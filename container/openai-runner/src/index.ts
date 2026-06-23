/**
 * NanoClaw OpenAI Agent Runner
 *
 * Uses the OpenAI Responses API so the same code path works against:
 *   • api.openai.com with an OPENAI_API_KEY
 *   • chatgpt.com/backend-api/codex with a Codex CLI OAuth token
 *     (~/.codex/auth.json, populated by `codex login` on the host)
 *
 * OAuth is preferred when present; otherwise the runner falls back to the
 * API key. With neither, it returns `escalate` so the orchestrator can swap
 * to the Claude runner.
 *
 * Stdin/stdout protocol is identical to the Claude runner.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Types (matching Claude runner's protocol)
// ---------------------------------------------------------------------------

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error' | 'escalate';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// Loose Responses API types — OAuth path hits the ChatGPT backend which can
// drift from the public SDK schema, so we deliberately stay schema-agnostic.
type InputItem = Record<string, unknown>;
type OutputItem = Record<string, unknown> & { type: string };

interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Output protocol (identical to Claude runner)
// ---------------------------------------------------------------------------

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[openai-runner] ${message}`);
}

// ---------------------------------------------------------------------------
// Auth resolution: Codex OAuth (preferred) → OPENAI_API_KEY (fallback)
// ---------------------------------------------------------------------------

const CODEX_AUTH_PATH = '/home/node/.codex/auth.json';
const CODEX_REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const APIKEY_RESPONSES_URL = 'https://api.openai.com/v1/responses';
// The ChatGPT-account backend only accepts a fixed set of models; gpt-5.5 is
// the default the Codex CLI itself picks. gpt-5-codex / gpt-4o / etc. are
// rejected with HTTP 400 "model is not supported when using Codex with a
// ChatGPT account".
const CODEX_DEFAULT_MODEL = 'gpt-5.5';
const APIKEY_DEFAULT_MODEL = 'gpt-4o';
// Reasoning effort for gpt-5/o-series models on the Responses API. Defaults to
// 'high' (deepest reasoning, best quality, slower). Tunable via env without a
// rebuild. Non-reasoning models (e.g. gpt-4o) reject this param, so it is only
// attached for reasoning-capable models — see isReasoningModel below.
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'high';
const isReasoningModel = (model: string): boolean => /^(gpt-5|o\d)/.test(model);

interface CodexTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
}

interface CodexAuthFile {
  OPENAI_API_KEY?: string | null;
  auth_mode?: string;
  tokens?: CodexTokens;
  last_refresh?: string;
  agent_identity?: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

async function refreshCodexTokens(refreshToken: string): Promise<{
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}> {
  const res = await fetch(CODEX_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Codex token refresh failed: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

async function ensureFreshCodexAuth(): Promise<CodexTokens | null> {
  if (!fs.existsSync(CODEX_AUTH_PATH)) return null;

  let auth: CodexAuthFile;
  try {
    auth = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, 'utf-8'));
  } catch (err) {
    log(`Failed to parse ${CODEX_AUTH_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!auth.tokens?.access_token || !auth.tokens?.refresh_token) return null;

  // Refresh if the access token expires within 5 minutes.
  const payload = decodeJwtPayload(auth.tokens.access_token);
  const exp = typeof payload?.exp === 'number' ? payload.exp : 0;
  const now = Math.floor(Date.now() / 1000);
  if (exp - now > 300) return auth.tokens;

  log('Codex access token expiring soon, refreshing...');
  try {
    const refreshed = await refreshCodexTokens(auth.tokens.refresh_token);
    auth.tokens = {
      id_token: refreshed.id_token ?? auth.tokens.id_token,
      access_token: refreshed.access_token ?? auth.tokens.access_token,
      refresh_token: refreshed.refresh_token ?? auth.tokens.refresh_token,
      account_id: auth.tokens.account_id,
    };
    auth.last_refresh = new Date().toISOString();
    fs.writeFileSync(CODEX_AUTH_PATH, JSON.stringify(auth, null, 2));
    log('Codex tokens refreshed and persisted');
    return auth.tokens;
  } catch (err) {
    log(`Codex refresh failed, using stale token: ${err instanceof Error ? err.message : String(err)}`);
    return auth.tokens;
  }
}

interface AuthConfig {
  url: string;
  headers: Record<string, string>;
  model: string;
  mode: 'oauth' | 'apikey';
  // ChatGPT-account backend mandates stream:true, store:false; api.openai.com
  // accepts both. We keep one streaming code path for both so flags are unused
  // here — see callResponsesStream below for the wire format.
}

async function resolveAuth(): Promise<AuthConfig | null> {
  const tokens = await ensureFreshCodexAuth();
  if (tokens) {
    log(`Auth: Codex OAuth (account ${tokens.account_id})`);
    return {
      url: CODEX_RESPONSES_URL,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'chatgpt-account-id': tokens.account_id,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
      },
      model: process.env.OPENAI_MODEL || CODEX_DEFAULT_MODEL,
      mode: 'oauth',
    };
  }

  if (process.env.OPENAI_API_KEY) {
    log('Auth: OPENAI_API_KEY');
    return {
      url: APIKEY_RESPONSES_URL,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      model: process.env.OPENAI_MODEL || APIKEY_DEFAULT_MODEL,
      mode: 'apikey',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Streaming Responses API call — SSE consumer
// ---------------------------------------------------------------------------
//
// The ChatGPT-account backend at chatgpt.com/backend-api/codex/responses
// REQUIRES stream:true and store:false. api.openai.com's /v1/responses
// accepts both, so we use one streaming path for both auth modes.
//
// We accumulate completed output items from `response.output_item.done`
// events and return them as a single array, matching the non-streaming
// response shape that the rest of the runner already knows how to parse.

interface ResponsesResult {
  id: string;
  output: OutputItem[];
}

async function callResponsesStream(
  auth: AuthConfig,
  body: {
    model: string;
    instructions: string;
    input: InputItem[];
    tools?: ResponsesTool[];
    tool_choice?: string;
    parallel_tool_calls?: boolean;
    reasoning?: { effort: string };
  },
): Promise<ResponsesResult> {
  // With store:false, the backend has no record of prior items. Reasoning
  // items in the response are server-side pointers (id + empty summary), so
  // feeding them back as input returns HTTP 404 "Item not found". Strip them.
  const filteredInput = body.input.filter((item) => {
    const t = (item as { type?: string }).type;
    return t !== 'reasoning';
  });

  // Without timeouts the fetch + reader.read() can block indefinitely if the
  // Codex backend stalls mid-stream. We saw this on the Mac dev instance
  // May 17–18: 5 consecutive containers killed at the 30-min hard timeout
  // with zero captured output. Two layers of protection:
  //   - overall AbortController (OVERALL_TIMEOUT_MS) on the whole stream
  //   - per-read deadline (PER_READ_TIMEOUT_MS) — the backend should send at
  //     least heartbeats; if it doesn't, we throw and let the caller escalate
  const OVERALL_TIMEOUT_MS = 600_000; // 10 min hard cap on a single stream
  const PER_READ_TIMEOUT_MS = 60_000; // 60 s between any two SSE reads
  const overall = new AbortController();
  const overallT = setTimeout(
    () => overall.abort(new Error('SSE overall timeout')),
    OVERALL_TIMEOUT_MS,
  );

  try {
    const res = await fetch(auth.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...auth.headers,
      },
      body: JSON.stringify({ ...body, input: filteredInput, stream: true, store: false }),
      signal: overall.signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Responses API ${res.status}: ${errText.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseId = '';
    const completedItems: OutputItem[] = [];

    // SSE frames are delimited by blank lines. Each frame may have multiple
    // `data:` lines (we concatenate); `event:` lines name the event type but
    // we dispatch on the parsed JSON's `type` field which is always present.
    while (true) {
      const readPromise = reader.read();
      let readTimeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        readTimeoutHandle = setTimeout(
          () => reject(new Error(`SSE read stalled >${PER_READ_TIMEOUT_MS}ms`)),
          PER_READ_TIMEOUT_MS,
        );
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = (await Promise.race([readPromise, timeoutPromise])) as ReadableStreamReadResult<Uint8Array>;
      } finally {
        if (readTimeoutHandle) clearTimeout(readTimeoutHandle);
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join('\n');
        if (dataStr === '[DONE]') continue;

        let evt: { type?: string; response?: { id?: string }; item?: OutputItem; error?: unknown };
        try {
          evt = JSON.parse(dataStr);
        } catch {
          continue;
        }

        switch (evt.type) {
          case 'response.created':
            if (evt.response?.id) responseId = evt.response.id;
            break;
          case 'response.output_item.done':
            if (evt.item) completedItems.push(evt.item);
            break;
          case 'error':
          case 'response.failed':
            throw new Error(`Responses stream error: ${JSON.stringify(evt).slice(0, 500)}`);
          // response.in_progress, response.output_text.delta, response.completed
          // etc. are informational here — we only need fully-formed items.
        }
      }
    }

    return { id: responseId, output: completedItems };
  } finally {
    clearTimeout(overallT);
  }
}

// ---------------------------------------------------------------------------
// Built-in tools (Responses API format: flat, no nested `function:`)
// ---------------------------------------------------------------------------

const BUILTIN_TOOLS: ResponsesTool[] = [
  {
    type: 'function',
    name: 'Bash',
    description: 'Execute a bash command and return its output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: 'Timeout in ms (default 120000)' },
      },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'Read',
    description: 'Read a file and return its contents.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start from (0-based)' },
        limit: { type: 'number', description: 'Max lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    type: 'function',
    name: 'Write',
    description: 'Write content to a file (overwrites).',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    type: 'function',
    name: 'Edit',
    description: 'Replace a string in a file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path' },
        old_string: { type: 'string', description: 'Text to find' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    type: 'function',
    name: 'Glob',
    description: 'Find files matching a glob pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
        path: { type: 'string', description: 'Directory to search in' },
      },
      required: ['pattern'],
    },
  },
  {
    type: 'function',
    name: 'Grep',
    description: 'Search file contents with regex.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'File or directory to search' },
        glob: { type: 'string', description: 'Glob filter for files' },
      },
      required: ['pattern'],
    },
  },
  {
    type: 'function',
    name: 'Skill',
    description: 'Load a skill by name. Returns the skill markdown content.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name (e.g. "davids-voice", "social-post")' },
      },
      required: ['skill'],
    },
  },
];

// ---------------------------------------------------------------------------
// Built-in tool execution
// ---------------------------------------------------------------------------

function execBash(command: string, timeout = 120000): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', command], {
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      const out = stdout + (stderr ? `\n[stderr] ${stderr}` : '');
      resolve(code === 0 ? out || '(success, no output)' : `Exit code ${code}\n${out}`);
    });
    proc.on('error', (err) => resolve(`Error: ${err.message}`));
  });
}

function execRead(filePath: string, offset?: number, limit?: number): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = offset || 0;
    const end = limit ? start + limit : lines.length;
    return lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n');
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function execWrite(filePath: string, content: string): string {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Written to ${filePath}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function execEdit(filePath: string, oldStr: string, newStr: string, replaceAll = false): string {
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(oldStr)) return `Error: old_string not found in ${filePath}`;
    if (replaceAll) {
      content = content.split(oldStr).join(newStr);
    } else {
      content = content.replace(oldStr, newStr);
    }
    fs.writeFileSync(filePath, content);
    return `Updated ${filePath}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function execGlob(pattern: string, searchPath?: string): Promise<string> {
  const cwd = searchPath || '/workspace/group';
  return execBash(`find ${cwd} -path '${pattern}' 2>/dev/null | head -50`);
}

async function execGrep(pattern: string, searchPath?: string, glob?: string): Promise<string> {
  const target = searchPath || '/workspace/group';
  const globFlag = glob ? `--include='${glob}'` : '';
  return execBash(`grep -rn ${globFlag} '${pattern}' ${target} 2>/dev/null | head -50`);
}

function execSkill(skillName: string): string {
  const skillPaths = [
    `/workspace/project/container/skills/${skillName}/SKILL.md`,
    `/workspace/project/container/skills/${skillName}.md`,
    `/app/skills/${skillName}/SKILL.md`,
  ];
  for (const p of skillPaths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8');
    }
  }
  const skillsDir = '/workspace/project/container/skills';
  if (fs.existsSync(skillsDir)) {
    const dirs = fs.readdirSync(skillsDir);
    return `Skill "${skillName}" not found. Available: ${dirs.join(', ')}`;
  }
  return `Skill "${skillName}" not found.`;
}

async function executeBuiltinTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'Bash': return execBash(args.command as string, args.timeout as number | undefined);
    case 'Read': return execRead(args.file_path as string, args.offset as number | undefined, args.limit as number | undefined);
    case 'Write': return execWrite(args.file_path as string, args.content as string);
    case 'Edit': return execEdit(args.file_path as string, args.old_string as string, args.new_string as string, args.replace_all as boolean | undefined);
    case 'Glob': return execGlob(args.pattern as string, args.path as string | undefined);
    case 'Grep': return execGrep(args.pattern as string, args.path as string | undefined, args.glob as string | undefined);
    case 'Skill': return execSkill(args.skill as string);
    default: return `Unknown tool: ${name}`;
  }
}

// ---------------------------------------------------------------------------
// MCP client management
// ---------------------------------------------------------------------------

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  tools: ResponsesTool[];
  toolMap: Map<string, string>; // openai function name → mcp tool name
}

async function connectMcpServer(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<McpConnection | null> {
  try {
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env as Record<string, string>, ...env },
    });
    const client = new Client({ name: `openai-runner-${name}`, version: '1.0.0' });
    await client.connect(transport);

    const { tools: mcpTools } = await client.listTools();
    const responseTools: ResponsesTool[] = [];
    const toolMap = new Map<string, string>();

    for (const tool of mcpTools) {
      const fnName = `mcp__${name}__${tool.name}`;
      toolMap.set(fnName, tool.name);
      responseTools.push({
        type: 'function',
        name: fnName,
        description: tool.description || '',
        parameters: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
      });
    }

    log(`MCP ${name}: connected, ${mcpTools.length} tools`);
    return { client, transport, tools: responseTools, toolMap };
  } catch (err) {
    log(`MCP ${name}: failed to connect - ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// IPC polling (same as Claude runner)
// ---------------------------------------------------------------------------

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json')).sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) messages.push(data.text);
      } catch { try { fs.unlinkSync(filePath); } catch { /* ignore */ } }
    }
    return messages;
  } catch { return []; }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const messages = drainIpcInput();
      if (messages.length > 0) { resolve(messages.join('\n')); return; }
      setTimeout(poll, 500);
    };
    poll();
  });
}

// ---------------------------------------------------------------------------
// Responses API helpers
// ---------------------------------------------------------------------------

function extractAssistantText(output: OutputItem[]): string | null {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type === 'message') {
      const content = (item as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'output_text' && typeof block.text === 'string') {
            parts.push(block.text);
          }
        }
      } else if (typeof content === 'string') {
        parts.push(content);
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function findFunctionCalls(output: OutputItem[]): Array<{ call_id: string; name: string; arguments: string }> {
  const calls: Array<{ call_id: string; name: string; arguments: string }> = [];
  for (const item of output) {
    if (item.type === 'function_call') {
      const it = item as { call_id?: string; id?: string; name?: string; arguments?: string };
      const callId = it.call_id || it.id;
      if (callId && it.name && typeof it.arguments === 'string') {
        calls.push({ call_id: callId, name: it.name, arguments: it.arguments });
      }
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await new Promise<string>((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    });
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}` });
    process.exit(1);
  }

  const authMaybe = await resolveAuth();
  if (!authMaybe) {
    log('No OpenAI auth available, escalating to Claude');
    writeOutput({ status: 'escalate', result: null, error: 'no openai auth' });
    process.exit(0);
  }
  const auth: AuthConfig = authMaybe;
  const { model, mode: authMode } = auth;
  log(
    `Model: ${model} (auth: ${authMode})` +
      (isReasoningModel(model) ? ` reasoning.effort=${REASONING_EFFORT}` : ''),
  );

  // Session persistence — save/load the Responses API input items array
  const SESSION_DIR = '/workspace/group/.sessions';
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  function loadSession(sessionId: string): InputItem[] {
    const sessionFile = path.join(SESSION_DIR, `${sessionId}.json`);
    if (!fs.existsSync(sessionFile)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as InputItem[];
      log(`Loaded session ${sessionId}: ${data.length} items`);
      // Cap to prevent unbounded prompt growth
      return data.slice(-80);
    } catch {
      return [];
    }
  }

  function saveSession(sessionId: string, items: InputItem[]): void {
    const sessionFile = path.join(SESSION_DIR, `${sessionId}.json`);
    const trimmed = items.slice(-120);
    fs.writeFileSync(sessionFile, JSON.stringify(trimmed));
    log(`Saved session ${sessionId}: ${trimmed.length} items`);
  }

  const sessionId = containerInput.sessionId || `openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const conversationItems: InputItem[] = containerInput.sessionId ? loadSession(containerInput.sessionId) : [];

  // System / instructions prompt.
  //
  // Loading order:
  //   1. Default persona blurb
  //   2. For non-main groups: the global baseline (groups/global/CLAUDE.md)
  //   3. The group's own CLAUDE.md (loaded for BOTH main and non-main, last
  //      so it can override or extend the baseline)
  //
  // The previous behavior — non-main groups got ONLY the global, ignoring
  // their per-group CLAUDE.md — meant a hand-curated persona like
  // groups/telegram_weight_loss_now/CLAUDE.md (HyloClaw) was silently
  // dropped, and there was no way for any non-main group to have its own
  // system-prompt context. Now group CLAUDE.md is always loaded if present.
  let instructions = `You are ${containerInput.assistantName || 'an AI assistant'}. You help the user with tasks using the tools available to you. Be concise and helpful.`;
  if (!containerInput.isMain) {
    const globalClaudeMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalClaudeMd)) {
      instructions += '\n\n' + fs.readFileSync(globalClaudeMd, 'utf-8');
    }
  }
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    instructions += '\n\n' + fs.readFileSync(groupClaudeMd, 'utf-8');
  }

  // Connect MCP servers
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  const mcpConfigs: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    },
    hylo: {
      command: 'hylo-mcp',
      args: [],
      env: {
        HYLO_API_KEY: process.env.HYLO_API_KEY || '',
        GHL_PIT_TOKEN: process.env.GHL_PIT_TOKEN || '',
        GHL_LOCATION_ID: process.env.GHL_LOCATION_ID || '',
      },
    },
    ai_news: {
      command: 'node',
      args: ['/opt/ai-news-mcp/index.js'],
      env: { AI_NEWS_DB_PATH: '/opt/ai-news-mcp/db/ai-news.db' },
    },
  };

  const mcpConnections = new Map<string, McpConnection>();
  const allMcpTools: ResponsesTool[] = [];

  for (const [name, config] of Object.entries(mcpConfigs)) {
    const conn = await connectMcpServer(name, config.command, config.args, config.env);
    if (conn) {
      mcpConnections.set(name, conn);
      allMcpTools.push(...conn.tools);
    }
  }

  const allTools = [...BUILTIN_TOOLS, ...allMcpTools];
  log(`Tools available: ${allTools.length} (${BUILTIN_TOOLS.length} builtin + ${allMcpTools.length} MCP)`);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  async function runQuery(userPrompt: string): Promise<string | null> {
    conversationItems.push({ role: 'user', content: userPrompt });

    // Per-query turn cap. Implementer-style skills doing multi-file edits with
    // tests can blow past 50; override via OPENAI_MAX_TURNS in the container
    // env (set per-group through containerConfig.env).
    const MAX_TURNS = parseInt(process.env.OPENAI_MAX_TURNS || '50', 10);
    let lastText: string | null = null;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      log(`Turn ${turn + 1}...`);

      let response: ResponsesResult;
      try {
        response = await callResponsesStream(auth, {
          model,
          instructions,
          input: conversationItems,
          tools: allTools,
          tool_choice: 'auto',
          parallel_tool_calls: true,
          ...(isReasoningModel(model)
            ? { reasoning: { effort: REASONING_EFFORT } }
            : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Responses API error: ${msg}`);
        throw new Error(`Responses API error: ${msg}`);
      }

      // Append every output item back into the conversation so the next call
      // sees the assistant's prior reasoning and tool calls.
      for (const item of response.output) {
        conversationItems.push(item as InputItem);
      }

      const text = extractAssistantText(response.output);
      if (text) lastText = text;

      const calls = findFunctionCalls(response.output);
      if (calls.length === 0) break;

      for (const call of calls) {
        let fnArgs: Record<string, unknown>;
        try { fnArgs = JSON.parse(call.arguments); } catch { fnArgs = {}; }

        log(`Tool: ${call.name}`);
        let result: string;

        const mcpPrefix = call.name.match(/^mcp__(\w+)__/);
        if (mcpPrefix) {
          const serverName = mcpPrefix[1];
          const conn = mcpConnections.get(serverName);
          if (!conn) {
            result = `MCP server "${serverName}" not connected`;
          } else {
            const mcpToolName = conn.toolMap.get(call.name);
            if (!mcpToolName) {
              result = `Unknown MCP tool: ${call.name}`;
            } else {
              try {
                const mcpResult = await conn.client.callTool({ name: mcpToolName, arguments: fnArgs });
                result = (mcpResult.content as Array<{ type: string; text: string }>)
                  .map(c => c.text)
                  .join('\n');
              } catch (err) {
                result = `MCP error: ${err instanceof Error ? err.message : String(err)}`;
              }
            }
          }
        } else {
          result = await executeBuiltinTool(call.name, fnArgs);
        }

        conversationItems.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: result.slice(0, 50000),
        });
      }

      if (shouldClose()) {
        log('Close sentinel detected during query');
        break;
      }
    }

    return lastText;
  }

  // Detects the Codex backend's specific complaint that a `function_call_output`
  // in our submitted history references a `call_id` the server doesn't know.
  // This happens when a previous container's session got persisted with
  // tool-call items whose original response is gone (store:false → server has
  // no memory across responses). The cure is to wipe our local session and
  // retry from scratch — Claude fallback shouldn't be triggered for this.
  const SESSION_CORRUPTION_RE =
    /No tool call found for function call output|Item not found|tool_call_id|previous_response_id/i;

  function wipeSession(sid: string): void {
    try {
      const f = path.join(SESSION_DIR, `${sid}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
      log(`Wiped corrupted session file ${f}`);
    } catch (err) {
      log(`Failed to wipe session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    while (true) {
      log(`Starting query...`);
      let result: string | null;
      try {
        result = await runQuery(prompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Self-heal session corruption in-process; never fall through to Claude.
        if (SESSION_CORRUPTION_RE.test(msg)) {
          log(`Session corruption detected (${msg.slice(0, 120)}). Wiping and retrying fresh.`);
          wipeSession(sessionId);
          // Reset in-memory conversation to just the user's current prompt
          conversationItems.length = 0;
          try {
            result = await runQuery(prompt);
            log('Retry after session wipe: success');
          } catch (retryErr) {
            const rmsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            log(`Retry after wipe also failed, escalating: ${rmsg}`);
            writeOutput({ status: 'escalate', result: null, error: rmsg });
            process.exit(0);
          }
        } else {
          log(`Query failed, escalating to Claude: ${msg}`);
          writeOutput({ status: 'escalate', result: null, error: msg });
          process.exit(0);
        }
      }

      saveSession(sessionId, conversationItems);
      writeOutput({ status: 'success', result, newSessionId: sessionId });

      if (shouldClose()) {
        log('Close sentinel received, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars)`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, error: errorMessage });
    process.exit(1);
  }

  for (const [name, conn] of mcpConnections) {
    try { await conn.client.close(); } catch { /* ignore */ }
    log(`MCP ${name}: disconnected`);
  }
}

main();

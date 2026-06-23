/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { getActiveCustomerLocation } from './db.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// True when either an OPENAI_API_KEY is set or the operator has run
// `codex login` on the host (creating ~/.codex/auth.json). The openai-runner
// resolves which one to use at startup; here we only need to know whether to
// route through it at all.
function hasOpenAIAuth(): boolean {
  if (process.env.OPENAI_API_KEY) return true;
  const codexAuth = path.join(
    process.env.HOME || '/home/nanoclaw',
    '.codex',
    'auth.json',
  );
  return fs.existsSync(codexAuth);
}

// ── Codex usage-limit circuit breaker ──────────────────────────────────────
// When the Codex (ChatGPT-subscription) backend returns `usage_limit_reached`,
// it includes a `resets_at` epoch. Without acting on it we retry Codex on every
// request — wasting a ~4s round-trip per call and firing repeated escalation
// alerts — until the limit lifts (can be days on the Plus plan). Instead we
// record the reset time, route straight to Claude until then, and auto-resume
// Codex afterward. Persisted to a file so a service restart doesn't forget the
// window.
const CODEX_BLOCK_FILE = path.join(DATA_DIR, 'codex-usage-block.json');
const CODEX_BLOCK_BUFFER_MS = 60_000; // cushion past resets_at for clock skew

function readCodexBlockedUntil(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(CODEX_BLOCK_FILE, 'utf-8')) as {
      blockedUntil?: number;
    };
    return typeof parsed.blockedUntil === 'number' ? parsed.blockedUntil : 0;
  } catch {
    return 0;
  }
}

function writeCodexBlockedUntil(blockedUntil: number, resetsAt: number): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      CODEX_BLOCK_FILE,
      JSON.stringify({
        blockedUntil,
        resetsAt,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to persist Codex usage-limit block');
  }
}

function clearCodexBlock(): void {
  try {
    if (fs.existsSync(CODEX_BLOCK_FILE)) fs.rmSync(CODEX_BLOCK_FILE);
  } catch (err) {
    logger.warn({ err }, 'Failed to clear Codex usage-limit block');
  }
}

// Extract a `resets_at` epoch (seconds) from a usage_limit_reached error.
// Returns null when the error is not a usage-limit signal.
function parseUsageLimitResetsAt(error: string | undefined): number | null {
  if (!error || !error.includes('usage_limit_reached')) return null;
  const at = error.match(/"resets_at"\s*:\s*(\d+)/);
  if (at) return parseInt(at[1], 10);
  const inSec = error.match(/"resets_in_seconds"\s*:\s*(\d+)/);
  if (inSec) return Math.floor(Date.now() / 1000) + parseInt(inSec[1], 10);
  return Math.floor(Date.now() / 1000) + 3600; // usage-limited, no time → back off 1h
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  proxyToken?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'escalate';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Non-main groups: their own folder + project root (read-only).
    // Project root mount lets the OpenAI runner's Skill loader find
    // skills at /workspace/project/container/skills/<name>/SKILL.md and
    // lets skills reference shared CONTEXT.md files there. Read-only +
    // .env shadowed so non-main groups can't modify host code or read
    // secrets — same posture as main, just without the writable group
    // folder being the project root.
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Mount ~/.codex (Codex CLI OAuth credentials) when present on the host.
  // The openai-runner reads tokens from auth.json and refreshes them in place,
  // so this must be writable. Shared across groups by design — one ChatGPT
  // identity for the whole NanoClaw install, mirroring `codex login` semantics.
  const hostCodexDir = path.join(
    process.env.HOME || '/home/nanoclaw',
    '.codex',
  );
  if (fs.existsSync(path.join(hostCodexDir, 'auth.json'))) {
    mounts.push({
      hostPath: hostCodexDir,
      containerPath: '/home/node/.codex',
      readonly: false,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Mount bridge-call script (read-only) so agents can call the GHL bridge
  // without needing auth tokens in their prompt context
  const bridgeCallScript = path.join(
    process.env.HOME || '/Users/davidsonshine',
    '.openclaw',
    'hylo-bridge',
    'bridge-call.sh',
  );
  if (fs.existsSync(bridgeCallScript)) {
    mounts.push({
      hostPath: bridgeCallScript,
      containerPath: '/usr/local/bin/bridge-call',
      readonly: true,
    });
  }

  // Mount ai-news-mcp source (read-only) and DB directory (read-write for SQLite journal/WAL).
  // node_modules is baked into the container image (native modules need matching Node version).
  const aiNewsMcpDir = '/opt/ai-news-mcp';
  const aiNewsDbDir = '/opt/ai-news-mcp/db';
  if (fs.existsSync(aiNewsMcpDir)) {
    const indexFile = path.join(aiNewsMcpDir, 'index.js');
    if (fs.existsSync(indexFile)) {
      mounts.push({
        hostPath: indexFile,
        containerPath: '/opt/ai-news-mcp/index.js',
        readonly: true,
      });
    }
    // Mount the db directory (writable so SQLite can create journal/wal files)
    if (fs.existsSync(aiNewsDbDir)) {
      mounts.push({
        hostPath: aiNewsDbDir,
        containerPath: '/opt/ai-news-mcp/db',
        readonly: false,
      });
    }
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Look up a PIT (access_token) from profiles.yaml by bridge_token.
 */
function lookupPitToken(bridgeToken: string): string | null {
  const profilesPath = path.join(
    process.env.HOME || '/home/nanoclaw',
    '.ghl',
    'profiles.yaml',
  );
  try {
    const content = fs.readFileSync(profilesPath, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (
        lines[i].includes(`bridge_token:`) &&
        lines[i].includes(bridgeToken)
      ) {
        // Walk backwards to find access_token
        for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
          const match = lines[j].match(/access_token:\s*"?([^"\s]+)"?/);
          if (match) return match[1];
        }
      }
    }
  } catch {
    logger.warn('Failed to read profiles.yaml for PIT lookup');
  }
  return null;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  proxyToken?: string,
  extraEnv?: Record<string, string>,
  runner: 'openai' | 'claude' = 'openai',
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Select which runner the container uses
  args.push('-e', `RUNNER=${runner}`);

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // OpenAI runner: pass through API key if set, plus the model override.
  // The runner itself decides between OAuth (~/.codex/auth.json) and API-key
  // auth at runtime; we just forward whatever's available.
  if (runner === 'openai') {
    if (process.env.OPENAI_API_KEY) {
      args.push('-e', `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`);
    }
    if (process.env.OPENAI_MODEL) {
      args.push('-e', `OPENAI_MODEL=${process.env.OPENAI_MODEL}`);
    }
    // Reasoning effort for gpt-5/o-series. Runner defaults to 'high' if unset;
    // override here (e.g. 'medium') without rebuilding the container image.
    if (process.env.OPENAI_REASONING_EFFORT) {
      args.push(
        '-e',
        `OPENAI_REASONING_EFFORT=${process.env.OPENAI_REASONING_EFFORT}`,
      );
    }
  }

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Force model selection via environment (default: claude-sonnet-4-6)
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  args.push('-e', `CLAUDE_MODEL=${model}`);

  // Pass Hylo API key for hylo-mcp inside containers
  if (process.env.HYLO_API_KEY) {
    args.push('-e', `HYLO_API_KEY=${process.env.HYLO_API_KEY}`);
  }

  // Auth mode for this container:
  // - If customer has their own API key (proxyToken set), always use API key mode
  //   so the SDK sends x-api-key which the proxy resolves to their real key.
  // - Otherwise, mirror the operator's auth method with a placeholder value.
  if (proxyToken) {
    args.push('-e', `ANTHROPIC_API_KEY=${proxyToken}`);
  } else {
    const authMode = detectAuthMode();
    if (authMode === 'api-key') {
      args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
    } else {
      args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    }
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Per-customer env vars (e.g. GHL credentials for hylo-mcp)
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value) args.push('-e', `${key}=${value}`);
    }
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  runner: 'openai' | 'claude' = hasOpenAIAuth() ? 'openai' : 'claude',
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;

  // Look up customer's GHL credentials for hylo-mcp
  const extraEnv: Record<string, string> = {};
  const activeLocation = getActiveCustomerLocation(input.chatJid);
  if (activeLocation) {
    extraEnv.GHL_LOCATION_ID = activeLocation.location_id;
    // Read PIT token from the group's .bridge-token → look up in profiles.yaml
    const bridgeTokenPath = path.join(groupDir, '.bridge-token');
    if (fs.existsSync(bridgeTokenPath)) {
      const bridgeToken = fs.readFileSync(bridgeTokenPath, 'utf-8').trim();
      const pitToken = lookupPitToken(bridgeToken);
      if (pitToken) extraEnv.GHL_PIT_TOKEN = pitToken;
    }
  }

  // Per-group env overrides from containerConfig.env. Allowlist-gated:
  // only OPENAI_*, ROUTEAWARE_*, and HYLO_* are accepted. The point of this
  // gate is that group config is set by main-group operators through
  // register_group, and we don't want it to become a generic injection surface
  // for arbitrary process env. Bump the allowlist regex below when adding a
  // new prefix.
  const PER_GROUP_ENV_ALLOW_RE = /^(OPENAI|ROUTEAWARE|HYLO)_[A-Z0-9_]+$/;
  if (group.containerConfig?.env) {
    for (const [key, value] of Object.entries(group.containerConfig.env)) {
      if (!PER_GROUP_ENV_ALLOW_RE.test(key)) {
        logger.warn(
          { group: group.name, key },
          'Per-group env key rejected (allowlist mismatch)',
        );
        continue;
      }
      // Sentinel: "$PROCESS_ENV" means look up the value from the
      // nanoclaw process's environment at runtime. Lets us keep secrets out
      // of the DB while still scoping them per-group. The key must already
      // be in process.env (loaded via systemd EnvironmentFile=) — if missing,
      // we skip rather than passing an empty string, so misconfig is loud.
      if (value === '$PROCESS_ENV') {
        const fromProcess = process.env[key];
        if (!fromProcess) {
          logger.warn(
            { group: group.name, key },
            'Per-group env $PROCESS_ENV sentinel: process.env key is unset',
          );
          continue;
        }
        extraEnv[key] = fromProcess;
      } else {
        extraEnv[key] = value;
      }
    }
  }

  const containerArgs = buildContainerArgs(
    mounts,
    containerName,
    input.proxyToken,
    extraEnv,
    runner,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        // Without the stderr/stdout tail we couldn't diagnose the May 17–18
        // Mac-instance hangs — the runner had been logging actively to stderr
        // but the timeout dump was 7 header lines and nothing else. Include
        // the captured buffers + spawn args so silent hangs are debuggable.
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
            ``,
            `=== Container Args ===`,
            containerArgs.join(' '),
            ``,
            `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
            stderr || '(empty)',
            ``,
            `=== Stdout tail (last 4KB${stdoutTruncated ? ', overall TRUNCATED' : ''}) ===`,
            stdout.slice(-4096) || '(empty)',
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Run container with automatic OpenAI → Claude fallback.
 * Tries OpenAI first (if OPENAI_API_KEY or Codex OAuth is set). If the
 * runner's first output is 'escalate', kill the OpenAI container and retry
 * with the Claude SDK runner.
 *
 * Implementation note: both runners stay alive after each query to receive
 * IPC follow-ups, so we MUST stream-parse output. With onOutput omitted, the
 * host would only resolve at container exit — which never happens for these
 * long-lived runners.
 */
export async function runContainerWithFallback(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onEscalate?: (reason: string) => Promise<void>,
): Promise<ContainerOutput> {
  if (!hasOpenAIAuth()) {
    return runContainerAgent(group, input, onProcess, onOutput, 'claude');
  }

  // Circuit breaker: if Codex is in a known usage-limit window, skip the OpenAI
  // round-trip entirely and route straight to Claude. Auto-resume once it lifts.
  const codexBlockedUntil = readCodexBlockedUntil();
  if (codexBlockedUntil > Date.now()) {
    logger.info(
      { group: group.name, until: new Date(codexBlockedUntil).toISOString() },
      'Codex usage limit active — routing to Claude, skipping OpenAI',
    );
    return runContainerAgent(group, input, onProcess, onOutput, 'claude');
  }
  if (codexBlockedUntil > 0) {
    clearCodexBlock();
    logger.info(
      { group: group.name },
      'Codex usage-limit window elapsed — resuming OpenAI runner',
    );
  }

  logger.info({ group: group.name }, 'Trying OpenAI runner');

  let escalated = false;
  let firstSeen = false;
  let openaiProcess: ChildProcess | null = null;

  const fireEscalate = async (reason: string | undefined): Promise<void> => {
    // If this escalation is a Codex usage-limit, trip the circuit breaker so
    // subsequent requests skip Codex until it resets, and enrich the alert.
    // Done before the onEscalate guard so the breaker trips even with no notifier.
    let alertReason = reason;
    const resetsAtSec = parseUsageLimitResetsAt(reason);
    if (resetsAtSec) {
      const until = resetsAtSec * 1000 + CODEX_BLOCK_BUFFER_MS;
      writeCodexBlockedUntil(until, resetsAtSec);
      const untilStr = new Date(until).toISOString();
      logger.info(
        { group: group.name, until: untilStr },
        'Codex usage limit reached — pausing OpenAI runner until reset',
      );
      alertReason = `Codex usage limit reached — pausing Codex until ${untilStr}; running on Claude until then.`;
    }
    if (!onEscalate) return;
    try {
      await onEscalate(alertReason || 'unknown');
    } catch (err) {
      logger.warn({ err }, 'onEscalate notifier threw');
    }
  };

  const wrappedOnProcess = (proc: ChildProcess, containerName: string) => {
    openaiProcess = proc;
    onProcess(proc, containerName);
  };

  const wrappedOnOutput = async (out: ContainerOutput): Promise<void> => {
    if (!firstSeen) {
      firstSeen = true;
      if (out.status === 'escalate') {
        escalated = true;
        logger.info(
          { group: group.name, reason: out.error },
          'OpenAI runner escalated on first output, killing and falling back to Claude',
        );
        if (openaiProcess) {
          try {
            openaiProcess.kill('SIGTERM');
          } catch {
            /* ignore */
          }
        }
        await fireEscalate(out.error);
        return;
      }
    }
    if (!escalated && onOutput) await onOutput(out);
  };

  const openaiResult = await runContainerAgent(
    group,
    input,
    wrappedOnProcess,
    wrappedOnOutput,
    'openai',
  );

  // Escalate path is detected via the wrapped output handler above OR via the
  // final result if the runner exited before emitting any streaming output
  // (e.g. immediate auth failure before the loop runs).
  if (escalated || openaiResult.status === 'escalate') {
    logger.info(
      { group: group.name, reason: openaiResult.error },
      'OpenAI runner escalated, falling back to Claude',
    );
    // Only fire here if we didn't already fire from the streaming path
    if (!escalated) await fireEscalate(openaiResult.error);
    return runContainerAgent(group, input, onProcess, onOutput, 'claude');
  }

  return openaiResult;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

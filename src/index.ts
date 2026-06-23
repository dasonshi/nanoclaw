import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  OPS_NOTIFY_JID,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy, TokenMap } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerWithFallback,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  deleteRegisteredGroup,
  getAllChats,
  getAllRegisteredGroups,
  getAllCustomerCredentials,
  getCustomerCredential,
  getOnboardingSession,
  getAllSessions,
  getAllTasks,
  getSession,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setGroupStatus,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { createOnboardingHandler } from './onboarding.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];

// Set in main() once channels are connected. runAgent / scheduler pass this
// to runContainerWithFallback so a Codex→Claude escalation triggers an
// operator notification.
let escalationNotifier:
  | ((group: RegisteredGroup, reason: string) => Promise<void>)
  | null = null;
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function unregisterGroup(jid: string): void {
  const group = registeredGroups[jid];
  if (group) {
    delete registeredGroups[jid];
    deleteRegisteredGroup(jid);
    logger.info(
      { jid, name: group.name, folder: group.folder },
      'Group unregistered',
    );
  }
}

function updateGroupStatus(jid: string, status: string): void {
  setGroupStatus(jid, status);
  // Also update in-memory
  if (registeredGroups[jid]) {
    registeredGroups[jid] = {
      ...registeredGroups[jid],
      status: status as RegisteredGroup['status'],
    };
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  // Skip paused/suspended groups
  if (group.status === 'paused' || group.status === 'suspended') return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  // Read through getSession() (not the in-memory cache) so the 72h staleness
  // check in db.ts kicks in: idle sessions are pruned and we start fresh.
  const sessionId = getSession(group.folder);
  if (!sessionId && sessions[group.folder]) {
    delete sessions[group.folder]; // keep cache in sync after prune
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  const credential = getCustomerCredential(chatJid);
  const proxyToken = credential?.anthropic_api_key
    ? credential.proxy_token
    : undefined;

  try {
    const output = await runContainerWithFallback(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        proxyToken,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      escalationNotifier
        ? (reason) => escalationNotifier!(group, reason)
        : undefined,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          // Skip paused/suspended groups
          if (group.status === 'paused' || group.status === 'suspended')
            continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/**
 * Build the onEscalate callback that fires when the OpenAI runner escalates
 * to Claude. Sends a Telegram heads-up to OPS_NOTIFY_JID so the operator
 * knows Anthropic credit is being used and can investigate the underlying
 * Codex issue. Per-group throttle: at most one notify per group per hour
 * (a sustained Codex outage would otherwise spam every retry).
 */
function makeEscalationNotifier(
  channels: Channel[],
): (group: RegisteredGroup, reason: string) => Promise<void> {
  const ESCALATE_THROTTLE_MS = 60 * 60 * 1000; // 1h
  const lastNotifyAt = new Map<string, number>();
  return async (group, reason) => {
    if (!OPS_NOTIFY_JID) return;
    const now = Date.now();
    const last = lastNotifyAt.get(group.folder) ?? 0;
    if (now - last < ESCALATE_THROTTLE_MS) return;
    lastNotifyAt.set(group.folder, now);
    const channel = findChannel(channels, OPS_NOTIFY_JID);
    if (!channel) {
      logger.warn(
        { jid: OPS_NOTIFY_JID },
        'No channel owns OPS_NOTIFY_JID, cannot send escalation notification',
      );
      return;
    }
    const trimmed = (reason || 'unknown').slice(0, 200);
    const text =
      `⚠️ Codex escalated to Claude for ${group.name}\n` +
      `Reason: ${trimmed}\n` +
      `Anthropic credit is now being used. ` +
      `Check: journalctl -u nanoclaw --since "10min ago"`;
    try {
      await channel.sendMessage(OPS_NOTIFY_JID, text);
    } catch (err) {
      logger.warn(
        { err, jid: OPS_NOTIFY_JID },
        'Failed to send escalation notification',
      );
    }
  };
}

/**
 * Channel recovery for unhandled rejections that look like polling / network
 * errors. Without this, a grammy getUpdates 409 (e.g. another instance racing
 * the bot token) kills the long-poll loop silently — the process stays
 * "active" but receives no inbound messages until restart. See the May 14–20
 * incident: that exact failure mode went undetected for 6 days because the
 * old handler in src/logger.ts only logged.
 *
 * On a matching error we disconnect+reconnect every Telegram channel in
 * place. If recovery itself throws we exit so systemd restarts cleanly.
 */
function installChannelRecoveryHandler(channels: Channel[]): void {
  let recoveryInProgress = false;
  process.on('unhandledRejection', async (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error({ err: reason }, 'Unhandled rejection');
    if (
      !/grammy|getUpdates|ETIMEDOUT|ECONNRESET|fetch failed|409|Conflict/i.test(
        msg,
      )
    ) {
      return;
    }
    if (recoveryInProgress) return;
    recoveryInProgress = true;
    try {
      for (const ch of channels) {
        if (ch.name !== 'telegram') continue;
        logger.warn(
          { channel: ch.name },
          'Polling-class error detected, re-initializing channel',
        );
        await ch.disconnect();
        await new Promise((r) => setTimeout(r, 2000));
        await ch.connect();
        logger.info({ channel: ch.name }, 'Channel re-initialized');
      }
    } catch (err) {
      logger.fatal(
        { err },
        'Channel recovery failed — exiting for systemd restart',
      );
      process.exit(1);
    } finally {
      recoveryInProgress = false;
    }
  });
}

class DbTokenMap implements TokenMap {
  private map = new Map<string, string>();
  constructor() {
    this.reload();
  }
  reload(): void {
    this.map.clear();
    for (const row of getAllCustomerCredentials()) {
      if (row.anthropic_api_key) {
        this.map.set(row.proxy_token, row.anthropic_api_key);
      }
    }
  }
  get(proxyToken: string): string | undefined {
    return this.map.get(proxyToken);
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Start credential proxy (containers route API calls through this)
  const tokenMap = new DbTokenMap();
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
    tokenMap,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Set up onboarding handler
  const routeOutbound = async (jid: string, text: string) => {
    const channel = findChannel(channels, jid);
    if (channel) await channel.sendMessage(jid, text);
  };
  const onboarding = createOnboardingHandler({
    sendMessage: routeOutbound,
    registerGroup,
    registeredGroups: () => registeredGroups,
    setGroupStatus: updateGroupStatus,
    reloadTokenMap: () => tokenMap.reload(),
  });

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onOnboardingStart: (jid: string, name: string) =>
      onboarding.startSession(jid, name),
    onOnboardingMessage: (jid: string, text: string, name: string) =>
      onboarding.handleMessage(jid, text, name),
    isInCommandFlow: (jid: string) => !!getOnboardingSession(jid),
    onCommand: (jid: string, command: string) => {
      switch (command) {
        case 'locations':
          onboarding.handleLocations(jid);
          break;
        case 'connect':
          onboarding.handleConnect(jid);
          break;
        case 'reconnect':
          onboarding.handleReconnect(jid);
          break;
        case 'disconnect':
          onboarding.handleDisconnect(jid);
          break;
        case 'pause':
          onboarding.handlePause(jid);
          break;
        case 'resume':
          onboarding.handleResume(jid);
          break;
        case 'apikey':
          onboarding.handleApiKey(jid);
          break;
        case 'help':
          onboarding.handleHelp(jid);
          break;
      }
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  installChannelRecoveryHandler(channels);
  escalationNotifier = makeEscalationNotifier(channels);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    onEscalate: escalationNotifier
      ? (group, reason) => escalationNotifier!(group, reason)
      : undefined,
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    setGroupStatus: updateGroupStatus,
    unregisterGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}

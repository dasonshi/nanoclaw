import {
  addCustomerLocation,
  cleanupStaleOnboardingSessions,
  deleteCustomerCredential,
  deleteOnboardingSession,
  getActiveCustomerLocation,
  getCustomerCredential,
  getCustomerLocationCount,
  getCustomerLocations,
  getOnboardingSession,
  removeCustomerLocation,
  setActiveCustomerLocation,
  updateLocationBridgeToken,
  upsertCustomerCredential,
  upsertOnboardingSession,
} from './db.js';
import { logger } from './logger.js';
import {
  deprovisionLocation,
  generateSlug,
  provision,
  provisionLocation,
  switchActiveLocation,
  updateProfileToken,
} from './provisioner.js';
import { RegisteredGroup } from './types.js';

const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface OnboardingDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  setGroupStatus: (jid: string, status: string) => void;
  reloadTokenMap?: () => void;
}

export function createOnboardingHandler(deps: OnboardingDeps) {
  // Periodically clean up stale sessions
  setInterval(() => {
    const cleaned = cleanupStaleOnboardingSessions(SESSION_MAX_AGE_MS);
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale onboarding sessions');
    }
  }, CLEANUP_INTERVAL_MS);

  // ── /start — Initial onboarding ──────────────────────────────────

  async function startSession(chatJid: string, senderName: string) {
    const groups = deps.registeredGroups();
    if (groups[chatJid]) {
      await deps.sendMessage(
        chatJid,
        'You already have an active account. Just send a message to get started!\n\nType /help to see available commands.',
      );
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      sender_name: senderName,
      state: 'awaiting_name',
      business_name: null,
      location_id: null,
      pit_token: null,
      description: null,
      bot_name: 'HyloClaw',
    });

    await deps.sendMessage(
      chatJid,
      `Hey ${senderName}! Welcome to HyloClaw — AI-powered GoHighLevel management via Telegram.\n\nLet's get you set up. What's your business name?`,
    );
  }

  // ── Text message router ──────────────────────────────────────────

  async function handleMessage(
    chatJid: string,
    text: string,
    senderName: string,
  ) {
    // Handle self-resume (from paused groups)
    if (text === '__self_resume__') {
      deps.setGroupStatus(chatJid, 'active');
      await deps.sendMessage(
        chatJid,
        'Your account has been reactivated. Welcome back!',
      );
      return;
    }

    const session = getOnboardingSession(chatJid);
    if (!session) {
      // No active session — prompt them to start
      await deps.sendMessage(
        chatJid,
        `Hey ${senderName}! I'm HyloClaw — AI-powered GHL management via Telegram.\n\nSend /start to begin setup.`,
      );
      return;
    }

    const input = text.trim();

    switch (session.state) {
      // Initial onboarding states
      case 'awaiting_name':
        await handleAwaitingName(chatJid, input);
        break;
      case 'awaiting_location_id':
        await handleAwaitingLocationId(chatJid, input);
        break;
      case 'awaiting_pit_token':
        await handleAwaitingPitToken(chatJid, input);
        break;
      case 'awaiting_description':
        await handleAwaitingDescription(chatJid, input);
        break;
      case 'awaiting_bot_name':
        await handleAwaitingBotName(chatJid, input);
        break;
      case 'confirming':
        await handleConfirming(chatJid, input, senderName);
        break;
      // /connect states
      case 'connect_awaiting_name':
        await handleConnectName(chatJid, input);
        break;
      case 'connect_awaiting_location_id':
        await handleConnectLocationId(chatJid, input);
        break;
      case 'connect_awaiting_pit_token':
        await handleConnectPitToken(chatJid, input);
        break;
      case 'connect_awaiting_description':
        await handleConnectDescription(chatJid, input);
        break;
      // /reconnect state
      case 'reconnect_awaiting_pit_token':
        await handleReconnectPitToken(chatJid, input);
        break;
      // /locations number selection
      case 'awaiting_location_choice':
        await handleLocationChoice(chatJid, input);
        break;
      // /apikey state
      case 'apikey_awaiting_key':
        await handleApiKeyInput(chatJid, input);
        break;
      default:
        deleteOnboardingSession(chatJid);
        await deps.sendMessage(
          chatJid,
          'Something went wrong. Send /start to try again.',
        );
    }
  }

  // ── Initial onboarding handlers ──────────────────────────────────

  async function handleAwaitingName(chatJid: string, input: string) {
    if (!input || input.length < 2) {
      await deps.sendMessage(
        chatJid,
        'Please enter your business name (at least 2 characters).',
      );
      return;
    }
    if (input.length > 100) {
      await deps.sendMessage(
        chatJid,
        'Business name is too long (max 100 characters). Please try again.',
      );
      return;
    }
    if (/["`$\\|]/.test(input)) {
      await deps.sendMessage(
        chatJid,
        'Business name contains unsupported characters. Please avoid quotes, backticks, $, \\, and |.',
      );
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'awaiting_location_id',
      business_name: input,
    });

    await deps.sendMessage(
      chatJid,
      `Great! Now I need your GHL Location ID.\n\nTo find it:\n1. Log into your GHL sub-account\n2. Go to Settings > Business Profile\n3. Copy the Location ID (it's a string of letters and numbers)\n\nPaste it here:`,
    );
  }

  async function handleAwaitingLocationId(chatJid: string, input: string) {
    if (!/^[a-zA-Z0-9]{10,30}$/.test(input)) {
      await deps.sendMessage(
        chatJid,
        "That doesn't look like a valid Location ID. It should be 10-30 alphanumeric characters.\n\nPlease check and try again:",
      );
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'awaiting_pit_token',
      location_id: input,
    });

    await deps.sendMessage(
      chatJid,
      `Got it. Now I need a Private Integration Token (PIT) from your GHL account.\n\nTo create one:\n1. Go to Settings > Integrations > Private Integrations\n2. Click "Create New"\n3. Name it "HyloClaw"\n4. Grant the scopes you want (contacts, calendars, pipelines, etc.)\n5. Copy the token (starts with "pit-")\n\nPaste it here:`,
    );
  }

  async function handleAwaitingPitToken(chatJid: string, input: string) {
    if (!/^pit-[a-f0-9-]{30,}$/.test(input)) {
      await deps.sendMessage(
        chatJid,
        'That doesn\'t look like a valid PIT token. It should start with "pit-" followed by a long hex string.\n\nPlease check and try again:',
      );
      return;
    }

    try {
      const res = await fetch('http://localhost:18800/schemas?q=contacts');
      if (!res.ok) {
        await deps.sendMessage(
          chatJid,
          "I couldn't reach the API bridge. Please contact support.",
        );
        return;
      }
    } catch {
      await deps.sendMessage(
        chatJid,
        "I couldn't reach the API bridge. Please contact support.",
      );
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'awaiting_description',
      pit_token: input,
    });

    await deps.sendMessage(
      chatJid,
      'Token received. For security, please delete the message you just sent containing the token.\n\nNow, briefly describe your business (industry, what you do):',
    );
  }

  async function handleAwaitingDescription(chatJid: string, input: string) {
    if (!input || input.length < 5) {
      await deps.sendMessage(
        chatJid,
        'Please provide a brief description (at least 5 characters).',
      );
      return;
    }
    if (input.length > 500) {
      await deps.sendMessage(
        chatJid,
        'Description is too long (max 500 characters). Please shorten it.',
      );
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'awaiting_bot_name',
      description: input,
    });

    await deps.sendMessage(
      chatJid,
      'What would you like your AI assistant to be called? (Default: "HyloClaw")\n\nJust type a name, or send "default" to keep HyloClaw:',
    );
  }

  async function handleAwaitingBotName(chatJid: string, input: string) {
    let botName = input;
    if (
      input.toLowerCase() === 'default' ||
      input.toLowerCase() === 'hyloclaw'
    ) {
      botName = 'HyloClaw';
    }

    if (botName.length < 2 || botName.length > 32) {
      await deps.sendMessage(
        chatJid,
        'Bot name must be 2-32 characters. Please try again:',
      );
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'confirming',
      bot_name: botName,
    });

    const session = getOnboardingSession(chatJid)!;

    await deps.sendMessage(
      chatJid,
      `Here's your setup summary:\n\n• Business: ${session.business_name}\n• Location ID: ${session.location_id}\n• Bot Name: ${botName}\n• Description: ${session.description}\n\nDoes this look correct? (yes/no)`,
    );
  }

  async function handleConfirming(
    chatJid: string,
    input: string,
    senderName: string,
  ) {
    const answer = input.toLowerCase();
    if (answer === 'no' || answer === 'n') {
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'No problem. Send /start to begin again.',
      );
      return;
    }
    if (answer !== 'yes' && answer !== 'y') {
      await deps.sendMessage(chatJid, 'Please respond with "yes" or "no".');
      return;
    }

    const session = getOnboardingSession(chatJid);
    if (
      !session ||
      !session.business_name ||
      !session.location_id ||
      !session.pit_token ||
      !session.description
    ) {
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'Session data is incomplete. Send /start to try again.',
      );
      return;
    }

    await deps.sendMessage(chatJid, 'Setting up your account...');

    try {
      const result = await provision({
        businessName: session.business_name,
        locationId: session.location_id,
        pitToken: session.pit_token,
        description: session.description,
        botName: session.bot_name || 'HyloClaw',
        chatJid,
      });

      // Register the group in-process
      deps.registerGroup(chatJid, {
        name: session.business_name,
        folder: result.groupFolder,
        trigger: 'always',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        status: 'active',
      });

      // Save as first customer location
      const slug = generateSlug(session.business_name);
      addCustomerLocation({
        chat_jid: chatJid,
        slug,
        business_name: session.business_name,
        location_id: session.location_id,
        description: session.description,
        bot_name: session.bot_name || 'HyloClaw',
        bridge_token: result.bridgeToken,
        group_folder: result.groupFolder,
        is_active: true,
      });

      deleteOnboardingSession(chatJid);

      await deps.sendMessage(
        chatJid,
        `Your account is ready! I'm ${session.bot_name || 'HyloClaw'}, your AI assistant for managing ${session.business_name}'s GHL account.\n\nTry asking me to "show my recent contacts" to make sure everything is connected.\n\nType /help to see available commands.`,
      );

      logger.info(
        { chatJid, slug: result.slug, businessName: session.business_name },
        'Self-service onboarding complete',
      );
    } catch (err) {
      logger.error({ chatJid, err }, 'Provisioning failed');
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'Something went wrong during setup. Please contact support or try again with /start.',
      );
    }
  }

  // ── /locations — List and switch ─────────────────────────────────

  async function handleLocations(chatJid: string) {
    const groups = deps.registeredGroups();
    if (!groups[chatJid]) {
      await deps.sendMessage(
        chatJid,
        "You don't have an account yet. Send /start to get set up.",
      );
      return;
    }

    const locations = getCustomerLocations(chatJid);
    if (locations.length === 0) {
      await deps.sendMessage(
        chatJid,
        'No locations connected. Use /connect to add one.',
      );
      return;
    }

    if (locations.length === 1) {
      const loc = locations[0];
      await deps.sendMessage(
        chatJid,
        `You have one location:\n\n1. ${loc.business_name} (${loc.location_id})\n\nUse /connect to add another location.`,
      );
      return;
    }

    const lines = locations.map((loc, i) => {
      const marker = loc.is_active ? ' ← active' : '';
      return `${i + 1}. ${loc.business_name}${marker}`;
    });

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'awaiting_location_choice',
    });

    await deps.sendMessage(
      chatJid,
      `Your locations:\n\n${lines.join('\n')}\n\nReply with a number to switch.`,
    );
  }

  async function handleLocationChoice(chatJid: string, input: string) {
    const num = parseInt(input, 10);
    const locations = getCustomerLocations(chatJid);

    if (isNaN(num) || num < 1 || num > locations.length) {
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'Invalid choice. Use /locations to try again.',
      );
      return;
    }

    const chosen = locations[num - 1];
    deleteOnboardingSession(chatJid);

    if (chosen.is_active) {
      await deps.sendMessage(
        chatJid,
        `${chosen.business_name} is already active.`,
      );
      return;
    }

    // Switch active location in DB
    setActiveCustomerLocation(chatJid, chosen.location_id);

    // Update files on disk
    const group = deps.registeredGroups()[chatJid];
    if (group) {
      switchActiveLocation(
        group.folder,
        chosen.bridge_token,
        chosen.business_name,
        chosen.location_id,
        chosen.description,
        chosen.bot_name,
      );
    }

    await deps.sendMessage(
      chatJid,
      `Switched to *${chosen.business_name}*. I'm now managing this location's GHL account.`,
    );

    logger.info(
      {
        chatJid,
        locationId: chosen.location_id,
        businessName: chosen.business_name,
      },
      'Location switched',
    );
  }

  // ── /connect — Add a new location ───────────────────────────────

  async function handleConnect(chatJid: string) {
    const groups = deps.registeredGroups();
    if (!groups[chatJid]) {
      await deps.sendMessage(
        chatJid,
        "You don't have an account yet. Send /start to get set up.",
      );
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'connect_awaiting_name',
    });

    await deps.sendMessage(
      chatJid,
      "Let's connect a new GHL location.\n\nWhat's the business/location name?",
    );
  }

  async function handleConnectName(chatJid: string, input: string) {
    if (!input || input.length < 2) {
      await deps.sendMessage(
        chatJid,
        'Please enter a name (at least 2 characters).',
      );
      return;
    }
    if (input.length > 100) {
      await deps.sendMessage(chatJid, 'Name is too long (max 100 characters).');
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'connect_awaiting_location_id',
      business_name: input,
    });

    await deps.sendMessage(chatJid, 'Got it. Now paste the Location ID:');
  }

  async function handleConnectLocationId(chatJid: string, input: string) {
    if (!/^[a-zA-Z0-9]{10,30}$/.test(input)) {
      await deps.sendMessage(
        chatJid,
        "That doesn't look like a valid Location ID. It should be 10-30 alphanumeric characters.\n\nPlease check and try again:",
      );
      return;
    }

    // Check if location is already connected
    const existing = getCustomerLocations(chatJid);
    if (existing.some((l) => l.location_id === input)) {
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'That location is already connected. Use /locations to switch to it.',
      );
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'connect_awaiting_pit_token',
      location_id: input,
    });

    await deps.sendMessage(
      chatJid,
      'Got it. Now paste the PIT token for this location (starts with "pit-"):',
    );
  }

  async function handleConnectPitToken(chatJid: string, input: string) {
    if (!/^pit-[a-f0-9-]{30,}$/.test(input)) {
      await deps.sendMessage(
        chatJid,
        'That doesn\'t look like a valid PIT token. It should start with "pit-" followed by a long hex string.\n\nPlease check and try again:',
      );
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'connect_awaiting_description',
      pit_token: input,
    });

    await deps.sendMessage(
      chatJid,
      'Token received. Please delete that message for security.\n\nBriefly describe this business/location:',
    );
  }

  async function handleConnectDescription(chatJid: string, input: string) {
    if (!input || input.length < 5) {
      await deps.sendMessage(
        chatJid,
        'Please provide a brief description (at least 5 characters).',
      );
      return;
    }
    if (input.length > 500) {
      await deps.sendMessage(
        chatJid,
        'Description is too long (max 500 characters). Please shorten it.',
      );
      return;
    }

    const session = getOnboardingSession(chatJid);
    if (
      !session?.location_id ||
      !session?.pit_token ||
      !session?.business_name
    ) {
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'Session expired. Use /connect to try again.',
      );
      return;
    }

    await deps.sendMessage(chatJid, 'Connecting location...');

    try {
      const group = deps.registeredGroups()[chatJid];
      if (!group) {
        deleteOnboardingSession(chatJid);
        await deps.sendMessage(chatJid, 'Account not found. Contact support.');
        return;
      }

      // Use the existing slug from the first location
      const locations = getCustomerLocations(chatJid);
      const baseSlug =
        locations.length > 0
          ? locations[0].slug
          : generateSlug(session.business_name);
      const botName = locations.length > 0 ? locations[0].bot_name : 'HyloClaw';

      const result = await provisionLocation({
        slug: baseSlug,
        locationId: session.location_id,
        pitToken: session.pit_token,
        description: input,
        botName,
      });

      addCustomerLocation({
        chat_jid: chatJid,
        slug: baseSlug,
        business_name: session.business_name,
        location_id: session.location_id,
        description: input,
        bot_name: botName,
        bridge_token: result.bridgeToken,
        group_folder: group.folder,
      });

      deleteOnboardingSession(chatJid);

      const count = getCustomerLocationCount(chatJid);
      await deps.sendMessage(
        chatJid,
        `Location connected! You now have ${count} locations.\n\nUse /locations to switch between them.`,
      );

      logger.info(
        { chatJid, locationId: session.location_id },
        'New location connected',
      );
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to connect location');
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'Failed to connect location. Please try again with /connect.',
      );
    }
  }

  // ── /reconnect — Update PIT token ───────────────────────────────

  async function handleReconnect(chatJid: string) {
    const groups = deps.registeredGroups();
    if (!groups[chatJid]) {
      await deps.sendMessage(
        chatJid,
        "You don't have an account yet. Send /start to get set up.",
      );
      return;
    }

    const active = getActiveCustomerLocation(chatJid);
    if (!active) {
      await deps.sendMessage(
        chatJid,
        'No active location. Use /locations to select one first.',
      );
      return;
    }

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'reconnect_awaiting_pit_token',
      location_id: active.location_id,
    });

    await deps.sendMessage(
      chatJid,
      `Updating PIT token for *${active.business_name}*.\n\nPaste the new PIT token:`,
    );
  }

  async function handleReconnectPitToken(chatJid: string, input: string) {
    if (!/^pit-[a-f0-9-]{30,}$/.test(input)) {
      await deps.sendMessage(
        chatJid,
        'That doesn\'t look like a valid PIT token. It should start with "pit-" followed by a long hex string.\n\nPlease check and try again:',
      );
      return;
    }

    const session = getOnboardingSession(chatJid);
    if (!session?.location_id) {
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'Session expired. Use /reconnect to try again.',
      );
      return;
    }

    const active = getActiveCustomerLocation(chatJid);
    if (!active) {
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'No active location found. Use /locations first.',
      );
      return;
    }

    try {
      const profileSlug = `${active.slug}_${active.location_id}`;
      const newBridgeToken = await updateProfileToken(profileSlug, input);

      // Update bridge token in DB
      updateLocationBridgeToken(chatJid, active.location_id, newBridgeToken);

      // Update .bridge-token on disk
      const group = deps.registeredGroups()[chatJid];
      if (group) {
        switchActiveLocation(
          group.folder,
          newBridgeToken,
          active.business_name,
          active.location_id,
          active.description,
          active.bot_name,
        );
      }

      deleteOnboardingSession(chatJid);

      await deps.sendMessage(
        chatJid,
        `PIT token updated for *${active.business_name}*. Please delete the message containing the token.\n\nEverything is reconnected.`,
      );

      logger.info(
        { chatJid, locationId: active.location_id },
        'PIT token updated',
      );
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to update PIT token');
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'Failed to update token. Please try again with /reconnect.',
      );
    }
  }

  // ── /disconnect — Remove active location ─────────────────────────

  async function handleDisconnect(chatJid: string) {
    const groups = deps.registeredGroups();
    if (!groups[chatJid]) {
      await deps.sendMessage(chatJid, "You don't have an account yet.");
      return;
    }

    const active = getActiveCustomerLocation(chatJid);
    if (!active) {
      await deps.sendMessage(
        chatJid,
        'No active location to disconnect. Use /locations first.',
      );
      return;
    }

    const locations = getCustomerLocations(chatJid);
    if (locations.length <= 1) {
      await deps.sendMessage(
        chatJid,
        'This is your only location. To fully remove your account, revoke the PIT token in your GHL settings and contact support.',
      );
      return;
    }

    try {
      // Remove from profiles.yaml
      const profileSlug = `${active.slug}_${active.location_id}`;
      await deprovisionLocation(profileSlug);

      // Remove from DB
      removeCustomerLocation(chatJid, active.location_id);

      // Switch to the next available location
      const remaining = getCustomerLocations(chatJid);
      if (remaining.length > 0) {
        const next = remaining[0];
        setActiveCustomerLocation(chatJid, next.location_id);

        const group = deps.registeredGroups()[chatJid];
        if (group) {
          switchActiveLocation(
            group.folder,
            next.bridge_token,
            next.business_name,
            next.location_id,
            next.description,
            next.bot_name,
          );
        }

        await deps.sendMessage(
          chatJid,
          `Disconnected *${active.business_name}*. Switched to *${next.business_name}*.`,
        );
      }

      logger.info(
        { chatJid, locationId: active.location_id },
        'Location disconnected',
      );
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to disconnect location');
      await deps.sendMessage(
        chatJid,
        'Failed to disconnect. Please try again.',
      );
    }
  }

  // ── /pause and /resume ───────────────────────────────────────────

  async function handlePause(chatJid: string) {
    const groups = deps.registeredGroups();
    if (!groups[chatJid]) {
      await deps.sendMessage(chatJid, "You don't have an account yet.");
      return;
    }

    if (groups[chatJid].status === 'paused') {
      await deps.sendMessage(
        chatJid,
        'Your account is already paused. Use /resume to reactivate.',
      );
      return;
    }

    deps.setGroupStatus(chatJid, 'paused');
    await deps.sendMessage(
      chatJid,
      'Your account is now paused. AI responses are disabled.\n\nUse /resume to reactivate.',
    );

    logger.info({ chatJid }, 'Customer self-paused');
  }

  async function handleResume(chatJid: string) {
    const groups = deps.registeredGroups();
    if (!groups[chatJid]) {
      await deps.sendMessage(chatJid, "You don't have an account yet.");
      return;
    }

    if (groups[chatJid].status === 'active') {
      await deps.sendMessage(chatJid, 'Your account is already active!');
      return;
    }

    if (groups[chatJid].status === 'suspended') {
      await deps.sendMessage(
        chatJid,
        'Your account has been suspended. Please contact support.',
      );
      return;
    }

    deps.setGroupStatus(chatJid, 'active');
    await deps.sendMessage(
      chatJid,
      'Your account is active again. Welcome back!',
    );

    logger.info({ chatJid }, 'Customer self-resumed');
  }

  // ── /apikey — Set or remove customer's own Anthropic API key ────

  async function handleApiKey(chatJid: string) {
    const groups = deps.registeredGroups();
    if (!groups[chatJid]) {
      await deps.sendMessage(
        chatJid,
        'You need an account first. Send /start to begin setup.',
      );
      return;
    }

    const existing = getCustomerCredential(chatJid);
    const status = existing?.anthropic_api_key
      ? '\n\nYou currently have your own API key configured.'
      : '\n\nYou are currently using the shared API key.';

    upsertOnboardingSession({
      chat_jid: chatJid,
      state: 'apikey_awaiting_key',
      updated_at: new Date().toISOString(),
    });

    await deps.sendMessage(
      chatJid,
      `Bring your own Anthropic API key to use your own account for AI usage.${status}\n\nPaste your API key (starts with sk-ant-), send "remove" to clear your key, or "cancel" to abort.`,
    );
  }

  async function handleApiKeyInput(chatJid: string, input: string) {
    const lower = input.toLowerCase().trim();

    if (lower === 'cancel') {
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(chatJid, 'Cancelled.');
      return;
    }

    if (lower === 'remove') {
      deleteCustomerCredential(chatJid);
      deps.reloadTokenMap?.();
      deleteOnboardingSession(chatJid);
      await deps.sendMessage(
        chatJid,
        'Your API key has been removed. You are now using the shared key.',
      );
      logger.info({ chatJid }, 'Customer removed their API key');
      return;
    }

    // Validate API key format
    if (!input.startsWith('sk-ant-')) {
      await deps.sendMessage(
        chatJid,
        'That doesn\'t look like a valid Anthropic API key. It should start with sk-ant-.\n\nTry again, send "remove" to clear, or "cancel" to abort.',
      );
      return;
    }

    upsertCustomerCredential(chatJid, input);
    deps.reloadTokenMap?.();
    deleteOnboardingSession(chatJid);

    await deps.sendMessage(
      chatJid,
      'Your API key has been saved. Your AI usage will now be billed to your own Anthropic account.\n\nPlease delete the message containing your key from this chat for security.',
    );
    logger.info({ chatJid }, 'Customer set their own API key');
  }

  // ── /help ────────────────────────────────────────────────────────

  async function handleHelp(chatJid: string) {
    const groups = deps.registeredGroups();
    const isRegistered = !!groups[chatJid];

    if (!isRegistered) {
      await deps.sendMessage(
        chatJid,
        'Available commands:\n\n/start — Set up your account\n/help — Show this message',
      );
      return;
    }

    await deps.sendMessage(
      chatJid,
      'Available commands:\n\n/locations — List & switch GHL locations\n/connect — Connect a new GHL location\n/reconnect — Update PIT token for active location\n/disconnect — Remove active location\n/pause — Pause AI responses\n/resume — Resume AI responses\n/apikey — Use your own Anthropic API key\n/help — Show this message',
    );
  }

  return {
    startSession,
    handleMessage,
    handleLocations,
    handleConnect,
    handleReconnect,
    handleDisconnect,
    handlePause,
    handleResume,
    handleApiKey,
    handleHelp,
  };
}

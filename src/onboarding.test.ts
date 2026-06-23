import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  addCustomerLocation,
  deleteOnboardingSession,
  getActiveCustomerLocation,
  getCustomerLocations,
  getOnboardingSession,
  upsertOnboardingSession,
} from './db.js';
import { createOnboardingHandler, OnboardingDeps } from './onboarding.js';
import { RegisteredGroup } from './types.js';

// Mock provisioner to avoid filesystem/network calls
vi.mock('./provisioner.js', () => ({
  provision: vi.fn().mockResolvedValue({
    slug: 'acme_corp',
    groupFolder: 'telegram_acme_corp',
    bridgeToken: 'mock-bridge-token-123',
  }),
  provisionLocation: vi.fn().mockResolvedValue({
    bridgeToken: 'mock-new-bridge-token',
    profileSlug: 'acme_loc456',
  }),
  switchActiveLocation: vi.fn(),
  deprovisionLocation: vi.fn().mockResolvedValue(undefined),
  updateProfileToken: vi.fn().mockResolvedValue('mock-rotated-bridge-token'),
  generateSlug: vi.fn((name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s_]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 64),
  ),
}));

let sentMessages: Array<{ jid: string; text: string }>;
let registeredGroupsMap: Record<string, RegisteredGroup>;
let statusUpdates: Array<{ jid: string; status: string }>;
let deps: OnboardingDeps;
let handler: ReturnType<typeof createOnboardingHandler>;

beforeEach(() => {
  _initTestDatabase();
  sentMessages = [];
  registeredGroupsMap = {};
  statusUpdates = [];

  deps = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
    },
    registerGroup: (jid, group) => {
      registeredGroupsMap[jid] = group;
    },
    registeredGroups: () => registeredGroupsMap,
    setGroupStatus: (jid, status) => {
      statusUpdates.push({ jid, status });
    },
  };

  handler = createOnboardingHandler(deps);
});

describe('onboarding startSession', () => {
  it('sends welcome message and creates session', async () => {
    await handler.startSession('tg:100', 'Alice');

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('Welcome to HyloClaw');
    expect(sentMessages[0].text).toContain('business name');

    const session = getOnboardingSession('tg:100');
    expect(session).toBeDefined();
    expect(session!.state).toBe('awaiting_name');
  });

  it('rejects if already registered', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Existing',
      folder: 'telegram_existing',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };

    await handler.startSession('tg:100', 'Alice');

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('already have an active account');
    expect(getOnboardingSession('tg:100')).toBeUndefined();
  });
});

describe('onboarding handleMessage', () => {
  it('prompts /start when no session exists', async () => {
    await handler.handleMessage('tg:100', 'hello', 'Alice');

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('/start');
  });

  it('handles self_resume special message', async () => {
    await handler.handleMessage('tg:100', '__self_resume__', 'Alice');

    expect(statusUpdates).toHaveLength(1);
    expect(statusUpdates[0]).toEqual({ jid: 'tg:100', status: 'active' });
    expect(sentMessages[0].text).toContain('reactivated');
  });
});

describe('onboarding state machine', () => {
  beforeEach(async () => {
    await handler.startSession('tg:100', 'Alice');
    sentMessages = [];
  });

  it('awaiting_name: validates and advances', async () => {
    await handler.handleMessage('tg:100', 'Acme Corp', 'Alice');

    const session = getOnboardingSession('tg:100');
    expect(session!.state).toBe('awaiting_location_id');
    expect(session!.business_name).toBe('Acme Corp');
    expect(sentMessages[0].text).toContain('Location ID');
  });

  it('awaiting_name: rejects too short', async () => {
    await handler.handleMessage('tg:100', 'A', 'Alice');

    const session = getOnboardingSession('tg:100');
    expect(session!.state).toBe('awaiting_name');
    expect(sentMessages[0].text).toContain('at least 2 characters');
  });

  it('awaiting_name: rejects unsafe chars', async () => {
    await handler.handleMessage('tg:100', 'Acme "Corp"', 'Alice');

    const session = getOnboardingSession('tg:100');
    expect(session!.state).toBe('awaiting_name');
    expect(sentMessages[0].text).toContain('unsupported characters');
  });

  it('awaiting_location_id: validates format', async () => {
    // Advance to awaiting_location_id
    await handler.handleMessage('tg:100', 'Acme Corp', 'Alice');
    sentMessages = [];

    await handler.handleMessage('tg:100', 'abc', 'Alice');
    expect(sentMessages[0].text).toContain(
      "doesn't look like a valid Location ID",
    );

    sentMessages = [];
    await handler.handleMessage('tg:100', 'abc1234567890', 'Alice');
    const session = getOnboardingSession('tg:100');
    expect(session!.state).toBe('awaiting_pit_token');
    expect(session!.location_id).toBe('abc1234567890');
  });

  it('awaiting_pit_token: validates format', async () => {
    // Set up session at awaiting_pit_token
    upsertOnboardingSession({
      chat_jid: 'tg:100',
      state: 'awaiting_pit_token',
      business_name: 'Acme',
      location_id: 'abc1234567890',
    });

    await handler.handleMessage('tg:100', 'not-a-token', 'Alice');
    expect(sentMessages[0].text).toContain(
      "doesn't look like a valid PIT token",
    );
  });

  it('awaiting_description: validates and advances', async () => {
    upsertOnboardingSession({
      chat_jid: 'tg:100',
      state: 'awaiting_description',
      business_name: 'Acme',
      location_id: 'abc1234567890',
      pit_token: 'pit-aabbccddeeff00112233445566778899aabb',
    });

    await handler.handleMessage(
      'tg:100',
      'A plumbing company in Austin TX',
      'Alice',
    );

    const session = getOnboardingSession('tg:100');
    expect(session!.state).toBe('awaiting_bot_name');
    expect(session!.description).toBe('A plumbing company in Austin TX');
  });

  it('awaiting_bot_name: accepts default', async () => {
    upsertOnboardingSession({
      chat_jid: 'tg:100',
      state: 'awaiting_bot_name',
      business_name: 'Acme',
      location_id: 'abc1234567890',
      pit_token: 'pit-aabbccddeeff00112233445566778899aabb',
      description: 'Plumbing company',
    });

    await handler.handleMessage('tg:100', 'default', 'Alice');

    const session = getOnboardingSession('tg:100');
    expect(session!.state).toBe('confirming');
    expect(session!.bot_name).toBe('HyloClaw');
    expect(sentMessages[0].text).toContain('summary');
  });

  it('awaiting_bot_name: accepts custom name', async () => {
    upsertOnboardingSession({
      chat_jid: 'tg:100',
      state: 'awaiting_bot_name',
      business_name: 'Acme',
      location_id: 'abc1234567890',
      pit_token: 'pit-aabbccddeeff00112233445566778899aabb',
      description: 'Plumbing company',
    });

    await handler.handleMessage('tg:100', 'PlumbBot', 'Alice');

    const session = getOnboardingSession('tg:100');
    expect(session!.state).toBe('confirming');
    expect(session!.bot_name).toBe('PlumbBot');
  });

  it('confirming: no restarts the flow', async () => {
    upsertOnboardingSession({
      chat_jid: 'tg:100',
      state: 'confirming',
      business_name: 'Acme',
    });

    await handler.handleMessage('tg:100', 'no', 'Alice');

    expect(getOnboardingSession('tg:100')).toBeUndefined();
    expect(sentMessages[0].text).toContain('/start');
  });
});

// --- /locations command ---

describe('handleLocations', () => {
  it('rejects unregistered users', async () => {
    await handler.handleLocations('tg:100');
    expect(sentMessages[0].text).toContain('/start');
  });

  it('shows message when no locations', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };

    await handler.handleLocations('tg:100');
    expect(sentMessages[0].text).toContain('/connect');
  });

  it('shows single location without choice prompt', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Acme Plumbing',
      location_id: 'loc1',
      description: 'Plumbing',
      bot_name: 'HyloClaw',
      bridge_token: 'tok1',
      group_folder: 'telegram_acme',
      is_active: true,
    });

    await handler.handleLocations('tg:100');
    expect(sentMessages[0].text).toContain('Acme Plumbing');
    expect(sentMessages[0].text).toContain('/connect');
  });

  it('shows numbered list for multiple locations and handles selection', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Acme Plumbing',
      location_id: 'loc1',
      description: 'Plumbing',
      bot_name: 'HyloClaw',
      bridge_token: 'tok1',
      group_folder: 'telegram_acme',
      is_active: true,
    });
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Acme HVAC',
      location_id: 'loc2',
      description: 'HVAC',
      bot_name: 'HyloClaw',
      bridge_token: 'tok2',
      group_folder: 'telegram_acme',
    });

    await handler.handleLocations('tg:100');
    expect(sentMessages[0].text).toContain('1. Acme Plumbing');
    expect(sentMessages[0].text).toContain('2. Acme HVAC');
    expect(sentMessages[0].text).toContain('active');

    // User picks location 2
    sentMessages = [];
    await handler.handleMessage('tg:100', '2', 'Alice');

    expect(sentMessages[0].text).toContain('Switched to');
    expect(sentMessages[0].text).toContain('Acme HVAC');

    const active = getActiveCustomerLocation('tg:100');
    expect(active!.location_id).toBe('loc2');
  });

  it('rejects invalid number choice', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Loc A',
      location_id: 'l1',
      description: 'A',
      bot_name: 'Bot',
      bridge_token: 't1',
      group_folder: 'telegram_acme',
      is_active: true,
    });
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Loc B',
      location_id: 'l2',
      description: 'B',
      bot_name: 'Bot',
      bridge_token: 't2',
      group_folder: 'telegram_acme',
    });

    await handler.handleLocations('tg:100');
    sentMessages = [];

    await handler.handleMessage('tg:100', '5', 'Alice');
    expect(sentMessages[0].text).toContain('Invalid choice');
    // Session should be cleared
    expect(getOnboardingSession('tg:100')).toBeUndefined();
  });
});

// --- /connect command ---

describe('handleConnect', () => {
  it('rejects unregistered users', async () => {
    await handler.handleConnect('tg:100');
    expect(sentMessages[0].text).toContain('/start');
  });

  it('walks through name → location_id → pit_token → description flow', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Acme Plumbing',
      location_id: 'loc1',
      description: 'Plumbing',
      bot_name: 'HyloClaw',
      bridge_token: 'tok1',
      group_folder: 'telegram_acme',
      is_active: true,
    });

    await handler.handleConnect('tg:100');
    expect(sentMessages[0].text).toContain('name');

    sentMessages = [];
    await handler.handleMessage('tg:100', 'Acme HVAC', 'Alice');
    expect(getOnboardingSession('tg:100')!.state).toBe(
      'connect_awaiting_location_id',
    );

    sentMessages = [];
    await handler.handleMessage('tg:100', 'newloc123456789', 'Alice');
    expect(getOnboardingSession('tg:100')!.state).toBe(
      'connect_awaiting_pit_token',
    );

    sentMessages = [];
    await handler.handleMessage(
      'tg:100',
      'pit-aabbccddeeff00112233445566778899aabb',
      'Alice',
    );
    expect(getOnboardingSession('tg:100')!.state).toBe(
      'connect_awaiting_description',
    );

    sentMessages = [];
    await handler.handleMessage('tg:100', 'HVAC division in Dallas', 'Alice');
    expect(sentMessages.some((m) => m.text.includes('connected'))).toBe(true);
    expect(getOnboardingSession('tg:100')).toBeUndefined();

    const locs = getCustomerLocations('tg:100');
    expect(locs).toHaveLength(2);
  });

  it('rejects duplicate location_id', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Acme Plumbing',
      location_id: 'existingloc1234',
      description: 'Plumbing',
      bot_name: 'HyloClaw',
      bridge_token: 'tok1',
      group_folder: 'telegram_acme',
      is_active: true,
    });

    await handler.handleConnect('tg:100');
    sentMessages = [];
    await handler.handleMessage('tg:100', 'Duplicate Biz', 'Alice');
    sentMessages = [];

    await handler.handleMessage('tg:100', 'existingloc1234', 'Alice');
    expect(sentMessages[0].text).toContain('already connected');
  });
});

// --- /reconnect command ---

describe('handleReconnect', () => {
  it('rejects when no active location', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };

    await handler.handleReconnect('tg:100');
    expect(sentMessages[0].text).toContain('No active location');
  });

  it('updates PIT token for active location', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Acme Plumbing',
      location_id: 'loc1',
      description: 'Plumbing',
      bot_name: 'HyloClaw',
      bridge_token: 'old_tok',
      group_folder: 'telegram_acme',
      is_active: true,
    });

    await handler.handleReconnect('tg:100');
    expect(sentMessages[0].text).toContain('Acme Plumbing');

    sentMessages = [];
    await handler.handleMessage(
      'tg:100',
      'pit-aabbccdd11223344556677889900aabb',
      'Alice',
    );
    expect(sentMessages[0].text).toContain('updated');
    expect(getOnboardingSession('tg:100')).toBeUndefined();
  });
});

// --- /disconnect command ---

describe('handleDisconnect', () => {
  it('refuses to disconnect only location', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Acme',
      location_id: 'loc1',
      description: 'X',
      bot_name: 'Bot',
      bridge_token: 'tok',
      group_folder: 'telegram_acme',
      is_active: true,
    });

    await handler.handleDisconnect('tg:100');
    expect(sentMessages[0].text).toContain('only location');
    expect(getCustomerLocations('tg:100')).toHaveLength(1);
  });

  it('disconnects and switches to next location', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Loc A',
      location_id: 'lA',
      description: 'A',
      bot_name: 'Bot',
      bridge_token: 'tA',
      group_folder: 'telegram_acme',
      is_active: true,
    });
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Loc B',
      location_id: 'lB',
      description: 'B',
      bot_name: 'Bot',
      bridge_token: 'tB',
      group_folder: 'telegram_acme',
    });

    await handler.handleDisconnect('tg:100');
    expect(sentMessages[0].text).toContain('Disconnected');
    expect(sentMessages[0].text).toContain('Loc B');

    const remaining = getCustomerLocations('tg:100');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].location_id).toBe('lB');
  });
});

// --- /pause and /resume ---

describe('handlePause and handleResume', () => {
  it('pauses an active account', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      status: 'active',
    };

    await handler.handlePause('tg:100');
    expect(statusUpdates[0]).toEqual({ jid: 'tg:100', status: 'paused' });
    expect(sentMessages[0].text).toContain('paused');
  });

  it('resumes a paused account', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      status: 'paused',
    };

    await handler.handleResume('tg:100');
    expect(statusUpdates[0]).toEqual({ jid: 'tg:100', status: 'active' });
    expect(sentMessages[0].text).toContain('active');
  });

  it('refuses to resume a suspended account', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      status: 'suspended',
    };

    await handler.handleResume('tg:100');
    expect(statusUpdates).toHaveLength(0);
    expect(sentMessages[0].text).toContain('suspended');
  });
});

// --- /help ---

describe('handleHelp', () => {
  it('shows limited commands for unregistered users', async () => {
    await handler.handleHelp('tg:100');
    expect(sentMessages[0].text).toContain('/start');
    expect(sentMessages[0].text).not.toContain('/locations');
  });

  it('shows all commands for registered users', async () => {
    registeredGroupsMap['tg:100'] = {
      name: 'Acme',
      folder: 'telegram_acme',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };

    await handler.handleHelp('tg:100');
    expect(sentMessages[0].text).toContain('/locations');
    expect(sentMessages[0].text).toContain('/connect');
    expect(sentMessages[0].text).toContain('/reconnect');
    expect(sentMessages[0].text).toContain('/disconnect');
    expect(sentMessages[0].text).toContain('/pause');
    expect(sentMessages[0].text).toContain('/resume');
  });
});

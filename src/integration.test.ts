/**
 * Integration tests for HyloClaw multi-location flows.
 * Tests the full stack: onboarding → commands → provisioner → DB
 * against a real in-memory database (no mocks except filesystem/network).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  _initTestDatabase,
  addCustomerLocation,
  getActiveCustomerLocation,
  getCustomerLocationCount,
  getCustomerLocations,
  getOnboardingSession,
  setGroupStatus,
} from './db.js';
import { createOnboardingHandler, OnboardingDeps } from './onboarding.js';
import { RegisteredGroup } from './types.js';

// Mock provisioner (avoids filesystem + network)
vi.mock('./provisioner.js', () => {
  let callCount = 0;
  return {
    provision: vi.fn().mockImplementation(async (input: any) => {
      const slug = input.businessName
        .toLowerCase()
        .replace(/[^a-z0-9\s_]/g, '')
        .replace(/\s+/g, '_');
      return {
        slug,
        groupFolder: `telegram_${slug}`,
        bridgeToken: `bridge-tok-${++callCount}`,
      };
    }),
    provisionLocation: vi.fn().mockImplementation(async () => ({
      bridgeToken: `loc-bridge-tok-${++callCount}`,
      profileSlug: 'test_profile',
    })),
    switchActiveLocation: vi.fn(),
    deprovisionLocation: vi.fn().mockResolvedValue(undefined),
    updateProfileToken: vi.fn().mockResolvedValue('rotated-bridge-tok'),
    generateSlug: vi.fn((name: string) =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9\s_]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 64),
    ),
  };
});

// Mock fetch for bridge health check in PIT token validation
const originalFetch = globalThis.fetch;
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

let sent: Array<{ jid: string; text: string }>;
let groups: Record<string, RegisteredGroup>;
let statuses: Array<{ jid: string; status: string }>;
let handler: ReturnType<typeof createOnboardingHandler>;

function lastMsg(jid?: string) {
  const msgs = jid ? sent.filter((m) => m.jid === jid) : sent;
  return msgs[msgs.length - 1]?.text || '';
}

beforeEach(() => {
  _initTestDatabase();
  sent = [];
  groups = {};
  statuses = [];

  const deps: OnboardingDeps = {
    sendMessage: async (jid, text) => {
      sent.push({ jid, text });
    },
    registerGroup: (jid, group) => {
      groups[jid] = group;
    },
    registeredGroups: () => groups,
    setGroupStatus: (jid, status) => {
      statuses.push({ jid, status });
      if (groups[jid]) {
        groups[jid] = { ...groups[jid], status: status as any };
      }
    },
  };

  handler = createOnboardingHandler(deps);
});

// ─── Full Onboarding Flow ────────────────────────────────────────

describe('integration: full onboarding → active customer', () => {
  const JID = 'tg:1001';

  it('completes onboarding and creates first location', async () => {
    // Start
    await handler.startSession(JID, 'Alice');
    expect(lastMsg()).toContain('business name');

    // Business name
    sent = [];
    await handler.handleMessage(JID, 'Sunrise Dental', 'Alice');
    expect(lastMsg()).toContain('Location ID');

    // Location ID
    sent = [];
    await handler.handleMessage(JID, 'loc1234567890abc', 'Alice');
    expect(lastMsg()).toContain('PIT');

    // PIT token
    sent = [];
    await handler.handleMessage(
      JID,
      'pit-aabbccddeeff00112233445566778899aabb',
      'Alice',
    );
    expect(lastMsg()).toContain('describe your business');

    // Description
    sent = [];
    await handler.handleMessage(
      JID,
      'Family dental practice in Portland',
      'Alice',
    );
    expect(lastMsg()).toContain('assistant to be called');

    // Bot name
    sent = [];
    await handler.handleMessage(JID, 'default', 'Alice');
    expect(lastMsg()).toContain('summary');
    expect(lastMsg()).toContain('Sunrise Dental');

    // Confirm
    sent = [];
    await handler.handleMessage(JID, 'yes', 'Alice');

    // Verify: group registered, location saved, session cleared
    expect(groups[JID]).toBeDefined();
    expect(groups[JID].status).toBe('active');
    expect(getOnboardingSession(JID)).toBeUndefined();

    const locs = getCustomerLocations(JID);
    expect(locs).toHaveLength(1);
    expect(locs[0].business_name).toBe('Sunrise Dental');
    expect(locs[0].is_active).toBe(true);
    expect(lastMsg()).toContain('ready');
  });
});

// ─── Multi-Location Flow ─────────────────────────────────────────

describe('integration: multi-location lifecycle', () => {
  const JID = 'tg:2001';

  beforeEach(() => {
    // Pre-register customer with one location
    groups[JID] = {
      name: 'Acme Plumbing',
      folder: 'telegram_acme_plumbing',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: false,
      status: 'active',
    };
    addCustomerLocation({
      chat_jid: JID,
      slug: 'acme_plumbing',
      business_name: 'Acme Plumbing',
      location_id: 'locAAAA1234567',
      description: 'Plumbing company',
      bot_name: 'PlumbBot',
      bridge_token: 'bridge-initial',
      group_folder: 'telegram_acme_plumbing',
      is_active: true,
    });
  });

  it('/connect adds a second location', async () => {
    await handler.handleConnect(JID);
    expect(lastMsg()).toContain('name');

    sent = [];
    await handler.handleMessage(JID, 'Acme HVAC', 'Alice');
    expect(lastMsg()).toContain('Location ID');

    sent = [];
    await handler.handleMessage(JID, 'locBBBB5678901', 'Alice');
    expect(lastMsg()).toContain('PIT token');

    sent = [];
    await handler.handleMessage(
      JID,
      'pit-112233445566778899aabbccddeeff00aabb',
      'Alice',
    );
    expect(lastMsg()).toContain('describe');

    sent = [];
    await handler.handleMessage(JID, 'HVAC division in Austin', 'Alice');
    expect(lastMsg()).toContain('connected');
    expect(getCustomerLocationCount(JID)).toBe(2);
  });

  it('/connect rejects duplicate location', async () => {
    await handler.handleConnect(JID);
    sent = [];
    await handler.handleMessage(JID, 'Dup Biz', 'Alice');
    sent = [];

    await handler.handleMessage(JID, 'locAAAA1234567', 'Alice');
    expect(lastMsg()).toContain('already connected');
  });

  it('/locations shows list and switches', async () => {
    // Add second location
    addCustomerLocation({
      chat_jid: JID,
      slug: 'acme_plumbing',
      business_name: 'Acme HVAC',
      location_id: 'locBBBB5678901',
      description: 'HVAC',
      bot_name: 'PlumbBot',
      bridge_token: 'bridge-2',
      group_folder: 'telegram_acme_plumbing',
    });

    await handler.handleLocations(JID);
    expect(lastMsg()).toContain('1. Acme Plumbing');
    expect(lastMsg()).toContain('2. Acme HVAC');
    expect(lastMsg()).toContain('active');

    // Switch to location 2
    sent = [];
    await handler.handleMessage(JID, '2', 'Alice');
    expect(lastMsg()).toContain('Switched');
    expect(lastMsg()).toContain('Acme HVAC');

    const active = getActiveCustomerLocation(JID);
    expect(active!.location_id).toBe('locBBBB5678901');
  });

  it('/locations with single location shows info only', async () => {
    await handler.handleLocations(JID);
    expect(lastMsg()).toContain('Acme Plumbing');
    expect(lastMsg()).toContain('/connect');
    // Should NOT have created a session for number input
    expect(getOnboardingSession(JID)).toBeUndefined();
  });

  it('/disconnect removes active and switches to remaining', async () => {
    addCustomerLocation({
      chat_jid: JID,
      slug: 'acme_plumbing',
      business_name: 'Acme HVAC',
      location_id: 'locBBBB5678901',
      description: 'HVAC',
      bot_name: 'PlumbBot',
      bridge_token: 'bridge-2',
      group_folder: 'telegram_acme_plumbing',
    });

    await handler.handleDisconnect(JID);
    expect(lastMsg()).toContain('Disconnected');
    expect(lastMsg()).toContain('Acme HVAC');

    expect(getCustomerLocationCount(JID)).toBe(1);
    const active = getActiveCustomerLocation(JID);
    expect(active!.business_name).toBe('Acme HVAC');
  });

  it('/disconnect refuses to remove only location', async () => {
    await handler.handleDisconnect(JID);
    expect(lastMsg()).toContain('only location');
    expect(getCustomerLocationCount(JID)).toBe(1);
  });

  it('/reconnect updates PIT token', async () => {
    await handler.handleReconnect(JID);
    expect(lastMsg()).toContain('Acme Plumbing');

    sent = [];
    await handler.handleMessage(
      JID,
      'pit-ffeeddccbbaa99887766554433221100aabb',
      'Alice',
    );
    expect(lastMsg()).toContain('updated');
    expect(getOnboardingSession(JID)).toBeUndefined();
  });
});

// ─── Pause / Resume ──────────────────────────────────────────────

describe('integration: pause and resume', () => {
  const JID = 'tg:3001';

  beforeEach(() => {
    groups[JID] = {
      name: 'Test Biz',
      folder: 'telegram_test_biz',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      status: 'active',
    };
  });

  it('pause → resume cycle', async () => {
    await handler.handlePause(JID);
    expect(lastMsg()).toContain('paused');
    expect(groups[JID].status).toBe('paused');

    sent = [];
    await handler.handleResume(JID);
    expect(lastMsg()).toContain('active');
    expect(groups[JID].status).toBe('active');
  });

  it('double pause is idempotent', async () => {
    await handler.handlePause(JID);
    sent = [];
    await handler.handlePause(JID);
    expect(lastMsg()).toContain('already paused');
  });

  it('double resume is idempotent', async () => {
    await handler.handleResume(JID);
    expect(lastMsg()).toContain('already active');
  });

  it('self-resume via reactivate keyword', async () => {
    groups[JID].status = 'paused';
    await handler.handleMessage(JID, '__self_resume__', 'Alice');
    expect(statuses.some((s) => s.status === 'active')).toBe(true);
    expect(lastMsg()).toContain('reactivated');
  });

  it('suspended account cannot self-resume', async () => {
    groups[JID].status = 'suspended';
    await handler.handleResume(JID);
    expect(lastMsg()).toContain('suspended');
    expect(groups[JID].status).toBe('suspended');
  });
});

// ─── Cross-Tenant Isolation ──────────────────────────────────────

describe('integration: cross-tenant isolation', () => {
  const ALICE_JID = 'tg:4001';
  const BOB_JID = 'tg:4002';

  beforeEach(() => {
    groups[ALICE_JID] = {
      name: 'Alice Biz',
      folder: 'telegram_alice_biz',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      status: 'active',
    };
    groups[BOB_JID] = {
      name: 'Bob Biz',
      folder: 'telegram_bob_biz',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      status: 'active',
    };

    addCustomerLocation({
      chat_jid: ALICE_JID,
      slug: 'alice',
      business_name: 'Alice Corp',
      location_id: 'aliceLoc123456',
      description: 'Alice stuff',
      bot_name: 'AliceBot',
      bridge_token: 'alice-tok',
      group_folder: 'telegram_alice_biz',
      is_active: true,
    });
    addCustomerLocation({
      chat_jid: BOB_JID,
      slug: 'bob',
      business_name: 'Bob Inc',
      location_id: 'bobLocABCDEF12',
      description: 'Bob stuff',
      bot_name: 'BobBot',
      bridge_token: 'bob-tok',
      group_folder: 'telegram_bob_biz',
      is_active: true,
    });
  });

  it('Alice cannot see Bob locations', async () => {
    const aliceLocs = getCustomerLocations(ALICE_JID);
    const bobLocs = getCustomerLocations(BOB_JID);

    expect(aliceLocs).toHaveLength(1);
    expect(bobLocs).toHaveLength(1);
    expect(aliceLocs[0].business_name).toBe('Alice Corp');
    expect(bobLocs[0].business_name).toBe('Bob Inc');
  });

  it('pausing Alice does not affect Bob', async () => {
    await handler.handlePause(ALICE_JID);
    expect(groups[ALICE_JID].status).toBe('paused');
    expect(groups[BOB_JID].status).toBe('active');
  });

  it('/locations only shows own locations', async () => {
    await handler.handleLocations(ALICE_JID);
    const aliceMsg = lastMsg(ALICE_JID);
    expect(aliceMsg).toContain('Alice Corp');
    expect(aliceMsg).not.toContain('Bob');

    sent = [];
    await handler.handleLocations(BOB_JID);
    const bobMsg = lastMsg(BOB_JID);
    expect(bobMsg).toContain('Bob Inc');
    expect(bobMsg).not.toContain('Alice');
  });

  it('disconnecting Alice location does not affect Bob', async () => {
    // Give Alice a second location so disconnect is allowed
    addCustomerLocation({
      chat_jid: ALICE_JID,
      slug: 'alice',
      business_name: 'Alice Branch 2',
      location_id: 'aliceLoc999999',
      description: 'Branch',
      bot_name: 'AliceBot',
      bridge_token: 'alice-tok-2',
      group_folder: 'telegram_alice_biz',
    });

    await handler.handleDisconnect(ALICE_JID);
    expect(getCustomerLocationCount(ALICE_JID)).toBe(1);
    expect(getCustomerLocationCount(BOB_JID)).toBe(1);
    expect(getActiveCustomerLocation(BOB_JID)!.business_name).toBe('Bob Inc');
  });
});

// ─── /help ───────────────────────────────────────────────────────

describe('integration: help', () => {
  it('unregistered user sees /start only', async () => {
    await handler.handleHelp('tg:9001');
    expect(lastMsg()).toContain('/start');
    expect(lastMsg()).not.toContain('/locations');
  });

  it('registered user sees all commands', async () => {
    groups['tg:9002'] = {
      name: 'Test',
      folder: 'telegram_test',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };

    await handler.handleHelp('tg:9002');
    const msg = lastMsg();
    for (const cmd of [
      '/locations',
      '/connect',
      '/reconnect',
      '/disconnect',
      '/pause',
      '/resume',
    ]) {
      expect(msg).toContain(cmd);
    }
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────

describe('integration: edge cases', () => {
  it('commands on unregistered account get rejected', async () => {
    const JID = 'tg:8001';
    for (const fn of [
      handler.handleLocations,
      handler.handleConnect,
      handler.handleReconnect,
      handler.handleDisconnect,
    ]) {
      sent = [];
      await fn(JID);
      expect(lastMsg()).toMatch(/don't have|\/start/);
    }
  });

  it('concurrent onboarding sessions are independent', async () => {
    await handler.startSession('tg:7001', 'Alice');
    await handler.startSession('tg:7002', 'Bob');

    await handler.handleMessage('tg:7001', 'Alice Biz', 'Alice');
    await handler.handleMessage('tg:7002', 'Bob Biz', 'Bob');

    const s1 = getOnboardingSession('tg:7001');
    const s2 = getOnboardingSession('tg:7002');
    expect(s1!.business_name).toBe('Alice Biz');
    expect(s2!.business_name).toBe('Bob Biz');
    expect(s1!.state).toBe('awaiting_location_id');
    expect(s2!.state).toBe('awaiting_location_id');
  });

  it('/start while already registered shows help hint', async () => {
    groups['tg:6001'] = {
      name: 'Existing',
      folder: 'telegram_existing',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };

    await handler.startSession('tg:6001', 'Alice');
    expect(lastMsg()).toContain('already have');
    expect(lastMsg()).toContain('/help');
  });

  it('switching to already-active location is no-op', async () => {
    const JID = 'tg:5001';
    groups[JID] = {
      name: 'Test',
      folder: 'telegram_test',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    addCustomerLocation({
      chat_jid: JID,
      slug: 'test',
      business_name: 'Loc A',
      location_id: 'locA12345678',
      description: 'A',
      bot_name: 'Bot',
      bridge_token: 'tA',
      group_folder: 'telegram_test',
      is_active: true,
    });
    addCustomerLocation({
      chat_jid: JID,
      slug: 'test',
      business_name: 'Loc B',
      location_id: 'locB12345678',
      description: 'B',
      bot_name: 'Bot',
      bridge_token: 'tB',
      group_folder: 'telegram_test',
    });

    await handler.handleLocations(JID);
    sent = [];
    await handler.handleMessage(JID, '1', 'Alice');
    expect(lastMsg()).toContain('already active');
  });
});

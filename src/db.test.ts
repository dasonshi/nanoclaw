import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  addCustomerLocation,
  cleanupStaleOnboardingSessions,
  createTask,
  deleteOnboardingSession,
  deleteRegisteredGroup,
  deleteTask,
  getActiveCustomerLocation,
  getAllChats,
  getAllRegisteredGroups,
  getCustomerLocationCount,
  getCustomerLocations,
  getMessagesSince,
  getNewMessages,
  getOnboardingSession,
  getTaskById,
  removeCustomerLocation,
  setActiveCustomerLocation,
  setGroupStatus,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateLocationBridgeToken,
  updateTask,
  upsertOnboardingSession,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- Group status ---

describe('group status', () => {
  it('defaults to active when not set', () => {
    setRegisteredGroup('tg:123', {
      name: 'Test',
      folder: 'telegram_test',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    expect(groups['tg:123'].status).toBe('active');
  });

  it('persists status through set/get round-trip', () => {
    setRegisteredGroup('tg:456', {
      name: 'Paused Biz',
      folder: 'telegram_paused-biz',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      status: 'paused',
    });

    const groups = getAllRegisteredGroups();
    expect(groups['tg:456'].status).toBe('paused');
  });

  it('setGroupStatus updates status in DB', () => {
    setRegisteredGroup('tg:789', {
      name: 'Active Biz',
      folder: 'telegram_active-biz',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    setGroupStatus('tg:789', 'paused');
    const groups = getAllRegisteredGroups();
    expect(groups['tg:789'].status).toBe('paused');

    setGroupStatus('tg:789', 'active');
    const groups2 = getAllRegisteredGroups();
    expect(groups2['tg:789'].status).toBe('active');
  });

  it('deleteRegisteredGroup removes group from DB', () => {
    setRegisteredGroup('tg:del', {
      name: 'Delete Me',
      folder: 'telegram_delete-me',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    deleteRegisteredGroup('tg:del');
    const groups = getAllRegisteredGroups();
    expect(groups['tg:del']).toBeUndefined();
  });
});

// --- Onboarding sessions ---

describe('onboarding sessions', () => {
  it('creates and retrieves a session', () => {
    upsertOnboardingSession({
      chat_jid: 'tg:100',
      sender_name: 'Alice',
      state: 'awaiting_name',
    });

    const session = getOnboardingSession('tg:100');
    expect(session).toBeDefined();
    expect(session!.state).toBe('awaiting_name');
    expect(session!.sender_name).toBe('Alice');
    expect(session!.bot_name).toBe('HyloClaw');
  });

  it('updates existing session fields', () => {
    upsertOnboardingSession({
      chat_jid: 'tg:200',
      state: 'awaiting_name',
    });

    upsertOnboardingSession({
      chat_jid: 'tg:200',
      state: 'awaiting_location_id',
      business_name: 'Acme Corp',
    });

    const session = getOnboardingSession('tg:200');
    expect(session!.state).toBe('awaiting_location_id');
    expect(session!.business_name).toBe('Acme Corp');
  });

  it('deletes a session', () => {
    upsertOnboardingSession({
      chat_jid: 'tg:300',
      state: 'awaiting_name',
    });

    deleteOnboardingSession('tg:300');
    expect(getOnboardingSession('tg:300')).toBeUndefined();
  });

  it('cleans up stale sessions', () => {
    // Create a session, then set its updated_at to the past
    upsertOnboardingSession({
      chat_jid: 'tg:400',
      state: 'awaiting_name',
    });

    // Manually make it stale — cleanupStaleOnboardingSessions checks updated_at
    // Since we just created it, cleaning with maxAge=0 should delete it
    const cleaned = cleanupStaleOnboardingSessions(0);
    expect(cleaned).toBe(1);
    expect(getOnboardingSession('tg:400')).toBeUndefined();
  });
});

// --- Customer locations ---

describe('customer locations', () => {
  it('adds and retrieves locations', () => {
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Acme Plumbing',
      location_id: 'loc123',
      description: 'Plumbing company',
      bot_name: 'HyloClaw',
      bridge_token: 'tok1',
      group_folder: 'telegram_acme',
      is_active: true,
    });
    addCustomerLocation({
      chat_jid: 'tg:100',
      slug: 'acme',
      business_name: 'Acme HVAC',
      location_id: 'loc456',
      description: 'HVAC division',
      bot_name: 'HyloClaw',
      bridge_token: 'tok2',
      group_folder: 'telegram_acme',
    });

    const locs = getCustomerLocations('tg:100');
    expect(locs).toHaveLength(2);
    expect(locs[0].business_name).toBe('Acme Plumbing');
    expect(locs[0].is_active).toBe(true);
    expect(locs[1].business_name).toBe('Acme HVAC');
    expect(locs[1].is_active).toBe(false);
  });

  it('gets active location', () => {
    addCustomerLocation({
      chat_jid: 'tg:200',
      slug: 'biz',
      business_name: 'Biz A',
      location_id: 'locA',
      description: 'A',
      bot_name: 'Bot',
      bridge_token: 'tokA',
      group_folder: 'telegram_biz',
      is_active: true,
    });

    const active = getActiveCustomerLocation('tg:200');
    expect(active).toBeDefined();
    expect(active!.location_id).toBe('locA');
  });

  it('switches active location', () => {
    addCustomerLocation({
      chat_jid: 'tg:300',
      slug: 'multi',
      business_name: 'Loc 1',
      location_id: 'l1',
      description: '1',
      bot_name: 'Bot',
      bridge_token: 't1',
      group_folder: 'telegram_multi',
      is_active: true,
    });
    addCustomerLocation({
      chat_jid: 'tg:300',
      slug: 'multi',
      business_name: 'Loc 2',
      location_id: 'l2',
      description: '2',
      bot_name: 'Bot',
      bridge_token: 't2',
      group_folder: 'telegram_multi',
    });

    setActiveCustomerLocation('tg:300', 'l2');

    const active = getActiveCustomerLocation('tg:300');
    expect(active!.location_id).toBe('l2');

    const all = getCustomerLocations('tg:300');
    expect(all[0].is_active).toBe(false);
    expect(all[1].is_active).toBe(true);
  });

  it('removes a location', () => {
    addCustomerLocation({
      chat_jid: 'tg:400',
      slug: 'rm',
      business_name: 'Remove Me',
      location_id: 'rmLoc',
      description: 'Test',
      bot_name: 'Bot',
      bridge_token: 'tok',
      group_folder: 'telegram_rm',
    });

    removeCustomerLocation('tg:400', 'rmLoc');
    expect(getCustomerLocations('tg:400')).toHaveLength(0);
  });

  it('updates bridge token', () => {
    addCustomerLocation({
      chat_jid: 'tg:500',
      slug: 'upd',
      business_name: 'Update',
      location_id: 'updLoc',
      description: 'Test',
      bot_name: 'Bot',
      bridge_token: 'old_tok',
      group_folder: 'telegram_upd',
      is_active: true,
    });

    updateLocationBridgeToken('tg:500', 'updLoc', 'new_tok');

    const active = getActiveCustomerLocation('tg:500');
    expect(active!.bridge_token).toBe('new_tok');
  });

  it('counts locations', () => {
    expect(getCustomerLocationCount('tg:600')).toBe(0);

    addCustomerLocation({
      chat_jid: 'tg:600',
      slug: 'cnt',
      business_name: 'A',
      location_id: 'a1',
      description: 'A',
      bot_name: 'Bot',
      bridge_token: 'tA',
      group_folder: 'telegram_cnt',
    });
    addCustomerLocation({
      chat_jid: 'tg:600',
      slug: 'cnt',
      business_name: 'B',
      location_id: 'b1',
      description: 'B',
      bot_name: 'Bot',
      bridge_token: 'tB',
      group_folder: 'telegram_cnt',
    });

    expect(getCustomerLocationCount('tg:600')).toBe(2);
  });

  it('enforces unique chat_jid + location_id', () => {
    addCustomerLocation({
      chat_jid: 'tg:700',
      slug: 'dup',
      business_name: 'Dup',
      location_id: 'sameLoc',
      description: 'First',
      bot_name: 'Bot',
      bridge_token: 'tok1',
      group_folder: 'telegram_dup',
    });

    expect(() =>
      addCustomerLocation({
        chat_jid: 'tg:700',
        slug: 'dup',
        business_name: 'Dup2',
        location_id: 'sameLoc',
        description: 'Second',
        bot_name: 'Bot',
        bridge_token: 'tok2',
        group_folder: 'telegram_dup',
      }),
    ).toThrow();
  });
});

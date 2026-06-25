import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, getDb } from '../db.js';
import { initTelegram, notify } from '../telegram.js';

// Mock bot factory — creates a mock TelegramBot constructor for test injection
function makeMockBot() {
  const sent = [];
  const handlers = {};
  function MockBot(_token, _opts) {
    this.on = (event, handler) => { handlers[event] = handler; };
    this.sendMessage = (chatId, text) => {
      sent.push({ chatId: String(chatId), text });
      return Promise.resolve();
    };
  }
  return { MockBot, sent, handlers };
}

// Fire a simulated incoming Telegram message
function fire(handlers, msg) {
  handlers['message']?.(msg);
}

before(() => { initDb(':memory:'); });
afterEach(() => { initDb(':memory:'); }); // fresh DB per test

test('telegram_chat_ids table exists after initDb', () => {
  const db = initDb(':memory:');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('telegram_chat_ids'), 'telegram_chat_ids table missing');
});

test('initTelegram returns null when no token configured', () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  const result = initTelegram({}, class MockBot {});
  assert.equal(result, null);
});

test('notify is no-op when bot not initialized', () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  initTelegram({}, class MockBot {});
  // Must not throw
  notify('test message');
});

test('/start with empty allowlist registers chat ID and sends welcome', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  const { MockBot, sent, handlers } = makeMockBot();
  initTelegram({}, MockBot);
  fire(handlers, { chat: { id: 42 }, text: '/start' });
  await new Promise(r => setTimeout(r, 10));
  const ids = getDb().prepare('SELECT chat_id FROM telegram_chat_ids').all().map(r => r.chat_id);
  assert.deepEqual(ids, ['42']);
  assert.ok(sent.length > 0, 'welcome message not sent');
  assert.ok(sent[0].text.includes('registered'), `expected "registered" in: ${sent[0].text}`);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('/start with non-empty allowlist, unknown sender — silent drop', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  const { MockBot, sent, handlers } = makeMockBot();
  getDb().prepare('INSERT OR IGNORE INTO telegram_chat_ids (chat_id) VALUES (?)').run('99');
  initTelegram({}, MockBot);
  fire(handlers, { chat: { id: 55 }, text: '/start' });
  await new Promise(r => setTimeout(r, 10));
  const ids = getDb().prepare('SELECT chat_id FROM telegram_chat_ids').all().map(r => r.chat_id);
  assert.deepEqual(ids, ['99'], 'unauthorized sender should not be registered');
  assert.equal(sent.length, 0, 'should not send any message to unauthorized sender');
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('/start with non-empty allowlist, known sender — greeting sent', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  const { MockBot, sent, handlers } = makeMockBot();
  getDb().prepare('INSERT OR IGNORE INTO telegram_chat_ids (chat_id) VALUES (?)').run('42');
  initTelegram({}, MockBot);
  fire(handlers, { chat: { id: 42 }, text: '/start' });
  await new Promise(r => setTimeout(r, 10));
  assert.ok(sent.length > 0, 'greeting not sent');
  assert.ok(sent[0].text.includes('/help'), `expected "/help" in: ${sent[0].text}`);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('/addtask from authorized sender creates queue task with created_by: telegram', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  const created = [];
  const { MockBot, sent, handlers } = makeMockBot();
  getDb().prepare('INSERT OR IGNORE INTO telegram_chat_ids (chat_id) VALUES (?)').run('42');
  initTelegram({
    createQueueTask: (opts) => { created.push(opts); return { id: 7, title: opts.title, status: 'pending' }; },
    writeToAgent: () => {},
  }, MockBot);
  fire(handlers, { chat: { id: 42 }, text: '/addtask Write unit tests' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(created.length, 1);
  assert.equal(created[0].title, 'Write unit tests');
  assert.equal(created[0].created_by, 'telegram');
  assert.ok(sent[0].text.includes('#7'), `expected "#7" in: ${sent[0].text}`);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('/message from unauthorized sender — no-op', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  const written = [];
  const { MockBot, sent, handlers } = makeMockBot();
  getDb().prepare('INSERT OR IGNORE INTO telegram_chat_ids (chat_id) VALUES (?)').run('99');
  initTelegram({
    writeToAgent: (name, text) => { written.push({ name, text }); },
    createQueueTask: () => {},
  }, MockBot);
  fire(handlers, { chat: { id: 55 }, text: '/message agent1 hello' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(written.length, 0, 'writeToAgent must not be called for unauthorized sender');
  assert.equal(sent.length, 0, 'no message should be sent to unauthorized sender');
  delete process.env.TELEGRAM_BOT_TOKEN;
});

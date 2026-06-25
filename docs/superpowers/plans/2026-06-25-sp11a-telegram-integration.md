# SP11a: Telegram Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Telegram bot to Flint that pushes notifications for agent lifecycle events, suggestions, queue changes, and cost alerts, and accepts `/status`, `/cost`, `/addtask`, and `/message` commands from Robin's authorized chat ID.

**Architecture:** New `dashboard/telegram.js` module using `node-telegram-bot-api` in polling mode. Bot token read via existing `getApiKeyValue('telegram')` (DB-first, env fallback). Chat IDs stored in a new `telegram_chat_ids` SQLite table. Dependency injection (`initTelegram(services)`) breaks circular imports between `telegram.js`, `terminal.js`, and `queue.js`.

**Tech Stack:** Node.js, `node-telegram-bot-api` (new), better-sqlite3 (existing), `node:test` (existing).

## Global Constraints

- `node-telegram-bot-api` is the only new npm dependency.
- `telegram.js` must NOT import from `terminal.js` or `queue.js` (circular import prevention) — these functions are injected via `initTelegram(services)`.
- `telegram.js` CAN import from: `db.js`, `apikeys.js`, `agents.js`, `logger.js`.
- Signature: `initTelegram(services: { writeToAgent, createQueueTask }, _BotConstructor = TelegramBot): bot | null` — second param allows test injection.
- `notify(text)` must never throw — always catch and log errors internally.
- If no bot token is configured, `initTelegram` returns `null` and `notify` is a no-op.
- All `notify()` calls in `terminal.js` and `queue.js` are fire-and-forget (no await, no error propagation into the caller).
- Cost alert threshold: `TELEGRAM_COST_ALERT_USD` env var (default `5`). Fires at most once per calendar day (module-level `_lastAlertDate` string dedup).
- Unauthorized senders receive no response (silent drop — no information leakage).
- `node --test` must pass all existing + new tests. Total expected after Task 1: 159 (151 existing + 8 new).
- All commits on `master`.

---

### Task 1: `telegram.js` module + DB table

**Files:**
- Create: `dashboard/telegram.js`
- Modify: `dashboard/db.js` — add `telegram_chat_ids` table inside the existing `_db.exec()` block
- Modify: `dashboard/package.json` — add `node-telegram-bot-api` to dependencies; add `tests/telegram.test.js` to test script
- Create: `dashboard/tests/telegram.test.js`

**Interfaces:**
- Consumes:
  - `getDb()` from `./db.js` — synchronous DB handle
  - `getMonthCost()` from `./db.js` — returns number (total USD this month, all agents)
  - `getApiKeyValue(name: string)` from `./apikeys.js` — returns string or null
  - `listAgents()` from `./agents.js` — returns `Array<{ name, status, mode, workdir, model, runtime }>`
  - `info(msg, meta?)` and `error(msg, meta?)` from `./logger.js`
- Produces:
  - `initTelegram(services, _BotConstructor?): bot | null`
  - `notify(text: string): void`

---

- [ ] **Step 1: Install `node-telegram-bot-api`**

```bash
cd dashboard && npm install node-telegram-bot-api
```

Expected: `node_modules/node-telegram-bot-api` exists, `package.json` dependencies updated.

- [ ] **Step 2: Write the failing tests**

Create `dashboard/tests/telegram.test.js`:

```js
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
```

- [ ] **Step 3: Run tests — expect failure (module not yet created)**

```bash
cd dashboard && node --test tests/telegram.test.js 2>&1 | tail -5
```

Expected: error about `../telegram.js` not found.

- [ ] **Step 4: Add `telegram_chat_ids` to `dashboard/db.js`**

In `db.js`, inside the `_db.exec(` `` ` `` ... `` ` `` `)` block, after the `api_keys` table (after `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` + closing `);`), add:

```sql
    CREATE TABLE IF NOT EXISTS telegram_chat_ids (
      chat_id  TEXT PRIMARY KEY,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
```

- [ ] **Step 5: Create `dashboard/telegram.js`**

```js
import TelegramBot from 'node-telegram-bot-api';
import { getDb, getMonthCost } from './db.js';
import { getApiKeyValue } from './apikeys.js';
import { listAgents } from './agents.js';
import { info, error as logError } from './logger.js';

const COST_ALERT_USD = parseFloat(process.env.TELEGRAM_COST_ALERT_USD ?? '5');

let _bot = null;
let _services = {};
let _lastAlertDate = '';

function getChatIds() {
  return getDb().prepare('SELECT chat_id FROM telegram_chat_ids').all().map(r => r.chat_id);
}

function addChatId(chatId) {
  getDb().prepare('INSERT OR IGNORE INTO telegram_chat_ids (chat_id) VALUES (?)').run(String(chatId));
}

function isAuthorized(chatId) {
  return getDb().prepare('SELECT 1 FROM telegram_chat_ids WHERE chat_id = ?').get(String(chatId)) != null;
}

export function notify(text) {
  if (!_bot) return;
  for (const chatId of getChatIds()) {
    _bot.sendMessage(chatId, text).catch(err => logError('telegram notify failed', { err: err.message }));
  }
}

export function initTelegram(services, _BotConstructor = TelegramBot) {
  _services = services ?? {};
  const token = getApiKeyValue('telegram');
  if (!token) {
    info('telegram: no token configured — bot disabled');
    _bot = null;
    return null;
  }

  _bot = new _BotConstructor(token, { polling: true });
  info('telegram: bot started');

  _bot.on('message', (msg) => {
    const chatId = String(msg.chat.id);
    const text = (msg.text ?? '').trim();

    if (text === '/start') {
      const ids = getChatIds();
      if (ids.length === 0) {
        addChatId(chatId);
        _bot.sendMessage(chatId,
          '👋 Hi Robin! I\'m Flint. You\'re now registered.\n\n' +
          'Commands:\n/status — running agents\n/cost — today\'s spend\n' +
          '/addtask <title> — add queue task\n/message <agent> <text> — message agent\n/help — this list'
        ).catch(() => {});
      } else if (isAuthorized(chatId)) {
        _bot.sendMessage(chatId, '👋 Already registered. Try /help.').catch(() => {});
      }
      // unauthorized /start: silent drop
      return;
    }

    if (!isAuthorized(chatId)) return;

    if (text === '/help') {
      _bot.sendMessage(chatId,
        'Commands:\n/status — running agents\n/cost — today\'s spend\n' +
        '/addtask <title> — add queue task\n/message <agent> <text> — message agent'
      ).catch(() => {});
      return;
    }

    if (text === '/status' || text === '/agents') {
      const agents = listAgents();
      if (agents.length === 0) {
        _bot.sendMessage(chatId, 'No agents registered.').catch(() => {});
        return;
      }
      const lines = agents.map(a => `• ${a.name}: ${a.status ?? 'unknown'}`).join('\n');
      _bot.sendMessage(chatId, `Agents:\n${lines}`).catch(() => {});
      return;
    }

    if (text === '/cost') {
      const todayRow = getDb().prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE date(timestamp) = date('now')`
      ).get();
      const month = getMonthCost();
      _bot.sendMessage(chatId,
        `💰 Today: $${todayRow.total.toFixed(4)}\n📅 This month: $${month.toFixed(4)}`
      ).catch(() => {});
      return;
    }

    if (text.startsWith('/addtask ')) {
      const title = text.slice('/addtask '.length).trim();
      if (!title) {
        _bot.sendMessage(chatId, 'Usage: /addtask <title>').catch(() => {});
        return;
      }
      try {
        const task = _services.createQueueTask({ title, created_by: 'telegram' });
        _bot.sendMessage(chatId, `✅ Task #${task.id} added: "${task.title}"`).catch(() => {});
      } catch (err) {
        _bot.sendMessage(chatId, `❌ Failed: ${err.message}`).catch(() => {});
      }
      return;
    }

    if (text.startsWith('/message ')) {
      const rest = text.slice('/message '.length).trim();
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) {
        _bot.sendMessage(chatId, 'Usage: /message <agent> <text>').catch(() => {});
        return;
      }
      const agent = rest.slice(0, spaceIdx);
      const msg2 = rest.slice(spaceIdx + 1);
      _services.writeToAgent?.(agent, msg2 + '\n');
      _bot.sendMessage(chatId, `✉️ Sent to ${agent}`).catch(() => {});
      return;
    }

    _bot.sendMessage(chatId, 'Unknown command. Try /help').catch(() => {});
  });

  setInterval(() => {
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      if (_lastAlertDate === todayStr) return;
      const row = getDb().prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE date(timestamp) = date('now')`
      ).get();
      if (row.total >= COST_ALERT_USD) {
        _lastAlertDate = todayStr;
        notify(`⚠️ Daily spend alert: $${row.total.toFixed(4)} (threshold: $${COST_ALERT_USD})`);
      }
    } catch (err) {
      logError('telegram cost alert error', { err: err.message });
    }
  }, 60 * 60 * 1000);

  return _bot;
}
```

- [ ] **Step 6: Update `dashboard/package.json` test script**

In `package.json`, replace:
```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js"
```

With:
```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js tests/telegram.test.js"
```

- [ ] **Step 7: Run the full test suite — expect 159 pass**

```bash
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 159
ℹ pass 159
ℹ fail 0
```

- [ ] **Step 8: Commit**

```bash
git add dashboard/telegram.js dashboard/db.js dashboard/package.json dashboard/package-lock.json dashboard/tests/telegram.test.js
git commit -m "feat(sp11a): add telegram.js bot module with notify, commands, and chat ID allowlist"
```

---

### Task 2: Integration wiring (server.js + terminal.js + queue.js)

**Files:**
- Modify: `dashboard/server.js` — import `initTelegram`, `notify`; call `initTelegram` in `createApp()`
- Modify: `dashboard/terminal.js` — import `notify`; add 4 `notify()` calls (spawn, exit-clean, exit-crash, suggestion)
- Modify: `dashboard/queue.js` — import `notify`; add `notify()` calls to `completeQueueTask` and `cancelQueueTask`

**Interfaces:**
- Consumes:
  - `initTelegram(services)` from Task 1 — call with `{ writeToAgent, createQueueTask }`
  - `notify(text: string)` from Task 1 — fire-and-forget, never throws
- Produces: nothing consumed by other tasks

---

- [ ] **Step 1: Wire `telegram.js` into `server.js`**

In `dashboard/server.js`, add to the import block after line 20 (the `listApiKeys` import line):

```js
import { initTelegram } from './telegram.js';
```

In `createApp()`, after `if (!TEST_MODE) startQueuePoller();` (line 69), add:

```js
  if (!TEST_MODE) initTelegram({ writeToAgent, createQueueTask });
```

- [ ] **Step 2: Add `notify` import to `terminal.js`**

In `dashboard/terminal.js`, add to the imports block after line 10 (the `injectMcpConfig` import):

```js
import { notify } from './telegram.js';
```

- [ ] **Step 3: Add agent-spawn notification in `terminal.js`**

After line 91 (`setAgentStatus(name, 'running');`), add:

```js
  notify(`🟢 Agent \`${name}\` started`);
```

- [ ] **Step 4: Add suggestion notification in `terminal.js`**

Replace the suggestion block (lines 129–137) — add a `notify` call after the `broadcastGlobal`:

```js
    const suggMatch = suggBuffer.match(SUGGESTION_REGEX);
    if (suggMatch) {
      const suggestion = createSuggestion(name, suggMatch[1].trim());
      if (suggestion) {
        broadcastGlobal({ type: 'suggestion', suggestion });
        notify(`💡 Suggestion from \`${name}\`: ${suggestion.content.slice(0, 200)}`);
      }
      // Remove matched text so the same suggestion doesn't fire again
      suggBuffer = suggBuffer.slice(suggBuffer.indexOf(suggMatch[0]) + suggMatch[0].length);
    }
```

- [ ] **Step 5: Add exit notification in `terminal.js`**

Replace line 153 to capture the exit code and notify:

```js
  ptyProcess.onExit(({ exitCode }) => {
    clearInterval(idleChecker);
    notify(exitCode === 0
      ? `✅ Agent \`${name}\` finished`
      : `🔴 Agent \`${name}\` crashed (exit ${exitCode})`);
```

The rest of the `onExit` body (lines 155–171) is unchanged.

- [ ] **Step 6: Add `notify` import to `queue.js`**

In `dashboard/queue.js`, add to the imports block after line 4 (the `broadcastGlobal` import):

```js
import { notify } from './telegram.js';
```

- [ ] **Step 7: Add task-complete notification in `queue.js`**

Replace `completeQueueTask` (lines 90–95):

```js
export function completeQueueTask(id, result = '') {
  getDb().prepare(
    `UPDATE task_queue SET status = 'done', result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(result, id);
  broadcastGlobal({ type: 'queue_task_done', taskId: id });
}
```

With:

```js
export function completeQueueTask(id, result = '') {
  const task = getQueueTask(id);
  getDb().prepare(
    `UPDATE task_queue SET status = 'done', result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(result, id);
  broadcastGlobal({ type: 'queue_task_done', taskId: id });
  if (task) notify(`✅ Queue task #${id} done: "${task.title}"`);
}
```

- [ ] **Step 8: Add task-cancel notification in `queue.js`**

Replace `cancelQueueTask` (lines 97–101):

```js
export function cancelQueueTask(id) {
  getDb().prepare(
    `UPDATE task_queue SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(id);
}
```

With:

```js
export function cancelQueueTask(id) {
  const task = getQueueTask(id);
  getDb().prepare(
    `UPDATE task_queue SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(id);
  if (task) notify(`❌ Queue task #${id} cancelled: "${task.title}"`);
}
```

- [ ] **Step 9: Run the full test suite — expect 159 pass**

```bash
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 159
ℹ pass 159
ℹ fail 0
```

- [ ] **Step 10: Commit**

```bash
git add dashboard/server.js dashboard/terminal.js dashboard/queue.js
git commit -m "feat(sp11a): wire telegram notifications into server, terminal, and queue"
```

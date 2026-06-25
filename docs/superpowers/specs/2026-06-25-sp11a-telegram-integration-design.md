# SP11a: Telegram Integration — Design Spec

**Date:** 2026-06-25
**Status:** Approved

## Overview

Remote notifications and light control for Flint via a Telegram bot. Robin receives alerts when agents start, finish, or crash, when suggestions arrive, when queue tasks complete, and when daily spend crosses a threshold. Robin can also query status and add tasks or send messages to agents — all from Telegram while away from the dashboard.

---

## Architecture

**Files:**
- **New:** `dashboard/telegram.js` — all bot logic (init, polling, commands, notify)
- **Modify:** `dashboard/db.js` — add `telegram_chat_ids` table to `_db.exec()` block
- **Modify:** `dashboard/server.js` — call `initTelegram()` after `initDb()` at startup
- **Modify:** `dashboard/terminal.js` — call `notify()` on agent start, exit, crash, suggestion
- **Modify:** `dashboard/queue.js` — call `notify()` on task complete/cancel
- **New:** `dashboard/tests/telegram.test.js` — unit tests

The bot token is read via the existing `getApiKeyValue('telegram')` (DB-first, env var `TELEGRAM_BOT_TOKEN` fallback). The `telegram` entry is already seeded in the `api_keys` table. If no token is configured, `initTelegram()` returns null and `notify()` is a no-op — the rest of the server is unaffected.

Uses `node-telegram-bot-api` npm package in polling mode. No webhook, no public URL required.

---

## Data Model

New table added to the `_db.exec()` block in `db.js`:

```sql
CREATE TABLE IF NOT EXISTS telegram_chat_ids (
  chat_id  TEXT PRIMARY KEY,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

DB queries are made directly inside `telegram.js` via `getDb()` — not exported from `db.js` since no other module needs them.

---

## telegram.js Module

### Exports

- `initTelegram(services)` — creates the `TelegramBot` instance, starts polling, registers command handlers, starts the cost alert interval. Returns the bot instance or null if no token is configured. Accepts a `services` object to avoid circular imports (see below).
- `notify(text)` — sends `text` to every chat ID in the `telegram_chat_ids` table. No-op if bot not initialized. Fire-and-forget (catches and logs errors, never throws).

### Dependency Injection (avoiding circular imports)

`terminal.js` and `queue.js` import `notify` from `telegram.js`. If `telegram.js` also imported `writeToAgent` from `terminal.js` and `createQueueTask` from `queue.js`, that would be circular. Instead, `server.js` injects these at startup:

```js
// server.js
initTelegram({
  writeToAgent,
  createQueueTask,
  getTodayCost,
  getMonthCost,
  listAgents,
});
```

`telegram.js` stores these in module-level variables set during `initTelegram`. No imports from `terminal.js` or `queue.js` in `telegram.js`.

### Bootstrap

When `/start` arrives and `telegram_chat_ids` is empty, auto-register that sender's chat ID and reply with a welcome message + command list. If the allowlist is non-empty and the sender is not in it, reply "Unauthorized." This means Robin sends `/start` once after configuring the bot token to register themselves.

### Commands

| Command | Behaviour |
|---------|-----------|
| `/start` | Bootstrap (register if allowlist empty) or greeting if already authorized |
| `/status` | Lists all agents and their status from `agents_log` |
| `/cost` | Today's spend and monthly total via `getTodayCost` / `getMonthCost` |
| `/addtask <title>` | Calls `createQueueTask({ title, created_by: 'telegram' })` |
| `/message <agent> <text>` | Calls `writeToAgent(agent, text + '\n')` |
| `/help` | Lists all available commands |
| anything else | "Unknown command. Try /help" |

All commands except `/start` check that the sender's chat ID is in the allowlist before responding. Unauthorized senders receive no response (silent drop — no information leakage about the bot's existence).

### Cost Alert

`setInterval` runs every hour. Sums today's cost across all agents via a direct DB query (`SELECT COALESCE(SUM(cost_usd), 0) FROM usage WHERE date(timestamp) = date('now')`). If the total exceeds `TELEGRAM_COST_ALERT_USD` (env var, default `5`), fires `notify()` with the current total. Deduped with a module-level `lastAlertDate` string (ISO date `YYYY-MM-DD`) so it fires at most once per calendar day.

---

## Notification Integration Points

All `notify()` calls are fire-and-forget — no `await`, no error propagation.

### terminal.js

| Event | Message |
|-------|---------|
| Agent spawned (after ptyProcess created) | `` 🟢 Agent `name` started `` |
| Agent exited cleanly (exit code 0) | `` ✅ Agent `name` finished `` |
| Agent crashed (exit code ≠ 0) | `` 🔴 Agent `name` crashed (exit N) `` |
| Suggestion captured (after `createSuggestion`, only if non-null) | `` 💡 Suggestion from `name`: <first 200 chars of content> `` |

The suggestion notify fires right after the existing `createSuggestion()` call (line 131). The 60-second dedup guard in `createSuggestion` already prevents duplicate suggestions from re-notifying.

### queue.js

| Event | Message |
|-------|---------|
| Task completed (`completeQueueTask`) | `✅ Queue task #N done: "title"` |
| Task cancelled (`cancelQueueTask`) | `❌ Queue task #N cancelled: "title"` |

---

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | — | Bot token (env fallback; DB key takes precedence) |
| `TELEGRAM_COST_ALERT_USD` | `5` | Daily spend threshold in USD before alert fires |

---

## Out of Scope

- Per-agent notification filtering (all agents notify)
- Multiple allowed users managed via UI (allowlist managed via `/start` bootstrap + DB directly if needed)
- Message threading or reply chains
- Inline keyboards or button interactions
- Encryption of stored chat IDs

---

## Test Approach

`dashboard/tests/telegram.test.js` uses `node:test` with mocked `TelegramBot` constructor and in-memory DB via `initDb(':memory:')`:

- `initTelegram()` returns null when no token configured
- `notify()` is a no-op when bot not initialized
- `/start` with empty allowlist → registers sender's chat ID, sends welcome
- `/start` with non-empty allowlist, unknown sender → does not register, no response
- `/start` with non-empty allowlist, known sender → sends greeting
- `/addtask` from authorized chat ID → task created in DB with `created_by: 'telegram'`
- `/message` from unauthorized chat ID → no-op (no write to agent)
- Cost alert fires `notify()` when daily spend exceeds threshold

Target: ~8 new tests. Existing 151 tests must still pass (`cd dashboard && node --test`).

# Level 3 Hybrid: Flint Heartbeat + OpenRouter Agent

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Flint an autonomous LLM brain (heartbeat loop) and the ability to spawn interactive agents powered by any OpenRouter model.

**Architecture:**
- Heartbeat: `setInterval` in server.js calls `runHeartbeatCycle()` every N minutes. Cycle collects compact system state, POSTs to router `/llm/complete`, parses JSON response `{ note, actions[] }`, executes actions (create_task), logs to `heartbeat_log` DB table.
- OpenRouter runtime: `router/openrouter-agent.js` is a Node.js interactive REPL that reads from stdin, calls OpenRouter API via openai SDK (already installed in `router/node_modules`), streams responses to stdout. `terminal.js` spawns it via PTY when runtime=`openrouter`.

**Tech Stack:** Node.js 20+, better-sqlite3, Express, node:test/assert, openai package (in router/node_modules), fetch (built-in Node 18+)

## Global Constraints

- Router called via HTTP `POST http://localhost:3001/llm/complete` body `{ taskType, prompt, systemPrompt, model?, provider? }` — NOT direct import (keeps packages separate)
- Router endpoint returns `{ text, model, provider, costUsd, durationMs }`
- Heartbeat disabled in `FLINT_TEST_MODE=1` — `startHeartbeat()` must be a no-op in test mode
- Heartbeat settings use existing `settings` table via `getSetting`/`setSetting` — keys: `heartbeat_enabled` (default `'true'`), `heartbeat_interval_minutes` (default `'5'`), `heartbeat_model` (default `''`), `heartbeat_provider` (default `''`)
- `heartbeat_log` table: id INTEGER PK AUTOINCREMENT, note TEXT NOT NULL, actions_json TEXT NOT NULL DEFAULT '[]', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
- OpenRouter agent spawned as: `node <path>/router/openrouter-agent.js <model>` — model defaults to `mistralai/mistral-nemo`
- OpenRouter agent reads `OPENROUTER_API_KEY` from env (injected via `buildApiKeyEnv()` as all runtimes do)
- Do NOT inject MCP config or autonomous directive for openrouter runtime (not a Claude agent)
- All commits on `master` branch
- Tests use `initDb(':memory:')` — never real DB
- Existing test suite: 263 tests, 260 pass (3 pre-existing failures in sp5/sp6 — do not fix, just don't break others)

---

## File Structure

| File | Action |
|---|---|
| `dashboard/db.js` | Modify — add `heartbeat_log` table |
| `dashboard/heartbeat.js` | Create — HeartbeatService |
| `dashboard/server.js` | Modify — import heartbeat, add 3 routes, call startHeartbeat() |
| `dashboard/settings.js` | Read-only reference |
| `dashboard/public/app.js` | Modify — heartbeat log UI + runtime model filtering |
| `dashboard/public/index.html` | Modify — heartbeat log panel + openrouter runtime option |
| `dashboard/public/style.css` | Modify — heartbeat log styles |
| `dashboard/tests/heartbeat.test.js` | Create — 4 unit tests |
| `router/openrouter-agent.js` | Create — interactive OpenRouter REPL |
| `dashboard/terminal.js` | Modify — openrouter runtime spawn |

---

### Task 1: heartbeat_log DB table + HeartbeatService

**Files:**
- Modify: `dashboard/db.js` — add heartbeat_log table
- Create: `dashboard/heartbeat.js`
- Create: `dashboard/tests/heartbeat.test.js`

**Interfaces:**
- Produces:
  - `logHeartbeat(note: string, actions: object[]): void`
  - `getHeartbeatLog(limit?: number): Row[]`
  - `collectState(): { agents, queue, recentNotes, ts }`
  - `runHeartbeatCycle(): Promise<{ note, actions }>`
  - `startHeartbeat(): void`
  - `stopHeartbeat(): void`

- [ ] **Step 1: Add heartbeat_log table to db.js**

In `dashboard/db.js`, in the `_db.exec(...)` multi-line SQL string, add after the `settings` table CREATE:

```sql
    CREATE TABLE IF NOT EXISTS heartbeat_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      note         TEXT NOT NULL,
      actions_json TEXT NOT NULL DEFAULT '[]',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
```

- [ ] **Step 2: Write the failing test**

Create `dashboard/tests/heartbeat.test.js`:

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

const TEMP_TASKS = join(tmpdir(), `flint-hb-test-${Date.now()}`);
process.env.FLINT_TASKS_DIR = TEMP_TASKS;
process.env.FLINT_TEST_MODE = '1';

import { initDb } from '../db.js';
import { logHeartbeat, getHeartbeatLog, collectState } from '../heartbeat.js';

before(() => {
  initDb(':memory:');
  mkdirSync(TEMP_TASKS, { recursive: true });
});

test('logHeartbeat stores note in heartbeat_log', () => {
  logHeartbeat('System looks healthy', []);
  const log = getHeartbeatLog(1);
  assert.equal(log.length, 1);
  assert.equal(log[0].note, 'System looks healthy');
});

test('getHeartbeatLog returns most recent first', () => {
  initDb(':memory:');
  logHeartbeat('First note', []);
  logHeartbeat('Second note', []);
  const log = getHeartbeatLog(10);
  assert.equal(log[0].note, 'Second note');
});

test('logHeartbeat stores actions as JSON string', () => {
  initDb(':memory:');
  const actions = [{ type: 'create_task', title: 'Test task' }];
  logHeartbeat('Note with action', actions);
  const log = getHeartbeatLog(1);
  assert.deepEqual(JSON.parse(log[0].actions_json), actions);
});

test('collectState returns required shape', () => {
  initDb(':memory:');
  const state = collectState();
  assert.ok(Array.isArray(state.agents), 'agents must be array');
  assert.ok(typeof state.queue === 'object', 'queue must be object');
  assert.ok(typeof state.queue.pending === 'number', 'pending must be number');
  assert.ok(typeof state.queue.inProgress === 'number', 'inProgress must be number');
  assert.ok(Array.isArray(state.recentNotes), 'recentNotes must be array');
  assert.ok(typeof state.ts === 'string', 'ts must be string');
});
```

- [ ] **Step 3: Run test — expect FAIL (module not found)**

```
cd dashboard && node --test tests/heartbeat.test.js 2>&1 | tail -5
```

Expected: fail with "Cannot find module '../heartbeat.js'"

- [ ] **Step 4: Create dashboard/heartbeat.js**

```js
import { getDb } from './db.js';
import { listQueueTasks, createQueueTask } from './queue.js';
import { listAgents } from './agents.js';
import { getSetting } from './settings.js';

const SYSTEM_PROMPT = `You are Flint's autonomous system brain. You review the agent team and task queue state and decide what (if anything) needs to happen.

Be conservative — most heartbeats should produce no actions (empty actions array). Only act when there is genuinely useful work that isn't already being handled.

Respond ONLY with valid JSON in exactly this format (no markdown, no explanation):
{
  "note": "One or two sentence observation about the system state.",
  "actions": []
}

Available action type (include in actions array only when clearly needed):
{ "type": "create_task", "title": "...", "description": "...", "role": "..." }

Never create tasks already in the queue. Never spawn agents (human decision). When in doubt, take no action.`;

export function logHeartbeat(note, actions = []) {
  getDb().prepare(
    'INSERT INTO heartbeat_log (note, actions_json) VALUES (?, ?)'
  ).run(note, JSON.stringify(actions));
}

export function getHeartbeatLog(limit = 20) {
  return getDb().prepare(
    'SELECT * FROM heartbeat_log ORDER BY id DESC LIMIT ?'
  ).all(limit);
}

export function collectState() {
  const agents = listAgents().map(a => ({ name: a.name, status: a.status, role: a.role ?? null }));
  const allTasks = listQueueTasks();
  const pending    = allTasks.filter(t => t.status === 'pending').length;
  const inProgress = allTasks.filter(t => t.status === 'in_progress').length;
  const doneLast24h = allTasks.filter(t => {
    if (t.status !== 'done') return false;
    return (Date.now() - new Date(t.updated_at + 'Z').getTime()) < 86_400_000;
  }).length;
  const recentTasks = allTasks.slice(0, 5).map(t => ({
    id: t.id, title: t.title, status: t.status, assigned_to: t.assigned_to ?? null,
  }));
  const recentNotes = getHeartbeatLog(3).map(r => r.note);
  return { agents, queue: { pending, inProgress, doneLast24h, recentTasks }, recentNotes, ts: new Date().toISOString() };
}

async function callLlm(prompt) {
  const model    = getSetting('heartbeat_model')    || undefined;
  const provider = getSetting('heartbeat_provider') || undefined;
  const body = {
    taskType:     'heartbeat',
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    ...(model    ? { model }    : {}),
    ...(provider ? { provider } : {}),
  };
  const res = await fetch('http://localhost:3001/llm/complete', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Router returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.text;
}

function parseResponse(raw) {
  try {
    const json = JSON.parse(raw.trim());
    return {
      note:    String(json.note ?? '').slice(0, 500),
      actions: Array.isArray(json.actions) ? json.actions : [],
    };
  } catch {
    return { note: String(raw).slice(0, 200), actions: [] };
  }
}

function executeActions(actions) {
  for (const action of actions) {
    try {
      if (action.type === 'create_task' && action.title) {
        createQueueTask({
          title:       action.title,
          description: action.description ?? '',
          role:        action.role ?? null,
          created_by:  'heartbeat',
        });
      }
    } catch (err) {
      console.warn(`[heartbeat] action failed: ${err.message}`);
    }
  }
}

export async function runHeartbeatCycle() {
  try {
    const state   = collectState();
    const raw     = await callLlm(JSON.stringify(state, null, 2));
    const { note, actions } = parseResponse(raw);
    executeActions(actions);
    logHeartbeat(note, actions);
    console.log(`[heartbeat] ${note}`);
    return { note, actions };
  } catch (err) {
    const errNote = `Heartbeat cycle error: ${err.message}`;
    try { logHeartbeat(errNote, []); } catch {}
    console.warn('[heartbeat]', err.message);
    return { note: errNote, actions: [] };
  }
}

let _timer = null;

export function startHeartbeat() {
  if (process.env.FLINT_TEST_MODE === '1') return;
  const enabled = getSetting('heartbeat_enabled');
  if (enabled === 'false') return;
  const mins = parseInt(getSetting('heartbeat_interval_minutes') || '5', 10);
  const ms   = mins * 60_000;
  if (_timer) clearInterval(_timer);
  _timer = setInterval(runHeartbeatCycle, ms);
  console.log(`[heartbeat] started — interval ${mins}min, model: ${getSetting('heartbeat_model') || 'router-default'}`);
}

export function stopHeartbeat() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
```

- [ ] **Step 5: Run test — expect PASS**

```
cd dashboard && node --test tests/heartbeat.test.js 2>&1 | tail -6
```

Expected: 4 tests pass, 0 fail

- [ ] **Step 6: Commit**

```bash
git add dashboard/db.js dashboard/heartbeat.js dashboard/tests/heartbeat.test.js
git commit -m "feat: heartbeat_log table + HeartbeatService (collect, call LLM, execute actions)"
```

---

### Task 2: Heartbeat REST routes + server.js integration

**Files:**
- Modify: `dashboard/server.js` — import heartbeat, 3 routes, call startHeartbeat()

**Interfaces:**
- `GET /heartbeat/log?limit=N` → `Row[]`
- `GET /heartbeat/status` → `{ lastRun, enabled, intervalMinutes }`
- `POST /heartbeat/trigger` → `{ note, actions }`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/server.test.js` (before the closing of the test file):

```js
test('GET /heartbeat/log returns array', async () => {
  const r = await req('GET', '/heartbeat/log');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body), 'heartbeat/log must return array');
});

test('GET /heartbeat/status returns shape', async () => {
  const r = await req('GET', '/heartbeat/status');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('enabled' in body, 'enabled field missing');
  assert.ok('intervalMinutes' in body, 'intervalMinutes field missing');
  assert.ok('lastRun' in body, 'lastRun field missing');
});

test('POST /heartbeat/trigger is reachable (test mode skips LLM)', async () => {
  // In test mode the route must exist and not throw 404
  const r = await req('POST', '/heartbeat/trigger');
  assert.ok(r.status === 200 || r.status === 500, `unexpected status ${r.status}`);
});
```

- [ ] **Step 2: Run tests — expect FAIL (404 on /heartbeat/log)**

```
cd dashboard && node --test tests/server.test.js 2>&1 | grep "heartbeat" | head -5
```

Expected: FAIL with 404

- [ ] **Step 3: Add import and routes to server.js**

In `dashboard/server.js`, add to the existing imports block:

```js
import { getHeartbeatLog, runHeartbeatCycle, startHeartbeat } from './heartbeat.js';
```

After the queue/orchestration routes, add:

```js
  // --- Heartbeat routes ---

  app.get('/heartbeat/log', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    res.json(getHeartbeatLog(limit));
  });

  app.get('/heartbeat/status', (_req, res) => {
    const [lastRun = null] = getHeartbeatLog(1);
    res.json({
      lastRun,
      enabled:         getSetting('heartbeat_enabled') !== 'false',
      intervalMinutes: parseInt(getSetting('heartbeat_interval_minutes') || '5', 10),
      model:           getSetting('heartbeat_model') || 'router-default',
      provider:        getSetting('heartbeat_provider') || 'router-default',
    });
  });

  app.post('/heartbeat/trigger', async (_req, res) => {
    try {
      const result = await runHeartbeatCycle();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
```

Find where the Express server starts listening (look for `server.listen` or `app.listen`). Add `startHeartbeat()` call immediately after the server is listening:

The existing pattern is likely: `const server = createServer(app); server.listen(PORT, () => { console.log(...); });`

Add `startHeartbeat();` inside that callback or immediately after.

- [ ] **Step 4: Run tests — expect PASS**

```
cd dashboard && node --test tests/server.test.js 2>&1 | tail -6
```

Expected: all heartbeat tests pass

- [ ] **Step 5: Restart and verify manually**

```
pm2 restart flint-dashboard --silent
```

Then:
```
Invoke-RestMethod http://localhost:3000/heartbeat/status | ConvertTo-Json
```

Expected: `{ "lastRun": null, "enabled": true, "intervalMinutes": 5, ... }`

- [ ] **Step 6: Commit**

```bash
git add dashboard/server.js dashboard/tests/server.test.js
git commit -m "feat: heartbeat REST routes (log, status, trigger) + start on server init"
```

---

### Task 3: Heartbeat UI + OpenRouter runtime option

**Files:**
- Modify: `dashboard/public/index.html` — heartbeat log panel in Queue view + openrouter runtime option
- Modify: `dashboard/public/app.js` — heartbeat log fetch + runtime model filtering
- Modify: `dashboard/public/style.css` — heartbeat log styles

**No automated tests — verify visually.**

- [ ] **Step 1: Add CSS to style.css**

Append to `dashboard/public/style.css`:

```css
/* Heartbeat log */
.heartbeat-log { margin-top: 16px; }
.heartbeat-log h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #8b949e; margin-bottom: 8px; }
.hb-entry { background: #161b22; border: 1px solid #21262d; border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; font-size: 12px; }
.hb-entry .hb-note { color: #e6edf3; }
.hb-entry .hb-meta { color: #8b949e; font-size: 10px; margin-top: 4px; }
.hb-entry .hb-actions { color: #58a6ff; font-size: 10px; margin-top: 2px; }
.hb-trigger { background: transparent; border: 1px solid #58a6ff66; color: #58a6ff; padding: 3px 10px; border-radius: 4px; font-size: 12px; cursor: pointer; margin-left: 8px; }
.hb-trigger:hover { background: #58a6ff22; }
```

- [ ] **Step 2: Add heartbeat panel to index.html Queue view**

In `index.html`, find the `<div id="queue-view" ...>` section. Inside it, after the existing queue content (tasks table, config section), add:

```html
    <div class="heartbeat-log" id="heartbeat-log-panel">
      <h3>Flint Heartbeat <button class="hb-trigger" id="btn-hb-trigger">Run now</button></h3>
      <div id="hb-log-entries"></div>
    </div>
```

- [ ] **Step 3: Add openrouter runtime option to spawn dialog in index.html**

Find the `<select id="modal-runtime">` element. Add after the vibe option:

```html
          <option value="openrouter">OpenRouter Chat (openrouter)</option>
```

- [ ] **Step 4: Wire up heartbeat log in app.js**

Find the `function fetchQueue()` or the queue view refresh logic in `app.js`. Add a call to `fetchHeartbeatLog()` when the queue view is shown.

Add these functions to app.js:

```js
async function fetchHeartbeatLog() {
  try {
    const entries = await fetch('/heartbeat/log?limit=10').then(r => r.json());
    const container = document.getElementById('hb-log-entries');
    if (!container) return;
    if (!entries.length) {
      container.innerHTML = '<div class="hb-entry"><div class="hb-note" style="color:#8b949e">No heartbeat cycles run yet.</div></div>';
      return;
    }
    container.innerHTML = entries.map(e => {
      const actions = JSON.parse(e.actions_json || '[]');
      const actionsHtml = actions.length ? `<div class="hb-actions">Actions: ${actions.map(a => a.type + (a.title ? ': ' + escHtml(a.title) : '')).join(', ')}</div>` : '';
      return `<div class="hb-entry">
        <div class="hb-note">${escHtml(e.note)}</div>
        ${actionsHtml}
        <div class="hb-meta">${new Date(e.created_at).toLocaleString()}</div>
      </div>`;
    }).join('');
  } catch {}
}
```

Wire up the trigger button — find where the queue view event listeners are set up or add:

```js
document.getElementById('btn-hb-trigger')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-hb-trigger');
  if (btn) btn.disabled = true;
  try {
    await fetch('/heartbeat/trigger', { method: 'POST' });
    await fetchHeartbeatLog();
  } finally {
    if (btn) btn.disabled = false;
  }
});
```

Call `fetchHeartbeatLog()` when the queue view is shown (find `showView('queue')` or the queue refresh logic).

- [ ] **Step 5: Runtime-aware model dropdown filtering in app.js**

Find the `modal-runtime` change listener in `app.js`:

```js
document.getElementById('modal-runtime').addEventListener('change', e => {
  const modelGroup = document.getElementById('modal-model-group');
  modelGroup.style.display = e.target.value === 'vibe' ? 'none' : '';
});
```

Replace with:

```js
document.getElementById('modal-runtime').addEventListener('change', e => {
  const runtime = e.target.value;
  const modelGroup = document.getElementById('modal-model-group');
  modelGroup.style.display = runtime === 'vibe' ? 'none' : '';
  filterModelDropdownForRuntime(runtime);
});

function filterModelDropdownForRuntime(runtime) {
  const select = document.getElementById('modal-model');
  if (!select) return;
  for (const group of select.querySelectorAll('optgroup')) {
    const provider = group.label;
    // For claude/gemini/mistral/ollama runtimes: hide openrouter group
    // For openrouter runtime: hide all non-openrouter groups
    if (runtime === 'openrouter') {
      group.style.display = provider === 'openrouter' ? '' : 'none';
    } else {
      group.style.display = provider === 'openrouter' ? 'none' : '';
    }
  }
  // Auto-select first visible option
  const first = select.querySelector('optgroup:not([style*="none"]) option');
  if (first) select.value = first.value;
}
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/public/index.html dashboard/public/app.js dashboard/public/style.css
git commit -m "feat: heartbeat log UI panel + openrouter runtime in spawn dialog + model dropdown filtering"
```

---

### Task 4: OpenRouter interactive agent runtime

**Files:**
- Create: `router/openrouter-agent.js` — streaming interactive REPL
- Modify: `dashboard/terminal.js` — spawn openrouter runtime

**Interfaces:**
- `router/openrouter-agent.js` reads:
  - `process.argv[2]` — model name (e.g. `mistralai/mistral-nemo`)
  - `process.env.OPENROUTER_API_KEY`
  - stdin — user messages (each newline-terminated line = one turn)
- Writes to stdout: streaming response text, ends with `\n\n> ` prompt

**No automated tests — verify manually via spawn dialog.**

- [ ] **Step 1: Create router/openrouter-agent.js**

```js
#!/usr/bin/env node
/**
 * OpenRouter interactive agent — streams responses from any OpenRouter model.
 * Spawned as a PTY process: node router/openrouter-agent.js <model>
 */

import OpenAI from 'openai';
import * as readline from 'node:readline';

const model = process.argv[2] || 'mistralai/mistral-nemo';
const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  console.error('[openrouter-agent] ERROR: OPENROUTER_API_KEY is not set.');
  console.error('Add your OpenRouter key via the API Keys tab in the Flint dashboard.');
  process.exit(1);
}

const client = new OpenAI({
  apiKey,
  baseURL: 'https://openrouter.ai/api/v1',
});

const messages = [];

function prompt() {
  process.stdout.write('\n> ');
}

console.log(`\r\n\x1b[36mOpenRouter Agent\x1b[0m — model: \x1b[33m${model}\x1b[0m`);
console.log('Type your message and press Enter. Ctrl+C to exit.\r\n');
prompt();

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) { prompt(); return; }
  if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
    console.log('\r\nGoodbye.');
    process.exit(0);
  }

  messages.push({ role: 'user', content: input });

  try {
    process.stdout.write('\r\n');
    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
    });

    let reply = '';
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? '';
      if (text) {
        process.stdout.write(text.replace(/\n/g, '\r\n'));
        reply += text;
      }
    }
    messages.push({ role: 'assistant', content: reply });
  } catch (err) {
    process.stdout.write(`\r\n\x1b[31mError: ${err.message}\x1b[0m`);
  }

  prompt();
});

rl.on('close', () => process.exit(0));
```

- [ ] **Step 2: Add openrouter runtime to terminal.js**

In `dashboard/terminal.js`, after the line:

```js
  const isVibe   = agent.runtime === 'vibe';
  const isOllama = agent.runtime === 'ollama';
```

Add:

```js
  const isOpenRouter = agent.runtime === 'openrouter';
```

In the `if (!isOllama)` autonomous directive block, extend the condition:

```js
  if (!isOllama && !isOpenRouter) {
```

And in the specialist model resolution block:

```js
  if (!model && specialist && !isVibe && !isOllama && !isOpenRouter) {
```

Find the `let bin, args;` block:

```js
  let bin, args;
  if (isOllama) {
    bin  = OLLAMA_BIN;
    args = ['run', agent.model || 'llama3'];
  } else if (isVibe) {
    bin  = VIBE_BIN;
    args = [];
  } else {
    bin  = CLAUDE_BIN;
    args = ['--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
  }
```

Replace with:

```js
  let bin, args;
  if (isOllama) {
    bin  = OLLAMA_BIN;
    args = ['run', agent.model || 'llama3'];
  } else if (isVibe) {
    bin  = VIBE_BIN;
    args = [];
  } else if (isOpenRouter) {
    bin  = 'node';
    args = [join(FLINT_ROOT, 'router', 'openrouter-agent.js'), model || 'mistralai/mistral-nemo'];
  } else {
    bin  = CLAUDE_BIN;
    args = ['--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
  }
```

Also find the MCP injection guard:

```js
  if (!isVibe && !isOllama) {
    try { injectMcpConfig(name, workdir); } catch {}
  }
```

Replace with:

```js
  if (!isVibe && !isOllama && !isOpenRouter) {
    try { injectMcpConfig(name, workdir); } catch {}
  }
```

Check `FLINT_ROOT` is already defined in terminal.js (it should be from the import block). If not, add:

```js
const FLINT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
```

Also fix the `lastModel` fallback line:

```js
  let lastModel = isOllama ? (agent.model || 'llama3') : isVibe ? 'mistral' : isOpenRouter ? (model || 'mistralai/mistral-nemo') : 'claude';
```

- [ ] **Step 3: Verify FLINT_ROOT is importable in terminal.js**

```bash
cd dashboard && node --input-type=module --eval "import { spawnAgent } from './terminal.js'; console.log('ok');"
```

Expected: `ok` (no import errors)

- [ ] **Step 4: Run existing test suite — no regressions**

```
cd dashboard && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 260 pass, 3 fail (same as before — no new failures)

- [ ] **Step 5: Commit**

```bash
git add router/openrouter-agent.js dashboard/terminal.js
git commit -m "feat: OpenRouter interactive agent runtime — spawn via node router/openrouter-agent.js <model>"
```

---

### Task 5: Wire up heartbeat fetch in queue view + final test run

**Files:**
- Modify: `dashboard/public/app.js` — call fetchHeartbeatLog() when queue view opens

**No new tests.**

- [ ] **Step 1: Call fetchHeartbeatLog when Queue view loads**

In `app.js`, find the `showView` function. In the `else if (view === 'queue')` branch, add a call to `fetchHeartbeatLog()` near where `fetchQueue()` is called.

- [ ] **Step 2: Run full npm test — verify no regressions**

```
cd dashboard && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: ≥ 260 pass, ≤ 3 fail (heartbeat tests are now included so pass count goes up).

- [ ] **Step 3: Restart and smoke-test**

```powershell
pm2 restart flint-dashboard --silent
```

- Open `http://localhost:3000`
- Click Queue tab — heartbeat log panel should appear at bottom
- Click "Run now" — should show a new heartbeat entry within ~5 seconds (or error if no router API key configured — that's expected)
- Click Spawn agent — change Runtime to "OpenRouter Chat" — Model dropdown should switch to showing only OpenRouter models

- [ ] **Step 4: Commit**

```bash
git add dashboard/public/app.js
git commit -m "chore: call fetchHeartbeatLog on queue view open; final wiring"
```

---

## Update workflow

After this ships, configure the heartbeat via the Settings API:

```
POST /settings  body: { key: "heartbeat_enabled", value: "true" }
POST /settings  body: { key: "heartbeat_interval_minutes", value: "5" }
POST /settings  body: { key: "heartbeat_provider", value: "openrouter" }
POST /settings  body: { key: "heartbeat_model", value: "mistralai/mistral-small-3.2-24b-instruct" }
```

Or just leave defaults — the heartbeat will use whatever the router's priority order resolves to (Anthropic first if key is set, then OpenRouter, etc.).

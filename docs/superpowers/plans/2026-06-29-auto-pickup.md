# Queue Auto-Pickup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically assign pending queue tasks to matching agents (by role) and restart stopped agents so tasks are picked up without manual intervention.

**Architecture:** A new `autoPickup.js` module runs alongside the existing queue poller every 10 seconds. It matches pending tasks to agents via a new `role` field on agents (exact string match), restarts stopped agents when needed, and falls back to a configurable default agent for roleless tasks. A `settings` table in SQLite stores the default agent name.

**Tech Stack:** Node.js ESM, better-sqlite3, node:test, Express (existing stack — no new dependencies)

## Global Constraints

- ESM modules throughout — use `import`/`export`, never `require()`
- Node.js `node:test` + `node:assert/strict` for all tests
- Run tests with: `node --test dashboard/tests/<file>.test.js`
- All test DBs use `:memory:` — never touch the real `usage.sqlite`
- Set `process.env.FLINT_TASKS_DIR` to a temp dir before importing queue/tasks modules in tests
- `autoPickup.js` must support dependency injection of `spawnFn` and `assignFn` for testability — the real `spawnAgent` from `terminal.js` requires a PTY process and cannot run in tests
- Never `console.error` more than once per unknown agent role (log-once guard)
- All new routes follow existing pattern: `app.get(...)` / `app.patch(...)` returning JSON

---

## File Map

| File | Change |
|---|---|
| `dashboard/settings.js` | **Create** — `getSetting`, `setSetting` |
| `dashboard/autoPickup.js` | **Create** — `autoAssignPendingTasks` |
| `dashboard/tests/settings.test.js` | **Create** — unit tests for settings module |
| `dashboard/tests/autoPickup.test.js` | **Create** — unit tests for auto-pickup logic |
| `dashboard/db.js` | **Modify** — add `settings` table to `initDb` |
| `dashboard/agents.js` | **Modify** — add `role` field throughout |
| `dashboard/queue.js` | **Modify** — call `autoAssignPendingTasks` in `startQueuePoller` |
| `dashboard/server.js` | **Modify** — `/queue/config` routes + `role` in agent creation |
| `dashboard/public/index.html` | **Modify** — role input in New Agent modal |
| `dashboard/public/app.js` | **Modify** — role in spawn message + default agent config in queue view |

---

### Task 1: settings table + settings.js

**Files:**
- Create: `dashboard/settings.js`
- Create: `dashboard/tests/settings.test.js`
- Modify: `dashboard/db.js` (lines 131–132 — after the last `CREATE TABLE IF NOT EXISTS` block, before the `try { _db.exec('ALTER TABLE…` lines)

**Interfaces:**
- Produces:
  - `getSetting(key: string, defaultVal?: string): string`
  - `setSetting(key: string, value: string): void`
  - Both require `initDb()` to have been called first (same contract as all other db modules)

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/settings.test.js`:

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../db.js';
import { getSetting, setSetting } from '../settings.js';

before(() => initDb(':memory:'));

test('getSetting returns empty string for unknown key', () => {
  assert.equal(getSetting('missing_key'), '');
});

test('getSetting returns defaultVal for unknown key when provided', () => {
  assert.equal(getSetting('missing_key', 'fallback'), 'fallback');
});

test('setSetting + getSetting round-trips a value', () => {
  setSetting('default_agent', 'my-worker');
  assert.equal(getSetting('default_agent'), 'my-worker');
});

test('setSetting overwrites an existing value', () => {
  setSetting('default_agent', 'first');
  setSetting('default_agent', 'second');
  assert.equal(getSetting('default_agent'), 'second');
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test dashboard/tests/settings.test.js
```

Expected: FAIL with `Cannot find module '../settings.js'`

- [ ] **Step 3: Add `settings` table to `db.js`**

In `dashboard/db.js`, add the following SQL block inside the `_db.exec(...)` template literal, directly after the `specialists` table block (after the closing `);` of specialists, before the closing backtick of the whole exec call). The specialists table ends at line 131. Insert before the closing `` ` `` of `_db.exec`:

```sql
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
```

The full `_db.exec` call should now end with:

```js
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
```

- [ ] **Step 4: Create `dashboard/settings.js`**

```js
import { getDb } from './db.js';

export function getSetting(key, defaultVal = '') {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
}

export function setSetting(key, value) {
  getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
node --test dashboard/tests/settings.test.js
```

Expected: 4 pass, 0 fail

- [ ] **Step 6: Commit**

```
git add dashboard/settings.js dashboard/tests/settings.test.js dashboard/db.js
git commit -m "feat(auto-pickup): settings table + getSetting/setSetting"
```

---

### Task 2: agents.js — role field

**Files:**
- Modify: `dashboard/agents.js`
- Modify: `dashboard/tests/agents.test.js` (append new tests)

**Interfaces:**
- Consumes: nothing new
- Produces (updated signatures):
  - `registerAgent(name, mode, workdir, logPath=null, model='', runtime='claude', role=null): agent`
  - `listAgents()` now includes `role: string | null` on each object
  - `getAgent(name)` registry entry now includes `role: string | null`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/agents.test.js`:

```js
test('registerAgent stores role field', () => {
  initAgents();
  registerAgent('tester-1', 'spawn', 'C:/flint', null, '', 'claude', 'tester');
  const a = getAgent('tester-1');
  assert.equal(a.role, 'tester');
});

test('listAgents includes role field', () => {
  initAgents();
  registerAgent('coder-1', 'spawn', 'C:/flint', null, '', 'claude', 'coder');
  const [a] = listAgents();
  assert.ok('role' in a, 'role missing from listAgents output');
  assert.equal(a.role, 'coder');
});

test('registerAgent role defaults to null', () => {
  initAgents();
  registerAgent('general', 'spawn', 'C:/flint');
  assert.equal(getAgent('general').role, null);
});

test('initAgents loads role from JSON', () => {
  initAgents();
  registerAgent('qa', 'spawn', 'C:/flint', null, '', 'claude', 'qa');
  // re-init from the same file (FLINT_AGENTS_FILE env is set to temp)
  initAgents();
  assert.equal(getAgent('qa').role, 'qa');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test dashboard/tests/agents.test.js
```

Expected: existing tests pass, 4 new tests FAIL

- [ ] **Step 3: Update `dashboard/agents.js`**

Replace the `registerAgent` function:

```js
export function registerAgent(name, mode, workdir, logPath = null, model = '', runtime = 'claude', role = null) {
  const agent = {
    name, mode, workdir, logPath, model: model ?? '', runtime: runtime ?? 'claude',
    role: role ?? null,
    status: 'stopped', ptyProcess: null, watcher: null, wsClients: new Set(),
  };
  registry.set(name, agent);
  save();
  return agent;
}
```

Replace the `save` function:

```js
function save() {
  const data = [...registry.values()].map(({ name, mode, workdir, logPath, model, runtime, role, status }) => ({
    name, mode, workdir, logPath: logPath ?? null, model: model ?? '',
    runtime: runtime ?? 'claude',
    role: role ?? null,
    status: status === 'running' ? 'stopped' : status,
  }));
  writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}
```

Replace `initAgents`:

```js
export function initAgents(agentsFile) {
  if (agentsFile) AGENTS_FILE = agentsFile;
  registry.clear();
  if (!existsSync(AGENTS_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'));
    for (const a of data) {
      registry.set(a.name, {
        ...a,
        model: a.model ?? '',
        runtime: a.runtime ?? 'claude',
        role: a.role ?? null,
        status: 'stopped',
        ptyProcess: null,
        watcher: null,
        wsClients: new Set(),
      });
    }
  } catch {
    // corrupt file — start fresh
  }
}
```

Replace `listAgents`:

```js
export function listAgents() {
  return [...registry.values()].map(({ name, mode, status, workdir, model, runtime, role }) => ({
    name, mode, status, workdir, model: model ?? '', runtime: runtime ?? 'claude', role: role ?? null,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test dashboard/tests/agents.test.js
```

Expected: all tests pass, 0 fail

- [ ] **Step 5: Commit**

```
git add dashboard/agents.js dashboard/tests/agents.test.js
git commit -m "feat(auto-pickup): add role field to agents"
```

---

### Task 3: autoPickup.js + wire into queue poller

**Files:**
- Create: `dashboard/autoPickup.js`
- Create: `dashboard/tests/autoPickup.test.js`
- Modify: `dashboard/queue.js` (last 3 lines — `startQueuePoller`)

**Interfaces:**
- Consumes:
  - `listQueueTasks({ status })` from `./queue.js`
  - `assignQueueTask(id, agentName)` from `./queue.js`
  - `listAgents()` from `./agents.js`
  - `getAgent(name)` from `./agents.js`
  - `getSetting(key)` from `./settings.js`
  - `spawnAgent(name, workdir, model, opts)` from `./terminal.js` (injected in tests)
- Produces:
  - `autoAssignPendingTasks({ spawnFn?, assignFn? }?): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/autoPickup.test.js`:

```js
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

const TEMP_TASKS = join(tmpdir(), `flint-autopickup-test-${Date.now()}`);
process.env.FLINT_TASKS_DIR = TEMP_TASKS;

import { initDb } from '../db.js';
import { initAgents, registerAgent, getAgent, setAgentStatus } from '../agents.js';
import { createQueueTask, getQueueTask } from '../queue.js';
import { setSetting } from '../settings.js';
import { autoAssignPendingTasks } from '../autoPickup.js';

before(() => {
  initDb(':memory:');
  mkdirSync(TEMP_TASKS, { recursive: true });
});

beforeEach(() => {
  initDb(':memory:');
  initAgents();
});

test('running agent with matching role gets the task assigned', async () => {
  registerAgent('qa-bot', 'spawn', 'C:/flint', null, '', 'claude', 'tester');
  setAgentStatus('qa-bot', 'running');
  const task = createQueueTask({ title: 'Run tests', role: 'tester', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { assigned.push({ id, name }); },
    spawnFn:  () => { throw new Error('spawnFn should not be called'); },
  });

  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].id, task.id);
  assert.equal(assigned[0].name, 'qa-bot');
});

test('stopped agent with matching role gets assigned and spawned', async () => {
  registerAgent('coder-1', 'spawn', 'C:/flint', null, '', 'claude', 'coder');
  // status defaults to stopped — no setAgentStatus call needed
  const task = createQueueTask({ title: 'Fix bug', role: 'coder', created_by: 'human' });

  const assigned = [];
  const spawned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { assigned.push({ id, name }); },
    spawnFn:  (name, workdir, model, opts) => { spawned.push(name); },
  });

  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].name, 'coder-1');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0], 'coder-1');
});

test('task with no role and no default_agent is skipped', async () => {
  setSetting('default_agent', '');
  registerAgent('worker', 'spawn', 'C:/flint', null, '', 'claude', null);
  createQueueTask({ title: 'Misc task', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { assigned.push({ id, name }); },
    spawnFn:  () => {},
  });

  assert.equal(assigned.length, 0);
});

test('task with no role uses default_agent when configured', async () => {
  registerAgent('default-worker', 'spawn', 'C:/flint', null, '', 'claude', null);
  setAgentStatus('default-worker', 'running');
  setSetting('default_agent', 'default-worker');
  const task = createQueueTask({ title: 'Misc task', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { assigned.push({ id, name }); },
    spawnFn:  () => {},
  });

  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].name, 'default-worker');
});

test('no agent matching role — task is skipped', async () => {
  createQueueTask({ title: 'Design DB', role: 'architect', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { assigned.push({ id, name }); },
    spawnFn:  () => {},
  });

  assert.equal(assigned.length, 0);
});

test('spawnFn error is caught — task stays pending (assign was called)', async () => {
  registerAgent('fragile', 'spawn', 'C:/flint', null, '', 'claude', 'builder');
  const task = createQueueTask({ title: 'Build it', role: 'builder', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { assigned.push({ id, name }); },
    spawnFn:  () => { throw new Error('PTY failed'); },
  });

  // assign was called before spawn; spawn error is caught
  assert.equal(assigned.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test dashboard/tests/autoPickup.test.js
```

Expected: FAIL with `Cannot find module '../autoPickup.js'`

- [ ] **Step 3: Create `dashboard/autoPickup.js`**

```js
import { listQueueTasks } from './queue.js';
import { listAgents, getAgent } from './agents.js';
import { getSetting } from './settings.js';
import { spawnAgent as _spawnAgent } from './terminal.js';
import { assignQueueTask as _assignQueueTask } from './queue.js';

const warnedRoles = new Set();

export async function autoAssignPendingTasks({
  spawnFn  = _spawnAgent,
  assignFn = _assignQueueTask,
} = {}) {
  const pending = listQueueTasks({ status: 'pending' });
  if (pending.length === 0) return;

  const agents = listAgents();

  for (const task of pending) {
    let targetName;

    if (task.role) {
      const match = agents.find(a => a.role === task.role);
      if (!match) {
        if (!warnedRoles.has(task.role)) {
          console.log(`[auto-pickup] no agent with role "${task.role}" — task #${task.id} stays pending`);
          warnedRoles.add(task.role);
        }
        continue;
      }
      targetName = match.name;
    } else {
      targetName = getSetting('default_agent');
      if (!targetName) continue;
    }

    const agent = getAgent(targetName);
    if (!agent) continue;

    try {
      assignFn(task.id, targetName);
    } catch (err) {
      console.log(`[auto-pickup] could not assign task #${task.id} to "${targetName}": ${err.message}`);
      continue;
    }

    if (agent.status === 'stopped') {
      try {
        spawnFn(targetName, agent.workdir, agent.model || null, {});
      } catch (err) {
        console.log(`[auto-pickup] spawn failed for "${targetName}": ${err.message}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test dashboard/tests/autoPickup.test.js
```

Expected: 6 pass, 0 fail

- [ ] **Step 5: Wire into queue poller in `dashboard/queue.js`**

Add import at the top of `dashboard/queue.js` (after the existing imports):

```js
import { autoAssignPendingTasks } from './autoPickup.js';
```

Replace `startQueuePoller`:

```js
export function startQueuePoller(intervalMs = 10000) {
  return setInterval(async () => {
    checkQueueTasks();
    await autoAssignPendingTasks();
  }, intervalMs);
}
```

- [ ] **Step 6: Verify existing queue tests still pass**

```
node --test dashboard/tests/queue.test.js
```

Expected: all pass, 0 fail

- [ ] **Step 7: Commit**

```
git add dashboard/autoPickup.js dashboard/tests/autoPickup.test.js dashboard/queue.js
git commit -m "feat(auto-pickup): autoAssignPendingTasks + wire into queue poller"
```

---

### Task 4: server.js — /queue/config routes + role in agent creation

**Files:**
- Modify: `dashboard/server.js`
- Modify: `dashboard/tests/server.test.js` (append new tests)

**Interfaces:**
- Consumes:
  - `getSetting`, `setSetting` from `./settings.js`
  - `registerAgent` (updated signature with `role`)
- Produces:
  - `GET  /queue/config` → `{ defaultAgent: string }`
  - `PATCH /queue/config` → `{ defaultAgent: string }` (updated value)
  - `POST /agents/spawn` — now accepts optional `role` field in body
  - WS `spawn` message — now accepts optional `role` field

- [ ] **Step 1: Write the failing tests**

Open `dashboard/tests/server.test.js` and append:

```js
test('GET /queue/config returns defaultAgent empty string by default', async () => {
  initDb(':memory:');
  const { app } = await makeApp();
  const r = await request(app).get('/queue/config');
  assert.equal(r.status, 200);
  assert.equal(r.body.defaultAgent, '');
});

test('PATCH /queue/config persists defaultAgent', async () => {
  initDb(':memory:');
  const { app } = await makeApp();
  const patch = await request(app).patch('/queue/config').send({ defaultAgent: 'my-worker' });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.defaultAgent, 'my-worker');
  const get = await request(app).get('/queue/config');
  assert.equal(get.body.defaultAgent, 'my-worker');
});

test('POST /agents/spawn with role registers agent with that role', async () => {
  initDb(':memory:');
  const { app } = await makeApp();
  const r = await request(app).post('/agents/spawn').send({
    name: 'qa-agent', workdir: 'C:/flint', role: 'tester',
  });
  assert.equal(r.status, 200);
  const agents = await request(app).get('/agents');
  const qa = agents.body.find(a => a.name === 'qa-agent');
  assert.ok(qa, 'agent not found');
  assert.equal(qa.role, 'tester');
});
```

Look at the top of `dashboard/tests/server.test.js` to understand the `makeApp` and `request` helper pattern — replicate it exactly. The existing tests use `supertest` or a similar HTTP helper. Use whatever pattern is already in that file.

- [ ] **Step 2: Run tests to verify they fail**

```
node --test dashboard/tests/server.test.js
```

Expected: new 3 tests FAIL (routes not found yet)

- [ ] **Step 3: Add `settings` import to `dashboard/server.js`**

At the top of `dashboard/server.js`, after the existing imports, add:

```js
import { getSetting, setSetting } from './settings.js';
```

- [ ] **Step 4: Add `/queue/config` routes to `dashboard/server.js`**

Find the existing `app.get('/queue/tasks'` route. Add the two new routes **directly before it**:

```js
  app.get('/queue/config', (_req, res) => {
    res.json({ defaultAgent: getSetting('default_agent') });
  });

  app.patch('/queue/config', (req, res) => {
    const { defaultAgent } = req.body ?? {};
    if (defaultAgent === undefined) return res.status(400).json({ error: 'defaultAgent required' });
    setSetting('default_agent', defaultAgent ?? '');
    res.json({ defaultAgent: getSetting('default_agent') });
  });
```

- [ ] **Step 5: Add `role` to `POST /agents/spawn` in `dashboard/server.js`**

Find the existing route:

```js
  app.post('/agents/spawn', (req, res) => {
    const { name, workdir, model, runtime, specialistName } = req.body ?? {};
    if (!name || !workdir) return res.status(400).json({ error: 'name and workdir required' });
    registerAgent(name, 'spawn', workdir, null, model ?? '', runtime ?? 'claude');
```

Replace with:

```js
  app.post('/agents/spawn', (req, res) => {
    const { name, workdir, model, runtime, specialistName, role } = req.body ?? {};
    if (!name || !workdir) return res.status(400).json({ error: 'name and workdir required' });
    registerAgent(name, 'spawn', workdir, null, model ?? '', runtime ?? 'claude', role ?? null);
```

- [ ] **Step 6: Add `role` to WebSocket `spawn` case in `dashboard/server.js`**

Find the WebSocket `case 'spawn':` block:

```js
        case 'spawn': {
          const { agent: name, workdir, model, isolate, runtime, specialistName } = msg;
          if (!name || !workdir) break;
          registerAgent(name, 'spawn', workdir, null, model, runtime ?? 'claude');
```

Replace with:

```js
        case 'spawn': {
          const { agent: name, workdir, model, isolate, runtime, specialistName, role } = msg;
          if (!name || !workdir) break;
          registerAgent(name, 'spawn', workdir, null, model, runtime ?? 'claude', role ?? null);
```

- [ ] **Step 7: Run tests to verify they pass**

```
node --test dashboard/tests/server.test.js
```

Expected: all pass including the 3 new tests

- [ ] **Step 8: Commit**

```
git add dashboard/server.js dashboard/tests/server.test.js
git commit -m "feat(auto-pickup): /queue/config API + role field in agent spawn"
```

---

### Task 5: UI — role input in New Agent modal + default agent config in Queue view

**Files:**
- Modify: `dashboard/public/index.html`
- Modify: `dashboard/public/app.js`

**Interfaces:**
- Consumes:
  - `GET /queue/config` — on queue view load
  - `PATCH /queue/config` — on Save button click
  - WS `spawn` message — now includes optional `role`
- No new exports (frontend only)

- [ ] **Step 1: Add role input to New Agent modal in `index.html`**

In `dashboard/public/index.html`, find the Specialist select block (lines ~82–87):

```html
      <label>
        Specialist (optional)
        <select id="modal-specialist">
          <option value="">— none —</option>
        </select>
      </label>
```

Insert the following **after** the Specialist block (between it and the `modal-model-group` div):

```html
      <label>
        Role (optional)
        <input id="modal-role" type="text" placeholder="e.g. tester, coder — leave blank for general" autocomplete="off">
      </label>
```

- [ ] **Step 2: Include `role` in the WebSocket spawn message in `app.js`**

Find the `modal-spawn` click handler in `dashboard/public/app.js`. It currently reads:

```js
  const specialistName = document.getElementById('modal-specialist')?.value || undefined;
  ws.send(JSON.stringify({
    type: 'spawn', agent: name, workdir, runtime,
```

Add the role read after `specialistName` and include it in the WS message:

```js
  const specialistName = document.getElementById('modal-specialist')?.value || undefined;
  const role = document.getElementById('modal-role')?.value.trim() || undefined;
  ws.send(JSON.stringify({
    type: 'spawn', agent: name, workdir, runtime,
    ...(model ? { model } : {}),
    ...(isolate ? { isolate } : {}),
    ...(specialistName ? { specialistName } : {}),
    ...(role ? { role } : {}),
  }));
```

Note: replace the entire `ws.send(JSON.stringify({...}))` call with the above — check the current spread of properties in the existing send call and ensure all existing fields remain.

- [ ] **Step 3: Reset `modal-role` when modal is closed**

Find the section in `app.js` where the modal fields are cleared on close (after the `ws.send` in the spawn handler). It currently resets `modal-name`, `modal-workdir`, `modal-isolate`, `modal-runtime`, `modal-specialist`. Add:

```js
  document.getElementById('modal-role').value = '';
```

alongside the other resets.

- [ ] **Step 4: Add default agent config to Queue view header in `app.js`**

Find the `renderQueueView` function. It renders a `.queue-header` div that currently contains:
- `← Dashboard` button
- `Task Queue` h3 heading
- `+ Add Task` button

Replace the `.queue-header` template section with (keep all existing buttons, add the config row after them):

```js
  view.innerHTML = `
    <div class="queue-header">
      <button id="btn-queue-back" style="background:none;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:14px">← Dashboard</button>
      <h3 style="margin:0;font-size:18px">Task Queue</h3>
      <button id="btn-add-task" style="background:#238636;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:16px">+ Add Task</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0 10px;border-bottom:1px solid #30363d;margin-bottom:8px;font-size:13px;color:#8b949e">
      <span>Default agent (roleless tasks):</span>
      <input id="queue-default-agent" type="text" placeholder="agent name or leave blank to skip"
        style="background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:3px 8px;border-radius:4px;font-size:13px;width:220px">
      <button id="btn-save-default-agent" style="background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:13px">Save</button>
    </div>
    <div style="...rest of existing queue table HTML...">
```

Keep all existing table/filter/task-row HTML unchanged — only add the new config row div between `.queue-header` and the filter tabs.

- [ ] **Step 5: Fetch and populate default agent on queue view load**

Find the `loadQueueView` function (or wherever `renderQueueView` is called). After `renderQueueView(tasks, agents, statusFilter)` is called, add:

```js
  // Populate default agent config
  fetch('/queue/config')
    .then(r => r.json())
    .then(cfg => {
      const input = document.getElementById('queue-default-agent');
      if (input) input.value = cfg.defaultAgent ?? '';
    })
    .catch(() => {});
```

- [ ] **Step 6: Wire Save button for default agent**

In `renderQueueView` (or via event delegation on the queue view), add after the existing button event listeners (like `btn-queue-back` and `btn-add-task`):

```js
  document.getElementById('btn-save-default-agent')?.addEventListener('click', () => {
    const val = document.getElementById('queue-default-agent')?.value.trim() ?? '';
    fetch('/queue/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAgent: val }),
    }).catch(() => {});
  });
```

- [ ] **Step 7: Restart dashboard and verify in browser**

```
pm2 restart flint-dashboard
```

Then open `http://localhost:3000`:
1. Click **+ New Agent** → verify "Role (optional)" input appears below Specialist dropdown
2. Click **Queue** → verify "Default agent (roleless tasks):" config row appears
3. Type an agent name in the default agent field, click Save, navigate away and back — verify it persists

- [ ] **Step 8: Commit**

```
git add dashboard/public/index.html dashboard/public/app.js
git commit -m "feat(auto-pickup): role input in New Agent modal + default agent config in Queue view"
```

---

## Self-Review

**Spec coverage:**
- ✅ `settings` table + `getSetting`/`setSetting` — Task 1
- ✅ `role` field on agents — Task 2
- ✅ `autoAssignPendingTasks` with role matching, stopped-agent restart, default agent, error guard — Task 3
- ✅ Queue poller wired — Task 3
- ✅ `/queue/config` GET+PATCH — Task 4
- ✅ `role` in `POST /agents/spawn` and WS `spawn` — Task 4
- ✅ Role input in New Agent modal — Task 5
- ✅ Default agent config in Queue view — Task 5

**No placeholders found.**

**Type consistency:** `registerAgent` signature is consistent across Tasks 2, 4, and 5. `getSetting`/`setSetting` signatures match across Tasks 1, 3, and 4. `autoAssignPendingTasks` injection interface matches between Task 3 implementation and test calls.

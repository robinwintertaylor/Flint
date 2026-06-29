# SP7b: Task Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global cross-agent task queue stored in SQLite. Tasks can be unassigned or assigned to a specific agent; assignment appends the task to the agent's existing task file. A background poller detects when the agent checks off the task and marks it done. A Queue tab in the dashboard and CLI expose the queue.

**Architecture:** `dashboard/queue.js` provides all CRUD and the poller. `assignQueueTask` appends to the agent's `tasks/<agent>.md` file via existing `appendTask`. The poller runs every 10 seconds, scans in-progress task files, and calls `completeQueueTask` when it finds a checked-off title. If a task was created by an orchestrator agent (SP7c), `assignQueueTask` also prepends a worker-context block — using a try/catch so it degrades gracefully if the orchestrations table (created in SP7c) doesn't yet exist.

**Tech Stack:** Node.js 20+, better-sqlite3, Express, node:test, node:assert/strict

## Global Constraints

- No new npm dependencies
- `appendTask(agentName, text)` in `tasks.js` prepends `- [ ] ` — the text passed must be the full content after that prefix
- Poller title matching: `/^- \[x\] <escaped-title>/im` against the full task file content
- Worker-context injection is wrapped in try/catch; if `orchestrations` table doesn't exist (SP7c not yet deployed) the injection is silently skipped
- `status` values: `pending` | `in_progress` | `done` | `cancelled`
- `role` values: `researcher` | `planner` | `builder` | `tester` | null
- REST errors return `{ error: "..." }` with appropriate HTTP status
- Tests use `initDb(':memory:')` and a temp `FLINT_TASKS_DIR`
- Dashboard UI: same dark theme, no new CSS frameworks

---

### Task 1: DB schema and queue.js CRUD

**Files:**
- Modify: `dashboard/db.js` — add `task_queue` table
- Create: `dashboard/queue.js` — CRUD exports + poller
- Create: `dashboard/tests/queue.test.js` — tests

**Interfaces:**
- Produces:
  - `listQueueTasks({ status?, assigned_to?, project_id?, role? }?): Row[]`
  - `getQueueTask(id: number): Row | undefined`
  - `createQueueTask({ title, description?, project_id?, assigned_to?, role?, priority?, created_by? }): Row`
  - `assignQueueTask(id: number, agentName: string): Row`
  - `updateQueueTask(id: number, fields: object): void`
  - `completeQueueTask(id: number, result: string): void`
  - `cancelQueueTask(id: number): void`
  - `checkQueueTasks(): Promise<void>` — one poll cycle (exported for testing)
  - `startQueuePoller(intervalMs?: number): NodeJS.Timeout`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/queue.test.js`:

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

// Set tasks dir before importing modules that read it at startup
const TEMP_TASKS = join(tmpdir(), `flint-queue-test-${Date.now()}`);
process.env.FLINT_TASKS_DIR = TEMP_TASKS;

import { initDb } from '../db.js';
import {
  listQueueTasks, getQueueTask, createQueueTask,
  assignQueueTask, completeQueueTask, cancelQueueTask,
  checkQueueTasks,
} from '../queue.js';
import { writeTasks } from '../tasks.js';

before(() => {
  initDb(':memory:');
  mkdirSync(TEMP_TASKS, { recursive: true });
});

test('initDb creates task_queue table', () => {
  const db = initDb(':memory:');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('task_queue'), 'task_queue table missing');
});

test('createQueueTask with no assigned_to sets status to pending', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Research auth', created_by: 'human' });
  assert.ok(task.id);
  assert.equal(task.status, 'pending');
  assert.equal(task.assigned_to, null);
});

test('createQueueTask with assigned_to sets status to in_progress and appends to task file', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Build API', description: 'Build a REST API', assigned_to: 'builder-1', role: 'builder', created_by: 'human' });
  assert.equal(task.status, 'in_progress');
  assert.equal(task.assigned_to, 'builder-1');
  assert.equal(task.role, 'builder');
});

test('listQueueTasks returns all tasks', () => {
  initDb(':memory:');
  createQueueTask({ title: 'Task A', created_by: 'human' });
  createQueueTask({ title: 'Task B', created_by: 'human' });
  assert.equal(listQueueTasks().length, 2);
});

test('listQueueTasks filters by status', () => {
  initDb(':memory:');
  createQueueTask({ title: 'Pending', created_by: 'human' });
  const t = createQueueTask({ title: 'Cancellable', created_by: 'human' });
  cancelQueueTask(t.id);
  const pending = listQueueTasks({ status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, 'Pending');
});

test('listQueueTasks filters by assigned_to', () => {
  initDb(':memory:');
  createQueueTask({ title: 'For alice', assigned_to: 'alice', created_by: 'human' });
  createQueueTask({ title: 'For bob', assigned_to: 'bob', created_by: 'human' });
  const aliceTasks = listQueueTasks({ assigned_to: 'alice' });
  assert.equal(aliceTasks.length, 1);
  assert.equal(aliceTasks[0].title, 'For alice');
});

test('assignQueueTask sets assigned_to and in_progress', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Unassigned', created_by: 'human' });
  assert.equal(task.status, 'pending');
  const updated = assignQueueTask(task.id, 'my-agent');
  assert.equal(updated.assigned_to, 'my-agent');
  assert.equal(updated.status, 'in_progress');
});

test('completeQueueTask sets done and result', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Completable', created_by: 'human' });
  completeQueueTask(task.id, 'Found 3 patterns');
  const updated = getQueueTask(task.id);
  assert.equal(updated.status, 'done');
  assert.equal(updated.result, 'Found 3 patterns');
});

test('cancelQueueTask sets cancelled', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Cancellable', created_by: 'human' });
  cancelQueueTask(task.id);
  assert.equal(getQueueTask(task.id).status, 'cancelled');
});

test('checkQueueTasks completes task when title is checked off in task file', async () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'My checked task', assigned_to: 'checker-agent', created_by: 'human' });
  assert.equal(task.status, 'in_progress');
  // Simulate agent checking off the task
  writeTasks('checker-agent', `# Tasks — checker-agent\n\n- [x] My checked task\n`);
  await checkQueueTasks();
  const updated = getQueueTask(task.id);
  assert.equal(updated.status, 'done');
});

test('checkQueueTasks does not complete task when title is still unchecked', async () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Still pending task', assigned_to: 'lazy-agent', created_by: 'human' });
  writeTasks('lazy-agent', `# Tasks — lazy-agent\n\n- [ ] Still pending task\n`);
  await checkQueueTasks();
  assert.equal(getQueueTask(task.id).status, 'in_progress');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd dashboard && node --test tests/queue.test.js
```

Expected: FAIL with "Cannot find module '../queue.js'"

- [ ] **Step 3: Add task_queue table to db.js**

In `dashboard/db.js`, inside the `_db.exec(...)` string, add after the `mcp_servers` table:

```sql
    CREATE TABLE IF NOT EXISTS task_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      project_id  INTEGER REFERENCES projects(id),
      assigned_to TEXT,
      role        TEXT,
      priority    INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'pending',
      result      TEXT NOT NULL DEFAULT '',
      created_by  TEXT NOT NULL DEFAULT 'human',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
```

- [ ] **Step 4: Create dashboard/queue.js**

```js
import { getDb } from './db.js';
import { appendTask, readTasks, writeTasks } from './tasks.js';
import { broadcastGlobal } from './agents.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTaskForInjection(task) {
  const roleTag = task.role ? ` | Role: ${task.role}` : '';
  const desc = task.description ? `\n\n  ${task.description}` : '';
  return `${task.title}${desc}\n\n  _Queue task #${task.id}${roleTag}_`;
}

export function listQueueTasks({ status, assigned_to, project_id, role } = {}) {
  const db = getDb();
  const wheres = [];
  const vals = [];
  if (status !== undefined)      { wheres.push('status = ?');      vals.push(status); }
  if (assigned_to !== undefined) { wheres.push('assigned_to = ?'); vals.push(assigned_to); }
  if (project_id !== undefined)  { wheres.push('project_id = ?');  vals.push(project_id); }
  if (role !== undefined)        { wheres.push('role = ?');         vals.push(role); }
  const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM task_queue ${where} ORDER BY priority DESC, id ASC`).all(...vals);
}

export function getQueueTask(id) {
  return getDb().prepare('SELECT * FROM task_queue WHERE id = ?').get(id);
}

export function createQueueTask({ title, description = '', project_id, assigned_to, role, priority = 0, created_by = 'human' }) {
  const db = getDb();
  const status = assigned_to ? 'in_progress' : 'pending';
  const r = db.prepare(
    `INSERT INTO task_queue (title, description, project_id, assigned_to, role, priority, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, description, project_id ?? null, assigned_to ?? null, role ?? null, priority, status, created_by);
  const task = getQueueTask(r.lastInsertRowid);
  if (assigned_to) appendTask(assigned_to, formatTaskForInjection(task));
  broadcastGlobal({ type: 'queue_task_added', task });
  return task;
}

export function assignQueueTask(id, agentName) {
  const db = getDb();
  const task = getQueueTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  db.prepare(
    `UPDATE task_queue SET assigned_to = ?, status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(agentName, id);
  const updated = getQueueTask(id);

  // If this task was created by an orchestrator, prepend worker context (SP7c feature).
  // Wrapped in try/catch so it degrades gracefully if orchestrations table doesn't exist yet.
  try {
    const orch = db.prepare(
      `SELECT id FROM orchestrations WHERE agent_name = ? AND status = 'running'`
    ).get(task.created_by);
    if (orch) {
      const scratchpadPath = `tasks/orch-${orch.id}/scratchpad.md`;
      const role = task.role ?? 'worker';
      const context = `## Context — Orchestration Worker\nRole: ${role}\nShared scratchpad: ${scratchpadPath}\nRead the scratchpad for context. Append your findings under ## Findings.\nWhen done, your task will be marked complete automatically.\n\n---\n\n`;
      writeTasks(agentName, context + readTasks(agentName));
    }
  } catch { /* orchestrations table not yet present — skip */ }

  appendTask(agentName, formatTaskForInjection(updated));
  broadcastGlobal({ type: 'queue_task_assigned', task: updated });
  return updated;
}

export function updateQueueTask(id, fields) {
  const allowed = ['title', 'description', 'priority', 'result', 'project_id'];
  const sets = ['updated_at = CURRENT_TIMESTAMP'];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  getDb().prepare(`UPDATE task_queue SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function completeQueueTask(id, result = '') {
  getDb().prepare(
    `UPDATE task_queue SET status = 'done', result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(result, id);
  broadcastGlobal({ type: 'queue_task_done', taskId: id });
}

export function cancelQueueTask(id) {
  getDb().prepare(
    `UPDATE task_queue SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(id);
}

export async function checkQueueTasks() {
  const inProgress = getDb().prepare(
    `SELECT * FROM task_queue WHERE status = 'in_progress' AND assigned_to IS NOT NULL`
  ).all();
  for (const task of inProgress) {
    try {
      const content = readTasks(task.assigned_to);
      const re = new RegExp(`^- \\[x\\] ${escapeRegex(task.title)}`, 'im');
      if (re.test(content)) completeQueueTask(task.id, '');
    } catch { /* task file unreadable — skip */ }
  }
}

export function startQueuePoller(intervalMs = 10000) {
  return setInterval(checkQueueTasks, intervalMs);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd dashboard && node --test tests/queue.test.js
```

Expected: all 11 tests PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/db.js dashboard/queue.js dashboard/tests/queue.test.js
git commit -m "feat(sp7b): add task_queue table and queue.js CRUD + poller"
```

---

### Task 2: REST routes for task queue and start poller on boot

**Files:**
- Modify: `dashboard/server.js` — import queue.js, add REST routes, start poller
- Modify: `dashboard/tests/server.test.js` — add queue route tests

**Interfaces:**
- Consumes: `listQueueTasks, getQueueTask, createQueueTask, assignQueueTask, updateQueueTask, completeQueueTask, cancelQueueTask, startQueuePoller` from `./queue.js`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/server.test.js`:

```js
test('GET /queue/tasks returns empty array initially', async () => {
  const r = await req('GET', '/queue/tasks');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('POST /queue/tasks creates unassigned task', async () => {
  const r = await req('POST', '/queue/tasks', { title: 'Do the thing', description: 'Details here', created_by: 'human' });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.title, 'Do the thing');
  assert.equal(body.status, 'pending');
  assert.equal(body.assigned_to, null);
});

test('POST /queue/tasks with assigned_to sets in_progress', async () => {
  await req('POST', '/agents/spawn', { name: 'worker-q', workdir: process.cwd() });
  const r = await req('POST', '/queue/tasks', { title: 'Assigned task', assigned_to: 'worker-q', created_by: 'human' });
  const body = await r.json();
  assert.equal(body.status, 'in_progress');
  assert.equal(body.assigned_to, 'worker-q');
});

test('POST /queue/tasks with missing title returns 400', async () => {
  const r = await req('POST', '/queue/tasks', { description: 'no title' });
  assert.equal(r.status, 400);
});

test('GET /queue/tasks/:id returns the task', async () => {
  const created = await req('POST', '/queue/tasks', { title: 'Fetchable', created_by: 'human' }).then(r => r.json());
  const r = await req('GET', `/queue/tasks/${created.id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.id, created.id);
});

test('PATCH /queue/tasks/:id with assigned_to assigns the task', async () => {
  await req('POST', '/agents/spawn', { name: 'worker-assign', workdir: process.cwd() });
  const created = await req('POST', '/queue/tasks', { title: 'To assign', created_by: 'human' }).then(r => r.json());
  const r = await req('PATCH', `/queue/tasks/${created.id}`, { assigned_to: 'worker-assign' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'in_progress');
});

test('PATCH /queue/tasks/:id with status=done completes task', async () => {
  const created = await req('POST', '/queue/tasks', { title: 'To complete', created_by: 'human' }).then(r => r.json());
  await req('PATCH', `/queue/tasks/${created.id}`, { status: 'done', result: 'Finished' });
  const r = await req('GET', `/queue/tasks/${created.id}`);
  assert.equal((await r.json()).status, 'done');
});

test('DELETE /queue/tasks/:id cancels the task', async () => {
  const created = await req('POST', '/queue/tasks', { title: 'To cancel', created_by: 'human' }).then(r => r.json());
  await req('DELETE', `/queue/tasks/${created.id}`);
  const r = await req('GET', `/queue/tasks/${created.id}`);
  assert.equal((await r.json()).status, 'cancelled');
});

test('GET /queue/tasks?status=pending filters correctly', async () => {
  const t = await req('POST', '/queue/tasks', { title: 'Filter test pending', created_by: 'human' }).then(r => r.json());
  await req('POST', '/queue/tasks', { title: 'Filter test other', created_by: 'human' });
  await req('DELETE', `/queue/tasks/${t.id}`); // cancel first one
  const r = await req('GET', '/queue/tasks?status=pending');
  const list = await r.json();
  assert.ok(list.every(task => task.status === 'pending'), 'all returned tasks should be pending');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd dashboard && node --test tests/server.test.js 2>&1 | grep -E "FAIL|Error" | head -5
```

Expected: FAIL with 404 on `/queue/tasks`

- [ ] **Step 3: Add import, routes, and poller start to server.js**

In `dashboard/server.js`, add to the imports block:

```js
import { listQueueTasks, getQueueTask, createQueueTask, assignQueueTask, updateQueueTask, completeQueueTask, cancelQueueTask, startQueuePoller } from './queue.js';
```

After the MCP routes, add:

```js
  // --- Task queue routes ---

  app.get('/queue/tasks', (req, res) => {
    const { status, assigned_to, role, project_id } = req.query;
    res.json(listQueueTasks({
      ...(status      ? { status }      : {}),
      ...(assigned_to ? { assigned_to } : {}),
      ...(role        ? { role }         : {}),
      ...(project_id  ? { project_id: Number(project_id) } : {}),
    }));
  });

  app.get('/queue/tasks/:id', (req, res) => {
    const task = getQueueTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json(task);
  });

  app.post('/queue/tasks', (req, res) => {
    const { title, description, project_id, assigned_to, role, priority, created_by } = req.body ?? {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const task = createQueueTask({ title, description, project_id, assigned_to, role, priority, created_by });
    res.status(201).json(task);
  });

  app.patch('/queue/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    const task = getQueueTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const { assigned_to, status, result, priority, description } = req.body ?? {};
    if (assigned_to !== undefined) return res.json(assignQueueTask(id, assigned_to));
    if (status === 'done')      { completeQueueTask(id, result ?? ''); return res.json(getQueueTask(id)); }
    if (status === 'cancelled') { cancelQueueTask(id); return res.json(getQueueTask(id)); }
    if (priority !== undefined || description !== undefined) {
      updateQueueTask(id, { ...(priority !== undefined ? { priority } : {}), ...(description !== undefined ? { description } : {}) });
    }
    res.json(getQueueTask(id));
  });

  app.delete('/queue/tasks/:id', (req, res) => {
    const task = getQueueTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    cancelQueueTask(Number(req.params.id));
    res.json({ ok: true });
  });
```

In `createApp()`, after `initAgents(...)`, start the poller (skip in test mode):

```js
  if (!TEST_MODE) startQueuePoller();
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd dashboard && node --test tests/server.test.js
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/server.js dashboard/tests/server.test.js
git commit -m "feat(sp7b): add queue REST routes and start poller on server boot"
```

---

### Task 3: Dashboard Queue tab UI

**Files:**
- Modify: `dashboard/public/index.html` — Queue tab button, queue-view div, add-task modal
- Modify: `dashboard/public/app.js` — queue view rendering, WS handlers, add-task form
- Modify: `dashboard/public/style.css` — queue table, role chips, status colours, unassigned glow

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /queue/tasks`, `GET /agents`, WS messages `queue_task_added`, `queue_task_assigned`, `queue_task_done`

*No automated test — verify manually in the browser.*

- [ ] **Step 1: Add CSS to style.css**

Append to `dashboard/public/style.css`:

```css
/* Queue view */
#queue-view { padding: 16px; display: flex; flex-direction: column; gap: 0; }
.queue-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.queue-filters { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.filter-pill {
  padding: 3px 10px; border-radius: 12px; font-size: 11px; cursor: pointer;
  background: #21262d; border: 1px solid #30363d; color: #8b949e;
}
.filter-pill.active { background: #388bfd22; border-color: #58a6ff; color: #58a6ff; }

.queue-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.queue-table th { color: #8b949e; text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; font-weight: normal; }
.queue-table td { padding: 7px 10px; border-bottom: 1px solid #161b22; vertical-align: middle; }
.queue-table tr:hover td { background: #1c2128; }
.queue-row-unassigned td:first-child { box-shadow: inset 3px 0 0 #d29922; }

.role-chip {
  display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: bold;
}
.role-researcher { background: #1a3f6e; color: #58a6ff; }
.role-planner    { background: #2d1f5e; color: #bf91f3; }
.role-builder    { background: #1a4731; color: #3fb950; }
.role-tester     { background: #5a2a00; color: #d29922; }

.badge-queue-pending     { background: #783900; color: #d29922; }
.badge-queue-in_progress { background: #1c3f5e; color: #58a6ff; }
.badge-queue-done        { background: #1a4731; color: #3fb950; }
.badge-queue-cancelled   { background: #3d3d3d; color: #8b949e; }

.queue-expand { display: none; background: #161b22; }
.queue-expand.open { display: table-row; }
.queue-expand td { padding: 8px 18px 12px; color: #8b949e; font-size: 12px; white-space: pre-wrap; }
```

- [ ] **Step 2: Add HTML to index.html**

In `<div id="toolbar">`, after the MCP button:

```html
    <button id="btn-queue">⬡ Queue</button>
```

After `<div id="project-view" class="hidden"></div>`, add:

```html
  <div id="queue-view" class="hidden"></div>
```

After the workspace manager modal, add:

```html
  <!-- Add Task modal -->
  <div id="add-task-modal" class="hidden" role="dialog" aria-modal="true">
    <div class="modal-box" style="max-width:480px">
      <h2>Add Task to Queue</h2>
      <label>Title (required)<input id="add-task-title" type="text" placeholder="Research OAuth2 patterns" autocomplete="off"></label>
      <label>Description<textarea id="add-task-desc" rows="3" placeholder="Optional detail…" style="width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:8px;font-family:inherit;resize:vertical"></textarea></label>
      <label>Assign to agent
        <select id="add-task-agent">
          <option value="">Leave unassigned</option>
        </select>
      </label>
      <label>Role
        <select id="add-task-role">
          <option value="">None</option>
          <option value="researcher">Researcher</option>
          <option value="planner">Planner</option>
          <option value="builder">Builder</option>
          <option value="tester">Tester</option>
        </select>
      </label>
      <label>Priority <input id="add-task-priority" type="number" value="0" min="0" style="width:80px"></label>
      <div class="modal-actions">
        <button id="add-task-cancel">Cancel</button>
        <button id="add-task-submit" style="background:#1f6feb;color:#fff;border:none">Add Task</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Add Queue JS to app.js**

In `app.js`, update `showView()` to handle `'queue'`:

```js
function showView(view) {
  currentView = view;
  const panels    = document.getElementById('panels');
  const toolbar   = document.getElementById('toolbar');
  const projView  = document.getElementById('project-view');
  const projBar   = document.getElementById('proj-toolbar');
  const queueView = document.getElementById('queue-view');
  if (view === 'projects') {
    panels.style.display = 'none'; toolbar.style.display = 'none';
    projView.classList.remove('hidden'); queueView.classList.add('hidden');
    if (projBar) projBar.style.display = 'flex';
    fetchProjects();
  } else if (view === 'queue') {
    panels.style.display = 'none'; toolbar.style.display = 'none';
    projView.classList.add('hidden'); queueView.classList.remove('hidden');
    if (projBar) projBar.style.display = 'none';
    fetchAndRenderQueue();
  } else {
    panels.style.display = ''; toolbar.style.display = '';
    projView.classList.add('hidden'); queueView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
  }
}
```

Append queue logic to `app.js`:

```js
// ============================================================
// Task Queue tab
// ============================================================

let queueFilter = 'all';

document.getElementById('btn-queue').addEventListener('click', () => showView('queue'));

async function fetchAndRenderQueue(statusFilter = queueFilter) {
  const url = statusFilter === 'all' ? '/queue/tasks' : `/queue/tasks?status=${statusFilter}`;
  const tasks = await fetch(url).then(r => r.json()).catch(() => []);
  const agents = await fetch('/agents').then(r => r.json()).catch(() => []);
  renderQueueView(tasks, agents, statusFilter);
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function renderQueueView(tasks, agents, activeFilter) {
  const view = document.getElementById('queue-view');
  const roleChip = r => r ? `<span class="role-chip role-${r}">${r}</span>` : '';
  const statusBadge = s => `<span class="badge badge-queue-${s}">${s.replace('_', ' ')}</span>`;
  const agentCell = t => t.assigned_to
    ? escHtml(t.assigned_to)
    : `<span style="color:#d29922">unassigned</span>`;

  view.innerHTML = `
    <div class="queue-header">
      <h3 style="margin:0;font-size:15px">Task Queue</h3>
      <button id="btn-add-task" style="background:#238636;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px">+ Add Task</button>
    </div>
    <div class="queue-filters">
      ${['all','pending','in_progress','done','cancelled'].map(f =>
        `<button class="filter-pill${activeFilter === f ? ' active' : ''}" data-filter="${f}">${f === 'in_progress' ? 'in progress' : f}</button>`
      ).join('')}
    </div>
    ${tasks.length === 0
      ? `<p style="color:#8b949e;text-align:center;padding:40px">No tasks${activeFilter !== 'all' ? ` with status "${activeFilter}"` : ''}.</p>`
      : `<table class="queue-table">
          <thead><tr>
            <th>Status</th><th>Title</th><th>Role</th><th>Agent</th><th>Pri</th><th>Created</th><th></th>
          </tr></thead>
          <tbody>${tasks.map(t => `
            <tr class="queue-row${!t.assigned_to ? ' queue-row-unassigned' : ''}" data-task-id="${t.id}">
              <td>${statusBadge(t.status)}</td>
              <td style="cursor:pointer" class="queue-title-cell" data-expand="${t.id}">${escHtml(t.title)}</td>
              <td>${roleChip(t.role)}</td>
              <td>${agentCell(t)}</td>
              <td style="color:#8b949e">${t.priority}</td>
              <td style="color:#8b949e;white-space:nowrap">${relativeTime(t.created_at)}</td>
              <td style="white-space:nowrap">
                ${!t.assigned_to && t.status === 'pending' ? `<button class="btn-assign-task" data-id="${t.id}" style="font-size:11px;padding:2px 7px;border-radius:4px;border:1px solid #388bfd;background:none;color:#388bfd;cursor:pointer">Assign</button>` : ''}
                ${['pending','in_progress'].includes(t.status) ? `<button class="btn-cancel-task" data-id="${t.id}" style="font-size:11px;padding:2px 7px;border-radius:4px;border:1px solid #f8514966;background:none;color:#f85149;cursor:pointer;margin-left:4px">Cancel</button>` : ''}
              </td>
            </tr>
            <tr class="queue-expand" id="expand-${t.id}"><td colspan="7">
              ${t.description ? `<strong>Description:</strong> ${escHtml(t.description)}\n` : ''}
              ${t.result ? `<strong>Result:</strong> ${escHtml(t.result)}` : '(no result yet)'}
            </td></tr>
          `).join('')}</tbody>
        </table>`
    }
  `;

  // Filter pills
  view.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      queueFilter = btn.dataset.filter;
      fetchAndRenderQueue(queueFilter);
    });
  });

  // Expand rows
  view.querySelectorAll('.queue-title-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const row = document.getElementById(`expand-${cell.dataset.expand}`);
      row?.classList.toggle('open');
    });
  });

  // Cancel buttons
  view.querySelectorAll('.btn-cancel-task').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/queue/tasks/${btn.dataset.id}`, { method: 'DELETE' });
      fetchAndRenderQueue(queueFilter);
    });
  });

  // Assign buttons — open add-task modal pre-filled
  view.querySelectorAll('.btn-assign-task').forEach(btn => {
    btn.addEventListener('click', () => {
      openAddTaskModal(agents, Number(btn.dataset.id));
    });
  });

  // Add Task button
  document.getElementById('btn-add-task').addEventListener('click', () => openAddTaskModal(agents));
}

function openAddTaskModal(agents, preAssignTaskId = null) {
  const modal = document.getElementById('add-task-modal');
  const agentSel = document.getElementById('add-task-agent');
  agentSel.innerHTML = '<option value="">Leave unassigned</option>';
  agents.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.name; opt.textContent = a.name;
    agentSel.appendChild(opt);
  });
  modal.classList.remove('hidden');
  modal.dataset.preAssignId = preAssignTaskId ?? '';
  document.getElementById('add-task-title').focus();
}

document.getElementById('add-task-cancel').addEventListener('click', () =>
  document.getElementById('add-task-modal').classList.add('hidden'));
document.getElementById('add-task-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('add-task-modal'))
    document.getElementById('add-task-modal').classList.add('hidden');
});

document.getElementById('add-task-submit').addEventListener('click', async () => {
  const title = document.getElementById('add-task-title').value.trim();
  if (!title) return;
  const description = document.getElementById('add-task-desc').value.trim();
  const assigned_to = document.getElementById('add-task-agent').value || undefined;
  const role        = document.getElementById('add-task-role').value || undefined;
  const priority    = Number(document.getElementById('add-task-priority').value) || 0;
  const modal       = document.getElementById('add-task-modal');
  const preId       = modal.dataset.preAssignId;

  if (preId && assigned_to) {
    // Assign existing task to agent
    await fetch(`/queue/tasks/${preId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_to }),
    });
  } else {
    await fetch('/queue/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, assigned_to, role, priority, created_by: 'human' }),
    });
  }
  modal.classList.add('hidden');
  document.getElementById('add-task-title').value = '';
  document.getElementById('add-task-desc').value = '';
  fetchAndRenderQueue(queueFilter);
});
```

Add WS message handlers in the `switch (msg.type)` block in `connect()`:

```js
      case 'queue_task_added':
      case 'queue_task_assigned':
      case 'queue_task_done':
        if (currentView === 'queue') fetchAndRenderQueue(queueFilter);
        break;
```

- [ ] **Step 4: Manually verify in browser**

Start the server: `node start.js`

Open `http://localhost:3000`, click **⬡ Queue**.

Verify:
- Queue view opens, shows "No tasks" message.
- Click "+ Add Task": modal opens. Fill title "Test task", leave unassigned. Click Add Task.
- Task appears in table with status "pending", "unassigned" in amber.
- Click on the title — row expands showing description/result.
- Click "Cancel" — task moves to cancelled. Switch filter to "cancelled" to see it.
- Add another task assigned to an existing agent. Verify status is "in progress".

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/index.html dashboard/public/app.js dashboard/public/style.css
git commit -m "feat(sp7b): add Queue tab to dashboard with task table, filters, and add-task modal"
```

---

### Task 4: CLI queue subcommand

**Files:**
- Modify: `bin/flint.js` — add `cmdQueue`, register in COMMANDS, update usage

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /queue/tasks` via `dashGet/dashPost/dashPatch/dashDelete`

*No automated test — verify manually.*

- [ ] **Step 1: Add cmdQueue to bin/flint.js**

Before `cmdWorkspace`, add:

```js
async function cmdQueue(args) {
  const [sub, ...rest] = args;

  if (sub === 'list') {
    const { values } = parseArgs({
      args: rest,
      options: { status: { type: 'string' }, agent: { type: 'string' } },
      allowPositionals: false,
    });
    const qs = new URLSearchParams();
    if (values.status) qs.set('status', values.status);
    if (values.agent)  qs.set('assigned_to', values.agent);
    const list = await dashGet(`/queue/tasks${qs.toString() ? '?' + qs : ''}`);
    if (!list.length) { console.log('No tasks.'); return; }
    for (const t of list) {
      const role   = t.role ? ` [${t.role}]` : '';
      const agent  = t.assigned_to ? ` → ${t.assigned_to}` : ' → unassigned';
      console.log(`[${t.id}] [${t.status}] ${t.title}${role}${agent}`);
    }

  } else if (sub === 'add') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        desc:     { type: 'string' },
        agent:    { type: 'string' },
        role:     { type: 'string' },
        priority: { type: 'string' },
      },
      allowPositionals: true,
    });
    const title = positionals.join(' ');
    if (!title) { console.error('Usage: flint queue add "title" [--desc "..."] [--agent <name>] [--role researcher|planner|builder|tester] [--priority 1]'); process.exit(1); }
    const body = { title, created_by: 'human' };
    if (values.desc)     body.description = values.desc;
    if (values.agent)    body.assigned_to  = values.agent;
    if (values.role)     body.role         = values.role;
    if (values.priority) body.priority     = Number(values.priority);
    const task = await dashPost('/queue/tasks', body);
    console.log(`Task [${task.id}] added: "${task.title}" [${task.status}]`);

  } else if (sub === 'assign') {
    const [id, agent] = rest;
    if (!id || !agent) { console.error('Usage: flint queue assign <id> <agent>'); process.exit(1); }
    const task = await dashPatch(`/queue/tasks/${id}`, { assigned_to: agent });
    console.log(`Task [${task.id}] assigned to "${task.assigned_to}".`);

  } else if (sub === 'done') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { result: { type: 'string' } },
      allowPositionals: true,
    });
    const [id] = positionals;
    if (!id) { console.error('Usage: flint queue done <id> [--result "summary"]'); process.exit(1); }
    await dashPatch(`/queue/tasks/${id}`, { status: 'done', result: values.result ?? '' });
    console.log(`Task [${id}] marked done.`);

  } else if (sub === 'cancel') {
    const [id] = rest;
    if (!id) { console.error('Usage: flint queue cancel <id>'); process.exit(1); }
    await dashDelete(`/queue/tasks/${id}`);
    console.log(`Task [${id}] cancelled.`);

  } else {
    console.error('Usage: flint queue <list|add|assign|done|cancel>');
    process.exit(1);
  }
}
```

- [ ] **Step 2: Register queue in COMMANDS and update usage**

```js
const COMMANDS = { ask: cmdAsk, models: cmdModels, config: cmdConfig, costs: cmdCosts, project: cmdProject, suggestions: cmdSuggestions, worktree: cmdWorktree, workspace: cmdWorkspace, mcp: cmdMcp, queue: cmdQueue };
```

```js
  console.error(`Usage: flint <ask|models|config|costs|project|suggestions|worktree|workspace|mcp|queue>`);
```

- [ ] **Step 3: Manual verification**

```
node bin/flint.js queue list
# Expected: No tasks.

node bin/flint.js queue add "Research OAuth2 patterns" --desc "Look at RFC 6749" --role researcher
# Expected: Task [1] added: "Research OAuth2 patterns" [pending]

node bin/flint.js queue list
# Expected: [1] [pending] Research OAuth2 patterns [researcher] → unassigned

node bin/flint.js queue done 1 --result "Found 3 patterns in RFC 6749"
# Expected: Task [1] marked done.

node bin/flint.js queue list --status done
# Expected: [1] [done] Research OAuth2 patterns [researcher] → unassigned
```

- [ ] **Step 4: Commit**

```bash
git add bin/flint.js
git commit -m "feat(sp7b): add flint queue CLI subcommand (list/add/assign/done/cancel)"
```

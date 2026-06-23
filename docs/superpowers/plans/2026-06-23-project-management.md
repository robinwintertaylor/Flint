# Project Management Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project registry to Flint so agents can be grouped into projects, costs tracked per project, and session context automatically injected when an agent picks up work.

**Architecture:** All project data lives in two new tables (`projects`, `project_agents`) in the existing `usage.sqlite`. A new `dashboard/projects.js` module handles all DB operations. Six REST routes added to `dashboard/server.js`. `terminal.js` gains context injection on spawn and session summary capture on exit. The dashboard gets a Projects tab (toggle from the header). The CLI gains a `project` subcommand group calling port 3000.

**Tech Stack:** Node.js 20+ ESM, better-sqlite3, Express 4, `node:test` + `node:assert/strict`, plain browser JS (no build step)

## Global Constraints

- Node.js 20+, ESM throughout — `import`/`export`, no `require()`
- `__dirname` via `dirname(fileURLToPath(import.meta.url))`
- `FLINT_DB_PATH` env var overrides `usage.sqlite` path (same pattern as existing code)
- `FLINT_TASKS_DIR` env var overrides tasks directory (same pattern as existing code)
- `FLINT_TEST_MODE=1` — server.js already skips spawnAgent; terminal.js context injection runs regardless (it's just file I/O)
- Tests use `node:test` and `node:assert/strict` — no external test framework
- All env vars set at module top level BEFORE any `await import(...)` calls in tests
- Dashboard lives at port 3000; all project CLI calls go to `http://localhost:3000`
- `dashboard/package.json` test script must list all test files explicitly
- Root: `C:\Users\Robin\Applications Dev\Flint\`

---

## File Map

**Created:**
- `dashboard/projects.js` — project CRUD, agent linking, cost aggregation
- `dashboard/tests/projects.test.js` — DB layer tests, HTTP route tests, session continuity unit tests

**Modified:**
- `dashboard/db.js` — export `getDb()`; add `projects` + `project_agents` tables to `initDb()`
- `dashboard/server.js` — import projects.js; add 6 project REST routes
- `dashboard/terminal.js` — import projects.js + tasks.js; export `injectProjectContext()`; add output buffer + summary capture to `spawnAgent()`
- `dashboard/package.json` — add `projects.test.js` to test script
- `dashboard/public/index.html` — Projects tab button; `#project-view` container; two new modals
- `dashboard/public/app.js` — projects tab logic, card grid, new/edit modals
- `dashboard/public/style.css` — project card styles, status badge colours
- `bin/flint.js` — `project` subcommand group (list, create, status, notes, link, unlink)

---

### Task 1: DB layer — schema migration + `dashboard/projects.js`

**Files:**
- Modify: `dashboard/db.js`
- Create: `dashboard/projects.js`
- Create: `dashboard/tests/projects.test.js`
- Modify: `dashboard/package.json`

**Interfaces:**
- Produces:
  - `getDb() → Database` — exported from db.js; returns singleton or throws if uninitialised
  - `listProjects() → Project[]`
  - `getProject(id: number) → Project | null`
  - `createProject({ name: string, notes?: string }) → number` (new project id)
  - `updateProject(id: number, fields: { name?, status?, notes?, last_summary? }) → void`
  - `linkAgent(projectId: number, agentName: string) → void`
  - `unlinkAgent(projectId: number, agentName: string) → void`
  - `getProjectForAgent(agentName: string) → { id, name, notes, last_summary } | null`
  - `Project` shape: `{ id, name, status, notes, last_summary, agents: string[], costWeek: number, costMonth: number }`

- [ ] **Step 1: Write the failing tests**

`dashboard/tests/projects.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Set env vars before any imports
process.env.FLINT_DB_PATH = ':memory:';

const { initDb, closeDb } = await import('../db.js');
const {
  listProjects, getProject, createProject, updateProject,
  linkAgent, unlinkAgent, getProjectForAgent,
} = await import('../projects.js');

before(() => {
  initDb(':memory:');
});

after(() => {
  closeDb();
});

test('createProject returns a numeric id', () => {
  const id = createProject({ name: 'Alpha', notes: 'first project' });
  assert.ok(typeof id === 'number' && id > 0);
});

test('listProjects returns active projects with agents and cost arrays', () => {
  initDb(':memory:');
  createProject({ name: 'Beta' });
  const list = listProjects();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
  const p = list[0];
  assert.ok(Array.isArray(p.agents));
  assert.ok(typeof p.costWeek === 'number');
  assert.ok(typeof p.costMonth === 'number');
});

test('listProjects excludes archived projects', () => {
  initDb(':memory:');
  const id = createProject({ name: 'ToArchive' });
  updateProject(id, { status: 'archived' });
  const list = listProjects();
  assert.ok(!list.find(p => p.name === 'ToArchive'));
});

test('getProject returns project by id with agents list', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Gamma', notes: 'test notes' });
  const p = getProject(id);
  assert.equal(p.name, 'Gamma');
  assert.equal(p.notes, 'test notes');
  assert.ok(Array.isArray(p.agents));
});

test('getProject returns null for unknown id', () => {
  initDb(':memory:');
  assert.equal(getProject(99999), null);
});

test('updateProject changes name, status, notes', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Delta' });
  updateProject(id, { name: 'Delta2', status: 'paused', notes: 'updated' });
  const p = getProject(id);
  assert.equal(p.name, 'Delta2');
  assert.equal(p.status, 'paused');
  assert.equal(p.notes, 'updated');
});

test('linkAgent and unlinkAgent modify project_agents', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Epsilon' });
  linkAgent(id, 'research');
  let p = getProject(id);
  assert.ok(p.agents.includes('research'));
  unlinkAgent(id, 'research');
  p = getProject(id);
  assert.ok(!p.agents.includes('research'));
});

test('linkAgent is idempotent', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Zeta' });
  linkAgent(id, 'code');
  linkAgent(id, 'code'); // should not throw or duplicate
  const p = getProject(id);
  assert.equal(p.agents.filter(a => a === 'code').length, 1);
});

test('getProjectForAgent returns project linked to agent', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Eta', notes: 'agent project' });
  linkAgent(id, 'my-agent');
  const proj = getProjectForAgent('my-agent');
  assert.ok(proj !== null);
  assert.equal(proj.name, 'Eta');
  assert.equal(proj.notes, 'agent project');
});

test('getProjectForAgent returns null for unlinked agent', () => {
  initDb(':memory:');
  assert.equal(getProjectForAgent('ghost-agent'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/projects.test.js
```

Expected: FAIL — `../projects.js` not found or export errors.

- [ ] **Step 3: Export `getDb` from `dashboard/db.js` and add schema tables**

Read `dashboard/db.js` first. Make two changes:

**Change 1:** In `initDb()`, add the two new tables to the `_db.exec(...)` call:

```js
export function initDb(dbPath = DEFAULT_DB) {
  _db = new Database(dbPath);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id         INTEGER PRIMARY KEY,
      agent_name TEXT NOT NULL,
      tokens_in  INTEGER,
      tokens_out INTEGER,
      model      TEXT,
      cost_usd   REAL,
      timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS agents_log (
      name      TEXT PRIMARY KEY,
      mode      TEXT,
      workdir   TEXT,
      status    TEXT,
      last_seen DATETIME
    );
    CREATE TABLE IF NOT EXISTS projects (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      status       TEXT NOT NULL DEFAULT 'active',
      notes        TEXT DEFAULT '',
      last_summary TEXT DEFAULT '',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS project_agents (
      project_id INTEGER NOT NULL REFERENCES projects(id),
      agent_name TEXT NOT NULL,
      PRIMARY KEY (project_id, agent_name)
    );
  `);
  return _db;
}
```

**Change 2:** Change `function getDb()` to `export function getDb()`:

```js
export function getDb() {
  if (!_db) throw new Error('DB not initialised — call initDb() first');
  return _db;
}
```

- [ ] **Step 4: Create `dashboard/projects.js`**

```js
import { getDb } from './db.js';

function projectCost(db, projectId, period) {
  const filter = period === 'week'
    ? `date(timestamp) >= date('now', '-7 days')`
    : `strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')`;
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage
    WHERE agent_name IN (SELECT agent_name FROM project_agents WHERE project_id = ?)
    AND ${filter}
  `).get(projectId);
  return row.total;
}

function hydrate(row) {
  const db = getDb();
  const agents = db.prepare(
    `SELECT agent_name FROM project_agents WHERE project_id = ? ORDER BY agent_name`
  ).all(row.id).map(r => r.agent_name);
  return {
    ...row,
    agents,
    costWeek: projectCost(db, row.id, 'week'),
    costMonth: projectCost(db, row.id, 'month'),
  };
}

export function listProjects() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM projects WHERE status != 'archived' ORDER BY updated_at DESC`
  ).all();
  return rows.map(hydrate);
}

export function getProject(id) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
  if (!row) return null;
  return hydrate(row);
}

export function createProject({ name, notes = '' }) {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO projects (name, notes) VALUES (?, ?)`
  ).run(name, notes);
  return result.lastInsertRowid;
}

export function updateProject(id, fields) {
  const db = getDb();
  const allowed = ['name', 'status', 'notes', 'last_summary'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const setParts = updates.map(([k]) => `${k} = ?`).join(', ');
  const values = updates.map(([, v]) => v);
  db.prepare(
    `UPDATE projects SET ${setParts}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...values, id);
}

export function linkAgent(projectId, agentName) {
  getDb().prepare(
    `INSERT OR IGNORE INTO project_agents (project_id, agent_name) VALUES (?, ?)`
  ).run(projectId, agentName);
}

export function unlinkAgent(projectId, agentName) {
  getDb().prepare(
    `DELETE FROM project_agents WHERE project_id = ? AND agent_name = ?`
  ).run(projectId, agentName);
}

export function getProjectForAgent(agentName) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.id, p.name, p.notes, p.last_summary
    FROM projects p
    JOIN project_agents pa ON pa.project_id = p.id
    WHERE pa.agent_name = ?
    LIMIT 1
  `).get(agentName);
  return row ?? null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/projects.test.js
```

Expected: 10/10 PASS.

- [ ] **Step 6: Verify existing db.test.js still passes**

```bash
node --test tests/db.test.js
```

Expected: 5/5 PASS (getDb export is additive; initDb SQL additions use `CREATE TABLE IF NOT EXISTS`).

- [ ] **Step 7: Update `dashboard/package.json` test script**

Read `dashboard/package.json`. Change the `test` script to include the new file:

```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js"
```

- [ ] **Step 8: Run full test suite**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js
```

Expected: all pass (20 existing + 10 new = 30 total).

- [ ] **Step 9: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add dashboard/db.js dashboard/projects.js dashboard/tests/projects.test.js dashboard/package.json
git commit -m "feat(pm): projects DB layer — schema, projects.js, tests"
```

---

### Task 2: REST API — project routes in `dashboard/server.js`

**Files:**
- Modify: `dashboard/server.js`
- Modify: `dashboard/tests/projects.test.js` (add HTTP route tests)

**Interfaces:**
- Consumes: `listProjects`, `getProject`, `createProject`, `updateProject`, `linkAgent`, `unlinkAgent` from `./projects.js`
- Produces HTTP endpoints:
  - `GET /projects` → `Project[]`
  - `POST /projects` → `Project` (400 if name missing)
  - `PATCH /projects/:id` → `Project` (404 if not found)
  - `DELETE /projects/:id` → `{ ok: true }` (404 if not found; sets status='archived')
  - `POST /projects/:id/agents` → `{ ok: true }` (404 if project not found)
  - `DELETE /projects/:id/agents/:agentName` → `{ ok: true }` (404 if project not found)

- [ ] **Step 1: Write the failing HTTP tests**

Append to `dashboard/tests/projects.test.js` (after the DB tests section):

```js
// --- HTTP route tests ---

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP2 = join(tmpdir(), 'flint-proj-routes-' + Date.now());
mkdirSync(TMP2, { recursive: true });

// Set env vars for server import
process.env.FLINT_DB_PATH   = join(TMP2, 'usage.sqlite');
process.env.FLINT_AGENTS_FILE = join(TMP2, 'agents.json');
process.env.FLINT_TASKS_DIR   = join(TMP2, 'tasks');
process.env.FLINT_TEST_MODE   = '1';
writeFileSync(process.env.FLINT_AGENTS_FILE, '[]');

const { createApp, closeDb: closeDb2 } = await import('../server.js');

let srv, base;

before(async () => {
  srv = createApp();
  await new Promise(resolve => srv.listen(0, resolve));
  base = `http://localhost:${srv.address().port}`;
});

after(async () => {
  await new Promise(resolve => srv.close(resolve));
  closeDb2();
  rmSync(TMP2, { recursive: true, force: true });
  delete process.env.FLINT_DB_PATH;
  delete process.env.FLINT_AGENTS_FILE;
  delete process.env.FLINT_TASKS_DIR;
  delete process.env.FLINT_TEST_MODE;
});

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${base}${path}`, opts);
  return { status: res.status, body: await res.json() };
}

test('GET /projects returns empty array initially', async () => {
  const { status, body } = await req('GET', '/projects');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('POST /projects creates a project', async () => {
  const { status, body } = await req('POST', '/projects', { name: 'Test Project', notes: 'hello' });
  assert.equal(status, 201);
  assert.equal(body.name, 'Test Project');
  assert.equal(body.notes, 'hello');
  assert.ok(typeof body.id === 'number');
});

test('POST /projects returns 400 when name missing', async () => {
  const { status } = await req('POST', '/projects', { notes: 'oops' });
  assert.equal(status, 400);
});

test('PATCH /projects/:id updates status', async () => {
  const { body: created } = await req('POST', '/projects', { name: 'Patchable' });
  const { status, body } = await req('PATCH', `/projects/${created.id}`, { status: 'paused' });
  assert.equal(status, 200);
  assert.equal(body.status, 'paused');
});

test('DELETE /projects/:id archives project', async () => {
  const { body: created } = await req('POST', '/projects', { name: 'Archivable' });
  const { status } = await req('DELETE', `/projects/${created.id}`);
  assert.equal(status, 200);
  const { body: list } = await req('GET', '/projects');
  assert.ok(!list.find(p => p.id === created.id));
});

test('POST /projects/:id/agents links agent', async () => {
  const { body: created } = await req('POST', '/projects', { name: 'Linkable' });
  const { status } = await req('POST', `/projects/${created.id}/agents`, { agentName: 'research' });
  assert.equal(status, 200);
  const { body: proj } = await req('GET', `/projects/${created.id}`);
  assert.ok(proj.agents.includes('research'));
});

test('DELETE /projects/:id/agents/:name unlinks agent', async () => {
  const { body: created } = await req('POST', '/projects', { name: 'Unlinkable' });
  await req('POST', `/projects/${created.id}/agents`, { agentName: 'code' });
  const { status } = await req('DELETE', `/projects/${created.id}/agents/code`);
  assert.equal(status, 200);
  const { body: proj } = await req('GET', `/projects/${created.id}`);
  assert.ok(!proj.agents.includes('code'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/projects.test.js
```

Expected: the first 10 DB tests pass, the 7 new HTTP tests fail with 404 (routes not yet added).

- [ ] **Step 3: Add project imports to `dashboard/server.js`**

Read `dashboard/server.js`. Add to the import block at the top:

```js
import {
  listProjects, getProject, createProject, updateProject,
  linkAgent, unlinkAgent,
} from './projects.js';
```

- [ ] **Step 4: Add project REST routes to `dashboard/server.js`**

Add these 6 routes inside `createApp()`, after the existing `/router/config` route and before the `// --- WebSocket ---` comment:

```js
  // --- Project routes ---

  app.get('/projects', (_req, res) => {
    res.json(listProjects());
  });

  app.get('/projects/:id', (req, res) => {
    const p = getProject(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'project not found' });
    res.json(p);
  });

  app.post('/projects', (req, res) => {
    const { name, notes } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      const id = createProject({ name, notes: notes ?? '' });
      res.status(201).json(getProject(id));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'project name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/projects/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    const { name, status, notes } = req.body ?? {};
    updateProject(id, { name, status, notes });
    res.json(getProject(id));
  });

  app.delete('/projects/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    updateProject(id, { status: 'archived' });
    res.json({ ok: true });
  });

  app.post('/projects/:id/agents', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    const { agentName } = req.body ?? {};
    if (!agentName) return res.status(400).json({ error: 'agentName required' });
    linkAgent(id, agentName);
    res.json({ ok: true });
  });

  app.delete('/projects/:id/agents/:agentName', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    unlinkAgent(id, req.params.agentName);
    res.json({ ok: true });
  });
```

- [ ] **Step 5: Run all tests to verify they pass**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js
```

Expected: all pass (20 existing + 17 new = 37 total).

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add dashboard/server.js dashboard/tests/projects.test.js
git commit -m "feat(pm): project REST routes — GET/POST/PATCH/DELETE /projects and agent linking"
```

---

### Task 3: Session continuity — `dashboard/terminal.js`

**Files:**
- Modify: `dashboard/terminal.js`
- Modify: `dashboard/tests/projects.test.js` (add session continuity unit test)

**Interfaces:**
- Consumes: `getProjectForAgent`, `updateProject` from `./projects.js`; `readTasks`, `writeTasks` from `./tasks.js`
- Produces:
  - `export function injectProjectContext(agentName: string) → void` — prepends project block to agent task file; no-op if agent not linked to any project
  - `spawnAgent(name, workdir, model)` — unchanged signature; now also calls `injectProjectContext` on spawn and saves last 50 output lines as `last_summary` on exit

- [ ] **Step 1: Write the failing test for `injectProjectContext`**

Append to `dashboard/tests/projects.test.js` (after the HTTP tests section):

```js
// --- Session continuity unit tests ---
import { mkdirSync as mkd2, rmSync as rmd2, readFileSync } from 'node:fs';
import { tmpdir as td } from 'node:os';
import { join as j } from 'node:path';

const TASK_TMP = j(td(), 'flint-tasks-' + Date.now());
mkd2(TASK_TMP, { recursive: true });
process.env.FLINT_TASKS_DIR = TASK_TMP;

const { injectProjectContext } = await import('../terminal.js');
const { writeTasks, readTasks } = await import('../tasks.js');

after(() => {
  rmd2(TASK_TMP, { recursive: true, force: true });
  delete process.env.FLINT_TASKS_DIR;
});

test('injectProjectContext prepends project block to agent task file', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Inject Project', notes: 'My notes here' });
  linkAgent(id, 'inject-agent');
  writeTasks('inject-agent', '- [ ] Existing task\n');

  injectProjectContext('inject-agent');

  const content = readTasks('inject-agent');
  assert.ok(content.includes('## Project: Inject Project'), 'project header missing');
  assert.ok(content.includes('My notes here'), 'notes missing');
  assert.ok(content.includes('- [ ] Existing task'), 'existing task should be preserved');
});

test('injectProjectContext is a no-op for unlinked agents', () => {
  initDb(':memory:');
  writeTasks('unlinked-agent', '- [ ] Solo task\n');
  injectProjectContext('unlinked-agent');
  const content = readTasks('unlinked-agent');
  assert.ok(!content.includes('## Project:'), 'should not inject project block');
  assert.ok(content.includes('- [ ] Solo task'), 'existing content must be preserved');
});

test('injectProjectContext includes last_summary when present', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Summary Project', notes: 'notes' });
  updateProject(id, { last_summary: 'Session ended at step 5' });
  linkAgent(id, 'summary-agent');
  writeTasks('summary-agent', '');
  injectProjectContext('summary-agent');
  const content = readTasks('summary-agent');
  assert.ok(content.includes('Session ended at step 5'), 'last_summary missing');
});

test('injectProjectContext does not double-inject on second call', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Double Project', notes: 'once' });
  linkAgent(id, 'double-agent');
  writeTasks('double-agent', '- [ ] task\n');
  injectProjectContext('double-agent');
  injectProjectContext('double-agent');
  const content = readTasks('double-agent');
  const count = (content.match(/## Project:/g) ?? []).length;
  assert.equal(count, 1, 'project header injected more than once');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/projects.test.js
```

Expected: the new 4 tests fail — `injectProjectContext` not exported from terminal.js yet.

- [ ] **Step 3: Modify `dashboard/terminal.js`**

Read `dashboard/terminal.js`. Replace the entire file with:

```js
import pty from 'node-pty';
import { watch, existsSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { getAgent, setAgentStatus, broadcastToAgent } from './agents.js';
import { writeUsage } from './db.js';
import { readTasks, writeTasks } from './tasks.js';
import { getProjectForAgent, updateProject } from './projects.js';

const COST_REGEX = /Total cost:\s+\$?([\d.]+)/i;
const MODEL_REGEX = /Model:\s+(\S+)/i;
const MAX_SUMMARY_LINES = 50;

export function injectProjectContext(agentName) {
  const project = getProjectForAgent(agentName);
  if (!project) return;

  const block = [
    `## Project: ${project.name}`,
    `### Notes`,
    project.notes || '(none)',
    ...(project.last_summary ? [`### Last session`, project.last_summary] : []),
    '---',
    '',
  ].join('\n');

  const existing = readTasks(agentName);
  // Strip any previously injected project block before re-injecting
  const cleaned = existing.replace(/^## Project:[\s\S]*?---\n\n?/, '');
  writeTasks(agentName, block + '\n' + cleaned);
}

export function spawnAgent(name, workdir, model) {
  const agent = getAgent(name);
  if (!agent) throw new Error(`Agent "${name}" not registered`);
  if (agent.ptyProcess) throw new Error(`Agent "${name}" already has a running process`);

  // Inject project context into task file before spawning
  injectProjectContext(name);

  const args = ['--dangerously-skip-permissions'];
  if (model) args.push('--model', model);

  const ptyProcess = pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: workdir,
    env: process.env,
  });

  agent.ptyProcess = ptyProcess;
  setAgentStatus(name, 'running');

  let lastModel = 'claude';
  let lastCost = 0;
  const outputBuffer = [];

  ptyProcess.onData((data) => {
    broadcastToAgent(name, { type: 'output', agent: name, data });

    // Rolling output buffer for session summary
    const lines = data.split('\n');
    outputBuffer.push(...lines);
    if (outputBuffer.length > MAX_SUMMARY_LINES) {
      outputBuffer.splice(0, outputBuffer.length - MAX_SUMMARY_LINES);
    }

    const modelMatch = data.match(MODEL_REGEX);
    if (modelMatch) lastModel = modelMatch[1];

    const costMatch = data.match(COST_REGEX);
    if (costMatch) {
      const delta = parseFloat(costMatch[1]) - lastCost;
      if (delta > 0) {
        writeUsage({ agentName: name, model: lastModel, costUsd: delta });
        lastCost = parseFloat(costMatch[1]);
      }
    }
  });

  ptyProcess.onExit(() => {
    // Save last session output as summary on linked project
    const project = getProjectForAgent(name);
    if (project && outputBuffer.length > 0) {
      updateProject(project.id, { last_summary: outputBuffer.join('\n') });
    }

    agent.ptyProcess = null;
    lastCost = 0;
    setAgentStatus(name, 'stopped');
  });

  return ptyProcess;
}

export function writeToAgent(name, data) {
  const agent = getAgent(name);
  if (agent?.ptyProcess) {
    agent.ptyProcess.write(data);
  }
}

export function observeLogFile(name, logPath) {
  if (!existsSync(logPath)) writeFileSync(logPath, '', 'utf8');

  let lastSize = statSync(logPath).size;

  const watcher = watch(logPath, () => {
    try {
      const newSize = statSync(logPath).size;
      if (newSize <= lastSize) return;
      const length = newSize - lastSize;
      const fd = openSync(logPath, 'r');
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, lastSize);
      closeSync(fd);
      lastSize = newSize;
      broadcastToAgent(name, { type: 'output', agent: name, data: buf.toString('utf8') });
    } catch {
      // file may be temporarily locked — skip this tick
    }
  });

  const agent = getAgent(name);
  if (agent) {
    agent.watcher = watcher;
    setAgentStatus(name, 'running');
  }
}
```

- [ ] **Step 4: Run all tests to verify they pass**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js
```

Expected: all pass (37 prior + 4 new = 41 total).

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add dashboard/terminal.js dashboard/tests/projects.test.js
git commit -m "feat(pm): session continuity — injectProjectContext on spawn, summary capture on exit"
```

---

### Task 4: Dashboard UI — Projects tab

**Files:**
- Modify: `dashboard/public/index.html`
- Modify: `dashboard/public/app.js`
- Modify: `dashboard/public/style.css`

No automated tests (plain browser JS, no build step). Verify manually by running the dashboard.

**Interfaces:**
- Consumes: `GET /projects`, `POST /projects`, `PATCH /projects/:id`, `DELETE /projects/:id`, `POST /projects/:id/agents`, `DELETE /projects/:id/agents/:agentName`, `GET /agents`
- Produces: Projects tab in dashboard with card grid, new project modal, edit project modal

- [ ] **Step 1: Read all three files**

Read `dashboard/public/index.html`, `dashboard/public/app.js`, and `dashboard/public/style.css` before editing.

- [ ] **Step 2: Update `dashboard/public/index.html`**

**2a:** Add Projects button to the header. In the `<div class="header-left">`, after `<span id="agent-count">0 agents</span>`, add:

```html
      <button id="btn-projects" style="margin-left:12px;background:none;border:1px solid #30363d;color:#e6edf3;padding:2px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Projects</button>
```

**2b:** Add project view container. After `<div id="panels"></div>`, add:

```html
  <div id="project-view" class="hidden"></div>
```

**2c:** Add New Project modal. After the existing `#modal` closing `</div>`, add:

```html
  <div id="proj-modal" class="hidden" role="dialog" aria-modal="true">
    <div class="modal-box">
      <h2>New Project</h2>
      <label>Name<input id="proj-modal-name" type="text" placeholder="My Project" autocomplete="off"></label>
      <label>Notes<textarea id="proj-modal-notes" rows="4" placeholder="Project context and goals…" style="width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:8px;font-family:inherit;resize:vertical"></textarea></label>
      <div class="modal-actions">
        <button id="proj-modal-cancel">Cancel</button>
        <button id="proj-modal-create">Create</button>
      </div>
    </div>
  </div>

  <div id="edit-proj-modal" class="hidden" role="dialog" aria-modal="true">
    <div class="modal-box" style="max-width:500px">
      <h2 id="edit-proj-title">Edit Project</h2>
      <input type="hidden" id="edit-proj-id">
      <label>Name<input id="edit-proj-name" type="text" autocomplete="off"></label>
      <label>Status
        <select id="edit-proj-status">
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="done">done</option>
          <option value="archived">archived</option>
        </select>
      </label>
      <label>Notes<textarea id="edit-proj-notes" rows="5" style="width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:8px;font-family:inherit;resize:vertical"></textarea></label>
      <div>
        <h4 style="margin:12px 0 6px">Last Session Summary</h4>
        <pre id="edit-proj-summary" style="background:#161b22;padding:8px;border-radius:4px;font-size:11px;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;color:#8b949e">(none)</pre>
      </div>
      <div>
        <h4 style="margin:12px 0 6px">Linked Agents</h4>
        <div id="edit-proj-agents"></div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <select id="edit-proj-agent-select" style="flex:1;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:4px"></select>
          <button id="edit-proj-link-btn">Link</button>
        </div>
      </div>
      <div class="modal-actions">
        <button id="edit-proj-cancel">Cancel</button>
        <button id="edit-proj-save">Save</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Add project styles to `dashboard/public/style.css`**

Append to the end of `style.css`:

```css
/* --- Projects tab --- */
#project-view {
  padding: 16px;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
@media (max-width: 1079px) {
  #project-view { grid-template-columns: 1fr; }
}
.project-card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 14px 16px;
}
.project-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.project-card-name { font-weight: 600; font-size: 14px; }
.badge-active    { background: #1a4731; color: #3fb950; }
.badge-paused    { background: #3d2b00; color: #d29922; }
.badge-done      { background: #0c2d6b; color: #58a6ff; }
.badge-archived  { background: #21262d; color: #8b949e; }
.project-card-meta { font-size: 12px; color: #8b949e; margin: 4px 0; }
.project-card-notes {
  font-size: 12px;
  color: #c9d1d9;
  margin-top: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 60px;
  overflow: hidden;
}
.project-card-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.btn-edit {
  background: none;
  border: 1px solid #30363d;
  color: #58a6ff;
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
#proj-toolbar {
  display: none;
  padding: 8px 16px;
  border-bottom: 1px solid #21262d;
}
```

- [ ] **Step 4: Add Projects tab logic to `dashboard/public/app.js`**

Append the following block to the END of `app.js` (before the final `connect();` line — move `connect();` to the very end):

```js
// ============================================================
// Projects tab
// ============================================================

let currentView = 'agents';

function showView(view) {
  currentView = view;
  const panels    = document.getElementById('panels');
  const toolbar   = document.getElementById('toolbar');
  const projView  = document.getElementById('project-view');
  const projBar   = document.getElementById('proj-toolbar');
  if (view === 'projects') {
    panels.style.display   = 'none';
    toolbar.style.display  = 'none';
    projView.classList.remove('hidden');
    if (projBar) projBar.style.display = 'flex';
    fetchProjects();
  } else {
    panels.style.display   = '';
    toolbar.style.display  = '';
    projView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
  }
}

async function fetchProjects() {
  try {
    const res = await fetch('/projects');
    const projects = await res.json();
    renderProjects(projects);
  } catch { /* silent fail */ }
}

function renderProjects(projects) {
  const view = document.getElementById('project-view');
  // Clear existing cards but keep the "New Project" button if injected
  view.innerHTML = `
    <div style="grid-column:1/-1;display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0;font-size:15px">Projects</h3>
      <button id="btn-new-project" style="background:#238636;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px">+ New Project</button>
    </div>
  `;
  document.getElementById('btn-new-project').addEventListener('click', openNewProjectModal);

  if (!projects.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'grid-column:1/-1;color:#8b949e;text-align:center;padding:40px';
    empty.textContent = 'No active projects. Create one to get started.';
    view.appendChild(empty);
    return;
  }

  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'project-card';
    const agentStr = p.agents.length ? p.agents.join(', ') : '(no agents)';
    const notesSnip = (p.notes || '').slice(0, 120) + ((p.notes || '').length > 120 ? '…' : '');
    card.innerHTML = `
      <div class="project-card-header">
        <span class="project-card-name">${escHtml(p.name)}</span>
        <span class="badge badge-${p.status}">${p.status}</span>
      </div>
      <div class="project-card-meta">Agents: ${escHtml(agentStr)}</div>
      <div class="project-card-meta">Week: $${p.costWeek.toFixed(4)} &nbsp; Month: $${p.costMonth.toFixed(4)}</div>
      ${notesSnip ? `<div class="project-card-notes">${escHtml(notesSnip)}</div>` : ''}
      <div class="project-card-footer">
        <button class="btn-edit" data-proj-id="${p.id}">Edit</button>
      </div>
    `;
    card.querySelector('[data-proj-id]').addEventListener('click', () => openEditProjectModal(p.id));
    view.appendChild(card);
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- New Project modal ---
function openNewProjectModal() {
  document.getElementById('proj-modal-name').value = '';
  document.getElementById('proj-modal-notes').value = '';
  document.getElementById('proj-modal').classList.remove('hidden');
  document.getElementById('proj-modal-name').focus();
}

document.getElementById('proj-modal-cancel').addEventListener('click', () => {
  document.getElementById('proj-modal').classList.add('hidden');
});
document.getElementById('proj-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('proj-modal'))
    document.getElementById('proj-modal').classList.add('hidden');
});
document.getElementById('proj-modal-create').addEventListener('click', async () => {
  const name  = document.getElementById('proj-modal-name').value.trim();
  const notes = document.getElementById('proj-modal-notes').value.trim();
  if (!name) return;
  await fetch('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, notes }),
  });
  document.getElementById('proj-modal').classList.add('hidden');
  fetchProjects();
});

// --- Edit Project modal ---
async function openEditProjectModal(projectId) {
  const res = await fetch(`/projects/${projectId}`);
  const p   = await res.json();

  document.getElementById('edit-proj-id').value      = p.id;
  document.getElementById('edit-proj-title').textContent = `Edit: ${p.name}`;
  document.getElementById('edit-proj-name').value    = p.name;
  document.getElementById('edit-proj-status').value  = p.status;
  document.getElementById('edit-proj-notes').value   = p.notes || '';
  document.getElementById('edit-proj-summary').textContent = p.last_summary || '(none)';

  // Linked agents
  const agentsDiv = document.getElementById('edit-proj-agents');
  agentsDiv.innerHTML = '';
  for (const agentName of p.agents) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:2px 0';
    row.innerHTML = `<span style="font-size:13px">${escHtml(agentName)}</span>
      <button style="background:none;border:none;color:#f85149;cursor:pointer;font-size:12px" data-unlink="${escHtml(agentName)}">×</button>`;
    row.querySelector('[data-unlink]').addEventListener('click', async () => {
      await fetch(`/projects/${p.id}/agents/${agentName}`, { method: 'DELETE' });
      openEditProjectModal(p.id);
    });
    agentsDiv.appendChild(row);
  }

  // Agent dropdown for linking
  const agentSelect = document.getElementById('edit-proj-agent-select');
  agentSelect.innerHTML = '<option value="">Select agent…</option>';
  try {
    const agentRes = await fetch('/agents');
    const agents   = await agentRes.json();
    for (const a of agents) {
      if (!p.agents.includes(a.name)) {
        const opt = document.createElement('option');
        opt.value = a.name;
        opt.textContent = a.name;
        agentSelect.appendChild(opt);
      }
    }
  } catch { /* agent list unavailable */ }

  document.getElementById('edit-proj-modal').classList.remove('hidden');
}

document.getElementById('edit-proj-cancel').addEventListener('click', () => {
  document.getElementById('edit-proj-modal').classList.add('hidden');
});
document.getElementById('edit-proj-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('edit-proj-modal'))
    document.getElementById('edit-proj-modal').classList.add('hidden');
});
document.getElementById('edit-proj-save').addEventListener('click', async () => {
  const id     = Number(document.getElementById('edit-proj-id').value);
  const name   = document.getElementById('edit-proj-name').value.trim();
  const status = document.getElementById('edit-proj-status').value;
  const notes  = document.getElementById('edit-proj-notes').value;
  if (!name) return;
  await fetch(`/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, status, notes }),
  });
  document.getElementById('edit-proj-modal').classList.add('hidden');
  fetchProjects();
});
document.getElementById('edit-proj-link-btn').addEventListener('click', async () => {
  const id        = Number(document.getElementById('edit-proj-id').value);
  const agentName = document.getElementById('edit-proj-agent-select').value;
  if (!agentName) return;
  await fetch(`/projects/${id}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName }),
  });
  openEditProjectModal(id);
});

// Projects tab button
document.getElementById('btn-projects').addEventListener('click', () => {
  if (currentView === 'projects') {
    showView('agents');
    document.getElementById('btn-projects').textContent = 'Projects';
  } else {
    showView('projects');
    document.getElementById('btn-projects').textContent = '← Agents';
  }
});
```

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add dashboard/public/index.html dashboard/public/app.js dashboard/public/style.css
git commit -m "feat(pm): Projects tab — card grid, new project modal, edit modal with agent linking"
```

---

### Task 5: CLI — `project` subcommand group in `bin/flint.js`

**Files:**
- Modify: `bin/flint.js`

No automated tests (calls live dashboard at port 3000). Verify via syntax check.

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /projects` and `/projects/:id/agents` on `http://localhost:3000`
- Produces subcommands: `project list`, `project create`, `project status`, `project notes`, `project link`, `project unlink`

- [ ] **Step 1: Read `bin/flint.js`**

Read the full file before editing.

- [ ] **Step 2: Add dashboard helpers and project subcommand to `bin/flint.js`**

After the existing `const ROUTER_URL = ...` line, add:

```js
const DASHBOARD_URL = process.env.FLINT_DASHBOARD_URL ?? 'http://localhost:3000';

async function dashGet(path) {
  const res = await fetch(`${DASHBOARD_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function dashPost(path, body) {
  const res = await fetch(`${DASHBOARD_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

async function dashPatch(path, body) {
  const res = await fetch(`${DASHBOARD_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

async function dashDelete(path) {
  const res = await fetch(`${DASHBOARD_URL}${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  return res.json();
}
```

Then add the project command functions (add these before the `const COMMANDS = ...` line):

```js
async function cmdProject(args) {
  const [sub, ...rest] = args;
  const subs = {
    list:   cmdProjectList,
    create: cmdProjectCreate,
    status: cmdProjectStatus,
    notes:  cmdProjectNotes,
    link:   cmdProjectLink,
    unlink: cmdProjectUnlink,
  };
  const fn = subs[sub];
  if (!fn) {
    console.error('Usage: flint project <list|create|status|notes|link|unlink>');
    process.exit(1);
  }
  return fn(rest);
}

async function cmdProjectList() {
  const projects = await dashGet('/projects');
  if (!projects.length) { console.log('No active projects.'); return; }
  for (const p of projects) {
    const agents = p.agents.length ? p.agents.join(', ') : '(none)';
    console.log(`[${p.id}] ${p.name} [${p.status}] | agents: ${agents} | week: $${p.costWeek.toFixed(4)} | month: $${p.costMonth.toFixed(4)}`);
    if (p.notes) console.log(`      ${p.notes.slice(0, 80).replace(/\n/g, ' ')}`);
  }
}

async function cmdProjectCreate(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { notes: { type: 'string', short: 'n' } },
    allowPositionals: true,
  });
  const name = positionals.join(' ');
  if (!name) { console.error('Usage: flint project create "name" [--notes "..."]'); process.exit(1); }
  const proj = await dashPost('/projects', { name, notes: values.notes ?? '' });
  console.log(`Created project [${proj.id}]: ${proj.name}`);
}

async function cmdProjectStatus(args) {
  const [id, status] = args;
  if (!id || !status) { console.error('Usage: flint project status <id> active|paused|done|archived'); process.exit(1); }
  await dashPatch(`/projects/${id}`, { status });
  console.log(`Project ${id} status → ${status}`);
}

async function cmdProjectNotes(args) {
  const [id, ...noteParts] = args;
  const notes = noteParts.join(' ');
  if (!id || !notes) { console.error('Usage: flint project notes <id> "text"'); process.exit(1); }
  await dashPatch(`/projects/${id}`, { notes });
  console.log(`Project ${id} notes updated.`);
}

async function cmdProjectLink(args) {
  const [id, agentName] = args;
  if (!id || !agentName) { console.error('Usage: flint project link <id> <agent-name>'); process.exit(1); }
  await dashPost(`/projects/${id}/agents`, { agentName });
  console.log(`Linked agent "${agentName}" to project ${id}.`);
}

async function cmdProjectUnlink(args) {
  const [id, agentName] = args;
  if (!id || !agentName) { console.error('Usage: flint project unlink <id> <agent-name>'); process.exit(1); }
  await dashDelete(`/projects/${id}/agents/${agentName}`);
  console.log(`Unlinked agent "${agentName}" from project ${id}.`);
}
```

Add `project: cmdProject` to the `COMMANDS` object:

```js
const COMMANDS = { ask: cmdAsk, models: cmdModels, config: cmdConfig, costs: cmdCosts, project: cmdProject };
```

- [ ] **Step 3: Syntax check**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
node --check bin/flint.js
```

Expected: no output (clean syntax check).

- [ ] **Step 4: Run full test suite one final time**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add bin/flint.js
git commit -m "feat(cli): project subcommand — list, create, status, notes, link, unlink"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `projects` + `project_agents` tables in usage.sqlite | Task 1 (db.js) |
| `listProjects()` excludes archived, ordered by updated_at | Task 1 (projects.js) |
| `getProject()`, `createProject()`, `updateProject()` | Task 1 (projects.js) |
| `linkAgent()`, `unlinkAgent()`, `getProjectForAgent()` | Task 1 (projects.js) |
| Cost aggregation (week/month) per project via usage JOIN | Task 1 (projects.js::projectCost) |
| GET/POST/PATCH/DELETE /projects routes | Task 2 (server.js) |
| POST/DELETE /projects/:id/agents routes | Task 2 (server.js) |
| GET /projects/:id route | Task 2 (server.js) |
| `injectProjectContext()` — prepend project block to task file | Task 3 (terminal.js) |
| Double-inject guard | Task 3 (terminal.js regex strip) |
| Rolling output buffer (50 lines) | Task 3 (terminal.js outputBuffer) |
| last_summary saved on PTY exit | Task 3 (terminal.js onExit) |
| Projects tab button in header | Task 4 (index.html) |
| Card grid with name, status, agents, cost, notes snippet | Task 4 (app.js) |
| New Project modal | Task 4 (app.js) |
| Edit modal: name, status, notes, summary (read-only), agent list | Task 4 (app.js) |
| Unlink agents from edit modal | Task 4 (app.js) |
| Link agent from edit modal (dropdown from GET /agents) | Task 4 (app.js) |
| CLI: project list, create, status, notes, link, unlink | Task 5 (bin/flint.js) |
| CLI calls port 3000 (dashboard), not 3001 | Task 5 (DASHBOARD_URL) |
| ~30+ dashboard tests; existing 20 unaffected | Tasks 1-3 (41 total) |

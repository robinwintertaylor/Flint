# SP7c: Flint Orchestrator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A special "Orchestrator" spawn mode: you give Flint a goal, it spawns a Claude Code agent with an injected task file containing the goal, a guide to the Flint REST API (curl commands), and a shared scratchpad path. The orchestrator agent autonomously plans, spawns typed worker agents via curl, assigns them tasks, monitors progress, and synthesises results. Workers get a context block prepended to their task file when assigned.

**Architecture:** `dashboard/orchestrator.js` creates the `orchestrations` DB row, writes the scratchpad file, builds the injected task file, registers the agent, and calls `spawnAgent`. When `assignQueueTask` (SP7b) detects a task created by an orchestrator agent, it queries the `orchestrations` table and prepends a worker-context block — this already works in SP7b because the query is wrapped in try/catch. SP7c simply adds the table. REST routes expose orchestration CRUD and scratchpad access. The dashboard adds an Orchestrate toolbar button and scratchpad viewer in the agent's task sidebar.

**Tech Stack:** Node.js 20+, better-sqlite3, Express, node:test, node:assert/strict

## Global Constraints

- Requires SP7b deployed and running (queue poller and REST routes must exist)
- The orchestrator agent name is auto-generated: `orch-<id>` (e.g. `orch-1`)
- Orchestrator task file is written to `tasks/orch-<id>.md` via `writeTasks` before `spawnAgent` is called
- Scratchpad file path: `tasks/orch-<id>/scratchpad.md` (directory created by `createOrchestration`)
- `injectProjectContext` in terminal.js is a no-op for the orchestrator agent (it has no linked project)
- REST errors return `{ error: "..." }` with appropriate HTTP status
- Dashboard `orchAgents` map (`agentName → orchId`) populated from `orchestration_started` WS message
- Tests use `initDb(':memory:')` and a temp `FLINT_TASKS_DIR`; `FLINT_TEST_MODE=1` skips actual spawn

---

### Task 1: DB schema and orchestrator.js

**Files:**
- Modify: `dashboard/db.js` — add `orchestrations` table
- Create: `dashboard/orchestrator.js` — createOrchestration, context builders, scratchpad I/O
- Create: `dashboard/tests/orchestrator.test.js` — tests

**Interfaces:**
- Produces:
  - `createOrchestration({ goal, workdir, model?, projectId? }): { id, agentName, scratchpadPath }` — also spawns the agent
  - `getOrchestration(id: number): Row | undefined`
  - `listOrchestrations(): Row[]`
  - `updateOrchestrationStatus(id: number, status: string): void`
  - `buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath }): string`
  - `appendScratchpad(id: number, content: string): void`
  - `readScratchpad(id: number): string`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/orchestrator.test.js`:

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync } from 'fs';

const TEMP_TASKS = join(tmpdir(), `flint-orch-test-${Date.now()}`);
process.env.FLINT_TASKS_DIR = TEMP_TASKS;
process.env.FLINT_TEST_MODE = '1'; // skip actual PTY spawn

import { initDb } from '../db.js';
import {
  getOrchestration, listOrchestrations, updateOrchestrationStatus,
  buildOrchestratorTaskFile, appendScratchpad, readScratchpad,
} from '../orchestrator.js';

before(() => {
  initDb(':memory:');
  mkdirSync(TEMP_TASKS, { recursive: true });
});

test('initDb creates orchestrations table', () => {
  const db = initDb(':memory:');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('orchestrations'), 'orchestrations table missing');
});

test('listOrchestrations returns empty initially', () => {
  initDb(':memory:');
  assert.deepEqual(listOrchestrations(), []);
});

test('buildOrchestratorTaskFile contains goal and API guide', () => {
  const content = buildOrchestratorTaskFile({
    goal: 'Build a REST API with JWT auth',
    id: 1,
    workdir: 'C:\\Projects\\myapp',
    scratchpadPath: 'tasks/orch-1/scratchpad.md',
  });
  assert.ok(content.includes('Build a REST API with JWT auth'), 'goal missing');
  assert.ok(content.includes('http://localhost:3000'), 'API base URL missing');
  assert.ok(content.includes('tasks/orch-1/scratchpad.md'), 'scratchpad path missing');
  assert.ok(content.includes('POST /queue/tasks'), 'queue API guide missing');
  assert.ok(content.includes('POST /agents/spawn'), 'spawn API guide missing');
  assert.ok(content.includes('researcher'), 'worker roles missing');
});

test('appendScratchpad and readScratchpad work correctly', () => {
  initDb(':memory:');
  const db = initDb(':memory:');
  // Insert a row so we can test scratchpad I/O
  db.prepare('INSERT INTO orchestrations (id, goal, agent_name) VALUES (99, "test goal", "orch-99")').run();
  const dir = join(TEMP_TASKS, 'orch-99');
  mkdirSync(dir, { recursive: true });
  const scratchPath = join(dir, 'scratchpad.md');
  // Write initial content
  require('fs').writeFileSync(scratchPath, '# Orchestration: test goal\n\n## Plan\n\n', 'utf8');
  appendScratchpad(99, '\n## Findings\n\nResearcher found: OAuth2 works.\n');
  const content = readScratchpad(99);
  assert.ok(content.includes('Researcher found: OAuth2 works.'));
});

test('updateOrchestrationStatus changes status', () => {
  initDb(':memory:');
  const db = initDb(':memory:');
  db.prepare('INSERT INTO orchestrations (id, goal, agent_name, status) VALUES (42, "g", "orch-42", "running")').run();
  updateOrchestrationStatus(42, 'done');
  const row = getOrchestration(42);
  assert.equal(row.status, 'done');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd dashboard && node --test tests/orchestrator.test.js
```

Expected: FAIL with "Cannot find module '../orchestrator.js'"

- [ ] **Step 3: Add orchestrations table to db.js**

In `dashboard/db.js`, inside the `_db.exec(...)` string, add after the `task_queue` table:

```sql
    CREATE TABLE IF NOT EXISTS orchestrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      goal       TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      project_id INTEGER REFERENCES projects(id),
      status     TEXT NOT NULL DEFAULT 'running',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
```

- [ ] **Step 4: Create dashboard/orchestrator.js**

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getDb } from './db.js';
import { writeTasks } from './tasks.js';
import { registerAgent } from './agents.js';
import { spawnAgent } from './terminal.js';
import { broadcastGlobal } from './agents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const TASKS_DIR  = process.env.FLINT_TASKS_DIR ?? join(FLINT_ROOT, 'tasks');

export function getOrchestration(id) {
  return getDb().prepare('SELECT * FROM orchestrations WHERE id = ?').get(id);
}

export function listOrchestrations() {
  return getDb().prepare('SELECT * FROM orchestrations ORDER BY id DESC').all();
}

export function updateOrchestrationStatus(id, status) {
  getDb().prepare('UPDATE orchestrations SET status = ? WHERE id = ?').run(status, id);
}

export function buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath }) {
  return `## Orchestration Goal
${goal}

## Your Role — Orchestrator
You are the Flint Orchestrator. Your job:
1. Read the goal above and think through what needs to happen.
2. Write your plan to the shared scratchpad.
3. Create queue tasks and spawn typed worker agents to execute each part.
4. Monitor progress by checking the task queue and scratchpad.
5. When all tasks are done, synthesise the results in the scratchpad under ## Synthesis.

## Shared Scratchpad
Path: ${scratchpadPath}
Write your plan there first. Workers will append findings under ## Findings.
Read it to track progress. Write your final synthesis under ## Synthesis.

## Flint REST API
Base URL: http://localhost:3000

### Spawn a worker agent
\`\`\`
curl -s -X POST http://localhost:3000/agents/spawn \\
  -H "Content-Type: application/json" \\
  -d '{"name":"<agent-name>","workdir":"${workdir.replace(/\\/g, '\\\\')}","runtime":"claude"}'
\`\`\`

### Create a task and assign it to a worker
\`\`\`
curl -s -X POST http://localhost:3000/queue/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title":"<title>","description":"<desc>","assigned_to":"<agent-name>","role":"researcher","created_by":"orch-${id}"}'
\`\`\`

### Check task queue progress
\`\`\`
curl -s "http://localhost:3000/queue/tasks?created_by=orch-${id}"
\`\`\`

### Mark a task done with result
\`\`\`
curl -s -X PATCH http://localhost:3000/queue/tasks/<id> \\
  -H "Content-Type: application/json" \\
  -d '{"status":"done","result":"<summary>"}'
\`\`\`

### Append synthesis to scratchpad
\`\`\`
curl -s -X POST http://localhost:3000/orchestrations/${id}/scratchpad \\
  -H "Content-Type: application/json" \\
  -d '{"content":"\\n## Synthesis\\n\\n<your synthesis here>"}'
\`\`\`

## Worker Roles
- **researcher**: investigates, reads docs, surveys prior art
- **planner**: designs architecture, data models, API contracts
- **builder**: writes code and commits it
- **tester**: writes tests, runs them, reports results

## Suggested Flow
1. Write plan to scratchpad.
2. Spawn a researcher and assign it a research task (created_by="orch-${id}").
3. When research tasks are done (poll queue), spawn planner + builder.
4. When builder finishes, spawn tester.
5. Read all findings from scratchpad, write synthesis, then your work is complete.
`;
}

export function appendScratchpad(id, content) {
  const path = join(TASKS_DIR, `orch-${id}`, 'scratchpad.md');
  if (!existsSync(path)) return;
  const existing = readFileSync(path, 'utf8');
  writeFileSync(path, existing + content, 'utf8');
}

export function readScratchpad(id) {
  const path = join(TASKS_DIR, `orch-${id}`, 'scratchpad.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

export function createOrchestration({ goal, workdir, model, projectId } = {}) {
  if (!goal || !workdir) throw new Error('goal and workdir required');

  const db = getDb();
  const r = db.prepare(
    'INSERT INTO orchestrations (goal, agent_name, project_id) VALUES (?, ?, ?)'
  ).run(goal, 'placeholder', projectId ?? null);
  const id = r.lastInsertRowid;
  const agentName = `orch-${id}`;
  db.prepare('UPDATE orchestrations SET agent_name = ? WHERE id = ?').run(agentName, id);

  // Create scratchpad directory + file
  const orchDir = join(TASKS_DIR, `orch-${id}`);
  if (!existsSync(orchDir)) mkdirSync(orchDir, { recursive: true });
  const scratchpadPath = `tasks/orch-${id}/scratchpad.md`;
  const absPath = join(orchDir, 'scratchpad.md');
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  writeFileSync(absPath, `# Orchestration: ${goal}\n\nStarted: ${timestamp}\n\n## Plan\n\n## Findings\n\n## Synthesis\n`, 'utf8');

  // Write orchestrator task file
  writeTasks(agentName, buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath }));

  // Register and spawn the orchestrator agent
  registerAgent(agentName, 'spawn', workdir, null, model ?? '', 'claude');

  const TEST_MODE = process.env.FLINT_TEST_MODE === '1';
  if (!TEST_MODE) {
    spawnAgent(agentName, workdir, model ?? null, {});
  }

  broadcastGlobal({ type: 'orchestration_started', id, agentName, goal });

  return { id, agentName, scratchpadPath };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd dashboard && node --test tests/orchestrator.test.js
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/db.js dashboard/orchestrator.js dashboard/tests/orchestrator.test.js
git commit -m "feat(sp7c): add orchestrations table and orchestrator.js (context builder, scratchpad, spawn)"
```

---

### Task 2: REST routes for orchestrations

**Files:**
- Modify: `dashboard/server.js` — import orchestrator.js, add 5 routes
- Modify: `dashboard/tests/server.test.js` — add orchestration route tests

**Interfaces:**
- Consumes: `createOrchestration, getOrchestration, listOrchestrations, appendScratchpad, readScratchpad` from `./orchestrator.js`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/server.test.js`:

```js
test('GET /orchestrations returns empty array initially', async () => {
  const r = await req('GET', '/orchestrations');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('POST /orchestrations creates orchestration and spawns agent (test mode skips spawn)', async () => {
  const r = await req('POST', '/orchestrations', {
    goal: 'Build a simple CLI tool',
    workdir: process.cwd(),
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok(body.id, 'id missing');
  assert.ok(body.agentName.startsWith('orch-'), 'agentName should start with orch-');
  assert.equal(body.goal, 'Build a simple CLI tool');
});

test('POST /orchestrations with missing goal returns 400', async () => {
  const r = await req('POST', '/orchestrations', { workdir: process.cwd() });
  assert.equal(r.status, 400);
});

test('GET /orchestrations/:id returns the orchestration', async () => {
  const created = await req('POST', '/orchestrations', {
    goal: 'Fetch test goal', workdir: process.cwd(),
  }).then(r => r.json());
  const r = await req('GET', `/orchestrations/${created.id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.goal, 'Fetch test goal');
});

test('GET /orchestrations/:id/scratchpad returns scratchpad content', async () => {
  const created = await req('POST', '/orchestrations', {
    goal: 'Scratchpad test', workdir: process.cwd(),
  }).then(r => r.json());
  const r = await req('GET', `/orchestrations/${created.id}/scratchpad`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(typeof body.content === 'string', 'content should be a string');
  assert.ok(body.content.includes('Scratchpad test'), 'scratchpad should contain goal');
});

test('POST /orchestrations/:id/scratchpad appends content', async () => {
  const created = await req('POST', '/orchestrations', {
    goal: 'Append test', workdir: process.cwd(),
  }).then(r => r.json());
  await req('POST', `/orchestrations/${created.id}/scratchpad`, { content: '\nAppended line.\n' });
  const r = await req('GET', `/orchestrations/${created.id}/scratchpad`);
  const body = await r.json();
  assert.ok(body.content.includes('Appended line.'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd dashboard && node --test tests/server.test.js 2>&1 | grep -E "FAIL|404" | head -5
```

Expected: FAIL with 404 on `/orchestrations`

- [ ] **Step 3: Add import and routes to server.js**

In `dashboard/server.js`, add to the imports block:

```js
import { createOrchestration, getOrchestration, listOrchestrations, appendScratchpad, readScratchpad } from './orchestrator.js';
```

After the queue routes, add:

```js
  // --- Orchestration routes ---

  app.get('/orchestrations', (_req, res) => res.json(listOrchestrations()));

  app.get('/orchestrations/:id', (req, res) => {
    const orch = getOrchestration(Number(req.params.id));
    if (!orch) return res.status(404).json({ error: 'orchestration not found' });
    res.json(orch);
  });

  app.post('/orchestrations', (req, res) => {
    const { goal, workdir, model, project_id } = req.body ?? {};
    if (!goal || !workdir) return res.status(400).json({ error: 'goal and workdir required' });
    try {
      const result = createOrchestration({ goal, workdir, model, projectId: project_id });
      res.status(201).json({ ...result, goal, status: 'running' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/orchestrations/:id/scratchpad', (req, res) => {
    const orch = getOrchestration(Number(req.params.id));
    if (!orch) return res.status(404).json({ error: 'orchestration not found' });
    res.json({ content: readScratchpad(Number(req.params.id)) });
  });

  app.post('/orchestrations/:id/scratchpad', (req, res) => {
    const orch = getOrchestration(Number(req.params.id));
    if (!orch) return res.status(404).json({ error: 'orchestration not found' });
    const { content } = req.body ?? {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    appendScratchpad(Number(req.params.id), content);
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd dashboard && node --test tests/server.test.js
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/server.js dashboard/tests/server.test.js
git commit -m "feat(sp7c): add orchestration REST routes (CRUD + scratchpad)"
```

---

### Task 3: Dashboard UI — Orchestrate modal, orch/worker badges, scratchpad viewer

**Files:**
- Modify: `dashboard/public/index.html` — Orchestrate toolbar button, modal
- Modify: `dashboard/public/app.js` — modal wiring, `orchestration_started` WS handler, `orchAgents` map, scratchpad poller in sidebar, orch/worker panel badges
- Modify: `dashboard/public/style.css` — `badge-orch`, `badge-worker`, scratchpad styles

*No automated test — verify manually in the browser.*

- [ ] **Step 1: Add CSS to style.css**

Append to `dashboard/public/style.css`:

```css
/* Orchestrator badges */
.badge-orch {
  background: #2d1f5e; color: #bf91f3;
  font-size: 10px; padding: 1px 6px; border-radius: 10px; margin-left: 4px;
}
.badge-worker {
  background: #1a3f6e; color: #58a6ff;
  font-size: 10px; padding: 1px 6px; border-radius: 10px; margin-left: 4px;
}

/* Scratchpad section in task sidebar */
.scratchpad-section { margin-top: 10px; border-top: 1px solid #30363d; padding-top: 8px; }
.scratchpad-section h4 { color: #58a6ff; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; cursor: pointer; }
.scratchpad-content {
  font-size: 10px; color: #8b949e; white-space: pre-wrap; word-break: break-word;
  max-height: 180px; overflow-y: auto; background: #0d1117;
  padding: 6px 8px; border-radius: 4px; border: 1px solid #21262d;
  display: none;
}
.scratchpad-content.open { display: block; }
```

- [ ] **Step 2: Add toolbar button and Orchestrate modal to index.html**

In `<div id="toolbar">`, after `⬡ Queue` button:

```html
    <button id="btn-orchestrate">⬡ Orchestrate</button>
```

After the Add Task modal closing `</div>`, add:

```html
  <!-- Orchestrate modal -->
  <div id="orch-modal" class="hidden" role="dialog" aria-modal="true">
    <div class="modal-box" style="max-width:480px">
      <h2>Orchestrate a Goal</h2>
      <label>Goal (required)
        <textarea id="orch-goal" rows="3" placeholder="Build a REST API with JWT auth and a React frontend…" style="width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:8px;font-family:inherit;resize:vertical"></textarea>
      </label>
      <label>
        Workspace
        <select id="orch-workspace">
          <option value="">— manual entry —</option>
        </select>
      </label>
      <label>Working Directory
        <input id="orch-workdir" type="text" placeholder="C:\Users\Robin\Applications Dev\Flint" autocomplete="off">
      </label>
      <label>Project (optional)
        <select id="orch-project">
          <option value="">None</option>
        </select>
      </label>
      <label>Model (optional)
        <select id="orch-model">
          <option value="">Default</option>
        </select>
      </label>
      <div class="modal-actions">
        <button id="orch-cancel">Cancel</button>
        <button id="orch-spawn" style="background:#6e40c9;color:#fff;border:none">Spawn Orchestrator</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Add orchestration JS to app.js**

At the top of `app.js`, after the `const taskContent = {};` line, add:

```js
const orchAgents = {}; // agentName → orchId
```

In the WS `switch (msg.type)` block, add a new case:

```js
      case 'orchestration_started':
        orchAgents[msg.agentName] = msg.id;
        // Panel may already exist (ensurePanel from agents list); add orch badge if so
        addOrchBadge(msg.agentName);
        break;
```

Update `ensurePanel` to accept `role` and render orch/worker badges. Find the `runtimeBadge` line and extend:

```js
function ensurePanel({ name, mode, status, isolate, runtime, role }) {
  if (document.getElementById(`panel-${name}`)) return;

  const runtimeBadge = (runtime && runtime !== 'claude')
    ? `<span class="badge badge-vibe" id="runtime-badge-${escHtml(name)}">vibe</span>`
    : '';
  const roleBadge = role === 'orchestrator'
    ? `<span class="badge badge-orch" id="role-badge-${escHtml(name)}">orch</span>`
    : role === 'worker'
    ? `<span class="badge badge-worker" id="role-badge-${escHtml(name)}">worker</span>`
    : '';

  // ... rest of ensurePanel unchanged, add roleBadge in the header HTML:
  // ${runtimeBadge}${roleBadge}
```

Find the panel innerHTML and add `${roleBadge}` after `${runtimeBadge}`:

```js
        ${mode === 'observe' ? '<span class="badge badge-observe">observe</span>' : ''}
        ${runtimeBadge}${roleBadge}
        ${isolate ? `<span class="badge badge-isolated" id="isolated-badge-${escHtml(name)}">isolated</span>` : ''}
```

Add a helper that adds the orch badge after a panel is already created:

```js
function addOrchBadge(agentName) {
  const nameEl = document.querySelector(`#panel-${escHtml(agentName)} .panel-name`);
  if (!nameEl) return;
  const existing = document.getElementById(`role-badge-${escHtml(agentName)}`);
  if (existing) return;
  const badge = document.createElement('span');
  badge.className = 'badge badge-orch';
  badge.id = `role-badge-${escHtml(agentName)}`;
  badge.textContent = 'orch';
  nameEl.after(badge);
  // Add scratchpad viewer to the task sidebar
  addScratchpadViewer(agentName, orchAgents[agentName]);
}

function addScratchpadViewer(agentName, orchId) {
  const sidebar = document.querySelector(`#panel-${escHtml(agentName)} .task-sidebar`);
  if (!sidebar || document.getElementById(`scratchpad-${escHtml(agentName)}`)) return;
  const section = document.createElement('div');
  section.className = 'scratchpad-section';
  section.innerHTML = `
    <h4 id="scratch-toggle-${escHtml(agentName)}">▶ Scratchpad</h4>
    <pre class="scratchpad-content" id="scratchpad-${escHtml(agentName)}"></pre>
  `;
  sidebar.appendChild(section);

  document.getElementById(`scratch-toggle-${escHtml(agentName)}`).addEventListener('click', () => {
    const content = document.getElementById(`scratchpad-${escHtml(agentName)}`);
    content.classList.toggle('open');
  });

  // Poll scratchpad every 15s while panel exists
  const pollInterval = setInterval(async () => {
    const panel = document.getElementById(`panel-${escHtml(agentName)}`);
    if (!panel) { clearInterval(pollInterval); return; }
    const contentEl = document.getElementById(`scratchpad-${escHtml(agentName)}`);
    if (!contentEl?.classList.contains('open')) return; // only poll when visible
    try {
      const r = await fetch(`/orchestrations/${orchId}/scratchpad`);
      const { content } = await r.json();
      contentEl.textContent = content;
    } catch {}
  }, 15000);
}
```

Add Orchestrate modal wiring — append to `app.js`:

```js
// ============================================================
// Orchestrate modal
// ============================================================

document.getElementById('btn-orchestrate').addEventListener('click', async () => {
  const modal = document.getElementById('orch-modal');
  modal.classList.remove('hidden');
  document.getElementById('orch-goal').focus();

  // Pre-fill workdir
  const wdInput = document.getElementById('orch-workdir');
  if (!wdInput.value) {
    fetch('/config').then(r => r.json()).then(cfg => { wdInput.value = cfg.defaultWorkdir; }).catch(() => {});
  }

  // Populate workspace dropdown
  const wsSel = document.getElementById('orch-workspace');
  fetch('/workspaces').then(r => r.json()).then(list => {
    wsSel.innerHTML = '<option value="">— manual entry —</option>';
    list.forEach(ws => {
      const opt = document.createElement('option');
      opt.value = ws.path; opt.textContent = `${ws.name}  (${ws.path})`;
      wsSel.appendChild(opt);
    });
  }).catch(() => {});

  // Populate project dropdown
  const projSel = document.getElementById('orch-project');
  fetch('/projects').then(r => r.json()).then(projects => {
    projSel.innerHTML = '<option value="">None</option>';
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      projSel.appendChild(opt);
    });
  }).catch(() => {});

  // Populate model dropdown (reuse router models)
  const modelSel = document.getElementById('orch-model');
  fetch('/router/models').then(r => r.json()).then(models => {
    if (models.error) return;
    while (modelSel.options.length > 1) modelSel.remove(1);
    for (const [provider, list] of Object.entries(models)) {
      const group = document.createElement('optgroup');
      group.label = provider;
      for (const m of list) {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        group.appendChild(opt);
      }
      modelSel.appendChild(group);
    }
  }).catch(() => {});
});

document.getElementById('orch-workspace').addEventListener('change', e => {
  if (e.target.value) document.getElementById('orch-workdir').value = e.target.value;
});

document.getElementById('orch-cancel').addEventListener('click', () =>
  document.getElementById('orch-modal').classList.add('hidden'));
document.getElementById('orch-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('orch-modal'))
    document.getElementById('orch-modal').classList.add('hidden');
});

document.getElementById('orch-spawn').addEventListener('click', async () => {
  const goal    = document.getElementById('orch-goal').value.trim();
  const workdir = document.getElementById('orch-workdir').value.trim();
  if (!goal || !workdir) return;
  const model      = document.getElementById('orch-model').value || undefined;
  const project_id = document.getElementById('orch-project').value || undefined;

  const r = await fetch('/orchestrations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, workdir, model, project_id }),
  });
  if (!r.ok) { console.error('Failed to start orchestration'); return; }
  const orch = await r.json();

  // Create the panel immediately (the WS event will also fire, ensurePanel is idempotent)
  ensurePanel({ name: orch.agentName, mode: 'spawn', status: 'running', role: 'orchestrator' });
  orchAgents[orch.agentName] = orch.id;
  addOrchBadge(orch.agentName);

  document.getElementById('orch-modal').classList.add('hidden');
  document.getElementById('orch-goal').value = '';
  document.getElementById('orch-workdir').value = '';
});
```

- [ ] **Step 4: Manually verify in browser**

Start the server: `node start.js`

Open `http://localhost:3000`, click **⬡ Orchestrate**.

Verify:
- Modal opens with goal textarea and workdir pre-filled.
- Fill goal "Write a hello world script", click Spawn Orchestrator.
- A new panel appears named `orch-1` with a purple `orch` badge.
- In the panel's task sidebar, a "▶ Scratchpad" section appears at the bottom.
- Click "▶ Scratchpad" — it expands showing the initial scratchpad markdown.
- The panel shows a terminal where the Claude agent is running.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/index.html dashboard/public/app.js dashboard/public/style.css
git commit -m "feat(sp7c): add Orchestrate modal, orch/worker panel badges, scratchpad viewer"
```

---

### Task 4: CLI orchestrate subcommand

**Files:**
- Modify: `bin/flint.js` — add `cmdOrchestrate`, register in COMMANDS, update usage

**Interfaces:**
- Consumes: `GET/POST /orchestrations`, `GET /orchestrations/:id/scratchpad` via `dashGet/dashPost`

*No automated test — verify manually.*

- [ ] **Step 1: Add cmdOrchestrate to bin/flint.js**

Before `cmdWorkspace`, add:

```js
async function cmdOrchestrate(args) {
  const [sub, ...rest] = args;

  // `flint orchestrate "goal"` — no sub means the first arg IS the goal
  if (!sub || (!['list', 'status', 'scratchpad'].includes(sub) && !sub.startsWith('-'))) {
    const { values, positionals } = parseArgs({
      args: sub ? [sub, ...rest] : [],
      options: {
        workdir: { type: 'string' },
        project: { type: 'string' },
        model:   { type: 'string' },
      },
      allowPositionals: true,
    });
    const goal = positionals.join(' ');
    if (!goal) {
      console.error('Usage: flint orchestrate "goal" [--workdir <path>] [--project <name>] [--model <model>]');
      process.exit(1);
    }
    const workdir = values.workdir ?? process.cwd();
    const body = { goal, workdir };
    if (values.model)   body.model = values.model;
    // Resolve project name to id if provided
    if (values.project) {
      const projects = await dashGet('/projects');
      const proj = projects.find(p => p.name === values.project);
      if (!proj) { console.error(`Project "${values.project}" not found.`); process.exit(1); }
      body.project_id = proj.id;
    }
    const orch = await dashPost('/orchestrations', body);
    console.log(`Orchestration started — id: ${orch.id}, agent: ${orch.agentName}`);
    console.log(`Goal: ${goal}`);
    console.log(`Monitor at: http://localhost:3000`);

  } else if (sub === 'list') {
    const list = await dashGet('/orchestrations');
    if (!list.length) { console.log('No orchestrations.'); return; }
    for (const o of list) {
      console.log(`[${o.id}] ${o.agent_name} [${o.status}] — ${o.goal.slice(0, 60)}`);
    }

  } else if (sub === 'status') {
    const [id] = rest;
    if (!id) { console.error('Usage: flint orchestrate status <id>'); process.exit(1); }
    const o = await dashGet(`/orchestrations/${id}`);
    console.log(`[${o.id}] ${o.agent_name} [${o.status}]`);
    console.log(`Goal: ${o.goal}`);
    console.log(`Started: ${o.created_at}`);

  } else if (sub === 'scratchpad') {
    const [id] = rest;
    if (!id) { console.error('Usage: flint orchestrate scratchpad <id>'); process.exit(1); }
    const { content } = await dashGet(`/orchestrations/${id}/scratchpad`);
    process.stdout.write(content + '\n');

  } else {
    console.error('Usage: flint orchestrate "goal" | list | status <id> | scratchpad <id>');
    process.exit(1);
  }
}
```

- [ ] **Step 2: Register orchestrate in COMMANDS and update usage**

```js
const COMMANDS = { ask: cmdAsk, models: cmdModels, config: cmdConfig, costs: cmdCosts, project: cmdProject, suggestions: cmdSuggestions, worktree: cmdWorktree, workspace: cmdWorkspace, mcp: cmdMcp, queue: cmdQueue, orchestrate: cmdOrchestrate };
```

```js
  console.error(`Usage: flint <ask|models|config|costs|project|suggestions|worktree|workspace|mcp|queue|orchestrate>`);
```

- [ ] **Step 3: Manual verification**

```
node bin/flint.js orchestrate "Research modern CSS grid layout techniques" --workdir "C:\Users\Robin\Applications Dev\Flint"
# Expected:
# Orchestration started — id: 1, agent: orch-1
# Goal: Research modern CSS grid layout techniques
# Monitor at: http://localhost:3000

node bin/flint.js orchestrate list
# Expected: [1] orch-1 [running] — Research modern CSS grid layout techniques

node bin/flint.js orchestrate status 1
# Expected: [1] orch-1 [running]
# Goal: Research modern CSS grid layout techniques
# Started: 2026-06-24 ...

node bin/flint.js orchestrate scratchpad 1
# Expected: # Orchestration: Research modern CSS grid layout techniques
# Started: ...
# ## Plan
# ...
```

- [ ] **Step 4: Commit**

```bash
git add bin/flint.js
git commit -m "feat(sp7c): add flint orchestrate CLI subcommand (goal/list/status/scratchpad)"
```

---

### Task 5: Update dashboard test suite registration

**Files:**
- Modify: `dashboard/package.json` — add new test files to test script

- [ ] **Step 1: Update package.json test script**

In `dashboard/package.json`, update the `"test"` script to include all test files:

```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js"
```

- [ ] **Step 2: Run the complete test suite**

```
cd dashboard && npm test
```

Expected: all tests across all files PASS

- [ ] **Step 3: Commit**

```bash
git add dashboard/package.json
git commit -m "chore: add sp7 test files to npm test script"
```

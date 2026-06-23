# Flint — Mission Control Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Node.js dashboard at `http://localhost:3000` that streams live terminal output from Claude Code agents into xterm.js browser panels, with a per-agent markdown task queue and SQLite usage tracking.

**Architecture:** Express + WebSocket server spawns Claude Code via node-pty (Windows ConPTY), streams PTY output over WebSocket to xterm.js panels in a plain-HTML frontend. Three agent modes: spawn (dashboard owns process), observe (tail log file via fs.watch), attach (PID, falls back to observe). Task queue is markdown files in `tasks/`. SQLite tracks usage/cost.

**Tech Stack:** Node.js 20+, Express 4, ws (WebSocket), node-pty 1.x, better-sqlite3, xterm.js 5.3.0 via CDN, plain HTML/CSS/JS (no build step)

## Global Constraints

- Root: `C:\Users\Robin\Applications Dev\Flint\` — dashboard lives at `dashboard\` subdirectory
- Windows 11 — node-pty requires native build: Python 3 + Visual Studio Build Tools must be installed before `npm install`
- Node.js 20+ required — uses `node:test` built-in runner and ESM (`"type": "module"`)
- `import.meta.dirname` not available in Node 20.0–20.10 — use `dirname(fileURLToPath(import.meta.url))` for `__dirname`
- No React, no Vue, no build step — plain HTML/CSS/JS only
- xterm.js loaded from CDN: `https://unpkg.com/xterm@5.3.0` and `xterm-addon-fit@0.8.0`
- `usage.sqlite` lives at Flint root (not inside `dashboard/`) — shared with Sub-project 4
- `tasks/` and `logs/` directories live at Flint root
- `agents.json` lives at Flint root — persists registry across dashboard restarts
- All server-side files use ESM (`import`/`export`) — no CommonJS
- Tests use `node:test` + `node:assert/strict` — run with `node --test dashboard/tests/`
- Dashboard port: 3000
- WebSocket path: `/ws`

---

### Task 1: Scaffold — package.json, directories, npm install

**Files:**
- Create: `dashboard/package.json`
- Create dirs: `dashboard/public/`, `dashboard/tests/`, `dashboard/scripts/`
- Create dirs at Flint root: `tasks/`, `logs/`

**Interfaces:**
- Produces: Node.js project with all dependencies installed; `node_modules/` ready for all subsequent tasks

- [ ] **Step 1: Create dashboard/package.json**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\package.json`:
```json
{
  "name": "flint-dashboard",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev":   "node --watch server.js",
    "test":  "node --test tests/"
  },
  "dependencies": {
    "better-sqlite3": "^9.4.3",
    "express": "^4.19.2",
    "node-pty": "^1.0.0",
    "ws": "^8.17.0"
  }
}
```

- [ ] **Step 2: Create supporting directories**

Run in PowerShell from `C:\Users\Robin\Applications Dev\Flint\`:
```powershell
New-Item -ItemType Directory -Force -Path dashboard\public, dashboard\tests, dashboard\scripts
New-Item -ItemType Directory -Force -Path tasks, logs
```
Expected: no errors

- [ ] **Step 3: Install dependencies**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
npm install
```
Expected: `node_modules/` created. node-pty will compile native bindings — this takes 30–60 seconds on first install. If it fails, ensure Python 3 and Visual Studio Build Tools are installed, then retry.

- [ ] **Step 4: Verify install**

```powershell
node -e "import('better-sqlite3').then(m => console.log('sqlite ok')); import('ws').then(m => console.log('ws ok'))"
node -e "import('node-pty').then(m => console.log('pty ok'))"
```
Expected: `sqlite ok`, `ws ok`, `pty ok` (all three lines)

- [ ] **Step 5: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/package.json dashboard/package-lock.json
git commit -m "feat(dashboard): scaffold package.json and directories"
```

---

### Task 2: db.js — SQLite Usage Tracking

**Files:**
- Create: `dashboard/db.js`
- Create: `dashboard/tests/db.test.js`

**Interfaces:**
- Produces:
  - `initDb(dbPath?)` — initialises database, creates tables, returns db instance
  - `writeUsage({ agentName, model, costUsd })` — inserts usage row
  - `getTodayCost(agentName)` — returns number (sum of cost_usd today for agent)
  - `getMonthCost()` — returns number (sum of cost_usd this calendar month)

- [ ] **Step 1: Write the failing tests**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\tests\db.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, writeUsage, getTodayCost, getMonthCost } from '../db.js';

test('initDb creates usage and agents_log tables', () => {
  const db = initDb(':memory:');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('usage'), 'usage table missing');
  assert.ok(tables.includes('agents_log'), 'agents_log table missing');
});

test('getTodayCost returns 0 for unknown agent', () => {
  initDb(':memory:');
  assert.equal(getTodayCost('ghost'), 0);
});

test('writeUsage inserts row and getTodayCost sums it', () => {
  initDb(':memory:');
  writeUsage({ agentName: 'research', model: 'claude', costUsd: 0.42 });
  writeUsage({ agentName: 'research', model: 'claude', costUsd: 0.18 });
  assert.equal(getTodayCost('research'), 0.60);
});

test('getMonthCost sums all agents this month', () => {
  initDb(':memory:');
  writeUsage({ agentName: 'a', model: 'claude', costUsd: 1.00 });
  writeUsage({ agentName: 'b', model: 'claude', costUsd: 2.50 });
  const total = getMonthCost();
  assert.ok(total >= 3.50, `expected >= 3.50, got ${total}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/db.test.js
```
Expected: FAIL — `Cannot find module '../db.js'`

- [ ] **Step 3: Create dashboard/db.js**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\db.js`:
```js
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const DEFAULT_DB = join(FLINT_ROOT, 'usage.sqlite');

let _db = null;

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
  `);
  return _db;
}

export function writeUsage({ agentName, model, costUsd }) {
  _db.prepare(
    `INSERT INTO usage (agent_name, model, cost_usd) VALUES (?, ?, ?)`
  ).run(agentName, model ?? 'claude', costUsd);
}

export function getTodayCost(agentName) {
  const row = _db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM usage WHERE agent_name = ? AND date(timestamp) = date('now')`
  ).get(agentName);
  return row.total;
}

export function getMonthCost() {
  const row = _db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM usage WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')`
  ).get();
  return row.total;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
node --test tests/db.test.js
```
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/db.js dashboard/tests/db.test.js
git commit -m "feat(dashboard): db.js SQLite usage tracking"
```

---

### Task 3: tasks.js — Per-Agent Markdown Task Queue

**Files:**
- Create: `dashboard/tasks.js`
- Create: `dashboard/tests/tasks.test.js`

**Interfaces:**
- Produces:
  - `readTasks(agentName)` → string (full file content; default header if file missing)
  - `writeTasks(agentName, content)` → void (overwrites file)
  - `appendTask(agentName, task)` → void (appends `- [ ] {task}` line)

- [ ] **Step 1: Write the failing tests**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\tests\tasks.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Override TASKS_DIR to a temp dir for tests
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_TASKS = join(__dirname, 'tmp-tasks');

// We need to test with a custom tasks dir — patch via env
process.env.FLINT_TASKS_DIR = TEMP_TASKS;

const { readTasks, writeTasks, appendTask } = await import('../tasks.js');

test('readTasks returns default header for missing file', () => {
  if (existsSync(TEMP_TASKS)) rmSync(TEMP_TASKS, { recursive: true });
  mkdirSync(TEMP_TASKS, { recursive: true });
  const content = readTasks('newagent');
  assert.ok(content.includes('# Tasks — newagent'), `Expected header, got: ${content}`);
});

test('writeTasks overwrites file content', () => {
  mkdirSync(TEMP_TASKS, { recursive: true });
  writeTasks('research', '# Tasks — research\n\n- [ ] do thing\n');
  const content = readTasks('research');
  assert.ok(content.includes('- [ ] do thing'));
});

test('appendTask adds a checkbox line', () => {
  mkdirSync(TEMP_TASKS, { recursive: true });
  writeTasks('dev', '# Tasks — dev\n\n');
  appendTask('dev', 'fix the bug');
  const content = readTasks('dev');
  assert.ok(content.includes('- [ ] fix the bug'));
});

test('cleanup', () => {
  rmSync(TEMP_TASKS, { recursive: true, force: true });
  assert.ok(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
node --test tests/tasks.test.js
```
Expected: FAIL — `Cannot find module '../tasks.js'`

- [ ] **Step 3: Create dashboard/tasks.js**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\tasks.js`:
```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const TASKS_DIR = process.env.FLINT_TASKS_DIR ?? join(FLINT_ROOT, 'tasks');

function ensureDir() {
  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
}

export function taskPath(agentName) {
  return join(TASKS_DIR, `${agentName}.md`);
}

export function readTasks(agentName) {
  ensureDir();
  const p = taskPath(agentName);
  if (!existsSync(p)) return `# Tasks — ${agentName}\n\n`;
  return readFileSync(p, 'utf8');
}

export function writeTasks(agentName, content) {
  ensureDir();
  writeFileSync(taskPath(agentName), content, 'utf8');
}

export function appendTask(agentName, task) {
  const content = readTasks(agentName);
  const line = content.endsWith('\n') ? `- [ ] ${task}\n` : `\n- [ ] ${task}\n`;
  writeFileSync(taskPath(agentName), content + line, 'utf8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
node --test tests/tasks.test.js
```
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/tasks.js dashboard/tests/tasks.test.js
git commit -m "feat(dashboard): tasks.js per-agent markdown task queue"
```

---

### Task 4: agents.js — Agent Registry

**Files:**
- Create: `dashboard/agents.js`
- Create: `dashboard/tests/agents.test.js`

**Interfaces:**
- Produces:
  - `initAgents(agentsFile?)` → void (loads from JSON file)
  - `registerAgent(name, mode, workdir, logPath?)` → agent object
  - `listAgents()` → `[{name, mode, status, workdir}]`
  - `getAgent(name)` → agent object or undefined
  - `setAgentStatus(name, status)` → void (updates + saves + broadcasts)
  - `addWsClient(name, ws)` → void
  - `removeWsClient(name, ws)` → void
  - `broadcastToAgent(name, message)` → void
  - `killAgent(name)` → boolean

**Agent object shape:** `{ name, mode, status, workdir, logPath, ptyProcess, watcher, wsClients }`

- [ ] **Step 1: Write the failing tests**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\tests\agents.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_FILE = join(tmpdir(), `flint-agents-test-${Date.now()}.json`);
process.env.FLINT_AGENTS_FILE = TEMP_FILE;

const { initAgents, registerAgent, listAgents, getAgent, setAgentStatus, killAgent } = await import('../agents.js');

test('listAgents returns empty array on fresh init', () => {
  initAgents();
  assert.deepEqual(listAgents(), []);
});

test('registerAgent adds agent to registry', () => {
  initAgents();
  registerAgent('research', 'spawn', 'C:/flint');
  const agents = listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, 'research');
  assert.equal(agents[0].mode, 'spawn');
  assert.equal(agents[0].status, 'stopped');
});

test('getAgent returns agent by name', () => {
  initAgents();
  registerAgent('dev', 'spawn', 'C:/flint');
  const agent = getAgent('dev');
  assert.ok(agent, 'agent not found');
  assert.equal(agent.name, 'dev');
});

test('setAgentStatus updates status', () => {
  initAgents();
  registerAgent('email', 'observe', null, 'C:/logs/email.log');
  setAgentStatus('email', 'running');
  assert.equal(getAgent('email').status, 'running');
});

test('killAgent returns false for unknown agent', () => {
  initAgents();
  assert.equal(killAgent('ghost'), false);
});

test('cleanup', () => {
  rmSync(TEMP_FILE, { force: true });
  assert.ok(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
node --test tests/agents.test.js
```
Expected: FAIL — `Cannot find module '../agents.js'`

- [ ] **Step 3: Create dashboard/agents.js**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\agents.js`:
```js
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const DEFAULT_AGENTS_FILE = join(FLINT_ROOT, 'agents.json');

let AGENTS_FILE = process.env.FLINT_AGENTS_FILE ?? DEFAULT_AGENTS_FILE;

// name → { name, mode, status, workdir, logPath, ptyProcess, watcher, wsClients }
const registry = new Map();

export function initAgents(agentsFile) {
  if (agentsFile) AGENTS_FILE = agentsFile;
  registry.clear();
  if (!existsSync(AGENTS_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'));
    for (const a of data) {
      registry.set(a.name, {
        ...a,
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

function save() {
  const data = [...registry.values()].map(({ name, mode, workdir, logPath, status }) => ({
    name, mode, workdir, logPath: logPath ?? null,
    status: status === 'running' ? 'stopped' : status,
  }));
  writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function registerAgent(name, mode, workdir, logPath = null) {
  const agent = {
    name, mode, workdir, logPath,
    status: 'stopped', ptyProcess: null, watcher: null, wsClients: new Set(),
  };
  registry.set(name, agent);
  save();
  return agent;
}

export function listAgents() {
  return [...registry.values()].map(({ name, mode, status, workdir }) => ({ name, mode, status, workdir }));
}

export function getAgent(name) {
  return registry.get(name);
}

export function setAgentStatus(name, status) {
  const agent = registry.get(name);
  if (!agent) return;
  agent.status = status;
  save();
  broadcastToAgent(name, { type: 'status', agent: name, status });
}

export function addWsClient(name, ws) {
  registry.get(name)?.wsClients.add(ws);
}

export function removeWsClient(name, ws) {
  registry.get(name)?.wsClients.delete(ws);
}

export function broadcastToAgent(name, message) {
  const agent = registry.get(name);
  if (!agent) return;
  const json = JSON.stringify(message);
  for (const ws of agent.wsClients) {
    if (ws.readyState === 1) ws.send(json); // 1 = WebSocket.OPEN
  }
}

export function killAgent(name) {
  const agent = registry.get(name);
  if (!agent) return false;
  if (agent.ptyProcess) {
    try { agent.ptyProcess.kill(); } catch {}
    agent.ptyProcess = null;
  }
  if (agent.watcher) {
    try { agent.watcher.close(); } catch {}
    agent.watcher = null;
  }
  setAgentStatus(name, 'stopped');
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
node --test tests/agents.test.js
```
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/agents.js dashboard/tests/agents.test.js
git commit -m "feat(dashboard): agents.js in-memory registry with JSON persistence"
```

---

### Task 5: terminal.js — node-pty Spawn + Observe

**Files:**
- Create: `dashboard/terminal.js`

**Interfaces:**
- Consumes: `getAgent`, `setAgentStatus`, `broadcastToAgent` from `agents.js`; `writeUsage` from `db.js`
- Produces:
  - `spawnAgent(name, workdir)` → ptyProcess — starts claude via ConPTY, streams output
  - `writeToAgent(name, data)` → void — sends input to PTY stdin
  - `observeLogFile(name, logPath)` → void — tails log file, streams to WebSocket clients

Note: node-pty requires a real Windows ConPTY — no unit test possible. Verified by smoke test in Task 10.

- [ ] **Step 1: Create dashboard/terminal.js**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\terminal.js`:
```js
import pty from 'node-pty';
import { watch, existsSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { getAgent, setAgentStatus, broadcastToAgent } from './agents.js';
import { writeUsage } from './db.js';

const COST_REGEX = /Total cost:\s+\$?([\d.]+)/i;
const MODEL_REGEX = /Model:\s+(\S+)/i;

export function spawnAgent(name, workdir) {
  const agent = getAgent(name);
  if (!agent) throw new Error(`Agent "${name}" not registered`);
  if (agent.ptyProcess) throw new Error(`Agent "${name}" already has a running process`);

  const ptyProcess = pty.spawn('claude', ['--dangerously-skip-permissions'], {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: workdir,
    env: process.env,
  });

  agent.ptyProcess = ptyProcess;
  setAgentStatus(name, 'running');

  let lastModel = 'claude';

  ptyProcess.onData((data) => {
    broadcastToAgent(name, { type: 'output', agent: name, data });

    const modelMatch = data.match(MODEL_REGEX);
    if (modelMatch) lastModel = modelMatch[1];

    const costMatch = data.match(COST_REGEX);
    if (costMatch) {
      writeUsage({ agentName: name, model: lastModel, costUsd: parseFloat(costMatch[1]) });
    }
  });

  ptyProcess.onExit(() => {
    agent.ptyProcess = null;
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
  // Create log file if it doesn't exist
  if (!existsSync(logPath)) writeFileSync(logPath, '', 'utf8');

  let lastSize = statSync(logPath).size;

  const watcher = watch(logPath, () => {
    try {
      const newSize = statSync(logPath).size;
      if (newSize <= lastSize) return; // truncation or no change
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

- [ ] **Step 2: Verify syntax**

```powershell
node --check dashboard/terminal.js
```
Expected: no output (syntax OK)

- [ ] **Step 3: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/terminal.js
git commit -m "feat(dashboard): terminal.js node-pty spawn and log-file observe"
```

---

### Task 6: server.js — Express + WebSocket

**Files:**
- Create: `dashboard/server.js`
- Create: `dashboard/tests/server.test.js`

**Interfaces:**
- Consumes: all of `db.js`, `tasks.js`, `agents.js`, `terminal.js`
- Produces: HTTP server on port 3000, WebSocket at `/ws`, REST routes per spec

**REST routes:**
- `GET /agents` → `[{name, mode, status, workdir}]`
- `POST /agents/spawn` body `{name, workdir}` → `{ok, name}`
- `POST /agents/observe` body `{name, logPath}` → `{ok, name}`
- `DELETE /agents/:name` → `{ok}`
- `GET /tasks/:agent` → `{content}`
- `PATCH /tasks/:agent` body `{content}` → `{ok}`
- `POST /tasks/:agent` body `{task}` → `{ok}`
- `GET /costs` → `{costs: [{agent, today}], monthTotal}`

- [ ] **Step 1: Write the failing HTTP route tests**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\tests\server.test.js`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

// Point to temp files so tests don't touch real data
const TEMP_DB = join(tmpdir(), `flint-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-agents-${Date.now()}.json`);
const TEMP_TASKS = join(tmpdir(), `flint-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR = TEMP_TASKS;
process.env.FLINT_TEST_MODE = '1'; // skip actual claude spawn in tests

const { createApp } = await import('../server.js');

let server;
let baseUrl;

before(() => new Promise((resolve) => {
  const app = createApp();
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(resolve);
  rmSync(TEMP_DB, { force: true });
  rmSync(TEMP_AGENTS, { force: true });
  rmSync(TEMP_TASKS, { recursive: true, force: true });
}));

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

test('GET /agents returns empty array initially', async () => {
  const r = await req('GET', '/agents');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('GET /tasks/:agent returns default header for unknown agent', async () => {
  const r = await req('GET', '/tasks/ghost');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.content.includes('# Tasks — ghost'));
});

test('PATCH /tasks/:agent overwrites task content', async () => {
  await req('PATCH', '/tasks/dev', { content: '# Tasks — dev\n\n- [ ] task one\n' });
  const r = await req('GET', '/tasks/dev');
  const body = await r.json();
  assert.ok(body.content.includes('- [ ] task one'));
});

test('POST /tasks/:agent appends a task', async () => {
  await req('PATCH', '/tasks/research', { content: '# Tasks — research\n\n' });
  await req('POST', '/tasks/research', { task: 'do the thing' });
  const r = await req('GET', '/tasks/research');
  const body = await r.json();
  assert.ok(body.content.includes('- [ ] do the thing'));
});

test('GET /costs returns costs object', async () => {
  const r = await req('GET', '/costs');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.costs));
  assert.ok('monthTotal' in body);
});

test('DELETE /agents/:name returns ok:false for unknown agent', async () => {
  const r = await req('DELETE', '/agents/ghost');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
node --test tests/server.test.js
```
Expected: FAIL — `Cannot find module '../server.js'`

- [ ] **Step 3: Create dashboard/server.js**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\server.js`:
```js
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initDb, getTodayCost, getMonthCost } from './db.js';
import { initAgents, registerAgent, listAgents, getAgent, addWsClient, removeWsClient, killAgent, broadcastToAgent } from './agents.js';
import { spawnAgent, writeToAgent, observeLogFile } from './terminal.js';
import { readTasks, writeTasks, appendTask } from './tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3000;
const TEST_MODE = process.env.FLINT_TEST_MODE === '1';

export function createApp() {
  // Init subsystems
  initDb(process.env.FLINT_DB_PATH);
  initAgents(process.env.FLINT_AGENTS_FILE);

  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // --- REST routes ---

  app.get('/agents', (_req, res) => {
    res.json(listAgents());
  });

  app.post('/agents/spawn', (req, res) => {
    const { name, workdir } = req.body ?? {};
    if (!name || !workdir) return res.status(400).json({ error: 'name and workdir required' });
    registerAgent(name, 'spawn', workdir);
    if (!TEST_MODE) spawnAgent(name, workdir);
    res.json({ ok: true, name });
  });

  app.post('/agents/observe', (req, res) => {
    const { name, logPath } = req.body ?? {};
    if (!name || !logPath) return res.status(400).json({ error: 'name and logPath required' });
    registerAgent(name, 'observe', null, logPath);
    if (!TEST_MODE) observeLogFile(name, logPath);
    res.json({ ok: true, name });
  });

  app.post('/agents/attach', (_req, res) => {
    res.status(501).json({ error: 'Attach by PID not supported on Windows — use observe mode with attach.ps1 instead' });
  });

  app.delete('/agents/:name', (req, res) => {
    res.json({ ok: killAgent(req.params.name) });
  });

  app.get('/tasks/:agent', (req, res) => {
    res.json({ content: readTasks(req.params.agent) });
  });

  app.patch('/tasks/:agent', (req, res) => {
    const { content } = req.body ?? {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    writeTasks(req.params.agent, content);
    broadcastToAgent(req.params.agent, { type: 'tasks', agent: req.params.agent, content });
    res.json({ ok: true });
  });

  app.post('/tasks/:agent', (req, res) => {
    const { task } = req.body ?? {};
    if (!task) return res.status(400).json({ error: 'task required' });
    appendTask(req.params.agent, task);
    const content = readTasks(req.params.agent);
    broadcastToAgent(req.params.agent, { type: 'tasks', agent: req.params.agent, content });
    res.json({ ok: true });
  });

  app.get('/costs', (_req, res) => {
    const agents = listAgents();
    const costs = agents.map(({ name }) => ({ agent: name, today: getTodayCost(name) }));
    res.json({ costs, monthTotal: getMonthCost() });
  });

  // --- WebSocket ---
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    const subscriptions = new Set();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'agents':
          ws.send(JSON.stringify({ type: 'agents', list: listAgents() }));
          break;

        case 'subscribe': {
          const name = msg.agent;
          subscriptions.add(name);
          addWsClient(name, ws);
          ws.send(JSON.stringify({ type: 'tasks', agent: name, content: readTasks(name) }));
          const agent = getAgent(name);
          if (agent) ws.send(JSON.stringify({ type: 'status', agent: name, status: agent.status }));
          break;
        }

        case 'input':
          writeToAgent(msg.agent, msg.data);
          break;

        case 'spawn': {
          const { agent: name, workdir } = msg;
          if (!name || !workdir) break;
          registerAgent(name, 'spawn', workdir);
          if (!TEST_MODE) spawnAgent(name, workdir);
          broadcastToAgent(name, { type: 'status', agent: name, status: 'running' });
          break;
        }

        case 'kill':
          killAgent(msg.agent);
          break;

        case 'tasks_get': {
          const content = readTasks(msg.agent);
          ws.send(JSON.stringify({ type: 'tasks', agent: msg.agent, content }));
          break;
        }

        case 'tasks_set': {
          writeTasks(msg.agent, msg.content);
          broadcastToAgent(msg.agent, { type: 'tasks', agent: msg.agent, content: msg.content });
          break;
        }
      }
    });

    ws.on('close', () => {
      for (const name of subscriptions) removeWsClient(name, ws);
    });
  });

  return httpServer;
}

// Only start server when run directly (not imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createApp();
  server.listen(PORT, () => {
    console.log(`Flint Dashboard → http://localhost:${PORT}`);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
node --test tests/server.test.js
```
Expected: all 6 tests PASS

- [ ] **Step 5: Run all tests together**

```powershell
node --test tests/
```
Expected: all tests PASS (db + tasks + agents + server)

- [ ] **Step 6: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/server.js dashboard/tests/server.test.js
git commit -m "feat(dashboard): server.js Express routes and WebSocket handler"
```

---

### Task 7: public/index.html + public/style.css — Dashboard UI Shell

**Files:**
- Create: `dashboard/public/index.html`
- Create: `dashboard/public/style.css`

**Interfaces:**
- Consumes: `app.js` (Task 8), xterm.js 5.3.0 from CDN
- Produces: Rendered dashboard shell — dark theme, 2-column grid, sticky header, New Agent modal

- [ ] **Step 1: Create dashboard/public/index.html**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\public\index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flint Dashboard</title>
  <link rel="stylesheet" href="https://unpkg.com/xterm@5.3.0/css/xterm.css">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header id="header">
    <div class="header-left">
      <span class="logo">⚡ Flint</span>
      <span id="agent-count">0 agents</span>
    </div>
    <div class="header-right">
      <span id="today-cost">Today: $0.00</span>
      <span id="month-cost">Month: $0.00</span>
    </div>
  </header>

  <div id="toolbar">
    <button id="btn-new-agent">+ New Agent</button>
    <button id="btn-refresh">↻ Refresh</button>
  </div>

  <div id="panels"></div>

  <div id="modal" class="hidden" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-box">
      <h2 id="modal-title">New Agent</h2>
      <label>
        Name
        <input id="modal-name" type="text" placeholder="research" autocomplete="off">
      </label>
      <label>
        Working Directory
        <input id="modal-workdir" type="text" placeholder="C:\Users\Robin\Applications Dev\Flint" autocomplete="off">
      </label>
      <div class="modal-actions">
        <button id="modal-cancel">Cancel</button>
        <button id="modal-spawn">Spawn</button>
      </div>
    </div>
  </div>

  <script src="https://unpkg.com/xterm@5.3.0/lib/xterm.js"></script>
  <script src="https://unpkg.com/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create dashboard/public/style.css**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\public\style.css`:
```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body { background: #0d1117; color: #e6edf3; font-family: 'Consolas', 'Courier New', monospace; font-size: 13px; }

/* Header */
#header {
  position: sticky; top: 0; z-index: 100;
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 16px; background: #161b22;
  border-bottom: 1px solid #30363d; height: 44px;
}
.logo { font-weight: bold; color: #58a6ff; margin-right: 12px; font-size: 15px; }
#agent-count { color: #8b949e; font-size: 12px; }
.header-right { display: flex; gap: 20px; font-size: 12px; color: #3fb950; }

/* Toolbar */
#toolbar { padding: 8px 12px; display: flex; gap: 8px; border-bottom: 1px solid #21262d; }
#toolbar button {
  background: #21262d; color: #c9d1d9; border: 1px solid #30363d;
  padding: 4px 12px; cursor: pointer; border-radius: 6px; font-size: 12px;
}
#toolbar button:hover { background: #388bfd22; border-color: #58a6ff; color: #58a6ff; }

/* Panels grid */
#panels { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; padding: 10px; }
@media (max-width: 1079px) { #panels { grid-template-columns: 1fr; } }

/* Panel */
.panel { background: #161b22; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; }

.panel-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 10px; background: #21262d; border-bottom: 1px solid #30363d;
  min-height: 34px;
}
.panel-name { font-weight: bold; color: #58a6ff; }
.badge {
  padding: 1px 7px; border-radius: 10px; font-size: 10px;
  margin-left: 6px; font-weight: bold;
}
.badge-running { background: #1a7f37; color: #3fb950; }
.badge-stopped { background: #3d3d3d; color: #8b949e; }
.badge-idle    { background: #783900; color: #d29922; }
.badge-observe { background: #1c3f5e; color: #58a6ff; }
.badge-error   { background: #5a1d1d; color: #f85149; }
.panel-cost { color: #8b949e; font-size: 11px; margin-left: auto; margin-right: 8px; }
.btn-kill {
  background: transparent; border: 1px solid #f8514966;
  color: #f85149; padding: 2px 8px; cursor: pointer;
  border-radius: 4px; font-size: 11px;
}
.btn-kill:hover { background: #f8514922; }

/* Panel body */
.panel-body { display: flex; flex: 1; min-height: 0; }
.terminal-wrap { flex: 1; padding: 4px; min-width: 0; height: 400px; overflow: hidden; }
.terminal-wrap .xterm { height: 100%; }

/* Task sidebar */
.task-sidebar {
  width: 220px; border-left: 1px solid #30363d;
  display: flex; flex-direction: column; padding: 8px; gap: 4px;
}
.task-sidebar h4 { color: #58a6ff; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
.task-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.task-item { display: flex; align-items: flex-start; gap: 5px; cursor: pointer; }
.task-item input[type=checkbox] { margin-top: 2px; cursor: pointer; flex-shrink: 0; }
.task-item span { word-break: break-word; color: #c9d1d9; font-size: 11px; line-height: 1.4; }
.task-item.done span { text-decoration: line-through; color: #484f58; }
.task-add { display: flex; gap: 4px; margin-top: 4px; }
.task-add input {
  flex: 1; background: #0d1117; border: 1px solid #30363d;
  color: #e6edf3; padding: 3px 6px; font-size: 11px; border-radius: 4px;
}
.task-add input:focus { outline: none; border-color: #58a6ff; }
.task-add button {
  background: #21262d; border: 1px solid #30363d; color: #58a6ff;
  padding: 3px 8px; cursor: pointer; border-radius: 4px; font-size: 13px;
}
.task-add button:hover { background: #388bfd22; }

/* Modal */
.hidden { display: none !important; }
#modal {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.modal-box {
  background: #161b22; border: 1px solid #30363d;
  padding: 24px; border-radius: 8px; min-width: 380px;
  display: flex; flex-direction: column; gap: 14px;
}
.modal-box h2 { color: #58a6ff; }
.modal-box label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #8b949e; }
.modal-box input {
  background: #0d1117; border: 1px solid #30363d; color: #e6edf3;
  padding: 7px 10px; font-size: 13px; border-radius: 4px; font-family: inherit;
}
.modal-box input:focus { outline: none; border-color: #58a6ff; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.modal-actions button { padding: 6px 16px; cursor: pointer; border-radius: 6px; border: none; font-size: 13px; }
#modal-cancel { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; }
#modal-spawn  { background: #1f6feb; color: #fff; }
#modal-spawn:hover { background: #388bfd; }
```

- [ ] **Step 3: Verify files exist**

```powershell
Test-Path "C:\Users\Robin\Applications Dev\Flint\dashboard\public\index.html"
Test-Path "C:\Users\Robin\Applications Dev\Flint\dashboard\public\style.css"
```
Expected: `True` and `True`

- [ ] **Step 4: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/public/index.html dashboard/public/style.css
git commit -m "feat(dashboard): HTML shell and dark-theme CSS"
```

---

### Task 8: public/app.js — Frontend WebSocket Client + xterm.js

**Files:**
- Create: `dashboard/public/app.js`

**Interfaces:**
- Consumes: `window.Terminal` and `window.FitAddon` from xterm.js CDN scripts; WebSocket at `ws://localhost:3000/ws`; REST at `/tasks/:agent`, `/costs`
- Produces: Live agent panels with xterm.js terminals and task sidebars; cost header updates; New Agent modal

- [ ] **Step 1: Create dashboard/public/app.js**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\public\app.js`:
```js
'use strict';

const WS_URL = `ws://${location.host}/ws`;

let ws;
const terminals = {};   // agentName → { term, fitAddon }
const taskContent = {}; // agentName → latest raw markdown content

function connect() {
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'agents' }));
    fetchCosts();
  });

  ws.addEventListener('message', ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'agents':
        msg.list.forEach(agent => ensurePanel(agent));
        updateAgentCount();
        break;
      case 'output':
        terminals[msg.agent]?.term.write(msg.data);
        break;
      case 'status':
        updateStatus(msg.agent, msg.status);
        break;
      case 'tasks':
        taskContent[msg.agent] = msg.content;
        renderTasks(msg.agent, msg.content);
        break;
      case 'cost':
        updateAgentCost(msg.agent, msg.today);
        break;
    }
  });

  ws.addEventListener('close', () => setTimeout(connect, 2000));
}

function ensurePanel({ name, mode, status }) {
  if (document.getElementById(`panel-${name}`)) return;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = `panel-${name}`;
  panel.innerHTML = `
    <div class="panel-header">
      <div style="display:flex;align-items:center;gap:0">
        <span class="panel-name">${name}</span>
        <span class="badge badge-${status}" id="badge-${name}">${status}</span>
        ${mode === 'observe' ? '<span class="badge badge-observe">observe</span>' : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="panel-cost" id="cost-${name}">$0.00 today</span>
        <button class="btn-kill" data-agent="${name}">Kill</button>
      </div>
    </div>
    <div class="panel-body">
      <div class="terminal-wrap" id="term-${name}"></div>
      <div class="task-sidebar">
        <h4>Tasks</h4>
        <div class="task-list" id="tasks-${name}"></div>
        <div class="task-add">
          <input type="text" id="task-input-${name}" placeholder="Add task…">
          <button data-add="${name}">+</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('panels').appendChild(panel);

  // Init xterm.js terminal
  const term = new Terminal({
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff' },
    fontSize: 12,
    cursorBlink: true,
    scrollback: 5000,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById(`term-${name}`));
  fitAddon.fit();
  terminals[name] = { term, fitAddon };

  // Keyboard input → server
  term.onData(data => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', agent: name, data }));
    }
  });

  // Subscribe to agent stream
  ws.send(JSON.stringify({ type: 'subscribe', agent: name }));

  // Kill button
  panel.querySelector(`[data-agent="${name}"]`).addEventListener('click', () => {
    ws.send(JSON.stringify({ type: 'kill', agent: name }));
  });

  // Add task button + Enter key
  const taskInput = panel.querySelector(`#task-input-${name}`);
  panel.querySelector(`[data-add="${name}"]`).addEventListener('click', () => addTask(name));
  taskInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTask(name); });

  // Poll tasks every 5s
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tasks_get', agent: name }));
    }
  }, 5000);

  updateAgentCount();
}

function updateStatus(name, status) {
  const badge = document.getElementById(`badge-${name}`);
  if (!badge) return;
  badge.textContent = status;
  badge.className = `badge badge-${status}`;
}

function updateAgentCost(name, today) {
  const el = document.getElementById(`cost-${name}`);
  if (el) el.textContent = `$${today.toFixed(2)} today`;
}

function updateAgentCount() {
  document.getElementById('agent-count').textContent =
    `${document.querySelectorAll('.panel').length} agents`;
}

function renderTasks(agentName, content) {
  const container = document.getElementById(`tasks-${agentName}`);
  if (!container) return;
  const lines = content.split('\n');
  container.innerHTML = '';
  lines.forEach((line, i) => {
    const checked = line.startsWith('- [x]');
    const unchecked = line.startsWith('- [ ]');
    if (!checked && !unchecked) return;
    const text = line.replace(/^- \[.\] /, '');
    const item = document.createElement('div');
    item.className = `task-item${checked ? ' done' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => toggleTask(agentName, i, cb.checked));
    const label = document.createElement('span');
    label.textContent = text;
    item.append(cb, label);
    container.appendChild(item);
  });
}

function toggleTask(agentName, lineIndex, checked) {
  const content = taskContent[agentName] ?? '';
  const lines = content.split('\n');
  if (!lines[lineIndex]) return;
  lines[lineIndex] = lines[lineIndex]
    .replace(checked ? '- [ ]' : '- [x]', checked ? '- [x]' : '- [ ]');
  const newContent = lines.join('\n');
  taskContent[agentName] = newContent;
  ws.send(JSON.stringify({ type: 'tasks_set', agent: agentName, content: newContent }));
}

function addTask(agentName) {
  const input = document.getElementById(`task-input-${agentName}`);
  const task = input.value.trim();
  if (!task) return;
  input.value = '';
  fetch(`/tasks/${agentName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
  }).then(() => {
    ws.send(JSON.stringify({ type: 'tasks_get', agent: agentName }));
  });
}

function fetchCosts() {
  fetch('/costs').then(r => r.json()).then(({ costs, monthTotal }) => {
    let todayTotal = 0;
    costs.forEach(({ agent, today }) => {
      todayTotal += today;
      updateAgentCost(agent, today);
    });
    document.getElementById('today-cost').textContent = `Today: $${todayTotal.toFixed(2)}`;
    document.getElementById('month-cost').textContent = `Month: $${monthTotal.toFixed(2)}`;
  }).catch(() => {}); // silent fail — server may not be ready
  setTimeout(fetchCosts, 30_000);
}

// New Agent modal
document.getElementById('btn-new-agent').addEventListener('click', () => {
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('modal-name').focus();
});
document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal').classList.add('hidden');
});
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal')) {
    document.getElementById('modal').classList.add('hidden');
  }
});
document.getElementById('modal-spawn').addEventListener('click', () => {
  const name = document.getElementById('modal-name').value.trim();
  const workdir = document.getElementById('modal-workdir').value.trim();
  if (!name || !workdir) return;
  ws.send(JSON.stringify({ type: 'spawn', agent: name, workdir }));
  ensurePanel({ name, mode: 'spawn', status: 'running' });
  document.getElementById('modal').classList.add('hidden');
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-workdir').value = '';
});

// Refresh button
document.getElementById('btn-refresh').addEventListener('click', () => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'agents' }));
  fetchCosts();
});

// Resize terminals when window resizes
window.addEventListener('resize', () => {
  Object.values(terminals).forEach(({ fitAddon }) => fitAddon.fit());
});

connect();
```

- [ ] **Step 2: Verify syntax (Node can parse it as a module)**

```powershell
node -e "import('./public/app.js').catch(e => { if (!e.message.includes('browser')) process.exit(1) })"
```
Expected: exits 0 or throws browser-environment error (acceptable — app.js uses `window`/`location` which are browser globals; syntax is still valid)

- [ ] **Step 3: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/public/app.js
git commit -m "feat(dashboard): app.js WebSocket client, xterm.js panels, task sidebar"
```

---

### Task 9: scripts/attach.ps1 — Observe Mode Wrapper

**Files:**
- Create: `dashboard/scripts/attach.ps1`

**Interfaces:**
- Consumes: `claude` on PATH, Flint root directory structure
- Produces: Starts claude.exe piping stdout to `logs/<AgentName>.log`; prints the `POST /agents/observe` command to run in dashboard

- [ ] **Step 1: Create dashboard/scripts/attach.ps1**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\scripts\attach.ps1`:
```powershell
<#
.SYNOPSIS
    Start a Claude Code agent in observe mode, piping output to a log file.
    The dashboard can then attach to the log file for a read-only live view.

.PARAMETER AgentName
    Name of the agent (used for the log file name and dashboard registration).

.EXAMPLE
    .\attach.ps1 research
    Then in dashboard: POST /agents/observe { name: "research", logPath: "<shown below>" }
#>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$AgentName
)

$FlintRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$LogsDir   = Join-Path $FlintRoot "logs"
$LogFile   = Join-Path $LogsDir "$AgentName.log"

if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
}

# Clear previous log so dashboard doesn't replay old output
if (Test-Path $LogFile) { Clear-Content $LogFile }

Write-Host ""
Write-Host "⚡ Flint — Observe Mode" -ForegroundColor Cyan
Write-Host "Agent   : $AgentName"
Write-Host "Log file: $LogFile"
Write-Host ""
Write-Host "Register in dashboard:" -ForegroundColor Yellow
Write-Host "  POST /agents/observe"
Write-Host "  Body: { `"name`": `"$AgentName`", `"logPath`": `"$($LogFile -replace '\\', '\\')`" }"
Write-Host ""
Write-Host "Starting Claude Code... (Ctrl+C to stop)" -ForegroundColor Green
Write-Host ""

# Start claude and tee all output (stdout + stderr) to the log file
claude --dangerously-skip-permissions 2>&1 | Tee-Object -FilePath $LogFile
```

- [ ] **Step 2: Verify PowerShell syntax**

```powershell
powershell -NoProfile -Command "& { Get-Command -Name 'Test-Path' | Out-Null; Write-Host 'syntax check: OK' }"
```
Expected: `syntax check: OK`

Optionally, check the script parses:
```powershell
powershell -NoProfile -File "C:\Users\Robin\Applications Dev\Flint\dashboard\scripts\attach.ps1" -? 2>&1
```
Expected: shows synopsis/help text without error

- [ ] **Step 3: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/scripts/attach.ps1
git commit -m "feat(dashboard): attach.ps1 observe-mode wrapper for existing claude sessions"
```

---

### Task 10: Full Test Suite + Smoke Test

**Files:**
- No new files — validates everything built in Tasks 1–9

**Interfaces:**
- Consumes: All dashboard modules
- Produces: Passing test suite + manually verified dashboard in browser

- [ ] **Step 1: Run the full test suite**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/
```
Expected output (all PASS):
```
✔ initDb creates usage and agents_log tables
✔ getTodayCost returns 0 for unknown agent
✔ writeUsage inserts row and getTodayCost sums it
✔ getMonthCost sums all agents this month
✔ readTasks returns default header for missing file
✔ writeTasks overwrites file content
✔ appendTask adds a checkbox line
✔ cleanup
✔ listAgents returns empty array on fresh init
✔ registerAgent adds agent to registry
✔ getAgent returns agent by name
✔ setAgentStatus updates status
✔ killAgent returns false for unknown agent
✔ cleanup
✔ GET /agents returns empty array initially
✔ GET /tasks/:agent returns default header for unknown agent
✔ PATCH /tasks/:agent overwrites task content
✔ POST /tasks/:agent appends a task
✔ GET /costs returns costs object
✔ DELETE /agents/:name returns ok:false for unknown agent
ℹ tests 20
ℹ pass 20
ℹ fail 0
```

- [ ] **Step 2: Start the dashboard**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
npm start
```
Expected: `Flint Dashboard → http://localhost:3000`

- [ ] **Step 3: Open dashboard in browser**

Navigate to `http://localhost:3000`.
Expected: Dark-theme dashboard with sticky header (`⚡ Flint — 0 agents — Today: $0.00 — Month: $0.00`), toolbar with "+ New Agent" and "↻ Refresh" buttons, empty panel grid.

- [ ] **Step 4: Spawn a test agent**

Click "+ New Agent". In the modal:
- Name: `test`
- Working Directory: `C:\Users\Robin\Applications Dev\Flint`

Click "Spawn".
Expected: A new panel appears with name "test", badge "running", an xterm.js terminal area, and an empty task sidebar.

- [ ] **Step 5: Verify terminal streams output**

The xterm.js panel should show Claude Code starting up (its intro banner / permission prompt).
Type something in the terminal panel — keystrokes should reach the claude process.

- [ ] **Step 6: Add a task**

In the task sidebar for the `test` agent, type "verify dashboard works" in the task input and press Enter.
Expected: task appears in sidebar as `- [ ] verify dashboard works`.

Check the file was written:
```powershell
Get-Content "C:\Users\Robin\Applications Dev\Flint\tasks\test.md"
```
Expected: file contains `- [ ] verify dashboard works`

- [ ] **Step 7: Toggle task done**

Click the checkbox beside "verify dashboard works".
Expected: text becomes strikethrough, `- [x]` in the file.

- [ ] **Step 8: Test observe mode**

In a new PowerShell terminal:
```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
.\dashboard\scripts\attach.ps1 observer-test
```
Expected: prints log file path and POST command. Copy the logPath shown.

In the browser console (F12):
```js
fetch('/agents/observe', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({ name: 'observer-test', logPath: '<paste logPath here>' })
})
```
Expected: `{ok: true, name: "observer-test"}` — a new panel appears.

- [ ] **Step 9: Kill the test agent**

Click the "Kill" button on the `test` panel.
Expected: badge changes to "stopped", PTY process terminates.

- [ ] **Step 10: Final commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add -A
git commit -m "feat(dashboard): complete - all 20 tests passing, smoke test verified"
```

---

## What Comes Next (Sub-project 3)

| Sub-project | What it adds |
|---|---|
| 3 — Multi-LLM Model Router | OpenRouter gateway, tier config, task-type routing, budget caps |
| 4 — PM Module | SQLite task/cost tables, Gantt, team isolation, budget alerts |
| 5 — Multi-agent Isolation | Forgejo, git worktrees, PR-based merge flow, production hardening |

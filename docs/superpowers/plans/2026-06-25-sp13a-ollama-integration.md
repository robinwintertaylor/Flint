# SP13a: Ollama Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ollama as a local LLM provider — agents can use `runtime: 'ollama'` and Flint exposes a `generate()` primitive plus REST endpoints for internal use.

**Architecture:** New `dashboard/ollama.js` mirrors the `forgejo.js`/`github.js` provider pattern (TEST_MODE guard, no auth, no npm dependencies). `terminal.js` gains a three-way spawn branch (Claude / Vibe / Ollama). `server.js` gets two new routes and an updated health endpoint.

**Tech Stack:** Node.js, `fetch` (built-in), `node:test` (existing), `node-pty` (existing).

## Global Constraints

- No new npm dependencies — uses `fetch` (built-in) only
- No DB schema changes
- Ollama base URL: `process.env.OLLAMA_URL ?? 'http://localhost:11434'` (read at call time, not module load)
- `TEST_MODE`: `() => process.env.FLINT_TEST_MODE === '1'` (function, not constant — read at call time)
- In TEST_MODE: `isOllamaReachable()` → `true`, `listModels()` → `['llama3']`, `generate()` → `'test response'`
- Agent spawn: `ollama run <agent.model || 'llama3'>` via PTY; skip autonomous block, MCP injection, cost parsing
- `node --test` must pass all existing + new tests. Target after Task 1: 171 (169 pass, 2 pre-existing EPERM). Target after Task 2: 174 (172 pass, 2 pre-existing EPERM)
- All commits on `master`

---

### Task 1: `dashboard/ollama.js` + module tests

**Files:**
- Create: `dashboard/ollama.js`
- Create: `dashboard/tests/ollama.test.js` (3 module-only tests)
- Modify: `dashboard/package.json` — add `tests/ollama.test.js` to test script

**Interfaces:**
- Produces:
  - `isOllamaReachable(): Promise<boolean>`
  - `listModels(): Promise<string[]>`
  - `generate(model: string, prompt: string, opts?: object): Promise<string>`

---

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/ollama.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FLINT_TEST_MODE = '1';

import { isOllamaReachable, listModels, generate } from '../ollama.js';

test('isOllamaReachable returns true in TEST_MODE', async () => {
  assert.equal(await isOllamaReachable(), true);
});

test('listModels returns ["llama3"] in TEST_MODE', async () => {
  assert.deepEqual(await listModels(), ['llama3']);
});

test('generate returns "test response" in TEST_MODE', async () => {
  assert.equal(await generate('llama3', 'hello'), 'test response');
});
```

- [ ] **Step 2: Run tests — expect failure (module not yet created)**

```bash
cd dashboard && node --test tests/ollama.test.js 2>&1 | tail -5
```

Expected: error about `../ollama.js` not found.

- [ ] **Step 3: Create `dashboard/ollama.js`**

```js
const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';

function getBaseUrl() {
  return process.env.OLLAMA_URL ?? 'http://localhost:11434';
}

export async function isOllamaReachable() {
  if (TEST_MODE()) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${getBaseUrl()}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function listModels() {
  if (TEST_MODE()) return ['llama3'];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${getBaseUrl()}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? []).map(m => m.name);
  } catch {
    return [];
  }
}

export async function generate(model, prompt, opts = {}) {
  if (TEST_MODE()) return 'test response';
  const res = await fetch(`${getBaseUrl()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, ...opts }),
  });
  if (!res.ok) throw new Error(`Ollama generate failed: ${res.status}`);
  const data = await res.json();
  return data.response;
}
```

- [ ] **Step 4: Update `dashboard/package.json` test script**

Replace:
```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js tests/telegram.test.js tests/github.test.js"
```

With:
```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js tests/telegram.test.js tests/github.test.js tests/ollama.test.js"
```

- [ ] **Step 5: Run isolated tests — expect 3 pass**

```bash
cd dashboard && node --test tests/ollama.test.js 2>&1 | tail -6
```

Expected:
```
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

- [ ] **Step 6: Run full test suite — expect 171 total (169 pass, 2 pre-existing EPERM failures)**

```bash
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 171
ℹ pass 169
ℹ fail 2
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/ollama.js dashboard/tests/ollama.test.js dashboard/package.json
git commit -m "feat(sp13a): add ollama.js — isOllamaReachable, listModels, generate"
```

---

### Task 2: `terminal.js` + `server.js` wiring + route tests

**Files:**
- Modify: `dashboard/terminal.js` — three-way spawn branch, guard autonomous block + MCP + cost parsing for Ollama
- Modify: `dashboard/server.js` — import from `ollama.js`, two new routes, updated health endpoint
- Modify: `dashboard/tests/ollama.test.js` — add 3 route tests

**Interfaces:**
- Consumes (from Task 1):
  - `isOllamaReachable(): Promise<boolean>`
  - `listModels(): Promise<string[]>`
  - `generate(model: string, prompt: string, opts?: object): Promise<string>`
- Produces: nothing consumed by other tasks

---

- [ ] **Step 1: Add 3 route tests to `dashboard/tests/ollama.test.js`**

The file currently has 3 module tests. Append these imports and route tests. The full updated file:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-ollama-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-ollama-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-ollama-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

import { isOllamaReachable, listModels, generate } from '../ollama.js';
const { createApp, closeDb } = await import('../server.js');

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
  server.close(() => {
    closeDb();
    rmSync(TEMP_DB,     { force: true });
    rmSync(TEMP_AGENTS, { force: true });
    rmSync(TEMP_TASKS,  { recursive: true, force: true });
    resolve();
  });
}));

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

// --- Module tests ---

test('isOllamaReachable returns true in TEST_MODE', async () => {
  assert.equal(await isOllamaReachable(), true);
});

test('listModels returns ["llama3"] in TEST_MODE', async () => {
  assert.deepEqual(await listModels(), ['llama3']);
});

test('generate returns "test response" in TEST_MODE', async () => {
  assert.equal(await generate('llama3', 'hello'), 'test response');
});

// --- Route tests ---

test('GET /api/ollama/status returns { reachable, models }', async () => {
  const r = await req('GET', '/api/ollama/status');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('reachable' in body, 'body has reachable');
  assert.ok(Array.isArray(body.models), 'body.models is array');
  assert.equal(body.reachable, true);
});

test('POST /api/ollama/generate with valid body returns { response }', async () => {
  const r = await req('POST', '/api/ollama/generate', { model: 'llama3', prompt: 'hello' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.response, 'test response');
});

test('POST /api/ollama/generate missing prompt returns 400', async () => {
  const r = await req('POST', '/api/ollama/generate', { model: 'llama3' });
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: Run isolated tests — expect 3 route tests to fail (routes not yet added)**

```bash
cd dashboard && node --test tests/ollama.test.js 2>&1 | tail -8
```

Expected: 3 pass (module tests), 3 fail (route tests — routes don't exist yet).

- [ ] **Step 3: Update `dashboard/terminal.js`**

**3a. Add `OLLAMA_BIN` constant** (after line 23 where `VIBE_BIN` is defined):

Replace:
```js
const CLAUDE_BIN = resolveBin('claude');
const VIBE_BIN   = resolveBin('vibe');
```

With:
```js
const CLAUDE_BIN  = resolveBin('claude');
const VIBE_BIN    = resolveBin('vibe');
const OLLAMA_BIN  = resolveBin('ollama');
```

**3b. Replace the autonomous block + spawn setup** (lines 60–95). Replace this entire block:

```js
  // Prepend autonomous operating directive so the agent never pauses for human input
  const AUTONOMOUS_BLOCK =
    '## Operating Mode: Autonomous\n' +
    'You are running as an autonomous agent orchestrated by Flint. No human is monitoring this session.\n' +
    '- Never pause to ask for confirmation or approval\n' +
    '- Make your best judgement on all decisions and proceed\n' +
    '- If you encounter ambiguity, choose the most reasonable interpretation and continue\n' +
    '- Complete all tasks fully without checking in\n' +
    '---\n\n';
  const _currentTasks = readTasks(name);
  if (!_currentTasks.startsWith('## Operating Mode:')) {
    writeTasks(name, AUTONOMOUS_BLOCK + _currentTasks);
  }

  const isVibe = agent.runtime === 'vibe';
  const bin = isVibe ? VIBE_BIN : CLAUDE_BIN;
  const args = isVibe ? [] : ['--dangerously-skip-permissions'];
  if (!isVibe && model) args.push('--model', model);

  if (!isVibe) {
    try { injectMcpConfig(name, workdir); } catch {}
  }

  const ptyProcess = pty.spawn(bin, args, {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: workdir,
    env: process.env,
  });

  agent.ptyProcess = ptyProcess;
  setAgentStatus(name, 'running');
  notify(`🟢 Agent \`${name}\` started`);

  let lastModel = isVibe ? 'mistral' : 'claude';
  let lastCost = 0;
```

With:

```js
  const isVibe   = agent.runtime === 'vibe';
  const isOllama = agent.runtime === 'ollama';

  if (!isOllama) {
    const AUTONOMOUS_BLOCK =
      '## Operating Mode: Autonomous\n' +
      'You are running as an autonomous agent orchestrated by Flint. No human is monitoring this session.\n' +
      '- Never pause to ask for confirmation or approval\n' +
      '- Make your best judgement on all decisions and proceed\n' +
      '- If you encounter ambiguity, choose the most reasonable interpretation and continue\n' +
      '- Complete all tasks fully without checking in\n' +
      '---\n\n';
    const _currentTasks = readTasks(name);
    if (!_currentTasks.startsWith('## Operating Mode:')) {
      writeTasks(name, AUTONOMOUS_BLOCK + _currentTasks);
    }
  }

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

  if (!isVibe && !isOllama) {
    try { injectMcpConfig(name, workdir); } catch {}
  }

  const ptyProcess = pty.spawn(bin, args, {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: workdir,
    env: process.env,
  });

  agent.ptyProcess = ptyProcess;
  setAgentStatus(name, 'running');
  notify(`🟢 Agent \`${name}\` started`);

  let lastModel = isOllama ? (agent.model || 'llama3') : isVibe ? 'mistral' : 'claude';
  let lastCost = 0;
```

**3c. Guard cost parsing** (the `costMatch` block, currently around lines 118–125). Replace:

```js
    const costMatch = plain.match(COST_REGEX);
    if (costMatch) {
      const delta = parseFloat(costMatch[1]) - lastCost;
      if (delta > 0) {
        writeUsage({ agentName: name, model: lastModel, costUsd: delta });
        lastCost = parseFloat(costMatch[1]);
      }
    }
```

With:

```js
    if (!isOllama) {
      const costMatch = plain.match(COST_REGEX);
      if (costMatch) {
        const delta = parseFloat(costMatch[1]) - lastCost;
        if (delta > 0) {
          writeUsage({ agentName: name, model: lastModel, costUsd: delta });
          lastCost = parseFloat(costMatch[1]);
        }
      }
    }
```

- [ ] **Step 4: Update `dashboard/server.js`**

**4a. Add `ollama.js` import** (after line 22, the `telegram.js` import):

```js
import { initTelegram } from './telegram.js';
import { isOllamaReachable, listModels, generate } from './ollama.js';
```

**4b. Update the health endpoint** (lines 301–309). Replace:

```js
  app.get('/health', async (_req, res) => {
    const reachable = await isForgejoReachable();
    res.json({
      status: reachable ? 'ok' : 'degraded',
      uptime: Math.floor(process.uptime()),
      db: 'connected',
      forgejo: reachable ? 'reachable' : 'unreachable',
    });
  });
```

With:

```js
  app.get('/health', async (_req, res) => {
    const [forgejoOk, ollamaOk] = await Promise.all([isForgejoReachable(), isOllamaReachable()]);
    res.json({
      status: forgejoOk ? 'ok' : 'degraded',
      uptime: Math.floor(process.uptime()),
      db: 'connected',
      forgejo: forgejoOk ? 'reachable' : 'unreachable',
      ollama:  ollamaOk  ? 'reachable' : 'unreachable',
    });
  });
```

**4c. Add Ollama routes** (immediately after the health endpoint, before `// --- Project routes ---`):

```js
  // --- Ollama routes ---

  app.get('/api/ollama/status', async (_req, res) => {
    const reachable = await isOllamaReachable();
    const models = reachable ? await listModels() : [];
    res.json({ reachable, models });
  });

  app.post('/api/ollama/generate', async (req, res) => {
    const { model, prompt } = req.body ?? {};
    if (!model || !prompt) return res.status(400).json({ error: 'model and prompt required' });
    try {
      const response = await generate(model, prompt);
      res.json({ response });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 5: Run isolated tests — expect all 6 pass**

```bash
cd dashboard && node --test tests/ollama.test.js 2>&1 | tail -8
```

Expected:
```
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

- [ ] **Step 6: Run full test suite — expect 174 total (172 pass, 2 pre-existing EPERM failures)**

```bash
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 174
ℹ pass 172
ℹ fail 2
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/terminal.js dashboard/server.js dashboard/tests/ollama.test.js
git commit -m "feat(sp13a): wire Ollama runtime into terminal.js and add REST routes to server.js"
```

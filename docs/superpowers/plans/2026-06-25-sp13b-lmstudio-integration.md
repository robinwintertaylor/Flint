# SP13b: LM Studio Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LM Studio as a local LLM provider via a `lmstudio.js` REST client module and two new API routes in `server.js`.

**Architecture:** New `dashboard/lmstudio.js` mirrors `ollama.js` — same `TEST_MODE` guard, same export shape, no auth, no npm dependencies — but targets LM Studio's OpenAI-compatible API at port 1234. `server.js` imports three functions with aliases (name clash with ollama imports), adds `GET /api/lmstudio/status` and `POST /api/lmstudio/generate` routes, and extends `GET /health` to include LM Studio reachability. No `terminal.js` changes — LM Studio has no interactive CLI.

**Tech Stack:** Node.js, `fetch` (built-in), `node:test` (existing).

## Global Constraints

- No new npm dependencies — uses `fetch` only.
- No DB schema changes.
- No `terminal.js` changes — LM Studio has no CLI for agent spawn.
- LM Studio base URL: `process.env.LMSTUDIO_URL ?? 'http://localhost:1234'` (read at call time).
- `TEST_MODE`: `() => process.env.FLINT_TEST_MODE === '1'` — function, not boolean.
- TEST_MODE return values: `isLmStudioReachable` → `true`, `listModels` → `['local-model']`, `generate` → `'test response'`.
- LM Studio API: `GET /v1/models` → `{ data: [{ id, ... }] }`; `POST /v1/chat/completions` → `{ choices: [{ message: { content } }] }`.
- `node --test` must pass all existing + new tests. Target: 175 existing + 7 new = 182 total (180 pass, 2 pre-existing Windows EPERM failures in sp5/sp6).
- All commits on `master`.

---

### Task 1: `dashboard/lmstudio.js` + tests + package.json

**Files:**
- Create: `dashboard/lmstudio.js`
- Create: `dashboard/tests/lmstudio.test.js`
- Modify: `dashboard/package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (consumed by Task 2):
  - `isLmStudioReachable(): Promise<boolean>`
  - `listModels(): Promise<string[]>`
  - `generate(model: string, prompt: string, opts?: object): Promise<string>`

---

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/lmstudio.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-lmstudio-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-lmstudio-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-lmstudio-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

import { isLmStudioReachable, listModels, generate } from '../lmstudio.js';
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

test('isLmStudioReachable returns true in TEST_MODE', async () => {
  assert.equal(await isLmStudioReachable(), true);
});

test('listModels returns ["local-model"] in TEST_MODE', async () => {
  assert.deepEqual(await listModels(), ['local-model']);
});

test('generate returns "test response" in TEST_MODE', async () => {
  assert.equal(await generate('local-model', 'hello'), 'test response');
});

// --- Route tests ---

test('GET /api/lmstudio/status returns { reachable, models }', async () => {
  const r = await req('GET', '/api/lmstudio/status');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('reachable' in body, 'body has reachable');
  assert.ok(Array.isArray(body.models), 'body.models is array');
  assert.equal(body.reachable, true);
});

test('POST /api/lmstudio/generate with valid body returns { response }', async () => {
  const r = await req('POST', '/api/lmstudio/generate', { model: 'local-model', prompt: 'hello' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.response, 'test response');
});

test('POST /api/lmstudio/generate missing prompt returns 400', async () => {
  const r = await req('POST', '/api/lmstudio/generate', { model: 'local-model' });
  assert.equal(r.status, 400);
});

test('POST /api/lmstudio/generate missing model returns 400', async () => {
  const r = await req('POST', '/api/lmstudio/generate', { prompt: 'hello' });
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: Run tests — expect failure (module not yet created)**

```
cd dashboard && node --test tests/lmstudio.test.js 2>&1 | tail -5
```

Expected: error about `../lmstudio.js` not found.

- [ ] **Step 3: Create `dashboard/lmstudio.js`**

```js
const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';

function getBaseUrl() {
  return process.env.LMSTUDIO_URL ?? 'http://localhost:1234';
}

export async function isLmStudioReachable() {
  if (TEST_MODE()) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${getBaseUrl()}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function listModels() {
  if (TEST_MODE()) return ['local-model'];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${getBaseUrl()}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data ?? []).map(m => m.id);
  } catch {
    return [];
  }
}

export async function generate(model, prompt, opts = {}) {
  if (TEST_MODE()) return 'test response';
  const res = await fetch(`${getBaseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      ...opts,
    }),
  });
  if (!res.ok) throw new Error(`LM Studio generate failed: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}
```

- [ ] **Step 4: Update `dashboard/package.json` test script**

In `package.json`, append `tests/lmstudio.test.js` to the end of the test script:

```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js tests/telegram.test.js tests/github.test.js tests/ollama.test.js tests/lmstudio.test.js"
```

- [ ] **Step 5: Run the lmstudio tests**

```
cd dashboard && node --test tests/lmstudio.test.js 2>&1 | tail -10
```

Expected: 3 module tests pass. The 4 route tests fail with 404 — that is expected at this stage; the routes are added in Task 2. 

- [ ] **Step 6: Run the full test suite**

```
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 182
ℹ pass 176
ℹ fail 6
```

(2 pre-existing EPERM + 4 route tests failing until Task 2 — this is correct.)

- [ ] **Step 7: Commit**

```
git add dashboard/lmstudio.js dashboard/tests/lmstudio.test.js dashboard/package.json
git commit -m "feat(sp13b): add lmstudio.js — OpenAI-compat client, TEST_MODE guards, module tests"
```

---

### Task 2: `server.js` wiring

**Files:**
- Modify: `dashboard/server.js`
  - Add import of `isLmStudioReachable`, `listModels as listLmStudioModels`, `generate as lmStudioGenerate` from `./lmstudio.js`
  - Add `GET /api/lmstudio/status` route
  - Add `POST /api/lmstudio/generate` route
  - Update `GET /health` to include LM Studio reachability

**Interfaces:**
- Consumes (from Task 1):
  - `isLmStudioReachable(): Promise<boolean>`
  - `listModels(): Promise<string[]>` (imported as `listLmStudioModels`)
  - `generate(model, prompt): Promise<string>` (imported as `lmStudioGenerate`)
- Produces: nothing consumed by other tasks.

---

- [ ] **Step 1: Add `lmstudio.js` import to `server.js`**

In `dashboard/server.js`, after line 23 (the existing `ollama.js` import):

```js
import { isOllamaReachable, listModels, generate } from './ollama.js';
import { isLmStudioReachable, listModels as listLmStudioModels, generate as lmStudioGenerate } from './lmstudio.js';
```

- [ ] **Step 2: Update the `/health` endpoint (lines 302–311)**

Replace the existing health handler:

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

With:

```js
  app.get('/health', async (_req, res) => {
    const [forgejoOk, ollamaOk, lmstudioOk] = await Promise.all([
      isForgejoReachable(), isOllamaReachable(), isLmStudioReachable(),
    ]);
    res.json({
      status: forgejoOk ? 'ok' : 'degraded',
      uptime: Math.floor(process.uptime()),
      db: 'connected',
      forgejo:  forgejoOk  ? 'reachable' : 'unreachable',
      ollama:   ollamaOk   ? 'reachable' : 'unreachable',
      lmstudio: lmstudioOk ? 'reachable' : 'unreachable',
    });
  });
```

- [ ] **Step 3: Add LM Studio routes after the Ollama routes block (after line 330)**

After the closing `});` of `POST /api/ollama/generate` (currently line 330), add:

```js
  // --- LM Studio routes ---

  app.get('/api/lmstudio/status', async (_req, res) => {
    const reachable = await isLmStudioReachable();
    const models = reachable ? await listLmStudioModels() : [];
    res.json({ reachable, models });
  });

  app.post('/api/lmstudio/generate', async (req, res) => {
    const { model, prompt } = req.body ?? {};
    if (!model || !prompt) return res.status(400).json({ error: 'model and prompt required' });
    try {
      const response = await lmStudioGenerate(model, prompt);
      res.json({ response });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 4: Run the full test suite — expect 182 total, 180 pass**

```
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 182
ℹ pass 180
ℹ fail 2
```

(Only the 2 pre-existing Windows EPERM failures remain.)

- [ ] **Step 5: Commit**

```
git add dashboard/server.js
git commit -m "feat(sp13b): wire LM Studio routes into server.js and health endpoint"
```

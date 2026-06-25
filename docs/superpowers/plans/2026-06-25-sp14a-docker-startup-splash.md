# SP14a: Docker Startup Splash Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen splash overlay that auto-starts Docker/Forgejo and polls until it is reachable before showing the dashboard.

**Architecture:** A new `POST /api/docker/start` route runs `docker compose up -d` server-side. The frontend adds a `#splash` overlay (visible by default) and replaces the bare `connect()` call with a `startup()` function that health-checks Forgejo, fires the start route if needed, polls every 3 seconds, then dismisses the splash and calls `connect()` once Forgejo responds.

**Tech Stack:** Node.js (`execSync`), vanilla JS, CSS animation.

## Global Constraints

- No new npm dependencies.
- No DB schema changes.
- `docker compose up -d` runs with `cwd: FLINT_ROOT` (already defined in `server.js` as `join(__dirname, '..')`).
- `TEST_MODE` in server.js is already defined as the boolean `const TEST_MODE = process.env.FLINT_TEST_MODE === '1'` — use it directly (not a function).
- `execSync` is already imported in `server.js` (`import { execSync } from 'child_process'`).
- Splash background: `#0d1117`. Accent blue: `#58a6ff`. Muted text: `#8b949e`. Error red: `#f85149`.
- Logo path: `/images/Flint Logo 1.jpg` (already served).
- `node --test` must pass all existing + new tests. Target: 182 existing + 3 new = 185 total (183 pass, 2 pre-existing Windows EPERM).
- All commits on `master`.

---

### Task 1: `POST /api/docker/start` route + tests

**Files:**
- Modify: `dashboard/server.js` — add Docker route after LM Studio routes (after line 353)
- Create: `dashboard/tests/docker.test.js`
- Modify: `dashboard/package.json` — append `tests/docker.test.js` to test script

**Interfaces:**
- Consumes: `FLINT_ROOT` (line 26 of server.js), `TEST_MODE` (line 28), `execSync` (imported line 4)
- Produces: `POST /api/docker/start` → `{ ok: true }` or `{ ok: false, error: string }` (consumed by Task 2's frontend `startup()`)

---

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/docker.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-docker-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-docker-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-docker-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

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

test('POST /api/docker/start returns { ok: true } in TEST_MODE', async () => {
  const r = await req('POST', '/api/docker/start');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
});

test('POST /api/docker/start requires no request body', async () => {
  const r = await fetch(`${baseUrl}/api/docker/start`, { method: 'POST' });
  assert.equal(r.status, 200);
});

test('GET /health response includes forgejo field', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('forgejo' in body, 'health response has forgejo field');
});
```

- [ ] **Step 2: Run tests — expect failure (route not yet created)**

```
cd dashboard && node --test tests/docker.test.js 2>&1 | tail -5
```

Expected: error — `POST /api/docker/start` returns 404.

- [ ] **Step 3: Add the Docker route to `server.js`**

In `dashboard/server.js`, after line 353 (the closing `});` of `POST /api/lmstudio/generate`) and before the `// --- Project routes ---` comment, add:

```js
  // --- Docker routes ---

  app.post('/api/docker/start', (_req, res) => {
    if (TEST_MODE) return res.json({ ok: true });
    try {
      execSync('docker compose up -d', { cwd: FLINT_ROOT, timeout: 30000 });
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });
```

- [ ] **Step 4: Update `dashboard/package.json` test script**

Append `tests/docker.test.js` to the end of the test script:

```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js tests/telegram.test.js tests/github.test.js tests/ollama.test.js tests/lmstudio.test.js tests/docker.test.js"
```

- [ ] **Step 5: Run the full test suite — expect 185 total, 183 pass**

```
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 185
ℹ pass 183
ℹ fail 2
```

(Only the 2 pre-existing Windows EPERM failures remain.)

- [ ] **Step 6: Commit**

```
git add dashboard/server.js dashboard/tests/docker.test.js dashboard/package.json
git commit -m "feat(sp14a): add POST /api/docker/start route — runs docker compose up -d"
```

---

### Task 2: Splash overlay — HTML + CSS + `app.js` startup

**Files:**
- Modify: `dashboard/public/index.html` — add `<div id="splash">` as first child of `<body>`
- Modify: `dashboard/public/style.css` — add splash overlay styles at end of file
- Modify: `dashboard/public/app.js` — replace `connect();` (last line, line 1329) with `startup()` function

**Interfaces:**
- Consumes (from Task 1): `POST /api/docker/start` → `{ ok: boolean }`
- Consumes: `GET /health` → `{ forgejo: 'reachable' | 'unreachable', ... }`
- Produces: nothing consumed by other tasks.

---

- [ ] **Step 1: Add the splash div to `index.html`**

In `dashboard/public/index.html`, insert immediately after the opening `<body>` tag (before `<header id="header">`):

```html
  <div id="splash">
    <img src="/images/Flint Logo 1.jpg" class="splash-logo" alt="Flint">
    <div class="splash-brand">FLINT</div>
    <div class="splash-subtitle">Your Friendly AI Agent OS</div>
    <div class="splash-spinner"></div>
    <div id="splash-message" class="splash-message">Checking services…</div>
    <div id="splash-error" class="splash-error hidden"></div>
  </div>
```

- [ ] **Step 2: Add splash styles to `style.css`**

Append to the end of `dashboard/public/style.css`:

```css
/* Splash overlay */
#splash {
  position: fixed; inset: 0; background: #0d1117; z-index: 9999;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
}
#splash.hidden { display: none; }
.splash-logo { width: 100px; height: 100px; border-radius: 50%; object-fit: cover; background: #fff; padding: 4px; }
.splash-brand { font-weight: bold; color: #58a6ff; font-size: 36px; }
.splash-subtitle { color: #8b949e; font-size: 18px; }
.splash-message { color: #8b949e; font-size: 14px; }
.splash-error { color: #f85149; font-size: 14px; text-align: center; max-width: 400px; line-height: 1.5; }
.splash-spinner {
  width: 32px; height: 32px;
  border: 3px solid #30363d; border-top-color: #58a6ff;
  border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 3: Replace `connect()` with `startup()` in `app.js`**

In `dashboard/public/app.js`, replace the last line:

```js
connect();
```

With:

```js
async function startup() {
  try {
    const h = await fetch('/health').then(r => r.json());
    if (h.forgejo === 'reachable') {
      document.getElementById('splash').classList.add('hidden');
      connect();
      return;
    }
  } catch {}

  document.getElementById('splash-message').textContent = 'Starting Forgejo…';
  try { await fetch('/api/docker/start', { method: 'POST' }); } catch {}

  let elapsed = 0;
  const poll = setInterval(async () => {
    elapsed += 3;
    try {
      const h = await fetch('/health').then(r => r.json());
      if (h.forgejo === 'reachable') {
        clearInterval(poll);
        document.getElementById('splash').classList.add('hidden');
        connect();
        return;
      }
    } catch {}
    if (elapsed >= 60) {
      clearInterval(poll);
      document.getElementById('splash-message').textContent = '';
      const err = document.getElementById('splash-error');
      err.textContent = 'Could not reach Forgejo. Run `docker compose up -d` in a terminal, then refresh.';
      err.classList.remove('hidden');
    }
  }, 3000);
}

startup();
```

- [ ] **Step 4: Run the full test suite — expect same count as Task 1**

```
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 185
ℹ pass 183
ℹ fail 2
```

(Task 2 adds no new server tests — the frontend changes are not covered by the automated suite.)

- [ ] **Step 5: Commit**

```
git add dashboard/public/index.html dashboard/public/style.css dashboard/public/app.js
git commit -m "feat(sp14a): add splash overlay — polls health, auto-starts Docker, dismisses on Forgejo ready"
```

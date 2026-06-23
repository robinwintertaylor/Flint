# SP5: Self-Improvement + CLI Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CLI-based LLM providers (claude-cli, gemini-cli, mistral-cli) to the router, git worktree isolation for self-modification agents, and an agent suggestion feed.

**Architecture:** CLI providers are subprocess adapters in the existing ADAPTERS pattern — they spawn the binary with the prompt via stdin and return cost=$0. Worktree isolation uses `git worktree` to give an agent its own branch to work on; the DB tracks which agent owns which worktree so the dashboard can offer merge/discard. Suggestions are PTY output lines prefixed `## SUGGESTION:` that are captured into a DB table and surfaced in the dashboard and CLI.

**Tech Stack:** Node.js 20+ ESM, better-sqlite3, child_process.spawn (CLI providers), child_process.execSync (git), node:test + node:assert/strict (tests), existing express/ws server.

## Global Constraints

- Node.js 20+, ESM throughout — `import`/`export`, no `require()`
- `better-sqlite3` singleton: `getDb()` after `initDb()` — never `new Database()` directly
- `node:test` + `node:assert/strict` — no external test framework
- `FLINT_TEST_MODE=1` stubs all LLM calls; also skips PTY spawn
- `FLINT_DB_PATH` / `FLINT_AGENTS_FILE` env vars for test isolation
- Dashboard runs on `http://localhost:3000`, router on `http://localhost:3001`
- Flint root: `C:\Users\Robin\Applications Dev\Flint\`
- Never interpolate user input into SQL strings — use parameterised `?` placeholders
- All `createApp()` factory pattern in server.js (returns `http.Server`)
- Existing 43 dashboard tests must continue to pass; existing 5 router tests must pass

---

## File Structure

```
Modified:
  router/providers.js       ← add completeCli() + 3 ADAPTERS entries
  router/config.js          ← add cli group to getModels(); recognise cli providers
  router/tests/router.test.js ← 3 new CLI provider tests
  dashboard/db.js           ← suggestions table; worktree ALTER TABLEs; 4 new exports
  dashboard/agents.js       ← add broadcastGlobal() + addGlobalWsClient/removeGlobalWsClient
  dashboard/terminal.js     ← SUGGESTION_REGEX detection; worktree_pending on exit
  dashboard/server.js       ← suggestion routes; worktree routes; spawn isolate handler
  dashboard/public/index.html ← isolate checkbox in modal; #suggestions-strip div
  dashboard/public/app.js   ← suggestion rendering; worktree UI; isolate in spawn msg
  dashboard/public/style.css ← suggestion strip styles; isolated badge
  bin/flint.js              ← cmdSuggestions + cmdWorktree subcommands

Created:
  dashboard/suggestions.js  ← createSuggestion / listSuggestions / updateSuggestion
  dashboard/worktrees.js    ← createWorktree / listWorktrees / mergeWorktree / discardWorktree
  dashboard/tests/sp5.test.js ← 9 new dashboard tests
```

---

### Task 1: CLI Providers (Router)

**Files:**
- Modify: `router/providers.js`
- Modify: `router/config.js`
- Modify: `router/tests/router.test.js`

**Interfaces:**
- Produces: `complete('claude-cli'|'gemini-cli'|'mistral-cli', binaryName, messages)` → `{ text, costUsd: 0, tokensIn: 0, tokensOut: 0 }`
- Produces: `getModels()` returns `{ ..., cli: ['claude', 'gemini'] }` when cli providers in router.json

- [ ] **Step 1: Write failing router tests**

Add three tests to `router/tests/router.test.js`. The file already sets `FLINT_TEST_MODE=1` at the top and imports `{ route }` from `../router.js`. Add these tests AFTER the existing 5 tests, and also update CONFIG to include cli providers:

```js
// Update CONFIG (replace existing CONFIG declaration):
const CONFIG = {
  tiers: {
    '1': {
      anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini',
      google: 'gemini-2.0-flash', azure: 'gpt-4o-mini',
      openrouter: 'mistral/mistral-small',
      'claude-cli': 'claude', 'gemini-cli': 'gemini',
    },
    '2': { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', google: 'gemini-2.0-pro', azure: 'gpt-4o', openrouter: 'mistral/mistral-medium' },
    '3': { anthropic: 'claude-opus-4-6', openai: 'gpt-4.5', google: 'gemini-2.5-pro', azure: 'gpt-4.5', openrouter: 'mistral/mistral-large' }
  },
  taskTypes: {
    'research': { tier: 2, provider: 'anthropic' },
    'code':     { tier: 2, provider: 'openai' }
  },
  defaultProvider: 'anthropic',
  defaultTier: 2
};
```

Then add the new tests at the end of the file (before `after()`):

```js
// Add these imports at top (after existing imports):
import { complete } from '../providers.js';
import { getModels, resetConfig } from '../config.js';

// Add these 3 tests after the existing 5 tests:
test('complete claude-cli returns stub in test mode', async () => {
  const result = await complete('claude-cli', 'claude', [{ role: 'user', content: 'hello' }]);
  assert.equal(result.text, 'stub response');
  assert.equal(result.costUsd, 0.001);
});

test('complete gemini-cli returns stub in test mode', async () => {
  const result = await complete('gemini-cli', 'gemini', [{ role: 'user', content: 'hello' }]);
  assert.equal(result.text, 'stub response');
});

test('getModels includes cli group when router.json has cli providers', () => {
  resetConfig();
  const models = getModels();
  assert.ok(Array.isArray(models.cli), 'cli group should exist');
  assert.ok(models.cli.includes('claude'), 'cli group should include claude binary');
  assert.ok(models.cli.includes('gemini'), 'cli group should include gemini binary');
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd "C:\Users\Robin\Applications Dev\Flint"
node --test router/tests/router.test.js
```

Expected: 3 new tests fail. "cli" group likely undefined, complete('claude-cli') may throw "Unknown provider".

- [ ] **Step 3: Implement CLI provider adapter in `router/providers.js`**

Add `import { spawn } from 'child_process';` at the top of the file (after existing imports).

Then add `buildCliPrompt`, `completeCli`, the `CLI_EXTRA_ARGS` map, and the three new ADAPTERS entries. Insert BEFORE the existing `const ADAPTERS = {` line:

```js
import { spawn } from 'child_process';
```

Then after `completeOpenRouter` and before `const ADAPTERS`, add:

```js
// Maps provider name → extra CLI args (beyond the binary name)
const CLI_EXTRA_ARGS = {
  'claude-cli':  ['-p'],
  'gemini-cli':  [],
  'mistral-cli': ['chat', '--no-interactive'],
};

function buildCliPrompt(messages) {
  const parts = [];
  const system = messages.find(m => m.role === 'system');
  if (system) {
    parts.push(system.content);
    parts.push('');
  }
  for (const m of messages.filter(m => m.role !== 'system')) {
    parts.push(m.content);
  }
  return parts.join('\n');
}

async function completeCli(provider, model, messages) {
  const extraArgs = CLI_EXTRA_ARGS[provider] ?? [];
  const prompt = buildCliPrompt(messages);

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(model, extraArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new Error(`CLI not found: ${model}`));
    }

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`CLI timeout after 120s: ${model}`));
    }, 120_000);

    const stdout = [];
    const stderr = [];

    proc.stdout.on('data', d => stdout.push(d));
    proc.stderr.on('data', d => stderr.push(d));

    proc.on('error', () => {
      clearTimeout(timer);
      reject(new Error(`CLI not found: ${model}`));
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CLI error: ${Buffer.concat(stderr).toString().trim()}`));
      } else {
        resolve({
          text: Buffer.concat(stdout).toString().trim(),
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
        });
      }
    });

    proc.stdin.write(prompt, () => proc.stdin.end());
  });
}
```

Then update the ADAPTERS object to add the three CLI entries:

```js
const ADAPTERS = {
  anthropic:     completeAnthropic,
  openai:        completeOpenAI,
  google:        completeGoogle,
  azure:         completeAzure,
  openrouter:    completeOpenRouter,
  'claude-cli':  (model, msgs) => completeCli('claude-cli',  model, msgs),
  'gemini-cli':  (model, msgs) => completeCli('gemini-cli',  model, msgs),
  'mistral-cli': (model, msgs) => completeCli('mistral-cli', model, msgs),
};
```

- [ ] **Step 4: Update `router/config.js` to recognise CLI providers**

Replace the `getModels` function:

```js
export function getModels() {
  const cfg = getConfig();
  const CLI_PROVIDERS = new Set(['claude-cli', 'gemini-cli', 'mistral-cli']);
  const result = { anthropic: [], openai: [], google: [], azure: [], openrouter: [], cli: [] };
  for (const tierModels of Object.values(cfg.tiers)) {
    for (const [provider, model] of Object.entries(tierModels)) {
      if (CLI_PROVIDERS.has(provider)) {
        if (!result.cli.includes(model)) result.cli.push(model);
      } else if (result[provider] && !result[provider].includes(model)) {
        result[provider].push(model);
      }
    }
  }
  return result;
}
```

- [ ] **Step 5: Run router tests to confirm all pass**

```bash
node --test router/tests/router.test.js
```

Expected: 8 tests pass (5 existing + 3 new). Output like:
```
✔ route with taskType returns stub text and correct model
✔ route with explicit model bypasses routing
...
✔ complete claude-cli returns stub in test mode
✔ complete gemini-cli returns stub in test mode
✔ getModels includes cli group when router.json has cli providers
```

- [ ] **Step 6: Run all existing dashboard tests to confirm no regressions**

```bash
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js
```

Expected: 43 tests pass.

- [ ] **Step 7: Commit**

```bash
git add router/providers.js router/config.js router/tests/router.test.js
git commit -m "feat(router): add claude-cli, gemini-cli, mistral-cli providers via subprocess stdin"
```

---

### Task 2: DB Schema + Broadcast Infrastructure

**Files:**
- Modify: `dashboard/db.js`
- Modify: `dashboard/agents.js`

**Interfaces:**
- Produces (db.js): `upsertAgentLog(name, { mode, workdir, status })`, `setAgentWorktree(name, path, branch)`, `clearAgentWorktree(name)`, `getAgentWorktree(name)` → `{ worktree_path, worktree_branch } | undefined`
- Produces (agents.js): `addGlobalWsClient(ws)`, `removeGlobalWsClient(ws)`, `broadcastGlobal(data)`

- [ ] **Step 1: Write failing DB tests**

These live in `dashboard/tests/sp5.test.js` — create that file now with just the DB-layer tests. Full server/suggestion tests will be added in Task 7, but these DB tests run standalone:

```js
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), 'flint-sp5-test-' + Date.now());
mkdirSync(TMP, { recursive: true });

process.env.FLINT_TEST_MODE  = '1';
process.env.FLINT_DB_PATH    = join(TMP, 'usage.sqlite');
process.env.FLINT_AGENTS_FILE = join(TMP, 'agents.json');

const { initDb, closeDb, upsertAgentLog, setAgentWorktree, getAgentWorktree, clearAgentWorktree } = await import('../db.js');
const { createSuggestion, listSuggestions, updateSuggestion } = await import('../suggestions.js');
const { listWorktrees } = await import('../worktrees.js');

before(() => initDb(process.env.FLINT_DB_PATH));
after(async () => {
  closeDb();
  await new Promise(r => setTimeout(r, 100));
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_DB_PATH;
  delete process.env.FLINT_AGENTS_FILE;
});

// --- Suggestion DB tests ---

test('createSuggestion inserts a row', () => {
  createSuggestion('agent-a', 'Cache getProject() calls');
  const list = listSuggestions();
  const found = list.find(s => s.agent_name === 'agent-a' && s.content === 'Cache getProject() calls');
  assert.ok(found, 'suggestion should be in list');
  assert.equal(found.status, 'new');
});

test('createSuggestion deduplicates within 60s', () => {
  createSuggestion('agent-b', 'Same content');
  createSuggestion('agent-b', 'Same content');
  const list = listSuggestions();
  const matches = list.filter(s => s.agent_name === 'agent-b' && s.content === 'Same content');
  assert.equal(matches.length, 1, 'duplicate should not be inserted');
});

test('listSuggestions excludes dismissed', () => {
  createSuggestion('agent-c', 'Will be dismissed');
  const all = listSuggestions();
  const row = all.find(s => s.agent_name === 'agent-c');
  assert.ok(row);
  updateSuggestion(row.id, { status: 'dismissed' });
  const after = listSuggestions();
  assert.ok(!after.find(s => s.id === row.id), 'dismissed should be excluded');
});

test('updateSuggestion changes status to noted', () => {
  createSuggestion('agent-d', 'Note this');
  const list = listSuggestions();
  const row = list.find(s => s.agent_name === 'agent-d');
  updateSuggestion(row.id, { status: 'noted' });
  const updated = listSuggestions().find(s => s.id === row.id);
  assert.equal(updated.status, 'noted');
});

// --- Worktree DB tests ---

test('listWorktrees returns only rows with non-null worktree_path', () => {
  upsertAgentLog('wt-agent', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  upsertAgentLog('no-wt-agent', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  setAgentWorktree('wt-agent', '/tmp/.worktrees/wt-agent-123', 'improve/wt-agent-123');
  const list = listWorktrees();
  assert.ok(list.some(r => r.name === 'wt-agent'), 'wt-agent should appear');
  assert.ok(!list.some(r => r.name === 'no-wt-agent'), 'no-wt-agent should not appear');
});

test('getAgentWorktree returns null when no worktree set', () => {
  upsertAgentLog('plain-agent', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  const wt = getAgentWorktree('plain-agent');
  assert.ok(!wt?.worktree_branch);
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/sp5.test.js
```

Expected: failures — `upsertAgentLog`, `suggestions.js`, `worktrees.js` not found yet.

- [ ] **Step 3: Add schema and new exports to `dashboard/db.js`**

Add the `suggestions` table to `initDb`'s `_db.exec` block (inside the template string, after `project_agents`):

```js
    CREATE TABLE IF NOT EXISTS suggestions (
      id          INTEGER PRIMARY KEY,
      agent_name  TEXT NOT NULL,
      content     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'new',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
```

After the closing `);` of `_db.exec(...)`, add the two worktree `ALTER TABLE` statements using try/catch (SQLite doesn't support `ADD COLUMN IF NOT EXISTS`):

```js
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN worktree_path TEXT'); } catch {}
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN worktree_branch TEXT'); } catch {}
```

Then add four new exported functions at the end of the file, before `export function getDb()`:

```js
export function upsertAgentLog(name, { mode, workdir, status } = {}) {
  _db.prepare(`
    INSERT INTO agents_log (name, mode, workdir, status, last_seen)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET
      mode = excluded.mode,
      workdir = excluded.workdir,
      status = excluded.status,
      last_seen = excluded.last_seen
  `).run(name, mode ?? null, workdir ?? null, status ?? null);
}

export function setAgentWorktree(name, worktreePath, worktreeBranch) {
  getDb().prepare(
    `UPDATE agents_log SET worktree_path = ?, worktree_branch = ? WHERE name = ?`
  ).run(worktreePath, worktreeBranch, name);
}

export function clearAgentWorktree(name) {
  getDb().prepare(
    `UPDATE agents_log SET worktree_path = NULL, worktree_branch = NULL WHERE name = ?`
  ).run(name);
}

export function getAgentWorktree(name) {
  return getDb().prepare(
    `SELECT worktree_path, worktree_branch FROM agents_log WHERE name = ?`
  ).get(name);
}
```

- [ ] **Step 4: Add global broadcast to `dashboard/agents.js`**

Add a `globalWsClients` Set and three exported functions. Insert after the `const registry = new Map();` line:

```js
const globalWsClients = new Set();

export function addGlobalWsClient(ws) { globalWsClients.add(ws); }
export function removeGlobalWsClient(ws) { globalWsClients.delete(ws); }

export function broadcastGlobal(data) {
  const json = JSON.stringify(data);
  for (const ws of globalWsClients) {
    if (ws.readyState === 1) ws.send(json);
  }
}
```

- [ ] **Step 5: Run sp5.test.js DB tests — they should now fail only on missing modules**

```bash
node --test tests/sp5.test.js
```

The DB-layer tests should fail with "Cannot find module '../suggestions.js'" and "../worktrees.js" — not schema errors. Verify schema is correct by checking no SQLite errors appear.

- [ ] **Step 6: Run full existing test suite to confirm no regressions**

```bash
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js
```

Expected: 43 tests pass.

- [ ] **Step 7: Commit**

```bash
git add dashboard/db.js dashboard/agents.js dashboard/tests/sp5.test.js
git commit -m "feat(db): add suggestions table, worktree columns, upsertAgentLog, global WS broadcast"
```

---

### Task 3: Suggestions + Worktrees Modules

**Files:**
- Create: `dashboard/suggestions.js`
- Create: `dashboard/worktrees.js`

**Interfaces:**
- Consumes (both): `getDb()`, `clearAgentWorktree()` from `./db.js`
- Produces (suggestions.js): `createSuggestion(agentName, content)` → inserted row `{ id, agent_name, content, status, created_at }` or `null` (dedup); `listSuggestions()` → array; `updateSuggestion(id, { status })` → void
- Produces (worktrees.js): `createWorktree(agentName)` → `{ worktreePath, branch }`; `listWorktrees()` → array; `mergeWorktree(agentName)` → void; `discardWorktree(agentName)` → void

- [ ] **Step 1: Create `dashboard/suggestions.js`**

```js
import { getDb } from './db.js';

export function createSuggestion(agentName, content) {
  const db = getDb();
  const recent = db.prepare(
    `SELECT id FROM suggestions
     WHERE agent_name = ? AND content = ?
     AND created_at >= datetime('now', '-60 seconds')`
  ).get(agentName, content);
  if (recent) return null;
  const result = db.prepare(
    `INSERT INTO suggestions (agent_name, content) VALUES (?, ?)`
  ).run(agentName, content);
  return db.prepare(
    `SELECT id, agent_name, content, status, created_at FROM suggestions WHERE id = ?`
  ).get(result.lastInsertRowid);
}

export function listSuggestions() {
  return getDb().prepare(
    `SELECT id, agent_name, content, status, created_at
     FROM suggestions WHERE status != 'dismissed'
     ORDER BY created_at DESC`
  ).all();
}

export function updateSuggestion(id, { status }) {
  getDb().prepare(`UPDATE suggestions SET status = ? WHERE id = ?`).run(status, id);
}
```

- [ ] **Step 2: Create `dashboard/worktrees.js`**

```js
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDb, clearAgentWorktree } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function createWorktree(agentName) {
  const ts = timestamp();
  const branch = `improve/${agentName}-${ts}`;
  const worktreePath = join(FLINT_ROOT, '.worktrees', `${agentName}-${ts}`);
  execSync(`git worktree add -b "${branch}" "${worktreePath}"`, { cwd: FLINT_ROOT });
  return { worktreePath, branch };
}

export function listWorktrees() {
  return getDb().prepare(
    `SELECT name, worktree_path, worktree_branch, status
     FROM agents_log WHERE worktree_path IS NOT NULL`
  ).all();
}

export function mergeWorktree(agentName) {
  const row = getDb().prepare(
    `SELECT worktree_path, worktree_branch FROM agents_log WHERE name = ?`
  ).get(agentName);
  if (!row?.worktree_branch) throw new Error(`No worktree for agent: ${agentName}`);
  execSync(`git merge "${row.worktree_branch}"`, { cwd: FLINT_ROOT });
  execSync(`git worktree remove --force "${row.worktree_path}"`, { cwd: FLINT_ROOT });
  execSync(`git branch -d "${row.worktree_branch}"`, { cwd: FLINT_ROOT });
  clearAgentWorktree(agentName);
}

export function discardWorktree(agentName) {
  const row = getDb().prepare(
    `SELECT worktree_path, worktree_branch FROM agents_log WHERE name = ?`
  ).get(agentName);
  if (!row?.worktree_branch) throw new Error(`No worktree for agent: ${agentName}`);
  execSync(`git worktree remove --force "${row.worktree_path}"`, { cwd: FLINT_ROOT });
  execSync(`git branch -D "${row.worktree_branch}"`, { cwd: FLINT_ROOT });
  clearAgentWorktree(agentName);
}
```

- [ ] **Step 3: Run sp5.test.js — DB layer tests should now pass**

```bash
node --test tests/sp5.test.js
```

Expected: 7 tests pass (suggestion + worktree DB tests). Any HTTP tests added in step 1 will still fail since server routes don't exist yet.

- [ ] **Step 4: Run full dashboard test suite to confirm no regressions**

```bash
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js
```

Expected: 43 tests pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/suggestions.js dashboard/worktrees.js
git commit -m "feat(dashboard): add suggestions and worktrees modules"
```

---

### Task 4: Server Routes + Terminal Integration

**Files:**
- Modify: `dashboard/server.js`
- Modify: `dashboard/terminal.js`

**Interfaces:**
- Consumes: `createSuggestion`, `listSuggestions`, `updateSuggestion` from `./suggestions.js`
- Consumes: `createWorktree`, `listWorktrees`, `mergeWorktree`, `discardWorktree` from `./worktrees.js`
- Consumes: `upsertAgentLog`, `setAgentWorktree`, `getAgentWorktree` from `./db.js`
- Consumes: `addGlobalWsClient`, `removeGlobalWsClient`, `broadcastGlobal` from `./agents.js`
- Produces: REST routes `GET /suggestions`, `PATCH /suggestions/:id`, `GET /worktrees`, `POST /worktrees/:agent/merge`, `DELETE /worktrees/:agent`
- Produces: WebSocket broadcast `{ type: 'suggestion', suggestion: {...} }` on new suggestion
- Produces: WebSocket broadcast `{ type: 'worktree_pending', agent, branch }` on PTY exit with pending worktree

- [ ] **Step 1: Update `dashboard/server.js` imports**

Change the import lines at the top of server.js:

Replace:
```js
import { initDb, getTodayCost, getMonthCost, closeDb } from './db.js';
import { initAgents, registerAgent, listAgents, getAgent, addWsClient, removeWsClient, killAgent, broadcastToAgent } from './agents.js';
```

With:
```js
import { initDb, getTodayCost, getMonthCost, closeDb, upsertAgentLog, setAgentWorktree, getAgentWorktree } from './db.js';
import { initAgents, registerAgent, listAgents, getAgent, addWsClient, removeWsClient, killAgent, broadcastToAgent, addGlobalWsClient, removeGlobalWsClient } from './agents.js';
import { listSuggestions, updateSuggestion } from './suggestions.js';
import { listWorktrees, createWorktree, mergeWorktree, discardWorktree } from './worktrees.js';
```

- [ ] **Step 2: Add suggestion REST routes to `dashboard/server.js`**

Add these routes after the project routes block (before the `// --- WebSocket ---` comment):

```js
  // --- Suggestion routes ---

  app.get('/suggestions', (_req, res) => {
    res.json(listSuggestions());
  });

  app.patch('/suggestions/:id', (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    const VALID = ['new', 'noted', 'dismissed'];
    if (!VALID.includes(status)) return res.status(400).json({ error: 'invalid status' });
    updateSuggestion(id, { status });
    res.json({ ok: true });
  });

  // --- Worktree routes ---

  app.get('/worktrees', (_req, res) => {
    res.json(listWorktrees());
  });

  app.post('/worktrees/:agent/merge', (req, res) => {
    try {
      mergeWorktree(req.params.agent);
      broadcastToAgent(req.params.agent, { type: 'worktree_merged', agent: req.params.agent });
      res.json({ ok: true });
    } catch (err) {
      if (err.message.includes('No worktree')) return res.status(404).json({ error: err.message });
      res.status(400).json({ error: `merge conflict: ${err.message}` });
    }
  });

  app.delete('/worktrees/:agent', (req, res) => {
    try {
      discardWorktree(req.params.agent);
      broadcastToAgent(req.params.agent, { type: 'worktree_discarded', agent: req.params.agent });
      res.json({ ok: true });
    } catch (err) {
      if (err.message.includes('No worktree')) return res.status(404).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 3: Update the WebSocket `spawn` handler in `dashboard/server.js`**

Replace the existing `case 'spawn':` block:

```js
        case 'spawn': {
          const { agent: name, workdir, model, isolate } = msg;
          if (!name || !workdir) break;
          registerAgent(name, 'spawn', workdir, null, model);
          upsertAgentLog(name, { mode: 'spawn', workdir, status: 'running' });
          if (!TEST_MODE) {
            let spawnDir = workdir;
            if (isolate) {
              const { worktreePath, branch } = createWorktree(name);
              setAgentWorktree(name, worktreePath, branch);
              spawnDir = worktreePath;
            }
            spawnAgent(name, spawnDir, model);
          }
          broadcastToAgent(name, { type: 'status', agent: name, status: 'running' });
          break;
        }
```

- [ ] **Step 4: Update WebSocket connection handler in `dashboard/server.js` for global clients**

Replace the `wss.on('connection', (ws) => {` block's opening and closing:

Change:
```js
  wss.on('connection', (ws) => {
    ws.on('error', () => {});
```

To:
```js
  wss.on('connection', (ws) => {
    addGlobalWsClient(ws);
    ws.on('error', () => {});
```

And change the `ws.on('close', ...)` handler:

```js
    ws.on('close', () => {
      removeGlobalWsClient(ws);
      for (const name of subscriptions) removeWsClient(name, ws);
    });
```

- [ ] **Step 5: Update `dashboard/terminal.js`**

Add imports at the top:

```js
import { createSuggestion } from './suggestions.js';
import { getAgentWorktree } from './db.js';
import { broadcastGlobal } from './agents.js';
```

Add the SUGGESTION_REGEX constant after MODEL_REGEX:

```js
const SUGGESTION_REGEX = /^## SUGGESTION:\s*(.+?)(?=\n\n|\n##|\n$|$)/ms;
```

In `ptyProcess.onData`, add suggestion detection after the `costMatch` block (before the closing `});`):

```js
    const suggMatch = data.match(SUGGESTION_REGEX);
    if (suggMatch) {
      const suggestion = createSuggestion(name, suggMatch[1].trim());
      if (suggestion) {
        broadcastGlobal({ type: 'suggestion', suggestion });
      }
    }
```

In `ptyProcess.onExit`, add worktree_pending broadcast. Replace:

```js
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
```

With:

```js
  ptyProcess.onExit(() => {
    // Save last session output as summary on linked project
    const project = getProjectForAgent(name);
    if (project && outputBuffer.length > 0) {
      updateProject(project.id, { last_summary: outputBuffer.join('\n') });
    }

    // Notify UI if agent had an isolated worktree
    const worktree = getAgentWorktree(name);
    if (worktree?.worktree_branch) {
      broadcastToAgent(name, { type: 'worktree_pending', agent: name, branch: worktree.worktree_branch });
    }

    agent.ptyProcess = null;
    lastCost = 0;
    setAgentStatus(name, 'stopped');
  });
```

- [ ] **Step 6: Add HTTP tests to `dashboard/tests/sp5.test.js`**

Append these tests to the existing sp5.test.js file (after the worktree DB tests):

```js
// --- HTTP tests ---

describe('Suggestion HTTP routes', () => {
  let server;
  let port;

  before(async () => {
    const { createApp } = await import('../server.js');
    server = createApp();
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
  });

  after(() => new Promise(r => server.close(r)));

  test('GET /suggestions returns only non-dismissed', async () => {
    // createSuggestion was called in DB tests above — some should exist
    const res = await fetch(`http://localhost:${port}/suggestions`);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
    assert.ok(list.every(s => s.status !== 'dismissed'), 'no dismissed in response');
  });

  test('PATCH /suggestions/:id updates status', async () => {
    // Insert a fresh suggestion
    createSuggestion('http-test-agent', 'A testable suggestion');
    const allRes = await fetch(`http://localhost:${port}/suggestions`);
    const all = await allRes.json();
    const row = all.find(s => s.agent_name === 'http-test-agent');
    assert.ok(row);

    const patchRes = await fetch(`http://localhost:${port}/suggestions/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'noted' }),
    });
    assert.equal(patchRes.status, 200);
    const body = await patchRes.json();
    assert.equal(body.ok, true);
  });
});

describe('Worktree HTTP routes', () => {
  let server;
  let port;

  before(async () => {
    const { createApp } = await import('../server.js');
    server = createApp();
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
  });

  after(() => new Promise(r => server.close(r)));

  test('GET /worktrees returns empty array when no worktrees active', async () => {
    const res = await fetch(`http://localhost:${port}/worktrees`);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
  });

  test('POST /worktrees/:agent/merge returns 404 for unknown agent', async () => {
    const res = await fetch(`http://localhost:${port}/worktrees/nonexistent-agent/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 404);
  });

  test('DELETE /worktrees/:agent returns 404 for unknown agent', async () => {
    const res = await fetch(`http://localhost:${port}/worktrees/nonexistent-agent`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 404);
  });
});
```

- [ ] **Step 7: Run all sp5 tests**

```bash
node --test tests/sp5.test.js
```

Expected: All tests pass (7 DB tests + 5 HTTP tests = 12 total).

- [ ] **Step 8: Run full test suite**

```bash
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/sp5.test.js
```

Expected: 55 tests pass (43 existing + 12 new).

- [ ] **Step 9: Commit**

```bash
git add dashboard/server.js dashboard/terminal.js dashboard/tests/sp5.test.js
git commit -m "feat(dashboard): add suggestion/worktree REST routes, terminal detection, spawn isolate flag"
```

---

### Task 5: Dashboard UI

**Files:**
- Modify: `dashboard/public/index.html`
- Modify: `dashboard/public/app.js`
- Modify: `dashboard/public/style.css`

**Interfaces:**
- Consumes: WS messages `{ type: 'suggestion', suggestion }`, `{ type: 'worktree_pending', agent, branch }`, `{ type: 'worktree_merged' }`, `{ type: 'worktree_discarded' }`
- Consumes: REST `GET /suggestions`, `PATCH /suggestions/:id`, `GET /worktrees`, `POST /worktrees/:agent/merge`, `DELETE /worktrees/:agent`
- Produces: Isolate checkbox in spawn modal → `isolate: true` in spawn WS message
- Produces: `#suggestions-strip` below `#panels` showing new/noted suggestion cards
- Produces: `isolated` badge on agent panel header; Merge/Discard buttons when worktree pending

- [ ] **Step 1: Update `dashboard/public/index.html`**

Add the isolate checkbox inside the modal's `modal-actions` div. Replace the existing modal `<div class="modal-actions">` block:

```html
      <div class="form-group" style="margin-top:8px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
          <input type="checkbox" id="modal-isolate">
          Isolated branch (safe self-modification)
        </label>
      </div>
      <div class="modal-actions">
        <button id="modal-cancel">Cancel</button>
        <button id="modal-spawn">Spawn</button>
      </div>
```

Add the suggestions strip div. Insert AFTER `<div id="project-view" class="hidden"></div>`:

```html
  <div id="suggestions-strip" class="hidden"></div>
```

- [ ] **Step 2: Add suggestion and worktree styles to `dashboard/public/style.css`**

Append these rules to the end of `style.css`:

```css
/* Suggestions strip */
#suggestions-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid #21262d;
  background: #0d1117;
}
#suggestions-strip.hidden { display: none; }

.suggestion-card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 10px 12px;
  min-width: 280px;
  max-width: 420px;
  flex: 1 1 280px;
}
.suggestion-card.noted { opacity: 0.55; }
.suggestion-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 11px;
  color: #8b949e;
}
.suggestion-content {
  font-size: 12px;
  color: #c9d1d9;
  white-space: pre-wrap;
  word-break: break-word;
}
.suggestion-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.suggestion-actions button {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid #30363d;
  background: none;
  color: #e6edf3;
  cursor: pointer;
}
.suggestion-actions button:hover { background: #21262d; }

/* Isolated worktree badge */
.badge-isolated {
  background: #6e7681;
  color: #e6edf3;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  margin-left: 4px;
}

/* Merge/Discard worktree buttons */
.btn-merge {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 4px;
  border: 1px solid #388bfd;
  background: none;
  color: #388bfd;
  cursor: pointer;
}
.btn-merge:hover { background: #1c2d3f; }
.btn-discard {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 4px;
  border: 1px solid #f85149;
  background: none;
  color: #f85149;
  cursor: pointer;
}
.btn-discard:hover { background: #2d1a1a; }
```

- [ ] **Step 3: Update `dashboard/public/app.js` — spawn modal sends isolate flag**

Replace the `document.getElementById('modal-spawn').addEventListener('click', ...)` handler:

```js
document.getElementById('modal-spawn').addEventListener('click', () => {
  const name = document.getElementById('modal-name').value.trim();
  const workdir = document.getElementById('modal-workdir').value.trim();
  if (!name || !workdir) return;
  const model = document.getElementById('modal-model').value;
  const isolate = document.getElementById('modal-isolate').checked;
  ws.send(JSON.stringify({
    type: 'spawn', agent: name, workdir,
    ...(model ? { model } : {}),
    ...(isolate ? { isolate: true } : {}),
  }));
  ensurePanel({ name, mode: 'spawn', status: 'running', isolate });
  document.getElementById('modal').classList.add('hidden');
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-workdir').value = '';
  document.getElementById('modal-isolate').checked = false;
});
```

- [ ] **Step 4: Update `ensurePanel` in `dashboard/public/app.js` to support isolated badge**

Replace the `ensurePanel` function signature and the badge line inside it:

```js
function ensurePanel({ name, mode, status, isolate }) {
```

And inside `panel.innerHTML`, replace the observe badge line:

```js
        ${mode === 'observe' ? '<span class="badge badge-observe">observe</span>' : ''}
        ${isolate ? `<span class="badge badge-isolated" id="isolated-badge-${name}">isolated</span>` : ''}
```

And add the worktree action area to the header's right div (after the Kill button):

```js
      <div style="display:flex;align-items:center;gap:6px" id="header-right-${name}">
        <span class="panel-cost" id="cost-${name}">$0.00 today</span>
        <button class="btn-kill" data-agent="${name}">Kill</button>
      </div>
```

Change the existing right div from:
```js
      <div style="display:flex;align-items:center;gap:6px">
        <span class="panel-cost" id="cost-${name}">$0.00 today</span>
        <button class="btn-kill" data-agent="${name}">Kill</button>
      </div>
```

To:
```js
      <div style="display:flex;align-items:center;gap:6px" id="header-right-${name}">
        <span class="panel-cost" id="cost-${name}">$0.00 today</span>
        <button class="btn-kill" data-agent="${name}">Kill</button>
      </div>
```

- [ ] **Step 5: Add worktree + suggestion WS message handlers to `dashboard/public/app.js`**

In the `ws.addEventListener('message', ...)` switch block, add new cases after `case 'cost':`:

```js
      case 'worktree_pending': {
        const headerRight = document.getElementById(`header-right-${msg.agent}`);
        if (!headerRight) break;
        // Hide kill button, show merge/discard
        headerRight.innerHTML = `
          <span class="panel-cost" id="cost-${msg.agent}">$0.00 today</span>
          <button class="btn-merge" data-agent="${msg.agent}">Merge</button>
          <button class="btn-discard" data-agent="${msg.agent}">Discard</button>
          <span id="worktree-error-${msg.agent}" style="color:#f85149;font-size:11px"></span>
        `;
        headerRight.querySelector('.btn-merge').addEventListener('click', () => {
          fetch(`/worktrees/${msg.agent}/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(r => r.json())
            .then(data => {
              if (data.ok) {
                restoreKillButton(msg.agent);
                const badge = document.getElementById(`isolated-badge-${msg.agent}`);
                if (badge) badge.remove();
              } else {
                const errEl = document.getElementById(`worktree-error-${msg.agent}`);
                if (errEl) errEl.textContent = data.error ?? 'merge failed';
              }
            });
        });
        headerRight.querySelector('.btn-discard').addEventListener('click', () => {
          if (!confirm(`Discard worktree for "${msg.agent}"? This cannot be undone.`)) return;
          fetch(`/worktrees/${msg.agent}`, { method: 'DELETE' })
            .then(r => r.json())
            .then(data => {
              if (data.ok) {
                restoreKillButton(msg.agent);
                const badge = document.getElementById(`isolated-badge-${msg.agent}`);
                if (badge) badge.remove();
              }
            });
        });
        break;
      }

      case 'worktree_merged':
      case 'worktree_discarded':
        restoreKillButton(msg.agent);
        break;

      case 'suggestion':
        renderSuggestionCard(msg.suggestion);
        showSuggestionsStrip();
        break;
```

- [ ] **Step 6: Add suggestion rendering + strip management to `dashboard/public/app.js`**

Add these helper functions before the `connect()` call at the bottom:

```js
function restoreKillButton(agentName) {
  const headerRight = document.getElementById(`header-right-${agentName}`);
  if (!headerRight) return;
  headerRight.innerHTML = `
    <span class="panel-cost" id="cost-${agentName}">$0.00 today</span>
    <button class="btn-kill" data-agent="${agentName}">Kill</button>
  `;
  headerRight.querySelector('.btn-kill').addEventListener('click', () => {
    ws.send(JSON.stringify({ type: 'kill', agent: agentName }));
  });
}

function showSuggestionsStrip() {
  document.getElementById('suggestions-strip').classList.remove('hidden');
}

function renderSuggestionCard(s) {
  const strip = document.getElementById('suggestions-strip');
  if (document.getElementById(`suggestion-${s.id}`)) return; // already rendered
  const date = (s.created_at ?? '').slice(11, 16);
  const card = document.createElement('div');
  card.className = `suggestion-card${s.status === 'noted' ? ' noted' : ''}`;
  card.id = `suggestion-${s.id}`;
  card.innerHTML = `
    <div class="suggestion-meta">
      <span>${escHtml(s.agent_name)} · ${escHtml(date)}</span>
      <div class="suggestion-actions">
        <button data-action="note" data-id="${s.id}">Noted</button>
        <button data-action="dismiss" data-id="${s.id}">Dismiss</button>
      </div>
    </div>
    <div class="suggestion-content">${escHtml(s.content)}</div>
  `;
  card.querySelector('[data-action="note"]').addEventListener('click', () => {
    fetch(`/suggestions/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'noted' }),
    }).then(() => card.classList.add('noted'));
  });
  card.querySelector('[data-action="dismiss"]').addEventListener('click', () => {
    fetch(`/suggestions/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed' }),
    }).then(() => {
      card.remove();
      if (!document.querySelector('.suggestion-card')) {
        document.getElementById('suggestions-strip').classList.add('hidden');
      }
    });
  });
  strip.appendChild(card);
}

function fetchSuggestions() {
  fetch('/suggestions')
    .then(r => r.json())
    .then(list => {
      if (!list.length) return;
      list.forEach(s => renderSuggestionCard(s));
      showSuggestionsStrip();
    })
    .catch(() => {});
  setTimeout(fetchSuggestions, 30_000);
}
```

Add `escHtml` if not already defined — check for it. If missing, add:

```js
function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

- [ ] **Step 7: Call `fetchSuggestions()` on WS open**

In the `ws.addEventListener('open', ...)` handler, add `fetchSuggestions();` after `populateModelDropdown();`:

```js
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'agents' }));
    fetchCosts();
    populateModelDropdown();
    fetchSuggestions();
  });
```

- [ ] **Step 8: Manual smoke test**

Start the dashboard: `npm start` from Flint root (or `cd dashboard && node server.js`).

1. Open `http://localhost:3000`
2. Click `+ New Agent` — verify "Isolated branch" checkbox appears below Model dropdown
3. Suggestions strip should be hidden initially
4. In browser console: `fetch('/suggestions', {method:'GET'}).then(r=>r.json()).then(console.log)` — should return `[]` or existing list

- [ ] **Step 9: Commit**

```bash
git add dashboard/public/index.html dashboard/public/app.js dashboard/public/style.css
git commit -m "feat(ui): add isolated branch checkbox, suggestion strip, worktree merge/discard buttons"
```

---

### Task 6: CLI Subcommands

**Files:**
- Modify: `bin/flint.js`

**Interfaces:**
- Consumes: `GET /suggestions`, `PATCH /suggestions/:id` via existing `dashGet`/`dashPatch`
- Consumes: `GET /worktrees`, `POST /worktrees/:agent/merge`, `DELETE /worktrees/:agent` via `dashGet`/`dashPost`/`dashDelete`
- Produces: `flint suggestions list`, `flint suggestions dismiss <id>`
- Produces: `flint worktree list`, `flint worktree merge <agent>`, `flint worktree discard <agent>`

- [ ] **Step 1: Add `cmdSuggestions` and `cmdWorktree` to `bin/flint.js`**

Add these two functions before the `const [,, subcommand, ...rest] = process.argv;` line:

```js
async function cmdSuggestions(args) {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const list = await dashGet('/suggestions');
    if (!list.length) { console.log('No suggestions.'); return; }
    for (const s of list) {
      const date = (s.created_at ?? '').slice(0, 16).replace('T', ' ');
      console.log(`[${s.id}] ${s.agent_name} [${s.status}] ${date}`);
      console.log(`  ${String(s.content).slice(0, 80).replace(/\n/g, ' ')}`);
    }
  } else if (sub === 'dismiss') {
    const [id] = rest;
    if (!id) { console.error('Usage: flint suggestions dismiss <id>'); process.exit(1); }
    await dashPatch(`/suggestions/${id}`, { status: 'dismissed' });
    console.log(`Suggestion ${id} dismissed.`);
  } else {
    console.error('Usage: flint suggestions <list|dismiss>');
    process.exit(1);
  }
}

async function cmdWorktree(args) {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const list = await dashGet('/worktrees');
    if (!list.length) { console.log('No active worktrees.'); return; }
    for (const w of list) {
      console.log(`${w.name} | ${w.worktree_branch} | ${w.worktree_path} | ${w.status}`);
    }
  } else if (sub === 'merge') {
    const [agent] = rest;
    if (!agent) { console.error('Usage: flint worktree merge <agent>'); process.exit(1); }
    await dashPost(`/worktrees/${encodeURIComponent(agent)}/merge`, {});
    console.log(`Merged worktree for agent "${agent}".`);
  } else if (sub === 'discard') {
    const [agent] = rest;
    if (!agent) { console.error('Usage: flint worktree discard <agent>'); process.exit(1); }
    await dashDelete(`/worktrees/${encodeURIComponent(agent)}`);
    console.log(`Discarded worktree for agent "${agent}".`);
  } else {
    console.error('Usage: flint worktree <list|merge|discard>');
    process.exit(1);
  }
}
```

- [ ] **Step 2: Register the new subcommands**

Replace:
```js
const COMMANDS = { ask: cmdAsk, models: cmdModels, config: cmdConfig, costs: cmdCosts, project: cmdProject };
```

With:
```js
const COMMANDS = { ask: cmdAsk, models: cmdModels, config: cmdConfig, costs: cmdCosts, project: cmdProject, suggestions: cmdSuggestions, worktree: cmdWorktree };
```

Update the error message:
```js
  console.error(`Usage: flint <ask|models|config|costs|project|suggestions|worktree>`);
```

- [ ] **Step 3: Verify CLI syntax (dashboard doesn't need to be running for syntax check)**

```bash
node bin/flint.js suggestions 2>&1
node bin/flint.js worktree 2>&1
```

Expected:
```
Usage: flint suggestions <list|dismiss>
Usage: flint worktree <list|merge|discard>
```

- [ ] **Step 4: Run all tests to confirm no regressions**

```bash
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/sp5.test.js
```

Expected: 55 tests pass.

```bash
cd "C:\Users\Robin\Applications Dev\Flint"
node --test router/tests/router.test.js
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add bin/flint.js
git commit -m "feat(cli): add 'flint suggestions' and 'flint worktree' subcommand groups"
```

---

### Task 7: Final Integration Check

**Files:** None (verification only)

This task verifies all success criteria from the spec against the implemented code.

- [ ] **Step 1: Run complete test suite**

```bash
cd "C:\Users\Robin\Applications Dev\Flint"
node --test router/tests/router.test.js
```
Expected: 8 tests pass (5 original + 3 CLI provider).

```bash
cd dashboard
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/sp5.test.js
```
Expected: 55 tests pass (43 original + 12 new).

- [ ] **Step 2: Verify CLI provider success criterion**

With the dashboard + router running (`npm start` from Flint root), test that `--provider claude-cli` routes through the CLI. If `claude` binary is in PATH:

```bash
node bin/flint.js ask "hello" --provider claude-cli
```

Expected: response from the Claude CLI. Cost logged as $0.

- [ ] **Step 3: Verify getModels includes cli group**

```bash
node bin/flint.js models
```

Expected: output includes a `cli:` section listing the binary names from router.json.

- [ ] **Step 4: Verify suggestion detection works**

Confirm `SUGGESTION_REGEX` in terminal.js matches the spec pattern. In Node REPL:

```js
const SUGGESTION_REGEX = /^## SUGGESTION:\s*(.+?)(?=\n\n|\n##|\n$|$)/ms;
const data = '## SUGGESTION: Cache getProject() calls to speed up the dashboard\n\nSome other text';
console.log(data.match(SUGGESTION_REGEX)?.[1]);
// Expected: "Cache getProject() calls to speed up the dashboard"
```

- [ ] **Step 5: Verify `escHtml` is present in app.js**

```bash
grep -n "escHtml" dashboard/public/app.js
```

If missing (it was added in SP4 or earlier), add to app.js:

```js
function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

- [ ] **Step 6: Commit final verification**

```bash
git add -A
git status
# Only commit if any stray fixes were needed
git commit -m "chore(sp5): final integration verification and minor fixes"
```

---

## Self-Review

**Spec coverage check:**

| Spec Section | Task |
|---|---|
| CLI providers (claude-cli, gemini-cli, mistral-cli) in router | Task 1 |
| CLI providers in router.json tiers (`-cli` suffix) | Task 1 (config.js) |
| Stdin-based prompt (not args) to avoid length limits | Task 1 (completeCli) |
| 120s timeout | Task 1 (completeCli timer) |
| Cost logged as $0 | Task 1 (return value) |
| `suggestions` table with id/agent_name/content/status/created_at | Task 2 |
| `worktree_path` + `worktree_branch` on agents_log via try/catch ALTER | Task 2 |
| `createSuggestion` with 60s dedup | Task 3 |
| `listSuggestions` excludes dismissed | Task 3 |
| `updateSuggestion` | Task 3 |
| `createWorktree` branch `improve/<agent>-<ts>`, path `.worktrees/<agent>-<ts>` | Task 3 |
| `mergeWorktree` → merge + remove + delete branch + clear DB | Task 3 |
| `discardWorktree` → force remove + force delete + clear DB | Task 3 |
| `GET /suggestions`, `PATCH /suggestions/:id` | Task 4 |
| `GET /worktrees`, `POST /worktrees/:agent/merge`, `DELETE /worktrees/:agent` | Task 4 |
| 404 for unknown agent on merge/discard | Task 4 |
| Spawn handler with `isolate: true` flag → createWorktree | Task 4 |
| `worktree_pending` broadcast on PTY exit | Task 4 |
| `## SUGGESTION:` detection in onData | Task 4 |
| WS broadcast on new suggestion | Task 4 |
| Isolate checkbox in spawn modal | Task 5 |
| `isolated` badge on panel header | Task 5 |
| Merge/Discard buttons when worktree pending | Task 5 |
| Suggestions strip with Noted/Dismiss per card | Task 5 |
| Suggestions polled every 30s | Task 5 |
| `flint suggestions list\|dismiss` | Task 6 |
| `flint worktree list\|merge\|discard` | Task 6 |
| `flint ask "hello" --provider claude-cli` works | Task 1 (--provider already in cmdAsk) |
| New tests: ~55 dashboard + 8 router | Tasks 2 + 4 + 7 |
| Existing 43 tests unaffected | Verified in each task |

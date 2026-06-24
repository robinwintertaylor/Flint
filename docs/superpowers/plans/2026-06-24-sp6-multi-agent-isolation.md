# SP6: Multi-Agent Isolation & Production Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up Forgejo (local Docker PR UI), automatic PR creation when agent worktrees complete, PM2 process management with crash restart, and structured JSON logging.

**Architecture:** Forgejo runs in Docker on port 3030 as a local git remote. When an agent exits with an active worktree, `terminal.js` fires an `onWorktreePending` callback (injected by `server.js`), which pushes the branch to Forgejo and opens a PR via the Forgejo REST API. A 30-second server-side poll detects PR merge/close and syncs back to the local repo. PM2 manages both the dashboard and router processes with log rotation. A thin `logger.js` outputs JSON lines captured by PM2.

**Tech Stack:** Node.js 20+ ESM, better-sqlite3, Docker Desktop (Forgejo), PM2, node:test + node:assert/strict

## Global Constraints

- Node.js 20+, ESM throughout — `import`/`export`, no `require()`
- `better-sqlite3` singleton: `getDb()` after `initDb()` — never `new Database()` directly
- `node:test` + `node:assert/strict` — no external test framework
- `FLINT_TEST_MODE=1` stubs all external calls (Forgejo API, git push, PTY spawn)
- `FLINT_DB_PATH` / `FLINT_AGENTS_FILE` env vars for test isolation
- Dashboard port 3000, Router port 3001, Forgejo port 3030
- Flint root: `C:\Users\Robin\Applications Dev\Flint\`
- All existing 54 dashboard tests + 8 router tests must continue to pass
- `ecosystem.config.cjs` uses CommonJS (`.cjs`) because root has `"type": "module"`
- `forgejo.token` is git-ignored — never commit it

---

## File Map

```
Created:
  docker-compose.yml                ← Forgejo service on port 3030
  ecosystem.config.cjs              ← PM2 process definitions
  scripts/forgejo-init.ps1          ← one-time Forgejo bootstrap
  dashboard/logger.js               ← JSON-line logger (info/warn/error)
  dashboard/forgejo.js              ← push branch, create PR, poll status
  dashboard/tests/sp6.test.js       ← all new tests for SP6

Modified:
  .gitignore                        ← add forgejo.token and .worktrees/
  dashboard/db.js                   ← +pr_number/pr_url/pr_status columns; 4 new exports
  dashboard/terminal.js             ← spawnAgent gains { onWorktreePending } callback
  dashboard/worktrees.js            ← remove mergeWorktree; update listWorktrees; discardWorktree clears PR
  dashboard/server.js               ← createPRForAgent; GET /health; PR poll; remove merge route
  dashboard/tests/sp5.test.js       ← remove stale merge route test
  dashboard/public/app.js           ← worktree_pr + pr_status handlers; showPRLink; updatePRBadge
  dashboard/public/style.css        ← PR badge styles
  bin/flint.js                      ← remove 'merge' subcommand; update 'list' output
```

---

### Task 1: Forgejo Infrastructure

**Files:**
- Create: `docker-compose.yml`
- Create: `scripts/forgejo-init.ps1`
- Modify: `.gitignore`

**Interfaces:**
- Produces: Forgejo running at `http://localhost:3030`, `forgejo` git remote, `forgejo.token` at Flint root

No unit tests possible for Docker/external services. Verified by smoke test at the end of this task.

- [ ] **Step 1: Add `forgejo.token` and `.worktrees/` to `.gitignore`**

Edit `.gitignore` to become:
```
.env
*.sqlite
node_modules/
forgejo.token
.worktrees/
```

- [ ] **Step 2: Create `docker-compose.yml`**

Create `C:\Users\Robin\Applications Dev\Flint\docker-compose.yml`:
```yaml
services:
  forgejo:
    image: codeberg.org/forgejo/forgejo:7
    container_name: flint-forgejo
    ports:
      - "3030:3000"
    volumes:
      - forgejo-data:/data
    environment:
      - USER_UID=1000
      - USER_GID=1000
    restart: unless-stopped

volumes:
  forgejo-data:
```

- [ ] **Step 3: Create `scripts/forgejo-init.ps1`**

Create `C:\Users\Robin\Applications Dev\Flint\scripts\forgejo-init.ps1`:
```powershell
<#
.SYNOPSIS
    One-time bootstrap for the local Forgejo instance.
    Run once after: docker compose up -d
    Creates admin user, generates API token, creates repo, pushes master, adds git remote.
#>

$ErrorActionPreference = 'Stop'
$FlintRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

# 1. Wait for Forgejo to be ready (up to 60s)
Write-Host "Waiting for Forgejo..." -NoNewline
$ready = $false
for ($i = 1; $i -le 60; $i++) {
    try {
        $r = Invoke-WebRequest -Uri 'http://localhost:3030/api/v1/version' -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Write-Host '.' -NoNewline
    Start-Sleep 1
}
if (-not $ready) { Write-Error "Forgejo not ready after 60s — is Docker running?"; exit 1 }
Write-Host " ready."

# 2. Create admin user (ignore if already exists)
docker exec flint-forgejo forgejo admin user create `
    --username robin `
    --password changeme123 `
    --email robin@flint.local `
    --admin 2>&1 | Out-Null
Write-Host "Admin user: robin / changeme123"

# 3. Generate API token via basic auth
$pair  = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('robin:changeme123'))
$hdr   = @{ Authorization = "Basic $pair"; 'Content-Type' = 'application/json' }
$tBody = @{ name = 'flint-dashboard' } | ConvertTo-Json
try {
    $tResp = Invoke-RestMethod -Uri 'http://localhost:3030/api/v1/user/tokens' `
        -Method Post -Headers $hdr -Body $tBody
    $token = $tResp.sha1
} catch {
    Write-Host "Token may already exist — delete it in Forgejo UI if re-running."
    exit 1
}

# 4. Save token to forgejo.token (git-ignored)
$tokenPath = Join-Path $FlintRoot 'forgejo.token'
$token | Out-File -FilePath $tokenPath -Encoding ascii -NoNewline
Write-Host "Token saved to: $tokenPath"

# 5. Create repo (ignore if already exists)
$authHdr = @{ Authorization = "token $token"; 'Content-Type' = 'application/json' }
$repoBody = @{ name = 'flint'; private = $true; auto_init = $false } | ConvertTo-Json
try {
    Invoke-RestMethod -Uri 'http://localhost:3030/api/v1/user/repos' `
        -Method Post -Headers $authHdr -Body $repoBody | Out-Null
    Write-Host "Repo 'flint' created."
} catch {
    Write-Host "Repo may already exist, continuing..."
}

# 6. Add forgejo remote and push master
Set-Location $FlintRoot
git remote remove forgejo 2>&1 | Out-Null
git remote add forgejo "http://robin:${token}@localhost:3030/robin/flint.git"
git push forgejo master
Write-Host ""
Write-Host "✓ Forgejo bootstrap complete"
Write-Host "  Web UI: http://localhost:3030"
Write-Host "  Login:  robin / changeme123"
```

- [ ] **Step 4: Start Forgejo and verify**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
docker compose up -d
```

Wait ~10 seconds, then:
```powershell
Invoke-WebRequest -Uri 'http://localhost:3030/api/v1/version' -UseBasicParsing | Select-Object StatusCode
```
Expected: `StatusCode: 200`

- [ ] **Step 5: Run bootstrap (first time only)**

```powershell
.\scripts\forgejo-init.ps1
```
Expected: ends with `✓ Forgejo bootstrap complete`. Open `http://localhost:3030/robin/flint` in browser and verify `master` branch is visible.

- [ ] **Step 6: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add .gitignore docker-compose.yml scripts/forgejo-init.ps1
git commit -m "feat(sp6): add Forgejo Docker Compose and bootstrap script"
```

---

### Task 2: `dashboard/logger.js` — Structured JSON Logger

**Files:**
- Create: `dashboard/logger.js`
- Create: `dashboard/tests/sp6.test.js` (DB + logger tests only for now)

**Interfaces:**
- Produces: `info(msg, data?)`, `warn(msg, data?)`, `error(msg, data?)` — each writes a JSON line to stdout
- Produces: `log(level, msg, data?)` — underlying function

- [ ] **Step 1: Create `dashboard/tests/sp6.test.js` with logger tests**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\tests\sp6.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Logger tests ────────────────────────────────────────────────────────────

const { info, warn, error: logError } = await import('../logger.js');

test('logger.info writes JSON line with level info', () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(chunk); return true; };
  info('test message', { key: 'val' });
  process.stdout.write = orig;
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'test message');
  assert.equal(parsed.key, 'val');
  assert.ok(parsed.ts, 'ts field missing');
});

test('logger.warn writes JSON line with level warn', () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(chunk); return true; };
  warn('something off');
  process.stdout.write = orig;
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.msg, 'something off');
});

test('logger.error writes JSON line with level error', () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(chunk); return true; };
  logError('boom', { err: 'details' });
  process.stdout.write = orig;
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.err, 'details');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/sp6.test.js
```
Expected: FAIL — `Cannot find module '../logger.js'`

- [ ] **Step 3: Create `dashboard/logger.js`**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\logger.js`:
```js
export function log(level, msg, data = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }) + '\n'
  );
}

export const info  = (msg, data) => log('info',  msg, data ?? {});
export const warn  = (msg, data) => log('warn',  msg, data ?? {});
export const error = (msg, data) => log('error', msg, data ?? {});
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
node --test tests/sp6.test.js
```
Expected: 3 logger tests PASS

- [ ] **Step 5: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/logger.js dashboard/tests/sp6.test.js
git commit -m "feat(dashboard): add structured JSON logger"
```

---

### Task 3: `dashboard/db.js` — PR Columns + New Exports

**Files:**
- Modify: `dashboard/db.js`
- Modify: `dashboard/tests/sp6.test.js` (append DB tests)

**Interfaces:**
- Produces: `setAgentPR(name, prNumber, prUrl, status)` → void
- Produces: `clearAgentPR(name)` → void
- Produces: `getAgentPR(name)` → `{ pr_number, pr_url, pr_status } | undefined`
- Produces: `listOpenPRAgents()` → `[{ name, pr_number }]`

- [ ] **Step 1: Append DB tests to `dashboard/tests/sp6.test.js`**

Append to the end of `C:\Users\Robin\Applications Dev\Flint\dashboard\tests\sp6.test.js`:
```js
// ─── DB PR column tests ───────────────────────────────────────────────────────

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TMP_DB = join(tmpdir(), `flint-sp6-db-${Date.now()}.sqlite`);
process.env.FLINT_DB_PATH = TMP_DB;

const { initDb, closeDb, upsertAgentLog, setAgentPR, clearAgentPR, getAgentPR, listOpenPRAgents } = await import('../db.js');

initDb(TMP_DB);

test('setAgentPR stores PR data on agents_log', () => {
  upsertAgentLog('pr-agent', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  setAgentPR('pr-agent', 42, 'http://localhost:3030/robin/flint/pulls/42', 'open');
  const row = getAgentPR('pr-agent');
  assert.equal(row.pr_number, 42);
  assert.equal(row.pr_url, 'http://localhost:3030/robin/flint/pulls/42');
  assert.equal(row.pr_status, 'open');
});

test('clearAgentPR sets PR columns to NULL', () => {
  upsertAgentLog('clear-pr-agent', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  setAgentPR('clear-pr-agent', 7, 'http://localhost:3030/robin/flint/pulls/7', 'open');
  clearAgentPR('clear-pr-agent');
  const row = getAgentPR('clear-pr-agent');
  assert.ok(!row?.pr_number, 'pr_number should be null');
});

test('listOpenPRAgents returns only rows with pr_status open', () => {
  upsertAgentLog('open-pr', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  upsertAgentLog('merged-pr', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  upsertAgentLog('no-pr', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  setAgentPR('open-pr', 1, 'http://localhost:3030/robin/flint/pulls/1', 'open');
  setAgentPR('merged-pr', 2, 'http://localhost:3030/robin/flint/pulls/2', 'merged');
  const list = listOpenPRAgents();
  assert.ok(list.some(r => r.name === 'open-pr'), 'open-pr should appear');
  assert.ok(!list.some(r => r.name === 'merged-pr'), 'merged-pr should not appear');
  assert.ok(!list.some(r => r.name === 'no-pr'), 'no-pr should not appear');
});

test('cleanup DB', () => {
  closeDb();
  rmSync(TMP_DB, { force: true });
  delete process.env.FLINT_DB_PATH;
  assert.ok(true);
});
```

- [ ] **Step 2: Run tests to verify DB tests fail**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/sp6.test.js
```
Expected: 3 logger tests PASS, 4 DB tests FAIL with `setAgentPR is not a function`

- [ ] **Step 3: Add ALTER TABLE statements to `dashboard/db.js`**

In `dashboard/db.js`, after the existing two `try { _db.exec('ALTER TABLE agents_log ADD COLUMN worktree_branch TEXT'); } catch {}` line, add:
```js
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN pr_number INTEGER'); } catch {}
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN pr_url TEXT'); } catch {}
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN pr_status TEXT'); } catch {}
```

- [ ] **Step 4: Add four new exports to `dashboard/db.js`**

Add these four functions before the `export function getDb()` line at the end of `dashboard/db.js`:
```js
export function setAgentPR(name, prNumber, prUrl, status) {
  getDb().prepare(
    `UPDATE agents_log SET pr_number = ?, pr_url = ?, pr_status = ? WHERE name = ?`
  ).run(prNumber, prUrl, status, name);
}

export function clearAgentPR(name) {
  getDb().prepare(
    `UPDATE agents_log SET pr_number = NULL, pr_url = NULL, pr_status = NULL WHERE name = ?`
  ).run(name);
}

export function getAgentPR(name) {
  return getDb().prepare(
    `SELECT pr_number, pr_url, pr_status FROM agents_log WHERE name = ?`
  ).get(name);
}

export function listOpenPRAgents() {
  return getDb().prepare(
    `SELECT name, pr_number FROM agents_log WHERE pr_status = 'open'`
  ).all();
}
```

- [ ] **Step 5: Run tests to verify all pass**

```powershell
node --test tests/sp6.test.js
```
Expected: 7 tests PASS (3 logger + 4 DB)

- [ ] **Step 6: Run full existing suite — no regressions**

```powershell
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/sp5.test.js
```
Expected: 54 tests PASS

- [ ] **Step 7: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/db.js dashboard/tests/sp6.test.js
git commit -m "feat(db): add PR columns and setAgentPR/clearAgentPR/getAgentPR/listOpenPRAgents"
```

---

### Task 4: `dashboard/forgejo.js` — Forgejo API Client

**Files:**
- Create: `dashboard/forgejo.js`
- Modify: `dashboard/tests/sp6.test.js` (append forgejo tests)

**Interfaces:**
- Produces: `isForgejoReachable()` → `Promise<boolean>` — GET /api/v1/version with 2s timeout; returns `true` in TEST_MODE
- Produces: `pushBranch(branch)` → `void` — `git push forgejo <branch>`; no-op in TEST_MODE
- Produces: `createPR(branch, agentName)` → `Promise<{ prNumber: number, prUrl: string }>` — POST to Forgejo API; returns `{ prNumber: 1, prUrl: 'http://localhost:3030/robin/flint/pulls/1' }` in TEST_MODE
- Produces: `getPRStatus(prNumber)` → `Promise<'open'|'merged'|'closed'>` — GET PR; returns `'open'` in TEST_MODE

Config (read at call time, not module load):
- `FORGEJO_URL` env (default `http://localhost:3030`)
- `FORGEJO_TOKEN` env or contents of `forgejo.token` file at Flint root
- `FORGEJO_OWNER` env (default `robin`)
- `FORGEJO_REPO` env (default `flint`)

- [ ] **Step 1: Append forgejo tests to `dashboard/tests/sp6.test.js`**

Append to the end of `C:\Users\Robin\Applications Dev\Flint\dashboard\tests\sp6.test.js`:
```js
// ─── forgejo.js stub tests (TEST_MODE) ───────────────────────────────────────

process.env.FLINT_TEST_MODE = '1';

const { isForgejoReachable, pushBranch, createPR, getPRStatus } = await import('../forgejo.js');

test('isForgejoReachable returns true in TEST_MODE', async () => {
  const result = await isForgejoReachable();
  assert.equal(result, true);
});

test('pushBranch is a no-op in TEST_MODE', () => {
  assert.doesNotThrow(() => pushBranch('improve/test-agent-20260624-120000'));
});

test('createPR returns stub in TEST_MODE', async () => {
  const result = await createPR('improve/test-20260624', 'test-agent');
  assert.equal(typeof result.prNumber, 'number');
  assert.ok(result.prUrl.includes('pulls'));
});

test('getPRStatus returns open in TEST_MODE', async () => {
  const status = await getPRStatus(1);
  assert.equal(status, 'open');
});
```

- [ ] **Step 2: Run to verify forgejo tests fail**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/sp6.test.js
```
Expected: 7 pass, 4 FAIL with `Cannot find module '../forgejo.js'`

- [ ] **Step 3: Create `dashboard/forgejo.js`**

Create `C:\Users\Robin\Applications Dev\Flint\dashboard\forgejo.js`:
```js
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';

function cfg() {
  return {
    url:   process.env.FORGEJO_URL   ?? 'http://localhost:3030',
    owner: process.env.FORGEJO_OWNER ?? 'robin',
    repo:  process.env.FORGEJO_REPO  ?? 'flint',
  };
}

function getToken() {
  if (process.env.FORGEJO_TOKEN) return process.env.FORGEJO_TOKEN;
  const f = join(FLINT_ROOT, 'forgejo.token');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `token ${getToken()}`,
  };
}

export async function isForgejoReachable() {
  if (TEST_MODE()) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${cfg().url}/api/v1/version`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export function pushBranch(branch) {
  if (TEST_MODE()) return;
  execSync(`git push forgejo "${branch}"`, { cwd: FLINT_ROOT });
}

export async function createPR(branch, agentName) {
  const { url, owner, repo } = cfg();
  if (TEST_MODE()) {
    return { prNumber: 1, prUrl: `${url}/${owner}/${repo}/pulls/1` };
  }
  const res = await fetch(`${url}/api/v1/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      title: `[${agentName}] ${branch}`,
      head: branch,
      base: 'master',
      body: `Automated PR created by Flint agent \`${agentName}\`.`,
    }),
  });
  if (!res.ok) throw new Error(`Forgejo createPR failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { prNumber: data.number, prUrl: data.html_url };
}

export async function getPRStatus(prNumber) {
  if (TEST_MODE()) return 'open';
  const { url, owner, repo } = cfg();
  const res = await fetch(
    `${url}/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`Forgejo getPRStatus failed: ${res.status}`);
  const data = await res.json();
  if (data.merged) return 'merged';
  if (data.state === 'closed') return 'closed';
  return 'open';
}
```

- [ ] **Step 4: Run all sp6 tests — 11 should pass**

```powershell
node --test tests/sp6.test.js
```
Expected: 11 tests PASS (3 logger + 4 DB + 4 forgejo)

- [ ] **Step 5: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/forgejo.js dashboard/tests/sp6.test.js
git commit -m "feat(dashboard): add Forgejo API client with TEST_MODE stubs"
```

---

### Task 5: `terminal.js` + `worktrees.js` — Wire Up PR Callback

**Files:**
- Modify: `dashboard/terminal.js`
- Modify: `dashboard/worktrees.js`

**Interfaces:**
- Consumes: `clearAgentPR(name)` from `./db.js` (Task 3)
- Produces: `spawnAgent(name, workdir, model, { onWorktreePending }?)` — fourth arg is optional opts object; `onWorktreePending(agentName, branch)` called after `worktree_pending` broadcast
- Produces: `listWorktrees()` → rows now include `pr_number, pr_url, pr_status` columns
- Produces: `discardWorktree(agentName)` now also calls `clearAgentPR(agentName)`
- Removes: `mergeWorktree` export

- [ ] **Step 1: Update `dashboard/terminal.js` — add `onWorktreePending` callback**

In `dashboard/terminal.js`, replace:
```js
export function spawnAgent(name, workdir, model) {
```
With:
```js
export function spawnAgent(name, workdir, model, { onWorktreePending } = {}) {
```

Then in the `ptyProcess.onExit` handler, replace:
```js
    // Notify UI if agent had an isolated worktree
    const worktree = getAgentWorktree(name);
    if (worktree?.worktree_branch) {
      broadcastToAgent(name, { type: 'worktree_pending', agent: name, branch: worktree.worktree_branch });
    }
```
With:
```js
    // Notify UI and trigger PR creation if agent had an isolated worktree
    const worktree = getAgentWorktree(name);
    if (worktree?.worktree_branch) {
      broadcastToAgent(name, { type: 'worktree_pending', agent: name, branch: worktree.worktree_branch });
      onWorktreePending?.(name, worktree.worktree_branch);
    }
```

- [ ] **Step 2: Update `dashboard/worktrees.js`**

Replace the entire file `C:\Users\Robin\Applications Dev\Flint\dashboard\worktrees.js`:
```js
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDb, clearAgentWorktree, clearAgentPR } from './db.js';

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
    `SELECT name, worktree_path, worktree_branch, status, pr_number, pr_url, pr_status
     FROM agents_log WHERE worktree_path IS NOT NULL`
  ).all();
}

export function discardWorktree(agentName) {
  const row = getDb().prepare(
    `SELECT worktree_path, worktree_branch FROM agents_log WHERE name = ?`
  ).get(agentName);
  if (!row?.worktree_branch) throw new Error(`No worktree for agent: ${agentName}`);
  execSync(`git worktree remove --force "${row.worktree_path}"`, { cwd: FLINT_ROOT });
  execSync(`git branch -D "${row.worktree_branch}"`, { cwd: FLINT_ROOT });
  clearAgentWorktree(agentName);
  clearAgentPR(agentName);
}
```

- [ ] **Step 3: Verify syntax**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
node --check dashboard/terminal.js
node --check dashboard/worktrees.js
```
Expected: no output (syntax OK)

- [ ] **Step 4: Run full existing suite — no regressions**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/sp5.test.js
```
Expected: 54 tests PASS

- [ ] **Step 5: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/terminal.js dashboard/worktrees.js
git commit -m "feat(terminal): add onWorktreePending callback; remove mergeWorktree; update listWorktrees"
```

---

### Task 6: `dashboard/server.js` — PR Flow, Health Endpoint, Poll Timer

**Files:**
- Modify: `dashboard/server.js`
- Modify: `dashboard/tests/sp5.test.js` (remove stale merge route test)
- Modify: `dashboard/tests/sp6.test.js` (append HTTP tests)

**Interfaces:**
- Consumes: `isForgejoReachable`, `pushBranch`, `createPR`, `getPRStatus` from `./forgejo.js`
- Consumes: `setAgentPR`, `clearAgentPR`, `getAgentPR`, `listOpenPRAgents`, `clearAgentWorktree` from `./db.js`
- Consumes: `info`, `error` from `./logger.js`
- Produces: `GET /health` → `{ status, uptime, db, forgejo }`
- Produces: automatic PR creation via `onWorktreePending` callback injected into `spawnAgent`
- Produces: 30-second PR status poll updating DB + broadcasting `pr_status`
- Removes: `POST /worktrees/:agent/merge` route
- Removes: `mergeWorktree` import

- [ ] **Step 1: Remove the stale merge route test from `dashboard/tests/sp5.test.js`**

In `dashboard/tests/sp5.test.js`, delete this entire test block:
```js
  test('POST /worktrees/:agent/merge returns 404 for unknown agent', async () => {
    const res = await fetch(`http://localhost:${port}/worktrees/nonexistent-agent/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 404);
  });
```

- [ ] **Step 2: Run existing suite to confirm 1 test removed (now 53)**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/sp5.test.js
```
Expected: 11 tests PASS (was 12 — one removed)

- [ ] **Step 3: Append HTTP tests to `dashboard/tests/sp6.test.js`**

Append to the end of `C:\Users\Robin\Applications Dev\Flint\dashboard\tests\sp6.test.js`:
```js
// ─── Server HTTP tests ────────────────────────────────────────────────────────

import { mkdirSync, writeFileSync } from 'node:fs';

const TMP_SRV = join(tmpdir(), `flint-sp6-srv-${Date.now()}`);
mkdirSync(TMP_SRV, { recursive: true });
process.env.FLINT_DB_PATH    = join(TMP_SRV, 'usage.sqlite');
process.env.FLINT_AGENTS_FILE = join(TMP_SRV, 'agents.json');
process.env.FLINT_TASKS_DIR   = join(TMP_SRV, 'tasks');
process.env.FLINT_TEST_MODE   = '1';
writeFileSync(process.env.FLINT_AGENTS_FILE, '[]');

const { createApp } = await import('../server.js');

let srv6, port6;

await new Promise(resolve => {
  srv6 = createApp();
  srv6.listen(0, () => { port6 = srv6.address().port; resolve(); });
});

test('GET /health returns ok status in TEST_MODE', async () => {
  const res = await fetch(`http://localhost:${port6}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.forgejo, 'reachable');
  assert.equal(body.db, 'connected');
  assert.ok(typeof body.uptime === 'number');
});

test('POST /worktrees/:agent/merge route no longer exists (404)', async () => {
  const res = await fetch(`http://localhost:${port6}/worktrees/any-agent/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 404);
});

test('cleanup server', async () => {
  await new Promise(resolve => srv6.close(resolve));
  rmSync(TMP_SRV, { recursive: true, force: true });
  assert.ok(true);
});
```

- [ ] **Step 4: Run sp6 tests to verify HTTP tests fail**

```powershell
node --test tests/sp6.test.js
```
Expected: 11 PASS, 3 FAIL (`GET /health` — route not found yet)

- [ ] **Step 5: Update imports in `dashboard/server.js`**

Replace the existing import block at the top of `dashboard/server.js`:
```js
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initDb, getTodayCost, getMonthCost, closeDb, upsertAgentLog, setAgentWorktree, getAgentWorktree } from './db.js';
import { initAgents, registerAgent, listAgents, getAgent, addWsClient, removeWsClient, killAgent, broadcastToAgent, addGlobalWsClient, removeGlobalWsClient } from './agents.js';
import { listSuggestions, updateSuggestion } from './suggestions.js';
import { listWorktrees, createWorktree, mergeWorktree, discardWorktree } from './worktrees.js';
import { spawnAgent, writeToAgent, observeLogFile } from './terminal.js';
import { readTasks, writeTasks, appendTask } from './tasks.js';
import {
  listProjects, getProject, createProject, updateProject,
  linkAgent, unlinkAgent,
} from './projects.js';
```

With:
```js
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initDb, getTodayCost, getMonthCost, closeDb, upsertAgentLog, setAgentWorktree, getAgentWorktree, setAgentPR, clearAgentPR, getAgentPR, listOpenPRAgents, clearAgentWorktree } from './db.js';
import { initAgents, registerAgent, listAgents, getAgent, addWsClient, removeWsClient, killAgent, broadcastToAgent, addGlobalWsClient, removeGlobalWsClient } from './agents.js';
import { listSuggestions, updateSuggestion } from './suggestions.js';
import { listWorktrees, createWorktree, discardWorktree } from './worktrees.js';
import { spawnAgent, writeToAgent, observeLogFile } from './terminal.js';
import { readTasks, writeTasks, appendTask } from './tasks.js';
import { listProjects, getProject, createProject, updateProject, linkAgent, unlinkAgent } from './projects.js';
import { isForgejoReachable, pushBranch, createPR, getPRStatus } from './forgejo.js';
import { info, error as logError } from './logger.js';
```

Also add the Flint root constant after the existing `const __dirname` line:
```js
const FLINT_ROOT = join(__dirname, '..');
```

- [ ] **Step 6: Add `createPRForAgent` private function to `dashboard/server.js`**

Add this function just before the `export function createApp()` line:
```js
async function createPRForAgent(name, branch) {
  try {
    info('creating PR', { agent: name, branch });
    pushBranch(branch);
    const { prNumber, prUrl } = await createPR(branch, name);
    setAgentPR(name, prNumber, prUrl, 'open');
    broadcastToAgent(name, { type: 'worktree_pr', agent: name, prUrl, prNumber });
    info('PR created', { agent: name, prNumber, prUrl });
  } catch (err) {
    logError('PR creation failed', { agent: name, err: err.message });
  }
}

async function handlePRMerged(name) {
  try {
    const worktree = getAgentWorktree(name);
    if (worktree?.worktree_path) {
      execSync(`git worktree remove --force "${worktree.worktree_path}"`, { cwd: FLINT_ROOT });
    }
    if (worktree?.worktree_branch) {
      try { execSync(`git branch -D "${worktree.worktree_branch}"`, { cwd: FLINT_ROOT }); } catch {}
      try { execSync(`git pull forgejo master`, { cwd: FLINT_ROOT }); } catch {}
    }
  } catch (err) {
    logError('cleanup after PR merge failed', { agent: name, err: err.message });
  }
  clearAgentWorktree(name);
  clearAgentPR(name);
}
```

- [ ] **Step 7: Add `GET /health` route to `dashboard/server.js`**

Add this route after the `app.get('/router/config', ...)` block and before `// --- Project routes ---`:
```js
  // --- Health ---

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

- [ ] **Step 8: Remove `POST /worktrees/:agent/merge` route from `dashboard/server.js`**

Delete this entire block from `dashboard/server.js`:
```js
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
```

- [ ] **Step 9: Update the `spawn` WebSocket handler in `dashboard/server.js`**

Replace:
```js
            spawnAgent(name, spawnDir, model);
```
With:
```js
            spawnAgent(name, spawnDir, model, { onWorktreePending: createPRForAgent });
```

- [ ] **Step 10: Add 30-second PR poll timer to `dashboard/server.js`**

Inside `createApp()`, add the poll timer just before the `return httpServer;` line:
```js
  if (!TEST_MODE) {
    const prPollInterval = setInterval(async () => {
      const agents = listOpenPRAgents();
      for (const { name, pr_number } of agents) {
        try {
          const status = await getPRStatus(pr_number);
          const current = getAgentPR(name);
          if (current && current.pr_status !== status) {
            setAgentPR(name, pr_number, current.pr_url, status);
            broadcastToAgent(name, { type: 'pr_status', agent: name, status });
            if (status === 'merged') await handlePRMerged(name);
            else if (status === 'closed') clearAgentPR(name);
          }
        } catch (err) {
          logError('PR poll failed', { agent: name, err: err.message });
        }
      }
    }, 30_000);
    httpServer.on('close', () => clearInterval(prPollInterval));
  }
```

- [ ] **Step 11: Also update `POST /agents/spawn` HTTP route to pass callback**

Replace:
```js
    if (!TEST_MODE) spawnAgent(name, workdir);
```
With:
```js
    if (!TEST_MODE) spawnAgent(name, workdir, null, { onWorktreePending: createPRForAgent });
```

- [ ] **Step 12: Run all sp6 tests — should now pass**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/sp6.test.js
```
Expected: 14 tests PASS

- [ ] **Step 13: Run the full suite — confirm totals**

```powershell
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/sp5.test.js tests/sp6.test.js
```
Expected: 67 tests PASS (54 − 1 removed merge test + 14 sp6 = 67)

- [ ] **Step 14: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add dashboard/server.js dashboard/tests/sp5.test.js dashboard/tests/sp6.test.js
git commit -m "feat(server): add PR flow, GET /health, 30s poll timer; remove direct merge route"
```

---

### Task 7: `dashboard/public/app.js` + `style.css` — PR UI

**Files:**
- Modify: `dashboard/public/app.js`
- Modify: `dashboard/public/style.css`

**Interfaces:**
- Consumes WS messages: `{ type: 'worktree_pending' }`, `{ type: 'worktree_pr', agent, prUrl, prNumber }`, `{ type: 'pr_status', agent, status }`
- Produces: loading state on `worktree_pending`; "View PR" link + open badge on `worktree_pr`; badge colour update on `pr_status`

- [ ] **Step 1: Update `case 'worktree_pending'` in `dashboard/public/app.js`**

Find the existing `case 'worktree_pending':` block and replace it entirely:
```js
      case 'worktree_pending': {
        const headerRight = document.getElementById(`header-right-${escHtml(msg.agent)}`);
        if (!headerRight) break;
        headerRight.innerHTML = `
          <span class="panel-cost" id="cost-${escHtml(msg.agent)}">$0.00 today</span>
          <span class="badge badge-pr-open" id="pr-badge-${escHtml(msg.agent)}">creating PR…</span>
        `;
        break;
      }
```

- [ ] **Step 2: Replace `case 'worktree_merged'` and `case 'worktree_discarded'` blocks**

Find:
```js
      case 'worktree_merged':
      case 'worktree_discarded':
        restoreKillButton(msg.agent);
        break;
```

Replace with:
```js
      case 'worktree_discarded':
        restoreKillButton(msg.agent);
        break;

      case 'worktree_pr':
        showPRLink(msg.agent, msg.prUrl, msg.prNumber);
        break;

      case 'pr_status':
        updatePRBadge(msg.agent, msg.status);
        if (msg.status === 'merged' || msg.status === 'closed') {
          restoreKillButton(msg.agent);
        }
        break;
```

- [ ] **Step 3: Add `showPRLink` and `updatePRBadge` helper functions to `dashboard/public/app.js`**

Add these two functions just before the `function restoreKillButton(agentName)` function:
```js
function showPRLink(agentName, prUrl, prNumber) {
  const headerRight = document.getElementById(`header-right-${escHtml(agentName)}`);
  if (!headerRight) return;
  headerRight.innerHTML = `
    <span class="panel-cost" id="cost-${escHtml(agentName)}">$0.00 today</span>
    <a class="btn-view-pr" href="${escHtml(prUrl)}" target="_blank" rel="noopener">View PR #${prNumber}</a>
    <span class="badge badge-pr-open" id="pr-badge-${escHtml(agentName)}">open</span>
  `;
}

function updatePRBadge(agentName, status) {
  const badge = document.getElementById(`pr-badge-${escHtml(agentName)}`);
  if (!badge) return;
  badge.textContent = status;
  badge.className = `badge badge-pr-${status}`;
}
```

- [ ] **Step 4: Append PR styles to `dashboard/public/style.css`**

Append to the end of `dashboard/public/style.css`:
```css
/* PR badges */
.badge-pr-open   { background: #1a7f37; color: #3fb950; padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: bold; }
.badge-pr-merged { background: #6e40c9; color: #d2a8ff; padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: bold; }
.badge-pr-closed { background: #5a1d1d; color: #f85149; padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: bold; }

/* View PR link button */
.btn-view-pr {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 4px;
  border: 1px solid #388bfd;
  background: none;
  color: #388bfd;
  text-decoration: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.btn-view-pr:hover { background: #1c2d3f; }
```

- [ ] **Step 5: Verify syntax**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
node --check dashboard/public/app.js
```
Expected: no output

- [ ] **Step 6: Commit**

```powershell
git add dashboard/public/app.js dashboard/public/style.css
git commit -m "feat(ui): add worktree_pr and pr_status handlers, View PR link, PR badge styles"
```

---

### Task 8: `bin/flint.js` — Remove Merge, Update List

**Files:**
- Modify: `bin/flint.js`

**Interfaces:**
- Removes: `flint worktree merge` subcommand
- Updates: `flint worktree list` output now shows `pr_status` and `pr_url` when present

- [ ] **Step 1: Remove the `merge` branch from `cmdWorktree` in `bin/flint.js`**

Find and delete:
```js
  } else if (sub === 'merge') {
    const [agent] = rest;
    if (!agent) { console.error('Usage: flint worktree merge <agent>'); process.exit(1); }
    await dashPost(`/worktrees/${encodeURIComponent(agent)}/merge`, {});
    console.log(`Merged worktree for agent "${agent}".`);
```

- [ ] **Step 2: Update the `list` branch to show PR info**

Replace:
```js
  if (sub === 'list') {
    const list = await dashGet('/worktrees');
    if (!list.length) { console.log('No active worktrees.'); return; }
    for (const w of list) {
      console.log(`${w.name} | ${w.worktree_branch} | ${w.worktree_path} | ${w.status}`);
    }
```

With:
```js
  if (sub === 'list') {
    const list = await dashGet('/worktrees');
    if (!list.length) { console.log('No active worktrees.'); return; }
    for (const w of list) {
      const pr = w.pr_status ? ` | PR #${w.pr_number} [${w.pr_status}] ${w.pr_url}` : '';
      console.log(`${w.name} | ${w.worktree_branch} | ${w.status}${pr}`);
    }
```

- [ ] **Step 3: Update the usage error message**

Replace:
```js
    console.error('Usage: flint worktree <list|merge|discard>');
```
With:
```js
    console.error('Usage: flint worktree <list|discard>');
```

- [ ] **Step 4: Verify CLI usage messages**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
node bin/flint.js worktree 2>&1
```
Expected: `Usage: flint worktree <list|discard>`

- [ ] **Step 5: Run full test suite — all pass**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/sp5.test.js tests/sp6.test.js
```
Expected: 67 tests PASS

- [ ] **Step 6: Commit**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git add bin/flint.js
git commit -m "feat(cli): remove worktree merge; show PR status in worktree list"
```

---

### Task 9: `ecosystem.config.cjs` — PM2 Process Management

**Files:**
- Create: `ecosystem.config.cjs`

No unit tests possible for process management. Verified by smoke test.

- [ ] **Step 1: Create `ecosystem.config.cjs`**

Create `C:\Users\Robin\Applications Dev\Flint\ecosystem.config.cjs`:
```js
module.exports = {
  apps: [
    {
      name: 'flint-dashboard',
      script: 'dashboard/server.js',
      cwd: 'C:/Users/Robin/Applications Dev/Flint',
      watch: false,
      max_memory_restart: '500M',
      env: { PORT: '3000', NODE_ENV: 'production' },
    },
    {
      name: 'flint-router',
      script: 'router/server.js',
      cwd: 'C:/Users/Robin/Applications Dev/Flint',
      watch: false,
      max_memory_restart: '300M',
      env: { PORT: '3001', NODE_ENV: 'production' },
    },
  ],
};
```

- [ ] **Step 2: Install PM2 globally (if not already installed)**

```powershell
npm list -g pm2 2>&1
```
If not found:
```powershell
npm install -g pm2
```

- [ ] **Step 3: Verify PM2 can parse the config**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
pm2 start ecosystem.config.cjs --no-daemon 2>&1 | Select-Object -First 5
pm2 stop all
pm2 delete all
```
Expected: PM2 lists both `flint-dashboard` and `flint-router` as `online`, then stops cleanly.

- [ ] **Step 4: Install log rotation**

```powershell
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

- [ ] **Step 5: Set up boot persistence**

```powershell
pm2 start ecosystem.config.cjs
pm2 startup
```
Run the command PM2 prints (it generates a Task Scheduler entry). Then:
```powershell
pm2 save
```
Expected: `[PM2] Saving current process list...` — process list saved.

- [ ] **Step 6: Verify logger output appears in PM2 logs**

```powershell
pm2 logs flint-dashboard --lines 10 --nostream
```
Expected: JSON lines like `{"ts":"2026-...","level":"info","msg":"Flint Dashboard → http://localhost:3000"}`

- [ ] **Step 7: Commit**

```powershell
pm2 stop all
pm2 delete all
cd "C:\Users\Robin\Applications Dev\Flint"
git add ecosystem.config.cjs
git commit -m "feat(pm2): add ecosystem.config.cjs for crash-restart and boot persistence"
```

---

### Task 10: Final Integration Check

**Files:** None — verification only.

- [ ] **Step 1: Run complete test suite**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/sp5.test.js tests/sp6.test.js
```
Expected:
```
ℹ tests 67
ℹ pass  67
ℹ fail  0
```

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
node --test router/tests/router.test.js
```
Expected:
```
ℹ tests 8
ℹ pass  8
ℹ fail  0
```

- [ ] **Step 2: Start full stack and verify health**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
docker compose up -d
pm2 start ecosystem.config.cjs
```

```powershell
Invoke-RestMethod http://localhost:3000/health | ConvertTo-Json
```
Expected:
```json
{ "status": "ok", "uptime": 3, "db": "connected", "forgejo": "reachable" }
```

- [ ] **Step 3: Verify crash restart**

```powershell
pm2 ls   # note dashboard pid
pm2 kill flint-dashboard   # send SIGKILL
Start-Sleep 3
pm2 ls   # should show flint-dashboard back online with restarts: 1
```

- [ ] **Step 4: Verify `flint worktree list` and `flint worktree merge` removed**

```powershell
node bin/flint.js worktree list
node bin/flint.js worktree merge 2>&1
```
Expected: `list` returns `No active worktrees.`; `merge` prints `Usage: flint worktree <list|discard>` and exits 1.

- [ ] **Step 5: Final commit (only if any stray fixes were needed)**

```powershell
git add -A
git status   # review before committing
git commit -m "chore(sp6): final integration verification"
```

- [ ] **Step 6: Stop stack**

```powershell
pm2 stop all
pm2 delete all
docker compose down
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Forgejo Docker Compose on port 3030 | Task 1 |
| `forgejo-init.ps1` bootstrap (user, token, repo, remote, push) | Task 1 |
| `forgejo.token` git-ignored | Task 1 |
| `logger.js` JSON-line output, info/warn/error | Task 2 |
| `pr_number`, `pr_url`, `pr_status` columns on `agents_log` | Task 3 |
| `setAgentPR`, `clearAgentPR`, `getAgentPR`, `listOpenPRAgents` | Task 3 |
| `forgejo.js`: `isForgejoReachable`, `pushBranch`, `createPR`, `getPRStatus` | Task 4 |
| TEST_MODE stubs for all Forgejo functions | Task 4 |
| `spawnAgent` gains `{ onWorktreePending }` callback | Task 5 |
| `mergeWorktree` removed | Task 5 |
| `listWorktrees` includes PR columns | Task 5 |
| `discardWorktree` clears PR in DB | Task 5 |
| `createPRForAgent` in server.js (push + createPR + setAgentPR + broadcast) | Task 6 |
| `handlePRMerged` (git worktree remove, pull forgejo, clear DB) | Task 6 |
| `GET /health` with Forgejo reachability | Task 6 |
| Remove `POST /worktrees/:agent/merge` route | Task 6 |
| 30s PR poll timer (TEST_MODE guarded) | Task 6 |
| `worktree_pending` → loading state in UI | Task 7 |
| `worktree_pr` → "View PR" link + open badge | Task 7 |
| `pr_status` → badge colour update; restoreKillButton on merged/closed | Task 7 |
| PR badge CSS classes (open/merged/closed) | Task 7 |
| `.btn-view-pr` styles | Task 7 |
| Remove `flint worktree merge` | Task 8 |
| `flint worktree list` shows PR status/URL | Task 8 |
| `ecosystem.config.cjs` (dashboard + router, crash restart, 500M/300M limits) | Task 9 |
| PM2 log rotation via `pm2-logrotate` | Task 9 |
| `pm2 startup && pm2 save` for boot persistence | Task 9 |
| All 54 existing dashboard tests pass (53 after removing stale merge test + sp6 adds 14) | Tasks 3/6 |
| All 8 router tests pass | Task 10 |
| Option C (CI) is one docker-compose.yml addition — no code changes | Spec section 6 |

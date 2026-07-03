# Project Git Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give project-linked orchestrations a real git lifecycle — auto-detect-or-create a repo per project, commit at task granularity, and auto-push + open a PR when the orchestrator finishes, with an offline fallback that re-syncs to Forgejo once it's reachable again.

**Architecture:** A new `dashboard/projectGit.js` module owns project-scoped git mechanics (repo detection/creation, per-task commits with a serialization lock). `dashboard/forgejo.js` is generalized to derive owner/repo from an arbitrary workdir's own `forgejo` remote instead of Flint's hardcoded config, mirroring the pattern `github.js` already uses. `orchestrator.js`'s `createOrchestration` calls into `projectGit.js` before creating a branch; `queue.js`'s existing task-completion poller calls into it after each project-linked task completes; a new `POST /orchestrations/:id/complete` route drives the push/PR step.

**Tech Stack:** Node.js ESM, better-sqlite3, `node:test`, `execSync` for git, Forgejo REST API (existing `forgejo.js` patterns).

## Global Constraints

- No `require()` — ESM only, matches rest of the codebase.
- New DB columns added via `try { ALTER TABLE ... } catch {}` in `initDb`, matching every existing migration in `db.js`.
- Tests use `node --test` with real temp git repos where git behavior is under test (no mocking git itself) — matches `worktrees.js`/`sp6.test.js` existing style. `FLINT_TEST_MODE=1` short-circuits real git/network calls the same way it already does in `forgejo.js`/`github.js`.
- Static `import` statements that come after a `process.env.FLINT_*` assignment in a test file are unsafe (ESM import hoisting silently ignores the ordering) — any new test file that needs to isolate `FLINT_AGENTS_FILE`, `FLINT_TASKS_DIR`, or similar must either read them lazily inside functions (already true for `FLINT_TASKS_DIR`/`FLINT_DB_PATH`) or use dynamic `await import()` after setting them. This was a real bug found and fixed this session in `autoPickup.test.js` — do not reintroduce it.
- `resolveWorkdir(projectId)` (in `projects.js`) is the single source of truth for a project's working directory — reuse it, don't re-derive workspace paths another way.

---

### Task 1: Orchestrations git columns + accessor functions

**Files:**
- Modify: `dashboard/db.js:171` (after the existing `active_orchestration_id` ALTER TABLE line)
- Modify: `dashboard/orchestrator.js` (add two new exported functions, after `updateOrchestrationStatus`)
- Test: `dashboard/tests/orchestrator.test.js`

**Interfaces:**
- Produces: `setOrchestrationBranch(id, branch)`, `setOrchestrationPR(id, { prNumber, prUrl, prStatus })` — both exported from `orchestrator.js`, used by Task 4 and Task 6.

- [ ] **Step 1: Write the failing tests**

Add to `dashboard/tests/orchestrator.test.js`, inside the existing import block (line 12-15), add the two new names:

```js
import {
  getOrchestration, listOrchestrations, updateOrchestrationStatus,
  buildOrchestratorTaskFile, appendScratchpad, readScratchpad,
  createOrchestration, setOrchestrationBranch, setOrchestrationPR,
} from '../orchestrator.js';
```

Then append these tests to the end of the file:

```js
test('orchestrations table has git columns', () => {
  const db = initDb(':memory:');
  const cols = db.prepare(`PRAGMA table_info(orchestrations)`).all().map(c => c.name);
  assert.ok(cols.includes('branch'), 'branch column missing');
  assert.ok(cols.includes('pr_number'), 'pr_number column missing');
  assert.ok(cols.includes('pr_url'), 'pr_url column missing');
  assert.ok(cols.includes('pr_status'), 'pr_status column missing');
});

test('setOrchestrationBranch stores the branch name', () => {
  initDb(':memory:');
  const { id } = createOrchestration({ goal: 'test goal', workdir: process.cwd() });
  setOrchestrationBranch(id, 'project/test-orch-1');
  assert.equal(getOrchestration(id).branch, 'project/test-orch-1');
});

test('setOrchestrationPR stores PR number, url, and status', () => {
  initDb(':memory:');
  const { id } = createOrchestration({ goal: 'test goal', workdir: process.cwd() });
  setOrchestrationPR(id, { prNumber: 5, prUrl: 'http://x/pulls/5', prStatus: 'open' });
  const orch = getOrchestration(id);
  assert.equal(orch.pr_number, 5);
  assert.equal(orch.pr_url, 'http://x/pulls/5');
  assert.equal(orch.pr_status, 'open');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && node --test tests/orchestrator.test.js`
Expected: FAIL — `cols.includes('branch')` assertion fails (columns don't exist yet), and `setOrchestrationBranch`/`setOrchestrationPR` are undefined imports.

- [ ] **Step 3: Add the DB columns**

In `dashboard/db.js`, immediately after line 171 (`try { _db.exec('ALTER TABLE projects ADD COLUMN active_orchestration_id INTEGER REFERENCES orchestrations(id)'); } catch {}`), add:

```js
  try { _db.exec('ALTER TABLE orchestrations ADD COLUMN branch TEXT'); } catch {}
  try { _db.exec('ALTER TABLE orchestrations ADD COLUMN pr_number INTEGER'); } catch {}
  try { _db.exec('ALTER TABLE orchestrations ADD COLUMN pr_url TEXT'); } catch {}
  try { _db.exec('ALTER TABLE orchestrations ADD COLUMN pr_status TEXT'); } catch {}
```

- [ ] **Step 4: Add the accessor functions**

In `dashboard/orchestrator.js`, immediately after the `updateOrchestrationStatus` function, add:

```js
export function setOrchestrationBranch(id, branch) {
  getDb().prepare('UPDATE orchestrations SET branch = ? WHERE id = ?').run(branch, id);
}

export function setOrchestrationPR(id, { prNumber, prUrl, prStatus }) {
  getDb().prepare(
    'UPDATE orchestrations SET pr_number = ?, pr_url = ?, pr_status = ? WHERE id = ?'
  ).run(prNumber, prUrl, prStatus, id);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard && node --test tests/orchestrator.test.js`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/db.js dashboard/orchestrator.js dashboard/tests/orchestrator.test.js
git commit -m "feat(project-git): add branch/PR columns to orchestrations table"
```

---

### Task 2: Generalize forgejo.js for arbitrary project workdirs

**Files:**
- Modify: `dashboard/forgejo.js`
- Test: `dashboard/tests/forgejo.test.js` (new file)

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `createRepo(name)` → `Promise<{ cloneUrl }>`; `pushBranch(branch, workdir = FLINT_ROOT)`; `createPR(branch, agentName, workdir = FLINT_ROOT)` → `Promise<{ prNumber, prUrl }>`; `getPRStatus(prNumber, workdir = FLINT_ROOT)` → `Promise<'open'|'merged'|'closed'>`. All four are consumed by Task 3 (`createRepo`), Task 4 (`pushBranch`/`createPR` via the complete route), and Task 6.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/forgejo.test.js`:

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

process.env.FLINT_TEST_MODE = '1';

const { isForgejoReachable, pushBranch, createPR, getPRStatus, createRepo } = await import('../forgejo.js');

const TMP_REPO = join(tmpdir(), `flint-forgejo-test-${Date.now()}`);

before(() => {
  mkdirSync(TMP_REPO, { recursive: true });
  execSync('git init', { cwd: TMP_REPO });
  execSync('git config user.email "test@flint.local"', { cwd: TMP_REPO });
  execSync('git config user.name "Flint Test"', { cwd: TMP_REPO });
  execSync('git commit --allow-empty -m "init"', { cwd: TMP_REPO });
  execSync(
    'git remote add forgejo "http://testuser:testtoken@localhost:3030/testuser/testrepo.git"',
    { cwd: TMP_REPO }
  );
});

test('isForgejoReachable returns true in TEST_MODE', async () => {
  assert.equal(await isForgejoReachable(), true);
});

test('pushBranch accepts a workdir and is a no-op in TEST_MODE', () => {
  assert.doesNotThrow(() => pushBranch('some-branch', TMP_REPO));
});

test('pushBranch defaults to FLINT_ROOT when no workdir given', () => {
  assert.doesNotThrow(() => pushBranch('some-branch'));
});

test('createPR accepts a workdir and returns a stub in TEST_MODE', async () => {
  const result = await createPR('some-branch', 'test-agent', TMP_REPO);
  assert.equal(typeof result.prNumber, 'number');
  assert.ok(result.prUrl.includes('pulls'));
});

test('getPRStatus accepts a workdir and returns open in TEST_MODE', async () => {
  const status = await getPRStatus(1, TMP_REPO);
  assert.equal(status, 'open');
});

test('createRepo returns a stub clone URL in TEST_MODE', async () => {
  const result = await createRepo('some-project');
  assert.ok(result.cloneUrl.includes('some-project'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && node --test tests/forgejo.test.js`
Expected: FAIL — `createRepo` is not exported yet; `pushBranch`/`createPR`/`getPRStatus` reject a second/third argument only in the sense that they currently ignore it (test itself won't fail on that, but `createRepo` import will be `undefined` and calling it throws `TypeError: createRepo is not a function`).

- [ ] **Step 3: Generalize forgejo.js**

Replace the full contents of `dashboard/forgejo.js` with:

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
    url: process.env.FORGEJO_URL ?? 'http://localhost:3030',
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

// Parses owner/repo from the `forgejo` remote configured in a given workdir,
// e.g. http://user:token@localhost:3030/owner/repo.git -> { owner: 'owner', repo: 'repo' }
function getForgejoRemoteInfo(workdir) {
  let out;
  try {
    out = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
  } catch {
    return null;
  }
  const line = out.split('\n').find(l => l.startsWith('forgejo\t'));
  if (!line) return null;
  const urlMatch = line.match(/forgejo\t(\S+)/);
  if (!urlMatch) return null;
  const parsed = urlMatch[1].match(/https?:\/\/(?:[^@/]+@)?[^/]+\/([^/]+)\/([^/.]+)(?:\.git)?/);
  if (!parsed) return null;
  return { owner: parsed[1], repo: parsed[2] };
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

export function pushBranch(branch, workdir = FLINT_ROOT) {
  if (TEST_MODE()) return;
  execSync(`git push forgejo "${branch}"`, { cwd: workdir });
}

export async function createPR(branch, agentName, workdir = FLINT_ROOT) {
  if (TEST_MODE()) {
    return { prNumber: 1, prUrl: `${cfg().url}/test/repo/pulls/1` };
  }
  const remoteInfo = getForgejoRemoteInfo(workdir);
  if (!remoteInfo) throw new Error(`No forgejo remote found in ${workdir}`);
  const { owner, repo } = remoteInfo;
  const res = await fetch(`${cfg().url}/api/v1/repos/${owner}/${repo}/pulls`, {
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

export async function getPRStatus(prNumber, workdir = FLINT_ROOT) {
  if (TEST_MODE()) return 'open';
  const remoteInfo = getForgejoRemoteInfo(workdir);
  if (!remoteInfo) throw new Error(`No forgejo remote found in ${workdir}`);
  const { owner, repo } = remoteInfo;
  const res = await fetch(`${cfg().url}/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Forgejo getPRStatus failed: ${res.status}`);
  const data = await res.json();
  if (data.merged) return 'merged';
  if (data.state === 'closed') return 'closed';
  return 'open';
}

// Creates (or reuses, if it already exists) a Forgejo repo named `name` under
// the admin user's account. Returns a clone URL with credentials embedded,
// matching the `user:token@host` convention scripts/forgejo-init.ps1 already uses.
export async function createRepo(name) {
  if (TEST_MODE()) {
    return { cloneUrl: `http://test:test@localhost:3030/test/${name}.git` };
  }
  const { url } = cfg();
  const token = getToken();
  const me = await fetch(`${url}/api/v1/user`, { headers: authHeaders() }).then(r => r.json());
  const res = await fetch(`${url}/api/v1/user/repos`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, private: true, auto_init: false }),
  });
  let cloneUrl;
  if (res.status === 409) {
    const existing = await fetch(`${url}/api/v1/repos/${me.login}/${name}`, { headers: authHeaders() });
    if (!existing.ok) throw new Error(`Forgejo repo "${name}" reported as existing but could not be fetched`);
    cloneUrl = (await existing.json()).clone_url;
  } else if (!res.ok) {
    throw new Error(`Forgejo createRepo failed: ${res.status} ${await res.text()}`);
  } else {
    cloneUrl = (await res.json()).clone_url;
  }
  return { cloneUrl: cloneUrl.replace(/^https?:\/\//, (m) => `${m}${me.login}:${token}@`) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && node --test tests/forgejo.test.js`
Expected: all 6 tests PASS.

- [ ] **Step 5: Run the pre-existing forgejo tests to confirm no regression**

Run: `cd dashboard && node --test tests/sp6.test.js`
Expected: the `isForgejoReachable`/`pushBranch`/`createPR`/`getPRStatus` TEST_MODE tests still PASS (they call these functions without a `workdir` arg, which now defaults to `FLINT_ROOT` — same effective behavior as before).

- [ ] **Step 6: Commit**

```bash
git add dashboard/forgejo.js dashboard/tests/forgejo.test.js
git commit -m "feat(project-git): generalize forgejo.js to work against arbitrary project workdirs"
```

---

### Task 3: `projectGit.js` — repo detection/creation and per-task commits

**Files:**
- Create: `dashboard/projectGit.js`
- Test: `dashboard/tests/projectGit.test.js` (new file)

**Interfaces:**
- Consumes: `isForgejoReachable`, `createRepo` from `./forgejo.js` (Task 2); `getProject` from `./projects.js` (already exists).
- Produces: `slugify(name)` → `string`; `ensureProjectRepo(projectId, workdir)` → `Promise<{ hasRemote: boolean }>`; `commitTaskForProject(workdir, message)` → `Promise<void>`. Consumed by Task 4 (`ensureProjectRepo`, via `orchestrator.js`) and Task 5 (`commitTaskForProject`, via `queue.js`).

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/projectGit.test.js`:

```js
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';

const TEMP_DB = join(tmpdir(), `flint-projectgit-test-${Date.now()}.sqlite`);
process.env.FLINT_DB_PATH = TEMP_DB;

const { initDb } = await import('../db.js');
const { createProject } = await import('../projects.js');
const { slugify, ensureProjectRepo, commitTaskForProject } = await import('../projectGit.js');

function freshWorkdir() {
  const dir = join(tmpdir(), `flint-projectgit-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

before(() => {
  initDb(TEMP_DB);
});

test('slugify lowercases and replaces non-alphanumerics with hyphens', () => {
  assert.equal(slugify('Proj A: Model Audit!'), 'proj-a-model-audit');
});

test('slugify falls back to a placeholder for an empty/symbol-only name', () => {
  assert.equal(slugify('!!!'), 'project');
});

test('ensureProjectRepo git-inits a blank workdir with FLINT_TEST_MODE set (offline path)', async () => {
  process.env.FLINT_TEST_MODE = '1';
  const workdir = freshWorkdir();
  const projectId = createProject({ name: 'Blank Project' });
  const result = await ensureProjectRepo(projectId, workdir);
  assert.equal(result.hasRemote, false);
  delete process.env.FLINT_TEST_MODE;
});

test('ensureProjectRepo is a no-op when the workdir already has a remote', async () => {
  const workdir = freshWorkdir();
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });
  execSync('git remote add forgejo "http://u:t@localhost:3030/u/repo.git"', { cwd: workdir });
  const projectId = createProject({ name: 'Existing Project' });
  const result = await ensureProjectRepo(projectId, workdir);
  assert.equal(result.hasRemote, true);
});

test('commitTaskForProject commits staged changes with the given message', async () => {
  const workdir = freshWorkdir();
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });
  execSync(`node -e "require('fs').writeFileSync('file.txt', 'hello')"`, { cwd: workdir });

  await commitTaskForProject(workdir, 'Do the thing (#1, builder)');

  const log = execSync('git log -1 --pretty=%s', { cwd: workdir, encoding: 'utf8' }).trim();
  assert.equal(log, 'Do the thing (#1, builder)');
});

test('commitTaskForProject does not throw when there is nothing to commit', async () => {
  const workdir = freshWorkdir();
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });

  await assert.doesNotReject(() => commitTaskForProject(workdir, 'Nothing changed'));
});

test('commitTaskForProject serializes concurrent commits to the same workdir', async () => {
  const workdir = freshWorkdir();
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });
  execSync(`node -e "require('fs').writeFileSync('a.txt', 'a')"`, { cwd: workdir });

  await Promise.all([
    commitTaskForProject(workdir, 'first commit message'),
    commitTaskForProject(workdir, 'second commit message'),
  ]);

  const log = execSync('git log --pretty=%s', { cwd: workdir, encoding: 'utf8' });
  assert.ok(log.includes('first commit message'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && node --test tests/projectGit.test.js`
Expected: FAIL — `Cannot find module '../projectGit.js'`.

- [ ] **Step 3: Create `dashboard/projectGit.js`**

```js
import { execSync } from 'child_process';
import { getProject } from './projects.js';
import { isForgejoReachable, createRepo } from './forgejo.js';

const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';

// workdir -> chained Promise, so concurrent commits to the same project
// never race the same git index.
const commitLocks = new Map();

export function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

function isGitRepo(workdir) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: workdir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function hasAnyRemote(workdir) {
  try {
    const out = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Idempotent: safe to call on every project launch/relaunch/sync.
export async function ensureProjectRepo(projectId, workdir) {
  if (TEST_MODE()) return { hasRemote: false };

  if (!isGitRepo(workdir)) {
    execSync('git init', { cwd: workdir });
    try {
      execSync('git add -A', { cwd: workdir });
      execSync('git commit -m "Initial commit" --allow-empty', { cwd: workdir });
    } catch (err) {
      throw new Error(`Failed to create initial commit in ${workdir}: ${err.message}`);
    }
  }

  if (hasAnyRemote(workdir)) return { hasRemote: true };

  const reachable = await isForgejoReachable();
  if (!reachable) return { hasRemote: false };

  const project = getProject(projectId);
  const repoName = slugify(project?.name ?? `project-${projectId}`);
  const { cloneUrl } = await createRepo(repoName);
  execSync(`git remote add forgejo "${cloneUrl}"`, { cwd: workdir });
  execSync('git push forgejo HEAD:master', { cwd: workdir });
  return { hasRemote: true };
}

export function commitTaskForProject(workdir, message) {
  const prev = commitLocks.get(workdir) ?? Promise.resolve();
  const next = prev.then(() => {
    try {
      execSync('git add -A', { cwd: workdir });
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: workdir });
    } catch (err) {
      const output = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
      if (!/nothing to commit/i.test(output)) {
        console.warn(`[project-git] commit failed in ${workdir}: ${err.message}`);
      }
    }
  });
  commitLocks.set(workdir, next);
  return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && node --test tests/projectGit.test.js`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/projectGit.js dashboard/tests/projectGit.test.js
git commit -m "feat(project-git): add ensureProjectRepo and commitTaskForProject"
```

---

### Task 4: Branch-per-orchestration-run in `createOrchestration`

**Files:**
- Modify: `dashboard/orchestrator.js`
- Test: `dashboard/tests/orchestrator.test.js`

**Interfaces:**
- Consumes: `ensureProjectRepo` from `./projectGit.js` (Task 3); `slugify` from `./projectGit.js`; `getProject` from `./projects.js`; `setOrchestrationBranch` (Task 1, same file).
- Produces: `createOrchestration` now sets `branch` on the orchestration row whenever `projectId` is supplied and `FLINT_TEST_MODE` is not set.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/orchestrator.test.js` (this test needs a real temp git repo, so it does NOT run under `FLINT_TEST_MODE` — set it to a real workdir and unset test mode just for this test, restoring it after):

```js
test('createOrchestration creates and stores a branch for a project-linked run', async () => {
  const { execSync } = await import('child_process');
  const { mkdtempSync } = await import('fs');
  const { tmpdir: osTmpdir } = await import('os');
  const { join: pathJoin } = await import('path');
  const { createProject } = await import('../projects.js');

  initDb(':memory:');
  const workdir = mkdtempSync(pathJoin(osTmpdir(), 'flint-orch-branch-'));
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });
  execSync('git remote add forgejo "http://u:t@localhost:3030/u/repo.git"', { cwd: workdir });

  const projectId = createProject({ name: 'Branch Test Project' });

  const prevTestMode = process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_TEST_MODE;
  try {
    const { id } = await createOrchestration({ goal: 'test goal', workdir, projectId });
    const orch = getOrchestration(id);
    assert.ok(orch.branch, 'branch should be set');
    assert.match(orch.branch, /^project\/branch-test-project-orch-\d+$/);
  } finally {
    if (prevTestMode !== undefined) process.env.FLINT_TEST_MODE = prevTestMode;
  }
});

test('createOrchestration leaves branch null when no projectId is given', async () => {
  initDb(':memory:');
  const { id } = await createOrchestration({ goal: 'ad-hoc goal', workdir: process.cwd() });
  const orch = getOrchestration(id);
  assert.equal(orch.branch, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && node --test tests/orchestrator.test.js`
Expected: FAIL — `orch.branch` is `undefined`/`null` where a value was expected (branch creation doesn't exist yet).

- [ ] **Step 3: Wire branch creation into `createOrchestration`**

In `dashboard/orchestrator.js`, add these imports at the top (alongside the existing ones):

```js
import { ensureProjectRepo, slugify } from './projectGit.js';
import { getProject } from './projects.js';
```

Add this helper function above `createOrchestration`:

```js
function branchNameFor(projectId, orchestrationId) {
  const project = getProject(projectId);
  const slug = slugify(project?.name ?? `project-${projectId}`);
  return `project/${slug}-orch-${orchestrationId}`;
}
```

Change `createOrchestration`'s signature to `async` and insert the git setup between the DB insert and the scratchpad/task-file writing. The function becomes:

```js
export async function createOrchestration({ goal, workdir, model, projectId, specialists = [], projectNotes = '', workspacePath = null } = {}) {
  if (!goal || !workdir) throw new Error('goal and workdir required');

  const TEST_MODE = process.env.FLINT_TEST_MODE === '1';

  if (projectId != null && !TEST_MODE) {
    await ensureProjectRepo(projectId, workdir);
  }

  const db = getDb();
  const r = db.prepare(
    'INSERT INTO orchestrations (goal, agent_name, project_id) VALUES (?, ?, ?)'
  ).run(goal, 'placeholder', projectId ?? null);
  const id = r.lastInsertRowid;
  const agentName = `orch-${id}`;
  db.prepare('UPDATE orchestrations SET agent_name = ? WHERE id = ?').run(agentName, id);

  if (projectId != null && !TEST_MODE) {
    const branch = branchNameFor(projectId, id);
    execSync(`git checkout -b "${branch}"`, { cwd: workdir });
    setOrchestrationBranch(id, branch);
  }

  // Create scratchpad directory + file
  const orchDir = join(getTasksDir(), `orch-${id}`);
  if (!existsSync(orchDir)) mkdirSync(orchDir, { recursive: true });
  const scratchpadPath = join(getTasksDir(), `orch-${id}`, 'scratchpad.md');
  const absPath = join(orchDir, 'scratchpad.md');
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  writeFileSync(absPath, `# Orchestration: ${goal}\n\nStarted: ${timestamp}\n\n## Plan\n\n## Findings\n\n## Synthesis\n`, 'utf8');

  // Write orchestrator task file
  const projectDocs = projectId ? listDocsWithContent(projectId) : [];
  writeTasks(agentName, buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs, specialists, projectNotes, workspacePath: workspacePath || workdir, projectId }));

  // Register the orchestrator agent
  registerAgent(agentName, 'spawn', workdir, null, model ?? '', 'claude');

  if (!TEST_MODE) {
    spawnAgent(agentName, workdir, model ?? null, {});
  }

  broadcastGlobal({ type: 'orchestration_started', id, agentName, goal });

  return { id, agentName, scratchpadPath };
}
```

This also needs `execSync` imported in `orchestrator.js` — add `import { execSync } from 'child_process';` near the top with the other imports.

Because `createOrchestration` is now `async`, its two existing callers must `await` it:
- `dashboard/projectLauncher.js` already does `await createOrchestration({...})` — no change needed.
- `dashboard/server.js`'s `POST /orchestrations` route currently calls it synchronously (`const result = createOrchestration({...})`). Change that line to:
  ```js
  const result = await createOrchestration({ goal, workdir, model, projectId: project_id });
  ```
  and make the route handler `async (req, res) => { ... }` (it's already declared without `async` — add it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && node --test tests/orchestrator.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Run the full server test suite to catch the now-async route**

Run: `cd dashboard && node --test tests/server.test.js`
Expected: all tests PASS (the `POST /orchestrations` route tests still work since `await`-ing a value that's already resolved is transparent to callers).

- [ ] **Step 6: Commit**

```bash
git add dashboard/orchestrator.js dashboard/server.js dashboard/tests/orchestrator.test.js
git commit -m "feat(project-git): create a branch per project-linked orchestration run"
```

---

### Task 5: Per-task commit hook in `checkQueueTasks`

**Files:**
- Modify: `dashboard/queue.js`
- Test: `dashboard/tests/queue.test.js`

**Interfaces:**
- Consumes: `resolveWorkdir` from `./projects.js` (already exists); `commitTaskForProject` from `./projectGit.js` (Task 3).

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/queue.test.js`. First add these imports alongside the existing ones at the top of the file:

```js
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync as writeFileSyncFs } from 'fs';
import { tmpdir as osTmpdir } from 'os';
import { createProject } from '../projects.js';
```

Then append the test:

```js
test('checkQueueTasks commits to the project workspace when a project-linked task completes', async () => {
  initDb(':memory:');
  const workdir = mkdtempSync(join(osTmpdir(), 'flint-queue-commit-'));
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });

  const projectId = createProject({ name: 'Commit Hook Project' });
  const { setSetting } = await import('../settings.js');
  setSetting('default_workdir', workdir); // resolveWorkdir falls back here since no workspace_id set

  const task = createQueueTask({ title: 'Write the docs', assigned_to: 'builder-1', project_id: projectId, created_by: 'human' });
  writeFileSyncFs(join(workdir, 'new-file.txt'), 'content');
  writeTasks('builder-1', `- [x] Write the docs\n`);

  await checkQueueTasks();

  const log = execSync('git log --pretty=%s', { cwd: workdir, encoding: 'utf8' });
  assert.match(log, /Write the docs \(#\d+, builder-1\)/);
});

test('checkQueueTasks does not attempt a commit for a task with no project_id', async () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'No project task', assigned_to: 'builder-2', created_by: 'human' });
  writeTasks('builder-2', `- [x] No project task\n`);

  await assert.doesNotReject(() => checkQueueTasks());
  assert.equal(getQueueTask(task.id).status, 'done');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && node --test tests/queue.test.js`
Expected: FAIL — the first new test's `git log` never gets the commit (hook doesn't exist yet).

- [ ] **Step 3: Add the commit hook**

In `dashboard/queue.js`, add these imports at the top:

```js
import { resolveWorkdir } from './projects.js';
import { commitTaskForProject } from './projectGit.js';
```

Change the body of the `for (const task of inProgress)` loop's completion check in `checkQueueTasks` from:

```js
    try {
      const content = readTasks(task.assigned_to);
      const re = new RegExp(`^- \\[x\\] ${escapeRegex(task.title)}`, 'im');
      if (re.test(content)) completeQueueTask(task.id, '');
    } catch { /* task file unreadable — skip */ }
```

to:

```js
    try {
      const content = readTasks(task.assigned_to);
      const re = new RegExp(`^- \\[x\\] ${escapeRegex(task.title)}`, 'im');
      if (re.test(content)) {
        completeQueueTask(task.id, '');
        if (task.project_id != null && process.env.FLINT_TEST_MODE !== '1') {
          const workdir = resolveWorkdir(task.project_id);
          commitTaskForProject(workdir, `${task.title} (#${task.id}, ${task.assigned_to})`);
        }
      }
    } catch { /* task file unreadable — skip */ }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && node --test tests/queue.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/queue.js dashboard/tests/queue.test.js
git commit -m "feat(project-git): commit to the project workspace when a project-linked task completes"
```

---

### Task 6: Completion route, sync-repo route, and PR-status polling

**Files:**
- Modify: `dashboard/server.js`
- Test: `dashboard/tests/server.test.js`

**Interfaces:**
- Consumes: `setOrchestrationPR` (Task 1), `ensureProjectRepo` (Task 3), `pushBranch`/`createPR`/`getPRStatus` (Task 2, generalized), `resolveWorkdir` (existing).

- [ ] **Step 1: Write the failing tests**

Add to `dashboard/tests/server.test.js`'s import block, add `setOrchestrationPR` to the existing `orchestrator.js` import, and add a `projects.js` import if not already present for `createProject`. Then append these tests (they run in `FLINT_TEST_MODE=1`, matching every other route test in this file, so real git/network calls are stubbed by `forgejo.js`'s own TEST_MODE guards):

```js
test('POST /orchestrations/:id/complete marks status done and returns pr_status null when not project-linked', async () => {
  const created = await req('POST', '/orchestrations', { goal: 'ad-hoc', workdir: process.cwd() });
  const res = await req('POST', `/orchestrations/${created.body.id}/complete`, { summary: 'done' });
  assert.equal(res.status, 200);
  assert.equal(res.body.pr_status, null);
});

test('POST /orchestrations/:id/complete 404s for an unknown orchestration', async () => {
  const res = await req('POST', '/orchestrations/999999/complete', {});
  assert.equal(res.status, 404);
});

test('POST /projects/:id/sync-repo 404s for an unknown project', async () => {
  const res = await req('POST', '/projects/999999/sync-repo', {});
  assert.equal(res.status, 404);
});
```

(This test file's `req` helper and `baseUrl`/`server` setup already exist earlier in the file — reuse them, don't redefine.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && node --test tests/server.test.js`
Expected: FAIL — both routes don't exist yet (404 for all three, but the first test expects 200 with a `pr_status` field).

- [ ] **Step 3: Add the routes**

In `dashboard/server.js`, update the existing imports:

```js
import { createOrchestration, getOrchestration, listOrchestrations, appendScratchpad, readScratchpad, updateOrchestrationStatus, setOrchestrationPR } from './orchestrator.js';
```

```js
import { isForgejoReachable, pushBranch, createPR, getPRStatus } from './forgejo.js';
```
stays the same (already imports what's needed — `pushBranch`/`createPR`/`getPRStatus` are now workdir-aware from Task 2, no import change required here).

Add:
```js
import { resolveWorkdir, getProject } from './projects.js';
```
(`getProject` may already be imported on this line from earlier work this session — merge into the existing `projects.js` import rather than duplicating the line.)

```js
import { ensureProjectRepo } from './projectGit.js';
```

Add these two routes in the "Orchestration routes" section, after the existing `POST /orchestrations/:id/scratchpad` route:

```js
  app.post('/orchestrations/:id/complete', async (req, res) => {
    const id = Number(req.params.id);
    const orch = getOrchestration(id);
    if (!orch) return res.status(404).json({ error: 'orchestration not found' });

    const { summary } = req.body ?? {};
    if (summary) appendScratchpad(id, `\n## Synthesis\n\n${summary}`);
    updateOrchestrationStatus(id, 'done');

    if (!orch.branch) {
      return res.json({ ok: true, pr_status: null });
    }

    const workdir = resolveWorkdir(orch.project_id);
    try {
      const remoteCheck = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' }).trim();
      if (!remoteCheck) {
        setOrchestrationPR(id, { prNumber: null, prUrl: null, prStatus: 'no_remote' });
        return res.json({ ok: true, pr_status: 'no_remote' });
      }
      pushBranch(orch.branch, workdir);
      const { prNumber, prUrl } = await createPR(orch.branch, orch.agent_name, workdir);
      setOrchestrationPR(id, { prNumber, prUrl, prStatus: 'open' });
      broadcastGlobal({ type: 'orchestration_pr_opened', id, prNumber, prUrl });
      res.json({ ok: true, pr_status: 'open', prNumber, prUrl });
    } catch (err) {
      setOrchestrationPR(id, { prNumber: null, prUrl: null, prStatus: 'failed' });
      logError('orchestration PR creation failed', { id, err: err.message });
      res.json({ ok: true, pr_status: 'failed' });
    }
  });
```

Add this route in the "Project routes" section, after the existing `POST /projects/:id/launch` route:

```js
  app.post('/projects/:id/sync-repo', async (req, res) => {
    const id = Number(req.params.id);
    const project = getProject(id);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const workdir = resolveWorkdir(id);
    try {
      const result = await ensureProjectRepo(id, workdir);
      if (result.hasRemote) {
        const pending = listOrchestrations().filter(
          o => o.project_id === id && o.pr_status === 'no_remote' && o.branch
        );
        for (const orch of pending) {
          try {
            pushBranch(orch.branch, workdir);
            const { prNumber, prUrl } = await createPR(orch.branch, orch.agent_name, workdir);
            setOrchestrationPR(orch.id, { prNumber, prUrl, prStatus: 'open' });
            broadcastGlobal({ type: 'orchestration_pr_opened', id: orch.id, prNumber, prUrl });
          } catch (err) {
            logError('sync-repo retry PR failed', { orchestrationId: orch.id, err: err.message });
          }
        }
      }
      res.json({ ok: true, hasRemote: result.hasRemote });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
```

Finally, extend the existing PR-status poller (the `setInterval` block near the bottom of `createApp`, right after the WebSocket `ws.on('close', ...)` handler) to also poll open project PRs. Change:

```js
  if (!TEST_MODE) {
    const prPollInterval = setInterval(async () => {
      const agents = listOpenPRAgents();
      for (const { name, pr_number } of agents) {
        try {
          const current = getAgentPR(name);
          const status = current?.pr_url?.includes('github.com')
            ? await getGitHubPRStatus(pr_number, current.pr_url)
            : await getPRStatus(pr_number);
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

to:

```js
  if (!TEST_MODE) {
    const prPollInterval = setInterval(async () => {
      const agents = listOpenPRAgents();
      for (const { name, pr_number } of agents) {
        try {
          const current = getAgentPR(name);
          const status = current?.pr_url?.includes('github.com')
            ? await getGitHubPRStatus(pr_number, current.pr_url)
            : await getPRStatus(pr_number);
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

      const openOrchestrations = listOrchestrations().filter(o => o.pr_status === 'open' && o.pr_number);
      for (const orch of openOrchestrations) {
        try {
          const workdir = resolveWorkdir(orch.project_id);
          const status = await getPRStatus(orch.pr_number, workdir);
          if (status !== orch.pr_status) {
            setOrchestrationPR(orch.id, { prNumber: orch.pr_number, prUrl: orch.pr_url, prStatus: status });
            broadcastGlobal({ type: 'orchestration_pr_status', id: orch.id, status });
          }
        } catch (err) {
          logError('orchestration PR poll failed', { id: orch.id, err: err.message });
        }
      }
    }, 30_000);
    httpServer.on('close', () => clearInterval(prPollInterval));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && node --test tests/server.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Run the full dashboard test suite**

Run: `cd dashboard && npm test`
Expected: same pass/fail count as the pre-existing baseline (283 tests, 272 pass, 11 pre-existing unrelated failures — confirmed earlier this session via `git stash`) plus all newly-added tests from Tasks 1-6 passing. No new failures.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server.js dashboard/tests/server.test.js
git commit -m "feat(project-git): add orchestration-complete and project sync-repo routes, extend PR polling"
```

---

### Task 7: Orchestrator task-file template — instruct the orchestrator to call `/complete`

**Files:**
- Modify: `dashboard/orchestrator.js` (`buildOrchestratorTaskFile` template only)
- Test: `dashboard/tests/orchestrator.test.js`

**Interfaces:**
- No new exports; this task only changes the generated markdown string.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/orchestrator.test.js`:

```js
test('buildOrchestratorTaskFile instructs the orchestrator to call the complete endpoint', () => {
  const content = buildOrchestratorTaskFile({
    goal: 'Build a REST API with JWT auth',
    id: 1,
    workdir: 'C:\\Projects\\myapp',
    scratchpadPath: 'tasks/orch-1/scratchpad.md',
  });
  assert.ok(content.includes('/orchestrations/1/complete'), 'complete endpoint missing');
  assert.ok(content.includes('"summary"'), 'summary field missing from complete example');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && node --test tests/orchestrator.test.js`
Expected: FAIL — `content.includes('/orchestrations/1/complete')` is `false` (no such text in the template yet).

- [ ] **Step 3: Update the template**

In `dashboard/orchestrator.js`, in `buildOrchestratorTaskFile`, change the job list's final step from:

```
6. When all tasks are done, write a synthesis to the scratchpad.
```

to:

```
6. When all tasks are done, call the Mark Orchestration Complete endpoint below with your synthesis.
```

Then, in the `## Flint REST API` section, add a new subsection right after `### Append to scratchpad` (which stays as-is for interim progress notes):

```
### Mark orchestration complete
Call this once, as your final action, when the goal is fully done. It records
your synthesis, marks the project done, and — for project-linked runs — pushes
your branch and opens a PR automatically (or marks it for later sync if
Forgejo isn't reachable right now).
\`\`\`bash
curl -s -X POST http://localhost:${process.env.PORT ?? 3000}/orchestrations/${id}/complete \\
  -H "Content-Type: application/json" \\
  -d '{"summary":"<your synthesis — what was built, key decisions, anything for the reviewer>"}'
\`\`\`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && node --test tests/orchestrator.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Run the full dashboard test suite one final time**

Run: `cd dashboard && npm test`
Expected: same baseline as Task 6's Step 5, plus this task's new test passing.

- [ ] **Step 6: Commit**

```bash
git add dashboard/orchestrator.js dashboard/tests/orchestrator.test.js
git commit -m "feat(project-git): orchestrator task file instructs calling /orchestrations/:id/complete"
```

---

## Post-implementation manual check

After all 7 tasks are committed, do one real end-to-end smoke test (not covered by the automated tests, which all run in `FLINT_TEST_MODE`):

1. Create a project with a blank workspace folder and a goal, launch it.
2. Confirm a matching repo appears in Forgejo's web UI (`http://localhost:3030`) and the workspace folder now has a `.git` directory and a `forgejo` remote.
3. Let a specialist complete a task; confirm a new commit shows up (`git log` in the workspace).
4. Call `POST /orchestrations/:id/complete` with a summary; confirm a PR appears in Forgejo for that repo.
5. Stop the Forgejo container, create a second blank-workspace project, launch it; confirm the workspace is git-initialized locally with no remote and the launch does not error.
6. Start Forgejo back up, call `POST /projects/:id/sync-repo` for that second project; confirm the repo now exists in Forgejo and the workspace's local commits are pushed.

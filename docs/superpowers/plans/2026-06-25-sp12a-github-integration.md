# SP12a: GitHub Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub as a PR target alongside Forgejo — auto-detected from the agent's git remotes, requiring zero per-agent configuration.

**Architecture:** New `dashboard/github.js` mirrors the `forgejo.js` interface (4 functions + `detectProvider` + `parseOwnerRepo`). `server.js` imports `detectProvider` and routes `createPRForAgent` and the PR polling loop to GitHub or Forgejo based on the agent's remote URLs. No new npm dependencies, no DB changes.

**Tech Stack:** Node.js, `fetch` (built-in), `execSync` (built-in), `node:test` (existing).

## Global Constraints

- No new npm dependencies — uses `fetch` and `execSync` like `forgejo.js`.
- No DB schema changes — provider inferred from stored `pr_url` at runtime.
- GitHub API base URL: `https://api.github.com` (hardcoded — no env var).
- Auth header: `Authorization: Bearer <token>` (not `token <token>`).
- Token source: `getApiKeyValue('github')` — DB-first, env `GITHUB_TOKEN` fallback.
- `TEST_MODE`: check `process.env.FLINT_TEST_MODE === '1'` via a function (matches `forgejo.js` pattern).
- `detectProvider` and `parseOwnerRepo` must be exported from `github.js` (needed for unit tests).
- PR base branch: `master` (matches `forgejo.js`).
- `node --test` must pass all existing + new tests. Target: 160 existing + 7 new = 167 total.
- All commits on `master`.

---

### Task 1: `dashboard/github.js` + tests

**Files:**
- Create: `dashboard/github.js`
- Create: `dashboard/tests/github.test.js`
- Modify: `dashboard/package.json` — add `tests/github.test.js` to test script

**Interfaces:**
- Consumes: `getApiKeyValue(name: string): string | null` from `./apikeys.js`
- Produces:
  - `parseOwnerRepo(remoteUrl: string): { owner: string, repo: string } | null`
  - `detectProvider(workdir: string): 'github' | 'forgejo'`
  - `isGitHubReachable(): Promise<boolean>`
  - `pushToGitHub(branch: string, workdir: string): void`
  - `createGitHubPR(branch: string, agentName: string, workdir: string): Promise<{ prNumber: number, prUrl: string }>`
  - `getGitHubPRStatus(prNumber: number, prUrl: string): Promise<'open' | 'closed' | 'merged'>`

---

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/github.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

process.env.FLINT_TEST_MODE = '1';

import {
  isGitHubReachable,
  pushToGitHub,
  createGitHubPR,
  getGitHubPRStatus,
  detectProvider,
  parseOwnerRepo,
} from '../github.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '../..');

test('isGitHubReachable returns true in test mode', async () => {
  assert.equal(await isGitHubReachable(), true);
});

test('pushToGitHub is a no-op in test mode', () => {
  pushToGitHub('test-branch', process.cwd());
});

test('createGitHubPR returns mock data in test mode', async () => {
  const result = await createGitHubPR('test-branch', 'agent1', process.cwd());
  assert.equal(result.prNumber, 1);
  assert.ok(result.prUrl.startsWith('https://github.com/'));
});

test('getGitHubPRStatus returns "open" in test mode', async () => {
  assert.equal(await getGitHubPRStatus(1, 'https://github.com/robin/flint/pull/1'), 'open');
});

test('parseOwnerRepo parses HTTPS URL', () => {
  assert.deepEqual(
    parseOwnerRepo('https://github.com/robin/flint.git'),
    { owner: 'robin', repo: 'flint' }
  );
});

test('parseOwnerRepo parses SSH URL', () => {
  assert.deepEqual(
    parseOwnerRepo('git@github.com:robin/flint.git'),
    { owner: 'robin', repo: 'flint' }
  );
});

test('detectProvider returns "forgejo" when git fails or no github remote', () => {
  // The Flint repo has a forgejo remote, not a github remote
  assert.equal(detectProvider(FLINT_ROOT), 'forgejo');
});
```

- [ ] **Step 2: Run tests — expect failure (module not yet created)**

```bash
cd dashboard && node --test tests/github.test.js 2>&1 | tail -5
```

Expected: error about `../github.js` not found.

- [ ] **Step 3: Create `dashboard/github.js`**

```js
import { execSync } from 'child_process';
import { getApiKeyValue } from './apikeys.js';

const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';
const GITHUB_API = 'https://api.github.com';

function getToken() {
  return getApiKeyValue('github') ?? '';
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
    'User-Agent': 'Flint/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function findGitHubRemote(workdir) {
  const out = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
  const match = out.match(/^(\S+)\s+[^\s]*github\.com/m);
  return match?.[1] ?? null;
}

export function parseOwnerRepo(remoteUrl) {
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function detectProvider(workdir) {
  try {
    const out = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
    return out.includes('github.com') ? 'github' : 'forgejo';
  } catch {
    return 'forgejo';
  }
}

export async function isGitHubReachable() {
  if (TEST_MODE()) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(GITHUB_API, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export function pushToGitHub(branch, workdir) {
  if (TEST_MODE()) return;
  const remote = findGitHubRemote(workdir);
  if (!remote) throw new Error(`No GitHub remote found in ${workdir}`);
  execSync(`git push "${remote}" "${branch}"`, { cwd: workdir });
}

export async function createGitHubPR(branch, agentName, workdir) {
  if (TEST_MODE()) {
    return { prNumber: 1, prUrl: 'https://github.com/test/repo/pull/1' };
  }
  const remote = findGitHubRemote(workdir);
  if (!remote) throw new Error(`No GitHub remote found in ${workdir}`);
  const remoteUrl = execSync(`git remote get-url "${remote}"`, {
    cwd: workdir,
    encoding: 'utf8',
  }).trim();
  const parsed = parseOwnerRepo(remoteUrl);
  if (!parsed) throw new Error(`Cannot parse owner/repo from remote URL: ${remoteUrl}`);
  const { owner, repo } = parsed;
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      title: `[${agentName}] ${branch}`,
      head: branch,
      base: 'master',
      body: `Automated PR created by Flint agent \`${agentName}\`.`,
    }),
  });
  if (!res.ok) throw new Error(`GitHub createPR failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { prNumber: data.number, prUrl: data.html_url };
}

export async function getGitHubPRStatus(prNumber, prUrl) {
  if (TEST_MODE()) return 'open';
  const parsed = parseOwnerRepo(prUrl);
  if (!parsed) throw new Error(`Cannot parse owner/repo from PR URL: ${prUrl}`);
  const { owner, repo } = parsed;
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`GitHub getPRStatus failed: ${res.status}`);
  const data = await res.json();
  if (data.merged) return 'merged';
  if (data.state === 'closed') return 'closed';
  return 'open';
}
```

- [ ] **Step 4: Update `dashboard/package.json` test script**

In `package.json`, replace:
```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js tests/telegram.test.js"
```

With:
```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js tests/telegram.test.js tests/github.test.js"
```

- [ ] **Step 5: Run the full test suite — expect 167 pass (160 + 7 new)**

```bash
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 167
ℹ pass 165
ℹ fail 2
```

(The 2 pre-existing EPERM failures in `sp5.test.js`/`sp6.test.js` on Windows are unrelated to this change.)

- [ ] **Step 6: Commit**

```bash
git add dashboard/github.js dashboard/tests/github.test.js dashboard/package.json
git commit -m "feat(sp12a): add github.js — auto-detect provider, push branch, create PR, poll status"
```

---

### Task 2: `server.js` wiring

**Files:**
- Modify: `dashboard/server.js`
  - Add import of `detectProvider`, `isGitHubReachable`, `pushToGitHub`, `createGitHubPR`, `getGitHubPRStatus` from `./github.js`
  - Replace `createPRForAgent` with provider-aware version
  - Update PR polling loop to route status check by `pr_url`

**Interfaces:**
- Consumes (from Task 1):
  - `detectProvider(workdir: string): 'github' | 'forgejo'`
  - `isGitHubReachable(): Promise<boolean>`
  - `pushToGitHub(branch: string, workdir: string): void`
  - `createGitHubPR(branch: string, agentName: string, workdir: string): Promise<{ prNumber, prUrl }>`
  - `getGitHubPRStatus(prNumber: number, prUrl: string): Promise<'open' | 'closed' | 'merged'>`
- Produces: nothing consumed by other tasks

---

- [ ] **Step 1: Add `github.js` import to `server.js`**

In `dashboard/server.js`, after line 15 (the `forgejo.js` import):

```js
import { isForgejoReachable, pushBranch, createPR, getPRStatus } from './forgejo.js';
import { detectProvider, isGitHubReachable, pushToGitHub, createGitHubPR, getGitHubPRStatus } from './github.js';
```

- [ ] **Step 2: Replace `createPRForAgent` (lines 30–48)**

Replace the entire `createPRForAgent` function:

```js
async function createPRForAgent(name, branch) {
  try {
    info('creating PR', { agent: name, branch });
    const worktree = getAgentWorktree(name);
    const workdir = worktree?.worktree_path ?? FLINT_ROOT;
    const provider = detectProvider(workdir);

    if (provider === 'github') {
      const reachable = await isGitHubReachable();
      if (!reachable) {
        logError('PR creation skipped — GitHub unreachable', { agent: name });
        broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
        return;
      }
      pushToGitHub(branch, workdir);
      const { prNumber, prUrl } = await createGitHubPR(branch, name, workdir);
      setAgentPR(name, prNumber, prUrl, 'open');
      broadcastToAgent(name, { type: 'worktree_pr', agent: name, prUrl, prNumber });
      info('PR created', { agent: name, prNumber, prUrl });
    } else {
      const reachable = await isForgejoReachable();
      if (!reachable) {
        logError('PR creation skipped — Forgejo unreachable', { agent: name });
        broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
        return;
      }
      pushBranch(branch);
      const { prNumber, prUrl } = await createPR(branch, name);
      setAgentPR(name, prNumber, prUrl, 'open');
      broadcastToAgent(name, { type: 'worktree_pr', agent: name, prUrl, prNumber });
      info('PR created', { agent: name, prNumber, prUrl });
    }
  } catch (err) {
    logError('PR creation failed', { agent: name, err: err.message });
    broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
  }
}
```

- [ ] **Step 3: Update the PR polling loop (lines 553–556)**

The current polling loop reads (lines 553–558):

```js
      for (const { name, pr_number } of agents) {
        try {
          const status = await getPRStatus(pr_number);
          const current = getAgentPR(name);
          if (current && current.pr_status !== status) {
            setAgentPR(name, pr_number, current.pr_url, status);
```

Replace with (move `current` before `status`, add GitHub branch):

```js
      for (const { name, pr_number } of agents) {
        try {
          const current = getAgentPR(name);
          const status = current?.pr_url?.includes('github.com')
            ? await getGitHubPRStatus(pr_number, current.pr_url)
            : await getPRStatus(pr_number);
          if (current && current.pr_status !== status) {
            setAgentPR(name, pr_number, current.pr_url, status);
```

- [ ] **Step 4: Run the full test suite — expect same count as after Task 1**

```bash
cd dashboard && node --test 2>&1 | tail -8
```

Expected (same as Task 1 result):
```
ℹ tests 167
ℹ pass 165
ℹ fail 2
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/server.js
git commit -m "feat(sp12a): wire GitHub provider into createPRForAgent and PR polling loop"
```

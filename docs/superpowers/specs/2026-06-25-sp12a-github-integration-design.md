# SP12a: GitHub Integration — Design Spec

**Date:** 2026-06-25
**Status:** Approved

## Overview

Extend Flint's worktree PR workflow to support GitHub repositories. When an agent finishes work in an isolated worktree, Flint auto-detects whether the repo's git remotes point at GitHub or Forgejo, then uses the appropriate provider to push the branch and open a PR. No manual provider configuration required.

---

## Architecture

**New file:** `dashboard/github.js` — mirrors the `forgejo.js` interface exactly, plus exports `detectProvider`. Reads the GitHub token via `getApiKeyValue('github')` (already seeded as `GITHUB_TOKEN`). No new npm dependencies — uses `fetch` and `execSync` like `forgejo.js`.

**Modified:** `dashboard/server.js` — adds a `detectProvider(workdir)` helper and updates `createPRForAgent` to branch on provider. Updates the PR status polling loop to infer provider from the stored `pr_url`.

**No DB changes** — provider is inferred at runtime from the stored `pr_url` string (`includes('github.com')` → GitHub, otherwise Forgejo). Zero new columns.

---

## github.js Module

### Token

Read via `getApiKeyValue('github')` — DB-first, falls back to `process.env.GITHUB_TOKEN`. If no token, `isGitHubReachable()` returns false and `createGitHubPR` throws.

Auth header: `Authorization: Bearer <token>` (works for classic PATs and fine-grained tokens).

### Internal Helpers

**`findGitHubRemote(workdir): string | null`**

Finds the name of the git remote whose URL contains `github.com`:

```js
function findGitHubRemote(workdir) {
  const out = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
  const match = out.match(/^(\S+)\s+[^\s]*github\.com/m);
  return match?.[1] ?? null;
}
```

Returns the remote name (e.g. `'origin'`, `'github'`) or null if none found.

**`parseOwnerRepo(remoteUrl): { owner, repo } | null`**

Handles both HTTPS and SSH URL formats:
- `https://github.com/robin/flint.git` → `{ owner: 'robin', repo: 'flint' }`
- `git@github.com:robin/flint.git` → `{ owner: 'robin', repo: 'flint' }`

```js
function parseOwnerRepo(remoteUrl) {
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}
```

### Exported Functions

**`isGitHubReachable(): Promise<boolean>`**

Hits `https://api.github.com` with a 2-second timeout. Returns false on network error or timeout. In `TEST_MODE` returns true.

**`pushToGitHub(branch, workdir): void`**

Runs `git push <remote> "<branch>"` where `<remote>` is the name returned by `findGitHubRemote(workdir)`. Throws if no GitHub remote found. In `TEST_MODE` is a no-op.

**`createGitHubPR(branch, agentName, workdir): Promise<{ prNumber, prUrl }>`**

1. Calls `findGitHubRemote(workdir)` to get the remote name
2. Calls `git remote get-url <remote>` to get the full remote URL
3. Calls `parseOwnerRepo(url)` to extract `owner` and `repo`
4. `POST https://api.github.com/repos/{owner}/{repo}/pulls` with:
   - `title`: `[${agentName}] ${branch}`
   - `head`: `branch`
   - `base`: `master`
   - `body`: `Automated PR created by Flint agent \`${agentName}\`.`
5. Returns `{ prNumber: data.number, prUrl: data.html_url }`

In `TEST_MODE` returns `{ prNumber: 1, prUrl: 'https://github.com/test/repo/pull/1' }`.

**`getGitHubPRStatus(prNumber, prUrl): Promise<'open' | 'closed' | 'merged'>`**

Parses `owner` and `repo` from the stored `prUrl` string using `parseOwnerRepo`. Calls `GET https://api.github.com/repos/{owner}/{repo}/pulls/{prNumber}`. Returns `'merged'` if `data.merged`, `'closed'` if `data.state === 'closed'`, otherwise `'open'`. In `TEST_MODE` returns `'open'`.

---

## server.js Changes

### `detectProvider(workdir): 'github' | 'forgejo'`

Exported from `github.js` (so it is directly unit-testable) and imported into `server.js`:

```js
export function detectProvider(workdir) {
  try {
    const out = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
    return out.includes('github.com') ? 'github' : 'forgejo';
  } catch { return 'forgejo'; }
}
```

### Updated `createPRForAgent`

```js
async function createPRForAgent(name, branch) {
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
  } else {
    // existing Forgejo path unchanged
    const reachable = await isForgejoReachable();
    if (!reachable) { ... }
    pushBranch(branch);
    const { prNumber, prUrl } = await createPR(branch, name);
    setAgentPR(name, prNumber, prUrl, 'open');
    broadcastToAgent(name, { type: 'worktree_pr', agent: name, prUrl, prNumber });
  }
}
```

### Updated PR Status Polling

In the existing polling loop (where `getPRStatus(pr_number)` is called), infer provider from the stored `pr_url`:

```js
const { pr_url } = getAgentPR(name);
const status = pr_url?.includes('github.com')
  ? await getGitHubPRStatus(pr_number, pr_url)
  : await getPRStatus(pr_number);
```

---

## Configuration

No new env vars required. GitHub token configured via the 🔑 Keys modal (`GITHUB_TOKEN`). GitHub remote added to the repo with standard `git remote add` — any name works as long as the URL contains `github.com`.

---

## Out of Scope

- GitHub Actions integration
- GitHub Issues management
- Configuring base branch per-repo (always `master` — same as Forgejo)
- Support for GitHub Enterprise (different hostname)
- Multiple GitHub remotes in the same repo (first match wins)

---

## Test Approach

`dashboard/tests/github.test.js` — unit tests using `FLINT_TEST_MODE=1` (same pattern as existing `forgejo.js` tests in `server.test.js`):

- `isGitHubReachable()` returns true in test mode
- `pushToGitHub` is a no-op in test mode (no git command runs)
- `createGitHubPR` returns `{ prNumber: 1, prUrl: 'https://github.com/test/repo/pull/1' }` in test mode
- `parseOwnerRepo` correctly parses HTTPS URL (`https://github.com/robin/flint.git`)
- `parseOwnerRepo` correctly parses SSH URL (`git@github.com:robin/flint.git`)
- `detectProvider` returns `'github'` when remote output contains `github.com`
- `detectProvider` returns `'forgejo'` when remote output does not contain `github.com`

Target: ~7 tests. Existing 160-test suite must still pass.

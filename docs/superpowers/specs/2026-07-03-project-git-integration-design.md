# Project Git Integration — Design Spec

**Date:** 2026-07-03
**Status:** Approved, ready for planning

## Problem

Project Orchestration (SP18) lets a project spawn an orchestrator + specialists into
a workspace directory, and those agents write files directly into it. Nothing commits
or pushes any of that work anywhere. The existing git/PR pipeline
(`createPRForAgent` in `server.js`, `forgejo.js`, `github.js`) only fires for the
older single-agent "worktree" workflow, where an agent works in a `.worktrees/<name>`
branch of the Flint repo itself and opens a PR back into Flint. It has no concept of
an external project's own repo, and `forgejo.js` hardcodes Flint's own
owner/repo (`robin`/`flint`) rather than deriving it from an arbitrary workdir.

Project workspaces vary: some are already git repos (possibly on GitHub or
elsewhere), some are blank folders. This spec adds git lifecycle management scoped
to project-linked orchestrations, without touching the existing worktree/PR
pipeline, autoPickup, or any ad-hoc (non-project) agent flow.

## Goals

- A project's workspace ends up backed by a git repo, whether it started blank or
  already existed.
- Agent work is committed at task granularity (one commit per completed
  project-linked task), not just squashed at the end.
- When an orchestration finishes, its branch is pushed and a PR opens automatically
  — no manual step required.
- If Forgejo is unreachable when a blank workspace needs a new repo, work proceeds
  locally (git-init only) and syncs to Forgejo once it's reachable again, either
  automatically (next launch) or on demand.

## Non-goals

- Multi-specialist isolation within a single project (each specialist still shares
  one workspace directory and one active branch — same as the already-fixed
  workdir-resolution behavior this session; true parallel isolation would need
  per-specialist worktrees, out of scope here).
- Changing the existing single-agent worktree/PR workflow (`createPRForAgent`,
  `.worktrees/`) — untouched by this feature.
- GitHub as an auto-creation target for blank workspaces (Forgejo only, per
  decision below). Existing-repo projects that already point at GitHub continue to
  use GitHub via the existing `detectProvider` precedence.
- Preventing two specialists from editing the same file concurrently — a
  pre-existing risk of the shared-workspace model, not solved by this feature.

## Data model

No duplicated git metadata on `projects`/`workspaces` — a workspace's own
`git remote -v` remains the single source of truth for provider/repo, consistent
with how `github.js` already derives owner/repo from the workdir's remote rather
than from stored config.

`orchestrations` table gains four columns (mirrors the existing worktree/PR columns
already on `agents_log`, just scoped to a project orchestration run instead of a
single worktree agent):

```sql
ALTER TABLE orchestrations ADD COLUMN branch     TEXT;
ALTER TABLE orchestrations ADD COLUMN pr_number  INTEGER;
ALTER TABLE orchestrations ADD COLUMN pr_url     TEXT;
ALTER TABLE orchestrations ADD COLUMN pr_status  TEXT;  -- open | merged | closed | no_remote | failed
```

`pr_status` values:
- `open` — PR successfully opened.
- `merged` / `closed` — mirrors existing lifecycle (updated the same way agent PRs
  already are, via whatever polling/webhook mechanism keeps `agents_log.pr_status`
  current today).
- `no_remote` — orchestration completed but the project's workspace has no remote
  yet (Forgejo was unreachable when the workspace was created, or it's still
  offline). Branch and commits exist locally only.
- `failed` — a remote existed but the push or PR-creation API call errored.

## Repo detection/creation — `ensureProjectRepo(projectId, workdir)`

Called at the start of `launchProject` (before spawning the orchestrator), and
reusable standalone for manual sync. Idempotent — safe to call on every launch.

1. Check if `workdir` is already a git repo (`git rev-parse --is-inside-work-tree`).
2. **Already a repo, has a remote** (Forgejo or GitHub, via `detectProvider`-style
   detection) → no-op, proceed.
3. **Already a repo, no remote** → treated the same as case 5 below (attempt to
   attach a remote; proceed locally if Forgejo is unreachable).
4. **Not a repo, Forgejo reachable** → slugify the project name into a repo name,
   create the repo in Forgejo via a new `createRepo(name)` in `forgejo.js` (using
   the same admin token `forgejo-init.ps1` already provisions), `git init` the
   workspace, add the `forgejo` remote, commit whatever's already present (or an
   empty initial commit), push to `master`.
   - If the repo name already exists in Forgejo: if it's this project's own repo
     from a prior run, reuse it (idempotent reuse, same pattern
     `forgejo-init.ps1` uses for "already exists"); if it belongs to something
     else, fail the launch with a clear error rather than silently attaching to
     the wrong repo.
5. **Not a repo, Forgejo unreachable** → `git init` + local initial commit only, no
   remote. No error, launch proceeds.
6. Any failure *other than* "Forgejo unreachable" (git missing, permissions, disk
   errors) fails the launch outright with a clear error surfaced on the project
   card — distinct from the offline case, which is expected/recoverable.

## Re-sync

Two paths, both reusing `ensureProjectRepo` — no separate sync code path:

- **Automatic**: every relaunch of a project re-runs `ensureProjectRepo`. If
  Forgejo is now reachable and the workspace still has no remote, it creates and
  attaches the repo and pushes everything accumulated locally.
- **Manual**: new `POST /projects/:id/sync-repo` route calls the same function
  on demand, for projects that finished in one launch and won't be relaunched.

When a sync attaches a remote for the first time, it also pushes the branch and
retries PR creation for any orchestration under that project sitting at
`pr_status = 'no_remote'`.

## Branch per orchestration run

`createOrchestration`, once `ensureProjectRepo` has guaranteed a repo (with or
without a remote), creates and checks out a branch named
`project/<project-slug>-orch-<id>` in the workspace, and stores the branch name on
the orchestration row. All specialists for that project share the one workspace
directory and therefore the one active branch.

## Per-task commits

Hooks into the existing `checkQueueTasks()` poller in `queue.js`, which already
detects task completion by polling for `- [x]` in an agent's task file and calls
`completeQueueTask()`. Immediately after a task with a `project_id` completes:

```
git add -A && git commit -m "<task title> (#<task id>, <assigned_to>)"
```
scoped to that project's resolved workspace (`resolveWorkdir(project_id)`, from
the workdir-resolution fix already shipped this session).

- A commit with nothing to commit is swallowed silently (expected/benign).
- A real git error is logged but does not crash the poller.
- Commits for a given workspace are serialized through an in-memory
  `Map<workdir, Promise>` lock, so two tasks completing in the same poll tick
  can't race the same git index. This prevents git-level corruption only — it
  does not prevent two specialists from editing the same file simultaneously
  (pre-existing risk of the shared-workspace model; see Non-goals).

## Completion + PR trigger

New route: `POST /orchestrations/:id/complete`, body `{ summary }` (optional). The
orchestrator's task-file template is updated to instruct it to call this as its
actual final step — replacing the current vague "write a synthesis to the
scratchpad" instruction with a concrete, actionable signal (the synthesis write
still happens; this is what makes completion observable to the rest of the
system).

On completion:
1. `updateOrchestrationStatus(id, 'done')`.
2. No `branch` on the orchestration (not project-linked, e.g. an ad-hoc
   `/orchestrations` call with no `projectId`) → nothing git-related happens,
   behavior unchanged from today.
3. Has a `branch`, workspace has a remote → push the branch (generalized
   `forgejo.js#pushBranch(branch, workdir)`), open a PR against `master`
   (generalized `createPR(branch, agentName, workdir)`), store
   `pr_number`/`pr_url`, `pr_status = 'open'`, broadcast a WS event so the
   dashboard can show a PR link on the project card.
4. Has a `branch`, no remote yet → `pr_status = 'no_remote'` (see Re-sync above).
5. Remote exists but push/API call fails → `pr_status = 'failed'`, logged and
   broadcast, same pattern as the existing `worktree_pr_failed` event.

`forgejo.js`'s `pushBranch`/`createPR` are generalized to accept a `workdir` and
derive owner/repo from that workdir's own `forgejo` remote, instead of the current
hardcoded Flint-repo config — mirroring how `github.js` already does this
correctly via `findGitHubRemote`/`parseOwnerRepo`.

## Error handling summary

| Scenario | Behavior |
|---|---|
| Forgejo unreachable, blank workspace | Local git-init only, launch proceeds, `no_remote` on completion |
| Forgejo unreachable, existing repo w/ remote already | Unaffected — remote already there |
| Non-git launch failure (git missing, perms, disk) | Launch fails outright, clear error on project card |
| Repo name collision with unrelated repo | Launch fails outright, clear error |
| Repo name collision with this project's own prior repo | Reused idempotently |
| Push/PR API failure at completion | `pr_status = 'failed'`, logged, broadcast, orchestration still marked done |
| Two tasks complete same tick | Serialized via in-memory per-workdir lock |
| Concurrent double-launch of same project | Existing `active_orchestration_id` guard, unchanged (out of scope) |

## Testing

- `ensureProjectRepo`: real temp git dirs (no git mocking, consistent with
  `worktrees.js`/`sp6.test.js` existing test style) covering: blank+Forgejo-up,
  blank+Forgejo-down, already-a-repo-with-remote, already-a-repo-no-remote.
- Per-task commit hook in `checkQueueTasks()`: real temp git repo; complete a
  project-linked task and assert a commit lands with the expected message; assert
  no commit/no crash for non-project tasks (regression guard against affecting
  existing behavior).
- `POST /orchestrations/:id/complete`: route test in `TEST_MODE` (mirrors existing
  `github.test.js`/`sp6.test.js` pattern — real git/network skipped, mocked
  push/PR) covering all four `pr_status` outcomes.
- `forgejo.js` generalization: unit tests confirming `pushBranch`/`createPR`
  derive owner/repo from an arbitrary workdir's own remote, not Flint's own.

## Open items for implementation planning

- Exact slugification rule for project name → repo name (collision-safe, matches
  existing agent-naming suffix convention `-2`, `-3`, etc. used elsewhere).
- Whether `pr_status` transitions to `merged`/`closed` are polled the same way
  `agents_log.pr_status` already is, or need their own poller — likely the same
  mechanism, generalized.

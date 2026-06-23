# Flint — Self-Improvement + CLI Providers: Design Spec
**Sub-project 5 of 5**
**Date:** 2026-06-23
**Status:** Approved

---

## 1. Problem

Flint has running agents, a dashboard, a multi-provider LLM router, and a project management module — but three gaps remain:

1. **API cost vs. subscription**: All LLM calls go through provider SDKs and cost per-token. Robin already has Claude Max and Gemini subscriptions; those CLI tools should be usable as free providers.
2. **Safe self-modification**: There's no safe way to point a Flint agent at the Flint codebase itself. An agent working directly on `master` could break the live system.
3. **Emergent improvement**: Agents surface useful observations during work, but there's nowhere to log them. Good insights are lost in terminal scroll.

---

## 2. Scope

**In:**
- CLI provider type in the router (`claude-cli`, `gemini-cli`, `mistral-cli`) — subprocess-based, cost logged as $0
- Worktree isolation for self-modification agents — `git worktree` branch per agent, merge/discard from dashboard or CLI
- Suggestion feed — agents emit `## SUGGESTION:` markers, captured to DB, surfaced in dashboard strip and CLI

**Out (explicitly not in this sub-project):**
- Forgejo / local git server
- Streaming responses over WebSocket
- Provider retry/fallback on failure
- Mammoth DAG pipeline orchestration
- Cost charts and forecasting
- Automatic suggestion application (suggestions are advisory only)
- PR review workflow

---

## 3. Platform

- **OS:** Windows 11 (local machine)
- **Runtime:** Node.js 20+, ESM throughout
- **DB:** `usage.sqlite` at Flint root (shared with SP2–SP4)
- **Dashboard:** `http://localhost:3000` (existing, extended)
- **Router:** `http://localhost:3001` (existing, extended)
- **Root:** `C:\Users\Robin\Applications Dev\Flint\`

---

## 4. File Structure

```
(modified)
router/
├── providers.js     ← add claude-cli, gemini-cli, mistral-cli cases
├── config.js        ← add cli providers to known provider list
router.json          ← user adds cli provider entries to tiers

dashboard/
├── db.js            ← add suggestions table; add worktree_path + worktree_branch to agents_log
├── suggestions.js   ← NEW: suggestion CRUD
├── worktrees.js     ← NEW: worktree lifecycle (create, list, merge, discard)
├── server.js        ← suggestion routes + worktree routes; spawn handler reads isolate flag
├── terminal.js      ← detect ## SUGGESTION: pattern in onData
├── public/
│   ├── index.html   ← isolate checkbox in spawn modal; suggestions strip; worktree badges + buttons
│   ├── app.js       ← suggestion rendering; worktree UI; isolate flag in spawn message
│   └── style.css    ← suggestion strip styles; isolated badge; merge/discard buttons

bin/
└── flint.js         ← flint suggestions list|dismiss; flint worktree list|merge|discard
```

---

## 5. CLI Providers

### 5.1 Configuration (`router.json`)

CLI providers are configured in `router.json` tiers exactly like SDK providers. The provider name suffix `-cli` identifies them:

```json
{
  "tiers": {
    "1": {
      "claude-cli": "claude",
      "gemini-cli": "gemini"
    },
    "2": {
      "anthropic": "claude-sonnet-4-6",
      "google": "gemini-2.0-flash"
    }
  }
}
```

The value (e.g. `"claude"`, `"gemini"`, `"mistral"`) is the CLI binary name used in `PATH`. If a binary is absent, the provider throws `Error('CLI not found: <binary>')` at call time.

### 5.2 `router/config.js`

Add `claude-cli`, `gemini-cli`, `mistral-cli` to the known provider set so `resolveRoute`, `getModels`, and `aggregateCosts` handle them without hardcoding. `getModels()` groups them under key `"cli"`.

### 5.3 `router/providers.js`

New cases in `complete(provider, model, messages)` for `claude-cli`, `gemini-cli`, `mistral-cli`:

**Prompt construction:** Concatenate messages into a single string:
```
[system content if present]

[user turn 1]
[assistant turn 1]
[user turn 2]
...
```

**Subprocess invocation:**

| Provider | Binary | stdin |
|---|---|---|
| `claude-cli` | `claude -p` | prompt written to stdin |
| `gemini-cli` | `gemini` | prompt written to stdin |
| `mistral-cli` | `mistral chat --no-interactive` | prompt written to stdin |

Spawn with `child_process.spawn`, write the prompt to stdin, then close stdin and collect stdout/stderr. Using stdin avoids OS command-line argument length limits for long prompts. If exit code ≠ 0, throw `Error('CLI error: <stderr>')`.

**Return value:** `{ text: stdout.trim(), costUsd: 0, tokensIn: 0, tokensOut: 0 }` — cost is always 0 (subscription covers it). Usage is written to the `usage` table with `cost_usd = 0` and `model = <binary-name>` so query history remains complete.

**Timeout:** 120 seconds (same as router HTTP timeout).

---

## 6. Worktree Isolation

### 6.1 Data Model

Two new nullable columns on `agents_log`:

```sql
ALTER TABLE agents_log ADD COLUMN worktree_path TEXT;
ALTER TABLE agents_log ADD COLUMN worktree_branch TEXT;
```

Added via `initDb()` in `dashboard/db.js` using try/catch: `try { db.exec('ALTER TABLE agents_log ADD COLUMN worktree_path TEXT') } catch {}` and the same for `worktree_branch`. SQLite throws if the column already exists; the catch silently ignores it, making this idempotent.

### 6.2 `dashboard/worktrees.js`

```js
// Creates a worktree and branch, returns { worktreePath, branch }
createWorktree(agentName) → { worktreePath: string, branch: string }
// branch: improve/<agentName>-<YYYYMMDD-HHmmss>
// worktreePath: <flintRoot>/.worktrees/<agentName>-<timestamp>

// Returns all agents_log rows with non-null worktree_path
listWorktrees() → [{ name, worktree_path, worktree_branch, status }]

// Runs: git -C <flintRoot> merge <branch>
// Then removes worktree and branch, clears worktree columns on agents_log row
mergeWorktree(agentName) → void  // throws on merge conflict

// Removes worktree (git worktree remove --force) and deletes branch
discardWorktree(agentName) → void
```

The Flint root is derived from `dirname(fileURLToPath(import.meta.url))` + `..` (one level up from `dashboard/`).

Git commands run via `child_process.execSync` with `{ cwd: flintRoot }`. Errors propagate as thrown exceptions.

### 6.3 Spawn Flow (`dashboard/server.js` + `dashboard/terminal.js`)

The WebSocket `spawn` message gains an optional `isolate: boolean` field:

```json
{ "type": "spawn", "agent": "flint-dev", "workdir": "C:/...", "isolate": true }
```

If `isolate` is true, the server calls `createWorktree(name)` before `spawnAgent`, then calls `spawnAgent(name, worktreePath, model)`. The `worktree_path` and `worktree_branch` are written to `agents_log`.

On PTY exit, if the agent has a worktree, the exit handler does **not** auto-remove it — it sends a `{ type: 'worktree_pending', agent: name, branch }` WebSocket message so the UI can show merge/discard controls.

### 6.4 REST Routes (`dashboard/server.js`)

```
GET  /worktrees
→ [{ name, worktree_path, worktree_branch, status }]

POST /worktrees/:agent/merge
→ { ok: true }  |  400 { error: 'merge conflict: ...' }

DELETE /worktrees/:agent
→ { ok: true }
```

### 6.5 Dashboard UI

**Spawn modal:** Add `<label><input type="checkbox" id="modal-isolate"> Isolated branch</label>` below the model dropdown. When checked, `isolate: true` is included in the `spawn` WebSocket message.

**Panel header:** Agents running in a worktree show an `isolated` badge (grey, same style as `observe` badge). When the PTY exits and the agent has a pending worktree, the Kill button is replaced by **Merge** and **Discard** buttons.

- **Merge** → `POST /worktrees/:agent/merge`. On success: badge removed, buttons removed. On conflict: show error text in panel header.
- **Discard** → `DELETE /worktrees/:agent` with a `confirm()` dialog. On success: buttons removed.

---

## 7. Suggestion Feed

### 7.1 Data Model

```sql
CREATE TABLE IF NOT EXISTS suggestions (
  id          INTEGER PRIMARY KEY,
  agent_name  TEXT NOT NULL,
  content     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Status values: `new` | `noted` | `dismissed`.

### 7.2 Detection (`dashboard/terminal.js`)

In `onData`, after the existing cost/model pattern matching, add:

```js
const SUGGESTION_REGEX = /^## SUGGESTION:\s*(.+?)(?=\n\n|\n##|\n$|$)/ms;
const suggMatch = data.match(SUGGESTION_REGEX);
if (suggMatch) {
  createSuggestion(name, suggMatch[1].trim());
}
```

`createSuggestion` is imported from `./suggestions.js`. Duplicate detection: if the same content string already exists for the same agent within the last 60 seconds, skip (prevents double-capture from overlapping chunks).

### 7.3 `dashboard/suggestions.js`

```js
createSuggestion(agentName, content) → void
listSuggestions()  → [{ id, agent_name, content, status, created_at }]  // excludes dismissed
updateSuggestion(id, { status }) → void
```

### 7.4 REST Routes (`dashboard/server.js`)

```
GET  /suggestions
→ [{ id, agent_name, content, status, created_at }]  (excludes dismissed)

PATCH /suggestions/:id
Body: { status: 'noted' | 'dismissed' }
→ { ok: true }
```

### 7.5 Dashboard UI

A **Suggestions** strip sits below `#panels` and above the footer (if it exists). Hidden when no `new` or `noted` suggestions exist. Each card:

```
┌─────────────────────────────────────────────────┐
│ flint-dev · 14:32          [Noted] [Dismiss]    │
│ If you add caching to getProject() the Projects │
│ tab would load faster under heavy use.          │
└─────────────────────────────────────────────────┘
```

- **Noted** → `PATCH /suggestions/:id { status: 'noted' }`. Card stays but greyed.
- **Dismiss** → `PATCH /suggestions/:id { status: 'dismissed' }`. Card removed from view.

Suggestions are fetched on dashboard load and refreshed every 30 seconds (same interval as costs).

### 7.6 WebSocket Push

When `createSuggestion` is called, the server broadcasts `{ type: 'suggestion', suggestion: { id, agent_name, content, status, created_at } }` over the existing WebSocket so new suggestions appear immediately without waiting for the poll interval.

---

## 8. CLI

New subcommand groups added to `bin/flint.js`:

```
node bin/flint.js suggestions list
  → table: id | agent | status | created_at | content (truncated to 80 chars)

node bin/flint.js suggestions dismiss <id>
  → marks dismissed, prints confirmation

node bin/flint.js worktree list
  → table: agent | branch | worktree_path | status

node bin/flint.js worktree merge <agent>
  → merges branch to master, removes worktree, prints confirmation

node bin/flint.js worktree discard <agent>
  → removes worktree and branch, prints confirmation
```

All calls go to `http://localhost:3000` (dashboard). Uses existing `dashGet/dashPost/dashPatch/dashDelete` helpers from SP4.

---

## 9. Testing

New tests in `dashboard/tests/sp5.test.js` using `node:test` + `node:assert/strict`:

**Suggestions:**
- `createSuggestion` inserts row
- `listSuggestions` excludes dismissed
- `updateSuggestion` changes status
- `GET /suggestions` returns only non-dismissed
- `PATCH /suggestions/:id` updates status

**Worktrees:**
- `listWorktrees` returns rows with non-null worktree_path
- `GET /worktrees` returns empty array when none active
- `POST /worktrees/:agent/merge` returns 404 for unknown agent
- `DELETE /worktrees/:agent` returns 404 for unknown agent

**CLI providers (router tests):**
- `complete('claude-cli', ...)` with `FLINT_TEST_MODE=1` returns stub response
- `complete('gemini-cli', ...)` with `FLINT_TEST_MODE=1` returns stub response
- `getModels()` includes `cli` group when router.json has cli providers

Worktree creation/merge/discard require real git operations — tested via integration tests that create a temporary git repo, not mocked. Suggestion detection from terminal output is tested by calling `createSuggestion` directly (same pattern as `injectProjectContext` tests in SP4).

Existing 43 dashboard tests must continue to pass. New total target: ~55 dashboard tests + 3 router tests.

---

## 10. What's Deliberately Excluded

| Excluded | Reason |
|---|---|
| Forgejo / local git server | No daily need; overkill for solo use |
| Streaming over WebSocket | Adds significant complexity; batch responses are fine |
| Provider retry/fallback | YAGNI; easy to add manually |
| Mammoth DAG pipelines | Large scope, not a current gap |
| Auto-applying suggestions | Suggestions are advisory; Robin decides |
| Cost charts/forecasting | Still no clear need |
| PR review workflow | Covered by manual merge flow |

---

## 11. Success Criteria

- [ ] `claude-cli` and `gemini-cli` work as router providers; `node bin/flint.js ask "hello" --provider claude-cli` returns a response (requires adding `--provider` flag to `cmdAsk` in `bin/flint.js`)
- [ ] Spawning with "Isolated branch" checked creates a `.worktrees/<agent>` directory and a new git branch
- [ ] After agent exits, Merge/Discard buttons appear in the dashboard panel header
- [ ] `POST /worktrees/:agent/merge` merges the branch to master and removes the worktree
- [ ] An agent emitting `## SUGGESTION: X` causes X to appear in the Suggestions strip within one poll cycle
- [ ] `flint suggestions list` shows current suggestions; `flint suggestions dismiss <id>` removes one
- [ ] `flint worktree list` shows active worktrees; `flint worktree merge <agent>` works from CLI
- [ ] All new tests pass; existing 43 dashboard tests unaffected

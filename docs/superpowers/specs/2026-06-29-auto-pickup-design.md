# Queue Auto-Pickup Design Spec

**Date:** 2026-06-29
**Author:** Flint

## Goal

When tasks sit in the queue with `status = 'pending'`, automatically assign them to the right agent and restart that agent if it is stopped — without any manual intervention.

---

## Decisions

| Question | Decision |
|---|---|
| Always on or toggle? | Always on — no toggle |
| How is an agent matched to a task role? | Exact match on a new `role` field on the agent |
| No matching agent running? | Restart the stopped agent if it exists in the registry |
| No matching agent at all? | Skip — task stays pending |
| Tasks with no role? | Assign to the agent named in a `default_agent` setting |
| `default_agent` not configured? | Roleless tasks are skipped |

---

## Data Model

### Agent: new `role` field

`agents.json` and the in-memory registry gain one field:

```json
{ "name": "my-tester", "role": "tester", "mode": "spawn", ... }
```

- Type: `string | null`
- Default: `null` (general-purpose agent, not matched to any role)
- Persisted to `agents.json` via the existing `save()` function

No DB migration needed — agents are file-persisted.

### New `settings` table

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Seeded with nothing. The `default_agent` key is written only when the user configures it via the API. Reads return `""` (empty string) when the key is absent.

---

## Components

### `dashboard/settings.js` (new)

```js
getSetting(key)        → string ('' if absent)
setSetting(key, value) → void
```

Thin wrapper over the `settings` table. Used by auto-pickup and the config API route.

### `dashboard/autoPickup.js` (new)

Single exported function:

```js
export function autoAssignPendingTasks()
```

Logic:
1. Query all `pending` tasks ordered by `priority DESC, id ASC`
2. For each task:
   - Determine target agent name:
     - `task.role` is set → find first agent in registry where `agent.role === task.role`
     - `task.role` is null → agent name = `getSetting('default_agent')`
   - If target name is empty or agent not in registry → skip (log once per agent name, not per task)
   - If agent is `running` → `assignQueueTask(id, agentName)` (appends task to task file)
   - If agent is `stopped` → `assignQueueTask(id, agentName)` then `spawnAgent(name, workdir, model)`
3. `spawnAgent` errors are caught and logged; task remains `pending` so the next poll can retry

**Idempotency:** `assignQueueTask` already guards against re-assigning in-progress or done tasks — no extra check needed.

**Polling:** `autoAssignPendingTasks` is called from `startQueuePoller` on the same 10-second interval as `checkQueueTasks`.

### `dashboard/queue.js` (modified)

`startQueuePoller` calls both `checkQueueTasks` and `autoAssignPendingTasks` on each tick:

```js
import { autoAssignPendingTasks } from './autoPickup.js';

export function startQueuePoller(intervalMs = 10000) {
  return setInterval(async () => {
    checkQueueTasks();
    await autoAssignPendingTasks();
  }, intervalMs);
}
```

### `dashboard/agents.js` (modified)

- `registerAgent(name, mode, workdir, logPath, model, runtime, role)` — adds `role` parameter
- `initAgents` — reads `role` from JSON on load
- `save()` — includes `role` in serialised output
- `listAgents()` — includes `role` in returned objects

### `dashboard/db.js` (modified)

Add `settings` table creation to `initDb()`:

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### `dashboard/server.js` (modified)

**New routes:**

```
GET  /queue/config   → { defaultAgent: getSetting('default_agent') }
PATCH /queue/config  → body { defaultAgent: string } → setSetting('default_agent', value)
```

**Updated agent creation** (`POST /agents` body and WebSocket `spawn` message):
- Accept optional `role` field
- Pass to `registerAgent()`

### `dashboard/public/app.js` (modified)

**New Agent modal** — add one input after the existing fields:

```
Role (optional): [text input]
placeholder: "e.g. tester, coder — leave blank for general"
```

Included in the `POST /agents` body as `role`.

**Queue view header** — add a config row:

```
Default agent: [text input]  [Save button]
```

On load: `GET /queue/config` → populate input.
On Save: `PATCH /queue/config` with `{ defaultAgent: value }`.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| `spawnAgent` throws (PTY unavailable, binary missing) | Catch, log to console, task stays `pending` |
| No agent matches role | Log once: `[auto-pickup] no agent with role "X"` — task stays `pending` |
| `default_agent` not set, roleless task | Silent skip — no log spam |
| Agent already `running` and assigned another task | `assignQueueTask` appends to task file — agent picks it up when it finishes current work |

---

## Testing

- Unit: `autoAssignPendingTasks` with a spy on `assignQueueTask` and `spawnAgent`
  - pending task with matching running agent → `assignQueueTask` called, `spawnAgent` not called
  - pending task with matching stopped agent → both called
  - pending task, no matching agent → neither called
  - pending task, no role, no default → neither called
  - pending task, no role, default configured → assigned to default agent
- Unit: `getSetting` / `setSetting` round-trip
- Route tests: `GET /queue/config` returns `{ defaultAgent: "" }` by default; `PATCH` persists
- Route tests: `POST /agents` with `role` → agent has role in `listAgents()`
- Integration: existing e2e.test.js queue tests unaffected (auto-pickup only fires from the poller, not from API calls in tests)

---

## Files Changed

| File | Change |
|---|---|
| `dashboard/settings.js` | **Create** — `getSetting`, `setSetting` |
| `dashboard/autoPickup.js` | **Create** — `autoAssignPendingTasks` |
| `dashboard/db.js` | **Modify** — add `settings` table to `initDb` |
| `dashboard/agents.js` | **Modify** — add `role` field throughout |
| `dashboard/queue.js` | **Modify** — import and call `autoAssignPendingTasks` in poller |
| `dashboard/server.js` | **Modify** — `/queue/config` routes, `role` in agent creation |
| `dashboard/public/app.js` | **Modify** — role field in New Agent modal, default agent config in Queue header |

---

## Out of Scope

- Auto-spawning brand-new agents (only restarts existing registered agents)
- Capacity limits (an agent can receive multiple tasks if the poller fires repeatedly)
- Per-role concurrency limits
- Audit log of auto-assignments

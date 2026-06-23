# Flint — Project Management Module: Design Spec
**Sub-project 4 of 5**
**Date:** 2026-06-23
**Status:** Approved

---

## 1. Problem

Sub-projects 1–3 give Flint running agents, live terminal panels, and a multi-provider LLM router — but there's no way to group work into projects, see what each project is spending, or let an agent pick up where it left off across sessions. Every session starts cold.

---

## 2. Scope

**In:** Project registry in SQLite, agent linking, per-project cost aggregation, session continuity (notes + auto-captured session summary injected on spawn), Projects tab in dashboard, CLI subcommands.

**Out (noted for later):**
- Router config editor in browser UI (explicitly deferred from SP3 — still deferred)
- Kanban/card drag-and-drop
- Project timelines or deadlines
- Team cost isolation / multi-user projects
- Automatic progress detection from agent output
- Cost charts and forecasting (may revisit in SP5)

---

## 3. Platform

- **OS:** Windows 11 (local machine)
- **Runtime:** Node.js 20+, ESM throughout
- **DB:** `usage.sqlite` at Flint root (shared with SP2/SP3)
- **Dashboard:** `http://localhost:3000` (existing, extended)
- **Root:** `C:\Users\Robin\Applications Dev\Flint\`

---

## 4. File Structure

```
(modified)
dashboard/
├── server.js          ← new /projects routes
├── db.js              ← schema migration for projects + project_agents tables
├── projects.js        ← NEW: project CRUD, agent linking, cost aggregation
├── terminal.js        ← on spawn: inject project context; on exit: capture summary
├── public/
│   ├── index.html     ← "Projects" tab button in header
│   └── app.js         ← Projects tab view, card grid, modals

bin/
└── flint.js           ← new `project` subcommand group
```

---

## 5. Data Model

### Schema (added to `usage.sqlite` via `dashboard/db.js`)

```sql
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active',
  notes        TEXT DEFAULT '',
  last_summary TEXT DEFAULT '',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_agents (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  agent_name TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_name)
);
```

**Status values:** `active` | `paused` | `done` | `archived`

Cost is never stored on the project — it is calculated at query time by joining `usage` on `agent_name` values from `project_agents`. This keeps cost data authoritative in one place.

---

## 6. `dashboard/projects.js`

One module, pure DB operations. All functions operate on the shared `_db` singleton from `db.js` via the existing `getDb()` pattern.

```js
// Returns all projects where status != 'archived', ordered by updated_at DESC
listProjects() → [{ id, name, status, notes, last_summary, agents: string[], costWeek: number, costMonth: number }]

// Returns one project by id (same shape as above)
getProject(id) → { id, name, status, notes, last_summary, agents: string[], costWeek, costMonth }

// Creates a project, returns new id
createProject({ name, notes? }) → number

// Updates name, status, and/or notes. Sets updated_at = CURRENT_TIMESTAMP.
updateProject(id, { name?, status?, notes?, last_summary? }) → void

// Links an agent name to a project (idempotent — INSERT OR IGNORE)
linkAgent(projectId, agentName) → void

// Removes an agent link
unlinkAgent(projectId, agentName) → void

// Returns the project linked to an agent name, or null
getProjectForAgent(agentName) → { id, name, notes, last_summary } | null
```

Cost calculation uses:
```sql
SELECT SUM(cost_usd) FROM usage
  WHERE agent_name IN (SELECT agent_name FROM project_agents WHERE project_id = ?)
  AND DATE(timestamp) >= ?
```

For `costWeek`: 7 days ago. For `costMonth`: start of current calendar month.

---

## 7. REST API

All routes added to `dashboard/server.js`. Request/response bodies are JSON.

```
GET  /projects
```
Returns `[{ id, name, status, notes, last_summary, agents, costWeek, costMonth }]`

```
POST /projects
Body: { name: string, notes?: string }
```
Returns `{ id, name, status, notes, last_summary, agents: [], costWeek: 0, costMonth: 0 }`
400 if name missing or duplicate.

```
PATCH /projects/:id
Body: { name?, status?, notes? }
```
Returns updated project object. 404 if not found.

```
DELETE /projects/:id
```
Sets `status = 'archived'`. Returns `{ ok: true }`. 404 if not found.

```
POST /projects/:id/agents
Body: { agentName: string }
```
Links agent to project. 404 if project not found.

```
DELETE /projects/:id/agents/:agentName
```
Unlinks agent. 404 if project not found.

---

## 8. Session Continuity

### On agent spawn (`dashboard/terminal.js`)

After the PTY is created, before the agent starts typing, check if the spawned agent is linked to a project:

```js
const project = getProjectForAgent(name);
if (project) {
  const header = [
    `## Project: ${project.name}`,
    `### Notes\n${project.notes || '(none)'}`,
    project.last_summary ? `### Last session\n${project.last_summary}` : '',
    '---',
    '',
  ].filter(Boolean).join('\n');

  const existing = readTasks(name);
  writeTasks(name, header + '\n' + existing);
}
```

This prepends the project context block to the top of `tasks/<agent>.md` each time the agent spawns. The agent reads its task file naturally and picks up the context.

### On session end (`dashboard/terminal.js`)

When the PTY `exit` event fires, capture the last 50 lines of terminal output and store as `last_summary` on the linked project:

```js
ptyProcess.onExit(() => {
  const project = getProjectForAgent(name);
  if (project && outputBuffer.length > 0) {
    const summary = outputBuffer.slice(-50).join('');
    updateProject(project.id, { last_summary: summary });
  }
});
```

`outputBuffer` is a rolling array of output chunks (capped at 50 lines) maintained per PTY session in `spawnAgent`.

---

## 9. Dashboard UI

### Header

Add a `Projects` button to the header bar, alongside the existing cost display:

```html
<button id="btn-projects">Projects</button>
```

Clicking it toggles between the **agents view** (existing panel grid) and the **projects view** (new card grid). The toggle state is in-memory only — page refresh returns to agents view.

### Projects View

A CSS grid of project cards (same 2-col / 1-col breakpoint as agent panels). Each card:

```
┌─────────────────────────────────┐
│ My Project             [active] │
│ Agents: research, code          │
│ This week: $0.42  Month: $3.10  │
│ Notes: Working on Q3 brief...   │
│                        [Edit]   │
└─────────────────────────────────┘
```

Status badge colours: `active` → green, `paused` → yellow, `done` → blue, `archived` → grey.

**"New Project" button** → modal with name input + notes textarea → `POST /projects`.

**"Edit" button** → detail modal with:
- Name (editable input)
- Status dropdown (active / paused / done / archived)
- Notes (textarea, saves on blur via `PATCH /projects/:id`)
- Last session summary (read-only `<pre>` block, grey background)
- Linked agents list with [×] unlink buttons
- "Link agent" dropdown (populated from `GET /agents`) + "Link" button

No drag-and-drop, no inline editing on the card itself — everything goes through the modal.

---

## 10. CLI

New `project` subcommand group added to `bin/flint.js`. All calls go to `http://localhost:3000` (dashboard API).

```
node bin/flint.js project list
  → table: id | name | status | agents | cost week | cost month

node bin/flint.js project create "My Project"
  → creates project, prints id + name

node bin/flint.js project create "My Project" --notes "Initial notes"
  → creates with notes

node bin/flint.js project status <id> active|paused|done|archived
  → updates status, prints confirmation

node bin/flint.js project notes <id> "Running notes text"
  → overwrites notes field, prints confirmation

node bin/flint.js project link <id> <agent-name>
  → links agent to project, prints confirmation

node bin/flint.js project unlink <id> <agent-name>
  → unlinks agent, prints confirmation
```

Errors exit 1 with a message. No external deps — uses native `fetch`.

---

## 11. Testing

New tests in `dashboard/tests/projects.test.js` using `node:test` + `node:assert/strict`:
- `createProject` returns correct shape
- `listProjects` includes cost fields (0 when no usage rows)
- `updateProject` updates name, status, notes
- `linkAgent` / `unlinkAgent` modify `project_agents` rows
- `getProjectForAgent` returns correct project or null
- Archive via DELETE sets status to `archived` and excludes from default list

Session continuity (context injection + summary capture) tested via `dashboard/tests/server.test.js` integration tests that simulate a spawn message with a linked project and verify task file content.

Existing 20 dashboard tests must continue to pass. New total target: ~30 dashboard tests.

---

## 12. What's Deliberately Excluded

| Excluded | Reason | When |
|---|---|---|
| Router config UI | Deferred from SP3, still not needed | Never unless asked |
| Kanban drag-and-drop | Heavy JS, YAGNI | Future |
| Cost charts / forecasting | Adds complexity without clear need | SP5 or never |
| Project deadlines / timelines | Not requested | Future |
| Team / multi-user isolation | Robin is solo | Future |
| Auto progress detection | Hard, imprecise | Future |

---

## 13. Success Criteria

- [ ] `GET /projects` returns project list with agent names and cost totals
- [ ] `POST /projects` creates a project; `PATCH /projects/:id` updates it
- [ ] `POST /projects/:id/agents` links an agent; cost aggregates from linked agents
- [ ] Spawning an agent linked to a project prepends project context to its task file
- [ ] When a PTY session ends, last 50 lines stored as `last_summary` on the linked project
- [ ] Dashboard "Projects" tab shows card grid; cards show name, status, agents, cost, notes snippet
- [ ] Edit modal lets you update notes, status, linked agents
- [ ] `node bin/flint.js project list` shows all projects with cost
- [ ] `node bin/flint.js project link <id> <agent>` links agent to project
- [ ] All new tests pass; existing 20 dashboard tests unaffected

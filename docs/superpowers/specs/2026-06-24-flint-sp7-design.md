# Flint SP7: Task Queue, MCP Management & Orchestrator

## Overview

Three interconnected features that evolve Flint from a multi-agent dashboard into a full agent orchestration platform:

1. **SP7a — MCP Server Management:** Store, inject, and manage MCP servers globally and per-agent.
2. **SP7b — Task Queue:** A global cross-agent task queue that feeds work to agents and tracks progress.
3. **SP7c — Flint Orchestrator:** A special agent spawn mode where Flint breaks a goal into subtasks, spawns typed worker agents, and coordinates them to completion.

Build order: SP7a → SP7b → SP7c. Each is independently shippable.

---

## Global Constraints

- Runtime: Node.js 20+, SQLite via `better-sqlite3`, existing Express + WebSocket server
- All new SQLite tables use `ALTER TABLE … ADD COLUMN` guards for schema migrations (existing pattern)
- No new npm dependencies unless unavoidable
- All REST routes follow existing patterns: JSON body, JSON response, error `{ error: "..." }`
- All CLI subcommands follow existing pattern in `bin/flint.js` using `dashGet/dashPost/dashDelete`
- Dashboard UI: same dark theme, existing CSS variables, no new CSS frameworks
- No backwards-incompatible changes to existing agent, project, workspace, or suggestion APIs
- MCP injection applies to Claude Code agents only for SP7a; Vibe MCP format is a stub (skip write, no error)
- HTTP-via-curl is the orchestrator's mechanism for calling back into Flint; Flint MCP server is a future iteration

---

## SP7a: MCP Server Management

### Goal

Allow Robin to register MCP servers in Flint once, then have them automatically injected into agent working directories at spawn time — so agents have access to filesystem, git, database, email, and other tools without any manual config.

### Architecture

```
Dashboard UI / CLI
       ↓ REST
dashboard/server.js  →  dashboard/mcp.js  →  dashboard/db.js
                                                  ↓ (at spawn time)
                              dashboard/terminal.js
                                  reads global + agent-scoped rows
                                  merges into <workdir>/.claude/settings.json
                                  PTY starts
```

### Data Model

New table in `dashboard/db.js`:

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  command    TEXT NOT NULL,
  args       TEXT NOT NULL DEFAULT '[]',
  env        TEXT NOT NULL DEFAULT '{}',
  scope      TEXT NOT NULL DEFAULT 'global',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- `args`: JSON array of strings, e.g. `["-y","@modelcontextprotocol/server-filesystem","/home"]`
- `env`: JSON object of extra environment variables for this server process
- `scope`: `'global'` applies to every agent; any other string is an agent name for agent-specific servers

### New File: `dashboard/mcp.js`

Exports:

```js
listMcpServers(scope = null)   // null = all; 'global' = global only; agent name = that agent's
addMcpServer({ name, command, args, env, scope, enabled })  // returns inserted id
updateMcpServer(id, fields)    // enable/disable/rename
removeMcpServer(id)
getMcpConfigForAgent(agentName)
  // returns { mcpServers: { name: { command, args, env }, ... } }
  // combines global enabled rows + rows where scope === agentName
injectMcpConfig(agentName, workdir)
  // reads getMcpConfigForAgent(agentName)
  // reads existing <workdir>/.claude/settings.json (if any), parses it
  // merges: existing server entries win on name conflicts
  // writes merged JSON back to <workdir>/.claude/settings.json
  // no-op if no MCP servers configured
  // no-op (silent) for Vibe agents (format unknown)
```

`.claude/settings.json` format written:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": {}
    }
  }
}
```

### Integration with `terminal.js`

In `spawnAgent()`, before `pty.spawn()` is called:

```js
import { injectMcpConfig } from './mcp.js';
// ...
if (!isVibe) injectMcpConfig(name, workdir);
```

### REST Routes (in `dashboard/server.js`)

```
GET    /mcp/servers              → listMcpServers()
POST   /mcp/servers              body: { name, command, args, env, scope }  → addMcpServer(...)
PATCH  /mcp/servers/:id          body: { enabled?, name?, scope? }          → updateMcpServer(id, fields)
DELETE /mcp/servers/:id          → removeMcpServer(id)
```

### Dashboard UI

Toolbar button: **`⚡ MCP`** opens a management modal.

Modal layout:
- Header: "MCP Servers"
- Server list table: columns Name | Command | Scope | Enabled toggle | Delete button
- Empty state: "No MCP servers configured yet."
- Add form (below list):
  - Name input (e.g. `filesystem`)
  - Command input (e.g. `npx`)
  - Args input — space-separated string, split on save (e.g. `-y @modelcontextprotocol/server-filesystem /projects`)
  - Env input — textarea, one `KEY=VALUE` per line, parsed on save
  - Scope select: "Global (all agents)" or pick from registered agent names
  - Add button

Enabled toggle calls `PATCH /mcp/servers/:id { enabled: 0|1 }` immediately.

### CLI (`bin/flint.js`)

New `cmdMcp` function registered as `mcp`:

```
flint mcp list
flint mcp add <name> <command> [args...]
               [--env KEY=VAL]     (repeatable)
               [--scope global|<agent-name>]
               [--disabled]
flint mcp remove <name>
flint mcp enable <name>
flint mcp disable <name>
```

`list` output format: `[id] name | command args | scope | enabled/disabled`

`add` resolves name to id for enable/disable/remove via `GET /mcp/servers` + filter by name.

### Files

| File | Change |
|------|--------|
| `dashboard/db.js` | Add `mcp_servers` table + migration guard |
| `dashboard/mcp.js` | **New** — all CRUD + `injectMcpConfig` |
| `dashboard/terminal.js` | Call `injectMcpConfig` before PTY spawn |
| `dashboard/server.js` | Add `GET/POST/PATCH/DELETE /mcp/servers` routes, import `mcp.js` |
| `dashboard/public/index.html` | Add MCP modal + toolbar button |
| `dashboard/public/app.js` | MCP modal open/close, CRUD wiring, enabled toggles |
| `dashboard/public/style.css` | MCP modal styles (reuse existing `.modal-box` patterns) |
| `bin/flint.js` | Add `cmdMcp`, register as `mcp` |

---

## SP7b: Task Queue

### Goal

A global cross-agent task queue that any human or the orchestrator can add tasks to. Tasks can be unassigned (waiting) or assigned to a specific agent. Assignment appends the task to the agent's existing task file. The dashboard Queue tab shows all tasks with status, assigned agent, and role.

### Architecture

```
Human / Orchestrator
       ↓ REST POST /queue/tasks
dashboard/server.js → dashboard/queue.js → dashboard/db.js
                                              ↓ (on assign)
                                     dashboard/tasks.js  (appendTask)
                                              ↓
                                     WS broadcast → agent panel task sidebar
                              Background poll (10s):
                                     reads tasks/<agent>.md
                                     if "- [x] <title>" found → mark done
```

### Data Model

New table in `dashboard/db.js`:

```sql
CREATE TABLE IF NOT EXISTS task_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id  INTEGER REFERENCES projects(id),
  assigned_to TEXT,
  role        TEXT,
  priority    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',
  result      TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT 'human',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- `assigned_to`: agent name or `NULL` (unassigned)
- `role`: `researcher` | `planner` | `builder` | `tester` | `NULL`
- `status`: `pending` | `in_progress` | `done` | `cancelled`
- `created_by`: `'human'` or orchestrator agent name

### New File: `dashboard/queue.js`

Exports:

```js
listQueueTasks({ status, assigned_to, project_id, role } = {})
getQueueTask(id)
createQueueTask({ title, description, project_id, assigned_to, role, priority, created_by })
  // if assigned_to is set: calls appendTask(assigned_to, formatted) and sets status = 'in_progress'
  // broadcasts { type: 'queue_task_added', task } globally
  // returns inserted task object
assignQueueTask(id, agentName)
  // sets assigned_to, status = 'in_progress'
  // calls appendTask(agentName, formatted)
  // broadcasts { type: 'queue_task_assigned', task }
updateQueueTask(id, fields)    // for result, priority changes
completeQueueTask(id, result)  // status = 'done', sets result
cancelQueueTask(id)            // status = 'cancelled'

startQueuePoller(intervalMs = 10000)
  // setInterval: for each in_progress task with assigned_to set:
  //   read tasks/<agent>.md as a string
  //   search for a line that matches /^- \[x\] <title>/i  (title trimmed, regex-escaped)
  //   if found: completeQueueTask(id, result='') and broadcast queue_task_done
```

Task formatted for agent task file injection:

```
- [ ] <title>

  <description>

  _Queue task #<id> | Role: <role>_
```

### REST Routes

```
GET    /queue/tasks              ?status=&assigned_to=&role=  → listQueueTasks(filters)
GET    /queue/tasks/:id          → getQueueTask(id)
POST   /queue/tasks              body: { title, description?, project_id?, assigned_to?,
                                         role?, priority?, created_by? }
                                 → createQueueTask(...)
PATCH  /queue/tasks/:id          body: { assigned_to?, priority?, result?, status? }
DELETE /queue/tasks/:id          → cancelQueueTask(id)   (soft delete — sets cancelled)
```

`PATCH` handles:
- `assigned_to` set → calls `assignQueueTask`
- `status = 'done'` → calls `completeQueueTask`
- `status = 'cancelled'` → calls `cancelQueueTask`
- Other fields → calls `updateQueueTask`

### Dashboard UI

New **Queue** tab button in the toolbar (between "+ New Agent" and "↻ Refresh"). Clicking it shows the Queue view (hides `#panels`, shows `#queue-view`).

Queue view layout:
- Header row: "Task Queue" heading + "+ Add Task" button
- Filter bar: status pills (All | Pending | In Progress | Done), agent dropdown filter
- Task table:
  - Status badge (pending=amber, in_progress=blue, done=green, cancelled=grey)
  - Title (clickable — expands description + result inline)
  - Role tag (researcher/planner/builder/tester — colour-coded chips)
  - Assigned agent (or "unassigned" in amber)
  - Priority number
  - Created time (relative)
  - Action buttons: Assign (if unassigned), Cancel (if pending/in_progress)
- Unassigned tasks have a subtle amber left-border glow

Add Task modal fields:
- Title (required)
- Description (textarea, optional)
- Assign to (agent select, optional — "Leave unassigned")
- Role (select: none / researcher / planner / builder / tester)
- Priority (number, default 0)
- Project (optional)

WebSocket messages:
- `queue_task_added` → insert new row at top of table (pending)
- `queue_task_assigned` → update row assigned agent
- `queue_task_done` → update row status badge, strike through title

### CLI

New `cmdQueue` function registered as `queue`:

```
flint queue list [--status pending|in_progress|done] [--agent <name>]
flint queue add "title" [--desc "..."] [--agent <name>] [--role researcher|planner|builder|tester] [--priority 1]
flint queue assign <id> <agent>
flint queue done <id> [--result "summary text"]
flint queue cancel <id>
```

`list` output: `[id] [status] title | agent | role`

### Files

| File | Change |
|------|--------|
| `dashboard/db.js` | Add `task_queue` table |
| `dashboard/queue.js` | **New** — all CRUD + task injection + poller |
| `dashboard/server.js` | Add queue REST routes; start poller on boot |
| `dashboard/public/index.html` | Add queue view div, queue tab button, add-task modal |
| `dashboard/public/app.js` | Queue tab toggle, task table render, WS handlers, add-task form |
| `dashboard/public/style.css` | Queue view, task table, role chips, status badges |
| `bin/flint.js` | Add `cmdQueue`, register as `queue` |

---

## SP7c: Flint Orchestrator

### Goal

Spawn a Claude Code agent in "Orchestrator" mode. It receives the goal and a guide to Flint's REST API, then autonomously plans, spawns typed worker agents, assigns them tasks from the queue, monitors progress via the shared scratchpad, and synthesises a final result. Workers are regular agents — the orchestrator is simply the agent that creates them.

### Architecture

```
Human → POST /orchestrations  (goal, workdir, project_id?)
              ↓
         dashboard/orchestrator.js
              ↓ creates orchestrations row
              ↓ creates scratchpad file at tasks/orch-<id>/scratchpad.md
              ↓ writes injected task file to tasks/<agent-name>.md
              ↓ calls registerAgent + spawnAgent
              ↓ broadcasts { type: 'orchestration_started', ... }

Orchestrator agent (Claude Code in terminal):
  reads its task file
  reasons about goal
  calls curl → POST /queue/tasks    (create tasks for workers)
  calls curl → POST /agents/spawn   (spawn worker agents)
  reads/writes tasks/orch-<id>/scratchpad.md via bash
  calls curl → PATCH /queue/tasks/:id  (mark done)
  calls curl → POST /orchestrations/:id/scratchpad  (append synthesis)

Worker agents:
  spawned by orchestrator with their role as their name prefix (e.g. "researcher-1")
  receive injected context: their role, scratchpad path, task queue API
  append findings to scratchpad.md
  mark their assigned tasks done (→ queue poller picks it up)
```

### Data Model

New table in `dashboard/db.js`:

```sql
CREATE TABLE IF NOT EXISTS orchestrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  goal       TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  status     TEXT NOT NULL DEFAULT 'running',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### New File: `dashboard/orchestrator.js`

Exports:

```js
createOrchestration({ goal, agentName, workdir, model, projectId })
  // inserts orchestrations row → gets id
  // mkdirSync tasks/orch-<id>/ if not exists
  // writes tasks/orch-<id>/scratchpad.md with header:
  //   "# Orchestration: <goal>\n\nStarted: <timestamp>\n\n## Plan\n\n## Findings\n\n## Synthesis\n"
  // writes orchestrator task file (see below)
  // calls registerAgent(agentName, 'spawn', workdir, null, model, 'claude')
  // calls spawnAgent(agentName, workdir, model, { onWorktreePending: ... })
  // returns { id, agentName, scratchpadPath }

getOrchestration(id)
listOrchestrations()
updateOrchestrationStatus(id, status)

buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath })
  // returns the markdown string injected into tasks/<agentName>.md

buildWorkerTaskFile({ role, title, description, orchId, scratchpadPath })
  // returns injected context for worker agents (called from queue.js on assign
  //   when the task has an orch run attached — via created_by field)
```

### Orchestrator Task File (injected into `tasks/<agentName>.md`)

```markdown
## Orchestration Goal
<goal>

## Your Role — Orchestrator
You are the Flint Orchestrator. Your job:
1. Read the goal above and think through what needs to happen.
2. Write your plan to the shared scratchpad.
3. Create queue tasks and spawn typed worker agents to execute each part.
4. Monitor progress by checking the task queue and scratchpad.
5. When all tasks are done, synthesise the results in the scratchpad.

## Shared Scratchpad
Path: <scratchpadPath>
Write your plan there first. Workers will append findings under ## Findings.
Read it to track progress. Write your final synthesis under ## Synthesis.

## Flint REST API
Base URL: http://localhost:3000

### Create a task and assign it to a worker
curl -s -X POST http://localhost:3000/queue/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"<title>","description":"<desc>","assigned_to":"<agent-name>","role":"researcher","created_by":"<your-name>"}'

### Spawn a worker agent
curl -s -X POST http://localhost:3000/agents/spawn \
  -H "Content-Type: application/json" \
  -d '{"name":"<agent-name>","workdir":"<workdir>","runtime":"claude"}'

### Check task queue progress
curl -s "http://localhost:3000/queue/tasks?created_by=<your-name>"

### Mark a task done with result
curl -s -X PATCH http://localhost:3000/queue/tasks/<id> \
  -H "Content-Type: application/json" \
  -d '{"status":"done","result":"<summary>"}'

## Worker Roles
- researcher: investigates, reads docs, surveys prior art
- planner: designs architecture, data models, API contracts
- builder: writes code and commits it
- tester: writes tests, runs them, reports results

## Suggested Flow
1. Write plan to scratchpad.
2. Spawn a researcher, assign it a research task.
3. When research is done (poll queue), spawn planner + builder.
4. When builder finishes, spawn tester.
5. Read all findings from scratchpad, write synthesis.
```

### Worker Context Injection

When `assignQueueTask` is called for a task whose `created_by` field matches an orchestrator agent name, `queue.js` queries the `orchestrations` table directly via `getDb()` (no import from `orchestrator.js`) to look up the scratchpad path, then prepends this block to the agent's task file **before** the `- [ ] <title>` line:

```markdown
## Context — Orchestration Worker
Role: <role>
Shared scratchpad: tasks/orch-<id>/scratchpad.md
Read the scratchpad for context. Append your findings under ## Findings.
When done, your task will be marked complete automatically.

---
```

Detection query: `SELECT id FROM orchestrations WHERE agent_name = ? AND status = 'running'` using `task.created_by` as the parameter. If no match, skip the prefix (task is human-created).

### REST Routes

```
GET  /orchestrations              → listOrchestrations()
GET  /orchestrations/:id          → getOrchestration(id)
POST /orchestrations              body: { goal, workdir, model?, project_id? }
                                  → createOrchestration(...)  (auto-generates agentName = "orch-<id>")
GET  /orchestrations/:id/scratchpad   → read tasks/orch-<id>/scratchpad.md
POST /orchestrations/:id/scratchpad   body: { content }  → append to scratchpad
```

WS message sent to all clients on orchestration start:
```json
{ "type": "orchestration_started", "id": 1, "agentName": "orch-1", "goal": "..." }
```

### Dashboard UI

Toolbar button: **`⬡ Orchestrate`** (after "+ New Agent").

Orchestrate modal:
- Goal (textarea, required, placeholder "Build a REST API with JWT auth and a React frontend")
- Working Directory (pre-filled from `/config`)
- Workspace dropdown (same as agent spawn modal)
- Project (optional, dropdown from `/projects`)
- Model (optional)
- Spawn Orchestrator button

Orchestrator agent panel:
- Same panel structure as a regular agent panel
- Panel name badge: purple `orch` chip next to the name (similar to `vibe` badge)
- Workers spawned by the orchestrator appear as regular panels with a smaller `worker` badge

Scratchpad viewer:
- `app.js` maintains an `orchAgents` map: `{ agentName → orchId }`, populated when a `orchestration_started` WS message arrives
- In the orchestrator's panel task sidebar, below the task list: a "Scratchpad" collapsible section
- Polls `GET /orchestrations/<orchAgents[agentName]>/scratchpad` every 15s (only if panel is visible)
- Renders as preformatted markdown inside a `<pre>` element

### CLI

New `cmdOrchestrate` function registered as `orchestrate`:

```
flint orchestrate "goal" [--workdir <path>] [--project <name>] [--model <model>]
flint orchestrate list
flint orchestrate status <id>
flint orchestrate scratchpad <id>
```

`orchestrate "goal"` prints the orchestration id and agent name, then exits (agent runs in background via Flint server).

### Files

| File | Change |
|------|--------|
| `dashboard/db.js` | Add `orchestrations` table |
| `dashboard/orchestrator.js` | **New** — createOrchestration, context builders, scratchpad I/O |
| `dashboard/queue.js` | Detect orchestration tasks on assign; inject worker context |
| `dashboard/server.js` | Add orchestration REST routes; import `orchestrator.js` |
| `dashboard/public/index.html` | Add Orchestrate toolbar button, modal, scratchpad section |
| `dashboard/public/app.js` | Orchestrate modal, `orchestration_started` WS handler, scratchpad poll |
| `dashboard/public/style.css` | `badge-orch`, `badge-worker`, scratchpad section styles |
| `bin/flint.js` | Add `cmdOrchestrate`, register as `orchestrate` |

---

## Implementation Order

**SP7a (MCP):** `db.js` → `mcp.js` → `terminal.js` → `server.js` → UI → CLI
**SP7b (Queue):** `db.js` → `queue.js` → `server.js` → UI → CLI → poller
**SP7c (Orchestrator):** `db.js` → `orchestrator.js` → `queue.js` update → `server.js` → UI → CLI

Each can be code-reviewed and merged independently. SP7c has a runtime dependency on SP7b being deployed first (worker task injection uses `appendTask` from queue.js).

## Future: Flint MCP Server

In a follow-on iteration, Flint exposes its own stdio MCP server (`dashboard/flint-mcp-server.js`) with tools:

- `spawn_agent({ name, workdir, role, runtime })`
- `create_task({ title, description, assigned_to, role })`
- `get_tasks({ created_by })`
- `read_scratchpad({ orch_id })`
- `write_scratchpad({ orch_id, content })`

This server is registered as a global MCP server via the SP7a system, so all agents automatically get it. The orchestrator can then call these as native MCP tool calls instead of curl. The REST API remains unchanged; the MCP server is a wrapper.

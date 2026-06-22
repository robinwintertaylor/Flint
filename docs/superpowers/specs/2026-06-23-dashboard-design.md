# Flint — Mission Control Dashboard: Design Spec
**Sub-project 2 of 5**
**Date:** 2026-06-23
**Status:** Approved

---

## 1. Problem

Sub-project 1 (Agentic OS Brain) gives Flint persistent identity and memory, but there's no way to see what agents are doing, manage their tasks, or track costs. With 4+ agents running simultaneously on Windows, you need a live view of every agent's terminal output and a per-agent task queue — all in a local browser tab.

---

## 2. Scope

**In:** Express server, node-pty agent management (spawn/attach/observe), WebSocket streaming, xterm.js terminal panels, per-agent markdown task queue, SQLite usage tracking, cost display header.

**Out (noted for later):**
- Electron desktop app (revisit when remote/offline access is needed)
- PR management (Forgejo integration — Sub-project 5)
- Drag-and-drop screenshots into agents
- LLM query panel (general-purpose chat alongside code agents)
- Self-building capability (dashboard instructs agent to add features to itself)
- Remote/LAN access (local only for now)
- Cost charts, forecasting, budget alerts (Sub-project 4)
- Team cost isolation (Sub-project 4)

---

## 3. Platform

- **OS:** Windows 11 (local machine)
- **Runtime:** Node.js 20+
- **URL:** `http://localhost:3000`
- **Root:** `C:\Users\Robin\Applications Dev\Flint\dashboard\`
- **Shared:** `usage.sqlite` at Flint root, `tasks/` at Flint root

---

## 4. File Structure

```
dashboard/
├── server.js          ← Express + WebSocket server, main entry point
├── package.json       ← deps: express, ws, node-pty, better-sqlite3
├── agents.js          ← agent registry: spawn, attach, kill, list
├── terminal.js        ← node-pty wrapper: create PTY, pipe I/O
├── tasks.js           ← task queue: read/write markdown files in tasks/
├── db.js              ← SQLite: usage + agents tables
├── public/
│   ├── index.html     ← dashboard page (no build step)
│   ├── app.js         ← WebSocket client + xterm.js init
│   └── style.css      ← minimal grid layout
└── scripts/
    └── attach.ps1     ← PowerShell wrapper: starts claude, pipes to log file

(at Flint root)
tasks/                 ← one .md file per agent
logs/                  ← log files for observe mode
usage.sqlite           ← shared with Sub-project 4
agents.json            ← persisted agent registry (survives dashboard restart)
```

---

## 5. Data Flow

```
Browser (xterm.js panel)
  ↕ WebSocket ws://localhost:3000/ws
Express server (server.js)
  ↕ node-pty (Windows ConPTY)
  claude.exe process (one PTY per spawned agent)
  ↓ output also scanned for cost
SQLite (usage.sqlite) ← cost rows written per response
tasks/*.md            ← read/written by both dashboard and agents
```

---

## 6. Agent Management

### Three modes

**Spawn** (dashboard owns the process)
- `POST /agents/spawn` `{name, workdir}` → node-pty creates ConPTY, runs `claude --dangerously-skip-permissions` in `workdir`
- Full bidirectional: xterm.js input → WebSocket → PTY stdin; PTY stdout → WebSocket → xterm.js
- `DELETE /agents/:name` → PTY.kill(), status set to `stopped`

**Attach** (user-started process, dashboard connects)
- `POST /agents/attach` `{name, pid}` → server attaches node-pty to Windows process by PID
- Bidirectional where ConPTY attach succeeds; falls back to observe-only if it fails

**Observe** (log file tail — read-only, always works)
- User runs `scripts/attach.ps1 research` → starts claude, pipes stdout to `logs/research.log`
- `POST /agents/observe` `{name, logPath}` → `fs.watch` on log file, streams new lines to browser
- Read-only panel (no stdin input)

### Agent registry (`agents.js`)
In-memory map: `{name, mode, status, workdir, ptyProcess, logPath, wsClients[]}`
Persisted to `agents.json` at Flint root on every state change — dashboard restart reconnects to known agents.

### Agent status
`running` | `idle` | `stopped` | `error`

---

## 7. WebSocket Protocol

Single WebSocket connection per browser tab at `ws://localhost:3000/ws`.

**Messages (client → server):**
```json
{ "type": "subscribe", "agent": "research" }
{ "type": "input",     "agent": "research", "data": "hello\n" }
{ "type": "spawn",     "agent": "research", "workdir": "C:/..." }
{ "type": "kill",      "agent": "research" }
{ "type": "tasks_get", "agent": "research" }
{ "type": "tasks_set", "agent": "research", "content": "..." }
```

**Messages (server → client):**
```json
{ "type": "output",  "agent": "research", "data": "..." }
{ "type": "status",  "agent": "research", "status": "running" }
{ "type": "tasks",   "agent": "research", "content": "..." }
{ "type": "cost",    "agent": "research", "today": 0.23, "month": 4.80 }
{ "type": "agents",  "list": [...] }
```

---

## 8. Task Queue

**Location:** `C:\Users\Robin\Applications Dev\Flint\tasks\<agent-name>.md`

**Format:**
```markdown
# Tasks — research

- [ ] Q3 market research brief
- [ ] Summarise competitor analysis
- [x] Read brand_context/ files
```

**API:**
- `GET /tasks/:agent` → read file, return `{content: "..."}` 
- `PATCH /tasks/:agent` `{content}` → overwrite file
- `POST /tasks/:agent` `{task}` → append `- [ ] {task}` to file

**UI:** sidebar beside each xterm panel. Checkbox list — click toggles done/undone via `PATCH`. "Add task" input at bottom. Auto-refreshes every 5 seconds.

**Why markdown not SQLite:** agents can read and update their own task file directly. Consistent with Sub-project 1 brain layer. No schema needed.

---

## 9. Usage Tracking

**Database:** `C:\Users\Robin\Applications Dev\Flint\usage.sqlite`

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS usage (
  id         INTEGER PRIMARY KEY,
  agent_name TEXT NOT NULL,
  tokens_in  INTEGER,
  tokens_out INTEGER,
  model      TEXT,
  cost_usd   REAL,
  timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agents_log (
  name      TEXT PRIMARY KEY,
  mode      TEXT,
  workdir   TEXT,
  status    TEXT,
  last_seen DATETIME
);
```

**Cost capture:** server scans each PTY output chunk with regex for Claude Code's cost line:
```
/Total cost:\s+\$?([\d.]+)/i
```
On match: insert row to `usage` table with agent name, model (from PTY output context), cost.

**Header bar** (always visible):
```
Flint │ 4 agents running │ Today: $1.42 │ Month: $28.60
```

**Per-agent panel header:** `research  ● running  $0.23 today`

---

## 10. Frontend

Plain HTML/CSS/JS — no build step, no framework, no bundler.

**`public/index.html`:** loads xterm.js from CDN, loads `app.js` and `style.css`.

**`public/app.js`:**
- Opens WebSocket to `ws://localhost:3000/ws`
- On connect: sends `{type: "agents"}` to get agent list → renders panels
- Per panel: creates `xterm.Terminal`, attaches to `<div>` in panel
- Handles all message types: routes `output` to correct terminal, `tasks` to sidebar, `cost` to header
- "New Agent" button → modal form (name + workdir) → sends `{type: "spawn"}`
- "Kill" button → sends `{type: "kill"}`

**`public/style.css`:**
- CSS grid: 2 columns at ≥1080px, 1 column below
- Each panel: fixed-height terminal area (400px) + scrollable task sidebar (200px)
- Dark theme (matches terminal aesthetic)
- Header bar: sticky top, flex row

---

## 11. npm Start

```json
{
  "scripts": {
    "start": "node server.js",
    "dev":   "node --watch server.js"
  }
}
```

Start: `cd dashboard && npm start` → open `http://localhost:3000`

---

## 12. What's Deliberately Excluded

| Excluded | Reason | When |
|---|---|---|
| Electron | Heavy, complex build | Revisit if remote/offline needed |
| React/Vue/build step | YAGNI — plain JS works | Never unless complexity demands |
| PR management | Needs Forgejo | Sub-project 5 |
| Drag-drop screenshots | Nice-to-have | Future |
| LLM query panel | Nice-to-have | Future |
| Self-building | Nice-to-have | Future |
| Cost charts/forecasting | Sub-project 4 | Phase 4 |
| Budget alerts | Sub-project 4 | Phase 4 |

---

## 13. Success Criteria

- [ ] `npm start` in `dashboard/` serves `http://localhost:3000`
- [ ] "New Agent" spawns a claude.exe process and streams its output to an xterm.js panel in real-time
- [ ] Keyboard input in the browser panel reaches the claude process
- [ ] 4 agent panels visible simultaneously, each independent
- [ ] Task sidebar shows tasks from `tasks/<agent>.md`, checkbox toggles update the file
- [ ] Adding a task from the browser appends to the markdown file
- [ ] Cost line parsed from PTY output and stored in SQLite
- [ ] Header bar shows live agent count + today's cost + month cost
- [ ] `scripts/attach.ps1 myagent` starts claude and pipes to `logs/myagent.log`
- [ ] `POST /agents/observe` attaches to that log file and streams to browser panel
- [ ] Dashboard restart reconnects to agents listed in `agents.json`

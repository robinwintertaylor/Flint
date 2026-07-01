![Flint — Your Friendly AI Agent OS](images/Flint%20Banner-Splash-Hero%20page%201.jpg)

# Flint — Personal AI Agent OS

Flint is a personal agentic operating system for running multiple Claude Code agents simultaneously. It provides a live browser dashboard, a multi-provider LLM router, a task queue with automatic role-based assignment, an orchestrator for multi-agent workflows, project management, cost tracking, Forgejo PR review, Telegram notifications, and local LLM support (Ollama, LM Studio) — all running on your Windows machine.

---

## What's Inside

| Component | Port | What it does |
|-----------|------|-------------|
| **Dashboard** | 3000 | Live agent terminals, task queue, orchestrator, projects, specialists, skills, MCP, API keys, costs |
| **Model Router** | 3001 | Multi-provider LLM gateway — routes by task type across Anthropic, OpenAI, Google, Azure, OpenRouter, Ollama, LM Studio |
| **Forgejo** | 3030 | Self-hosted Git — agents push branches here for PR review before merging |

---

## Prerequisites

- **Node.js 20+** — `winget install OpenJS.NodeJS.LTS`
- **Git** — `winget install Git.Git`
- **Docker Desktop** — for Forgejo ([download](https://www.docker.com/products/docker-desktop/))
- **PM2** — `npm install -g pm2`
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

---

## First-Time Setup

### 1. Clone and install dependencies

```powershell
git clone <your-repo-url> "C:\Flint"
cd "C:\Flint"

cd dashboard; npm install; cd ..
cd router;    npm install; cd ..
```

### 2. Start Forgejo

```powershell
docker compose up -d
```

Wait ~10 seconds, then bootstrap (first time only):

```powershell
# Default admin username is "admin" — pass -AdminUser to override
.\scripts\forgejo-init.ps1
# or: .\scripts\forgejo-init.ps1 -AdminUser yourname -AdminPassword yourpassword
```

This creates the admin user (default `admin`), saves an API token to `forgejo.token`, creates the `flint` repo, adds the `forgejo` git remote, and pushes `master`.
Forgejo login: `admin / changeme123` — **change this password** at `http://localhost:3030/user/settings/account`.

### 3. Start the full stack

```powershell
pm2 start ecosystem.config.cjs
```

### 4. Set up boot persistence

```powershell
pm2 startup   # run the command it prints (registers a Windows Task Scheduler entry)
pm2 save      # saves process list so it auto-restarts on reboot
```

### 5. Add your API keys

Open `http://localhost:3000` → **API Keys** tab. Add keys for the providers you want to use (Anthropic, OpenAI, Google, Azure, OpenRouter). Keys are stored encrypted in the local SQLite database — no `.env` file needed.

### 6. Verify

```powershell
Invoke-RestMethod http://localhost:3000/health | ConvertTo-Json
```

Expected:
```json
{ "status": "ok", "db": "connected", "forgejo": "reachable" }
```

---

## Dashboard — `http://localhost:3000`

### Agents

Spawn a Claude Code agent by entering a name, working directory, and optionally:
- **Runtime** — `claude` (Claude Code CLI) or `vibe` (Vibe Coding mode)
- **Specialist** — assign a specialist persona (injects a soul file and locks the model)
- **Role** — a role label used for automatic task assignment (e.g. `coder`, `tester`)
- **Model** — override the default model
- **Isolated branch** — tick to give the agent its own git worktree; a PR is created automatically in Forgejo when the agent exits

Each agent gets a live terminal panel streaming its output.

**Elastic panels** — The agent grid automatically shrinks panels to fit all running agents on one screen with no scrolling. Column count adjusts: 1 agent → 1 col, 2–4 → 2 col, 5–9 → 3 col, 10+ → 4 col. Click any panel's title bar to expand it to a full-screen overlay; click again or press **Escape** to collapse.

**Inter-agent handoff** — Every spawned agent's task file contains curl commands for posting new tasks to other specialist roles. Agents hand off work by calling `POST /queue/tasks` — Flint's orchestrator routes each task to the right agent automatically.

### Task Queue

Create tasks with a title, priority, and optional role. Tasks are automatically assigned to agents:
- **Role matching** — a pending task with `role: "coder"` is assigned to the first registered agent with that role
- **Auto-restart** — if the matching agent is stopped, it is automatically restarted
- **Default agent** — configure a fallback agent for tasks with no role (set in the Queue view header)
- The poller runs every 10 seconds

### Orchestrator

Create multi-agent orchestrations with a goal and notes. Each orchestration has a shared scratchpad agents can read from and write to. The orchestrator provides routing hints via the model router.

**Heartbeat orchestrator** — An LLM-based orchestrator runs on a configurable interval (default 5 min). It reviews system state (running agents, queue, projects) and autonomously: creates tasks, spawns agents for pending work, stops idle agents, and cascades follow-on tasks when prior phases complete. Configure via **Settings** → Heartbeat.

### Projects

Group agents into projects, track per-project LLM costs, add notes, and upload documents (PDF, text) for agents to reference. Each project shows a cost breakdown and linked agents.

### Specialists

Define reusable agent personas with a soul file, config, and domain tags. Assign a specialist at spawn time — the agent inherits the persona's system prompt and model. Track usage counts per specialist.

**Builder specialist** — A built-in `builder` role that creates new specialists on demand. When a queued task requires a role that has no specialist, auto-pickup automatically asks the builder to design and register one; the original task is then re-routed.

### Skills Library

Store and manage Claude Code skills as Markdown files. Import skills directly from a GitHub repository URL. Skills appear in the Skills tab and can be edited or deleted.

### MCP Servers

Configure Model Context Protocol servers (command, args, environment variables). Toggle servers on/off. The full config is exposed at `GET /config` for Claude Code to read.

### API Keys

Store LLM provider API keys in the local database through the UI. Keys are injected into the router's environment at startup. Supported providers: `anthropic`, `openai`, `google`, `azure`, `openrouter`. Keys are never written to disk in plaintext.

**Azure AI Foundry** — Use the quick-add section in the API Keys tab to enter your Azure endpoint, API key, deployment name, and API version as a single unit. These map to the `AZURE_OPENAI_*` env vars the router expects.

### Workspaces

Save working directory shortcuts (name + path) so you can pick them quickly when spawning agents.

### Supabase Memory (Optional)

Flint can sync agent memories to a Supabase project for vector search and cross-deployment memory sharing. This is **optional** — Flint runs fine without it.

**Setup:**
1. Create a free project at [supabase.com](https://supabase.com)
2. Enable the `pgvector` extension in your project: **Database → Extensions → vector**
3. Run the required SQL in the Supabase SQL editor (see `docs/admin-manual.md` — Supabase Setup)
4. Add two keys via the **API Keys** tab:
   - `SUPABASE_URL` — your project URL (e.g. `https://xyz.supabase.co`)
   - `SUPABASE_ANON_KEY` — your project's anon/public key
5. Restart the dashboard: `pm2 restart flint-dashboard`

**What it does once configured:**
- `POST /api/memory` — save a memory (name, type, description, body) with an auto-generated embedding
- `POST /api/memory/search` — semantic vector search across all memories
- `GET /api/memory` — list all memories
- `PATCH /api/memory/:name` — update a memory
- `DELETE /api/memory/:name` — delete a memory

Embeddings are generated using `text-embedding-3-small` via OpenAI, OpenRouter, or Mammouth (whichever key is present). If no embedding key is available, search falls back to full-text (`ilike`) matching.

### Local LLMs

- **Ollama** — status check and generation via the Ollama HTTP API (default: `http://localhost:11434`)
- **LM Studio** — status check and generation via the LM Studio local server (default: `http://localhost:1234`)

Both appear in the router's model list when running.

### Costs

Real-time cost tracking per provider and per model. View today's and this month's totals in the dashboard or via `flint costs`.

### Forgejo PR Review

When an isolated-branch agent exits, Flint automatically:
1. Pushes the agent's branch to Forgejo
2. Opens a PR via the Forgejo API
3. Shows a "View PR" link in the dashboard
4. Polls every 30 seconds — cleans up the worktree and local branch when the PR is merged

### Telegram Notifications

Add your Telegram bot token and chat ID via the API Keys tab (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Flint sends notifications for agent status changes, cost alerts, and PR events.

---

## CLI — `flint`

The CLI talks to the running dashboard (port 3000) and router (port 3001).

```powershell
# LLM
flint ask "summarise this in one sentence" --task coding --provider anthropic
flint models                          # list available models per provider
flint costs                           # today and month totals

# Projects
flint project list
flint project create "My Project"
flint project link <id> <agent-name>
flint project unlink <id> <agent-name>
flint project status <id> <status>
flint project notes <id> "notes text"

# Task queue
flint queue list
flint queue add "Fix the login bug" --role coder --priority high
flint queue assign <id> <agent-name>

# Orchestrations
flint orchestrate list

# Worktrees
flint worktree list
flint worktree discard <agent-name>

# Suggestions (from agents' ## SUGGESTION: ... blocks)
flint suggestions list
flint suggestions dismiss <id>

# Workspaces
flint workspace list
flint workspace add "My App" "C:\MyApp"

# MCP servers
flint mcp list
flint mcp add <name> <command>
```

---

## Architecture

```
C:\Flint\
│
├── dashboard/              Node.js server (port 3000)
│   ├── server.js           Express + WebSocket + all API routes
│   ├── db.js               SQLite (usage.sqlite) — all persistent state
│   ├── terminal.js         node-pty agent spawn + output streaming
│   ├── agents.js           Agent registry (in-memory + agents.json)
│   ├── queue.js            Task queue CRUD + 10s poller
│   ├── autoPickup.js       Role-based auto-assignment; triggers builder when role missing
│   ├── heartbeat.js        LLM-based autonomous orchestrator (runs on interval)
│   ├── settings.js         Key-value settings (getSetting/setSetting)
│   ├── worktrees.js        Git worktree create/discard
│   ├── forgejo.js          Forgejo API client (push branch, open PR, poll)
│   ├── github.js           GitHub API client (PR creation, provider detection)
│   ├── orchestrator.js     Orchestration CRUD + scratchpad
│   ├── projects.js         Project CRUD + cost aggregation
│   ├── project_docs.js     Document upload + retrieval (PDF, text)
│   ├── specialists.js      Specialist CRUD + soul file management
│   ├── skills.js           Skill library CRUD + GitHub import
│   ├── mcp.js              MCP server config management
│   ├── apikeys.js          API key storage + env injection
│   ├── suggestions.js      Agent suggestion parsing + storage
│   ├── tasks.js            Per-agent task file read/write
│   ├── telegram.js         Telegram bot notifications
│   ├── ollama.js           Ollama local LLM client
│   ├── lmstudio.js         LM Studio local LLM client
│   ├── logger.js           JSON-line structured logger
│   └── public/             Browser dashboard (vanilla JS + xterm.js)
│
├── router/                 Node.js server (port 3001)
│   ├── server.js           Express API — /llm/complete, /llm/models, /llm/costs
│   ├── router.js           Tier + provider routing logic
│   ├── config.js           router.json loader + specialist resolver
│   └── providers.js        Anthropic / OpenAI / Google / Azure / OpenRouter clients
│
├── bin/flint.js            CLI entry point
├── agents/                 Specialist definitions (config.json + soul.md per specialist)
├── context/                Flint identity (soul.md, user.md, memory.md, learnings.md)
├── skills/                 Built-in session skills (heartbeat, wrap-up, daily-briefing, start-here)
├── brand_context/          Brand voice, positioning, and sample copy
├── cron/                   Scheduled skill chain daemon
├── scripts/
│   └── forgejo-init.ps1    One-time Forgejo bootstrap
├── router.json             LLM tier/provider config (edit to change models)
├── docker-compose.yml      Forgejo service
└── ecosystem.config.cjs    PM2 process definitions
```

### Data model (SQLite — `dashboard/usage.sqlite`)

| Table | What it stores |
|---|---|
| `usage` | Per-request LLM cost rows (model, tokens, cost) |
| `agents_log` | Agent lifecycle events |
| `projects` | Project records + status/notes |
| `project_agents` | Project ↔ agent links |
| `project_docs` | Uploaded documents (text content + metadata) |
| `suggestions` | Agent `## SUGGESTION:` blocks |
| `workspaces` | Working directory shortcuts |
| `mcp_servers` | MCP server configs |
| `task_queue` | Queue tasks (title, role, priority, status, assigned agent) |
| `orchestrations` | Orchestration records + scratchpad |
| `api_keys` | Provider API keys (name, env_var, value) |
| `telegram_chat_ids` | Registered Telegram chat IDs |
| `skills` | Skill library entries |
| `specialists` | Specialist metadata (soul + config stored in `agents/specialists/`) |
| `settings` | Key-value settings (e.g. `default_agent` for queue auto-pickup) |

### PR lifecycle (isolated agents)

```
Agent exits with active worktree
  → dashboard broadcasts worktree_pending
  → server pushes branch to Forgejo (or GitHub)
  → server opens PR via API
  → UI shows "View PR" link + open badge

Every 30s:
  → server polls PR status
  → if merged: cleans up worktree + local branch
  → UI badge updates to merged/closed
```

### Task queue auto-pickup

```
Every 10s (queue poller):
  → checkQueueTasks()   — marks tasks done when agent checks off [x] in task file
  → autoAssignPendingTasks()
       for each pending task:
         if task.role → find agent with matching role
         if no role   → use settings.default_agent
         if agent stopped → assignQueueTask() + spawnAgent()
         if agent running → assignQueueTask() only
```

---

## LLM Router config — `router.json`

Edit `router.json` to change which model is used per tier and provider:

```json
{
  "tiers": {
    "1": { "anthropic": "claude-haiku-4-5", "openai": "gpt-4o-mini", ... },
    "2": { "anthropic": "claude-sonnet-4-6", "openai": "gpt-4o", ... },
    "3": { "anthropic": "claude-opus-4-6", "openai": "gpt-4o", ... }
  },
  "taskTypes": {
    "heartbeat":       { "tier": 1, "provider": "anthropic" },
    "classification":  { "tier": 1, "provider": "anthropic" },
    "research":        { "tier": 2, "provider": "anthropic" },
    "code":            { "tier": 2, "provider": "openai" },
    "architecture":    { "tier": 3, "provider": "anthropic" }
  },
  "defaultTier": 2
}
```

After editing, restart the router: `pm2 restart flint-router`

---

## Daily Use

### Start / stop

```powershell
# Start (after manual shutdown)
docker compose up -d
pm2 start ecosystem.config.cjs

# Stop
pm2 stop all
docker compose down
```

### PM2 commands

```powershell
pm2 ls                           # process status
pm2 logs flint-dashboard         # stream dashboard logs
pm2 logs flint-router            # stream router logs
pm2 restart flint-dashboard      # reload after code/config change
pm2 monit                        # real-time CPU/memory
```

### Updating Flint

```powershell
git pull forgejo master
pm2 restart all
```

---

## Testing

```powershell
# Full unit + integration suite (dashboard)
cd dashboard
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/apikeys.test.js tests/telegram.test.js tests/github.test.js tests/ollama.test.js tests/lmstudio.test.js tests/skills.test.js tests/project_docs.test.js tests/specialists.test.js tests/settings.test.js tests/autoPickup.test.js

# Router tests
cd router
node --test tests/config.test.js tests/router.test.js tests/server.test.js

# E2E (requires full stack running)
cd dashboard
node --test tests/e2e.test.js

# E2E with live agent spawn + Forgejo PR flow
E2E_FULL=1 node --test tests/e2e.test.js
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Dashboard not starting | `pm2 logs flint-dashboard` — check for port 3000 conflict |
| Router not starting | `pm2 logs flint-router` — check for port 3001 conflict |
| Forgejo unreachable | `docker compose ps` — check container is running; `docker compose up -d` |
| LLM calls returning errors | Go to API Keys tab — check `env_set: true` for your provider; verify the key value |
| PR not created after agent exits | Check `forgejo.token` exists at Flint root; re-run `forgejo-init.ps1` |
| Agent terminal not streaming | Refresh browser; check WebSocket in browser devtools (Network → WS) |
| `FLINT_DB_PATH` error | Delete `usage.sqlite` and restart — it rebuilds automatically |
| Queue tasks not being picked up | Check the Queue view — confirm `Default agent` is set or tasks have a `role` that matches a registered agent |
| node-pty spawn error | Ensure Claude Code CLI is on PATH: `claude --version` |

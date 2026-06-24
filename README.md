# Flint — Personal AI Agent OS

Flint is Robin's personal agentic operating system. It runs multiple Claude Code agents simultaneously, routes LLM calls across providers (Anthropic, OpenAI, Google, Azure, OpenRouter), manages projects and costs, reviews agent work via Forgejo PRs, and persists memory across sessions.

---

## What's Inside

| Component | Port | What it does |
|-----------|------|-------------|
| **Dashboard** | 3000 | Live terminal panels for every agent, task queues, cost tracking, PR review UI |
| **Model Router** | 3001 | Multi-provider LLM gateway — routes by task type, supports CLI providers (cost $0) |
| **Forgejo** | 3030 | Self-hosted Git UI — agents push branches here for PR review before merging |
| **Cron daemon** | — | Runs scheduled skill chains via `cron/jobs.json` |

---

## Prerequisites

- **Node.js 20+** — `node --version`
- **Git** — `git --version`
- **Docker Desktop** — for Forgejo ([download](https://www.docker.com/products/docker-desktop/))
- **PM2** — `npm install -g pm2`
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

---

## First-Time Setup

### 1. Clone and install dependencies

```powershell
git clone <your-repo-url> "C:\Users\Robin\Applications Dev\Flint"
cd "C:\Users\Robin\Applications Dev\Flint"

cd dashboard && npm install && cd ..
cd router    && npm install && cd ..
```

### 2. Configure environment

Create a `.env` file at the Flint root (never committed):

```env
# LLM Providers — add keys for the providers you use
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
OPENROUTER_API_KEY=...

# Supabase (for pgvector memory — optional until memory exceeds ~100 chunks)
SUPABASE_URL=https://cvhyqsinrqckckzkktug.supabase.co
SUPABASE_ANON_KEY=<your-anon-key-from-supabase-dashboard>

# Forgejo (populated by forgejo-init.ps1 — leave blank for now)
# FORGEJO_TOKEN is written to forgejo.token automatically
```

### 3. Start Forgejo (Docker)

```powershell
docker compose up -d
```

Wait ~10 seconds, then bootstrap (first time only):

```powershell
.\scripts\forgejo-init.ps1
```

This creates the `robin` admin user, generates an API token saved to `forgejo.token`, creates the `flint` repo, adds the `forgejo` git remote, and pushes `master`. Forgejo login: `robin / changeme123` — **change this password** at `http://localhost:3030`.

### 4. Start the full stack via PM2

```powershell
pm2 start ecosystem.config.cjs
```

### 5. Set up boot persistence

```powershell
pm2 startup    # generates a Windows Task Scheduler entry — run the command it prints
pm2 save       # saves the process list so it auto-restarts on reboot
```

### 6. Install log rotation

```powershell
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### 7. Verify everything is healthy

```powershell
Invoke-RestMethod http://localhost:3000/health | ConvertTo-Json
```

Expected:
```json
{ "status": "ok", "uptime": 12, "db": "connected", "forgejo": "reachable" }
```

Open `http://localhost:3000` for the dashboard.

---

## Daily Use

### Start / stop the stack

```powershell
# Start (after a manual shutdown or reboot without Task Scheduler)
docker compose up -d
pm2 start ecosystem.config.cjs

# Stop
pm2 stop all
docker compose down
```

### Dashboard — `http://localhost:3000`

- **Spawn agent** — enter a name, pick a model, click Spawn
- **Isolated branch** — tick the checkbox before spawning to give the agent its own git worktree; when it exits a PR is created automatically in Forgejo
- **Task queue** — each agent panel has a task file you can edit in real time
- **Suggestions** — agents emit `## SUGGESTION: ...` blocks; they appear in the strip at the top
- **Projects tab** — group agents into projects, see per-project costs, add notes

### Forgejo — `http://localhost:3030`

Review and merge agent PRs. Merging triggers automatic cleanup of the worktree and local branch within 30 seconds.

### CLI — `flint`

```powershell
# Ask a quick question via the router
flint ask "summarise this in one sentence" --task coding --provider anthropic

# List available models
flint models

# Check today's costs
flint costs

# Project management
flint project list
flint project create "My Project"
flint project link <id> <agent-name>

# Worktrees (agent isolated branches)
flint worktree list
flint worktree discard <agent-name>

# Suggestions
flint suggestions list
flint suggestions dismiss <id>
```

### PM2 commands

```powershell
pm2 ls                           # process status
pm2 logs flint-dashboard         # stream dashboard logs
pm2 logs flint-router            # stream router logs
pm2 restart flint-dashboard      # restart after a config change
pm2 monit                        # real-time CPU/memory monitor
```

---

## Architecture

```
C:\Users\Robin\Applications Dev\Flint\
│
├── dashboard/          Node.js server (port 3000)
│   ├── server.js       Express + WebSocket + agent management
│   ├── db.js           SQLite (usage.sqlite) — agents, costs, projects, PRs
│   ├── terminal.js     node-pty agent spawn + output streaming
│   ├── worktrees.js    git worktree create/discard
│   ├── forgejo.js      Forgejo API client (push branch, create PR, poll status)
│   ├── logger.js       JSON-line structured logger
│   └── public/         Browser dashboard (vanilla JS + xterm.js)
│
├── router/             Node.js server (port 3001)
│   └── server.js       Multi-provider LLM gateway + tier routing
│
├── bin/flint.js        CLI entry point
├── cron/               Scheduled skill chain daemon
├── scripts/
│   └── forgejo-init.ps1   One-time Forgejo bootstrap
├── docker-compose.yml  Forgejo service
├── ecosystem.config.cjs   PM2 process definitions
├── context/            Flint identity (soul.md, user.md, memory.md, learnings.md)
├── skills/             Heartbeat, wrap-up, daily-briefing, start-here
└── brand_context/      Robin's brand voice and positioning
```

### PR lifecycle (isolated agents)

```
Agent exits with active worktree
  → dashboard broadcasts worktree_pending
  → server pushes branch to Forgejo
  → server opens PR via Forgejo API
  → UI shows "View PR" link + open badge

Every 30s:
  → server polls Forgejo PR status
  → if merged: cleans up worktree + local branch
  → UI badge updates to merged/closed
```

---

## Supabase (pgvector memory — optional)

A Supabase project `flint` is provisioned in `eu-west-2` (London) with:

- **`memories` table** — stores Flint's memory chunks with 1536-dim embeddings and an HNSW index for fast cosine similarity search
- **`sessions` table** — session log with summaries and learnings
- **`search_memories()` function** — semantic search by embedding, filterable by type (`user` / `feedback` / `project` / `reference`)

Connect URL: `db.cvhyqsinrqckckzkktug.supabase.co`

Add your `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env` when you're ready to migrate from file-based memory to vector search (recommended once memory files exceed ~100 entries).

---

## Updating Flint

Agent worktrees merge into `master` via Forgejo. For manual changes:

```powershell
git pull forgejo master   # pull any Forgejo-merged changes
```

---

## Adding Gitea Actions CI (optional, future)

Add to `docker-compose.yml`:

```yaml
  gitea-runner:
    image: gitea/act_runner:latest
    environment:
      - GITEA_INSTANCE_URL=http://flint-forgejo:3000
      - GITEA_RUNNER_REGISTRATION_TOKEN=<token>
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    restart: unless-stopped
```

No application code changes required — the PR flow already works end-to-end.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Dashboard not starting | `pm2 logs flint-dashboard` — check for port 3000 conflict |
| Forgejo unreachable | `docker compose ps` — check container is running; `docker compose up -d` |
| PR not created after agent exits | Check `forgejo.token` exists at Flint root; re-run `forgejo-init.ps1` |
| Agent terminal not streaming | Refresh browser; check WebSocket connection in browser devtools |
| `FLINT_DB_PATH` error | Delete `usage.sqlite` and restart — it rebuilds automatically |
| Router 500 errors | Check provider API keys in `.env`; `pm2 logs flint-router` |

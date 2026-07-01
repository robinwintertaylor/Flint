# Flint — Administration Manual

> **Audience:** Whoever installs, configures, and maintains Flint. Covers installation, configuration files, maintenance, upgrades, backup, and advanced troubleshooting.

---

## System Requirements

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| OS | Windows 10/11 | Windows 11 Pro recommended |
| Node.js | 20 LTS | `winget install OpenJS.NodeJS.LTS` — use v20 or v22; avoid v24 (no prebuilt binaries for native modules yet) |
| Windows Build Tools | VS 2022 Build Tools + Windows 11 SDK | Required for `better-sqlite3` and `node-pty` — see Installation step 0 |
| RAM | 8 GB | 16 GB recommended for 5+ simultaneous agents |
| Disk | 2 GB free | SQLite DB + agent logs + git worktrees |
| Git | Any recent | `winget install Git.Git` |
| Docker Desktop | Latest | Required for Forgejo only |
| PM2 | Latest | `npm install -g pm2` |
| Claude Code CLI | Latest | `npm install -g @anthropic-ai/claude-code` |

---

## Installation

### 0. Install Windows Build Tools (first-time only)

Open PowerShell **as Administrator** and run:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --quiet --wait"
```

This installs the C++ build toolchain and Windows SDK needed to compile `better-sqlite3` and `node-pty`. Without it, `npm install` will fail on a fresh machine.

> **Already have Visual Studio?** Make sure the **Desktop development with C++** workload and a Windows 11 SDK component are installed via the Visual Studio Installer.

### 1. Clone and install

Run all commands in **PowerShell** (not cmd.exe).

```powershell
git clone <your-repo-url> C:\Flint
cd C:\Flint

cd dashboard
npm install
cd ..
cd router
npm install
cd ..
```

### 2. Install the CLI globally

```powershell
npm install -g .
```

### 3. Start Forgejo (self-hosted Git)

```powershell
docker compose up -d
```

Wait ~10 seconds, then bootstrap (run once only):

```powershell
# Default admin username is "admin" — pass -AdminUser to use your own name
.\scripts\forgejo-init.ps1
# or: .\scripts\forgejo-init.ps1 -AdminUser yourname -AdminPassword yourpassword
```

This creates the admin user (default `admin`), generates an API token at `forgejo.token`, creates the `flint` repo, adds the `forgejo` remote, and pushes `master`.

**Change the default password** at `http://localhost:3030/user/settings/account` (default: `changeme123`).

### 4. Configure environment

Copy `.env.example` to `.env` and edit as needed:

```
PORT=3000
ROUTER_PORT=3001
FLINT_IDLE_TIMEOUT=60
NODE_ENV=production
```

`FLINT_IDLE_TIMEOUT` — seconds of silence before Flint sends "please continue" to an idle agent.

### 5. Start the stack

```powershell
pm2 start ecosystem.config.cjs
```

### 6. Persist across reboots

```powershell
pm2 startup   # follow the printed instruction — registers a Task Scheduler entry
pm2 save      # saves the current process list
```

### 7. Add API keys

Open `http://localhost:3000` → **API Keys** tab and add your provider keys. After adding keys:

```powershell
pm2 restart flint-router
```

### 8. Verify health

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Expected: `{ "status": "ok", "db": "connected", "forgejo": "reachable" }`

---

## Process Management

Flint runs two Node.js processes under PM2:

| Process | Entry point | Port |
|---------|-------------|------|
| `flint-dashboard` | `dashboard/server.js` | 3000 |
| `flint-router` | `router/server.js` | 3001 |

### Common PM2 commands

```powershell
pm2 ls                           # process list + status
pm2 logs flint-dashboard         # stream dashboard logs
pm2 logs flint-router            # stream router logs
pm2 restart flint-dashboard      # reload after code changes
pm2 restart flint-router         # reload after API key changes
pm2 restart all                  # restart both
pm2 stop all                     # stop both (Forgejo keeps running)
pm2 monit                        # real-time CPU/memory monitor
```

### Starting / stopping the full stack

```powershell
# Start everything (after a manual shutdown)
docker compose up -d
pm2 start ecosystem.config.cjs

# Stop everything
pm2 stop all
docker compose down
```

---

## Configuration Files

### `ecosystem.config.cjs`

PM2 process definitions. Edit to change ports, Node flags, or environment variables:

```js
module.exports = {
  apps: [
    { name: 'flint-dashboard', script: 'dashboard/server.js', env: { PORT: 3000 } },
    { name: 'flint-router',    script: 'router/server.js',    env: { PORT: 3001 } },
  ],
};
```

### `router.json`

Controls which model and provider each tier and task type uses. Edit this to swap models:

```json
{
  "tiers": {
    "1": { "anthropic": "claude-haiku-4-5", "openai": "gpt-4o-mini" },
    "2": { "anthropic": "claude-sonnet-4-6", "openai": "gpt-4o" },
    "3": { "anthropic": "claude-opus-4-6", "openai": "gpt-4o" }
  },
  "taskTypes": {
    "heartbeat":      { "tier": 1, "provider": "anthropic" },
    "classification": { "tier": 1, "provider": "anthropic" },
    "research":       { "tier": 2, "provider": "anthropic" },
    "code":           { "tier": 2, "provider": "openai" },
    "architecture":   { "tier": 3, "provider": "anthropic" }
  },
  "defaultTier": 2
}
```

After editing: `pm2 restart flint-router`

### `.env`

Local environment overrides. Never commit this file — it is gitignored.

```
PORT=3000
ROUTER_PORT=3001
FLINT_IDLE_TIMEOUT=60
```

API keys go in the database (via UI), not here.

### `docker-compose.yml`

Forgejo service definition. Default data volume is `./forgejo-data`. To change the port, edit:

```yaml
ports:
  - "3030:3000"
```

---

## Database

Flint uses SQLite at `dashboard/flint.db`. This file is gitignored and created automatically on first run. Schema is applied via `dashboard/db.js`.

### Key tables

| Table | Purpose |
|-------|---------|
| `usage` | Per-request LLM cost rows |
| `agents_log` | Agent lifecycle events |
| `projects` | Project records |
| `task_queue` | Queue tasks (title, role, status, assigned agent) |
| `api_keys` | Encrypted provider keys |
| `specialists` | Specialist metadata |
| `skills` | Skill library entries |
| `settings` | Key-value config (heartbeat interval, default agent, etc.) |
| `heartbeat_log` | Orchestrator thought/action log |
| `mcp_servers` | MCP server configs |
| `workspaces` | Working directory shortcuts |

### Backup

```powershell
# Stop the dashboard first to avoid partial writes
pm2 stop flint-dashboard
Copy-Item dashboard\flint.db backups\flint-$(Get-Date -f yyyyMMdd).db
pm2 start flint-dashboard
```

### Reset / wipe

```powershell
pm2 stop flint-dashboard
Remove-Item dashboard\flint.db
pm2 start flint-dashboard   # schema is rebuilt automatically
```

---

## Supabase Setup (Optional — Cloud Memory)

Supabase provides vector memory storage and semantic search across agent sessions. It is entirely optional — Flint operates normally without it.

### 1. Create a Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a new project.
2. Enable the `pgvector` extension: **Database → Extensions → search "vector" → Enable**.
3. Note your **Project URL** and **anon public key** from **Project Settings → API**.

### 2. Run the required SQL migrations

Open the **SQL Editor** in your Supabase project and run each block below:

**Create tables:**
```sql
create table if not exists memories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        text,
  description text,
  body        text,
  embedding   vector(1536),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  constraint memories_name_key unique (name)
);

create table if not exists sessions (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz default now(),
  ended_at    timestamptz,
  summary     text,
  learnings   text,
  agent_names text[]
);
```

**Create the vector search function (required for semantic search):**
```sql
create or replace function search_memories(
  query_embedding vector(1536),
  match_type      text    default null,
  match_count     int     default 10,
  match_threshold float   default 0.7
)
returns table (
  id          uuid,
  name        text,
  type        text,
  description text,
  body        text,
  similarity  float
)
language plpgsql as $$
begin
  return query
  select
    m.id, m.name, m.type, m.description, m.body,
    1 - (m.embedding <=> query_embedding) as similarity
  from memories m
  where
    (match_type is null or m.type = match_type)
    and 1 - (m.embedding <=> query_embedding) >= match_threshold
  order by m.embedding <=> query_embedding
  limit match_count;
end;
$$;
```

**Add indexes for performance:**
```sql
create index if not exists memories_type_idx on memories (type);
create index if not exists memories_hnsw_idx on memories
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
```

**Enable Row-Level Security (recommended):**
```sql
alter table memories enable row level security;
alter table sessions enable row level security;

create policy "service_role_all_memories" on memories
  for all using (auth.role() = 'service_role');
create policy "service_role_all_sessions" on sessions
  for all using (auth.role() = 'service_role');

-- Allow anon key to read memories (needed by the dashboard):
create policy "anon_read_memories" on memories
  for select using (auth.role() = 'anon');
```

### 3. Add keys to Flint

In the **API Keys** tab, add:

| Key name | Env var | Value |
|----------|---------|-------|
| Supabase URL | `SUPABASE_URL` | `https://xyz.supabase.co` |
| Supabase Anon Key | `SUPABASE_ANON_KEY` | your anon/public key |

Then restart: `pm2 restart flint-dashboard`

### 4. Verify

```powershell
Invoke-RestMethod http://localhost:3000/api/memory
```

Returns `{ "memories": [] }` if Supabase is connected. Returns `503` if keys are missing or invalid.

### API routes

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/memory` | List all memories |
| `POST` | `/api/memory` | Save/update a memory (upsert by name) |
| `POST` | `/api/memory/search` | Semantic vector search |
| `PATCH` | `/api/memory/:name` | Update a memory's body/description |
| `DELETE` | `/api/memory/:name` | Delete a memory |

### Embeddings

Embeddings are generated using `text-embedding-3-small` (1536 dimensions). The system tries providers in order: **OpenAI → OpenRouter → Mammouth**. If none is available, semantic search falls back to full-text (`ilike`) matching.

---

## Heartbeat Orchestrator

The heartbeat runs an LLM call on a configurable interval to autonomously manage agents.

**Settings** (via dashboard → Settings tab):

| Setting | Default | Notes |
|---------|---------|-------|
| `heartbeat_enabled` | `true` | Set to `false` to disable |
| `heartbeat_interval_minutes` | `5` | How often the orchestrator runs |
| `heartbeat_model` | router-default | Override model for orchestrator calls |
| `heartbeat_provider` | router-default | Override provider |

The orchestrator can: create queue tasks, spawn agents, stop idle agents, cascade follow-on tasks. Its decisions are logged to `heartbeat_log`.

To turn it off temporarily:
```powershell
# Via CLI
flint settings set heartbeat_enabled false
pm2 restart flint-dashboard
```

---

## Specialists — File Layout

Each specialist has a directory at `agents/specialists/<name>/`:

```
agents/specialists/
  builder/
    config.json    # metadata: name, label, description, preferred_tier, preferred_provider
    soul.md        # system prompt injected into the agent's task file
  coder/
    config.json
    soul.md
```

Specialists registered via the UI are also stored in the database; the file on disk is the canonical soul. If you edit `soul.md` directly, restart the dashboard and re-register (or the DB record will be stale).

The **builder** specialist lives at `agents/specialists/builder/` and is the engine that creates new specialists on demand. Do not delete or rename it.

---

## Forgejo Administration

### First-time bootstrap

```powershell
.\scripts\forgejo-init.ps1                                          # creates "admin" user
.\scripts\forgejo-init.ps1 -AdminUser yourname -AdminPassword s3cr3t  # custom username
```

Creates the admin user (default `admin`, password `changeme123`), generates an API token, creates the `flint` repo.

### Token regeneration

If `forgejo.token` is lost:
1. Log in at `http://localhost:3030` with your admin username
2. Go to **Settings → Applications → Generate new token**
3. Paste the token into `forgejo.token` at the Flint root

### Backup Forgejo data

```powershell
docker compose stop forgejo
Copy-Item -Recurse forgejo-data backups\forgejo-$(Get-Date -f yyyyMMdd)
docker compose start forgejo
```

### Accessing Forgejo directly

`http://localhost:3030` — log in with the admin username you set during bootstrap (default: `admin` / `changeme123` — change this).

---

## Upgrading Flint

```powershell
git pull origin main        # or your remote name
cd dashboard
npm install
cd ..
cd router
npm install
cd ..
pm2 restart all
```

The database schema is applied on startup via `db.js` — no manual migrations needed.

---

## Logs

| Log | Location | What it contains |
|-----|----------|-----------------|
| Dashboard | `logs/dashboard.log` | Express requests, agent events, errors |
| Router | `logs/router.log` | LLM routing decisions, provider errors |
| Cron | `logs/cron.log` | Scheduled skill chain runs |
| PM2 (live) | `pm2 logs` | Real-time stdout from both processes |

Log files rotate on restart (PM2 default). For persistent log rotation: `pm2 install pm2-logrotate`.

---

## Ports and Firewall

| Port | Service | Bind |
|------|---------|------|
| 3000 | Flint Dashboard | localhost |
| 3001 | Model Router | localhost |
| 3030 | Forgejo | localhost |

All three bind to `localhost` by default — they are not exposed to the network. Do not expose ports 3000/3001/3030 to the internet without authentication and TLS.

---

## Running Tests

```powershell
# Dashboard unit + integration tests
cd dashboard
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js `
  tests/server.test.js tests/projects.test.js tests/mcp.test.js `
  tests/queue.test.js tests/orchestrator.test.js tests/apikeys.test.js `
  tests/telegram.test.js tests/github.test.js tests/ollama.test.js `
  tests/lmstudio.test.js tests/skills.test.js tests/project_docs.test.js `
  tests/specialists.test.js tests/settings.test.js tests/autoPickup.test.js

# Router tests
cd ..\router
node --test tests/config.test.js tests/router.test.js tests/server.test.js

# E2E (requires full stack running)
cd ..\dashboard
node --test tests/e2e.test.js

# E2E with live agent spawn + Forgejo PR flow
$env:E2E_FULL = "1"; node --test tests/e2e.test.js
```

---

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Dashboard 502 / not loading | `pm2 ls` | `pm2 restart flint-dashboard`; check `pm2 logs flint-dashboard` |
| Port 3000 in use | `netstat -ano \| findstr 3000` | Kill the conflicting process or change `PORT` in `.env` |
| Router not responding | `pm2 logs flint-router` | Check API keys are set; restart: `pm2 restart flint-router` |
| LLM calls returning 401 | API Keys tab → `env_set: true`? | Key may not have loaded — restart router after adding keys |
| Forgejo unreachable | `docker compose ps` | `docker compose up -d`; check Docker Desktop is running |
| PR not created after agent exit | `forgejo.token` exists? | Re-run `forgejo-init.ps1` |
| Agent terminal not streaming | Browser devtools → Network → WS | Reload page; check WebSocket is connected |
| `node-pty` spawn error | `claude --version` on PATH? | Re-install Claude Code CLI or check PATH |
| Database locked error | `pm2 logs flint-dashboard` | Only one process should access `flint.db` — stop any extra instances |
| Queue tasks not being picked up | Queue view → Default agent set? | Set a default agent, or ensure tasks have a role matching a registered agent |
| Heartbeat spawning too many agents | Settings → `heartbeat_enabled` | Set to `false`, or increase `heartbeat_interval_minutes` |
| High LLM costs | Costs tab → per-model breakdown | Switch heartbeat to tier 1 (cheap model) in Settings; review task types in `router.json` |
| `FLINT_DB_PATH` error | Old env var from v1 | Remove from `.env`; DB path is now hardcoded to `dashboard/flint.db` |
| Worktrees left behind | `flint worktree list` | `flint worktree discard <agent-name>` |

# Flint — User Manual

> **Audience:** Day-to-day users of the Flint dashboard. Assumes Flint is already installed and running.

---

## Getting Started

Open `http://localhost:3000` in your browser. You'll see the Flint dashboard with a header bar, toolbar, and an empty agent grid.

The header shows:
- **Flint logo + name** (left)
- **Agent count · Projects · Agents** nav (centre)
- **Today's cost · Month cost** (right)

---

## Spawning an Agent

1. Click **+ New Agent** in the toolbar.
2. Fill in the form:
   | Field | Required | Notes |
   |-------|----------|-------|
   | Name | Yes | Lowercase, no spaces — e.g. `coder-1` |
   | Working directory | Yes | Absolute path the agent will work in |
   | Specialist | No | Pick a persona — injects a soul and locks the model |
   | Runtime | No | `claude` (default), `openrouter`, `mammouth`, `ollama`, `vibe` |
   | Model | No | Override the specialist's default — e.g. `claude-sonnet-4-6` |
   | Role | No | Label for task routing — e.g. `coder`, `tester`, `researcher` |
   | Isolated branch | No | Gives the agent its own git branch; PR opens in Forgejo on exit |
3. Click **Spawn**.

The agent appears as a panel in the grid and begins running immediately.

### Panel controls

Each panel's title bar shows the agent name, status badge (running / stopped / idle), runtime, and role. The right side has:
- **⚙** — change model/runtime while the agent is stopped
- **Clear tasks** — wipe the agent's task file
- **Kill** — terminate the running process
- **Restart** (appears when stopped) — restart with the same settings
- **Remove** (appears when stopped) — deregister the agent

### Elastic panels

The grid shrinks panels to fill the viewport — no scrolling needed. As you add more agents the columns increase automatically (1→1 col, 2–4→2 col, 5–9→3 col, 10+→4 col).

**Expand a panel**: Click anywhere on its title bar (not a button). The panel floats over the grid at full size with a blue border.
**Collapse**: Click the title bar again, or press **Escape**.

---

## Sending Instructions to an Agent

Click inside a panel's terminal and type — keystrokes go directly to the Claude Code CLI running in that panel. To give the agent a complex task, write it in the **Tasks** sidebar on the right of each panel and click **+** (or press Enter).

Tasks use Markdown checkbox syntax:
```
- [ ] Research the API
- [ ] Write the integration
- [ ] Run tests
```

The agent checks off items as it completes them. The panel sidebar re-renders every 5 seconds.

---

## Task Queue

The queue lets you pre-stage work that agents pick up automatically.

**Creating a task:**
1. Go to **Queue** tab (toolbar).
2. Click **+ Add Task**.
3. Enter a title, description, priority (low / normal / high), and optionally a **role** (must match an agent's role label).

**Auto-assignment rules:**
- Task has a role → assigned to the first agent with that role (agent is restarted if stopped)
- Task has no role → assigned to the **Default agent** (set in the Queue view header)
- No matching agent and no default → task stays pending until an agent is available

**Builder auto-provision:** If a task's role has no registered specialist at all, Flint automatically asks the builder specialist to create one. The original task re-queues once the builder finishes.

**Heartbeat orchestrator:** Every few minutes an LLM reviews the system state and can create tasks, spawn agents, or cascade follow-on work — you can let it run fully autonomously or turn it off in Settings.

---

## Projects

Projects group agents, track shared costs, and can run an autonomous
orchestrator against a goal.

1. Click **Projects** in the header nav.
2. Click **+ New Project**, give it a name, notes, and optionally a
   **workspace** (the folder its agents will work in — if you skip this,
   agents fall back to a configured default working directory).
3. Link agents to the project from the project card's **Link agent**
   dropdown, or set a **Goal** and click **Launch** to spin up an
   orchestrator automatically.
4. Optionally upload reference documents (PDF, text) the agents can read.

The project card shows cost broken down by agent, a rolling session summary
from each agent's last exit, and — once a goal has been launched — an
orchestration status chip (running/done/failed).

### Launching a goal

Setting a **Goal** and clicking **Launch** spawns an orchestrator agent that
plans and executes the work: it researches (for anything non-trivial),
writes a plan, spawns whatever specialists it needs, and tracks progress
against a shared scratchpad. Click the status chip to open a live scratchpad
viewer and watch its plan and findings as they're written.

### Project work and git

If the project's workspace is (or becomes) a git repository, the
orchestrator's work is committed automatically as each task completes, on
its own branch. When the orchestrator finishes, it pushes that branch and
opens a pull request for review — against Forgejo if this is a fresh
project (Flint creates the repo for you automatically), or against GitHub if
the workspace already points there.

If Forgejo happens to be unreachable when a brand-new project's workspace
needs a repo, none of this blocks you — work still gets committed locally,
and the remote/PR catches up automatically the next time you launch.

---

## Specialists

Specialists are reusable personas — a soul file (system prompt) + preferred model + domain tags.

**Using a specialist:**
- Pick one from the **Specialist** dropdown when spawning an agent.
- The agent's task file is prepopulated with the soul so it knows its role.

**Creating a specialist:**
1. Go to **Specialists** tab.
2. Click **+ New Specialist**.
3. Fill in name, label, description, soul (system prompt), preferred provider/tier, and domains.

**Builder specialist:** If you queue a task for a role that doesn't exist yet, Flint asks the builder to create the specialist for you automatically.

---

## Costs

The header shows today's and this month's totals in real time.

For a full breakdown:
- Go to the **Costs** tab, or
- Run `flint costs` in your terminal.

Cost is tracked per model and per provider. Each agent panel also shows its own session cost.

---

## API Keys

All LLM provider keys are stored in Flint's database — not in `.env` files.

1. Go to **API Keys** tab.
2. Click **+ Add Key** and fill in env var name and value. Common vars:

| Provider | Env var |
|----------|---------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GOOGLE_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Azure endpoint | `AZURE_OPENAI_ENDPOINT` |
| Azure key | `AZURE_OPENAI_API_KEY` |
| Azure deployment | `AZURE_OPENAI_DEPLOYMENT` |
| Azure API version | `AZURE_OPENAI_API_VERSION` |
| Telegram bot | `TELEGRAM_BOT_TOKEN` |
| Telegram chat | `TELEGRAM_CHAT_ID` |

For **Azure AI Foundry**, use the quick-add section at the bottom of the tab to enter all four Azure values at once.

Keys take effect after `pm2 restart flint-router`.

---

## Cloud Memory (Supabase — Optional)

If your admin has configured Supabase, Flint gains a persistent vector memory store that survives restarts and can be shared across multiple Flint installations.

**Saving a memory:**
```bash
curl -X POST http://localhost:3000/api/memory \
  -H "Content-Type: application/json" \
  -d '{"name":"project-x-notes","type":"project","description":"Notes on Project X","body":"..."}'
```

**Searching memories semantically:**
```bash
curl -X POST http://localhost:3000/api/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query":"authentication approach","type":"project","count":5}'
```

**Listing all memories:**
```bash
curl http://localhost:3000/api/memory
```

Memory types are free-form strings (e.g. `project`, `agent`, `feedback`, `reference`) — use whatever makes sense for your workflow. If Supabase is not configured these endpoints return `503`.

---

## Skills Library

Skills are Markdown instruction files that agents (or you) can invoke.

1. Go to **Skills** tab.
2. Click **+ Import from GitHub** and paste a repository URL to pull skills from it, or click **+ New Skill** to write one manually.

Skills are stored in the database and also written to `skills/` on disk so Claude Code can load them.

---

## MCP Servers

Model Context Protocol servers extend what agents can do (file systems, databases, external APIs).

1. Go to **MCP** tab.
2. Click **+ Add Server**, enter the name, command, args, and any env vars.
3. Toggle the server on/off with the switch.

The full MCP config is exposed at `GET /config` — Claude Code reads this automatically when it starts.

---

## Forgejo PR Review

When an agent is spawned with **Isolated branch** ticked:
- It gets its own git worktree so its changes are isolated.
- When the agent exits, Flint pushes the branch and opens a PR in Forgejo (`http://localhost:3030`).
- A **View PR** button appears in the panel header.
- Once the PR is merged, Flint cleans up the branch and worktree automatically.

---

## Telegram Notifications

Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` via the API Keys tab. Flint will send you messages when:
- An agent starts or exits
- An agent crashes
- A PR is opened or merged

---

## CLI Quick Reference

```powershell
flint ask "your question" --task coding   # one-shot LLM call
flint models                               # list available models
flint costs                                # cost summary

flint queue list
flint queue add "Task title" --role coder --priority high

flint project list
flint project create "Name"
flint project link <id> <agent-name>

flint workspace list
flint workspace add "My App" "C:\MyApp"

flint suggestions list                     # show ## SUGGESTION: blocks agents wrote
```

---

## Tips

- **Name agents for their role** — `coder-1`, `tester-1` makes auto-routing clearer.
- **Use the queue for async work** — queue a task then close the browser; the agent picks it up.
- **Elastic expand for debugging** — click a panel title when you need to read detailed output.
- **Default agent** — set one in the Queue view so unroled tasks always have somewhere to go.
- **Heartbeat can be noisy** — if it spawns too many agents, raise the interval in Settings or disable it while you're working hands-on.

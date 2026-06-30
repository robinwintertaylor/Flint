# Flint — Deployment Guide

## Architecture

Flint runs as two PM2-managed Node.js processes:

| Service | Entry point | Port | Purpose |
|---|---|---|---|
| `flint-dashboard` | `dashboard/server.js` | 3000 | Web UI, REST API, WebSocket, SQLite |
| `flint-router` | `router/server.js` | 3001 | LLM routing, agent spawn coordination |

Each process has its own `node_modules`. The dashboard borrows the `openai` package from `router/node_modules` via a relative import (`dashboard/chat.js`) — no extra install needed.

---

## System Prerequisites

Installed automatically by `install-flint.ps1` (requires winget):

| Tool | Install | Required for |
|---|---|---|
| Node.js LTS | winget / nodejs.org | Runtime for both services |
| Git | winget / git-scm.com | Source updates |
| PM2 | `npm install -g pm2` | Process management, boot persistence |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` | Agent execution |

PM2 is cross-platform. Use `pm2 restart flint-dashboard` after dashboard code changes, `pm2 restart all` for router changes.

---

## npm Dependencies

### `dashboard/` (`npm install` in `dashboard/`)

| Package | Purpose |
|---|---|
| `express` | HTTP server + REST API |
| `ws` | WebSocket (live agent updates, terminal) |
| `better-sqlite3` | SQLite database (agents, queue, settings, API keys) |
| `node-pty` | Pseudo-terminal for spawning agent processes |
| `@supabase/supabase-js` | Optional cloud storage integration |
| `node-telegram-bot-api` | Optional Telegram bot integration |
| `pdf-parse` | PDF parsing for agent tasks |

### `router/` (`npm install` in `router/`)

| Package | Purpose |
|---|---|
| `openai` | OpenAI-compatible client (OpenRouter, Mammouth, OpenAI) |
| `@anthropic-ai/sdk` | Anthropic/Claude agent runtime |
| `@google/genai` | Google Gemini agent runtime |
| `@azure/openai` | Azure OpenAI agent runtime |
| `express` | Router HTTP API |
| `node-cron` | Heartbeat + scheduled tasks |
| `dotenv` | `.env` file loading |

---

## Environment Variables

All keys are stored in the SQLite database via the API Keys tab and injected as `process.env` at runtime. They can also be set in a `.env` file in the repo root for local development.

| Variable | Required | Enables |
|---|---|---|
| `OPENROUTER_API_KEY` | **Yes (primary)** | Default LLM provider for agents and chat |
| `MAMMOUTH_API_KEY` | Alt primary | Alternative LLM provider (gpt-5.4-mini etc.) |
| `ANTHROPIC_API_KEY` | Optional | Claude agent runtime (native Anthropic SDK) |
| `OPENAI_API_KEY` | Optional | OpenAI agent runtime |
| `GOOGLE_API_KEY` | Optional | Google Gemini agent runtime |
| `AZURE_OPENAI_KEY` | Optional | Azure OpenAI agent runtime |
| `AZURE_OPENAI_ENDPOINT` | Optional | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_DEPLOYMENT` | Optional | Azure deployment name |
| `OLLAMA_BASE_URL` | Optional | Local Ollama models (e.g. `http://localhost:11434`) |
| `LMSTUDIO_BASE_URL` | Optional | Local LM Studio models (e.g. `http://localhost:1234`) |
| `SUPABASE_URL` | Optional | Supabase cloud storage URL |
| `SUPABASE_ANON_KEY` | Optional | Supabase anon key |
| `TELEGRAM_BOT_TOKEN` | Optional | Telegram bot integration |
| `GITHUB_TOKEN` | Optional | Agent PR creation (repo scope) |

At least one of `OPENROUTER_API_KEY` or `MAMMOUTH_API_KEY` must be configured for the chat panel and agent orchestration to work.

---

## Service Configuration (`ecosystem.config.cjs`)

```js
// ecosystem.config.cjs
apps: [
  {
    name: 'flint-dashboard',
    script: 'dashboard/server.js',
    cwd: 'C:/Users/Robin/Applications Dev/Flint',
    env: { PORT: '3000' }
  },
  {
    name: 'flint-router',
    script: 'router/server.js',
    cwd: 'C:/Users/Robin/Applications Dev/Flint',
    env: { PORT: '3001' }
  },
]
```

The `cwd` is hardcoded to the repo path. Update it if you move the repo.

---

## First-Time Installation

```powershell
# 1. Clone the repo (requires gh CLI + gh auth login)
gh repo clone <owner>/<repo> "C:\Flint"
Set-Location "C:\Flint"

# 2. Run the installer (as Administrator)
.\install-flint.ps1
```

The installer:
1. Checks `gh` CLI is installed and authenticated
2. Installs Node.js LTS, Git, PM2, Claude Code CLI via winget
3. Runs `npm install` in `dashboard/` and `router/`
4. Starts both services via `pm2 start ecosystem.config.cjs`
5. Configures Windows Task Scheduler boot persistence (`pm2-startup`)
6. Prompts for API keys (stored via `/api-keys` REST endpoint)
7. Opens `http://localhost:3000` in the browser

> **Note:** The installer uses `C:\Flint` as the install path. If installing to a different path, update `ecosystem.config.cjs` after cloning.

---

## Updating (after first install)

```powershell
# Pull latest code
git pull

# Restart dashboard only (most changes)
pm2 restart flint-dashboard

# Restart both services (router/agent changes)
pm2 restart all

# If new npm packages were added
npm install --prefix dashboard
npm install --prefix router
pm2 restart all
```

The deployment process is **unchanged** from before this session's changes. All new features (Mammouth provider, shared agent worker, chat panel, specialist improvements) use only existing packages — no new `npm install` step is needed for updates from this session.

---

## Useful PM2 Commands

```powershell
pm2 list                        # service status
pm2 logs flint-dashboard        # live dashboard logs
pm2 logs flint-router           # live router logs
pm2 logs flint-dashboard --lines 50 --nostream  # last 50 lines
pm2 restart flint-dashboard     # restart dashboard
pm2 restart all                 # restart both services
pm2 save                        # persist current process list for boot
```

---

## Health Check

```
GET http://localhost:3000/health
→ { status: "ok", db: "ok" }
```

# Flint — Multi-LLM Model Router: Design Spec
**Sub-project 3 of 5**
**Date:** 2026-06-23
**Status:** Approved

---

## 1. Problem

Sub-project 2 (Dashboard) gives you live views of Claude Code agents, but all agents are locked to Claude. Every task — from a quick formatting job to deep architectural reasoning — runs on the same expensive frontier model. There's no way to route simple tasks to cheaper models, no way to use GPT, Gemini, Mistral, Kimi, or Azure-hosted models, no scheduled automation, and no CLI for quick LLM queries.

---

## 2. Scope

**In:** Multi-provider LLM gateway (Anthropic, OpenAI, Google, Azure, OpenRouter), tier-based task routing with per-task-type overrides and per-invocation model selection, cron daemon for scheduled skill chains, CLI tool, dashboard model picker, root launcher.

**Out (noted for later):**
- Streaming responses over WebSocket (SP5)
- Retry/fallback between providers on failure (SP5)
- Telegram integration for cron output (future)
- Router config editor in the browser UI (SP4)
- Mammoth DAG pipeline orchestration (SP5)
- Model fine-tuning / custom endpoints (never unless asked)

---

## 3. Platform

- **OS:** Windows 11 (local machine)
- **Runtime:** Node.js 20+, ESM throughout (`"type": "module"`)
- **Ports:** Dashboard 3000 (existing), Router 3001 (new)
- **Root:** `C:\Users\Robin\Applications Dev\Flint\`
- **Shared:** `usage.sqlite` and `.env` at Flint root

---

## 4. File Structure

```
Flint/
├── start.js                  ← root launcher: dashboard + router + cron as child processes
├── package.json              ← root: "start": "node start.js"
├── .env                      ← all API keys (gitignored)
├── router.json               ← tier config + task-type overrides
│
├── router/
│   ├── package.json          ← deps: express, @anthropic-ai/sdk, openai, @google/genai, @azure/openai
│   ├── server.js             ← Express on port 3001, createApp() export
│   ├── router.js             ← route(taskType, prompt, opts) → {text, model, provider, costUsd}
│   ├── providers.js          ← adapters: anthropic, openai, google, azure, openrouter
│   ├── config.js             ← load + validate router.json
│   └── tests/
│       ├── router.test.js    ← routing logic tests (no real API calls)
│       └── config.test.js    ← config validation tests
│
├── cron/
│   ├── daemon.js             ← reads .cron/schedule.json, registers node-cron schedules
│   └── runner.js             ← executes chain entries: spawn (PTY) or api (router call)
│
├── bin/
│   └── flint.js              ← CLI: ask, models, config, costs subcommands
│
└── dashboard/                ← existing, minor additions:
    ├── public/app.js         ← model dropdown in New Agent modal
    └── server.js             ← GET /router/models and GET /router/config proxy routes
```

---

## 5. router.json

Lives at Flint root. Editable directly — no UI needed for v1.

```json
{
  "tiers": {
    "1": {
      "anthropic":   "claude-haiku-4-5",
      "openai":      "gpt-4o-mini",
      "google":      "gemini-2.0-flash",
      "azure":       "gpt-4o-mini",
      "openrouter":  "mistral/mistral-small"
    },
    "2": {
      "anthropic":   "claude-sonnet-4-6",
      "openai":      "gpt-4o",
      "google":      "gemini-2.0-pro",
      "azure":       "gpt-4o",
      "openrouter":  "mistral/mistral-medium"
    },
    "3": {
      "anthropic":   "claude-opus-4-6",
      "openai":      "gpt-4.5",
      "google":      "gemini-2.5-pro",
      "azure":       "gpt-4.5",
      "openrouter":  "mistral/mistral-large"
    }
  },
  "taskTypes": {
    "heartbeat":       { "tier": 1, "provider": "anthropic" },
    "formatting":      { "tier": 1, "provider": "openai" },
    "classification":  { "tier": 1, "provider": "anthropic" },
    "research":        { "tier": 2, "provider": "anthropic" },
    "content-writing": { "tier": 2, "provider": "anthropic" },
    "code":            { "tier": 2, "provider": "openai" },
    "architecture":    { "tier": 3, "provider": "anthropic" }
  },
  "defaultProvider": "anthropic",
  "defaultTier": 2
}
```

---

## 6. Router Service (port 3001)

### REST API

**`POST /llm/complete`**
Request: `{ taskType?, prompt, systemPrompt?, model?, provider? }`
- If `model` is given explicitly → skip routing, call that model on the specified (or default) provider
- If `taskType` is given → look up tier + provider from `taskTypes`, resolve model from tier
- Otherwise → use `defaultProvider` + `defaultTier`

Response: `{ text, model, provider, costUsd, durationMs }`

**`GET /llm/models`**
Returns all configured models per provider, derived from `router.json` tiers plus any extras. Used by dashboard model picker.

Response: `{ anthropic: [...], openai: [...], google: [...], azure: [...], openrouter: [...] }`

**`GET /llm/config`**
Returns current `router.json` content verbatim.

**`GET /llm/costs`**
Reads `usage.sqlite` — returns today + month totals grouped by provider.
Response: `{ today: { anthropic: 0.42, openai: 0.18, ... }, month: { ... }, totalToday: 0.60, totalMonth: 12.40 }`

### providers.js

One adapter per provider. All share the same interface:
```js
complete(model, messages) → Promise<{ text, costUsd }>
// messages: [{ role: 'system'|'user'|'assistant', content: string }]
```

| Provider | SDK | Env var(s) |
|---|---|---|
| anthropic | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` |
| openai | `openai` | `OPENAI_API_KEY` |
| google | `@google/genai` | `GOOGLE_API_KEY` |
| azure | `@azure/openai` | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT` |
| openrouter | `openai` (pointed at `https://openrouter.ai/api/v1`) | `OPENROUTER_API_KEY` |

Cost calculation: use token counts from each provider's response + published per-token rates for known models. Store as best-effort estimate; display with `~` prefix in UI.

### Cost tracking

Every successful completion calls `writeUsage({ agentName: taskType ?? 'cli', model, costUsd })` from the shared `dashboard/db.js`. Router imports db.js directly (both live under the same Flint root).

### server.js

`createApp()` export pattern (same as dashboard) — returns an `http.Server` for test isolation. Only starts when run directly.

---

## 7. Cron Daemon

### `.cron/schedule.json` (extended format)

```json
{
  "schedules": [
    {
      "name": "Morning Briefing",
      "cron": "0 7 * * 1-5",
      "type": "spawn",
      "chain": ["daily-briefing"],
      "workdir": "C:\\Users\\Robin\\Applications Dev\\Flint",
      "description": "Weekday morning summary — spawns Claude Code session"
    },
    {
      "name": "Weekly Research Digest",
      "cron": "0 9 * * 1",
      "type": "api",
      "taskType": "research",
      "prompt": "Summarise this week's key AI developments relevant to Robin's work",
      "description": "Monday morning research — calls router API directly"
    }
  ]
}
```

### daemon.js

- Loads `dotenv` from Flint root `.env`
- Reads and validates `.cron/schedule.json` on startup
- Registers each entry with `node-cron`
- On fire: calls `runner.js` with the entry, logs to `logs/cron-<name>-<YYYY-MM-DD>.log`
- Re-reads schedule file on `SIGHUP` (hot-reload without restart)

### runner.js

**`type: "spawn"`**
- Spawns a Claude Code PTY (using `node-pty`, same as dashboard `terminal.js`)
- Sends each skill name in `chain` as input (e.g. `/daily-briefing\n`)
- Captures output to `logs/cron-<name>-<date>.log`
- Kills the PTY after a configurable timeout (default: 5 minutes)

**`type: "api"`**
- POSTs to `http://localhost:3001/llm/complete` with `{ taskType, prompt }`
- Writes response text to `logs/cron-<name>-<date>.log`
- Logs cost from response

---

## 8. CLI Tool

**`bin/flint.js`** — uses Node built-in `parseArgs`, calls router at `http://localhost:3001`.

```
node bin/flint.js ask "prompt"
node bin/flint.js ask --task research "prompt"
node bin/flint.js ask --model claude-opus-4-6 "prompt"
node bin/flint.js ask --provider openai --task code "prompt"
node bin/flint.js models              ← list models per provider
node bin/flint.js config              ← show router.json
node bin/flint.js costs               ← today + month spend per provider
```

Prints response text to stdout. Errors exit 1 with a message. No framework dependencies.

---

## 9. Dashboard Additions

### Model picker in New Agent modal

`dashboard/public/app.js` — on modal open, fetch `GET /router/models` and populate a `<select id="modal-model">` dropdown. Default: empty (uses agent's own model config). Selected model stored on the agent and passed as `ANTHROPIC_MODEL` (or equivalent) env var when the PTY spawns.

`dashboard/server.js` — two new proxy routes:
```
GET /router/models  → proxy to http://localhost:3001/llm/models
GET /router/config  → proxy to http://localhost:3001/llm/config
```
Both fail gracefully with `{ error: 'router not running' }` if port 3001 is unreachable.

### dashboard/agents.js

Add optional `model` field to the agent object and `agents.json` persistence. When `spawnAgent` is called with a model, pass it as env var to node-pty.

---

## 10. Root Launcher

**`start.js`** at Flint root:
- Spawns three child processes: `node dashboard/server.js`, `node router/server.js`, `node cron/daemon.js`
- Pipes each process's stdout/stderr to `logs/dashboard.log`, `logs/router.log`, `logs/cron.log` (append mode)
- Also mirrors output to the terminal with a `[dashboard]`, `[router]`, `[cron]` prefix
- On `SIGINT`/`SIGTERM`: kills all children cleanly before exiting

**Root `package.json`:**
```json
{
  "name": "flint",
  "version": "1.0.0",
  "scripts": {
    "start": "node start.js",
    "dashboard": "node dashboard/server.js",
    "router": "node router/server.js",
    "cron": "node cron/daemon.js"
  }
}
```

Individual services can still be started independently for development.

---

## 11. Environment Variables (.env)

```
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
OPENAI_API_KEY=sk-...

# Google
GOOGLE_API_KEY=...

# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://...openai.azure.com
AZURE_OPENAI_KEY=...
AZURE_OPENAI_DEPLOYMENT=gpt-4o

# OpenRouter
OPENROUTER_API_KEY=sk-or-...
```

`.env` is gitignored. A `.env.example` stub is committed with placeholder values.

---

## 12. What's Deliberately Excluded

| Excluded | Reason | When |
|---|---|---|
| Streaming responses | WebSocket complexity | SP5 |
| Provider fallback/retry | YAGNI for v1 | SP5 |
| Telegram cron output | Needs bot setup | Future |
| Router config UI | Edit file directly | SP4 |
| Mammoth DAG pipelines | Complex orchestration | SP5 |
| Model fine-tuning endpoints | Not needed | Never unless asked |

---

## 13. Success Criteria

- [ ] `npm start` at Flint root starts dashboard (3000) + router (3001) + cron daemon
- [ ] `POST /llm/complete` with `{taskType: "research", prompt: "test"}` returns a completion from the configured Anthropic model
- [ ] `POST /llm/complete` with `{model: "gpt-4o", provider: "openai", prompt: "test"}` bypasses routing and calls OpenAI directly
- [ ] `GET /llm/models` returns model lists for all configured providers
- [ ] `node bin/flint.js ask --task research "test"` prints a completion to stdout
- [ ] `node bin/flint.js costs` shows today + month spend per provider
- [ ] Dashboard New Agent modal shows a model dropdown populated from `GET /router/models`
- [ ] Cron daemon fires a `type: "api"` entry at the scheduled time; output in `logs/`
- [ ] All completions written to `usage.sqlite`; costs visible in `GET /llm/costs`
- [ ] `node bin/flint.js ask --provider azure "test"` calls Azure AI Foundry correctly
- [ ] `.env.example` committed; `.env` gitignored

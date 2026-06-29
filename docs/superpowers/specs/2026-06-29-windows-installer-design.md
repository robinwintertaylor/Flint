# Windows Installer Design Spec

**Date:** 2026-06-29

## Goal

A single PowerShell script (`install-flint.ps1`) that turns a fresh Windows machine into a fully running Flint instance — prerequisites, dependencies, API key configuration, PM2 services, and boot persistence — in one command.

---

## Decisions

| Question | Decision |
|---|---|
| Source repo | Private GitHub — user is already authenticated via `gh` CLI |
| Install location | `C:\Flint` (hardcoded default, matches README) |
| Local Git server | Skipped — agents use GitHub directly for PRs |
| Anthropic API key | Not needed — Claude Code CLI uses Pro/Max plan auth |
| GitHub token | Always prompted — required for PR creation |
| Other providers | Offered interactively; user presses Enter to skip |
| API key storage | Written via `POST /api-keys` REST endpoint after dashboard starts |
| Boot persistence | `pm2 startup` (Windows Task Scheduler) + `pm2 save` |

---

## Bootstrap Command

```powershell
gh repo clone <owner>/<repo> C:\Flint; Set-Location C:\Flint; .\install-flint.ps1
```

The script lives in the repo root. The user clones via their already-authenticated `gh` session, then runs the installer. No chicken-and-egg token problem.

---

## Installer Steps

### 1. Prerequisites

Check each tool, install if absent:

| Tool | Check | Install |
|---|---|---|
| Node.js 20+ | `node --version` | `winget install OpenJS.NodeJS.LTS` |
| Git | `git --version` | `winget install Git.Git` |
| PM2 | `pm2 --version` | `npm install -g pm2` |
| Claude Code CLI | `claude --version` | `npm install -g @anthropic-ai/claude-code` |
| GitHub CLI (`gh`) | `gh --version` | **Exit with message** — must be pre-installed and authenticated |

After installing Node.js or Git via winget, refresh `$env:PATH` so subsequent commands find them without requiring a shell restart.

### 2. npm install

```powershell
Push-Location C:\Flint\dashboard; npm install; Pop-Location
Push-Location C:\Flint\router;    npm install; Pop-Location
```

### 3. Start PM2 services

```powershell
pm2 start C:\Flint\ecosystem.config.cjs
pm2 startup   # registers Windows Task Scheduler entry for boot persistence
pm2 save      # saves process list
```

### 4. Wait for dashboard

Poll `GET http://localhost:3000/health` up to 30 times (1-second intervals). Abort with clear error if it never responds.

### 5. Configure API keys

The installer POSTs keys directly to the running dashboard via `POST /api-keys`. The request body is `{ name, envVar, value }` — matching the existing API key schema.

**Always prompt:**
- GitHub Personal Access Token → `{ name: "github_token", envVar: "GITHUB_TOKEN", value: "<token>" }`

**Optionally prompt (Enter to skip each):**
| Provider | API key name(s) | envVar(s) |
|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Google AI | `google` | `GOOGLE_API_KEY` |
| Azure AI Foundry | `azure_key` / `azure_endpoint` / `azure_deployment` | `AZURE_OPENAI_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` |
| Ollama URL | `ollama_url` | `OLLAMA_BASE_URL` |
| LM Studio URL | `lmstudio_url` | `LMSTUDIO_BASE_URL` |

Azure prompts for three values in sequence. Ollama and LM Studio prompt for a base URL only (no secret key).

Supabase keys (`supabase_url`, `supabase_anon_key`) are omitted from the installer — users set these via the API Keys tab if they want remote memory sync.

### 6. Verify and open

```powershell
$health = Invoke-RestMethod http://localhost:3000/health
# print db and forgejo status
Start-Process "http://localhost:3000"
```

Print a completion summary: what was installed, which keys were configured, and how to update (`git pull && pm2 restart all`).

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| `gh` not installed / not authenticated | Print install instructions, exit |
| winget not available | Warn that tools must be installed manually, exit |
| `npm install` fails | Print error + log path, exit |
| Dashboard never starts | Print PM2 log tail, exit |
| API key POST fails (e.g. bad token format) | Print warning, continue (key can be re-entered via UI) |

---

## Updating Flint

```powershell
cd C:\Flint && git pull && pm2 restart all
```

No re-running the installer — git pull gets new code, pm2 restart picks it up.

---

## Files Changed

| File | Change |
|---|---|
| `install-flint.ps1` | **Create** — full installer script |

---

## Out of Scope

- macOS / Linux support
- Forgejo / Docker setup (skipped — GitHub used directly)
- Supabase key configuration (done via API Keys tab after install)
- Silent / unattended mode (all interactive)
- Upgrade-in-place logic (just `git pull && pm2 restart all`)

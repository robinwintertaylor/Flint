# Windows Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `install-flint.ps1` — a single PowerShell script that turns a freshly-cloned Flint repo on any Windows machine into a fully-running Flint instance.

**Architecture:** One self-contained PowerShell script in the repo root. It checks/installs prerequisites via winget and npm, installs Node.js dependencies, starts PM2 services, waits for the dashboard, configures API keys via the REST API, and opens the browser. No external dependencies beyond what it installs.

**Tech Stack:** PowerShell 5.1+ (ships with Windows 10/11), winget (ships with Windows 11), npm, PM2, GitHub CLI (`gh`), Flint REST API (`POST /api-keys`, `GET /health`).

## Global Constraints

- Script must run on Windows 10/11 with PowerShell 5.1+
- Install location is always `C:\Flint` — the script does not accept a custom path
- `gh` must already be installed and authenticated — script exits with a clear error if not
- winget must be available — script exits if it's not (only available on Windows 10 1709+)
- API keys are stored via `POST http://localhost:3000/api-keys` with body `{ name, envVar, value }` — never written to disk in plaintext
- Providers supported by the router: `anthropic` (no key — uses CLI auth), `openai`, `google`, `azure`, `openrouter`, `ollama`, `lmstudio`
- Azure requires three separate key entries: `azure_key`/`AZURE_OPENAI_KEY`, `azure_endpoint`/`AZURE_OPENAI_ENDPOINT`, `azure_deployment`/`AZURE_OPENAI_DEPLOYMENT`

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `install-flint.ps1` | **Create** | Full installer script |

---

### Task 1: Write and smoke-test `install-flint.ps1`

**Files:**
- Create: `install-flint.ps1` (repo root — `C:\Flint\install-flint.ps1`)

**Interfaces:**
- Consumes: `GET http://localhost:3000/health` → `{ status, db }`
- Consumes: `POST http://localhost:3000/api-keys` body `{ name: string, envVar: string, value: string }`
- Consumes: `C:\Flint\ecosystem.config.cjs` (must exist in repo)
- Produces: Running Flint stack (PM2 processes `flint-dashboard`, `flint-router`)

- [ ] **Step 1: Create `install-flint.ps1`**

Create `C:\Flint\install-flint.ps1` with this exact content:

```powershell
<#
.SYNOPSIS
  One-command Flint installer for Windows.

.DESCRIPTION
  Run this after cloning the Flint repo to C:\Flint:

    gh repo clone <owner>/<repo> C:\Flint
    Set-Location C:\Flint
    .\install-flint.ps1

  Prerequisites: gh CLI must already be installed and authenticated.
  Everything else (Node.js, Git, PM2, Claude Code CLI) is installed automatically.

.PARAMETER SkipPrereqs
  Skip automatic prerequisite installation. Use this if all tools are already installed.
#>

param(
  [switch]$SkipPrereqs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Helpers ─────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) {
  Write-Host "`n▶  $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg) {
  Write-Host "   ✓ $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
  Write-Host "   ⚠ $msg" -ForegroundColor Yellow
}

function Test-Command([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('PATH', 'User')
}

function Wait-For-Dashboard {
  Write-Step "Waiting for dashboard to start..."
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $null = Invoke-RestMethod http://localhost:3000/health -ErrorAction Stop
      Write-Ok "Dashboard is up"
      return
    } catch { }
  }
  throw "Dashboard did not respond after 30 seconds. Check logs: pm2 logs flint-dashboard"
}

function Post-ApiKey([string]$name, [string]$envVar, [string]$value) {
  $body = @{ name = $name; envVar = $envVar; value = $value } | ConvertTo-Json
  try {
    $null = Invoke-RestMethod http://localhost:3000/api-keys `
      -Method POST -ContentType 'application/json' -Body $body -ErrorAction Stop
    Write-Ok "Stored $name → $envVar"
  } catch {
    Write-Warn "Failed to store ${name}: $($_.Exception.Message)"
  }
}

function Prompt-Key([string]$label, [string]$name, [string]$envVar) {
  $val = Read-Host "   $label (Enter to skip)"
  if ($val -and $val.Trim() -ne '') {
    Post-ApiKey $name $envVar $val.Trim()
  }
}

# ── 1. Guard: gh CLI ─────────────────────────────────────────────────────────

Write-Step "Checking GitHub CLI..."

if (-not (Test-Command 'gh')) {
  Write-Host @"

  ERROR: GitHub CLI (gh) is not installed or not on PATH.

  Install it from: https://cli.github.com
  Then run:  gh auth login
  Then re-run this installer.

"@ -ForegroundColor Red
  exit 1
}

$null = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host @"

  ERROR: gh is installed but not authenticated.
  Run:  gh auth login
  Then re-run this installer.

"@ -ForegroundColor Red
  exit 1
}
Write-Ok "gh CLI authenticated"

# ── 2. Prerequisites ─────────────────────────────────────────────────────────

if (-not $SkipPrereqs) {
  Write-Step "Installing prerequisites..."

  if (-not (Test-Command 'winget')) {
    Write-Host @"

  ERROR: winget is not available on this machine.
  Install Node.js manually from https://nodejs.org, then re-run with -SkipPrereqs.

"@ -ForegroundColor Red
    exit 1
  }

  # Node.js
  if (-not (Test-Command 'node')) {
    Write-Host "   Installing Node.js LTS via winget..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS.LTS --silent `
      --accept-package-agreements --accept-source-agreements
    Refresh-Path
  }
  if (-not (Test-Command 'node')) {
    Write-Host "   ERROR: Node.js install failed. Install from https://nodejs.org then re-run with -SkipPrereqs" -ForegroundColor Red
    exit 1
  }
  Write-Ok "Node.js $(node --version)"

  # Git
  if (-not (Test-Command 'git')) {
    Write-Host "   Installing Git via winget..." -ForegroundColor Yellow
    winget install --id Git.Git --silent `
      --accept-package-agreements --accept-source-agreements
    Refresh-Path
  }
  Write-Ok "Git $(git --version)"

  # PM2
  if (-not (Test-Command 'pm2')) {
    Write-Host "   Installing PM2..." -ForegroundColor Yellow
    npm install -g pm2
    Refresh-Path
  }
  Write-Ok "PM2 $(pm2 --version)"

  # Claude Code CLI
  if (-not (Test-Command 'claude')) {
    Write-Host "   Installing Claude Code CLI..." -ForegroundColor Yellow
    npm install -g @anthropic-ai/claude-code
    Refresh-Path
  }
  Write-Ok "Claude Code CLI installed"
}

# ── 3. npm install ────────────────────────────────────────────────────────────

Write-Step "Installing dashboard dependencies..."
Push-Location C:\Flint\dashboard
npm install
Pop-Location
Write-Ok "dashboard/node_modules ready"

Write-Step "Installing router dependencies..."
Push-Location C:\Flint\router
npm install
Pop-Location
Write-Ok "router/node_modules ready"

# ── 4. Start PM2 services ─────────────────────────────────────────────────────

Write-Step "Starting Flint services..."
pm2 start C:\Flint\ecosystem.config.cjs
Write-Ok "Services started (flint-dashboard on :3000, flint-router on :3001)"

Write-Step "Configuring boot persistence..."
try {
  $startupOut = (pm2 startup 2>&1) | Out-String
  if ($startupOut -match 'pm2-startup install') {
    pm2-startup install
  }
  pm2 save
  Write-Ok "Boot persistence configured (Windows Task Scheduler)"
} catch {
  Write-Warn "Could not auto-configure boot persistence."
  Write-Warn "Run 'pm2 startup' manually and follow the printed instructions."
  pm2 save
}

# ── 5. Wait for dashboard ──────────────────────────────────────────────────────

Wait-For-Dashboard

# ── 6. Configure API keys ──────────────────────────────────────────────────────

Write-Step "Configuring API keys..."
Write-Host "   Press Enter to skip any key you don't have yet." -ForegroundColor Gray
Write-Host "   Skipped keys can be added later via the API Keys tab in the dashboard." -ForegroundColor Gray
Write-Host ""

# GitHub token — required for agent PR creation
$ghToken = Read-Host "   GitHub Personal Access Token (repo scope — required for PR creation)"
if ($ghToken -and $ghToken.Trim() -ne '') {
  Post-ApiKey 'github_token' 'GITHUB_TOKEN' $ghToken.Trim()
} else {
  Write-Warn "GitHub token skipped — agent PR creation will not work until added via the API Keys tab"
}

Write-Host ""
Write-Host "   Optional LLM providers:" -ForegroundColor Gray

Prompt-Key "OpenAI API key"       'openai'      'OPENAI_API_KEY'
Prompt-Key "OpenRouter API key"   'openrouter'  'OPENROUTER_API_KEY'
Prompt-Key "Google AI API key"    'google'      'GOOGLE_API_KEY'

# Azure — three values
$azureKey = Read-Host "   Azure OpenAI key (Enter to skip)"
if ($azureKey -and $azureKey.Trim() -ne '') {
  Post-ApiKey 'azure_key' 'AZURE_OPENAI_KEY' $azureKey.Trim()
  $azureEndpoint = Read-Host "   Azure OpenAI endpoint (e.g. https://myinstance.openai.azure.com)"
  if ($azureEndpoint -and $azureEndpoint.Trim() -ne '') {
    Post-ApiKey 'azure_endpoint' 'AZURE_OPENAI_ENDPOINT' $azureEndpoint.Trim()
  }
  $azureDeployment = Read-Host "   Azure deployment name (Enter to use model name as deployment)"
  if ($azureDeployment -and $azureDeployment.Trim() -ne '') {
    Post-ApiKey 'azure_deployment' 'AZURE_OPENAI_DEPLOYMENT' $azureDeployment.Trim()
  }
}

Prompt-Key "Ollama base URL (e.g. http://localhost:11434)"  'ollama_url'    'OLLAMA_BASE_URL'
Prompt-Key "LM Studio base URL (e.g. http://localhost:1234)" 'lmstudio_url' 'LMSTUDIO_BASE_URL'

# ── 7. Verify + open ───────────────────────────────────────────────────────────

Write-Step "Verifying installation..."
try {
  $health = Invoke-RestMethod http://localhost:3000/health -ErrorAction Stop
  Write-Ok "Status: $($health.status)"
  Write-Ok "Database: $($health.db)"
} catch {
  Write-Warn "Health check returned an error: $($_.Exception.Message)"
}

Write-Step "Opening dashboard in browser..."
Start-Process "http://localhost:3000"

# ── 8. Summary ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host ("━" * 60) -ForegroundColor Cyan
Write-Host "  Flint is running at http://localhost:3000" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:"
Write-Host "    • Spawn an agent from the Agents tab"
Write-Host "    • Add remaining API keys via the API Keys tab"
Write-Host "    • Set a default agent in the Queue tab for auto-pickup"
Write-Host ""
Write-Host "  To update Flint:"
Write-Host "    cd C:\Flint && git pull && pm2 restart all"
Write-Host ("━" * 60) -ForegroundColor Cyan
```

- [ ] **Step 2: Smoke-test the helper functions**

With the dashboard already running locally, verify the two helper functions work before testing the full script:

```powershell
# Test Post-ApiKey (POST /api-keys) — run from PowerShell
$body = @{ name = 'test_key'; envVar = 'TEST_KEY'; value = 'test123' } | ConvertTo-Json
$res = Invoke-RestMethod http://localhost:3000/api-keys -Method POST -ContentType 'application/json' -Body $body
$res   # should print the saved key object

# Verify it was stored
(Invoke-RestMethod http://localhost:3000/api-keys) | Where-Object { $_.name -eq 'test_key' }
# Expected: one object with name=test_key, envVar=TEST_KEY, env_set=true

# Clean up
# (delete via dashboard API Keys tab or directly in DB)
```

Expected: POST returns `{ id, name, envVar, env_set: true }`. GET confirms it exists.

- [ ] **Step 3: Smoke-test the health poller**

```powershell
# With dashboard running, simulate what Wait-For-Dashboard does:
try {
  $health = Invoke-RestMethod http://localhost:3000/health -ErrorAction Stop
  Write-Host "Health: $($health | ConvertTo-Json)"
} catch {
  Write-Host "Failed: $_"
}
```

Expected output: `{ "status": "ok", "db": "connected" }`

- [ ] **Step 4: Test the prerequisite checks**

Run these manually to verify the guards work:

```powershell
# Test Test-Command helper
function Test-Command([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}
Test-Command 'node'    # Expected: True
Test-Command 'notreal' # Expected: False

# Test gh auth check
gh auth status 2>&1; $LASTEXITCODE  # Expected: 0 if authenticated
```

- [ ] **Step 5: Run the installer with -SkipPrereqs (fast path)**

Since this machine already has all prerequisites, run the installer skipping the winget steps. This exercises everything except winget calls:

```powershell
# Stop current PM2 first so the installer can re-start cleanly
pm2 stop all

# Run installer (skipping prereq installs since they're already present)
Set-Location C:\Flint
.\install-flint.ps1 -SkipPrereqs
```

Walk through the prompts:
- GitHub token: enter a real token (or skip if not testing PR flow)
- Other providers: press Enter to skip

Expected outcome:
- PM2 starts `flint-dashboard` and `flint-router`
- Dashboard opens in browser at `http://localhost:3000`
- Health check prints `Status: ok`, `Database: connected`
- Summary block printed

- [ ] **Step 6: Verify the install via PM2 and browser**

```powershell
pm2 ls
# Expected: flint-dashboard (online, port 3000) and flint-router (online, port 3001)

Invoke-RestMethod http://localhost:3000/health | ConvertTo-Json
# Expected: { "status": "ok", "db": "connected" }
```

Open `http://localhost:3000` in browser — Agents tab should be visible.

- [ ] **Step 7: Commit**

```powershell
git add install-flint.ps1
git commit -m "feat: add Windows installer script (install-flint.ps1)"
```

---

## Update workflow (not part of installer — just document it)

After installing, updating Flint on the machine is:

```powershell
cd C:\Flint
git pull
pm2 restart all
```

No re-running the installer. API keys are already in the database.

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

function Post-ApiKey([string]$name, [string]$label, [string]$envVar, [string]$keyValue) {
  $body = @{ name = $name; label = $label; env_var = $envVar; key_value = $keyValue } | ConvertTo-Json
  try {
    $null = Invoke-RestMethod http://localhost:3000/api-keys `
      -Method POST -ContentType 'application/json' -Body $body -ErrorAction Stop
    Write-Ok "Stored $name → $envVar"
  } catch {
    Write-Warn "Failed to store ${name}: $($_.Exception.Message)"
  }
}

function Prompt-Key([string]$prompt, [string]$name, [string]$label, [string]$envVar) {
  $val = Read-Host "   $prompt (Enter to skip)"
  if ($val -and $val.Trim() -ne '') {
    Post-ApiKey $name $label $envVar $val.Trim()
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
    if (-not (Test-Command 'git')) {
      Write-Host "   ERROR: Git install failed. Install from https://git-scm.com then re-run with -SkipPrereqs" -ForegroundColor Red
      exit 1
    }
  }
  Write-Ok "Git $(git --version)"

  # PM2
  if (-not (Test-Command 'pm2')) {
    Write-Host "   Installing PM2..." -ForegroundColor Yellow
    npm install -g pm2
    Refresh-Path
    if (-not (Test-Command 'pm2')) {
      Write-Host "   ERROR: PM2 install failed. Run: npm install -g pm2" -ForegroundColor Red
      exit 1
    }
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
  npm install -g pm2-startup --silent 2>$null
  pm2-startup install
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
  Post-ApiKey 'github-token' 'GitHub' 'GITHUB_TOKEN' $ghToken.Trim()
} else {
  Write-Warn "GitHub token skipped — agent PR creation will not work until added via the API Keys tab"
}

Write-Host ""
Write-Host "   Optional LLM providers:" -ForegroundColor Gray

Prompt-Key "OpenAI API key"       'openai'      'OpenAI'       'OPENAI_API_KEY'
Prompt-Key "OpenRouter API key"   'openrouter'  'OpenRouter'   'OPENROUTER_API_KEY'
Prompt-Key "Google AI API key"    'google'      'Google AI'    'GOOGLE_API_KEY'

# Azure — three values
$azureKey = Read-Host "   Azure OpenAI key (Enter to skip)"
if ($azureKey -and $azureKey.Trim() -ne '') {
  Post-ApiKey 'azure-key' 'Azure OpenAI Key' 'AZURE_OPENAI_KEY' $azureKey.Trim()
  $azureEndpoint = Read-Host "   Azure OpenAI endpoint (e.g. https://myinstance.openai.azure.com)"
  if ($azureEndpoint -and $azureEndpoint.Trim() -ne '') {
    Post-ApiKey 'azure-endpoint' 'Azure OpenAI Endpoint' 'AZURE_OPENAI_ENDPOINT' $azureEndpoint.Trim()
  }
  $azureDeployment = Read-Host "   Azure deployment name (Enter to use model name as deployment)"
  if ($azureDeployment -and $azureDeployment.Trim() -ne '') {
    Post-ApiKey 'azure-deployment' 'Azure OpenAI Deployment' 'AZURE_OPENAI_DEPLOYMENT' $azureDeployment.Trim()
  }
}

Prompt-Key "Ollama base URL (e.g. http://localhost:11434)"   'ollama-url'    'Ollama Base URL'    'OLLAMA_BASE_URL'
Prompt-Key "LM Studio base URL (e.g. http://localhost:1234)" 'lmstudio-url'  'LM Studio Base URL' 'LMSTUDIO_BASE_URL'

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
Write-Host "    cd C:\Flint; git pull; pm2 restart all"
Write-Host ("━" * 60) -ForegroundColor Cyan

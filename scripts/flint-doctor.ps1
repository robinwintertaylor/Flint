<#
.SYNOPSIS
    Diagnoses a Flint installation - checks every prerequisite and reports
    pass/fail with the specific fix command for anything failing.

.EXAMPLE
    .\scripts\flint-doctor.ps1
#>

$FlintRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$failures = 0

function Check-Item([string]$label, [scriptblock]$test, [string]$fixHint) {
  Write-Host -NoNewline "  $label... "
  try {
    $result = & $test
    if ($result) {
      Write-Host "OK" -ForegroundColor Green
    } else {
      Write-Host "FAIL" -ForegroundColor Red
      Write-Host "    Fix: $fixHint" -ForegroundColor Yellow
      $script:failures++
    }
  } catch {
    Write-Host "FAIL ($($_.Exception.Message))" -ForegroundColor Red
    Write-Host "    Fix: $fixHint" -ForegroundColor Yellow
    $script:failures++
  }
}

Write-Host "Flint Doctor" -ForegroundColor Cyan
Write-Host ("-" * 40)

Check-Item "Node.js" { [bool](Get-Command node -ErrorAction SilentlyContinue) } `
  "Install from https://nodejs.org or: winget install OpenJS.NodeJS.LTS"

Check-Item "Git" { [bool](Get-Command git -ErrorAction SilentlyContinue) } `
  "winget install Git.Git"

Check-Item "PM2" { [bool](Get-Command pm2 -ErrorAction SilentlyContinue) } `
  "npm install -g pm2"

Check-Item "Claude Code CLI" { [bool](Get-Command claude -ErrorAction SilentlyContinue) } `
  "npm install -g @anthropic-ai/claude-code"

Check-Item "Docker daemon responsive" {
  docker info 2>&1 | Out-Null
  $LASTEXITCODE -eq 0
} "Start Docker Desktop"

Check-Item "Forgejo API reachable" {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3030/api/v1/version' -UseBasicParsing -TimeoutSec 5
    $r.StatusCode -eq 200
  } catch { $false }
} "docker compose up -d (from $FlintRoot)"

Check-Item "forgejo.token exists and is valid" {
  $tokenPath = Join-Path $FlintRoot 'forgejo.token'
  if (-not (Test-Path $tokenPath)) { return $false }
  $token = (Get-Content $tokenPath -Raw).Trim()
  try {
    Invoke-RestMethod -Uri 'http://localhost:3030/api/v1/user' `
      -Headers @{ Authorization = "token $token" } -ErrorAction Stop | Out-Null
    $true
  } catch { $false }
} ".\scripts\forgejo-init.ps1"

Check-Item "'forgejo' git remote configured" {
  Push-Location $FlintRoot
  try {
    $remotes = git remote -v 2>&1
    $remotes -match 'forgejo'
  } finally { Pop-Location }
} ".\scripts\forgejo-init.ps1"

Check-Item "PM2 boot-persistence registry key" {
  [bool](Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'PM2' -ErrorAction SilentlyContinue)
} "pm2-startup install; pm2 save  (run as Administrator)"

Check-Item "flint-dashboard running" {
  # Note: intentionally not using `pm2 jlist | ConvertFrom-Json` here - on Windows,
  # pm2_env always contains both the native "USERNAME" env var and pm2's own
  # lowercase "username" metadata field, which ConvertFrom-Json rejects as
  # duplicate keys (case-insensitive) on both PS 5.1 and PS 7+. `pm2 describe`
  # avoids JSON parsing entirely.
  $out = (pm2 describe flint-dashboard 2>&1) -join "`n"
  $out -match 'status.*online'
} "pm2 start $FlintRoot\ecosystem.config.cjs"

Check-Item "flint-router running" {
  $out = (pm2 describe flint-router 2>&1) -join "`n"
  $out -match 'status.*online'
} "pm2 start $FlintRoot\ecosystem.config.cjs"

Check-Item "Dashboard health endpoint" {
  try {
    $h = Invoke-RestMethod -Uri 'http://localhost:3000/health' -TimeoutSec 5
    $h.status -eq 'ok'
  } catch { $false }
} "pm2 restart flint-dashboard, then check: pm2 logs flint-dashboard"

Write-Host ("-" * 40)
if ($failures -eq 0) {
  Write-Host "All checks passed." -ForegroundColor Green
} else {
  Write-Host "$failures check(s) failed - see fixes above." -ForegroundColor Red
  exit 1
}

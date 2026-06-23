<#
.SYNOPSIS
    Start a Claude Code agent in observe mode, piping output to a log file.
    The dashboard can then attach to the log file for a read-only live view.

.PARAMETER AgentName
    Name of the agent (used for the log file name and dashboard registration).

.EXAMPLE
    .\attach.ps1 research
    Then in dashboard: POST /agents/observe { name: "research", logPath: "<shown below>" }
#>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$AgentName
)

$FlintRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$LogsDir   = Join-Path $FlintRoot "logs"
$LogFile   = Join-Path $LogsDir "$AgentName.log"

if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
}

# Clear previous log so dashboard doesn't replay old output
if (Test-Path $LogFile) { Clear-Content $LogFile }

Write-Host ""
Write-Host "⚡ Flint — Observe Mode" -ForegroundColor Cyan
Write-Host "Agent   : $AgentName"
Write-Host "Log file: $LogFile"
Write-Host ""
Write-Host "Register in dashboard:" -ForegroundColor Yellow
Write-Host "  POST /agents/observe"
Write-Host "  Body: { `"name`": `"$AgentName`", `"logPath`": `"$($LogFile -replace '\\', '\\')`" }"
Write-Host ""
Write-Host "Starting Claude Code... (Ctrl+C to stop)" -ForegroundColor Green
Write-Host ""

# Start claude and tee all output (stdout + stderr) to the log file
claude --dangerously-skip-permissions 2>&1 | Tee-Object -FilePath $LogFile

<#
.SYNOPSIS
    One-time bootstrap for the local Forgejo instance.
    Run once after: docker compose up -d
    Creates admin user, generates API token, creates repo, pushes master, adds git remote.
#>

$ErrorActionPreference = 'Stop'
$FlintRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

# 1. Wait for Forgejo to be ready (up to 60s)
Write-Host "Waiting for Forgejo..." -NoNewline
$ready = $false
for ($i = 1; $i -le 60; $i++) {
    try {
        $r = Invoke-WebRequest -Uri 'http://localhost:3030/api/v1/version' -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Write-Host '.' -NoNewline
    Start-Sleep 1
}
if (-not $ready) { Write-Error "Forgejo not ready after 60s — is Docker running?"; exit 1 }
Write-Host " ready."

# 2. Create admin user (ignore if already exists)
docker exec flint-forgejo forgejo admin user create `
    --username robin `
    --password changeme123 `
    --email robin@flint.local `
    --admin 2>&1 | Out-Null
Write-Host "Admin user: robin / changeme123"

# 3. Generate API token via basic auth
$pair  = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('robin:changeme123'))
$hdr   = @{ Authorization = "Basic $pair"; 'Content-Type' = 'application/json' }
$tBody = @{ name = 'flint-dashboard' } | ConvertTo-Json
try {
    $tResp = Invoke-RestMethod -Uri 'http://localhost:3030/api/v1/user/tokens' `
        -Method Post -Headers $hdr -Body $tBody
    $token = $tResp.sha1
} catch {
    Write-Host "Token may already exist — delete it in Forgejo UI if re-running."
    exit 1
}

# 4. Save token to forgejo.token (git-ignored)
$tokenPath = Join-Path $FlintRoot 'forgejo.token'
$token | Out-File -FilePath $tokenPath -Encoding ascii -NoNewline
Write-Host "Token saved to: $tokenPath"

# 5. Create repo (ignore if already exists)
$authHdr = @{ Authorization = "token $token"; 'Content-Type' = 'application/json' }
$repoBody = @{ name = 'flint'; private = $true; auto_init = $false } | ConvertTo-Json
try {
    Invoke-RestMethod -Uri 'http://localhost:3030/api/v1/user/repos' `
        -Method Post -Headers $authHdr -Body $repoBody | Out-Null
    Write-Host "Repo 'flint' created."
} catch {
    Write-Host "Repo may already exist, continuing..."
}

# 6. Add forgejo remote and push master
Set-Location $FlintRoot
git remote remove forgejo 2>&1 | Out-Null
git remote add forgejo "http://robin:${token}@localhost:3030/robin/flint.git"
git push forgejo master
Write-Host ""
Write-Host "✓ Forgejo bootstrap complete"
Write-Host "  Web UI: http://localhost:3030"
Write-Host "  Login:  robin / changeme123"

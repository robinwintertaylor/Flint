<#
.SYNOPSIS
    One-time bootstrap for the local Forgejo instance.
    Run once after: docker compose up -d
    Creates admin user, generates API token, creates repo, pushes master, adds git remote.
    Safe to re-run: deletes and recreates the token if it already exists.

.PARAMETER AdminUser
    Username for the Forgejo admin account. Default: admin

.PARAMETER AdminPassword
    Password for the admin account. Default: changeme123  (change after first login)

.PARAMETER AdminEmail
    Email for the admin account. Default: <AdminUser>@flint.local

.EXAMPLE
    .\scripts\forgejo-init.ps1
    .\scripts\forgejo-init.ps1 -AdminUser alice -AdminPassword s3cr3t
#>
param(
    [string]$AdminUser     = 'flintadmin',
    [string]$AdminPassword = 'changeme123',
    [string]$AdminEmail    = ''
)

if (-not $AdminEmail) { $AdminEmail = "${AdminUser}@flint.local" }

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
if (-not $ready) { Write-Error "Forgejo not ready after 60s - is Docker running?"; exit 1 }
Write-Host " ready."

# 2. Create admin user (ignore if already exists)
$createOut = docker exec -u git flint-forgejo forgejo admin user create `
    --username $AdminUser `
    --password $AdminPassword `
    --email    $AdminEmail `
    --admin 2>&1
if ($LASTEXITCODE -ne 0) {
    $msg = "$createOut"
    if ($msg -match 'already exists') {
        Write-Host "Admin user already exists, continuing..."
    } else {
        Write-Error "Failed to create admin user. Output: $msg`nEnsure FORGEJO__security__INSTALL_LOCK=true is set in docker-compose.yml and Forgejo was restarted."
        exit 1
    }
}
Write-Host "Admin user: $AdminUser / $AdminPassword"

# 3. Get or generate API token
$tokenPath = Join-Path $FlintRoot 'forgejo.token'
$token = $null

# Re-use existing token if it is still valid
if (Test-Path $tokenPath) {
    $candidate = (Get-Content $tokenPath -Raw).Trim()
    try {
        Invoke-RestMethod -Uri 'http://localhost:3030/api/v1/user' `
            -Headers @{ Authorization = "token $candidate" } -ErrorAction Stop | Out-Null
        $token = $candidate
        Write-Host "Using existing valid token from forgejo.token"
    } catch {
        Write-Host "Stored token is invalid, will regenerate..."
        try {
            $tList = Invoke-RestMethod -Uri 'http://localhost:3030/api/v1/user/tokens' `
                -Headers @{ Authorization = "token $candidate" } -ErrorAction Stop
            $old = $tList | Where-Object { $_.name -eq 'flint-dashboard' }
            if ($old) {
                Invoke-RestMethod -Uri "http://localhost:3030/api/v1/user/tokens/$($old.id)" `
                    -Method Delete -Headers @{ Authorization = "token $candidate" } -ErrorAction Stop | Out-Null
                Write-Host "Deleted stale token via API."
            }
        } catch {}
    }
}

# Generate a fresh token only when we don't have a valid one
if (-not $token) {
    $tokenName  = "flint-$(Get-Date -Format 'yyyyMMddHHmmss')"
    $tokenOutput = @(docker exec -u git flint-forgejo forgejo admin user generate-access-token `
        --username $AdminUser --token-name $tokenName --raw `
        --scopes 'write:repository,write:issue,write:user,read:misc' 2>&1)
    foreach ($line in $tokenOutput) {
        $l = $line.Trim()
        if ($l -match ':\s*(\S+)$') { $token = $Matches[1] }
        elseif ($l -match '^\S{20,}$') { $token = $l }
    }
    if (-not $token) { Write-Error "Failed to generate token. Raw output: $tokenOutput"; exit 1 }
    $token | Out-File -FilePath $tokenPath -Encoding ascii -NoNewline
    Write-Host "New token saved to: $tokenPath"
}

# 4. Validate the token
try {
    $me = Invoke-RestMethod -Uri 'http://localhost:3030/api/v1/user' `
        -Headers @{ Authorization = "token $token" } -ErrorAction Stop
    Write-Host "Token valid for user: $($me.login)"
    # A reused pre-existing token may belong to a different account than the
    # requested/default -AdminUser (e.g. an earlier bootstrap ran under a
    # different username). Every subsequent step (repo lookup/creation, the
    # git remote URL) must operate as the token's actual owner, not the
    # requested default, or repo/remote paths will point at the wrong
    # namespace and pushes will 403.
    $AdminUser = $me.login
} catch {
    Write-Error "Token still invalid after regeneration: $($_.Exception.Message)"; exit 1
}

# 5. Create repo (ignore if already exists)
$authHdr  = @{ Authorization = "token $token"; 'Content-Type' = 'application/json' }
$repoBody = @{ name = 'flint'; private = $true; auto_init = $false } | ConvertTo-Json
try {
    Invoke-RestMethod -Uri 'http://localhost:3030/api/v1/user/repos' `
        -Method Post -Headers $authHdr -Body $repoBody | Out-Null
    Write-Host "Repo 'flint' created."
} catch {
    $errBody = $_.ErrorDetails.Message
    if ($errBody -match 'already exist') {
        Write-Host "Repo already exists, continuing..."
    } else {
        Write-Host "Repo creation error: $($_.Exception.Message) | $errBody"
        Write-Host "Attempting to verify repo exists..."
        try {
            Invoke-RestMethod -Uri "http://localhost:3030/api/v1/repos/${AdminUser}/flint" `
                -Headers @{ Authorization = "token $token" } -ErrorAction Stop | Out-Null
            Write-Host "Repo confirmed to exist."
        } catch {
            Write-Error "Repo does not exist and could not be created. Check Forgejo permissions."; exit 1
        }
    }
}

# 6. Add forgejo remote and push current branch as master
Set-Location $FlintRoot
try { git remote remove forgejo 2>&1 | Out-Null } catch {}
git remote add forgejo "http://${AdminUser}:${token}@localhost:3030/${AdminUser}/flint.git"
git push forgejo HEAD:master
Write-Host ""
Write-Host "Forgejo bootstrap complete"
Write-Host "  Web UI:   http://localhost:3030"
Write-Host "  Login:    $AdminUser / $AdminPassword"
Write-Host "  IMPORTANT: Change your password at http://localhost:3030/user/settings/account"

# Installer Automation & Documentation Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One run of `install-flint.ps1` on a bare Windows machine produces a fully working Flint instance — Docker Desktop and Forgejo included — with no README steps required, plus a re-runnable health-check script and docs that match the current feature set.

**Architecture:** Extend the existing idempotent prerequisite-checking pattern in `install-flint.ps1` with Docker Desktop detection/install and an inlined call to the existing `forgejo-init.ps1` bootstrap script. Add a standalone `scripts/flint-doctor.ps1` for post-install diagnosis. Fix a confirmed real bug (wrong npm package name) and a confirmed factual error in the admin manual (wrong boot-persistence mechanism). Refresh README/user-manual/admin-manual against the actual current install flow and feature set.

**Tech Stack:** PowerShell 5.1+ (matching existing `install-flint.ps1`/`forgejo-init.ps1`), Node.js `node:test` for the one JS-side task (Task 5).

## Global Constraints

- Every new installer step must be idempotent: safe to re-run after a partial failure without redoing completed work or erroring on things that already exist (spec: "Goals").
- The installer must never attempt to orchestrate a reboot itself — if Docker Desktop needs a restart to finish enabling virtualization features, print a clear, distinct message and exit non-zero; the user reboots and re-runs manually (spec: "Non-goals").
- `pm2-windows-startup` is the correct npm package name; its installed CLI command is named `pm2-startup` (confirmed via `npm view pm2-windows-startup bin` → `{ 'pm2-startup': 'index.js' }`). There is no npm package literally named `pm2-startup` (confirmed 404 on the registry) — the current installer's `npm install -g pm2-startup` is a real, reproducible bug.
- PM2 boot persistence uses a Registry Run key (`HKCU:\Software\Microsoft\Windows\CurrentVersion\Run`, value name `PM2`), not Windows Task Scheduler — confirmed directly via `Get-ItemProperty` earlier this session. The admin manual's current claim ("registers PM2 in Windows Task Scheduler") is factually wrong and must be corrected, not just left as-is.
- No automated test framework exists for `install-flint.ps1`/`forgejo-init.ps1`/`flint-doctor.ps1` and this plan doesn't introduce one — verification for PowerShell tasks is manual: syntax-check the script, then actually run it on this machine (which already has every prerequisite installed) to prove the new idempotent-skip paths work without side effects, per the spec's "Testing" section.
- `forgejo-init.ps1` already contains its own wait-for-Forgejo-ready polling (up to 60s) and its own idempotent "ignore if already exists" handling for the admin user and repo — the installer must call it, not duplicate its logic.

---

### Task 1: Fix the `pm2-startup` package name bug and verify boot-persistence registration

**Files:**
- Modify: `install-flint.ps1` (the "Configuring boot persistence" block, and the "Prerequisites" block's PM2 install line if it has the same issue — check both)

**Interfaces:** None — this task doesn't produce anything later tasks consume.

- [ ] **Step 1: Locate and confirm the exact current bug**

Run: `grep -n "pm2-startup\|pm2-windows-startup" "install-flint.ps1"`

Expected output includes a line like:
```
npm install -g pm2-startup --silent 2>$null
```
This is wrong — `pm2-startup` is not a real npm package (confirmed: `npm view pm2-startup` returns a 404). The correct package is `pm2-windows-startup`; its installed CLI command is separately named `pm2-startup` (confirmed: `npm view pm2-windows-startup bin` returns `{ 'pm2-startup': 'index.js' }`), so the *later* line that runs `pm2-startup install` is already correct and must not be changed.

- [ ] **Step 2: Fix the package name**

Change:
```powershell
  npm install -g pm2-startup --silent 2>$null
  pm2-startup install
```
to:
```powershell
  npm install -g pm2-windows-startup --silent 2>$null
  pm2-startup install
```

- [ ] **Step 3: Add explicit boot-persistence verification**

Find the existing "Configuring boot persistence..." block:
```powershell
Write-Step "Configuring boot persistence..."
try {
  npm install -g pm2-windows-startup --silent 2>$null
  pm2-startup install
  pm2 save
  Write-Ok "Boot persistence configured (Windows Task Scheduler)"
} catch {
  Write-Warn "Could not auto-configure boot persistence."
  Write-Warn "Run 'pm2 startup' manually and follow the printed instructions."
  pm2 save
}
```
Replace the whole block with one that verifies the Registry Run key actually exists afterward, and corrects the "Windows Task Scheduler" claim in the success message:
```powershell
Write-Step "Configuring boot persistence..."
try {
  npm install -g pm2-windows-startup --silent 2>$null
  pm2-startup install
  pm2 save
} catch {
  Write-Warn "Could not auto-configure boot persistence."
  Write-Warn "Run 'pm2-startup install' manually and follow the printed instructions."
  pm2 save
}

$pm2RunKey = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'PM2' -ErrorAction SilentlyContinue
if ($pm2RunKey) {
  Write-Ok "Boot persistence configured (Windows startup registry entry)"
} else {
  Write-Warn "Boot persistence registry entry not found after setup."
  Write-Warn "Run 'pm2-startup install' manually as Administrator, then 'pm2 save'."
}
```

- [ ] **Step 4: Verify the fix — syntax check**

Run: `powershell -NoProfile -Command "$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content 'install-flint.ps1' -Raw), [ref]$null); Write-Host 'Syntax OK'"`
Expected: `Syntax OK` with no errors printed.

- [ ] **Step 5: Verify the fix — real run on this machine**

This machine already has `pm2-windows-startup` installed and the Registry Run key already present (confirmed earlier this session), so re-running this block is a genuine idempotency test — it should detect everything is already correct and report success without erroring.

Run (from an elevated PowerShell, from the Flint root):
```powershell
.\install-flint.ps1 -SkipPrereqs
```
Expected: the script reaches the "Configuring boot persistence..." step and prints `Boot persistence configured (Windows startup registry entry)` — not a `pm2-startup` 404/install error, and not the "not found" warning branch.

- [ ] **Step 6: Commit**

```bash
git add install-flint.ps1
git commit -m "fix(installer): correct pm2-windows-startup package name, verify boot-persistence registry key"
```

---

### Task 2: Docker Desktop check, install, launch, and readiness poll

**Files:**
- Modify: `install-flint.ps1` (new block in the "Prerequisites" section, after the existing Claude Code CLI check and before the "npm install" section)

**Interfaces:**
- Produces: a PowerShell variable `$dockerReady` (boolean) set by the end of this task's block, consumed by Task 3 to decide whether to proceed with the Forgejo bootstrap call.

- [ ] **Step 1: Add the Docker Desktop check/install block**

Locate this existing block in `install-flint.ps1` (the end of the `if (-not $SkipPrereqs) { ... }` prerequisites section, right after the Claude Code CLI check and its closing brace):
```powershell
  # Claude Code CLI
  if (-not (Test-Command 'claude')) {
    Write-Host "   Installing Claude Code CLI..." -ForegroundColor Yellow
    npm install -g @anthropic-ai/claude-code
    Refresh-Path
    if (-not (Test-Command 'claude')) {
      Write-Host "   ERROR: Claude Code CLI install failed. Run: npm install -g @anthropic-ai/claude-code" -ForegroundColor Red
      exit 1
    }
  }
  Write-Ok "Claude Code CLI installed"
}
```

Immediately after that closing `}` (still inside the `if (-not $SkipPrereqs)` block being closed — insert *before* that closing brace, as a new step within prerequisites), add:

```powershell
  # Docker Desktop (for Forgejo)
  $dockerFreshInstall = $false
  if (-not (Test-Command 'docker')) {
    Write-Host "   Installing Docker Desktop via winget..." -ForegroundColor Yellow
    winget install --id Docker.DockerDesktop --silent `
      --accept-package-agreements --accept-source-agreements
    Refresh-Path
    $dockerFreshInstall = $true
    if (-not (Test-Command 'docker')) {
      Write-Host "   ERROR: Docker Desktop install failed. Install manually from https://www.docker.com/products/docker-desktop/ then re-run with -SkipPrereqs" -ForegroundColor Red
      exit 1
    }
  }
  Write-Ok "Docker CLI present"
```

- [ ] **Step 2: Add the daemon-readiness poll with the reboot-required distinction**

Add this function near the other helper functions at the top of the file (alongside `Write-Step`, `Write-Ok`, `Write-Warn`, `Test-Command`, `Refresh-Path`):

```powershell
function Wait-For-Docker([bool]$freshInstall) {
  Write-Step "Waiting for Docker Desktop to be ready..."
  $dockerDesktopExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dockerDesktopExe) {
    Start-Process $dockerDesktopExe -ErrorAction SilentlyContinue
  }
  for ($i = 1; $i -le 60; $i++) {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "Docker is ready"
      return $true
    }
    Start-Sleep -Seconds 2
  }
  Write-Host ""
  if ($freshInstall) {
    Write-Host "  Docker Desktop was just installed and needs a restart to finish" -ForegroundColor Red
    Write-Host "  enabling virtualization features (WSL2/Hyper-V)." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Restart your PC, then re-run:  .\install-flint.ps1" -ForegroundColor Red
    Write-Host "  It will pick up where it left off." -ForegroundColor Red
  } else {
    Write-Host "  Docker Desktop did not become ready after 2 minutes." -ForegroundColor Red
    Write-Host "  Start Docker Desktop manually and re-run this installer." -ForegroundColor Red
  }
  exit 1
}
```

Then, right after the `Write-Ok "Docker CLI present"` line added in Step 1, add:
```powershell
  $dockerReady = Wait-For-Docker -freshInstall $dockerFreshInstall
```

- [ ] **Step 3: Verify the fix — syntax check**

Run: `powershell -NoProfile -Command "$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content 'install-flint.ps1' -Raw), [ref]$null); Write-Host 'Syntax OK'"`
Expected: `Syntax OK` with no errors.

- [ ] **Step 4: Verify — real run on this machine**

This machine already has Docker Desktop installed and running (confirmed earlier this session), so this exercises the "already present, already ready" idempotent path.

Run (from an elevated PowerShell, from the Flint root):
```powershell
.\install-flint.ps1 -SkipPrereqs
```
Expected: script prints `Docker CLI present` then, within a few seconds, `Docker is ready` — it must NOT attempt a `winget install` (since `-SkipPrereqs` is passed the whole prerequisites block is skipped entirely; re-run **without** `-SkipPrereqs` once to confirm the Docker-specific checks inside that block also correctly no-op when Docker is already installed and running, without reinstalling it).

- [ ] **Step 5: Commit**

```bash
git add install-flint.ps1
git commit -m "feat(installer): auto-install and wait for Docker Desktop, detect reboot-required case"
```

---

### Task 3: Inline the Forgejo bootstrap call

**Files:**
- Modify: `install-flint.ps1` (new step after the existing "npm install dependencies" section, before "Starting Flint services")

**Interfaces:**
- Consumes: `$dockerReady` (from Task 2).

- [ ] **Step 1: Add the Forgejo bootstrap step**

Locate the existing block in `install-flint.ps1`:
```powershell
# ── 4. Start PM2 services ─────────────────────────────────────────────────────

Write-Step "Starting Flint services..."
pm2 start C:\Flint\ecosystem.config.cjs
```

Insert a new numbered section immediately *before* it:
```powershell
# ── 3b. Start Forgejo ──────────────────────────────────────────────────────────

if ($dockerReady) {
  Write-Step "Starting Forgejo (self-hosted Git)..."
  docker compose up -d
  Write-Step "Bootstrapping Forgejo (admin user, token, repo, remote)..."
  & "$PSScriptRoot\scripts\forgejo-init.ps1"
} else {
  Write-Warn "Skipping Forgejo setup — Docker was not ready."
}
```

- [ ] **Step 2: Verify the fix — syntax check**

Run: `powershell -NoProfile -Command "$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content 'install-flint.ps1' -Raw), [ref]$null); Write-Host 'Syntax OK'"`
Expected: `Syntax OK` with no errors.

- [ ] **Step 3: Verify — real run on this machine**

This machine already has Forgejo running with the admin user, token, and repo already bootstrapped (confirmed earlier this session), so this is a genuine idempotency test of `forgejo-init.ps1`'s own "ignore if already exists" logic, now invoked automatically.

Run (from an elevated PowerShell, from the Flint root):
```powershell
.\install-flint.ps1 -SkipPrereqs
```
Expected: script reaches `Starting Forgejo (self-hosted Git)...`, runs `docker compose up -d` (reports containers already running/up-to-date, not recreated), then `Bootstrapping Forgejo...` reports `Admin user already exists, continuing...`, `Using existing valid token from forgejo.token`, and `Repo already exists, continuing...` — it must NOT create a duplicate repo, duplicate admin user, or overwrite a currently-valid `forgejo.token`.

- [ ] **Step 4: Commit**

```bash
git add install-flint.ps1
git commit -m "feat(installer): automatically bootstrap Forgejo as part of install"
```

---

### Task 4: `scripts/flint-doctor.ps1` — standalone health-check script

**Files:**
- Create: `scripts/flint-doctor.ps1`

**Interfaces:** None — standalone, user-invoked script.

- [ ] **Step 1: Write the script**

Create `scripts/flint-doctor.ps1`:

```powershell
<#
.SYNOPSIS
    Diagnoses a Flint installation — checks every prerequisite and reports
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
Write-Host ("─" * 40)

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
  $list = pm2 jlist 2>&1 | ConvertFrom-Json
  ($list | Where-Object { $_.name -eq 'flint-dashboard' }).pm2_env.status -eq 'online'
} "pm2 start $FlintRoot\ecosystem.config.cjs"

Check-Item "flint-router running" {
  $list = pm2 jlist 2>&1 | ConvertFrom-Json
  ($list | Where-Object { $_.name -eq 'flint-router' }).pm2_env.status -eq 'online'
} "pm2 start $FlintRoot\ecosystem.config.cjs"

Check-Item "Dashboard health endpoint" {
  try {
    $h = Invoke-RestMethod -Uri 'http://localhost:3000/health' -TimeoutSec 5
    $h.status -eq 'ok'
  } catch { $false }
} "pm2 restart flint-dashboard, then check: pm2 logs flint-dashboard"

Write-Host ("─" * 40)
if ($failures -eq 0) {
  Write-Host "All checks passed." -ForegroundColor Green
} else {
  Write-Host "$failures check(s) failed — see fixes above." -ForegroundColor Red
  exit 1
}
```

- [ ] **Step 2: Verify the fix — syntax check**

Run: `powershell -NoProfile -Command "$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content 'scripts\flint-doctor.ps1' -Raw), [ref]$null); Write-Host 'Syntax OK'"`
Expected: `Syntax OK` with no errors.

- [ ] **Step 3: Verify — real run on this machine (all-pass case)**

This machine currently has everything working (confirmed earlier this session).

Run (from the Flint root):
```powershell
.\scripts\flint-doctor.ps1
```
Expected: every check prints `OK`, final line is `All checks passed.`, exit code 0.

- [ ] **Step 4: Verify — deliberately break one check, confirm it's reported accurately**

Run:
```powershell
Rename-Item forgejo.token forgejo.token.bak
.\scripts\flint-doctor.ps1
Rename-Item forgejo.token.bak forgejo.token
```
Expected: the `forgejo.token exists and is valid` check prints `FAIL` with the fix hint `.\scripts\forgejo-init.ps1`, every other check still prints `OK`, final line is `1 check(s) failed — see fixes above.`, exit code 1. Then confirm the rename-back restored the original file (the script itself must not have been left broken by this test).

- [ ] **Step 5: Commit**

```bash
git add scripts/flint-doctor.ps1
git commit -m "feat(installer): add flint-doctor.ps1 standalone health-check script"
```

---

### Task 5: `pm2 save` after `applyAuditReport`'s PM2 restart

**Files:**
- Modify: `dashboard/modelAudit.js:74-112` (`applyAuditReport`)
- Test: `dashboard/tests/modelAudit.test.js`

**Interfaces:**
- Produces: `applyAuditReport(reportId, { execFn } = {})` — `execFn` defaults to the real `execSync`, injectable for tests. Return shape (`{ applied, restartFailed }`) is unchanged.

Note: the design spec describes this fix as targeting "the dashboard's API-key-save flow" — that was inaccurate. There is no programmatic PM2 restart tied to saving API keys (the README documents restarting `flint-router` after adding keys as a manual step). The actual, and only, programmatic `pm2 restart` in the codebase is here, in `applyAuditReport` (`dashboard/modelAudit.js:107`), which restarts `flint-dashboard` after applying approved model-audit changes. This task targets that real call site.

- [ ] **Step 1: Write the failing test**

Add to `dashboard/tests/modelAudit.test.js`, near the existing `applyAuditReport` test:

```js
test('applyAuditReport calls pm2 save after a successful restart', () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review',
    summary: 'test',
    items: [{ scope: 'specialist', target: 'specialist:researcher', label: 'Researcher model', current_value: 'gpt-4o-mini', recommended_value: 'moonshotai/kimi-k2', rationale: 'Better research', evidence: [] }],
  });
  const { items } = getAuditReport(id);
  updateAuditItem(items[0].id, 'approved');

  const calls = [];
  const fakeExecFn = (cmd) => { calls.push(cmd); };
  applyAuditReport(id, { execFn: fakeExecFn });

  assert.deepEqual(calls, ['pm2 restart flint-dashboard', 'pm2 save']);
});

test('applyAuditReport still returns restartFailed:true and does not call pm2 save if restart throws', () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review',
    summary: 'test',
    items: [{ scope: 'specialist', target: 'specialist:researcher', label: 'Researcher model', current_value: 'gpt-4o-mini', recommended_value: 'moonshotai/kimi-k2', rationale: 'Better research', evidence: [] }],
  });
  const { items } = getAuditReport(id);
  updateAuditItem(items[0].id, 'approved');

  const calls = [];
  const fakeExecFn = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('restart')) throw new Error('pm2 not running');
  };
  const result = applyAuditReport(id, { execFn: fakeExecFn });

  assert.equal(result.restartFailed, true);
  assert.deepEqual(calls, ['pm2 restart flint-dashboard']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && node --test tests/modelAudit.test.js`
Expected: FAIL — `applyAuditReport` doesn't accept a second `{ execFn }` argument yet, so `calls` stays empty (the real `execSync` runs instead, guarded by `FLINT_TEST_MODE` — check this test file already sets `FLINT_TEST_MODE=1`, meaning the CURRENT code's `if (process.env.FLINT_TEST_MODE !== '1')` guard already skips the real command entirely, so `calls` will be `[]` in both new tests, not matching the expected arrays).

- [ ] **Step 3: Implement**

In `dashboard/modelAudit.js`, change:
```js
export function applyAuditReport(reportId) {
```
to:
```js
export function applyAuditReport(reportId, { execFn = execSync } = {}) {
```

Then change:
```js
  let restartFailed = false;
  if (process.env.FLINT_TEST_MODE !== '1') {
    try { execSync('pm2 restart flint-dashboard', { stdio: 'ignore' }); }
    catch { restartFailed = true; }
  }

  return { applied: items.length, restartFailed };
```
to:
```js
  let restartFailed = false;
  if (process.env.FLINT_TEST_MODE !== '1') {
    try {
      execFn('pm2 restart flint-dashboard', { stdio: 'ignore' });
      execFn('pm2 save', { stdio: 'ignore' });
    } catch { restartFailed = true; }
  }

  return { applied: items.length, restartFailed };
```

Note: this changes the guard so `FLINT_TEST_MODE=1` still skips both real commands entirely (preserving existing behavior for every OTHER existing test in this file), but the two NEW tests above need to run with the real command path exercised via injection. Add `delete process.env.FLINT_TEST_MODE;` before each new test's `applyAuditReport(...)` call and restore it after, following the same try/finally pattern already used elsewhere in this codebase for tests that need to bypass a `FLINT_TEST_MODE` guard (e.g. `dashboard/tests/orchestrator.test.js`'s `createOrchestration creates and stores a branch...` test). Update both new tests accordingly:

```js
test('applyAuditReport calls pm2 save after a successful restart', () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review',
    summary: 'test',
    items: [{ scope: 'specialist', target: 'specialist:researcher', label: 'Researcher model', current_value: 'gpt-4o-mini', recommended_value: 'moonshotai/kimi-k2', rationale: 'Better research', evidence: [] }],
  });
  const { items } = getAuditReport(id);
  updateAuditItem(items[0].id, 'approved');

  const calls = [];
  const fakeExecFn = (cmd) => { calls.push(cmd); };

  const prevTestMode = process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_TEST_MODE;
  try {
    applyAuditReport(id, { execFn: fakeExecFn });
  } finally {
    if (prevTestMode !== undefined) process.env.FLINT_TEST_MODE = prevTestMode;
  }

  assert.deepEqual(calls, ['pm2 restart flint-dashboard', 'pm2 save']);
});

test('applyAuditReport still returns restartFailed:true and does not call pm2 save if restart throws', () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review',
    summary: 'test',
    items: [{ scope: 'specialist', target: 'specialist:researcher', label: 'Researcher model', current_value: 'gpt-4o-mini', recommended_value: 'moonshotai/kimi-k2', rationale: 'Better research', evidence: [] }],
  });
  const { items } = getAuditReport(id);
  updateAuditItem(items[0].id, 'approved');

  const calls = [];
  const fakeExecFn = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('restart')) throw new Error('pm2 not running');
  };

  const prevTestMode = process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_TEST_MODE;
  let result;
  try {
    result = applyAuditReport(id, { execFn: fakeExecFn });
  } finally {
    if (prevTestMode !== undefined) process.env.FLINT_TEST_MODE = prevTestMode;
  }

  assert.equal(result.restartFailed, true);
  assert.deepEqual(calls, ['pm2 restart flint-dashboard']);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && node --test tests/modelAudit.test.js`
Expected: all tests PASS, including the two new ones and every pre-existing test in this file (the `execFn = execSync` default plus the still-present `FLINT_TEST_MODE` guard means every OTHER test in this file — which don't inject `execFn` and don't touch `FLINT_TEST_MODE` — behaves exactly as before).

- [ ] **Step 5: Commit**

```bash
git add dashboard/modelAudit.js dashboard/tests/modelAudit.test.js
git commit -m "fix(model-audit): save PM2 process list after applying audit changes, prevent stale dump.pm2"
```

---

### Task 6: Update `README.md`

**Files:**
- Modify: `README.md`

**Interfaces:** None.

- [ ] **Step 1: Simplify "First-Time Setup"**

Replace the current `## First-Time Setup` section (steps 1-6, from "Clone and install dependencies" through "Verify") with:

```markdown
## First-Time Setup

```powershell
git clone <your-repo-url> "C:\Flint"
cd "C:\Flint"
.\install-flint.ps1
```

That's it — the installer detects and installs everything it needs (Node.js,
Git, PM2, Claude Code CLI, Docker Desktop, Forgejo), bootstraps Forgejo,
starts the full stack, configures it to survive a reboot, and prompts for
your API keys.

If Docker Desktop was just installed for the first time, your PC may need a
restart to finish enabling virtualization features — the installer will tell
you clearly if this happens. Just restart and re-run `.\install-flint.ps1`;
it picks up where it left off.

Run `.\scripts\flint-doctor.ps1` anytime to check the health of an existing
install.

### Advanced / manual setup

If you'd rather run each step yourself (or are repairing a partially broken
install), see [`docs/admin-manual.md`](docs/admin-manual.md#installation) for
the full manual walkthrough.
```

- [ ] **Step 2: Reframe "Prerequisites"**

Change the section heading and lead-in from:
```markdown
## Prerequisites

- **PowerShell** — run all commands below in **PowerShell** (not cmd.exe)
- **Node.js LTS** — `winget install OpenJS.NodeJS.LTS` *(v20, v22, or v24 all work)*
```
to:
```markdown
## Prerequisites

`install-flint.ps1` installs all of these automatically if they're missing —
this list is for reference, not something you need to do yourself first.

- **PowerShell** — run all commands below in **PowerShell** (not cmd.exe)
- **Node.js LTS** *(v20, v22, or v24 all work)*
```
Leave the rest of the existing bullet list (Windows Build Tools, Git, Docker
Desktop, PM2, Claude Code CLI) unchanged — only the heading/lead-in changes,
since the individual bullets are still accurate reference material.

- [ ] **Step 3: Verify**

Read the whole file after editing (`cat README.md` or open it) and confirm:
- No broken markdown (headers, code fences all still balanced).
- No leftover reference to the old numbered manual steps 1-6 outside the new "Advanced / manual setup" link.
- The link `docs/admin-manual.md#installation` matches the actual heading slug in the admin manual after Task 7's edits (re-check once Task 7 is done, since its heading text changes there too).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: simplify README setup instructions to match fully-automated installer"
```

---

### Task 7: Update `docs/admin-manual.md`

**Files:**
- Modify: `docs/admin-manual.md`

**Interfaces:** None.

- [ ] **Step 1: Simplify the "Installation" section**

Replace the `## Installation` section's steps 1-8 (from "Clone and install" through "Verify health") with a summary of the automated flow plus the individual steps kept as sub-headings for manual/repair use — i.e., keep every existing sub-section's *content* (the actual commands are still valid and useful for manual repair), but add a new lead-in paragraph immediately after the `## Installation` heading:

```markdown
## Installation

The fastest path is the automated installer — see the
[README](../README.md#first-time-setup). It performs every step below
automatically, in order, and is safe to re-run if interrupted (e.g. by a
required reboot after installing Docker Desktop).

The steps below are for manual setup or repairing a specific part of a
broken install.
```

- [ ] **Step 2: Fix "Persist across reboots"**

Replace the current section:
```markdown
### 6. Persist across reboots

```powershell
npm install -g pm2-windows-startup   # one-time: installs the Windows startup helper
pm2-windows-startup install          # registers PM2 in Windows Task Scheduler
pm2 save                             # saves the current process list
```

> `pm2 startup` (the built-in command) targets Linux init systems and fails on Windows with "Init system not found". Use `pm2-windows-startup` instead.
```
with:
```markdown
### 6. Persist across reboots

```powershell
npm install -g pm2-windows-startup   # one-time: installs the Windows startup helper
pm2-startup install                  # registers a Windows startup registry entry
pm2 save                             # saves the current process list
```

> `pm2 startup` (the built-in command) targets Linux init systems and fails on Windows with "Init system not found". Use `pm2-windows-startup` instead — note the package name (`pm2-windows-startup`) and the command it installs (`pm2-startup`) differ.
>
> This registers a value named `PM2` under
> `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run` that runs an
> invisible script calling `pm2 resurrect` at login — **not** a Windows
> Task Scheduler task, despite what older versions of this doc said. Verify
> it's present with:
> ```powershell
> Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name PM2
> ```
>
> **Keep `pm2 save` current.** The saved process list only reflects PM2's
> state at the moment you last ran `pm2 save` — if you later add, remove, or
> restart processes and don't re-save, a reboot resurrects the *stale*
> snapshot. Flint's own model-audit apply flow re-saves automatically after
> restarting the dashboard; if you manually run `pm2 restart`/`pm2 start`/`pm2 delete`
> for any other reason, run `pm2 save` again afterward.
```

- [ ] **Step 3: Add the Model Audit section**

Add a new `##` section after the existing `## Heartbeat Orchestrator` section (before `## Specialists — File Layout`):

```markdown
## Model Audit

A weekly cron job (`.cron/schedule.json`, Sunday 09:00) triggers
`POST /model-audit/trigger`, which spawns an agent to compare Flint's
current model configuration (`router.json`, specialist `preferred_model`
values) against current OpenRouter pricing/capability data, and submits
structured recommendations via `POST /model-audit/reports/:id/submit`.

Reports live in two tables: `model_audit_reports` (one row per run, with a
`status` of `running` → `pending_review` → `applied`/`dismissed`, or
`no_change` if nothing needs changing) and `model_audit_items` (one row per
recommended change, each independently `pending`/`approved`/`rejected`).

Review recommendations in the dashboard's **🔍 Audit** tab — approve or
reject each item, then **Apply Approved** to write changes to `router.json`
and/or the specialists table and restart `flint-dashboard`. The apply step
also re-runs `pm2 save` afterward so the restarted process list survives a
future reboot.

REST routes:
```powershell
POST   /model-audit/trigger              # manually trigger a run
GET    /model-audit/reports              # list all reports
GET    /model-audit/reports/:id          # one report + its items
POST   /model-audit/reports/:id/submit   # agent submits recommendations (internal)
PATCH  /model-audit/items/:id            # approve/reject one item
POST   /model-audit/reports/:id/apply    # write approved changes, restart dashboard
DELETE /model-audit/reports/:id          # dismiss a report
```
```

- [ ] **Step 4: Add the Project Git Integration section**

Add a new `##` section right after the new Model Audit section:

```markdown
## Project Git Integration

Project-linked orchestrations get a real git lifecycle. When a project is
launched, Flint checks its workspace: if it's already a git repo with a
remote (Forgejo or GitHub), nothing changes; if it's blank, Flint creates a
matching repo in Forgejo, `git init`s the workspace, and pushes an initial
commit. If Forgejo is unreachable at that moment, the workspace is still
git-initialized locally with no remote — nothing blocks the launch — and the
remote gets attached automatically on the next launch, or on demand via
`POST /projects/:id/sync-repo`.

Each orchestration run gets its own branch. Every completed, project-linked
queue task is committed individually. When the orchestrator finishes (it
calls `POST /orchestrations/:id/complete`), Flint pushes that branch and
opens a pull request — routed to GitHub or Forgejo automatically depending
on which remote the project's workspace actually uses.

The `orchestrations` table's `pr_status` column reflects what happened:

| `pr_status` | Meaning |
|---|---|
| `open` | PR successfully opened |
| `merged` / `closed` | PR lifecycle, polled every 30s |
| `no_remote` | Completed, but the workspace has no remote yet (Forgejo was unreachable when it needed one) — resolves itself on the next sync |
| `failed` | A remote existed but the push or PR-creation API call itself errored — check `pm2 logs flint-dashboard` |

REST routes:
```powershell
POST /orchestrations/:id/complete   # push branch + open PR (called by the orchestrator agent)
POST /projects/:id/sync-repo        # retry attaching a remote + any pending no_remote PRs
```
```

- [ ] **Step 5: Add the `flint-doctor.ps1` troubleshooting entry**

Add a new subsection under the existing `## Troubleshooting` heading (check the exact current sub-heading style in that section first — match it):

```markdown
### Quick health check

```powershell
.\scripts\flint-doctor.ps1
```

Checks Node/Git/PM2/Claude CLI, Docker, Forgejo reachability and token
validity, the `forgejo` git remote, PM2 boot-persistence registration, both
PM2 processes' status, and the dashboard health endpoint — one command
instead of checking each manually.
```

- [ ] **Step 6: Verify**

Read the whole file after editing and confirm:
- No broken markdown (headers, code fences balanced).
- Table of contents / heading levels stay consistent with the rest of the file's existing style (`##` for top-level sections, `###` for subsections — match what's already there).
- The `../README.md#first-time-setup` link added in Step 1 resolves to the actual heading slug README.md ends up with after Task 6.

- [ ] **Step 7: Commit**

```bash
git add docs/admin-manual.md
git commit -m "docs: refresh admin manual — automated install, correct PM2 boot mechanism, Model Audit, Project Git Integration, flint-doctor"
```

---

### Task 8: Update `docs/user-manual.md`

**Files:**
- Modify: `docs/user-manual.md`

**Interfaces:** None.

- [ ] **Step 1: Rewrite the "Projects" section**

Replace the current section:
```markdown
## Projects

Projects group agents and track shared costs.

1. Click **Projects** in the header nav.
2. Click **+ New Project**, give it a name and notes.
3. Link agents to the project from the project card's **Link agent** dropdown.
4. Optionally upload reference documents (PDF, text) the agents can read.

The project card shows cost broken down by agent and a rolling session summary from each agent's last exit.
```
with:
```markdown
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
and the remote/PR catches up automatically the next time you launch, or you
can trigger it directly from the project card.
```

- [ ] **Step 2: Verify**

Read the whole file after editing and confirm no broken markdown, and that the new "Projects" section's terminology (Goal, Launch, workspace, orchestrator, scratchpad) matches what's actually in the current dashboard UI — spot-check against `dashboard/public/index.html`/`dashboard/public/app.js`'s project-card markup and labels (e.g. confirm the button is actually labeled "Launch", the field is actually labeled "Goal") rather than assuming the plan's wording is exactly what's on screen.

- [ ] **Step 3: Commit**

```bash
git add docs/user-manual.md
git commit -m "docs: rewrite Projects section to cover orchestration and project git integration"
```

---

## Post-implementation manual check

After all 8 tasks are committed:

1. Read through `README.md` → `docs/admin-manual.md` → `docs/user-manual.md` once, start to finish, as a brand-new user would, and confirm the story is consistent (no leftover references to steps that no longer exist, no contradictions between what the README promises and what the admin manual details).
2. If a genuinely fresh Windows VM is available, run `install-flint.ps1` on it end-to-end as the real, ultimate test of Task 1-3's automation (the per-task "real run on this machine" steps above only prove idempotency on an already-set-up machine, not a true first-run).

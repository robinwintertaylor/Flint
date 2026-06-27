# Flint E2E System Runbook

**Stack:** Dashboard :3000 · Router :3001 · Forgejo :3030 · Ollama (local)
**Run automated tests:** `node --test dashboard/tests/e2e.test.js`
**Full mode (spawns real agents):** `E2E_FULL=1 node --test dashboard/tests/e2e.test.js`
**Test data prefix:** All created resources use `e2e-test-` prefix for easy cleanup.

**NOT configured (skip):** Telegram · LM Studio · GitHub
**E2E_FULL=1 gated:** S5 (real agent spawn) · S16 (Forgejo PR flow)

Each section lists: Goal · Preconditions · Steps · Expected · Pass/Fail

---

## S1 — Health & Service Reachability

**Goal:** Confirm all three processes (dashboard, router, Forgejo) are up and returning healthy status.

**Preconditions:** Dashboard (`pm2 restart flint-dashboard`), router, and Forgejo Docker container all started before running this section.

**Steps:**
```powershell
# Dashboard health
Invoke-RestMethod http://localhost:3000/health | ConvertTo-Json -Depth 5

# Router health
Invoke-RestMethod http://localhost:3001/health | ConvertTo-Json -Depth 5

# Forgejo reachability (HEAD request)
try {
  $r = Invoke-WebRequest http://localhost:3030 -Method Head -UseBasicParsing
  Write-Output "Forgejo HTTP $($r.StatusCode)"
} catch {
  Write-Output "Forgejo UNREACHABLE: $_"
}
```

**Expected:**
- Dashboard `/health` → `{ "status": "ok", "db": "connected", "forgejo": "reachable", "ollama": "reachable", "lmstudio": "unreachable" }`
- Router `/health` → `{ "status": "ok" }`
- Forgejo HEAD → HTTP 200

**Pass:** All three return expected responses with `status: "ok"` and `db: "connected"`.
**Fail:** Any service returns non-200, `db` field is not `"connected"`, or `forgejo`/`ollama` fields are `"unreachable"`.

---

## S2 — Router / LLM Routing

**Goal:** Model router resolves providers correctly and can complete a prompt via OpenRouter.

**Preconditions:** S1 passed. OpenRouter API key stored in DB (verified in S3).

**Steps:**
```powershell
# List available models by provider
Invoke-RestMethod http://localhost:3001/llm/models | ConvertTo-Json -Depth 5

# Get routing config (tiers, provider priority)
Invoke-RestMethod http://localhost:3001/llm/config | ConvertTo-Json -Depth 5

# Check dashboard proxy for models (if route exists)
Invoke-RestMethod http://localhost:3000/router/models | ConvertTo-Json -Depth 5

# Send a completion request via dashboard proxy
$body = @{
  taskType = "general"
  prompt   = "Reply with the single word: hello"
} | ConvertTo-Json -Compress

Invoke-RestMethod http://localhost:3000/router/complete `
  -Method POST `
  -ContentType 'application/json' `
  -Body $body | ConvertTo-Json -Depth 5
```

**Expected:**
- `/llm/models` → `{ "cli": [], "openrouter": ["mistral/mistral-small", "mistral/mistral-medium", "mistral/mistral-large"] }`
- `/llm/config` → object with `tiers` and `providerPriority` keys
- Completion → `{ "text": <non-empty string containing "hello"> }`

**Pass:** LLM returns non-empty text response; model list contains at least one OpenRouter model.
**Fail:** Router unreachable, no API key error, or empty/null text field.

---

## S3 — API Keys

**Goal:** Key management endpoint lists providers, masks values, and exposes stored values when explicitly requested.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# List all configured API key slots
Invoke-RestMethod http://localhost:3000/api-keys | ConvertTo-Json -Depth 5

# Retrieve the stored OpenRouter key value (masked in list, full here)
Invoke-RestMethod http://localhost:3000/api-keys/openrouter/value | ConvertTo-Json -Depth 5
```

**Expected:**
- List → array of objects, each with fields: `name`, `label`, `env_var`, `has_db_key`, `env_set`, `masked`, `seeded`
- Array includes entries for at least: `anthropic`, `openrouter`
- `/api-keys/openrouter/value` → `{ "value": <non-null, non-empty string> }`

**Pass:** `openrouter` entry has `has_db_key: true`; value endpoint returns non-null string.
**Fail:** Value is null or empty string — key not stored in DB. OpenRouter provider absent from list.

---

## S4 — Workspaces

**Goal:** Workspace CRUD (create, list, delete) works end-to-end and DB state is consistent.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# Create a test workspace
$ws = Invoke-RestMethod http://localhost:3000/workspaces `
  -Method POST `
  -ContentType 'application/json' `
  -Body '{"name":"e2e-test-workspace","path":"C:\\Temp\\e2e-ws"}'

Write-Output "Created workspace id=$($ws.id)"

# Confirm it appears in list
$list = Invoke-RestMethod http://localhost:3000/workspaces
$found = $list | Where-Object { $_.name -eq "e2e-test-workspace" }
if ($found) { Write-Output "FOUND in list" } else { Write-Output "NOT FOUND in list — FAIL" }

# Delete the test workspace
Invoke-RestMethod "http://localhost:3000/workspaces/$($ws.id)" -Method DELETE
Write-Output "Deleted workspace $($ws.id)"

# Confirm it's gone
$list2 = Invoke-RestMethod http://localhost:3000/workspaces
$gone = $list2 | Where-Object { $_.name -eq "e2e-test-workspace" }
if (-not $gone) { Write-Output "CONFIRMED absent from list — PASS" } else { Write-Output "Still in list — FAIL" }
```

**Expected:**
- POST → `{ "id": <number>, "name": "e2e-test-workspace", "path": "C:\\Temp\\e2e-ws" }`
- GET list → array includes the new workspace
- DELETE → HTTP 200
- GET list after delete → workspace absent

**Pass:** All four steps succeed; workspace absent from list after delete.
**Fail:** Any step returns non-200, or workspace still present in list after delete.

---

## S5 — Agent Registry & Lifecycle

**Goal:** Agent registry reads correctly; agent deletion works. Real spawn gated behind `E2E_FULL=1`.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# List all registered agents
$agents = Invoke-RestMethod http://localhost:3000/agents
$agents | ConvertTo-Json -Depth 5

# Verify field shape on each agent
foreach ($a in $agents) {
  $missing = @()
  if (-not $a.PSObject.Properties['name'])   { $missing += 'name' }
  if (-not $a.PSObject.Properties['status']) { $missing += 'status' }
  if (-not $a.PSObject.Properties['mode'])   { $missing += 'mode' }
  if ($missing.Count -gt 0) {
    Write-Output "AGENT $($a.id) missing fields: $($missing -join ', ')"
  }
}
Write-Output "Agent list check complete"
```

**Note (E2E_FULL=1 only):**
```powershell
# Full mode — spawn a real agent (costs tokens, starts a process)
$body = @{
  name     = "e2e-test-agent"
  taskType = "general"
  prompt   = "Echo: e2e-test-ok"
} | ConvertTo-Json -Compress

$spawned = Invoke-RestMethod http://localhost:3000/agents/spawn `
  -Method POST `
  -ContentType 'application/json' `
  -Body $body

Write-Output "Spawned agent id=$($spawned.id) status=$($spawned.status)"

# Wait and verify status updates
Start-Sleep -Seconds 5
$status = Invoke-RestMethod "http://localhost:3000/agents/$($spawned.id)"
Write-Output "Agent status: $($status.status)"

# Cleanup
Invoke-RestMethod "http://localhost:3000/agents/$($spawned.id)" -Method DELETE
```

**Expected:**
- GET → array where every element has `name`, `status`, and `mode` fields
- (E2E_FULL) Spawned agent reaches `running` or `done` status within 30 seconds

**Pass:** Returns valid array with correct field shape.
**Fail:** Non-200, missing required fields, or (E2E_FULL) agent never leaves `pending` state.

---

## S6 — Agent Task Files

**Goal:** Per-agent task file read, overwrite (PATCH), and append (POST checkbox) all work correctly.

**Preconditions:** At least one agent registered (run S5 first to confirm). Replace `<agent-name>` below with a real registered agent name.

**Steps:**
```powershell
$agentName = (Invoke-RestMethod http://localhost:3000/agents | Select-Object -First 1).name
Write-Output "Using agent: $agentName"

# Read current task file
$current = Invoke-RestMethod "http://localhost:3000/tasks/$agentName"
Write-Output "Current content length: $($current.Length)"

# Overwrite with known content
$newContent = "# e2e-test task file`n`n- [ ] e2e-test-item-1`n"
Invoke-RestMethod "http://localhost:3000/tasks/$agentName" `
  -Method PATCH `
  -ContentType 'application/json' `
  -Body (@{ content = $newContent } | ConvertTo-Json)

# Verify overwrite
$after = Invoke-RestMethod "http://localhost:3000/tasks/$agentName"
if ($after -match "e2e-test-item-1") {
  Write-Output "PATCH verified — PASS"
} else {
  Write-Output "PATCH not reflected — FAIL"
}

# Append a checkbox item
Invoke-RestMethod "http://localhost:3000/tasks/$agentName" `
  -Method POST `
  -ContentType 'application/json' `
  -Body (@{ item = "e2e-test-appended" } | ConvertTo-Json)

# Verify append
$appended = Invoke-RestMethod "http://localhost:3000/tasks/$agentName"
if ($appended -match "e2e-test-appended") {
  Write-Output "POST append verified — PASS"
} else {
  Write-Output "POST append not reflected — FAIL"
}
```

**Expected:**
- GET → string content (may be empty string)
- PATCH → 200; subsequent GET contains the patched content
- POST → 200; subsequent GET contains `- [ ] e2e-test-appended` line

**Pass:** Content mutations are reflected on subsequent GET.
**Fail:** 404 (no agent with that name), or content unchanged after PATCH/POST.

---

## S7 — Worktrees & Isolation

**Goal:** Worktree list returns valid array; CLI worktree command works; discard clears DB entry.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# API list
$wt = Invoke-RestMethod http://localhost:3000/worktrees
Write-Output "Worktrees count: $($wt.Count)"
$wt | ConvertTo-Json -Depth 5

# CLI list
node "C:\Users\Robin\Applications Dev\Flint\bin\flint.js" worktree list
```

**Note (E2E_FULL=1 only):**
```powershell
# Full mode — create a real worktree (spawns an isolated agent process)
$body = @{
  agentName = "e2e-test-worktree-agent"
  task      = "Echo: worktree-e2e-ok"
} | ConvertTo-Json -Compress

$wt = Invoke-RestMethod http://localhost:3000/worktrees `
  -Method POST `
  -ContentType 'application/json' `
  -Body $body

Write-Output "Worktree id=$($wt.id) path=$($wt.path)"

# Discard (clears DB + filesystem)
Invoke-RestMethod "http://localhost:3000/worktrees/$($wt.id)/discard" -Method POST
Write-Output "Discard issued"

# Confirm absent from list
$list2 = Invoke-RestMethod http://localhost:3000/worktrees
$stillThere = $list2 | Where-Object { $_.id -eq $wt.id }
if (-not $stillThere) { Write-Output "CONFIRMED absent — PASS" } else { Write-Output "Still in list — FAIL" }
```

**Expected:**
- API GET → array (empty OK if no active worktrees)
- CLI → prints "No active worktrees." or a table of entries; exits 0
- (E2E_FULL) Discard removes entry from list

**Pass:** Both API and CLI return valid output without errors.
**Fail:** Non-200 from API, CLI exits non-zero, or (E2E_FULL) entry persists after discard.

---

## S8 — Projects

**Goal:** Project CRUD (create, list, status update, notes update, delete) works via both API and CLI.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# CLI: list existing projects
node "C:\Users\Robin\Applications Dev\Flint\bin\flint.js" project list

# CLI: create a test project
node "C:\Users\Robin\Applications Dev\Flint\bin\flint.js" project create "e2e-test-proj"

# API: get the newly created project id
$projects = Invoke-RestMethod http://localhost:3000/projects
$proj = $projects | Where-Object { $_.name -eq "e2e-test-proj" } | Select-Object -First 1
Write-Output "Project id=$($proj.id)"

# CLI: update status
node "C:\Users\Robin\Applications Dev\Flint\bin\flint.js" project status $proj.id paused

# CLI: update notes
node "C:\Users\Robin\Applications Dev\Flint\bin\flint.js" project notes $proj.id "e2e test notes"

# API: verify shape of updated project
$updated = Invoke-RestMethod "http://localhost:3000/projects/$($proj.id)"
Write-Output "status=$($updated.status) notes=$($updated.notes)"

# Verify required project fields are present
@('id','name','status','notes','last_summary','created_at','updated_at','agents','costWeek','costMonth') | ForEach-Object {
  if (-not $updated.PSObject.Properties[$_]) { Write-Output "MISSING field: $_" }
}

# Cleanup: delete the test project
Invoke-RestMethod "http://localhost:3000/projects/$($proj.id)" -Method DELETE
Write-Output "Deleted project $($proj.id)"
```

**Expected:**
- `project create` → exits 0, prints project with `id`
- `project status <id> paused` → exits 0; API confirms `status: "paused"`
- `project notes <id> "..."` → exits 0; API confirms `notes: "e2e test notes"`
- Project shape: `{ id, name, status, notes, last_summary, created_at, updated_at, agents: [], costWeek, costMonth }`

**Pass:** All CLI commands exit 0; API confirms mutations; all required fields present.
**Fail:** Any CLI command exits non-zero, or API shape missing required fields.

---

## S9 — Task Queue

**Goal:** Queue CRUD (add, list, assign, done, cancel) works via both API and CLI.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# CLI: add a task
node "C:\Users\Robin\Applications Dev\Flint\bin\flint.js" queue add "e2e-test task" --desc "automated test"

# CLI: list queue
node "C:\Users\Robin\Applications Dev\Flint\bin\flint.js" queue list

# API: get the new task id
$tasks = Invoke-RestMethod http://localhost:3000/queue
$task = $tasks | Where-Object { $_.title -eq "e2e-test task" } | Select-Object -First 1
Write-Output "Task id=$($task.id) status=$($task.status)"

# Verify queue task shape
@('id','title','description','project_id','assigned_to','role','priority','status','result','created_by','created_at','updated_at') | ForEach-Object {
  if (-not $task.PSObject.Properties.Name.Contains($_)) { Write-Output "MISSING field: $_" }
}

# API: mark done
Invoke-RestMethod "http://localhost:3000/queue/$($task.id)" `
  -Method PATCH `
  -ContentType 'application/json' `
  -Body (@{ status = "done"; result = "e2e test complete" } | ConvertTo-Json)

# Confirm status
$done = Invoke-RestMethod "http://localhost:3000/queue/$($task.id)"
Write-Output "Final status=$($done.status) result=$($done.result)"

# Cleanup: delete the task
Invoke-RestMethod "http://localhost:3000/queue/$($task.id)" -Method DELETE
```

**Expected:**
- `queue add` → exits 0
- `queue list` → prints table with the new task
- Task shape: `{ id, title, description, project_id, assigned_to, role, priority, status, result, created_by, created_at, updated_at }`
- After PATCH → `status: "done"`, `result: "e2e test complete"`

**Pass:** All steps succeed; status progresses to `done`.
**Fail:** CLI exits non-zero, shape missing fields, or status does not update.

---

## S10 — Orchestrations

**Goal:** Orchestration creation, status read, scratchpad read/write, and list all work.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# CLI list
node "C:\Users\Robin\Applications Dev\Flint\bin\flint.js" orchestrate list

# API: list orchestrations
$orcs = Invoke-RestMethod http://localhost:3000/orchestrations
Write-Output "Orchestrations count: $($orcs.Count)"
$orcs | ConvertTo-Json -Depth 3

# API: create a test orchestration
$orc = Invoke-RestMethod http://localhost:3000/orchestrations `
  -Method POST `
  -ContentType 'application/json' `
  -Body (@{
    name   = "e2e-test-orchestration"
    status = "running"
  } | ConvertTo-Json)

Write-Output "Created orchestration id=$($orc.id)"

# Read scratchpad
$scratch = Invoke-RestMethod "http://localhost:3000/orchestrations/$($orc.id)/scratchpad"
Write-Output "Scratchpad (raw): $scratch"

# Write to scratchpad
Invoke-RestMethod "http://localhost:3000/orchestrations/$($orc.id)/scratchpad" `
  -Method PUT `
  -ContentType 'application/json' `
  -Body (@{ content = "# e2e-test scratchpad" } | ConvertTo-Json)

# Verify scratchpad write
$scratch2 = Invoke-RestMethod "http://localhost:3000/orchestrations/$($orc.id)/scratchpad"
if ($scratch2 -match "e2e-test") { Write-Output "Scratchpad write verified — PASS" } else { Write-Output "Scratchpad write not reflected — FAIL" }

# Cleanup
Invoke-RestMethod "http://localhost:3000/orchestrations/$($orc.id)" -Method DELETE
```

**Expected:**
- CLI `orchestrate list` → exits 0
- API GET → array of orchestrations
- POST → `{ id, name, status }`
- Scratchpad PUT → 200; subsequent GET reflects written content

**Pass:** List returns array; scratchpad write reflected on read.
**Fail:** Non-200, CLI exits non-zero, or scratchpad content unchanged after PUT.

---

## S11 — MCP Servers

**Goal:** MCP server CRUD (add, list, toggle enabled, delete) works correctly.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# List current MCP servers
$mcps = Invoke-RestMethod http://localhost:3000/mcp
Write-Output "MCP servers count: $($mcps.Count)"

# Create a test MCP server entry
$mcp = Invoke-RestMethod http://localhost:3000/mcp `
  -Method POST `
  -ContentType 'application/json' `
  -Body (@{
    name    = "e2e-test-mcp"
    command = "node"
    args    = @("e2e-test-server.js")
    env     = @{}
    scope   = "project"
    enabled = $true
  } | ConvertTo-Json -Depth 5)

Write-Output "Created MCP id=$($mcp.id) name=$($mcp.name)"

# Verify shape
@('id','name','command','args','env','scope','enabled') | ForEach-Object {
  if (-not $mcp.PSObject.Properties[$_]) { Write-Output "MISSING field: $_" }
}

# Confirm in list
$list = Invoke-RestMethod http://localhost:3000/mcp
$found = $list | Where-Object { $_.name -eq "e2e-test-mcp" }
if ($found) { Write-Output "Found in list — PASS" } else { Write-Output "NOT in list — FAIL" }

# Toggle enabled to false
Invoke-RestMethod "http://localhost:3000/mcp/$($mcp.id)" `
  -Method PATCH `
  -ContentType 'application/json' `
  -Body (@{ enabled = $false } | ConvertTo-Json)

# Verify toggle
$toggled = Invoke-RestMethod "http://localhost:3000/mcp/$($mcp.id)"
Write-Output "enabled after toggle: $($toggled.enabled)"

# Delete
Invoke-RestMethod "http://localhost:3000/mcp/$($mcp.id)" -Method DELETE
Write-Output "Deleted MCP server"

# Confirm absent
$list2 = Invoke-RestMethod http://localhost:3000/mcp
$gone = $list2 | Where-Object { $_.name -eq "e2e-test-mcp" }
if (-not $gone) { Write-Output "Confirmed absent — PASS" } else { Write-Output "Still in list — FAIL" }
```

**Expected:**
- POST body: `{ name, command, args?, env?, scope?, enabled? }` → 201 `{ id, name, command, args, env, scope, enabled }`
- PATCH → `{ ok: true }` or 200
- DELETE → 200
- After DELETE, entry absent from list

**Pass:** Server appears in list after POST; PATCH updates `enabled`; absent after DELETE.
**Fail:** POST returns non-201, shape missing fields, or entry persists after DELETE.

---

## S12 — Skills

**Goal:** Skill CRUD (create, list, read, update, delete) works correctly.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# List existing skills
$skills = Invoke-RestMethod http://localhost:3000/skills
Write-Output "Skills count: $($skills.Count)"

# Create a test skill
$skill = Invoke-RestMethod http://localhost:3000/skills `
  -Method POST `
  -ContentType 'application/json' `
  -Body (@{
    name    = "e2e-test-skill"
    label   = "E2E Test Skill"
    content = "# e2e-test-skill`nThis is a test skill."
  } | ConvertTo-Json)

Write-Output "Created skill id=$($skill.id)"

# Confirm in list
$list = Invoke-RestMethod http://localhost:3000/skills
$found = $list | Where-Object { $_.name -eq "e2e-test-skill" }
if ($found) { Write-Output "Found in list — PASS" } else { Write-Output "NOT in list — FAIL" }

# Update label
Invoke-RestMethod "http://localhost:3000/skills/$($skill.id)" `
  -Method PATCH `
  -ContentType 'application/json' `
  -Body (@{ label = "E2E Test Skill Updated" } | ConvertTo-Json)

# Verify update
$updated = Invoke-RestMethod "http://localhost:3000/skills/$($skill.id)"
Write-Output "Updated label: $($updated.label)"
if ($updated.label -eq "E2E Test Skill Updated") { Write-Output "Label updated — PASS" } else { Write-Output "Label not updated — FAIL" }

# Delete
Invoke-RestMethod "http://localhost:3000/skills/$($skill.id)" -Method DELETE
Write-Output "Deleted skill (expect 204)"

# Confirm absent
$list2 = Invoke-RestMethod http://localhost:3000/skills
$gone = $list2 | Where-Object { $_.name -eq "e2e-test-skill" }
if (-not $gone) { Write-Output "Confirmed absent — PASS" } else { Write-Output "Still in list — FAIL" }
```

**Expected:**
- POST → skill object with `id`, `name`, `label`, `content`
- GET list → includes new skill
- PATCH → 200; GET confirms `label: "E2E Test Skill Updated"`
- DELETE → 204; entry absent from list

**Pass:** Full lifecycle completes without errors; all mutations reflected.
**Fail:** Any step returns non-200/204, or mutations not reflected on read.

---

## S13 — Specialists

**Goal:** Specialist CRUD (create, read, update, delete) works; soul field present; dashboard modal dropdown populated.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# List existing specialists
$specs = Invoke-RestMethod http://localhost:3000/api/specialists
Write-Output "Specialists count: $($specs.Count)"

# Create a test specialist
$spec = Invoke-RestMethod http://localhost:3000/api/specialists `
  -Method POST `
  -ContentType 'application/json' `
  -Body (@{
    name    = "e2e-test-specialist"
    label   = "E2E Test Specialist"
    domains = @("testing", "automation")
    soul    = "You are an E2E test specialist. Be concise."
    model   = "claude-3-5-haiku"
  } | ConvertTo-Json -Depth 5)

Write-Output "Created specialist name=$($spec.name)"

# Read back and verify soul field
$fetched = Invoke-RestMethod "http://localhost:3000/api/specialists/$($spec.name)"
if ($fetched.soul) { Write-Output "Soul field present — PASS" } else { Write-Output "Soul field missing — FAIL" }

# Verify required fields
@('name','label','domains','soul') | ForEach-Object {
  if (-not $fetched.PSObject.Properties[$_]) { Write-Output "MISSING field: $_" }
}

# Update label
Invoke-RestMethod "http://localhost:3000/api/specialists/$($spec.name)" `
  -Method PATCH `
  -ContentType 'application/json' `
  -Body (@{ label = "E2E Specialist Updated" } | ConvertTo-Json)

$updated = Invoke-RestMethod "http://localhost:3000/api/specialists/$($spec.name)"
Write-Output "Updated label: $($updated.label)"

# Delete
Invoke-RestMethod "http://localhost:3000/api/specialists/$($spec.name)" -Method DELETE
Write-Output "Deleted specialist (expect 204)"

# Confirm absent
$list2 = Invoke-RestMethod http://localhost:3000/api/specialists
$gone = $list2 | Where-Object { $_.name -eq "e2e-test-specialist" }
if (-not $gone) { Write-Output "Confirmed absent — PASS" } else { Write-Output "Still in list — FAIL" }
```

**Browser check (see S20):** Open New Agent modal at `http://localhost:3000` — Specialist dropdown must include the specialist created above (test before DELETE).

**Expected:**
- POST → specialist with `name`, `label`, `domains`, `soul`
- GET `:name` → includes `soul` field
- PATCH → updated label confirmed
- DELETE → 204; entry absent from list

**Pass:** Full lifecycle completes; browser modal shows specialist in dropdown (verified in S20).
**Fail:** Soul field missing, label not updated, or entry persists after DELETE.

---

## S14 — Project Docs

**Goal:** Document upload, list, retrieve, and delete against a real project ID.

**Preconditions:** S8 passed; a test project exists. Replace `<project-id>` with a real project ID.

**Steps:**
```powershell
# Create a project to attach docs to
$proj = Invoke-RestMethod http://localhost:3000/projects `
  -Method POST `
  -ContentType 'application/json' `
  -Body (@{ name = "e2e-test-proj-docs"; status = "active" } | ConvertTo-Json)

$pid = $proj.id
Write-Output "Using project id=$pid"

# Write a temp test file to upload
$tmpFile = "$env:TEMP\e2e-test-doc.txt"
Set-Content -Path $tmpFile -Value "# e2e-test document content"

# Upload document (multipart)
$form = @{
  file = Get-Item $tmpFile
}
$doc = Invoke-RestMethod "http://localhost:3000/projects/$pid/docs" `
  -Method POST `
  -Form $form

Write-Output "Uploaded doc id=$($doc.id) filename=$($doc.filename) size=$($doc.size)"

# List docs
$docs = Invoke-RestMethod "http://localhost:3000/projects/$pid/docs"
$found = $docs | Where-Object { $_.id -eq $doc.id }
if ($found) { Write-Output "Found in list — PASS" } else { Write-Output "NOT in list — FAIL" }

# Retrieve doc content
$content = Invoke-RestMethod "http://localhost:3000/projects/$pid/docs/$($doc.id)"
if ($content -match "e2e-test") { Write-Output "Content retrieved — PASS" } else { Write-Output "Content mismatch — FAIL" }

# Delete doc
Invoke-RestMethod "http://localhost:3000/projects/$pid/docs/$($doc.id)" -Method DELETE
Write-Output "Deleted doc (expect 204)"

# Confirm absent
$docs2 = Invoke-RestMethod "http://localhost:3000/projects/$pid/docs"
$gone = $docs2 | Where-Object { $_.id -eq $doc.id }
if (-not $gone) { Write-Output "Confirmed absent — PASS" } else { Write-Output "Still in list — FAIL" }

# Cleanup project
Invoke-RestMethod "http://localhost:3000/projects/$pid" -Method DELETE
Remove-Item $tmpFile -Force
```

**Expected:**
- POST → `{ "id": <number>, "filename": "e2e-test-doc.txt", "size": <number> }`
- GET list → includes new doc
- GET doc → returns file content containing "e2e-test"
- DELETE → 204; doc absent from list

**Pass:** Doc retrievable after upload; content matches; absent after delete.
**Fail:** Upload fails, content mismatch, or doc persists after delete.

---

## S15 — Ollama

**Goal:** Ollama status shows reachable with expected models; text generation returns non-empty response.

**Preconditions:** Ollama running locally. S1 passed (health shows `ollama: "reachable"`).

**Steps:**
```powershell
# Check Ollama status via dashboard API
$status = Invoke-RestMethod http://localhost:3000/api/ollama/status
Write-Output "reachable=$($status.reachable)"
Write-Output "models=$($status.models -join ', ')"

if (-not $status.reachable) {
  Write-Output "OLLAMA UNREACHABLE — FAIL"
  exit 1
}

# Verify expected models present
$expected = @("llama3.2:latest", "snowflake-arctic-embed2:latest")
foreach ($m in $expected) {
  if ($status.models -contains $m) {
    Write-Output "Model $m — PRESENT"
  } else {
    Write-Output "Model $m — MISSING (may still pass if other models loaded)"
  }
}

# Generate text via dashboard proxy
$genBody = @{
  model  = $status.models[0]
  prompt = "Reply with the single word: pong"
} | ConvertTo-Json -Compress

$gen = Invoke-RestMethod http://localhost:3000/api/ollama/generate `
  -Method POST `
  -ContentType 'application/json' `
  -Body $genBody

Write-Output "Generation response: $($gen.response)"
if ($gen.response -and $gen.response.Length -gt 0) {
  Write-Output "Non-empty response — PASS"
} else {
  Write-Output "Empty response — FAIL"
}
```

**Expected:**
- Status → `{ "reachable": true, "models": ["llama3.2:latest", "snowflake-arctic-embed2:latest"] }`
- Generate → `{ "response": <non-empty string> }`

**Pass:** `reachable: true`; model list non-empty; generation returns non-empty response.
**Fail:** `reachable: false`, empty model list, or empty/null `response` field.

---

## S16 — Forgejo PR Flow (E2E_FULL=1 only)

**Goal:** Branch push and PR creation reach Forgejo; full git flow verified with a real isolated agent.

**Preconditions:** `E2E_FULL=1` environment variable set. S1 confirmed `forgejo: "reachable"`. Forgejo Docker container running at `http://localhost:3030`.

**Standard-mode steps (always run):**
```powershell
# Confirm Forgejo reachable in health
$health = Invoke-RestMethod http://localhost:3000/health
Write-Output "Forgejo health field: $($health.forgejo)"

if ($health.forgejo -eq "reachable") {
  Write-Output "Forgejo reachable — standard check PASS"
} else {
  Write-Output "Forgejo NOT reachable — FAIL"
}

# Verify Forgejo API responds
try {
  $info = Invoke-RestMethod http://localhost:3030/api/v1/version
  Write-Output "Forgejo version: $($info.version)"
} catch {
  Write-Output "Forgejo API error: $_"
}
```

**Full-mode steps (E2E_FULL=1 only):**
```powershell
# Full mode — spawn isolated agent, push branch, create PR
$body = @{
  name       = "e2e-test-forgejo-agent"
  task       = "Create a file called e2e-test.txt, commit it, push to branch e2e-test-branch, and open a PR"
  worktree   = $true
  repoUrl    = "http://localhost:3030/robin/flint"
} | ConvertTo-Json -Compress

$agent = Invoke-RestMethod http://localhost:3000/agents/spawn `
  -Method POST `
  -ContentType 'application/json' `
  -Body $body

Write-Output "Agent spawned id=$($agent.id)"

# Wait for completion (up to 120 seconds)
$start = Get-Date
do {
  Start-Sleep -Seconds 10
  $s = Invoke-RestMethod "http://localhost:3000/agents/$($agent.id)"
  Write-Output "Status: $($s.status) ($(([int]((Get-Date) - $start).TotalSeconds))s elapsed)"
} while ($s.status -notin @("done","error","failed") -and ((Get-Date) - $start).TotalSeconds -lt 120)

# Check PR created in Forgejo
$token = (Invoke-RestMethod "http://localhost:3000/api/api-keys/forgejo/value").value
$prs = Invoke-RestMethod "http://localhost:3030/api/v1/repos/robin/flint/pulls?state=open&token=$token"
$e2ePR = $prs | Where-Object { $_.head.ref -eq "e2e-test-branch" }
if ($e2ePR) {
  Write-Output "PR found: $($e2ePR.title) — PASS"
} else {
  Write-Output "No PR found on e2e-test-branch — FAIL"
}

# Cleanup
Invoke-RestMethod "http://localhost:3000/agents/$($agent.id)" -Method DELETE
```

**Expected:**
- Standard: `forgejo: "reachable"` in health; Forgejo API returns version
- (E2E_FULL) Agent completes; PR visible in Forgejo on `e2e-test-branch`

**Pass:** Standard — health field correct. Full — PR created and visible in Forgejo.
**Fail:** Standard — `forgejo: "unreachable"`. Full — agent errors or no PR created within 120 seconds.

---

## S17 — Suggestions

**Goal:** Suggestion list endpoint returns valid array; format matches expected shape.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# List suggestions
$suggestions = Invoke-RestMethod http://localhost:3000/suggestions
Write-Output "Suggestions count: $($suggestions.Count)"
$suggestions | ConvertTo-Json -Depth 5

# Verify it's an array
if ($null -ne $suggestions -and ($suggestions -is [array] -or $suggestions.Count -ge 0)) {
  Write-Output "Valid array — PASS"
} else {
  Write-Output "Not an array — FAIL"
}
```

**Expected:** Array (may be empty `[]`). If suggestions present, each has at minimum a `text` or `content` field.

**Pass:** HTTP 200 with array response (empty is acceptable).
**Fail:** Non-200 or non-array response body.

---

## S18 — Costs & Usage

**Goal:** Cost aggregation returns valid structure with non-negative `monthTotal`.

**Preconditions:** S1 passed.

**Steps:**
```powershell
# Fetch cost data
$costs = Invoke-RestMethod http://localhost:3000/costs
Write-Output "monthTotal: $($costs.monthTotal)"
Write-Output "costs array count: $($costs.costs.Count)"

# Verify shape
if ($null -eq $costs.monthTotal) {
  Write-Output "monthTotal is null — FAIL"
} elseif ($costs.monthTotal -lt 0) {
  Write-Output "monthTotal is negative — FAIL"
} else {
  Write-Output "monthTotal valid ($($costs.monthTotal)) — PASS"
}

if ($null -eq $costs.costs) {
  Write-Output "costs array is null — FAIL"
} else {
  Write-Output "costs array present — PASS"
}

# Show breakdown if available
$costs.costs | ConvertTo-Json -Depth 3
```

**Expected:** `{ "costs": [...], "monthTotal": <non-negative number> }`

**Pass:** `monthTotal` is a non-negative number; `costs` is an array.
**Fail:** Either field is null, or `monthTotal` is negative.

---

## S19 — CLI Full Walkthrough

**Goal:** The `flint` CLI binary reaches both services and all subcommands exit 0 with non-empty output.

**Preconditions:** S1 passed. Node.js available in PATH.

**Steps:**
```powershell
$flint = "C:\Users\Robin\Applications Dev\Flint\bin\flint.js"

# LLM completion via CLI
Write-Output "=== ask ==="
node $flint ask "Reply with just the word: pong"
Write-Output "Exit code: $LASTEXITCODE"

# Project list
Write-Output "=== project list ==="
node $flint project list
Write-Output "Exit code: $LASTEXITCODE"

# Queue list
Write-Output "=== queue list ==="
node $flint queue list
Write-Output "Exit code: $LASTEXITCODE"

# Worktree list
Write-Output "=== worktree list ==="
node $flint worktree list
Write-Output "Exit code: $LASTEXITCODE"

# Orchestrate list
Write-Output "=== orchestrate list ==="
node $flint orchestrate list
Write-Output "Exit code: $LASTEXITCODE"

# Help / version
Write-Output "=== help ==="
node $flint --help
Write-Output "Exit code: $LASTEXITCODE"
```

**Expected:**
- `ask` → exits 0; response contains the word "pong"
- `project list` → exits 0; prints project table or "No projects"
- `queue list` → exits 0; prints task table or "No tasks"
- `worktree list` → exits 0; prints "No active worktrees." or a table
- `orchestrate list` → exits 0; prints orchestration table or "No orchestrations"
- `--help` → exits 0; prints usage text

**Pass:** Every command exits 0 with non-empty output; `ask` returns text containing "pong".
**Fail:** Any command exits 1, throws an uncaught exception, or `ask` returns empty string.

---

## S20 — Browser UI Full Walkthrough

**Goal:** Every tab in the dashboard renders without JS errors; primary actions (modals, CRUD) work in-browser.

**Preconditions:** S1 passed. Dashboard running at `http://localhost:3000`. Browser automation available.

**Steps (browser automation):**
```powershell
# Navigate to dashboard
# URL: http://localhost:3000
# Open browser dev tools console — note any errors before clicking

# Tab walkthrough sequence:
# 1. Agents (default view)
# 2. Projects
# 3. Workspaces
# 4. MCP
# 5. Keys
# 6. Skills
# 7. Specialists
# 8. Queue
# 9. Orchestrate
```

**Browser automation script (using claude-in-chrome):**
1. Navigate to `http://localhost:3000`
2. Capture screenshot — verify Agents view with toolbar visible
3. Click "+ New Agent" — verify modal opens with Specialist dropdown populated
4. Close modal (Escape or Cancel)
5. Click "Projects" tab — verify project cards/table renders
6. Click "Workspaces" tab — verify workspace list renders
7. Click "MCP" tab — verify MCP server list renders
8. Click "Keys" tab — verify API key rows with masked values visible
9. Click "Skills" tab — verify skill list renders
10. Click "Specialists" tab — verify card grid renders
11. Click "Queue" tab — verify queue table renders
12. Click "Orchestrate" tab — verify orchestration list renders
13. Click "← Dashboard" (if present) — returns to Agents view
14. Check browser console — collect any JS errors

**Checklist:**
- [ ] Agents view loads, toolbar visible
- [ ] "+ New Agent" modal opens with Specialist dropdown populated
- [ ] Specialist dropdown includes at least one option
- [ ] Projects tab renders without blank content
- [ ] Workspaces tab renders without blank content
- [ ] MCP tab renders without blank content
- [ ] Keys tab shows rows with masked key values
- [ ] Skills tab renders without blank content
- [ ] Specialists tab renders card grid
- [ ] Queue tab renders without blank content
- [ ] Orchestrate tab renders without blank content
- [ ] No JS console errors on any tab

**Pass:** All tabs render without blank content; modals open and close cleanly; no JS errors in console.
**Fail:** Any tab shows blank content, spinner indefinitely, or throws a JS console error.

---

## Appendix: Quick Cleanup

Remove all `e2e-test-*` resources if a test run was interrupted:

```powershell
$base = "http://localhost:3000"

# Clean workspaces
(Invoke-RestMethod "$base/workspaces") |
  Where-Object { $_.name -like "e2e-test-*" } |
  ForEach-Object { Invoke-RestMethod "$base/workspaces/$($_.id)" -Method DELETE; Write-Output "Deleted workspace $($_.id)" }

# Clean projects
(Invoke-RestMethod "$base/projects") |
  Where-Object { $_.name -like "e2e-test-*" } |
  ForEach-Object { Invoke-RestMethod "$base/projects/$($_.id)" -Method DELETE; Write-Output "Deleted project $($_.id)" }

# Clean queue tasks
(Invoke-RestMethod "$base/queue") |
  Where-Object { $_.title -like "e2e-test*" } |
  ForEach-Object { Invoke-RestMethod "$base/queue/$($_.id)" -Method DELETE; Write-Output "Deleted task $($_.id)" }

# Clean MCP servers
(Invoke-RestMethod "$base/mcp") |
  Where-Object { $_.name -like "e2e-test-*" } |
  ForEach-Object { Invoke-RestMethod "$base/mcp/$($_.id)" -Method DELETE; Write-Output "Deleted MCP $($_.id)" }

# Clean skills
(Invoke-RestMethod "$base/skills") |
  Where-Object { $_.name -like "e2e-test-*" } |
  ForEach-Object { Invoke-RestMethod "$base/skills/$($_.id)" -Method DELETE; Write-Output "Deleted skill $($_.id)" }

# Clean specialists
(Invoke-RestMethod "$base/api/specialists") |
  Where-Object { $_.name -like "e2e-test-*" } |
  ForEach-Object { Invoke-RestMethod "$base/api/specialists/$($_.name)" -Method DELETE; Write-Output "Deleted specialist $($_.name)" }

# Clean orchestrations
(Invoke-RestMethod "$base/orchestrations") |
  Where-Object { $_.name -like "e2e-test-*" } |
  ForEach-Object { Invoke-RestMethod "$base/orchestrations/$($_.id)" -Method DELETE; Write-Output "Deleted orchestration $($_.id)" }

Write-Output "Cleanup complete"
```

---

## Appendix: Pass/Fail Summary Table

| Section | Goal | Gated |
|---------|------|-------|
| S1 | Health & Service Reachability | — |
| S2 | Router / LLM Routing | — |
| S3 | API Keys | — |
| S4 | Workspaces CRUD | — |
| S5 | Agent Registry | E2E_FULL (spawn) |
| S6 | Agent Task Files | — |
| S7 | Worktrees & Isolation | E2E_FULL (create) |
| S8 | Projects CRUD | — |
| S9 | Task Queue CRUD | — |
| S10 | Orchestrations | — |
| S11 | MCP Servers CRUD | — |
| S12 | Skills CRUD | — |
| S13 | Specialists CRUD | — |
| S14 | Project Docs CRUD | — |
| S15 | Ollama | — |
| S16 | Forgejo PR Flow | E2E_FULL (full flow) |
| S17 | Suggestions | — |
| S18 | Costs & Usage | — |
| S19 | CLI Full Walkthrough | — |
| S20 | Browser UI Walkthrough | — |

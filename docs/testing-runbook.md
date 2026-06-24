# Flint Testing Runbook

Work through each section in order. Each test has an action and an expected result. Mark ✅ pass or ❌ fail as you go.

---

## 1. Stack Health

### 1.1 Start the stack

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
node start.js
```

**Expected:** Three lines confirming dashboard (3000), router (3001), and cron daemon started.

### 1.2 Health check

```powershell
Invoke-RestMethod http://localhost:3000/health | ConvertTo-Json
```

**Expected:**
```json
{ "status": "ok", "db": "connected", "forgejo": "reachable" }
```

> If `forgejo` shows `unreachable`, run `docker compose up -d` first.

### 1.3 Router health

```powershell
Invoke-RestMethod http://localhost:3001/health | ConvertTo-Json
```

**Expected:** `{ "status": "ok" }`

### 1.4 Dashboard loads

Open `http://localhost:3000` in a browser.

**Expected:** Dark dashboard with "New Agent" button, Agents / Projects / Costs tabs.

### 1.5 Forgejo loads

Open `http://localhost:3030` in a browser. Log in as `robin / changeme123`.

**Expected:** Forgejo UI with `flint` repo visible under your account.

---

## 2. Agent Spawn & Terminal

### 2.1 Spawn a basic agent

1. Click **New Agent**
2. Name: `test-agent`
3. Working Directory should auto-fill to the Flint root
4. Leave Model blank
5. Click **Spawn**

**Expected:** A panel appears titled `test-agent`. Claude Code starts up inside it, runs heartbeat/skills, and shows a prompt.

### 2.2 Terminal is interactive

Click inside the `test-agent` terminal panel and type:

```
what is 2 + 2?
```

Press Enter.

**Expected:** Claude responds in the terminal.

### 2.3 Task sidebar

In the `test-agent` panel, find the Tasks sidebar on the right. Type a task in the input and click **Add**.

**Expected:** Task appears in the task list. Claude does NOT acknowledge it automatically — tasks are written to a file Claude reads on demand. To action a task, either:
- Type `check your task file and work on the next task` in the terminal, or
- Add tasks before spawning so they are injected as startup context

### 2.4 Kill and Remove

1. Click **Kill** on the `test-agent` panel
2. **Expected:** Status badge changes to `stopped`, Kill button turns grey "Remove"
3. Click **Remove**
4. **Expected:** Panel disappears entirely

---

## 3. Isolated Branch (Worktree + PR flow)

> Requires Forgejo running and `forgejo.token` present.

### 3.1 Spawn an isolated agent

1. Click **New Agent**
2. Name: `iso-agent`
3. Tick **Isolated branch** checkbox
4. Click **Spawn**

**Expected:** Panel appears. Claude starts in an isolated git worktree (a separate branch).

### 3.2 Agent exits → PR created

In the terminal, type `/exit` or `exit` to end the Claude session.

**Expected:**
- Panel header shows `creating PR…` badge
- Within a few seconds badge changes to `View PR #N` (a link)

### 3.3 View the PR in Forgejo

Click the **View PR** link in the panel header.

**Expected:** Forgejo opens showing the PR for `iso-agent`'s branch.

### 3.4 Discard the worktree

If you don't want to merge the PR: click **Discard** next to the "View PR" link in the panel header.

Alternatively via CLI:
```powershell
node bin\flint.js worktree list
node bin\flint.js worktree discard iso-agent
```

**Expected:** Worktree and branch cleaned up, panel header restored to Kill/Remove buttons.

---

## 4. CLI — `flint` Commands

### 4.1 Models list

```powershell
node bin\flint.js models
```

**Expected:** List of providers and their available models. Providers without API keys show empty lists.

### 4.2 Config

```powershell
node bin\flint.js config
```

**Expected:** JSON showing router configuration (routing rules, providers).

### 4.3 Costs

```powershell
node bin\flint.js costs
```

**Expected:** Today's and this month's costs per provider (all $0.00 if no agents have run yet).

### 4.4 Ask (requires ANTHROPIC_API_KEY in .env)

```powershell
node bin\flint.js ask "what is the capital of France?"
```

**Expected:** `Paris` or similar answer returned via the router.

> If key not set, you'll get a provider error — skip this test until the key is added.

### 4.5 Project management

```powershell
# Create a project
node bin\flint.js project create "Test Project"

# List projects
node bin\flint.js project list

# Add notes (use the ID printed by create)
node bin\flint.js project notes 1 "This is a test project"

# Link an agent (spawn one first if needed)
node bin\flint.js project link 1 test-agent

# Unlink
node bin\flint.js project unlink 1 test-agent
```

**Expected:** Each command prints a confirmation line. `project list` shows the project with cost columns.

### 4.6 Suggestions

Spawn an agent named `suggester` (single word — no spaces) and in its terminal type output containing:
```
## SUGGESTION: use a config file instead of hardcoding values
```
Then check:
```powershell
node bin\flint.js suggestions list
```

**Expected:** The suggestion appears. Then:
```powershell
node bin\flint.js suggestions dismiss 1
```

**Expected:** `Suggestion 1 dismissed.`

### 4.7 Worktree list

```powershell
node bin\flint.js worktree list
```

**Expected:** Lists any active worktrees with branch and PR info, or `No active worktrees.`

---

## 5. Dashboard UI — Projects Tab

### 5.1 Create a project in the UI

1. Click the **Projects** tab
2. Click **New Project**
3. Name: `UI Test Project`, add some notes
4. Click **Create**

**Expected:** Project card appears in the Projects tab with $0.00 costs.

### 5.2 Link an agent to a project

1. Spawn an agent named `proj-agent`
2. In Projects tab, open the project
3. Link `proj-agent` to the project

**Expected:** Agent appears under the project. When the agent runs and incurs cost, it rolls up to the project total.

---

## 6. Costs Display

### 6.1 View costs

Look at the top-right corner of the dashboard header.

**Expected:** `Today: $0.00  Month: $0.00` — these update automatically as agents run and incur usage. No separate tab needed.

To verify programmatically:
```powershell
node bin\flint.js costs
```

**Expected:** Breakdown by provider for today and this month.

---

## 7. Suggestion Strip

### 7.1 Suggestion appears in strip

Spawn an agent. In its terminal, paste:
```
## SUGGESTION: add a retry mechanism to the API calls
```

**Expected:** A suggestion chip appears in the strip at the top of the dashboard (above the panels).

### 7.2 Dismiss from strip

Click the suggestion chip or its dismiss button.

**Expected:** Chip disappears from the strip.

---

## 8. Persistence — Restart Test

### 8.1 Stop and restart

1. Note which agents are visible on the dashboard
2. Stop `node start.js` (Ctrl+C)
3. Restart: `node start.js`
4. Refresh `http://localhost:3000`

**Expected:** Previously registered agents reappear in their panels (status: `stopped`). Projects and costs are preserved.

---

## 9. PM2 Auto-start (after reboot)

> Run this after a Windows reboot to verify the startup task works.

1. Reboot the machine
2. Wait ~30 seconds
3. Open `http://localhost:3000`

**Expected:** Dashboard is available without manually running `node start.js`.

> If not running, check Task Scheduler for the PM2 entry or run `node start.js` manually.

---

## Quick Reference — What to Check if Something Fails

| Symptom | Check |
|---------|-------|
| Dashboard 404 / refused | `node start.js` not running — start it |
| Agent spawn does nothing | Workdir field empty in modal |
| Terminal panel blank | Click the terminal area to focus it |
| `claude` not found error | Run `where claude` in PowerShell |
| Forgejo unreachable | `docker compose up -d` |
| PR not created | Check `forgejo.token` exists at Flint root |
| Router 500 on `flint ask` | Add `ANTHROPIC_API_KEY` to `.env`, restart router |
| Costs all zero | Expected until `flint ask` or agents complete sessions |
| PM2 not auto-starting | Rerun `pm2-startup install` in PowerShell |

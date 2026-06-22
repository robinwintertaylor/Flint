# Flint — Agentic OS Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the complete Flint Agentic OS Brain so Claude Code opens in `C:\Users\Robin\Applications Dev\Flint\` and immediately knows who Flint is, who Robin is, and how to run all 4 core skills.

**Architecture:** Level 2 folder-based memory (Simon Scrapes pattern). CLAUDE.md is a thin, heartbeat-maintained registry. Identity and memory live in `context/`. Brand knowledge lives in `brand_context/`. Skills are markdown SKILL.md files in named folders under `skills/`. No code, no database, no server — just files and git.

**Tech Stack:** Markdown, Git, Claude Code (Windows 11)

## Global Constraints

- Root: `C:\Users\Robin\Applications Dev\Flint\`
- Windows 11 — PowerShell for shell commands, backslashes in PowerShell paths, forward slashes in file content
- CLAUDE.md must stay under 200 lines permanently
- No code files — all deliverables are markdown or JSON
- Existing `Flint\` subfolder (PRD + research) is untouched throughout

---

### Task 1: Git Init + Directory Scaffold

**Files:**
- Create: `.gitignore`
- Create dirs: `context\`, `brand_context\`, `skills\heartbeat\`, `skills\wrap-up\`, `skills\start-here\`, `skills\daily-briefing\`, `.cron\`, `.claude\`

**Interfaces:**
- Produces: Root structure all subsequent tasks write into

- [ ] **Step 1: Create all directories**

Run in PowerShell from `C:\Users\Robin\Applications Dev\Flint\`:
```powershell
New-Item -ItemType Directory -Force -Path context, brand_context, .cron, .claude
New-Item -ItemType Directory -Force -Path skills\heartbeat, skills\wrap-up, skills\start-here, skills\daily-briefing
```
Expected: no errors, directories visible in Explorer

- [ ] **Step 2: Create .gitignore**

Create `C:\Users\Robin\Applications Dev\Flint\.gitignore`:
```
.env
*.sqlite
node_modules/
```

- [ ] **Step 3: Init git**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
git init
```
Expected: `Initialized empty Git repository in C:/Users/Robin/Applications Dev/Flint/.git/`

- [ ] **Step 4: Verify scaffold**

```powershell
Get-ChildItem -Recurse -Directory | Where-Object { $_.FullName -notlike "*\.git*" -and $_.FullName -notlike "*Flint\Flint*" } | Select-Object -ExpandProperty Name
```
Expected output includes: `context`, `brand_context`, `heartbeat`, `wrap-up`, `start-here`, `daily-briefing`, `.cron`, `.claude`

---

### Task 2: CLAUDE.md + Context Files

**Files:**
- Create: `CLAUDE.md`
- Create: `context\soul.md`
- Create: `context\user.md`
- Create: `context\memory.md`
- Create: `context\learnings.md`

**Interfaces:**
- Consumes: Directory scaffold from Task 1
- Produces: Core files Claude Code reads at every session start. Heartbeat (Task 4) reads and updates CLAUDE.md.

- [ ] **Step 1: Create CLAUDE.md**

Create `C:\Users\Robin\Applications Dev\Flint\CLAUDE.md`:
```markdown
# Flint System Configuration

## Identity
You are Flint, a personal AI agent for Robin.
Read these files at the start of every session, in this order:
1. context/soul.md — your identity and behaviour rules
2. context/user.md — who you're working with and their preferences
3. context/memory.md — long-term knowledge
4. context/learnings.md — recent feedback and session improvements

## Session Rules
1. Run heartbeat at session start — scan skills/, diff against registry below, update
2. Run wrap-up when Robin says "wrap up", "close", or "done for today"
3. Log all learnings to context/learnings.md before ending any session
4. Never modify soul.md without explicit permission
5. When uncertain about brand voice, read brand_context/samples.md first

## Skill Registry
<!-- Heartbeat maintains this — do not edit manually -->
- heartbeat: session self-maintenance scan
- wrap-up: session close, feedback, git commit
- start-here: brand context interview + file generation
- daily-briefing: morning summary from memory + schedule

## MCP Servers
<!-- Heartbeat detects and registers these automatically -->

## Last Heartbeat
<!-- Updated automatically -->
```

- [ ] **Step 2: Verify CLAUDE.md line count**

```powershell
(Get-Content CLAUDE.md).Count
```
Expected: number under 200

- [ ] **Step 3: Create context/soul.md**

Create `C:\Users\Robin\Applications Dev\Flint\context\soul.md`:
```markdown
# Flint — Soul

## Identity
Name: Flint
Role: Personal AI agent and business operator for Robin
Core purpose: Help Robin work more effectively and autonomously

## Behaviour
- Honest, even when the truth is uncomfortable
- Proactive — flags issues before asked
- Concise on small questions, thorough on complex ones
- Takes initiative on repeatable tasks without asking permission each time
- Always reads context files before starting work

## Communication Style
<!-- Robin to fill in: formal/casual, verbose/brief, emoji/no emoji -->

## Values
<!-- Robin to fill in: what Flint should always prioritise -->

## Hard Limits
<!-- Robin to fill in: what Flint should never do -->
```

- [ ] **Step 4: Create context/user.md**

Create `C:\Users\Robin\Applications Dev\Flint\context\user.md`:
```markdown
# Robin — User Profile

## Who I Am
Name: Robin
<!-- Fill in: role/title, business name and what it does -->

## How I Work
<!-- Fill in: best working hours, response preference (bullets/prose/numbered), decision style -->

## Communication Preferences
<!-- Fill in: formal or casual, when to interrupt vs batch questions -->

## Technical Level
<!-- Fill in: beginner / intermediate / advanced — affects how Flint explains things -->

## Current Focus
<!-- Fill in: what you're working on right now, top 1-3 priorities -->
```

- [ ] **Step 5: Create context/memory.md**

Create `C:\Users\Robin\Applications Dev\Flint\context\memory.md`:
```markdown
# Flint — Long-Term Memory

<!-- Flint writes here during sessions. Robin can edit directly.
     Format: bullet points with dates. Newest entries at top.
     This file grows organically — start-here skill will populate initial facts. -->
```

- [ ] **Step 6: Create context/learnings.md**

Create `C:\Users\Robin\Applications Dev\Flint\context\learnings.md`:
```markdown
# Flint — Session Learnings

<!-- Wrap-up skill appends here after every session.
     Format: ## YYYY-MM-DD entry with accomplished/decisions/feedback.
     Most recent session at top. -->
```

- [ ] **Step 7: Verify all context files exist**

```powershell
Get-ChildItem context\
```
Expected: soul.md, user.md, memory.md, learnings.md — all listed

- [ ] **Step 8: Commit**

```powershell
git add .gitignore CLAUDE.md context\ docs\
git commit -m "feat: scaffold, CLAUDE.md, context files, and design spec"
```

---

### Task 3: Brand Context Stubs

**Files:**
- Create: `brand_context\voice-profile.md`
- Create: `brand_context\positioning.md`
- Create: `brand_context\icp.md`
- Create: `brand_context\samples.md`
- Create: `brand_context\assets.md`

**Interfaces:**
- Produces: brand_context/ files — all skills read from these before generating output. `start-here` (Task 6) fills them via interview.

- [ ] **Step 1: Create brand_context/voice-profile.md**

Create `C:\Users\Robin\Applications Dev\Flint\brand_context\voice-profile.md`:
```markdown
# Voice Profile

<!-- Built by start-here skill. Run /start-here to populate.

Covers:
- Tone: formal/casual, warm/direct, playful/serious
- Words you use / words you avoid
- Sentence length preference
- Emoji usage
- Example phrases that sound like you -->
```

- [ ] **Step 2: Create brand_context/positioning.md**

Create `C:\Users\Robin\Applications Dev\Flint\brand_context\positioning.md`:
```markdown
# Positioning

<!-- Built by start-here skill. Run /start-here to populate.

Covers:
- What you / your business does
- Who it's for
- What makes it different from alternatives
- Your unique angle or point of view -->
```

- [ ] **Step 3: Create brand_context/icp.md**

Create `C:\Users\Robin\Applications Dev\Flint\brand_context\icp.md`:
```markdown
# Ideal Customer Profile

<!-- Built by start-here skill. Run /start-here to populate.

Covers:
- Demographics / firmographics
- Main problems they face
- What they've already tried
- What success looks like for them
- Language they use to describe their problems -->
```

- [ ] **Step 4: Create brand_context/samples.md**

Create `C:\Users\Robin\Applications Dev\Flint\brand_context\samples.md`:
```markdown
# Content Samples

<!-- Built by start-here skill. Run /start-here to populate.

Paste 2-3 examples of your best content here.
Flint reads these before writing anything to match your voice exactly. -->
```

- [ ] **Step 5: Create brand_context/assets.md**

Create `C:\Users\Robin\Applications Dev\Flint\brand_context\assets.md`:
```markdown
# Brand Assets

<!-- Fill in manually or via start-here skill.

Covers:
- Website URL
- Social handles
- Key product / service names
- Standard boilerplate / disclaimers
- Links you frequently reference -->
```

- [ ] **Step 6: Verify all brand_context files exist**

```powershell
Get-ChildItem brand_context\
```
Expected: voice-profile.md, positioning.md, icp.md, samples.md, assets.md — all listed

- [ ] **Step 7: Commit**

```powershell
git add brand_context\
git commit -m "feat: brand_context stub files (start-here fills these via interview)"
```

---

### Task 4: Heartbeat Skill

**Files:**
- Create: `skills\heartbeat\SKILL.md`

**Interfaces:**
- Consumes: `CLAUDE.md` (reads `## Skill Registry`, `## MCP Servers`, `## Last Heartbeat` sections and updates them), `.claude/settings.json` (reads `mcpServers` keys)
- Produces: Updated CLAUDE.md with current skill list, MCP servers, and timestamp. All sessions depend on this running first.

- [ ] **Step 1: Create skills/heartbeat/SKILL.md**

Create `C:\Users\Robin\Applications Dev\Flint\skills\heartbeat\SKILL.md`:
```markdown
# Skill: Heartbeat

## Purpose
Self-maintenance scan at session start. Keeps CLAUDE.md skill registry in sync with what's on disk. Runs automatically — never skip it.

## Trigger
Runs at every session start per CLAUDE.md Session Rule 1.
Also triggered by: "run heartbeat", "sync skills", "refresh registry".

## Prerequisites
- CLAUDE.md exists in project root with `## Skill Registry`, `## MCP Servers`, and `## Last Heartbeat` sections
- skills/ directory exists

## Steps

1. **Scan skills/ directory**
   - List every direct subdirectory of skills/ that contains a SKILL.md file
   - For each, record: folder name (= skill name) and the line immediately after `## Purpose` in that SKILL.md (= description)
   - Example: `skills/heartbeat/SKILL.md` → skill name `heartbeat`, description `Self-maintenance scan at session start.`

2. **Load current registry**
   - Read the `## Skill Registry` section from CLAUDE.md
   - Parse each line matching `- skill-name: description`

3. **Diff and update registry**
   - Found on disk but missing from registry → add as `- skill-name: description`
   - In registry but no longer on disk → remove that line
   - On disk with changed description → update the line
   - Write the updated `## Skill Registry` section back to CLAUDE.md (preserve the `<!-- Heartbeat maintains this -->` comment)

4. **Scan MCP servers**
   - Check if `.claude/settings.json` exists in the project root
   - If yes, read the `mcpServers` object — each key is a server name
   - Compare server names against `## MCP Servers` section in CLAUDE.md
   - For any new server not already listed, add: `- server-name: (detected from .claude/settings.json)`
   - Do not remove or modify existing MCP entries

5. **Update timestamp**
   - Replace the content of `## Last Heartbeat` with: `<!-- YYYY-MM-DD HH:MM -->` using the current local date and time

6. **Report**
   - If changes: `Heartbeat: N skills registered, +N new, -N removed`
   - If no changes: `Heartbeat: all N skills current — YYYY-MM-DD HH:MM`

## Output
Updated CLAUDE.md: current skill registry, detected MCP servers, current timestamp.

## Edge Cases
- skills/ subfolder with no SKILL.md → skip silently, do not register
- CLAUDE.md missing a required section → create the section with correct markdown heading
- .claude/settings.json missing or invalid JSON → skip MCP scan, append `(MCP scan skipped — settings.json missing)` to report
```

- [ ] **Step 2: Verify skill steps are unambiguous**

Read through each step. Every step must be specific enough to execute without asking clarifying questions. Confirm: step 1 gives the exact extraction rule. Step 3 gives the exact line format. Step 5 gives the exact timestamp format.

- [ ] **Step 3: Commit**

```powershell
git add skills\heartbeat\
git commit -m "feat: heartbeat skill — self-maintaining CLAUDE.md registry"
```

---

### Task 5: Wrap-up Skill

**Files:**
- Create: `skills\wrap-up\SKILL.md`

**Interfaces:**
- Consumes: `context/learnings.md` (appends new entry to top), git repo (stages and commits all changes)
- Produces: Updated `context/learnings.md`, new `context/YYYY-MM-DD.md` daily log, git commit

- [ ] **Step 1: Create skills/wrap-up/SKILL.md**

Create `C:\Users\Robin\Applications Dev\Flint\skills\wrap-up\SKILL.md`:
```markdown
# Skill: Wrap-up

## Purpose
Session close workflow. Summarises session, logs learnings, writes daily log, commits everything to git, re-syncs registry.

## Trigger
Robin says any of: "wrap up", "close", "done for today", "wrap", "end session".

## Prerequisites
- git initialised in project root
- context/learnings.md exists

## Steps

1. **Summarise session**
   List (bullet points, max 10 items each):
   - What was accomplished this session
   - Decisions made
   - Open threads (things started but not finished)
   Present this summary to Robin before continuing.

2. **Collect feedback**
   Ask Robin one question: "Anything that worked well, or should be different next time?"
   Wait for answer. If Robin says "nothing", "no", or "all good" → record "no feedback this session".

3. **Append to context/learnings.md**
   Add a new entry at the TOP of the file (newest first):
   ```
   ## YYYY-MM-DD
   **Accomplished:** [bullet summary from step 1]
   **Decisions:** [decisions from step 1, or "none"]
   **Open threads:** [open threads from step 1, or "none"]
   **Feedback:** [Robin's answer from step 2]
   ```

4. **Write daily log**
   Create (or overwrite) `context/YYYY-MM-DD.md`:
   ```markdown
   # Session Log — YYYY-MM-DD

   ## Accomplished
   [bullet list]

   ## Decisions
   [bullet list or "none"]

   ## Open Threads
   [bullet list or "none"]

   ## Next Session
   [one suggested starting point based on open threads]
   ```

5. **Git commit**
   ```
   git add -A
   git commit -m "session: YYYY-MM-DD — [one-line summary of main accomplishment]"
   ```

6. **Re-run heartbeat**
   Execute the heartbeat skill to sync registry before closing.

7. **Report**
   Say: "Session closed. Learnings saved. Committed. See you next time."

## Output
- Updated context/learnings.md (new entry at top)
- New context/YYYY-MM-DD.md
- Git commit with session summary

## Edge Cases
- git not initialised → warn Robin, skip commit step, still write learnings and daily log
- Robin triggers wrap-up with nothing accomplished → still write the log with "No tasks completed this session"
```

- [ ] **Step 2: Commit**

```powershell
git add skills\wrap-up\
git commit -m "feat: wrap-up skill — session close, learnings, daily log, git commit"
```

---

### Task 6: Start-here Skill

**Files:**
- Create: `skills\start-here\SKILL.md`

**Interfaces:**
- Produces: Populated `brand_context/` files — all other skills read from these before generating output

- [ ] **Step 1: Create skills/start-here/SKILL.md**

Create `C:\Users\Robin\Applications Dev\Flint\skills\start-here\SKILL.md`:
```markdown
# Skill: Start Here

## Purpose
One-time brand context interview. Asks Robin 5 questions and writes the answers into brand_context/. Re-run anytime to refresh brand context.

## Trigger
Robin says: "start here", "setup", "build my brand context", "run start-here".
Also auto-triggers if brand_context/voice-profile.md contains only comments (never been filled in).

## Prerequisites
- brand_context/ directory exists (stub files are fine — this skill overwrites them)

## Steps

1. **Announce**
   Say: "I'll ask you 5 questions to build your brand context. One at a time — just answer naturally."

2. **Question 1 — Voice & Tone**
   Ask: "How do you like to communicate? Describe your tone — casual or formal, direct or warm, any humour? Any words or phrases you love or avoid?"
   Wait for full answer before continuing.

3. **Question 2 — Positioning**
   Ask: "What makes you or your business different? What's your unique angle — what do you offer that alternatives don't?"
   Wait for full answer before continuing.

4. **Question 3 — Ideal Customer**
   Ask: "Who do you serve? Describe your ideal customer — who they are, what problem they're trying to solve, what they've already tried."
   Wait for full answer before continuing.

5. **Question 4 — Business Goals**
   Ask: "What are you trying to achieve in the next 90 days? Be specific — revenue targets, content output, launches, audience growth."
   Wait for full answer before continuing.

6. **Question 5 — Content Examples**
   Ask: "Share 2-3 examples of your best content or output — an email, post, message, or document you're proud of. Paste them here."
   Wait for full answer before continuing.

7. **Write brand_context/ files**
   Using the answers collected, write all 5 files now:

   **brand_context/voice-profile.md** — structured version of Q1 answer:
   ```markdown
   # Voice Profile
   [Extract and structure: tone descriptors, words to use, words to avoid,
    sentence length, formality level, any example phrases Robin provided]
   ```

   **brand_context/positioning.md** — structured version of Q2 answer:
   ```markdown
   # Positioning
   [Extract: what the business does, who for, key differentiator, unique angle]
   ```

   **brand_context/icp.md** — structured version of Q3 answer:
   ```markdown
   # Ideal Customer Profile
   [Extract: who they are, their core problem, what they've tried, what success looks like]
   ```

   **brand_context/samples.md** — Q5 answer verbatim:
   ```markdown
   # Content Samples
   [Paste Robin's examples exactly as given — Flint reads these to match voice]
   ```

   **brand_context/assets.md** — leave as stub with a note:
   ```markdown
   # Brand Assets
   <!-- Fill in manually: website URL, social handles, product names, boilerplate, key links -->
   ```

8. **Confirm**
   Say: "Brand context built. Files written:" then list each file with one line describing what's now in it.
   Say: "Edit any file directly, or run /start-here again to redo the interview."

## Output
Populated brand_context/ directory. All skills now have access to Robin's voice, positioning, ICP, and sample outputs.

## Edge Cases
- Robin skips a question (says "skip") → write `<!-- Skipped during interview — fill in manually -->` in that file
- Robin wants to update one section only → ask which question to re-run, update only that file
```

- [ ] **Step 2: Commit**

```powershell
git add skills\start-here\
git commit -m "feat: start-here skill — brand context interview"
```

---

### Task 7: Daily Briefing Skill

**Files:**
- Create: `skills\daily-briefing\SKILL.md`

**Interfaces:**
- Consumes: `context/memory.md`, `context/learnings.md`, `context/YYYY-MM-DD.md` (yesterday's log if it exists)
- Produces: Structured briefing printed to chat. No files written (except when run via cron — see Edge Cases).

- [ ] **Step 1: Create skills/daily-briefing/SKILL.md**

Create `C:\Users\Robin\Applications Dev\Flint\skills\daily-briefing\SKILL.md`:
```markdown
# Skill: Daily Briefing

## Purpose
Morning summary of priorities, open threads, and what Flint remembers from last session. Gives Robin a fast, grounded start to the day.

## Trigger
Robin says: "daily briefing", "morning briefing", "what's on today", "brief me".
Also runs automatically when scheduled via .cron/schedule.json.

## Prerequisites
- context/memory.md exists (can be empty)
- context/learnings.md exists (can be empty)

## Steps

1. **Read context**
   - Read context/memory.md — note any stated priorities, ongoing projects, key facts
   - Read context/learnings.md — read the most recent entry (top of file) for open threads and feedback
   - Check if `context/[yesterday's date].md` exists — if yes, extract its "Open Threads" and "Next Session" sections

2. **Compose briefing**
   Format the output exactly as:

   ```
   # Flint — Daily Briefing [WEEKDAY DD MONTH YYYY]

   ## Top Priorities
   [3-5 bullet points drawn from memory.md and open threads.
    If memory is empty: "No priorities logged yet — tell me what you're working on."]

   ## Open Threads
   [Unresolved items from the most recent session log or learnings entry.
    If none: "No open threads."]

   ## Flint Remembers
   [2-3 relevant facts from memory.md useful for today.
    If memory is empty: "Memory is empty — I'll start building it as we work today."]

   ## Yesterday
   [One-line summary of yesterday's session log if it exists.
    If not: "No log from yesterday."]
   ```

3. **Deliver and offer**
   Print the briefing, then say: "What would you like to work on?"

## Output
Briefing printed to chat. No files modified.

## Edge Cases
- All context files empty (very first session) → deliver a "fresh start" briefing:
  "Memory is empty and no past sessions found. Run /start-here to build your brand context, or just tell me what you're working on."
- Run multiple times in one day → deliver again, note: "(repeat briefing — context unchanged since this morning)"
- Run via cron with no active chat → write briefing to `context/YYYY-MM-DD-briefing.md` instead of printing to chat
```

- [ ] **Step 2: Commit**

```powershell
git add skills\daily-briefing\
git commit -m "feat: daily-briefing skill — morning summary from memory and session logs"
```

---

### Task 8: Support Stubs + Smoke Test

**Files:**
- Create: `.cron\schedule.json`
- Create: `.claude\settings.json`

**Interfaces:**
- `.cron/schedule.json` — stub for heartbeat to detect; daemon wired in Sub-project 3
- `.claude/settings.json` — read by heartbeat for MCP server names; empty mcpServers at start

- [ ] **Step 1: Create .cron/schedule.json**

Create `C:\Users\Robin\Applications Dev\Flint\.cron\schedule.json`:
```json
{
  "_comment": "Scheduled skill chains. Cron daemon wired in Sub-project 3.",
  "schedules": [
    {
      "name": "Morning Briefing",
      "cron": "0 7 * * 1-5",
      "chain": ["daily-briefing"],
      "description": "Weekday morning summary — activate in Sub-project 3"
    }
  ]
}
```

- [ ] **Step 2: Create .claude/settings.json**

Create `C:\Users\Robin\Applications Dev\Flint\.claude\settings.json`:
```json
{
  "mcpServers": {}
}
```

- [ ] **Step 3: Final commit**

```powershell
git add .cron\ .claude\
git commit -m "feat: .cron schedule stub and .claude/settings.json MCP config"
```

- [ ] **Step 4: Verify complete git log**

```powershell
git log --oneline
```
Expected (newest first):
```
feat: .cron schedule stub and .claude/settings.json MCP config
feat: daily-briefing skill — morning summary from memory and session logs
feat: start-here skill — brand context interview
feat: wrap-up skill — session close, learnings, daily log, git commit
feat: heartbeat skill — self-maintaining CLAUDE.md registry
feat: brand_context stub files (start-here fills these via interview)
feat: scaffold, CLAUDE.md, context files, and design spec
```

- [ ] **Step 5: Smoke test — open Flint in Claude Code**

```powershell
cd "C:\Users\Robin\Applications Dev\Flint"
claude
```

On the first message, verify Claude:
1. Acknowledges reading context/soul.md, user.md, memory.md, learnings.md
2. Reports heartbeat: `Heartbeat: 4 skills registered`
3. Last Heartbeat section in CLAUDE.md is updated to today's date/time

Check CLAUDE.md after:
```powershell
Get-Content CLAUDE.md | Select-String "Last Heartbeat" -A 1
```
Expected: shows today's date and time

- [ ] **Step 6: Test heartbeat auto-discovery**

Without closing Claude Code, create a test skill folder:
```powershell
New-Item -ItemType Directory -Force -Path skills\test-skill
"# Skill: Test Skill`n`n## Purpose`nTest skill for heartbeat verification." | Out-File -FilePath skills\test-skill\SKILL.md
```

Ask Flint: "run heartbeat"

Expected: `Heartbeat: 5 skills registered, +1 new (test-skill)`

Verify CLAUDE.md Skill Registry now includes `- test-skill: Test skill for heartbeat verification.`

Then clean up:
```powershell
Remove-Item -Recurse -Force skills\test-skill
```
Ask Flint: "run heartbeat" again.
Expected: `Heartbeat: 4 skills registered, -1 removed (test-skill)`

---

## What Comes Next (Sub-project 2)

Once this plan is complete and the smoke test passes, the Agentic OS Brain is live. Next sub-projects:

| Sub-project | What it adds |
|---|---|
| 2 — Mission Control Dashboard | Node.js server, WebSocket, tmux-equivalent on Windows, live agent view |
| 3 — Multi-LLM Model Router | OpenRouter, tier config, task-type routing, budget caps |
| 4 — PM Module | SQLite task/cost tables, Gantt, team isolation |
| 5 — Multi-agent Isolation | Forgejo, git worktrees, PR-based merge flow |

# Flint — Agentic OS Brain: Design Spec
**Sub-project 1 of 5**
**Date:** 2026-06-22
**Status:** Approved

---

## 1. Problem

A single intelligent agent that knows who Robin is, remembers everything across sessions, improves from feedback, and runs modular skills — without any infrastructure overhead. Foundation for the full Flint platform (dashboard, model router, PM module) which are separate sub-projects.

---

## 2. Scope

**In:** Identity layer, memory layer, skill system, heartbeat, wrap-up, start-here, daily-briefing, brand context, git.

**Out (later sub-projects):**
- Mission Control Dashboard (Sub-project 2)
- Multi-LLM Model Router (Sub-project 3)
- Project Management Module (Sub-project 4)
- Multi-agent isolation, Forgejo, tmux (Sub-project 5)
- Supabase/pgvector — add at Level 3 when memory chunks exceed 100

---

## 3. Platform

- **OS:** Windows 11 (local machine)
- **Runtime:** Claude Code
- **Root:** `C:\Users\Robin\Applications Dev\Flint\`
- **Memory level:** Level 2 (folder structure, no hooks needed — CLAUDE.md instruction is sufficient)

---

## 4. Directory Structure

```
Flint\
├── CLAUDE.md                    ← thin registry, heartbeat auto-maintains
├── .gitignore
│
├── context\
│   ├── soul.md                  ← Flint's identity & values
│   ├── user.md                  ← Robin's preferences & working style
│   ├── memory.md                ← long-term business knowledge
│   └── learnings.md             ← session feedback loop
│
├── brand_context\
│   ├── voice-profile.md
│   ├── positioning.md
│   ├── icp.md
│   ├── samples.md
│   └── assets.md
│
├── skills\
│   ├── heartbeat\SKILL.md
│   ├── wrap-up\SKILL.md
│   ├── start-here\SKILL.md
│   └── daily-briefing\SKILL.md
│
├── .cron\schedule.json          ← stub, wired up in Sub-project 3
├── docs\superpowers\specs\      ← design specs
│
└── Flint\                       ← existing PRD + research (untouched)
```

---

## 5. CLAUDE.md

Thin instruction layer and auto-maintained skill registry. Hard limit: stay under 200 lines.

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

---

## 6. Skill Designs

### heartbeat
Runs at every session start.

1. Scan `skills/` — list all `SKILL.md` files on disk
2. Compare against Skill Registry in `CLAUDE.md`
3. Add new skills, remove deleted ones, update changed descriptions
4. Scan `.claude/settings.json` (project-local) for MCP servers → register any new ones
5. Write updated registry + `## Last Heartbeat: YYYY-MM-DD HH:MM` to `CLAUDE.md`
6. Report: `"Heartbeat: N skills registered, N new, N removed"`

### wrap-up
Triggered by: "wrap up" / "close" / "done for today"

1. List what was accomplished this session
2. Ask Robin for feedback — one question: what worked / what didn't
3. Append feedback + date to `context/learnings.md`
4. Create `context/YYYY-MM-DD.md` daily log with: accomplished, decisions, next steps
5. Git commit all changes — message summarises session
6. Re-run heartbeat to sync registry
7. Report: `"Session closed. Learnings saved. Committed."`

### start-here
One-time brand context builder. Re-run to update.

1. Tell Robin: "I'll ask you 5 questions to build your brand context. One at a time."
2. Ask in sequence (one per message, wait for answer):
   - Voice & tone: how do you like to communicate?
   - Positioning: what makes you / your business different?
   - Ideal customer: who do you serve, what problems do they have?
   - Business goals: what are you trying to achieve in the next 90 days?
   - Content examples: share 2-3 examples of your best output
3. Write answers to `brand_context/` files (voice-profile, positioning, icp, samples, assets)
4. Confirm each file written
5. Report: `"Brand context built. Run /daily-briefing or ask me anything."`

### daily-briefing
Morning summary. Also schedulable via `.cron/schedule.json`.

1. Read `context/memory.md` + `context/learnings.md`
2. Read `context/YYYY-MM-DD.md` from yesterday if it exists
3. Output:
   - **Top priorities** (from memory + open threads)
   - **Open threads** (unresolved items from last session)
   - **What Flint remembers** (relevant recent context)

---

## 7. Context Files (Initial State)

All files are created as stubs at scaffold time. Content is filled by skills or Robin directly.

**soul.md** — Flint's stable identity. Robin fills once, rarely changes.
**user.md** — Robin's preferences. Updated as working style evolves.
**memory.md** — Empty at start. Grows organically each session.
**learnings.md** — Empty at start. Wrap-up appends after every session.
**brand_context/** — All files empty at start. `start-here` fills via interview.

---

## 8. Git Setup

```
git init
git add .
git commit -m "Flint: initial scaffold"
```

`.gitignore`:
```
.env
*.sqlite
node_modules/
```

Wrap-up commits after every session — memory, learnings, and skill changes are version-controlled. No remote, no branches, no CI yet.

ponytail: add remote when Sub-project 2 (Dashboard + Forgejo) needs it.

---

## 9. What's Deliberately Excluded

| Excluded | Reason | When |
|---|---|---|
| Session-start shell hooks | CLAUDE.md instruction is sufficient for Level 2 | Never unless retrieval fails |
| Supabase/pgvector | Level 3 memory — overkill under 100 chunks | Sub-project 3+ |
| `references/` subfolders in skills | Add when a skill needs brand docs injected | Per skill, as needed |
| Model router config | Sub-project 3 | Phase 4 |
| Dashboard / SQLite | Sub-project 2 | Phase 2 |
| Forgejo / tmux / worktrees | Sub-project 5 | Phase 5 |
| `.cron/` wiring | Stub only — daemon in Sub-project 3 | Phase 3 |

---

## 10. Success Criteria

- [ ] Claude Code reads soul.md, user.md, memory.md, learnings.md at session start
- [ ] Heartbeat detects a new skill folder and updates CLAUDE.md within same session
- [ ] Wrap-up appends to learnings.md and commits to git
- [ ] Start-here builds all brand_context/ files via interview
- [ ] Daily-briefing produces a useful morning summary from memory
- [ ] CLAUDE.md stays under 200 lines

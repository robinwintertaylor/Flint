# Research: TANK — Mike Russell's Mission Control for Claude Code
*Research compiled June 2026 from YouTube channel @CreatorMagicAI, video descriptions, and secondary sources*

---

## What is TANK?

**TANK** is Mike Russell's (Creator Magic) private, self-hosted **"mission control"** for Claude Code. It is a browser-based dashboard that lets you spin up, monitor, and orchestrate multiple sandboxed Claude Code agents simultaneously — all running on your own server with nothing leaving except Anthropic API calls.

> *"I built my own mission control for Claude Code and it's the one setup that's still allowed after the bans and billing chaos this year."*
> — Mike Russell, @CreatorMagicAI

TANK is **not open source**. It lives inside the Creator Magic Premium community (mrc.fm/premium). The full source is a snapshot — no support, bring your own Claude plan (Max/Pro).

**Discount code:** `TANK` (first 3 months)

---

## Key Videos

| Video | ID | Title |
|-------|----|-------|
| Primary TANK demo | hXWwqPgexZU | My Exact Claude Code Setup Still Allowed After Ban |
| Context / follow-up | mhqAHxvareo | Claude Fable 5 Runs My Entire Life (5 Builds) |

---

## Why Mike Built TANK

From the video description:

- **GitHub removed** — moved to **Forgejo** (self-hosted git) so nothing leaves the server except Anthropic API calls
- **Bans and billing chaos** — Anthropic cracked down on programmatic API credit usage (April cutoff and June 15 2026 change). TANK is designed to stay on the right side of Anthropic ToS because it runs Claude Code directly (your own subscription), not via API automation
- **Full control** — "I can spin up as many agents as I want, each one sandboxed, and watch every single one work live in the browser"
- **Privacy** — "runs entirely on my own server" — no cloud dependency, no data sent to third parties

---

## Architecture

### Infrastructure Layer

| Component | Tool Used | Purpose |
|-----------|-----------|---------|
| Git hosting | **Forgejo** (self-hosted) | Replaces GitHub — all repos stay on-server |
| Session management | **tmux** | Persistent terminal sessions per agent — survive disconnects |
| Storage | **SQLite** | Real-time usage tracking, task database |
| Server | Own VPS/dedicated box | Everything self-hosted, nothing leaves except Anthropic calls |
| Permissions mode | `--dangerously-skip-permissions` | Claude Code runs without permission prompts (powerful, run isolated) |

### Agent Layer

- **Multiple Claude Code instances** — each agent runs as its own Claude Code process
- **Sandboxed per agent** — isolation prevents agents overwriting each other's work
- **Git worktrees** — each agent gets its own isolated working folder and branch; merged when done
- **Sub-agents** — agents can spawn sub-agents for deep research tasks (multi-level orchestration)

### Dashboard Layer

- **Browser-based UI** — live view of every agent working in real-time
- **Self-building** — the dashboard builds its own features (Mike demos it adding a "repo flattener" on camera)
- **Drag and drop** — can drag and drop screenshots directly into Claude Code for visual input
- **Project icons** — visual project identification in the dashboard
- **General LLM mode** — multitask mode that can also run general-purpose LLM queries (not just code agents)

### Integration Layer

- **Markdown To-Do Lists** — agents read and write markdown task files
- **Terminal Hooks** — Claude Code's built-in hook system (session/tool-use events) for orchestration
- **Pull Request flow** — agents open real PRs into Forgejo repos; Mike merges from dashboard
- **Visual input** — screenshots can be dropped into agents for context

---

## Chapter Breakdown (Full Video)

From the video `hXWwqPgexZU` chapter timestamps:

| Timestamp | Chapter |
|-----------|---------|
| 0:00 | Introduction: Mission Control for Claude Code |
| 0:34 | Starting a New Task & UI Overview |
| 1:16 | Anthropic Terms of Service & Terminal Hooks |
| 2:49 | Why Build "Tank" & Moving Away from GitHub |
| 3:52 | Markdown To Do List Integration |
| 5:10 | Creating a Repo Flattening Feature |
| 6:57 | Multitasking & General LLM Queries |
| 8:35 | Real Time Usage Tracking & Database Storage |
| 9:59 | Persistent Sessions with tmux & Drag and Drop Images |
| 11:39 | Completing & Testing the Repo Flattening Feature |
| 13:23 | Visual Input Testing with Screenshots |
| 15:11 | Project Icon Customization |
| 15:36 | Security Warnings, Community Access & Wrap Up |

---

## Compliance & Safety Notes

Mike is explicit about the compliance angle:

- TANK runs Claude Code via **your own subscription** (Max/Pro) — no programmatic API credit purchasing
- This keeps it on the right side of Anthropic's ToS after April 2026 cutoff
- Designed to survive the June 15 2026 programmatic credit rule change
- **Security caveat:** every agent runs with `--dangerously-skip-permissions` — "run it isolated, locked down, and never as root"

---

## What TANK Is NOT

- **Not a Claude API automation tool** — uses Claude Code subscriptions, not API credits
- **Not open source** — private snapshot in Creator Magic Premium
- **Not a multi-channel messaging gateway** (that's OpenClaw, a different tool)
- **Not a memory/OS system** (that's Simon Scrapes' Agentic OS)

---

## TANK vs. OpenClaw vs. Simon Scrapes Agentic OS

| Dimension | TANK (Mike Russell) | OpenClaw | Simon Scrapes Agentic OS |
|-----------|-------------------|----------|--------------------------|
| **Core purpose** | Multi-agent mission control dashboard | Multi-channel AI agent gateway | Self-maintaining agent OS |
| **Interface** | Browser dashboard (self-built) | Web UI + messaging channels | CLI / Claude Code |
| **Agent isolation** | Git worktrees per agent | Isolated sessions | Single agent with skill chains |
| **Git** | Forgejo (self-hosted) | Not applicable | Git for version control |
| **Sessions** | tmux persistent sessions | Daemon process | Session → daily logs |
| **Memory** | SQLite for usage/tasks | Markdown + SQLite | Multi-tier markdown files |
| **Scheduling** | Manual / task-based | Heartbeat scheduler | Cron skill chains |
| **Model** | Claude Code (subscription) | Any (Claude/GPT/Gemini/Ollama) | Claude Code (subscription) |
| **Availability** | Private/paywalled | Open source (MIT) | Patterns published on blog |
| **Deployment** | Own VPS | Own server or cloud | Local or server |

---

## Mike Russell — Presenter Profile

- **Name:** Mike Russell
- **Brand:** Creator Magic
- **GitHub:** github.com/imikerussell (5 public repos — TANK is not public)
- **X:** @imikerussell
- **Community:** mrc.fm/cmc (160+ builders, $47/mo → rising to $97)
- **Premium:** mrc.fm/premium (includes TANK source code)
- **Focus:** Helping non-technical creators build and ship real-world AI applications, no-code & vibe coding
- **Channel:** youtube.com/@CreatorMagicAI (204k subscribers)

---

## Key Quotes

> *"I can spin up as many agents as I want, each one sandboxed, and watch every single one work live in the browser."*

> *"It runs entirely on my own server. No GitHub, I use Forgejo for self hosted git. Nothing leaves the building except the calls to Anthropic."*

> *"I get the dashboard to build itself a brand new feature on camera."*

> *"The full source is in my premium community as a snapshot, as is, with no support - bring your own Claude."*

> *"Every agent runs with permissions skipped, because I like to live dangerously. It's powerful and a little bit dangerous, so run it isolated, locked down, and never as root."*

---

## Sources

- [YouTube: My Exact Claude Code Setup Still Allowed After Ban](https://youtu.be/hXWwqPgexZU) — Primary TANK demo
- [YouTube: Claude Fable 5 Runs My Entire Life (5 Builds)](https://youtu.be/mhqAHxvareo) — Context/follow-up
- [Creator Magic Community](https://mrc.fm/cmc) — Where TANK source lives (paywalled)
- [Creator Magic Premium](https://mrc.fm/premium) — Snapshot source access
- [GitHub: imikerussell](https://github.com/imikerussell) — Mike's public repos (TANK not public)

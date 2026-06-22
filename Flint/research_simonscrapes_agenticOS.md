# Research: Simon Scrapes — Agentic OS & Claude Memory System
*Research compiled June 2026 from YouTube channel @simonscrapes and marketingagent.blog*

---

## Overview

Simon Scrapes built a **self-maintaining Agentic Operating System** on top of Claude Code. Unlike typical Claude setups that treat each skill as an isolated tool, this architecture chains skills into a living OS that:
- Builds its own brand context automatically
- Learns from session feedback and updates itself
- Keeps its own skill registry in sync without manual intervention
- Runs business operations autonomously on a cron schedule

**Core philosophy:** Most Claude Code setups treat skills as isolated tools — one for copy, one for research, never connected. The Agentic OS chains them into a self-maintaining operating system.

---

## Key Videos from @simonscrapes

| Video | Video ID | Topic |
|-------|----------|-------|
| Claude Code Agentic OS… It Remembers Everything | F4At4St1iH8 | Core Agentic OS architecture |
| Claude Code Agentic OS = UNSTOPPABLE | pfPi04pIfaw | Advanced OS capabilities |
| I Built The Best Claude Memory System (Beats Hermes) | H9BUkgDf5Y4 | Memory architecture |
| I Turned Claude Into the Ultimate Second Brain | 8QQ_INxAhRs | Second brain implementation |
| Claude Can Now Dream - Memory of Agentic AI Explained! | 7YmA1MvKnuA | Auto-memory / Dream feature |
| Claude Code + Graphify = Insane Agentic OS | Owv503rTqYY | Graph-based memory layer |
| I Made Claude Code FOR TEAMS (It's Incredible) | TE6zNesGcvY | Team-wide Agentic OS |
| How Smart People Are Using Claude Code Skills | 5AfSB0sWihw | Skill automation patterns |
| 14 GENIUS Ways to Give Claude Code SUPERPOWERS | mNawxNjrR_E | Capability extensions |
| How to Teach Claude to Write Content Like You | yh_fZZVbNwc | Brand voice training |
| Claude Code Has Become DANGEROUS | ARJMA4kvWWg | Advanced autonomy showcase |
| **Every Claude Code Memory System Compared** | **UHVFcUzAGlM** | **The 6 Levels of AI Memory — comprehensive comparison** |

---

## The Agentic OS Architecture

### Layer 1: Skill Anatomy

Every skill is a **folder** with two components:

```
skills/
└── my-skill/
    ├── SKILL.md          # Step-by-step process instructions
    └── references/       # Brand voice docs, templates, API guides, examples
        ├── brand-voice.md
        ├── example-outputs.md
        └── api-guide.md
```

- **SKILL.md** defines the repeatable process (how to do the task)
- **references/** injects deep business knowledge into the process
- Skills pulled from GitHub/marketplace are intentionally generic — you must populate the knowledge layer with real brand data to make them production-ready

### Layer 2: Shared Brand Context

All skills point to one central `brand_context/` folder:

```
brand_context/
├── voice-profile.md       # Tone, language, style
├── positioning.md         # Market position, differentiators
├── icp.md                 # Ideal customer profile
├── samples.md             # Example outputs
└── assets.md              # Key brand assets, links
```

- Copywriting, content repurposing, and research skills all pull from the **same** brand_context
- One source of truth — no duplication across skills
- Built automatically by running `start here` which interviews you and runs three foundation skills: brand voice extraction → positioning → ICP

### Layer 3: Memory & Identity (context/ folder)

```
context/
├── soul.md          # Agent identity: how it behaves, communicates, values
├── user.md          # Your preferences, working style, communication preferences
├── memory.md        # Long-term business knowledge
├── learnings.md     # Post-session feedback that skills read on next run
└── YYYY-MM-DD.md    # Daily session logs for continuity
```

**soul.md** — The agent's identity:
- How it behaves and communicates
- Core values and personality
- What it will and won't do

**user.md** — Your profile:
- Communication preferences
- Working style
- How you like to receive information

**memory.md** — Long-term knowledge:
- Business facts that persist across sessions
- Key decisions and context
- Project history

**learnings.md** — The feedback loop:
- Skills log post-deliverable feedback here
- At session end, skills auto-update their own SKILL.md files based on feedback
- Next run reads these learnings first → continuous improvement

### Layer 4: The Heartbeat (Self-Maintenance)

At every session start, the Heartbeat automatically:

1. **Scans** the `skills/` folder
2. **Compares** what's on disk against the registry in `CLAUDE.md` and `README`
3. **Registers** new skills found on disk
4. **Removes** stale entries no longer present
5. **Detects** newly added MCP servers
6. **Interlinks** skill dependencies

Result: The OS maintains itself — no manual registry updates needed.

**7 context files the Heartbeat reads at session start:**
1. CLAUDE.md (system prompt + skill registry)
2. soul.md
3. user.md
4. memory.md
5. learnings.md
6. brand_context/ (all files)
7. Skill YAML front matter (for overlap detection)

### Layer 5: Skill Chains

Skills connect sequentially to build pipelines:

```
Trending Research Skill
    ↓ saves brief
Content Repurposing Skill
    ↓ ingests brief + video transcript
Newsletter Skill
    ↓ informed by brand_context + learnings
Published Output
```

**Overlap detection:** Before creating any new skill, the system reads every installed skill's front matter to map overlaps and prevent duplication.

### Layer 6: The Wrap-Up Skill

Triggered with "close session" or "wrap things up":

1. Reviews all deliverables from the session
2. Collects feedback from you
3. Patches skill.md files with that feedback
4. Commits all work via git
5. Re-runs the Heartbeat to sync the registry

### Layer 7: Cron Scheduling

Skills chains run on a set schedule without human initiation:
- Research workflows run daily
- Content production runs weekly
- Reporting runs monthly
- No manual triggering needed

---

## The Memory System Deep-Dive

### Auto-Memory / "Dream" Feature
Claude now has a native memory consolidation mechanism (the "Dream" feature) that:
- Automatically distills session learnings into persistent memory
- Works like human sleep consolidation — important things stick, noise fades
- Feeds back into future sessions without manual curation

### Three Memory Tiers

| Tier | Storage | Purpose | Lifespan |
|------|---------|---------|----------|
| Session memory | Active context window | Current task state | Session only |
| Working memory | learnings.md + daily logs | Recent feedback and continuity | Days/weeks |
| Long-term memory | memory.md + soul.md | Core identity and business knowledge | Permanent |

### Team-Wide Memory (Advanced)

For teams, memory is extended with:
- **PostgreSQL with Row-Level Security (RLS)** — multi-client isolation
- **Supabase + pgvector** — vector search over memory
- **Notion as knowledge base** — human-readable, agent-accessible
- **Google Drive integration** — document library access
- **Three-tier file architecture** — CLAUDE.md (system), project-level context, user-level overrides (CLAUDE.local.md)

### Vendor-Agnostic Memory Design

The architecture is intentionally portable:
- All memory stored as **markdown files** — plain text, readable by any LLM
- No vendor lock-in — switch from Claude to GPT-4o and the same memory files work
- Credential vault via MCP server for secure key management
- Mem0 for semantic memory layer (optional, adds search capability)

---

## Complete Directory Structure

```
project-root/
├── CLAUDE.md                    # System prompt + skill registry (Heartbeat updates this)
├── README.md                    # Human-readable project docs
│
├── brand_context/               # Shared knowledge for all skills
│   ├── voice-profile.md
│   ├── positioning.md
│   ├── icp.md
│   ├── samples.md
│   └── assets.md
│
├── context/                     # Memory & identity
│   ├── soul.md
│   ├── user.md
│   ├── memory.md
│   ├── learnings.md
│   └── 2026-06-22.md           # Daily log
│
├── skills/                      # Skill library
│   ├── research/
│   │   ├── SKILL.md
│   │   └── references/
│   ├── content-repurposing/
│   │   ├── SKILL.md
│   │   └── references/
│   ├── heartbeat/               # Self-maintenance skill
│   │   └── SKILL.md
│   ├── start-here/              # Brand context builder
│   │   └── SKILL.md
│   └── wrap-up/                 # Session closer
│       └── SKILL.md
│
├── projects/                    # Active project folders
│   └── project-a/
│       └── context.md
│
└── .cron/                       # Scheduled chains
    └── schedule.json
```

---

## Key Differentiators vs. Standard Claude Code

| Feature | Standard Claude Code | Simon Scrapes Agentic OS |
|---------|---------------------|--------------------------|
| Skills | Isolated, manual | Chained, auto-registered |
| Memory | Session only | Multi-tier, persistent |
| Identity | Generic | soul.md + user.md |
| Learning | None | learnings.md feedback loop |
| Maintenance | Manual | Heartbeat self-sync |
| Scheduling | None | Cron skill chains |
| Brand context | Per-session | Shared brand_context/ |
| Team support | None | RLS + Supabase + Notion |

---

---

## The 6 Levels of Claude Code Memory
*From video: "Every Claude Code Memory System Compared (So You Don't Have To)" (UHVFcUzAGlM)*

Simon Scrapes maps every Claude Code memory approach into a six-level framework, helping builders pick the right architecture without over-engineering.

### Level 1 — Native (CLAUDE.md + memory.md)
**What:** The two files Claude Code ships with — no plugin, no database, no hooks.
- **CLAUDE.md** — you write it; loaded at every session start as an authoritative system prompt
- **memory.md** — Claude writes it; saves corrections and preferences you approve across sessions
- **Critical rule:** Keep CLAUDE.md under 200 lines. Beyond that, context rot sets in — Claude skims rather than reads, and specific rules get ignored
- **For large docs** (brand voice, etc.) store them as separate referenced files, not inside CLAUDE.md
- **Anthropic roadmap:** References leaked "Kairos" concept — an always-on background daemon that consolidates memory over time (not yet released)

**Who it's for:** Anyone new to Claude Code; single-project solo workflows

**Where it breaks:** When you hit 200 lines, or when you're maintaining the same core rules across multiple projects

---

### Level 2 — Folder Structure + Session-Start Hooks
**What:** Split memory into a structured folder hierarchy; inject only the relevant slice per session via deterministic hooks.

**Folder structure (John Connolly pattern):**
```
memory/
├── general/          # Cross-project: voice, ethics, output format
├── domain/           # Topic-specific: SEO, copywriting, security
└── tool/             # Tool-specific: Claude Code skills, Figma, Webflow
```

**Session-start hook mechanism:**
- A script fires at `SessionStart` (Claude Code hook event)
- Reads the memory index → injects only relevant slices into context
- **Deterministic** — runs whether Claude "feels like it" or not
- Hook script: ~40 lines of Bash + JSON config

**Benefits:**
- No context rot — each injected slice stays small and specific
- Team sharing — memory folder is just markdown; commit to git, teammates clone it
- Selective recall — irrelevant memory stays out of context window
- Versioning — memory becomes a tracked git artifact

**Who it's for:** Anyone using Claude Code for more than a month; multi-project workflows; teams

**Where it breaks:** When your memory folder hits 50+ files and keyword-based relevance starts missing the right slice

---

### Level 3 — Semantic Vector Search (MemSearch)
**What:** A markdown-first memory system with hybrid semantic + keyword retrieval. Recommended stopping point for most operators.

**Tool:** [MemSearch by Zilliz](https://github.com/zilliztech/memsearch) — Claude Code plugin, open source, inspired by OpenClaw

**Three memory layers:**
1. **Long-term facts** — durable knowledge: brand voice rules, architectural decisions, security policies
2. **Daily notes** — session summaries with timestamp, session ID — plain readable markdown
3. **Dreaming / promotion** — periodic compaction: short-term notes promoted to long-term if they recur; stale info dropped

**Retrieval mechanism — Hybrid search:**
- Semantic vectors (finds related content even if wording differs)
- BM25 keyword search (finds exact keyword matches)
- Reciprocal Rank Fusion (RRF) reranking — combines both for best results

**Three retrieval tiers:**
- **L1 (automatic):** Top-3 semantic results injected on every prompt — covers ~90% of use cases
- **L2 (on-demand):** Complete markdown sections when full context is needed
- **L3 (deep):** Raw verbatim conversation records for exact dialogue lookup

**Who it's for:** Operators with 100+ markdown chunks of memory; multi-brand workflows; solo founders running AI-first businesses

**Where it breaks:** When you need *exact verbatim* recall (not paraphrased) — upgrade to Level 4

---

### Level 4 — Verbatim RAG (Memory Palace)
**What:** A full RAG system that stores exact conversation text, indexed symbolically for fast verbatim retrieval.

**Architecture:**
- **SQL database** — pointer index (wings → rooms → closets → drawers)
- **Chroma vector DB** — semantic search over verbatim chunks
- **Retrieval latency:** ~42ms via indexed pointers
- Background hooks on session end silently file and index memories

**When you need it:** Legal/compliance (verbatim clause wording), research transcripts (exact quotes), therapy/coaching notes, long-running fiction projects

**Who it's for:** Legal, medical, research, voice-of-customer analysis where paraphrasing destroys the data

**Where it breaks:** Maintenance tax — you're now running a database; memory palace hierarchy needs curation

---

### Level 5 — LLM Wiki / Knowledge Base (Karpathy Pattern)
**What:** An LLM-compiled, interconnected wiki synthesized from source documents — not operational memory, but a research artifact.

**Folder structure:**
```
wiki-root/
├── raw/         # Read-only inputs: articles, transcripts, PDFs
└── wiki/        # AI-managed: encyclopedia-style synthesis pages with backlinks
```

**Tools:** [Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), Obsidian for graph visualization, OpenClaw `memory-wiki` plugin

**Key distinction:** A wiki is a *static reference* optimized for "I want to read about X" — NOT for operational "what was the rule on X?" queries. Wrong architecture for operational project memory.

**Who it's for:** Researchers; knowledge workers synthesizing large source corpora; content creators building topic knowledge bases

**Where it breaks:** As operational memory. Don't use a wiki as your project/task memory system.

---

### Level 6 — Cross-Tool Unified Memory (Open Brain / Mem0)
**What:** Memory that persists across multiple AI tools — Claude, ChatGPT, Cursor, etc. — in one shared store.

**Hosted options:**
- **Mem0** — production-ready cross-tool memory API; $19/mo for 10K memories; integrates with 21+ frameworks; memory on their servers
- **Zep, MemPalace** — hosted alternatives

**Self-hosted option:**
- **Open Brain (Nate Jones)** — Postgres + pgvector; `thoughts` table with text, embeddings, tags; MCP server as front door; ~$0.10–0.30/month on free tier

**Tradeoffs:**
- **Latency:** 100-500ms per retrieval (network call to external store)
- **Dependency:** hosted = vendor trust; self-hosted = database maintenance
- **Sync conflicts:** two tools writing simultaneously is an unsolved problem
- **Privacy surface:** everything in unified memory reachable from all connected tools

**Who it's for:** Power users context-switching between 3+ AI tools daily; teams where AI work crosses tool boundaries

**Where it breaks:** For solo operators — latency and complexity tax outweighs cross-tool convenience in most cases

---

### Decision Framework: Which Level to Pick

| Trigger | Move To |
|---------|---------|
| Starting out / single project | Level 1 |
| CLAUDE.md > 200 lines, or maintaining same rules across multiple projects | Level 2 |
| Memory folder > 50 files or keyword retrieval starts missing relevant slices | Level 3 |
| Need exact verbatim wording recall | Level 4 |
| Deep research synthesis across large source corpus | Level 5 |
| Context-switching between 3+ AI tools daily | Level 6 |

**Simon's recommendation for most operators:** Start at Level 1. Move to Level 2 after a month. Move to Level 3 if/when retrieval starts failing. Stop there unless a specific workflow demands otherwise. "Every level above the one you need is friction."

**Levels 1+2+3 are compatible and can be stacked.** They share similar folder structures and integrate naturally with Claude Code.

---

## Sources
- [YouTube: @simonscrapes](https://www.youtube.com/@simonscrapes)
- [YouTube: Every Claude Code Memory System Compared](https://youtu.be/UHVFcUzAGlM) — 6 levels of memory (June 2026)
- [Marketing Agent Blog: Tutorial: Build an Agentic OS with Claude Code Skills](https://marketingagent.blog/2026/03/16/tutorial-build-an-agentic-os-with-claude-code-skills/)
- [Marketing Agent Blog: Build a Team-Wide Agentic OS with Claude Code](https://marketingagent.blog/)
- [Marketing Agent Blog: Build a Vendor-Agnostic AI OS on Claude Code](https://marketingagent.blog/)
- [Sozai Transcript: How Smart People Are Using Claude Code Skills](https://sozai.app/transcript/how-smart-people-are-using-claude-code-skills-to-automa-transcript/)
- [Claude Agentic OS Memory - claudefa.st](https://claudefa.st/blog/guide/mechanics/auto-dream)
- [MemSearch GitHub (Zilliz)](https://github.com/zilliztech/memsearch)
- [Karpathy LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Open Brain GitHub](https://github.com/NateBJones-Project/openbrain)
- [Mem0 Docs](https://mem0.ai/)

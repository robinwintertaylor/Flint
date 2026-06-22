# Research: OpenClaw — CreatorMagicAI's AI Agent Gateway System
*Research compiled June 2026 from YouTube channel @CreatorMagicAI, docs.openclaw.ai, and secondary sources*

---

## Note on "Tank" — CORRECTION

**TANK is not OpenClaw.** TANK is Mike Russell's separate, private **mission control** for Claude Code — a self-hosted browser dashboard for running multiple sandboxed Claude Code agents in isolated git worktrees.

- **TANK** = Mike's private command centre (browser dashboard + Claude Code + git worktrees + Forgejo + tmux). Source code is paywalled inside Creator Magic Premium (mrc.fm/premium, discount code: TANK).
- **OpenClaw** = A different open-source AI agent *gateway* (multi-channel messaging: Telegram/WhatsApp/Discord → AI agent). OpenClaw is MIT licensed and unrelated to TANK.

See `research_tank_creatormagicai.md` for the full TANK architecture. This file covers OpenClaw separately as additional context for the project.

---

---

## What is OpenClaw?

OpenClaw is a **self-hosted, multi-channel gateway for AI agents**. It crossed 100,000 GitHub stars within its first week in late January 2026.

**Core concept:** Run a single persistent Gateway process on your own machine or server. That Gateway becomes the bridge between all your messaging apps and an always-available AI agent — accessible from your pocket, always running, always remembering.

**Who it's for:** Developers and power users who want a personal AI assistant they control completely — no cloud dependency, no data leaving their machine, accessible from anywhere.

---

## Architecture: Three Layers

### 1. Channel Layer (Input/Output)
All messaging surfaces connect to one Gateway:
- **Built-in channels:** WhatsApp, Telegram, Signal, iMessage, Discord, Slack, Microsoft Teams, Google Chat, Matrix, Zalo, WebChat
- **Plugin channels:** Nostr, Twitch, and more via bundled plugins
- **Mobile nodes:** iOS and Android nodes for camera, voice, Canvas workflows
- **Web Control UI:** Browser dashboard for chat, config, session management

One Gateway process serves all channels simultaneously. You message from Telegram, your partner from WhatsApp, your team from Slack — all talking to the same agent.

### 2. Agent Layer (Processing)
- **Model-agnostic:** Claude, GPT-4o, Gemini, Ollama (local models) all work interchangeably — OpenClaw handles routing
- **Tool use:** Browser automation, file access, form-filling, document reading, message sending
- **Persistent memory:** Combination of markdown files + SQLite — agent remembers preferences, past tasks, working context across sessions
- **Session management:** Isolated sessions per agent, workspace, or sender

### 3. Gateway Layer (Infrastructure)
- Runs as `systemd` on Linux or `LaunchAgent` on macOS
- Handles routing, authentication, session management
- Heartbeat scheduler for recurring tasks
- Config at `~/.openclaw/openclaw.json`

---

## Key Capabilities

### Multi-Agent Routing
Multiple specialized agents run through a single gateway:
- Agent A handles email
- Agent B monitors codebase  
- Agent C manages customer inquiries on Telegram
- They share infrastructure but operate independently with isolated sessions

### Persistent Memory System
Unlike stateless chatbots, OpenClaw maintains:
- **Markdown files** — human-readable memory that the agent reads at session start
- **SQLite database** — structured long-term storage
- **Mem0 integration** — semantic memory layer (community-built)
- **Supabase integration** — persistent cloud memory option

### Agent Capabilities
- Opens web pages, fills forms
- Reads documents, processes files
- Sends messages across platforms
- Executes code
- Manages files and directories
- Browser automation

---

## Video Series from @CreatorMagicAI

Key video titles showing the system's evolution:

| Series | Topic |
|--------|-------|
| OpenClaw basics | Setup, installation, first agent |
| "I Gave 3 AI Agents $1,000 Each (OpenClaw)" | Multi-agent economic experiments |
| "My AI Agents Made Money in 7 Days (OpenClaw)" | Real-world agent deployment |
| "NemoClaw: I Gave 3 AI Agents Real Credit Cards" | Advanced financial autonomy |
| "I Cut My OpenClaw Costs 99% With 4 Webhooks" | Cost optimization |
| "Claude Managed Agents: OpenClaw Is In Trouble" | Competitive analysis |
| "I Rebuilt My OpenClaw Stack Using Only Claude Code" | Integration with Claude Code |
| "My OpenClaw Made $2k & Wants to Clone Itself!" | Advanced autonomy showcase |
| "5 OpenClaw Upgrades You're Missing" | Feature deep-dives |
| "I Tested 24 AI Models on OpenClaw" | Model benchmarking |

---

## Technical Setup

```bash
# Install
npm install -g openclaw@latest

# Onboard with daemon install
openclaw onboard --install-daemon

# Open dashboard
openclaw dashboard
# → http://127.0.0.1:18789/
```

**Config example:**
```json5
{
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
}
```

---

## Memory Architecture (Community Solutions)

Since native OpenClaw memory has limitations, the community built:

1. **Markdown memory files** — Agent reads files at session start ("most organic" approach)
2. **Mem0 integration** — Semantic memory layer via API
3. **Supabase + pgvector** — Persistent cloud memory with vector search
4. **SQLite** — Local structured memory

---

## What Makes OpenClaw "Tank-Like" (Always-On)

The "Tank" metaphor fits the architecture:
- **Armored/persistent:** Runs as a daemon — survives reboots, always available
- **Heavy-duty:** Handles multiple channels, multiple agents, real tools
- **Autonomous:** Heartbeat scheduler runs tasks on cron without human initiation
- **Multi-weapon:** Any model, any channel, any tool

---

## Sources
- [OpenClaw Official Docs](https://docs.openclaw.ai/)
- [OpenClaw Multi-Agent Routing](https://docs.openclaw.ai/concepts/multi-agent)
- [FreeCodeCamp: Build and Secure a Personal AI Agent with OpenClaw](https://www.freecodecamp.org/news/how-to-build-and-secure-a-personal-ai-agent-with-openclaw/)
- [MindStudio: What Is OpenClaw?](https://www.mindstudio.ai/blog/what-is-openclaw-ai-agent)
- [Milvus Blog: OpenClaw Complete Guide](https://milvus.io/blog/openclaw-formerly-clawdbot-moltbot-explained-a-complete-guide-to-the-autonomous-ai-agent.md)
- [YouTube: @CreatorMagicAI](https://www.youtube.com/@CreatorMagicAI)

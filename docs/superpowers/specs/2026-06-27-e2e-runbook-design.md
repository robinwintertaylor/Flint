# Flint E2E System Runbook — Design Spec

**Date:** 2026-06-27
**Author:** Flint

## Goal

A single, ordered end-to-end system check that verifies every feature area of the Flint stack against real running services. The runbook is both a human-readable document and an executable automated test suite. It is the definitive pre-release / post-deploy verification gate.

---

## Deliverables

### 1. `docs/e2e-runbook.md`
The master runbook document. Twenty ordered sections covering every feature area in dependency order. Each section contains:
- **Goal** — what this section proves
- **Preconditions** — what must be true before this section runs
- **Steps** — exact terminal commands, API calls, or browser actions
- **Expected** — what a passing result looks like
- **Pass / Fail** criteria

Designed to be executed top-to-bottom by Flint (browser + terminal) as a complete system check. Can also be followed manually by a human.

### 2. `dashboard/tests/e2e.test.js`
A Node.js `node:test` file that automates every API-testable step in the runbook against the **live running stack** (ports 3000 and 3001). No mocks, no test DB — real services. Browser UI paths remain in the runbook (executed via browser automation). Runs with:

```
node --test dashboard/tests/e2e.test.js
```

---

## Live Services Required

| Service | Port / URL | Status |
|---|---|---|
| Flint Dashboard | http://localhost:3000 | Required |
| Flint Router | http://localhost:3001 | Required |
| Forgejo | http://localhost:3030 | Running (Docker) |
| Ollama | http://localhost:11434 | Running |
| OpenRouter | https://openrouter.ai | Running (API key in DB) |
| Telegram | — | Not configured — sections skipped |
| LM Studio | — | Not configured — sections skipped |
| GitHub | — | Not configured — sections skipped |

---

## Section Order & Coverage

Sections are ordered by dependency: services that others depend on come first.

### Section 1: Health & Service Reachability
**Proves:** All three processes (dashboard, router, Forgejo) are up and returning healthy responses.
- `GET /health` → `{ status: ok, db: connected, forgejo: reachable, ollama: reachable }`
- `GET http://localhost:3001/health` → `{ status: ok }`
- `GET http://localhost:3030` → HTTP 200

### Section 2: Router — LLM Routing
**Proves:** The model router resolves providers, returns models, and can complete a prompt via OpenRouter.
- `GET /llm/models` → array of available models
- `GET /llm/config` → tier/provider config
- `POST /llm/complete` with `{ taskType: "general", prompt: "say hello" }` → `{ text: <non-empty> }`
- `GET /llm/costs` → cost summary object

### Section 3: API Keys
**Proves:** Key management works — list, read (masked), update, and env fallback.
- `GET /api-keys` → array including seeded providers (anthropic, openai, openrouter, etc.)
- `GET /api-keys/openrouter/value` → non-null (key is stored)
- `PATCH /api-keys/openrouter` with a new value → 200, masked in list
- Restore original value

### Section 4: Workspaces
**Proves:** Workspace CRUD works.
- `POST /workspaces` → creates workspace
- `GET /workspaces` → includes new workspace
- `DELETE /workspaces/:id` → 200

### Section 5: Agent Lifecycle
**Proves:** Agent registration, status tracking, and teardown work.
- `GET /agents` → array (may be empty)
- WebSocket spawn message → agent appears in list with status `running`
- `DELETE /agents/:name` → removes agent
- Browser: agent panel appears in dashboard, kill button works

### Section 6: Agent Task Files
**Proves:** Per-agent task file read/write works.
- `GET /tasks/:agent` → returns task content
- `PATCH /tasks/:agent` → updates content, GET confirms change
- `POST /tasks/:agent` → appends a checkbox line

### Section 7: Worktrees & Isolation
**Proves:** Isolated branch creation and discard work end-to-end with Forgejo.
- `GET /worktrees` → list (may be empty)
- Spawn agent with `isolate: true` via WebSocket → worktree created, branch pushed to Forgejo
- `DELETE /worktrees/:agent` → discards worktree
- CLI: `flint worktree list` and `flint worktree discard`

### Section 8: Projects
**Proves:** Project CRUD, agent linking, and cost roll-up work.
- `POST /projects` → creates project
- `GET /projects` → includes new project
- `GET /projects/:id` → detail with cost fields
- `POST /projects/:id/agents` → links agent
- `PATCH /projects/:id` → updates status / notes
- `DELETE /projects/:id/agents/:name` → unlinks
- `DELETE /projects/:id` → removes
- CLI: `flint project list`, `create`, `status`, `notes`, `link`, `unlink`

### Section 9: Task Queue
**Proves:** Queue CRUD, assignment, status transitions, and cancellation work.
- `POST /queue/tasks` → creates task
- `GET /queue/tasks` → list includes new task
- `PATCH /queue/tasks/:id` → assign to agent, advance status
- `DELETE /queue/tasks/:id` → cancels
- CLI: `flint queue add`, `list`, `assign`, `done`, `cancel`
- Browser: Queue view shows tasks, status badges correct

### Section 10: Orchestrations
**Proves:** Goal-driven multi-agent orchestration creates an agent and tracks state.
- `POST /orchestrations` → creates orchestration, spawns agent
- `GET /orchestrations` → includes new entry
- `GET /orchestrations/:id` → status, agent name, goal
- `GET /orchestrations/:id/scratchpad` → scratchpad content
- `POST /orchestrations/:id/scratchpad` → appends content
- CLI: `flint orchestrate "test goal"`, `flint orchestrate list`

### Section 11: MCP Servers
**Proves:** MCP server management (global + per-agent scope) works.
- `POST /mcp/servers` → adds server
- `GET /mcp/servers` → includes new server
- `PATCH /mcp/servers/:id` → toggle enabled/disabled
- `DELETE /mcp/servers/:id` → removes
- Browser: MCP tab shows server, toggle works

### Section 12: Skills
**Proves:** Skill CRUD and GitHub import work.
- `POST /api/skills` → creates skill
- `GET /api/skills` → includes new skill
- `GET /api/skills/:id` → detail
- `PATCH /api/skills/:id` → updates
- `DELETE /api/skills/:id` → removes
- Browser: Skills tab shows skill card, edit modal works

### Section 13: Specialists
**Proves:** Specialist CRUD, soul storage, and dropdown in New Agent modal work.
- `POST /api/specialists` → creates specialist with soul
- `GET /api/specialists` → array includes new specialist
- `GET /api/specialists/:name` → includes `soul` field
- `PATCH /api/specialists/:name` → updates label and soul
- `DELETE /api/specialists/:name` → removes
- Browser: Specialists tab card grid, create/edit/delete modal, New Agent modal specialist dropdown populated

### Section 14: Project Docs
**Proves:** Document upload, listing, retrieval, and deletion work for a project.
- Create a project first
- `POST /api/projects/:id/docs` with a text file → 201 with doc id
- `GET /api/projects/:id/docs` → includes new doc
- `GET /api/projects/:id/docs/:docId` → returns content
- `DELETE /api/projects/:id/docs/:docId` → 204

### Section 15: Ollama
**Proves:** Ollama status and generation work with the local instance.
- `GET /api/ollama/status` → `{ reachable: true, models: [...] }`
- `POST /api/ollama/generate` with first available model → `{ response: <non-empty> }`

### Section 16: Forgejo PR Flow
**Proves:** Branch push and PR creation reach Forgejo end-to-end.
- `GET /health` → `forgejo: reachable`
- Spawn isolated agent → branch pushed → PR created in Forgejo
- Poll PR status → `open`
- `DELETE /worktrees/:agent` → worktree discarded, DB cleared

### Section 17: Suggestions
**Proves:** Suggestion read and update work.
- `GET /suggestions` → array (may be empty)
- If suggestions exist: `PATCH /suggestions/:id` with `{ status: 'accepted' }` → 200

### Section 18: Costs & Usage
**Proves:** Cost aggregation returns valid data.
- `GET /costs` → `{ today: <number>, month: <number>, providers: [...] }`
- Values are non-negative numbers

### Section 19: CLI Full Walkthrough
**Proves:** The `flint` CLI can reach both services and execute all subcommands.
- `flint ask "what is 2+2"` → non-empty response via router
- `flint project list`
- `flint queue list`
- `flint worktree list`
- `flint mcp list`
- `flint orchestrate list`

### Section 20: Browser UI Full Walkthrough
**Proves:** Every tab in the dashboard renders correctly and primary actions work.
- Agents view: toolbar visible, + New Agent modal opens with Specialist dropdown
- Projects tab: list renders
- Workspaces tab: list renders
- MCP tab: list renders
- Keys tab: masked keys shown
- Skills tab: list renders
- Specialists tab: card grid renders, create modal opens
- Queue tab: list renders
- Orchestrate tab: list renders

---

## Automated Test File Design (`e2e.test.js`)

- Requires the live stack to be running — fails fast with a clear message if `:3000` is unreachable
- Organised as `describe`-equivalent groups matching the 20 sections above (sections with no API surface skipped)
- Creates and tears down its own test data (prefixed `e2e-test-*`) — leaves no side effects
- Each test is labelled `[S<n>] description` to match the runbook section number
- Timeout: 10s per test (external services may be slow)
- Sections 5 (agent spawn) and 16 (Forgejo PR flow) are integration-heavy; marked `// SLOW` and skipped by default unless `E2E_FULL=1` is set

---

## What Is Not Covered

- **Telegram** — bot not configured; section omitted
- **LM Studio** — not running; section omitted
- **GitHub** — not configured; section omitted
- **PTY/terminal rendering** — actual Claude Code process execution is not tested (spawning a real agent requires a valid API key and would incur cost); spawn is tested at the registration level only
- **WebSocket stream** — real-time output streaming to the browser is verified visually in Section 20, not in the automated test

---

## Self-Review

- No TBDs or placeholders remain
- Section order is strictly dependency-safe (health before agents before projects etc.)
- Automated test creates/deletes its own data — no interference with existing data
- Browser sections are explicit about what is clicked and what constitutes a pass
- Services that are down are clearly documented as skipped — not silently ignored

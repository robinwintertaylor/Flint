# Project Orchestration Design

## Goal

When a Flint project is created or manually re-launched, the system automatically kicks off an orchestrator agent that reads the project goal, judges complexity, produces mandatory planning artifacts, and spawns the right specialists to execute the work — creating any missing specialists on the fly.

## Architecture

A new `dashboard/projectLauncher.js` module is the single entry point. It resolves the project's workdir, enriches the orchestrator task file with project context and the specialist roster, then delegates to the existing `createOrchestration()` in `orchestrator.js`. No new agent runtime is introduced — the existing orchestrator agent handles all intelligence.

The orchestrator uses a hybrid A+C approach: for simple tasks it spawns workers directly; for complex ones it stages through research → planning → execution. The agent itself makes this call based on the goal.

## Data Model

Two new columns on the `projects` table (added via migration):

```sql
ALTER TABLE projects ADD COLUMN goal TEXT;
ALTER TABLE projects ADD COLUMN active_orchestration_id INTEGER REFERENCES orchestrations(id);
```

- **`goal`** — concise, actionable directive (e.g. "Build a competitor price-tracking tool"). The primary input to the orchestrator. Separate from `notes`, which is background context.
- **`active_orchestration_id`** — points at the currently running orchestration so the UI can show live status. Previous orchestrations stay in the DB for history.

Workdir resolution order: project's linked workspace path → `default_workdir` setting → `process.cwd()`.

## Components

### `dashboard/projectLauncher.js` (new)

Single exported function:

```js
export async function launchProject(projectId)
```

Steps:
1. Load project (goal, notes, workspace_id, active_orchestration_id)
2. Validate: goal must be set
3. Resolve workdir from workspace or settings fallback
4. Load all attached project docs
5. Load full specialist roster from DB
6. Build enriched orchestrator task file (see below)
7. Call `createOrchestration({ goal, workdir, projectId })` — this spawns the orchestrator agent and writes the task file
8. Update `projects.active_orchestration_id` with the new orchestration id
9. Broadcast `{ type: 'project_launched', projectId, orchestrationId }`

### Enriched orchestrator task file

The existing `buildOrchestratorTaskFile()` in `orchestrator.js` is extended to accept:

- `specialists` — array of `{ name, label, description, domains }` from DB
- `projectGoal` — the project's goal field
- `projectNotes` — background context
- `workspacePath` — resolved workdir

The task file gains three new sections:

**Available Specialists**
Lists every registered specialist with name, label, description, and domains. The orchestrator uses this to assign roles. If a needed role isn't listed, the orchestrator creates it.

**Project Context**
```
Goal: <goal>
Background: <notes>
Workspace: <path>
```

**Two-Mode Guidance**
```
SIMPLE task (clear deliverable, no unknowns, ≤1 day):
  → Skip research/planning. Spawn builder directly.

COMPLEX task (unclear scope, research needed, multiple parts):
  → Stage 1: Spawn research-expert. Assign research task. Wait for completion.
  → Stage 2: Spawn planning-expert with research findings. Wait for completion.
  → Stage 3: Read scratchpad. Decide builders/testers. Spawn and assign.
```

**Mandatory Artifacts**
```
Before spawning any builder or tester, ensure these docs exist in the workspace
AND are attached to the project (POST /projects/:id/docs). Check existing
project docs first — skip creation if already present.

  research.md     — research findings, prior art, constraints (owner: research-expert)
  prd.md          — what we're building, who for, success criteria (owner: planning-expert)
  design.md       — architecture, components, data model, API contracts (owner: planning-expert)
  requirements.md — acceptance criteria, edge cases, non-goals (owner: planning-expert)

Write each to <workspace>/<filename>, then POST to attach.
For complex tasks all four are required. For simple tasks, prd.md and
requirements.md are sufficient.
```

**On-Demand Specialist Creation**
```
If no existing specialist fits a needed role:
  1. GET /api/specialists/:name  — check it doesn't already exist
  2. POST /api/specialists       — create with name, label, description, domains,
                                   preferred_provider, and a first-person soul
  3. POST /agents/spawn          — spawn immediately
  4. Assign task as normal

Prefer reusing existing specialists. Only create when no existing specialist fits.
```

### `dashboard/server.js` changes

- `POST /projects` — if `goal` is set in body, call `launchProject(id)` after insert
- `POST /projects/:id/launch` — new route, calls `launchProject(id)`; returns `{ orchestrationId }`
- `PATCH /projects/:id` — accept `goal` field
- `GET /projects/:id` — already returns full row; `goal` and `active_orchestration_id` come through automatically

### `dashboard/projects.js` changes

- `createProject()` — accept `goal` parameter
- `updateProject()` — add `goal` and `active_orchestration_id` to allowed fields

### UI changes (`dashboard/public/app.js` + `index.html`)

**Project card**:
- Add goal display (truncated, one line below project name)
- "Launch" button — enabled when goal is set; shows "Add goal to launch" (disabled) when goal is missing
- Status chip showing active orchestration state: `idle` / `running` / `done` / `failed` — derived from `active_orchestration_id` and the orchestration's `status` column
- Clicking the status chip opens the scratchpad in a read-only modal

**New/Edit project modal**:
- Add `goal` text input (single line, required for launch, optional for creation)

**Orchestration status polling**:
- When a project card has `active_orchestration_id`, poll `GET /orchestrations/:id` every 15s to update the status chip — or listen for `project_launched` / `orchestration_started` WebSocket events

## Data Flow

```
Robin clicks "Launch" (or creates project with goal)
  → POST /projects/:id/launch
  → launchProject(projectId)
      → resolve workdir
      → load specialists + docs
      → createOrchestration() → spawns orch-N agent with enriched task file
      → UPDATE projects SET active_orchestration_id = N
      → broadcast project_launched

orch-N agent reads task file
  → judges complexity
  → SIMPLE: spawns builder, assigns task
  → COMPLEX:
      → checks/creates research-expert → assigns research task
      → polls queue until research done
      → checks/creates planning-expert → assigns planning task
      → polls queue until planning done
      → reads scratchpad findings
      → decides remaining specialists needed
      → creates missing specialists on the fly if needed
      → assigns build/test tasks

Each specialist:
  → reads workspace artifacts (research.md, prd.md, design.md, requirements.md)
  → executes task
  → writes output to workspace + scratchpad
  → marks task done via PATCH /queue/tasks/:id

orch-N agent:
  → detects all tasks done
  → writes synthesis to scratchpad
  → marks orchestration done
  → broadcasts completion

Dashboard:
  → status chip updates to "done"
  → project docs tab shows all artifacts
```

## Error Handling

- **No goal set**: `launchProject()` throws; route returns 400. Button disabled in UI.
- **No workdir resolvable**: throws with message shown in UI alert.
- **Orchestrator spawn fails**: error logged, `active_orchestration_id` not updated.
- **Specialist creation fails**: orchestrator logs error to scratchpad and tries fallback (nearest existing specialist).
- **Re-launch while running**: allowed — creates a new orchestration, previous one is superseded but not killed.

## Files Modified / Created

| File | Change |
|---|---|
| `dashboard/projectLauncher.js` | **New** — `launchProject()` |
| `dashboard/orchestrator.js` | Extend `buildOrchestratorTaskFile()` with specialists, goal, notes, workspace, two-mode guidance, artifact mandate, specialist creation API docs |
| `dashboard/projects.js` | Add `goal`, `active_orchestration_id` to create/update |
| `dashboard/db.js` | Migration: two new columns on projects |
| `dashboard/server.js` | `POST /projects/:id/launch`; wire auto-launch on create; accept `goal` on PATCH |
| `dashboard/public/app.js` | Launch button, goal field, status chip, scratchpad modal, polling |
| `dashboard/public/index.html` | Goal input in create/edit modals |

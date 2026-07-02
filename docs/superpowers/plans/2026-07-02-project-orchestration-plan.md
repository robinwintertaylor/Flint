# Project Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Flint project has a goal set, automatically launch an orchestrator agent that mirrors the Superpowers workflow (research → plan → build → review), produces four mandatory artifacts, and can create missing specialists on the fly.

**Architecture:** A new `projectLauncher.js` module resolves workdir from the project's linked workspace, loads the specialist roster and project docs, then delegates to the existing `createOrchestration()` in `orchestrator.js`. The orchestrator task file is enriched with the specialist roster, project context, two-mode guidance (simple vs complex), mandatory artifact requirements, and on-demand specialist creation API docs. The UI adds a goal field to project modals and a Launch button + status chip to each project card.

**Tech Stack:** Node.js ESM, better-sqlite3, Express, WebSocket, vanilla JS frontend. No new dependencies.

## Global Constraints

- ESM throughout (`import`/`export`) — no `require()`
- All server files live in `dashboard/`; all frontend files in `dashboard/public/`
- `FLINT_TEST_MODE=1` env var prevents actual agent spawning — use it in manual tests
- Docs API path is `/api/projects/:id/docs` (note `/api/` prefix)
- Project card HTML is built with template literals using `escHtml()` for all user content
- No new npm packages
- Commit after every task

---

### Task 1: DB migration + projects.js data model

**Files:**
- Modify: `dashboard/db.js` (after the `preferred_model` migration line ~148)
- Modify: `dashboard/projects.js` (`createProject`, `updateProject`)

**Interfaces:**
- Produces: `createProject({ name, notes, workspace_id, goal })` accepting `goal`; `updateProject(id, fields)` accepting `goal` and `active_orchestration_id`; both new columns present in DB rows returned by `getProject()`

- [ ] **Step 1: Add migrations to db.js**

Open `dashboard/db.js`. Find the migration block (~line 143). After the existing `try/catch` migrations, add:

```js
try { _db.exec('ALTER TABLE projects ADD COLUMN goal TEXT'); } catch {}
try { _db.exec('ALTER TABLE projects ADD COLUMN active_orchestration_id INTEGER REFERENCES orchestrations(id)'); } catch {}
```

- [ ] **Step 2: Update createProject in projects.js**

Find `createProject` (~line 46). Replace:

```js
export function createProject({ name, notes = '', workspace_id = null }) {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO projects (name, notes, workspace_id) VALUES (?, ?, ?)`
  ).run(name, notes, workspace_id ?? null);
  return Number(result.lastInsertRowid);
}
```

With:

```js
export function createProject({ name, notes = '', workspace_id = null, goal = null }) {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO projects (name, notes, workspace_id, goal) VALUES (?, ?, ?, ?)`
  ).run(name, notes, workspace_id ?? null, goal ?? null);
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 3: Update updateProject allowed fields in projects.js**

Find `updateProject` (~line 54). Replace the `allowed` array:

```js
const allowed = ['name', 'status', 'notes', 'last_summary', 'workspace_id', 'goal', 'active_orchestration_id'];
```

- [ ] **Step 4: Restart and verify manually**

```powershell
pm2 restart flint-dashboard
```

Open browser → Projects tab → Edit any project → confirm no errors. Run in browser console:

```js
fetch('/projects/1').then(r=>r.json()).then(p=>console.log(p.goal, p.active_orchestration_id))
```

Expected: `null null` (or undefined — columns exist, values are null).

- [ ] **Step 5: Commit**

```powershell
git add dashboard/db.js dashboard/projects.js
git commit -m "feat(proj-orch): add goal and active_orchestration_id columns to projects"
git push
git push github master:main
```

---

### Task 2: projectLauncher.js

**Files:**
- Create: `dashboard/projectLauncher.js`

**Interfaces:**
- Consumes: `getProject(id)` from `./projects.js`; `updateProject(id, fields)` from `./projects.js`; `listWorkspaces()` from `./db.js`; `getSetting(key)` from `./settings.js`; `listSpecialists()` from `./specialists.js`; `listDocsWithContent(projectId)` from `./project_docs.js`; `createOrchestration({ goal, workdir, model, projectId, specialists, projectNotes, workspacePath })` from `./orchestrator.js`; `broadcastGlobal({ type, ... })` from `./agents.js`
- Produces: `launchProject(projectId)` → `Promise<{ orchestrationId: number }>`

- [ ] **Step 1: Create dashboard/projectLauncher.js**

```js
import { getProject, updateProject } from './projects.js';
import { listWorkspaces, getDb } from './db.js';
import { getSetting } from './settings.js';
import { listSpecialists } from './specialists.js';
import { listDocsWithContent } from './project_docs.js';
import { createOrchestration } from './orchestrator.js';
import { broadcastGlobal } from './agents.js';

export async function launchProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (!project.goal) throw new Error('Project has no goal — add a goal before launching');

  // Resolve workdir: workspace path → default_workdir setting → cwd
  let workdir = null;
  if (project.workspace_id) {
    const workspaces = listWorkspaces();
    const ws = workspaces.find(w => w.id === project.workspace_id);
    if (ws) workdir = ws.path;
  }
  if (!workdir) workdir = getSetting('default_workdir') || null;
  if (!workdir) workdir = process.cwd();

  const specialists  = listSpecialists();
  const projectDocs  = listDocsWithContent(projectId);

  const { id: orchestrationId } = createOrchestration({
    goal:          project.goal,
    workdir,
    projectId,
    specialists,
    projectNotes:  project.notes || '',
    workspacePath: workdir,
  });

  updateProject(projectId, { active_orchestration_id: orchestrationId });
  broadcastGlobal({ type: 'project_launched', projectId, orchestrationId });

  return { orchestrationId };
}
```

- [ ] **Step 2: Verify it imports cleanly**

```powershell
node --input-type=module --eval "import('./dashboard/projectLauncher.js').then(()=>console.log('OK')).catch(e=>console.error(e.message))"
```

Expected output: `OK`

- [ ] **Step 3: Commit**

```powershell
git add dashboard/projectLauncher.js
git commit -m "feat(proj-orch): add projectLauncher.js with launchProject()"
git push
git push github master:main
```

---

### Task 3: Enrich orchestrator task file

**Files:**
- Modify: `dashboard/orchestrator.js` (`buildOrchestratorTaskFile`, `createOrchestration`)

**Interfaces:**
- Consumes: existing `buildOrchestratorTaskFile` signature; `createOrchestration` signature
- Produces: `buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs, specialists, projectNotes, workspacePath, projectId })` — extended; `createOrchestration({ goal, workdir, model, projectId, specialists, projectNotes, workspacePath })` — extended

- [ ] **Step 1: Extend buildOrchestratorTaskFile signature and add new sections**

Open `dashboard/orchestrator.js`. Replace the entire `buildOrchestratorTaskFile` function:

```js
export function buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs = [], specialists = [], projectNotes = '', workspacePath = null, projectId = null }) {
  const docsSection = projectDocs.length > 0
    ? `\n## Project Documents\n\nThe following reference documents are attached to this project. Use them to inform your plan.\n\n${projectDocs.map(d => `### ${d.title}\n\n${d.content}`).join('\n\n---\n\n')}\n`
    : '';

  const ws = workspacePath || workdir;

  const specialistsTable = specialists.length > 0
    ? specialists.map(s => `| ${s.name} | ${s.label} | ${(s.domains ?? []).join(', ') || '—'} | ${s.description || '—'} |`).join('\n')
    : '| (none registered) | | | |';

  const artifactApi = projectId
    ? `curl -s -X POST http://localhost:${process.env.PORT ?? 3000}/api/projects/${projectId}/docs \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"<filename>","content":"<escaped-markdown>","source":"orchestrator"}'`
    : '# No project id — skip doc attachment';

  const checkDocsApi = projectId
    ? `curl -s "http://localhost:${process.env.PORT ?? 3000}/api/projects/${projectId}/docs"`
    : '# No project id';

  return `## Project Context

**Goal:** ${goal}
**Background:** ${projectNotes || '(none)'}
**Workspace:** ${ws}
${docsSection}
## Your Role — Orchestrator

You are Flint's Orchestrator. You work exactly like the Superpowers workflow:
  1. Research (understand the problem space)
  2. Plan (design the solution)
  3. Build (execute with specialists)
  4. Review (verify the work)

Your job:
1. Read the goal and project context above.
2. Judge complexity (see Approach section).
3. Ensure mandatory artifacts exist (see Artifacts section).
4. Spawn specialists and assign tasks to execute the plan.
5. Monitor the queue and scratchpad for progress.
6. When all tasks are done, write a synthesis to the scratchpad.

## Available Specialists

The following specialists are registered in Flint. Use their exact \`name\` as \`assigned_to\` when creating tasks.

| name | label | domains | description |
|---|---|---|---|
${specialistsTable}

If a needed role isn't listed, create it — see On-Demand Specialist Creation below.

## Approach — Choose Your Mode

Read the goal and judge complexity BEFORE taking any action.

**SIMPLE** (clear deliverable, no unknowns, ≤1 day of work — e.g. "add a button", "write a script"):
→ You write prd.md and requirements.md directly from the goal (no research-expert needed).
→ Spawn builder immediately and assign the task.
→ Required artifacts: prd.md, requirements.md only.

**COMPLEX** (unclear scope, research needed, multiple moving parts):
→ Stage 1 — Research: assign research task to research-expert. Poll until done.
→ Stage 2 — Plan: assign planning task to planning-expert with research findings. Poll until done.
→ Stage 3 — Execute: read scratchpad. Decide which builders/testers are needed. Spawn and assign.
→ Required artifacts: all four (research.md, prd.md, design.md, requirements.md).

## Mandatory Artifacts

Before spawning any builder or tester, ensure the required artifacts exist in the
workspace AND are attached to this project. Check first — skip any that already exist.

### Check existing docs
\`\`\`bash
${checkDocsApi}
\`\`\`

### Write artifact to workspace then attach it
For each artifact (research.md, prd.md, design.md, requirements.md):
1. Write the file to the workspace using the Edit or Write tool.
2. Attach it to the project:
\`\`\`bash
${artifactApi}
\`\`\`

Artifact owners:
- research.md     → research-expert (findings, prior art, constraints, unknowns)
- prd.md          → planning-expert or you for SIMPLE (what we build, who for, success criteria)
- design.md       → planning-expert (architecture, components, data model, API contracts)
- requirements.md → planning-expert or you for SIMPLE (acceptance criteria, edge cases, non-goals)

All builders and testers MUST read these files before starting work.
Include the workspace path in every task description you create.

## Shared Scratchpad

Path: ${scratchpadPath}
Write your plan there first. Workers append findings under ## Findings.
Read it to track progress. Write your final synthesis under ## Synthesis.

## Flint REST API
Base URL: http://localhost:${process.env.PORT ?? 3000}

### Spawn a specialist agent
\`\`\`bash
curl -s -X POST http://localhost:${process.env.PORT ?? 3000}/agents/spawn \\
  -H "Content-Type: application/json" \\
  -d '{"name":"<specialist-name>","workdir":"${ws.replace(/\\/g, '\\\\')}","runtime":"claude"}'
\`\`\`

### Create a queue task and assign it
\`\`\`bash
curl -s -X POST http://localhost:${process.env.PORT ?? 3000}/queue/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title":"<title>","description":"<desc — include workspace path and artifact file paths>","assigned_to":"<specialist-name>","role":"researcher","created_by":"orch-${id}"}'
\`\`\`

### Poll task queue progress
\`\`\`bash
curl -s "http://localhost:${process.env.PORT ?? 3000}/queue/tasks?created_by=orch-${id}"
\`\`\`

### Mark a task done
\`\`\`bash
curl -s -X PATCH http://localhost:${process.env.PORT ?? 3000}/queue/tasks/<task-id> \\
  -H "Content-Type: application/json" \\
  -d '{"status":"done","result":"<one-line summary>"}'
\`\`\`

### Append to scratchpad
\`\`\`bash
curl -s -X POST http://localhost:${process.env.PORT ?? 3000}/orchestrations/${id}/scratchpad \\
  -H "Content-Type: application/json" \\
  -d '{"text":"\\n## Synthesis\\n\\n<your synthesis>"}'
\`\`\`

## On-Demand Specialist Creation

If no existing specialist fits a needed role, create one:

\`\`\`bash
# 1. Check it doesn't already exist
curl -s http://localhost:${process.env.PORT ?? 3000}/api/specialists/<name>

# 2. Create it
curl -s -X POST http://localhost:${process.env.PORT ?? 3000}/api/specialists \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "<slug>",
    "label": "<Human Label>",
    "description": "<what it does>",
    "domains": ["<domain1>", "<domain2>"],
    "preferred_provider": "openrouter",
    "soul": "# <Label>\\n\\nI am a specialist in <topic>.\\n\\n## My approach:\\n- Complete assigned tasks thoroughly\\n- Stay focused on my expertise\\n- Report findings clearly"
  }'

# 3. Spawn it immediately
curl -s -X POST http://localhost:${process.env.PORT ?? 3000}/agents/spawn \\
  -H "Content-Type: application/json" \\
  -d '{"name":"<slug>","workdir":"${ws.replace(/\\/g, '\\\\')}","runtime":"openrouter","specialistName":"<slug>"}'
\`\`\`

Prefer reusing existing specialists. Create only when no existing specialist fits.

## Worker Roles
- **researcher**: investigates, reads docs, surveys prior art → produces research.md
- **planner**: designs architecture, data models, API contracts → produces prd.md, design.md, requirements.md
- **builder**: writes code and commits it
- **tester**: writes tests, runs them, reports results
- **reviewer**: reviews code quality and correctness
`;
}
```

- [ ] **Step 2: Extend createOrchestration to accept and pass new params**

Find `createOrchestration` (~line 117). Replace its signature and the `writeTasks` call:

```js
export function createOrchestration({ goal, workdir, model, projectId, specialists = [], projectNotes = '', workspacePath = null } = {}) {
```

Then find the line:
```js
writeTasks(agentName, buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs }));
```

Replace with:
```js
writeTasks(agentName, buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs, specialists, projectNotes, workspacePath: workspacePath || workdir, projectId }));
```

- [ ] **Step 3: Restart and verify task file content**

```powershell
pm2 restart flint-dashboard
```

Set `FLINT_TEST_MODE=1` temporarily to prevent spawn. In browser console:

```js
fetch('/orchestrations', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ goal: 'Test goal', workdir: 'C:\\Flint' })
}).then(r=>r.json()).then(console.log)
```

Then check the tasks file was created:

```powershell
cat "C:\Flint\tasks\orch-1\..\..\tasks\orch-1.md" 2>$null; Get-Content (Get-ChildItem "C:\Flint\tasks" -Filter "orch-*.md" | Select-Object -Last 1).FullName
```

Expected: file contains "## Available Specialists", "## Approach — Choose Your Mode", "## Mandatory Artifacts", "## On-Demand Specialist Creation".

- [ ] **Step 4: Commit**

```powershell
git add dashboard/orchestrator.js
git commit -m "feat(proj-orch): enrich orchestrator task file with specialists, two-mode guidance, mandatory artifacts"
git push
git push github master:main
```

---

### Task 4: server.js — launch route + auto-launch on create

**Files:**
- Modify: `dashboard/server.js`

**Interfaces:**
- Consumes: `launchProject(projectId)` from `./projectLauncher.js`
- Produces: `POST /projects/:id/launch` → `{ orchestrationId }` or 400 error; `POST /projects` auto-launches when `goal` is set; `PATCH /projects/:id` accepts `goal`

- [ ] **Step 1: Import launchProject in server.js**

Find the imports block at the top of `dashboard/server.js`. Add after the `projects.js` import line:

```js
import { launchProject } from './projectLauncher.js';
```

- [ ] **Step 2: Add POST /projects/:id/launch route**

Find the projects routes section (~line 622, after `app.get('/projects/:id',...)`). Add the new route before `app.patch('/projects/:id',...)`:

```js
  app.post('/projects/:id/launch', async (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    try {
      const result = await launchProject(id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
```

- [ ] **Step 3: Wire auto-launch in POST /projects**

Find `app.post('/projects', ...)`. Replace the handler body:

```js
  app.post('/projects', async (req, res) => {
    const { name, notes, workspace_id, goal } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      const id = createProject({ name, notes: notes ?? '', workspace_id: workspace_id ?? null, goal: goal ?? null });
      if (goal) {
        try { await launchProject(id); } catch (err) {
          console.warn(`[projects] auto-launch failed for project ${id}: ${err.message}`);
        }
      }
      res.status(201).json(getProject(id));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'project name already exists' });
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 4: Accept goal in PATCH /projects/:id**

Find `app.patch('/projects/:id', ...)`. Replace the destructure line and fields block:

```js
    const { name, status, notes, workspace_id, goal } = req.body ?? {};
    const VALID_STATUSES = ['active', 'paused', 'done', 'archived'];
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (status !== undefined) fields.status = status;
    if (notes !== undefined) fields.notes = notes;
    if (workspace_id !== undefined) fields.workspace_id = workspace_id ?? null;
    if (goal !== undefined) fields.goal = goal ?? null;
    if (Object.keys(fields).length) updateProject(id, fields);
```

- [ ] **Step 5: Restart and test launch route manually**

```powershell
pm2 restart flint-dashboard
```

Set env: create a test project without a goal first, then call launch (expect 400):

```powershell
$proj = Invoke-RestMethod -Uri http://localhost:3000/projects -Method Post -ContentType 'application/json' -Body '{"name":"test-orch-proj","notes":"test"}'
$projId = $proj.id
Invoke-RestMethod -Uri "http://localhost:3000/projects/$projId/launch" -Method Post
```

Expected: `{ error: "Project has no goal — add a goal before launching" }`

Now patch goal and launch:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/projects/$projId" -Method Patch -ContentType 'application/json' -Body '{"goal":"Build a test feature"}'
$FLINT_TEST_MODE = "1"  # Set in ecosystem.config.cjs temporarily or just observe
Invoke-RestMethod -Uri "http://localhost:3000/projects/$projId/launch" -Method Post
```

Expected: `{ orchestrationId: <number> }` and `GET /projects/:id` shows `active_orchestration_id` set.

Clean up test project:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/projects/$projId" -Method Delete
```

- [ ] **Step 6: Commit**

```powershell
git add dashboard/server.js
git commit -m "feat(proj-orch): POST /projects/:id/launch route; auto-launch on create when goal set"
git push
git push github master:main
```

---

### Task 5: UI — goal field, launch button, status chip, scratchpad modal

**Files:**
- Modify: `dashboard/public/index.html` (goal inputs in modals)
- Modify: `dashboard/public/app.js` (project card, modal wiring, polling, scratchpad modal)

**Interfaces:**
- Consumes: `POST /projects/:id/launch`; `GET /orchestrations/:id`; `GET /orchestrations/:id/scratchpad`; project object now includes `goal`, `active_orchestration_id`
- Produces: project cards showing goal line + launch button + status chip; scratchpad readable via click on chip

- [ ] **Step 1: Add goal input to New Project modal in index.html**

Find the `proj-modal` div in `dashboard/public/index.html`. Add the goal input as the first field (before Name):

```html
  <div id="proj-modal" class="hidden" role="dialog" aria-modal="true">
    <div class="modal-box">
      <h2>New Project</h2>
      <label>Goal <small style="color:#8b949e;font-weight:normal">(one sentence — what are we building?)</small>
        <input id="proj-modal-goal" type="text" placeholder="Build a competitor price-tracking tool" autocomplete="off">
      </label>
      <label>Name<input id="proj-modal-name" type="text" placeholder="My Project" autocomplete="off"></label>
      <label>Workspace
        <select id="proj-modal-workspace" style="width:100%;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px">
          <option value="">— none —</option>
        </select>
      </label>
      <label>Notes<textarea id="proj-modal-notes" rows="4" placeholder="Project context and goals…" style="width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:8px;font-family:inherit;resize:vertical"></textarea></label>
      <div class="modal-actions">
        <button id="proj-modal-cancel">Cancel</button>
        <button id="proj-modal-create">Create</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Add goal input to Edit Project modal in index.html**

Find the `edit-proj-modal` div. Add a goal input after the Name input:

```html
      <label>Name<input id="edit-proj-name" type="text" autocomplete="off"></label>
      <label>Goal <small style="color:#8b949e;font-weight:normal">(one sentence — what are we building?)</small>
        <input id="edit-proj-goal" type="text" placeholder="Build a competitor price-tracking tool" autocomplete="off">
      </label>
      <label>Workspace
```

- [ ] **Step 3: Wire goal field in openNewProjectModal (app.js)**

Find `async function openNewProjectModal()`. Add clearing the goal field:

```js
async function openNewProjectModal() {
  document.getElementById('proj-modal-goal').value = '';
  document.getElementById('proj-modal-name').value = '';
  document.getElementById('proj-modal-notes').value = '';
  await populateWorkspaceSelect('proj-modal-workspace');
  document.getElementById('proj-modal').classList.remove('hidden');
  document.getElementById('proj-modal-goal').focus();
}
```

- [ ] **Step 4: Send goal on project create (app.js)**

Find the `proj-modal-create` click handler. Update to include goal:

```js
document.getElementById('proj-modal-create').addEventListener('click', async () => {
  const goal        = document.getElementById('proj-modal-goal').value.trim();
  const name        = document.getElementById('proj-modal-name').value.trim();
  const notes       = document.getElementById('proj-modal-notes').value.trim();
  const workspace_id = Number(document.getElementById('proj-modal-workspace').value) || null;
  if (!name) return;
  await fetch('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, notes, workspace_id, ...(goal ? { goal } : {}) }),
  });
  document.getElementById('proj-modal').classList.add('hidden');
  fetchProjects();
});
```

- [ ] **Step 5: Wire goal in openEditProjectModal (app.js)**

Find `async function openEditProjectModal(projectId)`. After the `edit-proj-name` line, add:

```js
  document.getElementById('edit-proj-goal').value = p.goal || '';
```

- [ ] **Step 6: Send goal on project edit save (app.js)**

Find the `edit-proj-save` click handler. Add goal to destructure and body:

```js
document.getElementById('edit-proj-save').addEventListener('click', async () => {
  const id           = Number(document.getElementById('edit-proj-id').value);
  const name         = document.getElementById('edit-proj-name').value.trim();
  const goal         = document.getElementById('edit-proj-goal').value.trim();
  const status       = document.getElementById('edit-proj-status').value;
  const notes        = document.getElementById('edit-proj-notes').value;
  const workspace_id = Number(document.getElementById('edit-proj-workspace').value) || null;
  if (!name) return;
  await fetch(`/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, goal: goal || null, status, notes, workspace_id }),
  });
  document.getElementById('edit-proj-modal').classList.add('hidden');
  fetchProjects();
});
```

- [ ] **Step 7: Update project card to show goal, launch button, and status chip (app.js)**

Find the `for (const p of projects)` loop (~line 714). Replace the `card.innerHTML` template and the two event listeners below it:

```js
  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.id = `proj-card-${p.id}`;
    const agentStr  = p.agents.length ? p.agents.join(', ') : '(no agents)';
    const notesSnip = (p.notes || '').slice(0, 100) + ((p.notes || '').length > 100 ? '…' : '');
    const goalSnip  = (p.goal || '').slice(0, 120);
    const orchId    = p.active_orchestration_id;
    const launchBtn = p.goal
      ? `<button class="btn-launch" data-proj-id="${p.id}" style="background:#238636;border:none;color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:13px">▶ Launch</button>`
      : `<button disabled style="background:#21262d;border:none;color:#8b949e;padding:3px 10px;border-radius:4px;font-size:13px;cursor:default" title="Add a goal to enable launch">▶ Launch</button>`;
    const orchChip  = orchId
      ? `<span class="btn-orch-status badge badge-pending" data-orch-id="${orchId}" data-proj-id="${p.id}" style="cursor:pointer" title="Click to view scratchpad">⚙ …</span>`
      : '';
    card.innerHTML = `
      <div class="project-card-header">
        <span class="project-card-name">${escHtml(p.name)}</span>
        <span class="badge badge-${escHtml(p.status)}">${escHtml(p.status)}</span>
        ${orchChip}
      </div>
      ${goalSnip ? `<div class="project-card-meta" style="color:#58a6ff;font-style:italic">${escHtml(goalSnip)}</div>` : ''}
      <div class="project-card-meta">Agents: ${escHtml(agentStr)}</div>
      <div class="project-card-meta">Week: $${p.costWeek.toFixed(4)} &nbsp; Month: $${p.costMonth.toFixed(4)}</div>
      ${notesSnip ? `<div class="project-card-notes">${escHtml(notesSnip)}</div>` : ''}
      <div class="project-card-footer">
        ${launchBtn}
        <button class="btn-docs" data-proj-id="${p.id}">📄 Docs</button>
        <button class="btn-edit" data-proj-id="${p.id}">Edit</button>
      </div>
    `;
    card.querySelector('.btn-edit').addEventListener('click', () => openEditProjectModal(p.id));
    card.querySelector('.btn-docs').addEventListener('click', () => openDocsModal(p.id, p.name));
    const launchBtnEl = card.querySelector('.btn-launch');
    if (launchBtnEl) {
      launchBtnEl.addEventListener('click', async () => {
        launchBtnEl.textContent = '⏳ Launching…';
        launchBtnEl.disabled = true;
        try {
          const r = await fetch(`/projects/${p.id}/launch`, { method: 'POST' });
          const data = await r.json();
          if (!r.ok) { alert(data.error ?? 'Launch failed'); launchBtnEl.textContent = '▶ Launch'; launchBtnEl.disabled = false; return; }
          fetchProjects();
        } catch (err) {
          alert('Launch failed: ' + err.message);
          launchBtnEl.textContent = '▶ Launch';
          launchBtnEl.disabled = false;
        }
      });
    }
    const orchChipEl = card.querySelector('.btn-orch-status');
    if (orchChipEl) {
      orchChipEl.addEventListener('click', () => openScratchpadModal(orchId));
      pollOrchestrationStatus(orchId, orchChipEl);
    }
    view.appendChild(card);
  }
```

- [ ] **Step 8: Add pollOrchestrationStatus and openScratchpadModal functions (app.js)**

Add these two functions just before the `escHtml` function (~line 738):

```js
const _orchPollers = new Map();

function pollOrchestrationStatus(orchId, chipEl) {
  if (_orchPollers.has(orchId)) return; // already polling
  async function tick() {
    if (!chipEl.isConnected) { _orchPollers.delete(orchId); return; }
    try {
      const orch = await fetch(`/orchestrations/${orchId}`).then(r => r.json());
      const status = orch.status ?? 'running';
      chipEl.textContent = status === 'running' ? '⚙ running' : status === 'done' ? '✅ done' : `⚠ ${status}`;
      chipEl.className = `btn-orch-status badge badge-${status === 'running' ? 'pending' : status === 'done' ? 'success' : 'error'}`;
      if (status === 'running') setTimeout(tick, 15000);
      else _orchPollers.delete(orchId);
    } catch { setTimeout(tick, 15000); }
  }
  _orchPollers.set(orchId, true);
  tick();
}

async function openScratchpadModal(orchId) {
  let text = '';
  try { text = await fetch(`/orchestrations/${orchId}/scratchpad`).then(r => r.text()); } catch {}
  const existing = document.getElementById('scratchpad-modal-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'scratchpad-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:1000';
  overlay.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;width:700px;max-height:85vh;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0;color:#e6edf3">Orchestration Scratchpad #${orchId}</h3>
        <button id="sp-close" style="background:none;border:none;color:#8b949e;font-size:18px;cursor:pointer">×</button>
      </div>
      <pre style="flex:1;overflow-y:auto;background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:12px;font-size:13px;white-space:pre-wrap;word-break:break-word;color:#e6edf3;margin:0">${escHtml(text || '(empty)')}</pre>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('sp-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}
```

- [ ] **Step 9: Handle project_launched WebSocket event to refresh project list (app.js)**

Find the WebSocket `onmessage` handler (look for `case 'status_update':` or the switch statement). Add a new case:

```js
      case 'project_launched':
        fetchProjects();
        break;
```

- [ ] **Step 10: Restart and test end-to-end manually**

```powershell
pm2 restart flint-dashboard
```

Open the dashboard in browser:
1. Click Projects tab
2. Click "+ New Project"
3. Fill in Goal: "Build a simple hello-world CLI tool", Name: "test-proj", no workspace
4. Click Create → project card should appear showing the goal in blue italic
5. Verify Launch button is enabled (green ▶ Launch)
6. Click ▶ Launch → button shows "⏳ Launching…" then refreshes
7. Project card now shows ⚙ running chip
8. Click the chip → scratchpad modal opens showing orchestration content
9. Edit project → goal field is pre-filled

Also test: create project with NO goal → Launch button is disabled (greyed out).

- [ ] **Step 11: Commit**

```powershell
git add dashboard/public/app.js dashboard/public/index.html
git commit -m "feat(proj-orch): project cards — goal field, launch button, orchestration status chip, scratchpad modal"
git push
git push github master:main
pm2 restart flint-dashboard
```

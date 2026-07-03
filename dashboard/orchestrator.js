import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getDb } from './db.js';
import { writeTasks } from './tasks.js';
import { registerAgent, broadcastGlobal } from './agents.js';
import { spawnAgent } from './terminal.js';
import { listDocsWithContent } from './project_docs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');

function getTasksDir() {
  return process.env.FLINT_TASKS_DIR ?? join(FLINT_ROOT, 'tasks');
}

export function getOrchestration(id) {
  return getDb().prepare('SELECT * FROM orchestrations WHERE id = ?').get(id);
}

export function listOrchestrations() {
  return getDb().prepare('SELECT * FROM orchestrations ORDER BY id DESC').all();
}

export function updateOrchestrationStatus(id, status) {
  getDb().prepare('UPDATE orchestrations SET status = ? WHERE id = ?').run(status, id);
}

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
Always include \`"project_id":${projectId ?? 'null'}\` — this is how Flint knows to run the
assigned specialist inside the project workspace instead of Flint's own root directory.
\`\`\`bash
curl -s -X POST http://localhost:${process.env.PORT ?? 3000}/queue/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title":"<title>","description":"<desc — include workspace path and artifact file paths>","assigned_to":"<specialist-name>","role":"researcher","project_id":${projectId ?? 'null'},"created_by":"orch-${id}"}'
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

export function appendScratchpad(id, content) {
  const path = join(getTasksDir(), `orch-${id}`, 'scratchpad.md');
  if (!existsSync(path)) return;
  const existing = readFileSync(path, 'utf8');
  writeFileSync(path, existing + content, 'utf8');
}

export function readScratchpad(id) {
  const path = join(getTasksDir(), `orch-${id}`, 'scratchpad.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

export function createOrchestration({ goal, workdir, model, projectId, specialists = [], projectNotes = '', workspacePath = null } = {}) {
  if (!goal || !workdir) throw new Error('goal and workdir required');

  const db = getDb();
  const r = db.prepare(
    'INSERT INTO orchestrations (goal, agent_name, project_id) VALUES (?, ?, ?)'
  ).run(goal, 'placeholder', projectId ?? null);
  const id = r.lastInsertRowid;
  const agentName = `orch-${id}`;
  db.prepare('UPDATE orchestrations SET agent_name = ? WHERE id = ?').run(agentName, id);

  // Create scratchpad directory + file
  const orchDir = join(getTasksDir(), `orch-${id}`);
  if (!existsSync(orchDir)) mkdirSync(orchDir, { recursive: true });
  const scratchpadPath = join(getTasksDir(), `orch-${id}`, 'scratchpad.md');
  const absPath = join(orchDir, 'scratchpad.md');
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  writeFileSync(absPath, `# Orchestration: ${goal}\n\nStarted: ${timestamp}\n\n## Plan\n\n## Findings\n\n## Synthesis\n`, 'utf8');

  // Write orchestrator task file
  const projectDocs = projectId ? listDocsWithContent(projectId) : [];
  writeTasks(agentName, buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs, specialists, projectNotes, workspacePath: workspacePath || workdir, projectId }));

  // Register the orchestrator agent
  registerAgent(agentName, 'spawn', workdir, null, model ?? '', 'claude');

  const TEST_MODE = process.env.FLINT_TEST_MODE === '1';
  if (!TEST_MODE) {
    spawnAgent(agentName, workdir, model ?? null, {});
  }

  broadcastGlobal({ type: 'orchestration_started', id, agentName, goal });

  return { id, agentName, scratchpadPath };
}

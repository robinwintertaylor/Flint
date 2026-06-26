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

export function buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs = [] }) {
  const docsSection = projectDocs.length > 0
    ? `\n## Project Documents\n\nThe following reference documents are attached to this project. Use them to inform your plan.\n\n${projectDocs.map(d => `### ${d.title}\n\n${d.content}`).join('\n\n---\n\n')}\n`
    : '';

  return `## Orchestration Goal
${goal}
${docsSection}
## Your Role — Orchestrator
You are the Flint Orchestrator. Your job:
1. Read the goal above and think through what needs to happen.
2. Write your plan to the shared scratchpad.
3. Create queue tasks and spawn typed worker agents to execute each part.
4. Monitor progress by checking the task queue and scratchpad.
5. When all tasks are done, synthesise the results in the scratchpad under ## Synthesis.

## Shared Scratchpad
Path: ${scratchpadPath}
Write your plan there first. Workers will append findings under ## Findings.
Read it to track progress. Write your final synthesis under ## Synthesis.

## Flint REST API
Base URL: http://localhost:3000

### Spawn a worker agent
\`\`\`
# POST /agents/spawn
curl -s -X POST http://localhost:3000/agents/spawn \\
  -H "Content-Type: application/json" \\
  -d '{"name":"<agent-name>","workdir":"${workdir.replace(/\\/g, '\\\\')}","runtime":"claude"}'
\`\`\`

### Create a task and assign it to a worker
\`\`\`
# POST /queue/tasks
curl -s -X POST http://localhost:3000/queue/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title":"<title>","description":"<desc>","assigned_to":"<agent-name>","role":"researcher","created_by":"orch-${id}"}'
\`\`\`

### Check task queue progress
\`\`\`
curl -s "http://localhost:3000/queue/tasks?created_by=orch-${id}"
\`\`\`

### Mark a task done with result
\`\`\`
curl -s -X PATCH http://localhost:3000/queue/tasks/<id> \\
  -H "Content-Type: application/json" \\
  -d '{"status":"done","result":"<summary>"}'
\`\`\`

### Append synthesis to scratchpad
\`\`\`
curl -s -X POST http://localhost:3000/orchestrations/${id}/scratchpad \\
  -H "Content-Type: application/json" \\
  -d '{"text":"\\n## Synthesis\\n\\n<your synthesis here>"}'
\`\`\`

## Worker Roles
- **researcher**: investigates, reads docs, surveys prior art
- **planner**: designs architecture, data models, API contracts
- **builder**: writes code and commits it
- **tester**: writes tests, runs them, reports results

## Suggested Flow
1. Write plan to scratchpad.
2. Spawn a researcher and assign it a research task (created_by="orch-${id}").
3. When research tasks are done (poll queue), spawn planner + builder.
4. When builder finishes, spawn tester.
5. Read all findings from scratchpad, write synthesis, then your work is complete.
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

export function createOrchestration({ goal, workdir, model, projectId } = {}) {
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
  writeTasks(agentName, buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs }));

  // Register the orchestrator agent
  registerAgent(agentName, 'spawn', workdir, null, model ?? '', 'claude');

  const TEST_MODE = process.env.FLINT_TEST_MODE === '1';
  if (!TEST_MODE) {
    spawnAgent(agentName, workdir, model ?? null, {});
  }

  broadcastGlobal({ type: 'orchestration_started', id, agentName, goal });

  return { id, agentName, scratchpadPath };
}

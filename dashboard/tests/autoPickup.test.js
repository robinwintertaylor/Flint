import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

const TEMP_TASKS = join(tmpdir(), `flint-autopickup-test-${Date.now()}`);
process.env.FLINT_TASKS_DIR = TEMP_TASKS;

// Isolate agents file so registerAgent/setAgentStatus don't overwrite real agents.json.
// Must be a dynamic import: static imports are hoisted above this env var assignment,
// which would load agents.js against the real agents.json before AGENTS_FILE is overridden.
const TEMP_AGENTS = join(tmpdir(), `flint-autopickup-agents-${Date.now()}.json`);
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;

const { initDb, addWorkspace, getDb } = await import('../db.js');
const { initAgents, registerAgent, setAgentStatus } = await import('../agents.js');
const { createQueueTask } = await import('../queue.js');
const { setSetting } = await import('../settings.js');
const { createProject, updateProject } = await import('../projects.js');
const { createSpecialist } = await import('../specialists.js');
const { autoAssignPendingTasks } = await import('../autoPickup.js');

before(() => {
  initDb(':memory:');
  mkdirSync(TEMP_TASKS, { recursive: true });
});

beforeEach(() => {
  initDb(':memory:');
  initAgents();
});

test('running agent with matching role gets the task assigned', async () => {
  registerAgent('qa-bot', 'spawn', 'C:/flint', null, '', 'claude', 'tester');
  setAgentStatus('qa-bot', 'running');
  const task = createQueueTask({ title: 'Run tests', role: 'tester', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { const a = { id, name }; assigned.push(a); return a; },
    spawnFn:  () => { throw new Error('spawnFn should not be called'); },
  });

  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].id, task.id);
  assert.equal(assigned[0].name, 'qa-bot');
});

test('stopped agent with matching role gets assigned and spawned', async () => {
  registerAgent('coder-1', 'spawn', 'C:/flint', null, '', 'claude', 'coder');
  // status defaults to stopped — no setAgentStatus call needed
  const task = createQueueTask({ title: 'Fix bug', role: 'coder', created_by: 'human' });

  const assigned = [];
  const spawned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { const a = { id, name }; assigned.push(a); return a; },
    spawnFn:  (name, workdir, model, opts) => { spawned.push(name); },
  });

  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].name, 'coder-1');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0], 'coder-1');
});

test('task with no role and no default_agent is skipped', async () => {
  setSetting('default_agent', '');
  registerAgent('worker', 'spawn', 'C:/flint', null, '', 'claude', null);
  createQueueTask({ title: 'Misc task', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { const a = { id, name }; assigned.push(a); return a; },
    spawnFn:  () => {},
  });

  assert.equal(assigned.length, 0);
});

test('task with no role uses default_agent when configured', async () => {
  registerAgent('default-worker', 'spawn', 'C:/flint', null, '', 'claude', null);
  setAgentStatus('default-worker', 'running');
  setSetting('default_agent', 'default-worker');
  const task = createQueueTask({ title: 'Misc task', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { const a = { id, name }; assigned.push(a); return a; },
    spawnFn:  () => {},
  });

  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].name, 'default-worker');
});

test('no agent matching role — task is skipped', async () => {
  createQueueTask({ title: 'Design DB', role: 'architect', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { const a = { id, name }; assigned.push(a); return a; },
    spawnFn:  () => {},
  });

  assert.equal(assigned.length, 0);
});

test('spawnFn error is caught — task stays pending (assign was called)', async () => {
  registerAgent('fragile', 'spawn', 'C:/flint', null, '', 'claude', 'builder');
  const task = createQueueTask({ title: 'Build it', role: 'builder', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { const a = { id, name }; assigned.push(a); return a; },
    spawnFn:  () => { throw new Error('PTY failed'); },
  });

  // assign was called before spawn; spawn error is caught
  assert.equal(assigned.length, 1);
});

test('pre-assigned task tied to a project spawns the specialist into the project workspace, not the default cwd', async () => {
  setSetting('default_workdir', 'C:/flint-default');
  addWorkspace('proj-a-ws', 'C:/workspaces/proj-a');
  const projectId = createProject({ name: 'Proj A' });
  updateProject(projectId, { workspace_id: 1 });
  createSpecialist({ name: 'ws-builder', label: 'WS Builder' });
  const task = createQueueTask({ title: 'Build it', role: 'ws-builder', project_id: projectId, created_by: 'human' });
  // Simulate the agent having crashed and been auto-released back to 'pending'
  // while keeping assigned_to (mirrors queue.js checkQueueTasks' stale-agent release).
  getDb().prepare(`UPDATE task_queue SET status = 'pending', assigned_to = ? WHERE id = ?`).run('ws-builder', task.id);

  const spawned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => ({ id, name }),
    spawnFn:  (name, workdir) => { spawned.push({ name, workdir }); },
  });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].workdir, 'C:/workspaces/proj-a');
});

test('role-matched task tied to a project auto-provisions the specialist into the project workspace', async () => {
  setSetting('default_workdir', 'C:/flint-default');
  addWorkspace('proj-b-ws', 'C:/workspaces/proj-b');
  const projectId = createProject({ name: 'Proj B' });
  updateProject(projectId, { workspace_id: 1 });
  createSpecialist({ name: 'db-expert', label: 'DB Expert' });
  createQueueTask({ title: 'Register table', role: 'db-expert', project_id: projectId, created_by: 'human' });

  const spawned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => ({ id, name }),
    spawnFn:  (name, workdir) => { spawned.push({ name, workdir }); },
  });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].workdir, 'C:/workspaces/proj-b');
});

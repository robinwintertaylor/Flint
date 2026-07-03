import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync as writeFileSyncFs } from 'fs';
import { tmpdir as osTmpdir } from 'os';
import { createProject } from '../projects.js';
import { registerAgent, setAgentStatus, initAgents } from '../agents.js';

// Set tasks dir before importing modules that read it at startup
const TEMP_TASKS = join(tmpdir(), `flint-queue-test-${Date.now()}`);
process.env.FLINT_TASKS_DIR = TEMP_TASKS;

import { initDb } from '../db.js';
import {
  listQueueTasks, getQueueTask, createQueueTask,
  assignQueueTask, completeQueueTask, cancelQueueTask,
  checkQueueTasks,
} from '../queue.js';
import { writeTasks } from '../tasks.js';

// Isolate agents file so registerAgent/setAgentStatus (used by the two tests below that
// exercise the commit-hook path) don't overwrite the real agents.json. Calling initAgents()
// with an explicit path works regardless of import ordering (unlike a plain
// `process.env.FLINT_AGENTS_FILE = ...` assignment, which would be hoisted below the static
// `import { registerAgent } from '../agents.js'` above and never take effect — see
// autoPickup.test.js for the same trap). Applied unconditionally in before(); harmless for
// the other tests in this file since none of them touch the agents registry.
const TEMP_AGENTS = join(tmpdir(), `flint-queue-agents-test-${Date.now()}.json`);

before(() => {
  initDb(':memory:');
  mkdirSync(TEMP_TASKS, { recursive: true });
  initAgents(TEMP_AGENTS);
});

test('initDb creates task_queue table', () => {
  const db = initDb(':memory:');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('task_queue'), 'task_queue table missing');
});

test('createQueueTask with no assigned_to sets status to pending', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Research auth', created_by: 'human' });
  assert.ok(task.id);
  assert.equal(task.status, 'pending');
  assert.equal(task.assigned_to, null);
});

test('createQueueTask with assigned_to sets status to in_progress and appends to task file', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Build API', description: 'Build a REST API', assigned_to: 'builder-1', role: 'builder', created_by: 'human' });
  assert.equal(task.status, 'in_progress');
  assert.equal(task.assigned_to, 'builder-1');
  assert.equal(task.role, 'builder');
});

test('listQueueTasks returns all tasks', () => {
  initDb(':memory:');
  createQueueTask({ title: 'Task A', created_by: 'human' });
  createQueueTask({ title: 'Task B', created_by: 'human' });
  assert.equal(listQueueTasks().length, 2);
});

test('listQueueTasks filters by status', () => {
  initDb(':memory:');
  createQueueTask({ title: 'Pending', created_by: 'human' });
  const t = createQueueTask({ title: 'Cancellable', created_by: 'human' });
  cancelQueueTask(t.id);
  const pending = listQueueTasks({ status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, 'Pending');
});

test('listQueueTasks filters by assigned_to', () => {
  initDb(':memory:');
  createQueueTask({ title: 'For alice', assigned_to: 'alice', created_by: 'human' });
  createQueueTask({ title: 'For bob', assigned_to: 'bob', created_by: 'human' });
  const aliceTasks = listQueueTasks({ assigned_to: 'alice' });
  assert.equal(aliceTasks.length, 1);
  assert.equal(aliceTasks[0].title, 'For alice');
});

test('listQueueTasks filters by created_by', () => {
  initDb(':memory:');
  createQueueTask({ title: 'By orch', created_by: 'orch-1' });
  createQueueTask({ title: 'By human', created_by: 'human' });
  const results = listQueueTasks({ created_by: 'orch-1' });
  assert.ok(results.every(t => t.created_by === 'orch-1'), 'should only return orch-1 tasks');
  assert.ok(results.some(t => t.title === 'By orch'), 'orch-1 task should be present');
});

test('assignQueueTask sets assigned_to and in_progress', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Unassigned', created_by: 'human' });
  assert.equal(task.status, 'pending');
  const updated = assignQueueTask(task.id, 'my-agent');
  assert.equal(updated.assigned_to, 'my-agent');
  assert.equal(updated.status, 'in_progress');
});

test('assignQueueTask throws when task is already in_progress', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Already in progress', assigned_to: 'agent-a', created_by: 'human' });
  assert.equal(task.status, 'in_progress');
  assert.throws(() => assignQueueTask(task.id, 'agent-b'), /already in_progress/);
});

test('assignQueueTask throws when task is already done', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Already done', created_by: 'human' });
  completeQueueTask(task.id, 'result');
  assert.throws(() => assignQueueTask(task.id, 'agent-b'), /already done/);
});

test('completeQueueTask sets done and result', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Completable', created_by: 'human' });
  completeQueueTask(task.id, 'Found 3 patterns');
  const updated = getQueueTask(task.id);
  assert.equal(updated.status, 'done');
  assert.equal(updated.result, 'Found 3 patterns');
});

test('cancelQueueTask sets cancelled', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Cancellable', created_by: 'human' });
  cancelQueueTask(task.id);
  assert.equal(getQueueTask(task.id).status, 'cancelled');
});

test('checkQueueTasks completes task when title is checked off in task file', async () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'My checked task', assigned_to: 'checker-agent', created_by: 'human' });
  assert.equal(task.status, 'in_progress');
  // Simulate agent checking off the task
  writeTasks('checker-agent', `# Tasks — checker-agent\n\n- [x] My checked task\n`);
  await checkQueueTasks();
  const updated = getQueueTask(task.id);
  assert.equal(updated.status, 'done');
});

test('checkQueueTasks does not complete task when title is still unchecked', async () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Still pending task', assigned_to: 'lazy-agent', created_by: 'human' });
  writeTasks('lazy-agent', `# Tasks — lazy-agent\n\n- [ ] Still pending task\n`);
  await checkQueueTasks();
  assert.equal(getQueueTask(task.id).status, 'in_progress');
});

test('checkQueueTasks commits to the project workspace when a project-linked task completes', async () => {
  initDb(':memory:');
  const workdir = mkdtempSync(join(osTmpdir(), 'flint-queue-commit-'));
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });

  const projectId = createProject({ name: 'Commit Hook Project' });
  const { setSetting } = await import('../settings.js');
  setSetting('default_workdir', workdir); // resolveWorkdir falls back here since no workspace_id set

  registerAgent('builder-1', 'spawn', workdir, null, '', 'claude', null);
  setAgentStatus('builder-1', 'running');

  const task = createQueueTask({ title: 'Write the docs', assigned_to: 'builder-1', project_id: projectId, created_by: 'human' });
  writeFileSyncFs(join(workdir, 'new-file.txt'), 'content');
  writeTasks('builder-1', `- [x] Write the docs\n`);

  await checkQueueTasks();

  const log = execSync('git log --pretty=%s', { cwd: workdir, encoding: 'utf8' });
  assert.match(log, /Write the docs \(#\d+, builder-1\)/);
});

test('checkQueueTasks does not attempt a commit for a task with no project_id', async () => {
  initDb(':memory:');
  registerAgent('builder-2', 'spawn', process.cwd(), null, '', 'claude', null);
  setAgentStatus('builder-2', 'running');
  const task = createQueueTask({ title: 'No project task', assigned_to: 'builder-2', created_by: 'human' });
  writeTasks('builder-2', `- [x] No project task\n`);

  await assert.doesNotReject(() => checkQueueTasks());
  assert.equal(getQueueTask(task.id).status, 'done');
});

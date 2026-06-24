import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

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

before(() => {
  initDb(':memory:');
  mkdirSync(TEMP_TASKS, { recursive: true });
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

test('assignQueueTask sets assigned_to and in_progress', () => {
  initDb(':memory:');
  const task = createQueueTask({ title: 'Unassigned', created_by: 'human' });
  assert.equal(task.status, 'pending');
  const updated = assignQueueTask(task.id, 'my-agent');
  assert.equal(updated.assigned_to, 'my-agent');
  assert.equal(updated.status, 'in_progress');
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

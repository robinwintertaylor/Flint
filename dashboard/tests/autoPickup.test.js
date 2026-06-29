import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

const TEMP_TASKS = join(tmpdir(), `flint-autopickup-test-${Date.now()}`);
process.env.FLINT_TASKS_DIR = TEMP_TASKS;

// Isolate agents file so registerAgent/setAgentStatus don't overwrite real agents.json
const TEMP_AGENTS = join(tmpdir(), `flint-autopickup-agents-${Date.now()}.json`);
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;

import { initDb } from '../db.js';
import { initAgents, registerAgent, setAgentStatus } from '../agents.js';
import { createQueueTask } from '../queue.js';
import { setSetting } from '../settings.js';
import { autoAssignPendingTasks } from '../autoPickup.js';

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
    assignFn: (id, name) => { assigned.push({ id, name }); },
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
    assignFn: (id, name) => { assigned.push({ id, name }); },
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
    assignFn: (id, name) => { assigned.push({ id, name }); },
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
    assignFn: (id, name) => { assigned.push({ id, name }); },
    spawnFn:  () => {},
  });

  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].name, 'default-worker');
});

test('no agent matching role — task is skipped', async () => {
  createQueueTask({ title: 'Design DB', role: 'architect', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { assigned.push({ id, name }); },
    spawnFn:  () => {},
  });

  assert.equal(assigned.length, 0);
});

test('spawnFn error is caught — task stays pending (assign was called)', async () => {
  registerAgent('fragile', 'spawn', 'C:/flint', null, '', 'claude', 'builder');
  const task = createQueueTask({ title: 'Build it', role: 'builder', created_by: 'human' });

  const assigned = [];
  await autoAssignPendingTasks({
    assignFn: (id, name) => { assigned.push({ id, name }); },
    spawnFn:  () => { throw new Error('PTY failed'); },
  });

  // assign was called before spawn; spawn error is caught
  assert.equal(assigned.length, 1);
});

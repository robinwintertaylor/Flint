import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

const TEMP_TASKS = join(tmpdir(), `flint-hb-test-${Date.now()}`);
process.env.FLINT_TASKS_DIR = TEMP_TASKS;
process.env.FLINT_TEST_MODE = '1';

import { initDb } from '../db.js';
import { logHeartbeat, getHeartbeatLog, collectState } from '../heartbeat.js';

before(() => {
  initDb(':memory:');
  mkdirSync(TEMP_TASKS, { recursive: true });
});

test('logHeartbeat stores note in heartbeat_log', () => {
  logHeartbeat('System looks healthy', []);
  const log = getHeartbeatLog(1);
  assert.equal(log.length, 1);
  assert.equal(log[0].note, 'System looks healthy');
});

test('getHeartbeatLog returns most recent first', () => {
  initDb(':memory:');
  logHeartbeat('First note', []);
  logHeartbeat('Second note', []);
  const log = getHeartbeatLog(10);
  assert.equal(log[0].note, 'Second note');
});

test('logHeartbeat stores actions as JSON string', () => {
  initDb(':memory:');
  const actions = [{ type: 'create_task', title: 'Test task' }];
  logHeartbeat('Note with action', actions);
  const log = getHeartbeatLog(1);
  assert.deepEqual(JSON.parse(log[0].actions_json), actions);
});

test('collectState returns required shape', () => {
  initDb(':memory:');
  const state = collectState();
  assert.ok(Array.isArray(state.agents), 'agents must be array');
  assert.ok(typeof state.queue === 'object', 'queue must be object');
  assert.ok(typeof state.queue.pending === 'number', 'pending must be number');
  assert.ok(typeof state.queue.inProgress === 'number', 'inProgress must be number');
  assert.ok(Array.isArray(state.recentNotes), 'recentNotes must be array');
  assert.ok(typeof state.ts === 'string', 'ts must be string');
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const TEMP_DB     = join(tmpdir(), `flint-specialists-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-spec-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-spec-tasks-${Date.now()}`);
const TEMP_AGENTS_ROOT = join(tmpdir(), `flint-agents-root-${Date.now()}`);

process.env.FLINT_DB_PATH      = TEMP_DB;
process.env.FLINT_AGENTS_FILE  = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR    = TEMP_TASKS;
process.env.FLINT_AGENTS_ROOT  = TEMP_AGENTS_ROOT;
process.env.FLINT_TEST_MODE    = '1';

import { initDb } from '../db.js';
import {
  listSpecialists, getSpecialist, createSpecialist,
  updateSpecialist, deleteSpecialist, incrementUsage,
} from '../specialists.js';
const { createApp, closeDb } = await import('../server.js');

let server, baseUrl;

before(() => new Promise(resolve => {
  const app = createApp();
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise(resolve => {
  server.close(() => {
    closeDb();
    rmSync(TEMP_DB,     { force: true });
    rmSync(TEMP_AGENTS, { force: true });
    rmSync(TEMP_TASKS,  { recursive: true, force: true });
    rmSync(TEMP_AGENTS_ROOT, { recursive: true, force: true });
    resolve();
  });
}));

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

// ── DB-layer tests ──────────────────────────────────────────────

test('createSpecialist persists row — getSpecialist returns it', () => {
  createSpecialist({ name: 'test-spec-1', label: 'Test Spec One' });
  const s = getSpecialist('test-spec-1');
  assert.ok(s, 'specialist not found');
  assert.equal(s.label, 'Test Spec One');
  assert.deepEqual(s.domains, []);
  assert.deepEqual(s.skills, []);
  assert.equal(s.use_count, 0);
});

test('createSpecialist stores and parses domains + skills as arrays', () => {
  createSpecialist({
    name: 'test-spec-2', label: 'Test Spec Two',
    domains: ['research', 'web'], skills: ['web-search'],
  });
  const s = getSpecialist('test-spec-2');
  assert.deepEqual(s.domains, ['research', 'web']);
  assert.deepEqual(s.skills, ['web-search']);
});

test('listSpecialists returns array with parsed arrays', () => {
  const list = listSpecialists();
  assert.ok(Array.isArray(list));
  for (const s of list) {
    assert.ok(Array.isArray(s.domains), 'domains must be array');
    assert.ok(Array.isArray(s.skills),  'skills must be array');
  }
});

test('getSpecialist returns null for unknown name', () => {
  assert.equal(getSpecialist('no-such-specialist'), null);
});

test('updateSpecialist changes label — changes count = 1', () => {
  createSpecialist({ name: 'test-spec-update', label: 'Original' });
  const n = updateSpecialist('test-spec-update', { label: 'Updated' });
  assert.equal(n, 1);
  assert.equal(getSpecialist('test-spec-update').label, 'Updated');
});

test('deleteSpecialist removes row — getSpecialist returns null', () => {
  createSpecialist({ name: 'test-spec-delete', label: 'To Delete' });
  deleteSpecialist('test-spec-delete');
  assert.equal(getSpecialist('test-spec-delete'), null);
});

test('incrementUsage increments use_count and sets last_used', () => {
  createSpecialist({ name: 'test-spec-usage', label: 'Usage Test' });
  incrementUsage('test-spec-usage');
  incrementUsage('test-spec-usage');
  const s = getSpecialist('test-spec-usage');
  assert.equal(s.use_count, 2);
  assert.ok(s.last_used, 'last_used should be set');
});

test('createSpecialist throws on invalid name', () => {
  assert.throws(() => createSpecialist({ name: 'Bad Name!', label: 'Bad' }), /lowercase/);
});

test('createSpecialist throws on duplicate name', () => {
  createSpecialist({ name: 'test-spec-dup', label: 'First' });
  assert.throws(() => createSpecialist({ name: 'test-spec-dup', label: 'Second' }));
});

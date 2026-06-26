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

// ── Selector tests ───────────────────────────────────────────────

const { mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
const { join: pathJoin } = await import('node:path');
const { selectSpecialist, createSpecialist: selectorCreate, loadSpecialist, touchUsage } = await import('../../agents/specialists/selector.js');

// FLINT_AGENTS_ROOT is already set to TEMP_AGENTS_ROOT above

test('loadSpecialist returns null for unknown specialist', () => {
  assert.equal(loadSpecialist('no-such-specialist-xyz'), null);
});

test('createSpecialist (selector) writes soul.md and config.json', async () => {
  const mockRoute = async () => 'I am a test specialist.\n\n## My approach:\n- Test carefully\n';
  const specialist = await selectorCreate(
    { name: 'test-writer', description: 'A test writing specialist', domains: ['testing'] },
    mockRoute,
  );
  assert.equal(specialist.name, 'test-writer');
  assert.equal(specialist.label, 'Test Writer');
  assert.ok(specialist.soul.length > 0, 'soul must be non-empty');

  const specialistsDir = pathJoin(TEMP_AGENTS_ROOT, 'specialists');
  assert.ok(existsSync(pathJoin(specialistsDir, 'test-writer', 'soul.md')));
  assert.ok(existsSync(pathJoin(specialistsDir, 'test-writer', 'config.json')));
});

test('createSpecialist (selector) updates specialists.json index', async () => {
  const mockRoute = async () => 'I am the index-test specialist.';
  await selectorCreate({ name: 'index-test', description: 'Tests the index' }, mockRoute);

  const indexPath = pathJoin(TEMP_AGENTS_ROOT, 'specialists.json');
  assert.ok(existsSync(indexPath));
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.ok(index.some(s => s.name === 'index-test'));
});

test('selectSpecialist returns existing specialist when match found', async () => {
  // Seed a specialist in the index
  const mockRoute1 = async () => 'soul content';
  await selectorCreate({ name: 'match-me', description: 'A matchable specialist', domains: ['code'] }, mockRoute1);

  const mockRoute2 = async () => JSON.stringify({ match: 'match-me' });
  const result = await selectSpecialist('write some code', mockRoute2);
  assert.equal(result.name, 'match-me');
});

test('selectSpecialist creates new specialist when match is null', async () => {
  const mockRoute = async (_taskType, prompt) => {
    if (prompt.startsWith('You are a specialist selector')) {
      return JSON.stringify({ match: null, suggest: { name: 'new-created', description: 'Auto-created', domains: ['general'] } });
    }
    return '# New Created\n\nI am new.\n\n## My approach:\n- Be new\n';
  };
  const result = await selectSpecialist('do something entirely new', mockRoute);
  assert.equal(result.name, 'new-created');
});

test('selectSpecialist handles malformed JSON from selector — falls back to create', async () => {
  const mockRoute = async () => 'not valid json at all';
  const result = await selectSpecialist('something broken', mockRoute);
  assert.ok(result.name, 'should return a specialist even on bad JSON');
});

test('touchUsage increments use_count in specialists.json and DB', async () => {
  const mockRoute = async () => 'soul';
  await selectorCreate({ name: 'touch-me', description: 'Touch usage test' }, mockRoute);
  touchUsage('touch-me');
  touchUsage('touch-me');

  const indexPath = pathJoin(TEMP_AGENTS_ROOT, 'specialists.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const entry = index.find(s => s.name === 'touch-me');
  assert.equal(entry.use_count, 2);
  assert.ok(entry.last_used);
});

// ── Route tests ──────────────────────────────────────────────────

test('GET /api/specialists returns array', async () => {
  const r = await req('GET', '/api/specialists');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body));
});

test('POST /api/specialists creates specialist — returns 201 with id', async () => {
  const r = await req('POST', '/api/specialists', {
    name: 'route-test-spec', label: 'Route Test Spec',
    description: 'Created via route', domains: ['testing'],
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.name, 'route-test-spec');
  assert.equal(body.label, 'Route Test Spec');
  assert.deepEqual(body.domains, ['testing']);
});

test('POST /api/specialists missing name returns 400', async () => {
  const r = await req('POST', '/api/specialists', { label: 'No Name' });
  assert.equal(r.status, 400);
});

test('POST /api/specialists invalid name returns 400', async () => {
  const r = await req('POST', '/api/specialists', { name: 'Bad Name!', label: 'Bad' });
  assert.equal(r.status, 400);
});

test('POST /api/specialists duplicate name returns 409', async () => {
  await req('POST', '/api/specialists', { name: 'route-dup', label: 'Dup One' });
  const r = await req('POST', '/api/specialists', { name: 'route-dup', label: 'Dup Two' });
  assert.equal(r.status, 409);
});

test('GET /api/specialists/:name returns specialist', async () => {
  await req('POST', '/api/specialists', { name: 'route-get', label: 'Route Get' });
  const r = await req('GET', '/api/specialists/route-get');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.name, 'route-get');
  assert.ok('soul' in body, 'soul field must be present');
});

test('GET /api/specialists/:name unknown returns 404', async () => {
  const r = await req('GET', '/api/specialists/no-such-one-xyz');
  assert.equal(r.status, 404);
});

test('PATCH /api/specialists/:name updates label', async () => {
  await req('POST', '/api/specialists', { name: 'route-patch', label: 'Original Label' });
  const r = await req('PATCH', '/api/specialists/route-patch', { label: 'Updated Label' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.label, 'Updated Label');
});

test('PATCH /api/specialists/:name unknown returns 404', async () => {
  const r = await req('PATCH', '/api/specialists/no-such-xyz', { label: 'X' });
  assert.equal(r.status, 404);
});

test('DELETE /api/specialists/:name removes specialist — returns 204', async () => {
  await req('POST', '/api/specialists', { name: 'route-delete', label: 'To Delete' });
  const r = await req('DELETE', '/api/specialists/route-delete');
  assert.equal(r.status, 204);
  const check = await req('GET', '/api/specialists/route-delete');
  assert.equal(check.status, 404);
});

test('DELETE /api/specialists/:name unknown returns 404', async () => {
  const r = await req('DELETE', '/api/specialists/no-such-xyz');
  assert.equal(r.status, 404);
});

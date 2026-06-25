import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-skills-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-skills-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-skills-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

import { createSkill, listSkills, getSkill, updateSkill, upsertSkill, deleteSkill } from '../skills.js';
const { createApp, closeDb } = await import('../server.js');

let server, baseUrl;

before(() => new Promise((resolve) => {
  const app = createApp(); // calls initDb(TEMP_DB) — DB ready for module functions
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => {
    closeDb();
    rmSync(TEMP_DB,     { force: true });
    rmSync(TEMP_AGENTS, { force: true });
    rmSync(TEMP_TASKS,  { recursive: true, force: true });
    resolve();
  });
}));

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

// --- DB module tests ---

test('createSkill returns a positive integer id', () => {
  const id = createSkill({ name: 'skill-create-test', description: 'A test skill', content: '# Test\nContent here' });
  assert.ok(id > 0);
});

test('listSkills returns entries without content field', () => {
  createSkill({ name: 'skill-list-test', description: 'List test', content: 'content' });
  const skills = listSkills();
  const skill = skills.find(s => s.name === 'skill-list-test');
  assert.ok(skill, 'skill not found in list');
  assert.ok(!('content' in skill), 'listSkills should not return content field');
});

test('getSkill returns full skill including content', () => {
  const id = createSkill({ name: 'skill-get-test', description: 'Get test', content: 'full content here' });
  const skill = getSkill(id);
  assert.ok(skill !== null, 'getSkill returned null');
  assert.ok('content' in skill, 'getSkill should return content field');
  assert.equal(skill.content, 'full content here');
});

test('updateSkill changes the name field', () => {
  const id = createSkill({ name: 'skill-update-original', description: 'Update test', content: 'content' });
  updateSkill(id, { name: 'skill-update-renamed' });
  const updated = getSkill(id);
  assert.equal(updated.name, 'skill-update-renamed');
});

test('upsertSkill on new name returns { created: true }', () => {
  const result = upsertSkill({ name: 'skill-upsert-new', description: 'Upsert test', content: 'content', source: 'agent' });
  assert.equal(result.created, true);
  assert.ok(result.id > 0);
});

test('upsertSkill on existing name returns { created: false } and updates content', () => {
  upsertSkill({ name: 'skill-upsert-existing', description: 'First', content: 'first content', source: 'agent' });
  const result = upsertSkill({ name: 'skill-upsert-existing', description: 'Second', content: 'second content', source: 'agent' });
  assert.equal(result.created, false);
  const skill = getSkill(result.id);
  assert.equal(skill.content, 'second content');
});

test('deleteSkill removes the skill — getSkill returns null afterwards', () => {
  const id = createSkill({ name: 'skill-delete-test', description: 'Delete test', content: 'content' });
  deleteSkill(id);
  assert.equal(getSkill(id), null);
});

// --- Route tests ---

test('GET /api/skills returns array', async () => {
  const r = await req('GET', '/api/skills');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body));
});

test('POST /api/skills with valid body returns 201 and { id }', async () => {
  const r = await req('POST', '/api/skills', {
    name: 'route-create-test',
    description: 'Route create test',
    content: '# Route test\nContent',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok('id' in body);
  assert.ok(body.id > 0);
});

test('POST /api/skills missing required field returns 400', async () => {
  const r = await req('POST', '/api/skills', { name: 'missing-fields-test' });
  assert.equal(r.status, 400);
});

test('GET /api/skills/:id returns skill with content field', async () => {
  const create = await req('POST', '/api/skills', {
    name: 'route-get-test',
    description: 'Get route test',
    content: 'route get content',
  });
  const { id } = await create.json();
  const r = await req('GET', `/api/skills/${id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('content' in body);
  assert.equal(body.content, 'route get content');
});

test('GET /api/skills/:id with unknown id returns 404', async () => {
  const r = await req('GET', '/api/skills/999999');
  assert.equal(r.status, 404);
});

test('PATCH /api/skills/:id updates name and returns updated skill', async () => {
  const create = await req('POST', '/api/skills', {
    name: 'route-patch-test',
    description: 'Patch test',
    content: 'content',
  });
  const { id } = await create.json();
  const r = await req('PATCH', `/api/skills/${id}`, { name: 'updated-name' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.name, 'updated-name');
});

test('DELETE /api/skills/:id returns 204', async () => {
  const create = await req('POST', '/api/skills', {
    name: 'route-delete-test',
    description: 'Delete test',
    content: 'content',
  });
  const { id } = await create.json();
  const r = await req('DELETE', `/api/skills/${id}`);
  assert.equal(r.status, 204);
});

test('POST /api/skills/import-github returns { imported, updated, skipped } in TEST_MODE', async () => {
  const r = await req('POST', '/api/skills/import-github', { url: 'https://github.com/test/repo' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('imported' in body);
  assert.ok('updated' in body);
  assert.ok('skipped' in body);
});

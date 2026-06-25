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

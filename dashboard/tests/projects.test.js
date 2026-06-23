import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Set env vars before any imports
process.env.FLINT_DB_PATH = ':memory:';

const { initDb, closeDb } = await import('../db.js');
const {
  listProjects, getProject, createProject, updateProject,
  linkAgent, unlinkAgent, getProjectForAgent,
} = await import('../projects.js');

before(() => {
  initDb(':memory:');
});

after(() => {
  closeDb();
});

test('createProject returns a numeric id', () => {
  const id = createProject({ name: 'Alpha', notes: 'first project' });
  assert.ok(typeof id === 'number' && id > 0);
});

test('listProjects returns active projects with agents and cost arrays', () => {
  initDb(':memory:');
  createProject({ name: 'Beta' });
  const list = listProjects();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
  const p = list[0];
  assert.ok(Array.isArray(p.agents));
  assert.ok(typeof p.costWeek === 'number');
  assert.ok(typeof p.costMonth === 'number');
});

test('listProjects excludes archived projects', () => {
  initDb(':memory:');
  const id = createProject({ name: 'ToArchive' });
  updateProject(id, { status: 'archived' });
  const list = listProjects();
  assert.ok(!list.find(p => p.name === 'ToArchive'));
});

test('getProject returns project by id with agents list', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Gamma', notes: 'test notes' });
  const p = getProject(id);
  assert.equal(p.name, 'Gamma');
  assert.equal(p.notes, 'test notes');
  assert.ok(Array.isArray(p.agents));
});

test('getProject returns null for unknown id', () => {
  initDb(':memory:');
  assert.equal(getProject(99999), null);
});

test('updateProject changes name, status, notes', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Delta' });
  updateProject(id, { name: 'Delta2', status: 'paused', notes: 'updated' });
  const p = getProject(id);
  assert.equal(p.name, 'Delta2');
  assert.equal(p.status, 'paused');
  assert.equal(p.notes, 'updated');
});

test('linkAgent and unlinkAgent modify project_agents', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Epsilon' });
  linkAgent(id, 'research');
  let p = getProject(id);
  assert.ok(p.agents.includes('research'));
  unlinkAgent(id, 'research');
  p = getProject(id);
  assert.ok(!p.agents.includes('research'));
});

test('linkAgent is idempotent', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Zeta' });
  linkAgent(id, 'code');
  linkAgent(id, 'code'); // should not throw or duplicate
  const p = getProject(id);
  assert.equal(p.agents.filter(a => a === 'code').length, 1);
});

test('getProjectForAgent returns project linked to agent', () => {
  initDb(':memory:');
  const id = createProject({ name: 'Eta', notes: 'agent project' });
  linkAgent(id, 'my-agent');
  const proj = getProjectForAgent('my-agent');
  assert.ok(proj !== null);
  assert.equal(proj.name, 'Eta');
  assert.equal(proj.notes, 'agent project');
});

test('getProjectForAgent returns null for unlinked agent', () => {
  initDb(':memory:');
  assert.equal(getProjectForAgent('ghost-agent'), null);
});

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync as mkd2, rmSync as rmd2 } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  initDb(':memory:');
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

// --- HTTP route tests ---

const TMP2 = join(tmpdir(), 'flint-proj-routes-' + Date.now());
mkdirSync(TMP2, { recursive: true });

// Set env vars for server import
process.env.FLINT_DB_PATH   = join(TMP2, 'usage.sqlite');
process.env.FLINT_AGENTS_FILE = join(TMP2, 'agents.json');
process.env.FLINT_TASKS_DIR   = join(TMP2, 'tasks');
process.env.FLINT_TEST_MODE   = '1';
writeFileSync(process.env.FLINT_AGENTS_FILE, '[]');

const { createApp, closeDb: closeDb2 } = await import('../server.js');

describe('HTTP routes', async () => {
  let srv, base;

  before(async () => {
    srv = createApp();
    await new Promise(resolve => srv.listen(0, resolve));
    base = `http://localhost:${srv.address().port}`;
  });

  after(async () => {
    await new Promise(resolve => srv.close(resolve));
    closeDb2();
    rmSync(TMP2, { recursive: true, force: true });
    delete process.env.FLINT_DB_PATH;
    delete process.env.FLINT_AGENTS_FILE;
    delete process.env.FLINT_TASKS_DIR;
    delete process.env.FLINT_TEST_MODE;
  });

  async function req(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${base}${path}`, opts);
    return { status: res.status, body: await res.json() };
  }

  test('GET /projects returns empty array initially', async () => {
    const { status, body } = await req('GET', '/projects');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  test('POST /projects creates a project', async () => {
    const { status, body } = await req('POST', '/projects', { name: 'Test Project', notes: 'hello' });
    assert.equal(status, 201);
    assert.equal(body.name, 'Test Project');
    assert.equal(body.notes, 'hello');
    assert.ok(typeof body.id === 'number');
  });

  test('POST /projects returns 400 when name missing', async () => {
    const { status } = await req('POST', '/projects', { notes: 'oops' });
    assert.equal(status, 400);
  });

  test('PATCH /projects/:id updates status', async () => {
    const { body: created } = await req('POST', '/projects', { name: 'Patchable' });
    const { status, body } = await req('PATCH', `/projects/${created.id}`, { status: 'paused' });
    assert.equal(status, 200);
    assert.equal(body.status, 'paused');
  });

  test('DELETE /projects/:id archives project', async () => {
    const { body: created } = await req('POST', '/projects', { name: 'Archivable' });
    const { status } = await req('DELETE', `/projects/${created.id}`);
    assert.equal(status, 200);
    const { body: list } = await req('GET', '/projects');
    assert.ok(!list.find(p => p.id === created.id));
  });

  test('POST /projects/:id/agents links agent', async () => {
    const { body: created } = await req('POST', '/projects', { name: 'Linkable' });
    const { status } = await req('POST', `/projects/${created.id}/agents`, { agentName: 'research' });
    assert.equal(status, 200);
    const { body: proj } = await req('GET', `/projects/${created.id}`);
    assert.ok(proj.agents.includes('research'));
  });

  test('DELETE /projects/:id/agents/:name unlinks agent', async () => {
    const { body: created } = await req('POST', '/projects', { name: 'Unlinkable' });
    await req('POST', `/projects/${created.id}/agents`, { agentName: 'code' });
    const { status } = await req('DELETE', `/projects/${created.id}/agents/code`);
    assert.equal(status, 200);
    const { body: proj } = await req('GET', `/projects/${created.id}`);
    assert.ok(!proj.agents.includes('code'));
  });

  test('PATCH /projects/:id returns 404 for unknown project', async () => {
    const { status } = await req('PATCH', '/projects/99999', { status: 'paused' });
    assert.equal(status, 404);
  });
});

// --- Session continuity unit tests ---

const TASK_TMP = join(tmpdir(), 'flint-tasks-' + Date.now());
mkd2(TASK_TMP, { recursive: true });
process.env.FLINT_TASKS_DIR = TASK_TMP;

const { injectProjectContext } = await import('../terminal.js');
const { writeTasks, readTasks } = await import('../tasks.js');

describe('Session continuity', async () => {
  after(() => {
    rmd2(TASK_TMP, { recursive: true, force: true });
    delete process.env.FLINT_TASKS_DIR;
  });

  test('injectProjectContext prepends project block to agent task file', () => {
    initDb(':memory:');
    const id = createProject({ name: 'Inject Project', notes: 'My notes here' });
    linkAgent(id, 'inject-agent');
    writeTasks('inject-agent', '- [ ] Existing task\n');

    injectProjectContext('inject-agent');

    const content = readTasks('inject-agent');
    assert.ok(content.includes('## Project: Inject Project'), 'project header missing');
    assert.ok(content.includes('My notes here'), 'notes missing');
    assert.ok(content.includes('- [ ] Existing task'), 'existing task should be preserved');
  });

  test('injectProjectContext is a no-op for unlinked agents', () => {
    initDb(':memory:');
    writeTasks('unlinked-agent', '- [ ] Solo task\n');
    injectProjectContext('unlinked-agent');
    const content = readTasks('unlinked-agent');
    assert.ok(!content.includes('## Project:'), 'should not inject project block');
    assert.ok(content.includes('- [ ] Solo task'), 'existing content must be preserved');
  });

  test('injectProjectContext includes last_summary when present', () => {
    initDb(':memory:');
    const id = createProject({ name: 'Summary Project', notes: 'notes' });
    updateProject(id, { last_summary: 'Session ended at step 5' });
    linkAgent(id, 'summary-agent');
    writeTasks('summary-agent', '');
    injectProjectContext('summary-agent');
    const content = readTasks('summary-agent');
    assert.ok(content.includes('Session ended at step 5'), 'last_summary missing');
  });

  test('injectProjectContext does not double-inject on second call', () => {
    initDb(':memory:');
    const id = createProject({ name: 'Double Project', notes: 'once' });
    linkAgent(id, 'double-agent');
    writeTasks('double-agent', '- [ ] task\n');
    injectProjectContext('double-agent');
    injectProjectContext('double-agent');
    const content = readTasks('double-agent');
    const count = (content.match(/## Project:/g) ?? []).length;
    assert.equal(count, 1, 'project header injected more than once');
  });
});

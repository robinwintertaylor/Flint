import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

// Point to temp files so tests don't touch real data
const TEMP_DB = join(tmpdir(), `flint-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-agents-${Date.now()}.json`);
const TEMP_TASKS = join(tmpdir(), `flint-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR = TEMP_TASKS;
process.env.FLINT_TEST_MODE = '1'; // skip actual claude spawn in tests

const { createApp, closeDb } = await import('../server.js');

let server;
let baseUrl;

before(() => new Promise((resolve) => {
  const app = createApp();
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => {
    closeDb();
    rmSync(TEMP_DB, { force: true });
    rmSync(TEMP_AGENTS, { force: true });
    rmSync(TEMP_TASKS, { recursive: true, force: true });
    resolve();
  });
}));

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

test('GET /agents returns empty array initially', async () => {
  const r = await req('GET', '/agents');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('GET /tasks/:agent returns default header for unknown agent', async () => {
  const r = await req('GET', '/tasks/ghost');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.content.includes('# Tasks — ghost'));
});

test('PATCH /tasks/:agent overwrites task content', async () => {
  await req('PATCH', '/tasks/dev', { content: '# Tasks — dev\n\n- [ ] task one\n' });
  const r = await req('GET', '/tasks/dev');
  const body = await r.json();
  assert.ok(body.content.includes('- [ ] task one'));
});

test('POST /tasks/:agent appends a task', async () => {
  await req('PATCH', '/tasks/research', { content: '# Tasks — research\n\n' });
  await req('POST', '/tasks/research', { task: 'do the thing' });
  const r = await req('GET', '/tasks/research');
  const body = await r.json();
  assert.ok(body.content.includes('- [ ] do the thing'));
});

test('GET /costs returns costs object', async () => {
  const r = await req('GET', '/costs');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.costs));
  assert.ok('monthTotal' in body);
});

test('DELETE /agents/:name returns ok:false for unknown agent', async () => {
  const r = await req('DELETE', '/agents/ghost');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, false);
});

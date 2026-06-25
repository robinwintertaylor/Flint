import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-docker-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-docker-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-docker-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

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

test('POST /api/docker/start returns { ok: true } in TEST_MODE', async () => {
  const r = await req('POST', '/api/docker/start');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
});

test('POST /api/docker/start requires no request body', async () => {
  const r = await fetch(`${baseUrl}/api/docker/start`, { method: 'POST' });
  assert.equal(r.status, 200);
});

test('GET /health response includes forgejo field', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('forgejo' in body, 'health response has forgejo field');
});

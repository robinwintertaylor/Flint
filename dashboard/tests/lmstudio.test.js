import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-lmstudio-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-lmstudio-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-lmstudio-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

import { isLmStudioReachable, listModels, generate } from '../lmstudio.js';
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

// --- Module tests ---

test('isLmStudioReachable returns true in TEST_MODE', async () => {
  assert.equal(await isLmStudioReachable(), true);
});

test('listModels returns ["local-model"] in TEST_MODE', async () => {
  assert.deepEqual(await listModels(), ['local-model']);
});

test('generate returns "test response" in TEST_MODE', async () => {
  assert.equal(await generate('local-model', 'hello'), 'test response');
});

// --- Route tests ---

test('GET /api/lmstudio/status returns { reachable, models }', async () => {
  const r = await req('GET', '/api/lmstudio/status');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('reachable' in body, 'body has reachable');
  assert.ok(Array.isArray(body.models), 'body.models is array');
  assert.equal(body.reachable, true);
});

test('POST /api/lmstudio/generate with valid body returns { response }', async () => {
  const r = await req('POST', '/api/lmstudio/generate', { model: 'local-model', prompt: 'hello' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.response, 'test response');
});

test('POST /api/lmstudio/generate missing prompt returns 400', async () => {
  const r = await req('POST', '/api/lmstudio/generate', { model: 'local-model' });
  assert.equal(r.status, 400);
});

test('POST /api/lmstudio/generate missing model returns 400', async () => {
  const r = await req('POST', '/api/lmstudio/generate', { prompt: 'hello' });
  assert.equal(r.status, 400);
});

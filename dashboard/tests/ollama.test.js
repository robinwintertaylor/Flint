import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-ollama-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-ollama-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-ollama-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

import { isOllamaReachable, listModels, generate } from '../ollama.js';
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

test('isOllamaReachable returns true in TEST_MODE', async () => {
  assert.equal(await isOllamaReachable(), true);
});

test('listModels returns ["llama3"] in TEST_MODE', async () => {
  assert.deepEqual(await listModels(), ['llama3']);
});

test('generate returns "test response" in TEST_MODE', async () => {
  assert.equal(await generate('llama3', 'hello'), 'test response');
});

// --- Route tests ---

test('GET /api/ollama/status returns { reachable, models }', async () => {
  const r = await req('GET', '/api/ollama/status');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('reachable' in body, 'body has reachable');
  assert.ok(Array.isArray(body.models), 'body.models is array');
  assert.equal(body.reachable, true);
});

test('POST /api/ollama/generate with valid body returns { response }', async () => {
  const r = await req('POST', '/api/ollama/generate', { model: 'llama3', prompt: 'hello' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.response, 'test response');
});

test('POST /api/ollama/generate missing prompt returns 400', async () => {
  const r = await req('POST', '/api/ollama/generate', { model: 'llama3' });
  assert.equal(r.status, 400);
});

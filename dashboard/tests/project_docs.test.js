import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-pdocs-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-pdocs-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-pdocs-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

import { listDocs, getDoc, createDoc, deleteDoc, listDocsWithContent } from '../project_docs.js';
const { createApp, closeDb } = await import('../server.js');

let server, baseUrl;

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

// --- DB module tests ---

test('createDoc returns a positive integer id', () => {
  const id = createDoc({ projectId: 1, title: 'PRD', content: 'product requirements here' });
  assert.ok(id > 0);
});

test('listDocs returns docs without content field', () => {
  createDoc({ projectId: 1, title: 'BRD', content: 'business requirements' });
  const docs = listDocs(1);
  assert.ok(docs.length > 0);
  const doc = docs[0];
  assert.ok(!('content' in doc), 'listDocs should not include content');
});

test('getDoc returns full doc with content', () => {
  const id = createDoc({ projectId: 1, title: 'Design Doc', content: 'design content here' });
  const doc = getDoc(id);
  assert.ok(doc !== null, 'getDoc returned null');
  assert.ok('content' in doc, 'getDoc should include content');
  assert.equal(doc.content, 'design content here');
});

test('deleteDoc removes doc — getDoc returns null afterwards', () => {
  const id = createDoc({ projectId: 1, title: 'temp', content: 'x' });
  deleteDoc(id);
  assert.equal(getDoc(id), null);
});

test('listDocsWithContent returns docs including content field', () => {
  createDoc({ projectId: 1, title: 'Full Doc', content: 'full content here' });
  const docs = listDocsWithContent(1);
  assert.ok(docs.length > 0);
  assert.ok('content' in docs[0], 'listDocsWithContent should include content');
});

// --- Route tests ---

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

test('GET /api/projects/:id/docs returns array', async () => {
  const r = await req('GET', '/api/projects/1/docs');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body));
});

test('POST /api/projects/:id/docs with plain text returns 201 and { id }', async () => {
  const r = await req('POST', '/api/projects/1/docs', {
    title: 'route-test-prd.txt',
    content: 'This is the product requirements document.',
    mimeType: 'text/plain',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok('id' in body);
  assert.ok(body.id > 0);
});

test('POST /api/projects/:id/docs with PDF mimeType returns 201 in TEST_MODE', async () => {
  const r = await req('POST', '/api/projects/1/docs', {
    title: 'spec.pdf',
    content: 'fake-base64-pdf-content',
    mimeType: 'application/pdf',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok('id' in body);
});

test('POST /api/projects/:id/docs missing title returns 400', async () => {
  const r = await req('POST', '/api/projects/1/docs', { content: 'some content' });
  assert.equal(r.status, 400);
});

test('GET /api/projects/:id/docs/:docId returns doc with content', async () => {
  const create = await req('POST', '/api/projects/1/docs', {
    title: 'route-get-test.md',
    content: '# Design\n\nArchitecture notes.',
    mimeType: 'text/markdown',
  });
  const { id } = await create.json();
  const r = await req('GET', `/api/projects/1/docs/${id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('content' in body);
  assert.equal(body.content, '# Design\n\nArchitecture notes.');
});

test('GET /api/projects/:id/docs/:docId with unknown id returns 404', async () => {
  const r = await req('GET', '/api/projects/1/docs/999999');
  assert.equal(r.status, 404);
});

test('DELETE /api/projects/:id/docs/:docId returns 204', async () => {
  const create = await req('POST', '/api/projects/1/docs', {
    title: 'delete-me.txt',
    content: 'temporary',
  });
  const { id } = await create.json();
  const r = await req('DELETE', `/api/projects/1/docs/${id}`);
  assert.equal(r.status, 204);
});

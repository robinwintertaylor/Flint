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

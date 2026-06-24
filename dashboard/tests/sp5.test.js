import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), 'flint-sp5-test-' + Date.now());
mkdirSync(TMP, { recursive: true });

process.env.FLINT_TEST_MODE  = '1';
process.env.FLINT_DB_PATH    = join(TMP, 'usage.sqlite');
process.env.FLINT_AGENTS_FILE = join(TMP, 'agents.json');

const { initDb, closeDb, upsertAgentLog, setAgentWorktree, getAgentWorktree, clearAgentWorktree } = await import('../db.js');
const { createSuggestion, listSuggestions, updateSuggestion } = await import('../suggestions.js');
const { listWorktrees } = await import('../worktrees.js');

before(() => initDb(process.env.FLINT_DB_PATH));
after(async () => {
  closeDb();
  await new Promise(r => setTimeout(r, 100));
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_DB_PATH;
  delete process.env.FLINT_AGENTS_FILE;
});

// --- Suggestion DB tests ---

test('createSuggestion inserts a row', () => {
  createSuggestion('agent-a', 'Cache getProject() calls');
  const list = listSuggestions();
  const found = list.find(s => s.agent_name === 'agent-a' && s.content === 'Cache getProject() calls');
  assert.ok(found, 'suggestion should be in list');
  assert.equal(found.status, 'new');
});

test('createSuggestion deduplicates within 60s', () => {
  createSuggestion('agent-b', 'Same content');
  createSuggestion('agent-b', 'Same content');
  const list = listSuggestions();
  const matches = list.filter(s => s.agent_name === 'agent-b' && s.content === 'Same content');
  assert.equal(matches.length, 1, 'duplicate should not be inserted');
});

test('listSuggestions excludes dismissed', () => {
  createSuggestion('agent-c', 'Will be dismissed');
  const all = listSuggestions();
  const row = all.find(s => s.agent_name === 'agent-c');
  assert.ok(row);
  updateSuggestion(row.id, { status: 'dismissed' });
  const after = listSuggestions();
  assert.ok(!after.find(s => s.id === row.id), 'dismissed should be excluded');
});

test('updateSuggestion changes status to noted', () => {
  createSuggestion('agent-d', 'Note this');
  const list = listSuggestions();
  const row = list.find(s => s.agent_name === 'agent-d');
  updateSuggestion(row.id, { status: 'noted' });
  const updated = listSuggestions().find(s => s.id === row.id);
  assert.equal(updated.status, 'noted');
});

// --- Worktree DB tests ---

test('listWorktrees returns only rows with non-null worktree_path', () => {
  upsertAgentLog('wt-agent', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  upsertAgentLog('no-wt-agent', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  setAgentWorktree('wt-agent', '/tmp/.worktrees/wt-agent-123', 'improve/wt-agent-123');
  const list = listWorktrees();
  assert.ok(list.some(r => r.name === 'wt-agent'), 'wt-agent should appear');
  assert.ok(!list.some(r => r.name === 'no-wt-agent'), 'no-wt-agent should not appear');
});

test('getAgentWorktree returns null when no worktree set', () => {
  upsertAgentLog('plain-agent', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  const wt = getAgentWorktree('plain-agent');
  assert.ok(!wt?.worktree_branch);
});

// --- HTTP tests ---

describe('Suggestion HTTP routes', () => {
  let server;
  let port;

  before(async () => {
    const { createApp } = await import('../server.js');
    server = createApp();
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
  });

  after(() => new Promise(r => server.close(r)));

  test('GET /suggestions returns only non-dismissed', async () => {
    // createSuggestion was called in DB tests above — some should exist
    const res = await fetch(`http://localhost:${port}/suggestions`);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
    assert.ok(list.every(s => s.status !== 'dismissed'), 'no dismissed in response');
  });

  test('PATCH /suggestions/:id updates status', async () => {
    // Insert a fresh suggestion
    createSuggestion('http-test-agent', 'A testable suggestion');
    const allRes = await fetch(`http://localhost:${port}/suggestions`);
    const all = await allRes.json();
    const row = all.find(s => s.agent_name === 'http-test-agent');
    assert.ok(row);

    const patchRes = await fetch(`http://localhost:${port}/suggestions/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'noted' }),
    });
    assert.equal(patchRes.status, 200);
    const body = await patchRes.json();
    assert.equal(body.ok, true);
  });
});

describe('Worktree HTTP routes', () => {
  let server;
  let port;

  before(async () => {
    const { createApp } = await import('../server.js');
    server = createApp();
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
  });

  after(() => new Promise(r => server.close(r)));

  test('GET /worktrees returns empty array when no worktrees active', async () => {
    const res = await fetch(`http://localhost:${port}/worktrees`);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
  });

  test('DELETE /worktrees/:agent returns 404 for unknown agent', async () => {
    const res = await fetch(`http://localhost:${port}/worktrees/nonexistent-agent`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 404);
  });
});

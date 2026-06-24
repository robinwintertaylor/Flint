import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Logger tests ────────────────────────────────────────────────────────────

const { info, warn, error: logError } = await import('../logger.js');

test('logger.info writes JSON line with level info', () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(chunk); return true; };
  info('test message', { key: 'val' });
  process.stdout.write = orig;
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'test message');
  assert.equal(parsed.key, 'val');
  assert.ok(parsed.ts, 'ts field missing');
});

test('logger.warn writes JSON line with level warn', () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(chunk); return true; };
  warn('something off');
  process.stdout.write = orig;
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.msg, 'something off');
});

test('logger.error writes JSON line with level error', () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(chunk); return true; };
  logError('boom', { err: 'details' });
  process.stdout.write = orig;
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.err, 'details');
});

// ─── DB PR column tests ───────────────────────────────────────────────────────

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const TMP_DB = join(tmpdir(), `flint-sp6-db-${Date.now()}.sqlite`);
process.env.FLINT_DB_PATH = TMP_DB;

const { initDb, closeDb, upsertAgentLog, setAgentPR, clearAgentPR, getAgentPR, listOpenPRAgents } = await import('../db.js');

initDb(TMP_DB);

test('setAgentPR stores PR data on agents_log', () => {
  upsertAgentLog('pr-agent', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  setAgentPR('pr-agent', 42, 'http://localhost:3030/robin/flint/pulls/42', 'open');
  const row = getAgentPR('pr-agent');
  assert.equal(row.pr_number, 42);
  assert.equal(row.pr_url, 'http://localhost:3030/robin/flint/pulls/42');
  assert.equal(row.pr_status, 'open');
});

test('clearAgentPR sets PR columns to NULL', () => {
  upsertAgentLog('clear-pr-agent', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  setAgentPR('clear-pr-agent', 7, 'http://localhost:3030/robin/flint/pulls/7', 'open');
  clearAgentPR('clear-pr-agent');
  const row = getAgentPR('clear-pr-agent');
  assert.ok(!row?.pr_number, 'pr_number should be null');
});

test('listOpenPRAgents returns only rows with pr_status open', () => {
  upsertAgentLog('open-pr', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  upsertAgentLog('merged-pr', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  upsertAgentLog('no-pr', { mode: 'spawn', workdir: '/tmp', status: 'stopped' });
  setAgentPR('open-pr', 1, 'http://localhost:3030/robin/flint/pulls/1', 'open');
  setAgentPR('merged-pr', 2, 'http://localhost:3030/robin/flint/pulls/2', 'merged');
  const list = listOpenPRAgents();
  assert.ok(list.some(r => r.name === 'open-pr'), 'open-pr should appear');
  assert.ok(!list.some(r => r.name === 'merged-pr'), 'merged-pr should not appear');
  assert.ok(!list.some(r => r.name === 'no-pr'), 'no-pr should not appear');
});

test('cleanup DB', async () => {
  closeDb();
  await new Promise(r => setTimeout(r, 100));
  try { rmSync(TMP_DB, { force: true }); } catch {}
  delete process.env.FLINT_DB_PATH;
  assert.ok(true);
});

// ─── forgejo.js stub tests (TEST_MODE) ───────────────────────────────────────

process.env.FLINT_TEST_MODE = '1';

const { isForgejoReachable, pushBranch, createPR, getPRStatus } = await import('../forgejo.js');

test('isForgejoReachable returns true in TEST_MODE', async () => {
  const result = await isForgejoReachable();
  assert.equal(result, true);
});

test('pushBranch is a no-op in TEST_MODE', () => {
  assert.doesNotThrow(() => pushBranch('improve/test-agent-20260624-120000'));
});

test('createPR returns stub in TEST_MODE', async () => {
  const result = await createPR('improve/test-20260624', 'test-agent');
  assert.equal(typeof result.prNumber, 'number');
  assert.ok(result.prUrl.includes('pulls'));
});

test('getPRStatus returns open in TEST_MODE', async () => {
  const status = await getPRStatus(1);
  assert.equal(status, 'open');
});

// ─── Server HTTP tests ────────────────────────────────────────────────────────

const TMP_SRV = join(tmpdir(), `flint-sp6-srv-${Date.now()}`);
mkdirSync(TMP_SRV, { recursive: true });
process.env.FLINT_DB_PATH    = join(TMP_SRV, 'usage.sqlite');
process.env.FLINT_AGENTS_FILE = join(TMP_SRV, 'agents.json');
process.env.FLINT_TASKS_DIR   = join(TMP_SRV, 'tasks');
process.env.FLINT_TEST_MODE   = '1';
writeFileSync(process.env.FLINT_AGENTS_FILE, '[]');

const { createApp } = await import('../server.js');

let srv6, port6;

await new Promise(resolve => {
  srv6 = createApp();
  srv6.listen(0, () => { port6 = srv6.address().port; resolve(); });
});

test('GET /health returns ok status in TEST_MODE', async () => {
  const res = await fetch(`http://localhost:${port6}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.forgejo, 'reachable');
  assert.equal(body.db, 'connected');
  assert.ok(typeof body.uptime === 'number');
});

test('POST /worktrees/:agent/merge route no longer exists (404)', async () => {
  const res = await fetch(`http://localhost:${port6}/worktrees/any-agent/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 404);
});

test('cleanup server', async () => {
  await new Promise(resolve => srv6.close(resolve));
  rmSync(TMP_SRV, { recursive: true, force: true });
  assert.ok(true);
});

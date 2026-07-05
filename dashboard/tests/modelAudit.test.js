import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync, mkdirSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-audit-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-audit-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-audit-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

import { initDb, getDb } from '../db.js';
import {
  createAuditReport, getAuditReport, listAuditReports,
  submitAuditReport, updateAuditItem, applyAuditReport,
  dismissAuditReport, buildAuditTaskFile, releaseOrphanedAuditReports,
} from '../modelAudit.js';
const { createApp, closeDb } = await import('../server.js');

let server, baseUrl;

before(() => new Promise((resolve) => {
  initDb(TEMP_DB);
  mkdirSync(TEMP_TASKS, { recursive: true });
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

test('createAuditReport returns a positive integer id', () => {
  const id = createAuditReport();
  assert.ok(id > 0);
});

test('listAuditReports includes newly created report with status running', () => {
  const id = createAuditReport();
  const reports = listAuditReports();
  const r = reports.find(x => x.id === id);
  assert.ok(r, 'report not found');
  assert.equal(r.status, 'running');
});

test('getAuditReport returns report with empty items array', () => {
  const id = createAuditReport();
  const { report, items } = getAuditReport(id);
  assert.equal(report.id, id);
  assert.deepEqual(items, []);
});

test('submitAuditReport sets status to pending_review and creates items', () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review',
    summary: 'Found one upgrade',
    items: [{
      scope: 'router',
      target: 'tiers.1.anthropic',
      label: 'Tier 1 Anthropic model',
      current_value: 'claude-haiku-4-5',
      recommended_value: 'claude-haiku-4-6',
      rationale: 'Newer and faster',
      evidence: ['https://example.com'],
    }],
  });
  const { report, items } = getAuditReport(id);
  assert.equal(report.status, 'pending_review');
  assert.equal(report.summary, 'Found one upgrade');
  assert.equal(items.length, 1);
  assert.equal(items[0].scope, 'router');
  assert.equal(items[0].status, 'pending');
});

test('submitAuditReport with no_change sets status and no items', () => {
  const id = createAuditReport();
  submitAuditReport(id, { status: 'no_change', summary: 'All optimal', items: [] });
  const { report, items } = getAuditReport(id);
  assert.equal(report.status, 'no_change');
  assert.equal(items.length, 0);
});

test('updateAuditItem changes item status to approved', () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review',
    summary: 'test',
    items: [{ scope: 'router', target: 'tiers.2.openai', label: 'Tier 2 OpenAI', current_value: 'gpt-4o', recommended_value: 'gpt-4o-mini', rationale: 'Cheaper', evidence: [] }],
  });
  const { items } = getAuditReport(id);
  updateAuditItem(items[0].id, 'approved');
  const { items: updated } = getAuditReport(id);
  assert.equal(updated[0].status, 'approved');
});

test('applyAuditReport returns count of applied items and marks report applied', () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review',
    summary: 'test',
    items: [{ scope: 'specialist', target: 'specialist:researcher', label: 'Researcher model', current_value: 'gpt-4o-mini', recommended_value: 'moonshotai/kimi-k2', rationale: 'Better research', evidence: [] }],
  });
  const { items } = getAuditReport(id);
  updateAuditItem(items[0].id, 'approved');
  const result = applyAuditReport(id);
  assert.equal(result.applied, 1);
  const { report } = getAuditReport(id);
  assert.equal(report.status, 'applied');
});

test('applyAuditReport calls pm2 save after a successful restart', () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review',
    summary: 'test',
    items: [{ scope: 'specialist', target: 'specialist:researcher', label: 'Researcher model', current_value: 'gpt-4o-mini', recommended_value: 'moonshotai/kimi-k2', rationale: 'Better research', evidence: [] }],
  });
  const { items } = getAuditReport(id);
  updateAuditItem(items[0].id, 'approved');

  const calls = [];
  const fakeExecFn = (cmd) => { calls.push(cmd); };

  const prevTestMode = process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_TEST_MODE;
  try {
    applyAuditReport(id, { execFn: fakeExecFn });
  } finally {
    if (prevTestMode !== undefined) process.env.FLINT_TEST_MODE = prevTestMode;
  }

  assert.deepEqual(calls, ['pm2 restart flint-dashboard', 'pm2 save']);
});

test('applyAuditReport still returns restartFailed:true and does not call pm2 save if restart throws', () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review',
    summary: 'test',
    items: [{ scope: 'specialist', target: 'specialist:researcher', label: 'Researcher model', current_value: 'gpt-4o-mini', recommended_value: 'moonshotai/kimi-k2', rationale: 'Better research', evidence: [] }],
  });
  const { items } = getAuditReport(id);
  updateAuditItem(items[0].id, 'approved');

  const calls = [];
  const fakeExecFn = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('restart')) throw new Error('pm2 not running');
  };

  const prevTestMode = process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_TEST_MODE;
  let result;
  try {
    result = applyAuditReport(id, { execFn: fakeExecFn });
  } finally {
    if (prevTestMode !== undefined) process.env.FLINT_TEST_MODE = prevTestMode;
  }

  assert.equal(result.restartFailed, true);
  assert.deepEqual(calls, ['pm2 restart flint-dashboard']);
});

test('dismissAuditReport sets status to dismissed', () => {
  const id = createAuditReport();
  dismissAuditReport(id);
  const { report } = getAuditReport(id);
  assert.equal(report.status, 'dismissed');
});

test('buildAuditTaskFile contains reportId, router config, and instructions', () => {
  const content = buildAuditTaskFile({
    reportId: 42,
    routerConfig: { tiers: { '1': { anthropic: 'claude-haiku-4-5' } } },
    specialists: [{ name: 'researcher', label: 'Researcher', preferred_provider: 'openrouter', preferred_model: 'gpt-4o-mini', use_count: 5 }],
    costData: [{ model: 'gpt-4o-mini', total: 0.0123 }],
  });
  assert.ok(content.includes('42'), 'reportId missing');
  assert.ok(content.includes('claude-haiku-4-5'), 'router config missing');
  assert.ok(content.includes('researcher'), 'specialist missing');
  assert.ok(content.includes('gpt-4o-mini'), 'cost data missing');
  assert.ok(content.includes('/model-audit/reports/42/submit'), 'submit endpoint missing');
});

// ── Route tests ──────────────────────────────────────────────────────────

test('POST /model-audit/trigger returns reportId', async () => {
  const r = await req('POST', '/model-audit/trigger');
  const body = await r.json();
  assert.ok(body.reportId > 0, 'reportId missing');
});

test('GET /model-audit/reports returns array', async () => {
  const r = await req('GET', '/model-audit/reports');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body));
});

test('GET /model-audit/reports/:id returns 404 for unknown', async () => {
  const r = await req('GET', '/model-audit/reports/99999');
  assert.equal(r.status, 404);
});

test('POST /model-audit/reports/:id/submit sets pending_review', async () => {
  const id = createAuditReport();
  const r = await req('POST', `/model-audit/reports/${id}/submit`, {
    status: 'pending_review',
    summary: 'route test',
    items: [{
      scope: 'router', target: 'tiers.1.anthropic', label: 'Tier 1',
      current_value: 'old', recommended_value: 'new', rationale: 'better', evidence: [],
    }],
  });
  assert.equal(r.status, 200);
  const { report } = getAuditReport(id);
  assert.equal(report.status, 'pending_review');
});

test('PATCH /model-audit/items/:id approves item', async () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review', summary: 'x',
    items: [{ scope: 'specialist', target: 'specialist:x', label: 'X', current_value: 'a', recommended_value: 'b', rationale: 'r', evidence: [] }],
  });
  const { items } = getAuditReport(id);
  const r = await req('PATCH', `/model-audit/items/${items[0].id}`, { status: 'approved' });
  assert.equal(r.status, 200);
  const { items: updated } = getAuditReport(id);
  assert.equal(updated[0].status, 'approved');
});

test('PATCH /model-audit/items/:id rejects invalid status', async () => {
  const id = createAuditReport();
  submitAuditReport(id, {
    status: 'pending_review', summary: 'x',
    items: [{ scope: 'router', target: 'tiers.1.openai', label: 'Y', current_value: 'a', recommended_value: 'b', rationale: 'r', evidence: [] }],
  });
  const { items } = getAuditReport(id);
  const r = await req('PATCH', `/model-audit/items/${items[0].id}`, { status: 'banana' });
  assert.equal(r.status, 400);
});

test('POST /model-audit/reports/:id/apply with no approved items returns 400', async () => {
  const id = createAuditReport();
  submitAuditReport(id, { status: 'pending_review', summary: 'x', items: [] });
  const r = await req('POST', `/model-audit/reports/${id}/apply`);
  assert.equal(r.status, 400);
});

test('DELETE /model-audit/reports/:id dismisses report', async () => {
  const id = createAuditReport();
  const r = await req('DELETE', `/model-audit/reports/${id}`);
  assert.equal(r.status, 200);
  const { report } = getAuditReport(id);
  assert.equal(report.status, 'dismissed');
});

// Note: this file shares one real SQLite DB across every test in it (initDb
// is only called once, in before()), so earlier tests' reports can be left at
// status='running'. These tests check the specific report they created,
// rather than the aggregate count releaseOrphanedAuditReports returns, since
// that count legitimately includes whatever else is left over from earlier
// tests in the file.

test('releaseOrphanedAuditReports marks a running report failed when its agent is not actually running', () => {
  const id = createAuditReport();
  getDb().prepare(`UPDATE model_audit_reports SET agent_name = ? WHERE id = ?`).run('model-auditor-99', id);

  releaseOrphanedAuditReports({ listAgentsFn: () => [] });

  const { report } = getAuditReport(id);
  assert.equal(report.status, 'failed');
  assert.match(report.summary, /restarted/i);
  assert.ok(report.completed_at);
});

test('releaseOrphanedAuditReports leaves a report alone if its agent really is still running', () => {
  const id = createAuditReport();
  getDb().prepare(`UPDATE model_audit_reports SET agent_name = ? WHERE id = ?`).run('model-auditor-100', id);

  releaseOrphanedAuditReports({
    listAgentsFn: () => [{ name: 'model-auditor-100', status: 'running' }],
  });

  const { report } = getAuditReport(id);
  assert.equal(report.status, 'running');
});

test('releaseOrphanedAuditReports returns 0 on a second call once everything is already reconciled', () => {
  releaseOrphanedAuditReports({ listAgentsFn: () => [] }); // clean up anything currently orphaned
  const count = releaseOrphanedAuditReports({ listAgentsFn: () => [] }); // nothing left to reconcile
  assert.equal(count, 0);
});

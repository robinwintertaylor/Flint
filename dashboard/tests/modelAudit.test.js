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

import { initDb, closeDb } from '../db.js';
import {
  createAuditReport, getAuditReport, listAuditReports,
  submitAuditReport, updateAuditItem, applyAuditReport,
  dismissAuditReport, buildAuditTaskFile,
} from '../modelAudit.js';

before(() => {
  initDb(TEMP_DB);
  mkdirSync(TEMP_TASKS, { recursive: true });
});

after(() => {
  closeDb();
  rmSync(TEMP_DB,     { force: true });
  rmSync(TEMP_AGENTS, { force: true });
  rmSync(TEMP_TASKS,  { recursive: true, force: true });
});

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

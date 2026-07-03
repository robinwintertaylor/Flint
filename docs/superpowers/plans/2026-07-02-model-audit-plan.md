# Weekly Model Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a weekly model audit that spawns a Claude agent to research and recommend model upgrades, presents per-item approve/reject cards in a new Audit tab, and automatically applies approved changes to router.json and specialist records.

**Architecture:** A new `dashboard/modelAudit.js` module handles DB operations, task-file building, agent spawn, and apply logic. Seven new routes in `server.js` expose the audit lifecycle. A new Audit view in the dashboard follows the existing `showView` tab pattern (queue-view / skills-view / specialists-view). The cron daemon triggers the audit every Sunday at 09:00 via an API call.

**Tech Stack:** Node.js ESM, better-sqlite3, Express, vanilla JS frontend, PM2 (Windows).

## Global Constraints

- ESM throughout — no `require()`; no `.cjs` files
- No new npm dependencies
- `FLINT_TEST_MODE=1` must prevent actual agent spawning and pm2 restarts in all new code
- All user content rendered into innerHTML must go through `escHtml()`
- Push workflow: `git push` (Forgejo master) then `git push github master:main`
- Audit routes use `/model-audit/` prefix (not `/api/`)
- Test runner: `node --test` (Node built-in); test files in `dashboard/tests/`
- All tests run in isolation: `FLINT_DB_PATH`, `FLINT_TEST_MODE=1`, temp dirs

---

### Task 1: DB tables + modelAudit.js module

**Files:**
- Modify: `dashboard/db.js` (add two new tables to the CREATE TABLE block)
- Create: `dashboard/modelAudit.js`
- Create: `dashboard/tests/modelAudit.test.js` (module-level tests; route tests added in Task 2)

**Interfaces:**
- Produces:
  - `createAuditReport() → number` (report id)
  - `getAuditReport(id) → { report, items }` (report row + items array with `evidence` parsed from JSON)
  - `listAuditReports() → Report[]`
  - `submitAuditReport(reportId, { status, summary, items }) → void`
  - `updateAuditItem(itemId, status) → void` (status: `'approved'|'rejected'|'pending'`)
  - `applyAuditReport(reportId) → { applied: number }` (writes router.json + specialists, marks `applied`, restarts PM2)
  - `dismissAuditReport(reportId) → void`
  - `buildAuditTaskFile({ reportId, routerConfig, specialists, costData }) → string`
  - `runModelAudit() → { reportId: number }` (collects data, builds file, spawns agent)

- [ ] **Step 1: Add two new tables to db.js**

Open `dashboard/db.js`. Find the closing backtick of the `_db.exec(`` template literal (after `heartbeat_log`). Insert the following two tables **before** the closing backtick:

```js
    CREATE TABLE IF NOT EXISTS model_audit_reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      status       TEXT NOT NULL DEFAULT 'running',
      agent_name   TEXT,
      summary      TEXT,
      started_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS model_audit_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id         INTEGER NOT NULL REFERENCES model_audit_reports(id),
      scope             TEXT NOT NULL,
      target            TEXT NOT NULL,
      label             TEXT NOT NULL,
      current_value     TEXT NOT NULL,
      recommended_value TEXT NOT NULL,
      rationale         TEXT NOT NULL,
      evidence          TEXT,
      status            TEXT NOT NULL DEFAULT 'pending'
    );
```

- [ ] **Step 2: Write failing module tests**

Create `dashboard/tests/modelAudit.test.js`:

```js
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

import { initDb } from '../db.js';
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
```

- [ ] **Step 3: Run tests to verify they fail**

```powershell
cd dashboard
node --test tests/modelAudit.test.js 2>&1 | Select-String -Pattern "FAIL|Error|Cannot find" | Select-Object -First 10
```

Expected: errors about `modelAudit.js` not found.

- [ ] **Step 4: Create dashboard/modelAudit.js**

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { getDb } from './db.js';
import { getSetting } from './settings.js';
import { listSpecialists } from './specialists.js';
import { writeTasks } from './tasks.js';
import { registerAgent } from './agents.js';
import { spawnAgent } from './terminal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const FLINT_ROOT = join(__dirname, '..');

function setNestedKey(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]]) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

export function createAuditReport() {
  const db = getDb();
  const r = db.prepare(
    `INSERT INTO model_audit_reports (status) VALUES ('running')`
  ).run();
  return Number(r.lastInsertRowid);
}

export function getAuditReport(id) {
  const db = getDb();
  const report = db.prepare(`SELECT * FROM model_audit_reports WHERE id = ?`).get(id);
  if (!report) return null;
  const items = db.prepare(`SELECT * FROM model_audit_items WHERE report_id = ? ORDER BY id`).all(id);
  return { report, items: items.map(i => ({ ...i, evidence: i.evidence ? JSON.parse(i.evidence) : [] })) };
}

export function listAuditReports() {
  return getDb().prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM model_audit_items WHERE report_id = r.id) AS item_count
     FROM model_audit_reports r ORDER BY r.started_at DESC`
  ).all();
}

export function submitAuditReport(reportId, { status, summary, items = [] }) {
  const db = getDb();
  db.prepare(
    `UPDATE model_audit_reports SET status = ?, summary = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(status, summary ?? null, reportId);
  const insert = db.prepare(
    `INSERT INTO model_audit_items (report_id, scope, target, label, current_value, recommended_value, rationale, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of items) {
    insert.run(
      reportId, item.scope, item.target, item.label,
      item.current_value, item.recommended_value, item.rationale,
      item.evidence ? JSON.stringify(item.evidence) : null
    );
  }
}

export function updateAuditItem(itemId, status) {
  getDb().prepare(`UPDATE model_audit_items SET status = ? WHERE id = ?`).run(status, itemId);
}

export function applyAuditReport(reportId) {
  const db = getDb();
  const items = db.prepare(
    `SELECT * FROM model_audit_items WHERE report_id = ? AND status = 'approved'`
  ).all(reportId);
  if (!items.length) throw new Error('No approved items to apply');

  const routerPath = join(FLINT_ROOT, 'router.json');
  let routerCfg = null;

  for (const item of items) {
    if (item.scope === 'router') {
      if (!routerCfg) routerCfg = JSON.parse(readFileSync(routerPath, 'utf8'));
      setNestedKey(routerCfg, item.target, item.recommended_value);
    } else if (item.scope === 'specialist') {
      const name = item.target.replace(/^specialist:/, '');
      db.prepare(`UPDATE specialists SET preferred_model = ? WHERE name = ?`).run(item.recommended_value, name);
    }
  }

  if (routerCfg) writeFileSync(routerPath, JSON.stringify(routerCfg, null, 2), 'utf8');

  db.prepare(
    `UPDATE model_audit_reports SET status = 'applied', completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(reportId);

  if (process.env.FLINT_TEST_MODE !== '1') {
    try { execSync('pm2 restart flint-dashboard', { stdio: 'ignore' }); } catch {}
  }

  return { applied: items.length };
}

export function dismissAuditReport(reportId) {
  getDb().prepare(`UPDATE model_audit_reports SET status = 'dismissed' WHERE id = ?`).run(reportId);
}

export function buildAuditTaskFile({ reportId, routerConfig, specialists, costData }) {
  const port = process.env.PORT ?? 3000;

  const specialistRows = specialists.length > 0
    ? specialists.map(s =>
        `| ${s.name} | ${s.label} | ${s.preferred_provider || 'anthropic'} | ${s.preferred_model || '(default)'} | ${s.use_count} |`
      ).join('\n')
    : '| (none registered) | | | | |';

  const costRows = costData.length > 0
    ? costData.map(r => `| ${r.model} | $${Number(r.total).toFixed(4)} |`).join('\n')
    : '| (no usage data) | |';

  return `## Model Audit Task

Your job: research whether the models Flint currently uses are the best available for
their roles, balancing performance, capability, and cost ("bang for buck").

## Current Configuration

### router.json
\`\`\`json
${JSON.stringify(routerConfig, null, 2)}
\`\`\`

### Specialists
| name | label | provider | model | use_count |
|---|---|---|---|---|
${specialistRows}

### 30-Day Cost by Model
| model | total_cost_usd |
|---|---|
${costRows}

## Research Steps

1. **Query OpenRouter catalogue:**
\`\`\`bash
curl -s "https://openrouter.ai/api/v1/models" -H "Authorization: Bearer $OPENROUTER_API_KEY"
\`\`\`
Look at pricing (prompt/completion tokens), context window, and description.

2. **Web-search for benchmarks:**
   - "best LLM coding benchmark 2025"
   - "best LLM research tasks 2025"
   - "OpenRouter cheapest high-quality models 2025"
   - For each model in use that may be outdated: "<model-name> successor benchmark"

3. **Evaluate each model for its role:**
   - Tier 1 (heartbeat, formatting, classification): optimise for speed + lowest cost
   - Tier 2 (research, content-writing, code): optimise for capability-to-cost ratio
   - Tier 3 (architecture): optimise for maximum capability
   - Specialists: match to their domain (coding, research, etc.)

4. If all models are already optimal, submit with status \`no_change\`.
   If any improvement found, submit with status \`pending_review\` and include items.

## Submit Your Findings

\`\`\`bash
curl -s -X POST http://localhost:${port}/model-audit/reports/${reportId}/submit \\
  -H "Content-Type: application/json" \\
  -d '{
    "status": "pending_review",
    "summary": "Found 2 upgrades...",
    "items": [
      {
        "scope": "router",
        "target": "tiers.1.anthropic",
        "label": "Tier 1 Anthropic model",
        "current_value": "claude-haiku-4-5",
        "recommended_value": "claude-haiku-4-6",
        "rationale": "Haiku 4.6 is 20% faster at the same price as of July 2025.",
        "evidence": ["https://anthropic.com/...", "https://openrouter.ai/models/..."]
      }
    ]
  }'
\`\`\`

For no-change:
\`\`\`bash
curl -s -X POST http://localhost:${port}/model-audit/reports/${reportId}/submit \\
  -H "Content-Type: application/json" \\
  -d '{"status":"no_change","summary":"All current models are optimal as of [date].","items":[]}'
\`\`\`

## Scope reference
- \`"router"\` target is a dotted path into router.json: e.g. \`"tiers.1.anthropic"\`, \`"tiers.2.openai"\`
- \`"specialist"\` target is \`"specialist:<name>"\`: e.g. \`"specialist:researcher"\`

Include up to 3 evidence URLs per item.
`;
}

export async function runModelAudit() {
  const db = getDb();

  const running = db.prepare(`SELECT id FROM model_audit_reports WHERE status = 'running' LIMIT 1`).get();
  if (running) return { reportId: running.id };

  const reportId = createAuditReport();
  const agentName = `model-auditor-${reportId}`;

  db.prepare(`UPDATE model_audit_reports SET agent_name = ? WHERE id = ?`).run(agentName, reportId);

  const routerPath = join(FLINT_ROOT, 'router.json');
  const routerConfig = JSON.parse(readFileSync(routerPath, 'utf8'));
  const specialists  = listSpecialists();
  const costData     = db.prepare(
    `SELECT model, SUM(cost_usd) AS total FROM usage
     WHERE timestamp >= date('now', '-30 days')
     GROUP BY model ORDER BY total DESC`
  ).all();

  const taskContent = buildAuditTaskFile({ reportId, routerConfig, specialists, costData });
  writeTasks(agentName, taskContent);

  const workdir = getSetting('default_workdir') || process.cwd();
  registerAgent(agentName, 'spawn', workdir, null, '', 'claude');

  if (process.env.FLINT_TEST_MODE !== '1') {
    spawnAgent(agentName, workdir, null, {});
  }

  return { reportId };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```powershell
node --test tests/modelAudit.test.js 2>&1 | Select-String -Pattern "pass|fail|Error" | Select-Object -First 20
```

Expected: all 9 tests pass.

- [ ] **Step 6: Commit**

```powershell
git add dashboard/db.js dashboard/modelAudit.js dashboard/tests/modelAudit.test.js
git commit -m "feat(model-audit): DB tables, modelAudit.js module, and module tests"
git push
git push github master:main
```

---

### Task 2: Server routes + cron schedule

**Files:**
- Modify: `dashboard/server.js` (7 new routes + import)
- Modify: `dashboard/package.json` (add modelAudit.test.js to test script)
- Modify: `.cron/schedule.json` (add Sunday 09:00 entry)
- Modify: `dashboard/tests/modelAudit.test.js` (append route tests, update before/after to start server)

**Interfaces:**
- Consumes: all exports from `./modelAudit.js` (Task 1); `notify` from `./telegram.js`; `broadcastGlobal` from `./agents.js`
- Produces REST endpoints:
  - `POST /model-audit/trigger` → `{ reportId }`
  - `GET /model-audit/reports` → `Report[]`
  - `GET /model-audit/reports/:id` → `{ report, items }`
  - `POST /model-audit/reports/:id/submit` → `{ ok: true }`
  - `PATCH /model-audit/items/:id` → `{ ok: true }`
  - `POST /model-audit/reports/:id/apply` → `{ applied: N }`
  - `DELETE /model-audit/reports/:id` → `{ ok: true }`

- [ ] **Step 1: Import modelAudit functions in server.js**

At the top of `dashboard/server.js`, add after the other dashboard module imports:

```js
import {
  runModelAudit, listAuditReports, getAuditReport,
  submitAuditReport, updateAuditItem, applyAuditReport, dismissAuditReport,
} from './modelAudit.js';
```

- [ ] **Step 2: Add 7 routes to server.js**

Find a natural location (after orchestration routes). Add:

```js
  // ── Model Audit ──────────────────────────────────────────────────────────
  app.post('/model-audit/trigger', async (_req, res) => {
    try {
      const result = await runModelAudit();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/model-audit/reports', (_req, res) => {
    res.json(listAuditReports());
  });

  app.get('/model-audit/reports/:id', (req, res) => {
    const result = getAuditReport(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'report not found' });
    res.json(result);
  });

  app.post('/model-audit/reports/:id/submit', (req, res) => {
    const id = Number(req.params.id);
    if (!getAuditReport(id)) return res.status(404).json({ error: 'report not found' });
    const { status, summary, items = [] } = req.body ?? {};
    if (!status) return res.status(400).json({ error: 'status required' });
    submitAuditReport(id, { status, summary, items });
    broadcastGlobal({ type: 'model_audit_ready', reportId: id, status });
    const msg = status === 'no_change'
      ? '🔍 Model audit complete — no changes recommended. Current models are optimal.'
      : status === 'pending_review'
      ? `🔍 Model audit complete — ${items.length} recommendation(s) ready for review in the Flint dashboard.`
      : `⚠️ Model audit failed to complete. Check the Flint dashboard for details.`;
    notify(msg);
    res.json({ ok: true });
  });

  app.patch('/model-audit/items/:id', (req, res) => {
    const { status } = req.body ?? {};
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved, rejected, or pending' });
    }
    updateAuditItem(Number(req.params.id), status);
    res.json({ ok: true });
  });

  app.post('/model-audit/reports/:id/apply', async (req, res) => {
    const id = Number(req.params.id);
    if (!getAuditReport(id)) return res.status(404).json({ error: 'report not found' });
    try {
      const result = applyAuditReport(id);
      broadcastGlobal({ type: 'model_audit_applied', reportId: id });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/model-audit/reports/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getAuditReport(id)) return res.status(404).json({ error: 'report not found' });
    dismissAuditReport(id);
    res.json({ ok: true });
  });
```

- [ ] **Step 3: Add cron entry to .cron/schedule.json**

Open `.cron/schedule.json`. Add to the `"schedules"` array:

```json
{
  "name": "Weekly Model Audit",
  "cron": "0 9 * * 0",
  "type": "api",
  "url": "http://localhost:3000/model-audit/trigger",
  "description": "Sunday 09:00 — audit model assignments and surface recommendations"
}
```

- [ ] **Step 4: Add modelAudit.test.js to the test script in package.json**

Open `dashboard/package.json`. Find the `"test"` script. Append `tests/modelAudit.test.js` to the space-separated list of test files.

- [ ] **Step 5: Update modelAudit.test.js — add server + route tests**

Open `dashboard/tests/modelAudit.test.js`. Replace the top of the file (through the `after` block) with this updated version that also starts the Express server, then append the route tests at the bottom.

Replace the existing imports + `before` + `after`:

```js
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

import { initDb } from '../db.js';
import {
  createAuditReport, getAuditReport, listAuditReports,
  submitAuditReport, updateAuditItem, applyAuditReport,
  dismissAuditReport, buildAuditTaskFile,
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
```

Then append these route tests at the end of the file:

```js
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
```

- [ ] **Step 6: Run all tests**

```powershell
pm2 restart flint-dashboard
node --test tests/modelAudit.test.js 2>&1 | Select-String -Pattern "pass|fail|Error" | Select-Object -First 30
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```powershell
git add dashboard/server.js dashboard/tests/modelAudit.test.js dashboard/package.json .cron/schedule.json
git commit -m "feat(model-audit): server routes, cron schedule, route tests"
git push
git push github master:main
```

---

### Task 3: UI — Audit tab

**Files:**
- Modify: `dashboard/public/index.html` (add toolbar button + audit-view div)
- Modify: `dashboard/public/app.js` (showView case, renderAuditView, badge, WS events)

**Interfaces:**
- Consumes: `GET /model-audit/reports`, `GET /model-audit/reports/:id`, `POST /model-audit/trigger`, `PATCH /model-audit/items/:id`, `POST /model-audit/reports/:id/apply`, `DELETE /model-audit/reports/:id`; WS events `model_audit_ready`, `model_audit_applied`

- [ ] **Step 1: Add toolbar button and audit-view div to index.html**

In `dashboard/public/index.html`, find the `<div id="toolbar">` block. Add the audit button after `btn-orchestrate`:

```html
    <button id="btn-audit">🔍 Audit<span id="audit-badge" style="display:none;background:#da3633;color:#fff;border-radius:10px;font-size:11px;padding:1px 6px;margin-left:4px">0</span></button>
```

Then find the other view divs (e.g. `<div id="queue-view"`, `<div id="skills-view"`). Add after them:

```html
  <div id="audit-view" class="hidden" style="padding:16px;max-width:800px;margin:0 auto"></div>
```

- [ ] **Step 2: Add 'audit' case to showView in app.js**

Find `function showView(view)`. In the chain of `else if` blocks, add a new branch for `'audit'` before the final `else`. In that branch:
- set `panels.style.display = 'none'`
- set `toolbar.style.display = 'none'`
- add `classList.add('hidden')` for: `projView`, `queueView`, `skillsView`, `specialistsView`
- remove `'hidden'` from `document.getElementById('audit-view')`
- call `fetchAndRenderAudit()`

Also update every other `else if` branch to also hide `audit-view`:
```js
document.getElementById('audit-view').classList.add('hidden');
```

- [ ] **Step 3: Add btn-audit click handler in app.js**

Find the existing button click handlers (near `document.getElementById('btn-queue').addEventListener`). Add:

```js
document.getElementById('btn-audit').addEventListener('click', () => showView('audit'));
```

- [ ] **Step 4: Add audit rendering functions in app.js**

Add these functions near the other `fetchAndRender*` functions:

```js
async function fetchAndRenderAudit() {
  const view = document.getElementById('audit-view');
  view.innerHTML = '<div style="color:#8b949e;padding:24px">Loading…</div>';
  try {
    const reports = await fetch('/model-audit/reports').then(r => r.json());
    renderAuditView(reports);
  } catch (err) {
    view.innerHTML = `<div style="color:#f85149">Failed to load audit reports: ${escHtml(err.message)}</div>`;
  }
}

function renderAuditView(reports) {
  const view = document.getElementById('audit-view');
  const latest = reports[0] ?? null;

  let statusHtml = '';
  if (!latest) {
    statusHtml = '<div style="color:#8b949e;padding:16px 0">No audits run yet. Click Run Now to start.</div>';
  } else if (latest.status === 'running') {
    statusHtml = '<div style="color:#58a6ff;padding:16px 0">⏳ Audit in progress…</div>';
  } else if (latest.status === 'no_change') {
    statusHtml = `<div style="color:#3fb950;padding:16px 0">✅ No change required</div><p style="color:#8b949e">${escHtml(latest.summary || '')}</p>`;
  } else if (latest.status === 'failed') {
    statusHtml = `<div style="color:#f85149;padding:16px 0">⚠️ Audit failed</div><p style="color:#8b949e">${escHtml(latest.summary || '')}</p>`;
  } else if (latest.status === 'applied') {
    statusHtml = `<div style="color:#3fb950;padding:16px 0">✅ Changes applied — ${escHtml(latest.completed_at || '')}</div>`;
  } else if (latest.status === 'dismissed') {
    statusHtml = '<div style="color:#8b949e;padding:16px 0">Report dismissed.</div>';
  }

  view.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="margin:0;color:#e6edf3">🔍 Model Audit</h2>
      <div style="display:flex;gap:8px;align-items:center">
        ${latest ? `<span style="color:#8b949e;font-size:13px">Last run: ${escHtml(latest.started_at?.slice(0,16) || '')}</span>` : ''}
        <button id="btn-audit-run" style="background:#238636;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px">▶ Run Now</button>
        <button id="btn-audit-back" style="background:none;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:14px">← Dashboard</button>
      </div>
    </div>
    ${statusHtml}
    <div id="audit-items-container"></div>
    ${latest?.status === 'pending_review' ? `
      <div style="margin-top:16px;text-align:right">
        <button id="btn-audit-apply" style="background:#238636;border:none;color:#fff;padding:6px 16px;border-radius:4px;cursor:pointer;font-size:14px" disabled>Apply Approved (0)</button>
      </div>` : ''}
  `;

  document.getElementById('btn-audit-back').addEventListener('click', () => showView('agents'));
  document.getElementById('btn-audit-run').addEventListener('click', async () => {
    const btn = document.getElementById('btn-audit-run');
    btn.textContent = '⏳ Starting…';
    btn.disabled = true;
    try {
      await fetch('/model-audit/trigger', { method: 'POST' });
      fetchAndRenderAudit();
    } catch (err) {
      alert('Failed to start audit: ' + err.message);
      btn.textContent = '▶ Run Now';
      btn.disabled = false;
    }
  });

  if (latest?.status === 'pending_review') {
    loadAuditItems(latest.id);
  }
}

async function loadAuditItems(reportId) {
  const { items } = await fetch(`/model-audit/reports/${reportId}`).then(r => r.json());
  const container = document.getElementById('audit-items-container');
  if (!container) return;

  if (!items.length) {
    container.innerHTML = '<div style="color:#8b949e">No recommendations.</div>';
    return;
  }

  container.innerHTML = items.map(item => `
    <div class="audit-item" id="audit-item-${item.id}" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div>
          <div style="font-weight:600;color:#e6edf3;margin-bottom:4px">${escHtml(item.label)}</div>
          <div style="font-size:13px;color:#8b949e;margin-bottom:6px">
            <span style="color:#f85149">${escHtml(item.current_value)}</span>
            <span style="color:#8b949e"> → </span>
            <span style="color:#3fb950">${escHtml(item.recommended_value)}</span>
          </div>
          <div style="font-size:13px;color:#c9d1d9;margin-bottom:6px">${escHtml(item.rationale)}</div>
          ${item.evidence?.length ? `<div style="font-size:12px">${item.evidence.map((u, i) => `<a href="${escHtml(u)}" target="_blank" rel="noopener" style="color:#58a6ff;margin-right:8px">source ${i+1}</a>`).join('')}</div>` : ''}
          <details style="margin-top:8px">
            <summary style="color:#8b949e;font-size:12px;cursor:pointer">▼ Show diff</summary>
            <pre style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:8px;font-size:12px;color:#e6edf3;margin-top:6px;overflow-x:auto">${escHtml(`${item.target}:\n  "${item.current_value}" → "${item.recommended_value}"`)}</pre>
          </details>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn-item-approve" data-item-id="${item.id}" data-approved="${item.status === 'approved' ? '1' : '0'}" style="background:${item.status==='approved'?'#238636':'#21262d'};border:1px solid #30363d;color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:13px">✓ Approve</button>
          <button class="btn-item-reject" data-item-id="${item.id}" data-rejected="${item.status === 'rejected' ? '1' : '0'}" style="background:${item.status==='rejected'?'#da3633':'#21262d'};border:1px solid #30363d;color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:13px">✗ Reject</button>
        </div>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.btn-item-approve').forEach(btn => {
    btn.addEventListener('click', async () => {
      const itemId = btn.dataset.itemId;
      const newStatus = btn.dataset.approved === '1' ? 'pending' : 'approved';
      await fetch(`/model-audit/items/${itemId}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: newStatus }) });
      loadAuditItems(reportId);
    });
  });

  container.querySelectorAll('.btn-item-reject').forEach(btn => {
    btn.addEventListener('click', async () => {
      const itemId = btn.dataset.itemId;
      const newStatus = btn.dataset.rejected === '1' ? 'pending' : 'rejected';
      await fetch(`/model-audit/items/${itemId}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: newStatus }) });
      loadAuditItems(reportId);
    });
  });

  const approvedCount = items.filter(i => i.status === 'approved').length;
  const applyBtn = document.getElementById('btn-audit-apply');
  if (applyBtn) {
    applyBtn.textContent = `Apply Approved (${approvedCount})`;
    applyBtn.disabled = approvedCount === 0;
    applyBtn.onclick = async () => {
      if (!confirm(`Apply ${approvedCount} model change(s)? The server will restart.`)) return;
      applyBtn.disabled = true;
      applyBtn.textContent = 'Applying…';
      const r = await fetch(`/model-audit/reports/${reportId}/apply`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) { alert(data.error ?? 'Apply failed'); applyBtn.disabled = false; return; }
      fetchAndRenderAudit();
    };
  }

  updateAuditBadge(items.filter(i => i.status === 'pending').length);
}

function updateAuditBadge(count) {
  const badge = document.getElementById('audit-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}
```

- [ ] **Step 5: Handle WS events model_audit_ready and model_audit_applied in app.js**

Find the WebSocket `onmessage` handler (look for the `switch` on `data.type`). Add:

```js
      case 'model_audit_ready':
        if (currentView === 'audit') fetchAndRenderAudit();
        else updateAuditBadge(1);
        break;
      case 'model_audit_applied':
        if (currentView === 'audit') fetchAndRenderAudit();
        break;
```

- [ ] **Step 6: Restart and smoke-test manually**

```powershell
pm2 restart flint-dashboard
```

Open the dashboard in the browser:
1. Click "🔍 Audit" in toolbar — verify Audit view opens with "No audits run yet"
2. Click "▶ Run Now" — button shows "⏳ Starting…", view refreshes to "⏳ Audit in progress…"
3. Verify the audit agent panel appears in the agents grid
4. In browser console, simulate a submit to test the card UI:
```js
const reports = await fetch('/model-audit/reports').then(r=>r.json());
const id = reports[0].id;
await fetch(`/model-audit/reports/${id}/submit`, {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({
    status:'pending_review', summary:'Test run',
    items:[{ scope:'router', target:'tiers.1.anthropic', label:'Tier 1 Anthropic',
      current_value:'claude-haiku-4-5', recommended_value:'claude-haiku-4-6',
      rationale:'Newer model, same price', evidence:['https://anthropic.com'] }]
  })
});
```
5. Click Audit tab again — recommendation card appears with Approve/Reject buttons
6. Click Approve — button turns green, Apply count updates to 1
7. Navigate away — verify toolbar badge shows pending count

- [ ] **Step 7: Run full test suite**

```powershell
node --test tests/modelAudit.test.js 2>&1 | Select-String -Pattern "pass|fail" | Select-Object -First 5
```

- [ ] **Step 8: Commit**

```powershell
git add dashboard/public/app.js dashboard/public/index.html
git commit -m "feat(model-audit): Audit tab — recommendation cards, approve/reject, apply, WS events, toolbar badge"
git push
git push github master:main
pm2 restart flint-dashboard
```

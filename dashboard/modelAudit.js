import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  if (keys.some(k => k === '__proto__' || k === 'constructor' || k === 'prototype')) {
    throw new Error(`Forbidden key in target path: ${dotPath}`);
  }
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
  const routerItems = items.filter(i => i.scope === 'router');
  const specialistItems = items.filter(i => i.scope === 'specialist');

  // Write router.json first — if this throws, no DB changes are made
  if (routerItems.length) {
    const routerCfg = JSON.parse(readFileSync(routerPath, 'utf8'));
    for (const item of routerItems) {
      setNestedKey(routerCfg, item.target, item.recommended_value);
    }
    writeFileSync(routerPath, JSON.stringify(routerCfg, null, 2), 'utf8');
  }

  // Commit all DB changes in one transaction
  db.transaction(() => {
    for (const item of specialistItems) {
      const name = item.target.replace(/^specialist:/, '');
      db.prepare(`UPDATE specialists SET preferred_model = ? WHERE name = ?`).run(item.recommended_value, name);
    }
    db.prepare(
      `UPDATE model_audit_reports SET status = 'applied', completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(reportId);
  })();

  let restartFailed = false;
  if (process.env.FLINT_TEST_MODE !== '1') {
    try { execSync('pm2 restart flint-dashboard', { stdio: 'ignore' }); }
    catch { restartFailed = true; }
  }

  return { applied: items.length, restartFailed };
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

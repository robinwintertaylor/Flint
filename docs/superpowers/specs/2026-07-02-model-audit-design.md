# Weekly Model Audit Design

## Goal

Once a week Flint spawns an audit agent that researches whether the models currently
assigned to its router tiers, task types, and specialists are still the best option for
their role — balancing performance, capability, and cost. It surfaces per-item
recommendations in the dashboard for Robin to approve or reject. Approved changes are
applied automatically (router.json + specialist DB records + PM2 restart). A Telegram
nudge fires when the report is ready.

---

## Architecture

Three moving parts:

**1. Audit agent** — spawned by the cron daemon every Sunday at 09:00. Given a task
file containing the current model config, specialist list, and 30-day cost data, it
uses Claude with full tool access to query the OpenRouter catalogue and web-search for
recent benchmarks and release notes, then submits structured recommendations via REST.

**2. Report store** — two new DB tables (`model_audit_reports`, `model_audit_items`)
hold one report per run and one row per recommendation. Status flows:
`running` → `pending_review` | `no_change` | `failed` → `applied` | `dismissed`.

**3. UI + apply** — a new "🔍 Audit" toolbar tab lists the latest report. Each item
has approve/reject toggles and an expandable diff. "Apply Approved" writes the changes
and restarts the server. If no changes are needed the report shows "No change required"
with the agent's rationale.

---

## Data Model

### New DB tables (added via migration in `dashboard/db.js`)

```sql
CREATE TABLE model_audit_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  status       TEXT NOT NULL DEFAULT 'running',
  agent_name   TEXT,
  summary      TEXT,
  started_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE model_audit_items (
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

**`model_audit_reports.status` values:**
- `running` — agent is working
- `pending_review` — items submitted, waiting for approval
- `no_change` — agent found nothing to improve
- `failed` — agent crashed or timed out
- `applied` — approved items have been written
- `dismissed` — Robin dismissed the report

**`model_audit_items.scope` values:**
- `router` — target is a dotted path into `router.json` (e.g. `tiers.1.anthropic`)
- `specialist` — target is `specialist:<name>` (updates `preferred_model` in DB)

**`model_audit_items.status` values:** `pending` | `approved` | `rejected`

### Cron schedule

Add one entry to `.cron/schedule.json`:

```json
{ "name": "model-audit", "cron": "0 9 * * 0", "type": "api", "url": "http://localhost:3000/model-audit/trigger" }
```

---

## Components

### `dashboard/modelAudit.js` (new)

Exports:

- `createAuditReport()` → inserts a `running` report row, returns `{ id }`
- `buildAuditTaskFile({ reportId, routerConfig, specialists, costData })` → returns task
  file string for the agent
- `submitAuditReport(reportId, { status, summary, items })` → upserts items, sets
  report status and `completed_at`
- `applyAuditReport(reportId)` → for each approved item: writes `router.json` or
  updates specialist in DB; broadcasts `model_audit_applied`; calls
  `pm2 restart flint-dashboard`; marks report `applied`
- `getAuditReport(id)` → report row with items joined
- `listAuditReports()` → all reports ordered by `started_at DESC`
- `dismissAuditReport(id)` → sets status to `dismissed`
- `updateAuditItem(id, status)` → sets item status (`approved` | `rejected`)

### Audit task file content

The agent is given:

1. **Current router config** — full `router.json` pretty-printed
2. **Specialist list** — name, label, preferred_provider, preferred_model, domains,
   use_count, last_used
3. **30-day cost data** — `SELECT model, SUM(cost_usd) FROM usage WHERE timestamp >=
   date('now','-30 days') GROUP BY model`
4. **Instructions:**
   - Query `GET https://openrouter.ai/api/v1/models` (key from env `OPENROUTER_API_KEY`)
   - Web-search: "best LLM models benchmark 2025", "OpenRouter model cost comparison",
     task-specific searches per role (coding, research, planning, etc.)
   - For each model in use: evaluate whether a better alternative exists for that
     specific role at equal or lower cost
   - If all optimal: submit `{ status: "no_change", summary: "..." }`
   - If improvements found: submit `{ status: "pending_review", summary: "...", items: [...] }`
5. **Submit endpoint:**
   ```bash
   curl -X POST http://localhost:${PORT}/model-audit/reports/${reportId}/submit \
     -H "Content-Type: application/json" \
     -d '{ "status": "...", "summary": "...", "items": [...] }'
   ```
   Each item: `{ scope, target, label, current_value, recommended_value, rationale, evidence }`
   where `evidence` is a JSON array of URL strings.

### `dashboard/server.js` changes

New routes:

```
POST   /model-audit/trigger               spawn audit agent; return { reportId }
GET    /model-audit/reports               list reports
GET    /model-audit/reports/:id           full report + items
POST   /model-audit/reports/:id/submit    agent submits findings; triggers Telegram nudge + broadcasts model_audit_ready
PATCH  /model-audit/items/:id             { status: 'approved'|'rejected' }
POST   /model-audit/reports/:id/apply     apply approved items; pm2 restart
DELETE /model-audit/reports/:id           dismiss report
```

Guard on `POST /model-audit/trigger`: if a report with status `running` already exists,
return its `id` without spawning a second agent.

### `dashboard/public/app.js` + `index.html` changes

**Toolbar:** Add "🔍 Audit" button. Show a `badge` with pending-item count when the
latest report is `pending_review` and has unapproved items.

**Audit view** (rendered like other tab views):

- Header: "Model Audit", last-run date, "▶ Run Now" button
- Status states:
  - `running` — spinner, "Audit in progress…"
  - `no_change` — "✅ No change required" + summary paragraph + date
  - `failed` — "⚠️ Audit failed" + summary
  - `pending_review` — list of recommendation cards + "Apply Approved (N)" button
  - `applied` — "✅ Changes applied on [date]" + read-only item list
  - `dismissed` — empty state with "Run Now" prompt
- **Recommendation card:**
  - Title: `label` (e.g. "Tier 1 Anthropic model")
  - `current_value` → `recommended_value`
  - `rationale` (one paragraph)
  - Evidence links (up to 3 URLs)
  - "▼ Show diff" toggle — expands JSON diff
  - "✓ Approve" / "✗ Reject" buttons (PATCH `/model-audit/items/:id`)
- **"Apply Approved (N)"** button: enabled when ≥1 item is `approved`; shows confirm
  dialog before calling `POST /model-audit/reports/:id/apply`
- WebSocket event `model_audit_applied` → toast "Models updated — server restarting…"
  + refresh tab after 3s
- WebSocket event `model_audit_ready` → refresh tab + update toolbar badge

---

## Apply Logic

`applyAuditReport(reportId)` iterates approved items:

**`scope: 'router'`** — target is a dotted key path (e.g. `tiers.1.anthropic`):
```js
const cfg = JSON.parse(readFileSync('router.json', 'utf8'));
setNestedKey(cfg, target, recommended_value);
writeFileSync('router.json', JSON.stringify(cfg, null, 2), 'utf8');
```

**`scope: 'specialist'`** — target is `specialist:<name>`:
```js
db.prepare('UPDATE specialists SET preferred_model = ? WHERE name = ?')
  .run(recommended_value, name);
```

After all items: `execSync('pm2 restart flint-dashboard')`, broadcast
`{ type: 'model_audit_applied', reportId }`, mark report `applied`.

If `router.json` write throws: rollback (no partial writes), return 500, leave report
`pending_review`.

---

## Telegram Integration

Uses existing `notify()` from `dashboard/telegram.js`. Called from `submitAuditReport()`
after status is set:

- `pending_review` with items:
  > 🔍 Model audit complete — N recommendation(s) ready for review in the Flint dashboard.
- `no_change`:
  > 🔍 Model audit complete — no changes recommended. Current models are optimal.
- `failed`:
  > ⚠️ Model audit failed to complete. Check the Flint dashboard for details.

Only fires if Telegram is configured (existing `notify()` is a no-op when unconfigured).

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| OpenRouter API unreachable | Agent notes in rationale; continues with web search only |
| Web search MCP not configured | Agent falls back to OpenRouter API only; notes limitation in summary |
| Agent crashes / never submits | Cron timeout (30 min) → server marks report `failed` |
| `router.json` write fails on apply | Rollback; 500 response; report stays `pending_review` |
| PM2 restart fails on apply | Changes written; UI warns "Restart failed — please run `pm2 restart flint-dashboard` manually" |
| Trigger while audit already running | Returns existing `{ reportId }`; no second spawn |

---

## Files Modified / Created

| File | Change |
|---|---|
| `dashboard/db.js` | Migrations: `model_audit_reports`, `model_audit_items` tables |
| `dashboard/modelAudit.js` | **New** — all audit logic |
| `dashboard/server.js` | 7 new routes + Telegram nudge wiring |
| `dashboard/public/app.js` | Audit tab rendering, card logic, WS events, toolbar badge |
| `dashboard/public/index.html` | Audit toolbar button |
| `.cron/schedule.json` | Add Sunday 09:00 model-audit entry |

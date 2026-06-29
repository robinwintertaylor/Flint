# SP9a: API Key Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an API key management screen to the Flint dashboard — Robin can store, view (masked), and manage keys for LLM providers and services; agents can retrieve real key values at runtime via REST.

**Architecture:** New `dashboard/apikeys.js` module backed by a new `api_keys` SQLite table (seeded with 5 common providers). DB-first with env-var fallback on agent reads. UI follows the existing MCP Servers modal pattern — toolbar button opens a modal with a provider table and an Add Provider form.

**Tech Stack:** better-sqlite3, Express, Node.js 20+ (`node:test`), vanilla JS/HTML/CSS. No new npm dependencies.

## Global Constraints

- `name` slugs: lowercase alphanumeric + hyphens only (`/^[a-z0-9-]+$/`).
- Five seeded providers (`anthropic`, `openai`, `github`, `telegram`, `moonshot`) cannot be deleted — `deleteApiKey` throws; route returns 403.
- `GET /api-keys` must NEVER include `key_value` in any response object.
- `GET /api-keys/:name/value` returns the real key — DB first, env var fallback, 404 if neither.
- Empty-string `key_value` in PATCH is treated as null (clears the key).
- Run tests with: `cd dashboard && node --test tests/apikeys.test.js` (unit) and `node --test tests/server.test.js` (integration).
- All commits on `master`. Do not touch `main`.

---

### Task 1: `apikeys.js` module + DB migration + unit tests

**Files:**
- Modify: `dashboard/db.js` — add `api_keys` table + seeded rows to `initDb()`
- Create: `dashboard/apikeys.js` — all DB operations and masking logic
- Create: `dashboard/tests/apikeys.test.js` — unit tests
- Modify: `dashboard/package.json` — add `tests/apikeys.test.js` to test script

**Interfaces:**
- Produces:
  - `maskKey(value: string): string`
  - `listApiKeys(): ApiKeyRow[]` — where `ApiKeyRow = { name, label, env_var, has_db_key, env_set, masked, seeded }`
  - `getApiKeyValue(name: string): string | null`
  - `createApiKey({ name, label, key_value?, env_var? }): void` — throws on duplicate or bad name
  - `updateApiKey(name: string, { key_value?, label?, env_var? }): number` — returns changes count
  - `deleteApiKey(name: string): number` — throws for seeded names; returns changes count

- [ ] **Step 1: Add `api_keys` table and seeding to `db.js`**

In `dashboard/db.js`, inside the `_db.exec(...)` template string (after the `orchestrations` table definition, before the closing backtick), add:

```sql
    CREATE TABLE IF NOT EXISTS api_keys (
      name       TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      key_value  TEXT,
      env_var    TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
```

Then, after the final `try { _db.exec('ALTER TABLE...') } catch {}` block and before the `return _db;` line, add the seeding block:

```js
  const _seedKey = _db.prepare(
    `INSERT OR IGNORE INTO api_keys (name, label, env_var) VALUES (?, ?, ?)`
  );
  [
    ['anthropic', 'Anthropic',     'ANTHROPIC_API_KEY'],
    ['openai',    'OpenAI',        'OPENAI_API_KEY'],
    ['github',    'GitHub',        'GITHUB_TOKEN'],
    ['telegram',  'Telegram',      'TELEGRAM_BOT_TOKEN'],
    ['moonshot',  'Moonshot Kimi', 'MOONSHOT_API_KEY'],
  ].forEach(([n, l, e]) => _seedKey.run(n, l, e));
```

- [ ] **Step 2: Write the failing unit tests**

Create `dashboard/tests/apikeys.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../db.js';
import {
  maskKey, listApiKeys, getApiKeyValue,
  createApiKey, updateApiKey, deleteApiKey,
} from '../apikeys.js';

test('initDb creates api_keys table with 5 seeded rows', () => {
  initDb(':memory:');
  const rows = listApiKeys();
  assert.equal(rows.length, 5);
  assert.ok(rows.some(r => r.name === 'anthropic'));
  assert.ok(rows.some(r => r.name === 'moonshot'));
});

test('maskKey masks long keys — first 4 + bullets + last 4', () => {
  assert.equal(maskKey('sk-ant-1234567890abcd'), 'sk-a••••••••abcd');
});

test('maskKey returns bullets for keys 8 chars or shorter', () => {
  assert.equal(maskKey('short'), '••••••••');
  assert.equal(maskKey(''), '••••••••');
  assert.equal(maskKey('12345678'), '••••••••');
});

test('listApiKeys never exposes raw key_value field', () => {
  initDb(':memory:');
  createApiKey({ name: 'test-p', label: 'Test', key_value: 'sk-test-1234567890abcd' });
  const row = listApiKeys().find(r => r.name === 'test-p');
  assert.ok(row, 'row must exist');
  assert.ok(!('key_value' in row), 'key_value must not appear in response');
  assert.equal(row.has_db_key, true);
  assert.match(row.masked, /•/);
});

test('listApiKeys has_db_key false and masked — when no key set', () => {
  initDb(':memory:');
  const row = listApiKeys().find(r => r.name === 'anthropic');
  assert.equal(row.has_db_key, false);
  assert.equal(row.masked, '—');
});

test('seeded rows have seeded:true, custom rows have seeded:false', () => {
  initDb(':memory:');
  createApiKey({ name: 'custom-x', label: 'Custom' });
  const list = listApiKeys();
  assert.equal(list.find(r => r.name === 'anthropic').seeded, true);
  assert.equal(list.find(r => r.name === 'custom-x').seeded, false);
});

test('getApiKeyValue returns DB key when set', () => {
  initDb(':memory:');
  updateApiKey('anthropic', { key_value: 'real-key-abc123' });
  assert.equal(getApiKeyValue('anthropic'), 'real-key-abc123');
});

test('getApiKeyValue falls back to env var when DB key is null', () => {
  initDb(':memory:');
  process.env.ANTHROPIC_API_KEY = 'env-key-xyz';
  const val = getApiKeyValue('anthropic');
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(val, 'env-key-xyz');
});

test('getApiKeyValue returns null when neither DB nor env has value', () => {
  initDb(':memory:');
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(getApiKeyValue('anthropic'), null);
});

test('getApiKeyValue returns null for unknown provider', () => {
  initDb(':memory:');
  assert.equal(getApiKeyValue('does-not-exist'), null);
});

test('createApiKey adds a new provider', () => {
  initDb(':memory:');
  createApiKey({ name: 'new-llm', label: 'New LLM', env_var: 'NEW_KEY' });
  assert.ok(listApiKeys().some(r => r.name === 'new-llm'));
});

test('createApiKey throws on duplicate name', () => {
  initDb(':memory:');
  assert.throws(() => createApiKey({ name: 'anthropic', label: 'Dup' }), /already exists/);
});

test('createApiKey throws on invalid name', () => {
  initDb(':memory:');
  assert.throws(() => createApiKey({ name: 'Bad Name!', label: 'Bad' }), /alphanumeric/);
});

test('updateApiKey clears key when empty string passed', () => {
  initDb(':memory:');
  updateApiKey('anthropic', { key_value: 'some-key' });
  updateApiKey('anthropic', { key_value: '' });
  assert.equal(getApiKeyValue('anthropic'), null);
});

test('updateApiKey returns 0 for unknown provider', () => {
  initDb(':memory:');
  const changes = updateApiKey('no-such-name', { key_value: 'x' });
  assert.equal(changes, 0);
});

test('deleteApiKey removes custom provider', () => {
  initDb(':memory:');
  createApiKey({ name: 'remove-me', label: 'Remove' });
  deleteApiKey('remove-me');
  assert.ok(!listApiKeys().some(r => r.name === 'remove-me'));
});

test('deleteApiKey throws for seeded provider', () => {
  initDb(':memory:');
  assert.throws(() => deleteApiKey('anthropic'), /seeded/);
});

test('deleteApiKey returns 0 for unknown provider', () => {
  initDb(':memory:');
  assert.equal(deleteApiKey('no-such-xyz'), 0);
});
```

- [ ] **Step 3: Run tests — expect FAIL (module not found)**

```bash
cd dashboard && node --test tests/apikeys.test.js
```

Expected: fails with `Cannot find module '../apikeys.js'` or similar.

- [ ] **Step 4: Create `dashboard/apikeys.js`**

```js
import { getDb } from './db.js';

const SEEDED = new Set(['anthropic', 'openai', 'github', 'telegram', 'moonshot']);

export function maskKey(value) {
  if (!value || value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••••••' + value.slice(-4);
}

export function listApiKeys() {
  return getDb()
    .prepare('SELECT name, label, key_value, env_var FROM api_keys ORDER BY name')
    .all()
    .map(r => ({
      name:       r.name,
      label:      r.label,
      env_var:    r.env_var ?? null,
      has_db_key: !!r.key_value,
      env_set:    !!(r.env_var && process.env[r.env_var]),
      masked:     r.key_value ? maskKey(r.key_value) : '—',
      seeded:     SEEDED.has(r.name),
    }));
}

export function getApiKeyValue(name) {
  const row = getDb()
    .prepare('SELECT key_value, env_var FROM api_keys WHERE name = ?')
    .get(name);
  if (!row) return null;
  if (row.key_value) return row.key_value;
  if (row.env_var && process.env[row.env_var]) return process.env[row.env_var];
  return null;
}

export function createApiKey({ name, label, key_value = null, env_var = null }) {
  if (!name || !label) throw new Error('name and label required');
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('name must be alphanumeric + hyphens only');
  try {
    getDb().prepare(
      'INSERT INTO api_keys (name, label, key_value, env_var) VALUES (?, ?, ?, ?)'
    ).run(name, label, key_value || null, env_var || null);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) throw new Error('name already exists');
    throw err;
  }
}

export function updateApiKey(name, { key_value, label, env_var } = {}) {
  const sets = [];
  const vals = [];
  if (key_value !== undefined) { sets.push('key_value = ?'); vals.push(key_value || null); }
  if (label    !== undefined) { sets.push('label = ?');     vals.push(label); }
  if (env_var  !== undefined) { sets.push('env_var = ?');   vals.push(env_var || null); }
  if (!sets.length) return 0;
  vals.push(name);
  return getDb()
    .prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE name = ?`)
    .run(...vals).changes;
}

export function deleteApiKey(name) {
  if (SEEDED.has(name)) throw new Error(`Cannot delete seeded provider: ${name}`);
  return getDb().prepare('DELETE FROM api_keys WHERE name = ?').run(name).changes;
}
```

- [ ] **Step 5: Run unit tests — expect all PASS**

```bash
cd dashboard && node --test tests/apikeys.test.js
```

Expected output (18 tests):
```
✔ initDb creates api_keys table with 5 seeded rows
✔ maskKey masks long keys — first 4 + bullets + last 4
...
ℹ tests 18
ℹ pass 18
ℹ fail 0
```

- [ ] **Step 6: Add `tests/apikeys.test.js` to package.json test script**

In `dashboard/package.json`, append `tests/apikeys.test.js` to the `test` command:

```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js"
```

- [ ] **Step 7: Run full suite — confirm 140 tests pass**

```bash
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 140
ℹ pass 140
ℹ fail 0
```

(122 existing + 18 new)

- [ ] **Step 8: Commit**

```bash
git add dashboard/db.js dashboard/apikeys.js dashboard/tests/apikeys.test.js dashboard/package.json
git commit -m "feat(sp9a): add api_keys table, apikeys.js module, and unit tests"
```

---

### Task 2: REST routes + integration tests

**Files:**
- Modify: `dashboard/server.js` — import `apikeys.js`; add 5 routes
- Modify: `dashboard/tests/server.test.js` — add 11 integration tests

**Interfaces:**
- Consumes (from Task 1):
  - `listApiKeys()`, `getApiKeyValue(name)`, `createApiKey({name,label,key_value,env_var})`, `updateApiKey(name, fields)`, `deleteApiKey(name)`

- [ ] **Step 1: Write the failing integration tests**

Append to `dashboard/tests/server.test.js` (after the last existing test):

```js
// --- API Key routes ---

test('GET /api-keys returns 5 seeded rows with no key_value field', async () => {
  const r = await req('GET', '/api-keys');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.length, 5);
  assert.ok(body.some(k => k.name === 'anthropic'));
  assert.ok(body.every(k => !('key_value' in k)), 'raw key must never be exposed');
  assert.ok(body.every(k => 'masked' in k), 'every row must have masked field');
});

test('GET /api-keys/:name/value returns 404 when no key configured', async () => {
  const r = await req('GET', '/api-keys/anthropic/value');
  assert.equal(r.status, 404);
});

test('PATCH /api-keys/:name sets key then GET /value returns it', async () => {
  await req('PATCH', '/api-keys/openai', { key_value: 'sk-test-openai-1234567890ab' });
  const r = await req('GET', '/api-keys/openai/value');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).value, 'sk-test-openai-1234567890ab');
});

test('PATCH /api-keys/:name returns 404 for unknown provider', async () => {
  const r = await req('PATCH', '/api-keys/does-not-exist', { key_value: 'x' });
  assert.equal(r.status, 404);
});

test('POST /api-keys creates custom provider and returns 201 with masked row', async () => {
  const r = await req('POST', '/api-keys', {
    name: 'custom-llm', label: 'Custom LLM', env_var: 'CUSTOM_KEY',
    key_value: 'ck-test-1234567890abcd',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.name, 'custom-llm');
  assert.equal(body.has_db_key, true);
  assert.ok(!('key_value' in body), 'key_value must not be in 201 response');
});

test('POST /api-keys returns 409 on duplicate name', async () => {
  const r = await req('POST', '/api-keys', { name: 'anthropic', label: 'Dup' });
  assert.equal(r.status, 409);
});

test('POST /api-keys returns 400 on missing label', async () => {
  const r = await req('POST', '/api-keys', { name: 'no-label' });
  assert.equal(r.status, 400);
});

test('POST /api-keys returns 400 on invalid name slug', async () => {
  const r = await req('POST', '/api-keys', { name: 'Bad Name!', label: 'Bad' });
  assert.equal(r.status, 400);
});

test('DELETE /api-keys/:name returns 403 for seeded provider', async () => {
  const r = await req('DELETE', '/api-keys/anthropic');
  assert.equal(r.status, 403);
});

test('DELETE /api-keys/:name removes custom provider and returns 204', async () => {
  await req('POST', '/api-keys', { name: 'to-delete', label: 'Delete Me' });
  const r = await req('DELETE', '/api-keys/to-delete');
  assert.equal(r.status, 204);
  const list = await req('GET', '/api-keys').then(r => r.json());
  assert.ok(!list.some(k => k.name === 'to-delete'));
});

test('DELETE /api-keys/:name returns 404 for unknown provider', async () => {
  const r = await req('DELETE', '/api-keys/unknown-xyz-999');
  assert.equal(r.status, 404);
});
```

- [ ] **Step 2: Run integration tests — expect FAIL (routes not defined)**

```bash
cd dashboard && node --test tests/server.test.js 2>&1 | tail -6
```

Expected: fails on `GET /api-keys` with 404.

- [ ] **Step 3: Add import and routes to `server.js`**

In `dashboard/server.js`, add to the import block (after the orchestrator import, line ~19):

```js
import { listApiKeys, getApiKeyValue, createApiKey, updateApiKey, deleteApiKey } from './apikeys.js';
```

Then, inside `createApp()`, after the existing MCP routes block (after `app.delete('/mcp/servers/:id', ...)`) add:

```js
  // --- API Key routes ---

  app.get('/api-keys', (_req, res) => res.json(listApiKeys()));

  app.get('/api-keys/:name/value', (req, res) => {
    const value = getApiKeyValue(req.params.name);
    if (value === null) return res.status(404).json({ error: `No key configured for ${req.params.name}` });
    res.json({ value });
  });

  app.post('/api-keys', (req, res) => {
    const { name, label, key_value, env_var } = req.body ?? {};
    if (!name || !label) return res.status(400).json({ error: 'name and label required' });
    try {
      createApiKey({ name, label, key_value, env_var });
      const created = listApiKeys().find(r => r.name === name);
      res.status(201).json(created);
    } catch (err) {
      if (err.message === 'name already exists') return res.status(409).json({ error: err.message });
      if (err.message.includes('alphanumeric')) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.patch('/api-keys/:name', (req, res) => {
    const changes = updateApiKey(req.params.name, req.body ?? {});
    if (!changes) return res.status(404).json({ error: 'provider not found' });
    const updated = listApiKeys().find(r => r.name === req.params.name);
    res.json(updated);
  });

  app.delete('/api-keys/:name', (req, res) => {
    try {
      const changes = deleteApiKey(req.params.name);
      if (!changes) return res.status(404).json({ error: 'provider not found' });
      res.status(204).send();
    } catch (err) {
      if (err.message.includes('seeded')) return res.status(403).json({ error: err.message });
      throw err;
    }
  });
```

- [ ] **Step 4: Run integration tests — expect all 11 PASS**

```bash
cd dashboard && node --test tests/server.test.js 2>&1 | tail -6
```

Expected:
```
ℹ tests 133
ℹ pass 133
ℹ fail 0
```

(122 existing + 11 new)

- [ ] **Step 5: Run full suite**

```bash
cd dashboard && node --test 2>&1 | tail -6
```

Expected: `ℹ pass 151` (or 140+11 — exact count depends on Step 7 of Task 1 having been run).

- [ ] **Step 6: Commit**

```bash
git add dashboard/server.js dashboard/tests/server.test.js
git commit -m "feat(sp9a): add REST routes for API key management"
```

---

### Task 3: UI — toolbar button, modal, and app.js wiring

**Files:**
- Modify: `dashboard/public/index.html` — add toolbar button + `#keys-modal` HTML
- Modify: `dashboard/public/style.css` — add `#keys-modal` to fixed-position group, env badge styles
- Modify: `dashboard/public/app.js` — add `renderKeysList()` and event wiring

**Interfaces:**
- Consumes (from Task 2): `GET /api-keys`, `GET /api-keys/:name/value`, `POST /api-keys`, `PATCH /api-keys/:name`, `DELETE /api-keys/:name`
- Consumes: `escHtml(str)` — already defined in `app.js`

No automated tests. Verification: open modal in browser, add/edit/clear/delete providers.

- [ ] **Step 1: Add toolbar button to index.html**

In `dashboard/public/index.html`, inside `<div id="toolbar">`, after `<button id="btn-mcp">⚡ MCP</button>`:

```html
    <button id="btn-keys">🔑 Keys</button>
```

- [ ] **Step 2: Add `#keys-modal` HTML to index.html**

In `dashboard/public/index.html`, after the `<!-- Orchestrate modal -->` block (before the `<!-- Diff viewer modal -->` comment), add:

```html
  <!-- API Keys modal -->
  <div id="keys-modal" class="hidden" role="dialog" aria-modal="true">
    <div class="modal-box" style="max-width:720px;width:95vw">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="margin:0">API Keys</h2>
        <button id="keys-modal-close" style="background:none;border:none;color:#8b949e;font-size:21px;cursor:pointer">✕</button>
      </div>
      <div id="keys-list" style="margin-bottom:20px;min-height:32px"></div>
      <h4 style="color:#58a6ff;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Add Provider</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
        <input id="keys-add-name" type="text" placeholder="Name slug (e.g. moonshot)" style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:16px;font-family:inherit">
        <input id="keys-add-label" type="text" placeholder="Display name (e.g. Moonshot Kimi)" style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:16px;font-family:inherit">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
        <input id="keys-add-env" type="text" placeholder="Env var (e.g. MOONSHOT_API_KEY)" style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:16px;font-family:inherit">
        <input id="keys-add-value" type="password" placeholder="API key (optional)" style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:16px;font-family:inherit">
      </div>
      <div style="display:flex;justify-content:flex-end">
        <button id="keys-add-btn" style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 16px;cursor:pointer;font-size:16px">Add Provider</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Add CSS for keys-modal and env badges**

In `dashboard/public/style.css`, update the `#add-task-modal, #orch-modal` rule to include `#keys-modal`:

```
Old:
#add-task-modal,
#orch-modal {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}

New:
#add-task-modal,
#orch-modal,
#keys-modal {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
```

Then at the end of `style.css`, add:

```css
/* API Keys modal badges */
.badge-env-set {
  background: #1a4731; color: #3fb950;
  font-size: 12px; padding: 1px 6px; border-radius: 10px; margin-left: 6px;
}
.badge-env-not {
  background: #21262d; color: #8b949e;
  font-size: 12px; padding: 1px 6px; border-radius: 10px; margin-left: 6px;
}
```

- [ ] **Step 4: Add `renderKeysList()` and event wiring to app.js**

At the end of `dashboard/public/app.js`, append:

```js
// ============================================================
// API Keys modal
// ============================================================

async function renderKeysList() {
  const list = await fetch('/api-keys').then(r => r.json()).catch(() => []);
  const container = document.getElementById('keys-list');
  if (!list.length) {
    container.innerHTML = '<p style="color:#8b949e;font-size:16px;margin:0">No providers configured.</p>';
    return;
  }
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:16px">
      <thead><tr>
        <th style="text-align:left;padding:6px 8px;color:#8b949e;font-weight:normal;border-bottom:1px solid #21262d">Provider</th>
        <th style="text-align:left;padding:6px 8px;color:#8b949e;font-weight:normal;border-bottom:1px solid #21262d">Env Var</th>
        <th style="text-align:left;padding:6px 8px;color:#8b949e;font-weight:normal;border-bottom:1px solid #21262d">Key</th>
        <th style="padding:6px 8px;border-bottom:1px solid #21262d"></th>
      </tr></thead>
      <tbody>
        ${list.map(k => `
          <tr>
            <td style="padding:6px 8px">
              <span style="font-weight:600;color:#e6edf3">${escHtml(k.label)}</span>
              ${!k.seeded ? '<span style="font-size:13px;color:#8b949e;margin-left:6px">(custom)</span>' : ''}
            </td>
            <td style="padding:6px 8px">
              <span style="color:#8b949e;font-size:14px">${escHtml(k.env_var || '—')}</span>
              ${k.env_set
                ? '<span class="badge-env-set">✓ set</span>'
                : '<span class="badge-env-not">not set</span>'}
            </td>
            <td style="padding:6px 8px;font-family:monospace" id="key-cell-${escHtml(k.name)}">
              <span style="color:#8b949e">${escHtml(k.masked)}</span>
            </td>
            <td style="padding:6px 8px;white-space:nowrap;text-align:right">
              <button class="btn-key-edit" data-name="${escHtml(k.name)}"
                style="font-size:13px;padding:2px 8px;border-radius:4px;border:1px solid #30363d;background:none;color:#e6edf3;cursor:pointer;margin-right:4px">Edit</button>
              ${k.has_db_key ? `<button class="btn-key-clear" data-name="${escHtml(k.name)}"
                style="font-size:13px;padding:2px 8px;border-radius:4px;border:1px solid #f8514966;background:none;color:#f85149;cursor:pointer;margin-right:4px">Clear</button>` : ''}
              ${!k.seeded ? `<button class="btn-key-delete" data-name="${escHtml(k.name)}"
                style="font-size:13px;padding:2px 8px;border-radius:4px;border:1px solid #f8514966;background:none;color:#f85149;cursor:pointer">Delete</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  container.querySelectorAll('.btn-key-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      const cell = document.getElementById(`key-cell-${name}`);
      cell.innerHTML = `
        <input type="password" id="key-edit-${escHtml(name)}" placeholder="New key value"
          style="background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:3px 6px;border-radius:4px;font-size:14px;width:180px;font-family:inherit">
        <button class="btn-key-save" data-name="${escHtml(name)}"
          style="font-size:13px;padding:2px 8px;border-radius:4px;border:none;background:#1f6feb;color:#fff;cursor:pointer;margin-left:4px">Save</button>
        <button class="btn-key-cancel"
          style="font-size:13px;padding:2px 8px;border-radius:4px;border:1px solid #30363d;background:none;color:#c9d1d9;cursor:pointer;margin-left:4px">✕</button>
      `;
      cell.querySelector('.btn-key-save').addEventListener('click', async () => {
        const val = document.getElementById(`key-edit-${name}`).value.trim();
        await fetch(`/api-keys/${encodeURIComponent(name)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key_value: val }),
        });
        renderKeysList();
      });
      cell.querySelector('.btn-key-cancel').addEventListener('click', () => renderKeysList());
    });
  });

  container.querySelectorAll('.btn-key-clear').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api-keys/${encodeURIComponent(btn.dataset.name)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key_value: '' }),
      });
      renderKeysList();
    });
  });

  container.querySelectorAll('.btn-key-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete provider "${btn.dataset.name}"?`)) return;
      await fetch(`/api-keys/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
      renderKeysList();
    });
  });
}

document.getElementById('btn-keys').addEventListener('click', () => {
  document.getElementById('keys-modal').classList.remove('hidden');
  renderKeysList();
});
document.getElementById('keys-modal-close').addEventListener('click', () =>
  document.getElementById('keys-modal').classList.add('hidden'));
document.getElementById('keys-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('keys-modal'))
    document.getElementById('keys-modal').classList.add('hidden');
});

document.getElementById('keys-add-btn').addEventListener('click', async () => {
  const name      = document.getElementById('keys-add-name').value.trim();
  const label     = document.getElementById('keys-add-label').value.trim();
  const env_var   = document.getElementById('keys-add-env').value.trim();
  const key_value = document.getElementById('keys-add-value').value.trim();
  if (!name || !label) return;
  const r = await fetch('/api-keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, label, env_var: env_var || null, key_value: key_value || null }),
  });
  if (r.ok) {
    ['keys-add-name','keys-add-label','keys-add-env','keys-add-value']
      .forEach(id => { document.getElementById(id).value = ''; });
    renderKeysList();
  } else {
    const err = await r.json().catch(() => ({}));
    alert(err.error || 'Failed to add provider');
  }
});
```

- [ ] **Step 5: Check syntax**

```bash
node --check dashboard/public/app.js
```

Expected: exits clean (no output).

- [ ] **Step 6: Manual verification**

Restart the server (`cd dashboard && node server.js`) and open http://localhost:3000.

1. Click `🔑 Keys` in the toolbar — modal opens showing 5 seeded providers
2. Anthropic row: masked key shows `—` (no DB key), env var badge shows `not set`
3. Click **Edit** on Anthropic — key cell becomes a password input + Save/Cancel
4. Type a fake key `sk-ant-test-1234567890abcd` and click **Save** — row updates, masked key shows `sk-a••••••••abcd`
5. Click **Clear** on Anthropic — masked key returns to `—`
6. In the Add Provider form: enter `moonshot-alt`, `Moonshot Alt`, `MOONSHOT_ALT_KEY`, and click **Add Provider** — new row appears with `(custom)` label
7. Click **Delete** on `moonshot-alt` — row disappears
8. Clicking outside the modal closes it

- [ ] **Step 7: Run full test suite**

```bash
cd dashboard && node --test 2>&1 | tail -6
```

Expected: all tests pass (151 total).

- [ ] **Step 8: Commit**

```bash
git add dashboard/public/index.html dashboard/public/style.css dashboard/public/app.js
git commit -m "feat(sp9a): add API keys modal UI with masked display, edit, clear, add, delete"
```

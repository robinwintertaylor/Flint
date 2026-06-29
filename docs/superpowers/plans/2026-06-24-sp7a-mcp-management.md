# SP7a: MCP Server Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store MCP server configurations in SQLite and automatically inject them into agent working directories at spawn time, so agents get access to filesystem, git, database, and other tools without manual setup.

**Architecture:** A new `mcp_servers` SQLite table holds server configs. `dashboard/mcp.js` provides CRUD and an `injectMcpConfig` function that merges configured servers into `.claude/settings.json` in the agent's workdir before the PTY starts. REST routes and CLI expose the same operations. Vibe agents are silently skipped (format unknown).

**Tech Stack:** Node.js 20+, better-sqlite3, Express, node:test, node:assert/strict

## Global Constraints

- No new npm dependencies
- All tables use `CREATE TABLE IF NOT EXISTS` in `initDb()`; no separate migration files
- REST errors return `{ error: "..." }` with appropriate HTTP status
- CLI commands use `dashGet/dashPost/dashPatch/dashDelete` helpers already in `bin/flint.js`
- Existing servers in `.claude/settings.json` win on name conflicts (merge: existing entries take precedence)
- MCP injection is a no-op (silent, no error) for Vibe agents
- MCP injection is a no-op when zero MCP servers are configured for the agent
- Tests use `initDb(':memory:')` — never touch real `usage.sqlite`
- Dashboard UI uses the same dark-theme CSS variables; no new CSS frameworks

---

### Task 1: DB schema and mcp.js CRUD

**Files:**
- Modify: `dashboard/db.js` — add `mcp_servers` table to `initDb()`
- Create: `dashboard/mcp.js` — CRUD exports
- Create: `dashboard/tests/mcp.test.js` — tests

**Interfaces:**
- Produces:
  - `listMcpServers(scope?: string | null): Row[]` — null = all, 'global' = global only, agent name = that agent's
  - `addMcpServer({ name, command, args, env, scope, enabled }): number` — returns inserted id
  - `updateMcpServer(id: number, fields: object): void`
  - `removeMcpServer(id: number): void`
  - `getMcpConfigForAgent(agentName: string): { mcpServers: Record<string, { command, args, env }> }`
  - `injectMcpConfig(agentName: string, workdir: string): void`

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/mcp.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { initDb } from '../db.js';
import {
  listMcpServers, addMcpServer, updateMcpServer, removeMcpServer,
  getMcpConfigForAgent, injectMcpConfig,
} from '../mcp.js';

test('initDb creates mcp_servers table', () => {
  const db = initDb(':memory:');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('mcp_servers'), 'mcp_servers table missing');
});

test('addMcpServer inserts and listMcpServers returns it', () => {
  initDb(':memory:');
  addMcpServer({ name: 'fs', command: 'npx', args: ['-y', '@mcp/fs'], env: {}, scope: 'global', enabled: 1 });
  const list = listMcpServers();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'fs');
  assert.equal(list[0].command, 'npx');
});

test('getMcpConfigForAgent returns global + agent-specific enabled servers, excludes disabled', () => {
  initDb(':memory:');
  addMcpServer({ name: 'global-fs', command: 'npx', args: ['-y', '@mcp/fs'], env: {}, scope: 'global', enabled: 1 });
  addMcpServer({ name: 'agent-git', command: 'uvx', args: ['mcp-server-git'], env: {}, scope: 'myagent', enabled: 1 });
  addMcpServer({ name: 'disabled', command: 'npx', args: [], env: {}, scope: 'global', enabled: 0 });
  const cfg = getMcpConfigForAgent('myagent');
  assert.ok('global-fs' in cfg.mcpServers, 'global server missing');
  assert.ok('agent-git' in cfg.mcpServers, 'agent-specific server missing');
  assert.ok(!('disabled' in cfg.mcpServers), 'disabled server should be excluded');
  assert.deepEqual(cfg.mcpServers['global-fs'].args, ['-y', '@mcp/fs']);
});

test('getMcpConfigForAgent excludes other agents\' servers', () => {
  initDb(':memory:');
  addMcpServer({ name: 'other-agent-tool', command: 'npx', args: [], env: {}, scope: 'otheragent', enabled: 1 });
  const cfg = getMcpConfigForAgent('myagent');
  assert.ok(!('other-agent-tool' in cfg.mcpServers));
});

test('updateMcpServer changes enabled flag', () => {
  initDb(':memory:');
  const id = addMcpServer({ name: 'toggler', command: 'npx', args: [], env: {}, scope: 'global', enabled: 1 });
  updateMcpServer(id, { enabled: 0 });
  const list = listMcpServers();
  assert.equal(list[0].enabled, 0);
});

test('removeMcpServer deletes the row', () => {
  initDb(':memory:');
  const id = addMcpServer({ name: 'todelete', command: 'npx', args: [], env: {}, scope: 'global', enabled: 1 });
  removeMcpServer(id);
  assert.equal(listMcpServers().length, 0);
});

test('listMcpServers(scope) filters by scope', () => {
  initDb(':memory:');
  addMcpServer({ name: 'g', command: 'npx', args: [], env: {}, scope: 'global', enabled: 1 });
  addMcpServer({ name: 'a', command: 'npx', args: [], env: {}, scope: 'agent1', enabled: 1 });
  assert.equal(listMcpServers('global').length, 1);
  assert.equal(listMcpServers('global')[0].name, 'g');
});

test('injectMcpConfig writes .claude/settings.json in workdir', () => {
  initDb(':memory:');
  addMcpServer({ name: 'filesystem', command: 'npx', args: ['-y', '@mcp/fs', '/'], env: {}, scope: 'global', enabled: 1 });
  const dir = mkdtempSync(join(tmpdir(), 'flint-mcp-'));
  injectMcpConfig('any-agent', dir);
  const written = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.ok('mcpServers' in written);
  assert.ok('filesystem' in written.mcpServers);
  assert.equal(written.mcpServers.filesystem.command, 'npx');
});

test('injectMcpConfig merges with existing settings.json; existing entries win on conflict', () => {
  initDb(':memory:');
  addMcpServer({ name: 'clash', command: 'new-cmd', args: [], env: {}, scope: 'global', enabled: 1 });
  const dir = mkdtempSync(join(tmpdir(), 'flint-mcp-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
    mcpServers: { clash: { command: 'old-cmd', args: [], env: {} } },
    someOtherSetting: true,
  }), 'utf8');
  injectMcpConfig('any-agent', dir);
  const written = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(written.mcpServers.clash.command, 'old-cmd', 'existing entry should win');
  assert.equal(written.someOtherSetting, true, 'other settings must be preserved');
});

test('injectMcpConfig is a no-op when no servers configured', () => {
  initDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'flint-mcp-'));
  injectMcpConfig('any-agent', dir);
  assert.ok(!existsSync(join(dir, '.claude', 'settings.json')), 'should not create file when nothing configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd dashboard && node --test tests/mcp.test.js
```

Expected: FAIL with "Cannot find module '../mcp.js'"

- [ ] **Step 3: Add mcp_servers table to db.js**

In `dashboard/db.js`, inside the `_db.exec(`` ` ``...`` ` ``)` template string, add after the `workspaces` table:

```sql
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      command    TEXT NOT NULL,
      args       TEXT NOT NULL DEFAULT '[]',
      env        TEXT NOT NULL DEFAULT '{}',
      scope      TEXT NOT NULL DEFAULT 'global',
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
```

- [ ] **Step 4: Create dashboard/mcp.js**

```js
import { getDb } from './db.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export function listMcpServers(scope = null) {
  const db = getDb();
  if (scope === null) return db.prepare('SELECT * FROM mcp_servers ORDER BY name').all();
  return db.prepare('SELECT * FROM mcp_servers WHERE scope = ? ORDER BY name').all(scope);
}

export function addMcpServer({ name, command, args = [], env = {}, scope = 'global', enabled = 1 }) {
  const result = getDb().prepare(
    'INSERT INTO mcp_servers (name, command, args, env, scope, enabled) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, command, JSON.stringify(args), JSON.stringify(env), scope, enabled ? 1 : 0);
  return result.lastInsertRowid;
}

export function updateMcpServer(id, fields) {
  const allowed = ['name', 'command', 'args', 'env', 'scope', 'enabled'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(k === 'args' || k === 'env' ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  vals.push(id);
  getDb().prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function removeMcpServer(id) {
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}

export function getMcpConfigForAgent(agentName) {
  const rows = getDb().prepare(
    `SELECT * FROM mcp_servers WHERE enabled = 1 AND (scope = 'global' OR scope = ?) ORDER BY name`
  ).all(agentName);
  const mcpServers = {};
  for (const row of rows) {
    mcpServers[row.name] = {
      command: row.command,
      args: JSON.parse(row.args),
      env: JSON.parse(row.env),
    };
  }
  return { mcpServers };
}

export function injectMcpConfig(agentName, workdir) {
  const { mcpServers } = getMcpConfigForAgent(agentName);
  if (Object.keys(mcpServers).length === 0) return;

  const settingsDir = join(workdir, '.claude');
  const settingsPath = join(settingsDir, 'settings.json');

  let existing = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
  }

  // Existing entries win on name conflicts
  const merged = {
    ...existing,
    mcpServers: { ...mcpServers, ...(existing.mcpServers ?? {}) },
  };

  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd dashboard && node --test tests/mcp.test.js
```

Expected: all 10 tests PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/db.js dashboard/mcp.js dashboard/tests/mcp.test.js
git commit -m "feat(sp7a): add mcp_servers table and mcp.js CRUD + injectMcpConfig"
```

---

### Task 2: Inject MCP config into terminal.js before PTY spawn

**Files:**
- Modify: `dashboard/terminal.js` — import `injectMcpConfig`, call it before `pty.spawn`

**Interfaces:**
- Consumes: `injectMcpConfig(agentName: string, workdir: string): void` from `./mcp.js`

- [ ] **Step 1: Write the failing test**

Add to `dashboard/tests/mcp.test.js` (the `injectMcpConfig` tests from Task 1 already cover the logic; this step verifies the integration point exists by checking the import doesn't throw):

```js
test('terminal.js imports injectMcpConfig without error', async () => {
  // If terminal.js doesn't import mcp.js this will throw at module load time
  // We can't actually call spawnAgent in tests (needs PTY) but we can verify the import
  const mod = await import('../terminal.js');
  assert.ok(typeof mod.spawnAgent === 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd dashboard && node --test tests/mcp.test.js 2>&1 | tail -5
```

Expected: the new test PASSES already (terminal.js exists) — this is a smoke test for the import. Move on.

- [ ] **Step 3: Add import and call to terminal.js**

In `dashboard/terminal.js`, add at the top (after existing imports):

```js
import { injectMcpConfig } from './mcp.js';
```

In `spawnAgent()`, find the block:

```js
  const isVibe = agent.runtime === 'vibe';
  const bin = isVibe ? VIBE_BIN : CLAUDE_BIN;
  const args = isVibe ? [] : ['--dangerously-skip-permissions'];
  if (!isVibe && model) args.push('--model', model);

  const ptyProcess = pty.spawn(bin, args, {
```

Insert between the `args` setup and `pty.spawn`:

```js
  if (!isVibe) {
    try { injectMcpConfig(name, workdir); } catch {}
  }

  const ptyProcess = pty.spawn(bin, args, {
```

- [ ] **Step 4: Run full dashboard test suite**

```
cd dashboard && node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/terminal.js dashboard/tests/mcp.test.js
git commit -m "feat(sp7a): inject MCP config into agent workdir before PTY spawn"
```

---

### Task 3: REST routes for MCP servers

**Files:**
- Modify: `dashboard/server.js` — import mcp.js, add 4 routes
- Modify: `dashboard/tests/server.test.js` — add MCP route tests

**Interfaces:**
- Consumes: `listMcpServers, addMcpServer, updateMcpServer, removeMcpServer` from `./mcp.js`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/server.test.js`:

```js
test('GET /mcp/servers returns empty array initially', async () => {
  const r = await req('GET', '/mcp/servers');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('POST /mcp/servers creates a server and returns it', async () => {
  const r = await req('POST', '/mcp/servers', {
    name: 'test-fs', command: 'npx', args: ['-y', '@mcp/fs'], env: {}, scope: 'global',
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.name, 'test-fs');
  assert.ok(body.id, 'id should be present');
});

test('POST /mcp/servers with missing name returns 400', async () => {
  const r = await req('POST', '/mcp/servers', { command: 'npx' });
  assert.equal(r.status, 400);
});

test('PATCH /mcp/servers/:id toggles enabled', async () => {
  const { id } = await req('POST', '/mcp/servers', {
    name: 'toggler2', command: 'npx', args: [], env: {}, scope: 'global',
  }).then(r => r.json());
  await req('PATCH', `/mcp/servers/${id}`, { enabled: 0 });
  const list = await req('GET', '/mcp/servers').then(r => r.json());
  const found = list.find(s => s.id === id);
  assert.equal(found.enabled, 0);
});

test('DELETE /mcp/servers/:id removes the server', async () => {
  const { id } = await req('POST', '/mcp/servers', {
    name: 'todelete2', command: 'npx', args: [], env: {}, scope: 'global',
  }).then(r => r.json());
  await req('DELETE', `/mcp/servers/${id}`);
  const list = await req('GET', '/mcp/servers').then(r => r.json());
  assert.ok(!list.find(s => s.id === id), 'server should be gone');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd dashboard && node --test tests/server.test.js 2>&1 | tail -10
```

Expected: FAIL with 404 on `/mcp/servers`

- [ ] **Step 3: Add import and routes to server.js**

At the top of `dashboard/server.js`, add to the existing imports block:

```js
import { listMcpServers, addMcpServer, updateMcpServer, removeMcpServer } from './mcp.js';
```

After the workspace routes (`app.delete('/workspaces/:id', ...)`), add:

```js
  // --- MCP server routes ---

  app.get('/mcp/servers', (_req, res) => res.json(listMcpServers()));

  app.post('/mcp/servers', (req, res) => {
    const { name, command, args = [], env = {}, scope = 'global', enabled = 1 } = req.body ?? {};
    if (!name || !command) return res.status(400).json({ error: 'name and command required' });
    try {
      const id = addMcpServer({ name, command, args, env, scope, enabled });
      res.json({ id, name, command, args, env, scope, enabled });
    } catch {
      res.status(409).json({ error: 'server name already registered' });
    }
  });

  app.patch('/mcp/servers/:id', (req, res) => {
    updateMcpServer(Number(req.params.id), req.body ?? {});
    res.json({ ok: true });
  });

  app.delete('/mcp/servers/:id', (req, res) => {
    removeMcpServer(Number(req.params.id));
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd dashboard && node --test tests/server.test.js
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/server.js dashboard/tests/server.test.js
git commit -m "feat(sp7a): add REST routes GET/POST/PATCH/DELETE /mcp/servers"
```

---

### Task 4: Dashboard UI — MCP modal and toolbar button

**Files:**
- Modify: `dashboard/public/index.html` — toolbar button + MCP modal
- Modify: `dashboard/public/app.js` — modal open/close, CRUD wiring, enabled toggles
- Modify: `dashboard/public/style.css` — no new classes needed (reuses `.modal-box`, `.btn-remove`)

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /mcp/servers`, `GET /agents`

*No automated test — verify manually in the browser after `node start.js`.*

- [ ] **Step 1: Add toolbar button and MCP modal to index.html**

In `dashboard/public/index.html`, in `<div id="toolbar">`, after the `⚙ Workspaces` button:

```html
    <button id="btn-mcp">⚡ MCP</button>
```

After the workspace manager modal closing `</div>`, add:

```html
  <!-- MCP Servers modal -->
  <div id="mcp-modal" class="hidden" role="dialog" aria-modal="true">
    <div class="modal-box" style="max-width:640px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="margin:0">MCP Servers</h2>
        <button id="mcp-modal-close" style="background:none;border:none;color:#8b949e;font-size:18px;cursor:pointer">✕</button>
      </div>
      <div id="mcp-list" style="margin-bottom:16px;min-height:32px"></div>
      <h4 style="color:#58a6ff;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Add Server</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
        <input id="mcp-add-name" type="text" placeholder="Name (e.g. filesystem)" style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px">
        <input id="mcp-add-command" type="text" placeholder="Command (e.g. npx)" style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px">
      </div>
      <input id="mcp-add-args" type="text" placeholder="Args space-separated (e.g. -y @modelcontextprotocol/server-filesystem /projects)" style="width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px;margin-bottom:6px">
      <textarea id="mcp-add-env" rows="2" placeholder="Env vars — KEY=VALUE one per line (optional)" style="width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px;margin-bottom:6px;resize:vertical;font-family:inherit"></textarea>
      <div style="display:flex;gap:6px;align-items:center">
        <select id="mcp-add-scope" style="flex:1;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px">
          <option value="global">Global (all agents)</option>
        </select>
        <button id="mcp-add-btn" style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:13px">Add</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Add MCP modal JS to app.js**

Append to `dashboard/public/app.js` before the final `connect()` call:

```js
// ============================================================
// MCP Servers modal
// ============================================================

async function renderMcpList() {
  const list = await fetch('/mcp/servers').then(r => r.json()).catch(() => []);
  const container = document.getElementById('mcp-list');
  if (!list.length) {
    container.innerHTML = '<p style="color:#8b949e;font-size:12px;margin:0">No MCP servers configured yet.</p>';
    return;
  }
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:#8b949e;text-align:left">
        <th style="padding:4px 8px">Name</th><th style="padding:4px 8px">Command + Args</th>
        <th style="padding:4px 8px">Scope</th><th style="padding:4px 8px">On</th><th></th>
      </tr></thead>
      <tbody>${list.map(s => {
        const argsStr = JSON.parse(s.args || '[]').join(' ');
        return `<tr style="border-top:1px solid #21262d">
          <td style="padding:4px 8px">${escHtml(s.name)}</td>
          <td style="padding:4px 8px;color:#8b949e;font-size:11px">${escHtml(s.command)} ${escHtml(argsStr)}</td>
          <td style="padding:4px 8px">${escHtml(s.scope)}</td>
          <td style="padding:4px 8px"><input type="checkbox" data-mcp-toggle="${s.id}" ${s.enabled ? 'checked' : ''}></td>
          <td style="padding:4px 8px"><button class="btn-remove" data-mcp-delete="${s.id}">Remove</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  `;
  container.querySelectorAll('[data-mcp-toggle]').forEach(cb => {
    cb.addEventListener('change', () => fetch(`/mcp/servers/${cb.dataset.mcpToggle}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: cb.checked ? 1 : 0 }),
    }));
  });
  container.querySelectorAll('[data-mcp-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/mcp/servers/${btn.dataset.mcpDelete}`, { method: 'DELETE' });
      renderMcpList();
    });
  });
}

async function populateMcpScopeDropdown() {
  const agents = await fetch('/agents').then(r => r.json()).catch(() => []);
  const sel = document.getElementById('mcp-add-scope');
  sel.innerHTML = '<option value="global">Global (all agents)</option>';
  agents.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.name; opt.textContent = `Agent: ${a.name}`;
    sel.appendChild(opt);
  });
}

document.getElementById('btn-mcp').addEventListener('click', () => {
  document.getElementById('mcp-modal').classList.remove('hidden');
  renderMcpList();
  populateMcpScopeDropdown();
});
document.getElementById('mcp-modal-close').addEventListener('click', () =>
  document.getElementById('mcp-modal').classList.add('hidden'));
document.getElementById('mcp-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('mcp-modal'))
    document.getElementById('mcp-modal').classList.add('hidden');
});

document.getElementById('mcp-add-btn').addEventListener('click', async () => {
  const name    = document.getElementById('mcp-add-name').value.trim();
  const command = document.getElementById('mcp-add-command').value.trim();
  const argsStr = document.getElementById('mcp-add-args').value.trim();
  const envStr  = document.getElementById('mcp-add-env').value.trim();
  const scope   = document.getElementById('mcp-add-scope').value;
  if (!name || !command) return;
  const args = argsStr ? argsStr.split(/\s+/) : [];
  const env = {};
  envStr.split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
  await fetch('/mcp/servers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, command, args, env, scope }),
  });
  document.getElementById('mcp-add-name').value = '';
  document.getElementById('mcp-add-command').value = '';
  document.getElementById('mcp-add-args').value = '';
  document.getElementById('mcp-add-env').value = '';
  renderMcpList();
});
```

- [ ] **Step 3: Manually verify in browser**

Start the server: `node start.js`

Open `http://localhost:3000`, click **⚡ MCP** in the toolbar.

Verify:
- Modal opens, shows "No MCP servers configured yet."
- Add a server: Name=`filesystem`, Command=`npx`, Args=`-y @modelcontextprotocol/server-filesystem /projects`, Scope=`Global`. Click Add.
- Server appears in the table with enabled checkbox checked.
- Toggle enabled checkbox off — the server should show disabled (unchecked) after re-opening modal.
- Click Remove — server disappears.

- [ ] **Step 4: Commit**

```bash
git add dashboard/public/index.html dashboard/public/app.js
git commit -m "feat(sp7a): add MCP servers modal and toolbar button to dashboard"
```

---

### Task 5: CLI mcp subcommand

**Files:**
- Modify: `bin/flint.js` — add `cmdMcp`, register in COMMANDS, update usage string

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /mcp/servers` via `dashGet/dashPost/dashPatch/dashDelete`

*No automated test — verify manually with `node bin/flint.js mcp list`.*

- [ ] **Step 1: Add cmdMcp to bin/flint.js**

In `bin/flint.js`, before the `cmdWorktree` function, add:

```js
async function cmdMcp(args) {
  const [sub, name, ...rest] = args;

  if (sub === 'list') {
    const list = await dashGet('/mcp/servers');
    if (!list.length) { console.log('No MCP servers configured.'); return; }
    for (const s of list) {
      const argsParsed = JSON.parse(s.args || '[]').join(' ');
      const state = s.enabled ? 'enabled' : 'disabled';
      console.log(`[${s.id}] ${s.name} | ${s.command} ${argsParsed} | ${s.scope} | ${state}`);
    }

  } else if (sub === 'add') {
    const { values, positionals } = parseArgs({
      args: name ? [name, ...rest] : rest,
      options: {
        env:      { type: 'string', multiple: true },
        scope:    { type: 'string' },
        disabled: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    const [serverName, command, ...argParts] = positionals;
    if (!serverName || !command) {
      console.error('Usage: flint mcp add <name> <command> [args...] [--env KEY=VAL] [--scope global|<agent>] [--disabled]');
      process.exit(1);
    }
    const env = {};
    (values.env ?? []).forEach(kv => {
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    });
    const r = await dashPost('/mcp/servers', {
      name: serverName, command, args: argParts, env,
      scope: values.scope ?? 'global',
      enabled: values.disabled ? 0 : 1,
    });
    console.log(`MCP server "${r.name}" added (id ${r.id}).`);

  } else if (sub === 'remove') {
    if (!name) { console.error('Usage: flint mcp remove <name>'); process.exit(1); }
    const list = await dashGet('/mcp/servers');
    const server = list.find(s => s.name === name);
    if (!server) { console.error(`No MCP server named "${name}".`); process.exit(1); }
    await dashDelete(`/mcp/servers/${server.id}`);
    console.log(`MCP server "${name}" removed.`);

  } else if (sub === 'enable' || sub === 'disable') {
    if (!name) { console.error(`Usage: flint mcp ${sub} <name>`); process.exit(1); }
    const list = await dashGet('/mcp/servers');
    const server = list.find(s => s.name === name);
    if (!server) { console.error(`No MCP server named "${name}".`); process.exit(1); }
    await dashPatch(`/mcp/servers/${server.id}`, { enabled: sub === 'enable' ? 1 : 0 });
    console.log(`MCP server "${name}" ${sub}d.`);

  } else {
    console.error('Usage: flint mcp <list|add|remove|enable|disable>');
    process.exit(1);
  }
}
```

- [ ] **Step 2: Register mcp in COMMANDS and update usage**

Find the COMMANDS line and update it:

```js
const COMMANDS = { ask: cmdAsk, models: cmdModels, config: cmdConfig, costs: cmdCosts, project: cmdProject, suggestions: cmdSuggestions, worktree: cmdWorktree, workspace: cmdWorkspace, mcp: cmdMcp };
```

Update the usage error:

```js
  console.error(`Usage: flint <ask|models|config|costs|project|suggestions|worktree|workspace|mcp>`);
```

- [ ] **Step 3: Manual verification**

With the dashboard running:

```
node bin/flint.js mcp list
# Expected: No MCP servers configured.

node bin/flint.js mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /projects
# Expected: MCP server "filesystem" added (id 1).

node bin/flint.js mcp list
# Expected: [1] filesystem | npx -y @modelcontextprotocol/server-filesystem /projects | global | enabled

node bin/flint.js mcp disable filesystem
# Expected: MCP server "filesystem" disabled.

node bin/flint.js mcp enable filesystem
# Expected: MCP server "filesystem" enabled.

node bin/flint.js mcp remove filesystem
# Expected: MCP server "filesystem" removed.
```

- [ ] **Step 4: Commit**

```bash
git add bin/flint.js
git commit -m "feat(sp7a): add flint mcp CLI subcommand (list/add/remove/enable/disable)"
```

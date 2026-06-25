# SP15a: Skill Library — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared skill library with SQLite storage, 6 REST routes, a GitHub import pipeline, and a dashboard UI (Skills view, card list, create/edit/import modals).

**Architecture:** New `dashboard/skills.js` CRUD module uses `getDb()` from `db.js`. Server imports it and registers 6 routes under `/api/skills` (import-github route registered first to avoid path collision with `/:id`). Frontend adds a `📚 Skills` toolbar button, `#skills-view` div, and two modals.

**Tech Stack:** Node.js ESM, better-sqlite3 (via existing `getDb()`), `fetch` (built-in), `node:test`, vanilla JS.

## Global Constraints

- No new npm dependencies — better-sqlite3 already installed.
- No changes to existing DB tables or routes.
- `POST /api/skills/import-github` MUST be registered before `GET /api/skills/:id` in Express (prevents string `import-github` being matched as an id param).
- `parseFrontmatter` is a module-level function in `server.js` — no separate file.
- `getApiKeyValue` is already imported in `server.js`; use it for GitHub auth.
- `TEST_MODE` in `server.js` is `const TEST_MODE = process.env.FLINT_TEST_MODE === '1'` (boolean, not function).
- All commits on `master`.
- Target: 185 existing tests + 14 new = 199 total (197 pass, 2 pre-existing Windows EPERM).
- `escHtml` is already defined in `app.js` — do not redefine it.

---

### Task 1: `skills.js` module + DB migration + module tests

**Files:**
- Modify: `dashboard/db.js` — add `skills` table to the `initDb()` exec block
- Create: `dashboard/skills.js` — 6 named exports
- Create: `dashboard/tests/skills.test.js` — 6 module-level tests (route tests added in Task 2)

**Interfaces:**
- Consumes: `getDb()` from `./db.js`
- Produces (consumed by Task 2):
  - `listSkills(): { id, name, description, source, tags, created_at }[]`
  - `getSkill(id: number): object | null`
  - `createSkill({ name, description, content, source?, tags? }): number`
  - `updateSkill(id: number, fields: object): void`
  - `deleteSkill(id: number): void`
  - `upsertSkill({ name, description, content, source, tags? }): { id: number, created: boolean }`

---

- [ ] **Step 1: Write the failing module tests**

Create `dashboard/tests/skills.test.js` with only the 6 module tests (route tests come in Task 2):

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-skills-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-skills-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-skills-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

import { createSkill, listSkills, getSkill, updateSkill, upsertSkill } from '../skills.js';
const { createApp, closeDb } = await import('../server.js');

let server, baseUrl;

before(() => new Promise((resolve) => {
  const app = createApp(); // calls initDb(TEMP_DB) — DB ready for module functions
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

// --- DB module tests ---

test('createSkill returns a positive integer id', () => {
  const id = createSkill({ name: 'skill-create-test', description: 'A test skill', content: '# Test\nContent here' });
  assert.ok(id > 0);
});

test('listSkills returns entries without content field', () => {
  createSkill({ name: 'skill-list-test', description: 'List test', content: 'content' });
  const skills = listSkills();
  const skill = skills.find(s => s.name === 'skill-list-test');
  assert.ok(skill, 'skill not found in list');
  assert.ok(!('content' in skill), 'listSkills should not return content field');
});

test('getSkill returns full skill including content', () => {
  const id = createSkill({ name: 'skill-get-test', description: 'Get test', content: 'full content here' });
  const skill = getSkill(id);
  assert.ok(skill !== null, 'getSkill returned null');
  assert.ok('content' in skill, 'getSkill should return content field');
  assert.equal(skill.content, 'full content here');
});

test('updateSkill changes the name field', () => {
  const id = createSkill({ name: 'skill-update-original', description: 'Update test', content: 'content' });
  updateSkill(id, { name: 'skill-update-renamed' });
  const updated = getSkill(id);
  assert.equal(updated.name, 'skill-update-renamed');
});

test('upsertSkill on new name returns { created: true }', () => {
  const result = upsertSkill({ name: 'skill-upsert-new', description: 'Upsert test', content: 'content', source: 'agent' });
  assert.equal(result.created, true);
  assert.ok(result.id > 0);
});

test('upsertSkill on existing name returns { created: false } and updates content', () => {
  upsertSkill({ name: 'skill-upsert-existing', description: 'First', content: 'first content', source: 'agent' });
  const result = upsertSkill({ name: 'skill-upsert-existing', description: 'Second', content: 'second content', source: 'agent' });
  assert.equal(result.created, false);
  const skill = getSkill(result.id);
  assert.equal(skill.content, 'second content');
});
```

- [ ] **Step 2: Run the tests — expect failure (skills.js not yet created)**

```
cd dashboard && node --test tests/skills.test.js 2>&1 | tail -5
```

Expected: error — `Cannot find module '../skills.js'`

- [ ] **Step 3: Add `skills` table to `db.js`**

In `dashboard/db.js`, locate the `_db.exec(`` ` `` ... `` ` ``)` block inside `initDb()`. After the closing `);` of the `telegram_chat_ids` table definition and before the backtick that closes the template literal, add:

```sql
    CREATE TABLE IF NOT EXISTS skills (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      description TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      source      TEXT    NOT NULL DEFAULT 'manual',
      tags        TEXT    NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
```

The closing of the telegram_chat_ids table currently looks like:
```sql
    CREATE TABLE IF NOT EXISTS telegram_chat_ids (
      chat_id  TEXT PRIMARY KEY,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
```

It should become:
```sql
    CREATE TABLE IF NOT EXISTS telegram_chat_ids (
      chat_id  TEXT PRIMARY KEY,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS skills (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      description TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      source      TEXT    NOT NULL DEFAULT 'manual',
      tags        TEXT    NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
```

- [ ] **Step 4: Create `dashboard/skills.js`**

```js
import { getDb } from './db.js';

export function listSkills() {
  return getDb().prepare(
    'SELECT id, name, description, source, tags, created_at FROM skills ORDER BY name'
  ).all();
}

export function getSkill(id) {
  return getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) ?? null;
}

export function createSkill({ name, description, content, source = 'manual', tags = '' }) {
  const r = getDb().prepare(
    'INSERT INTO skills (name, description, content, source, tags) VALUES (?, ?, ?, ?, ?)'
  ).run(name, description, content, source, tags);
  return r.lastInsertRowid;
}

export function updateSkill(id, fields) {
  const allowed = ['name', 'description', 'content', 'tags'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (key in fields) { sets.push(`${key} = ?`); vals.push(fields[key]); }
  }
  if (!sets.length) return;
  sets.push('updated_at = unixepoch()');
  vals.push(id);
  getDb().prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteSkill(id) {
  getDb().prepare('DELETE FROM skills WHERE id = ?').run(id);
}

export function upsertSkill({ name, description, content, source, tags = '' }) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM skills WHERE name = ?').get(name);
  if (existing) {
    db.prepare(
      'UPDATE skills SET description = ?, content = ?, source = ?, tags = ?, updated_at = unixepoch() WHERE id = ?'
    ).run(description, content, source, tags, existing.id);
    return { id: existing.id, created: false };
  }
  const r = db.prepare(
    'INSERT INTO skills (name, description, content, source, tags) VALUES (?, ?, ?, ?, ?)'
  ).run(name, description, content, source, tags);
  return { id: r.lastInsertRowid, created: true };
}
```

- [ ] **Step 5: Run the module tests — expect all 6 pass**

```
cd dashboard && node --test tests/skills.test.js 2>&1 | tail -8
```

Expected:
```
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

- [ ] **Step 6: Commit**

```
git add dashboard/db.js dashboard/skills.js dashboard/tests/skills.test.js
git commit -m "feat(sp15a): add skills table, skills.js CRUD module, and module tests"
```

---

### Task 2: Server routes + route tests + package.json

**Files:**
- Modify: `dashboard/server.js` — import skills.js, add `parseFrontmatter` helper, add 6 routes
- Modify: `dashboard/tests/skills.test.js` — append 8 route tests
- Modify: `dashboard/package.json` — append `tests/skills.test.js` to test script

**Interfaces:**
- Consumes (from Task 1):
  - `listSkills`, `getSkill`, `createSkill`, `updateSkill`, `deleteSkill`, `upsertSkill` from `./skills.js`
  - `getApiKeyValue` — already imported in server.js
  - `TEST_MODE` — already defined as boolean in server.js
- Produces: `GET /api/skills`, `POST /api/skills`, `POST /api/skills/import-github`, `GET /api/skills/:id`, `PATCH /api/skills/:id`, `DELETE /api/skills/:id`

---

- [ ] **Step 1: Append 8 route tests to `dashboard/tests/skills.test.js`**

Append these tests after the 6 existing module tests at the bottom of the file:

```js
// --- Route tests ---

test('GET /api/skills returns array', async () => {
  const r = await req('GET', '/api/skills');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body));
});

test('POST /api/skills with valid body returns 201 and { id }', async () => {
  const r = await req('POST', '/api/skills', {
    name: 'route-create-test',
    description: 'Route create test',
    content: '# Route test\nContent',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok('id' in body);
  assert.ok(body.id > 0);
});

test('POST /api/skills missing required field returns 400', async () => {
  const r = await req('POST', '/api/skills', { name: 'missing-fields-test' });
  assert.equal(r.status, 400);
});

test('GET /api/skills/:id returns skill with content field', async () => {
  const create = await req('POST', '/api/skills', {
    name: 'route-get-test',
    description: 'Get route test',
    content: 'route get content',
  });
  const { id } = await create.json();
  const r = await req('GET', `/api/skills/${id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('content' in body);
  assert.equal(body.content, 'route get content');
});

test('GET /api/skills/:id with unknown id returns 404', async () => {
  const r = await req('GET', '/api/skills/999999');
  assert.equal(r.status, 404);
});

test('PATCH /api/skills/:id updates name and returns updated skill', async () => {
  const create = await req('POST', '/api/skills', {
    name: 'route-patch-test',
    description: 'Patch test',
    content: 'content',
  });
  const { id } = await create.json();
  const r = await req('PATCH', `/api/skills/${id}`, { name: 'updated-name' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.name, 'updated-name');
});

test('DELETE /api/skills/:id returns 204', async () => {
  const create = await req('POST', '/api/skills', {
    name: 'route-delete-test',
    description: 'Delete test',
    content: 'content',
  });
  const { id } = await create.json();
  const r = await req('DELETE', `/api/skills/${id}`);
  assert.equal(r.status, 204);
});

test('POST /api/skills/import-github returns { imported, updated, skipped } in TEST_MODE', async () => {
  const r = await req('POST', '/api/skills/import-github', { url: 'https://github.com/test/repo' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('imported' in body);
  assert.ok('updated' in body);
  assert.ok('skipped' in body);
});
```

- [ ] **Step 2: Run route tests — expect 8 failures (routes not yet added)**

```
cd dashboard && node --test tests/skills.test.js 2>&1 | tail -8
```

Expected:
```
ℹ tests 14
ℹ pass 6
ℹ fail 8
```

(All 6 module tests still pass; 8 route tests fail with 404.)

- [ ] **Step 3: Add `skills.js` import to `dashboard/server.js`**

In `dashboard/server.js`, after line 24 (the lmstudio import):

```js
import { isLmStudioReachable, listModels as listLmStudioModels, generate as lmStudioGenerate } from './lmstudio.js';
import { listSkills, getSkill, createSkill, updateSkill, deleteSkill, upsertSkill } from './skills.js';
```

- [ ] **Step 4: Add `parseFrontmatter` helper to `dashboard/server.js`**

In `dashboard/server.js`, after the `const TEST_MODE = ...` line (line 29) and before the `export { closeDb }` line (line 31), add:

```js
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (!meta.name || !meta.description) return null;
  return { name: meta.name, description: meta.description, tags: meta.tags ?? '', body: m[2].trim() };
}
```

- [ ] **Step 5: Add skills routes to `dashboard/server.js`**

Locate the `// --- Docker routes ---` block and find its closing `});`. Immediately after that closing `});` (and before `// --- Project routes ---`), add:

```js
  // --- Skills routes ---

  app.get('/api/skills', (_req, res) => {
    res.json(listSkills());
  });

  // import-github MUST be registered before /:id to avoid path collision
  app.post('/api/skills/import-github', async (req, res) => {
    const { url } = req.body ?? {};
    if (!url) return res.status(400).json({ error: 'url required' });
    if (TEST_MODE) return res.json({ imported: 1, updated: 0, skipped: 0 });
    try {
      const ghMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/([^/]+)(?:\/(.*))?)?(?:\.git)?(?:\/)?$/);
      if (!ghMatch) return res.status(400).json({ error: 'invalid GitHub URL' });
      const [, owner, repo, urlBranch, urlPrefix] = ghMatch;

      const ghToken = getApiKeyValue('github');
      const ghHeaders = ghToken
        ? { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json' }
        : { Accept: 'application/vnd.github+json' };

      let branch = urlBranch;
      if (!branch) {
        const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders });
        if (!repoRes.ok) return res.status(400).json({ error: `GitHub API error: ${repoRes.status}` });
        branch = (await repoRes.json()).default_branch;
      }

      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        { headers: ghHeaders }
      );
      if (!treeRes.ok) return res.status(400).json({ error: `GitHub tree API error: ${treeRes.status}` });
      const treeData = await treeRes.json();

      const candidates = (treeData.tree ?? []).filter(item => {
        if (item.type !== 'blob' || !item.path.endsWith('.md')) return false;
        if (urlPrefix && !item.path.startsWith(urlPrefix)) return false;
        const parts = item.path.split('/');
        const filename = parts[parts.length - 1].toLowerCase();
        const inSkillsDir = parts.some((p, i) => i < parts.length - 1 && p.toLowerCase() === 'skills');
        return filename === 'skill.md' || inSkillsDir;
      });

      let imported = 0, updated = 0, skipped = 0;
      for (const item of candidates) {
        const contentRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}?ref=${branch}`,
          { headers: ghHeaders }
        );
        if (!contentRes.ok) { skipped++; continue; }
        const raw = Buffer.from((await contentRes.json()).content, 'base64').toString('utf8');
        const parsed = parseFrontmatter(raw);
        if (!parsed) { skipped++; continue; }
        const result = upsertSkill({ name: parsed.name, description: parsed.description, content: parsed.body, source: `github:${url}`, tags: parsed.tags });
        if (result.created) imported++; else updated++;
      }
      res.json({ imported, updated, skipped });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/skills', (req, res) => {
    const { name, description, content, source, tags } = req.body ?? {};
    if (!name || !description || !content) return res.status(400).json({ error: 'name, description, and content required' });
    try {
      const id = createSkill({ name, description, content, source: source ?? 'manual', tags: tags ?? '' });
      res.status(201).json({ id });
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'skill name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/skills/:id', (req, res) => {
    const skill = getSkill(Number(req.params.id));
    if (!skill) return res.status(404).json({ error: 'skill not found' });
    res.json(skill);
  });

  app.patch('/api/skills/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getSkill(id)) return res.status(404).json({ error: 'skill not found' });
    const body = req.body ?? {};
    const fields = {};
    for (const k of ['name', 'description', 'content', 'tags']) {
      if (k in body) fields[k] = body[k];
    }
    updateSkill(id, fields);
    res.json(getSkill(id));
  });

  app.delete('/api/skills/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getSkill(id)) return res.status(404).json({ error: 'skill not found' });
    deleteSkill(id);
    res.status(204).end();
  });
```

- [ ] **Step 6: Update `dashboard/package.json` test script**

Replace the existing `"test"` script value to append `tests/skills.test.js`:

```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js tests/telegram.test.js tests/github.test.js tests/ollama.test.js tests/lmstudio.test.js tests/docker.test.js tests/skills.test.js"
```

- [ ] **Step 7: Run the full skills test file — expect all 14 pass**

```
cd dashboard && node --test tests/skills.test.js 2>&1 | tail -8
```

Expected:
```
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

- [ ] **Step 8: Run the full test suite — expect 199 total, 197 pass**

```
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 199
ℹ pass 197
ℹ fail 2
```

(Only the 2 pre-existing Windows EPERM failures in sp5/sp6.)

- [ ] **Step 9: Commit**

```
git add dashboard/server.js dashboard/tests/skills.test.js dashboard/package.json
git commit -m "feat(sp15a): add skills API routes and route tests"
```

---

### Task 3: Frontend UI (HTML + CSS + app.js)

**Files:**
- Modify: `dashboard/public/index.html` — toolbar button, `#skills-view`, two modals
- Modify: `dashboard/public/style.css` — skill card styles
- Modify: `dashboard/public/app.js` — skills view logic, modals, event listeners

**Interfaces:**
- Consumes (from Task 2): `GET /api/skills`, `POST /api/skills`, `PATCH /api/skills/:id`, `DELETE /api/skills/:id`, `GET /api/skills/:id`, `POST /api/skills/import-github`
- Produces: nothing consumed by other tasks.

No new automated tests — frontend changes are verified by running the dashboard.

---

- [ ] **Step 1: Add toolbar button to `dashboard/public/index.html`**

Locate the `#toolbar` div. After `<button id="btn-keys">🔑 Keys</button>` and before `<button id="btn-queue">⬡ Queue</button>`, insert:

```html
    <button id="btn-skills">📚 Skills</button>
```

The toolbar block should read:

```html
  <div id="toolbar">
    <button id="btn-new-agent">+ New Agent</button>
    <button id="btn-refresh">↻ Refresh</button>
    <button id="btn-workspaces">⚙ Workspaces</button>
    <button id="btn-mcp">⚡ MCP</button>
    <button id="btn-keys">🔑 Keys</button>
    <button id="btn-skills">📚 Skills</button>
    <button id="btn-queue">⬡ Queue</button>
    <button id="btn-orchestrate">⬡ Orchestrate</button>
  </div>
```

- [ ] **Step 2: Add `#skills-view` div to `dashboard/public/index.html`**

After `<div id="queue-view" class="hidden"></div>` and before `<div id="proj-toolbar" ...>`, insert:

```html
  <div id="skills-view" class="hidden" style="padding:16px;max-width:900px;margin:0 auto"></div>
```

- [ ] **Step 3: Add skill modals to `dashboard/public/index.html`**

After the `<!-- Orchestrate modal -->` block's closing `</div>`, insert:

```html
  <!-- Skill create/edit modal -->
  <div id="skill-modal" class="hidden" role="dialog" aria-modal="true">
    <div class="modal-box" style="max-width:620px">
      <h2 id="skill-modal-title">New Skill</h2>
      <label>Name<input id="skill-modal-name" type="text" placeholder="git-pr-workflow" autocomplete="off"></label>
      <label>Description<input id="skill-modal-desc" type="text" placeholder="How to create and manage pull requests" autocomplete="off"></label>
      <label>Tags (comma-separated, optional)<input id="skill-modal-tags" type="text" placeholder="git,pr,workflow" autocomplete="off"></label>
      <label>Content<textarea id="skill-modal-content" rows="10" placeholder="# Skill Name&#10;&#10;Describe the procedure here…" style="width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:8px;font-family:monospace;font-size:13px;resize:vertical"></textarea></label>
      <div class="modal-actions">
        <button id="skill-modal-cancel">Cancel</button>
        <button id="skill-modal-save" style="background:#1f6feb;color:#fff;border:none">Save</button>
      </div>
    </div>
  </div>

  <!-- Skill GitHub import modal -->
  <div id="skill-import-modal" class="hidden" role="dialog" aria-modal="true">
    <div class="modal-box" style="max-width:500px">
      <h2>Import Skills from GitHub</h2>
      <label>GitHub Repository URL<input id="skill-import-url" type="text" placeholder="https://github.com/owner/repo" autocomplete="off"></label>
      <p style="color:#8b949e;font-size:13px;margin:4px 0 12px">Looks for skill.md files or files in skills/ directories. Requires YAML frontmatter with name and description fields.</p>
      <div id="skill-import-result" style="font-size:14px;min-height:20px"></div>
      <div class="modal-actions">
        <button id="skill-import-cancel">Cancel</button>
        <button id="skill-import-btn" style="background:#1f6feb;color:#fff;border:none">Import</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 4: Add skill card CSS to `dashboard/public/style.css`**

Append to the end of `style.css`:

```css
/* Skill cards */
.skill-card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 12px 14px;
}
.skill-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  user-select: none;
}
.skill-name {
  font-weight: 600;
  color: #e6edf3;
  flex: 1;
}
.skill-badge {
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #8b949e;
  font-size: 12px;
  padding: 2px 6px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.skill-tag {
  background: #1f6feb22;
  border: 1px solid #1f6feb55;
  border-radius: 12px;
  color: #58a6ff;
  font-size: 12px;
  padding: 1px 8px;
}
.skill-content {
  margin-top: 10px;
  background: #0d1117;
  border-radius: 4px;
  padding: 10px;
  font-family: monospace;
  font-size: 13px;
  color: #c9d1d9;
  max-height: 400px;
  overflow-y: auto;
}
.skill-actions { display: flex; gap: 4px; }
```

- [ ] **Step 5: Update `showView` in `dashboard/public/app.js` to handle `skills`**

Locate the `showView` function (starts around line 427). Replace the entire function with:

```js
function showView(view) {
  currentView = view;
  const panels     = document.getElementById('panels');
  const toolbar    = document.getElementById('toolbar');
  const projView   = document.getElementById('project-view');
  const projBar    = document.getElementById('proj-toolbar');
  const queueView  = document.getElementById('queue-view');
  const skillsView = document.getElementById('skills-view');
  if (view === 'projects') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.remove('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'flex';
    fetchProjects();
  } else if (view === 'queue') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.add('hidden');
    queueView.classList.remove('hidden');
    skillsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
    fetchAndRenderQueue();
  } else if (view === 'skills') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.add('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.remove('hidden');
    if (projBar) projBar.style.display = 'none';
    fetchAndRenderSkills();
  } else {
    panels.style.display = '';
    toolbar.style.display = '';
    projView.classList.add('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
  }
}
```

- [ ] **Step 6: Add skills section to `dashboard/public/app.js`**

After the `// Task Queue tab` section (after the `fetchAndRenderQueue` and `relativeTime` functions, before the `renderQueueView` function or wherever there's a clear section break), add the following complete skills section. Find the line `document.getElementById('btn-queue').addEventListener('click', () => showView('queue'));` and add this block after it:

```js
// ============================================================
// Skills Library tab
// ============================================================

document.getElementById('btn-skills').addEventListener('click', () => showView('skills'));

async function fetchAndRenderSkills() {
  const skills = await fetch('/api/skills').then(r => r.json()).catch(() => []);
  renderSkillsView(skills);
}

function renderSkillsView(skills) {
  const view = document.getElementById('skills-view');
  view.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <h2 style="margin:0;flex:1">Skills Library</h2>
      <button id="btn-skill-new" style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:15px">+ New Skill</button>
      <button id="btn-skill-import" style="background:none;border:1px solid #30363d;color:#e6edf3;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:15px">⬇ Import from GitHub</button>
      <button id="btn-skills-back" style="background:none;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:14px">← Dashboard</button>
    </div>
    <div id="skills-list" style="display:flex;flex-direction:column;gap:8px"></div>
  `;

  document.getElementById('btn-skills-back').addEventListener('click', () => showView('agents'));
  document.getElementById('btn-skill-new').addEventListener('click', openNewSkillModal);
  document.getElementById('btn-skill-import').addEventListener('click', openImportGitHubModal);

  const list = document.getElementById('skills-list');
  if (!skills.length) {
    list.innerHTML = '<p style="color:#8b949e">No skills yet. Add one manually or import from GitHub.</p>';
    return;
  }

  for (const skill of skills) {
    const card = document.createElement('div');
    card.className = 'skill-card';
    const tagsHtml = skill.tags
      ? skill.tags.split(',').filter(Boolean).map(t => `<span class="skill-tag">${escHtml(t.trim())}</span>`).join('')
      : '';
    card.innerHTML = `
      <div class="skill-card-header" data-id="${skill.id}" style="cursor:pointer">
        <span class="skill-name">${escHtml(skill.name)}</span>
        <span class="skill-badge" title="${escHtml(skill.source)}">${escHtml(skill.source)}</span>
        <div class="skill-actions">
          <button class="btn-skill-edit" data-id="${skill.id}" style="background:none;border:none;color:#58a6ff;cursor:pointer;font-size:14px;padding:2px 6px">Edit</button>
          <button class="btn-skill-delete" data-id="${skill.id}" style="background:none;border:none;color:#f85149;cursor:pointer;font-size:14px;padding:2px 6px">Delete</button>
        </div>
      </div>
      <div style="color:#8b949e;font-size:14px;margin:4px 0">${escHtml(skill.description)}</div>
      ${tagsHtml ? `<div class="skill-tags">${tagsHtml}</div>` : ''}
      <div id="skill-content-${skill.id}" class="skill-content hidden"></div>
    `;
    list.appendChild(card);
  }

  list.querySelectorAll('.skill-card-header').forEach(header => {
    header.addEventListener('click', async (e) => {
      if (e.target.classList.contains('btn-skill-edit') || e.target.classList.contains('btn-skill-delete')) return;
      const id = header.dataset.id;
      const contentEl = document.getElementById(`skill-content-${id}`);
      if (!contentEl.classList.contains('hidden')) {
        contentEl.classList.add('hidden');
        return;
      }
      if (!contentEl.dataset.loaded) {
        const full = await fetch(`/api/skills/${id}`).then(r => r.json());
        contentEl.innerHTML = `<pre style="margin:0;white-space:pre-wrap;word-break:break-word">${escHtml(full.content)}</pre>`;
        contentEl.dataset.loaded = '1';
      }
      contentEl.classList.remove('hidden');
    });
  });

  list.querySelectorAll('.btn-skill-edit').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const full = await fetch(`/api/skills/${btn.dataset.id}`).then(r => r.json());
      openEditSkillModal(full);
    });
  });

  list.querySelectorAll('.btn-skill-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const skillName = btn.closest('.skill-card').querySelector('.skill-name').textContent;
      if (!confirm(`Delete skill "${skillName}"?`)) return;
      await fetch(`/api/skills/${btn.dataset.id}`, { method: 'DELETE' });
      fetchAndRenderSkills();
    });
  });
}

// --- New Skill / Edit Skill Modal ---

let _editingSkillId = null;

function openNewSkillModal() {
  _editingSkillId = null;
  document.getElementById('skill-modal-title').textContent = 'New Skill';
  ['skill-modal-name', 'skill-modal-desc', 'skill-modal-tags', 'skill-modal-content']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('skill-modal').classList.remove('hidden');
}

function openEditSkillModal(skill) {
  _editingSkillId = skill.id;
  document.getElementById('skill-modal-title').textContent = 'Edit Skill';
  document.getElementById('skill-modal-name').value    = skill.name;
  document.getElementById('skill-modal-desc').value    = skill.description;
  document.getElementById('skill-modal-tags').value    = skill.tags;
  document.getElementById('skill-modal-content').value = skill.content;
  document.getElementById('skill-modal').classList.remove('hidden');
}

document.getElementById('skill-modal-cancel').addEventListener('click', () =>
  document.getElementById('skill-modal').classList.add('hidden'));

document.getElementById('skill-modal-save').addEventListener('click', async () => {
  const name        = document.getElementById('skill-modal-name').value.trim();
  const description = document.getElementById('skill-modal-desc').value.trim();
  const tags        = document.getElementById('skill-modal-tags').value.trim();
  const content     = document.getElementById('skill-modal-content').value.trim();
  if (!name || !description || !content) return;

  if (_editingSkillId) {
    await fetch(`/api/skills/${_editingSkillId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, tags, content }),
    });
  } else {
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, tags, content }),
    });
  }
  document.getElementById('skill-modal').classList.add('hidden');
  fetchAndRenderSkills();
});

// --- Import from GitHub Modal ---

function openImportGitHubModal() {
  document.getElementById('skill-import-url').value     = '';
  document.getElementById('skill-import-result').textContent = '';
  document.getElementById('skill-import-result').style.color = '';
  document.getElementById('skill-import-modal').classList.remove('hidden');
}

document.getElementById('skill-import-cancel').addEventListener('click', () =>
  document.getElementById('skill-import-modal').classList.add('hidden'));

document.getElementById('skill-import-btn').addEventListener('click', async () => {
  const url = document.getElementById('skill-import-url').value.trim();
  if (!url) return;
  const resultEl = document.getElementById('skill-import-result');
  resultEl.textContent = 'Importing…';
  resultEl.style.color = '#8b949e';
  try {
    const r = await fetch('/api/skills/import-github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) {
      resultEl.style.color = '#f85149';
      resultEl.textContent = data.error || 'Import failed';
    } else {
      resultEl.style.color = '#3fb950';
      resultEl.textContent = `Imported ${data.imported}, updated ${data.updated}, skipped ${data.skipped}`;
      if (data.imported + data.updated > 0) fetchAndRenderSkills();
    }
  } catch {
    resultEl.style.color = '#f85149';
    resultEl.textContent = 'Network error';
  }
});
```

- [ ] **Step 7: Run the full test suite — expect counts unchanged**

```
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 199
ℹ pass 197
ℹ fail 2
```

(Task 3 adds no new server tests — counts are unchanged from Task 2.)

- [ ] **Step 8: Commit**

```
git add dashboard/public/index.html dashboard/public/style.css dashboard/public/app.js
git commit -m "feat(sp15a): add Skills Library UI — toolbar button, skills view, create/edit/import modals"
```

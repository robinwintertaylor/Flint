# SP16a: Project Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users and agents to attach reference documents (PRDs, BRDs, design docs) to projects, with PDF text extraction at upload time and automatic injection into orchestrator context.

**Architecture:** New `project_docs` SQLite table stores extracted text. A five-export module mirrors the patterns in `skills.js`. Four REST routes handle CRUD. The orchestrator injects project docs into the task file when a `projectId` is set. Frontend adds a "📄 Docs" button to each project card that opens a modal with file upload.

**Tech Stack:** Node.js ESM, better-sqlite3, Express, pdf-parse (new), FileReader API (frontend).

## Global Constraints

- No new npm dependencies except `pdf-parse`. Install with `npm install pdf-parse`.
- All new routes go under `/api/projects/:id/docs`. Do NOT use `/projects/:id/docs` (that prefix is for legacy non-API project routes).
- `TEST_MODE` check: `const TEST_MODE = process.env.FLINT_TEST_MODE === '1'` is already declared at module scope in `server.js` — do not redeclare it.
- Existing test count: 200 tests, 198 pass (2 pre-existing Windows EPERM failures in sp5/sp6 rmSync). After this plan: 212 total, 210 pass.
- All new module exports follow the `skills.js` pattern: import `getDb()`, no `initDb()`, pure named exports.
- Test file: `dashboard/tests/project_docs.test.js`. Uses `node:test` + `node:assert/strict`. Same boilerplate as `skills.test.js`.
- Run tests from the `dashboard/` directory: `node --test tests/project_docs.test.js`

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Modify | `dashboard/db.js` | Add `project_docs` table after `skills` table |
| Create | `dashboard/project_docs.js` | 5-export CRUD module |
| Create | `dashboard/tests/project_docs.test.js` | 12 tests (5 module + 7 route) — built across Task 1 and Task 2 |
| Modify | `dashboard/server.js` | Import `pdfParse` + 5 new exports from `project_docs.js`; add 4 routes |
| Modify | `dashboard/package.json` | Add `pdf-parse` dependency; append test file to test script |
| Modify | `dashboard/orchestrator.js` | Import `listDocsWithContent`; inject docs into task file |
| Modify | `dashboard/public/index.html` | Add `#proj-docs-modal` after `#skill-import-modal` |
| Modify | `dashboard/public/app.js` | Add Docs button to project cards; add modal open/upload/delete logic |

---

### Task 1: DB Table + Module + Module Tests

**Files:**
- Modify: `dashboard/db.js` (lines ~109–110 — after `skills` table closing `);`)
- Create: `dashboard/project_docs.js`
- Create: `dashboard/tests/project_docs.test.js` (5 module tests — route tests added in Task 2)

**Interfaces:**
- Produces:
  - `listDocs(projectId: number): { id, title, mime_type, source, created_at }[]`
  - `getDoc(id: number): { id, project_id, title, mime_type, content, source, created_at } | null`
  - `createDoc({ projectId, title, mimeType?, content, source? }): number`
  - `deleteDoc(id: number): void`
  - `listDocsWithContent(projectId: number): { id, title, content }[]`

- [ ] **Step 1: Write the 5 failing module tests**

Create `dashboard/tests/project_docs.test.js` with this exact content (just the module tests — route tests come in Task 2):

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_DB     = join(tmpdir(), `flint-pdocs-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-pdocs-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-pdocs-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH     = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR   = TEMP_TASKS;
process.env.FLINT_TEST_MODE   = '1';

import { listDocs, getDoc, createDoc, deleteDoc, listDocsWithContent } from '../project_docs.js';
const { createApp, closeDb } = await import('../server.js');

let server, baseUrl;

before(() => new Promise((resolve) => {
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

// --- DB module tests ---

test('createDoc returns a positive integer id', () => {
  const id = createDoc({ projectId: 1, title: 'PRD', content: 'product requirements here' });
  assert.ok(id > 0);
});

test('listDocs returns docs without content field', () => {
  createDoc({ projectId: 1, title: 'BRD', content: 'business requirements' });
  const docs = listDocs(1);
  assert.ok(docs.length > 0);
  const doc = docs[0];
  assert.ok(!('content' in doc), 'listDocs should not include content');
});

test('getDoc returns full doc with content', () => {
  const id = createDoc({ projectId: 1, title: 'Design Doc', content: 'design content here' });
  const doc = getDoc(id);
  assert.ok(doc !== null, 'getDoc returned null');
  assert.ok('content' in doc, 'getDoc should include content');
  assert.equal(doc.content, 'design content here');
});

test('deleteDoc removes doc — getDoc returns null afterwards', () => {
  const id = createDoc({ projectId: 1, title: 'temp', content: 'x' });
  deleteDoc(id);
  assert.equal(getDoc(id), null);
});

test('listDocsWithContent returns docs including content field', () => {
  createDoc({ projectId: 1, title: 'Full Doc', content: 'full content here' });
  const docs = listDocsWithContent(1);
  assert.ok(docs.length > 0);
  assert.ok('content' in docs[0], 'listDocsWithContent should include content');
});
```

- [ ] **Step 2: Run to confirm all 5 fail (project_docs.js not yet created)**

```
cd dashboard
node --test tests/project_docs.test.js
```

Expected: 5 failures — "Cannot find module '../project_docs.js'" or similar.

- [ ] **Step 3: Add `project_docs` table to `dashboard/db.js`**

In `dashboard/db.js`, find the `skills` table definition (around line 100–109). After its closing `);` and before the closing backtick of the `_db.exec(...)` template literal, insert the `project_docs` table:

```js
// BEFORE (lines 107-110):
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

// AFTER:
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS project_docs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL,
      title       TEXT    NOT NULL,
      mime_type   TEXT    NOT NULL DEFAULT 'text/plain',
      content     TEXT    NOT NULL,
      source      TEXT    NOT NULL DEFAULT 'upload',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
```

- [ ] **Step 4: Create `dashboard/project_docs.js`**

```js
import { getDb } from './db.js';

export function listDocs(projectId) {
  return getDb().prepare(
    'SELECT id, title, mime_type, source, created_at FROM project_docs WHERE project_id = ? ORDER BY created_at DESC'
  ).all(projectId);
}

export function getDoc(id) {
  return getDb().prepare('SELECT * FROM project_docs WHERE id = ?').get(id) ?? null;
}

export function createDoc({ projectId, title, mimeType = 'text/plain', content, source = 'upload' }) {
  const r = getDb().prepare(
    'INSERT INTO project_docs (project_id, title, mime_type, content, source) VALUES (?, ?, ?, ?, ?)'
  ).run(projectId, title, mimeType, content, source);
  return r.lastInsertRowid;
}

export function deleteDoc(id) {
  getDb().prepare('DELETE FROM project_docs WHERE id = ?').run(id);
}

export function listDocsWithContent(projectId) {
  return getDb().prepare(
    'SELECT id, title, content FROM project_docs WHERE project_id = ? ORDER BY created_at DESC'
  ).all(projectId);
}
```

- [ ] **Step 5: Run module tests — expect all 5 to pass**

```
cd dashboard
node --test tests/project_docs.test.js
```

Expected output: `✓ createDoc returns a positive integer id`, `✓ listDocs returns docs without content field`, `✓ getDoc returns full doc with content`, `✓ deleteDoc removes doc — getDoc returns null afterwards`, `✓ listDocsWithContent returns docs including content field` — 5 pass, 0 fail.

- [ ] **Step 6: Commit**

```
cd dashboard
git add db.js project_docs.js tests/project_docs.test.js
git commit -m "feat(sp16a): add project_docs table, module, and module tests"
```

---

### Task 2: Server Routes + pdf-parse + Route Tests

**Files:**
- Modify: `dashboard/server.js` (import `pdfParse` + new exports; add 4 routes after `/projects/:id/agents/:agentName DELETE`)
- Modify: `dashboard/tests/project_docs.test.js` (append 7 route tests)
- Modify: `dashboard/package.json` (add `pdf-parse` dep; append test file to test script)

**Interfaces:**
- Consumes (from Task 1): `listDocs`, `getDoc`, `createDoc`, `deleteDoc` from `./project_docs.js`
- Produces (new API routes):
  - `GET /api/projects/:id/docs` → 200 array of `{ id, title, mime_type, source, created_at }`
  - `POST /api/projects/:id/docs` → 201 `{ id }` | 400 `{ error }` | 422 `{ error }`
  - `GET /api/projects/:id/docs/:docId` → 200 full doc | 404
  - `DELETE /api/projects/:id/docs/:docId` → 204 | 404

- [ ] **Step 1: Install pdf-parse**

```
cd dashboard
npm install pdf-parse
```

Expected: `package.json` updated with `"pdf-parse": "^1.1.1"` (or newer), `node_modules/pdf-parse/` populated.

- [ ] **Step 2: Write 7 failing route tests**

Append these tests to the BOTTOM of `dashboard/tests/project_docs.test.js` (after the last module test, before the end of the file):

```js
// --- Route tests ---

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

test('GET /api/projects/:id/docs returns array', async () => {
  const r = await req('GET', '/api/projects/1/docs');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body));
});

test('POST /api/projects/:id/docs with plain text returns 201 and { id }', async () => {
  const r = await req('POST', '/api/projects/1/docs', {
    title: 'route-test-prd.txt',
    content: 'This is the product requirements document.',
    mimeType: 'text/plain',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok('id' in body);
  assert.ok(body.id > 0);
});

test('POST /api/projects/:id/docs with PDF mimeType returns 201 in TEST_MODE', async () => {
  const r = await req('POST', '/api/projects/1/docs', {
    title: 'spec.pdf',
    content: 'fake-base64-pdf-content',
    mimeType: 'application/pdf',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok('id' in body);
});

test('POST /api/projects/:id/docs missing title returns 400', async () => {
  const r = await req('POST', '/api/projects/1/docs', { content: 'some content' });
  assert.equal(r.status, 400);
});

test('GET /api/projects/:id/docs/:docId returns doc with content', async () => {
  const create = await req('POST', '/api/projects/1/docs', {
    title: 'route-get-test.md',
    content: '# Design\n\nArchitecture notes.',
    mimeType: 'text/markdown',
  });
  const { id } = await create.json();
  const r = await req('GET', `/api/projects/1/docs/${id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('content' in body);
  assert.equal(body.content, '# Design\n\nArchitecture notes.');
});

test('GET /api/projects/:id/docs/:docId with unknown id returns 404', async () => {
  const r = await req('GET', '/api/projects/1/docs/999999');
  assert.equal(r.status, 404);
});

test('DELETE /api/projects/:id/docs/:docId returns 204', async () => {
  const create = await req('POST', '/api/projects/1/docs', {
    title: 'delete-me.txt',
    content: 'temporary',
  });
  const { id } = await create.json();
  const r = await req('DELETE', `/api/projects/1/docs/${id}`);
  assert.equal(r.status, 204);
});
```

- [ ] **Step 3: Run tests — confirm 7 new tests fail (routes don't exist yet)**

```
cd dashboard
node --test tests/project_docs.test.js
```

Expected: 5 pass (module tests), 7 fail (route tests — 404 from Express on unknown routes).

- [ ] **Step 4: Add imports to `dashboard/server.js`**

In `dashboard/server.js`, add two import lines. The existing imports end around line 25. Add after the `skills.js` import line:

```js
// EXISTING line 25:
import { listSkills, getSkill, createSkill, updateSkill, deleteSkill, upsertSkill } from './skills.js';

// ADD these two lines immediately after:
import pdfParse from 'pdf-parse';
import { listDocs, getDoc, createDoc, deleteDoc } from './project_docs.js';
```

- [ ] **Step 5: Add 4 project doc routes to `dashboard/server.js`**

In `dashboard/server.js`, find the block ending with `app.delete('/projects/:id/agents/:agentName', ...)` (around line 542–547). After its closing `});`, and before `// --- Suggestion routes ---`, insert the following block:

```js
  // --- Project doc routes ---

  app.get('/api/projects/:id/docs', (req, res) => {
    res.json(listDocs(Number(req.params.id)));
  });

  app.post('/api/projects/:id/docs', async (req, res) => {
    const { title, content, mimeType = 'text/plain', source = 'upload' } = req.body ?? {};
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });
    const projectId = Number(req.params.id);
    let text = content;
    if (mimeType === 'application/pdf' && !TEST_MODE) {
      try {
        const b64 = content.replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(b64, 'base64');
        const parsed = await pdfParse(buf);
        text = parsed.text;
      } catch (err) {
        return res.status(422).json({ error: `PDF extraction failed: ${err.message}` });
      }
    }
    const id = createDoc({ projectId, title, mimeType, content: text, source });
    res.status(201).json({ id });
  });

  app.get('/api/projects/:id/docs/:docId', (req, res) => {
    const doc = getDoc(Number(req.params.docId));
    if (!doc) return res.status(404).json({ error: 'doc not found' });
    res.json(doc);
  });

  app.delete('/api/projects/:id/docs/:docId', (req, res) => {
    const id = Number(req.params.docId);
    if (!getDoc(id)) return res.status(404).json({ error: 'doc not found' });
    deleteDoc(id);
    res.status(204).end();
  });
```

- [ ] **Step 6: Run all 12 tests — expect all to pass**

```
cd dashboard
node --test tests/project_docs.test.js
```

Expected: 12 pass, 0 fail.

- [ ] **Step 7: Run full test suite to confirm no regressions**

```
cd dashboard
npm test
```

Expected: 212 total tests, 210 pass (2 pre-existing Windows EPERM failures in sp5/sp6 only).

- [ ] **Step 8: Update `dashboard/package.json` test script**

In `package.json`, find the `"test"` script. It currently ends with `tests/skills.test.js`. Append `tests/project_docs.test.js` to the end:

```json
"test": "node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js tests/projects.test.js tests/mcp.test.js tests/queue.test.js tests/orchestrator.test.js tests/sp5.test.js tests/sp6.test.js tests/apikeys.test.js tests/telegram.test.js tests/github.test.js tests/ollama.test.js tests/lmstudio.test.js tests/docker.test.js tests/skills.test.js tests/project_docs.test.js"
```

- [ ] **Step 9: Commit**

```
cd dashboard
git add server.js tests/project_docs.test.js package.json package-lock.json
git commit -m "feat(sp16a): add project doc routes, pdf-parse, and route tests"
```

---

### Task 3: Orchestrator Doc Injection

**Files:**
- Modify: `dashboard/orchestrator.js` (import `listDocsWithContent`; update `buildOrchestratorTaskFile`; update `createOrchestration`)

**Interfaces:**
- Consumes (from Task 1): `listDocsWithContent(projectId: number): { id, title, content }[]` from `./project_docs.js`
- No new routes or exports produced.

Note: The existing test `buildOrchestratorTaskFile contains goal and API guide` in `tests/orchestrator.test.js` calls the function without `projectDocs`. Adding a default of `projectDocs = []` preserves backward compatibility — the output is identical when no docs are supplied.

- [ ] **Step 1: Add import to `dashboard/orchestrator.js`**

At the top of `dashboard/orchestrator.js`, after the existing imports (after line 8 which imports from `./terminal.js`), add:

```js
import { listDocsWithContent } from './project_docs.js';
```

- [ ] **Step 2: Update `buildOrchestratorTaskFile` to accept and render docs**

In `dashboard/orchestrator.js`, replace the existing `buildOrchestratorTaskFile` function (lines 29–97) with this updated version:

```js
export function buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs = [] }) {
  const docsSection = projectDocs.length > 0
    ? `\n## Project Documents\n\nThe following reference documents are attached to this project. Use them to inform your plan.\n\n${projectDocs.map(d => `### ${d.title}\n\n${d.content}`).join('\n\n---\n\n')}\n`
    : '';

  return `## Orchestration Goal
${goal}
${docsSection}
## Your Role — Orchestrator
You are the Flint Orchestrator. Your job:
1. Read the goal above and think through what needs to happen.
2. Write your plan to the shared scratchpad.
3. Create queue tasks and spawn typed worker agents to execute each part.
4. Monitor progress by checking the task queue and scratchpad.
5. When all tasks are done, synthesise the results in the scratchpad under ## Synthesis.

## Shared Scratchpad
Path: ${scratchpadPath}
Write your plan there first. Workers will append findings under ## Findings.
Read it to track progress. Write your final synthesis under ## Synthesis.

## Flint REST API
Base URL: http://localhost:3000

### Spawn a worker agent
\`\`\`
# POST /agents/spawn
curl -s -X POST http://localhost:3000/agents/spawn \\
  -H "Content-Type: application/json" \\
  -d '{"name":"<agent-name>","workdir":"${workdir.replace(/\\/g, '\\\\')}","runtime":"claude"}'
\`\`\`

### Create a task and assign it to a worker
\`\`\`
# POST /queue/tasks
curl -s -X POST http://localhost:3000/queue/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title":"<title>","description":"<desc>","assigned_to":"<agent-name>","role":"researcher","created_by":"orch-${id}"}'
\`\`\`

### Check task queue progress
\`\`\`
curl -s "http://localhost:3000/queue/tasks?created_by=orch-${id}"
\`\`\`

### Mark a task done with result
\`\`\`
curl -s -X PATCH http://localhost:3000/queue/tasks/<id> \\
  -H "Content-Type: application/json" \\
  -d '{"status":"done","result":"<summary>"}'
\`\`\`

### Append synthesis to scratchpad
\`\`\`
curl -s -X POST http://localhost:3000/orchestrations/${id}/scratchpad \\
  -H "Content-Type: application/json" \\
  -d '{"text":"\\n## Synthesis\\n\\n<your synthesis here>"}'
\`\`\`

## Worker Roles
- **researcher**: investigates, reads docs, surveys prior art
- **planner**: designs architecture, data models, API contracts
- **builder**: writes code and commits it
- **tester**: writes tests, runs them, reports results

## Suggested Flow
1. Write plan to scratchpad.
2. Spawn a researcher and assign it a research task (created_by="orch-${id}").
3. When research tasks are done (poll queue), spawn planner + builder.
4. When builder finishes, spawn tester.
5. Read all findings from scratchpad, write synthesis, then your work is complete.
`;
}
```

- [ ] **Step 3: Update `createOrchestration` to pass docs to task file builder**

In `dashboard/orchestrator.js`, find `createOrchestration` (around line 112). Locate the `writeTasks` call:

```js
// EXISTING:
  writeTasks(agentName, buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath }));

// REPLACE WITH:
  const projectDocs = projectId ? listDocsWithContent(projectId) : [];
  writeTasks(agentName, buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs }));
```

- [ ] **Step 4: Run orchestrator tests — expect all to pass**

```
cd dashboard
node --test tests/orchestrator.test.js
```

Expected: all existing orchestrator tests pass. The `buildOrchestratorTaskFile` test still passes because calling it without `projectDocs` uses the default `[]`, producing no docs section — identical output to before.

- [ ] **Step 5: Commit**

```
cd dashboard
git add orchestrator.js
git commit -m "feat(sp16a): inject project docs into orchestrator task file"
```

---

### Task 4: Frontend — Docs Button + Modal

**Files:**
- Modify: `dashboard/public/index.html` (add `#proj-docs-modal` after `#skill-import-modal`)
- Modify: `dashboard/public/app.js` (update `renderProjects` card; update `fetchProjects` for doc counts; add modal JS)

**Interfaces:**
- Consumes API routes (from Task 2): `GET /api/projects/:id/docs`, `POST /api/projects/:id/docs`, `DELETE /api/projects/:id/docs/:docId`
- Consumes (from Task 1 — already in scope): `escHtml()` helper, `fetchProjects()`, `openEditProjectModal()` — all already defined in `app.js`

- [ ] **Step 1: Add `#proj-docs-modal` to `dashboard/public/index.html`**

In `index.html`, find the `<!-- Skill GitHub import modal -->` block (around lines 260–272). After its closing `</div>` (line 272) and before the `<!-- API Keys modal -->` comment (line 274), insert:

```html
  <!-- Project docs modal -->
  <div id="proj-docs-modal" class="hidden" role="dialog" aria-modal="true">
    <div class="modal-box" style="max-width:560px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 id="proj-docs-title" style="margin:0">Project Documents</h2>
        <button id="proj-docs-close" style="background:none;border:none;color:#8b949e;font-size:18px;cursor:pointer">✕</button>
      </div>
      <div id="proj-docs-list" style="min-height:40px;margin-bottom:16px;display:flex;flex-direction:column;gap:8px"></div>
      <div style="display:flex;gap:8px">
        <button id="proj-docs-upload-btn" style="background:#238636;border:none;color:#fff;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:14px">Upload Document</button>
      </div>
      <input id="proj-docs-file-input" type="file" accept=".txt,.md,.pdf" style="display:none">
    </div>
  </div>
```

- [ ] **Step 2: Update project card footer in `renderProjects` to add Docs button**

In `dashboard/public/app.js`, find `renderProjects` (around line 477). Inside the `for` loop, the card's `innerHTML` ends with:

```js
      <div class="project-card-footer">
        <button class="btn-edit" data-proj-id="${p.id}">Edit</button>
      </div>
```

Replace that footer with:

```js
      <div class="project-card-footer">
        <button class="btn-docs" data-proj-id="${p.id}">📄 Docs</button>
        <button class="btn-edit" data-proj-id="${p.id}">Edit</button>
      </div>
```

Then, directly after `card.innerHTML = \`...\`;`, replace the existing event listener line:

```js
// EXISTING (selects whichever button comes first — now wrong since Docs comes first):
    card.querySelector('[data-proj-id]').addEventListener('click', () => openEditProjectModal(p.id));

// REPLACE WITH (two separate listeners, each using the right class selector):
    card.querySelector('.btn-edit').addEventListener('click', () => openEditProjectModal(p.id));
    card.querySelector('.btn-docs').addEventListener('click', () => openDocsModal(p.id, p.name));
```

- [ ] **Step 3: Update `fetchProjects` to load doc counts after rendering**

In `dashboard/public/app.js`, find `fetchProjects` (around line 469):

```js
// EXISTING:
async function fetchProjects() {
  try {
    const res = await fetch('/projects');
    const projects = await res.json();
    renderProjects(projects);
  } catch { /* silent fail */ }
}

// REPLACE WITH:
async function fetchProjects() {
  try {
    const res = await fetch('/projects');
    const projects = await res.json();
    renderProjects(projects);
    await Promise.all(projects.map(async p => {
      try {
        const r = await fetch(`/api/projects/${p.id}/docs`);
        const docs = await r.json();
        const btn = document.querySelector(`.btn-docs[data-proj-id="${p.id}"]`);
        if (btn) btn.textContent = `📄 Docs (${docs.length})`;
      } catch { /* silent fail */ }
    }));
  } catch { /* silent fail */ }
}
```

- [ ] **Step 4: Add the docs modal JS to `dashboard/public/app.js`**

Find the end of the `// --- Edit Project modal ---` section in `app.js` (the block that ends with the `edit-proj-link-btn` listener, around line 640). After the last listener in that block, add the following new section:

```js
// --- Project docs modal ---

let _docsProjectId = null;

async function openDocsModal(projectId, projectName) {
  _docsProjectId = projectId;
  document.getElementById('proj-docs-title').textContent = `Docs — ${projectName}`;
  document.getElementById('proj-docs-modal').classList.remove('hidden');
  await _refreshDocsList();
}

async function _refreshDocsList() {
  const list = document.getElementById('proj-docs-list');
  list.innerHTML = '<span style="color:#8b949e;font-size:13px">Loading…</span>';
  const r = await fetch(`/api/projects/${_docsProjectId}/docs`);
  const docs = await r.json();
  if (!docs.length) {
    list.innerHTML = '<span style="color:#8b949e;font-size:13px">No documents yet. Upload a PRD, BRD, or design doc.</span>';
    return;
  }
  list.innerHTML = '';
  for (const doc of docs) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px';
    const date = new Date(doc.created_at * 1000).toLocaleDateString();
    const badge = doc.source === 'agent'
      ? '<span style="font-size:11px;padding:1px 6px;border-radius:3px;background:#21262d;color:#8b949e">agent</span>'
      : '<span style="font-size:11px;padding:1px 6px;border-radius:3px;background:#21262d;color:#8b949e">upload</span>';
    row.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:3px">
        <span style="font-weight:600;font-size:14px">${escHtml(doc.title)}</span>
        <span style="font-size:12px;color:#8b949e">${badge} &nbsp; ${date}</span>
      </div>
      <button data-del-doc-id="${doc.id}" style="background:none;border:none;color:#f85149;cursor:pointer;font-size:18px;padding:0 4px" title="Delete document">🗑</button>
    `;
    row.querySelector('[data-del-doc-id]').addEventListener('click', async () => {
      await fetch(`/api/projects/${_docsProjectId}/docs/${doc.id}`, { method: 'DELETE' });
      await _refreshDocsList();
    });
    list.appendChild(row);
  }
}

document.getElementById('proj-docs-close').addEventListener('click', () => {
  document.getElementById('proj-docs-modal').classList.add('hidden');
  fetchProjects();
});

document.getElementById('proj-docs-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('proj-docs-modal')) {
    document.getElementById('proj-docs-modal').classList.add('hidden');
    fetchProjects();
  }
});

document.getElementById('proj-docs-upload-btn').addEventListener('click', () => {
  document.getElementById('proj-docs-file-input').value = '';
  document.getElementById('proj-docs-file-input').click();
});

document.getElementById('proj-docs-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const title = file.name;
  const isPdf = file.name.toLowerCase().endsWith('.pdf');
  const isMd  = file.name.toLowerCase().endsWith('.md');

  const content = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = ev => resolve(ev.target.result);
    reader.onerror = reject;
    if (isPdf) reader.readAsDataURL(file);
    else       reader.readAsText(file);
  });

  const mimeType = isPdf ? 'application/pdf' : (isMd ? 'text/markdown' : 'text/plain');

  const r = await fetch(`/api/projects/${_docsProjectId}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content, mimeType, source: 'upload' }),
  });

  if (r.ok) {
    await _refreshDocsList();
    fetchProjects();
  } else {
    const err = await r.json().catch(() => ({}));
    alert(`Upload failed: ${err.error ?? 'unknown error'}`);
  }
});
```

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```
cd dashboard
npm test
```

Expected: 212 total, 210 pass (2 pre-existing EPERM failures only).

- [ ] **Step 6: Commit**

```
cd dashboard
git add public/index.html public/app.js
git commit -m "feat(sp16a): add project docs UI — Docs button on cards, upload modal"
```

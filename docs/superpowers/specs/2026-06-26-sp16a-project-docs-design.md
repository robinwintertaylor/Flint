# SP16a: Project Documents — Design Spec

**Date:** 2026-06-26
**Status:** Approved

## Overview

Attach reference documents (PRDs, BRDs, design docs) to projects so that agents and users can reference them. Documents are uploaded via the dashboard or submitted by an agent after a research run. Text is extracted at upload time and stored in SQLite. When an orchestrator is started for a project, all project docs are injected into its context automatically.

---

## Architecture

**New file:** `dashboard/project_docs.js` — SQLite CRUD module. Five named exports. No new npm dependencies beyond `pdf-parse` (added to package.json).

**Modified:** `dashboard/db.js` — adds `project_docs` table migration after `skills`.

**Modified:** `dashboard/server.js` — four new routes under `/api/projects/:id/docs` + `pdf-parse` import.

**Modified:** `dashboard/orchestrator.js` — injects docs into `buildOrchestratorTaskFile` when `projectId` has documents.

**Modified:** `dashboard/public/index.html` — `#proj-docs-modal` and hidden file input.

**Modified:** `dashboard/public/app.js` — "Docs (N)" button on project cards, modal logic.

**New file:** `dashboard/tests/project_docs.test.js` — 12 tests.

**Modified:** `dashboard/package.json` — adds `pdf-parse`, appends test file to test script.

---

## Data Model

New `project_docs` table added in `db.js` inside the existing `_db.exec()` block, after the `skills` table:

```sql
CREATE TABLE IF NOT EXISTS project_docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  mime_type   TEXT    NOT NULL DEFAULT 'text/plain',
  content     TEXT    NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'upload',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

`source` values: `'upload'` | `'agent'`.

`mime_type` values: `'text/plain'` | `'text/markdown'` | `'application/pdf'` (stored as extracted text — `mime_type` records the original file type for display).

No `updated_at` — documents are immutable once created (delete + re-upload to replace).

Note: no `REFERENCES` constraint — `PRAGMA foreign_keys` is not enabled in this codebase and projects cannot be deleted, so orphan docs are not a concern.

---

## `dashboard/project_docs.js` Module

Five named exports, same pattern as `skills.js` — imports `getDb()`, no `initDb()`:

**`listDocs(projectId): { id, title, mime_type, source, created_at }[]`**
Returns all docs for a project without the `content` field. Ordered by `created_at DESC`.

**`getDoc(id): { id, project_id, title, mime_type, content, source, created_at } | null`**
Returns full row including `content`. Returns `null` if not found.

**`createDoc({ projectId, title, mimeType, content, source }): number`**
Inserts a new document. `mimeType` defaults to `'text/plain'`. `source` defaults to `'upload'`. Returns the new `id`.

**`deleteDoc(id): void`**
Deletes the doc by id.

**`listDocsWithContent(projectId): { id, title, content }[]`**
Returns all docs for a project INCLUDING `content`. Used by the orchestrator for context injection. Ordered by `created_at DESC`.

---

## Server Routes

Import line added to `server.js`:
```js
import { listDocs, getDoc, createDoc, deleteDoc, listDocsWithContent } from './project_docs.js';
```

PDF import added to `server.js`:
```js
import pdfParse from 'pdf-parse';
```

All four routes placed under `// --- Project doc routes ---` after the skills routes block.

### `GET /api/projects/:id/docs`
Returns `listDocs(id)` — array without content. 200.

### `POST /api/projects/:id/docs`

Body: `{ title, content, mimeType?, source? }`.

- Validates `title` and `content` both present — 400 if missing.
- If `mimeType === 'application/pdf'` and `TEST_MODE` is false:
  - Strips data-URI prefix from `content`: `content.replace(/^data:[^;]+;base64,/, '')`
  - Decodes base64 to `Buffer`
  - Runs `await pdfParse(buf)` to extract `.text`
  - Returns 422 `{ error: 'PDF extraction failed: <msg>' }` on parse error
- In `TEST_MODE` with PDF: stores `content` as-is (skips extraction — enables route testing without real PDFs).
- Calls `createDoc({ projectId, title, mimeType, content: text, source })`.
- Returns 201 `{ id }`.

### `GET /api/projects/:id/docs/:docId`
Returns `getDoc(docId)` including content. 404 `{ error: 'doc not found' }` if missing.

### `DELETE /api/projects/:id/docs/:docId`
Calls `deleteDoc(docId)`. Returns 204. 404 if not found.

---

## PDF Handling

The frontend uses `FileReader` to encode files before upload:
- `.txt` / `.md`: `FileReader.readAsText()` → sent as plain string in `content` field, `mimeType: 'text/plain'` or `'text/markdown'`
- `.pdf`: `FileReader.readAsDataURL()` → data URI string in `content` field, `mimeType: 'application/pdf'`

The server strips the data-URI prefix, decodes base64, and passes the buffer to `pdf-parse`. Extracted text replaces the base64 content before storage. The `mime_type` column still records `'application/pdf'` so the UI can show the original file type.

---

## Orchestrator Injection

`orchestrator.js` changes:

1. **Import:** Add `import { listDocsWithContent } from './project_docs.js';` at top.

2. **`buildOrchestratorTaskFile` signature:** Add `projectDocs = []` parameter.

3. **Docs section:** If `projectDocs.length > 0`, insert a `## Project Documents` section between the goal and the role description:

```js
const docsSection = projectDocs.length > 0
  ? `\n## Project Documents\n\nThe following reference documents are attached to this project. Use them to inform your plan.\n\n${projectDocs.map(d => `### ${d.title}\n\n${d.content}`).join('\n\n---\n\n')}\n`
  : '';
```

4. **`createOrchestration`:** Before calling `buildOrchestratorTaskFile`, fetch docs:
```js
const projectDocs = projectId ? listDocsWithContent(projectId) : [];
writeTasks(agentName, buildOrchestratorTaskFile({ goal, id, workdir, scratchpadPath, projectDocs }));
```

This is the only place injection is needed — the orchestrator is the top-level agent that plans and delegates. Workers receive their context through tasks and the shared scratchpad.

---

## Frontend UI

### Project Card Changes

Each project card gains a `📄 Docs` button alongside the existing `Edit` button. The button shows a count once the doc list is loaded: `📄 Docs (2)`.

Doc counts are fetched lazily when the projects view renders — a single `GET /api/projects/:id/docs` per project, run in parallel.

### `#proj-docs-modal`

New modal added to `index.html` after the existing `#proj-modal`:

```html
<div id="proj-docs-modal" class="hidden" style="position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:100">
  <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;min-width:480px;max-width:640px;max-height:80vh;display:flex;flex-direction:column;gap:12px">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 id="proj-docs-modal-title" style="margin:0">Documents</h3>
      <button id="proj-docs-modal-close" style="background:none;border:none;color:#8b949e;cursor:pointer;font-size:18px">✕</button>
    </div>
    <div id="proj-docs-list" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px"></div>
    <div style="display:flex;gap:8px">
      <button id="proj-docs-upload-btn" style="background:#238636;border:none;color:#fff;padding:6px 14px;border-radius:4px;cursor:pointer">Upload Document</button>
    </div>
    <input id="proj-docs-file-input" type="file" accept=".txt,.md,.pdf" style="display:none">
  </div>
</div>
```

### Modal Behaviour

- **Open:** User clicks `📄 Docs` on a project card → `openDocsModal(projectId, projectName)` sets the modal title, stores the current `projectId`, fetches doc list, renders it, removes `hidden`.
- **Doc list rendering:** Each doc row shows title, a source badge (`upload` / `agent`), date, and a trash icon button. If no docs: "No documents yet. Upload a PRD, BRD, or design doc."
- **Upload:** Clicking `Upload Document` triggers `#proj-docs-file-input.click()`. On `change`:
  - Get the file. Derive `title` from `file.name`.
  - If `.pdf`: `readAsDataURL` → send `{ title, content: dataUrl, mimeType: 'application/pdf', source: 'upload' }`.
  - Otherwise: `readAsText` → send `{ title, content: text, mimeType: 'text/plain', source: 'upload' }`.
  - POST to `/api/projects/${projectId}/docs`, then re-fetch list and re-render.
- **Delete:** Trash button → `DELETE /api/projects/:id/docs/:docId` → re-fetch list.
- **Close:** `✕` button or backdrop click → add `hidden`.

---

## npm Dependency

Add `pdf-parse` to `dashboard/package.json` dependencies:
```json
"pdf-parse": "^1.1.1"
```

---

## Out of Scope

- Markdown rendering of document content in the UI (plain-text in a `<pre>` is sufficient)
- User download of original files (extracted text only)
- Pagination of documents within a project (list all; projects are unlikely to have >20 docs)
- Worker agent injection (orchestrator is the top-level recipient; it routes context to workers via tasks)
- Document versioning / history
- Editing doc content in the UI (delete + re-upload)

---

## Test Approach

`dashboard/tests/project_docs.test.js` — 12 tests, `FLINT_TEST_MODE=1`, `node:test` + `node:assert/strict`:

**DB module tests (5):**

| Test | Assertion |
|------|-----------|
| `createDoc` returns positive integer id | `assert.ok(id > 0)` |
| `listDocs` returns docs without `content` field | `assert.ok(!('content' in docs[0]))` |
| `getDoc` returns full doc with `content` | `assert.ok('content' in doc)` |
| `deleteDoc` removes doc; `getDoc` returns null | `assert.equal(getDoc(id), null)` |
| `listDocsWithContent` returns docs with `content` | `assert.ok('content' in docs[0])` |

**Route tests (7):**

| Test | Assertion |
|------|-----------|
| `GET /api/projects/:id/docs` returns array | `assert.ok(Array.isArray(body))` |
| `POST /api/projects/:id/docs` text → 201 + `{ id }` | `assert.equal(res.status, 201); assert.ok('id' in body)` |
| `POST /api/projects/:id/docs` PDF (TEST_MODE) → 201 | `assert.equal(res.status, 201)` |
| `POST /api/projects/:id/docs` missing title → 400 | `assert.equal(res.status, 400)` |
| `GET /api/projects/:id/docs/:docId` returns doc with content | `assert.ok('content' in body)` |
| `GET /api/projects/:id/docs/:docId` unknown → 404 | `assert.equal(res.status, 404)` |
| `DELETE /api/projects/:id/docs/:docId` → 204 | `assert.equal(res.status, 204)` |

**Target:** 200 existing + 12 new = 212 total (210 pass, 2 pre-existing Windows EPERM).

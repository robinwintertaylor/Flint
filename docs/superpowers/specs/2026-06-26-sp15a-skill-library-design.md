# SP15a: Skill Library — Design Spec

**Date:** 2026-06-26
**Status:** Approved

## Overview

Add a shared skill library to Flint so that reusable procedural knowledge can be stored, browsed, and discovered by agents and users alike. Skills are on-demand knowledge packages: metadata (name + description) is always available for discovery; full content is loaded only when needed. Three ingestion paths feed the same library: manual creation in the dashboard UI, agent submission at task end, and GitHub import. SP15b (skill injection at spawn) will consume this library once it exists.

---

## Architecture

**New file:** `dashboard/skills.js` — SQLite CRUD module. Six named exports. No npm dependencies.

**Modified:** `dashboard/db.js` — adds `skills` table migration.

**Modified:** `dashboard/server.js` — six new routes under `/api/skills`.

**Modified:** `dashboard/public/index.html` — `📚 Skills` toolbar button + `#skills-view` div.

**Modified:** `dashboard/public/app.js` — skills view logic (list, create, edit, delete, import).

**Modified:** `dashboard/public/style.css` — skill card styles.

**New file:** `dashboard/tests/skills.test.js` — 14 tests.

**Modified:** `dashboard/package.json` — test script updated.

No new npm dependencies. No changes to existing routes or DB tables.

---

## Data Model

New `skills` table added via migration in `db.js` (inside the existing `initDb()` function):

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

`source` values: `'manual'` | `'agent'` | `'github:<repo_url>'`

`tags`: comma-separated string (e.g. `'git,pr,writing'`).

---

## `dashboard/skills.js` Module

Six named exports:

**`listSkills(): { id, name, description, source, tags, created_at }[]`**
Returns all skills without the `content` field — fast for list rendering.

**`getSkill(id: number): { id, name, description, content, source, tags, created_at, updated_at } | null`**
Returns full skill including content. Returns `null` if not found.

**`createSkill({ name, description, content, source?, tags? }): number`**
Inserts a new skill. `source` defaults to `'manual'`. `tags` defaults to `''`. Returns the new `id`. Throws on duplicate name.

**`updateSkill(id: number, { name?, description?, content?, tags? }): void`**
Updates only the supplied fields plus `updated_at`. No-op if id not found.

**`deleteSkill(id: number): void`**
Deletes the skill by id.

**`upsertSkill({ name, description, content, source, tags? }): { id: number, created: boolean }`**
Inserts if `name` not found; updates `description`, `content`, `source`, `tags`, `updated_at` if it exists. Returns `{ id, created }` so callers can track import statistics.

---

## Server Routes

All imported from `./skills.js`. Added to `server.js` after the existing LM Studio / Docker routes block.

### `GET /api/skills`
Returns `listSkills()` — array of skills without content. 200.

### `GET /api/skills/:id`
Returns `getSkill(id)` including content. 404 `{ error: 'skill not found' }` if missing.

### `POST /api/skills`
Body: `{ name, description, content, source?, tags? }`.
Validates `name`, `description`, `content` all present — 400 if any missing.
Returns 201 `{ id }` on success. 400 if name already exists.

Used by both manual creation and agent self-submission (agents set `source: 'agent'`).

### `PATCH /api/skills/:id`
Body: any subset of `{ name, description, content, tags }`.
Calls `updateSkill`. 404 if skill not found. Returns updated skill via `getSkill`.

### `DELETE /api/skills/:id`
Calls `deleteSkill`. 404 if not found. Returns 204 on success.

### `POST /api/skills/import-github`

**Defined before `/:id` routes to prevent path collision.**

Body: `{ url }` — a GitHub repo URL, e.g. `https://github.com/owner/repo` or `https://github.com/owner/repo/tree/main/skills`.

In TEST_MODE: returns `{ imported: 1, updated: 0, skipped: 0 }` immediately.

Real execution flow:
1. Parse `url` → extract `owner`, `repo`, optional `branch` and `pathPrefix` from `/tree/<branch>/<path>` segment.
2. `GET https://api.github.com/repos/{owner}/{repo}` → read `default_branch` (used if no branch in URL).
3. `GET https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1` → flat file tree.
4. Filter: keep `.md` files where filename is `skill.md` / `SKILL.md`, or path contains a `skills/` directory segment. If `pathPrefix` present, also filter by it.
5. For each candidate: `GET https://api.github.com/repos/{owner}/{repo}/contents/{path}` → decode base64 content.
6. Parse YAML frontmatter with inline regex (no npm dependency). Files without valid `name` + `description` in frontmatter are counted as `skipped`.
7. `upsertSkill({ name, description, content: body, source: 'github:<url>', tags })` for each valid file.
8. Return `{ imported, updated, skipped }`.

Auth: `Authorization: Bearer <token>` using `getApiKeyValue('github')` (already imported). Falls back gracefully to no auth header if key is absent (works for public repos up to rate limit).

---

## Frontmatter Parser

Inline function in `server.js` (or `skills.js`), no new file needed:

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

---

## Frontend UI

### Toolbar
New button added to `#toolbar` between `🔑 Keys` and `⬡ Queue`:
```html
<button id="btn-skills">📚 Skills</button>
```

### Skills View
New `<div id="skills-view" class="hidden">` added to `index.html` (same sibling level as `#queue-view`). Contains:
- Header row: "Skills Library" heading + "New Skill" button + "Import from GitHub" button
- `<div id="skills-list">` — populated dynamically

### Skill Cards
Each card shows: **name** (bold), description (muted), source badge, tags chips. Click card → inline toggle of `#skill-content-{id}` div showing full content (monospace pre). Each card has Edit and Delete icon buttons.

### New Skill Modal
Reuses the existing `#modal` element pattern with fields:
- Name (text)
- Description (text)
- Tags (text, comma-separated, optional)
- Content (textarea)

Submit → `POST /api/skills` (create) or `PATCH /api/skills/:id` (edit).

### Import Modal
Small inline modal (or repurposed `#modal`):
- URL text input
- Import button → `POST /api/skills/import-github`
- Result line: "Imported 3, updated 1, skipped 0" or error message

### Interactions
All operations use `fetch` + list refresh. No WebSocket needed.

---

## Configuration

No new env vars. GitHub auth reuses the existing `github` API key stored in the DB.

---

## Out of Scope

- Skill search / filtering by tag (SP15a lists all; future enhancement)
- Skill versioning / history
- Skill injection at agent spawn (SP15b)
- Markdown rendering of skill content in the UI (plain text / monospace is sufficient)
- Private GitHub repos without a stored GitHub key

---

## Test Approach

`dashboard/tests/skills.test.js` — 14 tests, `FLINT_TEST_MODE=1`, `node:test` + `node:assert/strict`:

**DB module tests (6):**
| Test | Assertion |
|------|-----------|
| `createSkill` returns a positive integer id | `assert.ok(id > 0)` |
| `listSkills` returns skill without `content` field | `assert.ok(!('content' in skill))` |
| `getSkill` returns full skill with `content` | `assert.ok('content' in skill)` |
| `updateSkill` changes the name field | `assert.equal(getSkill(id).name, 'renamed')` |
| `upsertSkill` on new name returns `{ created: true }` | `assert.equal(result.created, true)` |
| `upsertSkill` on existing name returns `{ created: false }` | `assert.equal(result.created, false)` |

**Route tests (8):**
| Test | Assertion |
|------|-----------|
| `GET /api/skills` returns array | `assert.ok(Array.isArray(body))` |
| `POST /api/skills` valid body → 201 + `{ id }` | `assert.equal(res.status, 201); assert.ok('id' in body)` |
| `POST /api/skills` missing field → 400 | `assert.equal(res.status, 400)` |
| `GET /api/skills/:id` returns skill with `content` | `assert.ok('content' in body)` |
| `GET /api/skills/:id` unknown id → 404 | `assert.equal(res.status, 404)` |
| `PATCH /api/skills/:id` updates name | `assert.equal(body.name, 'updated-name')` |
| `DELETE /api/skills/:id` → 204 | `assert.equal(res.status, 204)` |
| `POST /api/skills/import-github` TEST_MODE → `{ imported, updated, skipped }` | `assert.ok('imported' in body)` |

**Target:** 185 existing + 14 new = 199 total (197 pass, 2 pre-existing Windows EPERM).

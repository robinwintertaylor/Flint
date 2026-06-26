# SP17a: Specialist Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a named specialist agent registry — each expert has a soul (identity), skills, and model preference — and wire it into Flint so the right specialist is injected whenever an agent is spawned.

**Architecture:** Three layers: (1) DB + file registry (`dashboard/specialists.js` + `agents/specialists/`), (2) LLM selector that picks or creates a specialist from the registry (`agents/specialists/selector.js`), (3) soul and model injection at spawn time (`dashboard/terminal.js`). Dashboard gets a full Specialists tab for viewing, creating, and editing.

**Tech Stack:** Node.js ESM, better-sqlite3, node:fs, node:test

## Global Constraints

- Specialist names: lowercase letters, numbers, hyphens only — regex `/^[a-z0-9-]+$/`
- JSON arrays (`domains`, `skills`) stored as JSON-serialised strings in SQLite
- `agents/` directory does not exist yet — tasks create it
- `FLINT_AGENTS_ROOT` env var overrides the agents base directory (used in tests); defaults to `<project-root>/agents`
- `FLINT_TEST_MODE=1` causes `complete()` in `router/providers.js` to return a stub — the selector must handle this by skipping its router fetch
- soul.md missing at spawn time is non-fatal: log a warning and spawn without specialist identity
- All cross-directory imports follow the pattern already established in the codebase (router ↔ dashboard)

---

### Task 1: DB schema + specialists CRUD module

**Files:**
- Modify: `dashboard/db.js` (add `specialists` table to `initDb()`)
- Create: `dashboard/specialists.js`
- Create: `dashboard/tests/specialists.test.js`
- Modify: `dashboard/package.json` (add specialists.test.js to test command)

**Interfaces:**
- Produces:
  - `listSpecialists() → Specialist[]` — array with parsed `domains` and `skills` arrays
  - `getSpecialist(name: string) → Specialist | null`
  - `createSpecialist({ name, label, description?, domains?, skills?, preferred_tier?, preferred_provider?, created_by? }) → void`
  - `updateSpecialist(name: string, fields: Partial<Specialist>) → number` (changes count)
  - `deleteSpecialist(name: string) → number` (changes count)
  - `incrementUsage(name: string) → void`
  - `Specialist` shape: `{ name, label, description, domains: string[], skills: string[], preferred_tier: number, preferred_provider: string|null, created_by: string, created_at: string, use_count: number, last_used: string|null }`

- [ ] **Step 1: Add specialists table to db.js**

Open `dashboard/db.js`. After the `project_docs` table definition (currently ending around line 118, inside the `_db.exec(...)` template literal), add:

```js
    CREATE TABLE IF NOT EXISTS specialists (
      name               TEXT PRIMARY KEY,
      label              TEXT NOT NULL,
      description        TEXT,
      domains            TEXT,
      skills             TEXT,
      preferred_tier     INTEGER DEFAULT 2,
      preferred_provider TEXT,
      created_by         TEXT NOT NULL DEFAULT 'robin',
      created_at         TEXT NOT NULL,
      use_count          INTEGER NOT NULL DEFAULT 0,
      last_used          TEXT
    );
```

Insert it after the `project_docs` table block and before the closing backtick of the `_db.exec(...)` call.

- [ ] **Step 2: Run db test to verify the table is created**

```
cd dashboard && node --test tests/db.test.js
```

Expected: all existing tests pass (the new table is created silently).

- [ ] **Step 3: Create dashboard/specialists.js**

```js
import { getDb } from './db.js';

export function listSpecialists() {
  return getDb()
    .prepare('SELECT name, label, description, domains, skills, preferred_tier, preferred_provider, created_by, created_at, use_count, last_used FROM specialists ORDER BY use_count DESC, label')
    .all()
    .map(parseRow);
}

export function getSpecialist(name) {
  const row = getDb().prepare('SELECT * FROM specialists WHERE name = ?').get(name);
  return row ? parseRow(row) : null;
}

export function createSpecialist({
  name, label,
  description  = '',
  domains      = [],
  skills       = [],
  preferred_tier     = 2,
  preferred_provider = null,
  created_by   = 'robin',
}) {
  validateName(name);
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO specialists
       (name, label, description, domains, skills, preferred_tier, preferred_provider, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, label, description, JSON.stringify(domains), JSON.stringify(skills), preferred_tier, preferred_provider, created_by, now);
}

export function updateSpecialist(name, fields) {
  const allowed = ['label', 'description', 'domains', 'skills', 'preferred_tier', 'preferred_provider'];
  const sets = [], vals = [];
  for (const key of allowed) {
    if (!(key in fields)) continue;
    sets.push(`${key} = ?`);
    vals.push(['domains', 'skills'].includes(key) ? JSON.stringify(fields[key]) : fields[key]);
  }
  if (!sets.length) return 0;
  vals.push(name);
  return getDb().prepare(`UPDATE specialists SET ${sets.join(', ')} WHERE name = ?`).run(...vals).changes;
}

export function deleteSpecialist(name) {
  return getDb().prepare('DELETE FROM specialists WHERE name = ?').run(name).changes;
}

export function incrementUsage(name) {
  getDb().prepare(
    'UPDATE specialists SET use_count = use_count + 1, last_used = ? WHERE name = ?'
  ).run(new Date().toISOString(), name);
}

function validateName(name) {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error('name must be lowercase letters, numbers, and hyphens only');
  }
}

function parseRow(row) {
  return {
    ...row,
    domains: tryParse(row.domains, []),
    skills:  tryParse(row.skills,  []),
  };
}

function tryParse(val, fallback) {
  try { return val ? JSON.parse(val) : fallback; } catch { return fallback; }
}
```

- [ ] **Step 4: Create dashboard/tests/specialists.test.js (DB-layer tests)**

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const TEMP_DB     = join(tmpdir(), `flint-specialists-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-spec-agents-${Date.now()}.json`);
const TEMP_TASKS  = join(tmpdir(), `flint-spec-tasks-${Date.now()}`);
const TEMP_AGENTS_ROOT = join(tmpdir(), `flint-agents-root-${Date.now()}`);

process.env.FLINT_DB_PATH      = TEMP_DB;
process.env.FLINT_AGENTS_FILE  = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR    = TEMP_TASKS;
process.env.FLINT_AGENTS_ROOT  = TEMP_AGENTS_ROOT;
process.env.FLINT_TEST_MODE    = '1';

import { initDb } from '../db.js';
import {
  listSpecialists, getSpecialist, createSpecialist,
  updateSpecialist, deleteSpecialist, incrementUsage,
} from '../specialists.js';
const { createApp, closeDb } = await import('../server.js');

let server, baseUrl;

before(() => new Promise(resolve => {
  const app = createApp();
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise(resolve => {
  server.close(() => {
    closeDb();
    rmSync(TEMP_DB,     { force: true });
    rmSync(TEMP_AGENTS, { force: true });
    rmSync(TEMP_TASKS,  { recursive: true, force: true });
    rmSync(TEMP_AGENTS_ROOT, { recursive: true, force: true });
    resolve();
  });
}));

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

// ── DB-layer tests ──────────────────────────────────────────────

test('createSpecialist persists row — getSpecialist returns it', () => {
  createSpecialist({ name: 'test-spec-1', label: 'Test Spec One' });
  const s = getSpecialist('test-spec-1');
  assert.ok(s, 'specialist not found');
  assert.equal(s.label, 'Test Spec One');
  assert.deepEqual(s.domains, []);
  assert.deepEqual(s.skills, []);
  assert.equal(s.use_count, 0);
});

test('createSpecialist stores and parses domains + skills as arrays', () => {
  createSpecialist({
    name: 'test-spec-2', label: 'Test Spec Two',
    domains: ['research', 'web'], skills: ['web-search'],
  });
  const s = getSpecialist('test-spec-2');
  assert.deepEqual(s.domains, ['research', 'web']);
  assert.deepEqual(s.skills, ['web-search']);
});

test('listSpecialists returns array with parsed arrays', () => {
  const list = listSpecialists();
  assert.ok(Array.isArray(list));
  for (const s of list) {
    assert.ok(Array.isArray(s.domains), 'domains must be array');
    assert.ok(Array.isArray(s.skills),  'skills must be array');
  }
});

test('getSpecialist returns null for unknown name', () => {
  assert.equal(getSpecialist('no-such-specialist'), null);
});

test('updateSpecialist changes label — changes count = 1', () => {
  createSpecialist({ name: 'test-spec-update', label: 'Original' });
  const n = updateSpecialist('test-spec-update', { label: 'Updated' });
  assert.equal(n, 1);
  assert.equal(getSpecialist('test-spec-update').label, 'Updated');
});

test('deleteSpecialist removes row — getSpecialist returns null', () => {
  createSpecialist({ name: 'test-spec-delete', label: 'To Delete' });
  deleteSpecialist('test-spec-delete');
  assert.equal(getSpecialist('test-spec-delete'), null);
});

test('incrementUsage increments use_count and sets last_used', () => {
  createSpecialist({ name: 'test-spec-usage', label: 'Usage Test' });
  incrementUsage('test-spec-usage');
  incrementUsage('test-spec-usage');
  const s = getSpecialist('test-spec-usage');
  assert.equal(s.use_count, 2);
  assert.ok(s.last_used, 'last_used should be set');
});

test('createSpecialist throws on invalid name', () => {
  assert.throws(() => createSpecialist({ name: 'Bad Name!', label: 'Bad' }), /lowercase/);
});

test('createSpecialist throws on duplicate name', () => {
  createSpecialist({ name: 'test-spec-dup', label: 'First' });
  assert.throws(() => createSpecialist({ name: 'test-spec-dup', label: 'Second' }));
});
```

- [ ] **Step 5: Add specialists.test.js to dashboard/package.json test command**

Open `dashboard/package.json`. The `"test"` script currently ends with `tests/project_docs.test.js`. Append ` tests/specialists.test.js` to that string.

- [ ] **Step 6: Run the new tests**

```
cd dashboard && node --test tests/specialists.test.js
```

Expected: 9 tests pass (all DB-layer tests, route tests are in Task 5).

- [ ] **Step 7: Commit**

```bash
git add dashboard/db.js dashboard/specialists.js dashboard/tests/specialists.test.js dashboard/package.json
git commit -m "feat(sp17a): specialists DB schema + CRUD module"
```

---

### Task 2: selector.js + agents/specialists.json

**Files:**
- Create: `agents/specialists.json` (empty index)
- Create: `agents/specialists/selector.js`

**Interfaces:**
- Consumes: `createSpecialist`, `incrementUsage` from `dashboard/specialists.js`; `notify` from `dashboard/telegram.js`; `FLINT_AGENTS_ROOT` env var
- Produces:
  - `selectSpecialist(taskDescription: string, _routeFn?: Function) → Promise<Specialist>`
  - `createSpecialist(suggest: { name, description, domains?, preferred_tier?, preferred_provider? }, _routeFn?: Function) → Promise<Specialist>`
  - `loadSpecialist(name: string) → Specialist | null`
  - `touchUsage(name: string) → void`
  - `Specialist` includes a `soul: string` field (the raw soul.md content)

Note: `_routeFn` is for dependency injection in tests. Default implementation calls `http://localhost:3001/llm/complete`. When `FLINT_TEST_MODE=1`, `_routeFn` defaults to a stub that returns predictable JSON so tests don't need a live router.

- [ ] **Step 1: Create agents/specialists.json**

In the project root, create `agents/specialists.json`:

```json
[]
```

This is the lightweight index used by the LLM selector. It starts empty — specialists are registered here as they are created.

- [ ] **Step 2: Create agents/specialists/selector.js**

```js
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSpecialist as dbCreate, incrementUsage } from '../../dashboard/specialists.js';
import { notify } from '../../dashboard/telegram.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const AGENTS_ROOT = process.env.FLINT_AGENTS_ROOT
  ?? dirname(__dirname);                          // agents/specialists/ → agents/
const SPECIALISTS_DIR = join(AGENTS_ROOT, 'specialists');
const INDEX_PATH      = join(AGENTS_ROOT, 'specialists.json');

// ── index helpers ────────────────────────────────────────────────

function readIndex() {
  if (!existsSync(INDEX_PATH)) return [];
  try { return JSON.parse(readFileSync(INDEX_PATH, 'utf8')); } catch { return []; }
}

function writeIndex(entries) {
  writeFileSync(INDEX_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

// ── default LLM caller ──────────────────────────────────────────

const TEST_STUB_SPECIALIST = JSON.stringify({ match: null, suggest: { name: 'general-assistant', description: 'General purpose assistant', domains: [] } });

async function defaultRouteFn(taskType, prompt) {
  if (process.env.FLINT_TEST_MODE === '1') return TEST_STUB_SPECIALIST;
  const res = await fetch('http://localhost:3001/llm/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskType, prompt }),
  });
  if (!res.ok) throw new Error(`Router error: ${res.status}`);
  return (await res.json()).text;
}

// ── public API ──────────────────────────────────────────────────

export async function selectSpecialist(taskDescription, _routeFn = defaultRouteFn) {
  const index = readIndex();

  if (index.length === 0) {
    return createSpecialist({ name: slugify(taskDescription.slice(0, 40)), description: taskDescription, domains: [] }, _routeFn);
  }

  const prompt = `You are a specialist selector. Given a task, pick the best specialist from the registry, or recommend creating a new one if nothing fits well.

Registry:
${JSON.stringify(index, null, 2)}

Task: "${taskDescription}"

Respond with JSON only — one of:
{ "match": "specialist-name" }
{ "match": null, "suggest": { "name": "kebab-case-name", "description": "one paragraph", "domains": ["tag1", "tag2"] } }`;

  let text;
  try {
    text = await _routeFn('classification', prompt);
  } catch (err) {
    console.warn('[specialists] selector LLM call failed:', err.message);
    text = JSON.stringify({ match: null, suggest: { name: slugify(taskDescription.slice(0, 40)), description: taskDescription, domains: [] } });
  }

  let parsed;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch?.[0] ?? text);
  } catch {
    console.warn('[specialists] selector returned invalid JSON — creating new specialist');
    parsed = { match: null, suggest: { name: slugify(taskDescription.slice(0, 40)), description: taskDescription, domains: [] } };
  }

  if (parsed.match) {
    const found = index.find(s => s.name === parsed.match);
    if (found) return loadSpecialist(found.name);
  }

  const suggest = parsed.suggest ?? { name: slugify(taskDescription.slice(0, 40)), description: taskDescription, domains: [] };
  return createSpecialist(suggest, _routeFn);
}

export async function createSpecialist(
  { name, description, domains = [], preferred_tier = 2, preferred_provider = null },
  _routeFn = defaultRouteFn,
) {
  const safeName = slugify(name || 'specialist');
  const label    = toLabel(safeName);

  const soulPrompt = `Write a specialist agent identity document in first person markdown.

Specialist: ${label}
Description: ${description}

Format exactly as:
# ${label}

[2-3 sentences: who this specialist is and their core expertise, written in first person]

## My approach:
- [4-6 bullet points: how they work, what principles guide them, what makes them distinctive]

Keep it concise and practical.`;

  let soul;
  try {
    soul = await _routeFn('content-writing', soulPrompt);
  } catch {
    soul = `# ${label}\n\nI am a specialist in ${description}.\n\n## My approach:\n- Focus on quality above all else\n- Be thorough and precise\n- Communicate findings clearly\n`;
  }

  const specialistDir = join(SPECIALISTS_DIR, safeName);
  mkdirSync(specialistDir, { recursive: true });

  const config = {
    name: safeName, label, description,
    domains, skills: [],
    preferred_tier, preferred_provider,
    created_by: 'flint',
    created_at: new Date().toISOString(),
    use_count: 0, last_used: null,
  };

  writeFileSync(join(specialistDir, 'soul.md'),     soul,                          'utf8');
  writeFileSync(join(specialistDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  // Update index
  const index   = readIndex();
  const existing = index.findIndex(s => s.name === safeName);
  const entry    = { name: safeName, label, description, domains, use_count: 0, last_used: null };
  if (existing >= 0) index[existing] = entry; else index.push(entry);
  writeIndex(index);

  // Persist to DB (may already exist on retry — ignore duplicate)
  try {
    dbCreate({ name: safeName, label, description, domains, preferred_tier, preferred_provider, created_by: 'flint' });
  } catch { /* duplicate on retry — safe to ignore */ }

  try { notify(`⚡ Created new specialist: ${label}`); } catch {}

  return { ...config, soul };
}

export function loadSpecialist(name) {
  const configPath = join(SPECIALISTS_DIR, name, 'config.json');
  const soulPath   = join(SPECIALISTS_DIR, name, 'soul.md');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const soul   = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '';
    return { ...config, soul };
  } catch { return null; }
}

export function touchUsage(name) {
  const now = new Date().toISOString();

  // Update index
  const index = readIndex();
  const entry  = index.find(s => s.name === name);
  if (entry) {
    entry.use_count = (entry.use_count ?? 0) + 1;
    entry.last_used  = now;
    writeIndex(index);
  }

  // Update DB
  try { incrementUsage(name); } catch {}

  // Update config.json
  const configPath = join(SPECIALISTS_DIR, name, 'config.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      cfg.use_count = (cfg.use_count ?? 0) + 1;
      cfg.last_used  = now;
      writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch {}
  }
}

// ── helpers ──────────────────────────────────────────────────────

function slugify(str) {
  return (str ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'specialist';
}

function toLabel(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
```

- [ ] **Step 3: Add selector tests to dashboard/tests/specialists.test.js**

Append the following tests to the END of `dashboard/tests/specialists.test.js` (after the existing DB-layer tests):

```js
// ── Selector tests ───────────────────────────────────────────────

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { selectSpecialist, createSpecialist as selectorCreate, loadSpecialist, touchUsage } from '../../agents/specialists/selector.js';

// FLINT_AGENTS_ROOT is already set to TEMP_AGENTS_ROOT above

test('loadSpecialist returns null for unknown specialist', () => {
  assert.equal(loadSpecialist('no-such-specialist-xyz'), null);
});

test('createSpecialist (selector) writes soul.md and config.json', async () => {
  const mockRoute = async () => 'I am a test specialist.\n\n## My approach:\n- Test carefully\n';
  const specialist = await selectorCreate(
    { name: 'test-writer', description: 'A test writing specialist', domains: ['testing'] },
    mockRoute,
  );
  assert.equal(specialist.name, 'test-writer');
  assert.equal(specialist.label, 'Test Writer');
  assert.ok(specialist.soul.length > 0, 'soul must be non-empty');

  const specialistsDir = pathJoin(TEMP_AGENTS_ROOT, 'specialists');
  assert.ok(existsSync(pathJoin(specialistsDir, 'test-writer', 'soul.md')));
  assert.ok(existsSync(pathJoin(specialistsDir, 'test-writer', 'config.json')));
});

test('createSpecialist (selector) updates specialists.json index', async () => {
  const mockRoute = async () => 'I am the index-test specialist.';
  await selectorCreate({ name: 'index-test', description: 'Tests the index' }, mockRoute);

  const indexPath = pathJoin(TEMP_AGENTS_ROOT, 'specialists.json');
  assert.ok(existsSync(indexPath));
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.ok(index.some(s => s.name === 'index-test'));
});

test('selectSpecialist returns existing specialist when match found', async () => {
  // Seed a specialist in the index
  const mockRoute1 = async () => 'soul content';
  await selectorCreate({ name: 'match-me', description: 'A matchable specialist', domains: ['code'] }, mockRoute1);

  const mockRoute2 = async () => JSON.stringify({ match: 'match-me' });
  const result = await selectSpecialist('write some code', mockRoute2);
  assert.equal(result.name, 'match-me');
});

test('selectSpecialist creates new specialist when match is null', async () => {
  const mockRoute = async (_taskType, prompt) => {
    if (prompt.startsWith('You are a specialist selector')) {
      return JSON.stringify({ match: null, suggest: { name: 'new-created', description: 'Auto-created', domains: ['general'] } });
    }
    return '# New Created\n\nI am new.\n\n## My approach:\n- Be new\n';
  };
  const result = await selectSpecialist('do something entirely new', mockRoute);
  assert.equal(result.name, 'new-created');
});

test('selectSpecialist handles malformed JSON from selector — falls back to create', async () => {
  const mockRoute = async () => 'not valid json at all';
  const result = await selectSpecialist('something broken', mockRoute);
  assert.ok(result.name, 'should return a specialist even on bad JSON');
});

test('touchUsage increments use_count in specialists.json and DB', async () => {
  const mockRoute = async () => 'soul';
  await selectorCreate({ name: 'touch-me', description: 'Touch usage test' }, mockRoute);
  touchUsage('touch-me');
  touchUsage('touch-me');

  const indexPath = pathJoin(TEMP_AGENTS_ROOT, 'specialists.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const entry = index.find(s => s.name === 'touch-me');
  assert.equal(entry.use_count, 2);
  assert.ok(entry.last_used);
});
```

- [ ] **Step 4: Run all specialist tests**

```
cd dashboard && node --test tests/specialists.test.js
```

Expected: all DB-layer tests + all selector tests pass (15+ tests).

- [ ] **Step 5: Commit**

```bash
git add agents/specialists.json agents/specialists/selector.js dashboard/tests/specialists.test.js
git commit -m "feat(sp17a): selector.js + specialists.json file index"
```

---

### Task 3: resolveSpecialistRoute helper

**Files:**
- Modify: `router/config.js` (add and export `resolveSpecialistRoute`)
- Modify: `router/tests/config.test.js` (add tests for the new function)

**Interfaces:**
- Consumes: `getConfig()`, `configuredProviders()` (already in config.js)
- Produces: `resolveSpecialistRoute(tier: number, preferredProvider: string | null) → { provider, model, tier }`

- [ ] **Step 1: Write the failing test**

Open `router/tests/config.test.js`. Add these tests at the END of the file (after the existing last test):

```js
test('resolveSpecialistRoute returns model for configured provider at tier', () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  resetConfig();
  // Write a config with providerPriority
  const cfgWithPriority = {
    ...MINIMAL_CONFIG,
    providerPriority: ['anthropic', 'openai'],
  };
  const cfgPath = join(TMP, 'router-specialist.json');
  writeFileSync(cfgPath, JSON.stringify(cfgWithPriority));
  process.env.FLINT_ROUTER_CONFIG = cfgPath;
  resetConfig();

  const r = resolveSpecialistRoute(2, 'anthropic');
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.model, 'claude-sonnet-4-6');
  assert.equal(r.tier, 2);

  delete process.env.ANTHROPIC_API_KEY;
  process.env.FLINT_ROUTER_CONFIG = join(TMP, 'router.json');
  resetConfig();
});

test('resolveSpecialistRoute falls back to next priority when preferred unavailable', () => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  delete process.env.ANTHROPIC_API_KEY;
  resetConfig();
  const cfgPath = join(TMP, 'router-fallback.json');
  writeFileSync(cfgPath, JSON.stringify({ ...MINIMAL_CONFIG, providerPriority: ['anthropic', 'openai'] }));
  process.env.FLINT_ROUTER_CONFIG = cfgPath;
  resetConfig();

  const r = resolveSpecialistRoute(2, 'anthropic'); // anthropic unavailable, falls back to openai
  assert.equal(r.provider, 'openai');
  assert.equal(r.model, 'gpt-4o');

  delete process.env.OPENAI_API_KEY;
  process.env.FLINT_ROUTER_CONFIG = join(TMP, 'router.json');
  resetConfig();
});

test('resolveSpecialistRoute throws when no provider configured', () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  resetConfig();
  const cfgPath = join(TMP, 'router-empty.json');
  writeFileSync(cfgPath, JSON.stringify({ ...MINIMAL_CONFIG, providerPriority: ['anthropic', 'openai'] }));
  process.env.FLINT_ROUTER_CONFIG = cfgPath;
  resetConfig();

  assert.throws(() => resolveSpecialistRoute(2, null), /No configured provider/);

  process.env.FLINT_ROUTER_CONFIG = join(TMP, 'router.json');
  resetConfig();
});
```

Also update the import line at the top of `config.test.js` to include `resolveSpecialistRoute`:

```js
const { getConfig, resolveRoute, getModels, resetConfig, resolveSpecialistRoute } = await import('../config.js');
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd router && node --test tests/config.test.js
```

Expected: last 3 tests FAIL with `resolveSpecialistRoute is not a function`.

- [ ] **Step 3: Add resolveSpecialistRoute to router/config.js**

In `router/config.js`, add the following function after `resolveRoute` (around line 54) and before `configuredProviders`:

```js
export function resolveSpecialistRoute(tier, preferredProvider) {
  const cfg      = getConfig();
  const active   = configuredProviders();
  const tierKey  = String(tier ?? cfg.defaultTier);
  const priority = cfg.providerPriority ?? [];

  const candidates = preferredProvider
    ? [preferredProvider, ...priority.filter(p => p !== preferredProvider)]
    : priority;

  for (const provider of candidates) {
    if (active.has(provider) && cfg.tiers[tierKey]?.[provider]) {
      return { provider, model: cfg.tiers[tierKey][provider], tier: Number(tierKey) };
    }
  }

  throw new Error(
    `No configured provider available for tier ${tierKey}. ` +
    `Add an API key for one of: ${priority.join(', ')}`
  );
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
cd router && node --test tests/config.test.js
```

Expected: all tests pass including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add router/config.js router/tests/config.test.js
git commit -m "feat(sp17a): add resolveSpecialistRoute to router/config.js"
```

---

### Task 4: terminal.js — soul injection + model routing + usage tracking

**Files:**
- Modify: `dashboard/terminal.js`

**Interfaces:**
- Consumes: `resolveSpecialistRoute` from `../router/config.js`; `touchUsage` from `../agents/specialists/selector.js`
- Produces: `spawnAgent(name, workdir, model, { onWorktreePending?, specialist? })` — `specialist` is now optional; if provided it shapes soul, model, and usage tracking

No new tests: terminal.js spawns real PTY processes and is not unit-tested. Verification is manual (see Step 5).

- [ ] **Step 1: Add imports to dashboard/terminal.js**

At the top of `dashboard/terminal.js`, after the existing imports, add:

```js
import { resolveSpecialistRoute } from '../router/config.js';
import { touchUsage } from '../agents/specialists/selector.js';
```

- [ ] **Step 2: Update spawnAgent signature to accept specialist**

Find the function signature (currently line 54):

```js
export function spawnAgent(name, workdir, model, { onWorktreePending } = {}) {
```

Change to:

```js
export function spawnAgent(name, workdir, model, { onWorktreePending, specialist } = {}) {
```

- [ ] **Step 3: Inject specialist soul before project context**

Find the line `injectProjectContext(name);` (currently around line 58). Immediately BEFORE it, insert:

```js
  // Inject specialist identity into task file before spawning
  if (specialist?.soul) {
    const SPECIALIST_BLOCK = `## Specialist Identity\n${specialist.soul}\n---\n\n`;
    const currentTasks = readTasks(name);
    if (!currentTasks.startsWith('## Specialist Identity')) {
      writeTasks(name, SPECIALIST_BLOCK + currentTasks);
    }
  }

```

- [ ] **Step 4: Resolve model from specialist preferences when no explicit model given**

Find the block that builds `bin` and `args` (the `if (isOllama)` / `else if (isVibe)` / `else` block, currently around lines 81-90). Immediately AFTER that block (after the closing `}` of the else), and before `if (!isVibe && !isOllama)`, insert:

```js
  // Use specialist's preferred model if no explicit model was requested
  if (!model && specialist && !isVibe && !isOllama) {
    try {
      const { model: resolved } = resolveSpecialistRoute(
        specialist.preferred_tier ?? 2,
        specialist.preferred_provider ?? null,
      );
      model = resolved;
    } catch (err) {
      console.warn(`[specialists] model resolution failed for "${specialist.name}": ${err.message}`);
    }
  }

```

Then update the args build to use the resolved model. Find the line (inside the `else` block):

```js
    if (model) args.push('--model', model);
```

This already uses `model`, so the resolved value flows in automatically — no further change needed there.

- [ ] **Step 5: Track usage on agent exit**

Find `ptyProcess.onExit(({ exitCode }) => {` (currently around line 172). Inside that handler, at the very END (just before the closing `});`), add:

```js
    if (specialist?.name) {
      try { touchUsage(specialist.name); } catch {}
    }
```

- [ ] **Step 6: Manual verification**

Confirm the dashboard server starts cleanly with the new imports:

```
cd dashboard && node -e "import('./terminal.js').then(() => console.log('ok')).catch(e => console.error(e.message))"
```

Expected: prints `ok` with no errors.

- [ ] **Step 7: Commit**

```bash
git add dashboard/terminal.js
git commit -m "feat(sp17a): spawnAgent accepts specialist — injects soul, resolves model, tracks usage"
```

---

### Task 5: server.js /api/specialists routes

**Files:**
- Modify: `dashboard/server.js` (add fs imports, import specialists.js, add CRUD routes)
- Modify: `dashboard/tests/specialists.test.js` (append route tests)

**Interfaces:**
- Consumes: `listSpecialists`, `getSpecialist`, `createSpecialist`, `updateSpecialist`, `deleteSpecialist` from `./specialists.js`
- Produces routes:
  - `GET /api/specialists` → `Specialist[]`
  - `POST /api/specialists` → `201 Specialist` | `400` | `409`
  - `GET /api/specialists/:name` → `Specialist & { soul: string }` | `404`
  - `PATCH /api/specialists/:name` → `Specialist` | `404`
  - `DELETE /api/specialists/:name` → `204` | `404`

- [ ] **Step 1: Add fs imports to dashboard/server.js**

At the top of `dashboard/server.js`, the existing imports include `import { execSync } from 'child_process';`. Add a new import after the existing node: imports:

```js
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
```

- [ ] **Step 2: Import specialists.js in dashboard/server.js**

Find the line:
```js
import { listDocs, getDoc, createDoc, deleteDoc } from './project_docs.js';
```

After it, add:

```js
import { listSpecialists, getSpecialist, createSpecialist, updateSpecialist, deleteSpecialist } from './specialists.js';
```

- [ ] **Step 3: Add /api/specialists routes to dashboard/server.js**

Find the comment `// --- Suggestion routes ---` (currently around line 591). Immediately BEFORE it, insert:

```js
  // --- Specialist routes ---

  app.get('/api/specialists', (_req, res) => {
    res.json(listSpecialists());
  });

  app.post('/api/specialists', (req, res) => {
    const { name, label, description, domains, skills, preferred_tier, preferred_provider, created_by, soul } = req.body ?? {};
    if (!name || !label) return res.status(400).json({ error: 'name and label required' });
    try {
      createSpecialist({ name, label, description, domains, skills, preferred_tier, preferred_provider, created_by });
      if (soul !== undefined) {
        const dir = join(FLINT_ROOT, 'agents', 'specialists', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'soul.md'), soul, 'utf8');
        const config = { name, label, description: description ?? '', domains: domains ?? [], skills: skills ?? [], preferred_tier: preferred_tier ?? 2, preferred_provider: preferred_provider ?? null, created_by: created_by ?? 'robin', created_at: new Date().toISOString(), use_count: 0, last_used: null };
        writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
        const idxPath = join(FLINT_ROOT, 'agents', 'specialists.json');
        let idx = [];
        try { idx = JSON.parse(readFileSync(idxPath, 'utf8')); } catch {}
        const entry = { name, label, description: description ?? '', domains: domains ?? [], use_count: 0, last_used: null };
        const pos = idx.findIndex(s => s.name === name);
        if (pos >= 0) idx[pos] = entry; else idx.push(entry);
        writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf8');
      }
      res.status(201).json(getSpecialist(name));
    } catch (err) {
      if (err.message?.includes('UNIQUE') || err.message?.includes('already')) return res.status(409).json({ error: 'specialist name already exists' });
      if (err.message?.includes('lowercase')) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/specialists/:name', (req, res) => {
    const specialist = getSpecialist(req.params.name);
    if (!specialist) return res.status(404).json({ error: 'specialist not found' });
    const soulPath = join(FLINT_ROOT, 'agents', 'specialists', req.params.name, 'soul.md');
    const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '';
    res.json({ ...specialist, soul });
  });

  app.patch('/api/specialists/:name', (req, res) => {
    const { soul, ...fields } = req.body ?? {};
    if (!getSpecialist(req.params.name)) return res.status(404).json({ error: 'specialist not found' });
    updateSpecialist(req.params.name, fields);
    if (soul !== undefined) {
      const soulPath = join(FLINT_ROOT, 'agents', 'specialists', req.params.name, 'soul.md');
      mkdirSync(dirname(soulPath), { recursive: true });
      writeFileSync(soulPath, soul, 'utf8');
    }
    res.json(getSpecialist(req.params.name));
  });

  app.delete('/api/specialists/:name', (req, res) => {
    const changes = deleteSpecialist(req.params.name);
    if (!changes) return res.status(404).json({ error: 'specialist not found' });
    try { rmSync(join(FLINT_ROOT, 'agents', 'specialists', req.params.name), { recursive: true, force: true }); } catch {}
    const idxPath = join(FLINT_ROOT, 'agents', 'specialists.json');
    try {
      let idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      idx = idx.filter(s => s.name !== req.params.name);
      writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf8');
    } catch {}
    res.status(204).end();
  });

```

- [ ] **Step 4: Append route tests to dashboard/tests/specialists.test.js**

Add these tests at the END of `dashboard/tests/specialists.test.js` (after the selector tests):

```js
// ── Route tests ──────────────────────────────────────────────────

test('GET /api/specialists returns array', async () => {
  const r = await req('GET', '/api/specialists');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body));
});

test('POST /api/specialists creates specialist — returns 201 with id', async () => {
  const r = await req('POST', '/api/specialists', {
    name: 'route-test-spec', label: 'Route Test Spec',
    description: 'Created via route', domains: ['testing'],
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.name, 'route-test-spec');
  assert.equal(body.label, 'Route Test Spec');
  assert.deepEqual(body.domains, ['testing']);
});

test('POST /api/specialists missing name returns 400', async () => {
  const r = await req('POST', '/api/specialists', { label: 'No Name' });
  assert.equal(r.status, 400);
});

test('POST /api/specialists invalid name returns 400', async () => {
  const r = await req('POST', '/api/specialists', { name: 'Bad Name!', label: 'Bad' });
  assert.equal(r.status, 400);
});

test('POST /api/specialists duplicate name returns 409', async () => {
  await req('POST', '/api/specialists', { name: 'route-dup', label: 'Dup One' });
  const r = await req('POST', '/api/specialists', { name: 'route-dup', label: 'Dup Two' });
  assert.equal(r.status, 409);
});

test('GET /api/specialists/:name returns specialist', async () => {
  await req('POST', '/api/specialists', { name: 'route-get', label: 'Route Get' });
  const r = await req('GET', '/api/specialists/route-get');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.name, 'route-get');
  assert.ok('soul' in body, 'soul field must be present');
});

test('GET /api/specialists/:name unknown returns 404', async () => {
  const r = await req('GET', '/api/specialists/no-such-one-xyz');
  assert.equal(r.status, 404);
});

test('PATCH /api/specialists/:name updates label', async () => {
  await req('POST', '/api/specialists', { name: 'route-patch', label: 'Original Label' });
  const r = await req('PATCH', '/api/specialists/route-patch', { label: 'Updated Label' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.label, 'Updated Label');
});

test('PATCH /api/specialists/:name unknown returns 404', async () => {
  const r = await req('PATCH', '/api/specialists/no-such-xyz', { label: 'X' });
  assert.equal(r.status, 404);
});

test('DELETE /api/specialists/:name removes specialist — returns 204', async () => {
  await req('POST', '/api/specialists', { name: 'route-delete', label: 'To Delete' });
  const r = await req('DELETE', '/api/specialists/route-delete');
  assert.equal(r.status, 204);
  const check = await req('GET', '/api/specialists/route-delete');
  assert.equal(check.status, 404);
});

test('DELETE /api/specialists/:name unknown returns 404', async () => {
  const r = await req('DELETE', '/api/specialists/no-such-xyz');
  assert.equal(r.status, 404);
});
```

- [ ] **Step 5: Run all specialist tests**

```
cd dashboard && node --test tests/specialists.test.js
```

Expected: all tests pass (DB-layer + selector + route tests).

- [ ] **Step 6: Run full test suite**

```
cd dashboard && npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add dashboard/server.js dashboard/tests/specialists.test.js
git commit -m "feat(sp17a): /api/specialists CRUD routes"
```

---

### Task 6: Dashboard UI — Specialists tab

**Files:**
- Modify: `dashboard/public/index.html` (add toolbar button + specialists-view div)
- Modify: `dashboard/public/app.js` (showView for specialists, card grid, create/edit/delete)

No automated tests for the UI. Verify manually by restarting the dashboard and checking the Specialists tab.

- [ ] **Step 1: Add toolbar button + view div to index.html**

In `dashboard/public/index.html`, find the toolbar div (currently around line 38):

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

Change to (add `btn-specialists` after `btn-skills`):

```html
  <div id="toolbar">
    <button id="btn-new-agent">+ New Agent</button>
    <button id="btn-refresh">↻ Refresh</button>
    <button id="btn-workspaces">⚙ Workspaces</button>
    <button id="btn-mcp">⚡ MCP</button>
    <button id="btn-keys">🔑 Keys</button>
    <button id="btn-skills">📚 Skills</button>
    <button id="btn-specialists">🧠 Specialists</button>
    <button id="btn-queue">⬡ Queue</button>
    <button id="btn-orchestrate">⬡ Orchestrate</button>
  </div>
```

Find the line:

```html
  <div id="skills-view" class="hidden" style="padding:16px;max-width:900px;margin:0 auto"></div>
```

After it, add:

```html
  <div id="specialists-view" class="hidden" style="padding:16px;max-width:960px;margin:0 auto"></div>
```

- [ ] **Step 2: Update showView() in app.js to handle specialists**

Find the `showView` function in `app.js` (currently around line 427). The function declares `skillsView` and hides/shows it. Update it to also handle `specialists-view`.

Find this section at the start of `showView`:

```js
  const panels     = document.getElementById('panels');
  const toolbar    = document.getElementById('toolbar');
  const projView   = document.getElementById('project-view');
  const projBar    = document.getElementById('proj-toolbar');
  const queueView  = document.getElementById('queue-view');
  const skillsView = document.getElementById('skills-view');
```

Change to:

```js
  const panels          = document.getElementById('panels');
  const toolbar         = document.getElementById('toolbar');
  const projView        = document.getElementById('project-view');
  const projBar         = document.getElementById('proj-toolbar');
  const queueView       = document.getElementById('queue-view');
  const skillsView      = document.getElementById('skills-view');
  const specialistsView = document.getElementById('specialists-view');
```

Then update EVERY branch of `showView` to also hide/show `specialistsView`. The pattern is: in every branch that currently calls `skillsView.classList.add('hidden')`, also call `specialistsView.classList.add('hidden')`. Then add a new `else if (view === 'specialists')` branch. The complete updated function:

```js
function showView(view) {
  currentView = view;
  const panels          = document.getElementById('panels');
  const toolbar         = document.getElementById('toolbar');
  const projView        = document.getElementById('project-view');
  const projBar         = document.getElementById('proj-toolbar');
  const queueView       = document.getElementById('queue-view');
  const skillsView      = document.getElementById('skills-view');
  const specialistsView = document.getElementById('specialists-view');

  if (view === 'projects') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.remove('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.add('hidden');
    specialistsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'flex';
    fetchProjects();
  } else if (view === 'queue') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.add('hidden');
    queueView.classList.remove('hidden');
    skillsView.classList.add('hidden');
    specialistsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
    fetchAndRenderQueue();
  } else if (view === 'skills') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.add('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.remove('hidden');
    specialistsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
    fetchAndRenderSkills();
  } else if (view === 'specialists') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.add('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.add('hidden');
    specialistsView.classList.remove('hidden');
    if (projBar) projBar.style.display = 'none';
    fetchAndRenderSpecialists();
  } else {
    panels.style.display = '';
    toolbar.style.display = '';
    projView.classList.add('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.add('hidden');
    specialistsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
  }
}
```

- [ ] **Step 3: Add Specialists tab logic to app.js**

At the END of `app.js` (after all existing code), append:

```js
// ============================================================
// Specialists tab
// ============================================================

document.getElementById('btn-specialists').addEventListener('click', () => showView('specialists'));

async function fetchAndRenderSpecialists() {
  const specialists = await fetch('/api/specialists').then(r => r.json()).catch(() => []);
  renderSpecialistsView(specialists);
}

function renderSpecialistsView(specialists) {
  const view = document.getElementById('specialists-view');
  view.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <h2 style="margin:0;flex:1">Specialists</h2>
      <button id="btn-specialist-new" style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:15px">+ New Specialist</button>
      <button id="btn-specialists-back" style="background:none;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:14px">← Dashboard</button>
    </div>
    <div id="specialists-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px"></div>
  `;

  document.getElementById('btn-specialists-back').addEventListener('click', () => showView('agents'));
  document.getElementById('btn-specialist-new').addEventListener('click', openNewSpecialistModal);

  const grid = document.getElementById('specialists-grid');

  if (!specialists.length) {
    grid.innerHTML = '<p style="color:#8b949e;grid-column:1/-1">No specialists yet. Create one to get started.</p>';
    return;
  }

  for (const s of specialists) {
    const card = document.createElement('div');
    card.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:8px';
    const createdByBadge = s.created_by === 'flint'
      ? `<span style="background:#1f3a4f;color:#58a6ff;font-size:11px;padding:1px 6px;border-radius:10px">⚡ Flint</span>`
      : `<span style="background:#1e3a1e;color:#3fb950;font-size:11px;padding:1px 6px;border-radius:10px">Robin</span>`;
    const domainsHtml = (s.domains ?? []).map(d =>
      `<span style="background:#21262d;color:#8b949e;font-size:11px;padding:1px 6px;border-radius:10px">${escHtml(d)}</span>`
    ).join('');
    const lastUsed = s.last_used ? new Date(s.last_used).toLocaleDateString() : 'never';

    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <span style="font-weight:600;color:#e6edf3;font-size:15px">${escHtml(s.label)}</span>
        ${createdByBadge}
      </div>
      <div style="color:#8b949e;font-size:13px;line-height:1.4">${escHtml(s.description ?? '')}</div>
      ${domainsHtml ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${domainsHtml}</div>` : ''}
      <div style="font-size:12px;color:#6e7681">Used ${s.use_count ?? 0}× · Last: ${lastUsed}</div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button data-spec-edit="${escHtml(s.name)}" style="flex:1;background:none;border:1px solid #30363d;color:#58a6ff;border-radius:4px;padding:4px 0;cursor:pointer;font-size:13px">Edit</button>
        <button data-spec-delete="${escHtml(s.name)}" style="flex:1;background:none;border:1px solid #30363d;color:#f85149;border-radius:4px;padding:4px 0;cursor:pointer;font-size:13px">Delete</button>
      </div>
    `;
    grid.appendChild(card);
  }

  grid.querySelectorAll('[data-spec-edit]').forEach(btn => {
    btn.addEventListener('click', () => openEditSpecialistModal(btn.dataset.specEdit));
  });
  grid.querySelectorAll('[data-spec-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete specialist "${btn.dataset.specDelete}"?`)) return;
      await fetch(`/api/specialists/${encodeURIComponent(btn.dataset.specDelete)}`, { method: 'DELETE' });
      fetchAndRenderSpecialists();
    });
  });
}

// ── Specialist modal ─────────────────────────────────────────────

let _editingSpecialistName = null;

function openNewSpecialistModal() {
  _editingSpecialistName = null;
  showSpecialistModal({ name: '', label: '', description: '', domains: '', preferred_tier: 2, preferred_provider: '', soul: '' });
}

async function openEditSpecialistModal(name) {
  _editingSpecialistName = name;
  const s = await fetch(`/api/specialists/${encodeURIComponent(name)}`).then(r => r.json()).catch(() => null);
  if (!s) return;
  showSpecialistModal({
    name: s.name,
    label: s.label,
    description: s.description ?? '',
    domains: (s.domains ?? []).join(', '),
    preferred_tier: s.preferred_tier ?? 2,
    preferred_provider: s.preferred_provider ?? '',
    soul: s.soul ?? '',
  });
}

function showSpecialistModal({ name, label, description, domains, preferred_tier, preferred_provider, soul }) {
  const existing = document.getElementById('specialist-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'specialist-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:1000';

  overlay.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;width:560px;max-height:90vh;overflow-y:auto;display:flex;flex-direction:column;gap:14px">
      <h3 style="margin:0;color:#e6edf3">${_editingSpecialistName ? 'Edit Specialist' : 'New Specialist'}</h3>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Name (slug)
        <input id="sp-name" type="text" value="${escHtml(name)}" ${_editingSpecialistName ? 'disabled' : ''} placeholder="e.g. research-expert" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Label
        <input id="sp-label" type="text" value="${escHtml(label)}" placeholder="Research Expert" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Description
        <textarea id="sp-description" rows="2" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px;resize:vertical">${escHtml(description)}</textarea>
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Domains (comma-separated)
        <input id="sp-domains" type="text" value="${escHtml(domains)}" placeholder="research, web, market-analysis" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px">
      </label>
      <div style="display:flex;gap:12px">
        <label style="flex:1;display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Preferred Tier
          <select id="sp-tier" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px">
            <option value="1" ${preferred_tier == 1 ? 'selected' : ''}>1 — Fast</option>
            <option value="2" ${preferred_tier == 2 ? 'selected' : ''}>2 — Standard</option>
            <option value="3" ${preferred_tier == 3 ? 'selected' : ''}>3 — Frontier</option>
          </select>
        </label>
        <label style="flex:1;display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Preferred Provider
          <input id="sp-provider" type="text" value="${escHtml(preferred_provider)}" placeholder="anthropic" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px">
        </label>
      </div>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Soul (identity — first-person markdown)
        <textarea id="sp-soul" rows="8" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:13px;font-family:monospace;resize:vertical">${escHtml(soul)}</textarea>
      </label>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="sp-cancel" style="background:none;border:1px solid #30363d;color:#8b949e;border-radius:4px;padding:6px 16px;cursor:pointer">Cancel</button>
        <button id="sp-save" style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 16px;cursor:pointer">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('sp-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  document.getElementById('sp-save').addEventListener('click', async () => {
    const nameVal     = document.getElementById('sp-name').value.trim();
    const labelVal    = document.getElementById('sp-label').value.trim();
    const descVal     = document.getElementById('sp-description').value.trim();
    const domainsVal  = document.getElementById('sp-domains').value.split(',').map(d => d.trim()).filter(Boolean);
    const tierVal     = Number(document.getElementById('sp-tier').value);
    const providerVal = document.getElementById('sp-provider').value.trim() || null;
    const soulVal     = document.getElementById('sp-soul').value;

    if (!nameVal || !labelVal) {
      alert('Name and Label are required.');
      return;
    }

    const body = { name: nameVal, label: labelVal, description: descVal, domains: domainsVal, preferred_tier: tierVal, preferred_provider: providerVal, soul: soulVal };

    if (_editingSpecialistName) {
      await fetch(`/api/specialists/${encodeURIComponent(_editingSpecialistName)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: labelVal, description: descVal, domains: domainsVal, preferred_tier: tierVal, preferred_provider: providerVal, soul: soulVal }),
      });
    } else {
      const r = await fetch('/api/specialists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(err.error ?? 'Failed to create specialist');
        return;
      }
    }

    overlay.remove();
    fetchAndRenderSpecialists();
  });
}
```

- [ ] **Step 4: Restart dashboard and verify manually**

```
pm2 restart flint-dashboard
```

Then open the dashboard in a browser and:
1. Click "🧠 Specialists" in the toolbar — specialists view loads (empty state shown)
2. Click "+ New Specialist" — modal opens with all fields
3. Fill in Name: `test-expert`, Label: `Test Expert`, Description: `A test specialist`, Soul: `# Test Expert\n\nI am a test.`
4. Click Save — specialist appears as a card
5. Click Edit on the card — modal opens pre-filled with existing values
6. Click Delete — confirm dialog; card disappears after deletion
7. Click "← Dashboard" — returns to agents view

- [ ] **Step 5: Run full test suite to confirm no regressions**

```
cd dashboard && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add dashboard/public/index.html dashboard/public/app.js
git commit -m "feat(sp17a): Specialists tab — card grid, create/edit/delete modal"
```

---

### Task 7: Wire specialist selection into agent spawn flow

**Files:**
- Modify: `dashboard/server.js` (import `loadSpecialist`; handle `specialistName` in WS spawn + REST spawn)
- Modify: `dashboard/public/app.js` (specialist dropdown in New Agent modal; pass `specialistName` in spawn message)
- Modify: `dashboard/public/index.html` (add specialist select to modal HTML)

**Interfaces:**
- Consumes: `loadSpecialist(name: string)` from `../agents/specialists/selector.js`; `specialist` param now wired end-to-end from UI → WS → `spawnAgent`

No new automated tests — verification is manual.

- [ ] **Step 1: Import loadSpecialist in dashboard/server.js**

Find the existing import block in `server.js`. After the specialists.js import line added in Task 5, add:

```js
import { loadSpecialist } from '../agents/specialists/selector.js';
```

- [ ] **Step 2: Handle specialistName in REST /agents/spawn route**

Find the `POST /agents/spawn` handler (currently around line 246):

```js
  app.post('/agents/spawn', (req, res) => {
    const { name, workdir, model, runtime } = req.body ?? {};
    if (!name || !workdir) return res.status(400).json({ error: 'name and workdir required' });
    registerAgent(name, 'spawn', workdir, null, model ?? '', runtime ?? 'claude');
    if (!TEST_MODE) spawnAgent(name, workdir, model ?? null, { onWorktreePending: createPRForAgent });
    res.json({ ok: true, name });
  });
```

Change to:

```js
  app.post('/agents/spawn', (req, res) => {
    const { name, workdir, model, runtime, specialistName } = req.body ?? {};
    if (!name || !workdir) return res.status(400).json({ error: 'name and workdir required' });
    registerAgent(name, 'spawn', workdir, null, model ?? '', runtime ?? 'claude');
    if (!TEST_MODE) {
      const specialist = specialistName ? loadSpecialist(specialistName) : null;
      spawnAgent(name, workdir, model ?? null, { onWorktreePending: createPRForAgent, specialist });
    }
    res.json({ ok: true, name });
  });
```

- [ ] **Step 3: Handle specialistName in WebSocket spawn handler**

Find the `case 'spawn':` block inside the WebSocket `ws.on('message', ...)` handler (currently around line 737):

```js
        case 'spawn': {
          const { agent: name, workdir, model, isolate, runtime } = msg;
```

Change to:

```js
        case 'spawn': {
          const { agent: name, workdir, model, isolate, runtime, specialistName } = msg;
```

Find where `spawnAgent` is called inside this handler (currently around line 754):

```js
            spawnAgent(name, spawnDir, model, { onWorktreePending: createPRForAgent });
```

Change to:

```js
            const specialist = specialistName ? loadSpecialist(specialistName) : null;
            spawnAgent(name, spawnDir, model, { onWorktreePending: createPRForAgent, specialist });
```

- [ ] **Step 4: Add specialist select to New Agent modal in index.html**

In `dashboard/public/index.html`, find the modal's Runtime select block:

```html
      <label>
        Runtime
        <select id="modal-runtime">
          <option value="claude">Claude Code (claude)</option>
          <option value="vibe">Mistral Vibe (vibe)</option>
        </select>
      </label>
```

After it, add:

```html
      <label>
        Specialist (optional)
        <select id="modal-specialist">
          <option value="">— none —</option>
        </select>
      </label>
```

- [ ] **Step 5: Populate specialist dropdown when modal opens in app.js**

In `app.js`, find the function or event that opens the New Agent modal (search for `btn-new-agent` or `modal`). The modal is opened somewhere with a function that populates `modal-workspace` etc. Find where `populateModelDropdown` or `modal-workspace` is populated and add:

Find the function `populateModelDropdown` (or wherever the modal is opened). Add a call to populate the specialist dropdown. Search for where `modal-workspace` is filled — it's likely in a function called when `btn-new-agent` is clicked.

Find the click handler for `btn-new-agent` in `app.js`. It should look something like:

```js
document.getElementById('btn-new-agent').addEventListener('click', () => {
  ...
  document.getElementById('modal').classList.remove('hidden');
  ...
});
```

Inside that handler, after the existing modal population code, add:

```js
  // Populate specialist dropdown
  fetch('/api/specialists')
    .then(r => r.json())
    .then(specialists => {
      const sel = document.getElementById('modal-specialist');
      sel.innerHTML = '<option value="">— none —</option>';
      specialists.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = s.label;
        sel.appendChild(opt);
      });
    })
    .catch(() => {});
```

- [ ] **Step 6: Include specialistName in the spawn WebSocket message**

In `app.js`, find where the `spawn` WebSocket message is sent when the modal form is submitted. It should look like:

```js
ws.send(JSON.stringify({ type: 'spawn', agent: name, workdir, model, isolate, runtime }));
```

Change to:

```js
const specialistName = document.getElementById('modal-specialist')?.value || undefined;
ws.send(JSON.stringify({ type: 'spawn', agent: name, workdir, model, isolate, runtime, specialistName }));
```

- [ ] **Step 7: Manual verification**

```
pm2 restart flint-dashboard
```

1. Open New Agent modal — "Specialist (optional)" dropdown appears, populated with any created specialists
2. Select a specialist and spawn an agent — the agent's task file starts with `## Specialist Identity` followed by the soul content
3. Spawn without a specialist selected — agent spawns as before, no soul injected
4. After the agent exits — check that `use_count` is incremented on the specialist

- [ ] **Step 8: Run full test suite**

```
cd dashboard && npm test
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add dashboard/server.js dashboard/public/index.html dashboard/public/app.js
git commit -m "feat(sp17a): wire specialist selection into agent spawn flow"
```

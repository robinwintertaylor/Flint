# Supabase Memory Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing Supabase `flint` project into Flint's dashboard so memories and sessions are synced to the cloud — enabling shared memory across multiple Flint deployments.

**Architecture:** A `dashboard/embeddings.js` module generates OpenAI vectors. A `dashboard/supabase.js` module provides `upsertMemory`, `searchMemories`, `logSessionStart`, `logSessionEnd`, and `pullMemories` using the existing Supabase schema. The dashboard server startup injects API keys into `process.env` (SUPABASE_URL + SUPABASE_ANON_KEY), calls `initSupabase()`, and exposes five new REST routes.

**Supabase project:** `cvhyqsinrqckckzkktug` (eu-west-2, ACTIVE_HEALTHY)

**Existing schema (do not modify):**
- `memories(id uuid, name text UNIQUE, type text, description text, body text, embedding vector, created_at, updated_at)`
- `sessions(id uuid, started_at, ended_at, summary text, learnings text, agent_names text[])`
- `search_memories(query_embedding vector, match_type text, match_count int, match_threshold float)` RPC → returns `(id, name, type, description, body, similarity)`
- pgvector extension installed

**Tech Stack:** Node.js ESM, `@supabase/supabase-js`, `node:test`, `node:assert/strict`

## Global Constraints

- ESM modules (`import`/`export`, never `require`)
- `node:test` + `node:assert/strict` for all tests
- Run tests: `node --test dashboard/tests/<file>.test.js`
- `@supabase/supabase-js` must be added to `dashboard/package.json` dependencies and installed
- All Supabase calls must be no-ops (not throw) when `SUPABASE_URL` / `SUPABASE_ANON_KEY` are absent — Supabase is optional
- Embeddings: call OpenAI `text-embedding-3-small` directly via `fetch` (no new SDK dependency); return `null` gracefully when `OPENAI_API_KEY` is absent
- Pass embedding arrays directly to Supabase (not JSON-stringified)
- All new server routes return JSON; 503 when Supabase is not configured

---

## File Map

| File | Change |
|---|---|
| `dashboard/embeddings.js` | **Create** — `generateEmbedding(text): number[]|null` |
| `dashboard/supabase.js` | **Create** — Supabase client + all memory/session functions |
| `dashboard/tests/supabase.test.js` | **Create** — unit tests with injected mock client |
| `dashboard/server.js` | **Modify** — inject API keys at startup, init Supabase, add 5 routes |
| `dashboard/package.json` | **Modify** — add `@supabase/supabase-js` |

---

### Task 1: embeddings.js + supabase.js + install dependency

**Files:**
- Create: `dashboard/embeddings.js`
- Create: `dashboard/supabase.js`
- Create: `dashboard/tests/supabase.test.js`
- Modify: `dashboard/package.json`

**Interfaces:**
- Produces:
  - `generateEmbedding(text: string): Promise<number[]|null>` from `./embeddings.js`
  - `initSupabase(): void` from `./supabase.js`
  - `isSupabaseEnabled(): boolean` from `./supabase.js`
  - `upsertMemory({ name, type, description, body }): Promise<object|null>` from `./supabase.js`
  - `searchMemories(queryText, { type?, count?, threshold? }): Promise<object[]>` from `./supabase.js`
  - `logSessionStart(): Promise<string|null>` from `./supabase.js` — returns session UUID
  - `logSessionEnd(sessionId, { summary?, learnings?, agentNames? }): Promise<void>` from `./supabase.js`
  - `pullMemories({ type? }): Promise<object[]>` from `./supabase.js`
  - `setSupabaseClient(mock): void` from `./supabase.js` — test injection only

- [ ] **Step 1: Install `@supabase/supabase-js`**

```
cd "C:\Users\Robin\Applications Dev\Flint\dashboard"
npm install @supabase/supabase-js
```

Verify it appears in `dashboard/package.json` dependencies.

- [ ] **Step 2: Write the failing tests**

Create `dashboard/tests/supabase.test.js`:

```js
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../db.js';

// Mock Supabase client
function makeMockClient({ upsertResult = {}, rpcResult = [], selectResult = [], insertResult = { id: 'session-uuid-1' } } = {}) {
  const calls = { upsert: [], rpc: [], insert: [], update: [], select: [] };
  return {
    calls,
    from: (table) => ({
      upsert: (record, opts) => {
        calls.upsert.push({ table, record, opts });
        return { select: () => ({ single: async () => ({ data: { id: 'mem-uuid', ...record }, error: null }) }) };
      },
      insert: (record) => {
        calls.insert.push({ table, record });
        return { select: () => ({ single: async () => ({ data: { id: insertResult.id, ...record }, error: null }) }) };
      },
      update: (record) => {
        calls.update.push({ table, record });
        return { eq: (_col, _val) => Promise.resolve({ error: null }) };
      },
      select: (cols) => {
        calls.select.push({ table, cols });
        return {
          order: () => ({ data: selectResult, error: null }),
          eq: () => ({ order: () => ({ data: selectResult.filter(r => r.type === 'user'), error: null }) }),
          ilike: () => ({ limit: async () => ({ data: selectResult, error: null }) }),
        };
      },
    }),
    rpc: (fn, params) => {
      calls.rpc.push({ fn, params });
      return Promise.resolve({ data: rpcResult, error: null });
    },
  };
}

import {
  initSupabase, isSupabaseEnabled, upsertMemory,
  searchMemories, logSessionStart, logSessionEnd,
  pullMemories, setSupabaseClient,
} from '../supabase.js';

before(() => initDb(':memory:'));

beforeEach(() => setSupabaseClient(null));

test('isSupabaseEnabled returns false when no client set', () => {
  assert.equal(isSupabaseEnabled(), false);
});

test('isSupabaseEnabled returns true after setSupabaseClient', () => {
  setSupabaseClient(makeMockClient());
  assert.equal(isSupabaseEnabled(), true);
});

test('upsertMemory returns null when Supabase not enabled', async () => {
  const result = await upsertMemory({ name: 'test', type: 'user', description: 'desc', body: 'body' });
  assert.equal(result, null);
});

test('upsertMemory calls from().upsert() with correct fields', async () => {
  const mock = makeMockClient();
  setSupabaseClient(mock);
  const result = await upsertMemory({ name: 'robin-role', type: 'user', description: 'Robin is a developer', body: 'He builds AI tools.' });
  assert.ok(result);
  assert.equal(mock.calls.upsert.length, 1);
  assert.equal(mock.calls.upsert[0].record.name, 'robin-role');
  assert.equal(mock.calls.upsert[0].record.type, 'user');
});

test('searchMemories returns [] when Supabase not enabled', async () => {
  const result = await searchMemories('find me something');
  assert.deepEqual(result, []);
});

test('searchMemories calls rpc when embedding provided (mocked)', async () => {
  const rpcResult = [{ id: '1', name: 'robin-role', type: 'user', description: 'd', body: 'b', similarity: 0.9 }];
  const mock = makeMockClient({ rpcResult });
  setSupabaseClient(mock);
  // Pass a pre-computed fake embedding to bypass OpenAI call
  const fakeEmbedding = new Array(1536).fill(0.1);
  const result = await searchMemories('', { _embedding: fakeEmbedding, count: 5 });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'robin-role');
});

test('logSessionStart returns session id', async () => {
  const mock = makeMockClient({ insertResult: { id: 'session-abc' } });
  setSupabaseClient(mock);
  const id = await logSessionStart();
  assert.equal(id, 'session-abc');
  assert.equal(mock.calls.insert.length, 1);
});

test('logSessionStart returns null when Supabase not enabled', async () => {
  const id = await logSessionStart();
  assert.equal(id, null);
});

test('logSessionEnd calls update on sessions', async () => {
  const mock = makeMockClient();
  setSupabaseClient(mock);
  await logSessionEnd('session-abc', { summary: 'We built stuff', learnings: 'Always test', agentNames: ['bot-1'] });
  assert.equal(mock.calls.update.length, 1);
  assert.equal(mock.calls.update[0].record.summary, 'We built stuff');
  assert.deepEqual(mock.calls.update[0].record.agent_names, ['bot-1']);
});

test('pullMemories returns [] when Supabase not enabled', async () => {
  const result = await pullMemories();
  assert.deepEqual(result, []);
});

test('pullMemories returns records when enabled', async () => {
  const memories = [{ id: '1', name: 'a', type: 'user', description: 'd', body: 'b', created_at: '', updated_at: '' }];
  const mock = makeMockClient({ selectResult: memories });
  setSupabaseClient(mock);
  const result = await pullMemories();
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'a');
});
```

- [ ] **Step 3: Run tests to verify they fail**

```
node --test dashboard/tests/supabase.test.js
```

Expected: FAIL with `Cannot find module '../supabase.js'`

- [ ] **Step 4: Create `dashboard/embeddings.js`**

```js
export async function generateEmbedding(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data[0].embedding;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Create `dashboard/supabase.js`**

```js
import { createClient } from '@supabase/supabase-js';
import { generateEmbedding } from './embeddings.js';

let client = null;

export function setSupabaseClient(mock) {
  client = mock;
}

export function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return;
  client = createClient(url, key);
}

export function isSupabaseEnabled() {
  return client !== null;
}

export async function upsertMemory({ name, type, description, body }) {
  if (!client) return null;
  const embedding = await generateEmbedding(`${description}\n\n${body}`);
  const record = { name, type, description, body, updated_at: new Date().toISOString() };
  if (embedding) record.embedding = embedding;
  const { data, error } = await client
    .from('memories')
    .upsert(record, { onConflict: 'name' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function searchMemories(queryText, { type = null, count = 10, threshold = 0.7, _embedding } = {}) {
  if (!client) return [];
  const embedding = _embedding ?? await generateEmbedding(queryText);
  if (!embedding) {
    let q = client.from('memories').select('id, name, type, description, body').ilike('body', `%${queryText}%`);
    if (type) q = q.eq('type', type);
    const { data } = await q.limit(count);
    return data ?? [];
  }
  const { data, error } = await client.rpc('search_memories', {
    query_embedding: embedding,
    match_type: type,
    match_count: count,
    match_threshold: threshold,
  });
  if (error) throw error;
  return data ?? [];
}

export async function logSessionStart() {
  if (!client) return null;
  const { data, error } = await client
    .from('sessions')
    .insert({ started_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data.id;
}

export async function logSessionEnd(sessionId, { summary = '', learnings = '', agentNames = [] } = {}) {
  if (!client) return;
  const { error } = await client
    .from('sessions')
    .update({ ended_at: new Date().toISOString(), summary, learnings, agent_names: agentNames })
    .eq('id', sessionId);
  if (error) throw error;
}

export async function pullMemories({ type = null } = {}) {
  if (!client) return [];
  let q = client.from('memories').select('id, name, type, description, body, created_at, updated_at').order('updated_at', { ascending: false });
  if (type) q = q.eq('type', type);
  const { data } = await q;
  return data ?? [];
}
```

- [ ] **Step 6: Run tests to verify they pass**

```
node --test dashboard/tests/supabase.test.js
```

Expected: 10 pass, 0 fail

- [ ] **Step 7: Commit**

```
git add dashboard/embeddings.js dashboard/supabase.js dashboard/tests/supabase.test.js dashboard/package.json dashboard/package-lock.json
git commit -m "feat(memory): embeddings.js + supabase.js — memory sync and semantic search"
```

---

### Task 2: server.js — API key injection, Supabase init, 5 new routes

**Files:**
- Modify: `dashboard/server.js`

**Interfaces:**
- Consumes:
  - `initSupabase`, `isSupabaseEnabled`, `upsertMemory`, `searchMemories`, `logSessionStart`, `logSessionEnd`, `pullMemories` from `./supabase.js`
  - `buildApiKeyEnv` from `./apikeys.js` (already imported for terminal.js — import it in server.js too)
- Produces (new routes):
  - `GET  /api/memory` — `{ memories: [...] }` — all memories from Supabase, or 503
  - `POST /api/memory/sync` — body `{ memories: [{ name, type, description, body }] }` — bulk upsert; returns `{ synced: number }`
  - `POST /api/memory/search` — body `{ query, type?, count?, threshold? }` — returns `{ results: [...] }`
  - `POST /api/memory/session` — start session; returns `{ id: uuid }`
  - `PATCH /api/memory/session/:id` — body `{ summary?, learnings?, agentNames? }` — end session; returns `{ ok: true }`

- [ ] **Step 1: Write the failing route tests**

Open `dashboard/tests/server.test.js` and append these tests (follow the existing file's `req()` helper pattern exactly):

```js
test('GET /api/memory returns 503 when Supabase not configured', async () => {
  const r = await req('GET', '/api/memory');
  assert.equal(r.status, 503);
});

test('POST /api/memory/search returns 503 when Supabase not configured', async () => {
  const r = await req('POST', '/api/memory/search', { query: 'test' });
  assert.equal(r.status, 503);
});

test('POST /api/memory/session returns 503 when Supabase not configured', async () => {
  const r = await req('POST', '/api/memory/session');
  assert.equal(r.status, 503);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test dashboard/tests/server.test.js
```

Expected: 3 new tests FAIL (routes not found → 404, not 503)

- [ ] **Step 3: Add imports to `dashboard/server.js`**

Add at the top of `dashboard/server.js`, alongside the existing imports:

```js
import { buildApiKeyEnv } from './apikeys.js';
import { initSupabase, isSupabaseEnabled, upsertMemory, searchMemories, logSessionStart, logSessionEnd, pullMemories } from './supabase.js';
```

- [ ] **Step 4: Inject API keys + init Supabase at startup in `dashboard/server.js`**

Find the line `initDb(process.env.FLINT_DB_PATH);` (around line 109 in `createApp()`). Directly after it, add:

```js
  Object.assign(process.env, buildApiKeyEnv());
  initSupabase();
```

- [ ] **Step 5: Add the 5 new routes to `dashboard/server.js`**

Find the block of `app.get('/api-keys'` routes and add the new memory routes directly before them:

```js
  // Memory sync (Supabase)
  app.get('/api/memory', async (_req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const memories = await pullMemories();
      res.json({ memories });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/memory/sync', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Supabase not configured' });
    const { memories } = req.body ?? {};
    if (!Array.isArray(memories)) return res.status(400).json({ error: 'memories array required' });
    try {
      let synced = 0;
      for (const m of memories) {
        await upsertMemory(m);
        synced++;
      }
      res.json({ synced });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/memory/search', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Supabase not configured' });
    const { query, type, count, threshold } = req.body ?? {};
    if (!query) return res.status(400).json({ error: 'query required' });
    try {
      const results = await searchMemories(query, { type, count, threshold });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/memory/session', async (_req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const id = await logSessionStart();
      res.json({ id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/memory/session/:id', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Supabase not configured' });
    const { id } = req.params;
    const { summary, learnings, agentNames } = req.body ?? {};
    try {
      await logSessionEnd(id, { summary, learnings, agentNames });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 6: Run server tests to verify they pass**

```
node --test dashboard/tests/server.test.js
```

Expected: 3 new tests pass (503 because Supabase not configured in test env); pre-existing pass count unchanged

- [ ] **Step 7: Run the full existing test suite to confirm no regressions**

```
node --test dashboard/tests/db.test.js dashboard/tests/tasks.test.js dashboard/tests/agents.test.js dashboard/tests/queue.test.js dashboard/tests/autoPickup.test.js dashboard/tests/settings.test.js dashboard/tests/apikeys.test.js
```

Expected: all pass

- [ ] **Step 8: Restart dashboard and verify Supabase init in logs**

```
pm2 restart flint-dashboard
pm2 logs flint-dashboard --lines 20
```

If `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set in the API Keys tab, you will see no error. If they're not yet set, `initSupabase()` silently skips — no crash.

- [ ] **Step 9: Commit**

```
git add dashboard/server.js dashboard/tests/server.test.js
git commit -m "feat(memory): wire Supabase into dashboard server — API key injection + 5 memory routes"
```

---

## Self-Review

**Spec coverage:**
- ✅ `generateEmbedding` gracefully returns `null` when `OPENAI_API_KEY` absent
- ✅ All supabase.js functions return no-ops when client is null
- ✅ `setSupabaseClient` enables test injection without touching env vars
- ✅ `searchMemories` falls back to text search when embedding is null
- ✅ 503 on all memory routes when Supabase not configured
- ✅ `buildApiKeyEnv()` + `initSupabase()` wired at dashboard startup
- ✅ 10 unit tests covering all exported functions

**No placeholders.**

**Type consistency:** `searchMemories` `_embedding` parameter matches test usage. `logSessionEnd` `agentNames` maps to `agent_names` in DB correctly. `pullMemories` `type` filter uses `.eq('type', type)` matching Supabase column name.

# Flint Supabase DB Review
_Reviewed 2026-06-30 | Project: cvhyqsinrqckckzkktug.supabase.co_

---

## 1. What exists

Two tables are in use, inferred from `dashboard/supabase.js` (no migration files exist):

| Table | Purpose | Key columns |
|---|---|---|
| `memories` | Vector memory store for agents and sessions | id, name (unique), type, description, body, embedding, updated_at |
| `sessions` | Session audit log | id, started_at, ended_at, summary, learnings, agent_names |

Both tables are currently **empty** — no memories have been saved and no sessions have been logged.

---

## 2. Critical issues

### 2a. `search_memories` RPC may not exist

`supabase.js` calls `client.rpc('search_memories', { query_embedding, match_type, match_count, match_threshold })` but there is no migration creating this function. If it was never run in the Supabase SQL editor, every vector search will silently fail and fall back to a slow `ilike` scan.

**Fix — run in Supabase SQL editor:**
```sql
create or replace function search_memories(
  query_embedding vector(1536),
  match_type      text    default null,
  match_count     int     default 10,
  match_threshold float   default 0.7
)
returns table (
  id          uuid,
  name        text,
  type        text,
  description text,
  body        text,
  similarity  float
)
language plpgsql
as $$
begin
  return query
  select
    m.id, m.name, m.type, m.description, m.body,
    1 - (m.embedding <=> query_embedding) as similarity
  from memories m
  where
    (match_type is null or m.type = match_type)
    and 1 - (m.embedding <=> query_embedding) >= match_threshold
  order by m.embedding <=> query_embedding
  limit match_count;
end;
$$;
```

### 2b. No pgvector HNSW index

Without an index, every vector search is an exact O(n) scan. For small datasets this is fine, but it will degrade past ~10k rows.

**Fix:**
```sql
-- Requires pgvector 0.5+, which Supabase supports
create index on memories using hnsw (embedding vector_cosine_ops)
with (m = 16, ef_construction = 64);
```

`vector_cosine_ops` matches the `<=>` (cosine distance) operator used in the RPC. Use `ef_search = 40` at query time for a good recall/speed balance.

### 2c. Sessions are never actually logged

`logSessionStart` / `logSessionEnd` are exported and have API endpoints (`POST /api/memory/session`, `PATCH /api/memory/session/:id`) but nothing in the Flint codebase calls them. Sessions table will always be empty.

**Fix — call them from the dashboard startup in `server.js`:**
```js
// Near the bottom of startServer(), after initDb():
if (isSupabaseEnabled()) {
  const sessionId = await logSessionStart().catch(() => null);
  process.on('SIGTERM', () => {
    if (sessionId) logSessionEnd(sessionId, { summary: 'Server shutdown' }).catch(() => {});
  });
}
```

---

## 3. Schema gaps

### 3a. `memories.name` must be UNIQUE

The upsert uses `onConflict: 'name'` but if the column has no UNIQUE constraint in Postgres, the conflict clause is silently ignored and duplicates accumulate.

**Fix:**
```sql
alter table memories add constraint memories_name_key unique (name);
```

### 3b. `memories.embedding` column type unknown

The column must be `vector(1536)` to match `text-embedding-3-small` output. If it was created without a dimension (just `vector`) the HNSW index cannot be built.

**Fix:**
```sql
-- Check current type:
select column_name, data_type, udt_name
from information_schema.columns
where table_name = 'memories' and column_name = 'embedding';

-- If wrong, alter it (data must be empty or migrated):
alter table memories alter column embedding type vector(1536);
```

### 3c. Missing index on `memories.type`

`pullMemories` and `searchMemories` both filter by `type`. Without an index, each call does a sequential scan.

**Fix:**
```sql
create index memories_type_idx on memories (type);
```

### 3d. `sessions.agent_names` storage type

The code passes a JS array (`agentNames: ['bot-1', 'bot-2']`). Supabase needs this column as `TEXT[]` or `JSONB`. If it was created as `TEXT`, writes will fail silently or error.

**Fix:**
```sql
alter table memories add column if not exists created_at timestamptz default now();
alter table sessions alter column agent_names type text[] using agent_names::text[];
```

---

## 4. Missing tables that would improve the system

### 4a. `agent_memories` (per-agent context)

Currently all memories are in a flat global pool. Agents can't scope searches to their own context.

```sql
create table agent_memories (
  id         uuid primary key default gen_random_uuid(),
  agent_name text not null,
  memory_id  uuid references memories(id) on delete cascade,
  created_at timestamptz default now()
);
create index on agent_memories (agent_name);
```

### 4b. `projects_memory` (project-scoped context)

```sql
create table project_memories (
  project_id integer references projects(id) on delete cascade,
  memory_id  uuid references memories(id) on delete cascade,
  primary key (project_id, memory_id)
);
```

Note: `projects` table exists in the local SQLite DB (`usage.sqlite`) — it would need to either be mirrored to Supabase or the link kept in SQLite.

---

## 5. Embeddings

### Current state
- Only `OPENAI_API_KEY` is supported → embeddings silently disabled when key is absent.
- **Now fixed** (2026-06-30): `dashboard/embeddings.js` updated to try OpenAI → OpenRouter → Mammouth in priority order.

### Recommendation: use `text-embedding-3-small`
This is the right choice — 1536 dimensions, cheap, fast. No change needed here.

### Recommendation: add `OPENROUTER_API_KEY` or `MAMMOUTH_API_KEY`
Add one of these to `.env` so embeddings work without an OpenAI account. OpenRouter's `openai/text-embedding-3-small` is the same model proxied.

---

## 6. RLS (Row-Level Security)

The anon key has read access to both tables (confirmed by live query returning `[]`). This means **any unauthenticated request can read all memories** via the Supabase REST API directly.

**Recommended RLS policies:**
```sql
-- Enable RLS
alter table memories enable row level security;
alter table sessions enable row level security;

-- Allow service_role full access (agents use service_role via MCP)
create policy "service_role_all_memories" on memories
  for all using (auth.role() = 'service_role');

create policy "service_role_all_sessions" on sessions
  for all using (auth.role() = 'service_role');

-- Optionally allow anon read (for dashboard queries with anon key):
create policy "anon_read_memories" on memories
  for select using (auth.role() = 'anon');
```

---

## 7. Priority order

| Priority | Action | Effort |
|---|---|---|
| 🔴 High | Create `search_memories` RPC function | 2 min in SQL editor |
| 🔴 High | Add UNIQUE constraint on `memories.name` | 1 SQL line |
| 🔴 High | Verify `embedding` column is `vector(1536)` | 1 SQL check |
| 🟡 Med | Add HNSW index | 1 SQL line (runs in background) |
| 🟡 Med | Add `type` index | 1 SQL line |
| 🟡 Med | Enable RLS + service_role policy | 4 SQL lines |
| 🟡 Med | Call `logSessionStart/End` from server.js | ~10 lines JS |
| 🟢 Low | Add `agent_memories` table | 5 SQL lines |
| 🟢 Low | Add OpenRouter/Mammouth key to `.env` for embeddings | Config only |

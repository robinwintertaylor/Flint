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

test('searchMemories falls back to ilike when embedding not available', async () => {
  const selectResult = [
    { id: '1', name: 'memory-a', type: 'user', description: 'About robin', body: 'Find me in the database' },
    { id: '2', name: 'memory-b', type: 'user', description: 'About coding', body: 'Another record to find' },
  ];
  const mock = makeMockClient({ selectResult });
  setSupabaseClient(mock);
  // Call without _embedding; generateEmbedding will return null since OPENAI_API_KEY is not set
  const result = await searchMemories('find me', {});
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'memory-a');
  assert.equal(result[1].name, 'memory-b');
  assert.equal(mock.calls.select.length, 1);
  assert.equal(mock.calls.select[0].table, 'memories');
});

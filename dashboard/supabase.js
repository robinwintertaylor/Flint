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

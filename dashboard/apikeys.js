import { getDb } from './db.js';

const SEEDED = new Set(['anthropic', 'openai', 'github', 'telegram', 'moonshot']);

export function maskKey(value) {
  if (!value || value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••••••' + value.slice(-4);
}

export function listApiKeys() {
  return getDb()
    .prepare('SELECT name, label, key_value, env_var FROM api_keys ORDER BY name')
    .all()
    .map(r => ({
      name:       r.name,
      label:      r.label,
      env_var:    r.env_var ?? null,
      has_db_key: !!r.key_value,
      env_set:    !!(r.env_var && process.env[r.env_var]),
      masked:     r.key_value ? maskKey(r.key_value) : '—',
      seeded:     SEEDED.has(r.name),
    }));
}

export function getApiKeyValue(name) {
  const row = getDb()
    .prepare('SELECT key_value, env_var FROM api_keys WHERE name = ?')
    .get(name);
  if (!row) return null;
  if (row.key_value) return row.key_value;
  if (row.env_var && process.env[row.env_var]) return process.env[row.env_var];
  return null;
}

export function createApiKey({ name, label, key_value = null, env_var = null }) {
  if (!name || !label) throw new Error('name and label required');
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('name must be lowercase letters, numbers, and hyphens only (e.g. openrouter)');
  try {
    getDb().prepare(
      'INSERT INTO api_keys (name, label, key_value, env_var) VALUES (?, ?, ?, ?)'
    ).run(name, label, key_value || null, env_var || null);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) throw new Error('name already exists');
    throw err;
  }
}

export function updateApiKey(name, { key_value, label, env_var } = {}) {
  const sets = [];
  const vals = [];
  if (key_value !== undefined) { sets.push('key_value = ?'); vals.push(key_value || null); }
  if (label    !== undefined) { sets.push('label = ?');     vals.push(label); }
  if (env_var  !== undefined) { sets.push('env_var = ?');   vals.push(env_var || null); }
  if (!sets.length) return 0;
  vals.push(name);
  return getDb()
    .prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE name = ?`)
    .run(...vals).changes;
}

export function deleteApiKey(name) {
  if (SEEDED.has(name)) throw new Error(`Cannot delete seeded provider: ${name}`);
  return getDb().prepare('DELETE FROM api_keys WHERE name = ?').run(name).changes;
}

export function buildApiKeyEnv() {
  const rows = getDb()
    .prepare('SELECT key_value, env_var FROM api_keys WHERE env_var IS NOT NULL AND key_value IS NOT NULL')
    .all();
  const env = {};
  for (const row of rows) {
    if (!process.env[row.env_var]) env[row.env_var] = row.key_value;
  }
  return env;
}

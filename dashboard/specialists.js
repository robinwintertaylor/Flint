import { getDb } from './db.js';

export function listSpecialists() {
  return getDb()
    .prepare('SELECT name, label, description, domains, skills, preferred_tier, preferred_provider, preferred_model, created_by, created_at, use_count, last_used FROM specialists ORDER BY use_count DESC, label')
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
  preferred_model    = null,
  created_by   = 'robin',
}) {
  validateName(name);
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO specialists
       (name, label, description, domains, skills, preferred_tier, preferred_provider, preferred_model, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, label, description, JSON.stringify(domains), JSON.stringify(skills), preferred_tier, preferred_provider, preferred_model, created_by, now);
}

export function updateSpecialist(name, fields) {
  const allowed = ['label', 'description', 'domains', 'skills', 'preferred_tier', 'preferred_provider', 'preferred_model'];
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

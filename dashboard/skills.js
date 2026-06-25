import { getDb } from './db.js';

export function listSkills() {
  return getDb().prepare(
    'SELECT id, name, description, source, tags, created_at FROM skills ORDER BY name'
  ).all();
}

export function getSkill(id) {
  return getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) ?? null;
}

export function createSkill({ name, description, content, source = 'manual', tags = '' }) {
  const r = getDb().prepare(
    'INSERT INTO skills (name, description, content, source, tags) VALUES (?, ?, ?, ?, ?)'
  ).run(name, description, content, source, tags);
  return r.lastInsertRowid;
}

export function updateSkill(id, fields) {
  const allowed = ['name', 'description', 'content', 'tags'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (key in fields) { sets.push(`${key} = ?`); vals.push(fields[key]); }
  }
  if (!sets.length) return;
  sets.push('updated_at = unixepoch()');
  vals.push(id);
  getDb().prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteSkill(id) {
  getDb().prepare('DELETE FROM skills WHERE id = ?').run(id);
}

export function upsertSkill({ name, description, content, source, tags = '' }) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM skills WHERE name = ?').get(name);
  if (existing) {
    db.prepare(
      'UPDATE skills SET description = ?, content = ?, source = ?, tags = ?, updated_at = unixepoch() WHERE id = ?'
    ).run(description, content, source, tags, existing.id);
    return { id: existing.id, created: false };
  }
  const r = db.prepare(
    'INSERT INTO skills (name, description, content, source, tags) VALUES (?, ?, ?, ?, ?)'
  ).run(name, description, content, source, tags);
  return { id: r.lastInsertRowid, created: true };
}

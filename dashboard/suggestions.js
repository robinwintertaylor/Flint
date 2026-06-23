import { getDb } from './db.js';

export function createSuggestion(agentName, content) {
  const db = getDb();
  const recent = db.prepare(
    `SELECT id FROM suggestions
     WHERE agent_name = ? AND content = ?
     AND created_at >= datetime('now', '-60 seconds')`
  ).get(agentName, content);
  if (recent) return null;
  const result = db.prepare(
    `INSERT INTO suggestions (agent_name, content) VALUES (?, ?)`
  ).run(agentName, content);
  return db.prepare(
    `SELECT id, agent_name, content, status, created_at FROM suggestions WHERE id = ?`
  ).get(result.lastInsertRowid);
}

export function listSuggestions() {
  return getDb().prepare(
    `SELECT id, agent_name, content, status, created_at
     FROM suggestions WHERE status != 'dismissed'
     ORDER BY created_at DESC`
  ).all();
}

export function updateSuggestion(id, { status }) {
  getDb().prepare(`UPDATE suggestions SET status = ? WHERE id = ?`).run(status, id);
}

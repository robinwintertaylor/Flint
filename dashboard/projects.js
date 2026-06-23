import { getDb } from './db.js';

function projectCost(db, projectId, period) {
  const filter = period === 'week'
    ? `date(timestamp) >= date('now', '-7 days')`
    : `strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')`;
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage
    WHERE agent_name IN (SELECT agent_name FROM project_agents WHERE project_id = ?)
    AND ${filter}
  `).get(projectId);
  return row.total;
}

function hydrate(row) {
  const db = getDb();
  const agents = db.prepare(
    `SELECT agent_name FROM project_agents WHERE project_id = ? ORDER BY agent_name`
  ).all(row.id).map(r => r.agent_name);
  return {
    ...row,
    agents,
    costWeek: projectCost(db, row.id, 'week'),
    costMonth: projectCost(db, row.id, 'month'),
  };
}

export function listProjects() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM projects WHERE status != 'archived' ORDER BY updated_at DESC`
  ).all();
  return rows.map(hydrate);
}

export function getProject(id) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
  if (!row) return null;
  return hydrate(row);
}

export function createProject({ name, notes = '' }) {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO projects (name, notes) VALUES (?, ?)`
  ).run(name, notes);
  return result.lastInsertRowid;
}

export function updateProject(id, fields) {
  const db = getDb();
  const allowed = ['name', 'status', 'notes', 'last_summary'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const setParts = updates.map(([k]) => `${k} = ?`).join(', ');
  const values = updates.map(([, v]) => v);
  db.prepare(
    `UPDATE projects SET ${setParts}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...values, id);
}

export function linkAgent(projectId, agentName) {
  getDb().prepare(
    `INSERT OR IGNORE INTO project_agents (project_id, agent_name) VALUES (?, ?)`
  ).run(projectId, agentName);
}

export function unlinkAgent(projectId, agentName) {
  getDb().prepare(
    `DELETE FROM project_agents WHERE project_id = ? AND agent_name = ?`
  ).run(projectId, agentName);
}

export function getProjectForAgent(agentName) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.id, p.name, p.notes, p.last_summary
    FROM projects p
    JOIN project_agents pa ON pa.project_id = p.id
    WHERE pa.agent_name = ?
    LIMIT 1
  `).get(agentName);
  return row ?? null;
}

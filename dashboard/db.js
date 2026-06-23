import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const DEFAULT_DB = join(FLINT_ROOT, 'usage.sqlite');

let _db = null;

export function initDb(dbPath = DEFAULT_DB) {
  _db = new Database(dbPath);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id         INTEGER PRIMARY KEY,
      agent_name TEXT NOT NULL,
      tokens_in  INTEGER,
      tokens_out INTEGER,
      model      TEXT,
      cost_usd   REAL,
      timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS agents_log (
      name      TEXT PRIMARY KEY,
      mode      TEXT,
      workdir   TEXT,
      status    TEXT,
      last_seen DATETIME
    );
    CREATE TABLE IF NOT EXISTS projects (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      status       TEXT NOT NULL DEFAULT 'active',
      notes        TEXT DEFAULT '',
      last_summary TEXT DEFAULT '',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS project_agents (
      project_id INTEGER NOT NULL REFERENCES projects(id),
      agent_name TEXT NOT NULL,
      PRIMARY KEY (project_id, agent_name)
    );
    CREATE TABLE IF NOT EXISTS suggestions (
      id          INTEGER PRIMARY KEY,
      agent_name  TEXT NOT NULL,
      content     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'new',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN worktree_path TEXT'); } catch {}
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN worktree_branch TEXT'); } catch {}
  return _db;
}

export function writeUsage({ agentName, model, costUsd }) {
  _db.prepare(
    `INSERT INTO usage (agent_name, model, cost_usd) VALUES (?, ?, ?)`
  ).run(agentName, model ?? 'claude', costUsd);
}

export function getTodayCost(agentName) {
  const row = _db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM usage WHERE agent_name = ? AND date(timestamp) = date('now')`
  ).get(agentName);
  return row.total;
}

export function getMonthCost() {
  const row = _db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM usage WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')`
  ).get();
  return row.total;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getCostsByProvider() {
  const db = getDb();
  const todayRows  = db.prepare(`SELECT model, SUM(cost_usd) as total FROM usage WHERE DATE(timestamp) = date('now') GROUP BY model`).all();
  const monthRows  = db.prepare(`SELECT model, SUM(cost_usd) as total FROM usage WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now') GROUP BY model`).all();
  return { todayRows, monthRows };
}

export function upsertAgentLog(name, { mode, workdir, status } = {}) {
  _db.prepare(`
    INSERT INTO agents_log (name, mode, workdir, status, last_seen)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET
      mode = excluded.mode,
      workdir = excluded.workdir,
      status = excluded.status,
      last_seen = excluded.last_seen
  `).run(name, mode ?? null, workdir ?? null, status ?? null);
}

export function setAgentWorktree(name, worktreePath, worktreeBranch) {
  getDb().prepare(
    `UPDATE agents_log SET worktree_path = ?, worktree_branch = ? WHERE name = ?`
  ).run(worktreePath, worktreeBranch, name);
}

export function clearAgentWorktree(name) {
  getDb().prepare(
    `UPDATE agents_log SET worktree_path = NULL, worktree_branch = NULL WHERE name = ?`
  ).run(name);
}

export function getAgentWorktree(name) {
  return getDb().prepare(
    `SELECT worktree_path, worktree_branch FROM agents_log WHERE name = ?`
  ).get(name);
}

export function getDb() {
  if (!_db) throw new Error('DB not initialised — call initDb() first');
  return _db;
}

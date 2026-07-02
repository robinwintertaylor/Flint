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
    CREATE TABLE IF NOT EXISTS workspaces (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      path       TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      command    TEXT NOT NULL,
      args       TEXT NOT NULL DEFAULT '[]',
      env        TEXT NOT NULL DEFAULT '{}',
      scope      TEXT NOT NULL DEFAULT 'global',
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS task_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      project_id  INTEGER REFERENCES projects(id),
      assigned_to TEXT,
      role        TEXT,
      priority    INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'pending',
      result      TEXT NOT NULL DEFAULT '',
      created_by  TEXT NOT NULL DEFAULT 'human',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS orchestrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      goal       TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      project_id INTEGER REFERENCES projects(id),
      status     TEXT NOT NULL DEFAULT 'running',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      name       TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      key_value  TEXT,
      env_var    TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS telegram_chat_ids (
      chat_id  TEXT PRIMARY KEY,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS skills (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      description TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      source      TEXT    NOT NULL DEFAULT 'manual',
      tags        TEXT    NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS project_docs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL,
      title       TEXT    NOT NULL,
      mime_type   TEXT    NOT NULL DEFAULT 'text/plain',
      content     TEXT    NOT NULL,
      source      TEXT    NOT NULL DEFAULT 'upload',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS specialists (
      name               TEXT PRIMARY KEY,
      label              TEXT NOT NULL,
      description        TEXT,
      domains            TEXT,
      skills             TEXT,
      preferred_tier     INTEGER DEFAULT 2,
      preferred_provider TEXT,
      created_by         TEXT NOT NULL DEFAULT 'robin',
      created_at         TEXT NOT NULL,
      use_count          INTEGER NOT NULL DEFAULT 0,
      last_used          TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS heartbeat_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      note         TEXT NOT NULL,
      actions_json TEXT NOT NULL DEFAULT '[]',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN worktree_path TEXT'); } catch {}
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN worktree_branch TEXT'); } catch {}
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN pr_number INTEGER'); } catch {}
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN pr_url TEXT'); } catch {}
  try { _db.exec('ALTER TABLE agents_log ADD COLUMN pr_status TEXT'); } catch {}
  try { _db.exec('ALTER TABLE specialists ADD COLUMN preferred_model TEXT'); } catch {}
  try { _db.exec('ALTER TABLE projects ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id)'); } catch {}
  try { _db.exec('ALTER TABLE projects ADD COLUMN goal TEXT'); } catch {}
  try { _db.exec('ALTER TABLE projects ADD COLUMN active_orchestration_id INTEGER REFERENCES orchestrations(id)'); } catch {}
  const _seedKey = _db.prepare(
    `INSERT OR IGNORE INTO api_keys (name, label, env_var) VALUES (?, ?, ?)`
  );
  [
    ['anthropic',   'Anthropic',     'ANTHROPIC_API_KEY'],
    ['openai',      'OpenAI',        'OPENAI_API_KEY'],
    ['github',      'GitHub',        'GITHUB_TOKEN'],
    ['telegram',    'Telegram',      'TELEGRAM_BOT_TOKEN'],
    ['moonshot',    'Moonshot Kimi', 'MOONSHOT_API_KEY'],
    ['openrouter',  'OpenRouter',    'OPENROUTER_API_KEY'],
    ['mammouth',    'Mammouth AI',   'MAMMOUTH_API_KEY'],
    ['lmstudio',    'LM Studio URL', 'LMSTUDIO_URL'],
    ['ollama',      'Ollama URL',    'OLLAMA_URL'],
  ].forEach(([n, l, e]) => _seedKey.run(n, l, e));
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

export function setAgentPR(name, prNumber, prUrl, status) {
  getDb().prepare(
    `UPDATE agents_log SET pr_number = ?, pr_url = ?, pr_status = ? WHERE name = ?`
  ).run(prNumber, prUrl, status, name);
}

export function clearAgentPR(name) {
  getDb().prepare(
    `UPDATE agents_log SET pr_number = NULL, pr_url = NULL, pr_status = NULL WHERE name = ?`
  ).run(name);
}

export function getAgentPR(name) {
  return getDb().prepare(
    `SELECT pr_number, pr_url, pr_status FROM agents_log WHERE name = ?`
  ).get(name);
}

export function listOpenPRAgents() {
  return getDb().prepare(
    `SELECT name, pr_number FROM agents_log WHERE pr_status = 'open'`
  ).all();
}

export function listWorkspaces() {
  return getDb().prepare('SELECT id, name, path, created_at FROM workspaces ORDER BY name').all();
}

export function addWorkspace(name, path) {
  return getDb().prepare('INSERT INTO workspaces (name, path) VALUES (?, ?)').run(name, path);
}

export function removeWorkspace(id) {
  return getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id);
}

export function getDb() {
  if (!_db) throw new Error('DB not initialised — call initDb() first');
  return _db;
}

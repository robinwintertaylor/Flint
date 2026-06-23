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
  `);
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

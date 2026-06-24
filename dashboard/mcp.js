import { getDb } from './db.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export function listMcpServers(scope = null) {
  const db = getDb();
  const rows = scope === null
    ? db.prepare('SELECT * FROM mcp_servers ORDER BY name').all()
    : db.prepare('SELECT * FROM mcp_servers WHERE scope = ? ORDER BY name').all(scope);
  return rows.map(r => ({ ...r, args: JSON.parse(r.args), env: JSON.parse(r.env) }));
}

export function addMcpServer({ name, command, args = [], env = {}, scope = 'global', enabled = 1 }) {
  const result = getDb().prepare(
    'INSERT INTO mcp_servers (name, command, args, env, scope, enabled) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, command, JSON.stringify(args), JSON.stringify(env), scope, enabled ? 1 : 0);
  return result.lastInsertRowid;
}

export function updateMcpServer(id, fields) {
  const allowed = ['name', 'command', 'args', 'env', 'scope', 'enabled'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(k === 'args' || k === 'env' ? JSON.stringify(v) : k === 'enabled' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return;
  vals.push(id);
  getDb().prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function removeMcpServer(id) {
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}

export function getMcpConfigForAgent(agentName) {
  const rows = getDb().prepare(
    `SELECT * FROM mcp_servers WHERE enabled = 1 AND (scope = 'global' OR scope = ?) ORDER BY name`
  ).all(agentName);
  const mcpServers = {};
  for (const row of rows) {
    mcpServers[row.name] = {
      command: row.command,
      args: JSON.parse(row.args),
      env: JSON.parse(row.env),
    };
  }
  return { mcpServers };
}

export function injectMcpConfig(agentName, workdir) {
  const { mcpServers } = getMcpConfigForAgent(agentName);
  if (Object.keys(mcpServers).length === 0) return;

  const settingsDir = join(workdir, '.claude');
  const settingsPath = join(settingsDir, 'settings.json');

  let existing = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
  }

  // Existing entries win on name conflicts
  const merged = {
    ...existing,
    mcpServers: { ...mcpServers, ...(existing.mcpServers ?? {}) },
  };

  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
}

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const DEFAULT_AGENTS_FILE = join(FLINT_ROOT, 'agents.json');

let AGENTS_FILE = process.env.FLINT_AGENTS_FILE ?? DEFAULT_AGENTS_FILE;

// name → { name, mode, status, workdir, logPath, ptyProcess, watcher, wsClients }
const registry = new Map();

export function initAgents(agentsFile) {
  if (agentsFile) AGENTS_FILE = agentsFile;
  registry.clear();
  if (!existsSync(AGENTS_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'));
    for (const a of data) {
      registry.set(a.name, {
        ...a,
        model: a.model ?? '',
        status: 'stopped',
        ptyProcess: null,
        watcher: null,
        wsClients: new Set(),
      });
    }
  } catch {
    // corrupt file — start fresh
  }
}

function save() {
  const data = [...registry.values()].map(({ name, mode, workdir, logPath, model, status }) => ({
    name, mode, workdir, logPath: logPath ?? null, model: model ?? '',
    status: status === 'running' ? 'stopped' : status,
  }));
  writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function registerAgent(name, mode, workdir, logPath = null, model = '') {
  const agent = {
    name, mode, workdir, logPath, model: model ?? '',
    status: 'stopped', ptyProcess: null, watcher: null, wsClients: new Set(),
  };
  registry.set(name, agent);
  save();
  return agent;
}

export function listAgents() {
  return [...registry.values()].map(({ name, mode, status, workdir, model }) => ({ name, mode, status, workdir, model: model ?? '' }));
}

export function getAgent(name) {
  return registry.get(name);
}

export function setAgentStatus(name, status) {
  const agent = registry.get(name);
  if (!agent) return;
  agent.status = status;
  save();
  broadcastToAgent(name, { type: 'status', agent: name, status });
}

export function addWsClient(name, ws) {
  registry.get(name)?.wsClients.add(ws);
}

export function removeWsClient(name, ws) {
  registry.get(name)?.wsClients.delete(ws);
}

export function broadcastToAgent(name, message) {
  const agent = registry.get(name);
  if (!agent) return;
  const json = JSON.stringify(message);
  for (const ws of agent.wsClients) {
    if (ws.readyState === 1) ws.send(json); // 1 = WebSocket.OPEN
  }
}

export function killAgent(name) {
  const agent = registry.get(name);
  if (!agent) return false;
  if (agent.ptyProcess) {
    try { agent.ptyProcess.kill(); } catch {}
    agent.ptyProcess = null;
  }
  if (agent.watcher) {
    try { agent.watcher.close(); } catch {}
    agent.watcher = null;
  }
  setAgentStatus(name, 'stopped');
  return true;
}

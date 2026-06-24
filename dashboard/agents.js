import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const DEFAULT_AGENTS_FILE = join(FLINT_ROOT, 'agents.json');

let AGENTS_FILE = process.env.FLINT_AGENTS_FILE ?? DEFAULT_AGENTS_FILE;

// name → { name, mode, status, workdir, logPath, runtime, ptyProcess, watcher, wsClients }
const registry = new Map();

const globalWsClients = new Set();

export function addGlobalWsClient(ws) { globalWsClients.add(ws); }
export function removeGlobalWsClient(ws) { globalWsClients.delete(ws); }

export function broadcastGlobal(data) {
  const json = JSON.stringify(data);
  for (const ws of globalWsClients) {
    if (ws.readyState === 1) ws.send(json);
  }
}

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
        runtime: a.runtime ?? 'claude',
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
  const data = [...registry.values()].map(({ name, mode, workdir, logPath, model, runtime, status }) => ({
    name, mode, workdir, logPath: logPath ?? null, model: model ?? '',
    runtime: runtime ?? 'claude',
    status: status === 'running' ? 'stopped' : status,
  }));
  writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function registerAgent(name, mode, workdir, logPath = null, model = '', runtime = 'claude') {
  const agent = {
    name, mode, workdir, logPath, model: model ?? '', runtime: runtime ?? 'claude',
    status: 'stopped', ptyProcess: null, watcher: null, wsClients: new Set(),
  };
  registry.set(name, agent);
  save();
  return agent;
}

export function listAgents() {
  return [...registry.values()].map(({ name, mode, status, workdir, model, runtime }) => ({ name, mode, status, workdir, model: model ?? '', runtime: runtime ?? 'claude' }));
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

export function removeAgent(name) {
  const agent = registry.get(name);
  if (!agent) return false;
  killAgent(name);
  registry.delete(name);
  save();
  broadcastGlobal({ type: 'agent_removed', agent: name });
  return true;
}

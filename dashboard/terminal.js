import pty from 'node-pty';
import { watch, existsSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { getAgent, setAgentStatus, broadcastToAgent } from './agents.js';
import { writeUsage } from './db.js';

const COST_REGEX = /Total cost:\s+\$?([\d.]+)/i;
const MODEL_REGEX = /Model:\s+(\S+)/i;

export function spawnAgent(name, workdir) {
  const agent = getAgent(name);
  if (!agent) throw new Error(`Agent "${name}" not registered`);
  if (agent.ptyProcess) throw new Error(`Agent "${name}" already has a running process`);

  const ptyProcess = pty.spawn('claude', ['--dangerously-skip-permissions'], {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: workdir,
    env: process.env,
  });

  agent.ptyProcess = ptyProcess;
  setAgentStatus(name, 'running');

  let lastModel = 'claude';

  ptyProcess.onData((data) => {
    broadcastToAgent(name, { type: 'output', agent: name, data });

    const modelMatch = data.match(MODEL_REGEX);
    if (modelMatch) lastModel = modelMatch[1];

    const costMatch = data.match(COST_REGEX);
    if (costMatch) {
      writeUsage({ agentName: name, model: lastModel, costUsd: parseFloat(costMatch[1]) });
    }
  });

  ptyProcess.onExit(() => {
    agent.ptyProcess = null;
    setAgentStatus(name, 'stopped');
  });

  return ptyProcess;
}

export function writeToAgent(name, data) {
  const agent = getAgent(name);
  if (agent?.ptyProcess) {
    agent.ptyProcess.write(data);
  }
}

export function observeLogFile(name, logPath) {
  // Create log file if it doesn't exist
  if (!existsSync(logPath)) writeFileSync(logPath, '', 'utf8');

  let lastSize = statSync(logPath).size;

  const watcher = watch(logPath, () => {
    try {
      const newSize = statSync(logPath).size;
      if (newSize <= lastSize) return; // truncation or no change
      const length = newSize - lastSize;
      const fd = openSync(logPath, 'r');
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, lastSize);
      closeSync(fd);
      lastSize = newSize;
      broadcastToAgent(name, { type: 'output', agent: name, data: buf.toString('utf8') });
    } catch {
      // file may be temporarily locked — skip this tick
    }
  });

  const agent = getAgent(name);
  if (agent) {
    agent.watcher = watcher;
    setAgentStatus(name, 'running');
  }
}

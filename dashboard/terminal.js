import pty from 'node-pty';
import { watch, existsSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { getAgent, setAgentStatus, broadcastToAgent } from './agents.js';
import { writeUsage } from './db.js';
import { readTasks, writeTasks } from './tasks.js';
import { getProjectForAgent, updateProject } from './projects.js';

const COST_REGEX = /Total cost:\s+\$?([\d.]+)/i;
const MODEL_REGEX = /Model:\s+(\S+)/i;
const MAX_SUMMARY_LINES = 50;

export function injectProjectContext(agentName) {
  const project = getProjectForAgent(agentName);
  if (!project) return;

  const block = [
    `## Project: ${project.name}`,
    `### Notes`,
    project.notes || '(none)',
    ...(project.last_summary ? [`### Last session`, project.last_summary] : []),
    '---',
    '',
  ].join('\n');

  const existing = readTasks(agentName);
  // Strip any previously injected project block before re-injecting
  const cleaned = existing.replace(/^## Project:[\s\S]*?---\n\n?/, '');
  writeTasks(agentName, block + '\n' + cleaned);
}

export function spawnAgent(name, workdir, model) {
  const agent = getAgent(name);
  if (!agent) throw new Error(`Agent "${name}" not registered`);
  if (agent.ptyProcess) throw new Error(`Agent "${name}" already has a running process`);

  // Inject project context into task file before spawning
  injectProjectContext(name);

  const args = ['--dangerously-skip-permissions'];
  if (model) args.push('--model', model);

  const ptyProcess = pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: workdir,
    env: process.env,
  });

  agent.ptyProcess = ptyProcess;
  setAgentStatus(name, 'running');

  let lastModel = 'claude';
  let lastCost = 0;
  const outputBuffer = [];

  ptyProcess.onData((data) => {
    broadcastToAgent(name, { type: 'output', agent: name, data });

    // Rolling output buffer for session summary
    const lines = data.split('\n');
    outputBuffer.push(...lines);
    if (outputBuffer.length > MAX_SUMMARY_LINES) {
      outputBuffer.splice(0, outputBuffer.length - MAX_SUMMARY_LINES);
    }

    const modelMatch = data.match(MODEL_REGEX);
    if (modelMatch) lastModel = modelMatch[1];

    const costMatch = data.match(COST_REGEX);
    if (costMatch) {
      const delta = parseFloat(costMatch[1]) - lastCost;
      if (delta > 0) {
        writeUsage({ agentName: name, model: lastModel, costUsd: delta });
        lastCost = parseFloat(costMatch[1]);
      }
    }
  });

  ptyProcess.onExit(() => {
    // Save last session output as summary on linked project
    const project = getProjectForAgent(name);
    if (project && outputBuffer.length > 0) {
      updateProject(project.id, { last_summary: outputBuffer.join('\n') });
    }

    agent.ptyProcess = null;
    lastCost = 0;
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
  if (!existsSync(logPath)) writeFileSync(logPath, '', 'utf8');

  let lastSize = statSync(logPath).size;

  const watcher = watch(logPath, () => {
    try {
      const newSize = statSync(logPath).size;
      if (newSize <= lastSize) return;
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

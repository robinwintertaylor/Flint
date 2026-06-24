import pty from 'node-pty';
import { watch, existsSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { execSync } from 'child_process';
import { platform } from 'os';
import { getAgent, setAgentStatus, broadcastToAgent, broadcastGlobal } from './agents.js';
import { writeUsage, getAgentWorktree } from './db.js';
import { createSuggestion } from './suggestions.js';
import { readTasks, writeTasks } from './tasks.js';
import { getProjectForAgent, updateProject } from './projects.js';
import { injectMcpConfig } from './mcp.js';

function resolveBin(name) {
  try {
    const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
    return execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
  } catch {
    return name;
  }
}

const CLAUDE_BIN = resolveBin('claude');
const VIBE_BIN   = resolveBin('vibe');

const COST_REGEX = /Total cost:\s+\$?([\d.]+)/i;
const MODEL_REGEX = /Model:\s+(\S+)/i;
const SUGGESTION_REGEX = /## SUGGESTION:\s*(.+?)(?=\n\n|\n##|$)/ms;
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-Z0-9]|\r/g;
const MAX_SUMMARY_LINES = 50;
const MAX_SUGG_BUFFER = 4000;

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

export function spawnAgent(name, workdir, model, { onWorktreePending } = {}) {
  const agent = getAgent(name);
  if (!agent) throw new Error(`Agent "${name}" not registered`);
  if (agent.ptyProcess) throw new Error(`Agent "${name}" already has a running process`);

  // Inject project context into task file before spawning
  injectProjectContext(name);

  const isVibe = agent.runtime === 'vibe';
  const bin = isVibe ? VIBE_BIN : CLAUDE_BIN;
  const args = isVibe ? [] : ['--dangerously-skip-permissions'];
  if (!isVibe && model) args.push('--model', model);

  if (!isVibe) {
    try { injectMcpConfig(name, workdir); } catch {}
  }

  const ptyProcess = pty.spawn(bin, args, {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: workdir,
    env: process.env,
  });

  agent.ptyProcess = ptyProcess;
  setAgentStatus(name, 'running');

  let lastModel = isVibe ? 'mistral' : 'claude';
  let lastCost = 0;
  const outputBuffer = [];
  let suggBuffer = '';

  ptyProcess.onData((data) => {
    broadcastToAgent(name, { type: 'output', agent: name, data });

    // Rolling output buffer for session summary
    const lines = data.split('\n');
    outputBuffer.push(...lines);
    if (outputBuffer.length > MAX_SUMMARY_LINES) {
      outputBuffer.splice(0, outputBuffer.length - MAX_SUMMARY_LINES);
    }

    // Strip ANSI codes for pattern matching
    const plain = data.replace(ANSI_RE, '');

    const modelMatch = plain.match(MODEL_REGEX);
    if (modelMatch) lastModel = modelMatch[1];

    const costMatch = plain.match(COST_REGEX);
    if (costMatch) {
      const delta = parseFloat(costMatch[1]) - lastCost;
      if (delta > 0) {
        writeUsage({ agentName: name, model: lastModel, costUsd: delta });
        lastCost = parseFloat(costMatch[1]);
      }
    }

    // Accumulate stripped text across chunks for multi-chunk suggestion detection
    suggBuffer += plain;
    if (suggBuffer.length > MAX_SUGG_BUFFER) suggBuffer = suggBuffer.slice(-MAX_SUGG_BUFFER);

    const suggMatch = suggBuffer.match(SUGGESTION_REGEX);
    if (suggMatch) {
      const suggestion = createSuggestion(name, suggMatch[1].trim());
      if (suggestion) {
        broadcastGlobal({ type: 'suggestion', suggestion });
      }
      // Remove matched text so the same suggestion doesn't fire again
      suggBuffer = suggBuffer.slice(suggBuffer.indexOf(suggMatch[0]) + suggMatch[0].length);
    }
  });

  ptyProcess.onExit(() => {
    // Save last session output as summary on linked project
    const project = getProjectForAgent(name);
    if (project && outputBuffer.length > 0) {
      updateProject(project.id, { last_summary: outputBuffer.join('\n') });
    }

    // Notify UI and trigger PR creation if agent had an isolated worktree
    const worktree = getAgentWorktree(name);
    if (worktree?.worktree_branch) {
      broadcastToAgent(name, { type: 'worktree_pending', agent: name, branch: worktree.worktree_branch });
      onWorktreePending?.(name, worktree.worktree_branch);
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

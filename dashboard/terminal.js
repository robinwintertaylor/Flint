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
import { notify } from './telegram.js';
import { buildApiKeyEnv } from './apikeys.js';

function resolveBin(name) {
  try {
    const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
    return execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
  } catch {
    return name;
  }
}

const CLAUDE_BIN  = resolveBin('claude');
const VIBE_BIN    = resolveBin('vibe');
const OLLAMA_BIN  = resolveBin('ollama');

const COST_REGEX = /Total cost:\s+\$?([\d.]+)/i;
const MODEL_REGEX = /Model:\s+(\S+)/i;
const SUGGESTION_REGEX = /## SUGGESTION:\s*(.+?)(?=\n\n|\n##|$)/ms;
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-Z0-9]|\r/g;
const MAX_SUMMARY_LINES = 50;
const MAX_SUGG_BUFFER = 4000;
const IDLE_THRESHOLD_MS = parseInt(process.env.FLINT_IDLE_TIMEOUT ?? '60') * 1000;

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

  const isVibe   = agent.runtime === 'vibe';
  const isOllama = agent.runtime === 'ollama';

  if (!isOllama) {
    const AUTONOMOUS_BLOCK =
      '## Operating Mode: Autonomous\n' +
      'You are running as an autonomous agent orchestrated by Flint. No human is monitoring this session.\n' +
      '- Never pause to ask for confirmation or approval\n' +
      '- Make your best judgement on all decisions and proceed\n' +
      '- If you encounter ambiguity, choose the most reasonable interpretation and continue\n' +
      '- Complete all tasks fully without checking in\n' +
      '---\n\n';
    const _currentTasks = readTasks(name);
    if (!_currentTasks.startsWith('## Operating Mode:')) {
      writeTasks(name, AUTONOMOUS_BLOCK + _currentTasks);
    }
  }

  let bin, args;
  if (isOllama) {
    bin  = OLLAMA_BIN;
    args = ['run', agent.model || 'llama3'];
  } else if (isVibe) {
    bin  = VIBE_BIN;
    args = [];
  } else {
    bin  = CLAUDE_BIN;
    args = ['--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
  }

  if (!isVibe && !isOllama) {
    try { injectMcpConfig(name, workdir); } catch {}
  }

  const ptyProcess = pty.spawn(bin, args, {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: workdir,
    env: { ...process.env, ...buildApiKeyEnv() },
  });

  agent.ptyProcess = ptyProcess;
  setAgentStatus(name, 'running');
  notify(`🟢 Agent \`${name}\` started`);

  let lastModel = isOllama ? (agent.model || 'llama3') : isVibe ? 'mistral' : 'claude';
  let lastCost = 0;
  const outputBuffer = [];
  let suggBuffer = '';
  let lastOutput = Date.now();

  ptyProcess.onData((data) => {
    lastOutput = Date.now();
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

    if (!isOllama) {
      const costMatch = plain.match(COST_REGEX);
      if (costMatch) {
        const delta = parseFloat(costMatch[1]) - lastCost;
        if (delta > 0) {
          writeUsage({ agentName: name, model: lastModel, costUsd: delta });
          lastCost = parseFloat(costMatch[1]);
        }
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
        notify(`💡 Suggestion from \`${name}\`: ${suggestion.content.slice(0, 200)}`);
      }
      // Remove matched text so the same suggestion doesn't fire again
      suggBuffer = suggBuffer.slice(suggBuffer.indexOf(suggMatch[0]) + suggMatch[0].length);
    }
  });

  const idleChecker = setInterval(() => {
    if (!agent.ptyProcess) { clearInterval(idleChecker); return; }
    if (Date.now() - lastOutput > IDLE_THRESHOLD_MS) {
      lastOutput = Date.now();
      agent.ptyProcess.write('please continue\n');
      broadcastToAgent(name, {
        type: 'output',
        agent: name,
        data: '\r\n\x1b[33m[Flint: agent idle — sent continue]\x1b[0m\r\n',
      });
    }
  }, 10_000);

  ptyProcess.onExit(({ exitCode }) => {
    clearInterval(idleChecker);
    notify(exitCode === 0
      ? `✅ Agent \`${name}\` finished`
      : `🔴 Agent \`${name}\` crashed (exit ${exitCode})`);
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

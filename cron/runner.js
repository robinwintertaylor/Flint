import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const LOGS_DIR = join(FLINT_ROOT, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

const DEFAULT_SPAWN_TIMEOUT_MS = 5 * 60 * 1000;

function logPath(name) {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOGS_DIR, `cron-${name}-${date}.log`);
}

export async function runEntry(entry) {
  if (entry.type === 'spawn') {
    return runSpawn(entry);
  } else if (entry.type === 'api') {
    return runApi(entry);
  } else {
    throw new Error(`Unknown cron entry type: ${entry.type}`);
  }
}

async function runSpawn(entry) {
  // Dynamically import node-pty (lives in dashboard/node_modules or root node_modules)
  let pty;
  try {
    pty = await import('node-pty');
  } catch {
    pty = await import(join(FLINT_ROOT, 'dashboard', 'node_modules', 'node-pty', 'lib', 'index.js'));
  }

  const logFile = logPath(entry.name);
  const logStream = createWriteStream(logFile, { flags: 'a' });

  logStream.write(`\n=== ${new Date().toISOString()} Starting: ${entry.name} ===\n`);

  const workdir = entry.workdir ?? FLINT_ROOT;
  const ptyProcess = pty.spawn('claude', ['--dangerously-skip-permissions'], {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: workdir,
    env: { ...process.env },
  });

  ptyProcess.onData(data => logStream.write(data));

  // Send each chain command
  for (const skillName of (entry.chain ?? [])) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    ptyProcess.write(`/${skillName}\n`);
  }

  const timeout = entry.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      ptyProcess.kill();
      logStream.write(`\n[cron] Killed after ${timeout}ms timeout\n`);
      resolve();
    }, timeout);
    ptyProcess.onExit(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  logStream.write(`=== ${new Date().toISOString()} Finished: ${entry.name} ===\n`);
  logStream.end();
}

async function runApi(entry) {
  const logFile = logPath(entry.name);
  const logStream = createWriteStream(logFile, { flags: 'a' });

  logStream.write(`\n=== ${new Date().toISOString()} Starting: ${entry.name} ===\n`);

  try {
    const res = await fetch('http://localhost:3001/llm/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskType: entry.taskType, prompt: entry.prompt }),
    });
    const data = await res.json();
    logStream.write(`Response:\n${data.text}\n`);
    logStream.write(`[cron] cost: $${data.costUsd?.toFixed(4)} model: ${data.model}\n`);
  } catch (err) {
    logStream.write(`[cron] ERROR: ${err.message}\n`);
  }

  logStream.write(`=== ${new Date().toISOString()} Finished: ${entry.name} ===\n`);
  logStream.end();
}

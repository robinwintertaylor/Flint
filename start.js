import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

const SERVICES = [
  { name: 'dashboard', cmd: 'node', args: ['dashboard/server.js'], log: 'dashboard.log' },
  { name: 'router',    cmd: 'node', args: ['router/server.js'],    log: 'router.log' },
  { name: 'cron',      cmd: 'node', args: ['cron/daemon.js'],      log: 'cron.log' },
];

const children = [];

for (const svc of SERVICES) {
  const logStream = createWriteStream(join(LOGS_DIR, svc.log), { flags: 'a' });
  const child = spawn(svc.cmd, svc.args, {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `[${svc.name}] `;

  child.stdout.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line) {
        process.stdout.write(prefix + line + '\n');
        logStream.write(line + '\n');
      }
    }
  });

  child.stderr.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line) {
        process.stderr.write(prefix + line + '\n');
        logStream.write('[ERR] ' + line + '\n');
      }
    }
  });

  child.on('exit', (code, signal) => {
    console.log(`${prefix}exited (code=${code} signal=${signal})`);
  });

  children.push(child);
  console.log(`${prefix}started (pid ${child.pid})`);
}

function shutdown() {
  console.log('\n[start] Shutting down all services...');
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

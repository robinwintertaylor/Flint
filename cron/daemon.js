import { readFileSync, watchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import nodeCron from '../router/node_modules/node-cron/src/index.js';
import { runEntry } from './runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const SCHEDULE_FILE = join(FLINT_ROOT, '.cron', 'schedule.json');

// Load .env from Flint root
import(join(FLINT_ROOT, 'router', 'node_modules', 'dotenv', 'lib', 'main.js')).then(({ default: dotenv }) => dotenv.config({ path: join(FLINT_ROOT, '.env') })).catch(() => {
  // dotenv import is optional; continue if not available
});

let registeredTasks = [];

function loadSchedule() {
  try {
    const raw = readFileSync(SCHEDULE_FILE, 'utf8');
    return JSON.parse(raw).schedules ?? [];
  } catch (err) {
    console.error(`[cron] Failed to load ${SCHEDULE_FILE}:`, err.message);
    return [];
  }
}

function registerSchedules() {
  // Stop existing tasks
  for (const task of registeredTasks) task.stop();
  registeredTasks = [];

  const schedules = loadSchedule();
  for (const entry of schedules) {
    if (!nodeCron.validate(entry.cron)) {
      console.error(`[cron] Invalid cron expression for "${entry.name}": ${entry.cron}`);
      continue;
    }
    const task = nodeCron.schedule(entry.cron, async () => {
      console.log(`[cron] Firing: ${entry.name}`);
      try {
        await runEntry(entry);
        console.log(`[cron] Done: ${entry.name}`);
      } catch (err) {
        console.error(`[cron] Error in "${entry.name}":`, err.message);
      }
    });
    registeredTasks.push(task);
    console.log(`[cron] Scheduled: ${entry.name} (${entry.cron})`);
  }
  console.log(`[cron] ${registeredTasks.length} schedule(s) active`);
}

// Initial load
registerSchedules();

// Hot-reload on SIGHUP
process.on('SIGHUP', () => {
  console.log('[cron] SIGHUP received — reloading schedule');
  registerSchedules();
});

// Also watch the file directly (Windows doesn't reliably deliver SIGHUP)
watchFile(SCHEDULE_FILE, { interval: 5000 }, () => {
  console.log('[cron] schedule.json changed — reloading');
  registerSchedules();
});

console.log('[cron] daemon running');

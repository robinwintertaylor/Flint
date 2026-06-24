import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');

function getTasksDir() {
  return process.env.FLINT_TASKS_DIR ?? join(FLINT_ROOT, 'tasks');
}

function ensureDir() {
  if (!existsSync(getTasksDir())) mkdirSync(getTasksDir(), { recursive: true });
}

export function taskPath(agentName) {
  return join(getTasksDir(), `${agentName}.md`);
}

export function readTasks(agentName) {
  ensureDir();
  const p = taskPath(agentName);
  if (!existsSync(p)) return `# Tasks — ${agentName}\n\n`;
  return readFileSync(p, 'utf8');
}

export function writeTasks(agentName, content) {
  ensureDir();
  writeFileSync(taskPath(agentName), content, 'utf8');
}

export function appendTask(agentName, task) {
  const content = readTasks(agentName);
  const line = content.endsWith('\n') ? `- [ ] ${task}\n` : `\n- [ ] ${task}\n`;
  writeFileSync(taskPath(agentName), content + line, 'utf8');
}

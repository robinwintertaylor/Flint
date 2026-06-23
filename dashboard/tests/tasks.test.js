import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Override TASKS_DIR to a temp dir for tests
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_TASKS = join(__dirname, 'tmp-tasks');

// We need to test with a custom tasks dir — patch via env
process.env.FLINT_TASKS_DIR = TEMP_TASKS;

const { readTasks, writeTasks, appendTask } = await import('../tasks.js');

test('readTasks returns default header for missing file', () => {
  if (existsSync(TEMP_TASKS)) rmSync(TEMP_TASKS, { recursive: true });
  mkdirSync(TEMP_TASKS, { recursive: true });
  const content = readTasks('newagent');
  assert.ok(content.includes('# Tasks — newagent'), `Expected header, got: ${content}`);
});

test('writeTasks overwrites file content', () => {
  mkdirSync(TEMP_TASKS, { recursive: true });
  writeTasks('research', '# Tasks — research\n\n- [ ] do thing\n');
  const content = readTasks('research');
  assert.ok(content.includes('- [ ] do thing'));
});

test('appendTask adds a checkbox line', () => {
  mkdirSync(TEMP_TASKS, { recursive: true });
  writeTasks('dev', '# Tasks — dev\n\n');
  appendTask('dev', 'fix the bug');
  const content = readTasks('dev');
  assert.ok(content.includes('- [ ] fix the bug'));
});

test('cleanup', () => {
  rmSync(TEMP_TASKS, { recursive: true, force: true });
  assert.ok(true);
});

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';

const TEMP_TASKS = join(tmpdir(), `flint-orch-test-${Date.now()}`);
process.env.FLINT_TASKS_DIR = TEMP_TASKS;
process.env.FLINT_TEST_MODE = '1'; // skip actual PTY spawn

import { initDb } from '../db.js';
import {
  getOrchestration, listOrchestrations, updateOrchestrationStatus,
  buildOrchestratorTaskFile, appendScratchpad, readScratchpad,
} from '../orchestrator.js';

before(() => {
  initDb(':memory:');
  mkdirSync(TEMP_TASKS, { recursive: true });
});

test('initDb creates orchestrations table', () => {
  const db = initDb(':memory:');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('orchestrations'), 'orchestrations table missing');
});

test('listOrchestrations returns empty initially', () => {
  initDb(':memory:');
  assert.deepEqual(listOrchestrations(), []);
});

test('buildOrchestratorTaskFile contains goal and API guide', () => {
  const content = buildOrchestratorTaskFile({
    goal: 'Build a REST API with JWT auth',
    id: 1,
    workdir: 'C:\\Projects\\myapp',
    scratchpadPath: 'tasks/orch-1/scratchpad.md',
  });
  assert.ok(content.includes('Build a REST API with JWT auth'), 'goal missing');
  assert.ok(content.includes('http://localhost:3000'), 'API base URL missing');
  assert.ok(content.includes('tasks/orch-1/scratchpad.md'), 'scratchpad path missing');
  assert.ok(content.includes('POST /queue/tasks'), 'queue API guide missing');
  assert.ok(content.includes('POST /agents/spawn'), 'spawn API guide missing');
  assert.ok(content.includes('researcher'), 'worker roles missing');
});

test('appendScratchpad and readScratchpad work correctly', () => {
  initDb(':memory:');
  const db = initDb(':memory:');
  // Insert a row so we can test scratchpad I/O
  db.prepare('INSERT INTO orchestrations (id, goal, agent_name) VALUES (?, ?, ?)').run(99, 'test goal', 'orch-99');
  const dir = join(TEMP_TASKS, 'orch-99');
  mkdirSync(dir, { recursive: true });
  const scratchPath = join(dir, 'scratchpad.md');
  // Write initial content
  writeFileSync(scratchPath, '# Orchestration: test goal\n\n## Plan\n\n', 'utf8');
  appendScratchpad(99, '\n## Findings\n\nResearcher found: OAuth2 works.\n');
  const content = readScratchpad(99);
  assert.ok(content.includes('Researcher found: OAuth2 works.'));
});

test('updateOrchestrationStatus changes status', () => {
  initDb(':memory:');
  const db = initDb(':memory:');
  db.prepare('INSERT INTO orchestrations (id, goal, agent_name, status) VALUES (?, ?, ?, ?)').run(42, 'g', 'orch-42', 'running');
  updateOrchestrationStatus(42, 'done');
  const row = getOrchestration(42);
  assert.equal(row.status, 'done');
});

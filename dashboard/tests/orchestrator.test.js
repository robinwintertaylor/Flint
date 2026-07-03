import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';

const TEMP_TASKS = join(tmpdir(), `flint-orch-test-${Date.now()}`);
process.env.FLINT_TASKS_DIR = TEMP_TASKS;
process.env.FLINT_TEST_MODE = '1'; // skip actual PTY spawn

// Isolate agents file so registerAgent (called internally by createOrchestration)
// doesn't overwrite the real agents.json. Must be a dynamic import: static imports
// are hoisted above this env var assignment, which would load orchestrator.js (and
// transitively agents.js) against the real agents.json before AGENTS_FILE is set.
const TEMP_AGENTS = join(tmpdir(), `flint-orch-agents-${Date.now()}.json`);
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;

const { initDb } = await import('../db.js');
const {
  getOrchestration, listOrchestrations, updateOrchestrationStatus,
  buildOrchestratorTaskFile, appendScratchpad, readScratchpad,
  createOrchestration, setOrchestrationBranch, setOrchestrationPR,
} = await import('../orchestrator.js');

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

test('orchestrations table has git columns', () => {
  const db = initDb(':memory:');
  const cols = db.prepare(`PRAGMA table_info(orchestrations)`).all().map(c => c.name);
  assert.ok(cols.includes('branch'), 'branch column missing');
  assert.ok(cols.includes('pr_number'), 'pr_number column missing');
  assert.ok(cols.includes('pr_url'), 'pr_url column missing');
  assert.ok(cols.includes('pr_status'), 'pr_status column missing');
});

test('setOrchestrationBranch stores the branch name', async () => {
  initDb(':memory:');
  const { id } = await createOrchestration({ goal: 'test goal', workdir: process.cwd() });
  setOrchestrationBranch(id, 'project/test-orch-1');
  assert.equal(getOrchestration(id).branch, 'project/test-orch-1');
});

test('setOrchestrationPR stores PR number, url, and status', async () => {
  initDb(':memory:');
  const { id } = await createOrchestration({ goal: 'test goal', workdir: process.cwd() });
  setOrchestrationPR(id, { prNumber: 5, prUrl: 'http://x/pulls/5', prStatus: 'open' });
  const orch = getOrchestration(id);
  assert.equal(orch.pr_number, 5);
  assert.equal(orch.pr_url, 'http://x/pulls/5');
  assert.equal(orch.pr_status, 'open');
});

test('createOrchestration creates and stores a branch for a project-linked run', async () => {
  const { execSync } = await import('child_process');
  const { mkdtempSync } = await import('fs');
  const { tmpdir: osTmpdir } = await import('os');
  const { join: pathJoin } = await import('path');
  const { createProject } = await import('../projects.js');

  initDb(':memory:');
  const workdir = mkdtempSync(pathJoin(osTmpdir(), 'flint-orch-branch-'));
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });
  execSync('git remote add forgejo "http://u:t@localhost:3030/u/repo.git"', { cwd: workdir });

  const projectId = createProject({ name: 'Branch Test Project' });

  const prevTestMode = process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_TEST_MODE;
  try {
    const { id } = await createOrchestration({ goal: 'test goal', workdir, projectId });
    const orch = getOrchestration(id);
    assert.ok(orch.branch, 'branch should be set');
    assert.match(orch.branch, /^project\/branch-test-project-orch-\d+$/);
  } finally {
    if (prevTestMode !== undefined) process.env.FLINT_TEST_MODE = prevTestMode;
  }
});

test('createOrchestration leaves branch null when no projectId is given', async () => {
  initDb(':memory:');
  const { id } = await createOrchestration({ goal: 'ad-hoc goal', workdir: process.cwd() });
  const orch = getOrchestration(id);
  assert.equal(orch.branch, null);
});

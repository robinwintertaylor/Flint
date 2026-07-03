import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';

const TEMP_DB = join(tmpdir(), `flint-projectgit-test-${Date.now()}.sqlite`);
process.env.FLINT_DB_PATH = TEMP_DB;

const { initDb } = await import('../db.js');
const { createProject } = await import('../projects.js');
const { slugify, ensureProjectRepo, commitTaskForProject } = await import('../projectGit.js');

function freshWorkdir() {
  const dir = join(tmpdir(), `flint-projectgit-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

before(() => {
  initDb(TEMP_DB);
});

test('slugify lowercases and replaces non-alphanumerics with hyphens', () => {
  assert.equal(slugify('Proj A: Model Audit!'), 'proj-a-model-audit');
});

test('slugify falls back to a placeholder for an empty/symbol-only name', () => {
  assert.equal(slugify('!!!'), 'project');
});

test('ensureProjectRepo git-inits a blank workdir with FLINT_TEST_MODE set (offline path)', async () => {
  process.env.FLINT_TEST_MODE = '1';
  const workdir = freshWorkdir();
  const projectId = createProject({ name: 'Blank Project' });
  const result = await ensureProjectRepo(projectId, workdir);
  assert.equal(result.hasRemote, false);
  delete process.env.FLINT_TEST_MODE;
});

test('ensureProjectRepo is a no-op when the workdir already has a remote', async () => {
  const workdir = freshWorkdir();
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });
  execSync('git remote add forgejo "http://u:t@localhost:3030/u/repo.git"', { cwd: workdir });
  const projectId = createProject({ name: 'Existing Project' });
  const result = await ensureProjectRepo(projectId, workdir);
  assert.equal(result.hasRemote, true);
});

test('ensureProjectRepo throws when workdir is nested inside a different git repo (not its own root)', async () => {
  const wasTestMode = process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_TEST_MODE;
  try {
    const parentRepo = freshWorkdir();
    execSync('git init', { cwd: parentRepo });
    execSync('git config user.email "t@t.local"', { cwd: parentRepo });
    execSync('git config user.name "T"', { cwd: parentRepo });
    execSync('git commit --allow-empty -m init', { cwd: parentRepo });

    const nestedDir = join(parentRepo, 'nested', 'workdir');
    mkdirSync(nestedDir, { recursive: true });

    const projectId = createProject({ name: 'Nested Project' });
    await assert.rejects(
      () => ensureProjectRepo(projectId, nestedDir),
      /nested inside an existing git repository/
    );
  } finally {
    if (wasTestMode === undefined) delete process.env.FLINT_TEST_MODE;
    else process.env.FLINT_TEST_MODE = wasTestMode;
  }
});

test('ensureProjectRepo creates a repo and pushes when Forgejo is reachable (online path, injected deps)', async () => {
  const wasTestMode = process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_TEST_MODE;
  try {
    const workdir = freshWorkdir();
    const projectId = createProject({ name: 'Online Project' });
    const fakeCloneUrl = 'http://u:t@localhost:3030/u/online-project.git';

    const result = await ensureProjectRepo(projectId, workdir, {
      isForgejoReachableFn: async () => true,
      createRepoFn: async () => ({ cloneUrl: fakeCloneUrl }),
      pushFn: () => {},
    });

    assert.equal(result.hasRemote, true);
    const remotes = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
    assert.ok(remotes.includes('forgejo'), 'expected a forgejo remote to be present');
    assert.ok(remotes.includes(fakeCloneUrl), 'expected the forgejo remote to point at the fake clone URL');
  } finally {
    if (wasTestMode === undefined) delete process.env.FLINT_TEST_MODE;
    else process.env.FLINT_TEST_MODE = wasTestMode;
  }
});

test('commitTaskForProject commits staged changes with the given message', async () => {
  const workdir = freshWorkdir();
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });
  execSync(`node -e "require('fs').writeFileSync('file.txt', 'hello')"`, { cwd: workdir });

  await commitTaskForProject(workdir, 'Do the thing (#1, builder)');

  const log = execSync('git log -1 --pretty=%s', { cwd: workdir, encoding: 'utf8' }).trim();
  assert.equal(log, 'Do the thing (#1, builder)');
});

test('commitTaskForProject does not let shell metacharacters in the message be interpreted by a shell', async () => {
  const workdir = freshWorkdir();
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });
  execSync(`node -e "require('fs').writeFileSync('file3.txt', 'hello')"`, { cwd: workdir });

  const message = 'Fix "the `foo()` bug"';
  await commitTaskForProject(workdir, message);

  const log = execSync('git log -1 --pretty=%s', { cwd: workdir, encoding: 'utf8' }).trim();
  assert.equal(log, message);
});

test('commitTaskForProject does not throw when there is nothing to commit', async () => {
  const workdir = freshWorkdir();
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });

  await assert.doesNotReject(() => commitTaskForProject(workdir, 'Nothing changed'));
});

test('commitTaskForProject serializes concurrent commits to the same workdir', async () => {
  const workdir = freshWorkdir();
  execSync('git init', { cwd: workdir });
  execSync('git config user.email "t@t.local"', { cwd: workdir });
  execSync('git config user.name "T"', { cwd: workdir });
  execSync('git commit --allow-empty -m init', { cwd: workdir });
  execSync(`node -e "require('fs').writeFileSync('a.txt', 'a')"`, { cwd: workdir });

  await Promise.all([
    commitTaskForProject(workdir, 'first commit message'),
    commitTaskForProject(workdir, 'second commit message'),
  ]);

  const log = execSync('git log --pretty=%s', { cwd: workdir, encoding: 'utf8' });
  assert.ok(log.includes('first commit message'));
});

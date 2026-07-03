import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

process.env.FLINT_TEST_MODE = '1';

const { isForgejoReachable, pushBranch, createPR, getPRStatus, createRepo } = await import('../forgejo.js');

const TMP_REPO = join(tmpdir(), `flint-forgejo-test-${Date.now()}`);

before(() => {
  mkdirSync(TMP_REPO, { recursive: true });
  execSync('git init', { cwd: TMP_REPO });
  execSync('git config user.email "test@flint.local"', { cwd: TMP_REPO });
  execSync('git config user.name "Flint Test"', { cwd: TMP_REPO });
  execSync('git commit --allow-empty -m "init"', { cwd: TMP_REPO });
  execSync(
    'git remote add forgejo "http://testuser:testtoken@localhost:3030/testuser/testrepo.git"',
    { cwd: TMP_REPO }
  );
});

test('isForgejoReachable returns true in TEST_MODE', async () => {
  assert.equal(await isForgejoReachable(), true);
});

test('pushBranch accepts a workdir and is a no-op in TEST_MODE', () => {
  assert.doesNotThrow(() => pushBranch('some-branch', TMP_REPO));
});

test('pushBranch defaults to FLINT_ROOT when no workdir given', () => {
  assert.doesNotThrow(() => pushBranch('some-branch'));
});

test('createPR accepts a workdir and returns a stub in TEST_MODE', async () => {
  const result = await createPR('some-branch', 'test-agent', TMP_REPO);
  assert.equal(typeof result.prNumber, 'number');
  assert.ok(result.prUrl.includes('pulls'));
});

test('getPRStatus accepts a workdir and returns open in TEST_MODE', async () => {
  const status = await getPRStatus(1, TMP_REPO);
  assert.equal(status, 'open');
});

test('createRepo returns a stub clone URL in TEST_MODE', async () => {
  const result = await createRepo('some-project');
  assert.ok(result.cloneUrl.includes('some-project'));
});

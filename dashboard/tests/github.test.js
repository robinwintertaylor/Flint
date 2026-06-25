import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

process.env.FLINT_TEST_MODE = '1';

import {
  isGitHubReachable,
  pushToGitHub,
  createGitHubPR,
  getGitHubPRStatus,
  detectProvider,
  parseOwnerRepo,
} from '../github.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '../..');

test('isGitHubReachable returns true in test mode', async () => {
  assert.equal(await isGitHubReachable(), true);
});

test('pushToGitHub is a no-op in test mode', () => {
  pushToGitHub('test-branch', process.cwd());
});

test('createGitHubPR returns mock data in test mode', async () => {
  const result = await createGitHubPR('test-branch', 'agent1', process.cwd());
  assert.equal(result.prNumber, 1);
  assert.ok(result.prUrl.startsWith('https://github.com/'));
});

test('getGitHubPRStatus returns "open" in test mode', async () => {
  assert.equal(await getGitHubPRStatus(1, 'https://github.com/robin/flint/pull/1'), 'open');
});

test('parseOwnerRepo parses HTTPS URL', () => {
  assert.deepEqual(
    parseOwnerRepo('https://github.com/robin/flint.git'),
    { owner: 'robin', repo: 'flint' }
  );
});

test('parseOwnerRepo parses SSH URL', () => {
  assert.deepEqual(
    parseOwnerRepo('git@github.com:robin/flint.git'),
    { owner: 'robin', repo: 'flint' }
  );
});

test('detectProvider returns "forgejo" when git fails or no github remote', () => {
  // The Flint repo has a forgejo remote, not a github remote
  assert.equal(detectProvider(FLINT_ROOT), 'forgejo');
});

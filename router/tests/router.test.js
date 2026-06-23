import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), 'flint-router-test-' + Date.now());
mkdirSync(TMP, { recursive: true });

const CONFIG = {
  tiers: {
    '1': {
      anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini',
      google: 'gemini-2.0-flash', azure: 'gpt-4o-mini',
      openrouter: 'mistral/mistral-small',
      'claude-cli': 'claude', 'gemini-cli': 'gemini',
    },
    '2': { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', google: 'gemini-2.0-pro', azure: 'gpt-4o', openrouter: 'mistral/mistral-medium' },
    '3': { anthropic: 'claude-opus-4-6', openai: 'gpt-4.5', google: 'gemini-2.5-pro', azure: 'gpt-4.5', openrouter: 'mistral/mistral-large' }
  },
  taskTypes: {
    'research': { tier: 2, provider: 'anthropic' },
    'code':     { tier: 2, provider: 'openai' }
  },
  defaultProvider: 'anthropic',
  defaultTier: 2
};

// Set env vars BEFORE importing router.js so initDb() and config load correctly
process.env.FLINT_TEST_MODE = '1';
process.env.FLINT_DB_PATH = join(TMP, 'usage.sqlite');
process.env.FLINT_ROUTER_CONFIG = join(TMP, 'router.json');
writeFileSync(process.env.FLINT_ROUTER_CONFIG, JSON.stringify(CONFIG));

before(() => {});

import { complete } from '../providers.js';
import { getModels, resetConfig } from '../config.js';

after(async () => {
  const { closeDb } = await import('../../dashboard/db.js');
  closeDb();
  // Brief pause so Windows releases SQLite file handles before rmSync
  await new Promise(r => setTimeout(r, 100));
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_DB_PATH;
  delete process.env.FLINT_ROUTER_CONFIG;
});

const { route } = await import('../router.js');

test('route with taskType returns stub text and correct model', async () => {
  const result = await route('research', 'test prompt');
  assert.equal(result.text, 'stub response');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'claude-sonnet-4-6');
  assert.ok(typeof result.costUsd === 'number');
  assert.ok(typeof result.durationMs === 'number');
});

test('route with explicit model bypasses routing', async () => {
  const result = await route(null, 'test prompt', { model: 'gpt-4o', provider: 'openai' });
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-4o');
});

test('route with no taskType uses defaults', async () => {
  const result = await route(null, 'test prompt');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'claude-sonnet-4-6');
});

test('route with provider override changes provider', async () => {
  const result = await route('research', 'test prompt', { provider: 'openai' });
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-4o');
});

test('route records usage in sqlite', async () => {
  const { initDb, getTodayCost, closeDb } = await import('../../dashboard/db.js');
  const db = initDb(process.env.FLINT_DB_PATH);
  await route('research', 'test prompt');
  const cost = getTodayCost('research');
  assert.ok(cost >= 0);
  closeDb();
});

test('complete claude-cli returns stub in test mode', async () => {
  const result = await complete('claude-cli', 'claude', [{ role: 'user', content: 'hello' }]);
  assert.equal(result.text, 'stub response');
  assert.equal(result.costUsd, 0.001);
});

test('complete gemini-cli returns stub in test mode', async () => {
  const result = await complete('gemini-cli', 'gemini', [{ role: 'user', content: 'hello' }]);
  assert.equal(result.text, 'stub response');
});

test('getModels includes cli group when router.json has cli providers', () => {
  resetConfig();
  const models = getModels();
  assert.ok(Array.isArray(models.cli), 'cli group should exist');
  assert.ok(models.cli.includes('claude'), 'cli group should include claude binary');
  assert.ok(models.cli.includes('gemini'), 'cli group should include gemini binary');
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), 'flint-config-test-' + Date.now());
mkdirSync(TMP, { recursive: true });

const MINIMAL_CONFIG = {
  tiers: {
    '1': { anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini', google: 'gemini-2.0-flash', azure: 'gpt-4o-mini', openrouter: 'mistral/mistral-small' },
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

before(() => {
  const cfgPath = join(TMP, 'router.json');
  writeFileSync(cfgPath, JSON.stringify(MINIMAL_CONFIG));
  process.env.FLINT_ROUTER_CONFIG = cfgPath;
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.FLINT_ROUTER_CONFIG;
});

const { getConfig, resolveRoute, getModels, resetConfig } = await import('../config.js');

test('getConfig returns parsed config', () => {
  const cfg = getConfig();
  assert.equal(cfg.defaultProvider, 'anthropic');
  assert.equal(cfg.defaultTier, 2);
  assert.ok(cfg.tiers['1']);
  assert.ok(cfg.taskTypes['research']);
});

test('resolveRoute uses taskType lookup', () => {
  const r = resolveRoute('research');
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.model, 'claude-sonnet-4-6');
  assert.equal(r.tier, 2);
});

test('resolveRoute allows provider override', () => {
  const r = resolveRoute('research', 'openai');
  assert.equal(r.provider, 'openai');
  assert.equal(r.model, 'gpt-4o');
});

test('resolveRoute falls back to defaults for unknown taskType', () => {
  const r = resolveRoute('unknown-task');
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'claude-sonnet-4-6');
});

test('getModels returns all models per provider', () => {
  const models = getModels();
  assert.ok(Array.isArray(models.anthropic));
  assert.ok(models.anthropic.includes('claude-haiku-4-5'));
  assert.ok(models.anthropic.includes('claude-sonnet-4-6'));
  assert.ok(models.anthropic.includes('claude-opus-4-6'));
  assert.ok(Array.isArray(models.openai));
  assert.ok(Array.isArray(models.google));
  assert.ok(Array.isArray(models.azure));
  assert.ok(Array.isArray(models.openrouter));
});

test('resetConfig clears cache so next getConfig re-reads', () => {
  const cfgPath = join(TMP, 'router2.json');
  const cfg2 = { ...MINIMAL_CONFIG, defaultProvider: 'openai' };
  writeFileSync(cfgPath, JSON.stringify(cfg2));
  process.env.FLINT_ROUTER_CONFIG = cfgPath;
  resetConfig();
  const cfg = getConfig();
  assert.equal(cfg.defaultProvider, 'openai');
  // restore
  const orig = join(TMP, 'router.json');
  process.env.FLINT_ROUTER_CONFIG = orig;
  resetConfig();
});

test('resolveRoute throws for provider not in tier', () => {
  assert.throws(() => resolveRoute('research', 'nonexistent-provider'), /No model configured/);
});

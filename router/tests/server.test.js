import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), 'flint-server-test-' + Date.now());
mkdirSync(TMP, { recursive: true });

const CONFIG = {
  tiers: {
    '1': { anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini', google: 'gemini-2.0-flash', azure: 'gpt-4o-mini', openrouter: 'mistral/mistral-small' },
    '2': { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', google: 'gemini-2.0-pro', azure: 'gpt-4o', openrouter: 'mistral/mistral-medium' },
    '3': { anthropic: 'claude-opus-4-6', openai: 'gpt-4.5', google: 'gemini-2.5-pro', azure: 'gpt-4.5', openrouter: 'mistral/mistral-large' }
  },
  taskTypes: { 'research': { tier: 2, provider: 'anthropic' } },
  defaultProvider: 'anthropic',
  defaultTier: 2
};

let server, baseUrl;

before(async () => {
  process.env.FLINT_TEST_MODE = '1';
  process.env.FLINT_DB_PATH = join(TMP, 'usage.sqlite');
  process.env.FLINT_ROUTER_CONFIG = join(TMP, 'router.json');
  writeFileSync(process.env.FLINT_ROUTER_CONFIG, JSON.stringify(CONFIG));

  const { createApp } = await import('../server.js');
  server = createApp();
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_DB_PATH;
  delete process.env.FLINT_ROUTER_CONFIG;
});

async function json(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  return { status: res.status, body: await res.json() };
}

test('POST /llm/complete with taskType returns completion', async () => {
  const { status, body } = await json(`${baseUrl}/llm/complete`, {
    method: 'POST',
    body: JSON.stringify({ taskType: 'research', prompt: 'test' }),
  });
  assert.equal(status, 200);
  assert.equal(body.text, 'stub response');
  assert.equal(body.provider, 'anthropic');
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.ok(typeof body.costUsd === 'number');
  assert.ok(typeof body.durationMs === 'number');
});

test('POST /llm/complete with explicit model bypasses routing', async () => {
  const { status, body } = await json(`${baseUrl}/llm/complete`, {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-4o', provider: 'openai', prompt: 'test' }),
  });
  assert.equal(status, 200);
  assert.equal(body.model, 'gpt-4o');
  assert.equal(body.provider, 'openai');
});

test('POST /llm/complete without prompt returns 400', async () => {
  const { status } = await json(`${baseUrl}/llm/complete`, {
    method: 'POST',
    body: JSON.stringify({ taskType: 'research' }),
  });
  assert.equal(status, 400);
});

test('GET /llm/models returns models per provider', async () => {
  const { status, body } = await json(`${baseUrl}/llm/models`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.anthropic));
  assert.ok(body.anthropic.includes('claude-sonnet-4-6'));
  assert.ok(Array.isArray(body.openai));
});

test('GET /llm/config returns router.json content', async () => {
  const { status, body } = await json(`${baseUrl}/llm/config`);
  assert.equal(status, 200);
  assert.equal(body.defaultProvider, 'anthropic');
  assert.ok(body.tiers);
});

test('GET /llm/costs returns cost breakdown', async () => {
  const { status, body } = await json(`${baseUrl}/llm/costs`);
  assert.equal(status, 200);
  assert.ok(typeof body.totalToday === 'number');
  assert.ok(typeof body.totalMonth === 'number');
  assert.ok(body.today);
  assert.ok(body.month);
});

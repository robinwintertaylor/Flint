import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../db.js';
import {
  maskKey, listApiKeys, getApiKeyValue,
  createApiKey, updateApiKey, deleteApiKey,
} from '../apikeys.js';

test('initDb creates api_keys table with 5 seeded rows', () => {
  initDb(':memory:');
  const rows = listApiKeys();
  assert.equal(rows.length, 5);
  assert.ok(rows.some(r => r.name === 'anthropic'));
  assert.ok(rows.some(r => r.name === 'moonshot'));
});

test('maskKey masks long keys — first 4 + bullets + last 4', () => {
  assert.equal(maskKey('sk-ant-1234567890abcd'), 'sk-a••••••••abcd');
});

test('maskKey returns bullets for keys 8 chars or shorter', () => {
  assert.equal(maskKey('short'), '••••••••');
  assert.equal(maskKey(''), '••••••••');
  assert.equal(maskKey('12345678'), '••••••••');
});

test('listApiKeys never exposes raw key_value field', () => {
  initDb(':memory:');
  createApiKey({ name: 'test-p', label: 'Test', key_value: 'sk-test-1234567890abcd' });
  const row = listApiKeys().find(r => r.name === 'test-p');
  assert.ok(row, 'row must exist');
  assert.ok(!('key_value' in row), 'key_value must not appear in response');
  assert.equal(row.has_db_key, true);
  assert.match(row.masked, /•/);
});

test('listApiKeys has_db_key false and masked — when no key set', () => {
  initDb(':memory:');
  const row = listApiKeys().find(r => r.name === 'anthropic');
  assert.equal(row.has_db_key, false);
  assert.equal(row.masked, '—');
});

test('seeded rows have seeded:true, custom rows have seeded:false', () => {
  initDb(':memory:');
  createApiKey({ name: 'custom-x', label: 'Custom' });
  const list = listApiKeys();
  assert.equal(list.find(r => r.name === 'anthropic').seeded, true);
  assert.equal(list.find(r => r.name === 'custom-x').seeded, false);
});

test('getApiKeyValue returns DB key when set', () => {
  initDb(':memory:');
  updateApiKey('anthropic', { key_value: 'real-key-abc123' });
  assert.equal(getApiKeyValue('anthropic'), 'real-key-abc123');
});

test('getApiKeyValue falls back to env var when DB key is null', () => {
  initDb(':memory:');
  process.env.ANTHROPIC_API_KEY = 'env-key-xyz';
  const val = getApiKeyValue('anthropic');
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(val, 'env-key-xyz');
});

test('getApiKeyValue returns null when neither DB nor env has value', () => {
  initDb(':memory:');
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(getApiKeyValue('anthropic'), null);
});

test('getApiKeyValue returns null for unknown provider', () => {
  initDb(':memory:');
  assert.equal(getApiKeyValue('does-not-exist'), null);
});

test('createApiKey adds a new provider', () => {
  initDb(':memory:');
  createApiKey({ name: 'new-llm', label: 'New LLM', env_var: 'NEW_KEY' });
  assert.ok(listApiKeys().some(r => r.name === 'new-llm'));
});

test('createApiKey throws on duplicate name', () => {
  initDb(':memory:');
  assert.throws(() => createApiKey({ name: 'anthropic', label: 'Dup' }), /already exists/);
});

test('createApiKey throws on invalid name', () => {
  initDb(':memory:');
  assert.throws(() => createApiKey({ name: 'Bad Name!', label: 'Bad' }), /alphanumeric/);
});

test('updateApiKey clears key when empty string passed', () => {
  initDb(':memory:');
  updateApiKey('anthropic', { key_value: 'some-key' });
  updateApiKey('anthropic', { key_value: '' });
  assert.equal(getApiKeyValue('anthropic'), null);
});

test('updateApiKey returns 0 for unknown provider', () => {
  initDb(':memory:');
  const changes = updateApiKey('no-such-name', { key_value: 'x' });
  assert.equal(changes, 0);
});

test('deleteApiKey removes custom provider', () => {
  initDb(':memory:');
  createApiKey({ name: 'remove-me', label: 'Remove' });
  deleteApiKey('remove-me');
  assert.ok(!listApiKeys().some(r => r.name === 'remove-me'));
});

test('deleteApiKey throws for seeded provider', () => {
  initDb(':memory:');
  assert.throws(() => deleteApiKey('anthropic'), /seeded/);
});

test('deleteApiKey returns 0 for unknown provider', () => {
  initDb(':memory:');
  assert.equal(deleteApiKey('no-such-xyz'), 0);
});

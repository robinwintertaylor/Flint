import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../db.js';
import { getSetting, setSetting } from '../settings.js';

before(() => initDb(':memory:'));

test('getSetting returns empty string for unknown key', () => {
  assert.equal(getSetting('missing_key'), '');
});

test('getSetting returns defaultVal for unknown key when provided', () => {
  assert.equal(getSetting('missing_key', 'fallback'), 'fallback');
});

test('setSetting + getSetting round-trips a value', () => {
  setSetting('default_agent', 'my-worker');
  assert.equal(getSetting('default_agent'), 'my-worker');
});

test('setSetting overwrites an existing value', () => {
  setSetting('default_agent', 'first');
  setSetting('default_agent', 'second');
  assert.equal(getSetting('default_agent'), 'second');
});

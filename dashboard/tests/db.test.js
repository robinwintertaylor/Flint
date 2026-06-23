import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, writeUsage, getTodayCost, getMonthCost } from '../db.js';

test('initDb creates usage and agents_log tables', () => {
  const db = initDb(':memory:');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('usage'), 'usage table missing');
  assert.ok(tables.includes('agents_log'), 'agents_log table missing');
});

test('getTodayCost returns 0 for unknown agent', () => {
  initDb(':memory:');
  assert.equal(getTodayCost('ghost'), 0);
});

test('writeUsage inserts row and getTodayCost sums it', () => {
  initDb(':memory:');
  writeUsage({ agentName: 'research', model: 'claude', costUsd: 0.42 });
  writeUsage({ agentName: 'research', model: 'claude', costUsd: 0.18 });
  assert.equal(getTodayCost('research'), 0.60);
});

test('getMonthCost sums all agents this month', () => {
  initDb(':memory:');
  writeUsage({ agentName: 'a', model: 'claude', costUsd: 1.00 });
  writeUsage({ agentName: 'b', model: 'claude', costUsd: 2.50 });
  const total = getMonthCost();
  assert.ok(total >= 3.50, `expected >= 3.50, got ${total}`);
});

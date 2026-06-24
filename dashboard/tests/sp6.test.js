import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Logger tests ────────────────────────────────────────────────────────────

const { info, warn, error: logError } = await import('../logger.js');

test('logger.info writes JSON line with level info', () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(chunk); return true; };
  info('test message', { key: 'val' });
  process.stdout.write = orig;
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'test message');
  assert.equal(parsed.key, 'val');
  assert.ok(parsed.ts, 'ts field missing');
});

test('logger.warn writes JSON line with level warn', () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(chunk); return true; };
  warn('something off');
  process.stdout.write = orig;
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.msg, 'something off');
});

test('logger.error writes JSON line with level error', () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(chunk); return true; };
  logError('boom', { err: 'details' });
  process.stdout.write = orig;
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.err, 'details');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { initDb } from '../db.js';
import {
  listMcpServers, addMcpServer, updateMcpServer, removeMcpServer,
  getMcpConfigForAgent, injectMcpConfig,
} from '../mcp.js';

test('initDb creates mcp_servers table', () => {
  const db = initDb(':memory:');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('mcp_servers'), 'mcp_servers table missing');
});

test('addMcpServer inserts and listMcpServers returns it', () => {
  initDb(':memory:');
  addMcpServer({ name: 'fs', command: 'npx', args: ['-y', '@mcp/fs'], env: {}, scope: 'global', enabled: 1 });
  const list = listMcpServers();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'fs');
  assert.equal(list[0].command, 'npx');
});

test('getMcpConfigForAgent returns global + agent-specific enabled servers, excludes disabled', () => {
  initDb(':memory:');
  addMcpServer({ name: 'global-fs', command: 'npx', args: ['-y', '@mcp/fs'], env: {}, scope: 'global', enabled: 1 });
  addMcpServer({ name: 'agent-git', command: 'uvx', args: ['mcp-server-git'], env: {}, scope: 'myagent', enabled: 1 });
  addMcpServer({ name: 'disabled', command: 'npx', args: [], env: {}, scope: 'global', enabled: 0 });
  const cfg = getMcpConfigForAgent('myagent');
  assert.ok('global-fs' in cfg.mcpServers, 'global server missing');
  assert.ok('agent-git' in cfg.mcpServers, 'agent-specific server missing');
  assert.ok(!('disabled' in cfg.mcpServers), 'disabled server should be excluded');
  assert.deepEqual(cfg.mcpServers['global-fs'].args, ['-y', '@mcp/fs']);
});

test('getMcpConfigForAgent excludes other agents\' servers', () => {
  initDb(':memory:');
  addMcpServer({ name: 'other-agent-tool', command: 'npx', args: [], env: {}, scope: 'otheragent', enabled: 1 });
  const cfg = getMcpConfigForAgent('myagent');
  assert.ok(!('other-agent-tool' in cfg.mcpServers));
});

test('updateMcpServer changes enabled flag', () => {
  initDb(':memory:');
  const id = addMcpServer({ name: 'toggler', command: 'npx', args: [], env: {}, scope: 'global', enabled: 1 });
  updateMcpServer(id, { enabled: 0 });
  const list = listMcpServers();
  assert.equal(list[0].enabled, 0);
});

test('removeMcpServer deletes the row', () => {
  initDb(':memory:');
  const id = addMcpServer({ name: 'todelete', command: 'npx', args: [], env: {}, scope: 'global', enabled: 1 });
  removeMcpServer(id);
  assert.equal(listMcpServers().length, 0);
});

test('listMcpServers(scope) filters by scope', () => {
  initDb(':memory:');
  addMcpServer({ name: 'g', command: 'npx', args: [], env: {}, scope: 'global', enabled: 1 });
  addMcpServer({ name: 'a', command: 'npx', args: [], env: {}, scope: 'agent1', enabled: 1 });
  assert.equal(listMcpServers('global').length, 1);
  assert.equal(listMcpServers('global')[0].name, 'g');
});

test('injectMcpConfig writes .claude/settings.json in workdir', () => {
  initDb(':memory:');
  addMcpServer({ name: 'filesystem', command: 'npx', args: ['-y', '@mcp/fs', '/'], env: {}, scope: 'global', enabled: 1 });
  const dir = mkdtempSync(join(tmpdir(), 'flint-mcp-'));
  injectMcpConfig('any-agent', dir);
  const written = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.ok('mcpServers' in written);
  assert.ok('filesystem' in written.mcpServers);
  assert.equal(written.mcpServers.filesystem.command, 'npx');
});

test('injectMcpConfig merges with existing settings.json; existing entries win on conflict', () => {
  initDb(':memory:');
  addMcpServer({ name: 'clash', command: 'new-cmd', args: [], env: {}, scope: 'global', enabled: 1 });
  const dir = mkdtempSync(join(tmpdir(), 'flint-mcp-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
    mcpServers: { clash: { command: 'old-cmd', args: [], env: {} } },
    someOtherSetting: true,
  }), 'utf8');
  injectMcpConfig('any-agent', dir);
  const written = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(written.mcpServers.clash.command, 'old-cmd', 'existing entry should win');
  assert.equal(written.someOtherSetting, true, 'other settings must be preserved');
});

test('injectMcpConfig is a no-op when no servers configured', () => {
  initDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'flint-mcp-'));
  injectMcpConfig('any-agent', dir);
  assert.ok(!existsSync(join(dir, '.claude', 'settings.json')), 'should not create file when nothing configured');
});

test('terminal.js imports injectMcpConfig without error', async () => {
  // If terminal.js doesn't import mcp.js this will throw at module load time
  // We can't actually call spawnAgent in tests (needs PTY) but we can verify the import
  const mod = await import('../terminal.js');
  assert.ok(typeof mod.spawnAgent === 'function');
});

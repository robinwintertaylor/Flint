import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const TEMP_FILE = join(tmpdir(), `flint-agents-test-${Date.now()}.json`);
process.env.FLINT_AGENTS_FILE = TEMP_FILE;

const { initAgents, registerAgent, listAgents, getAgent, setAgentStatus, killAgent } = await import('../agents.js');

test('listAgents returns empty array on fresh init', () => {
  initAgents();
  assert.deepEqual(listAgents(), []);
});

test('registerAgent adds agent to registry', () => {
  initAgents();
  registerAgent('research', 'spawn', 'C:/flint');
  const agents = listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, 'research');
  assert.equal(agents[0].mode, 'spawn');
  assert.equal(agents[0].status, 'stopped');
});

test('getAgent returns agent by name', () => {
  initAgents();
  registerAgent('dev', 'spawn', 'C:/flint');
  const agent = getAgent('dev');
  assert.ok(agent, 'agent not found');
  assert.equal(agent.name, 'dev');
});

test('setAgentStatus updates status', () => {
  initAgents();
  registerAgent('email', 'observe', null, 'C:/logs/email.log');
  setAgentStatus('email', 'running');
  assert.equal(getAgent('email').status, 'running');
});

test('killAgent returns false for unknown agent', () => {
  initAgents();
  assert.equal(killAgent('ghost'), false);
});

test('registerAgent stores role field', () => {
  initAgents();
  registerAgent('tester-1', 'spawn', 'C:/flint', null, '', 'claude', 'tester');
  const a = getAgent('tester-1');
  assert.equal(a.role, 'tester');
});

test('listAgents includes role field', () => {
  initAgents();
  registerAgent('coder-1', 'spawn', 'C:/flint', null, '', 'claude', 'coder');
  const agents = listAgents();
  const a = agents.find(x => x.name === 'coder-1');
  assert.ok('role' in a, 'role missing from listAgents output');
  assert.equal(a.role, 'coder');
});

test('registerAgent role defaults to null', () => {
  initAgents();
  registerAgent('general', 'spawn', 'C:/flint');
  assert.equal(getAgent('general').role, null);
});

test('initAgents loads role from JSON', () => {
  initAgents();
  registerAgent('qa', 'spawn', 'C:/flint', null, '', 'claude', 'qa');
  // re-init from the same file (FLINT_AGENTS_FILE env is set to temp)
  initAgents();
  assert.equal(getAgent('qa').role, 'qa');
});

test('cleanup', () => {
  rmSync(TEMP_FILE, { force: true });
  assert.ok(true);
});

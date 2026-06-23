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

test('cleanup', () => {
  rmSync(TEMP_FILE, { force: true });
  assert.ok(true);
});

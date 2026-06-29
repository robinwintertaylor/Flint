import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

// Point to temp files so tests don't touch real data
const TEMP_DB = join(tmpdir(), `flint-test-${Date.now()}.sqlite`);
const TEMP_AGENTS = join(tmpdir(), `flint-agents-${Date.now()}.json`);
const TEMP_TASKS = join(tmpdir(), `flint-tasks-${Date.now()}`);
process.env.FLINT_DB_PATH = TEMP_DB;
process.env.FLINT_AGENTS_FILE = TEMP_AGENTS;
process.env.FLINT_TASKS_DIR = TEMP_TASKS;
process.env.FLINT_TEST_MODE = '1'; // skip actual claude spawn in tests

const { createApp, closeDb } = await import('../server.js');

let server;
let baseUrl;

before(() => new Promise((resolve) => {
  const app = createApp();
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => {
    closeDb();
    rmSync(TEMP_DB, { force: true });
    rmSync(TEMP_AGENTS, { force: true });
    rmSync(TEMP_TASKS, { recursive: true, force: true });
    resolve();
  });
}));

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

test('GET /agents returns empty array initially', async () => {
  const r = await req('GET', '/agents');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('GET /tasks/:agent returns default header for unknown agent', async () => {
  const r = await req('GET', '/tasks/ghost');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.content.includes('# Tasks — ghost'));
});

test('PATCH /tasks/:agent overwrites task content', async () => {
  await req('PATCH', '/tasks/dev', { content: '# Tasks — dev\n\n- [ ] task one\n' });
  const r = await req('GET', '/tasks/dev');
  const body = await r.json();
  assert.ok(body.content.includes('- [ ] task one'));
});

test('POST /tasks/:agent appends a task', async () => {
  await req('PATCH', '/tasks/research', { content: '# Tasks — research\n\n' });
  await req('POST', '/tasks/research', { task: 'do the thing' });
  const r = await req('GET', '/tasks/research');
  const body = await r.json();
  assert.ok(body.content.includes('- [ ] do the thing'));
});

test('GET /costs returns costs object', async () => {
  const r = await req('GET', '/costs');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.costs));
  assert.ok('monthTotal' in body);
});

test('DELETE /agents/:name returns ok:false for unknown agent', async () => {
  const r = await req('DELETE', '/agents/ghost');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, false);
});

test('GET /mcp/servers returns empty array initially', async () => {
  const r = await req('GET', '/mcp/servers');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('POST /mcp/servers creates a server and returns it', async () => {
  const r = await req('POST', '/mcp/servers', {
    name: 'test-fs', command: 'npx', args: ['-y', '@mcp/fs'], env: {}, scope: 'global',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.name, 'test-fs');
  assert.ok(body.id, 'id should be present');
});

test('POST /mcp/servers with missing name returns 400', async () => {
  const r = await req('POST', '/mcp/servers', { command: 'npx' });
  assert.equal(r.status, 400);
});

test('PATCH /mcp/servers/:id toggles enabled', async () => {
  const { id } = await req('POST', '/mcp/servers', {
    name: 'toggler2', command: 'npx', args: [], env: {}, scope: 'global',
  }).then(r => r.json());
  await req('PATCH', `/mcp/servers/${id}`, { enabled: 0 });
  const list = await req('GET', '/mcp/servers').then(r => r.json());
  const found = list.find(s => s.id === id);
  assert.equal(found.enabled, 0);
});

test('DELETE /mcp/servers/:id removes the server', async () => {
  const { id } = await req('POST', '/mcp/servers', {
    name: 'todelete2', command: 'npx', args: [], env: {}, scope: 'global',
  }).then(r => r.json());
  await req('DELETE', `/mcp/servers/${id}`);
  const list = await req('GET', '/mcp/servers').then(r => r.json());
  assert.ok(!list.find(s => s.id === id), 'server should be gone');
});

test('DELETE /mcp/servers/:id returns 404 for nonexistent id', async () => {
  const r = await req('DELETE', '/mcp/servers/99999');
  assert.equal(r.status, 404);
});

test('GET /queue/tasks returns empty array initially', async () => {
  const r = await req('GET', '/queue/tasks');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('POST /queue/tasks creates unassigned task', async () => {
  const r = await req('POST', '/queue/tasks', { title: 'Do the thing', description: 'Details here', created_by: 'human' });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.title, 'Do the thing');
  assert.equal(body.status, 'pending');
  assert.equal(body.assigned_to, null);
});

test('POST /queue/tasks with assigned_to sets in_progress', async () => {
  await req('POST', '/agents/spawn', { name: 'worker-q', workdir: process.cwd() });
  const r = await req('POST', '/queue/tasks', { title: 'Assigned task', assigned_to: 'worker-q', created_by: 'human' });
  const body = await r.json();
  assert.equal(body.status, 'in_progress');
  assert.equal(body.assigned_to, 'worker-q');
});

test('POST /queue/tasks with missing title returns 400', async () => {
  const r = await req('POST', '/queue/tasks', { description: 'no title' });
  assert.equal(r.status, 400);
});

test('GET /queue/tasks/:id returns the task', async () => {
  const created = await req('POST', '/queue/tasks', { title: 'Fetchable', created_by: 'human' }).then(r => r.json());
  const r = await req('GET', `/queue/tasks/${created.id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.id, created.id);
});

test('PATCH /queue/tasks/:id with assigned_to assigns the task', async () => {
  await req('POST', '/agents/spawn', { name: 'worker-assign', workdir: process.cwd() });
  const created = await req('POST', '/queue/tasks', { title: 'To assign', created_by: 'human' }).then(r => r.json());
  const r = await req('PATCH', `/queue/tasks/${created.id}`, { assigned_to: 'worker-assign' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'in_progress');
});

test('PATCH /queue/tasks/:id with status=done completes task', async () => {
  const created = await req('POST', '/queue/tasks', { title: 'To complete', created_by: 'human' }).then(r => r.json());
  await req('PATCH', `/queue/tasks/${created.id}`, { status: 'done', result: 'Finished' });
  const r = await req('GET', `/queue/tasks/${created.id}`);
  assert.equal((await r.json()).status, 'done');
});

test('DELETE /queue/tasks/:id cancels the task', async () => {
  const created = await req('POST', '/queue/tasks', { title: 'To cancel', created_by: 'human' }).then(r => r.json());
  await req('DELETE', `/queue/tasks/${created.id}`);
  const r = await req('GET', `/queue/tasks/${created.id}`);
  assert.equal((await r.json()).status, 'cancelled');
});

test('GET /queue/tasks?status=pending filters correctly', async () => {
  const t = await req('POST', '/queue/tasks', { title: 'Filter test pending', created_by: 'human' }).then(r => r.json());
  await req('POST', '/queue/tasks', { title: 'Filter test other', created_by: 'human' });
  await req('DELETE', `/queue/tasks/${t.id}`); // cancel first one
  const r = await req('GET', '/queue/tasks?status=pending');
  const list = await r.json();
  assert.ok(list.every(task => task.status === 'pending'), 'all returned tasks should be pending');
});

test('GET /queue/tasks?created_by= filters by creator', async () => {
  await req('POST', '/queue/tasks', { title: 'Orch task', created_by: 'orch-99' });
  await req('POST', '/queue/tasks', { title: 'Human task', created_by: 'human-1' });
  const r = await req('GET', '/queue/tasks?created_by=orch-99');
  assert.equal(r.status, 200);
  const list = await r.json();
  assert.ok(list.every(t => t.created_by === 'orch-99'), 'should only return orch-99 tasks');
});

test('PATCH /queue/tasks/:id with assigned_to on in_progress task returns 409', async () => {
  await req('POST', '/agents/spawn', { name: 'worker-409', workdir: process.cwd() });
  const created = await req('POST', '/queue/tasks', { title: 'Already assigned', assigned_to: 'worker-409', created_by: 'human' }).then(r => r.json());
  assert.equal(created.status, 'in_progress');
  const r = await req('PATCH', `/queue/tasks/${created.id}`, { assigned_to: 'worker-409b' });
  assert.equal(r.status, 409);
});

test('GET /orchestrations returns empty array initially', async () => {
  const r = await req('GET', '/orchestrations');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('POST /orchestrations creates orchestration and spawns agent (test mode skips spawn)', async () => {
  const r = await req('POST', '/orchestrations', {
    goal: 'Build a simple CLI tool',
    workdir: process.cwd(),
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok(body.id, 'id missing');
  assert.ok(body.agentName.startsWith('orch-'), 'agentName should start with orch-');
  assert.equal(body.goal, 'Build a simple CLI tool');
});

test('POST /orchestrations with missing goal returns 400', async () => {
  const r = await req('POST', '/orchestrations', { workdir: process.cwd() });
  assert.equal(r.status, 400);
});

test('GET /orchestrations/:id returns the orchestration', async () => {
  const created = await req('POST', '/orchestrations', {
    goal: 'Fetch test goal', workdir: process.cwd(),
  }).then(r => r.json());
  const r = await req('GET', `/orchestrations/${created.id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.goal, 'Fetch test goal');
});

test('GET /orchestrations/:id/scratchpad returns scratchpad content', async () => {
  const created = await req('POST', '/orchestrations', {
    goal: 'Scratchpad test', workdir: process.cwd(),
  }).then(r => r.json());
  const r = await req('GET', `/orchestrations/${created.id}/scratchpad`);
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('content-type').includes('text/plain'), 'content-type should be text/plain');
  const text = await r.text();
  assert.ok(typeof text === 'string', 'response should be a string');
  assert.ok(text.includes('Scratchpad test'), 'scratchpad should contain goal');
});

test('POST /orchestrations/:id/scratchpad appends content', async () => {
  const created = await req('POST', '/orchestrations', {
    goal: 'Append test', workdir: process.cwd(),
  }).then(r => r.json());
  await req('POST', `/orchestrations/${created.id}/scratchpad`, { text: '\nAppended line.\n' });
  const r = await req('GET', `/orchestrations/${created.id}/scratchpad`);
  const text = await r.text();
  assert.ok(text.includes('Appended line.'));
});

test('GET /orchestrations/:id returns 404 for unknown id', async () => {
  const r = await req('GET', '/orchestrations/99999');
  assert.equal(r.status, 404);
});

test('POST /orchestrations with missing workdir returns 400', async () => {
  const r = await req('POST', '/orchestrations', { goal: 'x' });
  assert.equal(r.status, 400);
});

// --- API Key routes ---

test('GET /api-keys returns 5 seeded rows with no key_value field', async () => {
  const r = await req('GET', '/api-keys');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.length, 5);
  assert.ok(body.some(k => k.name === 'anthropic'));
  assert.ok(body.every(k => !('key_value' in k)), 'raw key must never be exposed');
  assert.ok(body.every(k => 'masked' in k), 'every row must have masked field');
});

test('GET /api-keys/:name/value returns 404 when no key configured', async () => {
  const r = await req('GET', '/api-keys/anthropic/value');
  assert.equal(r.status, 404);
});

test('PATCH /api-keys/:name sets key then GET /value returns it', async () => {
  await req('PATCH', '/api-keys/openai', { key_value: 'sk-test-openai-1234567890ab' });
  const r = await req('GET', '/api-keys/openai/value');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).value, 'sk-test-openai-1234567890ab');
});

test('PATCH /api-keys/:name returns 404 for unknown provider', async () => {
  const r = await req('PATCH', '/api-keys/does-not-exist', { key_value: 'x' });
  assert.equal(r.status, 404);
});

test('POST /api-keys creates custom provider and returns 201 with masked row', async () => {
  const r = await req('POST', '/api-keys', {
    name: 'custom-llm', label: 'Custom LLM', env_var: 'CUSTOM_KEY',
    key_value: 'ck-test-1234567890abcd',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.name, 'custom-llm');
  assert.equal(body.has_db_key, true);
  assert.ok(!('key_value' in body), 'key_value must not be in 201 response');
});

test('POST /api-keys returns 409 on duplicate name', async () => {
  const r = await req('POST', '/api-keys', { name: 'anthropic', label: 'Dup' });
  assert.equal(r.status, 409);
});

test('POST /api-keys returns 400 on missing label', async () => {
  const r = await req('POST', '/api-keys', { name: 'no-label' });
  assert.equal(r.status, 400);
});

test('POST /api-keys returns 400 on invalid name slug', async () => {
  const r = await req('POST', '/api-keys', { name: 'Bad Name!', label: 'Bad' });
  assert.equal(r.status, 400);
});

test('DELETE /api-keys/:name returns 403 for seeded provider', async () => {
  const r = await req('DELETE', '/api-keys/anthropic');
  assert.equal(r.status, 403);
});

test('DELETE /api-keys/:name removes custom provider and returns 204', async () => {
  await req('POST', '/api-keys', { name: 'to-delete', label: 'Delete Me' });
  const r = await req('DELETE', '/api-keys/to-delete');
  assert.equal(r.status, 204);
  const list = await req('GET', '/api-keys').then(r => r.json());
  assert.ok(!list.some(k => k.name === 'to-delete'));
});

test('DELETE /api-keys/:name returns 404 for unknown provider', async () => {
  const r = await req('DELETE', '/api-keys/unknown-xyz-999');
  assert.equal(r.status, 404);
});

test('GET /queue/config returns defaultAgent empty string by default', async () => {
  const r = await req('GET', '/queue/config');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).defaultAgent, '');
});

test('PATCH /queue/config persists defaultAgent', async () => {
  const patch = await req('PATCH', '/queue/config', { defaultAgent: 'my-worker' });
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).defaultAgent, 'my-worker');
  const get = await req('GET', '/queue/config');
  assert.equal((await get.json()).defaultAgent, 'my-worker');
});

test('POST /agents/spawn with role registers agent with that role', async () => {
  const r = await req('POST', '/agents/spawn', {
    name: 'qa-agent', workdir: 'C:/flint', role: 'tester',
  });
  assert.equal(r.status, 200);
  const agents = await req('GET', '/agents');
  const qa = (await agents.json()).find(a => a.name === 'qa-agent');
  assert.ok(qa, 'agent not found');
  assert.equal(qa.role, 'tester');
});

test('GET /api/memory returns 503 when Supabase not configured', async () => {
  const r = await req('GET', '/api/memory');
  assert.equal(r.status, 503);
});

test('POST /api/memory/search returns 503 when Supabase not configured', async () => {
  const r = await req('POST', '/api/memory/search', { query: 'test' });
  assert.equal(r.status, 503);
});

test('POST /api/memory/session returns 503 when Supabase not configured', async () => {
  const r = await req('POST', '/api/memory/session');
  assert.equal(r.status, 503);
});

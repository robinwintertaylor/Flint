import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initDb, getTodayCost, getMonthCost, closeDb, upsertAgentLog, setAgentWorktree, getAgentWorktree, setAgentPR, clearAgentPR, getAgentPR, listOpenPRAgents, clearAgentWorktree, listWorkspaces, addWorkspace, removeWorkspace } from './db.js';
import { initAgents, registerAgent, listAgents, getAgent, addWsClient, removeWsClient, killAgent, removeAgent, broadcastToAgent, addGlobalWsClient, removeGlobalWsClient } from './agents.js';
import { listSuggestions, updateSuggestion } from './suggestions.js';
import { listWorktrees, createWorktree, discardWorktree } from './worktrees.js';
import { spawnAgent, writeToAgent, observeLogFile } from './terminal.js';
import { readTasks, writeTasks, appendTask } from './tasks.js';
import { listProjects, getProject, createProject, updateProject, linkAgent, unlinkAgent } from './projects.js';
import { isForgejoReachable, pushBranch, createPR, getPRStatus } from './forgejo.js';
import { detectProvider, isGitHubReachable, pushToGitHub, createGitHubPR, getGitHubPRStatus } from './github.js';
import { info, error as logError } from './logger.js';
import { listMcpServers, addMcpServer, updateMcpServer, removeMcpServer } from './mcp.js';
import { listQueueTasks, getQueueTask, createQueueTask, assignQueueTask, updateQueueTask, completeQueueTask, cancelQueueTask, startQueuePoller } from './queue.js';
import { createOrchestration, getOrchestration, listOrchestrations, appendScratchpad, readScratchpad } from './orchestrator.js';
import { listApiKeys, getApiKeyValue, createApiKey, updateApiKey, deleteApiKey } from './apikeys.js';
import { initTelegram } from './telegram.js';
import { isOllamaReachable, listModels, generate } from './ollama.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const PORT = process.env.PORT ?? 3000;
const TEST_MODE = process.env.FLINT_TEST_MODE === '1';

export { closeDb } from './db.js';

async function createPRForAgent(name, branch) {
  try {
    info('creating PR', { agent: name, branch });
    const worktree = getAgentWorktree(name);
    const workdir = worktree?.worktree_path ?? FLINT_ROOT;
    const provider = detectProvider(workdir);

    if (provider === 'github') {
      const reachable = await isGitHubReachable();
      if (!reachable) {
        logError('PR creation skipped — GitHub unreachable', { agent: name });
        broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
        return;
      }
      pushToGitHub(branch, workdir);
      const { prNumber, prUrl } = await createGitHubPR(branch, name, workdir);
      setAgentPR(name, prNumber, prUrl, 'open');
      broadcastToAgent(name, { type: 'worktree_pr', agent: name, prUrl, prNumber });
      info('PR created', { agent: name, prNumber, prUrl });
    } else {
      const reachable = await isForgejoReachable();
      if (!reachable) {
        logError('PR creation skipped — Forgejo unreachable', { agent: name });
        broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
        return;
      }
      pushBranch(branch);
      const { prNumber, prUrl } = await createPR(branch, name);
      setAgentPR(name, prNumber, prUrl, 'open');
      broadcastToAgent(name, { type: 'worktree_pr', agent: name, prUrl, prNumber });
      info('PR created', { agent: name, prNumber, prUrl });
    }
  } catch (err) {
    logError('PR creation failed', { agent: name, err: err.message });
    broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
  }
}

async function handlePRMerged(name) {
  try {
    const worktree = getAgentWorktree(name);
    if (worktree?.worktree_path) {
      execSync(`git worktree remove --force "${worktree.worktree_path}"`, { cwd: FLINT_ROOT });
    }
    if (worktree?.worktree_branch) {
      try { execSync(`git branch -D "${worktree.worktree_branch}"`, { cwd: FLINT_ROOT }); } catch {}
    }
  } catch (err) {
    logError('cleanup after PR merge failed', { agent: name, err: err.message });
  }
  clearAgentWorktree(name);
  clearAgentPR(name);
}

export function createApp() {
  // Init subsystems
  initDb(process.env.FLINT_DB_PATH);
  initAgents(process.env.FLINT_AGENTS_FILE);
  if (!TEST_MODE) startQueuePoller();
  if (!TEST_MODE) initTelegram({ writeToAgent, createQueueTask });

  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));
  app.use('/images', express.static(join(FLINT_ROOT, 'images')));

  // --- REST routes ---

  app.get('/config', (_req, res) => {
    res.json({ defaultWorkdir: process.cwd() });
  });

  app.get('/diffs/:agent', (req, res) => {
    const worktree = getAgentWorktree(req.params.agent);
    if (!worktree?.worktree_branch) return res.status(404).json({ error: 'no worktree for this agent' });
    try {
      const diff = execSync(
        `git diff master...${worktree.worktree_branch}`,
        { cwd: FLINT_ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
      );
      const stat = execSync(
        `git diff --stat master...${worktree.worktree_branch}`,
        { cwd: FLINT_ROOT, encoding: 'utf8' }
      );
      res.json({ branch: worktree.worktree_branch, stat: stat.trim(), diff: diff.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/agents', (_req, res) => {
    res.json(listAgents());
  });

  app.get('/agents/:name', (req, res) => {
    const agent = getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'not found' });
    const { name, mode, status, workdir, model, runtime } = agent;
    res.json({ name, mode, status, workdir, model: model ?? '', runtime: runtime ?? 'claude' });
  });

  app.get('/workspaces', (_req, res) => res.json(listWorkspaces()));
  app.post('/workspaces', (req, res) => {
    const { name, path } = req.body ?? {};
    if (!name || !path) return res.status(400).json({ error: 'name and path required' });
    try {
      const r = addWorkspace(name, path);
      res.json({ id: r.lastInsertRowid, name, path });
    } catch {
      res.status(409).json({ error: 'workspace path already registered' });
    }
  });
  app.delete('/workspaces/:id', (req, res) => {
    removeWorkspace(Number(req.params.id));
    res.json({ ok: true });
  });

  // --- MCP server routes ---

  app.get('/mcp/servers', (_req, res) => res.json(listMcpServers()));

  app.post('/mcp/servers', (req, res) => {
    const { name, command, args = [], env = {}, scope = 'global', enabled = 1 } = req.body ?? {};
    if (!name || !command) return res.status(400).json({ error: 'name and command required' });
    try {
      const id = addMcpServer({ name, command, args, env, scope, enabled });
      res.status(201).json({ id, name, command, args, env, scope, enabled });
    } catch {
      res.status(409).json({ error: 'server name already registered' });
    }
  });

  app.patch('/mcp/servers/:id', (req, res) => {
    updateMcpServer(Number(req.params.id), req.body ?? {});
    res.json({ ok: true });
  });

  app.delete('/mcp/servers/:id', (req, res) => {
    const changes = removeMcpServer(Number(req.params.id));
    if (!changes) return res.status(404).json({ error: 'server not found' });
    res.json({ ok: true });
  });

  // --- Task queue routes ---

  app.get('/queue/tasks', (req, res) => {
    const { status, assigned_to, role, project_id, created_by } = req.query;
    res.json(listQueueTasks({
      ...(status      ? { status }      : {}),
      ...(assigned_to ? { assigned_to } : {}),
      ...(role        ? { role }         : {}),
      ...(project_id  ? { project_id: Number(project_id) } : {}),
      ...(created_by  ? { created_by }  : {}),
    }));
  });

  app.get('/queue/tasks/:id', (req, res) => {
    const task = getQueueTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json(task);
  });

  app.post('/queue/tasks', (req, res) => {
    const { title, description, project_id, assigned_to, role, priority, created_by } = req.body ?? {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const task = createQueueTask({ title, description, project_id, assigned_to, role, priority, created_by });
    res.status(201).json(task);
  });

  app.patch('/queue/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    const task = getQueueTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const { assigned_to, status, result, priority, description } = req.body ?? {};
    if (assigned_to !== undefined) {
      try {
        return res.json(assignQueueTask(id, assigned_to));
      } catch (err) {
        if (err.message.includes('already')) return res.status(409).json({ error: err.message });
        return res.status(500).json({ error: err.message });
      }
    }
    if (status === 'done')      { completeQueueTask(id, result ?? ''); return res.json(getQueueTask(id)); }
    if (status === 'cancelled') { cancelQueueTask(id); return res.json(getQueueTask(id)); }
    if (priority !== undefined || description !== undefined) {
      updateQueueTask(id, { ...(priority !== undefined ? { priority } : {}), ...(description !== undefined ? { description } : {}) });
    }
    res.json(getQueueTask(id));
  });

  app.delete('/queue/tasks/:id', (req, res) => {
    const task = getQueueTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    cancelQueueTask(Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/agents/spawn', (req, res) => {
    const { name, workdir, model, runtime } = req.body ?? {};
    if (!name || !workdir) return res.status(400).json({ error: 'name and workdir required' });
    registerAgent(name, 'spawn', workdir, null, model ?? '', runtime ?? 'claude');
    if (!TEST_MODE) spawnAgent(name, workdir, model ?? null, { onWorktreePending: createPRForAgent });
    res.json({ ok: true, name });
  });

  app.post('/agents/observe', (req, res) => {
    const { name, logPath } = req.body ?? {};
    if (!name || !logPath) return res.status(400).json({ error: 'name and logPath required' });
    registerAgent(name, 'observe', null, logPath);
    if (!TEST_MODE) observeLogFile(name, logPath);
    res.json({ ok: true, name });
  });

  app.post('/agents/attach', (_req, res) => {
    res.status(501).json({ error: 'Attach by PID not supported on Windows — use observe mode with attach.ps1 instead' });
  });

  app.delete('/agents/:name', (req, res) => {
    res.json({ ok: removeAgent(req.params.name) });
  });

  app.get('/tasks/:agent', (req, res) => {
    res.json({ content: readTasks(req.params.agent) });
  });

  app.patch('/tasks/:agent', (req, res) => {
    const { content } = req.body ?? {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    writeTasks(req.params.agent, content);
    broadcastToAgent(req.params.agent, { type: 'tasks', agent: req.params.agent, content });
    res.json({ ok: true });
  });

  app.post('/tasks/:agent', (req, res) => {
    const { task } = req.body ?? {};
    if (!task) return res.status(400).json({ error: 'task required' });
    appendTask(req.params.agent, task);
    const content = readTasks(req.params.agent);
    broadcastToAgent(req.params.agent, { type: 'tasks', agent: req.params.agent, content });
    res.json({ ok: true });
  });

  app.get('/costs', (_req, res) => {
    const agents = listAgents();
    const costs = agents.map(({ name }) => ({ agent: name, today: getTodayCost(name) }));
    res.json({ costs, monthTotal: getMonthCost() });
  });

  app.get('/router/models', async (_req, res) => {
    try {
      const r = await fetch('http://localhost:3001/llm/models');
      const data = await r.json();
      res.json(data);
    } catch {
      res.json({ error: 'router not running' });
    }
  });

  app.get('/router/config', async (_req, res) => {
    try {
      const r = await fetch('http://localhost:3001/llm/config');
      const data = await r.json();
      res.json(data);
    } catch {
      res.json({ error: 'router not running' });
    }
  });

  // --- Health ---

  app.get('/health', async (_req, res) => {
    const [forgejoOk, ollamaOk] = await Promise.all([isForgejoReachable(), isOllamaReachable()]);
    res.json({
      status: forgejoOk ? 'ok' : 'degraded',
      uptime: Math.floor(process.uptime()),
      db: 'connected',
      forgejo: forgejoOk ? 'reachable' : 'unreachable',
      ollama:  ollamaOk  ? 'reachable' : 'unreachable',
    });
  });

  // --- Ollama routes ---

  app.get('/api/ollama/status', async (_req, res) => {
    const reachable = await isOllamaReachable();
    const models = reachable ? await listModels() : [];
    res.json({ reachable, models });
  });

  app.post('/api/ollama/generate', async (req, res) => {
    const { model, prompt } = req.body ?? {};
    if (!model || !prompt) return res.status(400).json({ error: 'model and prompt required' });
    try {
      const response = await generate(model, prompt);
      res.json({ response });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Project routes ---

  app.get('/projects', (_req, res) => {
    res.json(listProjects());
  });

  app.get('/projects/:id', (req, res) => {
    const p = getProject(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'project not found' });
    res.json(p);
  });

  app.post('/projects', (req, res) => {
    const { name, notes } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      const id = createProject({ name, notes: notes ?? '' });
      res.status(201).json(getProject(id));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'project name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/projects/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    const { name, status, notes } = req.body ?? {};
    const VALID_STATUSES = ['active', 'paused', 'done', 'archived'];
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (status !== undefined) fields.status = status;
    if (notes !== undefined) fields.notes = notes;
    if (Object.keys(fields).length) updateProject(id, fields);
    res.json(getProject(id));
  });

  app.delete('/projects/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    updateProject(id, { status: 'archived' });
    res.json({ ok: true });
  });

  app.post('/projects/:id/agents', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    const { agentName } = req.body ?? {};
    if (!agentName) return res.status(400).json({ error: 'agentName required' });
    linkAgent(id, agentName);
    res.json({ ok: true });
  });

  app.delete('/projects/:id/agents/:agentName', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    unlinkAgent(id, req.params.agentName);
    res.json({ ok: true });
  });

  // --- Suggestion routes ---

  app.get('/suggestions', (_req, res) => {
    res.json(listSuggestions());
  });

  app.patch('/suggestions/:id', (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    const VALID = ['new', 'noted', 'dismissed'];
    if (!VALID.includes(status)) return res.status(400).json({ error: 'invalid status' });
    updateSuggestion(id, { status });
    res.json({ ok: true });
  });

  // --- Worktree routes ---

  app.get('/worktrees', (_req, res) => {
    res.json(listWorktrees());
  });

  app.delete('/worktrees/:agent', (req, res) => {
    try {
      discardWorktree(req.params.agent);
      broadcastToAgent(req.params.agent, { type: 'worktree_discarded', agent: req.params.agent });
      res.json({ ok: true });
    } catch (err) {
      if (err.message.includes('No worktree')) return res.status(404).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // --- Orchestration routes ---

  app.get('/orchestrations', (_req, res) => res.json(listOrchestrations()));

  app.get('/orchestrations/:id', (req, res) => {
    const orch = getOrchestration(Number(req.params.id));
    if (!orch) return res.status(404).json({ error: 'orchestration not found' });
    res.json(orch);
  });

  app.post('/orchestrations', (req, res) => {
    const { goal, workdir, model, project_id } = req.body ?? {};
    if (!goal || !workdir) return res.status(400).json({ error: 'goal and workdir required' });
    try {
      const result = createOrchestration({ goal, workdir, model, projectId: project_id });
      res.status(201).json({ ...result, goal, status: 'running' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/orchestrations/:id/scratchpad', (req, res) => {
    const orch = getOrchestration(Number(req.params.id));
    if (!orch) return res.status(404).json({ error: 'orchestration not found' });
    res.type('text/plain').send(readScratchpad(Number(req.params.id)));
  });

  app.post('/orchestrations/:id/scratchpad', (req, res) => {
    const orch = getOrchestration(Number(req.params.id));
    if (!orch) return res.status(404).json({ error: 'orchestration not found' });
    const { text } = req.body ?? {};
    if (typeof text !== 'string') return res.status(400).json({ error: 'text required' });
    appendScratchpad(Number(req.params.id), text);
    res.json({ ok: true });
  });

  // --- API Key routes ---

  app.get('/api-keys', (_req, res) => res.json(listApiKeys()));

  app.get('/api-keys/:name/value', (req, res) => {
    const value = getApiKeyValue(req.params.name);
    if (value === null) return res.status(404).json({ error: `No key configured for ${req.params.name}` });
    res.json({ value });
  });

  app.post('/api-keys', (req, res) => {
    const { name, label, key_value, env_var } = req.body ?? {};
    if (!name || !label) return res.status(400).json({ error: 'name and label required' });
    try {
      createApiKey({ name, label, key_value, env_var });
      const created = listApiKeys().find(r => r.name === name);
      res.status(201).json(created);
    } catch (err) {
      if (err.message === 'name already exists') return res.status(409).json({ error: err.message });
      if (err.message.includes('alphanumeric')) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.patch('/api-keys/:name', (req, res) => {
    const changes = updateApiKey(req.params.name, req.body ?? {});
    if (!changes) return res.status(404).json({ error: 'provider not found' });
    const updated = listApiKeys().find(r => r.name === req.params.name);
    res.json(updated);
  });

  app.delete('/api-keys/:name', (req, res) => {
    try {
      const changes = deleteApiKey(req.params.name);
      if (!changes) return res.status(404).json({ error: 'provider not found' });
      res.status(204).send();
    } catch (err) {
      if (err.message.includes('seeded')) return res.status(403).json({ error: err.message });
      throw err;
    }
  });

  // --- WebSocket ---
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    addGlobalWsClient(ws);
    ws.on('error', () => {}); // prevent unhandled error events on connection failures

    function safeSend(ws, obj) {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    }

    const subscriptions = new Set();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'agents':
          safeSend(ws, { type: 'agents', list: listAgents() });
          break;

        case 'subscribe': {
          const name = msg.agent;
          subscriptions.add(name);
          addWsClient(name, ws);
          safeSend(ws, { type: 'tasks', agent: name, content: readTasks(name) });
          const agent = getAgent(name);
          if (agent) safeSend(ws, { type: 'status', agent: name, status: agent.status });
          break;
        }

        case 'input':
          writeToAgent(msg.agent, msg.data);
          break;

        case 'spawn': {
          const { agent: name, workdir, model, isolate, runtime } = msg;
          if (!name || !workdir) break;
          registerAgent(name, 'spawn', workdir, null, model, runtime ?? 'claude');
          upsertAgentLog(name, { mode: 'spawn', workdir, status: 'running' });
          if (!TEST_MODE) {
            let spawnDir = workdir;
            if (isolate) {
              try {
                const { worktreePath, branch } = createWorktree(name);
                setAgentWorktree(name, worktreePath, branch);
                spawnDir = worktreePath;
              } catch (err) {
                logError('worktree creation failed', { agent: name, err: err.message });
                broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
                break;
              }
            }
            spawnAgent(name, spawnDir, model, { onWorktreePending: createPRForAgent });
          }
          broadcastToAgent(name, { type: 'status', agent: name, status: 'running' });
          break;
        }

        case 'kill':
          killAgent(msg.agent);
          break;

        case 'tasks_get': {
          const content = readTasks(msg.agent);
          safeSend(ws, { type: 'tasks', agent: msg.agent, content });
          break;
        }

        case 'tasks_set': {
          writeTasks(msg.agent, msg.content);
          broadcastToAgent(msg.agent, { type: 'tasks', agent: msg.agent, content: msg.content });
          break;
        }
      }
    });

    ws.on('close', () => {
      removeGlobalWsClient(ws);
      for (const name of subscriptions) removeWsClient(name, ws);
    });
  });

  if (!TEST_MODE) {
    const prPollInterval = setInterval(async () => {
      const agents = listOpenPRAgents();
      for (const { name, pr_number } of agents) {
        try {
          const current = getAgentPR(name);
          const status = current?.pr_url?.includes('github.com')
            ? await getGitHubPRStatus(pr_number, current.pr_url)
            : await getPRStatus(pr_number);
          if (current && current.pr_status !== status) {
            setAgentPR(name, pr_number, current.pr_url, status);
            broadcastToAgent(name, { type: 'pr_status', agent: name, status });
            if (status === 'merged') await handlePRMerged(name);
            else if (status === 'closed') clearAgentPR(name);
          }
        } catch (err) {
          logError('PR poll failed', { agent: name, err: err.message });
        }
      }
    }, 30_000);
    httpServer.on('close', () => clearInterval(prPollInterval));
  }

  return httpServer;
}

// Only start server when run directly (not imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createApp();
  server.listen(PORT, () => {
    console.log(`Flint Dashboard → http://localhost:${PORT}`);
  });
}

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initDb, getTodayCost, getMonthCost, closeDb } from './db.js';
import { initAgents, registerAgent, listAgents, getAgent, addWsClient, removeWsClient, killAgent, broadcastToAgent } from './agents.js';
import { spawnAgent, writeToAgent, observeLogFile } from './terminal.js';
import { readTasks, writeTasks, appendTask } from './tasks.js';
import {
  listProjects, getProject, createProject, updateProject,
  linkAgent, unlinkAgent,
} from './projects.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3000;
const TEST_MODE = process.env.FLINT_TEST_MODE === '1';

export { closeDb } from './db.js';

export function createApp() {
  // Init subsystems
  initDb(process.env.FLINT_DB_PATH);
  initAgents(process.env.FLINT_AGENTS_FILE);

  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // --- REST routes ---

  app.get('/agents', (_req, res) => {
    res.json(listAgents());
  });

  app.post('/agents/spawn', (req, res) => {
    const { name, workdir } = req.body ?? {};
    if (!name || !workdir) return res.status(400).json({ error: 'name and workdir required' });
    registerAgent(name, 'spawn', workdir);
    if (!TEST_MODE) spawnAgent(name, workdir);
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
    res.json({ ok: killAgent(req.params.name) });
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

  // --- WebSocket ---
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
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
          const { agent: name, workdir, model } = msg;
          if (!name || !workdir) break;
          registerAgent(name, 'spawn', workdir, null, model);
          if (!TEST_MODE) spawnAgent(name, workdir, model);
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
      for (const name of subscriptions) removeWsClient(name, ws);
    });
  });

  return httpServer;
}

// Only start server when run directly (not imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createApp();
  server.listen(PORT, () => {
    console.log(`Flint Dashboard → http://localhost:${PORT}`);
  });
}

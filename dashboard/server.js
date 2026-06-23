import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initDb, getTodayCost, getMonthCost, closeDb } from './db.js';
import { initAgents, registerAgent, listAgents, getAgent, addWsClient, removeWsClient, killAgent, broadcastToAgent } from './agents.js';
import { spawnAgent, writeToAgent, observeLogFile } from './terminal.js';
import { readTasks, writeTasks, appendTask } from './tasks.js';

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

  // --- WebSocket ---
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    const subscriptions = new Set();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'agents':
          ws.send(JSON.stringify({ type: 'agents', list: listAgents() }));
          break;

        case 'subscribe': {
          const name = msg.agent;
          subscriptions.add(name);
          addWsClient(name, ws);
          ws.send(JSON.stringify({ type: 'tasks', agent: name, content: readTasks(name) }));
          const agent = getAgent(name);
          if (agent) ws.send(JSON.stringify({ type: 'status', agent: name, status: agent.status }));
          break;
        }

        case 'input':
          writeToAgent(msg.agent, msg.data);
          break;

        case 'spawn': {
          const { agent: name, workdir } = msg;
          if (!name || !workdir) break;
          registerAgent(name, 'spawn', workdir);
          if (!TEST_MODE) spawnAgent(name, workdir);
          broadcastToAgent(name, { type: 'status', agent: name, status: 'running' });
          break;
        }

        case 'kill':
          killAgent(msg.agent);
          break;

        case 'tasks_get': {
          const content = readTasks(msg.agent);
          ws.send(JSON.stringify({ type: 'tasks', agent: msg.agent, content }));
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

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { route } from './router.js';
import { getModels, getConfig } from './config.js';
import { initDb, getCostsByProvider } from '../dashboard/db.js';
import { buildApiKeyEnv } from '../dashboard/apikeys.js';

function aggregateCosts(rows) {
  const cfg = getConfig();
  const out = {};
  for (const row of rows) {
    let provider;
    outer: for (const tierModels of Object.values(cfg.tiers)) {
      for (const [p, m] of Object.entries(tierModels)) {
        if (m === row.model) { provider = p; break outer; }
      }
    }
    provider = provider ?? 'unknown';
    out[provider] = (out[provider] ?? 0) + row.total;
  }
  return out;
}

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.post('/llm/complete', async (req, res) => {
    const { taskType, prompt, systemPrompt, model, provider } = req.body ?? {};
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    try {
      const result = await route(taskType, prompt, { model, provider, systemPrompt });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/llm/models', (_req, res) => {
    res.json(getModels());
  });

  app.get('/llm/config', (_req, res) => {
    res.json(getConfig());
  });

  app.get('/llm/costs', (_req, res) => {
    const { todayRows, monthRows } = getCostsByProvider();
    const today = aggregateCosts(todayRows);
    const month = aggregateCosts(monthRows);
    const totalToday = Object.values(today).reduce((s, v) => s + v, 0);
    const totalMonth = Object.values(month).reduce((s, v) => s + v, 0);
    res.json({ today, month, totalToday, totalMonth });
  });

  const httpServer = createServer(app);
  return httpServer;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initDb();
  Object.assign(process.env, buildApiKeyEnv());
  const server = createApp();
  server.listen(3001, () => console.log('[router] listening on port 3001'));
}

import { resolveRoute, getConfig } from './config.js';
import { complete } from './providers.js';
import { initDb, writeUsage } from '../dashboard/db.js';

// Initialise DB (uses FLINT_DB_PATH env or default path)
initDb(process.env.FLINT_DB_PATH);

export async function route(taskType, prompt, opts = {}) {
  const { model: explicitModel, provider: explicitProvider, systemPrompt } = opts;

  let provider, model;
  if (explicitModel) {
    const cfg = getConfig();
    provider = explicitProvider ?? cfg.defaultProvider;
    model    = explicitModel;
  } else {
    const resolved = resolveRoute(taskType, explicitProvider);
    provider = resolved.provider;
    model    = resolved.model;
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const start = Date.now();
  const { text, costUsd } = await complete(provider, model, messages);
  const durationMs = Date.now() - start;

  writeUsage({ agentName: taskType ?? 'router', model, costUsd });

  return { text, model, provider, costUsd, durationMs };
}

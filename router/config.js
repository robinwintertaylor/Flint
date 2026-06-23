import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');

let _config = null;

function loadConfig() {
  const cfgPath = process.env.FLINT_ROUTER_CONFIG ?? join(FLINT_ROOT, 'router.json');
  _config = JSON.parse(readFileSync(cfgPath, 'utf8'));
  return _config;
}

export function getConfig() {
  return _config ?? loadConfig();
}

export function resetConfig() {
  _config = null;
}

export function resolveRoute(taskType, providerOverride) {
  const cfg = getConfig();
  const taskDef = cfg.taskTypes[taskType];
  const tier    = String(taskDef?.tier ?? cfg.defaultTier);
  const provider = providerOverride ?? taskDef?.provider ?? cfg.defaultProvider;
  const model    = cfg.tiers[tier][provider];
  return { provider, model, tier: Number(tier) };
}

export function getModels() {
  const cfg = getConfig();
  const result = { anthropic: [], openai: [], google: [], azure: [], openrouter: [] };
  for (const tierModels of Object.values(cfg.tiers)) {
    for (const [provider, model] of Object.entries(tierModels)) {
      if (result[provider] && !result[provider].includes(model)) {
        result[provider].push(model);
      }
    }
  }
  return result;
}

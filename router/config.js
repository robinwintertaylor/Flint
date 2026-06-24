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
  if (!model) throw new Error(`No model configured for provider "${provider}" at tier ${tier}`);
  return { provider, model, tier: Number(tier) };
}

function configuredProviders() {
  const set = new Set();
  if (process.env.ANTHROPIC_API_KEY)  set.add('anthropic');
  if (process.env.OPENAI_API_KEY)     set.add('openai');
  if (process.env.GOOGLE_API_KEY)     set.add('google');
  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) set.add('azure');
  if (process.env.OPENROUTER_API_KEY) set.add('openrouter');
  return set;
}

export function getModels() {
  const cfg = getConfig();
  const CLI_PROVIDERS = new Set(['claude-cli', 'gemini-cli', 'mistral-cli']);
  const active = configuredProviders();

  const result = { cli: [] };
  for (const p of active) result[p] = [];

  for (const tierModels of Object.values(cfg.tiers)) {
    for (const [provider, model] of Object.entries(tierModels)) {
      if (CLI_PROVIDERS.has(provider)) {
        if (!result.cli.includes(model)) result.cli.push(model);
      } else if (result[provider] && !result[provider].includes(model)) {
        result[provider].push(model);
      }
    }
  }
  return result;
}

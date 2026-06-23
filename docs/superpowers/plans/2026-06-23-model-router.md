# Multi-LLM Model Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-provider LLM gateway (router service on port 3001), tier-based task routing, cron daemon for scheduled automations, CLI tool, and dashboard model picker — all wired together with a root launcher.

**Architecture:** Three Node.js processes run side-by-side: the existing dashboard (port 3000), a new router Express server (port 3001), and a new cron daemon. All share `usage.sqlite` and `.env` at the Flint root. The router provides a unified `complete(provider, model, messages)` interface across 5 providers; a `router.json` config drives tier-based model selection; the CLI and dashboard both call the router at `http://localhost:3001`.

**Tech Stack:** Node.js 20+ ESM, Express 4, `@anthropic-ai/sdk`, `openai` (reused for OpenRouter), `@google/genai`, `@azure/openai`, `node-cron`, `dotenv`, `node:test` + `node:assert/strict`

## Global Constraints

- Node.js 20+, ESM throughout (`"type": "module"` in every package.json)
- `import`/`export` everywhere — no `require()`
- `__dirname` via `dirname(fileURLToPath(import.meta.url))`
- `FLINT_TEST_MODE=1` returns stub responses in providers (no real API calls in tests)
- `FLINT_ROUTER_CONFIG` env var overrides the path to `router.json` (for config tests)
- `FLINT_DB_PATH` env var overrides `usage.sqlite` path (same pattern as dashboard)
- All tests use `node:test` and `node:assert/strict` — no external test framework
- Root: `C:\Users\Robin\Applications Dev\Flint\`
- Router runs on port 3001; dashboard stays on port 3000
- `createApp()` factory pattern in `router/server.js` — returns `http.Server`, starts only when run directly
- All API keys in `.env` at Flint root; `.env` is gitignored; `.env.example` committed
- Cost estimates stored with `~` prefix meaning (best-effort from token counts × published rates)
- `router.json` lives at Flint root; editable directly, no UI in v1
- `dashboard/db.js` is the shared DB module — router imports it directly
- No streaming responses (deferred to SP5)
- No provider fallback/retry (deferred to SP5)

---

## File Map

**Created:**
- `router/package.json` — router service deps
- `router/server.js` — Express on 3001, createApp() export
- `router/router.js` — route(taskType, prompt, opts) orchestration
- `router/providers.js` — 5 provider adapters, unified complete() interface
- `router/config.js` — load + validate router.json
- `router/tests/router.test.js` — routing logic tests (no real API calls)
- `router/tests/config.test.js` — config validation tests
- `router/tests/server.test.js` — HTTP endpoint tests
- `cron/daemon.js` — node-cron scheduler, reads .cron/schedule.json
- `cron/runner.js` — executes spawn (PTY) and api (router POST) chain entries
- `.cron/schedule.json` — example schedule config
- `bin/flint.js` — CLI: ask, models, config, costs subcommands
- `start.js` — root launcher: spawns dashboard + router + cron
- `router.json` — tier config + task-type overrides
- `.env.example` — placeholder keys (committed)
- `logs/.gitkeep` — ensure logs/ exists in git

**Modified:**
- `package.json` (root) — add `start`, `dashboard`, `router`, `cron` scripts; add `node-pty` dep (shared with dashboard for cron runner)
- `dashboard/db.js` — add `getCostsByProvider()` for GET /llm/costs breakdown
- `dashboard/server.js` — add GET /router/models and GET /router/config proxy routes
- `dashboard/agents.js` — add optional `model` field to agent shape and persistence
- `dashboard/public/app.js` — model picker dropdown in New Agent modal
- `dashboard/public/index.html` — model select element in modal HTML

---

### Task 1: Scaffold — package.json files, router.json, .env.example, directory structure

**Files:**
- Create: `package.json` (root, overwrite/create)
- Create: `router/package.json`
- Create: `router.json`
- Create: `.env.example`
- Create: `logs/.gitkeep`
- Create: `.cron/schedule.json`

**Interfaces:**
- Produces: `router.json` shape consumed by all later tasks

- [ ] **Step 1: Write `router.json` at Flint root**

```json
{
  "tiers": {
    "1": {
      "anthropic":  "claude-haiku-4-5",
      "openai":     "gpt-4o-mini",
      "google":     "gemini-2.0-flash",
      "azure":      "gpt-4o-mini",
      "openrouter": "mistral/mistral-small"
    },
    "2": {
      "anthropic":  "claude-sonnet-4-6",
      "openai":     "gpt-4o",
      "google":     "gemini-2.0-pro",
      "azure":      "gpt-4o",
      "openrouter": "mistral/mistral-medium"
    },
    "3": {
      "anthropic":  "claude-opus-4-6",
      "openai":     "gpt-4.5",
      "google":     "gemini-2.5-pro",
      "azure":      "gpt-4.5",
      "openrouter": "mistral/mistral-large"
    }
  },
  "taskTypes": {
    "heartbeat":       { "tier": 1, "provider": "anthropic" },
    "formatting":      { "tier": 1, "provider": "openai" },
    "classification":  { "tier": 1, "provider": "anthropic" },
    "research":        { "tier": 2, "provider": "anthropic" },
    "content-writing": { "tier": 2, "provider": "anthropic" },
    "code":            { "tier": 2, "provider": "openai" },
    "architecture":    { "tier": 3, "provider": "anthropic" }
  },
  "defaultProvider": "anthropic",
  "defaultTier": 2
}
```

- [ ] **Step 2: Write `.env.example` at Flint root**

```
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
OPENAI_API_KEY=sk-...

# Google
GOOGLE_API_KEY=...

# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://...openai.azure.com
AZURE_OPENAI_KEY=...
AZURE_OPENAI_DEPLOYMENT=gpt-4o

# OpenRouter
OPENROUTER_API_KEY=sk-or-...
```

- [ ] **Step 3: Create root `package.json`**

If a root `package.json` exists, read it first and merge these scripts in; otherwise create fresh:

```json
{
  "name": "flint",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start":     "node start.js",
    "dashboard": "node dashboard/server.js",
    "router":    "node router/server.js",
    "cron":      "node cron/daemon.js"
  },
  "dependencies": {
    "node-pty": "^1.0.0"
  }
}
```

- [ ] **Step 4: Create `router/package.json`**

```json
{
  "name": "flint-router",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "test":  "node --test tests/config.test.js tests/router.test.js tests/server.test.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@azure/openai":     "^2.0.0",
    "@google/genai":     "^0.7.0",
    "dotenv":            "^16.0.0",
    "express":           "^4.19.2",
    "node-cron":         "^3.0.0",
    "openai":            "^4.0.0"
  }
}
```

- [ ] **Step 5: Create directory structure and placeholder files**

```bash
mkdir -p "C:/Users/Robin/Applications Dev/Flint/router/tests"
mkdir -p "C:/Users/Robin/Applications Dev/Flint/cron"
mkdir -p "C:/Users/Robin/Applications Dev/Flint/bin"
mkdir -p "C:/Users/Robin/Applications Dev/Flint/.cron"
mkdir -p "C:/Users/Robin/Applications Dev/Flint/logs"
touch "C:/Users/Robin/Applications Dev/Flint/logs/.gitkeep"
```

- [ ] **Step 6: Create `.cron/schedule.json` example**

```json
{
  "schedules": [
    {
      "name": "Morning Briefing",
      "cron": "0 7 * * 1-5",
      "type": "spawn",
      "chain": ["daily-briefing"],
      "workdir": "C:\\Users\\Robin\\Applications Dev\\Flint",
      "description": "Weekday morning summary — spawns Claude Code session"
    },
    {
      "name": "Weekly Research Digest",
      "cron": "0 9 * * 1",
      "type": "api",
      "taskType": "research",
      "prompt": "Summarise this week's key AI developments relevant to Robin's work",
      "description": "Monday morning research — calls router API directly"
    }
  ]
}
```

- [ ] **Step 7: Run `npm install` in router/**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/router" && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 8: Commit scaffold**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add package.json router/package.json router/node_modules/.package-lock.json router.json .env.example logs/.gitkeep .cron/schedule.json
git commit -m "feat(router): scaffold — package.json files, router.json, .env.example, dirs"
```

---

### Task 2: `router/config.js` — load and validate router.json

**Files:**
- Create: `router/config.js`
- Create: `router/tests/config.test.js`

**Interfaces:**
- Produces:
  - `getConfig() → { tiers, taskTypes, defaultProvider, defaultTier }` — reads from `FLINT_ROUTER_CONFIG` env var path or `<flintRoot>/router.json`
  - `resolveRoute(taskType?, providerOverride?) → { provider, model, tier }` — returns routing decision
  - `getModels() → { anthropic: string[], openai: string[], google: string[], azure: string[], openrouter: string[] }` — all models per provider across all tiers (deduplicated)
  - `resetConfig() → void` — clears cached config (for tests)

- [ ] **Step 1: Write the failing tests**

`router/tests/config.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), 'flint-config-test-' + Date.now());
mkdirSync(TMP, { recursive: true });

const MINIMAL_CONFIG = {
  tiers: {
    '1': { anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini', google: 'gemini-2.0-flash', azure: 'gpt-4o-mini', openrouter: 'mistral/mistral-small' },
    '2': { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', google: 'gemini-2.0-pro', azure: 'gpt-4o', openrouter: 'mistral/mistral-medium' },
    '3': { anthropic: 'claude-opus-4-6', openai: 'gpt-4.5', google: 'gemini-2.5-pro', azure: 'gpt-4.5', openrouter: 'mistral/mistral-large' }
  },
  taskTypes: {
    'research': { tier: 2, provider: 'anthropic' },
    'code':     { tier: 2, provider: 'openai' }
  },
  defaultProvider: 'anthropic',
  defaultTier: 2
};

before(() => {
  const cfgPath = join(TMP, 'router.json');
  writeFileSync(cfgPath, JSON.stringify(MINIMAL_CONFIG));
  process.env.FLINT_ROUTER_CONFIG = cfgPath;
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.FLINT_ROUTER_CONFIG;
});

const { getConfig, resolveRoute, getModels, resetConfig } = await import('../config.js');

test('getConfig returns parsed config', () => {
  const cfg = getConfig();
  assert.equal(cfg.defaultProvider, 'anthropic');
  assert.equal(cfg.defaultTier, 2);
  assert.ok(cfg.tiers['1']);
  assert.ok(cfg.taskTypes['research']);
});

test('resolveRoute uses taskType lookup', () => {
  const r = resolveRoute('research');
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.model, 'claude-sonnet-4-6');
  assert.equal(r.tier, 2);
});

test('resolveRoute allows provider override', () => {
  const r = resolveRoute('research', 'openai');
  assert.equal(r.provider, 'openai');
  assert.equal(r.model, 'gpt-4o');
});

test('resolveRoute falls back to defaults for unknown taskType', () => {
  const r = resolveRoute('unknown-task');
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'claude-sonnet-4-6');
});

test('getModels returns all models per provider', () => {
  const models = getModels();
  assert.ok(Array.isArray(models.anthropic));
  assert.ok(models.anthropic.includes('claude-haiku-4-5'));
  assert.ok(models.anthropic.includes('claude-sonnet-4-6'));
  assert.ok(models.anthropic.includes('claude-opus-4-6'));
  assert.ok(Array.isArray(models.openai));
  assert.ok(Array.isArray(models.google));
  assert.ok(Array.isArray(models.azure));
  assert.ok(Array.isArray(models.openrouter));
});

test('resetConfig clears cache so next getConfig re-reads', () => {
  const cfgPath = join(TMP, 'router2.json');
  const cfg2 = { ...MINIMAL_CONFIG, defaultProvider: 'openai' };
  writeFileSync(cfgPath, JSON.stringify(cfg2));
  process.env.FLINT_ROUTER_CONFIG = cfgPath;
  resetConfig();
  const cfg = getConfig();
  assert.equal(cfg.defaultProvider, 'openai');
  // restore
  const orig = join(TMP, 'router.json');
  process.env.FLINT_ROUTER_CONFIG = orig;
  resetConfig();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/router"
node --test tests/config.test.js
```

Expected: FAIL — `../config.js` not found or export errors.

- [ ] **Step 3: Implement `router/config.js`**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/router"
node --test tests/config.test.js
```

Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add router/config.js router/tests/config.test.js
git commit -m "feat(router): config.js — load router.json, resolveRoute, getModels"
```

---

### Task 3: `router/providers.js` — 5 provider adapters with unified interface

**Files:**
- Create: `router/providers.js`

**Interfaces:**
- Consumes: provider name (string), model name (string), messages array
- Produces:
  - `complete(provider, model, messages) → Promise<{ text, costUsd }>`
  - `messages`: `[{ role: 'system'|'user'|'assistant', content: string }]`
  - In `FLINT_TEST_MODE=1`: returns `{ text: 'stub response', costUsd: 0.001 }` immediately, no API calls

Token cost rates used for estimation (per 1M tokens, input/output):
- anthropic claude-haiku-4-5: $0.80/$4.00; claude-sonnet-4-6: $3.00/$15.00; claude-opus-4-6: $15.00/$75.00
- openai gpt-4o-mini: $0.15/$0.60; gpt-4o: $2.50/$10.00; gpt-4.5: $75.00/$150.00
- google gemini-2.0-flash: $0.075/$0.30; gemini-2.0-pro: $1.25/$5.00; gemini-2.5-pro: $1.25/$10.00
- azure: same rates as openai (deployment maps to same model family)
- openrouter: $0.20/$0.60 (conservative estimate for unknown models)

- [ ] **Step 1: Implement `router/providers.js`**

No failing test for this task (providers make real API calls; test isolation is FLINT_TEST_MODE). Write the implementation and verify it parses without error.

```js
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { AzureOpenAI } from '@azure/openai';

const TEST_MODE = process.env.FLINT_TEST_MODE === '1';

// Per-model cost rates: [inputPer1M, outputPer1M] in USD
const TOKEN_RATES = {
  'claude-haiku-4-5':   [0.80,  4.00],
  'claude-sonnet-4-6':  [3.00,  15.00],
  'claude-opus-4-6':    [15.00, 75.00],
  'gpt-4o-mini':        [0.15,  0.60],
  'gpt-4o':             [2.50,  10.00],
  'gpt-4.5':            [75.00, 150.00],
  'gemini-2.0-flash':   [0.075, 0.30],
  'gemini-2.0-pro':     [1.25,  5.00],
  'gemini-2.5-pro':     [1.25,  10.00],
};
const DEFAULT_RATE = [0.20, 0.60];

function calcCost(model, inputTokens, outputTokens) {
  const [inRate, outRate] = TOKEN_RATES[model] ?? DEFAULT_RATE;
  return (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
}

// Convert unified messages format to Anthropic format
function toAnthropicMessages(messages) {
  const system = messages.find(m => m.role === 'system')?.content;
  const msgs   = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  return { system, msgs };
}

async function completeAnthropic(model, messages) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { system, msgs } = toAnthropicMessages(messages);
  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    ...(system ? { system } : {}),
    messages: msgs,
  });
  const text = res.content.map(b => b.type === 'text' ? b.text : '').join('');
  const costUsd = calcCost(model, res.usage.input_tokens, res.usage.output_tokens);
  return { text, costUsd };
}

async function completeOpenAI(model, messages) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({ model, messages });
  const text = res.choices[0].message.content ?? '';
  const costUsd = calcCost(model, res.usage.prompt_tokens, res.usage.completion_tokens);
  return { text, costUsd };
}

async function completeGoogle(model, messages) {
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  const system = messages.find(m => m.role === 'system')?.content;
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const res = await client.models.generateContent({
    model,
    contents,
    ...(system ? { systemInstruction: system } : {}),
  });
  const text = res.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
  const usage = res.usageMetadata ?? {};
  const costUsd = calcCost(model, usage.promptTokenCount ?? 0, usage.candidatesTokenCount ?? 0);
  return { text, costUsd };
}

async function completeAzure(model, messages) {
  const client = new AzureOpenAI({
    endpoint:   process.env.AZURE_OPENAI_ENDPOINT,
    apiKey:     process.env.AZURE_OPENAI_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? model,
    apiVersion: '2024-10-21',
  });
  const res = await client.chat.completions.create({ model, messages });
  const text = res.choices[0].message.content ?? '';
  const costUsd = calcCost(model, res.usage.prompt_tokens, res.usage.completion_tokens);
  return { text, costUsd };
}

async function completeOpenRouter(model, messages) {
  const client = new OpenAI({
    apiKey:  process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  });
  const res = await client.chat.completions.create({ model, messages });
  const text = res.choices[0].message.content ?? '';
  const costUsd = calcCost(model, res.usage.prompt_tokens, res.usage.completion_tokens);
  return { text, costUsd };
}

const ADAPTERS = {
  anthropic:  completeAnthropic,
  openai:     completeOpenAI,
  google:     completeGoogle,
  azure:      completeAzure,
  openrouter: completeOpenRouter,
};

export async function complete(provider, model, messages) {
  if (TEST_MODE) {
    return { text: 'stub response', costUsd: 0.001 };
  }
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  return adapter(model, messages);
}
```

- [ ] **Step 2: Verify the file parses without errors**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/router"
node --input-type=module <<'EOF'
import './providers.js';
console.log('providers.js loaded OK');
EOF
```

Expected: `providers.js loaded OK` (TEST_MODE not set, but no API calls made on import).

If the import fails because SDK packages aren't installed yet, run `npm install` first.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add router/providers.js
git commit -m "feat(router): providers.js — 5 provider adapters with unified complete() interface"
```

---

### Task 4: `router/router.js` — orchestration layer

**Files:**
- Create: `router/router.js`
- Create: `router/tests/router.test.js`

**Interfaces:**
- Consumes: `resolveRoute` from `router/config.js`; `complete` from `router/providers.js`; `writeUsage` from `../dashboard/db.js`
- Produces:
  - `route(taskType, prompt, opts) → Promise<{ text, model, provider, costUsd, durationMs }>`
  - `opts`: `{ model?: string, provider?: string, systemPrompt?: string }`
  - If `opts.model` given: skip routing, use that model + opts.provider (or defaultProvider)
  - If `taskType` given: look up via `resolveRoute`
  - Otherwise: use defaultProvider + defaultTier

- [ ] **Step 1: Write the failing tests**

`router/tests/router.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), 'flint-router-test-' + Date.now());
mkdirSync(TMP, { recursive: true });

const CONFIG = {
  tiers: {
    '1': { anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini', google: 'gemini-2.0-flash', azure: 'gpt-4o-mini', openrouter: 'mistral/mistral-small' },
    '2': { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', google: 'gemini-2.0-pro', azure: 'gpt-4o', openrouter: 'mistral/mistral-medium' },
    '3': { anthropic: 'claude-opus-4-6', openai: 'gpt-4.5', google: 'gemini-2.5-pro', azure: 'gpt-4.5', openrouter: 'mistral/mistral-large' }
  },
  taskTypes: {
    'research': { tier: 2, provider: 'anthropic' },
    'code':     { tier: 2, provider: 'openai' }
  },
  defaultProvider: 'anthropic',
  defaultTier: 2
};

before(() => {
  process.env.FLINT_TEST_MODE = '1';
  process.env.FLINT_DB_PATH = join(TMP, 'usage.sqlite');
  process.env.FLINT_ROUTER_CONFIG = join(TMP, 'router.json');
  writeFileSync(process.env.FLINT_ROUTER_CONFIG, JSON.stringify(CONFIG));
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_DB_PATH;
  delete process.env.FLINT_ROUTER_CONFIG;
});

const { route } = await import('../router.js');

test('route with taskType returns stub text and correct model', async () => {
  const result = await route('research', 'test prompt');
  assert.equal(result.text, 'stub response');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'claude-sonnet-4-6');
  assert.ok(typeof result.costUsd === 'number');
  assert.ok(typeof result.durationMs === 'number');
});

test('route with explicit model bypasses routing', async () => {
  const result = await route(null, 'test prompt', { model: 'gpt-4o', provider: 'openai' });
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-4o');
});

test('route with no taskType uses defaults', async () => {
  const result = await route(null, 'test prompt');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'claude-sonnet-4-6');
});

test('route with provider override changes provider', async () => {
  const result = await route('research', 'test prompt', { provider: 'openai' });
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-4o');
});

test('route records usage in sqlite', async () => {
  const { initDb, getTodayCost, closeDb } = await import('../../dashboard/db.js');
  const db = initDb(process.env.FLINT_DB_PATH);
  await route('research', 'test prompt');
  const cost = getTodayCost('research');
  assert.ok(cost >= 0);
  closeDb();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/router"
node --test tests/router.test.js
```

Expected: FAIL — `../router.js` not found.

- [ ] **Step 3: Implement `router/router.js`**

```js
import { resolveRoute, getConfig } from './config.js';
import { complete } from './providers.js';
import { initDb, writeUsage } from '../dashboard/db.js';

// Initialise DB (uses FLINT_DB_PATH env or default path)
initDb();

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/router"
node --test tests/router.test.js
```

Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add router/router.js router/tests/router.test.js
git commit -m "feat(router): router.js — route() orchestration with tier lookup and usage tracking"
```

---

### Task 5: `router/server.js` — Express REST API + `dashboard/db.js` cost breakdown

**Files:**
- Create: `router/server.js`
- Create: `router/tests/server.test.js`
- Modify: `dashboard/db.js` — add `getCostsByProvider()`

**Interfaces:**
- Consumes: `route` from `./router.js`; `getModels`, `getConfig` from `./config.js`; `getCostsByProvider` from `../dashboard/db.js`
- Produces HTTP endpoints:
  - `POST /llm/complete` → `{ text, model, provider, costUsd, durationMs }`
  - `GET /llm/models` → `{ anthropic: [...], openai: [...], ... }`
  - `GET /llm/config` → verbatim router.json content
  - `GET /llm/costs` → `{ today: {provider: usd}, month: {provider: usd}, totalToday, totalMonth }`
- Produces: `createApp() → http.Server`

- [ ] **Step 1: Add `getCostsByProvider()` to `dashboard/db.js`**

Read `dashboard/db.js` first. Append after the existing exports:

```js
export function getCostsByProvider() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';

  // usage table stores model, not provider — we return by model grouped by date
  // Router will group by provider on the JS side using its config
  const todayRows  = db.prepare(`SELECT model, SUM(cost_usd) as total FROM usage WHERE DATE(timestamp) = ? GROUP BY model`).all(today);
  const monthRows  = db.prepare(`SELECT model, SUM(cost_usd) as total FROM usage WHERE DATE(timestamp) >= ? GROUP BY model`).all(monthStart);
  return { todayRows, monthRows };
}
```

- [ ] **Step 2: Write the failing tests**

`router/tests/server.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), 'flint-server-test-' + Date.now());
mkdirSync(TMP, { recursive: true });

const CONFIG = {
  tiers: {
    '1': { anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini', google: 'gemini-2.0-flash', azure: 'gpt-4o-mini', openrouter: 'mistral/mistral-small' },
    '2': { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', google: 'gemini-2.0-pro', azure: 'gpt-4o', openrouter: 'mistral/mistral-medium' },
    '3': { anthropic: 'claude-opus-4-6', openai: 'gpt-4.5', google: 'gemini-2.5-pro', azure: 'gpt-4.5', openrouter: 'mistral/mistral-large' }
  },
  taskTypes: { 'research': { tier: 2, provider: 'anthropic' } },
  defaultProvider: 'anthropic',
  defaultTier: 2
};

let server, baseUrl;

before(async () => {
  process.env.FLINT_TEST_MODE = '1';
  process.env.FLINT_DB_PATH = join(TMP, 'usage.sqlite');
  process.env.FLINT_ROUTER_CONFIG = join(TMP, 'router.json');
  writeFileSync(process.env.FLINT_ROUTER_CONFIG, JSON.stringify(CONFIG));

  const { createApp } = await import('../server.js');
  server = createApp();
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.FLINT_TEST_MODE;
  delete process.env.FLINT_DB_PATH;
  delete process.env.FLINT_ROUTER_CONFIG;
});

async function json(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  return { status: res.status, body: await res.json() };
}

test('POST /llm/complete with taskType returns completion', async () => {
  const { status, body } = await json(`${baseUrl}/llm/complete`, {
    method: 'POST',
    body: JSON.stringify({ taskType: 'research', prompt: 'test' }),
  });
  assert.equal(status, 200);
  assert.equal(body.text, 'stub response');
  assert.equal(body.provider, 'anthropic');
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.ok(typeof body.costUsd === 'number');
  assert.ok(typeof body.durationMs === 'number');
});

test('POST /llm/complete with explicit model bypasses routing', async () => {
  const { status, body } = await json(`${baseUrl}/llm/complete`, {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-4o', provider: 'openai', prompt: 'test' }),
  });
  assert.equal(status, 200);
  assert.equal(body.model, 'gpt-4o');
  assert.equal(body.provider, 'openai');
});

test('POST /llm/complete without prompt returns 400', async () => {
  const { status } = await json(`${baseUrl}/llm/complete`, {
    method: 'POST',
    body: JSON.stringify({ taskType: 'research' }),
  });
  assert.equal(status, 400);
});

test('GET /llm/models returns models per provider', async () => {
  const { status, body } = await json(`${baseUrl}/llm/models`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.anthropic));
  assert.ok(body.anthropic.includes('claude-sonnet-4-6'));
  assert.ok(Array.isArray(body.openai));
});

test('GET /llm/config returns router.json content', async () => {
  const { status, body } = await json(`${baseUrl}/llm/config`);
  assert.equal(status, 200);
  assert.equal(body.defaultProvider, 'anthropic');
  assert.ok(body.tiers);
});

test('GET /llm/costs returns cost breakdown', async () => {
  const { status, body } = await json(`${baseUrl}/llm/costs`);
  assert.equal(status, 200);
  assert.ok(typeof body.totalToday === 'number');
  assert.ok(typeof body.totalMonth === 'number');
  assert.ok(body.today);
  assert.ok(body.month);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/router"
node --test tests/server.test.js
```

Expected: FAIL — `../server.js` not found.

- [ ] **Step 4: Implement `router/server.js`**

```js
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { route } from './router.js';
import { getModels, getConfig } from './config.js';
import { getCostsByProvider } from '../dashboard/db.js';

const MODEL_TO_PROVIDER = {
  'claude-haiku-4-5': 'anthropic', 'claude-sonnet-4-6': 'anthropic', 'claude-opus-4-6': 'anthropic',
  'gpt-4o-mini': 'openai', 'gpt-4o': 'openai', 'gpt-4.5': 'openai',
  'gemini-2.0-flash': 'google', 'gemini-2.0-pro': 'google', 'gemini-2.5-pro': 'google',
};

function aggregateCosts(rows) {
  const cfg = getConfig();
  const out = {};
  for (const row of rows) {
    // Determine provider: check model→provider map, then scan tiers
    let provider = MODEL_TO_PROVIDER[row.model];
    if (!provider) {
      outer: for (const tierModels of Object.values(cfg.tiers)) {
        for (const [p, m] of Object.entries(tierModels)) {
          if (m === row.model) { provider = p; break outer; }
        }
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
  const server = createApp();
  server.listen(3001, () => console.log('[router] listening on port 3001'));
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/router"
node --test tests/server.test.js
```

Expected: 6/6 PASS.

- [ ] **Step 6: Run all router tests**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/router"
node --test tests/config.test.js tests/router.test.js tests/server.test.js
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add router/server.js router/tests/server.test.js dashboard/db.js
git commit -m "feat(router): server.js — Express REST API on port 3001 with /llm/complete, /models, /config, /costs"
```

---

### Task 6: `cron/daemon.js` + `cron/runner.js` — scheduled skill chains

**Files:**
- Create: `cron/daemon.js`
- Create: `cron/runner.js`

**Interfaces:**
- Consumes: `.cron/schedule.json`; `node-cron`; `node-pty` (via root node_modules); POST to `http://localhost:3001/llm/complete`
- No tests (spawns PTYs and fires HTTP at localhost:3001 — integration-only). Verify via syntax check.

- [ ] **Step 1: Implement `cron/runner.js`**

```js
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const LOGS_DIR = join(FLINT_ROOT, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

const DEFAULT_SPAWN_TIMEOUT_MS = 5 * 60 * 1000;

function logPath(name) {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOGS_DIR, `cron-${name}-${date}.log`);
}

export async function runEntry(entry) {
  if (entry.type === 'spawn') {
    return runSpawn(entry);
  } else if (entry.type === 'api') {
    return runApi(entry);
  } else {
    throw new Error(`Unknown cron entry type: ${entry.type}`);
  }
}

async function runSpawn(entry) {
  // Dynamically import node-pty (lives in dashboard/node_modules or root node_modules)
  let pty;
  try {
    pty = await import('node-pty');
  } catch {
    pty = await import(join(FLINT_ROOT, 'dashboard', 'node_modules', 'node-pty', 'lib', 'index.js'));
  }

  const logFile = logPath(entry.name);
  const logStream = createWriteStream(logFile, { flags: 'a' });

  logStream.write(`\n=== ${new Date().toISOString()} Starting: ${entry.name} ===\n`);

  const workdir = entry.workdir ?? FLINT_ROOT;
  const ptyProcess = pty.spawn('claude', ['--dangerously-skip-permissions'], {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: workdir,
    env: { ...process.env },
  });

  ptyProcess.onData(data => logStream.write(data));

  // Send each chain command
  for (const skillName of (entry.chain ?? [])) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    ptyProcess.write(`/${skillName}\n`);
  }

  const timeout = entry.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      ptyProcess.kill();
      logStream.write(`\n[cron] Killed after ${timeout}ms timeout\n`);
      resolve();
    }, timeout);
    ptyProcess.onExit(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  logStream.write(`=== ${new Date().toISOString()} Finished: ${entry.name} ===\n`);
  logStream.end();
}

async function runApi(entry) {
  const logFile = logPath(entry.name);
  const logStream = createWriteStream(logFile, { flags: 'a' });

  logStream.write(`\n=== ${new Date().toISOString()} Starting: ${entry.name} ===\n`);

  try {
    const res = await fetch('http://localhost:3001/llm/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskType: entry.taskType, prompt: entry.prompt }),
    });
    const data = await res.json();
    logStream.write(`Response:\n${data.text}\n`);
    logStream.write(`[cron] cost: $${data.costUsd?.toFixed(4)} model: ${data.model}\n`);
  } catch (err) {
    logStream.write(`[cron] ERROR: ${err.message}\n`);
  }

  logStream.write(`=== ${new Date().toISOString()} Finished: ${entry.name} ===\n`);
  logStream.end();
}
```

- [ ] **Step 2: Implement `cron/daemon.js`**

```js
import { readFileSync, watchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import nodeCron from 'node-cron';
import { runEntry } from './runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const SCHEDULE_FILE = join(FLINT_ROOT, '.cron', 'schedule.json');

// Load .env from Flint root
import('dotenv').then(({ default: dotenv }) => dotenv.config({ path: join(FLINT_ROOT, '.env') }));

let registeredTasks = [];

function loadSchedule() {
  try {
    const raw = readFileSync(SCHEDULE_FILE, 'utf8');
    return JSON.parse(raw).schedules ?? [];
  } catch (err) {
    console.error(`[cron] Failed to load ${SCHEDULE_FILE}:`, err.message);
    return [];
  }
}

function registerSchedules() {
  // Stop existing tasks
  for (const task of registeredTasks) task.stop();
  registeredTasks = [];

  const schedules = loadSchedule();
  for (const entry of schedules) {
    if (!nodeCron.validate(entry.cron)) {
      console.error(`[cron] Invalid cron expression for "${entry.name}": ${entry.cron}`);
      continue;
    }
    const task = nodeCron.schedule(entry.cron, async () => {
      console.log(`[cron] Firing: ${entry.name}`);
      try {
        await runEntry(entry);
        console.log(`[cron] Done: ${entry.name}`);
      } catch (err) {
        console.error(`[cron] Error in "${entry.name}":`, err.message);
      }
    });
    registeredTasks.push(task);
    console.log(`[cron] Scheduled: ${entry.name} (${entry.cron})`);
  }
  console.log(`[cron] ${registeredTasks.length} schedule(s) active`);
}

// Initial load
registerSchedules();

// Hot-reload on SIGHUP
process.on('SIGHUP', () => {
  console.log('[cron] SIGHUP received — reloading schedule');
  registerSchedules();
});

// Also watch the file directly (Windows doesn't reliably deliver SIGHUP)
watchFile(SCHEDULE_FILE, { interval: 5000 }, () => {
  console.log('[cron] schedule.json changed — reloading');
  registerSchedules();
});

console.log('[cron] daemon running');
```

- [ ] **Step 3: Verify syntax**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
node --input-type=module --eval "import('./cron/daemon.js').catch(e => { if (!e.message.includes('ENOENT') && !e.message.includes('Cannot find')) throw e; })"
```

Expected: no syntax errors (ENOENT for missing .env or schedule.json is acceptable here).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add cron/daemon.js cron/runner.js
git commit -m "feat(cron): daemon.js + runner.js — node-cron scheduler with spawn and api execution modes"
```

---

### Task 7: `bin/flint.js` — CLI tool

**Files:**
- Create: `bin/flint.js`

**Interfaces:**
- Consumes: `http://localhost:3001` endpoints
- Produces: subcommands `ask`, `models`, `config`, `costs`

No automated tests (calls a live HTTP server). Verify via syntax check only.

- [ ] **Step 1: Implement `bin/flint.js`**

```js
#!/usr/bin/env node
import { parseArgs } from 'node:util';

const ROUTER_URL = process.env.FLINT_ROUTER_URL ?? 'http://localhost:3001';

async function apiGet(path) {
  const res = await fetch(`${ROUTER_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${ROUTER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

async function cmdAsk(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      task:     { type: 'string', short: 't' },
      model:    { type: 'string', short: 'm' },
      provider: { type: 'string', short: 'p' },
    },
    allowPositionals: true,
  });
  const prompt = positionals.join(' ');
  if (!prompt) { console.error('Usage: flint ask [--task TYPE] [--model MODEL] [--provider PROVIDER] "prompt"'); process.exit(1); }
  const body = { prompt };
  if (values.task)     body.taskType = values.task;
  if (values.model)    body.model    = values.model;
  if (values.provider) body.provider = values.provider;
  const result = await apiPost('/llm/complete', body);
  process.stdout.write(result.text + '\n');
}

async function cmdModels() {
  const models = await apiGet('/llm/models');
  for (const [provider, list] of Object.entries(models)) {
    console.log(`\n${provider}:`);
    for (const m of list) console.log(`  ${m}`);
  }
}

async function cmdConfig() {
  const cfg = await apiGet('/llm/config');
  console.log(JSON.stringify(cfg, null, 2));
}

async function cmdCosts() {
  const data = await apiGet('/llm/costs');
  console.log('\nToday:');
  for (const [p, v] of Object.entries(data.today)) console.log(`  ${p}: $${v.toFixed(4)}`);
  console.log(`  Total: $${data.totalToday.toFixed(4)}`);
  console.log('\nThis month:');
  for (const [p, v] of Object.entries(data.month)) console.log(`  ${p}: $${v.toFixed(4)}`);
  console.log(`  Total: $${data.totalMonth.toFixed(4)}`);
}

const [,, subcommand, ...rest] = process.argv;

const COMMANDS = { ask: cmdAsk, models: cmdModels, config: cmdConfig, costs: cmdCosts };
const cmd = COMMANDS[subcommand];
if (!cmd) {
  console.error(`Usage: flint <ask|models|config|costs>`);
  process.exit(1);
}

cmd(rest).catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify syntax**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
node --check bin/flint.js
```

Expected: no output (clean syntax check).

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add bin/flint.js
git commit -m "feat(cli): bin/flint.js — ask, models, config, costs subcommands"
```

---

### Task 8: Dashboard additions — model picker, proxy routes, agent model field

**Files:**
- Modify: `dashboard/public/index.html` — add `<select id="modal-model">` to New Agent modal
- Modify: `dashboard/public/app.js` — populate model dropdown; pass model to spawn; `--model` flag
- Modify: `dashboard/server.js` — proxy routes GET /router/models and GET /router/config
- Modify: `dashboard/agents.js` — add `model` field to agent shape and persistence
- Modify: `dashboard/terminal.js` — pass `--model <model>` to claude CLI when model set

**Interfaces:**
- Consumes: GET `http://localhost:3001/llm/models` (via proxy)
- Produces: model field on spawned agents; `claude --dangerously-skip-permissions --model <model>` CLI invocation

- [ ] **Step 1: Read the files to modify**

Read all four files before making changes:
- `dashboard/public/index.html`
- `dashboard/public/app.js`
- `dashboard/server.js`
- `dashboard/agents.js`
- `dashboard/terminal.js`

- [ ] **Step 2: Add model select to modal in `dashboard/public/index.html`**

Find the modal form section. After the workdir input and before the modal buttons, add:

```html
<div class="form-group">
  <label for="modal-model">Model (optional)</label>
  <select id="modal-model">
    <option value="">Default (agent config)</option>
  </select>
</div>
```

- [ ] **Step 3: Update `dashboard/public/app.js` — model picker population and spawn**

In the `connect()` / WS `open` handler (or wherever agent list is fetched on load), add a call to populate the model dropdown:

```js
async function populateModelDropdown() {
  try {
    const res = await fetch('/router/models');
    if (!res.ok) return; // router not running — leave default only
    const models = await res.json();
    if (models.error) return;
    const select = document.getElementById('modal-model');
    for (const [provider, list] of Object.entries(models)) {
      const group = document.createElement('optgroup');
      group.label = provider;
      for (const m of list) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
  } catch {
    // router not running — dropdown stays at default only
  }
}
```

Call `populateModelDropdown()` once on WS open (alongside the existing agents request).

In the modal spawn handler (where `{type: 'spawn', agent: name, workdir}` is sent), include model:

```js
const model = document.getElementById('modal-model').value;
ws.send(JSON.stringify({ type: 'spawn', agent: name, workdir, ...(model ? { model } : {}) }));
```

- [ ] **Step 4: Update `dashboard/server.js` — proxy routes**

Add after the existing routes (before any error handlers or default catch-alls):

```js
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
```

- [ ] **Step 5: Update `dashboard/agents.js` — add model field**

In `saveAgents()` (the persistence function), ensure the `model` field is included in the serialised shape. In `loadAgents()` / agent restore logic, read `model` back. The agent shape becomes:

`{name, mode, status, workdir, model, logPath, ptyProcess, watcher, wsClients: Set}`

Wherever agents are returned to callers (e.g. `listAgents()`), include `model` in the public shape:

```js
// In listAgents():
return agents.map(a => ({ name: a.name, mode: a.mode, status: a.status, workdir: a.workdir, model: a.model ?? '' }));
```

In `spawnAgentEntry` / `registerAgent`, accept and store `model`:

```js
export function registerAgent({ name, mode, workdir, model, logPath }) {
  // ... existing logic ...
  agents.set(name, { name, mode, status: 'idle', workdir, model: model ?? '', logPath, ptyProcess: null, watcher: null, wsClients: new Set() });
  // ...
}
```

- [ ] **Step 6: Update `dashboard/terminal.js` — pass --model flag to claude CLI**

In `spawnAgent(name, workdir, model)`, change the PTY spawn args:

```js
const args = ['--dangerously-skip-permissions'];
if (model) args.push('--model', model);

const ptyProcess = pty.spawn('claude', args, {
  name: 'xterm-256color',
  cols: 220,
  rows: 50,
  cwd: workdir,
  env: { ...process.env },
});
```

Ensure the `model` parameter is threaded through from `server.js` → `spawnAgent()` call.

In `server.js`, the WebSocket `spawn` message handler passes model:

```js
case 'spawn': {
  const { agent, workdir, model } = msg;
  // ...
  spawnAgent(agent, workdir, model);
  break;
}
```

- [ ] **Step 7: Run dashboard tests to confirm no regressions**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js
```

Expected: 20/20 PASS.

- [ ] **Step 8: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add dashboard/public/index.html dashboard/public/app.js dashboard/server.js dashboard/agents.js dashboard/terminal.js
git commit -m "feat(dashboard): model picker dropdown, proxy routes, --model flag on spawn"
```

---

### Task 9: `start.js` root launcher + integration smoke test

**Files:**
- Create: `start.js`

**Interfaces:**
- Spawns: `node dashboard/server.js`, `node router/server.js`, `node cron/daemon.js`
- Pipes each process stdout/stderr to `logs/dashboard.log`, `logs/router.log`, `logs/cron.log`
- Also mirrors to terminal with `[dashboard]`, `[router]`, `[cron]` prefix
- On `SIGINT`/`SIGTERM`: kills all children

No automated tests for start.js (it's a process manager). Verify via syntax check + manual smoke test.

- [ ] **Step 1: Implement `start.js`**

```js
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

const SERVICES = [
  { name: 'dashboard', cmd: 'node', args: ['dashboard/server.js'], log: 'dashboard.log' },
  { name: 'router',    cmd: 'node', args: ['router/server.js'],    log: 'router.log' },
  { name: 'cron',      cmd: 'node', args: ['cron/daemon.js'],      log: 'cron.log' },
];

const children = [];

for (const svc of SERVICES) {
  const logStream = createWriteStream(join(LOGS_DIR, svc.log), { flags: 'a' });
  const child = spawn(svc.cmd, svc.args, {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `[${svc.name}] `;

  child.stdout.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line) {
        process.stdout.write(prefix + line + '\n');
        logStream.write(line + '\n');
      }
    }
  });

  child.stderr.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line) {
        process.stderr.write(prefix + line + '\n');
        logStream.write('[ERR] ' + line + '\n');
      }
    }
  });

  child.on('exit', (code, signal) => {
    console.log(`${prefix}exited (code=${code} signal=${signal})`);
  });

  children.push(child);
  console.log(`${prefix}started (pid ${child.pid})`);
}

function shutdown() {
  console.log('\n[start] Shutting down all services...');
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 2: Verify syntax**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
node --check start.js
```

Expected: clean (no output).

- [ ] **Step 3: Run all router tests one final time**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/router"
node --test tests/config.test.js tests/router.test.js tests/server.test.js
```

Expected: all pass.

- [ ] **Step 4: Run dashboard tests to confirm no regressions**

```bash
cd "C:/Users/Robin/Applications Dev/Flint/dashboard"
node --test tests/db.test.js tests/tasks.test.js tests/agents.test.js tests/server.test.js
```

Expected: 20/20 PASS.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Robin/Applications Dev/Flint"
git add start.js
git commit -m "feat(root): start.js launcher — spawns dashboard, router, and cron with log piping and clean shutdown"
```

- [ ] **Step 6: Final integration smoke test (manual)**

In a terminal, run:
```
cd "C:/Users/Robin/Applications Dev/Flint"
node start.js
```

Verify:
- `[dashboard] listening on port 3000` appears
- `[router] listening on port 3001` appears
- `[cron] daemon running` appears
- `http://localhost:3000` loads in browser
- New Agent modal shows model dropdown (populated after router starts)
- `node bin/flint.js models` lists models per provider
- `node bin/flint.js config` returns router.json content
- `node bin/flint.js costs` returns today/month breakdown

---

## Spec Self-Review

**Spec coverage check:**

| Spec section | Task |
|---|---|
| Multi-provider LLM gateway (5 providers) | Task 3 (providers.js) |
| Tier-based routing | Task 2 (config.js) + Task 4 (router.js) |
| Per-task-type overrides | Task 2 (config.js) |
| Per-invocation model selection | Task 4 (router.js opts.model) |
| POST /llm/complete | Task 5 (server.js) |
| GET /llm/models | Task 5 (server.js) |
| GET /llm/config | Task 5 (server.js) |
| GET /llm/costs | Task 5 (server.js) + dashboard/db.js getCostsByProvider |
| Cost tracking → usage.sqlite | Task 4 (router.js calls writeUsage) |
| Cron daemon (schedule.json, node-cron) | Task 6 (daemon.js) |
| Cron spawn mode (node-pty chain) | Task 6 (runner.js) |
| Cron api mode (POST to router) | Task 6 (runner.js) |
| Cron log files | Task 6 (runner.js) |
| SIGHUP hot-reload | Task 6 (daemon.js) |
| CLI: ask, models, config, costs | Task 7 (bin/flint.js) |
| Dashboard model picker dropdown | Task 8 (index.html + app.js) |
| GET /router/models proxy | Task 8 (dashboard/server.js) |
| GET /router/config proxy | Task 8 (dashboard/server.js) |
| Agent model field + --model flag | Task 8 (agents.js + terminal.js) |
| Root launcher (start.js) | Task 9 |
| Root package.json scripts | Task 1 |
| .env.example committed | Task 1 |
| router.json at Flint root | Task 1 |
| FLINT_TEST_MODE stub | Task 3 (providers.js) |
| createApp() export pattern | Task 5 (server.js) |

All spec requirements covered. No gaps found.

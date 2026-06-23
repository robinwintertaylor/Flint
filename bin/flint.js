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

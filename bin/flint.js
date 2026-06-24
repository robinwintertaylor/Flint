#!/usr/bin/env node
import { parseArgs } from 'node:util';

const ROUTER_URL = process.env.FLINT_ROUTER_URL ?? 'http://localhost:3001';
const DASHBOARD_URL = process.env.FLINT_DASHBOARD_URL ?? 'http://localhost:3000';

async function dashGet(path) {
  const res = await fetch(`${DASHBOARD_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function dashPost(path, body) {
  const res = await fetch(`${DASHBOARD_URL}${path}`, {
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

async function dashPatch(path, body) {
  const res = await fetch(`${DASHBOARD_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

async function dashDelete(path) {
  const res = await fetch(`${DASHBOARD_URL}${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  return res.json();
}

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

async function cmdProject(args) {
  const [sub, ...rest] = args;
  const subs = {
    list:   cmdProjectList,
    create: cmdProjectCreate,
    status: cmdProjectStatus,
    notes:  cmdProjectNotes,
    link:   cmdProjectLink,
    unlink: cmdProjectUnlink,
  };
  const fn = subs[sub];
  if (!fn) {
    console.error('Usage: flint project <list|create|status|notes|link|unlink>');
    process.exit(1);
  }
  return fn(rest);
}

async function cmdProjectList() {
  const projects = await dashGet('/projects');
  if (!projects.length) { console.log('No active projects.'); return; }
  for (const p of projects) {
    const agents = p.agents.length ? p.agents.join(', ') : '(none)';
    console.log(`[${p.id}] ${p.name} [${p.status}] | agents: ${agents} | week: $${p.costWeek.toFixed(4)} | month: $${p.costMonth.toFixed(4)}`);
    if (p.notes) console.log(`      ${p.notes.slice(0, 80).replace(/\n/g, ' ')}`);
  }
}

async function cmdProjectCreate(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { notes: { type: 'string', short: 'n' } },
    allowPositionals: true,
  });
  const name = positionals.join(' ');
  if (!name) { console.error('Usage: flint project create "name" [--notes "..."]'); process.exit(1); }
  const proj = await dashPost('/projects', { name, notes: values.notes ?? '' });
  console.log(`Created project [${proj.id}]: ${proj.name}`);
}

async function cmdProjectStatus(args) {
  const [id, status] = args;
  if (!id || !status) { console.error('Usage: flint project status <id> active|paused|done|archived'); process.exit(1); }
  await dashPatch(`/projects/${id}`, { status });
  console.log(`Project ${id} status → ${status}`);
}

async function cmdProjectNotes(args) {
  const [id, ...noteParts] = args;
  const notes = noteParts.join(' ');
  if (!id || !notes) { console.error('Usage: flint project notes <id> "text"'); process.exit(1); }
  await dashPatch(`/projects/${id}`, { notes });
  console.log(`Project ${id} notes updated.`);
}

async function cmdProjectLink(args) {
  const [id, agentName] = args;
  if (!id || !agentName) { console.error('Usage: flint project link <id> <agent-name>'); process.exit(1); }
  await dashPost(`/projects/${id}/agents`, { agentName });
  console.log(`Linked agent "${agentName}" to project ${id}.`);
}

async function cmdProjectUnlink(args) {
  const [id, agentName] = args;
  if (!id || !agentName) { console.error('Usage: flint project unlink <id> <agent-name>'); process.exit(1); }
  await dashDelete(`/projects/${id}/agents/${agentName}`);
  console.log(`Unlinked agent "${agentName}" from project ${id}.`);
}

async function cmdSuggestions(args) {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const list = await dashGet('/suggestions');
    if (!list.length) { console.log('No suggestions.'); return; }
    for (const s of list) {
      const date = (s.created_at ?? '').slice(0, 16).replace('T', ' ');
      console.log(`[${s.id}] ${s.agent_name} [${s.status}] ${date}`);
      console.log(`  ${String(s.content).slice(0, 80).replace(/\n/g, ' ')}`);
    }
  } else if (sub === 'dismiss') {
    const [id] = rest;
    if (!id) { console.error('Usage: flint suggestions dismiss <id>'); process.exit(1); }
    await dashPatch(`/suggestions/${id}`, { status: 'dismissed' });
    console.log(`Suggestion ${id} dismissed.`);
  } else {
    console.error('Usage: flint suggestions <list|dismiss>');
    process.exit(1);
  }
}

async function cmdQueue(args) {
  const [sub, ...rest] = args;

  if (sub === 'list') {
    const { values } = parseArgs({
      args: rest,
      options: { status: { type: 'string' }, agent: { type: 'string' } },
      allowPositionals: false,
    });
    const qs = new URLSearchParams();
    if (values.status) qs.set('status', values.status);
    if (values.agent)  qs.set('assigned_to', values.agent);
    const list = await dashGet(`/queue/tasks${qs.toString() ? '?' + qs : ''}`);
    if (!list.length) { console.log('No tasks.'); return; }
    for (const t of list) {
      const role   = t.role ? ` [${t.role}]` : '';
      const agent  = t.assigned_to ? ` → ${t.assigned_to}` : ' → unassigned';
      console.log(`[${t.id}] [${t.status}] ${t.title}${role}${agent}`);
    }

  } else if (sub === 'add') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        desc:     { type: 'string' },
        agent:    { type: 'string' },
        role:     { type: 'string' },
        priority: { type: 'string' },
      },
      allowPositionals: true,
    });
    const title = positionals.join(' ');
    if (!title) { console.error('Usage: flint queue add "title" [--desc "..."] [--agent <name>] [--role researcher|planner|builder|tester] [--priority 1]'); process.exit(1); }
    const body = { title, created_by: 'human' };
    if (values.desc)     body.description = values.desc;
    if (values.agent)    body.assigned_to  = values.agent;
    if (values.role)     body.role         = values.role;
    if (values.priority) body.priority     = Number(values.priority);
    const task = await dashPost('/queue/tasks', body);
    console.log(`Task [${task.id}] added: "${task.title}" [${task.status}]`);

  } else if (sub === 'assign') {
    const [id, agent] = rest;
    if (!id || !agent) { console.error('Usage: flint queue assign <id> <agent>'); process.exit(1); }
    const task = await dashPatch(`/queue/tasks/${id}`, { assigned_to: agent });
    console.log(`Task [${task.id}] assigned to "${task.assigned_to}".`);

  } else if (sub === 'done') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { result: { type: 'string' } },
      allowPositionals: true,
    });
    const [id] = positionals;
    if (!id) { console.error('Usage: flint queue done <id> [--result "summary"]'); process.exit(1); }
    await dashPatch(`/queue/tasks/${id}`, { status: 'done', result: values.result ?? '' });
    console.log(`Task [${id}] marked done.`);

  } else if (sub === 'cancel') {
    const [id] = rest;
    if (!id) { console.error('Usage: flint queue cancel <id>'); process.exit(1); }
    await dashDelete(`/queue/tasks/${id}`);
    console.log(`Task [${id}] cancelled.`);

  } else {
    console.error('Usage: flint queue <list|add|assign|done|cancel>');
    process.exit(1);
  }
}

async function cmdWorkspace(args) {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const list = await dashGet('/workspaces');
    if (!list.length) { console.log('No workspaces registered.'); return; }
    for (const w of list) console.log(`[${w.id}] ${w.name}  →  ${w.path}`);
  } else if (sub === 'add') {
    const [name, ...pathParts] = rest;
    const path = pathParts.join(' ');
    if (!name || !path) { console.error('Usage: flint workspace add <name> <path>'); process.exit(1); }
    const r = await dashPost('/workspaces', { name, path });
    console.log(`Workspace "${r.name}" added (id ${r.id}).`);
  } else if (sub === 'remove') {
    const [id] = rest;
    if (!id) { console.error('Usage: flint workspace remove <id>'); process.exit(1); }
    await dashDelete(`/workspaces/${id}`);
    console.log(`Workspace ${id} removed.`);
  } else {
    console.error('Usage: flint workspace <list|add|remove>');
    process.exit(1);
  }
}

async function cmdMcp(args) {
  const [sub, name, ...rest] = args;

  if (sub === 'list') {
    const list = await dashGet('/mcp/servers');
    if (!list.length) { console.log('No MCP servers configured.'); return; }
    for (const s of list) {
      const argsParsed = (s.args || []).join(' ');
      const state = s.enabled ? 'enabled' : 'disabled';
      console.log(`[${s.id}] ${s.name} | ${s.command} ${argsParsed} | ${s.scope} | ${state}`);
    }

  } else if (sub === 'add') {
    const { values, positionals } = parseArgs({
      args: name ? [name, ...rest] : rest,
      options: {
        env:      { type: 'string', multiple: true },
        scope:    { type: 'string' },
        disabled: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    const [serverName, command, ...argParts] = positionals;
    if (!serverName || !command) {
      console.error('Usage: flint mcp add <name> <command> [args...] [--env KEY=VAL] [--scope global|<agent>] [--disabled]');
      process.exit(1);
    }
    const env = {};
    (values.env ?? []).forEach(kv => {
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    });
    const r = await dashPost('/mcp/servers', {
      name: serverName, command, args: argParts, env,
      scope: values.scope ?? 'global',
      enabled: values.disabled ? 0 : 1,
    });
    console.log(`MCP server "${r.name}" added (id ${r.id}).`);

  } else if (sub === 'remove') {
    if (!name) { console.error('Usage: flint mcp remove <name>'); process.exit(1); }
    const list = await dashGet('/mcp/servers');
    const server = list.find(s => s.name === name);
    if (!server) { console.error(`No MCP server named "${name}".`); process.exit(1); }
    await dashDelete(`/mcp/servers/${server.id}`);
    console.log(`MCP server "${name}" removed.`);

  } else if (sub === 'enable' || sub === 'disable') {
    if (!name) { console.error(`Usage: flint mcp ${sub} <name>`); process.exit(1); }
    const list = await dashGet('/mcp/servers');
    const server = list.find(s => s.name === name);
    if (!server) { console.error(`No MCP server named "${name}".`); process.exit(1); }
    await dashPatch(`/mcp/servers/${server.id}`, { enabled: sub === 'enable' ? 1 : 0 });
    console.log(`MCP server "${name}" ${sub}d.`);

  } else {
    console.error('Usage: flint mcp <list|add|remove|enable|disable>');
    process.exit(1);
  }
}

async function cmdWorktree(args) {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const list = await dashGet('/worktrees');
    if (!list.length) { console.log('No active worktrees.'); return; }
    for (const w of list) {
      const pr = w.pr_status ? ` | PR #${w.pr_number} [${w.pr_status}] ${w.pr_url}` : '';
      console.log(`${w.name} | ${w.worktree_branch} | ${w.status}${pr}`);
    }
  } else if (sub === 'discard') {
    const [agent] = rest;
    if (!agent) { console.error('Usage: flint worktree discard <agent>'); process.exit(1); }
    await dashDelete(`/worktrees/${encodeURIComponent(agent)}`);
    console.log(`Discarded worktree for agent "${agent}".`);
  } else {
    console.error('Usage: flint worktree <list|discard>');
    process.exit(1);
  }
}

const [,, subcommand, ...rest] = process.argv;

const COMMANDS = { ask: cmdAsk, models: cmdModels, config: cmdConfig, costs: cmdCosts, project: cmdProject, suggestions: cmdSuggestions, worktree: cmdWorktree, workspace: cmdWorkspace, mcp: cmdMcp, queue: cmdQueue };
const cmd = COMMANDS[subcommand];
if (!cmd) {
  console.error(`Usage: flint <ask|models|config|costs|project|suggestions|worktree|workspace|mcp|queue>`);
  process.exit(1);
}

cmd(rest).catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

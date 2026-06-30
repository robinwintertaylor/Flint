import { getDb } from './db.js';
import { listQueueTasks, createQueueTask } from './queue.js';
import { listAgents, killAgent, registerAgent } from './agents.js';
import { listSpecialists, getSpecialist, incrementUsage } from './specialists.js';
import { listProjects } from './projects.js';
import { getSetting } from './settings.js';
import { loadSpecialist } from '../agents/specialists/selector.js';
import { spawnAgent } from './terminal.js';

// ---------------------------------------------------------------------------
// Orchestrator system prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(state) {
  const specialistList = state.specialists.length
    ? state.specialists.map(s =>
        `  • ${s.name} (${s.label}) — ${s.description || 'no description'} | provider: ${s.preferredProvider || 'anthropic'} tier-${s.preferredTier}`
      ).join('\n')
    : '  (none configured yet)';

  return `You are Flint, an autonomous AI orchestrator managing a team of specialist agents.

Your job is to keep work moving. Review the system state below and decide what actions to take.

## Available Specialists
${specialistList}

## Actions you can take
Respond ONLY with valid JSON (no markdown fences, no explanation):
{
  "thought": "Your reasoning in 1-2 sentences.",
  "actions": []
}

Action types:
{ "type": "create_task", "title": "...", "description": "...", "role": "specialist-name", "project_id": null }
  — Add a task to the queue. Set role to a specialist name so the right agent picks it up.

{ "type": "spawn_agent", "specialist": "specialist-name", "reason": "..." }
  — Immediately spin up a new agent with this specialist's soul. Use when you need capacity NOW.

{ "type": "stop_agent", "name": "agent-name", "reason": "..." }
  — Stop an idle or stuck agent to free resources.

{ "type": "note", "text": "..." }
  — Record an observation without acting. Use when the system is healthy and no action is needed.

## Rules
- Only create tasks that don't already exist in the queue.
- Prefer create_task over spawn_agent — auto-pickup will provision agents when needed.
- Only spawn_agent when a task is already pending and no suitable agent is running/stopped.
- Only stop_agent if the agent has been idle (no in-progress tasks) and is not needed soon.
- If everything is running smoothly, return a note action only.
- Use specialist names EXACTLY as listed above.`;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export function logHeartbeat(note, actions = []) {
  getDb().prepare(
    'INSERT INTO heartbeat_log (note, actions_json) VALUES (?, ?)'
  ).run(note, JSON.stringify(actions));
}

export function getHeartbeatLog(limit = 20) {
  return getDb().prepare(
    'SELECT * FROM heartbeat_log ORDER BY id DESC LIMIT ?'
  ).all(limit);
}

// ---------------------------------------------------------------------------
// State collection
// ---------------------------------------------------------------------------

export function collectState() {
  const db = getDb();

  const agents = listAgents().map(a => ({
    name: a.name, status: a.status, role: a.role ?? null,
    runtime: a.runtime, model: a.model || null,
  }));

  const specialists = listSpecialists().map(s => ({
    name: s.name, label: s.label,
    description: s.description || '',
    domains: s.domains || [],
    preferredProvider: s.preferred_provider || 'anthropic',
    preferredTier: s.preferred_tier || 2,
  }));

  const projects = listProjects().map(p => {
    const tasks = db.prepare(
      `SELECT status, COUNT(*) as n FROM task_queue WHERE project_id = ? GROUP BY status`
    ).all(p.id);
    const byStatus = Object.fromEntries(tasks.map(r => [r.status, r.n]));
    return { id: p.id, name: p.name, notes: p.notes || '',
      pending: byStatus.pending || 0, inProgress: byStatus.in_progress || 0, done: byStatus.done || 0 };
  });

  const pendingTasks = db.prepare(
    `SELECT id, title, description, role, project_id FROM task_queue WHERE status='pending' ORDER BY priority DESC, id ASC LIMIT 15`
  ).all();

  const inProgressTasks = db.prepare(
    `SELECT id, title, assigned_to, role FROM task_queue WHERE status='in_progress' LIMIT 10`
  ).all();

  const recentDone = db.prepare(
    `SELECT title, assigned_to, updated_at FROM task_queue WHERE status='done' ORDER BY updated_at DESC LIMIT 5`
  ).all();

  const recentNotes = getHeartbeatLog(3).map(r => r.note);

  return {
    ts: new Date().toISOString(),
    agents,
    specialists,
    projects,
    queue: {
      pending: pendingTasks.length,
      inProgress: inProgressTasks.length,
      pendingTasks,
      inProgressTasks,
      recentDone,
    },
    recentNotes,
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLlm(state) {
  const model    = getSetting('heartbeat_model')    || undefined;
  const provider = getSetting('heartbeat_provider') || undefined;
  const systemPrompt = buildSystemPrompt(state);
  const prompt = `Current system state:\n\n${JSON.stringify(state, null, 2)}`;

  const body = {
    taskType: 'orchestrator',
    prompt,
    systemPrompt,
    ...(model    && model    !== 'router-default' ? { model }    : {}),
    ...(provider && provider !== 'router-default' ? { provider } : {}),
  };

  const res = await fetch('http://localhost:3001/llm/complete', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Router returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.text;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseResponse(raw) {
  try {
    // Strip any accidental markdown fences
    const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const json = JSON.parse(cleaned);
    const note = String(json.thought ?? json.note ?? '').slice(0, 500);
    const actions = Array.isArray(json.actions) ? json.actions : [];
    return { note, actions };
  } catch {
    return { note: String(raw).slice(0, 200), actions: [] };
  }
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

function runtimeForProvider(provider) {
  if (!provider || provider === 'anthropic') return 'claude';
  if (provider === 'openrouter') return 'openrouter';
  if (provider === 'ollama')     return 'ollama';
  if (provider === 'lmstudio')   return 'lmstudio';
  return 'claude';
}

function executeActions(actions) {
  for (const action of actions) {
    try {
      switch (action.type) {

        case 'create_task':
          if (!action.title) break;
          createQueueTask({
            title:       action.title,
            description: action.description ?? '',
            role:        action.role ?? null,
            project_id:  action.project_id ?? null,
            created_by:  'heartbeat',
          });
          console.log(`[heartbeat] created task: "${action.title}" (role: ${action.role ?? 'unset'})`);
          break;

        case 'spawn_agent': {
          if (!action.specialist) break;
          const spec = getSpecialist(action.specialist);
          if (!spec) { console.warn(`[heartbeat] spawn_agent: specialist "${action.specialist}" not found`); break; }

          // Don't spawn if an agent with this role already exists (running or stopped)
          const alreadyExists = listAgents().find(a => a.role === spec.name);
          if (alreadyExists) {
            console.log(`[heartbeat] spawn_agent skipped — agent "${alreadyExists.name}" already exists for role "${spec.name}" (status: ${alreadyExists.status})`);
            break;
          }

          const base = `${spec.name}-auto`;
          let agentName = base;
          let n = 2;
          while (listAgents().find(a => a.name === agentName)) agentName = `${base}-${n++}`;

          const workdir  = getSetting('default_workdir') || process.cwd();
          const runtime  = runtimeForProvider(spec.preferred_provider);
          const model    = runtime === 'openrouter' ? 'mistralai/mistral-nemo' : '';
          const loaded   = loadSpecialist(spec.name);

          registerAgent(agentName, 'spawn', workdir, null, model, runtime, spec.name);
          spawnAgent(agentName, workdir, model || null, { specialist: loaded });
          incrementUsage(spec.name);
          console.log(`[heartbeat] spawned "${agentName}" (${runtime}, specialist: ${spec.name}) — ${action.reason ?? ''}`);
          break;
        }

        case 'stop_agent':
          if (!action.name) break;
          killAgent(action.name);
          console.log(`[heartbeat] stopped agent "${action.name}" — ${action.reason ?? ''}`);
          break;

        case 'note':
          // Observation only — logged as part of the heartbeat entry
          break;

        default:
          console.warn(`[heartbeat] unknown action type: ${action.type}`);
      }
    } catch (err) {
      console.warn(`[heartbeat] action "${action.type}" failed: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main cycle
// ---------------------------------------------------------------------------

export async function runHeartbeatCycle() {
  try {
    const state  = collectState();
    const raw    = await callLlm(state);
    const { note, actions } = parseResponse(raw);
    executeActions(actions);
    logHeartbeat(note, actions);
    console.log(`[heartbeat] ${note}`);
    return { note, actions };
  } catch (err) {
    const errNote = `Orchestrator cycle error: ${err.message}`;
    try { logHeartbeat(errNote, []); } catch {}
    console.warn('[heartbeat]', err.message);
    return { note: errNote, actions: [] };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let _timer = null;

export function startHeartbeat() {
  if (process.env.FLINT_TEST_MODE === '1') return;
  if (getSetting('heartbeat_enabled') === 'false') return;
  const mins = parseInt(getSetting('heartbeat_interval_minutes') || '5', 10);
  if (_timer) clearInterval(_timer);
  _timer = setInterval(runHeartbeatCycle, mins * 60_000);
  console.log(`[heartbeat] orchestrator started — interval ${mins}min, model: ${getSetting('heartbeat_model') || 'router-default'}`);
}

export function stopHeartbeat() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

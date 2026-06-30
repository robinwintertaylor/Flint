import { getDb } from './db.js';
import { listQueueTasks, createQueueTask } from './queue.js';
import { listAgents } from './agents.js';
import { getSetting } from './settings.js';

const SYSTEM_PROMPT = `You are Flint's autonomous system brain. You review the agent team and task queue state and decide what (if anything) needs to happen.

Be conservative — most heartbeats should produce no actions (empty actions array). Only act when there is genuinely useful work that isn't already being handled.

Respond ONLY with valid JSON in exactly this format (no markdown, no explanation):
{
  "note": "One or two sentence observation about the system state.",
  "actions": []
}

Available action type (include in actions array only when clearly needed):
{ "type": "create_task", "title": "...", "description": "...", "role": "..." }

Never create tasks already in the queue. Never spawn agents (human decision). When in doubt, take no action.`;

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

export function collectState() {
  const agents = listAgents().map(a => ({ name: a.name, status: a.status, role: a.role ?? null }));
  const allTasks = listQueueTasks();
  const pending    = allTasks.filter(t => t.status === 'pending').length;
  const inProgress = allTasks.filter(t => t.status === 'in_progress').length;
  const doneLast24h = allTasks.filter(t => {
    if (t.status !== 'done') return false;
    return (Date.now() - new Date(t.updated_at + 'Z').getTime()) < 86_400_000;
  }).length;
  const recentTasks = allTasks.slice(0, 5).map(t => ({
    id: t.id, title: t.title, status: t.status, assigned_to: t.assigned_to ?? null,
  }));
  const recentNotes = getHeartbeatLog(3).map(r => r.note);
  return { agents, queue: { pending, inProgress, doneLast24h, recentTasks }, recentNotes, ts: new Date().toISOString() };
}

async function callLlm(prompt) {
  const model    = getSetting('heartbeat_model')    || undefined;
  const provider = getSetting('heartbeat_provider') || undefined;
  const body = {
    taskType:     'heartbeat',
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    ...(model    ? { model }    : {}),
    ...(provider ? { provider } : {}),
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

function parseResponse(raw) {
  try {
    const json = JSON.parse(raw.trim());
    return {
      note:    String(json.note ?? '').slice(0, 500),
      actions: Array.isArray(json.actions) ? json.actions : [],
    };
  } catch {
    return { note: String(raw).slice(0, 200), actions: [] };
  }
}

function executeActions(actions) {
  for (const action of actions) {
    try {
      if (action.type === 'create_task' && action.title) {
        createQueueTask({
          title:       action.title,
          description: action.description ?? '',
          role:        action.role ?? null,
          created_by:  'heartbeat',
        });
      }
    } catch (err) {
      console.warn(`[heartbeat] action failed: ${err.message}`);
    }
  }
}

export async function runHeartbeatCycle() {
  try {
    const state   = collectState();
    const raw     = await callLlm(JSON.stringify(state, null, 2));
    const { note, actions } = parseResponse(raw);
    executeActions(actions);
    logHeartbeat(note, actions);
    console.log(`[heartbeat] ${note}`);
    return { note, actions };
  } catch (err) {
    const errNote = `Heartbeat cycle error: ${err.message}`;
    try { logHeartbeat(errNote, []); } catch {}
    console.warn('[heartbeat]', err.message);
    return { note: errNote, actions: [] };
  }
}

let _timer = null;

export function startHeartbeat() {
  if (process.env.FLINT_TEST_MODE === '1') return;
  const enabled = getSetting('heartbeat_enabled');
  if (enabled === 'false') return;
  const mins = parseInt(getSetting('heartbeat_interval_minutes') || '5', 10);
  const ms   = mins * 60_000;
  if (_timer) clearInterval(_timer);
  _timer = setInterval(runHeartbeatCycle, ms);
  console.log(`[heartbeat] started — interval ${mins}min, model: ${getSetting('heartbeat_model') || 'router-default'}`);
}

export function stopHeartbeat() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

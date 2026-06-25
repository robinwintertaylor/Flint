import { join } from 'path';
import { getDb } from './db.js';
import { appendTask, getTasksDir, readTasks, writeTasks } from './tasks.js';
import { broadcastGlobal } from './agents.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTaskForInjection(task) {
  const roleTag = task.role ? ` | Role: ${task.role}` : '';
  const desc = task.description ? `\n\n  ${task.description}` : '';
  return `${task.title}${desc}\n\n  _Queue task #${task.id}${roleTag}_`;
}

export function listQueueTasks({ status, assigned_to, project_id, role, created_by } = {}) {
  const db = getDb();
  const wheres = [];
  const vals = [];
  if (status !== undefined)      { wheres.push('status = ?');      vals.push(status); }
  if (assigned_to !== undefined) { wheres.push('assigned_to = ?'); vals.push(assigned_to); }
  if (project_id !== undefined)  { wheres.push('project_id = ?');  vals.push(project_id); }
  if (role !== undefined)        { wheres.push('role = ?');         vals.push(role); }
  if (created_by !== undefined)  { wheres.push('created_by = ?');  vals.push(created_by); }
  const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM task_queue ${where} ORDER BY priority DESC, id ASC`).all(...vals);
}

export function getQueueTask(id) {
  return getDb().prepare('SELECT * FROM task_queue WHERE id = ?').get(id);
}

export function createQueueTask({ title, description = '', project_id, assigned_to, role, priority = 0, created_by = 'human' }) {
  const db = getDb();
  const status = assigned_to ? 'in_progress' : 'pending';
  const r = db.prepare(
    `INSERT INTO task_queue (title, description, project_id, assigned_to, role, priority, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, description, project_id ?? null, assigned_to ?? null, role ?? null, priority, status, created_by);
  const task = getQueueTask(r.lastInsertRowid);
  if (assigned_to) appendTask(assigned_to, formatTaskForInjection(task));
  broadcastGlobal({ type: 'queue_task_added', task });
  return task;
}

export function assignQueueTask(id, agentName) {
  const db = getDb();
  const task = getQueueTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  if (task.status === 'in_progress' || task.status === 'done') {
    throw new Error(`Task ${id} is already ${task.status}`);
  }
  db.prepare(
    `UPDATE task_queue SET assigned_to = ?, status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(agentName, id);
  const updated = getQueueTask(id);

  // If this task was created by an orchestrator, prepend worker context (SP7c feature).
  // Wrapped in try/catch so it degrades gracefully if orchestrations table doesn't exist yet.
  try {
    const orch = db.prepare(
      `SELECT id FROM orchestrations WHERE agent_name = ? AND status = 'running'`
    ).get(task.created_by);
    if (orch) {
      const scratchpadPath = join(getTasksDir(), `orch-${orch.id}`, 'scratchpad.md');
      const role = task.role ?? 'worker';
      const context = `## Context — Orchestration Worker\nRole: ${role}\nShared scratchpad: ${scratchpadPath}\nRead the scratchpad for context. Append your findings under ## Findings.\nWhen done, your task will be marked complete automatically.\n\n---\n\n`;
      writeTasks(agentName, context + readTasks(agentName));
    }
  } catch { /* orchestrations table not yet present — skip */ }

  appendTask(agentName, formatTaskForInjection(updated));
  broadcastGlobal({ type: 'queue_task_assigned', task: updated });
  return updated;
}

export function updateQueueTask(id, fields) {
  const allowed = ['title', 'description', 'priority', 'result', 'project_id'];
  const sets = ['updated_at = CURRENT_TIMESTAMP'];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  getDb().prepare(`UPDATE task_queue SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function completeQueueTask(id, result = '') {
  getDb().prepare(
    `UPDATE task_queue SET status = 'done', result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(result, id);
  broadcastGlobal({ type: 'queue_task_done', taskId: id });
}

export function cancelQueueTask(id) {
  getDb().prepare(
    `UPDATE task_queue SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(id);
}

export async function checkQueueTasks() {
  const inProgress = getDb().prepare(
    `SELECT * FROM task_queue WHERE status = 'in_progress' AND assigned_to IS NOT NULL`
  ).all();
  for (const task of inProgress) {
    try {
      const content = readTasks(task.assigned_to);
      const re = new RegExp(`^- \\[x\\] ${escapeRegex(task.title)}`, 'im');
      if (re.test(content)) completeQueueTask(task.id, '');
    } catch { /* task file unreadable — skip */ }
  }
}

export function startQueuePoller(intervalMs = 10000) {
  return setInterval(checkQueueTasks, intervalMs);
}

import { listQueueTasks, assignQueueTask as _assignQueueTask, notifyAgent } from './queue.js';
import { listAgents, getAgent } from './agents.js';
import { getSetting } from './settings.js';
import { spawnAgent as _spawnAgent } from './terminal.js';

const warnedRoles = new Set();

export async function autoAssignPendingTasks({
  spawnFn  = _spawnAgent,
  assignFn = _assignQueueTask,
} = {}) {
  const pending = listQueueTasks({ status: 'pending' });
  if (pending.length === 0) return;

  const agents = listAgents();

  const assignedByAgent = new Map();

  for (const task of pending) {
    let targetName;

    if (task.role) {
      const match = agents.find(a => a.role === task.role);
      if (!match) {
        if (!warnedRoles.has(task.role)) {
          console.log(`[auto-pickup] no agent with role "${task.role}" — task #${task.id} stays pending`);
          warnedRoles.add(task.role);
        }
        continue;
      }
      targetName = match.name;
    } else {
      targetName = getSetting('default_agent');
      if (!targetName) continue;
    }

    const agent = getAgent(targetName);
    if (!agent) continue;

    let assigned;
    try {
      assigned = assignFn(task.id, targetName, { skipNotify: true });
    } catch (err) {
      console.log(`[auto-pickup] could not assign task #${task.id} to "${targetName}": ${err.message}`);
      continue;
    }

    if (!assignedByAgent.has(targetName)) assignedByAgent.set(targetName, []);
    assignedByAgent.get(targetName).push(assigned);

    if (agent.status === 'stopped') {
      try {
        spawnFn(targetName, agent.workdir, agent.model || null, {});
      } catch (err) {
        console.log(`[auto-pickup] spawn failed for "${targetName}": ${err.message}`);
      }
    }
  }

  // Send one consolidated notification per agent so messages don't overlap
  for (const [agentName, tasks] of assignedByAgent) {
    notifyAgent(agentName, tasks);
  }
}

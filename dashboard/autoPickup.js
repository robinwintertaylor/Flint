import { listQueueTasks, assignQueueTask as _assignQueueTask, notifyAgent, createQueueTask } from './queue.js';
import { listAgents, getAgent, registerAgent } from './agents.js';
import { getSetting } from './settings.js';
import { resolveWorkdir } from './projects.js';
import { spawnAgent as _spawnAgent } from './terminal.js';
import { getSpecialist } from './specialists.js';
import { loadSpecialist } from '../agents/specialists/selector.js';

const warnedRoles = new Set();
const builderQueuedRoles = new Set();

// role -> agentName for agents we auto-provisioned; persists across poll cycles
// so we don't spin up duplicates if the agent hasn't appeared in the registry yet.
const provisionedRoles = new Map();

function runtimeForProvider(provider) {
  if (!provider || provider === 'anthropic') return 'claude';
  if (provider === 'openrouter') return 'openrouter';
  if (provider === 'ollama')     return 'ollama';
  if (provider === 'lmstudio')   return 'lmstudio';
  if (provider === 'mammouth')   return 'mammouth';
  return 'claude';
}

function modelForSpec(spec) {
  if (spec.preferred_model) return spec.preferred_model;
  const runtime = runtimeForProvider(spec.preferred_provider);
  if (runtime === 'openrouter') return 'openai/gpt-4o-mini';
  if (runtime === 'mammouth')   return 'gpt-5.4-mini';
  return '';
}

// Try to find (or create) an agent for a given role.
// Returns { agentName, spawnOptions, workdir } or null if no specialist exists for the role.
function provisionAgentForRole(role, projectId) {
  // Reuse a prior provisioned agent if it's still registered
  const prev = provisionedRoles.get(role);
  if (prev && getAgent(prev)) return { agentName: prev, spawnOptions: {} };

  const spec = getSpecialist(role);
  if (!spec) return null;

  // Pick a unique name
  const base = `${role}-auto`;
  let agentName = base;
  let n = 2;
  while (getAgent(agentName)) agentName = `${base}-${n++}`;

  const workdir = resolveWorkdir(projectId);
  const runtime = runtimeForProvider(spec.preferred_provider);
  const model   = modelForSpec(spec);
  const loaded  = loadSpecialist(spec.name);

  registerAgent(agentName, 'spawn', workdir, null, model, runtime, role);
  provisionedRoles.set(role, agentName);
  console.log(`[auto-pickup] provisioned "${agentName}" (${runtime}, specialist: ${spec.name}) for role "${role}"`);

  return { agentName, spawnOptions: { specialist: loaded }, workdir };
}

export async function autoAssignPendingTasks({
  spawnFn  = _spawnAgent,
  assignFn = _assignQueueTask,
} = {}) {
  const pending = listQueueTasks({ status: 'pending' });
  if (pending.length === 0) return;

  const agents = listAgents();

  // agentName -> { tasks, spawnOptions, workdir } for freshly provisioned agents
  const freshProvisions = new Map();
  const assignedByAgent = new Map();

  for (const task of pending) {
    let targetName;
    let spawnOptions = {};
    let provisionedWorkdir;

    // If already pre-assigned to a specific agent/specialist name, honour it
    if (task.assigned_to) {
      let agent = getAgent(task.assigned_to);

      // Helper: load specialist soul; fall back to a minimal soul from DB description
      // if filesystem files don't exist (e.g. created via API without files written)
      const loadSoul = (specName) => {
        const fromDisk = loadSpecialist(specName);
        if (fromDisk) return fromDisk;
        const spec = getSpecialist(specName);
        if (!spec) return null;
        return {
          ...spec,
          soul: `# ${spec.label}\n\nI am a specialist in ${spec.description || spec.label}.\n\n## My approach:\n- Complete assigned tasks thoroughly and accurately\n- Stay focused on my area of expertise\n- Report progress and findings clearly\n`,
        };
      };

      if (!agent) {
        // Not a panel agent yet — find the specialist and spawn it
        const spec = getSpecialist(task.assigned_to);
        if (!spec) {
          console.log(`[auto-pickup] task #${task.id} assigned to "${task.assigned_to}" but no agent or specialist found — skipping`);
          continue;
        }
        const workdir = resolveWorkdir(task.project_id);
        const runtime = runtimeForProvider(spec.preferred_provider);
        const model   = modelForSpec(spec);
        const loaded  = loadSoul(spec.name);
        registerAgent(task.assigned_to, 'spawn', workdir, null, model, runtime, task.assigned_to);
        agent = getAgent(task.assigned_to);
        console.log(`[auto-pickup] spawning specialist "${task.assigned_to}" for pre-assigned task #${task.id}`);
        try { spawnFn(task.assigned_to, workdir, model || null, { specialist: loaded }); } catch (err) {
          console.log(`[auto-pickup] spawn failed for "${task.assigned_to}": ${err.message}`);
          continue;
        }
      } else if (agent.status === 'stopped') {
        // Re-spawn with specialist soul so it doesn't run as a generic agent
        const loaded = loadSoul(task.assigned_to);
        try { spawnFn(task.assigned_to, agent.workdir, agent.model || null, { specialist: loaded }); } catch {}
      }

      try {
        const assigned = assignFn(task.id, task.assigned_to, { skipNotify: true });
        if (!assignedByAgent.has(task.assigned_to)) assignedByAgent.set(task.assigned_to, []);
        assignedByAgent.get(task.assigned_to).push(assigned);
      } catch (err) {
        console.log(`[auto-pickup] could not assign task #${task.id} to "${task.assigned_to}": ${err.message}`);
      }
      continue;
    }

    if (task.role) {
      const match = agents.find(a => a.role === task.role);
      if (!match) {
        // No existing agent — try to auto-provision one from a matching specialist
        const result = provisionAgentForRole(task.role, task.project_id);
        if (!result) {
          if (!warnedRoles.has(task.role)) {
            console.log(`[auto-pickup] no specialist for role "${task.role}" — task #${task.id} pending; queuing builder task`);
            warnedRoles.add(task.role);
          }
          // Queue a builder task to create the missing specialist (once per role per session)
          if (!builderQueuedRoles.has(task.role)) {
            const alreadyQueued = listQueueTasks({ role: 'builder' })
              .filter(t => t.status === 'pending' || t.status === 'in_progress')
              .some(t => t.title.includes(`role: ${task.role}`));
            if (!alreadyQueued) {
              createQueueTask({
                title: `Create specialist for role: ${task.role}`,
                description: `A queued task (id: ${task.id}, title: "${task.title}") requires role "${task.role}" but no specialist exists.\n\nPlease:\n1. Create \`agents/specialists/${task.role}/soul.md\` with the specialist's identity and approach\n2. Create \`agents/specialists/${task.role}/config.json\` with name, label, description, domains, preferred_provider, preferred_tier\n3. Add an entry to \`agents/specialists.json\`\n4. Register via: curl -s -X POST http://localhost:${process.env.PORT ?? 3000}/api/specialists -H "Content-Type: application/json" -d @agents/specialists/${task.role}/config.json`,
                role: 'builder',
                created_by: 'auto-pickup',
              });
              console.log(`[auto-pickup] queued builder task to create missing specialist "${task.role}"`);
            }
            builderQueuedRoles.add(task.role);
          }
          continue;
        }
        warnedRoles.delete(task.role);
        targetName         = result.agentName;
        spawnOptions       = result.spawnOptions;
        provisionedWorkdir = result.workdir;
        freshProvisions.set(targetName, { spawnOptions, workdir: provisionedWorkdir });
      } else {
        targetName = match.name;
      }
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
        const fp = freshProvisions.get(targetName);
        if (fp) {
          // Freshly provisioned — spawn once with specialist; don't spawn again below
          spawnFn(targetName, fp.workdir, null, fp.spawnOptions);
          freshProvisions.delete(targetName); // prevent double-spawn if multiple tasks go to same agent
        } else {
          spawnFn(targetName, agent.workdir, agent.model || null, {});
        }
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

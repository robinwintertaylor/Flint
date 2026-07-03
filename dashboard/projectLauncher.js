import { getProject, updateProject, resolveWorkdir } from './projects.js';
import { listSpecialists } from './specialists.js';
import { createOrchestration } from './orchestrator.js';
import { broadcastGlobal } from './agents.js';

export async function launchProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (!project.goal) throw new Error('Project has no goal — add a goal before launching');

  const workdir = resolveWorkdir(projectId);
  const specialists  = listSpecialists();

  const { id: orchestrationId } = await createOrchestration({
    goal:          project.goal,
    workdir,
    projectId,
    specialists,
    projectNotes:  project.notes || '',
    workspacePath: workdir,
    model:         getSetting('default_model') || 'claude-opus',
  });

  await updateProject(projectId, { active_orchestration_id: orchestrationId });
  broadcastGlobal({ type: 'project_launched', projectId, orchestrationId });

  return { orchestrationId };
}

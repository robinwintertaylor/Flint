import { getProject, updateProject } from './projects.js';
import { listWorkspaces } from './db.js';
import { getSetting } from './settings.js';
import { listSpecialists } from './specialists.js';
import { listDocsWithContent } from './project_docs.js';
import { createOrchestration } from './orchestrator.js';
import { broadcastGlobal } from './agents.js';

export async function launchProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (!project.goal) throw new Error('Project has no goal — add a goal before launching');

  // Resolve workdir: workspace path → default_workdir setting → cwd
  let workdir = null;
  if (project.workspace_id) {
    const workspaces = listWorkspaces();
    const ws = workspaces.find(w => w.id === project.workspace_id);
    if (ws) workdir = ws.path;
  }
  if (!workdir) workdir = getSetting('default_workdir') || null;
  if (!workdir) workdir = process.cwd();

  const specialists  = listSpecialists();
  const projectDocs  = listDocsWithContent(projectId);

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

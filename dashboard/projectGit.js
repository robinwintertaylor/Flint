import { execSync } from 'child_process';
import { getProject } from './projects.js';
import { isForgejoReachable, createRepo } from './forgejo.js';

const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';

// workdir -> chained Promise, so concurrent commits to the same project
// never race the same git index.
const commitLocks = new Map();

export function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

function isGitRepo(workdir) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: workdir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function hasAnyRemote(workdir) {
  try {
    const out = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Idempotent: safe to call on every project launch/relaunch/sync.
export async function ensureProjectRepo(projectId, workdir) {
  if (TEST_MODE()) return { hasRemote: false };

  if (!isGitRepo(workdir)) {
    execSync('git init', { cwd: workdir });
    try {
      execSync('git add -A', { cwd: workdir });
      execSync('git commit -m "Initial commit" --allow-empty', { cwd: workdir });
    } catch (err) {
      throw new Error(`Failed to create initial commit in ${workdir}: ${err.message}`);
    }
  }

  if (hasAnyRemote(workdir)) return { hasRemote: true };

  const reachable = await isForgejoReachable();
  if (!reachable) return { hasRemote: false };

  const project = getProject(projectId);
  const repoName = slugify(project?.name ?? `project-${projectId}`);
  const { cloneUrl } = await createRepo(repoName);
  execSync(`git remote add forgejo "${cloneUrl}"`, { cwd: workdir });
  execSync('git push forgejo HEAD:master', { cwd: workdir });
  return { hasRemote: true };
}

export function commitTaskForProject(workdir, message) {
  const prev = commitLocks.get(workdir) ?? Promise.resolve();
  const next = prev.then(() => {
    try {
      execSync('git add -A', { cwd: workdir });
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: workdir });
    } catch (err) {
      const output = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
      if (!/nothing to commit/i.test(output)) {
        console.warn(`[project-git] commit failed in ${workdir}: ${err.message}`);
      }
    }
  });
  commitLocks.set(workdir, next);
  return next;
}

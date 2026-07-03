import { execSync, execFileSync } from 'child_process';
import { resolve } from 'path';
import { realpathSync } from 'fs';
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

// Resolves a path to an absolute, case- and separator-normalized form so two
// paths that refer to the same directory (possibly via different casing or
// slash styles, as git on Windows can produce) compare equal.
function normalizePath(p) {
  let abs;
  try {
    abs = realpathSync(p);
  } catch {
    abs = resolve(p);
  }
  return abs.replace(/\\/g, '/').toLowerCase();
}

// Returns the normalized absolute toplevel directory of the git repository
// that contains `workdir`, or null if `workdir` is not inside any git repo.
// Note: this returns a toplevel for ANY enclosing repo, not just one rooted
// exactly at `workdir` — callers must compare it against `workdir` themselves
// to distinguish "workdir IS a repo root" from "workdir is nested inside one".
function gitToplevel(workdir) {
  try {
    const out = execSync('git rev-parse --show-toplevel', { cwd: workdir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return normalizePath(out.trim());
  } catch {
    return null;
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
//
// `deps` allows injecting the network/Forgejo-touching pieces for testing:
// isForgejoReachableFn, createRepoFn, pushFn. See dashboard/tests/projectGit.test.js
// for the "online path" test that exercises the real create-repo-and-push
// sequence with these stubbed out.
export async function ensureProjectRepo(projectId, workdir, {
  isForgejoReachableFn = isForgejoReachable,
  createRepoFn = createRepo,
  pushFn = (repoWorkdir) => execSync('git push forgejo HEAD:master', { cwd: repoWorkdir }),
} = {}) {
  if (TEST_MODE()) return { hasRemote: false };

  const toplevel = gitToplevel(workdir);
  const resolvedWorkdir = normalizePath(workdir);

  if (toplevel && toplevel !== resolvedWorkdir) {
    // workdir is inside a git repo, but is NOT that repo's root — e.g. it
    // resolved to Flint's own application root (or a subdirectory of it).
    // Treating this as "already a repo" would run git-add/commit/push
    // against the WRONG repo's .git; treating it as "blank" would nest a
    // second repo inside the first. Neither is safe — refuse outright.
    throw new Error(
      `Workdir ${workdir} is nested inside an existing git repository (root: ${toplevel}) that does not belong to this project — refusing to initialize or commit here.`
    );
  }

  if (!toplevel) {
    execSync('git init', { cwd: workdir });
    try {
      execSync('git add -A', { cwd: workdir });
      execSync('git commit -m "Initial commit" --allow-empty', { cwd: workdir });
    } catch (err) {
      throw new Error(`Failed to create initial commit in ${workdir}: ${err.message}`);
    }
  }

  if (hasAnyRemote(workdir)) return { hasRemote: true };

  const reachable = await isForgejoReachableFn();
  if (!reachable) return { hasRemote: false };

  const project = getProject(projectId);
  const repoName = slugify(project?.name ?? `project-${projectId}`);
  const { cloneUrl } = await createRepoFn(repoName);
  execSync(`git remote add forgejo "${cloneUrl}"`, { cwd: workdir });
  pushFn(workdir);
  return { hasRemote: true };
}

export function commitTaskForProject(workdir, message) {
  const prev = commitLocks.get(workdir) ?? Promise.resolve();
  const next = prev.then(() => {
    try {
      execSync('git add -A', { cwd: workdir });
      execFileSync('git', ['commit', '-m', message], { cwd: workdir });
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

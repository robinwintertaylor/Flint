import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDb, clearAgentWorktree, clearAgentPR } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function createWorktree(agentName) {
  const ts = timestamp();
  // Sanitize: replace spaces and git-invalid chars with hyphens, collapse multiples
  const safe = agentName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const branch = `improve/${safe}-${ts}`;
  const worktreePath = join(FLINT_ROOT, '.worktrees', `${safe}-${ts}`);
  execSync(`git worktree add -b "${branch}" "${worktreePath}"`, { cwd: FLINT_ROOT });
  return { worktreePath, branch };
}

export function listWorktrees() {
  return getDb().prepare(
    `SELECT name, worktree_path, worktree_branch, status, pr_number, pr_url, pr_status
     FROM agents_log WHERE worktree_path IS NOT NULL`
  ).all();
}

export function discardWorktree(agentName) {
  const row = getDb().prepare(
    `SELECT worktree_path, worktree_branch FROM agents_log WHERE name = ?`
  ).get(agentName);
  if (!row?.worktree_branch) throw new Error(`No worktree for agent: ${agentName}`);
  execSync(`git worktree remove --force "${row.worktree_path}"`, { cwd: FLINT_ROOT });
  execSync(`git branch -D "${row.worktree_branch}"`, { cwd: FLINT_ROOT });
  clearAgentWorktree(agentName);
  clearAgentPR(agentName);
}

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';

function cfg() {
  return {
    url:   process.env.FORGEJO_URL   ?? 'http://localhost:3030',
    owner: process.env.FORGEJO_OWNER ?? 'robin',
    repo:  process.env.FORGEJO_REPO  ?? 'flint',
  };
}

function getToken() {
  if (process.env.FORGEJO_TOKEN) return process.env.FORGEJO_TOKEN;
  const f = join(FLINT_ROOT, 'forgejo.token');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `token ${getToken()}`,
  };
}

export async function isForgejoReachable() {
  if (TEST_MODE()) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${cfg().url}/api/v1/version`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export function pushBranch(branch) {
  if (TEST_MODE()) return;
  execSync(`git push forgejo "${branch}"`, { cwd: FLINT_ROOT });
}

export async function createPR(branch, agentName) {
  const { url, owner, repo } = cfg();
  if (TEST_MODE()) {
    return { prNumber: 1, prUrl: `${url}/${owner}/${repo}/pulls/1` };
  }
  const res = await fetch(`${url}/api/v1/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      title: `[${agentName}] ${branch}`,
      head: branch,
      base: 'master',
      body: `Automated PR created by Flint agent \`${agentName}\`.`,
    }),
  });
  if (!res.ok) throw new Error(`Forgejo createPR failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { prNumber: data.number, prUrl: data.html_url };
}

export async function getPRStatus(prNumber) {
  if (TEST_MODE()) return 'open';
  const { url, owner, repo } = cfg();
  const res = await fetch(
    `${url}/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`Forgejo getPRStatus failed: ${res.status}`);
  const data = await res.json();
  if (data.merged) return 'merged';
  if (data.state === 'closed') return 'closed';
  return 'open';
}

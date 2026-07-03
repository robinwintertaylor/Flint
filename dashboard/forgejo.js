import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';

function cfg() {
  return {
    url: process.env.FORGEJO_URL ?? 'http://localhost:3030',
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

// Parses owner/repo from the `forgejo` remote configured in a given workdir,
// e.g. http://user:token@localhost:3030/owner/repo.git -> { owner: 'owner', repo: 'repo' }
function getForgejoRemoteInfo(workdir) {
  let out;
  try {
    out = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
  } catch {
    return null;
  }
  const line = out.split('\n').find(l => l.startsWith('forgejo\t'));
  if (!line) return null;
  const urlMatch = line.match(/forgejo\t(\S+)/);
  if (!urlMatch) return null;
  const parsed = urlMatch[1].match(/https?:\/\/(?:[^@/]+@)?[^/]+\/([^/]+)\/([^/.]+)(?:\.git)?/);
  if (!parsed) return null;
  return { owner: parsed[1], repo: parsed[2] };
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

export function pushBranch(branch, workdir = FLINT_ROOT) {
  if (TEST_MODE()) return;
  execSync(`git push forgejo "${branch}"`, { cwd: workdir });
}

export async function createPR(branch, agentName, workdir = FLINT_ROOT) {
  if (TEST_MODE()) {
    return { prNumber: 1, prUrl: `${cfg().url}/test/repo/pulls/1` };
  }
  const remoteInfo = getForgejoRemoteInfo(workdir);
  if (!remoteInfo) throw new Error(`No forgejo remote found in ${workdir}`);
  const { owner, repo } = remoteInfo;
  const res = await fetch(`${cfg().url}/api/v1/repos/${owner}/${repo}/pulls`, {
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

export async function getPRStatus(prNumber, workdir = FLINT_ROOT) {
  if (TEST_MODE()) return 'open';
  const remoteInfo = getForgejoRemoteInfo(workdir);
  if (!remoteInfo) throw new Error(`No forgejo remote found in ${workdir}`);
  const { owner, repo } = remoteInfo;
  const res = await fetch(`${cfg().url}/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Forgejo getPRStatus failed: ${res.status}`);
  const data = await res.json();
  if (data.merged) return 'merged';
  if (data.state === 'closed') return 'closed';
  return 'open';
}

// Creates (or reuses, if it already exists) a Forgejo repo named `name` under
// the admin user's account. Returns a clone URL with credentials embedded,
// matching the `user:token@host` convention scripts/forgejo-init.ps1 already uses.
export async function createRepo(name) {
  if (TEST_MODE()) {
    return { cloneUrl: `http://test:test@localhost:3030/test/${name}.git` };
  }
  const { url } = cfg();
  const token = getToken();
  const me = await fetch(`${url}/api/v1/user`, { headers: authHeaders() }).then(r => r.json());
  const res = await fetch(`${url}/api/v1/user/repos`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, private: true, auto_init: false }),
  });
  let cloneUrl;
  if (res.status === 409) {
    const existing = await fetch(`${url}/api/v1/repos/${me.login}/${name}`, { headers: authHeaders() });
    if (!existing.ok) throw new Error(`Forgejo repo "${name}" reported as existing but could not be fetched`);
    cloneUrl = (await existing.json()).clone_url;
  } else if (!res.ok) {
    throw new Error(`Forgejo createRepo failed: ${res.status} ${await res.text()}`);
  } else {
    cloneUrl = (await res.json()).clone_url;
  }
  return { cloneUrl: cloneUrl.replace(/^https?:\/\//, (m) => `${m}${me.login}:${token}@`) };
}

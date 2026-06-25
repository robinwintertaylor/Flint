import { execSync } from 'child_process';
import { getApiKeyValue } from './apikeys.js';

const TEST_MODE = () => process.env.FLINT_TEST_MODE === '1';
const GITHUB_API = 'https://api.github.com';

function getToken() {
  return getApiKeyValue('github') ?? '';
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
    'User-Agent': 'Flint/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function findGitHubRemote(workdir) {
  const out = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
  const match = out.match(/^(\S+)\s+[^\s]*github\.com/m);
  return match?.[1] ?? null;
}

export function parseOwnerRepo(remoteUrl) {
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function detectProvider(workdir) {
  try {
    const out = execSync('git remote -v', { cwd: workdir, encoding: 'utf8' });
    return out.includes('github.com') ? 'github' : 'forgejo';
  } catch {
    return 'forgejo';
  }
}

export async function isGitHubReachable() {
  if (TEST_MODE()) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(GITHUB_API, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export function pushToGitHub(branch, workdir) {
  if (TEST_MODE()) return;
  const remote = findGitHubRemote(workdir);
  if (!remote) throw new Error(`No GitHub remote found in ${workdir}`);
  execSync(`git push "${remote}" "${branch}"`, { cwd: workdir });
}

export async function createGitHubPR(branch, agentName, workdir) {
  if (TEST_MODE()) {
    return { prNumber: 1, prUrl: 'https://github.com/test/repo/pull/1' };
  }
  const remote = findGitHubRemote(workdir);
  if (!remote) throw new Error(`No GitHub remote found in ${workdir}`);
  const remoteUrl = execSync(`git remote get-url "${remote}"`, {
    cwd: workdir,
    encoding: 'utf8',
  }).trim();
  const parsed = parseOwnerRepo(remoteUrl);
  if (!parsed) throw new Error(`Cannot parse owner/repo from remote URL: ${remoteUrl}`);
  const { owner, repo } = parsed;
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      title: `[${agentName}] ${branch}`,
      head: branch,
      base: 'master',
      body: `Automated PR created by Flint agent \`${agentName}\`.`,
    }),
  });
  if (!res.ok) throw new Error(`GitHub createPR failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { prNumber: data.number, prUrl: data.html_url };
}

export async function getGitHubPRStatus(prNumber, prUrl) {
  if (TEST_MODE()) return 'open';
  const parsed = parseOwnerRepo(prUrl);
  if (!parsed) throw new Error(`Cannot parse owner/repo from PR URL: ${prUrl}`);
  const { owner, repo } = parsed;
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`GitHub getPRStatus failed: ${res.status}`);
  const data = await res.json();
  if (data.merged) return 'merged';
  if (data.state === 'closed') return 'closed';
  return 'open';
}

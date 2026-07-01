import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

import { initDb, getTodayCost, getMonthCost, closeDb, upsertAgentLog, setAgentWorktree, getAgentWorktree, setAgentPR, clearAgentPR, getAgentPR, listOpenPRAgents, clearAgentWorktree, listWorkspaces, addWorkspace, removeWorkspace } from './db.js';
import { initAgents, registerAgent, listAgents, getAgent, addWsClient, removeWsClient, killAgent, removeAgent, broadcastToAgent, addGlobalWsClient, removeGlobalWsClient, updateAgentMeta, broadcastGlobal } from './agents.js';
import { listSuggestions, updateSuggestion } from './suggestions.js';
import { listWorktrees, createWorktree, discardWorktree } from './worktrees.js';
import { spawnAgent, writeToAgent, observeLogFile } from './terminal.js';
import { readTasks, writeTasks, appendTask } from './tasks.js';
import { listProjects, getProject, createProject, updateProject, linkAgent, unlinkAgent } from './projects.js';
import { isForgejoReachable, pushBranch, createPR, getPRStatus } from './forgejo.js';
import { detectProvider, isGitHubReachable, pushToGitHub, createGitHubPR, getGitHubPRStatus } from './github.js';
import { info, error as logError } from './logger.js';
import { listMcpServers, addMcpServer, updateMcpServer, removeMcpServer } from './mcp.js';
import { listQueueTasks, getQueueTask, createQueueTask, assignQueueTask, updateQueueTask, completeQueueTask, cancelQueueTask, deleteQueueTask, startQueuePoller, releaseOrphanedTasks } from './queue.js';
import { createOrchestration, getOrchestration, listOrchestrations, appendScratchpad, readScratchpad } from './orchestrator.js';
import { listApiKeys, getApiKeyValue, createApiKey, updateApiKey, deleteApiKey, buildApiKeyEnv } from './apikeys.js';
import { initSupabase, isSupabaseEnabled, upsertMemory, searchMemories, logSessionStart, logSessionEnd, pullMemories } from './supabase.js';
import { initTelegram } from './telegram.js';
import { isOllamaReachable, listModels, generate } from './ollama.js';
import { isLmStudioReachable, listModels as listLmStudioModels, generate as lmStudioGenerate } from './lmstudio.js';
import { listSkills, getSkill, createSkill, updateSkill, deleteSkill, upsertSkill } from './skills.js';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { listDocs, getDoc, createDoc, deleteDoc } from './project_docs.js';
import { listSpecialists, getSpecialist, createSpecialist, updateSpecialist, deleteSpecialist } from './specialists.js';
import { loadSpecialist } from '../agents/specialists/selector.js';
import { getSetting, setSetting } from './settings.js';
import { getHeartbeatLog, runHeartbeatCycle, startHeartbeat } from './heartbeat.js';
import { flintChat } from './chat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');
const PORT = process.env.PORT ?? 3000;
const TEST_MODE = process.env.FLINT_TEST_MODE === '1';

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (!meta.name || !meta.description) return null;
  return { name: meta.name, description: meta.description, tags: meta.tags ?? '', body: m[2].trim() };
}

export { closeDb } from './db.js';

async function createPRForAgent(name, branch) {
  try {
    info('creating PR', { agent: name, branch });
    const worktree = getAgentWorktree(name);
    const workdir = worktree?.worktree_path ?? FLINT_ROOT;
    const provider = detectProvider(workdir);

    if (provider === 'github') {
      const reachable = await isGitHubReachable();
      if (!reachable) {
        logError('PR creation skipped — GitHub unreachable', { agent: name });
        broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
        return;
      }
      pushToGitHub(branch, workdir);
      const { prNumber, prUrl } = await createGitHubPR(branch, name, workdir);
      setAgentPR(name, prNumber, prUrl, 'open');
      broadcastToAgent(name, { type: 'worktree_pr', agent: name, prUrl, prNumber });
      info('PR created', { agent: name, prNumber, prUrl });
    } else {
      const reachable = await isForgejoReachable();
      if (!reachable) {
        logError('PR creation skipped — Forgejo unreachable', { agent: name });
        broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
        return;
      }
      pushBranch(branch);
      const { prNumber, prUrl } = await createPR(branch, name);
      setAgentPR(name, prNumber, prUrl, 'open');
      broadcastToAgent(name, { type: 'worktree_pr', agent: name, prUrl, prNumber });
      info('PR created', { agent: name, prNumber, prUrl });
    }
  } catch (err) {
    logError('PR creation failed', { agent: name, err: err.message });
    broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
  }
}

async function handlePRMerged(name) {
  try {
    const worktree = getAgentWorktree(name);
    if (worktree?.worktree_path) {
      execSync(`git worktree remove --force "${worktree.worktree_path}"`, { cwd: FLINT_ROOT });
    }
    if (worktree?.worktree_branch) {
      try { execSync(`git branch -D "${worktree.worktree_branch}"`, { cwd: FLINT_ROOT }); } catch {}
    }
  } catch (err) {
    logError('cleanup after PR merge failed', { agent: name, err: err.message });
  }
  clearAgentWorktree(name);
  clearAgentPR(name);
}

export function createApp() {
  // Init subsystems
  initDb(process.env.FLINT_DB_PATH);
  Object.assign(process.env, buildApiKeyEnv());
  initSupabase();
  initAgents(process.env.FLINT_AGENTS_FILE);
  if (!TEST_MODE) startQueuePoller();
  if (!TEST_MODE) initTelegram({ writeToAgent, createQueueTask });

  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));
  app.use('/images', express.static(join(FLINT_ROOT, 'images')));

  // --- REST routes ---

  app.get('/config', (_req, res) => {
    res.json({ defaultWorkdir: process.cwd() });
  });

  app.get('/diffs/:agent', (req, res) => {
    const worktree = getAgentWorktree(req.params.agent);
    if (!worktree?.worktree_branch) return res.status(404).json({ error: 'no worktree for this agent' });
    try {
      const diff = execSync(
        `git diff master...${worktree.worktree_branch}`,
        { cwd: FLINT_ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
      );
      const stat = execSync(
        `git diff --stat master...${worktree.worktree_branch}`,
        { cwd: FLINT_ROOT, encoding: 'utf8' }
      );
      res.json({ branch: worktree.worktree_branch, stat: stat.trim(), diff: diff.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/agents', (_req, res) => {
    res.json(listAgents());
  });

  app.get('/agents/:name', (req, res) => {
    const agent = getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'not found' });
    const { name, mode, status, workdir, model, runtime, role } = agent;
    res.json({ name, mode, status, workdir, model: model ?? '', runtime: runtime ?? 'claude', role: role ?? null });
  });

  app.get('/workspaces', (_req, res) => res.json(listWorkspaces()));
  app.post('/workspaces', (req, res) => {
    const { name, path } = req.body ?? {};
    if (!name || !path) return res.status(400).json({ error: 'name and path required' });
    try {
      const r = addWorkspace(name, path);
      res.json({ id: r.lastInsertRowid, name, path });
    } catch {
      res.status(409).json({ error: 'workspace path already registered' });
    }
  });
  app.delete('/workspaces/:id', (req, res) => {
    removeWorkspace(Number(req.params.id));
    res.json({ ok: true });
  });

  // --- MCP server routes ---

  app.get('/mcp/servers', (_req, res) => res.json(listMcpServers()));

  app.post('/mcp/servers', (req, res) => {
    const { name, command, args = [], env = {}, scope = 'global', enabled = 1 } = req.body ?? {};
    if (!name || !command) return res.status(400).json({ error: 'name and command required' });
    try {
      const id = addMcpServer({ name, command, args, env, scope, enabled });
      res.status(201).json({ id, name, command, args, env, scope, enabled });
    } catch {
      res.status(409).json({ error: 'server name already registered' });
    }
  });

  app.patch('/mcp/servers/:id', (req, res) => {
    updateMcpServer(Number(req.params.id), req.body ?? {});
    res.json({ ok: true });
  });

  app.delete('/mcp/servers/:id', (req, res) => {
    const changes = removeMcpServer(Number(req.params.id));
    if (!changes) return res.status(404).json({ error: 'server not found' });
    res.json({ ok: true });
  });

  // --- Task queue routes ---

  app.get('/queue/config', (_req, res) => {
    res.json({
      defaultAgent:   getSetting('default_agent')   ?? '',
      defaultWorkdir: getSetting('default_workdir') ?? '',
    });
  });

  app.patch('/queue/config', (req, res) => {
    const { defaultAgent, defaultWorkdir } = req.body ?? {};
    if (defaultAgent   !== undefined) setSetting('default_agent',   defaultAgent   ?? '');
    if (defaultWorkdir !== undefined) setSetting('default_workdir', defaultWorkdir ?? '');
    res.json({
      defaultAgent:   getSetting('default_agent')   ?? '',
      defaultWorkdir: getSetting('default_workdir') ?? '',
    });
  });

  app.get('/queue/tasks', (req, res) => {
    const { status, assigned_to, role, project_id, created_by } = req.query;
    res.json(listQueueTasks({
      ...(status      ? { status }      : {}),
      ...(assigned_to ? { assigned_to } : {}),
      ...(role        ? { role }         : {}),
      ...(project_id  ? { project_id: Number(project_id) } : {}),
      ...(created_by  ? { created_by }  : {}),
    }));
  });

  app.get('/queue/tasks/:id', (req, res) => {
    const task = getQueueTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json(task);
  });

  app.post('/queue/tasks', (req, res) => {
    const { title, description, project_id, assigned_to, role, priority, created_by } = req.body ?? {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const task = createQueueTask({ title, description, project_id, assigned_to, role, priority, created_by });
    res.status(201).json(task);
  });

  app.patch('/queue/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    const task = getQueueTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const { assigned_to, status, result, priority, description } = req.body ?? {};
    if (assigned_to !== undefined) {
      try {
        return res.json(assignQueueTask(id, assigned_to));
      } catch (err) {
        if (err.message.includes('already')) return res.status(409).json({ error: err.message });
        return res.status(500).json({ error: err.message });
      }
    }
    if (status === 'done')      { completeQueueTask(id, result ?? ''); return res.json(getQueueTask(id)); }
    if (status === 'cancelled') { cancelQueueTask(id); return res.json(getQueueTask(id)); }
    if (priority !== undefined || description !== undefined) {
      updateQueueTask(id, { ...(priority !== undefined ? { priority } : {}), ...(description !== undefined ? { description } : {}) });
    }
    res.json(getQueueTask(id));
  });

  app.delete('/queue/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    const task = getQueueTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (['cancelled', 'done', 'failed'].includes(task.status)) {
      deleteQueueTask(id);
      res.json({ ok: true, deleted: true });
    } else {
      cancelQueueTask(id);
      res.json({ ok: true, deleted: false });
    }
  });

  app.post('/queue/release-orphaned', (_req, res) => {
    const count = releaseOrphanedTasks();
    res.json({ released: count });
  });

  app.post('/agents/spawn', (req, res) => {
    const { name, workdir, model, runtime, specialistName, role } = req.body ?? {};
    if (!name || !workdir) return res.status(400).json({ error: 'name and workdir required' });
    registerAgent(name, 'spawn', workdir, null, model ?? '', runtime ?? 'claude', role ?? null);
    if (!TEST_MODE) {
      const specialist = specialistName ? loadSpecialist(specialistName) : null;
      spawnAgent(name, workdir, model ?? null, { onWorktreePending: createPRForAgent, specialist });
    }
    res.json({ ok: true, name });
  });

  app.post('/agents/observe', (req, res) => {
    const { name, logPath } = req.body ?? {};
    if (!name || !logPath) return res.status(400).json({ error: 'name and logPath required' });
    registerAgent(name, 'observe', null, logPath);
    if (!TEST_MODE) observeLogFile(name, logPath);
    res.json({ ok: true, name });
  });

  app.post('/agents/attach', (_req, res) => {
    res.status(501).json({ error: 'Attach by PID not supported on Windows — use observe mode with attach.ps1 instead' });
  });

  app.patch('/agents/:name', (req, res) => {
    const agent = getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'not found' });
    const { model, runtime } = req.body ?? {};
    const VALID_RUNTIMES = ['claude', 'openrouter', 'mammouth', 'ollama', 'lmstudio', 'vibe'];
    if (runtime !== undefined && !VALID_RUNTIMES.includes(runtime)) {
      return res.status(400).json({ error: `invalid runtime — must be one of: ${VALID_RUNTIMES.join(', ')}` });
    }
    updateAgentMeta(req.params.name, { model, runtime });
    const updated = getAgent(req.params.name);
    broadcastGlobal({ type: 'agent_updated', agent: updated.name, model: updated.model, runtime: updated.runtime });
    res.json({ ok: true, model: updated.model, runtime: updated.runtime });
  });

  app.delete('/agents/:name', (req, res) => {
    res.json({ ok: removeAgent(req.params.name) });
  });

  // Direct message relay — any agent or external caller can send a message to a named agent's terminal
  app.post('/agents/:name/message', (req, res) => {
    const agent = getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { message, from } = req.body ?? {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const tag = from ? `[Message from ${from}]` : '[Message]';
    const coloured = `\n\x1b[36m${tag}: ${message}\x1b[0m\n`;
    writeToAgent(req.params.name, coloured);
    broadcastToAgent(req.params.name, { type: 'output', agent: req.params.name, data: coloured });
    res.json({ ok: true });
  });

  app.get('/tasks/:agent', (req, res) => {
    res.json({ content: readTasks(req.params.agent) });
  });

  app.patch('/tasks/:agent', (req, res) => {
    const { content } = req.body ?? {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    writeTasks(req.params.agent, content);
    broadcastToAgent(req.params.agent, { type: 'tasks', agent: req.params.agent, content });
    res.json({ ok: true });
  });

  app.post('/tasks/:agent', (req, res) => {
    const { task } = req.body ?? {};
    if (!task) return res.status(400).json({ error: 'task required' });
    appendTask(req.params.agent, task);
    const content = readTasks(req.params.agent);
    broadcastToAgent(req.params.agent, { type: 'tasks', agent: req.params.agent, content });
    res.json({ ok: true });
  });

  app.delete('/tasks/:agent', (req, res) => {
    const { agent } = req.params;
    const reset = `# Tasks — ${agent}\n\n`;
    writeTasks(agent, reset);
    broadcastToAgent(agent, { type: 'tasks', agent, content: reset });
    res.json({ ok: true });
  });

  app.get('/costs', (_req, res) => {
    const agents = listAgents();
    const costs = agents.map(({ name }) => ({ agent: name, today: getTodayCost(name) }));
    res.json({ costs, monthTotal: getMonthCost() });
  });

  app.get('/router/models', async (_req, res) => {
    try {
      const r = await fetch('http://localhost:3001/llm/models');
      const data = await r.json();
      res.json(data);
    } catch {
      res.json({ error: 'router not running' });
    }
  });

  app.get('/api/openrouter/models', async (_req, res) => {
    try {
      const key = getApiKeyValue('openrouter');
      if (!key) return res.status(400).json({ error: 'OpenRouter API key not configured' });
      const r = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return res.status(r.status).json({ error: `OpenRouter API error ${r.status}` });
      const data = await r.json();
      // Score by a mix of context length and provider tier — penalise
      // unknown/niche providers so well-known frontier models surface first.
      const TIER1 = new Set(['anthropic', 'openai', 'google', 'meta-llama', 'mistralai', 'deepseek', 'qwen', 'microsoft', 'x-ai', 'cohere']);
      const score = m => {
        const provider = m.id.split('/')[0];
        const tier = TIER1.has(provider) ? 1 : 0;
        return tier * 10_000_000 + (m.context_length || 0);
      };
      const models = (data.data || [])
        .filter(m => m.id && !m.id.startsWith(':'))
        .sort((a, b) => score(b) - score(a))
        .map(m => ({ id: m.id, name: m.name || m.id }));
      res.json(models);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mammouth doesn't expose a public /models endpoint, so models are hardcoded.
  app.get('/api/mammouth/models', (_req, res) => {
    res.json([
      { id: 'gpt-5.5',                           name: 'GPT-5.5' },
      { id: 'gpt-5.4',                           name: 'GPT-5.4' },
      { id: 'gpt-5.4-mini',                      name: 'GPT-5.4 Mini' },
      { id: 'gpt-5.4-nano',                      name: 'GPT-5.4 Nano' },
      { id: 'gpt-5.3-chat',                      name: 'GPT-5.3 Chat' },
      { id: 'gpt-5.1',                           name: 'GPT-5.1' },
      { id: 'mistral-medium-3.1',                name: 'Mistral Medium 3.1' },
      { id: 'mistral-small-2603',                name: 'Mistral Small 2603' },
      { id: 'grok-4.3',                          name: 'Grok 4.3' },
      { id: 'gemini-3.1-flash-image-preview',    name: 'Gemini 3.1 Flash Image Preview' },
      { id: 'gemini-3.1-flash-lite-preview',     name: 'Gemini 3.1 Flash Lite Preview' },
      { id: 'gemini-3-flash-preview',            name: 'Gemini 3 Flash Preview' },
      { id: 'gemini-3.1-pro-preview',            name: 'Gemini 3.1 Pro Preview' },
      { id: 'glm-5.1',                           name: 'GLM-5.1' },
      { id: 'deepseek-v4-flash',                 name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro',                   name: 'DeepSeek V4 Pro' },
      { id: 'kimi-k2.6',                         name: 'Kimi K2.6' },
      { id: 'llama-4-maverick',                  name: 'Llama 4 Maverick' },
      { id: 'llama-4-scout',                     name: 'Llama 4 Scout' },
      { id: 'sonar-pro',                         name: 'Sonar Pro' },
      { id: 'sonar-deep-research',               name: 'Sonar Deep Research' },
      { id: 'claude-haiku-4-5',                  name: 'Claude Haiku 4.5' },
      { id: 'claude-opus-4.7',                   name: 'Claude Opus 4.7' },
      { id: 'claude-sonnet-4-6',                 name: 'Claude Sonnet 4.6' },
    ]);
  });

  app.get('/router/config', async (_req, res) => {
    try {
      const r = await fetch('http://localhost:3001/llm/config');
      const data = await r.json();
      res.json(data);
    } catch {
      res.json({ error: 'router not running' });
    }
  });

  // --- Health ---

  app.get('/health', async (_req, res) => {
    const [forgejoOk, ollamaOk, lmstudioOk] = await Promise.all([
      isForgejoReachable(), isOllamaReachable(), isLmStudioReachable(),
    ]);
    res.json({
      status: forgejoOk ? 'ok' : 'degraded',
      uptime: Math.floor(process.uptime()),
      db: 'connected',
      forgejo:  forgejoOk  ? 'reachable' : 'unreachable',
      ollama:   ollamaOk   ? 'reachable' : 'unreachable',
      lmstudio: lmstudioOk ? 'reachable' : 'unreachable',
    });
  });

  // --- Ollama routes ---

  app.get('/api/ollama/status', async (_req, res) => {
    const reachable = await isOllamaReachable();
    const models = reachable ? await listModels() : [];
    res.json({ reachable, models });
  });

  app.post('/api/ollama/generate', async (req, res) => {
    const { model, prompt } = req.body ?? {};
    if (!model || !prompt) return res.status(400).json({ error: 'model and prompt required' });
    try {
      const response = await generate(model, prompt);
      res.json({ response });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- LM Studio routes ---

  app.get('/api/lmstudio/status', async (_req, res) => {
    const reachable = await isLmStudioReachable();
    const models = reachable ? await listLmStudioModels() : [];
    res.json({ reachable, models });
  });

  app.post('/api/lmstudio/generate', async (req, res) => {
    const { model, prompt } = req.body ?? {};
    if (!model || !prompt) return res.status(400).json({ error: 'model and prompt required' });
    try {
      const response = await lmStudioGenerate(model, prompt);
      res.json({ response });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Docker routes ---

  app.post('/api/docker/start', (_req, res) => {
    if (TEST_MODE) return res.json({ ok: true });
    try {
      execSync('docker compose up -d', { cwd: FLINT_ROOT, timeout: 30000 });
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // --- Skills routes ---

  app.get('/api/skills', (_req, res) => {
    res.json(listSkills());
  });

  // import-github MUST be registered before /:id to avoid path collision
  app.post('/api/skills/import-github', async (req, res) => {
    const { url } = req.body ?? {};
    if (!url) return res.status(400).json({ error: 'url required' });
    if (TEST_MODE) return res.json({ imported: 1, updated: 0, skipped: 0 });
    try {
      const ghMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/([^/]+)(?:\/(.*))?)?(?:\.git)?(?:\/)?$/);
      if (!ghMatch) return res.status(400).json({ error: 'invalid GitHub URL' });
      const [, owner, repo, urlBranch, urlPrefix] = ghMatch;

      const ghToken = getApiKeyValue('github');
      const ghHeaders = ghToken
        ? { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json' }
        : { Accept: 'application/vnd.github+json' };

      let branch = urlBranch;
      if (!branch) {
        const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders });
        if (!repoRes.ok) return res.status(400).json({ error: `GitHub API error: ${repoRes.status}` });
        branch = (await repoRes.json()).default_branch;
      }

      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        { headers: ghHeaders }
      );
      if (!treeRes.ok) return res.status(400).json({ error: `GitHub tree API error: ${treeRes.status}` });
      const treeData = await treeRes.json();

      const candidates = (treeData.tree ?? []).filter(item => {
        if (item.type !== 'blob' || !item.path.endsWith('.md')) return false;
        if (urlPrefix && !item.path.startsWith(urlPrefix)) return false;
        const parts = item.path.split('/');
        const filename = parts[parts.length - 1].toLowerCase();
        const inSkillsDir = parts.some((p, i) => i < parts.length - 1 && p.toLowerCase() === 'skills');
        return filename === 'skill.md' || inSkillsDir;
      });

      let imported = 0, updated = 0, skipped = 0;
      for (const item of candidates) {
        const contentRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}?ref=${branch}`,
          { headers: ghHeaders }
        );
        if (!contentRes.ok) { skipped++; continue; }
        const raw = Buffer.from((await contentRes.json()).content, 'base64').toString('utf8');
        const parsed = parseFrontmatter(raw);
        if (!parsed) { skipped++; continue; }
        const result = upsertSkill({ name: parsed.name, description: parsed.description, content: parsed.body, source: `github:${url}`, tags: parsed.tags });
        if (result.created) imported++; else updated++;
      }
      res.json({ imported, updated, skipped });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/skills', (req, res) => {
    const { name, description, content, source, tags } = req.body ?? {};
    if (!name || !description || !content) return res.status(400).json({ error: 'name, description, and content required' });
    try {
      const id = createSkill({ name, description, content, source: source ?? 'manual', tags: tags ?? '' });
      res.status(201).json({ id });
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'skill name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/skills/:id', (req, res) => {
    const skill = getSkill(Number(req.params.id));
    if (!skill) return res.status(404).json({ error: 'skill not found' });
    res.json(skill);
  });

  app.patch('/api/skills/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getSkill(id)) return res.status(404).json({ error: 'skill not found' });
    const body = req.body ?? {};
    const fields = {};
    for (const k of ['name', 'description', 'content', 'tags']) {
      if (k in body) fields[k] = body[k];
    }
    try {
      updateSkill(id, fields);
      res.json(getSkill(id));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'skill name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/skills/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getSkill(id)) return res.status(404).json({ error: 'skill not found' });
    deleteSkill(id);
    res.status(204).end();
  });

  // --- Project routes ---

  app.get('/projects', (_req, res) => {
    res.json(listProjects());
  });

  app.get('/projects/:id', (req, res) => {
    const p = getProject(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'project not found' });
    res.json(p);
  });

  app.post('/projects', (req, res) => {
    const { name, notes } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      const id = createProject({ name, notes: notes ?? '' });
      res.status(201).json(getProject(id));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'project name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/projects/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    const { name, status, notes } = req.body ?? {};
    const VALID_STATUSES = ['active', 'paused', 'done', 'archived'];
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (status !== undefined) fields.status = status;
    if (notes !== undefined) fields.notes = notes;
    if (Object.keys(fields).length) updateProject(id, fields);
    res.json(getProject(id));
  });

  app.delete('/projects/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    updateProject(id, { status: 'archived' });
    res.json({ ok: true });
  });

  app.post('/projects/:id/agents', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    const { agentName } = req.body ?? {};
    if (!agentName) return res.status(400).json({ error: 'agentName required' });
    linkAgent(id, agentName);
    res.json({ ok: true });
  });

  app.delete('/projects/:id/agents/:agentName', (req, res) => {
    const id = Number(req.params.id);
    if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
    unlinkAgent(id, req.params.agentName);
    res.json({ ok: true });
  });

  // --- Project doc routes ---

  app.get('/api/projects/:id/docs', (req, res) => {
    res.json(listDocs(Number(req.params.id)));
  });

  app.post('/api/projects/:id/docs', async (req, res) => {
    const { title, content, mimeType = 'text/plain', source = 'upload' } = req.body ?? {};
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });
    const projectId = Number(req.params.id);
    let text = content;
    if (mimeType === 'application/pdf' && !TEST_MODE) {
      try {
        const b64 = content.replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(b64, 'base64');
        const parsed = await pdfParse(buf);
        text = parsed.text;
      } catch (err) {
        return res.status(422).json({ error: `PDF extraction failed: ${err.message}` });
      }
    }
    try {
      const id = createDoc({ projectId, title, mimeType, content: text, source });
      res.status(201).json({ id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id/docs/:docId', (req, res) => {
    const doc = getDoc(Number(req.params.docId));
    if (!doc) return res.status(404).json({ error: 'doc not found' });
    res.json(doc);
  });

  app.delete('/api/projects/:id/docs/:docId', (req, res) => {
    const id = Number(req.params.docId);
    if (!getDoc(id)) return res.status(404).json({ error: 'doc not found' });
    deleteDoc(id);
    res.status(204).end();
  });

  // --- Specialist routes ---

  app.get('/api/specialists', (_req, res) => {
    res.json(listSpecialists());
  });

  app.post('/api/specialists', (req, res) => {
    const { name, label, description, domains, skills, preferred_tier, preferred_provider, preferred_model, created_by, soul } = req.body ?? {};
    if (!name || !label) return res.status(400).json({ error: 'name and label required' });
    try {
      createSpecialist({ name, label, description, domains, skills, preferred_tier, preferred_provider, preferred_model, created_by });
      if (soul !== undefined) {
        const dir = join(FLINT_ROOT, 'agents', 'specialists', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'soul.md'), soul, 'utf8');
        const config = { name, label, description: description ?? '', domains: domains ?? [], skills: skills ?? [], preferred_tier: preferred_tier ?? 2, preferred_provider: preferred_provider ?? null, created_by: created_by ?? 'robin', created_at: new Date().toISOString(), use_count: 0, last_used: null };
        writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
        const idxPath = join(FLINT_ROOT, 'agents', 'specialists.json');
        let idx = [];
        try { idx = JSON.parse(readFileSync(idxPath, 'utf8')); } catch {}
        const entry = { name, label, description: description ?? '', domains: domains ?? [], use_count: 0, last_used: null };
        const pos = idx.findIndex(s => s.name === name);
        if (pos >= 0) idx[pos] = entry; else idx.push(entry);
        writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf8');
      }
      res.status(201).json(getSpecialist(name));
    } catch (err) {
      if (err.message?.includes('UNIQUE') || err.message?.includes('already')) return res.status(409).json({ error: 'specialist name already exists' });
      if (err.message?.includes('lowercase')) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/specialists/:name', (req, res) => {
    const specialist = getSpecialist(req.params.name);
    if (!specialist) return res.status(404).json({ error: 'specialist not found' });
    const soulPath = join(FLINT_ROOT, 'agents', 'specialists', req.params.name, 'soul.md');
    const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '';
    res.json({ ...specialist, soul });
  });

  app.patch('/api/specialists/:name', (req, res) => {
    const { soul, ...fields } = req.body ?? {};
    if (!getSpecialist(req.params.name)) return res.status(404).json({ error: 'specialist not found' });
    updateSpecialist(req.params.name, fields);
    if (soul !== undefined) {
      const soulPath = join(FLINT_ROOT, 'agents', 'specialists', req.params.name, 'soul.md');
      mkdirSync(dirname(soulPath), { recursive: true });
      writeFileSync(soulPath, soul, 'utf8');
    }
    res.json(getSpecialist(req.params.name));
  });

  app.delete('/api/specialists/:name', (req, res) => {
    const changes = deleteSpecialist(req.params.name);
    if (!changes) return res.status(404).json({ error: 'specialist not found' });
    try { rmSync(join(FLINT_ROOT, 'agents', 'specialists', req.params.name), { recursive: true, force: true }); } catch {}
    const idxPath = join(FLINT_ROOT, 'agents', 'specialists.json');
    try {
      let idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      idx = idx.filter(s => s.name !== req.params.name);
      writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf8');
    } catch {}
    res.status(204).end();
  });

  // --- Suggestion routes ---

  app.get('/suggestions', (_req, res) => {
    res.json(listSuggestions());
  });

  app.patch('/suggestions/:id', (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    const VALID = ['new', 'noted', 'dismissed'];
    if (!VALID.includes(status)) return res.status(400).json({ error: 'invalid status' });
    updateSuggestion(id, { status });
    res.json({ ok: true });
  });

  // --- Worktree routes ---

  app.get('/worktrees', (_req, res) => {
    res.json(listWorktrees());
  });

  app.delete('/worktrees/:agent', (req, res) => {
    try {
      discardWorktree(req.params.agent);
      broadcastToAgent(req.params.agent, { type: 'worktree_discarded', agent: req.params.agent });
      res.json({ ok: true });
    } catch (err) {
      if (err.message.includes('No worktree')) return res.status(404).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // --- Orchestration routes ---

  app.get('/orchestrations', (_req, res) => res.json(listOrchestrations()));

  app.get('/orchestrations/:id', (req, res) => {
    const orch = getOrchestration(Number(req.params.id));
    if (!orch) return res.status(404).json({ error: 'orchestration not found' });
    res.json(orch);
  });

  app.post('/orchestrations', (req, res) => {
    const { goal, workdir, model, project_id } = req.body ?? {};
    if (!goal || !workdir) return res.status(400).json({ error: 'goal and workdir required' });
    try {
      const result = createOrchestration({ goal, workdir, model, projectId: project_id });
      res.status(201).json({ ...result, goal, status: 'running' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/orchestrations/:id/scratchpad', (req, res) => {
    const orch = getOrchestration(Number(req.params.id));
    if (!orch) return res.status(404).json({ error: 'orchestration not found' });
    res.type('text/plain').send(readScratchpad(Number(req.params.id)));
  });

  app.post('/orchestrations/:id/scratchpad', (req, res) => {
    const orch = getOrchestration(Number(req.params.id));
    if (!orch) return res.status(404).json({ error: 'orchestration not found' });
    const { text } = req.body ?? {};
    if (typeof text !== 'string') return res.status(400).json({ error: 'text required' });
    appendScratchpad(Number(req.params.id), text);
    res.json({ ok: true });
  });

  // --- Heartbeat routes ---

  app.get('/heartbeat/log', (req, res) => {
    const n = parseInt(req.query.limit || '20', 10);
    const limit = Math.min(Number.isFinite(n) ? n : 20, 100);
    res.json(getHeartbeatLog(limit));
  });

  app.get('/heartbeat/status', (_req, res) => {
    const [lastRun = null] = getHeartbeatLog(1);
    res.json({
      lastRun,
      enabled:         getSetting('heartbeat_enabled') !== 'false',
      intervalMinutes: parseInt(getSetting('heartbeat_interval_minutes') || '5', 10),
      model:           getSetting('heartbeat_model') || 'router-default',
      provider:        getSetting('heartbeat_provider') || 'router-default',
    });
  });

  app.patch('/heartbeat/settings', (req, res) => {
    const { enabled, intervalMinutes, model, provider } = req.body ?? {};
    if (enabled         !== undefined) setSetting('heartbeat_enabled',          String(enabled));
    if (intervalMinutes !== undefined) setSetting('heartbeat_interval_minutes', String(parseInt(intervalMinutes, 10) || 5));
    if (model           !== undefined) setSetting('heartbeat_model',            model    || 'router-default');
    if (provider        !== undefined) setSetting('heartbeat_provider',         provider || 'router-default');
    res.json({ ok: true });
  });

  app.post('/heartbeat/trigger', async (_req, res) => {
    try {
      const result = await runHeartbeatCycle();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Chat ---

  app.post('/api/chat', async (req, res) => {
    const { messages } = req.body ?? {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages array required' });
    }
    try {
      const result = await flintChat(messages);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Memory sync (Supabase) ---

  app.get('/api/memory', async (_req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const memories = await pullMemories();
      res.json({ memories });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/memory/sync', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Supabase not configured' });
    const { memories } = req.body ?? {};
    if (!Array.isArray(memories)) return res.status(400).json({ error: 'memories array required' });
    try {
      let synced = 0;
      for (const m of memories) {
        await upsertMemory(m);
        synced++;
      }
      res.json({ synced });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/memory/search', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Supabase not configured' });
    const { query, type, count, threshold } = req.body ?? {};
    if (!query) return res.status(400).json({ error: 'query required' });
    try {
      const results = await searchMemories(query, { type, count, threshold });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/memory/session', async (_req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const id = await logSessionStart();
      res.json({ id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/memory/session/:id', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Supabase not configured' });
    const { id } = req.params;
    const { summary, learnings, agentNames } = req.body ?? {};
    try {
      await logSessionEnd(id, { summary, learnings, agentNames });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- API Key routes ---

  app.get('/api-keys', (_req, res) => res.json(listApiKeys()));

  app.get('/api-keys/:name/value', (req, res) => {
    const value = getApiKeyValue(req.params.name);
    if (value === null) return res.status(404).json({ error: `No key configured for ${req.params.name}` });
    res.json({ value });
  });

  app.post('/api-keys', (req, res) => {
    const { name, label, key_value, env_var } = req.body ?? {};
    if (!name || !label) return res.status(400).json({ error: 'name and label required' });
    try {
      createApiKey({ name, label, key_value, env_var });
      const created = listApiKeys().find(r => r.name === name);
      res.status(201).json(created);
    } catch (err) {
      if (err.message === 'name already exists') return res.status(409).json({ error: err.message });
      if (err.message.includes('alphanumeric')) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.patch('/api-keys/:name', (req, res) => {
    const changes = updateApiKey(req.params.name, req.body ?? {});
    if (!changes) return res.status(404).json({ error: 'provider not found' });
    const updated = listApiKeys().find(r => r.name === req.params.name);
    res.json(updated);
  });

  app.delete('/api-keys/:name', (req, res) => {
    try {
      const changes = deleteApiKey(req.params.name);
      if (!changes) return res.status(404).json({ error: 'provider not found' });
      res.status(204).send();
    } catch (err) {
      if (err.message.includes('seeded')) return res.status(403).json({ error: err.message });
      throw err;
    }
  });

  // --- WebSocket ---
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    addGlobalWsClient(ws);
    ws.on('error', () => {}); // prevent unhandled error events on connection failures

    function safeSend(ws, obj) {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    }

    const subscriptions = new Set();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'agents':
          safeSend(ws, { type: 'agents', list: listAgents() });
          break;

        case 'subscribe': {
          const name = msg.agent;
          subscriptions.add(name);
          addWsClient(name, ws);
          safeSend(ws, { type: 'tasks', agent: name, content: readTasks(name) });
          const agent = getAgent(name);
          if (agent) safeSend(ws, { type: 'status', agent: name, status: agent.status });
          break;
        }

        case 'input':
          writeToAgent(msg.agent, msg.data);
          break;

        case 'spawn': {
          const { agent: name, workdir, model, isolate, runtime, specialistName, role } = msg;
          if (!name || !workdir) break;
          registerAgent(name, 'spawn', workdir, null, model, runtime ?? 'claude', role ?? null);
          upsertAgentLog(name, { mode: 'spawn', workdir, status: 'running' });
          if (!TEST_MODE) {
            let spawnDir = workdir;
            if (isolate) {
              try {
                const { worktreePath, branch } = createWorktree(name);
                setAgentWorktree(name, worktreePath, branch);
                spawnDir = worktreePath;
              } catch (err) {
                logError('worktree creation failed', { agent: name, err: err.message });
                broadcastToAgent(name, { type: 'worktree_pr_failed', agent: name });
                break;
              }
            }
            const specialist = specialistName ? loadSpecialist(specialistName) : null;
            spawnAgent(name, spawnDir, model, { onWorktreePending: createPRForAgent, specialist });
          }
          broadcastToAgent(name, { type: 'status', agent: name, status: 'running' });
          break;
        }

        case 'kill':
          killAgent(msg.agent);
          break;

        case 'tasks_get': {
          const content = readTasks(msg.agent);
          safeSend(ws, { type: 'tasks', agent: msg.agent, content });
          break;
        }

        case 'tasks_set': {
          writeTasks(msg.agent, msg.content);
          broadcastToAgent(msg.agent, { type: 'tasks', agent: msg.agent, content: msg.content });
          break;
        }
      }
    });

    ws.on('close', () => {
      removeGlobalWsClient(ws);
      for (const name of subscriptions) removeWsClient(name, ws);
    });
  });

  if (!TEST_MODE) {
    const prPollInterval = setInterval(async () => {
      const agents = listOpenPRAgents();
      for (const { name, pr_number } of agents) {
        try {
          const current = getAgentPR(name);
          const status = current?.pr_url?.includes('github.com')
            ? await getGitHubPRStatus(pr_number, current.pr_url)
            : await getPRStatus(pr_number);
          if (current && current.pr_status !== status) {
            setAgentPR(name, pr_number, current.pr_url, status);
            broadcastToAgent(name, { type: 'pr_status', agent: name, status });
            if (status === 'merged') await handlePRMerged(name);
            else if (status === 'closed') clearAgentPR(name);
          }
        } catch (err) {
          logError('PR poll failed', { agent: name, err: err.message });
        }
      }
    }, 30_000);
    httpServer.on('close', () => clearInterval(prPollInterval));
  }

  return httpServer;
}

// Only start server when run directly or via PM2 (not imported by tests)
// PM2 sets process.argv[1] to its own ProcessContainerFork.js wrapper, so we also check PM2_HOME
const _isMain = (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) ||
  process.env.PM2_HOME !== undefined;
if (_isMain) {
  const server = createApp();
  let _sessionId = null;
  server.listen(PORT, async () => {
    console.log(`Flint Dashboard → http://localhost:${PORT}`);
    startHeartbeat();
    if (isSupabaseEnabled()) {
      try {
        _sessionId = await logSessionStart();
        console.log(`[supabase] session started: ${_sessionId}`);
      } catch (err) {
        console.warn('[supabase] logSessionStart failed:', err.message);
      }
    }
  });

  const _shutdown = async (signal) => {
    console.log(`[server] ${signal} — shutting down`);
    if (_sessionId && isSupabaseEnabled()) {
      try { await logSessionEnd(_sessionId, { summary: `Server shutdown (${signal})`, agentNames: listAgents().map(a => a.name) }); }
      catch {}
    }
    closeDb();
    process.exit(0);
  };
  process.once('SIGTERM', () => _shutdown('SIGTERM'));
  process.once('SIGINT',  () => _shutdown('SIGINT'));
}

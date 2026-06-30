import OpenAI from '../router/node_modules/openai/index.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listAgents } from './agents.js';
import { listQueueTasks, createQueueTask } from './queue.js';
import { listSpecialists } from './specialists.js';
import { getSetting } from './settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');

// ─── provider selection ────────────────────────────────────────────────────

function resolveClient() {
  const configuredProvider = getSetting('heartbeat_provider') || '';
  const configuredModel    = getSetting('heartbeat_model')    || '';

  const candidates = [
    configuredProvider === 'openrouter' || configuredProvider === 'router-default' || !configuredProvider
      ? { name: 'openrouter', envKey: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1',
          headers: { 'HTTP-Referer': 'https://flint.local', 'X-Title': 'Flint' },
          defaultModel: 'openai/gpt-4o-mini' }
      : null,
    configuredProvider === 'mammouth'
      ? { name: 'mammouth', envKey: 'MAMMOUTH_API_KEY', baseURL: 'https://api.mammouth.ai/v1',
          headers: {}, defaultModel: 'gpt-5.4-mini' }
      : null,
    // Fallbacks regardless of configured provider
    { name: 'openrouter', envKey: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1',
      headers: { 'HTTP-Referer': 'https://flint.local', 'X-Title': 'Flint' },
      defaultModel: 'openai/gpt-4o-mini' },
    { name: 'mammouth', envKey: 'MAMMOUTH_API_KEY', baseURL: 'https://api.mammouth.ai/v1',
      headers: {}, defaultModel: 'gpt-5.4-mini' },
  ].filter(Boolean);

  for (const p of candidates) {
    const key = process.env[p.envKey];
    if (!key) continue;
    const model = (configuredModel && configuredModel !== 'router-default') ? configuredModel : p.defaultModel;
    const client = new OpenAI({ apiKey: key, baseURL: p.baseURL, defaultHeaders: p.headers });
    return { client, model, provider: p.name };
  }
  return null;
}

// ─── system prompt ─────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const soulPath = join(FLINT_ROOT, 'context', 'soul.md');
  const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '';

  const agents = listAgents().map(a => `  • ${a.name} (${a.status}, ${a.runtime || 'claude'})`).join('\n') || '  (none)';
  const tasks  = listQueueTasks().filter(t => t.status === 'pending' || t.status === 'in_progress');
  const queue  = tasks.length
    ? tasks.slice(0, 10).map(t => `  • [${t.status}] ${t.title}`).join('\n')
    : '  (empty)';

  return [
    'You are Flint, Robin\'s personal AI agent and business operator.',
    soul ? `\n${soul}` : '',
    '\nYou have tools to inspect and manage the Flint agent system.',
    'Be concise. When you take an action, confirm it briefly.',
    '\n## Current System State',
    `Agents:\n${agents}`,
    `Queue:\n${queue}`,
  ].join('\n');
}

// ─── tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'List all current agents with their status and runtime.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_queue',
      description: 'Get the current task queue (pending and in-progress tasks).',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'], description: 'Filter by status (default: all active)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task in the queue.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string',  description: 'Short task title' },
          description: { type: 'string',  description: 'Detailed task description' },
          role:        { type: 'string',  description: 'Specialist role to handle the task (e.g. research-expert, code-reviewer)' },
          priority:    { type: 'integer', description: 'Priority 1-10 (default 5)' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_specialists',
      description: 'List all available specialist profiles.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ─── tool execution ────────────────────────────────────────────────────────

function execTool(name, args) {
  switch (name) {
    case 'list_agents':
      return JSON.stringify(listAgents().map(a => ({
        name: a.name, status: a.status, runtime: a.runtime || 'claude', model: a.model || null,
      })));

    case 'get_queue': {
      let tasks = listQueueTasks();
      if (args.status) tasks = tasks.filter(t => t.status === args.status);
      else tasks = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
      return JSON.stringify(tasks.slice(0, 20).map(t => ({
        id: t.id, title: t.title, status: t.status, role: t.role, agent: t.agent_name,
      })));
    }

    case 'create_task': {
      const task = createQueueTask({
        title:       args.title,
        description: args.description || '',
        role:        args.role || null,
        priority:    args.priority ?? 5,
      });
      return JSON.stringify({ ok: true, id: task.id, title: task.title });
    }

    case 'list_specialists':
      return JSON.stringify(listSpecialists().map(s => ({
        name: s.name, label: s.label, description: s.description, domains: s.domains,
      })));

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── main chat function ────────────────────────────────────────────────────

export async function flintChat(messages) {
  const resolved = resolveClient();
  if (!resolved) throw new Error('No LLM provider available. Configure OPENROUTER_API_KEY or MAMMOUTH_API_KEY.');

  const { client, model } = resolved;

  const allMessages = [
    { role: 'system', content: buildSystemPrompt() },
    ...messages,
  ];

  const actions_taken = [];
  const MAX_TOOL_TURNS = 4;

  for (let i = 0; i <= MAX_TOOL_TURNS; i++) {
    const res = await client.chat.completions.create({
      model,
      messages: allMessages,
      tools: TOOLS,
      tool_choice: 'auto',
    });

    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('Empty response from LLM');
    allMessages.push(msg);

    if (!msg.tool_calls?.length) {
      return { reply: msg.content || '(no reply)', actions_taken };
    }

    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}
      const result = execTool(tc.function.name, args);
      actions_taken.push({ tool: tc.function.name, args });
      allMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  const last = allMessages[allMessages.length - 1];
  return { reply: typeof last?.content === 'string' ? last.content : '(no reply)', actions_taken };
}

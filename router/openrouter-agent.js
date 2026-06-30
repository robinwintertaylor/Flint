#!/usr/bin/env node
/**
 * OpenRouter agentic worker — runs a tool-calling loop using any OpenRouter model.
 * Spawned as a PTY process: node router/openrouter-agent.js <model> <agent-name>
 *
 * Tools available to the model:
 *   bash        — execute shell commands
 *   read_file   — read a file's contents
 *   write_file  — write/overwrite a file
 *   str_replace — targeted string replacement in a file
 *   task_done   — mark a task complete in the agent's task file
 */

import OpenAI from 'openai';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, isAbsolute } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLINT_ROOT = join(__dirname, '..');

const model     = process.argv[2] || 'openai/gpt-4o-mini';
const agentName = process.argv[3] || 'agent';
const taskFile  = join(FLINT_ROOT, 'tasks', `${agentName}.md`);
const workdir   = process.cwd();

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  out('\x1b[31mERROR: OPENROUTER_API_KEY is not set. Add it in the Flint API Keys tab.\x1b[0m');
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' });

// ─── helpers ───────────────────────────────────────────────────────────────

function out(text) {
  process.stdout.write(text.replace(/\n/g, '\r\n'));
  if (!text.endsWith('\n') && !text.endsWith('\r\n')) process.stdout.write('\r\n');
}

function resolvePath(p) {
  if (isAbsolute(p)) return p;
  return resolve(workdir, p);
}

function readTaskFile() {
  if (!existsSync(taskFile)) return '(no task file found)';
  return readFileSync(taskFile, 'utf8');
}

function pendingCount() {
  const content = readTaskFile();
  return (content.match(/^- \[ \]/gm) || []).length;
}

// ─── tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command in the working directory. Returns combined stdout + stderr. Use for installing packages, running scripts, checking output, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeout_seconds: { type: 'number', description: 'Max execution time in seconds (default 60)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full contents of a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workdir-relative path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write (or overwrite) a file with new content. Creates parent directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Absolute or workdir-relative path' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'str_replace',
      description: 'Replace an exact string in a file. Fails if the string is not found.',
      parameters: {
        type: 'object',
        properties: {
          path:       { type: 'string', description: 'Absolute or workdir-relative path' },
          old_string: { type: 'string', description: 'Exact string to find' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_done',
      description: 'Mark a completed task as done in the task file (changes "- [ ]" to "- [x]"). Call this once you have verified the task is actually complete.',
      parameters: {
        type: 'object',
        properties: {
          task_title: { type: 'string', description: 'Exact title of the task as it appears in the task file' },
        },
        required: ['task_title'],
      },
    },
  },
];

// ─── tool execution ────────────────────────────────────────────────────────

function execTool(name, args) {
  switch (name) {

    case 'bash': {
      const timeoutMs = ((args.timeout_seconds ?? 60)) * 1000;
      out(`\x1b[90m$ ${args.command}\x1b[0m`);
      const r = spawnSync(args.command, [], {
        shell: true,
        cwd: workdir,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: process.env,
        maxBuffer: 4 * 1024 * 1024,
      });
      let combined = '';
      if (r.stdout) combined += r.stdout;
      if (r.stderr) combined += (combined ? '\nSTDERR:\n' : '') + r.stderr;
      if (r.error)  combined += (combined ? '\n' : '') + `Error: ${r.error.message}`;
      if (!combined) combined = '(no output)';
      const preview = combined.slice(0, 3000) + (combined.length > 3000 ? '\n…(truncated)' : '');
      out(`\x1b[90m${preview}\x1b[0m`);
      return combined.slice(0, 6000);
    }

    case 'read_file': {
      const p = resolvePath(args.path);
      try {
        const content = readFileSync(p, 'utf8');
        out(`\x1b[90mread ${p} (${content.length} chars)\x1b[0m`);
        return content;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }

    case 'write_file': {
      const p = resolvePath(args.path);
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, args.content, 'utf8');
        out(`\x1b[90mwrote ${p} (${args.content.length} chars)\x1b[0m`);
        return `Written: ${p}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }

    case 'str_replace': {
      const p = resolvePath(args.path);
      try {
        const original = readFileSync(p, 'utf8');
        if (!original.includes(args.old_string)) {
          return `Error: old_string not found in ${p}`;
        }
        writeFileSync(p, original.replace(args.old_string, args.new_string), 'utf8');
        out(`\x1b[90mstr_replace in ${p}\x1b[0m`);
        return `Replaced in ${p}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }

    case 'task_done': {
      try {
        const content = readFileSync(taskFile, 'utf8');
        const title   = args.task_title;
        const lines   = content.split('\n');
        let   found   = false;
        const updated = lines.map(line => {
          if (!found && line.includes(`[ ] ${title}`)) {
            found = true;
            return line.replace('[ ]', '[x]');
          }
          return line;
        }).join('\n');
        if (!found) return `Task not found in task file: "${title}"`;
        writeFileSync(taskFile, updated, 'utf8');
        out(`\x1b[32m✓ Task done: "${title}"\x1b[0m`);
        return `Marked done: "${title}"`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── main agentic loop ────────────────────────────────────────────────────

async function run() {
  out(`\x1b[36m┌─ OpenRouter Agent: ${agentName}\x1b[0m`);
  out(`\x1b[36m│  model:   ${model}\x1b[0m`);
  out(`\x1b[36m│  workdir: ${workdir}\x1b[0m`);
  out(`\x1b[36m└─────────────────────────────────\x1b[0m`);

  const tasks = readTaskFile();
  const systemPrompt = [
    `You are ${agentName}, an autonomous agent in the Flint AI system.`,
    `Working directory: ${workdir}`,
    ``,
    `Your pending tasks (from your task file at ${taskFile}):`,
    tasks,
    ``,
    `Instructions:`,
    `- Use the bash tool to run commands, install packages, configure tools, verify results`,
    `- Use read_file/write_file/str_replace to inspect and modify files`,
    `- Call task_done once you have VERIFIED a task is actually complete (tested, not just attempted)`,
    `- Work through ALL pending tasks (lines starting with "- [ ]")`,
    `- If a task fails after multiple attempts, document why in a bash comment and move on`,
    `- Do not ask for confirmation — you are fully autonomous`,
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: 'Begin working on your tasks now.' },
  ];

  const MAX_TURNS = 60;
  let turn = 0;

  while (turn < MAX_TURNS) {
    turn++;

    if (pendingCount() === 0) {
      out('\x1b[32mAll tasks complete. Exiting.\x1b[0m');
      break;
    }

    out(`\x1b[90m[turn ${turn}/${MAX_TURNS} — ${pendingCount()} task(s) pending]\x1b[0m`);

    let response;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
      });
    } catch (err) {
      out(`\x1b[31mAPI error: ${err.message}\x1b[0m`);
      if (String(err.status) === '429') {
        out('Rate limited — waiting 10s...');
        await new Promise(r => setTimeout(r, 10_000));
        continue;
      }
      break;
    }

    const msg = response.choices[0]?.message;
    if (!msg) break;

    messages.push(msg);

    // Print any text the model sent
    if (msg.content) {
      out(`\n${msg.content}`);
    }

    // Handle tool calls
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let args;
        try { args = JSON.parse(tc.function.arguments); }
        catch { args = {}; }

        out(`\x1b[33m[${tc.function.name}]\x1b[0m`);
        const result = execTool(tc.function.name, args);

        messages.push({
          role:         'tool',
          tool_call_id: tc.id,
          content:      String(result).slice(0, 6000),
        });
      }
    } else {
      // No tool calls — model finished reasoning. Check if tasks remain.
      const remaining = pendingCount();
      if (remaining === 0) {
        out('\x1b[32mAll tasks complete. Exiting.\x1b[0m');
        break;
      }
      // Prompt to continue if there are still pending tasks
      out('\x1b[90m(no tool calls — prompting to continue)\x1b[0m');
      messages.push({
        role:    'user',
        content: `You still have ${remaining} pending task(s). Continue using tools to complete them.`,
      });
    }
  }

  if (turn >= MAX_TURNS) {
    out('\x1b[31mMax turns reached — exiting.\x1b[0m');
  }

  out('\x1b[36mAgent session ended.\x1b[0m');
  process.exit(0);
}

run().catch(err => {
  out(`\x1b[31mFatal: ${err.message}\x1b[0m`);
  process.exit(1);
});

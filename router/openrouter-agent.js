#!/usr/bin/env node
/**
 * OpenRouter interactive agent — streams responses from any OpenRouter model.
 * Spawned as a PTY process: node router/openrouter-agent.js <model>
 */

import OpenAI from 'openai';
import * as readline from 'node:readline';

const model = process.argv[2] || 'mistralai/mistral-nemo';
const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  console.error('[openrouter-agent] ERROR: OPENROUTER_API_KEY is not set.');
  console.error('Add your OpenRouter key via the API Keys tab in the Flint dashboard.');
  process.exit(1);
}

const client = new OpenAI({
  apiKey,
  baseURL: 'https://openrouter.ai/api/v1',
});

const messages = [];

function prompt() {
  process.stdout.write('\n> ');
}

console.log(`\r\n\x1b[36mOpenRouter Agent\x1b[0m — model: \x1b[33m${model}\x1b[0m`);
console.log('Type your message and press Enter. Ctrl+C to exit.\r\n');
prompt();

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) { prompt(); return; }
  if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
    console.log('\r\nGoodbye.');
    process.exit(0);
  }

  messages.push({ role: 'user', content: input });

  try {
    process.stdout.write('\r\n');
    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
    });

    let reply = '';
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? '';
      if (text) {
        process.stdout.write(text.replace(/\n/g, '\r\n'));
        reply += text;
      }
    }
    messages.push({ role: 'assistant', content: reply });
  } catch (err) {
    process.stdout.write(`\r\n\x1b[31mError: ${err.message}\x1b[0m`);
  }

  prompt();
});

rl.on('close', () => process.exit(0));

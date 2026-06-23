import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { AzureOpenAI } from 'openai';
import { GoogleGenAI } from '@google/genai';

const TEST_MODE = process.env.FLINT_TEST_MODE === '1';

// Per-model cost rates: [inputPer1M, outputPer1M] in USD
const TOKEN_RATES = {
  'claude-haiku-4-5':   [0.80,  4.00],
  'claude-sonnet-4-6':  [3.00,  15.00],
  'claude-opus-4-6':    [15.00, 75.00],
  'gpt-4o-mini':        [0.15,  0.60],
  'gpt-4o':             [2.50,  10.00],
  'gpt-4.5':            [75.00, 150.00],
  'gemini-2.0-flash':   [0.075, 0.30],
  'gemini-2.0-pro':     [1.25,  5.00],
  'gemini-2.5-pro':     [1.25,  10.00],
};
const DEFAULT_RATE = [0.20, 0.60];

function calcCost(model, inputTokens, outputTokens) {
  const [inRate, outRate] = TOKEN_RATES[model] ?? DEFAULT_RATE;
  return (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
}

// Convert unified messages format to Anthropic format
function toAnthropicMessages(messages) {
  const system = messages.find(m => m.role === 'system')?.content;
  const msgs   = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  return { system, msgs };
}

async function completeAnthropic(model, messages) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { system, msgs } = toAnthropicMessages(messages);
  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    ...(system ? { system } : {}),
    messages: msgs,
  });
  const text = res.content.map(b => b.type === 'text' ? b.text : '').join('');
  const costUsd = calcCost(model, res.usage.input_tokens, res.usage.output_tokens);
  return { text, costUsd };
}

async function completeOpenAI(model, messages) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({ model, messages });
  const text = res.choices[0].message.content ?? '';
  const costUsd = calcCost(model, res.usage.prompt_tokens, res.usage.completion_tokens);
  return { text, costUsd };
}

async function completeGoogle(model, messages) {
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  const system = messages.find(m => m.role === 'system')?.content;
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const res = await client.models.generateContent({
    model,
    contents,
    ...(system ? { systemInstruction: system } : {}),
  });
  const text = res.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
  const usage = res.usageMetadata ?? {};
  const costUsd = calcCost(model, usage.promptTokenCount ?? 0, usage.candidatesTokenCount ?? 0);
  return { text, costUsd };
}

async function completeAzure(model, messages) {
  const client = new AzureOpenAI({
    endpoint:   process.env.AZURE_OPENAI_ENDPOINT,
    apiKey:     process.env.AZURE_OPENAI_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? model,
    apiVersion: '2024-10-21',
  });
  const res = await client.chat.completions.create({ model, messages });
  const text = res.choices[0].message.content ?? '';
  const costUsd = calcCost(model, res.usage.prompt_tokens, res.usage.completion_tokens);
  return { text, costUsd };
}

async function completeOpenRouter(model, messages) {
  const client = new OpenAI({
    apiKey:  process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  });
  const res = await client.chat.completions.create({ model, messages });
  const text = res.choices[0].message.content ?? '';
  const costUsd = calcCost(model, res.usage.prompt_tokens, res.usage.completion_tokens);
  return { text, costUsd };
}

const ADAPTERS = {
  anthropic:  completeAnthropic,
  openai:     completeOpenAI,
  google:     completeGoogle,
  azure:      completeAzure,
  openrouter: completeOpenRouter,
};

export async function complete(provider, model, messages) {
  if (TEST_MODE) {
    return { text: 'stub response', costUsd: 0.001 };
  }
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  return adapter(model, messages);
}

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSpecialist as dbCreate, incrementUsage } from '../../dashboard/specialists.js';
import { notify } from '../../dashboard/telegram.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const AGENTS_ROOT = process.env.FLINT_AGENTS_ROOT
  ?? dirname(__dirname);                          // agents/specialists/ → agents/
const SPECIALISTS_DIR = join(AGENTS_ROOT, 'specialists');
const INDEX_PATH      = join(AGENTS_ROOT, 'specialists.json');

// ── index helpers ────────────────────────────────────────────────

function readIndex() {
  if (!existsSync(INDEX_PATH)) return [];
  try { return JSON.parse(readFileSync(INDEX_PATH, 'utf8')); } catch { return []; }
}

function writeIndex(entries) {
  writeFileSync(INDEX_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

// ── default LLM caller ──────────────────────────────────────────

const TEST_STUB_SPECIALIST = JSON.stringify({ match: null, suggest: { name: 'general-assistant', description: 'General purpose assistant', domains: [] } });

async function defaultRouteFn(taskType, prompt) {
  if (process.env.FLINT_TEST_MODE === '1') return TEST_STUB_SPECIALIST;
  const res = await fetch('http://localhost:3001/llm/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskType, prompt }),
  });
  if (!res.ok) throw new Error(`Router error: ${res.status}`);
  return (await res.json()).text;
}

// ── public API ──────────────────────────────────────────────────

export async function selectSpecialist(taskDescription, _routeFn = defaultRouteFn) {
  const index = readIndex();

  if (index.length === 0) {
    return createSpecialist({ name: slugify(taskDescription.slice(0, 40)), description: taskDescription, domains: [] }, _routeFn);
  }

  const prompt = `You are a specialist selector. Given a task, pick the best specialist from the registry, or recommend creating a new one if nothing fits well.

Registry:
${JSON.stringify(index, null, 2)}

Task: "${taskDescription}"

Respond with JSON only — one of:
{ "match": "specialist-name" }
{ "match": null, "suggest": { "name": "kebab-case-name", "description": "one paragraph", "domains": ["tag1", "tag2"] } }`;

  let text;
  try {
    text = await _routeFn('classification', prompt);
  } catch (err) {
    console.warn('[specialists] selector LLM call failed:', err.message);
    text = JSON.stringify({ match: null, suggest: { name: slugify(taskDescription.slice(0, 40)), description: taskDescription, domains: [] } });
  }

  let parsed;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch?.[0] ?? text);
  } catch {
    console.warn('[specialists] selector returned invalid JSON — creating new specialist');
    parsed = { match: null, suggest: { name: slugify(taskDescription.slice(0, 40)), description: taskDescription, domains: [] } };
  }

  if (parsed.match) {
    const found = index.find(s => s.name === parsed.match);
    if (found) return loadSpecialist(found.name);
  }

  const suggest = parsed.suggest ?? { name: slugify(taskDescription.slice(0, 40)), description: taskDescription, domains: [] };
  return createSpecialist(suggest, _routeFn);
}

export async function createSpecialist(
  { name, description, domains = [], preferred_tier = 2, preferred_provider = null },
  _routeFn = defaultRouteFn,
) {
  const safeName = slugify(name || 'specialist');
  const label    = toLabel(safeName);

  const soulPrompt = `Write a specialist agent identity document in first person markdown.

Specialist: ${label}
Description: ${description}

Format exactly as:
# ${label}

[2-3 sentences: who this specialist is and their core expertise, written in first person]

## My approach:
- [4-6 bullet points: how they work, what principles guide them, what makes them distinctive]

Keep it concise and practical.`;

  let soul;
  try {
    soul = await _routeFn('content-writing', soulPrompt);
  } catch {
    soul = `# ${label}\n\nI am a specialist in ${description}.\n\n## My approach:\n- Focus on quality above all else\n- Be thorough and precise\n- Communicate findings clearly\n`;
  }

  const specialistDir = join(SPECIALISTS_DIR, safeName);
  mkdirSync(specialistDir, { recursive: true });

  const config = {
    name: safeName, label, description,
    domains, skills: [],
    preferred_tier, preferred_provider,
    created_by: 'flint',
    created_at: new Date().toISOString(),
    use_count: 0, last_used: null,
  };

  writeFileSync(join(specialistDir, 'soul.md'),     soul,                          'utf8');
  writeFileSync(join(specialistDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  // Update index
  const index   = readIndex();
  const existing = index.findIndex(s => s.name === safeName);
  const entry    = { name: safeName, label, description, domains, use_count: 0, last_used: null };
  if (existing >= 0) index[existing] = entry; else index.push(entry);
  writeIndex(index);

  // Persist to DB (may already exist on retry — ignore duplicate)
  try {
    dbCreate({ name: safeName, label, description, domains, preferred_tier, preferred_provider, created_by: 'flint' });
  } catch { /* duplicate on retry — safe to ignore */ }

  try { notify(`⚡ Created new specialist: ${label}`); } catch {}

  return { ...config, soul };
}

export function loadSpecialist(name) {
  const configPath = join(SPECIALISTS_DIR, name, 'config.json');
  const soulPath   = join(SPECIALISTS_DIR, name, 'soul.md');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const soul   = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '';
    return { ...config, soul };
  } catch { return null; }
}

export function touchUsage(name) {
  const now = new Date().toISOString();

  // Update index
  const index = readIndex();
  const entry  = index.find(s => s.name === name);
  if (entry) {
    entry.use_count = (entry.use_count ?? 0) + 1;
    entry.last_used  = now;
    writeIndex(index);
  }

  // Update DB
  try { incrementUsage(name); } catch {}

  // Update config.json
  const configPath = join(SPECIALISTS_DIR, name, 'config.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      cfg.use_count = (cfg.use_count ?? 0) + 1;
      cfg.last_used  = now;
      writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch {}
  }
}

// ── helpers ──────────────────────────────────────────────────────

function slugify(str) {
  return (str ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'specialist';
}

function toLabel(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

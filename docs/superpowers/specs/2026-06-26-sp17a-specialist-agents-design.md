# SP17a: Specialist Agents Design

## Overview

Flint can spin up named specialist agents — each with their own identity (soul), skills, and model preference — and remember them for reuse. When a task arrives, a fast LLM selector picks the best matching specialist (or creates a new one on the fly). The specialist's soul is injected as context at spawn time; their preferred model is fed into the existing router for selection.

This delivers agent-first routing: WHO does the work is decided before WHICH model they use.

---

## Architecture

The specialist system sits as a layer above the existing agent and router infrastructure:

```
Task arrives
  → Selector (tier-1 LLM) reads task + specialist index
    → match found: load soul.md + config, spawn with injection
    → no match: generate new specialist (tier-2), register, then spawn
      → agent runs with specialist identity + specialist-preferred model
        → usage stats updated on agent exit
```

The existing router is unchanged. Each specialist declares `preferred_tier` and `preferred_provider`; these are passed as hints into the existing `resolveRoute()` fallback chain.

---

## Data Model

### File structure

```
agents/
  specialists/
    research-expert/
      soul.md
      config.json
    brand-strategist/
      soul.md
      config.json
  specialists.json    ← lightweight index (selector reads this)
```

### `soul.md` — identity written in first person

```markdown
# Research Expert

I am a thorough, methodical researcher. I cross-reference multiple sources
before drawing conclusions and flag confidence levels explicitly.

My approach:
- Start broad, then narrow to specifics
- Always note source quality and contradictions
- Quantify claims where possible
- Produce structured reports: summary → findings → gaps → sources
```

### `config.json` — metadata and routing preferences

```json
{
  "name": "research-expert",
  "label": "Research Expert",
  "description": "Thorough market and topic researcher. Cross-references sources, synthesises findings, produces structured reports.",
  "domains": ["research", "market-analysis", "competitive-intelligence"],
  "skills": ["web-search", "report-writing"],
  "preferred_tier": 2,
  "preferred_provider": "anthropic",
  "created_by": "flint",
  "created_at": "2026-06-26T10:00:00Z",
  "use_count": 0,
  "last_used": null
}
```

### `agents/specialists.json` — selector index

Array of lightweight records — enough for the LLM selector to choose without loading soul files:

```json
[
  {
    "name": "research-expert",
    "label": "Research Expert",
    "description": "Thorough market and topic researcher...",
    "domains": ["research", "market-analysis", "competitive-intelligence"],
    "use_count": 12,
    "last_used": "2026-06-25T14:32:00Z"
  }
]
```

### DB table: `specialists`

Mirrors the index but queryable for dashboard stats:

```sql
CREATE TABLE specialists (
  name          TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  description   TEXT,
  domains       TEXT,        -- JSON array stored as string
  skills        TEXT,        -- JSON array stored as string
  preferred_tier    INTEGER DEFAULT 2,
  preferred_provider TEXT,
  created_by    TEXT NOT NULL DEFAULT 'robin',  -- 'robin' | 'flint'
  created_at    TEXT NOT NULL,
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used     TEXT
);
```

---

## Selection Flow

New module: `agents/specialists/selector.js`

### `selectSpecialist(taskDescription) → { specialist } | { suggest }`

1. Read `agents/specialists.json`
2. If registry is empty → skip LLM call, go straight to `createSpecialist` seeded from task description
3. Otherwise, call tier-1 model with:

```
You are a specialist selector. Given a task, pick the best specialist from
the registry, or recommend creating a new one if nothing fits well.

Registry:
<specialists index as JSON>

Task: "<task description>"

Respond with JSON only — one of:
{ "match": "research-expert" }
{ "match": null, "suggest": { "name": "brand-strategist", "description": "...", "domains": ["branding", "positioning"] } }
```

4. Parse response:
   - `match` found → return specialist name
   - `match: null` → call `createSpecialist(suggest)`

### `createSpecialist(suggest) → specialist`

1. Call tier-2 model to write a quality `soul.md` from the suggested name + description
2. Write `agents/specialists/<name>/soul.md` and `config.json`
3. Append entry to `agents/specialists.json`
4. Insert row into DB `specialists` table
5. Send Telegram notification: `⚡ Created new specialist: <Label>`
6. Return specialist config — ready to use immediately, no approval gate

Robin can edit or delete auto-created specialists from the dashboard at any time.

---

## Soul + Skills Injection

Changes to `dashboard/terminal.js` `spawnAgent()`:

### Soul injection

Prepended to the agent's task context, same pattern as the existing `AUTONOMOUS_BLOCK`:

```js
if (specialist) {
  const soul = readFileSync(
    `agents/specialists/${specialist.name}/soul.md`, 'utf8'
  );
  const SPECIALIST_BLOCK = `## Specialist Identity\n${soul}\n---\n\n`;
  const current = readTasks(name);
  if (!current.startsWith('## Specialist Identity')) {
    writeTasks(name, SPECIALIST_BLOCK + current);
  }
}
```

### Model routing

A new helper `resolveSpecialistRoute(tier, provider)` feeds the specialist's preferences into the existing tier/provider logic — same fallback chain as all other routing, no changes to `router.json` needed:

```js
const { model } = resolveSpecialistRoute(
  specialist.preferred_tier,
  specialist.preferred_provider
);
// passed as --model flag to the spawned agent
```

### Skills injection

`config.json` skills are checked against available MCPs via the existing `injectMcpConfig()` mechanism. Skills that map to a configured MCP are injected; unmatched skills are noted in the agent's task context as capabilities to use if available.

### Usage tracking

On agent exit, increment `use_count` and update `last_used` in both `specialists.json` and the DB row.

---

## Creation

### Flint-initiated

Triggered automatically by `selectSpecialist()` when no match is found. Flow described in Selection Flow → `createSpecialist()` above. Proceeds immediately — Robin is notified via Telegram but not blocked on approval.

### Robin-initiated

New specialist form in the dashboard Specialists panel:

| Field | Type | Notes |
|---|---|---|
| Name | text (slug) | e.g. `brand-strategist` — alphanumeric + hyphens |
| Label | text | Display name |
| Description | textarea | One paragraph — what they're good at |
| Domains | text | Comma-separated tags |
| Preferred tier | select | 1 / 2 / 3 |
| Preferred provider | select | Configured providers from API keys |
| Soul | textarea | Pre-filled with a generated draft; Robin edits before saving |

On submit: writes files, updates `specialists.json`, inserts DB row. Same outcome as Flint-initiated.

---

## Dashboard UI

New **Specialists** tab alongside Agents, Tasks, etc.

### Card grid

One card per specialist showing:
- Label + description
- Domain tags
- Use count + last used
- Created-by badge: `Robin` or `⚡ Flint`
- Edit button (opens soul + config inline editor)
- Delete button (confirmation required — removes files, index entry, DB row)

### Stats panel

- Most-used specialists (use_count ranking)
- Recently active (last_used)
- Flint-created vs Robin-created count

### "New Specialist" button

Opens the creation form described above.

---

## Integration Points

| Existing component | Change |
|---|---|
| `dashboard/terminal.js` | `spawnAgent()` accepts optional `specialist` param; injects soul + resolves model |
| `dashboard/db.js` | Add `specialists` table to schema; add `initSpecialists()` seed call |
| `router/config.js` | Add `resolveSpecialistRoute(tier, provider)` helper |
| `dashboard/server.js` | Add `/api/specialists` CRUD routes |
| `dashboard/public/app.js` | Add Specialists tab and card UI |
| `agents/specialists/selector.js` (new) | `selectSpecialist()`, `createSpecialist()` |

---

## Error Handling

- Selector LLM returns malformed JSON → log warning, fall back to creating a new specialist from task description
- `soul.md` missing at spawn time → log error, spawn without specialist identity (graceful degradation, not a crash)
- Skills MCP not available → note in task context, do not block spawn
- `createSpecialist` fails to write files → surface error to orchestrator, do not attempt spawn

---

## Out of Scope

- Specialist-to-specialist communication (future)
- Specialist performance scoring / outcome tracking (future — use_count is a proxy for now)
- Embedding-based similarity matching (future optimisation over the LLM selector)
- Specialist versioning / history

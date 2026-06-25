# SP13a: Ollama Integration — Design Spec

**Date:** 2026-06-25
**Status:** Approved

## Overview

Add Ollama as a general-purpose local LLM provider for Flint. Delivers two independent capabilities from one module: agents can use a local model as their AI runtime (`runtime: 'ollama'`), and Flint itself gains a `generate()` primitive for internal tasks (summarisation, routing, suggestion processing) without calling any external API.

---

## Architecture

**New file:** `dashboard/ollama.js` — Ollama REST client. Mirrors the `forgejo.js`/`github.js` provider pattern: `TEST_MODE` function guard, no auth, no npm dependencies, exports clean named functions.

**Modified:** `dashboard/terminal.js` — adds `runtime: 'ollama'` handling in `spawnAgent`. Spawns `ollama run <model>` via PTY; skips MCP injection, cost parsing, and autonomous block.

**Modified:** `dashboard/server.js` — two new routes (`GET /api/ollama/status`, `POST /api/ollama/generate`) and Ollama reachability added to `GET /api/health`.

**No DB changes. No new API key entry.** Ollama is local and requires no token.

---

## `dashboard/ollama.js` Module

### Config

Both values read at call time (not module load):

- `OLLAMA_URL`: `process.env.OLLAMA_URL ?? 'http://localhost:11434'`
- `TEST_MODE`: `() => process.env.FLINT_TEST_MODE === '1'`

### Exports

**`isOllamaReachable(): Promise<boolean>`**

`GET {OLLAMA_URL}/api/tags` with a 2-second `AbortController` timeout. Returns `false` on any error (network, timeout, non-ok status). In TEST_MODE returns `true`.

**`listModels(): Promise<string[]>`**

Same `GET /api/tags` call. Parses `data.models.map(m => m.name)`. Returns `[]` on error. In TEST_MODE returns `['llama3']`.

**`generate(model, prompt, opts = {}): Promise<string>`**

`POST {OLLAMA_URL}/api/generate` with body `{ model, prompt, stream: false, ...opts }`. Returns `data.response` (string). Throws on non-ok HTTP status with message `Ollama generate failed: <status>`. In TEST_MODE returns `'test response'`.

---

## `terminal.js` — Ollama Agent Runtime

`spawnAgent` currently uses a binary `isVibe ? ... : ...` pattern. With Ollama, this becomes a three-way branch:

```js
const isVibe   = agent.runtime === 'vibe';
const isOllama = agent.runtime === 'ollama';

let bin, args;
if (isOllama) {
  bin  = resolveBin('ollama');
  args = ['run', agent.model || 'llama3'];
} else if (isVibe) {
  bin  = VIBE_BIN;
  args = [];
} else {
  // Claude (default)
  bin  = CLAUDE_BIN;
  args = ['--dangerously-skip-permissions'];
  if (model) args.push('--model', model);
}
```

Skipped for Ollama:
- Autonomous block injection (`## Operating Mode: Autonomous`) — guard with `if (!isOllama)`
- MCP config injection — already guarded by `if (!isVibe)`, extend to `if (!isVibe && !isOllama)`
- Cost regex parsing and `writeUsage()` — guard the existing `costMatch` block with `if (!isOllama)`

`lastModel` seeded from `agent.model` at spawn time (no runtime model detection needed).

Output still broadcasts to WebSocket clients — the terminal pane works normally for Ollama sessions.

---

## `server.js` — New Routes

### `GET /api/ollama/status`

Calls `isOllamaReachable()` and `listModels()` in parallel. Returns:

```json
{ "reachable": true, "models": ["llama3", "codellama"] }
```

If not reachable: `{ "reachable": false, "models": [] }` (200, not an error).

### `POST /api/ollama/generate`

Body: `{ "model": "llama3", "prompt": "summarise this" }`

Validates both fields present — 400 if either is missing. Calls `generate(model, prompt)`. Returns:

```json
{ "response": "..." }
```

Errors from Ollama propagate as 500 with `{ "error": err.message }`.

### `GET /api/health` update

Add `ollama: await isOllamaReachable()` alongside the existing Forgejo check.

---

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `OLLAMA_URL` | `http://localhost:11434` | Base URL of the local Ollama server |

No token, no DB key. Model for internal use is passed explicitly to `generate()`; the caller decides.

---

## Out of Scope

- Streaming responses (Ollama supports `stream: true` — not wired up here)
- Dashboard UI for Ollama model selection
- Baking in specific Flint-internal use cases (summarisation, routing) — those call `generate()` directly once this lands
- Ollama model management (pull, delete) — out of scope for this SP
- GitHub Copilot or other local inference servers

---

## Test Approach

`dashboard/tests/ollama.test.js` — 6 tests, `FLINT_TEST_MODE=1`, `node:test` + `node:assert/strict`:

| Test | Assertion |
|------|-----------|
| `isOllamaReachable` returns `true` in TEST_MODE | `assert.equal(result, true)` |
| `listModels` returns `['llama3']` in TEST_MODE | `assert.deepEqual(result, ['llama3'])` |
| `generate` returns `'test response'` in TEST_MODE | `assert.equal(result, 'test response')` |
| `GET /api/ollama/status` returns `{ reachable, models }` shape | `assert.ok('reachable' in body && 'models' in body)` |
| `POST /api/ollama/generate` with valid body returns `{ response }` | `assert.ok('response' in body)` |
| `POST /api/ollama/generate` missing fields → 400 | `assert.equal(res.status, 400)` |

**Target:** 168 existing + 6 new = 174 total (172 pass, 2 pre-existing Windows EPERM failures in sp5/sp6).

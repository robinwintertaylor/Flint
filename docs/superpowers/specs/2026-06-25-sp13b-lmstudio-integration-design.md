# SP13b: LM Studio Integration — Design Spec

**Date:** 2026-06-25
**Status:** Approved

## Overview

Add LM Studio as a general-purpose local LLM provider for Flint. Delivers a REST client module and two new API routes, giving Flint and its callers access to locally-running LM Studio models via the OpenAI-compatible API. Unlike Ollama, LM Studio has no interactive CLI — it is a GUI app with a local HTTP server — so there is no agent terminal runtime to add.

---

## Architecture

**New file:** `dashboard/lmstudio.js` — LM Studio REST client. Mirrors the `ollama.js` provider pattern: `TEST_MODE` function guard, no auth, no npm dependencies, exports clean named functions.

**Modified:** `dashboard/server.js` — two new routes (`GET /api/lmstudio/status`, `POST /api/lmstudio/generate`) and LM Studio reachability added to `GET /api/health`.

**No DB changes. No new API key entry. No `terminal.js` changes.** LM Studio is local and requires no token. There is no `runtime: 'lmstudio'` agent spawn — LM Studio provides no CLI for interactive chat sessions.

---

## `dashboard/lmstudio.js` Module

### Config

Both values read at call time (not module load):

- `LMSTUDIO_URL`: `process.env.LMSTUDIO_URL ?? 'http://localhost:1234'`
- `TEST_MODE`: `() => process.env.FLINT_TEST_MODE === '1'`

### Exports

**`isLmStudioReachable(): Promise<boolean>`**

`GET {LMSTUDIO_URL}/v1/models` with a 2-second `AbortController` timeout. Returns `false` on any error (network, timeout, non-ok status). In TEST_MODE returns `true`.

**`listModels(): Promise<string[]>`**

Same `GET /v1/models` call. Parses `data.data.map(m => m.id)`. Returns `[]` on error. In TEST_MODE returns `['local-model']`.

**`generate(model, prompt, opts = {}): Promise<string>`**

`POST {LMSTUDIO_URL}/v1/chat/completions` with body:
```json
{ "model": "<model>", "messages": [{ "role": "user", "content": "<prompt>" }], "stream": false }
```
Spreads `opts` into the body. Returns `data.choices[0].message.content` (string). Throws on non-ok HTTP status with message `LM Studio generate failed: <status>`. In TEST_MODE returns `'test response'`.

---

## `server.js` — New Routes

### `GET /api/lmstudio/status`

Calls `isLmStudioReachable()`. If reachable, calls `listModels()`. Returns:

```json
{ "reachable": true, "models": ["model-name"] }
```

If not reachable: `{ "reachable": false, "models": [] }` (200, not an error). Sequential — avoids unnecessary `listModels()` call when LM Studio is down.

### `POST /api/lmstudio/generate`

Body: `{ "model": "local-model", "prompt": "summarise this" }`

Validates both fields present — 400 if either is missing. Calls `generate(model, prompt)`. Returns:

```json
{ "response": "..." }
```

Errors from LM Studio propagate as 500 with `{ "error": err.message }`.

### `GET /api/health` update

Add `lmstudio: await isLmStudioReachable()` alongside the existing Forgejo and Ollama checks.

---

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `LMSTUDIO_URL` | `http://localhost:1234` | Base URL of the local LM Studio server |

No token, no DB key. Model for internal use is passed explicitly to `generate()`; the caller decides.

---

## Out of Scope

- Streaming responses (`stream: true`)
- Dashboard UI for LM Studio model selection
- `runtime: 'lmstudio'` agent spawn (no CLI available)
- LM Studio model management

---

## Test Approach

`dashboard/tests/lmstudio.test.js` — 7 tests, `FLINT_TEST_MODE=1`, `node:test` + `node:assert/strict`:

| Test | Assertion |
|------|-----------|
| `isLmStudioReachable` returns `true` in TEST_MODE | `assert.equal(result, true)` |
| `listModels` returns `['local-model']` in TEST_MODE | `assert.deepEqual(result, ['local-model'])` |
| `generate` returns `'test response'` in TEST_MODE | `assert.equal(result, 'test response')` |
| `GET /api/lmstudio/status` returns `{ reachable, models }` shape | `assert.ok('reachable' in body && 'models' in body)` |
| `POST /api/lmstudio/generate` with valid body returns `{ response }` | `assert.ok('response' in body)` |
| `POST /api/lmstudio/generate` missing prompt → 400 | `assert.equal(res.status, 400)` |
| `POST /api/lmstudio/generate` missing model → 400 | `assert.equal(res.status, 400)` |

**Target:** 175 existing + 7 new = 182 total (180 pass, 2 pre-existing Windows EPERM failures in sp5/sp6).

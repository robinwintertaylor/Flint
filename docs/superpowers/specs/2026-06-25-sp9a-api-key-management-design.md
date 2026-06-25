# SP9a: API Key Management — Design Spec

**Date:** 2026-06-25
**Status:** Approved

## Overview

A central API key management screen in the Flint dashboard. Covers two use cases:

1. **Robin** can see which providers are configured, add new providers, and update or clear keys — all from a single modal. Keys are always masked in the UI so they can't be skimmed from the screen.
2. **Agents** can retrieve the real key for a named provider at runtime via a REST endpoint, enabling them to authenticate with LLM providers, GitHub, Telegram, and any other service Robin has configured.

---

## Architecture

**Storage:** SQLite `api_keys` table (migration in `db.js`). DB-first with env-var fallback — if a DB key exists it takes precedence; otherwise the agent read endpoint falls back to the named environment variable.

**New module:** `dashboard/apikeys.js` — all DB operations (list, get value, add, update, remove). Keeps server.js clean.

**Routes:** added to `dashboard/server.js`.

**UI:** new modal triggered by a `🔑 Keys` toolbar button — same pattern as the existing Workspaces and MCP Servers modals.

---

## Data Model

Table: `api_keys`

| Column | Type | Notes |
|--------|------|-------|
| `name` | TEXT PRIMARY KEY | URL-safe slug, e.g. `anthropic` |
| `label` | TEXT NOT NULL | Display name, e.g. `Anthropic` |
| `key_value` | TEXT | Actual key; NULL if only env var is used |
| `env_var` | TEXT | Env var to check as fallback, e.g. `ANTHROPIC_API_KEY` |
| `created_at` | DATETIME | `DEFAULT CURRENT_TIMESTAMP` |

### Pre-seeded Rows

Inserted once at DB init (key_value NULL — Robin fills them in via the UI):

| name | label | env_var |
|------|-------|---------|
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `github` | GitHub | `GITHUB_TOKEN` |
| `telegram` | Telegram | `TELEGRAM_BOT_TOKEN` |
| `moonshot` | Moonshot Kimi | `MOONSHOT_API_KEY` |

Pre-seeded rows can have their key_value cleared but cannot be deleted from the UI (to avoid accidental removal of well-known providers). Custom-added providers can be deleted.

---

## REST API

### `GET /api-keys`
Returns all providers for the management UI. **Never returns real key values.**

Response:
```json
[
  {
    "name": "anthropic",
    "label": "Anthropic",
    "env_var": "ANTHROPIC_API_KEY",
    "has_db_key": true,
    "env_set": false,
    "masked": "sk-a••••••••3b4c"
  }
]
```

`has_db_key`: true if `key_value` is non-null and non-empty in DB.
`env_set`: true if `process.env[env_var]` is non-empty at request time.
`masked`: first 4 + `••••••••` + last 4 chars of the DB key. `—` if no DB key.

### `GET /api-keys/:name/value`
Returns the real key for agent use. DB key takes precedence; falls back to env var.

Response (200): `{ "value": "sk-ant-..." }`
Response (404): `{ "error": "No key configured for anthropic" }` — if neither DB nor env has a value.

### `POST /api-keys`
Add a new provider.

Body: `{ "name": "moonshot", "label": "Moonshot Kimi", "key_value": "sk-...", "env_var": "MOONSHOT_API_KEY" }`

- `name` required, must be unique, alphanumeric + hyphens only.
- `label` required.
- `key_value` and `env_var` optional.

Response: 201 with the created row (masked).
Error: 409 if name already exists; 400 if name is invalid or label missing.

### `PATCH /api-keys/:name`
Update the key value (and optionally label/env_var) for an existing provider.

Body: `{ "key_value": "sk-new-..." }` (partial update — only fields present are changed)

Response: 200 with updated row (masked).
Error: 404 if provider not found.

### `DELETE /api-keys/:name`
Remove a provider. Pre-seeded providers return 403.

Response: 204.
Error: 403 for pre-seeded names; 404 if not found.

---

## UI

### Toolbar
Add `🔑 Keys` button to `#toolbar` in `index.html`, alongside the existing MCP and Workspaces buttons.

### Modal (`#keys-modal`)
Same structure as the MCP Servers modal:

- **Header:** "API Keys" + close (✕) button
- **Provider table:** one row per provider
  - Label (e.g. "Anthropic")
  - Env var name + badge: green `✓ set` if env_set, grey `not set` if not
  - Masked key (or `—` if no DB key)
  - **Edit** button: replaces the masked key cell with a password-type input + Save/Cancel
  - **Clear** button: sets key_value to null (shown only when has_db_key is true)
  - **Delete** button: only shown for non-seeded providers
- **Add Provider form** (below table):
  - Name input (slug), Label input, Env Var input (optional), Key input (password type)
  - Add button → POST /api-keys → refresh list

### Key masking
`maskedKey(value)`: if value length ≤ 8, return `••••••••`. Otherwise: `value.slice(0,4) + '••••••••' + value.slice(-4)`.

---

## Out of Scope

- Encryption at rest (keys stored in plaintext in SQLite — acceptable for a local single-user tool)
- Per-agent key scoping (any agent can read any key)
- Key rotation or expiry

---

## Test Approach

Unit tests in `dashboard/tests/apikeys.test.js`:
- `listApiKeys` returns masked values, never raw
- `getApiKeyValue` returns DB key when set
- `getApiKeyValue` falls back to env var when DB key is null
- `getApiKeyValue` returns null when neither is set
- `createApiKey` rejects duplicate names
- `deleteApiKey` rejects seeded provider names

Integration tests in `dashboard/tests/server.test.js`:
- `GET /api-keys` — 200, masked response
- `GET /api-keys/:name/value` — 200 with value; 404 when absent
- `POST /api-keys` — 201; 409 on duplicate; 400 on bad name
- `PATCH /api-keys/:name` — 200; 404 on unknown
- `DELETE /api-keys/:name` — 204; 403 on seeded; 404 on unknown

# SP14a: Docker Startup Splash Screen — Design Spec

**Date:** 2026-06-25
**Status:** Approved

## Overview

Add a full-screen splash overlay that gates the Flint dashboard behind a Forgejo availability check. On page load, Flint checks whether Forgejo is reachable. If it is, the splash is never shown and the dashboard loads normally. If Forgejo is down, the splash covers the UI, automatically triggers `docker compose up -d` via a new server route, and polls until Forgejo responds — then dismisses itself and hands off to the normal dashboard startup.

---

## Architecture

**Modified:** `dashboard/server.js` — new `POST /api/docker/start` route that runs `docker compose up -d` from the Flint root directory.

**Modified:** `dashboard/public/index.html` — adds `<div id="splash">` overlay (visible by default) with Flint branding, a status message, a CSS spinner, and an error state.

**Modified:** `dashboard/public/app.js` — replaces the bare `connect()` call at the end of the file with a `startup()` async function that handles the health check, splash lifecycle, and connect handoff.

**Modified:** `dashboard/public/style.css` — splash overlay styles.

No DB changes. No new npm dependencies.

---

## `POST /api/docker/start`

Runs `docker compose up -d` using `execSync` with `cwd: FLINT_ROOT` (already defined in `server.js` as `join(__dirname, '..')`). Timeout: 30 seconds.

Returns `{ ok: true }` on success. Returns `{ ok: false, error: err.message }` if the command throws (e.g. Docker daemon not running). Does not wait for Forgejo to become reachable — that is the client's job.

No auth, no body required.

---

## Splash Overlay

Added to `index.html` as the first child of `<body>`, ensuring it renders over everything:

```html
<div id="splash">
  <img src="/images/Flint Logo 1.jpg" class="splash-logo" alt="Flint">
  <div class="splash-brand">FLINT</div>
  <div class="splash-subtitle">Your Friendly AI Agent OS</div>
  <div class="splash-spinner"></div>
  <div id="splash-message" class="splash-message">Checking services…</div>
  <div id="splash-error" class="splash-error hidden"></div>
</div>
```

**CSS behaviour:**
- `#splash`: `position: fixed; inset: 0; z-index: 9999` — covers the full viewport
- `#splash.hidden`: `display: none` — dismissed once Forgejo is reachable
- Background matches the dashboard dark theme (`#0d1117`)
- Spinner: pure CSS rotating border animation
- Error text: red (`#f85149`)

---

## `app.js` — `startup()` function

Replaces the bare `connect()` at the bottom of `app.js`:

```js
async function startup() {
  try {
    const h = await fetch('/health').then(r => r.json());
    if (h.forgejo === 'reachable') {
      document.getElementById('splash').classList.add('hidden');
      connect();
      return;
    }
  } catch {}

  document.getElementById('splash-message').textContent = 'Starting Forgejo…';
  try { await fetch('/api/docker/start', { method: 'POST' }); } catch {}

  let elapsed = 0;
  const poll = setInterval(async () => {
    elapsed += 3;
    try {
      const h = await fetch('/health').then(r => r.json());
      if (h.forgejo === 'reachable') {
        clearInterval(poll);
        document.getElementById('splash').classList.add('hidden');
        connect();
        return;
      }
    } catch {}
    if (elapsed >= 60) {
      clearInterval(poll);
      document.getElementById('splash-message').textContent = '';
      const err = document.getElementById('splash-error');
      err.textContent = 'Could not reach Forgejo. Run `docker compose up -d` in a terminal, then refresh.';
      err.classList.remove('hidden');
    }
  }, 3000);
}

startup();
```

**Flow:**
1. Immediate `/health` check — if Forgejo is up, splash dismissed instantly (no flicker for normal starts)
2. If down: update message to "Starting Forgejo…", fire `POST /api/docker/start` (fire-and-forget from client's perspective)
3. Poll `/health` every 3 seconds, up to 60 seconds
4. On success: dismiss splash, call `connect()`
5. On timeout: stop polling, show error message with manual instructions

---

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| none | — | `docker compose` path resolved by the OS; `FLINT_ROOT` already defined in server.js |

---

## Out of Scope

- Stopping Docker / `docker compose down` from the dashboard
- Status indicators in the header for ongoing health (separate feature)
- Ollama / LM Studio splash gating (those services are optional, Forgejo is required for PRs)
- Showing Docker container logs in the UI

---

## Test Approach

`dashboard/tests/docker.test.js` — 3 tests, `FLINT_TEST_MODE=1`, `node:test` + `node:assert/strict`:

| Test | Assertion |
|------|-----------|
| `POST /api/docker/start` returns `{ ok: true }` in TEST_MODE | `assert.equal(body.ok, true)` |
| `POST /api/docker/start` without body succeeds (no required fields) | `assert.equal(res.status, 200)` |
| `GET /health` response includes `forgejo` field | `assert.ok('forgejo' in body)` |

The splash logic is frontend-only (`app.js`) and is not covered by server-side tests. Manual verification: load the dashboard with Forgejo down, confirm splash appears and auto-starts Docker.

**Target:** 182 existing + 3 new = 185 total (183 pass, 2 pre-existing Windows EPERM failures).

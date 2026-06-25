# SP8a: Quick UI Wins + Branding — Design Spec

**Date:** 2026-06-25
**Status:** Approved

## Overview

Three small but high-impact changes to the Flint dashboard:
1. A back button from the Queue view to the main agent dashboard
2. A 20% font size increase across the whole UI
3. A taller, branded header with the Flint logo image

Future: a splash/welcome landing page using the hero banner image is noted for a later superpower.

---

## 1. Queue — Back Button

### Problem
`showView('queue')` hides the main panels and toolbar entirely. There is no way to return to the agent dashboard without refreshing the page.

### Solution
Add a `← Dashboard` button at the top of `#queue-view` in `index.html`. When clicked it calls `showView('agents')` in `app.js`.

### Placement
Inside `#queue-view`, as the first child — a slim bar above the task table:

```html
<div id="queue-header-bar">
  <button id="btn-queue-back">← Dashboard</button>
  <span id="queue-title">Task Queue</span>
</div>
```

Styled consistently with the existing toolbar buttons (dark background, border, hover highlight).

### Files
- `dashboard/public/index.html` — add `#queue-header-bar` inside `#queue-view`
- `dashboard/public/app.js` — add click listener: `document.getElementById('btn-queue-back').addEventListener('click', () => showView('agents'))`
- `dashboard/public/style.css` — style `#queue-header-bar`

---

## 2. Font Size +20%

### Current → New sizes

| Element | Current | New |
|---------|---------|-----|
| `body` base | `13px` | `16px` |
| `.logo` | `15px` | `18px` |
| `#agent-count`, `.header-right` | `12px` | `14px` |
| toolbar buttons | `12px` | `14px` |
| `.panel-name` (implied body) | `13px` → | `16px` |
| `.badge` | `10px` | `12px` |
| `.panel-cost`, `.btn-kill`, `.btn-remove` | `11px` | `13px` |
| `.task-content`, `.task-meta` | `11px` | `13px` |
| `.scratchpad-section h4` | `11px` | `13px` |
| `.scratchpad-content` | `10px` | `12px` |
| cost labels | `12px` | `14px` |

All hardcoded `font-size` values in `style.css` scaled by ×1.23 (13→16 ratio), rounded to nearest even `px`. No changes to `em` or `rem` values (there are none currently).

### Files
- `dashboard/public/style.css` — update all `font-size` values

---

## 3. Branded Header

### Current state
- Height: `44px`
- Content: text `⚡ Flint` (blue, bold, 15px), agent count, Projects button, Today/Month costs

### New state
- Height: `72px`
- Left side:
  - `Flint Logo 1.jpg` displayed at `52px × 52px`, `border-radius: 50%; object-fit: cover` with a thin white background ring (`background: #fff; padding: 2px`) to cleanly frame the cartoon character on the dark header
  - Text block to the right of the image:
    - `FLINT` — bold, `#58a6ff`, `20px`
    - `Your Friendly AI Agent OS` — `#8b949e`, `11px`, below
  - Agent count badge and Projects button remain to the right of the text block
- Right side: Today/Month costs unchanged

### Image serving
`server.js` gets one additional static route so the dashboard can load images from the project root:

```js
app.use('/images', express.static(join(FLINT_ROOT, 'images')));
```

The image is then referenced as `<img src="/images/Flint Logo 1.jpg" ...>` in `index.html`.

### Files
- `dashboard/server.js` — add `/images` static route
- `dashboard/public/index.html` — replace `.logo` span with image + text block, increase header height
- `dashboard/public/style.css` — update `#header` height, add `.header-brand` styles

---

## Out of Scope (this superpower)

- Splash / welcome landing page using `Flint Banner-Splash-Hero page 1.jpg` — deferred to later superpower
- `Flint banner-splash-hero page 2.jpg` — deferred
- Any backend changes

---

## Test Approach

No automated tests (frontend-only visual changes). Manual verification:
1. Open dashboard — header shows logo image and correct text at 72px height
2. Font is noticeably larger everywhere
3. Click `⬡ Queue` — Queue view appears with `← Dashboard` button
4. Click `← Dashboard` — returns to agent panels
5. `node --check dashboard/public/app.js` — no syntax errors

# SP8a: Quick UI Wins + Branding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three visual improvements to the Flint dashboard — font sizes +20%, a back-to-dashboard button in the Queue view, and a taller branded header with the Flint logo image.

**Architecture:** Frontend-only changes to `style.css`, `app.js`, and `index.html`, plus one static file-serving route in `server.js`. No database changes, no new API endpoints, no npm dependencies.

**Tech Stack:** Vanilla JS, Express static file serving, Node.js 20+. Tests: manual visual inspection only (no automated test suite for frontend appearance changes).

## Global Constraints

- Font scale factor: ×1.20, round to nearest even px. Mapping: 10→12, 11→13, 12→14, 13→16, 14→17, 15→18.
- `node --check dashboard/public/app.js` must pass clean after any task that edits that file.
- Image at `images/Flint Logo 1.jpg` (project root, not dashboard/) — served via Express at `/images/Flint Logo 1.jpg`.
- Back button belongs INSIDE `renderQueueView()`'s innerHTML template, NOT in index.html. `renderQueueView()` sets `view.innerHTML = \`...\`` which wipes all static HTML in `#queue-view` on every render. Any element added to `#queue-view` in HTML would be destroyed immediately on queue load.
- All commits on current branch (master). Do not touch main.
- Dashboard server is at `dashboard/server.js`; `FLINT_ROOT` and `join` are already imported there.

---

### Task 1: Font Size +20%

**Files:**
- Modify: `dashboard/public/style.css` — update every `font-size` value
- Modify: `dashboard/public/app.js` — update inline `font-size` values inside template strings
- Modify: `dashboard/public/index.html` — update inline `font-size` values in style attributes

**Interfaces:**
- Produces: All font sizes scaled up so Tasks 2 and 3 write new code using the post-scale values.

- [ ] **Step 1: Update font sizes in style.css**

Apply these exact replacements in `dashboard/public/style.css` (one selector/rule per row; locate by selector text):

| Selector | Rule to change |
|----------|---------------|
| `body` | `font-size: 13px` → `font-size: 16px` |
| `.logo` | `font-size: 15px` → `font-size: 18px` |
| `#agent-count` | `font-size: 12px` → `font-size: 14px` |
| `.header-right` | `font-size: 12px` → `font-size: 14px` |
| `#toolbar button` | `font-size: 12px` → `font-size: 14px` |
| `.badge` | `font-size: 10px` → `font-size: 12px` |
| `.panel-cost` | `font-size: 11px` → `font-size: 13px` |
| `.btn-kill` | `font-size: 11px` → `font-size: 13px` |
| `.btn-remove` | `font-size: 11px` → `font-size: 13px` |
| `.btn-diff` | `font-size: 11px` → `font-size: 13px` |
| `.btn-restart` | `font-size: 11px` → `font-size: 13px` |
| `.task-sidebar h4` | `font-size: 11px` → `font-size: 13px` |
| `.task-item span` | `font-size: 11px` → `font-size: 13px` |
| `.task-add input` | `font-size: 11px` → `font-size: 13px` |
| `.task-add button` | `font-size: 13px` → `font-size: 16px` |
| `.modal-box label` | `font-size: 12px` → `font-size: 14px` |
| `.modal-box input` | `font-size: 13px` → `font-size: 16px` |
| `.modal-box select` | `font-size: 13px` → `font-size: 16px` |
| `.modal-actions button` | `font-size: 13px` → `font-size: 16px` |
| `.project-card-name` | `font-size: 14px` → `font-size: 17px` |
| `.project-card-meta` | `font-size: 12px` → `font-size: 14px` |
| `.project-card-notes` | `font-size: 12px` → `font-size: 14px` |
| `.btn-edit` | `font-size: 12px` → `font-size: 14px` |
| `.suggestion-meta` | `font-size: 11px` → `font-size: 13px` |
| `.suggestion-content` | `font-size: 12px` → `font-size: 14px` |
| `.suggestion-actions button` | `font-size: 11px` → `font-size: 13px` |
| `.badge-vibe` | `font-size: 10px` → `font-size: 12px` |
| `.badge-isolated` | `font-size: 10px` → `font-size: 12px` |
| `.btn-merge` | `font-size: 12px` → `font-size: 14px` |
| `.btn-discard` | `font-size: 12px` → `font-size: 14px` |
| `.badge-pr-open` | `font-size: 10px` → `font-size: 12px` |
| `.badge-pr-merged` | `font-size: 10px` → `font-size: 12px` |
| `.badge-pr-closed` | `font-size: 10px` → `font-size: 12px` |
| `.btn-view-pr` | `font-size: 12px` → `font-size: 14px` |
| `.filter-pill` | `font-size: 11px` → `font-size: 13px` |
| `.queue-table` | `font-size: 12px` → `font-size: 14px` |
| `.queue-expand td` | `font-size: 12px` → `font-size: 14px` |
| `.role-chip` | `font-size: 10px` → `font-size: 12px` |
| `.badge-orch` | `font-size: 10px` → `font-size: 12px` |
| `.badge-worker` | `font-size: 10px` → `font-size: 12px` |
| `.scratchpad-section h4` | `font-size: 11px` → `font-size: 13px` |
| `.scratchpad-content` | `font-size: 10px` → `font-size: 12px` |

- [ ] **Step 2: Update inline font-size values in app.js**

Apply these replacements in `dashboard/public/app.js`. Find each by the surrounding text shown:

```
FIND:    <h3 style="margin:0;font-size:15px">Projects</h3>
REPLACE: <h3 style="margin:0;font-size:18px">Projects</h3>
```

```
FIND:    padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px">+ New Project</button>
REPLACE: padding:4px 12px;border-radius:4px;cursor:pointer;font-size:16px">+ New Project</button>
```

```
FIND:    <span style="font-size:13px">${escHtml(agentName)}</span>
REPLACE: <span style="font-size:16px">${escHtml(agentName)}</span>
```

```
FIND:    style="background:none;border:none;color:#f85149;cursor:pointer;font-size:12px" data-unlink=
REPLACE: style="background:none;border:none;color:#f85149;cursor:pointer;font-size:14px" data-unlink=
```

```
FIND:    '<span style="color:#8b949e;font-size:12px">No workspaces registered yet.</span>'
REPLACE: '<span style="color:#8b949e;font-size:14px">No workspaces registered yet.</span>'
```

```
FIND:    <span style="font-weight:600;font-size:13px;color:#e6edf3;min-width:120px">
REPLACE: <span style="font-weight:600;font-size:16px;color:#e6edf3;min-width:120px">
```

```
FIND:    <span style="color:#8b949e;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
REPLACE: <span style="color:#8b949e;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
```

```
FIND:    '<p style="color:#8b949e;font-size:12px;margin:0">No MCP servers configured yet.</p>'
REPLACE: '<p style="color:#8b949e;font-size:14px;margin:0">No MCP servers configured yet.</p>'
```

```
FIND:    <table style="width:100%;border-collapse:collapse;font-size:12px">
REPLACE: <table style="width:100%;border-collapse:collapse;font-size:14px">
```

```
FIND:    <td style="padding:4px 8px;color:#8b949e;font-size:11px">
REPLACE: <td style="padding:4px 8px;color:#8b949e;font-size:13px">
```

```
FIND:    <h3 style="margin:0;font-size:15px">Task Queue</h3>
REPLACE: <h3 style="margin:0;font-size:18px">Task Queue</h3>
```

```
FIND:    padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px">+ Add Task</button>
REPLACE: padding:4px 12px;border-radius:4px;cursor:pointer;font-size:16px">+ Add Task</button>
```

```
FIND:    style="font-size:11px;padding:2px 7px;border-radius:4px;border:1px solid #388bfd;background:none;color:#388bfd;cursor:pointer">Assign</button>
REPLACE: style="font-size:13px;padding:2px 7px;border-radius:4px;border:1px solid #388bfd;background:none;color:#388bfd;cursor:pointer">Assign</button>
```

```
FIND:    style="font-size:11px;padding:2px 7px;border-radius:4px;border:1px solid #f8514966;background:none;color:#f85149;cursor:pointer;margin-left:4px">Cancel</button>
REPLACE: style="font-size:13px;padding:2px 7px;border-radius:4px;border:1px solid #f8514966;background:none;color:#f85149;cursor:pointer;margin-left:4px">Cancel</button>
```

- [ ] **Step 3: Update inline font-size values in index.html**

Apply these replacements in `dashboard/public/index.html`:

```
FIND:    cursor:pointer;font-size:12px;">Projects</button>
REPLACE: cursor:pointer;font-size:14px;">Projects</button>
```

```
FIND:    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
REPLACE: <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:16px">
```

```
FIND:    style="background:#161b22;padding:8px;border-radius:4px;font-size:11px;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;color:#8b949e"
REPLACE: style="background:#161b22;padding:8px;border-radius:4px;font-size:13px;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;color:#8b949e"
```

```
FIND:    style="color:#58a6ff;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Add Server</h4>
REPLACE: style="color:#58a6ff;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Add Server</h4>
```

Apply `font-size:13px` → `font-size:16px` to all four of these lines (each is an input, textarea, or button in the workspace manager and MCP modals):

```
FIND:    style="flex:1;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px">
REPLACE: style="flex:1;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:16px">
```
(2 occurrences: ws-add-name and mcp-add-scope select — search-replace-all is safe here since the surrounding text is identical)

```
FIND:    style="flex:2;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px">
REPLACE: style="flex:2;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:16px">
```

```
FIND:    style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:13px">Add</button>
REPLACE: style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:16px">Add</button>
```

```
FIND:    style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px">
REPLACE: style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:16px">
```
(2 occurrences: mcp-add-name and mcp-add-command inputs)

```
FIND:    font-size:13px;margin-bottom:6px">
REPLACE: font-size:16px;margin-bottom:6px">
```
(2 occurrences: mcp-add-args input and mcp-add-env textarea — both share this suffix)

```
FIND:    style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:13px">Add</button>
REPLACE: style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:16px">Add</button>
```

```
FIND:    style="background:#161b22;padding:8px;border-radius:4px;font-size:11px;color:#8b949e;margin-bottom:8px;white-space:pre-wrap">
REPLACE: style="background:#161b22;padding:8px;border-radius:4px;font-size:13px;color:#8b949e;margin-bottom:8px;white-space:pre-wrap">
```

```
FIND:    style="background:#0d1117;padding:12px;border-radius:4px;font-size:11px;max-height:60vh;
REPLACE: style="background:#0d1117;padding:12px;border-radius:4px;font-size:13px;max-height:60vh;
```

- [ ] **Step 4: Check syntax**

```
node --check dashboard/public/app.js
```
Expected: exits with no output (clean).

- [ ] **Step 5: Manual verification**

Open http://localhost:3000 (start with `cd dashboard && node server.js` if not running). Confirm:
- Body text is visibly larger everywhere
- Toolbar buttons, modal labels, task sidebar text all grew proportionally
- Queue table and filter pills are larger

- [ ] **Step 6: Commit**

```bash
git add dashboard/public/style.css dashboard/public/app.js dashboard/public/index.html
git commit -m "style(sp8a): increase all font sizes by 20%"
```

---

### Task 2: Queue Back Button

**Files:**
- Modify: `dashboard/public/app.js` — add back button inside `renderQueueView()` template + listener
- Modify: `dashboard/public/style.css` — add `#btn-queue-back` hover rule

**Key constraint:** The back button MUST live inside `renderQueueView()`'s template string, not in `index.html`. `renderQueueView()` at line ~933 does `view.innerHTML = \`...\`` which completely replaces every child of `#queue-view` on each render. Static HTML placed in `#queue-view` in `index.html` is destroyed the moment the queue loads.

**Interfaces:**
- Consumes: `showView(view)` — already globally scoped at line ~427 of app.js
- Consumes: post-Task-1 font sizes (back button inline style uses `font-size:14px`)

- [ ] **Step 1: Add back button to the renderQueueView innerHTML template**

In `dashboard/public/app.js`, find the `renderQueueView` function's `view.innerHTML` assignment. The `.queue-header` div currently looks like this (after Task 1 font update):

```js
    <div class="queue-header">
      <h3 style="margin:0;font-size:18px">Task Queue</h3>
      <button id="btn-add-task" style="background:#238636;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:16px">+ Add Task</button>
    </div>
```

Replace it with:

```js
    <div class="queue-header">
      <button id="btn-queue-back" style="background:none;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:14px">← Dashboard</button>
      <h3 style="margin:0;font-size:18px">Task Queue</h3>
      <button id="btn-add-task" style="background:#238636;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:16px">+ Add Task</button>
    </div>
```

The `.queue-header` CSS is `display:flex; justify-content:space-between` so three children will be left, centre, right automatically.

- [ ] **Step 2: Add click listener for the back button**

In `dashboard/public/app.js`, in `renderQueueView`, after the `view.innerHTML = \`...\`` block ends (closing backtick + semicolon), add the back button listener as the first listener (before the existing filter pills listener):

```js
  // Back button
  document.getElementById('btn-queue-back').addEventListener('click', () => showView('agents'));

  // Filter pills
  view.querySelectorAll('.filter-pill').forEach(btn => {
```

- [ ] **Step 3: Add hover style in style.css**

In `dashboard/public/style.css`, after the `.queue-header` rule (currently: `display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;`), add:

```css
#btn-queue-back:hover { background: #21262d; border-color: #58a6ff; color: #58a6ff; }
```

- [ ] **Step 4: Check syntax**

```
node --check dashboard/public/app.js
```
Expected: exits with no output (clean).

- [ ] **Step 5: Manual verification**

Open http://localhost:3000.
1. Click `⬡ Queue` in the toolbar — Queue view appears with a `← Dashboard` button at the top-left of the queue header.
2. Click `← Dashboard` — agent panels and toolbar reappear.
3. Click `⬡ Queue` again — back button is still present (it's part of the rendered template, not a one-time DOM element).
4. Hover the back button — turns blue to match other nav buttons.

- [ ] **Step 6: Commit**

```bash
git add dashboard/public/app.js dashboard/public/style.css
git commit -m "feat(sp8a): add back-to-dashboard button in queue view"
```

---

### Task 3: Branded Header + Image Serving

**Files:**
- Modify: `dashboard/server.js` — add `/images` static route
- Modify: `dashboard/public/index.html` — replace `.logo` span with image + text block
- Modify: `dashboard/public/style.css` — increase `#header` height, add brand layout styles, update `.logo`

**Interfaces:**
- Consumes: `images/Flint Logo 1.jpg` at project root — the 52×52 circular cartoon badge logo
- `FLINT_ROOT = join(__dirname, '..')` already defined in server.js line 22; `join` already imported from `'path'` line 6

- [ ] **Step 1: Add /images static route to server.js**

In `dashboard/server.js`, after line 72:
```js
  app.use(express.static(join(__dirname, 'public')));
```

Add:
```js
  app.use('/images', express.static(join(FLINT_ROOT, 'images')));
```

- [ ] **Step 2: Replace the header structure in index.html**

In `dashboard/public/index.html`, find and replace the entire `<header id="header">` block (lines 11–21):

```
Old:
  <header id="header">
    <div class="header-left">
      <span class="logo">⚡ Flint</span>
      <span id="agent-count">0 agents</span>
      <button id="btn-projects" style="margin-left:12px;background:none;border:1px solid #30363d;color:#e6edf3;padding:2px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Projects</button>
    </div>
    <div class="header-right">
      <span id="today-cost">Today: $0.00</span>
      <span id="month-cost">Month: $0.00</span>
    </div>
  </header>

New:
  <header id="header">
    <div class="header-left">
      <div class="header-brand">
        <img src="/images/Flint Logo 1.jpg" class="header-logo" alt="Flint">
        <div class="header-brand-text">
          <span class="logo">FLINT</span>
          <span class="header-subtitle">Your Friendly AI Agent OS</span>
        </div>
      </div>
      <span id="agent-count">0 agents</span>
      <button id="btn-projects" style="margin-left:12px;background:none;border:1px solid #30363d;color:#e6edf3;padding:2px 10px;border-radius:4px;cursor:pointer;font-size:14px;">Projects</button>
    </div>
    <div class="header-right">
      <span id="today-cost">Today: $0.00</span>
      <span id="month-cost">Month: $0.00</span>
    </div>
  </header>
```

Note: `font-size:14px` on the Projects button — this is the Task 1 scaled value, replacing Task 1's `12px→14px` change since we're rewriting this block.

- [ ] **Step 3: Update style.css for the branded header**

In `dashboard/public/style.css`, replace the current `#header` and `.logo` rules:

```
Old:
#header {
  position: sticky; top: 0; z-index: 100;
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 16px; background: #161b22;
  border-bottom: 1px solid #30363d; height: 44px;
}
.logo { font-weight: bold; color: #58a6ff; margin-right: 12px; font-size: 18px; }

New:
#header {
  position: sticky; top: 0; z-index: 100;
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 16px; background: #161b22;
  border-bottom: 1px solid #30363d; height: 72px;
}
.header-brand { display: flex; align-items: center; gap: 10px; margin-right: 16px; }
.header-logo { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; background: #fff; padding: 2px; }
.header-brand-text { display: flex; flex-direction: column; }
.logo { font-weight: bold; color: #58a6ff; font-size: 20px; line-height: 1.2; }
.header-subtitle { color: #8b949e; font-size: 11px; }
```

Note: `.logo` ends up at 20px (spec requirement) rather than 18px from Task 1 — Task 3 intentionally overrides this one value. The `margin-right: 12px` moves from `.logo` to `.header-brand` (renamed to `gap + margin-right`).

- [ ] **Step 4: Verify image file exists**

```bash
ls "images/Flint Logo 1.jpg"
```
Expected: file listed.

- [ ] **Step 5: Restart server and manual verification**

Restart the dashboard server to pick up the new `/images` route:
```bash
cd dashboard && node server.js
```

Open http://localhost:3000. Verify:
1. Header is visibly taller (72px instead of 44px)
2. Circular logo image appears on the left — cartoon stone character on white disc
3. "FLINT" in bold blue (20px) appears to the right of the image
4. "Your Friendly AI Agent OS" in grey appears below "FLINT"
5. Agent count badge and Projects button still visible to the right of the brand block
6. Today/Month costs still visible in the right section
7. Confirm the logo image loads (no broken image icon) — check browser network tab if unsure

- [ ] **Step 6: Commit**

```bash
git add dashboard/server.js dashboard/public/index.html dashboard/public/style.css
git commit -m "feat(sp8a): branded 72px header with Flint logo image and subtitle"
```

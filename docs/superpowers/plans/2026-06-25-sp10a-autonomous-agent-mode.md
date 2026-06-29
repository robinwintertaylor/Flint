# SP10a: Autonomous Agent Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Flint-orchestrated agents from hanging indefinitely when they pause mid-task expecting a human response.

**Architecture:** Two small additions to `spawnAgent()` in `dashboard/terminal.js`: (1) prepend an autonomous operating directive to the agent's task file before spawn so Claude knows not to ask for confirmation; (2) add a per-agent inactivity timer that sends `"please continue\n"` to the pty after 60 seconds of silence, and clears itself on exit.

**Tech Stack:** Node.js, node-pty (already in use), existing `readTasks`/`writeTasks` helpers.

## Global Constraints

- Single file changed: `dashboard/terminal.js` only — no new files, no DB changes, no new routes, no UI changes.
- `readTasks` and `writeTasks` are already imported from `'./tasks.js'` — do not add new imports.
- Autonomous block idempotency guard: only prepend if task file does not already start with `## Operating Mode:`.
- Default idle threshold: 60 seconds (`FLINT_IDLE_TIMEOUT` env var, in whole seconds).
- Idle notice broadcast: yellow ANSI — `'\r\n\x1b[33m[Flint: agent idle — sent continue]\x1b[0m\r\n'`.
- No automated unit tests (pty spawning is not unit-testable). Verification: `cd dashboard && node --test` must still report 151/151 pass.
- All commits on `master`.

---

### Task 1: Autonomous directive injection

**Files:**
- Modify: `dashboard/terminal.js` — insert directive-prepend block after `injectProjectContext(name)` call (line 56)

**Interfaces:**
- Consumes: `readTasks(name): string`, `writeTasks(name, content: string): void` — already imported from `'./tasks.js'`
- Produces: nothing consumed by Task 2

- [ ] **Step 1: Read the current `spawnAgent` function to confirm the exact insertion point**

Open `dashboard/terminal.js` and locate line 56:
```js
  // Inject project context into task file before spawning
  injectProjectContext(name);
```

The new block goes immediately after this line, before `const isVibe = ...`.

- [ ] **Step 2: Insert the autonomous directive block**

Replace:
```js
  // Inject project context into task file before spawning
  injectProjectContext(name);

  const isVibe = agent.runtime === 'vibe';
```

With:
```js
  // Inject project context into task file before spawning
  injectProjectContext(name);

  // Prepend autonomous operating directive so the agent never pauses for human input
  const AUTONOMOUS_BLOCK =
    '## Operating Mode: Autonomous\n' +
    'You are running as an autonomous agent orchestrated by Flint. No human is monitoring this session.\n' +
    '- Never pause to ask for confirmation or approval\n' +
    '- Make your best judgement on all decisions and proceed\n' +
    '- If you encounter ambiguity, choose the most reasonable interpretation and continue\n' +
    '- Complete all tasks fully without checking in\n' +
    '---\n\n';
  const _currentTasks = readTasks(name);
  if (!_currentTasks.startsWith('## Operating Mode:')) {
    writeTasks(name, AUTONOMOUS_BLOCK + _currentTasks);
  }

  const isVibe = agent.runtime === 'vibe';
```

- [ ] **Step 3: Run the test suite — expect 151/151 pass**

```bash
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 151
ℹ pass 151
ℹ fail 0
```

- [ ] **Step 4: Manual smoke-check**

Start the server (`cd dashboard && node server.js`) and spawn a new agent via the dashboard. In the agent's task file (check `tasks/<agent-name>.md` or wherever it lives), confirm the file now starts with:
```
## Operating Mode: Autonomous
You are running as an autonomous agent orchestrated by Flint...
```

Stop the server (`Ctrl-C`).

- [ ] **Step 5: Commit**

```bash
git add dashboard/terminal.js
git commit -m "feat(sp10a): prepend autonomous directive to agent task file before spawn"
```

---

### Task 2: Inactivity auto-responder

**Files:**
- Modify: `dashboard/terminal.js` — add `IDLE_THRESHOLD_MS` constant (after line 29), `lastOutput` tracking variable (line 81 area), `lastOutput = Date.now()` reset in `onData` (line 84), `idleChecker` interval (after `onData` closes, line 121), and `clearInterval(idleChecker)` in `onExit` (line 123)

**Interfaces:**
- Consumes (from existing code):
  - `agent.ptyProcess` — the live pty process handle
  - `broadcastToAgent(name, msg)` — already imported, broadcasts to the agent's terminal panel
- Produces: nothing consumed by other tasks

- [ ] **Step 1: Add the `IDLE_THRESHOLD_MS` module-level constant**

In `dashboard/terminal.js`, replace:
```js
const MAX_SUGG_BUFFER = 4000;
```
With:
```js
const MAX_SUGG_BUFFER = 4000;
const IDLE_THRESHOLD_MS = parseInt(process.env.FLINT_IDLE_TIMEOUT ?? '60') * 1000;
```

- [ ] **Step 2: Add `lastOutput` tracking variable inside `spawnAgent`**

Replace:
```js
  let lastCost = 0;
  const outputBuffer = [];
  let suggBuffer = '';
```
With:
```js
  let lastCost = 0;
  const outputBuffer = [];
  let suggBuffer = '';
  let lastOutput = Date.now();
```

- [ ] **Step 3: Reset `lastOutput` on every data chunk**

Replace the first line of the `onData` handler:
```js
  ptyProcess.onData((data) => {
    broadcastToAgent(name, { type: 'output', agent: name, data });
```
With:
```js
  ptyProcess.onData((data) => {
    lastOutput = Date.now();
    broadcastToAgent(name, { type: 'output', agent: name, data });
```

- [ ] **Step 4: Add the idle checker interval after the `onData` handler**

Replace:
```js
  });

  ptyProcess.onExit(() => {
```
With:
```js
  });

  const idleChecker = setInterval(() => {
    if (!agent.ptyProcess) { clearInterval(idleChecker); return; }
    if (Date.now() - lastOutput > IDLE_THRESHOLD_MS) {
      lastOutput = Date.now();
      agent.ptyProcess.write('please continue\n');
      broadcastToAgent(name, {
        type: 'output',
        agent: name,
        data: '\r\n\x1b[33m[Flint: agent idle — sent continue]\x1b[0m\r\n',
      });
    }
  }, 10_000);

  ptyProcess.onExit(() => {
```

- [ ] **Step 5: Clear the interval in the `onExit` handler**

Replace:
```js
  ptyProcess.onExit(() => {
    // Save last session output as summary on linked project
```
With:
```js
  ptyProcess.onExit(() => {
    clearInterval(idleChecker);
    // Save last session output as summary on linked project
```

- [ ] **Step 6: Run the test suite — expect 151/151 pass**

```bash
cd dashboard && node --test 2>&1 | tail -8
```

Expected:
```
ℹ tests 151
ℹ pass 151
ℹ fail 0
```

- [ ] **Step 7: Verify final shape of `spawnAgent` (self-check)**

The relevant portion of `spawnAgent` should now look like this (confirm by reading the file):

```js
  // Inject project context into task file before spawning
  injectProjectContext(name);

  // Prepend autonomous operating directive so the agent never pauses for human input
  const AUTONOMOUS_BLOCK =
    '## Operating Mode: Autonomous\n' +
    'You are running as an autonomous agent orchestrated by Flint. No human is monitoring this session.\n' +
    '- Never pause to ask for confirmation or approval\n' +
    '- Make your best judgement on all decisions and proceed\n' +
    '- If you encounter ambiguity, choose the most reasonable interpretation and continue\n' +
    '- Complete all tasks fully without checking in\n' +
    '---\n\n';
  const _currentTasks = readTasks(name);
  if (!_currentTasks.startsWith('## Operating Mode:')) {
    writeTasks(name, AUTONOMOUS_BLOCK + _currentTasks);
  }

  const isVibe = agent.runtime === 'vibe';
  // ...
  let lastCost = 0;
  const outputBuffer = [];
  let suggBuffer = '';
  let lastOutput = Date.now();

  ptyProcess.onData((data) => {
    lastOutput = Date.now();
    broadcastToAgent(name, { type: 'output', agent: name, data });
    // ... rest of onData unchanged ...
  });

  const idleChecker = setInterval(() => {
    if (!agent.ptyProcess) { clearInterval(idleChecker); return; }
    if (Date.now() - lastOutput > IDLE_THRESHOLD_MS) {
      lastOutput = Date.now();
      agent.ptyProcess.write('please continue\n');
      broadcastToAgent(name, {
        type: 'output',
        agent: name,
        data: '\r\n\x1b[33m[Flint: agent idle — sent continue]\x1b[0m\r\n',
      });
    }
  }, 10_000);

  ptyProcess.onExit(() => {
    clearInterval(idleChecker);
    // ... rest of onExit unchanged ...
  });
```

- [ ] **Step 8: Commit**

```bash
git add dashboard/terminal.js
git commit -m "feat(sp10a): add inactivity auto-responder — send continue after 60s silence"
```

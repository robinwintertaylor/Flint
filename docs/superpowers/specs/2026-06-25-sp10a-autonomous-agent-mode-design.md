# SP10a: Autonomous Agent Mode — Design Spec

**Date:** 2026-06-25
**Status:** Approved

## Overview

Flint orchestrates agents autonomously — no human operator monitors the terminal. However, Claude Code agents sometimes pause mid-task to ask for confirmation ("Should I continue?", "Do you want me to proceed?"), and since nobody is watching, the agent hangs indefinitely.

Two complementary fixes, both in `dashboard/terminal.js`:

1. **Autonomous directive injection** — prepend a system-level instruction block to every agent's task file before spawn, preventing most conversational pauses from happening.
2. **Inactivity auto-responder** — detect silence (no pty output for N seconds) and automatically send "please continue" to unstick any agent that does pause.

`--dangerously-skip-permissions` is already set on spawn; this superpower addresses the conversational pause problem, not tool-approval prompts.

---

## Architecture

All changes are in `spawnAgent()` in `dashboard/terminal.js`. No new files, no DB changes, no new REST routes, no UI changes.

---

## Change 1: Autonomous Directive Injection

### What

Before the pty is spawned, prepend a fixed markdown block to the agent's task file. This block instructs the agent to operate fully autonomously and never pause for human input.

### Block content

```
## Operating Mode: Autonomous
You are running as an autonomous agent orchestrated by Flint. No human is monitoring this session.
- Never pause to ask for confirmation or approval
- Make your best judgement on all decisions and proceed
- If you encounter ambiguity, choose the most reasonable interpretation and continue
- Complete all tasks fully without checking in
---

```

### Placement

In `spawnAgent()`, after `injectProjectContext(name)` is called, read the current task file and prepend the block — unless the file already starts with `## Operating Mode:` (idempotency guard, so re-spawning doesn't double-inject).

```js
const existing = readTasks(name);
const AUTONOMOUS_BLOCK = `## Operating Mode: Autonomous\nYou are running as an autonomous agent orchestrated by Flint. No human is monitoring this session.\n- Never pause to ask for confirmation or approval\n- Make your best judgement on all decisions and proceed\n- If you encounter ambiguity, choose the most reasonable interpretation and continue\n- Complete all tasks fully without checking in\n---\n\n`;
if (!existing.startsWith('## Operating Mode:')) {
  writeTasks(name, AUTONOMOUS_BLOCK + existing);
}
```

Applies to both Claude and Vibe runtimes.

---

## Change 2: Inactivity Auto-Responder

### What

A per-agent interval checks how long ago the agent last produced output. If the silence exceeds the threshold, it sends `"please continue\n"` to the pty and broadcasts a visible notice to the terminal panel so Robin can see it happened.

### Implementation

In `spawnAgent()`, inside the pty setup block:

```js
const IDLE_THRESHOLD_MS = parseInt(process.env.FLINT_IDLE_TIMEOUT ?? '60') * 1000;
let lastOutput = Date.now();

// Existing onData handler — add lastOutput reset at the top:
ptyProcess.onData((data) => {
  lastOutput = Date.now();
  // ... rest of existing handler unchanged ...
});

// New idle checker:
const idleChecker = setInterval(() => {
  if (!agent.ptyProcess) { clearInterval(idleChecker); return; }
  if (Date.now() - lastOutput > IDLE_THRESHOLD_MS) {
    lastOutput = Date.now(); // reset to avoid spamming
    agent.ptyProcess.write('please continue\n');
    broadcastToAgent(name, {
      type: 'output',
      agent: name,
      data: '\r\n\x1b[33m[Flint: agent idle — sent continue]\x1b[0m\r\n',
    });
  }
}, 10_000);
```

The notice is yellow (ANSI `\x1b[33m`) so it's visible but distinct from agent output.

### Cleanup

In the existing `ptyProcess.onExit` handler, add `clearInterval(idleChecker)` as the first line.

### Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `FLINT_IDLE_TIMEOUT` | `60` | Seconds of silence before auto-resume fires |

Set to a higher value (e.g. `180`) if agents regularly run long bash commands with no output.

---

## Out of Scope

- Per-agent configurable timeout (single global env var is sufficient)
- Pattern-based detection of specific prompt types (too fragile)
- UI toggle to enable/disable autonomous mode per agent
- Modifying the Vibe runtime's autonomous behaviour separately

---

## Test Approach

No automated unit tests (pty interaction is difficult to unit-test in isolation). The existing 151-test suite must still pass after the change.

Manual verification:
1. Spawn an agent — confirm the task file contains the `## Operating Mode: Autonomous` block
2. Spawn an agent, do nothing — after 60 seconds, the terminal panel shows `[Flint: agent idle — sent continue]` in yellow
3. Re-spawn the same agent — confirm the autonomous block is not duplicated in the task file
4. Run `cd dashboard && node --test` — confirm 151/151 pass

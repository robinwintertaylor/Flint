# Installer Automation & Documentation Refresh — Design Spec

**Date:** 2026-07-04
**Status:** Approved, ready for planning

## Problem

`install-flint.ps1` already auto-installs Node.js, Git, PM2, Claude Code CLI, and
VS2022 Build Tools via winget — but Docker Desktop and Forgejo bootstrap are
entirely absent from it. Setting those up today requires following separate
manual steps in the README (`docker compose up -d`, then
`.\scripts\forgejo-init.ps1`). This was confirmed directly this session: a
second machine had Forgejo's Docker container running but was never wired into
Flint's git repo because the bootstrap script had never been run.

Two smaller but real bugs compound this:
- The installer `npm install -g`s a package called `pm2-startup`; the README's
  manual instructions and the admin manual both reference a differently-named
  package, `pm2-windows-startup` — the one actually confirmed installed and
  working on the primary dev machine. Inconsistent naming across the two paths.
- The admin manual states `pm2-windows-startup install` "registers PM2 in
  Windows Task Scheduler." Confirmed directly this session (via
  `Get-ItemProperty HKCU:\...\Run`) that it actually uses a Registry Run key
  running an invisible VBScript — the documented mechanism is simply wrong.

Separately, `README.md`, `docs/user-manual.md`, and `docs/admin-manual.md` have
not been touched since 2026-07-01 — before Model Audit, the finished Project
Orchestration feature, the workspace-routing bugfix, and the entire Project Git
Integration feature shipped. `docs/user-manual.md`'s "Projects" section in
particular still describes only basic CRUD/agent-linking from before
orchestration existed at all.

## Goals

- One script run (`install-flint.ps1`), on a completely bare Windows machine,
  produces a fully working Flint instance — Docker Desktop and Forgejo
  included — with no README steps required.
- Every install step is idempotent: safe to re-run the whole script after a
  partial failure (e.g. a required reboot) without redoing completed work or
  erroring on things that already exist.
- Boot persistence (PM2 surviving a reboot) is verified, not just attempted —
  the installer confirms the Registry Run key actually exists before reporting
  success.
- A standalone, re-runnable health-check script exists for diagnosing "why
  didn't it come back after reboot" without a multi-step manual investigation.
- README/user-manual/admin-manual accurately describe the current install
  flow and every shipped feature through Project Git Integration.

## Non-goals

- Packaging as a `.exe`/MSI installer — explicitly deferred. Robin wants this
  as a later phase once the PowerShell-based flow is stable and any bugs from
  this round are shaken out.
- Auto-enabling Windows features (WSL2/Hyper-V) that require an unattended
  reboot-and-resume — the installer detects this case and asks the user to
  reboot and re-run manually, rather than attempting to orchestrate the reboot
  itself.
- Rewriting unrelated, still-accurate sections of the manuals (e.g. Task
  Queue, Specialists, Costs, MCP Servers) — only sections proven stale above
  are in scope, plus whatever new sections the two features need.

## Installer changes (`install-flint.ps1`)

Added after the existing prerequisite block (Node/Git/PM2/Claude CLI/Build
Tools), before the existing "npm install dependencies" step:

1. **Docker Desktop check/install.** `Test-Command 'docker'` (or equivalent
   detection already used for other prereqs); if missing,
   `winget install Docker.DockerDesktop --silent --accept-package-agreements --accept-source-agreements`.
2. **Docker readiness check with a distinct reboot-required outcome.** After
   install, poll whether the Docker daemon actually responds (e.g.
   `docker info`) for up to a bounded timeout. If it never comes up *and* the
   install was fresh (WSL2/Hyper-V likely just enabled), print a clear,
   distinct message: "Docker Desktop needs a restart to finish enabling
   virtualization features. Restart your PC, then re-run `.\install-flint.ps1`
   — it will pick up where it left off." Exit non-zero so this is
   unambiguous, distinct from a generic failure.
3. **Forgejo bootstrap, inlined.** Once Docker is confirmed responsive:
   `docker compose up -d` (from `FlintRoot`), wait for
   `http://localhost:3030/api/v1/version` (same wait pattern
   `forgejo-init.ps1` already uses), then run that script's existing
   admin-user/token/repo/remote bootstrap logic. `forgejo-init.ps1` itself
   stays as a standalone script (still directly runnable for repair/re-bootstrap),
   but the installer calls its logic automatically rather than requiring a
   second manual invocation.
4. **Fix the pm2-startup package name.** Replace
   `npm install -g pm2-startup --silent` with
   `npm install -g pm2-windows-startup --silent`, matching the command already
   used later in the same block (`pm2-startup install` — check: is this the
   correct *command* name even though the *package* is
   `pm2-windows-startup`? Confirm during planning by checking the installed
   package's bin name; adjust whichever side is wrong so the installed
   package and invoked command agree).
5. **Verify boot persistence, don't just attempt it.** After
   `pm2-windows-startup install` + `pm2 save`, check
   `Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'` for
   the `PM2` value and warn explicitly (not just "could not auto-configure")
   if it's missing, rather than assuming success from a zero exit code alone.

All new steps follow the installer's existing idempotency convention
(`Test-Command`/existence checks before acting) so a re-run after a
mid-script reboot skips everything already done and resumes at the first
incomplete step.

## `pm2 save` drift prevention

Today `pm2 save` only runs once, during install. Any later change to the
running process set (adding API keys and restarting `flint-router`, a manual
`pm2 restart`, etc.) leaves the saved snapshot stale, so a reboot resurrects
outdated state. Fix: everywhere Flint's own tooling programmatically restarts
a PM2-managed process (currently: the dashboard's API-key-save flow, which
already runs `pm2 restart flint-router`), append `pm2 save` immediately after.
This is a small, targeted addition — not a general "always re-save on a
timer" mechanism, since that would mask the actual moments state changes.

## `scripts/flint-doctor.ps1` (new)

A standalone, idempotent, re-runnable diagnostic script — not part of the
install flow, run manually anytime. Checks, in order, and reports pass/fail
per item with the specific fix command if failing:
- Node.js, Git, PM2, Claude Code CLI present (version check, matching the
  installer's own prerequisite checks)
- Docker daemon responsive
- Forgejo API reachable (`http://localhost:3030/api/v1/version`)
- `forgejo.token` exists and is a currently-valid token (matches
  `forgejo-init.ps1`'s own token-validation logic)
- `git remote -v` in the Flint root shows a `forgejo` remote
- PM2 boot-persistence Registry Run key exists
- `flint-dashboard`/`flint-router` are both `online` in `pm2 jlist`
- `GET http://localhost:3000/health` returns `status: "ok"`

This directly replaces the multi-step manual investigation from earlier this
session (checking `pm2 list`, `Get-ItemProperty` for the Run key, `git
remote -v`, health endpoint, etc. one at a time) with one command.

## Documentation updates

**`README.md`:**
- "Prerequisites" section reframed: these are now auto-installed, list stays
  as reference/what's-happening-under-the-hood rather than required manual
  steps.
- "First-Time Setup" collapses to: clone, run `.\install-flint.ps1` as
  Administrator, done. The current 6-step manual Forgejo/PM2/API-key dance
  moves to an "Advanced / Manual Setup" appendix for anyone who wants to run
  steps individually or is repairing a broken install rather than starting
  fresh.

**`docs/admin-manual.md`:**
- "Installation" section simplified the same way as the README.
- "Persist across reboots" corrected: Registry Run key mechanism (not Task
  Scheduler), `pm2-windows-startup` package name consistent with the fixed
  installer, and the `pm2 save`-after-restart convention documented.
- New section: **Model Audit** — weekly cron trigger, `model_audit_reports`/
  `model_audit_items` tables, the Audit tab approve/reject/apply flow, the
  `no_change`/`failed` outcomes.
- New section: **Project Git Integration** — per-project Forgejo repo
  lifecycle (auto-create for blank workspaces, offline fallback + re-sync),
  the four new `orchestrations` columns, `POST /orchestrations/:id/complete`,
  `POST /projects/:id/sync-repo`, and the `pr_status` values an admin might
  see (`open`/`merged`/`closed`/`no_remote`/`failed`).
- New Troubleshooting entry: `scripts/flint-doctor.ps1` usage.

**`docs/user-manual.md`:**
- "Projects" section rewritten to cover the current feature set: the Goal
  field, the Launch button (disabled until a goal is set), the orchestration
  status chip, the scratchpad viewer modal, and — from Project Git
  Integration — that finishing a goal now automatically commits work, pushes
  a branch, and opens a PR (or falls back to local-only commits with a note
  if Forgejo/GitHub isn't reachable, syncing once it's back).

## Error handling

| Scenario | Behavior |
|---|---|
| Docker Desktop install requires a reboot (fresh WSL2 enablement) | Script exits with a clear, distinct "restart and re-run" message, not a generic error |
| Re-running the installer after a partial run | Every step's existing idempotency check (already the installer's convention) means completed steps are skipped, not redone or erroring |
| Forgejo bootstrap runs before Docker is actually ready | The existing wait-for-`/api/v1/version` polling (reused from `forgejo-init.ps1`) blocks until ready or times out with a clear error, same as today's standalone script |
| `pm2-windows-startup install` succeeds by exit code but the Registry key isn't actually present | Installer explicitly checks for the key and warns with the exact manual fallback command, rather than silently trusting the exit code |
| `flint-doctor.ps1` run before Flint is installed at all | Each check reports its own pass/fail independently — no check depends on an earlier one having passed, so partial/failed installs still get a full, useful report |

## Testing

- This is primarily PowerShell tooling (no automated test framework exists for
  `install-flint.ps1`/`forgejo-init.ps1` today, and this spec doesn't
  introduce one) — verification is manual, on a real or freshly-reset VM:
  full run on a bare machine (with and without WSL2 already enabled, to
  exercise the reboot-required path), then a second run to confirm
  idempotency (nothing reinstalled, no errors on already-satisfied steps).
- `flint-doctor.ps1` is verified by deliberately breaking one check at a time
  (stop Docker, delete the Registry key, rename `forgejo.token`) and
  confirming it reports that specific failure accurately.
- Documentation changes are verified by re-reading each rewritten section
  against the actual current code/behavior (routes, table names, script
  names) rather than against the old text being replaced.

## Open items for implementation planning

- Confirm the exact npm package name vs. invoked command name mismatch for
  `pm2-startup`/`pm2-windows-startup` by checking the installed package's
  actual bin name, and align both the installer and docs to whichever side
  needs correcting.
- Decide the exact bounded timeout for the "is Docker actually responsive"
  poll before declaring "reboot required" (matching the general pattern of
  `forgejo-init.ps1`'s existing 60-second wait-for-Forgejo poll).

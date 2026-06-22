# Skill: Heartbeat

## Purpose
Self-maintenance scan at session start. Keeps CLAUDE.md skill registry in sync with what's on disk. Runs automatically — never skip it.

## Trigger
Runs at every session start per CLAUDE.md Session Rule 1.
Also triggered by: "run heartbeat", "sync skills", "refresh registry".

## Prerequisites
- CLAUDE.md exists in project root with `## Skill Registry`, `## MCP Servers`, and `## Last Heartbeat` sections
- skills/ directory exists

## Steps

1. **Scan skills/ directory**
   - List every direct subdirectory of skills/ that contains a SKILL.md file
   - For each, record: folder name (= skill name) and the first sentence (up to and including the first full stop) of the line immediately after `## Purpose` in that SKILL.md (= description)
   - Example: `skills/heartbeat/SKILL.md` → skill name `heartbeat`, description `Self-maintenance scan at session start.`

2. **Load current registry**
   - Read the `## Skill Registry` section from CLAUDE.md
   - Parse each line matching `- skill-name: description`

3. **Diff and update registry**
   - Found on disk but missing from registry → add as `- skill-name: description`
   - In registry but no longer on disk → remove that line
   - On disk with changed description → update the line
   - Write the updated `## Skill Registry` section back to CLAUDE.md (preserve the `<!-- Heartbeat maintains this -->` comment)

4. **Scan MCP servers**
   - Check if `.claude/settings.json` exists in the project root
   - If yes, read the `mcpServers` object — each key is a server name
   - Compare server names against `## MCP Servers` section in CLAUDE.md
   - For any new server not already listed, add: `- server-name: (detected from .claude/settings.json)`
   - Do not remove or modify existing MCP entries

5. **Update timestamp**
   - Replace the content of `## Last Heartbeat` with: `<!-- YYYY-MM-DD HH:MM -->` using the current local date and time

6. **Report**
   - If changes: `Heartbeat: N skills registered, +N new, -N removed`
   - If no changes: `Heartbeat: all N skills current — YYYY-MM-DD HH:MM`

## Output
Updated CLAUDE.md: current skill registry, detected MCP servers, current timestamp.

## Edge Cases
- skills/ subfolder with no SKILL.md → skip silently, do not register
- CLAUDE.md missing a required section → create the section with correct markdown heading
- .claude/settings.json not found → skip MCP scan, append `(MCP scan skipped — settings.json not found)` to report. .claude/settings.json exists but contains invalid JSON → skip MCP scan, append `(MCP scan skipped — settings.json is not valid JSON)` to report.

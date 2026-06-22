# Skill: Wrap-up

## Purpose
Session close workflow. Summarises session, logs learnings, writes daily log, commits everything to git, re-syncs registry.

## Trigger
Robin says any of: "wrap up", "close", "done for today", "wrap", "end session".

## Prerequisites
- git initialised in project root
- context/learnings.md exists

## Steps

1. **Summarise session**
   List (bullet points, max 10 items each):
   - What was accomplished this session
   - Decisions made
   - Open threads (things started but not finished)
   Present this summary to Robin before continuing.

2. **Collect feedback**
   Ask Robin one question: "Anything that worked well, or should be different next time?"
   Wait for answer. If Robin says "nothing", "no", or "all good" → record "no feedback this session".

3. **Append to context/learnings.md**
   Add a new entry at the TOP of the file (newest first):
   ```
   ## YYYY-MM-DD
   **Accomplished:** [bullet summary from step 1]
   **Decisions:** [decisions from step 1, or "none"]
   **Open threads:** [open threads from step 1, or "none"]
   **Feedback:** [Robin's answer from step 2]
   ```

4. **Write daily log**
   Create (or overwrite) `context/YYYY-MM-DD.md`:
   ```markdown
   # Session Log — YYYY-MM-DD

   ## Accomplished
   [bullet list]

   ## Decisions
   [bullet list or "none"]

   ## Open Threads
   [bullet list or "none"]

   ## Next Session
   [one suggested starting point based on open threads]
   ```

5. **Git commit**
   ```
   git add -A
   git commit -m "session: YYYY-MM-DD — [one-line summary of main accomplishment]"
   ```

6. **Re-run heartbeat**
   Execute the heartbeat skill to sync registry before closing.

7. **Report**
   Say: "Session closed. Learnings saved. Committed. See you next time."

## Output
- Updated context/learnings.md (new entry at top)
- New context/YYYY-MM-DD.md
- Git commit with session summary

## Edge Cases
- git not initialised → warn Robin, skip commit step, still write learnings and daily log
- Robin triggers wrap-up with nothing accomplished → still write the log with "No tasks completed this session"

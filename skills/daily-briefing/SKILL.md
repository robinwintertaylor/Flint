# Skill: Daily Briefing

## Purpose
Morning summary of priorities, open threads, and what Flint remembers from last session. Gives Robin a fast, grounded start to the day.

## Trigger
Robin says: "daily briefing", "morning briefing", "what's on today", "brief me".
Also runs automatically when scheduled via .cron/schedule.json.

## Prerequisites
- context/memory.md exists (can be empty)
- context/learnings.md exists (can be empty)

## Steps

1. **Read context**
   - Read context/memory.md — note any stated priorities, ongoing projects, key facts
   - Read context/learnings.md — read the most recent entry (top of file) for open threads and feedback
   - Check if `context/[yesterday's date].md` exists — if yes, extract its "Open Threads" and "Next Session" sections

2. **Compose briefing**
   Format the output exactly as:

   ```
   # Flint — Daily Briefing [WEEKDAY DD MONTH YYYY]

   ## Top Priorities
   [3-5 bullet points drawn from memory.md and open threads.
    If memory is empty: "No priorities logged yet — tell me what you're working on."]

   ## Open Threads
   [Unresolved items from the most recent session log or learnings entry.
    If none: "No open threads."]

   ## Flint Remembers
   [2-3 relevant facts from memory.md useful for today.
    If memory is empty: "Memory is empty — I'll start building it as we work today."]

   ## Yesterday
   [One-line summary of yesterday's session log if it exists.
    If not: "No log from yesterday."]
   ```

3. **Deliver and offer**
   Print the briefing, then say: "What would you like to work on?"

## Output
Briefing printed to chat. No files modified.

## Edge Cases
- All context files empty (very first session) → deliver a "fresh start" briefing:
  "Memory is empty and no past sessions found. Run /start-here to build your brand context, or just tell me what you're working on."
- Run multiple times in one day → deliver again, note: "(repeat briefing — context unchanged since this morning)"
- Run via cron with no active chat → write briefing to `context/YYYY-MM-DD-briefing.md` instead of printing to chat

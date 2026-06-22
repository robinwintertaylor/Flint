# Skill: Start Here

## Purpose
One-time brand context interview. Asks Robin 5 questions and writes the answers into brand_context/. Re-run anytime to refresh brand context.

## Trigger
Robin says: "start here", "setup", "build my brand context", "run start-here".
Also auto-triggers if brand_context/voice-profile.md contains only comments (never been filled in).

## Prerequisites
- brand_context/ directory exists (stub files are fine — this skill overwrites them)

## Steps

1. **Announce**
   Say: "I'll ask you 5 questions to build your brand context. One at a time — just answer naturally."

2. **Question 1 — Voice & Tone**
   Ask: "How do you like to communicate? Describe your tone — casual or formal, direct or warm, any humour? Any words or phrases you love or avoid?"
   Wait for full answer before continuing.

3. **Question 2 — Positioning**
   Ask: "What makes you or your business different? What's your unique angle — what do you offer that alternatives don't?"
   Wait for full answer before continuing.

4. **Question 3 — Ideal Customer**
   Ask: "Who do you serve? Describe your ideal customer — who they are, what problem they're trying to solve, what they've already tried."
   Wait for full answer before continuing.

5. **Question 4 — Business Goals**
   Ask: "What are you trying to achieve in the next 90 days? Be specific — revenue targets, content output, launches, audience growth."
   Wait for full answer before continuing.

6. **Question 5 — Content Examples**
   Ask: "Share 2-3 examples of your best content or output — an email, post, message, or document you're proud of. Paste them here."
   Wait for full answer before continuing.

7. **Write brand_context/ files**
   Using the answers collected, write all 5 files now:

   **brand_context/voice-profile.md** — structured version of Q1 answer:
   ```markdown
   # Voice Profile
   [Extract and structure: tone descriptors, words to use, words to avoid,
    sentence length, formality level, any example phrases Robin provided]
   ```

   **brand_context/positioning.md** — structured version of Q2 answer:
   ```markdown
   # Positioning
   [Extract: what the business does, who for, key differentiator, unique angle]
   ```

   **brand_context/icp.md** — structured version of Q3 answer:
   ```markdown
   # Ideal Customer Profile
   [Extract: who they are, their core problem, what they've tried, what success looks like]
   ```

   **brand_context/samples.md** — Q5 answer verbatim:
   ```markdown
   # Content Samples
   [Paste Robin's examples exactly as given — Flint reads these to match voice]
   ```

   **brand_context/assets.md** — leave as stub with a note:
   ```markdown
   # Brand Assets
   <!-- Fill in manually: website URL, social handles, product names, boilerplate, key links -->
   ```

8. **Confirm**
   Say: "Brand context built. Files written:" then list each file with one line describing what's now in it.
   Say: "Edit any file directly, or run /start-here again to redo the interview."

## Output
Populated brand_context/ directory. All skills now have access to Robin's voice, positioning, ICP, and sample outputs.

## Edge Cases
- Robin skips a question (says "skip") → write `<!-- Skipped during interview — fill in manually -->` in that file
- Robin wants to update one section only → ask which question to re-run, update only that file

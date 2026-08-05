# PHGG Discord automation

Discord bot for PHGG scrims: registration boards, announcements, and score
tallying from Bloodstrike endgame screenshots.

    npm install
    npm start          # reads .env / .env.local if present
    npm test
    npm run check      # syntax check every module

## Reading scoreboards

Screenshots are read locally by template matching — no API key, no quota. The
endgame screen is a fixed grid in a fixed bitmap font, so every glyph is
pixel-identical between captures and reading it is a lookup with an exact
answer rather than a recognition problem.

The rule the whole design serves: **it never guesses.** A cell that does not
match a template outright is reported instead of being resolved to a plausible
value. A flagged row costs a scorekeeper ten seconds; a wrong row costs a team
its placement.

Cloud vision (`TALLY_VISION_PROVIDER=gemini`) remains as a fallback for a layout
the templates do not know, such as a Bloodstrike UI restyle.

### Teaching it a new screenshot

Every capture added makes the reader permanently better at that case. This is
how slot letters `P`, `R` and `S` went from unreadable to exact.

1. Save the screenshot into `test/fixtures/screenshots/`. **Take it from
   Discord, not the phone gallery** — the bot reads what Discord serves, and
   re-encoding is what makes a capture hard.

2. Draft the ground truth:

       node scripts/add-captures.mjs

   It prints a ready-to-paste block for each new image, with anything it could
   not read marked `// CHECK`.

3. **Verify every value against the screenshot**, then paste the block into a
   round in `test/fixtures/scoreboard-ground-truth.js`.

   This step is not optional. The draft comes from the reader itself, so a value
   it misread would be written down as correct and then taught back as a
   template — that is how a reader poisons itself. Checking filled-in rows
   against an image takes seconds; the script exists to save the typing, not the
   checking.

   Use `skip: true` for a row whose values are cut off by the capture edge: the
   reader still detects it, but there is nothing on screen to label it with.

4. Rebuild and confirm nothing regressed:

       node scripts/build-glyph-atlas.mjs
       node scripts/ocr-calibrate.mjs
       npm test

   Calibration reports accuracy and coverage separately. **Wrong must stay at
   zero** — coverage going up is good, but never at the cost of a wrong answer.

The captures themselves stay out of git (they are large binaries); the atlas
built from them is committed, so production gets the accuracy without the files.

### Which screenshots are worth adding

- Ones the bot **flagged or misread**. Failures teach it more than successes.
- Ones containing slot letters it has never seen.
- Captures at a new size or from a new device — the reader is scale-independent,
  but templates cut at one scale match poorly at another, so the atlas is
  harvested at eleven scales.

### Known limits

- Below ~0.95x reference scale the reader declines rather than reads. Glyphs
  that small cannot be separated reliably, and threshold tuning does not fix it.
- A resized *and* re-encoded capture can still produce a wrong value; no
  confidence threshold rejects all of them. The durable fix is checking each
  team total against the sum of its four players' kills, which the scoreboard
  also shows. Not built yet.
- Slot deduction by elimination depends on the scrim board's roster being
  accurate. A team in the wrong slot makes it confidently wrong, so a deduced
  slot always says so in the review message.

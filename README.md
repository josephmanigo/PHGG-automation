# PHGG Discord automation

Discord bot for PHGG scrims: registration boards, announcements, and score
tallying from Bloodstrike endgame screenshots.

    npm install
    npm start          # reads .env / .env.local if present
    npm test
    npm run test:visual # requires the ignored labelled screenshot corpus
    npm run check      # syntax check every module

## /announce

Post a message to any channel as the bot.

    /announce channel:#main-chat message:Scrims at 8PM\nBe on time mention:@Scrim Players image:[attach]

- **channel** — where it goes. Text and announcement channels.
- **message** — what to post. A slash command field cannot hold a real newline,
  so type `\n` where you want a line break.
- **mention** *(optional)* — a role to ping. Only the role you pick can ping:
  an `@everyone` typed into the message text stays inert.
- **image** *(optional)* — attach a picture. It is re-uploaded, so it survives
  even if the original message is deleted.

Restricted to Manage Messages / Manage Server, checked when the command runs and
not only in Discord's UI. The reply is ephemeral; the announcement is the only
public output, and it links back to the posted message.

## Reading scoreboards

When `GEMINI_API_KEY` is configured, screenshots use the same evidence-first
approach as NIGHTRAID's production tally reader:

- ask only for rank, the colored slot letter, and the displayed team total;
- send the untouched screenshot plus a deterministic 1920×1080 enhanced copy;
- require structured JSON and enforce stricter ranges and object shape locally;
- keep unreadable values as `null` instead of converting them to zero;
- define row boxes against the untouched original, then map them through the
  enhanced image's letterbox transform so both crops cover the same pixels;
- enlarge an uncertain row and require two separately processed
  original/enhanced crop reads to agree exactly before recovery;
- require a screenshot to visibly prove the end of the leaderboard, so a clean
  ranks 1–10 crop cannot masquerade as a complete round; and
- read every uploaded screenshot independently, collapsing exact overlaps while
  sending every disagreement on rows linked by rank or slot identity to review.

Exact duplicate attachments are hashed and model-read once. If any screenshot
fails, any required field stays unreadable, the final row is not proven, or two
linked observations conflict, **Confirm & Save is disabled** and the same block
is enforced again server-side. Only PNG, JPG/JPEG, and WEBP attachments are
accepted; downloads are timed and byte-limited, and their actual file signature
must match a supported image.

The local glyph-template reader remains the no-key and provider-failure
fallback. It is fast, free, and exact on the labelled captures used to build
its atlas. Recognition considers the full A–Y alphabet first; the current
registered roster validates the result afterwards and never forces the visual
classifier toward a letter. Because local pixels cannot semantically prove a
scroll reached the bottom, a local result whose highest visible rank is below
the registered-team count is blocked for manual/text submission rather than
treated as complete.

The rule the whole design serves: **it never guesses.** A model confidence value
does not settle a conflict, two repeated low-confidence glyph guesses are not
treated as independent proof, and a roster is never used to invent a missing
slot. A flagged row costs a scorekeeper ten seconds; a wrong row costs a team
its placement.

Useful settings:

    TALLY_VISION_PROVIDER=gemini              # default when a key exists
    GEMINI_VISION_MODEL=gemini-3.6-flash
    TALLY_GEMINI_MIN_CONFIDENCE=0.82
    TALLY_TARGETED_RECOVERY_MAX_TEAMS=8

Set `TALLY_VISION_PROVIDER=local` to force the offline reader. With no Gemini
key, the bot falls back locally automatically.

The previous permissive `OPENAI_API_KEY` screenshot fallback is intentionally
not used by this score path: it accepted free-form team names, guessed absent
slots, and coerced unreadable kills to zero. Provider failure now falls back to
the stricter local reader; adding another cloud provider would require the same
schema, `null`, coverage, recovery-identity, and conflict guarantees.

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
       npm run test:visual
       npm test

   The visual command fails if any expected capture is absent, any row count is
   wrong, or any accepted rank/slot/kill is wrong; an ordinary unit-test pass
   therefore cannot be mistaken for a real-image accuracy run. Calibration
   reports accuracy and coverage separately. **Wrong must stay at zero** —
   coverage going up is good, but never at the cost of a wrong answer.

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
- The local 100% calibration is in-corpus: the same labelled captures are used
  to build the glyph atlas. Keep new Discord-downloaded captures aside as a true
  holdout before using them to rebuild the atlas.
- Gemini behavior cannot be measured offline. The request, validation, recovery,
  and merge contracts are covered with deterministic mocks; a real holdout run
  still requires a configured key and hand-verified screenshots.

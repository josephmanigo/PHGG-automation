/**
 * Scoreboard reader calibration harness.
 *
 *   node scripts/build-glyph-atlas.mjs   # rebuild templates first
 *   node scripts/ocr-calibrate.mjs
 *
 * Reads every capture in test/fixtures/screenshots with the template matcher in
 * src/scrims/tally-glyphs.js and scores rank, slot letter and team kills against
 * the hand-transcribed ground truth. Any change to geometry, thresholds or the
 * atlas can be measured instead of guessed at.
 *
 * ---------------------------------------------------------------------------
 * MEASURED LAYOUT (reference width 1135px; all values scale by width/1135)
 * ---------------------------------------------------------------------------
 * Rows are anchored on the white skull icon at x 90..118, which every row has —
 * medal banners included. This replaced a fixed 92px row pitch: scrolled
 * captures repeat rank 1 as a sticky header that is SHORTER than a normal row,
 * so a uniform pitch drifted by one row and put every value on the wrong team.
 *
 * Relative to the detected skull box for each row:
 *   Slot letter   x skullX0+1,  y centre-56, 32x34, Otsu (glyph is a saturated
 *                 colour; polarity flips between medal banners and plain rows).
 *   Team kills    x skullX1+6,  y centre-13, 44x26, white mask (digits are
 *                 always white, so a bright player card cannot flip polarity).
 *                 The +6 clears the skull's antialiased edge, which otherwise
 *                 segments as a spurious leading digit.
 *   Rank          x 6,          y centre-46, 84x52, Otsu. Ranks 1-3 are medal
 *                 graphics with no readable text; resolveMedalRanks recovers
 *                 them from the first readable rank below.
 *
 * A reported value is only counted when the matcher was confident. Coverage
 * (how many rows it was willing to answer for) is reported separately from
 * accuracy (how many of those answers were right) — for tournament scoring a
 * flagged row costs a scorekeeper ten seconds, a wrong row costs a placement.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Jimp } from 'jimp'
import { readCapture } from '../src/scrims/tally-glyphs.js'
import { ROUNDS } from '../test/fixtures/scoreboard-ground-truth.js'

const SHOT_DIR = path.join(process.cwd(), 'test', 'fixtures', 'screenshots')
const ATLAS = path.join(process.cwd(), 'src', 'scrims', 'glyph-atlas.json')

if (!fs.existsSync(ATLAS)) {
  console.error('No glyph atlas. Run: node scripts/build-glyph-atlas.mjs')
  process.exit(1)
}
const atlas = JSON.parse(fs.readFileSync(ATLAS, 'utf8'))

let total = 0
let rankHits = 0
let slotHits = 0
let killHits = 0
let slotAnswered = 0
let killAnswered = 0
let wrongSlot = 0
let wrongKills = 0
let rowMismatch = 0

for (const round of ROUNDS) {
  for (const capture of round.captures) {
    const file = path.join(SHOT_DIR, capture.file)
    if (!fs.existsSync(file)) {
      console.log(`${capture.file}  MISSING`)
      continue
    }

    const image = await Jimp.read(file)
    const got = readCapture(image.bitmap, atlas)
    const expected = [...(capture.stickyRank1 ? [capture.stickyRank1] : []), ...capture.rows]

    if (got.length !== expected.length) rowMismatch++

    let r = 0
    let s = 0
    let kk = 0
    for (let i = 0; i < expected.length && i < got.length; i++) {
      const g = got[i]
      const e = expected[i]
      if (g.rank === e.rank) r++
      if (g.slotLetter !== null) {
        slotAnswered++
        if (g.slotLetter === e.slotLetter) s++
        else wrongSlot++
      }
      if (g.kills !== null) {
        killAnswered++
        if (g.kills === e.kills) kk++
        else wrongKills++
      }
    }
    rankHits += r
    slotHits += s
    killHits += kk
    total += expected.length

    const flagged = got.filter((g) => !g.certain).length
    console.log(
      `${capture.file}  rows ${got.length}/${expected.length}  rank ${r}  slot ${s}  kills ${kk}  flagged ${flagged}`,
    )
    const line = (g) => `${g.rank ?? '?'}:${g.slotLetter ?? '?'}${g.kills ?? '?'}${g.certain ? '' : '!'}`
    console.log(`   got ${got.map(line).join(' ')}`)
    console.log(`   exp ${expected.map((e) => `${e.rank}:${e.slotLetter}${e.kills}`).join(' ')}`)
  }
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')
console.log(`\nTOTAL rows ${total}   captures with row-count mismatch: ${rowMismatch}`)
console.log(`rank   ${rankHits}/${total} (${pct(rankHits, total)})`)
console.log(`slot   ${slotHits}/${total} correct, answered ${slotAnswered}, WRONG ${wrongSlot} (accuracy when answered ${pct(slotHits, slotAnswered)})`)
console.log(`kills  ${killHits}/${total} correct, answered ${killAnswered}, WRONG ${wrongKills} (accuracy when answered ${pct(killHits, killAnswered)})`)
console.log('\nA wrong answer is the only unacceptable outcome; a flagged row just needs a human glance.')

/**
 * Draft ground truth for newly added screenshots.
 *
 *   node scripts/add-captures.mjs
 *
 * Finds every image in test/fixtures/screenshots that the ground truth does not
 * mention yet, reads it with the current atlas, and prints a ready-to-paste
 * block for test/fixtures/scoreboard-ground-truth.js.
 *
 * The point is to make adding a capture cheap. The reader already gets most
 * cells right, so transcribing by hand from scratch is wasted effort — but a
 * draft it produced is NOT ground truth, because a value it misread would be
 * written down as correct and then taught back to the atlas as a template. That
 * is how a reader poisons itself.
 *
 * So every cell the reader was not confident about comes out as null with a
 * CHECK marker, and the rule for the rest is simple: look at the screenshot and
 * confirm each number before you keep it. Checking a filled-in row against an
 * image is seconds of work; typing 20 rows from scratch is not.
 *
 * Then:
 *   node scripts/build-glyph-atlas.mjs    # learn the new glyphs
 *   node scripts/ocr-calibrate.mjs        # confirm nothing regressed
 *   npm test
 */

import fs from 'node:fs'
import path from 'node:path'
import { Jimp } from 'jimp'
import { readCapture } from '../src/scrims/tally-glyphs.js'
import { ALL_ROUNDS } from '../test/fixtures/scoreboard-ground-truth.js'

const SHOT_DIR = path.join(process.cwd(), 'test', 'fixtures', 'screenshots')
const ATLAS = path.join(process.cwd(), 'src', 'scrims', 'glyph-atlas.json')
const IMAGE = /\.(png|jpe?g|webp)$/i

if (!fs.existsSync(ATLAS)) {
  console.error('No glyph atlas. Run: node scripts/build-glyph-atlas.mjs')
  process.exit(1)
}
const atlas = JSON.parse(fs.readFileSync(ATLAS, 'utf8'))

const known = new Set()
for (const round of ALL_ROUNDS) {
  for (const capture of round.captures) known.add(capture.file)
}

const incoming = fs
  .readdirSync(SHOT_DIR)
  .filter((f) => IMAGE.test(f) && !known.has(f))
  .sort()

if (incoming.length === 0) {
  console.log('No new screenshots. Every image in the fixtures is already in the ground truth.')
  process.exit(0)
}

console.log(`${incoming.length} new capture(s). Draft below — CHECK every value against the image.\n`)

let needsAttention = 0

for (const file of incoming) {
  const image = await Jimp.read(path.join(SHOT_DIR, file))
  const rows = readCapture(image.bitmap, atlas)

  if (rows.length === 0) {
    console.log(`    // ${file}: no team rows found — is this an endgame scoreboard?`)
    needsAttention++
    continue
  }

  // The sticky rank-1 header is repeated at the top of a scrolled capture.
  const sticky = rows.length > 1 && rows[0].rank === 1 && rows[1].rank > 2 ? rows[0] : null
  const body = sticky ? rows.slice(1) : rows

  const lines = []
  lines.push('    {')
  lines.push(`      file: '${file}',`)
  if (sticky) {
    lines.push(
      `      stickyRank1: { rank: 1, slotLetter: '${sticky.slotLetter ?? '?'}', kills: ${sticky.kills ?? 'null'} },`,
    )
  }
  lines.push('      rows: [')
  for (const row of body) {
    const unsure = []
    if (!row.slotLetter) unsure.push('slot')
    if (row.kills === null) unsure.push('kills')
    if (row.rank === null) unsure.push('rank')
    if (unsure.length) needsAttention++

    const slot = row.slotLetter ? `'${row.slotLetter}'` : 'null'
    const note = unsure.length ? `  // CHECK ${unsure.join(' + ')} — read it off the screenshot` : ''
    lines.push(
      `        { rank: ${row.rank ?? 'null'}, slotLetter: ${slot}, kills: ${row.kills ?? 'null'} },${note}`,
    )
  }
  lines.push('      ],')
  lines.push('    },')
  console.log(lines.join('\n'))
}

console.log(
  `\n${needsAttention} cell(s) the reader could not read — those are the ones worth this capture's weight in the atlas.`,
)
console.log('Paste the blocks into a round in test/fixtures/scoreboard-ground-truth.js, then:')
console.log('  node scripts/build-glyph-atlas.mjs && node scripts/ocr-calibrate.mjs && npm test')

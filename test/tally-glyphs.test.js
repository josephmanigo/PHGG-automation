import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Jimp } from 'jimp'
import { readCapture, resolveMedalRanks } from '../src/scrims/tally-glyphs.js'
import { parseScreenshotWithGlyphs } from '../src/scrims/tally-ocr.js'
import atlas from '../src/scrims/glyph-atlas.json' with { type: 'json' }
import { ROUNDS } from './fixtures/scoreboard-ground-truth.js'

const SHOT_DIR = path.join(process.cwd(), 'test', 'fixtures', 'screenshots')
const expectedRows = (capture) => [
  ...(capture.stickyRank1 ? [capture.stickyRank1] : []),
  ...capture.rows,
]

const captures = ROUNDS.flatMap((round) => round.captures).filter((c) =>
  fs.existsSync(path.join(SHOT_DIR, c.file)),
)

// The captures are large binaries and stay out of git (see .gitignore), so a
// fresh clone has nothing to read. Skip rather than fail there — the atlas
// itself IS committed, so production is unaffected.
const needsCaptures = { skip: captures.length === 0 ? 'no fixture screenshots in this clone' : false }

/**
 * The accuracy this whole approach exists for. Tournament scoring cannot use a
 * reader that quietly assigns a team's kills to somebody else, so this asserts
 * the exact ground truth rather than a percentage floor — if a change to the
 * geometry, thresholds or atlas breaks even one cell, this fails.
 */
test('every fixture capture reads exactly, with nothing guessed', needsCaptures, async () => {
  for (const capture of captures) {
    const image = await Jimp.read(path.join(SHOT_DIR, capture.file))
    const got = readCapture(image.bitmap, atlas)
    const expected = expectedRows(capture)

    assert.equal(got.length, expected.length, `${capture.file}: row count`)
    for (let i = 0; i < expected.length; i++) {
      assert.equal(got[i].rank, expected[i].rank, `${capture.file} row ${i}: rank`)
      assert.equal(got[i].slotLetter, expected[i].slotLetter, `${capture.file} row ${i}: slot`)
      assert.equal(got[i].kills, expected[i].kills, `${capture.file} row ${i}: kills`)
      assert.equal(got[i].certain, true, `${capture.file} row ${i}: should be confident`)
    }
  }
})

test('a capture parses end to end into tally entries', needsCaptures, async () => {
  const capture = captures[0]
  const buffer = fs.readFileSync(path.join(SHOT_DIR, capture.file))
  const parsed = await parseScreenshotWithGlyphs({ images: [{ buffer, mimeType: 'image/png' }] })

  assert.equal(parsed.source, 'glyphs')
  assert.deepEqual(parsed.uncertain, [])
  assert.equal(parsed.entries.length, expectedRows(capture).length)

  const first = parsed.entries[0]
  const truth = expectedRows(capture)[0]
  assert.equal(first.rank, truth.rank)
  assert.equal(first.teamQuery, truth.slotLetter)
  assert.equal(first.kills, truth.kills)
  // The slot code is what the sheet keys on: A -> 1-A, Y -> 25-Y.
  assert.match(first.slotCode, /^\d{1,2}-[A-Y]$/)
})

test('overlapping captures merge into one round without duplicate ranks', needsCaptures, async () => {
  const round = ROUNDS.find((r) => r.captures.every((c) => fs.existsSync(path.join(SHOT_DIR, c.file))))
  const images = round.captures.map((c) => ({
    buffer: fs.readFileSync(path.join(SHOT_DIR, c.file)),
    mimeType: 'image/png',
  }))

  const parsed = await parseScreenshotWithGlyphs({ images })
  const ranks = parsed.entries.map((e) => e.rank)
  assert.deepEqual(ranks, [...new Set(ranks)], 'a rank appeared twice')
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'ranks are not ordered')

  // The sticky rank-1 header repeats on every scrolled capture; it must collapse
  // to a single entry rather than three.
  assert.equal(ranks.filter((r) => r === 1).length, 1)
})

/**
 * A phone screenshot arrives at whatever size the device renders, so the reader
 * has to be independent of it. This asserts the guarantee that matters at every
 * size: it may decline to answer, but it must never answer wrongly.
 */
test('reads at any capture size, and never answers wrongly at any of them', needsCaptures, async () => {
  for (const scale of [0.7, 0.95, 1, 1.43, 1.69, 2.5]) {
    let wrong = 0
    let read = 0
    let cells = 0

    for (const capture of captures) {
      const image = await Jimp.read(path.join(SHOT_DIR, capture.file))
      if (scale !== 1) image.scale(scale)
      const got = readCapture(image.bitmap, image.bitmap && atlas)
      const expected = expectedRows(capture)
      assert.equal(got.length, expected.length, `${capture.file} @${scale}x: row count`)

      for (let i = 0; i < expected.length; i++) {
        cells += 2
        for (const field of ['slotLetter', 'kills']) {
          if (got[i][field] === expected[i][field]) read++
          else if (got[i][field] !== null) wrong++
        }
      }
    }

    assert.equal(wrong, 0, `@${scale}x produced ${wrong} wrong cell(s) — must flag, never guess`)
    // Below the reliable scale the reader is expected to decline entirely.
    if (scale >= 1) {
      assert.ok(read / cells > 0.95, `@${scale}x only read ${read}/${cells}`)
    }
  }
})

test('a scrolled capture keeps its sticky header at rank 1 instead of extrapolating', () => {
  const rows = resolveMedalRanks([
    { rank: null, certain: true },
    { rank: 13, certain: true },
    { rank: 14, certain: true },
  ])
  assert.equal(rows[0].rank, 1)
})

test('an unscrolled capture numbers its three medal rows 1, 2, 3', () => {
  const rows = resolveMedalRanks([
    { rank: null, certain: true },
    { rank: null, certain: true },
    { rank: null, certain: true },
    { rank: 4, certain: true },
  ])
  assert.deepEqual(rows.slice(0, 3).map((r) => r.rank), [1, 2, 3])
})

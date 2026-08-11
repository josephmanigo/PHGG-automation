import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Jimp } from 'jimp'
import { readCapture, resolveMedalRanks } from '../src/scrims/tally-glyphs.js'
import { parseScreenshotWithGlyphs, partitionDuplicateSlotEntries } from '../src/scrims/tally-ocr.js'
import atlas from '../src/scrims/glyph-atlas.json' with { type: 'json' }
import {
  ALL_ROUNDS,
  MOBILE_ROUND_A,
  ROUND_A,
  ROUND_C,
  ROUND_D,
  ROUNDS,
  expectedRoundRows,
} from './fixtures/scoreboard-ground-truth.js'

const SHOT_DIR = path.join(process.cwd(), 'test', 'fixtures', 'screenshots')
const expectedRows = (capture) => [
  ...(capture.stickyRank1 ? [capture.stickyRank1] : []),
  ...capture.rows,
]

const captures = ALL_ROUNDS.flatMap((round) => round.captures).filter((c) =>
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
      // Rows cut off by the capture edge have no values to assert against.
      if (expected[i].skip) continue
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
  // Rescaling the 1919px phone captures to 2.5x is slow and adds nothing here;
  // they already cover the large end at their native size.
  const scalable = ROUNDS.flatMap((r) => r.captures).filter((c) =>
    fs.existsSync(path.join(SHOT_DIR, c.file)),
  )

  for (const scale of [0.7, 0.95, 1, 1.43, 1.69, 2.5]) {
    let wrong = 0
    let read = 0
    let cells = 0

    for (const capture of scalable) {
      const image = await Jimp.read(path.join(SHOT_DIR, capture.file))
      if (scale !== 1) image.scale(scale)
      const got = readCapture(image.bitmap, atlas)
      const expected = expectedRows(capture)
      assert.equal(got.length, expected.length, `${capture.file} @${scale}x: row count`)

      for (let i = 0; i < expected.length; i++) {
        if (expected[i].skip) continue
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

test('systematic 0.96x overlap errors are flagged instead of corroborated into scores', needsCaptures, async () => {
  const files = ROUND_D.captures.map((capture) => path.join(SHOT_DIR, capture.file))
  if (!files.every((file) => fs.existsSync(file))) return

  const images = []
  for (const file of files) {
    const image = await Jimp.read(file)
    image.scale(0.96)
    images.push({ buffer: await image.getBuffer('image/png'), mimeType: 'image/png' })
  }
  const parsed = await parseScreenshotWithGlyphs({ images })
  const truth = new Map(expectedRoundRows(ROUND_D).map((row) => [row.rank, row]))

  for (const entry of parsed.entries) {
    assert.equal(entry.teamQuery, truth.get(entry.rank)?.slotLetter, `rank ${entry.rank}: wrong slot accepted`)
    assert.equal(entry.kills, truth.get(entry.rank)?.kills, `rank ${entry.rank}: wrong kills accepted`)
  }
  assert.equal(parsed.entries.some((entry) => entry.rank === 15 && entry.kills === 18), false)
  const acceptedRank15 = parsed.entries.find((entry) => entry.rank === 15)
  assert.ok(
    (acceptedRank15?.teamQuery === truth.get(15).slotLetter && acceptedRank15?.kills === truth.get(15).kills)
      || parsed.uncertain.some((row) => row.rank === 15 || row.rank === null)
      || parsed.missingRanks.includes(15),
    'rank 15 must be exactly correct or make the extraction explicitly incomplete',
  )
})

test('a clean top-only local capture is incomplete against the registered roster', needsCaptures, async () => {
  const capture = ROUND_A.captures[0]
  const file = path.join(SHOT_DIR, capture.file)
  if (!fs.existsSync(file)) return
  const allowedLetters = [...new Set(expectedRoundRows(ROUND_A).map((row) => row.slotLetter))]
  const parsed = await parseScreenshotWithGlyphs({
    images: [{ buffer: fs.readFileSync(file), mimeType: 'image/png' }],
    allowedLetters,
  })

  assert.deepEqual(parsed.entries.map((entry) => entry.rank), Array.from({ length: 10 }, (_v, i) => i + 1))
  assert.equal(
    parsed.uncertain.some((row) => row.reason === 'leaderboard_end_not_visible'),
    true,
  )
})

/**
 * The real phone round that exposed all of this: five 1919x1079 JPEGs, scrolled
 * so they overlap and each repeats rank 1. Every placement from 1 to 19 must
 * come out exactly once, with nothing dropped and nothing guessed — placements
 * 2 to 5 previously vanished with no message at all.
 */
test('a full phone round reads every placement with none dropped', needsCaptures, async () => {
  const files = MOBILE_ROUND_A.captures.map((c) => path.join(SHOT_DIR, c.file))
  if (!files.every((f) => fs.existsSync(f))) return

  const images = files.map((f) => ({ buffer: fs.readFileSync(f), mimeType: 'image/jpeg' }))
  const parsed = await parseScreenshotWithGlyphs({ images })

  assert.deepEqual(parsed.uncertain, [], 'no row should be left unread')
  assert.deepEqual(parsed.missingRanks, [], 'no placement should be missing')
  assert.deepEqual(
    parsed.entries.map((e) => e.rank),
    Array.from({ length: 19 }, (_, i) => i + 1),
    'placements 1..19 must each appear exactly once',
  )

  // Slots P, R and S appear only in this round and had no template until it was
  // added; P was being confidently misread as F.
  const bySlot = new Map(parsed.entries.map((e) => [e.rank, e.teamQuery]))
  assert.equal(bySlot.get(2), 'R')
  assert.equal(bySlot.get(17), 'S')
  assert.equal(bySlot.get(18), 'P')
})

/**
 * The roster validates a visually read slot after classification. It must not
 * narrow the classifier or change a row the reader already read correctly.
 */
test('the roster never alters a slot the reader read on its own', needsCaptures, async () => {
  const files = MOBILE_ROUND_A.captures.map((c) => path.join(SHOT_DIR, c.file))
  if (!files.every((f) => fs.existsSync(f))) return
  const images = files.map((f) => ({ buffer: fs.readFileSync(f), mimeType: 'image/jpeg' }))

  const truth = new Map()
  for (const capture of MOBILE_ROUND_A.captures) {
    for (const row of capture.rows) if (!row.skip) truth.set(row.rank, row.slotLetter)
  }

  const withoutRoster = await parseScreenshotWithGlyphs({ images })
  const withRoster = await parseScreenshotWithGlyphs({ images, allowedLetters: [...truth.values()] })

  assert.equal(withRoster.entries.length, withoutRoster.entries.length)
  for (const entry of withRoster.entries) {
    assert.equal(entry.teamQuery, truth.get(entry.rank), `rank ${entry.rank}`)
  }
  // Nothing needed eliminating here — every slot was read outright.
  assert.equal(withRoster.entries.filter((e) => e.deduced).length, 0)
})

test('two rows claiming one slot are both pulled rather than scored', () => {
  const partitioned = partitionDuplicateSlotEntries([
    { rank: 1, teamQuery: 'A', kills: 44 },
    { rank: 2, teamQuery: 'B', kills: 20 },
    { rank: 3, teamQuery: 'B', kills: 19 },
    { rank: 4, teamQuery: 'C', kills: 10 },
  ])

  assert.deepEqual(partitioned.entries.map((entry) => entry.teamQuery), ['A', 'C'])
  assert.deepEqual(partitioned.uncertain.map((entry) => entry.rank), [2, 3])
  assert.ok(partitioned.uncertain.every((entry) => entry.reason === 'duplicate_teamCode'))
})

/**
 * How a scrolled round is meant to divide up: each capture contributes the
 * placings it shows in full, a placing repeated in the next capture is not read
 * twice, and a row clipped by the screen edge is left to the capture that shows
 * it whole. Getting this wrong is what made placings go missing.
 */
test('each capture contributes only the placings it shows in full', needsCaptures, async () => {
  const cases = [
    { round: MOBILE_ROUND_A, maxSlots: 20, mime: 'image/jpeg' },
    { round: ROUND_C, maxSlots: 25, mime: 'image/png' },
  ]

  for (const { round, maxSlots, mime } of cases) {
    const files = round.captures.map((c) => path.join(SHOT_DIR, c.file))
    if (!files.every((f) => fs.existsSync(f))) continue

    for (const capture of round.captures) {
      const image = await Jimp.read(path.join(SHOT_DIR, capture.file))
      const rows = readCapture(image.bitmap, atlas, { maxSlots })
      const expected = expectedRows(capture)

      for (let i = 0; i < expected.length && i < rows.length; i++) {
        // Rows the ground truth marks as cut off must never be read as usable.
        if (expected[i].skip) {
          assert.equal(rows[i].certain, false, `${capture.file}: clipped row was read anyway`)
        }
      }
    }

    const images = files.map((f) => ({ buffer: fs.readFileSync(f), mimeType: mime }))
    const parsed = await parseScreenshotWithGlyphs({ images, maxSlots })
    const ranks = parsed.entries.map((e) => e.rank)

    assert.equal(new Set(ranks).size, ranks.length, `${round.label}: a placing was read twice`)
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${round.label}: out of order`)
    assert.deepEqual(parsed.missingRanks, [], `${round.label}: a placing was missed`)
    assert.deepEqual(parsed.uncertain, [], `${round.label}: a placing was left unread`)
    // Contiguous from 1 to the last team, with no holes.
    assert.deepEqual(ranks, Array.from({ length: ranks.length }, (_, i) => i + 1))
    assert.ok(ranks.length <= maxSlots, `${round.label}: more placings than slots`)
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

/**
 * A capture where no rank was readable used to leave every row rankless, and
 * rankless rows were skipped without a word — so a whole screenshot could
 * contribute nothing and the only clue was a gap in the placements.
 */
test('a capture with no readable rank still returns its rows to be reported', () => {
  const rows = resolveMedalRanks([
    { rank: null, certain: true },
    { rank: null, certain: true },
    { rank: null, certain: true },
  ])
  assert.equal(rows.length, 3, 'rows must not be discarded')
})

test('a rank the matcher missed is recovered from the rows around it', () => {
  const rows = resolveMedalRanks([
    { rank: 4, certain: true },
    { rank: null, certain: true },
    { rank: 6, certain: true },
  ])
  assert.equal(rows[1].rank, 5)
  assert.equal(rows[1].certain, true)
})

test('a rank is only inferred when both neighbours agree', () => {
  // 4 then 9 with one row between: the neighbours imply 5 and 8, so the row
  // cannot be placed and must be flagged rather than guessed at.
  const rows = resolveMedalRanks([
    { rank: 4, certain: true },
    { rank: null, certain: true },
    { rank: 9, certain: true },
  ])
  assert.equal(rows[1].rank, null)
  assert.equal(rows[1].certain, false)
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

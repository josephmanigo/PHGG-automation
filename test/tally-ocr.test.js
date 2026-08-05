import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SLOT_LETTERS,
  slotCodeFromLetter,
  flattenWords,
  groupWordsIntoRows,
  parseStripRow,
  inferMissingRanks,
  mergeCaptureRows,
} from '../src/scrims/tally-ocr.js'
import { findMatchingTeam } from '../src/scrims/tally-core.js'
import { ROUND_A, expectedRoundRows } from './fixtures/scoreboard-ground-truth.js'

// A strip row as OCR would hand it back: tokens left to right.
const strip = (yCenter, tokens) => ({
  yCenter,
  words: tokens.map(([text, x], i) => ({ text, x, yCenter, confidence: 90 - i })),
})

test('slot letters map onto scoresheet slot codes', () => {
  assert.equal(SLOT_LETTERS.length, 25)
  assert.equal(slotCodeFromLetter('A'), '1-A')
  assert.equal(slotCodeFromLetter('I'), '9-I')
  assert.equal(slotCodeFromLetter('Y'), '25-Y')
  assert.equal(slotCodeFromLetter('Z'), null) // only A..Y exist
  assert.equal(slotCodeFromLetter(''), null)
})

test('kills come from the team total, not a player cell', () => {
  // "#4  L  38" — the 12/8/4/14 to the right are per-player and never reach here
  // because only the left strip is cropped.
  const parsed = parseStripRow(strip(315, [['#4', 30], ['L', 152], ['38', 118]]))
  assert.equal(parsed.rank, 4)
  assert.equal(parsed.slotLetter, 'L')
  assert.equal(parsed.kills, 38)
})

test('position decides meaning, so slot I is not read as rank 1', () => {
  // Rank 3, slot I, 14 kills. A pattern match would fight over "I" vs "1".
  const parsed = parseStripRow(strip(222, [['3', 30], ['I', 152], ['14', 118]]))
  assert.equal(parsed.rank, 3)
  assert.equal(parsed.slotLetter, 'I')
  assert.equal(parsed.kills, 14)
})

test('a zero-kill team is still a real row', () => {
  const parsed = parseStripRow(strip(880, [['#19', 30], ['Q', 152], ['0', 118]]))
  assert.deepEqual(
    { rank: parsed.rank, slotLetter: parsed.slotLetter, kills: parsed.kills },
    { rank: 19, slotLetter: 'Q', kills: 0 },
  )
})

test('rows without a slot letter or kills are discarded', () => {
  assert.equal(parseStripRow(strip(10, [])), null)
  assert.equal(parseStripRow(strip(10, [['#4', 30]])), null)          // no letter
  assert.equal(parseStripRow(strip(10, [['#4', 30], ['L', 152]])), null) // no kills
})

test('medal ranks 1-3 are recovered from row order', () => {
  // The badges for 1/2/3 are graphics, so OCR returns no rank for them.
  const rows = [
    { rank: null, slotLetter: 'A', kills: 58, confidence: 80, yCenter: 38 },
    { rank: null, slotLetter: 'O', kills: 12, confidence: 80, yCenter: 130 },
    { rank: null, slotLetter: 'I', kills: 14, confidence: 80, yCenter: 222 },
    { rank: 4, slotLetter: 'L', kills: 38, confidence: 80, yCenter: 315 },
  ]
  const filled = inferMissingRanks(rows)
  assert.deepEqual(filled.map((r) => r.rank), [1, 2, 3, 4])
  assert.deepEqual(filled.map((r) => r.slotLetter), ['A', 'O', 'I', 'L'])
})

test('overlapping captures and the sticky rank-1 header collapse to one row each', () => {
  // Every scrolled capture repeats rank 1, and captures 2 and 3 share rows.
  const merged = mergeCaptureRows([
    { rank: 1, slotLetter: 'A', kills: 58, confidence: 90 },
    { rank: 13, slotLetter: 'N', kills: 24, confidence: 70 },
    { rank: 1, slotLetter: 'A', kills: 58, confidence: 95 }, // sticky header again
    { rank: 13, slotLetter: 'N', kills: 24, confidence: 88 },
    { rank: 20, slotLetter: 'W', kills: 1, confidence: 91 },
  ])

  assert.equal(merged.length, 3)
  assert.deepEqual(merged.map((e) => e.rank), [1, 13, 20])
  assert.deepEqual(merged[0], { rank: 1, slotCode: '1-A', teamQuery: 'A', kills: 58 })
  assert.equal(merged[2].slotCode, '23-W')
})

test('the whole of round A merges to 21 unique slots with correct kills', () => {
  const rows = ROUND_A.captures.flatMap((c) => [
    ...(c.stickyRank1 ? [{ ...c.stickyRank1, confidence: 80 }] : []),
    ...c.rows.map((r) => ({ ...r, confidence: 80 })),
  ])
  const merged = mergeCaptureRows(rows)
  const expected = expectedRoundRows(ROUND_A)

  assert.equal(merged.length, 21)
  assert.equal(merged.length, expected.length)
  assert.deepEqual(merged.map((e) => e.rank), expected.map((e) => e.rank))
  assert.deepEqual(merged.map((e) => e.kills), expected.map((e) => e.kills))
  // No slot may appear twice.
  assert.equal(new Set(merged.map((e) => e.slotCode)).size, merged.length)
})

test('the emitted slot code matches a registered team by slot', () => {
  const roster = [
    { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID ESPORTS' },
    { slotIndex: 11, slotCode: '12L', slotLetter: 'L', tag: 'RA', name: 'BLAZE' },
  ]
  const merged = mergeCaptureRows([{ rank: 4, slotLetter: 'L', kills: 38, confidence: 80 }])
  // findMatchingTeam is given the slot code as the explicit slot hint.
  assert.equal(findMatchingTeam(merged[0].teamQuery, roster, merged[0].slotCode)?.tag, 'RA')
})

test('groupWordsIntoRows separates rows and orders each left to right', () => {
  const rows = groupWordsIntoRows(
    [
      { text: '38', x: 118, yCenter: 316, confidence: 80 },
      { text: '#4', x: 30, yCenter: 315, confidence: 80 },
      { text: 'L', x: 152, yCenter: 312, confidence: 80 },
      { text: '#5', x: 30, yCenter: 407, confidence: 80 },
      { text: 'T', x: 152, yCenter: 405, confidence: 80 },
      { text: '3', x: 118, yCenter: 408, confidence: 80 },
    ],
    30,
  )
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].words.map((w) => w.text), ['#4', '38', 'L'])
  assert.deepEqual(rows[1].words.map((w) => w.text), ['#5', '3', 'T'])
})

test('flattenWords walks the v7 block tree', () => {
  const words = flattenWords({
    blocks: [{ paragraphs: [{ lines: [{ words: [
      { text: '#4', confidence: 90, bbox: { x0: 30, y0: 300, y1: 330 } },
      { text: 'L', confidence: 70, bbox: { x0: 152, y0: 300, y1: 330 } },
    ] }] }] }],
  })
  assert.equal(words.length, 2)
  assert.equal(words[0].yCenter, 315)
  assert.equal(words[1].x, 152)
  assert.deepEqual(flattenWords({}), [])
})

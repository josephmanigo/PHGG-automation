import test from 'node:test'
import assert from 'node:assert/strict'
import {
  flattenLines,
  parseScoreboardLine,
  selectScoreboardEntries,
} from '../src/scrims/tally-ocr.js'
import { findMatchingTeam } from '../src/scrims/tally-core.js'

test('reads rank, team and kills off a scoreboard line', () => {
  assert.deepEqual(parseScoreboardLine('1 NIGHTRAID ESPORTS 12'), {
    rank: 1,
    teamQuery: 'NIGHTRAID ESPORTS',
    slotCode: '',
    kills: 12,
  })
  // Leading "#" and pipe separators are common in these layouts.
  assert.deepEqual(parseScoreboardLine('#4 | RA BLAZE | 38'), {
    rank: 4,
    teamQuery: 'RA BLAZE',
    slotCode: '',
    kills: 38,
  })
})

test('kills come from the last column, not DAMAGE or SCORE', () => {
  // rank, team, damage, score, kills — the big numbers must not win.
  const parsed = parseScoreboardLine('2 RAMPAGE SENTINELS 4820 137 8')
  assert.equal(parsed.kills, 8)
  assert.equal(parsed.rank, 2)
  assert.equal(parsed.teamQuery, 'RAMPAGE SENTINELS')

  // ...and the column is re-pointable once real screenshots are measured.
  assert.equal(
    parseScoreboardLine('5 SG SEEK GREATNESS 49 1200', { killsColumn: 'first' }).kills,
    49,
  )

  // A 4-digit DAMAGE column must not be absorbed into the team name.
  assert.equal(parseScoreboardLine('2 RAMPAGE SENTINELS 4820 137 8').teamQuery, 'RAMPAGE SENTINELS')
})

test('rejects rows that are not teams', () => {
  assert.equal(parseScoreboardLine(''), null)
  assert.equal(parseScoreboardLine('MATCH RESULTS'), null)      // no leading rank
  assert.equal(parseScoreboardLine('99 SOMETHING 5'), null)     // rank out of range
  assert.equal(parseScoreboardLine('3 SYNDICATE'), null)        // no kills column
  assert.equal(parseScoreboardLine('1 12'), null)               // no team name
})

test('duplicate ranks collapse to the highest-confidence read', () => {
  const entries = selectScoreboardEntries([
    { text: '1 NIGHTRAD ESPORTS 12', confidence: 40 },
    { text: '1 NIGHTRAID ESPORTS 12', confidence: 91 },
    { text: '2 RAMPAGE SENTINELS 8', confidence: 88 },
    { text: 'PH GAMING GUILD', confidence: 95 },
  ])

  assert.equal(entries.length, 2)
  assert.equal(entries[0].teamQuery, 'NIGHTRAID ESPORTS')
  assert.equal(entries[1].rank, 2)
  // Confidence is an internal ranking signal, not part of the entry contract.
  assert.ok(!('confidence' in entries[0]))
})

test('imperfect OCR still snaps onto the registered roster', () => {
  const roster = [
    { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID ESPORTS' },
    { slotIndex: 1, slotCode: '02B', slotLetter: 'B', tag: 'SS', name: 'RAMPAGE SENTINELS' },
  ]
  // This is why OCR is viable here: the name only has to be close.
  assert.equal(findMatchingTeam('NIGHTRAlD ESPORTS', roster)?.tag, 'NR')
  assert.equal(findMatchingTeam('RAMPAGE SENTINELS', roster)?.tag, 'SS')
})

test('flattenLines walks the v7 block tree and falls back to flat text', () => {
  const data = {
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              {
                words: [
                  { text: '1', confidence: 90, bbox: { x0: 10 } },
                  { text: 'NIGHTRAID', confidence: 80, bbox: { x0: 50 } },
                  { text: '12', confidence: 70, bbox: { x0: 300 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
  const lines = flattenLines(data)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].text, '1 NIGHTRAID 12')
  assert.equal(lines[0].confidence, 80) // mean of 90/80/70

  // Older/leaner outputs expose only `text`.
  const fallback = flattenLines({ text: '1 NIGHTRAID 12\n\n2 RAMPAGE 8', confidence: 77 })
  assert.equal(fallback.length, 2)
  assert.equal(fallback[1].text, '2 RAMPAGE 8')
})

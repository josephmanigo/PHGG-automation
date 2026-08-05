import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findMatchingTeam,
  getPlacementPoints,
  TallyBoard,
} from '../src/scrims/tally-core.js'
import { parseTextScoreInput } from '../src/scrims/tally-vision.js'
import {
  ROUND_COLUMNS,
  SCORE_START_ROW,
  SCORE_END_ROW,
  buildClearRanges,
  buildPlacementFormulaRestore,
  buildRankHighlightFormula,
  placementPointsFormula,
} from '../src/scrims/tally-sheet.js'

const mockRegisteredTeams = [
  { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID' },
  { slotIndex: 1, slotCode: '02B', slotLetter: 'B', tag: 'SS', name: 'RAMPAGE SENTINELS' },
  { slotIndex: 2, slotCode: '03C', slotLetter: 'C', tag: 'APXS', name: 'SYNDICATE' },
  { slotIndex: 3, slotCode: '04D', slotLetter: 'D', tag: 'M7', name: 'M7 ESPORTS' },
]

test('getPlacementPoints returns expected points for ranks', () => {
  assert.equal(getPlacementPoints(1), 20)
  assert.equal(getPlacementPoints(2), 16)
  assert.equal(getPlacementPoints(3), 13)
  assert.equal(getPlacementPoints(4), 10)
  assert.equal(getPlacementPoints(5), 8)
  assert.equal(getPlacementPoints(6), 5)
  assert.equal(getPlacementPoints(10), 5)
  assert.equal(getPlacementPoints(11), 2)
  assert.equal(getPlacementPoints(15), 2)
  assert.equal(getPlacementPoints(16), 1)
  assert.equal(getPlacementPoints(18), 1)
  assert.equal(getPlacementPoints(19), 0)
  assert.equal(getPlacementPoints(25), 0)
  assert.equal(getPlacementPoints(99), 0)
})

test('findMatchingTeam matches by slot, tag, or name', () => {
  assert.equal(findMatchingTeam('01A', mockRegisteredTeams)?.tag, 'NR')
  assert.equal(findMatchingTeam('A', mockRegisteredTeams)?.tag, 'NR')
  assert.equal(findMatchingTeam('NR', mockRegisteredTeams)?.tag, 'NR')
  assert.equal(findMatchingTeam('NIGHTRAID', mockRegisteredTeams)?.tag, 'NR')
  assert.equal(findMatchingTeam('RAMPAGE', mockRegisteredTeams)?.tag, 'SS')
  assert.equal(findMatchingTeam('APXS', mockRegisteredTeams)?.tag, 'APXS')
})

test('TallyBoard computes overall standings across multiple rounds', () => {
  const board = new TallyBoard()

  // Round 1
  board.setRound(
    1,
    [
      { rank: 1, teamQuery: 'NR', kills: 10 }, // 20 + 10 = 30
      { rank: 2, teamQuery: 'SS', kills: 5 },  // 16 + 5 = 21
      { rank: 3, teamQuery: 'APXS', kills: 3 },// 13 + 3 = 16
    ],
    mockRegisteredTeams,
  )

  // Round 2
  board.setRound(
    2,
    [
      { rank: 1, teamQuery: 'SS', kills: 12 }, // 20 + 12 = 32. Total SS: 21 + 32 = 53
      { rank: 2, teamQuery: 'NR', kills: 4 },  // 16 + 4 = 20. Total NR: 30 + 20 = 50
      { rank: 3, teamQuery: 'APXS', kills: 2 },// 13 + 2 = 15. Total APXS: 16 + 15 = 31
    ],
    mockRegisteredTeams,
  )

  const standings = board.getOverallStandings(mockRegisteredTeams)
  assert.equal(standings.length, 4)
  assert.equal(standings[0].tag, 'SS')
  assert.equal(standings[0].totalPoints, 53)
  assert.equal(standings[0].totalKills, 17)

  assert.equal(standings[1].tag, 'NR')
  assert.equal(standings[1].totalPoints, 50)
  assert.equal(standings[1].totalKills, 14)

  assert.equal(standings[2].tag, 'APXS')
  assert.equal(standings[2].totalPoints, 31)
  assert.equal(standings[2].totalKills, 5)
})

test('TallyBoard supports correctScore manual adjustments', () => {
  const board = new TallyBoard()

  board.setRound(
    1,
    [
      { rank: 1, teamQuery: 'NR', kills: 10 },
      { rank: 2, teamQuery: 'SS', kills: 5 },
    ],
    mockRegisteredTeams,
  )

  // Correct SS kills from 5 to 15
  board.correctScore(1, 'SS', 2, 15, mockRegisteredTeams)

  const standings = board.getOverallStandings(mockRegisteredTeams)
  const ss = standings.find((t) => t.tag === 'SS')
  assert.equal(ss.totalKills, 15)
  assert.equal(ss.totalPoints, 16 + 15) // 31
})

test('parseTextScoreInput parses structured text score formats', () => {
  const sampleInput = `
ROUND 1
1. NR - NIGHTRAID | 12 KILLS
#2 SS - RAMPAGE - 8 KILLS
3. APXS 5 KILLS
`
  const result = parseTextScoreInput(sampleInput)
  assert.equal(result.roundNumber, 1)
  assert.equal(result.entries.length, 3)
  assert.equal(result.entries[0].rank, 1)
  assert.equal(result.entries[0].teamQuery, 'NR - NIGHTRAID')
  assert.equal(result.entries[0].kills, 12)
  assert.equal(result.entries[1].rank, 2)
  assert.equal(result.entries[1].kills, 8)
  assert.equal(result.entries[2].rank, 3)
  assert.equal(result.entries[2].kills, 5)
})

test('rank highlight reads the RANK column, not the penalties table', () => {
  const formula = buildRankHighlightFormula()

  // AA is the RANK column (=RANK(Z8,$Z$8:$Z$32,0)).
  assert.match(formula, /\$AA8<=3/)
  assert.match(formula, /ISNUMBER\(\$AA8\)/)

  // The old rule matched $AB/$AC/$AD, which hold the penalties table's slot
  // numbers 1..25 — so it always painted rows 8, 9 and 10 regardless of rank.
  assert.doesNotMatch(formula, /\$AB8/)
  assert.doesNotMatch(formula, /\$AC8/)
  assert.doesNotMatch(formula, /\$AD8/)

  // A blank sheet ranks every row 1 (all scores are 0), so the rule also
  // requires a team name and a positive final score.
  assert.match(formula, /\$J8<>""/)
  assert.match(formula, /\$Z8>0/)

  // Marker so repeat syncs replace this rule instead of stacking duplicates.
  assert.match(formula, /PHGG_RANK_TOP3/)
})

test('placement points stay a live VLOOKUP and never yield #N/A', () => {
  assert.equal(
    placementPointsFormula('K', 8),
    '=IF(K8="","",IFERROR(VLOOKUP(K8,$B$8:$C$32,2,0),"X"))',
  )
  assert.equal(
    placementPointsFormula('T', 32),
    '=IF(T32="","",IFERROR(VLOOKUP(T32,$B$8:$C$32,2,0),"X"))',
  )

  // A bare VLOOKUP returns #N/A for an unplayed round, and X=SUM(...) turns
  // that into #N/A for TOTAL, FINAL SCORE and RANK alike — which is what left
  // the sheet with no ranking to highlight.
  for (const round of [1, 2, 3, 4]) {
    const { place } = ROUND_COLUMNS[round]
    assert.match(placementPointsFormula(place, 8), /^=IF\(/)
  }
})

test('clear wipes scrim data but leaves the sheet template intact', () => {
  const ranges = buildClearRanges('SHEET').join(' ')

  // Team names, every round, penalties and the bot-written header lines.
  assert.match(ranges, /'SHEET'!J8:J32/)
  assert.match(ranges, /'SHEET'!K8:V32/)
  assert.match(ranges, /'SHEET'!Y8:Y32/)
  assert.match(ranges, /'SHEET'!AD8:AG32/)
  assert.match(ranges, /'SHEET'!H3/)
  assert.match(ranges, /'SHEET'!H5/)

  // Columns the sheet computes for itself must survive a clear.
  assert.doesNotMatch(ranges, /!X\d/) // TOTAL POINTS EARNED
  assert.doesNotMatch(ranges, /!Z\d/) // FINAL SCORE
  assert.doesNotMatch(ranges, /!AA\d/) // RANK
  assert.doesNotMatch(ranges, /!B\d/) // B8:C32 points lookup table
  assert.doesNotMatch(ranges, /!AC\d/) // penalties slot numbering (template)
})

test('clear puts the placement-points formulas back after wiping K:V', () => {
  const restore = buildPlacementFormulaRestore('SHEET')
  const rowCount = SCORE_END_ROW - SCORE_START_ROW + 1

  assert.equal(restore.length, 4) // one column per round
  assert.equal(rowCount, 25)

  for (const round of [1, 2, 3, 4]) {
    const { place, placementPoints } = ROUND_COLUMNS[round]
    const block = restore.find((d) => d.range.includes(`!${placementPoints}${SCORE_START_ROW}:`))
    assert.ok(block, `round ${round} placement column missing`)
    assert.equal(block.values.length, rowCount)
    assert.equal(block.values[0][0], `=IF(${place}8="","",IFERROR(VLOOKUP(${place}8,$B$8:$C$32,2,0),"X"))`)
    assert.equal(
      block.values[rowCount - 1][0],
      `=IF(${place}32="","",IFERROR(VLOOKUP(${place}32,$B$8:$C$32,2,0),"X"))`,
    )
  }
})

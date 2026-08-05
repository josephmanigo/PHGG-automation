import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findMatchingTeam,
  getPlacementPoints,
  TallyBoard,
  findUnmatchedEntries,
} from '../src/scrims/tally-core.js'
import { parseTextScoreInput } from '../src/scrims/tally-vision.js'
import {
  ROUND_COLUMNS,
  SCORE_START_ROW,
  SCORE_END_ROW,
  buildClearRanges,
  buildTemplateRestore,
  buildRankHighlightFormula,
  placementPointsFormula,
  defaultPlacementPointsFormula,
  formatSheetTeamName,
  renderTitleBanner,
  slotIndexFromCode,
  TITLE_BANNER_TEMPLATE,
  DATE_HEADER_TEMPLATE,
} from '../src/scrims/tally-sheet.js'
import { formatAccuracyNotices, buildReviewMessage } from '../src/scrims/tally-automation.js'

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
  // M7 ESPORTS is registered but appeared in neither round, so it is not on
  // the board. The other three played.
  assert.equal(standings.length, 3)
  assert.ok(!standings.some((s) => s.tag === 'M7'))
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

test('a running scrim shows X for no score, never #N/A', () => {
  assert.equal(
    placementPointsFormula('K', 8),
    '=IF(K8="","",IFERROR(VLOOKUP(K8,$B$8:$C$32,2,0),"X"))',
  )
  assert.equal(
    placementPointsFormula('T', 32),
    '=IF(T32="","",IFERROR(VLOOKUP(T32,$B$8:$C$32,2,0),"X"))',
  )

  // Every round must be error-free, or SUM turns TOTAL / FINAL SCORE / RANK
  // into #N/A and there is no ranking left to highlight.
  for (const round of [1, 2, 3, 4]) {
    const { place } = ROUND_COLUMNS[round]
    const formula = placementPointsFormula(place, 8)
    assert.match(formula, /IFERROR/)
    assert.match(formula, /"X"/)
  }
})

test('the default sheet keeps the plain template formula, #N/A and all', () => {
  // /clear restores this, so a cleared sheet matches the untouched default.
  assert.equal(defaultPlacementPointsFormula('K', 8), '=VLOOKUP(K8,$B$8:$C$32,2,0)')
  assert.equal(defaultPlacementPointsFormula('U', 32), '=VLOOKUP(U32,$B$8:$C$32,2,0)')
  assert.doesNotMatch(defaultPlacementPointsFormula('K', 8), /IFERROR/)
  assert.doesNotMatch(defaultPlacementPointsFormula('K', 8), /"X"/)
})

test('slot codes resolve to the right row, and junk resolves to nothing', () => {
  assert.equal(slotIndexFromCode('1-A'), 0)
  assert.equal(slotIndexFromCode('01A'), 0)
  assert.equal(slotIndexFromCode('A'), 0)
  assert.equal(slotIndexFromCode('25-Y'), 24)
  assert.equal(slotIndexFromCode('13M'), 12)

  // Unusable codes must not land on an arbitrary row.
  assert.equal(slotIndexFromCode('??'), -1)
  assert.equal(slotIndexFromCode(''), -1)
  assert.equal(slotIndexFromCode(undefined), -1)
  // Number and letter disagreeing means the read is untrustworthy.
  assert.equal(slotIndexFromCode('1-B'), -1)
  assert.equal(slotIndexFromCode('25-A'), -1)
})

test('accuracy notices name what was deliberately not scored', () => {
  const notices = formatAccuracyNotices({
    registeredNotInScreenshot: ['3-C APXS • SYNDICATE'],
    unmatchedScreenshotEntries: ['SOME RANDOM TEAM'],
  })

  assert.equal(notices.length, 2)
  assert.match(notices[0], /Left blank/)
  assert.match(notices[0], /APXS • SYNDICATE/)
  assert.match(notices[1], /Skipped/)
  assert.match(notices[1], /SOME RANDOM TEAM/)

  // A clean round says nothing at all.
  assert.deepEqual(formatAccuracyNotices({}), [])
  assert.deepEqual(
    formatAccuracyNotices({ registeredNotInScreenshot: [], unmatchedScreenshotEntries: [] }),
    [],
  )
})

test('unregistered screenshot teams are discarded, not scored', () => {
  const board = new TallyBoard()
  const entries = board.setRound(
    1,
    [
      { rank: 1, teamQuery: 'NR', kills: 10 },
      { rank: 2, teamQuery: 'TOTALLY UNKNOWN CLAN', kills: 30 },
    ],
    mockRegisteredTeams,
  )

  assert.equal(entries.length, 1)
  assert.equal(entries[0].tag, 'NR')
  assert.ok(!entries.some((e) => e.kills === 30))
})

test('the visible title banner resolves the [DEVICE] placeholder', () => {
  assert.equal(
    renderTitleBanner('PC'),
    'PH GAMING GUILD  -  OPERATION :  DOMINATION\nBLOODSTRIKE SCRIMMAGE • PC',
  )
  assert.equal(
    renderTitleBanner('mobile'),
    'PH GAMING GUILD  -  OPERATION :  DOMINATION\nBLOODSTRIKE SCRIMMAGE • MOBILE',
  )
  // The guild line must survive — only the device token is substituted.
  assert.match(renderTitleBanner('PC'), /PH GAMING GUILD/)
  assert.doesNotMatch(renderTitleBanner('PC'), /\[DEVICE\]/)
  // ...and the template keeps the placeholder so /clear can put it back.
  assert.match(TITLE_BANNER_TEMPLATE, /\[DEVICE\]/)
})

test('team names are written in the sheet\'s "TAG • NAME" form', () => {
  assert.equal(
    formatSheetTeamName({ tag: 'NR', name: 'NIGHTRAID ESPORTS' }),
    'NR • NIGHTRAID ESPORTS',
  )
  // No tag, or no name, must not leave a dangling separator.
  assert.equal(formatSheetTeamName({ tag: '', name: 'NEMESIS' }), 'NEMESIS')
  assert.equal(formatSheetTeamName({ tag: 'SVE', name: '' }), 'SVE')
  assert.equal(formatSheetTeamName({}), '')
})

test('clear wipes scrim data but leaves the sheet template intact', () => {
  const ranges = buildClearRanges('SHEET').join(' ')

  // Team names, every round, penalties, and H3 (blank in the template).
  assert.match(ranges, /'SHEET'!J8:J32/)
  assert.match(ranges, /'SHEET'!K8:V32/)
  assert.match(ranges, /'SHEET'!Y8:Y32/)
  assert.match(ranges, /'SHEET'!AD8:AG32/)
  assert.match(ranges, /'SHEET'!H3/)

  // H4 and H5 are reset to their placeholders instead, never blanked —
  // blanking them would strip the guild banner and the date header line.
  assert.doesNotMatch(ranges, /'SHEET'!H4/)
  assert.doesNotMatch(ranges, /'SHEET'!H5/)

  // Columns the sheet computes for itself must survive a clear.
  assert.doesNotMatch(ranges, /!X\d/) // TOTAL POINTS EARNED
  assert.doesNotMatch(ranges, /!Z\d/) // FINAL SCORE
  assert.doesNotMatch(ranges, /!AA\d/) // RANK
  assert.doesNotMatch(ranges, /!B\d/) // B8:C32 points lookup table
  assert.doesNotMatch(ranges, /!AC\d/) // penalties slot numbering (template)
})

test('clear restores the header placeholders and the placement formulas', () => {
  const restore = buildTemplateRestore('SHEET')
  const rowCount = SCORE_END_ROW - SCORE_START_ROW + 1

  assert.equal(restore.length, 6) // H4 banner + H5 date line + one column per round
  assert.equal(rowCount, 25)

  // The cleared sheet reads as the untouched default scoresheet again.
  const banner = restore.find((d) => d.range.endsWith('!H4'))
  const dateLine = restore.find((d) => d.range.endsWith('!H5'))
  assert.equal(banner.values[0][0], TITLE_BANNER_TEMPLATE)
  assert.match(banner.values[0][0], /\[DEVICE\]/)
  assert.equal(dateLine.values[0][0], DATE_HEADER_TEMPLATE)
  assert.match(dateLine.values[0][0], /\[DD-Mmm-YYYY\]/)

  for (const round of [1, 2, 3, 4]) {
    const { place, placementPoints } = ROUND_COLUMNS[round]
    const block = restore.find((d) => d.range.includes(`!${placementPoints}${SCORE_START_ROW}:`))
    assert.ok(block, `round ${round} placement column missing`)
    assert.equal(block.values.length, rowCount)
    assert.equal(block.values[0][0], `=VLOOKUP(${place}8,$B$8:$C$32,2,0)`)
    assert.equal(block.values[rowCount - 1][0], `=VLOOKUP(${place}32,$B$8:$C$32,2,0)`)
  }
})

test('a score for an unregistered slot is discarded, not moved to another team', () => {
  // Reproduces a live mis-tally: round A showed a team in lobby slot W with
  // 1 kill, but slot 23-W had nobody registered. Fuzzy name matching then put
  // that score on ASCEND WONDERPETS at 11-K.
  const roster = [
    { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID ESPORTS' },
    { slotIndex: 10, slotCode: '11K', slotLetter: 'K', tag: 'ASCE', name: 'ASCEND WONDERPETS' },
  ]

  // Slot W is a real lobby slot that nobody holds -> no team, no guess.
  assert.equal(findMatchingTeam('W', roster, 'W'), null)
  assert.equal(findMatchingTeam('23-W', roster, '23-W'), null)
  assert.equal(findMatchingTeam('ASCEND WONDERPETS', roster, 'W'), null)

  // A registered slot still resolves normally.
  assert.equal(findMatchingTeam('K', roster, 'K')?.name, 'ASCEND WONDERPETS')
  assert.equal(findMatchingTeam('A', roster, '1-A')?.tag, 'NR')

  // An unreadable slot code still falls back to name matching.
  assert.equal(findMatchingTeam('NIGHTRAID ESPORTS', roster, '??')?.tag, 'NR')
})

test('the board drops an unregistered-slot row instead of scoring it', () => {
  const roster = [
    { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID ESPORTS' },
    { slotIndex: 10, slotCode: '11K', slotLetter: 'K', tag: 'ASCE', name: 'ASCEND WONDERPETS' },
  ]
  const board = new TallyBoard()
  const entries = board.setRound(
    1,
    [
      { rank: 1, slotCode: '1-A', teamQuery: 'A', kills: 58 },
      { rank: 20, slotCode: 'W', teamQuery: 'W', kills: 1 },
    ],
    roster,
  )

  assert.equal(entries.length, 1)
  assert.equal(entries[0].slotCode, '01A')
  // ASCEND WONDERPETS must not have inherited the slot-W score.
  assert.ok(!entries.some((e) => e.name === 'ASCEND WONDERPETS'))
})

test('the review names what will not be scored, before confirming', () => {
  const roster = [
    { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID ESPORTS' },
    { slotIndex: 10, slotCode: '11K', slotLetter: 'K', tag: 'ASCE', name: 'ASCEND WONDERPETS' },
  ]

  // Slot W is a real lobby slot nobody holds, so it is reported, not scored.
  const skipped = findUnmatchedEntries(
    [
      { rank: 1, slotCode: '1-A', teamQuery: 'A', kills: 58 },
      { rank: 20, slotCode: 'W', teamQuery: 'W', kills: 1 },
    ],
    roster,
  )
  assert.deepEqual(skipped, ['slot W'])

  const msg = buildReviewMessage({
    roundNumber: 1,
    entries: [{ rank: 1, slotCode: '01A', tag: 'NR', name: 'NIGHTRAID ESPORTS', kills: 58, totalPoints: 78 }],
    registeredTeams: roster,
    reviewId: 'rev_test',
    skippedEntries: skipped,
  })

  assert.match(msg.content, /Not on the team slot board/)
  assert.match(msg.content, /slot W/)
  // ASCEND WONDERPETS holds a slot but is absent, so its cells are left blank.
  assert.match(msg.content, /left blank/)
  assert.match(msg.content, /11-K ASCE • ASCEND WONDERPETS/)
})

test('a clean round adds no notices to the review', () => {
  const roster = [{ slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID' }]
  const msg = buildReviewMessage({
    roundNumber: 1,
    entries: [{ rank: 1, slotCode: '01A', tag: 'NR', name: 'NIGHTRAID', kills: 58, totalPoints: 78 }],
    registeredTeams: roster,
    reviewId: 'rev_test',
    skippedEntries: [],
  })
  assert.doesNotMatch(msg.content, /Not on the team slot board/)
  assert.doesNotMatch(msg.content, /marked \*\*X\*\*/)
})

test('teams that never played are left off the standings', () => {
  const roster = [
    { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID' },
    { slotIndex: 10, slotCode: '11K', slotLetter: 'K', tag: 'ASCE', name: 'ASCEND WONDERPETS' },
    { slotIndex: 16, slotCode: '17Q', slotLetter: 'Q', tag: 'GNZ', name: 'WRATH' },
  ]
  const board = new TallyBoard()
  board.setRound(
    1,
    [
      { rank: 1, slotCode: '01A', teamQuery: 'A', kills: 58 },
      { rank: 19, slotCode: '17Q', teamQuery: 'Q', kills: 0 }, // played, scored nothing
    ],
    roster,
  )

  const standings = board.getOverallStandings(roster)
  const slots = standings.map((s) => s.slotCode)

  // WONDERPETS was in no round at all, so it is not on the board.
  assert.ok(!slots.includes('11K'))
  // Placing last with zero kills still counts as having played.
  assert.ok(slots.includes('17Q'))
  assert.equal(standings.length, 2)

  // The full roster is still available when explicitly asked for.
  const all = board.getOverallStandings(roster, { includeUnplayed: true })
  assert.equal(all.length, 3)
  assert.ok(all.map((s) => s.slotCode).includes('11K'))
})

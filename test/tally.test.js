import test from 'node:test'
import { ButtonStyle } from 'discord.js'
import assert from 'node:assert/strict'
import {
  findMatchingTeam,
  getPlacementPoints,
  TallyBoard,
  TALLY_EMOJI,
  renderAlignedTable,
} from '../src/scrims/tally-core.js'
import { parseTextScoreInput } from '../src/scrims/tally-vision.js'
import {
  ROUND_COLUMNS,
  SCORE_START_ROW,
  SCORE_END_ROW,
  buildClearRanges,
  buildTemplateRestore,
  buildRankHighlightFormula,
  applyRankHighlight,
  placementPointsFormula,
  defaultPlacementPointsFormula,
  formatSheetTeamName,
  renderTitleBanner,
  slotIndexFromCode,
  TITLE_BANNER_TEMPLATE,
  DATE_HEADER_TEMPLATE,
  getSpreadsheetUrl,
} from '../src/scrims/tally-sheet.js'
import { buildReviewMessage, buildRoundScoreTable, formatClearReply, parseRoundTableFromMessage } from '../src/scrims/tally-automation.js'

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

test('the review is just the heading and the table, with no notices', () => {
  const roster = [
    { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID' },
    { slotIndex: 10, slotCode: '11K', slotLetter: 'K', tag: 'ASCE', name: 'ASCEND WONDERPETS' },
  ]
  const msg = buildReviewMessage({
    roundNumber: 1,
    entries: [{ rank: 1, slotCode: '01A', tag: 'NR', name: 'NIGHTRAID', kills: 58, totalPoints: 78 }],
    registeredTeams: roster,
    reviewId: 'rev_test',
  })

  // Neither skipped rows nor absent teams are called out any more.
  assert.doesNotMatch(msg.content, /Not on the team slot board/)
  assert.doesNotMatch(msg.content, /left blank/)
  assert.doesNotMatch(msg.content, /🚫/)
  assert.ok(!msg.content.includes('ASCEND WONDERPETS'))

  // Heading, subtitle, then the fenced table — nothing after it.
  const lines = msg.content.split('\n')
  assert.match(lines[0], /SCORE TALLY REVIEW — ROUND 1/)
  assert.ok(lines[lines.length - 1].startsWith(String.fromCharCode(96)))
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

test('the rank highlight covers TEAM..RANK and leaves the SLOT column alone', async () => {
  const calls = []
  const realFetch = global.fetch
  global.fetch = async (url, opts) => {
    if (String(url).includes('?fields=')) {
      return { ok: true, json: async () => ({ sheets: [{ properties: { title: 'S', sheetId: 1 }, conditionalFormats: [] }] }) }
    }
    calls.push(JSON.parse(opts.body))
    return { ok: true, json: async () => ({}) }
  }

  try {
    await applyRankHighlight({ spreadsheetId: 'x', sheetName: 'S', accessToken: 't' })
  } finally {
    global.fetch = realFetch
  }

  const add = calls[0].requests.find((r) => r.addConditionalFormatRule)
  const range = add.addConditionalFormatRule.rule.ranges[0]

  // H=7 is SLOT and I=8 is SLOT NO.; the highlight must start after them at J.
  assert.equal(range.startColumnIndex, 9)
  assert.equal(range.endColumnIndex, 27) // exclusive, so through AA (RANK)
  assert.equal(range.startRowIndex, 7) // row 8
  assert.equal(range.endRowIndex, 32)
})

test('the confirmed round table is byte-identical to the reviewed one', () => {
  // Round 3 as reviewed: placement order, not cumulative standings order.
  const entries = [
    { rank: 1, slotCode: '01A', tag: 'NR', name: 'NIGHTRAID ESPORTS', kills: 56, totalPoints: 76 },
    { rank: 2, slotCode: '21U', tag: 'LAG', name: 'UNORTHODOX', kills: 16, totalPoints: 32 },
    { rank: 3, slotCode: '06F', tag: 'AIM', name: 'AIM SEEK GREATNESS', kills: 32, totalPoints: 45 },
    { rank: 8, slotCode: '04D', tag: 'SG', name: 'SEEK GREATNESS ESPORTS PH', kills: 43, totalPoints: 48 },
  ]

  const table = buildRoundScoreTable(entries)
  const review = buildReviewMessage({
    roundNumber: 3,
    entries,
    registeredTeams: [],
    reviewId: 'rev_x',
  })

  // The confirmation embeds the very same table the reviewer approved.
  assert.ok(review.content.includes(table))

  // Order is the round's placement order and is preserved verbatim.
  const rows = table
    .split('\n')
    .map((l) => l.replace(/`/g, ''))
    .filter((l) => /^\s*\d/.test(l))
  assert.deepEqual(rows.map((r) => r.trim().split(/\s+/)[0]), ['1', '2', '3', '8'])
  assert.deepEqual(rows.map((r) => r.trim().split(/\s+/)[1]), ['01A', '21U', '06F', '04D'])

  // Rank 8 with 48 pts still sits below rank 2 with 32 — sorting by points
  // would have moved it, which is exactly what confirming used to do.
  assert.ok(table.indexOf('21U') < table.indexOf('04D'))
})

test('the tally messages use the custom server emoji', () => {
  // "confirmed" resolves in-server, so it stays a real <:name:id> tag.
  assert.match(TALLY_EMOJI.confirmed, /^<a?:[A-Za-z0-9_]+:\d{17,20}>$/)
  assert.match(TALLY_EMOJI.confirmed, /1472902880120934431/)

  // These two did not resolve for the bot, so they are CDN links instead.
  assert.match(TALLY_EMOJI.standings, /^https:\/\/cdn\.discordapp\.com\/emojis\//)
  assert.match(TALLY_EMOJI.standings, /1388436342257487872/)
  assert.match(TALLY_EMOJI.leader, /^https:\/\/cdn\.discordapp\.com\/emojis\//)
  assert.match(TALLY_EMOJI.leader, /1387891022104760501/)

  // The sheet line carries no emoji at all now.
  assert.equal(TALLY_EMOJI.sheet, undefined)

  const board = new TallyBoard()
  board.setRound(1, [{ rank: 1, teamQuery: 'NR', kills: 10 }], mockRegisteredTeams)
  const out = board.formatStandingsMarkdown(mockRegisteredTeams, 'PHGG PC SCRIM STANDINGS')

  assert.ok(out.includes(`${TALLY_EMOJI.standings} **PHGG PC SCRIM STANDINGS**`))
  assert.ok(out.includes(`${TALLY_EMOJI.leader} **Current Leader**:`))
  // The old unicode emoji must be gone, including the medal before the name.
  assert.ok(!out.includes('🏆'))
  assert.ok(!out.includes('🌟'))
  assert.ok(!out.includes('🥇'))
})

test('the buttons carry plain text labels, no emoji', () => {
  const msg = buildReviewMessage({
    roundNumber: 1,
    entries: [{ rank: 1, slotCode: '01A', tag: 'NR', name: 'NIGHTRAID', kills: 10, totalPoints: 30 }],
    registeredTeams: [],
    reviewId: 'rev_x',
  })

  const labels = msg.components[0].components.map((c) => c.data.label)
  assert.deepEqual(labels, ['Confirm & Save Scores', 'View Standings', 'Reject'])

  // Colour already conveys the action, so no pictographs belong in the labels.
  const hasEmoji = /\p{Extended_Pictographic}/u
  for (const label of labels) {
    assert.ok(!hasEmoji.test(label), `"${label}" still contains an emoji`)
  }
})

test('View Standings is a link straight to the scoresheet', () => {
  const msg = buildReviewMessage({
    roundNumber: 1,
    entries: [{ rank: 1, slotCode: '01A', tag: 'NR', name: 'NIGHTRAID', kills: 10, totalPoints: 30 }],
    registeredTeams: [],
    reviewId: 'rev_x',
  })

  const [confirm, standings, reject] = msg.components[0].components.map((c) => c.data)

  // Link buttons carry a url and no custom_id, so Discord opens them directly.
  assert.equal(standings.label, 'View Standings')
  assert.equal(standings.style, ButtonStyle.Link)
  assert.match(standings.url, /^https:\/\/docs\.google\.com\/spreadsheets\/d\//)
  assert.match(standings.url, /1N3oh4z2FbnWzfXg79UNvegoP44FO9TkYxic8fN8I17U/)
  assert.equal(standings.custom_id, undefined)

  // The other two still post back to the bot.
  assert.ok(confirm.custom_id.startsWith('phgg_tally:confirm:'))
  assert.ok(reject.custom_id.startsWith('phgg_tally:reject:'))
})

test('the sheet link follows the spreadsheet the bot actually writes to', () => {
  const original = process.env.GOOGLE_SHEETS_SPREADSHEET_ID
  try {
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID = 'OTHER_SHEET_ID'
    assert.match(getSpreadsheetUrl(), /OTHER_SHEET_ID/)
    process.env.TALLY_SHEET_URL = 'https://example.com/custom'
    assert.equal(getSpreadsheetUrl(), 'https://example.com/custom')
  } finally {
    delete process.env.TALLY_SHEET_URL
    if (original === undefined) delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID
    else process.env.GOOGLE_SHEETS_SPREADSHEET_ID = original
  }
})

test('the /clear reply is one line with the custom check emoji', () => {
  const ok = formatClearReply('PC', { success: true })

  assert.ok(ok.startsWith(TALLY_EMOJI.confirmed))
  assert.ok(!ok.includes('✅'))
  assert.match(ok, /reset to blank for \*\*PC SCRIM\*\*\./)

  // Single line, and the old breakdown sentence is gone.
  assert.ok(!ok.includes('\n'))
  assert.ok(!ok.includes('Team names, all four rounds'))

  // A failed clear still reports the reason rather than claiming success.
  const failed = formatClearReply('PC', { success: false, error: 'permission denied' })
  assert.match(failed, /permission denied/)
})

test('tables have no WWCD column and fit their contents', () => {
  const roster = [
    { slotIndex: 6, slotCode: '07G', slotLetter: 'G', tag: 'RYLS', name: 'ROYALS FORTIS INVICTUS' },
    { slotIndex: 16, slotCode: '17Q', slotLetter: 'Q', tag: 'GNZ', name: 'WRATH' },
  ]
  const board = new TallyBoard()
  board.setRound(
    1,
    [
      { rank: 1, slotCode: '07G', teamQuery: 'G', kills: 72 },
      { rank: 21, slotCode: '17Q', teamQuery: 'Q', kills: 1 },
    ],
    roster,
  )
  const out = board.formatStandingsMarkdown(roster, 'PHGG PC SCRIM STANDINGS')

  assert.ok(!out.includes('WWCD'))
  assert.match(out, /RANK\s+SLOT\s+TEAM\s+KILLS\s+PTS/)

  // Every table row is the same width as the header, and no wider than the
  // longest cell needs — the old fixed padding forced 61 characters.
  const body = out
    .split('\n')
    .map((l) => l.replace(/`/g, ''))
    .filter((l) => /^(RK|\s*\d)/.test(l))
  const widths = new Set(body.map((l) => l.length))
  assert.equal(widths.size, 1, 'table rows are not aligned to one width')
  assert.ok([...widths][0] < 61, `table is ${[...widths][0]} chars, expected narrower than 61`)
})

test('renderAlignedTable sizes each column to its widest cell', () => {
  const table = renderAlignedTable(
    [
      { key: 'rk', label: 'RK', align: 'right' },
      { key: 'team', label: 'TEAM' },
    ],
    [{ rk: 1, team: 'AB' }, { rk: 10, team: 'LONGER NAME' }],
  )
  const lines = table.split('\n')

  // Rows are inline code spans, not a fenced block: a ``` block is full-width
  // in Discord, so its grey container ignored how narrow the table was.
  assert.ok(!table.includes('```'))
  for (const line of lines) {
    assert.ok(line.startsWith('`') && line.endsWith('`'), `not an inline span: ${line}`)
  }

  const cells = lines.map((l) => l.slice(1, -1))
  // "RK" is 2 wide, "TEAM" widens to 11 for "LONGER NAME".
  assert.equal(cells[0], 'RK  TEAM       ')
  assert.equal(cells[1], ' 1  AB         ')
  assert.equal(cells[2], '10  LONGER NAME')
})

test('a confirm can be rebuilt from the review table after a restart', () => {
  const table = buildRoundScoreTable([
    { rank: 1, slotCode: '01A', tag: 'NR', name: 'NIGHTRAID ESPORTS', kills: 58, totalPoints: 78 },
    { rank: 10, slotCode: '04D', tag: 'SG', name: 'SEEK GREATNESS ESPORTS PH', kills: 49, totalPoints: 54 },
    { rank: 21, slotCode: '07G', tag: 'RYLS', name: 'ROYALS FORTIS INVICTUS', kills: 0, totalPoints: 0 },
  ])
  const message = `📋 **PC SCRIM SCORE TALLY REVIEW — ROUND 1**\n*Please verify…*\n${table}`

  const recovered = parseRoundTableFromMessage(message)
  assert.equal(recovered.length, 3)
  assert.deepEqual(recovered[0], { rank: 1, slotCode: '01A', teamQuery: '01A', kills: 58 })
  // Team names contain spaces, so the parse anchors on the two numeric columns.
  assert.deepEqual(recovered[1], { rank: 10, slotCode: '04D', teamQuery: '04D', kills: 49 })
  // A zero-kill row is still a row.
  assert.deepEqual(recovered[2], { rank: 21, slotCode: '07G', teamQuery: '07G', kills: 0 })

  // Headings, prose and the header row are not mistaken for entries.
  assert.deepEqual(parseRoundTableFromMessage('📋 **REVIEW**\n*verify*'), [])
  assert.deepEqual(parseRoundTableFromMessage('`RK  SLOT  TEAM   KILLS  PTS`'), [])
})

test('each scrim scope reads screenshots from its own tally channel', async () => {
  const { loadConfig } = await import('../src/config.js')

  // loadConfig refuses to run without the bot's own credentials.
  const saved = { ...process.env }
  process.env.DISCORD_BOT_TOKEN ||= 'test-token'
  process.env.DISCORD_GUILD_ID ||= '1'
  let config
  try {
    config = loadConfig()
  } finally {
    process.env = saved
  }

  const pc = config.scrims.find((s) => s.label === 'PC')
  const mobile = config.scrims.find((s) => s.label === 'MOBILE')

  assert.equal(pc.tallyChannelId, '1534258096975904849')
  assert.equal(mobile.tallyChannelId, '1534503608144363621')

  // MOBILE used to fall through to '', so its listener treated no channel as a
  // tally channel and mobile screenshots were never processed.
  assert.ok(mobile.tallyChannelId)
  assert.notEqual(pc.tallyChannelId, mobile.tallyChannelId)
})

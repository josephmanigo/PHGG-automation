import test from 'node:test'
import { EventEmitter } from 'node:events'
import { ButtonStyle, Events } from 'discord.js'
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
  syncScoresToGoogleSheet,
  TITLE_BANNER_TEMPLATE,
  DATE_HEADER_TEMPLATE,
  getSpreadsheetUrl,
} from '../src/scrims/tally-sheet.js'
import {
  buildReviewMessage,
  buildRoundScoreTable,
  downloadScoreboardAttachment,
  formatClearReply,
  getOrCreateTallyBoard,
  installTallyAutomation,
  isBlockedTallyReview,
  isSupportedScoreboardAttachment,
  parseRoundTableFromMessage,
  readScoreboardScreenshots,
  tallyRosterFingerprint,
} from '../src/scrims/tally-automation.js'

const mockRegisteredTeams = [
  { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID' },
  { slotIndex: 1, slotCode: '02B', slotLetter: 'B', tag: 'SS', name: 'RAMPAGE SENTINELS' },
  { slotIndex: 2, slotCode: '03C', slotLetter: 'C', tag: 'APXS', name: 'SYNDICATE' },
  { slotIndex: 3, slotCode: '04D', slotLetter: 'D', tag: 'M7', name: 'M7 ESPORTS' },
]

function createTallyHandlerHarness({
  name,
  getRegisteredTeams = () => mockRegisteredTeams,
  reader = async () => ({
    roundNumber: 1,
    source: 'gemini',
    entries: [{ rank: 1, teamQuery: 'A', slotCode: '1-A', kills: 44 }],
    uncertain: [],
    missingRanks: [],
    conflicts: [],
  }),
  downloader = async () => ({
    buffer: Buffer.from('injected-image'),
    mimeType: 'image/png',
  }),
  sheetSync = async ({ entries }) => ({
    success: true,
    teamsTallied: entries.length,
    verificationStatus: 'PASSED',
  }),
} = {}) {
  const label = `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const channelId = `channel_${label}`
  const client = new EventEmitter()
  const scrimConfig = {
    label,
    tallyChannelId: channelId,
    channels: { tally: channelId },
    scorekeeperRoleIds: [],
    maxSlots: 25,
  }
  const board = getOrCreateTallyBoard(label)
  board.clear()
  installTallyAutomation(
    client,
    scrimConfig,
    { brandName: 'PHGG', scrims: [scrimConfig], scorekeeperRoleIds: [] },
    () => ({ getRegisteredTeams }),
    {
      downloadScoreboardAttachment: downloader,
      readScoreboardScreenshots: reader,
      syncScoresToGoogleSheet: sheetSync,
    },
  )
  return { board, channelId, client, label }
}

async function emitTallyUpload(client, channelId, { content = 'ROUND 1', member } = {}) {
  return new Promise((resolve) => {
    client.emit(Events.MessageCreate, {
      id: `upload_${Date.now()}_${Math.random()}`,
      author: { bot: false },
      content,
      member: member ?? { permissions: { has: () => true } },
      attachments: new Map([['image', {
        name: 'round.png',
        contentType: 'image/png',
        url: 'https://example.test/round.png',
      }]]),
      channel: { id: channelId, sendTyping: async () => {} },
      reply: async (payload) => {
        if (typeof payload === 'string' && !payload.includes('Reading')) {
          resolve({ directReply: payload })
          return { edit: async () => {} }
        }
        return {
          edit: async (reviewPayload) => resolve({ reviewPayload }),
        }
      },
    })
  })
}

async function emitTallyButton(client, {
  customId,
  content,
  createdTimestamp,
  actionMember,
} = {}) {
  return new Promise((resolve) => {
    client.emit(Events.InteractionCreate, {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId,
      user: { id: 'scorekeeper' },
      member: actionMember ?? { permissions: { has: () => true } },
      message: { content, createdTimestamp },
      deferUpdate: async () => {},
      editReply: async (payload) => resolve({ editPayload: payload }),
      reply: async (payload) => resolve({ replyPayload: payload }),
    })
  })
}

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

test('parseTextScoreInput parses 4-column score tables and normalizes slot 150', () => {
  const tableInput = `
PLACE  SLOT  KILLS  PTS
  1    04D    98    118
  2    08H    22     38
  3    150    21     34
  4    05E    10     20
  5    21U    15     23
`
  const result = parseTextScoreInput(tableInput)
  assert.equal(result.entries.length, 5)
  assert.equal(result.entries[0].rank, 1)
  assert.equal(result.entries[0].teamQuery, '04D')
  assert.equal(result.entries[0].kills, 98)

  assert.equal(result.entries[2].rank, 3)
  assert.equal(result.entries[2].teamQuery, '15O')
  assert.equal(result.entries[2].kills, 21)

  assert.equal(result.entries[3].rank, 4)
  assert.equal(result.entries[3].teamQuery, '05E')
  assert.equal(result.entries[3].kills, 10)
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

test('previewing an extracted round does not mutate standings before confirmation', () => {
  const board = new TallyBoard()
  const preview = board.previewRound(
    1,
    [{ rank: 1, slotCode: '01A', teamQuery: 'A', kills: 10 }],
    mockRegisteredTeams,
  )

  assert.equal(preview.length, 1)
  assert.deepEqual(board.getRound(1), [])

  board.setRound(1, preview, mockRegisteredTeams)
  assert.equal(board.getRound(1).length, 1)
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

test('a review with unresolved extraction evidence cannot be confirmed', () => {
  const msg = buildReviewMessage({
    roundNumber: 1,
    entries: [{ rank: 1, slotCode: '01A', tag: 'NR', name: 'NIGHTRAID', kills: 10, totalPoints: 30 }],
    registeredTeams: [],
    reviewId: 'rev_blocked',
    notice: '⛔ AUTOMATIC SAVE BLOCKED',
    blocked: true,
  })

  const confirm = msg.components[0].components[0].data
  assert.equal(confirm.label, 'Confirm & Save Scores')
  assert.equal(confirm.disabled, true)
  assert.match(msg.content, /AUTOMATIC SAVE BLOCKED/)
})

test('the server-side guard blocks both remembered and restart-recovered reviews', () => {
  assert.equal(isBlockedTallyReview({ blocked: true }, 'ordinary review'), true)
  assert.equal(
    isBlockedTallyReview(null, '⛔ AUTOMATIC SAVE BLOCKED — incomplete extraction'),
    true,
  )
  assert.equal(isBlockedTallyReview({ blocked: false }, 'ordinary review'), false)
})

test('a crafted restart-lost blocked Confirm cannot mutate the tally board', async () => {
  const label = `BLOCKED_${Date.now()}`
  const client = new EventEmitter()
  const scrimConfig = {
    label,
    tallyChannelId: 'blocked-tally-channel',
    channels: { tally: 'blocked-tally-channel' },
    scorekeeperRoleIds: [],
  }
  const board = getOrCreateTallyBoard(label)
  board.clear()
  installTallyAutomation(
    client,
    scrimConfig,
    { brandName: 'PHGG', scrims: [scrimConfig], scorekeeperRoleIds: [] },
    () => ({ getRegisteredTeams: () => mockRegisteredTeams }),
  )

  let editedPayload
  let resolveEdited
  const edited = new Promise((resolve) => { resolveEdited = resolve })
  client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: `phgg_tally:confirm:${label}:1:lost_review`,
    user: { id: 'scorekeeper' },
    member: { permissions: { has: () => true } },
    message: { content: '⛔ **AUTOMATIC SAVE BLOCKED** — incomplete screenshot set' },
    deferUpdate: async () => {},
    editReply: async (payload) => {
      editedPayload = payload
      resolveEdited()
    },
    reply: async () => {},
  })
  await edited

  assert.deepEqual(board.getRound(1), [])
  assert.match(editedPayload.content, /NOT SAVED/)
  assert.deepEqual(editedPayload.components, [])
})

test('parser uncertainty flows through upload review and blocks a crafted Confirm', async () => {
  const label = `UPLOAD_BLOCKED_${Date.now()}`
  const channelId = `channel_${label}`
  const client = new EventEmitter()
  const scrimConfig = {
    label,
    tallyChannelId: channelId,
    channels: { tally: channelId },
    scorekeeperRoleIds: [],
    maxSlots: 25,
  }
  const board = getOrCreateTallyBoard(label)
  board.clear()
  let setRoundCalls = 0
  const originalSetRound = board.setRound.bind(board)
  board.setRound = (...args) => {
    setRoundCalls += 1
    return originalSetRound(...args)
  }

  installTallyAutomation(
    client,
    scrimConfig,
    { brandName: 'PHGG', scrims: [scrimConfig], scorekeeperRoleIds: [] },
    () => ({ getRegisteredTeams: () => mockRegisteredTeams }),
    {
      downloadScoreboardAttachment: async () => ({
        buffer: Buffer.from('injected-image'),
        mimeType: 'image/png',
      }),
      readScoreboardScreenshots: async () => ({
        roundNumber: 1,
        source: 'gemini',
        entries: [{ rank: 1, teamQuery: 'A', slotCode: '1-A', kills: 44 }],
        uncertain: [{ rank: 2, slotLetter: 'B', kills: null, reason: 'unreadable_field' }],
        missingRanks: [],
        conflicts: [],
      }),
    },
  )

  let reviewPayload
  let resolveReview
  const reviewReady = new Promise((resolve) => { resolveReview = resolve })
  client.emit(Events.MessageCreate, {
    id: 'score-upload-message',
    author: { bot: false },
    content: 'ROUND 1',
    member: { permissions: { has: () => true } },
    attachments: new Map([['image', {
      name: 'round.png',
      contentType: 'image/png',
      url: 'https://example.test/round.png',
    }]]),
    channel: {
      id: channelId,
      sendTyping: async () => {},
    },
    reply: async () => ({
      edit: async (payload) => {
        reviewPayload = payload
        resolveReview()
      },
    }),
  })
  await reviewReady

  const confirm = reviewPayload.components[0].components[0].data
  assert.equal(confirm.disabled, true)
  assert.match(reviewPayload.content, /AUTOMATIC SAVE BLOCKED/)
  assert.deepEqual(board.getRound(1), [])

  let resolveConfirm
  const confirmHandled = new Promise((resolve) => { resolveConfirm = resolve })
  client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: confirm.custom_id,
    user: { id: 'scorekeeper' },
    member: { permissions: { has: () => true } },
    message: { content: reviewPayload.content },
    deferUpdate: async () => {},
    editReply: async () => { resolveConfirm() },
    reply: async () => {},
  })
  await confirmHandled

  assert.equal(setRoundCalls, 0)
  assert.deepEqual(board.getRound(1), [])
})

test('unauthorized screenshot submissions never download or invoke a reader', async () => {
  let downloads = 0
  let reads = 0
  const harness = createTallyHandlerHarness({
    name: 'UNAUTHORIZED_UPLOAD',
    downloader: async () => {
      downloads += 1
      throw new Error('must not download')
    },
    reader: async () => {
      reads += 1
      throw new Error('must not read')
    },
  })
  const result = await emitTallyUpload(harness.client, harness.channelId, {
    member: {
      permissions: { has: () => false },
      roles: { cache: new Map() },
    },
  })

  assert.match(result.directReply, /do not have permission/i)
  assert.equal(downloads, 0)
  assert.equal(reads, 0)
})

test('an explicit round outside 1 through 4 is rejected before image work', async () => {
  let downloads = 0
  let reads = 0
  const harness = createTallyHandlerHarness({
    name: 'INVALID_ROUND_UPLOAD',
    downloader: async () => {
      downloads += 1
      throw new Error('must not download')
    },
    reader: async () => {
      reads += 1
      throw new Error('must not read')
    },
  })
  const result = await emitTallyUpload(harness.client, harness.channelId, { content: 'ROUND 99' })

  assert.match(result.directReply, /Round must be 1, 2, 3, or 4/i)
  assert.equal(downloads, 0)
  assert.equal(reads, 0)
})

test('a roster refresh cannot drop an extracted row or remap it at confirmation', async () => {
  const originalRoster = [mockRegisteredTeams[0]]
  const changedRoster = [{
    ...mockRegisteredTeams[0],
    tag: 'NEW',
    name: 'REPLACEMENT TEAM',
  }]
  let liveRoster = originalRoster
  let sheetCalls = 0
  const harness = createTallyHandlerHarness({
    name: 'ROSTER_SNAPSHOT',
    getRegisteredTeams: () => liveRoster,
    reader: async () => {
      liveRoster = changedRoster
      return {
        source: 'gemini',
        entries: [{ rank: 1, teamQuery: 'A', slotCode: '1-A', kills: 44 }],
        uncertain: [],
        missingRanks: [],
        conflicts: [],
      }
    },
    sheetSync: async () => {
      sheetCalls += 1
      return { success: true, teamsTallied: 1, verificationStatus: 'PASSED' }
    },
  })
  const { reviewPayload } = await emitTallyUpload(harness.client, harness.channelId)
  const confirm = reviewPayload.components[0].components[0].data

  assert.match(reviewPayload.content, /01A/)
  assert.equal(confirm.disabled, false)
  const result = await emitTallyButton(harness.client, {
    customId: confirm.custom_id,
    content: reviewPayload.content,
  })

  assert.match(result.editPayload.content, /NOT SAVED.*roster changed|roster changed.*NOT SAVED/is)
  assert.equal(sheetCalls, 0)
  assert.deepEqual(harness.board.getRound(1), [])
})

test('false and thrown sheet writes leave the round untouched and retryable', async (t) => {
  for (const failure of [
    { name: 'false result', sync: async () => ({ success: false, error: 'webhook rejected' }) },
    { name: 'thrown error', sync: async () => { throw new Error('sheet unavailable') } },
  ]) {
    await t.test(failure.name, async () => {
      let sheetCalls = 0
      const harness = createTallyHandlerHarness({
        name: `SYNC_FAILURE_${failure.name}`,
        sheetSync: async (input) => {
          sheetCalls += 1
          return failure.sync(input)
        },
      })
      const { reviewPayload } = await emitTallyUpload(harness.client, harness.channelId)
      const confirm = reviewPayload.components[0].components[0].data
      const result = await emitTallyButton(harness.client, {
        customId: confirm.custom_id,
        content: reviewPayload.content,
      })

      assert.equal(sheetCalls, 1)
      assert.deepEqual(harness.board.getRound(1), [])
      assert.match(result.editPayload.content, /NOT SAVED.*Google Sheet write failed/is)
      assert.equal(result.editPayload.components[0].components[0].data.disabled, false)
      assert.equal(result.editPayload.components[0].components[0].data.custom_id, confirm.custom_id)
    })
  }
})

test('concurrent confirm and reject clicks produce one committed sheet write', async () => {
  let sheetCalls = 0
  let releaseSync
  let signalSyncStarted
  const syncStarted = new Promise((resolve) => { signalSyncStarted = resolve })
  const syncRelease = new Promise((resolve) => { releaseSync = resolve })
  const harness = createTallyHandlerHarness({
    name: 'CONCURRENT_CONFIRM',
    sheetSync: async ({ entries }) => {
      sheetCalls += 1
      signalSyncStarted()
      await syncRelease
      return { success: true, teamsTallied: entries.length, verificationStatus: 'PASSED' }
    },
  })
  let setRoundCalls = 0
  const originalSetRound = harness.board.setRound.bind(harness.board)
  harness.board.setRound = (...args) => {
    setRoundCalls += 1
    return originalSetRound(...args)
  }
  const { reviewPayload } = await emitTallyUpload(harness.client, harness.channelId)
  const confirm = reviewPayload.components[0].components[0].data
  const reject = reviewPayload.components[0].components[2].data
  const firstConfirm = emitTallyButton(harness.client, {
    customId: confirm.custom_id,
    content: reviewPayload.content,
  })
  await syncStarted

  const [secondConfirm, concurrentReject] = await Promise.all([
    emitTallyButton(harness.client, {
      customId: confirm.custom_id,
      content: reviewPayload.content,
    }),
    emitTallyButton(harness.client, {
      customId: reject.custom_id,
      content: reviewPayload.content,
    }),
  ])
  assert.match(secondConfirm.replyPayload.content, /already being saved/i)
  assert.match(concurrentReject.replyPayload.content, /cannot be rejected mid-write/i)

  releaseSync()
  const saved = await firstConfirm
  assert.match(saved.editPayload.content, /SCORES CONFIRMED/i)
  assert.equal(sheetCalls, 1)
  assert.equal(setRoundCalls, 1)
  assert.equal(harness.board.getRound(1).length, 1)

  const replay = await emitTallyButton(harness.client, {
    customId: confirm.custom_id,
    content: reviewPayload.content,
  })
  assert.match(replay.replyPayload.content, /already saved/i)
  assert.equal(sheetCalls, 1)
  assert.equal(setRoundCalls, 1)
})

test('restart recovery rejects a valid-looking review older than the TTL', async () => {
  let sheetCalls = 0
  const harness = createTallyHandlerHarness({
    name: 'EXPIRED_RESTART_REVIEW',
    sheetSync: async () => {
      sheetCalls += 1
      return { success: true, teamsTallied: 1, verificationStatus: 'PASSED' }
    },
  })
  const oldTimestamp = Date.now() - 7 * 60 * 60 * 1000
  const reviewId = `rev_${oldTimestamp}_abcde_${tallyRosterFingerprint(mockRegisteredTeams)}`
  const content = `PC SCRIM SCORE TALLY REVIEW - ROUND 1\n${buildRoundScoreTable([{
    rank: 1,
    slotCode: '01A',
    kills: 44,
    totalPoints: 64,
  }])}`
  const result = await emitTallyButton(harness.client, {
    customId: `phgg_tally:confirm:${harness.label}:1:${reviewId}`,
    content,
    createdTimestamp: oldTimestamp,
  })

  assert.match(result.editPayload.content, /NOT saved|more than six hours old/i)
  assert.equal(sheetCalls, 0)
  assert.deepEqual(harness.board.getRound(1), [])
})

test('webhook sheet writes use an explicit success contract and reject non-OK responses', async () => {
  const originalWebhook = process.env.GOOGLE_SHEETS_WEBHOOK_URL
  const originalFetch = global.fetch
  process.env.GOOGLE_SHEETS_WEBHOOK_URL = 'https://example.test/tally-webhook'
  try {
    global.fetch = async () => new Response('', { status: 200 })
    const success = await syncScoresToGoogleSheet({
      roundNumber: 1,
      entries: [{ rank: 1, slotCode: '01A', kills: 44 }],
      registeredTeams: [mockRegisteredTeams[0]],
    })
    assert.deepEqual(success, {
      success: true,
      roundNumber: 1,
      teamsTallied: 1,
      verificationStatus: 'WEBHOOK_ACCEPTED',
    })

    global.fetch = async () => new Response('upstream unavailable', { status: 503 })
    await assert.rejects(syncScoresToGoogleSheet({
      roundNumber: 1,
      entries: [{ rank: 1, slotCode: '01A', kills: 44 }],
      registeredTeams: [mockRegisteredTeams[0]],
    }), /webhook failed \(503\).*upstream unavailable/i)
  } finally {
    global.fetch = originalFetch
    if (originalWebhook === undefined) delete process.env.GOOGLE_SHEETS_WEBHOOK_URL
    else process.env.GOOGLE_SHEETS_WEBHOOK_URL = originalWebhook
  }
})

test('score attachment intake accepts only supported still-image formats', () => {
  assert.equal(isSupportedScoreboardAttachment({ contentType: 'image/png', name: 'score' }), true)
  assert.equal(isSupportedScoreboardAttachment({ contentType: '', name: 'score.JPEG' }), true)
  assert.equal(isSupportedScoreboardAttachment({ contentType: 'application/octet-stream', name: 'score.png' }), true)
  assert.equal(isSupportedScoreboardAttachment({ contentType: 'image/gif', name: 'score.png' }), false)
  assert.equal(isSupportedScoreboardAttachment({ contentType: 'application/pdf', name: 'score.png' }), false)
  assert.equal(isSupportedScoreboardAttachment({ contentType: '', name: 'scores.txt' }), false)
})

test('score attachment download validates actual bytes and enforces its limit', async () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const downloaded = await downloadScoreboardAttachment({
    url: 'https://example.test/score.png',
    name: 'score.png',
    contentType: 'image/png',
  }, {
    fetchImpl: async () => new Response(pngHeader, { status: 200 }),
    maxBytes: 100,
  })
  assert.deepEqual(downloaded.buffer, pngHeader)
  assert.equal(downloaded.mimeType, 'image/png')

  await assert.rejects(downloadScoreboardAttachment({
    url: 'https://example.test/too-large.png',
    name: 'too-large.png',
    contentType: 'image/png',
  }, {
    fetchImpl: async () => new Response(pngHeader, {
      status: 200,
      headers: { 'Content-Length': '101' },
    }),
    maxBytes: 100,
  }), /exceeds.*byte download limit/i)

  await assert.rejects(downloadScoreboardAttachment({
    url: 'https://example.test/fake.png',
    name: 'fake.png',
    contentType: 'image/png',
  }, {
    fetchImpl: async () => new Response('not an image', { status: 200 }),
  }), /bytes are not a supported/i)
})

test('zero-accepted cloud output uses local fallback but remains blocked evidence', async () => {
  let localCalls = 0
  const parsed = await readScoreboardScreenshots({
    provider: 'gemini',
    images: [{ buffer: Buffer.from('fixture'), mimeType: 'image/png' }],
    cloudReader: async () => ({ entries: [], uncertain: [{ rank: null }] }),
    localReader: async () => {
      localCalls += 1
      return {
        source: 'glyphs',
        entries: [{ rank: 1, teamQuery: 'A', kills: 44 }],
        uncertain: [],
      }
    },
  })

  assert.equal(localCalls, 1)
  assert.equal(parsed.source, 'glyphs')
  assert.equal(parsed.entries[0].kills, 44)
  assert.equal(parsed.uncertain.some((item) => item.reason === 'provider_fallback_used'), true)
})

test('a partial cloud read remains blocked evidence and is not mixed with local OCR', async () => {
  let localCalls = 0
  const parsed = await readScoreboardScreenshots({
    provider: 'gemini',
    images: [{ buffer: Buffer.from('fixture'), mimeType: 'image/png' }],
    cloudReader: async () => ({
      source: 'gemini',
      entries: [{ rank: 1, teamQuery: 'A', kills: 44 }],
      uncertain: [{ rank: 2, reason: 'unreadable_field' }],
    }),
    localReader: async () => {
      localCalls += 1
      throw new Error('must not be called')
    },
  })

  assert.equal(localCalls, 0)
  assert.equal(parsed.uncertain.length, 1)
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
  assert.match(out, /PLACE\s+SLOT\s+TEAM\s+KILLS\s+PTS/)

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

test('a recovered round shows real points, and no TEAM column', () => {
  const roster = [
    { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID ESPORTS' },
    { slotIndex: 5, slotCode: '06F', slotLetter: 'F', tag: 'AIM', name: 'AIM SEEK GREATNESS' },
  ]

  // What parseRoundTableFromMessage hands back after a restart: slot and kills
  // only — no tag, no name, no points.
  const recovered = [
    { rank: 1, slotCode: '01A', teamQuery: '01A', kills: 56 },
    { rank: 2, slotCode: '06F', teamQuery: '06F', kills: 41 },
  ]

  const board = new TallyBoard()
  const processed = board.setRound(2, recovered, roster)
  const table = buildRoundScoreTable(processed)

  // setRound resolves the roster and computes the points.
  assert.equal(processed[0].totalPoints, 20 + 56) // place 1 -> 20 placement pts
  assert.equal(processed[1].totalPoints, 16 + 41) // place 2 -> 16

  // Four columns: PLACE, SLOT, KILLS, PTS. No TEAM.
  assert.match(table, /PLACE\s+SLOT\s+KILLS\s+PTS/)
  assert.ok(!table.includes('TEAM'))
  assert.ok(!table.includes('NIGHTRAID'))

  const rows = table.split('\n').slice(1).map((l) => l.replace(/`/g, '').trim())
  for (const row of rows) {
    const cells = row.split(/\s+/)
    assert.equal(cells.length, 4, `expected 4 columns, got: ${row}`)
    // A team that scored must never show 0 points.
    assert.notEqual(cells[3], '0', `points not computed: ${row}`)
  }
  assert.deepEqual(rows.map((r) => r.split(/\s+/)[3]), ['76', '57'])
})

test('points are computed even when the entry was never resolved', () => {
  // Straight from parseRoundTableFromMessage: no totalPoints on the entry.
  const table = buildRoundScoreTable([
    { rank: 1, slotCode: '01A', kills: 56 },
    { rank: 21, slotCode: '07G', kills: 0 },
  ])
  const rows = table.split('\n').slice(1).map((l) => l.replace(/`/g, '').trim())

  assert.equal(rows[0].split(/\s+/)[3], String(20 + 56)) // 76
  // Place 21 scores no placement points, and zero kills really is zero.
  assert.equal(rows[1].split(/\s+/)[3], '0')
})

test('the recovery parser skips the header under any of its names', () => {
  for (const header of ['RK  SLOT  TEAM  KILLS  PTS', 'RANK  SLOT  TEAM  KILLS  PTS', 'PLACE  SLOT  TEAM  KILLS  PTS']) {
    const msg = `\`${header}\`\n\` 1  01A   [NR] NIGHTRAID     58   78\``
    const rows = parseRoundTableFromMessage(msg)
    assert.equal(rows.length, 1, `header "${header.split(' ')[0]}" was parsed as a team row`)
    assert.equal(rows[0].slotCode, '01A')
  }
})

test('the rank highlight forces black text on the yellow fill', async () => {
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

  const rule = calls[0].requests.find((r) => r.addConditionalFormatRule).addConditionalFormatRule.rule
  const { backgroundColor, textFormat } = rule.booleanRule.format

  assert.deepEqual(backgroundColor, { red: 1.0, green: 1.0, blue: 0.0 })
  // Without an explicit foreground the cell keeps its own colour, and FINAL
  // SCORE / RANK are white on their dark fill — invisible once highlighted.
  assert.deepEqual(textFormat.foregroundColor, { red: 0, green: 0, blue: 0 })
  assert.equal(textFormat.bold, true)
})

test('the confirmation renders roster-resolved entries, never the raw input', async () => {
  // A guard on the source itself. The previous version of this fix was applied
  // by a string replacement that silently missed this line, so the confirmation
  // kept rendering reviewData.entries — slot codes as team names, 0 points —
  // while the tests all passed.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/scrims/tally-automation.js', import.meta.url), 'utf8')

  assert.ok(
    !/buildRoundScoreTable\(\s*reviewData\.entries\s*\)/.test(source),
    'the confirmation must not render reviewData.entries directly',
  )
  assert.match(source, /const confirmedTable = .*buildRoundScoreTable\(confirmedEntries\)/)
  // The sheet write must use the same resolved entries.
  assert.match(source, /entries: confirmedEntries,/)
})

test('centred columns split the padding around the value', () => {
  const table = renderAlignedTable(
    [
      { key: 'place', label: 'PLACE', align: 'center' },
      { key: 'pts', label: 'PTS', align: 'center' },
    ],
    [{ place: 1, pts: 76 }, { place: 21, pts: 0 }],
  )
  const cells = table.split('\n').map((l) => l.slice(1, -1))

  // PLACE is 5 wide and PTS is 3. Odd slack leans left, so "1" sits at 2/2 and
  // "21" at 1/2; in PTS, "76" is 0/1 and "0" is 1/1.
  assert.equal(cells[0], 'PLACE  PTS')
  assert.equal(cells[1], '  1    76 ')
  assert.equal(cells[2], ' 21     0 ')

  // Every row stays the same width, so the columns still line up.
  const widths = new Set(cells.map((c) => c.length))
  assert.equal(widths.size, 1)
})

test('the round table centres its values and keeps four columns', () => {
  const table = buildRoundScoreTable([
    { rank: 1, slotCode: '01A', kills: 56, totalPoints: 76 },
    { rank: 21, slotCode: '07G', kills: 0, totalPoints: 0 },
  ])
  const rows = table.split('\n').map((l) => l.slice(1, -1))

  assert.match(rows[0], /PLACE\s+SLOT\s+KILLS\s+PTS/)
  for (const row of rows) {
    assert.equal(row.length, rows[0].length, `row width drifted: "${row}"`)
    assert.equal(row.trim().split(/\s+/).length, 4)
  }
  // A single-digit place is not flush left any more.
  assert.ok(rows[1].startsWith(' '), 'value is not centred')
})

test('every button path ends in a response', async () => {
  // Discord reports an unanswered interaction as "This interaction failed" with
  // no detail, so the handler must never fall off the end silently.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/scrims/tally-automation.js', import.meta.url), 'utf8')

  // A catch-all after the known actions.
  assert.match(source, /Unhandled button action/)
  assert.match(source, /!interaction\.replied && !interaction\.deferred/)
  // Reading the slot board is guarded, since it runs before any reply.
  assert.match(source, /Could not read the slot board/)
  // A repeat confirm is answered rather than ignored.
  assert.match(source, /already saved/)
})

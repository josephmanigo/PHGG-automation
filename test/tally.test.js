import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findMatchingTeam,
  getPlacementPoints,
  TallyBoard,
} from '../src/scrims/tally-core.js'
import { parseTextScoreInput } from '../src/scrims/tally-vision.js'

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

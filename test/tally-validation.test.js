import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertValidTallyRound,
  TallyValidationError,
  validateTallyRound,
} from '../src/scrims/tally-validation.js'

const roster = [
  { slotIndex: 0, slotCode: '01A', slotLetter: 'A', tag: 'NR', name: 'NIGHTRAID' },
  { slotIndex: 1, slotCode: '02B', slotLetter: 'B', tag: 'SS', name: 'SENTINELS' },
  { slotIndex: 2, slotCode: '03C', slotLetter: 'C', tag: 'APX', name: 'APEX' },
]

function issueCodes(result) {
  return result.issues.map((issue) => issue.code)
}

test('accepts contiguous ranks and zero kills without mutating entries or roster', () => {
  const entries = [
    { rank: 1, slotCode: '1-A', teamQuery: 'A', kills: 0 },
    { rank: 2, slotCode: 'B', teamQuery: 'B', kills: 12 },
  ]
  const entriesBefore = structuredClone(entries)
  const rosterBefore = structuredClone(roster)

  const result = validateTallyRound(entries, roster)

  assert.equal(result.valid, true)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(entries, entriesBefore)
  assert.deepEqual(roster, rosterBefore)
  assert.notEqual(result.resolvedEntries[0], entries[0])
  assert.deepEqual(
    result.resolvedEntries.map(({ rank, slotIndex, slotCode, kills }) => ({
      rank,
      slotIndex,
      slotCode,
      kills,
    })),
    [
      { rank: 1, slotIndex: 0, slotCode: '01A', kills: 0 },
      { rank: 2, slotIndex: 1, slotCode: '02B', kills: 12 },
    ],
  )
})

test('rejects an empty round', () => {
  const result = validateTallyRound([], roster)

  assert.equal(result.valid, false)
  assert.deepEqual(issueCodes(result), ['empty_entries'])
})

test('rejects duplicate slots even when different slot aliases are used', () => {
  const result = validateTallyRound([
    { rank: 1, slotCode: '1-A', kills: 3 },
    { rank: 2, slotCode: 'A', kills: 4 },
  ], roster)

  const issue = result.issues.find(({ code }) => code === 'duplicate_slot')
  assert.equal(result.valid, false)
  assert.deepEqual(
    {
      entryIndex: issue.entryIndex,
      otherEntryIndex: issue.otherEntryIndex,
      slotIdentity: issue.slotIdentity,
      slotCode: issue.slotCode,
    },
    { entryIndex: 1, otherEntryIndex: 0, slotIdentity: 'slot:1', slotCode: '01A' },
  )
})

test('rejects duplicate ranks with both conflicting entry indexes', () => {
  const result = validateTallyRound([
    { rank: 1, slotCode: 'A', kills: 3 },
    { rank: 1, slotCode: 'B', kills: 4 },
  ], roster)

  const issue = result.issues.find(({ code }) => code === 'duplicate_rank')
  assert.equal(result.valid, false)
  assert.deepEqual(
    { rank: issue.rank, entryIndex: issue.entryIndex, otherEntryIndex: issue.otherEntryIndex },
    { rank: 1, entryIndex: 1, otherEntryIndex: 0 },
  )
})

test('rejects gaps because ranks must be exactly 1 through entry count', () => {
  const result = validateTallyRound([
    { rank: 1, slotCode: 'A', kills: 3 },
    { rank: 3, slotCode: 'B', kills: 4 },
  ], roster)

  const issue = result.issues.find(({ code }) => code === 'non_contiguous_ranks')
  assert.equal(result.valid, false)
  assert.deepEqual(issue.actualRanks, [1, 3])
  assert.deepEqual(issue.expectedRanks, [1, 2])
  assert.deepEqual(issue.missingRanks, [2])
  assert.deepEqual(issue.unexpectedRanks, [3])
})

test('rejects kills above 999 as well as negative, fractional, and string kills', () => {
  for (const kills of [1000, -1, 2.5, '12']) {
    const result = validateTallyRound([{ rank: 1, slotCode: 'A', kills }], roster)
    const issue = result.issues.find(({ code }) => code === 'invalid_kills')

    assert.equal(result.valid, false, `kills=${kills}`)
    assert.equal(issue.value, kills)
    assert.equal(issue.min, 0)
    assert.equal(issue.max, 999)
  }
})

test('rejects rank 26 when maxSlots is 25 and does not coerce rank strings', () => {
  for (const rank of [26, '1']) {
    const result = validateTallyRound([{ rank, slotCode: 'A', kills: 0 }], roster)
    const issue = result.issues.find(({ code }) => code === 'invalid_rank')

    assert.equal(result.valid, false, `rank=${rank}`)
    assert.equal(issue.value, rank)
    assert.equal(issue.max, 25)
  }
})

test('rejects an unknown explicit slot without falling back to a known team query', () => {
  const result = validateTallyRound([
    { rank: 1, slotCode: '04D', teamQuery: 'NR', kills: 0 },
  ], roster)

  const issue = result.issues.find(({ code }) => code === 'unknown_slot')
  assert.equal(result.valid, false)
  assert.equal(issue.entryIndex, 0)
  assert.equal(issue.value, '04D')
})

test('allows a partial roster by default but can require every registered team', () => {
  const partial = [
    { rank: 1, slotCode: 'A', kills: 0 },
    { rank: 2, slotCode: '02B', kills: 7 },
  ]

  const allowed = validateTallyRound(partial, roster)
  const required = validateTallyRound(partial, roster, { requireRosterComplete: true })

  assert.equal(allowed.valid, true)
  assert.equal(required.valid, false)
  const issue = required.issues.find(({ code }) => code === 'roster_incomplete')
  assert.equal(issue.expectedCount, 3)
  assert.equal(issue.actualResolvedCount, 2)
  assert.deepEqual(issue.missingTeams, [{
    rosterIndex: 2,
    slotIdentity: 'slot:3',
    slotCode: '03C',
    tag: 'APX',
    name: 'APEX',
  }])
})

test('accepts a complete roster when requireRosterComplete is enabled', () => {
  const result = validateTallyRound([
    { rank: 1, slotCode: 'A', kills: 0 },
    { rank: 2, slotCode: 'B', kills: 1 },
    { rank: 3, slotCode: 'C', kills: 2 },
  ], roster, { requireRosterComplete: true })

  assert.equal(result.valid, true)
  assert.deepEqual(result.issues, [])
})

test('rejects more entries than maxSlots', () => {
  const result = validateTallyRound([
    { rank: 1, slotCode: 'A', kills: 0 },
    { rank: 2, slotCode: 'B', kills: 0 },
    { rank: 3, slotCode: 'C', kills: 0 },
  ], roster, { maxSlots: 2 })

  const issue = result.issues.find(({ code }) => code === 'too_many_entries')
  assert.equal(result.valid, false)
  assert.equal(issue.count, 3)
  assert.equal(issue.maxSlots, 2)
})

test('assertValidTallyRound returns valid results and throws structured invalid results', () => {
  const validResult = assertValidTallyRound([
    { rank: 1, slotCode: 'A', kills: 0 },
  ], roster)
  assert.equal(validResult.valid, true)

  assert.throws(
    () => assertValidTallyRound([{ rank: 1, slotCode: 'A', kills: 1000 }], roster),
    (error) => {
      assert.equal(error instanceof TallyValidationError, true)
      assert.equal(error.result.valid, false)
      assert.equal(error.issues[0].code, 'invalid_kills')
      return true
    },
  )
})

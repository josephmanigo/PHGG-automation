export const DEFAULT_TALLY_MAX_SLOTS = 25
export const MAX_TALLY_KILLS = 999

function normalizeIdentifier(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toUpperCase()
}

function slotIndexFromReference(value, maxSlots) {
  const normalized = normalizeIdentifier(value)
  if (!normalized) return null

  if (/^[A-Z]$/.test(normalized)) {
    const index = normalized.charCodeAt(0) - 65
    return index < maxSlots ? index : null
  }

  const numbered = /^(\d+)([A-Z])?$/.exec(normalized)
  if (!numbered) return null

  const index = Number(numbered[1]) - 1
  if (!Number.isSafeInteger(index) || index < 0 || index >= maxSlots) return null

  if (numbered[2] && numbered[2].charCodeAt(0) - 65 !== index) return null
  return index
}

function addLookupValue(lookup, key, value) {
  if (!key) return
  const matches = lookup.get(key) ?? []
  matches.push(value)
  lookup.set(key, matches)
}

function uniqueMatches(matches = []) {
  return [...new Set(matches)]
}

function rosterSlotDescriptor(team, rosterIndex, maxSlots) {
  if (!team || typeof team !== 'object' || Array.isArray(team)) return null

  const candidateIndexes = []
  const numericSlotIndex = Number(team.slotIndex)
  if (
    team.slotIndex !== null
    && team.slotIndex !== undefined
    && team.slotIndex !== ''
    && Number.isInteger(numericSlotIndex)
    && numericSlotIndex >= 0
    && numericSlotIndex < maxSlots
  ) {
    candidateIndexes.push(numericSlotIndex)
  }

  for (const reference of [team.slotCode, team.slotLetter]) {
    if (reference === null || reference === undefined || String(reference).trim() === '') continue
    const index = slotIndexFromReference(reference, maxSlots)
    if (index !== null) candidateIndexes.push(index)
  }

  const distinctIndexes = [...new Set(candidateIndexes)]
  if (distinctIndexes.length !== 1) return null

  const slotIndex = distinctIndexes[0]
  const inferredLetter = slotIndex < 26 ? String.fromCharCode(65 + slotIndex) : ''
  const officialSlotCode = String(team.slotCode ?? '').trim()
    || (inferredLetter
      ? `${String(slotIndex + 1).padStart(2, '0')}${inferredLetter}`
      : String(slotIndex + 1))

  const slotAliases = new Set()
  for (const alias of [team.slotCode, team.slotLetter]) {
    const normalized = normalizeIdentifier(alias)
    if (normalized && slotIndexFromReference(alias, maxSlots) === slotIndex) {
      slotAliases.add(normalized)
    }
  }
  slotAliases.add(String(slotIndex + 1))
  if (inferredLetter) {
    slotAliases.add(inferredLetter)
    slotAliases.add(`${slotIndex + 1}${inferredLetter}`)
    slotAliases.add(`${String(slotIndex + 1).padStart(2, '0')}${inferredLetter}`)
  }

  const teamAliases = new Set()
  for (const alias of [team.tag, team.name, `${team.tag ?? ''} ${team.name ?? ''}`]) {
    const normalized = normalizeIdentifier(alias)
    if (normalized) teamAliases.add(normalized)
  }

  return {
    identity: `slot:${slotIndex + 1}`,
    officialSlotCode,
    rosterIndex,
    slotIndex,
    slotAliases,
    teamAliases,
    team,
  }
}

function buildRosterIndex(registeredTeams, maxSlots) {
  const descriptors = []
  const issues = []
  const slotLookup = new Map()
  const teamLookup = new Map()
  const identityLookup = new Map()

  for (let rosterIndex = 0; rosterIndex < registeredTeams.length; rosterIndex++) {
    const team = registeredTeams[rosterIndex]
    const descriptor = rosterSlotDescriptor(team, rosterIndex, maxSlots)
    if (!descriptor) {
      issues.push({
        code: 'invalid_roster_slot',
        message: `Registered team ${rosterIndex + 1} does not have one valid, consistent slot identity.`,
        rosterIndex,
      })
      continue
    }

    const existing = identityLookup.get(descriptor.identity)
    if (existing) {
      issues.push({
        code: 'duplicate_roster_slot',
        message: `Registered teams ${existing.rosterIndex + 1} and ${rosterIndex + 1} share ${descriptor.officialSlotCode}.`,
        rosterIndex,
        otherRosterIndex: existing.rosterIndex,
        slotIdentity: descriptor.identity,
        slotCode: descriptor.officialSlotCode,
      })
    } else {
      identityLookup.set(descriptor.identity, descriptor)
    }

    descriptors.push(descriptor)
    for (const alias of descriptor.slotAliases) addLookupValue(slotLookup, alias, descriptor)
    for (const alias of descriptor.teamAliases) addLookupValue(teamLookup, alias, descriptor)
  }

  return { descriptors, identityLookup, issues, slotLookup, teamLookup }
}

function lookupEntrySlot(entry, rosterIndex, maxSlots) {
  const hasExplicitSlotCode = Object.hasOwn(entry, 'slotCode')
    && entry.slotCode !== null
    && entry.slotCode !== undefined
    && String(entry.slotCode).trim() !== ''
  const hasExplicitSlotIndex = Object.hasOwn(entry, 'slotIndex')
    && entry.slotIndex !== null
    && entry.slotIndex !== undefined
    && entry.slotIndex !== ''

  let matches = []
  let sourceValue = null

  if (hasExplicitSlotCode) {
    sourceValue = entry.slotCode
    matches = uniqueMatches(rosterIndex.slotLookup.get(normalizeIdentifier(entry.slotCode)))
  } else if (hasExplicitSlotIndex) {
    sourceValue = entry.slotIndex
    const numericIndex = Number(entry.slotIndex)
    if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < maxSlots) {
      const descriptor = rosterIndex.identityLookup.get(`slot:${numericIndex + 1}`)
      if (descriptor) matches = [descriptor]
    }
  } else {
    sourceValue = entry.teamQuery ?? entry.tag ?? entry.name ?? null
    const normalizedQuery = normalizeIdentifier(sourceValue)
    matches = uniqueMatches([
      ...(rosterIndex.slotLookup.get(normalizedQuery) ?? []),
      ...(rosterIndex.teamLookup.get(normalizedQuery) ?? []),
    ])
  }

  if (matches.length !== 1) {
    return {
      descriptor: null,
      reason: matches.length > 1 ? 'ambiguous_slot' : 'unknown_slot',
      sourceValue,
    }
  }

  const descriptor = matches[0]

  // If both identity fields are present, both must name the same roster slot.
  // This prevents a stale slotIndex from silently disagreeing with slotCode.
  if (hasExplicitSlotCode && hasExplicitSlotIndex) {
    const numericIndex = Number(entry.slotIndex)
    if (!Number.isInteger(numericIndex) || numericIndex !== descriptor.slotIndex) {
      return { descriptor: null, reason: 'conflicting_slot_identity', sourceValue }
    }
  }

  return { descriptor, reason: null, sourceValue }
}

function invalidInputResult(code, message) {
  return {
    valid: false,
    issues: [{ code, message }],
    resolvedEntries: [],
  }
}

/**
 * Strictly validate one round before it is persisted.
 *
 * Rank and kill values must already be numbers; numeric strings are rejected.
 * An explicit slotCode is authoritative and is never rescued by a team-name
 * match. The returned entries are new objects using the roster's canonical
 * slot/team data, while both input arrays and every input object stay intact.
 */
export function validateTallyRound(
  entries,
  registeredTeams,
  { maxSlots = DEFAULT_TALLY_MAX_SLOTS, requireRosterComplete = false } = {},
) {
  if (!Array.isArray(entries)) {
    return invalidInputResult('invalid_entries', 'Round entries must be an array.')
  }
  if (!Array.isArray(registeredTeams)) {
    return invalidInputResult('invalid_roster', 'Registered teams must be an array.')
  }
  if (!Number.isInteger(maxSlots) || maxSlots < 1) {
    return invalidInputResult('invalid_max_slots', 'maxSlots must be a positive integer.')
  }

  const issues = []
  if (entries.length === 0) {
    issues.push({
      code: 'empty_entries',
      message: 'A round must contain at least one score entry.',
    })
  }
  if (entries.length > maxSlots) {
    issues.push({
      code: 'too_many_entries',
      message: `A round cannot contain more than ${maxSlots} entries.`,
      count: entries.length,
      maxSlots,
    })
  }

  const rosterIndex = buildRosterIndex(registeredTeams, maxSlots)
  issues.push(...rosterIndex.issues)

  const resolvedEntries = []
  const ranks = new Map()
  const slots = new Map()
  let everyRankIsIndividuallyValid = true

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const sourceEntry = entries[entryIndex]
    const isEntryObject = Boolean(sourceEntry)
      && typeof sourceEntry === 'object'
      && !Array.isArray(sourceEntry)
    const entry = isEntryObject ? sourceEntry : {}

    if (!isEntryObject) {
      issues.push({
        code: 'invalid_entry',
        message: `Entry ${entryIndex + 1} must be an object.`,
        entryIndex,
      })
    }

    const rankIsValid = Number.isInteger(entry.rank)
      && entry.rank >= 1
      && entry.rank <= maxSlots
    if (!rankIsValid) {
      everyRankIsIndividuallyValid = false
      issues.push({
        code: 'invalid_rank',
        message: `Entry ${entryIndex + 1} rank must be an integer from 1 through ${maxSlots}.`,
        entryIndex,
        field: 'rank',
        value: entry.rank,
        min: 1,
        max: maxSlots,
      })
    } else if (ranks.has(entry.rank)) {
      issues.push({
        code: 'duplicate_rank',
        message: `Entries ${ranks.get(entry.rank) + 1} and ${entryIndex + 1} both use rank ${entry.rank}.`,
        entryIndex,
        otherEntryIndex: ranks.get(entry.rank),
        field: 'rank',
        value: entry.rank,
        rank: entry.rank,
      })
    } else {
      ranks.set(entry.rank, entryIndex)
    }

    const killsAreValid = Number.isInteger(entry.kills)
      && entry.kills >= 0
      && entry.kills <= MAX_TALLY_KILLS
    if (!killsAreValid) {
      issues.push({
        code: 'invalid_kills',
        message: `Entry ${entryIndex + 1} kills must be an integer from 0 through ${MAX_TALLY_KILLS}.`,
        entryIndex,
        field: 'kills',
        value: entry.kills,
        min: 0,
        max: MAX_TALLY_KILLS,
      })
    }

    const resolution = lookupEntrySlot(entry, rosterIndex, maxSlots)
    let resolvedEntry = { ...entry }
    if (!resolution.descriptor) {
      const code = resolution.reason
      const description = code === 'ambiguous_slot'
        ? 'matches more than one registered team'
        : code === 'conflicting_slot_identity'
          ? 'has conflicting slotCode and slotIndex values'
          : 'does not resolve to a registered team slot'
      issues.push({
        code,
        message: `Entry ${entryIndex + 1} ${description}.`,
        entryIndex,
        field: 'slotCode',
        value: resolution.sourceValue,
      })
    } else {
      const descriptor = resolution.descriptor
      const duplicateEntryIndex = slots.get(descriptor.identity)
      if (duplicateEntryIndex !== undefined) {
        issues.push({
          code: 'duplicate_slot',
          message: `Entries ${duplicateEntryIndex + 1} and ${entryIndex + 1} both resolve to ${descriptor.officialSlotCode}.`,
          entryIndex,
          otherEntryIndex: duplicateEntryIndex,
          field: 'slotCode',
          slotIdentity: descriptor.identity,
          slotCode: descriptor.officialSlotCode,
        })
      } else {
        slots.set(descriptor.identity, entryIndex)
      }

      resolvedEntry = {
        ...entry,
        slotIndex: descriptor.slotIndex,
        slotCode: descriptor.officialSlotCode,
        tag: descriptor.team.tag ?? entry.tag,
        name: descriptor.team.name ?? entry.name,
      }
    }
    resolvedEntries.push(resolvedEntry)
  }

  if (everyRankIsIndividuallyValid && ranks.size === entries.length && entries.length > 0) {
    const actualRanks = [...ranks.keys()].sort((left, right) => left - right)
    const expectedRanks = Array.from({ length: entries.length }, (_, index) => index + 1)
    const missingRanks = expectedRanks.filter((rank) => !ranks.has(rank))
    const unexpectedRanks = actualRanks.filter((rank) => rank > entries.length)
    if (missingRanks.length > 0 || unexpectedRanks.length > 0) {
      issues.push({
        code: 'non_contiguous_ranks',
        message: `Round ranks must be contiguous from 1 through ${entries.length}.`,
        field: 'rank',
        actualRanks,
        expectedRanks,
        missingRanks,
        unexpectedRanks,
      })
    }
  }

  if (requireRosterComplete) {
    const missingTeams = [...rosterIndex.identityLookup.values()]
      .filter((descriptor) => !slots.has(descriptor.identity))
      .map((descriptor) => ({
        rosterIndex: descriptor.rosterIndex,
        slotIdentity: descriptor.identity,
        slotCode: descriptor.officialSlotCode,
        tag: descriptor.team.tag ?? '',
        name: descriptor.team.name ?? '',
      }))
    if (missingTeams.length > 0) {
      issues.push({
        code: 'roster_incomplete',
        message: `Round is missing ${missingTeams.length} registered team${missingTeams.length === 1 ? '' : 's'}.`,
        expectedCount: rosterIndex.identityLookup.size,
        actualResolvedCount: slots.size,
        missingTeams,
      })
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    resolvedEntries,
  }
}

export class TallyValidationError extends Error {
  constructor(result) {
    const summary = result.issues.map((issue) => issue.message).join(' ')
    super(`Invalid tally round. ${summary}`)
    this.name = 'TallyValidationError'
    this.issues = result.issues
    this.result = result
  }
}

/** Return the validation result, or throw a TallyValidationError. */
export function assertValidTallyRound(entries, registeredTeams, options) {
  const result = validateTallyRound(entries, registeredTeams, options)
  if (!result.valid) throw new TallyValidationError(result)
  return result
}

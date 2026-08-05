export const DEFAULT_PLACEMENT_POINTS = Object.freeze({
  1: 20,
  2: 16,
  3: 13,
  4: 10,
  5: 8,
  6: 5,
  7: 5,
  8: 5,
  9: 5,
  10: 5,
  11: 2,
  12: 2,
  13: 2,
  14: 2,
  15: 2,
  16: 1,
  17: 1,
  18: 1,
  19: 0,
  20: 0,
  21: 0,
  22: 0,
  23: 0,
  24: 0,
  25: 0,
})

export function getPlacementPoints(rank, customPoints = DEFAULT_PLACEMENT_POINTS) {
  const numericRank = Number(rank)
  if (!Number.isInteger(numericRank) || numericRank < 1) return 0
  return customPoints[numericRank] ?? 0
}

export function normalizeIdentifier(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toUpperCase()
}

function levenshteinDistance(a, b) {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const nextRow = [i]
    for (let j = 1; j <= b.length; j++) {
      nextRow[j] = Math.min(
        nextRow[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    row = nextRow
  }
  return row[b.length]
}

/**
 * True when a normalized string is a lobby slot reference — a letter ("W"),
 * a slot code ("23W"), or a slot number ("23") — rather than a team name.
 */
export function isSlotDesignator(normalized) {
  const value = String(normalized || '')
  if (/^[A-Y]$/.test(value)) return true
  const numbered = /^(\d{1,2})([A-Y])?$/.exec(value)
  if (!numbered) return false
  const index = Number(numbered[1])
  return index >= 1 && index <= 25
}

export function findMatchingTeam(query, registeredTeams = [], explicitSlot = null) {
  if (registeredTeams.length === 0) return null

  // 1. Explicit slot parameter matching (e.g. '23W', 'W', '23-W')
  if (explicitSlot) {
    const expTarget = normalizeIdentifier(String(explicitSlot).trim())
    if (expTarget) {
      const explicitMatch = registeredTeams.find((t) => {
        const sLetter = normalizeIdentifier(t.slotLetter)
        const sCode = normalizeIdentifier(t.slotCode)
        const sNumLetter = normalizeIdentifier(`${t.slotIndex + 1}${t.slotLetter}`)
        return expTarget === sLetter || expTarget === sCode || expTarget === sNumLetter
      })
      if (explicitMatch) return explicitMatch

      // The slot code is authoritative. If it names a real lobby slot that no
      // registered team holds, this row belongs to nobody — falling through to
      // fuzzy name matching is how an empty slot's score gets written onto an
      // unrelated team.
      if (isSlotDesignator(expTarget)) return null
    }
  }

  if (!query) return null
  const rawStr = String(query).trim()
  const target = normalizeIdentifier(rawStr)
  if (!target) return null

  // 2. Exact match by slot letter (A, B, C... W) or slot code (01A, 23W...) or alternate formats (23W, 23-W)
  const slotMatch = registeredTeams.find((t) => {
    const sLetter = normalizeIdentifier(t.slotLetter)
    const sCode = normalizeIdentifier(t.slotCode)
    const sNumLetter = normalizeIdentifier(`${t.slotIndex + 1}${t.slotLetter}`)
    return target === sLetter || target === sCode || target === sNumLetter
  })
  if (slotMatch) return slotMatch

  // 3. Numeric slot index match (e.g. query "23" maps to slotIndex 22)
  const numMatch = target.match(/^(\d{1,2})$/)
  if (numMatch) {
    const slotIdx = Number(numMatch[1]) - 1
    const teamBySlot = registeredTeams.find((t) => t.slotIndex === slotIdx)
    if (teamBySlot) return teamBySlot
  }

  // 4. Exact match by tag or name or combined tag+name
  const exactMatch = registeredTeams.find(
    (t) =>
      normalizeIdentifier(t.tag) === target ||
      normalizeIdentifier(t.name) === target ||
      normalizeIdentifier(`${t.tag} ${t.name}`) === target,
  )
  if (exactMatch) return exactMatch

  // 5. Partial match (starts with or includes tag or name)
  const partialMatch = registeredTeams.find(
    (t) =>
      (normalizeIdentifier(t.tag) && (normalizeIdentifier(t.tag).startsWith(target) || target.startsWith(normalizeIdentifier(t.tag)))) ||
      (normalizeIdentifier(t.name) && (normalizeIdentifier(t.name).includes(target) || target.includes(normalizeIdentifier(t.name)))),
  )
  if (partialMatch) return partialMatch

  // 6. Fuzzy Levenshtein match
  let bestTeam = null
  let bestDistance = Infinity
  for (const team of registeredTeams) {
    const tagNorm = normalizeIdentifier(team.tag)
    const nameNorm = normalizeIdentifier(team.name)
    const distTag = tagNorm ? levenshteinDistance(target, tagNorm) : Infinity
    const distName = nameNorm ? levenshteinDistance(target, nameNorm) : Infinity
    const minDist = Math.min(distTag, distName)
    if (minDist < bestDistance && minDist <= 3) {
      bestDistance = minDist
      bestTeam = team
    }
  }

  return bestTeam
}

/**
 * Screenshot rows that resolve to no registered team, and so will not be
 * scored. Returned as readable labels for the review message, because a row
 * silently vanishing between the screenshot and the sheet looks like a bug.
 */
export function findUnmatchedEntries(entries = [], registeredTeams = []) {
  if (!Array.isArray(entries) || registeredTeams.length === 0) return []
  return entries
    .filter(
      (entry) =>
        !findMatchingTeam(
          entry.slotCode || entry.teamQuery || entry.tag || entry.name,
          registeredTeams,
          entry.slotCode,
        ),
    )
    .map((entry) => {
      const slot = String(entry.slotCode || '').trim()
      const label = String(entry.teamQuery || entry.name || entry.tag || '').trim()
      if (slot && slot !== '??') return `slot ${slot}${label && label !== slot ? ` (${label})` : ''}`
      return label || 'unreadable row'
    })
}

export class TallyBoard {
  constructor(placementPoints = DEFAULT_PLACEMENT_POINTS) {
    this.placementPoints = placementPoints
    this.rounds = new Map()
  }

  clear() {
    this.rounds.clear()
  }

  getRound(roundNumber) {
    return this.rounds.get(Number(roundNumber)) ?? []
  }

  setRound(roundNumber, entries, registeredTeams = [], sourceMessageId = null) {
    const roundNum = Number(roundNumber)
    const rawProcessed = entries
      .map((entry) => {
        const rank = Number(entry.rank || 0)
        const kills = Math.max(0, Number(entry.kills || 0))
        const matched = findMatchingTeam(
          entry.slotCode || entry.teamQuery || entry.tag || entry.name,
          registeredTeams,
          entry.slotCode,
        )

        // Strict non-negotiable rule: Discard any entry not registered on the team slot board
        if (registeredTeams.length > 0 && !matched) {
          return null
        }

        const tag = matched ? matched.tag : (entry.tag || entry.teamQuery || 'UNK')
        const name = matched ? matched.name : (entry.name || entry.teamQuery || 'Unknown Team')
        const slotCode = matched ? matched.slotCode : (entry.slotCode || '??')

        const placementPts = getPlacementPoints(rank, this.placementPoints)
        const totalPts = placementPts + kills

        return {
          rank,
          teamQuery: entry.teamQuery || `${tag} ${name}`,
          slotCode,
          tag,
          name,
          kills,
          placementPoints: placementPts,
          killPoints: kills,
          totalPoints: totalPts,
          sourceMessageId,
        }
      })
      .filter(Boolean)

    // Deduplicate entries by matched slotCode / team identity
    const seenSlots = new Map()
    const deduplicated = []

    // Sort by rank ascending first so best placement comes first
    rawProcessed.sort((a, b) => a.rank - b.rank)

    for (const item of rawProcessed) {
      const key = item.slotCode !== '??' ? item.slotCode : `${item.tag}:${item.name}`
      
      // If we already saw this slot/team, keep the one with better (lower) rank
      if (seenSlots.has(key)) {
        continue
      }

      // If another team was already assigned this exact rank, re-assign rank if unmapped
      seenSlots.set(key, item)
      deduplicated.push(item)
    }

    this.rounds.set(roundNum, deduplicated)
    return deduplicated
  }

  correctScore(roundNumber, teamQuery, newPlacement, newKills, registeredTeams = []) {
    const roundNum = Number(roundNumber)
    const round = [...this.getRound(roundNum)]
    const matched = findMatchingTeam(teamQuery, registeredTeams)
    const targetKey = matched
      ? matched.slotCode
      : normalizeIdentifier(teamQuery)

    const existingIndex = round.findIndex(
      (entry) =>
        (matched && entry.slotCode === matched.slotCode) ||
        normalizeIdentifier(entry.tag) === targetKey ||
        normalizeIdentifier(entry.name) === targetKey ||
        normalizeIdentifier(entry.teamQuery) === targetKey,
    )

    const rank = Number(newPlacement)
    const kills = Math.max(0, Number(newKills))
    const placementPts = getPlacementPoints(rank, this.placementPoints)
    const totalPts = placementPts + kills

    const updatedEntry = {
      rank,
      teamQuery: teamQuery,
      slotCode: matched ? matched.slotCode : '??',
      tag: matched ? matched.tag : teamQuery.slice(0, 4).toUpperCase(),
      name: matched ? matched.name : teamQuery,
      kills,
      placementPoints: placementPts,
      killPoints: kills,
      totalPoints: totalPts,
    }

    if (existingIndex >= 0) {
      round[existingIndex] = updatedEntry
    } else {
      round.push(updatedEntry)
    }

    this.rounds.set(roundNum, round)
    return updatedEntry
  }

  getOverallStandings(registeredTeams = []) {
    const teamMap = new Map()

    for (const team of registeredTeams) {
      teamMap.set(team.slotCode, {
        slotCode: team.slotCode,
        tag: team.tag,
        name: team.name,
        rounds: {},
        totalKills: 0,
        totalPlacementPoints: 0,
        totalPoints: 0,
      })
    }

    for (const [roundNum, entries] of this.rounds.entries()) {
      for (const entry of entries) {
        const key = entry.slotCode !== '??' ? entry.slotCode : `${entry.tag}_${entry.name}`
        if (!teamMap.has(key)) {
          teamMap.set(key, {
            slotCode: entry.slotCode,
            tag: entry.tag,
            name: entry.name,
            rounds: {},
            totalKills: 0,
            totalPlacementPoints: 0,
            totalPoints: 0,
          })
        }

        const teamStats = teamMap.get(key)
        teamStats.rounds[roundNum] = {
          rank: entry.rank,
          kills: entry.kills,
          placementPoints: entry.placementPoints,
          totalPoints: entry.totalPoints,
        }
        teamStats.totalKills += entry.kills
        teamStats.totalPlacementPoints += entry.placementPoints
        teamStats.totalPoints += entry.totalPoints
      }
    }

    const standings = [...teamMap.values()]

    standings.sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints
      if (b.totalKills !== a.totalKills) return b.totalKills - a.totalKills
      return b.totalPlacementPoints - a.totalPlacementPoints
    })

    return standings.map((item, index) => ({
      overallRank: index + 1,
      ...item,
    }))
  }

  formatStandingsMarkdown(registeredTeams = [], title = 'PHGG SCRIM OVERALL STANDINGS') {
    const rawStandings = this.getOverallStandings(registeredTeams)
    const standings = rawStandings
      .filter((t) => Object.keys(t.rounds).length > 0)
      .map((item, index) => ({ ...item, overallRank: index + 1 }))
    const activeRounds = [...this.rounds.keys()].sort((a, b) => a - b)

    if (standings.length === 0) {
      return `📊 **${title}**\n*No score tallies recorded yet for this scrim session.*`
    }

    const lines = [
      `🏆 **${title}**`,
      `*Active Rounds: ${activeRounds.length > 0 ? activeRounds.join(', ') : 'None'} | Total Teams: ${standings.length}*`,
      '```',
      `RK  SLOT  TEAM                              KILLS  WWCD  PTS`,
      `──────────────────────────────────────────────────────────────`,
    ]

    for (const team of standings) {
      const rk = String(team.overallRank).padStart(2, ' ')
      const slot = String(team.slotCode).padEnd(4, ' ')
      const displayName = team.tag ? `[${team.tag}] ${team.name}` : team.name
      const nameCol = displayName.slice(0, 32).padEnd(32, ' ')
      const kills = String(team.totalKills).padStart(5, ' ')
      const wwcdCount = Object.values(team.rounds).filter((r) => r.rank === 1).length
      const wwcd = String(wwcdCount).padStart(4, ' ')
      const pts = String(team.totalPoints).padStart(4, ' ')

      lines.push(`${rk}  ${slot}  ${nameCol}  ${kills}  ${wwcd}  ${pts}`)
    }

    lines.push('```')

    if (standings.length > 0) {
      const topTeam = standings[0]
      const topName = topTeam.tag ? `[${topTeam.tag}] ${topTeam.name}` : topTeam.name
      lines.push(`🌟 **Current Leader**: 🥇 **${topName}** with **${topTeam.totalPoints} PTS** (${topTeam.totalKills} Kills)`)
    }

    return lines.join('\n')
  }
}

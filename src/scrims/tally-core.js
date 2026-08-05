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
 * Custom server emoji used in the tally messages.
 *
 * A `<:name:id>` tag only renders if the BOT shares a server with that emoji.
 * Three of these did not, and showed up as literal ":sheet:" text, so they are
 * given as CDN links instead.
 *
 * Be aware: a bare URL in message content is a link, not an inline image.
 * Discord will not draw it beside the text the way a real emoji tag does. The
 * only ways to get a true inline emoji are to add the bot to the server that
 * owns it, or re-upload the emoji to a server the bot is already in — at which
 * point set the env var back to a `<:name:id>` tag.
 *
 * Each can be overridden with an env var, so swapping one does not need a code
 * change — set e.g. TALLY_EMOJI_CONFIRMED='<:yes:123456789>'.
 */
export const TALLY_EMOJI = {
  // This one resolves in-server today, so it stays as a real emoji tag.
  confirmed: process.env.TALLY_EMOJI_CONFIRMED || '<:confirmed:1472902880120934431>',
  // These two did not resolve — they rendered as literal ":standings:" text —
  // so they are written as CDN links instead. See the note above about how
  // Discord treats a bare URL in message content.
  standings:
    process.env.TALLY_EMOJI_STANDINGS ||
    'https://cdn.discordapp.com/emojis/1388436342257487872.webp?size=32&animated=true',
  leader:
    process.env.TALLY_EMOJI_LEADER ||
    'https://cdn.discordapp.com/emojis/1387891022104760501.webp?size=32&animated=true',
}

/**
 * A code-block table sized to its contents.
 *
 * Fixed-width padding made every table as wide as the widest name it could
 * ever hold, so the block ran far past the text and forced a sideways scroll
 * on narrow windows. Each column is now only as wide as its widest cell.
 */
export function renderAlignedTable(columns, rows, { fenced = false } = {}) {
  const widths = columns.map((col) =>
    Math.max(col.label.length, ...rows.map((row) => String(row[col.key] ?? '').length)),
  )
  const pad = (value, i) =>
    columns[i].align === 'right'
      ? String(value ?? '').padStart(widths[i])
      : String(value ?? '').padEnd(widths[i])

  const header = columns.map((col, i) => pad(col.label, i)).join('  ')
  const body = rows.map((row) => columns.map((col, i) => pad(row[col.key], i)).join('  '))

  if (fenced) {
    return ['```', header, '─'.repeat(header.length), ...body, '```'].join('\n')
  }

  // A ``` block is a full-width element in Discord: its grey container spans
  // the whole message area no matter how narrow the table is. Inline code spans
  // keep the monospace alignment but hug the text, so the block ends where the
  // columns do.
  return [`\`${header}\``, ...body.map((line) => `\`${line}\``)].join('\n')
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

  /**
   * Standings for the teams actually taking part.
   *
   * A registered team that has not appeared in a single round has not played,
   * and listing it on 0/0/0 pads the board with teams that were never in the
   * lobby. Pass includeUnplayed to get the full roster instead. Note that a
   * team which placed last with no kills HAS played, and still appears.
   */
  getOverallStandings(registeredTeams = [], { includeUnplayed = false } = {}) {
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

    const standings = [...teamMap.values()].filter(
      (team) => includeUnplayed || Object.keys(team.rounds).length > 0,
    )

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
      `${TALLY_EMOJI.standings} **${title}**`,
      `*Active Rounds: ${activeRounds.length > 0 ? activeRounds.join(', ') : 'None'} | Total Teams: ${standings.length}*`,
      renderAlignedTable(
        [
          { key: 'rk', label: 'RANK', align: 'right' },
          { key: 'slot', label: 'SLOT' },
          { key: 'team', label: 'TEAM' },
          { key: 'kills', label: 'KILLS', align: 'right' },
          { key: 'pts', label: 'PTS', align: 'right' },
        ],
        standings.map((team) => ({
          rk: team.overallRank,
          slot: team.slotCode,
          team: (team.tag ? `[${team.tag}] ${team.name}` : team.name).slice(0, 32),
          kills: team.totalKills,
          pts: team.totalPoints,
        })),
      ),
    ]

    if (standings.length > 0) {
      const topTeam = standings[0]
      const topName = topTeam.tag ? `[${topTeam.tag}] ${topTeam.name}` : topTeam.name
      lines.push(`${TALLY_EMOJI.leader} **Current Leader**: **${topName}** with **${topTeam.totalPoints} PTS** (${topTeam.totalKills} Kills)`)
    }

    return lines.join('\n')
  }
}

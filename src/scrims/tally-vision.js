/** Parse the manual text-score formats supported alongside screenshots. */
export function parseTextScoreInput(text) {
  const content = String(text ?? '').trim()
  if (!content) return { roundNumber: 1, entries: [] }

  let roundNumber = 1
  const roundMatch = content.match(/\bROUND\s*#?(\d+)\b/i)
  if (roundMatch) roundNumber = Number(roundMatch[1])

  const entries = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^`+/, '').replace(/`+$/, '').trim()
    if (!trimmed || /\bROUND\s*#?\d+\b/i.test(trimmed)) continue

    // Skip table header lines and markdown dividers
    if (/^(?:RK|RANK|PLACE|POS)\s+SLOT\b/i.test(trimmed) || /^[─\-=\s|]+$/.test(trimmed)) {
      continue
    }

    // 1. Tabular / multi-token lines: e.g. "1 04D 98 118" or "1 | 04D | 98 | 118" or "#1 04D 98"
    const tokens = trimmed.split(/[\s|,\t]+/).map((t) => t.trim()).filter(Boolean)
    const firstTokenRankMatch = /^(?:#|RANK\s*)?(\d+)$/i.exec(tokens[0] || '')
    if (firstTokenRankMatch && tokens.length >= 3) {
      const rank = Number(firstTokenRankMatch[1])
      let rawTeam = tokens[1]
      if (/^150$/i.test(rawTeam)) rawTeam = '15O'
      if (/^15-0$/i.test(rawTeam)) rawTeam = '15-O'

      // 4-token row: rank slot kills pts (e.g. 1 04D 98 118)
      // 3-token row: rank slot kills (e.g. 1 04D 98)
      const killsTokenIdx = tokens.length >= 4 && /^\d+$/.test(tokens[2]) && /^\d+$/.test(tokens[3]) ? 2 : tokens.length - 1
      const killsVal = Number(tokens[killsTokenIdx])

      if (rank >= 1 && Number.isInteger(killsVal) && killsVal >= 0) {
        entries.push({ rank, teamQuery: rawTeam, kills: killsVal, isManual: true })
        continue
      }
    }

    // 2. 2-token row: slot/team kills (e.g. "2B 25" or "02B 25" or "05E 10")
    if (tokens.length === 2) {
      let rawTeam = tokens[0]
      const killsVal = Number(tokens[1])
      if (/^150$/i.test(rawTeam)) rawTeam = '15O'
      if (/^15-0$/i.test(rawTeam)) rawTeam = '15-O'

      if (rawTeam && Number.isInteger(killsVal) && killsVal >= 0) {
        entries.push({ rank: null, teamQuery: rawTeam, kills: killsVal, isManual: true })
        continue
      }
    }

    // 3. #1 NR - NIGHTRAID | 12 KILLS or 1. NR - NIGHTRAID - 12 KILLS
    const plain = /^(?:#|RANK\s*)?(\d+)[.\s\-:]+\s*(.+?)\s*(?:[|\-:]\s*)?(\d+)\s*(?:KILLS?|K|PTS?|POINTS?)?$/i.exec(trimmed)
    if (plain) {
      const rank = Number(plain[1])
      let teamQuery = plain[2].replace(/[|\-:]\s*$/, '').trim()
      const kills = Number(plain[3])
      if (/^150$/i.test(teamQuery)) teamQuery = '15O'
      if (/^15-0$/i.test(teamQuery)) teamQuery = '15-O'
      if (rank >= 1 && teamQuery) {
        entries.push({ rank, teamQuery, kills, isManual: true })
        continue
      }
    }

    // 4. 1-NR (12) or #1 NR (12 KILLS)
    const parenthesized = /^(?:#|RANK\s*)?(\d+)[.\s\-:]+\s*(.+?)\s*\(\s*(\d+)\s*(?:KILLS?|K)?\s*\)$/i.exec(trimmed)
    if (parenthesized) {
      const rank = Number(parenthesized[1])
      let teamQuery = parenthesized[2].trim()
      const kills = Number(parenthesized[3])
      if (/^150$/i.test(teamQuery)) teamQuery = '15O'
      if (/^15-0$/i.test(teamQuery)) teamQuery = '15-O'
      if (rank >= 1 && teamQuery) entries.push({ rank, teamQuery, kills, isManual: true })
    }
  }

  return { roundNumber, entries }
}

// Backward-compatible export for callers that imported both readers here.
export { parseScreenshotWithGemini } from './tally-gemini.js'

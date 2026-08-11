/** Parse the manual text-score formats supported alongside screenshots. */
export function parseTextScoreInput(text) {
  const content = String(text ?? '').trim()
  if (!content) return { roundNumber: 1, entries: [] }

  let roundNumber = 1
  const roundMatch = content.match(/\bROUND\s*#?(\d+)\b/i)
  if (roundMatch) roundNumber = Number(roundMatch[1])

  const entries = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || /\bROUND\s*#?\d+\b/i.test(trimmed)) continue

    // #1 NR - NIGHTRAID | 12 KILLS or 1. NR - NIGHTRAID - 12 KILLS
    const plain = /^(?:#|RANK\s*)?(\d+)[.\s\-:]+\s*(.+?)\s*(?:[|\-:]\s*)?(\d+)\s*(?:KILLS?|K|PTS?|POINTS?)?$/i.exec(trimmed)
    if (plain) {
      const rank = Number(plain[1])
      const teamQuery = plain[2].replace(/[|\-:]\s*$/, '').trim()
      const kills = Number(plain[3])
      if (rank >= 1 && teamQuery) {
        entries.push({ rank, teamQuery, kills })
        continue
      }
    }

    // 1-NR (12) or #1 NR (12 KILLS)
    const parenthesized = /^(?:#|RANK\s*)?(\d+)[.\s\-:]+\s*(.+?)\s*\(\s*(\d+)\s*(?:KILLS?|K)?\s*\)$/i.exec(trimmed)
    if (parenthesized) {
      const rank = Number(parenthesized[1])
      const teamQuery = parenthesized[2].trim()
      const kills = Number(parenthesized[3])
      if (rank >= 1 && teamQuery) entries.push({ rank, teamQuery, kills })
    }
  }

  return { roundNumber, entries }
}

// Backward-compatible export for callers that imported both readers here.
export { parseScreenshotWithGemini } from './tally-gemini.js'

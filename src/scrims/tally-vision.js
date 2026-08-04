export function parseTextScoreInput(text) {
  const content = String(text ?? '').trim()
  if (!content) return { roundNumber: 1, entries: [] }

  let roundNumber = 1
  const roundMatch = content.match(/\bROUND\s*#?(\d+)\b/i)
  if (roundMatch) {
    roundNumber = Number(roundMatch[1])
  }

  const entries = []
  const lines = content.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || /\bROUND\s*#?\d+\b/i.test(trimmed)) continue

    // Pattern 1: #1 NR - NIGHTRAID | 12 KILLS or 1. NR - NIGHTRAID - 12 KILLS
    const match1 = /^(?:#|RANK\s*)?(\d+)[.\s\-\:]+\s*(.+?)\s*(?:[|\-:]\s*)?(\d+)\s*(?:KILLS?|K|PTS?|POINTS?)?$/i.exec(trimmed)
    if (match1) {
      const rank = Number(match1[1])
      const teamQuery = match1[2].replace(/[|\-:]\s*$/, '').trim()
      const kills = Number(match1[3])
      if (rank >= 1 && teamQuery) {
        entries.push({ rank, teamQuery, kills })
        continue
      }
    }

    // Pattern 2: 1-NR (12) or #1 NR (12 KILLS)
    const match2 = /^(?:#|RANK\s*)?(\d+)[.\s\-\:]+\s*(.+?)\s*\(\s*(\d+)\s*(?:KILLS?|K)?\s*\)$/i.exec(trimmed)
    if (match2) {
      const rank = Number(match2[1])
      const teamQuery = match2[2].trim()
      const kills = Number(match2[3])
      if (rank >= 1 && teamQuery) {
        entries.push({ rank, teamQuery, kills })
      }
    }
  }

  return { roundNumber, entries }
}

export async function parseScreenshotWithGemini({
  buffer,
  mimeType = 'image/png',
  images = [],
  apiKey = process.env.GEMINI_API_KEY,
  modelName = process.env.GEMINI_VISION_MODEL || 'gemini-3.5-flash',
}) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.')
  }

  const imageList = images.length > 0
    ? images
    : (buffer ? [{ buffer, mimeType }] : [])

  if (imageList.length === 0) {
    throw new Error('No image buffers provided for Gemini Vision parsing.')
  }

  const imageParts = imageList.map((item) => ({
    inlineData: {
      mimeType: item.mimeType || 'image/png',
      data: item.buffer.toString('base64'),
    },
  }))

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`

  const promptText = `
You are an expert esports tournament scorekeeper analyzing Bloodstrike / PUBG / PC Battle Royale endgame scoreboard screenshots.
These screenshots may be multi-part images of the same endgame leaderboard (e.g. Image 1 shows ranks 1-10, Image 2 shows ranks 11-20, Image 3 shows ranks 21-25).

EXACT VISUAL MAPPING INSTRUCTIONS:
1. TEAM PLACE (RANK): The placement number "1" to "25" at the start of each row.
2. TEAM SLOT CODE / LETTER: The slot code or slot letter (e.g. "01A", "02B", "03C"... or "1-A", "2-B"... or single letters "A", "B", "C"..."Y").
3. TEAM KILLS: The number displayed next to the SKULL ICON (💀) or under the KILLS/ELIMS header.
   - DO NOT extract Total Score, Points, or Damage as Kills!
   - Kills is strictly the number next to the SKULL ICON (💀) or ELIMS column.
4. STRICT NO-DUPLICATE RULE:
   - Extract each team/slot AT MOST ONCE.
   - Once a team/slot or rank is extracted from an image, DO NOT extract it again if it appears in another overlapping photo.
5. NO HALLUCINATIONS:
   - Extract only the exact visible slot code/letter, placement rank, and skull icon kill count.

Extract:
- roundNumber: integer (default to 1 if not explicitly shown as Round 1, Round 2, Round 3, Round 4, etc.)
- teams: array of objects with:
  - rank: integer (1 to 25)
  - slotCode: string (e.g. "01A", "02B", "1-A", "2-B", or "A", "B", "C")
  - teamName: string (team tag or name if shown on screen)
  - kills: integer (the number next to the SKULL ICON 💀 or KILLS column)

Respond ONLY with valid JSON in this format, without markdown wrapping:
{
  "roundNumber": 1,
  "teams": [
    { "rank": 1, "slotCode": "01A", "teamName": "NR NIGHTRAID", "kills": 12 },
    { "rank": 2, "slotCode": "02B", "teamName": "SS RAMPAGE", "kills": 8 }
  ]
}
`

  const payload = {
    contents: [
      {
        parts: [
          { text: promptText },
          ...imageParts,
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  }

  const candidateModels = [
    modelName,
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ].filter((m, i, arr) => arr.indexOf(m) === i)

  let lastError = null

  for (const currentModel of candidateModels) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })

        if (!response.ok) {
          const errorText = await response.text()
          if (response.status === 503 || response.status === 429 || response.status === 500) {
            console.warn(`Gemini API ${currentModel} returned ${response.status} (attempt ${attempt}): ${errorText}`)
            lastError = new Error(`Gemini API error (${response.status}): ${errorText}`)
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
            continue
          }
          throw new Error(`Gemini API error (${response.status}): ${errorText}`)
        }

        const data = await response.json()
        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text
        if (!textResponse) {
          throw new Error('Gemini API returned an empty response.')
        }

        const cleanJson = textResponse.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
        const parsed = JSON.parse(cleanJson)

        const roundNumber = Number(parsed.roundNumber || 1)
        const entries = (parsed.teams || [])
          .map((t) => ({
            rank: Number(t.rank || 0),
            slotCode: String(t.slotCode || t.slot || '').trim(),
            teamQuery: String(t.slotCode || t.teamName || t.tag || '').trim(),
            kills: Math.max(0, Number(t.kills || 0)),
          }))
          .filter((e) => e.rank > 0 && (e.slotCode || e.teamQuery))

        return { roundNumber, entries }
      } catch (err) {
        lastError = err
        if (!err.message.includes('503') && !err.message.includes('429') && !err.message.includes('500')) {
          throw err
        }
      }
    }
  }

  throw lastError || new Error('All Gemini Vision model endpoints failed after retries.')
}

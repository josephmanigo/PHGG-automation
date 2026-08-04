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

async function getAvailableGeminiModels(apiKey) {
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    const res = await fetch(listUrl)
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data.models)) return []

    return data.models
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean)
  } catch (err) {
    console.warn('[TALLY] Failed to query dynamic model list:', err.message)
    return []
  }
}

export async function parseScreenshotWithGemini({
  buffer,
  mimeType = 'image/png',
  images = [],
  apiKey = process.env.GEMINI_API_KEY,
  modelName = process.env.GEMINI_VISION_MODEL || 'gemini-2.0-flash',
}) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.')
  }

  const imageList = images.length > 0
    ? images
    : (buffer ? [{ buffer, mimeType }] : [])

  if (imageList.length === 0) {
    throw new Error('No image buffer or base64 images provided for Gemini vision parsing.')
  }

  const contentsParts = [
    {
      text: `You are an expert esports tournament scorekeeper. Extract the endgame score data from the provided Bloodstrike / Mobile / PC battle royale endgame screenshot.

Return ONLY a valid JSON object (no markdown, no explanatory text) with this exact schema:
{
  "roundNumber": 1,
  "teams": [
    {
      "rank": 1,
      "slotCode": "01A",
      "teamName": "TEAM NAME",
      "kills": 12
    }
  ]
}

Rules:
1. "roundNumber": Integer (default to 1 if not explicitly shown on the screenshot).
2. "rank": Placement integer (1 for #1 / Victory, 2 for #2, etc.).
3. "slotCode": Look for team slot codes if visible (e.g., "1-A", "01A", "2-B", "02B", "25-Y"). If not visible, return empty string "".
4. "teamName": The team name or clan tag displayed.
5. "kills": Total team kills integer.
6. Extract ALL teams visible in the endgame results list.`,
    },
  ]

  for (const img of imageList) {
    let base64Data = img.base64
    let imgMime = img.mimeType || mimeType

    if (!base64Data && img.buffer) {
      base64Data = img.buffer.toString('base64')
    }

    if (base64Data) {
      contentsParts.push({
        inlineData: {
          mimeType: imgMime,
          data: base64Data,
        },
      })
    }
  }

  const payload = {
    contents: [{ parts: contentsParts }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  }

  const requestedModel = String(modelName || '').trim()

  const candidateModels = [
    requestedModel,
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro',
    'gemini-1.5-pro-latest',
  ]
    .filter(Boolean)
    .filter((m, i, arr) => arr.indexOf(m) === i)

  let lastError = null
  let dynamicModelsFetched = false

  for (let i = 0; i < candidateModels.length; i++) {
    const currentModel = candidateModels[i]
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
          console.warn(`Gemini API model "${currentModel}" returned HTTP ${response.status} (attempt ${attempt}): ${errorText}`)
          lastError = new Error(`Gemini API error (${response.status}): ${errorText}`)

          // If 404, dynamically query Google API for active model names supported by this API key
          if (response.status === 404 && !dynamicModelsFetched) {
            dynamicModelsFetched = true
            const liveModels = await getAvailableGeminiModels(apiKey)
            if (liveModels.length > 0) {
              console.log(`[TALLY] Dynamically discovered active models for this API key: ${liveModels.join(', ')}`)
              for (const lm of liveModels) {
                if (!candidateModels.includes(lm)) {
                  candidateModels.push(lm)
                }
              }
            }
          }

          if ((response.status === 503 || response.status === 429 || response.status === 500) && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
            continue
          }
          break
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
        console.warn(`Attempt ${attempt} for model "${currentModel}" failed: ${err.message}`)
        lastError = err
      }
    }
  }

  throw lastError || new Error('All Gemini Vision model endpoints failed after retries.')
}

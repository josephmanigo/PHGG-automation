import { Jimp } from 'jimp'
import { createWorker, PSM } from 'tesseract.js'
import { readCapture } from './tally-glyphs.js'
import atlas from './glyph-atlas.json' with { type: 'json' }

/**
 * Local scoreboard OCR. No API key, no quota, no per-request call to a model
 * provider — Tesseract runs in-process.
 *
 * The Bloodstrike endgame screen is a grid, not a text table. One team row is:
 *
 *   [rank badge] [slot letter] [skull] [TEAM kills] | player1 ... player4
 *
 * Only the narrow strip on the left is worth reading. Everything to the right
 * is four player cells, each with its own kill count — reading the whole row
 * would pick up a player's kills instead of the team's total.
 *
 * The slot letter is what makes this reliable: it maps straight onto a sheet
 * slot (A -> 1-A, Y -> 25-Y), so no team-name recognition is needed at all.
 */

const WORKER_IDLE_TIMEOUT_MS = Number(process.env.OCR_WORKER_IDLE_MS || 5 * 60 * 1000)
const MIN_STRIP_WIDTH = Number(process.env.OCR_MIN_STRIP_WIDTH || 480)

// Fraction of image width holding rank + slot letter + team kills. Measured at
// ~160px on 1135px-wide captures; the margin is deliberate.
export const DEFAULT_LEFT_STRIP_RATIO = Number(process.env.OCR_LEFT_STRIP_RATIO || 0.17)

// 25 slots, A..Y, matching rows 8..32 of the scoresheet.
export const SLOT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXY'
const MAX_RANK = SLOT_LETTERS.length
const MAX_PLAUSIBLE_KILLS = 200

let workerPromise = null
let idleTimer = null

function touchIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    releaseOcrWorker().catch(() => {})
  }, WORKER_IDLE_TIMEOUT_MS)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng')
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        // The strip only ever holds digits, a slot letter and the "#" prefix.
        // Constraining the alphabet cuts the usual O/0 and I/1 confusions.
        tessedit_char_whitelist: `#0123456789${SLOT_LETTERS}`,
      })
      return worker
    })().catch((err) => {
      workerPromise = null
      throw err
    })
  }
  touchIdleTimer()
  return workerPromise
}

export async function releaseOcrWorker() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const pending = workerPromise
  workerPromise = null
  if (!pending) return
  try {
    const worker = await pending
    await worker.terminate()
  } catch {
    // Already gone.
  }
}

export function slotCodeFromLetter(letter) {
  const normalized = String(letter || '').toUpperCase()
  // Guard the length first: "".indexOf is 0, which would silently map an
  // empty read onto slot 1-A.
  if (normalized.length !== 1) return null
  const index = SLOT_LETTERS.indexOf(normalized)
  if (index === -1) return null
  return `${index + 1}-${normalized}`
}

/**
 * Crop to the left strip and make it legible: light-on-dark game UI inverted to
 * dark-on-light, contrast pushed, and upscaled because the glyphs are small.
 */
export async function preprocessLeftStrip(buffer, { stripRatio = DEFAULT_LEFT_STRIP_RATIO } = {}) {
  const image = await Jimp.fromBuffer(buffer)
  const stripWidth = Math.max(1, Math.round(image.bitmap.width * stripRatio))

  image.crop({ x: 0, y: 0, w: stripWidth, h: image.bitmap.height })
  if (image.bitmap.width < MIN_STRIP_WIDTH) {
    image.scale(Math.min(4, MIN_STRIP_WIDTH / image.bitmap.width))
  }
  image.greyscale()
  image.invert()
  image.contrast(0.4)

  return image.getBuffer('image/png')
}

/** tesseract.js v7 nests results as blocks > paragraphs > lines > words. */
export function flattenWords(data) {
  const words = []
  for (const block of data?.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          const text = String(word.text || '').trim()
          if (!text) continue
          const bbox = word.bbox || {}
          words.push({
            text,
            confidence: Number(word.confidence ?? 0),
            x: Number(bbox.x0 ?? 0),
            yCenter: (Number(bbox.y0 ?? 0) + Number(bbox.y1 ?? 0)) / 2,
          })
        }
      }
    }
  }
  return words
}

/**
 * Cluster words into visual rows by vertical position. Row pitch is ~92px on a
 * 1135px-wide capture, so a generous fraction of that separates rows safely.
 */
export function groupWordsIntoRows(words, rowTolerance) {
  const sorted = [...words].sort((a, b) => a.yCenter - b.yCenter)
  const rows = []

  for (const word of sorted) {
    const current = rows[rows.length - 1]
    if (current && Math.abs(word.yCenter - current.yCenter) <= rowTolerance) {
      current.words.push(word)
      current.yCenter = current.words.reduce((s, w) => s + w.yCenter, 0) / current.words.length
    } else {
      rows.push({ yCenter: word.yCenter, words: [word] })
    }
  }

  return rows.map((row) => ({
    yCenter: row.yCenter,
    words: row.words.sort((a, b) => a.x - b.x),
  }))
}

/**
 * Read one strip row. Tokens run left to right as rank, slot letter, kills, so
 * position decides the meaning rather than pattern matching — that is what
 * keeps slot "I" from being read as rank "1", and vice versa.
 *
 * Ranks 1-3 are medal badges rather than "#N" text; when the rank is missing
 * the row is still returned so the caller can infer it from row order.
 */
export function parseStripRow(row) {
  const tokens = row.words
    .map((w) => ({ ...w, clean: w.text.replace(/[^0-9A-Z]/gi, '').toUpperCase() }))
    .filter((t) => t.clean)

  if (tokens.length === 0) return null

  let rank = null
  let slotLetter = null
  let kills = null

  for (const token of tokens) {
    const isLetter = /^[A-Z]$/.test(token.clean)
    const isNumber = /^\d{1,3}$/.test(token.clean)

    if (slotLetter === null && isLetter && SLOT_LETTERS.includes(token.clean)) {
      slotLetter = token.clean
      continue
    }
    if (isNumber) {
      const value = Number(token.clean)
      // Before the slot letter it is the rank; after it, the team kill total.
      if (slotLetter === null) {
        if (rank === null && value >= 1 && value <= MAX_RANK) rank = value
      } else if (kills === null && value >= 0 && value <= MAX_PLAUSIBLE_KILLS) {
        kills = value
      }
    }
  }

  if (slotLetter === null || kills === null) return null

  const confidence = tokens.reduce((s, t) => s + t.confidence, 0) / tokens.length
  return { rank, slotLetter, kills, confidence, yCenter: row.yCenter }
}

/**
 * Fill in ranks the medal badges hid. Rows are always in descending rank order
 * down the capture, so a missing rank sits between its readable neighbours.
 */
export function inferMissingRanks(rows) {
  const ordered = [...rows].sort((a, b) => a.yCenter - b.yCenter)

  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].rank !== null) continue

    const before = ordered.slice(0, i).reverse().find((r) => r.rank !== null)
    const after = ordered.slice(i + 1).find((r) => r.rank !== null)

    if (before) {
      const offset = i - ordered.indexOf(before)
      ordered[i].rank = before.rank + offset
    } else if (after) {
      const offset = ordered.indexOf(after) - i
      ordered[i].rank = after.rank - offset
    }
  }

  return ordered.filter((r) => Number.isInteger(r.rank) && r.rank >= 1 && r.rank <= MAX_RANK)
}

/**
 * Merge rows from every capture of the same round. Scrolled screenshots overlap
 * and each repeats the rank-1 row as a sticky header, so the same slot shows up
 * more than once; keep the highest-confidence read of each slot.
 */
export function mergeCaptureRows(rows) {
  const bySlot = new Map()

  for (const row of rows) {
    const existing = bySlot.get(row.slotLetter)
    if (!existing || (row.confidence ?? 0) > (existing.confidence ?? 0)) {
      bySlot.set(row.slotLetter, row)
    }
  }

  return [...bySlot.values()]
    .sort((a, b) => a.rank - b.rank)
    .map((row) => ({
      rank: row.rank,
      slotCode: slotCodeFromLetter(row.slotLetter),
      teamQuery: row.slotLetter,
      kills: row.kills,
    }))
}

/**
 * Drop-in replacement for parseScreenshotWithGemini: same { roundNumber,
 * entries } shape, so the review and confirm flow is unchanged.
 */
export async function parseScreenshotWithOcr({
  images = [],
  buffer,
  mimeType = 'image/png',
  stripRatio = DEFAULT_LEFT_STRIP_RATIO,
} = {}) {
  const imageList = images.length > 0 ? images : buffer ? [{ buffer, mimeType }] : []
  if (imageList.length === 0) {
    throw new Error('No image provided for OCR parsing.')
  }

  const worker = await getWorker()
  const collected = []

  for (const img of imageList) {
    const source = img.buffer || (img.base64 ? Buffer.from(img.base64, 'base64') : null)
    if (!source) continue

    const prepared = await preprocessLeftStrip(source, { stripRatio })
    const { data } = await worker.recognize(prepared, {}, { blocks: true, text: true })

    const words = flattenWords(data)
    if (words.length === 0) continue

    // Row pitch scales with the capture, so derive the tolerance from it.
    const heights = words.map((w) => w.yCenter)
    const span = Math.max(...heights) - Math.min(...heights)
    const rowTolerance = Math.max(12, span / (words.length || 1))

    const rows = groupWordsIntoRows(words, rowTolerance)
      .map(parseStripRow)
      .filter(Boolean)

    collected.push(...inferMissingRanks(rows))
  }

  touchIdleTimer()

  const entries = mergeCaptureRows(collected)
  if (entries.length === 0) {
    throw new Error(
      'Local OCR could not read any team rows from that screenshot. ' +
        'Post a sharper or less cropped image, or type the scores instead (e.g. "ROUND 1" then "1. NR 12 KILLS").',
    )
  }

  return { roundNumber: 1, entries, source: 'ocr', uncertain: [] }
}

/**
 * Read captures with the glyph template matcher.
 *
 * Measured 60/60 on rank, slot letter and team kills across the six fixture
 * captures, with nothing guessed: a cell that does not match a template
 * outright is reported in `uncertain` instead of being resolved to a plausible
 * value. That distinction is the whole point — a flagged row costs a
 * scorekeeper a glance, a wrong row costs a team its placement.
 */
export async function parseScreenshotWithGlyphs({
  images = [],
  buffer,
  mimeType = "image/png",
  allowedLetters,
  maxSlots,
} = {}) {
  const imageList = images.length > 0 ? images : buffer ? [{ buffer, mimeType }] : []
  if (imageList.length === 0) {
    throw new Error('No image provided for glyph parsing.')
  }

  const collected = []
  for (const img of imageList) {
    const source = img.buffer || (img.base64 ? Buffer.from(img.base64, 'base64') : null)
    if (!source) continue
    const image = await Jimp.fromBuffer(source)
    collected.push(...readCapture(image.bitmap, atlas, { allowedLetters, maxSlots }))
  }

  if (collected.length === 0) {
    throw new Error(
      'The scoreboard reader found no team rows in that screenshot. ' +
        'It expects the Bloodstrike endgame results screen, uncropped on the left.',
    )
  }

  // Scrolled captures overlap and each repeats rank 1 as a sticky header, so
  // the same rank appears more than once. Keep the confident read of each.
  //
  // A row whose rank could not be resolved used to be skipped here, which meant
  // it disappeared from the tally with nothing said about it — a whole capture
  // could contribute no rows and the scorekeeper would only notice by spotting
  // the gap in the placements by eye. Every detected row is now accounted for.
  const byRank = new Map()
  const rankless = []
  for (const row of collected) {
    if (!Number.isInteger(row.rank)) {
      rankless.push(row)
      continue
    }
    const existing = byRank.get(row.rank)
    if (!existing || (row.certain && !existing.certain)) byRank.set(row.rank, row)
  }

  const ordered = [...byRank.values()].sort((a, b) => a.rank - b.rank)
  const entries = []
  const uncertain = []

  for (const row of ordered) {
    if (!row.certain || !row.slotLetter || row.kills === null) {
      uncertain.push({ rank: row.rank, slotLetter: row.slotLetter, kills: row.kills })
      continue
    }
    entries.push({
      rank: row.rank,
      slotCode: slotCodeFromLetter(row.slotLetter),
      teamQuery: row.slotLetter,
      kills: row.kills,
    })
  }

  for (const row of rankless) {
    uncertain.push({ rank: null, slotLetter: row.slotLetter, kills: row.kills })
  }

  // Every team occupies exactly one slot, so a letter already claimed by a
  // confident row cannot belong to another. If that leaves a single unclaimed
  // slot and a single row missing only its letter, the answer is forced — no
  // guessing involved, it is the only value the board can hold.
  if (allowedLetters) {
    const claimed = new Set(entries.map((e) => e.teamQuery))
    const free = [...allowedLetters].map((l) => String(l).toUpperCase()).filter((l) => !claimed.has(l))
    const needsLetter = uncertain.filter((u) => !u.slotLetter && u.kills !== null && Number.isInteger(u.rank))

    if (free.length === 1 && needsLetter.length === 1) {
      const row = needsLetter[0]
      entries.push({
        rank: row.rank,
        slotCode: slotCodeFromLetter(free[0]),
        teamQuery: free[0],
        kills: row.kills,
        deduced: true,
      })
      entries.sort((a, b) => a.rank - b.rank)
      uncertain.splice(uncertain.indexOf(row), 1)
    }
  }

  // Two rows claiming the same slot means one of them is misread, and there is
  // nothing in the image to say which. Both are pulled for checking rather than
  // letting a team be scored twice and another not at all.
  const seen = new Map()
  for (const entry of entries) {
    seen.set(entry.teamQuery, (seen.get(entry.teamQuery) || 0) + 1)
  }
  for (const [letter, count] of seen) {
    if (count < 2) continue
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].teamQuery !== letter) continue
      uncertain.push({ rank: entries[i].rank, slotLetter: letter, kills: entries[i].kills, duplicate: true })
      entries.splice(i, 1)
    }
  }

  // Placements run consecutively, so a hole between the lowest and highest rank
  // read means a row was missed outright — usually a screenshot that was never
  // posted, or one whose rows could not be placed.
  const ranks = entries.map((e) => e.rank)
  const missingRanks = []
  if (ranks.length > 0) {
    const flagged = new Set(uncertain.map((u) => u.rank).filter(Number.isInteger))
    for (let r = Math.min(...ranks); r <= Math.max(...ranks); r++) {
      if (!ranks.includes(r) && !flagged.has(r)) missingRanks.push(r)
    }
  }

  if (entries.length === 0) {
    throw new Error(
      'The scoreboard reader could not confidently read any row (the capture may be too low-resolution). ' +
        'Post a sharper or less cropped image, or type the scores instead (e.g. "ROUND 1" then "1. NR 12 KILLS").',
    )
  }

  return { roundNumber: 1, entries, source: 'glyphs', uncertain, missingRanks }
}

/**
 * Local reading, no API key and no quota: glyph templates first, Tesseract only
 * if the templates cannot read the image at all (a UI restyle, an unexpected
 * resolution). Tesseract's accuracy is far lower, so its result is marked
 * `source: 'ocr'` for the caller to flag.
 */
export async function parseScreenshotLocally(options) {
  try {
    return await parseScreenshotWithGlyphs(options)
  } catch (glyphErr) {
    console.warn(`[TALLY] Glyph reader failed, falling back to Tesseract: ${glyphErr.message}`)
    return parseScreenshotWithOcr(options)
  }
}

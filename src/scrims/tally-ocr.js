import { Jimp } from 'jimp'
import { createWorker, PSM } from 'tesseract.js'

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

  return { roundNumber: 1, entries, source: 'ocr' }
}

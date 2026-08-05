import { Jimp } from 'jimp'
import { createWorker, PSM } from 'tesseract.js'

/**
 * Local scoreboard OCR. No API key, no quota, no network call to a model
 * provider — Tesseract runs in-process.
 *
 * This works because the problem is far narrower than general image reading:
 * the team names are a closed set of at most 25 known strings, and the numbers
 * that matter (placement and kills) are plain digits. OCR only has to get close
 * enough for findMatchingTeam() to snap the name onto the right slot.
 */

// Cold start costs ~1s and the worker holds ~150-200MB. On a small instance
// that is worth reclaiming between scrims, but not between rounds.
const WORKER_IDLE_TIMEOUT_MS = Number(process.env.OCR_WORKER_IDLE_MS || 5 * 60 * 1000)

// Tesseract reads small text badly. Screenshots are upscaled to at least this
// width before recognition.
const MIN_OCR_WIDTH = Number(process.env.OCR_MIN_WIDTH || 1600)

let workerPromise = null
let idleTimer = null

function touchIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    releaseOcrWorker().catch(() => {})
  }, WORKER_IDLE_TIMEOUT_MS)
  // Never hold the process open just to keep a cache warm.
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng')
      await worker.setParameters({
        // A scoreboard is a sparse grid, not prose.
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
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

/**
 * Game UI is light text on a dark panel, which Tesseract handles poorly.
 * Greyscale + invert + contrast + upscale turns it into something much closer
 * to the black-on-white it was trained on.
 */
export async function preprocessScreenshot(buffer, { invert = true, contrast = 0.35 } = {}) {
  const image = await Jimp.fromBuffer(buffer)

  if (image.bitmap.width < MIN_OCR_WIDTH) {
    image.scale(Math.min(3, MIN_OCR_WIDTH / image.bitmap.width))
  }
  image.greyscale()
  if (invert) image.invert()
  if (contrast) image.contrast(contrast)

  return image.getBuffer('image/png')
}

/**
 * tesseract.js v7 nests results as blocks > paragraphs > lines > words, with no
 * top-level `lines`. Flatten to one entry per visual line, keeping word boxes
 * so columns can be told apart by x position.
 */
export function flattenLines(data) {
  const lines = []
  for (const block of data?.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const words = (line.words || [])
          .map((w) => ({
            text: String(w.text || '').trim(),
            confidence: Number(w.confidence ?? 0),
            x: Number(w.bbox?.x0 ?? 0),
          }))
          .filter((w) => w.text)
        if (words.length === 0) continue
        lines.push({
          text: words.map((w) => w.text).join(' '),
          confidence: words.reduce((sum, w) => sum + w.confidence, 0) / words.length,
          words,
        })
      }
    }
  }

  // Some builds return only flat text; keep a usable fallback.
  if (lines.length === 0 && typeof data?.text === 'string') {
    return data.text
      .split(/\r?\n/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ text, confidence: Number(data.confidence ?? 0), words: [] }))
  }

  return lines
}

const MAX_RANK = 25
const MAX_PLAUSIBLE_KILLS = 99

/**
 * Pull rank / team / kills out of one scoreboard line.
 *
 * Layout is "<rank> <team name> <...numeric columns...>". Kills is taken from
 * the LAST number on the line by default, because DAMAGE and SCORE columns sit
 * between the name and kills on some layouts and are far larger. killsColumn
 * lets that be re-pointed once real screenshots are measured.
 */
export function parseScoreboardLine(rawLine, { killsColumn = 'last' } = {}) {
  const text = String(rawLine || '')
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null

  const rankMatch = /^#?\s*(\d{1,2})\b/.exec(text)
  if (!rankMatch) return null
  const rank = Number(rankMatch[1])
  if (!Number.isInteger(rank) || rank < 1 || rank > MAX_RANK) return null

  const rest = text.slice(rankMatch[0].length).trim()
  if (!rest) return null

  // Every digit run, including 4+ digit DAMAGE values. Matching only short
  // numbers here would skip past them and swallow them into the team name.
  const numbers = [...rest.matchAll(/\d+/g)]
  if (numbers.length === 0) return null

  let killsMatch
  if (killsColumn === 'first') {
    killsMatch = numbers[0]
  } else if (Number.isInteger(killsColumn)) {
    killsMatch = numbers[Math.min(killsColumn, numbers.length - 1)]
  } else {
    killsMatch = numbers[numbers.length - 1]
  }

  const kills = Number(killsMatch[0])
  if (!Number.isInteger(kills) || kills < 0 || kills > MAX_PLAUSIBLE_KILLS) return null

  // Everything before the first numeric column is the team name.
  const teamQuery = rest.slice(0, numbers[0].index).replace(/[^\p{L}\p{N}\s.'-]/gu, '').trim()
  if (!teamQuery) return null

  return { rank, teamQuery, slotCode: '', kills }
}

/**
 * Drop the rows that are obviously not teams (headers, footers, watermarks)
 * and collapse duplicate ranks, keeping the highest-confidence read.
 */
export function selectScoreboardEntries(lines, options = {}) {
  const byRank = new Map()

  for (const line of lines) {
    const parsed = parseScoreboardLine(line.text, options)
    if (!parsed) continue

    const existing = byRank.get(parsed.rank)
    if (!existing || (line.confidence ?? 0) > (existing.confidence ?? 0)) {
      byRank.set(parsed.rank, { ...parsed, confidence: line.confidence ?? 0 })
    }
  }

  return [...byRank.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(({ confidence, ...entry }) => entry)
}

/**
 * Drop-in replacement for parseScreenshotWithGemini: same { roundNumber,
 * entries } shape, so the review / confirm flow is unchanged.
 */
export async function parseScreenshotWithOcr({
  images = [],
  buffer,
  mimeType = 'image/png',
  killsColumn = process.env.OCR_KILLS_COLUMN || 'last',
  invert,
} = {}) {
  const imageList = images.length > 0 ? images : buffer ? [{ buffer, mimeType }] : []
  if (imageList.length === 0) {
    throw new Error('No image provided for OCR parsing.')
  }

  const worker = await getWorker()
  const allLines = []

  for (const img of imageList) {
    const source = img.buffer || (img.base64 ? Buffer.from(img.base64, 'base64') : null)
    if (!source) continue

    const prepared = await preprocessScreenshot(source, invert === undefined ? {} : { invert })
    const { data } = await worker.recognize(prepared, {}, { blocks: true, text: true })
    allLines.push(...flattenLines(data))
  }

  touchIdleTimer()

  const parsedKillsColumn = /^\d+$/.test(String(killsColumn))
    ? Number(killsColumn)
    : String(killsColumn)
  const entries = selectScoreboardEntries(allLines, { killsColumn: parsedKillsColumn })

  if (entries.length === 0) {
    throw new Error(
      'Local OCR could not read any team rows from that screenshot. ' +
        'Post a sharper or less cropped image, or type the scores instead (e.g. "ROUND 1" then "1. NR 12 KILLS").',
    )
  }

  // The round number is not reliably present in the endgame screen; the caller
  // already falls back to the next unfilled round.
  return { roundNumber: 1, entries, source: 'ocr', linesRead: allLines.length }
}

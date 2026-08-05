/**
 * OCR calibration harness.
 *
 *   node scripts/ocr-calibrate.mjs
 *
 * Reads every capture in test/fixtures/screenshots, extracts the slot letter
 * and team kill count for each row, and scores the result against the
 * hand-transcribed ground truth. Prints per-capture detail plus a total, so any
 * change to preprocessing or geometry can be measured instead of guessed at.
 *
 * ---------------------------------------------------------------------------
 * MEASURED LAYOUT (reference width 1135px; all values scale by width/1135)
 * ---------------------------------------------------------------------------
 * Row pitch                92px, constant across every capture.
 * Left strip worth reading  x 0 .. 0.145*W. Beyond that are the four player
 *                           cells, whose per-player kill counts must never be
 *                           mistaken for the team total.
 * Rank badge                x 4..60, row centre. Ranks 1-3 are medal graphics
 *                           with no readable digits.
 * Slot letter               x 100..140, centred 35px above the kills line.
 * Skull icon                x 95..112 — excluded from the kills crop because it
 *                           OCRs as a "9" and corrupts the number.
 * Team kills                x 110..158, on the kills line.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS STILL NOT PRODUCTION READY
 * ---------------------------------------------------------------------------
 * Best measured result: slot letter 36/60, kills 33/60.
 *
 * Two independent problems remain:
 *
 * 1. Grid phase. Captures where few rows are legible enough to lock the phase
 *    (round-a-3, round-b-3) end up offset by one row, which makes every value
 *    on that capture wrong. Detecting the horizontal row separators directly
 *    would fix this properly.
 *
 * 2. Single-letter recognition. Tesseract confuses O/D/Q, I/1 and B/8 at this
 *    glyph size, and a wrong letter silently assigns a score to a different
 *    team. The promising fix is template matching: the font, size and position
 *    are fixed, and there are only 25 possible glyphs, so normalised
 *    cross-correlation against reference bitmaps should beat general OCR
 *    comfortably. Templates can be cut from these captures using the ground
 *    truth as labels.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Jimp } from 'jimp'
import { createWorker, PSM } from 'tesseract.js'
import { SLOT_LETTERS, flattenWords } from '../src/scrims/tally-ocr.js'
import { ROUNDS } from '../test/fixtures/scoreboard-ground-truth.js'

const REF_WIDTH = 1135
const ROW_PITCH = 92
const SHOT_DIR = path.join(process.cwd(), 'test', 'fixtures', 'screenshots')

function maxChannelThreshold(image, t) {
  const d = image.bitmap.data
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(d[i], d[i + 1], d[i + 2])
    const o = v >= t ? 0 : 255
    d[i] = d[i + 1] = d[i + 2] = o
  }
}

/**
 * Otsu threshold with automatic polarity. Rows 1-3 are light medal banners with
 * dark glyphs; rows 4+ are dark with bright glyphs. The glyph is the minority
 * class either way, so that is what decides which side becomes black.
 */
export function adaptiveBinarize(image) {
  const d = image.bitmap.data
  const n = d.length / 4
  const hist = new Array(256).fill(0)
  const lum = new Array(n)
  for (let i = 0; i < n; i++) {
    const v = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])
    lum[i] = v
    hist[v]++
  }
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let best = 0
  let thresh = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = n - wB
    if (!wF) break
    sumB += t * hist[t]
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (between > best) {
      best = between
      thresh = t
    }
  }
  let above = 0
  for (let i = 0; i < n; i++) if (lum[i] > thresh) above++
  const glyphIsBright = above < n / 2
  for (let i = 0; i < n; i++) {
    const isGlyph = glyphIsBright ? lum[i] > thresh : lum[i] <= thresh
    const o = isGlyph ? 0 : 255
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = o
  }
}

async function main() {
  if (!fs.existsSync(SHOT_DIR)) {
    console.error(`No captures found. Put the PNGs in ${SHOT_DIR}`)
    process.exit(1)
  }

  const coarse = await createWorker('eng')
  await coarse.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    tessedit_char_whitelist: '0123456789',
  })
  const digits = await createWorker('eng')
  await digits.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_WORD,
    tessedit_char_whitelist: '0123456789',
  })
  const letters = await createWorker('eng')
  await letters.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_CHAR,
    tessedit_char_whitelist: SLOT_LETTERS,
  })

  let slotHits = 0
  let killHits = 0
  let total = 0

  for (const round of ROUNDS) {
    for (const capture of round.captures) {
      const file = path.join(SHOT_DIR, capture.file)
      if (!fs.existsSync(file)) {
        console.log(`${capture.file}  MISSING`)
        continue
      }
      const buf = fs.readFileSync(file)
      const src = await Jimp.fromBuffer(buf)
      const W = src.bitmap.width
      const H = src.bitmap.height
      const k = W / REF_WIDTH
      const pitch = ROW_PITCH * k

      // Coarse pass, only to lock the phase of the row grid.
      const strip = await Jimp.fromBuffer(buf)
      strip.crop({ x: 0, y: 0, w: Math.round(W * 0.145), h: H }).scale(4)
      maxChannelThreshold(strip, 200)
      const { data } = await coarse.recognize(await strip.getBuffer('image/png'), {}, { blocks: true })
      const ys = flattenWords(data)
        .filter((w) => w.x / 4 > 60 * k && /^\d{1,3}$/.test(w.text.replace(/\D/g, '')))
        .map((w) => w.yCenter / 4)
      if (ys.length === 0) {
        console.log(`${capture.file}  could not lock the row grid`)
        continue
      }
      const residuals = ys.map((y) => ((y % pitch) + pitch) % pitch).sort((a, b) => a - b)
      const phase = residuals[Math.floor(residuals.length / 2)]

      const got = []
      for (let y = phase; y < H - 10; y += pitch) {
        if (y <= 18 * k) continue

        const killTop = Math.round(y - 13 * k)
        if (killTop < 0 || killTop + 26 * k > H) continue
        const kc = await Jimp.fromBuffer(buf)
        kc.crop({ x: Math.round(110 * k), y: killTop, w: Math.round(48 * k), h: Math.round(26 * k) }).scale(6)
        adaptiveBinarize(kc)
        const kr = await digits.recognize(await kc.getBuffer('image/png'), {}, { blocks: true })
        const killText = (kr.data.text || '').replace(/\D/g, '')

        const letterTop = Math.round(y - 52 * k)
        if (letterTop < 0) continue
        const lc = await Jimp.fromBuffer(buf)
        lc.crop({ x: Math.round(100 * k), y: letterTop, w: Math.round(40 * k), h: Math.round(34 * k) }).scale(6)
        adaptiveBinarize(lc)
        const lr = await letters.recognize(await lc.getBuffer('image/png'), {}, { blocks: true })
        const slot = ((lr.data.text || '').trim().replace(/[^A-Y]/g, '')[0]) || null

        if (slot || killText !== '') {
          got.push({ slot, kills: killText === '' ? null : Number(killText) })
        }
      }

      const expected = [...(capture.stickyRank1 ? [capture.stickyRank1] : []), ...capture.rows]
      let s = 0
      let kk = 0
      for (let i = 0; i < expected.length && i < got.length; i++) {
        if (got[i].slot === expected[i].slotLetter) s++
        if (got[i].kills === expected[i].kills) kk++
      }
      slotHits += s
      killHits += kk
      total += expected.length

      console.log(`${capture.file}  rows ${got.length}/${expected.length}  slot ${s}  kills ${kk}`)
      console.log(`   got ${got.map((g) => `${g.slot || '?'}${g.kills ?? '?'}`).join(' ')}`)
      console.log(`   exp ${expected.map((e) => `${e.slotLetter}${e.kills}`).join(' ')}`)
    }
  }

  console.log(`\nTOTAL  slot ${slotHits}/${total}   kills ${killHits}/${total}`)
  console.log('Tournament scoring needs both at ~100%; see the notes at the top of this file.')

  await coarse.terminate()
  await digits.terminate()
  await letters.terminate()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

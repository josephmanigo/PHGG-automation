/**
 * Build the glyph atlas from the labelled fixtures.
 *
 *   node scripts/build-glyph-atlas.mjs
 *
 * Cuts every slot letter, kill digit and rank glyph out of the captures in
 * test/fixtures/screenshots, labels each one from the hand-transcribed ground
 * truth, and writes the deduplicated templates to src/scrims/glyph-atlas.json.
 *
 * A sample is only kept when the segmentation agrees with the label — a kills
 * cell whose expected value has two digits must yield exactly two glyph boxes.
 * Anything else is a misread crop, and letting it into the atlas would teach
 * the matcher the wrong shape.
 *
 * Re-run this whenever new captures are added to the fixtures, then re-run
 * scripts/ocr-calibrate.mjs to confirm accuracy did not regress.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Jimp } from 'jimp'
import {
  cellMask,
  detectRows,
  encodeGlyph,
  killsCell,
  KILLS_MIN_PIXELS,
  letterCell,
  normalizeGlyph,
  rankCell,
  scaleFactor,
  segmentGlyphs,
} from '../src/scrims/tally-glyphs.js'
import { ROUNDS } from '../test/fixtures/scoreboard-ground-truth.js'

const SHOT_DIR = path.join(process.cwd(), 'test', 'fixtures', 'screenshots')
const OUT = path.join(process.cwd(), 'src', 'scrims', 'glyph-atlas.json')

const letters = new Map()
const digits = new Map()
const rankDigits = new Map()
const marks = new Map()

function add(store, label, vec) {
  const encoded = encodeGlyph(vec)
  if (!store.has(label)) store.set(label, new Set())
  store.get(label).add(encoded)
}

/**
 * Drop any template that turns up under more than one label.
 *
 * A vector that is byte-identical for two classes cannot discriminate between
 * them — it only guarantees a zero-margin match, which the reader then has to
 * throw away. This caught a Q whose descender was clipped by the crop window,
 * normalising it into an exact copy of O and making BOTH letters unreadable.
 */
function dropCollisions(store, kind) {
  const owners = new Map()
  for (const [label, set] of store) {
    for (const vec of set) {
      if (!owners.has(vec)) owners.set(vec, new Set())
      owners.get(vec).add(label)
    }
  }
  for (const [vec, labels] of owners) {
    if (labels.size < 2) continue
    console.log(`${kind}: dropping template shared by ${[...labels].join('/')} — not discriminative`)
    for (const label of labels) store.get(label).delete(vec)
  }
}

function toObject(store) {
  const out = {}
  for (const label of [...store.keys()].sort()) {
    const list = [...store.get(label)]
    if (list.length) out[label] = list
  }
  return out
}

// The fixtures are all one device scale. A phone renders the same UI larger,
// so each capture is harvested at several scales to cover the range a real
// screenshot can arrive at.
const SCALES = [1, 0.95, 1.1, 1.2, 1.35, 1.43, 1.6, 1.69, 2, 2.5, 3]

let rowsSeen = 0
let letterKept = 0
let killsKept = 0
let rankKept = 0

for (const round of ROUNDS) {
  for (const capture of round.captures) {
    const file = path.join(SHOT_DIR, capture.file)
    if (!fs.existsSync(file)) {
      console.log(`${capture.file}  MISSING`)
      continue
    }

    for (const scale of SCALES) {
      const image = await Jimp.read(file)
      if (scale !== 1) image.scale(scale)
      await harvest(image, capture, scale)
    }
  }
}

/**
 * Cut every labelled glyph out of one capture.
 *
 * Called once per scale: a phone capture renders the same UI larger or smaller
 * than the fixtures, and resampling changes stroke thickness and antialiasing
 * enough that a template cut at one scale is a poor match at another. Teaching
 * the atlas each scale is cheaper and far more reliable than trying to
 * normalise the difference away.
 */
async function harvest(image, capture, scale) {
  {
    const bitmap = image.bitmap
    const k = scaleFactor(bitmap)
    const rows = detectRows(bitmap)
    const expected = [...(capture.stickyRank1 ? [capture.stickyRank1] : []), ...capture.rows]

    if (rows.length !== expected.length) {
      console.log(`${capture.file} @${scale}x  row count ${rows.length} != ${expected.length}, skipped`)
      return
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const truth = expected[i]
      rowsSeen++

      const lMask = cellMask(bitmap, letterCell(row, k), 'otsu')
      const lBoxes = segmentGlyphs(lMask)
      if (lBoxes.length === 1) {
        add(letters, truth.slotLetter, normalizeGlyph(lMask, lBoxes[0]))
        letterKept++
      }

      const kMask = cellMask(bitmap, killsCell(row, k), 'white')
      const kBoxes = segmentGlyphs(kMask, { minPixels: KILLS_MIN_PIXELS })
      const killDigits = String(truth.kills)
      if (kBoxes.length === killDigits.length) {
        kBoxes.forEach((box, j) => add(digits, killDigits[j], normalizeGlyph(kMask, box)))
        killsKept++
      }

      // Ranks 1-3 are medal graphics with no readable text.
      if (truth.rank > 3) {
        const rMask = cellMask(bitmap, rankCell(row, k), 'otsu')
        const rBoxes = segmentGlyphs(rMask)
        const rankText = String(truth.rank)
        if (rBoxes.length === rankText.length + 1) {
          add(marks, '#', normalizeGlyph(rMask, rBoxes[0]))
          rankText.split('').forEach((d, j) => add(rankDigits, d, normalizeGlyph(rMask, rBoxes[j + 1])))
          rankKept++
        }
      }
    }
  }
}

dropCollisions(letters, 'letters')
dropCollisions(digits, 'digits')
dropCollisions(rankDigits, 'rankDigits')

const atlas = {
  letters: toObject(letters),
  digits: toObject(digits),
  rankDigits: toObject(rankDigits),
  marks: toObject(marks),
}
fs.writeFileSync(OUT, `${JSON.stringify(atlas)}\n`)

const missingLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXY'
  .split('')
  .filter((c) => !atlas.letters[c])

console.log(`rows ${rowsSeen}  letter cells ${letterKept}  kills cells ${killsKept}  rank cells ${rankKept}`)
console.log(`letters ${Object.keys(atlas.letters).length}/25  digits ${Object.keys(atlas.digits).length}/10`)
console.log(`templates: ${Object.values(atlas.letters).flat().length} letter, ${Object.values(atlas.digits).flat().length} digit`)
if (missingLetters.length) {
  console.log(`NO TEMPLATE for slot letters: ${missingLetters.join(', ')} — add a capture containing them.`)
}
console.log(`wrote ${OUT}`)

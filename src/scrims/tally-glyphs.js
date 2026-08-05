/**
 * Glyph-level scoreboard reader.
 *
 * The Bloodstrike endgame screen is a fixed-layout grid drawn with a fixed
 * bitmap font, so every "7" is pixel-identical to every other "7" at the same
 * capture width. That makes reading it a lookup problem with an exact answer,
 * not a recognition problem — template matching beats general OCR here and is
 * deterministic, which is what tournament scoring actually needs.
 *
 * Pipeline, per capture:
 *   1. detectRows      — anchor every row on its white skull icon.
 *   2. cellMask        — crop rank / slot / kills relative to that skull.
 *   3. segmentGlyphs   — split a cell into individual glyph boxes.
 *   4. matchGlyph      — nearest template from the atlas.
 *
 * Anchoring on the skull rather than a fixed row pitch is what makes this
 * robust: scrolled captures repeat rank 1 as a sticky header that is SHORTER
 * than a normal row, so any uniform-pitch assumption drifts by one row and
 * every value after it lands on the wrong team.
 */

const REF_WIDTH = 1135

// Geometry in reference pixels at REF_WIDTH; every value scales by width/1135.
const SKULL_X0 = 90
const SKULL_X1 = 118
const SKULL_MIN_RUN = 4
const SKULL_MIN_PIXELS_PER_ROW = 3
const WHITE_MIN_CHANNEL = 170

const LETTER_DX = 1
// Tall enough to hold Q's descender. At 34 the tail was clipped on some rows,
// which normalised a Q into a byte-identical copy of O — the single worst kind
// of template, since it makes both letters unreadable.
const LETTER_DY = -58
const LETTER_W = 32
const LETTER_H = 42

// The skull's antialiased right edge sits ~3px past its detected bbox and
// segments as a spurious leading glyph, so the kills cell starts clear of it.
const KILLS_DX = 6
const KILLS_DY = -13
// Stops short of the player-card divider on the right, which otherwise
// segments as a spurious trailing digit. Team totals are never 3 digits.
const KILLS_W = 34
const KILLS_H = 26

// A digit stroke carries ~28 ink pixels at this scale; icon slivers carry <10.
export const KILLS_MIN_PIXELS = 12

const RANK_X = 6
const RANK_DY = -46
const RANK_W = 84
const RANK_H = 52

// Normalised template size. Big enough to hold what separates O from Q (the
// tail) and 8 from B, small enough that a one-pixel scale difference between
// captures does not matter.
export const GLYPH_W = 16
export const GLYPH_H = 20

export function scaleFactor(width) {
  return width / REF_WIDTH
}

/**
 * Every row — medal banner or plain — carries a white skull immediately left of
 * its team kill total, so a vertical run of white pixels in that column marks a
 * row and its horizontal extent locates the cells beside it.
 */
export function detectRows(bitmap) {
  const { width: W, height: H, data } = bitmap
  const k = scaleFactor(W)
  const x0 = Math.round(SKULL_X0 * k)
  const x1 = Math.round(SKULL_X1 * k)

  const isWhite = (x, y) => {
    const i = (y * W + x) * 4
    return Math.min(data[i], data[i + 1], data[i + 2]) > WHITE_MIN_CHANNEL
  }

  const rows = []
  let start = -1

  const closeRun = (end) => {
    if (start < 0) return
    if (end - start >= SKULL_MIN_RUN * k) {
      let sx0 = x1
      let sx1 = x0
      for (let y = start; y < end; y++) {
        for (let x = x0; x < x1; x++) {
          if (!isWhite(x, y)) continue
          if (x < sx0) sx0 = x
          if (x > sx1) sx1 = x
        }
      }
      if (sx1 > sx0) rows.push({ cy: (start + end) / 2, skullX0: sx0, skullX1: sx1 })
    }
    start = -1
  }

  for (let y = 0; y < H; y++) {
    let count = 0
    for (let x = x0; x < x1; x++) if (isWhite(x, y)) count++
    if (count >= SKULL_MIN_PIXELS_PER_ROW) {
      if (start < 0) start = y
    } else {
      closeRun(y)
    }
  }
  closeRun(H)

  return rows
}

/** Otsu threshold over a luminance array. */
function otsuThreshold(lum) {
  const hist = new Array(256).fill(0)
  for (const v of lum) hist[v]++
  const n = lum.length
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
  return thresh
}

/**
 * Binary mask of one cell.
 *
 * 'white' keys on the minimum channel and suits the kill digits, which are
 * always white — polarity is fixed, so a bright neighbouring player card cannot
 * flip it. 'otsu' suits the slot letter and rank, which are saturated colours
 * whose brightness relative to the background changes between the medal banners
 * (light) and the plain rows (dark); the glyph is the minority class either
 * way, and that is what decides which side becomes ink.
 */
export function cellMask(bitmap, { x, y, w, h }, mode = 'otsu') {
  const { width: W, height: H, data } = bitmap
  const x0 = Math.max(0, Math.round(x))
  const y0 = Math.max(0, Math.round(y))
  const cw = Math.min(Math.round(w), W - x0)
  const ch = Math.min(Math.round(h), H - y0)
  if (cw <= 0 || ch <= 0) return { bits: new Uint8Array(0), w: 0, h: 0 }

  const lum = new Array(cw * ch)
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      const i = ((y0 + yy) * W + (x0 + xx)) * 4
      lum[yy * cw + xx] =
        mode === 'white'
          ? Math.min(data[i], data[i + 1], data[i + 2])
          : Math.max(data[i], data[i + 1], data[i + 2])
    }
  }

  const bits = new Uint8Array(cw * ch)
  if (mode === 'white') {
    for (let i = 0; i < lum.length; i++) bits[i] = lum[i] > WHITE_MIN_CHANNEL ? 1 : 0
    return { bits, w: cw, h: ch }
  }

  const thresh = otsuThreshold(lum)
  let above = 0
  for (const v of lum) if (v > thresh) above++
  const inkIsBright = above < lum.length / 2
  for (let i = 0; i < lum.length; i++) {
    bits[i] = (inkIsBright ? lum[i] > thresh : lum[i] <= thresh) ? 1 : 0
  }
  return { bits, w: cw, h: ch }
}

export function letterCell(row, k) {
  return {
    x: row.skullX0 + LETTER_DX * k,
    y: row.cy + LETTER_DY * k,
    w: LETTER_W * k,
    h: LETTER_H * k,
  }
}

export function killsCell(row, k) {
  return {
    x: row.skullX1 + KILLS_DX * k,
    y: row.cy + KILLS_DY * k,
    w: KILLS_W * k,
    h: KILLS_H * k,
  }
}

export function rankCell(row, k) {
  return { x: RANK_X * k, y: row.cy + RANK_DY * k, w: RANK_W * k, h: RANK_H * k }
}

/**
 * Split a cell into glyph boxes using column gaps. The font never kerns two
 * glyphs into a shared column, so an empty column is always a glyph boundary.
 */
export function segmentGlyphs(mask, { minPixels = 6, minWidth = 2 } = {}) {
  const { bits, w, h } = mask
  if (!w || !h) return []

  const colFilled = new Array(w).fill(0)
  for (let x = 0; x < w; x++) {
    let c = 0
    for (let y = 0; y < h; y++) if (bits[y * w + x]) c++
    colFilled[x] = c
  }

  const boxes = []
  let start = -1
  const close = (end) => {
    if (start < 0) return
    if (end - start >= minWidth) {
      let y0 = h
      let y1 = -1
      let pixels = 0
      for (let y = 0; y < h; y++) {
        for (let x = start; x < end; x++) {
          if (!bits[y * w + x]) continue
          pixels++
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
      if (pixels >= minPixels && y1 >= y0) {
        boxes.push({ x0: start, x1: end, y0, y1: y1 + 1, pixels })
      }
    }
    start = -1
  }

  for (let x = 0; x < w; x++) {
    if (colFilled[x] > 0) {
      if (start < 0) start = x
    } else {
      close(x)
    }
  }
  close(w)

  return boxes
}

/**
 * Resample a glyph box to the fixed template size. Scale normalisation is what
 * lets one atlas serve captures from 1135px to 1151px wide.
 */
export function normalizeGlyph(mask, box) {
  const { bits, w } = mask
  const bw = box.x1 - box.x0
  const bh = box.y1 - box.y0
  const out = new Uint8Array(GLYPH_W * GLYPH_H)
  // Aspect is carried alongside the bitmap because stretching every glyph to
  // the same box destroys it — and for "I", a plain vertical bar that fills
  // the box solid once stretched, aspect is the ONLY thing distinguishing it
  // from any other solid blob.
  const aspect = bh > 0 ? bw / bh : 1
  if (bw <= 0 || bh <= 0) return { bits: out, aspect }

  for (let ty = 0; ty < GLYPH_H; ty++) {
    // Area-average each destination pixel so thin strokes survive downscaling.
    const sy0 = box.y0 + Math.floor((ty * bh) / GLYPH_H)
    const sy1 = Math.max(sy0 + 1, box.y0 + Math.floor(((ty + 1) * bh) / GLYPH_H))
    for (let tx = 0; tx < GLYPH_W; tx++) {
      const sx0 = box.x0 + Math.floor((tx * bw) / GLYPH_W)
      const sx1 = Math.max(sx0 + 1, box.x0 + Math.floor(((tx + 1) * bw) / GLYPH_W))
      let on = 0
      let total = 0
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          total++
          if (bits[y * w + x]) on++
        }
      }
      out[ty * GLYPH_W + tx] = total && on * 2 >= total ? 1 : 0
    }
  }
  return { bits: out, aspect }
}

export function encodeGlyph({ bits, aspect }) {
  let s = ''
  for (let i = 0; i < bits.length; i++) s += bits[i] ? '1' : '0'
  return `${s}|${aspect.toFixed(4)}`
}

export function decodeGlyph(str) {
  const [bitString, aspect] = String(str).split('|')
  const bits = new Uint8Array(bitString.length)
  for (let i = 0; i < bitString.length; i++) bits[i] = bitString[i] === '1' ? 1 : 0
  return { bits, aspect: Number(aspect) }
}

// Aspect differences below this are ordinary capture-to-capture variation.
const ASPECT_DEADZONE = 0.08
const ASPECT_WEIGHT = 2
const ASPECT_MAX_PENALTY = 0.5

function aspectPenalty(a, b) {
  const diff = Math.abs(a - b)
  if (diff <= ASPECT_DEADZONE) return 0
  return Math.min(ASPECT_MAX_PENALTY, (diff - ASPECT_DEADZONE) * ASPECT_WEIGHT)
}

/**
 * Nearest template by agreement fraction. Returns the runner-up too: a glyph
 * that matches two classes almost equally is exactly the case a scorekeeper
 * should be asked to confirm rather than silently resolved.
 */
export function matchGlyph(sample, templates) {
  let best = { label: null, score: -1 }
  let second = { label: null, score: -1 }

  for (const [label, exemplars] of Object.entries(templates)) {
    let labelBest = -1
    for (const exemplar of exemplars) {
      let same = 0
      for (let i = 0; i < sample.bits.length; i++) if (sample.bits[i] === exemplar.bits[i]) same++
      const score = same / sample.bits.length - aspectPenalty(sample.aspect, exemplar.aspect)
      if (score > labelBest) labelBest = score
    }
    if (labelBest > best.score) {
      second = best
      best = { label, score: labelBest }
    } else if (labelBest > second.score) {
      second = { label, score: labelBest }
    }
  }

  return { label: best.label, score: best.score, margin: best.score - Math.max(0, second.score) }
}

export function loadTemplates(atlasSection = {}) {
  const out = {}
  for (const [label, list] of Object.entries(atlasSection)) {
    out[label] = list.map(decodeGlyph)
  }
  return out
}

// Below this agreement fraction the glyph is not one of the known templates —
// a UI restyle, an unseen slot letter, or a bad crop. Guessing anyway is what
// silently awards points to the wrong team, so the row is flagged instead.
export const MIN_MATCH_SCORE = 0.86
// Two classes this close apart (O/D/Q, 8/B) is a coin flip, not a read.
export const MIN_MATCH_MARGIN = 0.02

function readCell(mask, templates, segmentOptions) {
  const boxes = segmentGlyphs(mask, segmentOptions)
  return boxes.map((box) => matchGlyph(normalizeGlyph(mask, box), templates))
}

function confident(match) {
  return Boolean(match) && match.score >= MIN_MATCH_SCORE && match.margin >= MIN_MATCH_MARGIN
}

/**
 * Read every row of one capture.
 *
 * Each row carries its own confidence. A row is only trustworthy when the slot
 * letter and every kill digit matched a template outright; anything short of
 * that is returned with `certain: false` so the caller can surface it for
 * checking rather than folding a guess into the standings.
 */
export function readCapture(bitmap, atlas) {
  const letters = loadTemplates(atlas.letters)
  const digits = loadTemplates(atlas.digits)
  // Rank digits are drawn far larger than kill digits. Normalisation aliases
  // an upscaled small glyph differently from a downscaled large one, so mixing
  // both into one pool blunted every match; they get their own templates.
  const rankTemplates = { ...loadTemplates(atlas.rankDigits), ...loadTemplates(atlas.marks) }

  const k = scaleFactor(bitmap.width)
  const rows = detectRows(bitmap)
  const read = []

  for (const row of rows) {
    const letterMask = cellMask(bitmap, letterCell(row, k), 'otsu')
    const letterMatches = readCell(letterMask, letters)
    // A stray speck can split the cell; the widest box is the letter.
    const letterMatch = letterMatches.length === 1 ? letterMatches[0] : null

    const killsMask = cellMask(bitmap, killsCell(row, k), 'white')
    const killMatches = readCell(killsMask, digits, { minPixels: KILLS_MIN_PIXELS })

    const rankMask = cellMask(bitmap, rankCell(row, k), 'otsu')
    const rankMatches = readCell(rankMask, rankTemplates)

    // Rows 1-3 are medal graphics: no "#", so no readable rank.
    let rank = null
    if (rankMatches.length > 1 && rankMatches[0].label === '#') {
      const digitsOnly = rankMatches.slice(1)
      if (digitsOnly.every((m) => confident(m) && /^\d$/.test(m.label))) {
        const value = Number(digitsOnly.map((m) => m.label).join(''))
        if (value >= 1 && value <= 99) rank = value
      }
    }

    const killsCertain = killMatches.length > 0 && killMatches.every((m) => confident(m) && /^\d$/.test(m.label))
    const kills = killsCertain ? Number(killMatches.map((m) => m.label).join('')) : null
    const slotLetter = confident(letterMatch) ? letterMatch.label : null

    read.push({
      cy: row.cy,
      rank,
      slotLetter,
      kills,
      certain: Boolean(slotLetter) && kills !== null,
      letterScore: letterMatch ? letterMatch.score : 0,
      letterMargin: letterMatch ? letterMatch.margin : 0,
    })
  }

  return resolveMedalRanks(read)
}

/**
 * Give the medal rows their rank.
 *
 * A capture either starts at the top of the board — three medal rows, then a
 * readable "#4" — or it is scrolled, in which case the single medal row at the
 * top is the sticky rank-1 header and the next readable rank jumps (e.g. #13).
 * Comparing the first readable rank against the count of leading medal rows
 * tells the two apart without reading the medal art at all.
 */
export function resolveMedalRanks(rows) {
  let lead = 0
  while (lead < rows.length && rows[lead].rank === null) lead++
  if (lead === 0 || lead === rows.length) return rows

  const firstReadable = rows[lead].rank
  const contiguous = firstReadable === lead + 1

  for (let i = 0; i < lead; i++) {
    rows[i].rank = contiguous ? i + 1 : 1
  }
  // A scrolled capture repeats only rank 1, so anything above it is the header.
  if (!contiguous && lead > 1) {
    for (let i = 0; i < lead; i++) rows[i].certain = false
  }
  return rows
}

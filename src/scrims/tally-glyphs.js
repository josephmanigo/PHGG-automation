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

// Geometry is expressed in reference pixels at the scale where the skull icon
// measures REF_SKULL_SIZE across, and every value is scaled by the skull
// actually found in the capture.
//
// Scale used to come from image width (width/1135). That silently assumed the
// UI scales with the canvas, which it does not: across the six fixtures the
// width varies 1135..1155 while the skull stays exactly 14px, so the factor was
// always ~1.0 and the assumption was never tested. A 1920x1080 capture has the
// same UI drawn at a different ratio, and width-derived scale put every crop in
// the wrong place. The skull is the one element whose size IS the UI scale.
const REF_SKULL_SIZE = 14
// Distance between consecutive team rows at scale 1. Scale is derived from this
// rather than from the skull: measuring a 14px icon to ±1px is a ±7% error,
// which throws a -58px letter offset out by 4px, while pitch is ~92px and is
// averaged over every row in the capture.
const REF_ROW_PITCH = 92
const WHITE_MIN_CHANNEL = 170

// How far across the frame to hunt for the skull column. The team skull sits
// left of the first player card in every layout seen so far.
const SEARCH_STRIP_RATIO = 0.3
// Identifying the column needs whole skulls; measuring a row needs the jaw too,
// which is much smaller. Two thresholds rather than one.
const MIN_COLUMN_BLOB_PIXELS = 40
const MIN_PART_BLOB_PIXELS = 8
const MIN_SKULLS_PER_COLUMN = 3

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

// Measured leftward from the skull, not from the frame edge: the left margin
// before the rank badge differs between capture aspect ratios.
const RANK_GAP = 8
const RANK_DY = -46
const RANK_W = 84
const RANK_H = 52

// Normalised template size. Big enough to hold what separates O from Q (the
// tail) and 8 from B, small enough that a one-pixel scale difference between
// captures does not matter.
export const GLYPH_W = 16
export const GLYPH_H = 20

/**
 * White blobs in the left strip, found by flood fill.
 *
 * The skull is drawn as two pieces (cranium and jaw), so blobs are grouped into
 * columns afterwards rather than assumed to be one shape per row.
 */
function whiteBlobs(bitmap) {
  const { width: W, height: H, data } = bitmap
  const sw = Math.max(1, Math.round(W * SEARCH_STRIP_RATIO))
  const seen = new Uint8Array(sw * H)
  const isWhite = (x, y) => {
    const i = (y * W + x) * 4
    return Math.min(data[i], data[i + 1], data[i + 2]) > WHITE_MIN_CHANNEL
  }

  const blobs = []
  const stack = []
  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      if (seen[sy * sw + sx] || !isWhite(sx, sy)) continue
      let x0 = sx
      let x1 = sx
      let y0 = sy
      let y1 = sy
      let pixels = 0
      stack.length = 0
      stack.push(sx, sy)
      seen[sy * sw + sx] = 1
      while (stack.length) {
        const cy = stack.pop()
        const cx = stack.pop()
        pixels++
        if (cx < x0) x0 = cx
        if (cx > x1) x1 = cx
        if (cy < y0) y0 = cy
        if (cy > y1) y1 = cy
        const neighbours = [cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1]
        for (let n = 0; n < neighbours.length; n += 2) {
          const nx = neighbours[n]
          const ny = neighbours[n + 1]
          if (nx < 0 || ny < 0 || nx >= sw || ny >= H) continue
          if (seen[ny * sw + nx] || !isWhite(nx, ny)) continue
          seen[ny * sw + nx] = 1
          stack.push(nx, ny)
        }
      }
      if (pixels >= MIN_PART_BLOB_PIXELS) {
        blobs.push({ x0, x1, y0, y1, pixels, w: x1 - x0 + 1, h: y1 - y0 + 1 })
      }
    }
  }
  return blobs
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

/**
 * Locate the team skull column and the UI scale it implies.
 *
 * Candidate columns are clusters of roughly square, similarly sized white
 * blobs. The team skull column is the leftmost such cluster — everything
 * further right belongs to the player cards, whose per-player kill counts must
 * never be mistaken for the team total.
 */
export function detectSkullColumn(bitmap) {
  const blobs = whiteBlobs(bitmap)
  if (blobs.length === 0) return null

  const tolerance = Math.max(3, Math.round(bitmap.width * 0.01))
  const columns = new Map()
  for (const blob of blobs) {
    // Whole skulls only, to identify the column: square-ish and big enough.
    // Medal badges and avatar corners fail one or the other.
    if (blob.pixels < MIN_COLUMN_BLOB_PIXELS) continue
    if (Math.abs(blob.w - blob.h) / Math.max(blob.w, blob.h) > 0.35) continue
    const key = Math.round((blob.x0 + blob.x1) / 2 / tolerance)
    if (!columns.has(key)) columns.set(key, [])
    columns.get(key).push(blob)
  }

  const candidates = [...columns.entries()]
    .filter(([, list]) => list.length >= MIN_SKULLS_PER_COLUMN)
    .map(([key, list]) => {
      const size = median(list.map((b) => b.w))
      // Drop outliers so one stray blob cannot set the scale.
      const kept = list.filter((b) => Math.abs(b.w - size) <= Math.max(2, size * 0.25))
      return { key, list: kept, size }
    })
    .filter((c) => c.list.length >= MIN_SKULLS_PER_COLUMN)

  if (candidates.length === 0) return null

  // Leftmost alone is not safe: the rank 1-3 medal badges are big and bright,
  // and three of them line up at a smaller x than the skulls. The real column
  // has one blob per row, so require a candidate to be within half the best
  // count before preferring it for being further left — that rejects the
  // medals while still choosing the team skull over the player-card skulls.
  const mostRows = Math.max(...candidates.map((c) => c.list.length))
  const chosen = candidates
    .filter((c) => c.list.length >= Math.max(MIN_SKULLS_PER_COLUMN, mostRows * 0.5))
    .sort((a, b) => a.key - b.key)[0]
  if (!chosen) return null

  // Now take every white piece sitting in that column, jaw included, so a row's
  // bounding box spans the whole skull. The cell offsets are measured from the
  // centre of that full span; using the cranium alone shifts every crop up.
  const left = Math.min(...chosen.list.map((b) => b.x0))
  const right = Math.max(...chosen.list.map((b) => b.x1))
  // Strictly inside the cranium's own span. The jaw sits directly beneath it,
  // but the kill digits start just past its right edge — any tolerance here
  // pulls a digit into the skull box and corrupts both the row centre and the
  // kills crop.
  const parts = blobs.filter((b) => {
    const cx = (b.x0 + b.x1) / 2
    return cx >= left && cx <= right
  })

  const rows = groupBlobsIntoRows(parts, chosen.size)

  // Pitch is the accurate scale signal; the skull only stands in when there
  // are too few rows to measure a pitch from.
  let k = chosen.size / REF_SKULL_SIZE
  if (rows.length >= 3) {
    const pitches = rows.slice(1).map((r, i) => r.cy - rows[i].cy)
    // The sticky rank-1 header sits closer to the row below it than a normal
    // pitch, so the median rejects it rather than being dragged down by it.
    k = median(pitches) / REF_ROW_PITCH
  }

  return { blobs: chosen.list, rows, skullSize: chosen.size, k }
}

/**
 * Scale of the capture: 1 when the skull measures REF_SKULL_SIZE across.
 * Falls back to the historical width ratio only if no skull column is found.
 */
export function scaleFactor(bitmapOrWidth) {
  if (typeof bitmapOrWidth === 'number') return bitmapOrWidth / 1135
  const column = detectSkullColumn(bitmapOrWidth)
  return column ? column.k : bitmapOrWidth.width / 1135
}

/**
 * Every row — medal banner or plain — carries a white skull immediately left of
 * its team kill total, so a vertical run of white pixels in that column marks a
 * row and its horizontal extent locates the cells beside it.
 */
export function detectRows(bitmap, column = detectSkullColumn(bitmap)) {
  if (!column) return []
  return column.rows
}

/**
 * Group the column's blobs into rows.
 *
 * The skull is drawn as two pieces, cranium and jaw, and upscaling separates
 * them far enough that a scanline treats each as its own row. Grouping by
 * vertical proximity — in units of the skull's own size, so it holds at any
 * scale — merges them back into one row whose bounding box spans both, which
 * is what the cell offsets are measured against.
 */
function groupBlobsIntoRows(blobs, skullSize) {
  const sorted = [...blobs].sort((a, b) => a.y0 - b.y0)
  const gap = Math.max(2, skullSize * 0.8)
  const rows = []

  for (const blob of sorted) {
    const current = rows[rows.length - 1]
    if (current && blob.y0 - current.y1 <= gap) {
      current.y1 = Math.max(current.y1, blob.y1)
      current.x0 = Math.min(current.x0, blob.x0)
      current.x1 = Math.max(current.x1, blob.x1)
    } else {
      rows.push({ x0: blob.x0, x1: blob.x1, y0: blob.y0, y1: blob.y1 })
    }
  }

  return rows.map((r) => ({
    cy: (r.y0 + r.y1 + 1) / 2,
    skullX0: r.x0,
    skullX1: r.x1,
  }))
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
  const w = RANK_W * k
  return {
    x: Math.max(0, row.skullX0 - (RANK_GAP + RANK_W) * k),
    y: row.cy + RANK_DY * k,
    w,
    h: RANK_H * k,
  }
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
// Stricter bar for a capture rendered below reference size, where the same
// thresholds start producing wrong answers rather than uncertain ones.
export const SMALL_MATCH_SCORE = 0.94
export const SMALL_MATCH_MARGIN = 0.04

export const MIN_MATCH_SCORE = 0.86
// Two classes this close apart (O/D/Q, 8/B) is a coin flip, not a read.
export const MIN_MATCH_MARGIN = 0.02

function readCell(mask, templates, segmentOptions) {
  const boxes = segmentGlyphs(mask, segmentOptions)
  return boxes.map((box) => matchGlyph(normalizeGlyph(mask, box), templates))
}

function confident(match, minScore = MIN_MATCH_SCORE, minMargin = MIN_MATCH_MARGIN) {
  return Boolean(match) && match.score >= minScore && match.margin >= minMargin
}

/**
 * Read every row of one capture.
 *
 * Each row carries its own confidence. A row is only trustworthy when the slot
 * letter and every kill digit matched a template outright; anything short of
 * that is returned with `certain: false` so the caller can surface it for
 * checking rather than folding a guess into the standings.
 */
/**
 * Below this scale the glyphs carry too few pixels to separate reliably —
 * measured at 0.75x, where the reader produced 9 outright wrong cells rather
 * than merely uncertain ones. Declining is the only safe response: a wrong
 * slot letter awards a team's kills to somebody else.
 */
export const MIN_RELIABLE_SCALE = 0.95

export function readCapture(bitmap, atlas, thresholds = {}) {
  const letters = loadTemplates(atlas.letters)
  const digits = loadTemplates(atlas.digits)
  // Rank digits are drawn far larger than kill digits. Normalisation aliases
  // an upscaled small glyph differently from a downscaled large one, so mixing
  // both into one pool blunted every match; they get their own templates.
  const rankTemplates = { ...loadTemplates(atlas.rankDigits), ...loadTemplates(atlas.marks) }

  const column = detectSkullColumn(bitmap)
  if (!column) return []
  const k = column.k
  const rows = detectRows(bitmap, column)
  const read = []

  // A capture rendered below reference size has genuinely fewer pixels per
  // glyph, so the same thresholds that are safe at 1x start producing wrong
  // answers. Demand more agreement from a small capture instead of refusing
  // it outright: a stricter bar flags the marginal cells rather than guessing.
  const small = (thresholds.sourceScale ?? k) < 1
  const minScore = thresholds.minScore ?? (small ? SMALL_MATCH_SCORE : MIN_MATCH_SCORE)
  const minMargin = thresholds.minMargin ?? (small ? SMALL_MATCH_MARGIN : MIN_MATCH_MARGIN)

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
      if (digitsOnly.every((m) => confident(m, minScore, minMargin) && /^\d$/.test(m.label))) {
        const value = Number(digitsOnly.map((m) => m.label).join(''))
        if (value >= 1 && value <= 99) rank = value
      }
    }

    const readable = k >= MIN_RELIABLE_SCALE
    const killsCertain =
      readable && killMatches.length > 0 && killMatches.every((m) => confident(m, minScore, minMargin) && /^\d$/.test(m.label))
    const kills = killsCertain ? Number(killMatches.map((m) => m.label).join('')) : null
    const slotLetter = readable && confident(letterMatch, minScore, minMargin) ? letterMatch.label : null
    if (!readable) rank = null

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

  // No rank readable anywhere in this capture. Nothing can be inferred, but the
  // rows are still returned rankless so the caller reports them rather than
  // dropping the whole capture in silence — which is exactly what used to
  // happen, and made a capture's rows vanish with no message at all.
  if (lead === rows.length) return rows

  if (lead > 0) {
    const firstReadable = rows[lead].rank
    const contiguous = firstReadable === lead + 1

    if (contiguous) {
      // Top of the board: the leading rows are the medal ranks 1, 2, 3.
      for (let i = 0; i < lead; i++) rows[i].rank = i + 1
    } else {
      // Scrolled: row 0 is the sticky rank-1 header. Anything between it and
      // the first readable rank is a real row whose own rank was cut off or
      // unreadable, so it counts backwards from that rank — it is NOT another
      // copy of rank 1. Giving them all rank 1 collapsed genuine rows onto the
      // header and lost them.
      rows[0].rank = 1
      for (let i = 1; i < lead; i++) {
        const inferred = firstReadable - (lead - i)
        rows[i].rank = inferred >= 2 ? inferred : null
        // Its own rank was never read, so it is worth a second look.
        rows[i].certain = false
      }
    }
  }

  // Ranks below the header run consecutively down the capture, so a rank the
  // matcher could not read sits a fixed number of rows from one it could. Only
  // accept it when the neighbour above and the neighbour below agree; a lone
  // anchor could itself be misread, and a wrong rank misplaces the team.
  for (let i = lead; i < rows.length; i++) {
    if (rows[i].rank !== null) continue

    let before = null
    for (let j = i - 1; j >= lead; j--) {
      if (rows[j].rank !== null) {
        before = rows[j].rank + (i - j)
        break
      }
    }
    let after = null
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].rank !== null) {
        after = rows[j].rank - (j - i)
        break
      }
    }

    const agreed = before !== null && after !== null && before === after
    if (agreed && before >= 1) {
      rows[i].rank = before
    } else {
      rows[i].certain = false
    }
  }

  return rows
}

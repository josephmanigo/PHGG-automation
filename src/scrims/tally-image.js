import { createHash } from 'node:crypto'
import { Jimp } from 'jimp'
import { detectRows } from './tally-glyphs.js'

export const SCOREBOARD_TARGET_WIDTH = 1920
export const SCOREBOARD_TARGET_HEIGHT = 1080
export const SCOREBOARD_CROP_WIDTH = 1600
export const SCOREBOARD_CROP_HEIGHT = 480

const SHARPEN_KERNEL = Object.freeze([
  [0, -0.3, 0],
  [-0.3, 2.2, -0.3],
  [0, -0.3, 0],
])

function requireImageBuffer(buffer, label = 'scoreboard image') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error(`A non-empty ${label} buffer is required.`)
  }
  return buffer
}

function positiveInteger(value, fallback, label) {
  const number = value === undefined || value === null || value === ''
    ? fallback
    : Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return number
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

/**
 * The local reader already has a deterministic team-skull detector. Reuse its
 * row centres as navigation hints for vision, but never as extracted values.
 */
export function scoreboardRowHints(bitmap) {
  const rows = detectRows(bitmap)
  if (rows.length === 0) return []

  const pitches = rows
    .slice(1)
    .map((row, index) => row.cy - rows[index].cy)
    .filter((pitch) => pitch > 0)
  const rowHeight = Math.max(24, median(pitches) || bitmap.height * 0.08)

  return rows.map((row) => {
    const top = Math.max(0, row.cy - (rowHeight / 2))
    const bottom = Math.min(bitmap.height, row.cy + (rowHeight / 2))
    return {
      bbox: [
        0,
        Math.round((top / bitmap.height) * 1000),
        1000,
        Math.max(1, Math.round(((bottom - top) / bitmap.height) * 1000)),
      ],
      confidence: 1,
    }
  })
}

function containTransform(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const scale = targetWidth / targetHeight > sourceWidth / sourceHeight
    ? targetHeight / sourceHeight
    : targetWidth / sourceWidth
  const contentWidth = Math.max(1, Math.round(sourceWidth * scale))
  const contentHeight = Math.max(1, Math.round(sourceHeight * scale))
  return {
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    contentWidth,
    contentHeight,
    offsetX: Math.round((targetWidth - contentWidth) / 2),
    offsetY: Math.round((targetHeight - contentHeight) / 2),
  }
}

/**
 * Build NIGHTRAID-style visual evidence without touching the original bytes:
 * preserve aspect ratio, letterbox to 1920x1080, lift contrast/brightness, and
 * sharpen the small rank/slot/kill glyphs.
 */
export async function prepareScoreboardImage(buffer, options = {}) {
  requireImageBuffer(buffer)
  const originalSnapshot = Buffer.from(buffer)
  const image = await Jimp.fromBuffer(originalSnapshot)
  const rowHints = scoreboardRowHints(image.bitmap)
  const sourceWidth = image.bitmap.width
  const sourceHeight = image.bitmap.height
  const targetWidth = positiveInteger(
    options.targetWidth,
    SCOREBOARD_TARGET_WIDTH,
    'scoreboard target width',
  )
  const targetHeight = positiveInteger(
    options.targetHeight,
    SCOREBOARD_TARGET_HEIGHT,
    'scoreboard target height',
  )
  const enhancedTransform = containTransform(
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
  )

  image.background = 0x000000ff
  image.contain({ w: targetWidth, h: targetHeight })
  // Jimp brightness is a multiplier (unlike ffmpeg's additive eq value).
  // 0.02 turns every useful pixel black; 1.02 is the intended 2% lift.
  image.brightness(1.02)
  image.contrast(0.3)
  image.convolution(SHARPEN_KERNEL)

  const enhancedBuffer = await image.getBuffer('image/png')
  if (!buffer.equals(originalSnapshot)) {
    throw new Error('Scoreboard preprocessing modified the original image buffer.')
  }

  return {
    enhancedBuffer,
    rowHints,
    width: targetWidth,
    height: targetHeight,
    enhancedTransform,
    originalSha256: createHash('sha256').update(originalSnapshot).digest('hex'),
    enhancedSha256: createHash('sha256').update(enhancedBuffer).digest('hex'),
  }
}

/** Convert and pad a Gemini 0-1000 bounding box without allowing it off-image. */
export function normalizedScoreboardCropBox(value, padding = 30) {
  if (
    !Array.isArray(value)
    || value.length !== 4
    || value.some((item) => !Number.isFinite(Number(item)))
  ) {
    throw new Error('A scoreboard crop requires [x, y, width, height].')
  }
  const [rawX, rawY, rawWidth, rawHeight] = value.map(Number)
  if (
    rawX < 0
    || rawY < 0
    || rawWidth <= 0
    || rawHeight <= 0
    || rawX + rawWidth > 1000
    || rawY + rawHeight > 1000
  ) {
    throw new Error('The scoreboard crop is outside the 0-1000 coordinate space.')
  }
  const margin = Math.max(0, Math.min(150, Number(padding) || 0))
  const x = Math.max(0, rawX - margin)
  const y = Math.max(0, rawY - margin)
  const right = Math.min(1000, rawX + rawWidth + margin)
  const bottom = Math.min(1000, rawY + rawHeight + margin)
  return [x, y, right - x, bottom - y]
}

/**
 * Map a box measured on the untouched original into the enhanced image's
 * letterboxed coordinate space. This keeps both recovery crops on the same
 * physical row for phone, portrait, and other non-16:9 screenshots.
 */
export function transformScoreboardBoxForContainedImage(value, transform) {
  const [x, y, width, height] = normalizedScoreboardCropBox(value, 0)
  const required = [
    'targetWidth',
    'targetHeight',
    'contentWidth',
    'contentHeight',
    'offsetX',
    'offsetY',
  ]
  if (!transform || required.some((key) => !Number.isFinite(Number(transform[key])))) {
    throw new Error('The enhanced scoreboard crop requires valid letterbox transform metadata.')
  }
  const targetWidth = Number(transform.targetWidth)
  const targetHeight = Number(transform.targetHeight)
  const contentWidth = Number(transform.contentWidth)
  const contentHeight = Number(transform.contentHeight)
  const offsetX = Number(transform.offsetX)
  const offsetY = Number(transform.offsetY)
  if (targetWidth <= 0 || targetHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    throw new Error('The enhanced scoreboard crop transform contains invalid dimensions.')
  }

  const left = ((offsetX + ((x / 1000) * contentWidth)) / targetWidth) * 1000
  const top = ((offsetY + ((y / 1000) * contentHeight)) / targetHeight) * 1000
  const right = ((offsetX + (((x + width) / 1000) * contentWidth)) / targetWidth) * 1000
  const bottom = ((offsetY + (((y + height) / 1000) * contentHeight)) / targetHeight) * 1000
  const safeLeft = Math.max(0, Math.min(1000, left))
  const safeTop = Math.max(0, Math.min(1000, top))
  const safeRight = Math.max(safeLeft, Math.min(1000, right))
  const safeBottom = Math.max(safeTop, Math.min(1000, bottom))
  return [safeLeft, safeTop, safeRight - safeLeft, safeBottom - safeTop]
}

export async function cropScoreboardImage(buffer, bbox, options = {}) {
  requireImageBuffer(buffer, 'scoreboard crop source')
  const [x, y, width, height] = normalizedScoreboardCropBox(
    bbox,
    options.padding ?? 30,
  )
  const targetWidth = positiveInteger(
    options.targetWidth,
    SCOREBOARD_CROP_WIDTH,
    'scoreboard crop width',
  )
  const targetHeight = positiveInteger(
    options.targetHeight,
    SCOREBOARD_CROP_HEIGHT,
    'scoreboard crop height',
  )
  const image = await Jimp.fromBuffer(Buffer.from(buffer))
  const cropX = Math.max(0, Math.floor((x / 1000) * image.bitmap.width))
  const cropY = Math.max(0, Math.floor((y / 1000) * image.bitmap.height))
  const cropRight = Math.min(
    image.bitmap.width,
    Math.ceil(((x + width) / 1000) * image.bitmap.width),
  )
  const cropBottom = Math.min(
    image.bitmap.height,
    Math.ceil(((y + height) / 1000) * image.bitmap.height),
  )

  image.crop({
    x: cropX,
    y: cropY,
    w: Math.max(1, cropRight - cropX),
    h: Math.max(1, cropBottom - cropY),
  })
  image.background = 0x000000ff
  image.contain({ w: targetWidth, h: targetHeight })
  image.convolution(SHARPEN_KERNEL)
  return image.getBuffer('image/png')
}

export async function createScoreboardCropVariants({
  originalBuffer,
  enhancedBuffer,
  bbox,
  enhancedTransform,
}, options = {}) {
  const originalBox = normalizedScoreboardCropBox(bbox, options.padding ?? 30)
  const enhancedBox = transformScoreboardBoxForContainedImage(
    originalBox,
    enhancedTransform,
  )
  const cropOptions = { ...options, padding: 0 }
  const [originalCrop, enhancedCrop] = await Promise.all([
    cropScoreboardImage(originalBuffer, originalBox, cropOptions),
    cropScoreboardImage(enhancedBuffer, enhancedBox, cropOptions),
  ])
  return {
    originalCrop,
    enhancedCrop,
    bbox: originalBox,
    enhancedBbox: enhancedBox,
  }
}

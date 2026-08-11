import fs from 'node:fs'
import path from 'node:path'
import { createSign } from 'node:crypto'

export const DEFAULT_SPREADSHEET_ID = '1N3oh4z2FbnWzfXg79UNvegoP44FO9TkYxic8fN8I17U'
const DEFAULT_WORKSHEET_GID = '707255476'

/**
 * Link to the live scoresheet, used by the View Standings button. Built from
 * the same id the bot writes to, so pointing the bot at another spreadsheet
 * moves the button with it. Override wholesale with TALLY_SHEET_URL.
 */
export function getSpreadsheetUrl() {
  if (process.env.TALLY_SHEET_URL) return process.env.TALLY_SHEET_URL
  const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID
  const gid = process.env.GOOGLE_SHEETS_WORKSHEET_GID || DEFAULT_WORKSHEET_GID
  return `https://docs.google.com/spreadsheets/d/${id}/edit?gid=${gid}#gid=${gid}`
}

export const ROUND_COLUMNS = Object.freeze({
  1: { place: 'K', placementPoints: 'L', kills: 'M' },
  2: { place: 'N', placementPoints: 'O', kills: 'P' },
  3: { place: 'Q', placementPoints: 'R', kills: 'S' },
  4: { place: 'T', placementPoints: 'U', kills: 'V' },
})

// Scoresheet geometry — teams occupy rows 8..32 (25 slots).
export const SCORE_START_ROW = 8
export const SCORE_TOTAL_SLOTS = 25
export const SCORE_END_ROW = SCORE_START_ROW + SCORE_TOTAL_SLOTS - 1 // 32

// Verified live column layout of '4 Rounds - 25 Teams (Do Not Edit)':
// H=SLOT  I=SLOT NO.  J=TEAM  K..V=rounds 1-4  X=TOTAL EARNED  Y=TOTAL DEDUCTED
// Z=FINAL SCORE  AA=RANK  AC..AG=penalties table
export const TEAM_COLUMN = 'J'
export const FINAL_SCORE_COLUMN = 'Z'
export const RANK_COLUMN = 'AA'
// The highlight covers TEAM..RANK. It deliberately starts at J, not H, so the
// SLOT and SLOT NO. columns keep their own template styling.
const HIGHLIGHT_START_COLUMN_INDEX = 9 // J (TEAM)
const HIGHLIGHT_END_COLUMN_INDEX = 27 // exclusive -> through AA

// Marker embedded in the rule we own so repeat syncs replace it instead of
// stacking a new copy. N("text") evaluates to 0, so it never affects the result.
const RANK_HIGHLIGHT_MARKER = 'PHGG_RANK_TOP3'

// Conditional-format rules that are "the rank 1/2/3 highlight" and are therefore
// ours to replace or remove. Everything else on the sheet is left untouched.
const RANK_HIGHLIGHT_SIGNATURES = [
  RANK_HIGHLIGHT_MARKER,
  '$AD8=1', // legacy rule that read the penalties table instead of the RANK column
  'LARGE($Z$8:$Z$3', // older "top 3 by final score" variant
]

// H4 is the big merged title banner. It ships with a "[DEVICE]" placeholder
// that has to be swapped for PC / MOBILE on tally and put back on /clear.
export const TITLE_BANNER_TEMPLATE =
  'PH GAMING GUILD  -  OPERATION :  DOMINATION\nBLOODSTRIKE SCRIMMAGE • [DEVICE]'
const TITLE_DEVICE_PLACEHOLDER = '[DEVICE]'

export function renderTitleBanner(deviceLabel) {
  return TITLE_BANNER_TEMPLATE.replace(TITLE_DEVICE_PLACEHOLDER, String(deviceLabel || 'PC').toUpperCase())
}

// H5 in the blank template. /clear puts this back rather than leaving the
// header line empty, so a cleared sheet matches the default scoresheet exactly.
export const DATE_HEADER_TEMPLATE = '[DD-Mmm-YYYY]   |   [HH:MM] PM   |   4 ROUNDS'

/**
 * Team names as the scoresheet shows them: "NR • NIGHTRAID ESPORTS".
 * The bracket form ("[NR] NIGHTRAID ESPORTS") did not match the sheet layout.
 */
export function formatSheetTeamName({ tag, name } = {}) {
  const cleanTag = String(tag || '').trim()
  const cleanName = String(name || '').trim()
  if (!cleanTag) return cleanName
  if (!cleanName) return cleanTag
  return `${cleanTag} • ${cleanName}`
}

/**
 * Slot index (0-based) for the codes the parsers emit: "1-A", "01A", "A".
 * Returns -1 when the code is missing or unreadable, which keeps such an entry
 * out of the sheet rather than letting it land on an arbitrary row.
 */
export function slotIndexFromCode(slotCode) {
  const raw = String(slotCode ?? '').toUpperCase().replace(/[\s\-]/g, '')
  if (!raw || raw === '??') return -1

  const numbered = /^(\d{1,2})([A-Z])$/.exec(raw)
  if (numbered) {
    const index = Number(numbered[1]) - 1
    return index === numbered[2].charCodeAt(0) - 65 ? index : -1
  }
  if (/^[A-Z]$/.test(raw)) return raw.charCodeAt(0) - 65
  if (/^\d{1,2}$/.test(raw)) return Number(raw) - 1
  return -1
}

const auditStore = new Map()

/**
 * Placement points are a live VLOOKUP against the B8:C32 points table. The bot
 * must never replace this formula with a literal, or the column stops
 * recalculating for that row forever.
 *
 * Used once a scrim is running. The bare template formula returns #N/A for any
 * round not yet played, and X = SUM(L,M,O,P,...) propagates that error through
 * FINAL SCORE (Z) and RANK (AA) — which is why ranking, and therefore the
 * rank highlight, could never work mid-scrim. This version keeps every case
 * numeric-or-text so the totals always compute:
 *   - place empty  -> "" (round not played yet)
 *   - place 'X'    -> "X" (slot unused, or team not in this screenshot)
 *   - place 1..25  -> the placement points
 * SUM ignores text, so the totals stay correct in all three cases.
 */
export function placementPointsFormula(placeColumn, row) {
  const cell = `${placeColumn}${row}`
  return `=IF(${cell}="","",IFERROR(VLOOKUP(${cell},$B$8:$C$32,2,0),"X"))`
}

/**
 * The formula exactly as the blank scoresheet ships it. /clear puts this back,
 * so a cleared sheet shows #N/A down the placement, total, score and rank
 * columns just like the untouched default template.
 */
export function defaultPlacementPointsFormula(placeColumn, row) {
  return `=VLOOKUP(${placeColumn}${row},$B$8:$C$32,2,0)`
}

export function buildRankHighlightFormula(startRow = SCORE_START_ROW) {
  return (
    `=AND(N("${RANK_HIGHLIGHT_MARKER}")=0,` +
    `$${TEAM_COLUMN}${startRow}<>"",` +
    `ISNUMBER($${RANK_COLUMN}${startRow}),` +
    `$${RANK_COLUMN}${startRow}<=3,` +
    `$${FINAL_SCORE_COLUMN}${startRow}>0)`
  )
}

function isRankHighlightRule(rule) {
  const formula = rule?.booleanRule?.condition?.values?.[0]?.userEnteredValue
  if (typeof formula !== 'string') return false
  return RANK_HIGHLIGHT_SIGNATURES.some((signature) => formula.includes(signature))
}

async function fetchSheetMeta({ spreadsheetId, sheetName, accessToken }) {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties,sheets.conditionalFormats`
  const metaResp = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!metaResp.ok) {
    throw new Error(`Could not read spreadsheet metadata (${metaResp.status}): ${await metaResp.text()}`)
  }
  const metaData = await metaResp.json()
  const targetSheet =
    (metaData.sheets || []).find((s) => s.properties?.title === sheetName) || metaData.sheets?.[0]
  if (!targetSheet || targetSheet.properties?.sheetId === undefined) {
    throw new Error(`Worksheet "${sheetName}" was not found in the spreadsheet.`)
  }
  return {
    sheetId: targetSheet.properties.sheetId,
    conditionalFormats: targetSheet.conditionalFormats || [],
  }
}

/**
 * Delete requests for every rank-highlight rule on the sheet, highest index
 * first so the remaining indexes stay valid while the batch is applied.
 */
function buildRankHighlightDeleteRequests(sheetId, conditionalFormats) {
  return conditionalFormats
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => isRankHighlightRule(rule))
    .sort((a, b) => b.index - a.index)
    .map(({ index }) => ({
      deleteConditionalFormatRule: { sheetId, index },
    }))
}

/**
 * Re-assert exactly one yellow "rank 1, 2, 3" rule for rows 8..32, columns H..AA.
 * Any previous copy (including the broken legacy versions) is deleted first.
 */
export async function applyRankHighlight({ spreadsheetId, sheetName, accessToken }) {
  const { sheetId, conditionalFormats } = await fetchSheetMeta({ spreadsheetId, sheetName, accessToken })

  const requests = buildRankHighlightDeleteRequests(sheetId, conditionalFormats)
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [
          {
            sheetId,
            startRowIndex: SCORE_START_ROW - 1,
            endRowIndex: SCORE_END_ROW,
            startColumnIndex: HIGHLIGHT_START_COLUMN_INDEX,
            endColumnIndex: HIGHLIGHT_END_COLUMN_INDEX,
          },
        ],
        booleanRule: {
          condition: {
            type: 'CUSTOM_FORMULA',
            values: [{ userEnteredValue: buildRankHighlightFormula() }],
          },
          format: {
            backgroundColor: { red: 1.0, green: 1.0, blue: 0.0 }, // Bright Yellow #FFFF00
            // Force black text. Without it the cell keeps its own colour, and
            // FINAL SCORE / RANK are white on their dark fill — unreadable once
            // the row turns yellow.
            textFormat: { bold: true, foregroundColor: { red: 0, green: 0, blue: 0 } },
          },
        },
      },
      index: 0,
    },
  })

  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  })
  if (!response.ok) {
    throw new Error(`Rank highlight update failed (${response.status}): ${await response.text()}`)
  }
  return { rulesReplaced: requests.length - 1 }
}

/**
 * Remove the rank 1/2/3 highlight without disturbing the sheet's own
 * conditional formatting (colour scales, the "x" marker styling, ...).
 */
export async function removeRankHighlight({ spreadsheetId, sheetName, accessToken }) {
  const { sheetId, conditionalFormats } = await fetchSheetMeta({ spreadsheetId, sheetName, accessToken })
  const requests = buildRankHighlightDeleteRequests(sheetId, conditionalFormats)
  if (requests.length === 0) return { rulesRemoved: 0 }

  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  })
  if (!response.ok) {
    throw new Error(`Rank highlight removal failed (${response.status}): ${await response.text()}`)
  }
  return { rulesRemoved: requests.length }
}

export function resolveGoogleCredentials() {
  let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL
  let privateKey = process.env.GOOGLE_PRIVATE_KEY || process.env.GOOGLE_SHEETS_PRIVATE_KEY

  if (email && privateKey) {
    return { email, privateKey }
  }

  const cwd = process.cwd()
  const thisDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'))
  const projectRoot = path.resolve(thisDir, '..', '..')
  const credFileName = 'phgg-504518-2bd2b9666931.json'

  const candidateFiles = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.GOOGLE_CREDENTIALS_PATH,
    path.join(cwd, credFileName),
    path.join(cwd, '..', credFileName),
    path.join(projectRoot, credFileName),
    path.join(projectRoot, '..', credFileName),
    path.join(thisDir, credFileName),
    path.join(thisDir, '..', credFileName),
  ].filter(Boolean)

  for (const filePath of candidateFiles) {
    try {
      if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, 'utf8')
        const parsed = JSON.parse(fileContent)
        if (parsed.client_email && parsed.private_key) {
          console.log(`[TALLY] Google credentials loaded from: ${filePath}`)
          return { email: parsed.client_email, privateKey: parsed.private_key }
        }
      }
    } catch {
      // Continue
    }
  }

  console.warn(`[TALLY] Could not find Google credentials file (${credFileName}). Searched: ${candidateFiles.join(', ')}`)
  return { email: null, privateKey: null }
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

let cachedToken = null
let tokenExpiry = 0

export async function getGoogleAccessToken(email, privateKey) {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && now < tokenExpiry - 60) {
    return cachedToken
  }

  const cleanPrivateKey = privateKey.replace(/\\n/g, '\n')

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = base64url(
    JSON.stringify({
      iss: email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  )

  const signatureInput = `${header}.${claim}`
  const signer = createSign('RSA-SHA256')
  signer.update(signatureInput)
  const signature = base64url(signer.sign(cleanPrivateKey))
  const jwt = `${signatureInput}.${signature}`

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Google Auth failed (${response.status}): ${errorText}`)
  }

  const data = await response.json()
  cachedToken = data.access_token
  tokenExpiry = now + 3500
  return cachedToken
}

function sanitizeSheetText(text) {
  if (typeof text !== 'string') return text
  const trimmed = text.trim()
  if (/^[=+\-@]/.test(trimmed)) {
    throw new Error(`Formula injection rejected for team name: "${text}"`)
  }
  return trimmed
}

export function getAuditRecord(auditId) {
  return auditStore.get(auditId) || null
}

export function getAllAudits() {
  return [...auditStore.values()]
}

export async function syncScoresToGoogleSheet({
  spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID,
  sheetName = process.env.GOOGLE_SHEETS_WORKSHEET_NAME || '4 Rounds - 25 Teams (Do Not Edit)',
  roundNumber,
  entries,
  registeredTeams = [],
  device = 'PC',
  timeLabel = '10:00 PM',
  roundsLabel = '4 ROUNDS',
  submissionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  actorUserId = 'system',
}) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL
  const { email: clientEmail, privateKey } = resolveGoogleCredentials()

  const roundNum = Number(roundNumber)
  const roundCols = ROUND_COLUMNS[roundNum]
  if (!roundCols) {
    throw new Error(`Round ${roundNum} is invalid. Supported rounds are 1, 2, 3, or 4.`)
  }

  // 0. Never tally against an empty team-slot board. Without a roster every
  //    row falls through to the "not registered" branch and the whole round
  //    gets overwritten with X, silently wiping scores that were already there.
  if (!Array.isArray(registeredTeams) || registeredTeams.length === 0) {
    throw new Error(
      'No registered teams on the slot board, so nothing can be tallied. ' +
        'Refresh the team slots (!refreshteams) and try again.',
    )
  }

  // Re-confirming the same round is allowed. Every write targets that round's
  // own cells with the same values, so repeating it is idempotent — and
  // blocking it stopped a legitimate retry after the review had to be
  // recovered. Earlier attempts are still recorded in the audit log below.
  const previousAttempt = [...auditStore.values()].find(
    (a) => a.submissionId === submissionId && a.roundNumber === roundNum && a.status === 'verified',
  )
  if (previousAttempt) {
    console.log(
      `[TALLY] Re-writing round ${roundNum} for submission ${submissionId} (previous audit ${previousAttempt.auditId}).`,
    )
  }

  const payload = {
    submissionId,
    spreadsheetId,
    sheetName,
    roundNumber: roundNum,
    entries,
    registeredTeams,
    device,
    timeLabel,
    roundsLabel,
  }

  // Support Webhook endpoint if configured
  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `Google Sheets webhook failed (${response.status})${detail ? `: ${detail}` : '.'}`,
      )
    }
    return {
      success: true,
      roundNumber: roundNum,
      teamsTallied: entries.length,
      verificationStatus: 'WEBHOOK_ACCEPTED',
    }
  }

  if (!clientEmail || !privateKey) {
    throw new Error('Google Sheets Service Account credentials (client_email / private_key) could not be loaded. Ensure phgg-504518-2bd2b9666931.json is present.')
  }

  const accessToken = await getGoogleAccessToken(clientEmail, privateKey)
  const auditId = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

  // Format current date in PH Time in CAPITAL LETTERS (e.g. 21-JUL-2026 or 05-AUG-2026)
  const now = new Date()
  const dateFormatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(now).replace(/ /g, '-').toUpperCase()

  // Determine starting row: standard NIGHTRAID scoresheet is Row 8 to 32
  const startRow = SCORE_START_ROW
  const totalSlots = SCORE_TOTAL_SLOTS

  // 2. Read Current Scoresheet State for Backup & Pre-Write Validation
  const readRange = `'${sheetName}'!H${startRow}:V${startRow + totalSlots - 1}`
  const readUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(readRange)}` +
    '?valueRenderOption=FORMULA'

  let currentCells
  try {
    const readResponse = await fetch(readUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!readResponse.ok) {
      const detail = await readResponse.text().catch(() => '')
      throw new Error(
        `Google Sheets pre-read failed (${readResponse.status})${detail ? `: ${detail}` : '.'}`,
      )
    }
    const readData = await readResponse.json()
    currentCells = readData.values || []
  } catch (err) {
    throw new Error(`Could not safely read the sheet before writing: ${err.message}`)
  }

  const updateData = []
  const writePlanTargets = []
  let teamsTalliedCount = 0
  let missingMarkersAddedCount = 0
  // Registered teams that hold a slot but do not appear in this screenshot.
  // They are marked X, never scored — reported back so the result can be checked.
  const registeredNotInScreenshot = []

  // Screenshot rows that matched no registered slot. They are never written to
  // the sheet; surfaced so a misread or unregistered team does not pass silently.
  const unmatchedScreenshotEntries = entries
    .filter((e) => !registeredTeams.some((t) => t.slotIndex === slotIndexFromCode(e.slotCode)))
    .map((e) => e.teamQuery || e.name || e.slotCode || 'unknown')

  // Update Header Title Cells with Device PC/MOBILE.
  // H4 is the big merged banner that is actually visible on the scoresheet;
  // writing only H3 left the "[DEVICE]" placeholder on screen all scrim.
  const deviceLabel = String(device || 'PC').toUpperCase()
  updateData.push({
    range: `'${sheetName}'!H3`,
    values: [[`BLOODSTRIKE SCRIMMAGE • ${deviceLabel}`]],
  })
  updateData.push({
    range: `'${sheetName}'!H4`,
    values: [[renderTitleBanner(deviceLabel)]],
  })

  // Update Header Date Cell (H5 contains capital date, time, and rounds label)
  const formattedRoundsLabel = String(roundsLabel || '4 ROUNDS').toUpperCase()
  updateData.push({
    range: `'${sheetName}'!H5`,
    values: [[`${dateFormatted}   |   ${timeLabel}   |   ${formattedRoundsLabel}`]],
  })

  // Process rows 8 through 32
  for (let i = 0; i < totalSlots; i++) {
    const row = startRow + i
    const slotLetter = String.fromCharCode(65 + i)
    const slotCode = `${i + 1}-${slotLetter}`
    const altSlotCode = `${String(i + 1).padStart(2, '0')}${slotLetter}`

    const existingRowValues = currentCells[i] || []
    // Columns in H..V:
    // H=0 (Slot Code), I=1 (Slot Num), J=2 (Team), K=3 (R1 Place), L=4 (R1 Pts), M=5 (R1 Kills)
    // N=6 (R2 Place), O=7 (R2 Pts), P=8 (R2 Kills), Q=9 (R3 Place), R=10 (R3 Pts), S=11 (R3 Kills)
    // T=12 (R4 Place), U=13 (R4 Pts), V=14 (R4 Kills)

    // 1. Find this slot's participating entry (match by slot code ONLY, never by rank)
    const registered = registeredTeams.find((t) => t.slotIndex === i)
    const entry = entries.find((e) => {
      if (!e.slotCode || e.slotCode === '??') return false
      const eCode = String(e.slotCode).toUpperCase().replace(/[\s\-]/g, '')
      const matchSlotCode = slotCode.replace(/[\s\-]/g, '').toUpperCase()
      const matchAltSlotCode = altSlotCode.toUpperCase()
      const matchSlotLetter = slotLetter.toUpperCase()
      return eCode === matchSlotCode || eCode === matchAltSlotCode || eCode === matchSlotLetter
    })

    // Does this row already hold a score from one of the OTHER three rounds?
    // A team that sat out this round but played an earlier one must keep its
    // name, or its existing scores are orphaned on an unlabelled row.
    const playedAnotherRound = Object.entries(ROUND_COLUMNS)
      .filter(([num]) => Number(num) !== roundNum)
      .some(([, cols]) => {
        const placeIdx = cols.place.charCodeAt(0) - 'H'.charCodeAt(0)
        const killsIdx = cols.kills.charCodeAt(0) - 'H'.charCodeAt(0)
        return [placeIdx, killsIdx].some((idx) => {
          const value = String(existingRowValues[idx] ?? '').trim()
          return value !== '' && value.toUpperCase() !== 'X' && Number.isFinite(Number(value))
        })
      })

    // 2. Write the team name in column J.
    // A registered team that has not played ANY round is left off the sheet
    // entirely — no name, no markers — so an absent team never looks like a
    // participant. The name appears the moment it actually plays.
    const showTeamName = Boolean(registered) && (Boolean(entry) || playedAnotherRound)
    if (showTeamName) {
      const officialTeamName = sanitizeSheetText(formatSheetTeamName(registered))
      updateData.push({
        range: `'${sheetName}'!${TEAM_COLUMN}${row}`,
        values: [[officialTeamName]],
      })
      writePlanTargets.push({ cell: `${TEAM_COLUMN}${row}`, role: 'team_name', value: officialTeamName })
    } else if (registeredTeams.length > 0) {
      // Unused slot, or a registered team that has played nothing yet. Clear any
      // name left over from a previous session. Skipped entirely when the board
      // is empty, so a bot restart cannot wipe the roster.
      updateData.push({
        range: `'${sheetName}'!${TEAM_COLUMN}${row}`,
        values: [['']],
      })
      writePlanTargets.push({ cell: `${TEAM_COLUMN}${row}`, role: 'team_name', value: '' })
    }

    // Repair the PLACEMENT POINTS formula for all four rounds, not just the one
    // being written. A single unplayed round left a #N/A that propagated into
    // TOTAL / FINAL SCORE / RANK, so the whole row had no rank at all.
    for (const cols of Object.values(ROUND_COLUMNS)) {
      const pointsFormula = placementPointsFormula(cols.place, row)
      updateData.push({
        range: `'${sheetName}'!${cols.placementPoints}${row}`,
        values: [[pointsFormula]],
      })
      writePlanTargets.push({
        cell: `${cols.placementPoints}${row}`,
        role: 'placementPoints',
        value: pointsFormula,
      })
    }

    if (entry && registered) {
      const parsedRank = Number(entry.rank)
      const placeVal =
        Number.isInteger(parsedRank) && parsedRank >= 1 && parsedRank <= totalSlots ? parsedRank : 'X'
      const killsVal = Math.max(0, Number(entry.kills || 0))

      updateData.push({
        range: `'${sheetName}'!${roundCols.place}${row}`,
        values: [[placeVal]],
      })
      updateData.push({
        range: `'${sheetName}'!${roundCols.kills}${row}`,
        values: [[killsVal]],
      })

      writePlanTargets.push({ cell: `${roundCols.place}${row}`, role: 'place', value: placeVal })
      writePlanTargets.push({ cell: `${roundCols.kills}${row}`, role: 'kills', value: killsVal })
      teamsTalliedCount++

      if (placeVal === 'X') {
        console.warn(`[TALLY] Slot ${slotCode} had an out-of-range placement (${entry.rank}); wrote 'X' instead.`)
      }
    } else {
      // Two different situations, and they are NOT marked the same way:
      //  - the slot is unused         -> 'X', the sheet's "no team here" marker
      //  - a registered team sat this round out -> blank, so an absent team is
      //    not shown as having taken part
      // Either way, never a score.
      // A team on the sheet that sat this round out gets blank cells. A row with
      // no team on it at all — unused slot, or a registered team that has played
      // nothing — gets the sheet's 'X' marker.
      const marker = showTeamName ? '' : 'X'
      if (registered) {
        registeredNotInScreenshot.push(`${slotCode} ${formatSheetTeamName(registered)}`)
      }

      updateData.push({
        range: `'${sheetName}'!${roundCols.place}${row}`,
        values: [[marker]],
      })
      updateData.push({
        range: `'${sheetName}'!${roundCols.kills}${row}`,
        values: [[marker]],
      })

      writePlanTargets.push({ cell: `${roundCols.place}${row}`, role: 'place', value: marker })
      writePlanTargets.push({ cell: `${roundCols.kills}${row}`, role: 'kills', value: marker })
      missingMarkersAddedCount++

      if (entry && !registered) {
        console.warn(`[TALLY] Marked slot ${slotCode} as 'X' because team "${entry.teamQuery}" is NOT registered in team slots.`)
      }
    }
  }

  // Create Audit Record
  const auditRecord = {
    auditId,
    submissionId,
    roundNumber: roundNum,
    actorUserId,
    status: 'pending',
    spreadsheetId,
    sheetName,
    writePlan: writePlanTargets,
    beforeSnapshot: currentCells,
    verificationResult: 'PENDING',
  }
  auditStore.set(auditId, auditRecord)

  // Execute Write Strategy via Google Sheets API v4
  const apiEndpoint = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`
  const apiResponse = await fetch(apiEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: updateData,
    }),
  })

  if (!apiResponse.ok) {
    const errText = await apiResponse.text()
    auditRecord.status = 'failed'
    auditRecord.verificationResult = 'FAILED'
    auditRecord.errorDetails = errText
    throw new Error(`Google Sheets API write failed (${apiResponse.status}): ${errText}`)
  }

  auditRecord.status = 'written'

  // 4. Ensure exactly one Rank 1, 2, 3 yellow highlight rule is active
  try {
    const { rulesReplaced } = await applyRankHighlight({ spreadsheetId, sheetName, accessToken })
    if (rulesReplaced > 0) {
      console.log(`[TALLY] Replaced ${rulesReplaced} stale rank highlight rule(s).`)
    }
  } catch (err) {
    console.warn('[TALLY] Could not apply rank highlight conditional formatting:', err.message)
  }

  // 5. Post-write re-read and exact verification. An HTTP 200 alone does not
  // prove that the requested cells contain the values we approved.
  try {
    const verifyResponse = await fetch(readUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!verifyResponse.ok) {
      const detail = await verifyResponse.text().catch(() => '')
      throw new Error(
        `Google Sheets verification read failed (${verifyResponse.status})${detail ? `: ${detail}` : '.'}`,
      )
    }
    const verifyData = await verifyResponse.json()
    auditRecord.afterSnapshot = verifyData.values || []

    const mismatches = writePlanTargets.flatMap((target) => {
      const match = /^([A-Z]+)(\d+)$/.exec(target.cell)
      if (!match) return [{ ...target, actual: '<invalid cell reference>' }]
      const columnNumber = [...match[1]].reduce(
        (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
        0,
      )
      const rowOffset = Number(match[2]) - startRow
      const columnOffset = columnNumber - 8 // H is column 8 and index zero here.
      const actual = auditRecord.afterSnapshot[rowOffset]?.[columnOffset] ?? ''
      return String(actual ?? '') === String(target.value ?? '')
        ? []
        : [{ ...target, actual }]
    })
    if (mismatches.length > 0) {
      const sample = mismatches.slice(0, 5)
        .map((item) => `${item.cell}: expected ${JSON.stringify(item.value)}, got ${JSON.stringify(item.actual)}`)
        .join('; ')
      throw new Error(
        `Google Sheets verification found ${mismatches.length} mismatched cells. ${sample}`,
      )
    }

    auditRecord.status = 'verified'
    auditRecord.verificationResult = 'PASSED'
  } catch (err) {
    auditRecord.status = 'verification_failed'
    auditRecord.verificationResult = 'FAILED'
    auditRecord.errorDetails = err.message
    throw new Error(`Google Sheets write could not be verified: ${err.message}`)
  }

  return {
    success: true,
    roundNumber: roundNum,
    worksheetName: sheetName,
    teamsTallied: teamsTalliedCount,
    missingMarkersAdded: missingMarkersAddedCount,
    registeredNotInScreenshot,
    unmatchedScreenshotEntries,
    formulaCellsChanged: 0,
    penaltyCellsChanged: 0,
    verificationStatus: 'PASSED',
    auditId,
  }
}

export async function fetchLiveStandingsFromSheet({
  spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID,
  sheetName = process.env.GOOGLE_SHEETS_WORKSHEET_NAME || '4 Rounds - 25 Teams (Do Not Edit)',
}) {
  // Use the same resolver as every other call so the service-account JSON file
  // works here too — the env-only lookup made this silently return null.
  const { email: clientEmail, privateKey } = resolveGoogleCredentials()

  if (!clientEmail || !privateKey) return null

  const accessToken = await getGoogleAccessToken(clientEmail, privateKey)
  // Read H8:AA32 (H=Slot, J=Team, Z=Final Score, AA=Final Rank)
  const range = `'${sheetName}'!H${SCORE_START_ROW}:${RANK_COLUMN}${SCORE_END_ROW}`
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!response.ok) return null

  const data = await response.json()
  const rows = data.values || []

  const standings = []
  rows.forEach((row, idx) => {
    // Relative cols: H=0, I=1, J=2, Z=18, AA=19
    const slotCode = row[0] || `${idx + 1}-${String.fromCharCode(65 + idx)}`
    const teamName = row[2] || ''
    const finalScore = Number(row[18] ?? NaN)
    const finalRank = Number(row[19] ?? NaN)

    if (teamName && !isNaN(finalScore) && !isNaN(finalRank)) {
      standings.push({
        slotCode,
        teamName,
        finalScore,
        finalRank,
        rowNumber: SCORE_START_ROW + idx,
      })
    }
  })

  // Sort by finalRank ascending, finalScore descending, rowNumber ascending
  standings.sort((a, b) => a.finalRank - b.finalRank || b.finalScore - a.finalScore || a.rowNumber - b.rowNumber)
  return standings
}

/**
 * Ranges wiped by /clear. Deliberately excludes the columns the sheet computes
 * for itself (X total earned, Z final score, AA rank) and the B8:C32 points
 * table, which are template, not scrim data.
 */
export function buildClearRanges(sheetName) {
  const first = SCORE_START_ROW
  const last = SCORE_END_ROW
  return [
    `'${sheetName}'!H3`, // device title written by the bot (blank in the template)
    // H4 and H5 are not blanked — they are reset to their placeholders below.
    `'${sheetName}'!${TEAM_COLUMN}${first}:${TEAM_COLUMN}${last}`, // team names
    `'${sheetName}'!K${first}:V${last}`, // all four rounds: place / points / kills
    `'${sheetName}'!Y${first}:Y${last}`, // total points deducted
    `'${sheetName}'!AD${first}:AG${last}`, // penalties table entries
  ]
}

/**
 * K8:V32 is cleared wholesale above, which also removes the PLACEMENT POINTS
 * VLOOKUPs in L/O/R/U. Put back the *template* formula, so a cleared sheet is
 * indistinguishable from the untouched default scoresheet — #N/A included.
 * The next tally swaps in placementPointsFormula(), which is what makes
 * TOTAL / FINAL SCORE / RANK compute again.
 */
export function buildTemplateRestore(sheetName) {
  // Put the header placeholders back instead of blanking them, so a cleared
  // sheet is byte-for-byte the default scoresheet again.
  const data = [
    {
      range: `'${sheetName}'!H4`,
      values: [[TITLE_BANNER_TEMPLATE]],
    },
    {
      range: `'${sheetName}'!H5`,
      values: [[DATE_HEADER_TEMPLATE]],
    },
  ]
  for (const { place, placementPoints } of Object.values(ROUND_COLUMNS)) {
    const values = []
    for (let row = SCORE_START_ROW; row <= SCORE_END_ROW; row++) {
      values.push([defaultPlacementPointsFormula(place, row)])
    }
    data.push({
      range: `'${sheetName}'!${placementPoints}${SCORE_START_ROW}:${placementPoints}${SCORE_END_ROW}`,
      values,
    })
  }
  return data
}

export async function clearGoogleSheetScores({
  spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID,
  sheetName = process.env.GOOGLE_SHEETS_WORKSHEET_NAME || '4 Rounds - 25 Teams (Do Not Edit)',
} = {}) {
  const { email: clientEmail, privateKey } = resolveGoogleCredentials()
  if (!clientEmail || !privateKey) {
    console.warn('[TALLY] Cannot clear Google Sheet: service account credentials are not available.')
    return { success: false, error: 'Google Sheets credentials are not configured.' }
  }

  try {
    const accessToken = await getGoogleAccessToken(clientEmail, privateKey)

    // 1. Clear team names, scores, penalties and the bot-written header lines.
    const batchClearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchClear`
    const response = await fetch(batchClearUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ranges: buildClearRanges(sheetName) }),
    })

    if (!response.ok) {
      const errText = await response.text()
      console.warn('[TALLY] Failed to clear Google Sheet:', errText)
      return { success: false, error: `Sheet clear failed (${response.status}): ${errText}` }
    }

    // 2. Restore the placement-points VLOOKUPs the clear just removed.
    const restoreResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: buildTemplateRestore(sheetName),
        }),
      },
    )

    if (!restoreResponse.ok) {
      const errText = await restoreResponse.text()
      console.warn('[TALLY] Cleared values but could not restore placement formulas:', errText)
      return { success: false, error: `Placement formula restore failed (${restoreResponse.status}): ${errText}` }
    }

    // 3. Remove the rank 1/2/3 highlight — and only that. The sheet's own
    //    conditional formatting (colour scales, 'x' marker styling) is kept.
    let rulesRemoved = 0
    try {
      ;({ rulesRemoved } = await removeRankHighlight({ spreadsheetId, sheetName, accessToken }))
    } catch (fmtErr) {
      console.warn('[TALLY] Could not remove rank highlight:', fmtErr.message)
    }

    console.log(
      `[TALLY] Cleared teams, header, scores, penalties and ${rulesRemoved} rank highlight rule(s) on '${sheetName}'`,
    )
    return { success: true, rulesRemoved, worksheetName: sheetName }
  } catch (err) {
    console.warn('[TALLY] Exception clearing Google Sheet:', err.message)
    return { success: false, error: err.message }
  }
}

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import { createHash } from 'node:crypto'
import { TallyBoard, TALLY_EMOJI, renderAlignedTable, getPlacementPoints } from './tally-core.js'
import { parseScreenshotWithGemini } from './tally-gemini.js'
import { parseTextScoreInput } from './tally-vision.js'
import { parseScreenshotLocally } from './tally-ocr.js'
import { syncScoresToGoogleSheet, fetchLiveStandingsFromSheet, clearGoogleSheetScores, formatSheetTeamName, getSpreadsheetUrl } from './tally-sheet.js'

const activeTallyBoards = new Map()
const pendingReviews = new Map()
const activeConfirmations = new Set()
const completedReviews = new Map()
const SUPPORTED_SCOREBOARD_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])
const DEFAULT_SCOREBOARD_DOWNLOAD_TIMEOUT_MS = 30_000
const DEFAULT_SCOREBOARD_MAX_BYTES = 15 * 1024 * 1024
const DEFAULT_SCOREBOARD_MAX_ATTACHMENTS = 6
const DEFAULT_SCOREBOARD_MAX_TOTAL_BYTES = 45 * 1024 * 1024

function normalizedAttachmentMime(value) {
  const mime = String(value ?? '').split(';', 1)[0].trim().toLowerCase()
  return mime === 'image/jpg' ? 'image/jpeg' : mime
}

function detectedImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null
  if (
    buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp'
  return null
}

export function isSupportedScoreboardAttachment(attachment = {}) {
  const mime = normalizedAttachmentMime(attachment.contentType)
  if (SUPPORTED_SCOREBOARD_MIME_TYPES.has(mime)) return true
  if (mime && !['application/octet-stream', 'binary/octet-stream'].includes(mime)) return false
  return /\.(?:png|jpe?g|webp)$/i.test(String(attachment.name ?? ''))
}

export async function downloadScoreboardAttachment(attachment, options = {}) {
  if (!isSupportedScoreboardAttachment(attachment)) {
    throw new Error('Score screenshots must be PNG, JPG, JPEG, or WEBP files.')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_SCOREBOARD_DOWNLOAD_TIMEOUT_MS)
  const maxBytes = Number(options.maxBytes ?? DEFAULT_SCOREBOARD_MAX_BYTES)
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Image download timeout must be positive.')
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('Image download byte limit must be positive.')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchImpl(attachment.url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`Failed to download attachment ${attachment.name ?? 'image'}: HTTP ${response.status}`)
    }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Score screenshot exceeds the ${maxBytes}-byte download limit.`)
    }

    const chunks = []
    let total = 0
    if (response.body?.getReader) {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        total += chunk.length
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new Error(`Score screenshot exceeds the ${maxBytes}-byte download limit.`)
        }
        chunks.push(chunk)
      }
    } else {
      const chunk = Buffer.from(await response.arrayBuffer())
      total = chunk.length
      if (total > maxBytes) throw new Error(`Score screenshot exceeds the ${maxBytes}-byte download limit.`)
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks, total)
    const mimeType = detectedImageMime(buffer)
    if (!mimeType) {
      throw new Error('Attachment bytes are not a supported PNG, JPEG, or WEBP image.')
    }
    return { buffer, mimeType }
  } catch (reason) {
    if (reason?.name === 'AbortError') {
      throw new Error(`Score screenshot download timed out after ${Math.round(timeoutMs / 1000)}s.`)
    }
    throw reason
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Every scrim scope registers itself here.
 *
 * Discord delivers a slash command once, and only the PC listener handles them
 * (they are registered once, globally). Without this registry those commands
 * always answered with PC's board, so /standings in the mobile channel showed
 * the PC scrim. The scope is now picked from the channel the command was run
 * in, falling back to PC.
 */
const scrimScopes = new Map()

function resolveScopeForChannel(channelId) {
  for (const scope of scrimScopes.values()) {
    const { scrimConfig } = scope
    const owns =
      Object.values(scrimConfig.channels || {}).includes(channelId) ||
      (scrimConfig.tallyChannelId && scrimConfig.tallyChannelId === channelId)
    if (owns) return scope
  }
  return scrimScopes.get('PC') || [...scrimScopes.values()][0] || null
}

const PENDING_REVIEW_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours — one scrim night

function clonedRoster(teams = []) {
  return Array.isArray(teams) ? teams.map((team) => ({ ...team })) : []
}

export function tallyRosterFingerprint(teams = []) {
  const normalized = clonedRoster(teams)
    .map((team) => ({
      slotIndex: Number.isInteger(Number(team.slotIndex)) ? Number(team.slotIndex) : null,
      slotCode: String(team.slotCode ?? '').trim().toUpperCase(),
      slotLetter: String(team.slotLetter ?? '').trim().toUpperCase(),
      tag: String(team.tag ?? '').trim(),
      name: String(team.name ?? '').trim(),
    }))
    .sort((left, right) => (
      (left.slotIndex ?? Number.MAX_SAFE_INTEGER) - (right.slotIndex ?? Number.MAX_SAFE_INTEGER)
      || left.slotCode.localeCompare(right.slotCode)
    ))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)
}

function createReviewId(registeredTeams, now = Date.now()) {
  return `rev_${now}_${Math.random().toString(36).slice(2, 7)}_${tallyRosterFingerprint(registeredTeams)}`
}

function tallyScopeToken(scrimLabel) {
  const label = String(scrimLabel ?? '').trim()
  if (/^[A-Za-z0-9_-]{1,16}$/.test(label)) return label
  return `s_${createHash('sha256').update(label).digest('hex').slice(0, 12)}`
}

function parseReviewId(reviewId) {
  const match = /^rev_(\d{10,})_[a-z0-9]+_([a-f0-9]{16})$/i.exec(String(reviewId ?? ''))
  if (!match) return null
  const createdAt = Number(match[1])
  return Number.isSafeInteger(createdAt)
    ? { createdAt, rosterFingerprint: match[2].toLowerCase() }
    : null
}

function reviewIsExpired(reviewId, reviewData, message, now = Date.now()) {
  const parsed = parseReviewId(reviewId)
  if (!parsed) return true
  const timestamps = [parsed.createdAt, reviewData?.createdAt, message?.createdTimestamp]
    .map(Number)
    .filter(Number.isFinite)
  return timestamps.some((timestamp) => (
    timestamp > now + 5 * 60 * 1000 || now - timestamp > PENDING_REVIEW_TTL_MS
  ))
}

function cleanupCompletedReviews(now = Date.now()) {
  for (const [reviewId, completedAt] of completedReviews) {
    if (now - completedAt > PENDING_REVIEW_TTL_MS) completedReviews.delete(reviewId)
  }
}

export function getOrCreateTallyBoard(scrimLabel, customPlacementPoints) {
  const key = String(scrimLabel || 'DEFAULT').toUpperCase()
  if (!activeTallyBoards.has(key)) {
    activeTallyBoards.set(key, new TallyBoard(customPlacementPoints))
  }
  return activeTallyBoards.get(key)
}

function rememberReview(reviewId, data) {
  // Drop reviews that were never confirmed or rejected, so the map cannot grow
  // without bound across scrim nights.
  const cutoff = Date.now() - PENDING_REVIEW_TTL_MS
  for (const [id, entry] of pendingReviews) {
    if ((entry.createdAt ?? 0) < cutoff) pendingReviews.delete(id)
  }
  cleanupCompletedReviews()
  pendingReviews.set(reviewId, { ...data, createdAt: Date.now() })
}

/**
 * Every scrim scope writes to the same spreadsheet, so resetting the sheet has
 * to reset every in-memory board too — otherwise the next /standings replays
 * scores that are no longer on the sheet.
 */
function clearAllTallyBoards() {
  for (const board of activeTallyBoards.values()) board.clear()
}

async function clearTallyAndSheet(scrimConfig = {}) {
  clearAllTallyBoards()
  return clearGoogleSheetScores(sheetTarget(scrimConfig))
}

/**
 * Which spreadsheet/worksheet this scrim scope reads and writes. Empty values
 * fall through to the module defaults, so PC keeps its existing target and
 * MOBILE only diverges once it is given one.
 */
function sheetTarget(scrimConfig = {}) {
  const target = {}
  if (scrimConfig.sheetSpreadsheetId) target.spreadsheetId = scrimConfig.sheetSpreadsheetId
  if (scrimConfig.sheetWorksheetName) target.sheetName = scrimConfig.sheetWorksheetName
  return target
}

// Rows that match no registered team are dropped silently in Discord. They are
// still reported on syncScoresToGoogleSheet's result and in the logs, so a
// misread can be traced without cluttering the scorekeeper's message.

export function formatClearReply(scrimLabel, result) {
  if (result?.success) {
    return `${TALLY_EMOJI.confirmed} Score tally board and Google Sheet reset to blank for **${scrimLabel} SCRIM**.`
  }
  return `⚠️ Tally board reset for **${scrimLabel} SCRIM**, but the Google Sheet could not be cleared: ${result?.error || 'unknown error'}`
}

/**
 * Which reader parses screenshots.
 *
 * NIGHTRAID-style score-only Gemini is primary whenever a key is configured:
 * original plus enhanced evidence, strict local validation, two-crop recovery,
 * and conflict-safe overlap merging. The exact local glyph reader remains the
 * no-key and provider-failure fallback.
 */
function resolveVisionProvider(globalConfig) {
  const configured = String(process.env.TALLY_VISION_PROVIDER || 'gemini').toLowerCase()
  const apiKey = globalConfig?.geminiApiKey || process.env.GEMINI_API_KEY
  if (configured === 'gemini' && apiKey) return 'gemini'
  if (configured === 'gemini') {
    console.warn('[TALLY] TALLY_VISION_PROVIDER=gemini but no API key configured; reading locally.')
  }
  return 'local'
}

/**
 * Keep provider selection and fallback testable outside Discord. A cloud read
 * that accepts zero rows is a failed read, not a successful empty round.
 */
export async function readScoreboardScreenshots({
  provider,
  images,
  apiKey,
  maxSlots,
  allowedLetters,
  cloudReader = parseScreenshotWithGemini,
  localReader = parseScreenshotLocally,
}) {
  const localOptions = {
    images,
    maxSlots,
    ...(allowedLetters?.length ? { allowedLetters } : {}),
  }
  const callCloud = async () => {
    const parsed = await cloudReader({
      images,
      apiKey,
      maxSlots,
      allowedLetters: localOptions.allowedLetters,
    })
    if (!Array.isArray(parsed?.entries) || parsed.entries.length === 0) {
      throw new Error('Cloud vision did not accept any scoreboard rows.')
    }
    return { source: 'gemini', ...parsed }
  }
  const callLocal = async () => localReader(localOptions)
  const markProviderFallback = (parsed, failedProvider, reason) => ({
    ...parsed,
    providerFallback: {
      failedProvider,
      reason: String(reason?.message ?? reason ?? 'unknown provider failure'),
    },
    uncertain: [
      ...(parsed?.uncertain ?? []),
      {
        rank: null,
        slotLetter: null,
        kills: null,
        reason: 'provider_fallback_used',
        failedProvider,
        error: String(reason?.message ?? reason ?? 'unknown provider failure'),
      },
    ],
  })

  if (provider === 'gemini') {
    try {
      return await callCloud()
    } catch (visionError) {
      console.warn(`[TALLY] Cloud vision failed, reading locally: ${visionError.message}`)
      try {
        return markProviderFallback(await callLocal(), 'gemini', visionError)
      } catch (localError) {
        throw new Error(
          `Cloud vision failed: ${visionError.message}\n\nLocal fallback also failed: ${localError.message}`,
        )
      }
    }
  }

  try {
    return await callLocal()
  } catch (localError) {
    console.warn(`[TALLY] Local reader failed, trying cloud vision: ${localError.message}`)
    try {
      return markProviderFallback(await callCloud(), 'local', localError)
    } catch (visionError) {
      throw new Error(
        `${localError.message}\n\nCloud vision fallback also failed: ${visionError.message}`,
      )
    }
  }
}

function canManageTally(member, allowedRoleIds = new Set()) {
  if (!member) return false
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true
  if (member.permissions?.has(PermissionFlagsBits.ManageMessages)) return true

  const memberRoles = member.roles?.cache?.keys ? [...member.roles.cache.keys()] : []
  return memberRoles.some((roleId) => allowedRoleIds.has(String(roleId)))
}

/**
 * One round's result table, in that round's own placement order.
 *
 * Shared by the review and the confirmation so the table cannot drift between
 * them — confirming a round shows exactly what was approved, rather than
 * re-sorting into cumulative standings.
 */
export function buildRoundScoreTable(entries = []) {
  // The slot code identifies the team, and the sheet carries the names, so the
  // TEAM column is left out here.
  return renderAlignedTable(
    [
      { key: 'rk', label: 'PLACE', align: 'center' },
      { key: 'slot', label: 'SLOT', align: 'center' },
      { key: 'kills', label: 'KILLS', align: 'center' },
      { key: 'pts', label: 'PTS', align: 'center' },
    ],
    entries.map((e, idx) => {
      const rank = e.rank || idx + 1
      const kills = Number(e.kills) || 0
      // totalPoints is only present once setRound has resolved the row. Work it
      // out here too, so a table built straight from parsed entries still shows
      // real points rather than 0.
      const points = Number.isFinite(Number(e.totalPoints))
        ? Number(e.totalPoints)
        : getPlacementPoints(rank) + kills
      return { rk: rank, slot: e.slotCode || '??', kills, pts: points }
    }),
  )
}

/**
 * Rebuild a round's entries from a review message that is already on screen.
 *
 * pendingReviews lives in memory, so a restart — a redeploy, or the host
 * spinning the instance down between the screenshot and the Confirm press —
 * used to lose the round entirely. The table in the message holds everything
 * needed, so it is parsed back rather than making the scorekeeper redo it.
 */
export function parseRoundTableFromMessage(content) {
  const rawLines = String(content || '').split('\n')
  const cleanLine = (raw) => raw.trim().replace(/^`+/, '').replace(/`+$/, '').trim()
  const headerIndex = rawLines.findIndex((raw) => {
    const line = cleanLine(raw)
    return /^(?:RK|RANK|PLACE)\s+SLOT\s+(?:TEAM\s+)?KILLS\s+PTS$/i.test(line)
  })
  if (headerIndex === -1) return []

  const entries = []
  // Only read the contiguous inline-code table immediately below its exact
  // header. Notice/error prose before or after the table is untrusted and must
  // never become restart-recovered score data.
  for (const raw of rawLines.slice(headerIndex + 1)) {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('`') || !trimmed.endsWith('`')) break
    const line = cleanLine(raw)
    // Skip the header, whatever it was called when the message was posted.
    if (!line || /^(RK|RANK|PLACE)\b/.test(line) || /^[─-]+$/.test(line)) continue

    // "<place> <slot> [team name…] <kills> <pts>". The TEAM column was dropped,
    // but older messages still carry it — and a team name contains spaces — so
    // read the ends of the row and ignore whatever sits between them.
    const tokens = line.split(/\s+/)
    if (tokens.length < 4) continue

    const rank = Number(tokens[0])
    let slotCode = tokens[1]
    if (/^150$/i.test(slotCode)) slotCode = '15O'
    const kills = Number(tokens[tokens.length - 2])
    const points = Number(tokens[tokens.length - 1])

    if (!Number.isInteger(rank) || rank < 1 || rank > 25) continue
    const slotMatch = /^(\d{1,2})([A-Z])$/i.exec(slotCode)
    if (!slotMatch || Number(slotMatch[1]) !== slotMatch[2].toUpperCase().charCodeAt(0) - 64) continue
    if (!Number.isInteger(kills) || kills < 0 || kills > 999) continue
    if (!Number.isInteger(points) || points !== getPlacementPoints(rank) + kills) continue

    entries.push({ rank, slotCode, teamQuery: slotCode, kills })
  }
  return entries
}

export function buildReviewMessage({
  roundNumber,
  entries,
  registeredTeams,
  reviewId,
  scrimLabel = 'PC',
  notice = '',
  blocked = false,
}) {
  const scopeToken = tallyScopeToken(scrimLabel)
  const lines = [
    `📋 **${scrimLabel.toUpperCase()} SCRIM SCORE TALLY REVIEW — ROUND ${roundNumber}**`,
    `*Please verify extracted team ranks and kills before confirming.*`,
    // Only set when the round was read by a degraded reader, so the scorekeeper
    // knows this draft needs more than a glance.
    ...(notice ? [notice] : []),
    buildRoundScoreTable(entries),
  ]

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`phgg_tally:confirm:${scopeToken}:${roundNumber}:${reviewId}`)
      .setLabel('Confirm & Save Scores')
      .setStyle(ButtonStyle.Success)
      .setDisabled(blocked),
    new ButtonBuilder()
      .setCustomId(`phgg_tally:input:${scopeToken}:${roundNumber}:${reviewId}`)
      .setLabel('Input / Fix Scores')
      .setStyle(ButtonStyle.Primary),
    // Link buttons open the scoresheet directly; they carry a URL instead of a
    // custom id and so never round-trip to the bot.
    new ButtonBuilder()
      .setLabel('View Standings')
      .setStyle(ButtonStyle.Link)
      .setURL(getSpreadsheetUrl()),
    new ButtonBuilder()
      .setCustomId(`phgg_tally:reject:${scopeToken}:${roundNumber}:${reviewId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  )

  return { content: lines.join('\n'), components: [row] }
}

export function isBlockedTallyReview(reviewData, renderedContent = '') {
  return Boolean(
    reviewData?.blocked
    || /AUTOMATIC SAVE BLOCKED/i.test(String(renderedContent ?? '')),
  )
}

export function installTallyAutomation(
  client,
  scrimConfig,
  globalConfig,
  getScrimBoard,
  dependencies = {},
) {
  const tallyBoard = getOrCreateTallyBoard(scrimConfig.label, scrimConfig.placementPoints)
  const attachmentDownloader = dependencies.downloadScoreboardAttachment
    ?? downloadScoreboardAttachment
  const scoreboardReader = dependencies.readScoreboardScreenshots
    ?? readScoreboardScreenshots
  const sheetSync = dependencies.syncScoresToGoogleSheet
    ?? syncScoresToGoogleSheet
  const tallyChannelId = scrimConfig.tallyChannelId || scrimConfig.channels?.tally || globalConfig?.tallyChannelId
  const allowedRoleIds = new Set([
    ...(scrimConfig.scorekeeperRoleIds || []),
    ...(globalConfig.scorekeeperRoleIds || []),
  ])

  // Register this scope so the globally-registered slash commands can answer
  // for whichever scrim's channel they were invoked in.
  scrimScopes.set(scrimConfig.label.toUpperCase(), { scrimConfig, tallyBoard, getScrimBoard })

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return
    const content = (message.content || '').trim()
    const upperContent = content.toUpperCase()
    const currentLabel = scrimConfig.label.toUpperCase()

    // 1. Text Scope Check: "ROUND 1 PC", "!tally PC", "ROUND 1 MOBILE"
    const specifiesPC = /\bPC\b/.test(upperContent)
    const specifiesMobile = /\bMOBILE\b/.test(upperContent)
    if (specifiesPC && currentLabel !== 'PC') return
    if (specifiesMobile && currentLabel !== 'MOBILE') return

    // 2. Exclusive Channel Scope Check
    const isThisScrimChannel = Object.values(scrimConfig.channels || {}).includes(message.channel.id) ||
      (scrimConfig.tallyChannelId && message.channel.id === scrimConfig.tallyChannelId)

    const allScrims = globalConfig.scrims || []
    const isOtherScrimExclusiveChannel = allScrims.some((other) => {
      if (other.label.toUpperCase() === currentLabel) return false
      return Object.values(other.channels || {}).includes(message.channel.id) ||
        (other.tallyChannelId && message.channel.id === other.tallyChannelId)
    })

    if (isOtherScrimExclusiveChannel && !isThisScrimChannel) return

    // 3. Shared Tally Channel: if user didn't specify PC or MOBILE in text,
    //    and this channel is NOT exclusive to this scrim, only let PC handle it
    //    (PC is the default scrim scope for shared tally channels).
    if (!specifiesPC && !specifiesMobile && !isThisScrimChannel) {
      // In a shared channel, only the PC listener processes by default
      if (currentLabel !== 'PC') return
    }

    if (message._tallyProcessing) return
    message._tallyProcessing = true

    const hasRoundKeyword = /\b(?:ROUND|R)\s*#?(\d+)\b/i.test(content) || content.toLowerCase().startsWith('!tally') || content.toLowerCase().startsWith('!score')
    const isTallyChannel = Boolean(
      (tallyChannelId && message.channel.id === tallyChannelId) ||
      (globalConfig?.tallyChannelId && message.channel.id === globalConfig.tallyChannelId) ||
      Object.values(scrimConfig.channels || {}).includes(message.channel.id) ||
      (hasRoundKeyword && message.attachments.size > 0)
    )
    const isScrimChannel = isTallyChannel || Object.values(scrimConfig.channels || {}).includes(message.channel.id)

    // Handle Commands: !standings, !refreshteams, !cleartally, !correctscore
    if (content.toLowerCase().startsWith('!standings')) {
      const parts = content.split(/\s+/)
      const targetScope = parts[1]?.toUpperCase()
      if (targetScope && targetScope !== scrimConfig.label.toUpperCase()) return
      if (!targetScope && !isScrimChannel) return

      const registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []
      const standingsOutput = tallyBoard.formatStandingsMarkdown(
        registeredTeams,
        `${globalConfig.brandName} ${scrimConfig.label} SCRIM STANDINGS`,
      )
      await message.reply({ content: standingsOutput }).catch(() => {})
      return
    }

    if (content.toLowerCase().startsWith('!refreshteams')) {
      const parts = content.split(/\s+/)
      const targetScope = parts[1]?.toUpperCase()
      if (targetScope && targetScope !== scrimConfig.label.toUpperCase()) return
      if (!targetScope && !isScrimChannel) return

      const registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []
      const teamListStr = registeredTeams.length > 0
        ? registeredTeams.map((t) => `${t.slotCode}: ${t.tag ? `[${t.tag}] ` : ''}${t.name}`).join('\n')
        : '*No teams registered on the board yet.*'

      await message.reply(`🔄 **${scrimConfig.label} SCRIM REGISTERED TEAMS REFRESHED** (${registeredTeams.length} Teams):\n\`\`\`\n${teamListStr}\n\`\`\``).catch(() => {})
      return
    }

    const isClearCmd = content.toLowerCase().startsWith('!cleartally') ||
      content.toLowerCase().startsWith('!clearsheet') ||
      content.toLowerCase().startsWith('!clear') ||
      content.toLowerCase().startsWith('/clear') ||
      content.toLowerCase().startsWith('/clearsheet')

    if (isClearCmd) {
      const parts = content.split(/\s+/)
      const targetScope = parts[1]?.toUpperCase()
      if (targetScope && targetScope !== scrimConfig.label.toUpperCase()) return
      if (!targetScope && !isScrimChannel) return

      if (!canManageTally(message.member, allowedRoleIds)) {
        await message.reply('❌ You do not have permission to clear score tallies.').catch(() => {})
        return
      }
      const clearResult = await clearTallyAndSheet(scrimConfig)
      await message.reply(formatClearReply(scrimConfig.label, clearResult)).catch(() => {})
      return
    }

    if (content.toLowerCase().startsWith('!correctscore')) {
      if (!canManageTally(message.member, allowedRoleIds)) {
        await message.reply('❌ You do not have permission to correct scores.').catch(() => {})
        return
      }
      const match = /^!correctscore\s+(\d+)\s+(.+?)\s+(\d+)\s+(\d+)$/i.exec(content)
      if (!match) {
        await message.reply('❌ **Format**: `!correctscore <roundNumber> <teamTagOrSlot> <placement> <kills>`\nExample: `!correctscore 1 NR 1 12`').catch(() => {})
        return
      }

      const [, roundNumStr, teamQuery, placementStr, killsStr] = match
      const roundNum = Number(roundNumStr)
      const registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []
      const updated = tallyBoard.correctScore(
        roundNum,
        teamQuery,
        Number(placementStr),
        Number(killsStr),
        registeredTeams,
      )

      // Sync pendingReviews entries if a review is active
      for (const reviewData of pendingReviews.values()) {
        if (reviewData.roundNumber === roundNum && reviewData.scrimLabel === scrimConfig.label) {
          const idx = reviewData.entries.findIndex((e) => e.slotCode === updated.slotCode || e.tag === updated.tag)
          if (idx !== -1) {
            reviewData.entries[idx] = updated
          } else {
            reviewData.entries.push(updated)
          }
        }
      }

      await message.reply(
        `✅ Updated Round ${roundNumStr} score for **${updated.tag} ${updated.name}** (Slot ${updated.slotCode}): Rank #${updated.rank}, ${updated.kills} Kills (${updated.totalPoints} PTS)`,
      ).catch(() => {})
      return
    }

    // Process Screenshot or Text score in tally channel
    if (isTallyChannel) {
      // Detect round number from user message text (e.g. "ROUND 2", "R3", "ROUND4")
      const roundOverrideMatch = content.match(/\b(?:ROUND|R)\s*#?(\d+)\b/i)
      const userSpecifiedRound = roundOverrideMatch ? Number(roundOverrideMatch[1]) : null

      // Auto-detect next round: find the next unfilled round (1-4)
      function getNextRound() {
        if (userSpecifiedRound && userSpecifiedRound >= 1 && userSpecifiedRound <= 4) {
          return userSpecifiedRound
        }
        for (let r = 1; r <= 4; r++) {
          if (tallyBoard.getRound(r).length === 0) return r
        }
        // All 4 rounds filled, default to 1 (overwrite)
        return 1
      }

      const allAttachments = [...message.attachments.values()]
      const looksLikeTextScore = content.toLowerCase().startsWith('round') || /^#?\d+[.\s\-]/m.test(content)
      if (
        (allAttachments.length > 0 || looksLikeTextScore)
        && !canManageTally(message.member, allowedRoleIds)
      ) {
        await message.reply('❌ You do not have permission to submit tally scores.').catch(() => {})
        return
      }
      if (
        roundOverrideMatch
        && (!Number.isInteger(userSpecifiedRound) || userSpecifiedRound < 1 || userSpecifiedRound > 4)
      ) {
        await message.reply('❌ Round must be 1, 2, 3, or 4. Nothing was read or saved.').catch(() => {})
        return
      }
      const imageAttachments = allAttachments.filter(isSupportedScoreboardAttachment)

      if (allAttachments.length > imageAttachments.length) {
        await message.reply(
          '❌ Every tally attachment must be a PNG, JPG, JPEG, or WEBP screenshot. GIF, BMP, documents, and unknown attachments are not processed.',
        ).catch(() => {})
        return
      }
      if (imageAttachments.length > DEFAULT_SCOREBOARD_MAX_ATTACHMENTS) {
        await message.reply(
          `❌ Upload at most ${DEFAULT_SCOREBOARD_MAX_ATTACHMENTS} scoreboard screenshots in one tally submission.`,
        ).catch(() => {})
        return
      }

      if (imageAttachments.length > 0) {
        // Reading a screenshot takes several seconds. Acknowledge immediately —
        // the typing indicator fires right away and the placeholder is edited
        // into the review, so there is never a silent gap and no extra message.
        message.channel.sendTyping().catch(() => {})
        const workingMessage = await message
          .reply(`⏳ **Reading ${imageAttachments.length > 1 ? `${imageAttachments.length} screenshots` : 'screenshot'}...**`)
          .catch(() => null)
        const respond = (payload) =>
          workingMessage
            ? workingMessage.edit(payload).catch(() => {})
            : message.reply(payload).catch(() => {})

        try {
          const provider = resolveVisionProvider(globalConfig)
          const startedAt = Date.now()
          console.log(`[TALLY] Processing ${imageAttachments.length} attached images for ${scrimConfig.label} scrim...`)

          const downloadedImages = []
          let totalDownloadedBytes = 0
          for (const attachment of imageAttachments) {
            const remainingBytes = DEFAULT_SCOREBOARD_MAX_TOTAL_BYTES - totalDownloadedBytes
            if (remainingBytes <= 0) {
              throw new Error('Combined scoreboard screenshots exceed the 45 MiB submission limit.')
            }
            const downloaded = await attachmentDownloader(attachment, {
              maxBytes: Math.min(DEFAULT_SCOREBOARD_MAX_BYTES, remainingBytes),
            })
            totalDownloadedBytes += downloaded.buffer.length
            downloadedImages.push(downloaded)
          }
          console.log(`[TALLY] Downloaded ${downloadedImages.length} image(s) in ${Date.now() - startedAt}ms`)

          let parsed
          let degradedNotice = ''
          let reviewBlocked = false
          // Recognition still considers A..Y. The registered letters are a
          // post-read validation boundary, never a way to force classification.
          // Keep this exact roster snapshot through extraction, preview, and
          // confirmation. Re-fetching after a slow model call can otherwise
          // drop a correctly read slot or silently resolve it to a new team.
          const registeredTeams = clonedRoster(
            getScrimBoard ? getScrimBoard().getRegisteredTeams() : [],
          )
          const rosterFingerprint = tallyRosterFingerprint(registeredTeams)
          const allowedLetters = registeredTeams
            .map((team) => team.slotLetter)
            .filter(Boolean)
          parsed = await scoreboardReader({
            provider,
            images: downloadedImages,
            apiKey: globalConfig?.geminiApiKey || process.env.GEMINI_API_KEY,
            // Mobile scrims run 20 slots (A..T), PC 25 (A..Y). Past that the
            // letters and placings are impossible, not merely unlikely.
            maxSlots: Number(scrimConfig.maxSlots) || undefined,
            allowedLetters,
          })

          const usedProvider = parsed.source || provider
          if (usedProvider === 'ocr') {
            reviewBlocked = true
            degradedNotice =
              '⛔ **AUTOMATIC SAVE BLOCKED** — fallback OCR is not strong enough for an automatic write. Check the screenshot and submit the complete round as text.'
          } else {
            const warnings = []
            if (parsed.uncertain?.length) {
              const coverageWarnings = parsed.uncertain.filter(
                (item) => item.reason === 'leaderboard_end_not_visible',
              )
              const fallbackWarnings = parsed.uncertain.filter(
                (item) => item.reason === 'provider_fallback_used',
              )
              const rowWarnings = parsed.uncertain.filter(
                (item) => ![
                  'leaderboard_end_not_visible',
                  'provider_fallback_used',
                ].includes(item.reason),
              )
              if (rowWarnings.length) {
                const ranks = rowWarnings.map((u) => `#${u.rank ?? '?'}`).join(', ')
                warnings.push(
                  `⚠️ **${rowWarnings.length} row(s) could not be read confidently** (${ranks}) and were left out. Add them manually before confirming.`,
                )
              }
              if (coverageWarnings.length) {
                warnings.push(
                  '⚠️ **The uploaded screenshots do not prove the final leaderboard row is visible.** Include the bottom of the leaderboard so a clean top-only crop cannot be mistaken for the whole round.',
                )
              }
              if (fallbackWarnings.length) {
                warnings.push(
                  '⚠️ **The configured primary reader failed and a fallback reader produced this table.** The result is shown for comparison, but automatic save stays blocked so a provider failure cannot hide conflicting visual evidence.',
                )
              }
              // A pasted screenshot arrives at whatever size it was displayed
              // at, not its original resolution, and the lost pixels are the
              // glyph detail the reader needs. Losing a quarter of the rows is
              // the signature of that, and it costs nothing to fix.
              const detected = parsed.entries.length + rowWarnings.length
              if (detected > 0 && rowWarnings.length / detected > 0.25) {
                warnings.push(
                  '💡 That many unread rows usually means the screenshot was **pasted** rather than attached. ' +
                    'Copying an image sends it at the size it was displayed, not its full resolution. ' +
                    'Send it again with the **+** button and pick the file — every row should read.',
                )
              }
            }
            const recovered = parsed.entries?.filter((e) => e.recovered) || []
            if (recovered.length) {
              const which = recovered.map((e) => `#${e.rank}`).join(', ')
              warnings.push(
                `ℹ️ **${which}** required two enlarged row reads. Both separately processed crop variants agreed exactly.`,
              )
            }
            // A hole in the placements means a row never made it in at all.
            // Empty slots with no registered team do not count as missing ranks.
            if (parsed.missingRanks?.length && registeredTeams.length > 0) {
              const registeredLetters = new Set(registeredTeams.map((t) => t.slotLetter).filter(Boolean))
              const extractedLetters = new Set((parsed.entries || []).map((e) => (e.slotCode ? e.slotCode.slice(-1) : e.teamQuery)))
              const missingRegisteredLetters = [...registeredLetters].filter((l) => !extractedLetters.has(l))
              if (missingRegisteredLetters.length === 0) {
                parsed.missingRanks = []
              }
            }
            if (parsed.missingRanks?.length) {
              const ranks = parsed.missingRanks.map((r) => `#${r}`).join(', ')
              warnings.push(
                `⚠️ **No row found for ${ranks}.** Post the screenshot covering those placements, or add them manually.`,
              )
            }
            reviewBlocked = Boolean(
              parsed.uncertain?.length
              || parsed.missingRanks?.length
              || parsed.conflicts?.length,
            )
            if (reviewBlocked) {
              warnings.unshift(
                '⛔ **AUTOMATIC SAVE BLOCKED** — at least one required row is unreadable, missing, or conflicts with another screenshot. Re-upload clearer coverage or submit the complete round as text.',
              )
            }
            degradedNotice = warnings.join('\n')
          }

          console.log(
            `[TALLY] ${usedProvider.toUpperCase()} parse finished ${Date.now() - startedAt}ms after the screenshot arrived (${parsed.entries.length} rows)`,
          )

          // Use user-specified round, auto-detected next round, or Gemini's parsed round
          const effectiveRound = userSpecifiedRound
            ? userSpecifiedRound
            : (parsed.roundNumber && parsed.roundNumber !== 1 ? parsed.roundNumber : getNextRound())
          if (!Number.isInteger(effectiveRound) || effectiveRound < 1 || effectiveRound > 4) {
            throw new Error(`Round ${effectiveRound} is invalid. Supported rounds are 1, 2, 3, or 4.`)
          }

          console.log(`[TALLY] Screenshot parsed: ${usedProvider} returned ${parsed.entries.length} teams. Round: ${effectiveRound}`)

          const previewEntries = tallyBoard.previewRound(
            effectiveRound,
            parsed.entries,
            registeredTeams,
            message.id,
          )
          if (previewEntries.length !== parsed.entries.length) {
            reviewBlocked = true
            const rosterWarning =
              '⚠️ **At least one extracted slot did not resolve against the reviewed roster snapshot.** ' +
              'Refresh the slot board and re-upload the complete round.'
            const blockedWarning =
              '⛔ **AUTOMATIC SAVE BLOCKED** — the extraction cannot be mapped one-to-one to the reviewed roster.'
            degradedNotice = [
              ...(degradedNotice.includes('AUTOMATIC SAVE BLOCKED') ? [] : [blockedWarning]),
              rosterWarning,
              degradedNotice,
            ].filter(Boolean).join('\n')
          }

          const reviewId = createReviewId(registeredTeams)
          rememberReview(reviewId, {
            roundNumber: effectiveRound,
            entries: previewEntries,
            scrimLabel: scrimConfig.label,
            blocked: reviewBlocked,
            rosterFingerprint,
          })

          const reviewMsg = buildReviewMessage({
            roundNumber: effectiveRound,
            entries: previewEntries,
            registeredTeams,
            reviewId,
            scrimLabel: scrimConfig.label,
            notice: degradedNotice,
            blocked: reviewBlocked,
          })

          await respond(reviewMsg)
        } catch (err) {
          console.error('[TALLY] Failed to parse screenshot:', err)
          await respond(`❌ **Tally Error**: ${err.message}`)
        }
        return
      }

      // Check text score input
      if (content.toLowerCase().startsWith('round') || /^#?\d+[.\s\-]/m.test(content)) {
        const parsed = parseTextScoreInput(content)
        if (parsed.entries.length > 0) {
          // Use explicit round from text, or auto-detect
          const effectiveRound = parsed.roundNumber !== 1
            ? parsed.roundNumber
            : getNextRound()

          const registeredTeams = clonedRoster(
            getScrimBoard ? getScrimBoard().getRegisteredTeams() : [],
          )
          const rosterFingerprint = tallyRosterFingerprint(registeredTeams)
          const previewEntries = tallyBoard.previewRound(
            effectiveRound,
            parsed.entries,
            registeredTeams,
            message.id,
          )
          const reviewBlocked = previewEntries.length !== parsed.entries.length

          const reviewId = createReviewId(registeredTeams)
          rememberReview(reviewId, {
            roundNumber: effectiveRound,
            entries: previewEntries,
            scrimLabel: scrimConfig.label,
            blocked: reviewBlocked,
            rosterFingerprint,
          })

          const reviewMsg = buildReviewMessage({
            roundNumber: effectiveRound,
            entries: previewEntries,
            registeredTeams,
            reviewId,
            scrimLabel: scrimConfig.label,
            notice: reviewBlocked
              ? '⛔ **AUTOMATIC SAVE BLOCKED** — at least one pasted score row does not match the reviewed roster snapshot.'
              : '',
            blocked: reviewBlocked,
          })

          await message.reply(reviewMsg).catch(() => {})
        }
      }
    }
  })

  // Register Discord Native Slash Commands (/clear, /clearsheet, /standings, /refreshteams)
  const slashDefinitions = [
    { name: 'clear', description: 'Clear score tally board and reset Google Sheet to blank.' },
    { name: 'clearsheet', description: 'Clear score tally board and reset Google Sheet to blank.' },
    { name: 'standings', description: 'View current overall scrim standings.' },
    { name: 'refreshteams', description: 'Refresh and view registered teams on the scrim board.' },
  ]

  client.once(Events.ClientReady, async (readyClient) => {
    if (globalConfig?.guildId && scrimConfig.label.toUpperCase() === 'PC') {
      try {
        const guild = await readyClient.guilds.fetch(globalConfig.guildId)
        const commands = await guild.commands.fetch()
        for (const def of slashDefinitions) {
          const existing = commands.find((c) => c.name === def.name)
          if (existing) await existing.edit(def)
          else await guild.commands.create(def)
        }
        console.log(`[TALLY] Slash commands (/clear, /clearsheet, /standings, /refreshteams) registered in ${guild.name}.`)
      } catch (err) {
        console.error('[TALLY] Could not register slash commands:', err.message)
      }
    }
  })

  // Handle Discord Button & Slash Command Interactions
  client.on(Events.InteractionCreate, async (interaction) => {
    // Only the PC listener handles slash commands (they are registered once by PC)
    if (interaction.isChatInputCommand() && scrimConfig.label.toUpperCase() === 'PC') {
      const cmdName = interaction.commandName

      // Answer for the scrim whose channel the command was run in, so the
      // mobile channel reports the mobile scrim rather than always PC.
      const scope = resolveScopeForChannel(interaction.channelId) || {
        scrimConfig,
        tallyBoard,
        getScrimBoard,
      }
      const scopeLabel = scope.scrimConfig.label.toUpperCase()
      const scopeTeams = () => (scope.getScrimBoard ? scope.getScrimBoard().getRegisteredTeams() : [])

      if (cmdName === 'clear' || cmdName === 'clearsheet') {
        if (!canManageTally(interaction.member, allowedRoleIds)) {
          await interaction.reply({ content: '❌ You do not have permission to clear score tallies.', flags: MessageFlags.Ephemeral }).catch(() => {})
          return
        }
        await interaction.deferReply().catch(() => {})
        const clearResult = await clearTallyAndSheet(scope.scrimConfig)
        await interaction.editReply(formatClearReply(scopeLabel, clearResult)).catch(() => {})
        return
      }
      if (cmdName === 'standings') {
        const standingsText = scope.tallyBoard.formatStandingsMarkdown(
          scopeTeams(),
          `${globalConfig.brandName} ${scopeLabel} SCRIM STANDINGS`,
        )
        await interaction.reply({ content: standingsText }).catch(() => {})
        return
      }
      if (cmdName === 'refreshteams') {
        const registeredTeams = scopeTeams()
        const teamListStr = registeredTeams.length > 0
          ? registeredTeams.map((t) => `${t.slotCode}: ${t.tag ? `[${t.tag}] ` : ''}${t.name}`).join('\n')
          : '*No teams registered on the board yet.*'
        await interaction.reply({ content: `🔄 **${scopeLabel} SCRIM REGISTERED TEAMS REFRESHED** (${registeredTeams.length} Teams):\n\`\`\`\n${teamListStr}\n\`\`\`` }).catch(() => {})
        return
      }
    }

    const isBtn = typeof interaction.isButton === 'function' && interaction.isButton()
    const isModal = typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit()
    if (!isBtn && !isModal) return
    const customId = String(interaction.customId || '')

    if (!customId.startsWith('phgg_tally:') && !customId.startsWith('phgg_tally_modal:')) return

    const parts = customId.split(':')
    const [, action, targetLabel, roundStr, reviewId] = parts
    if (
      targetLabel
      && ![
        scrimConfig.label.toUpperCase(),
        tallyScopeToken(scrimConfig.label).toUpperCase(),
      ].includes(targetLabel.toUpperCase())
    ) return

    // Log every button/modal this scope accepts.
    console.log(
      `[TALLY] ${scrimConfig.label} ${interaction.type} "${action}" round=${roundStr} review=${reviewId} by ${interaction.user?.id}`,
    )

    // Reading the slot board must never take the interaction down with it
    let registeredTeams = []
    try {
      registeredTeams = clonedRoster(
        getScrimBoard ? getScrimBoard().getRegisteredTeams() : [],
      )
    } catch (boardErr) {
      console.error('[TALLY] Could not read the slot board:', boardErr.message)
      await interaction
        .reply({
          content: `⚠️ Could not read the ${scrimConfig.label} slot board: ${boardErr.message}`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {})
      return
    }

    if (action === 'standings') {
      const standingsText = tallyBoard.formatStandingsMarkdown(
        registeredTeams,
        `${globalConfig.brandName} ${scrimConfig.label} SCRIM STANDINGS`,
      )
      await interaction.reply({ content: standingsText, flags: MessageFlags.Ephemeral }).catch(() => {})
      return
    }

    if (!canManageTally(interaction.member, allowedRoleIds)) {
      await interaction.reply({ content: '❌ You do not have permission to modify tally scores.', flags: MessageFlags.Ephemeral }).catch(() => {})
      return
    }

    if (action === 'input' && isBtn) {
      if (
        /SCORES CONFIRMED/i.test(interaction.message?.content || '')
        || completedReviews.has(reviewId)
      ) {
        await interaction.reply({
          content: `✅ Round ${roundStr} is already saved and cannot be edited.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {})
        return
      }

      const modal = new ModalBuilder()
        .setCustomId(`phgg_tally_modal:input:${scrimConfig.label}:${roundStr}:${reviewId}`)
        .setTitle(`Input / Fix Round ${roundStr} Scores`)

      const scoreInput = new TextInputBuilder()
        .setCustomId('score_text')
        .setLabel('Paste missing row(s) or full table text')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Example:\n4 05E 10\nOr full table:\n1 04D 98 118\n2 08H 22 38\n...')
        .setRequired(true)

      modal.addComponents(new ActionRowBuilder().addComponents(scoreInput))
      await interaction.showModal(modal).catch((err) => {
        console.error('[TALLY] Failed to show score input modal:', err)
      })
      return
    }

    if (isModal && action === 'input') {
      const textValue = interaction.fields.getTextInputValue('score_text') || ''
      const parsedInput = parseTextScoreInput(textValue)

      if (parsedInput.entries.length === 0) {
        await interaction.reply({
          content: '⚠️ No valid score rows were recognized from your text input. Example format: `4 05E 10` or `1 04D 98 118`.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {})
        return
      }

      const reviewToken = parseReviewId(reviewId)
      let reviewData = pendingReviews.get(reviewId)
      if (!reviewData && interaction.message) {
        const recovered = parseRoundTableFromMessage(interaction.message.content)
        if (recovered.length > 0) {
          reviewData = {
            roundNumber: Number(roundStr || 1),
            entries: recovered,
            scrimLabel: scrimConfig.label,
            rosterFingerprint: reviewToken?.rosterFingerprint,
            createdAt: reviewToken?.createdAt,
            blocked: true,
          }
        }
      }

      const existingEntries = reviewData?.entries || []
      const mergedEntriesMap = new Map()

      for (const entry of existingEntries) {
        mergedEntriesMap.set(entry.rank, entry)
      }

      for (const newEntry of parsedInput.entries) {
        mergedEntriesMap.set(newEntry.rank, newEntry)
      }

      const updatedEntries = [...mergedEntriesMap.values()].sort((a, b) => a.rank - b.rank)

      const resolvedPreview = tallyBoard.previewRound(
        Number(roundStr || 1),
        updatedEntries,
        registeredTeams,
      )

      const registeredLetters = new Set(registeredTeams.map((t) => t.slotLetter).filter(Boolean))
      const extractedLetters = new Set(resolvedPreview.map((e) => (e.slotCode ? e.slotCode.slice(-1) : e.teamQuery)))
      const missingRegisteredTeams = [...registeredLetters].filter((l) => !extractedLetters.has(l))
      const effectiveMissingRanks = (registeredTeams.length > 0 && missingRegisteredTeams.length === 0)
        ? []
        : missingRanks

      const reviewBlocked = effectiveMissingRanks.length > 0 || resolvedPreview.length !== updatedEntries.length

      let notice = ''
      if (reviewBlocked) {
        const warnings = []
        if (effectiveMissingRanks.length > 0) {
          warnings.push(`⚠️ **Missing row(s)**: #${effectiveMissingRanks.join(', #')}. Use the **Input / Fix Scores** button to add them.`)
        }
        if (resolvedPreview.length !== updatedEntries.length) {
          warnings.push('⚠️ **Unregistered slot**: At least one entered slot does not match the registered team roster.')
        }
        warnings.unshift('⛔ **AUTOMATIC SAVE BLOCKED** — row coverage is incomplete.')
        notice = warnings.join('\n')
      }

      rememberReview(reviewId, {
        roundNumber: Number(roundStr || 1),
        entries: resolvedPreview,
        scrimLabel: scrimConfig.label,
        blocked: reviewBlocked,
        rosterFingerprint: tallyRosterFingerprint(registeredTeams),
      })

      const updatedMessagePayload = buildReviewMessage({
        roundNumber: Number(roundStr || 1),
        entries: resolvedPreview,
        registeredTeams,
        reviewId,
        scrimLabel: scrimConfig.label,
        notice,
        blocked: reviewBlocked,
      })

      try {
        if (interaction.message) {
          await interaction.message.edit(updatedMessagePayload).catch(() => {})
        }
      } catch (editErr) {
        console.error('[TALLY] Failed to edit review message after modal submit:', editErr)
      }

      await interaction.reply({
        content: reviewBlocked
          ? `⚠️ **Added ${parsedInput.entries.length} score row(s).** The review table has been updated, but some required rows are still missing (#${effectiveMissingRanks.join(', #')}).`
          : `✅ **Added ${parsedInput.entries.length} score row(s).** The review table has been updated and is now complete! You can click **Confirm & Save Scores**.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {})
      return
    }

    if (action === 'confirm') {
      cleanupCompletedReviews()
      // A second press on a round that is already saved. Discord keeps showing
      // the old buttons until the client catches up, so this is easy to do by
      // accident — answer it plainly instead of letting it fail.
      if (
        /SCORES CONFIRMED/i.test(interaction.message?.content || '')
        || completedReviews.has(reviewId)
      ) {
        console.log(`[TALLY] Ignoring repeat confirm for ${reviewId}; round ${roundStr} is already saved.`)
        await interaction
          .reply({
            content: `✅ Round ${roundStr} is already saved. Nothing was changed.`,
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {})
        return
      }

      if (activeConfirmations.has(reviewId)) {
        await interaction.reply({
          content: `Round ${roundStr} is already being saved. No second write was started.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {})
        return
      }
      activeConfirmations.add(reviewId)
      try {

      try {
        await interaction.deferUpdate()
      } catch (deferErr) {
        console.error(`[TALLY] Could not acknowledge confirm for ${reviewId}:`, deferErr.message)
        try {
          await interaction.reply({ content: '⚠️ Button interaction expired. Please send the screenshot again.', flags: MessageFlags.Ephemeral })
        } catch { /* already replied */ }
        return
      }

      // Nothing can be tallied accurately without a roster: every row would
      // fall through to "not registered" and overwrite the round with X.
      if (registeredTeams.length === 0) {
        await interaction.editReply({
          content:
            '❌ **No registered teams on the slot board.** Nothing was written to the sheet.\n' +
            'Run `!refreshteams` so the board is loaded, then send the screenshot again.',
          components: [],
        }).catch(() => {})
        return
      }

      // Fall back to the table already on screen when the in-memory review is
      // gone, so a restart between posting and confirming no longer costs the
      // round. The review is the source of truth either way: the scorekeeper
      // approved exactly what is rendered there.
      const reviewToken = parseReviewId(reviewId)
      let reviewData = pendingReviews.get(reviewId)
      if (!reviewData) {
        const recovered = parseRoundTableFromMessage(interaction.message?.content)
        if (recovered.length > 0) {
          console.warn(
            `[TALLY] Review ${reviewId} was lost (restart?); recovered ${recovered.length} rows from the message.`,
          )
          reviewData = {
            roundNumber: Number(roundStr || 1),
            entries: recovered,
            scrimLabel: scrimConfig.label,
            rosterFingerprint: reviewToken?.rosterFingerprint,
            createdAt: reviewToken?.createdAt,
          }
        }
      }
      if (isBlockedTallyReview(reviewData, interaction.message?.content)) {
        pendingReviews.delete(reviewId)
        await interaction.editReply({
          content:
            `${interaction.message?.content || `📋 Round ${roundStr} review`}` +
            '\n\n⛔ **NOT SAVED.** This extraction contains unreadable, missing, or conflicting rows. ' +
            'Re-upload clearer screenshots or submit the complete round as text.',
          components: [],
        }).catch(() => {})
        return
      }
      if (reviewIsExpired(reviewId, reviewData, interaction.message)) {
        pendingReviews.delete(reviewId)
        await interaction.editReply({
          content:
            `Round ${roundStr} was NOT saved.\n` +
            'This review is invalid or more than six hours old. Nothing was written to the Google Sheet.\n' +
            'Post the screenshot again to create a fresh review.',
          components: [],
        }).catch(() => {})
        return
      }
      let roundNumInt = Number(roundStr || 1)
      let confirmedEntries = []
      let syncResult = null

      if (reviewData) {
        roundNumInt = reviewData.roundNumber
        if (
          !Number.isInteger(Number(roundNumInt))
          || Number(roundNumInt) < 1
          || Number(roundNumInt) > 4
          || Number(roundNumInt) !== Number(roundStr)
        ) {
          pendingReviews.delete(reviewId)
          await interaction.editReply({
            content: 'NOT SAVED. The review has an invalid or mismatched round number.',
            components: [],
          }).catch(() => {})
          return
        }
        const expectedRosterFingerprint = reviewData.rosterFingerprint
          || reviewToken?.rosterFingerprint
        if (
          !expectedRosterFingerprint
          || expectedRosterFingerprint !== tallyRosterFingerprint(registeredTeams)
        ) {
          pendingReviews.delete(reviewId)
          await interaction.editReply({
            content:
              `${interaction.message?.content || `Round ${roundStr} review`}` +
              '\n\nNOT SAVED. The registered slot roster changed after this review was created. ' +
              'Refresh the roster and re-upload the complete round.',
            components: [],
          }).catch(() => {})
          return
        }
        console.log(`[TALLY] Confirm pressed for Round ${roundNumInt} with ${reviewData.entries.length} entries`)

        // Use what setRound returns, not what went in. Entries recovered from
        // a review message carry only the slot code and kills, so rendering
        // them raw showed the slot code in the TEAM column and 0 points.
        // setRound resolves each row against the roster and works out the
        // placement points.
        confirmedEntries = tallyBoard.previewRound(
          reviewData.roundNumber,
          reviewData.entries,
          registeredTeams,
        )
        if (
          reviewData.entries.length === 0
          || confirmedEntries.length !== reviewData.entries.length
        ) {
          pendingReviews.delete(reviewId)
          await interaction.editReply({
            content: 'NOT SAVED. One or more reviewed rows no longer map one-to-one to the slot roster.',
            components: [],
          }).catch(() => {})
          return
        }

        try {
          syncResult = await sheetSync({
            ...sheetTarget(scrimConfig),
            roundNumber: reviewData.roundNumber,
            entries: confirmedEntries,
            registeredTeams,
            // Stable per-review id, so the duplicate-write guard can actually
            // fire. It defaulted to a fresh random value on every call, which
            // meant no double-submit was ever detected.
            submissionId: reviewId,
            device: scrimConfig.label || 'PC',
            timeLabel: scrimConfig.timeLabel || '10:00 PM',
            roundsLabel: scrimConfig.roundsLabel || '4 ROUNDS',
            actorUserId: interaction.user.id,
          })
          if (syncResult?.success !== true) {
            throw new Error(syncResult?.error || 'The sheet writer did not return an explicit success result.')
          }
          console.log(`[TALLY] Sheet sync success:`, syncResult)
        } catch (err) {
          console.error('[TALLY] Google Sheets sync error:', err)
          const retryReview = buildReviewMessage({
            roundNumber: roundNumInt,
            entries: confirmedEntries,
            registeredTeams,
            reviewId,
            scrimLabel: scrimConfig.label,
            notice:
              `NOT SAVED - Google Sheet write failed: ${err.message}\n` +
              'The tally board was not changed. Fix the sheet connection, then press Confirm again.',
          })
          await interaction.editReply(retryReview).catch(() => {})
          return
        }

        confirmedEntries = tallyBoard.setRound(
          reviewData.roundNumber,
          confirmedEntries,
          registeredTeams,
        )
        pendingReviews.delete(reviewId)
        completedReviews.set(reviewId, Date.now())
      } else {
        // Nothing was tallied and nothing was written to the sheet. Saying
        // "SCORES CONFIRMED" here was actively misleading: the round looked
        // saved while the sheet still had no scores for it.
        console.warn(`[TALLY] No pending review found for reviewId=${reviewId}`)
        await interaction
          .editReply({
            content:
              `⚠️ **Round ${roundNumInt} was NOT saved.**\n` +
              '*This review expired, or the bot restarted after the screenshot was posted. ' +
              'Nothing was written to the Google Sheet.*\n' +
              'Post the screenshot again to redo this round.',
            components: [],
          })
          .catch(() => {})
        return
      }

      // Show the round exactly as it was reviewed, in its own placement order.
      // Re-sorting into cumulative standings here made a correct extract look
      // like it had changed on confirm. Overall standings are still one click
      // away on the View Standings button, or via !standings.
      // reviewData is guaranteed here — the branch above returns without it.
      // Must be confirmedEntries, not reviewData.entries: a round recovered
      // from its review message carries only slot codes and kills, so rendering
      // the input showed the slot code as the team name and 0 points. setRound
      // resolves the roster and computes the placement points.
      const confirmedTable = `📋 **ROUND ${roundNumInt} RESULTS**\n${buildRoundScoreTable(confirmedEntries)}`

      const teamsTallied = Number.isInteger(syncResult?.teamsTallied)
        ? syncResult.teamsTallied
        : confirmedEntries.length
      const statusNotice = syncResult?.verificationStatus === 'WEBHOOK_ACCEPTED'
        ? `*(Google Sheets webhook accepted ${teamsTallied} teams)*`
        : `*(Scores written & verified in Google Sheet — ${teamsTallied} teams tallied)*`

      // Confirm and Reject are gone, but keep View Standings so the cumulative
      // table is still one click away.
      const standingsOnly = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('View Standings')
          .setStyle(ButtonStyle.Link)
          .setURL(getSpreadsheetUrl()),
      )

      try {
        await interaction.editReply({
          content: `${TALLY_EMOJI.confirmed} **ROUND ${roundNumInt} SCORES CONFIRMED!**\n${statusNotice}\n\n${confirmedTable}`,
          components: [standingsOnly],
        })
      } catch (editErr) {
        console.error('[TALLY] Failed to edit reply after confirm:', editErr.message)
      }
      return
      } finally {
        activeConfirmations.delete(reviewId)
      }
    }

    if (action === 'reject') {
      if (activeConfirmations.has(reviewId)) {
        await interaction.reply({
          content: `Round ${roundStr} is already being saved and cannot be rejected mid-write.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {})
        return
      }
      if (completedReviews.has(reviewId)) {
        await interaction.reply({
          content: `Round ${roundStr} is already saved and cannot be rejected.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {})
        return
      }
      await interaction.deferUpdate().catch(() => {})
      pendingReviews.delete(reviewId)
      await interaction.editReply({
        content: `❌ **ROUND ${roundStr} TALLY REJECTED & DISCARDED.**`,
        components: [],
      }).catch(() => {})
      return
    }

    // Nothing matched. An unanswered interaction is precisely what Discord
    // shows as "This interaction failed", so acknowledge it rather than letting
    // it fall off the end — most likely a button from an older message whose
    // action no longer exists.
    if (!interaction.replied && !interaction.deferred) {
      console.warn(`[TALLY] Unhandled button action "${action}" on customId ${customId}`)
      await interaction
        .reply({
          content: '⚠️ This button is from an older message and no longer works. Post the screenshot again.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {})
    }
  })
}

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { TallyBoard, TALLY_EMOJI, renderAlignedTable, getPlacementPoints } from './tally-core.js'
import { parseScreenshotWithGemini, parseTextScoreInput } from './tally-vision.js'
import { parseScreenshotLocally } from './tally-ocr.js'
import { syncScoresToGoogleSheet, fetchLiveStandingsFromSheet, clearGoogleSheetScores, formatSheetTeamName, getSpreadsheetUrl } from './tally-sheet.js'

const activeTallyBoards = new Map()
const pendingReviews = new Map()

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
 * Local glyph template matching is the default: the endgame screen is a fixed
 * grid in a fixed bitmap font, so reading it is a lookup with an exact answer.
 * Measured against the six real captures in test/fixtures it gets 60/60 on
 * rank, slot letter and kills, and — the part that matters for scoring — it
 * reports a cell it cannot match instead of guessing. No API key, no quota.
 * See scripts/ocr-calibrate.mjs for the harness.
 *
 * Cloud vision is kept as the fallback for anything the templates cannot read,
 * such as a Bloodstrike UI restyle. Set TALLY_VISION_PROVIDER=gemini to put it
 * back in front.
 */
function resolveVisionProvider(globalConfig) {
  const configured = String(process.env.TALLY_VISION_PROVIDER || 'local').toLowerCase()
  const apiKey = globalConfig?.geminiApiKey || process.env.GEMINI_API_KEY
  if (configured === 'gemini' && apiKey) return 'gemini'
  if (configured === 'gemini') {
    console.warn('[TALLY] TALLY_VISION_PROVIDER=gemini but no API key configured; reading locally.')
  }
  return 'local'
}

function canManageTally(member, allowedRoleIds = new Set()) {
  if (!member) return true
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
  const entries = []
  for (const raw of String(content || '').split('\n')) {
    const line = raw.trim().replace(/^`+/, '').replace(/`+$/, '').trim()
    // Skip the header, whatever it was called when the message was posted.
    if (!line || /^(RK|RANK|PLACE)\b/.test(line) || /^[─-]+$/.test(line)) continue

    // "<place> <slot> [team name…] <kills> <pts>". The TEAM column was dropped,
    // but older messages still carry it — and a team name contains spaces — so
    // read the ends of the row and ignore whatever sits between them.
    const tokens = line.split(/\s+/)
    if (tokens.length < 4) continue

    const rank = Number(tokens[0])
    const slotCode = tokens[1]
    const kills = Number(tokens[tokens.length - 2])

    if (!Number.isInteger(rank) || rank < 1 || rank > 25) continue
    if (!/^\d{1,2}[A-Z]$/i.test(slotCode)) continue
    if (!Number.isInteger(kills) || kills < 0) continue

    entries.push({ rank, slotCode, teamQuery: slotCode, kills })
  }
  return entries
}

export function buildReviewMessage({ roundNumber, entries, registeredTeams, reviewId, scrimLabel = 'PC', notice = '' }) {
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
      .setCustomId(`phgg_tally:confirm:${scrimLabel}:${roundNumber}:${reviewId}`)
      .setLabel('Confirm & Save Scores')
      .setStyle(ButtonStyle.Success),
    // Link buttons open the scoresheet directly; they carry a URL instead of a
    // custom id and so never round-trip to the bot.
    new ButtonBuilder()
      .setLabel('View Standings')
      .setStyle(ButtonStyle.Link)
      .setURL(getSpreadsheetUrl()),
    new ButtonBuilder()
      .setCustomId(`phgg_tally:reject:${scrimLabel}:${roundNumber}:${reviewId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  )

  return { content: lines.join('\n'), components: [row] }
}

export function installTallyAutomation(client, scrimConfig, globalConfig, getScrimBoard) {
  const tallyBoard = getOrCreateTallyBoard(scrimConfig.label, scrimConfig.placementPoints)
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
      const imageAttachments = allAttachments.filter((att) => {
        const contentType = att.contentType ?? ''
        const name = att.name ?? ''
        const isImageExt = /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)
        const isImageMime = contentType.startsWith('image/')
        const hasDimensions = Boolean(att.width || att.height)
        return isImageMime || isImageExt || hasDimensions || allAttachments.length > 0
      })

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

          const downloadedImages = await Promise.all(
            imageAttachments.map(async (att) => {
              const resp = await fetch(att.url)
              if (!resp.ok) throw new Error(`Failed to download attachment ${att.name}: HTTP ${resp.status}`)
              const buf = Buffer.from(await resp.arrayBuffer())
              return { buffer: buf, mimeType: att.contentType || 'image/png' }
            }),
          )
          console.log(`[TALLY] Downloaded ${downloadedImages.length} image(s) in ${Date.now() - startedAt}ms`)

          let parsed
          let degradedNotice = ''
          // Tagged so the log and the review notice name the reader that
          // actually produced the round, not the one that was tried first.
          const callCloud = async () => ({
            source: 'gemini',
            ...(await parseScreenshotWithGemini({
              images: downloadedImages,
              apiKey: globalConfig.geminiApiKey || process.env.GEMINI_API_KEY,
            })),
          })

          if (provider === 'local') {
            try {
              parsed = await parseScreenshotLocally({ images: downloadedImages })
            } catch (localErr) {
              // The templates only know the current Bloodstrike endgame layout.
              // Anything else — a UI restyle, a cropped capture — is what cloud
              // vision is kept around for.
              console.warn(`[TALLY] Local reader failed, trying cloud vision: ${localErr.message}`)
              try {
                parsed = await callCloud()
              } catch (visionErr) {
                throw new Error(`${localErr.message}\n\nCloud vision fallback also failed: ${visionErr.message}`)
              }
            }
          } else {
            try {
              parsed = await callCloud()
            } catch (visionErr) {
              console.warn(`[TALLY] Cloud vision failed, reading locally: ${visionErr.message}`)
              parsed = await parseScreenshotLocally({ images: downloadedImages })
            }
          }

          const usedProvider = parsed.source || provider
          if (usedProvider === 'ocr') {
            degradedNotice =
              '⚠️ **Read with fallback OCR** — the glyph reader could not parse this layout, so slot letters and kill counts are frequently wrong here. **Check every row** before confirming.'
          } else if (parsed.uncertain?.length) {
            const ranks = parsed.uncertain.map((u) => `#${u.rank ?? '?'}`).join(', ')
            degradedNotice = `⚠️ **${parsed.uncertain.length} row(s) could not be read confidently** (${ranks}) and were left out. Add them manually before confirming.`
          }

          console.log(
            `[TALLY] ${usedProvider.toUpperCase()} parse finished ${Date.now() - startedAt}ms after the screenshot arrived (${parsed.entries.length} rows)`,
          )

          // Use user-specified round, auto-detected next round, or Gemini's parsed round
          const effectiveRound = userSpecifiedRound
            ? userSpecifiedRound
            : (parsed.roundNumber && parsed.roundNumber !== 1 ? parsed.roundNumber : getNextRound())

          console.log(`[TALLY] Screenshot parsed: ${usedProvider} returned ${parsed.entries.length} teams. Round: ${effectiveRound}`)

          const registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []
          const previewEntries = tallyBoard.setRound(
            effectiveRound,
            parsed.entries,
            registeredTeams,
            message.id,
          )

          const reviewId = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
          rememberReview(reviewId, {
            roundNumber: effectiveRound,
            entries: previewEntries,
            scrimLabel: scrimConfig.label,
          })

          const reviewMsg = buildReviewMessage({
            roundNumber: effectiveRound,
            entries: previewEntries,
            registeredTeams,
            reviewId,
            scrimLabel: scrimConfig.label,
            notice: degradedNotice,
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

          const registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []
          const previewEntries = tallyBoard.setRound(
            effectiveRound,
            parsed.entries,
            registeredTeams,
            message.id,
          )

          const reviewId = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
          rememberReview(reviewId, {
            roundNumber: effectiveRound,
            entries: previewEntries,
            scrimLabel: scrimConfig.label,
          })

          const reviewMsg = buildReviewMessage({
            roundNumber: effectiveRound,
            entries: previewEntries,
            registeredTeams,
            reviewId,
            scrimLabel: scrimConfig.label,
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

    if (!interaction.isButton()) return
    const { customId } = interaction

    if (!customId.startsWith('phgg_tally:')) return

    const parts = customId.split(':')
    const [, action, targetLabel, roundStr, reviewId] = parts
    if (targetLabel && targetLabel.toUpperCase() !== scrimConfig.label.toUpperCase()) return

    // Log every button this scope accepts. "This interaction failed" in Discord
    // gives no detail, so without this there is nothing to diagnose from.
    console.log(
      `[TALLY] ${scrimConfig.label} button "${action}" round=${roundStr} review=${reviewId} by ${interaction.user?.id}`,
    )

    // Reading the slot board must never take the interaction down with it: a
    // throw here happens before any reply, which Discord reports as a failed
    // interaction with no explanation.
    let registeredTeams = []
    try {
      registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []
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

    if (action === 'confirm') {
      // A second press on a round that is already saved. Discord keeps showing
      // the old buttons until the client catches up, so this is easy to do by
      // accident — answer it plainly instead of letting it fail.
      if (/SCORES CONFIRMED/i.test(interaction.message?.content || '')) {
        console.log(`[TALLY] Ignoring repeat confirm for ${reviewId}; round ${roundStr} is already saved.`)
        await interaction
          .reply({
            content: `✅ Round ${roundStr} is already saved. Nothing was changed.`,
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {})
        return
      }

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
          }
        }
      }
      let roundNumInt = Number(roundStr || 1)
      let confirmedEntries = []
      let syncResult = null
      let syncError = null

      if (reviewData) {
        roundNumInt = reviewData.roundNumber
        console.log(`[TALLY] Confirm pressed for Round ${roundNumInt} with ${reviewData.entries.length} entries`)

        // Use what setRound returns, not what went in. Entries recovered from
        // a review message carry only the slot code and kills, so rendering
        // them raw showed the slot code in the TEAM column and 0 points.
        // setRound resolves each row against the roster and works out the
        // placement points.
        confirmedEntries = tallyBoard.setRound(
          reviewData.roundNumber,
          reviewData.entries,
          registeredTeams,
        )

        try {
          syncResult = await syncScoresToGoogleSheet({
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
          console.log(`[TALLY] Sheet sync success:`, syncResult)
        } catch (err) {
          console.error('[TALLY] Google Sheets sync error:', err)
          syncError = err.message
        }

        pendingReviews.delete(reviewId)
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

      const statusNotice = syncError
        ? `⚠️ **Sheet Write Error**: ${syncError}`
        : (syncResult && syncResult.success
            ? [
                // The audit id stays in the audit store and the logs; it is not
                // something the scorekeeper needs to read on every round.
                `*(Scores written & verified in Google Sheet — ${syncResult.teamsTallied} teams tallied)*`,
              ].join('\n')
            : `*(Scores saved to leaderboard)*`)

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
    }

    if (action === 'reject') {
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

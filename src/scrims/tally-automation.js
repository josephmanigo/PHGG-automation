import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { TallyBoard, findUnmatchedEntries } from './tally-core.js'
import { parseScreenshotWithGemini, parseTextScoreInput } from './tally-vision.js'
import { parseScreenshotWithOcr } from './tally-ocr.js'
import { syncScoresToGoogleSheet, fetchLiveStandingsFromSheet, clearGoogleSheetScores, formatSheetTeamName } from './tally-sheet.js'

const activeTallyBoards = new Map()
const pendingReviews = new Map()

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

async function clearTallyAndSheet() {
  clearAllTallyBoards()
  return clearGoogleSheetScores()
}

const MAX_LISTED_TEAMS = 8

function summariseTeams(list) {
  if (list.length <= MAX_LISTED_TEAMS) return list.join(', ')
  return `${list.slice(0, MAX_LISTED_TEAMS).join(', ')} +${list.length - MAX_LISTED_TEAMS} more`
}

/**
 * Spell out what was deliberately NOT scored, so a misread screenshot is
 * obvious at a glance instead of silently landing in the sheet.
 */
export function formatAccuracyNotices(syncResult = {}) {
  const notices = []
  const absent = syncResult.registeredNotInScreenshot || []
  const unmatched = syncResult.unmatchedScreenshotEntries || []

  if (absent.length > 0) {
    notices.push(`⬜ *Marked **X** (registered but not in this screenshot): ${summariseTeams(absent)}*`)
  }
  if (unmatched.length > 0) {
    notices.push(`🚫 *Skipped (not on the team slot board): ${summariseTeams(unmatched)}*`)
  }
  return notices
}

function formatClearReply(scrimLabel, result) {
  if (result?.success) {
    return `✅ Score tally board and Google Sheet reset to blank for **${scrimLabel} SCRIM**.\n*Team names, all four rounds, penalties and the rank 1-2-3 highlight were removed.*`
  }
  return `⚠️ Tally board reset for **${scrimLabel} SCRIM**, but the Google Sheet could not be cleared: ${result?.error || 'unknown error'}`
}

/**
 * Which reader parses screenshots.
 *
 * Local OCR is the goal — no API key, no quota — but measured against the six
 * real captures in test/fixtures it currently gets the slot letter right about
 * 60% of the time and the kill count about 55%. A wrong slot letter silently
 * awards points to another team, so it is NOT the default yet. See
 * scripts/ocr-calibrate.mjs for the harness and the remaining work.
 *
 * Set TALLY_VISION_PROVIDER=ocr to use it anyway; it falls back to OCR
 * automatically when no Gemini key is configured.
 */
function resolveVisionProvider(globalConfig) {
  const configured = String(process.env.TALLY_VISION_PROVIDER || 'gemini').toLowerCase()
  const apiKey = globalConfig?.geminiApiKey || process.env.GEMINI_API_KEY
  if (configured === 'ocr') return 'ocr'
  if (!apiKey) {
    console.warn('[TALLY] No Gemini API key configured; using local OCR (accuracy is not yet verified).')
    return 'ocr'
  }
  return 'gemini'
}

function canManageTally(member, allowedRoleIds = new Set()) {
  if (!member) return true
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true
  if (member.permissions?.has(PermissionFlagsBits.ManageMessages)) return true

  const memberRoles = member.roles?.cache?.keys ? [...member.roles.cache.keys()] : []
  return memberRoles.some((roleId) => allowedRoleIds.has(String(roleId)))
}

export function buildReviewMessage({ roundNumber, entries, registeredTeams, reviewId, scrimLabel = 'PC', skippedEntries = [] }) {
  const lines = [
    `📋 **${scrimLabel.toUpperCase()} SCRIM SCORE TALLY REVIEW — ROUND ${roundNumber}**`,
    `*Please verify extracted team ranks and kills before confirming.*`,
    '```',
    `RK  SLOT  TAG / TEAM                        KILLS  PTS`,
    `───────────────────────────────────────────────────────`,
  ]

  entries.forEach((e, idx) => {
    const rk = String(e.rank || idx + 1).padStart(2, ' ')
    const slot = String(e.slotCode || '??').padEnd(4, ' ')
    const nameStr = e.tag ? `[${e.tag}] ${e.name}` : (e.teamQuery || 'Unknown')
    const nameCol = nameStr.slice(0, 32).padEnd(32, ' ')
    const kills = String(e.kills || 0).padStart(5, ' ')
    const pts = String(e.totalPoints || 0).padStart(4, ' ')
    lines.push(`${rk}  ${slot}  ${nameCol}  ${kills}  ${pts}`)
  })
  lines.push('```')

  // Anything deliberately left out, shown BEFORE confirming rather than after.
  // A gap in the RK column otherwise reads as a fetch error.
  const scoredSlots = new Set(entries.map((e) => e.slotCode))
  const absent = (registeredTeams || [])
    .filter((t) => !scoredSlots.has(t.slotCode))
    .map((t) => `${t.slotIndex + 1}-${t.slotLetter} ${formatSheetTeamName(t)}`)

  if (skippedEntries.length > 0) {
    lines.push(
      `🚫 *Not on the team slot board, so **not** scored: ${summariseTeams(skippedEntries)}*`,
    )
  }
  if (absent.length > 0) {
    lines.push(`⬜ *Registered but not in this screenshot, will be marked **X**: ${summariseTeams(absent)}*`)
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`phgg_tally:confirm:${scrimLabel}:${roundNumber}:${reviewId}`)
      .setLabel('✅ Confirm & Save Scores')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`phgg_tally:standings:${scrimLabel}:${roundNumber}:${reviewId}`)
      .setLabel('📊 View Standings')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`phgg_tally:reject:${scrimLabel}:${roundNumber}:${reviewId}`)
      .setLabel('❌ Reject')
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
      const clearResult = await clearTallyAndSheet()
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

          const parsed =
            provider === 'gemini'
              ? await parseScreenshotWithGemini({
                  images: downloadedImages,
                  apiKey: globalConfig.geminiApiKey || process.env.GEMINI_API_KEY,
                })
              : await parseScreenshotWithOcr({ images: downloadedImages })
          console.log(
            `[TALLY] ${provider.toUpperCase()} parse finished ${Date.now() - startedAt}ms after the screenshot arrived (${parsed.entries.length} rows)`,
          )

          // Use user-specified round, auto-detected next round, or Gemini's parsed round
          const effectiveRound = userSpecifiedRound
            ? userSpecifiedRound
            : (parsed.roundNumber && parsed.roundNumber !== 1 ? parsed.roundNumber : getNextRound())

          console.log(`[TALLY] Screenshot parsed: Gemini returned ${parsed.entries.length} teams. Round: ${effectiveRound}`)

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
            skippedEntries: findUnmatchedEntries(parsed.entries, registeredTeams),
          })

          await respond(reviewMsg)
        } catch (err) {
          console.error('[TALLY] Failed to parse screenshot with Gemini:', err)
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
            skippedEntries: findUnmatchedEntries(parsed.entries, registeredTeams),
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
      if (cmdName === 'clear' || cmdName === 'clearsheet') {
        if (!canManageTally(interaction.member, allowedRoleIds)) {
          await interaction.reply({ content: '❌ You do not have permission to clear score tallies.', flags: MessageFlags.Ephemeral }).catch(() => {})
          return
        }
        await interaction.deferReply().catch(() => {})
        const clearResult = await clearTallyAndSheet()
        await interaction.editReply(formatClearReply('PC', clearResult)).catch(() => {})
        return
      }
      if (cmdName === 'standings') {
        const registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []
        const standingsText = tallyBoard.formatStandingsMarkdown(
          registeredTeams,
          `${globalConfig.brandName} PC SCRIM STANDINGS`,
        )
        await interaction.reply({ content: standingsText }).catch(() => {})
        return
      }
      if (cmdName === 'refreshteams') {
        const registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []
        const teamListStr = registeredTeams.length > 0
          ? registeredTeams.map((t) => `${t.slotCode}: ${t.tag ? `[${t.tag}] ` : ''}${t.name}`).join('\n')
          : '*No teams registered on the board yet.*'
        await interaction.reply({ content: `🔄 **PC SCRIM REGISTERED TEAMS REFRESHED** (${registeredTeams.length} Teams):\n\`\`\`\n${teamListStr}\n\`\`\`` }).catch(() => {})
        return
      }
    }

    if (!interaction.isButton()) return
    const { customId } = interaction

    if (!customId.startsWith('phgg_tally:')) return

    const parts = customId.split(':')
    const [, action, targetLabel, roundStr, reviewId] = parts
    if (targetLabel && targetLabel.toUpperCase() !== scrimConfig.label.toUpperCase()) return

    const registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []

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
      try {
        await interaction.deferUpdate()
      } catch (deferErr) {
        console.error('Failed to defer button update:', deferErr.message)
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

      const reviewData = pendingReviews.get(reviewId)
      let roundNumInt = Number(roundStr || 1)
      let syncResult = null
      let syncError = null

      if (reviewData) {
        roundNumInt = reviewData.roundNumber
        console.log(`[TALLY] Confirm pressed for Round ${roundNumInt} with ${reviewData.entries.length} entries`)

        tallyBoard.setRound(
          reviewData.roundNumber,
          reviewData.entries,
          registeredTeams,
        )

        try {
          syncResult = await syncScoresToGoogleSheet({
            roundNumber: reviewData.roundNumber,
            entries: reviewData.entries,
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
        console.warn(`[TALLY] No pending review found for reviewId=${reviewId}`)
      }

      const standingsText = tallyBoard.formatStandingsMarkdown(
        registeredTeams,
        `${globalConfig.brandName} ${scrimConfig.label} SCRIM STANDINGS`,
      )

      const statusNotice = syncError
        ? `⚠️ **Sheet Write Error**: ${syncError}`
        : (syncResult && syncResult.success
            ? [
                `📊 *Scores written & verified in Google Sheet! (${syncResult.teamsTallied} teams tallied, Audit ID: \`${syncResult.auditId}\`)*`,
                ...formatAccuracyNotices(syncResult),
              ].join('\n')
            : `📊 *Scores saved to leaderboard!*`)

      try {
        await interaction.editReply({
          content: `✅ **ROUND ${roundNumInt} SCORES CONFIRMED!**\n${statusNotice}\n\n${standingsText}`,
          components: [],
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
    }
  })
}

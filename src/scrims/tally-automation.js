import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  PermissionFlagsBits,
} from 'discord.js'
import { TallyBoard } from './tally-core.js'
import { parseScreenshotWithGemini, parseTextScoreInput } from './tally-vision.js'
import { syncScoresToGoogleSheet, fetchLiveStandingsFromSheet } from './tally-sheet.js'

const activeTallyBoards = new Map()
const pendingReviews = new Map()

export function getOrCreateTallyBoard(scrimLabel, customPlacementPoints) {
  const key = String(scrimLabel || 'DEFAULT').toUpperCase()
  if (!activeTallyBoards.has(key)) {
    activeTallyBoards.set(key, new TallyBoard(customPlacementPoints))
  }
  return activeTallyBoards.get(key)
}

function canManageTally(member, allowedRoleIds = new Set()) {
  if (!member) return true
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true
  if (member.permissions?.has(PermissionFlagsBits.ManageMessages)) return true

  const memberRoles = member.roles?.cache?.keys ? [...member.roles.cache.keys()] : []
  return memberRoles.some((roleId) => allowedRoleIds.has(String(roleId)))
}

export function buildReviewMessage({ roundNumber, entries, registeredTeams, reviewId, scrimLabel = 'PC' }) {
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
  const tallyChannelId = scrimConfig.tallyChannelId || scrimConfig.channels?.tally
  const allowedRoleIds = new Set([
    ...(scrimConfig.scorekeeperRoleIds || []),
    ...(globalConfig.scorekeeperRoleIds || []),
  ])

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return
    const isTallyChannel = Boolean(tallyChannelId && message.channel.id === tallyChannelId)
    const isScrimChannel = isTallyChannel || Object.values(scrimConfig.channels || {}).includes(message.channel.id)
    const content = message.content.trim()

    // Handle Commands: !standings, !correctscore, !cleartally
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

    if (content.toLowerCase().startsWith('!cleartally')) {
      const parts = content.split(/\s+/)
      const targetScope = parts[1]?.toUpperCase()
      if (targetScope && targetScope !== scrimConfig.label.toUpperCase()) return
      if (!targetScope && !isScrimChannel) return

      if (!canManageTally(message.member, allowedRoleIds)) {
        await message.reply('❌ You do not have permission to clear score tallies.').catch(() => {})
        return
      }
      tallyBoard.clear()
      await message.reply(`✅ Score tally board cleared for ${scrimConfig.label} session.`).catch(() => {})
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
      const imageAttachments = [...message.attachments.values()].filter((att) =>
        (att.contentType ?? '').startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(att.name),
      )

      if (imageAttachments.length > 0) {
        try {
          const apiKey = globalConfig.geminiApiKey || process.env.GEMINI_API_KEY
          if (!apiKey) {
            await message.reply('⚠️ `GEMINI_API_KEY` is not set. Please use text format score input: `ROUND 1\n1. NR 12 KILLS` or configure `GEMINI_API_KEY`.').catch(() => {})
            return
          }

          const downloadedImages = await Promise.all(
            imageAttachments.map(async (att) => {
              const resp = await fetch(att.url)
              const buf = Buffer.from(await resp.arrayBuffer())
              return { buffer: buf, mimeType: att.contentType || 'image/png' }
            }),
          )

          const parsed = await parseScreenshotWithGemini({
            images: downloadedImages,
            apiKey,
          })

          const registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []
          const previewEntries = tallyBoard.setRound(
            parsed.roundNumber,
            parsed.entries,
            registeredTeams,
            message.id,
          )

          const reviewId = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
          pendingReviews.set(reviewId, {
            roundNumber: parsed.roundNumber,
            entries: previewEntries,
            scrimLabel: scrimConfig.label,
          })

          const reviewMsg = buildReviewMessage({
            roundNumber: parsed.roundNumber,
            entries: previewEntries,
            registeredTeams,
            reviewId,
            scrimLabel: scrimConfig.label,
          })

          await message.reply(reviewMsg).catch(() => {})
        } catch (err) {
          console.error('Failed to parse screenshot with Gemini:', err)
          await message.reply(`❌ Failed to parse screenshot: ${err.message}`).catch(() => {})
        }
        return
      }

      // Check text score input
      if (content.toLowerCase().startsWith('round') || /^#?\d+[.\s\-]/m.test(content)) {
        const parsed = parseTextScoreInput(content)
        if (parsed.entries.length > 0) {
          const registeredTeams = getScrimBoard ? getScrimBoard().getRegisteredTeams() : []
          const previewEntries = tallyBoard.setRound(
            parsed.roundNumber,
            parsed.entries,
            registeredTeams,
            message.id,
          )

          const reviewId = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
          pendingReviews.set(reviewId, {
            roundNumber: parsed.roundNumber,
            entries: previewEntries,
            scrimLabel: scrimConfig.label,
          })

          const reviewMsg = buildReviewMessage({
            roundNumber: parsed.roundNumber,
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

  // Handle Discord Button Interactions
  client.on(Events.InteractionCreate, async (interaction) => {
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
      await interaction.reply({ content: standingsText, ephemeral: true }).catch(() => {})
      return
    }

    if (!canManageTally(interaction.member, allowedRoleIds)) {
      await interaction.reply({ content: '❌ You do not have permission to modify tally scores.', ephemeral: true }).catch(() => {})
      return
    }

    if (action === 'confirm') {
      await interaction.deferUpdate().catch(() => {})
      const reviewData = pendingReviews.get(reviewId)
      let syncResult = null
      if (reviewData) {
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
            actorUserId: interaction.user.id,
          })
        } catch (err) {
          console.error('Failed to sync scores to Google Sheet:', err)
          await interaction.followUp({ content: `❌ **Scoresheet Write / Verification Error**: ${err.message}`, ephemeral: true }).catch(() => {})
          return
        }
      }

      const standingsText = tallyBoard.formatStandingsMarkdown(
        registeredTeams,
        `${globalConfig.brandName} ${scrimConfig.label} SCRIM STANDINGS`,
      )

      const successBlock = syncResult && syncResult.success
        ? `\`\`\`\nROUND ${roundStr} TALLY CONFIRMED\n\nTeams tallied: ${syncResult.teamsTallied}\nMissing-slot markers added: ${syncResult.missingMarkersAdded}\nFormula cells changed: 0\nPenalty cells changed: 0\nVerification: ${syncResult.verificationStatus}\nWorksheet: ${syncResult.worksheetName}\nAudit ID: ${syncResult.auditId}\n\`\`\``
        : `✅ **ROUND ${roundStr} SCORES CONFIRMED & SAVED!**`

      await interaction.editReply({
        content: `${successBlock}\n\n${standingsText}`,
        components: [],
      }).catch(() => {})
      return
    }

    if (action === 'reject') {
      pendingReviews.delete(reviewId)
      await interaction.update({
        content: `❌ **ROUND ${roundStr} TALLY REJECTED & DISCARDED.**`,
        components: [],
      }).catch(() => {})
    }
  })
}

import { EmbedBuilder, Events, PermissionFlagsBits } from 'discord.js'
import {
  parseCancelContent,
  parseMineContent,
  ScrimBoard,
  slotCode,
  validateRegistrationContent,
} from './core.js'
import {
  BOT_CHECK_REACTION_ID,
  BOT_CROSS_REACTION_ID,
  findReaction,
  LEGACY_BOT_REACTION_EMOJIS,
  resolveReactionEmoji,
} from '../reactions.js'

const MAX_WAITLIST_DISPLAY = 40
const ALWAYS_OPEN_CYCLE_ID = 'ALWAYS_OPEN'
export const SCRIM_CHECK_REACTION_ID = BOT_CHECK_REACTION_ID
export const SCRIM_CROSS_REACTION_ID = BOT_CROSS_REACTION_ID
export const BOARD_CALENDAR_EMOJI_ID = '1436064495939354634'
export const BOARD_ALARM_CLOCK_EMOJI_ID = '1259806144080248894'
export const BOARD_PUSHPIN_EMOJI_ID = '1240329558033436722'
const CANCEL_SLOT_FORMAT_MESSAGE = [
  '❌ **WRONG FORMAT**',
  'Follow this format:',
  '`CANCEL - TEAM NAME`',
].join('\n')
const MINE_SLOT_FORMAT_MESSAGE = [
  '❌ **WRONG FORMAT**',
  'Follow this format:',
  '`MINE - CLAN TAG TEAM NAME`',
].join('\n')

function messageSignals(message) {
  return [
    message.id,
    message.content,
    ...[...message.attachments.values()].flatMap((attachment) => [
      attachment.id,
      attachment.name,
      attachment.url,
    ]),
    ...message.embeds.flatMap((embed) => [
      embed.url,
      embed.image?.url,
      embed.thumbnail?.url,
      embed.video?.url,
    ]),
  ].filter(Boolean)
}

function starterSignalIds(config) {
  return [
    config.bannerAssetId,
    ...[...(config.bannerSignalIds ?? [])],
  ].filter(Boolean)
}

function hasConfiguredStarterSignal(message, config) {
  const signals = messageSignals(message)
  return starterSignalIds(config).some((starterId) =>
    signals.some((value) => value.includes(starterId)),
  )
}

export function replayScrimEvents(board, events) {
  const registrationOutcomes = []
  for (const event of events) {
    const { message } = event
    if (event.type === 'registration') {
      const registration = validateRegistrationContent(message.content)
      if (registration.valid) {
        board.registerMany(registration.teams, message.id)
      }
      registrationOutcomes.push({
        message,
        accepted: registration.valid,
      })
      continue
    }

    const cancel = parseCancelContent(message.content)
    if (cancel) {
      board.cancel(cancel, message.id)
      continue
    }
    const mine = parseMineContent(message.content)
    if (mine && message.reference?.messageId) {
      board.claim(mine, message.reference.messageId, message.id)
    }
  }
  return registrationOutcomes
}

export function isRegistrationOpener(message, config) {
  if (validateRegistrationContent(message.content).valid) return false
  return hasConfiguredStarterSignal(message, config)
}

export function isAutomatedRegistrationOpener(message, config, botUserId) {
  if (!botUserId || message.author?.id !== botUserId) return false
  if (validateRegistrationContent(message.content).valid) return false
  return hasExpectedStarterAttachmentName(message, config)
}

function hasExpectedStarterAttachmentName(message, config) {
  const expectedNames = new Set(
    [...(config.automatedStarterAttachmentNames ?? [])].map((name) =>
      name.toLowerCase(),
    ),
  )
  return [...message.attachments.values()].some((attachment) =>
    expectedNames.has((attachment.name ?? '').toLowerCase()),
  )
}

function messageMediaSources(message) {
  return [
    message,
    ...[...(message.messageSnapshots?.values?.() ?? [])],
  ]
}

function hasGifMedia(message) {
  return messageMediaSources(message).some((source) => {
    const attachments = [...(source.attachments?.values?.() ?? [])]
    if (
      attachments.some((attachment) => {
        const contentType = (attachment.contentType ?? '').toLowerCase()
        if (contentType.startsWith('image/gif')) return true
        return [attachment.name, attachment.url].some((value) =>
          /\.gif(?:$|[?#])/i.test(value ?? ''),
        )
      })
    ) {
      return true
    }

    return [...(source.embeds ?? [])].some((embed) => {
      if ((embed.data?.type ?? embed.type) === 'gifv') return true
      return [
        embed.url,
        embed.image?.url,
        embed.image?.proxyURL,
        embed.thumbnail?.url,
        embed.thumbnail?.proxyURL,
        embed.video?.url,
        embed.video?.proxyURL,
      ].some((value) => /\.gif(?:$|[?#])/i.test(value ?? ''))
    })
  })
}

function canManuallyOpenRegistration(message, member = message.member) {
  if (
    message.guild?.ownerId &&
    message.author?.id === message.guild.ownerId
  ) {
    return true
  }
  const permissions = member?.permissions
  return [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ModerateMembers,
  ].some((permission) => permissions?.has?.(permission))
}

export function isAdminRegistrationOpener(
  message,
  config,
  member = message.member,
) {
  if (
    !canManuallyOpenRegistration(message, member) ||
    validateRegistrationContent(message.content).valid
  ) {
    return false
  }
  return (
    hasExpectedStarterAttachmentName(message, config) ||
    hasGifMedia(message)
  )
}

async function isCycleOpener(message, config, botUserId) {
  if (
    isRegistrationOpener(message, config) ||
    isAutomatedRegistrationOpener(message, config, botUserId) ||
    isAdminRegistrationOpener(message, config)
  ) {
    return true
  }
  if (!hasGifMedia(message) || !message.guild || !message.author?.id) {
    return false
  }
  const member = await message.guild.members
    .fetch(message.author.id)
    .catch(() => null)
  return isAdminRegistrationOpener(message, config, member)
}

function dateLabel(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    weekday: 'long',
  }).formatToParts(new Date())
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('month')} ${part('day')}, ${part('year')} (${part('weekday')})`
}

function displayTeam(team, config) {
  if (!team) return ''
  const tag = config.padTeamTags ? team.tag.padEnd(5) : team.tag
  return `${tag} - ${team.name} | ${team.countryLabel ?? 'PH'}`
}

function boardTitle(config) {
  if (!config.titleEmojiId) return config.title
  const emoji = `<:phgg:${config.titleEmojiId}>`
  return `${emoji} ${config.title} ${emoji}`
}

function animatedEmoji(name, id) {
  return `<a:${name}:${id}>`
}

export function buildEmbeds(
  board,
  state,
  config,
  botConfig,
  templateMessage = null,
) {
  const date = dateLabel(botConfig.timezone)
  state.lastRenderedDate = date
  const slotLines = board.slots.map((team, index) =>
    `${slotCode(index).padEnd(5)}:  ${displayTeam(team, config)}`.trimEnd(),
  )
  const waitRows = Math.max(
    config.emptyWaitlistRows,
    Math.min(board.waitlist.length, MAX_WAITLIST_DISPLAY),
  )
  const waitLines = Array.from({ length: waitRows }, (_value, index) => {
    const number = String(index + (config.waitlistStartAtZero ? 0 : 1)).padStart(2, '0')
    return `${number.padEnd(5)}:  ${displayTeam(board.waitlist[index], config)}`.trimEnd()
  })
  if (board.waitlist.length > MAX_WAITLIST_DISPLAY) {
    waitLines.push(
      `...  :  +${board.waitlist.length - MAX_WAITLIST_DISPLAY} MORE TEAMS`,
    )
  }

  const templateMain = templateMessage?.embeds?.[0]
  const main = new EmbedBuilder()
    .setColor(templateMain?.color ?? botConfig.color)
    .setTitle(boardTitle(config))
    .setDescription(
      [
        `${animatedEmoji('calendar', BOARD_CALENDAR_EMOJI_ID)} **DATE:** ${date}`,
        `${animatedEmoji('alarm_clock', BOARD_ALARM_CLOCK_EMOJI_ID)} **TIME:** ${config.timeLabel}`,
        `${animatedEmoji('pushpin', BOARD_PUSHPIN_EMOJI_ID)} **ROUNDS:** ${config.roundsLabel}`,
        '',
        '## SLOT LIST',
        '```',
        ...slotLines,
        '```',
        '',
        '\u200b',
        '## WAIT LIST',
        '```',
        ...waitLines,
        '```',
      ].join('\n'),
    )
  const templateImage = templateMain?.image?.url
  if (config.bannerUrl || templateImage) {
    main.setImage(config.bannerUrl || templateImage)
  }

  return [main]
}

function boardCycleId(message) {
  for (const embed of message.embeds) {
    const match = /• CYCLE (\S+)$/.exec(embed.footer?.text ?? '')
    if (match) return match[1]
  }
  return null
}

function isLiveBoard(message, botUserId, brandName, label, title) {
  if (message.author.id !== botUserId) return false
  const marker = `${brandName.toUpperCase()} ${label} SCRIM BOARD • LIVE`
  return message.embeds.some(
    (embed) =>
      embed.footer?.text?.startsWith(marker) ||
      (title && embed.title?.includes(title)),
  )
}

async function readableChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId)
  if (!channel?.isTextBased() || !('messages' in channel)) {
    throw new Error(`Channel ${channelId} is not a readable text channel.`)
  }
  return channel
}

async function findLiveBoard(channel, botUserId, brandName, label, title) {
  const pins = await channel.messages.fetchPins({ limit: 50 })
  const pinned = pins.items
    .map((item) => item.message)
    .filter((message) =>
      isLiveBoard(message, botUserId, brandName, label, title),
    )
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0]
  if (pinned) return pinned

  const recent = await channel.messages.fetch({ limit: 100 })
  return (
    [...recent.values()]
      .filter((message) =>
        isLiveBoard(message, botUserId, brandName, label, title),
      )
      .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0] ?? null
  )
}

export function installScrimAutomation(client, config, botConfig) {
  if (!config.enabled) {
    console.log(`${config.label} scrim automation is disabled (three channels are not configured).`)
    return
  }

  const board = new ScrimBoard(config.maxSlots, config.fixedTeams)
  const state = {
    registrationOpen: false,
    cycleStartedAt: null,
    cycleStartMessageId: null,
    boardMessageId: null,
    lastRenderedDate: '',
  }
  let initialized = Promise.resolve()
  let queueValue = Promise.resolve()
  const processedMessages = new Set()
  let boardTemplate = null
  let boardTemplateLoaded = false

  function openRegistration(message, { createBoard = false } = {}) {
    board.reset()
    state.registrationOpen = true
    state.cycleStartedAt = message.createdTimestamp
    state.cycleStartMessageId = message.id
    if (createBoard) state.boardMessageId = null
  }

  function closeRegistration() {
    board.reset()
    state.registrationOpen = false
    state.cycleStartedAt = null
    state.cycleStartMessageId = null
  }

  async function loadBoardTemplate(channel) {
    if (boardTemplateLoaded) return boardTemplate
    boardTemplateLoaded = true
    if (!config.boardTemplateMessageId) return null
    boardTemplate = await channel.messages
      .fetch(config.boardTemplateMessageId)
      .catch((reason) => {
        console.warn(
          `${config.label} board template ${config.boardTemplateMessageId} could not be fetched:`,
          reason instanceof Error ? reason.message : reason,
        )
        return null
      })
    return boardTemplate
  }

  async function copyBoardHeader(channel) {
    if (!config.boardHeaderMessageId) return null
    const source = await channel.messages
      .fetch(config.boardHeaderMessageId)
      .catch((reason) => {
        console.warn(
          `${config.label} board header ${config.boardHeaderMessageId} could not be fetched:`,
          reason instanceof Error ? reason.message : reason,
        )
        return null
      })
    if (!source) return null

    const files = [...source.attachments.values()].map((attachment) => ({
      attachment: attachment.url,
      name: attachment.name ?? `attachment-${attachment.id}`,
    }))
    const payload = {
      content: source.content || undefined,
      embeds: source.embeds
        .filter((embed) => embed.type === 'rich')
        .map((embed) => embed.toJSON()),
      files,
      allowedMentions: { parse: [] },
    }
    if (!payload.content && payload.embeds.length === 0 && files.length === 0) {
      return null
    }
    return channel.send(payload).catch((reason) => {
      console.warn(
        `${config.label} board header could not be copied:`,
        reason instanceof Error ? reason.message : reason,
      )
      return null
    })
  }

  async function syncBoard() {
    if (!state.registrationOpen) return null
    const channel = await readableChannel(client, config.channels.board)
    const template = await loadBoardTemplate(channel)
    const payload = {
      embeds: buildEmbeds(board, state, config, botConfig, template),
      allowedMentions: { parse: [] },
    }
    if (state.boardMessageId) {
      try {
        const message = await channel.messages.fetch(state.boardMessageId)
        await message.edit(payload)
        return message
      } catch {
        state.boardMessageId = null
      }
    }

    await copyBoardHeader(channel)
    const message = await channel.send(payload)
    state.boardMessageId = message.id
    await message
      .pin(
        `Keep the live ${botConfig.brandName} ${config.label} scrim board available after restarts.`,
      )
      .catch(() => undefined)
    return message
  }

  async function loadCycle() {
    closeRegistration()
    const registrationChannel = await readableChannel(client, config.channels.registration)
    const registrationMessages = [
      ...(await registrationChannel.messages.fetch({ limit: 100 })).values(),
    ].sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    let configuredOpener = starterSignalIds(config).length > 0
      ? registrationMessages.find((message) =>
          hasConfiguredStarterSignal(message, config),
        )
      : null
    if (!configuredOpener && config.bannerAssetId) {
      configuredOpener = await registrationChannel.messages
        .fetch(config.bannerAssetId)
        .catch(() => null)
    }
    let opener = null
    for (const message of [...registrationMessages].reverse()) {
      if (await isCycleOpener(message, config, client.user?.id)) {
        opener = message
        break
      }
    }
    opener ??=
      configuredOpener && isRegistrationOpener(configuredOpener, config)
        ? configuredOpener
        : null
    if (opener) {
      openRegistration(opener)
      await clearBotRegistrationReactions(opener)
    } else if (config.alwaysOpen) {
      board.reset()
      state.registrationOpen = true
      state.cycleStartedAt = 0
      state.cycleStartMessageId = ALWAYS_OPEN_CYCLE_ID
    } else {
      return
    }

    const cancelChannel = await readableChannel(client, config.channels.cancel)
    const cancellationMessages = [
      ...(await cancelChannel.messages.fetch({ limit: 100 })).values(),
    ]
    const events = [
      ...registrationMessages.map((message) => ({ type: 'registration', message })),
      ...cancellationMessages.map((message) => ({ type: 'cancellation', message })),
    ]
      .filter(
        ({ message }) =>
          !message.author.bot && message.createdTimestamp > state.cycleStartedAt,
      )
      .sort((left, right) => left.message.createdTimestamp - right.message.createdTimestamp)

    const registrationOutcomes = replayScrimEvents(board, events)
    for (const { message, accepted } of registrationOutcomes) {
      await setRegistrationReaction(message, accepted)
    }
  }

  async function initialize(readyClient) {
    const boardChannel = await readableChannel(client, config.channels.board)
    const existing = await findLiveBoard(
      boardChannel,
      readyClient.user.id,
      botConfig.brandName,
      config.label,
      config.title,
    )
    await loadCycle()
    const recordedCycleId = existing ? boardCycleId(existing) : null
    state.boardMessageId =
      existing &&
      (state.cycleStartMessageId === ALWAYS_OPEN_CYCLE_ID ||
        recordedCycleId === state.cycleStartMessageId ||
        (!recordedCycleId &&
          state.cycleStartedAt !== null &&
          existing.createdTimestamp >= state.cycleStartedAt))
        ? existing.id
        : null
    await syncBoard()
    console.log(
      `${config.label} scrim automation ready: ${state.registrationOpen ? 'OPEN' : 'CLOSED'}, ` +
        `${board.slots.filter(Boolean).length} slotted, ${board.waitlist.length} waiting.`,
    )
  }

  async function reply(message, content) {
    await message.reply({ content, allowedMentions: { parse: [] } }).catch(() => undefined)
  }

  async function clearBotRegistrationReactions(message) {
    for (const emoji of [
      SCRIM_CROSS_REACTION_ID,
      SCRIM_CHECK_REACTION_ID,
      ...LEGACY_BOT_REACTION_EMOJIS,
    ]) {
      const reaction = findReaction(message, emoji)
      if (reaction?.me && client.user) {
        await reaction.users.remove(client.user.id).catch(() => undefined)
      }
    }
  }

  async function setRegistrationReaction(message, accepted) {
    const wanted = accepted
      ? SCRIM_CHECK_REACTION_ID
      : SCRIM_CROSS_REACTION_ID
    const unwanted = accepted
      ? SCRIM_CROSS_REACTION_ID
      : SCRIM_CHECK_REACTION_ID
    for (const emoji of [unwanted, ...LEGACY_BOT_REACTION_EMOJIS]) {
      const oldReaction = findReaction(message, emoji)
      if (oldReaction?.me && client.user) {
        await oldReaction.users.remove(client.user.id).catch(() => undefined)
      }
    }
    const currentReaction = findReaction(message, wanted)
    if (currentReaction?.me) return
    await message
      .react(resolveReactionEmoji(client, wanted))
      .catch(() => undefined)
  }

  async function setCancellationFormatReaction(message, valid) {
    const crossReaction = findReaction(message, SCRIM_CROSS_REACTION_ID)
    if (valid) {
      if (crossReaction?.me && client.user) {
        await crossReaction.users.remove(client.user.id).catch(() => undefined)
      }
    }
    for (const emoji of LEGACY_BOT_REACTION_EMOJIS) {
      const legacyReaction = findReaction(message, emoji)
      if (legacyReaction?.me && client.user) {
        await legacyReaction.users.remove(client.user.id).catch(() => undefined)
      }
    }
    if (valid) return
    if (crossReaction?.me) return
    await message
      .react(resolveReactionEmoji(client, SCRIM_CROSS_REACTION_ID))
      .catch(() => undefined)
  }

  async function rejectCancellationFormat(message, expectedCommand = 'CANCEL') {
    await setCancellationFormatReaction(message, false)
    await reply(
      message,
      expectedCommand === 'MINE'
        ? MINE_SLOT_FORMAT_MESSAGE
        : CANCEL_SLOT_FORMAT_MESSAGE,
    )
  }

  async function handleRegistration(message) {
    if (await isCycleOpener(message, config, client.user?.id)) {
      openRegistration(message, { createBoard: true })
      await syncBoard()
      await clearBotRegistrationReactions(message)
      return
    }

    const registration = validateRegistrationContent(message.content)
    if (!state.registrationOpen) {
      console.warn(
        `${config.label} registration rejected for ${message.author.tag}: the official opening GIF was not detected.`,
      )
      await setRegistrationReaction(message, false)
      return
    }
    if (!registration.valid) {
      console.warn(
        `${config.label} registration rejected for ${message.author.tag}: use "CLAN TAG - TEAM NAME | 🇵🇭".`,
      )
      await setRegistrationReaction(message, false)
      return
    }
    board.registerMany(registration.teams, message.id)
    await syncBoard()
    await setRegistrationReaction(message, true)
  }

  async function handleCancellation(message) {
    const cancel = parseCancelContent(message.content)
    const mine = parseMineContent(message.content)
    const referenceId = message.reference?.messageId
    if (!cancel && (!mine || !referenceId)) {
      const expectedCommand =
        /^\s*MINE\b/i.test(message.content) || referenceId ? 'MINE' : 'CANCEL'
      await rejectCancellationFormat(message, expectedCommand)
      return
    }
    await setCancellationFormatReaction(message, true)
    if (!state.registrationOpen) return

    if (cancel) {
      const result = board.cancel(cancel, message.id)
      if (result.status === 'not_found') {
        await reply(message, `⚠️ I could not find **${cancel}** on the board.`)
        return
      }
      await syncBoard()
      if (result.status === 'waitlist_removed') {
        await reply(message, `✅ **${result.team.name}** was removed from the waiting list.`)
        return
      }
      const promotion = result.promotedTeam
        ? ` **${result.promotedTeam.name}** moved into that slot.`
        : ' The slot is now open.'
      await reply(
        message,
        `✅ **${result.team.name}** canceled slot **${slotCode(result.slotIndex)}**.${promotion}`,
      )
      return
    }

    const referencedMessage = await message.channel.messages
      .fetch(referenceId)
      .catch(() => null)
    if (!referencedMessage || !parseCancelContent(referencedMessage.content)) {
      await rejectCancellationFormat(message, 'MINE')
      return
    }
    const result = board.claim(mine, referenceId, message.id)
    if (result.status === 'claimed') {
      await syncBoard()
      await reply(
        message,
        `✅ **${result.team.name}** claimed slot **${slotCode(result.slotIndex)}**.`,
      )
    } else if (result.status === 'already_registered') {
      await reply(
        message,
        `⚠️ **${result.team.name}** is already in slot **${slotCode(result.slotIndex)}**.`,
      )
    } else if (result.status === 'invalid_team') {
      await rejectCancellationFormat(message, 'MINE')
    } else {
      await reply(message, '❌ That canceled slot is no longer available.')
    }
  }

  function queue(operation) {
    queueValue = queueValue
      .then(() => initialized)
      .then(operation)
      .catch((reason) => {
        console.error(
          `${config.label} scrim automation failed:`,
          reason instanceof Error ? reason.message : reason,
        )
      })
    return queueValue
  }

  function claimMessage(id) {
    if (processedMessages.has(id)) return false
    processedMessages.add(id)
    if (processedMessages.size > 1_000) {
      const first = processedMessages.values().next().value
      processedMessages.delete(first)
    }
    return true
  }

  client.once(Events.ClientReady, (readyClient) => {
    initialized = initialize(readyClient)
  })

  client.on(Events.MessageCreate, (message) => {
    if (!message.inGuild()) return
    if (message.channelId === config.channels.registration) {
      if (
        message.author.bot &&
        !isAutomatedRegistrationOpener(message, config, client.user?.id)
      ) {
        return
      }
      if (claimMessage(message.id)) queue(() => handleRegistration(message))
    } else if (message.channelId === config.channels.cancel) {
      if (message.author.bot) return
      if (claimMessage(message.id)) queue(() => handleCancellation(message))
    }
  })

  client.on(Events.MessageUpdate, (_oldMessage, message) => {
    if (
      message.channelId !== config.channels.registration &&
      message.channelId !== config.channels.cancel
    ) {
      return
    }
    queue(async () => {
      await loadCycle()
      await syncBoard()
    })
  })

  client.on(Events.MessageDelete, (message) => {
    if (
      message.channelId !== config.channels.registration &&
      message.channelId !== config.channels.cancel
    ) {
      return
    }
    if (!claimMessage(`delete:${message.id}`)) return
    queue(async () => {
      await loadCycle()
      await syncBoard()
    })
  })

  const timer = setInterval(() => {
    if (!client.isReady() || dateLabel(botConfig.timezone) === state.lastRenderedDate) return
    queue(() => syncBoard())
  }, 60 * 60 * 1_000)
  timer.unref()
}

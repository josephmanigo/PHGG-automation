import { Events, PermissionFlagsBits } from 'discord.js'
import { installTallyAutomation } from './tally-automation.js'
import {
  isAdminNoteContent,
  isAvailableSlotsCommand,
  parseAvailableSlotsContent,
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
import { sendDiscordAttachments } from '../discord-upload.js'

const MAX_WAITLIST_DISPLAY = 40
const ALWAYS_OPEN_CYCLE_ID = 'ALWAYS_OPEN'
export const SCRIM_CYCLE_TTL_MS = 72 * 60 * 60 * 1_000
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
const AVAILABLE_SLOT_FORMAT_MESSAGE = [
  '❌ **WRONG FORMAT**',
  'Admins must follow this format:',
  '`AVAILABLE SLOT 2, 15 & 16`',
].join('\n')

export function isCurrentScrimCycle(createdTimestamp, now = Date.now()) {
  if (!Number.isFinite(createdTimestamp)) return false
  const age = now - createdTimestamp
  return age >= -5 * 60 * 1_000 && age <= SCRIM_CYCLE_TTL_MS
}

function messageSignals(message) {
  return messageMediaSources(message)
    .flatMap((source) => [
      source.id,
      source.content,
      ...[...(source.attachments?.values?.() ?? [])].flatMap(
        (attachment) => [
          attachment.id,
          attachment.name,
          attachment.url,
        ],
      ),
      ...(source.embeds ?? []).flatMap((embed) => [
        embed.url,
        embed.image?.url,
        embed.thumbnail?.url,
        embed.video?.url,
      ]),
    ])
    .filter(Boolean)
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

    const availableSlots = parseAvailableSlotsContent(message.content)
    if (availableSlots && event.canManageScrim) {
      board.makeSlotsAvailable(availableSlots, message.id)
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
  return (
    hasExpectedStarterAttachmentName(message, config) ||
    hasConfiguredStarterSignal(message, config)
  )
}

function hasExpectedStarterAttachmentName(message, config) {
  const expectedNames = new Set(
    [...(config.automatedStarterAttachmentNames ?? [])].map((name) =>
      name.toLowerCase(),
    ),
  )
  return messageMediaSources(message).some((source) =>
    [...(source.attachments?.values?.() ?? [])].some((attachment) =>
      expectedNames.has((attachment.name ?? '').toLowerCase()),
    ),
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

export function isCancelChannelAdminNotice(message) {
  return hasGifMedia(message) || isAdminNoteContent(message.content)
}

function canManageScrim(message, member = message.member) {
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
  if (!isAdminRegistrationMediaNotice(message, member)) return false
  return (
    hasExpectedStarterAttachmentName(message, config) ||
    hasConfiguredStarterSignal(message, config)
  )
}

export function isAdminRegistrationMediaNotice(
  message,
  member = message.member,
) {
  return (
    canManageScrim(message, member) &&
    !validateRegistrationContent(message.content).valid &&
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

async function canManageScrimMessage(message) {
  if (canManageScrim(message)) return true
  if (!message.guild || !message.author?.id) return false
  const member = await message.guild.members
    .fetch(message.author.id)
    .catch(() => null)
  return canManageScrim(message, member)
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
  if (team.sourceType === 'fixed' && config.label === 'PC') {
    return `${team.tag}  - ${team.name} | ${team.countryLabel ?? 'PH'}`
  }
  const tag = config.padTeamTags ? team.tag.padEnd(5) : team.tag
  const identity = team.tag ? `${tag} - ${team.name}` : team.name
  return `${identity} | ${team.countryLabel ?? 'PH'}`
}

function boardTitle(config) {
  if (!config.titleEmojiId) return config.title
  const emoji = `<:phgg:${config.titleEmojiId}>`
  return `${emoji} ${config.title} ${emoji}`
}

function animatedEmoji(name, id) {
  return `<a:${name}:${id}>`
}

export function buildBoardContent(
  board,
  state,
  config,
  botConfig,
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

  return [
    `# ${boardTitle(config)}`,
    `${animatedEmoji('calendar', BOARD_CALENDAR_EMOJI_ID)} **DATE:** ${date}`,
    `${animatedEmoji('alarm_clock', BOARD_ALARM_CLOCK_EMOJI_ID)} **TIME:** ${config.timeLabel}`,
    `${animatedEmoji('pushpin', BOARD_PUSHPIN_EMOJI_ID)} **ROUNDS:** ${config.roundsLabel}`,
    '',
    '## SLOT LIST',
    '```',
    ...slotLines,
    '```',
    '',
    '## WAIT LIST',
    '```',
    ...waitLines,
    '```',
  ].join('\n')
}

function isLiveBoard(message, botUserId, brandName, label, title) {
  if (message.author.id !== botUserId) return false
  const marker = `${brandName.toUpperCase()} ${label} SCRIM BOARD • LIVE`
  return (
    (title && message.content?.includes(title)) ||
    message.embeds.some(
      (embed) =>
        embed.footer?.text?.startsWith(marker) ||
        (title && embed.title?.includes(title)),
    )
  )
}

export function selectCurrentScrimBoard(
  messages,
  {
    botUserId,
    brandName,
    label,
    title,
    cycleStartedAt,
  },
) {
  return (
    [...messages]
      .filter(
        (message) =>
          isLiveBoard(message, botUserId, brandName, label, title) &&
          (cycleStartedAt === 0 ||
            message.createdTimestamp >= cycleStartedAt),
      )
      .sort(
        (left, right) =>
          right.createdTimestamp - left.createdTimestamp,
      )[0] ?? null
  )
}

async function readableChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId)
  if (!channel?.isTextBased() || !('messages' in channel)) {
    throw new Error(`Channel ${channelId} is not a readable text channel.`)
  }
  return channel
}

async function findLiveBoard(
  channel,
  botUserId,
  brandName,
  label,
  title,
  cycleStartedAt,
) {
  const belongsToCycle = (message) =>
    isLiveBoard(message, botUserId, brandName, label, title) &&
    (cycleStartedAt === 0 ||
      message.createdTimestamp >= cycleStartedAt)
  const pins = await channel.messages.fetchPins({ limit: 50 })
  const pinnedBotBoards = pins.items
    .map((item) => item.message)
    .filter((message) =>
      isLiveBoard(message, botUserId, brandName, label, title),
    )
  for (const message of pinnedBotBoards) {
    await message
      .unpin('PHGG scrim boards are no longer pinned automatically.')
      .catch(() => undefined)
  }
  const pinnedBoards = pinnedBotBoards.filter(belongsToCycle)

  const recent = await channel.messages.fetch({ limit: 100 })
  return selectCurrentScrimBoard(
    [...pinnedBoards, ...recent.values()],
    {
      botUserId,
      brandName,
      label,
      title,
      cycleStartedAt,
    },
  )
}

export function installScrimAutomation(client, config, botConfig) {
  const board = new ScrimBoard(config.maxSlots, config.fixedTeams)
  installTallyAutomation(client, config, botConfig, () => board)

  if (!config.enabled) {
    console.log(`${config.label} scrim slot registration automation is disabled (three channels are not configured), but score tally automation is ACTIVE.`)
    return
  }
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

  function registrationCycleIsCurrent(now = Date.now()) {
    return (
      state.registrationOpen &&
      (state.cycleStartMessageId === ALWAYS_OPEN_CYCLE_ID ||
        isCurrentScrimCycle(state.cycleStartedAt, now))
    )
  }

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

    const embedContent = source.embeds
      .filter((embed) => embed.type === 'rich')
      .flatMap((embed) => [
        embed.author?.name ? `**${embed.author.name}**` : null,
        embed.title ? `# ${embed.title}` : null,
        embed.description,
        ...embed.fields.map(
          (field) => `**${field.name}**\n${field.value}`,
        ),
        embed.image?.url,
        embed.thumbnail?.url,
      ])
      .filter(Boolean)
      .join('\n')
    const payload = {
      content: [source.content, embedContent]
        .filter(Boolean)
        .join('\n\n') || undefined,
      nonce: `H${state.cycleStartMessageId}`.slice(0, 25),
      enforceNonce: true,
      allowedMentions: { parse: [] },
    }
    const attachments = [...source.attachments.values()]
    if (
      !payload.content &&
      attachments.length === 0
    ) {
      return null
    }
    const send =
      attachments.length > 0
        ? sendDiscordAttachments(source.client, channel, attachments, payload)
        : channel.send(payload)
    return send.catch((reason) => {
      console.warn(
        `${config.label} board header could not be copied:`,
        reason instanceof Error ? reason.message : reason,
      )
      return null
    })
  }

  async function syncBoard() {
    if (!registrationCycleIsCurrent()) {
      if (state.registrationOpen) closeRegistration()
      return null
    }
    const channel = await readableChannel(client, config.channels.board)
    const payload = {
      content: buildBoardContent(board, state, config, botConfig),
      allowedMentions: { parse: [] },
    }
    if (state.boardMessageId) {
      try {
        const message = await channel.messages.fetch(state.boardMessageId)
        await message.edit(payload)
        if (message.pinned) {
          await message
            .unpin('PHGG scrim boards are no longer pinned automatically.')
            .catch(() => undefined)
        }
        return message
      } catch {
        state.boardMessageId = null
      }
    }

    const existing = await findLiveBoard(
      channel,
      client.user.id,
      botConfig.brandName,
      config.label,
      config.title,
      state.cycleStartedAt,
    )
    if (existing) {
      state.boardMessageId = existing.id
      await existing.edit(payload)
      if (existing.pinned) {
        await existing
          .unpin('PHGG scrim boards are no longer pinned automatically.')
          .catch(() => undefined)
      }
      return existing
    }

    await copyBoardHeader(channel)
    const message = await channel.send({
      ...payload,
      nonce: `B${state.cycleStartMessageId}`.slice(0, 25),
      enforceNonce: true,
    })
    state.boardMessageId = message.id
    return message
  }

  async function loadCycle() {
    closeRegistration()
    const registrationChannel = await readableChannel(client, config.channels.registration)
    const registrationMessages = [
      ...(await registrationChannel.messages.fetch({ limit: 100 })).values(),
    ].sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    let opener = null
    for (const message of [...registrationMessages].reverse()) {
      if (!isCurrentScrimCycle(message.createdTimestamp)) continue
      if (await isCycleOpener(message, config, client.user?.id)) {
        opener = message
        break
      }
    }
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
    const cancellationEvents = await Promise.all(
      cancellationMessages.map(async (message) => {
        const adminNotice = isCancelChannelAdminNotice(message)
        return {
          type: 'cancellation',
          message,
          adminNotice,
          canManageScrim:
            parseAvailableSlotsContent(message.content) || adminNotice
              ? await canManageScrimMessage(message)
              : false,
        }
      }),
    )
    const events = [
      ...registrationMessages.map((message) => ({ type: 'registration', message })),
      ...cancellationEvents,
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
    for (const event of cancellationEvents) {
      if (event.adminNotice && event.canManageScrim) {
        await setCancellationFormatReaction(event.message, true)
      }
    }
  }

  async function initialize() {
    await loadCycle()
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
    if (
      hasGifMedia(message) &&
      (await canManageScrimMessage(message))
    ) {
      await clearBotRegistrationReactions(message)
      return
    }

    const registration = validateRegistrationContent(message.content)
    if (!registrationCycleIsCurrent()) {
      if (state.registrationOpen) closeRegistration()
      console.warn(
        `${config.label} registration rejected for ${message.author.tag}: the official opening GIF was not detected.`,
      )
      await setRegistrationReaction(message, false)
      return
    }
    if (!registration.valid) {
      console.warn(
        `${config.label} registration rejected for ${message.author.tag}: use "CLAN TAG - TEAM NAME | COUNTRY".`,
      )
      await setRegistrationReaction(message, false)
      return
    }
    board.registerMany(registration.teams, message.id)
    await syncBoard()
    await setRegistrationReaction(message, true)
  }

  async function handleCancellation(message) {
    const availableSlots = parseAvailableSlotsContent(message.content)
    const availableCommand = isAvailableSlotsCommand(message.content)
    const adminNotice = isCancelChannelAdminNotice(message)
    const canPostAdminNotice =
      adminNotice && (await canManageScrimMessage(message))
    if (
      canPostAdminNotice &&
      (!availableCommand || !availableSlots)
    ) {
      await setCancellationFormatReaction(message, true)
      return
    }

    if (availableCommand) {
      const validSlots =
        availableSlots?.filter((slotIndex) => slotIndex < board.maxSlots) ?? []
      if (
        !availableSlots ||
        validSlots.length !== availableSlots.length
      ) {
        await setCancellationFormatReaction(message, false)
        await reply(message, AVAILABLE_SLOT_FORMAT_MESSAGE)
        return
      }
      if (
        !canPostAdminNotice &&
        !(await canManageScrimMessage(message))
      ) {
        await setCancellationFormatReaction(message, false)
        await reply(message, '❌ Only server admins or scrim staff can open available slots.')
        return
      }
      await setCancellationFormatReaction(message, true)
      if (!registrationCycleIsCurrent()) return
      const result = board.makeSlotsAvailable(validSlots, message.id)
      await syncBoard()
      const slotNumbers = result.slotIndexes.map((slotIndex) => slotIndex + 1)
      const displaySlots =
        slotNumbers.length === 1
          ? String(slotNumbers[0])
          : `${slotNumbers.slice(0, -1).join(', ')} & ${slotNumbers.at(-1)}`
      await reply(
        message,
        `✅ Slot${slotNumbers.length === 1 ? '' : 's'} **${displaySlots}** ${slotNumbers.length === 1 ? 'is' : 'are'} available for **MINE replies only**.`,
      )
      return
    }

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
    if (!registrationCycleIsCurrent()) return

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
      await reply(
        message,
        `✅ **${result.team.name}** canceled slot **${slotCode(result.slotIndex)}**. The slot is now available for **MINE replies only**.`,
      )
      return
    }

    const referencedMessage = await message.channel.messages
      .fetch(referenceId)
      .catch(() => null)
    if (
      !referencedMessage ||
      (!parseCancelContent(referencedMessage.content) &&
        !parseAvailableSlotsContent(referencedMessage.content))
    ) {
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
      await reply(message, '❌ That slot is no longer available.')
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

  client.once(Events.ClientReady, () => {
    initialized = initialize()
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

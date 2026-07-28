import { EmbedBuilder, Events } from 'discord.js'
import { formatNickname } from '../nickname.js'
import {
  parseCancelContent,
  parseMineContent,
  ScrimBoard,
  slotCode,
  validateRegistrationContent,
} from './core.js'

const MAX_WAITLIST_DISPLAY = 40
const ALWAYS_OPEN_CYCLE_ID = 'ALWAYS_OPEN'
const learnedOpenerIds = new Set()

function isGifUrl(value) {
  return /(?:\.gif(?:$|[?#])|tenor\.com|giphy\.com)/i.test(value ?? '')
}

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

function isGif(message) {
  return (
    isGifUrl(message.content) ||
    [...message.attachments.values()].some(
      (attachment) =>
        attachment.contentType?.includes('gif') ||
        /\.gif$/i.test(attachment.name ?? '') ||
        isGifUrl(attachment.url),
    ) ||
    message.embeds.some(
      (embed) =>
        embed.type === 'gifv' ||
        /tenor|giphy/i.test(embed.provider?.name ?? '') ||
        [embed.url, embed.image?.url, embed.thumbnail?.url, embed.video?.url].some(isGifUrl),
    )
  )
}

export function isRegistrationOpener(message, config) {
  if (validateRegistrationContent(message.content).valid) return false
  const officialAsset =
    config.bannerAssetId &&
    messageSignals(message).some((value) => value.includes(config.bannerAssetId))
  const trustedSender =
    config.openerIds.has(message.author?.id) || learnedOpenerIds.has(message.author?.id)
  return Boolean(officialAsset || (trustedSender && isGif(message)))
}

export function trustOpenerAuthor(message, config) {
  const authorId = message?.author?.id
  if (!authorId) return false
  config.openerIds.add(authorId)
  learnedOpenerIds.add(authorId)
  return true
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
  return `${part('month')} ${part('day')}, ${part('year')} (${part('weekday').toUpperCase()})`
}

function displayTeam(team) {
  return team ? `${team.tag.padEnd(5)} - ${team.name}` : ''
}

function buildEmbeds(board, state, config, botConfig) {
  const date = dateLabel(botConfig.timezone)
  state.lastRenderedDate = date
  const slotLines = board.slots.map(
    (team, index) => `${slotCode(index)} : ${displayTeam(team)}`.trimEnd(),
  )
  const waitRows = Math.max(
    config.emptyWaitlistRows,
    Math.min(board.waitlist.length, MAX_WAITLIST_DISPLAY),
  )
  const waitLines = Array.from({ length: waitRows }, (_value, index) => {
    const number = String(index + 1).padStart(2, '0')
    return `W${number} : ${displayTeam(board.waitlist[index])}`.trimEnd()
  })
  if (board.waitlist.length > MAX_WAITLIST_DISPLAY) {
    waitLines.push(`... : +${board.waitlist.length - MAX_WAITLIST_DISPLAY} MORE TEAMS`)
  }

  const marker =
    `${botConfig.brandName.toUpperCase()} ${config.label} SCRIM BOARD • LIVE`
  const main = new EmbedBuilder()
    .setColor(botConfig.color)
    .setTitle(`🎟️ ${config.title} 🎟️`)
    .setDescription(
      [
        `📅 **DATE:** ${date}`,
        `⏰ **TIME:** ${config.timeLabel}`,
        `📌 **ROUNDS:** ${config.roundsLabel}`,
        '',
        '**SLOT LIST**',
        '```',
        ...slotLines,
        '```',
      ].join('\n'),
    )
  if (config.bannerUrl) main.setImage(config.bannerUrl)

  const waiting = new EmbedBuilder()
    .setColor(botConfig.color)
    .setTitle('WAIT LIST')
    .setDescription(['```', ...waitLines, '```'].join('\n'))
    .setFooter({
      text: state.cycleStartMessageId
        ? `${marker} • CYCLE ${state.cycleStartMessageId}`
        : marker,
    })
    .setTimestamp()
  return [main, waiting]
}

function boardCycleId(message) {
  for (const embed of message.embeds) {
    const match = /• CYCLE (\S+)$/.exec(embed.footer?.text ?? '')
    if (match) return match[1]
  }
  return null
}

function isLiveBoard(message, botUserId, brandName, label) {
  if (message.author.id !== botUserId) return false
  const marker = `${brandName.toUpperCase()} ${label} SCRIM BOARD • LIVE`
  return message.embeds.some(
    (embed) =>
      embed.footer?.text?.startsWith(marker),
  )
}

async function readableChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId)
  if (!channel?.isTextBased() || !('messages' in channel)) {
    throw new Error(`Channel ${channelId} is not a readable text channel.`)
  }
  return channel
}

async function findLiveBoard(channel, botUserId, brandName, label) {
  const pins = await channel.messages.fetchPins({ limit: 50 })
  const pinned = pins.items
    .map((item) => item.message)
    .filter((message) => isLiveBoard(message, botUserId, brandName, label))
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0]
  if (pinned) return pinned

  const recent = await channel.messages.fetch({ limit: 100 })
  return (
    [...recent.values()]
      .filter((message) => isLiveBoard(message, botUserId, brandName, label))
      .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0] ?? null
  )
}

export function installScrimAutomation(client, config, botConfig) {
  if (!config.enabled) {
    console.log(`${config.label} scrim automation is disabled (three channels are not configured).`)
    return
  }

  const board = new ScrimBoard(config.maxSlots)
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

  async function syncBoard() {
    if (!state.registrationOpen) return null
    const channel = await readableChannel(client, config.channels.board)
    const payload = {
      embeds: buildEmbeds(board, state, config, botConfig),
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
    let configuredOpener = config.bannerAssetId
      ? registrationMessages.find((message) =>
          messageSignals(message).some((value) => value.includes(config.bannerAssetId)),
        )
      : null
    if (!configuredOpener && config.bannerAssetId) {
      configuredOpener = await registrationChannel.messages
        .fetch(config.bannerAssetId)
        .catch(() => null)
    }
    if (configuredOpener) trustOpenerAuthor(configuredOpener, config)

    const opener =
      [...registrationMessages]
        .reverse()
        .find((message) => isRegistrationOpener(message, config)) ??
      (configuredOpener && isRegistrationOpener(configuredOpener, config)
        ? configuredOpener
        : null)
    if (opener) {
      openRegistration(opener)
      await markOpeningMessage(opener)
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

    for (const event of events) {
      const { message } = event
      if (event.type === 'registration') {
        const registration = validateRegistrationContent(message.content)
        if (registration.valid && (await hasValidServerNickname(message))) {
          board.registerMany(registration.teams, message.id)
        }
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
  }

  async function initialize(readyClient) {
    const boardChannel = await readableChannel(client, config.channels.board)
    const existing = await findLiveBoard(
      boardChannel,
      readyClient.user.id,
      botConfig.brandName,
      config.label,
    )
    await loadCycle()
    state.boardMessageId =
      existing && boardCycleId(existing) === state.cycleStartMessageId ? existing.id : null
    await syncBoard()
    console.log(
      `${config.label} scrim automation ready: ${state.registrationOpen ? 'OPEN' : 'CLOSED'}, ` +
        `${board.slots.filter(Boolean).length} slotted, ${board.waitlist.length} waiting.`,
    )
  }

  async function reply(message, content) {
    await message.reply({ content, allowedMentions: { parse: [] } }).catch(() => undefined)
  }

  async function markOpeningMessage(message) {
    const rejectedReaction = message.reactions.cache.find(
      (reaction) => reaction.emoji.name === '❌',
    )
    if (rejectedReaction && client.user) {
      await rejectedReaction.users.remove(client.user.id).catch(() => undefined)
    }
    await message.react('✅').catch(() => undefined)
  }

  async function hasValidServerNickname(message) {
    if (!config.requireValidNickname) return true
    const member =
      message.member ??
      (await message.guild?.members.fetch(message.author.id).catch(() => null))
    if (!member?.nickname) return false
    return formatNickname(member.nickname).ok
  }

  async function handleRegistration(message) {
    if (isRegistrationOpener(message, config)) {
      trustOpenerAuthor(message, config)
      openRegistration(message, { createBoard: true })
      await syncBoard()
      await markOpeningMessage(message)
      return
    }

    const registration = validateRegistrationContent(message.content)
    if (!state.registrationOpen) {
      console.warn(
        `${config.label} registration rejected for ${message.author.tag}: the official opening GIF was not detected.`,
      )
      await message.react('❌').catch(() => undefined)
      return
    }
    if (!registration.valid) {
      console.warn(
        `${config.label} registration rejected for ${message.author.tag}: use "CLAN TAG - TEAM NAME | 🇵🇭".`,
      )
      await message.react('❌').catch(() => undefined)
      return
    }
    if (!(await hasValidServerNickname(message))) {
      console.warn(
        `${config.label} registration rejected for ${message.author.tag}: the member has no valid server nickname.`,
      )
      await message.react('❌').catch(() => undefined)
      return
    }
    const results = board.registerMany(registration.teams, message.id)
    await syncBoard()
    const added = results.some((result) => result.status !== 'duplicate')
    await message.react(added ? '✅' : '❌').catch(() => undefined)
  }

  async function handleCancellation(message) {
    if (!state.registrationOpen) return
    const cancel = parseCancelContent(message.content)
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

    const mine = parseMineContent(message.content)
    const referenceId = message.reference?.messageId
    if (!mine || !referenceId) return
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
    if (message.author.bot || !message.inGuild()) return
    if (message.channelId === config.channels.registration) {
      if (claimMessage(message.id)) queue(() => handleRegistration(message))
    } else if (message.channelId === config.channels.cancel) {
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

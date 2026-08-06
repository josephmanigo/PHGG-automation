import { Events, MessageFlags } from 'discord.js'
import { sendDiscordAttachments } from './discord-upload.js'

const TEST_COMMAND_NAME = 'test'
const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]
const WEEKDAYS = new Set(WEEKDAY_NAMES)
const DISCORD_ATTACHMENT_URL =
  /https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/[^\s]+/gi
const ANNOUNCEMENT_DETAIL_EMOJIS = [
  ['DATE', '\u{1F4C5}'],
  ['TIME', '\u{23F0}'],
  ['ROUNDS', '\u{1F4CC}'],
  ['IMPORTANT', '\u{1F4CC}'],
]
const LEADING_DETAIL_EMOJI =
  /^([\t ]*(?:>\s*)?)(?:(?:<a?:[^>\r\n]+>|:[A-Z0-9_]+:|\p{Extended_Pictographic}\uFE0F?)[\t ]*)?/iu
const PC_REGISTRATION_CHANNEL_ID = '1340963116954947635'
const PHGG_LOGO_EMOJI =
  '<:PHGAMINGGUILDNEWLOGO1:1337103312989716592>'

function timeParts(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!match) throw new Error('ANNOUNCEMENT_TIME must use 24-hour HH:MM format.')
  return { hour: match[1], minute: match[2] }
}

export function scheduledRunKey(date, { timezone, weekday, time }) {
  if (!WEEKDAYS.has(weekday)) {
    throw new Error('ANNOUNCEMENT_WEEKDAY must be a full English weekday name.')
  }
  const expected = timeParts(time)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  if (
    part('weekday') !== weekday ||
    part('hour') !== expected.hour ||
    part('minute') !== expected.minute
  ) {
    return null
  }
  return `${part('year')}-${part('month')}-${part('day')}`
}

function localDateTime(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  return {
    dateKey: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  }
}

export function nextScheduledRunKey(date, { timezone, weekday }) {
  if (!WEEKDAYS.has(weekday)) {
    throw new Error('ANNOUNCEMENT_WEEKDAY must be a full English weekday name.')
  }
  const local = localDateTime(date, timezone)
  const localWeekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  }).format(date)
  const daysUntilRun =
    (WEEKDAY_NAMES.indexOf(weekday) -
      WEEKDAY_NAMES.indexOf(localWeekday) +
      WEEKDAY_NAMES.length) %
    WEEKDAY_NAMES.length
  const [year, month, day] = local.dateKey.split('-').map(Number)
  const runDate = new Date(Date.UTC(year, month - 1, day + daysUntilRun, 12))
  return runDate.toISOString().slice(0, 10)
}

export function announcementDateLabel(runKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(runKey)
  if (!match) throw new Error(`Invalid announcement run date: ${runKey}.`)
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12),
  )
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    weekday: 'long',
  }).formatToParts(date)
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('month')} ${part('day')}, ${part('year')} (${part('weekday')})`
}

export function replaceAnnouncementDate(value, dateLabel) {
  if (!value) return value
  return value
    .split(/\r?\n/)
    .map((line) => {
      if (!isAnnouncementDetailLine(line, 'DATE')) return line
      const colonIndex = line.lastIndexOf(':')
      if (colonIndex < 0) return line
      const closingBold =
        /^\*{0,2}/.exec(line.slice(colonIndex + 1))?.[0] ?? ''
      return `${line.slice(0, colonIndex + 1)}${closingBold} ${dateLabel}`
    })
    .join('\n')
}

function isAnnouncementDetailLine(line, label) {
  const withoutEmoji = line
    .normalize('NFKC')
    .replace(LEADING_DETAIL_EMOJI, '')
  return new RegExp(`^\\*{0,2}${label}\\b`, 'i').test(withoutEmoji)
}

export function replaceAnnouncementDetailEmojis(value) {
  if (!value) return value
  return value
    .split(/\r?\n/)
    .map((line) => {
      const detail = ANNOUNCEMENT_DETAIL_EMOJIS.find(([label]) =>
        isAnnouncementDetailLine(line, label),
      )
      if (!detail) return line
      const [, emoji] = detail
      return line.replace(LEADING_DETAIL_EMOJI, `$1${emoji} `)
    })
    .join('\n')
}

function announcementText(value, dateLabel = null) {
  const result = replaceAnnouncementDetailEmojis(value)
  return dateLabel ? replaceAnnouncementDate(result, dateLabel) : result
}

export function pcAnnouncementContent(dateLabel) {
  return [
    `# PH GAMING GUILD'S BS PC SCRIMMAGE OPERATION: DOMINATION ${PHGG_LOGO_EMOJI}`,
    '',
    `\u{1F4C5} 𝐃𝐀𝐓𝐄: ${dateLabel}`,
    '\u{23F0} 𝐓𝐈𝐌𝐄: 10:00PM',
    '\u{1F4CC} 𝐑𝐎𝐔𝐍𝐃𝐒: 4 Rounds | 1SB - 1DV - 2SI',
    '',
    '**Registration will start at 12:00 PM PH TIME for today’s scrimmage.**',
    '',
    `Register here: <#${PC_REGISTRATION_CHANNEL_ID}>`,
    '',
    '\u{1F4CC} *Important: Registrations with outdated server nicknames will be voided.*',
    '',
    '||@everyone||',
  ].join('\n')
}

export function announcementAllowsMentions(
  configured,
  formatLabel,
  force,
) {
  return Boolean(configured || (formatLabel === 'PC' && !force))
}

function plainEmbedText(embed, dateLabel = null) {
  const parts = []
  if (embed.author?.name) {
    parts.push(`**${announcementText(embed.author.name, dateLabel)}**`)
  }
  if (embed.title) {
    parts.push(`# ${announcementText(embed.title, dateLabel)}`)
  }
  if (embed.description) {
    parts.push(announcementText(embed.description, dateLabel))
  }
  for (const field of embed.fields ?? []) {
    const value =
      dateLabel && isAnnouncementDetailLine(field.name, 'DATE')
        ? dateLabel
        : announcementText(field.value, dateLabel)
    parts.push(
      `**${announcementText(field.name, dateLabel)}**\n${value}`,
    )
  }
  return parts.map((part) => part?.trim()).filter(Boolean).join('\n')
}

export function announcementMessageSignature(
  message,
  normalizeDate = false,
  formatLabel = null,
) {
  const comparable =
    [...(message.messageSnapshots?.values?.() ?? [])][0] ?? message
  const text = (value) => announcementText(value, normalizeDate ? '<DATE>' : null)
  const linkedMedia = []
  const comparableContent =
    formatLabel === 'PC' && normalizeDate
      ? pcAnnouncementContent('<DATE>')
      : text(comparable.content)
  const flattenedEmbeds =
    formatLabel === 'PC' && normalizeDate
      ? []
      : comparable.embeds.map((embed) =>
          plainEmbedText(embed, normalizeDate ? '<DATE>' : null),
        )
  const content = [comparableContent, ...flattenedEmbeds]
    .filter(Boolean)
    .join('\n\n')
    .replace(DISCORD_ATTACHMENT_URL, (url) => {
      linkedMedia.push(url)
      return ''
    })
    .trim()
  const mediaUrl = (value) => {
    if (!value) return null
    try {
      const url = new URL(value)
      return url.pathname.startsWith('/attachments/')
        ? url.pathname
        : `${url.hostname}${url.pathname}`
    } catch {
      return String(value).split(/[?#]/, 1)[0]
    }
  }
  return JSON.stringify({
    content,
    media: [
      ...new Set(
        [
          ...linkedMedia,
          ...[...comparable.attachments.values()].map(
            (attachment) => attachment.url,
          ),
          ...comparable.embeds.flatMap((embed) => [
            embed.image?.url,
            embed.thumbnail?.url,
            embed.video?.url,
          ]),
        ]
          .map(mediaUrl)
          .filter(Boolean),
      ),
    ],
  })
}

function clonePayload(
  message,
  allowMentions,
  dateLabel = null,
  formatLabel = null,
) {
  const payload = {
    allowedMentions: allowMentions
      ? { parse: ['everyone', 'roles', 'users'], repliedUser: false }
      : { parse: [], repliedUser: false },
  }
  const contentParts =
    formatLabel === 'PC' && dateLabel
      ? [pcAnnouncementContent(dateLabel)]
      : [
          announcementText(message.content, dateLabel),
          ...message.embeds
            .slice(0, 10)
            .map((embed) => plainEmbedText(embed, dateLabel)),
        ]
  payload.content = contentParts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n\n')
  if (payload.content.length > 2_000) {
    throw new Error(
      `Source message ${message.id} is longer than Discord's 2,000-character plain-message limit.`,
    )
  }
  if (message.stickers.size > 0) payload.stickers = [...message.stickers.keys()].slice(0, 3)
  if (
    !payload.content &&
    !payload.stickers &&
    message.attachments.size === 0
  ) {
    throw new Error(`Source message ${message.id} has no content that can be reposted.`)
  }
  return payload
}

async function publishMessage(
  channel,
  source,
  allowMentions,
  dateLabel = null,
  formatLabel = null,
) {
  const payload = clonePayload(
    source,
    allowMentions,
    dateLabel,
    formatLabel,
  )
  const attachments = [...source.attachments.values()]
  return attachments.length > 0
    ? sendDiscordAttachments(source.client, channel, attachments, payload)
    : channel.send(payload)
}

async function textChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId)
  if (!channel?.isTextBased() || !('messages' in channel)) {
    throw new Error(`Announcement channel ${channelId} is not a readable text channel.`)
  }
  return channel
}

async function recentScheduledBotMessages(
  channel,
  clientUserId,
  scheduler,
  runKey,
) {
  return [
    ...(await channel.messages.fetch({ limit: 100 })).values(),
  ].filter((message) => {
    if (message.author.id !== clientUserId) return false
    const local = localDateTime(
      new Date(message.createdTimestamp),
      scheduler.timezone,
    )
    const scheduled = timeParts(scheduler.time)
    const scheduledMinutes =
      Number(scheduled.hour) * 60 + Number(scheduled.minute)
    return local.dateKey === runKey && local.minutes >= scheduledMinutes
  })
}

async function publishAfterMessageOnce(
  client,
  action,
  scheduler,
  runKey,
  force = false,
) {
  const channel = await textChannel(client, action.channelId)
  const sourceChannel =
    action.sourceChannelId && action.sourceChannelId !== action.channelId
      ? await textChannel(client, action.sourceChannelId)
      : channel
  const source = await sourceChannel.messages.fetch(action.messageId)
  if (!force) {
    const recent = await recentScheduledBotMessages(
      channel,
      client.user.id,
      scheduler,
      runKey,
    )
    const signature = announcementMessageSignature(source)
    if (
      recent.some(
        (message) => announcementMessageSignature(message) === signature,
      )
    ) {
      return false
    }
  }
  await publishMessage(channel, source, scheduler.allowMentions)
  return true
}

async function publishGroup(
  client,
  group,
  scheduler,
  runKey,
  { force = false, log = true } = {},
) {
  const channel = await textChannel(client, group.channelId)
  const sources = await Promise.all(
    group.messageIds.map((messageId) => channel.messages.fetch(messageId)),
  )
  const recent = force
    ? []
    : await recentScheduledBotMessages(
        channel,
        client.user.id,
        scheduler,
        runKey,
      )
  const remainingRecent = [...recent]
  const datedMessageIds = new Set(group.dateMessageIds ?? [])
  const dateLabel = announcementDateLabel(runKey)

  let posted = 0
  for (const source of sources) {
    const updatesDate = datedMessageIds.has(source.id)
    const formatLabel = updatesDate ? group.label : null
    const signature = announcementMessageSignature(
      source,
      updatesDate,
      formatLabel,
    )
    const existingIndex = remainingRecent.findIndex(
      (message) =>
        announcementMessageSignature(
          message,
          updatesDate,
          formatLabel,
        ) === signature,
    )
    if (existingIndex >= 0) {
      remainingRecent.splice(existingIndex, 1)
      continue
    }
    await publishMessage(
      channel,
      source,
      announcementAllowsMentions(
        scheduler.allowMentions,
        formatLabel,
        force,
      ),
      updatesDate ? dateLabel : null,
      formatLabel,
    )
    posted += 1
  }
  let afterPosted = 0
  for (const action of group.afterMessages ?? []) {
    if (
      await publishAfterMessageOnce(
        client,
        action,
        scheduler,
        runKey,
        force,
      )
    ) {
      afterPosted += 1
    }
  }
  if (log) {
    console.log(
      `${group.label} weekly announcement ` +
        `${posted > 0 ? `posted (${posted} messages)` : 'already posted'} ` +
        `with ${afterPosted > 0 ? `${afterPosted} follow-up` : 'follow-up already posted'} ` +
        `for ${runKey}.`,
    )
  }
  return { posted, afterPosted }
}

export function installAnnouncementAutomation(client, config) {
  const groups = config.groups.filter((group) => group.enabled)
  if (groups.length === 0) {
    console.log('Weekly announcement automation is disabled.')
    return
  }

  const activeRuns = new Set()
  const completedRuns = new Set()
  let testActive = false

  async function tick() {
    const runKey = scheduledRunKey(new Date(), config)
    if (!runKey) return

    for (const group of groups) {
      const groupRunKey = `${group.label}:${runKey}`
      if (activeRuns.has(groupRunKey) || completedRuns.has(groupRunKey)) continue
      activeRuns.add(groupRunKey)
      try {
        await publishGroup(client, group, config, runKey)
        completedRuns.add(groupRunKey)
      } catch (reason) {
        console.error(
          `${group.label} weekly announcement failed:`,
          reason instanceof Error ? reason.message : reason,
        )
      } finally {
        activeRuns.delete(groupRunKey)
      }
    }
  }

  client.once(Events.ClientReady, () => {
    console.log(
      `Weekly announcements scheduled for ${config.weekday} at ${config.time} (${config.timezone}).`,
    )
    void tick()
    const timer = setInterval(() => void tick(), 15_000)
    timer.unref()
  })

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      const guild =
        readyClient.guilds?.cache?.get(config.guildId) ??
        (await readyClient.guilds.fetch(config.guildId))
      const definition = {
        name: TEST_COMMAND_NAME,
        description: 'Test the weekly Mobile and PC scrim announcement flow now.',
        defaultMemberPermissions: null,
      }
      await guild.commands.create(definition)
      console.log(`/${TEST_COMMAND_NAME} registered in ${guild.name}.`)
    } catch (reason) {
      console.error(
        `Could not register /${TEST_COMMAND_NAME}:`,
        reason instanceof Error ? reason.message : reason,
      )
    }
  })

  client.on(Events.InteractionCreate, async (interaction) => {
    if (
      !interaction.isChatInputCommand() ||
      interaction.commandName !== TEST_COMMAND_NAME
    ) {
      return
    }
    if (testActive) {
      await interaction.reply({
        content: '⚠️ A scheduler test is already running. Please wait for it to finish.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    testActive = true
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      const runKey = nextScheduledRunKey(new Date(), config)
      const results = []
      for (const group of groups) {
        try {
          const outcome = await publishGroup(
            client,
            group,
            config,
            runKey,
            { force: true, log: false },
          )
          results.push(
            `✅ **${group.label}:** ${outcome.posted} announcement message(s) and ${outcome.afterPosted} follow-up message(s) posted.`,
          )
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason)
          console.error(`/${TEST_COMMAND_NAME} ${group.label} failed:`, message)
          results.push(`❌ **${group.label}:** ${message}`)
        }
      }
      await interaction.editReply({
        content: [
          `**Scheduler test for ${announcementDateLabel(runKey)}**`,
          ...results,
          '',
          `The automatic schedule remains ${config.weekday} at ${config.time} (${config.timezone}).`,
        ].join('\n'),
        allowedMentions: { parse: [] },
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      console.error(`/${TEST_COMMAND_NAME} failed:`, message)
      const payload = {
        content: `❌ Scheduler test failed: ${message}`,
        allowedMentions: { parse: [] },
      }
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => undefined)
      } else {
        await interaction
          .reply({ ...payload, flags: MessageFlags.Ephemeral })
          .catch(() => undefined)
      }
    } finally {
      testActive = false
    }
  })
}

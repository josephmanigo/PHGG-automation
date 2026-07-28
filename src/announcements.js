import { EmbedBuilder, Events } from 'discord.js'

const WEEKDAYS = new Set([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
])

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
  return value.replace(
    /(\bDATE\b\s*:\s*\*{0,2}\s*)[^\r\n]*/gi,
    `$1${dateLabel}`,
  )
}

function cloneEmbed(embed, dateLabel = null) {
  const result = new EmbedBuilder()
  if (embed.title) {
    result.setTitle(
      dateLabel ? replaceAnnouncementDate(embed.title, dateLabel) : embed.title,
    )
  }
  if (embed.description) {
    result.setDescription(
      dateLabel
        ? replaceAnnouncementDate(embed.description, dateLabel)
        : embed.description,
    )
  }
  if (embed.url) result.setURL(embed.url)
  if (embed.color !== null) result.setColor(embed.color)
  if (embed.timestamp) result.setTimestamp(new Date(embed.timestamp))
  if (embed.fields.length > 0) {
    result.setFields(
      embed.fields.map((field) => ({
        ...field,
        name: dateLabel
          ? replaceAnnouncementDate(field.name, dateLabel)
          : field.name,
        value:
          dateLabel && /^\s*\**\s*DATE\s*:?\s*\**\s*$/i.test(field.name)
            ? dateLabel
            : dateLabel
              ? replaceAnnouncementDate(field.value, dateLabel)
              : field.value,
      })),
    )
  }
  if (embed.author?.name) {
    result.setAuthor({
      name: embed.author.name,
      iconURL: embed.author.iconURL,
      url: embed.author.url,
    })
  }
  if (embed.footer?.text) {
    result.setFooter({ text: embed.footer.text, iconURL: embed.footer.iconURL })
  }
  if (embed.thumbnail?.url) result.setThumbnail(embed.thumbnail.url)
  if (embed.image?.url) result.setImage(embed.image.url)
  return result
}

function messageSignature(message, normalizeDate = false) {
  const text = (value) =>
    normalizeDate ? replaceAnnouncementDate(value, '<DATE>') : value
  return JSON.stringify({
    content: text(message.content),
    attachments: [...message.attachments.values()].map((attachment) => ({
      name: attachment.name,
      size: attachment.size,
    })),
    embeds: message.embeds.map((embed) => ({
      title: text(embed.title),
      description: text(embed.description),
      url: embed.url,
      image: embed.image?.url,
      thumbnail: embed.thumbnail?.url,
      fields: embed.fields.map((field) => ({
        name: field.name,
        value:
          normalizeDate && /^\s*\**\s*DATE\s*:?\s*\**\s*$/i.test(field.name)
            ? '<DATE>'
            : text(field.value),
      })),
    })),
  })
}

function clonePayload(message, allowMentions, dateLabel = null) {
  const payload = {
    allowedMentions: allowMentions
      ? { parse: ['everyone', 'roles', 'users'], repliedUser: false }
      : { parse: [], repliedUser: false },
  }
  if (message.content) {
    payload.content = dateLabel
      ? replaceAnnouncementDate(message.content, dateLabel)
      : message.content
  }
  if (message.embeds.length > 0) {
    payload.embeds = message.embeds
      .slice(0, 10)
      .map((embed) => cloneEmbed(embed, dateLabel))
  }
  if (message.attachments.size > 0) {
    payload.files = [...message.attachments.values()].map((attachment) => ({
      attachment: attachment.url,
      name: attachment.name ?? 'announcement-attachment',
    }))
  }
  if (message.stickers.size > 0) payload.stickers = [...message.stickers.keys()].slice(0, 3)
  if (!payload.content && !payload.embeds && !payload.files && !payload.stickers) {
    throw new Error(`Source message ${message.id} has no content that can be reposted.`)
  }
  return payload
}

async function textChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId)
  if (!channel?.isTextBased() || !('messages' in channel)) {
    throw new Error(`Announcement channel ${channelId} is not a readable text channel.`)
  }
  return channel
}

async function publishGroup(client, group, scheduler, runKey) {
  const channel = await textChannel(client, group.channelId)
  const sources = await Promise.all(
    group.messageIds.map((messageId) => channel.messages.fetch(messageId)),
  )
  const recent = [
    ...(await channel.messages.fetch({ limit: 100 })).values(),
  ].filter((message) => {
    if (message.author.id !== client.user.id) return false
    const local = localDateTime(new Date(message.createdTimestamp), scheduler.timezone)
    const scheduled = timeParts(scheduler.time)
    const scheduledMinutes = Number(scheduled.hour) * 60 + Number(scheduled.minute)
    return local.dateKey === runKey && local.minutes >= scheduledMinutes
  })
  const remainingRecent = [...recent]
  const datedMessageIds = new Set(group.dateMessageIds ?? [])
  const dateLabel = announcementDateLabel(runKey)

  let posted = 0
  for (const source of sources) {
    const updatesDate = datedMessageIds.has(source.id)
    const signature = messageSignature(source, updatesDate)
    const existingIndex = remainingRecent.findIndex(
      (message) => messageSignature(message, updatesDate) === signature,
    )
    if (existingIndex >= 0) {
      remainingRecent.splice(existingIndex, 1)
      continue
    }
    await channel.send(
      clonePayload(
        source,
        scheduler.allowMentions,
        updatesDate ? dateLabel : null,
      ),
    )
    posted += 1
  }
  console.log(
    `${group.label} weekly announcement ${posted > 0 ? `posted (${posted} messages)` : 'already posted'} for ${runKey}.`,
  )
}

export function installAnnouncementAutomation(client, config) {
  const groups = config.groups.filter((group) => group.enabled)
  if (groups.length === 0) {
    console.log('Weekly announcement automation is disabled.')
    return
  }

  const activeRuns = new Set()
  const completedRuns = new Set()

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
}

import { Events } from 'discord.js'

const COMMAND_NAME = 'rules'
const SCRIM_COMMAND_NAME = 'scrimrules'
const MESSAGE_LIMIT = 1_900

function messageText(message) {
  const parts = [message.content]
  for (const embed of message.embeds) {
    if (embed.author?.name) parts.push(`**${embed.author.name}**`)
    if (embed.title) parts.push(`# ${embed.title}`)
    if (embed.description) parts.push(embed.description)
    for (const field of embed.fields) parts.push(`**${field.name}**\n${field.value}`)
  }
  return parts.map((part) => part?.trim()).filter(Boolean).join('\n')
}

function splitContent(content) {
  const chunks = []
  let remaining = content
  while (remaining.length > MESSAGE_LIMIT && chunks.length < 9) {
    let splitAt = remaining.lastIndexOf('\n\n', MESSAGE_LIMIT)
    if (splitAt < MESSAGE_LIMIT / 2) {
      splitAt = remaining.lastIndexOf('\n', MESSAGE_LIMIT)
    }
    if (splitAt < MESSAGE_LIMIT / 2) splitAt = MESSAGE_LIMIT
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining.slice(0, MESSAGE_LIMIT))
  return chunks
}

function sourceFiles(messages) {
  const attachments = messages.flatMap((message) => [
    ...message.attachments.values(),
  ])
  if (attachments.length > 0) {
    return attachments.slice(0, 10).map((attachment, index) => ({
      attachment: attachment.url,
      name: attachment.name ?? `rules-${index + 1}.png`,
      description: attachment.description ?? undefined,
    }))
  }

  return messages
    .flatMap((message) => message.embeds)
    .flatMap((embed) => [embed.image?.url, embed.thumbnail?.url])
    .filter(Boolean)
    .slice(0, 10)
    .map((url, index) => ({
      attachment: url,
      name: `rules-${index + 1}.png`,
    }))
}

async function readableChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId)
  if (!channel?.isTextBased() || !('messages' in channel)) {
    throw new Error(`Rules channel ${channelId} is not a readable text channel.`)
  }
  return channel
}

async function fetchRules(channel) {
  const pins = await channel.messages.fetchPins({ limit: 50 })
  const pinned = pins.items.map((item) => item.message)
  if (pinned.length > 0) return pinned
  return [...(await channel.messages.fetch({ limit: 100 })).values()]
}

async function fetchConfiguredRules(channel, messageIds) {
  const results = await Promise.allSettled(
    messageIds.map((messageId) => channel.messages.fetch(messageId)),
  )
  const messages = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  if (messages.length > 0) return messages
  return fetchRules(channel)
}

function responses(messages, { brandName }) {
  const content = messages
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(messageText)
    .filter(Boolean)
    .join('\n\n')
  const text = content || `No official ${brandName} rules text was found.`
  const pages = splitContent(text)
  const files = sourceFiles(messages)
  return pages.map((page, index) => ({
    content: page,
    files: index === pages.length - 1 ? files : [],
    allowedMentions: { parse: [] },
  }))
}

export function scrimRulesResponses(messages) {
  const content = messages
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(messageText)
    .filter(Boolean)
    .join('\n\n')
  const text =
    content || 'No scrim-rules text was found in the configured source message.'
  const pages = splitContent(text)
  const files = sourceFiles(messages)
  return pages.map((page, index) => ({
    content: page,
    files: index === pages.length - 1 ? files : [],
    allowedMentions: { parse: [] },
  }))
}

function scrimRulesErrorResponse() {
  return {
    content:
      '❌ Scrim rules could not be loaded. Give the bot **View Channel** and ' +
      '**Read Message History** permissions in the scrim-rules source channel.',
    allowedMentions: { parse: [] },
  }
}

export function installRulesAutomation(client, config, botConfig) {
  const definitions = []
  if (config.enabled) {
    definitions.push({
      name: COMMAND_NAME,
      description: `Show the official ${botConfig.brandName} rules.`,
    })
  }
  if (config.scrims.enabled) {
    definitions.push({
      name: SCRIM_COMMAND_NAME,
      description: `Show the official ${botConfig.brandName} scrim rules.`,
    })
  }
  const commandNames = new Set(definitions.map((definition) => definition.name))
  if (definitions.length === 0) {
    console.log('Rules commands are disabled (no source channels configured).')
    return
  }

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      const guild = await readyClient.guilds.fetch(botConfig.guildId)
      const commands = await guild.commands.fetch()
      for (const definition of definitions) {
        const existing = commands.find((command) => command.name === definition.name)
        if (existing) await existing.edit(definition)
        else await guild.commands.create(definition)
      }
      console.log(
        `${definitions.map((definition) => `/${definition.name}`).join(', ')} registered in ${guild.name}.`,
      )
    } catch (reason) {
      console.error('Could not register rules commands:', reason instanceof Error ? reason.message : reason)
    }
  })

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !commandNames.has(interaction.commandName)) return
    try {
      await interaction.deferReply()
      if (interaction.commandName === COMMAND_NAME) {
        const channel = await readableChannel(client, config.channelId)
        const messages = await fetchRules(channel)
        const pages = responses(messages, {
          brandName: botConfig.brandName,
        })
        await interaction.editReply(pages[0])
        for (const page of pages.slice(1)) await interaction.followUp(page)
        return
      }

      const channel = await readableChannel(client, config.scrims.channelId)
      const messages = await fetchConfiguredRules(
        channel,
        config.scrims.messageIds,
      )
      const pages = scrimRulesResponses(messages)
      await interaction.editReply(pages[0])
      for (const page of pages.slice(1)) await interaction.followUp(page)
    } catch (reason) {
      console.error(
        `/${interaction.commandName} failed:`,
        reason instanceof Error ? reason.message : reason,
      )
      const sourceChannelId =
        interaction.commandName === SCRIM_COMMAND_NAME
          ? config.scrims.channelId
          : config.channelId
      const payload =
        interaction.commandName === SCRIM_COMMAND_NAME
          ? scrimRulesErrorResponse()
          : {
              content: `Rules could not be loaded right now. Open <#${sourceChannelId}> to view them.`,
              allowedMentions: { parse: [] },
            }
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => undefined)
      else await interaction.reply({ ...payload, ephemeral: true }).catch(() => undefined)
    }
  })
}

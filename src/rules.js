import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} from 'discord.js'

const COMMAND_NAME = 'rules'
const SCRIM_COMMAND_NAME = 'scrimrules'
const EMBED_LIMIT = 3_800

function messageText(message) {
  const parts = [message.content]
  for (const embed of message.embeds) {
    if (embed.title) parts.push(`**${embed.title}**`)
    if (embed.description) parts.push(embed.description)
    for (const field of embed.fields) parts.push(`**${field.name}**\n${field.value}`)
  }
  for (const attachment of message.attachments.values()) {
    parts.push(`[${attachment.name ?? 'Attachment'}](${attachment.url})`)
  }
  return parts.map((part) => part?.trim()).filter(Boolean).join('\n')
}

function splitContent(content) {
  const chunks = []
  let remaining = content
  while (remaining.length > EMBED_LIMIT && chunks.length < 9) {
    let splitAt = remaining.lastIndexOf('\n\n', EMBED_LIMIT)
    if (splitAt < EMBED_LIMIT / 2) splitAt = remaining.lastIndexOf('\n', EMBED_LIMIT)
    if (splitAt < EMBED_LIMIT / 2) splitAt = EMBED_LIMIT
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining.slice(0, EMBED_LIMIT))
  return chunks
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

function response(messages, { brandName, color, guildId, channelId }) {
  const content = messages
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(messageText)
    .filter(Boolean)
    .join('\n\n')
  const description = content || `Read the official rules in <#${channelId}>.`
  const embeds = splitContent(description).map((chunk, index) =>
    new EmbedBuilder()
      .setColor(color)
      .setTitle(index === 0 ? `${brandName.toUpperCase()} RULES` : 'RULES • CONTINUED')
      .setDescription(chunk)
      .setFooter({ text: `Official ${brandName} rules` }),
  )
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('OPEN RULES CHANNEL')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${guildId}/${channelId}`),
    ),
  ]
  return { embeds, components, allowedMentions: { parse: [] } }
}

export function scrimRulesResponses(messages, { color, guildId, channelId }) {
  const content = messages
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(messageText)
    .filter(Boolean)
    .join('\n\n')
  const description =
    content || 'No scrim-rules text was found in the configured source message.'
  const chunks = splitContent(description)
  const imageUrl =
    messages
      .flatMap((message) => [...message.attachments.values()])
      .find((attachment) => attachment.contentType?.startsWith('image/'))?.url ??
    messages.flatMap((message) => message.embeds).find((embed) => embed.image?.url)?.image?.url

  const sourceMessage = messages[0]
  const sourceUrl = sourceMessage
    ? `https://discord.com/channels/${guildId}/${channelId}/${sourceMessage.id}`
    : `https://discord.com/channels/${guildId}/${channelId}`
  return chunks.map((chunk, index) => {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(index === 0 ? 'SCRIM RULES' : 'SCRIM RULES • CONTINUED')
      .setDescription(chunk)
      .setFooter({ text: 'Official PHGG scrim rules' })
    if (imageUrl && index === chunks.length - 1) embed.setImage(imageUrl)

    return {
      embeds: [embed],
      components:
        index === 0
          ? [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setLabel('OPEN SCRIM RULES')
                  .setStyle(ButtonStyle.Link)
                  .setURL(sourceUrl),
              ),
            ]
          : [],
      allowedMentions: { parse: [] },
    }
  })
}

function scrimRulesErrorResponse({ guildId, channelId, messageIds }) {
  const sourceUrl = messageIds[0]
    ? `https://discord.com/channels/${guildId}/${channelId}/${messageIds[0]}`
    : `https://discord.com/channels/${guildId}/${channelId}`
  return {
    content:
      '❌ Scrim rules could not be loaded. Give the bot **View Channel** and ' +
      '**Read Message History** permissions in the scrim-rules source channel.',
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('OPEN SCRIM RULES SOURCE')
          .setStyle(ButtonStyle.Link)
          .setURL(sourceUrl),
      ),
    ],
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
        await interaction.editReply(
          response(messages, {
            brandName: botConfig.brandName,
            color: botConfig.color,
            guildId: interaction.guildId ?? botConfig.guildId,
            channelId: config.channelId,
          }),
        )
        return
      }

      const channel = await readableChannel(client, config.scrims.channelId)
      const messages = await fetchConfiguredRules(
        channel,
        config.scrims.messageIds,
      )
      const pages = scrimRulesResponses(messages, {
        color: botConfig.color,
        guildId: interaction.guildId ?? botConfig.guildId,
        channelId: config.scrims.channelId,
      })
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
          ? scrimRulesErrorResponse({
              guildId: interaction.guildId ?? botConfig.guildId,
              channelId: sourceChannelId,
              messageIds: config.scrims.messageIds,
            })
          : {
              content: `Rules could not be loaded right now. Open <#${sourceChannelId}> to view them.`,
              allowedMentions: { parse: [] },
            }
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => undefined)
      else await interaction.reply({ ...payload, ephemeral: true }).catch(() => undefined)
    }
  })
}

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} from 'discord.js'

const LINK_KEYWORD = /\blink\b/i

export function containsLinkKeyword(content) {
  return LINK_KEYWORD.test(String(content ?? ''))
}

export function selectBestInvite(invites) {
  return [...invites.values()]
    .filter(
      (invite) =>
        !invite.temporary &&
        !invite.expiresTimestamp &&
        !invite.maxUses,
    )
    .sort((left, right) => (right.uses ?? 0) - (left.uses ?? 0))[0] ?? null
}

function inviteReply(guild, inviteUrl, color) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🔗 ${guild.name.toUpperCase()} SERVER LINK`)
    .setDescription(`Here is the official **${guild.name}** server invite:\n${inviteUrl}`)
    .setFooter({ text: 'Official server invite' })
  const iconUrl = guild.iconURL({ size: 256 })
  if (iconUrl) embed.setThumbnail(iconUrl)

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('JOIN SERVER')
          .setStyle(ButtonStyle.Link)
          .setURL(inviteUrl),
      ),
    ],
    allowedMentions: { parse: [], repliedUser: false },
  }
}

async function createPermanentInvite(guild, preferredChannel) {
  const candidates = [
    preferredChannel,
    guild.systemChannel,
    ...guild.channels.cache.values(),
  ]
  const tried = new Set()
  let lastError = null
  for (const channel of candidates) {
    if (!channel || tried.has(channel.id) || typeof channel.createInvite !== 'function') continue
    tried.add(channel.id)
    try {
      const invite = await channel.createInvite({
        maxAge: 0,
        maxUses: 0,
        temporary: false,
        unique: false,
        reason: 'Permanent PHGG invite requested through the link keyword.',
      })
      return invite.url
    } catch (reason) {
      lastError = reason
    }
  }
  throw lastError ?? new Error('No channel is available for creating a permanent invite.')
}

async function officialInvite(guild, preferredChannel) {
  const refreshedGuild = await guild.fetch()
  if (refreshedGuild.vanityURLCode) {
    return `https://discord.gg/${refreshedGuild.vanityURLCode}`
  }

  const invites = await refreshedGuild.invites.fetch().catch(() => null)
  const invite = invites ? selectBestInvite(invites) : null
  if (invite) return invite.url
  return createPermanentInvite(refreshedGuild, preferredChannel)
}

export function installServerInviteAutomation(client, config, botConfig) {
  if (!config.enabled) {
    console.log('Server invite keyword automation is disabled.')
    return
  }

  let pendingInvite = null

  client.on(Events.MessageCreate, async (message) => {
    if (
      message.author.bot ||
      !message.inGuild() ||
      message.guildId !== botConfig.guildId ||
      !containsLinkKeyword(message.content)
    ) {
      return
    }

    try {
      pendingInvite ??= officialInvite(message.guild, message.channel).finally(() => {
        pendingInvite = null
      })
      const inviteUrl = await pendingInvite
      await message.reply(inviteReply(message.guild, inviteUrl, botConfig.color))
    } catch (reason) {
      console.error(
        'Could not fetch the server invite:',
        reason instanceof Error ? reason.message : reason,
      )
      await message
        .reply({
          content:
            '⚠️ I could not create a permanent server invite. Please give me **Manage Server** and **Create Invite** permissions.',
          allowedMentions: { parse: [], repliedUser: false },
        })
        .catch(() => undefined)
    }
  })
}

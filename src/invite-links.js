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

export function selectBestInvite(invites, now = Date.now()) {
  return [...invites.values()]
    .filter(
      (invite) =>
        !invite.temporary &&
        (!invite.expiresTimestamp || invite.expiresTimestamp > now) &&
        (!invite.maxUses || (invite.uses ?? 0) < invite.maxUses),
    )
    .sort((left, right) => {
      const leftPermanent = !left.expiresTimestamp && !left.maxUses ? 1 : 0
      const rightPermanent = !right.expiresTimestamp && !right.maxUses ? 1 : 0
      if (leftPermanent !== rightPermanent) return rightPermanent - leftPermanent
      return (right.uses ?? 0) - (left.uses ?? 0)
    })[0] ?? null
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

async function officialInvite(guild) {
  const refreshedGuild = await guild.fetch()
  if (refreshedGuild.vanityURLCode) {
    return `https://discord.gg/${refreshedGuild.vanityURLCode}`
  }

  const invites = await refreshedGuild.invites.fetch()
  const invite = selectBestInvite(invites)
  return invite?.url ?? null
}

export function installServerInviteAutomation(client, config, botConfig) {
  if (!config.enabled) {
    console.log('Server invite keyword automation is disabled.')
    return
  }

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
      const inviteUrl = await officialInvite(message.guild)
      if (!inviteUrl) {
        await message.reply({
          content:
            '⚠️ I could not find an active server invite. An administrator needs to create one first.',
          allowedMentions: { parse: [], repliedUser: false },
        })
        return
      }
      await message.reply(inviteReply(message.guild, inviteUrl, botConfig.color))
    } catch (reason) {
      console.error(
        'Could not fetch the server invite:',
        reason instanceof Error ? reason.message : reason,
      )
      await message
        .reply({
          content:
            '⚠️ I could not fetch the server invite. Please check that I have the **Manage Server** permission.',
          allowedMentions: { parse: [], repliedUser: false },
        })
        .catch(() => undefined)
    }
  })
}

import { Events } from 'discord.js'

const COMMAND_NAME = 'server'
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

function inviteReply(guild, inviteUrl) {
  return {
    content: [
      `# 🔗 ${guild.name.toUpperCase()} SERVER LINK`,
      `Here is the official **${guild.name}** server invite:`,
      `<${inviteUrl}>`,
    ].join('\n'),
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
    console.log('Server invite automation is disabled.')
    return
  }

  const pendingInvites = new Map()
  const inviteFor = (guild, preferredChannel) => {
    let pendingInvite = pendingInvites.get(guild.id)
    if (!pendingInvite) {
      pendingInvite = officialInvite(guild, preferredChannel).finally(() => {
        pendingInvites.delete(guild.id)
      })
      pendingInvites.set(guild.id, pendingInvite)
    }
    return pendingInvite
  }

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      const guild = await readyClient.guilds.fetch(botConfig.guildId)
      const commands = await guild.commands.fetch()
      const definition = {
        name: COMMAND_NAME,
        description: 'Get the official server invite.',
      }
      const existing = commands.find((command) => command.name === COMMAND_NAME)
      if (existing) await existing.edit(definition)
      else await guild.commands.create(definition)
      console.log(`/${COMMAND_NAME} registered in ${guild.name}.`)
    } catch (reason) {
      console.error(
        `Could not register /${COMMAND_NAME}:`,
        reason instanceof Error ? reason.message : reason,
      )
    }
  })

  client.on(Events.InteractionCreate, async (interaction) => {
    if (
      !interaction.isChatInputCommand() ||
      interaction.commandName !== COMMAND_NAME
    ) {
      return
    }

    try {
      await interaction.deferReply()
      const guild = await client.guilds.fetch(config.guildId)
      const inviteUrl = await inviteFor(guild, null)
      await interaction.editReply(inviteReply(guild, inviteUrl))
    } catch (reason) {
      console.error(
        `/${COMMAND_NAME} failed:`,
        reason instanceof Error ? reason.message : reason,
      )
      const payload = {
        content:
          '⚠️ I could not load the official server invite. Please make sure the bot is in that server and can create invites.',
        allowedMentions: { parse: [] },
      }
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => undefined)
      } else {
        await interaction.reply({ ...payload, ephemeral: true }).catch(() => undefined)
      }
    }
  })

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
      const inviteUrl = await inviteFor(message.guild, message.channel)
      await message.reply(inviteReply(message.guild, inviteUrl))
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

import { Events, PermissionFlagsBits } from 'discord.js'
import { discordUploadLimit } from './discord-upload.js'

/**
 * /announce — post a message to a chosen channel, as the bot.
 *
 * The scheduled announcements in announcements.js clone an existing message on
 * a timer. This is the manual counterpart: pick a channel, type the message,
 * optionally ping a role and attach an image.
 *
 * Posting into any channel is a privileged action, so the command is hidden
 * from members who cannot manage messages AND re-checked when it runs —
 * default_member_permissions is a UI hint that a server admin can override, not
 * a guarantee.
 */

const COMMAND_NAME = 'announce'
// Discord's own limit on message content.
const MAX_CONTENT_LENGTH = 2000

// Raw option type numbers; this codebase declares commands as plain objects
// rather than through the builders.
const OPTION_STRING = 3
const OPTION_CHANNEL = 7
const OPTION_ROLE = 8
const OPTION_ATTACHMENT = 11

// Text and announcement channels. Anything else has no plain message to post.
const TEXT_CHANNEL_TYPES = [0, 5]

/**
 * A slash command argument cannot contain a real newline — Discord submits the
 * field as a single line — so "\n" is accepted as one. Without this every
 * announcement would arrive as one long paragraph.
 */
export function expandLineBreaks(text) {
  return String(text ?? '').replace(/\\n/g, '\n')
}

/**
 * Build the message to post.
 *
 * Mentions are opt-in and narrow: only the role actually chosen is allowed to
 * ping, so a stray "@everyone" typed into the message text stays inert.
 */
export function buildAnnouncement({ message, role = null, guildId = null } = {}) {
  const body = expandLineBreaks(message).trim()
  if (!body) throw new Error('The announcement message is empty.')

  const isEveryone = Boolean(role) && role.id === guildId
  const prefix = role ? (isEveryone ? '@everyone' : `<@&${role.id}>`) : ''
  const content = [prefix, body].filter(Boolean).join('\n')

  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(
      `That message is ${content.length} characters; Discord allows ${MAX_CONTENT_LENGTH}.`,
    )
  }

  const allowedMentions = role
    ? isEveryone
      ? { parse: ['everyone'], repliedUser: false }
      : { parse: [], roles: [role.id], repliedUser: false }
    : { parse: [], repliedUser: false }

  return { content, allowedMentions }
}

function canAnnounce(member) {
  if (!member) return false
  return (
    member.permissions?.has(PermissionFlagsBits.Administrator) ||
    member.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions?.has(PermissionFlagsBits.ManageMessages)
  )
}

/** What the bot itself needs in the target channel before it can post. */
function missingBotPermissions(channel, guild, withImage) {
  const me = guild.members.me
  if (!me) return ['Send Messages']
  const perms = channel.permissionsFor(me)
  if (!perms) return ['View Channel']

  const missing = []
  if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel')
  if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages')
  if (withImage && !perms.has(PermissionFlagsBits.AttachFiles)) missing.push('Attach Files')
  return missing
}

export function installAnnounceCommand(client, botConfig) {
  const definition = {
    name: COMMAND_NAME,
    description: `Post an announcement to a channel as ${botConfig.brandName}.`,
    dm_permission: false,
    // A hint to Discord's UI. The handler checks again, because a server admin
    // can grant this command to anyone from Server Settings.
    default_member_permissions: String(PermissionFlagsBits.ManageMessages),
    options: [
      {
        name: 'channel',
        description: 'Where to post it.',
        type: OPTION_CHANNEL,
        required: true,
        channel_types: TEXT_CHANNEL_TYPES,
      },
      {
        name: 'message',
        description: 'What to post. Type \\n where you want a line break.',
        type: OPTION_STRING,
        required: true,
        max_length: MAX_CONTENT_LENGTH,
      },
      {
        name: 'mention',
        description: 'Role to ping. Only this role can be pinged.',
        type: OPTION_ROLE,
        required: false,
      },
      {
        name: 'image',
        description: 'An image to attach.',
        type: OPTION_ATTACHMENT,
        required: false,
      },
    ],
  }

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      const guild =
        readyClient.guilds?.cache?.get(botConfig.guildId) ??
        (await readyClient.guilds.fetch(botConfig.guildId))
      await guild.commands.create(definition)
      console.log(`/${COMMAND_NAME} registered in ${guild.name}.`)
    } catch (reason) {
      console.error(
        `Could not register /${COMMAND_NAME}:`,
        reason instanceof Error ? reason.message : reason,
      )
    }
  })

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) return

    // Ephemeral throughout: the announcement itself is the public output, and
    // the scorekeeper's command should not clutter the channel it was run in.
    await interaction.deferReply({ flags: 64 }).catch(() => {})

    try {
      if (!canAnnounce(interaction.member)) {
        await interaction.editReply(
          '❌ You need **Manage Messages** (or Manage Server) to post announcements.',
        )
        return
      }

      const channel = interaction.options.getChannel('channel')
      const message = interaction.options.getString('message')
      const role = interaction.options.getRole('mention')
      const image = interaction.options.getAttachment('image')

      if (!channel?.isTextBased?.()) {
        await interaction.editReply('❌ That channel cannot receive messages.')
        return
      }

      const missing = missingBotPermissions(channel, interaction.guild, Boolean(image))
      if (missing.length > 0) {
        await interaction.editReply(
          `❌ I need **${missing.join('**, **')}** in ${channel} before I can post there.`,
        )
        return
      }

      if (image) {
        if (!String(image.contentType || '').startsWith('image/')) {
          await interaction.editReply(
            `❌ That attachment is \`${image.contentType || 'an unknown type'}\`, not an image.`,
          )
          return
        }
        const limit = discordUploadLimit(channel)
        if (Number(image.size) > limit) {
          await interaction.editReply(
            `❌ That image is ${(image.size / 1024 / 1024).toFixed(1)} MB; this server allows ${(limit / 1024 / 1024).toFixed(0)} MB.`,
          )
          return
        }
      }

      const payload = buildAnnouncement({
        message,
        role,
        guildId: interaction.guildId,
      })
      if (image) {
        // Re-uploaded from Discord's CDN rather than linked, so the image stays
        // with the announcement if the original interaction is deleted.
        payload.files = [{ attachment: image.url, name: image.name || 'image.png' }]
      }

      const sent = await channel.send(payload)
      await interaction.editReply(
        `✅ Posted in ${channel}${role ? ` and pinged **${role.name}**` : ''}.\n${sent.url}`,
      )
      console.log(
        `[ANNOUNCE] ${interaction.user.tag} posted to #${channel.name}` +
          `${role ? ` mentioning @${role.name}` : ''}${image ? ' with an image' : ''}.`,
      )
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason)
      console.error(`/${COMMAND_NAME} failed:`, detail)
      await interaction
        .editReply(`❌ Could not post that announcement: ${detail}`)
        .catch(() => undefined)
    }
  })
}

import { Events } from 'discord.js'

export const NICKNAME_MAX_LENGTH = 32

const TAG_PATTERN = /^[A-Z0-9]{1,10}$/
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '._-]*$/u
const ROLE_PATTERN = /^(PLAYER|HANDLER)$/i

const invalid = (reason) => ({ ok: false, reason })

function checkName(name) {
  if (!name) return 'the name is missing'
  if (!NAME_PATTERN.test(name)) return `"${name}" is not a usable name`
  return null
}

export function formatNickname(rawValue) {
  const value = String(rawValue ?? '').replace(/\s+/g, ' ').trim()
  if (!value) return invalid('the message is empty')

  const match = /^([^|]+?)\s*\|\s*(.+?)\s*-\s*([^-]+?)$/.exec(value)
  if (!match) return invalid('use "CLAN TAG | IGN - Player" or "CLAN TAG | IGN - Handler"')

  const tag = match[1].trim().toUpperCase()
  const name = match[2].trim()
  const role = match[3].trim()
  if (!TAG_PATTERN.test(tag)) return invalid(`"${tag}" is not a usable clan tag`)
  const nameProblem = checkName(name)
  if (nameProblem) return invalid(nameProblem)
  if (!ROLE_PATTERN.test(role)) return invalid('the final role must be Player or Handler')

  const canonicalRole = role.toUpperCase() === 'PLAYER' ? 'Player' : 'Handler'
  const nickname = `${tag} | ${name} - ${canonicalRole}`

  if (nickname.length > NICKNAME_MAX_LENGTH) {
    return invalid(
      `the nickname is ${nickname.length} characters; Discord allows ${NICKNAME_MAX_LENGTH}`,
    )
  }
  return { ok: true, nickname }
}

function cleanName(value) {
  const name = value.replace(/[\r\n`]/g, ' ').replace(/\s+/g, ' ').trim()
  return name || null
}

export function parseRenameTargets(content) {
  const tokens = []
  const mentionPattern = /<@!?(\d+)>/g
  let cursor = 0
  for (let match = mentionPattern.exec(content); match; match = mentionPattern.exec(content)) {
    tokens.push({ text: content.slice(cursor, match.index) })
    tokens.push({ userId: match[1] })
    cursor = mentionPattern.lastIndex
  }
  tokens.push({ text: content.slice(cursor) })

  const requests = new Map()
  const consumed = new Set()
  let allNamed = true
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].userId) continue
    const before = index - 1
    const after = index + 1
    let name = null
    if (!consumed.has(before) && tokens[before] && cleanName(tokens[before].text)) {
      name = cleanName(tokens[before].text)
      consumed.add(before)
    } else if (!consumed.has(after) && tokens[after] && cleanName(tokens[after].text)) {
      name = cleanName(tokens[after].text)
      consumed.add(after)
    }
    if (name) requests.set(tokens[index].userId, name)
    else allNamed = false
  }
  return { requests, allNamed }
}

async function applyNickname(member, nickname) {
  if (member.nickname === nickname) return true
  if (!member.manageable) return false
  await member.setNickname(nickname, 'Requested in the nickname channel.')
  return true
}

async function react(message, emoji) {
  await message.react(emoji).catch((reason) => {
    console.error('Could not add a nickname reaction:', reason instanceof Error ? reason.message : reason)
  })
}

export function installNicknameAutomation(client, config) {
  if (!config.enabled) {
    console.log('Nickname automation is disabled (no channel configured).')
    return
  }

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild() || message.channelId !== config.channelId) return

    try {
      const { requests, allNamed } = parseRenameTargets(message.content)
      if (requests.size > 0) {
        const checked = [...requests].map(([userId, name]) => [
          userId,
          formatNickname(name),
        ])
        if (!allNamed || checked.some(([, result]) => !result.ok)) {
          await react(message, '❌')
          return
        }

        const results = await Promise.all(
          checked.map(async ([userId, result]) => {
            const member = await message.guild.members.fetch(userId)
            return applyNickname(member, result.nickname)
          }),
        )
        await react(message, results.every(Boolean) ? '✅' : '⚠️')
        return
      }

      const requested = cleanName(message.content.replace(/<@!?\d+>/g, ' '))
      if (!requested) return
      const result = formatNickname(requested)
      if (!result.ok) {
        console.warn(`Nickname rejected for ${message.author.tag}: ${result.reason}.`)
        await react(message, '❌')
        return
      }
      const member = message.member ?? (await message.guild.members.fetch(message.author.id))
      await react(message, (await applyNickname(member, result.nickname)) ? '✅' : '⚠️')
    } catch (reason) {
      console.error('Nickname automation failed:', reason instanceof Error ? reason.message : reason)
      await react(message, '⚠️')
    }
  })
}

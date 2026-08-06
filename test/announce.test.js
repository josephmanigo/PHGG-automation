import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnnouncement, expandLineBreaks } from '../src/announce.js'

const GUILD = '111'
const ROLE = { id: '222', name: 'Scrim Players' }

test('a slash argument turns \\n into real line breaks', () => {
  assert.equal(expandLineBreaks('one\\ntwo\\nthree'), 'one\ntwo\nthree')
  assert.equal(expandLineBreaks('no breaks here'), 'no breaks here')
})

test('the message posts as written', () => {
  const { content } = buildAnnouncement({ message: 'Scrims at 8PM\\nBe on time', guildId: GUILD })
  assert.equal(content, 'Scrims at 8PM\nBe on time')
})

test('a chosen role is pinged above the message', () => {
  const { content, allowedMentions } = buildAnnouncement({
    message: 'Scrims tonight',
    role: ROLE,
    guildId: GUILD,
  })
  assert.equal(content, '<@&222>\nScrims tonight')
  assert.deepEqual(allowedMentions.roles, ['222'])
})

/**
 * The whole point of narrowing allowedMentions: text is untrusted input, and a
 * bot posting it must not become a way to ping the server at will.
 */
test('mentions typed into the message text stay inert', () => {
  const { allowedMentions } = buildAnnouncement({
    message: 'hey @everyone and <@&999> and <@123>',
    guildId: GUILD,
  })
  assert.deepEqual(allowedMentions.parse, [])
  assert.equal(allowedMentions.roles, undefined)
})

test('choosing a role still does not license any other mention', () => {
  const { allowedMentions } = buildAnnouncement({
    message: 'ping @everyone please',
    role: ROLE,
    guildId: GUILD,
  })
  assert.deepEqual(allowedMentions.parse, [])
  assert.deepEqual(allowedMentions.roles, ['222'])
})

test('@everyone is only pinged when it is the role that was picked', () => {
  // Discord models @everyone as the role whose id is the guild id.
  const { content, allowedMentions } = buildAnnouncement({
    message: 'Server maintenance tonight',
    role: { id: GUILD, name: '@everyone' },
    guildId: GUILD,
  })
  assert.equal(content, '@everyone\nServer maintenance tonight')
  assert.deepEqual(allowedMentions.parse, ['everyone'])
})

test('an empty message is refused rather than posted blank', () => {
  assert.throws(() => buildAnnouncement({ message: '   ', guildId: GUILD }), /empty/i)
})

test('a message over the Discord limit is refused with its length', () => {
  assert.throws(
    () => buildAnnouncement({ message: 'x'.repeat(2001), guildId: GUILD }),
    /2001 characters/,
  )
})

test('the role prefix counts toward the length limit', () => {
  // 1995 chars plus "<@&222>\n" is 2003 — over, even though the body is not.
  assert.throws(
    () => buildAnnouncement({ message: 'x'.repeat(1995), role: ROLE, guildId: GUILD }),
    /Discord allows 2000/,
  )
})

test('installAnnounceCommand registers slash command in 1 fetch call directly', async () => {
  const onceHandlers = new Map()
  const createdCommands = []
  let fetchCommandsCount = 0

  const commandGuild = {
    id: GUILD,
    name: 'PHGG',
    commands: {
      fetch: async () => {
        fetchCommandsCount++
        return []
      },
      create: async (def) => {
        createdCommands.push(def)
      },
    },
  }

  const client = {
    guilds: {
      cache: new Map([[GUILD, commandGuild]]),
      fetch: async () => commandGuild,
    },
    once: (event, handler) => onceHandlers.set(event, handler),
    on: () => {},
  }

  const { installAnnounceCommand } = await import('../src/announce.js')
  installAnnounceCommand(client, { guildId: GUILD, brandName: 'PHGG' })

  const readyHandler = onceHandlers.get('ClientReady') || onceHandlers.get('clientReady')
  assert.ok(readyHandler, 'ClientReady handler should be registered')
  await readyHandler(client)

  assert.equal(createdCommands.length, 1)
  assert.equal(createdCommands[0].name, 'announce')
  assert.equal(fetchCommandsCount, 0, 'Should not do duplicate commands.fetch call')
})

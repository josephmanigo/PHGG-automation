import assert from 'node:assert/strict'
import test from 'node:test'
import {
  containsLinkKeyword,
  installServerInviteAutomation,
  selectBestInvite,
} from '../src/invite-links.js'

test('detects the word link anywhere in a sentence', () => {
  assert.equal(containsLinkKeyword('link'), true)
  assert.equal(containsLinkKeyword('Can someone send the LINK please?'), true)
  assert.equal(containsLinkKeyword('Where is the link for the server'), true)
})

test('does not trigger on words that merely contain link', () => {
  assert.equal(containsLinkKeyword('hyperlink'), false)
  assert.equal(containsLinkKeyword('linktree'), false)
  assert.equal(containsLinkKeyword('connected'), false)
})

test('prefers a permanent unlimited server invite', () => {
  const invites = new Map([
    [
      'temporary',
      {
        code: 'temporary',
        url: 'https://discord.gg/temporary',
        temporary: false,
        expiresTimestamp: Date.now() + 60_000,
        maxUses: 10,
        uses: 1,
      },
    ],
    [
      'official',
      {
        code: 'official',
        url: 'https://discord.gg/official',
        temporary: false,
        expiresTimestamp: null,
        maxUses: 0,
        uses: 50,
      },
    ],
  ])
  assert.equal(selectBestInvite(invites).code, 'official')
})

test('never returns an expiring or limited invite', () => {
  const invites = new Map([
    [
      'expiring',
      {
        code: 'expiring',
        url: 'https://discord.gg/expiring',
        temporary: false,
        expiresTimestamp: Date.now() + 86_400_000,
        maxUses: 0,
        uses: 0,
      },
    ],
    [
      'limited',
      {
        code: 'limited',
        url: 'https://discord.gg/limited',
        temporary: false,
        expiresTimestamp: null,
        maxUses: 100,
        uses: 0,
      },
    ],
  ])
  assert.equal(selectBestInvite(invites), null)
})

test('/server fetches the current configured guild and returns its official invite', async () => {
  const onceHandlers = new Map()
  const eventHandlers = new Map()
  const fetchedGuildIds = []
  const createdCommands = []
  const commandGuild = {
    id: 'test-guild',
    name: 'PHGG',
    vanityURLCode: 'phgg',
    fetch: async () => commandGuild,
    commands: {
      fetch: async () => ({ find: () => null }),
      create: async (definition) => createdCommands.push(definition),
    },
  }
  const client = {
    guilds: {
      fetch: async (guildId) => {
        fetchedGuildIds.push(guildId)
        return commandGuild
      },
    },
    once: (event, handler) => onceHandlers.set(event, handler),
    on: (event, handler) => eventHandlers.set(event, handler),
  }

  installServerInviteAutomation(
    client,
    { enabled: true, guildId: commandGuild.id },
    { guildId: commandGuild.id },
  )
  await onceHandlers.get('clientReady')(client)

  let reply
  const interaction = {
    commandName: 'server',
    isChatInputCommand: () => true,
    deferReply: async () => undefined,
    editReply: async (payload) => {
      reply = payload
    },
  }
  await eventHandlers.get('interactionCreate')(interaction)

  assert.deepEqual(createdCommands, [
    {
      name: 'server',
      description: 'Get the official server invite.',
    },
  ])
  assert.deepEqual(fetchedGuildIds, [commandGuild.id, commandGuild.id])
  assert.match(reply.content, /PHGG SERVER LINK/)
  assert.match(reply.content, /https:\/\/discord\.gg\/phgg/)
})

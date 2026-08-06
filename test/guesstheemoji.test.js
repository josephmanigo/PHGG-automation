import test from 'node:test'
import assert from 'node:assert/strict'
import { Events } from 'discord.js'
import {
  parseEmojis,
  shuffleArray,
  createShuffledSequence,
  countCorrectPositions,
  getReactionsForCount,
  installGuessTheEmojiCommand,
  activeGames,
} from '../src/guesstheemoji.js'

test('parseEmojis extracts Unicode and custom Discord emojis correctly', () => {
  const unicodeInput = '🥰 🫡 🐱 💚 😺 🛡️'
  assert.deepEqual(parseEmojis(unicodeInput), ['🥰', '🫡', '🐱', '💚', '😺', '🛡️'])

  const customInput = '<:nightraid:1337103312989716592> <a:dance_gif:123456789>'
  assert.deepEqual(parseEmojis(customInput), [
    '<:nightraid:1337103312989716592>',
    '<a:dance_gif:123456789>',
  ])

  const mixedInput = '🥰 Hello <:nr:9999> world 🫡'
  assert.deepEqual(parseEmojis(mixedInput), ['🥰', '<:nr:9999>', '🫡'])

  assert.deepEqual(parseEmojis('No emojis here!'), [])
  assert.deepEqual(parseEmojis(''), [])
  assert.deepEqual(parseEmojis(null), [])
})

test('shuffleArray maintains array length and elements', () => {
  const input = ['🥰', '🫡', '🐱', '💚', '😺', '🛡️']
  const shuffled = shuffleArray(input)

  assert.equal(shuffled.length, input.length)
  assert.deepEqual(shuffled.sort(), [...input].sort())
})

test('createShuffledSequence returns shuffled sequence', () => {
  const input = ['🥰', '🫡', '🐱', '💚', '😺', '🛡️']
  const result = createShuffledSequence(input)

  assert.equal(result.length, input.length)
  assert.deepEqual(result.sort(), [...input].sort())
})

test('countCorrectPositions counts exact index matches', () => {
  const secret = ['🥰', '🫡', '🐱', '💚', '😺', '🛡️']

  // 6 out of 6 match
  assert.equal(countCorrectPositions(['🥰', '🫡', '🐱', '💚', '😺', '🛡️'], secret), 6)

  // 3 out of 6 match (indices 0, 1, 3 match)
  assert.equal(countCorrectPositions(['🥰', '🫡', '🛡️', '💚', '🐱', '😺'], secret), 3)

  // 0 out of 6 match
  assert.equal(countCorrectPositions(['🛡️', '😺', '💚', '🐱', '🫡', '🥰'], secret), 0)

  // Handlers with invalid input
  assert.equal(countCorrectPositions(null, secret), 0)
})

test('getReactionsForCount maps position count to emojis correctly', () => {
  assert.deepEqual(getReactionsForCount(0), ['❌'])
  assert.deepEqual(getReactionsForCount(1), ['1️⃣'])
  assert.deepEqual(getReactionsForCount(3), ['3️⃣'])
  assert.deepEqual(getReactionsForCount(6), ['6️⃣'])
  assert.deepEqual(getReactionsForCount(10), ['🔟'])
  assert.deepEqual(getReactionsForCount(12), ['1️⃣', '2️⃣'])
})

test('installGuessTheEmojiCommand registers command and handles game lifecycle', async () => {
  const GUILD_ID = '111'
  const CHANNEL_ID = 'ch-1'

  const createdCommands = []
  const eventHandlers = new Map()
  const onceHandlers = new Map()

  const mockGuild = {
    id: GUILD_ID,
    name: 'PHGG Server',
    commands: {
      create: async (def) => {
        createdCommands.push(def)
      },
    },
  }

  const client = {
    guilds: {
      cache: new Map([[GUILD_ID, mockGuild]]),
      fetch: async () => mockGuild,
    },
    once: (event, fn) => onceHandlers.set(event, fn),
    on: (event, fn) => eventHandlers.set(event, fn),
  }

  installGuessTheEmojiCommand(client, { guildId: GUILD_ID })

  const readyHandler =
    onceHandlers.get(Events.ClientReady) ||
    onceHandlers.get('ClientReady') ||
    onceHandlers.get('ready')
  assert.ok(readyHandler, 'ClientReady handler should be registered')
  await readyHandler(client)

  assert.equal(createdCommands.length, 1)
  assert.equal(createdCommands[0].name, 'guesstheemoji')

  // Test slash command execution
  const interactionHandler =
    eventHandlers.get(Events.InteractionCreate) || eventHandlers.get('interactionCreate')
  assert.ok(interactionHandler, 'InteractionCreate handler should be registered')

  const sentMessages = []
  let editReplyContent = ''

  const mockInteraction = {
    isChatInputCommand: () => true,
    commandName: 'guesstheemoji',
    user: { id: 'host-1', tag: 'HostUser#0001' },
    channelId: CHANNEL_ID,
    channel: {
      send: async (msg) => {
        sentMessages.push(msg)
        return { id: 'msg-1' }
      },
    },
    options: {
      getString: (key) => (key === 'emojis' ? '🥰 🫡 🐱 💚 😺 🛡️' : null),
    },
    deferReply: async () => {},
    editReply: async (msg) => {
      editReplyContent = msg
    },
  }

  await interactionHandler(mockInteraction)

  assert.ok(activeGames.has(CHANNEL_ID))
  assert.equal(sentMessages.length, 1)
  assert.ok(sentMessages[0].content.includes('GUESS THE EMOJI GAME STARTED!'))
  assert.ok(editReplyContent.includes('Guess The Emoji'))

  // Test message guess handling (incorrect position guess)
  const messageHandler =
    eventHandlers.get(Events.MessageCreate) || eventHandlers.get('messageCreate')
  assert.ok(messageHandler, 'MessageCreate handler should be registered')

  const reactedEmojis = []
  const mockPlayerMessage = {
    author: { bot: false, id: 'player-1', tag: 'Player1#0002' },
    channelId: CHANNEL_ID,
    content: '🥰 🫡 🛡️ 💚 🐱 😺', // 3 position matches (0, 1, 3)
    react: async (emoji) => {
      reactedEmojis.push(emoji)
    },
    channel: {
      send: async () => {},
    },
  }

  await messageHandler(mockPlayerMessage)
  assert.deepEqual(reactedEmojis, ['3️⃣'])
  assert.ok(activeGames.has(CHANNEL_ID)) // Game should still be active

  // Test winning guess
  const mockWinningMessage = {
    author: { bot: false, id: 'player-1', tag: 'Player1#0002' },
    channelId: CHANNEL_ID,
    content: '🥰 🫡 🐱 💚 😺 🛡️', // Exact match
    react: async (emoji) => {
      reactedEmojis.push(emoji)
    },
    channel: {
      send: async (msg) => {
        sentMessages.push(msg)
      },
    },
  }

  await messageHandler(mockWinningMessage)
  assert.ok(reactedEmojis.includes('🎉'))
  assert.ok(sentMessages.some((m) => m.content.includes('CONGRATULATIONS!')))
  assert.equal(activeGames.has(CHANNEL_ID), false) // Game ended and cleaned up
})

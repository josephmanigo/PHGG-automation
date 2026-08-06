import { Events } from 'discord.js'

const COMMAND_NAME = 'guesstheemoji'
const OPTION_STRING = 3

const EMOJI_REGEX =
  /<a?:[a-zA-Z0-9_]+:\d+>|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic})*/gu

const DIGIT_EMOJIS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']

/**
 * Extract all Unicode and custom Discord emojis from a text string.
 */
export function parseEmojis(text) {
  if (!text || typeof text !== 'string') return []
  const matches = text.match(EMOJI_REGEX)
  return matches ? matches.filter(Boolean) : []
}

/**
 * Fisher-Yates array shuffle.
 */
export function shuffleArray(array) {
  const result = [...array]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/**
 * Create a shuffled sequence that is different from original if possible.
 */
export function createShuffledSequence(sequence) {
  if (!Array.isArray(sequence) || sequence.length <= 1) return [...sequence]
  const isAllSame = sequence.every((item) => item === sequence[0])
  if (isAllSame) return [...sequence]

  let shuffled = shuffleArray(sequence)
  let retries = 10
  while (retries > 0 && shuffled.every((val, idx) => val === sequence[idx])) {
    shuffled = shuffleArray(sequence)
    retries--
  }
  return shuffled
}

/**
 * Compare guess emojis with secret sequence by exact position.
 */
export function countCorrectPositions(guessEmojis, secretEmojis) {
  if (!Array.isArray(guessEmojis) || !Array.isArray(secretEmojis)) return 0
  const length = Math.min(guessEmojis.length, secretEmojis.length)
  let correct = 0
  for (let i = 0; i < length; i++) {
    if (guessEmojis[i] === secretEmojis[i]) {
      correct++
    }
  }
  return correct
}

/**
 * Get reactions for a given number of correct position emojis.
 * Returns ['❌'] for 0, ['3️⃣'] for 3, etc.
 */
export function getReactionsForCount(count) {
  if (!Number.isInteger(count) || count <= 0) return ['❌']
  if (count <= 10) return [DIGIT_EMOJIS[count]]

  const digits = String(count).split('')
  return digits.map((digit) => DIGIT_EMOJIS[Number(digit)])
}

/** Active games in memory, keyed by channelId. */
export const activeGames = new Map()

export function installGuessTheEmojiCommand(client, botConfig) {
  const definition = {
    name: COMMAND_NAME,
    description: 'Start a Guess The Emoji sequence game in this channel.',
    dm_permission: false,
    options: [
      {
        name: 'emojis',
        description: 'Input the emojis for the guessing game (e.g. 🥰 🫡 🐱 💚 😺 🛡️).',
        type: OPTION_STRING,
        required: true,
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

    await interaction.deferReply({ flags: 64 }).catch(() => {})

    try {
      const input = interaction.options.getString('emojis')
      const secretSequence = parseEmojis(input)

      if (secretSequence.length < 2) {
        await interaction.editReply(
          '❌ Please provide at least **2 emojis** to start a guessing game.',
        )
        return
      }

      const shuffledSequence = createShuffledSequence(secretSequence)
      const channelId = interaction.channelId

      const game = {
        channelId,
        hostId: interaction.user.id,
        hostTag: interaction.user.tag,
        secretSequence,
        shuffledSequence,
        guessesCount: 0,
        startedAt: Date.now(),
      }

      activeGames.set(channelId, game)

      const gameAnnouncement = [
        `🎮 **GUESS THE EMOJI GAME STARTED!**`,
        `Host: <@${interaction.user.id}>`,
        ``,
        `**Emojis used (shuffled order):**`,
        `${shuffledSequence.join(' ')}`,
        ``,
        `**Rules:**`,
        `• Guess the exact sequence of all **${secretSequence.length}** emojis!`,
        `• Type your emoji guess directly in this channel (unlimited guesses).`,
        `• Reaction hints: bot reacts with a number for correct emoji positions, or ❌ if 0 correct.`,
      ].join('\n')

      await interaction.channel.send({ content: gameAnnouncement })
      await interaction.editReply('✅ **Guess The Emoji** game has been started in this channel!')

      console.log(
        `[GUESSTHEEMOJI] Game started by ${interaction.user.tag} in #${interaction.channel?.name || channelId} with ${secretSequence.length} emojis.`,
      )
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason)
      console.error(`/${COMMAND_NAME} failed:`, detail)
      await interaction
        .editReply(`❌ Could not start the Guess The Emoji game: ${detail}`)
        .catch(() => undefined)
    }
  })

  client.on(Events.MessageCreate, async (message) => {
    if (message.author?.bot || !message.channelId) return

    const game = activeGames.get(message.channelId)
    if (!game) return

    const guessEmojis = parseEmojis(message.content)

    // Only process as a guess if the message has emojis equal to the game's sequence length
    if (guessEmojis.length !== game.secretSequence.length) return

    game.guessesCount++
    const correctCount = countCorrectPositions(guessEmojis, game.secretSequence)

    if (correctCount === game.secretSequence.length) {
      // Winner!
      activeGames.delete(message.channelId)
      await message.react('🎉').catch(() => {})

      const winMessage = [
        `🎉 **CONGRATULATIONS!** <@${message.author.id}> guessed the correct sequence!`,
        `Total guesses: **${game.guessesCount}**`,
        `Sequence: ${game.secretSequence.join(' ')}`,
      ].join('\n')

      await message.channel.send({ content: winMessage }).catch(() => {})
      console.log(
        `[GUESSTHEEMOJI] ${message.author.tag} won in #${message.channel?.name || message.channelId} after ${game.guessesCount} guesses.`,
      )
    } else {
      // Provide reaction feedback
      const reactions = getReactionsForCount(correctCount)
      for (const reaction of reactions) {
        await message.react(reaction).catch(() => {})
      }
    }
  })
}

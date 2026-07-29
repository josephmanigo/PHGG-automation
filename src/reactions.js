export const BOT_CHECK_REACTION_ID = '1472902880120934431'
export const BOT_CROSS_REACTION_ID = '1531747414380253335'

export const LEGACY_BOT_REACTION_EMOJIS = [
  '✅',
  '❌',
  '⚠️',
  '1470736595673157754',
]

export function findReaction(message, emoji) {
  return message.reactions.cache.find(
    (reaction) => reaction.emoji.id === emoji || reaction.emoji.name === emoji,
  )
}

export function resolveReactionEmoji(client, emojiId) {
  return client.emojis.cache.get(emojiId) ?? emojiId
}

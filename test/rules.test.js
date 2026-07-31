import assert from 'node:assert/strict'
import test from 'node:test'
import {
  installRulesAutomation,
  scrimRulesResponses,
} from '../src/rules.js'

function rulesMessage(id, content, createdTimestamp, attachments = []) {
  return {
    id,
    content,
    createdTimestamp,
    attachments: new Map(
      attachments.map((attachment, index) => [
        String(index),
        attachment,
      ]),
    ),
    embeds: [],
  }
}

test('paginates scrim rules as plain messages and keeps the source image', () => {
  const pages = scrimRulesResponses(
    [
      rulesMessage(
        'rules-2',
        'B'.repeat(3_700),
        2,
        [
          {
            url: 'https://cdn.discordapp.com/attachments/rules/points.png',
            name: 'PHGG_PT_SYSTEM.png',
          },
        ],
      ),
      rulesMessage('rules-1', 'A'.repeat(3_700), 1),
    ],
  )

  assert.equal(pages.length, 4)
  assert.ok(pages.every((page) => page.content.length <= 1_900))
  assert.ok(pages.every((page) => !('embeds' in page)))
  assert.ok(pages.every((page) => !('components' in page)))
  assert.deepEqual(pages.at(-1).files, [
    {
      attachment:
        'https://cdn.discordapp.com/attachments/rules/points.png',
      name: 'PHGG_PT_SYSTEM.png',
      description: undefined,
    },
  ])
  assert.deepEqual(pages.slice(0, -1).map((page) => page.files), [
    [],
    [],
    [],
  ])
})

test('/rules fetches the configured server-rules message directly', async () => {
  const eventHandlers = new Map()
  const fetchedChannelIds = []
  const fetchedMessageIds = []
  const message = rulesMessage(
    '1336451755734732861',
    'SERVER RULES CONTENT',
    1,
  )
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: async (messageId) => {
        fetchedMessageIds.push(messageId)
        return message
      },
      fetchPins: async () => {
        throw new Error('/rules must not fall back to channel pins')
      },
    },
  }
  const client = {
    channels: {
      fetch: async (channelId) => {
        fetchedChannelIds.push(channelId)
        return channel
      },
    },
    once: () => undefined,
    on: (event, handler) => eventHandlers.set(event, handler),
  }

  installRulesAutomation(
    client,
    {
      enabled: true,
      channelId: '1270783545685577871',
      messageIds: ['1336451755734732861'],
      scrims: { enabled: false, channelId: '', messageIds: [] },
    },
    { brandName: 'PHGG', guildId: 'test-guild' },
  )

  let reply
  await eventHandlers.get('interactionCreate')({
    commandName: 'rules',
    isChatInputCommand: () => true,
    deferReply: async () => undefined,
    editReply: async (payload) => {
      reply = payload
    },
  })

  assert.deepEqual(fetchedChannelIds, ['1270783545685577871'])
  assert.deepEqual(fetchedMessageIds, ['1336451755734732861'])
  assert.deepEqual(reply, {
    content: 'SERVER RULES CONTENT',
    files: [],
    allowedMentions: { parse: [] },
  })
})

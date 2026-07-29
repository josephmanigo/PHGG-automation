import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDirectMediaPayload,
  buildStreamingMultipart,
  discordUploadLimit,
  sendDiscordAttachments,
} from '../src/discord-upload.js'

test('builds a fixed-length multipart upload without buffering the GIF', () => {
  const attachment = {
    name: 'Announcement.gif',
    contentType: 'image/gif',
    size: 123_456,
    url: 'https://cdn.discordapp.com/attachments/announcement.gif',
  }
  const multipart = buildStreamingMultipart(
    {
      content: 'Scrim announcement',
      allowedMentions: { parse: [] },
    },
    [attachment],
    'PHGG-test-boundary',
  )

  assert.match(multipart.json.toString(), /"content":"Scrim announcement"/)
  assert.match(
    multipart.files[0].header.toString(),
    /name="files\[0\]"; filename="Announcement\.gif"/,
  )
  assert.equal(
    multipart.contentLength,
    multipart.json.length +
      multipart.files[0].header.length +
      attachment.size +
      multipart.files[0].footer.length +
      multipart.closing.length,
  )
})

test('uses the server boost tier to determine its Discord upload limit', () => {
  assert.equal(
    discordUploadLimit({ guild: { premiumTier: 0 } }),
    10 * 1024 * 1024,
  )
  assert.equal(
    discordUploadLimit({ guild: { premiumTier: 2 } }),
    50 * 1024 * 1024,
  )
  assert.equal(
    discordUploadLimit({ guild: { premiumTier: 3 } }),
    100 * 1024 * 1024,
  )
})

test('builds a direct GIF preview payload without forwarding or embedding it', () => {
  const payload = buildDirectMediaPayload(
    { allowedMentions: { parse: [] } },
    [
      {
        url: 'https://cdn.discordapp.com/attachments/channel/message/Announcement.gif?signature=fresh',
      },
    ],
  )

  assert.equal(
    payload.content,
    'https://cdn.discordapp.com/attachments/channel/message/Announcement.gif?signature=fresh',
  )
  assert.deepEqual(payload.allowedMentions, { parse: [] })
  assert.equal(payload.embeds, undefined)
})

test('falls back to a direct media preview before uploading an oversized GIF', async () => {
  const sent = []
  const message = await sendDiscordAttachments(
    { token: 'test-token' },
    {
      guild: { premiumTier: 0 },
      send: async (payload) => {
        sent.push(payload)
        return { id: 'fallback-message' }
      },
    },
    [
      {
        name: 'Announcement.gif',
        contentType: 'image/gif',
        size: 121_214_226,
        url: 'https://cdn.discordapp.com/attachments/channel/message/Announcement.gif?signature=fresh',
      },
    ],
    { allowedMentions: { parse: [] } },
  )

  assert.equal(message.id, 'fallback-message')
  assert.equal(sent.length, 1)
  assert.match(sent[0].content, /Announcement\.gif\?signature=fresh$/)
  assert.equal(sent[0].embeds, undefined)
})

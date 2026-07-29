import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStreamingMultipart } from '../src/discord-upload.js'

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

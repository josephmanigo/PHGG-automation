import assert from 'node:assert/strict'
import test from 'node:test'
import {
  announcementDateLabel,
  announcementMessageSignature,
  attachmentImageEmbeds,
  nextScheduledRunKey,
  replaceAnnouncementDate,
  scheduledRunKey,
} from '../src/announcements.js'

const schedule = {
  timezone: 'Asia/Manila',
  weekday: 'Tuesday',
  time: '11:30',
}

test('matches Tuesday at 11:30 AM Philippine time', () => {
  assert.equal(scheduledRunKey(new Date('2026-07-28T03:30:00.000Z'), schedule), '2026-07-28')
})

test('does not run before, after, or on another weekday', () => {
  assert.equal(scheduledRunKey(new Date('2026-07-28T03:29:59.000Z'), schedule), null)
  assert.equal(scheduledRunKey(new Date('2026-07-28T03:31:00.000Z'), schedule), null)
  assert.equal(scheduledRunKey(new Date('2026-07-29T03:30:00.000Z'), schedule), null)
})

test('uses the next Tuesday date for a manual scheduler test', () => {
  assert.equal(
    nextScheduledRunKey(new Date('2026-07-29T03:30:00.000Z'), schedule),
    '2026-08-04',
  )
  assert.equal(
    nextScheduledRunKey(new Date('2026-07-28T01:00:00.000Z'), schedule),
    '2026-07-28',
  )
})

test('updates the labeled mobile announcement date', () => {
  const label = announcementDateLabel('2026-07-28')
  assert.equal(label, 'July 28, 2026 (Tuesday)')
  assert.equal(
    replaceAnnouncementDate(
      '📅 **DATE:** July 21, 2026 (Tuesday)\n⏰ **TIME:** 8:00PM',
      label,
    ),
    '📅 **DATE:** July 28, 2026 (Tuesday)\n⏰ **TIME:** 8:00PM',
  )
})

test('reposts attachment GIFs as normal memory-safe image embeds', () => {
  const embeds = attachmentImageEmbeds({
    attachments: new Map([
      [
        'gif',
        {
          name: 'Announcement.gif',
          url: 'https://cdn.discordapp.com/attachments/banner.gif',
        },
      ],
    ]),
  })
  assert.equal(
    embeds[0].toJSON().image.url,
    'https://cdn.discordapp.com/attachments/banner.gif',
  )
  assert.deepEqual(attachmentImageEmbeds({ attachments: new Map() }), [])
})

test('deduplicates a source GIF attachment against its normal image embed', () => {
  const source = {
    content: '',
    attachments: new Map([
      [
        'gif',
        {
          url: 'https://cdn.discordapp.com/attachments/123/456/banner.gif?ex=new-signature',
        },
      ],
    ]),
    embeds: [],
  }
  const posted = {
    content: '',
    attachments: new Map(),
    embeds: [
      {
        title: null,
        description: null,
        url: null,
        image: {
          url: 'https://media.discordapp.net/attachments/123/456/banner.gif?ex=old-signature',
        },
        thumbnail: null,
        video: null,
        fields: [],
      },
    ],
  }

  assert.equal(
    announcementMessageSignature(source),
    announcementMessageSignature(posted),
  )
})

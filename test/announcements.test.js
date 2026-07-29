import assert from 'node:assert/strict'
import test from 'node:test'
import {
  announcementDateLabel,
  announcementMessageSignature,
  nextScheduledRunKey,
  replaceAnnouncementDate,
  replaceAnnouncementDetailEmojis,
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

test('uses normal announcement detail emojis', () => {
  assert.equal(
    replaceAnnouncementDetailEmojis(
      [
        ':emoji_150: **DATE:** August 4, 2026 (Tuesday)',
        ':emoji_157: **TIME:** 8:00PM PH Time',
        ':PIN: **ROUNDS:** 4 Rounds | 2SB-1DV-1SI',
        ':pinned: Important: Registrations must be updated.',
      ].join('\n'),
    ),
    [
      '📅 **DATE:** August 4, 2026 (Tuesday)',
      '⏰ **TIME:** 8:00PM PH Time',
      '📌 **ROUNDS:** 4 Rounds | 2SB-1DV-1SI',
      '📌 Important: Registrations must be updated.',
    ].join('\n'),
  )
})

test('normalizes refreshed Discord attachment URLs for deduplication', () => {
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
    attachments: new Map([
      [
        'copied-gif',
        {
          url: 'https://media.discordapp.net/attachments/123/456/banner.gif?ex=old-signature',
        },
      ],
    ]),
    embeds: [],
  }

  assert.equal(
    announcementMessageSignature(source),
    announcementMessageSignature(posted),
  )
})

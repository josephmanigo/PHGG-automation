import assert from 'node:assert/strict'
import test from 'node:test'
import {
  announcementDateLabel,
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

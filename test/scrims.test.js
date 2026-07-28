import assert from 'node:assert/strict'
import test from 'node:test'
import {
  makeTeam,
  parseCancelContent,
  parseMineContent,
  ScrimBoard,
  slotCode,
  validateRegistrationContent,
} from '../src/scrims/core.js'
import { isRegistrationOpener } from '../src/scrims/automation.js'

test('parses one or more flag registration lines atomically', () => {
  const result = validateRegistrationContent(
    ['ABC - ALPHA TEAM | 🇵🇭', 'XYZ - BRAVO TEAM | 🇵🇭'].join('\n'),
  )
  assert.equal(result.valid, true)
  assert.deepEqual(
    result.teams.map(({ tag, name }) => ({ tag, name })),
    [
      { tag: 'ABC', name: 'ALPHA TEAM' },
      { tag: 'XYZ', name: 'BRAVO TEAM' },
    ],
  )

  assert.deepEqual(validateRegistrationContent('ABC - ALPHA | 🇵🇭\nbad line'), {
    valid: false,
    teams: [],
  })
})

test('rejects the old flag-first registration format and non-Philippine flags', () => {
  assert.equal(validateRegistrationContent('🇵🇭 | ABC - ALPHA TEAM').valid, false)
  assert.equal(validateRegistrationContent('ABC - ALPHA TEAM | 🇺🇸').valid, false)
})

test('recognizes the official mobile registration opening GIF asset', () => {
  const message = {
    content: '',
    author: { id: 'unlisted-user' },
    attachments: new Map([
      [
        '1531588588372885615',
        {
          id: '1531588588372885615',
          name: 'mobile-registration.gif',
          url: 'https://cdn.discordapp.com/attachments/channel/1531588588372885615/file.gif',
          contentType: 'image/gif',
        },
      ],
    ]),
    embeds: [],
  }
  assert.equal(
    isRegistrationOpener(message, {
      bannerAssetId: '1531588588372885615',
      openerIds: new Set(),
    }),
    true,
  )
})

test('fills slots, then waitlist, and prevents duplicates', () => {
  const board = new ScrimBoard(2)
  assert.equal(board.register(makeTeam('A', 'ALPHA')).status, 'slot')
  assert.equal(board.register(makeTeam('B', 'BRAVO')).status, 'slot')
  assert.equal(board.register(makeTeam('C', 'CHARLIE')).status, 'waitlist')
  assert.equal(board.register(makeTeam('A', 'ALPHA')).status, 'duplicate')
  assert.equal(board.waitlist.length, 1)
})

test('cancellation promotes the first waiting team into the exact slot', () => {
  const board = new ScrimBoard(2)
  board.register(makeTeam('A', 'ALPHA'))
  board.register(makeTeam('B', 'BRAVO'))
  board.register(makeTeam('C', 'CHARLIE'))

  const result = board.cancel('ALPHA', 'cancel-message')
  assert.equal(result.status, 'slot_removed')
  assert.equal(result.slotIndex, 0)
  assert.equal(board.slots[0].name, 'CHARLIE')
  assert.equal(board.waitlist.length, 0)
})

test('a MINE reply takes the canceled slot and restores the promoted team', () => {
  const board = new ScrimBoard(2)
  board.register(makeTeam('A', 'ALPHA'))
  board.register(makeTeam('B', 'BRAVO'))
  board.register(makeTeam('C', 'CHARLIE'))
  board.cancel('ALPHA', 'cancel-message')

  const result = board.claim('D - DELTA', 'cancel-message', 'claim-message')
  assert.equal(result.status, 'claimed')
  assert.equal(board.slots[0].name, 'DELTA')
  assert.equal(board.waitlist[0].name, 'CHARLIE')
})

test('parses cancellation commands and slot labels', () => {
  assert.equal(parseCancelContent('CANCEL - Alpha Team'), 'Alpha Team')
  assert.equal(parseMineContent('mine: ABC Alpha Team'), 'ABC Alpha Team')
  assert.equal(slotCode(0), '01A')
  assert.equal(slotCode(24), '25Y')
})

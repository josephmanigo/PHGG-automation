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

test('parses PHGG flag-last registration lines atomically', () => {
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

  assert.deepEqual(validateRegistrationContent('ABC - ALPHA |🇵🇭\nbad line'), {
    valid: false,
    teams: [],
  })
})

test('accepts the exact displayed AMT registration format', () => {
  const result = validateRegistrationContent('AMT - THE UNCLAIMED | 🇵🇭')
  assert.equal(result.valid, true)
  assert.deepEqual(
    result.teams.map(({ tag, name }) => ({ tag, name })),
    [{ tag: 'AMT', name: 'THE UNCLAIMED' }],
  )
})

test('requires the Philippine flag at the end', () => {
  assert.equal(validateRegistrationContent('ABC - ALPHA TEAM | 🇵🇭').valid, true)
  assert.equal(validateRegistrationContent('2EZ4 - TEST TEAM |🇵🇭').valid, true)
  assert.equal(validateRegistrationContent('🇵🇭 | ABC - ALPHA TEAM').valid, false)
  assert.equal(validateRegistrationContent('ABC - ALPHA TEAM | 🇺🇸').valid, false)
})

test('recognizes only the configured registration starter asset', () => {
  const message = {
    content: '',
    author: { id: 'unlisted-user' },
    attachments: new Map([
      [
        '1531385927811989674',
        {
          id: '1531385927811989674',
          name: 'mobile-registration.gif',
          url: 'https://media.discordapp.net/attachments/1345795374962704465/1531385927811989674/Mob_Reg.gif',
          contentType: 'image/gif',
        },
      ],
    ]),
    embeds: [],
  }
  assert.equal(
    isRegistrationOpener(message, {
      bannerAssetId: '1531385928105594940',
      bannerSignalIds: new Set(['1531385927811989674']),
      openerIds: new Set(),
    }),
    true,
  )
})

test('recognizes the configured starter by Discord message ID', () => {
  const message = {
    id: '1531385928105594940',
    content: '',
    author: { id: 'unlisted-user' },
    attachments: new Map(),
    embeds: [],
  }
  assert.equal(
    isRegistrationOpener(message, {
      bannerAssetId: '1531385928105594940',
      bannerSignalIds: new Set(['1531385927811989674']),
      openerIds: new Set(),
    }),
    true,
  )
})

test('rejects a different GIF even when posted by an administrator', () => {
  assert.equal(
    isRegistrationOpener(
      {
        id: 'admin-starter',
        content: '',
        author: { id: 'server-admin' },
        member: { permissions: { has: () => true } },
        attachments: new Map([
          [
            'admin-gif',
            {
              id: 'admin-gif',
              name: 'scrimmage.gif',
              url: 'https://cdn.discordapp.com/admin-scrimmage.gif',
              contentType: 'image/gif',
            },
          ],
        ]),
        embeds: [],
      },
      {
        bannerAssetId: 'different-id',
        bannerSignalIds: new Set(['different-asset']),
        openerIds: new Set(),
      },
    ),
    false,
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

test('keeps a duplicate registration on the board only once', () => {
  const board = new ScrimBoard(25)
  const team = makeTeam('AMT', 'THE UNCLAIMED')
  assert.equal(board.register(team).status, 'slot')
  assert.equal(board.register(team).status, 'duplicate')
  assert.equal(board.slots.filter(Boolean).length, 1)
  assert.equal(board.waitlist.length, 0)
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

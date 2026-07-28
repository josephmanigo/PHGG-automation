import assert from 'node:assert/strict'
import test from 'node:test'
import { containsLinkKeyword, selectBestInvite } from '../src/invite-links.js'

test('detects the word link anywhere in a sentence', () => {
  assert.equal(containsLinkKeyword('link'), true)
  assert.equal(containsLinkKeyword('Can someone send the LINK please?'), true)
  assert.equal(containsLinkKeyword('Where is the link for the server'), true)
})

test('does not trigger on words that merely contain link', () => {
  assert.equal(containsLinkKeyword('hyperlink'), false)
  assert.equal(containsLinkKeyword('linktree'), false)
  assert.equal(containsLinkKeyword('connected'), false)
})

test('prefers a permanent unlimited server invite', () => {
  const invites = new Map([
    [
      'temporary',
      {
        code: 'temporary',
        url: 'https://discord.gg/temporary',
        temporary: false,
        expiresTimestamp: Date.now() + 60_000,
        maxUses: 10,
        uses: 1,
      },
    ],
    [
      'official',
      {
        code: 'official',
        url: 'https://discord.gg/official',
        temporary: false,
        expiresTimestamp: null,
        maxUses: 0,
        uses: 50,
      },
    ],
  ])
  assert.equal(selectBestInvite(invites).code, 'official')
})

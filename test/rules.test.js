import assert from 'node:assert/strict'
import test from 'node:test'
import { scrimRulesResponses } from '../src/rules.js'

function rulesMessage(id, content, createdTimestamp) {
  return {
    id,
    content,
    createdTimestamp,
    attachments: new Map(),
    embeds: [],
  }
}

test('paginates long scrim rules within Discord embed limits', () => {
  const pages = scrimRulesResponses(
    [
      rulesMessage('rules-2', 'B'.repeat(3_700), 2),
      rulesMessage('rules-1', 'A'.repeat(3_700), 1),
    ],
    {
      color: 0xed1c24,
      guildId: 'guild',
      channelId: 'rules-channel',
    },
  )

  assert.equal(pages.length, 2)
  assert.equal(pages[0].embeds.length, 1)
  assert.equal(pages[1].embeds.length, 1)
  assert.ok(pages.every((page) => page.embeds[0].data.description.length <= 3_800))
  assert.equal(pages[0].components.length, 1)
  assert.equal(pages[1].components.length, 0)
  assert.match(
    pages[0].components[0].components[0].data.url,
    /\/rules-channel\/rules-1$/,
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { scrimRulesResponses } from '../src/rules.js'

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

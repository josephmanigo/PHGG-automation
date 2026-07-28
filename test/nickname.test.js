import assert from 'node:assert/strict'
import test from 'node:test'
import { formatNickname, parseRenameTargets } from '../src/nickname.js'

test('formats a player nickname', () => {
  assert.deepEqual(formatNickname('6night | TiSAYwho - player'), {
    ok: true,
    nickname: '6NIGHT | TiSAYwho - Player',
  })
})

test('formats a handler nickname', () => {
  assert.deepEqual(formatNickname('ss | KULIT - handler'), {
    ok: true,
    nickname: 'SS | KULIT - Handler',
  })
})

test('normalizes spacing around separators', () => {
  assert.deepEqual(formatNickname('NR|Ems-Handler'), {
    ok: true,
    nickname: 'NR | Ems - Handler',
  })
})

test('rejects a nickname without Player or Handler', () => {
  const result = formatNickname('NR | Ems')
  assert.equal(result.ok, false)
})

test('rejects unsupported roles', () => {
  const result = formatNickname('NR | Ems - Admin')
  assert.equal(result.ok, false)
})

test('pairs bulk nickname requests with mentions', () => {
  const result = parseRenameTargets(
    'SS | KULIT - Handler <@123456789012345678> NR | Ems - Player <@987654321098765432>',
  )
  assert.equal(result.allNamed, true)
  assert.deepEqual([...result.requests], [
    ['123456789012345678', 'SS | KULIT - Handler'],
    ['987654321098765432', 'NR | Ems - Player'],
  ])
})

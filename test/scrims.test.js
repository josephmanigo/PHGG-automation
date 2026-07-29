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
import {
  buildEmbeds,
  isAdminRegistrationOpener,
  isAutomatedRegistrationOpener,
  isRegistrationOpener,
  replayScrimEvents,
  SCRIM_CHECK_REACTION_ID,
  SCRIM_CROSS_REACTION_ID,
} from '../src/scrims/automation.js'

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

test('uses the configured PHGG custom registration reactions', () => {
  assert.equal(SCRIM_CHECK_REACTION_ID, '1472902880120934431')
  assert.equal(SCRIM_CROSS_REACTION_ID, '1531747414380253335')
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

test('recognizes the PC starter GIF attachment signal', () => {
  const message = {
    id: 'pc-starter-message',
    content: '',
    author: { id: 'unlisted-user' },
    attachments: new Map([
      [
        '1531386417123426384',
        {
          id: '1531386417123426384',
          name: 'PC_reg.gif',
          url: 'https://media.discordapp.net/attachments/1340963116954947635/1531386417123426384/PC_reg.gif',
        },
      ],
    ]),
    embeds: [],
  }
  assert.equal(
    isRegistrationOpener(message, {
      bannerAssetId: '1531386417434071191',
      bannerSignalIds: new Set(['1531386417123426384']),
      openerIds: new Set(),
    }),
    true,
  )
})

test('recognizes only the bot-owned copied mobile starter GIF', () => {
  const message = {
    id: 'copied-mobile-starter',
    content: '',
    author: { id: 'phgg-bot' },
    attachments: new Map([
      [
        'new-discord-attachment',
        {
          id: 'new-discord-attachment',
          name: 'Mob_Reg.gif',
          url: 'https://cdn.discordapp.com/new-discord-attachment/Mob_Reg.gif',
        },
      ],
    ]),
    embeds: [],
  }
  const config = {
    automatedStarterAttachmentNames: new Set(['Mob_Reg.gif']),
  }
  assert.equal(
    isAutomatedRegistrationOpener(message, config, 'phgg-bot'),
    true,
  )
  assert.equal(
    isAutomatedRegistrationOpener(
      { ...message, author: { id: 'another-user' } },
      config,
      'phgg-bot',
    ),
    false,
  )
})

test('recognizes the bot-owned copied PC starter GIF', () => {
  const message = {
    id: 'copied-pc-starter',
    content: '',
    author: { id: 'phgg-bot' },
    attachments: new Map([
      [
        'new-pc-attachment',
        {
          id: 'new-pc-attachment',
          name: 'PC_reg.gif',
          url: 'https://cdn.discordapp.com/new-pc-attachment/PC_reg.gif',
        },
      ],
    ]),
    embeds: [],
  }
  assert.equal(
    isAutomatedRegistrationOpener(
      message,
      { automatedStarterAttachmentNames: new Set(['PC_reg.gif']) },
      'phgg-bot',
    ),
    true,
  )
})

test('recognizes an administrator-owned copied mobile starter GIF', () => {
  const message = {
    id: 'admin-mobile-starter',
    content: '',
    author: { id: 'server-admin' },
    member: { permissions: { has: () => true } },
    attachments: new Map([
      [
        'new-admin-attachment',
        {
          id: 'new-admin-attachment',
          name: 'Mob_Reg.gif',
          url: 'https://cdn.discordapp.com/new-admin-attachment/Mob_Reg.gif',
        },
      ],
    ]),
    embeds: [],
  }
  const config = {
    automatedStarterAttachmentNames: new Set(['Mob_Reg.gif']),
  }
  assert.equal(isAdminRegistrationOpener(message, config), true)
  assert.equal(
    isAdminRegistrationOpener(
      {
        ...message,
        member: { permissions: { has: () => false } },
      },
      config,
    ),
    false,
  )
})

test('recognizes a renamed GIF file uploaded by an administrator', () => {
  assert.equal(
    isAdminRegistrationOpener(
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
        automatedStarterAttachmentNames: new Set(['Mob_Reg.gif']),
      },
    ),
    true,
  )
})

test('rejects an admin upload that is not a GIF', () => {
  assert.equal(
    isAdminRegistrationOpener(
      {
        id: 'admin-static-image',
        content: '',
        author: { id: 'server-admin' },
        member: { permissions: { has: () => true } },
        attachments: new Map([
          [
            'admin-image',
            {
              id: 'admin-image',
              name: 'scrimmage.png',
              url: 'https://cdn.discordapp.com/admin-scrimmage.png',
              contentType: 'image/png',
            },
          ],
        ]),
        embeds: [],
      },
      {
        automatedStarterAttachmentNames: new Set(['Mob_Reg.gif']),
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

test('renders the exact 20-slot PHGG board layout', () => {
  const board = new ScrimBoard(20)
  board.register(makeTeam('AMT', 'THE UNCLAIMED'))
  const state = {
    cycleStartMessageId: 'starter-message',
    lastRenderedDate: '',
  }
  const [embed] = buildEmbeds(
    board,
    state,
    {
      label: 'MOBILE',
      title: 'PH GAMING GUILD BS OPERATION: DOMINATION',
      titleEmojiId: '1337103312989716592',
      timeLabel: '8:00PM PH Time',
      roundsLabel: '4 Rounds | 2SB-1DV-1SI',
      emptyWaitlistRows: 4,
      bannerUrl: '',
    },
    {
      brandName: 'PHGG',
      color: 0xed1c24,
      timezone: 'Asia/Manila',
    },
  )
  const rendered = embed.toJSON()
  assert.equal(
    rendered.title,
    '<:phgg:1337103312989716592> PH GAMING GUILD BS OPERATION: DOMINATION <:phgg:1337103312989716592>',
  )
  assert.match(rendered.description, /\*\*TIME:\*\* 8:00PM PH Time/)
  assert.match(rendered.description, /\*\*ROUNDS:\*\* 4 Rounds \| 2SB-1DV-1SI/)
  assert.ok(rendered.description.includes('01A  :  AMT - THE UNCLAIMED | PH'))
  assert.ok(rendered.description.includes('20T  :'))
  assert.ok(rendered.description.includes('## WAIT LIST'))
  assert.ok(rendered.description.includes('01   :'))
  assert.equal(rendered.footer, undefined)
})

test('renders the exact 25-slot PC board layout', () => {
  const board = new ScrimBoard(25)
  board.register(makeTeam('NR', 'NIGHTRAID ESPORTS'))
  const state = {
    cycleStartMessageId: 'pc-starter-message',
    lastRenderedDate: '',
  }
  const [embed] = buildEmbeds(
    board,
    state,
    {
      label: 'PC',
      title: 'PH GAMING GUILD BS OPERATION: DOMINATION',
      titleEmojiId: '1337103312989716592',
      timeLabel: '10:00PM PH Time',
      roundsLabel: '4 Rounds | 2SB-1DV-1SI',
      emptyWaitlistRows: 11,
      waitlistStartAtZero: true,
      padTeamTags: true,
      bannerUrl: '',
    },
    {
      brandName: 'PHGG',
      color: 0xed1c24,
      timezone: 'Asia/Manila',
    },
  )
  const rendered = embed.toJSON()
  assert.match(rendered.description, /\*\*TIME:\*\* 10:00PM PH Time/)
  assert.ok(rendered.description.includes('01A  :  NR    - NIGHTRAID ESPORTS | PH'))
  assert.ok(rendered.description.includes('25Y  :'))
  assert.ok(rendered.description.includes('00   :'))
  assert.ok(rendered.description.includes('10   :'))
  assert.ok(!rendered.description.includes('11   :'))
})

test('rebuild uses only an edited registration message’s latest content', () => {
  const board = new ScrimBoard(20)
  const originalMessage = {
    id: 'registration-message',
    content: 'OLD - ORIGINAL TEAM | 🇵🇭',
  }
  replayScrimEvents(board, [
    { type: 'registration', message: originalMessage },
  ])
  assert.equal(board.slots[0].name, 'ORIGINAL TEAM')

  board.reset()
  replayScrimEvents(board, [
    {
      type: 'registration',
      message: {
        ...originalMessage,
        content: 'NEW - UPDATED TEAM | 🇵🇭',
      },
    },
  ])
  assert.equal(board.find('ORIGINAL TEAM'), null)
  assert.equal(board.slots[0].tag, 'NEW')
  assert.equal(board.slots[0].name, 'UPDATED TEAM')
})

test('rebuild removes a deleted registration from team slots', () => {
  const board = new ScrimBoard(20)
  replayScrimEvents(board, [
    {
      type: 'registration',
      message: {
        id: 'registration-message',
        content: 'AMT - THE UNCLAIMED | 🇵🇭',
      },
    },
  ])
  assert.equal(board.slots.filter(Boolean).length, 1)

  board.reset()
  replayScrimEvents(board, [])
  assert.equal(board.slots.filter(Boolean).length, 0)
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
  assert.equal(parseCancelContent('CANCEL Alpha Team'), null)
  assert.equal(parseMineContent('MINE ABC Alpha Team'), null)
  assert.equal(parseCancelContent('CANCEL -'), null)
  assert.equal(parseMineContent('MINE -'), null)
  assert.equal(slotCode(0), '01A')
  assert.equal(slotCode(24), '25Y')
})

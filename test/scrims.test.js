import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAdminNoteContent,
  isAvailableSlotsCommand,
  makeTeam,
  parseAvailableSlotsContent,
  parseCancelContent,
  parseMineContent,
  ScrimBoard,
  slotCode,
  validateRegistrationContent,
} from '../src/scrims/core.js'
import {
  BOARD_ALARM_CLOCK_EMOJI_ID,
  BOARD_CALENDAR_EMOJI_ID,
  BOARD_PUSHPIN_EMOJI_ID,
  buildBoardContent,
  isCancelChannelAdminNotice,
  isAdminRegistrationMediaNotice,
  isAdminRegistrationOpener,
  isAutomatedRegistrationOpener,
  isCurrentScrimCycle,
  isRegistrationOpener,
  replayScrimEvents,
  SCRIM_CHECK_REACTION_ID,
  SCRIM_CROSS_REACTION_ID,
  selectCurrentScrimBoard,
} from '../src/scrims/automation.js'

test('opens boards only for a current registration starter cycle', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z')
  assert.equal(
    isCurrentScrimCycle(now - 71 * 60 * 60 * 1_000, now),
    true,
  )
  assert.equal(
    isCurrentScrimCycle(now - 73 * 60 * 60 * 1_000, now),
    false,
  )
})

test('recovers the newest bot board from the current starter cycle', () => {
  const title = 'PH GAMING GUILD BS OPERATION: DOMINATION'
  const message = (id, authorId, createdTimestamp) => ({
    id,
    author: { id: authorId },
    content: `# ${title}`,
    embeds: [],
    createdTimestamp,
  })
  const selected = selectCurrentScrimBoard(
    [
      message('previous-cycle', 'bot', 1_000),
      message('current-older', 'bot', 2_100),
      message('human-board', 'staff', 2_300),
      message('current-newest', 'bot', 2_400),
    ],
    {
      botUserId: 'bot',
      brandName: 'PHGG',
      label: 'MOBILE',
      title,
      cycleStartedAt: 2_000,
    },
  )

  assert.equal(selected.id, 'current-newest')
})

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

test('uses the configured animated board detail emojis', () => {
  assert.equal(BOARD_CALENDAR_EMOJI_ID, '1436064495939354634')
  assert.equal(BOARD_ALARM_CLOCK_EMOJI_ID, '1259806144080248894')
  assert.equal(BOARD_PUSHPIN_EMOJI_ID, '1240329558033436722')
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

test('recognizes a bot-forwarded mobile starter GIF snapshot', () => {
  const message = {
    id: 'forwarded-mobile-starter',
    content: '',
    author: { id: 'phgg-bot' },
    attachments: new Map(),
    embeds: [],
    messageSnapshots: new Map([
      [
        '1531385928105594940',
        {
          id: '1531385928105594940',
          content: '',
          attachments: new Map([
            [
              '1531385927811989674',
              {
                id: '1531385927811989674',
                name: 'Mob_Reg.gif',
                url: 'https://cdn.discordapp.com/attachments/Mob_Reg.gif',
              },
            ],
          ]),
          embeds: [],
        },
      ],
    ]),
  }
  const config = {
    bannerAssetId: '1531385928105594940',
    bannerSignalIds: new Set(['1531385927811989674']),
    automatedStarterAttachmentNames: new Set(['Mob_Reg.gif']),
  }

  assert.equal(isRegistrationOpener(message, config), true)
  assert.equal(
    isAutomatedRegistrationOpener(message, config, 'phgg-bot'),
    true,
  )
})

test('recognizes a bot-posted mobile starter GIF image embed', () => {
  const message = {
    id: 'embedded-mobile-starter',
    content: '',
    author: { id: 'phgg-bot' },
    attachments: new Map(),
    embeds: [
      {
        image: {
          url: 'https://cdn.discordapp.com/attachments/1345795374962704465/1531385927811989674/Mob_Reg.gif',
        },
      },
    ],
  }
  const config = {
    bannerAssetId: '1531385928105594940',
    bannerSignalIds: new Set(['1531385927811989674']),
    automatedStarterAttachmentNames: new Set(['Mob_Reg.gif']),
  }

  assert.equal(isRegistrationOpener(message, config), true)
  assert.equal(
    isAutomatedRegistrationOpener(message, config, 'phgg-bot'),
    true,
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

test('ignores an admin GIF divider without treating it as the starter', () => {
  const message = {
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
  }
  const config = {
    automatedStarterAttachmentNames: new Set(['Mob_Reg.gif']),
  }
  assert.equal(isAdminRegistrationMediaNotice(message), true)
  assert.equal(isAdminRegistrationOpener(message, config), false)
})

test('ignores a Discord GIF embed posted by staff without opening registration', () => {
  const message = {
    id: 'admin-gif-embed',
    content: '',
    author: { id: 'server-admin' },
    member: { permissions: { has: () => true } },
    attachments: new Map(),
    embeds: [
      {
        data: { type: 'gifv' },
        video: {
          url: 'https://media.discordapp.net/rendered-gif.mp4',
        },
      },
    ],
  }
  assert.equal(isAdminRegistrationMediaNotice(message), true)
  assert.equal(
    isAdminRegistrationOpener(
      message,
      {
        automatedStarterAttachmentNames: new Set(['Mob_Reg.gif']),
      },
    ),
    false,
  )
})

test('ignores a forwarded staff GIF without opening registration', () => {
  const message = {
    id: 'admin-forwarded-gif',
    content: '',
    author: { id: 'server-admin' },
    member: { permissions: { has: () => true } },
    attachments: new Map(),
    embeds: [],
    messageSnapshots: new Map([
      [
        'forwarded-message',
        {
          attachments: new Map([
            [
              'forwarded-gif',
              {
                id: 'forwarded-gif',
                name: 'renamed-file',
                url: 'https://cdn.discordapp.com/forwarded-media',
                contentType: 'image/gif',
              },
            ],
          ]),
          embeds: [],
        },
      ],
    ]),
  }
  assert.equal(isAdminRegistrationMediaNotice(message), true)
  assert.equal(
    isAdminRegistrationOpener(
      message,
      {
        automatedStarterAttachmentNames: new Set(['Mob_Reg.gif']),
      },
    ),
    false,
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

test('seeds the first three PC slots and allows their cancellation', () => {
  const fixedTeams = [
    {
      tag: 'NR',
      name: 'NIGHTRAID ESPORTS',
      countryLabel: 'PH',
    },
    {
      tag: 'SS',
      name: 'RAMPAGE SENTINELS',
      countryLabel: 'PH',
    },
    {
      tag: 'APXS',
      name: 'SYNDICATE',
      countryLabel: 'PH',
    },
  ]
  const board = new ScrimBoard(25, fixedTeams)
  assert.equal(board.slots[0].name, 'NIGHTRAID ESPORTS')
  assert.equal(board.slots[1].name, 'RAMPAGE SENTINELS')
  assert.equal(board.slots[2].name, 'SYNDICATE')
  assert.equal(board.register(makeTeam('NEW', 'NEW TEAM')).slotIndex, 3)
  assert.equal(board.register(makeTeam('NR', 'NIGHTRAID ESPORTS')).status, 'duplicate')
  assert.equal(board.register(makeTeam('SS', 'RAMPAGE SENTINELS')).status, 'duplicate')
  assert.equal(
    board.cancel('NIGHTRAID ESPORTS', 'cancel-seeded').status,
    'slot_removed',
  )
  assert.equal(board.slots[0], null)

  board.reset()
  assert.equal(board.slots[0].name, 'NIGHTRAID ESPORTS')
  assert.equal(board.slots[1].name, 'RAMPAGE SENTINELS')
  assert.equal(board.slots[2].name, 'SYNDICATE')
})

test('renders the exact 20-slot PHGG board layout', () => {
  const board = new ScrimBoard(20)
  board.register(makeTeam('AMT', 'THE UNCLAIMED'))
  const state = {
    cycleStartMessageId: 'starter-message',
    lastRenderedDate: '',
  }
  const rendered = buildBoardContent(
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
  assert.match(
    rendered,
    /^# <:phgg:1337103312989716592> PH GAMING GUILD BS OPERATION: DOMINATION <:phgg:1337103312989716592>/,
  )
  assert.match(
    rendered,
    /\n<a:calendar:1436064495939354634> \*\*DATE:\*\*/,
  )
  assert.match(
    rendered,
    /<a:alarm_clock:1259806144080248894> \*\*TIME:\*\*/,
  )
  assert.match(
    rendered,
    /<a:pushpin:1240329558033436722> \*\*ROUNDS:\*\*/,
  )
  assert.match(rendered, /\*\*TIME:\*\* 8:00PM PH Time/)
  assert.match(rendered, /\*\*ROUNDS:\*\* 4 Rounds \| 2SB-1DV-1SI/)
  assert.ok(rendered.includes('01A  :  AMT - THE UNCLAIMED | PH'))
  assert.ok(rendered.includes('20T  :'))
  assert.ok(rendered.includes('## WAIT LIST'))
  assert.ok(rendered.includes('01   :'))
  assert.ok(!rendered.includes('\u200b'))
})

test('renders the exact 25-slot PC board layout', () => {
  const board = new ScrimBoard(25, [
    {
      tag: 'NR',
      name: 'NIGHTRAID ESPORTS',
      countryLabel: 'PH',
    },
    {
      tag: 'SS',
      name: 'RAMPAGE SENTINELS',
      countryLabel: 'PH',
    },
    {
      tag: 'APXS',
      name: 'SYNDICATE',
      countryLabel: 'PH',
    },
  ])
  const state = {
    cycleStartMessageId: 'pc-starter-message',
    lastRenderedDate: '',
  }
  const rendered = buildBoardContent(
    board,
    state,
    {
      label: 'PC',
      title: 'PH GAMING GUILD BS OPERATION: DOMINATION',
      titleEmojiId: '1337103312989716592',
      timeLabel: '10:00PM PH Time',
      roundsLabel: '4 Rounds | 1SB-1DV-2SI',
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
  assert.match(rendered, /\*\*TIME:\*\* 10:00PM PH Time/)
  assert.match(rendered, /\*\*ROUNDS:\*\* 4 Rounds \| 1SB-1DV-2SI/)
  assert.ok(rendered.includes('01A  :  NR  - NIGHTRAID ESPORTS | PH'))
  assert.ok(rendered.includes('02B  :  SS  - RAMPAGE SENTINELS | PH'))
  assert.ok(rendered.includes('03C  :  APXS  - SYNDICATE | PH'))
  assert.ok(rendered.includes('25Y  :'))
  assert.ok(rendered.includes('00   :'))
  assert.ok(rendered.includes('10   :'))
  assert.ok(!rendered.includes('11   :'))
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

test('cancellation leaves the exact slot mine-only and preserves the waitlist', () => {
  const board = new ScrimBoard(2)
  board.register(makeTeam('A', 'ALPHA'))
  board.register(makeTeam('B', 'BRAVO'))
  board.register(makeTeam('C', 'CHARLIE'))

  const result = board.cancel('ALPHA', 'cancel-message')
  assert.equal(result.status, 'slot_removed')
  assert.equal(result.slotIndex, 0)
  assert.equal(board.slots[0], null)
  assert.equal(board.waitlist[0].name, 'CHARLIE')
  assert.equal(board.mineOnlySlots.has(0), true)

  assert.equal(board.register(makeTeam('D', 'DELTA')).status, 'waitlist')
  assert.equal(board.slots[0], null)
  assert.deepEqual(
    board.waitlist.map((team) => team.name),
    ['CHARLIE', 'DELTA'],
  )
})

test('a MINE reply takes the canceled slot without changing waitlist order', () => {
  const board = new ScrimBoard(2)
  board.register(makeTeam('A', 'ALPHA'))
  board.register(makeTeam('B', 'BRAVO'))
  board.register(makeTeam('C', 'CHARLIE'))
  board.cancel('ALPHA', 'cancel-message')

  const result = board.claim('D - DELTA', 'cancel-message', 'claim-message')
  assert.equal(result.status, 'claimed')
  assert.equal(board.slots[0].name, 'DELTA')
  assert.equal(board.waitlist[0].name, 'CHARLIE')
  assert.equal(board.mineOnlySlots.has(0), false)
})

test('rebuild keeps a canceled slot mine-only instead of promoting registrations', () => {
  const board = new ScrimBoard(2)
  replayScrimEvents(board, [
    {
      type: 'registration',
      message: { id: 'team-a', content: 'A - ALPHA | 🇵🇭' },
    },
    {
      type: 'registration',
      message: { id: 'team-b', content: 'B - BRAVO | 🇵🇭' },
    },
    {
      type: 'registration',
      message: { id: 'team-c', content: 'C - CHARLIE | 🇵🇭' },
    },
    {
      type: 'cancellation',
      message: { id: 'cancel-a', content: 'CANCEL - ALPHA' },
    },
    {
      type: 'registration',
      message: { id: 'team-d', content: 'D - DELTA | 🇵🇭' },
    },
  ])

  assert.equal(board.slots[0], null)
  assert.equal(board.mineOnlySlots.has(0), true)
  assert.deepEqual(
    board.waitlist.map((team) => team.name),
    ['CHARLIE', 'DELTA'],
  )
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

test('parses admin available-slot lists', () => {
  assert.deepEqual(parseAvailableSlotsContent('AVAILABLE SLOT 2, 15 & 16'), [
    1,
    14,
    15,
  ])
  assert.deepEqual(parseAvailableSlotsContent('available slots: 4 and 9'), [
    3,
    8,
  ])
  assert.deepEqual(parseAvailableSlotsContent('**AVAILABLE SLOT 7**'), [6])
  assert.deepEqual(parseAvailableSlotsContent('# Available slot 1,2'), [0, 1])
  assert.deepEqual(
    parseAvailableSlotsContent('# **Available slot 3 & 4**'),
    [2, 3],
  )
  assert.equal(isAvailableSlotsCommand('## **AVAILABLE SLOT TWO**'), true)
  assert.equal(parseAvailableSlotsContent('AVAILABLE SLOT TWO'), null)
  assert.equal(parseAvailableSlotsContent('AVAILABLE SLOT 0'), null)
})

test('recognizes formatted admin NOTE notices and GIF dividers', () => {
  const note = [
    '**NOTE:**',
    '*If a team cancels, we will replace them with a team from the waiting list until 9:30 PM (PH Time).*',
  ].join('\n')
  assert.equal(isAdminNoteContent(note), true)
  assert.equal(isAdminNoteContent('# **NOTE:**\nDivider information'), true)
  assert.equal(isAdminNoteContent('CANCEL - NOTE TEAM'), false)

  assert.equal(
    isCancelChannelAdminNotice({
      content: 'Scrim divider',
      attachments: new Map([
        [
          'divider',
          {
            name: 'divider.gif',
            contentType: 'image/gif',
          },
        ],
      ]),
      embeds: [],
    }),
    true,
  )
  assert.equal(
    isCancelChannelAdminNotice({
      content: note,
      attachments: new Map(),
      embeds: [],
    }),
    true,
  )
  assert.equal(
    isCancelChannelAdminNotice({
      content: 'ordinary message',
      attachments: new Map([
        [
          'image',
          {
            name: 'divider.png',
            contentType: 'image/png',
          },
        ],
      ]),
      embeds: [],
    }),
    false,
  )
})

test('keeps admin-opened slots mine-only and does not promote the waitlist', () => {
  const board = new ScrimBoard(3)
  board.register(makeTeam('A', 'ALPHA'))
  board.register(makeTeam('B', 'BRAVO'))
  board.register(makeTeam('C', 'CHARLIE'))
  board.register(makeTeam('W', 'WAITING TEAM'))

  const result = board.makeSlotsAvailable([1, 2], 'available-message')
  assert.equal(result.status, 'available')
  assert.equal(result.removedTeams[0].name, 'BRAVO')
  assert.equal(result.removedTeams[1].name, 'CHARLIE')
  assert.equal(board.slots[1], null)
  assert.equal(board.slots[2], null)
  assert.equal(board.waitlist[0].name, 'WAITING TEAM')

  assert.equal(board.register(makeTeam('N', 'NEW REGISTRATION')).status, 'waitlist')
  assert.equal(board.slots[1], null)

  const claim = board.claim(
    'MINE - W WAITING TEAM'.replace(/^MINE\s*-\s*/i, ''),
    'available-message',
    'mine-message',
  )
  assert.equal(claim.status, 'claimed')
  assert.equal(claim.slotIndex, 1)
  assert.equal(board.slots[1].name, 'WAITING TEAM')
  assert.equal(board.waitlist.some((team) => team.name === 'WAITING TEAM'), false)

  const secondClaim = board.claim(
    'X SECOND CLAIM',
    'available-message',
    'second-mine-message',
  )
  assert.equal(secondClaim.status, 'claimed')
  assert.equal(secondClaim.slotIndex, 2)
  assert.equal(board.slots[2].name, 'SECOND CLAIM')
  assert.equal(
    board.claim('Y LATE CLAIM', 'available-message').status,
    'not_available',
  )
})

test('rebuild restores admin availability and its ordered MINE replies', () => {
  const board = new ScrimBoard(3)
  replayScrimEvents(board, [
    {
      type: 'registration',
      message: {
        id: 'team-a',
        content: 'A - ALPHA | 🇵🇭',
      },
    },
    {
      type: 'registration',
      message: {
        id: 'team-b',
        content: 'B - BRAVO | 🇵🇭',
      },
    },
    {
      type: 'registration',
      message: {
        id: 'team-c',
        content: 'C - CHARLIE | 🇵🇭',
      },
    },
    {
      type: 'cancellation',
      canManageScrim: true,
      message: {
        id: 'available-slots',
        content: 'AVAILABLE SLOT 2 & 3',
      },
    },
    {
      type: 'cancellation',
      message: {
        id: 'first-mine',
        content: 'MINE - X FIRST CLAIM',
        reference: { messageId: 'available-slots' },
      },
    },
    {
      type: 'cancellation',
      message: {
        id: 'second-mine',
        content: 'MINE - Y SECOND CLAIM',
        reference: { messageId: 'available-slots' },
      },
    },
  ])

  assert.equal(board.slots[0].name, 'ALPHA')
  assert.equal(board.slots[1].name, 'FIRST CLAIM')
  assert.equal(board.slots[2].name, 'SECOND CLAIM')
  assert.equal(board.waitlist.length, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  announcementAllowsMentions,
  announcementDateLabel,
  announcementMessageSignature,
  nextScheduledRunKey,
  pcAnnouncementContent,
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

test('normalizes the stylized Mobile and PC announcement labels', () => {
  const source = [
    '<a:emoji_150:1258450242601484338>   𝐃𝐀𝐓𝐄: July 28, 2026 (Tuesday)',
    '<a:emoji_157:1259806144080248894>   𝐓𝐈𝐌𝐄: 10:00PM',
    '<a:PIN:1237358846922719323>   𝐑𝐎𝐔𝐍𝐃𝐒: 4 Rounds',
    '<a:pinned:1240329558033436722>  𝐈𝐌𝐏𝐎𝐑𝐓𝐀𝐍𝐓: Updated nicknames only.',
  ].join('\n')

  assert.equal(
    replaceAnnouncementDetailEmojis(source),
    [
      '\u{1F4C5} 𝐃𝐀𝐓𝐄: July 28, 2026 (Tuesday)',
      '\u{23F0} 𝐓𝐈𝐌𝐄: 10:00PM',
      '\u{1F4CC} 𝐑𝐎𝐔𝐍𝐃𝐒: 4 Rounds',
      '\u{1F4CC} 𝐈𝐌𝐏𝐎𝐑𝐓𝐀𝐍𝐓: Updated nicknames only.',
    ].join('\n'),
  )
  assert.equal(
    replaceAnnouncementDate(
      '<a:emoji_150:1258450242601484338> 𝐃𝐀𝐓𝐄: July 28, 2026 (Tuesday)',
      'August 4, 2026 (Tuesday)',
    ),
    '<a:emoji_150:1258450242601484338> 𝐃𝐀𝐓𝐄: August 4, 2026 (Tuesday)',
  )
})

test('builds the exact canonical PC announcement format', () => {
  const content = pcAnnouncementContent('August 4, 2026 (Tuesday)')
  assert.equal(
    content,
    [
      "# PH GAMING GUILD'S BS PC SCRIMMAGE OPERATION: DOMINATION <:PHGAMINGGUILDNEWLOGO1:1337103312989716592>",
      '',
      '\u{1F4C5} 𝐃𝐀𝐓𝐄: August 4, 2026 (Tuesday)',
      '\u{23F0} 𝐓𝐈𝐌𝐄: 10:00PM',
      '\u{1F4CC} 𝐑𝐎𝐔𝐍𝐃𝐒: 4 Rounds | 1SB - 1DV - 2SI',
      '',
      '**Registration will start at 12:00 PM PH TIME for today’s scrimmage.**',
      '',
      'Register here: <#1340963116954947635>',
      '',
      '\u{1F4CC} *Important: Registrations with outdated server nicknames will be voided.*',
      '',
      '||@everyone||',
    ].join('\n'),
  )
  assert.equal(content.includes('PRIZE'), false)
})

test('pings everyone for the scheduled PC post but not for /test', () => {
  assert.equal(announcementAllowsMentions(false, 'PC', false), true)
  assert.equal(announcementAllowsMentions(false, 'PC', true), false)
  assert.equal(announcementAllowsMentions(false, 'MOBILE', false), false)
})

test('deduplicates the PC source and its canonical formatted post', () => {
  const source = {
    content: [
      "𝗣𝗛 𝗚𝗔𝗠𝗜𝗡𝗚 𝗚𝗨𝗜𝗟𝗗'𝗦 𝗕𝗦 𝗣𝗖 𝗦𝗖𝗥𝗜𝗠𝗠𝗔𝗚𝗘 𝗢𝗣𝗘𝗥𝗔𝗧𝗜𝗢𝗡: 𝗗𝗢𝗠𝗜𝗡𝗔𝗧𝗜𝗢𝗡",
      '<a:emoji_150:1258450242601484338> 𝐃𝐀𝐓𝐄: July 28, 2026 (Tuesday)',
    ].join('\n'),
    attachments: new Map(),
    embeds: [],
  }
  const posted = {
    content: pcAnnouncementContent('August 4, 2026 (Tuesday)'),
    attachments: new Map(),
    embeds: [],
  }

  assert.equal(
    announcementMessageSignature(source, true, 'PC'),
    announcementMessageSignature(posted, true, 'PC'),
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

test('recognizes an oversized attachment reposted as a direct GIF preview', () => {
  const source = {
    content: '',
    attachments: new Map([
      [
        'gif',
        {
          url: 'https://cdn.discordapp.com/attachments/123/456/banner.gif?ex=source-signature',
        },
      ],
    ]),
    embeds: [],
  }
  const posted = {
    content:
      'https://cdn.discordapp.com/attachments/123/456/banner.gif?ex=posted-signature',
    attachments: new Map(),
    embeds: [],
  }

  assert.equal(
    announcementMessageSignature(source),
    announcementMessageSignature(posted),
  )
})

test('installAnnouncementAutomation registers /test command with optional date parameter', async () => {
  const onceHandlers = []
  const createdCommands = []

  const commandGuild = {
    id: '111',
    name: 'PHGG',
    commands: {
      create: async (def) => {
        createdCommands.push(def)
      },
    },
  }

  const client = {
    guilds: {
      cache: new Map([['111', commandGuild]]),
      fetch: async () => commandGuild,
    },
    once: (event, handler) => onceHandlers.push(handler),
    on: () => {},
  }

  const { installAnnouncementAutomation } = await import('../src/announcements.js')
  installAnnouncementAutomation(client, {
    guildId: '111',
    timezone: 'Asia/Manila',
    weekday: 'Tuesday',
    time: '11:30',
    groups: [{ label: 'PC', enabled: true }],
  })

  for (const handler of onceHandlers) {
    await handler(client)
  }

  assert.equal(createdCommands.length, 1)
  assert.equal(createdCommands[0].name, 'test')
  assert.deepEqual(createdCommands[0].options, [
    {
      name: 'date',
      description: 'Optional date (YYYY-MM-DD). Defaults to today in real time.',
      type: 3,
      required: false,
    },
  ])
})

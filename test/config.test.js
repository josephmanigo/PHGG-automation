import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../src/config.js'

test('loads independent mobile and PC scrim channel sets', () => {
  const keys = [
    'DISCORD_BOT_TOKEN',
    'DISCORD_GUILD_ID',
    'DISCORD_NICKNAME_CHANNEL_ID',
    'DISCORD_RULES_CHANNEL_ID',
    'MOBILE_SCRIM_REGISTRATION_CHANNEL_ID',
    'MOBILE_SCRIM_BOARD_CHANNEL_ID',
    'MOBILE_SCRIM_CANCEL_CHANNEL_ID',
    'PC_SCRIM_REGISTRATION_CHANNEL_ID',
    'PC_SCRIM_BOARD_CHANNEL_ID',
    'PC_SCRIM_CANCEL_CHANNEL_ID',
    'MOBILE_ANNOUNCEMENT_CHANNEL_ID',
    'MOBILE_ANNOUNCEMENT_MESSAGE_IDS',
    'PC_ANNOUNCEMENT_CHANNEL_ID',
    'PC_ANNOUNCEMENT_MESSAGE_IDS',
    'SCRIM_RULES_CHANNEL_ID',
    'SCRIM_RULES_MESSAGE_IDS',
  ]
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_GUILD_ID: 'test-guild',
    MOBILE_SCRIM_REGISTRATION_CHANNEL_ID: 'mobile-registration',
    MOBILE_SCRIM_BOARD_CHANNEL_ID: 'mobile-board',
    MOBILE_SCRIM_CANCEL_CHANNEL_ID: 'mobile-cancel',
    PC_SCRIM_REGISTRATION_CHANNEL_ID: 'pc-registration',
    PC_SCRIM_BOARD_CHANNEL_ID: 'pc-board',
    PC_SCRIM_CANCEL_CHANNEL_ID: 'pc-cancel',
    MOBILE_ANNOUNCEMENT_CHANNEL_ID: 'mobile-announcements',
    MOBILE_ANNOUNCEMENT_MESSAGE_IDS: 'mobile-message-1,mobile-message-2',
    PC_ANNOUNCEMENT_CHANNEL_ID: 'pc-announcements',
    PC_ANNOUNCEMENT_MESSAGE_IDS: 'pc-message-1,pc-message-2',
    SCRIM_RULES_CHANNEL_ID: 'scrim-rules-channel',
    SCRIM_RULES_MESSAGE_IDS: 'scrim-rules-message',
  })

  try {
    const config = loadConfig()
    assert.equal(config.scrims.length, 2)
    assert.deepEqual(
      config.scrims.map(({ label, enabled, channels }) => ({ label, enabled, channels })),
      [
        {
          label: 'MOBILE',
          enabled: true,
          channels: {
            registration: 'mobile-registration',
            board: 'mobile-board',
            cancel: 'mobile-cancel',
          },
        },
        {
          label: 'PC',
          enabled: true,
          channels: {
            registration: 'pc-registration',
            board: 'pc-board',
            cancel: 'pc-cancel',
          },
        },
      ],
    )
    assert.deepEqual(config.announcements.groups, [
      {
        label: 'MOBILE',
        enabled: true,
        channelId: 'mobile-announcements',
        messageIds: ['mobile-message-1', 'mobile-message-2'],
        dateMessageIds: ['1531386979907014667'],
        afterMessages: [
          {
            channelId: '1345795374962704465',
            messageId: '1531385928105594940',
          },
          {
            channelId: '1345800858138574979',
            sourceChannelId: '1340963218582929430',
            messageId: '1531386615472328756',
          },
          {
            channelId: '1345800858138574979',
            sourceChannelId: '1340963218582929430',
            messageId: '1531940434861887610',
          },
        ],
      },
      {
        label: 'PC',
        enabled: true,
        channelId: 'pc-announcements',
        messageIds: ['pc-message-1', 'pc-message-2'],
        dateMessageIds: ['1531386923203952910'],
        afterMessages: [
          {
            channelId: '1340963116954947635',
            messageId: '1531386417434071191',
          },
          {
            channelId: '1340963218582929430',
            sourceChannelId: '1340963218582929430',
            messageId: '1531386615472328756',
          },
          {
            channelId: '1340963218582929430',
            sourceChannelId: '1340963218582929430',
            messageId: '1531940434861887610',
          },
        ],
      },
    ])
    assert.deepEqual(config.rules.scrims, {
      enabled: true,
      channelId: '1345795209417457685',
      messageIds: ['1531917547014721666'],
    })
  } finally {
    for (const [key, oldValue] of previous) {
      if (oldValue === undefined) delete process.env[key]
      else process.env[key] = oldValue
    }
  }
})

test('ignores stale Render overrides for the PHGG scrim rules source', () => {
  const keys = [
    'DISCORD_BOT_TOKEN',
    'DISCORD_GUILD_ID',
    'SCRIM_RULES_CHANNEL_ID',
    'SCRIM_RULES_MESSAGE_IDS',
  ]
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_GUILD_ID: 'test-guild',
    SCRIM_RULES_CHANNEL_ID: 'old-invalid-channel',
    SCRIM_RULES_MESSAGE_IDS: 'old-invalid-message',
  })

  try {
    assert.deepEqual(loadConfig().rules.scrims, {
      enabled: true,
      channelId: '1345795209417457685',
      messageIds: ['1531917547014721666'],
    })
  } finally {
    for (const [key, oldValue] of previous) {
      if (oldValue === undefined) delete process.env[key]
      else process.env[key] = oldValue
    }
  }
})

test('uses PHGG Mobile and PC channel IDs with NightRaid flow defaults', () => {
  const keys = [
    'DISCORD_BOT_TOKEN',
    'DISCORD_GUILD_ID',
    'DISCORD_NICKNAME_CHANNEL_ID',
    'DISCORD_RULES_CHANNEL_ID',
    'MOBILE_SCRIM_REGISTRATION_CHANNEL_ID',
    'MOBILE_SCRIM_BOARD_CHANNEL_ID',
    'MOBILE_SCRIM_CANCEL_CHANNEL_ID',
    'MOBILE_SCRIM_BANNER_ASSET_ID',
    'MOBILE_SCRIM_BANNER_SIGNAL_IDS',
    'MOBILE_SCRIM_BOARD_HEADER_MESSAGE_ID',
    'MOBILE_SCRIM_BOARD_TEMPLATE_MESSAGE_ID',
    'MOBILE_SCRIM_ALWAYS_OPEN',
    'MOBILE_SCRIM_MAX_SLOTS',
    'MOBILE_SCRIM_EMPTY_WAITLIST_ROWS',
    'MOBILE_SCRIM_TITLE',
    'MOBILE_SCRIM_TITLE_EMOJI_ID',
    'MOBILE_SCRIM_TIME_LABEL',
    'MOBILE_SCRIM_ROUNDS_LABEL',
    'SCRIM_REGISTRATION_CHANNEL_ID',
    'SCRIM_BOARD_CHANNEL_ID',
    'SCRIM_CANCEL_CHANNEL_ID',
    'SCRIM_BANNER_ASSET_ID',
    'SCRIM_ALWAYS_OPEN',
    'SCRIM_MAX_SLOTS',
    'SCRIM_EMPTY_WAITLIST_ROWS',
    'PC_SCRIM_REGISTRATION_CHANNEL_ID',
    'PC_SCRIM_BOARD_CHANNEL_ID',
    'PC_SCRIM_CANCEL_CHANNEL_ID',
    'PC_SCRIM_BANNER_ASSET_ID',
    'PC_SCRIM_BANNER_SIGNAL_IDS',
    'PC_SCRIM_BOARD_HEADER_MESSAGE_ID',
    'PC_SCRIM_ALWAYS_OPEN',
    'PC_SCRIM_MAX_SLOTS',
    'PC_SCRIM_EMPTY_WAITLIST_ROWS',
    'PC_SCRIM_WAITLIST_START_AT_ZERO',
    'PC_SCRIM_PAD_TEAM_TAGS',
    'PC_SCRIM_TITLE',
    'PC_SCRIM_TITLE_EMOJI_ID',
    'PC_SCRIM_TIME_LABEL',
    'PC_SCRIM_ROUNDS_LABEL',
    'MOBILE_ANNOUNCEMENT_CHANNEL_ID',
    'MOBILE_ANNOUNCEMENT_MESSAGE_IDS',
    'PC_ANNOUNCEMENT_CHANNEL_ID',
    'PC_ANNOUNCEMENT_MESSAGE_IDS',
  ]
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  Object.assign(process.env, {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_GUILD_ID: 'test-guild',
    MOBILE_SCRIM_ALWAYS_OPEN: 'true',
    MOBILE_SCRIM_TITLE: 'PH GAMING GUILD MOBILE SCRIMMAGE',
    PC_SCRIM_ALWAYS_OPEN: 'true',
    PC_SCRIM_TIME_LABEL: '08:00 PM (PC) PH Time',
    PC_SCRIM_ROUNDS_LABEL: 'STALE RENDER VALUE',
  })

  try {
    const mobile = loadConfig().scrims.find(({ label }) => label === 'MOBILE')
    assert.deepEqual(mobile.channels, {
      registration: '1345795374962704465',
      board: '1345799937358565407',
      cancel: '1345800858138574979',
    })
    assert.equal(mobile.bannerAssetId, '1531385928105594940')
    assert.deepEqual(
      [...mobile.bannerSignalIds],
      ['1531385927811989674'],
    )
    assert.equal(mobile.boardHeaderMessageId, '1531588588372885615')
    assert.equal(mobile.boardTemplateMessageId, '1529059937068777620')
    assert.equal(mobile.alwaysOpen, false)
    assert.equal(mobile.maxSlots, 20)
    assert.equal(mobile.emptyWaitlistRows, 4)
    assert.equal(
      mobile.title,
      'PH GAMING GUILD BS OPERATION: DOMINATION',
    )
    assert.equal(mobile.titleEmojiId, '1337103312989716592')
    assert.equal(mobile.timeLabel, '8:00PM PH Time')
    assert.equal(mobile.roundsLabel, '4 Rounds | 2SB-1DV-1SI')

    const pc = loadConfig().scrims.find(({ label }) => label === 'PC')
    assert.deepEqual(pc.channels, {
      registration: '1340963116954947635',
      board: '1340963180809031721',
      cancel: '1340963218582929430',
    })
    assert.equal(pc.bannerAssetId, '1531386417434071191')
    assert.deepEqual(
      [...pc.bannerSignalIds],
      ['1531386417123426384'],
    )
    assert.equal(pc.boardHeaderMessageId, '1531616934385418320')
    assert.equal(pc.alwaysOpen, false)
    assert.equal(pc.maxSlots, 25)
    assert.equal(pc.emptyWaitlistRows, 11)
    assert.equal(pc.waitlistStartAtZero, true)
    assert.equal(pc.padTeamTags, true)
    assert.equal(
      pc.title,
      'PH GAMING GUILD BS OPERATION: DOMINATION',
    )
    assert.equal(pc.titleEmojiId, '1337103312989716592')
    assert.equal(pc.timeLabel, '10:00PM PH Time')
    assert.equal(pc.roundsLabel, '4 Rounds | 1SB-1DV-2SI')
    assert.deepEqual(pc.fixedTeams, [
      {
        tag: 'NR',
        name: 'NIGHTRAID ESPORTS',
        countryLabel: '🇵🇭',
      },
      {
        tag: 'SS',
        name: 'RAMPAGE SENTINELS',
        countryLabel: '🇵🇭',
      },
      {
        tag: 'APXS',
        name: 'SYNDICATE',
        countryLabel: '🇵🇭',
      },
    ])
    assert.equal(loadConfig().serverInvite.guildId, '1336451755734732861')

    assert.deepEqual(
      loadConfig().announcements.groups.map(
        ({ label, enabled, channelId, messageIds }) => ({
          label,
          enabled,
          channelId,
          messageIds,
        }),
      ),
      [
        {
          label: 'MOBILE',
          enabled: true,
          channelId: '1345793370454495242',
          messageIds: ['1531386132703613029', '1531386979907014667'],
        },
        {
          label: 'PC',
          enabled: true,
          channelId: '1345794008471044176',
          messageIds: ['1531386761190838283', '1531386923203952910'],
        },
      ],
    )

    const defaults = loadConfig()
    assert.deepEqual(defaults.nickname, {
      enabled: true,
      channelId: '1270790990772437073',
    })
    assert.deepEqual(
      {
        enabled: defaults.rules.enabled,
        channelId: defaults.rules.channelId,
      },
      {
        enabled: true,
        channelId: '1345795209417457685',
      },
    )
  } finally {
    for (const [key, oldValue] of previous) {
      if (oldValue === undefined) delete process.env[key]
      else process.env[key] = oldValue
    }
  }
})

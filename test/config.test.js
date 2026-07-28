import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../src/config.js'

test('loads independent mobile and PC scrim channel sets', () => {
  const keys = [
    'DISCORD_BOT_TOKEN',
    'DISCORD_GUILD_ID',
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
      },
      {
        label: 'PC',
        enabled: true,
        channelId: 'pc-announcements',
        messageIds: ['pc-message-1', 'pc-message-2'],
      },
    ])
    assert.deepEqual(config.rules.scrims, {
      enabled: true,
      channelId: 'scrim-rules-channel',
      messageIds: ['scrim-rules-message'],
    })
  } finally {
    for (const [key, oldValue] of previous) {
      if (oldValue === undefined) delete process.env[key]
      else process.env[key] = oldValue
    }
  }
})

test('uses the PHGG scrim rules source when Render overrides are absent', () => {
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
  })
  delete process.env.SCRIM_RULES_CHANNEL_ID
  delete process.env.SCRIM_RULES_MESSAGE_IDS

  try {
    assert.deepEqual(loadConfig().rules.scrims, {
      enabled: true,
      channelId: '1346107866951581817',
      messageIds: ['1412431092031553547'],
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
    'MOBILE_SCRIM_REGISTRATION_CHANNEL_ID',
    'MOBILE_SCRIM_BOARD_CHANNEL_ID',
    'MOBILE_SCRIM_CANCEL_CHANNEL_ID',
    'MOBILE_SCRIM_BANNER_ASSET_ID',
    'MOBILE_SCRIM_ALWAYS_OPEN',
    'MOBILE_SCRIM_MAX_SLOTS',
    'MOBILE_SCRIM_EMPTY_WAITLIST_ROWS',
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
    'PC_SCRIM_ALWAYS_OPEN',
    'PC_SCRIM_MAX_SLOTS',
    'PC_SCRIM_EMPTY_WAITLIST_ROWS',
  ]
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  Object.assign(process.env, {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_GUILD_ID: 'test-guild',
    MOBILE_SCRIM_ALWAYS_OPEN: 'false',
    PC_SCRIM_ALWAYS_OPEN: 'false',
  })

  try {
    const mobile = loadConfig().scrims.find(({ label }) => label === 'MOBILE')
    assert.deepEqual(mobile.channels, {
      registration: '1345795374962704465',
      board: '1345799937358565407',
      cancel: '1345800858138574979',
    })
    assert.equal(mobile.bannerAssetId, '1531588588372885615')
    assert.equal(mobile.alwaysOpen, true)
    assert.equal(mobile.maxSlots, 25)
    assert.equal(mobile.emptyWaitlistRows, 4)

    const pc = loadConfig().scrims.find(({ label }) => label === 'PC')
    assert.deepEqual(pc.channels, {
      registration: '1340963116954947635',
      board: '1340963180809031721',
      cancel: '1340963218582929430',
    })
    assert.equal(pc.bannerAssetId, '1531588588372885615')
    assert.equal(pc.alwaysOpen, true)
    assert.equal(pc.maxSlots, 25)
    assert.equal(pc.emptyWaitlistRows, 4)
  } finally {
    for (const [key, oldValue] of previous) {
      if (oldValue === undefined) delete process.env[key]
      else process.env[key] = oldValue
    }
  }
})

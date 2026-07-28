function value(name, fallback = '') {
  return process.env[name]?.trim() || fallback
}

const DEFAULT_SCRIM_RULES_CHANNEL_ID = '1346107866951581817'
const DEFAULT_SCRIM_RULES_MESSAGE_IDS = '1412431092031553547'
const DEFAULT_SCRIMS = {
  MOBILE: {
    channels: {
      registration: '1345795374962704465',
      board: '1345799937358565407',
      cancel: '1345800858138574979',
    },
    bannerAssetId: '1531385928105594940',
    bannerSignalIds: ['1531385927811989674'],
    boardHeaderMessageId: '1531588588372885615',
    boardTemplateMessageId: '1529059937068777620',
    alwaysOpen: false,
  },
  PC: {
    channels: {
      registration: '1340963116954947635',
      board: '1340963180809031721',
      cancel: '1340963218582929430',
    },
    bannerAssetId: '1531385928105594940',
    alwaysOpen: false,
  },
}

function required(name) {
  const result = value(name)
  if (!result) throw new Error(`Missing required environment variable: ${name}`)
  return result
}

function color(name, fallback) {
  const raw = value(name, fallback).replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(raw)) {
    throw new Error(`${name} must be a six-digit hex color such as #ED1C24.`)
  }
  return Number.parseInt(raw, 16)
}

function idSet(raw) {
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
}

function parseBoolean(name, raw, fallback = false) {
  if (!raw) return fallback
  if (/^(?:1|true|yes|on)$/i.test(raw)) return true
  if (/^(?:0|false|no|off)$/i.test(raw)) return false
  throw new Error(`${name} must be true or false.`)
}

function parseInteger(name, raw, fallback, { min, max }) {
  if (!raw) return fallback
  const result = Number(raw)
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`)
  }
  return result
}

function loadScrimConfig(scope, brandName, { legacy = false } = {}) {
  const defaults = DEFAULT_SCRIMS[scope] ?? {}
  const variable = (suffix) => `${scope}_SCRIM_${suffix}`
  const read = (suffix, fallback = '') => {
    const legacyValue = legacy ? value(`SCRIM_${suffix}`) : ''
    return value(variable(suffix), legacyValue || fallback)
  }
  const channels = {
    registration: read(
      'REGISTRATION_CHANNEL_ID',
      defaults.channels?.registration,
    ),
    board: read('BOARD_CHANNEL_ID', defaults.channels?.board),
    cancel: read('CANCEL_CHANNEL_ID', defaults.channels?.cancel),
  }
  const suppliedChannels = Object.values(channels).filter(Boolean)
  if (suppliedChannels.length > 0 && suppliedChannels.length !== 3) {
    throw new Error(
      `${scope} scrim automation needs its registration, board, and cancel channel IDs together.`,
    )
  }

  return {
    label: scope,
    enabled: suppliedChannels.length === 3,
    channels,
    openerIds: idSet(read('OPENER_IDS')),
    bannerAssetId: read('BANNER_ASSET_ID', defaults.bannerAssetId),
    bannerSignalIds: idSet(
      read('BANNER_SIGNAL_IDS', defaults.bannerSignalIds?.join(',')),
    ),
    bannerUrl: read('BANNER_URL'),
    boardHeaderMessageId: read(
      'BOARD_HEADER_MESSAGE_ID',
      defaults.boardHeaderMessageId,
    ),
    boardTemplateMessageId: read(
      'BOARD_TEMPLATE_MESSAGE_ID',
      defaults.boardTemplateMessageId,
    ),
    alwaysOpen:
      defaults.alwaysOpen ??
      parseBoolean(variable('ALWAYS_OPEN'), read('ALWAYS_OPEN')),
    requireValidNickname: parseBoolean(
      variable('REQUIRE_VALID_NICKNAME'),
      read('REQUIRE_VALID_NICKNAME'),
    ),
    maxSlots: parseInteger(variable('MAX_SLOTS'), read('MAX_SLOTS'), 25, {
      min: 1,
      max: 26,
    }),
    emptyWaitlistRows: parseInteger(
      variable('EMPTY_WAITLIST_ROWS'),
      read('EMPTY_WAITLIST_ROWS'),
      4,
      { min: 1, max: 20 },
    ),
    title: read('TITLE', `${brandName.toUpperCase()} ${scope} SCRIMMAGE SLOT LIST`),
    timeLabel: read('TIME_LABEL', '10:00 PM PH Time'),
    roundsLabel: read('ROUNDS_LABEL', '4 Rounds | 1SB-1DV-2SI'),
  }
}

function loadAnnouncementConfig(scope) {
  const channelId = value(`${scope}_ANNOUNCEMENT_CHANNEL_ID`)
  const messageIds = value(`${scope}_ANNOUNCEMENT_MESSAGE_IDS`)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (Boolean(channelId) !== (messageIds.length > 0)) {
    throw new Error(
      `${scope} announcements need both ${scope}_ANNOUNCEMENT_CHANNEL_ID and ${scope}_ANNOUNCEMENT_MESSAGE_IDS.`,
    )
  }
  return {
    label: scope,
    enabled: Boolean(channelId),
    channelId,
    messageIds,
  }
}

export function loadConfig() {
  const brandName = value('BOT_BRAND_NAME', 'PHGG')
  const nicknameChannelId = value('DISCORD_NICKNAME_CHANNEL_ID')
  const rulesChannelId = value('DISCORD_RULES_CHANNEL_ID')
  const scrimRulesChannelId = value(
    'SCRIM_RULES_CHANNEL_ID',
    DEFAULT_SCRIM_RULES_CHANNEL_ID,
  )
  const scrimRulesMessageIds = value(
    'SCRIM_RULES_MESSAGE_IDS',
    DEFAULT_SCRIM_RULES_MESSAGE_IDS,
  )
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (Boolean(scrimRulesChannelId) !== (scrimRulesMessageIds.length > 0)) {
    throw new Error(
      'The /scrimrules command needs both SCRIM_RULES_CHANNEL_ID and SCRIM_RULES_MESSAGE_IDS.',
    )
  }

  return {
    token: required('DISCORD_BOT_TOKEN'),
    guildId: required('DISCORD_GUILD_ID'),
    brandName,
    color: color('BOT_COLOR', '#ED1C24'),
    timezone: value('BOT_TIMEZONE', 'Asia/Manila'),
    nickname: {
      enabled: Boolean(nicknameChannelId),
      channelId: nicknameChannelId,
    },
    rules: {
      enabled: Boolean(rulesChannelId),
      channelId: rulesChannelId,
      scrims: {
        enabled: Boolean(scrimRulesChannelId),
        channelId: scrimRulesChannelId,
        messageIds: scrimRulesMessageIds,
      },
    },
    scrims: [
      loadScrimConfig('MOBILE', brandName, { legacy: true }),
      loadScrimConfig('PC', brandName),
    ],
    announcements: {
      timezone: value('ANNOUNCEMENT_TIMEZONE', 'Asia/Manila'),
      weekday: value('ANNOUNCEMENT_WEEKDAY', 'Tuesday'),
      time: value('ANNOUNCEMENT_TIME', '11:30'),
      allowMentions: parseBoolean(
        'ANNOUNCEMENT_ALLOW_MENTIONS',
        value('ANNOUNCEMENT_ALLOW_MENTIONS'),
      ),
      groups: [loadAnnouncementConfig('MOBILE'), loadAnnouncementConfig('PC')],
    },
    serverInvite: {
      enabled: parseBoolean(
        'SERVER_INVITE_KEYWORD_ENABLED',
        value(
          'SERVER_INVITE_KEYWORD_ENABLED',
          value('INVITE_LINK_PREVIEW_ENABLED'),
        ),
        true,
      ),
    },
  }
}

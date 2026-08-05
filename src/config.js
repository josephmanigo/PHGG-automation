function value(name, fallback = '') {
  return process.env[name]?.trim() || fallback
}

const DEFAULT_NICKNAME_CHANNEL_ID = '1270790990772437073'
const DEFAULT_RULES_CHANNEL_ID = '1270783545685577871'
const DEFAULT_RULES_MESSAGE_IDS = '1336451755734732861'
const DEFAULT_SCRIM_RULES_CHANNEL_ID = '1345795209417457685'
const DEFAULT_SCRIM_RULES_MESSAGE_IDS =
  '1531917547014721666'
// Each scrim scope reads its screenshots from its own channel, so a MOBILE
// result posted in the MOBILE channel is never picked up by the PC board.
const DEFAULT_TALLY_CHANNEL_ID = '1534258096975904849'
const DEFAULT_MOBILE_TALLY_CHANNEL_ID = '1534503608144363621'
const DEFAULT_ANNOUNCEMENTS = {
  MOBILE: {
    channelId: '1345793370454495242',
    messageIds: ['1531386132703613029', '1531386979907014667'],
  },
  PC: {
    channelId: '1345794008471044176',
    messageIds: ['1531386761190838283', '1531386923203952910'],
  },
}
const ANNOUNCEMENT_DATE_MESSAGE_IDS = {
  MOBILE: ['1531386979907014667'],
  PC: ['1531386923203952910'],
}
const ANNOUNCEMENT_AFTER_MESSAGES = {
  MOBILE: [
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
  PC: [
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
}
const DEFAULT_SCRIMS = {
  MOBILE: {
    channels: {
      registration: '1345795374962704465',
      board: '1345799937358565407',
      cancel: '1345800858138574979',
    },
    bannerAssetId: '1531385928105594940',
    bannerSignalIds: ['1531385927811989674'],
    automatedStarterAttachmentNames: ['Mob_Reg.gif'],
    boardHeaderMessageId: '1531588588372885615',
    boardTemplateMessageId: '1529059937068777620',
    alwaysOpen: false,
    maxSlots: 20,
    emptyWaitlistRows: 4,
    title: 'PH GAMING GUILD BS OPERATION: DOMINATION',
    titleEmojiId: '1337103312989716592',
    timeLabel: '8:00PM PH Time',
    roundsLabel: '4 Rounds | 2SB-1DV-1SI',
  },
  PC: {
    channels: {
      registration: '1340963116954947635',
      board: '1340963180809031721',
      cancel: '1340963218582929430',
    },
    bannerAssetId: '1531386417434071191',
    bannerSignalIds: ['1531386417123426384'],
    automatedStarterAttachmentNames: ['PC_reg.gif'],
    boardHeaderMessageId: '1531616934385418320',
    alwaysOpen: false,
    maxSlots: 25,
    emptyWaitlistRows: 11,
    waitlistStartAtZero: true,
    padTeamTags: true,
    title: 'PH GAMING GUILD BS OPERATION: DOMINATION',
    titleEmojiId: '1337103312989716592',
    timeLabel: '10:00PM PH Time',
    fixedTimeLabel: true,
    roundsLabel: '4 Rounds | 1SB-1DV-2SI',
    fixedRoundsLabel: true,
    fixedTeams: [
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
    ],
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
    // MOBILE previously fell through to '', so its listener never recognised
    // any channel as a tally channel and mobile screenshots were ignored.
    tallyChannelId: read(
      'TALLY_CHANNEL_ID',
      defaults.channels?.tally ||
        (scope === 'PC'
          ? value('GAME_RESULTS_CHANNEL_ID', DEFAULT_TALLY_CHANNEL_ID)
          : scope === 'MOBILE'
            ? DEFAULT_MOBILE_TALLY_CHANNEL_ID
            : ''),
    ),
    // Both scopes write to one spreadsheet by default, which means whichever
    // scrim tallies second overwrites the first. Set
    // MOBILE_SCRIM_SHEETS_SPREADSHEET_ID (or the worksheet name) to give a
    // scope its own scoresheet.
    sheetSpreadsheetId: read('SHEETS_SPREADSHEET_ID', ''),
    sheetWorksheetName: read('SHEETS_WORKSHEET_NAME', ''),
    scorekeeperRoleIds: idSet(
      read('SCOREKEEPER_ROLE_IDS', value('GAME_RESULTS_SCOREKEEPER_ROLE_IDS', '')),
    ),
    openerIds: idSet(read('OPENER_IDS')),
    bannerAssetId: read('BANNER_ASSET_ID', defaults.bannerAssetId),
    bannerSignalIds: idSet(
      read('BANNER_SIGNAL_IDS', defaults.bannerSignalIds?.join(',')),
    ),
    automatedStarterAttachmentNames: new Set(
      defaults.automatedStarterAttachmentNames ?? [],
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
    maxSlots: parseInteger(
      variable('MAX_SLOTS'),
      read('MAX_SLOTS'),
      defaults.maxSlots ?? 25,
      {
      min: 1,
      max: 26,
      },
    ),
    emptyWaitlistRows: parseInteger(
      variable('EMPTY_WAITLIST_ROWS'),
      read('EMPTY_WAITLIST_ROWS'),
      defaults.emptyWaitlistRows ?? 4,
      { min: 1, max: 20 },
    ),
    waitlistStartAtZero: parseBoolean(
      variable('WAITLIST_START_AT_ZERO'),
      read('WAITLIST_START_AT_ZERO'),
      defaults.waitlistStartAtZero ?? false,
    ),
    padTeamTags: parseBoolean(
      variable('PAD_TEAM_TAGS'),
      read('PAD_TEAM_TAGS'),
      defaults.padTeamTags ?? false,
    ),
    fixedTeams: (defaults.fixedTeams ?? []).map((team) => ({ ...team })),
    title:
      defaults.title ??
      read('TITLE', `${brandName.toUpperCase()} ${scope} SCRIMMAGE SLOT LIST`),
    titleEmojiId: read('TITLE_EMOJI_ID', defaults.titleEmojiId),
    timeLabel: defaults.fixedTimeLabel
      ? defaults.timeLabel
      : read('TIME_LABEL', defaults.timeLabel ?? '10:00 PM PH Time'),
    roundsLabel: defaults.fixedRoundsLabel
      ? defaults.roundsLabel
      : read(
          'ROUNDS_LABEL',
          defaults.roundsLabel ?? '4 Rounds | 1SB-1DV-2SI',
        ),
  }
}

function loadAnnouncementConfig(scope) {
  const defaults = DEFAULT_ANNOUNCEMENTS[scope] ?? {}
  const channelId = value(
    `${scope}_ANNOUNCEMENT_CHANNEL_ID`,
    defaults.channelId,
  )
  const messageIds = value(
    `${scope}_ANNOUNCEMENT_MESSAGE_IDS`,
    defaults.messageIds?.join(','),
  )
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
    dateMessageIds: ANNOUNCEMENT_DATE_MESSAGE_IDS[scope] ?? [],
    afterMessages: ANNOUNCEMENT_AFTER_MESSAGES[scope] ?? [],
  }
}

export function loadConfig() {
  const brandName = value('BOT_BRAND_NAME', 'PHGG')
  const guildId = required('DISCORD_GUILD_ID')
  const nicknameChannelId = value(
    'DISCORD_NICKNAME_CHANNEL_ID',
    DEFAULT_NICKNAME_CHANNEL_ID,
  )
  const rulesChannelId = value(
    'DISCORD_RULES_CHANNEL_ID',
    DEFAULT_RULES_CHANNEL_ID,
  )
  const rulesMessageIds = value(
    'DISCORD_RULES_MESSAGE_IDS',
    DEFAULT_RULES_MESSAGE_IDS,
  )
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const scrimRulesChannelId = DEFAULT_SCRIM_RULES_CHANNEL_ID
  const scrimRulesMessageIds = DEFAULT_SCRIM_RULES_MESSAGE_IDS
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
    guildId,
    brandName,
    geminiApiKey: value('GEMINI_API_KEY'),
    tallyChannelId: value('TALLY_CHANNEL_ID', value('GAME_RESULTS_CHANNEL_ID', DEFAULT_TALLY_CHANNEL_ID)),
    scorekeeperRoleIds: idSet(value('SCOREKEEPER_ROLE_IDS', value('GAME_RESULTS_SCOREKEEPER_ROLE_IDS', ''))),
    color: color('BOT_COLOR', '#ED1C24'),
    timezone: value('BOT_TIMEZONE', 'Asia/Manila'),
    nickname: {
      enabled: Boolean(nicknameChannelId),
      channelId: nicknameChannelId,
    },
    rules: {
      enabled: Boolean(rulesChannelId),
      channelId: rulesChannelId,
      messageIds: rulesMessageIds,
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
      guildId,
    },
  }
}

import { createServer } from 'node:http'
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import { loadConfig } from './config.js'
import { installAnnouncementAutomation } from './announcements.js'
import { installServerInviteAutomation } from './invite-links.js'
import { installNicknameAutomation } from './nickname.js'
import { installRulesAutomation } from './rules.js'
import { installScrimAutomation } from './scrims/automation.js'

const config = loadConfig()
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
})
client.rest.setToken(config.token)

installNicknameAutomation(client, config.nickname)
installRulesAutomation(client, config.rules, config)
for (const scrimConfig of config.scrims) {
  installScrimAutomation(client, scrimConfig, config)
}
installAnnouncementAutomation(client, {
  ...config.announcements,
  guildId: config.guildId,
})
installServerInviteAutomation(client, config.serverInvite, config)

client.once(Events.ClientReady, (readyClient) => {
  console.log(`${config.brandName} bot connected as ${readyClient.user.tag}.`)
  console.log(
    [
      `nickname=${config.nickname.enabled ? 'on' : 'off'}`,
      `rules=${config.rules.enabled ? 'on' : 'off'}`,
      `scrims=${config.scrims
        .filter((scrim) => scrim.enabled)
        .map((scrim) => scrim.label.toLowerCase())
        .join('+') || 'off'}`,
      `announcements=${config.announcements.groups
        .filter((group) => group.enabled)
        .map((group) => group.label.toLowerCase())
        .join('+') || 'off'}`,
      `server-invite-keyword=${config.serverInvite.enabled ? 'on' : 'off'}`,
      `tally-score=${config.geminiApiKey ? 'ai-vision' : 'text-fallback'}`,
    ].join(', '),
  )

  // Both keys accept a comma-separated list and are rotated on quota errors.
  // Print the counts so a mistyped list is obvious at boot rather than at 429.
  const countKeys = (value) =>
    String(value || '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean).length

  const geminiKeys = countKeys(config.geminiApiKey || process.env.GEMINI_API_KEY)
  const openaiKeys = countKeys(process.env.OPENAI_API_KEY)
  console.log(
    `vision providers: ${geminiKeys} Gemini key(s), ${openaiKeys} OpenAI key(s), ` +
      `reader=${String(process.env.TALLY_VISION_PROVIDER || 'gemini').toLowerCase()}`,
  )
})

client.on(Events.Error, (reason) => {
  console.error('Discord client error:', reason)
})

client.login(config.token).catch((reason) => {
  console.error('Discord login failed:', reason instanceof Error ? reason.message : reason)
  process.exitCode = 1
})

const port = Number(process.env.PORT)
let healthServer = null
if (Number.isInteger(port) && port > 0) {
  healthServer = createServer((request, response) => {
    const ready = client.isReady()
    const body = JSON.stringify({
      status: ready ? 'ok' : 'starting',
      discordReady: ready,
      bot: config.brandName,
    })
    response.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end(body)
  }).listen(port, '0.0.0.0', () => {
    console.log(`Health endpoint listening on http://0.0.0.0:${port}/health.`)
  })
}

function shutdown(signal) {
  console.log(`${signal} received; disconnecting cleanly.`)
  client.destroy()
  if (healthServer) healthServer.close(() => process.exit(0))
  else process.exit(0)
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))

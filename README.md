# PHGG Discord Automation Bot

This is a standalone version of the reusable automation from the NightRaid bot. It does not contain NightRaid IDs, tokens, or website/database integrations.

## Included automation

### Nickname channel

When a member posts a valid nickname in the configured channel, the bot changes their server nickname and reacts:

- `SS | KULIT - Handler` → ✅
- `6NIGHT | TiSAYwho - Player` → ✅
- `NR | Ems - Handler` → ✅
- Invalid format → ❌
- Discord role hierarchy prevents the change → ⚠️

The required format is `CLAN TAG | IGN - Player/Handler`. The role must be either `Player` or `Handler`.

Mentioning a member changes that member instead of the sender. Multiple `name @mention` pairs can be handled in one message.

### `/rules`

The bot registers `/rules` in your server. It displays the pinned messages from the configured rules channel in branded embeds. When that channel has no pins, it uses its latest messages.

### `/scrimrules`

The bot registers `/scrimrules` and fetches message `1412431092031553547` from channel `1346107866951581817`. It displays the saved text, embeds, and image with a button linking to the original rules message.

### Mobile and PC scrim registration boards

The bot runs separate mobile and PC cycles:

| Scrim | Registration | Team slots | Cancel slots |
| --- | --- | --- | --- |
| Mobile | `1345795374962704465` | `1345799937358565407` | `1345800858138574979` |
| PC | `1340963116954947635` | `1340963180809031721` | `1340963218582929430` |

Each registration remains closed until the official GIF with attachment ID `1531588588372885615` is posted in that registration channel. Posting it starts a fresh 20-slot cycle and creates a new live board for that scrim. Teams then register with:

```text
CLAN TAG - TEAM NAME | 🇵🇭
```

The format is strict: invalid registration messages receive ❌ and are not added. A registration also receives ❌ when the sender has no server nickname or their nickname does not follow `CLAN TAG | IGN - Player/Handler`. Each board fills `01A` through `20T` in message order, then adds extra teams to its own waiting list. The bot maintains pinned live boards and reconstructs both current cycles after a restart.

In the cancellation channel:

```text
CANCEL - TEAM NAME
```

The first waiting team is promoted automatically. A team can reply to that cancellation:

```text
MINE - TAG TEAM NAME
```

The first valid reply claims the canceled slot. Edits and deletions rebuild the board from the channel history.

### Weekly announcements

Every Tuesday at **11:30 AM Philippine time**, the bot fetches and reposts these saved messages:

| Scrim | Announcement channel | Source message IDs |
| --- | --- | --- |
| Mobile | `1345793370454495242` | `1531386132703613029`, `1531386979907014667` |
| PC | `1345794008471044176` | `1531386761190838283`, `1531386923203952910` |

The source messages must remain in their listed announcement channel. Their text, embeds, attachments, stickers, and allowed mentions are copied. The bot checks recent posts before sending, so reconnecting during the scheduled minute does not create duplicate announcements.

### Server invite keyword

When a member writes the word `link` anywhere in a message in any server channel—for example, `link`, `Link please`, or `Can someone send the link?`—the bot fetches and replies with this server's official invite and a **Join Server** button. It prefers the server vanity link, then a permanent unlimited invite. The trigger is case-insensitive and does not match unrelated words such as `hyperlink` or `linktree`.

## Set up Discord

1. Create or select an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Open **Bot** and enable:
   - **Server Members Intent**
   - **Message Content Intent**
3. Invite the bot with the `bot` and `applications.commands` scopes.
4. Give its server role these permissions:
   - View Channels
   - Read Message History
   - Send Messages
   - Embed Links
   - Add Reactions
   - Mention Everyone (when the saved announcement contains `@everyone` or a role mention)
   - Manage Nicknames
   - Manage Messages (needed to pin the live board)
5. Put the bot role above every member role whose nickname it should manage.

Only give the bot access to channels it needs. Discord never lets a bot rename the server owner.

## Configure

Copy `.env.example` to `.env`, then fill in the token, server ID, and desired channel IDs.

```powershell
Copy-Item .env.example .env
```

Never commit `.env` or share the bot token. If the token is exposed, reset it immediately in the Developer Portal.

The features are independent:

- Leave `DISCORD_NICKNAME_CHANNEL_ID` blank to disable nickname changes.
- Leave `DISCORD_RULES_CHANNEL_ID` blank to disable `/rules`.
- Each scrim requires its three `MOBILE_SCRIM_*_CHANNEL_ID` or `PC_SCRIM_*_CHANNEL_ID` values.
- `MOBILE_SCRIM_OPENER_IDS` and `PC_SCRIM_OPENER_IDS` can list extra users trusted to open cycles with a GIF.
- The scoped `*_BANNER_ASSET_ID` identifies the official opening GIF.
- The scoped `*_ALWAYS_OPEN=false` keeps registration closed until the official GIF opens a cycle.
- The scoped `*_REQUIRE_VALID_NICKNAME=true` voids registrations from members without the required nickname.

To copy IDs, enable **Developer Mode** in Discord, right-click a server, channel, user, or message, and choose **Copy ID**.

## Run

Node.js 20 or newer is required.

```powershell
npm install
npm test
npm start
```

Run only one copy of the bot token at a time. Two active processes can both receive the same Discord event and create duplicate responses.

## Deploy

Use a long-running worker on Render, Railway, Fly.io, a VPS, or a PC that stays online. Discord gateway bots cannot run as short-lived serverless functions.

Use:

```text
Build command: npm ci
Start command: npm start
```

Set the values from `.env.example` in the host's environment settings. `PORT` is optional; when the host supplies it, the bot exposes a small health endpoint.

### Render and UptimeRobot

This repository includes `render.yaml` for a free Render Web Service in Singapore. Render asks for `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` during Blueprint creation; they are never stored in Git.

After deployment, the health endpoint is:

```text
https://YOUR-RENDER-SERVICE.onrender.com/health
```

Create an UptimeRobot **HTTP(s)** monitor for that URL with a five-minute interval. A healthy bot returns HTTP 200 and `{"status":"ok","discordReady":true}`. A disconnected bot returns HTTP 503, allowing Render and UptimeRobot to report the failure.

## Limits inherited from the NightRaid approach

- Restart reconstruction reads the latest 100 messages from each scrim channel.
- The waiting-list embed shows up to 40 teams.
- Discord nicknames are limited to 32 characters.
- The application-review workflow is intentionally excluded because it requires NightRaid's private website API and database.

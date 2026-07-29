import { once } from 'node:events'
import { request } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'

const MEBIBYTE = 1024 * 1024
const UPLOAD_LIMITS_BY_PREMIUM_TIER = new Map([
  [0, 10 * MEBIBYTE],
  [1, 10 * MEBIBYTE],
  [2, 50 * MEBIBYTE],
  [3, 100 * MEBIBYTE],
])

function filename(value, index) {
  return String(value || `attachment-${index}`)
    .replace(/[\r\n"\\]/g, '_')
    .slice(0, 200)
}

export function discordUploadLimit(channel) {
  const premiumTier = Number(channel.guild?.premiumTier ?? 0)
  return UPLOAD_LIMITS_BY_PREMIUM_TIER.get(premiumTier) ?? 10 * MEBIBYTE
}

export function buildDirectMediaPayload(payload, attachments) {
  const attachmentUrls = attachments.map((attachment) => attachment.url)
  if (attachmentUrls.some((url) => !url)) {
    throw new Error(
      'An oversized Discord attachment has no direct media URL fallback.',
    )
  }
  const mediaUrls = [...new Set(attachmentUrls)]
  const content = [payload.content, ...mediaUrls]
    .filter(Boolean)
    .join('\n')
  if (content.length > 2_000) {
    throw new Error(
      'The direct media fallback would exceed Discord’s message length limit.',
    )
  }
  return {
    ...payload,
    content,
  }
}

function apiPayload(payload, attachments) {
  const result = {
    attachments: attachments.map((attachment, index) => ({
      id: String(index),
      filename: filename(attachment.name, index),
      ...(attachment.description
        ? { description: attachment.description }
        : {}),
    })),
  }
  if (payload.content) result.content = payload.content
  if (payload.embeds?.length > 0) {
    result.embeds = payload.embeds.map((embed) =>
      typeof embed.toJSON === 'function' ? embed.toJSON() : embed,
    )
  }
  if (payload.stickers?.length > 0) result.sticker_ids = payload.stickers
  if (payload.nonce !== undefined) result.nonce = payload.nonce
  if (payload.enforceNonce) result.enforce_nonce = true
  if (payload.allowedMentions) {
    result.allowed_mentions = {
      parse: payload.allowedMentions.parse ?? [],
      replied_user: payload.allowedMentions.repliedUser ?? false,
    }
  }
  return result
}

export function buildStreamingMultipart(
  payload,
  attachments,
  boundary = `PHGG-${Date.now().toString(36)}`,
) {
  const json = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="payload_json"',
      'Content-Type: application/json',
      '',
      JSON.stringify(apiPayload(payload, attachments)),
      '',
    ].join('\r\n'),
  )
  const files = attachments.map((attachment, index) => {
    const header = Buffer.from(
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="files[${index}]"; filename="${filename(attachment.name, index)}"`,
        `Content-Type: ${attachment.contentType || 'application/octet-stream'}`,
        '',
        '',
      ].join('\r\n'),
    )
    return {
      attachment,
      header,
      footer: Buffer.from('\r\n'),
    }
  })
  const closing = Buffer.from(`--${boundary}--\r\n`)
  const contentLength =
    json.length +
    files.reduce(
      (total, file) =>
        total + file.header.length + file.attachment.size + file.footer.length,
      0,
    ) +
    closing.length
  return { boundary, closing, contentLength, files, json }
}

async function write(requestStream, value) {
  if (!requestStream.write(value)) await once(requestStream, 'drain')
}

async function responseBody(response) {
  const chunks = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function sendOnce(client, channel, attachments, payload) {
  const multipart = buildStreamingMultipart(payload, attachments)
  let requestStream
  const responsePromise = new Promise((resolve, reject) => {
    requestStream = request(
      {
        hostname: 'discord.com',
        path: `/api/v10/channels/${channel.id}/messages`,
        method: 'POST',
        headers: {
          Authorization: `Bot ${client.token}`,
          'Content-Length': String(multipart.contentLength),
          'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
          'User-Agent': 'DiscordBot (PHGG Automation, 1.0)',
        },
      },
      resolve,
    )
    requestStream.once('error', reject)
  })
  void responsePromise.catch(() => undefined)

  try {
    await write(requestStream, multipart.json)
    for (const file of multipart.files) {
      await write(requestStream, file.header)
      const response = await fetch(file.attachment.url)
      if (!response.ok || !response.body) {
        throw new Error(
          `Could not download ${file.attachment.name}: HTTP ${response.status}.`,
        )
      }
      let transferred = 0
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        transferred += buffer.length
        await write(requestStream, buffer)
      }
      if (transferred !== file.attachment.size) {
        throw new Error(
          `${file.attachment.name} changed size while it was being copied.`,
        )
      }
      await write(requestStream, file.footer)
    }
    await write(requestStream, multipart.closing)
    requestStream.end()
  } catch (reason) {
    requestStream?.destroy()
    await responsePromise.catch(() => undefined)
    throw reason
  }

  const response = await responsePromise
  const body = await responseBody(response)
  let data = null
  try {
    data = body ? JSON.parse(body) : null
  } catch {
    data = null
  }
  if (response.statusCode === 429) {
    return {
      retryAfter: Math.max(0.25, Number(data?.retry_after) || 1),
    }
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const reason = new Error(
      `Discord attachment upload failed with HTTP ${response.statusCode}: ${data?.message || body || 'Unknown error'}`,
    )
    reason.statusCode = response.statusCode
    throw reason
  }
  return { data, retryAfter: null }
}

export async function sendDiscordAttachments(
  client,
  channel,
  attachments,
  payload,
) {
  if (!client.token) throw new Error('The Discord bot token is unavailable.')
  if (attachments.length === 0) return channel.send(payload)
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw new Error(
        `Attachment ${attachment.name ?? attachment.id} has no usable size.`,
      )
    }
  }

  const uploadLimit = discordUploadLimit(channel)
  if (attachments.some((attachment) => attachment.size > uploadLimit)) {
    console.warn(
      `Discord attachment exceeds this server’s ${Math.floor(uploadLimit / MEBIBYTE)} MB upload limit; sending it as a direct media preview.`,
    )
    return channel.send(buildDirectMediaPayload(payload, attachments))
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result
    try {
      result = await sendOnce(client, channel, attachments, payload)
    } catch (reason) {
      if (reason?.statusCode === 413) {
        console.warn(
          'Discord rejected the attachment size; sending it as a direct media preview.',
        )
        return channel.send(buildDirectMediaPayload(payload, attachments))
      }
      throw reason
    }
    if (result.retryAfter === null) return result.data
    if (attempt === 1) {
      throw new Error('Discord kept rate-limiting the attachment upload.')
    }
    await delay(result.retryAfter * 1_000)
  }
  return null
}

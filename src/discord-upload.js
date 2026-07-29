import { once } from 'node:events'
import { request } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'

function filename(value, index) {
  return String(value || `attachment-${index}`)
    .replace(/[\r\n"\\]/g, '_')
    .slice(0, 200)
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
    throw new Error(
      `Discord attachment upload failed with HTTP ${response.statusCode}: ${data?.message || body || 'Unknown error'}`,
    )
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await sendOnce(client, channel, attachments, payload)
    if (result.retryAfter === null) return result.data
    if (attempt === 1) {
      throw new Error('Discord kept rate-limiting the attachment upload.')
    }
    await delay(result.retryAfter * 1_000)
  }
  return null
}

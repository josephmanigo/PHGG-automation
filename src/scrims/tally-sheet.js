import { createSign } from 'node:crypto'

export const DEFAULT_SPREADSHEET_ID = '1ehK9etINJbB39pbEB9n9NI0Kt5sAKRA1IRX9L9JlRNk'

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

export async function getGoogleAccessToken(email, privateKey) {
  const cleanPrivateKey = privateKey.replace(/\\n/g, '\n')
  const now = Math.floor(Date.now() / 1000)

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = base64url(
    JSON.stringify({
      iss: email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  )

  const signatureInput = `${header}.${claim}`
  const signer = createSign('RSA-SHA256')
  signer.update(signatureInput)
  const signature = base64url(signer.sign(cleanPrivateKey))
  const jwt = `${signatureInput}.${signature}`

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Google Auth failed (${response.status}): ${errorText}`)
  }

  const data = await response.json()
  return data.access_token
}

// Columns for each round in PHGG Operation Domination Score Sheet
// Slot Rows: Row 14 (Slot 1-A) to Row 38 (Slot 25-Y)
const ROUND_COLUMNS = {
  1: { place: 'J', kills: 'L' },
  2: { place: 'M', kills: 'O' },
  3: { place: 'P', kills: 'R' },
  4: { place: 'S', kills: 'U' },
}

export async function syncScoresToGoogleSheet({
  spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID,
  sheetName = process.env.GOOGLE_SHEETS_WORKSHEET_NAME || 'Copy of New',
  roundNumber,
  entries,
  registeredTeams = [],
}) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL
  const privateKey = process.env.GOOGLE_PRIVATE_KEY || process.env.GOOGLE_SHEETS_PRIVATE_KEY

  const roundNum = Number(roundNumber)
  const roundCols = ROUND_COLUMNS[roundNum]
  if (!roundCols) {
    console.warn(`Round ${roundNum} is outside supported rounds (1-4) for Google Sheets sync.`)
    return false
  }

  const payload = {
    spreadsheetId,
    sheetName,
    roundNumber: roundNum,
    entries,
    registeredTeams,
  }

  // 1. Webhook endpoint support (Google Apps Script)
  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return response.ok
  }

  // 2. Direct Google Sheets REST API v4 using Service Account Credentials
  if (!clientEmail || !privateKey) {
    console.warn('Google Sheets Service Account email/key or Webhook URL not provided. Skipping live spreadsheet write.')
    return false
  }

  const accessToken = await getGoogleAccessToken(clientEmail, privateKey)

  // Format current date in PH Time (e.g. 05-Aug-2026)
  const now = new Date()
  const dateFormatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(now).replace(/ /g, '-')

  const updateData = []

  // Update Header Date Cell (H11)
  updateData.push({
    range: `'${sheetName}'!H11`,
    values: [[`PH GAMING GUILD  -  OPERATION :  DOMINATION\nBLOODSTRIKE SCRIMMAGE • MOBILE/PC ${dateFormatted}   |   4 ROUNDS SLOT`]],
  })

  // Map registered teams to Column I (Row 14 to 38)
  for (let i = 0; i < 25; i++) {
    const row = 14 + i
    const slotLetter = String.fromCharCode(65 + i)
    const slotCode = `${String(i + 1).padStart(2, '0')}${slotLetter}`

    const registered = registeredTeams.find((t) => t.slotIndex === i)
    if (registered) {
      const displayName = registered.tag ? `[${registered.tag}] ${registered.name}` : registered.name
      updateData.push({
        range: `'${sheetName}'!I${row}`,
        values: [[displayName]],
      })
    }

    const entry = entries.find((e) =>
      e.slotCode === slotCode ||
      e.slotCode === `${i + 1}-${slotLetter}` ||
      e.rank === i + 1,
    )

    if (entry) {
      updateData.push({
        range: `'${sheetName}'!${roundCols.place}${row}`,
        values: [[entry.rank]],
      })
      updateData.push({
        range: `'${sheetName}'!${roundCols.kills}${row}`,
        values: [[entry.kills]],
      })
    }
  }

  const apiEndpoint = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`
  const apiResponse = await fetch(apiEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: updateData,
    }),
  })

  if (!apiResponse.ok) {
    const errText = await apiResponse.text()
    throw new Error(`Google Sheets API update error (${apiResponse.status}): ${errText}`)
  }

  return true
}

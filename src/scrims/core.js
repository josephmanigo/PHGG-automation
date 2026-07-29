function cleanPart(value, maxLength) {
  return String(value ?? '')
    .replace(/[`*_~]/g, '')
    .replace(/<@!?&?\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim()
}

export function normalize(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
}

export function makeTeam(tag, name) {
  const safeTag = cleanPart(tag, 12).toUpperCase()
  const safeName = cleanPart(name, 48).toUpperCase()
  if (!safeTag || !safeName) return null
  return {
    tag: safeTag,
    name: safeName,
    key: normalize(`${safeTag} ${safeName}`),
  }
}

function parseRegistrationLine(line) {
  const match =
    /^\s*(.{1,16}?)\s*-\s*(.{1,64}?)\s*\|\s*🇵🇭\s*$/u.exec(
      line,
    )
  return match ? makeTeam(match[1], match[2]) : null
}

export function validateRegistrationContent(content) {
  const lines = String(content ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { valid: false, teams: [] }

  const teams = lines.map(parseRegistrationLine)
  if (teams.some((team) => !team)) return { valid: false, teams: [] }
  return { valid: true, teams }
}

export function parseRegistrationContent(content) {
  const result = validateRegistrationContent(content)
  return result.valid ? result.teams : []
}

export function parseCancelContent(content) {
  const match = /^\s*CANCEL\s*[-:]\s*(.+?)\s*$/i.exec(String(content ?? ''))
  return match ? cleanPart(match[1], 64) : null
}

export function parseMineContent(content) {
  const match = /^\s*MINE\s*[-:]\s*(.+?)\s*$/i.exec(String(content ?? ''))
  return match ? cleanPart(match[1], 64) : null
}

function teamMatches(team, query) {
  const target = normalize(query)
  if (!target) return false
  const variants = [normalize(team.name), normalize(`${team.tag} ${team.name}`), team.key]
  return variants.some(
    (variant) =>
      variant === target || variant.endsWith(` ${target}`) || target.endsWith(` ${variant}`),
  )
}

export class ScrimBoard {
  constructor(maxSlots = 25, fixedTeams = []) {
    this.maxSlots = maxSlots
    this.fixedTeams = fixedTeams
      .map((team) => {
        const normalized = makeTeam(team.tag, team.name)
        return normalized
          ? {
              ...normalized,
              countryLabel: team.countryLabel,
              sourceType: 'fixed',
            }
          : null
      })
      .filter(Boolean)
      .slice(0, maxSlots)
    this.reset()
  }

  reset() {
    this.slots = Array(this.maxSlots).fill(null)
    this.fixedTeams.forEach((team, index) => {
      this.slots[index] = { ...team }
    })
    this.waitlist = []
    this.pendingCancellations = new Map()
  }

  find(query) {
    const slotIndex = this.slots.findIndex((team) => team && teamMatches(team, query))
    if (slotIndex >= 0) {
      return { location: 'slot', index: slotIndex, team: this.slots[slotIndex] }
    }
    const waitIndex = this.waitlist.findIndex((team) => teamMatches(team, query))
    if (waitIndex >= 0) {
      return { location: 'waitlist', index: waitIndex, team: this.waitlist[waitIndex] }
    }
    return null
  }

  register(team, messageId = null, sourceType = 'registration') {
    const storedTeam = messageId ? { ...team, sourceMessageId: messageId, sourceType } : team
    if (this.find(`${storedTeam.tag} ${storedTeam.name}`)) {
      return { status: 'duplicate', team: storedTeam }
    }
    const slotIndex = this.slots.findIndex((entry) => !entry)
    if (slotIndex >= 0) {
      this.slots[slotIndex] = storedTeam
      return { status: 'slot', slotIndex, team: storedTeam }
    }
    this.waitlist.push(storedTeam)
    return { status: 'waitlist', waitIndex: this.waitlist.length - 1, team: storedTeam }
  }

  registerMany(teams, messageId = null) {
    return teams.map((team) => this.register(team, messageId))
  }

  cancel(query, cancellationMessageId) {
    const found = this.find(query)
    if (!found) return { status: 'not_found' }

    if (found.location === 'waitlist') {
      this.waitlist.splice(found.index, 1)
      return { status: 'waitlist_removed', team: found.team, waitIndex: found.index }
    }
    const promotedTeam = this.waitlist.shift() ?? null
    this.slots[found.index] = promotedTeam
    this.pendingCancellations.set(cancellationMessageId, {
      slotIndex: found.index,
      promotedTeamKey: promotedTeam?.key ?? null,
    })
    return {
      status: 'slot_removed',
      slotIndex: found.index,
      team: found.team,
      promotedTeam,
    }
  }

  teamFromClaim(value) {
    const registrationTeams = parseRegistrationContent(value)
    if (registrationTeams.length > 0) return registrationTeams[0]

    const explicit = /^(.{1,16}?)\s*-\s*(.{1,64})$/.exec(value)
    if (explicit) return makeTeam(explicit[1], explicit[2])

    const existing = this.find(value)
    if (existing) return existing.team

    const words = value.split(/\s+/).filter(Boolean)
    if (words.length < 2) return null
    return makeTeam(words[0], words.slice(1).join(' '))
  }

  claim(value, cancellationMessageId, claimMessageId = null) {
    const pending = this.pendingCancellations.get(cancellationMessageId)
    if (!pending) return { status: 'not_available' }

    const parsed = this.teamFromClaim(value)
    if (!parsed) return { status: 'invalid_team' }
    const team = claimMessageId
      ? { ...parsed, sourceMessageId: claimMessageId, sourceType: 'mine' }
      : parsed

    const existing = this.find(`${team.tag} ${team.name}`)
    if (existing?.location === 'slot' && existing.index !== pending.slotIndex) {
      return { status: 'already_registered', team: existing.team, slotIndex: existing.index }
    }
    if (existing?.location === 'slot' && existing.index === pending.slotIndex) {
      this.pendingCancellations.delete(cancellationMessageId)
      return { status: 'claimed', slotIndex: pending.slotIndex, team: existing.team }
    }
    if (existing?.location === 'waitlist') this.waitlist.splice(existing.index, 1)

    const currentTeam = this.slots[pending.slotIndex]
    if (currentTeam && currentTeam.key === pending.promotedTeamKey) {
      this.waitlist.unshift(currentTeam)
    } else if (currentTeam && currentTeam.key !== team.key) {
      return { status: 'not_available' }
    }

    this.slots[pending.slotIndex] = team
    this.pendingCancellations.delete(cancellationMessageId)
    return { status: 'claimed', slotIndex: pending.slotIndex, team }
  }
}

export function slotCode(index) {
  return `${String(index + 1).padStart(2, '0')}${String.fromCharCode(65 + index)}`
}

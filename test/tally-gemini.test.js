import test from 'node:test'
import assert from 'node:assert/strict'
import { Jimp } from 'jimp'
import {
  createGeminiScoreVisionReader,
  mergeScoreObservations,
  parseScreenshotWithGemini,
  scoreVisionOutputSchema,
} from '../src/scrims/tally-gemini.js'
import {
  createScoreboardCropVariants,
  normalizedScoreboardCropBox,
  prepareScoreboardImage,
  transformScoreboardBoxForContainedImage,
} from '../src/scrims/tally-image.js'

const field = (value, confidence = 0.99) => ({ value, confidence })
const team = ({ rank = 1, code = 'A', kills = 44, confidence = 0.99, bbox = [0, 0, 1000, 200] } = {}) => ({
  rank: field(rank, confidence),
  team_code: field(code, confidence),
  team_total_kills: field(kills, confidence),
  bbox,
})
const scoreOutput = (teams, endVisible = true, confidence = 0.99) => ({
  teams,
  coverage: {
    leaderboard_end_visible: field(endVisible, confidence),
  },
})

const prepared = async () => ({
  enhancedBuffer: Buffer.from('enhanced'),
  rowHints: [{ bbox: [0, 0, 1000, 200], confidence: 1 }],
  originalSha256: 'original',
  enhancedSha256: 'enhanced',
})

function injectedVision(outputs, recoveries = []) {
  let readIndex = 0
  let recoveryIndex = 0
  const reader = async () => ({
    provider: 'test',
    model: 'test-model',
    output: outputs[Math.min(readIndex++, outputs.length - 1)],
  })
  reader.recoverTeam = async () => recoveries[recoveryIndex++] ?? { observations: [] }
  return reader
}

const images = (count = 1) => Array.from({ length: count }, (_value, index) => ({
  buffer: Buffer.from(`original-${index}`),
  mimeType: 'image/png',
}))

test('score-only schema rejects extra model fields instead of trusting arbitrary JSON', () => {
  assert.throws(() => scoreVisionOutputSchema.parse(
    scoreOutput([{ ...team(), teamName: 'MODEL INVENTED NAME' }]),
  ))
})

test('a real zero-kill value stays zero and is never confused with unreadable null', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([team({ kills: 0 })])]),
    prepareImage: prepared,
    targetedRecoveryMaxTeams: 0,
  })

  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].kills, 0)
  assert.deepEqual(parsed.uncertain, [])
})

test('two separately processed enlarged crops can recover an unreadable displayed total', async () => {
  const full = team({ kills: null, confidence: 0.2 })
  // Keep rank/code high-confidence while only the total requires recovery.
  full.rank = field(1, 0.99)
  full.team_code = field('A', 0.99)
  const recovery = {
    observations: [
      {
        variant: 'original_crop',
        output: {
          rank: field(1),
          team_code: field('A'),
          team_total_kills: field(44, 0.94),
        },
      },
      {
        variant: 'enhanced_crop',
        output: {
          rank: field(1),
          team_code: field('A'),
          team_total_kills: field(44, 0.92),
        },
      },
    ],
  }
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([full])], [recovery]),
    prepareImage: prepared,
    cropper: async () => ({
      originalCrop: Buffer.from('original-crop'),
      enhancedCrop: Buffer.from('enhanced-crop'),
    }),
  })

  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].kills, 44)
  assert.equal(parsed.entries[0].recovered, true)
  assert.deepEqual(parsed.uncertain, [])
})

test('targeted crops from another row cannot donate its kills to the resolved team', async () => {
  const full = team({ kills: null, confidence: 0.2 })
  full.rank = field(1, 0.99)
  full.team_code = field('A', 0.99)
  const wrongRow = {
    observations: ['original_crop', 'enhanced_crop'].map((variant) => ({
      variant,
      output: {
        rank: field(2),
        team_code: field('B'),
        team_total_kills: field(20),
      },
    })),
  }

  await assert.rejects(parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([full])], [wrongRow]),
    prepareImage: prepared,
    cropper: async () => ({ originalCrop: Buffer.from('a'), enhancedCrop: Buffer.from('b') }),
  }), /none passed the strict score checks/i)
})

test('kills alone cannot identify a row for targeted rank and code recovery', async () => {
  const full = team({ rank: null, code: null, kills: 10, confidence: 0.2 })
  full.team_total_kills = field(10, 0.99)
  const shiftedRow = {
    observations: ['original_crop', 'enhanced_crop'].map((variant) => ({
      variant,
      output: {
        rank: field(2),
        team_code: field('B'),
        team_total_kills: field(10),
      },
    })),
  }

  await assert.rejects(parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([full])], [shiftedRow]),
    prepareImage: prepared,
    cropper: async () => ({ originalCrop: Buffer.from('a'), enhancedCrop: Buffer.from('b') }),
  }), /none passed the strict score checks/i)
})

test('targeted crop disagreement yields no accepted score and triggers fallback', async () => {
  const full = team({ kills: null, confidence: 0.2 })
  full.rank = field(1)
  full.team_code = field('A')
  await assert.rejects(parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([full])], [{
      observations: [
        {
          variant: 'original_crop',
          output: {
            rank: field(1),
            team_code: field('A'),
            team_total_kills: field(44),
          },
        },
        {
          variant: 'enhanced_crop',
          output: {
            rank: field(1),
            team_code: field('A'),
            team_total_kills: field(43),
          },
        },
      ],
    }]),
    prepareImage: prepared,
    cropper: async () => ({ originalCrop: Buffer.from('a'), enhancedCrop: Buffer.from('b') }),
  }), /none passed the strict score checks/i)
})

test('crop consensus cannot overwrite contradictory full-image evidence', async () => {
  const full = team({ kills: 43, confidence: 0.2 })
  full.rank = field(1)
  full.team_code = field('A')
  const agreement = {
    observations: ['original_crop', 'enhanced_crop'].map((variant) => ({
      variant,
      output: {
        rank: field(1),
        team_code: field('A'),
        team_total_kills: field(44),
      },
    })),
  }
  await assert.rejects(parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([full])], [agreement]),
    prepareImage: prepared,
    cropper: async () => ({ originalCrop: Buffer.from('a'), enhancedCrop: Buffer.from('b') }),
  }), /none passed the strict score checks/i)
})

test('independent screenshot overlaps collapse exact rows once', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(2),
    visionReader: injectedVision([
      scoreOutput([team({ rank: 1, code: 'A', kills: 44 })]),
      scoreOutput([team({ rank: 1, code: 'A', kills: 44 })]),
    ]),
    prepareImage: prepared,
    targetedRecoveryMaxTeams: 0,
  })

  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.overlapRowsCollapsed, 1)
  assert.deepEqual(parsed.entries[0].sources, [0, 1])
})

test('byte-identical attachments are model-read once before overlap merging', async () => {
  let reads = 0
  const duplicate = { buffer: Buffer.from('same-screenshot'), mimeType: 'image/png' }
  const reader = async () => {
    reads += 1
    return { output: scoreOutput([team()]) }
  }
  const parsed = await parseScreenshotWithGemini({
    images: [duplicate, { ...duplicate }],
    visionReader: reader,
    prepareImage: prepared,
    targetedRecoveryMaxTeams: 0,
  })

  assert.equal(reads, 1)
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.screenshots[1].skippedDuplicateOf, 0)
})

test('one failed screenshot plus one successful screenshot remains blocked evidence', async () => {
  let reads = 0
  const reader = async () => {
    reads += 1
    if (reads === 1) throw new Error('simulated unreadable attachment')
    return { output: scoreOutput([team()]) }
  }
  const parsed = await parseScreenshotWithGemini({
    images: images(2),
    visionReader: reader,
    prepareImage: prepared,
    targetedRecoveryMaxTeams: 0,
  })

  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.uncertain.some((item) => item.reason === 'screenshot_read_failed'), true)
})

test('model output cannot silently omit rows found by deterministic geometry', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([team()])]),
    prepareImage: async () => ({
      ...await prepared(),
      rowHints: [
        { bbox: [0, 0, 1000, 200], confidence: 1 },
        { bbox: [0, 200, 1000, 200], confidence: 1 },
      ],
    }),
    targetedRecoveryMaxTeams: 0,
  })

  assert.equal(parsed.entries.length, 1)
  assert.equal(
    parsed.uncertain.some((item) => item.reason === 'screenshot_row_count_mismatch'),
    true,
  )
})

test('model output cannot add rows beyond deterministic nonempty geometry', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([
      team({ rank: 1, code: 'A', kills: 44 }),
      team({ rank: 2, code: 'B', kills: 20 }),
    ])]),
    prepareImage: prepared,
    targetedRecoveryMaxTeams: 0,
  })

  assert.deepEqual(parsed.entries.map((entry) => entry.rank), [1, 2])
  assert.equal(
    parsed.uncertain.some((item) => item.reason === 'screenshot_row_count_mismatch'),
    true,
  )
})

test('identical duplicate rows within one model response are never collapsed as overlap', async () => {
  await assert.rejects(parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([team(), team()])]),
    prepareImage: async () => ({
      ...await prepared(),
      rowHints: [
        { bbox: [0, 0, 1000, 200], confidence: 1 },
        { bbox: [0, 200, 1000, 200], confidence: 1 },
      ],
    }),
    targetedRecoveryMaxTeams: 0,
  }), /none passed the strict score checks/i)
})

test('two returned rows cannot claim the same detected physical row box', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([
      team({ rank: 1, code: 'A', kills: 10, bbox: [0, 0, 1000, 100] }),
      team({ rank: 2, code: 'B', kills: 20, bbox: [0, 0, 1000, 100] }),
    ])]),
    prepareImage: async () => ({
      ...await prepared(),
      rowHints: [
        { bbox: [0, 0, 1000, 100], confidence: 1 },
        { bbox: [0, 500, 1000, 100], confidence: 1 },
      ],
    }),
    targetedRecoveryMaxTeams: 0,
  })

  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.uncertain.some((item) => item.reason === 'screenshot_geometry_mismatch'), true)
})

test('duplicate model boxes cannot pass by sitting halfway between adjacent row hints', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([
      team({ rank: 1, code: 'A', kills: 10, bbox: [0, 100, 1000, 100] }),
      team({ rank: 2, code: 'B', kills: 20, bbox: [0, 100, 1000, 100] }),
    ])]),
    prepareImage: async () => ({
      ...await prepared(),
      rowHints: [
        { bbox: [0, 50, 1000, 100], confidence: 1 },
        { bbox: [0, 150, 1000, 100], confidence: 1 },
      ],
    }),
    targetedRecoveryMaxTeams: 0,
  })

  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.uncertain.some((item) => item.reason === 'screenshot_geometry_mismatch'), true)
})

test('two thin boxes cannot split one boundary and impersonate adjacent detected rows', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([
      team({ rank: 1, code: 'A', kills: 10, bbox: [0, 148, 1000, 2] }),
      team({ rank: 2, code: 'B', kills: 20, bbox: [0, 150, 1000, 2] }),
    ])]),
    prepareImage: async () => ({
      ...await prepared(),
      rowHints: [
        { bbox: [0, 50, 1000, 100], confidence: 1 },
        { bbox: [0, 150, 1000, 100], confidence: 1 },
      ],
    }),
    targetedRecoveryMaxTeams: 0,
  })

  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.uncertain.some((item) => item.reason === 'screenshot_geometry_mismatch'), true)
})

test('resolved ranks must increase from top to bottom within each screenshot', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([
      team({ rank: 2, code: 'A', kills: 10, bbox: [0, 0, 1000, 100] }),
      team({ rank: 1, code: 'B', kills: 20, bbox: [0, 500, 1000, 100] }),
    ])]),
    prepareImage: async () => ({
      ...await prepared(),
      rowHints: [
        { bbox: [0, 0, 1000, 100], confidence: 1 },
        { bbox: [0, 500, 1000, 100], confidence: 1 },
      ],
    }),
    targetedRecoveryMaxTeams: 0,
  })

  assert.deepEqual(parsed.entries.map((entry) => entry.rank), [1, 2])
  assert.equal(parsed.uncertain.some((item) => item.reason === 'screenshot_rank_order_conflict'), true)
})

test('rank order is revalidated after targeted recovery resolves a rank', async () => {
  const top = team({ rank: null, code: 'A', kills: 10, confidence: 0.2, bbox: [0, 0, 1000, 100] })
  top.team_code = field('A')
  top.team_total_kills = field(10)
  const bottom = team({ rank: 1, code: 'B', kills: 20, bbox: [0, 500, 1000, 100] })
  const recoveredTop = {
    observations: ['original_crop', 'enhanced_crop'].map((variant) => ({
      variant,
      output: {
        rank: field(2),
        team_code: field('A'),
        team_total_kills: field(10),
      },
    })),
  }
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([top, bottom])], [recoveredTop]),
    prepareImage: async () => ({
      ...await prepared(),
      rowHints: [
        { bbox: [0, 0, 1000, 100], confidence: 1 },
        { bbox: [0, 500, 1000, 100], confidence: 1 },
      ],
    }),
    cropper: async () => ({ originalCrop: Buffer.from('a'), enhancedCrop: Buffer.from('b') }),
  })

  assert.deepEqual(parsed.entries.map((entry) => entry.rank), [1, 2])
  assert.equal(parsed.uncertain.some((item) => item.reason === 'screenshot_rank_order_conflict'), true)
})

test('conflicting overlapping kills invalidate the row instead of taking the first', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(2),
    visionReader: injectedVision([
      scoreOutput([
        team({ rank: 1, code: 'A', kills: 44 }),
        team({ rank: 2, code: 'B', kills: 20 }),
      ]),
      scoreOutput([
        team({ rank: 1, code: 'A', kills: 43 }),
        team({ rank: 2, code: 'B', kills: 20 }),
      ]),
    ]),
    prepareImage: prepared,
    targetedRecoveryMaxTeams: 0,
  })

  assert.deepEqual(parsed.entries.map((entry) => entry.rank), [2])
  assert.equal(parsed.uncertain.some((item) => item.reason === 'overlap_conflict'), true)
  assert.equal(parsed.conflicts[0].field, 'kills')
})

test('a shared-rank team-code conflict cannot leave the other observation accepted', () => {
  const merged = mergeScoreObservations([
    {
      rank: 1,
      teamCode: 'A',
      kills: 44,
      confidence: { rank: 0.99, teamCode: 0.99, kills: 0.99 },
      recoveredFields: [],
      sourceIndex: 0,
    },
    {
      rank: 1,
      teamCode: 'B',
      kills: null,
      confidence: { rank: 0.99, teamCode: 0.99, kills: 0.2 },
      recoveredFields: [],
      sourceIndex: 1,
    },
  ])

  assert.deepEqual(merged.entries, [])
  assert.equal(merged.uncertain[0].reason, 'overlap_conflict')
  assert.equal(merged.conflicts[0].field, 'teamCode')
})

test('the roster cannot hide a visual team-code conflict before overlap merging', async () => {
  await assert.rejects(parseScreenshotWithGemini({
    images: images(2),
    allowedLetters: ['A'],
    visionReader: injectedVision([
      scoreOutput([team({ rank: 1, code: 'B', kills: 44 })]),
      scoreOutput([team({ rank: 1, code: 'A', kills: 44 })]),
    ]),
    prepareImage: prepared,
    targetedRecoveryMaxTeams: 0,
  }), /none passed the strict score checks/i)
})

test('a visually read unregistered code is removed only after conflict-safe merging', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    allowedLetters: ['A'],
    visionReader: injectedVision([scoreOutput([
      team({ rank: 1, code: 'B', kills: 44 }),
      team({ rank: 2, code: 'A', kills: 20 }),
    ])]),
    prepareImage: async () => ({
      ...await prepared(),
      rowHints: [
        { bbox: [0, 0, 1000, 200], confidence: 1 },
        { bbox: [0, 200, 1000, 200], confidence: 1 },
      ],
    }),
    targetedRecoveryMaxTeams: 0,
  })

  assert.deepEqual(parsed.entries.map((entry) => entry.rank), [2])
  assert.equal(parsed.uncertain.some((item) => item.reason === 'unregistered_slot'), true)
})

test('team letters beyond the configured slot count are never accepted', async () => {
  await assert.rejects(parseScreenshotWithGemini({
    images: images(),
    maxSlots: 20,
    visionReader: injectedVision([scoreOutput([team({ rank: 1, code: 'U', kills: 44 })])]),
    prepareImage: prepared,
    targetedRecoveryMaxTeams: 0,
  }), /none passed the strict score checks/i)
})

test('all-low-confidence Gemini rows yield no accepted result', async () => {
  await assert.rejects(parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([
      team({ rank: 1, code: 'A', kills: 44, confidence: 0.2 }),
    ])]),
    prepareImage: prepared,
    targetedRecoveryMaxTeams: 0,
  }), /none passed the strict score checks/i)
})

test('a contiguous top-only capture remains blocked until the leaderboard end is visible', async () => {
  const parsed = await parseScreenshotWithGemini({
    images: images(),
    visionReader: injectedVision([scoreOutput([
      team({ rank: 1, code: 'A', kills: 44 }),
      team({ rank: 2, code: 'B', kills: 20 }),
    ], false)]),
    prepareImage: prepared,
    targetedRecoveryMaxTeams: 0,
  })

  assert.deepEqual(parsed.entries.map((entry) => entry.rank), [1, 2])
  assert.equal(parsed.uncertain.at(-1).reason, 'leaderboard_end_not_visible')
})

test('duplicate ranks or slot letters are removed from accepted scores', () => {
  const merged = mergeScoreObservations([
    {
      rank: 1,
      teamCode: 'A',
      kills: 44,
      confidence: { rank: 0.99, teamCode: 0.99, kills: 0.99 },
      recoveredFields: [],
      sourceIndex: 0,
    },
    {
      rank: 2,
      teamCode: 'A',
      kills: 40,
      confidence: { rank: 0.99, teamCode: 0.99, kills: 0.99 },
      recoveredFields: [],
      sourceIndex: 0,
    },
  ])

  assert.deepEqual(merged.entries, [])
  assert.equal(merged.uncertain.length, 1)
  assert.equal(merged.uncertain[0].reason, 'same_screenshot_duplicate_row')
  assert.equal(merged.conflicts[0].type, 'same_screenshot_duplicate_row')
})

test('a cropped continuation is incomplete unless ranks from one are covered', () => {
  const merged = mergeScoreObservations([{
    rank: 10,
    teamCode: 'J',
    kills: 12,
    confidence: { rank: 0.99, teamCode: 0.99, kills: 0.99 },
    recoveredFields: [],
    sourceIndex: 0,
  }])

  assert.deepEqual(merged.missingRanks, [1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('invalid provider output fails closed instead of coercing missing kills to zero', async () => {
  await assert.rejects(
    parseScreenshotWithGemini({
      images: images(),
      visionReader: injectedVision([scoreOutput([{
        rank: field(1),
        team_code: field('A'),
        team_total_kills: { value: '44', confidence: 0.99 },
        bbox: [0, 0, 1000, 200],
      }])]),
      prepareImage: prepared,
      targetedRecoveryMaxTeams: 0,
    }),
    /could not safely read any scoreboard screenshot/i,
  )
})

test('Gemini request uses the score-only structured contract and original plus enhanced evidence', async () => {
  const requests = []
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({
      status: 'completed',
      steps: [{
        type: 'model_output',
          content: [{ type: 'text', text: JSON.stringify(scoreOutput([team()])) }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const reader = createGeminiScoreVisionReader({ apiKey: 'test-key', fetchImpl })
  const result = await reader({
    originalBuffer: Buffer.from('original'),
    originalMimeType: 'image/png',
    enhancedBuffer: Buffer.from('enhanced'),
    rowHints: [],
  })

  assert.equal(result.output.teams[0].team_total_kills.value, 44)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].store, false)
  assert.equal(requests[0].generation_config.thinking_level, 'low')
  assert.equal(requests[0].response_format.mime_type, 'application/json')
  const content = requests[0].input[0].content
  assert.equal(content.filter((item) => item.type === 'image').length, 2)
  assert.match(requests[0].system_instruction, /Never guess and never calculate/)
  assert.match(requests[0].system_instruction, /FIRST, untouched original screenshot/)
})

test('targeted recovery performs two separate original and enhanced crop reads', async () => {
  const requests = []
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({
      status: 'completed',
      steps: [{
        type: 'model_output',
        content: [{
          type: 'text',
          text: JSON.stringify({
            rank: field(1),
            team_code: field('A'),
            team_total_kills: field(44),
          }),
        }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const reader = createGeminiScoreVisionReader({ apiKey: 'test-key', fetchImpl })
  const result = await reader.recoverTeam({
    originalCrop: Buffer.from('original-crop'),
    enhancedCrop: Buffer.from('enhanced-crop'),
    teamIndex: 0,
    unresolvedFields: ['kills'],
  })

  assert.equal(requests.length, 2)
  assert.equal(result.observations.length, 2)
  assert.deepEqual(result.observations.map((item) => item.variant), [
    'original_crop',
    'enhanced_crop',
  ])
  const imageBytes = requests.map((request) => request.input[0].content
    .find((item) => item.type === 'image').data)
  assert.deepEqual(imageBytes, [
    Buffer.from('original-crop').toString('base64'),
    Buffer.from('enhanced-crop').toString('base64'),
  ])
  assert.ok(requests.every((request) => /Read exactly one enlarged/.test(request.system_instruction)))
})

test('one successful real crop transport plus one failed crop is insufficient recovery evidence', async () => {
  let requests = 0
  const transport = createGeminiScoreVisionReader({
    apiKey: 'test-key',
    fetchImpl: async () => {
      requests += 1
      if (requests === 2) {
        return new Response(JSON.stringify({ error: { message: 'simulated crop failure' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        status: 'completed',
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              rank: field(1),
              team_code: field('A'),
              team_total_kills: field(44),
            }),
          }],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const full = team({ kills: null, confidence: 0.2 })
  full.rank = field(1)
  full.team_code = field('A')
  const reader = async () => ({ output: scoreOutput([full]) })
  reader.recoverTeam = transport.recoverTeam

  await assert.rejects(parseScreenshotWithGemini({
    images: images(),
    visionReader: reader,
    prepareImage: prepared,
    cropper: async () => ({ originalCrop: Buffer.from('a'), enhancedCrop: Buffer.from('b') }),
  }), /none passed the strict score checks/i)
  assert.equal(requests, 2)
})

test('an invalid primary-model structure falls through to a valid fallback model', async () => {
  const models = []
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body)
    models.push(request.model)
    const output = models.length === 1 ? { teams: [team()] } : scoreOutput([team()])
    return new Response(JSON.stringify({
      status: 'completed',
      steps: [{
        type: 'model_output',
        content: [{ type: 'text', text: JSON.stringify(output) }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const reader = createGeminiScoreVisionReader({
    apiKey: 'test-key',
    modelName: 'primary-test-model',
    fallbackModelName: 'fallback-test-model',
    secondaryFallbackModelName: 'secondary-test-model',
    fetchImpl,
  })
  const result = await reader({
    originalBuffer: Buffer.from('original'),
    originalMimeType: 'image/png',
    enhancedBuffer: Buffer.from('enhanced'),
  })

  assert.deepEqual(models, ['primary-test-model', 'fallback-test-model'])
  assert.equal(result.model, 'fallback-test-model')
  assert.equal(result.output.teams[0].team_total_kills.value, 44)
})

test('image preparation preserves original bytes and produces a fixed enhanced frame', async () => {
  const source = new Jimp({ width: 64, height: 36, color: 0x202020ff })
  for (let y = 0; y < 36; y += 1) {
    for (let x = 32; x < 64; x += 1) source.setPixelColor(0xb0b0b0ff, x, y)
  }
  const original = await source.getBuffer('image/png')
  const snapshot = Buffer.from(original)
  const preparedImage = await prepareScoreboardImage(original, {
    targetWidth: 320,
    targetHeight: 180,
  })
  const enhanced = await Jimp.fromBuffer(preparedImage.enhancedBuffer)

  assert.deepEqual(original, snapshot)
  assert.equal(enhanced.bitmap.width, 320)
  assert.equal(enhanced.bitmap.height, 180)
  assert.notEqual(preparedImage.originalSha256, preparedImage.enhancedSha256)
  const rgb = enhanced.bitmap.data.filter((_value, index) => index % 4 !== 3)
  const range = rgb.reduce(
    (result, value) => [Math.min(result[0], value), Math.max(result[1], value)],
    [255, 0],
  )
  assert.ok(range[1] - range[0] > 20, 'enhancement must preserve visible contrast')
})

test('targeted crop boxes are padded but remain inside normalized bounds', () => {
  assert.deepEqual(normalizedScoreboardCropBox([10, 20, 100, 200], 30), [0, 0, 140, 250])
  assert.deepEqual(normalizedScoreboardCropBox([900, 900, 100, 100], 30), [870, 870, 130, 130])
  assert.throws(() => normalizedScoreboardCropBox([900, 900, 200, 200], 30))
})

test('non-16:9 boxes map through letterboxing before the enhanced crop', async () => {
  const source = new Jimp({ width: 100, height: 100, color: 0x000000ff })
  for (let y = 20; y < 30; y += 1) {
    for (let x = 10; x < 40; x += 1) source.setPixelColor(0xffffffff, x, y)
  }
  const original = await source.getBuffer('image/png')
  const preparedImage = await prepareScoreboardImage(original, {
    targetWidth: 192,
    targetHeight: 108,
  })
  const mapped = transformScoreboardBoxForContainedImage(
    [100, 200, 300, 100],
    preparedImage.enhancedTransform,
  )

  assert.ok(Math.abs(mapped[0] - 275) < 0.01)
  assert.ok(Math.abs(mapped[1] - 200) < 0.01)
  assert.ok(Math.abs(mapped[2] - 168.75) < 0.01)
  assert.ok(Math.abs(mapped[3] - 100) < 0.01)

  const crops = await createScoreboardCropVariants({
    originalBuffer: original,
    enhancedBuffer: preparedImage.enhancedBuffer,
    bbox: [100, 200, 300, 100],
    enhancedTransform: preparedImage.enhancedTransform,
  }, { targetWidth: 160, targetHeight: 48, padding: 0 })
  const [originalCrop, enhancedCrop] = await Promise.all([
    Jimp.fromBuffer(crops.originalCrop),
    Jimp.fromBuffer(crops.enhancedCrop),
  ])
  assert.equal(originalCrop.bitmap.width, 160)
  assert.equal(enhancedCrop.bitmap.width, 160)
  assert.deepEqual(crops.enhancedBbox, mapped)
  const meanRgb = (image) => {
    let sum = 0
    let count = 0
    for (let index = 0; index < image.bitmap.data.length; index += 4) {
      sum += image.bitmap.data[index]
      sum += image.bitmap.data[index + 1]
      sum += image.bitmap.data[index + 2]
      count += 3
    }
    return sum / count
  }
  assert.ok(meanRgb(originalCrop) > 150, 'original crop should contain the marked row')
  assert.ok(meanRgb(enhancedCrop) > 150, 'enhanced crop should contain the same marked row')
})

test('oversized cloud evidence fails closed instead of dropping the canonical original', async () => {
  let requests = 0
  const reader = createGeminiScoreVisionReader({
    apiKey: 'test-key',
    maxInlineImageBytes: 1024,
    fetchImpl: async () => {
      requests += 1
      return new Response('{}')
    },
  })
  await assert.rejects(reader({
    originalBuffer: Buffer.alloc(600),
    originalMimeType: 'image/png',
    enhancedBuffer: Buffer.alloc(600),
  }), /exceeds.*inline-image limit/i)
  assert.equal(requests, 0)
})

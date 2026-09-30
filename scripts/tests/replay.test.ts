// @vitest-environment node
/**
 * Replay CLI end to end: a watch night is uploaded through the real
 * endpoint into migrated in-memory pod databases, `fetch` pulls its bundle
 * through a real tRPC fetch handler (plus a stubbed raw export), and `score`
 * re-stages and scores it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as biometricsSchema from '@/src/db/biometrics-schema'
import * as mainSchema from '@/src/db/schema'

const state = vi.hoisted(() => ({
  biometrics: null as unknown,
  main: null as unknown,
}))

vi.mock('@/src/db', () => ({
  get biometricsDb() {
    return state.biometrics
  },
  get db() {
    return state.main
  },
}))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getDacMonitorIfRunning: () => null }))

const { router } = await import('@/src/server/trpc')
const { biometricsRouter } = await import('@/src/server/routers/biometrics')
const { fetchCorpus, bundleName, rawArchiveUrl } = await import('../replay/fetch')
const { scoreCorpus, parseReport } = await import('../replay/score')
const { formatReport } = await import('../replay/format')
const { main, parseArgs } = await import('../replay/cli')
const { normalizePodUrl, createPodClient } = await import('../replay/client')

const testRouter = router({ biometrics: biometricsRouter })
const caller = biometricsRouter.createCaller({})

const MIN = 60_000
const NIGHT_START = 1_790_000_000_000 // pod clock
const CLOCK_OFFSET = 5000 // pod clock is 5 s ahead of the phone
const LAG = 200 // bed beats trail the wrist by 200 ms

let rawBiometrics: Database.Database
let rawMain: Database.Database
let dir: string
let archiveRequests: string[]
let archiveResponses: Array<() => Response>

/** Route pod requests: tRPC into the real handler, raw export into a stub. */
async function podFetch(url: string, init?: RequestInit): Promise<Response> {
  if (url.includes('/api/export/archive')) {
    archiveRequests.push(url)
    return (archiveResponses.shift() ?? (() => new Response('tarball', { status: 200 })))()
  }
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request(url, init),
    router: testRouter,
    createContext: () => ({}),
  })
}

/** Beat times with a gently varying rhythm (~62 bpm). */
function podBeats(start: number, end: number): number[] {
  const out: number[] = []
  let t = start
  let i = 0
  while (t < end) {
    out.push(t)
    t += 970 + 40 * Math.sin(i++ / 5)
  }
  return out
}

function seedPod(): number[] {
  const bdb = state.biometrics as ReturnType<typeof drizzle<typeof biometricsSchema>>
  const mdb = state.main as ReturnType<typeof drizzle<typeof mainSchema>>
  const end = NIGHT_START + 60 * MIN
  bdb.insert(biometricsSchema.sleepRecords).values({
    side: 'left',
    enteredBedAt: new Date(NIGHT_START),
    leftBedAt: new Date(end),
    sleepDurationSeconds: 3600,
  }).run()
  const beats = podBeats(NIGHT_START, end)
  for (let m = NIGHT_START; m < end; m += MIN) {
    bdb.insert(biometricsSchema.heartbeats).values({
      side: 'left',
      timestamp: new Date(m),
      beats: beats.filter(b => b >= m && b < m + MIN).map(b => b - m),
    }).run()
    bdb.insert(biometricsSchema.vitals).values({ side: 'left', timestamp: new Date(m), heartRate: 62, hrv: 40, breathingRate: 14 }).run()
    bdb.insert(biometricsSchema.movement).values({ side: 'left', timestamp: new Date(m), totalMovement: m < NIGHT_START + 5 * MIN ? 400 : 10 }).run()
  }
  mdb.insert(mainSchema.deviceSettings).values({ timezone: 'America/New_York' }).run()
  mdb.insert(mainSchema.sideSettings).values({ side: 'left', name: 'Left', age: 40, sex: 'female' }).run()
  return beats
}

async function uploadWatchNight(beats: number[]) {
  // Reference clock = pod clock − offset.
  const ref = (podMs: number) => podMs - CLOCK_OFFSET
  const segStart = NIGHT_START + 30 * MIN
  const segment = beats.filter(b => b >= segStart && b < segStart + MIN).map(b => b - LAG)
  vi.setSystemTime(ref(NIGHT_START + 12 * 60 * MIN) + CLOCK_OFFSET)
  await caller.reportReferenceNight({
    side: 'left',
    source: 'apple-watch',
    deviceModel: 'Watch7,1',
    nightStart: ref(NIGHT_START),
    nightEnd: ref(NIGHT_START + 60 * MIN),
    sentAt: ref(NIGHT_START + 12 * 60 * MIN),
    stages: [
      { start: ref(NIGHT_START), end: ref(NIGHT_START + 5 * MIN), stage: 'wake' },
      { start: ref(NIGHT_START + 5 * MIN), end: ref(NIGHT_START + 40 * MIN), stage: 'light' },
      { start: ref(NIGHT_START + 40 * MIN), end: ref(NIGHT_START + 60 * MIN), stage: 'rem' },
    ],
    heartRate: [10, 20, 30, 40, 50].map(m => ({ t: ref(NIGHT_START + m * MIN), bpm: 62 })),
    hrv: [],
    beatSeries: [{
      // Wall-clock fields are integer ms; offsets within a series may be fractional.
      start: Math.round(ref(segment[0])),
      beats: segment.map(b => ({ t: ref(b) - Math.round(ref(segment[0])), gap: false })),
    }],
  })
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  rawBiometrics = new Database(':memory:')
  rawMain = new Database(':memory:')
  state.biometrics = drizzle(rawBiometrics, { schema: biometricsSchema })
  state.main = drizzle(rawMain, { schema: mainSchema })
  migrate(state.biometrics as never, { migrationsFolder: path.resolve('src/db/biometrics-migrations') })
  migrate(state.main as never, { migrationsFolder: path.resolve('src/db/migrations') })
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'))
  process.env.BIOMETRICS_ARCHIVE_DIR = path.join(dir, 'no-archive')
  archiveRequests = []
  archiveResponses = []
  await uploadWatchNight(seedPod())
})

afterEach(() => {
  vi.useRealTimers()
  rawBiometrics.close()
  rawMain.close()
  fs.rmSync(dir, { recursive: true, force: true })
  Reflect.deleteProperty(process.env, 'BIOMETRICS_ARCHIVE_DIR')
})

describe('biometrics.getReplayBundle', () => {
  it('bundles the overlapping sleep record, the pod rows, profile and timezone', async () => {
    const bundle = await caller.getReplayBundle({ referenceNightId: 1 })

    expect(bundle.version).toBe(1)
    expect(bundle.reference.clockOffsetMs).toBe(CLOCK_OFFSET)
    expect(bundle.window).toEqual({ start: NIGHT_START, end: NIGHT_START + 60 * MIN, sleepRecordId: 1 })
    expect(bundle.profile).toEqual({ age: 40, sex: 'female' })
    expect(bundle.timezone).toBe('America/New_York')
    expect(bundle.heartbeats).toHaveLength(60)
    expect(bundle.movement).toHaveLength(60)
    expect(bundle.vitals[0]).toEqual({ timestamp: NIGHT_START, heartRate: 62, hrv: 40, breathingRate: 14 })
  })

  it('falls back to the reference span when no sleep record overlaps', async () => {
    rawBiometrics.prepare('DELETE FROM sleep_records').run()

    const bundle = await caller.getReplayBundle({ referenceNightId: 1 })

    expect(bundle.window).toEqual({ start: NIGHT_START, end: NIGHT_START + 60 * MIN, sleepRecordId: null })
  })

  it('rejects an unknown reference night', async () => {
    await expect(caller.getReplayBundle({ referenceNightId: 99 })).rejects.toThrow('Reference night 99 not found')
  })
})

describe('replay fetch', () => {
  it('saves one bundle per reference night and the raw frames of its window', async () => {
    archiveResponses.push(() => new Response('busy', { status: 429 }))
    const log: string[] = []

    const result = await fetchCorpus({ pod: 'pod.local', out: dir, limit: 10, raw: true, fetchImpl: podFetch, retryDelayMs: 0, log: l => log.push(l) })

    const name = '2026-09-21-left-1'
    expect(result.bundles).toEqual([path.join(dir, 'nights', `${name}.json`)])
    expect(result.raw).toEqual([path.join(dir, 'raw', `${name}.tar.gz`)])
    expect(fs.readFileSync(result.raw[0], 'utf8')).toBe('tarball')
    expect(archiveRequests).toHaveLength(2) // one busy retry
    expect(archiveRequests[0]).toContain('include=raw')
    expect(log[0]).toBe('1 reference night(s) on http://pod.local:3000')
    expect(log[1]).toContain('sleep record 1')
  })

  it('keeps raw archives it already has unless forced', async () => {
    await fetchCorpus({ pod: 'pod.local', out: dir, limit: 10, raw: true, fetchImpl: podFetch })
    await fetchCorpus({ pod: 'pod.local', out: dir, limit: 10, raw: true, fetchImpl: podFetch })
    expect(archiveRequests).toHaveLength(1)
    await fetchCorpus({ pod: 'pod.local', out: dir, limit: 10, raw: true, force: true, fetchImpl: podFetch })
    expect(archiveRequests).toHaveLength(2)
  })

  it('names bundles by local date, side and id, and pads the raw window like the keep-list', async () => {
    const bundle = await caller.getReplayBundle({ referenceNightId: 1 })
    expect(bundleName(bundle)).toBe('2026-09-21-left-1')
    const url = new URL(rawArchiveUrl('http://pod:3000', bundle))
    expect(Number(url.searchParams.get('startTs'))).toBe((NIGHT_START - 30 * MIN) / 1000)
    expect(Number(url.searchParams.get('endTs'))).toBe((NIGHT_START + 60 * MIN + 45 * MIN) / 1000)
  })

  it('surfaces pod errors', async () => {
    const client = createPodClient('pod.local', podFetch)
    await expect(client.query('biometrics.getReplayBundle', { referenceNightId: 42 })).rejects.toThrow('biometrics.getReplayBundle: Reference night 42 not found')
    const broken = createPodClient('pod.local', async () => new Response('<html>', { status: 502 }))
    await expect(broken.query('biometrics.getReferenceNights', {})).rejects.toThrow('HTTP 502')
  })
})

describe('replay score', () => {
  beforeEach(async () => {
    await fetchCorpus({ pod: 'pod.local', out: dir, limit: 10, raw: false, fetchImpl: podFetch })
  })

  it('re-stages each bundle with the current code and scores it against the watch', () => {
    const report = scoreCorpus(dir, 'abc1234')

    expect(report.gitRef).toBe('abc1234')
    expect(report.nights).toHaveLength(1)
    const { agreement } = report.nights[0]
    expect(agreement.method).toBe('model')
    expect(agreement.stages.scoredEpochs).toBe(120)
    expect(agreement.heart.readings).toBe(5)
    expect(agreement.heart.beatHrCoverage).toBe(1)
    expect(agreement.heart.beatHrMaeBpm).toBeLessThan(2)
    expect(agreement.beatTiming.matchedShare).toBe(1)
    expect(agreement.beatTiming.medianLagMs).toBe(LAG)
    expect(agreement.beatTiming.ibiRmseMs).toBeLessThan(1)
    expect(report.pooled.nights).toBe(1)
  })

  it('formats a report, with changes against a baseline', () => {
    const report = scoreCorpus(dir, 'abc1234')
    const text = formatReport(report, report)

    expect(text).toContain('Replay score — 1 night(s) (1 model, 0 rules) at abc1234')
    expect(text).toContain('2026-09-21-left-1')
    expect(text).toContain('Pooled')
    expect(text).toContain('matched 100.0% of')
    expect(text).toMatch(/κ -?\d\.\d\d \(\+0\.00\)/)
  })

  it('saves, reloads and prints JSON through the CLI', async () => {
    const save = path.join(dir, 'report.json')
    const out: string[] = []

    expect(await main(['score', '--dir', dir, '--save', save], l => out.push(l))).toBe(0)
    expect(parseReport(fs.readFileSync(save, 'utf8')).nights).toHaveLength(1)
    expect(await main(['score', `--dir=${dir}`, '--baseline', save], l => out.push(l))).toBe(0)
    expect(out[1]).toContain('Baseline: 1 night(s)')
    expect(await main(['score', '--dir', dir, '--json'], l => out.push(l))).toBe(0)
    expect(JSON.parse(out[2]).version).toBe(1)
  })

  it('explains an empty corpus and rejects a non-report baseline', async () => {
    expect(() => scoreCorpus(path.join(dir, 'empty'))).toThrow('run `pnpm replay fetch --pod <host>` first')
    expect(() => parseReport('{"version":2}')).toThrow('not a replay score report')
  })
})

describe('replay CLI arguments', () => {
  it('parses commands, valued flags, inline values and booleans', () => {
    expect(parseArgs(['fetch', '--pod', 'pod.local', '--raw', '--limit=5'])).toEqual({
      command: 'fetch',
      flags: { pod: 'pod.local', raw: true, limit: '5' },
    })
    expect(parseArgs([])).toEqual({ command: null, flags: {} })
    expect(() => parseArgs(['fetch', 'stray'])).toThrow('unexpected argument: stray')
  })

  it('validates fetch options before touching the network', async () => {
    const saved = process.env.SLEEPYPOD_POD
    Reflect.deleteProperty(process.env, 'SLEEPYPOD_POD')
    await expect(main(['fetch'], () => {})).rejects.toThrow('--pod <host|url> is required')
    await expect(main(['fetch', '--pod', 'x', '--side', 'middle'], () => {})).rejects.toThrow('--side must be left or right')
    await expect(main(['fetch', '--pod', 'x', '--limit', '0'], () => {})).rejects.toThrow('--limit must be an integer')
    await expect(main(['fetch', '--pod'], () => {})).rejects.toThrow('--pod needs a value')
    if (saved !== undefined) process.env.SLEEPYPOD_POD = saved
  })

  it('prints usage for help and fails for an unknown command', async () => {
    const out: string[] = []
    expect(await main(['help'], l => out.push(l))).toBe(0)
    expect(await main(['bogus'], l => out.push(l))).toBe(1)
    expect(out[0]).toContain('pnpm replay fetch')
  })

  it('normalizes pod addresses', () => {
    expect(normalizePodUrl('pod.local')).toBe('http://pod.local:3000')
    expect(normalizePodUrl('192.168.1.20:8080')).toBe('http://192.168.1.20:8080')
    expect(normalizePodUrl('https://pod.example/')).toBe('https://pod.example')
  })
})

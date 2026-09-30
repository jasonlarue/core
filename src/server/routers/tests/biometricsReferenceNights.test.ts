/**
 * biometrics.reportReferenceNight / getReferenceNights / deleteReferenceNights
 * against a real, migrated in-memory biometrics DB — the overlap-replace and
 * keep-list behaviour lives in SQL, so a chain mock would not exercise it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { KEEP_LIST_NAME, KEEP_PAD_AFTER_MS, KEEP_PAD_BEFORE_MS, RAW_KEEP_NIGHTS } from '@/src/lib/rawKeepList'

const state = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle<typeof schema>> | null,
  podVersion: 'I00' as string | null,
  monitorRunning: true,
}))

vi.mock('@/src/db', () => ({
  get biometricsDb() {
    if (!state.db) throw new Error('test db not initialised')
    return state.db
  },
  db: {},
}))

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitorIfRunning: () => state.monitorRunning
    ? { getLastStatus: () => (state.podVersion ? { podVersion: state.podVersion } : null) }
    : null,
}))

const { biometricsRouter } = await import('@/src/server/routers/biometrics')
const caller = biometricsRouter.createCaller({})

const HOUR = 3_600_000
const NOW = 1_790_000_000_000
let raw: Database.Database
let archiveDir: string
const originalArchiveDir = process.env.BIOMETRICS_ARCHIVE_DIR

/** A valid upload for one night starting at `start` (reference clock). */
function night(start: number, overrides: Record<string, unknown> = {}) {
  return {
    side: 'left' as const,
    source: 'apple-watch' as const,
    deviceModel: 'Watch7,1',
    nightStart: start,
    nightEnd: start + 8 * HOUR,
    sentAt: NOW,
    stages: [
      { start, end: start + 4 * HOUR, stage: 'light' as const },
      { start: start + 4 * HOUR, end: start + 8 * HOUR, stage: 'rem' as const },
    ],
    heartRate: [{ t: start + HOUR, bpm: 55 }],
    hrv: [{ t: start + HOUR, sdnnMs: 48 }],
    beatSeries: [{ start: start + HOUR, beats: [{ t: 0, gap: false }, { t: 1010.5, gap: false }] }],
    respiratoryRate: [{ t: start + HOUR, rate: 14 }],
    ...overrides,
  }
}

function keepListLines(): string[] {
  const file = path.join(archiveDir, KEEP_LIST_NAME)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith('#'))
}

beforeEach(() => {
  raw = new Database(':memory:')
  state.db = drizzle(raw, { schema })
  migrate(state.db, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') })
  state.podVersion = 'I00'
  state.monitorRunning = true
  archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleepypod-keep-'))
  process.env.BIOMETRICS_ARCHIVE_DIR = archiveDir
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  raw.close()
  state.db = null
  fs.rmSync(archiveDir, { recursive: true, force: true })
  if (originalArchiveDir === undefined) Reflect.deleteProperty(process.env, 'BIOMETRICS_ARCHIVE_DIR')
  else process.env.BIOMETRICS_ARCHIVE_DIR = originalArchiveDir
})

describe('biometrics.reportReferenceNight', () => {
  it('stores the night with its payloads, clock offset and pod version', async () => {
    const start = NOW - 10 * HOUR
    const out = await caller.reportReferenceNight(night(start, { sentAt: NOW - 2500 }))

    expect(out).toEqual({ id: 1, replaced: 0, clockOffsetMs: 2500 })
    const [stored] = await caller.getReferenceNights({})
    expect(stored).toEqual({
      id: 1,
      side: 'left',
      source: 'apple-watch',
      deviceModel: 'Watch7,1',
      podVersion: 'I00',
      nightStart: start,
      nightEnd: start + 8 * HOUR,
      stages: night(start).stages,
      heartRate: [{ t: start + HOUR, bpm: 55 }],
      hrv: [{ t: start + HOUR, sdnnMs: 48 }],
      beatSeries: [{ start: start + HOUR, beats: [{ t: 0, gap: false }, { t: 1010.5, gap: false }] }],
      respiratoryRate: [{ t: start + HOUR, rate: 14 }],
      clockOffsetMs: 2500,
    })
  })

  it('records a negative offset when the pod clock is behind the phone', async () => {
    const out = await caller.reportReferenceNight(night(NOW - 10 * HOUR, { sentAt: NOW + 90_000 }))
    expect(out.clockOffsetMs).toBe(-90_000)
  })

  it('stores a null pod version when the DAC monitor is not running or has no status', async () => {
    state.monitorRunning = false
    await caller.reportReferenceNight(night(NOW - 30 * HOUR))
    state.monitorRunning = true
    state.podVersion = null
    await caller.reportReferenceNight(night(NOW - 10 * HOUR))

    const nights = await caller.getReferenceNights({})
    expect(nights.map(n => n.podVersion)).toEqual([null, null])
  })

  it('defaults optional payloads to empty arrays and the device model to null', async () => {
    const start = NOW - 10 * HOUR
    await caller.reportReferenceNight({
      side: 'right',
      source: 'apple-watch',
      nightStart: start,
      nightEnd: start + HOUR,
      sentAt: NOW,
      stages: [{ start, end: start + HOUR, stage: 'deep' }],
    })

    const [stored] = await caller.getReferenceNights({})
    expect(stored.deviceModel).toBeNull()
    expect(stored.heartRate).toEqual([])
    expect(stored.hrv).toEqual([])
    expect(stored.beatSeries).toEqual([])
    expect(stored.respiratoryRate).toEqual([])
  })

  it('replaces an overlapping night on the same side only', async () => {
    const start = NOW - 30 * HOUR
    await caller.reportReferenceNight(night(start))
    await caller.reportReferenceNight(night(start, { side: 'right' }))
    await caller.reportReferenceNight(night(start + 24 * HOUR)) // next night, no overlap

    // Re-sync of the first left night after an edit: starts later, still overlaps.
    const out = await caller.reportReferenceNight(night(start + HOUR, { heartRate: [{ t: start + 2 * HOUR, bpm: 60 }] }))

    expect(out.replaced).toBe(1)
    const left = await caller.getReferenceNights({ side: 'left' })
    expect(left.map(n => n.nightStart)).toEqual([start + 24 * HOUR, start + HOUR])
    expect(left[1].heartRate).toEqual([{ t: start + 2 * HOUR, bpm: 60 }])
    expect(await caller.getReferenceNights({ side: 'right' })).toHaveLength(1)
  })

  it('treats nights that only touch at an edge as overlapping', async () => {
    const start = NOW - 30 * HOUR
    await caller.reportReferenceNight(night(start))
    const out = await caller.reportReferenceNight(night(start + 8 * HOUR))
    expect(out.replaced).toBe(1)
  })

  it.each([
    ['end before start', { nightEnd: NOW - 11 * HOUR, nightStart: NOW - 10 * HOUR }],
    ['night longer than 24 h', { nightStart: NOW - 30 * HOUR, nightEnd: NOW - 5 * HOUR }],
    ['stage ending before it starts', { stages: [{ start: NOW - 5 * HOUR, end: NOW - 6 * HOUR, stage: 'light' }] }],
    ['unknown stage', { stages: [{ start: NOW - 6 * HOUR, end: NOW - 5 * HOUR, stage: 'asleep' }] }],
    ['no stages', { stages: [] }],
    ['implausible heart rate', { heartRate: [{ t: NOW - 6 * HOUR, bpm: 400 }] }],
    ['unknown field', { extra: true }],
    ['non-watch source', { source: 'oura' }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(caller.reportReferenceNight(night(NOW - 10 * HOUR, overrides) as never)).rejects.toThrow()
    expect(await caller.getReferenceNights({})).toHaveLength(0)
  })

  it('accepts a night of exactly 24 h', async () => {
    const start = NOW - 30 * HOUR
    await expect(caller.reportReferenceNight(night(start, { nightEnd: start + 24 * HOUR }))).resolves.toMatchObject({ id: 1 })
  })
})

describe('raw keep-list', () => {
  it('writes each night window on the pod clock, padded', async () => {
    const start = NOW - 10 * HOUR
    await caller.reportReferenceNight(night(start, { sentAt: NOW - 60_000 }))

    const podStart = start + 60_000
    const podEnd = start + 8 * HOUR + 60_000
    expect(keepListLines()).toEqual([
      `${Math.floor((podStart - KEEP_PAD_BEFORE_MS) / 1000)} ${Math.ceil((podEnd + KEEP_PAD_AFTER_MS) / 1000)}`,
    ])
  })

  it('keeps only the most recent nights', async () => {
    for (let i = 0; i < RAW_KEEP_NIGHTS + 2; i++) {
      await caller.reportReferenceNight(night(NOW - (i + 1) * 24 * HOUR))
    }

    const lines = keepListLines()
    expect(lines).toHaveLength(RAW_KEEP_NIGHTS)
    // Most recent first; the two oldest nights dropped out.
    const oldestKeptStart = NOW - RAW_KEEP_NIGHTS * 24 * HOUR
    expect(lines.at(-1)).toBe(`${Math.floor((oldestKeptStart - KEEP_PAD_BEFORE_MS) / 1000)} ${Math.ceil((oldestKeptStart + 8 * HOUR + KEEP_PAD_AFTER_MS) / 1000)}`)
  })

  it('still stores the night when the keep-list cannot be written', async () => {
    fs.mkdirSync(path.join(archiveDir, KEEP_LIST_NAME)) // a directory where the file goes
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(caller.reportReferenceNight(night(NOW - 10 * HOUR))).resolves.toMatchObject({ id: 1 })
    expect(warn).toHaveBeenCalledWith('[biometrics] failed to refresh raw keep-list:', expect.any(String))
    warn.mockRestore()
  })

  it('writes nothing when the archive directory does not exist', async () => {
    process.env.BIOMETRICS_ARCHIVE_DIR = path.join(archiveDir, 'missing')
    await caller.reportReferenceNight(night(NOW - 10 * HOUR))
    expect(fs.existsSync(path.join(archiveDir, 'missing'))).toBe(false)
  })
})

describe('biometrics.getReferenceNights', () => {
  beforeEach(async () => {
    await caller.reportReferenceNight(night(NOW - 72 * HOUR))
    await caller.reportReferenceNight(night(NOW - 48 * HOUR, { side: 'right' }))
    await caller.reportReferenceNight(night(NOW - 24 * HOUR))
  })

  it('returns the most recent nights first', async () => {
    const nights = await caller.getReferenceNights({})
    expect(nights.map(n => n.nightStart)).toEqual([NOW - 24 * HOUR, NOW - 48 * HOUR, NOW - 72 * HOUR])
  })

  it('filters by side', async () => {
    const nights = await caller.getReferenceNights({ side: 'right' })
    expect(nights.map(n => n.nightStart)).toEqual([NOW - 48 * HOUR])
  })

  it('filters by night start, bounds inclusive', async () => {
    const nights = await caller.getReferenceNights({
      startDate: new Date(NOW - 48 * HOUR),
      endDate: new Date(NOW - 24 * HOUR),
    })
    expect(nights.map(n => n.nightStart)).toEqual([NOW - 24 * HOUR, NOW - 48 * HOUR])
  })

  it('honours the limit', async () => {
    expect(await caller.getReferenceNights({ limit: 1 })).toHaveLength(1)
  })

  it('rejects a start date after the end date', async () => {
    await expect(caller.getReferenceNights({
      startDate: new Date(NOW),
      endDate: new Date(NOW - HOUR),
    })).rejects.toThrow('startDate must be before or equal to endDate')
  })
})

describe('biometrics.deleteReferenceNights', () => {
  beforeEach(async () => {
    await caller.reportReferenceNight(night(NOW - 48 * HOUR))
    await caller.reportReferenceNight(night(NOW - 24 * HOUR, { side: 'right' }))
  })

  it('deletes one side and refreshes the keep-list', async () => {
    expect(await caller.deleteReferenceNights({ side: 'left' })).toEqual({ deleted: 1 })
    expect((await caller.getReferenceNights({})).map(n => n.side)).toEqual(['right'])
    expect(keepListLines()).toHaveLength(1)
  })

  it('deletes every side when none is given', async () => {
    expect(await caller.deleteReferenceNights({})).toEqual({ deleted: 2 })
    expect(await caller.getReferenceNights({})).toEqual([])
    expect(keepListLines()).toEqual([])
  })
})

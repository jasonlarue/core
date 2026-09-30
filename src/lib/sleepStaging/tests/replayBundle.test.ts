import { describe, expect, it, vi } from 'vitest'
import { chooseWindow, podNightFromBundle, referencePodSpan, type ReplayBundle } from '../replayBundle'
import { stageWindow } from '../stageWindow'

const H = 3_600_000
const ref = { nightStart: 10 * H, nightEnd: 18 * H, clockOffsetMs: 60_000 }

describe('chooseWindow', () => {
  it('picks the sleep record that overlaps the reference night most', () => {
    const window = chooseWindow(ref, [
      { id: 1, enteredBedAt: 9 * H, leftBedAt: 11 * H }, // 1 h overlap
      { id: 2, enteredBedAt: 11 * H, leftBedAt: 19 * H }, // ~7 h
      { id: 3, enteredBedAt: 20 * H, leftBedAt: 21 * H }, // none
    ])
    expect(window).toEqual({ start: 11 * H, end: 19 * H, sleepRecordId: 2 })
  })

  it('uses the reference span on the pod clock when no record overlaps', () => {
    expect(chooseWindow(ref, [{ id: 1, enteredBedAt: 0, leftBedAt: 10 * H + 60_000 }]))
      .toEqual({ start: 10 * H + 60_000, end: 18 * H + 60_000, sleepRecordId: null })
    expect(referencePodSpan(ref)).toEqual({ start: 10 * H + 60_000, end: 18 * H + 60_000 })
  })
})

describe('podNightFromBundle', () => {
  const bundle: ReplayBundle = {
    version: 1,
    reference: {
      id: 1, side: 'left', source: 'apple-watch', deviceModel: null, podVersion: null,
      nightStart: 0, nightEnd: H, stages: [], heartRate: [], hrv: [], beatSeries: [], respiratoryRate: [], clockOffsetMs: 0,
    },
    window: { start: 1000, end: 2000, sleepRecordId: 7 },
    profile: { age: 33, sex: 'male' },
    timezone: 'Europe/Berlin',
    heartbeats: [{ timestamp: 1000, beats: [0, null, 900] }],
    movement: [{ timestamp: 1000, totalMovement: 12 }],
    vitals: [{ timestamp: 1000, heartRate: 60, hrv: null, breathingRate: 14 }],
  }

  it('hands the stager Dates and the profile, and returns its result with the pod rows', () => {
    const stage = vi.fn(() => ({ epochs: [], method: 'rules' as const, fallbackReason: 'coverage' as const }))

    const night = podNightFromBundle(bundle, stage)

    expect(stage).toHaveBeenCalledWith({
      chunks: [{ timestamp: new Date(1000), beats: [0, null, 900] }],
      windowStart: new Date(1000),
      windowEnd: new Date(2000),
      timezone: 'Europe/Berlin',
      age: 33,
      sex: 'male',
      movement: [{ timestamp: new Date(1000), totalMovement: 12 }],
      vitals: [{ timestamp: new Date(1000), heartRate: 60, hrv: null, breathingRate: 14 }],
    })
    expect(night).toMatchObject({ windowStart: 1000, windowEnd: 2000, method: 'rules', fallbackReason: 'coverage' })
    expect(night.heartbeats[0].timestamp).toEqual(new Date(1000))
  })
})

describe('stageWindow', () => {
  it('falls back to the rule-based stager with the reason when the model cannot run', () => {
    const vitals = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(i * 60_000), heartRate: 60 + i, hrv: 40, breathingRate: 14,
    }))
    const out = stageWindow({
      chunks: [],
      windowStart: new Date(0),
      windowEnd: new Date(3 * H),
      timezone: 'UTC',
      age: null,
      sex: null,
      movement: [],
      vitals,
    })
    expect(out.method).toBe('rules')
    expect(out.fallbackReason).toBe('profile')
    expect(out.epochs.length).toBeGreaterThan(0)
  })
})

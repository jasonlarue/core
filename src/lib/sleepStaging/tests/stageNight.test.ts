import { describe, expect, it } from 'vitest'
import { beatsToRri, MIN_BEAT_COVERAGE, recordingStartSec, secondsSinceLocalMidnight, stageNight, type HeartbeatChunk } from '../stageNight'
import parity from './fixtures/wrn-gru-mesa.parity.json'

const T0 = Date.UTC(2026, 8, 25, 3, 15, 0) // 23:15 in America/New_York (EDT)

/** Pack beat times (s from T0) into minute chunks as the piezo-processor stores them. */
function chunk(beatsS: number[], startMs = T0): HeartbeatChunk[] {
  const byMinute = new Map<number, number[]>()
  for (const t of beatsS) {
    const ms = startMs + t * 1000
    const minute = Math.floor(ms / 60_000) * 60_000
    const list = byMinute.get(minute) ?? []
    list.push(Math.round(ms - minute))
    byMinute.set(minute, list)
  }
  return [...byMinute.entries()].sort((a, b) => a[0] - b[0])
    .map(([m, beats]) => ({ timestamp: new Date(m), beats }))
}

describe('beatsToRri', () => {
  it('builds intervals within a run and across consecutive minutes', () => {
    const { rri, rriTimes } = beatsToRri(chunk([58, 59, 60, 61]), T0, T0 + 120_000)
    expect(rri).toEqual([1, 1, 1])
    expect(rriTimes).toEqual([59, 60, 61])
  })

  it('marks a stored break as a missed beat, never an interval across it', () => {
    const chunks: HeartbeatChunk[] = [{ timestamp: new Date(T0), beats: [0, 1000, null, 2500, 3500] }]
    const { rri, rriTimes } = beatsToRri(chunks, T0, T0 + 60_000)
    expect(rri).toEqual([1, NaN, 1])
    expect(rriTimes).toEqual([1, 2.5, 3.5])
  })

  it('marks a missing minute as a missed beat', () => {
    const chunks: HeartbeatChunk[] = [
      { timestamp: new Date(T0), beats: [59_000] },
      { timestamp: new Date(T0 + 120_000), beats: [500, 1500] },
    ]
    expect(beatsToRri(chunks, T0, T0 + 180_000)).toEqual({ rri: [NaN, 1], rriTimes: [120.5, 121.5] })
  })

  it('ignores beats outside the session, and a run starting it has no gap before it', () => {
    const { rri } = beatsToRri(chunk([-2, -1, 0, 1, 2]), T0, T0 + 1500)
    expect(rri).toEqual([1])
  })
})

describe('secondsSinceLocalMidnight', () => {
  it('uses the device timezone', () => {
    expect(secondsSinceLocalMidnight(new Date(T0), 'America/New_York')).toBe(23 * 3600 + 15 * 60)
    expect(secondsSinceLocalMidnight(new Date(T0), 'UTC')).toBe(3 * 3600 + 15 * 60)
  })
})

describe('recordingStartSec', () => {
  it('keeps an evening start as is', () => {
    expect(recordingStartSec(new Date(T0), 'America/New_York')).toBe(23 * 3600 + 15 * 60)
  })

  it('continues past midnight for a night that starts after it', () => {
    // 00:22 local: the evening scale the model was trained on, not ~0.
    const start = Date.UTC(2026, 8, 26, 4, 22, 0)
    expect(recordingStartSec(new Date(start), 'America/New_York')).toBe(24 * 3600 + 22 * 60)
  })

  it('treats noon as the turn of the night', () => {
    const noon = Date.UTC(2026, 8, 26, 16, 0, 0) // 12:00 EDT
    expect(recordingStartSec(new Date(noon), 'America/New_York')).toBe(12 * 3600)
    expect(recordingStartSec(new Date(noon - 1000), 'America/New_York')).toBe(36 * 3600 - 1)
  })
})

describe('stageNight', () => {
  const fixture = (parity as { fixtures: Array<{ name: string, heartbeatTimes: number[] }> }).fixtures
    .find(f => f.name === 'A')
  if (!fixture) throw new Error('parity fixture A missing')
  const beats = fixture.heartbeatTimes
  const windowEnd = new Date(T0 + Math.floor(beats[beats.length - 1] / 30) * 30_000)
  const base = {
    chunks: chunk(beats),
    windowStart: new Date(T0),
    windowEnd,
    timezone: 'America/New_York',
    age: 45,
    sex: 'male' as const,
    movement: [],
    vitals: [],
  }

  it('falls back when the sleeper profile is unset', () => {
    expect(stageNight({ ...base, age: null })).toEqual({ ok: false, reason: 'profile' })
    expect(stageNight({ ...base, sex: null })).toEqual({ ok: false, reason: 'profile' })
  })

  it('falls back when too little of the night has heartbeats', () => {
    const sparse = beats.filter(t => t < 0.3 * beats[beats.length - 1])
    const out = stageNight({ ...base, chunks: chunk(sparse) })
    expect(out).toEqual({ ok: false, reason: 'coverage' })
    expect(MIN_BEAT_COVERAGE).toBe(0.5)
  })

  it('falls back when most heart-rate windows are gappy, even with beats in every one', () => {
    // 4 s of beats in every 10 s: each window has intervals, but most of
    // its time is missing, so no spectral features.
    const gappy = beats.filter(t => t % 10 < 4)
    const out = stageNight({ ...base, chunks: chunk(gappy) })
    expect(out).toEqual({ ok: false, reason: 'coverage' })
  })

  it('stages a night in 30 s epochs with the model and deep-sleep rules', () => {
    const out = stageNight(base)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.coverage).toBeGreaterThan(0.95)
    expect(out.epochs).toHaveLength(200)
    expect(out.epochs[1].start - out.epochs[0].start).toBe(30_000)
    for (const e of out.epochs) {
      expect(['wake', 'light', 'deep', 'rem']).toContain(e.stage)
      if (e.heartRate !== null) expect(e.heartRate).toBeGreaterThan(45)
    }
    const deep = out.epochs.filter(e => e.stage === 'deep').length
    expect(deep).toBeLessThanOrEqual(0.25 * out.epochs.filter(e => e.stage !== 'wake').length)
  })

  it('marks heart-less epochs as wake when moving', () => {
    const gapStart = 1500
    const gapped = beats.filter(t => t < gapStart || t > gapStart + 300)
    const movement = [{ timestamp: new Date(T0 + (gapStart + 120) * 1000), totalMovement: 800 }]
    const out = stageNight({ ...base, chunks: chunk(gapped), movement })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const idx = Math.floor((gapStart + 120) / 30)
    expect(out.epochs[idx].heartRate).toBeNull()
    expect(out.epochs[idx].stage).toBe('wake')
  })
})

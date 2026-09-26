/**
 * Stage one night from detected heartbeats: wrn-gru-mesa (wake / REM /
 * NREM) plus the deep-sleep rules within NREM.
 *
 * Returns `{ ok: false, reason }` — callers then use the rule-based stager —
 * when the model's inputs aren't there: the sleeper profile (age, sex) is
 * unset (`profile`), or the night is shorter than MIN_STAGES or fewer than
 * MIN_BEAT_COVERAGE of its stages have a usable heart-rate window
 * (`coverage`).
 */
import type { SleepEpoch, SleepStage } from '@/src/lib/sleep-stages'
import { detectDeepSleep, type DeepSleepEpoch } from './deepSleep'
import { extractFeatures, FEATURE_IDS, WRN_GRU_MESA_PARAMS, type Sex } from './hrvFeatures'
import { predictStages, type ModelWeights } from './gruModel'
import weightsJson from './wrn-gru-mesa.weights.json'

const WEIGHTS = weightsJson as unknown as ModelWeights
const STAGE_S = WRN_GRU_MESA_PARAMS.stageDuration
const COL = Object.fromEntries(FEATURE_IDS.map((id, i) => [id, i])) as Record<(typeof FEATURE_IDS)[number], number>

/**
 * Share of stages that must have a usable HRV window — at most half of it
 * missing, SleepECG's own limit for its spectral features — for the model to
 * be trusted over the rules. The model was trained on ECG, where nearly every
 * window qualifies; with most windows gappy its output leans on age and time
 * of night instead of the heart.
 */
export const MIN_BEAT_COVERAGE = 0.5
/** Shorter than this (in stages) and there's nothing meaningful to stage. */
export const MIN_STAGES = 20
/** Movement at or above this marks an epoch without heart data as wake. */
const WAKE_MOVEMENT = 200

export interface HeartbeatChunk {
  timestamp: Date
  /** ms offsets from `timestamp`; null = break (no interval across it). */
  beats: Array<number | null>
}

export interface StageNightInput {
  chunks: HeartbeatChunk[]
  windowStart: Date
  windowEnd: Date
  /** Device timezone — the model's recording_start_time is local. */
  timezone: string
  age: number | null
  sex: Sex | null
  movement: Array<{ timestamp: Date, totalMovement: number }>
  vitals: Array<{ timestamp: Date, breathingRate: number | null }>
}

export interface StagedNight { ok: true, epochs: SleepEpoch[], coverage: number }
export interface UnstagedNight { ok: false, reason: 'profile' | 'coverage' }
export type StageNightOutcome = StagedNight | UnstagedNight

/**
 * RR intervals (s) and the times of their closing beats (s from `startMs`)
 * within [startMs, endMs). No interval spans a break, a missing minute or a
 * non-consecutive chunk: the first beat after one closes a NaN interval,
 * which is how SleepECG represents a missed beat (an over-long RR marked
 * invalid). Its resampling and successive differences then stop at the gap
 * instead of joining the intervals on either side.
 */
export function beatsToRri(chunks: HeartbeatChunk[], startMs: number, endMs: number) {
  const rri: number[] = []
  const rriTimes: number[] = []
  const sorted = [...chunks].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  let prev: number | null = null
  let seen = false // a beat in the window before the current run
  let prevChunkEnd: number | null = null
  for (const chunk of sorted) {
    const base = chunk.timestamp.getTime()
    if (prevChunkEnd !== null && base !== prevChunkEnd) prev = null
    prevChunkEnd = base + 60_000
    for (const off of chunk.beats) {
      if (off === null) {
        prev = null
        continue
      }
      const t = base + off
      if (t < startMs || t >= endMs) {
        prev = null
        continue
      }
      if (prev !== null || seen) {
        rri.push(prev !== null ? (t - prev) / 1000 : NaN)
        rriTimes.push((t - startMs) / 1000)
      }
      prev = t
      seen = true
    }
  }
  return { rri, rriTimes }
}

/**
 * The model's recording_start_time: seconds since local midnight, counted
 * from the previous day for a start before noon. wrn-gru-mesa was trained on
 * recordings started in the evening (21:21 +- 1.6 h), so a night that starts
 * at 00:22 is 87,720 s, the same scale, not 1,320 s, 13 SD from anything it
 * saw.
 */
export function recordingStartSec(date: Date, timezone: string): number {
  const s = secondsSinceLocalMidnight(date, timezone)
  return s < 12 * 3600 ? s + 24 * 3600 : s
}

/** Seconds since local midnight of `date` in `timezone`. */
export function secondsSinceLocalMidnight(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  }).formatToParts(date)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0)
  return (get('hour') % 24) * 3600 + get('minute') * 60 + get('second')
}

function nearestBy<T>(rows: T[], ms: number, at: (r: T) => number, maxGapMs: number): T | null {
  let best: T | null = null
  let bestGap = Infinity
  for (const r of rows) {
    const gap = Math.abs(at(r) - ms)
    if (gap < bestGap) {
      best = r
      bestGap = gap
    }
  }
  return bestGap <= maxGapMs ? best : null
}

export function stageNight(input: StageNightInput): StageNightOutcome {
  if (input.age === null || input.sex === null) return { ok: false, reason: 'profile' }
  const startMs = input.windowStart.getTime()
  const endMs = input.windowEnd.getTime()
  const numStages = Math.floor((endMs - startMs) / 1000 / STAGE_S)
  if (numStages < MIN_STAGES) return { ok: false, reason: 'coverage' }

  const { rri, rriTimes } = beatsToRri(input.chunks, startMs, endMs)
  const features = extractFeatures({
    rri,
    rriTimes,
    numStages,
    recordingStartSec: recordingStartSec(input.windowStart, input.timezone),
    age: input.age,
    sex: input.sex,
  })
  const hasHeart = features.map(row => Number.isFinite(row[COL.meanNN]))
  const usable = features.filter(row => Number.isFinite(row[COL.total_power])).length
  const coverage = usable / numStages
  if (coverage < MIN_BEAT_COVERAGE) return { ok: false, reason: 'coverage' }

  const probs = predictStages(features, WEIGHTS)
  const movementAt = (ms: number) => nearestBy(input.movement, ms, r => r.timestamp.getTime(), 60_000)?.totalMovement ?? null
  // Classes: [UNDEFINED, NREM, REM, WAKE]; UNDEFINED is never a real stage.
  const coarse: Array<'nrem' | 'rem' | 'wake'> = probs.map((p, i) => {
    if (!hasHeart[i]) {
      const mv = movementAt(startMs + (i + 0.5) * STAGE_S * 1000)
      return mv !== null && mv > WAKE_MOVEMENT ? 'wake' : 'nrem'
    }
    const [, nrem, rem, wake] = p
    return nrem >= rem && nrem >= wake ? 'nrem' : rem >= wake ? 'rem' : 'wake'
  })

  const deepInput: DeepSleepEpoch[] = features.map((row, i) => ({
    nrem: coarse[i] === 'nrem' && hasHeart[i],
    meanHR: row[COL.meanHR],
    lfHfRatio: row[COL.LF_HF_ratio],
    hfNorm: row[COL.HF_norm],
    movement: movementAt(startMs + (i + 0.5) * STAGE_S * 1000),
  }))
  const deep = detectDeepSleep(deepInput, coarse.map(c => c !== 'wake'))

  const epochs: SleepEpoch[] = coarse.map((c, i) => {
    const start = startMs + i * STAGE_S * 1000
    const stage: SleepStage = c === 'wake' ? 'wake' : c === 'rem' ? 'rem' : deep[i] ? 'deep' : 'light'
    const row = features[i]
    const br = nearestBy(input.vitals, start + STAGE_S * 500, r => r.timestamp.getTime(), 60_000)
    return {
      start,
      duration: STAGE_S * 1000,
      stage,
      heartRate: Number.isFinite(row[COL.meanHR]) ? row[COL.meanHR] : null,
      hrv: Number.isFinite(row[COL.RMSSD]) ? row[COL.RMSSD] * 1000 : null,
      breathingRate: br?.breathingRate ?? null,
      movement: deepInput[i].movement,
    }
  })
  return { ok: true, epochs, coverage }
}

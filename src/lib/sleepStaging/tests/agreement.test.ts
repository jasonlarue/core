import { describe, expect, it } from 'vitest'
import type { SleepEpoch, SleepStage } from '@/src/lib/sleep-stages'
import type { HeartbeatChunk } from '../stageNight'
import type { ReferenceNight } from '../referenceNight'
import {
  cohensKappa,
  EPOCH_MS,
  podBeatRuns,
  poolAgreement,
  scoreNight,
  toSleepWake,
  type PodNight,
} from '../agreement'

const T0 = 1_790_000_000_000 // pod clock
const MIN = 60_000

function epochs(start: number, stages: SleepStage[], duration = EPOCH_MS): SleepEpoch[] {
  return stages.map((stage, i) => ({
    start: start + i * duration,
    duration,
    stage,
    heartRate: null,
    hrv: null,
    breathingRate: null,
    movement: null,
  }))
}

function podNight(overrides: Partial<PodNight> = {}): PodNight {
  return {
    windowStart: T0,
    windowEnd: T0 + 8 * 60 * MIN,
    epochs: [],
    method: 'model',
    fallbackReason: null,
    heartbeats: [],
    vitals: [],
    ...overrides,
  }
}

function refNight(overrides: Partial<ReferenceNight> = {}): ReferenceNight {
  return {
    id: 1,
    side: 'left',
    source: 'apple-watch',
    deviceModel: null,
    podVersion: null,
    nightStart: T0,
    nightEnd: T0 + 8 * 60 * MIN,
    stages: [],
    heartRate: [],
    hrv: [],
    beatSeries: [],
    respiratoryRate: [],
    clockOffsetMs: 0,
    ...overrides,
  }
}

/** Heartbeat chunks (one per minute) from absolute beat times; `null` entries are breaks. */
function chunks(beats: Array<number | null>): HeartbeatChunk[] {
  const out = new Map<number, Array<number | null>>()
  let lastBase = Math.floor(T0 / MIN) * MIN
  for (const b of beats) {
    if (b === null) {
      out.get(lastBase)?.push(null)
      continue
    }
    const base = Math.floor(b / MIN) * MIN
    lastBase = base
    const list = out.get(base) ?? []
    list.push(b - base)
    out.set(base, list)
  }
  return [...out.entries()].map(([base, list]) => ({ timestamp: new Date(base), beats: list }))
}

/** Regular beats every `ibi` ms from `start` (inclusive) to `end` (exclusive). */
function regularBeats(start: number, end: number, ibi: number): number[] {
  const out: number[] = []
  for (let t = start; t < end; t += ibi) out.push(t)
  return out
}

describe('cohensKappa', () => {
  it('is 1 for perfect agreement', () => {
    expect(cohensKappa([[5, 0], [0, 7]])).toBe(1)
  })

  it('matches a worked example', () => {
    // po = 0.7, pe = (25·30 + 25·20) / 50² = 0.5 → κ = 0.4
    expect(cohensKappa([[20, 5], [10, 15]])).toBeCloseTo(0.4, 10)
  })

  it('is 0 at chance-level agreement', () => {
    expect(cohensKappa([[25, 25], [25, 25]])).toBeCloseTo(0, 10)
  })

  it('is negative below chance', () => {
    expect(cohensKappa([[0, 10], [10, 0]])).toBeCloseTo(-1, 10)
  })

  it('is null with nothing scored or when both sides used one class', () => {
    expect(cohensKappa([[0, 0], [0, 0]])).toBeNull()
    expect(cohensKappa([[9, 0], [0, 0]])).toBeNull()
  })
})

describe('toSleepWake', () => {
  it('collapses light, deep and REM into sleep', () => {
    const c = [
      [1, 2, 3, 4], // watch wake
      [5, 6, 7, 8], // watch light
      [9, 10, 11, 12], // watch deep
      [13, 14, 15, 16], // watch REM
    ]
    expect(toSleepWake(c)).toEqual([
      [1, 2 + 3 + 4],
      [5 + 9 + 13, 6 + 7 + 8 + 10 + 11 + 12 + 14 + 15 + 16],
    ])
  })
})

describe('podBeatRuns', () => {
  it('joins consecutive chunks into one run', () => {
    const runs = podBeatRuns([
      { timestamp: new Date(T0), beats: [0, 30_000] },
      { timestamp: new Date(T0 + MIN), beats: [10_000] },
    ])
    expect(runs).toEqual([[T0, T0 + 30_000, T0 + MIN + 10_000]])
  })

  it('splits runs at breaks and at gaps between chunks, in time order', () => {
    const runs = podBeatRuns([
      { timestamp: new Date(T0 + 3 * MIN), beats: [0] },
      { timestamp: new Date(T0), beats: [0, null, 1000, 2000] },
    ])
    expect(runs).toEqual([[T0], [T0 + 1000, T0 + 2000], [T0 + 3 * MIN]])
  })
})

describe('scoreNight — stages', () => {
  it('fills the confusion matrix on the overlap, watch rows × pod columns', () => {
    const pod = podNight({ epochs: epochs(T0, ['wake', 'light', 'light', 'deep', 'rem', 'rem']) })
    const ref = refNight({
      stages: [
        { start: T0, end: T0 + EPOCH_MS, stage: 'wake' },
        { start: T0 + EPOCH_MS, end: T0 + 3 * EPOCH_MS, stage: 'light' },
        { start: T0 + 3 * EPOCH_MS, end: T0 + 4 * EPOCH_MS, stage: 'light' }, // pod says deep
        { start: T0 + 4 * EPOCH_MS, end: T0 + 6 * EPOCH_MS, stage: 'rem' },
      ],
    })

    const { stages } = scoreNight(pod, ref)

    expect(stages.confusion).toEqual([
      [1, 0, 0, 0],
      [0, 2, 1, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 2],
    ])
    expect(stages.overlapEpochs).toBe(6)
    expect(stages.scoredEpochs).toBe(6)
    expect(stages.accuracy).toBeCloseTo(5 / 6, 10)
    expect(stages.sleepWakeAccuracy).toBe(1)
    expect(stages.podMinutes).toEqual({ wake: 0.5, light: 1, deep: 0.5, rem: 1 })
    expect(stages.refMinutes).toEqual({ wake: 0.5, light: 1.5, deep: 0, rem: 1 })
  })

  it('moves watch times onto the pod clock with the stored offset', () => {
    // The pod clock runs 90 s ahead: the watch's 00:00 is the pod's 00:01:30.
    const offset = 90_000
    const pod = podNight({ epochs: epochs(T0 + offset, ['light', 'light', 'deep', 'deep']) })
    const ref = refNight({
      clockOffsetMs: offset,
      stages: [
        { start: T0, end: T0 + 2 * EPOCH_MS, stage: 'light' },
        { start: T0 + 2 * EPOCH_MS, end: T0 + 4 * EPOCH_MS, stage: 'deep' },
      ],
    })

    const { stages } = scoreNight(pod, ref)

    expect(stages.accuracy).toBe(1)
    expect(stages.scoredEpochs).toBe(4)
  })

  it('samples variable-length pod epochs at each 30 s grid midpoint', () => {
    // Rule-based stager: one 5-minute epoch of light, one of deep.
    const pod = podNight({ epochs: epochs(T0, ['light', 'deep'], 5 * MIN) })
    const ref = refNight({ stages: [{ start: T0, end: T0 + 10 * MIN, stage: 'light' }] })

    const { stages } = scoreNight(pod, ref)

    expect(stages.overlapEpochs).toBe(20)
    expect(stages.confusion[1]).toEqual([0, 10, 10, 0])
  })

  it('counts overlap epochs that one side left unstaged but does not score them', () => {
    const pod = podNight({
      epochs: [...epochs(T0, ['light', 'light']), ...epochs(T0 + 4 * EPOCH_MS, ['light', 'light'])],
    })
    const ref = refNight({ stages: [{ start: T0, end: T0 + 6 * EPOCH_MS, stage: 'light' }] })

    const { stages } = scoreNight(pod, ref)

    expect(stages.overlapEpochs).toBe(6)
    expect(stages.scoredEpochs).toBe(4)
  })

  it('scores only the overlap when the recordings start and end at different times', () => {
    const pod = podNight({ epochs: epochs(T0, Array(10).fill('light')) })
    const ref = refNight({ stages: [{ start: T0 + 4 * EPOCH_MS, end: T0 + 20 * EPOCH_MS, stage: 'light' }] })

    expect(scoreNight(pod, ref).stages.overlapEpochs).toBe(6)
  })

  it('returns an empty matrix and null scores with no overlap', () => {
    const pod = podNight({ epochs: epochs(T0, ['light']) })
    const ref = refNight({ stages: [{ start: T0 + MIN, end: T0 + 2 * MIN, stage: 'light' }] })

    const { stages } = scoreNight(pod, ref)

    expect(stages.overlapEpochs).toBe(0)
    expect(stages.accuracy).toBeNull()
    expect(stages.kappa).toBeNull()
  })

  it('passes through the staging method and fallback reason', () => {
    const out = scoreNight(podNight({ method: 'rules', fallbackReason: 'profile' }), refNight())
    expect(out.method).toBe('rules')
    expect(out.fallbackReason).toBe('profile')
  })
})

describe('scoreNight — sleep window', () => {
  it('compares onset, final wake, total sleep and wake after onset', () => {
    // Pod: 2 wake, 4 sleep, 1 wake, 3 sleep, 2 wake (30 s epochs).
    const pod = podNight({
      epochs: epochs(T0, ['wake', 'wake', 'light', 'light', 'deep', 'rem', 'wake', 'light', 'light', 'rem', 'wake', 'wake']),
    })
    // Watch: asleep 1 min later, awake 1 min earlier, no wake in between.
    const ref = refNight({
      stages: [
        { start: T0, end: T0 + 4 * EPOCH_MS, stage: 'wake' },
        { start: T0 + 4 * EPOCH_MS, end: T0 + 8 * EPOCH_MS, stage: 'light' },
        { start: T0 + 8 * EPOCH_MS, end: T0 + 12 * EPOCH_MS, stage: 'wake' },
      ],
    })

    const { window } = scoreNight(pod, ref)

    expect(window.podSleepOnset).toBe(T0 + 2 * EPOCH_MS)
    expect(window.refSleepOnset).toBe(T0 + 4 * EPOCH_MS)
    expect(window.onsetDiffMin).toBe(-1)
    expect(window.finalWakeDiffMin).toBe(1)
    expect(window.podTotalSleepMin).toBe(3.5)
    expect(window.refTotalSleepMin).toBe(2)
    expect(window.totalSleepDiffMin).toBe(1.5)
    expect(window.podWasoMin).toBe(0.5)
    expect(window.refWasoMin).toBe(0)
    expect(window.wasoDiffMin).toBe(0.5)
  })

  it('leaves onset and wake-after-onset null for a side that never slept', () => {
    const pod = podNight({ epochs: epochs(T0, ['wake', 'wake']) })
    const ref = refNight({ stages: [{ start: T0, end: T0 + MIN, stage: 'light' }] })

    const { window } = scoreNight(pod, ref)

    expect(window.podSleepOnset).toBeNull()
    expect(window.onsetDiffMin).toBeNull()
    expect(window.finalWakeDiffMin).toBeNull()
    expect(window.podWasoMin).toBeNull()
    expect(window.wasoDiffMin).toBeNull()
    expect(window.totalSleepDiffMin).toBe(-1)
  })
})

describe('scoreNight — heart rate', () => {
  it('compares the beat heart rate around each watch reading inside the window', () => {
    const beats = regularBeats(T0, T0 + 10 * MIN, 1000) // 60 bpm
    const pod = podNight({ heartbeats: chunks(beats) })
    const ref = refNight({
      heartRate: [
        { t: T0 + 2 * MIN, bpm: 62 }, // err 2
        { t: T0 + 5 * MIN, bpm: 67 }, // err 7
        { t: T0 - MIN, bpm: 60 }, // before the window: ignored
        { t: T0 + 30 * MIN, bpm: 60 }, // in the window, no beats nearby
      ],
    })

    const { heart } = scoreNight(pod, ref)

    expect(heart.readings).toBe(3)
    expect(heart.beatHrCovered).toBe(2)
    expect(heart.beatHrCoverage).toBeCloseTo(2 / 3, 10)
    expect(heart.beatHrMaeBpm).toBeCloseTo(4.5, 6)
    expect(heart.beatHrWithin5Share).toBe(0.5)
  })

  it('does not take an interval across a detector break', () => {
    // Beats every 1 s, but a break after every other beat: only 1 s intervals survive, never 2 s.
    const beats: Array<number | null> = []
    for (let t = T0; t < T0 + 2 * MIN; t += 2000) beats.push(t, t + 1000, null)
    const pod = podNight({ heartbeats: chunks(beats) })
    const ref = refNight({ heartRate: [{ t: T0 + MIN, bpm: 60 }] })

    expect(scoreNight(pod, ref).heart.beatHrMaeBpm).toBeCloseTo(0, 6)
  })

  it('needs enough intervals for a beat heart rate', () => {
    const pod = podNight({ heartbeats: chunks(regularBeats(T0 + MIN, T0 + MIN + 4000, 1000)) })
    const ref = refNight({ heartRate: [{ t: T0 + MIN, bpm: 60 }] })

    expect(scoreNight(pod, ref).heart.beatHrCovered).toBe(0)
  })

  it('compares the nearest vitals heart rate within a minute', () => {
    const pod = podNight({
      vitals: [
        { timestamp: new Date(T0 + MIN), heartRate: 58 },
        { timestamp: new Date(T0 + 2 * MIN), heartRate: null },
        { timestamp: new Date(T0 + 10 * MIN), heartRate: 70 },
      ],
    })
    const ref = refNight({
      heartRate: [
        { t: T0 + MIN + 20_000, bpm: 60 }, // nearest non-null row: 58
        { t: T0 + 5 * MIN, bpm: 60 }, // nothing within a minute
      ],
    })

    const { heart } = scoreNight(pod, ref)

    expect(heart.vitalsHrCovered).toBe(1)
    expect(heart.vitalsHrMaeBpm).toBe(2)
  })
})

describe('scoreNight — beat timing', () => {
  const segStart = T0 + 60 * MIN

  /** Watch segment of `n` beats every `ibi` ms, with optional gaps before given indices. */
  function segment(n: number, ibi: number, gaps: number[] = []) {
    return {
      start: segStart,
      beats: Array.from({ length: n }, (_, i) => ({ t: i * ibi, gap: gaps.includes(i) })),
    }
  }

  it('aligns a segment despite a constant delay and matches every beat', () => {
    // Bed beats trail the wrist by 180 ms and are otherwise identical.
    const pod = podNight({ heartbeats: chunks(regularBeats(segStart - 5000 + 180, segStart + 70_000, 1000)) })
    const ref = refNight({ beatSeries: [segment(60, 1000)] })

    const { beatTiming } = scoreNight(pod, ref)

    expect(beatTiming.segments).toBe(1)
    expect(beatTiming.watchBeats).toBe(60)
    expect(beatTiming.matchedBeats).toBe(60)
    expect(beatTiming.matchedShare).toBe(1)
    expect(beatTiming.medianLagMs).toBe(180)
    expect(beatTiming.ibiPairs).toBe(59)
    expect(beatTiming.ibiRmseMs).toBe(0)
  })

  it('does not align one whole beat off when the rhythm varies', () => {
    // Intervals vary beat to beat (as real rhythms do); the bed trails by 150 ms.
    const ibis = Array.from({ length: 70 }, (_, i) => 1000 + [0, 60, -40, 90, -80, 30, -50][i % 7])
    const watchT = ibis.reduce<number[]>((acc, x) => [...acc, acc[acc.length - 1] + x], [0]).slice(5, 65)
    const pod = podNight({ heartbeats: chunks(ibis.reduce<number[]>((acc, x) => [...acc, acc[acc.length - 1] + x], [0]).map(t => segStart - 5000 + t + 150)) })
    const ref = refNight({ beatSeries: [{ start: segStart - 5000, beats: watchT.map(t => ({ t, gap: false })) }] })

    const { beatTiming } = scoreNight(pod, ref)

    expect(beatTiming.medianLagMs).toBe(150)
    expect(beatTiming.ibiRmseMs).toBe(0)
  })

  it('measures interval error from jittered bed beats', () => {
    // Alternate beats land 10 ms late: every interval is off by exactly 10 ms.
    const beats = regularBeats(segStart, segStart + 60_000, 1000).map((t, i) => t + (i % 2 ? 10 : 0))
    const pod = podNight({ heartbeats: chunks(beats) })
    const ref = refNight({ beatSeries: [segment(60, 1000)] })

    expect(scoreNight(pod, ref).beatTiming.ibiRmseMs).toBeCloseTo(10, 6)
  })

  it('skips intervals across a watch gap or a pod break', () => {
    const beats: Array<number | null> = regularBeats(segStart, segStart + 60_000, 1000)
    beats.splice(30, 0, null) // pod break between beats 29 and 30
    const pod = podNight({ heartbeats: chunks(beats) })
    const ref = refNight({ beatSeries: [segment(60, 1000, [10])] }) // watch gap before beat 10

    expect(scoreNight(pod, ref).beatTiming.ibiPairs).toBe(57)
  })

  it('counts watch beats the pod missed', () => {
    const beats = regularBeats(segStart, segStart + 60_000, 1000).filter((_, i) => i % 4 !== 0)
    const pod = podNight({ heartbeats: chunks(beats) })
    const ref = refNight({ beatSeries: [segment(60, 1000)] })

    const { beatTiming } = scoreNight(pod, ref)

    expect(beatTiming.matchedBeats).toBe(45)
    expect(beatTiming.matchedShare).toBe(0.75)
  })

  it('compares SDNN over the segment, each side from its own intervals', () => {
    // Watch intervals alternate 950 / 1050 (SD ≈ 50); the pod reads 900 / 1100 (SD ≈ 100).
    const watchIbis = Array.from({ length: 40 }, (_, i) => (i % 2 ? 1050 : 950))
    const podIbis = Array.from({ length: 40 }, (_, i) => (i % 2 ? 1100 : 900))
    const cumulative = (ibis: number[]) => ibis.reduce<number[]>((acc, x) => [...acc, acc[acc.length - 1] + x], [0])
    const watchT = cumulative(watchIbis)
    const pod = podNight({ heartbeats: chunks(cumulative(podIbis).map(t => segStart + t)) })
    const ref = refNight({ beatSeries: [{ start: segStart, beats: watchT.map(t => ({ t, gap: false })) }] })

    const { beatTiming } = scoreNight(pod, ref)

    expect(beatTiming.sdnnSegments).toBe(1)
    expect(beatTiming.sdnnMeanDiffMs).toBeGreaterThan(45)
    expect(beatTiming.sdnnMeanDiffMs).toBeLessThan(55)
    expect(beatTiming.sdnnMeanAbsDiffMs).toBe(beatTiming.sdnnMeanDiffMs)
  })

  it('ignores segments outside the pod window and empty segments', () => {
    const ref = refNight({
      beatSeries: [
        { start: T0 - 10 * MIN, beats: [{ t: 0, gap: false }] },
        { start: segStart, beats: [] },
      ],
    })

    const { beatTiming } = scoreNight(podNight(), ref)

    expect(beatTiming.segments).toBe(0)
    expect(beatTiming.matchedShare).toBeNull()
    expect(beatTiming.medianLagMs).toBeNull()
  })
})

describe('poolAgreement', () => {
  it('sums confusion matrices and averages window errors across nights', () => {
    const night1 = scoreNight(
      podNight({ epochs: epochs(T0, ['light', 'light', 'wake', 'wake']) }),
      refNight({ stages: [{ start: T0, end: T0 + 4 * EPOCH_MS, stage: 'light' }] }),
    )
    const night2 = scoreNight(
      podNight({ method: 'rules', epochs: epochs(T0, ['deep', 'deep']) }),
      refNight({ stages: [{ start: T0, end: T0 + 2 * EPOCH_MS, stage: 'deep' }] }),
    )

    const pooled = poolAgreement([night1, night2])

    expect(pooled.nights).toBe(2)
    expect(pooled.modelNights).toBe(1)
    expect(pooled.stages.confusion[1]).toEqual([2, 2, 0, 0])
    expect(pooled.stages.confusion[2]).toEqual([0, 0, 2, 0])
    expect(pooled.stages.scoredEpochs).toBe(6)
    expect(pooled.stages.accuracy).toBeCloseTo(4 / 6, 10)
    // Night 1: pod sleeps 1 min vs 2; night 2: 1 vs 1 → mean |diff| 0.5 min.
    expect(pooled.window.totalSleepMaeMin).toBeCloseTo(0.5, 10)
    expect(pooled.stages.podMinutesPerNight).toEqual({ wake: 0.5, light: 0.5, deep: 0.5, rem: 0 })
  })

  it('pools heart-rate and beat sums rather than averaging per-night ratios', () => {
    const beats = regularBeats(T0, T0 + 10 * MIN, 1000)
    const night1 = scoreNight(
      podNight({ heartbeats: chunks(beats) }),
      refNight({ heartRate: [{ t: T0 + MIN, bpm: 64 }, { t: T0 + 2 * MIN, bpm: 64 }, { t: T0 + 3 * MIN, bpm: 64 }] }),
    )
    const night2 = scoreNight(podNight(), refNight({ heartRate: [{ t: T0 + MIN, bpm: 60 }] }))

    const pooled = poolAgreement([night1, night2])

    expect(pooled.heart.readings).toBe(4)
    expect(pooled.heart.beatHrCoverage).toBe(0.75)
    expect(pooled.heart.beatHrMaeBpm).toBeCloseTo(4, 6)
  })

  it('returns nulls for no nights', () => {
    const pooled = poolAgreement([])
    expect(pooled.nights).toBe(0)
    expect(pooled.stages.kappa).toBeNull()
    expect(pooled.heart.beatHrCoverage).toBeNull()
    expect(pooled.window.onsetMaeMin).toBeNull()
    expect(pooled.stages.podMinutesPerNight).toEqual({ wake: 0, light: 0, deep: 0, rem: 0 })
  })
})

/**
 * Everything needed to re-stage and score one reference night away from the
 * pod (docs/sleep-tracking-plan.md, A0.4): the reference night itself, the
 * pod's in-bed window for it, the pod rows staging reads (heartbeats,
 * movement, vitals), the sleeper profile and the device timezone.
 * `biometrics.getReplayBundle` builds one; the replay CLI stores it as JSON
 * and re-stages it with the working tree's code. Times are unix ms (pod
 * clock, except inside `reference`, which keeps the reference clock).
 */
import { z } from 'zod'
import type { PodNight } from './agreement'
import {
  referenceBeatSeriesSchema,
  referenceHeartRateSchema,
  referenceHrvSchema,
  referenceRespiratoryRateSchema,
  referenceStageSchema,
  toPodTime,
  type ReferenceNight,
} from './referenceNight'
import { stageWindow, type StagedWindow } from './stageWindow'

export const REPLAY_BUNDLE_VERSION = 1

const sideEnum = z.enum(['left', 'right'])

export const replayBundleSchema = z.object({
  version: z.literal(REPLAY_BUNDLE_VERSION),
  reference: z.object({
    id: z.number(),
    side: sideEnum,
    source: z.literal('apple-watch'),
    deviceModel: z.string().nullable(),
    podVersion: z.string().nullable(),
    nightStart: z.number(),
    nightEnd: z.number(),
    stages: z.array(referenceStageSchema),
    heartRate: z.array(referenceHeartRateSchema),
    hrv: z.array(referenceHrvSchema),
    beatSeries: z.array(referenceBeatSeriesSchema),
    respiratoryRate: z.array(referenceRespiratoryRateSchema),
    clockOffsetMs: z.number(),
  }),
  /** The pod's in-bed window the stages cover. */
  window: z.object({
    start: z.number(),
    end: z.number(),
    /** The sleep record it came from, or null when none overlapped the reference night. */
    sleepRecordId: z.number().nullable(),
  }),
  profile: z.object({
    age: z.number().nullable(),
    sex: z.enum(['female', 'male']).nullable(),
  }),
  timezone: z.string(),
  heartbeats: z.array(z.object({ timestamp: z.number(), beats: z.array(z.number().nullable()) })),
  movement: z.array(z.object({ timestamp: z.number(), totalMovement: z.number() })),
  vitals: z.array(z.object({
    timestamp: z.number(),
    heartRate: z.number().nullable(),
    hrv: z.number().nullable(),
    breathingRate: z.number().nullable(),
  })),
})

export type ReplayBundle = z.infer<typeof replayBundleSchema>

export interface SleepRecordSpan { id: number, enteredBedAt: number, leftBedAt: number }

/** The reference night's span on the pod's clock. */
export function referencePodSpan(ref: Pick<ReferenceNight, 'nightStart' | 'nightEnd' | 'clockOffsetMs'>) {
  return {
    start: toPodTime(ref.nightStart, ref.clockOffsetMs),
    end: toPodTime(ref.nightEnd, ref.clockOffsetMs),
  }
}

/**
 * The pod window to stage for a reference night: the sleep record that
 * overlaps it most, or — when the pod recorded no session over it — the
 * reference night's own span, so the night is still staged and scored.
 */
export function chooseWindow(
  ref: Pick<ReferenceNight, 'nightStart' | 'nightEnd' | 'clockOffsetMs'>,
  records: SleepRecordSpan[],
): ReplayBundle['window'] {
  const span = referencePodSpan(ref)
  let best: SleepRecordSpan | null = null
  let bestOverlap = 0
  for (const r of records) {
    const overlap = Math.min(r.leftBedAt, span.end) - Math.max(r.enteredBedAt, span.start)
    if (overlap > bestOverlap) {
      best = r
      bestOverlap = overlap
    }
  }
  return best
    ? { start: best.enteredBedAt, end: best.leftBedAt, sleepRecordId: best.id }
    : { start: span.start, end: span.end, sleepRecordId: null }
}

/**
 * Stage a bundle with the current code and shape it for scoreNight. `stage`
 * is injectable so a caller can compare staging variants on the same data.
 */
export function podNightFromBundle(
  bundle: ReplayBundle,
  stage: (input: Parameters<typeof stageWindow>[0]) => StagedWindow = stageWindow,
): PodNight {
  const heartbeats = bundle.heartbeats.map(h => ({ timestamp: new Date(h.timestamp), beats: h.beats }))
  const movement = bundle.movement.map(m => ({ timestamp: new Date(m.timestamp), totalMovement: m.totalMovement }))
  const vitals = bundle.vitals.map(v => ({ ...v, timestamp: new Date(v.timestamp) }))
  const staged = stage({
    chunks: heartbeats,
    windowStart: new Date(bundle.window.start),
    windowEnd: new Date(bundle.window.end),
    timezone: bundle.timezone,
    age: bundle.profile.age,
    sex: bundle.profile.sex,
    movement,
    vitals,
  })
  return {
    windowStart: bundle.window.start,
    windowEnd: bundle.window.end,
    epochs: staged.epochs,
    method: staged.method,
    fallbackReason: staged.fallbackReason,
    heartbeats,
    vitals,
  }
}

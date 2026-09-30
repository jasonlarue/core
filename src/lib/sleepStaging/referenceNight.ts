/**
 * A night recorded by a reference device — today an Apple Watch, synced by
 * the iOS app from HealthKit — that the pod's own tracking is scored against
 * (docs/sleep-tracking-plan.md, A0).
 *
 * Every time here is unix ms on the reference device's clock. The pod may run
 * without NTP while WAN is blocked, so the upload carries the phone's send
 * time and the pod stores `clockOffsetMs` (pod receive time − phone send
 * time); `toPodTime()` maps reference times onto the pod's clock.
 */
import { z } from 'zod'

/** Longest night accepted; anything longer is a grouping bug on the client. */
export const MAX_REFERENCE_NIGHT_MS = 24 * 60 * 60 * 1000

export const referenceStageSchema = z.object({
  start: z.number().int(),
  end: z.number().int(),
  // HealthKit's asleepCore / asleepDeep / asleepREM / awake; inBed and
  // asleepUnspecified are dropped by the client.
  stage: z.enum(['wake', 'light', 'deep', 'rem']),
}).strict().refine(s => s.end > s.start, { message: 'stage end must be after start' })

export const referenceHeartRateSchema = z.object({
  t: z.number().int(),
  bpm: z.number().positive().max(300),
}).strict()

export const referenceHrvSchema = z.object({
  t: z.number().int(),
  sdnnMs: z.number().nonnegative().max(1000),
}).strict()

/**
 * One HKHeartbeatSeriesSample: beat times as ms offsets from `start`, with
 * `gap` set when the watch lost beats before this one (no interval may be
 * taken across it — the same rule as the pod's `null` breaks).
 */
export const referenceBeatSeriesSchema = z.object({
  start: z.number().int(),
  beats: z.array(z.object({
    t: z.number().nonnegative(),
    gap: z.boolean(),
  }).strict()).max(1000),
}).strict()

export const referenceRespiratoryRateSchema = z.object({
  t: z.number().int(),
  rate: z.number().positive().max(100),
}).strict()

export const referenceNightInputSchema = z.object({
  side: z.enum(['left', 'right']),
  source: z.literal('apple-watch'),
  deviceModel: z.string().max(64).nullable().optional(),
  nightStart: z.number().int(),
  nightEnd: z.number().int(),
  /** Phone clock at send time, for the clock offset. */
  sentAt: z.number().int(),
  stages: z.array(referenceStageSchema).min(1).max(2000),
  heartRate: z.array(referenceHeartRateSchema).max(10_000).default([]),
  hrv: z.array(referenceHrvSchema).max(500).default([]),
  beatSeries: z.array(referenceBeatSeriesSchema).max(500).default([]),
  respiratoryRate: z.array(referenceRespiratoryRateSchema).max(5000).default([]),
}).strict().refine(
  n => n.nightEnd > n.nightStart && n.nightEnd - n.nightStart <= MAX_REFERENCE_NIGHT_MS,
  { message: `nightEnd must be after nightStart and at most ${MAX_REFERENCE_NIGHT_MS / 3_600_000} h later` },
)

export type ReferenceNightInput = z.infer<typeof referenceNightInputSchema>
export type ReferenceStage = z.infer<typeof referenceStageSchema>
export type ReferenceHeartRate = z.infer<typeof referenceHeartRateSchema>
export type ReferenceHrv = z.infer<typeof referenceHrvSchema>
export type ReferenceBeatSeries = z.infer<typeof referenceBeatSeriesSchema>
export type ReferenceRespiratoryRate = z.infer<typeof referenceRespiratoryRateSchema>

/** A stored reference night, as the scoring code consumes it. */
export interface ReferenceNight {
  id: number
  side: 'left' | 'right'
  source: 'apple-watch'
  deviceModel: string | null
  podVersion: string | null
  nightStart: number
  nightEnd: number
  stages: ReferenceStage[]
  heartRate: ReferenceHeartRate[]
  hrv: ReferenceHrv[]
  beatSeries: ReferenceBeatSeries[]
  respiratoryRate: ReferenceRespiratoryRate[]
  clockOffsetMs: number
}

/** A reference-clock time on the pod's clock. */
export function toPodTime(referenceMs: number, clockOffsetMs: number): number {
  return referenceMs + clockOffsetMs
}

/** A `reference_nights` row as drizzle returns it. */
export interface ReferenceNightRow {
  id: number
  side: 'left' | 'right'
  source: 'apple-watch'
  deviceModel: string | null
  podVersion: string | null
  nightStart: Date
  nightEnd: Date
  stages: ReferenceStage[]
  heartRate: ReferenceHeartRate[]
  hrv: ReferenceHrv[]
  beatSeries: ReferenceBeatSeries[]
  respiratoryRate: ReferenceRespiratoryRate[]
  clockOffsetMs: number
}

export function rowToReferenceNight(row: ReferenceNightRow): ReferenceNight {
  return {
    id: row.id,
    side: row.side,
    source: row.source,
    deviceModel: row.deviceModel,
    podVersion: row.podVersion,
    nightStart: row.nightStart.getTime(),
    nightEnd: row.nightEnd.getTime(),
    stages: row.stages,
    heartRate: row.heartRate,
    hrv: row.hrv,
    beatSeries: row.beatSeries,
    respiratoryRate: row.respiratoryRate,
    clockOffsetMs: row.clockOffsetMs,
  }
}

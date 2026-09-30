/**
 * How well one pod night agrees with a reference night (an Apple Watch, see
 * referenceNight.ts) — the ruler for docs/sleep-tracking-plan.md. Pure: the
 * replay CLI and the pod scoreboard feed it the same shapes.
 *
 * Everything is compared on the pod's clock (reference times are shifted by
 * the stored clock offset). Stages are compared on a 30 s grid over the
 * overlap of the two recordings, sampling each side's stage at every grid
 * midpoint, so pod epochs of any length (30 s model stages, variable
 * rule-based ones) line up with the watch's intervals.
 */
import type { SleepEpoch, SleepStage } from '@/src/lib/sleep-stages'
import type { HeartbeatChunk } from './stageNight'
import { toPodTime, type ReferenceNight } from './referenceNight'

export const EPOCH_MS = 30_000
export const STAGE_ORDER: readonly SleepStage[] = ['wake', 'light', 'deep', 'rem']

/** Half-width of the window a beat heart rate is taken over, around a watch reading. */
export const BEAT_HR_HALF_WINDOW_MS = 30_000
/** Fewest pod intervals in that window for a beat heart rate. */
export const BEAT_HR_MIN_INTERVALS = 5
/** Nearest vitals row used for a watch reading, at most this far away. */
export const VITALS_MAX_GAP_MS = 60_000
/** Watch and pod beats within this of each other (after alignment) are the same beat. */
export const BEAT_MATCH_TOLERANCE_MS = 100
/**
 * Lags searched when aligning a watch heartbeat segment with pod beats: the
 * clock offset carries network latency, the pod's clock drifts between the
 * night and the morning upload that measured the offset, and the wrist pulse
 * and the bed's ballistocardiogram trail the heartbeat by different amounts.
 * Each segment gets its own lag, so drift across the night is absorbed.
 */
export const BEAT_MAX_LAG_MS = 2000
export const BEAT_LAG_STEP_MS = 10
/** Fewest intervals on each side for an SDNN comparison. */
export const SDNN_MIN_INTERVALS = 20

export interface PodNight {
  /** Pod-clock unix ms of the in-bed window the stages cover. */
  windowStart: number
  windowEnd: number
  epochs: SleepEpoch[]
  method: 'model' | 'rules'
  fallbackReason: 'profile' | 'coverage' | null
  heartbeats: HeartbeatChunk[]
  vitals: Array<{ timestamp: Date, heartRate: number | null }>
}

export interface HeartAgreement {
  /** Watch heart-rate readings inside the pod's window. */
  readings: number
  /** …of which the pod had a beat heart rate for. */
  beatHrCovered: number
  beatHrAbsErrSum: number
  beatHrWithin5: number
  /** …of which the pod had a vitals heart rate for (what users see). */
  vitalsHrCovered: number
  vitalsHrAbsErrSum: number
  beatHrCoverage: number | null
  beatHrMaeBpm: number | null
  beatHrWithin5Share: number | null
  vitalsHrMaeBpm: number | null
}

export interface BeatTimingAgreement {
  /** Watch heartbeat segments inside the pod's window. */
  segments: number
  watchBeats: number
  matchedBeats: number
  matchedShare: number | null
  /** Watch intervals whose two beats both matched consecutive pod beats. */
  ibiPairs: number
  ibiSumSqErrMs2: number
  ibiRmseMs: number | null
  /** Median alignment lag (pod − watch), ms, over segments with matches. */
  medianLagMs: number | null
  /** Segments with enough intervals on both sides to compare SDNN. */
  sdnnSegments: number
  sdnnAbsDiffSumMs: number
  sdnnDiffSumMs: number
  sdnnMeanAbsDiffMs: number | null
  /** Pod − watch; positive = the pod reads more variability. */
  sdnnMeanDiffMs: number | null
}

export interface SleepWindowAgreement {
  podSleepOnset: number | null
  refSleepOnset: number | null
  /** Pod − watch, minutes; positive = the pod says later. */
  onsetDiffMin: number | null
  finalWakeDiffMin: number | null
  podTotalSleepMin: number
  refTotalSleepMin: number
  totalSleepDiffMin: number
  podWasoMin: number | null
  refWasoMin: number | null
  wasoDiffMin: number | null
}

export interface StageAgreement {
  /** Rows = watch stage, columns = pod stage, in STAGE_ORDER; counts of 30 s epochs. */
  confusion: number[][]
  /** Grid epochs in the overlap, and how many both sides staged. */
  overlapEpochs: number
  scoredEpochs: number
  accuracy: number | null
  kappa: number | null
  sleepWakeAccuracy: number | null
  sleepWakeKappa: number | null
  /** Minutes per stage over the scored epochs. */
  podMinutes: Record<SleepStage, number>
  refMinutes: Record<SleepStage, number>
}

export interface NightAgreement {
  method: PodNight['method']
  fallbackReason: PodNight['fallbackReason']
  heart: HeartAgreement
  beatTiming: BeatTimingAgreement
  window: SleepWindowAgreement
  stages: StageAgreement
}

// ─── helpers ────────────────────────────────────────────────────────────────

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function sampleSd(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const ss = values.reduce((a, b) => a + (b - mean) ** 2, 0)
  return Math.sqrt(ss / (values.length - 1))
}

/**
 * Cohen's κ from a square confusion matrix: agreement corrected for chance.
 * Null when there is nothing to score or chance agreement is total (both
 * sides used one and the same class), where κ is undefined.
 */
export function cohensKappa(confusion: number[][]): number | null {
  const n = confusion.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0)
  if (n === 0) return null
  let observed = 0
  let chance = 0
  for (let i = 0; i < confusion.length; i++) {
    observed += confusion[i][i]
    const rowSum = confusion[i].reduce((a, b) => a + b, 0)
    const colSum = confusion.reduce((s, row) => s + row[i], 0)
    chance += rowSum * colSum
  }
  const po = observed / n
  const pe = chance / (n * n)
  if (pe === 1) return null
  return (po - pe) / (1 - pe)
}

/** Collapse a STAGE_ORDER confusion matrix to wake vs. sleep. */
export function toSleepWake(confusion: number[][]): number[][] {
  const out = [[0, 0], [0, 0]]
  for (let i = 0; i < confusion.length; i++) {
    for (let j = 0; j < confusion.length; j++) {
      out[i === 0 ? 0 : 1][j === 0 ? 0 : 1] += confusion[i][j]
    }
  }
  return out
}

function accuracyOf(confusion: number[][]): number | null {
  const n = confusion.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0)
  const hits = confusion.reduce((s, row, i) => s + row[i], 0)
  return ratio(hits, n)
}

interface Interval { start: number, end: number, stage: SleepStage }

/** Stage at `t` from intervals sorted by start, advancing a shared cursor. */
function makeStageLookup(intervals: Interval[]) {
  let i = 0
  return (t: number): SleepStage | null => {
    while (i < intervals.length && intervals[i].end <= t) i++
    const iv = intervals[i]
    return iv && iv.start <= t && t < iv.end ? iv.stage : null
  }
}

function emptyMinutes(): Record<SleepStage, number> {
  return { wake: 0, light: 0, deep: 0, rem: 0 }
}

/**
 * Pod beats as runs of absolute pod-clock times. A run ends at a detector
 * break (`null`) and at a gap between chunks, the same rule stageNight's
 * beatsToRri uses — no interval is ever taken across either.
 */
export function podBeatRuns(chunks: HeartbeatChunk[]): number[][] {
  const runs: number[][] = []
  let run: number[] = []
  let prevChunkEnd: number | null = null
  const sorted = [...chunks].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  for (const chunk of sorted) {
    const base = chunk.timestamp.getTime()
    if (prevChunkEnd !== null && base !== prevChunkEnd && run.length) {
      runs.push(run)
      run = []
    }
    prevChunkEnd = base + 60_000
    for (const off of chunk.beats) {
      if (off === null) {
        if (run.length) runs.push(run)
        run = []
        continue
      }
      run.push(base + off)
    }
  }
  if (run.length) runs.push(run)
  return runs
}

/** Beat heart rate from pod intervals fully inside [t − half, t + half], or null. */
function beatHrAt(runs: number[][], t: number): number | null {
  const lo = t - BEAT_HR_HALF_WINDOW_MS
  const hi = t + BEAT_HR_HALF_WINDOW_MS
  let sum = 0
  let n = 0
  for (const run of runs) {
    if (run.length < 2 || run[run.length - 1] < lo || run[0] > hi) continue
    for (let k = 1; k < run.length; k++) {
      if (run[k - 1] >= lo && run[k] <= hi) {
        sum += run[k] - run[k - 1]
        n++
      }
    }
  }
  return n >= BEAT_HR_MIN_INTERVALS ? 60_000 / (sum / n) : null
}

// ─── heart ──────────────────────────────────────────────────────────────────

function scoreHeart(pod: PodNight, ref: ReferenceNight, runs: number[][]): HeartAgreement {
  const vitals = pod.vitals
    .filter(v => v.heartRate !== null)
    .map(v => ({ t: v.timestamp.getTime(), hr: v.heartRate as number }))
  let readings = 0
  let beatHrCovered = 0
  let beatHrAbsErrSum = 0
  let beatHrWithin5 = 0
  let vitalsHrCovered = 0
  let vitalsHrAbsErrSum = 0
  for (const sample of ref.heartRate) {
    const t = toPodTime(sample.t, ref.clockOffsetMs)
    if (t < pod.windowStart || t > pod.windowEnd) continue
    readings++
    const beatHr = beatHrAt(runs, t)
    if (beatHr !== null) {
      const err = Math.abs(beatHr - sample.bpm)
      beatHrCovered++
      beatHrAbsErrSum += err
      if (err <= 5) beatHrWithin5++
    }
    let nearest: { t: number, hr: number } | null = null
    for (const v of vitals) {
      if (Math.abs(v.t - t) <= VITALS_MAX_GAP_MS && (!nearest || Math.abs(v.t - t) < Math.abs(nearest.t - t))) nearest = v
    }
    if (nearest) {
      vitalsHrCovered++
      vitalsHrAbsErrSum += Math.abs(nearest.hr - sample.bpm)
    }
  }
  return {
    readings,
    beatHrCovered,
    beatHrAbsErrSum,
    beatHrWithin5,
    vitalsHrCovered,
    vitalsHrAbsErrSum,
    beatHrCoverage: ratio(beatHrCovered, readings),
    beatHrMaeBpm: ratio(beatHrAbsErrSum, beatHrCovered),
    beatHrWithin5Share: ratio(beatHrWithin5, beatHrCovered),
    vitalsHrMaeBpm: ratio(vitalsHrAbsErrSum, vitalsHrCovered),
  }
}

interface PodBeat { t: number, run: number, idx: number }

/** Index of the pod beat nearest `t` within tolerance, skipping used ones. */
function nearestBeat(beats: PodBeat[], t: number, used: Set<number>): number {
  let lo = 0
  let hi = beats.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (beats[mid].t < t) lo = mid + 1
    else hi = mid
  }
  let best = -1
  let bestErr = Infinity
  for (const k of [lo - 1, lo, lo + 1]) {
    if (k < 0 || k >= beats.length || used.has(k)) continue
    const err = Math.abs(beats[k].t - t)
    if (err <= BEAT_MATCH_TOLERANCE_MS && err < bestErr) {
      best = k
      bestErr = err
    }
  }
  return best
}

/**
 * Greedy one-to-one match of watch beats (shifted by `lag`) to pod beats, with
 * the summed |timing residual| of the matches.
 */
function matchBeats(watch: number[], beats: PodBeat[], lag: number): { match: number[], matched: number, residual: number } {
  const used = new Set<number>()
  let matched = 0
  let residual = 0
  const match = watch.map((w) => {
    const k = nearestBeat(beats, w + lag, used)
    if (k >= 0) {
      used.add(k)
      matched++
      residual += Math.abs(beats[k].t - (w + lag))
    }
    return k
  })
  return { match, matched, residual }
}

/**
 * The lag that best aligns a watch segment with the pod's beats: most
 * matches, then the smallest mean timing residual, then the smallest |lag|.
 * Every lag within the match tolerance of the true one matches the same
 * beats, so the residual picks the centre of that plateau — and it rejects an
 * alignment one whole beat off, whose residuals carry the beat-to-beat
 * variation of the heart rhythm.
 */
function bestLag(watch: number[], beats: PodBeat[]): number {
  let best = 0
  let bestMatched = -1
  let bestResidual = Infinity
  for (let lag = -BEAT_MAX_LAG_MS; lag <= BEAT_MAX_LAG_MS; lag += BEAT_LAG_STEP_MS) {
    const { matched, residual } = matchBeats(watch, beats, lag)
    const meanResidual = matched > 0 ? residual / matched : Infinity
    const better = matched > bestMatched
      || (matched === bestMatched && meanResidual < bestResidual - 1e-9)
      || (matched === bestMatched && Math.abs(meanResidual - bestResidual) <= 1e-9 && Math.abs(lag) < Math.abs(best))
    if (better) {
      best = lag
      bestMatched = matched
      bestResidual = meanResidual
    }
  }
  return best
}

function scoreBeatTiming(pod: PodNight, ref: ReferenceNight, runs: number[][]): BeatTimingAgreement {
  const beats: PodBeat[] = runs
    .flatMap((run, r) => run.map((t, idx) => ({ t, run: r, idx })))
    .sort((a, b) => a.t - b.t)
  let segments = 0
  let watchBeats = 0
  let matchedBeats = 0
  let ibiPairs = 0
  let ibiSumSqErrMs2 = 0
  let sdnnSegments = 0
  let sdnnAbsDiffSumMs = 0
  let sdnnDiffSumMs = 0
  const lags: number[] = []

  for (const series of ref.beatSeries) {
    const start = toPodTime(series.start, ref.clockOffsetMs)
    if (start < pod.windowStart || start > pod.windowEnd || series.beats.length === 0) continue
    segments++
    const watch = series.beats.map(b => start + b.t)
    watchBeats += watch.length

    const lag = bestLag(watch, beats)
    const { match, matched } = matchBeats(watch, beats, lag)
    matchedBeats += matched
    if (matched > 0) lags.push(lag)

    const watchIbis: number[] = []
    for (let i = 1; i < watch.length; i++) {
      if (series.beats[i].gap) continue
      const ibi = watch[i] - watch[i - 1]
      watchIbis.push(ibi)
      const a = match[i - 1]
      const b = match[i]
      if (a < 0 || b < 0) continue
      const pa = beats[a]
      const pb = beats[b]
      if (pa.run !== pb.run || pb.idx !== pa.idx + 1) continue
      ibiPairs++
      ibiSumSqErrMs2 += (pb.t - pa.t - ibi) ** 2
    }

    // SDNN over the segment's span, each side from its own intervals.
    const lo = watch[0] + lag
    const hi = watch[watch.length - 1] + lag
    const podIbis: number[] = []
    for (const run of runs) {
      for (let k = 1; k < run.length; k++) {
        if (run[k - 1] >= lo && run[k] <= hi) podIbis.push(run[k] - run[k - 1])
      }
    }
    if (watchIbis.length >= SDNN_MIN_INTERVALS && podIbis.length >= SDNN_MIN_INTERVALS) {
      const diff = sampleSd(podIbis) - sampleSd(watchIbis)
      sdnnSegments++
      sdnnAbsDiffSumMs += Math.abs(diff)
      sdnnDiffSumMs += diff
    }
  }

  return {
    segments,
    watchBeats,
    matchedBeats,
    matchedShare: ratio(matchedBeats, watchBeats),
    ibiPairs,
    ibiSumSqErrMs2,
    ibiRmseMs: ibiPairs > 0 ? Math.sqrt(ibiSumSqErrMs2 / ibiPairs) : null,
    medianLagMs: median(lags),
    sdnnSegments,
    sdnnAbsDiffSumMs,
    sdnnDiffSumMs,
    sdnnMeanAbsDiffMs: ratio(sdnnAbsDiffSumMs, sdnnSegments),
    sdnnMeanDiffMs: ratio(sdnnDiffSumMs, sdnnSegments),
  }
}

// ─── sleep window and stages ────────────────────────────────────────────────

interface WindowSummary { onset: number | null, finalWake: number | null, totalSleepMs: number, wasoMs: number | null }

function summarizeWindow(intervals: Interval[]): WindowSummary {
  const sleep = intervals.filter(iv => iv.stage !== 'wake')
  if (sleep.length === 0) return { onset: null, finalWake: null, totalSleepMs: 0, wasoMs: null }
  const onset = Math.min(...sleep.map(iv => iv.start))
  const finalWake = Math.max(...sleep.map(iv => iv.end))
  const totalSleepMs = sleep.reduce((s, iv) => s + (iv.end - iv.start), 0)
  const wasoMs = intervals
    .filter(iv => iv.stage === 'wake')
    .reduce((s, iv) => s + Math.max(0, Math.min(iv.end, finalWake) - Math.max(iv.start, onset)), 0)
  return { onset, finalWake, totalSleepMs, wasoMs }
}

const toMin = (ms: number) => ms / 60_000
const diffMin = (a: number | null, b: number | null) => (a === null || b === null ? null : toMin(a - b))

function scoreWindow(podIv: Interval[], refIv: Interval[]): SleepWindowAgreement {
  const p = summarizeWindow(podIv)
  const r = summarizeWindow(refIv)
  return {
    podSleepOnset: p.onset,
    refSleepOnset: r.onset,
    onsetDiffMin: diffMin(p.onset, r.onset),
    finalWakeDiffMin: diffMin(p.finalWake, r.finalWake),
    podTotalSleepMin: toMin(p.totalSleepMs),
    refTotalSleepMin: toMin(r.totalSleepMs),
    totalSleepDiffMin: toMin(p.totalSleepMs - r.totalSleepMs),
    podWasoMin: p.wasoMs === null ? null : toMin(p.wasoMs),
    refWasoMin: r.wasoMs === null ? null : toMin(r.wasoMs),
    wasoDiffMin: diffMin(p.wasoMs, r.wasoMs),
  }
}

function scoreStages(podIv: Interval[], refIv: Interval[]): StageAgreement {
  const confusion = STAGE_ORDER.map(() => STAGE_ORDER.map(() => 0))
  const podMinutes = emptyMinutes()
  const refMinutes = emptyMinutes()
  let overlapEpochs = 0
  let scoredEpochs = 0

  if (podIv.length > 0 && refIv.length > 0) {
    const start = Math.max(podIv[0].start, refIv[0].start)
    const end = Math.min(
      Math.max(...podIv.map(iv => iv.end)),
      Math.max(...refIv.map(iv => iv.end)),
    )
    const podAt = makeStageLookup(podIv)
    const refAt = makeStageLookup(refIv)
    for (let t = start; t + EPOCH_MS <= end; t += EPOCH_MS) {
      overlapEpochs++
      const mid = t + EPOCH_MS / 2
      const p = podAt(mid)
      const r = refAt(mid)
      if (p === null || r === null) continue
      scoredEpochs++
      confusion[STAGE_ORDER.indexOf(r)][STAGE_ORDER.indexOf(p)]++
      podMinutes[p] += EPOCH_MS / 60_000
      refMinutes[r] += EPOCH_MS / 60_000
    }
  }

  const sleepWake = toSleepWake(confusion)
  return {
    confusion,
    overlapEpochs,
    scoredEpochs,
    accuracy: accuracyOf(confusion),
    kappa: cohensKappa(confusion),
    sleepWakeAccuracy: accuracyOf(sleepWake),
    sleepWakeKappa: cohensKappa(sleepWake),
    podMinutes,
    refMinutes,
  }
}

// ─── entry points ───────────────────────────────────────────────────────────

/** Score one pod night against one reference night. */
export function scoreNight(pod: PodNight, ref: ReferenceNight): NightAgreement {
  const podIv: Interval[] = pod.epochs
    .map(e => ({ start: e.start, end: e.start + e.duration, stage: e.stage }))
    .sort((a, b) => a.start - b.start)
  const refIv: Interval[] = ref.stages
    .map(s => ({
      start: toPodTime(s.start, ref.clockOffsetMs),
      end: toPodTime(s.end, ref.clockOffsetMs),
      stage: s.stage,
    }))
    .sort((a, b) => a.start - b.start)
  const runs = podBeatRuns(pod.heartbeats)

  return {
    method: pod.method,
    fallbackReason: pod.fallbackReason,
    heart: scoreHeart(pod, ref, runs),
    beatTiming: scoreBeatTiming(pod, ref, runs),
    window: scoreWindow(podIv, refIv),
    stages: scoreStages(podIv, refIv),
  }
}

export interface PooledAgreement {
  nights: number
  modelNights: number
  heart: HeartAgreement
  beatTiming: Omit<BeatTimingAgreement, 'medianLagMs'>
  /** Mean absolute pod − watch differences across nights, minutes. */
  window: {
    onsetMaeMin: number | null
    finalWakeMaeMin: number | null
    totalSleepMaeMin: number | null
    wasoMaeMin: number | null
  }
  stages: Omit<StageAgreement, 'podMinutes' | 'refMinutes'> & {
    /** Mean minutes per stage per night. */
    podMinutesPerNight: Record<SleepStage, number>
    refMinutesPerNight: Record<SleepStage, number>
  }
}

function meanAbs(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null)
  return v.length ? v.reduce((s, x) => s + Math.abs(x), 0) / v.length : null
}

/** Pool several nights: sums for counts and the confusion matrix, means across nights for window errors. */
export function poolAgreement(nights: NightAgreement[]): PooledAgreement {
  const sum = (f: (n: NightAgreement) => number) => nights.reduce((s, n) => s + f(n), 0)
  const readings = sum(n => n.heart.readings)
  const beatHrCovered = sum(n => n.heart.beatHrCovered)
  const beatHrAbsErrSum = sum(n => n.heart.beatHrAbsErrSum)
  const beatHrWithin5 = sum(n => n.heart.beatHrWithin5)
  const vitalsHrCovered = sum(n => n.heart.vitalsHrCovered)
  const vitalsHrAbsErrSum = sum(n => n.heart.vitalsHrAbsErrSum)

  const watchBeats = sum(n => n.beatTiming.watchBeats)
  const matchedBeats = sum(n => n.beatTiming.matchedBeats)
  const ibiPairs = sum(n => n.beatTiming.ibiPairs)
  const ibiSumSqErrMs2 = sum(n => n.beatTiming.ibiSumSqErrMs2)
  const sdnnSegments = sum(n => n.beatTiming.sdnnSegments)
  const sdnnAbsDiffSumMs = sum(n => n.beatTiming.sdnnAbsDiffSumMs)
  const sdnnDiffSumMs = sum(n => n.beatTiming.sdnnDiffSumMs)

  const confusion = STAGE_ORDER.map((_, i) => STAGE_ORDER.map((_, j) => sum(n => n.stages.confusion[i][j])))
  const sleepWake = toSleepWake(confusion)
  const perNight = (pick: (n: NightAgreement) => Record<SleepStage, number>) => {
    const out = emptyMinutes()
    for (const s of STAGE_ORDER) out[s] = nights.length ? sum(n => pick(n)[s]) / nights.length : 0
    return out
  }

  return {
    nights: nights.length,
    modelNights: nights.filter(n => n.method === 'model').length,
    heart: {
      readings,
      beatHrCovered,
      beatHrAbsErrSum,
      beatHrWithin5,
      vitalsHrCovered,
      vitalsHrAbsErrSum,
      beatHrCoverage: ratio(beatHrCovered, readings),
      beatHrMaeBpm: ratio(beatHrAbsErrSum, beatHrCovered),
      beatHrWithin5Share: ratio(beatHrWithin5, beatHrCovered),
      vitalsHrMaeBpm: ratio(vitalsHrAbsErrSum, vitalsHrCovered),
    },
    beatTiming: {
      segments: sum(n => n.beatTiming.segments),
      watchBeats,
      matchedBeats,
      matchedShare: ratio(matchedBeats, watchBeats),
      ibiPairs,
      ibiSumSqErrMs2,
      ibiRmseMs: ibiPairs > 0 ? Math.sqrt(ibiSumSqErrMs2 / ibiPairs) : null,
      sdnnSegments,
      sdnnAbsDiffSumMs,
      sdnnDiffSumMs,
      sdnnMeanAbsDiffMs: ratio(sdnnAbsDiffSumMs, sdnnSegments),
      sdnnMeanDiffMs: ratio(sdnnDiffSumMs, sdnnSegments),
    },
    window: {
      onsetMaeMin: meanAbs(nights.map(n => n.window.onsetDiffMin)),
      finalWakeMaeMin: meanAbs(nights.map(n => n.window.finalWakeDiffMin)),
      totalSleepMaeMin: meanAbs(nights.map(n => n.window.totalSleepDiffMin)),
      wasoMaeMin: meanAbs(nights.map(n => n.window.wasoDiffMin)),
    },
    stages: {
      confusion,
      overlapEpochs: sum(n => n.stages.overlapEpochs),
      scoredEpochs: sum(n => n.stages.scoredEpochs),
      accuracy: accuracyOf(confusion),
      kappa: cohensKappa(confusion),
      sleepWakeAccuracy: accuracyOf(sleepWake),
      sleepWakeKappa: cohensKappa(sleepWake),
      podMinutesPerNight: perNight(n => n.stages.podMinutes),
      refMinutesPerNight: perNight(n => n.stages.refMinutes),
    },
  }
}

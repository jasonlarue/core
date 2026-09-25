/**
 * Deep sleep (N3) within the model's NREM.
 *
 * wrn-gru-mesa scores wake / REM / NREM; it does not separate slow-wave sleep
 * from light NREM (N1+N2). These rules pick out N3 from cardiac autonomic and
 * movement markers that are consistently reported in the literature:
 *
 * - Heart rate is lowest in N3 among NREM stages
 *   (Trinder et al., 2001, J Sleep Res 10:253-264).
 * - Vagal dominance peaks in N3: normalised HF power rises and LF/HF falls
 *   relative to N2 (Vanoli et al., 1995, Circulation 91:1918-1922; Bonnet &
 *   Arand, 1997, Electroencephalogr Clin Neurophysiol 102:390-396; review:
 *   Tobaldini et al., 2013, Front Physiol 4:294). High-frequency
 *   cardiopulmonary coupling marks stable NREM (Thomas et al., 2005, Sleep
 *   28:1151-1161).
 * - Body movements are rarest in N3 (Wilde-Frenz & Schulz, 1983, Percept
 *   Mot Skills 56:275-283).
 * - N3 is concentrated in the first sleep cycles and occurs in consolidated
 *   periods (Carskadon & Dement, Normal Human Sleep: An Overview, Principles
 *   and Practice of Sleep Medicine).
 * - N3 is ~13-23% of sleep in young adults and declines with age (Ohayon et
 *   al., 2004, Sleep 27:1255-1273); 25% is used as an upper bound.
 *
 * Absolute heart rate and HRV differ widely between people, so every marker
 * is scored against the SAME night's NREM epochs (robust z-scores: median and
 * MAD), not fixed thresholds. These are rules grounded in physiology, not a
 * trained model, and have not been validated against polysomnography on this
 * hardware.
 */

export interface DeepSleepEpoch {
  /** Model says NREM. */
  nrem: boolean
  /** Mean heart rate over the epoch's HRV window (bpm); NaN if unknown. */
  meanHR: number
  /** LF/HF ratio; NaN if unknown. */
  lfHfRatio: number
  /** Normalised HF power (%); NaN if unknown. */
  hfNorm: number
  /** Movement score (0-1000) for the epoch's minute, if known. */
  movement: number | null
}

export const DEEP_SLEEP_RULES = {
  /** Mean robust z-score an NREM epoch needs, early in the night. */
  scoreThreshold: 0.5,
  /** Stricter in the middle and last thirds of the sleep period. */
  middleThirdPenalty: 0.25,
  lastThirdPenalty: 0.5,
  /** Movement at or above this ("minor fidgeting" and up) rules out N3. */
  movementVeto: 50,
  /** N3 comes in consolidated runs: at least 5 minutes of 30 s epochs. */
  minRunEpochs: 10,
  /** Single-epoch dips inside a run are bridged. */
  maxGapEpochs: 1,
  /** Upper bound on N3 as a fraction of sleep epochs. */
  maxFraction: 0.25,
} as const

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return NaN
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

/** Robust z-scores (median / 1.4826·MAD) of `values` against `ref`. */
function robustZ(values: number[], ref: number[]): number[] {
  const m = median(ref)
  const mad = 1.4826 * median(ref.map(v => Math.abs(v - m)))
  return values.map(v => (Number.isFinite(v) && mad > 0 ? (v - m) / mad : NaN))
}

/** Per-epoch deep-sleep score: mean of −z(HR), −z(log LF/HF), +z(HF norm). */
export function deepSleepScores(epochs: DeepSleepEpoch[]): number[] {
  const logLfHf = epochs.map(e => (e.lfHfRatio > 0 ? Math.log(e.lfHfRatio) : NaN))
  const refIdx = epochs.map((e, i) => i).filter(i => epochs[i].nrem)
  const pick = (arr: number[]) => refIdx.map(i => arr[i]).filter(Number.isFinite)
  const hr = epochs.map(e => e.meanHR)
  const hfn = epochs.map(e => e.hfNorm)
  const zHr = robustZ(hr, pick(hr))
  const zLf = robustZ(logLfHf, pick(logLfHf))
  const zHf = robustZ(hfn, pick(hfn))
  return epochs.map((_, i) => {
    const terms = [-zHr[i], -zLf[i], zHf[i]].filter(Number.isFinite)
    return terms.length ? terms.reduce((a, b) => a + b, 0) / terms.length : NaN
  })
}

/**
 * Which epochs are deep sleep. `sleepEpoch[i]` marks epochs inside the
 * sleep period (non-wake); the time-of-night prior is measured from the
 * first to the last of them.
 */
export function detectDeepSleep(epochs: DeepSleepEpoch[], sleepEpoch: boolean[]): boolean[] {
  const R = DEEP_SLEEP_RULES
  const n = epochs.length
  const scores = deepSleepScores(epochs)
  const first = sleepEpoch.indexOf(true)
  const last = sleepEpoch.lastIndexOf(true)
  const span = Math.max(1, last - first)
  const candidate = epochs.map((e, i) => {
    if (!e.nrem || !Number.isFinite(scores[i])) return false
    if (e.movement !== null && e.movement >= R.movementVeto) return false
    const pos = first < 0 ? 0 : (i - first) / span
    const threshold = R.scoreThreshold
      + (pos > 2 / 3 ? R.lastThirdPenalty : pos > 1 / 3 ? R.middleThirdPenalty : 0)
    return scores[i] >= threshold
  })
  // Bridge short dips inside a run: a gap of <= maxGapEpochs between two
  // candidates is filled when the gap is still NREM and not moving.
  const still = (k: number) => {
    const mv = epochs[k].movement
    return epochs[k].nrem && (mv === null || mv < R.movementVeto)
  }
  for (let i = 0; i < n; i++) {
    if (!candidate[i]) continue
    let j = i + 1
    while (j < n && !candidate[j]) j++
    const gap = j - i - 1
    if (j < n && gap > 0 && gap <= R.maxGapEpochs) {
      let ok = true
      for (let k = i + 1; k < j; k++) ok &&= still(k)
      if (ok) for (let k = i + 1; k < j; k++) candidate[k] = true
    }
  }
  // Keep consolidated runs only.
  const runs: Array<{ start: number, end: number, score: number }> = []
  for (let i = 0; i < n;) {
    if (!candidate[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && candidate[j]) j++
    if (j - i >= R.minRunEpochs) {
      const s = scores.slice(i, j).filter(Number.isFinite)
      runs.push({ start: i, end: j, score: s.reduce((x, y) => x + y, 0) / Math.max(1, s.length) })
    }
    i = j
  }
  // Cap at the normative upper bound, strongest runs first.
  const sleepCount = sleepEpoch.filter(Boolean).length
  const cap = Math.floor(R.maxFraction * sleepCount)
  const deep = new Array(n).fill(false)
  let used = 0
  for (const run of [...runs].sort((x, y) => y.score - x.score)) {
    const len = run.end - run.start
    if (used + len > cap) continue
    for (let k = run.start; k < run.end; k++) deep[k] = true
    used += len
  }
  return deep
}

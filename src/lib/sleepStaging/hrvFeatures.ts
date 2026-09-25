/**
 * HRV feature extraction for the wrn-gru-mesa sleep-stage model — a port of
 * SleepECG's `extract_features` (feature_extraction.py, BSD-3-Clause, see
 * SLEEPECG_LICENSE) for the features that model uses: 26 time-domain and 7
 * frequency-domain HRV features per 30 s stage, over a window of `lookback`
 * seconds before to `lookforward` after the stage onset, plus recording start
 * time, age and sex.
 *
 * Numerics deliberately follow SleepECG/NumPy/SciPy exactly, quirks
 * included, because the model was trained on their output:
 * - windows are rows of a NaN-padded ragged array, so pNN50/pNN20 divide by
 *   the LONGEST window's successive-difference count over the whole night;
 * - RR intervals are linearly resampled at 4 Hz with scipy `interp1d`
 *   semantics (NaN where an interval touches a NaN, NaN out of range);
 * - spectra are scipy `periodogram`s: boxcar for complete windows; windows
 *   with up to `maxNans` missing get a Hann window over the valid samples
 *   (compacted), zero-padded to the full window length; density scaling.
 * Parity with SleepECG is pinned by tests/parity.test.ts.
 */

export interface FeatureParams {
  lookback: number
  lookforward: number
  fsResample: number
  maxNans: number
  minRri: number
  maxRri: number
  stageDuration: number
}

export const WRN_GRU_MESA_PARAMS: FeatureParams = {
  lookback: 120,
  lookforward: 150,
  fsResample: 4,
  maxNans: 0.5,
  minRri: 0.3,
  maxRri: 2,
  stageDuration: 30,
}

export const FEATURE_IDS = [
  'meanNN', 'maxNN', 'minNN', 'rangeNN', 'SDNN', 'RMSSD', 'SDSD', 'NN50', 'NN20',
  'pNN50', 'pNN20', 'medianNN', 'madNN', 'iqrNN', 'cvNN', 'cvSD', 'meanHR', 'maxHR',
  'minHR', 'stdHR', 'SD1', 'SD2', 'S', 'SD1_SD2_ratio', 'CSI', 'CVI',
  'total_power', 'VLF', 'LF', 'LF_norm', 'HF', 'HF_norm', 'LF_HF_ratio',
  'recording_start_time', 'age', 'gender',
] as const

export type Sex = 'female' | 'male'

export interface FeatureInput {
  /** RR intervals in seconds; NaN where no valid interval exists. */
  rri: ArrayLike<number>
  /** Time of each interval's closing beat, seconds from recording start. */
  rriTimes: ArrayLike<number>
  /** Number of 30 s stages (stage i starts at i * stageDuration). */
  numStages: number
  /** Recording start as seconds since local midnight. */
  recordingStartSec: number | null
  age: number | null
  sex: Sex | null
}

/** SleepECG's preprocess_rri: out-of-range intervals become NaN. */
export function preprocessRri(rri: ArrayLike<number>, minRri: number, maxRri: number): Float64Array {
  const out = new Float64Array(rri.length)
  for (let i = 0; i < rri.length; i++) {
    const v = rri[i]
    out[i] = v < minRri || v > maxRri ? NaN : v
  }
  return out
}

// ── NaN-aware statistics (NumPy semantics) ──

function finite(values: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i++) if (!Number.isNaN(values[i])) out.push(values[i])
  return out
}

function nanmean(values: ArrayLike<number>): number {
  const f = finite(values)
  if (f.length === 0) return NaN
  let s = 0
  for (const v of f) s += v
  return s / f.length
}

/** np.nanstd(ddof=1): NaN when fewer than 2 finite values. */
function nanstd1(values: ArrayLike<number>): number {
  const f = finite(values)
  if (f.length < 2) return NaN
  const m = f.reduce((a, b) => a + b, 0) / f.length
  let ss = 0
  for (const v of f) ss += (v - m) * (v - m)
  return Math.sqrt(ss / (f.length - 1))
}

/** np.nanpercentile with the default linear interpolation. */
function nanpercentile(values: ArrayLike<number>, q: number): number {
  const f = finite(values).sort((a, b) => a - b)
  if (f.length === 0) return NaN
  const pos = (q / 100) * (f.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return f[lo] + (f[hi] - f[lo]) * (pos - lo)
}

function nanmax(values: ArrayLike<number>): number {
  const f = finite(values)
  return f.length ? Math.max(...f) : NaN
}

function nanmin(values: ArrayLike<number>): number {
  const f = finite(values)
  return f.length ? Math.min(...f) : NaN
}

// ── Windowing ──

/** Indices [start, end) of rriTimes in [t - lookback, t + lookforward). */
function windowBounds(rriTimes: ArrayLike<number>, numStages: number, p: FeatureParams): Array<[number, number]> {
  const bounds: Array<[number, number]> = []
  let lo = 0
  let hi = 0
  for (let s = 0; s < numStages; s++) {
    const t = s * p.stageDuration
    const start = t - p.lookback
    const end = t + p.lookforward
    while (lo < rriTimes.length && rriTimes[lo] < start) lo++
    if (hi < lo) hi = lo
    while (hi < rriTimes.length && rriTimes[hi] < end) hi++
    bounds.push([lo, hi])
  }
  return bounds
}

function timeDomain(rri: Float64Array, bounds: Array<[number, number]>): number[][] {
  // Ragged-array quirk: every row is padded to the longest window, so the
  // pNN denominators are that longest window's diff count for all stages.
  const maxLen = bounds.reduce((m, [a, b]) => Math.max(m, b - a), 0)
  const diffSlots = Math.max(0, maxLen - 1)
  return bounds.map(([a, b]) => {
    const nn = rri.subarray(a, b)
    const sd: number[] = []
    for (let i = 1; i < nn.length; i++) sd.push(nn[i] - nn[i - 1]) // NaN if either is NaN
    const meanNN = nanmean(nn)
    const maxNN = nanmax(nn)
    const minNN = nanmin(nn)
    const SDNN = nanstd1(nn)
    const sdSquared = sd.map(v => v * v)
    const RMSSD = Math.sqrt(nanmean(sdSquared))
    const SDSD = nanstd1(sd)
    let nn50 = 0
    let nn20 = 0
    for (const v of sd) {
      if (Math.abs(v) > 0.05) nn50++
      if (Math.abs(v) > 0.02) nn20++
    }
    const pNN50 = diffSlots > 0 ? nn50 / diffSlots : NaN
    const pNN20 = diffSlots > 0 ? nn20 / diffSlots : NaN
    const medianNN = nanpercentile(nn, 50)
    const madNN = nanpercentile(Array.from(nn, v => Math.abs(v - medianNN)), 50)
    const iqrNN = nanpercentile(nn, 75) - nanpercentile(nn, 25)
    const cvNN = SDNN / meanNN
    const cvSD = SDSD / nanmean(sd)
    const stdHR = nanstd1(Array.from(nn, v => 60 / v))
    const SD1 = Math.sqrt(SDSD * SDSD * 0.5)
    const SD2 = Math.sqrt(2 * SDNN * SDNN - SD1 * SD1)
    return [
      meanNN, maxNN, minNN, maxNN - minNN, SDNN, RMSSD, SDSD, nn50, nn20, pNN50, pNN20,
      medianNN, madNN, iqrNN, cvNN, cvSD, 60 / meanNN, 60 / minNN, 60 / maxNN, stdHR,
      SD1, SD2, Math.PI * SD1 * SD2, SD1 / SD2, SD2 / SD1, Math.log10(SD1 * SD2 * 16),
    ]
  })
}

/** scipy interp1d(kind='linear', bounds_error=False) at `xNew`. */
function interpLinear(x: ArrayLike<number>, y: ArrayLike<number>, xNew: Float64Array): Float64Array {
  const out = new Float64Array(xNew.length).fill(NaN)
  const n = x.length
  if (n < 2) return out
  let idx = 1
  for (let i = 0; i < xNew.length; i++) {
    const t = xNew[i]
    if (t < x[0] || t > x[n - 1]) continue
    // searchsorted(x, t, 'left'), clipped to [1, n - 1]
    while (idx < n - 1 && x[idx] < t) idx++
    while (idx > 1 && x[idx - 1] >= t) idx--
    const lo = idx - 1
    const slope = (y[idx] - y[lo]) / (x[idx] - x[lo])
    out[i] = slope * (t - x[lo]) + y[lo]
  }
  return out
}

let dftCache: { n: number, bins: number, cos: Float64Array, sin: Float64Array } | null = null

function dftTables(n: number, bins: number) {
  if (dftCache && dftCache.n === n && dftCache.bins === bins) return dftCache
  const cos = new Float64Array(bins * n)
  const sin = new Float64Array(bins * n)
  for (let k = 0; k < bins; k++) {
    for (let j = 0; j < n; j++) {
      const a = (2 * Math.PI * ((k * j) % n)) / n
      cos[k * n + j] = Math.cos(a)
      sin[k * n + j] = Math.sin(a)
    }
  }
  dftCache = { n, bins, cos, sin }
  return dftCache
}

/** One-sided density periodogram bins 0..bins-1 of `x` zero-padded to `nfft`. */
function periodogramBins(x: ArrayLike<number>, window: 'boxcar' | 'hann', fs: number,
  nfft: number, bins: number): Float64Array {
  const m = x.length
  let mean = 0
  for (let i = 0; i < m; i++) mean += x[i]
  mean /= m
  const w = new Float64Array(m)
  let wss = 0
  for (let i = 0; i < m; i++) {
    // scipy get_window('hann', m) is periodic (fftbins=True).
    const wi = window === 'hann' ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / m) : 1
    w[i] = (x[i] - mean) * wi
    wss += wi * wi
  }
  const { cos, sin } = dftTables(nfft, bins)
  const scale = 1 / (fs * wss)
  const out = new Float64Array(bins)
  for (let k = 0; k < bins; k++) {
    let re = 0
    let im = 0
    const base = k * nfft
    for (let j = 0; j < m; j++) {
      re += w[j] * cos[base + j]
      im -= w[j] * sin[base + j]
    }
    const nyquist = nfft % 2 === 0 && k === nfft / 2
    out[k] = (re * re + im * im) * scale * (k === 0 || nyquist ? 1 : 2)
  }
  return out
}

/** scipy.integrate.trapezoid over the masked (contiguous) bins. */
function trapezoid(psd: Float64Array, freq: Float64Array, lo: number, hi: number): number {
  let s = 0
  for (let k = lo; k < hi; k++) s += (freq[k + 1] - freq[k]) * (psd[k] + psd[k + 1]) / 2
  return s
}

function frequencyDomain(rri: Float64Array, rriTimes: ArrayLike<number>,
  numStages: number, p: FeatureParams): number[][] {
  const step = 1 / p.fsResample
  const start = -p.lookback
  const stop = (numStages - 1) * p.stageDuration + p.lookforward
  const nInterp = Math.ceil((stop - start) / step)
  const times = new Float64Array(nInterp)
  for (let i = 0; i < nInterp; i++) times[i] = start + i * step
  const interp = interpLinear(rriTimes, rri, times)

  const nfft = Math.trunc((p.lookback + p.lookforward) * p.fsResample)
  const winStep = Math.trunc(p.fsResample * p.stageDuration)
  // rfftfreq: k * (1 / (n * d))
  const df = 1 / (nfft * step)
  const nBinsAll = Math.floor(nfft / 2) + 1
  const freq = new Float64Array(nBinsAll)
  for (let k = 0; k < nBinsAll; k++) freq[k] = k * df
  let bins = 0
  while (bins < nBinsAll && freq[bins] <= 0.4) bins++
  const band = (lo: number, hi: number): [number, number] => {
    let a = -1
    let b = -1
    for (let k = 0; k < bins; k++) {
      if (freq[k] > lo && freq[k] <= hi) {
        if (a < 0) a = k
        b = k
      }
    }
    return [a, b]
  }
  const vlf = band(0.0033, 0.04)
  const lf = band(0.04, 0.15)
  const hf = band(0.15, 0.4)

  const rows: number[][] = []
  for (let s = 0; s < numStages; s++) {
    const seg = interp.subarray(s * winStep, s * winStep + nfft)
    let nanCount = 0
    for (let i = 0; i < seg.length; i++) if (Number.isNaN(seg[i])) nanCount++
    const frac = nanCount / nfft
    let psd: Float64Array | null = null
    if (nanCount === 0) {
      psd = periodogramBins(seg, 'boxcar', p.fsResample, nfft, bins)
    }
    else if (frac <= p.maxNans && frac < 1) {
      psd = periodogramBins(finite(seg), 'hann', p.fsResample, nfft, bins)
    }
    if (!psd) {
      rows.push(new Array(7).fill(NaN))
      continue
    }
    const total = trapezoid(psd, freq, 0, bins - 1)
    const vlfP = trapezoid(psd, freq, vlf[0], vlf[1])
    const lfP = trapezoid(psd, freq, lf[0], lf[1])
    const hfP = trapezoid(psd, freq, hf[0], hf[1])
    rows.push([total, vlfP, lfP, lfP / (lfP + hfP) * 100, hfP, hfP / (lfP + hfP) * 100, lfP / hfP])
  }
  return rows
}

/**
 * The 36-column feature matrix (FEATURE_IDS order) for `input.numStages`
 * stages. Missing values are NaN; the model runtime masks them.
 */
export function extractFeatures(input: FeatureInput, p: FeatureParams = WRN_GRU_MESA_PARAMS): number[][] {
  const rri = preprocessRri(input.rri, p.minRri, p.maxRri)
  const bounds = windowBounds(input.rriTimes, input.numStages, p)
  const td = input.numStages > 0 ? timeDomain(rri, bounds) : []
  const fd = input.numStages > 0 ? frequencyDomain(rri, input.rriTimes, input.numStages, p) : []
  const meta = [
    input.recordingStartSec ?? NaN,
    input.age ?? NaN,
    input.sex === 'male' ? 1 : input.sex === 'female' ? 0 : NaN,
  ]
  const out: number[][] = []
  for (let s = 0; s < input.numStages; s++) out.push([...td[s], ...fd[s], ...meta])
  if (out.length && out[0].length !== FEATURE_IDS.length) {
    throw new Error(`feature count ${out[0].length} != ${FEATURE_IDS.length}`)
  }
  return out
}

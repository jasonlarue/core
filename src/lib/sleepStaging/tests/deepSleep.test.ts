import { describe, expect, it } from 'vitest'
import { DEEP_SLEEP_RULES, detectDeepSleep, type DeepSleepEpoch } from '../deepSleep'

/**
 * A synthetic night of `n` NREM epochs with light-NREM autonomic markers
 * (with some spread), and an N3-like run: lower HR, lower LF/HF, higher
 * normalised HF — the directions reported for slow-wave sleep.
 */
function night(n: number, deep: Array<[number, number]>, opts: { hrShift?: number, strength?: number } = {}) {
  const s = opts.strength ?? 1
  const epochs: DeepSleepEpoch[] = []
  for (let i = 0; i < n; i++) {
    const jitter = Math.sin(i * 1.7) // deterministic spread
    const inDeep = deep.some(([a, b]) => i >= a && i < b)
    epochs.push({
      nrem: true,
      meanHR: 60 + 2 * jitter - (inDeep ? 5 * s : 0) + (opts.hrShift ?? 0),
      lfHfRatio: Math.exp(0.3 * jitter - (inDeep ? 0.9 * s : 0)),
      hfNorm: 45 + 5 * jitter + (inDeep ? 18 * s : 0),
      movement: 0,
    })
  }
  return epochs
}

const allSleep = (n: number) => new Array(n).fill(true)
const count = (xs: boolean[]) => xs.filter(Boolean).length

describe('detectDeepSleep', () => {
  it('finds a sustained N3-like run early in the night', () => {
    const e = night(600, [[60, 120]])
    const deep = detectDeepSleep(e, allSleep(600))
    const inRun = deep.slice(60, 120).filter(Boolean).length
    expect(inRun).toBeGreaterThanOrEqual(55)
    expect(count(deep) - inRun).toBeLessThanOrEqual(3)
  })

  it('is scored against the night itself, not absolute heart rate', () => {
    const base = detectDeepSleep(night(600, [[60, 120]]), allSleep(600))
    const shifted = detectDeepSleep(night(600, [[60, 120]], { hrShift: 20 }), allSleep(600))
    expect(shifted).toEqual(base)
  })

  it('never labels a moving epoch, and breaks the run there', () => {
    const e = night(600, [[60, 120]])
    for (let i = 85; i < 95; i++) e[i].movement = 300
    const deep = detectDeepSleep(e, allSleep(600))
    expect(deep.slice(85, 95).some(Boolean)).toBe(false)
  })

  it('drops runs shorter than five minutes', () => {
    const deep = detectDeepSleep(night(600, [[60, 60 + DEEP_SLEEP_RULES.minRunEpochs - 2]]), allSleep(600))
    expect(count(deep)).toBe(0)
  })

  it('bridges a single-epoch dip inside a run', () => {
    const e = night(600, [[60, 90], [91, 120]])
    const deep = detectDeepSleep(e, allSleep(600))
    expect(deep[90]).toBe(true)
  })

  it('demands stronger evidence late in the night', () => {
    const early = detectDeepSleep(night(600, [[60, 120]], { strength: 0.45 }), allSleep(600))
    const late = detectDeepSleep(night(600, [[500, 560]], { strength: 0.45 }), allSleep(600))
    expect(count(early.slice(60, 120))).toBeGreaterThan(count(late.slice(500, 560)))
  })

  it('caps deep sleep at 25% of the sleep period', () => {
    const deep = detectDeepSleep(night(400, [[20, 150], [200, 330]]), allSleep(400))
    expect(count(deep)).toBeLessThanOrEqual(Math.floor(0.25 * 400))
  })

  it('only NREM can be deep', () => {
    const e = night(600, [[60, 120]])
    for (let i = 60; i < 120; i++) e[i].nrem = false
    expect(count(detectDeepSleep(e, allSleep(600)))).toBe(0)
  })

  it('tolerates missing markers', () => {
    const e = night(600, [[60, 120]])
    for (let i = 60; i < 120; i++) e[i].lfHfRatio = Number.NaN
    // Heart rate and HF norm still point to N3.
    expect(count(detectDeepSleep(e, allSleep(600)).slice(60, 120))).toBeGreaterThanOrEqual(50)
  })
})

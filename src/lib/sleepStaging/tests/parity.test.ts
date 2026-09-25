/**
 * Parity with SleepECG: features and wrn-gru-mesa probabilities computed by
 * the real Python package (sleepecg 0.5.9 + Keras) on two synthetic nights —
 * one with age/sex, a short beat gap, an extra and a missed beat; one without
 * metadata and with a 4-minute gap (windows over half empty exercise the
 * Hann-windowed partial periodogram). Regenerate with the export script in
 * this directory's README if the upstream model changes.
 */
import { describe, expect, it } from 'vitest'
import { extractFeatures, FEATURE_IDS, type Sex } from '../hrvFeatures'
import { predictStages, type ModelWeights } from '../gruModel'
import weights from '../wrn-gru-mesa.weights.json'
import parity from './fixtures/wrn-gru-mesa.parity.json'

interface Fixture {
  name: string
  heartbeatTimes: number[]
  recordingStartSec: number
  age: number | null
  sex: number | null
  numStages: number
  featureIds: string[]
  features: Array<Array<number | string | null>>
  probs: number[][]
}

const fixtures = (parity as { fixtures: Fixture[] }).fixtures

function decode(v: number | string | null): number {
  if (v === null) return NaN
  if (v === 'inf') return Infinity
  if (v === '-inf') return -Infinity
  return v as number
}

function computeFeatures(f: Fixture) {
  const hb = f.heartbeatTimes
  const rri = hb.slice(1).map((t, i) => t - hb[i])
  return extractFeatures({
    rri,
    rriTimes: hb.slice(1),
    numStages: f.numStages,
    recordingStartSec: f.recordingStartSec,
    age: f.age,
    sex: f.sex === null ? null : (f.sex === 1 ? 'male' : 'female') as Sex,
  })
}

describe.each(fixtures.map(f => [f.name, f] as const))('SleepECG parity — night %s', (_name, f) => {
  const ours = computeFeatures(f)

  it('uses the same feature order', () => {
    expect([...FEATURE_IDS]).toEqual(f.featureIds)
    expect(ours).toHaveLength(f.numStages)
  })

  it('matches every feature', () => {
    let compared = 0
    for (let s = 0; s < f.numStages; s++) {
      for (let c = 0; c < FEATURE_IDS.length; c++) {
        const want = decode(f.features[s][c])
        const got = ours[s][c]
        if (Number.isNaN(want)) {
          expect(got, `${FEATURE_IDS[c]} @ stage ${s}`).toBeNaN()
          continue
        }
        const tol = 1e-9 * Math.max(1, Math.abs(want))
        expect(Math.abs(got - want), `${FEATURE_IDS[c]} @ stage ${s}: ${got} vs ${want}`).toBeLessThanOrEqual(tol)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(f.numStages * 20)
  })

  it('matches the Keras stage probabilities', () => {
    const probs = predictStages(ours, weights as unknown as ModelWeights)
    for (let s = 0; s < f.numStages; s++) {
      for (let k = 0; k < 4; k++) {
        // Keras runs in float32; the port in float64.
        expect(Math.abs(probs[s][k] - f.probs[s][k]), `stage ${s} class ${k}`).toBeLessThan(1e-4)
      }
    }
  })
})

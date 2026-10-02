/**
 * Forward pass of SleepECG's wrn-gru-mesa classifier (BSD-3-Clause, see
 * SLEEPECG_LICENSE), reimplemented from its exported Keras weights so the pod
 * needs no ML runtime:
 *
 *   Masking(-1) → BatchNormalization → Dense(64) → ReLU
 *     → Bidirectional(GRU(8)) → Bidirectional(GRU(8)) → Dense(4, softmax)
 *
 * Keras semantics reproduced:
 * - Masking: a timestep is masked when every feature equals the mask value.
 * - BatchNormalization (inference): gamma·(x − mean)/√(var + ε) + beta.
 * - GRU, reset_after=True, gate order [z, r, h], sigmoid / tanh:
 *     z = σ(x·Wz + bz + h·Uz + rbz),  r = σ(x·Wr + br + h·Ur + rbr)
 *     ĥ = tanh(x·Wh + bh + r ⊙ (h·Uh + rbh)),  h' = z ⊙ h + (1 − z) ⊙ ĥ
 * - Bidirectional(merge_mode='concat', return_sequences): the backward GRU
 *   reads the sequence reversed; its outputs are re-aligned and appended.
 *   Masked steps carry the state and output zeros.
 *
 * Output per 30 s stage: probabilities over [UNDEFINED, NREM, REM, WAKE].
 * Parity with Keras is pinned by tests/parity.test.ts.
 */

type Matrix = number[][] // [rows][cols]

interface GruWeights {
  kernel: Matrix // [input][3·units]
  recurrentKernel: Matrix // [units][3·units]
  inputBias: number[] // [3·units]
  recurrentBias: number[] // [3·units]
}

export interface ModelWeights {
  maskValue: number
  outputClasses: string[]
  batchNorm: { gamma: number[], beta: number[], movingMean: number[], movingVar: number[], epsilon: number }
  dense: { kernel: Matrix, bias: number[] }
  gru1: { forward: GruWeights, backward: GruWeights }
  gru2: { forward: GruWeights, backward: GruWeights }
  output: { kernel: Matrix, bias: number[] }
}

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v))

function affine(x: number[], kernel: Matrix, bias: number[]): number[] {
  const out = bias.slice()
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]
    if (xi === 0) continue
    const row = kernel[i]
    for (let j = 0; j < out.length; j++) out[j] += xi * row[j]
  }
  return out
}

/** One GRU direction over `seq`; masked steps keep state, output zeros. */
function gru(seq: number[][], mask: boolean[], w: GruWeights, reverse: boolean): number[][] {
  const units = w.recurrentKernel.length
  const out: number[][] = new Array(seq.length)
  let h = new Array(units).fill(0)
  for (let step = 0; step < seq.length; step++) {
    const t = reverse ? seq.length - 1 - step : step
    if (!mask[t]) {
      out[t] = new Array(units).fill(0)
      continue
    }
    const mx = affine(seq[t], w.kernel, w.inputBias)
    const mh = affine(h, w.recurrentKernel, w.recurrentBias)
    const next = new Array(units)
    for (let u = 0; u < units; u++) {
      const z = sigmoid(mx[u] + mh[u])
      const r = sigmoid(mx[units + u] + mh[units + u])
      const hh = Math.tanh(mx[2 * units + u] + r * mh[2 * units + u])
      next[u] = z * h[u] + (1 - z) * hh
    }
    h = next
    out[t] = next.slice()
  }
  return out
}

function bidirectional(seq: number[][], mask: boolean[], w: { forward: GruWeights, backward: GruWeights }): number[][] {
  const f = gru(seq, mask, w.forward, false)
  const b = gru(seq, mask, w.backward, true)
  return seq.map((_, t) => [...f[t], ...b[t]])
}

function softmax(v: number[]): number[] {
  const m = Math.max(...v)
  const e = v.map(x => Math.exp(x - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map(x => x / s)
}

/**
 * Stage probabilities for a night's feature matrix (`numStages × 36`).
 * Non-finite features are replaced by the mask value, as SleepECG's
 * `stage()` does before calling the model.
 */
export function predictStages(features: number[][], weights: ModelWeights): number[][] {
  const mv = weights.maskValue
  const x = features.map(row => row.map(v => (Number.isFinite(v) ? v : mv)))
  const mask = x.map(row => row.some(v => v !== mv))
  const bn = weights.batchNorm
  const hidden = x.map((row) => {
    const normed = row.map((v, i) => bn.gamma[i] * (v - bn.movingMean[i]) / Math.sqrt(bn.movingVar[i] + bn.epsilon) + bn.beta[i])
    return affine(normed, weights.dense.kernel, weights.dense.bias).map(v => Math.max(0, v))
  })
  const g1 = bidirectional(hidden, mask, weights.gru1)
  const g2 = bidirectional(g1, mask, weights.gru2)
  return g2.map(row => softmax(affine(row, weights.output.kernel, weights.output.bias)))
}

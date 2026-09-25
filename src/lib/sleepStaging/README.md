# Sleep staging (wrn-gru-mesa)

A dependency-free TypeScript port of [SleepECG](https://github.com/cbrnr/sleepecg)'s
`wrn-gru-mesa` classifier (BSD-3-Clause, see `SLEEPECG_LICENSE`): wake / REM /
NREM per 30 s stage from beat-to-beat heart rate, trained on 1,971 MESA nights and
tested on 1,000 SHHS nights (accuracy 0.75, κ 0.54 on ECG-derived beats).

| File | Role |
|---|---|
| `hrvFeatures.ts` | 26 time-domain + 7 frequency-domain HRV features per stage, plus recording start time, age and sex — SleepECG's `extract_features`, numerics included |
| `gruModel.ts` | The Keras network's forward pass (batch-norm → dense → 2 × bidirectional GRU(8) → softmax) |
| `wrn-gru-mesa.weights.json` | Exported weights (~7.4k parameters) |
| `tests/parity.test.ts` | Features match SleepECG to 1e-9 relative, probabilities match Keras to 1e-4, on two synthetic nights covering complete, gappy (Hann-windowed) and unusable windows |

The model expects age and sex: without them (inputs masked to −1) it drifts
strongly towards WAKE, so callers should fall back to the rule-based stager when
the sleeper profile is unset.

Regenerate weights and fixtures with `scripts/sleepecg/export_wrn_gru_mesa.py`
(dev machine only).

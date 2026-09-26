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
| `deepSleep.ts` | Rules that pick deep sleep (N3) out of the model's NREM |
| `stageNight.ts` | The pipeline: heartbeats → RR intervals → features → model → deep-sleep rules → `SleepEpoch[]` |

The model expects age and sex: without them (inputs masked to −1) it drifts
strongly towards WAKE, so callers should fall back to the rule-based stager when
the sleeper profile is unset.

## Pipeline

`biometrics.getSleepStages` calls `stageNight()` with the night's `heartbeats`
chunks (written by the piezo-processor's beat detector, see
`docs/piezo-processor.md` §5a), the side's age and sex, the device timezone,
and the night's movement and vitals.

1. **RR intervals.** Beats become intervals; no interval spans a detector
   break, a missing minute or a gap between chunks. The first beat after one
   closes a NaN interval — SleepECG's representation of a missed beat — so
   the 4 Hz resampling and successive differences stop at the gap instead of
   joining the intervals on either side (which smooths away HF power and
   reads as wake).
2. **Features and model.** 30 s stages over the whole bed window. The
   recording start time counts from the previous day for a start before noon
   (00:22 → 87,720 s): the model was trained on evening starts (21:21 ± 1.6 h)
   and a small after-midnight value is far outside what it saw. The class
   with the highest probability among NREM / REM / WAKE is taken (UNDEFINED is
   never a real stage). Stages without heart data use movement instead
   (> 200 → wake, else NREM) so short dropouts don't punch holes in the night.
3. **Deep sleep.** Within NREM, `detectDeepSleep()` scores each stage by the
   mean robust z-score of lower heart rate, lower log LF/HF and higher
   normalised HF power, against the same night's NREM (people differ too much
   for fixed thresholds). A stage qualifies above 0.5, raised by 0.25 in the
   middle third of the night and 0.5 in the last third (N3 is front-loaded).
   Any movement ≥ 50 rules it out, runs shorter than 5 minutes are dropped
   (one-stage dips are bridged), and deep sleep is capped at 25% of sleep.
   The sources for each rule are cited in `deepSleep.ts`.
4. **Output.** Stages become `SleepEpoch`s (wake / light / deep / REM, with
   mean HR, RMSSD and the nearest breathing rate) and go through the same
   block merging, distribution and quality score as the rule-based stager.

`stageNight()` returns `{ ok: false, reason }` and the endpoint falls back to
the rule-based stager (`src/lib/sleep-stages.ts`) when:

- `profile` — age or sex is unset for the side (Settings → Sleeper profile);
- `coverage` — the night is under 10 minutes, or fewer than half of its
  stages have a usable heart-rate window (at most half of its 4.5 minutes
  missing, SleepECG's limit for spectral features). With gappier input the
  model leans on age and time of night rather than the heart.

The response's `method` (`model` | `rules`) and `fallbackReason` say which
path ran; the sleep-stages card shows it under the date.

**Accuracy caveats.** SleepECG's figures are for ECG-derived beats. Beats
from the bed's piezo sensors are noisier, so expect lower agreement until
this is compared against a reference device. The deep-sleep rules are
grounded in the physiology literature, not trained, and have not been
validated against polysomnography on this hardware. The model was trained on
MESA participants (age 69 ± 9); for much younger sleepers it extrapolates,
and its output is sensitive to the age input when heart data is thin.

Regenerate weights and fixtures with `scripts/sleepecg/export_wrn_gru_mesa.py`
(dev machine only).

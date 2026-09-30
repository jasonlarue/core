# Sleep Tracking Accuracy Plan

**Status:** Proposal. Nothing here is decided; steps become ADRs once they're built and measured.
**Date:** 2026-09-30
**Builds on:** `feat/beat-detection-sleep-staging` (beat detection in `modules/piezo-processor/beats.py`, heart-rhythm staging in `src/lib/sleepStaging/`)
**Spans:** `sleepypod/core` (pod) and `sleepypod/ios` (app)

## Execution Status

In progress 2026-09-30 (branch `claude/eloquent-rubin-0fuo61`, on top of `feat/beat-detection-sleep-staging`):

- A0.2 done: `reference_nights` table and endpoints, raw keep-list, pruner and archiver changes.
- A0.3 done: `src/lib/sleepStaging/agreement.ts`.
- A0.4 partly done: `pnpm replay fetch` and `pnpm replay score` (restaging is part of `score`); `replay reprocess` still needs a batch mode in the Python processors.
- A0.1 and A1 (iOS) not started: waiting on a `jasonlarue/ios` fork to push to.

## Goal

Make the pod's sleep tracking agree with an Apple Watch as closely as possible: first with changes that improve accuracy for every sleepypod user, then with optional per-sleeper tuning for people who also wear a watch.

"Agree with the watch" is the working definition of accuracy because it is what can be measured at home. The watch is not ground truth: against lab polysomnography it scores Cohen's κ 0.20–0.53 on four stages and ~88% on sleep vs. wake. Matching it is a reachable, deliberate target, not a claim that the pod becomes clinically accurate. (κ is agreement corrected for chance: 0 = no better than guessing from stage frequencies, 1 = perfect.)

Placeholder targets, to be replaced once A0 measures a baseline:

- Beat heart rate available for ≥ 90% of the watch's heart-rate readings, within 2 bpm.
- Sleep vs. wake agreeing on ≥ 90% of 30 s epochs; total sleep within 15 min of the watch.
- Nightly deep and REM minutes within 10–15 min of the watch.
- Four-stage κ vs. the watch: as high as possible. Baseline first.

## Where Things Stand

- `beats.py` detects individual heartbeats and writes them to the `heartbeats` table. On one Pod 4 night against a wrist-worn reference, beat heart rate was available for 84% of readings with 1.6 bpm mean error (`docs/piezo-processor.md` §5a).
- `src/lib/sleepStaging/` runs SleepECG's `wrn-gru-mesa` (wake / REM / NREM), trained on MESA (NSRR lists ages 54–95; SleepECG's training nights average 69 ± 9), plus literature-based deep-sleep rules. `getSleepStages` falls back to the rule-based `src/lib/sleep-stages.ts` when age/sex are unset or under half the night has usable beats.
- The iOS app does not call `getSleepStages`; it runs its own rule-based `SleepAnalyzer` on the phone, so pod-side improvements don't reach app users.
- There is no way to score a night against a reference except one-off replays.
- Raw frames survive days to ~2 weeks (the archive pruner keeps `/persistent` under 80%, ADR-0018). Processed rows (`heartbeats`, `movement`, `vitals`) survive 90 days (`BIOMETRICS_RETENTION_DAYS`).
- The Python processors only follow the live RAW file (`RawFileFollower`); there is no batch mode for archived frames.

## Principles

1. **Shared before personal.** Per-sleeper corrections are fitted on top of the shared model, so every shared-model change would force a refit. Settle the shared model first.
2. **Measure every change.** Each PR that claims an accuracy change includes before/after `replay score` output.
3. **Prefer changes that generalize.** Signal-processing fixes and models trained on large public datasets carry over to other sleepers; constants fitted to one sleeper may not.
4. **Health data stays home.** Watch data goes phone → pod over the LAN. Replay data stays on the developer's machine and is never committed. Only code, model weights and a few constants ship.
5. **Upstream is the distribution channel.** Pod changes go to `sleepypod/core`, app changes to `sleepypod/ios`. Early testers can install a fork's branch build (sleepypod/core#705).

---

## Part A: Accuracy for Everyone

### A0: Measurement

Only the developer and volunteers need this. It is the ruler for everything after it.

#### A0.1 Watch nights → pod (`sleepypod/ios`)

New `HealthReferenceSync` service:

- **Read authorization:** sleep analysis, heart rate, HRV (SDNN), heartbeat series (`HKSeriesType.heartbeat()`), respiratory rate. `NSHealthShareUsageDescription` already exists. Remove the unused `health-records` entitlement while here.
- **Finding nights:** `HKAnchoredObjectQuery` on sleep analysis with the anchor persisted, so each run sees only new or edited nights. Keep only samples whose `sourceRevision.productType` starts with `"Watch"` (other apps can write sleep data to Health). Group samples into nights; skip nights that ended less than an hour ago.
- **Per night:**
  - stage intervals: `asleepCore` → light, `asleepDeep` → deep, `asleepREM` → rem, `awake` → wake (`inBed` ignored)
  - heart-rate samples
  - HRV samples with their beat times via `HKHeartbeatSeriesQuery` (time since series start, `precededByGap`)
  - respiratory rate
- **Upload:** new `reportReferenceNight` on `SleepypodProtocol`. `SleepypodCoreClient` calls the pod; `FreeSleepClient` throws unsupported; `MockClient` is a no-op. Side comes from `UserProfile.defaultSide`. Include the phone's send time.
- **When:** on app foreground and pull-to-refresh on the Health screen, behind an opt-in "Share Apple Watch sleep with pod" setting. Background delivery can come later; it needs another entitlement and background local-network access is unreliable.

#### A0.2 Storage and raw keep-list (`sleepypod/core`)

- `reference_nights` table in biometrics.db: `id`, `side`, `source` (`apple-watch`), `device_model`, `pod_model`, `night_start`, `night_end`, JSON columns for `stages`, `heart_rate`, `hrv`, `beat_series`, `respiratory_rate`, plus `clock_offset_ms` and `uploaded_at`. Unique on `(side, night_start)`; uploads upsert. Not in `RETENTION_TABLES`: it is small and is the evaluation set.
- `biometrics.reportReferenceNight` (mutation, exposed via trpc-to-openapi) and `biometrics.getReferenceNights` (query).
- **Clock offset:** pod receive time minus phone send time. The pod may have no NTP while WAN is blocked, so pod and watch timestamps are aligned with this offset.
- **Raw keep-list:** on upload, append the night's window to `/persistent/biometrics-archive/keep.list`. `sleepypod-biometrics-pruner` skips archives inside a kept window, capped at the most recent 14 reference nights.
- **Privacy:** same LAN trust model as other biometrics (no auth; see `openapi.ts`). Document the new data in `docs/PRIVACY.md`.

#### A0.3 Scoring library

`src/lib/sleepStaging/agreement.ts`: a pure function from (pod night, reference night) to metrics, computed on the overlap of the two windows after clock-offset correction.

| Area | Metrics |
|---|---|
| Heart | HR mean absolute error vs. watch samples (nearest minute); share of watch readings with a pod beat HR; beat timing on the watch's heartbeat segments (align, then interval RMSE and matched-beat share); SDNN difference |
| Sleep window | Sleep-onset and final-wake differences; total-sleep and wake-after-onset differences |
| Stages | 30 s confusion matrix; 4-stage κ; sleep/wake accuracy and κ; per-stage minute differences; share of the night staged by the model vs. the rule fallback |

Used by the replay CLI now and by the pod scoreboard in Part B.

#### A0.4 Replay CLI (`pnpm replay`, dev machine)

| Command | What it does |
|---|---|
| `replay fetch --pod <host> [--raw]` | For every stored reference night, saves a replay bundle from `biometrics.getReplayBundle` (the watch night, the pod's in-bed window for it, the heartbeats, movement and vitals staging reads, the sleeper profile and timezone) to `.replay/nights/`. With `--raw`, also saves the night's raw frames from the pod's existing `/api/export/archive` route to `.replay/raw/`. Plain HTTP over the LAN API; no SSH. `.replay/` is gitignored. |
| `replay score [--save <file>] [--baseline <file>] [--json]` | Re-stages every bundle with the working tree's code (`stageWindow`, the same path `getSleepStages` uses) and scores it against its reference night: per-night and pooled metrics, with changes against a saved baseline report. `--json` output carries no health data and is what volunteers share. |
| `replay reprocess` (not built yet) | Runs the working tree's piezo-processor and sleep-detector in a new batch mode (`--replay <dir> --db <tmp.db>`) over the fetched raw frames in order, then scores. For `beats.py`, presence and movement changes. |

Why bundles instead of copying `biometrics.db`: the database can reach hundreds of MB and the pod's `/tmp` is RAM-backed, while one night's bundle is well under a megabyte and needs nothing but the API.

Batch-mode notes:

- The processors must take "now" from record timestamps. Beat heart rate is only used when the latest beat is < 45 s old, so a wall-clock replay would silently fall back to the window estimate.
- Parity check: reprocessing with unchanged code must reproduce the pod's live `heartbeats` and `movement` rows within tolerance.

#### Acceptance Criteria

- A synced watch night appears in `reference_nights` with its clock offset.
- `replay score` on the current branch produces a baseline for ≥ 7 nights; the placeholder targets above are replaced with numbers set from it.
- Reprocess parity holds on at least one full night.

### A1: One Stager for App and Web (`sleepypod/ios`)

#### Action

- The Health screen and `SleepStagesTimelineView` use `getSleepStages` instead of `SleepAnalyzer`. Keep `SleepAnalyzer` only if the free-sleep backend still needs it.
- Show the staging method and fallback reason, as the web card does.

#### Acceptance Criteria

- The same night renders identically in the app and on the web.

### A2: Beat and Movement Quality

#### Action

Iterate on `beats.py`, presence detection and movement gating with `replay reprocess`. Each fix gets a synthetic regression case in `test_beats.py` (or the sleep-detector tests) for the failure mode it addresses.

#### Acceptance Criteria

- Beat coverage and heart-rate error improve on the pooled nights.
- No individual night regresses beyond noise.

### A3: Sleep vs. Wake from `ws-gru-mesa`

SleepECG's `ws-gru-mesa` (wake vs. sleep, κ 0.60 on SHHS) uses the same feature types as `wrn-gru-mesa` with longer windows (lookback 240 s / lookforward 270 s vs. 120 / 150).

#### Action

- Export its weights with `scripts/sleepecg/`, add its parameters alongside `WRN_GRU_MESA_PARAMS`, and add a parity fixture.
- `ws-gru-mesa` decides sleep vs. wake; `wrn-gru-mesa` decides REM vs. NREM within sleep.

#### Acceptance Criteria

- Sleep/wake agreement and total-sleep error improve against the baseline.
- Superseded by A4 if the retrained model does better on sleep vs. wake.

### A4: Retrain on NSRR

**Apply for NSRR access on day 1.** Access is a per-dataset Data Access and Use Agreement, reviewed in up to two weeks and valid for three years. Commercial use is restricted per dataset, based on participant consent.

#### Action

Adapt SleepECG's `examples/classifiers/wrn_gru_mesa.py` (about 50 lines of Keras, same architecture the TypeScript port already runs):

- `stages_mode="wake-rem-light-n3"`: four stages directly. Retires the `deepSleep.ts` rules if it wins.
- Add the `"actigraphy"` feature group (MESA wrist actigraphy via `activity_source="actigraphy"`). On the pod, feed the `movement` table normalized per night.
- Train variants with and without age/sex. Dropping them removes the sleeper-profile fallback.
- Heartbeats from NSRR's R-peak annotations (`heartbeats_source="annotation"`), so the raw recordings (385 GB MESA, 356 GB SHHS) are never downloaded.
- Cohorts: MESA + SHHS first, then WSC, CFS and HomePAP for younger sleepers.

| Cohort | People | Ages | Notes |
|---|---|---|---|
| SHHS | 5,804 | 40–89 | Largest; SleepECG's test set |
| MESA | 2,237 | 54–95 | Current training set; has concurrent wrist actigraphy |
| WSC | 1,123 | 37–85 | Middle-aged adults |
| CFS | 735 | 6–88 | Widest age range |
| HomePAP | 373 | 20–80 | Adults with sleep apnea |

Excluded: MrOS and SOF (65+ only), CHAT (children), NCHSDB (mostly pediatric clinic). HCHS/SOL is large and young, but its home apnea test likely has no stage labels; check before relying on it.

Evaluate twice:

- **Across ages:** train on MESA + SHHS, test on held-out WSC + CFS.
- **On the bed sensor:** `replay restage` on the watch nights.

Ship the weights JSON with a parity fixture; extend the TypeScript port for the actigraphy feature and four-class output.

#### Acceptance Criteria

- Held-out-cohort κ at least matches `wrn-gru-mesa` on its classes.
- Watch-night agreement beats the A3 result.

### A5: Breathing Features (only if A4 plateaus)

ECG plus respiratory effort reached κ 0.76 for wake / REM / NREM on 8,682 PSGs (Sun et al. 2020); `wrn-gru-mesa` reports κ 0.54 on the same classes (different test sets, so not a clean comparison). A bed sensor picks up breathing strongly, and the current model uses none of it.

#### Action

- Per-breath intervals or a respiratory envelope from the piezo-processor, stored alongside heartbeats (breathing rate is currently one value per minute).
- Respiratory-rate variability features per 30 s epoch.
- Matching training features from NSRR's thorax/abdomen effort belts. This needs feature extraction beyond SleepECG.

The largest step in the plan; start it only if A4 leaves a clear gap.

### A6: Shared Defaults from Pooled Watch Nights

#### Action

Fit a handful of constants (an overall stage-bias correction, any remaining thresholds) on pooled watch nights from the developer and volunteers. Volunteers run A0 and share only `replay score --json` output.

#### Acceptance Criteria

- Ships only if it improves held-out nights for several sleepers, not only the developer.
- Skipped if there are no volunteers; Part B then absorbs per-person bias.

---

## Part B: Fine-Tuning for an Individual

Opt-in, and only for sleepers who sync an Apple Watch. Everyone else keeps the Part A model. Reuses the A0 sync, so there is little new plumbing.

### B1: Scoreboard

`biometrics.getReferenceAgreement` runs `agreement.ts` on stored reference nights. The web sleep-stages card and the iOS Health screen show how well each night matched the watch, plus the trend. Sleepers see where they stand before any tuning.

### B2: Per-Sleeper Calibration

- After ≥ 5 reference nights, the pod fits a per-class bias and a temperature (~8 numbers) for that side against the watch's labels, treating labels as soft and skipping ±1 epoch around each watch stage change.
- Every fifth night is held out; the correction is kept only if held-out agreement improves.
- Stored per side together with the shared-model version. It refits automatically when the model version changes, and Settings has a reset.
- Runs on the pod in seconds.

### B3: Per-Sleeper Final Layer (only if B2 plateaus)

With ~20+ reference nights on a side, retrain the model's output layer with a penalty toward the shared weights. Same held-out guard as B2.

---

## Not in This Plan

| Idea | Why not |
|---|---|
| Apple Watch app (`CMSensorRecorder` movement) | The pod has its own movement sensor, and model inputs must come from the pod so it works on nights without the watch. |
| Training on the iPhone (MLX, Core ML) | Per-sleeper fits are small enough for the pod. Core ML's on-device training can't update GRU layers anyway. |
| Deep per-sleeper fine-tuning (LoRA etc.) | Too little data per sleeper; risks learning the watch's own errors. |
| EEG headband reference | Decided against; watch agreement is the target. |
| XML export from Apple Health | Replaced by the in-app HealthKit sync (A0.1). |

## Risks

- **Overfitting to one sleeper** (A2, A6): prefer changes that generalize; A6's multi-sleeper gate.
- **Watch label noise:** soft labels, skip epochs at watch stage changes, compare pooled over many nights.
- **Movement sensor mismatch:** MESA's wrist actigraphy is not the pod's capacitive sensor; A4 trains with and without movement.
- **Pod generations:** Pod 3/4/5 sensors differ; record `pod_model` per reference night and report metrics per model.
- **Bed partners:** cross-talk between sides is a real error source; include two-sleeper nights.
- **Sparse watch heart data:** a reading every few minutes plus a few beat segments per night; beat timing is judged on samples.
- **Raw retention:** keep-list cap; run `replay fetch` regularly.
- **NSRR terms:** commercial-use limits; see open questions on redistributing weights.

## Open Questions

- Target thresholds, once the baseline exists.
- Can NSRR-trained weights ship in an AGPL repo? SleepECG publishes MESA-trained weights, which suggests yes; confirm with NSRR.
- Drop age/sex entirely if A4's no-demographics variant is within noise?
- Volunteer protocol: where results are posted (Discord, a GitHub issue), and how many sleepers A6 needs.
- Should the B1 scoreboard be visible to everyone who syncs, or behind a developer toggle?
- Where per-sleeper calibration lives: a `side_settings` column or its own table.

## References

- SleepECG: [repository](https://github.com/cbrnr/sleepecg), [classifiers and reported accuracy](https://sleepecg.readthedocs.io/en/stable/classification/), [datasets](https://sleepecg.readthedocs.io/en/stable/datasets/)
- NSRR: [overview and cohort table (2024)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11236948/), [data security and access](https://sleepdata.org/about/data-security), [download tool](https://github.com/nsrr/nsrr-gem)
- Apple Watch vs. PSG: [six wearables compared](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12038347/), [Apple Watch validation](https://pubmed.ncbi.nlm.nih.gov/38083143/), [Apple's sleep-staging paper (Oct 2025)](https://www.apple.com/health/pdf/Estimating_Sleep_Stages_from_Apple_Watch_Oct_2025.pdf)
- Heart and breathing staging: [Sun et al. 2020](https://academic.oup.com/sleep/article/43/7/zsz306/5682785), [Sridhar et al. 2020](https://www.nature.com/articles/s41746-020-0291-x), [non-EEG staging decomposition (2026)](https://arxiv.org/abs/2607.19441)
- Under-mattress validation: [Withings, > 400 nights](https://pmc.ncbi.nlm.nih.gov/articles/PMC12592840/), [under-mattress device, Sleep Medicine 2022](https://www.sciencedirect.com/science/article/pii/S1389945722001368)
- Personalization: [Personalizing sleep staging models](https://arxiv.org/abs/1801.02645), [personalized wrist-PPG staging (2025)](https://pubmed.ncbi.nlm.nih.gov/40882681)
- Open Apple Watch datasets: [BIDSleep](https://physionet.org/content/bidsleep-dataset/1.0.0/), [sleep-accel](https://physionet.org/content/sleep-accel/1.0.0/)

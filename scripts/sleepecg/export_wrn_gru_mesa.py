"""
Export SleepECG's wrn-gru-mesa weights and parity fixtures for the
TypeScript port in src/lib/sleepStaging (dev machine only — never runs on
the pod).

    uv run --python 3.12 --with "sleepecg[full]" python scripts/sleepecg/export_wrn_gru_mesa.py

Writes wrn-gru-mesa.weights.json and wrn-gru-mesa.parity.json to the current
directory; round-trip them into src/lib/sleepStaging/ (weights: floats to 9
significant digits, which is exact for float32) and
src/lib/sleepStaging/tests/fixtures/, then run
`pnpm vitest run src/lib/sleepStaging`.
"""
import datetime, json, math
import numpy as np
from sleepecg import SleepRecord, SubjectData, extract_features, load_classifier
import sleepecg

clf = load_classifier("wrn-gru-mesa", "SleepECG")
m = clf.model
layers = {l.name: l for l in m.layers}

def arr(a): return np.asarray(a, dtype=float).tolist()

def gru(w):
    k, rk, b = w
    return {"kernel": arr(k), "recurrentKernel": arr(rk), "inputBias": arr(b[0]), "recurrentBias": arr(b[1])}

bn = layers["batch_normalization"].get_weights()  # gamma, beta, moving_mean, moving_var
d1 = layers["dense"].get_weights()
b1 = layers["bidirectional"].get_weights()
b2 = layers["bidirectional_1"].get_weights()
d2 = layers["dense_1"].get_weights()
weights = {
    "model": "wrn-gru-mesa",
    "source": f"SleepECG {sleepecg.__version__} (https://github.com/cbrnr/sleepecg), trained on MESA, tested on SHHS",
    "license": "BSD-3-Clause — see SLEEPECG_LICENSE",
    "stagesMode": clf.stages_mode,
    "outputClasses": ["UNDEFINED", "NREM", "REM", "WAKE"],
    "maskValue": clf.mask_value,
    "featureExtraction": clf.feature_extraction_params | {"fs_rri_resample": 4, "sleep_stage_duration": 30},
    "batchNorm": {"gamma": arr(bn[0]), "beta": arr(bn[1]), "movingMean": arr(bn[2]), "movingVar": arr(bn[3]), "epsilon": 0.001},
    "dense": {"kernel": arr(d1[0]), "bias": arr(d1[1])},
    "gru1": {"forward": gru(b1[0:3]), "backward": gru(b1[3:6])},
    "gru2": {"forward": gru(b2[0:3]), "backward": gru(b2[3:6])},
    "output": {"kernel": arr(d2[0]), "bias": arr(d2[1])},
}
json.dump(weights, open("wrn-gru-mesa.weights.json", "w"), separators=(",", ":"))

def night(minutes, seed, gap=None, extra=None, missed=None):
    rng = np.random.default_rng(seed)
    t, times = 5.0, []
    while t < minutes * 60:
        # slow drifts (stage-like), RSA and jitter
        hr = 58 + 6 * math.sin(2 * math.pi * t / 5400) + 3 * math.sin(2 * math.pi * t / 1300)
        ibi = 60 / hr + 0.04 * math.sin(2 * math.pi * 0.25 * t) + rng.normal(0, 0.02)
        t += ibi
        times.append(t)
    times = np.array(times)
    if gap:
        times = times[(times < gap[0]) | (times > gap[1])]
    if extra:
        times = np.sort(np.concatenate([times, [extra]]))
    if missed:
        times = np.delete(times, np.argmin(np.abs(times - missed)))
    return np.round(times, 6)

def enc(x):
    x = float(x)
    if math.isnan(x): return None
    if math.isinf(x): return "inf" if x > 0 else "-inf"
    return x

fixtures = []
for name, minutes, seed, start, subj, kw in [
    ("A", 100, 1, datetime.time(23, 15, 0), SubjectData(age=45, gender=1), dict(gap=(1800, 1850), extra=2400.3, missed=3000)),
    ("B", 60, 2, datetime.time(1, 2, 3), None, dict(gap=(1200, 1440))),
]:
    hb = night(minutes, seed, **kw)
    rec = SleepRecord(heartbeat_times=hb, recording_start_time=start, subject_data=subj)
    feats, _, ids = extract_features([rec], **clf.feature_extraction_params)
    X = feats[0]
    Xm = X.copy(); Xm[~np.isfinite(Xm)] = clf.mask_value
    probs = m.predict(Xm[np.newaxis, ...], verbose=0)[0]
    fixtures.append({
        "name": name,
        "heartbeatTimes": hb.tolist(),
        "recordingStartSec": start.hour * 3600 + start.minute * 60 + start.second,
        "age": subj.age if subj else None,
        "sex": subj.gender if subj else None,
        "numStages": int(hb[-1] // 30),
        "featureIds": ids,
        "features": [[enc(v) for v in row] for row in X],
        "probs": probs.astype(float).tolist(),
    })
json.dump({"generatedBy": f"SleepECG {sleepecg.__version__} + Keras (TensorFlow backend)", "fixtures": fixtures},
          open("wrn-gru-mesa.parity.json", "w"), separators=(",", ":"))
print("ids", ids)
for f in fixtures:
    X = np.array([[np.nan if v is None else (np.inf if v == "inf" else (-np.inf if v == "-inf" else v)) for v in r] for r in f["features"]])
    print(f["name"], "epochs", len(f["features"]), "beats", len(f["heartbeatTimes"]), "nan rows(any)", int(np.isnan(X).any(1).sum()), "inf", int(np.isinf(X).sum()), "argmax counts", np.bincount(np.array(f["probs"]).argmax(1), minlength=4).tolist())

"""
Beat detection, artifact correction and HRV on synthetic ballistocardiograms
with known beat times.

The synthetic BCG uses the classic H-I-J-K-L complex (J dominant), a
respiratory sinus arrhythmia rhythm plus beat-to-beat jitter (RMSSD ~40 ms),
respiration baseline wander and amplitude modulation, and white noise. Scores
are sensitivity / positive predictive value against the true J-peak times
(+-50 ms) and the RMS timing error of matched beats.
"""

import math

import numpy as np
import pytest

import beats as B

FS = B.FS_RAW


# ---------------------------------------------------------------------------
# Synthetic signal
# ---------------------------------------------------------------------------

def _complex(fs=FS):
    """BCG beat complex; J peak at 0.20 s."""
    t = np.arange(int(0.6 * fs)) / fs
    waves = [(0.08, 0.3, 0.015), (0.14, -0.6, 0.02), (0.20, 1.0, 0.022),
             (0.27, -0.7, 0.025), (0.35, 0.25, 0.03)]
    return sum(a * np.exp(-0.5 * ((t - c) / w) ** 2) for c, a, w in waves)


J_OFFSET = 0.20


def beat_times(duration, hr=60.0, rsa_ms=40.0, jitter_ms=20.0, seed=0, start=2.0):
    rng = np.random.default_rng(seed)
    times, t = [], start
    base = 60.0 / hr
    while t < duration - 1.0:
        times.append(t)
        rsa = rsa_ms / 1000 * math.sin(2 * math.pi * 0.25 * t)
        t += base + rsa + rng.normal(0, jitter_ms / 1000)
    return np.array(times)


def bcg(times, duration, amp=1000.0, noise=150.0, seed=1, fs=FS,
        resp_amp=5000.0, delay=0.0, gain=1.0):
    rng = np.random.default_rng(seed)
    n = int(duration * fs)
    tt = np.arange(n) / fs
    x = resp_amp * np.sin(2 * math.pi * 0.25 * tt)
    cplx = _complex(fs)
    for bt in times:
        i0 = int(round((bt + delay - J_OFFSET) * fs))
        if i0 < 0 or i0 + cplx.size > n:
            continue
        mod = 1 + 0.2 * math.sin(2 * math.pi * 0.25 * bt)
        x[i0:i0 + cplx.size] += gain * amp * mod * cplx
    return x + rng.normal(0, noise, n)


def interference(duration, freq=1.07, amp=900.0, fs=FS):
    """In-band periodic vibration both sides see (e.g. a pump beat)."""
    tt = np.arange(int(duration * fs)) / fs
    return amp * np.sin(2 * math.pi * freq * tt) * (1 + 0.3 * np.sin(2 * math.pi * 0.05 * tt))


def run_tracker(own1, own2=None, ref1=None, ref2=None, t0=1_700_000_000.0):
    """Stream 1-second records through a tracker; return committed beat times
    (absolute) and all chunks."""
    tr = B.BeatTracker("left")
    n = own1.size
    chunks = []
    for i in range(0, n - FS + 1, FS):
        sl = slice(i, i + FS)
        tr.push(t0 + i / FS, own1[sl],
                None if own2 is None else own2[sl],
                None if ref1 is None else ref1[sl],
                None if ref2 is None else ref2[sl])
        chunks.extend(tr.take_chunks())
    chunks.extend(tr.take_chunks(flush_before=float("inf")))
    detected = []
    for c in chunks:
        detected.extend(c.start + b / 1000 for b in c.beats if b is not None)
    return tr, np.array(sorted(detected)) - t0, chunks


def anchor_offset(truth, detected):
    """The detector reports a fixed point of the (filtered) beat complex,
    not necessarily the J peak: a constant offset, irrelevant to intervals.
    Estimated as the median nearest-beat difference."""
    if detected.size == 0:
        return 0.0
    near = [detected[np.argmin(np.abs(detected - t))] - t for t in truth]
    return float(np.median(near))


def score(truth, detected, lo, hi, tol=0.05):
    """Sensitivity, PPV and RMS timing error inside [lo, hi), after removing
    the constant anchor offset."""
    off = anchor_offset(truth[(truth >= lo) & (truth < hi)], detected)
    assert abs(off) < 0.15, f"anchor offset {off:.3f}s"
    detected = detected - off
    truth = truth[(truth >= lo) & (truth < hi)]
    det = detected[(detected >= lo) & (detected < hi)]
    used = np.zeros(det.size, dtype=bool)
    errs = []
    for t in truth:
        if det.size == 0:
            break
        j = int(np.argmin(np.abs(det - t)))
        if not used[j] and abs(det[j] - t) <= tol:
            used[j] = True
            errs.append(det[j] - t)
    tp = len(errs)
    sens = tp / max(1, truth.size)
    ppv = tp / max(1, det.size)
    rms = float(np.sqrt(np.mean(np.square(errs)))) if errs else float("inf")
    return sens, ppv, rms


DUR = 180.0
EVAL = (15.0, DUR - 15.0)


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

class TestDetection:
    def test_clean_signal_finds_every_beat_precisely(self):
        truth = beat_times(DUR)
        _, det, _ = run_tracker(bcg(truth, DUR))
        sens, ppv, rms = score(truth, det, *EVAL)
        # Cleaning may break a run at a noisy beat, so allow a few misses.
        assert sens >= 0.97 and ppv >= 0.99
        assert rms < 0.005

    @pytest.mark.parametrize("seeds,burst", [((31, 32), False), ((33, 34), True)])
    def test_anchor_is_stable_across_windows(self, seeds, burst):
        # HRV depends on every beat being timed at the same point of the
        # complex across the 5 s windows. Without anchor continuity, seed
        # 33/34 flipped from the K trough to the J peak (78 ms) after a
        # movement burst — one bad interval that passes the 20% rule.
        truth = beat_times(DUR, seed=seeds[0])
        x = bcg(truth, DUR, seed=seeds[1])
        if burst:
            x[int(90 * FS):int(94 * FS)] += np.random.default_rng(35).normal(0, 20000, 4 * FS)
        _, det, _ = run_tracker(x)
        off = anchor_offset(truth, det)
        per_10s = [anchor_offset(truth[(truth >= m) & (truth < m + 10)], det)
                   for m in range(20, int(DUR) - 20, 10)]
        assert all(abs(o - off) < 0.008 for o in per_10s)

    @pytest.mark.parametrize("hr", [45, 60, 80, 100])
    def test_heart_rate_range(self, hr):
        truth = beat_times(DUR, hr=hr, rsa_ms=25, jitter_ms=10, seed=hr)
        _, det, _ = run_tracker(bcg(truth, DUR, seed=hr + 1))
        sens, ppv, _ = score(truth, det, *EVAL)
        assert sens >= 0.95 and ppv >= 0.98

    def test_movement_burst_does_not_invent_intervals(self):
        # Turning over: a few seconds of large broadband motion. Beats there
        # may be lost, but no false interval may survive cleaning.
        truth = beat_times(DUR, seed=33)
        x = bcg(truth, DUR, seed=34)
        rng = np.random.default_rng(35)
        x[int(90 * FS):int(94 * FS)] += rng.normal(0, 20000, 4 * FS)
        _, det, chunks = run_tracker(x)
        sens, ppv, _ = score(truth, det, *EVAL)
        assert ppv >= 0.98 and sens >= 0.85
        seq = [None if b is None else c.start + b / 1000 for c in chunks for b in c.beats]
        runs, cur = [], []
        for v in seq:
            if v is None:
                runs.append(cur)
                cur = []
            else:
                cur.append(v)
        runs.append(cur)
        for run in runs:
            for a, b in zip(run, run[1:]):
                assert 0.75 <= b - a <= 1.3  # true IBIs are ~1.0 +- 0.06 s

    def test_large_dc_offset_like_real_channels(self):
        truth = beat_times(DUR, seed=36)
        x = bcg(truth, DUR, seed=37) - 2_350_000   # channel-2 style offset
        _, det, _ = run_tracker(x)
        sens, ppv, _ = score(truth, det, *EVAL)
        assert sens >= 0.97 and ppv >= 0.99

    def test_empty_bed_yields_no_beats(self):
        rng = np.random.default_rng(3)
        noise = rng.normal(0, 150, int(DUR * FS)) + 5000 * np.sin(
            2 * math.pi * 0.25 * np.arange(int(DUR * FS)) / FS)
        _, det, _ = run_tracker(noise)
        assert det.size <= 5  # vs ~150 real beats


class TestTwoChannels:
    def test_noisy_first_channel_is_rescued_by_the_second(self):
        truth = beat_times(DUR, seed=5)
        ch1 = bcg(truth, DUR, noise=900, seed=6)                     # poor
        ch2 = bcg(truth, DUR, noise=120, seed=7, gain=-0.6, delay=0.02)  # inverted, clean
        _, alone, _ = run_tracker(ch1)
        _, both, _ = run_tracker(ch1, ch2)
        s_alone = score(truth, alone, *EVAL)
        s_both = score(truth, both, *EVAL)
        assert s_both[0] >= 0.95 and s_both[1] >= 0.98
        assert s_both[0] > s_alone[0]

    def test_combination_never_worse_than_the_good_channel(self):
        truth = beat_times(DUR, seed=8)
        good = bcg(truth, DUR, noise=100, seed=9)
        junk = np.random.default_rng(10).normal(0, 3000, good.size)  # unrelated
        _, one, _ = run_tracker(good)
        _, both, _ = run_tracker(good, junk)
        assert score(truth, both, *EVAL)[0] >= score(truth, one, *EVAL)[0] - 0.01

    def test_combined_signal_uses_aligned_polarity(self):
        truth = beat_times(60, seed=11)
        a = B.bandpass_decimate(bcg(truth, 60, noise=100, seed=12))
        b = B.bandpass_decimate(bcg(truth, 60, noise=100, seed=13, gain=-1.0, delay=0.03))
        comb = B.combine_channels(a, b)
        assert len(comb.aligned) == 2
        z1, z2 = comb.aligned[0][0], comb.aligned[1][0]
        assert np.corrcoef(z1, z2)[0, 1] > 0.8  # inverted + delayed, now aligned
        assert comb.quality >= max(q for _, q in comb.aligned)


class TestOtherSideReference:
    def test_common_interference_is_removed(self):
        truth = beat_times(DUR, seed=14)
        common = interference(DUR)
        primary = bcg(truth, DUR, noise=150, seed=15) + common
        rng = np.random.default_rng(16)
        ref = 0.8 * np.roll(common, 3) + rng.normal(0, 100, common.size)
        _, without, _ = run_tracker(primary)
        _, with_ref, _ = run_tracker(primary, None, ref)
        s0 = score(truth, without, *EVAL)
        s1 = score(truth, with_ref, *EVAL)
        assert s1[0] >= 0.95 and s1[1] >= 0.98
        assert s1[0] >= s0[0]

    @pytest.mark.parametrize("leak", [0.15, 0.5])
    def test_own_heartbeat_leaking_to_the_other_side_is_not_cancelled(self, leak):
        # Sleeping alone: the empty side picks up this sleeper's heartbeat.
        # Subtracting it would erase the beats; the verification must refuse.
        truth = beat_times(DUR, seed=17)
        primary = bcg(truth, DUR, noise=150, seed=18)
        ref = bcg(truth, DUR, noise=60, seed=19, gain=leak, delay=0.01, resp_amp=0)
        _, det, _ = run_tracker(primary, None, ref)
        sens, ppv, _ = score(truth, det, *EVAL)
        assert sens >= 0.95 and ppv >= 0.98

    def test_cancel_common_noise_removes_predictable_part(self):
        rng = np.random.default_rng(20)
        ref = rng.normal(0, 1, 2000)
        target = rng.normal(0, 0.1, 2000)
        primary = target + 0.7 * B._shift(ref, 2)
        cleaned = B.cancel_common_noise(primary, [ref])
        assert np.std(cleaned - target) < 0.03


class TestPeriodicity:
    def test_period_is_the_fundamental_not_a_multiple(self):
        truth = beat_times(30, hr=72, rsa_ms=0, jitter_ms=0, seed=21)
        x = B.bandpass_decimate(bcg(truth, 30, noise=50, seed=22))
        q, period = B.periodicity(x)
        assert q > 0.5
        assert period == pytest.approx(60 / 72, rel=0.03)

    def test_flat_signal_has_no_rhythm(self):
        assert B.periodicity(np.zeros(2000)) == (0.0, 0.0)


# ---------------------------------------------------------------------------
# Artifact correction
# ---------------------------------------------------------------------------

def _clean(times):
    c = B.BeatCleaner()
    out = []
    for t in times:
        out.extend(c.push(None if t is None else (t, 1.0)))
    return [None if o is None else round(o[0], 3) for o in out]


class TestBeatCleaner:
    def _regular(self, n, start=0.0, ibi=1.0):
        return [start + i * ibi for i in range(n)]

    def test_regular_rhythm_passes_unchanged(self):
        ts = self._regular(12)
        assert _clean(ts) == ts

    def test_extra_beat_is_removed_without_a_break(self):
        ts = self._regular(10) + [9.4] + self._regular(4, start=10.0)
        ts = sorted(ts)
        out = _clean(ts)
        assert 9.4 not in out
        assert None not in out
        assert out[-1] == 13.0

    def test_missed_beat_becomes_a_break_not_an_invented_beat(self):
        ts = self._regular(10) + self._regular(5, start=11.0)  # 10.0 missing
        out = _clean(ts)
        assert out == self._regular(10) + [None] + self._regular(5, start=11.0)

    def test_ectopic_beat_breaks_the_run(self):
        # Premature beat followed by a compensatory pause: neither interval
        # is trustworthy, and the pair doesn't sum to a normal interval.
        ts = self._regular(10) + [9.6, 11.0, 12.0, 13.0]
        out = _clean(ts)
        assert None in out
        # No reported interval deviates from 1 s by more than 20%.
        runs, cur = [], []
        for o in out:
            if o is None:
                runs.append(cur)
                cur = []
            else:
                cur.append(o)
        runs.append(cur)
        for run in runs:
            for a, b in zip(run, run[1:]):
                assert abs((b - a) - 1.0) <= 0.2 + 1e-9

    def test_sustained_rate_change_is_adopted(self):
        ts = self._regular(10, ibi=1.0) + self._regular(10, start=9.7, ibi=0.7)
        out = _clean(ts)
        tail = [o for o in out[-5:] if o is not None]
        assert len(tail) == 5 and all(abs((b - a) - 0.7) < 1e-6 for a, b in zip(tail, tail[1:]))

    def test_explicit_break_is_passed_through(self):
        out = _clean(self._regular(6) + [None] + self._regular(6, start=100.0))
        assert out[6] is None and out[7] == 100.0


# ---------------------------------------------------------------------------
# HRV and chunks
# ---------------------------------------------------------------------------

class TestBeatHistory:
    def test_rmssd_matches_ground_truth(self):
        truth = beat_times(360, seed=23)
        _, det, _ = run_tracker(bcg(truth, 360, seed=24))
        tr, _, _ = run_tracker(bcg(truth, 360, seed=24))
        rmssd = tr.history.rmssd_ms()
        window = truth[truth >= truth[-1] - 300 - 15]
        true_rmssd = 1000 * np.sqrt(np.mean(np.diff(np.diff(window)) ** 2))
        assert rmssd == pytest.approx(true_rmssd, rel=0.12)

    def test_heart_rate_matches_ground_truth(self):
        truth = beat_times(200, hr=58, seed=25)
        tr, _, _ = run_tracker(bcg(truth, 200, seed=26))
        assert tr.history.heart_rate() == pytest.approx(58, abs=2)

    def test_no_difference_across_a_break(self):
        h = B.BeatHistory()
        items = [(float(i), 1.0) for i in range(40)] + [None] + [(40.5 + i * 0.5, 1.0) for i in range(60)]
        h.extend(items)
        # Intervals are 1.0 then 0.5; a difference across the break would be 0.5 s.
        assert h.rmssd_ms(window_s=300, min_coverage=0.1, min_diffs=5) == pytest.approx(0.0, abs=1e-6)

    def test_insufficient_coverage_gives_no_value(self):
        h = B.BeatHistory()
        h.extend([(float(i), 1.0) for i in range(30)])
        assert h.rmssd_ms() is None           # 30 s of beats in a 300 s window
        assert h.heart_rate(window_s=60) is None


class TestChunks:
    def test_minute_chunks_hold_ms_offsets(self):
        truth = beat_times(200, seed=27)
        _, det, chunks = run_tracker(bcg(truth, 200, seed=28))
        assert chunks and all(c.start % 60 == 0 for c in chunks)
        for c in chunks:
            offs = [b for b in c.beats if b is not None]
            assert offs == sorted(offs) and all(0 <= b < 60_000 for b in offs)
            assert 0 < c.quality <= 1
        starts = [c.start for c in chunks]
        assert len(starts) == len(set(starts))

    def test_signal_gap_leaves_a_break_between_the_beats_around_it(self):
        truth = beat_times(240, seed=29)
        x = bcg(truth, 240, seed=30)
        tr = B.BeatTracker("left")
        t0 = 1_700_000_000.0
        chunks = []
        for i in range(0, 120 * FS, FS):
            tr.push(t0 + i / FS, x[i:i + FS], None, None, None)
            chunks.extend(tr.take_chunks())
        # 30 s of dropped records, then data resumes.
        for i in range(150 * FS, 240 * FS - FS + 1, FS):
            tr.push(t0 + i / FS, x[i:i + FS], None, None, None)
            chunks.extend(tr.take_chunks())
        chunks.extend(tr.take_chunks(flush_before=float("inf")))
        seq = [None if b is None else c.start + b / 1000 for c in chunks for b in c.beats]
        last_before = max(i for i, v in enumerate(seq) if v is not None and v < t0 + 120)
        first_after = min(i for i, v in enumerate(seq) if v is not None and v > t0 + 150)
        assert None in seq[last_before + 1:first_after]

    def test_break_at_a_minute_edge_opens_the_next_chunk(self):
        tr = B.BeatTracker("left")
        tr._emit([(60.0 + i, 1.0) for i in range(50)])      # minute 60
        tr._emit([None])
        tr._emit([(125.0 + i, 1.0) for i in range(10)])     # minute 120
        chunks = tr.take_chunks(flush_before=float("inf"))
        assert [c.start for c in chunks] == [60, 120]
        assert chunks[0].beats[-1] is not None
        assert chunks[1].beats[0] is None

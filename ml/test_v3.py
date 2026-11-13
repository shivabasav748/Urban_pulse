"""Invariant tests for the synthetic v3 generator and training features. Run: python -m pytest ml/test_v3.py -q
(or python ml/test_v3.py). Uses a 21-day slice of the generator for speed where the full year is not needed."""
import hashlib
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_v3 as g  # noqa: E402
import train_v3 as t  # noqa: E402


def small(seed=g.SEED, days=21):
    old = g.DAYS
    g.DAYS = days
    try:
        return g.generate(seed)
    finally:
        g.DAYS = old


def test_shape_and_provenance():
    df = small()
    assert len(df) == 21 * 8 * 48
    assert df.synthetic.all() and (df.dataset_version == g.VERSION).all() and (df.seed == g.SEED).all()
    assert df.groupby(["zone_id", "ts"]).size().max() == 1, "one row per zone and bucket"
    assert (df.demand >= 0).all() and (df.expected_lambda > 0).all()


def test_deterministic_and_seed_sensitive():
    h = lambda d: hashlib.sha256(d[["zone_id", "ts", "demand"]].to_csv(index=False).encode()).hexdigest()
    assert h(small()) == h(small())
    assert h(small()) != h(small(seed=7))


def test_temporal_correlation_and_profiles():
    df = small(days=60)
    z = df[df.zone_id == 3].sort_values("ts")
    r = np.corrcoef(z.expected_lambda.values[1:], z.expected_lambda.values[:-1])[0, 1]
    assert r > 0.8, f"adjacent buckets must be correlated, got {r:.2f}"
    wk = df[(df.zone_id == 5) & (df.weekend == 0) & (df.holiday == 0) & (df.festival == 0)]
    we = df[(df.zone_id == 5) & (df.weekend == 1)]
    assert wk.demand.mean() > we.demand.mean(), "industrial zone busier on workdays"
    night = df[df.bucket.isin([4, 5, 6])].demand.mean(); evening = df[df.bucket.isin([36, 37, 38])].demand.mean()
    assert evening > 2 * night


def test_scenarios_raise_demand():
    df = small(days=120)
    ev = df[(df.zone_id == 7) & (df.scheduled_event == 1)]
    base = df[(df.zone_id == 7) & (df.bucket.isin(ev.bucket.unique())) & (df.scheduled_event == 0)]
    if len(ev):
        assert ev.expected_lambda.mean() > 2 * base.expected_lambda.mean()


def test_od_matrix_rows_sum_to_one():
    od = g.od_matrix()
    s = od.groupby(["time_block", "origin_zone"]).share.sum()
    assert np.allclose(s, 1, atol=1e-3) and len(od) == 4 * 8 * 8


def test_features_use_only_the_past():
    df = small(days=40)
    f = t.features(df.copy()).sort_values(["zone_id", "ts"])
    z = f[f.zone_id == 1].reset_index(drop=True)
    assert z.loc[400, "lag1"] == z.loc[399, "demand"] and z.loc[400, "lag336"] == z.loc[64, "demand"]
    assert abs(z.loc[400, "roll4"] - z.loc[396:399, "demand"].mean()) < 1e-9
    # zone boundary: first rows of zone 2 must not borrow zone 1 values
    z2 = f[f.zone_id == 2].reset_index(drop=True)
    assert pd.isna(z2.loc[0, "lag1"]) and pd.isna(z2.loc[2, "roll4"])


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("PASS", name)

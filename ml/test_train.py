"""Self-check: python ml/test_train.py (run after ml/train.py has written ml/metrics.json)."""
import json
import sys
from pathlib import Path

import numpy as np
from sklearn.metrics import mean_absolute_error

sys.path.insert(0, str(Path(__file__).parent))
import train as t

assert "incident" not in t.FEATS, "random incidents must not be a model feature"
raw = t.generate(np.random.default_rng(t.SEED))
assert raw["demand"].equals(t.generate(np.random.default_rng(t.SEED))["demand"]), "generation not deterministic"
assert (raw["scheduled_event"] <= raw["incident"]).all() and raw["scheduled_event"].sum() < raw["incident"].sum()

tr, te, model, pred = t.fit(t.features(raw))
assert tr.day.max() < te.day.min(), "train/test overlap"
m = json.loads((t.ROOT / "ml" / "metrics.json").read_text())
assert m["model_version"] == t.VERSION and m["features"] == t.FEATS
assert m["mae"] == round(mean_absolute_error(te["demand"], pred), 4), "MAE mismatch"
assert m["baseline_mae"] == round(mean_absolute_error(te["demand"], te["lag336"]), 4), "baseline MAE mismatch"
assert (m["train_rows"], m["test_rows"]) == (len(tr), len(te))
print("ok: no incident feature, no split overlap, deterministic demand, metrics reproduce")

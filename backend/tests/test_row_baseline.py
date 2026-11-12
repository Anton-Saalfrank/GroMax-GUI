"""
A per-residue baseline measured across conditions.

THE POINT. Normalising each map by its OWN row medians removes what dominates a
rolling-RMSF map — some residues are simply floppier — but it also removes the
comparison between conditions, because each map is divided by its own numbers.
A mutant uniformly twice as mobile normalises to 1.0 in both arms and the
difference vanishes. Dividing BOTH by the SAME baseline keeps both properties.
Test 2 is exactly that: a planted 2x difference must survive.

Test 4 covers the balance rule. Within a condition replicas are pooled, because
more sampling is more evidence about that condition. ACROSS conditions the
median of per-condition medians is taken, so an arm with ten replicas cannot
drag the shared baseline — and every map with it — towards itself.

Test 5 is the refusal that matters: two results covering different residues
would line up row N of one against a different residue of the other, silently.
"""
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from fastapi import HTTPException

from core.config import settings

TMP = Path(tempfile.mkdtemp())
settings.projects_dir = TMP / "projects"

import core.session as S
import core.derived as AR
from core.gmx import save_cached_result

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


SID = S.create_session(S.CreateSessionRequest(name="baseline")).id


def store(key, name, mats, residues=None):
    """Save a heatmap result with per-replica matrices, as the runner does."""
    idx = list(range(1, len(mats) + 1))
    agg = {"kind": "heatmap", "z": [list(map(float, r)) for r in mats[0]],
           "condition_id": key, "condition_name": name, "colour": "#4f8ef7",
           "analysis_name": name, "zlabel": "RMSF (nm)",
           "replica_indices": idx, "replica_cache_prefix": key,
           "time_x": True}
    if residues is not None:
        agg["residues"] = residues
    save_cached_result(SID, key, agg)
    for i, m in zip(idx, mats):
        save_cached_result(SID, f"{key}__rep{i}",
                           {"kind": "heatmap", "index": i,
                            "z": [list(map(float, r)) for r in m]})
    return key


def ask(keys):
    return AR.row_baseline(AR.RowBaselineRequest(session_id=SID, cache_keys=keys))


# Three residues with very different normal flexibility, 40 windows each.
BASE = np.array([0.05, 0.30, 1.20])
rng = np.random.default_rng(0)


def matrix(scale=1.0, n=40, jitter=0.02):
    return (BASE[:, None] * scale
            + rng.normal(0, jitter, size=(3, n)) * BASE[:, None])


print("1. the baseline is each residue's own typical value")
wt = store("wt", "WT", [matrix(), matrix(), matrix()])
res = ask([wt])
got = np.array(res["shared"]["median"])
check("three residues reported", res["n_rows"] == 3)
check("each baseline matches what was planted",
      np.allclose(got, BASE, rtol=0.06), f"{np.round(got, 3)} vs {BASE}")
check("replicas were pooled, not just the first read",
      res["per_condition"][0]["n_replicas"] == 3)
check("and all their windows used",
      res["per_condition"][0]["n_windows"] == 120,
      res["per_condition"][0]["n_windows"])

print("\n2. a 2x difference between conditions SURVIVES the shared baseline")
mut = store("mut", "Y269C", [matrix(2.0), matrix(2.0), matrix(2.0)])
res = ask([wt, mut])
shared = np.array(res["shared"]["median"])
wt_med = np.array(res["per_condition"][0]["median"])
mut_med = np.array(res["per_condition"][1]["median"])
check("the mutant's own medians really are ~2x the WT's",
      np.allclose(mut_med / wt_med, 2.0, rtol=0.06),
      f"{np.round(mut_med / wt_med, 2)}")
# This is the whole purpose: normalised by the SHARED baseline the two arms
# land on different numbers, where own-baseline normalisation puts both on 1.
check("against the shared baseline WT sits below 1 and the mutant above",
      np.all(wt_med / shared < 0.8) and np.all(mut_med / shared > 1.2),
      f"WT {np.round(wt_med / shared, 2)}, mutant {np.round(mut_med / shared, 2)}")
check("whereas own-baseline normalisation would put BOTH at exactly 1.0",
      np.allclose(wt_med / wt_med, 1.0) and np.allclose(mut_med / mut_med, 1.0),
      "which is why this endpoint exists")

print("\n3. flat residues still sit on a common footing")
# The rigid residue and the floppy one differ 24-fold in absolute terms; after
# dividing by the shared baseline they are the same number.
ratio = mut_med / shared
check("a 24x spread in absolute flexibility becomes one scale",
      float(ratio.max() / ratio.min()) < 1.1,
      f"absolute {BASE.max() / BASE.min():.0f}x -> normalised "
      f"{ratio.max() / ratio.min():.2f}x")

print("\n4. one heavily-sampled arm cannot drag the shared baseline")
big = store("big", "Big", [matrix(4.0) for _ in range(10)])
small = store("small", "Small", [matrix(1.0)])
res = ask([big, small])
shared2 = np.array(res["shared"]["median"])
expect = (BASE * 4.0 + BASE * 1.0) / 2          # midpoint of the two conditions
check("10 replicas vs 1 still weigh equally",
      np.allclose(shared2, expect, rtol=0.06),
      f"{np.round(shared2, 3)} vs balanced {np.round(expect, 3)}")
pooled = np.median(np.concatenate(
    [np.repeat(BASE[:, None] * 4.0, 10, axis=1),
     BASE[:, None] * 1.0], axis=1), axis=1)
check("a naive pool over replicas would have been dragged to the big arm",
      not np.allclose(pooled, expect, rtol=0.06),
      f"naive {np.round(pooled, 3)}")

print("\n5. results covering different residues are refused")
short = store("short", "Fewer residues", [np.ones((2, 40))])
try:
    ask([wt, short])
    check("a residue-count mismatch is refused", False, "it was accepted")
except HTTPException as e:
    check("a residue-count mismatch is refused", e.status_code == 400)
    check("and the message names both counts",
          "3" in str(e.detail) and "2" in str(e.detail),
          str(e.detail)[:96])

print("\n6. missing or wrong-kind results degrade, they do not crash")
line_key = "aline"
save_cached_result(SID, line_key, {"kind": "line", "x": [0], "y": [1],
                                   "analysis_name": "a line"})
res = ask([wt, line_key, "nonexistent"])
check("the usable one still answers", res["n_conditions"] == 1)
check("and the others are explained", len(res["warnings"]) == 2, res["warnings"])
try:
    ask([line_key])
    check("asking for only unusable results is an error", False, "it was accepted")
except HTTPException as e:
    check("asking for only unusable results is an error", e.status_code == 400,
          str(e.detail)[:80])

print("\n7. MAD comes back too, for a robust-z view")
res = ask([wt, mut])
mads = np.array(res["shared"]["mad"])
check("a spread is reported per residue", np.all(np.isfinite(mads)) and np.all(mads > 0),
      np.round(mads, 4))
check("and it scales with the residue, like the median does",
      mads[2] > mads[0], f"{mads[0]:.4f} (rigid) vs {mads[2]:.4f} (floppy)")

import shutil
shutil.rmtree(TMP, ignore_errors=True)
print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

"""Matrix distribution: the triangle, the exactness of the stats, the refusals."""
import shutil, sys, tempfile, warnings, datetime as dt
from pathlib import Path
warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import core.session as sm
SBOX = Path(tempfile.mkdtemp()); sm.SESSIONS_DIR = SBOX
from fastapi import HTTPException
from core.gmx import save_cached_result
from core.derived import matrix_distribution, MatrixDistributionRequest

fails = 0
def check(n, ok, d=''):
    global fails
    ok = bool(ok)
    if not ok: fails += 1
    print(f"  {'ok  ' if ok else 'FAIL'}  {n}{('  — ' + str(d)) if str(d) else ''}")

SID = "md-test"; (SBOX / SID / "cache").mkdir(parents=True, exist_ok=True)
now = dt.datetime.now().isoformat()
sm.save_state(sm.SessionState(id=SID, name="md", created_at=now, updated_at=now))

rng = np.random.default_rng(3)
N = 60
def sym(scale):
    a = rng.random((N, N)) * scale
    m = (a + a.T) / 2
    np.fill_diagonal(m, 0.0)
    return m

M1, M2 = sym(1.0), sym(2.0)
save_cached_result(SID, "k", {
    "kind": "heatmap", "z": M1.tolist(), "x": list(range(N)), "y": list(range(N)),
    "zlabel": "RMSD (nm)", "condition_id": "c1", "condition_name": "WT",
    "colour": "#4f8ef7", "analysis_name": "rmsd2d core",
    "replica_indices": [1, 2], "replica_cache_prefix": "k"})
save_cached_result(SID, "k__rep2", {"kind": "heatmap", "z": M2.tolist()})
save_cached_result(SID, "line", {"kind": "line", "x": [0], "y": [1]})

r = matrix_distribution(MatrixDistributionRequest(session_id=SID, cache_key="k"))

print("1. the upper triangle only")
iu = np.triu_indices(N, k=1)
expect_n = len(iu[0])
check("n_pairs is N(N-1)/2, not N^2", r["replicas"][0]["n_pairs"] == expect_n,
      f"{r['replicas'][0]['n_pairs']} vs N^2={N*N}")
check("  so the zero diagonal is excluded", r["replicas"][0]["min"] > 0,
      f"min {r['replicas'][0]['min']:.4f}")
exact_mean = float(M1[iu].mean())
check("the mean matches an exact upper-triangle mean",
      abs(r["replicas"][0]["mean"] - exact_mean) < 1e-12,
      f"{r['replicas'][0]['mean']:.9f} vs {exact_mean:.9f}")
check("  and is NOT the whole-matrix mean (which the diagonal drags down)",
      abs(r["replicas"][0]["mean"] - float(M1.mean())) > 1e-4,
      f"whole-matrix mean would be {float(M1.mean()):.4f}")

print("\n2. statistics are exact, only the outline is sampled")
small = matrix_distribution(MatrixDistributionRequest(
    session_id=SID, cache_key="k", max_points=200))
check("the sample is capped", len(small["replicas"][0]["sample"]) == 200,
      len(small["replicas"][0]["sample"]))
check("  and flagged as sampled", small["replicas"][0]["sampled"] is True)
check("  but the mean is unchanged by the cap",
      abs(small["replicas"][0]["mean"] - r["replicas"][0]["mean"]) < 1e-12)
check("  and the note says so", "subsample" in small["note"], small["note"][:52])
check("sampling is deterministic across calls",
      small["replicas"][0]["sample"] == matrix_distribution(
          MatrixDistributionRequest(session_id=SID, cache_key="k",
                                    max_points=200))["replicas"][0]["sample"])

print("\n3. every replica is summarised")
check("both replicas present", [x["index"] for x in r["replicas"]] == [1, 2])
check("replica 2 is scaled up ~2x as built",
      1.8 < r["replicas"][1]["mean"] / r["replicas"][0]["mean"] < 2.2,
      f"{r['replicas'][1]['mean'] / r['replicas'][0]['mean']:.3f}x")
check("quantiles are ordered",
      all(x["p5"] <= x["p25"] <= x["median"] <= x["p75"] <= x["p95"]
          for x in r["replicas"]))
check("the z label travels with it", r["zlabel"] == "RMSD (nm)", r["zlabel"])

print("\n4. a missing replica is reported, not silently dropped")
save_cached_result(SID, "k2", {
    "kind": "heatmap", "z": M1.tolist(), "x": list(range(N)), "y": list(range(N)),
    "replica_indices": [1, 2, 3], "replica_cache_prefix": "k2"})
r2 = matrix_distribution(MatrixDistributionRequest(session_id=SID, cache_key="k2"))
check("replicas without a stored matrix are listed", r2["skipped_replicas"] == [2, 3],
      r2["skipped_replicas"])
check("  and the ones that exist are still summarised", len(r2["replicas"]) == 1)

print("\n5. refusals")
for kw, expect, code in [
    (dict(cache_key="nope"), "no longer cached", 404),
    (dict(cache_key="line"), "needs a matrix", 400),
]:
    try:
        matrix_distribution(MatrixDistributionRequest(session_id=SID, **kw))
        check(f"{kw} refused", False, "ACCEPTED")
    except HTTPException as e:
        check(f"{kw} refused", expect in e.detail and e.status_code == code,
              f"{e.status_code}: {e.detail[:44]}")

shutil.rmtree(SBOX, ignore_errors=True)
print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

"""
The Results tab and the Compare tab must draw the SAME error band.

Those two bands are computed by different code in different languages: the
Results tab plots `_agg_replicas` from this backend, and the Compare tab
recomputes the band in the browser with `recomputeMean` from src/lib/stats.ts
as soon as a replica is excluded. For most of this project's life they
disagreed — one divided by n, the other by n-1 — and nothing anywhere would
have caught it, because each side's own tests agreed with itself.

So this test runs BOTH and diffs the numbers. Asserting separately that each
"uses n-1" would not catch a divergence in truncation, rounding or NaN
handling; running them against identical input and comparing does.

Skipped, loudly, if node or esbuild is unavailable.
"""
import json
import math
import subprocess
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from core.replica_agg import _agg_replicas

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
BUNDLE = Path("/tmp/gromax_band_harness.mjs")

if not ESBUILD.is_file():
    print("  (esbuild not installed — skipping)")
    sys.exit(0)

build = subprocess.run(
    [str(ESBUILD), str(ROOT / "src/lib/__tests__/bandHarness.ts"), "--bundle",
     "--platform=node", "--format=esm", f"--outfile={BUNDLE}",
     "--log-level=warning"],
    capture_output=True, text=True)
if build.returncode != 0:
    print("  esbuild failed:\n" + build.stderr)
    sys.exit(1)


def frontend_band(replicas):
    """The band the Compare tab would draw, from the real TypeScript."""
    payload = json.dumps({"replicas": [{"y": r} for r in replicas]})
    out = subprocess.run([ "node", str(BUNDLE)], input=payload,
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError("node failed: " + out.stderr)
    return json.loads(out.stdout)


def backend_band(replicas):
    """The band the Results tab plots, from this backend."""
    reps = [{"kind": "line", "x": list(range(len(y))), "y": list(y),
             "xlabel": "t", "ylabel": "v", "title": "t", "_rep_index": i + 1}
            for i, y in enumerate(replicas)]
    agg = _agg_replicas(reps)
    return {"mean": agg["y_mean"], "sd": agg["y_sd"]}


def same(a, b, tol=1e-9):
    if len(a) != len(b):
        return False
    return all(abs(x - y) <= tol * max(1.0, abs(x), abs(y)) for x, y in zip(a, b))


CASES = {
    "three equal-length replicas": [
        [1.0, 2.0, 3.0], [3.0, 4.0, 5.0], [5.0, 6.0, 7.0]],
    "ten replicas, the real replica count here": [
        [i * 0.1 + j * 0.37 for i in range(12)] for j in range(10)],
    "ragged lengths (the mean must stop at the shortest)": [
        [1.0, 2.0, 3.0, 4.0], [2.0, 3.0, 4.0], [9.0, 1.0, 5.0, 2.0, 8.0]],
    "two replicas, the smallest n with a real SD": [
        [0.5, 1.5, 2.5], [2.5, 1.5, 0.5]],
    "one replica, where the sample SD is undefined": [[4.0, 5.0, 6.0]],
    "values that are not round numbers": [
        [0.123456789, 1.987654321], [2.718281828, 3.141592653],
        [1.414213562, 0.577215664]],
    "negative and zero values": [
        [-3.0, 0.0, 3.0], [0.0, 0.0, 0.0], [3.0, 0.0, -3.0]],
}

print("1. the two tabs compute the same band")
for label, reps in CASES.items():
    be, fe = backend_band(reps), frontend_band(reps)
    check(f"mean agrees — {label}", same(be["mean"], fe["mean"]),
          f'{[round(v, 6) for v in be["mean"][:3]]} vs '
          f'{[round(v, 6) for v in fe["mean"][:3]]}')
    check(f"SD agrees — {label}", same(be["sd"], fe["sd"]),
          f'{[round(v, 6) for v in be["sd"][:3]]} vs '
          f'{[round(v, 6) for v in fe["sd"][:3]]}')

print("\n2. and it is the sample SD, not the population one")
# [1,3,5] has mean 3 and squared deviations 4,0,4. Sample sqrt(8/2)=2;
# population sqrt(8/3)=1.63299. The whole point is which one comes back.
be = backend_band([[1.0, 2.0, 3.0], [3.0, 4.0, 5.0], [5.0, 6.0, 7.0]])
check("backend gives sqrt(8/2) = 2", abs(be["sd"][0] - 2.0) < 1e-12,
      f'{be["sd"][0]:.9f}')
check("not sqrt(8/3) = 1.632993",
      abs(be["sd"][0] - math.sqrt(8 / 3)) > 0.3, f'{be["sd"][0]:.6f}')

print("\n3. a divergence would actually be caught")
# Guard against the test passing because both sides are trivially equal: feed
# the comparison a deliberately population-SD band and confirm it fails.
pop = [math.sqrt(8 / 3)] * 3
check("the comparison rejects a population-SD band",
      not same(be["sd"], pop),
      f'{be["sd"][0]:.4f} vs {pop[0]:.4f}')

print("\nALL PASS" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

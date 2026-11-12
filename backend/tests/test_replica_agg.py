"""
Combining replicas: the mean, the spread, and what the payload carries.

This module had almost no coverage while it lived inside a 2152-line
analysis_runner — two assertions in test_parsers. Making it testable was the
stated reason for splitting it out, so here is the test.

Every expected number below is arithmetic done by hand in the comment beside
it, never a second call into the code.

SECTION 4 IS THE INTERESTING ONE. Reading this code closely to test it turned
up a real inconsistency: the aggregated SD here was a POPULATION standard
deviation (statistics.pstdev, dividing by n) while every other spread in the
codebase — stats.ts, plotFilter.ts, derived.py, helix.py — is a SAMPLE standard
deviation (dividing by n-1). The same replicas therefore got a visibly
different error band depending on which tab you looked at: 22% at n=3, 5% at
n=10, with neither chart saying which convention it used.

RESOLVED 2026-11-03: replicas are a sample of the runs that could have been
done, so the sample SD is correct and this line now matches everything else.
Section 4 pins the new convention and states the old one, because figures
exported before that date carry the narrower population band.
"""
import math
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.replica_agg import _agg_replicas, _matrix_stats, _map_matrix_residues

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


def near(a, b, tol=1e-12):
    return a is not None and b is not None and abs(a - b) <= tol


def line(y, x=None, index=None):
    r = {"kind": "line", "x": x if x is not None else list(range(len(y))),
         "y": list(y), "xlabel": "Time (ns)", "ylabel": "RMSD (nm)",
         "title": "t"}
    if index is not None:
        r["_rep_index"] = index
    return r


print("1. three replicas, equal length")
{}
# y columns are [1,3,5], [2,4,6], [3,5,7]  ->  means 3, 4, 5
reps = [line([1, 2, 3], index=1), line([3, 4, 5], index=2), line([5, 6, 7], index=3)]
agg = _agg_replicas(reps)
check("the mean is the element-wise mean",
      agg["y_mean"] == [3.0, 4.0, 5.0], str(agg["y_mean"]))
check("`y` is the mean too, so a plotter needs no special case",
      agg["y"] == agg["y_mean"])
check("n_replicas counts them", agg["n_replicas"] == 3)
check("replica_indices preserves the real run numbers, not 1..n",
      agg["replica_indices"] == [1, 2, 3], str(agg["replica_indices"]))
check("nothing is marked truncated when the lengths agree",
      agg["mean_truncated"] is False and agg["short_replicas"] == [])
check("every replica's own series comes back for per-run plotting",
      [e["index"] for e in agg["replicas"]] == [1, 2, 3]
      and agg["replicas"][1]["y"] == [3, 4, 5])
check("axis labels and title come from the first replica",
      agg["xlabel"] == "Time (ns)" and agg["ylabel"] == "RMSD (nm)")

print("\n2. one replica is not a sample of one, it is a line")
one = _agg_replicas([line([2, 4, 6], index=7)])
# With one run the sample SD is undefined (0/0). 0.0 is what recomputeMean
# returns for the same input, so the two tabs agree here too.
check("one replica gives a zero-width band, as the frontend also does",
      one["y_sd"] == [0.0, 0.0, 0.0], str(one["y_sd"]))
check("and the single run keeps its own index", one["replica_indices"] == [7])
check("nothing at all is an empty dict, not a crash", _agg_replicas([]) == {})

print("\n3. unequal lengths: the mean stops at the shortest, and says so")
# rep3 is two points long, so the mean can only cover indices 0 and 1.
short = [line([1, 2, 3], index=1), line([3, 4, 5], index=2),
         line([5, 6], x=[0, 1], index=3)]
agg = _agg_replicas(short)
check("the mean covers only where EVERY replica has data",
      agg["y_mean"] == [3.0, 4.0], str(agg["y_mean"]))
check("and x is truncated with it", agg["x"] == [0, 1], str(agg["x"]))
check("the truncation is flagged", agg["mean_truncated"] is True)
check("with both lengths reported",
      agg["n_points_mean"] == 2 and agg["n_points_longest"] == 3,
      f'{agg["n_points_mean"]} / {agg["n_points_longest"]}')
check("and the short replica named, so the UI can explain the gap",
      agg["short_replicas"] == [3], str(agg["short_replicas"]))
check("t_end_mean is where the mean really ends",
      agg["t_end_mean"] == 1, str(agg["t_end_mean"]))
check("t_end_longest is where the longest run ends",
      agg["t_end_longest"] == 2, str(agg["t_end_longest"]))
check("the FULL series still come back untruncated — only the mean is cut",
      agg["replicas"][0]["y"] == [1, 2, 3], str(agg["replicas"][0]["y"]))

print("\n4. the SD convention — sample (n-1), matching every other tab")
# Column 0 is [1, 3, 5], mean 3, so the squared deviations are 4, 0, 4 (sum 8).
#     sample SD     = sqrt(8/2) = 2.0           <- what this code returns now
#     population SD = sqrt(8/3) = 1.632993...   <- what it returned before
agg = _agg_replicas([line([1, 2, 3]), line([3, 4, 5]), line([5, 6, 7])])
pop = math.sqrt(8 / 3)
smp = math.sqrt(8 / 2)
check("the SAMPLE SD (divides by n-1) is what comes back",
      near(agg["y_sd"][0], smp), f'{agg["y_sd"][0]:.6f} == sqrt(8/2)')
check("not the population SD this used to return",
      not near(agg["y_sd"][0], pop, 1e-9),
      f'{smp:.4f} vs the old {pop:.4f}')
"""
WHY THIS MATTERS, stated so it cannot be lost again.

Replicas are a SAMPLE of the runs that could have been done, not the entire
population of them, so the spread worth drawing is the one that estimates the
underlying variability. src/lib/stats.ts said so in a comment and divided by
(n-1); so do plotFilter.ts, derived.py's matrix-distribution `sd`, and
helix.py's rolling SD. This function's statistics.pstdev was the only
disagreement in the codebase.

It was a visible one. The Results tab plots the band this backend computes; the
Compare tab recomputes it in the browser the moment a replica is excluded. The
same ten runs therefore drew two different error bands, 5% apart at n=10 and
22% at n=3, and neither chart named its convention.

CONSEQUENCE FOR PUBLISHED WORK: error bars exported before 2026-11-03 used the
narrower population band. A figure remade now will have bars wider by
sqrt(n/(n-1)) — 5.4% at n=10, 11.8% at n=5, 22.5% at n=3.
"""
check("the correction is ~5% wider at ten replicas",
      abs((smp_over_pop := math.sqrt(10 / 9)) - 1.0541) < 1e-3,
      f'{100 * (smp_over_pop - 1):.1f}% wider at n=10')
check("and ~22% wider at three, which is not a rounding difference",
      abs(math.sqrt(3 / 2) - 1.2247) < 1e-3,
      f'{100 * (math.sqrt(3 / 2) - 1):.1f}% wider at n=3')

print("\n5. heatmaps are not averaged, and keep the payload light")
# Two 2x2 matrices. Pooling them gives the eight values 1..8.
hm = [{"kind": "heatmap", "z": [[1, 2], [3, 4]], "_rep_index": 1},
      {"kind": "heatmap", "z": [[5, 6], [7, 8]], "_rep_index": 2}]
agg = _agg_replicas(hm)
check("only the first replica's matrix is inline",
      agg["z"] == [[1, 2], [3, 4]], str(agg["z"]))
check("but every replica is listed, so the UI can fetch the others",
      agg["replica_indices"] == [1, 2] and agg["n_replicas"] == 2)
check("and a note says why it was not averaged",
      "isn't averaged" in agg.get("replica_note", ""))
check("z_stats pools ALL replicas, not just the one shown",
      agg["z_stats"]["n_matrices"] == 2 and agg["z_stats"]["n_cells"] == 8,
      f'{agg["z_stats"]["n_matrices"]} matrices, {agg["z_stats"]["n_cells"]} cells')
check("pooled min and max span both matrices",
      agg["z_stats"]["min"] == 1.0 and agg["z_stats"]["max"] == 8.0)

print("\n6. matrix statistics")
st = _matrix_stats([[[1, 2], [3, 4]], [[5, 6], [7, 8]]])
check("the median of 1..8 is 4.5", near(st["p50"], 4.5), str(st["p50"]))
check("percentiles are ordered",
      st["p1"] <= st["p5"] <= st["p50"] <= st["p95"] <= st["p99"],
      f'{st["p1"]:.2f} {st["p5"]:.2f} {st["p50"]:.2f} {st["p95"]:.2f} {st["p99"]:.2f}')
# A clipped scale is the whole point: p98 must sit below the extreme.
check("p98 is below the maximum, which is what makes clipping useful",
      st["p98"] < st["max"], f'{st["p98"]:.3f} < {st["max"]}')
nan = _matrix_stats([[[1.0, float("nan")], [3.0, float("inf")]]])
check("non-finite cells are dropped rather than poisoning the range",
      nan["n_cells"] == 2 and nan["min"] == 1.0 and nan["max"] == 3.0,
      f'{nan["n_cells"]} cells, {nan["min"]}..{nan["max"]}')
check("nothing numeric gives None, so the UI can fall back to autoscale",
      _matrix_stats([]) is None and _matrix_stats([[], None]) is None)

print("\n7. scatter2d pools every replica's points")
sc = [{"kind": "scatter2d", "x": [1, 2], "y": [3, 4], "_rep_index": 1},
      {"kind": "scatter2d", "x": [5], "y": [6], "_rep_index": 2}]
agg = _agg_replicas(sc)
check("points from all replicas are concatenated",
      agg["x"] == [1, 2, 5] and agg["y"] == [3, 4, 6],
      f'{agg["x"]} / {agg["y"]}')

print("\n8. flat residue indices map back to (chain, resnum)")
# The real ChainDef, not a stand-in: flat->bio numbering is exactly the kind
# of mapping where a hand-rolled fake would quietly encode my assumption
# rather than the code's.  Two chains of 3, so flat 1..3 are A 1..3 and
# flat 4..6 are B 1..3.
from core.session import ChainDef
chains = [ChainDef(id="A", start_resnum=1, end_resnum=3, n_residues=3),
          ChainDef(id="B", start_resnum=1, end_resnum=3, n_residues=3)]
mapped = _map_matrix_residues(chains, [1, 4, 99])
check("a residue in the first chain maps to it",
      mapped[0] == {"chain": "A", "resnum": 1}, str(mapped[0]))
check("a residue past the first chain maps to the second",
      mapped[1] == {"chain": "B", "resnum": 1}, str(mapped[1]))
check("an index beyond the structure is None, not a wrong residue",
      mapped[2] is None, str(mapped[2]))
check("no chain definitions means the PDB's own numbering is kept",
      _map_matrix_residues([], [5]) == [{"chain": "", "resnum": 5}],
      str(_map_matrix_residues([], [5])))

print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)

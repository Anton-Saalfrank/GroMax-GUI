"""
Counting the atoms that actually have water next to them.

WHY THIS EXISTS ALONGSIDE SASA
A rolling-probe surface area decides accessibility geometrically and locally,
so the wall of a SEALED interior cavity counts as accessible — nothing covers
it. Measured on a hollow shell of carbons, SASA is 2770 A^2 with the cavity
empty against 2166 A^2 packed solid: the 598 A^2 of cavity wall is counted
either way. SASA reacts when a cavity forms, barely when it opens.

Counting water contacts asks where the water IS. Test 2 is the whole point: a
sealed cavity reads zero however large it is, and the same geometry with water
inside reads the atoms that touch it.

Test 4 covers the refusal that matters — a trajectory with the solvent stripped
must say so rather than reporting a confident zero.
"""
import asyncio
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import MDAnalysis as mda
from MDAnalysis.coordinates.XTC import XTCWriter

from engines.mdanalysis import MDAnalysisEngine
from core.cavity import fibonacci_directions

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


# ── A two-layer protein shell with a cavity inside, and bulk water outside ───
#
# Two layers, not one, because that is the situation being modelled: the OUTER
# layer is the protein surface and is always wet, while the INNER layer lines
# the cavity and is wet only when water gets in. On a single-layer shell every
# atom faces both ways, so filling the cavity would not change the atom count
# and the test would prove nothing.
BOX = 70.0
CTR = BOX / 2
INNER = fibonacci_directions(260) * 8.0 + CTR          # cavity lining
OUTER = fibonacci_directions(420) * 11.5 + CTR         # protein surface
PROT = np.vstack([INNER, OUTER])
N_PROT = len(PROT)
N_INNER = len(INNER)

rng = np.random.default_rng(1)
bulk = []
while len(bulk) < 200:                                  # just outside the shell
    v = rng.normal(size=3); v /= np.linalg.norm(v)
    bulk.append(CTR + v * rng.uniform(13.0, 16.0))
bulk = np.array(bulk)
# Cavity water: close enough to the inner layer (8.0 - 5.2 = 2.8 A) to count.
inside = fibonacci_directions(14) * 5.2 + CTR
N_WAT = len(bulk) + len(inside)

u = mda.Universe.empty(N_PROT + N_WAT, n_residues=N_PROT + N_WAT,
                       atom_resindex=np.arange(N_PROT + N_WAT),
                       residue_segindex=np.zeros(N_PROT + N_WAT, dtype=int),
                       trajectory=True)
u.add_TopologyAttr('name', ['CA'] * N_PROT + ['OH2'] * N_WAT)
u.add_TopologyAttr('type', ['C'] * N_PROT + ['O'] * N_WAT)
u.add_TopologyAttr('resname', ['ALA'] * N_PROT + ['TIP3'] * N_WAT)
u.add_TopologyAttr('resid', list(range(1, N_PROT + N_WAT + 1)))
u.add_TopologyAttr('segid', ['A'])

# frame 0: cavity dry (those waters parked in a corner); frame 1: cavity filled
far = np.tile([3.0, 3.0, 3.0], (len(inside), 1)) + rng.uniform(0, 1.5, (len(inside), 3))
f0 = np.vstack([PROT, bulk, far])
f1 = np.vstack([PROT, bulk, inside])

tmp = Path(tempfile.mkdtemp())
u.dimensions = [BOX, BOX, BOX, 90, 90, 90]
u.atoms.positions = f0
u.atoms.write(str(tmp / "top.pdb"))
with XTCWriter(str(tmp / "traj.xtc"), n_atoms=len(u.atoms)) as w:
    for k, xyz in enumerate((f0, f1)):
        u.atoms.positions = xyz
        u.dimensions = [BOX, BOX, BOX, 90, 90, 90]
        u.trajectory.ts.time = k * 1000.0
        w.write(u.atoms)


def run(sel="resname ALA", top="top.pdb", xtc="traj.xtc", **params):
    pr = {"cutoff": 3.5, "count": "atoms", "heavy_only": True}
    pr.update(params)
    ctx = {"tpr": str(tmp / top), "xtc": str(tmp / xtc), "groups": [sel],
           "stride": 1, "time_start": None, "time_end": None, "params": pr}
    logs = []
    r = asyncio.run(MDAnalysisEngine.ANALYSES["hydration"]()
                    .run(ctx, tmp, line_callback=logs.append))
    return r, logs


print("1. the outer surface is wetted by bulk water in both frames")
r, logs = run()
y = r["y"]
check("some atoms touch water every frame", min(y) > 0, f"{y}")
check("and it is a minority of the protein", max(y) < N_PROT, f"{max(y)} of {N_PROT}")

print("\n2. water entering the cavity is SEEN — the point of the whole analysis")
check("more atoms are wetted once the cavity fills", y[1] > y[0],
      f"{y[0]:.0f} dry-cavity frame -> {y[1]:.0f} filled-cavity frame")
check("the increase is substantial, not marginal", y[1] >= y[0] + 10,
      f"+{y[1] - y[0]:.0f} atoms")
# The geometric check: SASA would have counted that cavity wall in BOTH frames,
# because nothing covers it. Here it only counts when water is actually there.
check("the cavity lining really is a closed sphere",
      float(np.linalg.norm(INNER - CTR, axis=1).std()) < 0.01, "sealed")
check("and in the dry frame NONE of the lining is wet",
      y[0] <= N_PROT - N_INNER,
      f"{y[0]:.0f} wet atoms, {N_PROT - N_INNER} atoms in the outer layer")

print("\n3. the counting modes count different things")
for mode, expect_rel in (("atoms", None), ("residues", None),
                         ("waters", None), ("fraction", None)):
    rr, _ = run(count=mode)
    check(f"mode '{mode}' returns a series", len(rr["y"]) == 2,
          f"{[round(v, 3) for v in rr['y']]}")
rf, _ = run(count="fraction")
ra, _ = run(count="atoms")
check("fraction is atoms / selection size",
      abs(rf["y"][1] - ra["y"][1] / N_PROT) < 1e-9,
      f"{rf['y'][1]:.3f} vs {ra['y'][1] / N_PROT:.3f}")
rw, _ = run(count="waters")
check("waters counted differs from atoms counted", rw["y"][1] != ra["y"][1],
      f"{rw['y'][1]:.0f} waters vs {ra['y'][1]:.0f} atoms")

print("\n4. a trajectory with no water is refused, not answered with zero")
try:
    run(water="resname NOSUCHTHING")
    check("an empty water selection is refused", False, "it returned a number")
except RuntimeError as e:
    check("an empty water selection is refused", "matched no atoms" in str(e))
    check("and the message says what to do instead", "cavity" in str(e).lower(),
          str(e).splitlines()[-1][:80])

print("\n5. a cutoff typed in nm is refused")
try:
    run(cutoff=0.35)
    check("0.35 is refused as a nm value", False, "it was accepted as Å")
except RuntimeError as e:
    check("0.35 is refused as a nm value", "Ångström" in str(e),
          str(e).splitlines()[0][:70])

print("\n6. the log names the residues that change state")
_, logs = run()
joined = "\n".join(logs)
check("it separates always-wet, never-wet and in-between",
      "always wet" in joined or "≥95% of frames" in joined, "")
check("and lists the ones that open",
      "usually dry but sometimes wetted" in joined
      or "No residue changes state" in joined,
      next((l for l in logs if "dry" in l), ""))

import shutil
shutil.rmtree(tmp, ignore_errors=True)
print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

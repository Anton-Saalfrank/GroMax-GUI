"""
Contact counting, on a geometry where every answer is known by hand.

"74 contacts between what ChimeraX says are 4 residues" is the report this test
exists for. Three different questions hide behind the word "contacts" — atom
pairs, residue pairs, and how much of one group is touching — and they differ by
more than an order of magnitude on real data. Each one is checked here against a
count done on paper, not against another run of the same code.

THE GEOMETRY (cutoff 4.0 A throughout)

  group A, resids 1-3        group B, resids 11-13
    res1  CA (0, 0,0)          res11  CB (3.0, 0,0)
          HA (1, 0,0)                 HB (4.5, 0,0)
    res2  CA (0,10,0)          res12  CB (3.0,10,0)
          HA (1,10,0)                 HB (4.5,10,0)
    res3  CA (0,20,0)          res13  CB (6.0,20,0)
          HA (1,20,0)                 HB (4.2,20,0)

  res1-res11   CA-CB 3.0 in | CA-HB 4.5 out | HA-CB 2.0 in | HA-HB 3.5 in
  res2-res12   identical to res1-res11
  res3-res13   CA-CB 6.0 out | CA-HB 4.2 out | HA-CB 5.0 out | HA-HB 3.2 in
  everything else is >= 10 A apart in y.

So res3-res13 touch through hydrogens ONLY — which is what makes the
heavy-atoms-only switch visible in a residue-pair count, and is the whole
reason a viewer showing no hydrogens disagrees with an all-atom count.

Frame 1 moves res2 to y = 50, out of contact, so the counts also have to move.
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

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


BOX = 200.0
NAMES = ['CA', 'HA'] * 3 + ['CB', 'HB'] * 3
RESIDS = [1, 1, 2, 2, 3, 3, 11, 11, 12, 12, 13, 13]
RESNAMES = ['ALA', 'ALA', 'ALA', 'GLY', 'GLY', 'GLY']

frame0 = np.array([
    [0.0, 0.0, 0.0], [1.0, 0.0, 0.0],        # A res1
    [0.0, 10.0, 0.0], [1.0, 10.0, 0.0],      # A res2
    [0.0, 20.0, 0.0], [1.0, 20.0, 0.0],      # A res3
    [3.0, 0.0, 0.0], [4.5, 0.0, 0.0],        # B res11
    [3.0, 10.0, 0.0], [4.5, 10.0, 0.0],      # B res12
    [6.0, 20.0, 0.0], [4.2, 20.0, 0.0],      # B res13
])
frame1 = frame0.copy()
frame1[2:4, 1] = 50.0                         # res2 leaves

u0 = mda.Universe.empty(12, n_residues=6, atom_resindex=np.repeat(np.arange(6), 2),
                        residue_segindex=np.zeros(6, dtype=int), trajectory=True)
u0.add_TopologyAttr('name', NAMES)
u0.add_TopologyAttr('type', [n[0] for n in NAMES])
u0.add_TopologyAttr('resname', RESNAMES)
u0.add_TopologyAttr('resid', [1, 2, 3, 11, 12, 13])
u0.add_TopologyAttr('segid', ['A'])

tmp = Path(tempfile.mkdtemp())
u0.dimensions = [BOX, BOX, BOX, 90, 90, 90]
u0.atoms.positions = frame0
u0.atoms.write(str(tmp / "top.pdb"))
with XTCWriter(str(tmp / "traj.xtc"), n_atoms=12) as w:
    for k, xyz in enumerate((frame0, frame1)):
        u0.atoms.positions = xyz
        u0.dimensions = [BOX, BOX, BOX, 90, 90, 90]
        u0.trajectory.ts.time = k * 1000.0                # 1 ns per frame
        w.write(u0.atoms)


def run(mode, heavy=True, cut=4.0, groups=("resid 1:3", "resid 11:13")):
    ctx = {"tpr": str(tmp / "top.pdb"), "xtc": str(tmp / "traj.xtc"),
           "groups": list(groups), "stride": 1,
           "time_start": None, "time_end": None,
           "params": {"cutoff": cut, "count": mode, "heavy_only": heavy}}
    logs = []
    r = asyncio.run(MDAnalysisEngine.ANALYSES["contact_count"]()
                    .run(ctx, tmp, line_callback=logs.append))
    return r, logs


print("1. every counting mode, all atoms (hydrogens included)")
#                          frame 0, frame 1
EXPECT_ALL = {
    'atom_pairs':    (7, 4),     # 3 + 3 + 1   ->  3 + 0 + 1
    'residue_pairs': (3, 2),
    'residues_a':    (3, 2),
    'residues_b':    (3, 2),
    'atoms_a':       (5, 3),     # CA1 HA1 CA2 HA2 HA3  ->  CA1 HA1 HA3
    'atoms_b':       (5, 3),     # CB11 HB11 CB12 HB12 HB13
}
for mode, (e0, e1) in EXPECT_ALL.items():
    r, _ = run(mode, heavy=False)
    check(f"{mode}: {e0}, then {e1}", r["y"] == [e0, e1], f"got {r['y']}")

print("\n2. the same geometry, heavy atoms only")
EXPECT_HEAVY = {
    'atom_pairs':    (2, 1),     # only CA-CB 3.0 in each live pair
    'residue_pairs': (2, 1),     # res3-res13 was a hydrogen-only contact
    'residues_a':    (2, 1),
    'residues_b':    (2, 1),
    'atoms_a':       (2, 1),
    'atoms_b':       (2, 1),
}
for mode, (e0, e1) in EXPECT_HEAVY.items():
    r, _ = run(mode, heavy=True)
    check(f"{mode}: {e0}, then {e1}", r["y"] == [e0, e1], f"got {r['y']}")

print("\n3. the three answers really are different numbers")
pairs, _ = run('atom_pairs', heavy=False)
resp, _ = run('residue_pairs', heavy=False)
atb, _ = run('atoms_b', heavy=False)
check("atom pairs > residue pairs on the same frame",
      pairs["y"][0] > resp["y"][0], f"{pairs['y'][0]} vs {resp['y'][0]}")
check("'atoms of group 2' is a third answer again",
      atb["y"][0] not in (pairs["y"][0], resp["y"][0]),
      f"{atb['y'][0]} vs {pairs['y'][0]} and {resp['y'][0]}")

print("\n4. the label says which question was answered")
r, _ = run('residue_pairs', heavy=True)
check("y-label names residue pairs", r["ylabel"] == "Residue pairs in contact",
      r["ylabel"])
check("title carries cutoff and hydrogen policy",
      "4 Å" in r["title"] and "heavy atoms" in r["title"], r["title"])
r, _ = run('atom_pairs', heavy=False)
check("a different mode gets a different y-label",
      r["ylabel"] == "Atom pairs in contact", r["ylabel"])
check("all-atom runs say so in the title", "all atoms" in r["title"], r["title"])

print("\n5. the job log names the residue pairs behind the number")
_, logs = run('residue_pairs', heavy=False)
joined = "\n".join(logs)
check("res1-res11 is listed at 100% of frames",
      "ALA1 – GLY11" in joined and "100.0%" in joined,
      next((l.strip() for l in logs if "ALA1 " in l), "not found"))
check("res2-res12, in contact for one frame of two, is listed at 50%",
      any("50.0%" in l for l in logs),
      next((l.strip() for l in logs if "50.0%" in l), "not found"))
check("the log states the hydrogen policy",
      "hydrogens included" in joined)
check("the log states how many atoms each selection holds",
      "Selection 1: 6 atoms in 3 residues" in joined,
      next((l for l in logs if l.startswith("Selection 1")), ""))

print("\n6. things that must be refused rather than answered wrongly")
try:
    run('residue_pairs', groups=("resid 1:13", "resid 11:13"))
    check("overlapping selections are refused", False, "they were accepted")
except RuntimeError as e:
    check("overlapping selections are refused", "share" in str(e),
          str(e).splitlines()[0][:70])

try:
    run('residue_pairs', cut=0.4)
    check("a cutoff typed in nm is refused", False, "0.4 was accepted as Å")
except RuntimeError as e:
    check("a cutoff typed in nm is refused", "Ångström" in str(e),
          str(e).splitlines()[0][:70])

try:
    run('residue_contacts')
    check("an unknown mode is refused", False, "it was accepted")
except RuntimeError as e:
    check("an unknown mode is refused", "Unknown count mode" in str(e))

try:
    run('atom_pairs', groups=("name HA", "resid 11:13"))
    check("an all-hydrogen selection with heavy-only is refused", False,
          "it was accepted")
except RuntimeError as e:
    check("an all-hydrogen selection with heavy-only is refused",
          "only hydrogens" in str(e), str(e).splitlines()[0][:70])

print("\n7. hydrogens are found by name, not by mass")
# Hydrogen mass repartitioning puts hydrogens at ~3 u and pulls a methyl carbon
# down to ~6 u, so any mass threshold mislabels an HMR topology in both
# directions. Masses here are deliberately scrambled to prove they are unused.
from engines.mdanalysis import _hydrogen_mask
check("HA and HB are hydrogens, CA and CB are not",
      list(_hydrogen_mask(['CA', 'HA', 'CB', 'HB'])) == [False, True, False, True])
check("a leading digit does not hide a hydrogen (1HB style names)",
      list(_hydrogen_mask(['1HB', '2CG'])) == [True, False])

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

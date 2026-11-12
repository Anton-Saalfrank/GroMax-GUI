"""
Clicking a surface and getting the cavity behind it.

The geometry is known: a hollow shell of carbons with a second, separate
pocket nearby. A click on the inner wall of one must return that pocket's
lining and not the other's — which is the whole point, since a click is only
useful if it resolves the pocket the user is actually looking at.
"""
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from fastapi import HTTPException

from core.cavity import fibonacci_directions
from core.structure import CavityAtRequest, cavity_at

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


def shell(radius, centre, n, resid_base, chain="A"):
    pts = fibonacci_directions(n) * radius + np.asarray(centre, float)
    return [{"index": resid_base * 1000 + i, "x": float(p[0]), "y": float(p[1]),
             "z": float(p[2]), "name": "CA", "resname": "ALA",
             "resnum": resid_base + i // 10, "chain": chain}
            for i, p in enumerate(pts)]


# Two closed pockets 26 A apart, with distinct residue numbering.
POCKET_A = shell(8.0, (0, 0, 0), 800, 100)
POCKET_B = shell(8.0, (26, 0, 0), 800, 500)
ATOMS = POCKET_A + POCKET_B


def ask(point, **kw):
    return cavity_at(CavityAtRequest(point=list(point), atoms=ATOMS, **kw))


print("1. a click inside one pocket finds that pocket")
# A point just inside pocket A's wall, where a surface click would land.
res = ask((0.0, 0.0, 4.0))
want = 4 / 3 * np.pi * (8.0 - 1.70 - 1.4) ** 3
check("a cavity is found", res["found"], res["reason"])
check("its volume matches the geometry",
      abs(res["volume_A3"] - want) / want < 0.2,
      f"{res['volume_A3']:.0f} vs {want:.0f} A^3")
check("it is reported as enclosed, not open", not res["open_to_bulk"])
resids = {r["resnum"] for r in res["residues"]}
check("the lining is pocket A's residues", min(resids) >= 100 and max(resids) < 200,
      f"{min(resids)}-{max(resids)}")
check("and none of pocket B's", not any(r >= 500 for r in resids))
check("atom indices come back for selecting", len(res["atom_indices"]) > 50,
      f"{len(res['atom_indices'])} atoms")

print("\n2. a click inside the OTHER pocket finds the other one")
res_b = ask((26.0, 0.0, 4.0))
resids_b = {r["resnum"] for r in res_b["residues"]}
check("the lining is pocket B's residues",
      min(resids_b) >= 500 and not any(r < 200 for r in resids_b),
      f"{min(resids_b)}-{max(resids_b)}")
check("the two clicks disagree completely",
      not (resids & resids_b), f"{len(resids & resids_b)} shared residues")

print("\n3. a click in open space outside everything finds nothing")
res_out = ask((0.0, 0.0, 60.0))
check("no cavity is claimed", not res_out["found"], res_out["reason"])
check("and the volume is zero", res_out["volume_A3"] == 0.0)
check("with a reason the user can read", bool(res_out["reason"]),
      res_out["reason"])

print("\n4. the probe size decides what counts as a cavity")
# In a shell of radius 6 A made of 1.7 A carbons, a probe of radius p reaches
# out to 6 - 1.7 - p, so it fits at 1.4 A (2.9 A of cavity), barely at 3.0 A
# (1.3 A), and not at all at 5.0 A. That is the whole of the parameter.
small = [{"index": i, "x": float(p[0]), "y": float(p[1]), "z": float(p[2]),
          "name": "CA", "resname": "ALA", "resnum": 10 + i // 10, "chain": "A"}
         for i, p in enumerate(fibonacci_directions(700) * 6.0)]
r14 = cavity_at(CavityAtRequest(point=[0, 0, 2.0], atoms=small, probe=1.4))
r30 = cavity_at(CavityAtRequest(point=[0, 0, 2.0], atoms=small, probe=3.0))
r50 = cavity_at(CavityAtRequest(point=[0, 0, 2.0], atoms=small, probe=5.0))
check("a water-sized probe fits", r14["found"], f"{r14['volume_A3']:.0f} A^3")
check("a bigger probe finds a smaller cavity",
      r30["found"] and r30["volume_A3"] < 0.3 * r14["volume_A3"],
      f"{r30['volume_A3']:.0f} vs {r14['volume_A3']:.0f} A^3")
check("a probe too big for the cavity finds nothing",
      not r50["found"], r50["reason"])

print("\n5. bad requests are refused")
for bad, why in (({"point": [0, 0], "atoms": ATOMS}, "a 2D point"),
                 ({"point": [0, 0, 0], "atoms": []}, "no atoms")):
    try:
        cavity_at(CavityAtRequest(**bad))
        check(f"{why} is refused", False, "it was accepted")
    except HTTPException as e:
        check(f"{why} is refused", e.status_code == 400, str(e.detail)[:70])

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

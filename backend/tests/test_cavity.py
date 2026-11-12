"""
Cavity volume, against geometry whose answer is known in closed form.

A hollow shell of atoms of radius R_shell encloses a sphere of empty space that
a probe of radius r_p can reach out to R_shell - (r_vdw + r_p). Its volume is
4/3 pi r^3, and that is what the measurement has to return — not something
proportional to it, not something that depends on how the shell is oriented.

The three failure modes this guards are the ones that make a void measurement
useless rather than merely imprecise:

  BULK SOLVENT COUNTED AS A CAVITY — test 4 puts the seed in open water next to
  a flat wall. The honest answer is zero, and a method without a buriedness
  test returns the whole region instead.

  THE ANSWER FOLLOWING THE MOLECULE'S ORIENTATION — test 3 rotates the system
  and demands the same number back. A lab-frame grid, or rays cast along grid
  axes, fails this, and the resulting wobble is indistinguishable from the
  cavity breathing.

  A GROWING CAVITY NOT BEING SEEN TO GROW — test 6 enlarges a shell and checks
  the measurement follows the analytic volume across it.
"""
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from core.cavity import cavity_frame, fibonacci_directions, radii_for

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


CARBON = 1.70
PROBE = 1.4


def shell(radius, n=900, centre=(0., 0., 0.)):
    """A closed sphere of carbon atoms — dense enough that no probe leaks out."""
    return np.asarray(centre, float) + radius * fibonacci_directions(n)


def analytic(radius_shell, probe=PROBE, r_atom=CARBON):
    r = radius_shell - (r_atom + probe)
    return 4.0 / 3.0 * np.pi * r ** 3


def measure(xyz, centre=(0., 0., 0.), **kw):
    opts = dict(probe=PROBE, spacing=0.6, region=10.0, burial=0.65,
                n_rays=50, ray_length=10.0)
    opts.update(kw)
    return cavity_frame(xyz, np.full(len(xyz), CARBON), np.asarray(centre, float),
                        **opts)


print("1. a hollow shell gives back its analytic volume")
for R in (8.0, 9.0, 10.0):
    got = measure(shell(R))["volume_A3"]
    want = analytic(R)
    err = abs(got - want) / want * 100
    check(f"shell R={R:g} A -> {want:.0f} A^3", err < 8,
          f"measured {got:.0f} A^3, {err:.1f}% off")

print("\n2. the largest sphere that fits is the cavity radius")
res = measure(shell(10.0))
want_r = 10.0 - CARBON - PROBE
check("max inscribed sphere matches the geometry",
      abs(res["max_sphere_A"] - (want_r + PROBE)) < 0.9,
      f"{res['max_sphere_A']:.2f} A vs {want_r + PROBE:.2f} A expected")
check("an enclosed cavity is not reported as open", not res["open_to_bulk"])

print("\n3. rotating the system does not change the answer")
# The cavity is deliberately NOT spherically symmetric, or any method would
# pass: two overlapping shells make a peanut with a defined orientation.
A, B = np.array([-3.0, 0, 0]), np.array([3.0, 0, 0])
sa, sb = shell(7.0, 800, A), shell(7.0, 800, B)
# Keep only the atoms on the OUTER surface of the union, so the two shells form
# one closed peanut rather than two spheres with a wall down the middle.
base = np.vstack([sa[np.linalg.norm(sa - B, axis=1) > 7.0],
                  sb[np.linalg.norm(sb - A, axis=1) > 7.0]])
ref = measure(base, centre=(0, 0, 0))["volume_A3"]
check("the irregular test cavity is non-trivial", ref > 300, f"{ref:.0f} A^3")
rng = np.random.default_rng(7)
spread = []
for _ in range(5):
    q = rng.normal(size=4); q /= np.linalg.norm(q)
    w, x, y, z = q
    Rm = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])
    shifted = base @ Rm.T + np.array([13.0, -7.0, 21.0])
    spread.append(measure(shifted, centre=np.array([13.0, -7.0, 21.0]))["volume_A3"])
spread = np.array(spread)
rel = (spread.max() - spread.min()) / ref * 100
check("five random rotations + a translation agree within 3%", rel < 3.0,
      f"{spread.min():.0f}-{spread.max():.0f} A^3 vs {ref:.0f} ({rel:.1f}% spread)")

print("\n4. open solvent next to a wall is NOT a cavity")
# A flat slab with the seed 6 A above it in open space. Every naive void count
# returns the whole hemisphere here.
g = np.arange(-18, 18.01, 1.6)
gx, gy = np.meshgrid(g, g)
slab = np.stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)], axis=1)
slab = np.vstack([slab, slab + [0, 0, -1.6], slab + [0, 0, -3.2]])
res = measure(slab, centre=(0, 0, 6.0))
check("volume above a flat surface is ~zero", res["volume_A3"] < 20,
      f"{res['volume_A3']:.0f} A^3 — {res['reason'] or 'buriedness filtered it'}")

print("\n5. a solid ball of atoms has no cavity")
rng2 = np.random.default_rng(3)
pos = rng2.normal(size=(6000, 3)) * 4.0
pos = pos[np.linalg.norm(pos, axis=1) < 11]
res = measure(pos)
check("a packed ball reports no cavity", res["volume_A3"] < 30,
      f"{res['volume_A3']:.0f} A^3")

print("\n6. a growing cavity is seen to grow, and tracks the analytic curve")
seq = [(R, measure(shell(R))["volume_A3"], analytic(R)) for R in (7.0, 8.0, 9.0, 10.0)]
vols = [v for _, v, _ in seq]
check("volume increases monotonically with shell radius",
      all(b > a for a, b in zip(vols, vols[1:])),
      " -> ".join(f"{v:.0f}" for v in vols))
worst = max(abs(v - w) / w * 100 for _, v, w in seq)
check("every point is within 8% of analytic", worst < 8, f"worst {worst:.1f}%")

print("\n7. an opening is reported as an opening")
closed = shell(9.0, 900)
holed = closed[~((closed[:, 2] > 4.5) & (np.linalg.norm(closed[:, :2], axis=1) < 6))]
r_closed, r_open = measure(closed), measure(holed)
check("the closed shell is enclosed", not r_closed["open_to_bulk"])
check("the breached shell is flagged open", r_open["open_to_bulk"],
      f"{r_open['volume_A3']:.0f} A^3")
check("and its volume does not explode into bulk solvent",
      r_open["volume_A3"] < 4 * r_closed["volume_A3"],
      f"{r_open['volume_A3']:.0f} vs {r_closed['volume_A3']:.0f} A^3 closed")

print("\n8. the grid spacing sets precision, not the answer")
vals = {s: measure(shell(10.0), spacing=s)["volume_A3"] for s in (1.0, 0.8, 0.6, 0.5)}
rel = (max(vals.values()) - min(vals.values())) / analytic(10.0) * 100
check("0.5-1.0 A spacings agree within 10%", rel < 10,
      " ".join(f"{k}A:{v:.0f}" for k, v in vals.items()))

print("\n9. a seed far from any void returns zero, not the nearest cavity")
far = measure(shell(10.0), centre=(30.0, 0, 0))
check("a seed outside the system finds nothing", far["volume_A3"] == 0.0,
      far["reason"])

print("\n10. unrelated voids are not added in")
# A second, larger cavity 26 A away must not contribute to the seeded one.
two = np.vstack([shell(8.0, 800, (0, 0, 0)), shell(10.0, 900, (26.0, 0, 0))])
one = measure(two, centre=(0, 0, 0))["volume_A3"]
alone = measure(shell(8.0, 800), centre=(0, 0, 0))["volume_A3"]
check("only the seeded cavity is counted", abs(one - alone) / alone < 0.05,
      f"{one:.0f} A^3 with a neighbour vs {alone:.0f} alone")

print("\n11. grid spacing on a SMALL cavity")
# A small cavity is measured just as faithfully as a large one, PROVIDED it is
# smooth. That is worth pinning, but it must not be read as "spacing does not
# matter" — see the note below, which is the case these synthetic shells do
# NOT reproduce.
small = {sp: measure(shell(5.5), spacing=sp)["volume_A3"] for sp in (1.0, 0.7, 0.5)}
want = analytic(5.5)
rel = (max(small.values()) - min(small.values())) / want * 100
check("a ~58 A^3 smooth cavity is right at every spacing",
      all(abs(v - want) / want < 0.25 for v in small.values()),
      " ".join(f"{k}A:{v:.0f}" for k, v in small.items()) + f" vs analytic {want:.0f}")
check("and the spacings agree closely with each other", rel < 25,
      f"{rel:.0f}% spread")
# A REAL cavity behaves worse than any shell here, and no smooth synthetic
# geometry reproduces it, because the mechanism is different: spacing decides
# whether narrow necks contain a lattice point at all — and a neck that
# is resolved lets the flood reach further, adding volume that a coarser grid
# never sees. Measured on a Tyr->Cys mutant: mean 40 A^3 at 1.0 A spacing
# against 68 A^3 at 0.5 A, on the same 150 frames. So absolute volumes are
# comparable only at a FIXED spacing; the condition-vs-condition difference is
# the result, not the number of cubic angstrom.
print("     (see the comment above: a real irregular cavity moved 40 -> 68 A^3"
      " between 1.0 and 0.5 A spacing — hold spacing fixed when comparing)")

print("\n12. a region defined by LINING residues, not by a seed point")
# Why this exists: a seed point is a poor handle. The centroid of a side chain
# lies INSIDE it — measured on a real system, 1.0-1.3 A inside the nearest vdW
# surface — so the void can never start closer than ~2.5 A, and whatever pocket
# is nearest within the seed radius gets counted. In a mutation study that is
# worse still, because a tyrosine centroid and a cysteine centroid are not in
# the same place: measured, the two conditions shared only 29% of their lining
# residues. Naming the lining removes the ambiguity entirely.
pocket_a = shell(6.0, 700) + np.array([-8., 0, 0])     # analytic 102 A^3
pocket_b = shell(8.0, 900) + np.array([8., 0, 0])      # analytic 493 A^3
both = np.vstack([pocket_a, pocket_b])
radii = np.full(len(both), CARBON)


def by_lining(lining, reach, centre=(0., 0., 0.)):
    return cavity_frame(both, radii, np.asarray(centre, float), probe=PROBE,
                        spacing=0.6, region=14.0, burial=0.65,
                        require_connected=False,
                        include_xyz=lining, include_radius=reach)["volume_A3"]


a_want, b_want = analytic(6.0), analytic(8.0)
got_a, got_b = by_lining(pocket_a, 4.0), by_lining(pocket_b, 6.0)
check("naming the small pocket's lining measures the small pocket",
      abs(got_a - a_want) / a_want < 0.2, f"{got_a:.0f} vs {a_want:.0f} A^3")
check("naming the large pocket's lining measures the large one",
      abs(got_b - b_want) / b_want < 0.2, f"{got_b:.0f} vs {b_want:.0f} A^3")
check("and each one EXCLUDES the other pocket",
      got_a < 0.4 * b_want and got_b > 2 * a_want,
      f"small {got_a:.0f}, large {got_b:.0f}")

no_lining = cavity_frame(both, radii, np.zeros(3), probe=PROBE, spacing=0.6,
                         region=14.0, burial=0.65,
                         require_connected=False)["volume_A3"]
check("with no lining given, a seed between them sweeps up everything",
      no_lining > a_want + b_want,
      f"{no_lining:.0f} A^3 against {a_want + b_want:.0f} for the two pockets")

# REGRESSION: the seed-proximity rule used to apply even here, so a correct
# lining with the seed on the far side returned 0.
check("the answer does not depend on where the seed happens to sit",
      abs(by_lining(pocket_a, 4.0, (-4, 0, 0))
          - by_lining(pocket_a, 4.0, (4, 0, 0))) / a_want < 0.2,
      f"{by_lining(pocket_a, 4.0, (-4, 0, 0)):.0f} from one side, "
      f"{by_lining(pocket_a, 4.0, (4, 0, 0)):.0f} from the other")

print("\n13. the lining reach cuts BOTH ways, and has to be chosen")
# Too short and the middle of the cavity is outside the region; too long and
# the region spills into whatever is next door. Neither is a safe default, so
# the numbers are recorded here and quoted in the parameter's help text.
reach_small = {r: by_lining(pocket_a, r) for r in (4.0, 6.0, 8.0)}
check("too much reach over-counts a shallow pocket",
      reach_small[8.0] > 1.5 * reach_small[4.0],
      " ".join(f"{k:g}A:{v:.0f}" for k, v in reach_small.items())
      + f" (analytic {a_want:.0f})")
deep = shell(10.0, 1100)
deep_r = np.full(len(deep), CARBON)
want_deep = analytic(10.0)


def deep_vol(reach):
    return cavity_frame(deep, deep_r, np.zeros(3), probe=PROBE, spacing=0.6,
                        region=14.0, burial=0.65, require_connected=False,
                        include_xyz=deep, include_radius=reach)["volume_A3"]


check("too little reach clips the middle out of a deep cavity",
      deep_vol(5.0) < 0.75 * want_deep,
      f"{deep_vol(5.0):.0f} of {want_deep:.0f} A^3 at 5 A reach")
check("a reach that spans it recovers the cavity",
      abs(deep_vol(10.0) - want_deep) / want_deep < 0.1,
      f"{deep_vol(10.0):.0f} of {want_deep:.0f} A^3 at 10 A reach")

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

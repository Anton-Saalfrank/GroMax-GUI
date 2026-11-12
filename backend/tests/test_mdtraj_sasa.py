"""
MDTraj SASA, against a Shrake-Rupley written from the definition.

REGRESSION: md.shrake_rupley over several frames in ONE call is wrong for
every frame after the first — a frame's area depends on its position in the
call, not on any coordinates. Measured on a real 6480-atom protein: +21.4 A^2
on every frame except frame 0, always high, which puts a fake step at the start
of every trace. The engine therefore calls it one frame at a time
(engines/mdtraj.py:_sasa_chunked). This test checks the property we own — our
helper matches an independent implementation — and REPORTS whether MDTraj
itself still has the problem, so a future fix upstream does not turn into a
spurious failure here.
"""
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
try:
    import mdtraj as md
except Exception:
    print("  (MDTraj not installed — skipping)")
    sys.exit(0)
from scipy.spatial import cKDTree

from engines.mdtraj import _sasa_chunked

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


def sphere_points(n):
    inc = np.pi * (3 - np.sqrt(5)); off = 2.0 / n
    k = np.arange(n); y = k * off - 1 + off / 2
    r = np.sqrt(1 - y * y); phi = k * inc
    return np.stack([np.cos(phi) * r, y, np.sin(phi) * r], axis=1)


def reference(xyz, radius=0.17, probe=0.14, n=960):
    """Shrake-Rupley from the definition. Nothing carried between frames."""
    sp = sphere_points(n); R = radius + probe
    tree = cKDTree(xyz); total = 0.0
    for i in range(len(xyz)):
        pts = xyz[i] + sp * R
        free = np.ones(n, bool)
        for j in tree.query_ball_point(xyz[i], 2 * R):
            if j != i:
                free &= np.sum((pts - xyz[j]) ** 2, axis=1) >= R * R
        total += 4 * np.pi * R * R * free.mean()
    return total


top = md.Topology(); ch = top.add_chain()
for _ in range(300):
    top.add_atom("C", md.element.carbon, top.add_residue("ALA", ch))
rng = np.random.default_rng(0)
xyz = rng.uniform(0, 2.6, (8, 300, 3)).astype(np.float32)
traj = md.Trajectory(xyz, top)
refs = np.array([reference(xyz[f].astype(float)) for f in range(len(xyz))])

print("1. the engine's SASA matches an independent implementation, every frame")
ours = _sasa_chunked(traj, None, mode="atom").sum(axis=1)
dev = np.abs(ours - refs) / refs
check("all frames within float32 precision of the reference",
      dev.max() < 2e-4, f"worst {dev.max():.1e}")
check("including the frames after the first", dev[1:].max() < 2e-4,
      f"frames 1-7 worst {dev[1:].max():.1e}")

print("\n2. one frame per call is what makes that true")
one_call = md.shrake_rupley(traj, mode="atom").sum(axis=1)
upstream = np.abs(one_call - refs) / refs
if upstream[1:].max() > 5e-4:
    print(f"  note  MDTraj {md.__version__} still mis-scores frames after the "
          f"first in a multi-frame call (worst {upstream[1:].max():.1e}, "
          f"always {'high' if (one_call[1:] > refs[1:]).all() else 'mixed'}) — "
          f"the per-frame workaround is needed")
else:
    print(f"  note  MDTraj {md.__version__} no longer shows the multi-frame "
          f"error — the per-frame workaround is harmless but could be revisited")
check("frame 0 of a multi-frame call is unaffected either way",
      upstream[0] < 2e-4, f"{upstream[0]:.1e}")

print("\n3. progress is reported on a long run")
lines = []
long = md.Trajectory(np.repeat(xyz[:1], 40, axis=0), top)
_sasa_chunked(long, lines.append, mode="atom")
check("a long run reports progress with an estimate",
      len(lines) >= 5 and "left" in lines[-1], lines[-1] if lines else "")

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

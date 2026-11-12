"""
The helix-motion analysis end to end, on a trajectory with a planted motion.

Two helices. Helix B and its domain stay put; helix A pistons 4 A along its own
axis and rolls 60 degrees, both ramping in over the second half of the run. The
WHOLE system is then given a large rigid-body drift and a rotation per frame,
and the coordinates are wrapped into a periodic box — so the analysis only
recovers the planted motion if the fitting and the PBC handling both work.
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

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


def rot_about(axis, deg):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    t = np.radians(deg)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(t) * K + (1 - np.cos(t)) * (K @ K)


def helix(n, origin, rise=1.5, radius=2.3, turn=100.0):
    a = np.radians(turn) * np.arange(n)
    return np.column_stack([radius * np.cos(a), radius * np.sin(a),
                            rise * np.arange(n)]) + np.asarray(origin, float)


# ── system: domain (30 CA) + helix B (14) + helix A (16) ────────────────────
N_DOM, N_B, N_A = 30, 14, 16
rng = np.random.default_rng(11)
domain = rng.normal(scale=6.0, size=(N_DOM, 3)) + np.array([0., 0., 0.])
hB = helix(N_B, [12.0, 0.0, -5.0])
hA0 = helix(N_A, [-12.0, 0.0, -6.0])
base = np.vstack([domain, hB, hA0])
N = len(base)

A_SLICE = slice(N_DOM + N_B, N)
PISTON_A, ROLL_DEG = 4.0, 60.0
N_FRAMES = 80
BOX = 90.0

frames = []
for f in range(N_FRAMES):
    c = base.copy()
    # ramp the planted motion over the second half
    s = 0.0 if f < N_FRAMES // 2 else (f - N_FRAMES // 2) / (N_FRAMES // 2 - 1)
    a_now = hA0.copy()
    cen = a_now.mean(axis=0)
    axis_a = np.array([0., 0., 1.])                       # helix A runs along +z
    a_now = (a_now - cen) @ rot_about(axis_a, ROLL_DEG * s).T + cen
    a_now = a_now + axis_a * (PISTON_A * s)
    c[A_SLICE] = a_now
    c += rng.normal(scale=0.03, size=c.shape)             # thermal jitter
    # a large global rigid-body motion the fit must remove
    c = c @ rot_about([0.3, 1.0, 0.2], f * 2.0).T + np.array([f * 0.4, -f * 0.3, f * 0.2])
    c = np.mod(c + BOX / 2, BOX)                          # and wrap into the box
    frames.append(c)
xyz = np.stack(frames)

top = mda.Universe.empty(N, n_residues=N, atom_resindex=np.arange(N),
                         residue_segindex=np.zeros(N, dtype=int), trajectory=True)
top.add_TopologyAttr('name', ['CA'] * N)
top.add_TopologyAttr('type', ['C'] * N)
top.add_TopologyAttr('resname', ['ALA'] * N)
top.add_TopologyAttr('resid', list(range(1, N + 1)))
top.add_TopologyAttr('segid', ['A'])
# Bonds along each chain, so unwrap() has something to work with — a .tpr
# carries these, and without them the transformation cannot run at all.
bonds = [(i, i + 1) for i in range(N_DOM - 1)]
bonds += [(i, i + 1) for i in range(N_DOM, N_DOM + N_B - 1)]
bonds += [(i, i + 1) for i in range(N_DOM + N_B, N - 1)]
top.add_TopologyAttr('bonds', bonds)

tmp = Path(tempfile.mkdtemp())
top.atoms.positions = xyz[0]
top.dimensions = [BOX, BOX, BOX, 90, 90, 90]
top.atoms.write(str(tmp / "top.pdb"))
with XTCWriter(str(tmp / "traj.xtc"), n_atoms=N) as w:
    for k in range(N_FRAMES):
        top.atoms.positions = xyz[k]
        top.dimensions = [BOX, BOX, BOX, 90, 90, 90]
        top.trajectory.ts.time = k * 100.0                # 0.1 ns per frame
        w.write(top.atoms)

import engines.mdanalysis as mdae

_real_plain = mdae._plain_universe


def _fake_plain(ctx):
    u = mda.Universe(str(tmp / "top.pdb"), str(tmp / "traj.xtc"))
    return u


mdae._plain_universe = _fake_plain
_orig_mda_universe = mda.Universe


def _patched_universe(topology, *args, **kw):
    # The engine builds Universes from ctx["tpr"]; redirect to the PDB topology,
    # which carries the bonds unwrap() needs.
    if isinstance(topology, str) and topology.endswith(".tpr"):
        return _orig_mda_universe(str(tmp / "top.pdb"), *args, **kw)
    return _orig_mda_universe(topology, *args, **kw)


mda.Universe = _patched_universe

DOM_RESIDS = f"1-{N_DOM}"
B_RESIDS = f"{N_DOM + 1}-{N_DOM + N_B}"
A_RESIDS = f"{N_DOM + N_B + 1}-{N}"


def run(extra=None):
    params = {
        "helix_a": A_RESIDS, "helix_b": B_RESIDS,
        "fit_selection": f"name CA and resid 1:{N_DOM}",
        "ref_frame": 0, "axis_method": "smoothed",
        "rise_per_residue": 1.5, "rolling_window": 10,
    }
    params.update(extra or {})
    ctx = {"tpr": str(tmp / "x.tpr"), "xtc": str(tmp / "traj.xtc"),
           "groups": [], "time_start": None, "time_end": None, "stride": 1,
           "dt_ps": 100.0, "params": params, "_topology_dir": str(tmp)}
    return asyncio.run(mdae.MDAHelixMotion().run(ctx, tmp, None))


res = run()
ch = {c["key"]: np.array([np.nan if v is None else v for v in c["y"]])
      for c in res["channels"]}
t = np.array(res["x"])

print("1. the planted motion is recovered through drift, rotation and wrapping")
check("piston starts at zero", abs(np.nanmean(ch["piston_A"][:20])) < 0.25,
      f"{np.nanmean(ch['piston_A'][:20]):.3f} A over the static first half")
check(f"piston ends at {PISTON_A} A", abs(ch["piston_A"][-1] - PISTON_A) < 0.3,
      f"{ch['piston_A'][-1]:.3f} A")
check(f"roll ends at {ROLL_DEG} deg", abs(ch["roll_deg"][-1] - ROLL_DEG) < 4.0,
      f"{ch['roll_deg'][-1]:.2f} deg")
check("roll starts at zero", abs(np.nanmean(ch["roll_deg"][:20])) < 3.0,
      f"{np.nanmean(ch['roll_deg'][:20]):.2f} deg")
check("tilt stays near zero (the motion was piston+roll only)",
      np.nanmax(np.abs(ch["tilt_deg"])) < 6.0,
      f"max {np.nanmax(np.abs(ch['tilt_deg'])):.2f} deg")
check("lateral stays near zero", np.nanmax(ch["lateral_A"]) < 0.6,
      f"max {np.nanmax(ch['lateral_A']):.3f} A")
check("piston in residues = piston/1.5",
      abs(ch["piston_res"][-1] - ch["piston_A"][-1] / 1.5) < 1e-9)

print("\n2. the global drift really was removed")
raw = np.linalg.norm(xyz[-1].mean(axis=0) - xyz[0].mean(axis=0))
check("the system itself moved a long way in the box", raw > 5,
      f"centre of mass moved {raw:.1f} A before fitting")
check("  yet the static first half reports almost no piston",
      np.nanstd(ch["piston_A"][:20]) < 0.3,
      f"sd {np.nanstd(ch['piston_A'][:20]):.3f} A")

print("\n3. the A-B channels")
for k in ("interaxis_deg", "centroid_dist_A", "closest_dist_A"):
    check(f"{k} present and finite", k in ch and np.all(np.isfinite(ch[k])))
check("helices A and B are parallel (both built along +z)",
      np.nanmax(np.abs(ch["interaxis_deg"])) < 6.0,
      f"max {np.nanmax(np.abs(ch['interaxis_deg'])):.2f} deg")
check("closest approach never exceeds the centroid distance",
      np.all(ch["closest_dist_A"] <= ch["centroid_dist_A"] + 1e-6))

print("\n4. the result contract")
check("primary series is a plain line result", res["kind"] == "line")
check("  and it is the piston", np.allclose(res["y"], ch["piston_A"], equal_nan=True))
check("  with units on the axis label", "A" in res["ylabel"], res["ylabel"])
check("every channel carries a unit",
      all(c["unit"] for c in res["channels"]),
      [(c["key"], c["unit"]) for c in res["channels"][:3]])
check("channels and x are the same length",
      all(len(c["y"]) == len(res["x"]) for c in res["channels"]))
check("rolling SD channel present", "piston_rolling_sd_A" in ch)
meta = res["helix_meta"]
check("metadata records what was actually measured",
      meta["n_ca_a"] == N_A and meta["n_ca_b"] == N_B
      and meta["axis_method"] == "smoothed" and meta["units"].startswith("angstrom"),
      f"A={meta['n_ca_a']} B={meta['n_ca_b']}")

print("\n5. stride stability")
res2 = run()
ctx2 = dict(stride=2)
params = {"helix_a": A_RESIDS, "helix_b": B_RESIDS,
          "fit_selection": f"name CA and resid 1:{N_DOM}", "ref_frame": 0,
          "rolling_window": 5}
c2 = {"tpr": str(tmp / "x.tpr"), "xtc": str(tmp / "traj.xtc"), "groups": [],
      "time_start": None, "time_end": None, "stride": 2, "dt_ps": 100.0,
      "params": params, "_topology_dir": str(tmp)}
r_s2 = asyncio.run(mdae.MDAHelixMotion().run(c2, tmp, None))
ch2 = {c["key"]: np.array([np.nan if v is None else v for v in c["y"]])
       for c in r_s2["channels"]}
check("stride 2 halves the frame count", len(r_s2["x"]) == (N_FRAMES + 1) // 2,
      f"{len(r_s2['x'])} frames")
check("final piston is the same under stride 2",
      abs(ch2["piston_A"][-1] - ch["piston_A"][-1]) < 0.35,
      f"{ch2['piston_A'][-1]:.3f} vs {ch['piston_A'][-1]:.3f} A")
check("final roll is the same under stride 2",
      abs(ch2["roll_deg"][-1] - ch["roll_deg"][-1]) < 4.0,
      f"{ch2['roll_deg'][-1]:.2f} vs {ch['roll_deg'][-1]:.2f} deg")

print("\n6. the axis sign never flips across the trajectory")
# A flip would show as a ~180 deg jump in tilt or a sign inversion in piston.
check("no 180 deg tilt jumps", np.nanmax(np.abs(np.diff(ch["tilt_deg"]))) < 30,
      f"largest frame-to-frame tilt change {np.nanmax(np.abs(np.diff(ch['tilt_deg']))):.2f} deg")
check("no piston sign inversions", np.nanmax(np.abs(np.diff(ch["piston_A"]))) < 1.0,
      f"largest jump {np.nanmax(np.abs(np.diff(ch['piston_A']))):.3f} A")

print("\n7. options")
r_ev = run({"event_selection": f"name CA and resid {N_DOM + N_B + 1}:{N}"})
ev = {c["key"]: c for c in r_ev["channels"]}
check("an event selection adds an order parameter", "event_rmsd_A" in ev)
check("  measured in A", ev["event_rmsd_A"]["unit"] == "A")
r_auto = run({"auto_core": True, "core_percentile": 60})
check("auto core runs and still recovers the piston",
      abs(np.array([v for v in
                    [c for c in r_auto["channels"] if c["key"] == "piston_A"][0]["y"]
                    ])[-1] - PISTON_A) < 0.5,
      f"{[c for c in r_auto['channels'] if c['key']=='piston_A'][0]['y'][-1]:.3f} A")
r_svd = run({"axis_method": "svd"})
check("the plain-SVD estimator is selectable and runs",
      r_svd["helix_meta"]["axis_method"] == "svd")

print("\n8. refusals")
for bad, expect in [
    ({"helix_a": ""}, "required"),
    ({"ref_frame": 9999}, "outside"),
    ({"helix_a": f"{N}-{N}"}, "at least 3"),
]:
    try:
        run(bad)
        check(f"{list(bad)[0]}={list(bad.values())[0]!r} is refused", False, "ACCEPTED")
    except RuntimeError as e:
        check(f"{list(bad)[0]}={list(bad.values())[0]!r} is refused",
              expect in str(e), str(e).splitlines()[0][:66])

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

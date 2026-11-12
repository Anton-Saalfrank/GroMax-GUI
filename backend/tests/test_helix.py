"""
Helix motion geometry, against cases with an exact known answer.

Every test here is one where the right answer is known in advance — translate an
ideal helix 3 A along its own axis and the piston IS 3, not "about 3". That is
the point: on a real trajectory nobody knows the answer, so a sign error or a
tilt/roll mix-up would look like a finding.
"""
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.helix import (ALPHA_RISE_A, HelixReference, align_rotation,
                        angle_between, axis_segment, frame_metrics, helix_axis,
                        perpendicular_basis, rolling_std, segment_distance,
                        unwrap_degrees, wrap_degrees)

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    # str() first: `if detail` on a numpy array raises "truth value ambiguous".
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


def ideal_helix(n=18, rise=ALPHA_RISE_A, radius=2.3, turn=100.0):
    """An ideal alpha-helix of CA atoms along +z: 1.5 A rise, 100 deg/residue."""
    ang = np.radians(turn) * np.arange(n)
    return np.column_stack([radius * np.cos(ang),
                            radius * np.sin(ang),
                            rise * np.arange(n)])


def rot_about(axis, deg):
    """Rotation matrix about `axis` by `deg` degrees (right-handed)."""
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    t = np.radians(deg)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(t) * K + (1 - np.cos(t)) * (K @ K)


def _spin(ca, axis, deg):
    """Rotate `ca` about `axis` THROUGH ITS OWN CENTROID by `deg`.

    About the centroid, not the origin: rotating about a parallel axis
    elsewhere also translates the helix, which would show up as piston and
    lateral motion that the test did not ask for."""
    c = ca.mean(axis=0)
    return (ca - c) @ rot_about(axis, deg).T + c


H = ideal_helix()
REF = HelixReference(H)

print("1. the axis itself")
axis, centroid = helix_axis(H)
# NOT exactly +z, and that is a property of the estimator rather than a bug: a
# CA's azimuth advances with its height, so x/y covary with z and the fitted
# axis tilts. Quantified in section 1b. Everything below therefore moves the
# helix along ITS OWN axis, which is what "its axis" means.
check("an ideal helix along +z gives an axis close to +z",
      angle_between(axis, np.array([0., 0, 1.])) < 1.0,
      f"{angle_between(axis, np.array([0.,0,1.])):.3f} deg off +z")
check("centroid is the mean CA", np.allclose(centroid, H.mean(axis=0)))
check("axis is a unit vector", abs(np.linalg.norm(axis) - 1) < 1e-12)

# SIGN: the whole point of pinning N->C. Reversing the atom ORDER reverses the
# chemistry, so the axis must flip; an SVD alone would return either sign.
rev_axis, _ = helix_axis(H[::-1])
check("reversing N->C order flips the axis", np.allclose(rev_axis, -axis, atol=1e-6),
      np.round(rev_axis, 4))
# ...but a rigid rotation must NOT flip it, however the SVD happens to resolve.
signs = []
rng = np.random.default_rng(0)
for _ in range(200):
    q = rng.normal(size=4); q /= np.linalg.norm(q)
    w, x, y, z = q
    R = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                  [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                  [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
    a, _c = helix_axis(H @ R.T)
    signs.append(np.dot(a, R @ axis))
check("axis sign is consistent across 200 random orientations",
      all(s > 0.999 for s in signs), f"min alignment {min(signs):.6f}")

try:
    helix_axis(H[:2])
    check("too few CA atoms is refused", False, "ACCEPTED")
except ValueError as e:
    check("too few CA atoms is refused", "at least 3" in str(e), str(e)[:52])

print("\n1b. estimator bias - why 'smoothed' is the default")
# The spec asked for a plain SVD of the CA coordinates. It carries a systematic
# error that is large on short helices, so both estimators are kept and this
# pins the difference instead of leaving it as a claim in a docstring.
_wsvd, _wsm = {}, {}
for _n in (6, 12, 18, 36):
    _es, _em = [], []
    for _ph in np.linspace(0, 2 * np.pi, 25):
        _a = np.radians(100.0) * np.arange(_n) + _ph
        _hh = np.column_stack([2.3 * np.cos(_a), 2.3 * np.sin(_a),
                               ALPHA_RISE_A * np.arange(_n)])
        _es.append(angle_between(helix_axis(_hh, "svd")[0], np.array([0., 0, 1.])))
        _em.append(angle_between(helix_axis(_hh, "smoothed")[0], np.array([0., 0, 1.])))
    _wsvd[_n], _wsm[_n] = max(_es), max(_em)
    print(f"      {_n:>2} residues: svd {max(_es):6.2f} deg   smoothed {max(_em):6.3f} deg")
check("a 6-residue helix is badly biased under plain SVD", _wsvd[6] > 10,
      f"{_wsvd[6]:.1f} deg off the true axis")
check("  and smoothing more than halves it", _wsm[6] < _wsvd[6] / 2,
      f"{_wsm[6]:.1f} vs {_wsvd[6]:.1f} deg")
check("at 12+ residues smoothing is under 0.5 deg",
      all(_wsm[k] < 0.5 for k in (12, 18, 36)),
      {k: round(_wsm[k], 3) for k in (12, 18, 36)})
check("both estimators are selectable",
      not np.allclose(helix_axis(H, "svd")[0], helix_axis(H, "smoothed")[0]))
check("a helix too short to smooth falls back rather than failing",
      helix_axis(ideal_helix(n=4), "smoothed")[0].shape == (3,))

print("\n2. THE SPEC'S CASES")
# translate 3 A along the axis -> piston = 3, tilt ~ 0, roll ~ 0
m = frame_metrics(H + 3.0 * REF.axis, REF)
check("translate 3 A along the axis -> piston = 3.000",
      abs(m["piston_A"] - 3.0) < 1e-9, f"{m['piston_A']:.9f} A")
check("  -> and in residues = 3/1.5 = 2.000",
      abs(m["piston_res"] - 2.0) < 1e-9, f"{m['piston_res']:.6f} res")
check("  -> tilt = 0", abs(m["tilt_deg"]) < 1e-6, f"{m['tilt_deg']:.2e} deg")
check("  -> roll = 0", abs(m["_roll_raw_deg"]) < 1e-6, f"{m['_roll_raw_deg']:.2e} deg")
check("  -> lateral = 0", abs(m["lateral_A"]) < 1e-9, f"{m['lateral_A']:.2e} A")

# rotate 100 deg about the axis -> roll = 100, piston ~ 0
m = frame_metrics(_spin(H, REF.axis, 100.0), REF)
check("rotate 100 deg about the axis -> roll = 100.000",
      abs(m["_roll_raw_deg"] - 100.0) < 1e-6, f"{m['_roll_raw_deg']:.9f} deg")
check("  -> piston = 0", abs(m["piston_A"]) < 1e-9, f"{m['piston_A']:.2e} A")
check("  -> tilt = 0", abs(m["tilt_deg"]) < 1e-6, f"{m['tilt_deg']:.2e} deg")

# a random GLOBAL rigid-body transform, after fitting, changes nothing
base = frame_metrics(H + 3.0 * REF.axis, REF)
worst = 0.0
for _ in range(50):
    q = rng.normal(size=4); q /= np.linalg.norm(q)
    w, x, y, z = q
    R = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                  [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                  [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
    t = rng.normal(size=3) * 25
    # Fitting maps the frame back onto the reference domain, which for a rigid
    # transform is exactly its inverse — so apply the transform to BOTH the
    # moved helix and the reference, i.e. measure in the fitted frame.
    moved = (H + 3.0 * REF.axis) @ R.T + t
    ref_moved = HelixReference(H @ R.T + t)
    mm = frame_metrics(moved, ref_moved)
    for k in ("piston_A", "lateral_A", "tilt_deg", "_roll_raw_deg"):
        worst = max(worst, abs(mm[k] - base[k]))
check("a random global rigid transform leaves every metric unchanged",
      worst < 1e-6, f"max drift {worst:.2e} over 50 transforms")

print("\n3. tilt must not leak into roll (the trap)")
# Tilt the helix 25 degrees about x, with NO rotation about its own axis.
tilted = _spin(H, np.cross(REF.axis, [1., 0, 0]), 25.0)
m = frame_metrics(tilted, REF)
check("pure 25 deg tilt is measured as tilt", abs(m["tilt_deg"] - 25.0) < 1e-6,
      f"{m['tilt_deg']:.6f} deg")
check("  and reports roll ~ 0, not a spurious rotation",
      abs(m["_roll_raw_deg"]) < 1e-6, f"roll {m['_roll_raw_deg']:.2e} deg")
# The naive version — azimuth in the reference plane without realigning the
# axis — gets this wrong. Demonstrate the size of the error it would make.
v = tilted[0] - tilted.mean(axis=0)
perp = v - np.dot(v, REF.axis) * REF.axis
naive = np.degrees(np.arctan2(np.dot(perp, REF.e2), np.dot(perp, REF.e1)) - REF.phase0)
check("  (a naive projection would have reported a large false roll)",
      abs(naive) > 1.0, f"naive roll would be {naive:.2f} deg")

# tilt and roll together are both recovered
both = _spin(_spin(H, REF.axis, 40.0), np.cross(REF.axis, [1., 0, 0]), 15.0)
m = frame_metrics(both, REF)
check("tilt 15 + roll 40 together -> tilt 15", abs(m["tilt_deg"] - 15.0) < 1e-6,
      f"{m['tilt_deg']:.4f}")
check("  -> roll 40", abs(m["_roll_raw_deg"] - 40.0) < 1e-4,
      f"{m['_roll_raw_deg']:.4f}")

print("\n4. the roll reference atom should cancel")
rolls = []
for idx in (0, 5, 9, 17):
    r = HelixReference(H, roll_atom_index=idx)
    rolls.append(frame_metrics(_spin(H, r.axis, 73.0), r)["_roll_raw_deg"])
check("roll is 73 deg whichever CA is used as the phase reference",
      max(abs(np.array(rolls) - 73.0)) < 1e-6, f"{np.round(rolls, 6)}")

print("\n4b. wrapping a single frame")
check("a 100 deg roll is not reported as -260",
      abs(wrap_degrees(-260.0) - 100.0) < 1e-12, wrap_degrees(-260.0))
check("180 stays 180, not -180", abs(wrap_degrees(180.0) - 180.0) < 1e-12)
check("-180 folds to 180", abs(wrap_degrees(-180.0) - 180.0) < 1e-12)
check("NaN survives as NaN", np.isnan(wrap_degrees(float("nan"))))
check("a full turn is zero", abs(wrap_degrees(360.0)) < 1e-12)

print("\n5. unwrapping")
raw = [170.0, 175.0, 179.0, -179.0, -175.0]
un = unwrap_degrees(raw)
check("a roll passing 180 deg keeps going up, not back",
      np.all(np.diff(un) > 0), np.round(un, 1))
check("  and the total is ~15 deg, not ~345",
      abs((un[-1] - un[0]) - 15.0) < 1e-6, f"{un[-1]-un[0]:.2f} deg")

print("\n6. the A-B pair quantities")
A = ideal_helix(n=12)
B = ideal_helix(n=12) + np.array([10.0, 0, 0])          # parallel, 10 A apart
ref = HelixReference(A)
m = frame_metrics(A, ref, ca_b=B)
check("parallel helices -> inter-axis angle 0", abs(m["interaxis_deg"]) < 1e-6,
      f"{m['interaxis_deg']:.2e}")
check("centroid distance = 10.000", abs(m["centroid_dist_A"] - 10.0) < 1e-9,
      f"{m['centroid_dist_A']:.6f} A")
check("closest approach of parallel axes = 10.000",
      abs(m["closest_dist_A"] - 10.0) < 1e-3, f"{m['closest_dist_A']:.6f} A")

Bp = _spin(ideal_helix(n=12), [1., 0, 0], 90.0) + np.array([10.0, 0, 0])
m = frame_metrics(A, ref, ca_b=Bp)
check("perpendicular helices -> inter-axis angle 90",
      abs(m["interaxis_deg"] - 90.0) < 0.5, f"{m['interaxis_deg']:.4f} deg")

print("\n7. closest approach uses SEGMENTS, not infinite lines")
# Two short, skewed helices whose infinite axes nearly meet but whose actual
# extents are far apart. An infinite-line distance would report ~0.
p0, p1 = np.array([0., 0., 0.]), np.array([1., 0., 0.])
q0, q1 = np.array([50., -1., 0.]), np.array([50., 1., 0.])
d_seg = segment_distance(p0, p1, q0, q1)
check("segments that never approach report their real gap",
      abs(d_seg - 49.0) < 1e-6, f"{d_seg:.4f} A (infinite lines would give 0)")
check("crossing segments report 0",
      segment_distance(np.array([-1., 0., 0.]), np.array([1., 0., 0.]),
                       np.array([0., -1., 0.]), np.array([0., 1., 0.])) < 1e-9)
check("identical segments report 0",
      segment_distance(p0, p1, p0, p1) < 1e-9)
check("parallel offset segments report the offset",
      abs(segment_distance(p0, p1, p0 + np.array([0., 4., 0.]),
                           p1 + np.array([0., 4., 0.])) - 4.0) < 1e-9)
ax_a, c_a = helix_axis(A)
s0, s1 = axis_segment(A, ax_a, c_a)
check("the axis segment spans the helix, no further",
      abs(np.linalg.norm(s1 - s0) - (ALPHA_RISE_A * 11)) < 0.05,
      f"{np.linalg.norm(s1-s0):.4f} A for 12 residues (ideal {ALPHA_RISE_A*11:.2f})")

print("\n8. helpers")
check("align_rotation maps src onto dst",
      np.allclose(align_rotation(np.array([1., 0, 0]), np.array([0., 1, 0]))
                  @ np.array([1., 0, 0]), [0, 1, 0], atol=1e-12))
check("  identity when already aligned",
      np.allclose(align_rotation(np.array([0., 0, 1]), np.array([0., 0, 1])), np.eye(3)))
anti = align_rotation(np.array([0., 0, 1.]), np.array([0., 0, -1.]))
check("  antiparallel is handled (no NaN)",
      np.all(np.isfinite(anti)) and np.allclose(anti @ [0, 0, 1.], [0, 0, -1], atol=1e-12))
check("  and stays a proper rotation (det = +1)",
      abs(np.linalg.det(anti) - 1.0) < 1e-9, f"det {np.linalg.det(anti):.6f}")
for seed_axis in ([1., 0, 0], [0, 1., 0], [0, 0, 1.], [1, 1, 1.]):
    e1, e2 = perpendicular_basis(np.array(seed_axis, float))
    a = np.array(seed_axis, float); a /= np.linalg.norm(a)
    ok = (abs(np.dot(e1, a)) < 1e-12 and abs(np.dot(e2, a)) < 1e-12
          and abs(np.dot(e1, e2)) < 1e-12)
    check(f"perpendicular_basis is orthonormal for axis {seed_axis}", ok)
check("angle_between is clamped (no domain error on identical vectors)",
      abs(angle_between(np.array([1., 0, 0]), np.array([1., 0, 0]))) < 1e-9)

print("\n9. rolling standard deviation")
vals = [0.0] * 10 + [5.0] * 10
rs = rolling_std(vals, 4)
check("flat regions have zero spread", abs(rs[2]) < 1e-12 and abs(rs[17]) < 1e-12)
check("the step shows as a peak", rs[10] > 2.0, f"{rs[10]:.3f}")
check("edges are NaN, not a short-window value",
      np.isnan(rs[0]) and np.isnan(rs[-1]))
check("a window longer than the series is all NaN",
      all(np.isnan(v) for v in rolling_std([1., 2., 3.], 10)))

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

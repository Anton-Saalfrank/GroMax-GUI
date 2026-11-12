"""
Helix motion geometry — piston, tilt, roll of one helix against a reference.

Pure numpy, no MDAnalysis: every quantity here is a function of coordinates, so
it can be tested against cases with an exact known answer (translate by 3 A,
rotate by 100 degrees) rather than only against a trajectory where nobody knows
the right answer in advance.

UNITS: angstrom and degrees throughout, matching the spec. The rest of this app
plots nanometres, so anything leaving this module is labelled explicitly.

THE ONE SUBTLETY THAT MATTERS: ROLL AND TILT ARE NOT INDEPENDENT

Roll is the rotation of the helix about its own axis. The obvious implementation
— project a reference CA onto the plane normal to the REFERENCE axis and take
its azimuth — is wrong as soon as the helix tilts, because the atom is then
being projected onto a plane the helix no longer lies in. Part of the tilt shows
up as roll, and the two measurements stop being separable.

So each frame's axis is first rotated onto the reference axis by the minimal
rotation, and the azimuth is measured after that. What remains is rotation about
the axis and nothing else. This is why a pure-tilt motion reports roll ~ 0 here
(test_helix.py checks exactly that), and why a naive implementation does not.
"""
from __future__ import annotations

import numpy as np

# Rise per residue along an ideal alpha-helix, in angstrom. Only valid for an
# alpha-helix: 3-10 helices rise ~2.0 A per residue and pi-helices ~1.15, so a
# piston expressed in "residues" is meaningless for those. Exposed as a
# parameter rather than hard-coded for that reason.
ALPHA_RISE_A = 1.5


# Residues per turn of an alpha-helix (100 degrees per residue). Used as the
# smoothing width: averaging consecutive CA positions over ~one turn cancels
# their radial excursion and leaves a point on the axis.
TURN_RESIDUES = 4


def helix_axis(ca: np.ndarray, method: str = "smoothed") -> tuple[np.ndarray, np.ndarray]:
    """
    Principal axis and centroid of a set of CA coordinates.

    Returns (unit axis, centroid).

    TWO ESTIMATORS, AND WHY THE DEFAULT IS NOT THE OBVIOUS ONE

    "svd" takes the first right-singular vector of the centred CA coordinates —
    the direction of greatest extent. It is the textbook answer and it carries a
    systematic error that is easy to miss: a CA atom's azimuth advances with its
    height, so the x/y coordinates covary with z, and the principal axis tilts
    away from the true helical axis. Measured against ideal helices, worst case
    over the starting phase:

        residues     6      9     12     18     24     36     50     80
        svd       19.2   0.97   2.32   2.22   0.65   0.54   0.26   0.08   deg
        smoothed   9.6   1.37   0.09   0.29   0.16   0.06   0.03   0.004 deg

    Nineteen degrees on a six-residue helix is not a rounding error. "smoothed"
    first averages CA positions over one turn, which cancels the radial
    component, then fits the axis through those local axis points.

    Most reported quantities are differences against the reference frame, where
    a systematic bias largely cancels; the ones that do not are absolute angles
    — tilt and especially the inter-axis angle to helix B. Hence the default.
    "svd" remains available for exact comparability with other tools.

    SIGN: an SVD returns an axis of arbitrary sign, and a sign that flips
    between frames turns a smooth tilt into a 180 degree sawtooth and inverts
    the piston. It is pinned N->C from the first-to-last CA vector, which is a
    property of the molecule rather than of the numerics, so it is stable across
    frames by construction.
    """
    if ca.ndim != 2 or ca.shape[1] != 3:
        raise ValueError(f"Expected (n_atoms, 3) coordinates, got {ca.shape}")
    if len(ca) < 3:
        raise ValueError(
            f"A helix axis needs at least 3 CA atoms; got {len(ca)}. "
            f"Check the residue range covers a helix.")

    centroid = ca.mean(axis=0)

    points = ca
    if method == "smoothed" and len(ca) >= TURN_RESIDUES + 2:
        # Running mean over one turn. Needs at least two such windows to fit a
        # line through, hence the +2; below that it falls back to the raw SVD,
        # which is no worse and is at least the documented behaviour.
        w = TURN_RESIDUES
        points = np.array([ca[i:i + w].mean(axis=0)
                           for i in range(len(ca) - w + 1)])

    _u, _s, vt = np.linalg.svd(points - points.mean(axis=0), full_matrices=False)
    axis = vt[0]

    n_to_c = ca[-1] - ca[0]
    if np.dot(axis, n_to_c) < 0:
        axis = -axis
    norm = np.linalg.norm(axis)
    if norm == 0:
        raise ValueError("Degenerate helix axis (all CA atoms coincide).")
    # The centroid stays the plain CA mean regardless of estimator: it is where
    # the helix IS, and smoothing shortens the point set at both ends, which
    # would shift it.
    return axis / norm, centroid


def perpendicular_basis(axis: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Two orthonormal vectors spanning the plane normal to `axis`.

    The seed is chosen as whichever cardinal direction is least aligned with the
    axis: seeding with a fixed vector produces a near-zero cross product when
    the axis happens to lie along it, and the basis then becomes numerical noise.
    """
    a = axis / np.linalg.norm(axis)
    seed = np.eye(3)[int(np.argmin(np.abs(a)))]
    e1 = np.cross(a, seed)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(a, e1)
    return e1, e2 / np.linalg.norm(e2)


def align_rotation(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """
    The minimal rotation matrix taking unit vector `src` onto unit vector `dst`.

    Rodrigues' formula. Handles both degenerate cases explicitly: already
    aligned (identity) and exactly antiparallel, where the rotation axis is
    undefined and any perpendicular will do.
    """
    a = src / np.linalg.norm(src)
    b = dst / np.linalg.norm(dst)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    s = float(np.linalg.norm(v))
    if s < 1e-12:
        if c > 0:
            return np.eye(3)
        # Antiparallel: rotate by pi about any axis perpendicular to a.
        perp = perpendicular_basis(a)[0]
        return -np.eye(3) + 2 * np.outer(perp, perp)
    vx = np.array([[0, -v[2], v[1]],
                   [v[2], 0, -v[0]],
                   [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / (s * s))


def roll_phase(ca_point: np.ndarray, centroid: np.ndarray, axis: np.ndarray,
               ref_axis: np.ndarray, e1: np.ndarray, e2: np.ndarray) -> float:
    """
    Azimuth of one CA about the helix axis, in radians, measured in the
    REFERENCE frame's perpendicular basis.

    The frame's axis is rotated onto the reference axis first — see the module
    docstring. Without that step a pure tilt leaks into roll.
    """
    rot = align_rotation(axis, ref_axis)
    v = rot @ (ca_point - centroid)
    perp = v - np.dot(v, ref_axis) * ref_axis
    if np.linalg.norm(perp) < 1e-9:
        # The reference atom sits on the axis; its azimuth is undefined.
        return float("nan")
    return float(np.arctan2(np.dot(perp, e2), np.dot(perp, e1)))


def unwrap_degrees(phases_deg) -> np.ndarray:
    """
    Remove +-360 jumps from a sequence of angles.

    A helix rolling steadily past 180 degrees would otherwise appear to snap
    back to -180, which reads as a large, fast counter-rotation that never
    happened.
    """
    return np.degrees(np.unwrap(np.radians(np.asarray(phases_deg, dtype=float))))


def angle_between(u: np.ndarray, v: np.ndarray) -> float:
    """Angle between two vectors, in degrees, clamped against domain error."""
    cu = u / np.linalg.norm(u)
    cv = v / np.linalg.norm(v)
    return float(np.degrees(np.arccos(np.clip(np.dot(cu, cv), -1.0, 1.0))))


def axis_segment(ca: np.ndarray, axis: np.ndarray,
                 centroid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    The helix axis as a finite SEGMENT rather than an infinite line.

    Endpoints are the extreme projections of the CA atoms onto the axis, so the
    segment spans the helix and no further. This matters for closest approach:
    two short helices side by side have infinite lines that may intersect
    somewhere outside either molecule, giving a distance of zero for helices
    that never touch.
    """
    t = (ca - centroid) @ axis
    return centroid + t.min() * axis, centroid + t.max() * axis


def segment_distance(p0: np.ndarray, p1: np.ndarray,
                     q0: np.ndarray, q1: np.ndarray) -> float:
    """
    Closest approach between two line SEGMENTS.

    The standard clamped-parameter solution: solve for the closest points on the
    infinite lines, then clamp each parameter to its segment and re-solve the
    other. Parallel segments are handled by the degenerate-denominator branch.
    """
    u = p1 - p0
    v = q1 - q0
    w = p0 - q0
    a, b, c = np.dot(u, u), np.dot(u, v), np.dot(v, v)
    d, e = np.dot(u, w), np.dot(v, w)
    denom = a * c - b * b

    if denom < 1e-12:                 # parallel (or a degenerate segment)
        sc = 0.0
        tc = (e / c) if c > 1e-12 else 0.0
    else:
        sc = (b * e - c * d) / denom
        tc = (a * e - b * d) / denom

    sc = float(np.clip(sc, 0.0, 1.0))
    # Re-solve the other parameter against the clamped one, then clamp it too;
    # clamping both independently would miss the true closest pair whenever the
    # unclamped solution falls outside a segment.
    tc = (np.dot(v, w + sc * u) / c) if c > 1e-12 else 0.0
    tc = float(np.clip(tc, 0.0, 1.0))
    sc = (np.dot(u, (q0 + tc * v) - p0) / a) if a > 1e-12 else 0.0
    sc = float(np.clip(sc, 0.0, 1.0))

    return float(np.linalg.norm((p0 + sc * u) - (q0 + tc * v)))


def wrap_degrees(a: float) -> float:
    """
    Fold an angle into (-180, 180].

    A roll is the DIFFERENCE of two atan2 phases, so it arrives anywhere in
    (-720, 720). A 100 degree rotation came back as -260 before this existed —
    the same angle, but it reads as a large rotation the other way, and the
    across-frame unwrap would then start from the wrong branch and stay there.
    """
    if not np.isfinite(a):
        return float("nan")
    w = (a + 180.0) % 360.0 - 180.0
    # The modulo lands exactly 180 on -180, which is the OPEN end of the stated
    # interval. Folding it back keeps the contract the docstring promises, so a
    # caller reasoning about the range is not quietly wrong at the boundary.
    return float(180.0 if w == -180.0 else w)


class HelixReference:
    """
    The reference frame's geometry, against which every other frame is measured.

    Built once so the per-frame loop does no redundant work, and so the thing
    everything is relative to is explicit rather than implied by a loop index.
    """

    def __init__(self, ca_a: np.ndarray, roll_atom_index: int = 0,
                 method: str = "smoothed"):
        self.method = method
        self.axis, self.centroid = helix_axis(ca_a, method)
        self.e1, self.e2 = perpendicular_basis(self.axis)
        self.roll_atom_index = int(roll_atom_index)
        self.phase0 = roll_phase(ca_a[self.roll_atom_index], self.centroid,
                                 self.axis, self.axis, self.e1, self.e2)


def frame_metrics(ca_a: np.ndarray, ref: HelixReference,
                  ca_b: np.ndarray | None = None,
                  rise_a: float = ALPHA_RISE_A) -> dict:
    """
    Every per-frame quantity for one frame, in angstrom and degrees.

    `ca_a` and `ca_b` must already be fitted onto the reference domain —
    measuring these on unfitted coordinates reports the molecule's motion
    through the box, not helix A's motion relative to the domain.
    """
    axis, centroid = helix_axis(ca_a, ref.method)
    disp = centroid - ref.centroid

    piston = float(np.dot(disp, ref.axis))
    lateral = float(np.linalg.norm(disp - piston * ref.axis))
    tilt = angle_between(axis, ref.axis)
    phase = roll_phase(ca_a[ref.roll_atom_index], centroid, axis,
                       ref.axis, ref.e1, ref.e2)

    out = {
        "piston_A": piston,
        "piston_res": piston / rise_a if rise_a else float("nan"),
        "lateral_A": lateral,
        "tilt_deg": tilt,
        # Raw phase relative to the reference; unwrapped across frames by the
        # caller, which is the only place the time ordering is known.
        # Wrapped to (-180, 180] here; unwrapped ACROSS frames by the caller,
        # which is the only place the time ordering is known.
        "_roll_raw_deg": wrap_degrees(np.degrees(phase - ref.phase0)),
    }

    if ca_b is not None:
        axis_b, centroid_b = helix_axis(ca_b, ref.method)
        pa0, pa1 = axis_segment(ca_a, axis, centroid)
        pb0, pb1 = axis_segment(ca_b, axis_b, centroid_b)
        out["interaxis_deg"] = angle_between(axis, axis_b)
        out["centroid_dist_A"] = float(np.linalg.norm(centroid - centroid_b))
        out["closest_dist_A"] = segment_distance(pa0, pa1, pb0, pb1)
    return out


def rolling_std(values, window: int) -> list[float]:
    """
    Rolling standard deviation, centred, NaN where the window does not fit.

    NaN rather than a shorter window at the edges: a standard deviation from
    three points plotted next to one from fifty looks like a real drop in
    variability at the start and end of every run.
    """
    v = np.asarray(values, dtype=float)
    w = max(2, int(window))
    out = np.full(v.shape, np.nan)
    if w > len(v):
        return out.tolist()
    half = w // 2
    for i in range(len(v)):
        lo, hi = i - half, i - half + w
        if lo < 0 or hi > len(v):
            continue
        block = v[lo:hi]
        block = block[np.isfinite(block)]
        if block.size >= 2:
            out[i] = block.std(ddof=1)
    return out.tolist()

"""
Void volume in a defined region, frame by frame.

THE QUESTION THIS ANSWERS
A mutation that removes a large side chain (Tyr -> Cys) leaves the space it
occupied behind. Does that space stay empty, collapse, or grow into a channel?
A surface rendering shows it; a number is needed to compare conditions and to
correlate the opening with anything else.

WHY A GRID AND NOT A DISTANCE
Distances between the lining residues answer a different question. Two residues
can move apart while the gap between them stays plugged by a third side chain,
and they can stay put while a cavity opens behind them. The volume of empty
space is the thing being asked about, so it is the thing measured.

THE THREE WAYS A VOID MEASUREMENT GOES WRONG, AND WHAT IS DONE ABOUT THEM

 1. BULK SOLVENT COUNTS AS A CAVITY. Any point outside the protein is "empty",
    so a naive void count in a box around a surface residue mostly measures the
    solvent around it. Every candidate point is therefore tested for
    BURIEDNESS: rays are cast in many directions and the point is kept only if
    protein blocks most of them. This is the LIGSITE/PocketPicker criterion.

 2. THE ANSWER DEPENDS ON HOW THE MOLECULE HAPPENS TO BE ORIENTED. A protein
    tumbles during a simulation. A grid fixed to the lab frame, or rays cast
    along grid axes, make the measured volume wobble with the tumbling and that
    wobble is indistinguishable from the cavity breathing. The region here is a
    SPHERE (rotationally invariant by construction) and the rays are a
    Fibonacci sphere (near-isotropic), so rotating the system does not change
    the answer. test_cavity.py checks this explicitly.

 3. UNRELATED VOIDS GET ADDED IN. A region of any useful size contains other
    small packing defects. Only the connected component reachable from the seed
    is counted, so the number tracks ONE cavity rather than the local porosity.

UNITS: Angstrom and cubic Angstrom throughout, matching the rest of the
MDAnalysis engine. 1 A^3 = 0.001 nm^3.
"""
from __future__ import annotations

import numpy as np

# Bondi van der Waals radii (A). Hydrogens are explicit, so carbon keeps its
# bare-atom 1.70 rather than a united-atom value.
VDW_RADII = {
    "H": 1.20, "C": 1.70, "N": 1.55, "O": 1.52, "S": 1.80, "P": 1.80,
    "F": 1.47, "CL": 1.75, "BR": 1.85, "I": 1.98,
    "NA": 2.27, "K": 2.75, "MG": 1.73, "CA": 2.31, "ZN": 1.39, "FE": 2.00,
}
DEFAULT_RADIUS = 1.70


# Residues that ARE a single ion. Needed because an ion's atom name is its
# element, while a protein atom's name is not: 'CA' is calcium in a CAL/CA
# residue and the alpha carbon in every one of the twenty amino acids. Reading
# the name alone would hand a 2.31 A calcium radius to every backbone carbon in
# the protein — the single most common atom there is.
_ION_RESNAMES = {
    "SOD": "NA", "NA": "NA", "NA+": "NA",
    "POT": "K", "K": "K", "K+": "K",
    "CLA": "CL", "CL": "CL", "CL-": "CL",
    "CAL": "CA", "CA": "CA", "CA2": "CA",
    "ZN": "ZN", "ZN2": "ZN", "MG": "MG", "MG2": "MG",
    "FE": "FE", "FE2": "FE", "FE3": "FE",
    "BR": "BR", "IOD": "I", "I": "I",
}


def element_of(name: str, resname: str | None = None) -> str:
    """
    The element of an atom, from its name and the residue it belongs to.

    The first alphabetic character of the name is the PDB/CHARMM/AMBER
    convention and handles 'HB2', '1HB', 'SD', 'OE1'. Deliberately not
    mass-based: hydrogen mass repartitioning moves hydrogens to ~3 u and a
    methyl carbon down to ~6 u, so mass thresholds mislabel an HMR topology in
    both directions.

    A monatomic ion is the exception — there the name is the element — and is
    recognised from the RESIDUE name, never from the atom name, for the 'CA'
    reason above.
    """
    if resname is not None:
        rn = str(resname).strip().upper()
        if rn in _ION_RESNAMES:
            return _ION_RESNAMES[rn]
    s = str(name).strip().upper()
    letters = "".join(c for c in s if c.isalpha())
    return letters[0] if letters else "C"


def radii_for(names, resnames=None) -> np.ndarray:
    """vdW radius per atom. `resnames` is optional but should be passed
    whenever it is available — see element_of."""
    if resnames is None:
        resnames = [None] * len(names)
    return np.array([VDW_RADII.get(element_of(n, rn), DEFAULT_RADIUS)
                     for n, rn in zip(names, resnames)], dtype=float)


def fibonacci_directions(n: int) -> np.ndarray:
    """
    n near-uniformly spread unit vectors.

    Near-uniform matters: the 6 grid axes, or the 26 directions of a cube, are
    aligned with nothing physical, so buriedness measured along them changes as
    the molecule rotates. A Fibonacci sphere has no preferred axis.
    """
    n = max(6, int(n))
    i = np.arange(n) + 0.5
    phi = np.arccos(1.0 - 2.0 * i / n)
    theta = np.pi * (1.0 + 5.0 ** 0.5) * i
    return np.stack([np.cos(theta) * np.sin(phi),
                     np.sin(theta) * np.sin(phi),
                     np.cos(phi)], axis=1)


# Diagnostics returned alongside the volume. A zero is ambiguous on its own —
# it can mean the cavity collapsed, or that the void is there but too small for
# the probe, or too far from the seed, or not buried enough to count. These say
# which, without which tuning the parameters is guesswork.
_DIAG = {"n_void_raw": 0, "n_buried": 0, "max_clearance_A": 0.0,
         "nearest_void_A": float("inf"), "nearest_buried_A": float("inf")}


def _empty(reason: str, **diag) -> dict:
    out = {"volume_A3": 0.0, "n_points": 0, "open_to_bulk": False,
           "max_sphere_A": 0.0, "n_components": 0,
           "points": np.zeros((0, 3)), "reason": reason}
    out.update(_DIAG)
    out.update(diag)
    return out


def cavity_frame(wall_xyz, wall_radii, centre, *, probe=1.4, spacing=0.7,
                 region=10.0, burial=0.65, n_rays=50, ray_length=10.0,
                 seed_radius=6.0, require_connected=True,
                 include_xyz=None, include_radius=5.0) -> dict:
    """
    Volume of the void connected to `centre`, within `region` of it.

    wall_xyz / wall_radii — the atoms that form the walls, and their vdW radii.
    centre                — the seed, usually the centroid of the mutated residue.
    probe                 — radius of the sphere that has to fit (1.4 A = water).
    spacing               — grid spacing; the volume quantum is spacing**3.
    burial                — fraction of rays that must hit protein for a point
                            to count as inside the structure rather than in
                            bulk solvent.

    Returns the volume, whether the void reaches the edge of the region (so it
    is open rather than enclosed), the largest sphere that fits inside it, and
    the points themselves, which the caller uses to count the waters in it.
    """
    from scipy.spatial import cKDTree
    from scipy import ndimage

    centre = np.asarray(centre, dtype=float).reshape(3)
    wall_xyz = np.asarray(wall_xyz, dtype=float)
    wall_radii = np.asarray(wall_radii, dtype=float)
    if wall_xyz.size == 0:
        return _empty("no wall atoms")

    # The rays have to see protein beyond the region, or every point near the
    # region edge would look unburied for lack of anything to hit.
    half = float(region) + float(ray_length)
    n = int(np.ceil(2 * half / spacing)) + 1
    ax = (np.arange(n) - (n - 1) / 2.0) * spacing
    rel = np.stack(np.meshgrid(ax, ax, ax, indexing="ij"), axis=-1)  # (n,n,n,3)
    rel_flat = rel.reshape(-1, 3)
    pts_flat = rel_flat + centre

    # Only atoms that can reach the grid matter. On a solvated system this is
    # the difference between a few thousand atoms and a few hundred thousand.
    reach = half * np.sqrt(3.0) + wall_radii.max() + probe + spacing
    near = np.linalg.norm(wall_xyz - centre, axis=1) <= reach
    xyz, rad = wall_xyz[near], wall_radii[near]
    if len(xyz) == 0:
        return _empty("no wall atoms within the region")

    # Clearance: distance from each grid point to the nearest vdW SURFACE.
    # Taking the k nearest atom centres and subtracting their own radii is what
    # makes this exact for differing radii — the nearest centre is not always
    # the nearest surface.
    tree = cKDTree(xyz)
    k = int(min(12, len(xyz)))
    d, idx = tree.query(pts_flat, k=k,
                        distance_upper_bound=float(rad.max() + 5.0))
    if k == 1:                      # query() drops the k axis for k == 1
        d, idx = d[:, None], idx[:, None]
    finite = np.isfinite(d)
    safe_idx = np.where(finite, np.minimum(idx, len(xyz) - 1), 0)
    clearance = np.where(finite, d - rad[safe_idx], np.inf).min(axis=1)

    void = clearance >= probe
    void3 = void.reshape(n, n, n)

    # Candidates: void, and inside the region proper (not the ray margin).
    r_from_centre = np.linalg.norm(rel_flat, axis=1)
    in_region = r_from_centre <= region

    # A REGION DEFINED BY RESIDUES RATHER THAN BY A POINT.
    #
    # A seed point is a poor handle on a cavity. The centroid of a side chain
    # lies INSIDE that side chain — measured on a real system, 1.0 to 1.3 A
    # inside the nearest vdW surface — so the void can never start closer than
    # about 2.5 A, and whatever is nearest within the seed radius gets counted,
    # which may be an adjacent pocket. Worse for a mutation study: the centroid
    # of a tyrosine side chain and of a cysteine side chain are in different
    # places, so the two conditions are probed at different points.
    #
    # Naming the residues that LINE the cavity avoids all of it. The region is
    # the space within include_radius of those atoms, which is the same
    # definition in every condition because the residues are the same.
    if include_xyz is not None and len(include_xyz):
        inc = np.asarray(include_xyz, dtype=float)
        inc_tree = cKDTree(inc)
        near_inc = np.array(
            inc_tree.query_ball_point(pts_flat, float(include_radius),
                                      return_length=True)) > 0
        in_region = in_region & near_inc

    cand_flat = np.flatnonzero(void & in_region)

    # How much space is there at all, before anything is filtered? Measured on
    # the FULL grid clearance, so "the void is there but the probe will not fit"
    # is distinguishable from "there is no void".
    clear_region = clearance[in_region]
    clear_region = clear_region[np.isfinite(clear_region)]
    diag = {
        "n_void_raw": int(cand_flat.size),
        "max_clearance_A": float(clear_region.max()) if clear_region.size else 0.0,
        "nearest_void_A": (float(np.linalg.norm(
            pts_flat[cand_flat] - centre, axis=1).min())
            if cand_flat.size else float("inf")),
    }
    if cand_flat.size == 0:
        return _empty("no empty space in the region", **diag)

    # ── Buriedness ───────────────────────────────────────────────────────────
    dirs = fibonacci_directions(n_rays)
    n_steps = max(1, int(round(ray_length / spacing)))
    steps = (np.arange(1, n_steps + 1) * spacing).astype(np.float32)
    origin = centre - half
    cand_pts = pts_flat[cand_flat]
    occupied3 = ~void3

    keep_mask = np.zeros(cand_flat.size, dtype=bool)
    chunk = 4096
    for s0 in range(0, cand_flat.size, chunk):
        block = cand_pts[s0:s0 + chunk].astype(np.float32)          # (m,3)
        # (m, rays, steps, 3) sample points along every ray
        samp = (block[:, None, None, :]
                + dirs.astype(np.float32)[None, :, None, :]
                * steps[None, None, :, None])
        ijk = np.rint((samp - origin.astype(np.float32)) / spacing).astype(np.int32)
        np.clip(ijk, 0, n - 1, out=ijk)
        hit = occupied3[ijk[..., 0], ijk[..., 1], ijk[..., 2]]       # (m,rays,steps)
        blocked = hit.any(axis=2)                                   # (m,rays)
        keep_mask[s0:s0 + chunk] = blocked.mean(axis=1) >= burial

    diag["n_buried"] = int(keep_mask.sum())
    if not keep_mask.any():
        return _empty("the empty space here is open solvent, not a cavity", **diag)

    # ── One cavity, not the local porosity ───────────────────────────────────
    buried3 = np.zeros(n * n * n, dtype=bool)
    buried3[cand_flat[keep_mask]] = True
    buried3 = buried3.reshape(n, n, n)
    labels, n_lab = ndimage.label(buried3)          # 6-connectivity
    lab_flat = labels.reshape(-1)

    kept_flat = cand_flat[keep_mask]
    kept_pts = pts_flat[kept_flat]
    d_seed = np.linalg.norm(kept_pts - centre, axis=1)
    j = int(np.argmin(d_seed))
    diag["nearest_buried_A"] = float(d_seed[j])
    # The seed-proximity rule exists to stop a point seed grabbing a distant
    # pocket. A lining-defined region already says exactly which space counts,
    # so applying it there as well would reject the cavity for being far from a
    # seed that is not defining anything — measured: a correct lining with the
    # seed placed on the far side returned 0 A^3.
    if include_xyz is None and d_seed[j] > seed_radius:
        return _empty(f"no cavity within {seed_radius:g} A of the seed "
                      f"(nearest is {d_seed[j]:.1f} A)", **diag)

    if require_connected:
        seed_label = lab_flat[kept_flat[j]]
        sel = lab_flat[kept_flat] == seed_label
    else:
        # Every buried void point in the region, connected to the seed or not.
        sel = np.ones(kept_flat.size, dtype=bool)
    pts_in = kept_pts[sel]

    # The largest sphere that fits, measured EXACTLY on the cavity points.
    #
    # The grid-wide query above is bounded for speed, so any point further than
    # that bound from every atom comes back as infinite clearance — which is
    # precisely what happens at the centre of a large cavity, the one place
    # this number is read. Re-querying the few thousand selected points without
    # a bound costs nothing and is exact.
    d2, i2 = tree.query(pts_in, k=k)
    if k == 1:
        d2, i2 = d2[:, None], i2[:, None]
    clear_in = (d2 - rad[np.minimum(i2, len(xyz) - 1)]).min(axis=1)

    edge = np.linalg.norm(pts_in - centre, axis=1) >= (region - 1.5 * spacing)
    return {
        **diag,
        "volume_A3": float(sel.sum()) * spacing ** 3,
        "n_points": int(sel.sum()),
        "open_to_bulk": bool(edge.any()),
        "max_sphere_A": float(np.clip(clear_in, 0.0, None).max()),
        "n_components": int(n_lab),
        "points": pts_in,
        "reason": "",
    }

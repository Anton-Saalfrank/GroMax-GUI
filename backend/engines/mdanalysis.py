"""
MDAnalysis engine.

Reads .tpr + .xtc directly, so it needs no topology conversion and its `resid`
values already ARE the flat GROMACS residue indices the rest of the app uses.
That makes it the cheapest engine to be correct with.

UNITS — the thing to be careful about
MDAnalysis works in ANGSTROM and PICOSECONDS. This app plots NANOMETRES and
NANOSECONDS, because GROMACS does. Every number leaving this module is
converted, so an RMSD from MDAnalysis lies on top of an RMSD from GROMACS
instead of ten times higher.

WHY IT IS WORTH HAVING ALONGSIDE GROMACS
Not to duplicate gmx, but for the things gmx has no tool for: radial
distribution functions, dihedral time series, and a native-contacts fraction
(Q) with a proper switching function.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional

from core.selections import common_groups

from .base import (_rolling_params, _rolling_result,
                   average_by_residue, matrix_result,
                   rmsf_windows_from_coords, time_windows,
                   Engine, EngineAnalysis, dccm_from_coords, frame_indices,
                   heatmap_result, line_result, require_selection_hits)

# Angstrom -> nanometre. Spelled out rather than 0.1 inline, because a bare
# 0.1 in a formula is exactly the kind of thing that gets "simplified" away.
A_TO_NM = 0.1
PS_TO_NS = 0.001


def _universe(ctx: dict):
    import MDAnalysis as mda
    return mda.Universe(ctx["tpr"], ctx["xtc"])


def _frames(u, ctx: dict) -> list[int]:
    """
    Which frames to analyse.

    Reading every frame's time means seeking through the whole .xtc, which on a
    multi-gigabyte trajectory is a real cost paid before any analysis starts. So
    that pass only happens when a time window actually needs it — the common
    case of "whole trajectory, maybe strided" is answered from the frame count
    alone.
    """
    stride = max(1, int(ctx.get("stride") or 1))
    t_start, t_end = ctx.get("time_start"), ctx.get("time_end")

    if t_start is None and t_end is None:
        n = len(u.trajectory)
        if not n:
            raise RuntimeError("The trajectory contains no frames.")
        return list(range(0, n, stride))

    times = [ts.time for ts in u.trajectory]
    idx = frame_indices(times, t_start, t_end, stride)
    if not idx:
        raise RuntimeError(
            "No frames fall inside the requested time window. The trajectory "
            f"runs {times[0] * PS_TO_NS:.3f}–{times[-1] * PS_TO_NS:.3f} ns."
            if times else "The trajectory contains no frames.")
    return idx


def _select(u, sele: str, what: str = "selection"):
    try:
        ag = u.select_atoms(sele)
    except Exception as e:
        raise RuntimeError(
            f"MDAnalysis could not read the {what} '{sele}': {e}") from e
    require_selection_hits(len(ag), sele, what)
    return ag


class _MDAAnalysis(EngineAnalysis):
    """Shared plumbing: every MDAnalysis analysis opens a Universe the same way."""

    # Every analysis in this module computes in-process and never awaits, so
    # all of them would otherwise block the API for their whole runtime.
    blocking = True

    def _cmd(self, ctx: dict) -> str:
        groups = " | ".join(ctx.get("groups") or [])
        return f"MDAnalysis {self.type_id}: {groups}"


class MDARmsd(_MDAAnalysis):
    type_id = "rmsd"
    name = "RMSD"
    description = "Root-mean-square deviation from the first frame, after superposition."
    # Two selections, matching gmx rms — fitting on the backbone while
    # measuring a single domain is a routine and meaningful thing to want, and
    # an engine that could only do both at once would quietly answer a
    # different question than the GROMACS engine does.
    n_groups = 2
    group_prompts = ["Selection for least-squares fit", "Selection for RMSD"]
    default_groups = ["name CA", "name CA"]

    async def run(self, ctx, work_dir, line_callback=None):
        from MDAnalysis.analysis import rms
        u = _universe(ctx)
        g = ctx["groups"] or ["name CA", "name CA"]
        fit_sele = g[0]
        meas_sele = g[1] if len(g) > 1 and g[1].strip() else fit_sele
        _select(u, fit_sele, "fit selection")
        _select(u, meas_sele, "RMSD selection")
        frames = _frames(u, ctx)
        if line_callback:
            line_callback(f"MDAnalysis RMSD over {len(frames)} frames: "
                          f"fit '{fit_sele}', measure '{meas_sele}'")

        ref = _universe(ctx)
        ref.trajectory[frames[0]]
        same = fit_sele == meas_sele
        r = rms.RMSD(u, ref, select=fit_sele, ref_frame=frames[0],
                     groupselections=None if same else [meas_sele])
        r.run(frames=frames)
        # Columns: frame, time (ps), rmsd of `select`, then one per
        # groupselection. The measured group is the LAST column.
        res = r.results.rmsd
        col = 2 if same else 3
        return line_result(
            [row[1] * PS_TO_NS for row in res],
            [row[col] * A_TO_NM for row in res],
            "Time (ns)", "RMSD (nm)", "RMSD vs first frame", self._cmd(ctx))


class MDARmsf(_MDAAnalysis):
    type_id = "rmsf"
    name = "RMSF"
    description = "Per-residue root-mean-square fluctuation about the average structure."
    group_prompts = ["Selection"]
    default_groups = ["name CA"]

    async def run(self, ctx, work_dir, line_callback=None):
        from MDAnalysis.analysis import align, rms
        u = _universe(ctx)
        sele = (ctx["groups"] or ["name CA"])[0]
        frames = _frames(u, ctx)
        if line_callback:
            line_callback(f"MDAnalysis RMSF over {len(frames)} frames: '{sele}'")

        # RMSF is only meaningful about an AVERAGE structure with rotation and
        # translation removed — otherwise it measures the box drifting. gmx
        # rmsf does this internally; MDAnalysis makes you ask.
        avg = align.AverageStructure(u, u, select=sele, ref_frame=frames[0])
        avg.run(frames=frames)
        aligner = align.AlignTraj(u, avg.results.universe, select=sele,
                                  in_memory=True)
        aligner.run(frames=frames)

        ag = _select(u, sele)
        r = rms.RMSF(ag)
        r.run()
        values = [v * A_TO_NM for v in r.results.rmsf]

        # One point per residue, as gmx rmsf -res does. With a C-alpha
        # selection that is already one atom per residue; for anything wider,
        # average within each residue so the x-axis stays residue index and the
        # structure colouring can map it.
        by_res: dict[int, list[float]] = {}
        for atom, val in zip(ag, values):
            by_res.setdefault(int(atom.resid), []).append(val)
        resids = sorted(by_res)
        return line_result(
            resids, [sum(by_res[r]) / len(by_res[r]) for r in resids],
            "Residue", "RMSF (nm)", "RMSF per residue", self._cmd(ctx))


class MDAGyrate(_MDAAnalysis):
    type_id = "gyrate"
    name = "Radius of gyration"
    description = "Radius of gyration vs time — compactness of the selection."
    group_prompts = ["Selection"]
    default_groups = ["protein"]

    async def run(self, ctx, work_dir, line_callback=None):
        u = _universe(ctx)
        sele = (ctx["groups"] or ["protein"])[0]
        ag = _select(u, sele)
        frames = _frames(u, ctx)
        if line_callback:
            line_callback(f"MDAnalysis Rg over {len(frames)} frames: '{sele}'")

        x, y = [], []
        for i in frames:
            ts = u.trajectory[i]
            x.append(ts.time * PS_TO_NS)
            y.append(ag.radius_of_gyration() * A_TO_NM)
        return line_result(x, y, "Time (ns)", "Rg (nm)",
                           "Radius of gyration", self._cmd(ctx))


class MDAMindist(_MDAAnalysis):
    type_id = "mindist"
    name = "Minimum distance"
    description = "Minimum distance between two selections vs time."
    n_groups = 2
    group_prompts = ["First selection", "Second selection"]
    default_groups = ["protein", "protein"]

    async def run(self, ctx, work_dir, line_callback=None):
        import numpy as np
        from MDAnalysis.analysis import distances
        u = _universe(ctx)
        g = ctx["groups"]
        a = _select(u, g[0], "first selection")
        b = _select(u, g[1], "second selection")
        frames = _frames(u, ctx)
        if line_callback:
            line_callback(f"MDAnalysis min. distance over {len(frames)} frames")

        x, y = [], []
        for i in frames:
            ts = u.trajectory[i]
            d = distances.distance_array(a.positions, b.positions,
                                         box=ts.dimensions)
            x.append(ts.time * PS_TO_NS)
            y.append(float(np.min(d)) * A_TO_NM)
        return line_result(x, y, "Time (ns)", "Min. distance (nm)",
                           "Minimum distance", self._cmd(ctx))


class MDAHBond(_MDAAnalysis):
    type_id = "hbond"
    name = "Hydrogen bonds"
    description = "Hydrogen-bond count vs time (geometric criteria)."
    n_groups = 2
    group_prompts = ["Donor selection", "Acceptor selection"]
    default_groups = ["protein", "protein"]
    params_schema = [
        {"key": "d_a_cutoff", "label": "Donor–acceptor cutoff (Å)",
         "type": "number", "default": 3.5},
        {"key": "d_h_a_angle", "label": "Minimum D–H···A angle (°)",
         "type": "number", "default": 150.0},
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        from MDAnalysis.analysis.hydrogenbonds import HydrogenBondAnalysis
        u = _universe(ctx)
        g = ctx["groups"]
        p = ctx.get("params") or {}
        frames = _frames(u, ctx)
        if line_callback:
            line_callback(f"MDAnalysis H-bonds over {len(frames)} frames")

        hb = HydrogenBondAnalysis(
            universe=u,
            donors_sel=g[0], hydrogens_sel=None, acceptors_sel=g[1],
            d_a_cutoff=float(p.get("d_a_cutoff", 3.5)),
            d_h_a_angle_cutoff=float(p.get("d_h_a_angle", 150.0)),
        )
        hb.run(frames=frames)
        counts = hb.count_by_time()
        times = [u.trajectory[i].time * PS_TO_NS for i in frames]
        return line_result(times, list(counts), "Time (ns)", "Hydrogen bonds",
                           "Hydrogen bonds vs time", self._cmd(ctx))


class MDAContacts(_MDAAnalysis):
    type_id = "ncontacts"
    name = "Native contacts (Q)"
    description = ("Fraction of the first frame's contacts still present, with "
                   "a soft switching function. No gmx equivalent.")
    n_groups = 2
    group_prompts = ["First selection", "Second selection"]
    default_groups = ["protein and not name H*", "protein and not name H*"]
    params_schema = [
        {"key": "radius", "label": "Contact cutoff (Å)", "type": "number",
         "default": 4.5},
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        from MDAnalysis.analysis import contacts
        u = _universe(ctx)
        g = ctx["groups"]
        p = ctx.get("params") or {}
        radius = float(p.get("radius", 4.5))
        frames = _frames(u, ctx)

        a = _select(u, g[0], "first selection")
        b = _select(u, g[1], "second selection")
        u.trajectory[frames[0]]
        if line_callback:
            line_callback(f"MDAnalysis native contacts (Q) over {len(frames)} frames")

        q = contacts.Contacts(u, select=(g[0], g[1]),
                              refgroup=(a, b), radius=radius, method="soft_cut")
        q.run(frames=frames)
        res = q.results.timeseries
        return line_result([row[0] for row in res], [row[1] for row in res],
                           "Frame", "Q (fraction of native contacts)",
                           "Native contacts", self._cmd(ctx))


class MDARdf(_MDAAnalysis):
    type_id = "rdf"
    name = "Radial distribution function"
    description = ("g(r) between two selections. Not available in the GROMACS "
                   "analyses here.")
    n_groups = 2
    group_prompts = ["Reference selection", "Surrounding selection"]
    default_groups = ["protein", "resname SOL and name OW"]
    params_schema = [
        {"key": "r_max", "label": "Maximum r (Å)", "type": "number", "default": 15.0},
        {"key": "nbins", "label": "Bins", "type": "number", "default": 75},
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        from MDAnalysis.analysis.rdf import InterRDF
        u = _universe(ctx)
        g = ctx["groups"]
        p = ctx.get("params") or {}
        a = _select(u, g[0], "reference selection")
        b = _select(u, g[1], "surrounding selection")
        frames = _frames(u, ctx)
        if line_callback:
            line_callback(f"MDAnalysis RDF over {len(frames)} frames")

        rdf = InterRDF(a, b, nbins=int(p.get("nbins", 75)),
                       range=(0.0, float(p.get("r_max", 15.0))))
        rdf.run(frames=frames)
        return line_result([r * A_TO_NM for r in rdf.results.bins],
                           list(rdf.results.rdf),
                           "r (nm)", "g(r)", "Radial distribution function",
                           self._cmd(ctx))


class MDADihedral(_MDAAnalysis):
    type_id = "dihedral"
    name = "Dihedral angle"
    description = ("Time series of a dihedral defined by four atoms. Select "
                   "exactly four; order matters.")
    group_prompts = ["Four-atom selection"]
    default_groups = ["resid 1 and name N CA C"]

    async def run(self, ctx, work_dir, line_callback=None):
        from MDAnalysis.analysis.dihedrals import Dihedral
        u = _universe(ctx)
        sele = (ctx["groups"] or [""])[0]
        ag = _select(u, sele)
        if len(ag) != 4:
            raise RuntimeError(
                f"A dihedral needs exactly 4 atoms; '{sele}' matched {len(ag)}. "
                f"Narrow it, e.g. 'resid 12 and name N CA C' plus the next "
                f"residue's N.")
        frames = _frames(u, ctx)
        if line_callback:
            line_callback(f"MDAnalysis dihedral over {len(frames)} frames")

        d = Dihedral([ag])
        d.run(frames=frames)
        times = [u.trajectory[i].time * PS_TO_NS for i in frames]
        return line_result(times, [row[0] for row in d.results.angles],
                           "Time (ns)", "Dihedral (°)", "Dihedral angle",
                           self._cmd(ctx))


class MDARollingRmsf(_MDAAnalysis):
    type_id = "rmsf_rolling"
    name = "Rolling RMSF"
    description = """ + repr(DESC) + """
    n_groups = 1
    group_prompts = ["Selection"]
    default_groups = ["name CA"]
    params_schema = [
        {
            "key": "window_ns",
            "label": "Window (ns)",
            "type": "number",
            "default": 10.0,
            "min": 0.1,
            "max": 10000.0,
            "step": 1.0,
            "help": "Each column is an RMSF over this much trajectory. The "
                    "window is also the time resolution: an event shorter than "
                    "this is smeared across every window containing it, so a "
                    "narrow spike appears as a band one window wide.",
        },
        {
            "key": "step_ns",
            "label": "Step (ns)",
            "type": "number",
            "default": 2.0,
            "min": 0.1,
            "max": 10000.0,
            "step": 0.5,
            "help": "How far the window slides between columns. Smaller than "
                    "the window means overlapping windows, which is usually "
                    "what you want — it smooths the map without inventing "
                    "time resolution.",
        },
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        import numpy as np

        u = _universe(ctx)
        sele = (ctx["groups"] or ["name CA"])[0]
        frames = _frames(u, ctx)
        ag = _select(u, sele)
        window_ns, step_ns = _rolling_params(ctx)

        if line_callback:
            line_callback(f"MDAnalysis rolling RMSF: '{sele}' ({len(ag)} atoms), "
                          f"{window_ns:g} ns window / {step_ns:g} ns step "
                          f"over {len(frames)} frames")

        # One pass: read the selection's coordinates and the frame times
        # together. Seeking the trajectory twice on a multi-gigabyte file is the
        # expensive part of this analysis, not the arithmetic.
        coords = np.empty((len(frames), len(ag), 3), dtype=np.float64)
        times_ns = []
        for n, i in enumerate(frames):
            u.trajectory[i]
            coords[n] = ag.positions
            times_ns.append(float(u.trajectory.ts.time) * PS_TO_NS)

        windows = time_windows(times_ns, window_ns, step_ns)
        per_atom = np.asarray(
            rmsf_windows_from_coords(coords, windows, line_callback)) * A_TO_NM
        resids, rows = average_by_residue(per_atom, [int(a.resid) for a in ag])
        return _rolling_result(rows, resids, windows, window_ns, step_ns,
                               self._cmd(ctx))


class MDADccm(_MDAAnalysis):
    type_id = "dccm"
    name = "Cross-correlation (DCCM)"
    description = """ + repr(DESC) + """
    n_groups = 2
    group_prompts = ["Selection for least-squares fit", "Selection for the matrix"]
    default_groups = ["name CA", "name CA"]

    async def run(self, ctx, work_dir, line_callback=None):
        import numpy as np
        from MDAnalysis.analysis import align

        u = _universe(ctx)
        g = ctx["groups"] or ["name CA", "name CA"]
        fit_sele = g[0]
        meas_sele = g[1] if len(g) > 1 and g[1].strip() else fit_sele
        fit = _select(u, fit_sele, "fit selection")
        meas = _select(u, meas_sele, "matrix selection")
        frames = _frames(u, ctx)
        if line_callback:
            line_callback(f"MDAnalysis DCCM: fit '{fit_sele}', "
                          f"matrix '{meas_sele}' over {len(frames)} frames")

        # Superpose by hand rather than with AlignTraj, so the fit group and the
        # measured group can differ and the rotation is applied to BOTH from the
        # fit group's frame of reference. Without removing global rotation and
        # translation, a DCCM mostly measures the molecule tumbling in its box
        # and comes out almost uniformly positive.
        u.trajectory[frames[0]]
        ref_centre = fit.center_of_geometry()
        ref_fit = fit.positions - ref_centre

        coords = np.empty((len(frames), len(meas), 3), dtype=np.float64)
        for n, i in enumerate(frames):
            u.trajectory[i]
            centre = fit.center_of_geometry()
            R, _ = align.rotation_matrix(fit.positions - centre, ref_fit)
            coords[n] = (meas.positions - centre) @ R.T

        z = dccm_from_coords(coords, line_callback)
        # One residue id per matrix row, read straight off the .tpr — this is
        # what lets a dragged region of the plot become a selection on the
        # structure.
        resids = [int(a.resid) for a in meas]
        return heatmap_result(
            z, resids, "Residue", "Residue", "Correlation",
            "Dynamic cross-correlation", self._cmd(ctx), diverging=True,
            residues=resids)


# ─── Helix motion helpers ─────────────────────────────────────────────────────

def _chan(key: str, label: str, unit: str, series: dict) -> dict:
    """One plotted channel. The unit travels with the data, never assumed."""
    return {"key": key, "label": label, "unit": unit,
            "y": [None if v is None or v != v else float(v) for v in series[key]]}


def _fit_description(p: dict) -> str:
    base = str(p.get("fit_selection", "")).strip()
    if p.get("auto_core"):
        return f"{base} (auto core, below the {p.get('core_percentile', 50)}th RMSF percentile)"
    return base


def _ca_of(u, resid_range: str, what: str):
    """
    CA atoms of a residue range written as '200-220' or '200 205 210'.

    Restricted to CA deliberately: the axis fit is defined on CA positions, and
    letting side chains in would make a helix's axis depend on which rotamers
    happened to be pointing outward.
    """
    spec = resid_range.replace(",", " ").strip()
    parts = []
    for tok in spec.split():
        if "-" in tok and not tok.startswith("-"):
            lo, _, hi = tok.partition("-")
            parts.append(f"resid {int(lo)}:{int(hi)}")
        else:
            parts.append(f"resid {int(tok)}")
    sel = f"name CA and ({' or '.join(parts)})"
    ag = _select(u, sel, what)
    if len(ag) < 3:
        raise RuntimeError(
            f"{what} resolves to {len(ag)} CA atoms ({resid_range}); a helix "
            f"axis needs at least 3. These are GROMACS residue numbers — check "
            f"the range against the System tab.")
    return ag


def _self_fitted_rmsd(coords, ref_coords) -> float:
    """
    RMSD of a region against its own reference, after superposing on itself.

    'Fitted on itself' is what makes this an ORDER PARAMETER for the region's
    internal rearrangement rather than a record of where it drifted to.
    """
    import numpy as np
    from engines.base import _superpose_batch

    fitted = _superpose_batch(np.asarray(coords, float)[None, :, :],
                              np.asarray(ref_coords, float))[0]
    ref_c = np.asarray(ref_coords, float) - np.asarray(ref_coords, float).mean(axis=0)
    return float(np.sqrt(((fitted - ref_c) ** 2).sum(axis=1).mean()))


def _plain_universe(ctx):
    import MDAnalysis as mda
    return mda.Universe(ctx["tpr"], ctx["xtc"])


def _pbc_universe(ctx, p, line_callback=None, fit_indices=None):
    """
    A Universe with PBC handled on the fly, fitted onto the reference domain.

    unwrap -> centre -> fit, applied by the trajectory reader so every frame the
    analysis touches is already whole and already in the reference frame. The
    order is not arbitrary:

      unwrap   makes molecules whole. A helix split across the box boundary has
               half its CA atoms a box-length away; its "axis" is then a line
               through two clouds and every metric derived from it is nonsense.
      centre   puts the fit group mid-box so the following fit is not working
               across a wrap.
      fit      removes the rigid-body motion of the reference domain, which is
               the entire point: piston and tilt are defined RELATIVE to it.

    Never compute geometry on wrapped coordinates — hence doing this in the
    reader rather than hoping the trajectory was already processed.
    """
    import MDAnalysis as mda
    from MDAnalysis import transformations as trans

    u = mda.Universe(ctx["tpr"], ctx["xtc"])
    ref_u = mda.Universe(ctx["tpr"], ctx["xtc"])

    fit_sel = str(p.get("fit_selection") or "name CA and protein").strip()
    if fit_indices is None:
        fit = _select(u, fit_sel, "fit selection")
        ref_fit = _select(ref_u, fit_sel, "fit selection")
    else:
        fit = u.atoms[fit_indices]
        ref_fit = ref_u.atoms[fit_indices]
    if len(fit) < 3:
        raise RuntimeError(
            f"The fit selection '{fit_sel}' has {len(fit)} atoms; fitting needs "
            f"at least 3 non-collinear atoms.")

    ref_u.trajectory[int(ctx.get("_ref_traj_frame", 0))]

    try:
        whole = u.select_atoms("protein") or u.atoms
        workflow = [trans.unwrap(whole),
                    trans.center_in_box(fit, wrap=False),
                    trans.fit_rot_trans(fit, ref_fit)]
        u.trajectory.add_transformations(*workflow)
    except Exception as e:
        raise RuntimeError(
            f"Could not set up PBC handling: {e}\n"
            f"unwrap needs bond information. A .tpr carries bonds; a .gro or "
            f"bare .pdb does not, and the trajectory would have to be made "
            f"whole with gmx trjconv -pbc mol first.") from e

    if line_callback:
        line_callback(f"PBC: unwrap -> centre -> fit on '{fit_sel}' "
                      f"({len(fit)} atoms)")
    return u, fit


def _auto_core_indices(ctx, p, line_callback=None):
    """
    The quiet half of the fit selection, by RMSF percentile.

    CIRCULAR, AND RESOLVED IN TWO PASSES. RMSF is only meaningful after a fit,
    and the fit is what we are trying to choose atoms for. So: fit on the whole
    selection, measure RMSF against that, keep the atoms below the percentile,
    and let the caller fit again on those. One refinement, not iterated to
    convergence — the second fit changes the RMSF ordering very little, and
    iterating would make the result depend on a convergence criterion nobody
    set.
    """
    import numpy as np

    u, fit = _pbc_universe(ctx, p, None)
    frames = _frames(u, ctx)
    pct = float(p.get("core_percentile", 50.0) or 50.0)

    coords = np.empty((len(frames), len(fit), 3), dtype=np.float64)
    for n, fi in enumerate(frames):
        u.trajectory[fi]
        coords[n] = fit.positions
    rmsf = np.sqrt(((coords - coords.mean(axis=0)) ** 2).sum(axis=2).mean(axis=0))

    cutoff = float(np.percentile(rmsf, pct))
    keep = np.flatnonzero(rmsf <= cutoff)
    if len(keep) < 3:
        raise RuntimeError(
            f"The auto core kept {len(keep)} atoms at the {pct:g}th percentile, "
            f"which is too few to fit on. Raise the percentile.")
    if line_callback:
        line_callback(f"Auto core: kept {len(keep)} of {len(fit)} fit atoms "
                      f"(RMSF <= {cutoff:.2f} A, {pct:g}th percentile)")
    return fit.indices[keep]


def _trim_by_dssp(u, ag_ca, frames, pct: float, what: str, line_callback=None):
    """
    Drop residues at each END of a helix that are mostly not helical.

    Only the ends: a non-helical residue in the MIDDLE is a kink, which is part
    of the helix's shape and should influence its axis. A frayed terminus is
    not — it swings freely and drags the fitted axis with it, which appears as
    tilt and roll the body of the helix never did.
    """
    import numpy as np
    try:
        from MDAnalysis.analysis.dssp import DSSP
    except ImportError:
        if line_callback:
            line_callback("NOTE: MDAnalysis has no DSSP module here, so helix "
                          "ends were NOT trimmed. Results are unchanged "
                          "otherwise.")
        return ag_ca

    resids = [int(r) for r in ag_ca.resids]
    try:
        run = DSSP(u).run(frames=frames)
        codes = run.results.dssp            # (n_frames, n_residues) of 'H'/'E'/'-'
        all_resids = [int(r) for r in u.select_atoms("protein").residues.resids]
        pos = {r: i for i, r in enumerate(all_resids)}
        frac = []
        for r in resids:
            i = pos.get(r)
            if i is None or i >= codes.shape[1]:
                frac.append(1.0)            # unknown: treat as helical, keep it
            else:
                frac.append(float((codes[:, i] == "H").mean()))
    except Exception as e:
        if line_callback:
            line_callback(f"NOTE: DSSP failed ({type(e).__name__}: {e}); helix "
                          f"ends were NOT trimmed.")
        return ag_ca

    limit = 1.0 - pct / 100.0
    lo, hi = 0, len(resids) - 1
    while lo < hi and frac[lo] < limit:
        lo += 1
    while hi > lo and frac[hi] < limit:
        hi -= 1
    if hi - lo + 1 < 3:
        if line_callback:
            line_callback(f"NOTE: trimming would leave {hi - lo + 1} residues of "
                          f"{what}; kept the untrimmed range instead.")
        return ag_ca
    if lo or hi != len(resids) - 1:
        kept = resids[lo:hi + 1]
        if line_callback:
            line_callback(f"{what}: trimmed to {kept[0]}-{kept[-1]} "
                          f"({len(resids) - len(kept)} fraying residue(s) dropped)")
        return _ca_of(u, f"{kept[0]}-{kept[-1]}", what)
    return ag_ca


class MDAHelixMotion(_MDAAnalysis):
    type_id = "helix_motion"
    name = "Helix motion (piston/tilt/roll)"
    description = ("How one helix moves relative to a reference domain: piston "
                   "along its own axis, lateral shift, tilt, roll, and its "
                   "geometry against a second helix. Reported against a "
                   "reference frame after fitting on the rigid core.")
    n_groups = 0
    group_prompts = []
    default_groups = []

    params_schema = [
        {"key": "helix_a", "label": "Helix A residues (e.g. 200-220)",
         "type": "text", "default": "",
         "help": "The moving helix, as a residue range like 200-220. CA atoms are "
                 "selected automatically — do not write 'name CA' here. "
                 "These are MDAnalysis resids, i.e. GROMACS' own residue "
                 "numbers. Required: no default is assumed."},
        {"key": "helix_b", "label": "Helix B residues (reference helix)",
         "type": "text", "default": "",
         "help": "The helix A is measured against, as a residue range. CA atoms "
                 "are selected automatically. Optional: leave blank for "
                 "piston/lateral/tilt/roll only, with no inter-axis angle "
                 "or distances."},
        {"key": "fit_selection", "label": "Fit selection",
         "type": "text", "default": "name CA and protein",
         "help": "The rigid frame everything is measured in, as a FULL "
                 "MDAnalysis selection — unlike the helix boxes above, this "
                 "one is used verbatim, so write 'name CA' yourself if you "
                 "want CA only. It is used verbatim because fitting on "
                 "backbone or on all heavy atoms are both legitimate "
                 "choices. Everything is relative to this, so it should be "
                 "the part that does NOT move — typically the CA of helix "
                 "B's domain. Example: name CA and resid 40:180"},
        {"key": "auto_core", "label": "Auto core (drop the most mobile CA)",
         "type": "boolean", "default": False,
         "help": "Keeps only fit-selection CA below the RMSF percentile below. "
                 "Resolved in two passes: fit on everything, measure RMSF, keep "
                 "the quiet atoms, fit again. A floppy terminus left in the fit "
                 "drags the whole reference frame with it."},
        {"key": "core_percentile", "label": "Auto core: keep CA below RMSF percentile",
         "type": "number", "default": 50.0, "min": 5.0, "max": 100.0, "step": 5.0,
         "help": "Only used when auto core is on."},
        {"key": "event_selection", "label": "Event selection (order parameter)",
         "type": "text", "default": "",
         "help": "Optional. RMSD of this region, fitted on itself, as an order "
                 "parameter to correlate the piston against."},
        {"key": "ref_frame", "label": "Reference frame", "type": "number",
         "default": 0, "min": 0,
         "help": "Index within the analysed frames (after stride), not into the "
                 "raw trajectory."},
        {"key": "trim_dssp", "label": "Trim non-helical helix ends (DSSP)",
         "type": "boolean", "default": False,
         "help": "Drops residues at each end that are non-helical in more than "
                 "the percentage below. Fraying termini swing widely and bias "
                 "the axis fit, which shows up as tilt and roll that the body "
                 "of the helix never did."},
        {"key": "trim_pct", "label": "Trim if non-helical in more than (%)",
         "type": "number", "default": 50.0, "min": 0.0, "max": 100.0, "step": 5.0},
        {"key": "axis_method", "label": "Axis estimator", "type": "choice",
         "choices": [{"value": "smoothed", "label": "Smoothed over one turn (recommended)"},
                     {"value": "svd", "label": "Plain SVD of CA positions"}],
         "default": "smoothed",
         "help": "Plain SVD tilts away from the true axis because a CA's "
                 "azimuth advances with its height: ~19 deg out on a 6-residue "
                 "helix, ~2 deg at 12-18. Smoothing over a turn first removes "
                 "most of it. Use plain SVD only to match another tool."},
        {"key": "rise_per_residue", "label": "Rise per residue (A)",
         "type": "number", "default": 1.5, "min": 0.5, "max": 5.0, "step": 0.05,
         "help": "Used only to express the piston in residues. 1.5 A is the "
                 "alpha-helix value; 3-10 helices rise ~2.0 and pi-helices "
                 "~1.15, where 'residues' would otherwise be wrong."},
        {"key": "rolling_window", "label": "Rolling SD window (frames)",
         "type": "number", "default": 50, "min": 2, "step": 10,
         "help": "Window for the rolling standard deviation of the piston."},
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        import numpy as np
        from core.helix import (HelixReference, frame_metrics, rolling_std,
                                unwrap_degrees)

        p = ctx.get("params") or {}
        sel_a = str(p.get("helix_a", "")).strip()
        sel_b = str(p.get("helix_b", "")).strip()
        if not sel_a:
            raise RuntimeError(
                "Helix A residues are required — there is no sensible default. "
                "Give a range such as '200-220'.")

        # ORDER MATTERS. The fit needs a reference frame, the reference frame
        # index is given against the STRIDED frame list, and the strided list
        # needs a trajectory to count. So: open a plain universe to resolve the
        # frames, then build the fitted one knowing which frame to fit onto.
        # Fitting onto frame 0 while reporting against frame N would offset
        # every metric by the difference and look entirely plausible.
        u0 = _plain_universe(ctx)
        frames = _frames(u0, ctx)
        ref_i = int(p.get("ref_frame", 0) or 0)
        if not 0 <= ref_i < len(frames):
            raise RuntimeError(
                f"Reference frame {ref_i} is outside the {len(frames)} frames "
                f"being analysed (0-{len(frames) - 1}). Note this indexes the "
                f"STRIDED frames, not the raw trajectory.")
        ctx = dict(ctx, _ref_traj_frame=frames[ref_i])

        fit_indices = None
        if p.get("auto_core"):
            fit_indices = _auto_core_indices(ctx, p, line_callback)

        u, _fit = _pbc_universe(ctx, p, line_callback, fit_indices)

        ag_a = _ca_of(u, sel_a, "helix A")
        ag_b = _ca_of(u, sel_b, "helix B") if sel_b else None
        if p.get("trim_dssp"):
            ag_a = _trim_by_dssp(u, ag_a, frames, float(p.get("trim_pct", 50.0)),
                                 "helix A", line_callback)
            if ag_b is not None:
                ag_b = _trim_by_dssp(u, ag_b, frames, float(p.get("trim_pct", 50.0)),
                                     "helix B", line_callback)

        ag_event = None
        if str(p.get("event_selection", "")).strip():
            ag_event = _select(u, str(p["event_selection"]).strip(), "event selection")

        method = p.get("axis_method", "smoothed")
        rise = float(p.get("rise_per_residue", 1.5) or 1.5)

        if line_callback:
            line_callback(f"Helix motion: A = {len(ag_a)} CA, "
                          + (f"B = {len(ag_b)} CA, " if ag_b is not None else "")
                          + f"{len(frames)} frames, axis estimator '{method}'")

        # Reference geometry from the chosen frame, measured AFTER the same
        # fitting every other frame gets — otherwise frame 0 sits in a different
        # frame of reference from the rest and every metric is offset.
        u.trajectory[frames[ref_i]]
        ref = HelixReference(np.array(ag_a.positions, dtype=float),
                             roll_atom_index=0, method=method)
        ref_event = np.array(ag_event.positions, dtype=float) if ag_event is not None else None

        times, rows = [], []
        for n, fi in enumerate(frames):
            ts = u.trajectory[fi]
            times.append(float(ts.time) * PS_TO_NS)
            m = frame_metrics(np.array(ag_a.positions, dtype=float), ref,
                              ca_b=np.array(ag_b.positions, dtype=float)
                              if ag_b is not None else None,
                              rise_a=rise)
            if ref_event is not None:
                m["event_rmsd_A"] = _self_fitted_rmsd(
                    np.array(ag_event.positions, dtype=float), ref_event)
            rows.append(m)
            if line_callback and len(frames) > 200 and n % max(1, len(frames) // 10) == 0:
                line_callback(f"  frame {n + 1}/{len(frames)}")

        series = {k: [r.get(k, float("nan")) for r in rows] for k in rows[0]}
        # Unwrapped here and only here: this is the first point at which the
        # frames are known to be in time order.
        series["roll_deg"] = unwrap_degrees(series.pop("_roll_raw_deg")).tolist()

        piston = series["piston_A"]
        window = int(p.get("rolling_window", 50) or 50)
        series["piston_rolling_sd_A"] = rolling_std(piston, window)

        channels = [
            _chan("piston_A", "Piston", "A", series),
            _chan("piston_res", "Piston", "residues", series),
            _chan("lateral_A", "Lateral shift", "A", series),
            _chan("tilt_deg", "Tilt", "deg", series),
            _chan("roll_deg", "Roll", "deg", series),
            _chan("piston_rolling_sd_A", f"Piston rolling SD ({window} frames)",
                  "A", series),
        ]
        if ag_b is not None:
            channels += [
                _chan("interaxis_deg", "A-B inter-axis angle", "deg", series),
                _chan("centroid_dist_A", "A-B centroid distance", "A", series),
                _chan("closest_dist_A", "A-B closest approach", "A", series),
            ]
        if ref_event is not None:
            channels.append(_chan("event_rmsd_A", "Event order parameter", "A", series))

        # The PRIMARY series is the piston, as a plain line result: that makes
        # this analysis work unchanged in Compare, Repeat detail, correlation
        # and the statistics, none of which know about channels.
        data = line_result(times, piston, "Time (ns)", "Piston (A)",
                           "Helix A piston along its own axis", self._cmd(ctx))
        data["channels"] = channels
        data["helix_meta"] = {
            "n_ca_a": len(ag_a), "n_ca_b": len(ag_b) if ag_b is not None else 0,
            "ref_frame": ref_i, "ref_time_ns": times[ref_i],
            "axis_method": method, "rise_per_residue": rise,
            "rolling_window": window,
            "resids_a": [int(r) for r in ag_a.resids],
            "resids_b": [int(r) for r in ag_b.resids] if ag_b is not None else [],
            "fit_selection": _fit_description(p),
            "units": "angstrom and degrees",
        }
        return data


# ─── Contact counting ─────────────────────────────────────────────────────────
#
# WHY THIS EXISTS ALONGSIDE THE GROMACS "Contacts over time"
#
# gmx mindist can count two things and only two things: every atom pair within
# the cutoff (-on), or, with -group, each atom of the SECOND group that touches
# the first group at all. Neither is a residue-pair count, which is what people
# usually mean by "contacts" and what a structure viewer reports.
#
# Measured on a real system at 0.4 nm (gmx 2024.2, 1062-atom group vs 184-atom
# group, frame 0): 164 atom pairs, 35 by -group, and 8 actual residue pairs
# between 4 residues on each side. Three answers to what sounds like one
# question, differing by a factor of twenty.
#
# So this analysis counts the thing that was asked for, explicitly, and says in
# the y-label which thing that was.

# mode -> (y-label, what the plot title calls it)
_COUNT_MODES = {
    "atom_pairs":    ("Atom pairs in contact", "atom pairs"),
    "residue_pairs": ("Residue pairs in contact", "residue pairs"),
    "residues_a":    ("Residues of selection 1 in contact", "residues of selection 1"),
    "residues_b":    ("Residues of selection 2 in contact", "residues of selection 2"),
    "atoms_a":       ("Atoms of selection 1 in contact", "atoms of selection 1"),
    "atoms_b":       ("Atoms of selection 2 in contact", "atoms of selection 2"),
}


def _hydrogen_mask(names):
    """
    Which atoms are hydrogens, by name.

    Deliberately NOT by mass. Hydrogen mass repartitioning — routine for 4 fs
    timesteps — moves hydrogens to ~3 u and drags a methyl carbon down to ~6 u,
    so any mass threshold that works for a normal topology mislabels an HMR one
    in both directions. The first alphabetic character of the atom name is the
    PDB/CHARMM/AMBER convention and survives names like '1HB' and 'HB2'.
    """
    import numpy as np
    return np.array([next((c for c in str(n) if c.isalpha()), "?").upper() == "H"
                     for n in names], dtype=bool)


def _heavy_atoms(ag, what: str):
    keep = ~_hydrogen_mask(ag.names)
    if not keep.any():
        raise RuntimeError(
            f"The {what} contains only hydrogens, so 'heavy atoms only' leaves "
            f"nothing to measure. Either widen the selection or turn that "
            f"option off.")
    return ag[keep]


class MDAContactCount(_MDAAnalysis):
    type_id = "contact_count"
    name = "Contact count (atom or residue pairs)"
    description = ("Contacts between two selections vs time, counted as atom "
                   "pairs, residue pairs, or residues/atoms involved. Residue "
                   "pairs have no gmx equivalent.")
    n_groups = 2
    group_prompts = ["First selection", "Second selection"]
    default_groups = ["protein", "protein"]
    params_schema = [
        {"key": "cutoff", "label": "Contact cutoff (Å)", "type": "number",
         "default": 4.0, "min": 1.0, "max": 25.0, "step": 0.5,
         "help": "Ångström, not nm — this engine works in Å throughout. "
                 "4 Å is the usual heavy-atom contact distance; 4.5 Å and "
                 "5 Å are also common."},
        {"key": "count", "label": "Count", "type": "choice",
         "default": "residue_pairs",
         "choices": [
             {"value": "residue_pairs", "label": "residue pairs"},
             {"value": "atom_pairs", "label": "atom pairs"},
             {"value": "residues_a", "label": "residues of selection 1 involved"},
             {"value": "residues_b", "label": "residues of selection 2 involved"},
             {"value": "atoms_a", "label": "atoms of selection 1 involved"},
             {"value": "atoms_b", "label": "atoms of selection 2 involved"},
         ],
         "help": "A residue pair counts once however many of its atoms touch. "
                 "This is what a structure viewer means by 'residues in "
                 "contact'; atom pairs run several times higher."},
        {"key": "heavy_only", "label": "Heavy atoms only (ignore hydrogens)",
         "type": "boolean", "default": True,
         "help": "On by default, because contact distances are quoted for "
                 "heavy atoms and because structures in viewers often have no "
                 "hydrogens at all. Turning it off roughly triples an atom-pair "
                 "count and leaves a residue-pair count almost unchanged."},
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        import numpy as np
        from collections import Counter
        from MDAnalysis.lib.distances import capped_distance

        p = ctx.get("params") or {}
        g = ctx["groups"]

        cut = float(p.get("cutoff", 4.0))
        if not (0.5 <= cut <= 50.0):
            raise RuntimeError(
                f"Contact cutoff {cut} Å is out of range. This engine takes "
                f"Ångström (4 Å = 0.4 nm), not nm — the GROMACS engine is the "
                f"one that asks for nm.")

        mode = str(p.get("count", "residue_pairs"))
        if mode not in _COUNT_MODES:
            raise RuntimeError(
                f"Unknown count mode '{mode}'. Expected one of: "
                f"{', '.join(sorted(_COUNT_MODES))}.")
        ylabel, mode_label = _COUNT_MODES[mode]
        heavy = bool(p.get("heavy_only", True))

        u = _universe(ctx)
        a = _select(u, g[0], "first selection")
        b = _select(u, g[1], "second selection")
        n_all_a, n_all_b = len(a), len(b)
        if heavy:
            a = _heavy_atoms(a, "first selection")
            b = _heavy_atoms(b, "second selection")

        # Overlapping selections would count an atom against itself at distance
        # zero and report a contact that is not one.
        shared = np.intersect1d(a.indices, b.indices)
        if shared.size:
            raise RuntimeError(
                f"The two selections share {shared.size} atom(s), which would "
                f"count as contacts with themselves at zero distance. Make "
                f"them disjoint (e.g. 'resid 205:267' and 'resid 377:387').")

        frames = _frames(u, ctx)
        if line_callback:
            line_callback(
                f"Selection 1: {len(a)} atoms in {len(a.residues)} residues"
                + (f" ({n_all_a} with hydrogens)" if heavy else ""))
            line_callback(
                f"Selection 2: {len(b)} atoms in {len(b.residues)} residues"
                + (f" ({n_all_b} with hydrogens)" if heavy else ""))
            line_callback(
                f"Counting {mode_label} within {cut:g} Å over {len(frames)} "
                f"frames ({'heavy atoms only' if heavy else 'hydrogens included'})")

        resid_a, resid_b = a.resids, b.resids
        # A single integer key per residue pair, so np.unique does the work.
        span_b = int(resid_b.max()) + 1 if len(resid_b) else 1

        label_a = {int(r.resid): f"{r.resname}{r.resid}" for r in a.residues}
        label_b = {int(r.resid): f"{r.resname}{r.resid}" for r in b.residues}

        times, counts = [], []
        pair_occupancy: Counter = Counter()
        for n, i in enumerate(frames):
            ts = u.trajectory[i]
            pairs = capped_distance(a.positions, b.positions, max_cutoff=cut,
                                    box=ts.dimensions, return_distances=False)
            if len(pairs):
                ra, rb = resid_a[pairs[:, 0]], resid_b[pairs[:, 1]]
                keys = np.unique(ra.astype(np.int64) * span_b + rb)
            else:
                ra = rb = keys = np.empty(0, dtype=np.int64)

            if mode == "atom_pairs":
                value = len(pairs)
            elif mode == "residue_pairs":
                value = len(keys)
            elif mode == "residues_a":
                value = len(np.unique(ra))
            elif mode == "residues_b":
                value = len(np.unique(rb))
            elif mode == "atoms_a":
                value = len(np.unique(pairs[:, 0])) if len(pairs) else 0
            else:  # atoms_b
                value = len(np.unique(pairs[:, 1])) if len(pairs) else 0

            times.append(ts.time * PS_TO_NS)
            counts.append(int(value))
            for k in keys:
                pair_occupancy[int(k)] += 1

            if line_callback and len(frames) > 50 and n % max(1, len(frames) // 10) == 0:
                line_callback(f"  frame {n + 1}/{len(frames)}")

        # Which residue pairs these counts are actually made of. No new UI
        # needed for this, and it is the first thing anyone asks when a count
        # does not match what they saw in a viewer.
        if line_callback and pair_occupancy:
            line_callback(f"Residue pairs seen, by % of frames "
                          f"({len(pair_occupancy)} distinct):")
            for key, hits in pair_occupancy.most_common(15):
                ra_i, rb_i = divmod(key, span_b)
                line_callback(
                    f"  {label_a.get(ra_i, ra_i)} – {label_b.get(rb_i, rb_i)}"
                    f"   {100.0 * hits / len(frames):5.1f}%")
            if len(pair_occupancy) > 15:
                line_callback(f"  … and {len(pair_occupancy) - 15} more")

        title = (f"Contacts within {cut:g} Å vs time ({mode_label}, "
                 f"{'heavy atoms' if heavy else 'all atoms'})")
        result = line_result(times, counts, "Time (ns)", ylabel, title,
                             self._cmd(ctx))
        result["cutoff_angstrom"] = cut
        result["count_mode"] = mode
        result["heavy_only"] = heavy
        return result


# ─── Cavity volume ────────────────────────────────────────────────────────────

# Water oxygens across the usual force-field naming. A trajectory with the
# solvent stripped is common for analysis, so an empty match here is REPORTED
# rather than silently counted as "no water in the cavity".
_WATER_SEL = ("resname SOL TIP3 TIP3P TIP4 TIP4P HOH WAT SPC SPCE T3P "
              "and name O OW OH2 OW1")


def _rolling_mean(y, times_ns, window_ns):
    """
    Centred rolling mean over a window given in NANOSECONDS, not frames.

    In nanoseconds because that is the unit the user is thinking in and because
    a frame count means something different at every stride — a 10-frame window
    is 0.25 ns at one stride and 25 ns at another, so the same number would
    silently smooth by 100x more or less.

    The window shrinks at the ends rather than padding, so the first and last
    points are honest means of what exists rather than diluted by zeros.
    """
    import numpy as np
    y = np.asarray(y, dtype=float)
    t = np.asarray(times_ns, dtype=float)
    if window_ns <= 0 or y.size < 2:
        return list(y)
    dt = float(np.median(np.diff(t))) if t.size > 1 else 0.0
    if dt <= 0:
        return list(y)
    half = max(1, int(round(window_ns / dt / 2.0)))
    out = np.empty_like(y)
    for i in range(y.size):
        lo, hi = max(0, i - half), min(y.size, i + half + 1)
        out[i] = y[lo:hi].mean()
    return list(out)


class MDACavity(_MDAAnalysis):
    type_id = "cavity"
    name = "Cavity volume"
    description = ("Volume of the empty space around a chosen residue, vs time "
                   "— for a hole left by a truncating mutation. No gmx "
                   "equivalent.")
    # The selections are parameters rather than index groups: a seed residue
    # and a wall are not the two symmetric groups the group picker is for.
    n_groups = 0
    params_schema = [
        {"key": "seed", "label": "Seed selection", "type": "text",
         "default": "resid 269 and not backbone",
         "placeholder": "resid 269 and not backbone",
         "help": "The cavity is the empty space connected to the centre of "
                 "THIS selection, whose centroid is re-found every frame so "
                 "the measurement follows the residue as the protein moves. "
                 "For a truncating mutation, seed on the SIDE CHAIN — that is "
                 "where the removed atoms used to be. Including the backbone "
                 "drags the centroid out of the cavity and roughly halves the "
                 "signal (measured: 101 Å³ side-chain-seeded vs 99 Å³ with "
                 "backbone in a Tyr→Cys mutant, against 4 Å³ vs 49 Å³ for the "
                 "wild type — the control is what degrades)."},
        {"key": "lining", "label": "Lining residues (optional)", "type": "text",
         "default": "",
         "placeholder": "resid 264 267 268 269 270 271 294",
         "help": "STRONGLY RECOMMENDED when comparing a mutant with its wild "
                 "type. Naming the residues that wrap the cavity defines it by "
                 "the same geometry in every condition, where a seed point does "
                 "not: the centroid of a side chain lies INSIDE it (measured: "
                 "1.0–1.3 Å inside the nearest vdW surface), so the void can "
                 "never start closer than ~2.5 Å and whatever pocket is nearest "
                 "gets counted — and a tyrosine centroid and a cysteine "
                 "centroid are not even in the same place. Measured on a "
                 "Tyr→Cys pair, seed-based regions in the two conditions shared "
                 "only 29% of their lining residues: they were largely "
                 "measuring different pockets. Leave blank to use the seed "
                 "point instead."},
        {"key": "lining_reach", "label": "Lining reach (Å)", "type": "number",
         "default": 6.0, "min": 2.0, "max": 15.0, "step": 0.5,
         "help": "How far from the lining atoms the region extends. It has to "
                 "reach the middle of the cavity or the middle is cut off — "
                 "measured on spherical test cavities, a 2.9 Å-radius cavity is "
                 "98% recovered at 6 Å reach, a 6.9 Å-radius one only 82%. The "
                 "log warns when the cavity looks clipped."},
        {"key": "wall", "label": "Wall selection", "type": "text",
         "default": "protein",
         "help": "What counts as solid. Add a ligand or lipid here if one "
                 "lines the cavity, or it will be measured as empty space."},
        {"key": "region_radius", "label": "Search radius (Å)", "type": "number",
         "default": 10.0, "min": 4.0, "max": 25.0, "step": 1.0,
         "help": "Only space within this far of the seed is considered. Raise "
                 "it if the cavity grows beyond it — the plot will say so."},
        {"key": "probe_radius", "label": "Probe radius (Å)", "type": "number",
         "default": 1.4, "min": 0.5, "max": 5.0, "step": 0.1,
         "help": "The sphere that has to fit. 1.4 Å is a water molecule."},
        {"key": "grid_spacing", "label": "Grid spacing (Å)", "type": "number",
         "default": 0.7, "min": 0.3, "max": 1.5, "step": 0.1,
         "help": "Precision of the volume, and the main cost. 0.7 Å is "
                 "within ~2% of the exact value; 1.0 Å runs about twice as "
                 "fast."},
        {"key": "burial", "label": "Buriedness threshold", "type": "number",
         "default": 0.65, "min": 0.0, "max": 1.0, "step": 0.05,
         "help": "Fraction of directions that must be blocked by the wall for "
                 "a point to count as inside the structure. This is what stops "
                 "bulk solvent being measured as a cavity. Lower it towards "
                 "0.5 for a shallow surface pocket; 0 disables the test."},
        {"key": "connectivity", "label": "What to count", "type": "choice",
         "default": "connected",
         "choices": [
             {"value": "connected", "label": "one pocket joined to the seed"},
             {"value": "region", "label": "all buried space near the seed"},
         ],
         "help": "'One pocket' floods outwards from the seed and counts only "
                 "space reachable from it — specific to this cavity, but it "
                 "jumps whenever a narrow neck opens and the flood reaches "
                 "further. 'All buried space' integrates over the whole search "
                 "radius instead: steadier frame to frame, but it also counts "
                 "unrelated packing voids nearby, which dilutes the difference "
                 "between conditions. Measured on a Tyr→Cys pair: 1.7× "
                 "mutant/WT connected, 1.3× region-wide."},
        {"key": "seed_radius", "label": "Max seed distance (Å)", "type": "number",
         "default": 6.0, "min": 1.0, "max": 20.0, "step": 0.5,
         "help": "How far from the seed centroid the cavity may start. If the "
                 "nearest empty space is further than this, the frame reports "
                 "zero — which is what you want when the cavity has genuinely "
                 "closed, and what to raise if the side chain has swung away "
                 "from the space you mean."},
        {"key": "smooth_ns", "label": "Rolling mean (ns, 0 = off)",
         "type": "number", "default": 0.0, "min": 0.0, "max": 500.0, "step": 5.0,
         "help": "A per-frame cavity volume is an intrinsically noisy "
                 "observable: a 1.4 Å probe either fits between two side "
                 "chains or does not, and that flips with ordinary thermal "
                 "motion. Measured on this system, consecutive frames 25 ps "
                 "apart are statistically INDEPENDENT (lag-1 r ≈ 0), so a "
                 "single frame's number means very little. Set a window here "
                 "and the plotted series becomes its rolling mean; the "
                 "unsmoothed series is kept as a channel either way."},
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        import numpy as np
        from MDAnalysis.lib.distances import capped_distance, minimize_vectors
        from core.cavity import cavity_frame, radii_for

        p = ctx.get("params") or {}
        seed_sel = str(p.get("seed", "") or "").strip()
        if not seed_sel:
            raise RuntimeError(
                "A seed selection is required — the residue whose cavity is "
                "being measured, e.g. 'resid 269'. (With lining residues given "
                "it only anchors the search box, so the mutated residue is "
                "still the right thing to put here.)")
        wall_sel = str(p.get("wall", "protein") or "protein").strip()

        region = float(p.get("region_radius", 10.0))
        probe = float(p.get("probe_radius", 1.4))
        spacing = float(p.get("grid_spacing", 0.7))
        burial = float(p.get("burial", 0.65))
        if not (0.3 <= spacing <= 2.0):
            raise RuntimeError(f"Grid spacing {spacing} Å is out of range.")
        if not (4.0 <= region <= 30.0):
            raise RuntimeError(
                f"Search radius {region} Å is out of range. This engine takes "
                f"Ångström (10 Å = 1 nm), not nm.")
        if not (0.0 <= burial <= 1.0):
            raise RuntimeError("Buriedness threshold must be between 0 and 1.")

        mode = str(p.get("connectivity", "connected"))
        if mode not in ("connected", "region"):
            raise RuntimeError(
                f"Unknown option '{mode}' for what to count. Expected "
                f"'connected' or 'region'.")
        seed_radius = float(p.get("seed_radius", 6.0))
        if not (0.5 <= seed_radius <= region):
            raise RuntimeError(
                f"Max seed distance {seed_radius} Å must be between 0.5 Å and "
                f"the search radius ({region:g} Å).")
        smooth_ns = float(p.get("smooth_ns", 0.0) or 0.0)
        if smooth_ns < 0:
            raise RuntimeError("Rolling mean window cannot be negative.")

        lining_sel = str(p.get("lining", "") or "").strip()
        lining_reach = float(p.get("lining_reach", 6.0))
        if not (1.0 <= lining_reach <= 20.0):
            raise RuntimeError(f"Lining reach {lining_reach} Å is out of range.")

        u = _universe(ctx)
        lining_ag = _select(u, lining_sel, "lining selection") if lining_sel else None
        seed_ag = _select(u, seed_sel, "seed selection")
        wall_ag = _select(u, wall_sel, "wall selection")
        water_ag = u.select_atoms(_WATER_SEL)
        wall_radii = radii_for(wall_ag.names, wall_ag.resnames)

        frames = _frames(u, ctx)
        if line_callback:
            if lining_ag is not None:
                line_callback(
                    f"Cavity defined by its LINING: '{lining_sel}' — "
                    f"{len(lining_ag)} atoms in {len(lining_ag.residues)} "
                    f"residues, region reaching {lining_reach:g} Å from them. "
                    f"Identical geometry in every condition.")
            else:
                line_callback(
                    "Cavity defined by a SEED POINT. For comparing conditions, "
                    "naming the lining residues instead is more reliable — a "
                    "side-chain centroid sits in a different place in a mutant "
                    "than in the wild type.")
            line_callback(f"Seed: {seed_sel} — {len(seed_ag)} atoms in "
                          f"{len(seed_ag.residues)} residue(s)")
            line_callback(f"Wall: {wall_sel} — {len(wall_ag)} atoms")
            line_callback(
                f"Probe {probe:g} Å · grid {spacing:g} Å · search radius "
                f"{region:g} Å · buriedness ≥ {burial:g}")
            line_callback(
                f"Waters: {len(water_ag)} oxygens found"
                if len(water_ag) else
                "Waters: none in this trajectory — the water channel will be "
                "blank. (Solvent stripped? Then volume is still valid.)")
            line_callback(f"Measuring over {len(frames)} frames")

        times, vols, waters, spheres, openness, offsets = [], [], [], [], [], []
        n_open = 0
        reasons: dict[str, int] = {}
        # WHICH void is being measured, not just how big it is.
        #
        # The seed only has to be within `seed_radius` of the void, so the
        # thing counted can be a neighbouring pocket rather than the seed's
        # own — and nothing on the plot would say so. Naming its lining
        # residues makes that checkable against a structure viewer, which is
        # the first thing anyone does when a number looks wrong.
        from collections import Counter as _Counter
        lining: _Counter = _Counter()
        n_with_cavity = 0
        resname_of = {int(r.resid): r.resname for r in wall_ag.residues}

        for n, i in enumerate(frames):
            ts = u.trajectory[i]
            box = ts.dimensions

            # The seed centroid, computed through the periodic boundary rather
            # than across it: a residue split by the box edge would otherwise
            # have its centroid land in the middle of the box, far from either
            # half of itself.
            sp = seed_ag.positions
            centre = sp[0] + minimize_vectors(sp - sp[0], box).mean(axis=0)

            # With lining residues given, the SEARCH BOX is centred on them
            # rather than on the seed, so the region does not drift with a
            # side chain that is a different size in each condition.
            inc_local = None
            if lining_ag is not None:
                lp = lining_ag.positions
                centre = lp[0] + minimize_vectors(lp - lp[0], box).mean(axis=0)

            # Wall atoms near the seed, in their minimum-image position
            # relative to it. This is what lets the measurement work on a
            # trajectory whose protein is broken across the boundary.
            reach = (region + 12.0) * 1.74 + float(wall_radii.max()) + probe
            pr = capped_distance(centre[None, :], wall_ag.positions,
                                 max_cutoff=min(reach, 0.49 * float(np.min(box[:3]))),
                                 box=box, return_distances=False)
            if len(pr) == 0:
                raise RuntimeError(
                    f"No '{wall_sel}' atoms anywhere near the seed selection. "
                    f"Check that the two selections refer to the same molecule.")
            widx = np.unique(pr[:, 1])
            wxyz = centre + minimize_vectors(wall_ag.positions[widx] - centre, box)

            if lining_ag is not None:
                inc_local = centre + minimize_vectors(
                    lining_ag.positions - centre, box)

            res = cavity_frame(
                wxyz, wall_radii[widx], centre,
                probe=probe, spacing=spacing, region=region,
                burial=burial, seed_radius=seed_radius,
                # A lining-defined region IS the definition, so there is no
                # seed blob to flood from — every buried void inside it counts.
                require_connected=(mode == "connected" and lining_ag is None),
                include_xyz=inc_local, include_radius=lining_reach)
            if res["reason"]:
                reasons[res["reason"]] = reasons.get(res["reason"], 0) + 1

            # Waters actually sitting in the cavity — the parameter-free check
            # on the volume. A filled cavity is a real one.
            n_wat = 0
            if len(water_ag) and res["n_points"]:
                wp = capped_distance(centre[None, :], water_ag.positions,
                                     max_cutoff=min(region + 2.0,
                                                    0.49 * float(np.min(box[:3]))),
                                     box=box, return_distances=False)
                if len(wp):
                    oidx = np.unique(wp[:, 1])
                    oxy = centre + minimize_vectors(
                        water_ag.positions[oidx] - centre, box)
                    near = capped_distance(oxy, res["points"],
                                           max_cutoff=spacing, return_distances=False)
                    n_wat = int(len(np.unique(near[:, 0]))) if len(near) else 0

            # Which residues wrap the counted void, and how far its centre
            # sits from the seed.
            offset = float("nan")
            if res["n_points"]:
                n_with_cavity += 1
                offset = float(np.linalg.norm(res["points"].mean(axis=0) - centre))
                touch = capped_distance(res["points"], wxyz, max_cutoff=5.0,
                                        return_distances=False)
                if len(touch):
                    lining.update(set(
                        int(x) for x in wall_ag[widx[np.unique(touch[:, 1])]].resids))

            times.append(ts.time * PS_TO_NS)
            offsets.append(offset)
            vols.append(res["volume_A3"])
            waters.append(float(n_wat) if len(water_ag) else float("nan"))
            spheres.append(res["max_sphere_A"])
            openness.append(1.0 if res["open_to_bulk"] else 0.0)
            n_open += int(res["open_to_bulk"])

            if line_callback and len(frames) > 20 and n % max(1, len(frames) // 10) == 0:
                line_callback(f"  frame {n + 1}/{len(frames)} — "
                              f"{res['volume_A3']:.0f} Å³")

        import numpy as _np
        arr = _np.array(vols, dtype=float)
        if line_callback:
            line_callback(
                f"Cavity volume: mean {arr.mean():.0f} Å³, range "
                f"{arr.min():.0f}–{arr.max():.0f} Å³")
            if lining_ag is not None and spheres:
                import numpy as _np4
                big = _np4.nanmax(_np4.array(spheres, dtype=float))
                if big >= 0.85 * lining_reach:
                    line_callback(
                        f"WARNING: the largest sphere that fits ({big:.1f} Å) is "
                        f"close to the lining reach ({lining_reach:g} Å), so the "
                        f"middle of the cavity is probably being cut off. Raise "
                        f"the reach until the volume stops growing.")
            if n_with_cavity:
                import numpy as _np3
                off = _np3.array(offsets, dtype=float)
                off = off[_np3.isfinite(off)]
                if off.size:
                    line_callback(
                        f"The measured void's centre sits {off.mean():.1f} Å from "
                        f"the seed on average (max {off.max():.1f} Å). A large "
                        f"offset means a NEIGHBOURING pocket is being measured, "
                        f"not the seed's own — lower 'max seed distance' to "
                        f"insist on a local one.")
                line_callback(
                    f"Residues lining the measured void, by % of the "
                    f"{n_with_cavity} frames that had one:")
                for rid, cnt in lining.most_common(14):
                    line_callback(f"   {resname_of.get(rid, '')}{rid}"
                                  f"   {100.0 * cnt / n_with_cavity:5.1f}%")
                line_callback(
                    "If that list is not the pocket you meant, the seed is "
                    "picking up a different one — check it against the "
                    "structure before reading the volumes.")
            if n_open:
                line_callback(
                    f"Open to bulk in {n_open}/{len(frames)} frames "
                    f"({100.0 * n_open / len(frames):.0f}%) — the void reaches "
                    f"the edge of the {region:g} Å search radius, so it is a "
                    f"channel or surface groove there, not an enclosed pocket. "
                    f"Raise the search radius to see how far it goes.")
            n_zero = int((arr == 0).sum())
            if n_zero:
                line_callback(
                    f"{n_zero}/{len(frames)} frames measured zero "
                    f"({100.0 * n_zero / len(frames):.0f}%) — no water-sized "
                    f"space next to the seed in those frames:")
                for why, cnt in sorted(reasons.items(), key=lambda kv: -kv[1]):
                    line_callback(f"   {cnt} × {why}")
            # Frame-to-frame independence is the thing most likely to mislead,
            # so it is measured and stated rather than left for the user to
            # infer from a spiky plot.
            if len(arr) > 10:
                import numpy as _np2
                a, b = arr[:-1], arr[1:]
                if a.std() > 0 and b.std() > 0:
                    r1 = float(_np2.corrcoef(a, b)[0, 1])
                    dt_ns = (float(_np2.median(_np2.diff(times)))
                             if len(times) > 1 else 0.0)
                    # The interval MATTERS and is quoted with the number. This
                    # system measures r = 0.55 between points 0.6 ns apart but
                    # r = 0.0 between points 0.025 ns apart — because over a
                    # long run the slow trend supplies most of the variance,
                    # while inside a short window only the fast flicker does.
                    # An r without its sampling interval says nothing.
                    line_callback(
                        f"Correlation between points {dt_ns:.3g} ns apart: "
                        f"r = {r1:.2f}. "
                        + ("They are nearly independent, so a single point is "
                           "mostly thermal flicker of the probe criterion — "
                           "read time averages or per-replica means, not "
                           "individual frames. A rolling mean window shows the "
                           "trend underneath."
                           if r1 < 0.5 else
                           "A trend at this timescale is readable directly; "
                           "individual frames are still noisy."))

        smoothed = _rolling_mean(vols, times, smooth_ns)
        series = {"volume_A3": vols, "waters": waters, "volume_smooth": smoothed,
                  "max_sphere_A": spheres, "open_to_bulk": openness,
                  "seed_offset_A": offsets}
        channels = [
            _chan("volume_A3", "Cavity volume (per frame)", "A^3", series),
            _chan("max_sphere_A", "Largest sphere that fits", "A", series),
            _chan("open_to_bulk", "Open to bulk (1 = yes)", "", series),
            _chan("seed_offset_A", "Void centre, distance from seed", "A", series),
        ]
        if smooth_ns > 0:
            channels.insert(1, _chan("volume_smooth",
                                     f"Cavity volume ({smooth_ns:g} ns mean)",
                                     "A^3", series))
        if len(water_ag):
            channels.insert(1, _chan("waters", "Waters inside", "count", series))

        # Smoothing replaces the PLOTTED series, never the stored one: the
        # per-frame values stay available as a channel, and the label says
        # which is on screen so a smoothed trace can never be mistaken for raw.
        plotted = smoothed if smooth_ns > 0 else vols
        ylabel = ("Cavity volume (Å³)" if smooth_ns <= 0 else
                  f"Cavity volume (Å³, {smooth_ns:g} ns mean)")
        title = (f"Cavity volume around {seed_sel}"
                 + (f" — {smooth_ns:g} ns rolling mean" if smooth_ns > 0 else ""))
        result = line_result(times, plotted, "Time (ns)", ylabel, title,
                             self._cmd(ctx))
        result["channels"] = channels
        result["cavity_params"] = {
            "seed": seed_sel, "wall": wall_sel, "probe_A": probe,
            "spacing_A": spacing, "region_A": region, "burial": burial,
            "frames_open": n_open, "n_frames": len(frames),
            "has_water": bool(len(water_ag)),
        }
        return result


# ─── Hydration: who is actually touching water ────────────────────────────────
#
# WHY THIS IS NOT SASA
#
# A rolling-probe surface area decides accessibility GEOMETRICALLY and locally:
# a point counts if no neighbouring atom covers it. The wall of a SEALED
# interior cavity is covered by nothing, so it counts as accessible even though
# no water could ever reach it. Measured on a hollow shell of carbons: 2770 A^2
# with the cavity empty against 2166 A^2 with it packed solid — the 598 A^2 of
# cavity wall is in the total either way. SASA therefore reacts when a cavity
# FORMS, barely at all when it opens.
#
# Counting the atoms that have a water molecule next to them asks the question
# directly, using where the water actually is. A sealed cavity reads zero
# however large it is; the moment it connects to bulk and fills, the atoms
# lining it light up. That is the event, measured rather than inferred.
#
# It is also far better conditioned than a cavity volume: a count over hundreds
# of atoms averages, where a single probe-fits-or-not test flickers.

_HYDRATION_MODES = {
    "atoms": ("Atoms touching water", "atoms"),
    "residues": ("Residues touching water", "residues"),
    "waters": ("Waters in the first shell", "waters"),
    "fraction": ("Fraction of atoms touching water", ""),
}


class MDAHydration(_MDAAnalysis):
    type_id = "hydration"
    name = "Water contacts (hydration)"
    description = ("How many atoms of a selection have water next to them, vs "
                   "time. Unlike SASA this uses the real water positions, so a "
                   "sealed cavity reads zero until it opens.")
    n_groups = 1
    group_prompts = ["Atoms to watch for water contact"]
    default_groups = ["protein"]
    params_schema = [
        {"key": "cutoff", "label": "Water contact cutoff (Å)", "type": "number",
         "default": 3.5, "min": 2.0, "max": 10.0, "step": 0.1,
         "help": "Heavy atom to water oxygen. 3.5 Å is the usual first "
                 "hydration shell; 3.0 Å is tighter, 5.0 Å counts the second "
                 "shell as well."},
        {"key": "count", "label": "Count", "type": "choice", "default": "atoms",
         "choices": [
             {"value": "atoms", "label": "atoms touching water"},
             {"value": "residues", "label": "residues touching water"},
             {"value": "waters", "label": "waters in the first shell"},
             {"value": "fraction", "label": "fraction of the selection wetted"},
         ],
         "help": "Counting RESIDUES is the steadiest, because a residue stays "
                 "wet while its individual atoms flicker in and out."},
        {"key": "heavy_only", "label": "Heavy atoms only", "type": "boolean",
         "default": True,
         "help": "On by default: hydration distances are quoted for heavy "
                 "atoms, and counting hydrogens separately would triple the "
                 "number without adding information."},
        {"key": "water", "label": "Water selection", "type": "text",
         "default": _WATER_SEL,
         "help": "Water oxygens. The default covers the usual force-field "
                 "names; widen it if your solvent is named differently."},
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        import numpy as np
        from collections import Counter
        from MDAnalysis.lib.distances import capped_distance

        p = ctx.get("params") or {}
        g = ctx["groups"]
        cut = float(p.get("cutoff", 3.5))
        if not (1.0 <= cut <= 20.0):
            raise RuntimeError(
                f"Water contact cutoff {cut} Å is out of range. This engine "
                f"takes Ångström (3.5 Å = 0.35 nm), not nm.")
        mode = str(p.get("count", "atoms"))
        if mode not in _HYDRATION_MODES:
            raise RuntimeError(
                f"Unknown count mode '{mode}'. Expected one of: "
                f"{', '.join(sorted(_HYDRATION_MODES))}.")
        heavy = bool(p.get("heavy_only", True))
        water_sel = str(p.get("water", _WATER_SEL) or _WATER_SEL).strip()

        u = _universe(ctx)
        ag = _select(u, g[0], "selection")
        if heavy:
            ag = _heavy_atoms(ag, "selection")
        water = u.select_atoms(water_sel)
        if len(water) == 0:
            raise RuntimeError(
                f"The water selection '{water_sel}' matched no atoms. If the "
                f"solvent was stripped from this trajectory there is nothing "
                f"to measure — use the cavity analysis instead, which needs no "
                f"water.")

        frames = _frames(u, ctx)
        resid_of = ag.resids
        resname_of = {int(r.resid): r.resname for r in ag.residues}
        n_res_total = len(ag.residues)

        if line_callback:
            line_callback(f"Watching {len(ag)} atoms in {n_res_total} residues"
                          + (" (heavy atoms only)" if heavy else ""))
            line_callback(f"Water: {len(water)} oxygens · contact within "
                          f"{cut:g} Å · over {len(frames)} frames")

        times, counts = [], []
        wet_frames: Counter = Counter()          # per residue
        for n, i in enumerate(frames):
            ts = u.trajectory[i]
            pairs = capped_distance(ag.positions, water.positions,
                                    max_cutoff=cut, box=ts.dimensions,
                                    return_distances=False)
            if len(pairs):
                wet_atoms = np.unique(pairs[:, 0])
                wet_res = np.unique(resid_of[wet_atoms])
                n_wat = int(len(np.unique(pairs[:, 1])))
            else:
                wet_atoms = wet_res = np.empty(0, dtype=np.int64)
                n_wat = 0

            if mode == "atoms":
                value = float(len(wet_atoms))
            elif mode == "residues":
                value = float(len(wet_res))
            elif mode == "waters":
                value = float(n_wat)
            else:
                value = float(len(wet_atoms)) / max(len(ag), 1)

            times.append(ts.time * PS_TO_NS)
            counts.append(value)
            for rr in wet_res:
                wet_frames[int(rr)] += 1

            if line_callback and len(frames) > 50 and n % max(1, len(frames) // 10) == 0:
                line_callback(f"  frame {n + 1}/{len(frames)}")

        # WHICH residues get wet, and — the interesting part — which ones are
        # usually dry but occasionally are not. A residue that is buried most of
        # the time and wetted some of the time is a cavity opening and closing.
        if line_callback and wet_frames:
            nf = len(frames)
            always = [r for r, c in wet_frames.items() if c >= 0.95 * nf]
            never = [int(r) for r in {int(x) for x in resid_of}
                     if wet_frames.get(r, 0) == 0]
            sometimes = sorted(((r, c) for r, c in wet_frames.items()
                                if 0.02 * nf <= c < 0.95 * nf),
                               key=lambda kv: -kv[1])
            line_callback(
                f"{len(always)} residues are wet in ≥95% of frames (surface), "
                f"{len(never)} never (buried), {len(sometimes)} in between.")
            if sometimes:
                line_callback("Residues that are usually dry but sometimes "
                              "wetted — these are the ones that open:")
                for rr, c in sometimes[:15]:
                    line_callback(f"   {resname_of.get(rr, '')}{rr}"
                                  f"   {100.0 * c / nf:5.1f}% of frames")
            else:
                line_callback("No residue changes state during this run: every "
                              "one is either always wet or always dry.")

        arr = np.asarray(counts, dtype=float)
        if line_callback and arr.size > 10 and arr.std() > 0:
            r1 = float(np.corrcoef(arr[:-1], arr[1:])[0, 1])
            dt = float(np.median(np.diff(times))) if len(times) > 1 else 0.0
            line_callback(f"Correlation between points {dt:.3g} ns apart: "
                          f"r = {r1:.2f}.")

        ylabel, unit = _HYDRATION_MODES[mode]
        result = line_result(times, counts, "Time (ns)", ylabel,
                             f"Water contacts within {cut:g} Å of {g[0]}",
                             self._cmd(ctx))
        result["hydration"] = {
            "cutoff_A": cut, "mode": mode, "heavy_only": heavy,
            "n_atoms": len(ag), "n_residues": n_res_total,
            "n_waters": len(water),
        }
        return result


class MDAnalysisEngine(Engine):
    id = "mdanalysis"
    name = "MDAnalysis"
    description = ("Python toolkit that reads .tpr + .xtc directly. Brings RDF, "
                   "dihedrals and native-contacts Q, which the GROMACS tools "
                   "here do not cover.")
    homepage = "https://docs.mdanalysis.org/stable/documentation_pages/selections.html"
    dialect = "mdanalysis"
    selection_help = (
        "MDAnalysis selection syntax: 'protein', 'name CA', 'backbone', "
        "'resid 200:270', 'resname SOL and name OW'. Ranges use a colon "
        "(resid 200:270), and multiple values are space-separated."
    )
    install_hint = (
        "pip install MDAnalysis\n"
        "Install it into the SAME Python that runs the backend — if you launch "
        "from a conda environment, activate that environment first."
    )
    notes = [
        "Reads the .tpr directly, so its resid values are the same flat "
        "residue indices GROMACS uses. Residue picks translate exactly.",
        "Works internally in Ångström and picoseconds; results are converted "
        "to nm and ns so they overlay GROMACS results directly.",
    ]

    ANALYSES = {
        "rmsd": MDARmsd,
        "rmsf": MDARmsf,
        "helix_motion": MDAHelixMotion,
        "rmsf_rolling": MDARollingRmsf,
        "gyrate": MDAGyrate,
        "mindist": MDAMindist,
        "hbond": MDAHBond,
        "ncontacts": MDAContacts,
        "contact_count": MDAContactCount,
        "cavity": MDACavity,
        "hydration": MDAHydration,
        "rdf": MDARdf,
        "dihedral": MDADihedral,
        "dccm": MDADccm,
    }

    @classmethod
    def probe(cls) -> dict:
        try:
            import MDAnalysis  # noqa: F401
        except Exception as e:
            return {"available": False, "version": None,
                    "reason": f"MDAnalysis is not installed in the backend's "
                              f"Python ({type(e).__name__})."}
        try:
            version = MDAnalysis.__version__
        except Exception:
            version = "unknown"
        return {"available": True, "version": version, "reason": None}

    @classmethod
    def chips(cls) -> list[dict]:
        return common_groups(cls.dialect)

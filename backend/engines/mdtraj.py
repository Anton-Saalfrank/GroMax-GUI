"""
MDTraj engine.

MDTraj cannot read a .tpr, so every analysis here goes through a topology
dumped from the .tpr by gmx trjconv — see engines/topology.py for why the
reference PDB is the wrong thing to use and what goes silently wrong if you do.

UNITS
MDTraj is already in NANOMETRES, which matches this app, so distances pass
straight through. Times come from the trajectory in picoseconds and are
converted to ns like everywhere else.

WHAT IT ADDS OVER THE OTHERS
Shrake–Rupley SASA and DSSP secondary structure without needing the external
`dssp` binary GROMACS wants, and a Baker–Hubbard hydrogen-bond criterion that
is stricter (and slower) than the plain geometric one.
"""

from __future__ import annotations

from pathlib import Path

from core.selections import common_groups

from .base import (_rolling_params, _rolling_result,
                   average_by_residue, matrix_result,
                   rmsf_windows_from_coords, time_windows,
                   Engine, EngineAnalysis, dccm_from_coords, frame_indices,
                   heatmap_result, line_result, require_selection_hits)
from .topology import ensure_topology

PS_TO_NS = 0.001
NM2_TO_A2 = 100.0     # MDTraj SASA is nm^2; gmx sasa reports nm^2 too


async def _load(ctx: dict, line_callback=None):
    """Load the trajectory with a topology that genuinely matches it."""
    import mdtraj as md
    top = await ensure_topology(ctx["tpr"], ctx["xtc"],
                                Path(ctx["_topology_dir"]), line_callback)
    traj = md.load(ctx["xtc"], top=str(top))
    return traj


def _sasa_chunked(traj, line_callback=None, **kw):
    """
    Shrake-Rupley SASA, ONE FRAME PER CALL. Both reasons were measured.

    1. CORRECTNESS. md.shrake_rupley over several frames in one call is wrong
       for every frame after the first. Checked against an independent
       Shrake-Rupley written from the definition: a frame computed on its own
       matches the reference to 3e-5 (float32 precision), while the same frame
       computed as the 2nd..Nth of a call reads HIGH by ~0.13% — always high,
       and the result depends on the frame's POSITION in the call, not on any
       coordinates. On a real 6480-atom protein the bias is +21.4 +- 0.2 A^2
       per frame, every frame except the first, which plants a fake step at
       frame 0 of every trace. test_mdtraj_sasa.py pins this.

    2. VISIBILITY. One call over the whole trajectory is a single C call that
       never returns to Python: a real run sat in it for 42 minutes with no
       output, indistinguishable from a hang. Per-frame calls allow a progress
       line with an estimate.

    The cost of calling per frame was measured at +3%.
    """
    import time
    import mdtraj as md
    import numpy as np

    n = traj.n_frames
    out, t0, next_report = [], time.time(), 0.1
    for i in range(n):
        out.append(md.shrake_rupley(traj[i:i + 1], **kw))
        done = i + 1
        if line_callback and n > 20 and (done / n >= next_report or done == n):
            el = time.time() - t0
            line_callback(f"  SASA {done}/{n} frames · {el:.0f} s elapsed · "
                          f"~{el / done * (n - done):.0f} s left")
            next_report += 0.1
    return np.concatenate(out, axis=0)


def _slice(traj, ctx: dict):
    times_ps = list(traj.time)
    idx = frame_indices(times_ps, ctx.get("time_start"), ctx.get("time_end"),
                        ctx.get("stride") or 1)
    if not idx:
        span = (f"{times_ps[0] * PS_TO_NS:.3f}–{times_ps[-1] * PS_TO_NS:.3f} ns"
                if times_ps else "empty")
        raise RuntimeError(
            f"No frames fall inside the requested time window (trajectory: {span}).")
    return traj[idx]


def _select(traj, sele: str, what: str = "selection"):
    try:
        idx = traj.topology.select(sele)
    except Exception as e:
        raise RuntimeError(
            f"MDTraj could not read the {what} '{sele}': {e}") from e
    require_selection_hits(len(idx), sele, what)
    return idx


class _MDTrajAnalysis(EngineAnalysis):
    # Loads the trajectory into memory and computes there. The only await in
    # this module is the topology conversion at the start; everything after it
    # holds the loop. See EngineAnalysis.blocking.
    blocking = True

    def _cmd(self, ctx: dict) -> str:
        return f"MDTraj {self.type_id}: {' | '.join(ctx.get('groups') or [])}"


class MDTRmsd(_MDTrajAnalysis):
    type_id = "rmsd"
    name = "RMSD"
    description = "Root-mean-square deviation from the first frame, after superposition."
    n_groups = 2
    group_prompts = ["Selection for least-squares fit", "Selection for RMSD"]
    default_groups = ["name CA", "name CA"]

    async def run(self, ctx, work_dir, line_callback=None):
        import mdtraj as md
        import numpy as np
        traj = _slice(await _load(ctx, line_callback), ctx)
        g = ctx["groups"] or ["name CA", "name CA"]
        fit_sele = g[0]
        meas_sele = g[1] if len(g) > 1 and g[1].strip() else fit_sele
        fit_idx = _select(traj, fit_sele, "fit selection")
        if line_callback:
            line_callback(f"MDTraj RMSD over {traj.n_frames} frames: "
                          f"fit '{fit_sele}', measure '{meas_sele}'")

        if meas_sele == fit_sele:
            values = md.rmsd(traj, traj, frame=0, atom_indices=fit_idx)
        else:
            # md.rmsd() superposes on the same atoms it measures, so a separate
            # fit group has to be done by hand: superpose on the fit selection,
            # then take the plain displacement RMSD of the measured one.
            meas_idx = _select(traj, meas_sele, "RMSD selection")
            traj.superpose(traj, frame=0, atom_indices=fit_idx)
            sub = traj.atom_slice(meas_idx)
            ref = sub.xyz[0]
            values = np.sqrt(np.mean(np.sum((sub.xyz - ref) ** 2, axis=2), axis=1))

        return line_result([t * PS_TO_NS for t in traj.time], list(values),
                           "Time (ns)", "RMSD (nm)", "RMSD vs first frame",
                           self._cmd(ctx))


class MDTRmsf(_MDTrajAnalysis):
    type_id = "rmsf"
    name = "RMSF"
    description = "Per-residue root-mean-square fluctuation about the average structure."
    group_prompts = ["Selection"]
    default_groups = ["name CA"]

    async def run(self, ctx, work_dir, line_callback=None):
        import mdtraj as md
        traj = _slice(await _load(ctx, line_callback), ctx)
        sele = (ctx["groups"] or ["name CA"])[0]
        idx = _select(traj, sele)
        if line_callback:
            line_callback(f"MDTraj RMSF over {traj.n_frames} frames: '{sele}'")

        sub = traj.atom_slice(idx)
        # Superpose first: without it this measures the box drifting, not the
        # protein flexing.
        sub.superpose(sub, frame=0)
        values = md.rmsf(sub, sub, frame=0)

        # Collapse to one point per residue, matching gmx rmsf -res so the
        # Structure tab can colour by it.
        by_res: dict[int, list[float]] = {}
        for atom, val in zip(sub.topology.atoms, values):
            by_res.setdefault(int(atom.residue.resSeq), []).append(float(val))
        resids = sorted(by_res)
        return line_result(resids,
                           [sum(by_res[r]) / len(by_res[r]) for r in resids],
                           "Residue", "RMSF (nm)", "RMSF per residue",
                           self._cmd(ctx))


class MDTGyrate(_MDTrajAnalysis):
    type_id = "gyrate"
    name = "Radius of gyration"
    description = "Radius of gyration vs time — compactness of the selection."
    group_prompts = ["Selection"]
    default_groups = ["protein"]

    async def run(self, ctx, work_dir, line_callback=None):
        import mdtraj as md
        traj = _slice(await _load(ctx, line_callback), ctx)
        sele = (ctx["groups"] or ["protein"])[0]
        idx = _select(traj, sele)
        if line_callback:
            line_callback(f"MDTraj Rg over {traj.n_frames} frames: '{sele}'")
        sub = traj.atom_slice(idx)
        values = md.compute_rg(sub)
        return line_result([t * PS_TO_NS for t in traj.time], list(values),
                           "Time (ns)", "Rg (nm)", "Radius of gyration",
                           self._cmd(ctx))


class MDTSasa(_MDTrajAnalysis):
    type_id = "sasa"
    name = "Solvent accessible surface area"
    description = ("Shrake–Rupley SASA vs time. No external tool needed. "
                   "Name a subset second to get its area within the intact "
                   "molecule.")
    n_groups = 2
    group_prompts = [
        "Surface — the molecule that occludes (usually protein)",
        "Report area for (blank = the whole surface selection)",
    ]
    default_groups = ["protein", ""]
    params_schema = [
        {"key": "probe_radius", "label": "Probe radius (nm)", "type": "number",
         "default": 0.14},
        {"key": "n_sphere_points", "label": "Sphere points (accuracy)",
         "type": "number", "default": 960},
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        import mdtraj as md
        import numpy as np

        traj = _slice(await _load(ctx, line_callback), ctx)
        g = ctx["groups"] or ["protein"]
        surface_sele = g[0]
        subset_sele = g[1].strip() if len(g) > 1 and g[1] else ""
        surface_idx = _select(traj, surface_sele, "surface selection")
        p = ctx.get("params") or {}
        if line_callback:
            line_callback(f"MDTraj SASA over {traj.n_frames} frames "
                          f"(Shrake–Rupley, this is the slow one)")

        sub = traj.atom_slice(surface_idx)
        areas = _sasa_chunked(
            sub, line_callback,
            probe_radius=float(p.get("probe_radius", 0.14)),
            n_sphere_points=int(p.get("n_sphere_points", 960)),
            mode="atom")

        if subset_sele:
            # PER-ATOM areas computed with the whole surface present, then
            # summed over the subset. Slicing the subset out first and measuring
            # it would report what that fragment exposes in isolation — up to
            # 27x too much for a buried patch. See analyses/sasa.py.
            subset_idx = _select(traj, subset_sele, "subset selection")
            pos = {int(a): k for k, a in enumerate(surface_idx)}
            cols = [pos[int(a)] for a in subset_idx if int(a) in pos]
            if not cols:
                raise RuntimeError(
                    f"'{subset_sele}' selects no atoms that are part of "
                    f"'{surface_sele}'. The reported subset has to be inside "
                    f"the surface selection, or there is nothing to report.")
            if len(cols) < len(subset_idx):
                if line_callback:
                    line_callback(
                        f"NOTE: {len(subset_idx) - len(cols)} atom(s) of the "
                        f"subset are outside the surface selection and were "
                        f"not counted.")
            total = [float(row[cols].sum()) for row in areas]
        else:
            total = [float(row.sum()) for row in areas]
        return line_result([t * PS_TO_NS for t in traj.time], total,
                           "Time (ns)", "SASA (nm²)",
                           "Solvent accessible surface area", self._cmd(ctx))


class MDTHBond(_MDTrajAnalysis):
    type_id = "hbond"
    name = "Hydrogen bonds"
    description = ("Hydrogen-bond count vs time, Baker–Hubbard criterion "
                   "(stricter than plain geometry).")
    group_prompts = ["Selection"]
    default_groups = ["protein"]
    params_schema = [
        {"key": "freq", "label": "Minimum occupancy (0–1)", "type": "number",
         "default": 0.0},
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        import mdtraj as md
        traj = _slice(await _load(ctx, line_callback), ctx)
        sele = (ctx["groups"] or ["protein"])[0]
        idx = _select(traj, sele)
        p = ctx.get("params") or {}
        sub = traj.atom_slice(idx)
        if line_callback:
            line_callback(f"MDTraj H-bonds over {sub.n_frames} frames")

        # baker_hubbard returns the bonds that persist; count how many of those
        # are present in each frame, which is the series people expect.
        triplets = md.baker_hubbard(sub, freq=float(p.get("freq", 0.0)),
                                    periodic=True)
        if len(triplets) == 0:
            counts = [0.0] * sub.n_frames
        else:
            distances = md.compute_distances(sub, triplets[:, [0, 2]], periodic=True)
            angles = md.compute_angles(sub, triplets, periodic=True)
            # Baker–Hubbard: donor–acceptor < 0.25 nm and D–H···A > 120°.
            import numpy as np
            present = (distances < 0.25) & (angles > (120.0 * np.pi / 180.0))
            counts = [float(row.sum()) for row in present]
        return line_result([t * PS_TO_NS for t in sub.time], counts,
                           "Time (ns)", "Hydrogen bonds",
                           "Hydrogen bonds vs time", self._cmd(ctx))


class MDTDssp(_MDTrajAnalysis):
    type_id = "dssp"
    name = "Secondary structure"
    description = ("Fraction of residues in helix / sheet / coil vs time "
                   "(built-in DSSP, no external binary).")
    group_prompts = ["Selection"]
    default_groups = ["protein"]

    async def run(self, ctx, work_dir, line_callback=None):
        import mdtraj as md
        traj = _slice(await _load(ctx, line_callback), ctx)
        sele = (ctx["groups"] or ["protein"])[0]
        idx = _select(traj, sele)
        sub = traj.atom_slice(idx)
        if line_callback:
            line_callback(f"MDTraj DSSP over {sub.n_frames} frames")

        codes = md.compute_dssp(sub, simplified=True)   # 'H', 'E', 'C'
        n_res = codes.shape[1] or 1
        helix = [float((row == "H").sum()) / n_res for row in codes]
        return line_result([t * PS_TO_NS for t in sub.time], helix,
                           "Time (ns)", "Fraction in helix",
                           "Helical content vs time", self._cmd(ctx))


class MDTRollingRmsf(_MDTrajAnalysis):
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

        traj = _slice(await _load(ctx, line_callback), ctx)
        sele = (ctx["groups"] or ["name CA"])[0]
        idx = _select(traj, sele)
        window_ns, step_ns = _rolling_params(ctx)

        if line_callback:
            line_callback(f"MDTraj rolling RMSF: '{sele}' ({len(idx)} atoms), "
                          f"{window_ns:g} ns window / {step_ns:g} ns step "
                          f"over {traj.n_frames} frames")

        sub = traj.atom_slice(idx)
        # MDTraj is already in nanometres, so no conversion here — unlike
        # MDAnalysis, which works in angstroms.
        times_ns = [float(t) * PS_TO_NS for t in traj.time]
        windows = time_windows(times_ns, window_ns, step_ns)
        per_atom = np.asarray(
            rmsf_windows_from_coords(sub.xyz, windows, line_callback))
        resids, rows = average_by_residue(
            per_atom, [int(a.residue.resSeq) for a in sub.topology.atoms])
        return _rolling_result(rows, resids, windows, window_ns, step_ns,
                               self._cmd(ctx))


class MDTNewSasa(_MDTrajAnalysis):
    type_id = "sasa_new"
    name = "Newly exposed SASA"
    description = ("Surface area of residues that started BURIED — the signal a "
                   "total SASA hides. A cavity opening exposes a few nm² on a "
                   "surface of 200, well inside the noise of the parts that "
                   "were always exposed.")
    n_groups = 2
    group_prompts = [
        "Surface — the molecule that occludes (usually protein)",
        "Restrict to (blank = every buried residue)",
    ]
    default_groups = ["protein", ""]
    params_schema = [
        {
            "key": "ref_ns",
            "label": "Reference window (ns from the start)",
            "type": "number",
            "default": 10.0,
            "min": 0.0,
            "help": "Residues are classified buried or exposed from their "
                    "AVERAGE area over this opening stretch. A window rather "
                    "than frame 0: a single frame catches side chains wherever "
                    "they happened to be, which flips a few percent of "
                    "residues between categories for no physical reason.",
        },
        {
            "key": "rsa_threshold",
            "label": "Buried if relative accessibility ≤",
            "type": "number",
            "default": 0.20,
            "min": 0.0,
            "max": 1.0,
            "step": 0.05,
            "help": "Fraction of the area that residue type has when fully "
                    "exposed (Tien et al. 2013). 0.20 is the conventional cut. "
                    "Relative, not absolute, because an exposed glycine has "
                    "less surface than a half-buried tryptophan.",
        },
        {
            "key": "min_gain",
            "label": "Count as emerged if it gains ≥ (nm²)",
            "type": "number",
            "default": 0.10,
            "min": 0.0,
            "step": 0.05,
            "help": "Side chains breathe. Without a floor every residue "
                    "appears in the emerged list with a gain of a few "
                    "hundredths.",
        },
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        import mdtraj as md
        import numpy as np
        from core.burial import classify_buried, exposure_gain

        traj = _slice(await _load(ctx, line_callback), ctx)
        g = ctx["groups"] or ["protein"]
        sele = g[0]
        region_sele = g[1].strip() if len(g) > 1 and g[1] else ""
        idx = _select(traj, sele, "surface selection")
        p = ctx.get("params") or {}
        ref_ns = float(p.get("ref_ns", 10.0))
        rsa_cut = float(p.get("rsa_threshold", 0.20))
        min_gain = float(p.get("min_gain", 0.10))

        # Say this BEFORE the expensive pass, not after it fails.
        #
        # The surface has to be the whole occluding molecule: this analysis
        # works out the buried set itself, so handing it a residue subset
        # measures that fragment alone, where almost nothing is buried. That
        # produced a "nothing is buried" error only after several minutes of
        # Shrake-Rupley, which is a poor way to learn it.
        try:
            prot = traj.topology.select("protein")
        except Exception:
            prot = []
        n_sel = len({a.residue.index for a in
                     (traj.topology.atom(int(i)) for i in idx)})
        n_prot = len({traj.topology.atom(int(i)).residue.index for i in prot}) if len(prot) else 0
        subset_note = ""
        if n_prot and n_sel < n_prot and not region_sele:
            subset_note = (f"the surface selection covers {n_sel} of the "
                           f"protein's {n_prot} residues")
            if line_callback:
                line_callback(
                    f"NOTE: {subset_note}. The surface should normally be the "
                    f"WHOLE occluding molecule. To focus on a region, leave the "
                    f"surface as the protein and name the region in the second "
                    f"box — that keeps burial judged against the whole "
                    f"structure while reporting only your residues.")

        if line_callback:
            line_callback(f"MDTraj newly-exposed SASA over {traj.n_frames} frames "
                          f"(Shrake–Rupley per atom, this is the slow part)")

        # Per-atom areas WITH the whole surface selection present, so burial
        # means buried by the rest of the protein — not by nothing at all.
        sub = traj.atom_slice(idx)
        areas = _sasa_chunked(sub, line_callback, mode="atom")   # (frames, atoms) nm^2

        # Collapse to residues once; everything below works per residue.
        res_of = [a.residue for a in sub.topology.atoms]
        order, cols = [], {}
        for k, r in enumerate(res_of):
            key = int(r.resSeq)
            if key not in cols:
                cols[key] = []
                order.append((key, r.name))
            cols[key].append(k)
        per_res = np.stack([areas[:, cols[rn]].sum(axis=1) for rn, _ in order], axis=1)

        times_ns = np.asarray([t * PS_TO_NS for t in traj.time], dtype=np.float64)
        t0 = times_ns[0]
        ref_mask = times_ns <= (t0 + ref_ns) if ref_ns > 0 else np.zeros_like(times_ns, bool)
        if ref_mask.sum() < 2:
            # Fall back to the first tenth rather than classifying from one frame.
            n = max(2, len(times_ns) // 10)
            ref_mask = np.zeros_like(times_ns, bool)
            ref_mask[:n] = True
            if line_callback:
                line_callback(
                    f"The {ref_ns:g} ns reference window holds fewer than two "
                    f"frames; using the first {n} frames instead.")

        ref_area = per_res[ref_mask].mean(axis=0)

        # WHICH residues to classify — the areas above were computed with the
        # whole surface present either way, so restricting here narrows the
        # REPORT without touching the physics. This is what makes "the cavity in
        # my domain" answerable: the rest of the protein still occludes, but its
        # hundred other buried residues stop diluting the signal with their own
        # breathing.
        keep = list(range(len(order)))
        region_note = ""
        if region_sele:
            want = {int(traj.topology.atom(int(a)).residue.resSeq)
                    for a in _select(traj, region_sele, "restrict selection")}
            keep = [i for i, (rn, _) in enumerate(order) if rn in want]
            if not keep:
                raise RuntimeError(
                    f"'{region_sele}' selects no residue that is part of "
                    f"'{sele}'. The region has to lie inside the surface "
                    f"selection — it is the part of it you want reported.")
            region_note = f"{len(keep)} residues in '{region_sele}'"
            if line_callback:
                line_callback(f"Restricting the report to {region_note}; burial "
                              f"is still judged against all of '{sele}'.")

        residues = [{"resnum": order[i][0], "resname": order[i][1]} for i in keep]
        buried, exposed, skipped = classify_buried(
            residues, [ref_area[i] for i in keep], rsa_cut)

        if not buried:
            raise RuntimeError(
                f"Nothing is buried to begin with, so nothing can newly emerge.\n"
                f"No residue in "
                f"{repr(region_sele) if region_sele else repr(sele)} has "
                f"relative accessibility at or below {rsa_cut:.0%} over the "
                f"first {ref_ns:g} ns."
                + (f" All {len(residues)} residues of that region are already "
                   f"exposed at the start." if region_sele else "")
                + (f"\n\nMost likely cause: {subset_note}. Put the WHOLE "
                   f"protein in the surface box — this analysis works out which "
                   f"residues are buried on its own, and a {n_sel}-residue "
                   f"fragment measured alone is almost entirely surface."
                   if subset_note else
                   "\n\nEither the selection really is all surface, or the "
                   "threshold is too strict — try raising it."))

        by_resnum = {rn: i for i, (rn, _) in enumerate(order)}
        buried_cols = [by_resnum[b["resnum"]] for b in buried]
        total = per_res[:, buried_cols].sum(axis=1)

        # Where the new surface came from. Measured over the LAST quarter of the
        # run so a transient opening does not dominate the list.
        tail = max(1, len(times_ns) // 4)
        final_by_resnum = {rn: float(per_res[-tail:, i].mean())
                           for rn, i in by_resnum.items()}
        gains = exposure_gain(buried, final_by_resnum, min_gain)
        emerged = [g for g in gains if g["emerged"]]

        if line_callback:
            line_callback(f"{len(buried)} residues buried at t0, "
                          f"{len(exposed)} exposed"
                          + (f", {len(skipped)} untabulated" if skipped else "")
                          + f"; {len(emerged)} emerged by the end.")

        base = float(ref_area[buried_cols].sum())
        data = line_result(
            times_ns.tolist(), (total - base).tolist(),
            "Time (ns)", "Newly exposed SASA (nm²)",
            f"Newly exposed surface ({len(buried)} residues buried at t0"
            + (f" in {region_sele}" if region_sele else "") + ")",
            self._cmd(ctx))
        # The plot says WHEN; this says WHERE. Carried on the result so the UI
        # can list the residues without recomputing anything.
        data["newly_exposed"] = [
            {k: g[k] for k in ("resnum", "resname", "ref_area", "ref_rsa",
                               "final_area", "final_rsa", "gain")}
            for g in emerged[:60]
        ]
        data["n_buried"] = len(buried)
        data["n_exposed"] = len(exposed)
        data["n_emerged"] = len(emerged)
        data["n_untabulated"] = len(skipped)
        data["rsa_threshold"] = rsa_cut
        data["region"] = region_sele
        data["ref_ns"] = ref_ns
        data["baseline_nm2"] = base
        return data


class MDTDccm(_MDTrajAnalysis):
    type_id = "dccm"
    name = "Cross-correlation (DCCM)"
    description = """ + repr(DESC) + """
    n_groups = 2
    group_prompts = ["Selection for least-squares fit", "Selection for the matrix"]
    default_groups = ["name CA", "name CA"]

    async def run(self, ctx, work_dir, line_callback=None):
        traj = _slice(await _load(ctx, line_callback), ctx)
        g = ctx["groups"] or ["name CA", "name CA"]
        fit_sele = g[0]
        meas_sele = g[1] if len(g) > 1 and g[1].strip() else fit_sele
        fit_idx = _select(traj, fit_sele, "fit selection")
        meas_idx = _select(traj, meas_sele, "matrix selection")
        if line_callback:
            line_callback(f"MDTraj DCCM: fit '{fit_sele}', matrix "
                          f"'{meas_sele}' over {traj.n_frames} frames")

        # Global rotation and translation have to go first, or this measures
        # the box tumbling rather than internal motion.
        traj.superpose(traj, frame=0, atom_indices=fit_idx)
        sub = traj.atom_slice(meas_idx)
        z = dccm_from_coords(sub.xyz, line_callback)
        # resSeq, not resid: resid is MDTraj's own 0-based counter, while resSeq
        # is the number GROMACS wrote into the topology — the one the structure
        # viewer and every other analysis here speak.
        resids = [int(a.residue.resSeq) for a in sub.topology.atoms]
        return heatmap_result(
            z, resids, "Residue", "Residue", "Correlation",
            "Dynamic cross-correlation", self._cmd(ctx), diverging=True,
            residues=resids)


class MDTrajEngine(Engine):
    id = "mdtraj"
    name = "MDTraj"
    description = ("Fast trajectory analysis in Python. Brings Shrake–Rupley "
                   "SASA and built-in DSSP, neither of which needs an external "
                   "binary.")
    homepage = "https://mdtraj.org/1.9.4/atom_selection.html"
    dialect = "mdtraj"
    selection_help = (
        "MDTraj selection syntax: 'protein', 'name CA', 'backbone', "
        "'resSeq 200 to 270', 'resname SOL'. Note resSeq (the residue number in "
        "the topology), not resid (which is a 0-based index)."
    )
    install_hint = (
        "pip install mdtraj      (or: conda install -c conda-forge mdtraj)\n"
        "Install it into the SAME Python that runs the backend — if you launch "
        "from a conda environment, activate that environment first."
    )
    notes = [
        "Cannot read .tpr files, so a topology is dumped from the .tpr with "
        "gmx trjconv on first use and cached. It therefore still needs GROMACS "
        "available, and uses the same flat residue numbering.",
        "Loads the whole trajectory into memory. A multi-microsecond all-atom "
        "run may need a stride.",
    ]

    ANALYSES = {
        "rmsd": MDTRmsd,
        "rmsf": MDTRmsf,
        "rmsf_rolling": MDTRollingRmsf,
        "gyrate": MDTGyrate,
        "sasa": MDTSasa,
        "sasa_new": MDTNewSasa,
        "hbond": MDTHBond,
        "dssp": MDTDssp,
        "dccm": MDTDccm,
    }

    @classmethod
    def probe(cls) -> dict:
        try:
            import mdtraj  # noqa: F401
        except Exception as e:
            return {"available": False, "version": None,
                    "reason": f"MDTraj is not installed in the backend's "
                              f"Python ({type(e).__name__})."}
        try:
            version = mdtraj.version.short_version
        except Exception:
            version = getattr(mdtraj, "__version__", "unknown")
        return {"available": True, "version": version, "reason": None}

    @classmethod
    def chips(cls) -> list[dict]:
        return common_groups(cls.dialect)

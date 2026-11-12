"""
Rolling RMSF — flexibility as a function of time, not just of residue.

A plain RMSF collapses the whole trajectory into one number per residue, which
answers "which parts are floppy" but never "floppy WHEN". Recomputing it in a
sliding window turns it into a residue-by-time map, so a burst of motion can be
lined up against the moment a contact breaks or a distance jumps.

WHY THIS DOES NOT CALL `gmx rmsf` ONCE PER WINDOW
That is the obvious implementation and it is a trap. An .xtc carries no index,
so gmx has to read from the start of the file to reach `-b`; a hundred windows
therefore costs a hundred passes of increasing length over a trajectory that may
be gigabytes. Instead the selection's coordinates are dumped ONCE with
`gmx traj -ox` and every window is computed from that in numpy — the same
routine MDAnalysis and MDTraj use here, so all three engines agree to the last
decimal rather than merely being close.

WHAT THE NUMBER MEANS
Each window is least-squares fitted onto its OWN average structure before the
fluctuation is measured. That is what makes it local: a domain that swings into
a new position and then sits perfectly still reads as RIGID for every window
after the move, rather than staying "flexible" forever because it is far from
where it started. See engines/base.rmsf_windows_from_coords.
"""
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.gmx import run_gmx, read_pdb_residue_numbers

from .base import BaseAnalysis


def _helpers():
    # Deferred for the same reason as analyses/dccm.py: engines/__init__ imports
    # engines.gromacs, which imports this package, so reaching engines.base at
    # module scope would make a working backend depend on import order.
    from engines.base import (_rolling_params, _rolling_result,
                              average_by_residue, rmsf_windows_from_coords,
                              time_windows)
    return (_rolling_params, _rolling_result, average_by_residue,
            rmsf_windows_from_coords, time_windows)


class RollingRMSFAnalysis(BaseAnalysis):
    type_id = "rmsf_rolling"
    name = "Rolling RMSF"
    description = ("RMSF recomputed in a sliding time window, giving a "
                   "residue-by-time map of flexibility. Lets a burst of motion "
                   "be lined up against the moment a contact breaks or a "
                   "distance jumps, which a single whole-trajectory RMSF "
                   "averages away.")
    gmx_tool = "traj"
    n_groups = 1
    group_prompts = ["Group for RMSF calculation"]
    default_groups = ["C-alpha", "Backbone", "Protein"]
    x_is_time = False

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

        (rolling_params, rolling_result, average_by_residue,
         rmsf_windows_from_coords, time_windows) = _helpers()

        work_dir.mkdir(parents=True, exist_ok=True)
        window_ns, step_ns = rolling_params(ctx)
        group = (ctx.get("groups") or ["C-alpha"])[0]

        ref_pdb = work_dir / "group.pdb"
        coord_xvg = work_dir / "coords.xvg"
        for stale in (ref_pdb, coord_xvg):
            # GROMACS backs existing files up with a "Back Off!" notice that can
            # stall a non-interactive run.
            if stale.exists():
                stale.unlink()

        # ── 1. Which residue is each atom? ───────────────────────────────────
        # gmx traj -ox writes bare numbers with no identity attached, so the
        # group is dumped once as a PDB to learn the residue of every column.
        args = ["trjconv", "-s", ctx["tpr"], "-f", ctx["xtc"],
                "-o", str(ref_pdb), "-dump", "0"]
        if ctx.get("ndx"):
            args += ["-n", ctx["ndx"]]
        if line_callback:
            line_callback(f"Identifying the atoms in '{group}'…")
        r = await run_gmx(args, stdin_input=f"{group}\n", cwd=work_dir,
                          line_callback=line_callback, timeout=self.timeout)
        resids = read_pdb_residue_numbers(ref_pdb)
        if not resids:
            raise RuntimeError(
                f"Could not work out which residues '{group}' covers.\n"
                f"Command: {r['cmd']}\nstderr tail: {r['stderr'][-600:]}")

        # ── 2. Coordinates, in one pass ──────────────────────────────────────
        args = ["traj", "-s", ctx["tpr"], "-f", ctx["xtc"],
                "-ox", str(coord_xvg), "-com", "no"]
        if ctx.get("ndx"):
            args += ["-n", ctx["ndx"]]
        args += self.frame_args(ctx)
        if line_callback:
            line_callback(f"Dumping coordinates for {len(resids)} atoms "
                          f"(gmx traj -ox). This writes a large text file.")
        r = await run_gmx(args, stdin_input=f"{group}\n", cwd=work_dir,
                          line_callback=line_callback, timeout=self.timeout)
        if not r["success"] or not coord_xvg.is_file():
            raise RuntimeError(
                f"{self.name} could not dump coordinates (exit {r['returncode']}).\n"
                f"Command: {r['cmd']}\nstderr tail: {r['stderr'][-800:]}")

        times_ps, coords = _read_coordinate_dump(coord_xvg, len(resids))
        if line_callback:
            line_callback(f"Read {coords.shape[0]} frames x {coords.shape[1]} atoms; "
                          f"building {window_ns:g} ns windows.")

        # ── 3. The same arithmetic every other engine uses ───────────────────
        times_ns = [t / 1000.0 for t in times_ps]
        windows = time_windows(times_ns, window_ns, step_ns)
        per_atom = np.asarray(
            rmsf_windows_from_coords(coords, windows, line_callback))
        residues, rows = average_by_residue(per_atom, resids)
        return rolling_result(rows, residues, windows, window_ns, step_ns,
                              r["cmd"])


def _read_coordinate_dump(path: Path, n_atoms: int):
    """
    Read `gmx traj -ox` output into (times_ps, coords[frames, atoms, 3]).

    Read with numpy rather than the shared parse_xvg: this file is one row per
    frame with 3N+1 columns, so a 5000-frame dump of 500 atoms is 7.5 million
    numbers. Built as Python lists that is hundreds of megabytes and slow;
    numpy reads it in one go.

    The column count is checked against the atom count instead of trusted,
    because a reshape of the wrong width produces a full, plausible-looking
    matrix of nonsense rather than an error.
    """
    import numpy as np

    raw = np.loadtxt(path, comments=["#", "@"], ndmin=2)
    if raw.size == 0:
        raise RuntimeError("gmx traj wrote no coordinate data.")

    expected = 3 * n_atoms + 1
    if raw.shape[1] != expected:
        raise RuntimeError(
            f"The coordinate dump has {raw.shape[1]} columns but the group has "
            f"{n_atoms} atoms, which should give {expected} (time plus x, y, z "
            f"each). The dump and the structure do not describe the same "
            f"selection.")

    times_ps = raw[:, 0].tolist()
    coords = raw[:, 1:].reshape(raw.shape[0], n_atoms, 3)
    return times_ps, coords

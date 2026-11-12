"""
Analysis engine contract.

An ENGINE is a piece of MD analysis software — GROMACS, MDAnalysis, MDTraj,
cpptraj. Each brings its own selection language, its own set of analyses, and
its own idea of what it needs to read a trajectory. What they must agree on is
the shape of the ANSWER, so that everything downstream — the Results tab, the
Compare tab, the structure colouring, the ChimeraX export — keeps working
without knowing or caring which engine produced a series.

That shared answer is the dict returned by run():

    {"kind": "line", "x": [...], "y": [...],
     "xlabel": str, "ylabel": str, "title": str, "_cmd": str}

(or "kind": "heatmap" with "z"). It is exactly what the original
GROMACS-only analyses returned, which is why adding engines did not require
touching a single plot.

TWO THINGS EVERY ENGINE MUST GET RIGHT
  1. UNITS. The UI speaks nanoseconds and nanometres, because GROMACS does.
     MDAnalysis and MDTraj do not: MDAnalysis works in Angstrom and ps,
     MDTraj in nanometres and ps. Converting in the engine — never in the
     plot — is what keeps an RMSD from being wrong by a factor of ten
     depending on which engine you picked.
  2. NUMBERING. Selections arrive as flat residue indices (see
     core/selections.py). An engine that cannot read a .tpr must therefore be
     handed a topology derived from one, not the reference PDB.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional


class EngineAnalysis:
    """One analysis, as implemented by one engine."""

    type_id: str = ""
    name: str = ""
    description: str = ""

    n_groups: int = 1
    group_prompts: list[str] = ["Selection"]
    # In THIS engine's dialect — 'C-alpha' for GROMACS, 'name CA' for MDAnalysis.
    default_groups: list[str] = ["Protein"]
    params_schema: list[dict] = []

    # Wall-clock ceiling. Trajectory-streaming analyses scale with file size.
    timeout: int = 7200

    # DOES run() HOLD THE EVENT LOOP?
    #
    # True for an analysis that computes in-process — numpy, MDAnalysis, MDTraj
    # — because `async def` does NOT make CPU work concurrent. A coroutine that
    # never awaits runs start to finish without yielding, and the loop it runs
    # on is the SAME one serving the HTTP API, so the whole backend stops
    # answering for the duration: no job progress, no tab switches, nothing.
    # Three minutes of cavity volume froze the entire app.
    #
    # The runner pushes these to a worker thread instead (see _run_engine).
    # False is correct for an engine that shells out to gmx or cpptraj: those
    # await a subprocess, which yields the loop on its own.
    blocking: bool = False

    def describe(self) -> dict:
        return {
            "type": self.type_id,
            "name": self.name,
            "description": self.description,
            "n_groups": self.n_groups,
            "group_prompts": self.group_prompts,
            "default_groups": self.default_groups,
            "params_schema": self.params_schema,
        }

    async def run(self, ctx: dict, work_dir: Path,
                  line_callback: Optional[Callable[[str], None]] = None) -> dict:
        raise NotImplementedError


class Engine:
    """A piece of analysis software, and the analyses it can run."""

    id: str = ""
    name: str = ""
    description: str = ""
    homepage: str = ""
    # Which selection dialect this engine speaks — see core/selections.py.
    dialect: str = ""
    selection_help: str = ""
    # Shown when the engine is missing. Exact, and naming the right environment,
    # because "pip install X" into the wrong interpreter is the usual outcome.
    install_hint: str = ""
    # Caveats a user should know BEFORE running, not after reading a odd result.
    notes: list[str] = []

    ANALYSES: dict[str, type[EngineAnalysis]] = {}

    @classmethod
    def probe(cls) -> dict:
        """
        Report whether this engine can actually run here.

        Returns {"available": bool, "version": str|None, "reason": str|None}.
        Never raises: a broken optional dependency must degrade to "not
        available, here is why", not take the whole analyses list down with it.
        """
        raise NotImplementedError

    @classmethod
    def get(cls, type_id: str) -> EngineAnalysis:
        klass = cls.ANALYSES.get(type_id)
        if klass is None:
            raise ValueError(
                f"{cls.name} cannot run '{type_id}'. It offers: "
                f"{', '.join(sorted(cls.ANALYSES)) or '(nothing)'}.")
        return klass()

    @classmethod
    def list_analyses(cls) -> list[dict]:
        return [k().describe() for k in cls.ANALYSES.values()]

    @classmethod
    def describe(cls) -> dict:
        probe = cls.probe()
        return {
            "id": cls.id,
            "name": cls.name,
            "description": cls.description,
            "homepage": cls.homepage,
            "dialect": cls.dialect,
            "selection_help": cls.selection_help,
            "install_hint": cls.install_hint,
            "notes": list(cls.notes),
            "analyses": cls.list_analyses(),
            **probe,
        }


# ─── Shared helpers for the Python engines ────────────────────────────────────

def frame_indices(times_ps, t_start_ns, t_end_ns, stride: int) -> list[int]:
    """
    Which frames to analyse, from a list of frame times in picoseconds.

    The time window is applied in TIME, not frame count, so it means the same
    thing whatever the trajectory's timestep — matching what `gmx -b/-e` does,
    so switching engines does not silently change which part of the run you
    measured. Stride is applied after the window, so "every 10th frame from
    100 ns" is the same ten frames in every engine.
    """
    lo = None if t_start_ns is None else float(t_start_ns) * 1000.0
    hi = None if t_end_ns is None else float(t_end_ns) * 1000.0
    step = max(1, int(stride or 1))

    kept = [i for i, t in enumerate(times_ps)
            if (lo is None or t >= lo - 1e-6) and (hi is None or t <= hi + 1e-6)]
    return kept[::step]


def line_result(x, y, xlabel: str, ylabel: str, title: str, cmd: str = "") -> dict:
    """The standard line payload, so every engine returns the same shape."""
    return {
        "kind": "line",
        "x": [float(v) for v in x],
        "y": [float(v) for v in y],
        "xlabel": xlabel,
        "ylabel": ylabel,
        "title": title,
        "_cmd": cmd,
    }


def heatmap_result(z, axis, xlabel: str, ylabel: str, zlabel: str,
                   title: str, cmd: str = "", diverging: bool = False,
                   residues=None) -> dict:
    """
    The standard matrix payload, matching what the 2D-RMSD analysis returns.

    `diverging` tells the plot that zero is the meaningful midpoint, so it uses
    a red/blue scale centred there rather than a sequential one. On a
    correlation matrix that is not decoration: with a sequential scale, -1 and
    +1 read as "low" and "high" instead of "moves oppositely" and "moves
    together", which inverts the interpretation of half the plot.

    `residues` is what makes a matrix CLICKABLE: one flat GROMACS residue index
    per row, in row order. Without it, dragging a box across the plot yields two
    ranges of matrix indices and nothing can say which residues those are — so
    the axis tick "142" might be the 142nd selected atom rather than residue
    142. The analysis_runner maps these to (chain, resnum) before the result is
    stored, using the same system definition the structure viewer uses, so the
    two agree on what a residue number means.
    """
    data = {
        "kind": "heatmap",
        "z": z,
        "x": list(axis),
        "y": list(axis),
        "xlabel": xlabel,
        "ylabel": ylabel,
        "zlabel": zlabel,
        "title": title,
        "diverging": diverging,
        "_cmd": cmd,
    }
    if residues is not None:
        data["residues"] = [int(r) for r in residues]
    return data


# A matrix is N x N, and it has to survive being JSON-encoded, shipped to the
# browser and handed to Plotly. 1200 residues is 1.44M cells — already a ~10 MB
# payload after rounding. Past that the browser is the bottleneck, not the
# science, so refuse with an instruction rather than hanging the app.
MAX_MATRIX_SIDE = 1200


def dccm_from_coords(coords, line_callback=None):
    """
    Dynamic cross-correlation matrix from superposed coordinates.

    coords: (n_frames, n_atoms, 3), already superposed — DCCM measures
    correlated MOTION, and without removing overall rotation and translation it
    mostly measures the molecule tumbling in the box, which shows up as a
    uniformly positive matrix.

        C_ij    = < dr_i . dr_j >                (dot product, summed over xyz)
        DCCM_ij = C_ij / sqrt(C_ii * C_jj)

    so the diagonal is exactly 1 and the range is [-1, +1].

    Computed as one matrix product rather than a per-pair loop: for 600 atoms
    over 10 000 frames the naive double loop is ~10^11 operations, while
    D.T @ D is a single BLAS call on a 1800x1800 result.
    """
    import numpy as np

    arr = np.asarray(coords, dtype=np.float64)
    if arr.ndim != 3 or arr.shape[2] != 3:
        raise RuntimeError(
            f"Expected coordinates shaped (frames, atoms, 3), got {arr.shape}.")
    n_frames, n_atoms, _ = arr.shape

    if n_atoms < 2:
        raise RuntimeError(
            "A cross-correlation matrix needs at least 2 atoms; the selection "
            "matched " + str(n_atoms) + ".")
    if n_atoms > MAX_MATRIX_SIDE:
        raise RuntimeError(
            f"The selection has {n_atoms} atoms, which would be a "
            f"{n_atoms}x{n_atoms} matrix — too large to plot. Narrow it, for "
            f"example to C-alpha atoms only, or to one chain.")
    if n_frames < 3:
        raise RuntimeError(
            f"Only {n_frames} frame(s) fall in the window. A correlation needs "
            f"a fluctuation to correlate; use a wider time window or no stride.")

    if line_callback:
        line_callback(f"DCCM: {n_atoms} atoms over {n_frames} frames")

    # Displacement of every atom from its own mean position.
    d = arr - arr.mean(axis=0)

    # (frames, 3N) -> (3N, 3N) covariance, then collapse each 3x3 xyz block to
    # its trace, which is exactly the <dr_i . dr_j> dot product.
    flat = d.reshape(n_frames, n_atoms * 3)
    full = (flat.T @ flat) / n_frames
    cov = full.reshape(n_atoms, 3, n_atoms, 3).trace(axis1=1, axis2=3)

    var = np.diag(cov).copy()
    # An atom that never moves has zero variance and would divide by zero.
    # Restraints and frozen atoms make this a real case, not a theoretical one.
    frozen = var <= 1e-12
    var[frozen] = 1.0
    norm = np.sqrt(var)
    dccm = cov / np.outer(norm, norm)
    # A motionless atom correlates with nothing, including itself.
    if frozen.any():
        dccm[frozen, :] = 0.0
        dccm[:, frozen] = 0.0
        if line_callback:
            line_callback(f"NOTE: {int(frozen.sum())} atom(s) do not move at "
                          f"all and are shown as uncorrelated.")

    # Clip to kill floating-point overshoot past +/-1, then round: three
    # decimals is far beyond what a correlation coefficient means, and it
    # shrinks the payload several-fold.
    return np.round(np.clip(dccm, -1.0, 1.0), 3).tolist()


def require_selection_hits(n: int, sele: str, what: str = "selection") -> None:
    """
    Fail loudly on an empty selection.

    An empty selection is the single most common way to get a plausible-looking
    but meaningless result out of any of these packages — MDAnalysis happily
    computes the radius of gyration of zero atoms as 0.0, forever. Better a
    clear error than a flat line at zero.
    """
    if n == 0:
        raise RuntimeError(
            f"The {what} '{sele}' matched 0 atoms. Check the syntax for this "
            f"engine — selection languages differ between them.")


# ─── Rolling RMSF ─────────────────────────────────────────────────────────────
#
# A plain RMSF collapses a whole trajectory into one number per residue, which
# answers "which parts are floppy" but not "floppy WHEN". Recomputing it in a
# sliding window turns it into a residue-by-time map, so a burst of flexibility
# can be lined up against the moment a contact breaks or a distance jumps.
#
# The windowing is shared so that every engine cuts time the same way. If one
# engine used window STARTS and another window CENTRES for its x-axis, the two
# would appear to disagree about when an event happened by half a window.

# A residue-by-time map is n_residues x n_windows. Rows are bounded by
# MAX_MATRIX_SIDE like any other matrix; columns get their own, larger bound
# because time is the axis being resolved and 2000 columns is still only a few
# megabytes once rounded.
MAX_WINDOWS = 2000

# Fewer frames than this in a window and the fluctuation is noise: with two
# frames every atom's "fluctuation" is just half the distance it happened to
# move, which says nothing about flexibility.
MIN_FRAMES_PER_WINDOW = 5


def time_windows(times_ns, window_ns: float, step_ns: float):
    """
    Cut a list of frame times into overlapping windows.

    Returns [(i0, i1, centre_ns), ...] with i1 EXCLUSIVE, covering only whole
    windows — a trailing partial window is dropped rather than reported, because
    an RMSF from 3 frames sitting next to one from 200 looks like a real spike
    at the end of every trajectory.

    The x-position of a window is its CENTRE. A window describes a span of time,
    not an instant, and labelling it with its start would shift every feature
    half a window earlier than it happened — which is exactly the error that
    matters when the point is lining events up against another trace.
    """
    if window_ns <= 0:
        raise RuntimeError("The window length must be greater than zero.")
    if step_ns <= 0:
        raise RuntimeError("The step must be greater than zero.")
    if len(times_ns) < 2:
        raise RuntimeError("Need at least two frames to compute a rolling RMSF.")

    t0, t_end = float(times_ns[0]), float(times_ns[-1])
    span = t_end - t0
    if window_ns > span:
        raise RuntimeError(
            f"The window ({window_ns:g} ns) is longer than the trajectory "
            f"({span:g} ns, {t0:g}–{t_end:g}). Use a shorter window.")

    out = []
    start = t0
    # Float accumulation would drift over hundreds of steps, so the window
    # number drives the arithmetic rather than a running sum.
    k = 0
    while True:
        start = t0 + k * step_ns
        stop = start + window_ns
        if stop > t_end + 1e-9:
            break
        i0 = _first_at_or_after(times_ns, start)
        i1 = _first_at_or_after(times_ns, stop + 1e-9)
        if i1 - i0 >= MIN_FRAMES_PER_WINDOW:
            out.append((i0, i1, start + window_ns / 2.0))
        k += 1
        if len(out) > MAX_WINDOWS:
            raise RuntimeError(
                f"That window and step give more than {MAX_WINDOWS} windows. "
                f"Increase the step (currently {step_ns:g} ns) or the window.")

    if not out:
        raise RuntimeError(
            f"No window of {window_ns:g} ns contains at least "
            f"{MIN_FRAMES_PER_WINDOW} frames. The trajectory may be too coarsely "
            f"sampled for a window this short — try a longer window, or a "
            f"smaller stride.")
    return out


def _first_at_or_after(times, t):
    """Index of the first time >= t. Times from a trajectory are sorted."""
    import bisect
    return bisect.bisect_left(times, t)


def _superpose_batch(mobile, ref):
    """
    Least-squares fit every frame of `mobile` onto `ref`.

    mobile: (n_frames, n_atoms, 3); ref: (n_atoms, 3). Returns the fitted
    coordinates. Kabsch via SVD, with the reflection case handled — without
    that correction a near-planar selection can be fitted with a MIRRORED
    rotation, which is not a rigid motion and silently halves the fluctuation
    it was supposed to measure.
    """
    import numpy as np

    mob_c = mobile - mobile.mean(axis=1, keepdims=True)
    ref_c = ref - ref.mean(axis=0)

    # H = mobile^T ref, per frame.
    h = np.einsum('fai,aj->fij', mob_c, ref_c)
    u, _s, vt = np.linalg.svd(h)

    # R = U D V^T with D = diag(1, 1, sign(det(U V^T))), applied as x @ R.
    d = np.sign(np.linalg.det(np.einsum('fij,fjk->fik', u, vt)))
    d[d == 0] = 1.0
    dmat = np.zeros((len(h), 3, 3))
    dmat[:, 0, 0] = 1.0
    dmat[:, 1, 1] = 1.0
    dmat[:, 2, 2] = d
    rot = np.einsum('fij,fjk,fkl->fil', u, dmat, vt)
    return np.einsum('fai,fij->faj', mob_c, rot)


def rmsf_windows_from_coords(coords, windows, line_callback=None):
    """
    Per-atom RMSF inside each window.

    coords: (n_frames, n_atoms, 3) in the engine's own length units.
    Returns an (n_atoms, n_windows) list of lists.

    Each window is fitted onto its OWN average structure, not onto a global
    reference. That is what makes the number mean "how much is this residue
    moving right now": fluctuation measured about a distant reference would
    include the conformational change that got there, so a protein that settled
    into a new, perfectly rigid state would report high flexibility forever.
    Two fitting passes — to the first frame, then to the resulting mean — which
    is where this converges in practice.
    """
    import numpy as np

    arr = np.asarray(coords, dtype=np.float64)
    if arr.ndim != 3 or arr.shape[2] != 3:
        raise RuntimeError(f"Expected (frames, atoms, 3) coordinates, got {arr.shape}.")
    n_atoms = arr.shape[1]

    out = np.empty((n_atoms, len(windows)), dtype=np.float64)
    for col, (i0, i1, _centre) in enumerate(windows):
        block = arr[i0:i1]
        ref = block[0]
        for _ in range(2):
            fitted = _superpose_batch(block, ref)
            ref = fitted.mean(axis=0)
        dev = fitted - fitted.mean(axis=0)
        out[:, col] = np.sqrt((dev ** 2).sum(axis=2).mean(axis=0))
        if line_callback and len(windows) > 20 and col % max(1, len(windows) // 10) == 0:
            line_callback(f"  window {col + 1}/{len(windows)}")
    return out


def average_by_residue(values_by_atom, resids):
    """
    Collapse a per-atom quantity to one row per residue, as `gmx rmsf -res` does.

    values_by_atom: (n_atoms, n_windows). Returns (resids_sorted, matrix).
    With a C-alpha selection this is a relabelling; for anything wider it is a
    real average, and it keeps the y-axis in residues so the map can be read
    against a sequence and painted onto a structure.
    """
    import numpy as np

    arr = np.asarray(values_by_atom, dtype=np.float64)
    order: dict[int, list[int]] = {}
    for i, rid in enumerate(resids):
        order.setdefault(int(rid), []).append(i)
    keys = sorted(order)
    rows = np.vstack([arr[order[k], :].mean(axis=0) for k in keys])
    return keys, rows


def matrix_result(z, x, y, xlabel: str, ylabel: str, zlabel: str,
                  title: str, cmd: str = "", residues=None,
                  time_x: bool = False, extras: dict | None = None) -> dict:
    """
    A RECTANGULAR matrix payload: x and y are different axes.

    heatmap_result() takes one axis and uses it for both, which is right for a
    correlation or 2D-RMSD matrix and wrong for anything plotted against time.
    `time_x` tells the plot that the x-axis is nanoseconds, which is what lets
    it overlay another trace on the same axis and open a frame from a click.
    """
    data = {
        "kind": "heatmap",
        "z": z,
        "x": list(x),
        "y": list(y),
        "xlabel": xlabel,
        "ylabel": ylabel,
        "zlabel": zlabel,
        "title": title,
        "time_x": time_x,
        "_cmd": cmd,
    }
    if residues is not None:
        data["residues"] = [int(r) for r in residues]
    if extras:
        data.update(extras)
    return data


def _rolling_params(ctx: dict) -> tuple[float, float]:
    """Window and step in ns, defaulted and validated in one place."""
    p = ctx.get("params") or {}
    try:
        window_ns = float(p.get("window_ns", 10.0))
        step_ns = float(p.get("step_ns", 2.0))
    except (TypeError, ValueError):
        raise RuntimeError("The window and step must be numbers, in nanoseconds.")
    if step_ns > window_ns:
        raise RuntimeError(
            f"The step ({step_ns:g} ns) is longer than the window "
            f"({window_ns:g} ns), which would skip over stretches of the "
            f"trajectory entirely. Use a step no larger than the window.")
    return window_ns, step_ns


def _rolling_result(rows, resids, windows, window_ns: float, step_ns: float,
                    cmd: str) -> dict:
    """The residue-by-time payload, shared so every engine ships the same shape."""
    if len(resids) > MAX_MATRIX_SIDE:
        raise RuntimeError(
            f"The selection covers {len(resids)} residues, which is too tall to "
            f"plot ({MAX_MATRIX_SIDE} max). Narrow it to one chain or a domain.")
    centres = [round(w[2], 4) for w in windows]
    return matrix_result(
        [[round(float(v), 4) for v in row] for row in rows],
        centres, resids,
        "Time (ns)", "Residue", "RMSF (nm)",
        f"Rolling RMSF ({window_ns:g} ns window, {step_ns:g} ns step)",
        cmd, residues=resids, time_x=True,
        extras={"window_ns": window_ns, "step_ns": step_ns,
                "n_windows": len(windows)})

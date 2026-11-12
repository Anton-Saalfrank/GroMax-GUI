"""
Dynamic cross-correlation matrix, via gmx covar.

GROMACS has no DCCM tool. What it does have is `gmx covar`, which computes the
3N x 3N covariance matrix of atomic displacements after a least-squares fit —
and a DCCM is just that matrix, collapsed per atom pair and normalised:

    C_ij    = < dr_i . dr_j >       (the trace of the 3x3 xyz block)
    DCCM_ij = C_ij / sqrt(C_ii * C_jj)

so the diagonal is 1 and the range is [-1, +1]. The arithmetic is shared with
the other engines (engines/base.py) so all four agree to the last decimal.

WHY THE ASCII FILE IS READ THE WAY IT IS
`gmx covar -ascii` has written its matrix as one value per line in some
versions and as wrapped rows in others. Rather than depend on which, every
number in the file is read and the count is checked against (3N)^2. That both
survives the layout difference and catches a truncated file, instead of
reshaping a short read into a plausible-looking wrong answer.
"""
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.gmx import run_gmx

from .base import BaseAnalysis

# NOT imported at module scope, deliberately.
#
# engines/__init__ imports engines.gromacs, which does `from analyses import
# REGISTRY` — so importing engines.base from here at import time closes a cycle:
# `import analyses` first and analyses/__init__ is still half-built when gromacs
# asks it for REGISTRY. The app only avoided it by importing engines first, which
# made a working backend depend on the order two modules happen to be reached in.
# Importing inside the functions breaks the cycle without moving anything.
def _result_helpers():
    from engines.base import MAX_MATRIX_SIDE, heatmap_result
    return MAX_MATRIX_SIDE, heatmap_result


class DCCMAnalysis(BaseAnalysis):
    type_id = "dccm"
    name = "Cross-correlation (DCCM)"
    description = ("Correlated motion between residue pairs. +1 moves together, "
                   "-1 moves oppositely — the standard way to spot allosteric "
                   "coupling and rigid domains.")
    gmx_tool = "covar"
    n_groups = 2
    group_prompts = ["Group for least-squares fit", "Group for the matrix"]
    default_groups = ["Backbone", "C-alpha", "Protein"]
    x_is_time = False

    async def run(self, ctx, work_dir, line_callback=None):
        work_dir.mkdir(parents=True, exist_ok=True)
        ascii_path = work_dir / "covar_ascii.dat"
        avg_path = work_dir / "average.pdb"
        for stale in (ascii_path, work_dir / "eigenval.xvg",
                      work_dir / "eigenvec.trr", avg_path,
                      work_dir / "covar.log"):
            # GROMACS backs up existing files with a "Back Off!" notice that can
            # stall a non-interactive run; clearing them first avoids it.
            if stale.exists():
                stale.unlink()

        args = [
            "covar",
            "-s", ctx["tpr"],
            "-f", ctx["xtc"],
            # Every output named explicitly so nothing lands in the cwd.
            "-o", str(work_dir / "eigenval.xvg"),
            "-v", str(work_dir / "eigenvec.trr"),
            "-av", str(avg_path),
            "-l", str(work_dir / "covar.log"),
            "-ascii", str(ascii_path),
        ]
        if ctx.get("ndx"):
            args += ["-n", ctx["ndx"]]
        args += self.frame_args(ctx)

        groups = ctx.get("groups") or ["Backbone", "C-alpha"]
        fit = groups[0]
        meas = groups[1] if len(groups) > 1 and str(groups[1]).strip() else fit
        stdin = f"{fit}\n{meas}\n"

        if line_callback:
            line_callback(f"Running: gmx {' '.join(args)}")
        result = await run_gmx(args, stdin_input=stdin, cwd=work_dir,
                               line_callback=line_callback, timeout=self.timeout)

        if not result["success"]:
            raise RuntimeError(
                f"{self.name} failed (exit {result['returncode']}).\n"
                f"Command: {result['cmd']}\n"
                f"stderr tail: {result['stderr'][-800:]}")
        if not ascii_path.exists():
            raise RuntimeError(
                f"{self.name} finished but gmx covar wrote no -ascii matrix.\n"
                f"stderr tail: {result['stderr'][-800:]}")

        z, n_atoms = _read_covariance(ascii_path)

        # gmx covar writes the average structure of the ANALYSIS group, so its
        # atoms are exactly the matrix rows, in the same order. That is the only
        # thing that says which residue row 142 is — without it the axis is a
        # count of selected atoms, and dragging a region of the plot could not
        # be turned into a selection on the structure.
        residues = _read_average_residues(avg_path, n_atoms,
                                          line_callback)
        axis = residues if residues else list(range(1, n_atoms + 1))
        label = "Residue" if residues else "Atom in group"
        _, heatmap_result = _result_helpers()
        return heatmap_result(
            z, axis, label, label, "Correlation",
            "Dynamic cross-correlation", result["cmd"], diverging=True,
            residues=residues)


def _read_covariance(path: Path):
    """
    Read gmx covar's ASCII covariance matrix and normalise it to a DCCM.

    Returns (matrix, n_atoms).
    """
    import numpy as np

    tokens = [t for line in path.read_text().splitlines()
              if line.strip() and not line.lstrip().startswith(("#", "@"))
              for t in line.split()]
    values = np.asarray(tokens, dtype=np.float64)

    total = values.size
    side = int(round(total ** 0.5))
    if side * side != total or side % 3 != 0:
        raise RuntimeError(
            f"gmx covar's matrix has {total} values, which is not a square of a "
            f"multiple of three. The file may be truncated or from a build that "
            f"writes a different format.")

    n_atoms = side // 3
    MAX_MATRIX_SIDE, _ = _result_helpers()
    if n_atoms > MAX_MATRIX_SIDE:
        raise RuntimeError(
            f"The group has {n_atoms} atoms, which would be a "
            f"{n_atoms}x{n_atoms} matrix — too large to plot. Use C-alpha only, "
            f"or one chain.")

    full = values.reshape(side, side)
    # Collapse each 3x3 xyz block to its trace, then normalise. Shared with the
    # other engines so the four agree exactly.
    cov = full.reshape(n_atoms, 3, n_atoms, 3).trace(axis1=1, axis2=3)
    return _normalise(cov), n_atoms


def _read_average_residues(path: Path, n_atoms: int, line_callback=None):
    """
    Per-row residue numbers, read from the average structure gmx covar writes.

    Returns None — not a guess — if the file is missing or does not have exactly
    one atom per matrix row. A wrong mapping here would colour the wrong part of
    the protein while looking entirely plausible, which is worse than the
    feature simply being unavailable.
    """
    from core.gmx import read_pdb_residue_numbers

    resnums = read_pdb_residue_numbers(path)
    if resnums is None:
        if line_callback:
            line_callback("gmx covar wrote no readable average structure, so the "
                          "matrix axis stays as atom numbers and region-selection "
                          "on the plot is unavailable.")
        return None
    if len(resnums) != n_atoms:
        if line_callback:
            line_callback(
                f"The average structure has {len(resnums)} atoms but the matrix "
                f"is {n_atoms}x{n_atoms}; not mapping rows to residues.")
        return None
    return resnums


def _normalise(cov):
    """C_ij / sqrt(C_ii C_jj), guarding atoms that never move."""
    import numpy as np

    var = np.diag(cov).astype(np.float64).copy()
    frozen = var <= 1e-12
    var[frozen] = 1.0
    norm = np.sqrt(var)
    dccm = cov / np.outer(norm, norm)
    if frozen.any():
        dccm[frozen, :] = 0.0
        dccm[:, frozen] = 0.0
    return np.round(np.clip(dccm, -1.0, 1.0), 3).tolist()

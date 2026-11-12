"""
DSSP secondary structure over time (gmx dssp, GROMACS 2023+).

Matches the GROMACS 2024.2 interface:
  gmx dssp -f traj -s tpr -o out.dat -sel <selection> -hmode dssp
  - selection is given via -sel (modern selection syntax), NOT stdin groups
  - -o writes a .dat: one line per frame, each a string of per-residue SS codes
  - -hmode dssp uses pseudo-hydrogens from C/O coords, essential for MD
    trajectories that lack DSSP-standard hydrogen atom naming (the usual
    cause of gmx dssp failing or giving empty output)
"""
from pathlib import Path
from typing import Optional, Callable
from .base import BaseAnalysis

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from core.gmx import run_gmx


# One-symbol SS designations used by gmx dssp 2024 (from -h):
#   H alpha-helix, B isolated beta-bridge, E extended strand,
#   G 3_10-helix, I pi-helix, P kappa/PPII-helix, S bend,
#   T H-bonded turn, = break, ~ loop
SS_CODES = {
    "H": (0, "α-helix"),
    "G": (1, "3₁₀-helix"),
    "I": (2, "π-helix"),
    "E": (3, "β-strand"),
    "B": (4, "β-bridge"),
    "P": (5, "PPII-helix"),
    "T": (6, "turn"),
    "S": (7, "bend"),
    "~": (8, "loop"),
    "=": (8, "loop"),     # chain break rendered as loop
    " ": (8, "loop"),
}
CATEGORIES = ["α-helix", "3₁₀", "π-helix", "β-strand", "β-bridge",
              "PPII", "turn", "bend", "loop"]


class DSSPAnalysis(BaseAnalysis):
    type_id = "dssp"
    name = "Secondary structure (DSSP)"
    description = "Per-residue secondary structure over time."
    gmx_tool = "dssp"
    n_groups = 1
    group_prompts = ["Selection for DSSP (usually Protein)"]
    default_groups = ["Protein"]
    x_is_time = False

    async def run(self, ctx: dict, work_dir: Path,
                  line_callback: Optional[Callable[[str], None]] = None) -> dict:
        """
        gmx dssp uses -sel (modern selection) instead of stdin group numbers,
        so we override run() rather than using the base stdin mechanism.
        """
        work_dir.mkdir(parents=True, exist_ok=True)
        stem = ctx.get("_out_name") or "dssp"
        out_dat = work_dir / f"{stem}.dat"
        ctx["_ss_out"] = out_dat

        # Selection: the resolved group name (or custom sel). gmx dssp -sel
        # accepts a group name that exists in the (optional) index file.
        groups = ctx.get("groups", []) or ["Protein"]
        sel = groups[0]

        args = [
            "dssp",
            "-f", ctx["xtc"],
            "-s", ctx["tpr"],
            "-o", str(out_dat),
            "-sel", sel,
            "-hmode", "dssp",   # pseudo-H from C/O — robust for MD trajectories
        ]
        if ctx.get("ndx"):
            args += ["-n", ctx["ndx"]]
        args += self.frame_args(ctx)

        result = await run_gmx(args, cwd=work_dir,
                               line_callback=line_callback, timeout=7200)
        if not result["success"]:
            raise RuntimeError(
                f"gmx dssp failed (exit {result['returncode']}).\n"
                f"Command: {result['cmd']}\n"
                f"stderr tail: {result['stderr'][-800:]}"
            )
        if not out_dat.exists():
            raise RuntimeError(
                f"gmx dssp produced no output.\nCommand: {result['cmd']}\n"
                f"stderr tail: {result['stderr'][-800:]}"
            )

        data = self.parse(out_dat, ctx)
        data["_cmd"] = result["cmd"]
        return data

    def parse(self, output: Path, ctx: dict) -> dict:
        # .dat: one line per frame, each line a string of per-residue SS codes
        raw = [l.rstrip("\n") for l in output.read_text().splitlines()
               if l and not l.startswith("#")]
        # Drop any blank lines
        lines = [l for l in raw if l.strip()]
        if not lines:
            raise RuntimeError(
                "gmx dssp output was empty — the selection may have matched no "
                "protein residues, or the structure lacks recognisable residues."
            )
        n_res = max(len(l) for l in lines)
        n_frames = len(lines)
        # rows = residues, cols = frames
        z = [[SS_CODES.get(lines[f][r] if r < len(lines[f]) else "~", (8, "loop"))[0]
              for f in range(n_frames)]
             for r in range(n_res)]
        return {
            "kind": "heatmap",
            "z": z,
            "x": list(range(n_frames)),
            "y": list(range(1, n_res + 1)),
            "xlabel": "Frame",
            "ylabel": "Residue",
            "zlabel": "SS type",
            "title": "Secondary structure (DSSP)",
            "categorical": True,
            "categories": CATEGORIES,
        }

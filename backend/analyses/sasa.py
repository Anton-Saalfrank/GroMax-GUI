"""
SASA — solvent accessible surface area (gmx sasa).

TWO SELECTIONS, AND WHY IT MATTERS

`gmx sasa -surface X` computes the surface of X *as if nothing else existed*.
That is correct when X is the whole solute, and badly wrong when X is a subset:
asking for residues 200-275 with `-surface` alone measures the area that peptide
would have floating free in water, not its exposure inside the folded protein.
The rest of the protein is not there to bury it.

Measured on a compact 305-atom globule (Shrake-Rupley, same principle as the
LCPO/Connolly surfaces here):

    subset                      in context    isolated     ratio
    whole molecule                  54.299      54.299      1.0x
    outer shell (exposed)           34.812      64.823      1.9x
    buried core                      0.765      20.749     27.1x
    a contiguous 20-residue run      2.058      11.500      5.6x

So the surface is always computed for the CONTEXT group — the whole molecule
that does the occluding — and the area of interest is reported with `-output`,
which asks for the contribution of a subset of that surface. Leave the second
selection blank and you get the whole surface group, which is the old behaviour
and the right answer for "SASA of the protein".

This is the same principle sasa_nonpolar.py already relied on for splitting
polar from apolar atoms; it just was not applied to residue subsets.

WHAT SASA WILL NOT SHOW YOU: A CAVITY OPENING

Every rolling-probe method — Shrake-Rupley, the double cubic lattice gmx uses,
LCPO — decides accessibility LOCALLY: a surface point counts if no neighbouring
atom covers it. A point on the wall of a sealed interior cavity is covered by
nothing, so it counts as accessible even though no water outside could ever
reach it. Measured on a hollow shell of carbons:

    hollow shell, big empty cavity inside      2770 A^2
    same shell with the cavity packed solid    2166 A^2
    geometric outer surface alone              ~2157 A^2
    geometric cavity surface alone              ~598 A^2

So the cavity's 598 A^2 is already in the total. SASA therefore responds when a
cavity FORMS, not when it opens to bulk — by then the area has been counted for
some time. And on a real protein the change is swamped: a few hundred A^2 of
cavity wall against ~20,000 A^2 of protein surface, which fluctuates by more
than that between frames.

To see a cavity in SASA at all, report the area for the LINING RESIDUES only
(second selection) so the denominator is small enough for the change to show.
To measure the cavity itself, use the MDAnalysis engine's "Cavity volume".

OUTPUT COLUMNS
With `-output`, the .xvg carries:
    column 1  time
    column 2  total area of the -surface selection
    column 3  first -output group   <- what we report
Without it there is only the total, and column 2 is what we report.

OPERATIONAL NOTES (this tool has been prone to hanging)
  - The modern selection engine via -surface resolves non-interactively.
  - The output filename is unique and cleared first, so GROMACS never hits an
    existing file and never prints a "Back Off!" prompt.
  - 10 minute timeout, so a genuine stall surfaces as an error.
"""
from .base import BaseAnalysis


class SASAAnalysis(BaseAnalysis):
    type_id = "sasa"
    name = "SASA"
    description = ("Solvent accessible surface area vs time. Report a subset's "
                   "area within the intact molecule by naming the subset "
                   "second.")
    gmx_tool = "sasa"
    n_groups = 2
    group_prompts = [
        "Surface — the molecule that occludes (usually Protein)",
        "Report area for (blank = the whole surface group)",
    ]
    default_groups = ["Protein", ""]

    selection_mode = "surface"
    unique_output = True
    timeout = 600
    x_is_time = True
    default_ylabel = "SASA (nm²)"
    plot_title = "SASA vs time"

    @staticmethod
    def _subset(ctx: dict) -> str:
        groups = ctx.get("groups") or []
        return str(groups[1]).strip() if len(groups) > 1 else ""

    def build_args(self, ctx: dict) -> list[str]:
        groups = ctx.get("groups") or ["Protein"]
        surface = groups[0]
        args = ["-s", ctx["tpr"], "-f", ctx["xtc"],
                "-o", str(ctx["_out_xvg"]),
                "-surface", f'group "{surface}"']
        subset = self._subset(ctx)
        if subset:
            # The surface stays the whole context; this only asks which part of
            # it to report. Without this the subset would be measured alone.
            args += ["-output", f'group "{subset}"']
        if ctx.get("ndx"):
            args += ["-n", ctx["ndx"]]
        args += self.frame_args(ctx)
        return args

    def parse(self, output_xvg, ctx: dict) -> dict:
        from core.gmx import parse_xvg

        d = parse_xvg(output_xvg)
        series = d.get("y_series") or []
        if not series:
            raise RuntimeError("gmx sasa produced no data columns.")

        subset = self._subset(ctx)
        if subset:
            if len(series) < 2:
                raise RuntimeError(
                    f"gmx sasa reported no separate column for '{subset}'. "
                    f"Expected the total area plus one -output group, got "
                    f"{len(series)}. That selection may have matched no atoms, "
                    f"or no atoms that are part of the surface group.")
            y = series[1]
        else:
            y = series[0]

        groups = ctx.get("groups") or ["Protein"]
        label = (f"SASA of {subset} within {groups[0]}" if subset
                 else f"SASA of {groups[0]}")
        return {
            "kind": "line",
            "x": self.ps_to_ns(d["x"]),
            "y": y,
            "xlabel": "Time (ns)",
            "ylabel": self.default_ylabel,
            "title": label,
            # Recorded so a stored result says what context it was measured in,
            # rather than leaving it to be remembered.
            "surface_group": groups[0],
            "reported_group": subset or groups[0],
        }

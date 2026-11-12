"""
Exposed nonpolar (hydrophobic) surface area vs time — gmx sasa -output.

HOW IT WORKS
`gmx sasa` computes the surface for whatever `-surface` selects, and can then
report the area of ARBITRARY SUBSETS of that surface via `-output`. So the
whole molecule's surface is computed once, and the nonpolar part is reported as
a separate column. This is the approach the GROMACS documentation itself
demonstrates, and it is the right one: taking the surface of an apolar-only
selection would be wrong, because removing the polar atoms exposes buried area
that is not solvent accessible in the intact protein.

THE SAME APPLIES TO RESIDUE SUBSETS. "Nonpolar SASA of residues 200-275" must
keep the whole protein as the surface and put the residue restriction in
-output alongside the apolar condition. Narrowing -surface instead reports what
that peptide would expose in isolation — a 5x to 27x overestimate depending on
how buried it is (see analyses/sasa.py).

OUTPUT COLUMNS
With `-output`, the .xvg contains:
    column 1  time
    column 2  total area of the -surface selection
    column 3  first -output group   <- what we want
So this analysis reads the SECOND y series, not the first.

DEFINING "NONPOLAR"
Two conventions, both in common use, offered as a parameter:

  charge  — atoms with a small partial charge (|q| <= threshold). This is the
            GROMACS documentation's own example. It follows the force field,
            so it adapts to the actual parameterisation, but the threshold is
            arbitrary and force-field dependent.

  element — carbon and sulfur atoms. The classic Eisenberg/Lesk definition,
            independent of force field and easy to state in a methods section.

Neither is "the" answer, so the choice is explicit and recorded in the plot
title rather than buried.
"""
from .base import BaseAnalysis


class NonpolarSASAAnalysis(BaseAnalysis):
    type_id = "sasa_nonpolar"
    name = "Nonpolar SASA"
    description = ("Exposed hydrophobic surface area vs time — the apolar part "
                   "of the solvent accessible surface.")
    gmx_tool = "sasa"
    n_groups = 2
    group_prompts = [
        "Surface — the molecule that occludes (usually Protein)",
        "Restrict to (blank = the whole surface group)",
    ]
    default_groups = ["Protein", ""]

    selection_mode = "surface"
    unique_output = True
    timeout = 600
    x_is_time = True
    default_ylabel = "Nonpolar SASA (nm²)"
    plot_title = "Nonpolar SASA vs time"

    params_schema = [
        {
            "key": "definition",
            "label": "Definition of nonpolar",
            "type": "choice",
            "choices": [
                {"value": "charge", "label": "Small partial charge (force field)"},
                {"value": "element", "label": "Carbon + sulfur atoms"},
            ],
            "default": "charge",
            "help": "Charge-based follows your force field's parameterisation; "
                    "element-based (C and S) is force-field independent and "
                    "easier to state in a methods section. Report which you used.",
        },
        {
            "key": "charge_cutoff",
            "label": "Charge cutoff (|q| ≤)",
            "type": "number",
            "default": 0.2,
            "min": 0.0,
            "max": 1.0,
            "step": 0.05,
            "help": "Only used with the charge-based definition. 0.2 is the "
                    "value used in the GROMACS documentation's example.",
        },
    ]

    @staticmethod
    def _restrict(ctx: dict) -> str:
        groups = ctx.get("groups") or []
        return str(groups[1]).strip() if len(groups) > 1 else ""

    def _apolar_selection(self, ctx: dict) -> str:
        """
        The apolar part of the surface, optionally restricted to a subset.

        Both conditions go in the SAME -output selection rather than narrowing
        -surface: the surface must stay the whole occluding molecule, or a
        subset's area is measured as if the rest of the protein were deleted.
        See the note at the top of analyses/sasa.py for how large that error is.
        """
        params = ctx.get("params") or {}
        surface_group = (ctx.get("groups") or ["Protein"])[0]
        definition = params.get("definition", "charge")
        restrict = self._restrict(ctx)
        scope = (f'group "{surface_group}" and group "{restrict}"'
                 if restrict else f'group "{surface_group}"')

        if definition == "element":
            # Carbon and sulfur. Nitrogen/oxygen are the hydrogen-bonding
            # atoms, so excluding them is what makes the rest "apolar".
            return f'"Nonpolar" {scope} and name "C*" "S*"'

        cutoff = params.get("charge_cutoff", 0.2)
        try:
            cutoff = abs(float(cutoff))
        except (TypeError, ValueError):
            cutoff = 0.2
        return f'"Nonpolar" {scope} and charge {{{-cutoff} to {cutoff}}}' 

    def build_args(self, ctx: dict) -> list[str]:
        grp = (ctx.get("groups") or ["Protein"])[0]
        args = ["-s", ctx["tpr"], "-f", ctx["xtc"],
                "-o", str(ctx["_out_xvg"]),
                "-surface", f'group "{grp}"',
                "-output", self._apolar_selection(ctx)]
        if ctx.get("ndx"):
            args += ["-n", ctx["ndx"]]
        args += self.frame_args(ctx)
        return args

    def parse(self, output_xvg, ctx: dict) -> dict:
        from core.gmx import parse_xvg      # same parser the base uses

        d = parse_xvg(output_xvg)
        series = d.get("y_series") or []
        if len(series) < 2:
            raise RuntimeError(
                "gmx sasa did not report a separate nonpolar column. Expected "
                "total area plus one -output group; got "
                f"{len(series)} column(s). The apolar selection may have "
                "matched no atoms — check the definition and the surface group."
            )

        # series[0] is the TOTAL surface; series[1] is our -output group.
        total = series[0]
        nonpolar = series[1]

        params = ctx.get("params") or {}
        definition = params.get("definition", "charge")
        label = ("C+S atoms" if definition == "element"
                 else f"|q| ≤ {params.get('charge_cutoff', 0.2)}")

        result = {
            "kind": "line",
            "x": self.ps_to_ns(d["x"]),
            "y": nonpolar,
            "xlabel": "Time (ns)",
            "ylabel": "Nonpolar SASA (nm²)",
            "title": f"Nonpolar SASA vs time ({label})",
            # Keep the total alongside so the fraction can be derived later
            # without re-running the analysis.
            "y_total_sasa": total,
            "nonpolar_definition": definition,
        }
        return result

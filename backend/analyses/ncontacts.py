"""
Number of contacts vs time between two groups (gmx mindist -on).

`gmx mindist` writes two things from one pass:
  -od   the minimum distance vs time   (the existing 'mindist' analysis)
  -on   the NUMBER OF CONTACTS closer than -d, vs time   (this analysis)

So this is the same tool with a different output, plus a user-facing cutoff.

WHY IT IS A SEPARATE ANALYSIS
The cutoff is meaningless for minimum distance but essential here, and the
y-axis is a count rather than a length — so they don't share a plot, a y-label,
or a cache key. Keeping them separate also means an existing mindist result
isn't invalidated when someone changes the cutoff.

CUTOFF CONVENTION
GROMACS works in nm, so -d is in nm. The UI collects nm too (0.6 nm = 6 A is
the usual default for a heavy-atom contact). We do NOT silently convert from
Angstrom: a factor-of-10 error here would be invisible in the plot shape and
would only show up as an implausible count.

WHAT -group ACTUALLY COUNTS, WHICH IS NOT WHAT ITS NAME SUGGESTS
gmx mindist -group is documented as "Count contacts with multiple atoms in the
first group as one". That is NOT a residue-pair count: it counts, for each ATOM
of the SECOND group, whether that atom is within the cutoff of the first group
at all. The ceiling is therefore the size of the second group, in atoms.

Measured on a real system (gmx 2024.2, 1062-atom group A vs 184-atom group B,
frame 0), against ground truth computed independently with MDAnalysis:

    cutoff   plain -on   -group (A,B)   -group (B,A)   true residue pairs
    0.4 nm        164             35             --                    8
    0.6 nm        794             73             72                   18

  plain -on    = every atom pair closer than the cutoff   (= 164 / 794)
  -group (A,B) = unique atoms of B in contact with A      (=  35 /  73)
  -group (B,A) = unique atoms of A in contact with B      (=  --/   72)

So -group answers "how much of the second group is touching", and neither mode
answers "how many residue pairs are in contact". Residue pairs need the
MDAnalysis engine's "Contact count" analysis, which counts them directly.

HYDROGENS
Both modes count whatever atoms are in the index groups, hydrogens included —
a protein selection is roughly half hydrogen, so an all-atom count runs several
times higher than the heavy-atom contact count a structure viewer reports.
Exclude them in the selection itself: 'ri 205-267 & ! a H*' (verified against
gmx 2024.2; it builds the group r_205-267_&_!H*).
"""
from .base import BaseAnalysis


class NContactsAnalysis(BaseAnalysis):
    type_id = "ncontacts"
    name = "Contacts over time"
    description = ("Number of atom pairs closer than a cutoff, vs time, "
                   "between two groups.")
    gmx_tool = "mindist"
    n_groups = 2
    group_prompts = ["First group", "Second group"]
    default_groups = ["Protein", "Protein"]

    out_flag = "-on"                 # number of contacts, not -od
    x_is_time = True
    default_ylabel = "Contacts"
    plot_title = "Number of contacts vs time"

    # Parameters the UI should expose for this analysis. `cutoff` is in nm.
    params_schema = [
        {
            "key": "cutoff",
            "label": "Contact cutoff (nm)",
            "type": "number",
            "default": 0.6,
            "min": 0.1,
            "max": 5.0,
            "step": 0.05,
            "help": "Atom pairs closer than this count as a contact. "
                    "0.6 nm (6 Å) is a common heavy-atom cutoff. Hydrogens "
                    "count too unless the selection excludes them — append "
                    "'& ! a H*' to compare with a structure viewer.",
        },
        {
            "key": "group_contacts",
            "label": "Count each atom of the second group only once",
            "type": "boolean",
            "default": False,
            "help": "gmx mindist -group. Off: every atom pair within the "
                    "cutoff is one contact. On: each ATOM of the second group "
                    "that touches the first group counts once no matter how "
                    "many atoms it touches, so the number can never exceed the "
                    "size of the second group. Neither mode counts residue "
                    "pairs — for those, use the MDAnalysis engine's "
                    "'Contact count' analysis.",
        },
    ]

    def build_args(self, ctx: dict) -> list[str]:
        args = ["-s", ctx["tpr"], "-f", ctx["xtc"],
                self.out_flag, str(ctx["_out_xvg"])]

        params = ctx.get("params") or {}
        cutoff = params.get("cutoff", 0.6)
        try:
            cutoff = float(cutoff)
        except (TypeError, ValueError):
            cutoff = 0.6
        # Guard against a nonsensical cutoff producing a silently empty or
        # saturated trace.
        if not (0.0 < cutoff <= 10.0):
            raise RuntimeError(
                f"Contact cutoff {cutoff} nm is out of range. Expected nm "
                f"(e.g. 0.6 for 6 Å), not Angstrom.")
        args += ["-d", str(cutoff)]

        if params.get("group_contacts"):
            args += ["-group"]

        if ctx.get("ndx"):
            args += ["-n", ctx["ndx"]]
        args += self.frame_args(ctx)
        return args

    def parse(self, output_xvg, ctx: dict) -> dict:
        result = super().parse(output_xvg, ctx)
        params = ctx.get("params") or {}
        cutoff = params.get("cutoff", 0.6)
        # Put the cutoff in the title — a contact count is meaningless without
        # it, and plots get exported away from the UI that set it.
        # Name the counting mode in the title AND the y-label. gmx writes
        # "Number" as the y-axis label for both modes, which tells a reader
        # nothing — and an exported plot has to stand on its own.
        grouped = bool(params.get("group_contacts"))
        mode = "atoms of 2nd group" if grouped else "atom pairs"
        result["title"] = f"Contacts within {cutoff} nm vs time ({mode})"
        result["ylabel"] = ("Atoms of 2nd group in contact" if grouped
                            else "Atom pairs in contact")
        result["count_mode"] = "group" if grouped else "atom_pairs"
        result["cutoff_nm"] = cutoff
        return result

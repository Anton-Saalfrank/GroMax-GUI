"""
Newly exposed SASA — surface that did not exist at the start of the run.

THE PROBLEM WITH TOTAL SASA
A cavity opening inside a protein might expose 2-5 nm^2. The whole surface is
150-250 nm^2 and breathes by several nm^2 from thermal motion alone, so the new
surface sits inside the noise of the old. Watching the total means watching the
residues that were already exposed and stay exposed — which is most of them.

WHAT THIS DOES INSTEAD
  1. Runs gmx sasa over a REFERENCE WINDOW at the start and takes the average
     area of every residue there (-or).
  2. Calls a residue buried if its RELATIVE accessibility in that window is at
     or below the threshold — its area divided by the area that residue type
     has fully exposed (Tien et al. 2013). Relative, because an exposed glycine
     has less surface than a half-buried tryptophan.
  3. Runs gmx sasa again over the whole window, with the surface still the
     WHOLE protein and -output restricted to those initially-buried residues.

So the reported area can only rise if something that was buried stops being
buried. A flat line means nothing opened.

THREE gmx CALLS, AND WHY
  trjconv -dump   residue names, which -or does not report and RSA needs
  sasa (reference) per-residue areas over the opening window
  sasa (run)      the time series, plus per-residue averages for the breakdown
The alternative — one pass, classifying from frame 0 — is worse: a single frame
catches side chains wherever they happened to be and flips a few percent of
residues between categories for no physical reason.
"""
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.gmx import run_gmx

from .base import BaseAnalysis


class NewSASAAnalysis(BaseAnalysis):
    type_id = "sasa_new"
    name = "Newly exposed SASA"
    description = ("Surface area of residues that started BURIED — the signal a "
                   "total SASA hides. Shows when a cavity opens and which "
                   "residues it exposes.")
    gmx_tool = "sasa"
    n_groups = 2
    group_prompts = [
        "Surface — the molecule that occludes (usually Protein)",
        "Restrict to (blank = every buried residue)",
    ]
    default_groups = ["Protein", ""]

    unique_output = True
    timeout = 900
    x_is_time = True
    default_ylabel = "Newly exposed SASA (nm²)"
    plot_title = "Newly exposed surface"

    params_schema = [
        {
            "key": "ref_ns",
            "label": "Reference window (ns from the start)",
            "type": "number",
            "default": 10.0,
            "min": 0.0,
            "help": "Residues are classified buried or exposed from their "
                    "average area over this opening stretch, not from one "
                    "frame.",
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
                    "exposed (Tien et al. 2013). 0.20 is the conventional cut.",
        },
        {
            "key": "min_gain",
            "label": "Count as emerged if it gains ≥ (nm²)",
            "type": "number",
            "default": 0.10,
            "min": 0.0,
            "step": 0.05,
            "help": "Side chains breathe; without a floor every residue "
                    "appears in the list with a gain of a few hundredths.",
        },
    ]

    async def run(self, ctx, work_dir, line_callback=None):
        from core.burial import classify_buried, exposure_gain

        # Overriding run() means the base class never gets to set this, which
        # surfaced as a bare KeyError '_out_xvg' with nothing to act on.
        out_xvg = self.prepare_output(ctx, work_dir)
        groups = ctx.get("groups") or ["Protein"]
        group = groups[0]
        region = str(groups[1]).strip() if len(groups) > 1 else ""
        params = ctx.get("params") or {}
        ref_ns = float(params.get("ref_ns", 10.0))
        rsa_cut = float(params.get("rsa_threshold", 0.20))
        min_gain = float(params.get("min_gain", 0.10))

        ref_pdb = work_dir / "group.pdb"
        ref_xvg = work_dir / "ref_resarea.xvg"
        run_xvg = work_dir / "run_resarea.xvg"
        for stale in (ref_pdb, ref_xvg, run_xvg):
            if stale.exists():
                stale.unlink()

        def ndx(args):
            return args + (["-n", ctx["ndx"]] if ctx.get("ndx") else [])

        # ── 1. Residue identities. -or gives numbers, RSA needs types. ──────
        # Dumped for the REGION when one is given, which answers two questions
        # in one call: the residue types, and exactly which residue numbers the
        # region covers. The surface stays whole regardless — the region only
        # decides what gets reported.
        identity_group = region or group
        if line_callback:
            line_callback(f"Reading residue types in '{identity_group}'…")
        r = await run_gmx(ndx(["trjconv", "-s", ctx["tpr"], "-f", ctx["xtc"],
                               "-o", str(ref_pdb), "-dump", "0"]),
                          stdin_input=f"{identity_group}\n", cwd=work_dir,
                          line_callback=line_callback, timeout=self.timeout)
        names = _read_residue_names(ref_pdb)
        if not names:
            raise RuntimeError(
                f"Could not read residue types for '{identity_group}'.\n"
                f"Command: {r['cmd']}\nstderr tail: {r['stderr'][-500:]}")

        # ── 2. The reference window ─────────────────────────────────────────
        t_start = float(ctx.get("time_start") or 0.0)
        args = ["sasa", "-s", ctx["tpr"], "-f", ctx["xtc"],
                "-surface", f'group "{group}"',
                "-o", str(work_dir / "ref_total.xvg"),
                "-or", str(ref_xvg),
                "-b", str(t_start * 1000.0)]
        if ref_ns > 0:
            args += ["-e", str((t_start + ref_ns) * 1000.0)]
        if line_callback:
            line_callback(f"Classifying residues over the first {ref_ns:g} ns…")
        r = await run_gmx(ndx(args), cwd=work_dir, line_callback=line_callback,
                          timeout=self.timeout)
        ref_area = _read_resarea(ref_xvg)
        if not ref_area:
            raise RuntimeError(
                f"gmx sasa produced no per-residue areas for the reference "
                f"window (exit {r['returncode']}).\nCommand: {r['cmd']}\n"
                f"stderr tail: {r['stderr'][-600:]}")

        # ref_area covers every residue of the surface, measured with the whole
        # thing present. Restricting to the region narrows the REPORT only — the
        # occlusion that decided those areas is untouched, which is the entire
        # difference between this and putting the region in the surface box.
        wanted = sorted(rn for rn in ref_area if not region or rn in names)
        if region and not wanted:
            raise RuntimeError(
                f"'{region}' shares no residue with the surface group "
                f"'{group}'. The region has to lie inside the surface — it is "
                f"the part of it you want reported.")
        if region and line_callback:
            line_callback(f"Restricting the report to {len(wanted)} residues in "
                          f"'{region}'; burial is still judged against all of "
                          f"'{group}'.")
        residues = [{"resnum": rn, "resname": names.get(rn, "")} for rn in wanted]
        buried, exposed, skipped = classify_buried(
            residues, [ref_area[x["resnum"]] for x in residues], rsa_cut)
        if not buried:
            raise RuntimeError(
                f"Nothing is buried to begin with, so nothing can newly emerge.\n"
                f"No residue in '{region or group}' has relative accessibility at or below "
                f"{rsa_cut:.0%} over the first {ref_ns:g} ns "
                f"({len(residues)} residues examined, {len(exposed)} exposed"
                + (f", {len(skipped)} with no tabulated maximum" if skipped else "")
                + ").\n\nIf that selection is a residue range rather than the "
                  "whole protein, put it in the SECOND box instead and leave "
                  "the surface as the protein — that keeps burial judged "
                  "against the whole structure while reporting only your "
                  "residues. Otherwise, try raising the threshold.")
        if line_callback:
            line_callback(f"{len(buried)} residues buried, {len(exposed)} exposed"
                          + (f", {len(skipped)} untabulated" if skipped else ""))

        # ── 3. The run, reporting only the initially-buried residues ────────
        sel = " ".join(str(b["resnum"]) for b in buried)
        args = ["sasa", "-s", ctx["tpr"], "-f", ctx["xtc"],
                "-surface", f'group "{group}"',
                "-output", f'"Buried at t0" group "{group}" and resnr {sel}',
                "-o", str(out_xvg),
                "-or", str(run_xvg)]
        args += self.frame_args(ctx)
        if line_callback:
            line_callback(f"Measuring those {len(buried)} residues over the run…")
        r = await run_gmx(ndx(args), cwd=work_dir, line_callback=line_callback,
                          timeout=self.timeout)
        if not r["success"] or not out_xvg.is_file():
            raise RuntimeError(
                f"{self.name} failed (exit {r['returncode']}).\n"
                f"Command: {r['cmd']}\nstderr tail: {r['stderr'][-800:]}")

        from core.gmx import parse_xvg
        d = parse_xvg(out_xvg)
        series = d.get("y_series") or []
        if len(series) < 2:
            raise RuntimeError(
                f"gmx sasa reported no separate column for the buried set; got "
                f"{len(series)}. The residue selection may have matched nothing.")

        baseline = sum(b["ref_area"] for b in buried)
        y = [v - baseline for v in series[1]]

        run_area = _read_resarea(run_xvg)
        gains = exposure_gain(buried, run_area, min_gain) if run_area else []
        emerged = [g for g in gains if g["emerged"]]

        return {
            "kind": "line",
            "x": self.ps_to_ns(d["x"]),
            "y": y,
            "xlabel": "Time (ns)",
            "ylabel": self.default_ylabel,
            "title": (f"Newly exposed surface ({len(buried)} residues buried at t0"
                      + (f" in {region}" if region else "") + ")"),
            "newly_exposed": [
                {k: g[k] for k in ("resnum", "resname", "ref_area", "ref_rsa",
                                   "final_area", "final_rsa", "gain")}
                for g in emerged[:60]
            ],
            "n_buried": len(buried),
            "n_exposed": len(exposed),
            "n_emerged": len(emerged),
            "n_untabulated": len(skipped),
            "rsa_threshold": rsa_cut,
            "region": region,
            "ref_ns": ref_ns,
            "baseline_nm2": baseline,
        }


def _read_residue_names(path: Path) -> dict:
    """{residue number: residue name} from a PDB, in file order."""
    out: dict = {}
    if not path.is_file():
        return out
    carry, prev = 0, None
    for line in path.read_text().splitlines():
        if not line.startswith(("ATOM", "HETATM")):
            continue
        try:
            raw = int(line[22:26])
        except ValueError:
            continue
        # PDB resSeq is four columns wide and wraps past 9999; an index group is
        # sorted by residue, so a decrease is a wrap and nothing else.
        if prev is not None and raw < prev:
            carry += 10000
        prev = raw
        out.setdefault(raw + carry, line[17:20].strip().upper())
    return out


def _read_resarea(path: Path) -> dict:
    """
    {residue number: average area in nm^2} from `gmx sasa -or`.

    Read column-wise and tolerantly rather than assuming a fixed width: -or has
    carried a standard-deviation column in some builds and not others, and the
    first two columns are the residue number and its area in every version.
    A row that does not start with a number is skipped rather than guessed at.
    """
    out: dict = {}
    if not path.is_file():
        return out
    for line in path.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith(("#", "@", "&")):
            continue
        parts = s.split()
        if len(parts) < 2:
            continue
        try:
            resnum = int(float(parts[0]))
            area = float(parts[1])
        except ValueError:
            continue
        out[resnum] = area
    return out

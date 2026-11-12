"""
Base class for all analyses.
Each analysis knows how to build its gmx command, what stdin to pipe for
group selection, and how to parse its .xvg output into plot-ready data.

Time handling convention (IMPORTANT):
  - The UI always passes time_start / time_end in NANOSECONDS.
  - We always send -b / -e to gmx in PICOSECONDS (ns * 1000), and never use
    `-tu ns`, because `-tu` reinterprets -b/-e on some gmx builds and causes
    a 1000x error. Output x-axes that come out in ps are converted to ns in
    parse() where needed.
"""

import time
from pathlib import Path
from typing import Optional, Callable

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.gmx import run_gmx, parse_xvg


class BaseAnalysis:
    type_id: str = ""
    name: str = ""
    description: str = ""
    gmx_tool: str = ""
    n_groups: int = 1
    group_prompts: list[str] = ["Group"]
    default_groups: list[str] = ["Backbone", "C-alpha", "Protein"]
    # Whether this analysis' x-axis is time (so we convert ps->ns in parse)
    x_is_time: bool = False

    # ── Declarative result shape ──────────────────────────────────────────────
    # These replace five near-identical build_args()/parse() implementations.
    # A subclass usually only needs to set these attributes; override the
    # methods only where the tool is genuinely different.
    out_flag: str = "-o"              # gmx flag for the .xvg output
    extra_args: list[str] = []        # tool-specific flags, e.g. ["-res"]
    default_xlabel: str = "Residue"   # used when x is NOT time
    default_ylabel: str = "value"
    plot_title: str = ""

    # How the group selection is delivered to gmx:
    #   "stdin"   — pipe group names/indices (classic tools: rms, rmsf, gyrate…)
    #   "surface" — modern selection engine via -surface (gmx sasa)
    selection_mode: str = "stdin"

    # Give the output file a unique name so GROMACS never finds an existing
    # file and never emits a "Back Off! I just backed up …" prompt, which can
    # stall a non-interactive run. Previously only SASA did this.
    unique_output: bool = False

    # Per-analysis wall-clock ceiling (seconds). Most tools stream the whole
    # trajectory, so this scales with trajectory size, not complexity.
    timeout: int = 7200

    def describe(self) -> dict:
        return {
            "type": self.type_id,
            "name": self.name,
            "description": self.description,
            "n_groups": self.n_groups,
            "group_prompts": self.group_prompts,
            "default_groups": self.default_groups,
            # Extra per-analysis parameters (e.g. a distance cutoff) so the UI
            # can render controls without hardcoding which analysis needs what.
            "params_schema": getattr(self, "params_schema", []),
        }

    def build_args(self, ctx: dict) -> list[str]:
        """
        Standard gmx invocation: -s tpr -f xtc <out_flag> out.xvg [-n ndx]
        plus tool-specific extras and the frame/time window.

        Tools whose command line genuinely differs (rmsd2d, dssp) override this.
        """
        args = ["-s", ctx["tpr"], "-f", ctx["xtc"],
                self.out_flag, str(ctx["_out_xvg"])]
        args += list(self.extra_args)
        if self.selection_mode == "surface":
            grp = (ctx.get("groups") or ["Protein"])[0]
            args += ["-surface", f'group "{grp}"']
        if ctx.get("ndx"):
            args += ["-n", ctx["ndx"]]
        args += self.frame_args(ctx)
        return args

    def build_stdin(self, ctx: dict) -> str:
        groups = ctx.get("groups", [])
        if self.selection_mode == "surface":
            # Not needed by modern builds, but harmless as a fallback in case
            # this build prompts for an output group.
            return f"{groups[0]}\n" if groups else ""
        return "\n".join(str(g) for g in groups) + "\n" if groups else ""

    def parse(self, output_xvg: Path, ctx: dict) -> dict:
        """
        Turn a single-series .xvg into the standard line-plot payload.

        This was duplicated verbatim across rmsd/gyrate/hbond/mindist/rmsf,
        differing only in axis labels — so a change to the result contract had
        to be made in five places.
        """
        d = parse_xvg(output_xvg)
        return {
            "kind": "line",
            "x": self.ps_to_ns(d["x"]) if self.x_is_time else d["x"],
            "y": d["y_series"][0] if d["y_series"] else [],
            "xlabel": "Time (ns)" if self.x_is_time
                      else (d["xlabel"] or self.default_xlabel),
            "ylabel": d["ylabel"] or self.default_ylabel,
            "title": self.plot_title or self.name,
        }

    def prepare_output(self, ctx: dict, work_dir: Path) -> Path:
        """
        Decide the output .xvg path and put it in ctx as `_out_xvg`.

        Separate from run() because an analysis that needs several gmx calls
        has to override run() wholesale, and would then never reach the line
        that sets `_out_xvg` — leaving build_args to raise a bare KeyError with
        no indication of what was missing. Any override calls this first.
        """
        work_dir.mkdir(parents=True, exist_ok=True)
        # Descriptive filename (<type>_<name>_<i>.xvg) when provided, so files
        # are self-describing on disk and readable by the HTML plotting tool.
        stem = ctx.get("_out_name") or self.type_id
        if self.unique_output and not ctx.get("_out_name"):
            stem = f"{self.type_id}_{str(int(time.time() * 1000))[-8:]}"
        out_xvg = work_dir / f"{stem}.xvg"
        # A pre-existing output makes GROMACS print a "Back Off! I just backed
        # up …" notice and, on some builds, pause — so clear it first.
        if out_xvg.exists():
            out_xvg.unlink()
        ctx["_out_xvg"] = out_xvg
        return out_xvg

    async def run(self, ctx: dict, work_dir: Path,
                  line_callback: Optional[Callable[[str], None]] = None) -> dict:
        # Keep the return value: the checks and the parse below both need the
        # path. Dropping it left `out_xvg` undefined here — which Python only
        # reports when the line actually runs, so it broke every GROMACS
        # analysis at run time while every static check stayed green.
        out_xvg = self.prepare_output(ctx, work_dir)

        args = [self.gmx_tool] + self.build_args(ctx)
        stdin = self.build_stdin(ctx)

        if line_callback:
            line_callback(f"Running: gmx {' '.join(args)}")

        result = await run_gmx(args, stdin_input=stdin, cwd=work_dir,
                               line_callback=line_callback,
                               timeout=self.timeout)

        if not result["success"]:
            raise RuntimeError(
                f"{self.name} failed (exit {result['returncode']}).\n"
                f"Command: {result['cmd']}\n"
                f"stderr tail: {result['stderr'][-800:]}"
            )
        if not out_xvg.exists():
            raise RuntimeError(
                f"{self.name} finished but produced no output file.\n"
                f"Command: {result['cmd']}\n"
                f"stderr tail: {result['stderr'][-800:]}"
            )

        data = self.parse(out_xvg, ctx)
        data["_cmd"] = result["cmd"]
        return data

    # ─── Frame selection helpers ──────────────────────────────────────────────
    @staticmethod
    def frame_args(ctx: dict) -> list[str]:
        """
        Build -b / -e / -dt flags. UI gives ns; gmx -b/-e/-dt expect ps.
        We deliberately do NOT use -tu here (see module docstring).

        STRIDE: `gmx -dt` filters on TIME, not on frame count — it writes a
        frame only when t is a multiple of dt. So a stride of N means
        `-dt (N * dt_ps)`, which requires knowing the trajectory's own
        timestep. The runner puts that in ctx["dt_ps"] (from `gmx check`,
        cached on file identity). If it's unavailable we skip -dt rather than
        guess, because guessing wrong silently drops or keeps every frame.
        """
        args = []
        if ctx.get("time_start") is not None:
            args += ["-b", str(float(ctx["time_start"]) * 1000.0)]
        if ctx.get("time_end") is not None:
            args += ["-e", str(float(ctx["time_end"]) * 1000.0)]

        stride = int(ctx.get("stride") or 1)
        dt_ps = ctx.get("dt_ps")
        if stride > 1 and dt_ps:
            args += ["-dt", str(float(dt_ps) * stride)]
        return args

    # Backwards-compatible alias. Older analysis modules called time_args();
    # keeping it means a third-party/custom analysis doesn't silently lose
    # its time window after this refactor.
    @classmethod
    def time_args(cls, ctx: dict) -> list[str]:
        return cls.frame_args(ctx)

    @staticmethod
    def ps_to_ns(x: list[float]) -> list[float]:
        return [v / 1000.0 for v in x]

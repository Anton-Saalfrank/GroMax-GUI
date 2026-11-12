"""
cpptraj engine (AmberTools).

Unlike the other three, cpptraj is not a Python library — it is a separate
binary driven by an input script. So this module does three things the others
do not have to: write a script, run the binary, and parse its output files.

TOPOLOGY
cpptraj cannot read a .tpr either, so it gets the same trjconv-dumped topology
MDTraj uses (engines/topology.py). That keeps its `:206` masks pointing at the
same residue GROMACS' `ri 206` does.

MASKS
cpptraj's Amber mask syntax is a different shape from the others: `:` selects
residues, `@` selects atoms, and combining them is juxtaposition rather than a
keyword — `:206,370@CA`. It also has no `protein` keyword at all, so "Protein"
is translated to a not-solvent mask; that is an approximation, and it is called
out in the engine notes rather than hidden.

UNITS
cpptraj reports distances in ANGSTROM. Converted to nm on the way out, like
every other engine, so results overlay GROMACS directly.
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from core.selections import common_groups

from .base import (Engine, EngineAnalysis, MAX_MATRIX_SIDE,
                   heatmap_result, line_result)
from .topology import ensure_topology

A_TO_NM = 0.1


def cpptraj_executable() -> str:
    """The cpptraj binary, or a clear error naming what to install."""
    for candidate in ("cpptraj", "cpptraj.OMP", "cpptraj.MPI"):
        found = shutil.which(candidate)
        if found:
            return found
    raise RuntimeError(
        "cpptraj was not found on PATH. It ships with AmberTools "
        "(conda install -c conda-forge ambertools).")


async def run_cpptraj(script: str, work_dir: Path, line_callback=None,
                      timeout: int = 7200) -> dict:
    """
    Run a cpptraj input script.

    cpptraj reports most failures on stdout and STILL EXITS 0 — a bad mask
    prints "Error: ... selects no atoms" and carries on to write an empty
    output file. So the caller must check the output, and this scans the log
    for 'Error:' rather than trusting the return code.
    """
    exe = cpptraj_executable()
    script_path = work_dir / "cpptraj.in"
    script_path.write_text(script)

    proc = await asyncio.create_subprocess_exec(
        exe, "-i", str(script_path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        cwd=str(work_dir),
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"cpptraj timed out after {timeout}s.")
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise

    log = out.decode(errors="replace")
    if line_callback:
        for line in log.splitlines():
            line_callback(line)

    errors = [l for l in log.splitlines() if l.strip().startswith("Error:")]
    return {"returncode": proc.returncode, "log": log, "errors": errors,
            "cmd": f"{exe} -i {script_path.name}"}


def parse_cpptraj_dat(path: Path) -> tuple[list[float], list[float]]:
    """
    Read a cpptraj data file: '#Frame  Value' with whitespace columns.

    Takes the first two numeric columns. Comment lines start with '#'.
    """
    x: list[float] = []
    y: list[float] = []
    for line in path.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        parts = s.split()
        if len(parts) < 2:
            continue
        try:
            x.append(float(parts[0]))
            y.append(float(parts[1]))
        except ValueError:
            continue
    return x, y


def parse_cpptraj_matrix(path: Path) -> list[list[float]]:
    """
    Read a cpptraj square matrix.

    cpptraj writes a matrix as whitespace-separated rows, sometimes wrapped
    across lines, sometimes with a header comment. Rather than assume a layout,
    take every number in the file and check the count is a perfect square —
    which also catches a truncated or half-written file instead of silently
    reshaping it into nonsense.
    """
    values: list[float] = []
    for line in path.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        for tok in s.split():
            try:
                values.append(float(tok))
            except ValueError:
                pass

    if not values:
        raise RuntimeError("cpptraj wrote an empty matrix.")
    n = int(round(len(values) ** 0.5))
    if n * n != len(values):
        raise RuntimeError(
            f"cpptraj's matrix has {len(values)} values, which is not a square. "
            f"The file may be truncated.")
    return [values[i * n:(i + 1) * n] for i in range(n)]


class _CpptrajAnalysis(EngineAnalysis):
    """Shared plumbing: topology, frame window, script, run, parse."""

    # cpptraj's own command name, and what it writes.
    out_name = "out.dat"

    def frame_clause(self, ctx: dict) -> str:
        """
        The `trajin` frame range.

        cpptraj counts FRAMES, not time — it has no -b/-e in ps. The runner
        supplies the trajectory's timestep, so a window given in ns can be
        converted; without it we run the whole trajectory rather than guess,
        which is the same rule the GROMACS stride handling follows.
        """
        dt_ps = ctx.get("dt_ps")
        stride = max(1, int(ctx.get("stride") or 1))
        start, end = ctx.get("time_start"), ctx.get("time_end")

        if (start is None and end is None) or not dt_ps:
            return f" 1 last {stride}" if stride > 1 else ""

        first = 1 if start is None else max(1, int(round(float(start) * 1000.0 / dt_ps)) + 1)
        last = "last" if end is None else max(first, int(round(float(end) * 1000.0 / dt_ps)) + 1)
        return f" {first} {last} {stride}"

    def build_script(self, ctx: dict, top: Path, out: Path) -> str:
        raise NotImplementedError

    def to_series(self, x: list[float], y: list[float], ctx: dict) -> dict:
        raise NotImplementedError

    async def run(self, ctx, work_dir, line_callback=None):
        work_dir.mkdir(parents=True, exist_ok=True)
        top = await ensure_topology(ctx["tpr"], ctx["xtc"],
                                    Path(ctx["_topology_dir"]), line_callback)
        out = work_dir / self.out_name
        if out.exists():
            out.unlink()

        script = self.build_script(ctx, top, out)
        if line_callback:
            line_callback(f"cpptraj script:\n{script}")

        result = await run_cpptraj(script, work_dir, line_callback, self.timeout)

        if result["errors"]:
            raise RuntimeError(
                f"{self.name} failed in cpptraj:\n" + "\n".join(result["errors"][:5]))
        if not out.is_file():
            raise RuntimeError(
                f"{self.name} produced no output. cpptraj exits 0 even when a "
                f"mask selects nothing — check the masks.\n"
                + "\n".join(result["log"].splitlines()[-10:]))

        x, y = parse_cpptraj_dat(out)
        if not x:
            raise RuntimeError(
                f"{self.name} produced an empty result. The most common cause "
                f"is a mask that matched no atoms.")
        data = self.to_series(x, y, ctx)
        data["_cmd"] = result["cmd"]
        return data

    def _frame_to_ns(self, frames: list[float], ctx: dict) -> tuple[list[float], str]:
        """
        cpptraj's x-axis is a frame number. Convert to ns when the timestep is
        known, and say 'Frame' honestly when it is not — a time axis with the
        wrong scale is worse than a frame axis.
        """
        dt_ps = ctx.get("dt_ps")
        if not dt_ps:
            return frames, "Frame"
        stride = max(1, int(ctx.get("stride") or 1))
        offset = float(ctx.get("time_start") or 0.0)
        return ([offset + (f - 1) * dt_ps * stride / 1000.0 for f in frames],
                "Time (ns)")


class CppRmsd(_CpptrajAnalysis):
    type_id = "rmsd"
    name = "RMSD"
    description = "Root-mean-square deviation from the first frame, after superposition."
    n_groups = 2
    group_prompts = ["Mask for least-squares fit", "Mask for RMSD"]
    default_groups = ["@CA", "@CA"]

    def build_script(self, ctx, top, out):
        g = ctx["groups"] or ["@CA", "@CA"]
        fit = g[0]
        meas = g[1] if len(g) > 1 and g[1].strip() else fit
        head = (f'parm "{top}"\n'
                f'trajin "{ctx["xtc"]}"{self.frame_clause(ctx)}\n')
        if meas == fit:
            return head + f'rms first {fit} out "{out}"\n' + 'run\n'
        # cpptraj's `rms` fits and measures on one mask, so a separate fit is
        # two commands: superpose on the fit mask, then measure the other with
        # `nofit` on the already-superposed coordinates.
        return (head
                + f'rms Fit first {fit}\n'
                + f'rms Meas first {meas} nofit out "{out}"\n'
                + 'run\n')

    def to_series(self, x, y, ctx):
        t, xlabel = self._frame_to_ns(x, ctx)
        return line_result(t, [v * A_TO_NM for v in y], xlabel, "RMSD (nm)",
                           "RMSD vs first frame")


class CppRmsf(_CpptrajAnalysis):
    type_id = "rmsf"
    name = "RMSF"
    description = "Per-residue root-mean-square fluctuation (atomicfluct byres)."
    group_prompts = ["Mask"]
    default_groups = ["@CA"]

    def build_script(self, ctx, top, out):
        mask = (ctx["groups"] or ["@CA"])[0]
        # rms first before atomicfluct: fluctuation about an unaligned average
        # measures the box drifting, not the protein.
        return (f'parm "{top}"\n'
                f'trajin "{ctx["xtc"]}"{self.frame_clause(ctx)}\n'
                f'rms first {mask}\n'
                f'atomicfluct out "{out}" {mask} byres\n'
                f'run\n')

    def to_series(self, x, y, ctx):
        return line_result(x, [v * A_TO_NM for v in y], "Residue", "RMSF (nm)",
                           "RMSF per residue")


class CppGyrate(_CpptrajAnalysis):
    type_id = "gyrate"
    name = "Radius of gyration"
    description = "Radius of gyration vs time (radgyr)."
    group_prompts = ["Mask"]
    default_groups = ["!:WAT,HOH,SOL,NA,CL"]

    def build_script(self, ctx, top, out):
        mask = (ctx["groups"] or ["*"])[0]
        return (f'parm "{top}"\n'
                f'trajin "{ctx["xtc"]}"{self.frame_clause(ctx)}\n'
                f'radgyr {mask} out "{out}"\n'
                f'run\n')

    def to_series(self, x, y, ctx):
        t, xlabel = self._frame_to_ns(x, ctx)
        return line_result(t, [v * A_TO_NM for v in y], xlabel, "Rg (nm)",
                           "Radius of gyration")


class CppSasa(_CpptrajAnalysis):
    type_id = "sasa"
    name = "Solvent accessible surface area"
    description = ("Molecular surface area vs time (LCPO). The mask is both the "
                   "surface and what is reported, so use GROMACS or MDTraj for "
                   "a residue subset's area inside the protein.")
    group_prompts = ["Mask (this is both the surface AND what is reported)"]
    default_groups = ["!:WAT,HOH,SOL,NA,CL"]

    def build_script(self, ctx, top, out):
        """
        NOTE — one mask only, and it does two jobs.

        `surf` computes the LCPO area of the masked atoms from those atoms
        alone, so the mask is simultaneously the occluding surface and the
        thing being reported. That is right for a whole solute and wrong for a
        subset: residues 200-275 masked on their own are measured as a free
        peptide, not as part of the folded protein, which overestimates by
        roughly 5x for a surface loop and far more for anything buried (see
        analyses/sasa.py for the measurements).

        Left as-is rather than guessed at because there is no cpptraj here to
        verify a two-mask formulation against. The GROMACS and MDTraj engines
        both take a separate surface and subset selection and should be used
        for that question.
        """
        mask = (ctx["groups"] or ["*"])[0]
        return (f'parm "{top}"\n'
                f'trajin "{ctx["xtc"]}"{self.frame_clause(ctx)}\n'
                f'surf {mask} out "{out}"\n'
                f'run\n')

    def to_series(self, x, y, ctx):
        t, xlabel = self._frame_to_ns(x, ctx)
        # cpptraj surf is A^2; this app plots nm^2, so 1 A^2 = 0.01 nm^2.
        return line_result(t, [v * A_TO_NM * A_TO_NM for v in y], xlabel,
                           "SASA (nm²)", "Solvent accessible surface area")


class CppDistance(_CpptrajAnalysis):
    type_id = "mindist"
    name = "Minimum distance"
    description = "Closest approach between two masks vs time."
    n_groups = 2
    group_prompts = ["First mask", "Second mask"]
    default_groups = ["@CA", "@CA"]

    def build_script(self, ctx, top, out):
        g = ctx["groups"]
        # `noimage` is deliberately NOT set: a periodic system needs minimum
        # image, and cpptraj images by default when the box is present.
        return (f'parm "{top}"\n'
                f'trajin "{ctx["xtc"]}"{self.frame_clause(ctx)}\n'
                f'nativecontacts {g[0]} {g[1]} mindist out "{out}"\n'
                f'run\n')

    def to_series(self, x, y, ctx):
        t, xlabel = self._frame_to_ns(x, ctx)
        return line_result(t, [v * A_TO_NM for v in y], xlabel,
                           "Min. distance (nm)", "Minimum distance")


class CppHBond(_CpptrajAnalysis):
    type_id = "hbond"
    name = "Hydrogen bonds"
    description = "Hydrogen-bond count vs time (cpptraj hbond)."
    n_groups = 2
    group_prompts = ["Donor mask", "Acceptor mask"]
    default_groups = ["!:WAT,HOH,SOL,NA,CL", "!:WAT,HOH,SOL,NA,CL"]
    params_schema = [
        {"key": "dist", "label": "Donor–acceptor cutoff (Å)", "type": "number",
         "default": 3.0},
        {"key": "angle", "label": "Minimum D–H···A angle (°)", "type": "number",
         "default": 135.0},
    ]

    def build_script(self, ctx, top, out):
        g = ctx["groups"] or ["*", "*"]
        donor = g[0]
        acceptor = g[1] if len(g) > 1 and g[1].strip() else donor
        p = ctx.get("params") or {}
        return (f'parm "{top}"\n'
                f'trajin "{ctx["xtc"]}"{self.frame_clause(ctx)}\n'
                f'hbond donormask {donor} acceptormask {acceptor} '
                f'dist {float(p.get("dist", 3.0))} '
                f'angle {float(p.get("angle", 135.0))} '
                f'series out "{out}"\n'
                f'run\n')

    def to_series(self, x, y, ctx):
        t, xlabel = self._frame_to_ns(x, ctx)
        return line_result(t, y, xlabel, "Hydrogen bonds",
                           "Hydrogen bonds vs time")


class CppDccm(_CpptrajAnalysis):
    type_id = "dccm"
    name = "Cross-correlation (DCCM)"
    description = ("Correlated motion between residue pairs. +1 moves together, "
                   "-1 moves oppositely — the standard way to spot allosteric "
                   "coupling and rigid domains.")
    n_groups = 2
    group_prompts = ["Mask for least-squares fit", "Mask for the matrix"]
    default_groups = ["@CA", "@CA"]
    out_name = "dccm.dat"

    def build_script(self, ctx, top, out):
        g = ctx["groups"] or ["@CA", "@CA"]
        fit = g[0]
        meas = g[1] if len(g) > 1 and g[1].strip() else fit
        # `rms first` before `matrix correl` is not optional: without removing
        # global rotation and translation the matrix measures the molecule
        # tumbling in its box and comes out almost uniformly positive.
        return (f'parm "{top}"\n'
                f'trajin "{ctx["xtc"]}"{self.frame_clause(ctx)}\n'
                f'rms first {fit}\n'
                f'matrix correl {meas} out "{out}"\n'
                f'run\n')

    async def run(self, ctx, work_dir, line_callback=None):
        # cpptraj computes this natively, so this overrides the series-shaped
        # run() rather than reusing it.
        work_dir.mkdir(parents=True, exist_ok=True)
        top = await ensure_topology(ctx["tpr"], ctx["xtc"],
                                    Path(ctx["_topology_dir"]), line_callback)
        out = work_dir / self.out_name
        if out.exists():
            out.unlink()

        script = self.build_script(ctx, top, out)
        if line_callback:
            line_callback(f"cpptraj script:\n{script}")
        result = await run_cpptraj(script, work_dir, line_callback, self.timeout)

        if result["errors"]:
            raise RuntimeError(
                f"{self.name} failed in cpptraj:\n" + "\n".join(result["errors"][:5]))
        if not out.is_file():
            raise RuntimeError(
                f"{self.name} produced no output. cpptraj exits 0 even when a "
                f"mask selects nothing — check the masks.\n"
                + "\n".join(result["log"].splitlines()[-10:]))

        z = parse_cpptraj_matrix(out)
        if len(z) > MAX_MATRIX_SIDE:
            raise RuntimeError(
                f"The mask gives a {len(z)}x{len(z)} matrix — too large to "
                f"plot. Narrow it, for example to '@CA' or one chain.")
        # cpptraj's correl matrix is already normalised to [-1, 1]; round to
        # match the other engines and keep the payload small.
        z = [[round(float(v), 3) for v in row] for row in z]
        data = heatmap_result(
            z, list(range(1, len(z) + 1)), "Residue", "Residue", "Correlation",
            "Dynamic cross-correlation", result["cmd"], diverging=True)
        return data


class CpptrajEngine(Engine):
    id = "cpptraj"
    name = "cpptraj"
    description = ("The AmberTools analysis engine. A separate binary driven by "
                   "an input script, using Amber mask syntax.")
    homepage = "https://amberhub.chpc.utah.edu/atom-mask-selection-syntax/"
    dialect = "cpptraj"
    selection_help = (
        "Amber mask syntax: ':' for residues, '@' for atoms, combined by "
        "juxtaposition. ':206,370@CA' is residues 206 and 370, C-alpha only. "
        "'!' negates, so '!:WAT' is everything except water."
    )
    install_hint = (
        "conda install -c conda-forge ambertools\n"
        "cpptraj must be on the PATH of the shell that launches the backend."
    )
    notes = [
        "Amber masks have no 'protein' keyword, so Protein is translated to a "
        "not-solvent mask (!:WAT,HOH,SOL,…). Check it covers your system — an "
        "unusual ion or lipid residue name will not be excluded automatically.",
        "Cannot read .tpr files, so a topology is dumped from the .tpr with gmx "
        "trjconv on first use and cached. GROMACS is still needed for that.",
        "cpptraj exits 0 even when a mask matches nothing, so its log is "
        "scanned for errors rather than trusting the exit code.",
    ]

    ANALYSES = {
        "rmsd": CppRmsd,
        "rmsf": CppRmsf,
        "gyrate": CppGyrate,
        "sasa": CppSasa,
        "mindist": CppDistance,
        "hbond": CppHBond,
        "dccm": CppDccm,
    }

    @classmethod
    def probe(cls) -> dict:
        try:
            exe = cpptraj_executable()
        except Exception as e:
            return {"available": False, "version": None, "reason": str(e)}
        # Version without running a trajectory: cpptraj --version is cheap.
        try:
            import subprocess
            r = subprocess.run([exe, "--version"], capture_output=True,
                               text=True, timeout=10)
            version = (r.stdout + r.stderr).strip().splitlines()[0] if (r.stdout or r.stderr) else "unknown"
        except Exception:
            version = "unknown"
        return {"available": True, "version": version, "reason": None}

    @classmethod
    def chips(cls) -> list[dict]:
        return common_groups(cls.dialect)

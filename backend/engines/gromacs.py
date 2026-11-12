"""
GROMACS engine — the original, wrapped in the engine contract.

Deliberately thin. The ten analyses in backend/analyses/ already did everything
an engine needs to do; this only re-presents them so the picker has something
uniform to talk to. No behaviour changes, so a result produced before engines
existed is identical to one produced now.
"""

from __future__ import annotations

from analyses import REGISTRY as GMX_REGISTRY
from core.selections import common_groups

from .base import Engine


class GromacsEngine(Engine):
    id = "gromacs"
    name = "GROMACS"
    description = ("The tools that came with your simulation. Index-group "
                   "selections, and the only engine here that can build a "
                   "custom .ndx from a residue pick.")
    homepage = "https://manual.gromacs.org/current/onlinehelp/"
    dialect = "gromacs"
    selection_help = (
        "Index group names (Protein, C-alpha, Backbone) or a make_ndx "
        "expression such as 'ri 200-270' or 'ri 206 370 & a CA'. Custom "
        "selections are built into an index group automatically. "
        "A group name used INSIDE an expression needs double quotes — "
        "'\"Protein\" & ri 205-267' works, 'protein & ri 205-267' is a syntax "
        "error. To leave hydrogens out, append '& ! a H*'. "
        "make_ndx reads strictly left to right with no brackets, so to combine "
        "different atoms of different residues, separate the parts with ';' — "
        "'ri 161 & a CB HB1; ri 162; ri 270 & a O' — and each is built on its "
        "own and then joined."
    )
    install_hint = (
        "Set the path to your gmx executable in the Setup tab. GROMACS is not "
        "a Python package — it is the simulation engine itself."
    )

    # The existing modules are already EngineAnalysis-shaped: same describe(),
    # same run(ctx, work_dir, line_callback), same result dict.
    ANALYSES = dict(GMX_REGISTRY)

    @classmethod
    def probe(cls) -> dict:
        from core.appconfig import get_gmx_executable, probe_gmx
        try:
            exe = get_gmx_executable()
        except Exception as e:
            return {"available": False, "version": None, "reason": str(e)}
        try:
            info = probe_gmx(exe)
        except Exception as e:
            return {"available": False, "version": None,
                    "reason": f"Could not run {exe}: {e}"}
        ok = bool(info.get("found"))
        return {
            "available": ok,
            "version": info.get("version"),
            "reason": None if ok else (info.get("error") or "gmx not found"),
        }

    @classmethod
    def chips(cls) -> list[dict]:
        return common_groups(cls.dialect)

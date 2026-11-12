"""
Analysis engine registry.

The Analyses tab asks this module two things: which engines exist, and which of
them can actually run here. Those are deliberately separate questions — an
engine that is not installed still appears in the picker, greyed out, with the
exact command to install it. Hiding it would leave the user wondering whether
the app supports MDAnalysis at all.

ADDING AN ENGINE
Write a module with an Engine subclass and add it to ENGINES below. Everything
else — the picker, availability reporting, selection translation, caching and
the Results/Compare tabs — picks it up without further changes.
"""

from __future__ import annotations

from .base import Engine, EngineAnalysis
from .cpptraj import CpptrajEngine
from .gromacs import GromacsEngine
from .mdanalysis import MDAnalysisEngine
from .mdtraj import MDTrajEngine

# Order is the order shown in the picker. GROMACS first: it is the one that is
# always present, and the one the rest of the app's selections are native to.
ENGINES: dict[str, type[Engine]] = {
    GromacsEngine.id: GromacsEngine,
    MDAnalysisEngine.id: MDAnalysisEngine,
    MDTrajEngine.id: MDTrajEngine,
    CpptrajEngine.id: CpptrajEngine,
}

DEFAULT_ENGINE = GromacsEngine.id


def get_engine(engine_id: str) -> type[Engine]:
    engine = ENGINES.get(engine_id or DEFAULT_ENGINE)
    if engine is None:
        raise ValueError(
            f"Unknown analysis engine '{engine_id}'. Available: "
            f"{', '.join(ENGINES)}.")
    return engine


def get_engine_analysis(engine_id: str, analysis_type: str) -> EngineAnalysis:
    return get_engine(engine_id).get(analysis_type)


def describe_engines() -> list[dict]:
    """
    Every engine, with its availability and its analyses.

    Each probe is isolated: a broken optional dependency must not take the whole
    list down, or one bad install would make the Analyses tab unusable.
    """
    out = []
    for engine in ENGINES.values():
        try:
            out.append(engine.describe())
        except Exception as e:
            out.append({
                "id": engine.id,
                "name": engine.name,
                "description": engine.description,
                "homepage": getattr(engine, "homepage", ""),
                "dialect": getattr(engine, "dialect", ""),
                "selection_help": getattr(engine, "selection_help", ""),
                "install_hint": getattr(engine, "install_hint", ""),
                "notes": list(getattr(engine, "notes", [])),
                "analyses": [],
                "available": False,
                "version": None,
                "reason": f"This engine could not be loaded: {e}",
            })
    return out

"""
Selection translation between analysis engines.

THE PROBLEM
Every MD analysis package has its own selection language, and they disagree
about almost everything — keywords, residue syntax, even what "backbone" means:

    GROMACS      C-alpha          ri 206 370 & a CA
    MDAnalysis   name CA          resid 206 370 and name CA
    MDTraj       name CA          resSeq 206 370 and name CA
    cpptraj      @CA              :206,370@CA

The Structure tab speaks one of these (GROMACS index selections, because that
is what make_ndx needs). Without translation, picking residues in 3D would only
ever work for one engine, and the whole pick-in-3D-then-analyse workflow would
quietly stop at the engine picker.

THE NUMBERING, WHICH IS THE PART THAT CAN SILENTLY LIE
`ri 206` is GROMACS' FLAT residue index: residues counted 1..N straight through
the topology. A reference PDB's author numbering (chain A, residue 206) is a
different thing entirely, and confusing the two lands every selection on the
wrong residue while looking perfectly healthy.

This module only ever emits flat indices, and every engine here is fed a
topology that uses them — MDAnalysis reads the .tpr directly, and MDTraj and
cpptraj are handed a topology dumped FROM the .tpr (see engines/topology.py).
So `ri 206`, `resid 206`, `resSeq 206` and `:206` all name the same residue.

WHAT IS NOT TRANSLATED
Anything this module does not recognise is passed through untouched, with a
warning. Guessing at a selection nobody can read is how you get a confident,
wrong answer — refusing to guess is the whole point of the warning.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

# Dialects this module can emit. Kept as plain strings rather than an enum so
# an engine module can name its dialect without importing from here.
DIALECTS = ("gromacs", "mdanalysis", "mdtraj", "cpptraj")

# Residue names treated as non-protein when an engine has no `protein` keyword
# of its own (cpptraj). Deliberately generous: a stray ion left inside a
# "protein" selection skews a radius of gyration far more than a missing one.
_SOLVENT_RESNAMES = [
    "WAT", "HOH", "SOL", "TIP3", "TIP4", "SPC", "T3P", "T4P",
    "NA", "CL", "K", "MG", "CA", "ZN", "SOD", "CLA", "POT", "CAL", "ION",
]


@dataclass
class ParsedSelection:
    """
    A selection in engine-neutral terms.

    kind:
      'name'     — a standard group ('Protein', 'C-alpha', …)
      'residues' — explicit flat residue indices, optionally restricted to
                   named atoms; this is what the Structure tab produces
      'raw'      — something we could not parse, carried through verbatim
    """
    kind: str
    name: str = ""
    residues: list[int] = field(default_factory=list)
    ranges: list[tuple[int, int]] = field(default_factory=list)
    atoms: list[str] = field(default_factory=list)
    raw: str = ""

    def is_empty(self) -> bool:
        return not (self.name or self.residues or self.ranges or self.raw)


# ─── Standard groups ──────────────────────────────────────────────────────────
#
# One row per group, one column per dialect. The values are not guesses; the
# fiddly ones are called out below, because "backbone" in particular does NOT
# mean the same thing in GROMACS as it does in MDAnalysis or MDTraj:
#
#   GROMACS  Backbone  = N, CA, C          (three atoms)
#   GROMACS  MainChain = N, CA, C, O
#   MDAnalysis/MDTraj  backbone = N, CA, C, O   (four — GROMACS' MainChain)
#
# So GROMACS "Backbone" is spelled out atom by atom elsewhere rather than
# mapped onto the other packages' `backbone` keyword, which would silently add
# the carbonyl oxygen and change every RMSD it touches.
_NOT_SOLVENT_MASK = "!:" + ",".join(_SOLVENT_RESNAMES)

STANDARD_GROUPS: dict[str, dict[str, str]] = {
    "System":     {"gromacs": "System",     "mdanalysis": "all",
                   "mdtraj": "all",         "cpptraj": "*"},
    "Protein":    {"gromacs": "Protein",    "mdanalysis": "protein",
                   "mdtraj": "protein",     "cpptraj": _NOT_SOLVENT_MASK},
    "Backbone":   {"gromacs": "Backbone",   "mdanalysis": "name N CA C",
                   "mdtraj": "name N CA C", "cpptraj": "@N,CA,C"},
    "MainChain":  {"gromacs": "MainChain",  "mdanalysis": "backbone",
                   "mdtraj": "backbone",    "cpptraj": "@N,CA,C,O"},
    "C-alpha":    {"gromacs": "C-alpha",    "mdanalysis": "name CA",
                   "mdtraj": "name CA",     "cpptraj": "@CA"},
    "SideChain":  {"gromacs": "SideChain",  "mdanalysis": "protein and not backbone",
                   "mdtraj": "sidechain",   "cpptraj": "!@N,CA,C,O,H,HA"},
    "Protein-H":  {"gromacs": "Protein-H",  "mdanalysis": "protein and not name H*",
                   "mdtraj": "protein and element != H", "cpptraj": _NOT_SOLVENT_MASK + "&!@H="},
    "Water":      {"gromacs": "Water",      "mdanalysis": "resname SOL HOH TIP3 WAT",
                   "mdtraj": "water",       "cpptraj": ":WAT,HOH,SOL"},
}

# Case-insensitive lookup, so a user typing "protein" still gets the mapping.
_GROUP_BY_LOWER = {k.lower(): k for k in STANDARD_GROUPS}

# The chips the Analyses tab offers for each dialect.
#
# Returned as (label, value): the chip reads "Protein" in every engine, but
# inserts that engine's own spelling. Showing the raw value on the chip would
# put cpptraj's 140-character not-solvent mask on a button, and hiding the
# value entirely would mean the thing you clicked is not the thing that runs.
def common_groups(dialect: str) -> list[dict]:
    order = ["System", "Protein", "Backbone", "C-alpha", "MainChain", "SideChain"]
    return [{"label": g, "value": STANDARD_GROUPS[g][dialect]} for g in order]


# ─── Parsing ──────────────────────────────────────────────────────────────────

_RI_RE = re.compile(r"\bri\s+([0-9\s\-]+)", re.I)
_ATOM_RE = re.compile(r"&\s*a\s+([A-Za-z0-9_,\s*]+)", re.I)


def parse_selection(sele: str) -> ParsedSelection:
    """
    Read a GROMACS-flavoured selection into engine-neutral terms.

    Handles the forms this app actually produces and the ones people type:
      Protein                     -> name
      C-alpha                     -> name
      ri 206 370                  -> residues
      ri 200-270                  -> range
      ri 206 370 & a CA           -> residues + atom restriction
    Anything else comes back as 'raw' and is passed through unchanged.
    """
    s = (sele or "").strip()
    if not s:
        return ParsedSelection(kind="raw", raw="")

    canonical = _GROUP_BY_LOWER.get(s.lower())
    if canonical:
        return ParsedSelection(kind="name", name=canonical)

    m = _RI_RE.search(s)
    if m:
        residues: list[int] = []
        ranges: list[tuple[int, int]] = []
        for token in m.group(1).split():
            if "-" in token:
                lo, _, hi = token.partition("-")
                try:
                    ranges.append((int(lo), int(hi)))
                except ValueError:
                    return ParsedSelection(kind="raw", raw=s)
            else:
                try:
                    residues.append(int(token))
                except ValueError:
                    return ParsedSelection(kind="raw", raw=s)

        atoms: list[str] = []
        am = _ATOM_RE.search(s)
        if am:
            atoms = [a for a in re.split(r"[,\s]+", am.group(1).strip()) if a]

        # A leading group index ("3 & ri 200-270") restricts to an index group
        # we cannot see from here, so the residue list alone would be WIDER
        # than what was asked for. Refuse rather than quietly broaden it.
        head = s[: m.start()].strip()
        if head and head not in ("", "&"):
            return ParsedSelection(kind="raw", raw=s)

        if residues or ranges:
            return ParsedSelection(kind="residues", residues=residues,
                                   ranges=ranges, atoms=atoms)

    return ParsedSelection(kind="raw", raw=s)


# ─── Emitting ─────────────────────────────────────────────────────────────────

def _residue_tokens(p: ParsedSelection, dialect: str) -> str:
    """The residue half of a selection, in the dialect's syntax."""
    if dialect == "cpptraj":
        parts = [str(r) for r in p.residues]
        parts += [f"{lo}-{hi}" for lo, hi in p.ranges]
        return ":" + ",".join(parts)

    keyword = {"gromacs": "ri", "mdanalysis": "resid", "mdtraj": "resSeq"}[dialect]
    parts = [str(r) for r in p.residues]
    if dialect == "gromacs":
        parts += [f"{lo}-{hi}" for lo, hi in p.ranges]
    elif dialect == "mdanalysis":
        # MDAnalysis writes an inclusive range as lo:hi.
        parts += [f"{lo}:{hi}" for lo, hi in p.ranges]
    else:
        # MDTraj has no range shorthand, but its DSL does take numeric
        # comparisons — far better than listing 70 residue numbers, and the
        # only sane option for a range that spans thousands.
        bounds = [f"(resSeq >= {lo} and resSeq <= {hi})" for lo, hi in p.ranges]
        if parts and bounds:
            return f"({keyword} " + " ".join(parts) + ") or " + " or ".join(bounds)
        if bounds:
            return " or ".join(bounds)
    return f"{keyword} " + " ".join(parts)


def emit_selection(p: ParsedSelection, dialect: str) -> str:
    """Render an engine-neutral selection in one dialect."""
    if dialect not in DIALECTS:
        raise ValueError(f"Unknown selection dialect: {dialect}")

    if p.kind == "name":
        return STANDARD_GROUPS[p.name][dialect]

    if p.kind == "residues":
        res = _residue_tokens(p, dialect)
        if not p.atoms:
            return res
        if dialect == "gromacs":
            return f"{res} & a {' '.join(p.atoms)}"
        if dialect == "cpptraj":
            return f"{res}@{','.join(p.atoms)}"
        # MDAnalysis and MDTraj share `and name A B C`.
        return f"({res}) and name {' '.join(p.atoms)}"

    return p.raw


def translate(sele: str, to_dialect: str) -> tuple[str, Optional[str]]:
    """
    Translate one selection. Returns (text, warning).

    A warning means the text was carried through unchanged because it could not
    be read — the caller should show it rather than let the user assume the
    string means the same thing in the new engine.
    """
    p = parse_selection(sele)
    if p.kind == "raw" and p.raw.strip():
        if to_dialect == "gromacs":
            return p.raw, None          # it came from here; nothing to say
        return p.raw, (
            f"'{p.raw}' is not a selection this app can translate, so it was "
            f"left as typed. Check it is valid {to_dialect} syntax."
        )
    return emit_selection(p, to_dialect), None


def translate_all(seles: list[str], to_dialect: str) -> tuple[list[str], list[str]]:
    """Translate a list, collecting any warnings."""
    out: list[str] = []
    warnings: list[str] = []
    for s in seles:
        text, warn = translate(s, to_dialect)
        out.append(text)
        if warn:
            warnings.append(warn)
    return out, warnings


def residues_to_selection(residues: list[int], atoms: Optional[list[str]],
                          dialect: str) -> str:
    """
    Build a selection straight from flat residue indices.

    The exact path for a Structure-tab pick: no parsing, no round trip through
    GROMACS syntax, so nothing can be lost on the way.
    """
    p = ParsedSelection(kind="residues", residues=sorted(set(residues)),
                        atoms=list(atoms or []))
    return emit_selection(p, dialect)

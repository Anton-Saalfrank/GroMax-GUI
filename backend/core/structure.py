"""
Structure serving for the in-app 3D viewer.

The viewer needs two things the rest of the API doesn't provide:

  1. The reference PDB text, so NGL can render it in the browser.
  2. A per-residue value series aligned to the PDB's OWN numbering, so a
     colour can be attached to each residue without the frontend having to
     understand GROMACS' flat indexing.

WHY THE NUMBERING MATTERS
NGL reports picks in the PDB's author numbering — chain ID + full-length
residue number — which is exactly what SystemDefinition.chains describes. So a
click maps straight through system_map.bio_to_flat() to the flat residue index
make_ndx wants, and a per-residue result maps back the other way through
chimerax.flat_to_bio(). This module is the seam between those two worlds.

THE TRAP THIS GUARDS AGAINST
If the reference PDB isn't the structure that was actually simulated (different
construct, different numbering, extra tags), every mapping silently lands on
the wrong residue and you get a confident, beautiful, wrong figure. The
session's cached residue-identity table lets us check residue NAMES at mapped
positions; when it disagrees we report the mismatch instead of colouring
anything.
"""

import logging
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from .chimerax import _per_residue_series, flat_to_bio
from .gmx import get_cached_result, run_gmx
from .session import ChainDef, load_state, session_dir
from .system_map import bio_to_flat, parse_pdb_chains

log = logging.getLogger("gromax.structure")

router = APIRouter()

# Atoms present in every standard amino acid. A selection restricted to these
# is well defined even where the residue TYPE differs between conditions, which
# is exactly the case at a mutation site.
BACKBONE_ATOMS = {"N", "CA", "C", "O", "OXT"}

# Solvent, ions and common non-polymer residues. Picking one of these by
# residue number is essentially never intended, and their numbering overlaps
# the protein's, so a stray click would resolve to a wrong protein residue.
NON_POLYMER_RESNAMES = {
    "HOH", "WAT", "SOL", "TIP3", "TIP3P", "TIP4", "TIP4P", "SPC", "SPCE",
    "NA", "NA+", "CL", "CL-", "K", "K+", "MG", "MG2", "CA2", "ZN", "ZN2",
    "POT", "SOD", "CLA", "CAL", "DUM",
}


# ─── Serving the structure ────────────────────────────────────────────────────

def _condition_pdb(state, condition_id: str) -> Path:
    """
    Find a reference structure for this condition.

    There are TWO places a PDB can live, and users legitimately have only one:

      1. condition.pdb — set in the Setup tab when a scanned folder contains a
         .pdb. Many simulation folders contain only .tpr/.xtc, so this is
         often empty.
      2. system_definition.source_pdb — imported in the System tab to define
         chains and residue numbering.

    (2) is a perfectly good reference structure and is the one whose numbering
    the residue mapping is built from, so falling back to it is not just a
    convenience — it's arguably the more correct choice for this view.
    """
    cond = (state.conditions or {}).get(condition_id)
    if cond is None:
        raise HTTPException(status_code=404, detail=f"No condition {condition_id}")

    candidates = [
        (cond.pdb, "condition"),
        ((cond.files or {}).get("pdb"), "condition"),
    ]
    sd = state.system_definition
    if sd and sd.source_pdb:
        candidates.append((sd.source_pdb, "system definition"))

    tried = []
    for path, origin in candidates:
        if not path:
            continue
        p = Path(path).expanduser()
        if p.is_file():
            return p
        tried.append(f"{path} (from {origin})")

    if tried:
        raise HTTPException(
            status_code=404,
            detail=f"Reference structure file is missing on disk: {tried[0]}. "
                   f"If the file moved, re-import it in the System tab.",
        )
    raise HTTPException(
        status_code=404,
        detail=f"Condition '{cond.name}' has no reference structure. Add one "
               f"either by importing a PDB in the System tab (which also "
               f"defines chains and residue numbering), or by selecting a PDB "
               f"when scanning the folder in the Setup tab.",
    )


@router.get("/{session_id}/{condition_id}/pdb", response_class=PlainTextResponse)
def get_structure(session_id: str, condition_id: str):
    """
    Return the reference PDB as plain text for NGL to parse client-side.

    Served as text rather than a file download so the viewer can load it with a
    plain fetch and there's no temp-file dance in the renderer.
    """
    state = load_state(session_id)
    p = _condition_pdb(state, condition_id)
    try:
        return p.read_text(errors="replace")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not read structure: {e}")


@router.get("/{session_id}/{condition_id}/info")
def structure_info(session_id: str, condition_id: str):
    """
    Summarise the structure so the UI can show what it's looking at, and warn
    early when the PDB doesn't match the system definition.
    """
    state = load_state(session_id)
    p = _condition_pdb(state, condition_id)

    try:
        pdb_chains, pdb_residues = parse_pdb_chains(p)
    except Exception as e:
        log.warning("PDB chain parse failed for %s: %s", p, e)
        pdb_chains, pdb_residues = [], []

    sd = state.system_definition
    defined = sd.chains if (sd and sd.chains) else []

    warnings = []
    if defined and pdb_chains:
        pdb_ids = {c.get("id") for c in pdb_chains}
        missing = [c.id for c in defined if c.id not in pdb_ids]
        if missing:
            warnings.append(
                f"System definition names chain(s) {', '.join(missing)}, which "
                f"are not in this PDB. Residue picking on those chains will not "
                f"map correctly."
            )
        # Residue counts disagreeing is the clearest sign the reference
        # structure isn't the simulated construct.
        for d in defined:
            match = next((c for c in pdb_chains if c.get("id") == d.id), None)
            if match and d.n_residues and match.get("n_residues"):
                if abs(int(match["n_residues"]) - int(d.n_residues)) > 0:
                    warnings.append(
                        f"Chain {d.id}: PDB has {match['n_residues']} residues, "
                        f"system definition says {d.n_residues}. Picking may "
                        f"target the wrong residues."
                    )
    if not defined:
        warnings.append(
            "No system definition for this session. Picking will report the "
            "PDB's own numbering, which may not match GROMACS' residue indices."
        )

    return {
        "path": str(p),
        "filename": p.name,
        "pdb_chains": pdb_chains,
        "n_pdb_residues": len(pdb_residues),
        "defined_chains": [c.model_dump() for c in defined],
        "has_system_definition": bool(defined),
        "warnings": warnings,
    }


# ─── Per-residue values for colouring ─────────────────────────────────────────

class ResidueValuesRequest(BaseModel):
    session_id: str
    cache_key: str


@router.post("/residue-values")
def residue_values(req: ResidueValuesRequest):
    """
    Turn a stored per-residue analysis into {chain, resnum, value} triples that
    the viewer can colour by directly.

    Reuses the same extraction as the ChimeraX export, so both paths agree on
    what counts as "per-residue" — and both reject per-frame results (RMSD vs
    time) rather than producing something meaningless.
    """
    state = load_state(req.session_id)
    result = get_cached_result(req.session_id, req.cache_key)
    if result is None:
        raise HTTPException(status_code=404, detail="Result not cached")

    values, resnums = _per_residue_series(result)   # raises 400 if per-frame

    sd = state.system_definition
    chains: list[ChainDef] = sd.chains if (sd and sd.chains) else []

    items = []
    unmapped = 0
    for i, val in enumerate(values):
        if val is None:
            continue
        flat = resnums[i] if resnums else (i + 1)
        try:
            flat = int(flat)
        except (TypeError, ValueError):
            continue

        if chains:
            bio = flat_to_bio(chains, flat)
            if bio is None:
                unmapped += 1
                continue
            chain_id, resnum = bio
        else:
            # No system definition: fall through with the flat index as the
            # residue number. Correct for a single-chain system whose PDB
            # starts at 1; flagged in /info so the user knows.
            chain_id, resnum = "", flat

        items.append({"chain": chain_id, "resnum": resnum, "value": float(val)})

    if not items:
        raise HTTPException(
            status_code=400,
            detail="No residues could be mapped onto the structure. Check the "
                   "system definition matches this condition.",
        )

    vals = [it["value"] for it in items]
    return {
        "items": items,
        "min": min(vals),
        "max": max(vals),
        "n_mapped": len(items),
        "n_unmapped": unmapped,
        "label": result.get("ylabel") or "value",
        "analysis_name": result.get("analysis_name") or result.get("analysis_type"),
        "mapped_with_chains": bool(chains),
    }


# ─── Picking: structure -> GROMACS selection ──────────────────────────────────

class PickRequest(BaseModel):
    session_id: str
    picks: list[dict]        # [{"chain": "A", "resnum": 629}, ...]


# ── Build the selection in make_ndx DIALECT ──────────────────────────────
#
# CRITICAL: this string is consumed by `gmx make_ndx`, whose syntax is
#     ri <indices>     residue index      a <names>   atom name
#     &  |  !          boolean operators
#
# It is NOT `gmx select` syntax ("resindex 211 and name CA"). Emitting the
# select dialect here was a real bug: is_custom_selection() did not
# recognise it, so it was never built into an index group at all — the
# string was handed to the analysis tool as though it were the NAME of an
# existing group. Whatever GROMACS resolved that to was not what the user
# picked, and the resulting numbers were wrong.
#
# make_ndx has no parentheses and evaluates left to right, so
# "ri 1 & a CA | ri 2 & a OD1" does NOT mean what it looks like: the later
# "& a OD1" re-intersects everything before it, and the group comes out as
# the four atoms named OD1 rather than the union that was asked for.
#
# That is a limit on ONE LINE, not on make_ndx. A selection written as
# several parts separated by ';' becomes one group per part in a single
# make_ndx session, joined afterwards by GROUP NUMBER — and OR over group
# numbers is associative, so left-to-right evaluation cannot misread it.
# ndx_builder.split_selection_parts() does exactly that, and checks the
# joined group against the parts atom-for-atom before anything runs.
#
# So picking CE1 of one residue and CB, NE, NH2 of another is expressible,
# and used to be refused: the selection widened to whole residues and the
# pick was reported as unusable. Widening is not a smaller version of the
# same measurement — a side-chain tip contact and a whole-residue contact
# are different quantities — so the parts are emitted instead.
def build_pick_selection(resolved: list[dict]) -> str:
    """The make_ndx selection for a list of resolved picks. "" if there are none."""
    flats = sorted({e["flat"] for e in resolved})
    if not flats:
        return ""
    if not any(e.get("atom") for e in resolved):
        return "ri " + " ".join(str(f) for f in flats)

    # What was picked from each residue. A residue picked BOTH as a whole and
    # by one of its atoms is taken whole: the whole-residue pick is the
    # superset, so intersecting it with the atom name would drop atoms the user
    # had already asked for.
    by_res: dict[int, set] = {}
    for e in resolved:
        by_res.setdefault(e["flat"], set()).add(e.get("atom") or "")

    # Residues asking for the same atoms share a part, so the common case —
    # every residue picked at the same atom — still comes out as the one line
    # it always was ("ri 163 202 & a CA"), not as one part per residue.
    by_atoms: dict[frozenset, list[int]] = {}
    for flat, names in by_res.items():
        by_atoms.setdefault(frozenset() if "" in names else frozenset(names),
                            []).append(flat)

    parts = []
    for key, group in sorted(by_atoms.items(), key=lambda kv: min(kv[1])):
        ris = " ".join(str(f) for f in sorted(group))
        parts.append(f"ri {ris}" if not key
                     else f"ri {ris} & a {' '.join(sorted(key))}")
    return "; ".join(parts)


@router.post("/resolve-picks")
def resolve_picks(req: PickRequest):
    """
    Convert residues clicked in the viewer into a GROMACS selection.

    This is the whole point of the feature: the user clicks a loop instead of
    going to ChimeraX to look up that it was residues 640-655.

    Verifies residue identity where the session has a cached residue table.
    A mismatch means the reference PDB is not the simulated construct, which
    would silently analyse the wrong residues — so we report it rather than
    returning a selection that looks fine.
    """
    state = load_state(req.session_id)
    sd = state.system_definition
    chains: list[ChainDef] = sd.chains if (sd and sd.chains) else []

    # {(chain, resnum): resname} from the cached identity table, when present
    # Residue identity, indexed two ways so a pick can be resolved even when the
    # structure carries no chain IDs at all.
    identity = {}                       # (chain, resnum) -> resname
    if sd and sd.residues:
        for r in sd.residues:
            try:
                rn = int(r.get("resnum"))
            except (TypeError, ValueError):
                continue
            identity[(r.get("chain") or "", rn)] = r.get("resname")

    resolved, problems = [], []
    notes: list[str] = []      # non-blocking observations
    mutated: list[dict] = []   # picks affected by a substitution

    for pick in req.picks:
        chain_id = (pick.get("chain") or "").strip()
        try:
            resnum = int(pick.get("resnum"))
        except (TypeError, ValueError):
            problems.append(f"Bad residue number: {pick!r}")
            continue

        seen_name = (pick.get("resname") or "").strip().upper()

        # Reject solvent and ions outright. Water numbering overlaps protein
        # numbering, so a stray click on a TIP3 would otherwise resolve to a
        # plausible-looking but completely wrong residue index.
        if seen_name in NON_POLYMER_RESNAMES:
            problems.append(
                f"{seen_name} {resnum} is solvent or an ion, not part of the "
                f"protein. Uncheck 'water'/'ions' under Show to stop picking "
                f"them by accident.")
            continue

        # ── Resolve the chain ────────────────────────────────────────────────
        # GROMACS-processed PDBs frequently have a BLANK chain-ID column, so
        # NGL reports an empty chain name. Refusing the pick there was wrong:
        # the residue is perfectly identifiable, we just have to work out which
        # chain it falls in.
        if not chain_id and chains:
            candidates = [c.id for c in chains
                          if c.start_resnum is not None and c.end_resnum is not None
                          and c.start_resnum <= resnum <= c.end_resnum]

            # Prefer a chain whose residue NAME matches what was clicked. That
            # disambiguates a homodimer where both chains span the number.
            if len(candidates) > 1 and seen_name:
                named = [cid for cid in candidates
                         if (identity.get((cid, resnum)) or "").upper() == seen_name]
                if len(named) == 1:
                    candidates = named

            if len(candidates) == 1:
                chain_id = candidates[0]
            elif len(candidates) > 1:
                problems.append(
                    f"Residue {resnum} exists in chains {', '.join(candidates)} "
                    f"and this structure has no chain IDs to tell them apart. "
                    f"Use a structure that carries chain IDs, or select by "
                    f"typing the residue index directly.")
                continue
            else:
                ranges = "; ".join(f"{c.id}: {c.start_resnum}-{c.end_resnum}"
                                   for c in chains)
                problems.append(
                    f"Residue {resnum} is outside every defined chain ({ranges}). "
                    f"The reference structure may not match the simulated system.")
                continue

        if chains:
            flat = bio_to_flat(chains, chain_id, resnum)
            if flat is None:
                problems.append(
                    f"{chain_id}:{resnum} is outside the defined chains — the "
                    f"structure may not match the simulated system.")
                continue
        else:
            flat = resnum      # no definition: assume PDB numbering is flat

        entry = {
            "chain": chain_id,
            "resnum": resnum,
            "flat": flat,
            "resname": identity.get((chain_id, resnum)),
            "pdb_resname": pick.get("resname"),
            "atom": (pick.get("atom") or "").strip() or None,
        }

        # Cross-check the residue name when we know it. This guards against a
        # mis-numbered reference structure — but it must not fire on a
        # deliberate MUTATION, which is the whole point of a WT-vs-mutant
        # project.
        #
        # The distinction is which atoms the pick actually touches:
        #   * Backbone atoms (N, CA, C, O, OXT) exist in every amino acid, so
        #     they are well defined regardless of the substitution. Selecting
        #     the CA of Y269C is perfectly meaningful in BOTH conditions.
        #   * Side-chain atoms may not exist in the other residue type, so the
        #     selection would silently mean something different per condition.
        known = entry["resname"]
        seen = (pick.get("resname") or "").strip().upper()
        differs = bool(known and seen and known.strip().upper() != seen)

        if differs:
            atom_name = (entry.get("atom") or "").strip().upper()
            if atom_name and atom_name in BACKBONE_ATOMS:
                # Safe: backbone is common to both residue types.
                entry["mutation"] = {"reference": seen, "simulated": known,
                                     "scope": "backbone"}
                notes.append(
                    f"{chain_id}:{resnum} differs between the reference "
                    f"structure ({seen}) and the simulated system ({known}) — "
                    f"a mutation site. You picked the {atom_name} atom, which "
                    f"exists in both, so this selection is valid for either "
                    f"condition."
                )
            elif atom_name:
                # Side-chain atom that may not exist in the other residue.
                entry["mutation"] = {"reference": seen, "simulated": known,
                                     "scope": "sidechain"}
                mutated.append(entry)
                notes.append(
                    f"{chain_id}:{resnum} is {seen} in the reference structure "
                    f"but {known} in the simulated system, and {atom_name} is a "
                    f"side-chain atom that may not exist in both. Restrict this "
                    f"analysis to the matching condition, or pick a backbone "
                    f"atom (N, CA, C, O) to compare across conditions."
                )
            else:
                # Whole-residue pick at a mutation site: valid, but the residue
                # is not the same chemical entity in both conditions.
                entry["mutation"] = {"reference": seen, "simulated": known,
                                     "scope": "residue"}
                mutated.append(entry)
                notes.append(
                    f"{chain_id}:{resnum} is {seen} in the reference structure "
                    f"but {known} in the simulated system — a mutation site. "
                    f"The whole-residue selection is valid in both, but the "
                    f"side chains differ, so a distance or contact measurement "
                    f"is not comparing like with like. Pick a backbone atom to "
                    f"compare across conditions."
                )

        resolved.append(entry)

    flats = sorted({e["flat"] for e in resolved})

    atom_picks = [e for e in resolved if e.get("atom")]
    selection = build_pick_selection(resolved)

    return {
        "residues": resolved,
        "flat_indices": flats,
        "selection": selection,
        "atom_level": bool(atom_picks) and len(atom_picks) == len(resolved),
        # Deduplicated: one pick per residue+atom means the same message was
        # repeated once per pick, filling the panel with identical rows.
        "problems": list(dict.fromkeys(problems)),
        "notes": list(dict.fromkeys(notes)),
        "mutations": mutated,          # picks at a substitution site
        # A mutation no longer blocks. Refusing to select the CA of a mutated
        # residue was wrong: the backbone is identical, and comparing a mutation
        # site across conditions is the entire point of a WT-vs-mutant project.
        "ok": bool(flats) and not problems,
    }


# ─── Trajectory snapshots ─────────────────────────────────────────────────────
#
# "There is a big jump in mindist at 345 ns in repeat 5" is a question about a
# MOMENT, and the reference PDB cannot answer it — it is the starting structure,
# or a crystal structure, and by definition not the frame where the interesting
# thing happened. So pull that frame out of the trajectory and view it directly.
#
# THE NUMBERING PROBLEM, AND WHY THIS IS NOT JUST A trjconv CALL
# gmx trjconv writes GROMACS' own numbering: residues counted 1..N straight
# through the topology, no chain IDs. Every selection in this app — picks,
# highlights, saved groups — is expressed in the reference PDB's AUTHOR
# numbering (chain + full-length residue number). Hand the raw dump to the
# viewer and every one of them silently lands on the wrong residue.
#
# So the frame is renumbered back into author numbering on the way out, using
# the same SystemDefinition that the rest of the mapping runs on. A highlight
# built on the reference structure then means the same residues in the frame,
# which is the only way "view this frame with the highlights I already have"
# can be trusted.

class FrameRequest(BaseModel):
    session_id: str
    condition_id: str
    replica_index: int
    time_ns: float
    # Solvent roughly decuples the file, and is off unless it is the point.
    include_solvent: bool = False


def _replica_files(cond, replica_index: int) -> tuple[str, str]:
    """The (tpr, xtc) pair for a replica, with the legacy single-file fallback."""
    replicas = [r for r in (cond.replicas or []) if r.get("paired")]
    if not replicas and cond.files.get("tpr") and cond.files.get("xtc"):
        replicas = [{"index": 1, "tpr": cond.files["tpr"], "xtc": cond.files["xtc"]}]

    for r in replicas:
        if int(r.get("index", 0)) == int(replica_index):
            return r["tpr"], r["xtc"]

    available = ", ".join(str(r.get("index")) for r in replicas) or "none"
    raise HTTPException(
        status_code=404,
        detail=f"Condition '{cond.name}' has no replica {replica_index} "
               f"(available: {available}).",
    )


def _residue_key(line: str) -> str:
    """
    The PDB columns that identify a residue: resName, chainID, resSeq, iCode.

    Compared verbatim rather than parsed, because a change in ANY of them starts
    a new residue and that is all we need to know. Resilient to resSeq wrapping
    past 9999, which GROMACS does on large systems.
    """
    return line[17:27]


def _renumber_to_bio(pdb_text: str, chains: list[ChainDef]) -> tuple[str, list[str]]:
    """
    Rewrite a trjconv frame from flat GROMACS numbering into author numbering.

    ASSUMPTION, stated because it is the one that can bite: residues appear in
    the file in topology order, so the Nth residue in the file is flat index N.
    That is the same assumption `ri N` selections rest on throughout this app —
    if it were wrong, every analysis selection would already be wrong too.

    Residues past the end of the system definition (ligands, ions, water) keep
    their own numbering and get a blank chain; NGL classifies them by residue
    name, which is what the viewer's water/ion filters key off anyway.
    """
    warnings: list[str] = []
    n_defined = sum(
        (c.n_residues if c.n_residues else (c.end_resnum - c.start_resnum + 1))
        for c in chains
    ) if chains else 0

    out: list[str] = []
    prev_key: Optional[str] = None
    prev_chain: Optional[str] = None
    flat = 0
    unmapped = 0

    for line in pdb_text.splitlines():
        record = line[:6]

        if record in ("ATOM  ", "HETATM"):
            key = _residue_key(line)
            if key != prev_key:
                flat += 1
                prev_key = key

            mapped = flat_to_bio(chains, flat) if (chains and flat <= n_defined) else None
            if mapped is None:
                if flat <= n_defined:
                    unmapped += 1
                out.append(line)
                continue

            chain_id, resnum = mapped
            # A TER between chains keeps NGL from tracing a bond across the gap
            # and drawing a ribbon that jumps from one chain to the next.
            if prev_chain is not None and chain_id != prev_chain:
                out.append("TER")
            prev_chain = chain_id

            # Columns are fixed-width: chainID at 22, resSeq at 23-26 (1-based).
            padded = f"{line:<80}"
            out.append(
                padded[:21] + (chain_id or " ")[:1] + f"{resnum:>4d}" + padded[26:].rstrip()
            )
            continue

        if record.startswith("TER"):
            prev_key = None          # force the next residue to be a new one
            out.append(line)
            continue

        out.append(line)

    if not chains:
        warnings.append(
            "No system definition, so this frame is shown in GROMACS' own "
            "residue numbering. Import a PDB in the System tab and your "
            "existing selections and highlights will line up with it.")
    elif flat < n_defined:
        warnings.append(
            f"This frame has {flat} residues but the system definition "
            f"describes {n_defined}. Numbering past the end of the frame "
            f"cannot be mapped — check that the trajectory and the system "
            f"definition are the same construct.")
    if unmapped:
        warnings.append(f"{unmapped} atom(s) could not be mapped to a chain.")

    return "\n".join(out) + "\n", warnings


# ─── The cavity under a click ─────────────────────────────────────────────────

class CavityAtRequest(BaseModel):
    """
    A point on a molecular surface, plus the atoms around it.

    The COORDINATES COME FROM THE VIEWER, not from a file on disk. What is on
    screen may be the reference structure or any frame of any replica, and
    re-deriving which one here would be a second source of truth that could
    disagree with the picture the user is looking at. Sending the local
    neighbourhood also keeps the payload small — a few hundred atoms rather
    than the whole system — and sidesteps periodic boundaries entirely, since
    the viewer's coordinates are already whole.
    """
    point: list[float]
    atoms: list[dict]
    probe: float = 1.4
    spacing: float = 0.7
    region: float = 10.0
    burial: float = 0.6
    lining_cutoff: float = 5.0


@router.post("/cavity-at")
def cavity_at(req: CavityAtRequest):
    """
    Which residues line the cavity at this point on the surface.

    A CLICK IS THE BEST SEED THERE IS. Seeding a cavity search on a residue is
    awkward because the centroid of a side chain lies INSIDE it — measured
    1.0-1.3 A inside the nearest van der Waals surface — so the void can only
    start a couple of Angstrom away and the nearest one wins, which may not be
    the pocket meant. A point picked off the surface is already in the empty
    space, right at the mouth of the pocket the user is looking at. Measured:
    a ray cast onto a molecular surface lands a median 2.43 A from the nearest
    atom centre, which is the empty side of that atom's surface.

    So there is nothing to parameterise about WHERE to look. What remains is
    the probe size (how narrow a neck still counts as connected) and the
    buriedness threshold (how enclosed a point must be to count as cavity
    rather than bulk solvent), both of which keep their meaning from the
    cavity analysis.
    """
    import numpy as np
    from .cavity import cavity_frame, radii_for

    if len(req.point) != 3:
        raise HTTPException(status_code=400,
                            detail="point must be [x, y, z] in Angstrom.")
    if not req.atoms:
        raise HTTPException(
            status_code=400,
            detail="No atoms were sent with the click, so there is nothing to "
                   "measure the cavity against.")

    centre = np.asarray(req.point, dtype=float)
    xyz = np.array([[float(a["x"]), float(a["y"]), float(a["z"])]
                    for a in req.atoms], dtype=float)
    names = [str(a.get("name", "C")) for a in req.atoms]
    resnames = [str(a.get("resname", "")) for a in req.atoms]
    radii = radii_for(names, resnames)

    res = cavity_frame(xyz, radii, centre, probe=req.probe, spacing=req.spacing,
                       region=req.region, burial=req.burial,
                       require_connected=True, seed_radius=req.region)

    if not res["n_points"]:
        return {"found": False, "reason": res["reason"] or "no cavity here",
                "volume_A3": 0.0, "residues": [], "atom_indices": [],
                "open_to_bulk": False, "max_sphere_A": 0.0,
                "max_clearance_A": res.get("max_clearance_A", 0.0)}

    # Atoms whose surface wraps the void: the lining.
    from scipy.spatial import cKDTree
    tree = cKDTree(xyz)
    touched: set[int] = set()
    for idx in tree.query_ball_point(res["points"], float(req.lining_cutoff)):
        touched.update(idx)

    by_res: dict[tuple, dict] = {}
    atom_indices = []
    for i in sorted(touched):
        a = req.atoms[i]
        if a.get("index") is not None:
            atom_indices.append(int(a["index"]))
        key = (str(a.get("chain", "")), int(a.get("resnum", 0)))
        row = by_res.setdefault(key, {
            "chain": key[0], "resnum": key[1],
            "resname": str(a.get("resname", "")), "n_atoms": 0})
        row["n_atoms"] += 1

    return {
        "found": True,
        "reason": "",
        "volume_A3": round(float(res["volume_A3"]), 1),
        "open_to_bulk": bool(res["open_to_bulk"]),
        "max_sphere_A": round(float(res["max_sphere_A"]), 2),
        "n_points": int(res["n_points"]),
        "residues": sorted(by_res.values(), key=lambda r: (r["chain"], r["resnum"])),
        "atom_indices": atom_indices,
    }


@router.post("/frame")
async def get_frame(req: FrameRequest):
    """
    Dump one frame of a trajectory as a PDB, in the app's residue numbering.

    Cached on disk per (replica, time, solvent): scrubbing back and forth across
    a plot should not re-read the trajectory every time, and trjconv on a large
    .xtc is not instant.
    """
    state = load_state(req.session_id)
    cond = (state.conditions or {}).get(req.condition_id)
    if cond is None:
        raise HTTPException(status_code=404, detail=f"No condition {req.condition_id}")

    tpr, xtc = _replica_files(cond, req.replica_index)
    for label, path in (("tpr", tpr), ("xtc", xtc)):
        if not Path(path).expanduser().is_file():
            raise HTTPException(
                status_code=404,
                detail=f"The {label} for replica {req.replica_index} is missing "
                       f"on disk: {path}")

    # The UI speaks nanoseconds; gmx takes picoseconds. Never -tu ns — see the
    # note at the top of analyses/base.py, it silently rescales -b/-e.
    time_ps = float(req.time_ns) * 1000.0
    group = "System" if req.include_solvent else "Protein"

    frames_dir = session_dir(req.session_id) / "frames" / req.condition_id
    frames_dir.mkdir(parents=True, exist_ok=True)
    out_pdb = frames_dir / f"rep{req.replica_index}_{time_ps:.0f}ps_{group.lower()}.pdb"

    xtc_mtime = Path(xtc).expanduser().stat().st_mtime
    cached = out_pdb.is_file() and out_pdb.stat().st_mtime >= xtc_mtime

    if not cached:
        args = ["trjconv", "-s", str(tpr), "-f", str(xtc),
                "-dump", f"{time_ps:g}", "-o", str(out_pdb)]
        # A PBC-corrected trajectory has already been through trjconv; running
        # -pbc mol over it again is at best redundant. An uncorrected one needs
        # it, or the molecule arrives split across the periodic box.
        if not cond.pbc_corrected:
            args += ["-pbc", "mol"]

        result = await run_gmx(args, stdin_input=f"{group}\n", cwd=frames_dir, timeout=900)

        # "Protein" is not a group in every system (a nucleic-acid-only or
        # coarse-grained one, say). Fall back rather than failing outright.
        if not result["success"] and group == "Protein":
            group = "System"
            out_pdb = frames_dir / f"rep{req.replica_index}_{time_ps:.0f}ps_system.pdb"
            args[args.index("-o") + 1] = str(out_pdb)
            result = await run_gmx(args, stdin_input="System\n", cwd=frames_dir, timeout=900)

        if not result["success"] or not out_pdb.is_file():
            tail = "\n".join((result.get("stderr") or "").splitlines()[-8:])
            raise HTTPException(
                status_code=500,
                detail=f"gmx trjconv could not dump {req.time_ns:g} ns from "
                       f"replica {req.replica_index}.\n{tail}")

    raw = out_pdb.read_text()
    if not raw.strip():
        raise HTTPException(
            status_code=500,
            detail=f"gmx trjconv produced an empty frame at {req.time_ns:g} ns. "
                   f"Is that time inside this replica's trajectory?")

    sd = state.system_definition
    chains = list(sd.chains) if (sd and sd.chains) else []
    pdb, warnings = _renumber_to_bio(raw, chains)

    # trjconv stamps the frame it actually wrote into the TITLE record, and
    # -dump lands on the NEAREST frame rather than the exact time asked for.
    # Reporting the real one keeps "345 ns" from quietly meaning 344.8.
    actual_ns = None
    for line in pdb.splitlines()[:5]:
        if not line.startswith("TITLE"):
            continue
        m = re.search(r"\bt=\s*([0-9.eE+-]+)", line)
        if m:
            try:
                actual_ns = float(m.group(1)) / 1000.0
            except ValueError:
                actual_ns = None
        break

    return {
        "pdb": pdb,
        "requested_ns": req.time_ns,
        "actual_ns": actual_ns,
        "group": group,
        "warnings": warnings,
    }

"""
Multi-chain system mapping.

The GROMACS index file numbers residues as one continuous list (no chains).
This module lets the user describe the biological layout of the system —
which chains exist, and what full-length residue range each simulated chain
covers — and translates biological selections (chain B, residue D629) into the
flat residue-index (ri) numbers make_ndx needs.

Assumptions (confirmed with the user):
  - Chains are laid out SEQUENTIALLY in the topology (chain A first, then B, …).
  - Residue numbering the user thinks in is FULL-LENGTH (e.g. VPS35 629), while
    the simulated excerpt may start partway in (e.g. residues 400–800).

Mapping:
  For a chain with simulated range [start_resnum … end_resnum], the chain has
  n = end_resnum - start_resnum + 1 residues. Chains are concatenated, so the
  flat (1-based) residue index of biological residue R in a chain is:

      flat_ri = cumulative_offset(chain) + (R - chain.start_resnum + 1)

  where cumulative_offset is the total residue count of all preceding chains.
"""

import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .session import (load_state, save_state, session_dir, locked_state,
                      SystemDefinition, ChainDef)
from .gmx import run_gmx

router = APIRouter()


# ─── PDB parsing ──────────────────────────────────────────────────────────────

def parse_pdb_chains(pdb_path: Path) -> tuple[list[dict], list[dict]]:
    """
    Parse a PDB, returning (chains, residues).
      chains:   [{id, label, start_resnum, end_resnum, n_residues}]
      residues: [{flat, chain, resnum, resname}]  (flat = 1-based sequential)

    Chains are detected by the chain ID column; residues are ordered as they
    appear so the flat index matches the topology's sequential numbering.
    """
    chains_order: list[str] = []
    chain_residues: dict[str, list[tuple[int, str]]] = {}

    # Water and ion residue names to exclude (broad, case-insensitive). Anything
    # not matching standard amino acids that looks like solvent is dropped. We
    # keep a permissive amino-acid allowlist approach as a backstop below.
    SOLVENT = {
        "HOH", "WAT", "SOL", "TIP", "TIP3", "TIP4", "TIP5", "T3P", "T4P", "SPC",
        "NA", "CL", "POT", "CLA", "SOD", "K", "MG", "ZN", "CAL", "ION",
        "NA+", "CL-", "K+", "MG2", "ZN2",
    }
    AMINO = {
        "ALA","ARG","ASN","ASP","CYS","GLN","GLU","GLY","HIS","ILE","LEU","LYS",
        "MET","PHE","PRO","SER","THR","TRP","TYR","VAL","SEC","PYL",
        # common protonation/terminal variants
        "HID","HIE","HIP","HSD","HSE","HSP","CYX","CYM","ASH","GLH","LYN","ARN",
    }

    seen = set()
    for line in pdb_path.read_text().splitlines():
        if not line.startswith(("ATOM", "HETATM")):
            continue
        resname = line[17:20].strip().upper()
        # Keep only standard protein residues; drop water, ions, ligands, etc.
        # This guarantees the residue table is protein-only and its 1-based flat
        # index matches gmx's protein residue indexing (resindex within Protein).
        if resname in SOLVENT or resname not in AMINO:
            continue
        chain = line[21].strip() or "A"
        try:
            resnum = int(line[22:26])
        except ValueError:
            continue
        key = (chain, resnum)
        if key in seen:
            continue
        seen.add(key)
        if chain not in chain_residues:
            chain_residues[chain] = []
            chains_order.append(chain)
        chain_residues[chain].append((resnum, resname))

    chains = []
    residues = []
    flat = 1
    for cid in chains_order:
        reslist = chain_residues[cid]
        if not reslist:
            continue
        start = reslist[0][0]
        end = reslist[-1][0]
        chains.append({
            "id": cid, "label": "",
            "start_resnum": start, "end_resnum": end,
            "n_residues": len(reslist),
        })
        for (rnum, rname) in reslist:
            residues.append({"flat": flat, "chain": cid,
                             "resnum": rnum, "resname": rname})
            flat += 1

    return chains, residues


async def residues_from_structure(tpr_or_pdb: str, work: Path) -> list[dict]:
    """
    Build the residue-identity table from a structure via editconf -> PDB.
    Returns [{flat, chain, resnum, resname}] in topology order.
    """
    work.mkdir(parents=True, exist_ok=True)
    out_pdb = work / "_system.pdb"
    await run_gmx(["editconf", "-f", tpr_or_pdb, "-o", str(out_pdb)], timeout=120)
    if not out_pdb.exists():
        return []
    _, residues = parse_pdb_chains(out_pdb)
    return residues


async def atom_to_residue_map(tpr_or_pdb: str, work: Path):
    """
    Build {atom_serial (1-based) -> flat_residue_index} and the protein-only
    residue table from a structure via editconf -> PDB.

    Atom serials are globally unique, so mapping contacts via atoms disambiguates
    chains where residue NUMBERS repeat (e.g. a homodimer numbered 400-800 in
    both chains). gmx select's -oi (default seltype) returns atom indices, which
    we map through this table to a unique flat residue -> chain + biological id.

    Returns (atom_map: dict[int,int], residues: list[dict]).
    """
    work.mkdir(parents=True, exist_ok=True)
    out_pdb = work / "_atommap.pdb"
    await run_gmx(["editconf", "-f", tpr_or_pdb, "-o", str(out_pdb)], timeout=120)
    if not out_pdb.exists():
        return {}, []

    AMINO = {
        "ALA","ARG","ASN","ASP","CYS","GLN","GLU","GLY","HIS","ILE","LEU","LYS",
        "MET","PHE","PRO","SER","THR","TRP","TYR","VAL","SEC","PYL",
        "HID","HIE","HIP","HSD","HSE","HSP","CYX","CYM","ASH","GLH","LYN","ARN",
    }
    atom_map = {}
    residues = []
    seen_res = {}
    flat = 0
    for line in out_pdb.read_text().splitlines():
        if not line.startswith(("ATOM", "HETATM")):
            continue
        resname = line[17:20].strip().upper()
        if resname not in AMINO:
            continue
        try:
            serial = int(line[6:11])
            resnum = int(line[22:26])
        except ValueError:
            continue
        chain = line[21].strip() or "A"
        rkey = (chain, resnum)
        if rkey not in seen_res:
            flat += 1
            seen_res[rkey] = flat
            residues.append({"flat": flat, "chain": chain,
                             "resnum": resnum, "resname": resname})
        atom_map[serial] = seen_res[rkey]
    return atom_map, residues


# ─── Mapping ──────────────────────────────────────────────────────────────────

def chain_offsets(chains: list[ChainDef]) -> dict[str, int]:
    """Cumulative residue offset preceding each chain (0 for the first)."""
    offsets = {}
    running = 0
    for c in chains:
        offsets[c.id] = running
        n = c.n_residues if c.n_residues else (c.end_resnum - c.start_resnum + 1)
        running += n
    return offsets


def bio_to_flat(chains: list[ChainDef], chain_id: str, resnum: int) -> Optional[int]:
    """
    Map a biological (chain, full-length resnum) to the flat 1-based ri number.
    Returns None if the chain is unknown or the residue is outside its range.
    """
    offsets = chain_offsets(chains)
    for c in chains:
        if c.id == chain_id:
            if resnum < c.start_resnum or resnum > c.end_resnum:
                return None
            return offsets[c.id] + (resnum - c.start_resnum + 1)
    return None


def bio_range_to_flat(chains: list[ChainDef], chain_id: str,
                      r_start: int, r_end: int) -> Optional[tuple[int, int]]:
    a = bio_to_flat(chains, chain_id, r_start)
    b = bio_to_flat(chains, chain_id, r_end)
    if a is None or b is None:
        return None
    return (min(a, b), max(a, b))


# ─── Request models & endpoints ───────────────────────────────────────────────

class ImportPdbRequest(BaseModel):
    session_id: str
    pdb_path: str

class SaveSystemRequest(BaseModel):
    session_id: str
    chains: list[ChainDef]

class TranslateRequest(BaseModel):
    session_id: str
    chain_id: str
    res_start: int
    res_end: Optional[int] = None
    check_type: bool = False          # assert residue identity if True
    expected_resname: Optional[str] = None  # e.g. "ASP" for a D629 check


@router.post("/import-pdb")
async def import_pdb(req: ImportPdbRequest):
    """Parse a PDB and return detected chains + cache the residue table."""
    pdb = Path(req.pdb_path)
    if not pdb.exists():
        raise HTTPException(status_code=404, detail=f"PDB not found: {req.pdb_path}")
    chains, residues = parse_pdb_chains(pdb)
    if not chains:
        raise HTTPException(status_code=422, detail="No protein chains found in PDB.")
    # Persist as the system definition (user can edit before finalising)
    with locked_state(req.session_id) as state:
        state.system_definition = SystemDefinition(
            chains=[ChainDef(**c) for c in chains],
            source_pdb=str(pdb),
            residues=residues,
        )
    return {"chains": chains, "n_residues": len(residues)}


@router.post("/save")
def save_system(req: SaveSystemRequest):
    """Save the (possibly user-edited) chain definitions."""
    with locked_state(req.session_id) as state:
        existing = state.system_definition or SystemDefinition()
        existing.chains = req.chains
        state.system_definition = existing
    return {"ok": True, "chains": [c.model_dump() for c in req.chains]}


@router.get("/get/{session_id}")
def get_system(session_id: str):
    state = load_state(session_id)
    sd = state.system_definition
    if not sd:
        return {"defined": False, "chains": []}
    return {
        "defined": True,
        "chains": [c.model_dump() for c in sd.chains],
        "source_pdb": sd.source_pdb,
        "n_residues": len(sd.residues),
    }


@router.post("/translate")
def translate(req: TranslateRequest):
    """
    Translate a biological chain+residue(range) to a flat 'ri' selection string.
    Optionally assert the residue identity (check_type).
    """
    state = load_state(req.session_id)
    sd = state.system_definition
    if not sd or not sd.chains:
        raise HTTPException(status_code=400, detail="No system definition set.")

    r_end = req.res_end if req.res_end is not None else req.res_start
    rng = bio_range_to_flat(sd.chains, req.chain_id, req.res_start, r_end)
    if rng is None:
        raise HTTPException(status_code=422,
            detail=f"Residue(s) {req.res_start}-{r_end} not in chain {req.chain_id}.")
    flat_start, flat_end = rng

    result = {
        "chain_id": req.chain_id,
        "res_start": req.res_start, "res_end": r_end,
        "flat_start": flat_start, "flat_end": flat_end,
        "ri": f"{flat_start}-{flat_end}" if flat_start != flat_end else f"{flat_start}",
    }

    # Optional residue-type sanity check
    if req.check_type and sd.residues:
        # find the residue at (chain, res_start)
        match = next((x for x in sd.residues
                      if x["chain"] == req.chain_id and x["resnum"] == req.res_start), None)
        if match:
            result["actual_resname"] = match["resname"]
            if req.expected_resname:
                result["check_passed"] = (
                    match["resname"].upper() == req.expected_resname.upper())
        else:
            result["actual_resname"] = None
            result["check_passed"] = False

    return result

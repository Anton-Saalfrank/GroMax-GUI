"""
File registration via folder scanning (option 2).
The backend scans a directory the user specifies, finds .tpr/.xtc/.pdb files,
auto-pairs replicas by the number embedded in the filename, and registers them.
No file copying — files are referenced in place (they can be multi-GB).
"""

import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .session import load_state, save_state, locked_state

router = APIRouter()


# ─── Replica index extraction ─────────────────────────────────────────────────

def extract_index(filename: str) -> int | None:
    """
    Pull the replica number from a filename.
    'step5_3.pbc.xtc' -> 3,  'step5_10.tpr' -> 10,  'md.xtc' -> None
    Strategy: take the last integer that appears before the extension group.
    """
    stem = filename.split("/")[-1]
    # Remove known extensions progressively
    for ext in [".pbc.xtc", ".xtc", ".tpr", ".pdb", ".gro"]:
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    # Find all integer runs; take the last one (handles step5_1, run_rep3, etc.)
    nums = re.findall(r"\d+", stem)
    return int(nums[-1]) if nums else None


# ─── Folder scan ──────────────────────────────────────────────────────────────

class ScanRequest(BaseModel):
    folder: str
    tpr_pattern: str = "*.tpr"
    xtc_pattern: str = "*.xtc"


def _scan_folder(folder: Path, tpr_glob: str, xtc_glob: str) -> dict:
    tprs = sorted(folder.glob(tpr_glob))
    xtcs = sorted(folder.glob(xtc_glob))
    pdbs = sorted(list(folder.glob("*.pdb")) + list(folder.glob("*.gro")))

    tpr_map = {extract_index(p.name): p for p in tprs}
    xtc_map = {extract_index(p.name): p for p in xtcs}
    all_idx = sorted(
        {i for i in (set(tpr_map) | set(xtc_map)) if i is not None}
    )

    replicas = []
    for idx in all_idx:
        t = tpr_map.get(idx)
        x = xtc_map.get(idx)
        replicas.append({
            "index": idx,
            "tpr": str(t) if t else None,
            "xtc": str(x) if x else None,
            "tpr_name": t.name if t else None,
            "xtc_name": x.name if x else None,
            "paired": bool(t and x),
        })

    # Handle unindexed single files (e.g. one tpr, one xtc, no numbers)
    if not all_idx and (tprs or xtcs):
        replicas.append({
            "index": 1,
            "tpr": str(tprs[0]) if tprs else None,
            "xtc": str(xtcs[0]) if xtcs else None,
            "tpr_name": tprs[0].name if tprs else None,
            "xtc_name": xtcs[0].name if xtcs else None,
            "paired": bool(tprs and xtcs),
        })

    return {
        "replicas": replicas,
        "pdb_candidates": [str(p) for p in pdbs],
        "n_tpr": len(tprs),
        "n_xtc": len(xtcs),
    }


@router.post("/scan")
def scan_folder(req: ScanRequest):
    """Scan a folder and return proposed replica pairings (no registration yet)."""
    folder = Path(req.folder).expanduser()
    if not folder.exists():
        raise HTTPException(status_code=400, detail=f"Folder not found: {folder}")
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {folder}")
    return _scan_folder(folder, req.tpr_pattern, req.xtc_pattern)


# ─── Registration ─────────────────────────────────────────────────────────────

class RegisterScanRequest(BaseModel):
    session_id: str
    condition_id: str
    folder: str
    replicas: list          # the (possibly user-edited) replica list from /scan
    pdb: str | None = None


@router.post("/register-scan")
def register_scan(req: RegisterScanRequest):
    """Register scanned + paired files into a condition."""
    with locked_state(req.session_id) as state:
        if req.condition_id not in state.conditions:
            raise HTTPException(status_code=404, detail="Condition not found")

        # Validate every referenced file exists
        missing = []
        for rep in req.replicas:
            for key in ("tpr", "xtc"):
                p = rep.get(key)
                if p and not Path(p).exists():
                    missing.append(p)
        if req.pdb and not Path(req.pdb).exists():
            missing.append(req.pdb)
        if missing:
            raise HTTPException(status_code=400,
                                detail=f"{len(missing)} file(s) not found: {missing[:3]}")

        cond = state.conditions[req.condition_id]
        cond.replicas = req.replicas
        cond.pdb = req.pdb
        cond.source_dir = req.folder

        # Also populate legacy `files` dict for the first replica (back-compat with analyses)
        if req.replicas:
            first = req.replicas[0]
            cond.files = {}
            if first.get("tpr"):
                cond.files["tpr"] = first["tpr"]
            if first.get("xtc"):
                cond.files["xtc"] = first["xtc"]
        if req.pdb:
            cond.files["pdb"] = req.pdb

    n_paired = sum(1 for r in req.replicas if r.get("paired"))
    return {"ok": True, "n_replicas": len(req.replicas), "n_paired": n_paired}


@router.get("/{session_id}/{condition_id}/status")
def condition_status(session_id: str, condition_id: str):
    """Report readiness of a condition for analysis."""
    state = load_state(session_id)
    if condition_id not in state.conditions:
        raise HTTPException(status_code=404, detail="Condition not found")
    cond = state.conditions[condition_id]
    n_paired = sum(1 for r in cond.replicas if r.get("paired"))
    ready = n_paired > 0 and bool(cond.pdb)
    return {
        "ready": ready,
        "n_replicas": len(cond.replicas),
        "n_paired": n_paired,
        "has_pdb": bool(cond.pdb),
        "source_dir": cond.source_dir,
    }


# ─── Generic file-manager helpers ─────────────────────────────────────────────
# These used to live on the PCA router (/api/pca/reveal, /api/pca/copy-path)
# purely because that's where they were first needed. They have nothing to do
# with PCA — any tab that shows a result path wants them.

class RevealRequest(BaseModel):
    path: str


@router.post("/reveal")
def reveal_file(req: RevealRequest):
    """
    Open the OS file manager with the given file selected (or its folder).
    macOS: open -R. Linux: xdg-open on the directory. Windows: explorer /select.
    """
    import subprocess
    import sys as _sys

    p = Path(req.path).expanduser()
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {req.path}")
    try:
        if _sys.platform == "darwin":
            subprocess.run(["open", "-R", str(p)], check=False)
        elif _sys.platform.startswith("linux"):
            subprocess.run(["xdg-open", str(p.parent)], check=False)
        elif _sys.platform.startswith("win"):
            # One argument, not two. Explorer parses "/select,<path>" as a
            # single token — passing the switch and the path separately puts a
            # space after the comma, and Explorer then ignores the path and
            # opens the default folder instead of selecting the file.
            # It also exits non-zero on success, hence check=False.
            subprocess.run(["explorer", f"/select,{p}"], check=False)
        else:
            return {"ok": False, "error": f"Unsupported platform: {_sys.platform}"}
        return {"ok": True, "path": str(p)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/copy-path")
def copy_path(path: str):
    """Return the absolute path (the frontend copies it to the clipboard)."""
    p = Path(path).expanduser()
    return {"path": str(p.resolve()), "exists": p.exists()}

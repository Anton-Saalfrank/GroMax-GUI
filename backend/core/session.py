"""
Session management.
Each project is a directory under ~/.gromax/projects/<session_id>/
with a state.json describing all registered files, conditions, analyses, and results.
"""

import json
import logging
import os
import tempfile
import threading
import uuid
import shutil
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("gromax.session")

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .config import settings

router = APIRouter()


# ─── Models ──────────────────────────────────────────────────────────────────

class ChainDef(BaseModel):
    id: str                     # chain identifier, e.g. "A"
    label: str = ""            # protein name, e.g. "VPS35"
    start_resnum: int = 1       # full-length residue number of the first residue
    end_resnum: int = 1         # full-length residue number of the last residue
    n_residues: int = 0         # residue count in the simulated excerpt

class SystemDefinition(BaseModel):
    chains: list[ChainDef] = Field(default_factory=list)
    source_pdb: Optional[str] = None
    # cached residue-identity table: list of {flat, chain, resnum, resname}
    residues: list = Field(default_factory=list)

class Condition(BaseModel):
    id: str
    name: str
    colour: str = "#4f8ef7"
    files: dict = Field(default_factory=dict)  # legacy single-file: tpr, xtc, pdb paths
    pbc_corrected: bool = True
    # Structured replicas: [{"index": 1, "tpr": "...", "xtc": "..."}]
    replicas: list = Field(default_factory=list)
    pdb: Optional[str] = None       # single reference structure for the condition
    source_dir: Optional[str] = None  # folder the files were scanned from

class TimeWindow(BaseModel):
    id: str
    name: str
    start_ns: Optional[float] = None
    end_ns: Optional[float] = None
    stride: int = 1

class SessionState(BaseModel):
    id: str
    name: str
    created_at: str
    updated_at: str
    conditions: dict[str, Condition] = Field(default_factory=dict)
    time_windows: dict[str, TimeWindow] = Field(default_factory=dict)
    index_groups: dict = Field(default_factory=dict)   # name → .ndx path
    analyses: dict = Field(default_factory=dict)        # hash → result metadata
    system_definition: Optional[SystemDefinition] = None  # multi-chain mapping
    notes: str = ""
    # Per-project UI state that outlives the window: picked residues, highlight
    # layers, saved selection groups, the Analyses form.
    #
    # Stored here rather than in browser storage because it belongs to the
    # PROJECT, not to the machine — a selection built from this system's residue
    # numbering is meaningless against another one, and it should travel with
    # the project folder the way the analyses already do.
    #
    # Deliberately an opaque dict: the frontend owns its own shape, and the
    # backend has no business validating a UI layout. It is only ever handed
    # back to the code that wrote it.
    workspace: dict = Field(default_factory=dict)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def session_dir(session_id: str) -> Path:
    return settings.projects_dir / session_id

def state_path(session_id: str) -> Path:
    return session_dir(session_id) / "state.json"

def load_state(session_id: str) -> SessionState:
    p = state_path(session_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    return SessionState(**json.loads(p.read_text()))


def save_state(state: SessionState):
    """
    Write state.json ATOMICALLY.

    A bare write_text() leaves a half-written state.json if the process dies
    mid-write, which loses the entire project. Writing to a temp file in the
    same directory and then os.replace() is atomic on every supported OS: a
    reader sees either the old file or the new one, never a partial one.
    """
    p = state_path(state.id)
    p.parent.mkdir(parents=True, exist_ok=True)
    state.updated_at = datetime.now(timezone.utc).isoformat()
    payload = state.model_dump_json(indent=2)

    fd, tmp_name = tempfile.mkstemp(dir=str(p.parent), prefix=".state-", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())      # durable before the swap
        os.replace(tmp, p)            # atomic
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


# ─── Concurrency ──────────────────────────────────────────────────────────────
# state.json is a single shared document, but it's mutated from several places
# at once:
#   * FastAPI sync (`def`) endpoints run in a THREADPOOL, so they genuinely
#     preempt each other. "Hide all" in the UI fires one POST /visibility per
#     analysis simultaneously — ten threads doing load -> modify -> save on the
#     same file.
#   * Job workers are asyncio tasks (serialised among themselves), but a
#     threadpool endpoint can interleave with them.
#
# Without a lock this is a classic lost update: two writers both load the same
# state, each adds its own change, and whoever saves last silently erases the
# other. Symptom: an analysis completes but never appears, or Show/Hide all
# only sticks for some items.
#
# Every read-modify-write of state.json must therefore go through locked_state().

_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def _lock_for(session_id: str) -> threading.RLock:
    """Get (or create) the lock guarding one session's state.json."""
    with _locks_guard:
        lock = _locks.get(session_id)
        if lock is None:
            lock = threading.RLock()
            _locks[session_id] = lock
        return lock


@contextmanager
def locked_state(session_id: str):
    """
    Load state, let the caller mutate it, then save — all under one lock, so
    concurrent writers serialise instead of clobbering each other.

        with locked_state(sid) as state:
            state.analyses[key] = entry

    Re-entrant, so nesting is safe. The lock is only held across the (fast,
    synchronous) load/mutate/save; never await inside this block.
    """
    with _lock_for(session_id):
        # NB: load_state / save_state directly — calling locked_state here would
        # recurse infinitely.
        state = load_state(session_id)
        yield state
        save_state(state)


# ─── Routes ──────────────────────────────────────────────────────────────────

@router.get("/list")
def list_sessions():
    """Return all projects sorted by last updated."""
    projects = []
    if not settings.projects_dir.exists():
        return []
    for p in settings.projects_dir.iterdir():
        row = _summarise_project(p)
        if row:
            projects.append(row)
    return sorted(projects, key=lambda x: x["updated_at"], reverse=True)


# ─── Disk usage ──────────────────────────────────────────────────────────────
#
# WHY THIS EXISTS
# A project folder holds every analysis ever run in it, and nothing in the UI
# ever said how big that was. Measured on this machine: three projects at 13 GB,
# 9.4 GB and 5.2 GB, none of it visible anywhere, with the home screen offering
# "archive" as though the only cost of keeping a project were clutter.
#
# WHY IT IS BROKEN DOWN BY CATEGORY RATHER THAN TOTALLED
# A single number tells you that you have a problem, not what to do about it.
# The breakdown is actionable in a way the total is not: `results/` is
# recomputable but expensive, `cache/` is recomputable and cheap, `topologies/`
# is recomputable and nearly free. On the 13 GB project above, results/ is 11 GB
# and topologies/ is 76 MB — so a UI that led with "clear the cache" would be
# pointing at the wrong 2%.
#
# WHY IT IS ITS OWN ENDPOINT AND NOT PART OF /list
# It walks the whole tree. That is ~0.2 s warm for 7300 files and rather more
# cold, which is fine for a number that appears a moment after the list, and not
# fine for the list itself — the project names must never wait on a disk walk.

#: Directories inside a project whose cost is worth naming separately, in the
#: order they are worth showing: biggest-and-most-precious first.
USAGE_CATEGORIES = [
    ("results", "Analysis results", False),
    ("pca", "PCA", False),
    ("cache", "Cached intermediates", True),
    ("topologies", "Engine topologies", True),
    ("frames", "Structure snapshots", True),
    ("ndx", "Index groups", True),
    ("conditions", "Condition files", False),
]


def _dir_usage(d: Path) -> tuple[int, int]:
    """
    (bytes, file count) under `d`, counting each inode once.

    Hard links are the point: the topology store deliberately gives several
    cache names one set of bytes, and a walk that added up `st_size` per name
    would report the space this app just finished saving. `du` behaves this way
    too, which is what makes the two agree.
    """
    seen: set[tuple[int, int]] = set()
    total = count = 0
    if not d.is_dir():
        return 0, 0
    for root, _dirs, files in os.walk(d, onerror=lambda e: None):
        for f in files:
            try:
                st = os.lstat(os.path.join(root, f))
            except OSError:
                continue
            count += 1
            key = (st.st_dev, st.st_ino)
            if st.st_nlink > 1:
                if key in seen:
                    continue
                seen.add(key)
            total += st.st_size
    return total, count


def _project_usage(d: Path) -> dict:
    """Per-category disk use for one project directory."""
    cats, named_bytes = [], 0
    for key, label, recomputable in USAGE_CATEGORIES:
        b, n = _dir_usage(d / key)
        named_bytes += b
        if n:
            cats.append({"key": key, "label": label, "bytes": b,
                         "n_files": n, "recomputable": recomputable})

    total, total_files = _dir_usage(d)
    other = max(0, total - named_bytes)

    return {
        "total_bytes": total,
        "n_files": total_files,
        "categories": cats,
        # state.json, the workspace, anything a future version adds. Shown so
        # the parts always add up to the total — a breakdown that silently
        # omits a category is worse than no breakdown.
        "other_bytes": other,
    }


@router.get("/usage/projects")
def usage_projects():
    """
    Disk use of every project, broken down, plus what could be reclaimed.

    `reclaimable_bytes` is measured, not estimated: it is a dry run of the
    topology deduplication, so the number offered to the user is the number they
    would actually get.

    Two path segments so this can never be confused with `/{session_id}`,
    whatever order the routes end up declared in.
    """
    out = []
    for base, archived in ((settings.projects_dir, False),
                           (settings.archive_dir, True)):
        if not base.exists():
            continue
        for d in sorted(base.iterdir()):
            if not d.is_dir() or not (d / "state.json").exists():
                continue
            row = {"id": d.name, "archived": archived, "path": str(d)}
            try:
                s = json.loads((d / "state.json").read_text())
                row["name"] = s.get("name", d.name)
            except Exception:
                row["name"] = d.name
            try:
                row.update(_project_usage(d))
            except OSError as e:
                row["error"] = str(e)
            row["reclaimable_bytes"] = _reclaimable(d)
            out.append(row)
    out.sort(key=lambda r: r.get("total_bytes", 0), reverse=True)
    return {"projects": out,
            "total_bytes": sum(r.get("total_bytes", 0) for r in out),
            "reclaimable_bytes": sum(r.get("reclaimable_bytes", 0) for r in out)}


def _reclaimable(d: Path) -> int:
    """Bytes a reclaim would free for this project. Never raises: a usage
    report that fails because one project is unreadable is useless."""
    try:
        from engines.topology import dedup_topologies
        return int(dedup_topologies(d / "topologies",
                                    dry_run=True)["reclaimable_bytes"])
    except Exception:
        return 0


@router.post("/{session_id}/reclaim")
def reclaim_space(session_id: str):
    """
    Free the space the usage report offered, without losing a cache entry.

    Deduplication only — every topology stays exactly where it was and reads
    identically afterwards, because the redundant copies are replaced by hard
    links to shared bytes. Nothing here deletes a cache entry, so this cannot
    cost anyone a recomputation; it is safe to offer without a confirmation
    step, which is why it is separate from any "clear cache" action.
    """
    d = session_dir(_safe_id(session_id))
    if not d.exists():
        d = archive_dir_for(session_id)
    if not d.exists():
        raise HTTPException(status_code=404,
                            detail=f"Session '{session_id}' not found")

    from engines.topology import dedup_topologies
    before = _dir_usage(d)[0]
    st = dedup_topologies(d / "topologies")
    after = _dir_usage(d)[0]

    return {
        "ok": True,
        "freed_bytes": max(0, before - after),
        "n_relinked": st["n_relinked"],
        "n_distinct": st["n_distinct"],
        "total_bytes": after,
    }


class CreateSessionRequest(BaseModel):
    name: str

@router.post("/create")
def create_session(req: CreateSessionRequest):
    """Create a new project session."""
    sid = str(uuid.uuid4())[:8]
    d = session_dir(sid)
    d.mkdir(parents=True, exist_ok=True)
    (d / "conditions").mkdir(exist_ok=True)
    (d / "results").mkdir(exist_ok=True)
    (d / "cache").mkdir(exist_ok=True)
    (d / "ndx").mkdir(exist_ok=True)

    now = datetime.now(timezone.utc).isoformat()
    state = SessionState(id=sid, name=req.name, created_at=now, updated_at=now)
    save_state(state)
    return state


# ─── Archive ─────────────────────────────────────────────────────────────────
#
# WHY ARCHIVE RATHER THAN DELETE
# A project folder holds every analysis ever run in it — often hours of compute
# that cannot be reproduced from anything in the UI. A misclick on a delete
# button is unrecoverable; a misclick on an archive button is a nuisance. So the
# home screen only ever offers archive, and permanent deletion is possible only
# from inside the archive, where the thing being deleted has already been named
# and looked at once.
#
# Archiving MOVES the directory rather than copying it: a 50 GB project would
# otherwise fill the disk, and a half-finished copy is a worse failure than no
# archive at all. The session id is preserved, so absolute paths recorded inside
# state.json are valid again the moment it is restored.

ARCHIVE_MARKER = ".archived.json"


def _safe_id(session_id: str) -> str:
    """
    Reject anything that is not a plain id before it reaches a path.

    These endpoints move and delete whole directories, and session_id arrives
    from the URL. Without this, an id of '../..' would resolve outside the
    projects directory and rmtree something that was never a project.
    """
    import re as _re
    if not _re.fullmatch(r"[A-Za-z0-9_-]{1,64}", session_id or ""):
        raise HTTPException(status_code=400,
                            detail=f"Not a valid project id: {session_id!r}")
    return session_id


def archive_dir_for(session_id: str) -> Path:
    return settings.archive_dir / _safe_id(session_id)


def _running_jobs_for(session_id: str) -> int:
    """How many jobs are still live for this project. Moving its folder out
    from under a running analysis would fail the job and lose its output."""
    try:
        from .jobs import job_manager, JobStatus
        return sum(1 for j in job_manager.list_jobs(session_id)
                   if j.status in (JobStatus.PENDING, JobStatus.RUNNING))
    except Exception:
        return 0


def _summarise_project(d: Path, extra: dict | None = None) -> Optional[dict]:
    sp = d / "state.json"
    if not sp.exists():
        return None
    try:
        s = json.loads(sp.read_text())
    except Exception:
        return None
    out = {
        "id": s["id"],
        "name": s["name"],
        "created_at": s["created_at"],
        "updated_at": s["updated_at"],
        "conditions": list(s.get("conditions", {}).keys()),
        "path": str(d),
    }
    out.update(extra or {})
    return out


@router.get("/archive/list")
def list_archived():
    """Archived projects, most recently archived first."""
    out = []
    if not settings.archive_dir.exists():
        return out
    for d in settings.archive_dir.iterdir():
        if not d.is_dir():
            continue
        marker = d / ARCHIVE_MARKER
        meta = {}
        if marker.exists():
            try:
                meta = json.loads(marker.read_text())
            except Exception:
                meta = {}
        row = _summarise_project(d, {"archived_at": meta.get("archived_at", "")})
        if row:
            out.append(row)
    return sorted(out, key=lambda x: x.get("archived_at") or x["updated_at"],
                  reverse=True)


@router.post("/{session_id}/archive")
def archive_session(session_id: str):
    """Move a project into the archive. Reversible; nothing is deleted."""
    src = session_dir(_safe_id(session_id))
    if not src.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    live = _running_jobs_for(session_id)
    if live:
        raise HTTPException(
            status_code=409,
            detail=f"{live} job(s) are still running in this project. "
                   f"Wait for them to finish or cancel them first — moving the "
                   f"folder now would lose their output.")

    dest = archive_dir_for(session_id)
    if dest.exists():
        raise HTTPException(
            status_code=409,
            detail=f"The archive already holds a project with id {session_id}. "
                   f"Restore or delete that one first.")

    name = ""
    try:
        name = json.loads((src / "state.json").read_text()).get("name", "")
    except Exception:
        pass

    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    # shutil.move falls back to copy+delete across filesystems; the archive is a
    # sibling of projects_dir, so in practice this is an atomic rename.
    shutil.move(str(src), str(dest))
    (dest / ARCHIVE_MARKER).write_text(json.dumps({
        "archived_at": datetime.now(timezone.utc).isoformat(),
        "id": session_id, "name": name,
    }, indent=2))
    log.info("archived project %s (%s)", session_id, name)
    return {"ok": True, "id": session_id, "name": name, "path": str(dest)}


@router.post("/archive/{session_id}/restore")
def restore_session(session_id: str):
    """Move an archived project back. The id is unchanged, so every path
    recorded inside it points at the right place again."""
    src = archive_dir_for(session_id)
    if not src.exists():
        raise HTTPException(status_code=404,
                            detail="No archived project with that id")
    dest = session_dir(_safe_id(session_id))
    if dest.exists():
        raise HTTPException(
            status_code=409,
            detail=f"A live project with id {session_id} already exists.")

    settings.projects_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))
    marker = dest / ARCHIVE_MARKER
    if marker.exists():
        marker.unlink()
    log.info("restored project %s", session_id)
    return {"ok": True, "id": session_id}


@router.delete("/archive/{session_id}")
def delete_archived(session_id: str):
    """
    Delete an archived project for good.

    Only reachable for something already in the archive, so nothing can be
    destroyed in a single action from the project list.
    """
    d = archive_dir_for(session_id)
    if not d.exists():
        raise HTTPException(status_code=404,
                            detail="No archived project with that id")
    shutil.rmtree(d)
    log.info("permanently deleted archived project %s", session_id)
    return {"ok": True, "id": session_id}


@router.get("/{session_id}")
def get_session(session_id: str):
    return load_state(session_id)


@router.delete("/{session_id}")
def delete_session(session_id: str):
    d = session_dir(_safe_id(session_id))
    if not d.exists():
        raise HTTPException(status_code=404, detail="Session not found")
    shutil.rmtree(d)
    return {"ok": True}


# ─── Conditions ──────────────────────────────────────────────────────────────

class AddConditionRequest(BaseModel):
    name: str
    colour: str = "#4f8ef7"
    pbc_corrected: bool = True

@router.post("/{session_id}/conditions")
def add_condition(session_id: str, req: AddConditionRequest):
    with locked_state(session_id) as state:
        cid = str(uuid.uuid4())[:8]
        cond_dir = session_dir(session_id) / "conditions" / cid
        cond_dir.mkdir(parents=True, exist_ok=True)
        (cond_dir / "results").mkdir(exist_ok=True)

        condition = Condition(id=cid, name=req.name, colour=req.colour,
                              pbc_corrected=req.pbc_corrected)
        state.conditions[cid] = condition
    return condition


@router.delete("/{session_id}/conditions/{condition_id}")
def delete_condition(session_id: str, condition_id: str, purge_files: bool = False):
    """
    Remove a condition.

    Also drops any stored analyses that reference it — otherwise the Results
    and Compare tabs keep plotting traces for a condition that no longer
    exists, with no way to get rid of them.

    `purge_files` additionally deletes the condition's working directory. Off
    by default: the source trajectories live wherever the user scanned them
    from and are never touched, but the results folder may still be wanted.
    """
    import shutil

    with locked_state(session_id) as state:
        if condition_id not in state.conditions:
            raise HTTPException(status_code=404, detail="Condition not found")

        name = state.conditions[condition_id].name
        del state.conditions[condition_id]

        # Drop analyses belonging to this condition.
        removed = []
        if getattr(state, "analyses", None):
            for key, entry in list(state.analyses.items()):
                ent_cond = (entry.get("condition_id")
                            if isinstance(entry, dict)
                            else getattr(entry, "condition_id", None))
                if ent_cond == condition_id:
                    del state.analyses[key]
                    removed.append(key)

    if purge_files:
        cond_dir = session_dir(session_id) / "conditions" / condition_id
        if cond_dir.exists():
            shutil.rmtree(cond_dir, ignore_errors=True)

    return {"ok": True, "deleted": condition_id, "name": name,
            "analyses_removed": len(removed), "files_purged": purge_files}


@router.patch("/{session_id}/conditions/{condition_id}")
def update_condition(session_id: str, condition_id: str, updates: dict):
    with locked_state(session_id) as state:
        if condition_id not in state.conditions:
            raise HTTPException(status_code=404, detail="Condition not found")
        cond = state.conditions[condition_id]
        for k, v in updates.items():
            if hasattr(cond, k):
                setattr(cond, k, v)
    return cond


# ─── Time windows ─────────────────────────────────────────────────────────────

class AddTimeWindowRequest(BaseModel):
    name: str
    start_ns: Optional[float] = None
    end_ns: Optional[float] = None
    stride: int = 1

class WorkspaceRequest(BaseModel):
    workspace: dict


@router.put("/{session_id}/workspace")
def save_workspace(session_id: str, req: WorkspaceRequest):
    """
    Persist the per-project UI state.

    Written under the state lock like everything else: analyses finishing in the
    background write to the same file, and an unlocked read-modify-write here
    would drop whichever landed first.
    """
    with locked_state(session_id) as state:
        state.workspace = req.workspace or {}
    return {"ok": True}


@router.post("/{session_id}/time-windows")
def add_time_window(session_id: str, req: AddTimeWindowRequest):
    with locked_state(session_id) as state:
        wid = str(uuid.uuid4())[:8]
        tw = TimeWindow(id=wid, **req.model_dump())
        state.time_windows[wid] = tw
    return tw


@router.delete("/{session_id}/time-windows/{window_id}")
def delete_time_window(session_id: str, window_id: str):
    with locked_state(session_id) as state:
        state.time_windows.pop(window_id, None)
    return {"ok": True}

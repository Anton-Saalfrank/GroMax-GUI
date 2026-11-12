"""
Analysis runner — orchestrates running an analysis across replicas & conditions,
submits work to the job queue, caches results, and assembles comparison data.
"""

import logging
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent))

# The per-engine registry supersedes the flat one; analyses/ is still the
# GROMACS engine's own set of modules, reached through engines/gromacs.py.
from engines import (DEFAULT_ENGINE, describe_engines, get_engine,
                     get_engine_analysis)
from .selections import common_groups, translate_all
from .session import load_state, save_state, session_dir, locked_state
from .gmx import (make_analysis_hash, get_cached_result, save_cached_result,
                   get_index_groups, count_frames, _file_identity)
from .jobs import job_manager

# ─── Extracted modules ───────────────────────────────────────────────────────
#
# This module was 2152 lines and twelve endpoints. The four pieces below were
# lifted out WHOLE — no logic changed — along the section comments that were
# already in the file, because each has a different reason to be read:
#
#   ndx_builder     selection text -> a gmx index group, and the diagnostics
#                   for when make_ndx refuses it
#   replica_agg     combining replicas into a mean, a spread and a pooled
#                   colour range; pure, and the part most worth testing
#   engine_process  running a blocking engine in a separate process, with the
#                   watchdog and the exit-code reporting
#   derived         endpoints that read cached results rather than running
#                   anything (correlate, CSV export, row baseline, matrix
#                   distribution). Carries its own router, included below.
#
# Only what this module still USES is imported. No compatibility re-exports:
# the four test modules that reached in for the moved helpers now import them
# from the module that owns them, so there is exactly one place each name
# lives and no shim to mislead the next reader.
from .ndx_builder import build_ndx_for_selections, describe_ri_selection
from .replica_agg import _agg_replicas, _map_matrix_residues
from .engine_process import _run_engine
from .derived import router as _derived_router

log = logging.getLogger("gromax.analysis")

router = APIRouter()

# Mounted into this router, not into the app, so correlate / export-csv /
# row-baseline / matrix-distribution keep their existing /api/analysis paths
# and main.py needs no change.
router.include_router(_derived_router)


# ─── Metadata ─────────────────────────────────────────────────────────────────

def _engine_or_400(engine_id: str):
    """Resolve an engine, reporting an unknown name as a 400 rather than a 500."""
    try:
        return get_engine(engine_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/available")
def available_analyses(engine: str = DEFAULT_ENGINE):
    """
    Analyses one engine can run.

    Engine-scoped because the sets genuinely differ: MDAnalysis offers RDF and
    dihedrals that gmx has no tool for, cpptraj has no 2D-RMSD, and the default
    selections are written in each engine's own language.
    """
    return _engine_or_400(engine).list_analyses()


@router.get("/engines")
def analysis_engines():
    """
    Every engine, whether or not it is installed.

    Unavailable engines are returned too, with the reason and the exact install
    command — omitting them would leave the user unable to tell "not supported"
    from "not installed".
    """
    return {"engines": describe_engines(), "default": DEFAULT_ENGINE}


class TranslateSelectionRequest(BaseModel):
    selections: list[str]
    to_engine: str


@router.post("/translate-selection")
def translate_selection(req: TranslateSelectionRequest):
    """
    Rewrite selections into another engine's language.

    Lets the Analyses tab show the real string that will run when you switch
    engine, rather than silently sending GROMACS syntax to MDAnalysis. Anything
    unparseable comes back unchanged with a warning attached — see
    core/selections.py for why guessing is worse than saying so.
    """
    engine = _engine_or_400(req.to_engine)
    texts, warnings = translate_all(req.selections, engine.dialect)
    return {
        "selections": texts,
        "warnings": warnings,
        "dialect": engine.dialect,
        "chips": common_groups(engine.dialect),
        "selection_help": engine.selection_help,
    }



# ─── Run request ──────────────────────────────────────────────────────────────

class RunRequest(BaseModel):
    session_id: str
    analysis_type: str
    # Which analysis software runs this. Defaults to GROMACS so anything that
    # predates the engine picker — a saved draft, a scripted call — keeps
    # meaning exactly what it did before.
    engine: str = "gromacs"
    condition_ids: list[str]          # run on these conditions
    groups: list[str]                 # index group name(s), length = n_groups
    analysis_name: str = ""           # user label; auto-generated if blank
    time_start: Optional[float] = None  # ns
    time_end: Optional[float] = None    # ns
    stride: int = 1
    params: dict = {}                 # per-analysis extras (e.g. contact cutoff)
    force: bool = False               # ignore cache
    # Which replicas to run, per condition: {condition_id: [1, 3, 4]}.
    #
    # A condition that is absent, or maps to an empty list, runs ALL of its
    # paired replicas — which is what every caller did before this existed, so
    # an old client keeps its exact behaviour. Indices are the replica's own
    # `index`, the number shown in the UI, NOT a position in the list: deleting
    # replica 2 must not silently renumber replica 3.
    replicas: dict[str, list[int]] = {}


def _sanitize_name(s: str) -> str:
    """Make a string safe for a filename/folder: alnum, dash, underscore."""
    import re
    s = s.strip().replace(" ", "-")
    s = re.sub(r"[^A-Za-z0-9_\-]", "", s)
    return s or "unnamed"


def auto_analysis_name(analysis_type: str, groups: list[str]) -> str:
    """
    Generate a descriptive name from the selection when the user leaves it blank.
    Single group -> that group's name; two groups (mindist etc.) -> name1_name2.
    """
    cleaned = [_sanitize_name(g) for g in groups if g and g.strip()]
    if not cleaned:
        return analysis_type
    if len(cleaned) == 1:
        return cleaned[0]
    # Two+ groups: join the first two (e.g. mindist between two selections)
    return "_".join(cleaned[:2])



def _make_run_coro(req: RunRequest, condition_id: str):
    """Build the coroutine factory the job worker will execute."""

    async def coro(progress_cb, log_cb):
        state = load_state(req.session_id)
        cond = state.conditions[condition_id]
        analysis = get_engine_analysis(req.engine, req.analysis_type)

        # Determine replicas (structured) or fall back to legacy single files
        replicas = [r for r in cond.replicas if r.get("paired")]
        if not replicas and cond.files.get("tpr") and cond.files.get("xtc"):
            replicas = [{"index": 1, "tpr": cond.files["tpr"], "xtc": cond.files["xtc"]}]
        if not replicas:
            raise RuntimeError(f"Condition '{cond.name}' has no paired tpr/xtc files.")

        # NARROW TO THE CHOSEN REPLICAS
        #
        # An unknown index is refused rather than ignored. Silently dropping it
        # would run on a smaller set than asked for and report a mean over
        # replicas the user believes they included — the same class of problem
        # as a selection that quietly matches the wrong atoms.
        all_indices = [int(r["index"]) for r in replicas]
        wanted = [int(i) for i in (req.replicas.get(condition_id) or [])]
        if wanted:
            unknown = sorted(set(wanted) - set(all_indices))
            if unknown:
                raise RuntimeError(
                    f"Condition '{cond.name}' has no replica "
                    f"{', '.join(str(u) for u in unknown)}. "
                    f"Paired replicas here are: "
                    f"{', '.join(str(i) for i in all_indices)}.")
            chosen = set(wanted)
            replicas = [r for r in replicas if int(r["index"]) in chosen]
            if not replicas:
                raise RuntimeError(
                    f"No replicas selected for condition '{cond.name}'.")
            if len(replicas) < len(all_indices):
                log_cb(f"Running {len(replicas)} of {len(all_indices)} replicas: "
                       f"{', '.join(str(int(r['index'])) for r in replicas)}")

        # Resolve the analysis name (auto-generate from selection if blank)
        analysis_name = _sanitize_name(req.analysis_name) if req.analysis_name.strip() \
            else auto_analysis_name(req.analysis_type, req.groups)

        # Cache key includes everything that affects the result (incl. the name,
        # so two differently-named analyses of the same type never collide).
        #
        # Files are identified by (path, mtime, size) rather than path alone:
        # re-running a simulation and overwriting the same .xtc used to serve a
        # stale cached result, because the key never changed. With the identity
        # in the key, the hash changes and the analysis re-runs automatically.
        params = {
            "condition": condition_id,
            "name": analysis_name,
            # Without this, the same analysis run under two engines hashes to
            # the same key — and the second one silently returns the first
            # one's numbers, which is the worst possible way to compare them.
            "engine": req.engine,
            "groups": req.groups,
            "time_start": req.time_start,
            "time_end": req.time_end,
            "stride": req.stride,
            # Per-analysis params MUST be in the key: changing a contact cutoff
            # produces a different result, and without this the cache would
            # return the old trace under the new cutoff — silently wrong.
            "params": req.params or {},
            "n_replicas": len(replicas),
            "files": [_file_identity(r["xtc"]) or r["xtc"] for r in replicas],
        }
        # Only when a SUBSET was asked for. The file list and count already
        # differ between subsets, so this key is belt-and-braces — but adding it
        # unconditionally would change the hash of every analysis ever run and
        # silently orphan the whole cache, forcing hours of re-computation for
        # a feature nobody used yet.
        if len(replicas) < len(all_indices):
            params["replica_indices"] = sorted(int(r["index"]) for r in replicas)
        cache_key = make_analysis_hash(req.analysis_type, params)

        if not req.force:
            cached = get_cached_result(req.session_id, cache_key)
            if cached:
                log_cb("Loaded from cache.")
                progress_cb(100)
                return cached

        # Storage folder named by analysis type + user name, so multiple
        # analyses of the same type (e.g. two different mindist pairs) each get
        # their own folder and never overwrite each other. Files inside are
        # named <type>_<name>_<i>.xvg to match the HTML tool's _i.xvg convention.
        folder_tag = f"{req.analysis_type}_{analysis_name}"
        rep_results = []
        for i, rep in enumerate(replicas):
            log_cb(f"Replica {rep['index']} ({i+1}/{len(replicas)})…")
            work_dir = (session_dir(req.session_id) / "results" /
                        folder_tag / condition_id / f"rep{rep['index']}")

            # Index files are a GROMACS concept. The other engines take their
            # selection strings directly, and handing them an .ndx group name
            # would be meaningless — so only build one when gmx will read it.
            if req.engine == "gromacs":
                resolved_groups, ndx_path = await build_ndx_for_selections(
                    rep["tpr"], req.groups, work_dir, log_cb=log_cb
                )
                # Spell out what `ri` resolved to in biological terms. The atom
                # count alone does not reveal an off-by-a-chain error — it looks
                # entirely reasonable while describing the wrong residues.
                if i == 0:
                    sd = state.system_definition
                    chains = sd.chains if (sd and sd.chains) else []
                    for g in req.groups:
                        desc = describe_ri_selection(chains, str(g or ""))
                        if desc:
                            log_cb(f"'{g}' covers {desc}")
            else:
                resolved_groups, ndx_path = list(req.groups), None

            # STRIDE: gmx -dt filters on time, so we need this trajectory's own
            # timestep to turn "every Nth frame" into a ps value. `gmx check` is
            # cached on file identity, so this costs one read per file per
            # server run — and we only pay it when a stride is actually asked
            # for. If the timestep can't be determined we warn and run at full
            # resolution rather than silently applying a wrong -dt.
            dt_ps = None
            # cpptraj windows frames, not time, so it needs the timestep even
            # without a stride — otherwise a "200-400 ns" window would either be
            # ignored or, worse, applied as frame numbers.
            # Only the engines that express a stride or a window in TIME need
            # the trajectory's timestep. GROMACS turns a stride into
            # `-dt N*dt_ps`; cpptraj windows by frame number, so it needs dt to
            # convert a time window. MDAnalysis and MDTraj both stride by frame
            # INDEX and read each frame's own time, so for them this was a
            # pointless extra pass over the trajectory — and because it shells
            # out to `gmx check`, it made a pure-Python analysis fail outright
            # with "GROMACS executable not found" on any machine without gmx.
            strides_in_time = req.engine in ("gromacs", "cpptraj")
            needs_dt = (strides_in_time and req.stride and req.stride > 1) or (
                req.engine == "cpptraj"
                and (req.time_start is not None or req.time_end is not None))
            if needs_dt:
                info = await count_frames(rep["tpr"], rep["xtc"])
                dt_ps = info.get("dt_ps")
                if dt_ps:
                    log_cb(f"Stride {req.stride} → -dt {dt_ps * req.stride:g} ps")
                else:
                    log_cb(f"WARNING: could not determine timestep for "
                           f"{Path(rep['xtc']).name}; ignoring stride "
                           f"and using every frame.")

            ctx = {
                "tpr": rep["tpr"],
                "xtc": rep["xtc"],
                "groups": resolved_groups,
                "time_start": req.time_start,
                "time_end": req.time_end,
                "stride": req.stride,
                "dt_ps": dt_ps,
                "params": req.params or {},
                "ndx": ndx_path,
                # Shared across analyses of the same replica: a tpr-derived
                # topology is built once and reused (engines/topology.py).
                "_topology_dir": str(session_dir(req.session_id) / "topologies"),
                # descriptive output filename for HTML-tool compatibility
                "_out_name": f"{folder_tag}_{rep['index']}",
            }

            def cb(line, idx=rep["index"]):
                log_cb(line)

            data = await _run_engine(analysis, ctx, work_dir, cb)
            data["_rep_index"] = rep["index"]
            # Resolve matrix rows to residues here rather than in the engines:
            # the system definition lives with the session, and doing it once
            # means all four engines produce the same identities.
            if data.get("residues"):
                sd = state.system_definition
                data["residues"] = _map_matrix_residues(
                    sd.chains if (sd and sd.chains) else [], data["residues"])
            # Same mapping for a list of residues carried alongside a time
            # series — "which residues newly emerged" is only actionable if the
            # structure viewer recognises the numbers.
            if data.get("newly_exposed"):
                sd = state.system_definition
                chains = sd.chains if (sd and sd.chains) else []
                flat = [r.get("resnum") for r in data["newly_exposed"]]
                for row, bio in zip(data["newly_exposed"],
                                    _map_matrix_residues(chains, flat)):
                    row["bio"] = bio
            # Heatmap matrices are huge (480x480 = 230k cells). Round to 3 dp —
            # 0.001 nm precision is far beyond what's meaningful for RMSD — which
            # shrinks the JSON several-fold with no visible change.
            if data.get("kind") == "heatmap" and isinstance(data.get("z"), list):
                data["z"] = [[round(float(v), 3) for v in row] for row in data["z"]]
            rep_results.append(data)
            progress_cb(int((i + 1) / len(replicas) * 90))

        agg = _agg_replicas(rep_results)
        agg["condition_id"] = condition_id
        agg["condition_name"] = cond.name
        agg["colour"] = cond.colour
        agg["analysis_type"] = req.analysis_type
        agg["engine"] = req.engine
        agg["analysis_name"] = analysis_name
        agg["folder"] = folder_tag

        # Heatmaps: store each replica's matrix as its OWN cache entry, so the
        # main result stays small and the UI can fetch a replica on demand when
        # the user clicks through. Embedding them all made results ~90 MB.
        if agg.get("kind") == "heatmap" and len(rep_results) > 1:
            for r in rep_results:
                ri = r.get("_rep_index")
                # The AXES go with the matrix, not just the matrix.
                #
                # A correlation matrix shares one residue axis across replicas,
                # so dropping them was harmless. A rolling RMSF does not:
                # replicas differ in length, so they have different numbers of
                # time windows. Storing z alone would plot replica 5's map
                # against replica 1's time axis and mislabel every column — by
                # more, the further apart the two runs are. They are a few
                # hundred numbers next to a matrix of tens of thousands.
                per_rep = {"kind": "heatmap", "z": r.get("z"), "index": ri}
                for field in ("x", "y", "xlabel", "ylabel", "zlabel",
                              "time_x", "residues", "window_ns", "step_ns"):
                    # Absent stays absent. The UI layers this over the
                    # aggregated result, so writing an explicit null would
                    # ERASE a field the aggregate does have rather than
                    # falling through to it.
                    if r.get(field) is not None:
                        per_rep[field] = r[field]
                save_cached_result(req.session_id, f"{cache_key}__rep{ri}", per_rep)
            agg["replica_cache_prefix"] = cache_key

        # Persist
        save_cached_result(req.session_id, cache_key, agg)
        # Register under the lock: several analyses finish concurrently and each
        # adds its own key, so an unlocked read-modify-write loses entries.
        with locked_state(req.session_id) as state:
            state.analyses[cache_key] = {
                "type": req.analysis_type,
                "engine": req.engine,
                "name": analysis_name,
                "condition_id": condition_id,
                "condition_name": cond.name,
                "colour": cond.colour,
                "params": params,
                "cache_key": cache_key,
                "folder": folder_tag,
            }

        progress_cb(100)
        return agg

    return coro


@router.post("/run")
def run_analysis(req: RunRequest):
    """Submit analysis jobs (one per condition) to the queue."""
    state = load_state(req.session_id)

    # Validate up front: a bad engine or an analysis that engine cannot run
    # should be an immediate, readable 400 — not a job that queues, starts, and
    # dies in a worker where the message is buried in a log.
    engine = _engine_or_400(req.engine)
    probe = engine.probe()
    if not probe.get("available"):
        raise HTTPException(
            status_code=400,
            detail=f"{engine.name} is not available: "
                   f"{probe.get('reason') or 'unknown reason'}")
    try:
        analysis = engine.get(req.analysis_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if len(req.groups) < analysis.n_groups:
        raise HTTPException(status_code=400,
                            detail=f"{analysis.name} needs {analysis.n_groups} group(s)")

    job_ids = []
    for cid in req.condition_ids:
        if cid not in state.conditions:
            continue
        cond = state.conditions[cid]
        label = f"{analysis.name} — {cond.name}"
        if req.engine != DEFAULT_ENGINE:
            label += f" [{engine.name}]"
        if req.time_start is not None or req.time_end is not None:
            label += f" ({req.time_start or 0}-{req.time_end or 'end'} ns)"
        job = job_manager.submit(
            session_id=req.session_id,
            condition_id=cid,
            analysis_type=req.analysis_type,
            label=label,
            coro_factory=_make_run_coro(req, cid),
            params={"groups": req.groups},
        )
        job_ids.append(job.id)

    return {"ok": True, "job_ids": job_ids}


@router.delete("/cache/{session_id}")
def clear_cache(session_id: str):
    """Delete all cached analysis results for a session (forces fresh reruns)."""
    import shutil
    cache_dir = session_dir(session_id) / "cache"
    n = 0
    if cache_dir.exists():
        for f in cache_dir.glob("*.json"):
            f.unlink()
            n += 1
    # Also clear the analyses registry in state
    try:
        with locked_state(session_id) as state:
            state.analyses = {}
    except Exception:
        # Cache files are already gone; a stale registry is cosmetic but
        # confusing, so make the failure visible rather than silent.
        log.exception("Cleared cache but failed to clear the analyses registry")
    return {"ok": True, "cleared": n}


@router.post("/reset/{session_id}")
def reset_analyses(session_id: str):
    """
    Full clean slate: clear cached results, the analyses registry, AND the
    finished jobs for this session, so the Results/Compare views start empty.
    Does not touch registered files, conditions, or the gmx config.
    """
    import shutil
    from .jobs import job_manager
    n = 0
    cache_dir = session_dir(session_id) / "cache"
    if cache_dir.exists():
        for f in cache_dir.glob("*.json"):
            f.unlink()
            n += 1
    # Clear on-disk per-analysis result dirs too (optional tidy-up)
    results_dir = session_dir(session_id) / "results"
    if results_dir.exists():
        shutil.rmtree(results_dir, ignore_errors=True)
        results_dir.mkdir(exist_ok=True)
    try:
        with locked_state(session_id) as state:
            state.analyses = {}
    except Exception:
        log.exception("Reset removed results but failed to clear the registry")
    # Clear jobs (finished + any lingering) for this session
    job_manager.clear_all_for_session(session_id)
    return {"ok": True, "cleared_cache": n}


@router.get("/list/{session_id}")
def list_named_analyses(session_id: str):
    """
    Managed list of named analysis instances for this session, each with type,
    name, condition, colour, and cache key — for the Analyses list UI
    (show/hide/delete), independent of the raw job log.
    """
    try:
        state = load_state(session_id)
    except Exception:
        return {"analyses": []}
    out = []
    for key, a in (state.analyses or {}).items():
        out.append({
            "cache_key": a.get("cache_key", key),
            "type": a.get("type"),
            "name": a.get("name", ""),
            "condition_id": a.get("condition_id"),
            "condition_name": a.get("condition_name", a.get("condition_id")),
            "colour": a.get("colour"),
            "folder": a.get("folder"),
        })
    return {"analyses": out}


@router.delete("/instance/{session_id}/{cache_key}")
def delete_named_analysis(session_id: str, cache_key: str):
    """Delete a single named analysis: cached result, registry entry, and folder."""
    import shutil
    cache_file = session_dir(session_id) / "cache" / f"{cache_key}.json"
    if cache_file.exists():
        cache_file.unlink()
    try:
        with locked_state(session_id) as state:
            entry = (state.analyses or {}).get(cache_key)
            if entry and entry.get("folder"):
                folder = session_dir(session_id) / "results" / entry["folder"]
                if folder.exists():
                    shutil.rmtree(folder, ignore_errors=True)
            if cache_key in (state.analyses or {}):
                del state.analyses[cache_key]
    except Exception:
        # Best-effort: the cached result file is already gone, so the analysis
        # is functionally deleted. Log rather than swallow — a failure here
        # leaves a stale registry entry, which is worth being able to diagnose.
        log.exception("Failed to remove analysis %s from the registry", cache_key)
    return {"ok": True, "deleted": cache_key}


@router.get("/result/{session_id}/{cache_key}")
def get_stored_result(session_id: str, cache_key: str):
    """
    Fetch a stored analysis result by cache key. This lets the Results/Compare
    tabs load previously-computed analyses directly from disk, independent of
    the transient jobs list — so clearing the Jobs panel no longer hides plots.
    """
    res = get_cached_result(session_id, cache_key)
    if res is None:
        raise HTTPException(status_code=404, detail="Result not cached")
    return res


@router.get("/results/{session_id}")
def get_all_stored_results(session_id: str):
    """
    Fetch every registered analysis result for this session, in one call.

    IMPORTANT: heatmap matrices are stripped from this bulk response — a single
    480x480 matrix is megabytes, and a project with several of them made this
    endpoint (which the Results tab calls on every load) crawl. The UI fetches a
    matrix on demand via /result/{session_id}/{cache_key} instead.
    """
    try:
        state = load_state(session_id)
    except Exception:
        return {"results": []}
    out = []
    for key, a in (state.analyses or {}).items():
        ck = a.get("cache_key", key)
        res = get_cached_result(session_id, ck)
        if res is None:
            continue
        if res.get("kind") in ("heatmap", "xcorr") and "z" in res:
            # Send metadata only; the matrix is fetched separately when shown.
            # xcorr counts: a 500-residue by 81-lag map is another 40,000 cells
            # in a response the Results tab loads on every visit.
            res = {k: v for k, v in res.items() if k != "z"}
            res["z_deferred"] = True
        out.append({
            "cache_key": ck,
            "type": a.get("type"),
            # Results predating the engine picker have no engine recorded, and
            # they were all GROMACS.
            "engine": a.get("engine", "gromacs"),
            "name": a.get("name", ""),
            "condition_id": a.get("condition_id"),
            "condition_name": a.get("condition_name", a.get("condition_id")),
            "colour": a.get("colour"),
            "hidden": bool(a.get("hidden", False)),
            "result": res,
        })
    return {"results": out}


class VisibilityRequest(BaseModel):
    session_id: str
    cache_key: str
    hidden: bool


@router.post("/visibility")
def set_visibility(req: VisibilityRequest):
    """Show/hide a stored analysis. Persists in the session, so visibility
    survives restarts and clearing the Jobs panel."""
    with locked_state(req.session_id) as state:
        entry = (state.analyses or {}).get(req.cache_key)
        if not entry:
            raise HTTPException(status_code=404, detail="Analysis not found")
        entry["hidden"] = req.hidden
        state.analyses[req.cache_key] = entry
    return {"ok": True, "cache_key": req.cache_key, "hidden": req.hidden}

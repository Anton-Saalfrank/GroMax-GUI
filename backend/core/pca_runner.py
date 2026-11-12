"""
Shared-basis PCA runner.

Faithful to the standard essential-dynamics comparison workflow:
  1. Build a reference structure (selected atoms, frame 0 of first replica).
  2. Per replica: trjconv with that replica's frame window/stride + selection
     -> a reduced, trimmed trajectory.
  3. trjcat -cat all reduced replicas from all conditions -> one pooled traj.
  4. One gmx covar on the pool -> shared eigenvectors + eigenvalues.
  5. gmx anaeig -proj -2d onto the shared basis, per condition or per replica.

All projected trajectories use the SAME trimmed frames that built the basis.
An atom-count guardrail runs before the pipeline: the selection must resolve
to an identical atom count in every replica across every condition, otherwise
a shared covariance matrix is not well-defined.
"""

import logging
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.gmx import (run_gmx, parse_xvg, count_frames, count_selection_atoms,
                      parse_gmx_groups)
from core.session import load_state, save_state, session_dir, locked_state
from core.jobs import job_manager

log = logging.getLogger("gromax.pca")

router = APIRouter()


# ─── Selection helpers ────────────────────────────────────────────────────────

BASE_SELECTIONS = {
    # make_ndx accepts standard group names in quotes, e.g. "Backbone", and
    # intersects them with residues via '& ri ...'. Verified on GROMACS 2024.2:
    #   "Backbone" & ri 200-270  ->  213 atoms (71 res x 3)
    # NB: make_ndx's interactive parser does NOT support parentheses, so we must
    # NOT wrap the base in ( ). We build a flat 'BASE & ri ... & ! ri ...' string.
    "C-alpha":   '"C-alpha"',
    "Backbone":  '"Backbone"',
    "Sidechain": '"SideChain"',
    "Protein":   '"Protein"',
}


def build_selection_string(base: str, include_residues: str = "", exclude_residues: str = "") -> str:
    """
    Compose a make_ndx selection from a base group and optional residue ranges.

    Uses make_ndx's quoted-group-name syntax for the base (e.g. "Backbone"),
    combined with residue-index terms. No parentheses (make_ndx's interactive
    parser rejects them). Verified working forms on GROMACS 2024.2:
        "Backbone" & ri 200-270            -> intersect
        "C-alpha" & ri 200-270 & ! ri 269  -> intersect then subtract
    """
    sel = BASE_SELECTIONS.get(base, base)  # allow raw custom base primitive

    inc = include_residues.strip()
    if inc:
        inc = " ".join(inc.replace(",", " ").split())
        sel = f"{sel} & ri {inc}"

    ex = exclude_residues.strip()
    if ex:
        ex = " ".join(ex.replace(",", " ").split())
        sel = f"{sel} & ! ri {ex}"

    return sel



# ─── Request models ───────────────────────────────────────────────────────────

class ReplicaFrameSpec(BaseModel):
    condition_id: str
    replica_index: int
    tpr: str
    xtc: str
    start_ns: Optional[float] = None
    end_ns: Optional[float] = None
    stride: int = 1


class PCACheckRequest(BaseModel):
    session_id: str
    condition_ids: list[str]
    base_selection: str = "C-alpha"
    include_residues: str = ""
    exclude_residues: str = ""


class PCARunRequest(BaseModel):
    session_id: str
    condition_ids: list[str]
    base_selection: str = "C-alpha"
    include_residues: str = ""
    exclude_residues: str = ""
    projection: str = "per_condition"     # 'per_condition' | 'per_replica'
    replicas: list[ReplicaFrameSpec] = []  # per-replica frame specs
    n_components: int = 2
    pca_name: str = ""                     # user label; auto-generated if blank


# ─── Introspection endpoints (for the setup UI) ───────────────────────────────

@router.post("/scan-frames")
async def scan_frames(req: PCACheckRequest):
    """
    Return per-replica frame counts + timing for all selected conditions,
    so the UI can show lengths and help equalise them.
    """
    state = load_state(req.session_id)
    out = []
    for cid in req.condition_ids:
        cond = state.conditions.get(cid)
        if not cond:
            continue
        reps = [r for r in cond.replicas if r.get("paired")]
        for r in reps:
            info = await count_frames(r["tpr"], r["xtc"])
            out.append({
                "condition_id": cid,
                "condition_name": cond.name,
                "colour": cond.colour,
                "replica_index": r["index"],
                "tpr": r["tpr"],
                "xtc": r["xtc"],
                "n_frames": info["n_frames"],
                "t_end_ps": info["t_end_ps"],
                "dt_ps": info["dt_ps"],
            })
    return {"replicas": out}


@router.post("/check-selection")
async def check_selection(req: PCACheckRequest):
    """
    Resolve the covariance selection in every replica across every condition
    and verify the atom count matches. Also auto-detect residues that differ
    between conditions (by residue name) to suggest an exclusion.
    """
    state = load_state(req.session_id)
    selection = build_selection_string(req.base_selection, req.include_residues, req.exclude_residues)

    counts = []
    work = session_dir(req.session_id) / "pca" / "_check"
    for cid in req.condition_ids:
        cond = state.conditions.get(cid)
        if not cond:
            continue
        for r in [x for x in cond.replicas if x.get("paired")]:
            res = await count_selection_atoms(r["tpr"], selection, work)
            counts.append({
                "condition_id": cid, "condition_name": cond.name,
                "replica_index": r["index"],
                "n_atoms": res["n_atoms"], "ok": res["ok"], "error": res["error"],
            })

    atom_counts = {c["n_atoms"] for c in counts if c["n_atoms"] is not None}
    consistent = len(atom_counts) == 1 and all(c["ok"] for c in counts)

    # Auto-detect differing residues across conditions
    suggested_exclusions = await _detect_differing_residues(state, req.condition_ids,
                                                            session_dir(req.session_id))

    return {
        "selection": selection,
        "consistent": consistent,
        "atom_counts": sorted(atom_counts),
        "per_replica": counts,
        "suggested_exclusions": suggested_exclusions,
    }


async def _detect_differing_residues(state, condition_ids, sdir) -> list[int]:
    """
    Compare residue names across conditions' first replicas to find positions
    that differ (e.g. mutation sites). Returns a list of residue indices.
    """
    seqs = {}
    for cid in condition_ids:
        cond = state.conditions.get(cid)
        if not cond:
            continue
        reps = [x for x in cond.replicas if x.get("paired")]
        if not reps:
            continue
        tpr = reps[0]["tpr"]
        seq = await _get_residue_sequence(tpr, sdir / "pca" / "_seq")
        if seq:
            seqs[cid] = seq

    if len(seqs) < 2:
        return []

    # Compare position by position across conditions
    ref = next(iter(seqs.values()))
    differing = []
    for cid, seq in seqs.items():
        for i, (a, b) in enumerate(zip(ref, seq), start=1):
            if a != b and i not in differing:
                differing.append(i)
    return sorted(differing)


async def _get_residue_sequence(tpr: str, work: Path) -> list[str]:
    """Extract residue name sequence from a tpr via a dumped pdb."""
    work.mkdir(parents=True, exist_ok=True)
    pdb = work / "seq.pdb"
    # dump frame 0 as pdb; needs a trajectory, but tpr alone works with editconf
    res = await run_gmx(["editconf", "-f", tpr, "-o", str(pdb)], timeout=120)
    if not pdb.exists():
        return []
    seen = {}
    for ln in pdb.read_text().splitlines():
        if ln.startswith(("ATOM", "HETATM")):
            try:
                resname = ln[17:20].strip()
                resid = int(ln[22:26])
                seen.setdefault(resid, resname)
            except (ValueError, IndexError):
                continue
    return [seen[k] for k in sorted(seen)]


# ─── The PCA pipeline (runs as a single job) ──────────────────────────────────

def _make_pca_coro(req: PCARunRequest):

    async def coro(progress_cb, log_cb):
        state = load_state(req.session_id)
        selection = build_selection_string(req.base_selection, req.include_residues, req.exclude_residues)
        pca_dir = session_dir(req.session_id) / "pca" / "run"
        pca_dir.mkdir(parents=True, exist_ok=True)

        specs = req.replicas
        if not specs:
            # Build default specs (full trajectories) from state
            specs = []
            for cid in req.condition_ids:
                cond = state.conditions.get(cid)
                if not cond:
                    continue
                for r in [x for x in cond.replicas if x.get("paired")]:
                    specs.append(ReplicaFrameSpec(
                        condition_id=cid, replica_index=r["index"],
                        tpr=r["tpr"], xtc=r["xtc"]))

        # ── Guardrail: verify atom-count consistency ──────────────────────────
        log_cb("Checking selection atom-count consistency…")
        counts = set()
        for s in specs:
            res = await count_selection_atoms(s.tpr, selection, pca_dir / "_check")
            if not res["ok"]:
                raise RuntimeError(f"Selection failed on {s.condition_id} rep{s.replica_index}: {res['error']}")
            counts.add(res["n_atoms"])
        if len(counts) != 1:
            raise RuntimeError(
                f"Selection '{selection}' resolves to different atom counts across "
                f"replicas ({sorted(counts)}). A shared basis needs identical atoms. "
                f"Exclude the differing residue(s) (e.g. mutation sites)."
            )
        n_sel_atoms = counts.pop()
        log_cb(f"Selection OK — {n_sel_atoms} atoms in every replica.")
        progress_cb(5)

        # ── Build the index group once per unique tpr ─────────────────────────
        async def make_sel_ndx(tpr: str, tag: str) -> str:
            # Build an ndx that contains the standard groups plus our named
            # selection group GROMAX_SEL, without guessing group indices.
            from core.gmx import _last_group_in_ndx
            base = pca_dir / f"base_{tag}.ndx"
            await run_gmx(["make_ndx", "-f", tpr, "-o", str(base)],
                          stdin_input="q\n", timeout=120)
            base_txt = base.read_text() if base.exists() else ""

            tmp = pca_dir / f"tmp_{tag}.ndx"
            if tmp.exists():
                tmp.unlink()
            r = await run_gmx(["make_ndx", "-f", tpr, "-o", str(tmp)],
                              stdin_input=f"{selection}\nq\n", timeout=120)
            if not tmp.exists():
                raise RuntimeError(f"make_ndx failed for selection '{selection}'.\n{r['stderr'][-400:]}")
            last = _last_group_in_ndx(tmp)
            if last is None or last[1] == 0:
                raise RuntimeError(
                    f"Selection '{selection}' matched 0 atoms. Check residue "
                    f"numbering (ri is 1-based internal index).")
            # Append the selection group under a stable name to the base ndx.
            lines = tmp.read_text().splitlines()
            last_hdr = max(i for i, l in enumerate(lines) if l.strip().startswith("["))
            body = "\n".join(l for l in lines[last_hdr + 1:] if l.strip())
            ndx = pca_dir / f"sel_{tag}.ndx"
            ndx.write_text(base_txt + f"\n[ GROMAX_SEL ]\n{body}\n")
            return str(ndx)

        # ── Reference structure: selection, frame 0 of the first spec ─────────
        log_cb("Building reference structure (frame 0)…")
        first = specs[0]
        ref_ndx = await make_sel_ndx(first.tpr, "ref")
        ref_pdb = pca_dir / "pca_ref.pdb"
        r = await run_gmx(
            ["trjconv", "-f", first.xtc, "-s", first.tpr, "-n", ref_ndx,
             "-o", str(ref_pdb), "-dump", "0"],
            stdin_input="GROMAX_SEL\n", timeout=600)
        if not ref_pdb.exists():
            raise RuntimeError(f"Failed to build reference PDB.\n{r['stderr'][-400:]}")
        progress_cb(10)

        # ── Per replica: trjconv with window/stride + selection ───────────────
        reduced = {}   # (cid) -> list of reduced xtc paths, in order
        total = len(specs)
        # Track how many frames each replica contributes, per condition, in order
        # — so the per-condition PCA cloud can be colour-segmented by replica
        # without recomputing a per-replica PCA.
        rep_frame_counts = {}   # cid -> [{"index":ri, "n_frames":n}, ...]
        for i, s in enumerate(specs):
            log_cb(f"Trimming {s.condition_id} rep{s.replica_index} "
                   f"({i+1}/{total})…")
            sel_ndx = await make_sel_ndx(s.tpr, f"{s.condition_id}_{s.replica_index}")
            out_xtc = pca_dir / f"reduced_{s.condition_id}_{s.replica_index}.xtc"
            args = ["trjconv", "-f", s.xtc, "-s", s.tpr, "-n", sel_ndx,
                    "-o", str(out_xtc)]
            if s.start_ns is not None:
                args += ["-b", str(s.start_ns * 1000)]
            if s.end_ns is not None:
                args += ["-e", str(s.end_ns * 1000)]
            if s.stride and s.stride > 1:
                # -skip keeps every Nth frame
                args += ["-skip", str(s.stride)]
            rr = await run_gmx(args, stdin_input="GROMAX_SEL\n", cwd=pca_dir, timeout=1800)
            if not out_xtc.exists():
                raise RuntimeError(f"trjconv failed for {s.condition_id} rep{s.replica_index}.\n{rr['stderr'][-400:]}")
            reduced.setdefault(s.condition_id, []).append(str(out_xtc))
            # Count frames in the trimmed trajectory.
            #
            # The start time and timestep are recorded alongside, because they
            # are what turns a clicked point back into a moment in the original
            # trajectory: point i of this replica's cloud is frame i of THIS
            # file, at t_start + i*dt. Measured on the trimmed file rather than
            # derived from -b/-skip, so it stays right whether or not trjconv
            # landed exactly on the requested start. Deliberately not taken from
            # the concatenated trajectory further down — trjcat -cat is free to
            # renumber times, and a frame dumped at the wrong time would look
            # entirely plausible.
            fi = await count_frames(s.tpr, str(out_xtc))
            rep_frame_counts.setdefault(s.condition_id, []).append({
                "index": s.replica_index, "n_frames": fi.get("n_frames"),
                "t_start_ps": fi.get("t_start_ps"), "dt_ps": fi.get("dt_ps"),
                "tpr": s.tpr, "xtc": s.xtc,
            })
            progress_cb(10 + int((i + 1) / total * 35))

        # ── Concatenate per condition, then pool all ──────────────────────────
        log_cb("Concatenating trajectories…")
        per_cond_cat = {}
        for cid, xtcs in reduced.items():
            cat = pca_dir / f"cat_{cid}.xtc"
            await run_gmx(["trjcat", "-f", *xtcs, "-o", str(cat), "-cat"],
                          cwd=pca_dir, timeout=1800)
            per_cond_cat[cid] = str(cat)

        pooled = pca_dir / "all_cat.xtc"
        await run_gmx(["trjcat", "-f", *per_cond_cat.values(), "-o", str(pooled), "-cat"],
                      cwd=pca_dir, timeout=1800)
        progress_cb(55)

        # ── Build shared basis: one covar on the pool ─────────────────────────
        log_cb("Building shared covariance matrix (gmx covar)…")
        eigval = pca_dir / "eigenval.xvg"
        eigvec = pca_dir / "eigenvec.trr"
        r = await run_gmx(
            ["covar", "-f", str(pooled), "-s", str(ref_pdb),
             "-o", str(eigval), "-v", str(eigvec), "-l", str(pca_dir / "covar.log")],
            stdin_input="System\nSystem\n", cwd=pca_dir, timeout=7200)
        if not eigvec.exists():
            raise RuntimeError(f"gmx covar failed.\n{r['stderr'][-600:]}")
        progress_cb(70)

        # Variance explained
        ev = parse_xvg(eigval)
        eigvals = ev["y_series"][0] if ev["y_series"] else []
        total_var = sum(eigvals) or 1.0
        var_explained = [v / total_var * 100 for v in eigvals[:10]]

        # ── Project onto shared basis ─────────────────────────────────────────
        log_cb("Projecting onto shared basis (gmx anaeig)…")
        clouds = []
        extremes = []   # per-condition extreme structure files

        async def project(label, colour, traj, tag, make_extremes=False):
            proj2d = pca_dir / f"proj2d_{tag}.xvg"
            args = ["anaeig", "-f", traj, "-s", str(ref_pdb), "-v", str(eigvec),
                    "-eig", str(eigval), "-2d", str(proj2d),
                    "-first", "1", "-last", "2"]
            # Generate extreme structures along PC1 and PC2 for this input.
            extr_files = {}
            if make_extremes:
                extr_pdb = pca_dir / f"extreme_{tag}.pdb"
                args += ["-extr", str(extr_pdb), "-nframes", "30"]
                extr_files["pc1_2"] = str(extr_pdb)
            await run_gmx(args, stdin_input="System\nSystem\n", cwd=pca_dir, timeout=3600)
            cloud = None
            if proj2d.exists():
                d = parse_xvg(proj2d)
                cloud = {"label": label, "colour": colour,
                         "x": d["x"], "y": d["y_series"][0] if d["y_series"] else []}
            return cloud, extr_files

        if req.projection == "per_replica":
            for s in specs:
                cond = state.conditions[s.condition_id]
                traj = pca_dir / f"reduced_{s.condition_id}_{s.replica_index}.xtc"
                c, _ = await project(f"{cond.name} rep{s.replica_index}", cond.colour,
                                     str(traj), f"{s.condition_id}_{s.replica_index}")
                if c:
                    # Same shape as the per-condition clouds — one segment —
                    # so the frontend has a single way to turn a clicked point
                    # into (replica, time) regardless of projection.
                    seg = next((r for r in rep_frame_counts.get(s.condition_id, [])
                                if r["index"] == s.replica_index), None)
                    c["condition_id"] = s.condition_id
                    c["condition_name"] = cond.name
                    c["replica_segments"] = [dict(seg)] if seg else []
                    clouds.append(c)

        # Always also produce per-condition extremes (on the concatenated
        # per-condition trajectory), regardless of projection granularity —
        # these are the "what does the motion look like" structures.
        for cid, cat in per_cond_cat.items():
            cond = state.conditions[cid]
            c, extr = await project(cond.name, cond.colour, cat, cid, make_extremes=True)
            if req.projection == "per_condition" and c:
                # Attach the per-replica frame-count breakdown so the frontend
                # can colour this single cloud by replica (points are in order).
                c["replica_segments"] = rep_frame_counts.get(cid, [])
                c["condition_id"] = cid
                c["condition_name"] = cond.name
                clouds.append(c)
            if extr.get("pc1_2"):
                extremes.append({
                    "condition_id": cid,
                    "condition_name": cond.name,
                    "colour": cond.colour,
                    "path": extr["pc1_2"],
                    "filename": Path(extr["pc1_2"]).name,
                })

        progress_cb(95)

        # Resolve the PCA name (auto-generate if blank)
        import re as _re
        pca_name = _re.sub(r'[^A-Za-z0-9_\-]', '', req.pca_name.strip().replace(' ', '-')) \
            if req.pca_name.strip() else f"{req.base_selection}_{req.projection}"

        result = {
            "kind": "pca",
            "clouds": clouds,
            "var_explained": var_explained,
            "xlabel": "PC1 (nm)",
            "ylabel": "PC2 (nm)",
            "title": f"PCA: {pca_name}",
            "analysis_name": pca_name,
            "n_atoms": n_sel_atoms,
            "selection": selection,
            "analysis_type": "pca",
            "projection": req.projection,
            "extremes": extremes,
            "pca_dir": str(pca_dir),
        }
        # Persist a copy
        import json
        (pca_dir / "result.json").write_text(json.dumps(result))

        # Cache + register so the result persists in the analyses registry and
        # can be reloaded independently of the transient jobs list.
        try:
            from .gmx import save_cached_result
            cache_key = f"pca_{pca_name}"
            save_cached_result(req.session_id, cache_key, result)
            with locked_state(req.session_id) as st:
                first_cid = req.condition_ids[0]
                st.analyses[cache_key] = {
                    "type": "pca", "name": pca_name,
                    "condition_id": first_cid,
                    "condition_name": st.conditions[first_cid].name if first_cid in st.conditions else first_cid,
                    "colour": st.conditions[first_cid].colour if first_cid in st.conditions else "#4f8ef7",
                    "cache_key": cache_key,
                    "folder": f"pca/{pca_name}",
                }
        except Exception:
            # Computed and cached, but unregistered results never show up in
            # Results — make that visible instead of failing silently.
            log.exception("PCA finished but could not be registered")
            log_cb("WARNING: PCA computed but could not be registered — "
                   "it may not appear in the Results tab.")

        progress_cb(100)
        return result

    return coro




@router.post("/run")
def run_pca(req: PCARunRequest):
    state = load_state(req.session_id)
    for cid in req.condition_ids:
        if cid not in state.conditions:
            raise HTTPException(status_code=404, detail=f"Condition {cid} not found")

    import re as _re
    pca_name = _re.sub(r'[^A-Za-z0-9_\-]', '', req.pca_name.strip().replace(' ', '-')) \
        if req.pca_name.strip() else f"{req.base_selection}_{req.projection}"

    label = f"PCA: {pca_name} — {len(req.condition_ids)} condition(s)"
    # PCA is multi-condition: submit ONE job, attributed to the first condition
    job = job_manager.submit(
        session_id=req.session_id,
        condition_id=req.condition_ids[0],
        analysis_type="pca",
        label=label,
        coro_factory=_make_pca_coro(req),
        params={"projection": req.projection, "name": pca_name},
    )
    return {"ok": True, "job_id": job.id}

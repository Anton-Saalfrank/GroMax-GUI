"""
Residue-contact query.

"Which residues contact a residue of interest across the trajectory?"

Uses gmx select with a dynamic distance selection evaluated per frame:
    resname_within = "same residue as (within CUTOFF of group TARGET)"
and reports, per residue, the fraction of frames it is within CUTOFF of the
target residue (occupancy). Results are mapped back to biological
(chain, resnum, resname) via the system definition when available.

An optional hydrogen-bond mode additionally requires donor–H···acceptor
geometry; this is harder and version-dependent, so it's offered but flagged
as needing verification against the user's gmx build.
"""

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .session import load_state, save_state, session_dir, locked_state
from .gmx import run_gmx, get_gmx_executable
from .jobs import job_manager

log = logging.getLogger("gromax.contacts")

router = APIRouter()


class ContactQueryRequest(BaseModel):
    session_id: str
    condition_ids: list[str]
    target_selection: str          # e.g. 'resid 629' (flat) or a chain-mapped ri
    cutoff_nm: float = 0.4
    mode: str = "distance"         # 'distance' | 'hbond'
    name: str = ""
    # Optional frame filter: restrict the contact tally to frames where a
    # previously-computed per-frame metric passes a threshold.
    filter_name: str = ""          # analysis_name of the filter metric (line result)
    filter_op: str = ">"           # '>' | '<' | '>=' | '<='
    filter_threshold: Optional[float] = None


def _passing_times_by_replica(session_id: str, filter_name: str, condition_id: str,
                              op: str, threshold: float) -> Optional[dict]:
    """
    Find the completed line analysis named `filter_name` for `condition_id`,
    and return per replica index the SET of frame-times (ns, rounded) where the
    metric passes the threshold. Used to frame-filter the contact query.

    Returns None if no matching analysis is found.
    """
    from .gmx import get_cached_result
    state = load_state(session_id)
    # find the registered analysis with this name for this condition
    cache_key = None
    for key, a in (state.analyses or {}).items():
        if a.get("name") == filter_name and a.get("condition_id") == condition_id:
            cache_key = a.get("cache_key", key)
            break
    if not cache_key:
        return None
    try:
        res = get_cached_result(session_id, cache_key)
    except Exception:
        res = None
    if not res or not res.get("replicas"):
        return None

    def passes(v):
        return (v > threshold if op == ">" else v < threshold if op == "<"
                else v >= threshold if op == ">=" else v <= threshold)

    out = {}
    for rep in res["replicas"]:
        idx = rep.get("index")
        xs, ys = rep.get("x", []), rep.get("y", [])
        times = {round(float(x), 3) for x, y in zip(xs, ys) if passes(y)}
        out[idx] = times
    return out


def _is_full_selection(t: str) -> bool:
    """
    True if the target already looks like a full gmx selection expression
    (rather than a bare residue number or simple 'ri N'). Such expressions are
    passed through untouched so users can select specific atoms, e.g.
        resindex 210 and name OD1 OD2
        resindex 210 and not name N CA C O
    """
    import re
    lowered = f" {t.strip().lower()} "
    keywords = (" and ", " or ", " not ", " name ", " type ", " within ",
                " same ", " atomnr ", " chain ", "(", ")")
    return any(k in lowered for k in keywords)


def _normalize_target(target: str) -> str:
    """
    Normalise a target selection for gmx select / gmx hbond.

    - A FULL selection expression is passed through unchanged, so atom-level
      targets work (e.g. 'resindex 210 and name OD1 OD2').
    - A bare number, 'ri N', 'resid N' etc. is normalised to 'resindex N' —
      the 1-based residue index matching make_ndx's 'ri' (what the rest of the
      app uses).

    VERIFIED on GROMACS 2024.2: 'resindex 200' targets protein residue 200 when
    combined with the atom-index output; plain 'resid 200' points elsewhere.
    """
    import re
    t = target.strip()
    if _is_full_selection(t):
        return t
    # strip a leading keyword if present
    m = re.match(r'^(resid|resindex|ri|resnr|r)\s+(.+)$', t, re.IGNORECASE)
    nums = m.group(2) if m else t
    # normalise range separators: make_ndx uses '200-270', gmx select uses '200 to 270'
    nums = nums.strip()
    range_m = re.match(r'^(\d+)\s*-\s*(\d+)$', nums)
    if range_m:
        return f'resindex {range_m.group(1)} to {range_m.group(2)}'
    return f'resindex {nums}'


async def _protein_residue_count(tpr: str, work: Path) -> Optional[int]:
    """
    Read the number of protein residues from a tpr via make_ndx, which prints
    'There are:  N    Protein residues'. Used as the authoritative boundary to
    filter stray water/ion indices out of contact results.
    """
    import re
    try:
        r = await run_gmx(["make_ndx", "-f", tpr, "-o", str(work / "_count.ndx")],
                          stdin_input="q\n", cwd=work, timeout=120)
        text = (r.get("stdout", "") or "") + (r.get("stderr", "") or "")
        m = re.search(r"There are:\s*(\d+)\s+Protein residues", text)
        if m:
            return int(m.group(1))
    except Exception:
        # Optional: callers fall back gracefully when this returns None.
        log.debug("Could not determine protein residue count", exc_info=True)
    return None


def _hbond_reference_atoms(ndx_path: Path) -> set:
    """
    Read the reference residue's atom indices from a gmx hbond -o/-pf index file.
    The first section '[ <reference selection> ]' lists them (before the
    'donors_hydrogens_' / 'acceptors_' sections). We take the first section only.
    """
    atoms = set()
    in_first = False
    started = False
    for line in ndx_path.read_text().splitlines():
        s = line.strip()
        if s.startswith('['):
            if not started:
                # first section = reference
                in_first = True
                started = True
                continue
            else:
                # any subsequent section ends the reference block
                break
        if in_first and s:
            for tok in s.split():
                try:
                    atoms.add(int(tok))
                except ValueError:
                    pass
    return atoms


def _parse_hbond_pf(dat_path: Path, ref_atoms: set, atom_map: dict):
    """
    Parse a gmx hbond -pf index file. Each frame has a section
    '[ hbonds_..._frame_N ]' listing H-bonds as 'donor hydrogen acceptor' atom
    triplets. For each H-bond, the atom NOT belonging to the reference residue
    identifies the TARGET residue. Returns (total_frames, {flat_res: frames}).

    ref_atoms: set of atom indices belonging to the reference residue.
    atom_map:  {atom_serial -> flat_residue_index}.
    """
    import re
    total_frames = 0
    residue_frames: dict[int, int] = {}
    current_frame_active = False
    frame_residues = set()

    def flush():
        for flat in frame_residues:
            residue_frames[flat] = residue_frames.get(flat, 0) + 1

    for line in dat_path.read_text().splitlines():
        s = line.strip()
        m = re.match(r'\[\s*hbonds_.*_frame_(\d+)\s*\]', s)
        if m:
            # new frame section: flush previous, start fresh
            if current_frame_active:
                flush()
            current_frame_active = True
            total_frames += 1
            frame_residues = set()
            continue
        if s.startswith('['):
            # a non-hbond section ends any active frame
            if current_frame_active:
                flush()
                current_frame_active = False
                frame_residues = set()
            continue
        if current_frame_active and s:
            atoms = s.split()
            if len(atoms) == 3:
                try:
                    donor, hyd, acc = int(atoms[0]), int(atoms[1]), int(atoms[2])
                except ValueError:
                    continue
                # target atom = the donor or acceptor NOT in the reference
                target = None
                if acc in ref_atoms:
                    target = donor
                elif donor in ref_atoms:
                    target = acc
                if target is not None:
                    flat = atom_map.get(target)
                    if flat is not None:
                        frame_residues.add(flat)
    # flush the last frame
    if current_frame_active:
        flush()
    return total_frames, residue_frames


def _make_contact_coro(req: ContactQueryRequest, condition_id: str):

    async def coro(progress_cb, log_cb):
        state = load_state(req.session_id)
        cond = state.conditions.get(condition_id)
        if not cond:
            raise RuntimeError(f"Condition {condition_id} not found")
        reps = [r for r in cond.replicas if r.get("paired")]
        if not reps:
            raise RuntimeError("No paired replicas.")

        work = session_dir(req.session_id) / "results" / f"contacts_{req.name or 'q'}" / condition_id
        work.mkdir(parents=True, exist_ok=True)

        # Selection: protein residues within cutoff of the target, per frame.
        # VERIFIED numbering behaviour on GROMACS 2024.2:
        #  - target: 'resindex N' selects the Nth topology residue = make_ndx 'ri N'
        #    (verified: resindex 210 -> biological D620 on the multi-protein system).
        #  - OUTPUT: we use -oi with the DEFAULT seltype, which emits ATOM indices.
        #    We deliberately AVOID -seltype whole_res_com: it emits residue NUMBERS
        #    (e.g. 620), which are AMBIGUOUS on homodimers where both chains are
        #    numbered 400-800. Atom indices are globally unique, so mapping each
        #    contact atom -> flat residue (via atom_to_residue_map) disambiguates
        #    the chain correctly.
        cutoff = req.cutoff_nm
        target = _normalize_target(req.target_selection)
        # Exclude the target's WHOLE RESIDUE, not just the target atoms. This
        # matters for atom-specific targets (e.g. 'resindex 210 and name OD1 OD2'):
        # without it the rest of residue 210 would appear as its own contact.
        target_res = f'same residue as ({target})'
        sel = (f'group "Protein" and same residue as '
               f'(within {cutoff} of ({target})) '
               f'and not ({target_res})')

        # Build the atom -> flat-residue map and residue table from the tpr, so
        # contact atoms can be resolved to a unique residue + chain.
        from .system_map import atom_to_residue_map
        atom_map, tpr_residues = await atom_to_residue_map(reps[0]["tpr"], work)

        # Optional frame filter: load passing frame-times per replica
        filter_active = bool(req.filter_name and req.filter_threshold is not None)
        passing_by_rep = None
        if filter_active:
            passing_by_rep = _passing_times_by_replica(
                req.session_id, req.filter_name, condition_id,
                req.filter_op, req.filter_threshold)
            if passing_by_rep is None:
                log_cb(f"Filter '{req.filter_name}' not found for this condition — running unfiltered.")
                filter_active = False

        # For H-bond mode, build the target as an explicitly non-overlapping
        # selection: gmx hbond requires reference and target to be identical or
        # fully disjoint (verified: partial overlap -> assertion error). So the
        # target excludes the reference residue.
        hbond_mode = (req.mode == "hbond")
        hb_cutoff = max(cutoff, 0.35)   # gmx hbond min/recommended cutoff is 0.35
        # Exclude the reference's whole residue so -r and -t are non-overlapping
        # (gmx hbond asserts on partial overlap) and so an atom-specific
        # reference doesn't H-bond with the rest of its own residue.
        hb_target = f'group "Protein" and not ({target_res})'

        # Per-replica occupancy: for each replica, count frames-in-contact per
        # residue and that replica's total frames (after filtering).
        per_rep = []

        for i, rep in enumerate(reps):
            log_cb(f"Replica {rep['index']} ({i+1}/{len(reps)})…")

            if hbond_mode:
                # ── Hydrogen-bond mode: gmx hbond -pf ─────────────────────────
                hb_ndx = work / f"hbond_rep{rep['index']}.ndx"
                args = ["hbond", "-s", rep["tpr"], "-f", rep["xtc"],
                        "-r", target, "-t", hb_target,
                        "-o", str(hb_ndx), "-pf", "-cutoff", str(hb_cutoff)]
                r = await run_gmx(args, cwd=work, timeout=3600)
                if not hb_ndx.exists():
                    raise RuntimeError(
                        f"gmx hbond failed for rep{rep['index']}.\n"
                        f"Command: {r['cmd']}\nstderr: {r['stderr'][-600:]}")
                # The reference residue's atoms are listed in the first section
                # '[ <target-selection> ]'; read them to identify target atoms.
                ref_atoms = _hbond_reference_atoms(hb_ndx)
                tf, rf = _parse_hbond_pf(hb_ndx, ref_atoms, atom_map)
                per_rep.append({"index": rep["index"], "total_frames": tf,
                                "residue_frames": rf})
                progress_cb(int((i+1)/len(reps)*90))
                continue

            # ── Distance mode: gmx select ─────────────────────────────────────
            oi = work / f"contacts_rep{rep['index']}.dat"
            args = ["select", "-s", rep["tpr"], "-f", rep["xtc"],
                    "-select", sel, "-oi", str(oi)]
            r = await run_gmx(args, cwd=work, timeout=3600)
            if not oi.exists():
                raise RuntimeError(
                    f"gmx select failed for rep{rep['index']}.\n"
                    f"Command: {r['cmd']}\nstderr: {r['stderr'][-600:]}")
            # This replica's passing time-set (ns), if filtering
            rep_pass = passing_by_rep.get(rep["index"]) if (filter_active and passing_by_rep) else None
            rep_frames = 0
            rep_residue_frames: dict[int, int] = {}
            for line in oi.read_text().splitlines():
                s = line.strip()
                if s.startswith("\\"):
                    s = s[1:].strip()
                if s.startswith(("#", "@")) or not s:
                    continue
                parts = s.split()
                if len(parts) < 2:
                    continue
                # frame time: gmx writes ps; filter times are ns
                try:
                    t_ns = round(float(parts[0]) / 1000.0, 3)
                except ValueError:
                    t_ns = None
                # apply frame filter
                if rep_pass is not None:
                    if t_ns is None or t_ns not in rep_pass:
                        continue
                rep_frames += 1
                try:
                    n = int(parts[1])
                except ValueError:
                    continue
                residues_this_frame = set()
                for tok in parts[2:2+n]:
                    try:
                        atom = int(tok)
                    except ValueError:
                        continue
                    flat = atom_map.get(atom)
                    if flat is not None:
                        residues_this_frame.add(flat)
                for flat in residues_this_frame:
                    rep_residue_frames[flat] = rep_residue_frames.get(flat, 0) + 1
            per_rep.append({"index": rep["index"], "total_frames": rep_frames,
                            "residue_frames": rep_residue_frames})
            progress_cb(int((i+1)/len(reps)*90))

        # Residue identity table (tpr-derived, chain-disambiguated)
        resmap = {x["flat"]: x for x in tpr_residues}
        sd = state.system_definition
        if not resmap and sd and sd.residues:
            resmap = {x["flat"]: x for x in sd.residues}

        # Union of all residues seen in any replica
        all_flats = set()
        for pr in per_rep:
            all_flats.update(pr["residue_frames"].keys())

        # For each residue, compute per-replica occupancy, then mean + SD
        import math
        contacts = []
        for rid in all_flats:
            occs = []
            for pr in per_rep:
                tf = pr["total_frames"]
                occs.append(pr["residue_frames"].get(rid, 0) / tf if tf else 0.0)
            mean = sum(occs) / len(occs) if occs else 0.0
            # sample SD (n-1) across replicas
            if len(occs) > 1:
                var = sum((o - mean) ** 2 for o in occs) / (len(occs) - 1)
                sd_val = math.sqrt(var)
            else:
                sd_val = 0.0
            entry = {"resid_flat": rid, "occupancy": mean, "sd": sd_val,
                     "per_replica": occs}
            bio = resmap.get(rid)
            if bio:
                entry["chain"] = bio["chain"]
                entry["resnum"] = bio["resnum"]
                entry["resname"] = bio["resname"]
                entry["label"] = f'{bio["resname"]}{bio["resnum"]} ({bio["chain"]})'
            else:
                entry["label"] = f"res {rid}"
            contacts.append(entry)

        # Rank by mean occupancy, keep top 60
        contacts.sort(key=lambda c: -c["occupancy"])
        contacts = contacts[:60]

        # Auto-generate a distinctive name from the target if none given, so
        # multiple contact analyses coexist as separate results (like mindist/PCA).
        import re as _re
        auto = _re.sub(r'[^A-Za-z0-9_\-]', '', (req.target_selection or 'contacts').replace(' ', '-'))
        cname = _re.sub(r'[^A-Za-z0-9_\-]', '', req.name.strip().replace(' ', '-')) if req.name.strip() else auto

        progress_cb(100)
        result = {
            "kind": "contacts",
            "analysis_type": "contacts",
            "analysis_name": cname,
            "condition_id": condition_id,
            "condition_name": cond.name,
            "colour": cond.colour,
            "target": req.target_selection,
            "cutoff_nm": hb_cutoff if hbond_mode else cutoff,
            "mode": req.mode,
            "contacts": contacts,
            "n_replicas": len(per_rep),
            "total_frames": sum(pr["total_frames"] for pr in per_rep),
            "folder": f"contacts_{cname}",
            "frame_filtered": filter_active,
            "filter_desc": (f"{req.filter_op} {req.filter_threshold}"
                            if filter_active else ""),
        }

        # Register in the analyses list so it's selectable/deletable and multiple
        # contact runs don't collide. Cache the result so it persists and can be
        # reloaded independently of the transient jobs list.
        try:
            from .gmx import save_cached_result
            key = f"contacts_{cname}_{condition_id}"
            save_cached_result(req.session_id, key, result)
            with locked_state(req.session_id) as st:
                st.analyses[key] = {
                    "type": "contacts", "name": cname,
                    "condition_id": condition_id, "condition_name": cond.name,
                    "colour": cond.colour, "cache_key": key,
                    "folder": f"contacts_{cname}",
                }
        except Exception:
            # If registration fails the analysis is computed and cached but will
            # never appear in Results — a silent failure here looks to the user
            # like the job simply did nothing. Log it AND surface it in the job.
            log.exception("Contact query finished but could not be registered")
            log_cb("WARNING: results computed but could not be registered — "
                   "they may not appear in the Results tab.")

        return result

    return coro


@router.post("/run")
def run_contact_query(req: ContactQueryRequest):
    state = load_state(req.session_id)
    for cid in req.condition_ids:
        if cid not in state.conditions:
            raise HTTPException(status_code=404, detail=f"Condition {cid} not found")
    job_ids = []
    for cid in req.condition_ids:
        job = job_manager.submit(
            session_id=req.session_id, condition_id=cid,
            analysis_type="contacts",
            label=f"Contacts: {req.name or req.target_selection} — {state.conditions[cid].name}",
            coro_factory=_make_contact_coro(req, cid),
            params={"target": req.target_selection, "cutoff": req.cutoff_nm},
        )
        job_ids.append(job.id)
    return {"ok": True, "job_ids": job_ids}

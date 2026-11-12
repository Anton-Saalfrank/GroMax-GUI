"""
Analyses OF analyses: things computed from results already in the cache.

Split out of analysis_runner. These four endpoints — correlate a rolling RMSF
against a time series, export a result as CSV, compute a per-residue baseline
across conditions, summarise a matrix's distribution across replicas — share a
shape that nothing else in the runner has: they read cached results rather than
running anything, so they need no engine, no job queue and no index groups.

They keep their own APIRouter, which analysis_runner includes into its own.
That keeps every path under /api/analysis exactly where it was, so no frontend
call changes, while letting this file be read on its own.
"""
import logging
import re as _re
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .gmx import make_analysis_hash, get_cached_result, save_cached_result
from .session import load_state, locked_state

log = logging.getLogger("gromax.analysis")

router = APIRouter()


# ─── Correlating a rolling RMSF against another time series ───────────────────

class CorrelateRequest(BaseModel):
    session_id: str
    """Cache key of a residue-by-time map (a rolling RMSF)."""
    map_key: str
    """Cache key of the time series to correlate it against."""
    series_key: str
    max_lag_windows: int = 20
    method: str = "pearson"
    name: str = ""


@router.post("/correlate")
def correlate_results(req: CorrelateRequest):
    """
    Quantify what the overlay only shows by eye.

    Laying mindist over a rolling-RMSF map shows whether the two move together;
    this returns the coefficient, per residue and per time lag, so "the loop
    loosens when the contact breaks" gets a number and a lead time.

    Everything is computed PER REPLICA and then pooled, because correlating
    replica 5's flexibility against the mean of five mindist traces would be
    comparing a run against an average that includes four other runs.
    """
    from .correlate import (best_lag, correlation, cross_correlate, effective_n,
                            fisher_mean, p_value, window_means, MIN_PAIRS)

    # Called for its side effect, not its value: load_state raises 404 for an
    # unknown session, so this is the existence check. It reads as dead code
    # and linters flag it as such — deleting it would silently turn a missing
    # project into a confusing error further down.
    load_state(req.session_id)
    map_res = get_cached_result(req.session_id, req.map_key)
    ser_res = get_cached_result(req.session_id, req.series_key)
    if map_res is None or ser_res is None:
        raise HTTPException(status_code=404, detail="One of those results is no longer cached.")

    if not map_res.get("time_x") or not map_res.get("window_ns"):
        raise HTTPException(
            status_code=400,
            detail="The first result is not a residue-by-time map. This needs a "
                   "rolling RMSF, whose x-axis is time.")
    if ser_res.get("kind") != "line":
        raise HTTPException(
            status_code=400,
            detail=f"'{req.series_key}' is a {ser_res.get('kind')} result; this "
                   f"needs a time series such as mindist, RMSD or contacts.")

    window_ns = float(map_res["window_ns"])
    step_ns = float(map_res.get("step_ns") or window_ns)
    method = "spearman" if req.method == "spearman" else "pearson"
    max_lag = max(0, min(200, int(req.max_lag_windows)))
    warnings: list[str] = []

    # Which replicas both analyses actually have. A map replica the series does
    # not cover cannot be correlated with anything, and silently substituting
    # the mean would invent agreement.
    ser_reps = {int(p["index"]): p for p in (ser_res.get("replicas") or [])
                if p.get("index") is not None}
    map_reps = list(map_res.get("replica_indices") or [1])

    per_replica = []
    stacks = []          # one (n_residues, n_lags) array per replica
    agg_curves = []      # the mean-over-residues curve per replica
    n_windows_seen, n_eff_seen = [], []

    for ri in map_reps:
        block = map_res if (ri == map_reps[0] and map_res.get("z")) else \
            get_cached_result(req.session_id, f"{req.map_key}__rep{ri}")
        if not block or not block.get("z"):
            continue
        centres = block.get("x") or map_res.get("x") or []
        z = block["z"]
        if not centres or not z:
            continue

        rep = ser_reps.get(int(ri))
        if rep is None:
            warnings.append(
                f"'{ser_res.get('analysis_name') or req.series_key}' has no "
                f"replica {ri}, so that replica was left out rather than "
                f"correlated against the mean of the others.")
            continue

        windowed = window_means(rep.get("x") or ser_res.get("x") or [],
                                rep.get("y") or [], centres, window_ns)
        covered = sum(1 for v in windowed if v is not None)
        if covered < MIN_PAIRS:
            warnings.append(
                f"Replica {ri}: the two analyses overlap in only {covered} "
                f"windows, too few to correlate — check they cover the same "
                f"time range.")
            continue
        if covered < len(centres):
            warnings.append(
                f"Replica {ri}: {len(centres) - covered} of {len(centres)} "
                f"windows are outside the time range of "
                f"'{ser_res.get('analysis_name') or 'the series'}' and were skipped.")

        import numpy as np
        rows = []
        for row in z:
            lags, rs = cross_correlate(list(row), windowed, max_lag, method)
            rows.append([np.nan if v is None else v for v in rs])
        stacks.append(np.asarray(rows, dtype=np.float64))

        # The same thing for the map's mean profile, which is the headline
        # "does overall flexibility track this at all" number.
        mean_profile = [float(np.mean(col)) for col in zip(*z)]
        lags, agg = cross_correlate(mean_profile, windowed, max_lag, method)
        agg_curves.append([np.nan if v is None else v for v in agg])

        r0 = correlation(mean_profile, windowed, method)
        bl, br = best_lag(lags, agg)
        ne = effective_n(mean_profile, windowed)
        n_windows_seen.append(covered)
        n_eff_seen.append(ne)
        per_replica.append({
            "index": int(ri),
            "r0": r0,
            "p0": p_value(r0, ne),
            "best_lag_ns": None if bl is None else bl * step_ns,
            "best_r": br,
            "n_windows": covered,
            "n_eff": round(ne, 1),
        })

    if not stacks:
        raise HTTPException(
            status_code=400,
            detail="Nothing could be correlated. " + (warnings[0] if warnings else
                   "The two analyses share no replicas or no overlapping time range."))

    import numpy as np
    lags_ns = [t * step_ns for t in range(-max_lag, max_lag + 1)]

    # Pool with Fisher z, not a plain mean — coefficients are not additive.
    pooled = np.full(stacks[0].shape, np.nan)
    for i in range(stacks[0].shape[0]):
        for j in range(stacks[0].shape[1]):
            vals = [s[i, j] for s in stacks
                    if i < s.shape[0] and j < s.shape[1] and np.isfinite(s[i, j])]
            m = fisher_mean(vals)
            if m is not None:
                pooled[i, j] = m

    agg_pooled = []
    for j in range(len(lags_ns)):
        vals = [c[j] for c in agg_curves if j < len(c) and np.isfinite(c[j])]
        m = fisher_mean(vals)
        agg_pooled.append(None if m is None else round(m, 4))

    zero_i = max_lag
    agg_bl, agg_br = best_lag(list(range(-max_lag, max_lag + 1)), agg_pooled)
    n_eff_mean = float(np.mean(n_eff_seen)) if n_eff_seen else 0.0
    r0_pooled = agg_pooled[zero_i] if zero_i < len(agg_pooled) else None

    # The per-residue headline: correlation at zero lag, and the strongest lag.
    per_res_r0, per_res_best_r, per_res_best_lag = [], [], []
    for i in range(pooled.shape[0]):
        row = pooled[i]
        per_res_r0.append(None if not np.isfinite(row[zero_i]) else round(float(row[zero_i]), 4))
        bl, br = best_lag(list(range(-max_lag, max_lag + 1)),
                          [None if not np.isfinite(v) else float(v) for v in row])
        per_res_best_lag.append(None if bl is None else bl * step_ns)
        per_res_best_r.append(None if br is None else round(br, 4))

    overlap = max(0.0, 1.0 - step_ns / window_ns)
    n_win_mean = int(np.mean(n_windows_seen)) if n_windows_seen else 0
    # Phrased from what was MEASURED, not from the nominal overlap. The
    # effective count comes from the lag-1 autocorrelation of these two series,
    # so it drops a long way when both are smooth and stays near the window
    # count when one of them is not — saying "overlap of 90% means 10% of the
    # samples" would be a claim the arithmetic does not make.
    warnings.append(
        f"These {n_win_mean} windows carry about {n_eff_mean:.0f} independent "
        f"samples, estimated from how strongly the two series autocorrelate"
        + (f" (windows overlap by {overlap * 100:.0f}%, which is the usual "
           f"reason for the gap)" if overlap > 0 else "")
        + ". p-values use the effective count and are approximate.")
    warnings.append(
        "The strongest lag was found by searching, so its p-value is optimistic "
        "in a way the zero-lag one is not.")
    warnings.append(
        "The coefficient, p-value and sample counts describe the MEAN profile "
        "over the selected residues. A single residue in the map may be far more "
        "or less correlated than that, and more or less autocorrelated with it.")

    series_name = ser_res.get("analysis_name") or ser_res.get("analysis_type") or "series"
    map_name = map_res.get("analysis_name") or "rolling RMSF"
    result = {
        "kind": "xcorr",
        "z": [[None if not np.isfinite(v) else round(float(v), 4) for v in row]
              for row in pooled],
        "x": [round(v, 4) for v in lags_ns],
        "y": list(map_res.get("y") or range(1, pooled.shape[0] + 1)),
        "residues": map_res.get("residues"),
        "xlabel": f"Lag (ns) — positive: {series_name} leads",
        "ylabel": map_res.get("ylabel") or "Residue",
        "zlabel": f"{method} r",
        "title": f"{map_name} vs {series_name}",
        "diverging": True,
        "x_is_lag": True,
        "aggregate": {
            "lags_ns": [round(v, 4) for v in lags_ns],
            "r": agg_pooled,
            "r0": r0_pooled,
            "p0": p_value(r0_pooled, n_eff_mean),
            "best_lag_ns": None if agg_bl is None else agg_bl * step_ns,
            "best_r": agg_br,
            "p_best": p_value(agg_br, n_eff_mean),
        },
        "per_residue": {
            "r0": per_res_r0,
            "best_r": per_res_best_r,
            "best_lag_ns": per_res_best_lag,
        },
        "per_replica": per_replica,
        "method": method,
        "window_ns": window_ns,
        "step_ns": step_ns,
        "n_windows": int(np.mean(n_windows_seen)) if n_windows_seen else 0,
        "n_eff": round(n_eff_mean, 1),
        "series_name": series_name,
        "map_name": map_name,
        "condition_id": map_res.get("condition_id"),
        "condition_name": map_res.get("condition_name"),
        "colour": map_res.get("colour"),
        "warnings": warnings,
        "analysis_type": "xcorr",
    }

    name = (req.name or f"{map_name}-vs-{series_name}").strip()
    result["analysis_name"] = name
    cache_key = f"xcorr_{make_analysis_hash('xcorr', {'m': req.map_key, 's': req.series_key, 'l': max_lag, 'me': method})}"
    save_cached_result(req.session_id, cache_key, result)
    with locked_state(req.session_id) as st:
        st.analyses[cache_key] = {
            "type": "xcorr",
            "engine": "gromax",
            "name": name,
            "condition_id": map_res.get("condition_id"),
            "condition_name": map_res.get("condition_name"),
            "colour": map_res.get("colour"),
            "params": {"map": req.map_key, "series": req.series_key,
                       "max_lag_windows": max_lag, "method": method},
            "cache_key": cache_key,
        }
    result["cache_key"] = cache_key
    return result


# ─── Tabular export ───────────────────────────────────────────────────────────

class ExportCsvRequest(BaseModel):
    session_id: str
    cache_key: str
    """Omit for the aggregate; give a replica index for one run's own series."""
    replica: Optional[int] = None


@router.post("/export-csv")
def export_result_csv(req: ExportCsvRequest):
    """
    A stored result as CSV.

    NEW, not matching an existing convention — there wasn't one. GROMACS
    analyses leave .xvg files on disk only because gmx wrote them; the Python
    engines write nothing, and the UI had no download at all. So this is one
    endpoint that serves every line result, multi-channel or not, rather than a
    per-analysis file format.

    The header carries the units, because a column called "piston" is ambiguous
    between angstrom and nanometre and a CSV outlives the window it came from.
    """
    import csv
    import io

    result = get_cached_result(req.session_id, req.cache_key)
    if result is None:
        raise HTTPException(status_code=404, detail="That result is no longer cached.")
    if result.get("kind") != "line":
        raise HTTPException(
            status_code=400,
            detail=f"CSV export covers time-series results; this one is "
                   f"'{result.get('kind')}'.")

    block = result
    if req.replica is not None:
        reps = result.get("replicas") or []
        block = next((r for r in reps if r.get("index") == req.replica), None)
        if block is None:
            raise HTTPException(
                status_code=404,
                detail=f"Replica {req.replica} is not in this result "
                       f"(have: {[r.get('index') for r in reps]}).")

    x = block.get("x") or result.get("x") or []
    columns = [(result.get("xlabel") or "x", x)]

    channels = block.get("channels") or result.get("channels")
    if channels:
        for c in channels:
            name = f"{c.get('label', c.get('key'))}" + (
                f" ({c['unit']})" if c.get("unit") else "")
            columns.append((name, c.get("y") or []))
    else:
        columns.append((result.get("ylabel") or "y", block.get("y") or []))
        # The aggregate's mean and spread are part of the result, so they belong
        # in its export; a per-replica export has neither and gets neither.
        if req.replica is None and result.get("y_sd"):
            columns.append((f"{result.get('ylabel') or 'y'} SD", result["y_sd"]))

    n = max((len(v) for _, v in columns), default=0)
    buf = io.StringIO()
    w = csv.writer(buf)
    meta = result.get("helix_meta") or {}
    if meta:
        w.writerow([f"# {result.get('title', '')}"])
        for k in ("fit_selection", "axis_method", "ref_frame", "ref_time_ns", "units"):
            if k in meta:
                w.writerow([f"# {k}", meta[k]])
    w.writerow([name for name, _ in columns])
    for i in range(n):
        w.writerow(["" if i >= len(v) or v[i] is None else v[i] for _, v in columns])

    name = (result.get("analysis_name") or result.get("analysis_type") or "result")
    safe = _re.sub(r"[^A-Za-z0-9_.-]", "_", str(name))
    if req.replica is not None:
        safe = f"{safe}_rep{req.replica}"
    return {"filename": f"{safe}.csv", "csv": buf.getvalue(),
            "n_rows": n, "n_columns": len(columns)}


# ─── Per-residue baseline, across conditions ──────────────────────────────────

class RowBaselineRequest(BaseModel):
    session_id: str
    """One cache key per condition — every map that should share the baseline."""
    cache_keys: list[str]


def _row_stats(session_id: str, cache_key: str):
    """
    Per-row median and MAD for one condition, over EVERY replica it has.

    Replicas are concatenated along the time axis before the median is taken,
    rather than averaging each replica's own median. A replica that ran longer
    then contributes proportionally more windows, which is what you want: the
    baseline is "what this residue typically does in this condition", and a
    longer run is more evidence about that, not a louder vote.
    """
    import numpy as np

    agg = get_cached_result(session_id, cache_key)
    if agg is None:
        return None, f"result {cache_key[:8]} is no longer cached"
    if agg.get("kind") != "heatmap":
        return None, (f"'{agg.get('analysis_name') or cache_key[:8]}' is a "
                      f"{agg.get('kind')} result, not a matrix")

    prefix = agg.get("replica_cache_prefix") or cache_key
    indices = agg.get("replica_indices") or [1]
    mats, skipped = [], []
    for ri in indices:
        block = agg if (ri == indices[0] and agg.get("z")) else \
            get_cached_result(session_id, f"{prefix}__rep{ri}")
        z = (block or {}).get("z")
        if not z:
            skipped.append(int(ri))
            continue
        mats.append(np.asarray(z, dtype=np.float64))

    if not mats:
        return None, (f"'{agg.get('analysis_name') or cache_key[:8]}' has no "
                      f"stored matrices")

    rows = {m.shape[0] for m in mats}
    if len(rows) > 1:
        return None, (f"replicas of '{agg.get('analysis_name')}' disagree on "
                      f"how many residues they cover ({sorted(rows)})")

    # Concatenate along time, then one median per row.
    full = np.concatenate(mats, axis=1)
    with _np_errstate():
        med = np.nanmedian(np.where(np.isfinite(full), full, np.nan), axis=1)
        dev = np.abs(np.where(np.isfinite(full), full, np.nan) - med[:, None])
        mad = 1.4826 * np.nanmedian(dev, axis=1)

    return {
        "cache_key": cache_key,
        "condition_id": agg.get("condition_id", ""),
        "condition_name": agg.get("condition_name", ""),
        "colour": agg.get("colour", ""),
        "analysis_name": agg.get("analysis_name", ""),
        "n_replicas": len(mats),
        "n_windows": int(full.shape[1]),
        "skipped_replicas": skipped,
        "median": [None if not np.isfinite(v) else float(v) for v in med],
        "mad": [None if not np.isfinite(v) else float(v) for v in mad],
        "residues": agg.get("residues"),
        "zlabel": agg.get("zlabel", ""),
    }, None


class _np_errstate:
    """numpy's all-NaN slice warnings are expected here — a residue can be
    missing from every window — and are handled by the finite checks below."""
    def __enter__(self):
        import warnings
        self._cm = warnings.catch_warnings()
        self._cm.__enter__()
        warnings.simplefilter("ignore")
    def __exit__(self, *a):
        self._cm.__exit__(*a)


@router.post("/row-baseline")
def row_baseline(req: RowBaselineRequest):
    """
    What each residue typically does, measured across every condition at once.

    WHY THIS IS A DIFFERENT QUESTION FROM NORMALISING EACH MAP SEPARATELY
    Dividing a rolling-RMSF map by its OWN per-residue medians removes the
    thing that dominates it — some residues are simply floppier than others —
    but it also removes the comparison between conditions, because each map is
    divided by its own numbers. A residue uniformly twice as mobile in a mutant
    normalises to 1.0 in both and the difference disappears.

    Dividing both by the SAME per-residue baseline keeps both properties: every
    residue is on a common footing, AND a condition that really is more mobile
    reads above 1.0. That is what this computes.

    THE BASELINE IS BALANCED ACROSS CONDITIONS, NOT POOLED OVER REPLICAS.
    Within a condition, all replicas are pooled (more sampling is more
    evidence). Across conditions, the median of the per-condition medians is
    taken, so a condition with ten replicas does not drown one with three — the
    baseline would otherwise drift towards whichever arm was sampled harder,
    and every map would shift with it.

    Nothing is recomputed: this reads matrices already in the cache.
    """
    import numpy as np

    if not req.cache_keys:
        raise HTTPException(status_code=400, detail="No results given.")

    per_condition, warnings_out = [], []
    for key in req.cache_keys:
        row, err = _row_stats(req.session_id, key)
        if row is None:
            warnings_out.append(err)
        else:
            per_condition.append(row)

    if not per_condition:
        raise HTTPException(
            status_code=400,
            detail="None of these results have stored matrices to measure. "
                   + "; ".join(warnings_out[:3]))

    # Residue axes must line up, or row i would mean a different residue in
    # each condition and the baseline would be nonsense — silently.
    sizes = {len(c["median"]) for c in per_condition}
    if len(sizes) > 1:
        detail = ", ".join(f"{c['condition_name'] or c['cache_key'][:8]}: "
                           f"{len(c['median'])}" for c in per_condition)
        raise HTTPException(
            status_code=400,
            detail=f"These results cover different numbers of residues "
                   f"({detail}), so one shared baseline would line up row N of "
                   f"one against a different residue of another. Re-run them "
                   f"with the same selection.")

    n = sizes.pop()
    med = np.array([[c["median"][i] if c["median"][i] is not None else np.nan
                     for i in range(n)] for c in per_condition], dtype=float)
    mad = np.array([[c["mad"][i] if c["mad"][i] is not None else np.nan
                     for i in range(n)] for c in per_condition], dtype=float)
    with _np_errstate():
        shared_med = np.nanmedian(med, axis=0)
        shared_mad = np.nanmedian(mad, axis=0)

    return {
        "n_rows": int(n),
        "n_conditions": len(per_condition),
        "shared": {
            "median": [None if not np.isfinite(v) else float(v) for v in shared_med],
            "mad": [None if not np.isfinite(v) else float(v) for v in shared_mad],
        },
        "per_condition": per_condition,
        "zlabel": per_condition[0].get("zlabel", ""),
        "warnings": warnings_out,
    }


# ─── Distribution of a square matrix, across replicas ─────────────────────────

class MatrixDistributionRequest(BaseModel):
    session_id: str
    cache_key: str
    """Values kept per replica for drawing the violin. Statistics use them all."""
    max_points: int = 2000


@router.post("/matrix-distribution")
def matrix_distribution(req: MatrixDistributionRequest):
    """
    Summarise every replica's matrix as a distribution.

    For a 2D-RMSD this is the spread of pairwise frame-to-frame RMSD: a wide
    distribution means the run visited conformations far apart, a narrow one
    means it sat still. Collapsing each replica to a single number then makes
    ten runs against ten runs an ordinary comparison.

    TWO THINGS THIS IS CAREFUL ABOUT

    Only the UPPER TRIANGLE is counted. The matrix is symmetric with a zero
    diagonal, so including everything would count each pair twice and add N
    zeros that are not measurements of anything — pulling the mean down by a
    factor that depends on how long the trajectory is.

    Statistics come from ALL the values; only the violin OUTLINE is drawn from a
    subsample. Shipping 230,000 cells per replica to the browser is not viable,
    but reporting a mean computed from 2,000 of them when the exact one is
    available would be a silent approximation.
    """
    import numpy as np

    agg = get_cached_result(req.session_id, req.cache_key)
    if agg is None:
        raise HTTPException(status_code=404, detail="That result is no longer cached.")
    if agg.get("kind") != "heatmap":
        raise HTTPException(
            status_code=400,
            detail=f"This needs a matrix result; that one is '{agg.get('kind')}'.")

    prefix = agg.get("replica_cache_prefix") or req.cache_key
    indices = agg.get("replica_indices") or [1]
    rng = np.random.default_rng(0)      # fixed: the violin should not reshuffle
    cap = max(100, min(20000, int(req.max_points)))

    out, skipped = [], []
    for ri in indices:
        block = agg if (ri == indices[0] and agg.get("z")) else \
            get_cached_result(req.session_id, f"{prefix}__rep{ri}")
        z = (block or {}).get("z")
        if not z:
            skipped.append(int(ri))
            continue
        m = np.asarray(z, dtype=np.float64)
        if m.ndim != 2 or m.shape[0] != m.shape[1]:
            # Rectangular (a rolling RMSF, say): no symmetry to exploit, so take
            # every finite cell rather than a triangle that would mean nothing.
            vals = m[np.isfinite(m)].ravel()
        else:
            iu = np.triu_indices(m.shape[0], k=1)
            vals = m[iu]
            vals = vals[np.isfinite(vals)]
        if vals.size == 0:
            skipped.append(int(ri))
            continue

        q = np.percentile(vals, [5, 25, 50, 75, 95])
        sample = (vals if vals.size <= cap
                  else rng.choice(vals, size=cap, replace=False))
        out.append({
            "index": int(ri),
            "n_pairs": int(vals.size),
            "mean": float(vals.mean()),
            "sd": float(vals.std(ddof=1)) if vals.size > 1 else 0.0,
            "min": float(vals.min()), "max": float(vals.max()),
            "p5": float(q[0]), "p25": float(q[1]), "median": float(q[2]),
            "p75": float(q[3]), "p95": float(q[4]),
            "sample": [round(float(v), 4) for v in sample],
            "sampled": bool(vals.size > cap),
        })

    if not out:
        raise HTTPException(
            status_code=400,
            detail="No replica of this analysis has a stored matrix to summarise.")

    return {
        "cache_key": req.cache_key,
        "condition_id": agg.get("condition_id"),
        "condition_name": agg.get("condition_name"),
        "colour": agg.get("colour"),
        "zlabel": agg.get("zlabel") or "value",
        "analysis_name": agg.get("analysis_name"),
        "square": True,
        "replicas": out,
        "skipped_replicas": skipped,
        "note": ("Statistics are computed from every pair; the violin outline is "
                 "drawn from a subsample." if any(r["sampled"] for r in out)
                 else "Statistics and violin both use every pair."),
    }

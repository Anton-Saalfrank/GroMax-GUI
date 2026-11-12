"""
Combining several replicas' results into one.

Split out of analysis_runner. This is the numerical heart of a multi-replica
analysis — the mean, the spread, and the pooled colour range a set of matrices
share — and it is pure: dicts in, a dict out, no HTTP, no session, no
subprocess. That makes it the part most worth testing in isolation, which was
impossible while it lived inside a 2152-line module of endpoints.
"""
import logging
import statistics
from typing import Optional

from .chimerax import flat_to_bio

log = logging.getLogger("gromax.analysis")


def _matrix_stats(matrices) -> Optional[dict]:
    """
    Range and percentiles over every replica's matrix, pooled.

    Percentiles rather than just min/max because a colour scale stretched to the
    single most extreme cell is the reason a whole map can look uniformly dark:
    a few very mobile residues drag the top of the range up and everything else
    is squeezed into the bottom fifth of the colourmap. Clipping at, say, the
    98th percentile gives the remaining 98% of the data the full range.

    Returns None if there is nothing numeric to summarise, so the UI can fall
    back to Plotly's own autoscaling rather than showing a broken control.
    """
    import numpy as np

    pooled = []
    for z in matrices:
        if not isinstance(z, list) or not z:
            continue
        arr = np.asarray(z, dtype=np.float64)
        arr = arr[np.isfinite(arr)]
        if arr.size:
            pooled.append(arr.ravel())
    if not pooled:
        return None

    allv = np.concatenate(pooled)
    qs = np.percentile(allv, [1, 2, 5, 50, 95, 98, 99])
    return {
        "min": float(allv.min()),
        "max": float(allv.max()),
        "p1": float(qs[0]), "p2": float(qs[1]), "p5": float(qs[2]),
        "p50": float(qs[3]),
        "p95": float(qs[4]), "p98": float(qs[5]), "p99": float(qs[6]),
        "n_cells": int(allv.size),
        "n_matrices": len(pooled),
    }


def _agg_replicas(rep_results: list[dict]) -> dict:
    """
    Combine per-replica parsed data into mean ± sd where x-axes match.
    Line data (RMSF, RMSD, Rg, ...) is averaged with SD across replicas.
    Non-line data (heatmap, scatter2d) can't be element-averaged meaningfully,
    so we return the first replica and note how many were available.
    """
    if not rep_results:
        return {}

    kind = rep_results[0].get("kind", "line")

    # Non-line results: keep the payload LIGHT. Embedding every replica's matrix
    # made results ~90 MB and the Results tab (which fetches all results) crawled.
    # We keep only replica 1's matrix inline and list the other replica indices;
    # their matrices are stored separately and fetched on demand by the UI.
    if kind in ("heatmap", "scatter2d"):
        base = dict(rep_results[0])
        base["n_replicas"] = len(rep_results)
        base["replica_indices"] = [r.get("_rep_index", i + 1)
                                   for i, r in enumerate(rep_results)]
        base["replica_note"] = (
            f"{len(rep_results)} replicas available "
            f"(this plot type isn't averaged across replicas)."
        )
        # Summarise the VALUES across every replica, not just the one shown.
        #
        # The plot otherwise lets Plotly pick a colour range from whichever
        # matrix happens to be on screen, so each replica and each condition
        # gets its own scale — and two maps whose colours look identical can
        # hold quite different numbers. Shipping the pooled range and a few
        # percentiles lets the UI hold one scale across all of them without
        # fetching every matrix back.
        if kind == "heatmap":
            base["z_stats"] = _matrix_stats([r.get("z") for r in rep_results])

        # For scatter2d, concatenate all replicas' points so the landscape is fuller
        if kind == "scatter2d" and len(rep_results) > 1:
            all_x, all_y = [], []
            for r in rep_results:
                all_x.extend(r.get("x", []))
                all_y.extend(r.get("y", []))
            base["x"], base["y"] = all_x, all_y
        return base

    # Analyses that report several channels (helix motion: piston, tilt, roll,
    # ...) carry them per replica, so the stacked plot can overlay replicates
    # the same way the single-series plots do. Additive: a result without
    # channels is unchanged.
    def _rep_entry(r, default_index=1):
        entry = {"index": r.get("_rep_index", default_index), "x": r["x"], "y": r["y"]}
        if r.get("channels"):
            entry["channels"] = r["channels"]
        return entry

    if len(rep_results) == 1:
        r = rep_results[0]
        return {
            **r, "y_mean": r["y"], "y_sd": [0.0] * len(r["y"]), "n_replicas": 1,
            "replica_indices": [r.get("_rep_index", 1)],
            "replicas": [_rep_entry(r)],
        }

    # Align on shortest length for the mean/SD reference.
    #
    # A mean can only be computed where EVERY replica has data, so the averaged
    # trace necessarily stops at the shortest replica. That is correct, but it
    # used to be invisible: the Results tab (which plots the mean) would end at
    # e.g. 1.2 us while the Compare tab (which plots per-replica series) ran to
    # 2.5 us, with nothing explaining the difference. We now report the spread
    # so the UI can say so explicitly.
    lengths = [len(r["y"]) for r in rep_results]
    min_len, max_len = min(lengths), max(lengths)
    x = rep_results[0]["x"][:min_len]
    y_stack = [r["y"][:min_len] for r in rep_results]

    def _t_end(rr):
        return rr["x"][-1] if rr.get("x") else None
    t_ends = [_t_end(r) for r in rep_results if _t_end(r) is not None]
    short_reps = [r.get("_rep_index") for r in rep_results
                  if len(r["y"]) == min_len] if min_len != max_len else []

    # SAMPLE standard deviation (divide by n-1), not population (divide by n).
    #
    # These replicas are a sample of the runs that could have been done, not
    # the entire population of them, so the spread that matters is the one that
    # estimates the underlying variability rather than describing only the runs
    # in hand. Everything else in this codebase already agrees: stats.ts
    # (`summarise`, `recomputeMean`), plotFilter.ts, derived.py's
    # matrix-distribution `sd`, and helix.py's rolling SD all use n-1. This
    # line used `statistics.pstdev` and was the sole exception — which meant
    # the Results tab (plotting this band) and the Compare tab (recomputing it
    # in the browser) drew visibly different error bands for the same runs:
    # 5% apart at n=10, 22% at n=3, with neither chart saying which it used.
    #
    # `statistics.stdev` raises on a single value, hence the guard. 0.0 there
    # matches recomputeMean, which also yields 0 for one replica: with one run
    # the band has no width, which is the honest answer.
    y_mean, y_sd = [], []
    for i in range(min_len):
        col = [y[i] for y in y_stack]
        y_mean.append(statistics.mean(col))
        y_sd.append(statistics.stdev(col) if len(col) > 1 else 0.0)

    base = rep_results[0]
    return {
        "kind": base["kind"],
        "x": x,
        "y": y_mean,
        "y_mean": y_mean,
        "y_sd": y_sd,
        "n_replicas": len(rep_results),
        # Replica-length bookkeeping, so the UI can explain why the mean stops
        # earlier than the individual replicas.
        "mean_truncated": min_len != max_len,
        "n_points_mean": min_len,
        "n_points_longest": max_len,
        "t_end_mean": (x[-1] if x else None),
        "t_end_longest": (max(t_ends) if t_ends else None),
        "short_replicas": short_reps,
        # Which replicas these numbers came from. Without it a mean over a
        # chosen subset is indistinguishable from a mean over everything.
        "replica_indices": [r.get("_rep_index", i + 1)
                            for i, r in enumerate(rep_results)],
        "xlabel": base["xlabel"],
        "ylabel": base["ylabel"],
        "title": base["title"],
        # Full per-replica series (own x + y), so the Compare tab can plot,
        # hover-identify, highlight, and recompute means without any replica.
        "replicas": [_rep_entry(r, i + 1) for i, r in enumerate(rep_results)],
    }


def _map_matrix_residues(chains, flat_residues):
    """
    Turn a matrix's per-row flat residue indices into biological identities.

    A correlation matrix is only clickable if a row can name a residue the
    structure viewer also recognises, and the viewer speaks (chain, resnum) —
    the same conversion /residue-values does for per-residue colouring, so the
    two cannot disagree about what residue 142 means.

    Rows that fall outside every defined chain become None rather than being
    dropped: the matrix axis must keep its length, or every row after a gap
    would silently refer to the wrong residue.
    """
    out = []
    for flat in flat_residues:
        try:
            flat = int(flat)
        except (TypeError, ValueError):
            out.append(None)
            continue
        if not chains:
            # No system definition — fall through with the flat index, exactly
            # as /residue-values does. /info already warns that this is the
            # PDB's own numbering.
            out.append({"chain": "", "resnum": flat})
            continue
        bio = flat_to_bio(chains, flat)
        out.append(None if bio is None else {"chain": bio[0], "resnum": bio[1]})
    return out

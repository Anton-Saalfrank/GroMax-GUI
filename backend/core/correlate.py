"""
Correlating a rolling RMSF against another time series.

The rolling RMSF map shows flexibility against time, and laying a mindist trace
over it shows whether the two move together — by eye. This turns that into a
number, per residue and at a range of time lags, so "the loop loosens when the
contact breaks" becomes something with a coefficient and a lead time rather than
an impression.

THREE THINGS THIS HAS TO GET RIGHT

1. COMPARING LIKE WITH LIKE. An RMSF value is not an instant, it is an average
   over a window. So the other series is averaged over exactly the SAME windows
   before anything is correlated. Correlating window means against instantaneous
   values would compare a smoothed signal to an unsmoothed one and understate
   the relationship.

2. THE LAG SIGN. Stated once, here, and repeated in the UI:
       positive lag  =  the OTHER observable leads, RMSF follows.
   That is, r(tau) pairs RMSF at window w with the other series at window
   w - tau. A peak at +4 ns means the distance changed first and flexibility
   responded four nanoseconds later. Getting this backwards would invert every
   causal reading anyone takes from the plot, and nothing in the output would
   look wrong.

3. THE SAMPLES ARE NOT INDEPENDENT. Rolling windows OVERLAP — a 10 ns window
   stepped by 2 ns shares 80% of its frames with the next one — so consecutive
   points are strongly autocorrelated and the honest number of independent
   samples is far below the number of windows. A textbook p-value computed from
   the window count would be wildly optimistic. The effective sample size below
   (Bretherton et al. 1999) corrects for this; it is still an approximation, and
   the UI says so.

No scipy: the backend is frozen with PyInstaller for distribution and this needs
nothing beyond numpy and the standard library.
"""
from __future__ import annotations

import math
from typing import Optional


# Correlating fewer points than this is not worth reporting: with a handful of
# overlapping windows the coefficient is dominated by whichever way the first
# and last point happen to fall.
MIN_PAIRS = 6


def window_means(times_ns, values, centres_ns, window_ns: float):
    """
    Average a time series over each rolling window.

    Returns a list the same length as `centres_ns`, holding None for any window
    the series does not cover — the two analyses may span different time ranges,
    and inventing a value for the gap would create correlation out of nothing.

    Half-open on the right so adjacent non-overlapping windows never share a
    frame, matching how the RMSF windows themselves are cut.
    """
    import numpy as np

    t = np.asarray(times_ns, dtype=np.float64)
    v = np.asarray(values, dtype=np.float64)
    if t.size == 0 or v.size == 0:
        return [None] * len(centres_ns)
    n = min(t.size, v.size)
    t, v = t[:n], v[:n]

    order = np.argsort(t, kind="stable")
    t, v = t[order], v[order]

    half = window_ns / 2.0
    out = []
    for c in centres_ns:
        lo = np.searchsorted(t, c - half, side="left")
        hi = np.searchsorted(t, c + half, side="left")
        if hi <= lo:
            out.append(None)
            continue
        block = v[lo:hi]
        block = block[np.isfinite(block)]
        out.append(float(block.mean()) if block.size else None)
    return out


def _paired(a, b):
    """The pairs where both series have a finite value, as arrays."""
    import numpy as np

    n = min(len(a), len(b))
    xa = np.array([np.nan if a[i] is None else a[i] for i in range(n)], dtype=np.float64)
    xb = np.array([np.nan if b[i] is None else b[i] for i in range(n)], dtype=np.float64)
    keep = np.isfinite(xa) & np.isfinite(xb)
    return xa[keep], xb[keep]


def _rank(x):
    """Average ranks, so ties do not bias a Spearman coefficient."""
    import numpy as np

    order = np.argsort(x, kind="stable")
    ranks = np.empty(len(x), dtype=np.float64)
    ranks[order] = np.arange(len(x), dtype=np.float64)
    # Average the ranks within each run of equal values.
    xs = x[order]
    i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[j + 1] == xs[i]:
            j += 1
        if j > i:
            ranks[order[i:j + 1]] = (i + j) / 2.0
        i = j + 1
    return ranks


def correlation(a, b, method: str = "pearson") -> Optional[float]:
    """Pearson or Spearman coefficient over the finite pairs, or None."""
    import numpy as np

    xa, xb = _paired(a, b)
    if xa.size < MIN_PAIRS:
        return None
    if method == "spearman":
        xa, xb = _rank(xa), _rank(xb)
    sa, sb = xa.std(), xb.std()
    # A flat series has no correlation with anything — not zero, undefined.
    if sa == 0 or sb == 0:
        return None
    r = float(((xa - xa.mean()) * (xb - xb.mean())).mean() / (sa * sb))
    return max(-1.0, min(1.0, r))


def lag1_autocorrelation(x) -> float:
    """Lag-1 autocorrelation, the input to the effective sample size."""
    import numpy as np

    a = np.asarray([v for v in x if v is not None and np.isfinite(v)], dtype=np.float64)
    if a.size < 3:
        return 0.0
    a = a - a.mean()
    denom = float((a * a).sum())
    if denom == 0:
        return 0.0
    r1 = float((a[:-1] * a[1:]).sum() / denom)
    return max(-0.99, min(0.99, r1))


def effective_n(a, b) -> float:
    """
    The number of INDEPENDENT samples, give or take.

    Bretherton et al. (1999): n_eff = n (1 - r1a r1b) / (1 + r1a r1b), where r1
    are the lag-1 autocorrelations. With windows overlapping by 80% both are
    near 1 and this collapses to a small fraction of the window count, which is
    the point — it is what stops a hundred overlapping windows being reported as
    a hundred independent observations.
    """
    import numpy as np

    xa, xb = _paired(a, b)
    n = xa.size
    if n < 3:
        return float(n)
    r1a, r1b = lag1_autocorrelation(xa), lag1_autocorrelation(xb)
    prod = r1a * r1b
    if prod <= -1:
        return float(n)
    n_eff = n * (1.0 - prod) / (1.0 + prod)
    return float(max(2.0, min(float(n), n_eff)))


def p_value(r: Optional[float], n_eff: float) -> Optional[float]:
    """
    Two-sided p for a correlation, via the Fisher z transform.

    Fisher z rather than a t-test because it needs only erfc from the standard
    library, and because it behaves better for |r| near 1. Uses the EFFECTIVE
    sample size, not the window count — see the module docstring.
    """
    if r is None or n_eff is None or n_eff <= 3:
        return None
    r = max(-0.999999, min(0.999999, r))
    z = math.atanh(r) * math.sqrt(n_eff - 3.0)
    return float(math.erfc(abs(z) / math.sqrt(2.0)))


def cross_correlate(a, b, max_lag: int, method: str = "pearson"):
    """
    r at each lag from -max_lag to +max_lag, in WINDOWS.

    POSITIVE LAG MEANS `b` LEADS `a`: r(tau) pairs a[w] with b[w - tau]. So with
    a = RMSF and b = mindist, a peak at +2 windows says the distance moved two
    windows before the flexibility did.

    Returns (lags, values) with None wherever too few pairs overlap.
    """
    n = min(len(a), len(b))
    lags, out = [], []
    for tau in range(-max_lag, max_lag + 1):
        if tau >= 0:
            xa, xb = a[tau:n], b[0:n - tau]
        else:
            k = -tau
            xa, xb = a[0:n - k], b[k:n]
        lags.append(tau)
        out.append(correlation(xa, xb, method) if len(xa) >= MIN_PAIRS else None)
    return lags, out


def best_lag(lags, values):
    """
    The lag of the strongest correlation, by absolute value.

    Returns (lag, r) or (None, None). Selected by SEARCH, so its p-value is
    optimistic in a way a pre-specified lag's is not — callers must label it.
    """
    best_i = None
    best_abs = -1.0
    for i, v in enumerate(values):
        if v is None:
            continue
        if abs(v) > best_abs:
            best_abs = abs(v)
            best_i = i
    if best_i is None:
        return None, None
    return lags[best_i], values[best_i]


def fisher_mean(rs):
    """
    Average correlations across replicas properly.

    Coefficients are not additive — the arithmetic mean of r underestimates when
    they are large — so average the Fisher z values and transform back. This is
    also why a per-replica spread is reported alongside: three replicas
    disagreeing about the sign matters more than their average.
    """
    vals = [r for r in rs if r is not None and abs(r) < 1]
    if not vals:
        # All +-1, or nothing: the mean of the extremes is still meaningful.
        hard = [r for r in rs if r is not None]
        return (sum(hard) / len(hard)) if hard else None
    z = [math.atanh(max(-0.999999, min(0.999999, r))) for r in vals]
    return float(math.tanh(sum(z) / len(z)))

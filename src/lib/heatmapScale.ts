/**
 * Choosing the colour range for a heatmap.
 *
 * Two problems, one cause. Left to itself Plotly stretches the colourmap
 * between the smallest and largest value IN THE MATRIX IT IS DRAWING, which
 * means:
 *
 *  1. A handful of very mobile residues — a terminal tail, a disordered loop —
 *     set the top of the range, and everything else is squeezed into the bottom
 *     of the colourmap. A rigid region becoming slightly more flexible is a
 *     change of a few percent of the range and is invisible.
 *
 *  2. Every replica and every condition gets its OWN range, because each is a
 *     separate matrix. Two maps whose colours look identical can hold quite
 *     different numbers, so "is this region more flexible in repeat 5 than in
 *     repeat 2" cannot be answered by looking — which is the question the plot
 *     appears to be answering.
 *
 * The fix for (1) is clipping: put the top of the scale at a percentile rather
 * than the maximum, so the remaining values get the whole colourmap. The fix
 * for (2) is to compute one range across every replica of every condition on
 * screen and give it to all of them.
 *
 * Clipping HIDES MAGNITUDE — everything above the top is drawn in the same
 * colour — so anything using this must say when it is active and what the cap
 * is. See HeatmapScaleControls.
 */

export type ScaleMode = 'shared' | 'auto' | 'manual'
export type ClipLevel = 'none' | 'p99' | 'p98' | 'p95'

/** What the backend measured across every replica of one analysis. */
export interface MatrixStats {
  min: number
  max: number
  p1: number
  p2: number
  p5: number
  p50: number
  p95: number
  p98: number
  p99: number
  n_cells: number
  n_matrices: number
}

export interface ScaleSettings {
  mode: ScaleMode
  clip: ClipLevel
  /** Used in manual mode; null means "fall back to the shared value". */
  manualMin: number | null
  manualMax: number | null
  /** Correlation maps are symmetric about zero, so they need one limit. */
  divergingLimit: number
}

export const DEFAULT_SCALE: ScaleSettings = {
  // Shared by default. A map that cannot be compared to the one beside it is a
  // worse failure than one whose contrast is not optimal, and per-matrix
  // autoscaling makes every comparison silently invalid.
  mode: 'shared',
  clip: 'none',
  manualMin: null,
  manualMax: null,
  divergingLimit: 1,
}

const UPPER: Record<Exclude<ClipLevel, 'none'>, keyof MatrixStats> = {
  p99: 'p99', p98: 'p98', p95: 'p95',
}
const LOWER: Record<Exclude<ClipLevel, 'none'>, keyof MatrixStats> = {
  p99: 'p1', p98: 'p2', p95: 'p5',
}

function isStats(s: any): s is MatrixStats {
  return !!s && typeof s.min === 'number' && typeof s.max === 'number'
      && Number.isFinite(s.min) && Number.isFinite(s.max)
}

/**
 * Pool several analyses' statistics into one.
 *
 * min and max combine exactly. Percentiles do not — you cannot average
 * percentiles — so the combination is deliberately the WIDEST of them: the
 * largest upper percentile and the smallest lower one. That clips no condition
 * more aggressively than its own percentile would, which keeps the rule easy to
 * state and errs towards showing data rather than hiding it.
 */
export function combineStats(list: (MatrixStats | null | undefined)[]): MatrixStats | null {
  const all = list.filter(isStats)
  if (!all.length) return null
  const pick = (key: keyof MatrixStats, fn: (a: number, b: number) => number) =>
    all.reduce((acc, s) => fn(acc, s[key] as number), all[0][key] as number)

  return {
    min: pick('min', Math.min),
    max: pick('max', Math.max),
    p1: pick('p1', Math.min),
    p2: pick('p2', Math.min),
    p5: pick('p5', Math.min),
    // Not meaningful pooled, and not used for the range; kept so the shape
    // stays a MatrixStats. Reported nowhere.
    p50: all[0].p50,
    p95: pick('p95', Math.max),
    p98: pick('p98', Math.max),
    p99: pick('p99', Math.max),
    n_cells: all.reduce((n, s) => n + (s.n_cells || 0), 0),
    n_matrices: all.reduce((n, s) => n + (s.n_matrices || 0), 0),
  }
}

export interface ResolvedRange {
  zmin: number
  zmax: number
  /** True when values above zmax exist and are drawn at the top colour. */
  clippedHigh: boolean
  clippedLow: boolean
  /** The full extent of the data, for reporting what was cut off. */
  dataMin: number
  dataMax: number
}

/**
 * The range to give Plotly, or null to leave it autoscaling.
 *
 * null is a real answer, not a failure: 'auto' means "per matrix", which is
 * exactly Plotly's own behaviour and is still the right choice when looking at
 * one map in isolation.
 */
export function resolveRange(
  settings: ScaleSettings,
  stats: MatrixStats | null,
  diverging: boolean,
): ResolvedRange | null {
  if (diverging) {
    const lim = Math.abs(settings.divergingLimit) || 1
    return {
      zmin: -lim, zmax: lim,
      clippedHigh: lim < 1, clippedLow: lim < 1,
      dataMin: stats?.min ?? -1, dataMax: stats?.max ?? 1,
    }
  }

  if (settings.mode === 'auto') return null
  if (!stats) return null

  let lo = stats.min
  let hi = stats.max
  if (settings.clip !== 'none') {
    lo = stats[LOWER[settings.clip]] as number
    hi = stats[UPPER[settings.clip]] as number
  }

  if (settings.mode === 'manual') {
    if (settings.manualMin !== null && Number.isFinite(settings.manualMin)) lo = settings.manualMin
    if (settings.manualMax !== null && Number.isFinite(settings.manualMax)) hi = settings.manualMax
  }

  // A zero-width or inverted range makes Plotly render a single flat colour,
  // which looks like "no data" rather than "your bounds are wrong".
  if (!(hi > lo)) {
    const mid = Number.isFinite(lo) ? lo : 0
    const pad = Math.abs(mid) > 0 ? Math.abs(mid) * 0.05 : 1
    lo = mid - pad
    hi = mid + pad
  }

  return {
    zmin: lo,
    zmax: hi,
    clippedHigh: hi < stats.max,
    clippedLow: lo > stats.min,
    dataMin: stats.min,
    dataMax: stats.max,
  }
}

/**
 * Statistics for a matrix the backend did not summarise.
 *
 * Results computed before z_stats existed have none, and re-running an analysis
 * to get a colour scale would be absurd. This covers only the matrix actually
 * loaded — one replica — so it is a fallback, and callers should say so rather
 * than presenting it as a pooled range.
 */
export function statsFromMatrix(z: any): MatrixStats | null {
  if (!Array.isArray(z) || !z.length) return null
  const vals: number[] = []
  for (const row of z) {
    if (!Array.isArray(row)) continue
    for (const v of row) if (typeof v === 'number' && Number.isFinite(v)) vals.push(v)
  }
  if (!vals.length) return null
  vals.sort((a, b) => a - b)
  const q = (p: number) => vals[Math.min(vals.length - 1,
                                         Math.max(0, Math.round((p / 100) * (vals.length - 1))))]
  return {
    min: vals[0], max: vals[vals.length - 1],
    p1: q(1), p2: q(2), p5: q(5), p50: q(50),
    p95: q(95), p98: q(98), p99: q(99),
    n_cells: vals.length, n_matrices: 1,
  }
}

/** Compact number for a colour-scale readout: 0.0412 not 0.04123456789. */
export function fmtScale(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 100) return v.toFixed(0)
  if (a >= 1) return v.toFixed(2)
  if (a >= 0.01) return v.toFixed(3)
  return v.toPrecision(2)
}

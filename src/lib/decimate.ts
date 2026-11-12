/**
 * Shrinking a long trace for display without losing what it was plotted for.
 *
 * Needed because the rolling-RMSF overlay has to be an SVG `scatter` rather
 * than a `scattergl`: measured in Plotly 2.35, putting a scattergl trace on a
 * heatmap stops `plotly_selected` firing at all, which would silently kill the
 * drag-a-region interaction the map exists for. SVG copes with a few thousand
 * points and struggles with fifty thousand, so a long trace is thinned first.
 *
 * NOT by taking every Nth point. The whole reason for overlaying mindist on a
 * flexibility map is to see the moment it spikes, and a stride drops exactly
 * that: a one-frame contact break has a 1-in-N chance of surviving. Each bucket
 * therefore contributes its MINIMUM and its MAXIMUM, in the order they occur,
 * so the envelope of the trace is preserved even as the point count falls.
 */

/** Below this, a trace is passed through untouched. */
export const DECIMATE_THRESHOLD = 8000

export interface Decimated {
  x: number[]
  y: number[]
  /** True if anything was dropped, so the UI can say so. */
  reduced: boolean
  original: number
}

export function decimateMinMax(
  xs: number[], ys: number[], maxPoints = DECIMATE_THRESHOLD,
): Decimated {
  const n = Math.min(xs.length, ys.length)
  if (n <= maxPoints || maxPoints < 4) {
    return { x: xs.slice(0, n), y: ys.slice(0, n), reduced: false, original: n }
  }

  // Two points per bucket (the min and the max), so aim for half as many
  // buckets as the point budget.
  const buckets = Math.floor(maxPoints / 2)
  const width = n / buckets
  const outX: number[] = []
  const outY: number[] = []

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * width)
    const stop = Math.min(n, Math.floor((b + 1) * width))
    if (stop <= start) continue

    let loI = -1, hiI = -1
    let lo = Infinity, hi = -Infinity
    for (let i = start; i < stop; i++) {
      const v = ys[i]
      if (!Number.isFinite(v)) continue
      if (v < lo) { lo = v; loI = i }
      if (v > hi) { hi = v; hiI = i }
    }
    if (loI < 0) continue                       // the whole bucket was NaN

    // Emit in time order, so the line is drawn left to right rather than
    // zig-zagging back on itself.
    const first = Math.min(loI, hiI)
    const second = Math.max(loI, hiI)
    outX.push(xs[first]); outY.push(ys[first])
    if (second !== first) { outX.push(xs[second]); outY.push(ys[second]) }
  }

  return { x: outX, y: outY, reduced: true, original: n }
}

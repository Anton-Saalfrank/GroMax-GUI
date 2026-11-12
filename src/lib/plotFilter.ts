/**
 * A filter is a FRAME MASK. Everything else is a reading of that mask.
 *
 * The original filtered-analysis code computed a pass fraction directly out of
 * a threshold, which made "fraction of frames passing" the only thing a filter
 * could ever produce. Once a saved filter is also allowed to gate a time series
 * ("show only the frames where the cavity is open") that framing stops working,
 * because gating needs the mask itself and not a summary of it.
 *
 * So the mask is the primitive:
 *
 *     fraction          = mean(mask)
 *     conditional mean  = mean(target[i] for i where mask[i])
 *     gated time series = target[i] where mask[i], a GAP elsewhere
 *     shaded overlay    = the intervals where mask is true
 *
 * All four are in this file, pure and without React, so they can be checked
 * against values counted by hand.
 *
 * TWO THINGS THAT WOULD OTHERWISE BE QUIETLY WRONG
 *
 * 1. FRAME ALIGNMENT. A mask is an array of indices. Applying it to a metric
 *    sampled on a different stride, or over a different time window, lines up
 *    frame 100 of one trajectory with frame 100 of another and silently reports
 *    a number for the wrong moments. `alignFrames` refuses that, naming both
 *    sampling intervals, instead of truncating to the shorter one.
 *
 * 2. GAPS, NOT DELETION. When a time series is gated, the failing frames must
 *    become `null`, not disappear. Dropping them and re-plotting connects the
 *    line across the gap and compresses the time axis, so a 50 ns excursion
 *    where the filter failed renders as two adjacent frames. Plotly breaks a
 *    line at a null (connectgaps defaults to false), which is the honest
 *    picture: no data was collected there, as far as this filter is concerned.
 */
import type { FilterDef } from './plotSeries'

/** One replica's series, as the stored results carry it. */
export interface ReplicaSeries {
  index: number
  /** Time axis, when the analysis has one. */
  x?: number[]
  y: number[]
}

export function passes(v: number, op: FilterDef['op'], thr: number): boolean {
  if (!Number.isFinite(v)) return false
  return op === '>' ? v > thr
       : op === '<' ? v < thr
       : op === '>=' ? v >= thr
       : v <= thr
}

/** The threshold applied frame by frame, before any debouncing. */
export function rawMask(ys: number[], op: FilterDef['op'], thr: number): boolean[] {
  return (ys || []).map(v => passes(v, op, thr))
}

/**
 * Drop passing runs shorter than `minRun` frames.
 *
 * A one-dimensional morphological opening, and the reason it exists is
 * specific: several of the metrics worth filtering on — cavity volume above
 * all — are dominated by frame-to-frame noise, with a lag-1 autocorrelation
 * near zero. Thresholding such a signal produces a mask that flickers on and
 * off every few frames, and a time series gated by it is confetti rather than a
 * picture of an open state.
 *
 * `minRun` is a statement about what counts as an EVENT, so it is the user's to
 * set, and it defaults to 1 — no debouncing, the mask is exactly the threshold.
 * Runs are measured in frames, not nanoseconds, because that is what the mask
 * is indexed by; the UI converts.
 */
export function openRuns(mask: boolean[], minRun: number): boolean[] {
  if (!(minRun > 1)) return mask.slice()
  const out = mask.slice()
  let i = 0
  while (i < out.length) {
    if (!out[i]) { i++; continue }
    let j = i
    while (j < out.length && out[j]) j++
    if (j - i < minRun) for (let k = i; k < j; k++) out[k] = false
    i = j
  }
  return out
}

/** The complete mask for a filter: threshold, then debounce. */
export function frameMask(ys: number[], filter: FilterDef): boolean[] {
  return openRuns(rawMask(ys, filter.op, filter.threshold), filter.minRun || 1)
}

// ─── Frame alignment ────────────────────────────────────────────────────────

export interface Alignment {
  /** Frames safe to use. 0 when the two cannot be aligned at all. */
  n: number
  /** Why they cannot be aligned, with both sides named. */
  problem: string | null
  /** Aligned, but one is shorter — said out loud rather than assumed. */
  note: string | null
}

/**
 * The mean sampling interval, over the WHOLE series rather than the first pair.
 *
 * x[1]-x[0] samples one interval and inherits whatever rounding the writer
 * applied to two numbers; across a few thousand frames that is enough to make
 * two identically-sampled analyses look different at the tolerance this
 * function is compared at.
 */
function meanDt(xs?: number[]): number | null {
  if (!Array.isArray(xs) || xs.length < 2) return null
  const dt = (xs[xs.length - 1] - xs[0]) / (xs.length - 1)
  return Number.isFinite(dt) && dt !== 0 ? dt : null
}

/**
 * Can `b` be read with a mask built from `a`?
 *
 * Compares the time axes when both have one, and falls back to frame counts
 * when they do not. A mismatch is REFUSED rather than truncated: truncation
 * here does not lose data, it reports a number for the wrong frames.
 */
export function alignFrames(a: ReplicaSeries, b?: ReplicaSeries,
                            labelA = 'filter metric',
                            labelB = 'target metric'): Alignment {
  const na = a?.y?.length || 0
  if (!b) return { n: na, problem: null, note: null }
  const nb = b.y?.length || 0
  if (!na || !nb) {
    return { n: 0, problem: `${!na ? labelA : labelB} has no frames.`, note: null }
  }

  const dtA = meanDt(a.x), dtB = meanDt(b.x)
  if (dtA !== null && dtB !== null) {
    // A thousandth of a frame interval: far beyond float noise, far below any
    // real difference in stride.
    const tol = Math.min(Math.abs(dtA), Math.abs(dtB)) * 1e-3
    if (Math.abs(dtA - dtB) > tol) {
      return { n: 0, note: null, problem:
        `${labelA} is sampled every ${dtA.toPrecision(4)} and ${labelB} every `
        + `${dtB.toPrecision(4)}. Frame n of one is not frame n of the other, `
        + `so the filter cannot be applied across them.` }
    }
    const t0A = a.x![0], t0B = b.x![0]
    if (Math.abs(t0A - t0B) > tol) {
      return { n: 0, note: null, problem:
        `${labelA} starts at ${t0A.toPrecision(4)} and ${labelB} at `
        + `${t0B.toPrecision(4)}. They cover different windows of the `
        + `trajectory, so their frames do not correspond.` }
    }
  } else if (na !== nb) {
    // No time axis to check against, so frame count is the only evidence there
    // is — and unequal counts with no way to tell why is not something to
    // guess at.
    return { n: 0, note: null, problem:
      `${labelA} has ${na} frames and ${labelB} has ${nb}, and neither carries `
      + `a time axis to align them by.` }
  }

  const n = Math.min(na, nb)
  return { n, problem: null,
    note: na === nb ? null
      : `${labelA} has ${na} frames and ${labelB} has ${nb}; the first ${n} are `
        + `compared.` }
}

// ─── The four readings ──────────────────────────────────────────────────────

export interface FilterValue {
  /** null when the filter selected nothing, or the metrics do not align. */
  value: number | null
  nPass: number
  nTotal: number
  problem: string | null
}

/**
 * One number for one replica: the pass fraction, or the conditional mean.
 *
 * A conditional mean over zero passing frames is `null`, not 0. Zero is a
 * measurement; "the filter never fired in this run" is the absence of one, and
 * averaging it in as zero would drag a condition's bar toward the floor in
 * proportion to how often the event failed to happen.
 */
export function evaluateReplica(filter: FilterDef, filterRep: ReplicaSeries,
                                targetRep?: ReplicaSeries): FilterValue {
  const ys = filterRep?.y || []
  if (!ys.length) {
    return { value: null, nPass: 0, nTotal: 0, problem: 'no frames' }
  }

  if (filter.output === 'fraction') {
    const mask = frameMask(ys, filter)
    const nPass = mask.reduce((a, m) => a + (m ? 1 : 0), 0)
    return { value: nPass / mask.length, nPass, nTotal: mask.length, problem: null }
  }

  if (!targetRep) {
    return { value: null, nPass: 0, nTotal: ys.length,
             problem: `no matching replica in the metric being averaged` }
  }
  const al = alignFrames(filterRep, targetRep, filter.metric,
                         filter.targetMetric || 'target metric')
  if (al.problem) return { value: null, nPass: 0, nTotal: 0, problem: al.problem }

  const mask = frameMask(ys, filter)
  const kept: number[] = []
  for (let i = 0; i < al.n; i++) {
    if (mask[i] && Number.isFinite(targetRep.y[i])) kept.push(targetRep.y[i])
  }
  const nPass = mask.slice(0, al.n).reduce((a, m) => a + (m ? 1 : 0), 0)
  return {
    value: kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : null,
    nPass, nTotal: al.n,
    problem: kept.length ? al.note : 'the filter passed no frames in this replica',
  }
}

/** The gated series: the value where the mask holds, a gap where it does not. */
export function gate(ys: number[], mask: boolean[]): (number | null)[] {
  const n = Math.min(ys.length, mask.length)
  const out: (number | null)[] = new Array(ys.length).fill(null)
  for (let i = 0; i < n; i++) if (mask[i]) out[i] = ys[i]
  return out
}

/**
 * The passing stretches, as [start, end] on the x axis, for shading.
 *
 * A single passing frame is given the width of ONE FRAME rather than zero,
 * centred on its own time: that frame stands for the interval it was written
 * from, and a zero-width band is invisible — which would read as "this never
 * happened" rather than "this happened briefly".
 */
export function passIntervals(xs: number[], mask: boolean[]): [number, number][] {
  const n = Math.min(xs?.length || 0, mask?.length || 0)
  if (!n) return []
  const dt = meanDt(xs) ?? 1
  const half = Math.abs(dt) / 2
  const out: [number, number][] = []
  let i = 0
  while (i < n) {
    if (!mask[i]) { i++; continue }
    let j = i
    while (j < n && mask[j]) j++
    out.push([xs[i] - half, xs[j - 1] + half])
    i = j
  }
  return out
}

export interface GatedMean {
  mean: (number | null)[]
  sd: (number | null)[]
  /** How many replicas contributed at each time point. */
  n: number[]
}

/**
 * Mean ± SD across replicas, computed only over the frames each one passes.
 *
 * THE COUNT CHANGES ALONG THE AXIS, and that is the whole difficulty. In the
 * ungated plot every point is a mean of the same ten runs. Here a point near
 * the start might average nine runs and a point in the middle two, because the
 * filter is a statement about what the system is doing and the runs do not do
 * it in step. A band drawn without saying so looks like the ordinary mean±SD
 * and is not one.
 *
 * Two consequences are handled rather than papered over:
 *   - below `minN` contributing replicas the point is `null`, so the line
 *     breaks instead of wandering off on the evidence of a single run;
 *   - `n` comes back so the caller can show the coverage, which is the only
 *     way a reader can tell a well-supported stretch from a thin one.
 */
export function gatedMean(items: { y: number[]; mask: boolean[] }[],
                          minN = 2): GatedMean {
  const len = items.reduce((m, it) => Math.max(m, it.y.length), 0)
  const mean: (number | null)[] = [], sd: (number | null)[] = [], n: number[] = []
  for (let i = 0; i < len; i++) {
    const col: number[] = []
    for (const it of items) {
      if (it.mask[i] && Number.isFinite(it.y[i])) col.push(it.y[i])
    }
    n.push(col.length)
    if (col.length < Math.max(1, minN)) { mean.push(null); sd.push(null); continue }
    const m = col.reduce((a, b) => a + b, 0) / col.length
    mean.push(m)
    sd.push(col.length > 1
      ? Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / (col.length - 1))
      : 0)
  }
  return { mean, sd, n }
}

// ─── Description ────────────────────────────────────────────────────────────

const OP_WORD: Record<FilterDef['op'], string> = {
  '>': '>', '<': '<', '>=': '≥', '<=': '≤',
}

/**
 * The filter in words, for the list and for axis labels.
 *
 * A saved filter whose name is "open" tells a reader nothing six months later;
 * the definition beside it does.
 */
export function describeFilter(f: FilterDef,
                               label: (metric: string) => string = m => m): string {
  const run = (f.minRun || 1) > 1 ? ` for ${f.minRun}+ frames in a row` : ''
  const where = `${label(f.metric)} ${OP_WORD[f.op]} ${f.threshold}${run}`
  return f.output === 'fraction'
    ? `fraction of frames where ${where}`
    : `mean ${label(f.targetMetric || '?')} over frames where ${where}`
}

/** A stable id that does not change when the filter is renamed. */
export function newFilterId(): string {
  return 'f' + Math.random().toString(36).slice(2, 9)
}

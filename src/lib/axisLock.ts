/**
 * Holding an axis still while you page through repeats.
 *
 * Repeat detail answers "what was happening in repeat 5 around 345 ns", and
 * the obvious next action is to look at repeat 6. With autoscaled axes that
 * comparison is worthless: Plotly refits every panel to whatever the new run
 * happens to span, so a 0.28–0.34 nm RMSD and a 0.9–3.1 nm RMSD are drawn as
 * the same picture. The shape is preserved and the magnitude — the only thing
 * you were comparing — is thrown away. Worse, it is thrown away invisibly;
 * nothing on screen says the scale moved under you.
 *
 * So the range can be pinned to the extent across every repeat, which makes
 * paging a true comparison, at the cost of a quiet run occupying a sliver of
 * its panel. That trade is the user's to make per analysis, which is why this
 * is a setting and not a default dressed up as a fix.
 */

export type AxisLockMode =
  /** Plotly autoscales to whatever is drawn — per repeat, so it moves. */
  | 'auto'
  /** Every repeat of the condition being viewed. */
  | 'repeats'
  /** Every repeat of every condition, so switching condition holds too. */
  | 'all'
  /** Typed bounds. */
  | 'manual'

export interface AxisLock {
  mode: AxisLockMode
  /** Only read in 'manual' mode; kept when switching away so it comes back. */
  min?: number
  max?: number
}

/**
 * Locked across repeats by default.
 *
 * The autoscaling behaviour this replaces is not a neutral starting point —
 * it silently defeats the comparison the mode exists for (see above). Anyone
 * who wants a quiet run to fill its panel can say so per analysis; nobody
 * wants to be misled by default.
 */
export const DEFAULT_AXIS_LOCK: AxisLock = { mode: 'repeats' }

export function normaliseAxisLock(raw: any): AxisLock {
  const modes: AxisLockMode[] = ['auto', 'repeats', 'all', 'manual']
  const mode: AxisLockMode =
    raw && modes.includes(raw.mode) ? raw.mode : DEFAULT_AXIS_LOCK.mode
  const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  return { mode, min: num(raw?.min), max: num(raw?.max) }
}

export interface Extent { min: number; max: number }

/** Extent of finite values, or null when there are none to speak of. */
export function extentOf(values: Iterable<number>): Extent | null {
  let min = Infinity, max = -Infinity
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  return min <= max ? { min, max } : null
}

export function mergeExtents(a: Extent | null, b: Extent | null): Extent | null {
  if (!a) return b
  if (!b) return a
  return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) }
}

/**
 * Breathing room, because a hard range has none.
 *
 * Plotly's autorange pads by itself; an explicit range does not, so a locked
 * panel draws its maximum exactly on the top border and the peak you locked
 * the axis to read is the one line you cannot see. A flat series (min === max)
 * would give a zero-height window, so it gets an absolute margin instead.
 */
export function padExtent(e: Extent, frac = 0.05): [number, number] {
  const span = e.max - e.min
  if (span <= 0) {
    const m = Math.abs(e.max) > 0 ? Math.abs(e.max) * frac : 0.5
    return [e.min - m, e.max + m]
  }
  const m = span * frac
  return [e.min - m, e.max + m]
}

/**
 * The Plotly range for one axis, or undefined to leave it autoscaling.
 *
 * `undefined` rather than null: it is spread straight into an axis object, and
 * `range: null` is not the same as an absent `range` to Plotly.
 */
export function resolveAxisRange(
  lock: AxisLock,
  extents: { repeats: Extent | null; all: Extent | null },
  pad = 0.05,
): [number, number] | undefined {
  if (lock.mode === 'auto') return undefined
  if (lock.mode === 'manual') {
    const { min, max } = lock
    // One bound typed is a half-answer; fall back to the across-repeats extent
    // for the other, which is what the user was looking at when they typed it.
    const base = extents.repeats ?? extents.all
    const lo = min ?? base?.min
    const hi = max ?? base?.max
    if (lo === undefined || hi === undefined || lo === hi) return undefined
    return lo < hi ? [lo, hi] : [hi, lo]
  }
  const e = lock.mode === 'all' ? (extents.all ?? extents.repeats)
                                : (extents.repeats ?? extents.all)
  return e ? padExtent(e, pad) : undefined
}

export const AXIS_LOCK_LABELS: Record<AxisLockMode, string> = {
  auto: 'Fit this repeat',
  repeats: 'Lock across repeats',
  all: 'Lock across everything',
  manual: 'Fixed range',
}

export const AXIS_LOCK_HELP: Record<AxisLockMode, string> = {
  auto: 'Rescales to each repeat — shapes comparable, magnitudes not.',
  repeats: 'Same scale for every repeat of this condition.',
  all: 'Same scale for every repeat of every condition.',
  manual: 'Exactly the bounds you type.',
}

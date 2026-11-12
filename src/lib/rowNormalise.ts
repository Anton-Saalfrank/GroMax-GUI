/**
 * Showing a rolling RMSF relative to each residue's own usual flexibility.
 *
 * THE PROBLEM WITH ABSOLUTE VALUES
 * A rolling-RMSF map is dominated by WHERE the protein is floppy, not by WHEN
 * anything happened. A terminal tail or a long loop sits at the top of the
 * colour range for the whole run, and a buried residue that doubles its
 * fluctuation — which is the interesting event — moves by a few percent of the
 * range and is invisible. Clipping the scale helps a little; it does not fix
 * the cause, which is that one scale is being used for residues whose normal
 * values differ by an order of magnitude.
 *
 * Dividing each row by its own typical value puts every residue on the same
 * footing: 1.0 means "normal for this residue", 2.0 means "twice its usual",
 * wherever it sits on the flexibility range.
 *
 * WHICH BASELINE, WHICH IS THE WHOLE QUESTION
 * Dividing each row by ITS OWN median — measured inside the matrix on screen —
 * answers "when was this residue unusual for itself". It also destroys the
 * comparison between conditions: a residue uniformly twice as mobile in a
 * mutant is divided by its own larger median and lands on 1.0 in BOTH arms, so
 * the difference disappears entirely.
 *
 * Dividing every map by the SAME per-residue baseline, measured across all the
 * conditions on screen, keeps both properties at once — every residue is on a
 * common footing AND an arm that really is more mobile reads above 1.0.
 * Measured end to end in test_row_baseline.py: a planted 2x difference comes
 * out as 0.67 against 1.33, where own-baseline normalisation puts both on 1.00.
 *
 * So a shared baseline is the better default, and `baseline` is how it gets
 * here. Own-row normalisation stays available for reading one run on its own
 * terms, and absolute values stay available for everything else.
 *
 * WHY MEDIAN AND MAD RATHER THAN MEAN AND SD
 * The baseline has to be robust to the very events being looked for. One large
 * excursion pulls the row's mean up and its SD up much further, so the event
 * partly normalises itself away — the stronger the event, the more it hides.
 * The median and the median absolute deviation barely move. Measured in
 * rowNormalise.test.ts: a 4x spike over 5% of a run scores 4.5 against a
 * mean/SD baseline and 35 against median/MAD — nearly 8x more signal for the
 * same event, purely from not letting the event define its own yardstick.
 */

export type NormMode = 'none' | 'ratio' | 'log2' | 'robustz'

/**
 * A per-residue baseline computed elsewhere — normally by the backend across
 * every replica of every condition. `median` is the value that reads as 1.0;
 * `mad` is only needed for the robust-z view.
 */
export interface RowBaseline {
  median: (number | null)[]
  mad?: (number | null)[]
  /** Shown to the user, e.g. "all conditions" or "WT". */
  label: string
}

/** What /api/analysis/row-baseline returns, carried down to each map. */
export interface RowBaselineBundle {
  n_rows: number
  n_conditions: number
  shared: { median: (number | null)[]; mad: (number | null)[] }
  per_condition: {
    cache_key: string; condition_id: string; condition_name: string
    colour: string; n_replicas: number; n_windows: number
    median: (number | null)[]; mad: (number | null)[]
  }[]
  warnings: string[]
}

export interface NormResult {
  /** The transformed matrix; null marks a row or cell that cannot be scaled. */
  z: (number | null)[][]
  zlabel: string
  /** The value that means "normal for this residue" — the colour midpoint. */
  neutral: number
  /** Half-range for a symmetric colour scale, or null to let the plot decide. */
  limit: number | null
  /** Rows with no usable baseline, left blank rather than shown as huge. */
  nSkipped: number
  note: string
}

export const NORM_LABELS: Record<NormMode, string> = {
  none: 'absolute values',
  ratio: 'fold of each residue’s own median',
  log2: 'log₂ fold of own median',
  robustz: 'robust z (median / MAD)',
}

export function median(xs: number[]): number {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return NaN
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/**
 * Median absolute deviation, scaled to be comparable with a standard
 * deviation (x1.4826 for normally distributed data) so "3" means roughly what
 * "3 sigma" means and nobody has to learn a second scale.
 */
export function mad(xs: number[], med?: number): number {
  const m = med === undefined ? median(xs) : med
  if (!Number.isFinite(m)) return NaN
  return 1.4826 * median(xs.filter(Number.isFinite).map(v => Math.abs(v - m)))
}

/** Percentile of an array, for picking a colour limit that outliers cannot set. */
function pct(xs: number[], p: number): number {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return NaN
  const i = Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))))
  return v[i]
}

/**
 * Rescale every row of a residue-by-time matrix against its own baseline.
 *
 * `minCells` guards the short rows that appear at the ends of a trajectory;
 * a baseline from two windows is not a baseline.
 */
export function normaliseRows(z: number[][], mode: NormMode,
                              baseline?: RowBaseline | null,
                              minCells = 5): NormResult {
  if (mode === 'none' || !Array.isArray(z) || !z.length) {
    return { z: z as any, zlabel: '', neutral: 0, limit: null, nSkipped: 0, note: '' }
  }

  // A baseline for a different number of residues cannot be lined up with this
  // matrix — row N would be a different residue — so it is refused rather than
  // used, and the fallback is stated instead of happening quietly.
  const mismatched = !!baseline && baseline.median.length !== z.length
  const base = mismatched ? null : (baseline || null)
  const source = base ? base.label : 'this map'

  const out: (number | null)[][] = []
  const spread: number[] = []
  let skipped = 0

  for (let ri = 0; ri < z.length; ri++) {
    const row = z[ri]
    if (!Array.isArray(row)) { out.push([]); skipped++; continue }
    const finite = row.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    const given = base ? base.median[ri] : null
    const med = (given !== null && given !== undefined && Number.isFinite(given))
      ? given : (base ? NaN : median(finite))

    // A row needs enough windows to have a "usual" at all, and a positive one:
    // an RMSF of zero has no meaningful fold-change, and dividing by it would
    // paint a rigid residue as the most dramatic thing on the map.
    const usable = finite.length >= minCells && Number.isFinite(med) && med > 0
    if (!usable) { out.push(row.map(() => null)); skipped++; continue }

    if (mode === 'robustz') {
      const bm = base?.mad?.[ri]
      const d = (bm !== null && bm !== undefined && Number.isFinite(bm))
        ? bm : (base ? NaN : mad(finite, med))
      if (!Number.isFinite(d) || d <= 0) { out.push(row.map(() => null)); skipped++; continue }
      const r = row.map(v => (typeof v === 'number' && Number.isFinite(v)
                              ? (v - med) / d : null))
      out.push(r)
      for (const v of r) if (v !== null) spread.push(Math.abs(v))
    } else {
      const r = row.map(v => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
        const ratio = v / med
        return mode === 'log2' ? Math.log2(ratio) : ratio
      })
      out.push(r)
      const neutral = mode === 'log2' ? 0 : 1
      for (const v of r) if (v !== null) spread.push(Math.abs(v - neutral))
    }
  }

  const neutral = mode === 'ratio' ? 1 : 0
  // The 98th percentile, not the maximum: one residue with a wild excursion
  // would otherwise set the range and flatten everything this view exists to
  // reveal — the same failure as the absolute map, one level up.
  const lim = pct(spread, 98)
  const zlabel = mode === 'ratio' ? `× median (${source})`
    : mode === 'log2' ? `log₂ × median (${source})`
    : `robust z (${source})`

  return {
    z: out, zlabel, neutral,
    limit: Number.isFinite(lim) && lim > 0 ? lim : null,
    nSkipped: skipped,
    note: [
      mismatched
        ? `The shared baseline covers ${baseline!.median.length} residues and `
          + `this map has ${z.length}, so it was not used — each row is `
          + 'scaled against itself here, which cannot compare conditions.'
        : '',
      skipped
        ? `${skipped} residue${skipped === 1 ? '' : 's'} left blank — too few `
          + 'windows, or no measurable baseline to scale against.'
        : '',
    ].filter(Boolean).join(' '),
  }
}

/**
 * Reading regions off a correlation matrix.
 *
 * A box dragged across a DCCM is a claim about two stretches of sequence at
 * once — the columns it spans and the rows it spans — and the useful thing to
 * do with it is colour those two stretches differently on the structure. That
 * is the same reading an AlphaFold PAE map gets, and it is how an off-diagonal
 * patch stops being a patch and becomes "this loop moves with that helix".
 *
 * The mapping is kept here, away from the plot component, because it is the
 * part that can be wrong in a way nobody would notice: colouring by matrix
 * ROW INDEX rather than residue looks completely plausible and is off by
 * however many residues the analysis selection skipped.
 */

export interface MatrixResidue {
  chain: string
  resnum: number
}

/**
 * The residues covered by a dragged range along one axis.
 *
 * The range arrives in DATA coordinates — Plotly reports where the box landed
 * on the axis, not which cells it touched — so it is compared against the
 * axis VALUES. That is what makes it correct for a selection with gaps: a box
 * drawn over residues 40-60 picks the rows whose residue number is in 40-60,
 * even when those are rows 12-19 of the matrix.
 *
 * Rows the system definition could not place (null) are skipped rather than
 * guessed at.
 */
export function residuesInRange(
  axis: number[],
  residues: (MatrixResidue | null)[],
  lo: number,
  hi: number,
): MatrixResidue[] {
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  const out: MatrixResidue[] = []
  const n = Math.min(axis.length, residues.length)
  for (let i = 0; i < n; i++) {
    const v = axis[i]
    if (!Number.isFinite(v) || v < a || v > b) continue
    const r = residues[i]
    if (r) out.push(r)
  }
  return out
}

/**
 * A short human label for a set of residues, for naming the highlight.
 *
 * Spans rather than a count, because "DCCM rows 120–180" is something you can
 * check against the plot you just dragged on and "180 residues" is not.
 */
export function describeResidues(picks: MatrixResidue[]): string {
  if (!picks.length) return 'none'
  const byChain = new Map<string, number[]>()
  for (const p of picks) {
    const list = byChain.get(p.chain || '')
    if (list) list.push(p.resnum)
    else byChain.set(p.chain || '', [p.resnum])
  }
  const parts: string[] = []
  for (const [chain, nums] of byChain) {
    const lo = Math.min(...nums)
    const hi = Math.max(...nums)
    const span = lo === hi ? `${lo}` : `${lo}–${hi}`
    parts.push(chain ? `${chain}:${span}` : span)
  }
  return parts.join(', ')
}

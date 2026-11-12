/**
 * Paired tests, checked against scipy — and against the mistake they prevent.
 *
 * Reference values were generated with scipy 1.15.2:
 *
 *   stats.ttest_rel(a, b)                                  -> t, p
 *   stats.ttest_ind(a, b, equal_var=False)                 -> Welch, for contrast
 *   stats.wilcoxon(a, b, method='approx', correction=True) -> W, p (A has ties)
 *   stats.wilcoxon(e, f, method='exact')                   -> W, p (tie-free)
 *   stats.wilcoxon(c, d, method='approx', correction=True,
 *                  zero_method='wilcox')                   -> W, p with ties+zero
 *
 * Section 1 is the one that matters. The same twenty numbers give p = 3.8e-6
 * paired and p = 0.385 unpaired, because pairing removes a between-replica
 * spread that the unpaired test leaves in the denominator. A panel that picks
 * the wrong one is not off by a little.
 */
import { pairedT, wilcoxonSignedRank, comparePaired, welchT, isPairedTest } from '../stats'

let fails = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
/** Agreement to the given number of significant figures. */
const sig = (a: number, b: number, n = 6) =>
  b === 0 ? a === 0 : Math.abs(a - b) / Math.abs(b) < 10 ** -n

// Ten replicas. Wide spread BETWEEN replicas (1.8 to 5.0), small and
// consistent difference WITHIN each one (b is always above a).
const A = [2.1, 3.4, 1.8, 4.2, 2.9, 3.1, 5.0, 2.2, 3.8, 4.5]
const B = [2.5, 3.9, 2.0, 4.9, 3.2, 3.6, 5.4, 2.6, 4.3, 5.1]

console.log('1. the trap: the same numbers, two answers')
{
  const pt = pairedT(A, B)!
  const w = welchT(A, B)!
  check('paired t matches scipy ttest_rel t', sig(pt.t, -9.925397398266), String(pt.t))
  check('paired t matches scipy ttest_rel p', sig(pt.p, 0.000003808230, 5), String(pt.p))
  check('Welch on the same data matches scipy ttest_ind', sig(w.p, 0.384852079407, 6), String(w.p))
  check('and the two disagree by five orders of magnitude — this is the bug '
        + 'the paired test exists to prevent', w.p / pt.p > 1e4,
        `${w.p.toExponential(2)} vs ${pt.p.toExponential(2)}`)
  check('df is n-1, not 2n-2', pt.df === 9, String(pt.df))
}

console.log('\n2. Wilcoxon signed-rank')
{
  /*
   * |d| for this fixture is 0.2, 0.3, 0.4, 0.4, 0.4, 0.5, 0.5, 0.5, 0.6, 0.7 —
   * ties, so the approximation is the correct path and an "exact" p would be
   * wrong. But the 0.4s are computed (2.1-2.5 and 5.0-5.4) and differ in the
   * last bit, so this ALSO pins the tolerance in the tie grouping: with `===`
   * the tie correction is wrong and the p-value drifts.
   */
  const r = wilcoxonSignedRank(A, B)!
  check('every difference has the same sign, so W = 0', r.w === 0, String(r.w))
  check('ties are detected despite float noise in the differences', !r.exact)
  /*
   * The reference here is scipy run on the differences ROUNDED to 10 dp
   * (0.005666092353), not on the raw ones (0.005761162816).
   *
   * That is not a fudge. scipy ranks the raw floats, so the three differences
   * that are all 0.4 get ranks 3.5, 3.5 and 5 — two of them happened to come
   * out bit-identical and the third did not. Its tie correction is then built
   * on a tie structure that is an artefact of subtraction order. Rounding
   * first gives ranks 4, 4, 4, which is the statistic the test is defined to
   * compute, and that is what the tolerance in midRanks reproduces directly.
   *
   * Agreement is checked to 4 significant figures because that is what this
   * file's own normalCdf supports — its erf is a series approximation good to
   * about 1e-7 absolute, which at p = 0.0057 is a few parts in 100,000.
   */
  check('p matches scipy (on differences cleaned of float noise)',
        sig(r.p, 0.005666092353, 4), String(r.p))
  check('and that is NOT scipy\'s raw answer, because the raw ranks are an '
        + 'artefact of float noise', !sig(r.p, 0.005761162816, 4))
  check('n counts the non-zero differences', r.n === 10 && r.nZero === 0)

  // A tie-free fixture, where the exact enumeration is the valid test.
  const E = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
  const F = [1.3, 2.9, 2.8, 4.05, 6.2, 5.5, 7.45]
  const e = wilcoxonSignedRank(E, F)!
  check('with no ties the exact test is used', e.exact)
  check('exact W matches scipy', e.w === 7, String(e.w))
  check('exact p matches scipy to the bit', near(e.p, 0.296875, 1e-15), String(e.p))
  check('and the exact p is a dyadic rational, as enumeration requires',
        Number.isInteger(e.p * 2 ** 7), String(e.p * 2 ** 7))
  const ept = pairedT(E, F)!
  check('paired t on the tie-free fixture matches scipy',
        sig(ept.t, -1.391170328071, 8) && sig(ept.p, 0.213568167435, 8),
        `t=${ept.t} p=${ept.p}`)
}

console.log('\n3. Wilcoxon with ties and a zero difference')
{
  // c[2] == d[2], so that pair is dropped (Wilcoxon's own handling) and n
  // falls to 7. |d| has ties, so the normal approximation is used.
  const C = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
  const D = [1.5, 2.5, 3.0, 4.6, 5.5, 5.4, 7.5, 8.6]
  const r = wilcoxonSignedRank(C, D)!
  check('the zero-difference pair is dropped', r.nZero === 1 && r.n === 7,
        `n=${r.n} nZero=${r.nZero}`)
  check('ties force the approximation rather than a bogus exact p', !r.exact)
  check('W matches scipy', r.w === 6, String(r.w))
  check('p matches scipy approx with continuity + tie correction',
        sig(r.p, 0.193373163105, 5), String(r.p))

  const pt = pairedT(C, D)!
  check('paired t on the same fixture matches scipy',
        sig(pt.t, -2.188486619610, 8) && sig(pt.p, 0.064823435576, 7),
        `t=${pt.t} p=${pt.p}`)
}

console.log('\n4. comparePaired refuses what it cannot pair')
{
  const ok = comparePaired([{ name: 'closed', values: A }, { name: 'open', values: B }], 'pairedt')
  check('two aligned series give one comparison', ok.pairs.length === 1)
  check('and it is the paired p, not Welch', sig(ok.pairs[0].p, 0.000003808230, 5),
        String(ok.pairs[0].p))
  check('the note says why a paired test was used',
        /SAME replicas/.test(ok.notes[0]), ok.notes[0])

  // Unequal lengths cannot be paired: replica 7 of one is not replica 7 of
  // the other, and truncating would pair different runs.
  const bad = comparePaired([{ name: 'a', values: A },
                             { name: 'b', values: B.slice(0, 8) }], 'pairedt')
  check('series of different lengths are refused, not truncated',
        bad.pairs.length === 0 && /cannot be paired/.test(bad.notes.join(' ')),
        bad.notes.join(' '))

  const three = comparePaired([{ name: 'a', values: A }, { name: 'b', values: B },
                               { name: 'c', values: A.map(v => v + 0.1) }], 'pairedt')
  check('three series give three pairwise comparisons', three.pairs.length === 3)
  check('and they are Holm-adjusted',
        three.pairs.every(p => p.pAdjusted !== undefined && p.pAdjusted >= p.p))

  check('isPairedTest knows the families',
        isPairedTest('pairedt') && isPairedTest('wilcoxon')
        && !isPairedTest('welch') && !isPairedTest('mannwhitney'))
}

console.log('\n5. underpowered is reported, not hidden')
{
  // Three pairs: the exact test cannot go below 2/2^3 = 0.25.
  const r = comparePaired([{ name: 'a', values: [1, 2, 3] },
                           { name: 'b', values: [2, 3, 4] }], 'wilcoxon')
  check('with 3 pairs the floor is 0.25 and is said out loud',
        /0\.250/.test(r.pairs[0].underpowered || ''),
        r.pairs[0].underpowered || '(nothing)')
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)

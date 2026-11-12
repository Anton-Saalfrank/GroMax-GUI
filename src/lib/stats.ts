/**
 * Statistics for comparing conditions.
 *
 * THE UNIT OF REPLICATION IS THE REPLICA, NOT THE FRAME.
 *
 * This is the whole design, and getting it wrong is the easiest way to produce
 * confident nonsense from an MD trajectory. A 500 ns run sampled every 100 ps
 * has 5000 frames, but they are not 5000 independent observations of anything —
 * consecutive frames are almost identical, and the whole trajectory is one
 * draw from one set of starting conditions. Running a t-test over frames gives
 * p-values like 1e-300 for differences that would vanish if you ran the
 * simulation again with a different seed.
 *
 * So every test here takes ONE NUMBER PER REPLICA — that replica's mean over
 * the selected window — and compares those across conditions. With three
 * replicas per condition, n = 3. That is a small number, and it should look
 * small: the honest conclusion from three-versus-three is usually "suggestive",
 * and the effect size matters more than the p-value. The helpers below report
 * both, and flag the cases where a non-significant result says more about the
 * number of replicas than about the systems.
 *
 * No dependencies: the distribution functions are implemented here (continued
 * fractions for the incomplete beta, Lanczos for log-gamma) and checked against
 * scipy in the test suite.
 */

// ─── Special functions ───────────────────────────────────────────────────────

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
]

/** log|Γ(x)| — Lanczos approximation, good to ~15 significant figures. */
export function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection, so the series is only ever evaluated where it converges well.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  }
  const z = x - 1
  let a = 0.99999999999980993
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i + 1)
  const t = z + LANCZOS.length - 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

/**
 * Regularised incomplete beta I_x(a, b), by the Lentz continued fraction.
 *
 * This is what turns a t statistic into a p-value. The symmetry swap keeps the
 * fraction in the region where it converges quickly.
 */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a)

  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b)
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a

  const TINY = 1e-30
  let f = 1, c = 1, d = 0
  for (let i = 0; i <= 300; i++) {
    const m = Math.floor(i / 2)
    let numerator: number
    if (i === 0) numerator = 1
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m))
    else numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1))

    d = 1 + numerator * d
    if (Math.abs(d) < TINY) d = TINY
    d = 1 / d
    c = 1 + numerator / c
    if (Math.abs(c) < TINY) c = TINY
    const cd = c * d
    f *= cd
    if (Math.abs(1 - cd) < 1e-12) break
  }
  return front * (f - 1)
}

/** Two-sided p for Student's t with df degrees of freedom. */
export function tTestP(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return NaN
  const x = df / (df + t * t)
  return Math.min(1, incompleteBeta(x, df / 2, 0.5))
}

/** Upper-tail p for the F distribution — the ANOVA p-value. */
export function fTestP(f: number, df1: number, df2: number): number {
  if (!Number.isFinite(f) || f <= 0 || df1 <= 0 || df2 <= 0) return NaN
  return Math.min(1, incompleteBeta(df2 / (df2 + df1 * f), df2 / 2, df1 / 2))
}

/** Standard normal CDF, via erf. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/** Abramowitz & Stegun 7.1.26 refined — max error ~1.2e-7, ample for a p-value. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
                 - 0.284496736) * t * t * Math.exp(-a * a)
             - 0.254829592 * t * Math.exp(-a * a)
  return sign * y
}

/** Upper-tail p for chi-squared — the Kruskal–Wallis p-value. */
export function chiSquaredP(x: number, df: number): number {
  if (!Number.isFinite(x) || x <= 0 || df <= 0) return NaN
  return 1 - lowerGamma(df / 2, x / 2)
}

/** Regularised lower incomplete gamma P(a, x), series + continued fraction. */
function lowerGamma(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN
  if (x === 0) return 0
  if (x < a + 1) {
    let sum = 1 / a, term = sum
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a))
  }
  // Continued fraction for the UPPER tail, then complement.
  const TINY = 1e-300
  let b = x + 1 - a, c = 1 / TINY, d = 1 / b, h = d
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < TINY) d = TINY
    c = b + an / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-14) break
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h
}

// ─── Descriptives ────────────────────────────────────────────────────────────

export interface Summary {
  n: number
  mean: number
  sd: number
  sem: number
  /** Half-width of the 95% CI, so the interval is mean ± ci95. */
  ci95: number
}

export function summarise(values: number[]): Summary | null {
  const v = values.filter(Number.isFinite)
  if (!v.length) return null
  const n = v.length
  const mean = v.reduce((a, b) => a + b, 0) / n
  // Sample SD (n-1): these replicas are a sample of the runs you could have
  // done, not the entire population of them.
  const sd = n > 1
    ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const sem = n > 1 ? sd / Math.sqrt(n) : 0
  // t-based, not 1.96: with n = 3 the multiplier is 4.3, and using the normal
  // value would understate the interval by more than half.
  const ci95 = n > 1 ? tCritical95(n - 1) * sem : 0
  return { n, mean, sd, sem, ci95 }
}

/** Two-sided 95% t critical value, found by bisection on the CDF. */
export function tCritical95(df: number): number {
  if (df <= 0) return NaN
  let lo = 0, hi = 100
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (tTestP(mid, df) > 0.05) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// ─── Comparing two conditions ────────────────────────────────────────────────

export type TestKind = 'welch' | 'mannwhitney' | 'pairedt' | 'wilcoxon'

/** The two paired tests, so a caller can tell which family a kind belongs to. */
export const PAIRED_TESTS: TestKind[] = ['pairedt', 'wilcoxon']
export const isPairedTest = (t: TestKind) => PAIRED_TESTS.includes(t)

export interface Comparison {
  a: string
  b: string
  nA: number
  nB: number
  test: TestKind
  statistic: number
  p: number
  /** Holm-adjusted across all pairs in the same family. */
  pAdjusted?: number
  /** Hedges' g — the standardised difference, bias-corrected for small n. */
  effect: number
  effectLabel: string
  meanDiff: number
  /** Set when the test CANNOT reach significance at this sample size. */
  underpowered?: string
}

/**
 * Welch's t-test: unequal variances assumed.
 *
 * The default rather than Student's, because two conditions of an MD system
 * routinely differ in how variable they are — a destabilised mutant is both
 * shifted AND noisier — and Student's pooled variance would be wrong in exactly
 * that case. Welch costs nothing when the variances do match.
 */
export function welchT(a: number[], b: number[]): { t: number; df: number; p: number } | null {
  const sa = summarise(a), sb = summarise(b)
  if (!sa || !sb || sa.n < 2 || sb.n < 2) return null
  const va = sa.sd ** 2 / sa.n, vb = sb.sd ** 2 / sb.n
  if (va + vb === 0) return null
  const t = (sa.mean - sb.mean) / Math.sqrt(va + vb)
  // Welch–Satterthwaite
  const df = (va + vb) ** 2
    / ((va ** 2) / (sa.n - 1) + (vb ** 2) / (sb.n - 1))
  return { t, df, p: tTestP(t, df) }
}

/**
 * Mann–Whitney U with an exact null distribution for small samples.
 *
 * Exact rather than the normal approximation because the samples here are
 * tiny — the approximation is poor below about n=8 per group, which is most
 * MD replica counts. Ties fall back to the normal approximation with a tie
 * correction, and are flagged.
 */
export function mannWhitney(a: number[], b: number[]): { u: number; p: number; exact: boolean } | null {
  const xa = a.filter(Number.isFinite), xb = b.filter(Number.isFinite)
  if (xa.length < 1 || xb.length < 1) return null
  const n1 = xa.length, n2 = xb.length

  let u1 = 0
  let ties = false
  for (const x of xa) for (const y of xb) {
    if (x > y) u1 += 1
    else if (x === y) { u1 += 0.5; ties = true }
  }
  const u = Math.min(u1, n1 * n2 - u1)

  if (!ties && n1 * n2 <= 400) {
    return { u, p: Math.min(1, 2 * exactMannWhitneyCdf(u, n1, n2)), exact: true }
  }
  const mean = (n1 * n2) / 2
  const sd = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12)
  if (sd === 0) return { u, p: 1, exact: false }
  const z = (u - mean + 0.5) / sd
  return { u, p: Math.min(1, 2 * normalCdf(z)), exact: false }
}

/**
 * P(U <= u) under the null, from the exact null distribution.
 *
 * Counts ARRANGEMENTS, of which there are C(n1+n2, n1) — not orderings, of
 * which there are 2^(n1+n2). Getting that wrong gives p-values several times
 * too small, which is the difference between "significant" and not.
 *
 * Recurrence on the largest remaining element: if it came from sample 1 it
 * exceeds all j remaining members of sample 2 and so adds j to U, otherwise it
 * adds nothing.  f(i,j,k) = f(i-1,j,k-j) + f(i,j-1,k)
 */
function exactMannWhitneyCdf(u: number, n1: number, n2: number): number {
  const maxU = n1 * n2
  // table[j] holds the counts over k for the current i.
  let table: Float64Array[] = new Array(n2 + 1)
  for (let j = 0; j <= n2; j++) {
    const a = new Float64Array(maxU + 1); a[0] = 1; table[j] = a
  }
  for (let i = 1; i <= n1; i++) {
    const next: Float64Array[] = new Array(n2 + 1)
    const a0 = new Float64Array(maxU + 1); a0[0] = 1; next[0] = a0
    for (let j = 1; j <= n2; j++) {
      const cur = new Float64Array(maxU + 1)
      const fromI = table[j]        // largest came from sample 1: adds j
      const fromJ = next[j - 1]     // largest came from sample 2: adds 0
      for (let k = 0; k <= maxU; k++) {
        cur[k] = fromJ[k] + (k - j >= 0 ? fromI[k - j] : 0)
      }
      next[j] = cur
    }
    table = next
  }
  const counts = table[n2]
  let total = 0, below = 0
  for (let k = 0; k <= maxU; k++) {
    total += counts[k]
    if (k <= u) below += counts[k]
  }
  return total === 0 ? NaN : below / total
}

/**
 * The smallest p Mann–Whitney can possibly return at these sample sizes.
 *
 * Worth computing and showing: with three replicas against three, the most
 * extreme possible arrangement gives p = 0.1, so "not significant" is
 * guaranteed in advance and says nothing whatsoever about the systems. Reading
 * that as evidence of no difference is a real and common mistake.
 */
export function minimumAchievableP(n1: number, n2: number): number {
  if (n1 < 1 || n2 < 1) return 1
  return Math.min(1, 2 / binomial(n1 + n2, n1))
}

function binomial(n: number, k: number): number {
  return Math.round(Math.exp(logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)))
}

/** Hedges' g: Cohen's d with the small-sample bias correction applied. */
export function hedgesG(a: number[], b: number[]): number {
  const sa = summarise(a), sb = summarise(b)
  if (!sa || !sb || sa.n < 2 || sb.n < 2) return NaN
  const pooled = Math.sqrt((((sa.n - 1) * sa.sd ** 2) + ((sb.n - 1) * sb.sd ** 2))
                           / (sa.n + sb.n - 2))
  if (pooled === 0) return NaN
  const d = (sa.mean - sb.mean) / pooled
  const df = sa.n + sb.n - 2
  // Without this, d is biased upward by ~25% at n=3 per group.
  const j = 1 - 3 / (4 * df - 1)
  return d * j
}

export function effectLabel(g: number): string {
  const a = Math.abs(g)
  if (!Number.isFinite(a)) return '—'
  if (a < 0.2) return 'negligible'
  if (a < 0.5) return 'small'
  if (a < 0.8) return 'medium'
  return 'large'
}

/**
 * Holm–Bonferroni across a family of comparisons.
 *
 * Holm rather than plain Bonferroni: it is uniformly more powerful and just as
 * valid, which matters when three replicas leave little power to spare.
 */
export function holmAdjust(ps: number[]): number[] {
  const idx = ps.map((p, i) => [p, i] as [number, number])
             .filter(([p]) => Number.isFinite(p))
             .sort((x, y) => x[0] - y[0])
  const out = ps.map(() => NaN)
  let running = 0
  idx.forEach(([p, i], rank) => {
    const adj = Math.min(1, (idx.length - rank) * p)
    running = Math.max(running, adj)      // enforce monotonicity
    out[i] = running
  })
  return out
}

/** ★ notation, with the thresholds spelled out wherever it is shown. */
export function stars(p: number): string {
  if (!Number.isFinite(p)) return ''
  if (p < 0.0001) return '****'
  if (p < 0.001) return '***'
  if (p < 0.01) return '**'
  if (p < 0.05) return '*'
  return 'ns'
}

// ─── Three or more conditions ────────────────────────────────────────────────

export interface Omnibus {
  test: string
  statistic: number
  p: number
  df1?: number
  df2?: number
}

/**
 * Welch's one-way ANOVA — does ANY condition differ?
 *
 * Welch's again, not the classical F: unequal group variances are the norm
 * here, and the classical test's error rate is badly inflated when group sizes
 * also differ.
 */
export function welchAnova(groups: number[][]): Omnibus | null {
  const gs = groups.map(summarise).filter((s): s is Summary => !!s && s.n > 1)
  if (gs.length < 2) return null
  const w = gs.map(g => g.n / (g.sd ** 2 || Number.EPSILON))
  const sumW = w.reduce((a, b) => a + b, 0)
  const wMean = gs.reduce((acc, g, i) => acc + w[i] * g.mean, 0) / sumW
  const k = gs.length
  const numerator = gs.reduce((acc, g, i) => acc + w[i] * (g.mean - wMean) ** 2, 0) / (k - 1)
  const lambda = gs.reduce(
    (acc, g, i) => acc + ((1 - w[i] / sumW) ** 2) / (g.n - 1), 0) / (k ** 2 - 1)
  const denominator = 1 + (2 * (k - 2) * lambda) / 3
  const f = numerator / denominator
  const df2 = 1 / (3 * lambda)
  return { test: "Welch's ANOVA", statistic: f, p: fTestP(f, k - 1, df2), df1: k - 1, df2 }
}

/** Kruskal–Wallis — the rank-based alternative when normality is doubtful. */
export function kruskalWallis(groups: number[][]): Omnibus | null {
  const clean = groups.map(g => g.filter(Number.isFinite)).filter(g => g.length > 0)
  if (clean.length < 2) return null
  const all: { v: number; g: number }[] = []
  clean.forEach((g, gi) => g.forEach(v => all.push({ v, g: gi })))
  const n = all.length
  if (n < 3) return null
  all.sort((a, b) => a.v - b.v)

  // Average ranks within ties.
  const ranks = new Array(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && all[j + 1].v === all[i].v) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[k] = r
    i = j + 1
  }
  const sums = clean.map(() => 0)
  const counts = clean.map(() => 0)
  all.forEach((item, k) => { sums[item.g] += ranks[k]; counts[item.g] += 1 })

  let h = 0
  for (let g = 0; g < clean.length; g++) h += (sums[g] ** 2) / counts[g]
  h = (12 / (n * (n + 1))) * h - 3 * (n + 1)

  // Tie correction. Without it H is biased DOWNWARD whenever two replicas give
  // the same value — which happens with rounded data — so the test becomes
  // quietly conservative rather than wrong-looking.
  let tieSum = 0
  let i2 = 0
  while (i2 < n) {
    let j = i2
    while (j + 1 < n && all[j + 1].v === all[i2].v) j++
    const t = j - i2 + 1
    if (t > 1) tieSum += t ** 3 - t
    i2 = j + 1
  }
  const correction = 1 - tieSum / (n ** 3 - n)
  if (correction > 0) h /= correction

  const df = clean.length - 1
  return { test: 'Kruskal–Wallis', statistic: h, p: chiSquaredP(h, df), df1: df }
}

// ─── Correlation ─────────────────────────────────────────────────────────────

export interface CorrelationResult {
  r: number
  p: number
  n: number
  r2: number
  /** Fisher-z 95% interval for r. */
  ciLow: number
  ciHigh: number
  slope: number
  intercept: number
}

export function linearFit(xs: number[], ys: number[], spearman = false): CorrelationResult | null {
  const x = xs.slice(), y = ys.slice()
  const n0 = Math.min(x.length, y.length)
  const px: number[] = [], py: number[] = []
  for (let i = 0; i < n0; i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) { px.push(x[i]); py.push(y[i]) }
  }
  if (px.length < 3) return null
  const useX = spearman ? rankArray(px) : px
  const useY = spearman ? rankArray(py) : py

  const n = px.length
  const mx = useX.reduce((a, b) => a + b, 0) / n
  const my = useY.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (useX[i] - mx) * (useY[i] - my)
    sxx += (useX[i] - mx) ** 2
    syy += (useY[i] - my) ** 2
  }
  if (sxx === 0 || syy === 0) return null
  const r = sxy / Math.sqrt(sxx * syy)
  const t = r * Math.sqrt((n - 2) / Math.max(1e-300, 1 - r * r))
  const p = tTestP(t, n - 2)

  // The fitted line is always on the RAW values: a line through ranks would not
  // lie on the data the user is looking at.
  const rmx = px.reduce((a, b) => a + b, 0) / n
  const rmy = py.reduce((a, b) => a + b, 0) / n
  let rsxy = 0, rsxx = 0
  for (let i = 0; i < n; i++) {
    rsxy += (px[i] - rmx) * (py[i] - rmy)
    rsxx += (px[i] - rmx) ** 2
  }
  const slope = rsxx === 0 ? NaN : rsxy / rsxx
  const intercept = rmy - slope * rmx

  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)))
  const se = n > 3 ? 1 / Math.sqrt(n - 3) : NaN
  return {
    r, p, n, r2: r * r,
    ciLow: Number.isFinite(se) ? Math.tanh(z - 1.96 * se) : NaN,
    ciHigh: Number.isFinite(se) ? Math.tanh(z + 1.96 * se) : NaN,
    slope, intercept,
  }
}

function rankArray(x: number[]): number[] {
  const order = x.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0])
  const ranks = new Array(x.length)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[order[k][1]] = r
    i = j + 1
  }
  return ranks
}

// ─── Putting it together for a set of conditions ─────────────────────────────

export interface GroupComparison {
  groups: { name: string; values: number[]; summary: Summary | null }[]
  omnibus: Omnibus | null
  pairs: Comparison[]
  notes: string[]
}

/**
 * Compare named groups of per-replica values.
 *
 * `values` must be one number per replica — see the module docstring. Every
 * caveat that applies is returned in `notes` rather than left implicit.
 */
export function compareGroups(
  named: { name: string; values: number[] }[],
  test: TestKind = 'welch',
): GroupComparison {
  const groups = named.map(g => ({
    name: g.name,
    values: g.values.filter(Number.isFinite),
    summary: summarise(g.values),
  }))
  const usable = groups.filter(g => g.values.length >= 2)
  const notes: string[] = []

  if (usable.length < 2) {
    notes.push('At least two conditions with two or more replicas each are '
             + 'needed to compare anything.')
    return { groups, omnibus: null, pairs: [], notes }
  }

  const omnibus = usable.length > 2
    ? (test === 'welch'
        ? welchAnova(usable.map(g => g.values))
        : kruskalWallis(usable.map(g => g.values)))
    : null

  const pairs: Comparison[] = []
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const A = usable[i], B = usable[j]
      let statistic = NaN, p = NaN
      if (test === 'welch') {
        const w = welchT(A.values, B.values)
        if (w) { statistic = w.t; p = w.p }
      } else {
        const m = mannWhitney(A.values, B.values)
        if (m) { statistic = m.u; p = m.p }
      }
      const g = hedgesG(A.values, B.values)
      const minP = minimumAchievableP(A.values.length, B.values.length)
      pairs.push({
        a: A.name, b: B.name, nA: A.values.length, nB: B.values.length,
        test, statistic, p,
        effect: g, effectLabel: effectLabel(g),
        meanDiff: (A.summary?.mean ?? NaN) - (B.summary?.mean ?? NaN),
        underpowered: (test === 'mannwhitney' && minP > 0.05)
          ? `with ${A.values.length} vs ${B.values.length} replicas the smallest `
            + `p this test can return is ${minP.toFixed(2)}, so it cannot reach `
            + `significance however different the conditions are`
          : undefined,
      })
    }
  }

  const adj = holmAdjust(pairs.map(c => c.p))
  pairs.forEach((c, i) => { c.pAdjusted = adj[i] })

  const smallest = Math.min(...usable.map(g => g.values.length))
  notes.push(`n is the number of REPLICAS, not frames — each replica contributes `
           + `its mean over the plotted range. Frames within a run are not `
           + `independent observations.`)
  if (smallest < 5) {
    notes.push(`The smallest group has ${smallest} replicas. At that size the `
             + `effect size is more informative than the p-value, and a `
             + `non-significant result is weak evidence of no difference.`)
  }
  if (pairs.length > 1) {
    notes.push(`${pairs.length} pairwise comparisons — p values are also shown `
             + `Holm-adjusted for that.`)
  }
  return { groups, omnibus, pairs, notes }
}


// ─── Paired comparisons ──────────────────────────────────────────────────────
/*
 * WHY THIS EXISTS, in one worked example.
 *
 * Two filters measured on the SAME ten replicas is a paired design. Feeding
 * those two columns to Welch treats ten paired observations as twenty
 * independent ones, and the error is not conservative — it gets WORSE the
 * stronger the pairing is, because the between-replica spread that pairing
 * removes is exactly what the unpaired test puts in the denominator.
 *
 * On the fixture in the test file (ten replicas, each one consistently higher
 * under B than under A, but with a wide spread between replicas):
 *
 *     paired t   p = 0.0000038
 *     Welch      p = 0.385
 *
 * Five orders of magnitude, on the same twenty numbers. Whichever is right, a
 * panel that silently picks the wrong one is not reporting a statistic.
 */

/** Complete pairs only — a replica missing on either side is not a pair. */
function pairOf(a: number[], b: number[]): { x: number[]; y: number[] } {
  const n = Math.min(a.length, b.length)
  const x: number[] = [], y: number[] = []
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { x.push(a[i]); y.push(b[i]) }
  }
  return { x, y }
}

/**
 * Paired t-test on the per-replica differences.
 *
 * ORDER MATTERS, and the order is positional: element i of `a` must be the same
 * replica as element i of `b`. The caller is responsible for that alignment —
 * which is why the Compare tab intersects the usable replica indices across
 * every metric on the graph before it gets here.
 */
export function pairedT(a: number[], b: number[]):
    { t: number; df: number; p: number; n: number } | null {
  const { x, y } = pairOf(a, b)
  const n = x.length
  if (n < 2) return null
  const d = x.map((v, i) => v - y[i])
  const m = d.reduce((s, v) => s + v, 0) / n
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1))
  if (sd === 0) return null
  const t = m / (sd / Math.sqrt(n))
  return { t, df: n - 1, p: tTestP(t, n - 1), n }
}

/**
 * Ranks of |d|, ties averaged — the midrank convention the test assumes.
 *
 * Ties are matched with a TOLERANCE, not with `===`, and that is not a
 * nicety. These differences are computed, not read in: 2.1 - 2.5 is
 * -0.3999999999999999 and 5.0 - 5.4 is -0.40000000000000036, two numbers that
 * are the same measurement and differ in the last bit. Exact comparison calls
 * them distinct, which changes the tie correction, changes whether the exact
 * test is considered valid, and so changes the p-value — on data where every
 * difference was meant to be 0.4.
 */
function midRanks(vals: number[]): { ranks: number[]; tieGroups: number[] } {
  const idx = vals.map((v, i) => [v, i] as [number, number])
                  .sort((p, q) => p[0] - q[0])
  const ranks = new Array(vals.length).fill(0)
  const tieGroups: number[] = []
  // Relative, so it scales with the data: nothing measured here is
  // meaningfully distinct at one part in a billion.
  const same = (u: number, v: number) =>
    Math.abs(u - v) <= 1e-9 * Math.max(1, Math.abs(u), Math.abs(v))
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && same(idx[j + 1][0], idx[i][0])) j++
    const r = (i + j + 2) / 2          // 1-based mean rank of positions i..j
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = r
    if (j > i) tieGroups.push(j - i + 1)
    i = j + 1
  }
  return { ranks, tieGroups }
}

/**
 * Exact two-sided p for the signed-rank statistic, by enumerating every sign
 * assignment. Valid only without ties, which is why the caller checks.
 */
function exactSignedRankP(n: number, w: number): number {
  // counts[s] = number of sign assignments giving W+ = s
  const maxS = (n * (n + 1)) / 2
  let counts = new Float64Array(maxS + 1)
  counts[0] = 1
  for (let r = 1; r <= n; r++) {
    const next = new Float64Array(maxS + 1)
    for (let sIdx = 0; sIdx <= maxS; sIdx++) {
      const c = counts[sIdx]
      if (!c) continue
      next[sIdx] += c                                  // this rank is negative
      if (sIdx + r <= maxS) next[sIdx + r] += c        // this rank is positive
    }
    counts = next
  }
  let total = 0, le = 0
  for (let sIdx = 0; sIdx <= maxS; sIdx++) {
    total += counts[sIdx]
    if (sIdx <= w) le += counts[sIdx]
  }
  return Math.min(1, 2 * (le / total))
}

/**
 * Wilcoxon signed-rank test.
 *
 * Zero differences are DROPPED and n reduced (Wilcoxon's own handling): a
 * replica that gave the same value both ways carries no information about the
 * direction of the effect, and keeping it as a rank of zero would dilute the
 * ones that do.
 *
 * Exact when it is exact — no ties among |d| and n small enough to enumerate —
 * and the normal approximation with a continuity and tie correction otherwise.
 * Which one ran comes back in `exact`, because at n = 6 the difference between
 * them is the difference between a claim and a hint.
 */
export function wilcoxonSignedRank(a: number[], b: number[]):
    { w: number; p: number; exact: boolean; n: number; nZero: number } | null {
  const { x, y } = pairOf(a, b)
  const all = x.map((v, i) => v - y[i])
  const nZero = all.filter(v => v === 0).length
  const d = all.filter(v => v !== 0)
  const n = d.length
  if (n < 2) return null

  const { ranks, tieGroups } = midRanks(d.map(Math.abs))
  let wPlus = 0
  for (let i = 0; i < n; i++) if (d[i] > 0) wPlus += ranks[i]
  const wMinus = (n * (n + 1)) / 2 - wPlus
  const w = Math.min(wPlus, wMinus)

  // 2^20 sign assignments is the practical ceiling, and far more replicas
  // than any of these studies run.
  if (!tieGroups.length && n <= 20) {
    return { w, p: exactSignedRankP(n, w), exact: true, n, nZero }
  }
  const mean = (n * (n + 1)) / 4
  const tieCorr = tieGroups.reduce((s, t) => s + (t ** 3 - t), 0) / 2
  const se = Math.sqrt(((n * (n + 1) * (2 * n + 1)) - tieCorr) / 24)
  if (se === 0) return null
  const cc = 0.5 * Math.sign(wPlus - mean)
  const z = (wPlus - mean - cc) / se
  return { w, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))), exact: false, n, nZero }
}

/**
 * Compare groups measured on the SAME replicas, in order.
 *
 * `values[i]` must be replica i in every group — the caller aligns them. Groups
 * of unequal length are refused rather than truncated: silently dropping the
 * tail would pair replica 7 of one group with replica 7 of another that is a
 * different run, which is the error this whole function exists to prevent.
 */
export function comparePaired(
  named: { name: string; values: number[] }[],
  test: TestKind = 'pairedt',
): GroupComparison {
  const groups = named.map(g => ({
    name: g.name, values: g.values, summary: summarise(g.values.filter(Number.isFinite)),
  }))
  const notes: string[] = []
  const usable = groups.filter(g => g.values.filter(Number.isFinite).length >= 2)

  if (usable.length < 2) {
    notes.push('At least two series with two or more replicas each are needed '
             + 'to compare anything.')
    return { groups, omnibus: null, pairs: [], notes }
  }
  const lengths = new Set(usable.map(g => g.values.length))
  if (lengths.size > 1) {
    notes.push(`These series are measured on different numbers of replicas `
             + `(${[...lengths].join(', ')}), so they cannot be paired. Nothing `
             + `is reported rather than pairing runs that are not the same run.`)
    return { groups, omnibus: null, pairs: [], notes }
  }

  const kind: TestKind = isPairedTest(test) ? test : 'pairedt'
  const pairs: Comparison[] = []
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const A = usable[i], B = usable[j]
      let statistic = NaN, p = NaN, nUsed = A.values.length
      let underpowered: string | undefined
      if (kind === 'pairedt') {
        const r = pairedT(A.values, B.values)
        if (r) { statistic = r.t; p = r.p; nUsed = r.n }
      } else {
        const r = wilcoxonSignedRank(A.values, B.values)
        if (r) {
          statistic = r.w; p = r.p; nUsed = r.n
          /*
           * The signed-rank statistic has 2^n possible sign assignments, so
           * its smallest two-sided p is 2/2^n. Below six pairs that floor is
           * above 0.05 and the test CANNOT be significant, however large the
           * difference — which is worth saying before someone reads a null
           * result as evidence of no effect.
           *
           * It is said on the approximation path too, and more loudly: there
           * the normal approximation can return a small p at n = 3, and that
           * number is an artefact of approximating a distribution with six
           * atoms by a continuous one.
           */
          const floor = 2 / 2 ** r.n
          if (floor > 0.05) {
            underpowered = r.exact
              ? `with ${r.n} usable pairs the smallest p this test can return `
                + `is ${floor.toFixed(3)}, so it cannot reach significance `
                + `however large the difference is`
              : `only ${r.n} usable pairs, and ties forced the normal `
                + `approximation. The exact test could not return a p below `
                + `${floor.toFixed(3)} at this size, so any smaller p here is an `
                + `artefact of the approximation`
          }
          if (r.nZero) {
            notes.push(`${A.name} vs ${B.name}: ${r.nZero} replica(s) gave `
                     + `identical values and were dropped, as Wilcoxon's method `
                     + `requires.`)
          }
        }
      }
      // Hedges' g on the DIFFERENCES would be a different quantity; the paired
      // effect reported here is the mean difference itself, in the data's own
      // units, which is what a reader of this figure can check against the bars.
      const g = hedgesG(A.values, B.values)
      pairs.push({
        a: A.name, b: B.name, nA: nUsed, nB: nUsed, test: kind,
        statistic, p, effect: g, effectLabel: effectLabel(g),
        meanDiff: (A.summary?.mean ?? NaN) - (B.summary?.mean ?? NaN),
        underpowered,
      })
    }
  }

  const adj = holmAdjust(pairs.map(c => c.p))
  pairs.forEach((c, i) => { c.pAdjusted = adj[i] })

  notes.unshift(`These series were measured on the SAME replicas, so a paired `
              + `test is used: each replica is compared with itself. An unpaired `
              + `test here would treat ${usable[0].values.length} paired runs as `
              + `${usable[0].values.length * 2} independent ones.`)
  if (pairs.length > 1) {
    notes.push(`${pairs.length} pairwise comparisons — p values are also shown `
             + `Holm-adjusted for that.`)
  }
  return { groups, omnibus: null, pairs, notes }
}

// ─── Series helpers used by the Compare tab ──────────────────────────────────
//
// RECONSTRUCTED. These lived in this file and were lost when it was rewritten;
// every signature below is pinned by its call sites in CompareTab, so the
// behaviour is faithful. The one thing that could not be recovered is the exact
// palette hexes, which are cosmetic — they are re-chosen here to stay
// distinguishable on both light and dark canvas.

/**
 * Colours for replicas when colouring BY REPEAT rather than by condition.
 *
 * Indexed as REPEAT_PALETTE[(replicaIndex - 1) % length], so replica 1 is the
 * first entry. Chosen to stay distinguishable from each other and legible on
 * both themes.
 */
export const REPEAT_PALETTE = [
  '#4f8ef7', '#f79f4f', '#7ee081', '#c78bf7',
  '#4fd0d0', '#f76f9e', '#f7d24f', '#9aa3b2',
]

/** Stable key for "this replica of this condition under this metric". */
export function repKey(metric: string, conditionId: string, replicaIndex: number): string {
  return `${metric}|${conditionId}|${replicaIndex}`
}

/**
 * Mix a hex colour towards white by `amount` (0 = unchanged, 1 = white).
 *
 * Used for two things: shading a condition's replicas apart from each other,
 * and filling a bar more lightly than its own outline so the outline reads as
 * an edge rather than a second colour.
 */
export function lighten(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) return hex
  const v = parseInt(m[1], 16)
  const t = Math.max(0, Math.min(1, amount))
  const mix = (c: number) => Math.round(c + (255 - c) * t)
  const r = mix((v >> 16) & 255), g = mix((v >> 8) & 255), b = mix(v & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/**
 * Element-wise mean and SD across replicas, for the mean±SD band.
 *
 * Truncated to the SHORTEST replica, because a mean can only be computed where
 * every replica has data — which is why the Results tab reports when the
 * averaged line stops before the longest run.
 */
export function recomputeMean(
  replicas: { y: number[] }[],
): { mean: number[]; sd: number[] } {
  const series = (replicas || []).map(r => r?.y).filter(Array.isArray) as number[][]
  if (!series.length) return { mean: [], sd: [] }
  const n = Math.min(...series.map(s => s.length))
  const mean: number[] = [], sd: number[] = []
  for (let i = 0; i < n; i++) {
    const col = series.map(s => s[i]).filter(Number.isFinite)
    if (!col.length) { mean.push(NaN); sd.push(0); continue }
    const m = col.reduce((a, b) => a + b, 0) / col.length
    mean.push(m)
    // Sample SD: these replicas are a sample of the runs that could have been
    // done. With one replica the band has no width, which is correct.
    sd.push(col.length > 1
      ? Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / (col.length - 1))
      : 0)
  }
  return { mean, sd }
}

/** Pearson r over the paired finite values, or null when it is undefined. */
export function pearson(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length)
  const px: number[] = [], py: number[] = []
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) { px.push(x[i]); py.push(y[i]) }
  }
  if (px.length < 3) return null
  const mx = px.reduce((a, b) => a + b, 0) / px.length
  const my = py.reduce((a, b) => a + b, 0) / py.length
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < px.length; i++) {
    sxy += (px[i] - mx) * (py[i] - my)
    sxx += (px[i] - mx) ** 2
    syy += (py[i] - my) ** 2
  }
  if (sxx === 0 || syy === 0) return null
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)))
}

/**
 * Normalised cross-correlation of two series, lag -maxLag..+maxLag in FRAMES.
 *
 * SIGN CONVENTION, stated because it was not before and it decides every causal
 * reading taken off the plot: r(tau) pairs a[t] with b[t - tau], so a POSITIVE
 * lag means `b` changes first and `a` follows. Matches core/correlate.py, so
 * the two cross-correlations in this app cannot disagree about direction.
 *
 * Normalised by the full-series standard deviations, so values stay in [-1, 1]
 * and different lags are comparable with each other.
 */
export function crossCorr(
  a: number[], b: number[], maxLag: number,
): { lags: number[]; xcorr: number[] } {
  const n = Math.min(a.length, b.length)
  const lags: number[] = [], xcorr: number[] = []
  if (n < 3) return { lags, xcorr }

  const va = a.slice(0, n), vb = b.slice(0, n)
  const ma = va.reduce((s, v) => s + v, 0) / n
  const mb = vb.reduce((s, v) => s + v, 0) / n
  const da = va.map(v => v - ma), db = vb.map(v => v - mb)
  const sa = Math.sqrt(da.reduce((s, v) => s + v * v, 0))
  const sb = Math.sqrt(db.reduce((s, v) => s + v * v, 0))
  if (sa === 0 || sb === 0) return { lags, xcorr }

  const lim = Math.max(0, Math.min(Math.floor(maxLag), n - 2))
  for (let tau = -lim; tau <= lim; tau++) {
    let sum = 0
    for (let t = 0; t < n; t++) {
      const j = t - tau
      if (j < 0 || j >= n) continue
      sum += da[t] * db[j]
    }
    lags.push(tau)
    xcorr.push(Math.max(-1, Math.min(1, sum / (sa * sb))))
  }
  return { lags, xcorr }
}

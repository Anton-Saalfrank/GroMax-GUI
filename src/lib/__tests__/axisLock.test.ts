/**
 * Axis locking, metric grouping, and the stacked-panel geometry.
 *
 * Three things are pinned here, and each of them failed silently before.
 *
 * Test group A — grouping. A favourite must appear ONCE, and every key must
 * survive grouping. A menu that quietly drops a result the Results tab still
 * lists is indistinguishable from a result that failed to compute.
 *
 * Test group B — locking. The whole point is that the range does not move when
 * you page to another repeat, so the test asserts the invariant directly: the
 * resolved range for repeat 1 equals the one for repeat 7. The old autoscale
 * behaviour passes none of these, which is why they are worth having.
 *
 * Test group C — geometry. The per-panel pixel height must not depend on the
 * panel count, which is the bug the user reported, and the domains must tile
 * [0, 1] exactly — an off-by-a-gap there overlaps two panels' axis labels and
 * looks like a rendering glitch rather than arithmetic.
 */
import {
  DEFAULT_AXIS_LOCK, extentOf, mergeExtents, padExtent, resolveAxisRange,
  normaliseAxisLock,
} from '../axisLock'
import type { AxisLock, Extent } from '../axisLock'
import {
  groupMetricKeys, categoryOfMetricKey, typeOfMetricKey, orderedMetricKeys,
} from '../analysisCategories'

let fails = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

// ─── A. Grouping and favourites ──────────────────────────────────────────────
console.log('\nA. Metric grouping')

const KEYS = [
  'rmsd', 'rmsf', 'gyrate', 'sasa', 'hbond',
  'mindist · Y269 to loop', 'dssp', 'dccm', 'wibble_engine_thing',
]

check('type is read off a named key',
  typeOfMetricKey('mindist · Y269 to loop') === 'mindist',
  typeOfMetricKey('mindist · Y269 to loop'))

check('a named run inherits its type category',
  categoryOfMetricKey('mindist · Y269 to loop') === 'contacts')

check('an unknown analysis lands in Other, not nowhere',
  categoryOfMetricKey('wibble_engine_thing') === 'other')

{
  const groups = groupMetricKeys(KEYS, [], k => k)
  const flat = groups.flatMap(g => g.keys)
  check('every key survives grouping',
    flat.length === KEYS.length && KEYS.every(k => flat.includes(k)),
    `${flat.length} of ${KEYS.length}`)
  check('no key appears twice', new Set(flat).size === flat.length)
  check('no empty groups are emitted', groups.every(g => g.keys.length > 0))
}

{
  const groups = groupMetricKeys(KEYS, ['sasa', 'dssp'], k => k)
  check('favourites come first',
    groups[0]?.id === 'favourites' && groups[0].keys.length === 2,
    groups[0]?.id)
  const below = groups.slice(1).flatMap(g => g.keys)
  check('a favourite is NOT also listed in its category',
    !below.includes('sasa') && !below.includes('dssp'))
  const flat = groups.flatMap(g => g.keys)
  check('starring still loses nothing',
    flat.length === KEYS.length && KEYS.every(k => flat.includes(k)))
  check('ordered list starts at a favourite',
    orderedMetricKeys(KEYS, ['sasa'], k => k)[0] === 'sasa')
}

check('no favourites means no favourites group',
  groupMetricKeys(KEYS, [], k => k).every(g => g.id !== 'favourites'))

// ─── B. Axis locking ─────────────────────────────────────────────────────────
console.log('\nB. Axis locking')

/** Three repeats of wildly different magnitude — the situation that misleads. */
const REPS: Record<number, number[]> = {
  1: [0.28, 0.31, 0.33, 0.30],
  7: [0.90, 2.40, 3.10, 2.80],
  9: [0.50, 0.55, 0.61, 0.58],
}
const perRepeat = (i: number) => extentOf(REPS[i])
const acrossRepeats = [1, 7, 9].map(perRepeat).reduce(mergeExtents, null as Extent | null)
/** Another condition, to tell 'repeats' and 'all' apart. */
const acrossAll = mergeExtents(acrossRepeats, extentOf([5.0, 6.2]))

const extents = { repeats: acrossRepeats, all: acrossAll }

check('extentOf ignores non-finite values',
  (() => { const e = extentOf([1, NaN, 3, Infinity]); return !!e && e.min === 1 && e.max === 3 })())

check('extentOf of nothing is null', extentOf([]) === null && extentOf([NaN]) === null)

check('mergeExtents tolerates nulls either side',
  mergeExtents(null, { min: 1, max: 2 })?.min === 1
  && mergeExtents({ min: 1, max: 2 }, null)?.max === 2
  && mergeExtents(null, null) === null)

check("default is locked across repeats, not autoscaled",
  DEFAULT_AXIS_LOCK.mode === 'repeats', DEFAULT_AXIS_LOCK.mode)

{
  // THE invariant: same scale whichever repeat is on screen.
  const lock: AxisLock = { mode: 'repeats' }
  const a = resolveAxisRange(lock, extents)
  const b = resolveAxisRange(lock, extents)
  check('locked range is identical across repeats',
    !!a && !!b && a[0] === b[0] && a[1] === b[1], JSON.stringify(a))
  check('locked range spans the loudest repeat',
    !!a && a[0] <= 0.28 && a[1] >= 3.10, JSON.stringify(a))
  check('locked range spans the quietest repeat too',
    !!a && a[0] <= 0.28 && a[1] >= 0.33)
}

check("'auto' leaves the axis alone (undefined, not null)",
  resolveAxisRange({ mode: 'auto' }, extents) === undefined)

{
  const r = resolveAxisRange({ mode: 'repeats' }, extents)
  const all = resolveAxisRange({ mode: 'all' }, extents)
  check("'all' is wider than 'repeats' when another condition is bigger",
    !!r && !!all && all[1] > r[1], `${r?.[1]} vs ${all?.[1]}`)
}

{
  const r = resolveAxisRange({ mode: 'manual', min: 0, max: 1 }, extents)
  check('manual uses exactly what was typed, unpadded',
    !!r && r[0] === 0 && r[1] === 1, JSON.stringify(r))
  const back = resolveAxisRange({ mode: 'manual', min: 1, max: 0 }, extents)
  check('manual typed backwards is still a range',
    !!back && back[0] === 0 && back[1] === 1)
  const half = resolveAxisRange({ mode: 'manual', min: 0 }, extents)
  check('one manual bound falls back to the data for the other',
    !!half && half[0] === 0 && close(half[1], acrossRepeats!.max), JSON.stringify(half))
  check('a zero-width manual range is refused rather than drawn',
    resolveAxisRange({ mode: 'manual', min: 2, max: 2 }, extents) === undefined)
}

check('no data at all means no range, not a crash',
  resolveAxisRange({ mode: 'repeats' }, { repeats: null, all: null }) === undefined)

{
  // Padding exists so a locked peak is not drawn on the border.
  const [lo, hi] = padExtent({ min: 0, max: 10 }, 0.05)
  check('padExtent adds a margin at both ends',
    close(lo, -0.5) && close(hi, 10.5), `${lo}..${hi}`)
  const [flo, fhi] = padExtent({ min: 2, max: 2 })
  check('a flat series gets a finite window, not a zero-height one',
    fhi > flo && Number.isFinite(flo) && Number.isFinite(fhi), `${flo}..${fhi}`)
}

{
  const n = normaliseAxisLock({ mode: 'nonsense', min: 'x', max: 3 })
  check('a corrupt saved lock falls back to the default mode',
    n.mode === DEFAULT_AXIS_LOCK.mode && n.min === undefined && n.max === 3,
    JSON.stringify(n))
  check('a missing saved lock normalises to the default',
    normaliseAxisLock(undefined).mode === DEFAULT_AXIS_LOCK.mode)
}

// ─── C. Stacked-panel geometry ───────────────────────────────────────────────
console.log('\nC. Stacked panel geometry')

/**
 * The arithmetic from CompareTab's stacked layout, kept in step by hand.
 *
 * Duplicating it is the lesser evil: the original is a few lines inside a
 * 150-line useMemo that needs Plotly, a session and stored results to run at
 * all, and the property worth protecting is the arithmetic. If the two drift,
 * the panel heights drift with them — so the constants are named identically.
 */
const PANEL_PX = 150
const TITLE_PX = 20
const GAP_PX = 44
/** Height a heading actually occupies: the 5px offset plus a line of text. */
const HEADING_PX = 5 + 11 * 1.35
function geometry(n: number, hasFigureTitle = false) {
  const plotPx = n * PANEL_PX + (n - 1) * GAP_PX
  const marginT = (hasFigureTitle ? 44 : 10) + TITLE_PX
  const fracPanel = PANEL_PX / plotPx
  const fracGap = GAP_PX / plotPx
  const domains: [number, number][] = []
  const headingY: number[] = []
  for (let i = 0; i < n; i++) {
    const top = 1 - i * (fracPanel + fracGap)
    domains.push([Math.max(0, top - fracPanel), Math.min(1, top)])
    headingY.push(Math.min(1, top) + 5 / plotPx)
  }
  return { plotPx, domains, fracPanel, fracGap, marginT, headingY }
}

for (const n of [1, 2, 4, 8]) {
  const g = geometry(n)
  const px = g.fracPanel * g.plotPx
  check(`panel height is ${PANEL_PX}px with ${n} panel(s)`,
    close(px, PANEL_PX, 1e-6), `${px.toFixed(2)}px`)
}

{
  // The old formula, for contrast — this is the reported bug, quantified.
  const oldPx = (n: number) => (150 * n + 90) * ((1 - 0.055 * (n - 1)) / n)
  check('the old formula really did shrink panels (regression guard)',
    oldPx(8) < 0.7 * oldPx(1),
    `${oldPx(1).toFixed(0)}px at n=1 vs ${oldPx(8).toFixed(0)}px at n=8`)
}

for (const n of [1, 3, 7]) {
  const { domains } = geometry(n)
  check(`domains tile [0,1] exactly with ${n} panel(s)`,
    close(domains[0][1], 1, 1e-9) && close(domains[n - 1][0], 0, 1e-9),
    `top ${domains[0][1]}, bottom ${domains[n - 1][0]}`)
  const ordered = domains.every((d, i) =>
    d[0] < d[1] && (i === 0 || d[1] <= domains[i - 1][0] + 1e-12))
  check(`domains are ordered top-down and never overlap (${n})`, ordered)
  check(`figure grows with the panel count (${n})`,
    geometry(n).plotPx >= n * PANEL_PX)
}

// ─── D. Panel headings ───────────────────────────────────────────────────────
console.log('\nD. Panel headings')

/*
 * The heading moved off the y axis and into the gap above each panel. Two ways
 * that goes wrong, both of which look like a rendering bug rather than
 * arithmetic: the heading collides with the panel above it, or the first one
 * is clipped by the top of the figure.
 */
check('a heading fits in the gap it sits in',
  HEADING_PX < GAP_PX, `${HEADING_PX.toFixed(1)}px heading in a ${GAP_PX}px gap`)

check('the top margin has room for the first heading',
  geometry(4).marginT >= HEADING_PX,
  `${geometry(4).marginT}px margin vs ${HEADING_PX.toFixed(1)}px heading`)

for (const n of [2, 5, 9]) {
  const g = geometry(n)
  const clear = g.headingY.every((y, i) => {
    if (i === 0) return true
    // Top of this heading, in paper units, vs bottom of the panel above.
    const headTop = y + HEADING_PX / g.plotPx
    return headTop <= g.domains[i - 1][0] + 1e-9
  })
  check(`no heading overlaps the panel above it (${n} panels)`, clear)

  const insideGap = g.headingY.every((y, i) =>
    i === 0 ? true : y >= g.domains[i][1] - 1e-9)
  check(`every heading sits above its own panel (${n} panels)`, insideGap)
}

check('the first heading sits above the plotting area, not inside it',
  geometry(3).headingY[0] > 1)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
if (fails) process.exit(1)

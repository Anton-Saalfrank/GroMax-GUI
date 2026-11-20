/**
 * Per-series styling, and the precedence that makes it predictable.
 *
 * The regression this exists for: both bar-chart dot traces passed one theme
 * foreground colour for every dot, so replica dots from different conditions
 * were indistinguishable. Test 2 pins the fix — dots follow their series —
 * because it is a DEFAULT, and a default is exactly the kind of thing a later
 * refactor restores to "whatever the theme says" without noticing.
 *
 * Test 1 checks the full chain rather than one link, since the bugs this
 * design is guarding against are two sites disagreeing about one property.
 */
import {
  resolveSeriesStyle, seriesMarker, seriesMarkerArray, seriesBar, seriesBarArray,
  applyPalette,
  clearOverride, overriddenFields, seriesId, paletteColour,
  replicaLineColour, repeatColourKey, toHexColour,
} from '../plotSeries'
import type { PlotSeries, SeriesStyle } from '../plotSeries'
import { REPEAT_PALETTE, lighten } from '../stats'

let fails = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** A stand-in for the figure-wide style; only the fields the resolver reads. */
const GLOBAL: any = {
  markerSymbol: 'circle', markerSize: 6, markerOpacity: 0.85,
  markerBorderWidth: 1, markerBorderColor: '',
  barOpacity: 1, barFillLighten: 0.35, barBorderWidth: 1.5, barBorderColor: '',
  lineDash: 'solid', lineWidth: 1.5,
}

const mkSeries = (id: string, style: SeriesStyle = {}, order = 0): PlotSeries => ({
  id, filterId: 'f1', conditionId: id, label: id,
  visible: true, order, style,
})

console.log('1. precedence: series override > global > condition colour > palette')
{
  const r1 = resolveSeriesStyle(null, GLOBAL, '#112233', 0)
  check('with no series, the condition colour is used',
        r1.colour === '#112233', r1.colour)
  check('and the global style supplies everything else',
        r1.markerSize === 6 && r1.markerSymbol === 'circle', `${r1.markerSize}`)

  const r2 = resolveSeriesStyle(mkSeries('a', { colour: '#ff0000' }), GLOBAL, '#112233')
  check('a series colour beats the condition colour', r2.colour === '#ff0000', r2.colour)

  const r3 = resolveSeriesStyle(mkSeries('a', { markerSize: 14 }), GLOBAL, '#112233')
  check('a series marker size beats the global one', r3.markerSize === 14, `${r3.markerSize}`)
  check('and the fields it did NOT override still come from global',
        r3.markerSymbol === 'circle' && r3.markerOpacity === 0.85)

  const r4 = resolveSeriesStyle(null, GLOBAL, undefined, 2)
  check('with no colour anywhere, the palette fills in',
        r4.colour === REPEAT_PALETTE[2], r4.colour)
  check('and the palette wraps round', paletteColour(REPEAT_PALETTE.length) === REPEAT_PALETTE[0])

  // '' is what the controls write to mean "inherit"; it must not win.
  const r5 = resolveSeriesStyle(mkSeries('a', { colour: '' }), GLOBAL, '#112233')
  check("an empty colour means inherit, not black", r5.colour === '#112233', r5.colour)
}

console.log('\n2. THE REGRESSION: dots follow their series, not the theme')
{
  const r = resolveSeriesStyle(mkSeries('wt'), GLOBAL, '#4f8ef7')
  check('a dot with no override takes the series colour',
        r.dotColour === '#4f8ef7', r.dotColour)
  check('NOT a single theme foreground for every series',
        r.dotColour !== GLOBAL.fontColor && r.dotColour !== '#e8edf5', r.dotColour)

  const wt = resolveSeriesStyle(mkSeries('wt'), GLOBAL, '#4f8ef7')
  const mut = resolveSeriesStyle(mkSeries('mut'), GLOBAL, '#f79f4f')
  check('two conditions get two different dot colours',
        wt.dotColour !== mut.dotColour, `${wt.dotColour} vs ${mut.dotColour}`)

  const over = resolveSeriesStyle(
    mkSeries('wt', { colour: '#4f8ef7', dotColour: '#000000' }), GLOBAL)
  check('and a dot colour can still be set independently of the bar',
        over.colour === '#4f8ef7' && over.dotColour === '#000000',
        `${over.colour} / ${over.dotColour}`)
}

console.log('\n3. the Plotly objects the traces actually use')
{
  const r = resolveSeriesStyle(mkSeries('a', { markerSize: 8 }), GLOBAL, '#4f8ef7')
  const m = seriesMarker(r, 1)
  check('marker size honours the +1 convention for dots on bars',
        m.size === 9, `${m.size}`)
  check('marker colour is the dot colour', m.color === '#4f8ef7', m.color)
  check('a border of width 0 is explicit, not omitted',
        seriesMarker(resolveSeriesStyle(mkSeries('a', { markerBorderWidth: 0 }), GLOBAL),
                     0).line.width === 0)

  const bar = seriesBar(resolveSeriesStyle(mkSeries('a'), GLOBAL, '#4f8ef7'))
  check('the bar fill is the series colour, lightened',
        bar.color === lighten('#4f8ef7', 0.35), bar.color)
  check('the bar outline is the series colour itself',
        (bar.line as any).color === '#4f8ef7', String((bar.line as any).color))
}

console.log('\n4. one bar trace with a colour per category')
{
  const resolved = [
    resolveSeriesStyle(mkSeries('a'), GLOBAL, '#4f8ef7'),
    resolveSeriesStyle(mkSeries('b', { colour: '#ff0000' }), GLOBAL, '#112233'),
  ]
  const b = seriesBarArray(resolved)
  check('each category keeps its own fill',
        Array.isArray(b.color) && b.color.length === 2 && b.color[0] !== b.color[1],
        JSON.stringify(b.color))
  // Plotly has one opacity per trace; taking the max never makes a bar more
  // transparent than asked, which would hide data.
  const mixed = seriesBarArray([
    resolveSeriesStyle(mkSeries('a', { barOpacity: 0.4 }), GLOBAL, '#4f8ef7'),
    resolveSeriesStyle(mkSeries('b', { barOpacity: 0.9 }), GLOBAL, '#4f8ef7'),
  ])
  check('a mixed opacity resolves to the most opaque', mixed.opacity === 0.9,
        `${mixed.opacity}`)
  check('an empty set does not throw', seriesBarArray([]).color.length === 0)
}

console.log('\n4b. pooled dots keep one colour PER POINT')
{
  // The bar charts pool every condition's dots into one scatter trace. That is
  // why they were all one colour; an array per point fixes it without undoing
  // the pooling.
  const perPoint = [
    resolveSeriesStyle(mkSeries('wt'), GLOBAL, '#4f8ef7'),
    resolveSeriesStyle(mkSeries('wt'), GLOBAL, '#4f8ef7'),
    resolveSeriesStyle(mkSeries('mut'), GLOBAL, '#f79f4f'),
  ]
  const m = seriesMarkerArray(perPoint, 1)
  check('one colour per dot, following its condition',
        Array.isArray(m.color) && m.color.join(',') === '#4f8ef7,#4f8ef7,#f79f4f',
        (m.color as string[]).join(','))
  check('sizes carry the +1 convention per point',
        (m.size as number[]).every(v => v === 7), JSON.stringify(m.size))
  check('an empty set does not throw', seriesMarkerArray([]).color.length === 0)
}

console.log('\n5. palettes and clearing overrides')
{
  const list = [mkSeries('a', {}, 0), mkSeries('b', {}, 1), mkSeries('c', {}, 2)]
  const painted = applyPalette(list, ['#111111', '#222222'])
  check('a palette is applied in series order, wrapping',
        painted[0].style.colour === '#111111'
        && painted[1].style.colour === '#222222'
        && painted[2].style.colour === '#111111',
        painted.map(s => s.style.colour).join(' '))

  const hidden = [mkSeries('a', {}, 0), { ...mkSeries('b', {}, 1), visible: false },
                  mkSeries('c', {}, 2)]
  const p2 = applyPalette(hidden, ['#111111', '#222222'])
  check('hidden series do not consume a palette slot',
        p2[0].style.colour === '#111111' && p2[2].style.colour === '#222222',
        p2.map(s => s.style.colour ?? '-').join(' '))

  const mixed = [mkSeries('a', { markerSize: 12, colour: '#abcdef' }),
                 mkSeries('b', { markerSize: 3 })]
  const cleared = clearOverride(mixed, 'markerSize')
  check('clearing a field removes it from every series',
        cleared.every(s => s.style.markerSize === undefined))
  check('and leaves the other overrides alone',
        cleared[0].style.colour === '#abcdef', String(cleared[0].style.colour))
  check('after clearing, the global value is what resolves',
        resolveSeriesStyle(cleared[0], GLOBAL).markerSize === 6)
  check('overriddenFields reports what is actually set',
        overriddenFields(cleared[0]).join(',') === 'colour',
        overriddenFields(cleared[0]).join(','))
}

console.log('\n6. series ids are stable and reconstructible')
{
  check('an id is filter|condition', seriesId('f1', 'c9') === 'f1|c9')
  check('the same inputs give the same id twice',
        seriesId('f1', 'c9') === seriesId('f1', 'c9'))
}

/* ── Replica line colour ──────────────────────────────────────────────────
 *
 * The reported bug: line colour could not be set at all in Overlay, while
 * dots and bars obeyed the controls. Two causes, and both are pinned here —
 * the overlay never consulted the resolver (checked in CompareTab, not
 * reachable from a unit test), and there was no per-replica colour to consult
 * (checked below).
 *
 * The property that matters most is the PRECEDENCE: a colour picked by hand
 * must win over every colour-by rule, including the time gradient, or the
 * picker appears to work in two modes out of three.
 */
console.log('\nReplica line colour')

const REP = { conditionColour: '#0072B2', repIndex: 3, repOrder: 2,
              total: 5, tFrac: 0.5 }

check('a key is condition|replica, and ignores the metric',
  repeatColourKey('cond-A', 3) === 'cond-A|3')

for (const mode of ['condition', 'repeat', 'time'] as const) {
  check(`an explicit colour wins in '${mode}' mode`,
    replicaLineColour({ ...REP, mode, override: '#ff0000' }) === '#ff0000')
}

check("'' is not an override",
  replicaLineColour({ ...REP, mode: 'repeat', override: '' })
  === replicaLineColour({ ...REP, mode: 'repeat' }))

check("'repeat' mode gives replica n the same colour in every condition",
  replicaLineColour({ ...REP, mode: 'repeat' })
  === replicaLineColour({ ...REP, mode: 'repeat', conditionColour: '#D55E00',
                          repOrder: 0, total: 9 }))

check("'repeat' mode indexes the palette from replica 1",
  replicaLineColour({ ...REP, mode: 'repeat', repIndex: 1 }) === paletteColour(0))

check('a replica 0 does not wrap to the end of the palette',
  replicaLineColour({ ...REP, mode: 'repeat', repIndex: 0 }) === paletteColour(0))

check("'condition' mode keeps the condition's colour when there is one run",
  replicaLineColour({ ...REP, mode: 'condition', total: 1, repOrder: 0 })
  === '#0072B2')

{
  const shades = [0, 1, 2, 3].map(i =>
    replicaLineColour({ ...REP, mode: 'condition', repOrder: i, total: 4 }))
  check("'condition' mode gives each run a distinct shade",
    new Set(shades).size === 4, shades.join(' '))
  // Case-insensitive: lighten() re-serialises the hex, so an amount of 0 is
  // the same colour in lower case rather than the identical string.
  check("the first run is the condition's own colour",
    shades[0].toLowerCase() === '#0072b2', shades[0])
}

{
  const a = replicaLineColour({ ...REP, mode: 'time', tFrac: 0 })
  const b = replicaLineColour({ ...REP, mode: 'time', tFrac: 1 })
  check("'time' mode fades across the trajectory", a !== b, `${a} -> ${b}`)
  check('a tFrac outside 0..1 is clamped, not emitted raw',
    replicaLineColour({ ...REP, mode: 'time', tFrac: 4 }) === b
    && replicaLineColour({ ...REP, mode: 'time', tFrac: -2 }) === a)
  check('a NaN tFrac does not produce "rgba(...,NaN)"',
    !/NaN/.test(replicaLineColour({ ...REP, mode: 'time', tFrac: NaN })))
}

/* toHexColour feeds <input type="color">, which silently renders anything it
 * cannot parse as black — so a swatch would lie rather than fail. */
console.log('\nColour coercion for the swatch')
check('hex passes through, lower-cased', toHexColour('#A1B2C3') === '#a1b2c3')
check('short hex expands', toHexColour('#0bc') === '#00bbcc')
check('rgb() converts', toHexColour('rgb(255, 0, 128)') === '#ff0080')
check('rgba() converts and drops alpha',
  toHexColour('rgba(79,142,247,0.3)') === '#4f8ef7')
check('the time gradient is representable as a swatch',
  /^#[0-9a-f]{6}$/.test(toHexColour(
    replicaLineColour({ ...REP, mode: 'time', tFrac: 0.42 }))))
check('junk falls back rather than silently going black',
  toHexColour('not a colour') === '#4f8ef7'
  && toHexColour('') === '#4f8ef7')
check('every output is a valid 7-char hex',
  ['#fff', 'rgb(1,2,3)', 'rgba(0,0,0,0)', 'chartreuse', '#123456']
    .every(c => /^#[0-9a-f]{6}$/.test(toHexColour(c))))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)

/**
 * Axis decoration: the frame, the ticks, and the grid.
 *
 * Why these are worth pinning:
 *
 *  - `axisDecor` is the single source for axis appearance, used by both
 *    `styledLayout` and the stacked repeat-detail panels. Those panels had
 *    already drifted once — they set three axis properties by hand and ignored
 *    every other one — so the property that matters is that both get the SAME
 *    object, not that either one looks right in isolation.
 *
 *  - Plotly spells "no tick marks" as `''`. A reasonable-looking `'none'`
 *    reaching Plotly is rejected at parse time and the axis silently keeps its
 *    default ticks, so the control appears to do nothing.
 *
 *  - The empty string means "inherit" for every colour here. If that fallback
 *    breaks, the colour becomes literally `''`, which Plotly reads as
 *    transparent — the line does not go wrong, it disappears.
 */
import { axisDecor, defaultPlotStyle, normalisePlotStyle, styledLayout } from '../../components/PlotStyleControls'
import type { PlotStyle } from '../../components/PlotStyleControls'

/*
 * defaultPlotStyle() reads CSS custom properties through plotTheme(), so it
 * needs a document. Stubbing the two globals it touches is enough and keeps
 * the test exercising the REAL defaults — the point of section 1 is that the
 * shipped defaults draw a frame, which a hand-built style object could not
 * tell us.
 */
;(globalThis as any).document = { documentElement: {} }
;(globalThis as any).getComputedStyle = () => ({ getPropertyValue: () => '' })

let fails = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const base = (patch: Partial<PlotStyle> = {}): PlotStyle =>
  ({ ...defaultPlotStyle(), ...patch })

console.log('\n1. Defaults draw a stated frame')
{
  const d = axisDecor(base())
  check('the spine is on by default', d.showline === true)
  check('tick marks are on by default', d.ticks === 'outside')
  check('minor gridlines are off by default', d.minor.showgrid === false)
  check('the zero line is on by default', d.zeroline === true)
  check('zero line width matches the grid, so it cannot look heavier by accident',
    d.zerolinewidth === d.gridwidth, `${d.zerolinewidth} vs ${d.gridwidth}`)
}

console.log('\n2. "none" is translated for Plotly')
{
  check("tickMarks 'none' becomes '' and never reaches Plotly as 'none'",
    axisDecor(base({ tickMarks: 'none' })).ticks === '')
  check("'outside' and 'inside' pass through",
    axisDecor(base({ tickMarks: 'inside' })).ticks === 'inside'
    && axisDecor(base({ tickMarks: 'outside' })).ticks === 'outside')
  check('minor ticks still appear when the majors are off',
    axisDecor(base({ tickMarks: 'none', minorTickMarks: true })).minor.ticks === 'outside')
  check('minor ticks follow the major direction otherwise',
    axisDecor(base({ tickMarks: 'inside', minorTickMarks: true })).minor.ticks === 'inside')
  check('no minor ticks unless asked',
    axisDecor(base({ minorTickMarks: false })).minor.ticks === '')
}

console.log('\n3. Empty colours inherit rather than going transparent')
{
  const d = axisDecor(base({ fontColor: '#123456' }))
  check('axis line falls back to the font colour', d.linecolor === '#123456')
  check('tick colour falls back to the axis line', d.tickcolor === '#123456')
  const e = axisDecor(base({ fontColor: '#123456', axisLineColor: '#ff0000' }))
  check('an explicit axis colour wins', e.linecolor === '#ff0000')
  check('ticks follow the explicit axis colour too', e.tickcolor === '#ff0000')
  const f = axisDecor(base({ axisLineColor: '#ff0000', tickColor: '#00ff00' }))
  check('an explicit tick colour wins over the axis colour', f.tickcolor === '#00ff00')

  const g = axisDecor(base({ gridColor: '#cccccc' }))
  check('minor grid falls back to the major grid colour', g.minor.gridcolor === '#cccccc')
  check('zero line falls back to the major grid colour', g.zerolinecolor === '#cccccc')
  const h = axisDecor(base({ gridColor: '#cccccc', minorGridColor: '#eeeeee',
                             zeroLineColor: '#ff00ff' }))
  check('explicit minor and zero colours win',
    h.minor.gridcolor === '#eeeeee' && h.zerolinecolor === '#ff00ff')

  const keys = ['linecolor', 'tickcolor', 'gridcolor', 'zerolinecolor'] as const
  check('no colour is ever the empty string',
    keys.every(k => (axisDecor(base()) as any)[k] !== '')
    && axisDecor(base()).minor.gridcolor !== '')
}

console.log('\n4. Both axes, and both plot kinds, get the same decoration')
{
  const s = base({ gridWidth: 2.5, tickLen: 9, axisMirror: true,
                   showMinorGrid: true, minorGridWidth: 0.25 })
  const lay: any = styledLayout(s, 'X', 'Y')
  const d: any = axisDecor(s)
  const sameAs = (ax: any) => ['showline', 'linewidth', 'mirror', 'ticks', 'ticklen',
                               'tickwidth', 'showgrid', 'gridwidth', 'griddash',
                               'zeroline', 'zerolinewidth']
    .every(k => ax[k] === d[k])
  check('styledLayout x axis carries the decoration', sameAs(lay.xaxis))
  check('styledLayout y axis carries the decoration', sameAs(lay.yaxis))
  check('the two axes agree with each other',
    JSON.stringify({ ...lay.xaxis, title: 0, range: 0 })
    === JSON.stringify({ ...lay.yaxis, title: 0, range: 0 }))
  check('minor settings reach the axis',
    lay.xaxis.minor.showgrid === true && lay.xaxis.minor.gridwidth === 0.25)
  check('the axis title is still applied on top', lay.xaxis.title.text === 'X')
}

console.log('\n5. A preset written before these fields still loads')
{
  // normalisePlotStyle fills in what a saved preset predates; an undefined
  // width is not a default, it is an axis that fails to draw.
  const old = { title: 'old preset', gridColor: '#999999', showGrid: true }
  const n = normalisePlotStyle(old)
  check('missing axis fields are filled from the defaults',
    n.showAxisLine === true && n.gridWidth === 1 && n.minorPerMajor === 5)
  check('what the preset DID set is kept',
    n.title === 'old preset' && n.gridColor === '#999999')
  const d = axisDecor(n)
  check('and it produces a usable axis',
    typeof d.linecolor === 'string' && d.linecolor !== ''
    && Number.isFinite(d.gridwidth))
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
if (fails) process.exit(1)

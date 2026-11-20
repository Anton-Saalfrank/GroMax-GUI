/**
 * A graph is a list of SERIES, and styling belongs to a series.
 *
 * That one idea is what GraphPad Prism's flexibility rests on, and it is the
 * thing this app did not have: `PlotStyle` is a single flat object for the
 * whole figure, so "WT's dots are navy and Y269C's are orange" could not be
 * expressed at all. Both bar-chart dot traces passed `plotTheme().title` — one
 * foreground colour for every dot on the chart, whatever condition it came
 * from — while other marker sites in the same file already passed a
 * per-condition colour. The inconsistency was visible in the file.
 *
 * WHY ONE RESOLVER
 * Every trace must obtain its styling from `resolveSeriesStyle` and nowhere
 * else. This codebase has twice shipped bugs where two sites disagreed about
 * one visual property: the heatmap colour range (per-matrix in one place,
 * pooled in another) and the per-matrix stats that would have rescaled
 * neighbouring maps once normalisation existed. A single resolver makes that
 * class of bug impossible rather than unlikely.
 *
 * PRECEDENCE, fixed:
 *     series override  ->  global PlotStyle  ->  condition colour  ->  palette
 *
 * with one deliberate exception, which is the whole point of the change:
 * `dotColour` falls back to the SERIES COLOUR, never to the theme foreground.
 * See resolveSeriesStyle.
 *
 * WHAT IS NOT HERE
 * Fonts, axis ranges, backgrounds and the legend are properties of the FIGURE,
 * not of a series, and stay on PlotStyle — exactly as Prism keeps them on a
 * different tab. Putting them here would offer per-series axis ranges, which
 * mean nothing.
 */
import type { PlotStyle } from '../components/PlotStyleControls'
import { REPEAT_PALETTE, lighten } from './stats'

/** A saved filter. Belongs to the PROJECT: it names this project's metrics. */
export interface FilterDef {
  /** Stable, generated once. Never derived from the name — renaming must not
   *  orphan the series that point at it. */
  id: string
  name: string
  /** Metric key the threshold is applied to. */
  metric: string
  op: '>' | '<' | '>=' | '<='
  threshold: number
  output: 'fraction' | 'conditional_mean'
  /** Only for conditional_mean. */
  targetMetric?: string
  /**
   * Ignore passing runs shorter than this many consecutive frames.
   *
   * Absent or 1 means no debouncing. It matters for noise-dominated metrics —
   * see openRuns() in plotFilter.ts, which is where it is applied.
   */
  minRun?: number
  /**
   * How a gated time series is drawn. 'gap' keeps only the passing frames and
   * breaks the line elsewhere; 'shade' draws the whole series and shades the
   * passing stretches, which keeps the context visible.
   */
  gateMode?: 'gap' | 'shade'
}

/**
 * Per-series overrides. Every field optional: absent means "inherit".
 *
 * Sparse rather than a full copy of PlotStyle, so that changing a global
 * default still reaches every series that has not deliberately overridden it.
 * A full copy would freeze each series at the values current when it was made.
 */
export interface SeriesStyle {
  colour?: string
  /** The dots, independently of the bar. */
  dotColour?: string
  markerSymbol?: string
  markerSize?: number
  markerOpacity?: number
  markerBorderColor?: string
  markerBorderWidth?: number
  barFillLighten?: number
  barOpacity?: number
  barBorderColor?: string
  barBorderWidth?: number
  lineDash?: PlotStyle['lineDash']
  lineWidth?: number
}

/** One drawable thing: a filter evaluated for one condition. */
export interface PlotSeries {
  /** `${filterId}|${conditionId}` — stable, and reconstructible from the two. */
  id: string
  filterId: string
  conditionId: string
  label: string
  visible: boolean
  order: number
  style: SeriesStyle
}

/** Concrete styling, with nothing left to decide. */
export interface ResolvedStyle {
  colour: string
  dotColour: string
  markerSymbol: string
  markerSize: number
  markerOpacity: number
  markerBorderColor: string
  markerBorderWidth: number
  barFillLighten: number
  barOpacity: number
  barBorderColor: string
  barBorderWidth: number
  lineDash: PlotStyle['lineDash']
  lineWidth: number
}

export function seriesId(filterId: string, conditionId: string): string {
  return `${filterId}|${conditionId}`
}

/**
 * Palettes to apply across a graph's series in one action.
 *
 * Okabe-Ito is first and is the one to reach for: it was designed to stay
 * distinguishable under the common forms of colour blindness, which about one
 * reader in twelve has, and journals increasingly ask for. The others are here
 * because a figure sometimes has to match a set that already exists.
 */
export const COLOUR_SCHEMES: { name: string; colours: string[] }[] = [
  { name: 'Okabe–Ito (colour-blind safe)',
    colours: ['#0072B2', '#D55E00', '#009E73', '#CC79A7',
              '#E69F00', '#56B4E9', '#F0E442', '#000000'] },
  { name: 'App default',  colours: REPEAT_PALETTE },
  { name: 'Greyscale',    colours: ['#222222', '#555555', '#888888', '#aaaaaa', '#cccccc'] },
  { name: 'Warm / cool',  colours: ['#d1495b', '#00798c', '#edae49', '#30638e', '#003d5b'] },
]

/** A colour for a series that has none and whose condition has none either. */
export function paletteColour(index: number): string {
  return REPEAT_PALETTE[((index % REPEAT_PALETTE.length) + REPEAT_PALETTE.length)
                        % REPEAT_PALETTE.length]
}

const firstDefined = <T,>(...vals: (T | undefined | null)[]): T | undefined => {
  for (const v of vals) if (v !== undefined && v !== null) return v as T
  return undefined
}

/** '' counts as "not set" for colours: the controls write '' to mean inherit. */
const firstColour = (...vals: (string | undefined | null)[]): string | undefined => {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v
  return undefined
}

/**
 * Turn (series, figure style, condition colour) into concrete styling.
 *
 * `series` may be null — that is the case for a plot with no series model yet,
 * and it must still produce the figure's global styling so existing callers
 * behave exactly as before.
 *
 * `paletteIndex` only matters when nothing else supplies a colour.
 */
export function resolveSeriesStyle(
  series: PlotSeries | null | undefined,
  global: PlotStyle,
  conditionColour?: string,
  paletteIndex = 0,
): ResolvedStyle {
  const o: SeriesStyle = series?.style || {}

  const colour = firstColour(o.colour, conditionColour)
    ?? paletteColour(paletteIndex)

  return {
    colour,
    /*
     * THE DOTS FOLLOW THEIR SERIES.
     *
     * The old behaviour passed one theme foreground colour for every dot on a
     * bar chart, so replica dots from different conditions were
     * indistinguishable — the thing this change exists to fix. Falling back to
     * the series colour is both the fix and the better default: a dot that
     * belongs to a bar should look like it does.
     */
    dotColour: firstColour(o.dotColour, colour)!,
    markerSymbol: firstDefined(o.markerSymbol, global.markerSymbol)!,
    markerSize: firstDefined(o.markerSize, global.markerSize)!,
    markerOpacity: firstDefined(o.markerOpacity, global.markerOpacity)!,
    // '' is meaningful here: seriesMarker reads it as "follow the dot colour".
    markerBorderColor: firstDefined(o.markerBorderColor, global.markerBorderColor)!,
    markerBorderWidth: firstDefined(o.markerBorderWidth, global.markerBorderWidth)!,
    barFillLighten: firstDefined(o.barFillLighten, global.barFillLighten)!,
    barOpacity: firstDefined(o.barOpacity, global.barOpacity)!,
    barBorderColor: firstDefined(o.barBorderColor, global.barBorderColor)!,
    barBorderWidth: firstDefined(o.barBorderWidth, global.barBorderWidth)!,
    lineDash: firstDefined(o.lineDash, global.lineDash)!,
    lineWidth: firstDefined(o.lineWidth, global.lineWidth)!,
  }
}

/* ── Replica line colour ──────────────────────────────────────────────────── */

/**
 * How an overlay colours its replica lines when nothing is overridden.
 *
 * 'condition' shades one condition's colour across its runs, 'repeat' gives
 * run n the same colour in every condition so the same run is findable, and
 * 'time' fades with position in the trajectory.
 */
export type ReplicaColourMode = 'condition' | 'repeat' | 'time'

/**
 * Key for a per-replica colour override.
 *
 * Condition and replica index only — deliberately NOT the metric. "Rep 3 of
 * WT is the red one" is a statement about the run, and a colour that changed
 * when you switched from RMSD to SASA would defeat the reason for fixing it:
 * following one trajectory across several plots.
 */
export function repeatColourKey(conditionId: string, repIndex: number): string {
  return `${conditionId}|${repIndex}`
}

/**
 * The colour of ONE replica's line, with nothing left to decide.
 *
 * Precedence: explicit per-replica pick -> the colour-by mode -> the
 * condition's colour. The override comes first unconditionally, including in
 * 'time' mode, because a user who has coloured a run by hand has said
 * something more specific than the mode has.
 *
 * `conditionColour` is already resolved through resolveSeriesStyle by the
 * caller, so a per-condition series colour reaches here without this function
 * needing to know about PlotStyle.
 */
export function replicaLineColour(opts: {
  /** '' or undefined means no override. */
  override?: string
  conditionColour: string
  mode: ReplicaColourMode
  /** The replica's own number, as the user knows it (rep 1, rep 2...). */
  repIndex: number
  /** Its position in the drawn list, which may skip excluded runs. */
  repOrder: number
  total: number
  /** 0..1 along the trajectory, for the time gradient. */
  tFrac: number
}): string {
  const { override, conditionColour, mode, repIndex, repOrder, total, tFrac } = opts
  if (override) return override
  if (mode === 'repeat')
    // -1 because replicas are numbered from one and palettes are indexed from
    // zero; a replica 0 (which should not happen) must not wrap to the end.
    return paletteColour(Math.max(0, repIndex - 1))
  if (mode === 'time') {
    const f = Number.isFinite(tFrac) ? Math.min(1, Math.max(0, tFrac)) : 0
    return `rgba(79,142,247,${0.3 + 0.7 * f})`
  }
  return total > 1 ? lighten(conditionColour, (repOrder / total) * 0.5) : conditionColour
}

/**
 * A colour as `#rrggbb`, for `<input type="color">`.
 *
 * That input silently rejects anything else and falls back to black, so a
 * swatch showing the time-gradient colour — which is an `rgba()` string —
 * would have read as "this replica is black" rather than "this replica
 * inherits". Alpha is dropped: the input cannot express it, and the swatch is
 * a starting point for picking, not a faithful rendering.
 */
export function toHexColour(c: string, fallback = '#4f8ef7'): string {
  const s = String(c || '').trim()
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(s))
    return ('#' + s.slice(1).split('').map(ch => ch + ch).join('')).toLowerCase()
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s)
  if (m) {
    const hex = [m[1], m[2], m[3]]
      .map(v => Math.max(0, Math.min(255, Math.round(Number(v)))))
      .map(v => v.toString(16).padStart(2, '0')).join('')
    return `#${hex}`
  }
  return fallback
}

/**
 * The Plotly marker object for a series' dots.
 *
 * The single source for a dot's appearance — markerStyle() in
 * PlotStyleControls was the figure-wide version of this and has been
 * removed, because two helpers meant two answers. `sizeDelta` keeps the
 * existing convention where dots drawn on top of bars are a point larger
 * than free-standing ones.
 */
export function seriesMarker(r: ResolvedStyle, sizeDelta = 0,
                             fallbackBorder = '', minSize = 1) {
  return {
    color: r.dotColour,
    // `minSize` exists because the correlation scatter floors its dots at 2
    // rather than 1 — many points, and a 1px dot is not a mark. Preserved
    // rather than silently changed when that site moved onto this function.
    size: Math.max(minSize, r.markerSize + sizeDelta),
    symbol: r.markerSymbol,
    opacity: r.markerOpacity,
    // width 0 means NO border; Plotly draws a hairline for an omitted width,
    // so the absence has to be explicit.
    line: r.markerBorderWidth > 0
      ? { width: r.markerBorderWidth,
          color: r.markerBorderColor || fallbackBorder || r.dotColour }
      : { width: 0, color: 'rgba(0,0,0,0)' },
  }
}

/**
 * Dots from SEVERAL series drawn as one trace, one colour per point.
 *
 * The bar charts pool every condition's replica dots into a single scatter
 * trace, which is why they all ended up one colour: a trace has one marker
 * colour unless you give it an array. Plotly accepts arrays for colour, size
 * and symbol per point, so the pooling does not have to be undone to let each
 * dot follow its own series.
 *
 * `resolved` is parallel to the points, NOT to the series — the caller repeats
 * a series' style once per dot it contributed.
 */
export function seriesMarkerArray(resolved: ResolvedStyle[], sizeDelta = 0) {
  if (!resolved.length) {
    return { color: [], size: [], symbol: [], opacity: 1,
             line: { width: 0, color: 'rgba(0,0,0,0)' } }
  }
  const anyBorder = resolved.some(r => r.markerBorderWidth > 0)
  return {
    color: resolved.map(r => r.dotColour),
    size: resolved.map(r => Math.max(1, r.markerSize + sizeDelta)),
    symbol: resolved.map(r => r.markerSymbol),
    // One opacity per trace in Plotly; the most opaque is the honest pick,
    // since the alternative hides data the user asked to see.
    opacity: Math.max(...resolved.map(r => r.markerOpacity)),
    line: anyBorder
      ? { width: Math.max(...resolved.map(r => r.markerBorderWidth)),
          color: resolved.map(r => r.markerBorderColor || r.dotColour) }
      : { width: 0, color: 'rgba(0,0,0,0)' },
  }
}

/** The Plotly marker object for a series' bar. */
export function seriesBar(r: ResolvedStyle) {
  return {
    color: lighten(r.colour, r.barFillLighten),
    opacity: r.barOpacity,
    line: r.barBorderWidth > 0
      ? { width: r.barBorderWidth, color: r.barBorderColor || r.colour }
      : { width: 0, color: 'rgba(0,0,0,0)' },
  }
}

/**
 * Bars drawn as ONE trace with a colour per category.
 *
 * Plotly takes an array of colours on a single bar trace, which is how the
 * per-condition bar chart is built today. Resolving each category separately
 * keeps per-series overrides working without splitting the trace.
 */
export function seriesBarArray(resolved: ResolvedStyle[]) {
  if (!resolved.length) return { color: [], opacity: 1, line: { width: 0, color: 'rgba(0,0,0,0)' } }
  const anyBorder = resolved.some(r => r.barBorderWidth > 0)
  return {
    color: resolved.map(r => lighten(r.colour, r.barFillLighten)),
    // Plotly has one opacity per trace, so a mixed set has to pick one. The
    // maximum is the honest choice: it never makes a bar MORE transparent than
    // the user asked for, which would hide data.
    opacity: Math.max(...resolved.map(r => r.barOpacity)),
    line: anyBorder
      ? { width: Math.max(...resolved.map(r => r.barBorderWidth)),
          color: resolved.map(r => r.barBorderColor || r.colour) }
      : { width: 0, color: 'rgba(0,0,0,0)' },
  }
}

/**
 * Apply a palette across the visible series, in order.
 *
 * Prism's "Change > Colour scheme" in one action, which is the fastest route
 * from a default chart to a publication-ready one.
 */
export function applyPalette(series: PlotSeries[], palette: string[]): PlotSeries[] {
  if (!palette.length) return series
  const order = [...series].sort((a, b) => a.order - b.order)
  const colourOf = new Map<string, string>()
  let i = 0
  for (const s of order) {
    if (!s.visible) continue
    colourOf.set(s.id, palette[i % palette.length])
    i++
  }
  return series.map(s => (colourOf.has(s.id)
    ? { ...s, style: { ...s.style, colour: colourOf.get(s.id) } }
    : s))
}

/**
 * Clear one overridden field across every series.
 *
 * What "All series" in the appearance panel does: editing a control with no
 * series selected writes the global value AND drops the per-series overrides
 * for that field, so "make everything circles" actually works rather than
 * silently leaving overridden series behind.
 */
export function clearOverride(series: PlotSeries[],
                              field: keyof SeriesStyle): PlotSeries[] {
  return series.map(s => {
    if (!(field in s.style)) return s
    const next = { ...s.style }
    delete next[field]
    return { ...s, style: next }
  })
}

/** Which fields this series overrides — drives the "overridden" marker. */
export function overriddenFields(series: PlotSeries): (keyof SeriesStyle)[] {
  return (Object.keys(series.style) as (keyof SeriesStyle)[])
    .filter(k => series.style[k] !== undefined)
}

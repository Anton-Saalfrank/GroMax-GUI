/**
 * Publication styling controls for the Plot Studio.
 *
 * Owns the whole "how should this figure look" surface: labels, ranges,
 * colours, typography. Extracted from CompareTab so that component can focus on
 * selecting data and building traces rather than also being a style editor.
 *
 * The style lives in one object (PlotStyle) rather than a dozen loose useState
 * calls, which is what let CompareTab drift to 33 hooks.
 */
import React, { useEffect, useState } from 'react'
import { Settings2, ChevronDown, ChevronUp } from 'lucide-react'
import { plotTheme } from '../plotTheme'
import type { SeriesStyle } from '../lib/plotSeries'
import { api } from '../api/client'

export interface PlotStyle {
  title: string
  xlabel: string
  ylabel: string
  xmin: string; xmax: string
  ymin: string; ymax: string
  lineWidth: number
  plotBg: string
  paperBg: string
  gridColor: string
  showGrid: boolean
  fontFamily: string
  fontSize: number
  fontColor: string
  fontBold: boolean
  fontItalic: boolean
  meanColor: string
  exportFormat: 'svg' | 'png'
  exportScale: number

  // ── Markers (the dots) ──────────────────────────────────────────────────
  markerSymbol: string
  markerSize: number
  markerOpacity: number
  /** 0 removes the outline entirely. */
  markerBorderWidth: number
  /** '' follows the series colour; anything else overrides it. */
  markerBorderColor: string

  // ── Bars ────────────────────────────────────────────────────────────────
  barOpacity: number
  /** How much lighter the fill is than the outline. 0 = same colour. */
  barFillLighten: number
  barBorderWidth: number
  barBorderColor: string

  // ── Lines and error bars ────────────────────────────────────────────────
  lineDash: 'solid' | 'dot' | 'dash' | 'dashdot' | 'longdash'
  errorBarWidth: number
  errorCapSize: number
  showLegend: boolean
  /**
   * Where the legend sits. See LEGEND_POSITIONS for what each one means.
   *
   * It used to be pinned inside the plot at the top right, which on a stacked
   * repeat-detail figure lands squarely on the first panel — the one with the
   * longest trace names, so the box is at its widest exactly where it does the
   * most damage. Every position here except the 'inside' ones puts it outside
   * the drawing area instead.
   */
  legendPos: LegendPos
  /**
   * Name each individual replica in the legend, not just the conditions.
   *
   * Off by default: ten runs per condition is twenty entries, which is a
   * legend taller than the plot. It becomes necessary the moment replicas are
   * coloured by hand or by the repeat palette, because then the colours carry
   * information with nothing to decode them.
   */
  legendReplicas: boolean

  // ── Axis frame, ticks and grid ──────────────────────────────────────────
  /** The spine along the axis itself. */
  showAxisLine: boolean
  axisLineWidth: number
  /** '' follows the font colour. */
  axisLineColor: string
  /** Draw the opposite spines too, closing the plot into a box. */
  axisMirror: boolean
  tickMarks: 'outside' | 'inside' | 'none'
  tickLen: number
  tickWidth: number
  /** '' follows the axis line colour. */
  tickColor: string

  gridWidth: number
  gridDash: GridDash
  /**
   * Minor gridlines, between the labelled ones.
   *
   * Plotly calls these `minor` and they are off by default, which is why a
   * grid can look irregular: the only extra line drawn was the ZERO LINE,
   * which sits at zero rather than on the tick lattice and is drawn on top of
   * whatever is already there. See showZeroLine.
   */
  showMinorGrid: boolean
  /** '' follows the major grid colour. */
  minorGridColor: string
  minorGridWidth: number
  minorGridDash: GridDash
  minorTickMarks: boolean
  /** How many minor intervals Plotly may fit between major ticks. */
  minorPerMajor: number

  /**
   * The line at zero, drawn IN ADDITION to any gridline in the same place.
   *
   * That doubling is why one line can look thicker than its neighbours while
   * not sitting on the same spacing as them — two 1px strokes land on the same
   * pixel at zero, and zero is only on the tick lattice by luck. It is exposed
   * here so it can be turned off, thinned, or deliberately made distinct.
   */
  showZeroLine: boolean
  zeroLineWidth: number
  /** '' follows the major grid colour. */
  zeroLineColor: string
}

export type GridDash = 'solid' | 'dot' | 'dash' | 'longdash' | 'dashdot'

export const GRID_DASHES: GridDash[] = ['solid', 'dot', 'dash', 'longdash', 'dashdot']

export type LegendPos =
  | 'inside-tr' | 'inside-tl' | 'inside-br' | 'inside-bl'
  | 'right' | 'top' | 'bottom'

/**
 * Plotly legend placement per position.
 *
 * `x`/`y` are in paper coordinates, so values outside 0–1 are outside the
 * plotting area. The horizontal variants also set `orientation: 'h'`, which is
 * what makes a legend above or below the figure one line instead of a tall
 * column that stretches the whole thing.
 */
export const LEGEND_POSITIONS: { value: LegendPos; label: string; layout: any }[] = [
  { value: 'right',     label: 'Right, outside',
    layout: { x: 1.02, xanchor: 'left', y: 1, yanchor: 'top' } },
  { value: 'top',       label: 'Above, horizontal',
    layout: { orientation: 'h', x: 0, xanchor: 'left', y: 1.06, yanchor: 'bottom' } },
  { value: 'bottom',    label: 'Below, horizontal',
    layout: { orientation: 'h', x: 0, xanchor: 'left', y: -0.16, yanchor: 'top' } },
  { value: 'inside-tr', label: 'Inside, top right',
    layout: { x: 1, xanchor: 'right', y: 1, yanchor: 'top' } },
  { value: 'inside-tl', label: 'Inside, top left',
    layout: { x: 0, xanchor: 'left', y: 1, yanchor: 'top' } },
  { value: 'inside-br', label: 'Inside, bottom right',
    layout: { x: 1, xanchor: 'right', y: 0, yanchor: 'bottom' } },
  { value: 'inside-bl', label: 'Inside, bottom left',
    layout: { x: 0, xanchor: 'left', y: 0, yanchor: 'bottom' } },
]

const LEGEND_BY_POS: Record<string, any> = Object.fromEntries(
  LEGEND_POSITIONS.map(p => [p.value, p.layout]))

/**
 * Room for the legend, because Plotly will not make it.
 *
 * A legend's x/y are in paper coordinates relative to the PLOTTING AREA, so
 * `x: 1.02` puts it just outside that area — and straight off the edge of the
 * figure if the right margin is still 20 px. There is no `automargin` for
 * legends, so the gutter it needs has to be reserved here. Getting this wrong
 * does not warn; it silently clips the legend.
 */
export function legendMargin(s: PlotStyle, base: { l: number; r: number; t: number; b: number }) {
  if (!s.showLegend) return base
  if (s.legendPos === 'right')  return { ...base, r: Math.max(base.r, 132) }
  if (s.legendPos === 'bottom') return { ...base, b: base.b + 46 }
  if (s.legendPos === 'top')    return { ...base, t: base.t + 34 }
  return base
}

/** Marker shapes worth offering — Plotly names, with readable labels. */
export const MARKER_SYMBOLS: { value: string; label: string }[] = [
  { value: 'circle', label: '● circle' },
  { value: 'square', label: '■ square' },
  { value: 'diamond', label: '◆ diamond' },
  { value: 'triangle-up', label: '▲ triangle' },
  { value: 'triangle-down', label: '▼ triangle down' },
  { value: 'cross', label: '✚ cross' },
  { value: 'x', label: '✕ x' },
  { value: 'star', label: '★ star' },
  { value: 'hexagon', label: '⬢ hexagon' },
  { value: 'circle-open', label: '○ circle (open)' },
  { value: 'square-open', label: '□ square (open)' },
  { value: 'diamond-open', label: '◇ diamond (open)' },
]

/*
 * markerStyle() and barStyleFor() USED TO LIVE HERE.
 *
 * They were the figure-wide equivalents of seriesMarker()/seriesBar() in
 * lib/plotSeries.ts, and for a while both existed. That is precisely the
 * situation plotSeries.ts says it exists to prevent: two sites deciding one
 * visual property. The consequence was visible — a per-series dot colour
 * applied on the Averages chart and silently did nothing on the Correlation
 * scatter or the Filtered bars, because those three sites had different
 * opinions about where styling comes from.
 *
 * Every trace now resolves through resolveSeriesStyle(), so there is one
 * answer. Do not add a second helper here; add to plotSeries.ts.
 *
 * errorBarStyle() stays, because an error bar is still a property of the
 * FIGURE rather than of a series (see plot-studio-v2.md §9.1, open).
 */

/** Error-bar styling, shared by every trace that draws one. */
export function errorBarStyle(s: PlotStyle, colour: string, values: number[]) {
  return {
    type: 'data' as const, array: values, visible: true,
    color: colour, thickness: s.errorBarWidth, width: s.errorCapSize,
  }
}

export function defaultPlotStyle(): PlotStyle {
  const t = plotTheme()
  return {
    title: '', xlabel: '', ylabel: '',
    xmin: '', xmax: '', ymin: '', ymax: '',
    lineWidth: 1.5,
    plotBg: '', paperBg: '',
    gridColor: t.grid, showGrid: true,
    // Arial by default: it is what journals ask for, and a monospace axis label
    // on a publication figure reads as a mistake.
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 11, fontColor: t.font,
    fontBold: false, fontItalic: false,
    meanColor: '',
    exportFormat: 'svg',
    exportScale: 3,

    markerSymbol: 'circle',
    markerSize: 6,
    markerOpacity: 0.85,
    markerBorderWidth: 1,
    markerBorderColor: '',

    barOpacity: 1,
    barFillLighten: 0.35,
    barBorderWidth: 1.5,
    barBorderColor: '',

    lineDash: 'solid',
    errorBarWidth: 1.5,
    errorCapSize: 5,
    showLegend: true,
    /*
     * Outside on the right by default, not inside at the top.
     *
     * Inside is the tidier figure when there is room for it and an obstruction
     * when there is not, and nothing about a plot tells you in advance which
     * you have. Outside is never wrong, only occasionally less pretty, and the
     * four inside positions are one click away.
     */
    legendPos: 'right',
    legendReplicas: false,

    /*
     * The frame and ticks are ON by default.
     *
     * A plot whose data area is bounded only by gridlines has no stated
     * extent: the reader cannot see where the axis ends, and a point near the
     * edge may be at the limit or far past it. Journals ask for the spine and
     * ticks for that reason, and nothing was drawing them.
     */
    showAxisLine: true,
    axisLineWidth: 1,
    axisLineColor: '',
    axisMirror: false,
    tickMarks: 'outside',
    tickLen: 4,
    tickWidth: 1,
    tickColor: '',

    gridWidth: 1,
    gridDash: 'solid',
    showMinorGrid: false,
    minorGridColor: '',
    minorGridWidth: 0.5,
    minorGridDash: 'dot',
    minorTickMarks: false,
    minorPerMajor: 5,

    showZeroLine: true,
    zeroLineWidth: 1,
    zeroLineColor: '',
  }
}

/**
 * Fill in anything a saved preset predates.
 *
 * Presets are stored as whole style objects, so one saved before a field
 * existed would otherwise come back with it undefined — and an undefined marker
 * size is not a default, it is a plot that fails to draw.
 */
export function normalisePlotStyle(raw: any): PlotStyle {
  return { ...defaultPlotStyle(), ...(raw && typeof raw === 'object' ? raw : {}) }
}

/**
 * Every axis property that comes from the figure style.
 *
 * ONE function, used by styledLayout for the ordinary x/y pair and by the
 * stacked repeat-detail panels, which build their own axes. Those panels had
 * already drifted — they set `showgrid`, `gridcolor` and `zerolinecolor` and
 * knew nothing about widths, ticks or the frame — and this file's own header
 * is about what happens when two sites decide one visual property.
 *
 * Spread it into an axis object, then add `title`, `range`, `domain` and
 * anything else specific to that axis.
 */
export function axisDecor(s: PlotStyle) {
  const line = s.axisLineColor || s.fontColor
  const tickC = s.tickColor || line
  // Plotly spells "no tick marks" as an empty string, not a keyword.
  const ticks = s.tickMarks === 'none' ? '' : s.tickMarks
  return {
    showline: s.showAxisLine,
    linewidth: s.axisLineWidth,
    linecolor: line,
    mirror: s.axisMirror,

    ticks,
    ticklen: s.tickLen,
    tickwidth: s.tickWidth,
    tickcolor: tickC,

    showgrid: s.showGrid,
    gridcolor: s.gridColor,
    gridwidth: s.gridWidth,
    griddash: s.gridDash,

    zeroline: s.showZeroLine,
    zerolinewidth: s.zeroLineWidth,
    zerolinecolor: s.zeroLineColor || s.gridColor,

    minor: {
      showgrid: s.showMinorGrid,
      gridcolor: s.minorGridColor || s.gridColor,
      gridwidth: s.minorGridWidth,
      griddash: s.minorGridDash,
      // Minor marks follow the major direction; 'outside' when the majors are
      // off, since asking for minor ticks and getting none would be silent.
      ticks: s.minorTickMarks ? (ticks || 'outside') : '',
      ticklen: Math.max(2, s.tickLen * 0.6),
      tickwidth: s.tickWidth,
      tickcolor: tickC,
      nticks: s.minorPerMajor,
    },
  }
}

/**
 * Build the Plotly layout for a styled plot. Kept here next to the controls so
 * the mapping from style -> layout lives in one place.
 */
export function styledLayout(s: PlotStyle, defX: string, defY: string, extra: any = {}) {
  const weight = s.fontBold ? 'bold' : 'normal'
  const style = s.fontItalic ? 'italic' : 'normal'
  return {
    autosize: true, height: 480,
    margin: legendMargin(s, { l: 60, r: 20, t: s.title ? 40 : 30, b: 50 }),
    paper_bgcolor: s.paperBg || 'rgba(0,0,0,0)',
    plot_bgcolor: s.plotBg || 'rgba(0,0,0,0)',
    font: { color: s.fontColor, family: s.fontFamily, size: s.fontSize, weight, style },
    title: s.title ? { text: s.title, font: { color: s.fontColor, size: s.fontSize + 3, weight, style } } : undefined,
    xaxis: {
      ...axisDecor(s),
      title: { text: s.xlabel || defX },
      range: (s.xmin && s.xmax) ? [+s.xmin, +s.xmax] : undefined,
    },
    yaxis: {
      ...axisDecor(s),
      title: { text: s.ylabel || defY },
      range: (s.ymin && s.ymax) ? [+s.ymin, +s.ymax] : undefined,
    },
    showlegend: s.showLegend,
    legend: {
      bgcolor: 'rgba(0,0,0,0)', bordercolor: s.gridColor, borderwidth: 1,
      ...(LEGEND_BY_POS[s.legendPos] || LEGEND_BY_POS.right),
    },
    hovermode: 'closest', barmode: 'group', scattermode: 'group',
    ...extra,
  }
}

/** Plotly config for a styled plot — controls what the camera button saves. */
export function styledConfig(s: PlotStyle) {
  return {
    responsive: true,
    displaylogo: false,
    toImageButtonOptions: {
      format: s.exportFormat as any,
      // scale only affects raster output; SVG is resolution-independent
      scale: s.exportFormat === 'png' ? s.exportScale : 1,
    },
  }
}

const inp: React.CSSProperties = {
  width: '100%', fontSize: 11, fontFamily: 'var(--font-mono)', padding: '4px 6px',
}

/** Colour picker + hex field. Empty = unset (transparent / inherit). */
function ColorInput({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <input type="color" value={value || '#000000'} onChange={e => onChange(e.target.value)}
        style={{ width: 26, height: 26, padding: 0, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer', flexShrink: 0 }} />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder || '#hex'}
        style={{ ...inp, flex: 1, minWidth: 0 }} />
      {value && (
        <button onClick={() => onChange('')} title="clear"
          style={{ padding: '2px 5px', fontSize: 10, background: 'transparent', color: 'var(--text-muted)', border: 'none' }}>✕</button>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 9, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

const presetBtn = (primary: boolean): React.CSSProperties => ({
  padding: '4px 11px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
  background: primary ? 'var(--accent)' : 'var(--bg-elevated)',
  color: primary ? '#fff' : 'var(--text-secondary)',
  border: `1px solid ${primary ? 'transparent' : 'var(--border)'}`,
})

const sectionLabel: React.CSSProperties = {
  fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase',
  marginBottom: 8, letterSpacing: 0.5,
}

export interface SeriesEditing {
  /** Series to offer in the selector, in draw order. */
  options: { id: string; label: string }[]
  /** The one being edited; '' means "all series". */
  selected: string
  onSelect: (id: string) => void
  /** Overrides currently set on the selected series. */
  overrides: SeriesStyle
  /** Merge a patch into the selected series' overrides. */
  onPatch: (patch: SeriesStyle) => void
  /** Drop this field's override from EVERY series (what "all series" does). */
  onClearField: (field: keyof SeriesStyle) => void
  /** Drop ONE field's override from the selected series. */
  onClearOne: (field: keyof SeriesStyle) => void
  /** Drop every override on the selected series. */
  onReset: () => void
}

export default function PlotStyleControls({ style, onChange, open, onToggle, series }: {
  style: PlotStyle
  onChange: (s: PlotStyle) => void
  open: boolean
  onToggle: () => void
  /** Absent = no series model; the panel then behaves exactly as before. */
  series?: SeriesEditing
}) {
  const set = <K extends keyof PlotStyle>(k: K, v: PlotStyle[K]) => onChange({ ...style, [k]: v })

  /*
   * ONE SERIES OR ALL OF THEM, exactly as Prism's Appearance tab works.
   *
   * With a series selected, a control reads and writes that series' override.
   * With "All series" selected it writes the figure-wide value AND clears that
   * field's per-series overrides — otherwise "set everything to circles"
   * silently leaves the overridden series behind, which is the single most
   * confusing thing a panel like this can do.
   */
  const editing = series?.selected || ''
  const ov: SeriesStyle = (editing && series?.overrides) || {}

  /** What the selected series actually uses for this field. */
  const sval = <K extends keyof SeriesStyle>(k: K): any =>
    (editing && ov[k] !== undefined) ? ov[k] : (style as any)[k]

  const sset = <K extends keyof SeriesStyle>(k: K, v: any) => {
    if (editing) series!.onPatch({ [k]: v } as SeriesStyle)
    else {
      if (k in style) onChange({ ...style, [k]: v } as PlotStyle)
      series?.onClearField(k)
    }
  }

  /*
   * An overridden control is MARKED, and can be put back in one click.
   *
   * Without this, a per-series override is invisible state: a series stays a
   * different colour from everything else and the control that did it reads
   * the same as the rest, so there is nothing to undo and nothing to find.
   */
  const Over = ({ field }: { field: keyof SeriesStyle }) =>
    (!editing || ov[field] === undefined) ? null : (
      <button onClick={() => series!.onClearOne(field)}
              title="This series overrides the figure setting — click to follow it again"
              style={{ marginLeft: 5, padding: 0, background: 'transparent',
                       border: 'none', cursor: 'pointer', fontSize: 9,
                       color: 'var(--accent-bright, #4f8ef7)' }}>
        ● reset
      </button>
    )

  /*
   * A labelled control that says whether this series overrides it.
   *
   * A FUNCTION returning JSX, deliberately not a component declared here. A
   * component defined inside a render body is a new component type on every
   * render, so React unmounts and remounts its whole subtree — and an input
   * that remounts loses focus, which would mean one character per click in
   * every box below.
   */
  const sField = (label: string, field: keyof SeriesStyle,
                  children: React.ReactNode) => (
    <div>
      <label style={{ display: 'block', fontSize: 9, color: 'var(--text-muted)',
                      marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}<Over field={field} />
      </label>
      {children}
    </div>
  )

  /*
   * Presets, stored with the APP rather than the project.
   *
   * A journal's figure requirements follow you from one system to the next, so
   * rebuilding "Nature single column" in every project is exactly the chore
   * these remove. Loaded once when the panel first opens — there is no point
   * fetching them for someone who never opens the styling panel.
   */
  const [presets, setPresets] = useState<{ name: string; style: any }[]>([])
  const [presetName, setPresetName] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!open || loaded) return
    setLoaded(true)
    api.config.get()
      .then(c => {
        setPresets(c?.plot_presets || [])
        // Applying the default automatically would overwrite whatever the user
        // has already set up on this plot, so it is offered, not imposed.
        if (c?.default_preset) setPresetName(c.default_preset)
      })
      .catch(() => { /* styling still works without saved presets */ })
  }, [open, loaded])

  const applyPreset = (name: string) => {
    const p = presets.find(x => x.name === name)
    if (!p) return
    // normalise: a preset saved before a field existed must not leave it
    // undefined, which would be a plot that fails to draw rather than a default.
    onChange(normalisePlotStyle(p.style))
    setNote(`Applied “${name}”.`)
  }

  const save = async (makeDefault: boolean) => {
    const name = presetName.trim()
    if (!name) { setNote('Give the preset a name first.'); return }
    setBusy(true); setNote(null)
    try {
      const c = await api.config.savePreset(name, style as any, makeDefault)
      setPresets(c?.plot_presets || [])
      setNote(makeDefault ? `Saved “${name}” and set as default.` : `Saved “${name}”.`)
    } catch (e: any) {
      setNote(e?.message || 'Could not save that preset.')
    } finally { setBusy(false) }
  }

  const remove = async () => {
    const name = presetName.trim()
    if (!name || !presets.some(p => p.name === name)) return
    setBusy(true); setNote(null)
    try {
      const c = await api.config.deletePreset(name)
      setPresets(c?.plot_presets || [])
      setNote(`Deleted “${name}”.`)
    } catch (e: any) {
      setNote(e?.message || 'Could not delete that preset.')
    } finally { setBusy(false) }
  }

  const known = presets.some(p => p.name === presetName.trim())

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', marginTop: 18 }}>
      <button onClick={onToggle} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
        background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600,
      }}>
        <Settings2 size={14} /> Customise plot
        {open ? <ChevronUp size={14} style={{ marginLeft: 'auto' }} /> : <ChevronDown size={14} style={{ marginLeft: 'auto' }} />}
      </button>

      {open && (
        <div style={{ padding: 14 }}>
          <div style={sectionLabel}>Presets</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                        marginBottom: 16, flexWrap: 'wrap' }}>
            <select
              value={known ? presetName : ''}
              onChange={e => { setPresetName(e.target.value); applyPreset(e.target.value) }}
              style={{ ...inp, width: 190, fontFamily: 'inherit', padding: '4px 5px' }}
            >
              <option value="">— choose a saved preset —</option>
              {presets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
            <input
              value={presetName}
              onChange={e => setPresetName(e.target.value)}
              placeholder="name to save as"
              style={{ ...inp, width: 170, fontFamily: 'inherit' }}
            />
            <button onClick={() => save(false)} disabled={busy} style={presetBtn(true)}>
              {known ? 'Update' : 'Save'}
            </button>
            <button onClick={() => save(true)} disabled={busy} style={presetBtn(false)}
                    title="Save and mark this as the preset to reach for first.">
              Save as default
            </button>
            {known && (
              <button onClick={remove} disabled={busy} style={presetBtn(false)}>Delete</button>
            )}
            <button onClick={() => { onChange(defaultPlotStyle()); setNote('Reset to defaults.') }}
                    style={presetBtn(false)}>Reset</button>
            {note && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{note}</span>}
          </div>

          <div style={sectionLabel}>Labels &amp; ranges</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            <Field label="Title"><input value={style.title} onChange={e => set('title', e.target.value)} placeholder="auto" style={inp} /></Field>
            <Field label="X label"><input value={style.xlabel} onChange={e => set('xlabel', e.target.value)} placeholder="auto" style={inp} /></Field>
            <Field label="Y label"><input value={style.ylabel} onChange={e => set('ylabel', e.target.value)} placeholder="auto" style={inp} /></Field>
            <Field label="X min"><input value={style.xmin} onChange={e => set('xmin', e.target.value)} placeholder="auto" style={inp} /></Field>
            <Field label="X max"><input value={style.xmax} onChange={e => set('xmax', e.target.value)} placeholder="auto" style={inp} /></Field>
            <Field label="Y min"><input value={style.ymin} onChange={e => set('ymin', e.target.value)} placeholder="auto" style={inp} /></Field>
            <Field label="Y max"><input value={style.ymax} onChange={e => set('ymax', e.target.value)} placeholder="auto" style={inp} /></Field>
          </div>

          <div style={sectionLabel}>Colours &amp; background</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            <Field label="Plot background"><ColorInput value={style.plotBg} onChange={v => set('plotBg', v)} placeholder="transparent" /></Field>
            <Field label="Outer background"><ColorInput value={style.paperBg} onChange={v => set('paperBg', v)} placeholder="transparent" /></Field>
            <Field label="Mean line colour"><ColorInput value={style.meanColor} onChange={v => set('meanColor', v)} placeholder="per condition" /></Field>
          </div>

          <div style={sectionLabel}>Axis frame &amp; ticks</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            <Field label="Axis line">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <input type="checkbox" checked={style.showAxisLine}
                       onChange={e => set('showAxisLine', e.target.checked)}
                       style={{ accentColor: 'var(--accent)' }} />
                show
              </label>
            </Field>
            <Field label="Axis line width">
              <input type="number" value={style.axisLineWidth} min={0} max={6} step={0.5}
                     disabled={!style.showAxisLine}
                     onChange={e => set('axisLineWidth', Math.max(0, +e.target.value || 0))}
                     style={inp} />
            </Field>
            <Field label="Axis line colour">
              <ColorInput value={style.axisLineColor}
                          onChange={v => set('axisLineColor', v)} placeholder="text colour" />
            </Field>
            <Field label="Box (all four sides)">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <input type="checkbox" checked={style.axisMirror}
                       onChange={e => set('axisMirror', e.target.checked)}
                       style={{ accentColor: 'var(--accent)' }} />
                mirror
              </label>
            </Field>
            <Field label="Tick marks">
              <select value={style.tickMarks} onChange={e => set('tickMarks', e.target.value as any)}
                      style={{ ...inp, padding: '3px 4px' }}>
                <option value="outside">outside</option>
                <option value="inside">inside</option>
                <option value="none">none</option>
              </select>
            </Field>
            <Field label="Tick length">
              <input type="number" value={style.tickLen} min={0} max={20} step={1}
                     disabled={style.tickMarks === 'none'}
                     onChange={e => set('tickLen', Math.max(0, +e.target.value || 0))} style={inp} />
            </Field>
            <Field label="Tick width">
              <input type="number" value={style.tickWidth} min={0} max={6} step={0.5}
                     disabled={style.tickMarks === 'none'}
                     onChange={e => set('tickWidth', Math.max(0, +e.target.value || 0))} style={inp} />
            </Field>
            <Field label="Tick colour">
              <ColorInput value={style.tickColor} onChange={v => set('tickColor', v)}
                          placeholder="axis line colour" />
            </Field>
          </div>

          <div style={sectionLabel}>Gridlines</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 6 }}>
            <Field label="Major gridlines">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <input type="checkbox" checked={style.showGrid}
                       onChange={e => set('showGrid', e.target.checked)}
                       style={{ accentColor: 'var(--accent)' }} />
                show
              </label>
            </Field>
            <Field label="Major width">
              <input type="number" value={style.gridWidth} min={0} max={6} step={0.25}
                     disabled={!style.showGrid}
                     onChange={e => set('gridWidth', Math.max(0, +e.target.value || 0))} style={inp} />
            </Field>
            <Field label="Major style">
              <select value={style.gridDash} disabled={!style.showGrid}
                      onChange={e => set('gridDash', e.target.value as GridDash)}
                      style={{ ...inp, padding: '3px 4px' }}>
                {GRID_DASHES.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="Major colour">
              <ColorInput value={style.gridColor} onChange={v => set('gridColor', v)} />
            </Field>

            <Field label="Minor gridlines">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <input type="checkbox" checked={style.showMinorGrid}
                       onChange={e => set('showMinorGrid', e.target.checked)}
                       style={{ accentColor: 'var(--accent)' }} />
                show
              </label>
            </Field>
            <Field label="Minor width">
              <input type="number" value={style.minorGridWidth} min={0} max={6} step={0.25}
                     disabled={!style.showMinorGrid}
                     onChange={e => set('minorGridWidth', Math.max(0, +e.target.value || 0))} style={inp} />
            </Field>
            <Field label="Minor style">
              <select value={style.minorGridDash} disabled={!style.showMinorGrid}
                      onChange={e => set('minorGridDash', e.target.value as GridDash)}
                      style={{ ...inp, padding: '3px 4px' }}>
                {GRID_DASHES.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="Minor colour">
              <ColorInput value={style.minorGridColor} onChange={v => set('minorGridColor', v)}
                          placeholder="major grid colour" />
            </Field>

            <Field label="Minor divisions">
              <input type="number" value={style.minorPerMajor} min={0} max={20} step={1}
                     disabled={!style.showMinorGrid && !style.minorTickMarks}
                     onChange={e => set('minorPerMajor', Math.max(0, Math.round(+e.target.value || 0)))}
                     style={inp} />
            </Field>
            <Field label="Minor tick marks">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <input type="checkbox" checked={style.minorTickMarks}
                       onChange={e => set('minorTickMarks', e.target.checked)}
                       style={{ accentColor: 'var(--accent)' }} />
                show
              </label>
            </Field>
            <Field label="Zero line">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <input type="checkbox" checked={style.showZeroLine}
                       onChange={e => set('showZeroLine', e.target.checked)}
                       style={{ accentColor: 'var(--accent)' }} />
                show
              </label>
            </Field>
            <Field label="Zero line width">
              <input type="number" value={style.zeroLineWidth} min={0} max={6} step={0.5}
                     disabled={!style.showZeroLine}
                     onChange={e => set('zeroLineWidth', Math.max(0, +e.target.value || 0))} style={inp} />
            </Field>
            <Field label="Zero line colour">
              <ColorInput value={style.zeroLineColor} onChange={v => set('zeroLineColor', v)}
                          placeholder="major grid colour" />
            </Field>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 16,
                        lineHeight: 1.5 }}>
            A gridline that looks thicker than its neighbours, and off the
            spacing of the rest, is usually the <strong>zero line</strong>: it is
            drawn on top of whatever is already at zero, and zero only falls on
            the tick lattice by chance. Turn it off, or give it its own colour,
            to see which lines are really the grid.
          </div>

          {/* ── Which series the appearance controls below apply to ───── */}
          {series && series.options.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                          marginBottom: 12, flexWrap: 'wrap',
                          padding: '8px 10px', borderRadius: 6,
                          background: editing ? 'rgba(79,142,247,0.09)' : 'var(--bg-elevated)',
                          border: '1px solid var(--border)' }}>
              <span style={{ ...sectionLabel, marginBottom: 0 }}>Appearance applies to</span>
              <select value={editing} onChange={e => series.onSelect(e.target.value)}
                      style={{ ...inp, width: 230, fontFamily: 'inherit', padding: '4px 5px' }}>
                <option value="">All series</option>
                {series.options.map(o => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
              {editing ? (
                <>
                  <button onClick={series.onReset} style={presetBtn(false)}>
                    Follow the figure again
                  </button>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    Changes below affect this series only.
                  </span>
                </>
              ) : (
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  Changes below set the figure default and clear that setting on
                  every individual series.
                </span>
              )}
            </div>
          )}

          {/*
            SERIES COLOUR HAS ITS OWN SECTION, and no longer sits under
            "Markers (dots)".
            It drives the line, the bar, the mean±SD band and the dots — but
            filed under Markers it read as a dot setting, so it was reasonable
            to conclude that lines simply could not be coloured. (They could
            not, in Overlay, for a different reason: those traces never called
            the resolver at all. Both halves of that are fixed.)
          */}
          {editing && (
            <>
              <div style={sectionLabel}>Colour of this series</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 6 }}>
                {sField('Series colour', 'colour', <>                  <ColorInput value={ov.colour || ''} onChange={v => sset('colour', v)}
                              placeholder="condition colour" />
                </>)}
                {/*
                  * The dots follow the series colour unless this is set, so a
                  * bar and its replica dots match by default and can still be
                  * separated on purpose.
                  */}
                {sField('Dot colour', 'dotColour', <>                  <ColorInput value={ov.dotColour || ''} onChange={v => sset('dotColour', v)}
                              placeholder="series colour" />
                </>)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 16,
                            lineHeight: 1.5 }}>
                Applies to this condition's line, bar, mean±SD band and dots.
                To colour <em>individual replicas</em> in Overlay, use the
                swatches in the Replicas panel on the right.
              </div>
            </>
          )}

          <div style={sectionLabel}>Markers (dots)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            {sField('Shape', 'markerSymbol', <>              <select value={sval('markerSymbol')} onChange={e => sset('markerSymbol', e.target.value)}
                      style={{ ...inp, padding: '3px 4px' }}>
                {MARKER_SYMBOLS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </>)}
            {sField('Size', 'markerSize', <>              <input type="number" value={sval('markerSize')} min={1} max={40} step={1}
                     onChange={e => sset('markerSize', +e.target.value || 6)} style={inp} />
            </>)}
            {sField('Opacity', 'markerOpacity', <>              <input type="range" min={0.05} max={1} step={0.05} value={sval('markerOpacity')}
                     onChange={e => sset('markerOpacity', +e.target.value)}
                     style={{ width: '100%', accentColor: 'var(--accent)' }} />
            </>)}
            {sField('Border width (0 = none)', 'markerBorderWidth', <>              <input type="number" value={sval('markerBorderWidth')} min={0} max={6} step={0.5}
                     onChange={e => sset('markerBorderWidth', Math.max(0, +e.target.value || 0))}
                     style={inp} />
            </>)}
            {sField('Border colour', 'markerBorderColor', <>              <ColorInput value={sval('markerBorderColor')}
                          onChange={v => sset('markerBorderColor', v)} placeholder="auto" />
            </>)}
          </div>

          <div style={sectionLabel}>Bars</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            {sField('Fill lightness', 'barFillLighten', <>              <input type="range" min={0} max={0.9} step={0.05} value={sval('barFillLighten')}
                     onChange={e => sset('barFillLighten', +e.target.value)}
                     style={{ width: '100%', accentColor: 'var(--accent)' }} />
            </>)}
            {sField('Opacity', 'barOpacity', <>              <input type="range" min={0.05} max={1} step={0.05} value={sval('barOpacity')}
                     onChange={e => sset('barOpacity', +e.target.value)}
                     style={{ width: '100%', accentColor: 'var(--accent)' }} />
            </>)}
            {sField('Border width (0 = none)', 'barBorderWidth', <>              <input type="number" value={sval('barBorderWidth')} min={0} max={6} step={0.5}
                     onChange={e => sset('barBorderWidth', Math.max(0, +e.target.value || 0))}
                     style={inp} />
            </>)}
            {sField('Border colour', 'barBorderColor', <>              <ColorInput value={sval('barBorderColor')}
                          onChange={v => sset('barBorderColor', v)} placeholder="bar colour" />
            </>)}
          </div>

          <div style={sectionLabel}>Lines &amp; error bars</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            {sField('Line style', 'lineDash', <>              <select value={sval('lineDash')} onChange={e => sset('lineDash', e.target.value as any)}
                      style={{ ...inp, padding: '3px 4px' }}>
                <option value="solid">solid</option>
                <option value="dash">dashed</option>
                <option value="dot">dotted</option>
                <option value="dashdot">dash-dot</option>
                <option value="longdash">long dash</option>
              </select>
            </>)}
            {sField('Line width', 'lineWidth', <>              <input type="number" value={sval('lineWidth')} step={0.5} min={0.5}
                     onChange={e => sset('lineWidth', +e.target.value || 1.5)} style={inp} />
            </>)}
            <Field label="Error bar width">
              <input type="number" value={style.errorBarWidth} min={0} max={6} step={0.5}
                     onChange={e => set('errorBarWidth', Math.max(0, +e.target.value || 0))} style={inp} />
            </Field>
            <Field label="Error cap size">
              <input type="number" value={style.errorCapSize} min={0} max={20} step={1}
                     onChange={e => set('errorCapSize', Math.max(0, +e.target.value || 0))} style={inp} />
            </Field>
            <Field label="Legend">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <input type="checkbox" checked={style.showLegend}
                       onChange={e => set('showLegend', e.target.checked)}
                       style={{ accentColor: 'var(--accent)' }} />
                show
              </label>
            </Field>
            <Field label="Legend position">
              <select value={style.legendPos} disabled={!style.showLegend}
                      onChange={e => set('legendPos', e.target.value as LegendPos)}
                      style={{ ...inp, padding: '3px 4px',
                               opacity: style.showLegend ? 1 : 0.5 }}>
                {LEGEND_POSITIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            {/*
              A POINTER, not a second control. "Name each repeat" writes
              style.legendReplicas and lives beside "Colour by" in Overlay,
              where the need for it arises; two controls for one field is how
              a setting becomes impossible to find again.
            */}
            <Field label="Individual repeats">
              <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                Listing each replica is <strong>name each repeat</strong>, next to
                Colour by in Overlay.
              </div>
            </Field>
          </div>

          <div style={sectionLabel}>Export</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            <Field label="Format">
              <select value={style.exportFormat} onChange={e => set('exportFormat', e.target.value as any)} style={{ ...inp, padding: '3px 4px' }}>
                <option value="svg">SVG (vector)</option>
                <option value="png">PNG (raster)</option>
              </select>
            </Field>
            <Field label="PNG scale">
              <input type="number" value={style.exportScale} min={1} max={8} step={1}
                disabled={style.exportFormat !== 'png'}
                onChange={e => set('exportScale', Math.max(1, +e.target.value || 1))}
                style={{ ...inp, opacity: style.exportFormat === 'png' ? 1 : 0.4 }} />
            </Field>
            <div style={{ gridColumn: 'span 2', fontSize: 10, color: 'var(--text-muted)', alignSelf: 'end', lineHeight: 1.5, paddingBottom: 4 }}>
              Use the camera button on the plot to save. SVG scales losslessly and stays editable in Illustrator/Inkscape.
            </div>
          </div>

          <div style={sectionLabel}>Typography &amp; grid</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <Field label="Font family">
              <select value={style.fontFamily} onChange={e => set('fontFamily', e.target.value)} style={{ ...inp, padding: '3px 4px' }}>
                <option value="Arial, Helvetica, sans-serif">Arial</option>
                <option value="Inter, Arial, sans-serif">Inter</option>
                <option value="JetBrains Mono, monospace">JetBrains Mono</option>
                <option value="Helvetica, Arial, sans-serif">Helvetica</option>
                <option value="Times New Roman, serif">Times New Roman</option>
                <option value="Georgia, serif">Georgia</option>
                <option value="Courier New, monospace">Courier New</option>
              </select>
            </Field>
            <Field label="Font size"><input type="number" value={style.fontSize} onChange={e => set('fontSize', +e.target.value || 11)} min={6} max={28} style={inp} /></Field>
            <Field label="Font colour"><ColorInput value={style.fontColor} onChange={v => set('fontColor', v)} /></Field>
            <Field label="Style">
              <div style={{ display: 'flex', gap: 5, paddingTop: 2 }}>
                <button onClick={() => set('fontBold', !style.fontBold)} title="Bold" style={{
                  width: 28, height: 24, borderRadius: 4, fontSize: 12, fontWeight: 700,
                  background: style.fontBold ? 'var(--accent)' : 'var(--bg-surface)',
                  color: style.fontBold ? '#fff' : 'var(--text-secondary)',
                  border: `1px solid ${style.fontBold ? 'transparent' : 'var(--border)'}`,
                }}>B</button>
                <button onClick={() => set('fontItalic', !style.fontItalic)} title="Italic" style={{
                  width: 28, height: 24, borderRadius: 4, fontSize: 12, fontStyle: 'italic',
                  background: style.fontItalic ? 'var(--accent)' : 'var(--bg-surface)',
                  color: style.fontItalic ? '#fff' : 'var(--text-secondary)',
                  border: `1px solid ${style.fontItalic ? 'transparent' : 'var(--border)'}`,
                }}>I</button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text-secondary)', marginLeft: 6 }}>
                  <input type="checkbox" checked={style.showGrid} onChange={e => set('showGrid', e.target.checked)} style={{ accentColor: 'var(--accent)' }} /> grid
                </label>
              </div>
            </Field>
          </div>
        </div>
      )}
    </div>
  )
}

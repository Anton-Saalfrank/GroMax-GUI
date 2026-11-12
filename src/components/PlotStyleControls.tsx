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
 * Build the Plotly layout for a styled plot. Kept here next to the controls so
 * the mapping from style -> layout lives in one place.
 */
export function styledLayout(s: PlotStyle, defX: string, defY: string, extra: any = {}) {
  const weight = s.fontBold ? 'bold' : 'normal'
  const style = s.fontItalic ? 'italic' : 'normal'
  return {
    autosize: true, height: 480,
    margin: { l: 60, r: 20, t: s.title ? 40 : 30, b: 50 },
    paper_bgcolor: s.paperBg || 'rgba(0,0,0,0)',
    plot_bgcolor: s.plotBg || 'rgba(0,0,0,0)',
    font: { color: s.fontColor, family: s.fontFamily, size: s.fontSize, weight, style },
    title: s.title ? { text: s.title, font: { color: s.fontColor, size: s.fontSize + 3, weight, style } } : undefined,
    xaxis: {
      title: { text: s.xlabel || defX }, showgrid: s.showGrid,
      gridcolor: s.gridColor, zerolinecolor: s.gridColor,
      range: (s.xmin && s.xmax) ? [+s.xmin, +s.xmax] : undefined,
    },
    yaxis: {
      title: { text: s.ylabel || defY }, showgrid: s.showGrid,
      gridcolor: s.gridColor, zerolinecolor: s.gridColor,
      range: (s.ymin && s.ymax) ? [+s.ymin, +s.ymax] : undefined,
    },
    showlegend: s.showLegend,
    legend: { bgcolor: 'rgba(0,0,0,0)', bordercolor: s.gridColor, borderwidth: 1, x: 1, xanchor: 'right', y: 1 },
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
            <Field label="Gridline colour"><ColorInput value={style.gridColor} onChange={v => set('gridColor', v)} /></Field>
            <Field label="Mean line colour"><ColorInput value={style.meanColor} onChange={v => set('meanColor', v)} placeholder="per condition" /></Field>
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

          <div style={sectionLabel}>Markers (dots)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            {editing && (
              <>
                {sField('Series colour', 'colour', <>                  <ColorInput value={ov.colour || ''} onChange={v => sset('colour', v)}
                              placeholder="condition colour" />
                </>)}
                {/*
                  * REQUEST (3) LIVES HERE. The dots follow the series colour
                  * unless this is set, so a bar and its replica dots match by
                  * default and can still be separated on purpose.
                  */}
                {sField('Dot colour', 'dotColour', <>                  <ColorInput value={ov.dotColour || ''} onChange={v => sset('dotColour', v)}
                              placeholder="series colour" />
                </>)}
              </>
            )}
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

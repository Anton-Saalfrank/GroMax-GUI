/**
 * "Data on graph" — Prism's first Format Graph tab.
 *
 * Two lists, and the distinction between them is the point. The TOP list is
 * saved filters: definitions that belong to the project and outlive the
 * figure. The BOTTOM list is the series actually on this graph, one per
 * filter x condition, which is derived and exists only while they are on it.
 *
 * Conflating the two is the obvious shortcut and the wrong one: deleting a
 * series would then mean deleting a definition, and taking something off the
 * graph to look at it later would destroy the work of defining it.
 */
import React, { useState } from 'react'
import { Plus, Trash2, Copy, Pencil, Eye, EyeOff, Check, X } from 'lucide-react'
import { describeFilter, newFilterId } from '../../lib/plotFilter'
import { COLOUR_SCHEMES, resolveSeriesStyle } from '../../lib/plotSeries'
import type { FilterDef } from '../../lib/plotSeries'
import type { SeriesModel, ConditionRef, GroupBy } from './useSeriesModel'
import type { PlotStyle } from '../PlotStyleControls'

const box: React.CSSProperties = {
  marginBottom: 14, padding: '12px 14px', background: 'var(--bg-surface)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
}
const lbl: React.CSSProperties = {
  display: 'block', fontSize: 10, color: 'var(--text-muted)',
  marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4,
}
const chip = (on: boolean): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
  background: on ? 'var(--accent)' : 'var(--bg-elevated)',
  color: on ? '#fff' : 'var(--text-secondary)',
  border: `1px solid ${on ? 'transparent' : 'var(--border)'}`,
})
const iconBtn: React.CSSProperties = {
  padding: 3, background: 'transparent', color: 'var(--text-muted)',
  border: 'none', cursor: 'pointer',
}

/** The editor for one filter. Separate so the list stays readable. */
function FilterEditor({ draft, keys, labelFor, onSave, onCancel }: {
  draft: FilterDef
  keys: string[]
  labelFor: (k: string) => string
  onSave: (f: FilterDef) => void
  onCancel: () => void
}) {
  const [f, setF] = useState<FilterDef>(draft)
  const set = <K extends keyof FilterDef>(k: K, v: FilterDef[K]) =>
    setF(p => ({ ...p, [k]: v }))

  return (
    <div style={{ padding: '10px 12px', background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={lbl}>Name</label>
          <input value={f.name} onChange={e => set('name', e.target.value)}
                 placeholder="cavity open" style={{ width: 140, fontSize: 12 }} />
        </div>
        <div>
          <label style={lbl}>Keep frames where</label>
          <select value={f.metric} onChange={e => set('metric', e.target.value)}
                  style={{ fontSize: 12, maxWidth: 220 }}>
            {keys.map(k => <option key={k} value={k}>{labelFor(k)}</option>)}
          </select>
        </div>
        <select value={f.op} onChange={e => set('op', e.target.value as any)} style={{ fontSize: 12 }}>
          <option value=">">&gt;</option><option value="<">&lt;</option>
          <option value=">=">&ge;</option><option value="<=">&le;</option>
        </select>
        <input value={String(f.threshold)} type="number" step="any"
               onChange={e => set('threshold', parseFloat(e.target.value))}
               style={{ width: 80, fontSize: 12, fontFamily: 'var(--font-mono)' }} />
        <div>
          <label style={lbl} title={'Ignore flickers: a run shorter than this many '
                 + 'consecutive frames is not counted as the state being entered.'}>
            Min run (frames)
          </label>
          <input type="number" min={1} step={1} value={f.minRun || 1}
                 onChange={e => set('minRun', Math.max(1, parseInt(e.target.value) || 1))}
                 style={{ width: 70, fontSize: 12 }} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap',
                    alignItems: 'flex-end', marginTop: 10 }}>
        <div>
          <label style={lbl}>On a bar chart, report</label>
          <select value={f.output} onChange={e => set('output', e.target.value as any)}
                  style={{ fontSize: 12 }}>
            <option value="fraction">fraction of frames passing</option>
            <option value="conditional_mean">mean of another metric over those frames</option>
          </select>
        </div>
        {f.output === 'conditional_mean' && (
          <div>
            <label style={lbl}>Metric to average</label>
            <select value={f.targetMetric || ''} onChange={e => set('targetMetric', e.target.value)}
                    style={{ fontSize: 12, maxWidth: 220 }}>
              <option value="">— choose —</option>
              {keys.map(k => <option key={k} value={k}>{labelFor(k)}</option>)}
            </select>
          </div>
        )}
        <div>
          <label style={lbl} title={'On a time-series plot: break the line outside the '
                 + 'passing frames, or draw it all and shade where the filter holds.'}>
            On a time plot
          </label>
          <select value={f.gateMode || 'shade'} onChange={e => set('gateMode', e.target.value as any)}
                  style={{ fontSize: 12 }}>
            <option value="shade">shade the passing stretches</option>
            <option value="gap">show only the passing frames</option>
          </select>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => onSave({ ...f, name: f.name.trim() || 'filter' })}
                  disabled={!f.metric || !Number.isFinite(f.threshold)
                            || (f.output === 'conditional_mean' && !f.targetMetric)}
                  style={{ ...chip(true), display: 'flex', alignItems: 'center', gap: 4 }}>
            <Check size={12} /> Save
          </button>
          <button onClick={onCancel} style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 4 }}>
            <X size={12} /> Cancel
          </button>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
        {Number.isFinite(f.threshold) && f.metric
          ? describeFilter(f, labelFor)
          : 'Pick a metric and a threshold.'}
      </div>
    </div>
  )
}

export default function SeriesPanel({ model, keys, labelFor, conditions, style, unusedKeys }: {
  model: SeriesModel
  keys: string[]
  labelFor: (k: string) => string
  conditions: ConditionRef[]
  style: PlotStyle
  /** Metrics a saved filter points at that no longer exist. */
  unusedKeys?: Record<string, string>
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<FilterDef | null>(null)

  const startNew = () => {
    const d: FilterDef = {
      id: newFilterId(), name: '', metric: keys[0] || '', op: '>',
      threshold: 1, output: 'fraction', minRun: 1, gateMode: 'shade',
    }
    setDraft(d); setEditingId(d.id)
  }

  return (
    <div style={box}>
      {/* ── Saved filters ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ ...lbl, marginBottom: 0 }}>Saved filters</span>
        <button onClick={startNew} style={{ ...chip(false), display: 'flex',
                alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
          <Plus size={12} /> New filter
        </button>
      </div>

      {draft && editingId === draft.id && (
        <FilterEditor draft={draft} keys={keys} labelFor={labelFor}
          onSave={f => { model.addPlotFilter(f); model.setOnGraph([...model.onGraph, f.id])
                         setDraft(null); setEditingId(null) }}
          onCancel={() => { setDraft(null); setEditingId(null) }} />
      )}

      {!model.filters.length && !draft && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 6 }}>
          A filter is a rule about frames — “cavity volume &gt; 20 Å³”. Saved here, it
          can be put on a bar chart as the fraction of time it holds, used to
          average another metric over just those frames, or used to gate a time
          series so only the passing stretches are drawn. Filters are kept with
          this project.
        </div>
      )}

      {model.filters.map(f => {
        if (editingId === f.id) {
          return <FilterEditor key={f.id} draft={f} keys={keys} labelFor={labelFor}
                   onSave={n => { model.updatePlotFilter(f.id, n); setEditingId(null) }}
                   onCancel={() => setEditingId(null)} />
        }
        const on = model.onGraph.includes(f.id)
        const missing = !keys.includes(f.metric)
          || (f.output === 'conditional_mean' && !!f.targetMetric && !keys.includes(f.targetMetric))
        return (
          <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8,
                                   padding: '5px 0', opacity: missing ? 0.55 : 1 }}>
            <button onClick={() => !missing && model.toggleOnGraph(f.id)}
                    disabled={missing} style={chip(on)}
                    title={missing ? 'The metric this filter names is not loaded.'
                                   : 'Put this filter on the graph for every condition'}>
              {on ? 'on graph' : 'add to graph'}
            </button>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{f.name}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {describeFilter(f, labelFor)}
              </div>
            </div>
            {missing && (
              /*
               * A filter whose metric was deleted or re-run under another name
               * greys out and says so. Dropping it silently would make a chart
               * quietly lose a series; keeping it live would plot nothing and
               * give no reason.
               */
              <span style={{ fontSize: 10, color: 'var(--orange, #f79f4f)' }}>
                metric not loaded
              </span>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
              <button onClick={() => setEditingId(f.id)} title="Edit" style={iconBtn}>
                <Pencil size={12} />
              </button>
              <button title="Duplicate" style={iconBtn}
                      onClick={() => model.addPlotFilter({ ...f, id: newFilterId(),
                                                           name: `${f.name} copy` })}>
                <Copy size={12} />
              </button>
              <button onClick={() => model.removePlotFilter(f.id)} title="Delete"
                      style={{ ...iconBtn, color: 'var(--red)' }}>
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        )
      })}

      {/* ── Series on the graph ───────────────────────────────────────── */}
      {model.series.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10,
                        margin: '14px 0 8px', flexWrap: 'wrap' }}>
            <span style={{ ...lbl, marginBottom: 0 }}>
              On the graph ({model.series.length})
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>group by</span>
              {(['condition', 'filter'] as GroupBy[]).map(g => (
                <button key={g} onClick={() => model.setGroupBy(g)}
                        style={chip(model.groupBy === g)}
                        title={g === 'condition'
                          ? 'x-axis is the conditions; colour distinguishes filters'
                          : 'x-axis is the filters; colour distinguishes conditions'}>
                  {g}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            <select defaultValue="" style={{ fontSize: 11 }}
                    onChange={e => {
                      const s = COLOUR_SCHEMES.find(c => c.name === e.target.value)
                      if (s) model.applyScheme(s.colours)
                      e.target.value = ''
                    }}>
              <option value="">— colour scheme —</option>
              {COLOUR_SCHEMES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            <button style={chip(false)}
                    onClick={() => model.series.forEach(s => s.visible || model.toggleHidden(s.id))}>
              show all
            </button>
            <button style={chip(false)}
                    onClick={() => model.series.forEach(s => s.visible && model.toggleHidden(s.id))}>
              hide all
            </button>
            <button style={chip(false)} title="Remove every per-series colour and shape override"
                    onClick={() => model.series.forEach(s => model.resetSeriesStyle(s.id))}>
              reset styles
            </button>
          </div>

          <div style={{ maxHeight: 190, overflow: 'auto' }}>
            {model.series.map(s => {
              const cond = conditions.find(c => c.id === s.conditionId)
              const resolved = resolveSeriesStyle(s, style, cond?.colour, s.order)
              return (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 7,
                      padding: '3px 0', opacity: s.visible ? 1 : 0.45 }}>
                  <span style={{ width: 11, height: 11, borderRadius: 3, flexShrink: 0,
                                 background: resolved.colour,
                                 border: '1px solid var(--border)' }} />
                  <input
                    value={model.labels[s.id] ?? ''}
                    placeholder={s.label}
                    onChange={e => model.setLabel(s.id, e.target.value)}
                    style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '2px 5px',
                             background: 'transparent', border: '1px solid transparent',
                             color: 'var(--text-secondary)' }}
                    onFocus={e => (e.target.style.border = '1px solid var(--border)')}
                    onBlur={e => (e.target.style.border = '1px solid transparent')}
                  />
                  <button onClick={() => model.setEditing(s.id)}
                          style={{ ...chip(model.editing === s.id), padding: '2px 7px', fontSize: 10 }}
                          title="Edit this series' appearance in Customise plot">
                    style
                  </button>
                  <button onClick={() => model.toggleHidden(s.id)} style={iconBtn}
                          title={s.visible ? 'Hide' : 'Show'}>
                    {s.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                  </button>
                </div>
              )
            })}
          </div>

          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            {model.groupBy === 'condition'
              ? `x-axis: ${conditions.map(c => c.name).join(', ')} — one colour per filter.`
              : `x-axis: ${model.activeFilters.map(f => f.name).join(', ')} — one colour per condition.`}
            {' '}Pick a series above, then open Customise plot to change just that one.
          </div>
        </>
      )}
    </div>
  )
}

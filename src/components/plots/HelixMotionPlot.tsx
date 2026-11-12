/**
 * Several channels of one analysis, on one shared time axis.
 *
 * Named for helix motion, which was the first analysis to need it, but it
 * renders ANY line result that carries `channels` — cavity volume uses it too.
 *
 * Stacked panels rather than one axis, for the same reason as the Repeat detail
 * mode: these channels are in angstrom, degrees and residues, and the largest
 * would otherwise flatten the rest into a line at the bottom. Each panel keeps
 * its own units, and the unit is printed on every axis because nothing about a
 * number called "piston" says whether it is A or nm.
 *
 * UNITS NOTE: angstrom and degrees here, which is what the analysis computes
 * and what the field convention is for helix geometry. Every other plot in this
 * app is in nanometres (GROMACS' unit), so the axes say so explicitly rather
 * than relying on the reader to remember which plot they are looking at.
 */
import React, { useMemo, useState, useCallback } from 'react'
import Plot from './Plot'
import { PLOT_CONFIG, getPlotBg, getAxis, REP_PALETTE } from './shared'
import { api } from '../../api/client'
import { downloadText } from '../../lib/download'
import { useStore } from '../../store'

interface Channel { key: string; label: string; unit: string; y: (number | null)[] }

/**
 * Channels shown by default — the rest are one click away.
 *
 * This list is helix motion's. Any other multi-channel analysis (cavity
 * volume, and whatever comes next) matches none of it, so the fallback below
 * shows its first few channels instead — without it such a result rendered as
 * "No channels selected", which looks exactly like a failed analysis.
 */
const PRIMARY = ['piston_A', 'lateral_A', 'tilt_deg', 'roll_deg',
                 'interaxis_deg', 'closest_dist_A', 'event_rmsd_A',
                 'volume_A3', 'waters', 'max_sphere_A']

const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function HelixMotionPlot({ results, cacheKeys }: {
  results: any[]
  /** cache_key per condition_id, so the CSV comes from the stored result. */
  cacheKeys?: Record<string, string>
}) {
  const first = results[0]
  const sessionId = useStore(st => st.activeSession?.id || '')
  const [exportNote, setExportNote] = useState<string | null>(null)

  const exportCsv = async (r: any, replica?: number) => {
    const key = cacheKeys?.[r.condition_id || '']
    if (!sessionId || !key) {
      setExportNote('This result has no cache key, so it cannot be exported.')
      return
    }
    try {
      const out = await api.analysis.exportCsv(sessionId, key, replica)
      downloadText(out.filename, out.csv)
      setExportNote(`${out.filename} — ${out.n_rows} rows x ${out.n_columns} columns`)
    } catch (e: any) {
      setExportNote(e?.message || 'Export failed.')
    }
  }
  const allKeys: string[] = useMemo(() => {
    const seen: string[] = []
    for (const r of results)
      for (const c of (r.channels || []) as Channel[])
        if (!seen.includes(c.key)) seen.push(c.key)
    return seen
  }, [results])

  const [shown, setShown] = useState<string[]>([])
  const [splitNs, setSplitNs] = useState<string>('')
  const [showReplicas, setShowReplicas] = useState(true)

  const primary = allKeys.filter(k => PRIMARY.includes(k))
  const keys = shown.length ? shown
    : (primary.length ? primary : allKeys.slice(0, 4))
  // useCallback so the memos below can declare it and have that checked; it
  // reads only `results`, which they already depend on.
  const labelOf = useCallback((k: string) => {
    for (const r of results)
      for (const c of (r.channels || []) as Channel[]) if (c.key === k) return c
    return null
  }, [results])

  /** Every (condition, replica) series for one channel. */
  const seriesFor = useCallback((k: string) => {
    const out: { x: number[]; y: (number | null)[]; colour: string;
                 name: string; isMean: boolean }[] = []
    for (const r of results) {
      const colour = r.colour || '#4f8ef7'
      const reps = (r.replicas || []) as any[]
      if (showReplicas && reps.length) {
        reps.forEach((rep, i) => {
          const ch = (rep.channels || []).find((c: Channel) => c.key === k)
          if (!ch) return
          out.push({
            x: rep.x || r.x, y: ch.y, name: `${r.condition_name} rep${rep.index}`,
            // Replicas keep the condition's colour so conditions stay
            // distinguishable; the repeat palette is for colouring BY repeat.
            colour: reps.length > 1 ? colour : REP_PALETTE[i % REP_PALETTE.length],
            isMean: false,
          })
        })
      }
      const ch = (r.channels || []).find((c: Channel) => c.key === k)
      if (ch) out.push({ x: r.x, y: ch.y, colour, name: r.condition_name, isMean: true })
    }
    return out
  }, [results, showReplicas])

  // ── Stacked panels ────────────────────────────────────────────────────────
  const stacked = useMemo(() => {
    const traces: any[] = []
    const layout: any = {}
    const n = keys.length
    if (!n) return { traces, layout }
    const gap = 0.045
    const h = (1 - gap * (n - 1)) / n

    keys.forEach((k, i) => {
      const meta = labelOf(k)
      const top = 1 - i * (h + gap)
      const ax = i === 0 ? 'yaxis' : `yaxis${i + 1}`
      layout[ax] = {
        domain: [Math.max(0, top - h), top],
        title: { text: `${meta?.label || k}${meta?.unit ? ` (${meta.unit})` : ''}`,
                 font: { size: 9 } },
        ...getAxis(),
      }
      for (const s of seriesFor(k)) {
        traces.push({
          x: s.x, y: s.y, type: 'scattergl', mode: 'lines',
          line: { color: s.colour, width: s.isMean ? 1.8 : 0.8 },
          opacity: s.isMean ? 1 : 0.35,
          name: s.name, showlegend: i === 0 && s.isMean,
          legendgroup: s.name,
          yaxis: i === 0 ? 'y' : `y${i + 1}`,
          hovertemplate: `${s.name}<br>%{x:.2f} ns · %{y:.3f}`
                       + `${meta?.unit ? ' ' + meta.unit : ''}<extra></extra>`,
        })
      }
    })
    layout.xaxis = {
      title: { text: 'Time (ns)' }, anchor: n === 1 ? 'y' : `y${n}`,
      showspikes: true, spikemode: 'across', spikethickness: 1, spikedash: 'dot',
      ...getAxis(),
    }
    layout.height = Math.max(340, 135 * n + 90)
    layout.hovermode = 'x unified'
    layout.spikedistance = -1
    if (splitNs !== '' && Number.isFinite(+splitNs)) {
      layout.shapes = [{ type: 'line', x0: +splitNs, x1: +splitNs, yref: 'paper',
                         y0: 0, y1: 1, line: { color: '#f79f4f', width: 1.4,
                                               dash: 'dash' } }]
    }
    return { traces, layout }
  }, [keys, labelOf, seriesFor, splitNs])

  // ── Piston vs the event order parameter ───────────────────────────────────
  const density = useMemo(() => {
    if (!allKeys.includes('event_rmsd_A')) return null
    const traces: any[] = []
    for (const r of results) {
      const px = (r.channels || []).find((c: Channel) => c.key === 'piston_A')
      const ev = (r.channels || []).find((c: Channel) => c.key === 'event_rmsd_A')
      if (!px || !ev) continue
      traces.push({
        x: px.y.map(num), y: ev.y.map(num), type: 'scattergl', mode: 'markers',
        marker: { color: r.colour || '#4f8ef7', size: 4, opacity: 0.45 },
        name: r.condition_name,
        hovertemplate: `${r.condition_name}<br>piston %{x:.2f} A · `
                     + `event %{y:.2f} A<extra></extra>`,
      })
    }
    return traces.length ? traces : null
  }, [results, allKeys])

  // ── Before/after a split time ─────────────────────────────────────────────
  const hist = useMemo(() => {
    const split = +splitNs
    if (splitNs === '' || !Number.isFinite(split)) return null
    const key = keys[0] || 'piston_A'
    const meta = labelOf(key)
    const traces: any[] = []
    for (const r of results) {
      const ch = (r.channels || []).find((c: Channel) => c.key === key)
      if (!ch) continue
      const x = r.x as number[]
      const before: number[] = [], after: number[] = []
      ch.y.forEach((v: number | null, i: number) => {
        const n2 = num(v)
        if (n2 === null) return
        ;(x[i] < split ? before : after).push(n2)
      })
      // Probability, not count: the two sides of a split are rarely the same
      // length, and raw counts would make the longer side look like the denser
      // distribution whatever the values do.
      if (before.length) traces.push({
        x: before, type: 'histogram', histnorm: 'probability', opacity: 0.55,
        marker: { color: r.colour || '#4f8ef7' },
        name: `${r.condition_name} < ${split} ns`, nbinsx: 40,
      })
      if (after.length) traces.push({
        x: after, type: 'histogram', histnorm: 'probability', opacity: 0.55,
        marker: { color: '#f79f4f' },
        name: `${r.condition_name} ≥ ${split} ns`, nbinsx: 40,
      })
    }
    return traces.length ? { traces, meta, key } : null
  }, [results, keys, labelOf, splitNs])

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '3px 9px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
    background: active ? 'var(--accent)' : 'var(--bg-surface)',
    color: active ? '#fff' : 'var(--text-secondary)',
    border: `1px solid ${active ? 'transparent' : 'var(--border)'}`,
  })
  const meta = first?.helix_meta

  return (
    <div>
      {meta && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8,
                      lineHeight: 1.6 }}>
          Helix A: {meta.n_ca_a} CA{meta.resids_a?.length
            ? ` (${meta.resids_a[0]}–${meta.resids_a[meta.resids_a.length - 1]})` : ''}
          {meta.n_ca_b ? ` · helix B: ${meta.n_ca_b} CA` : ''}
          {' · '}fit: <code>{meta.fit_selection}</code>
          {' · '}reference frame {meta.ref_frame} ({meta.ref_time_ns?.toFixed?.(2)} ns)
          {' · '}axis: {meta.axis_method}
          <br />
          All distances in <strong>ångström</strong> and angles in{' '}
          <strong>degrees</strong> — note the rest of this app plots nanometres.
          {meta.axis_method === 'svd' && (
            <> Plain SVD is biased by roughly 2° on a 12–18 residue helix and
               ~19° on a 6-residue one; “smoothed” removes most of that.</>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8,
                    alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)',
                       textTransform: 'uppercase' }}>Channels</span>
        {allKeys.map(k => {
          const m = labelOf(k)
          const on = keys.includes(k)
          return (
            <button key={k} style={chip(on)}
                    onClick={() => setShown(on ? keys.filter(x => x !== k)
                                               : [...keys, k])}>
              {m?.label || k}{m?.unit ? ` (${m.unit})` : ''}
            </button>
          )
        })}
        <label style={{ display: 'flex', alignItems: 'center', gap: 5,
                        fontSize: 11, marginLeft: 8 }}>
          <input type="checkbox" checked={showReplicas}
                 onChange={e => setShowReplicas(e.target.checked)} />
          replicates
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
          split at
          <input type="number" step="any" value={splitNs} placeholder="ns"
                 onChange={e => setSplitNs(e.target.value)}
                 style={{ width: 72, padding: '3px 6px', fontSize: 11,
                          border: '1px solid var(--border)', borderRadius: 4,
                          background: 'var(--bg)', color: 'var(--text)',
                          fontFamily: 'var(--font-mono)' }} />
          ns
        </label>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8,
                    alignItems: 'center', fontSize: 11 }}>
        <span style={{ color: 'var(--text-muted)', textTransform: 'uppercase',
                       fontSize: 10 }}>Export</span>
        {results.map((r: any) => (
          <React.Fragment key={r.condition_id}>
            <button style={chip(false)} onClick={() => exportCsv(r)}>
              {r.condition_name} (mean)
            </button>
            {(r.replicas || []).map((rep: any) => (
              <button key={rep.index} style={chip(false)}
                      onClick={() => exportCsv(r, rep.index)}>
                {r.condition_name} rep{rep.index}
              </button>
            ))}
          </React.Fragment>
        ))}
        {exportNote && (
          <span style={{ color: 'var(--text-muted)' }}>{exportNote}</span>
        )}
      </div>

      {keys.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          No channels selected.
        </div>
      ) : (
        <Plot data={stacked.traces} layout={{
          autosize: true, uirevision: `helix-${keys.join(',')}-${showReplicas}`,
          margin: { l: 72, r: 20, t: 10, b: 48 }, ...getPlotBg(), ...stacked.layout,
        }} config={PLOT_CONFIG} useResizeHandler style={{ width: '100%' }} />
      )}

      {density && (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '12px 0 4px' }}>
            Piston against the event order parameter — one point per frame.
          </div>
          <Plot data={density} config={PLOT_CONFIG} useResizeHandler
                style={{ width: '100%' }}
                layout={{
                  autosize: true, height: 320, uirevision: 'helix-density',
                  margin: { l: 64, r: 20, t: 10, b: 48 }, ...getPlotBg(),
                  xaxis: { title: { text: 'Piston (Å)' }, ...getAxis() },
                  yaxis: { title: { text: 'Event order parameter (Å)' }, ...getAxis() },
                  legend: { bgcolor: 'rgba(0,0,0,0)', x: 1, xanchor: 'right', y: 1 },
                }} />
        </>
      )}

      {hist && (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '12px 0 4px' }}>
            {hist.meta?.label || hist.key} before and after {splitNs} ns, as
            probability — the two sides rarely hold the same number of frames,
            and raw counts would make the longer one look denser regardless.
          </div>
          <Plot data={hist.traces} config={PLOT_CONFIG} useResizeHandler
                style={{ width: '100%' }}
                layout={{
                  autosize: true, height: 300, barmode: 'overlay',
                  uirevision: `helix-hist-${splitNs}`,
                  margin: { l: 64, r: 20, t: 10, b: 48 }, ...getPlotBg(),
                  xaxis: { title: { text: `${hist.meta?.label || hist.key}`
                                        + `${hist.meta?.unit ? ` (${hist.meta.unit})` : ''}` },
                           ...getAxis() },
                  yaxis: { title: { text: 'probability' }, ...getAxis() },
                  legend: { bgcolor: 'rgba(0,0,0,0)', x: 1, xanchor: 'right', y: 1 },
                }} />
        </>
      )}
    </div>
  )
}

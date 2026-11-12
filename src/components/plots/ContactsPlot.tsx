/**
 * Residue-contact / H-bond occupancy: grouped bars with SD error bars and
 * per-replica dots bound to each condition's offset group.
 */
import { useState } from 'react'
import Plot from './Plot'
import { plotTheme } from '../../plotTheme'

export function ContactsPlot({ results }: { results: any[] }) {
  const [showDots, setShowDots] = useState(true)
  // Union of residues across conditions, ordered by max mean occupancy
  const byLabel: Record<string, any> = {}
  for (const r of results)
    for (const c of r.contacts || []) {
      if (!byLabel[c.label]) byLabel[c.label] = { label: c.label, max: 0 }
      byLabel[c.label][r.condition_id] = c
      byLabel[c.label].max = Math.max(byLabel[c.label].max, c.occupancy)
    }
  const ordered = Object.values(byLabel).sort((a: any, b: any) => b.max - a.max).slice(0, 40)
  const labels = ordered.map((o: any) => o.label)

  const traces: any[] = []
  for (const r of results) {
    // Bars: mean occupancy with SD error bars
    traces.push({
      x: labels,
      y: labels.map(l => byLabel[l][r.condition_id!]?.occupancy || 0),
      error_y: {
        type: 'data',
        array: labels.map(l => byLabel[l][r.condition_id!]?.sd || 0),
        visible: true, color: plotTheme().font, thickness: 1, width: 2,
      },
      type: 'bar', name: r.condition_name, marker: { color: r.colour },
      offsetgroup: r.condition_id, legendgroup: r.condition_id,
    })
    // Dots: individual replica occupancies, bound to the condition's offset
    // group so they sit inside the bar rather than between grouped bars.
    if (showDots) {
      const dx: string[] = [], dy: number[] = []
      for (const l of labels) {
        const c = byLabel[l][r.condition_id!]
        if (c?.per_replica) for (const v of c.per_replica) { dx.push(l); dy.push(v) }
      }
      traces.push({
        x: dx, y: dy, type: 'scatter', mode: 'markers',
        offsetgroup: r.condition_id, legendgroup: r.condition_id,
        marker: { color: r.colour, size: 4, line: { color: plotTheme().grid, width: 0.5 }, opacity: 0.6 },
        name: `${r.condition_name} reps`, showlegend: false,
        hovertemplate: '%{x}<br>rep: %{y:.3f}<extra></extra>',
      })
    }
  }
  const target = results[0]?.target
  const cutoff = results[0]?.cutoff_nm
  const nrep = results[0]?.n_replicas
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 'auto' }}>
          {results[0]?.mode === 'hbond' ? 'Residues H-bonding with' : 'Residues contacting'} <code style={{ color: 'var(--text-code)' }}>{target}</code>
          {results[0]?.mode === 'hbond' ? ' (H-bond geometry)' : ` within ${cutoff} nm`} · mean ± SD over {nrep} replicas
          {results[0]?.frame_filtered && <span style={{ color: 'var(--accent-bright)' }}> · frame-filtered ({results[0].filter_desc})</span>}
        </span>
        <button onClick={() => setShowDots(s => !s)} style={{
          padding: '4px 10px', borderRadius: 6, fontSize: 11,
          background: showDots ? 'var(--bg-elevated)' : 'var(--bg-surface)',
          color: showDots ? 'var(--text-primary)' : 'var(--text-muted)',
          border: `1px solid ${showDots ? 'var(--border-light)' : 'var(--border)'}`,
        }}>Replica dots</button>
      </div>
      <Plot data={traces as any}
        config={{ responsive: true, displaylogo: false }} useResizeHandler style={{ width: '100%' }}
        layout={{
          autosize: true, uirevision: 'keep', height: 460, margin: { l: 55, r: 20, t: 20, b: 110 },
          paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
          font: { color: plotTheme().font, family: plotTheme().fontFamily, size: 10 },
          barmode: 'group', scattermode: 'group',
          xaxis: { tickangle: -60, gridcolor: plotTheme().grid, automargin: true },
          yaxis: { title: { text: 'occupancy (fraction of frames)' }, gridcolor: plotTheme().grid, range: [0, 1] },
          legend: { bgcolor: 'rgba(0,0,0,0)', x: 1, xanchor: 'right', y: 1 },
        }} />
    </div>
  )
}



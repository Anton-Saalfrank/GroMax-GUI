/**
 * Shared-basis PCA: scatter / density / both, per-replica colouring,
 * start-end markers, and extreme-structure links.
 */
import React, { useState } from 'react'
import Plot from './Plot'
import { Box, FolderOpen, Copy, Check } from 'lucide-react'
import { api } from '../../api/client'
import { plotTheme } from '../../plotTheme'
import { useStore } from '../../store'
import { PLOT_CONFIG, getPlotBg, getAxis, REP_PALETTE } from './shared'

/**
 * One replica's stretch of a cloud, and how to read a time off it.
 *
 * Points within a cloud are in trajectory order, so point n of a segment is
 * frame n of that replica's trimmed trajectory — at t_start + n*dt. The start
 * and timestep are measured on the trimmed file itself rather than derived from
 * the requested window, because trjconv lands on the nearest frame rather than
 * the exact time asked for.
 */
interface Segment {
  index: number
  n_frames?: number | null
  t_start_ps?: number | null
  dt_ps?: number | null
}

interface CloudMeta {
  conditionId?: string
  conditionName?: string
  segments: Segment[]
}

/**
 * Turn a clicked point into the moment it was recorded at.
 *
 * Returns null rather than a guess whenever the timing is unknown — a PCA run
 * from before this was recorded has no t_start/dt, and inventing one would open
 * a confidently-labelled snapshot of the wrong frame.
 */
export function frameForPoint(meta: CloudMeta | undefined, pointNumber: number) {
  if (!meta?.conditionId || !Array.isArray(meta.segments)) return null
  let offset = 0
  for (const seg of meta.segments) {
    const n = seg.n_frames || 0
    if (pointNumber < offset + n) {
      const local = pointNumber - offset
      if (seg.t_start_ps == null || seg.dt_ps == null) return null
      return {
        conditionId: meta.conditionId,
        conditionName: meta.conditionName || '',
        replicaIndex: seg.index,
        timeNs: (seg.t_start_ps + local * seg.dt_ps) / 1000,
      }
    }
    offset += n
  }
  return null
}

// A row for one condition's extreme-structure PDB with reveal + copy-path actions
function ExtremeRow({ ex }: { ex: any }) {
  const [copied, setCopied] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const reveal = async () => {
    try {
      const r = await api.pca.reveal(ex.path)
      if (r.ok) { setRevealed(true); setTimeout(() => setRevealed(false), 1500) }
    } catch { /* ignore */ }
  }
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(ex.path)
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
      borderRadius: 'var(--radius)', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    }}>
      <Box size={14} color={ex.colour} />
      <span style={{ fontSize: 12, fontWeight: 600 }}>{ex.condition_name}</span>
      <code style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {ex.filename}
      </code>
      <button onClick={reveal} style={{
        display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6,
        background: 'var(--bg-surface)', color: revealed ? 'var(--green)' : 'var(--text-secondary)',
        border: '1px solid var(--border-light)', fontSize: 11,
      }}>
        {revealed ? <Check size={12} /> : <FolderOpen size={12} />} {revealed ? 'Revealed' : 'Reveal in Finder'}
      </button>
      <button onClick={copyPath} title="Copy full path" style={{
        display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6,
        background: 'var(--bg-surface)', color: copied ? 'var(--green)' : 'var(--text-secondary)',
        border: '1px solid var(--border-light)', fontSize: 11,
      }}>
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy path'}
      </button>
    </div>
  )
}

export function PcaPlot({ result }: { result: any }) {
  const clouds = result.clouds || []
  const [mode, setMode] = React.useState<'scatter' | 'density' | 'both'>('scatter')
  const [bins, setBins] = React.useState(60)
  const [byReplica, setByReplica] = React.useState(false)
  const [showStartEnd, setShowStartEnd] = React.useState(false)
  const { setStructureFrame, setRequestedTab } = useStore()

  /*
   * A point in a PCA cloud IS a conformation — that is the whole claim the plot
   * makes — so the question it provokes is always "what does that one look
   * like?". Clicking answers it, with the same snapshot machinery the
   * time-series plots use, so every highlight already built applies to it too.
   *
   * Only possible when the run recorded each replica's start time and timestep.
   * PCA results computed before that was stored have no way back to a moment,
   * and the honest answer there is to say so rather than open a frame that is
   * merely plausible.
   */
  const canOpenFrames = clouds.some((c: any) =>
    c.condition_id && (c.replica_segments || []).some(
      (s: any) => s && s.t_start_ps != null && s.dt_ps != null))

  const openFrame = (e: any) => {
    const pt = e?.points?.[0]
    if (!pt) return
    const f = frameForPoint(pt.data?.meta, pt.pointNumber ?? pt.pointIndex ?? -1)
    if (!f) return
    setStructureFrame({
      ...f,
      label: `PCA ${result.analysis_name || ''}`.trim(),
      includeSolvent: false,
    })
    setRequestedTab('structure')
  }

  // Does any cloud carry per-replica frame segments (per-condition PCA)?
  const canColourByReplica = clouds.some((c: any) => (c.replica_segments || []).length > 1)
          // REP_PALETTE comes from ./shared (single source: lib/stats).

  const traces: any[] = []
  for (const c of clouds) {
    if (mode === 'density' || mode === 'both') {
      traces.push({
        x: c.x, y: c.y, type: 'histogram2dcontour', name: `${c.label} density`,
        showscale: false, ncontours: 14, nbinsx: bins, nbinsy: bins,
        contours: { coloring: 'fill', showlines: true },
        line: { width: 0.6, color: c.colour },
        colorscale: [[0, 'rgba(0,0,0,0)'], [1, c.colour]],
        opacity: 0.55, showlegend: false,
      })
    }
    if (mode === 'scatter' || mode === 'both') {
      // Colour by replica: segment the in-order points using replica_segments
      const segs = c.replica_segments || []
      if (byReplica && segs.length > 1) {
        let offset = 0
        for (const seg of segs) {
          const n = seg.n_frames || 0
          const xs = c.x.slice(offset, offset + n)
          const ys = c.y.slice(offset, offset + n)
          offset += n
          const col = REP_PALETTE[(seg.index - 1) % REP_PALETTE.length]
          traces.push({
            x: xs, y: ys, type: 'scattergl', mode: 'markers',
            marker: { color: col, size: 3, opacity: 0.5 },
            name: `${c.label} rep${seg.index}`,
            // This trace is one replica, so its own segment is the whole story.
            meta: { conditionId: c.condition_id, conditionName: c.condition_name,
                    segments: [seg] } as CloudMeta,
            hovertemplate: `${c.label} rep${seg.index}<br>%{x:.2f}, %{y:.2f}`
              + `<br><i>click to open this frame in 3D</i><extra></extra>`,
          })
          // Start/end markers for this replica's trajectory
          if (showStartEnd && xs.length) {
            traces.push({
              x: [xs[0]], y: [ys[0]], type: 'scatter', mode: 'markers',
              marker: { color: col, size: 11, symbol: 'circle', line: { color: plotTheme().grid, width: 2 } },
              name: `rep${seg.index} start`, showlegend: false,
              hovertemplate: `${c.label} rep${seg.index} START<extra></extra>`,
            })
            traces.push({
              x: [xs[xs.length - 1]], y: [ys[ys.length - 1]], type: 'scatter', mode: 'markers',
              marker: { color: col, size: 12, symbol: 'square', line: { color: plotTheme().title, width: 2 } },
              name: `rep${seg.index} end`, showlegend: false,
              hovertemplate: `${c.label} rep${seg.index} END<extra></extra>`,
            })
          }
        }
      } else {
        traces.push({
          x: c.x, y: c.y, type: 'scattergl', mode: 'markers',
          marker: { color: c.colour, size: 3, opacity: mode === 'both' ? 0.25 : 0.45 },
          name: c.label,
          // The whole cloud: which replica a point belongs to is worked out from
          // the segment boundaries, since the points are in trajectory order.
          meta: { conditionId: c.condition_id, conditionName: c.condition_name,
                  segments: segs } as CloudMeta,
          hovertemplate: `${c.label}<br>%{x:.2f}, %{y:.2f}`
            + `<br><i>click to open this frame in 3D</i><extra></extra>`,
        })
        // Start/end markers per replica even when not colouring by replica
        if (showStartEnd && segs.length) {
          let off = 0
          for (const seg of segs) {
            const n = seg.n_frames || 0
            if (n > 0) {
              traces.push({
                x: [c.x[off]], y: [c.y[off]], type: 'scatter', mode: 'markers',
                marker: { color: c.colour, size: 11, symbol: 'circle', line: { color: plotTheme().grid, width: 2 } },
                name: `start`, showlegend: false,
                hovertemplate: `${c.label} rep${seg.index} START<extra></extra>`,
              })
              traces.push({
                x: [c.x[off + n - 1]], y: [c.y[off + n - 1]], type: 'scatter', mode: 'markers',
                marker: { color: c.colour, size: 12, symbol: 'square', line: { color: plotTheme().title, width: 2 } },
                name: `end`, showlegend: false,
                hovertemplate: `${c.label} rep${seg.index} END<extra></extra>`,
              })
            }
            off += n
          }
        }
      }
    }
  }

  const ve = result.var_explained || []
  const veTrace = [{
    x: ve.map((_: number, i: number) => `PC${i + 1}`),
    y: ve, type: 'bar', marker: { color: '#3b82f6' },
  }]

  const modeBtn = (m: typeof mode, label: string) => (
    <button onClick={() => setMode(m)} style={{
      padding: '4px 12px', borderRadius: 6, fontSize: 11,
      background: mode === m ? 'var(--accent)' : 'var(--bg-surface)',
      color: mode === m ? '#fff' : 'var(--text-secondary)',
      border: `1px solid ${mode === m ? 'transparent' : 'var(--border)'}`,
      fontWeight: mode === m ? 600 : 400,
    }}>{label}</button>
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 'auto' }}>
          {result.analysis_name ? <strong style={{ color: 'var(--text-secondary)' }}>{result.analysis_name}</strong> : 'PCA'} · {result.n_atoms} atoms · <code style={{ color: 'var(--text-code)' }}>{result.selection}</code>
        </span>
        {modeBtn('scatter', 'Scatter')}
        {modeBtn('density', 'Density')}
        {modeBtn('both', 'Both')}
      </div>
      {/* Sub-controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
        {(mode === 'density' || mode === 'both') && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
            Density coarseness
            <input type="range" min={15} max={120} value={bins} onChange={e => setBins(+e.target.value)} style={{ width: 120 }} />
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{bins} bins</span>
          </label>
        )}
        {canColourByReplica && (mode === 'scatter' || mode === 'both') && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={byReplica} onChange={e => setByReplica(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
            Colour by replica
          </label>
        )}
        {canColourByReplica && (mode === 'scatter' || mode === 'both') && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showStartEnd} onChange={e => setShowStartEnd(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
            Mark start (●) / end (■)
          </label>
        )}
      </div>
      {canOpenFrames && (mode === 'scatter' || mode === 'both') && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          Click any point to open that conformation in the Structure tab.
        </div>
      )}
      <Plot
        data={traces}
        onClick={canOpenFrames ? openFrame : undefined}
        config={PLOT_CONFIG} useResizeHandler style={{ width: '100%' }}
        layout={{
          autosize: true, uirevision: 'keep', height: 460, margin: { l: 60, r: 20, t: 40, b: 50 }, ...getPlotBg(),
          title: { text: result.title || 'PCA', font: { color: plotTheme().title, size: 14 } },
          xaxis: { title: { text: result.xlabel || 'PC1' }, ...getAxis() },
          yaxis: { title: { text: result.ylabel || 'PC2' }, ...getAxis(), scaleanchor: 'x' },
          legend: { bgcolor: 'rgba(0,0,0,0)', bordercolor: plotTheme().grid, borderwidth: 1, x: 1, xanchor: 'right', y: 1 },
        }} />
      {ve.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Variance explained per component</div>
          <Plot
            data={veTrace as any}
            config={{ ...PLOT_CONFIG, displayModeBar: false }} useResizeHandler style={{ width: '100%' }}
            layout={{
              autosize: true, uirevision: 'keep', height: 180, margin: { l: 50, r: 20, t: 10, b: 40 }, ...getPlotBg(),
              xaxis: { ...getAxis() }, yaxis: { title: { text: '%' }, ...getAxis() },
            }} />
        </div>
      )}

      {/* Extreme structures */}
      {result.extremes && result.extremes.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Extreme structures along PC1 & PC2</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
            Multi-model PDBs showing the structure at the extremes of motion along the first two
            principal components — one per condition. Open in ChimeraX (or any viewer) to inspect
            or animate the dominant motion.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {result.extremes.map((ex: any) => (
              <ExtremeRow key={ex.condition_id} ex={ex} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}



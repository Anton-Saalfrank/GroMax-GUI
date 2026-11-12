import React, { useState, useMemo, useEffect, useCallback } from 'react'
import { Dna, Eye, EyeOff, BarChart3, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../api/client'
import { LinePlot, HeatmapPlot } from './plots/LinePlot'
import { HeatmapScaleControls } from './plots/HeatmapScaleControls'
import { XCorrPlot } from './plots/XCorrPlot'
import { NewlyExposedPanel } from './plots/NewlyExposedPanel'
import { HelixMotionPlot } from './plots/HelixMotionPlot'
import { MatrixDistributionPanel } from './plots/MatrixDistributionPanel'
import { combineStats, DEFAULT_SCALE } from '../lib/heatmapScale'
import type { MatrixStats, ScaleSettings } from '../lib/heatmapScale'
import type { RowBaselineBundle } from '../lib/rowNormalise'

/**
 * The unit out of an axis label like 'RMSF (nm)', for the scale readout.
 * Returns '' when the label has no parenthesised unit, rather than guessing.
 */
function unitOf(label?: string): string {
  const m = /\(([^)]+)\)\s*$/.exec(label || '')
  return m ? m[1] : ''
}
import { Scatter2DPlot } from './plots/Scatter2DPlot'
import { PcaPlot } from './plots/PcaPlot'
import { ContactsPlot } from './plots/ContactsPlot'
import type { AnalysisResult, StoredResult } from '../types'

// Managed list of stored analyses with per-item show/hide and delete.
// Reads from the persistent registry, so it survives clearing the Jobs panel.
function AnalysisList({ items, onToggle, onDelete }: {
  items: StoredResult[]
  onToggle: (key: string, hidden: boolean) => void
  onDelete: (key: string) => void
}) {
  if (items.length === 0) return null
  const nVisible = items.filter(i => !i.hidden).length
  return (
    <div style={{ marginBottom: 22, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          Analyses ({nVisible}/{items.length} shown)
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => items.forEach(i => i.hidden && onToggle(i.cache_key, false))}
            style={miniBtn}>Show all</button>
          <button onClick={() => items.forEach(i => !i.hidden && onToggle(i.cache_key, true))}
            style={miniBtn}>Hide all</button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {items.map(a => (
          <div key={a.cache_key} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
            borderRadius: 'var(--radius)', background: 'var(--bg-elevated)',
            border: '1px solid var(--border)', opacity: a.hidden ? 0.45 : 1,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.colour, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent-bright)' }}>{a.type}</span>
            <span style={{ fontSize: 12, fontWeight: 600, textDecoration: a.hidden ? 'line-through' : 'none' }}>{a.name}</span>
            {/* Only when it is NOT the default: badging every GROMACS result
                would be noise in the projects that never leave GROMACS. */}
            {a.engine && a.engine !== 'gromacs' && (
              <span title={`Produced by ${a.engine}`} style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 8,
                background: 'var(--bg-surface)', color: 'var(--text-secondary)',
                border: '1px solid var(--border)', fontFamily: 'var(--font-mono)',
              }}>{a.engine}</span>
            )}
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {a.condition_name}</span>
            <button onClick={() => onToggle(a.cache_key, !a.hidden)}
              title={a.hidden ? 'Show this analysis' : 'Hide this analysis'}
              style={{ marginLeft: 'auto', padding: 4, background: 'transparent', color: a.hidden ? 'var(--text-muted)' : 'var(--text-secondary)', border: 'none' }}>
              {a.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button onClick={() => onDelete(a.cache_key)} title="Delete this analysis"
              style={{ padding: 4, background: 'transparent', color: 'var(--text-muted)', border: 'none' }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const miniBtn: React.CSSProperties = {
  padding: '3px 9px', borderRadius: 5, fontSize: 10,
  background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
  border: '1px solid var(--border)',
}


/**
 * Load analyses from the PERSISTENT registry (not the transient jobs list), so
 * clearing the Jobs panel never hides plots. Refreshes when jobs complete so
 * newly-finished analyses appear automatically.
 */
function useStoredResults(sessionId: string) {
  const { jobs } = useStore()
  const [items, setItems] = useState<StoredResult[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = React.useCallback(() => {
    if (!sessionId) return Promise.resolve()
    return api.analysis.storedResults(sessionId)
      .then(r => setItems(r.results))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [sessionId])

  useEffect(() => { refresh() }, [refresh])
  // re-fetch whenever a job finishes (count of completed jobs changes).
  // `refresh` is a useCallback over sessionId, so listing it adds no re-runs.
  const nDone = jobs.filter(j => j.status === 'completed').length
  useEffect(() => { refresh() }, [nDone, refresh])

  return { items, setItems, refresh, loading }
}

/** Group visible stored results by "type · name" for plotting. Also returns the
 *  cache key per (group, condition) so heavy data (heatmap matrices) can be
 *  fetched on demand. */
function groupForPlots(items: StoredResult[]) {
  const byKey: Record<string, AnalysisResult[]> = {}
  const keys: Record<string, Record<string, string>> = {}
  for (const it of items) {
    if (it.hidden) continue
    const r = it.result
    if (!r) continue
    const isPlottable = r.x || (r as any).z || (r as any).z_deferred ||
                        (r as any).clouds || (r as any).contacts
    if (!isPlottable) continue
    const key = it.name ? `${it.type} · ${it.name}` : it.type
    if (!byKey[key]) { byKey[key] = []; keys[key] = {} }
    const cid = r.condition_id || it.condition_id
    keys[key][cid] = it.cache_key
    const existing = byKey[key].findIndex(x => x.condition_id === r.condition_id)
    if (existing >= 0) byKey[key][existing] = r
    else byKey[key].push(r)
  }
  return { byKey, keys }
}



// ─── Scatter2d (PCA landscape; overlays conditions by colour) ─────────────────
function AnalysisBlock({ results, showSd, showReplicas, keyByCondition, sessionId,
                        onAnalysisCreated }: {
  results: AnalysisResult[]; showSd: boolean; showReplicas: boolean
  keyByCondition?: Record<string, string>; sessionId?: string
  onAnalysisCreated?: () => void
}) {
  const kind = results[0]?.kind || 'line'

  /*
   * Per-residue baselines for this block, fetched once and shared by every map.
   *
   * Only for residue-by-time maps, and only lazily: it reads every replica's
   * stored matrix server-side, which is cheap but not free, and means nothing
   * for a square correlation matrix. A failure is non-fatal — the maps fall
   * back to absolute values and per-map scaling.
   */
  const isRolling = kind === 'heatmap' && Boolean((results[0] as any)?.time_x)
  const baselineKeys = useMemo(
    () => results.map(r => keyByCondition?.[r.condition_id || ''])
                 .filter((k): k is string => !!k),
    [results, keyByCondition])
  // One scalar standing for the list, so the effect below has a dependency
  // that can be compared by value instead of by array identity.
  const baselineKey = baselineKeys.join(',')
  const [baselines, setBaselines] = useState<RowBaselineBundle | null>(null)
  useEffect(() => {
    if (!isRolling || !sessionId || !baselineKey) {
      setBaselines(null)
      return
    }
    let cancelled = false
    // Rebuilt from the key inside the effect, so the dependency is the key
    // itself rather than an array whose identity changes every render.
    api.analysis.rowBaseline(sessionId, baselineKey.split(','))
      .then(b => { if (!cancelled) setBaselines(b as RowBaselineBundle) })
      .catch(() => { if (!cancelled) setBaselines(null) })
    return () => { cancelled = true }
  }, [isRolling, sessionId, baselineKey])

  /*
   * One colour scale for every heatmap in this block.
   *
   * Held here rather than inside each map because the maps are one per
   * condition, and the whole point is that they share a range — per-map state
   * would let two conditions sit side by side on two different scales, which
   * is the bug these controls exist to fix.
   */
  const [scale, setScale] = useState<ScaleSettings>(DEFAULT_SCALE)
  /* Off by default: it fetches and summarises every replicate's matrix, which
     is real work on a long trajectory and not what you want on every visit. */
  const [showDistribution, setShowDistribution] = useState(false)
  /* Fallbacks reported upward by maps whose result predates pooled stats. */
  const [fallbackStats, setFallbackStats] = useState<Record<string, MatrixStats | null>>({})
  const reportStats = useCallback((id: string, st: MatrixStats | null) => {
    // Compared by VALUE: the child sends a freshly built object, so an identity
    // check would store a new state every time and re-render for ever.
    setFallbackStats(prev => (
      JSON.stringify(prev[id] ?? null) === JSON.stringify(st ?? null)
        ? prev : { ...prev, [id]: st }))
  }, [])

  const diverging = Boolean((results[0] as any)?.diverging) || kind === 'xcorr'
  const pooled = useMemo(() => {
    const given = results.map(r => (r as any).z_stats as MatrixStats | undefined)
    const anyGiven = given.some(Boolean)
    const list = results.map((r, i) =>
      given[i] || fallbackStats[r.condition_id || String(i)] || null)
    return { stats: combineStats(list), approximate: !anyGiven }
  }, [results, fallbackStats])

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16, marginBottom: 20 }}>
      {/* A multi-channel line result (helix motion) gets the stacked view; it is
          still a plain line result underneath, so Compare and Repeat detail
          treat it as the piston series without knowing about channels. */}
      {kind === 'line' && results.some((r: any) => r.channels?.length)
        ? <HelixMotionPlot results={results} cacheKeys={keyByCondition} />
        : kind === 'line' && <LinePlot results={results} showSd={showSd} showReplicas={showReplicas} />}
      {kind === 'line' && results.filter((r: any) => r.newly_exposed).map((r: any, i) => (
        <NewlyExposedPanel key={r.condition_id || i} r={r} />
      ))}
      {kind === 'scatter2d' && <Scatter2DPlot results={results} />}
      {(kind === 'heatmap' || kind === 'xcorr') && (
        <HeatmapScaleControls
          settings={scale} onChange={setScale}
          stats={pooled.stats} diverging={diverging}
          unit={unitOf(results[0]?.zlabel)}
          pooledFrom={pooled.stats?.n_matrices}
          approximate={pooled.approximate}
        />
      )}
      {kind === 'heatmap' && (
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:11,
                        marginBottom:8, color:'var(--text-secondary)' }}>
          <input type="checkbox" checked={showDistribution}
                 onChange={e => setShowDistribution(e.target.checked)} />
          Distribution across replicates — the spread inside each matrix, and the
          average-of-averages comparison
        </label>
      )}
      {kind === 'heatmap' && showDistribution && (
        <MatrixDistributionPanel results={results} cacheKeys={keyByCondition} />
      )}
      {kind === 'heatmap' && results.map(r => (
        <HeatmapPlot key={r.condition_id} r={r} sessionId={sessionId}
          cacheKey={keyByCondition?.[r.condition_id || '']}
          scale={scale} pooledStats={pooled.stats}
          onStats={st => reportStats(r.condition_id || '', st)}
          baselines={baselines}
          onAnalysisCreated={onAnalysisCreated} />
      ))}
      {kind === 'xcorr' && results.map(r => (
        <XCorrPlot key={r.condition_id} r={r} sessionId={sessionId}
          cacheKey={keyByCondition?.[r.condition_id || '']}
          scale={scale} pooledStats={pooled.stats}
          onStats={st => reportStats(r.condition_id || '', st)} />
      ))}
      {kind === 'pca' && results.map((r, i) => <PcaPlot key={i} result={r} />)}
      {kind === 'contacts' && <ContactsPlot results={results} />}
    </div>
  )
}

// Ranked contact occupancy — grouped bars per condition, with SD error bars
// and individual replica dots.
export default function ResultsTab() {
  const { activeSession, theme } = useStore()
  const sessionId = activeSession?.id || ''
  const { items, setItems, refresh, loading } = useStoredResults(sessionId)
  const [showSd, setShowSd] = useState(true)
  const [showReplicas, setShowReplicas] = useState(false)

  const grouped = useMemo(() => groupForPlots(items), [items])
  const byType = grouped.byKey
  const types = Object.keys(byType)

  const toggle = async (key: string, hidden: boolean) => {
    // optimistic update, then persist
    setItems(prev => prev.map(i => i.cache_key === key ? { ...i, hidden } : i))
    try { await api.analysis.setVisibility(sessionId, key, hidden) }
    catch { refresh() }
  }
  const del = async (key: string) => {
    await api.analysis.deleteInstance(sessionId, key)
    await refresh()
  }

  const list = (
    <AnalysisList items={items} onToggle={toggle} onDelete={del} />
  )

  if (items.length === 0) {
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px' }}>
        <div style={{ maxWidth: 860 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', maxWidth: 300 }}>
              <Dna size={40} style={{ margin: '0 auto 12px', opacity: 0.25 }} />
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>
                {loading ? 'Loading analyses…' : 'No results yet'}
              </div>
              <div style={{ fontSize: 12 }}>Run an analysis from the Analyses tab. Completed results appear here and persist — clearing the Jobs panel won't remove them.</div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px' }}>
      <div style={{ maxWidth: 860 }}>
        {list}
        {types.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 0', fontSize: 12 }}>
            All analyses are hidden. Use the eye icons above to show them.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <h2 style={{ marginRight: 'auto' }}>Results</h2>
              <button onClick={() => setShowSd(s => !s)} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 'var(--radius)', fontSize: 12,
                background: showSd ? 'var(--bg-elevated)' : 'var(--bg-surface)', color: showSd ? 'var(--text-primary)' : 'var(--text-muted)',
                border: `1px solid ${showSd ? 'var(--border-light)' : 'var(--border)'}`,
              }}><BarChart3 size={13} /> ±SD band</button>
              <button onClick={() => setShowReplicas(s => !s)} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 'var(--radius)', fontSize: 12,
                background: showReplicas ? 'var(--bg-elevated)' : 'var(--bg-surface)', color: showReplicas ? 'var(--text-primary)' : 'var(--text-muted)',
                border: `1px solid ${showReplicas ? 'var(--border-light)' : 'var(--border)'}`,
              }}>{showReplicas ? <Eye size={13} /> : <EyeOff size={13} />} Individual replicas</button>
            </div>
            {types.map(t => (
              <AnalysisBlock key={`${t}-${theme}`} results={byType[t]} showSd={showSd} showReplicas={showReplicas}
                keyByCondition={grouped.keys[t]} sessionId={sessionId}
                onAnalysisCreated={refresh} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

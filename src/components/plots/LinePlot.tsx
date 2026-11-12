/**
 * Line plots (RMSF, RMSD, Rg, SASA, H-bonds, mindist) and the 2D-RMSD heatmap.
 *
 * The heatmap fetches its matrix on demand: matrices are megabytes each, so
 * they're deliberately excluded from the bulk results payload.
 */
import React, { useState, useMemo, useEffect } from 'react'
import Plot from './Plot'
import { api } from '../../api/client'
import { normaliseRows } from '../../lib/rowNormalise'
import type { NormMode, RowBaseline, RowBaselineBundle } from '../../lib/rowNormalise'
import { plotTheme } from '../../plotTheme'
import { useStore } from '../../store'
import { residuesToSele } from '../../lib/nglSelection'
import { residuesInRange, describeResidues } from '../../lib/matrixRegions'
import { decimateMinMax } from '../../lib/decimate'
import { AxisRangeControls } from './AxisRangeControls'
import type { AxisExtent } from './AxisRangeControls'
import { DEFAULT_SCALE, resolveRange, statsFromMatrix } from '../../lib/heatmapScale'
import type { MatrixStats, ScaleSettings } from '../../lib/heatmapScale'
import type { AnalysisResult } from '../../types'
import { PLOT_CONFIG, getPlotBg, getAxis, navBtn } from './shared'

/**
 * The two halves of a dragged box on a correlation matrix.
 *
 * A box on a DCCM is a statement about two stretches of sequence at once: the
 * columns it spans and the rows it spans. Colouring them differently on the
 * structure is what turns "there is an off-diagonal patch here" into "THIS loop
 * moves with THAT helix" — the same reading an AlphaFold PAE map gets.
 */
const REGION_STYLE = [
  { id: 'dccm-region-x', axis: 'x' as const, colour: '#4fd0d0', role: 'columns' },
  { id: 'dccm-region-y', axis: 'y' as const, colour: '#f79f4f', role: 'rows' },
]

// ─── Line comparison (overlays conditions) ────────────────────────────────────
export function LinePlot({ results, showSd, showReplicas }: {
  results: AnalysisResult[]; showSd: boolean; showReplicas: boolean
}) {
  const traces: any[] = []
  for (const r of results) {
    const colour = r.colour || '#3b82f6'
    if (showReplicas && r.replicas && r.replicas.length > 1) {
      for (const rep of r.replicas) {
        traces.push({
          x: r.x, y: rep.y, type: 'scatter', mode: 'lines',
          line: { color: colour, width: 0.7 }, opacity: 0.25,
          showlegend: false, hoverinfo: 'skip',
        })
      }
    }
    if (showSd && r.y_sd && r.y_mean && r.y_sd.some(v => v > 0)) {
      const upper = r.y_mean.map((v, i) => v + (r.y_sd![i] || 0))
      const lower = r.y_mean.map((v, i) => v - (r.y_sd![i] || 0))
      traces.push({
        x: [...r.x, ...[...r.x].reverse()],
        y: [...upper, ...lower.reverse()],
        fill: 'toself', fillcolor: colour, opacity: 0.15,
        line: { color: 'transparent' }, type: 'scatter',
        showlegend: false, hoverinfo: 'skip',
      })
    }
    traces.push({
      x: r.x, y: r.y_mean || r.y, type: 'scatter', mode: 'lines',
      line: { color: colour, width: 2 },
      name: r.n_replicas && r.n_replicas > 1 ? `${r.condition_name} (n=${r.n_replicas})` : r.condition_name,
    })
  }
  const first = results[0]

  // The mean can only span frames every replica has, so it stops at the
  // SHORTEST replica. Previously invisible: Results (mean) ended at 1.2 us
  // while Compare (per-replica) ran to 2.5 us with no explanation.
  const truncated = results.filter((r: any) => r.mean_truncated)

  return (
    <>
    {truncated.length > 0 && (
      <div style={{
        margin: '0 0 8px', padding: '7px 10px', borderRadius: 4, fontSize: 11,
        background: 'rgba(247,210,79,0.12)', lineHeight: 1.5,
      }}>
        ℹ The averaged line stops at the shortest replica, because a mean needs
        every replica to have data at that time point.
        {truncated.map((r: any, i: number) => (
          <div key={i} style={{ marginTop: 3 }}>
            <strong>{r.condition_name}</strong>: mean ends at{' '}
            {Math.round(r.t_end_mean)} ns, longest replica runs to{' '}
            {Math.round(r.t_end_longest)} ns
            {r.short_replicas?.length
              ? ` (shortest: replica ${r.short_replicas.join(', ')})` : ''}.
          </div>
        ))}
        <div style={{ marginTop: 3, opacity: 0.8 }}>
          Use “Individual replicas” to see the full time range.
        </div>
      </div>
    )}
    <Plot data={traces} config={PLOT_CONFIG} useResizeHandler style={{ width: '100%' }}
      layout={{
        autosize: true, uirevision: 'keep', height: 440, margin: { l: 60, r: 20, t: 40, b: 50 }, ...getPlotBg(),
        title: { text: first?.title || '', font: { color: plotTheme().title, size: 14 } },
        xaxis: { title: { text: first?.xlabel || '' }, ...getAxis() },
        yaxis: { title: { text: first?.ylabel || '' }, ...getAxis() },
        legend: { bgcolor: 'rgba(0,0,0,0)', bordercolor: plotTheme().grid, borderwidth: 1, x: 1, xanchor: 'right', y: 1 },
        hovermode: 'x unified',
      }} />
    </>
  )
}

// ─── Heatmap (one per condition) ──────────────────────────────────────────────
// Matrices are large, so they're NOT included in the bulk results payload.
// This component fetches the matrix for the selected replica on demand.
export function HeatmapPlot({ r, cacheKey, sessionId, scale, pooledStats, onStats,
                              onAnalysisCreated, baselines }: {
  r: AnalysisResult; cacheKey?: string; sessionId?: string
  /** Colour-scale settings, shared by every map in the block. */
  scale?: ScaleSettings
  /** Range pooled across every map in the block, so colours are comparable. */
  pooledStats?: MatrixStats | null
  /** Reported upward when this result carries no pooled stats of its own. */
  onStats?: (s: MatrixStats | null) => void
  /** Called after a correlation is computed, so the results list can refresh. */
  onAnalysisCreated?: () => void
  /**
   * Per-residue baselines measured across every condition in the block.
   *
   * Normalising against these rather than against each map's own rows is what
   * keeps a real difference between conditions visible — see rowNormalise.ts.
   */
  baselines?: RowBaselineBundle | null
}) {
  // Memoised: the `|| []` builds a fresh array whenever replica_indices is
  // absent, which made every memo depending on it recompute each render.
  const indices: number[] = useMemo(() => (r as any).replica_indices || [], [r])
  const hasReps = indices.length > 1
  const [repIdx, setRepIdx] = useState(0)
  const [showHist, setShowHist] = useState(false)
  const [loading, setLoading] = useState(false)
  /*
   * What a drag does. Local to each map, not shared like the colour scale:
   * zooming is navigation and belongs to the map you are looking at, whereas a
   * colour range has to be the same everywhere or the maps cannot be compared.
   *
   * 'zoom' by default. Plotly's modebar offers Zoom, Pan, Zoom in/out,
   * Autoscale and Reset for a heatmap but NEVER Box Select — it hides that
   * button for traces with no point-selection support — so select is the mode
   * that needs a control of its own, and zoom is the one that should be there
   * without asking. A drag that jumps to another tab is also a big thing to
   * trigger by accident, where a zoom undoes with a double-click.
   */
  const [dragMode, setDragMode] = useState<string>('zoom')

  /*
   * Absolute flexibility, or each residue against its own usual?
   *
   * A rolling-RMSF map is dominated by WHERE the protein is floppy rather than
   * WHEN anything happened: a disordered tail holds the top of the colour range
   * for the whole run while a buried residue doubling its fluctuation moves a
   * few percent of it. Dividing each row by its own median puts every residue
   * on the same footing. See rowNormalise.ts — including what it destroys.
   */
  const [normScale, setNormScale] = useState<NormMode>('ratio')
  /** 'none' | 'shared' | 'own' | a condition_id to use as the reference. */
  const [normBase, setNormBase] = useState<string>('none')

  /*
   * The visible window, as numbers.
   *
   * Dragging is fine for "roughly there" and hopeless for "residues 120 to 140,
   * 340 to 350 ns" — you cannot hit that with a mouse, and on a map 75 columns
   * wide one pixel is most of a window. So the axis ranges are STATE, edited
   * either by typing or by dragging, and null means "fit the data".
   *
   * Plotly's semantics here were worth checking rather than assuming, since
   * uirevision exists precisely to make it ignore programmatic layout changes.
   * Measured in 2.35: an explicit `range` DOES win, even after a user zoom and
   * with uirevision unchanged, and `autorange: true` restores the full view. So
   * one piece of state can drive both, as long as dragging writes back into it
   * — which is what onRelayout below is for. Without that write-back the next
   * re-render would snap the view back to whatever was last typed.
   */
  const [view, setView] = useState<{ x: [number, number] | null
                                     y: [number, number] | null }>({ x: null, y: null })
  const [regionNote, setRegionNote] = useState<string | null>(null)
  const { structureLayers, addStructureLayer, updateStructureLayer,
          setRequestedTab, setStructureView, setStructureFrame } = useStore()

  const prefix = (r as any).replica_cache_prefix || cacheKey

  /*
   * Load the WHOLE result for the selected replica, not just its matrix.
   *
   * Fetching only `z` was fine while every matrix was square and shared one
   * residue axis. A rolling RMSF's columns are time windows, and replicas
   * differ in length — so replica 5's matrix against replica 1's time axis
   * would mislabel every column, by more the further apart the two runs are.
   */
  const cacheRef = React.useRef<Record<string, any>>({})
  const [shown, setShown] = useState<any>((r as any).z ? r : null)
  useEffect(() => {
    let cancelled = false
    const idx = indices[repIdx] ?? 1
    // Replica 1's matrix is inline in the aggregated payload.
    if (repIdx === 0 && (r as any).z) { setShown(r); return }
    const key = hasReps ? `${prefix}__rep${idx}` : (cacheKey || '')
    if (cacheRef.current[key]) { setShown(cacheRef.current[key]); return }
    if (!sessionId || !key) return
    setLoading(true)
    api.analysis.storedResult(sessionId, key)
      .then(res => {
        if (cancelled) return
        // Spread over `r` so condition name, colour and the replica list —
        // which live on the aggregate, not on one replica — survive.
        const merged = { ...r, ...res }
        cacheRef.current[key] = merged
        setShown(merged)
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
    // `r` is listed: when the aggregate is refetched the inline replica-1
    // matrix comes with it, and the old deps would have kept showing the
    // previous one. The early returns make the extra runs cheap.
  }, [repIdx, sessionId, prefix, cacheKey, r, indices, hasReps])

  const rawZ = shown?.z ?? null
  const nRows = Array.isArray(rawZ) ? rawZ.length : 0
  const nCols = nRows && Array.isArray(rawZ[0]) ? rawZ[0].length : 0

  /**
   * What the x-axis MEANS, which decides what a dragged box can be turned into.
   *
   *   'residues' — a correlation or 2D-RMSD matrix: both axes are residues, so
   *                a box names two regions.
   *   'time'     — a rolling RMSF: a box names residues and a moment.
   *   'other'    — a lag axis, say: a box names residues and nothing else. A
   *                lag is not a moment, so offering to open a structure "at"
   *                one would be meaningless.
   */
  const xKind: 'residues' | 'time' | 'other' =
    shown?.time_x ? 'time' : (shown?.x_is_lag ? 'other' : 'residues')
  const timeX = xKind === 'time'

  /*
   * Offered only for a residue-by-time map. Normalising the rows of a
   * correlation or 2D-RMSD matrix would divide residue i's correlations by
   * their own median — a number with no meaning — and the axes are not even
   * the same kind of thing, so the control simply is not there for those.
   */
  const normMode: NormMode = (timeX && normBase !== 'none') ? normScale : 'none'

  /** The baseline the chosen source resolves to, or null for per-map rows. */
  const baseline: RowBaseline | null = useMemo(() => {
    if (normBase === 'none' || normBase === 'own' || !baselines) return null
    if (normBase === 'shared') {
      return { median: baselines.shared.median, mad: baselines.shared.mad,
               label: `all ${baselines.n_conditions} conditions` }
    }
    const c = baselines.per_condition.find(x => x.condition_id === normBase)
    return c ? { median: c.median, mad: c.mad,
                 label: c.condition_name || 'reference' } : null
  }, [normBase, baselines])

  const normalised = useMemo(
    () => normaliseRows(rawZ as number[][], normMode, baseline),
    [rawZ, normMode, baseline])
  const z = normMode === 'none' ? rawZ : normalised.z

  /*
   * The backend's own axes, when it sent them.
   *
   * These used to be forced to 0..n-1 for BOTH axes, which discarded the
   * residue numbers a DCCM ships (so the tick reading "142" was the 142nd
   * selected atom) and could not represent a rectangular matrix at all.
   */
  const axisX = useMemo(() => {
    const given = shown?.x
    if (Array.isArray(given) && given.length === nCols) return given as number[]
    return Array.from({ length: nCols }, (_, i) => i)
  }, [nCols, shown])

  const axisY = useMemo(() => {
    const given = shown?.y
    if (Array.isArray(given) && given.length === nRows) return given as number[]
    return Array.from({ length: nRows }, (_, i) => i)
  }, [nRows, shown])

  /**
   * One residue identity per matrix ROW, when the analysis could supply them.
   *
   * Rows, specifically: on a square correlation matrix rows and columns are the
   * same residues, but on a residue-by-time map only the rows are.
   */
  const residues: ({ chain: string; resnum: number } | null)[] | null = useMemo(() => {
    const given = shown?.residues
    return Array.isArray(given) && given.length === nRows ? given : null
  }, [nRows, shown])

  /*
   * If the backend measured this analysis, use that — it pooled EVERY replica,
   * including the ones not currently loaded. Otherwise fall back to the matrix
   * on screen and tell the parent, which combines the fallbacks and flags the
   * range as approximate rather than presenting it as pooled.
   */
  const ownStats = (r as any).z_stats as MatrixStats | undefined
  // rawZ, NOT the displayed matrix. These stats feed the colour range SHARED
  // with every other map in the block, in nanometres — so normalising one map
  // would have rescaled all of them into units it no longer uses.
  const fallbackStats = useMemo(
    () => (ownStats ? null : statsFromMatrix(rawZ)), [ownStats, rawZ])
  /*
   * Reported only when the VALUE changes.
   *
   * statsFromMatrix returns a fresh object every call and the parent passes a
   * fresh arrow every render, so an unguarded effect here would be: render ->
   * new callback -> effect -> parent setState -> render. That is the same
   * infinite loop the onResolve handover hit, and it does not announce itself —
   * it just pins a core and stops the tab responding.
   */
  const lastReported = React.useRef<string>('\u0000')
  useEffect(() => {
    if (ownStats || !onStats) return
    const key = fallbackStats ? JSON.stringify(fallbackStats) : ''
    if (key === lastReported.current) return
    lastReported.current = key
    onStats(fallbackStats)
  }, [fallbackStats, ownStats, onStats])

  /** The colour range to draw with, or null to let Plotly scale per map. */
  const range = useMemo(
    // DEFAULT_SCALE rather than null when no settings are supplied: a
    // correlation map must stay pinned to +-1 whatever else happens, since
    // autoscaling one would make "moves together" mean a different colour on
    // every map. For a sequential map with nothing pooled it resolves to null,
    // which is Plotly's own per-map behaviour.
    () => resolveRange(scale ?? DEFAULT_SCALE, pooledStats ?? null,
                       Boolean(r.diverging)),
    [scale, pooledStats, r.diverging])

  /** What the boxes should offer, taken from the axes actually plotted. */
  const extents = useMemo(() => {
    const make = (vals: number[], label: string): AxisExtent | null => {
      if (!vals.length) return null
      const lo = Math.min(...vals), hi = Math.max(...vals)
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
      return { min: lo, max: hi, label: label || 'range',
               // Residue numbers step by one; nanoseconds do not.
               integer: vals.every(v => Number.isInteger(v)) }
    }
    return {
      x: make(axisX, shown?.xlabel || r.xlabel || ''),
      y: make(axisY, shown?.ylabel || r.ylabel || ''),
    }
  }, [axisX, axisY, shown, r.xlabel, r.ylabel])

  const repLabel = hasReps ? `rep ${indices[repIdx]}` : ''

  // Distribution of pairwise RMSD values (upper triangle, excludes the zero
  // diagonal) — a narrow peak means one basin, a broad/bimodal spread means
  // the trajectory visits distinct conformational states.
  // Also rawZ: this panel is the distribution of the measured values, and its
  // axis is labelled in them. Following the display toggle would change its
  // units without changing its label.
  const hist = useMemo(() => {
    const z = rawZ
    if (!showHist || !Array.isArray(z)) return null
    const vals: number[] = []
    // A rectangular map has no diagonal to exclude and no symmetry to halve, so
    // take every cell; the upper-triangle walk below is only right for a square
    // matrix, where it would otherwise double-count each pair.
    if (timeX) {
      for (const row of z) for (const v of row)
        if (typeof v === 'number' && isFinite(v)) vals.push(v)
      return vals
    }
    for (let i = 0; i < z.length; i++)
      for (let j = i + 1; j < z[i].length; j++) {
        const v = z[i][j]
        if (typeof v === 'number' && isFinite(v)) vals.push(v)
      }
    return vals
  }, [rawZ, showHist, timeX])

  /**
   * Region-selection is only offered when a row can name a residue.
   *
   * Without that mapping the drag would yield ranges of matrix indices and no
   * way to say which residues they are, and colouring the structure by index
   * would be confidently wrong wherever the selection skipped anything.
   */
  const canSelectRegions = Boolean((r.diverging || timeX) && residues)
  /** Only a residue axis on BOTH sides gives two regions. */
  const twoRegions = xKind === 'residues' && nRows === nCols

  /** Put a region on the structure, replacing the previous one of its kind. */
  const showRegion = (
    id: string, name: string, colour: string,
    picks: { chain: string; resnum: number }[]
  ) => {
    const sele = residuesToSele(picks)
    // '' would select the whole system — skip rather than paint everything.
    if (!sele) return false
    const patch = {
      name, sele, color: colour, visible: true,
      // 'none' paints the region onto the base representation instead of adding
      // licorice on top: a region here is a stretch of ribbon, not a set of
      // side chains, and two hundred residues in licorice is a hairball.
      rep: 'none', opacity: 1, sideChainsOnly: false, colorBase: true,
    }
    // Fixed ids, so dragging a new box moves the SAME highlights rather than
    // leaving a trail of them behind.
    if (structureLayers.some(l => l.id === id)) updateStructureLayer(id, patch)
    else addStructureLayer({ ...patch, id })
    return true
  }

  const onRegionSelected = (ev: any) => {
    const range = ev?.range
    if (!range || !canSelectRegions || !residues) return
    const xr = range.x, yr = range.y
    if (!Array.isArray(xr) || !Array.isArray(yr)) return

    /*
     * A box means different things on the two kinds of matrix.
     *
     * On a square correlation matrix both axes are residues, so a box names two
     * regions and the useful thing is to colour them differently. On a
     * residue-by-time map only the ROWS are residues — the columns are moments
     * — so a box names one region and one MOMENT, and the useful thing is to
     * colour that region and open the structure at that time.
     */
    if (!twoRegions) {
      const picks = residuesInRange(axisY, residues, yr[0], yr[1])
      if (!picks.length) {
        setRegionNote('That box covers no residues in this map.')
        return
      }
      const centre = (Math.min(xr[0], xr[1]) + Math.max(xr[0], xr[1])) / 2
      showRegion('rmsf-region', `${shown?.ylabel || 'Residues'} ${describeResidues(picks)}`,
                 REGION_STYLE[1].colour, picks)

      // ...and, only when x really is time, pull the structure out at that
      // moment. On a lag axis there is no moment to open.
      const replicaIndex = indices[repIdx] ?? 1
      const conditionId = timeX ? shown?.condition_id : null
      if (conditionId) {
        // This also points the Structure tab at the right condition, so there
        // is no separate setStructureView here — passing an empty id would
        // blank the tab rather than leave it alone.
        setStructureFrame({
          conditionId,
          conditionName: shown?.condition_name || '',
          replicaIndex,
          timeNs: centre,
          label: `rolling RMSF ${describeResidues(picks)}`,
          includeSolvent: false,
        })
        setRegionNote(
          `Highlighted ${picks.length} residues and opened replica `
          + `${replicaIndex} at ${centre.toFixed(2)} ns.`)
      } else {
        setRegionNote(`Highlighted ${picks.length} residues on the structure.`)
      }
      setRequestedTab('structure')
      return
    }

    const picked = REGION_STYLE.map(st => {
      const [lo, hi] = st.axis === 'x' ? xr : yr
      const axisFor = st.axis === 'x' ? axisX : axisY
      return { ...st, picks: residuesInRange(axisFor, residues, lo, hi) }
    })

    if (picked.every(p => p.picks.length === 0)) {
      setRegionNote('That box covers no residues in this matrix.')
      return
    }

    let any = false
    const described: string[] = []
    for (const p of picked) {
      if (!p.picks.length) continue
      const label = `DCCM ${p.role} ${describeResidues(p.picks)}`
      if (showRegion(p.id, label, p.colour, p.picks)) {
        any = true
        described.push(`${p.picks.length} ${p.role}`)
      }
    }
    if (!any) return

    // The matrix belongs to one condition; showing it against another's
    // structure would colour residues that were never in this calculation.
    if (shown?.condition_id) {
      setStructureView({ conditionId: shown.condition_id })
    }
    setRegionNote(`Highlighted ${described.join(' and ')} on the structure.`)
    setRequestedTab('structure')
  }

  // ── Overlaying another trace on the same time axis ────────────────────────
  //
  // This is what makes a rolling RMSF answer the question it was asked: a band
  // of flexibility is only interesting next to the thing that happened at the
  // same moment. Drawing mindist over the map on a shared x-axis is the whole
  // point — reading two plots side by side and eyeballing the alignment is
  // exactly what gets this wrong.
  const [overlayKey, setOverlayKey] = useState('')
  const [candidates, setCandidates] = useState<any[]>([])
  const [maxLagNs, setMaxLagNs] = useState(20)
  const [corrBusy, setCorrBusy] = useState(false)
  const [corrNote, setCorrNote] = useState<string | null>(null)

  /**
   * Turn the overlay into a number.
   *
   * Deliberately the SAME pair that is drawn: you line a trace up by eye, then
   * ask what the coefficient actually is, without re-picking anything and
   * without the chance of quantifying a different analysis than the one on
   * screen.
   */
  const runCorrelation = async () => {
    const it = candidates.find(c => c.cache_key === overlayKey)
    if (!it || !sessionId || !cacheKey) return
    setCorrBusy(true); setCorrNote(null)
    try {
      const steps = Math.max(1, Math.round(maxLagNs / (shown?.step_ns || 1)))
      const res = await api.analysis.correlate({
        session_id: sessionId, map_key: cacheKey, series_key: it.cache_key,
        max_lag_windows: steps,
      })
      const a = res?.aggregate || {}
      setCorrNote(
        `r = ${a.r0 === null || a.r0 === undefined ? '—' : a.r0.toFixed(3)} at zero lag`
        + (a.best_lag_ns !== null && a.best_lag_ns !== undefined
            ? `, strongest ${a.best_r?.toFixed(3)} at ${a.best_lag_ns > 0 ? '+' : ''}`
              + `${a.best_lag_ns.toFixed(1)} ns` : '')
        + ' — added to Results.')
      onAnalysisCreated?.()
    } catch (e: any) {
      const m = String(e?.message || 'Could not correlate these two.')
      setCorrNote(/^(not found|method not allowed)$/i.test(m.trim())
        ? 'This backend does not have the correlation endpoint yet — quit and '
          + 'relaunch the app so it picks up the current code.'
        : m)
    } finally {
      setCorrBusy(false)
    }
  }

  useEffect(() => {
    if (!timeX || !sessionId || !shown?.condition_id) return
    let cancelled = false
    api.analysis.storedResults(sessionId)
      .then(({ results }) => {
        if (cancelled) return
        setCandidates((results || []).filter((it: any) =>
          it.condition_id === shown.condition_id
          && it.result?.kind === 'line'
          // Only traces whose x really is time can share this axis. An RMSF
          // (x = residue) plotted here would look like a line over the first
          // few nanoseconds and mean nothing.
          && /time/i.test(it.result?.xlabel || '')))
      })
      .catch(() => { /* the overlay is optional; the map still works */ })
    return () => { cancelled = true }
  }, [timeX, sessionId, shown?.condition_id])

  const overlay = useMemo(() => {
    const it = candidates.find(c => c.cache_key === overlayKey)
    if (!it?.result) return null
    const res = it.result
    const wantRep = indices[repIdx] ?? 1
    const rep = (res.replicas || []).find((p: any) => p.index === wantRep)
    // Fall back to the mean, but SAY so — silently drawing the average of five
    // replicas against one replica's flexibility map is a different claim.
    const rawX = rep?.x || res.x
    const rawY = rep ? rep.y : (res.y_mean || res.y)
    if (!Array.isArray(rawX) || !Array.isArray(rawY) || !rawX.length) return null
    const thin = decimateMinMax(rawX, rawY)
    return {
      name: it.name || it.type,
      ylabel: res.ylabel || '',
      isMean: !rep,
      wantRep,
      reduced: thin.reduced,
      original: thin.original,
      trace: {
        x: thin.x, y: thin.y,
        /*
         * `scatter`, deliberately NOT `scattergl`.
         *
         * Measured in Plotly 2.35: a scattergl trace on the same subplot stops
         * plotly_selected firing altogether, which would silently disable the
         * drag-a-region interaction this map exists for. SVG it is — hence the
         * min/max decimation above, which keeps the spikes.
         */
        type: 'scatter', mode: 'lines', yaxis: 'y2',
        // Magenta because it has to stay legible across the whole of Viridis,
        // which runs dark blue to bright yellow.
        line: { color: '#ff3ea5', width: 1.6 },
        name: `${it.name || it.type}${rep ? ` rep ${wantRep}` : ' (mean)'}`,
        hovertemplate: '%{x:.2f} ns · %{y:.3f}<extra></extra>',
      },
    }
  }, [candidates, overlayKey, repIdx, indices])

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: r.colour, display: 'inline-block' }} />
        {r.condition_name}
        {hasReps && <span style={{ fontSize: 11, color: 'var(--accent-bright)', fontFamily: 'var(--font-mono)' }}>{repLabel}</span>}
        {loading && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>loading…</span>}

        {hasReps && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
            <button onClick={() => setRepIdx(i => Math.max(0, i - 1))} disabled={repIdx === 0}
              title="Previous replica" style={navBtn(repIdx === 0)}>‹</button>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400, minWidth: 38, textAlign: 'center' }}>
              {repIdx + 1}/{indices.length}
            </span>
            <button onClick={() => setRepIdx(i => Math.min(indices.length - 1, i + 1))} disabled={repIdx === indices.length - 1}
              title="Next replica" style={navBtn(repIdx === indices.length - 1)}>›</button>
          </div>
        )}
        <button onClick={() => setShowHist(s => !s)} style={{
          marginLeft: 'auto', padding: '3px 9px', borderRadius: 5, fontSize: 10, fontWeight: 400,
          background: showHist ? 'var(--bg-elevated)' : 'var(--bg-surface)',
          color: showHist ? 'var(--text-primary)' : 'var(--text-muted)',
          border: `1px solid ${showHist ? 'var(--border-light)' : 'var(--border)'}`,
        }}>{r.diverging ? 'Value distribution'
            : timeX ? 'RMSF distribution' : 'RMSD distribution'}</button>

        {canSelectRegions && (
          <button
            onClick={() => setDragMode(m => (m === 'select' ? 'zoom' : 'select'))}
            title={dragMode === 'select'
              ? 'Dragging sends a region to the Structure tab. Click to go back '
                + 'to zooming.'
              : 'Dragging zooms. Click to make a drag send a region to the '
                + 'Structure tab instead.'}
            style={{
              padding: '3px 9px', borderRadius: 5, fontSize: 10, fontWeight: 400,
              background: dragMode === 'select' ? 'var(--accent)' : 'var(--bg-surface)',
              color: dragMode === 'select' ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${dragMode === 'select' ? 'transparent' : 'var(--border)'}`,
            }}
          >{dragMode === 'select' ? 'Drag: select region' : 'Drag: zoom'}</button>
        )}
      </div>

      {/* ── Overlay: the reason a rolling RMSF is on a time axis at all ──── */}
      {timeX && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                      marginBottom: 6, flexWrap: 'wrap', fontSize: 11 }}>
          <span style={{ color: 'var(--text-muted)' }}>Overlay</span>
          <select
            value={overlayKey}
            onChange={e => setOverlayKey(e.target.value)}
            style={{ fontSize: 11, padding: '3px 6px', maxWidth: 260,
                     background: 'var(--bg)', color: 'var(--text)',
                     border: '1px solid var(--border)', borderRadius: 4 }}
          >
            <option value="">— none —</option>
            {candidates.map(c => (
              <option key={c.cache_key} value={c.cache_key}>
                {c.name || c.type}
              </option>
            ))}
          </select>
          {!candidates.length && (
            <span style={{ color: 'var(--text-muted)' }}>
              (no time-series results for this condition yet — run a mindist,
              RMSD or contacts analysis and it will appear here)
            </span>
          )}
          {overlay?.isMean && (
            <span style={{ color: 'var(--orange, #f79f4f)' }}>
              ⚠ that analysis has no replica {overlay.wantRep}, so the line is
              the mean across replicas — not the same run as the map.
            </span>
          )}
          {overlay?.reduced && (
            <span style={{ color: 'var(--text-muted)' }}>
              ({overlay.original.toLocaleString()} points, thinned for drawing —
              peaks and troughs are kept)
            </span>
          )}

          {overlayKey && (
            <>
              <button
                onClick={runCorrelation}
                disabled={corrBusy}
                title={'Correlate this map against the overlaid trace, per '
                     + 'residue and at a range of time lags.'}
                style={{
                  padding: '3px 10px', borderRadius: 4, fontSize: 11,
                  background: corrBusy ? 'var(--bg-surface)' : 'var(--accent)',
                  color: corrBusy ? 'var(--text-muted)' : '#fff',
                  border: '1px solid transparent',
                  cursor: corrBusy ? 'default' : 'pointer',
                }}
              >{corrBusy ? 'Correlating…' : 'Correlate'}</button>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5,
                              color: 'var(--text-muted)' }}>
                up to ±
                <input
                  type="number" min={0} max={1000} step={1} value={maxLagNs}
                  onChange={e => setMaxLagNs(Math.max(0, parseFloat(e.target.value) || 0))}
                  style={{ width: 58, padding: '3px 6px', fontSize: 11,
                           border: '1px solid var(--border)', borderRadius: 4,
                           background: 'var(--bg)', color: 'var(--text)',
                           fontFamily: 'var(--font-mono)' }}
                />
                ns lag
              </label>
            </>
          )}
        </div>
      )}

      {corrNote && (
        <div style={{ fontSize: 11, marginBottom: 6, padding: '6px 9px',
                      borderRadius: 4, background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          {corrNote}
        </div>
      )}

      {/* A window is a span, not an instant. Saying so prevents reading a band
          one window wide as an event one window long. */}
      {timeX && shown?.window_ns && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          Each column is an RMSF over {shown.window_ns}&nbsp;ns centred on that
          time, so anything shorter than {shown.window_ns}&nbsp;ns is spread
          across every window containing it — a brief event shows up as a band
          about {shown.window_ns}&nbsp;ns wide, not as a spike.
        </div>
      )}

      {canSelectRegions && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6,
                      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>
            {dragMode !== 'select'
              ? <>Drag to zoom{dragMode === 'pan' ? ' · panning' : ''} · double-click
                  to reset · switch to <em>Drag: select region</em> to send part of
                  this map to the structure.</>
              : timeX
              ? <>Drag a box to highlight those residues{' '}
                  <span style={{ color: REGION_STYLE[1].colour }}>■</span> on the
                  structure and open a snapshot at that moment.</>
              : <>Drag a box across the matrix to colour both of its regions on
                  the structure — columns in{' '}
                  <span style={{ color: REGION_STYLE[0].colour }}>■</span>, rows
                  in <span style={{ color: REGION_STYLE[1].colour }}>■</span>.</>}
          </span>
          {regionNote && (
            <span style={{ color: 'var(--text-secondary)' }}>· {regionNote}</span>
          )}
        </div>
      )}

      {/* Say why the feature is missing rather than just not showing it — the
          alternative is looking for a control that was never there. */}
      {r.diverging && !residues && nRows > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          This matrix did not report which residue each row is, so dragging a
          region onto the structure isn’t available for it. Re-running the DCCM
          with GROMACS, MDAnalysis or MDTraj gives rows that can be mapped.
        </div>
      )}

      {/* Replica strip — click any replica directly */}
      {hasReps && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
          {indices.map((ri, i) => (
            <button key={i} onClick={() => setRepIdx(i)} style={{
              padding: '2px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-mono)',
              background: i === repIdx ? r.colour : 'var(--bg-surface)',
              color: i === repIdx ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${i === repIdx ? 'transparent' : 'var(--border)'}`,
            }}>{ri}</button>
          ))}
        </div>
      )}

      {nRows > 0 && (
        <AxisRangeControls x={extents.x} y={extents.y}
                           value={view} onChange={setView} />
      )}

      {/* Per-residue normalisation. Only meaningful on a residue-by-time map. */}
      {timeX && nRows > 0 && (
        <div style={{ marginBottom: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8,
                          fontSize: 11, color: 'var(--text-secondary)',
                          flexWrap: 'wrap' }}>
            <span>Scale each residue against</span>
            <select value={normBase} onChange={e => setNormBase(e.target.value)}
                    style={{ fontSize: 11, padding: '3px 6px',
                             border: '1px solid var(--border)', borderRadius: 4,
                             background: 'var(--bg)', color: 'var(--text)' }}>
              <option value="none">nothing — absolute values</option>
              {baselines && (
                <option value="shared">
                  its median across all {baselines.n_conditions} conditions
                </option>
              )}
              {baselines?.per_condition.map(c => (
                <option key={c.condition_id} value={c.condition_id}>
                  its median in {c.condition_name || 'this condition'}
                </option>
              ))}
              <option value="own">its median in this map only</option>
            </select>

            {normBase !== 'none' && (
              <>
                <span>shown as</span>
                <select value={normScale}
                        onChange={e => setNormScale(e.target.value as NormMode)}
                        style={{ fontSize: 11, padding: '3px 6px',
                                 border: '1px solid var(--border)', borderRadius: 4,
                                 background: 'var(--bg)', color: 'var(--text)' }}>
                  <option value="ratio">fold (1 = normal)</option>
                  <option value="log2">log₂ fold (0 = normal)</option>
                  <option value="robustz">robust z</option>
                </select>
                <span style={{ color: 'var(--text-muted)' }}>
                  midpoint {normalised.neutral} = normal for that residue
                </span>
              </>
            )}
          </label>

          {/*
            * The caveat is specific to the baseline chosen, because the two
            * are not equally safe. A shared baseline keeps the comparison
            * between conditions; a per-map one destroys it, and saying so only
            * in general terms would leave the destructive option looking like
            * a harmless styling choice.
            */}
          {normBase === 'own' && (
            <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.55,
                          padding: '7px 10px', borderRadius: 5,
                          background: 'rgba(247,159,79,0.10)',
                          border: '1px solid var(--border)' }}>
              <strong style={{ color: 'var(--amber)' }}>
                This baseline cannot compare conditions.
              </strong>{' '}
              Each row is divided by its own median <em>within this matrix</em>,
              so a residue uniformly twice as mobile in one condition lands on
              the midpoint in both and the difference vanishes. Use it to ask
              <em> when a residue was unusual for itself</em>; for anything
              comparative, scale against all conditions instead.
              {normalised.note && <> {normalised.note}</>}
            </div>
          )}

          {(normBase === 'shared' || (normBase !== 'none' && normBase !== 'own')) && (
            <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.55,
                          color: 'var(--text-muted)' }}>
              {normBase === 'shared'
                ? <>Every map here is divided by the same per-residue baseline,
                    pooled over all replicas of each condition and balanced
                    between conditions — so a residue that really is more mobile
                    in one arm still reads above the midpoint.</>
                : <>Every map here is divided by this condition&rsquo;s own
                    per-residue medians, so it reads as fold-change against that
                    reference and the reference itself sits at the midpoint.</>}
              {normalised.note && <> {normalised.note}</>}
            </div>
          )}
        </div>
      )}

      <Plot
        data={[{
          z, x: axisX, y: axisY, type: 'heatmap',
          /*
           * A correlation matrix needs a DIVERGING scale anchored at zero.
           * On a sequential scale like Viridis, -1 and +1 read as "low" and
           * "high" — so "moves oppositely" and "moves together" look like two
           * ends of one quantity, and half the plot is interpreted backwards.
           * Red for positive, blue for negative, white at zero is the
           * convention every DCCM figure in the literature uses.
           */
          /*
           * A NORMALISED map is diverging by construction: the question is
           * "above or below this residue's usual", so the midpoint carries the
           * meaning and a sequential scale would read it as "low to high"
           * flexibility — exactly the reading this view exists to remove.
           */
          ...(normMode !== 'none'
            ? { colorscale: 'RdBu', reversescale: true, zmid: normalised.neutral }
            : r.diverging
            ? { colorscale: 'RdBu', reversescale: true, zmid: 0 }
            : { colorscale: r.categorical ? 'Portland' : 'Viridis' }),
          /*
           * An EXPLICIT range, shared with every other map in this block.
           *
           * Without zmin/zmax Plotly stretches the colourmap between the
           * extremes of whichever matrix it is drawing — so each replica and
           * each condition got its own scale, and two maps that looked the
           * same colour could hold quite different numbers. Setting it also
           * makes clipping possible, which is what stops a few very mobile
           * residues compressing everything else into one shade.
           *
           * null means the user chose per-map scaling, which is Plotly's own
           * behaviour, so nothing is set.
           */
          /*
           * The shared range is in nanometres and means nothing once the rows
           * have been divided by their own medians, so a normalised map takes
           * its own symmetric range about the neutral value instead. Still
           * shared in spirit: every map here computes it the same way from a
           * percentile, so two conditions remain comparable AS normalised maps.
           */
          ...(normMode !== 'none'
            ? (normalised.limit
                ? { zmin: normalised.neutral - normalised.limit,
                    zmax: normalised.neutral + normalised.limit }
                : {})
            : range ? { zmin: range.zmin, zmax: range.zmax } : {}),
          colorbar: { title: { text: normMode !== 'none' ? normalised.zlabel
                                     : (shown?.zlabel || r.zlabel || ''),
                               side: 'right' },
                      thickness: 12, len: 0.9,
                      // Leave room for the overlay's own axis on the right.
                      x: overlay ? 1.12 : 1.02 },
      }, ...(overlay ? [overlay.trace] : [])]}
        config={PLOT_CONFIG} useResizeHandler style={{ width: '100%' }}
        onSelected={canSelectRegions ? onRegionSelected : undefined}
        /*
         * The modebar changes dragmode behind React's back. Without mirroring
         * it into state, the next re-render — a colour-scale change, a replica
         * switch — would push the old mode back and undo the user's click on
         * Pan or Zoom.
         */
        onRelayout={(e: any) => {
          if (!e) return
          if (typeof e.dragmode === 'string') setDragMode(e.dragmode)
          // Zoom, pan and double-click-to-reset all arrive here. Mirroring them
          // keeps the typed boxes showing what is actually on screen, and stops
          // the next re-render from undoing the drag.
          const axis = (k: 'xaxis' | 'yaxis'): [number, number] | null | undefined => {
            if (e[`${k}.autorange`] === true) return null
            const a = e[`${k}.range[0]`], b = e[`${k}.range[1]`]
            if (typeof a === 'number' && typeof b === 'number') return [a, b]
            if (Array.isArray(e[`${k}.range`]) && e[`${k}.range`].length === 2) {
              return [Number(e[`${k}.range`][0]), Number(e[`${k}.range`][1])]
            }
            return undefined          // this event said nothing about the axis
          }
          const nx = axis('xaxis'), ny = axis('yaxis')
          if (nx !== undefined || ny !== undefined) {
            setView(v => ({ x: nx === undefined ? v.x : nx,
                            y: ny === undefined ? v.y : ny }))
          }
        }}
        layout={{
          autosize: true, uirevision: 'keep', height: 420, margin: { l: 60, r: 20, t: 30, b: 50 }, ...getPlotBg(),
          title: { text: `${shown?.title || r.title || ''}${repLabel ? ` — ${repLabel}` : ''}`, font: { color: plotTheme().title, size: 13 } },
          xaxis: { title: { text: shown?.xlabel || r.xlabel || '' }, ...getAxis(),
                   ...(view.x ? { range: view.x } : { autorange: true }) },
          yaxis: { title: { text: shown?.ylabel || r.ylabel || '' }, ...getAxis(),
                   ...(view.y ? { range: view.y } : { autorange: true }) },
          // The overlay gets its own scale on the right: RMSF in nm and a
          // minimum distance in nm are both "nm" but not the same quantity, and
          // forcing them onto one axis would flatten whichever has the smaller
          // range into a straight line.
          ...(overlay ? {
            yaxis2: {
              title: { text: overlay.ylabel, font: { color: '#ff3ea5' } },
              tickfont: { color: '#ff3ea5' },
              overlaying: 'y', side: 'right', showgrid: false,
            },
            showlegend: true,
            legend: { x: 0, y: 1.12, orientation: 'h' as const,
                      bgcolor: 'rgba(0,0,0,0)' },
          } : {}),
          /*
           * In 'select', a heatmap trace has no selectPoints of its own so
           * Plotly reports no points — but it still reports the RANGE the box
           * covered, which is the whole of what a region means here.
           */
          dragmode: canSelectRegions ? dragMode : 'zoom',
        }} />

      {showHist && hist && hist.length > 0 && (
        <Plot
          data={[{ x: hist, type: 'histogram', nbinsx: 60, marker: { color: r.colour, opacity: 0.75 } }]}
          config={PLOT_CONFIG} useResizeHandler style={{ width: '100%' }}
          layout={{
            autosize: true, uirevision: 'keep', height: 200, margin: { l: 60, r: 20, t: 24, b: 42 }, ...getPlotBg(),
            title: { text: `${r.diverging ? 'Correlation' : timeX ? 'RMSF' : 'Pairwise RMSD'} distribution — ${repLabel || r.condition_name}`, font: { color: plotTheme().title, size: 11 } },
            xaxis: { title: { text: shown?.zlabel || r.zlabel || (r.diverging ? 'Correlation' : 'RMSD (nm)') }, ...getAxis() },
            yaxis: { title: { text: 'count' }, ...getAxis() },
          }} />
      )}
    </div>
  )
}


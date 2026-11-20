import React, { useState, useMemo, useEffect, useCallback } from 'react'
import Plot from './plots/Plot'
import { GitCompare, Eye, EyeOff, Ban, RotateCcw, TrendingUp, BarChart3, Activity, Radar, Layers } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../api/client'
import { plotTheme } from '../plotTheme'
import PlotStyleControls, { PlotStyle, defaultPlotStyle, styledLayout, styledConfig,
         errorBarStyle, axisDecor } from './PlotStyleControls'
import { resolveSeriesStyle, seriesMarker, seriesMarkerArray, seriesBar,
         seriesBarArray, seriesId, replicaLineColour, repeatColourKey,
         toHexColour } from '../lib/plotSeries'
import type { PlotSeries } from '../lib/plotSeries'
import { frameMask, gate, gatedMean, passIntervals, evaluateReplica,
         alignFrames, describeFilter } from '../lib/plotFilter'
import { useSeriesModel } from './plots/useSeriesModel'
import type { ConditionRef } from './plots/useSeriesModel'
import SeriesPanel from './plots/SeriesPanel'
import {
  pearson, crossCorr, recomputeMean, lighten, repKey, REPEAT_PALETTE,
  linearFit, compareGroups, comparePaired, isPairedTest,
} from '../lib/stats'
import type { TestKind } from '../lib/stats'
import { StatsPanel, CorrelationStats, XCorrRepeatStats } from './plots/StatsPanel'
import { RepeatDetailPanel } from './plots/RepeatDetailPanel'
import { RepeatAxisPanel } from './plots/RepeatAxisPanel'
import type { AxisRow } from './plots/RepeatAxisPanel'
import { MetricSelect } from './plots/MetricSelect'
import { DEFAULT_AXIS_LOCK, extentOf, mergeExtents, resolveAxisRange }
  from '../lib/axisLock'
import type { AxisLock, Extent } from '../lib/axisLock'
import type { AnalysisResult, StoredResult } from '../types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const stepBtn: React.CSSProperties = {
  width: 22, height: 24, borderRadius: 4, fontSize: 10, lineHeight: 1, padding: 0,
  background: 'var(--bg-surface)', color: 'var(--text-secondary)',
  border: '1px solid var(--border)',
}

/** The parenthesised unit out of an axis label like 'RMSD (nm)'. */
function unitOfLabel(label?: string): string {
  const m = /\(([^)]+)\)\s*$/.exec(label || '')
  return m ? m[1] : ''
}


// Normalised cross-correlation (ported from the HTML tool)


// Lighten a hex colour toward white by fraction f (0..1)

type Mode = 'overlay' | 'together' | 'correlation' | 'crosscorr' | 'bars' | 'filtered'
type ColorMode = 'condition' | 'repeat' | 'time'
type LineMode = 'both' | 'meansd' | 'individual'

/**
 * Load line analyses from the PERSISTENT registry (not the jobs list), honouring
 * each analysis's hidden flag. Clearing the Jobs panel no longer loses plots.
 */
function useLineResults(sessionId: string): Record<string, AnalysisResult[]> {
  const { jobs } = useStore()
  const [items, setItems] = useState<StoredResult[]>([])

  const refresh = React.useCallback(() => {
    if (!sessionId) return
    api.analysis.storedResults(sessionId).then(r => setItems(r.results)).catch(() => {})
  }, [sessionId])

  useEffect(() => { refresh() }, [refresh])
  const nDone = jobs.filter(j => j.status === 'completed').length
  // A completed job means there may be a new result to show. `refresh` is a
  // useCallback over sessionId, so listing it costs nothing and keeps the
  // dependency honest.
  useEffect(() => { refresh() }, [nDone, refresh])

  return useMemo(() => {
    const byKey: Record<string, AnalysisResult[]> = {}
    for (const it of items) {
      if (it.hidden) continue
      const r = it.result
      if (!r || r.kind !== 'line' || !r.replicas) continue
      const key = it.name ? `${it.type} · ${it.name}` : it.type
      if (!byKey[key]) byKey[key] = []
      const i = byKey[key].findIndex(x => x.condition_id === r.condition_id)
      if (i >= 0) byKey[key][i] = r; else byKey[key].push(r)
    }
    return byKey
  }, [items])
}


export default function CompareTab() {
  const { activeSession, theme, setStructureFrame, setRequestedTab,
          favouriteMetrics, toggleFavouriteMetric,
          repeatAxisLocks, setRepeatAxisLock,
          repeatXLock, setRepeatXLock,
          repeatColours, setRepeatColour, clearRepeatColours } = useStore()
  const sessionId = activeSession?.id || ''
  const byKey = useLineResults(sessionId)
  const keys = Object.keys(byKey)

  /**
   * A metric key plus its unit, for menus and trace names.
   *
   * A `function` declaration, not a `const` arrow, and deliberately so: it is
   * called from useMemo bodies that run during render, and those sit ABOVE this
   * point in the file. A const would be in its temporal dead zone there and
   * throw "cannot access before initialization" — which is exactly what
   * happened when the Repeat detail mode started calling it. Function
   * declarations hoist, so the order of this file can no longer break it.
   */
  function metricLabel(k: string) {
    const r = (byKey[k] || [])[0]
    return r ? `${k} — ${r.ylabel}` : k
  }

  const [mode, setMode] = useState<Mode>('overlay')
  const [metricA, setMetricA] = useState('')
  const [metricB, setMetricB] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [highlight, setHighlight] = useState<string | null>(null)

  // Display options (ported from HTML tool)
  const [lineMode, setLineMode] = useState<LineMode>('both')
  /** Draw a line of best fit on the correlation scatter. */
  const [showFit, setShowFit] = useState(true)
  /** What one dot on the correlation plot IS — see the comment on `corr`. */
  const [corrPoints, setCorrPoints] = useState<'mean' | 'pooled' | 'perrep'>('mean')
  /**
   * Cross-correlation basis. PER REPEAT by default — averaging runs before
   * cross-correlating them destroys event coupling; see the note on `xcorr`.
   */
  const [xcorrBasis, setXcorrBasis] = useState<'perrep' | 'mean'>('perrep')

  // ── Repeat detail: several analyses, one run ──────────────────────────────
  const [togetherCond, setTogetherCond] = useState('')
  const [togetherRep, setTogetherRep] = useState<number | null>(null)
  const [togetherMetrics, setTogetherMetrics] = useState<string[]>([])
  const [togetherLayout, setTogetherLayout] = useState<'stacked' | 'overlay'>('stacked')
  const [togetherNorm, setTogetherNorm] = useState<'zscore' | 'minmax'>('zscore')
  /** Time marker, in ns. Drawn across every panel. */
  const [cursorNs, setCursorNs] = useState<number | null>(null)
  /** Show the statistics panel under the plot, where it applies. */
  const [showStats, setShowStats] = useState(true)
  const [statTest, setStatTest] = useState<TestKind>('welch')
  const [colorMode, setColorMode] = useState<ColorMode>('condition')
  const [maxLag, setMaxLag] = useState(500)
  const [barStyle, setBarStyle] = useState<'per_condition' | 'per_replica'>('per_condition')
  const [barMetrics, setBarMetrics] = useState<string[]>([])
  // Filtered analysis: filter frames by a condition on filterMetric, then
  // report the pass-fraction, or the conditional mean of a target metric.
  const [filterMetric, setFilterMetric] = useState('')
  const [filterOp, setFilterOp] = useState<'>' | '<' | '>=' | '<='>('>')
  const [filterThreshold, setFilterThreshold] = useState('1')
  const [filterOutput, setFilterOutput] = useState<'fraction' | 'conditional_mean'>('fraction')
  const [targetMetric, setTargetMetric] = useState('')
  const [filterBarStyle, setFilterBarStyle] = useState<'per_condition' | 'per_replica'>('per_condition')
  const [customOpen, setCustomOpen] = useState(false)
  // All figure styling lives in ONE object rather than a dozen useStates —
  // see PlotStyleControls. This is what kept this component's hook count
  // climbing, and hook-count is what broke v33.
  const [style, setStyle] = useState<PlotStyle>(defaultPlotStyle)

  /**
   * Every condition in the project, in the order it is first seen.
   *
   * Collected across ALL metrics rather than the one on screen: a filter may
   * name a metric the current mode is not showing, and its series still have
   * to exist.
   */
  const conditions = useMemo<ConditionRef[]>(() => {
    const m = new Map<string, ConditionRef>()
    for (const k of Object.keys(byKey)) {
      for (const r of byKey[k] || []) {
        if (r.condition_id && !m.has(r.condition_id)) {
          m.set(r.condition_id, { id: r.condition_id,
                                  name: r.condition_name || r.condition_id,
                                  colour: r.colour || '#4f8ef7' })
        }
      }
    }
    return [...m.values()]
    // `keys` is Object.keys(byKey), so byKey alone determines this.
  }, [byKey])

  // Filters, series, grouping and per-series styles — ONE hook. See the file.
  const model = useSeriesModel(conditions)

  /*
   * A series per CONDITION even when no filter is on the graph.
   *
   * The plain Averages chart has no filters, but "give WT's dots a different
   * colour from the mutant's" is exactly what was asked for and must work
   * there too. So the conditions stand in as series under a reserved filter
   * id, which keys their overrides in the same store as the real ones and
   * persists with the project in the same way.
   */
  const BASE = '__base'
  const styleSeries = useMemo<PlotSeries[]>(() => {
    if (model.series.length) return model.series
    return conditions.map((c, i) => ({
      id: seriesId(BASE, c.id), filterId: BASE, conditionId: c.id,
      label: c.name, visible: true, order: i,
      style: model.seriesStyles[seriesId(BASE, c.id)] || {},
    }))
  }, [model.series, conditions, model.seriesStyles])

  /**
   * The stand-in series for one condition, so a trace can resolve its style.
   *
   * useCallback, not a bare arrow, so the trace memos below can DECLARE it as
   * a dependency and have that checked. Its identity tracks styleSeries, which
   * those memos already depend on, so nothing recomputes more often than
   * before — the dependency is now enforced rather than assumed.
   */
  const baseSeries = useCallback(
    (cid: string) =>
      styleSeries.find(s => s.conditionId === cid && s.filterId === BASE) || null,
    [styleSeries])

  /*
   * Pick sensible default metrics once results arrive.
   *
   * Depends on `byKey` rather than a joined `keys` string: `keys` IS
   * Object.keys(byKey), so byKey determines it completely, and byKey is
   * memoised in useLineResults. The old `[keys.join(',')]` was a stringified
   * dependency that worked but hid what the effect actually read — and the
   * four metric values it guards on were missing from it entirely.
   */
  useEffect(() => {
    const ks = Object.keys(byKey)
    if (!metricA && ks[0]) setMetricA(ks[0])
    if (!metricB && ks[0]) setMetricB(ks[1] || ks[0])
    if (!filterMetric && ks[0]) setFilterMetric(ks[0])
    if (!targetMetric && ks[0]) setTargetMetric(ks[1] || ks[0])
  }, [byKey, metricA, metricB, filterMetric, targetMetric])

  // NOTE: no early return here. Stored results load ASYNCHRONOUSLY, so `keys`
  // is empty on the first render and populated later. Returning early would run
  // fewer hooks on that first pass and more afterwards, which violates React's
  // rules-of-hooks and crashes the tab. The empty state is rendered at the END,
  // after every hook has been called unconditionally.

  // useCallback for the same reason as baseSeries: every trace memo reads
  // these, and each one's identity tracks exactly the Set it closes over —
  // which those memos already list. Behaviour is unchanged; the dependency is
  // now checked.
  const isExcluded = useCallback(
    (t:string,cid:string,ri:number)=>excluded.has(repKey(t,cid,ri)), [excluded])
  const isHidden = useCallback(
    (t:string,cid:string,ri:number)=>hidden.has(repKey(t,cid,ri)), [hidden])
  const toggle = (set:Set<string>, setter:(s:Set<string>)=>void, k:string) => {
    const n = new Set(set)
    if (n.has(k)) n.delete(k); else n.add(k)
    setter(n)
  }
  /*
   * The same flip for every replica of one condition at once.
   *
   * Ten runs per condition means ten clicks to look at three of them, and that
   * cost falls on exactly the comparison this panel exists to support — so the
   * expensive path was the one you actually want. Going to an EXTREME rather
   * than flipping each key is what makes it cheap: clear the condition once,
   * then add back the three you want.
   *
   * It takes an explicit `on` instead of inverting per key, because a mixed
   * selection has no sensible inverse: flipping seven shown and three hidden
   * would leave seven hidden and three shown, which is not a state anyone
   * asked for.
   */
  const setMany = (set:Set<string>, setter:(s:Set<string>)=>void,
                   keys:string[], on:boolean) => {
    const n = new Set(set)
    for (const k of keys) { if (on) n.add(k); else n.delete(k) }
    setter(n)
  }

  const activeMetrics = (mode==='correlation'||mode==='crosscorr') ? [metricA, metricB] : [metricA]
  const uniqMetrics = Array.from(new Set(activeMetrics.filter(Boolean)))

  /*
   * Colour for one replica's line.
   *
   * The rule itself moved to lib/plotSeries so it is testable and so the
   * per-replica override cannot be forgotten at one of the call sites — the
   * mistake this file's own header warns about twice. All this adds is the
   * lookup of that override.
   */
  const repColour = useCallback(
    (condColour: string, cid: string, repIndex: number, repIdx: number,
     total: number, tFrac: number) =>
      replicaLineColour({
        override: repeatColours[repeatColourKey(cid, repIndex)],
        conditionColour: condColour, mode: colorMode,
        repIndex, repOrder: repIdx, total, tFrac,
      }),
    [colorMode, repeatColours])

  // ─── Overlay traces ─────────────────────────────────────────────────────────
  /*
   * GATING A TIME SERIES BY A SAVED FILTER.
   *
   * "Show only the frames where the cavity is open" is a different and more
   * useful question than "what fraction of frames is it open for", and it is
   * the same filter asking it. The mask is per REPLICA — the runs do not open
   * and close in step — so everything here is computed run by run.
   *
   * Three things this gets right that a naive version would not:
   *
   *   - Failing frames become GAPS, not deleted points. Dropping them would
   *     connect the line across the gap and compress the time axis, so a 50 ns
   *     stretch where the filter failed would render as two adjacent frames.
   *   - The mean band is recomputed over only the passing runs AT EACH FRAME,
   *     so its n varies along x. That is reported, because a stretch resting
   *     on two runs and one resting on ten look identical otherwise.
   *   - The gating metric must share frame sampling with the plotted one, or
   *     the mask indexes the wrong moments. A mismatch leaves the condition
   *     ungated and says why, rather than drawing a confident wrong picture.
   */
  const overlay = useMemo(() => {
    const traces: any[] = []
    const shapes: any[] = []
    const problems: string[] = []
    const gateF = model.filters.find(f => f.id === model.gateFilterId) || null
    const shadeMode = (gateF?.gateMode || 'shade') === 'shade'
    let coverage: { min: number; max: number; of: number } | null = null

    for (const r of byKey[metricA] || []) {
      const cid = r.condition_id!
      /*
       * THE OVERLAY NOW RESOLVES ITS STYLE LIKE EVERY OTHER MODE.
       *
       * These traces were the one family that never called
       * resolveSeriesStyle: line colour came straight from the stored
       * condition colour and line width from the global PlotStyle, so the
       * "Series colour", per-series line width and dash controls did nothing
       * here while visibly working on bars and dots. That is exactly the
       * two-sites-one-property split plotSeries.ts exists to prevent, and it
       * had simply been missed on this path.
       */
      const rs = resolveSeriesStyle(baseSeries(cid), style, r.colour,
                                    (byKey[metricA] || []).indexOf(r))
      const condColour = rs.colour
      const dash = rs.lineDash === 'solid' ? undefined : rs.lineDash
      const allReps = r.replicas || []
      const kept = allReps.filter(rep => !isExcluded(metricA, cid, rep.index))
      const xRef = (kept[0] as any)?.x || r.x

      // ── masks for this condition, or none ──────────────────────────────
      let masks: Map<number, boolean[]> | null = null
      if (gateF) {
        const gr = (byKey[gateF.metric] || []).find(x => x.condition_id === cid)
        if (!gr) {
          problems.push(`${r.condition_name}: ${gateF.metric} has no result for `
                      + `this condition, so it is drawn ungated.`)
        } else {
          const m = new Map<number, boolean[]>()
          let ok = true
          for (const rep of kept) {
            const grep = (gr.replicas || []).find(p => p.index === rep.index)
            if (!grep) {
              problems.push(`${r.condition_name}: ${gateF.metric} has no rep`
                          + `${rep.index}, so this condition is drawn ungated.`)
              ok = false; break
            }
            const al = alignFrames(
              { index: rep.index, x: (grep as any).x || gr.x, y: grep.y },
              { index: rep.index, x: (rep as any).x || r.x, y: rep.y },
              gateF.metric, metricA)
            if (al.problem) { problems.push(`${r.condition_name}: ${al.problem}`); ok = false; break }
            m.set(rep.index, frameMask(grep.y, gateF))
          }
          if (ok) masks = m
        }
      }

      /*
       * Shading uses a MAJORITY rule, stated here and on screen.
       *
       * Each run passes at different times, so there is no single stretch to
       * shade. Shading every run's own stretches would overlap into a grey
       * wash; shading only where all of them pass would almost never fire.
       * "More than half the runs" is one rule, it is interpretable, and it is
       * said out loud rather than left for a reader to assume it means "all".
       */
      if (masks && shadeMode && kept.length) {
        const n = Math.max(...kept.map(rep => rep.y.length))
        const majority: boolean[] = []
        for (let i = 0; i < n; i++) {
          let c = 0
          for (const rep of kept) if (masks.get(rep.index)?.[i]) c++
          majority.push(c > kept.length / 2)
        }
        for (const [x0, x1] of passIntervals(xRef, majority)) {
          shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1,
                        fillcolor: condColour || '#4f8ef7', opacity: 0.1,
                        line: { width: 0 }, layer: 'below' })
        }
      }

      const gapping = !!masks && !shadeMode
      const { mean, sd } = gapping
        ? (() => {
            const g = gatedMean(kept.map(rep => ({ y: rep.y, mask: masks!.get(rep.index)! })), 2)
            const live = g.n.filter((v, i) => g.mean[i] !== null)
            if (live.length) {
              const lo = Math.min(...live), hi = Math.max(...live)
              coverage = coverage
                ? { min: Math.min(coverage.min, lo), max: Math.max(coverage.max, hi),
                    of: Math.max(coverage.of, kept.length) }
                : { min: lo, max: hi, of: kept.length }
            }
            return { mean: g.mean as any[], sd: g.sd as any[] }
          })()
        : recomputeMean(kept)

      if ((lineMode==='both'||lineMode==='meansd') && mean.length
          && sd.some((v:any)=>Number.isFinite(v) && v>0)) {
        const xs = xRef.slice(0, mean.length)
        if (gapping) {
          // Two traces with `tonexty` rather than one closed polygon: a
          // polygon cannot have holes, and this band does.
          traces.push({ x: xs, y: mean.map((v:any,i:number)=> v===null?null:v-sd[i]),
            type:'scatter', mode:'lines', line:{ color:'transparent' },
            showlegend:false, hoverinfo:'skip' })
          traces.push({ x: xs, y: mean.map((v:any,i:number)=> v===null?null:v+sd[i]),
            type:'scatter', mode:'lines', fill:'tonexty', fillcolor:condColour,
            opacity:0.13, line:{ color:'transparent' },
            showlegend:false, hoverinfo:'skip' })
        } else {
          const upper = mean.map((v:any,i:number)=>v+sd[i]), lower = mean.map((v:any,i:number)=>v-sd[i])
          traces.push({
            x:[...xs, ...xs.slice().reverse()],
            y:[...upper, ...lower.reverse()], fill:'toself', fillcolor:condColour,
            opacity:0.13, line:{color:'transparent'}, type:'scatter', showlegend:false, hoverinfo:'skip',
          })
        }
      }
      if (lineMode==='both'||lineMode==='individual') {
        allReps.forEach((rep, idx) => {
          if (isHidden(metricA,r.condition_id!,rep.index) || isExcluded(metricA,r.condition_id!,rep.index)) return
          const k = repKey(metricA,r.condition_id!,rep.index)
          const isHi = highlight===k
          const mk = masks?.get(rep.index)
          traces.push({
            x: (rep as any).x || r.x,
            // In gap mode a failing frame is null, which Plotly draws as a
            // break. `connectgaps` defaults to false, so this is a hole and
            // not a straight line across the excursion.
            y: (mk && !shadeMode) ? gate(rep.y, mk) : rep.y,
            type:'scattergl', mode:'lines',
            line:{ color: repColour(condColour||'#4f8ef7', cid, rep.index, idx,
                                    allReps.length, idx/Math.max(1,allReps.length-1)),
                   width: isHi?2.5:rs.lineWidth, dash },
            opacity: highlight&&!isHi ? 0.12 : (isHi?1:(lineMode==='individual'?0.7:0.4)),
            name:`rep ${rep.index}`,
            hovertemplate:`${r.condition_name} rep${rep.index}<br>%{x:.2f}, %{y:.3f}`
              + `<br><i>click to open this frame in 3D</i><extra></extra>`,
            /*
             * A KEY FOR THE REPLICA COLOURS.
             *
             * These traces were unconditionally absent from the legend, which
             * was defensible while every run of a condition was a shade of one
             * colour. It stops being defensible the moment the colours carry
             * information — by the repeat palette, or picked by hand — because
             * then the figure encodes which run is which and provides no way
             * to read it.
             *
             * Grouped under the condition, and the group named once, so twenty
             * runs read as two labelled blocks rather than twenty loose
             * entries. Hidden and excluded runs never reach here, so the
             * legend lists exactly what is drawn.
             */
            showlegend: style.legendReplicas,
            legendgroup: cid,
            legendgrouptitle: { text: r.condition_name || cid },
            // Plotly hands the whole trace back on a click, so `meta` is how a
            // point says which replica of which condition it belongs to.
            // The metric KEY, not its label — the label is resolved in the
            // click handler. (metricLabel is now hoisted so calling it here
            // would work, but storing the key keeps `meta` to plain data.)
            meta: { conditionId: r.condition_id, conditionName: r.condition_name,
                    replicaIndex: rep.index, metricKey: metricA },
          })
        })
      }
      if (lineMode==='both'||lineMode==='meansd') {
        traces.push({
          x:xRef.slice(0,mean.length), y:mean, type:'scatter', mode:'lines',
          line:{ color: style.meanColor || condColour,
                 width: highlight?1.2:Math.max(2,rs.lineWidth+0.7), dash },
          opacity: highlight?0.5:1,
          name: gapping ? `${r.condition_name} (gated, n varies)`
                        : `${r.condition_name} (n=${kept.length})`,
          legendgroup: cid,
          legendgrouptitle: style.legendReplicas
            ? { text: r.condition_name || cid } : undefined,
          hovertemplate:`${r.condition_name} mean<br>%{x:.2f}, %{y:.3f}<extra></extra>`,
        })
      }
    }
    return { traces, shapes, gate: gateF,
             problems: [...new Set(problems)], coverage, shadeMode }
    // isExcluded/isHidden/repColour stand in for excluded/hidden/colorMode:
    // each is a useCallback over exactly that state, so listing the callback
    // is both necessary and sufficient.
  }, [metricA, byKey, isExcluded, isHidden, repColour, highlight, lineMode,
      style, baseSeries, model.gateFilterId, model.filters])

  // ─── Correlation scatter ────────────────────────────────────────────────────
  /*
   * WHAT ONE DOT IS.
   *
   * This was the source of a real confusion, so it is spelled out. In 'mean'
   * mode each dot is ONE TIME POINT of the across-replica average: the ten
   * repeats are collapsed to a single mean curve per metric first, and that
   * curve is plotted against the other. So excluding a repeat moves every dot
   * (the mean changes) without changing how many there are — which is exactly
   * the symptom of averaging, and is not a bug, but it is also not obvious.
   *
   * Averaging first is a real analytical choice, not a display detail. It is a
   * low-pass filter across repeats: it can produce a clean correlation that no
   * individual run shows, and it can wash out a genuine one if the runs are
   * offset in time. So the other two modes exist, and the dot count is now
   * stated on screen.
   */
  const corr = useMemo(() => {
    const empty = { traces:[] as any[], r:null as number|null, overall:null as any,
                    overallSpearman:null as any, fits:[] as any[], nPoints:0,
                    perRep:[] as {name:string;r:number}[], droppedReps:[] as string[] }
    if (mode!=='correlation') return empty
    const traces:any[] = []; const allX:number[]=[], allY:number[]=[]
    const fits:{name:string;fit:any;colour:string}[] = []
    const perRep:{name:string;r:number}[] = []
    const droppedReps:string[] = []

    const fitLine = (xs:number[], ys:number[], colour:string, name:string, dim=false) => {
      const f = linearFit(xs, ys)
      if (!f || !Number.isFinite(f.slope)) return null
      const x0 = Math.min(...xs), x1 = Math.max(...xs)
      traces.push({
        x:[x0,x1], y:[f.intercept+f.slope*x0, f.intercept+f.slope*x1],
        type:'scatter', mode:'lines',
        line:{ color:colour, width: dim ? style.lineWidth : style.lineWidth+0.6,
               dash: style.lineDash==='solid' ? undefined : style.lineDash },
        opacity: dim ? 0.55 : 1,
        name:`${name} fit`, showlegend:false,
        hovertemplate:`${name}: y = ${f.slope.toFixed(4)}x `
          + `${f.intercept>=0?'+':'−'} ${Math.abs(f.intercept).toFixed(4)}`
          + `<br>r = ${f.r.toFixed(3)}, R² = ${f.r2.toFixed(3)}<extra></extra>`,
      })
      return f
    }

    for (const a of byKey[metricA]||[]) {
      const b = (byKey[metricB]||[]).find(x=>x.condition_id===a.condition_id)
      if (!b) continue
      const cid = a.condition_id!
      const cname = a.condition_name || cid
      const colour = a.colour || '#4f8ef7'
      // Through the resolver like every other trace, so a per-series colour,
      // shape or dot colour applies here too. This site used markerStyle(),
      // which reads only the figure-wide style — so styling a condition's
      // dots worked on the bar chart and silently did nothing here.
      const rs = resolveSeriesStyle(baseSeries(cid), style, colour,
                                    traces.length)

      /*
       * A repeat excluded under EITHER metric is excluded from both.
       *
       * Exclusions are stored per metric, so it was possible to build x from
       * ten repeats and y from nine and pair them up anyway — silently
       * correlating one set of runs against a different set. Pairing only makes
       * sense for a repeat that survives on both axes.
       */
      const aReps = new Map((a.replicas||[]).map(r=>[r.index, r]))
      const bReps = new Map((b.replicas||[]).map(r=>[r.index, r]))
      const paired: {index:number; ay:number[]; by:number[]}[] = []
      for (const [idx, ar] of aReps) {
        const br = bReps.get(idx)
        if (!br) { droppedReps.push(`${cname} rep${idx} (missing from ${metricB})`); continue }
        if (isExcluded(metricA,cid,idx) || isExcluded(metricB,cid,idx)) continue
        paired.push({ index: idx, ay: ar.y, by: br.y })
      }
      if (!paired.length) continue

      if (corrPoints === 'mean') {
        const ma = recomputeMean(paired.map(p=>({y:p.ay}))).mean
        const mb = recomputeMean(paired.map(p=>({y:p.by}))).mean
        const n = Math.min(ma.length, mb.length)
        const xs = ma.slice(0,n), ys = mb.slice(0,n)
        allX.push(...xs); allY.push(...ys)
        traces.push({ x:xs, y:ys, type:'scattergl', mode:'markers',
          marker: seriesMarker(rs, -2, '', 2),
          name:`${cname} (mean of ${paired.length})`,
          hovertemplate:`${cname} mean<br>%{x:.3f}, %{y:.3f}<extra></extra>` })
        if (showFit) { const f = fitLine(xs, ys, colour, cname)
                       if (f) fits.push({ name:cname, fit:f, colour }) }
      } else {
        // Every repeat's own points, paired frame by frame with ITSELF.
        const xs:number[] = [], ys:number[] = []
        for (const pr of paired) {
          const n = Math.min(pr.ay.length, pr.by.length)
          const rx = pr.ay.slice(0,n), ry = pr.by.slice(0,n)
          xs.push(...rx); ys.push(...ry)
          if (corrPoints === 'perrep') {
            const f = linearFit(rx, ry)
            if (f) {
              perRep.push({ name:`${cname} rep${pr.index}`, r:f.r })
              if (showFit) fitLine(rx, ry, colour, `${cname} rep${pr.index}`, true)
            }
          }
        }
        allX.push(...xs); allY.push(...ys)
        traces.push({ x:xs, y:ys, type:'scattergl', mode:'markers',
          marker: seriesMarker(rs, -3, '', 2),
          name:`${cname} (${paired.length} repeats)`,
          hovertemplate:`${cname}<br>%{x:.3f}, %{y:.3f}<extra></extra>` })
        if (showFit && corrPoints === 'pooled') {
          const f = fitLine(xs, ys, colour, cname)
          if (f) fits.push({ name:cname, fit:f, colour })
        }
      }
    }
    return { traces, r: pearson(allX, allY),
             overall: linearFit(allX, allY),
             overallSpearman: linearFit(allX, allY, true),
             fits, perRep, droppedReps, nPoints: allX.length }
  }, [mode, metricA, metricB, byKey, isExcluded, baseSeries, showFit, style,
      corrPoints])

  // ─── Repeat detail: several analyses, one run ───────────────────────────────
  /*
   * "What was happening in repeat 5 around 345 ns?"
   *
   * Every other mode here answers a question about CONDITIONS, pooling or
   * averaging runs to get there. This one deliberately does the opposite: it
   * fixes one run and lays several observables over the same time axis, because
   * whether a contact breaking coincides with a loop opening is a fact about a
   * single trajectory, and averaging is what destroys it.
   *
   * STACKED IS THE DEFAULT, and not for taste. RMSD sits around 0.3 nm, SASA
   * around 200 nm^2, hydrogen-bond counts around 50. Drawn on one raw axis
   * everything but the largest is a flat line at the bottom. Stacked panels
   * keep real units and real values; overlaying them requires destroying the
   * units first, which is a thing to opt into rather than to be handed.
   */
  const together = useMemo(() => {
    const empty = { traces: [] as any[], layout: {} as any, panels: [] as any[],
                    skipped: [] as string[], repeats: [] as number[],
                    conditions: [] as {id:string;name:string}[], span: null as null|[number,number],
                    axisRows: [] as AxisRow[], axisToken: '' }
    if (mode !== 'together') return empty

    // Only time series belong on a shared time axis. An RMSF profile is
    // per-residue: plotting it against time would silently reinterpret residue
    // numbers as nanoseconds, which would look entirely plausible.
    const isTime = (r: any) => /time/i.test(r?.xlabel || '')
    const timeKeys = keys.filter(k => (byKey[k] || []).some(isTime))
    const skipped = keys.filter(k => !timeKeys.includes(k))
                        .map(k => metricLabel(k))

    const conditions = new Map<string, string>()
    for (const k of timeKeys)
      for (const r of byKey[k] || [])
        if (r.condition_id) conditions.set(r.condition_id, r.condition_name || r.condition_id)
    const condList = [...conditions].map(([id, name]) => ({ id, name }))
    const cid = togetherCond || condList[0]?.id || ''

    // Repeats available for this condition, across the CHOSEN analyses — a
    // repeat one analysis is missing is not a repeat you can overlay.
    const chosen = togetherMetrics.filter(k => timeKeys.includes(k))
    const active = chosen.length ? chosen : timeKeys.slice(0, 3)
    const repSets = active.map(k => {
      const r = (byKey[k] || []).find(x => x.condition_id === cid)
      return new Set((r?.replicas || [])
        .filter(rep => !isExcluded(k, cid, rep.index)).map(rep => rep.index))
    })
    const repeats = repSets.length
      ? [...repSets.reduce((acc, s) => new Set([...acc].filter(v => s.has(v))))].sort((a,b)=>a-b)
      : []
    const rep = (togetherRep !== null && repeats.includes(togetherRep))
      ? togetherRep : repeats[0]
    if (rep === undefined) {
      return { ...empty, skipped, repeats, conditions: condList }
    }

    const traces: any[] = []
    /*
     * `title` and `ylabel` are the two halves of `label`, split rather than
     * repeated. The full "sasa · helix_cavity_atoms — SASA (nm^2)" was being
     * used as a y-axis title on every panel, where it is rotated vertical and
     * far longer than a 150px panel is tall — so five of them overlapped into
     * an unreadable column down the left edge. The part that identifies the
     * RUN goes above the panel as a heading, and only the part that names the
     * quantity and its unit stays on the axis.
     */
    const panels: {key:string; label:string; title:string; ylabel:string;
                   unit:string; colour:string}[] = []
    let lo = Infinity, hi = -Infinity

    active.forEach((k, i) => {
      const r = (byKey[k] || []).find(x => x.condition_id === cid)
      const series = (r?.replicas || []).find(p => p.index === rep)
      if (!r || !series) return
      const xs = (series as any).x || r.x || []
      const ys = series.y || []
      if (!xs.length || !ys.length) return
      const colour = REPEAT_PALETTE[i % REPEAT_PALETTE.length]
      const unit = /\(([^)]+)\)\s*$/.exec(r.ylabel || '')?.[1] || ''
      panels.push({ key: k, label: metricLabel(k), title: k,
                    ylabel: r.ylabel || '', unit, colour })
      for (const v of xs) { if (v < lo) lo = v; if (v > hi) hi = v }

      // Normalising is only for the overlaid layout; stacked keeps the real
      // numbers, which is the point of stacking.
      let plotted: number[] = ys
      if (togetherLayout === 'overlay') {
        const fin = ys.filter(Number.isFinite)
        if (togetherNorm === 'zscore') {
          const m = fin.reduce((a,b)=>a+b,0)/(fin.length||1)
          const sd = Math.sqrt(fin.reduce((a,b)=>a+(b-m)**2,0)/Math.max(1,fin.length-1))
          plotted = ys.map(v => sd > 0 ? (v-m)/sd : 0)
        } else {
          const mn = Math.min(...fin), mx = Math.max(...fin)
          plotted = ys.map(v => mx > mn ? (v-mn)/(mx-mn) : 0)
        }
      }

      traces.push({
        x: xs, y: plotted, type: 'scattergl', mode: 'lines',
        line: { color: colour, width: style.lineWidth,
                dash: style.lineDash === 'solid' ? undefined : style.lineDash },
        name: metricLabel(k),
        yaxis: togetherLayout === 'stacked' ? (i === 0 ? 'y' : `y${i+1}`) : 'y',
        // The raw value stays in the hover even when the line is normalised,
        // so a z-score of 2.1 can still be read as 0.47 nm.
        customdata: togetherLayout === 'overlay' ? ys : undefined,
        hovertemplate: togetherLayout === 'overlay'
          ? `${metricLabel(k)}: %{customdata:.3f}${unit ? ' ' + unit : ''}`
            + ` (%{y:.2f})<extra></extra>`
          : `${metricLabel(k)}: %{y:.3f}${unit ? ' ' + unit : ''}<extra></extra>`,
      })
    })

    // ── Axis extents, for locking a scale across repeats ──────────────────
    /*
     * Measured from the STORED replicas, not from the traces, because the
     * traces only hold the one repeat on screen — which is precisely the run
     * whose extent must not be allowed to set the scale.
     */
    const extentsOf = (k: string, condId: string | null) => {
      let y: Extent | null = null, x: Extent | null = null
      for (const r of byKey[k] || []) {
        if (condId !== null && r.condition_id !== condId) continue
        for (const pr of r.replicas || []) {
          if (isExcluded(k, r.condition_id || '', pr.index)) continue
          y = mergeExtents(y, extentOf(pr.y || []))
          x = mergeExtents(x, extentOf((pr as any).x || r.x || []))
        }
      }
      return { x, y }
    }
    const extents: Record<string, { repeats: {x: Extent|null; y: Extent|null}
                                    all: {x: Extent|null; y: Extent|null} }> = {}
    for (const k of active)
      extents[k] = { repeats: extentsOf(k, cid), all: extentsOf(k, null) }

    const lockFor = (k: string): AxisLock => repeatAxisLocks[k] || DEFAULT_AXIS_LOCK
    /*
     * Y locks apply to STACKED panels only. The overlaid layout has already
     * destroyed the units to get everything onto one axis, so a range in nm is
     * not a range in anything it draws.
     */
    const yRangeFor = (k: string) => togetherLayout !== 'stacked' ? undefined
      : resolveAxisRange(lockFor(k), { repeats: extents[k]?.repeats.y ?? null,
                                       all: extents[k]?.all.y ?? null })

    const xExt = {
      repeats: active.reduce((a, k) => mergeExtents(a, extents[k]?.repeats.x ?? null),
                             null as Extent | null),
      all: active.reduce((a, k) => mergeExtents(a, extents[k]?.all.x ?? null),
                         null as Extent | null),
    }
    // Time gets almost no padding: a trajectory starts at 0 and ends where it
    // ends, and a margin there just draws empty axis.
    const xRange = resolveAxisRange(repeatXLock, xExt, 0.01)

    const axisRows: AxisRow[] = [
      ...panels.map(pn => ({
        key: pn.key, label: pn.title, unit: pn.unit, colour: pn.colour,
        lock: lockFor(pn.key),
        extents: { repeats: extents[pn.key]?.repeats.y ?? null,
                   all: extents[pn.key]?.all.y ?? null },
        applied: yRangeFor(pn.key),
      })),
      { key: '__x__', label: 'Time', unit: 'ns', lock: repeatXLock,
        extents: { repeats: xExt.repeats, all: xExt.all }, applied: xRange },
    ]
    /*
     * Plotly keeps axis state across renders that share a uirevision, which is
     * what stops a redraw throwing away someone's zoom. The flip side is that
     * a NEW range computed here is also ignored, so changing a lock looked
     * like it did nothing until the panel count happened to change too. The
     * resolved ranges therefore go into the token.
     */
    const axisToken = axisRows
      .map(r => `${r.key}:${r.lock.mode}:${r.applied?.join('_') ?? ''}`).join('|')

    // ── Layout ────────────────────────────────────────────────────────────
    const layout: any = {}
    if (togetherLayout === 'stacked' && panels.length) {
      const n = panels.length
      /*
       * EVERY PANEL IS THE SAME HEIGHT IN PIXELS, and the figure grows instead.
       *
       * The old arithmetic set a total height of 150n + 90 and then split it
       * into n equal FRACTIONS, so the per-panel height fell away as panels
       * were added — 240 px with one, 144 px with four, 99 px with eight. Eight
       * analyses is exactly when you most need to read them, and that is when
       * they were thinnest. Sizing the figure from a fixed per-panel height and
       * deriving the fractions from it inverts that: panel ten is as tall as
       * panel one, and the page scrolls, which is free.
       */
      const PANEL_PX = 150
      /*
       * The gap now has to hold each panel's heading, not just separate two
       * plot frames, so it is deeper than the 34px that sufficed when the
       * identifying text lived on the axis.
       */
      const TITLE_PX = 20
      const GAP_PX = 44
      const plotPx = n * PANEL_PX + (n - 1) * GAP_PX
      // The first panel's heading has no gap above it to sit in, so the top
      // margin provides one.
      const marginT = (style.title ? 44 : 10) + TITLE_PX
      const marginB = 56
      const fracPanel = PANEL_PX / plotPx
      const fracGap = GAP_PX / plotPx

      /*
       * Headings are ANNOTATIONS, not per-axis titles.
       *
       * Plotly has no notion of a subplot title: a y-axis `title` is rotated
       * and centred on the axis, which is exactly the placement being moved
       * away from. A paper-referenced annotation pinned to the left edge just
       * above each domain is the only way to get a flat heading over a panel.
       */
      const titles: any[] = []

      panels.forEach((pn, i) => {
        const top = 1 - i * (fracPanel + fracGap)
        const key = i === 0 ? 'yaxis' : `yaxis${i+1}`
        layout[key] = {
          // The frame, ticks and grid come from the same place as every other
          // plot's; these panels used to set three of those properties by hand
          // and silently ignore the rest.
          ...axisDecor(style),
          domain: [Math.max(0, top - fracPanel), Math.min(1, top)],
          // Just the quantity and its unit — the run is named in the heading.
          title: { text: pn.ylabel || pn.label,
                   font: { size: Math.max(8, style.fontSize - 1) } },
          range: yRangeFor(pn.key),
        }
        titles.push({
          text: `<b>${pn.title}</b>`,
          xref: 'paper', yref: 'paper',
          x: 0, xanchor: 'left',
          y: Math.min(1, top) + 5 / plotPx, yanchor: 'bottom',
          showarrow: false,
          font: {
            family: 'Arial Black, Arial Bold, Arial, Helvetica, sans-serif',
            size: style.fontSize, color: style.fontColor,
          },
          align: 'left',
        })
      })
      layout.annotations = titles

      layout.xaxis = {
        ...axisDecor(style),
        title: { text: 'Time (ns)' }, anchor: n === 1 ? 'y' : `y${n}`,
        range: xRange,
        // A spike line drawn ACROSS every panel is what makes coincident events
        // readable: the eye cannot hold a vertical position across four panels.
        showspikes: true, spikemode: 'across', spikethickness: 1,
        spikecolor: style.gridColor, spikedash: 'dot',
      }
      layout.height = plotPx + marginT + marginB
      /*
       * NO LEGEND, and the width it occupied goes to the time axis.
       *
       * A legend maps colour to series, and here each series already has its
       * own panel with its own heading — so every entry restated something
       * written six inches to its left, in a box wide enough to swallow a
       * third of the plot. The margin is therefore the bare gutter rather than
       * legendMargin's reservation.
       *
       * `l` is narrower too, now that the axis title is "SASA (nm²)" rather
       * than the whole metric key.
       */
      layout.showlegend = false
      layout.margin = { l: 58, r: 18, t: marginT, b: marginB }
      layout.hovermode = 'x unified'
      layout.spikedistance = -1
    }
    if (togetherLayout === 'overlay') {
      // The overlaid layout DOES keep its legend: one axis, several series,
      // and no per-panel heading to name them by.
      layout.hovermode = 'x unified'
      layout.xaxis = { ...axisDecor(style),
                       title: { text: 'Time (ns)' }, range: xRange,
                       showspikes: true,
                       spikemode: 'across', spikethickness: 1,
                       spikecolor: style.gridColor, spikedash: 'dot' }
    }

    // The time marker, spanning the full height so it crosses every panel.
    if (cursorNs !== null && Number.isFinite(cursorNs)) {
      layout.shapes = [{
        type: 'line', x0: cursorNs, x1: cursorNs, yref: 'paper', y0: 0, y1: 1,
        line: { color: '#f79f4f', width: 1.4, dash: 'dash' },
      }]
    }

    return { traces, layout, panels, skipped, repeats,
             conditions: condList, axisRows, axisToken,
             span: Number.isFinite(lo) ? [lo, hi] as [number, number] : null }
    // metricLabel is intentionally absent: it is a hoisted function
    // declaration (see its own comment — a const there reintroduces a
    // temporal-dead-zone crash) and reads only byKey, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, keys, byKey, isExcluded, togetherCond, togetherRep, togetherMetrics,
      togetherLayout, togetherNorm, cursorNs, style,
      repeatAxisLocks, repeatXLock])

  // ─── Cross-correlation ──────────────────────────────────────────────────────
  /*
   * PER REPEAT BY DEFAULT, and that is not a preference.
   *
   * Averaging the repeats before cross-correlating destroys the thing this plot
   * exists to measure. Coupling is a statement about events: a contact breaks
   * and a distance responds a few nanoseconds later. But those events happen at
   * DIFFERENT WALL-CLOCK TIMES in different runs — 300 ns in one, 700 ns in
   * another — so averaging by time smears every event into a broad, shallow
   * bump. The mean of ten stochastic events is close to flat, and its
   * cross-correlation is correspondingly close to zero.
   *
   * Worse than losing the signal: what SURVIVES averaging is whatever the runs
   * share at the same absolute time — equilibration drift, a slow common trend —
   * so a peak in the averaged curve is more likely to be that than coupling.
   *
   * The honest analysis is within each run, where the events actually co-occur,
   * and then asking whether the repeats AGREE about the lag. Agreement across
   * independent runs is the evidence; a single pooled curve cannot show it.
   */
  const xcorr = useMemo(() => {
    const empty = { traces: [] as any[], perRep: [] as any[], dtNs: null as number | null,
                    conditions: [] as any[] }
    if (mode!=='crosscorr') return empty
    const traces:any[] = []
    const perRep:{condition:string; index:number; peakLag:number; peakR:number; r0:number}[] = []
    const conditions:{name:string; colour:string; nReps:number}[] = []
    let dtNs: number | null = null

    for (const a of byKey[metricA]||[]) {
      const b = (byKey[metricB]||[]).find(x=>x.condition_id===a.condition_id)
      if (!b) continue
      const cid = a.condition_id!, cname = a.condition_name || cid
      const colour = a.colour || '#4f8ef7'

      // Matched by repeat INDEX, and dropped if excluded under either metric —
      // the same pairing rule the correlation scatter uses.
      const bReps = new Map((b.replicas||[]).map(r=>[r.index, r]))
      const paired = (a.replicas||[])
        .filter(r => bReps.has(r.index)
                  && !isExcluded(metricA,cid,r.index) && !isExcluded(metricB,cid,r.index))
        .map(r => ({ index: r.index, ay: r.y, by: bReps.get(r.index)!.y,
                     ax: (r as any).x as number[] | undefined }))
      if (!paired.length) continue
      conditions.push({ name: cname, colour, nReps: paired.length })

      // Lag in nanoseconds rather than frames, when the timestep can be read
      // off the series — "coupled with a 4 ns delay" is a claim; "4 frames" is
      // a claim about the output interval.
      if (dtNs === null) {
        const xs = paired[0].ax
        if (Array.isArray(xs) && xs.length > 1 && Number.isFinite(xs[1] - xs[0])) {
          dtNs = xs[1] - xs[0]
        }
      }
      const toLagUnits = (l: number) => dtNs ? l * dtNs : l

      if (xcorrBasis === 'mean') {
        const ma = recomputeMean(paired.map(p=>({y:p.ay}))).mean
        const mb = recomputeMean(paired.map(p=>({y:p.by}))).mean
        const { lags, xcorr:xc } = crossCorr(ma, mb, maxLag)
        traces.push({ x:lags.map(toLagUnits), y:xc, type:'scatter', mode:'lines',
          line:{ color:colour, width:style.lineWidth+0.8,
                 dash: style.lineDash==='solid' ? undefined : style.lineDash },
          name:`${cname} (mean of ${paired.length})` })
        continue
      }

      // One curve per repeat, plus the Fisher-pooled curve on top.
      const curves:number[][] = []
      let lagAxis:number[] = []
      for (const pr of paired) {
        const { lags, xcorr:xc } = crossCorr(pr.ay, pr.by, maxLag)
        if (!lags.length) continue
        lagAxis = lags
        curves.push(xc)
        let bi = 0
        for (let i=1;i<xc.length;i++) if (Math.abs(xc[i]) > Math.abs(xc[bi])) bi = i
        const zeroI = lags.indexOf(0)
        perRep.push({ condition:cname, index:pr.index,
                      peakLag: toLagUnits(lags[bi]), peakR: xc[bi],
                      r0: zeroI >= 0 ? xc[zeroI] : NaN })
        traces.push({ x:lags.map(toLagUnits), y:xc, type:'scattergl', mode:'lines',
          line:{ color:colour, width:Math.max(0.6, style.lineWidth-0.6) },
          opacity:0.35, name:`${cname} rep${pr.index}`, showlegend:false,
          hovertemplate:`${cname} rep${pr.index}<br>lag %{x:.2f}, r %{y:.3f}<extra></extra>` })
      }

      if (curves.length > 1 && lagAxis.length) {
        // Fisher z per lag: coefficients are not additive, so a plain mean
        // understates a consistent correlation.
        const pooled = lagAxis.map((_, i) => {
          const vals = curves.map(c => c[i]).filter(Number.isFinite)
          if (!vals.length) return NaN
          const z = vals.reduce((acc, v) =>
            acc + Math.atanh(Math.max(-0.999999, Math.min(0.999999, v))), 0) / vals.length
          return Math.tanh(z)
        })
        traces.push({ x:lagAxis.map(toLagUnits), y:pooled, type:'scatter', mode:'lines',
          line:{ color:colour, width:style.lineWidth+1.2,
                 dash: style.lineDash==='solid' ? undefined : style.lineDash },
          name:`${cname} (${curves.length} repeats, pooled)`,
          hovertemplate:`${cname} pooled<br>lag %{x:.2f}, r %{y:.3f}<extra></extra>` })
      }
    }
    return { traces, perRep, dtNs, conditions }
  }, [mode, metricA, metricB, byKey, isExcluded, maxLag, style, xcorrBasis])

  /**
   * One number per replica, per condition — the input every test here takes.
   *
   * Built from exactly the same per-replica means the bar chart plots, so the
   * statistics can never describe a different quantity than the figure above
   * them. Excluded replicas are excluded from both.
   */
  const statGroups = useMemo(() => {
    const out: { name: string; values: number[] }[] = []
    for (const r of byKey[metricA] || []) {
      const kept = (r.replicas || []).filter(rep => !isExcluded(metricA, r.condition_id!, rep.index))
      if (!kept.length) continue
      out.push({
        name: r.condition_name || r.condition_id!,
        values: kept.map(rep => rep.y.reduce((a, b) => a + b, 0) / (rep.y.length || 1)),
      })
    }
    return out
  }, [metricA, byKey, isExcluded])

  const comparison = useMemo(
    () => compareGroups(statGroups, statTest), [statGroups, statTest])

  // ─── Average bars ───────────────────────────────────────────────────────────
  // Two styles:
  //   'per_replica'  : one bar per replica, grouped by condition (original)
  //   'per_condition': one bar per condition = mean across its replicas, with
  //                    individual replica means overlaid as dots + SD error bar
  const bars = useMemo(() => {
    const traces:any[] = []

    if (barStyle === 'per_replica') {
      for (const r of byKey[metricA]||[]) {
        const kept = (r.replicas||[]).filter(rep=>!isExcluded(metricA,r.condition_id!,rep.index))
        if (!kept.length) continue
        const avgs = kept.map(rep => rep.y.reduce((a,b)=>a+b,0)/(rep.y.length||1))
        const sds = kept.map(rep => {
          const m = rep.y.reduce((a,b)=>a+b,0)/(rep.y.length||1)
          return Math.sqrt(rep.y.reduce((a,b)=>a+(b-m)**2,0)/(rep.y.length||1))
        })
        // Shaded from the RESOLVED colour, so an override on the condition
        // carries through to its per-replica bars instead of being ignored.
        const rs = resolveSeriesStyle(baseSeries(r.condition_id!), style,
                                      r.colour || undefined, traces.length)
        const shades = kept.map((_,i)=>lighten(rs.colour, kept.length>1?(i/kept.length)*0.5:0))
        traces.push({
          x: kept.map(rep=>`rep${rep.index}`), y: avgs, type:'bar', name:r.condition_name,
          marker: seriesBarArray(shades.map(sh => ({ ...rs, colour: sh }))),
          error_y: errorBarStyle(style, rs.colour, sds),
        })
      }
      return traces
    }

    // per_condition: pooled mean per condition + dots for each replica.
    // If barMetrics has entries, compare MULTIPLE metrics (e.g. several mindist
    // analyses) side by side: x-axis grouped by metric, bars coloured by condition.
    const metricsToPlot = barMetrics.length > 0 ? barMetrics : [metricA]

    if (metricsToPlot.length > 1) {
      // Grouped bars: one trace per condition, x = metric names.
      // NOT named `conditions` — that is the component-level list now, and
      // shadowing it here would silently resolve series styles against a Map.
      const condMap = new Map<string, { name:string; colour:string }>()
      for (const mk of metricsToPlot)
        for (const r of byKey[mk]||[])
          condMap.set(r.condition_id!, { name:r.condition_name||r.condition_id!, colour:r.colour||'#4f8ef7' })

      for (const [cid, cinfo] of condMap) {
        const xs:string[] = [], ys:number[] = [], es:number[] = []
        const dX:string[] = [], dY:number[] = [], dT:string[] = []
        for (const mk of metricsToPlot) {
          const r = (byKey[mk]||[]).find(x=>x.condition_id===cid)
          if (!r) continue
          const kept = (r.replicas||[]).filter(rep=>!isExcluded(mk,cid,rep.index))
          if (!kept.length) continue
          const repAvgs = kept.map(rep => rep.y.reduce((a,b)=>a+b,0)/(rep.y.length||1))
          const m = repAvgs.reduce((a,b)=>a+b,0)/repAvgs.length
          const v = repAvgs.length>1 ? repAvgs.reduce((a,b)=>a+(b-m)**2,0)/(repAvgs.length-1) : 0
          xs.push(mk); ys.push(m); es.push(Math.sqrt(v))
          kept.forEach((rep,i)=>{ dX.push(mk); dY.push(repAvgs[i]); dT.push(`${cinfo.name} ${mk} rep${rep.index}: ${repAvgs[i].toFixed(3)}`) })
        }
        const rs = resolveSeriesStyle(baseSeries(cid), style, cinfo.colour,
                                      [...condMap.keys()].indexOf(cid))
        traces.push({
          x:xs, y:ys, type:'bar', name:cinfo.name,
          marker: seriesBarArray([rs]),
          offsetgroup: cid, legendgroup: cid,
          error_y: errorBarStyle(style, plotTheme().font, es),
          hovertemplate:`${cinfo.name}<br>%{x}: %{y:.3f}<extra></extra>`,
        })
        traces.push({
          x:dX, y:dY, type:'scatter', mode:'markers', name:`${cinfo.name} reps`,
          // Bind dots to the same offset group as this condition's bars so they
          // sit INSIDE the bar rather than centred between the grouped bars.
          offsetgroup: cid, legendgroup: cid,
          marker: seriesMarkerArray(dX.map(() => rs)),
          text:dT, hovertemplate:'%{text}<extra></extra>', showlegend:false,
        })
      }
      return traces
    }

    // Single metric: pooled mean per condition + dots for each replica
    const names:string[] = [], means:number[] = [], errs:number[] = []
    const dotX:string[] = [], dotY:number[] = [], dotText:string[] = []
    // One resolved style PER BAR and PER DOT, so pooled traces can still give
    // each one its own condition's colour. See lib/plotSeries.ts.
    const barStyles: ReturnType<typeof resolveSeriesStyle>[] = []
    const dotStyles: ReturnType<typeof resolveSeriesStyle>[] = []
    for (const r of byKey[metricA]||[]) {
      const kept = (r.replicas||[]).filter(rep=>!isExcluded(metricA,r.condition_id!,rep.index))
      if (!kept.length) continue
      const repAvgs = kept.map(rep => rep.y.reduce((a,b)=>a+b,0)/(rep.y.length||1))
      const m = repAvgs.reduce((a,b)=>a+b,0)/repAvgs.length
      const variance = repAvgs.length>1
        ? repAvgs.reduce((a,b)=>a+(b-m)**2,0)/(repAvgs.length-1) : 0
      const cname = r.condition_name || r.condition_id!
      names.push(cname); means.push(m); errs.push(Math.sqrt(variance))
      const resolved = resolveSeriesStyle(baseSeries(r.condition_id!), style,
                                          r.colour || undefined, names.length - 1)
      barStyles.push(resolved)
      kept.forEach((rep,i) => {
        dotX.push(cname); dotY.push(repAvgs[i])
        dotText.push(`${cname} rep${rep.index}: ${repAvgs[i].toFixed(3)}`)
        dotStyles.push(resolved)
      })
    }
    traces.push({
      x: names, y: means, type:'bar', name:'condition mean',
      marker: seriesBarArray(barStyles),
      error_y: errorBarStyle(style, plotTheme().font, errs),
      hovertemplate:'%{x}<br>mean: %{y:.3f}<extra></extra>', showlegend:false,
    })
    traces.push({
      x: dotX, y: dotY, type:'scatter', mode:'markers', name:'replicas',
      // Was a single theme colour for every dot, so replica dots from
      // different conditions were indistinguishable. Each dot now carries its
      // own condition's colour.
      marker: seriesMarkerArray(dotStyles, 1),
      text: dotText, hovertemplate:'%{text}<extra></extra>', showlegend:false,
    })
    return traces
  }, [metricA, byKey, isExcluded, baseSeries, style, barStyle, barMetrics])

  // ─── Filtered analysis ──────────────────────────────────────────────────────
  // Filter frames by a threshold on filterMetric, then report either:
  //   'fraction'          : fraction of frames passing the filter (contact time!)
  //   'conditional_mean'  : mean of targetMetric over the passing frames
  // Per-frame metrics must share frame sampling (same time window/stride).
  const filtered = useMemo(() => {
    const passes = (v: number, thr: number) =>
      filterOp === '>' ? v > thr : filterOp === '<' ? v < thr :
      filterOp === '>=' ? v >= thr : v <= thr
    const thr = parseFloat(filterThreshold)
    if (isNaN(thr)) return { traces: [], perReplica: [] as any[] }

    // Compute per-replica value (fraction or conditional mean) keyed by condition
    const perCond: Record<string, { name:string; colour:string; vals:{index:number;val:number|null}[] }> = {}
    for (const fr of byKey[filterMetric] || []) {
      const cid = fr.condition_id!
      const tgt = filterOutput === 'conditional_mean'
        ? (byKey[targetMetric] || []).find(x => x.condition_id === cid) : fr
      perCond[cid] = { name: fr.condition_name || cid, colour: fr.colour || '#4f8ef7', vals: [] }
      for (const rep of fr.replicas || []) {
        if (isExcluded(filterMetric, cid, rep.index)) continue
        const fy = rep.y
        // find matching target replica (same index) for conditional mean
        let val: number | null = null
        if (filterOutput === 'fraction') {
          const nPass = fy.reduce((a, v) => a + (passes(v, thr) ? 1 : 0), 0)
          val = fy.length ? nPass / fy.length : null
        } else {
          const tRep = (tgt?.replicas || []).find(r => r.index === rep.index)
          if (tRep) {
            const n = Math.min(fy.length, tRep.y.length)
            const kept: number[] = []
            for (let i = 0; i < n; i++) if (passes(fy[i], thr)) kept.push(tRep.y[i])
            val = kept.length ? kept.reduce((a,b)=>a+b,0)/kept.length : null
          }
        }
        perCond[cid].vals.push({ index: rep.index, val })
      }
    }

    const traces: any[] = []
    if (filterBarStyle === 'per_replica') {
      for (const cid of Object.keys(perCond)) {
        const pc = perCond[cid]
        traces.push({
          x: pc.vals.map(v => `rep${v.index}`), y: pc.vals.map(v => v.val),
          type: 'bar', name: pc.name,
          marker: seriesBar(resolveSeriesStyle(baseSeries(cid), style, pc.colour,
                                               traces.length)),
        })
      }
    } else {
      // per-condition mean + replica dots
      const names:string[]=[], means:number[]=[], errs:number[]=[]
      const dX:string[]=[], dY:number[]=[], dT:string[]=[]
      const bStyles: ReturnType<typeof resolveSeriesStyle>[] = []
      const dStyles: ReturnType<typeof resolveSeriesStyle>[] = []
      for (const cid of Object.keys(perCond)) {
        const pc = perCond[cid]
        const vals = pc.vals.map(v => v.val).filter((v): v is number => v !== null)
        if (!vals.length) continue
        const m = vals.reduce((a,b)=>a+b,0)/vals.length
        const variance = vals.length>1 ? vals.reduce((a,b)=>a+(b-m)**2,0)/(vals.length-1) : 0
        names.push(pc.name); means.push(m); errs.push(Math.sqrt(variance))
        // Was resolveSeriesStyle(null, ...) — which threw away the per-series
        // override, so a dot colour set on this chart did nothing at all.
        const resolved = resolveSeriesStyle(baseSeries(cid), style, pc.colour,
                                            names.length - 1)
        bStyles.push(resolved)
        pc.vals.forEach(v => { if (v.val!==null){
          dX.push(pc.name); dY.push(v.val)
          dT.push(`${pc.name} rep${v.index}: ${v.val.toFixed(3)}`)
          dStyles.push(resolved)
        } })
      }
      traces.push({
        x: names, y: means, type: 'bar', name: 'condition mean',
        marker: seriesBarArray(bStyles),
        error_y: errorBarStyle(style, plotTheme().font, errs),
        hovertemplate:'%{x}<br>%{y:.3f}<extra></extra>', showlegend:false,
      })
      traces.push({
        x: dX, y: dY, type:'scatter', mode:'markers', name:'replicas',
        marker: seriesMarkerArray(dStyles, 1),
        text: dT, hovertemplate:'%{text}<extra></extra>', showlegend:false,
      })
    }
    return { traces }
  }, [filterMetric, filterOp, filterThreshold, filterOutput, targetMetric,
      filterBarStyle, byKey, isExcluded, baseSeries, style])

  /**
   * SEVERAL saved filters on one chart, grouped either way round.
   *
   * This replaces the single-filter chart whenever filters are on the graph;
   * the inline controls still drive the old path when none are, so nothing a
   * project already does changes.
   *
   * THE REPLICA INTERSECTION. Each filter names its own metric, and exclusions
   * are stored per metric, so excluding repeat 3 of the cavity analysis would
   * otherwise leave a filter on SASA still using it — two bars side by side
   * built from different sets of runs, with nothing on screen saying so. The
   * usable repeats are therefore intersected across every metric any series on
   * the graph touches, which is the rule the correlation scatter already uses.
   */
  const multi = useMemo(() => {
    const empty = {
      active: false, traces: [] as any[], ylabel: '',
      groups: [] as { name: string; values: number[] }[],
      paired: false, refuse: null as string | null, notes: [] as string[],
      dropped: [] as string[],
    }
    if (mode !== 'filtered' || !model.series.length) return empty
    const visible = model.series.filter(s => s.visible)
    if (!visible.length) {
      return { ...empty, active: true, notes: ['Every series is hidden.'] }
    }

    const filterOf = (id: string) => model.activeFilters.find(f => f.id === id)
    const notes: string[] = [], dropped: string[] = []

    const metricsUsed = new Set<string>()
    for (const s of visible) {
      const f = filterOf(s.filterId); if (!f) continue
      metricsUsed.add(f.metric)
      if (f.output === 'conditional_mean' && f.targetMetric) metricsUsed.add(f.targetMetric)
    }

    const usable = new Map<string, number[]>()
    for (const c of conditions) {
      let set: Set<number> | null = null
      for (const mk of metricsUsed) {
        const r = (byKey[mk] || []).find(x => x.condition_id === c.id)
        const have = new Set((r?.replicas || [])
          .filter(rep => !isExcluded(mk, c.id, rep.index)).map(rep => rep.index))
        if (set === null) set = have
        else {
          for (const v of [...set]) if (!have.has(v)) {
            dropped.push(`${c.name} rep${v} (unavailable or excluded under ${mk})`)
            set.delete(v)
          }
        }
      }
      usable.set(c.id, [...(set || new Set<number>())].sort((a, b) => a - b))
    }

    // One number per usable replica, per series.
    const valueOf = new Map<string, { index: number; value: number }[]>()
    const problems = new Set<string>()
    for (const s of visible) {
      const f = filterOf(s.filterId)
      if (!f) continue
      const fr = (byKey[f.metric] || []).find(x => x.condition_id === s.conditionId)
      const tg = (f.output === 'conditional_mean' && f.targetMetric)
        ? (byKey[f.targetMetric] || []).find(x => x.condition_id === s.conditionId)
        : undefined
      const out: { index: number; value: number }[] = []
      for (const idx of usable.get(s.conditionId) || []) {
        const rep = (fr?.replicas || []).find(r => r.index === idx)
        if (!rep) continue
        const trep = tg ? (tg.replicas || []).find(r => r.index === idx) : undefined
        const v = evaluateReplica(
          f, { index: idx, x: (rep as any).x || fr!.x, y: rep.y },
          trep ? { index: idx, x: (trep as any).x || tg!.x, y: trep.y } : undefined)
        if (v.problem) problems.add(v.problem)
        if (v.value !== null) out.push({ index: idx, value: v.value })
      }
      valueOf.set(s.id, out)
    }
    for (const p of problems) notes.push(p)

    /*
     * MIXED UNITS ON ONE AXIS.
     *
     * A pass fraction is 0-1 and a conditional mean is in the metric's own
     * units, often hundreds. Drawn on one axis the fraction is a flat line on
     * the floor, which reads as "no signal" rather than "wrong axis".
     */
    const outputs = new Set(visible.map(s => filterOf(s.filterId)?.output))
    const targets = new Set(visible.map(s => filterOf(s.filterId)?.targetMetric)
                                   .filter(Boolean))
    if (outputs.size > 1) {
      notes.push('These series mix a pass FRACTION (0–1) with a conditional MEAN '
               + 'in a metric’s own units. They share one y-axis, so the '
               + 'fraction will sit flat against the floor. Put them on separate '
               + 'graphs.')
    } else if (outputs.has('conditional_mean') && targets.size > 1) {
      notes.push(`These series average different metrics (${[...targets].join(', ')}), `
               + 'so the y-axis has no single unit.')
    }
    const ylabel = outputs.size > 1 ? 'value (mixed units — see below)'
      : outputs.has('fraction') ? 'fraction of frames passing'
      : `mean ${[...targets].join(' / ')} (filtered)`

    // ── Traces ────────────────────────────────────────────────────────────
    const axis = model.groupBy === 'condition'
      ? conditions.map(c => ({ key: c.id, label: c.name }))
      : model.activeFilters.map(f => ({ key: f.id, label: f.name }))
    const legendDim = model.groupBy === 'condition'
      ? model.activeFilters.map(f => ({ key: f.id, label: f.name }))
      : conditions.map(c => ({ key: c.id, label: c.name }))

    const traces: any[] = []
    for (const L of legendDim) {
      const xs: string[] = [], ys: number[] = [], es: number[] = []
      const barStyles: ReturnType<typeof resolveSeriesStyle>[] = []
      const dX: string[] = [], dY: number[] = [], dT: string[] = []
      const dotStyles: ReturnType<typeof resolveSeriesStyle>[] = []
      let legend = L.label
      for (const Ax of axis) {
        const fid = model.groupBy === 'condition' ? L.key : Ax.key
        const cid = model.groupBy === 'condition' ? Ax.key : L.key
        const sr = visible.find(v => v.filterId === fid && v.conditionId === cid)
        if (!sr) continue
        const vals = valueOf.get(sr.id) || []
        if (!vals.length) continue
        const nums = vals.map(v => v.value)
        const m = nums.reduce((a, b) => a + b, 0) / nums.length
        const variance = nums.length > 1
          ? nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1) : 0
        xs.push(Ax.label); ys.push(m); es.push(Math.sqrt(variance))
        const cond = conditions.find(c => c.id === cid)
        const rs = resolveSeriesStyle(sr, style, cond?.colour, sr.order)
        barStyles.push(rs)
        // A hand-typed label belongs to the series, so it wins over the
        // dimension name the legend would otherwise take.
        if (model.labels[sr.id]) legend = model.labels[sr.id]
        vals.forEach(v => {
          dX.push(Ax.label); dY.push(v.value); dotStyles.push(rs)
          dT.push(`${sr.label} rep${v.index}: ${v.value.toFixed(3)}`)
        })
      }
      if (!xs.length) continue
      traces.push({
        x: xs, y: ys, type: 'bar', name: legend,
        marker: seriesBarArray(barStyles),
        // Grouped by the legend dimension, so bars for the same x sit side by
        // side and each one's dots land INSIDE it rather than between them.
        offsetgroup: L.key, legendgroup: L.key,
        error_y: errorBarStyle(style, plotTheme().font, es),
        hovertemplate: `${legend}<br>%{x}: %{y:.3f}<extra></extra>`,
      })
      traces.push({
        x: dX, y: dY, type: 'scatter', mode: 'markers', name: `${legend} reps`,
        offsetgroup: L.key, legendgroup: L.key, showlegend: false,
        marker: seriesMarkerArray(dotStyles, 1),
        text: dT, hovertemplate: '%{text}<extra></extra>',
      })
    }

    /*
     * WHICH TEST, decided from the series and not from a menu.
     *
     * Across conditions with one filter the samples are independent runs:
     * unpaired. Across filters within one condition they are the SAME runs
     * measured two ways: paired. A chart holding both at once contains a
     * mixture of the two, and a single Holm-adjusted family over that mixture
     * is not a correction of anything — so it is refused with the way out
     * named, rather than quietly run as Welch.
     */
    const cids = new Set(visible.map(s => s.conditionId))
    const fids = new Set(visible.map(s => s.filterId))
    let groups: { name: string; values: number[] }[] = []
    let paired = false
    let refuse: string | null = null
    if (cids.size === 1 && fids.size > 1) {
      paired = true
      groups = visible.map(s => ({
        name: filterOf(s.filterId)?.name || s.label,
        // Ordered by replica index so position i is the same run in every
        // group — the pairing is positional, and comparePaired trusts it.
        values: (valueOf.get(s.id) || []).sort((a, b) => a.index - b.index)
                                         .map(v => v.value),
      }))
    } else if (fids.size === 1 && cids.size > 1) {
      groups = visible.map(s => ({
        name: conditions.find(c => c.id === s.conditionId)?.name || s.label,
        values: (valueOf.get(s.id) || []).map(v => v.value),
      }))
    } else if (cids.size > 1 && fids.size > 1) {
      refuse = `This graph holds ${fids.size} filters across ${cids.size} `
        + `conditions, so some comparisons on it are paired (same replicas, `
        + `different filters) and others are not (different replicas, same `
        + `filter). Those need different tests and cannot share one `
        + `multiple-comparison correction. Hide series until the graph shows `
        + `either one filter across conditions, or one condition across `
        + `filters.`
    }

    return { active: true, traces, ylabel, groups, paired, refuse, notes,
             dropped: [...new Set(dropped)] }
  }, [mode, model.series, model.activeFilters, model.groupBy, model.labels,
      conditions, byKey, isExcluded, style])

  /** The paired or unpaired comparison for the multi-series chart. */
  const multiComparison = useMemo(() => {
    if (!multi.groups.length) return null
    return multi.paired
      ? comparePaired(multi.groups, isPairedTest(statTest) ? statTest : 'pairedt')
      : compareGroups(multi.groups, isPairedTest(statTest) ? 'welch' : statTest)
  }, [multi.groups, multi.paired, statTest])

  // Layout is derived from the style object — the style->layout mapping
  // lives in PlotStyleControls so it's defined once, next to the controls.
  /**
   * Each panel's value at the marker.
   *
   * Nearest SAMPLE, not an interpolation: these are sampled trajectories, and a
   * value invented between two frames is not a measurement anyone made. The
   * frames are close enough together that the nearest one is the honest answer.
   */
  const valuesAtCursor = useMemo(() => {
    if (mode !== 'together' || cursorNs === null) return []
    return together.panels.map((pn, i) => {
      const tr = together.traces[i]
      let value: number | null = null
      if (tr) {
        const xs: number[] = tr.x || []
        const ys: number[] = (tr.customdata as number[]) || tr.y || []
        let best = -1, bestD = Infinity
        for (let k = 0; k < xs.length; k++) {
          const d = Math.abs(xs[k] - cursorNs)
          if (d < bestD) { bestD = d; best = k }
        }
        if (best >= 0) value = ys[best]
      }
      return { label: pn.label, unit: pn.unit, colour: pn.colour, value }
    })
  }, [mode, cursorNs, together])

  const layout = (defX: string, defY: string): any =>
    styledLayout(style, defX, defY, {
      // Includes the panel count and layout: Plotly reuses axis state across
      // re-renders with the same uirevision, so adding a panel would otherwise
      // leave the previous geometry behind.
      uirevision: `${mode}-${metricA}-${metricB}-${together.panels.length}`
                 + `-${togetherLayout}-${together.axisToken}`,
    })
  const cfg = styledConfig(style)

  /**
   * Click a point on a replica trace and open THAT frame in the 3D view.
   *
   * The reason this exists: a spike at 345 ns in repeat 5 is a question about
   * one moment, and the reference structure — the thing the viewer otherwise
   * shows — is by construction not that moment. Only offered on the individual
   * replica traces, because a mean line does not correspond to any frame that
   * was ever simulated.
   */
  const openFrame = (e: any) => {
    // In repeat detail a click sets the TIME MARKER instead of jumping straight
    // to a structure: the mode exists to read several panels at one moment, so
    // the first click should line that moment up across them. Opening the
    // structure is then a deliberate second action.
    if (mode === 'together') {
      const pt = e?.points?.[0]
      if (pt && Number.isFinite(Number(pt.x))) setCursorNs(Number(pt.x))
      return
    }
    if (mode !== 'overlay') return
    const pt = e?.points?.[0]
    const meta = pt?.data?.meta
    if (!meta?.conditionId) return
    setStructureFrame({
      conditionId: meta.conditionId,
      conditionName: meta.conditionName || '',
      replicaIndex: meta.replicaIndex,
      timeNs: Number(pt.x),
      label: meta.metricKey ? metricLabel(meta.metricKey) : '',
      includeSolvent: false,
    })
    setRequestedTab('structure')
  }

  /*
   * A RECORD keyed by Mode, not a ternary chain ending in a catch-all.
   *
   * The chain used to end `: bars`, so a mode with no branch silently rendered
   * the bar chart — which is exactly what happened when Repeat detail's wiring
   * was lost: its controls appeared, the plot stayed on Averages, and nothing
   * anywhere reported a problem. TypeScript requires every key of Mode here, so
   * the same omission is now a build error instead of a wrong plot.
   *
   * Every value is an already-computed memo result, so building the record
   * costs nothing beyond the object literal.
   */
  const tracesByMode: Record<Mode, any[]> = {
    overlay: overlay.traces,
    together: together.traces,
    correlation: corr.traces,
    crosscorr: xcorr.traces,
    filtered: multi.active ? multi.traces : filtered.traces,
    bars,
  }
  const xLabelByMode: Record<Mode, string> = {
    overlay: byKey[metricA]?.[0]?.xlabel || '',
    together: 'Time (ns)',
    correlation: metricLabel(metricA),
    crosscorr: `lag (${xcorr.dtNs ? 'ns' : 'frames'}) — positive: ${metricB} leads`,
    filtered: '',
    bars: '',
  }
  const yLabelByMode: Record<Mode, string> = {
    overlay: byKey[metricA]?.[0]?.ylabel || '',
    together: togetherLayout === 'overlay'
      ? (togetherNorm === 'zscore' ? 'z-score (SD from each mean)' : 'normalised 0–1')
      : '',
    correlation: metricLabel(metricB),
    crosscorr: 'normalised cross-correlation',
    filtered: multi.active ? multi.ylabel
      : filterOutput === 'fraction'
        ? 'fraction of frames passing' : `mean ${targetMetric} (filtered)`,
    bars: `mean ${metricLabel(metricA)}`,
  }

  const dataForMode = tracesByMode[mode]
  const defX = xLabelByMode[mode]
  const defY = yLabelByMode[mode]
  /**
   * Does the pinned axis range actually contain any of the plotted data?
   *
   * A plot with axes and no data gives no clue why. This is the one failure
   * where the cause is invisible from the figure: the range is a setting made
   * once, in another mode, against another metric, and it silently survives
   * every change of metric afterwards. Saying so — with a way out — turns a
   * dead end into a fix.
   */
  const rangeHidesData = useMemo(() => {
    const xr = (style.xmin && style.xmax) ? [+style.xmin, +style.xmax] : null
    const yr = (style.ymin && style.ymax) ? [+style.ymin, +style.ymax] : null
    if (!xr && !yr) return null
    const traces = (dataForMode || []) as any[]
    let anyPoint = false, anyVisible = false
    for (const t of traces) {
      const xs = (t?.x || []) as number[]
      const ys = (t?.y || []) as number[]
      const n = Math.max(xs.length, ys.length)
      for (let i = 0; i < n; i++) {
        const xv = xs[i], yv = ys[i]
        if (!Number.isFinite(xv) && !Number.isFinite(yv)) continue
        anyPoint = true
        const okX = !xr || !Number.isFinite(xv) || (xv >= xr[0] && xv <= xr[1])
        const okY = !yr || !Number.isFinite(yv) || (yv >= yr[0] && yv <= yr[1])
        if (okX && okY) { anyVisible = true; break }
      }
      if (anyVisible) break
    }
    if (!anyPoint || anyVisible) return null
    return { xr, yr }
  }, [dataForMode, style.xmin, style.xmax, style.ymin, style.ymax])

  const lay = layout(defX, defY)
  // The multi-series chart groups bars by the legend dimension via
  // offsetgroup, so they must be grouped rather than overlaid.
  if (mode==='filtered') lay.barmode = multi.active ? 'group'
    : (filterBarStyle==='per_condition') ? 'overlay' : 'group'
  // Shaded gating stretches sit BELOW the data (layer: 'below' on each shape).
  if (mode==='overlay' && overlay.shapes.length) lay.shapes = overlay.shapes
  // For single-metric bar+dot, overlay so dots sit on the bar; for multi-metric
  // grouped comparison, group the bars.
  if (mode==='bars') lay.barmode = (barMetrics.length > 1) ? 'group' : 'overlay'
  /*
   * Repeat detail builds its own axes — one y-axis per panel, all sharing x.
   *
   * MERGED, not assigned over the top. Object.assign replaced lay.xaxis and
   * lay.yaxis wholesale, which silently threw away the axis ranges the user had
   * typed in Plot Settings. That had two consequences, and the second was far
   * worse than the first: the ranges did nothing here, AND they stayed in the
   * shared style object, so every other mode kept applying them — drawing its
   * data outside a pinned window and showing axes with nothing on them.
   *
   * The x range is re-applied because x is time in both layouts and that is
   * exactly the axis anyone wants to pin. The y range is only meaningful when
   * the panels share an axis; across stacked panels in different units a single
   * pair of limits belongs to none of them, so it is ignored and said so.
   */
  if (mode==='together') {
    const userX = lay.xaxis?.range
    const userY = lay.yaxis?.range
    Object.assign(lay, together.layout)
    /*
     * The axis panel beside the plot wins over the X range in Plot Settings
     * when it has an opinion. Both are typed by hand, so neither is obviously
     * senior — but only one of them is displayed next to the plot as the range
     * in force, and a panel that states a range it is not applying is worse
     * than either precedence.
     */
    if (userX && repeatXLock.mode === 'auto' && lay.xaxis) lay.xaxis.range = userX
    if (userY && togetherLayout === 'overlay' && lay.yaxis) lay.yaxis.range = userY
  }
  if (mode==='crosscorr') lay.shapes = [
    { type:'line', x0:0, x1:0, y0:-1, y1:1, line:{color:'#888',dash:'dot',width:1} },
    { type:'line', xref:'paper', x0:0, x1:1, y0:0, y1:0, line:{color:'#888',dash:'dot',width:1} },
  ]

  // Empty state — rendered AFTER every hook has run, so hook order stays stable
  // across the async load of stored results.
  if (keys.length === 0) {
    return (
      <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <div style={{ textAlign:'center', color:'var(--text-muted)', maxWidth:340 }}>
          <GitCompare size={40} style={{ margin:'0 auto 12px', opacity:0.25 }} />
          <div style={{ fontSize:15, fontWeight:600, marginBottom:6, color:'var(--text-secondary)' }}>Nothing to plot yet</div>
          <div style={{ fontSize:12, lineHeight:1.6 }}>
            Run a per-frame analysis (RMSD, mindist, Rg, SASA…) and it'll appear here.
            Analyses hidden in the Results tab are excluded — unhide them to plot.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
      <div style={{ flex:1, overflow:'auto', padding:'24px 28px' }}>
        {/*
          Repeat detail is uncapped: it has given up the 230px replica panel and
          the legend, and capping it at a column width would simply hand that
          space back to the margin instead of to the time axis it was taken for.
          The axis panel then sits against the right edge of the window.
        */}
        <div style={{ maxWidth: mode==='together' ? 'none' : 840 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:16, flexWrap:'wrap' }}>
            <h2 style={{ marginRight:'auto' }}>Plot Studio</h2>
            {([['overlay','Overlay',<TrendingUp size={13}/>],
               ['together','Repeat detail',<Layers size={13}/>],
               ['correlation','Correlation',<GitCompare size={13}/>],
               ['crosscorr','Cross-corr',<Activity size={13}/>],
               ['bars','Averages',<BarChart3 size={13}/>],
               ['filtered','Filtered',<Radar size={13}/>]] as const).map(([m,label,icon]) => (
              <button key={m} onClick={()=>setMode(m as Mode)} style={{
                display:'flex',alignItems:'center',gap:6,padding:'6px 12px',borderRadius:'var(--radius)',fontSize:12,
                background: mode===m?'var(--accent)':'var(--bg-surface)', color: mode===m?'#fff':'var(--text-secondary)',
                border:`1px solid ${mode===m?'transparent':'var(--border)'}`, fontWeight: mode===m?600:400,
              }}>{icon} {label}</button>
            ))}
          </div>

          {/* Metric selectors + mode options */}
          <div style={{ display:'flex', gap:12, marginBottom:14, flexWrap:'wrap', alignItems:'flex-end' }}>
            {mode!=='together' && (
            <div>
              <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>
                {(mode==='correlation'||mode==='crosscorr') ? 'Metric X' : 'Metric'}
              </label>
              <MetricSelect value={metricA} onChange={setMetricA} keys={keys}
                            labelFor={metricLabel} favourites={favouriteMetrics}
                            onToggleFavourite={toggleFavouriteMetric} />
            </div>
            )}

            {mode==='together' && (
              <>
                <div>
                  <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Condition</label>
                  <select value={togetherCond || together.conditions[0]?.id || ''}
                          onChange={e=>{ setTogetherCond(e.target.value); setTogetherRep(null) }}
                          style={{ fontSize:12 }}>
                    {together.conditions.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Repeat</label>
                  <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                    <button onClick={()=>{
                      const i = together.repeats.indexOf(togetherRep ?? together.repeats[0])
                      if (i > 0) setTogetherRep(together.repeats[i-1])
                    }} disabled={!together.repeats.length} style={stepBtn}>◀</button>
                    <select value={String(togetherRep ?? together.repeats[0] ?? '')}
                            onChange={e=>setTogetherRep(Number(e.target.value))}
                            style={{ fontSize:12 }} disabled={!together.repeats.length}>
                      {together.repeats.map(n=><option key={n} value={n}>rep {n}</option>)}
                    </select>
                    <button onClick={()=>{
                      const i = together.repeats.indexOf(togetherRep ?? together.repeats[0])
                      if (i >= 0 && i < together.repeats.length-1) setTogetherRep(together.repeats[i+1])
                    }} disabled={!together.repeats.length} style={stepBtn}>▶</button>
                  </div>
                </div>
                <div>
                  <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Layout</label>
                  <select value={togetherLayout} onChange={e=>setTogetherLayout(e.target.value as any)}
                          style={{ fontSize:12 }}
                          title={'Stacked keeps each analysis in its own units. Overlaid puts '
                               + 'them on one axis, which requires normalising away the units '
                               + 'first — otherwise the largest one flattens the rest.'}>
                    <option value="stacked">stacked panels</option>
                    <option value="overlay">overlaid (normalised)</option>
                  </select>
                </div>
                {togetherLayout==='overlay' && (
                  <div>
                    <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Scale</label>
                    <select value={togetherNorm} onChange={e=>setTogetherNorm(e.target.value as any)}
                            style={{ fontSize:12 }}>
                      <option value="zscore">z-score (SD from its own mean)</option>
                      <option value="minmax">0–1 (own min to max)</option>
                    </select>
                  </div>
                )}
              </>
            )}
            {(mode==='correlation'||mode==='crosscorr') && (
              <div>
                <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Metric Y</label>
                <MetricSelect value={metricB} onChange={setMetricB} keys={keys}
                              labelFor={metricLabel} favourites={favouriteMetrics}
                              onToggleFavourite={toggleFavouriteMetric} />
              </div>
            )}
            {mode==='crosscorr' && (
              <div>
                <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Compute</label>
                <select value={xcorrBasis} onChange={e=>setXcorrBasis(e.target.value as any)}
                        style={{ fontSize:12 }}
                        title={'Per repeat correlates within each run, where the events '
                             + 'actually co-occur, then pools. Averaging first smears events '
                             + 'that happen at different times in different runs.'}>
                  <option value="perrep">per repeat, then pool</option>
                  <option value="mean">repeats averaged first</option>
                </select>
              </div>
            )}

            {mode==='correlation' && (
              <div>
                <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Each dot is</label>
                <select value={corrPoints} onChange={e=>setCorrPoints(e.target.value as any)}
                        style={{ fontSize:12 }}
                        title={'Mean: repeats are averaged first, so one dot per time point. '
                             + 'Pooled: every repeat contributes its own points. '
                             + 'Per repeat: pooled points, with a separate fit and r for each run.'}>
                  <option value="mean">a time point (repeats averaged)</option>
                  <option value="pooled">a frame of one repeat (pooled)</option>
                  <option value="perrep">a frame, with per-repeat fits</option>
                </select>
              </div>
            )}

            {mode==='correlation' && (
              <div>
                <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Fit</label>
                <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, cursor:'pointer' }}>
                  <input type="checkbox" checked={showFit}
                         onChange={e=>setShowFit(e.target.checked)}
                         style={{ accentColor:'var(--accent)' }} />
                  line of best fit
                </label>
              </div>
            )}

            {(mode==='bars' || mode==='correlation' || mode==='crosscorr') && (
              <div>
                <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Stats</label>
                <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, cursor:'pointer' }}>
                  <input type="checkbox" checked={showStats}
                         onChange={e=>setShowStats(e.target.checked)}
                         style={{ accentColor:'var(--accent)' }} />
                  show statistics
                </label>
              </div>
            )}

            {mode==='overlay' && (
              <>
                <div>
                  <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Show</label>
                  <select value={lineMode} onChange={e=>setLineMode(e.target.value as LineMode)} style={{ fontSize:12 }}>
                    <option value="both">repeats + mean ± SD</option>
                    <option value="meansd">mean ± SD only</option>
                    <option value="individual">individual repeats</option>
                  </select>
                </div>
                <div>
                  <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Colour by</label>
                  <select value={colorMode} onChange={e=>setColorMode(e.target.value as ColorMode)} style={{ fontSize:12 }}>
                    <option value="condition">condition (shaded)</option>
                    <option value="repeat">repeat (palette)</option>
                    <option value="time">time gradient</option>
                  </select>
                </div>
                {/*
                  Beside "Colour by", not buried in the legend section of Plot
                  Settings — the need for it arises the moment you colour the
                  runs, and that is here.
                */}
                <div>
                  <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Legend</label>
                  <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12,
                                  height:24, color: style.showLegend ? 'var(--text-secondary)' : 'var(--text-muted)' }}
                         title={style.showLegend
                           ? 'List every replica in the legend, grouped under its condition'
                           : 'The legend is switched off in Plot Settings'}>
                    <input type="checkbox" checked={style.legendReplicas}
                           disabled={!style.showLegend}
                           onChange={e=>setStyle({ ...style, legendReplicas: e.target.checked })}
                           style={{ accentColor:'var(--accent)' }} />
                    name each repeat
                  </label>
                </div>
                {model.filters.length > 0 && (
                  <div>
                    <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>
                      Gate by filter
                    </label>
                    <select value={model.gateFilterId}
                            onChange={e=>model.setGateFilterId(e.target.value)}
                            style={{ fontSize:12, maxWidth:220 }}
                            title={'Restrict this plot to the frames a saved filter '
                                 + 'passes — per replica, since the runs do not enter '
                                 + 'the state at the same time.'}>
                      <option value="">— no filter —</option>
                      {model.filters.map(f=>(
                        <option key={f.id} value={f.id} disabled={!keys.includes(f.metric)}>
                          {f.name}{keys.includes(f.metric) ? '' : ' (metric not loaded)'}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}
            {mode==='crosscorr' && (
              <div>
                <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Max lag</label>
                <input type="number" value={maxLag} onChange={e=>setMaxLag(+e.target.value||500)} style={{ width:80, fontSize:12 }} />
              </div>
            )}
            {mode==='bars' && (
              <div>
                <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Bar style</label>
                <select value={barStyle} onChange={e=>setBarStyle(e.target.value as any)} style={{ fontSize:12 }}>
                  <option value="per_condition">condition mean + replica dots</option>
                  <option value="per_replica">one bar per replica</option>
                </select>
              </div>
            )}
          </div>

          {/* Multi-metric picker for comparing several analyses as grouped bars */}
          {mode==='bars' && barStyle==='per_condition' && keys.length > 1 && (
            <div style={{ marginBottom:14, padding:'10px 12px', background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)' }}>
              <div style={{ fontSize:11, color:'var(--text-secondary)', marginBottom:6 }}>
                Compare multiple analyses side by side (leave empty to show just the metric above):
              </div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
                {keys.map(k => {
                  const on = barMetrics.includes(k)
                  return (
                    <button key={k} onClick={() => setBarMetrics(p => on ? p.filter(x=>x!==k) : [...p, k])} style={{
                      padding:'4px 10px', borderRadius:6, fontSize:11,
                      background: on ? 'var(--accent)' : 'var(--bg-elevated)',
                      color: on ? '#fff' : 'var(--text-secondary)',
                      border:`1px solid ${on ? 'transparent' : 'var(--border)'}`,
                    }}>{k}</button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Several saved filters on one chart — Prism's "Data on graph". */}
          {mode==='filtered' && (
            <SeriesPanel model={model} keys={keys} labelFor={metricLabel}
                         conditions={conditions} style={style} />
          )}

          {/* The original single-filter controls, still the path when no saved
              filter is on the graph. Hidden once the series model takes over,
              because two filters defining one chart is exactly the confusion
              this feature replaces. */}
          {mode==='filtered' && !multi.active && (
            <div style={{ marginBottom:14, padding:'12px 14px', background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)' }}>
              <div style={{ display:'flex', gap:10, alignItems:'flex-end', flexWrap:'wrap', marginBottom:10 }}>
                <div>
                  <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Keep frames where</label>
                  <MetricSelect value={filterMetric} onChange={setFilterMetric} keys={keys}
                                labelFor={k=>k} favourites={favouriteMetrics}
                                onToggleFavourite={toggleFavouriteMetric} />
                </div>
                <select value={filterOp} onChange={e=>setFilterOp(e.target.value as any)} style={{ fontSize:12 }}>
                  <option value=">">&gt;</option><option value="<">&lt;</option>
                  <option value=">=">&ge;</option><option value="<=">&le;</option>
                </select>
                <input value={filterThreshold} onChange={e=>setFilterThreshold(e.target.value)} style={{ width:70, fontSize:12, fontFamily:'var(--font-mono)' }} />
                <input type="range" min={0} max={5} step={0.05} value={parseFloat(filterThreshold)||0}
                  onChange={e=>setFilterThreshold(e.target.value)} style={{ width:140 }} title="drag to adjust threshold" />
              </div>
              <div style={{ display:'flex', gap:10, alignItems:'flex-end', flexWrap:'wrap' }}>
                <div>
                  <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Report</label>
                  <select value={filterOutput} onChange={e=>setFilterOutput(e.target.value as any)} style={{ fontSize:12 }}>
                    <option value="fraction">fraction of frames passing (contact time)</option>
                    <option value="conditional_mean">mean of another metric over those frames</option>
                  </select>
                </div>
                {filterOutput==='conditional_mean' && (
                  <div>
                    <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Metric to average</label>
                    <MetricSelect value={targetMetric} onChange={setTargetMetric} keys={keys}
                                  labelFor={k=>k} favourites={favouriteMetrics}
                                  onToggleFavourite={toggleFavouriteMetric} />
                  </div>
                )}
                <div>
                  <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Bars</label>
                  <select value={filterBarStyle} onChange={e=>setFilterBarStyle(e.target.value as any)} style={{ fontSize:12 }}>
                    <option value="per_condition">condition mean + dots</option>
                    <option value="per_replica">one bar per replica</option>
                  </select>
                </div>
              </div>
              <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:8, lineHeight:1.5 }}>
                Works on per-frame metrics sharing the same frames. Example: keep frames where a
                mindist &gt; 1 nm, then report the fraction (how long they're apart) or the mean of
                another distance over just those frames.
              </div>
            </div>
          )}

          {/* Plot */}
          <div style={{ background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:16 }}>
            {rangeHidesData && (
              <div style={{
                marginBottom: 8, padding: '9px 12px', borderRadius: 6, fontSize: 12,
                background: 'rgba(247,127,79,0.12)', border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              }}>
                <span>
                  ⚠ <strong>The plot is empty because of a fixed axis range</strong>,
                  not because the data is missing. Nothing falls inside
                  {rangeHidesData.xr ? ` X ${rangeHidesData.xr[0]}–${rangeHidesData.xr[1]}` : ''}
                  {rangeHidesData.xr && rangeHidesData.yr ? ' and' : ''}
                  {rangeHidesData.yr ? ` Y ${rangeHidesData.yr[0]}–${rangeHidesData.yr[1]}` : ''}.
                  Ranges are shared by every mode, so one set for another metric
                  stays in force here.
                </span>
                <button
                  onClick={() => setStyle({ ...style, xmin:'', xmax:'', ymin:'', ymax:'' })}
                  style={{ padding:'4px 11px', borderRadius:5, fontSize:11,
                           background:'var(--accent)', color:'#fff',
                           border:'1px solid transparent', fontWeight:600 }}
                >Clear axis ranges</button>
              </div>
            )}

            {mode==='overlay' && overlay.gate && (
              <div style={{ marginBottom: 8, padding: '9px 12px', borderRadius: 6,
                            fontSize: 11, lineHeight: 1.55,
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border)' }}>
                <strong>Gated by “{overlay.gate.name}”</strong> —{' '}
                {describeFilter(overlay.gate, metricLabel).replace(/^fraction of frames /, '')}
                .{' '}
                {overlay.shadeMode
                  ? 'The whole trace is drawn and the shaded stretches are where '
                    + 'MORE THAN HALF the runs of that condition pass. Individual '
                    + 'runs enter and leave at different times, so no single band '
                    + 'can mark them all.'
                  : 'Only the passing frames are drawn; the line breaks elsewhere '
                    + 'rather than joining across the gap, which would compress '
                    + 'the time axis.'}
                {!overlay.shadeMode && overlay.coverage && (
                  <> The mean rests on {overlay.coverage.min === overlay.coverage.max
                      ? `${overlay.coverage.min}`
                      : `${overlay.coverage.min}–${overlay.coverage.max}`} of{' '}
                    {overlay.coverage.of} runs depending on where you read it, and
                    is broken where fewer than two pass.</>
                )}
                {overlay.problems.map((p, i) => (
                  <div key={i} style={{ marginTop: 5, color: 'var(--orange, #f79f4f)' }}>⚠ {p}</div>
                ))}
              </div>
            )}

            {mode==='filtered' && multi.active && (multi.notes.length > 0 || multi.dropped.length > 0) && (
              <div style={{ marginBottom: 8, padding: '9px 12px', borderRadius: 6,
                            fontSize: 11, lineHeight: 1.55,
                            background: 'rgba(247,159,79,0.10)',
                            border: '1px solid var(--border)' }}>
                {multi.notes.map((n, i) => <div key={i}>⚠ {n}</div>)}
                {multi.dropped.length > 0 && (
                  <div style={{ marginTop: multi.notes.length ? 5 : 0 }}>
                    Dropped so every series rests on the same runs:{' '}
                    {multi.dropped.join('; ')}.
                  </div>
                )}
              </div>
            )}

            {mode==='together' && togetherLayout==='stacked'
              && style.ymin && style.ymax && (
              <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                The Y range in Plot Settings is not applied to stacked panels —
                each panel is in its own units, so one pair of limits cannot
                belong to all of them. It applies in the overlaid layout, and the
                X (time) range applies in both.
              </div>
            )}

            {/*
              The axis panel sits BESIDE the plot, so `minWidth: 0` on the plot
              half is load-bearing: a flex item defaults to its content's
              min-width, and Plotly's SVG reports one wide enough to push the
              panel off the edge instead of shrinking.
            */}
            <div style={{ display:'flex', gap:12, alignItems:'flex-start' }}>
              <div style={{ flex:1, minWidth:0 }}>
                <Plot key={theme} data={dataForMode} layout={lay} config={cfg} useResizeHandler style={{ width:'100%' }}
                      onClick={openFrame} />
              </div>
              {mode==='together' && together.axisRows.length > 1 && (
                <RepeatAxisPanel
                  rows={together.axisRows}
                  nRepeats={together.repeats.length}
                  nConditions={together.conditions.length}
                  yApplies={togetherLayout === 'stacked'}
                  onChange={(key, patch) => key === '__x__'
                    ? setRepeatXLock(patch)
                    : setRepeatAxisLock(key, patch)}
                />
              )}
            </div>

            {/* Statistics, only where they mean something.
                A bar chart compares conditions across replicas, which is a
                question a test can answer. An overlay of time series is not —
                there is no grouping to compare, and a test over frames would
                treat 5000 correlated points as 5000 observations. */}
            {showStats && mode==='bars' && (
              <StatsPanel comparison={comparison} test={statTest}
                          onTestChange={setStatTest}
                          unit={unitOfLabel(byKey[metricA]?.[0]?.ylabel)} />
            )}
            {showStats && mode==='filtered' && multi.active && (
              multi.refuse ? (
                <div style={{ marginTop:10, padding:'10px 12px', borderRadius:6,
                              fontSize:11, lineHeight:1.6,
                              background:'var(--bg-surface)',
                              border:'1px solid var(--border)' }}>
                  <strong style={{ fontSize:12 }}>Statistics</strong>
                  <div style={{ marginTop:6, color:'var(--text-secondary)' }}>
                    {multi.refuse}
                  </div>
                </div>
              ) : multiComparison ? (
                <StatsPanel comparison={multiComparison}
                            test={multi.paired
                              ? (isPairedTest(statTest) ? statTest : 'pairedt')
                              : (isPairedTest(statTest) ? 'welch' : statTest)}
                            onTestChange={setStatTest}
                            paired={multi.paired} />
              ) : null
            )}
            {mode==='together' && (
              <RepeatDetailPanel
                allKeys={keys.filter(k => (byKey[k]||[]).some((r:any)=>/time/i.test(r?.xlabel||'')))}
                labelFor={metricLabel}
                favourites={favouriteMetrics}
                onToggleFavourite={toggleFavouriteMetric}
                selected={togetherMetrics}
                onSelect={setTogetherMetrics}
                panels={together.panels}
                skipped={together.skipped}
                cursorNs={cursorNs}
                onCursor={setCursorNs}
                span={together.span}
                valuesAt={valuesAtCursor}
                repLabel={`${together.conditions.find(c=>c.id===(togetherCond||together.conditions[0]?.id))?.name || ''} rep ${togetherRep ?? together.repeats[0] ?? ''}`}
                onOpenStructure={() => {
                  const cid = togetherCond || together.conditions[0]?.id
                  const rep = togetherRep ?? together.repeats[0]
                  if (!cid || rep === undefined || cursorNs === null) return
                  setStructureFrame({
                    conditionId: cid,
                    conditionName: together.conditions.find(c=>c.id===cid)?.name || '',
                    replicaIndex: rep,
                    timeNs: cursorNs,
                    label: together.panels.map(p=>p.label).join(' · '),
                    includeSolvent: false,
                  })
                  setRequestedTab('structure')
                }}
              />
            )}

            {showStats && mode==='crosscorr' && (
              <XCorrRepeatStats perRep={xcorr.perRep} conditions={xcorr.conditions}
                                unit={xcorr.dtNs ? 'ns' : 'frames'} basis={xcorrBasis} />
            )}
            {showStats && mode==='correlation' && (
              <CorrelationStats overall={corr.overall} spearman={corr.overallSpearman}
                                fits={corr.fits} basis={corrPoints}
                                nPoints={corr.nPoints} perRep={corr.perRep}
                                droppedReps={corr.droppedReps}
                                unitX={unitOfLabel(byKey[metricA]?.[0]?.ylabel)}
                                unitY={unitOfLabel(byKey[metricB]?.[0]?.ylabel)} />
            )}
          </div>

          {/* Publication styling — extracted into its own component */}
          <PlotStyleControls style={style} onChange={setStyle}
            open={customOpen} onToggle={() => setCustomOpen(o => !o)}
            series={{
              options: styleSeries.map(sr => ({ id: sr.id, label: sr.label })),
              selected: styleSeries.some(sr => sr.id === model.editing) ? model.editing : '',
              onSelect: model.setEditing,
              overrides: model.seriesStyles[model.editing] || {},
              onPatch: patch => model.setSeriesStyle(model.editing, patch),
              onClearField: model.clearSeriesStyleField,
              onClearOne: field => {
                const next = { ...(model.seriesStyles[model.editing] || {}) }
                delete next[field]
                model.resetSeriesStyle(model.editing)
                if (Object.keys(next).length) model.setSeriesStyle(model.editing, next)
              },
              onReset: () => model.resetSeriesStyle(model.editing),
            }} />
        </div>
      </div>

      {/*
        Hidden in Repeat detail, which picks ONE repeat from the dropdown above
        the plot. The panel's job there was to control which replicas are drawn,
        and in this mode exactly one is — so it was 230px of screen spent
        restating the choice already made, directly at the expense of the time
        axis beside it.

        Its exclusions still apply: a replica banned in another mode stays out
        of the repeat list and out of the locked axis extents. This only removes
        the place to CHANGE that while in Repeat detail.
      */}
      {mode!=='together' && (
      <div style={{ width:230, background:'var(--bg-panel)', borderLeft:'1px solid var(--border)', overflow:'auto', flexShrink:0, padding:'16px 12px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
          <h3>Replicas</h3>
          {(excluded.size>0||hidden.size>0) && (
            <button onClick={()=>{setExcluded(new Set());setHidden(new Set());setHighlight(null)}} title="Reset"
              style={{ padding:3, background:'transparent', color:'var(--text-muted)' }}><RotateCcw size={12}/></button>
          )}
        </div>
        <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom:12, lineHeight:1.5 }}>
          Click to highlight. Eye hides. Ban excludes from mean/SD (recomputes live).
          The eye and ban beside a condition name do all of its repeats at once.
          {mode==='overlay' && <> The swatch sets that replica's line colour, overriding
          the <strong>colour by</strong> rule.</>}
        </div>
        {mode==='overlay' && Object.keys(repeatColours).length > 0 && (
          <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom:12,
                        display:'flex', alignItems:'center', gap:6 }}>
            {Object.keys(repeatColours).length} colour
            {Object.keys(repeatColours).length === 1 ? '' : 's'} set by hand
            <button onClick={clearRepeatColours} title="Return every replica to the colour-by rule"
              style={{ padding:'1px 6px', borderRadius:4, fontSize:10,
                       background:'var(--bg-elevated)', color:'var(--text-secondary)',
                       border:'1px solid var(--border)', cursor:'pointer' }}>
              reset all
            </button>
          </div>
        )}
        {uniqMetrics.map(t => (
          <div key={t} style={{ marginBottom:14 }}>
            {uniqMetrics.length>1 && <div style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase', marginBottom:4 }}>{t}</div>}
            {(byKey[t]||[]).map(r => (
              <div key={r.condition_id} style={{ marginBottom:8 }}>
                <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, fontWeight:600, marginBottom:3 }}>
                  <span style={{ width:8, height:8, borderRadius:'50%', background:r.colour, flexShrink:0 }} />
                  <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis',
                                 whiteSpace:'nowrap' }} title={r.condition_name}>
                    {r.condition_name}
                  </span>
                  {/*
                    The bulk buttons show the ACTION, not the state — the
                    opposite of the replica rows below, where the icon is the
                    state. A condition of ten runs has three aggregate states,
                    not two, so there is no single state for one icon to show;
                    the count beside them says where things stand instead.
                  */}
                  {(() => {
                    const keys = (r.replicas||[])
                      .map(rep => repKey(t, r.condition_id!, rep.index))
                    if (keys.length < 2) return null
                    const nShown = keys.filter(k => !hidden.has(k)).length
                    const allHidden = nShown === 0
                    const allExcluded = keys.every(k => excluded.has(k))
                    const bulk = (active:boolean):React.CSSProperties => ({
                      padding:2, background:'transparent', border:'none',
                      cursor:'pointer', lineHeight:1,
                      color: active ? 'var(--accent-bright)' : 'var(--text-muted)',
                    })
                    return (
                      <>
                        <span style={{ fontSize:10, fontWeight:400,
                                       fontFamily:'var(--font-mono)',
                                       color:'var(--text-muted)' }}
                              title={`${nShown} of ${keys.length} shown`}>
                          {nShown}/{keys.length}
                        </span>
                        <button
                          onClick={()=>setMany(hidden,setHidden,keys,!allHidden)}
                          title={allHidden
                            ? `Show all ${keys.length} repeats of ${r.condition_name}`
                            : `Hide all ${keys.length} repeats of ${r.condition_name} `
                              + '— then click the ones you want back'}
                          style={bulk(allHidden)}>
                          {allHidden ? <Eye size={12}/> : <EyeOff size={12}/>}
                        </button>
                        <button
                          onClick={()=>setMany(excluded,setExcluded,keys,!allExcluded)}
                          title={allExcluded
                            ? `Put all ${keys.length} repeats of ${r.condition_name} back into the mean`
                            : `Exclude all ${keys.length} repeats of ${r.condition_name} from the mean`}
                          style={{ ...bulk(allExcluded),
                                   color: allExcluded ? 'var(--red)' : 'var(--text-muted)' }}>
                          <Ban size={12}/>
                        </button>
                      </>
                    )
                  })()}
                </div>
                {(r.replicas||[]).map((rep, ri) => {
                  const k = repKey(t,r.condition_id!,rep.index)
                  const ex = excluded.has(k), hid = hidden.has(k), hi = highlight===k
                  /*
                   * The swatch shows the EFFECTIVE colour, not the override.
                   *
                   * Showing only overrides would leave every swatch empty
                   * until clicked, so the panel could not be used to read the
                   * graph's colours — which is most of what it is for. It is
                   * resolved exactly as the trace is, so the two cannot drift.
                   */
                  const ck = repeatColourKey(r.condition_id!, rep.index)
                  const over = repeatColours[ck]
                  const nReps = (r.replicas||[]).length
                  const eff = replicaLineColour({
                    override: over,
                    conditionColour: resolveSeriesStyle(
                      baseSeries(r.condition_id!), style, r.colour,
                      (byKey[t]||[]).indexOf(r)).colour,
                    mode: colorMode, repIndex: rep.index, repOrder: ri,
                    total: nReps, tFrac: ri/Math.max(1, nReps-1),
                  })
                  return (
                    <div key={k} style={{ display:'flex', alignItems:'center', gap:4, padding:'2px 4px', borderRadius:4,
                      background: hi?'var(--bg-hover)':'transparent', opacity: ex?0.4:1 }}>
                      {/*
                        Only in Overlay, which is the mode that draws one line
                        per replica. Bars and the scatters colour by CONDITION,
                        so a per-replica swatch there would be an affordance
                        that silently does nothing.
                      */}
                      {mode==='overlay' && (
                      <input type="color" value={toHexColour(eff)}
                        onChange={e=>setRepeatColour(ck, e.target.value)}
                        title={over ? `rep ${rep.index}: colour set by hand — use ✕ to go back to "${colorMode}"`
                                    : `rep ${rep.index}: following "${colorMode}". Pick a colour to fix it.`}
                        style={{ width:15, height:15, flexShrink:0, padding:0, cursor:'pointer',
                          borderRadius:3, background:'transparent',
                          border:`1px solid ${over?'var(--accent)':'var(--border)'}` }} />
                      )}
                      <span onClick={()=>setHighlight(hi?null:k)} style={{ flex:1, fontSize:11, cursor:'pointer',
                        color: hi?'var(--accent-bright)':'var(--text-secondary)', textDecoration: ex?'line-through':'none' }}>rep {rep.index}</span>
                      {mode==='overlay' && over && (
                        <button onClick={()=>setRepeatColour(ck,'')} title="Back to the colour-by rule"
                          style={{ padding:'0 2px', background:'transparent', color:'var(--text-muted)',
                                   border:'none', cursor:'pointer', fontSize:11, lineHeight:1 }}>✕</button>
                      )}
                      <button onClick={()=>toggle(hidden,setHidden,k)} title="Show/hide" style={{ padding:2, background:'transparent', color: hid?'var(--text-muted)':'var(--text-secondary)' }}>
                        {hid?<EyeOff size={11}/>:<Eye size={11}/>}
                      </button>
                      <button onClick={()=>toggle(excluded,setExcluded,k)} title="Exclude from mean" style={{ padding:2, background:'transparent', color: ex?'var(--red)':'var(--text-muted)' }}>
                        <Ban size={11}/>
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
      )}
    </div>
  )
}



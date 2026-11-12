/**
 * The graph's list of series, in ONE hook.
 *
 * CompareTab's own comments record that hook count is what broke a previous
 * release, and this feature wants filters, which filters are on the graph, how
 * the chart is grouped, which series are hidden and what they are called. As a
 * dozen useStates in that component it would be exactly the drift that caused
 * the breakage, so it is one custom hook called unconditionally at the top.
 *
 * WHAT IS DERIVED AND WHAT IS STORED
 * The series list is DERIVED — filters on the graph × conditions — rather than
 * stored. Storing it would mean reconciling it every time a condition appears
 * or a filter is deleted, and a stale series pointing at a filter that no
 * longer exists is a trace that silently plots nothing. Only the things that
 * cannot be derived are kept: which filters are on the graph, which series are
 * hidden, and any hand-typed labels.
 *
 * Filters and per-series styles live in the STORE, because they belong to the
 * project and must survive closing it.
 */
import { useState, useMemo, useCallback } from 'react'
import { useStore } from '../../store'
import { seriesId } from '../../lib/plotSeries'
import type { FilterDef, PlotSeries } from '../../lib/plotSeries'

export interface ConditionRef { id: string; name: string; colour: string }
export type GroupBy = 'condition' | 'filter'

/** What a series is called in the legend, which depends on how it is grouped. */
export function legendName(s: PlotSeries, groupBy: GroupBy,
                           filterName: string, conditionName: string,
                           custom?: string): string {
  if (custom) return custom
  // The axis already says one of the two; repeating it in every legend entry
  // is noise, and with 4 filters x 10 conditions it is 40 lines of it.
  return groupBy === 'condition' ? filterName : conditionName
}

export function useSeriesModel(conditions: ConditionRef[]) {
  const plotFilters = useStore(s => s.plotFilters)
  const addPlotFilter = useStore(s => s.addPlotFilter)
  const updatePlotFilter = useStore(s => s.updatePlotFilter)
  const removePlotFilter = useStore(s => s.removePlotFilter)
  const plotSeriesStyles = useStore(s => s.plotSeriesStyles)
  const setSeriesStyle = useStore(s => s.setSeriesStyle)
  const clearSeriesStyleField = useStore(s => s.clearSeriesStyleField)
  const resetSeriesStyle = useStore(s => s.resetSeriesStyle)

  const [onGraph, setOnGraph] = useState<string[]>([])
  const [groupBy, setGroupBy] = useState<GroupBy>('condition')
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set())
  const [labels, setLabels] = useState<Record<string, string>>({})
  /** Which series the appearance controls are editing; '' = all of them. */
  const [editing, setEditing] = useState<string>('')
  /*
   * The filter gating the TIME-SERIES views — exactly one, or none.
   *
   * Deliberately a single id rather than the series list the bar chart uses.
   * Two masks over one line have no defined meaning: the question "which
   * frames am I looking at" has one answer, and a plot that silently
   * intersected or unioned two filters would be a different quantity
   * depending on an ordering nobody chose.
   */
  const [gateFilterId, setGateFilterId] = useState<string>('')

  const activeFilters = useMemo(
    () => onGraph.map(id => plotFilters.find(f => f.id === id))
                 .filter((f): f is FilterDef => !!f),
    [onGraph, plotFilters])

  const series: PlotSeries[] = useMemo(() => {
    const out: PlotSeries[] = []
    let order = 0
    for (const f of activeFilters) {
      for (const c of conditions) {
        const id = seriesId(f.id, c.id)
        out.push({
          id, filterId: f.id, conditionId: c.id,
          label: labels[id] || `${f.name} · ${c.name}`,
          visible: !hiddenSeries.has(id),
          order: order++,
          style: plotSeriesStyles[id] || {},
        })
      }
    }
    return out
  }, [activeFilters, conditions, labels, hiddenSeries, plotSeriesStyles])

  const toggleOnGraph = useCallback((id: string) => {
    setOnGraph(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
  }, [])

  const toggleHidden = useCallback((id: string) => {
    setHiddenSeries(p => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }, [])

  /**
   * Apply a palette across the VISIBLE series in draw order.
   *
   * Writes per-series overrides rather than mutating the condition colours,
   * which belong to the project and are shown in the Structure and Results
   * tabs. A colour scheme is a property of this figure.
   */
  const applyScheme = useCallback((palette: string[]) => {
    if (!palette.length) return
    let i = 0
    for (const s of series) {
      if (!s.visible) continue
      setSeriesStyle(s.id, { colour: palette[i % palette.length] })
      i++
    }
  }, [series, setSeriesStyle])

  return {
    filters: plotFilters, addPlotFilter, updatePlotFilter, removePlotFilter,
    onGraph, setOnGraph, toggleOnGraph, activeFilters,
    groupBy, setGroupBy,
    series, hiddenSeries, toggleHidden,
    labels, setLabel: (id: string, v: string) =>
      setLabels(p => ({ ...p, [id]: v })),
    editing, setEditing,
    gateFilterId, setGateFilterId,
    seriesStyles: plotSeriesStyles, setSeriesStyle, clearSeriesStyleField,
    resetSeriesStyle, applyScheme,
  }
}

export type SeriesModel = ReturnType<typeof useSeriesModel>

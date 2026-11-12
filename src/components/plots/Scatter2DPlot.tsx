/**
 * 2D scatter (e.g. PCA-style landscapes) overlaying conditions by colour.
 */
import Plot from './Plot'
import { plotTheme } from '../../plotTheme'
import type { AnalysisResult } from '../../types'
import { PLOT_CONFIG, getPlotBg, getAxis } from './shared'

export function Scatter2DPlot({ results }: { results: AnalysisResult[] }) {
  const traces = results.map(r => ({
    x: r.x, y: r.y, type: 'scattergl', mode: 'markers',
    marker: { color: r.colour, size: 3, opacity: 0.5 },
    name: r.condition_name,
  }))
  const first = results[0]
  return (
    <Plot data={traces} config={PLOT_CONFIG} useResizeHandler style={{ width: '100%' }}
      layout={{
        autosize: true, uirevision: 'keep', height: 480, margin: { l: 60, r: 20, t: 40, b: 50 }, ...getPlotBg(),
        title: { text: first?.title || '', font: { color: plotTheme().title, size: 14 } },
        xaxis: { title: { text: first?.xlabel || '' }, ...getAxis() },
        yaxis: { title: { text: first?.ylabel || '' }, ...getAxis(), scaleanchor: 'x' },
        legend: { bgcolor: 'rgba(0,0,0,0)', bordercolor: plotTheme().grid, borderwidth: 1, x: 1, xanchor: 'right', y: 1 },
      }} />
  )
}

// ─── PCA (shared-basis clouds + variance explained) ───────────────────────────

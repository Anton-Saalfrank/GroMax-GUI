/**
 * Shared plot primitives.
 *
 * Theme-aware getters (not constants) so a light/dark switch restyles charts.
 * Lives next to the plot components that use it.
 */
import { plotTheme } from '../../plotTheme'

export const PLOT_CONFIG = {
  responsive: true,
  displaylogo: false,
  toImageButtonOptions: { format: 'png' as const, scale: 3 },
}

export const getPlotBg = () => {
  const t = plotTheme()
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: t.font, family: t.fontFamily, size: 11 },
  }
}

export const getAxis = () => {
  const t = plotTheme()
  return { gridcolor: t.grid, zerolinecolor: t.grid }
}

/**
 * Palette for per-replica colouring.
 *
 * Single source of truth is lib/stats. This used to be a duplicated literal
 * here (and a THIRD copy inside PcaPlot that shadowed the import), so the
 * three could drift and one plot would silently colour replicas differently.
 */
export { REPEAT_PALETTE as REP_PALETTE } from '../../lib/stats'

/** Small ‹ › nav button used by the heatmap replica pager. */
export const navBtn = (disabled: boolean): React.CSSProperties => ({
  width: 20, height: 20, borderRadius: 4, fontSize: 13, lineHeight: 1,
  background: 'var(--bg-surface)',
  color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
  border: '1px solid var(--border)',
  opacity: disabled ? 0.4 : 1,
  cursor: disabled ? 'default' : 'pointer',
  padding: 0,
})

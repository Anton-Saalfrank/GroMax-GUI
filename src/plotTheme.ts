/**
 * Plot theming helper.
 *
 * Reads the active CSS design tokens so Plotly charts follow the app's
 * light/dark theme automatically. Called at render time (after the theme
 * attribute is set), so switching themes restyles the plots.
 */
export function plotTheme() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) =>
    (css.getPropertyValue(name) || '').trim() || fallback
  return {
    font: v('--plot-font', '#8896ad'),
    grid: v('--plot-grid', '#252d3d'),
    title: v('--plot-title', '#e8edf5'),
    // Axis labels are prose, not code. Monospace here fought with every other
    // label in the app; the UI face keeps a plot looking part of the window.
    fontFamily: 'Inter, -apple-system, Segoe UI, Helvetica Neue, Arial, sans-serif',
  }
}


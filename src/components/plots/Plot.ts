/**
 * The Plot component, built on a PARTIAL Plotly bundle.
 *
 * WHY NOT `import Plot from 'react-plotly.js'`
 * That pulls the full plotly.js distribution — every trace type the library
 * has, including the map traces (scattermapbox, choroplethmapbox,
 * densitymapbox). Those drag in maplibre-gl, which this app has never had a
 * use for: there is not one map trace anywhere in the codebase, and a
 * trajectory analyser is unlikely to grow one.
 *
 * It was not free dead weight. maplibre-gl 4.7.1 carries a CRITICAL advisory
 * (XSS sanitizer bypass in DOM.sanitize via live NamedNodeMap removal skip),
 * reachable only through a map trace — so the vulnerable code was shipped in
 * every build while being unreachable by any user action. Shipping it at all
 * is the thing worth fixing, and upgrading plotly across two major versions to
 * carry a patched maplibre would have been a large API risk taken on behalf of
 * code we do not run.
 *
 * Registering only the traces actually used removes maplibre from the bundle
 * entirely, and takes probe-image-size (its own advisory) out of the graph with
 * it. Measured: 4.35 MB for plotly.min.js against 1.37 MB for this bundle.
 *
 * ADDING A TRACE TYPE
 * If a plot ever needs a type not registered below, Plotly will not render it
 * and will say so in the console. Import it from 'plotly.js/lib/<type>' and add
 * it to the register call — that is the whole change. Only the map traces are
 * deliberately out of bounds.
 *
 * Everything else — layout, shapes, annotations, the modebar, and SVG/PNG
 * export through the camera button — lives in core and is unaffected.
 */
import Plotly from 'plotly.js/lib/core'
import bar from 'plotly.js/lib/bar'
import heatmap from 'plotly.js/lib/heatmap'
import histogram from 'plotly.js/lib/histogram'
import histogram2dcontour from 'plotly.js/lib/histogram2dcontour'
import scatter from 'plotly.js/lib/scatter'
import scattergl from 'plotly.js/lib/scattergl'
import createPlotlyComponent from 'react-plotly.js/factory'

// The six types this app draws. `scattergl` matters as much as `scatter`:
// the Compare tab switches to it for large replica sets.
Plotly.register([
  bar,
  heatmap,
  histogram,
  histogram2dcontour,
  scatter,
  scattergl,
])

const Plot = createPlotlyComponent(Plotly)
export default Plot

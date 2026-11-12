// The partial Plotly bundle (see components/plots/Plot.ts). plotly.js ships no
// types for its lib/ entry points, and the app never touches the Plotly object
// directly — it only hands it to createPlotlyComponent — so `any` here costs
// nothing that stricter typing would have caught.
declare module 'plotly.js/lib/core' {
  const Plotly: { register(modules: any[]): void; [key: string]: any }
  export default Plotly
}
declare module 'plotly.js/lib/bar' { const m: any; export default m }
declare module 'plotly.js/lib/heatmap' { const m: any; export default m }
declare module 'plotly.js/lib/histogram' { const m: any; export default m }
declare module 'plotly.js/lib/histogram2dcontour' { const m: any; export default m }
declare module 'plotly.js/lib/scatter' { const m: any; export default m }
declare module 'plotly.js/lib/scattergl' { const m: any; export default m }

declare module 'react-plotly.js/factory' {
  import type { ComponentType } from 'react'
  import type { PlotParams } from 'react-plotly.js'
  export default function createPlotlyComponent(plotly: any): ComponentType<PlotParams>
}

declare module 'react-plotly.js' {
  import { Component } from 'react'
  export interface PlotParams {
    data: any[]
    layout?: any
    config?: any
    style?: any
    useResizeHandler?: boolean
    [key: string]: any
  }
  export default class Plot extends Component<PlotParams> {}
}

declare namespace Electron {
  interface OpenDialogOptions {
    properties?: string[]
    filters?: { name: string; extensions: string[] }[]
    [key: string]: any
  }
  interface OpenDialogReturnValue { canceled: boolean; filePaths: string[] }
  interface SaveDialogOptions { [key: string]: any }
  interface SaveDialogReturnValue { canceled: boolean; filePath?: string }
}

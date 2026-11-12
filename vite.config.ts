import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') }
  },
  // Plotly's `lib/` entry points — which is what components/plots/Plot.ts
  // imports to build the partial bundle — reach for the Node global `global`.
  // The production build resolves it; the dev dependency pre-bundler does not,
  // so without this the renderer dies on `ReferenceError: global is not
  // defined` before React mounts and the window comes up blank.
  //
  // Scoped to optimizeDeps rather than a top-level `define` on purpose: the
  // problem is confined to pre-bundled dependencies, and the production build
  // is already verified working without the substitution. Widening it would
  // change a path that is not broken.
  optimizeDeps: {
    esbuildOptions: { define: { global: 'globalThis' } }
  },

  server: { port: 5173 },
  build: { outDir: 'dist', emptyOutDir: true }
})

/**
 * Rolling RMSF against another observable — the numbers, not the impression.
 *
 * An overlay shows whether two traces move together; this says by how much, at
 * which residues, and with what lead time. Three things are shown together
 * because any one of them alone is misleading:
 *
 *   - the HEADLINE correlation for the mean profile, with its sample counts,
 *   - the CURVE of correlation against lag, where a broad shapeless hump means
 *     something different from a sharp peak,
 *   - the RESIDUE-BY-LAG map, because a mean of zero routinely hides one loop
 *     correlating strongly and another anticorrelating just as hard.
 *
 * The caveats are rendered, not buried: overlapping windows are not independent
 * samples, and a lag chosen by searching is not a lag that was predicted.
 */
import React from 'react'
import Plot from './Plot'
import { HeatmapPlot } from './LinePlot'
import { plotTheme } from '../../plotTheme'
import { PLOT_CONFIG, getPlotBg, getAxis } from './shared'
import type { MatrixStats, ScaleSettings } from '../../lib/heatmapScale'

const fmtR = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(3)

const fmtP = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (v < 1e-4) return v.toExponential(1)
  return v.toFixed(4)
}

export function XCorrPlot({ r, sessionId, cacheKey, scale, pooledStats, onStats }: {
  r: any
  sessionId?: string
  cacheKey?: string
  scale?: ScaleSettings
  pooledStats?: MatrixStats | null
  onStats?: (s: MatrixStats | null) => void
}) {
  const agg = r.aggregate || {}
  const lags: number[] = agg.lags_ns || []
  const curve: (number | null)[] = agg.r || []
  const reps: any[] = r.per_replica || []

  const stat = (label: string, value: React.ReactNode, hint?: string) => (
    <div title={hint} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 14, fontFamily: 'var(--font-mono)' }}>{value}</span>
    </div>
  )

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8,
                    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%',
                       background: r.colour, display: 'inline-block' }} />
        {r.condition_name} · {r.map_name} vs {r.series_name}
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
          {r.method === 'spearman' ? 'Spearman' : 'Pearson'}
        </span>
      </div>

      {/* Headline numbers for the mean profile. */}
      <div style={{
        display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: 10,
        padding: '10px 12px', borderRadius: 6,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      }}>
        {stat('r at zero lag', fmtR(agg.r0),
              'Correlation with no time offset — the one you would have predicted '
              + 'in advance, so its p-value is not inflated by searching.')}
        {stat('p (zero lag)', fmtP(agg.p0),
              'From the effective sample size, not the window count.')}
        {stat('strongest lag',
              agg.best_lag_ns === null || agg.best_lag_ns === undefined
                ? '—' : `${agg.best_lag_ns > 0 ? '+' : ''}${agg.best_lag_ns.toFixed(2)} ns`,
              `Positive means ${r.series_name} changes first and flexibility follows.`)}
        {stat('r there', fmtR(agg.best_r), 'Found by searching over lags.')}
        {stat('windows', String(r.n_windows ?? '—'))}
        {stat('effective n', String(r.n_eff ?? '—'),
              'How many INDEPENDENT samples those windows are worth, from the '
              + 'autocorrelation of the two series.')}
      </div>

      {/* Which way round the lag runs, stated in words rather than left to a
          sign convention nobody remembers. */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
        A <strong>positive</strong> lag means <strong>{r.series_name}</strong> changes
        first and flexibility follows; a <strong>negative</strong> lag means
        flexibility moves first.
      </div>

      <Plot
        data={[
          {
            x: lags, y: curve, type: 'scatter', mode: 'lines',
            line: { color: r.colour || '#4f8ef7', width: 2 },
            name: 'mean profile',
            hovertemplate: 'lag %{x:.2f} ns · r %{y:.3f}<extra></extra>',
          },
          ...(agg.best_lag_ns !== null && agg.best_lag_ns !== undefined
            ? [{
                x: [agg.best_lag_ns], y: [agg.best_r], type: 'scatter' as const,
                mode: 'markers' as const, showlegend: false,
                marker: { color: '#f79f4f', size: 10, symbol: 'diamond',
                          line: { color: plotTheme().grid, width: 1 } },
                hovertemplate: 'strongest: lag %{x:.2f} ns · r %{y:.3f}<extra></extra>',
              }] : []),
        ]}
        config={PLOT_CONFIG} useResizeHandler style={{ width: '100%' }}
        layout={{
          autosize: true, uirevision: 'keep', height: 230,
          margin: { l: 60, r: 20, t: 10, b: 46 }, ...getPlotBg(),
          xaxis: { title: { text: `Lag (ns) — positive: ${r.series_name} leads` },
                   ...getAxis() },
          // Pinned: a correlation axis that autoscales to +-0.05 makes noise
          // look like a finding.
          yaxis: { title: { text: `${r.method === 'spearman' ? 'Spearman' : 'Pearson'} r` },
                   range: [-1, 1], ...getAxis() },
          showlegend: false,
          shapes: [
            { type: 'line', x0: 0, x1: 0, y0: -1, y1: 1,
              line: { color: plotTheme().grid, dash: 'dot', width: 1 } },
            { type: 'line', x0: lags[0], x1: lags[lags.length - 1], y0: 0, y1: 0,
              line: { color: plotTheme().grid, dash: 'dot', width: 1 } },
          ],
        }} />

      {/* Per residue — where a mean of zero hides two opposite effects. */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '10px 0 4px' }}>
        Per residue. Drag a box (with <em>Drag: select region</em>) to highlight
        those residues on the structure.
      </div>
      <HeatmapPlot r={r} sessionId={sessionId} cacheKey={cacheKey}
                   scale={scale} pooledStats={pooledStats} onStats={onStats} />

      {reps.length > 1 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            Per replica — agreement between runs matters more than the pooled
            number. Replicas differing in sign is a result in itself.
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {reps.map(p => (
              <div key={p.index} style={{
                padding: '5px 9px', borderRadius: 5, fontSize: 11,
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                fontFamily: 'var(--font-mono)',
              }}>
                rep {p.index}: r₀ {fmtR(p.r0)}
                {p.best_lag_ns !== null && p.best_lag_ns !== undefined && (
                  <> · peak {p.best_lag_ns > 0 ? '+' : ''}{p.best_lag_ns.toFixed(1)} ns
                     ({fmtR(p.best_r)})</>
                )}
                <span style={{ color: 'var(--text-muted)' }}> · n≈{p.n_eff}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(r.warnings) && r.warnings.length > 0 && (
        <div style={{
          marginTop: 10, padding: '8px 11px', borderRadius: 5, fontSize: 11,
          lineHeight: 1.55, background: 'rgba(247,210,79,0.10)',
          border: '1px solid var(--border)', color: 'var(--text-secondary)',
        }}>
          {r.warnings.map((w: string, i: number) => (
            <div key={i} style={{ marginBottom: i < r.warnings.length - 1 ? 4 : 0 }}>
              · {w}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The distribution inside a matrix, per replicate and per condition.
 *
 * A 2D-RMSD map shows WHEN a run moved; this shows HOW MUCH it moved overall.
 * Each replicate's pairwise frame-to-frame RMSDs become one violin, and each
 * replicate's mean becomes one dot — which is what makes ten runs against ten
 * runs an ordinary comparison.
 *
 * THE STATISTICAL TRAP THIS DELIBERATELY AVOIDS
 *
 * A 500-frame matrix holds 124,750 pairs. It is tempting to treat those as the
 * sample and compare two conditions with n = 124,750, which would make every
 * difference overwhelmingly significant. They are not independent: all of them
 * come from 500 frames of ONE trajectory, and those frames are correlated with
 * each other. The honest unit is the replicate.
 *
 * So the violins are shown for shape, and every test is run on the per-replicate
 * means — n = the number of runs — through the same statistics the bar charts
 * use. The panel says which is which rather than letting the dense violin imply
 * the power it does not have.
 */
import { useEffect, useMemo, useState } from 'react'
import Plot from './Plot'
import { api } from '../../api/client'
import { useStore } from '../../store'
import { compareGroups, summarise, stars } from '../../lib/stats'
import { PLOT_CONFIG, getPlotBg, getAxis } from './shared'

interface RepSummary {
  index: number; n_pairs: number; mean: number; sd: number
  min: number; max: number; p5: number; p25: number; median: number
  p75: number; p95: number; sample: number[]; sampled: boolean
}
interface CondDist {
  condition_id: string; condition_name: string; colour: string
  zlabel: string; replicas: RepSummary[]; skipped_replicas: number[]; note: string
}

const fmt = (v: number | null | undefined, d = 3) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d)

export function MatrixDistributionPanel({ results, cacheKeys }: {
  results: any[]
  cacheKeys?: Record<string, string>
}) {
  const sessionId = useStore(st => st.activeSession?.id || '')
  const [data, setData] = useState<CondDist[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'violin' | 'box'>('violin')

  const keys = useMemo(
    () => results.map(r => ({ r, key: cacheKeys?.[r.condition_id || ''] }))
                 .filter(x => !!x.key),
    [results, cacheKeys])
  const cacheKeyList = keys.map(k => k.key).join(',')

  useEffect(() => {
    if (!sessionId || !keys.length) return
    let cancelled = false
    setBusy(true); setError(null)
    Promise.all(keys.map(({ r, key }) =>
      api.analysis.matrixDistribution(sessionId, key!)
        .then(d => ({ ...d, condition_name: d.condition_name || r.condition_name,
                      colour: d.colour || r.colour }))))
      .then(d => { if (!cancelled) setData(d as CondDist[]) })
      .catch(e => {
        if (cancelled) return
        const m = String(e?.message || '')
        setError(/not found|method not allowed/i.test(m.trim())
          ? 'This backend predates the distribution endpoint — quit and relaunch '
            + 'the app so it picks up the current code.'
          : m || 'Could not summarise these matrices.')
      })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
    /*
     * Keyed on the CACHE KEYS, not on `keys`.
     *
     * `results` is a prop array whose identity changes on every parent render,
     * so `keys` (memoised over it) changes too — and refetching every matrix
     * distribution on each render is exactly what this avoids. The cache keys
     * are the thing that actually determines the request. That content-keying
     * is correct but cannot be expressed as a static dependency, hence the
     * suppression rather than a dependency that would be wrong.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, cacheKeyList])

  /** Per-replicate means — the sample every test here actually uses. */
  const perReplicate = useMemo(() => (data || []).map(d => ({
    name: d.condition_name,
    colour: d.colour,
    values: d.replicas.map(r => r.mean),
  })), [data])

  const comparison = useMemo(
    () => (perReplicate.length >= 2 ? compareGroups(perReplicate, 'welch') : null),
    [perReplicate])

  const traces = useMemo(() => {
    if (!data) return []
    const out: any[] = []
    for (const d of data) {
      for (const rep of d.replicas) {
        out.push({
          type: mode, y: rep.sample,
          name: `${d.condition_name} rep${rep.index}`,
          x: rep.sample.map(() => `${d.condition_name}\nrep${rep.index}`),
          marker: { color: d.colour }, line: { color: d.colour },
          fillcolor: d.colour, opacity: 0.45,
          ...(mode === 'violin'
            ? { points: false as const, spanmode: 'hard' as const,
                meanline: { visible: true } }
            : { boxpoints: false as const }),
          showlegend: false,
          hovertemplate: `${d.condition_name} rep${rep.index}<br>`
            + `median ${fmt(rep.median)} · mean ${fmt(rep.mean)}<extra></extra>`,
        })
      }
    }
    return out
  }, [data, mode])

  if (busy && !data) {
    return <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '8px 0' }}>
      Summarising every replicate's matrix…
    </div>
  }
  if (error) {
    return <div style={{ fontSize: 11, padding: '8px 11px', borderRadius: 5,
                         background: 'rgba(247,127,79,0.12)',
                         border: '1px solid var(--border)' }}>{error}</div>
  }
  if (!data) return null

  const zlabel = data[0]?.zlabel || 'value'
  const anySkipped = data.some(d => d.skipped_replicas?.length)

  return (
    <div style={{ marginTop: 12, paddingTop: 12,
                  borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10,
                    flexWrap: 'wrap', marginBottom: 8 }}>
        <strong style={{ fontSize: 12 }}>Distribution across replicates</strong>
        <select value={mode} onChange={e => setMode(e.target.value as any)}
                style={{ fontSize: 11 }}>
          <option value="violin">violin</option>
          <option value="box">box</option>
        </select>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {data[0]?.note}
        </span>
      </div>

      <Plot data={traces} config={PLOT_CONFIG} useResizeHandler
            style={{ width: '100%' }}
            layout={{
              autosize: true, height: 360, uirevision: `dist-${mode}`,
              margin: { l: 66, r: 20, t: 10, b: 70 }, ...getPlotBg(),
              xaxis: { ...getAxis(), tickangle: -40 },
              yaxis: { title: { text: zlabel }, ...getAxis() },
              violinmode: 'group', boxmode: 'group', showlegend: false,
            }} />

      {/* Average of averages — one dot per replicate. */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          Each replicate's mean, and the comparison built from them. <strong>n is
          the number of replicates</strong>, not the number of frame pairs — the
          pairs inside one run are not independent observations, and treating
          them as a sample would make any difference look certain.
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {data.map((d, i) => {
            const s = summarise(perReplicate[i].values)
            return (
              <div key={d.condition_id} style={{
                padding: '8px 11px', borderRadius: 6, fontSize: 11,
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                              marginBottom: 4 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%',
                                 background: d.colour, display: 'inline-block' }} />
                  <strong>{d.condition_name}</strong>
                  <span style={{ color: 'var(--text-muted)' }}>
                    n = {s?.n ?? 0} replicates
                  </span>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)' }}>
                  mean {fmt(s?.mean)} ± {fmt(s?.sd)} {zlabel}
                  <br />
                  <span style={{ color: 'var(--text-muted)' }}>
                    95% CI ±{fmt(s?.ci95)} · range {fmt(Math.min(...perReplicate[i].values))}
                    –{fmt(Math.max(...perReplicate[i].values))}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 5 }}>
                  {d.replicas.map(r => (
                    <span key={r.index} style={{
                      padding: '1px 6px', borderRadius: 3, fontSize: 10,
                      fontFamily: 'var(--font-mono)', background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                    }} title={`${r.n_pairs.toLocaleString()} pairs · `
                            + `median ${fmt(r.median)} · SD ${fmt(r.sd)}`}>
                      {r.index}: {fmt(r.mean, 2)}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {comparison && comparison.pairs.length > 0 && (
        <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 6,
                      fontSize: 11, background: 'var(--bg-surface)',
                      border: '1px solid var(--border)' }}>
          {comparison.pairs.map((c, i) => (
            <div key={i} style={{ fontFamily: 'var(--font-mono)', marginBottom: 3 }}>
              {c.a} vs {c.b}: Δ {fmt(c.meanDiff)} {zlabel} · Welch p{' '}
              {c.p < 1e-4 ? c.p.toExponential(1) : fmt(c.p, 4)}{' '}
              <span style={{ color: 'var(--text-muted)' }}>({stars(c.p)})</span>
              {' · '}Hedges' g {fmt(c.effect, 2)} ({c.effectLabel})
              {' · '}n {c.nA} vs {c.nB}
            </div>
          ))}
          {comparison.notes.map((n, i) => (
            <div key={i} style={{ color: 'var(--text-muted)', marginTop: 4,
                                  lineHeight: 1.5 }}>· {n}</div>
          ))}
        </div>
      )}

      {anySkipped && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--orange, #f79f4f)' }}>
          Some replicates have no stored matrix and were left out:{' '}
          {data.filter(d => d.skipped_replicas?.length)
               .map(d => `${d.condition_name} rep ${d.skipped_replicas.join(', ')}`)
               .join('; ')}. Re-run the analysis to include them.
        </div>
      )}
    </div>
  )
}

/**
 * The statistics readout under a comparison plot.
 *
 * Shows the test, the effect size and the caveats together, deliberately. A bare
 * p-value from three replicas against three invites exactly the reading it
 * cannot support, so the sample size, the effect size and the reason a result
 * may be unreachable are given the same prominence as the asterisk.
 */
import React from 'react'
import type { GroupComparison, CorrelationResult, TestKind } from '../../lib/stats'
import { stars } from '../../lib/stats'

const num = (v: number | undefined | null, dp = 3) =>
  v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(dp)

const pStr = (v: number | undefined | null) => {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—'
  if (v < 0.0001) return v.toExponential(1)
  return v.toFixed(4)
}

const cell: React.CSSProperties = {
  padding: '4px 9px', textAlign: 'left', whiteSpace: 'nowrap',
}
const head: React.CSSProperties = {
  ...cell, fontWeight: 600, color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border)',
}

export function StatsPanel({ comparison, test, onTestChange, unit, paired }: {
  comparison: GroupComparison
  test: TestKind
  onTestChange: (t: TestKind) => void
  unit?: string
  /**
   * The series on this chart were measured on the SAME replicas.
   *
   * It changes which tests are offered, and the unpaired ones are not among
   * them: on paired data Welch does not merely lose power, it treats n paired
   * observations as 2n independent ones and returns a p-value that is too
   * small — and the error grows with the strength of the pairing. Offering it
   * as a choice here would be offering the wrong answer.
   */
  paired?: boolean
}) {
  const { groups, omnibus, pairs, notes } = comparison
  const usable = groups.filter(g => g.values.length >= 2)

  return (
    <div style={{
      marginTop: 10, padding: '10px 12px', borderRadius: 6,
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10,
                    marginBottom: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 12 }}>Statistics</strong>
        {paired && (
          <span title={'These series come from the same replicas, so each run is '
                     + 'compared with itself. Unpaired tests are not offered.'}
                style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4,
                         background: 'rgba(79,142,247,0.15)',
                         color: 'var(--accent-bright, #4f8ef7)' }}>
            paired design
          </span>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          {((paired ? [
            ['pairedt', 'Paired t', 'Tests the per-replica DIFFERENCES against '
              + 'zero. Assumes those differences are roughly normal — a much '
              + 'weaker assumption than normality of the values themselves.'],
            ['wilcoxon', 'Wilcoxon signed-rank', 'Rank-based on the differences, '
              + 'assumes nothing about their distribution. Cannot reach p < 0.05 '
              + 'with fewer than 6 usable pairs.'],
          ] : [
            ['welch', "Welch's t / ANOVA", 'Assumes roughly normal replica means '
              + 'but NOT equal variances — the usual situation when one condition '
              + 'is both shifted and noisier.'],
            ['mannwhitney', 'Mann–Whitney / Kruskal–Wallis', 'Rank-based, assumes '
              + 'nothing about the distribution. Much weaker at small n: with '
              + '3 vs 3 it cannot return p below 0.1.'],
          ]) as [TestKind, string, string][]).map(([id, label, help]) => (
            <button key={id} title={help} onClick={() => onTestChange(id)}
              style={{
                padding: '3px 9px', borderRadius: 4, fontSize: 11,
                background: test === id ? 'var(--accent)' : 'var(--bg-elevated)',
                color: test === id ? '#fff' : 'var(--text-secondary)',
                border: `1px solid ${test === id ? 'transparent' : 'var(--border)'}`,
              }}>{label}</button>
          ))}
        </div>
      </div>

      {usable.length > 0 && (
        <table style={{ borderCollapse: 'collapse', marginBottom: 8, fontFamily: 'var(--font-mono)' }}>
          <thead>
            <tr>
              <th style={head}>condition</th>
              <th style={head}>n</th>
              <th style={head}>mean{unit ? ` (${unit})` : ''}</th>
              <th style={head}>SD</th>
              <th style={head}>SEM</th>
              <th style={head}>95% CI</th>
            </tr>
          </thead>
          <tbody>
            {usable.map(g => (
              <tr key={g.name}>
                <td style={{ ...cell, fontFamily: 'inherit' }}>{g.name}</td>
                <td style={cell}>{g.summary?.n ?? 0}</td>
                <td style={cell}>{num(g.summary?.mean, 4)}</td>
                <td style={cell}>{num(g.summary?.sd, 4)}</td>
                <td style={cell}>{num(g.summary?.sem, 4)}</td>
                <td style={cell}>±{num(g.summary?.ci95, 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {omnibus && (
        <div style={{ marginBottom: 8, fontFamily: 'var(--font-mono)' }}>
          {omnibus.test}: {omnibus.test.startsWith('Welch') ? 'F' : 'H'} ={' '}
          {num(omnibus.statistic)} , p = {pStr(omnibus.p)} {stars(omnibus.p)}
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-sans, inherit)' }}>
            {' '}— asks only whether ANY condition differs.
          </span>
        </div>
      )}

      {pairs.length > 0 && (
        <table style={{ borderCollapse: 'collapse', marginBottom: 8, fontFamily: 'var(--font-mono)' }}>
          <thead>
            <tr>
              <th style={head}>comparison</th>
              <th style={head}>n</th>
              <th style={head}>Δ mean</th>
              <th style={head}>{test === 'welch' ? 't' : test === 'pairedt' ? 't (paired)'
                                 : test === 'wilcoxon' ? 'W' : 'U'}</th>
              <th style={head}>p</th>
              <th style={head} title="Holm–Bonferroni across all pairs shown">p adj</th>
              <th style={head} title="Hedges' g — the standardised difference">effect</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((c, i) => (
              <tr key={i}>
                <td style={{ ...cell, fontFamily: 'inherit' }}>{c.a} vs {c.b}</td>
                <td style={cell}>{c.nA}/{c.nB}</td>
                <td style={cell}>{num(c.meanDiff, 4)}</td>
                <td style={cell}>{num(c.statistic)}</td>
                <td style={cell}>{pStr(c.p)}</td>
                <td style={cell}>
                  {pStr(c.pAdjusted)}{' '}
                  <span style={{ color: 'var(--text-muted)' }}>{stars(c.pAdjusted ?? NaN)}</span>
                </td>
                <td style={cell} title={c.effectLabel}>
                  {num(c.effect, 2)} <span style={{ color: 'var(--text-muted)' }}>{c.effectLabel}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pairs.some(c => c.underpowered) && (
        <div style={{ marginBottom: 6, color: 'var(--orange, #f79f4f)', lineHeight: 1.5 }}>
          {pairs.filter(c => c.underpowered).map((c, i) => (
            <div key={i}>⚠ {c.a} vs {c.b}: {c.underpowered}.</div>
          ))}
        </div>
      )}

      <div style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        {notes.map((nte, i) => <div key={i}>· {nte}</div>)}
        <div>· ★ thresholds: * p&lt;0.05, ** p&lt;0.01, *** p&lt;0.001, **** p&lt;0.0001.</div>
      </div>
    </div>
  )
}

/** The readout for a correlation plot. */
export function CorrelationStats({ overall, spearman, fits, unitX, unitY,
                                   basis, nPoints, perRep, droppedReps }: {
  overall: CorrelationResult | null
  spearman: CorrelationResult | null
  fits: { name: string; fit: CorrelationResult; colour: string }[]
  unitX?: string
  unitY?: string
  /** What one dot is — decides which caveat applies. */
  basis?: 'mean' | 'pooled' | 'perrep'
  nPoints?: number
  /** Per-repeat r values, when fitted separately. */
  perRep?: { name: string; r: number }[]
  /** Repeats left out, and why. */
  droppedReps?: string[]
}) {
  if (!overall) return null

  // Fisher-z mean across repeats: coefficients are not additive, and the
  // SPREAD matters more than the average — repeats disagreeing in sign is a
  // result, not noise to be averaged away.
  const reps = perRep || []
  const fisher = reps.length
    ? Math.tanh(reps.reduce((a, p) =>
        a + Math.atanh(Math.max(-0.999999, Math.min(0.999999, p.r))), 0) / reps.length)
    : null
  const rMin = reps.length ? Math.min(...reps.map(p => p.r)) : null
  const rMax = reps.length ? Math.max(...reps.map(p => p.r)) : null
  return (
    <div style={{
      marginTop: 10, padding: '10px 12px', borderRadius: 6,
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      fontSize: 11,
    }}>
      <strong style={{ fontSize: 12 }}>Correlation</strong>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', margin: '8px 0',
                    fontFamily: 'var(--font-mono)' }}>
        <span>Pearson r = <strong>{num(overall.r)}</strong></span>
        <span>R² = {num(overall.r2)}</span>
        <span>95% CI [{num(overall.ciLow)}, {num(overall.ciHigh)}]</span>
        <span>p = {pStr(overall.p)} {stars(overall.p)}</span>
        <span>n = {overall.n}</span>
        {spearman && <span>Spearman ρ = {num(spearman.r)}</span>}
      </div>

      {/* What a dot actually is, on screen, in words. Getting this wrong is
          how an averaged cloud gets read as raw data. */}
      <div style={{ marginBottom: 8, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        {basis === 'mean' && (
          <>Each of the <strong>{(nPoints ?? 0).toLocaleString()}</strong> dots is
            one <strong>time point of the across-repeat mean</strong> — the repeats
            are averaged first, then plotted against each other. Excluding a repeat
            therefore moves the dots without changing how many there are. Averaging
            first is a filter: it can produce a clean trend that no single run shows.</>
        )}
        {basis === 'pooled' && (
          <>Each of the <strong>{(nPoints ?? 0).toLocaleString()}</strong> dots is
            one <strong>frame of one repeat</strong>, paired with the same frame of
            the same repeat on the other metric. Nothing is averaged.</>
        )}
        {basis === 'perrep' && (
          <>Each of the <strong>{(nPoints ?? 0).toLocaleString()}</strong> dots is
            one frame of one repeat, and each repeat is fitted separately.</>
        )}
      </div>

      {reps.length > 1 && (
        <div style={{ marginBottom: 8, fontFamily: 'var(--font-mono)' }}>
          per repeat: r = {num(rMin)} to {num(rMax)} · Fisher mean {num(fisher)}
          <span style={{ color: 'var(--text-muted)', fontFamily: 'inherit' }}>
            {' '}— {rMin !== null && rMax !== null && rMin * rMax < 0
              ? 'repeats disagree in SIGN, which the pooled number hides'
              : 'consistency across repeats matters more than the pooled value'}
          </span>
        </div>
      )}

      {droppedReps && droppedReps.length > 0 && (
        <div style={{ marginBottom: 6, color: 'var(--orange, #f79f4f)' }}>
          ⚠ left out: {droppedReps.join('; ')}
        </div>
      )}

      {fits.length > 1 && (
        <table style={{ borderCollapse: 'collapse', marginBottom: 8,
                        fontFamily: 'var(--font-mono)' }}>
          <thead>
            <tr>
              <th style={head}>condition</th><th style={head}>r</th>
              <th style={head}>R²</th><th style={head}>slope</th><th style={head}>p</th>
            </tr>
          </thead>
          <tbody>
            {fits.map(f => (
              <tr key={f.name}>
                <td style={{ ...cell, fontFamily: 'inherit', color: f.colour }}>{f.name}</td>
                <td style={cell}>{num(f.fit.r)}</td>
                <td style={cell}>{num(f.fit.r2)}</td>
                <td style={cell}>{num(f.fit.slope, 4)}</td>
                <td style={cell}>{pStr(f.fit.p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/*
        * The caveat that matters most on this particular plot. Each point is a
        * TIME POINT, and consecutive frames of a trajectory are nearly
        * identical — so n here is not a count of independent observations and
        * the p-value is correspondingly optimistic. Said plainly rather than
        * left for the reader to remember.
        */}
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        · Consecutive frames of a trajectory are nearly identical, so n is not a
        count of independent samples and this p-value is optimistic. Treat r as
        descriptive.
        <br />
        · A repeat excluded under either metric is excluded from both — the two
        axes are always built from the same runs.
        <br />
        · The fitted line spans only the observed range; it is not extrapolated.
      </div>
    </div>
  )
}

/**
 * Cross-correlation, summarised across repeats.
 *
 * The question a cross-correlation is asked — "are these two events coupled,
 * and with what delay?" — is answered by AGREEMENT BETWEEN INDEPENDENT RUNS,
 * not by the height of one pooled curve. Ten repeats peaking at +4 ns is
 * evidence. One pooled curve peaking at +4 ns, built by averaging runs whose
 * events happen at different times, mostly is not.
 *
 * So the spread of per-repeat peaks is given top billing, and the count of
 * repeats that agree on the SIGN is stated outright.
 */
export function XCorrRepeatStats({ perRep, conditions, unit, basis }: {
  perRep: { condition: string; index: number; peakLag: number; peakR: number; r0: number }[]
  conditions: { name: string; colour: string; nReps: number }[]
  /** 'ns' when the timestep was known, otherwise 'frames'. */
  unit: string
  basis: 'perrep' | 'mean'
}) {
  if (basis === 'mean') {
    return (
      <div style={{
        marginTop: 10, padding: '10px 12px', borderRadius: 6, fontSize: 11,
        background: 'rgba(247,127,79,0.10)', border: '1px solid var(--border)',
        color: 'var(--text-secondary)', lineHeight: 1.6,
      }}>
        ⚠ <strong>Repeats are averaged before cross-correlating.</strong> Events
        occur at different times in different runs, so averaging by wall-clock
        time smears them out — the coupling signal is attenuated toward zero, and
        what survives is whatever the runs share at the same absolute time
        (equilibration, a slow common drift). A peak here is more likely to be
        that than coupling. Switch to <em>per repeat</em> unless you specifically
        want the behaviour of the averaged trace.
      </div>
    )
  }
  if (!perRep.length) return null

  const median = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b)
    const m = Math.floor(v.length / 2)
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
  }

  return (
    <div style={{
      marginTop: 10, padding: '10px 12px', borderRadius: 6, fontSize: 11,
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
    }}>
      <strong style={{ fontSize: 12 }}>Coupling across repeats</strong>

      {conditions.map(c => {
        const rows = perRep.filter(p => p.condition === c.name)
        if (!rows.length) return null
        const lags = rows.map(r => r.peakLag)
        const rs = rows.map(r => r.peakR)
        const medLag = median(lags)
        const pos = rs.filter(v => v > 0).length
        const neg = rs.filter(v => v < 0).length
        const agreeSign = Math.max(pos, neg)
        // "Agrees" = peaks within one median-absolute-deviation of the median,
        // which adapts to how sharp the peaks are instead of a fixed window.
        const mad = median(lags.map(l => Math.abs(l - medLag)))
        const tol = Math.max(mad, 1e-9)
        const near = lags.filter(l => Math.abs(l - medLag) <= tol).length

        return (
          <div key={c.name} style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%',
                             background: c.colour, display: 'inline-block' }} />
              <strong>{c.name}</strong>
              <span style={{ color: 'var(--text-muted)' }}>{rows.length} repeats</span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', marginBottom: 3 }}>
              peak lag: median {num(medLag, 2)} {unit} · range{' '}
              {num(Math.min(...lags), 2)} to {num(Math.max(...lags), 2)} {unit}
              {' · '}|r| at peak {num(Math.min(...rs.map(Math.abs)), 2)}–
              {num(Math.max(...rs.map(Math.abs)), 2)}
            </div>
            <div style={{ color: agreeSign === rows.length ? 'var(--green, #7ee081)'
                                                           : 'var(--orange, #f79f4f)' }}>
              {agreeSign} of {rows.length} repeats agree on the sign
              {agreeSign < rows.length
                ? ' — the runs disagree about the direction of the relationship'
                : ''}
              {`; ${near} of ${rows.length} peak near the median lag.`}
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
              {rows.map(r => (
                <span key={r.index} style={{
                  padding: '2px 7px', borderRadius: 4, fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                }}>
                  rep {r.index}: {r.peakR > 0 ? '+' : ''}{num(r.peakR, 2)} @{' '}
                  {r.peakLag > 0 ? '+' : ''}{num(r.peakLag, 1)} {unit}
                </span>
              ))}
            </div>
          </div>
        )
      })}

      <div style={{ color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 8 }}>
        · A positive lag means the second metric changes FIRST and the first
        follows.
        <br />
        · Each curve is one run. The bold curve is the Fisher-pooled average of
        them — pooled after correlating, never before.
        <br />
        · Cross-correlating two autocorrelated series produces broad peaks by
        construction. Agreement between independent repeats is the evidence, not
        the height of any single curve.
      </div>
    </div>
  )
}

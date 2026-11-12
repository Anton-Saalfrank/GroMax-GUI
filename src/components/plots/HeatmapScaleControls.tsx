/**
 * Colour-scale controls, shared by every heatmap on screen.
 *
 * Deliberately ONE control bar above all the condition maps rather than a set
 * per map. The reason these exist is to make maps comparable, and per-map
 * controls would let you put two maps on two different scales and lay them side
 * by side — which is the problem, dressed up as a feature.
 */
import React from 'react'
import type {
  ClipLevel, MatrixStats, ScaleMode, ScaleSettings,
} from '../../lib/heatmapScale'
import { fmtScale, resolveRange } from '../../lib/heatmapScale'

const MODES: { id: ScaleMode; label: string; help: string }[] = [
  { id: 'shared', label: 'Shared',
    help: 'One colour range across every replica and every condition shown, so '
        + 'the same colour means the same value everywhere.' },
  { id: 'auto', label: 'Per map',
    help: 'Each map scales to its own values. Best contrast within one map, but '
        + 'colours cannot be compared between maps.' },
  { id: 'manual', label: 'Manual',
    help: 'Type the range yourself. Useful for holding a scale fixed across '
        + 'sessions, or for matching a figure you already have.' },
]

const CLIPS: { id: ClipLevel; label: string }[] = [
  { id: 'none', label: 'full range' },
  { id: 'p99', label: '1–99%' },
  { id: 'p98', label: '2–98%' },
  { id: 'p95', label: '5–95%' },
]

export function HeatmapScaleControls({
  settings, onChange, stats, diverging, unit, pooledFrom, approximate,
}: {
  settings: ScaleSettings
  onChange: (s: ScaleSettings) => void
  stats: MatrixStats | null
  diverging: boolean
  /** e.g. 'nm', for the readout. */
  unit?: string
  /** How many matrices the pooled statistics cover. */
  pooledFrom?: number
  /** True when the stats came from the loaded matrices, not the whole set. */
  approximate?: boolean
}) {
  const range = resolveRange(settings, stats, diverging)
  const set = (patch: Partial<ScaleSettings>) => onChange({ ...settings, ...patch })

  const btn = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
    background: active ? 'var(--accent)' : 'var(--bg-surface)',
    color: active ? '#fff' : 'var(--text-secondary)',
    border: `1px solid ${active ? 'transparent' : 'var(--border)'}`,
    fontWeight: active ? 600 : 400,
  })

  const num: React.CSSProperties = {
    width: 84, padding: '3px 6px', fontSize: 11,
    border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg)', color: 'var(--text)',
    fontFamily: 'var(--font-mono)',
  }

  const u = unit ? ` ${unit}` : ''

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10,
      padding: '8px 10px', borderRadius: 6,
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-muted)' }}>Colour scale</span>

        {diverging ? (
          /* A correlation map is symmetric about zero: the only meaningful
             adjustment is how far out the ends reach. Narrowing it is how you
             see weak correlations that ±1 flattens to near-white. */
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            ±
            <input
              type="number" min={0.05} max={1} step={0.05}
              value={settings.divergingLimit}
              onChange={e => set({ divergingLimit: Math.min(1, Math.max(0.05,
                parseFloat(e.target.value) || 1)) })}
              style={num}
            />
            <input
              type="range" min={0.05} max={1} step={0.05}
              value={settings.divergingLimit}
              onChange={e => set({ divergingLimit: parseFloat(e.target.value) })}
              style={{ width: 130, accentColor: 'var(--accent)' }}
            />
          </label>
        ) : (
          <>
            {MODES.map(m => (
              <button key={m.id} title={m.help}
                      onClick={() => set({ mode: m.id })}
                      style={btn(settings.mode === m.id)}>{m.label}</button>
            ))}

            {settings.mode !== 'auto' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6,
                              marginLeft: 4 }}
                     title={'Put the ends of the scale at percentiles instead '
                          + 'of the extremes, so a few very large values stop '
                          + 'compressing everything else into one colour.'}>
                <span style={{ color: 'var(--text-muted)' }}>clip</span>
                <select
                  value={settings.clip}
                  onChange={e => set({ clip: e.target.value as ClipLevel })}
                  style={{ ...num, width: 94, fontFamily: 'inherit' }}
                >
                  {CLIPS.map(c => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </label>
            )}

            {settings.mode === 'manual' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--text-muted)' }}>from</span>
                <input
                  type="number" step="any"
                  value={settings.manualMin ?? (range ? Number(range.zmin.toPrecision(4)) : 0)}
                  onChange={e => set({ manualMin: e.target.value === '' ? null
                                                : parseFloat(e.target.value) })}
                  style={num}
                />
                <span style={{ color: 'var(--text-muted)' }}>to</span>
                <input
                  type="number" step="any"
                  value={settings.manualMax ?? (range ? Number(range.zmax.toPrecision(4)) : 1)}
                  onChange={e => set({ manualMax: e.target.value === '' ? null
                                                : parseFloat(e.target.value) })}
                  style={num}
                />
                <button onClick={() => set({ manualMin: null, manualMax: null })}
                        style={{ ...btn(false), padding: '3px 8px' }}>reset</button>
              </label>
            )}
          </>
        )}
      </div>

      {/* What is actually being drawn, and what it costs. Clipping hides
          magnitude, so it has to be stated rather than left to be discovered. */}
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {range ? (
          <>
            Showing <strong style={{ color: 'var(--text-secondary)',
                                     fontFamily: 'var(--font-mono)' }}>
              {fmtScale(range.zmin)} – {fmtScale(range.zmax)}{u}
            </strong>
            {stats && (
              <> · data spans {fmtScale(range.dataMin)} – {fmtScale(range.dataMax)}{u}
                {pooledFrom && pooledFrom > 1
                  ? ` across ${pooledFrom} maps` : ''}</>
            )}
            {(range.clippedHigh || range.clippedLow) && (
              <span style={{ color: 'var(--orange, #f79f4f)' }}>
                {' '}· values{range.clippedHigh ? ` above ${fmtScale(range.zmax)}${u}` : ''}
                {range.clippedHigh && range.clippedLow ? ' and' : ''}
                {range.clippedLow ? ` below ${fmtScale(range.zmin)}${u}` : ''}
                {' '}are drawn at the end colour, so differences beyond that are
                not visible
              </span>
            )}
          </>
        ) : (
          <>Each map scales to its own values — good contrast within a map,
            but colours are <strong>not comparable between maps</strong>.</>
        )}
        {approximate && settings.mode !== 'auto' && (
          <span style={{ color: 'var(--orange, #f79f4f)' }}>
            {' '}· range measured from the matrices currently loaded, not every
            replica — re-run the analysis for an exact pooled range
          </span>
        )}
      </div>
    </div>
  )
}

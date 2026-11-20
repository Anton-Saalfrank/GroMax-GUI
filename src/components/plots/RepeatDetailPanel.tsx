/**
 * Picking the analyses for one run, and reading them at one moment.
 *
 * The time marker is the reason this mode exists. Four aligned panels tell you
 * that something happens around 345 ns; a marker and a readout tell you what
 * every observable was AT 345 ns, and hand that moment to the structure viewer.
 * Without it the mode is four plots next to each other.
 */
import React from 'react'
import { Star } from 'lucide-react'
import { groupMetricKeys } from '../../lib/analysisCategories'

export interface PanelInfo { key: string; label: string; unit: string; colour: string }

export function RepeatDetailPanel({
  allKeys, labelFor, selected, onSelect, panels, skipped,
  cursorNs, onCursor, span, valuesAt, onOpenStructure, repLabel,
  favourites, onToggleFavourite,
}: {
  allKeys: string[]
  labelFor: (k: string) => string
  selected: string[]
  onSelect: (keys: string[]) => void
  /** Metric keys starred by the user; lifted into their own group. */
  favourites: string[]
  onToggleFavourite: (k: string) => void
  panels: PanelInfo[]
  skipped: string[]
  cursorNs: number | null
  onCursor: (v: number | null) => void
  span: [number, number] | null
  /** Each panel's value at the marker, interpolated onto its own samples. */
  valuesAt: { label: string; unit: string; colour: string; value: number | null }[]
  onOpenStructure: () => void
  repLabel: string
}) {
  const toggle = (k: string) => onSelect(
    selected.includes(k) ? selected.filter(x => x !== k) : [...selected, k])

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '3px 9px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
    background: active ? 'var(--accent)' : 'var(--bg-surface)',
    color: active ? '#fff' : 'var(--text-secondary)',
    border: `1px solid ${active ? 'transparent' : 'var(--border)'}`,
    fontWeight: active ? 600 : 400,
  })

  /*
   * The star and the label are SIBLING buttons inside one pill, not a button
   * inside a button — the latter is invalid HTML and browsers resolve it by
   * dropping one of the click targets, which is how you get a star that does
   * nothing on one browser and selects the analysis on another.
   */
  const starBtn = (k: string) => {
    const on = favourites.includes(k)
    return (
      <button
        onClick={e => { e.stopPropagation(); onToggleFavourite(k) }}
        title={on ? `Unstar ${labelFor(k)}` : `Star ${labelFor(k)} to keep it at the top`}
        aria-pressed={on}
        style={{
          display: 'flex', alignItems: 'center', padding: '0 5px 0 2px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: on ? 'var(--amber, #f7d24f)' : 'var(--text-muted)',
          opacity: on ? 1 : 0.5,
        }}>
        <Star size={10} fill={on ? 'currentColor' : 'none'} />
      </button>
    )
  }

  const groups = groupMetricKeys(allKeys, favourites, labelFor)

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4,
                    textTransform: 'uppercase' }}>
        Analyses to stack
      </div>

      {groups.map(g => (
        <div key={g.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8,
                                 marginBottom: 5 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', width: 112,
                        flexShrink: 0, textAlign: 'right', paddingTop: 4 }}
               title={g.label}>
            {g.label}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {g.keys.map(k => {
              const active = selected.includes(k)
              return (
                <span key={k} style={{
                  display: 'inline-flex', alignItems: 'center',
                  borderRadius: 5, overflow: 'hidden',
                  background: active ? 'var(--accent)' : 'var(--bg-surface)',
                  border: `1px solid ${active ? 'transparent' : 'var(--border)'}`,
                }}>
                  <button onClick={() => toggle(k)} style={{
                    padding: '3px 4px 3px 9px', fontSize: 11, cursor: 'pointer',
                    background: 'transparent', border: 'none',
                    color: active ? '#fff' : 'var(--text-secondary)',
                    fontWeight: active ? 600 : 400,
                  }}>
                    {labelFor(k)}
                  </button>
                  {starBtn(k)}
                </span>
              )
            })}
          </div>
        </div>
      ))}

      {selected.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <button onClick={() => onSelect([])} style={{ ...chip(false), opacity: 0.8 }}>
            clear
          </button>
        </div>
      )}

      {selected.length === 0 && panels.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          Nothing picked, so the first {panels.length} time-based{' '}
          {panels.length === 1 ? 'analysis is' : 'analyses are'} shown.
        </div>
      )}

      {skipped.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          Not available here: <strong>{skipped.join(', ')}</strong> — these are
          per-residue, not per-frame, so they have no time axis to share.
        </div>
      )}

      {/* ── The moment ─────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '8px 10px', borderRadius: 6, fontSize: 11,
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
      }}>
        <span style={{ color: 'var(--text-muted)' }}>Marker</span>
        <input
          type="number" step="any"
          value={cursorNs === null ? '' : Number(cursorNs.toFixed(3))}
          placeholder={span ? `${span[0].toFixed(1)}–${span[1].toFixed(1)}` : 'ns'}
          onChange={e => onCursor(e.target.value === '' ? null : parseFloat(e.target.value))}
          style={{
            width: 90, padding: '3px 6px', fontSize: 11,
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg)', color: 'var(--text)',
            fontFamily: 'var(--font-mono)',
          }}
        />
        <span style={{ color: 'var(--text-muted)' }}>ns — or click the plot</span>

        {cursorNs !== null && (
          <>
            <button onClick={() => onCursor(null)} style={chip(false)}>clear</button>
            <button onClick={onOpenStructure} style={chip(true)}
                    title={`Dump ${repLabel} at ${cursorNs.toFixed(2)} ns and open it in `
                         + `the Structure tab, with your highlights applied.`}>
              Open structure at {cursorNs.toFixed(2)} ns
            </button>
          </>
        )}
      </div>

      {cursorNs !== null && valuesAt.length > 0 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6,
                      fontSize: 11, fontFamily: 'var(--font-mono)' }}>
          {valuesAt.map(v => (
            <span key={v.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2,
                             background: v.colour, display: 'inline-block' }} />
              {v.label}:{' '}
              <strong>
                {v.value === null || !Number.isFinite(v.value)
                  ? '—' : v.value.toFixed(3)}
              </strong>
              {v.unit ? ` ${v.unit}` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Picking the analyses for one run, and reading them at one moment.
 *
 * The time marker is the reason this mode exists. Four aligned panels tell you
 * that something happens around 345 ns; a marker and a readout tell you what
 * every observable was AT 345 ns, and hand that moment to the structure viewer.
 * Without it the mode is four plots next to each other.
 */
import React from 'react'

export interface PanelInfo { key: string; label: string; unit: string; colour: string }

export function RepeatDetailPanel({
  allKeys, labelFor, selected, onSelect, panels, skipped,
  cursorNs, onCursor, span, valuesAt, onOpenStructure, repLabel,
}: {
  allKeys: string[]
  labelFor: (k: string) => string
  selected: string[]
  onSelect: (keys: string[]) => void
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

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4,
                    textTransform: 'uppercase' }}>
        Analyses to stack
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        {allKeys.map(k => (
          <button key={k} onClick={() => toggle(k)} style={chip(selected.includes(k))}>
            {labelFor(k)}
          </button>
        ))}
        {selected.length > 0 && (
          <button onClick={() => onSelect([])} style={{ ...chip(false), opacity: 0.8 }}>
            clear
          </button>
        )}
      </div>

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

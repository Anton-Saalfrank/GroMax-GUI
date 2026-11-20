/**
 * Axis scales for Repeat detail, beside the plot rather than behind a menu.
 *
 * This is deliberately always visible. The whole failure it addresses is
 * invisible — autoscaled panels redraw a quiet run and a violent one as the
 * same picture, and nothing on screen says the scale moved — so a control
 * hidden in a settings drawer would leave the reader of the figure in exactly
 * the position they started: unable to tell, at a glance, whether what they
 * are comparing is comparable. Each row states the scale it is actually using,
 * next to the panel it governs.
 */
import type React from 'react'
import { AXIS_LOCK_HELP, AXIS_LOCK_LABELS } from '../../lib/axisLock'
import type { AxisLock, AxisLockMode, Extent } from '../../lib/axisLock'

const MODES: AxisLockMode[] = ['repeats', 'all', 'auto', 'manual']

export interface AxisRow {
  /** Metric key, or '__x__' for the shared time axis. */
  key: string
  label: string
  unit: string
  /** Swatch colour, matching the trace. Absent for the time axis. */
  colour?: string
  lock: AxisLock
  extents: { repeats: Extent | null; all: Extent | null }
  /** What the plot will actually draw, after the lock resolves. */
  applied: [number, number] | undefined
}

export function RepeatAxisPanel({ rows, onChange, nRepeats, nConditions,
                                 yApplies }: {
  rows: AxisRow[]
  onChange: (key: string, patch: Partial<AxisLock>) => void
  nRepeats: number
  nConditions: number
  /**
   * False in the overlaid layout, where every series has been normalised onto
   * one axis and a range in nm belongs to none of them. The Y rows are then
   * shown DISABLED with the reason, rather than hidden: hiding them makes the
   * panel change shape when you switch layout and leaves the user guessing
   * where the per-analysis scales went.
   */
  yApplies: boolean
}) {
  const label: React.CSSProperties = {
    fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase',
  }
  const numBox: React.CSSProperties = {
    width: 62, padding: '2px 5px', fontSize: 11,
    border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg)', color: 'var(--text)',
    fontFamily: 'var(--font-mono)',
  }

  const fmt = (v: number | undefined) =>
    v === undefined || !Number.isFinite(v) ? '—' : String(Number(v.toFixed(3)))

  return (
    <div style={{
      width: 236, flexShrink: 0, alignSelf: 'flex-start',
      padding: '10px 12px', borderRadius: 6,
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      fontSize: 11,
    }}>
      <div style={{ ...label, marginBottom: 2 }}>Axis scales</div>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
        Locked axes keep the same scale as you page through repeats, so the
        comparison survives the switch.
      </div>

      {!yApplies && (
        <div style={{ marginBottom: 10, padding: '6px 8px', borderRadius: 5,
                      lineHeight: 1.5, color: 'var(--text-secondary)',
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)' }}>
          The overlaid layout normalises every series onto one axis, so only the
          time axis can be scaled. Switch to <strong>stacked panels</strong> for
          per-analysis ranges.
        </div>
      )}

      {rows.map(r => {
        const manual = r.lock.mode === 'manual'
        const isX = r.key === '__x__'
        const live = isX || yApplies
        return (
          <div key={r.key} style={{
            marginBottom: 10, paddingBottom: 10,
            borderBottom: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5,
                          marginBottom: 4 }}>
              {r.colour && (
                <span style={{ width: 8, height: 8, borderRadius: 2,
                               background: r.colour, flexShrink: 0 }} />
              )}
              <span style={{ fontWeight: 600, overflow: 'hidden',
                             textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={r.label}>
                {isX ? 'Time (x, shared)' : r.label}
              </span>
            </div>

            <select
              value={r.lock.mode}
              disabled={!live}
              onChange={e => onChange(r.key, { mode: e.target.value as AxisLockMode })}
              title={live ? AXIS_LOCK_HELP[r.lock.mode]
                          : 'Only the time axis applies in the overlaid layout'}
              style={{ fontSize: 11, width: '100%', marginBottom: 4,
                       opacity: live ? 1 : 0.45 }}>
              {MODES.map(m => (
                <option key={m} value={m}>{AXIS_LOCK_LABELS[m]}</option>
              ))}
            </select>

            {!live ? null : manual ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="number" step="any" style={numBox}
                  placeholder={fmt(r.extents.repeats?.min)}
                  value={r.lock.min ?? ''}
                  onChange={e => onChange(r.key, {
                    min: e.target.value === '' ? undefined : Number(e.target.value) })} />
                <span style={{ color: 'var(--text-muted)' }}>to</span>
                <input
                  type="number" step="any" style={numBox}
                  placeholder={fmt(r.extents.repeats?.max)}
                  value={r.lock.max ?? ''}
                  onChange={e => onChange(r.key, {
                    max: e.target.value === '' ? undefined : Number(e.target.value) })} />
              </div>
            ) : (
              /*
               * The resolved numbers, not just the mode name. "Lock across
               * repeats" does not tell you whether the window is 0.2–0.4 or
               * 0.2–3.1 nm, and that difference is the reason one panel looks
               * flat.
               */
              <div style={{ color: 'var(--text-muted)',
                            fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                {r.applied
                  ? `${fmt(r.applied[0])} – ${fmt(r.applied[1])}${r.unit ? ' ' + r.unit : ''}`
                  : 'fitted to this repeat'}
              </div>
            )}
          </div>
        )
      })}

      {rows.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['repeats', 'auto'] as AxisLockMode[]).map(m => (
            <button key={m}
              onClick={() => rows.forEach(r => {
                if (r.key === '__x__' || yApplies) onChange(r.key, { mode: m })
              })}
              style={{
                padding: '3px 8px', borderRadius: 4, fontSize: 10,
                background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                border: '1px solid var(--border)', cursor: 'pointer',
              }}>
              All: {AXIS_LOCK_LABELS[m].toLowerCase()}
            </button>
          ))}
        </div>
      )}

      <div style={{ color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5,
                    fontSize: 10 }}>
        {nRepeats} repeat{nRepeats === 1 ? '' : 's'} here
        {nConditions > 1 && `, ${nConditions} conditions`}.
      </div>
    </div>
  )
}

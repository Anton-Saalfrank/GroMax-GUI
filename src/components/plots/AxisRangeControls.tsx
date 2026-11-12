/**
 * Typing the visible window instead of dragging for it.
 *
 * Dragging is fine for "roughly there" and hopeless for "residues 120 to 140,
 * 340 to 350 ns". On a map seventy-five columns wide a single pixel is most of
 * a time window, so a drag cannot express a range you already know, and it
 * cannot be repeated exactly on the next map you want to compare against.
 *
 * Values are held as DRAFT TEXT and committed on Enter or blur, not on every
 * keystroke: typing "140" passes through "1" and "14", and applying those would
 * make the plot lurch to a one-residue window and back while you type.
 */
import { useEffect, useState } from 'react'

export interface AxisExtent {
  /** Full data extent, used for the placeholder and for "blank means all". */
  min: number
  max: number
  label: string
  /** Residue numbers step by 1; times do not. */
  integer: boolean
}

export type Range = [number, number] | null

export function AxisRangeControls({ x, y, value, onChange }: {
  x: AxisExtent | null
  y: AxisExtent | null
  value: { x: Range; y: Range }
  onChange: (v: { x: Range; y: Range }) => void
}) {
  /**
   * Text for boxes the user is CURRENTLY editing. Anything not in here is shown
   * from `value`, so the boxes always reflect what the plot is showing —
   * including after a drag — without an effect that has to run first. Syncing
   * through an effect left the boxes blank on the very first render.
   */
  const [draft, setDraft] = useState<Record<string, string>>({})

  const fmt = (v: number | undefined) =>
    v === undefined || !Number.isFinite(v) ? '' : String(Number(v.toFixed(4)))

  const current: Record<string, string> = {
    x0: fmt(value.x?.[0]), x1: fmt(value.x?.[1]),
    y0: fmt(value.y?.[0]), y1: fmt(value.y?.[1]),
  }
  const shownFor = (key: string) => draft[key] ?? current[key] ?? ''

  // Dragging or double-clicking the plot changes the range too; drop any stale
  // draft so the boxes follow rather than arguing with what is on screen.
  // Destructured first: an indexed optional chain inside a dependency array
  // cannot be checked statically, so the four bounds are named here instead.
  const [vx0, vx1] = value.x ?? []
  const [vy0, vy1] = value.y ?? []
  useEffect(() => { setDraft({}) }, [vx0, vx1, vy0, vy1])

  const commit = (edits: Record<string, string>) => {
    const next = { ...current, ...edits }
    const read = (lo: string, hi: string, ext: AxisExtent | null): Range => {
      if (!ext) return null
      const a = lo.trim() === '' ? NaN : Number(lo)
      const b = hi.trim() === '' ? NaN : Number(hi)
      const okA = Number.isFinite(a), okB = Number.isFinite(b)
      // Both blank is the honest way to say "show everything".
      if (!okA && !okB) return null
      // One blank means "from here to the end of the data", which is a common
      // thing to want and would otherwise need looking the number up.
      const from = okA ? a : ext.min
      const to = okB ? b : ext.max
      if (from === to) return null                     // a zero-width view is not a view
      return from < to ? [from, to] : [to, from]       // typed backwards is still a range
    }
    onChange({
      x: read(next.x0 ?? '', next.x1 ?? '', x),
      y: read(next.y0 ?? '', next.y1 ?? '', y),
    })
  }

  const box = (key: string, ext: AxisExtent | null, placeholder: number) => (
    <input
      type="number"
      step={ext?.integer ? 1 : 'any'}
      value={shownFor(key)}
      placeholder={String(Number(placeholder.toFixed(ext?.integer ? 0 : 2)))}
      onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
      onBlur={() => commit(draft)}
      onKeyDown={e => {
        if (e.key === 'Enter') { commit(draft); (e.target as HTMLInputElement).blur() }
        // Abandon a half-typed number and fall back to what is on screen.
        if (e.key === 'Escape') setDraft(d => { const n = { ...d }; delete n[key]; return n })
      }}
      style={{
        width: 72, padding: '3px 6px', fontSize: 11,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg)', color: 'var(--text)',
        fontFamily: 'var(--font-mono)',
      }}
    />
  )

  const group = (ext: AxisExtent | null, k0: string, k1: string) => ext && (
    <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ color: 'var(--text-muted)' }}>{ext.label}</span>
      {box(k0, ext, ext.min)}
      <span style={{ color: 'var(--text-muted)' }}>to</span>
      {box(k1, ext, ext.max)}
    </label>
  )

  const anySet = Boolean(value.x || value.y)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12,
                  marginBottom: 6, flexWrap: 'wrap', fontSize: 11 }}>
      <span style={{ color: 'var(--text-muted)' }}>View</span>
      {group(y, 'y0', 'y1')}
      {group(x, 'x0', 'x1')}
      <button
        onClick={() => { setDraft({}); onChange({ x: null, y: null }) }}
        disabled={!anySet}
        title="Show the whole map again"
        style={{
          padding: '3px 9px', borderRadius: 4, fontSize: 11,
          background: 'var(--bg-surface)',
          color: anySet ? 'var(--text-secondary)' : 'var(--text-muted)',
          border: '1px solid var(--border)',
          opacity: anySet ? 1 : 0.5, cursor: anySet ? 'pointer' : 'default',
        }}
      >Whole map</button>
      <span style={{ color: 'var(--text-muted)' }}>
        blank = to the end of the data · Enter to apply
      </span>
    </div>
  )
}

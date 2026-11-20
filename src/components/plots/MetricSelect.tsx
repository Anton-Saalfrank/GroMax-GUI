/**
 * One metric picker, grouped and starrable.
 *
 * Four separate <select>s in the Plot Studio listed every analysis flat, in
 * whatever order `Object.keys` happened to produce — which is insertion order,
 * so it tracked the order things were RUN rather than anything about the
 * analyses themselves. Grouping and starring one of them and not the others
 * would be worse than leaving all four alone, so the control is shared.
 *
 * The star is a sibling button, not part of the <select>. Browsers render
 * <option> content as plain text and give no hook for a click inside one, so a
 * star drawn in the list could be read but never pressed; it has to live
 * outside, acting on whatever is currently chosen.
 */
import { Star } from 'lucide-react'
import { groupMetricKeys } from '../../lib/analysisCategories'

export function MetricSelect({
  value, onChange, keys, labelFor, favourites, onToggleFavourite,
  /** Keys that exist but cannot be picked here, with the reason shown. */
  disabledKeys, width,
}: {
  value: string
  onChange: (k: string) => void
  keys: string[]
  labelFor: (k: string) => string
  favourites: string[]
  onToggleFavourite: (k: string) => void
  disabledKeys?: Set<string>
  width?: number | string
}) {
  const groups = groupMetricKeys(keys, favourites, labelFor)
  const starred = value !== '' && favourites.includes(value)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <select value={value} onChange={e => onChange(e.target.value)}
              style={{ fontSize: 12, width }}>
        {/*
          Groups are emitted even when there is only one, so the heading always
          tells you what kind of thing you are looking at. A lone unlabelled
          option in a menu that is grouped elsewhere reads as a bug.
        */}
        {groups.map(g => (
          <optgroup key={g.id} label={g.label}>
            {g.keys.map(k => (
              <option key={k} value={k} disabled={disabledKeys?.has(k)}>
                {labelFor(k)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        onClick={() => value && onToggleFavourite(value)}
        disabled={!value}
        title={!value ? 'Pick an analysis first'
             : starred ? `Unstar ${labelFor(value)}`
             : `Star ${labelFor(value)} so it stays at the top of these menus`}
        aria-pressed={starred}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, borderRadius: 5, padding: 0,
          background: 'var(--bg-surface)',
          border: `1px solid ${starred ? 'var(--amber, #f7d24f)' : 'var(--border)'}`,
          color: starred ? 'var(--amber, #f7d24f)' : 'var(--text-muted)',
          cursor: value ? 'pointer' : 'default',
          opacity: value ? 1 : 0.4,
        }}>
        <Star size={12} fill={starred ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}

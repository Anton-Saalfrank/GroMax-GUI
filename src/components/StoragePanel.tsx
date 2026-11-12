/**
 * What a project costs on disk, and the one safe way to get some of it back.
 *
 * WHY THIS EXISTS
 * Nothing in the app ever said how much space a project used. On this machine
 * that was 32 GB across thirteen projects, with the home screen offering
 * "archive" as though the only cost of keeping a project were clutter.
 *
 * WHY THE BREAKDOWN, NOT A TOTAL
 * A total tells you that you have a problem, not what to do about it. The split
 * separates the 11 GB of analysis results that cost hours of compute from the
 * 300 MB of cache that costs seconds — so the obvious thing to delete is the
 * obvious thing on screen, rather than whatever is easiest to find.
 *
 * WHY MEASURING IS DEFERRED UNTIL THE PANEL IS OPENED
 * It walks every project tree. That is half a second warm and much longer on a
 * cold or networked disk, and the project list must never wait on it.
 */
import { useState } from 'react'
import { HardDrive, ChevronRight, ChevronDown, Archive, Wand2 } from 'lucide-react'
import { useStore } from '../store'
import type { ProjectUsage, UsageCategory } from '../types'

/**
 * Bytes as a person reads them.
 *
 * Decimal units, because this number is compared against what Finder and `du
 * -h` report for the same folder, and disagreeing with them by 7% would make
 * the panel look wrong rather than make the units look right.
 */
export function formatBytes(b: number): string {
  if (!b) return '0 B'
  if (b < 1e3) return `${b} B`
  if (b < 1e6) return `${(b / 1e3).toFixed(0)} kB`
  if (b < 1e9) return `${(b / 1e6).toFixed(b < 1e8 ? 1 : 0)} MB`
  return `${(b / 1e9).toFixed(b < 1e10 ? 2 : 1)} GB`
}

/** A project can appear in both projects/ and archive/ under one id — two of
 *  them do here — so the id alone is not a unique key. */
const rowKey = (p: ProjectUsage) => `${p.archived ? 'a' : 'p'}:${p.id}`

/**
 * One hue per category, from the Okabe–Ito palette the plots already use.
 *
 * Not the theme's own tokens, for two reasons. `--accent-dim` sits next to
 * `--accent` on the same hue (#1d4ed8 against #3b82f6, and closer still in
 * light mode), so "Structure snapshots" and "Analysis results" were two blues
 * nobody could tell apart in a 6px bar; and `--green-dim` is #065f46, which is
 * all but invisible against the dark background. These are mid-tone and
 * colour-blind safe, so one set reads on either theme — and the legend beside
 * every swatch means the colour is a convenience, never the only clue.
 */
const CATEGORY_COLOUR: Record<string, string> = {
  results: '#0072B2',      // blue
  pca: '#CC79A7',          // pink
  cache: '#E69F00',        // amber
  topologies: '#009E73',   // green
  frames: '#56B4E9',       // light blue
  ndx: '#D55E00',          // vermillion
  conditions: '#F0E442',   // yellow
}
const OTHER_COLOUR = 'var(--border-light)'

function Bar({ cats, other, total }: {
  cats: UsageCategory[]; other: number; total: number
}) {
  if (total <= 0) return null
  const parts = [...cats.map(c => ({
    key: c.key, bytes: c.bytes, colour: CATEGORY_COLOUR[c.key] || OTHER_COLOUR,
    label: c.label,
  }))]
  if (other > 0) parts.push({ key: '__other', bytes: other,
                              colour: OTHER_COLOUR, label: 'Other' })
  return (
    <div style={{
      display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden',
      background: 'var(--bg-base)', marginTop: 7,
    }}>
      {parts.map(p => (
        <div key={p.key}
             title={`${p.label} — ${formatBytes(p.bytes)}`}
             style={{ width: `${(p.bytes / total) * 100}%`, background: p.colour }} />
      ))}
    </div>
  )
}

function ProjectRow({ p }: { p: ProjectUsage }) {
  const { reclaimSpace } = useStore()
  const [busy, setBusy] = useState(false)
  const [freed, setFreed] = useState<number | null>(null)
  const [error, setError] = useState('')

  const reclaim = async () => {
    setBusy(true); setError('')
    try { setFreed(await reclaimSpace(p.id)) }
    catch (e: any) { setError(e?.message || 'Could not reclaim') }
    finally { setBusy(false) }
  }

  return (
    <div style={{
      padding: '11px 13px', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', background: 'var(--bg-surface)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
        {p.archived && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10,
            color: 'var(--text-muted)',
          }}><Archive size={10} /> archived</span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600,
                       fontFamily: 'var(--font-mono)' }}>
          {formatBytes(p.total_bytes)}
        </span>
      </div>

      <Bar cats={p.categories} other={p.other_bytes} total={p.total_bytes} />

      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8,
        fontSize: 11, color: 'var(--text-secondary)',
      }}>
        {p.categories.map(c => (
          <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              width: 7, height: 7, borderRadius: 2, flexShrink: 0,
              background: CATEGORY_COLOUR[c.key] || OTHER_COLOUR,
            }} />
            {c.label} <span style={{ fontFamily: 'var(--font-mono)' }}>{formatBytes(c.bytes)}</span>
            {/* Marked rather than coloured differently: "can be rebuilt" is the
                one fact that decides whether deleting it is cheap or painful. */}
            {c.recomputable && (
              <span title="Can be deleted and rebuilt by re-running"
                    style={{ color: 'var(--text-muted)' }}>· rebuildable</span>
            )}
          </span>
        ))}
        {p.error && <span style={{ color: 'var(--red)' }}>{p.error}</span>}
      </div>

      {(p.reclaimable_bytes > 0 || freed !== null || error) && (
        <div style={{
          marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 11,
        }}>
          {freed !== null ? (
            <span style={{ color: 'var(--green)' }}>
              Freed {formatBytes(freed)}. Every analysis is still cached.
            </span>
          ) : (
            <>
              <span style={{ color: 'var(--text-secondary)' }}>
                {formatBytes(p.reclaimable_bytes)} of duplicate engine topologies.
                Replicas of one system share a starting structure, so the files
                are identical.
              </span>
              <button onClick={reclaim} disabled={busy}
                      style={{
                        marginLeft: 'auto', flexShrink: 0, display: 'flex',
                        alignItems: 'center', gap: 5, padding: '4px 10px',
                        borderRadius: 'var(--radius-sm)', fontSize: 11,
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-primary)',
                      }}>
                <Wand2 size={11} /> {busy ? 'Reclaiming…' : 'Reclaim'}
              </button>
            </>
          )}
          {error && <span style={{ color: 'var(--red)' }}>{error}</span>}
        </div>
      )}
    </div>
  )
}

export default function StoragePanel() {
  const { usage, usageLoading, usageError, loadUsage, backendOnline } = useStore()
  const [open, setOpen] = useState(false)

  const toggle = () => {
    const next = !open
    setOpen(next)
    // Measure on open, and again on re-open: analyses run while this is shut.
    if (next && backendOnline) loadUsage()
  }

  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div style={{ marginTop: 20 }}>
      <button onClick={toggle} disabled={!backendOnline}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '6px 2px', background: 'none', border: 'none',
                color: 'var(--text-muted)', fontSize: 12,
              }}>
        <Chevron size={13} /> <HardDrive size={13} /> Storage
        {usage && (
          <span style={{ color: 'var(--text-secondary)' }}>
            — {formatBytes(usage.total_bytes)} across {usage.projects.length} project
            {usage.projects.length === 1 ? '' : 's'}
          </span>
        )}
        {!!usage?.reclaimable_bytes && (
          <span style={{
            padding: '1px 6px', borderRadius: 10, fontSize: 10,
            background: 'var(--green-dim)', color: 'var(--green)',
          }}>
            {formatBytes(usage.reclaimable_bytes)} reclaimable
          </span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {usageLoading && !usage && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 2px' }}>
              Measuring…
            </div>
          )}
          {usageError && (
            <div style={{ fontSize: 11, color: 'var(--red)', padding: '8px 2px' }}>
              {usageError}
            </div>
          )}
          {usage && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {usage.projects.map(p => <ProjectRow key={rowKey(p)} p={p} />)}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                Totals count shared files once, so they agree with what Finder
                reports for the same folder.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * EnginePicker — which analysis software runs the job.
 *
 * A compact control, because it is a setting you change rarely and want to SEE
 * always: when a result is wrong or surprising, "which package produced this"
 * is the first question, and it should never require digging.
 *
 * UNAVAILABLE ENGINES ARE STILL LISTED. Hiding what is not installed makes
 * "this app does not support MDTraj" and "MDTraj is not installed" look
 * identical. Each one carries the reason and the exact install command instead,
 * naming the backend's own Python — installing into the wrong interpreter is
 * the usual way this goes wrong.
 */
import { useEffect, useRef, useState } from 'react'
import { Cpu, Check, AlertTriangle, ExternalLink } from 'lucide-react'
import type { EngineMeta } from '../types'

interface Props {
  engines: EngineMeta[]
  value: string
  onChange: (id: string) => void
}

export default function EnginePicker({ engines, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const current = engines.find(e => e.id === value)

  // Close on an outside click, the way every other popover in this app behaves.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const dot = (ok: boolean) => (
    <span style={{
      width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
      background: ok ? 'var(--green, #34d399)' : 'var(--text-muted)',
    }} />
  )

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Choose which analysis software runs this"
        style={{
          display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px',
          borderRadius: 'var(--radius)', fontSize: 12, cursor: 'pointer',
          background: 'var(--bg-surface)', color: 'var(--text-primary)',
          border: `1px solid ${current?.available === false
            ? 'var(--amber, #fbbf24)' : 'var(--border)'}`,
        }}
      >
        <Cpu size={14} />
        <span style={{ fontWeight: 600 }}>{current?.name || 'Engine'}</span>
        {current && dot(current.available)}
        <span style={{ opacity: 0.5, fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 60,
          width: 380, maxHeight: 460, overflowY: 'auto',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-light)',
          borderRadius: 'var(--radius-lg)', padding: 8,
          boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)',
                        padding: '4px 8px 8px', lineHeight: 1.5 }}>
            Analysis software. All of these read your GROMACS trajectories;
            they differ in which analyses they offer and how selections are
            written.
          </div>

          {engines.map(e => {
            const active = e.id === value
            return (
              <div
                key={e.id}
                onClick={() => { if (e.available) { onChange(e.id); setOpen(false) } }}
                style={{
                  padding: '9px 10px', borderRadius: 'var(--radius)',
                  marginBottom: 4,
                  cursor: e.available ? 'pointer' : 'default',
                  background: active ? 'var(--bg-hover)' : 'transparent',
                  border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
                  opacity: e.available ? 1 : 0.72,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  {dot(e.available)}
                  <strong style={{ fontSize: 12.5 }}>{e.name}</strong>
                  {e.version && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)',
                                   fontFamily: 'var(--font-mono)' }}>
                      {e.version.length > 28 ? e.version.slice(0, 28) + '…' : e.version}
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  {active && <Check size={13} color="var(--accent-bright)" />}
                </div>

                <div style={{ fontSize: 11, color: 'var(--text-muted)',
                              lineHeight: 1.5, marginTop: 4 }}>
                  {e.description}
                </div>

                {e.available && !!e.analyses.length && (
                  <div style={{ fontSize: 10.5, color: 'var(--text-secondary)',
                                marginTop: 5 }}>
                    {e.analyses.length} analyses: {e.analyses.map(a => a.name).join(', ')}
                  </div>
                )}

                {/* Not installed — say why, and exactly what to run. */}
                {!e.available && (
                  <div style={{
                    marginTop: 6, padding: '7px 9px', borderRadius: 4,
                    background: 'rgba(247,210,79,0.10)', fontSize: 11,
                    lineHeight: 1.55,
                  }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <AlertTriangle size={12} style={{ marginTop: 2, flexShrink: 0 }} />
                      <span>{e.reason}</span>
                    </div>
                    {e.install_hint && (
                      <pre style={{
                        margin: '6px 0 0', padding: '6px 8px', borderRadius: 4,
                        background: 'var(--bg)', border: '1px solid var(--border)',
                        fontSize: 10.5, fontFamily: 'var(--font-mono)',
                        whiteSpace: 'pre-wrap', color: 'var(--text-code, var(--text))',
                      }}>{e.install_hint}</pre>
                    )}
                  </div>
                )}

                {/* Caveats worth reading BEFORE a run, not after a result. */}
                {active && e.available && e.notes?.length > 0 && (
                  <ul style={{ margin: '6px 0 0 14px', padding: 0, fontSize: 10.5,
                               color: 'var(--text-muted)', lineHeight: 1.55 }}>
                    {e.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}

                {e.homepage && (
                  <a href={e.homepage} target="_blank" rel="noreferrer"
                     onClick={ev => ev.stopPropagation()}
                     style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                              fontSize: 10.5, marginTop: 6,
                              color: 'var(--accent-bright)', textDecoration: 'none' }}>
                    selection syntax <ExternalLink size={10} />
                  </a>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

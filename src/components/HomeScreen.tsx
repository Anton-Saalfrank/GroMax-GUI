import React, { useState, useEffect } from 'react'
import { FolderOpen, Plus, Clock, FlaskConical, Trash2, AlertCircle,
         Archive, ArchiveRestore, ChevronDown, ChevronRight } from 'lucide-react'
import { useStore } from '../store'
import StoragePanel from './StoragePanel'
import type { SessionSummary } from '../types'

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { createSession } = useStore()

  const submit = async () => {
    if (!name.trim()) return
    setLoading(true)
    setError('')
    try {
      await createSession(name.trim())
      onClose()
    } catch (e: any) {
      setError(e.message)
      setLoading(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-light)',
        borderRadius: 'var(--radius-lg)',
        padding: 32,
        width: 420,
        animation: 'fadeIn 150ms ease',
      }} onClick={e => e.stopPropagation()}>

        <h2 style={{ marginBottom: 6 }}>New Project</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 24, fontSize: 12 }}>
          A project holds your trajectories, conditions, and all analysis results.
        </p>

        <label style={{ display: 'block', color: 'var(--text-secondary)', fontSize: 11, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Project Name
        </label>
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="e.g. TRPV1_WT_vs_A123V"
          style={{ width: '100%', marginBottom: 8 }}
        />
        <p style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 24 }}>
          Saved to ~/.gromax/projects/
        </p>

        {error && (
          <div style={{
            background: '#2d1515', border: '1px solid var(--red)',
            borderRadius: 'var(--radius)', padding: '8px 12px',
            color: 'var(--red)', fontSize: 12, marginBottom: 16,
            display: 'flex', gap: 8, alignItems: 'center'
          }}>
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            padding: '8px 16px', borderRadius: 'var(--radius)',
            background: 'var(--bg-surface)', color: 'var(--text-secondary)',
          }}>Cancel</button>
          <button
            onClick={submit}
            disabled={!name.trim() || loading}
            style={{
              padding: '8px 20px', borderRadius: 'var(--radius)',
              background: 'var(--accent)', color: '#fff', fontWeight: 600,
            }}>
            {loading ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A small square icon button that never triggers the card underneath it. */
function IconButton({ title, onClick, children, danger }: {
  title: string; onClick: () => void; children: React.ReactNode; danger?: boolean
}) {
  return (
    <button
      title={title}
      onClick={e => { e.stopPropagation(); onClick() }}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 9px', borderRadius: 'var(--radius)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)', fontSize: 11,
        color: danger ? 'var(--red)' : 'var(--text-secondary)',
      }}>
      {children}
    </button>
  )
}

function ProjectCard({ session, onOpen, onArchive }: {
  session: SessionSummary; onOpen: () => void; onArchive: () => Promise<void>
}) {
  // Archiving is reversible, but it still moves a folder — so it asks once,
  // inline. A modal for something this cheap to undo would be worse.
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const archive = async () => {
    setBusy(true); setError('')
    try { await onArchive() }
    catch (e: any) { setError(e.message || 'Could not archive'); setBusy(false); setConfirming(false) }
  }

  return (
    <div
      onClick={onOpen}
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '18px 20px',
        cursor: 'pointer',
        transition: 'border-color 150ms, background 150ms',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-light)'
        ;(e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'
        ;(e.currentTarget as HTMLElement).style.background = 'var(--bg-surface)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 'var(--radius)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <FlaskConical size={18} color="var(--accent-bright)" />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }} className="truncate">
            {session.name}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {session.conditions.length === 0 ? (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No conditions yet</span>
            ) : session.conditions.map(c => (
              <span key={c} style={{
                fontSize: 10, padding: '1px 7px',
                background: 'var(--bg-hover)', borderRadius: 10,
                color: 'var(--text-secondary)', border: '1px solid var(--border)',
              }}>{c}</span>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)', fontSize: 11 }}>
            <Clock size={11} />
            {formatDate(session.updated_at)}
          </div>
          {confirming ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                 onClick={e => e.stopPropagation()}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                Archive?
              </span>
              <IconButton title="Move this project to the archive" onClick={archive}>
                {busy ? 'Archiving…' : 'Archive'}
              </IconButton>
              <IconButton title="Leave it where it is"
                          onClick={() => setConfirming(false)}>Cancel</IconButton>
            </div>
          ) : (
            <IconButton title="Archive this project (reversible)"
                        onClick={() => setConfirming(true)}>
              <Archive size={13} />
            </IconButton>
          )}
        </div>
      </div>

      {!!error && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--red)',
                      display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}


/**
 * The archive: everything removed from the project list, with a way back.
 *
 * Deliberately below the fold and collapsed by default. It exists to make
 * removing a project safe, not to be browsed — but it has to be visible enough
 * that nobody believes an archived project is gone.
 */
function ArchivePanel() {
  const { archivedSessions, loadArchived, restoreSession, deleteArchived } = useStore()
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id); setError('')
    try { await fn() }
    catch (e: any) { setError(e.message || 'Failed') }
    finally { setBusy(null); setConfirmDelete(null) }
  }

  if (archivedSessions.length === 0 && !open) {
    return (
      <button onClick={() => { setOpen(true); loadArchived() }}
              style={{
                marginTop: 28, display: 'flex', alignItems: 'center', gap: 7,
                padding: '6px 2px', background: 'none', border: 'none',
                color: 'var(--text-muted)', fontSize: 12,
              }}>
        <ChevronRight size={13} /> <Archive size={13} /> Archive
      </button>
    )
  }

  return (
    <div style={{ marginTop: 28 }}>
      <button onClick={() => { setOpen(o => !o); if (!open) loadArchived() }}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '6px 2px', background: 'none', border: 'none',
                color: 'var(--text-secondary)', fontSize: 12,
              }}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Archive size={13} />
        Archive{archivedSessions.length > 0 ? ` (${archivedSessions.length})` : ''}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {archivedSessions.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)',
                          padding: '10px 14px', border: '1px dashed var(--border)',
                          borderRadius: 'var(--radius)' }}>
              Nothing archived. Archived projects keep all their results and can
              be restored at any time.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {archivedSessions.map(a => (
                <div key={a.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px 16px', borderRadius: 'var(--radius)',
                  background: 'var(--bg-surface)', border: '1px solid var(--border)',
                }}>
                  <Archive size={14} color="var(--text-muted)" style={{ flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }} className="truncate">
                      {a.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {a.conditions.length} condition{a.conditions.length === 1 ? '' : 's'}
                      {a.archived_at ? ` · archived ${formatDate(a.archived_at)}` : ''}
                    </div>
                  </div>

                  {confirmDelete === a.id ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--red)' }}>
                        Delete “{a.name}” and all its results for good?
                      </span>
                      <IconButton title="Delete permanently" danger
                                  onClick={() => act(a.id, () => deleteArchived(a.id))}>
                        {busy === a.id ? 'Deleting…' : 'Delete'}
                      </IconButton>
                      <IconButton title="Keep it"
                                  onClick={() => setConfirmDelete(null)}>Cancel</IconButton>
                    </div>
                  ) : (
                    <>
                      <IconButton title="Put this project back in the list"
                                  onClick={() => act(a.id, () => restoreSession(a.id))}>
                        <ArchiveRestore size={13} />
                        {busy === a.id ? 'Restoring…' : 'Restore'}
                      </IconButton>
                      <IconButton title="Delete permanently — this cannot be undone"
                                  danger onClick={() => setConfirmDelete(a.id)}>
                        <Trash2 size={13} />
                      </IconButton>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {!!error && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--red)' }}>{error}</div>
          )}
        </div>
      )}
    </div>
  )
}

export default function HomeScreen() {
  const { sessions, loadSessions, openSession, backendOnline,
          archiveSession, loadArchived } = useStore()
  const [showNew, setShowNew] = useState(false)
  // Clicking a project used to be able to fail in total silence: the rejection
  // went to the console as an unhandled promise and the card just sat there.
  // A backend that has stopped answering is exactly when this happens, so it
  // is also exactly when the user needs to be told something.
  const [openError, setOpenError] = useState('')

  const open = (id: string) => {
    setOpenError('')
    openSession(id).catch((e: any) =>
      setOpenError(e?.message || 'Could not open that project.'))
  }

  useEffect(() => {
    if (backendOnline) { loadSessions(); loadArchived() }
    // Store actions: stable identities, so these are documentation, not
    // extra re-runs.
  }, [backendOnline, loadSessions, loadArchived])

  return (
    <div style={{
      flex: 1, overflow: 'auto',
      padding: 48,
      maxWidth: 780,
      margin: '0 auto',
      width: '100%',
    }}>
      {/* Header */}
      <div style={{ marginBottom: 48 }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 20, padding: '4px 14px', fontSize: 11,
          color: 'var(--text-secondary)', marginBottom: 20,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
          GROMACS Trajectory Analysis
        </div>
        <h1 style={{ marginBottom: 10 }}>GroMax GUI</h1>
        <p style={{ color: 'var(--text-secondary)', maxWidth: 480, lineHeight: 1.7 }}>
          Upload trajectories, define conditions, run analyses, and compare results —
          all in one place.
        </p>
      </div>

      {/* Backend warning */}
      {!backendOnline && (
        <div style={{
          background: '#2d1a0a', border: '1px solid var(--amber)',
          borderRadius: 'var(--radius)', padding: '12px 16px',
          display: 'flex', gap: 10, alignItems: 'flex-start',
          marginBottom: 32, fontSize: 12,
        }}>
          <AlertCircle size={16} color="var(--amber)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong style={{ color: 'var(--amber)' }}>Backend not reachable.</strong>
            <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>
              Make sure Python is running: <code style={{ color: 'var(--text-code)' }}>cd backend && python main.py</code>
            </span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 36 }}>
        <button
          onClick={() => setShowNew(true)}
          disabled={!backendOnline}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 20px', borderRadius: 'var(--radius)',
            background: 'var(--accent)', color: '#fff', fontWeight: 600,
          }}>
          <Plus size={16} /> New Project
        </button>
        <button
          onClick={loadSessions}
          disabled={!backendOnline}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 16px', borderRadius: 'var(--radius)',
            background: 'var(--bg-surface)', color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}>
          <FolderOpen size={15} /> Refresh
        </button>
      </div>

      {/* Project list */}
      {sessions.length === 0 ? (
        <div style={{
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '48px 32px',
          textAlign: 'center',
          color: 'var(--text-muted)',
        }}>
          <FlaskConical size={32} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
          <div style={{ fontSize: 14, marginBottom: 6 }}>No projects yet</div>
          <div style={{ fontSize: 12 }}>Create a project to get started.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h3 style={{ marginBottom: 8 }}>Recent Projects</h3>
          {!!openError && (
            <div style={{
              display: 'flex', gap: 8, alignItems: 'flex-start',
              padding: '9px 12px', borderRadius: 'var(--radius)',
              border: '1px solid var(--red)', fontSize: 12,
              color: 'var(--red)',
            }}>
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              {openError}
            </div>
          )}
          {sessions.map(s => (
            <ProjectCard key={s.id} session={s} onOpen={() => open(s.id)}
                         onArchive={() => archiveSession(s.id)} />
          ))}
        </div>
      )}

      <ArchivePanel />

      <StoragePanel />

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
    </div>
  )
}

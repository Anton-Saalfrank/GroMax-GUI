import { useState, useEffect } from 'react'
import { CheckCircle2, AlertCircle, Terminal, RotateCcw } from 'lucide-react'
import { api } from '../api/client'

interface GmxStatus {
  found: boolean
  path: string | null
  version: string | null
  error?: string
}

export default function GromaxSettings() {
  const [gmxPath,    setGmxPath]    = useState('')
  const [savedPath,  setSavedPath]  = useState('')
  const [status,     setStatus]     = useState<GmxStatus | null>(null)
  const [verifying,  setVerifying]  = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [debugMsg,   setDebugMsg]   = useState('')

  useEffect(() => {
    setDebugMsg('Loading config…')
    api.config.get()
      .then(cfg => {
        const path = cfg.gmx_path || ''
        setGmxPath(path)
        setSavedPath(path)
        setStatus(cfg.gmx_status ?? null)
        setDebugMsg('')
      })
      .catch(e => setDebugMsg(`Config load failed: ${e.message}`))
  }, [])

  const verify = async (override?: string) => {
    const p = (override ?? gmxPath).trim()
    if (!p) { setDebugMsg('No path entered'); return }
    setVerifying(true)
    setStatus(null)
    setDebugMsg('Sending verify request…')
    try {
      const result = await api.config.verifyGmx(p)
      setDebugMsg('')
      setStatus({
        found:   result.ok,
        path:    result.path ?? p,
        version: result.version ?? null,
        error:   result.error,
      })
    } catch (e: any) {
      setDebugMsg(`Request failed: ${e.message}`)
    } finally {
      setVerifying(false)
    }
  }

  const save = async () => {
    const p = gmxPath.trim()
    setSaving(true)
    setDebugMsg('Saving…')
    try {
      await api.config.update({ gmx_path: p || null })
      setSavedPath(p)
      setDebugMsg('Saved. Verifying…')
      await verify(p)
      setDebugMsg('')
    } catch (e: any) {
      setDebugMsg(`Save failed: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    setGmxPath('')
    setSavedPath('')
    setStatus(null)
    setDebugMsg('')
    await api.config.update({ gmx_path: null }).catch(() => {})
  }

  const isDirty = gmxPath.trim() !== savedPath

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: 20, marginBottom: 24,
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
        <Terminal size={16} color="var(--accent-bright)" />
        <span style={{ fontWeight:700, fontSize:14 }}>GROMACS Path</span>
        {status?.found && (
          <span style={{ fontSize:10, padding:'2px 8px', borderRadius:10, background:'var(--green-dim)', color:'var(--green)', border:'1px solid #065f46' }}>
            ✓ verified
          </span>
        )}
      </div>

      <p style={{ color:'var(--text-secondary)', fontSize:12, marginBottom:12, lineHeight:1.6 }}>
        Full path to your <code style={{ color:'var(--text-code)' }}>gmx</code> binary.
        Find it with: <code style={{ color:'var(--text-code)' }}>conda activate gromacs-2024.2 && which gmx</code>
      </p>

      {/* Input row */}
      <div style={{ display:'flex', gap:8, marginBottom:10 }}>
        <input
          value={gmxPath}
          onChange={e => { setGmxPath(e.target.value); setDebugMsg('') }}
          onKeyDown={e => e.key === 'Enter' && (isDirty ? save() : verify())}
          placeholder="/opt/miniconda3/envs/gromacs-2024.2/bin.ARM_NEON_ASIMD/gmx"
          style={{ flex:1, fontFamily:'var(--font-mono)', fontSize:11 }}
        />
        <button onClick={() => verify()} disabled={!gmxPath.trim() || verifying} style={{ padding:'6px 14px', borderRadius:'var(--radius)', background:'var(--bg-elevated)', color:'var(--text-secondary)', border:'1px solid var(--border-light)', fontSize:12, whiteSpace:'nowrap' }}>
          {verifying ? 'Testing…' : 'Test'}
        </button>
        <button onClick={save} disabled={!gmxPath.trim() || saving} style={{ padding:'6px 14px', borderRadius:'var(--radius)', background:'var(--accent)', color:'#fff', border:'none', fontSize:12, fontWeight:600, whiteSpace:'nowrap' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedPath && (
          <button onClick={reset} title="Clear" style={{ padding:'6px 8px', borderRadius:'var(--radius)', background:'transparent', color:'var(--text-muted)', border:'1px solid var(--border)' }}>
            <RotateCcw size={13} />
          </button>
        )}
      </div>

      {/* Debug message */}
      {debugMsg && (
        <div style={{ fontSize:11, color:'var(--amber)', fontFamily:'var(--font-mono)', marginBottom:8, padding:'4px 8px', background:'rgba(251,191,36,0.07)', borderRadius:'var(--radius-sm)' }}>
          {debugMsg}
        </div>
      )}

      {/* Status */}
      {status && (
        <div style={{ display:'flex', alignItems:'flex-start', gap:9, padding:'10px 12px', borderRadius:'var(--radius)', background: status.found ? '#0a2318' : '#2d1515', border:`1px solid ${status.found ? '#065f46' : '#7f1d1d'}`, fontSize:12 }}>
          {status.found
            ? <CheckCircle2 size={14} color="var(--green)" style={{ flexShrink:0, marginTop:1 }} />
            : <AlertCircle  size={14} color="var(--red)"   style={{ flexShrink:0, marginTop:1 }} />}
          <div>
            {status.found ? (
              <>
                <span style={{ color:'var(--green)', fontWeight:600 }}>GROMACS found. </span>
                <span style={{ color:'var(--text-secondary)' }}>{status.version}</span>
                <div style={{ color:'var(--text-muted)', fontFamily:'var(--font-mono)', fontSize:10, marginTop:3 }}>{status.path}</div>
              </>
            ) : (
              <>
                <span style={{ color:'var(--red)', fontWeight:600 }}>Not found. </span>
                <span style={{ color:'var(--text-secondary)' }}>{status.error}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Prefill hint */}
      {!status && !debugMsg && !gmxPath && (
        <div style={{ fontSize:11, color:'var(--text-muted)' }}>
          Your path: <span
            onClick={() => setGmxPath('/opt/miniconda3/envs/gromacs-2024.2/bin.ARM_NEON_ASIMD/gmx')}
            style={{ color:'var(--accent-bright)', cursor:'pointer', textDecoration:'underline' }}>
            click to prefill your known path
          </span>
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import {
  FolderSearch, CheckCircle2, AlertCircle, Link2, Unlink2, Loader2
} from 'lucide-react'
import { api } from '../api/client'
import type { Condition, Replica } from '../types'

interface Props {
  condition: Condition
  sessionId: string
  onDone: () => void
}

export default function FileRegistration({ condition, sessionId, onDone }: Props) {
  const [folder, setFolder]       = useState(condition.source_dir || '')
  const [tprPat, setTprPat]       = useState('*.tpr')
  const [xtcPat, setXtcPat]       = useState('*.pbc.xtc')
  const [scanning, setScanning]   = useState(false)
  const [replicas, setReplicas]   = useState<Replica[]>(condition.replicas || [])
  const [pdbCandidates, setPdbs]  = useState<string[]>([])
  const [selectedPdb, setPdb]     = useState<string | null>(condition.pdb || null)
  const [error, setError]         = useState('')
  const [registering, setReg]     = useState(false)
  const [scanned, setScanned]     = useState((condition.replicas?.length || 0) > 0)

  const doScan = async () => {
    if (!folder.trim()) return
    setScanning(true); setError('')
    try {
      const res = await api.files.scan(folder.trim(), tprPat, xtcPat)
      setReplicas(res.replicas)
      setPdbs(res.pdb_candidates)
      if (res.pdb_candidates.length > 0 && !selectedPdb) {
        setPdb(res.pdb_candidates[0])
      }
      setScanned(true)
    } catch (e: any) {
      setError(e.message)
      setReplicas([])
    } finally {
      setScanning(false)
    }
  }

  const doRegister = async () => {
    setReg(true); setError('')
    try {
      await api.files.registerScan(sessionId, condition.id, folder.trim(), replicas, selectedPdb)
      onDone()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setReg(false)
    }
  }

  const nPaired = replicas.filter(r => r.paired).length
  const allPaired = replicas.length > 0 && nPaired === replicas.length

  return (
    <div>
      {/* Folder input */}
      <label style={{ display:'block', fontSize:11, color:'var(--text-secondary)', textTransform:'uppercase', letterSpacing:0.5, marginBottom:6 }}>
        Simulation folder
      </label>
      <div style={{ display:'flex', gap:8, marginBottom:10 }}>
        <input
          value={folder}
          onChange={e => setFolder(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doScan()}
          placeholder="/path/to/sims/WT/"
          style={{ flex:1, fontFamily:'var(--font-mono)', fontSize:11 }}
        />
        <button onClick={doScan} disabled={!folder.trim() || scanning} style={{
          display:'flex', alignItems:'center', gap:6, padding:'6px 14px',
          borderRadius:'var(--radius)', background:'var(--accent)', color:'#fff',
          fontWeight:600, fontSize:12, whiteSpace:'nowrap',
        }}>
          {scanning ? <Loader2 size={13} className="spin" /> : <FolderSearch size={13} />}
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {/* Patterns */}
      <div style={{ display:'flex', gap:8, marginBottom:14 }}>
        <div style={{ flex:1 }}>
          <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3 }}>tpr pattern</label>
          <input value={tprPat} onChange={e => setTprPat(e.target.value)}
            style={{ width:'100%', fontFamily:'var(--font-mono)', fontSize:11 }} />
        </div>
        <div style={{ flex:1 }}>
          <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3 }}>xtc pattern</label>
          <input value={xtcPat} onChange={e => setXtcPat(e.target.value)}
            style={{ width:'100%', fontFamily:'var(--font-mono)', fontSize:11 }} />
        </div>
      </div>

      {error && (
        <div style={{ display:'flex', gap:8, alignItems:'center', padding:'8px 12px',
          borderRadius:'var(--radius)', background:'#2d1515', border:'1px solid var(--red)',
          color:'var(--red)', fontSize:12, marginBottom:12 }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Scan results */}
      {scanned && replicas.length > 0 && (
        <div style={{ marginBottom:14 }}>
          {/* Pairing summary */}
          <div style={{
            display:'flex', alignItems:'center', gap:8, marginBottom:10,
            padding:'8px 12px', borderRadius:'var(--radius)',
            background:'var(--bg-surface)',
            border:`1px solid ${allPaired ? '#065f46' : 'var(--amber)'}`,
          }}>
            {allPaired ? <Link2 size={13} color="var(--green)" /> : <Unlink2 size={13} color="var(--amber)" />}
            <span style={{ fontSize:12, fontWeight:600, color: allPaired ? 'var(--green)' : 'var(--amber)' }}>
              {nPaired}/{replicas.length} replicas paired
            </span>
            <span style={{ fontSize:11, color:'var(--text-muted)' }}>by number in filename</span>
          </div>

          {/* Replica list */}
          <div style={{ display:'flex', flexDirection:'column', gap:3, maxHeight:220, overflow:'auto' }}>
            {replicas.map(r => (
              <div key={r.index} style={{
                display:'flex', alignItems:'center', gap:8, padding:'5px 10px',
                borderRadius:'var(--radius-sm)', background:'var(--bg-elevated)',
                border:'1px solid var(--border)', fontSize:11,
              }}>
                <span style={{ fontFamily:'var(--font-mono)', fontSize:10, width:20, textAlign:'right',
                  color:'var(--text-muted)' }}>#{r.index}</span>
                <span style={{ flex:1, color: r.tpr ? 'var(--text-primary)':'var(--red)' }} className="truncate">
                  {r.tpr_name ?? '⚠ no tpr'}
                </span>
                <span style={{ color:'var(--border-light)' }}>↔</span>
                <span style={{ flex:1, color: r.xtc ? 'var(--text-primary)':'var(--red)' }} className="truncate">
                  {r.xtc_name ?? '⚠ no xtc'}
                </span>
                {r.paired
                  ? <CheckCircle2 size={12} color="var(--green)" />
                  : <AlertCircle size={12} color="var(--amber)" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {scanned && replicas.length === 0 && !error && (
        <div style={{ padding:'12px', textAlign:'center', color:'var(--text-muted)', fontSize:12,
          border:'1px dashed var(--border)', borderRadius:'var(--radius)', marginBottom:14 }}>
          No tpr/xtc files matched. Check your patterns and folder path.
        </div>
      )}

      {/* PDB selection */}
      {scanned && (
        <div style={{ marginBottom:14 }}>
          <label style={{ display:'block', fontSize:11, color:'var(--text-secondary)', textTransform:'uppercase', letterSpacing:0.5, marginBottom:6 }}>
            Reference structure (pdb/gro)
          </label>
          {pdbCandidates.length > 0 ? (
            <select value={selectedPdb || ''} onChange={e => setPdb(e.target.value)}
              style={{ width:'100%', fontFamily:'var(--font-mono)', fontSize:11 }}>
              {pdbCandidates.map(p => (
                <option key={p} value={p}>{p.split('/').pop()}</option>
              ))}
            </select>
          ) : (
            <input placeholder="/path/to/reference.pdb" value={selectedPdb || ''}
              onChange={e => setPdb(e.target.value)}
              style={{ width:'100%', fontFamily:'var(--font-mono)', fontSize:11 }} />
          )}
        </div>
      )}

      {/* Register */}
      {scanned && nPaired > 0 && (
        <button onClick={doRegister} disabled={registering} style={{
          width:'100%', padding:'10px', borderRadius:'var(--radius)',
          background:'var(--accent)', color:'#fff', fontWeight:600, fontSize:13,
        }}>
          {registering ? 'Registering…' : `Register ${nPaired} replica${nPaired>1?'s':''} to ${condition.name}`}
        </button>
      )}
    </div>
  )
}

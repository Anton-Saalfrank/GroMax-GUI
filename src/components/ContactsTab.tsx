import React, { useState, useEffect } from 'react'
import { Radar, Play, Boxes } from 'lucide-react'
import { api } from '../api/client'
import { useStore } from '../store'
import ChainResiduePicker from './ChainResiduePicker'

export default function ContactsTab({ sessionId }: { sessionId: string }) {
  const { activeSession, setJobsPanelOpen, pollJobs, jobs } = useStore()
  const conditions = Object.values(activeSession?.conditions ?? {})
  const ready = conditions.filter(c => (c.replicas?.filter(r => r.paired).length || 0) > 0)

  const [condIds, setCondIds] = useState<string[]>([])
  const [target, setTarget] = useState('')
  const [cutoff, setCutoff] = useState('0.4')
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'distance' | 'hbond'>('distance')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [hasSystem, setHasSystem] = useState(false)
  const [msg, setMsg] = useState('')
  // Frame filter
  const [useFilter, setUseFilter] = useState(false)
  const [filterName, setFilterName] = useState('')
  const [filterOp, setFilterOp] = useState<'>' | '<' | '>=' | '<='>('>')
  const [filterThreshold, setFilterThreshold] = useState('1')

  // Completed per-frame (line) analyses available as filter metrics
  const lineMetrics = React.useMemo(() => {
    const names = new Set<string>()
    for (const j of jobs) {
      const r = j.result
      if (j.status === 'completed' && r && r.kind === 'line' && (r as any).analysis_name)
        names.add((r as any).analysis_name)
    }
    return Array.from(names)
  }, [jobs])

  // Named rather than inlined, so the dependency can be checked. Pick a
  // default metric once one exists; the guard keeps it from overriding a
  // choice the user has made.
  const firstMetric = lineMetrics[0]
  useEffect(() => { if (!filterName && firstMetric) setFilterName(firstMetric) },
            [filterName, firstMetric])

  // Keyed on the ids, not the count: a same-size change of membership would
  // otherwise leave condIds naming a condition that is no longer ready.
  const readyIdsKey = ready.map(c => c.id).join(',')
  useEffect(() => { setCondIds(readyIdsKey ? readyIdsKey.split(',') : []) },
            [activeSession?.id, readyIdsKey])
  useEffect(() => { api.system.get(sessionId).then(r => setHasSystem(r.defined)).catch(() => {}) }, [sessionId])

  const launch = async () => {
    if (!target.trim() || condIds.length === 0) return
    setMsg('')
    try {
      await api.contacts.run({
        session_id: sessionId, condition_ids: condIds,
        target_selection: target.trim(), cutoff_nm: parseFloat(cutoff), name,
        mode,
        filter_name: useFilter ? filterName : undefined,
        filter_op: useFilter ? filterOp : undefined,
        filter_threshold: useFilter ? parseFloat(filterThreshold) : undefined,
      })
      setMsg('Contact query launched — watch the Jobs panel.')
      setJobsPanelOpen(true); pollJobs()
    } catch (e: any) { setMsg(`Error: ${e.message}`) }
  }

  if (ready.length === 0) {
    return (
      <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <div style={{ textAlign:'center', color:'var(--text-muted)', maxWidth:320 }}>
          <Radar size={40} style={{ margin:'0 auto 12px', opacity:0.25 }} />
          <div style={{ fontSize:15, fontWeight:600, marginBottom:6, color:'var(--text-secondary)' }}>No conditions ready</div>
          <div style={{ fontSize:12 }}>Register conditions with replicas first.</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex:1, overflow:'auto', padding:'24px 28px' }}>
      <div style={{ maxWidth:720 }}>
        <h2 style={{ marginBottom:4 }}>Residue contacts</h2>
        <p style={{ color:'var(--text-secondary)', fontSize:12, marginBottom:16, lineHeight:1.6 }}>
          Find which residues contact a residue of interest across the trajectory. For each residue,
          reports the fraction of frames it's in contact with your target (occupancy), averaged
          over replicas and mapped back to biological identity.
        </p>

        {/* Mode toggle */}
        <div style={{ display:'flex', gap:8, marginBottom:20 }}>
          {(['distance','hbond'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding:'7px 16px', borderRadius:'var(--radius)', fontSize:12, fontWeight: mode===m?600:400,
              background: mode===m ? 'var(--accent)' : 'var(--bg-surface)',
              color: mode===m ? '#fff' : 'var(--text-secondary)',
              border:`1px solid ${mode===m ? 'transparent' : 'var(--border)'}`,
            }}>{m === 'distance' ? 'Distance contacts' : 'Hydrogen bonds'}</button>
          ))}
        </div>
        {mode === 'hbond' && (
          <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:18, lineHeight:1.5, padding:'8px 12px', background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)' }}>
            H-bond mode uses <code style={{ color:'var(--text-code)' }}>gmx hbond</code> with geometric criteria (distance + angle). Cutoff is the donor–acceptor distance (min 0.35 nm). Reports which residues form H-bonds with your target and how often. Note: the frame filter isn't applied in H-bond mode yet.
          </div>
        )}

        <h3 style={{ marginBottom:8 }}>Target residue</h3>
        <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:6, position:'relative' }}>
          <input value={target} onChange={e => setTarget(e.target.value)}
            placeholder="e.g. ri 200  ·  or  resindex 200 and name OD1 OD2"
            style={{ flex:1, fontFamily:'var(--font-mono)', fontSize:12 }} />
          {hasSystem && (
            <button onClick={() => setPickerOpen(o => !o)} style={{
              display:'flex', alignItems:'center', gap:5, padding:'7px 12px', borderRadius:'var(--radius)', fontSize:11,
              background:'var(--bg-elevated)', color:'var(--accent-bright)', border:'1px solid var(--border-light)',
            }}><Boxes size={12} /> chain</button>
          )}
          {pickerOpen && (
            <ChainResiduePicker sessionId={sessionId}
              onApply={(ri) => { setTarget(ri); setPickerOpen(false) }}
              onClose={() => setPickerOpen(false)} />
          )}
        </div>
        <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:20 }}>
          Accepts <code style={{ color:'var(--text-code)' }}>ri N</code>, <code style={{ color:'var(--text-code)' }}>200</code>, or a range like <code style={{ color:'var(--text-code)' }}>200-205</code>. The chain picker fills this in for you.
          <br />
          <strong style={{ color:'var(--text-secondary)' }}>Atom-level targets</strong> also work — write a full gmx selection and it's passed through as-is:
          {' '}<code style={{ color:'var(--text-code)' }}>resindex 200 and name OD1 OD2</code> (carboxylate only),
          {' '}<code style={{ color:'var(--text-code)' }}>resindex 200 and not name N CA C O</code> (sidechain only).
          The target's whole residue is always excluded from the results.
        </div>

        <div style={{ display:'flex', gap:16, alignItems:'flex-end', marginBottom:20, flexWrap:'wrap' }}>
          <div>
            <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Cutoff (nm)</label>
            <input value={cutoff} onChange={e => setCutoff(e.target.value)} style={{ width:80, fontSize:12, fontFamily:'var(--font-mono)' }} />
          </div>
          <div>
            <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Name (optional)</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. D629_contacts" style={{ width:200, fontSize:12, fontFamily:'var(--font-mono)' }} />
          </div>
        </div>

        {/* Frame filter (2a) */}
        <div style={{ marginBottom:22, padding:'12px 14px', background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)' }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:'var(--text-secondary)', cursor:'pointer', marginBottom: useFilter ? 12 : 0 }}>
            <input type="checkbox" checked={useFilter} onChange={e => setUseFilter(e.target.checked)} style={{ accentColor:'var(--accent)' }} />
            <strong>Frame filter</strong> — only count contacts during frames where a metric passes a threshold
          </label>
          {useFilter && (
            lineMetrics.length === 0 ? (
              <div style={{ fontSize:11, color:'var(--text-muted)', lineHeight:1.5 }}>
                No per-frame metrics available. Run a mindist/RMSD/Rg analysis first (same conditions & time window), then it'll appear here.
              </div>
            ) : (
              <div style={{ display:'flex', gap:10, alignItems:'flex-end', flexWrap:'wrap' }}>
                <div>
                  <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3, textTransform:'uppercase' }}>Keep frames where</label>
                  <select value={filterName} onChange={e => setFilterName(e.target.value)} style={{ fontSize:12 }}>
                    {lineMetrics.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <select value={filterOp} onChange={e => setFilterOp(e.target.value as any)} style={{ fontSize:12 }}>
                  <option value=">">&gt;</option><option value="<">&lt;</option>
                  <option value=">=">&ge;</option><option value="<=">&le;</option>
                </select>
                <input value={filterThreshold} onChange={e => setFilterThreshold(e.target.value)} style={{ width:70, fontSize:12, fontFamily:'var(--font-mono)' }} />
                <span style={{ fontSize:10, color:'var(--text-muted)', maxWidth:220, lineHeight:1.5 }}>
                  The filter metric must share the same frames (time window & stride) as the trajectory.
                </span>
              </div>
            )
          )}
        </div>

        <h3 style={{ marginBottom:10 }}>Conditions</h3>
        <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:22 }}>
          {ready.map(c => {
            const on = condIds.includes(c.id)
            return (
              <div key={c.id} onClick={() => setCondIds(p => on ? p.filter(x=>x!==c.id) : [...p, c.id])} style={{
                display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:'var(--radius)', cursor:'pointer',
                background: on ? 'var(--bg-elevated)' : 'var(--bg-surface)', border:`1px solid ${on ? 'var(--border-light)' : 'var(--border)'}`,
              }}>
                <div style={{ width:16, height:16, borderRadius:4, border:`2px solid ${on ? c.colour : 'var(--border-light)'}`, background: on ? c.colour : 'transparent', display:'flex', alignItems:'center', justifyContent:'center' }}>
                  {on && <span style={{ color:'#fff', fontSize:10, fontWeight:900 }}>✓</span>}
                </div>
                <span style={{ width:10, height:10, borderRadius:'50%', background:c.colour }} />
                <span style={{ fontWeight:600, fontSize:13 }}>{c.name}</span>
              </div>
            )
          })}
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <button onClick={launch} disabled={!target.trim() || condIds.length===0} style={{
            display:'flex', alignItems:'center', gap:8, padding:'11px 24px', borderRadius:'var(--radius)',
            background: target.trim() ? 'var(--accent)' : 'var(--bg-elevated)', color: target.trim() ? '#fff' : 'var(--text-muted)',
            fontWeight:600, fontSize:14, border:'none',
          }}><Play size={15} /> Run contact query</button>
          {msg && <span style={{ fontSize:12, color: msg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{msg}</span>}
        </div>

        <div style={{ marginTop:20, padding:'10px 14px', background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:11, color:'var(--text-muted)', lineHeight:1.6 }}>
          <strong style={{ color:'var(--text-secondary)' }}>Note:</strong> this uses <code style={{ color:'var(--text-code)' }}>gmx select</code> with a per-frame distance search, which can be slow on long trajectories. Results appear in the Results tab ranked by occupancy. Hydrogen-bond mode (distance + angle) is planned but needs verification against your gmx build first.
        </div>
      </div>
    </div>
  )
}

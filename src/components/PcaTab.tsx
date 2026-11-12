import React, { useState, useEffect } from 'react'
import {
  Play, Layers, CheckCircle2, AlertCircle, Loader2, Wand2, Scale, Boxes
} from 'lucide-react'
import { api } from '../api/client'
import { useStore } from '../store'
import ChainResiduePicker from './ChainResiduePicker'
import type { PcaReplicaFrame, PcaSelectionCheck, PcaReplicaSpec } from '../types'

const BASE_GROUPS = ['C-alpha', 'Backbone', 'Sidechain', 'Protein']

// Estimate frames after applying start/end/stride to a replica
function estFrames(f: PcaReplicaFrame, start: number | null, end: number | null, stride: number): number | null {
  if (f.n_frames == null || f.dt_ps == null || f.t_end_ps == null) return null
  const dtNs = f.dt_ps / 1000
  const tEndNs = f.t_end_ps / 1000
  const s = start ?? 0
  const e = end ?? tEndNs
  const span = Math.max(0, e - s)
  const raw = Math.floor(span / dtNs) + 1
  return Math.max(1, Math.floor(raw / Math.max(1, stride)))
}

// A row that lets the user set start/end/stride once and push to all replicas
function ApplyAllRow({ onApply }: { onApply: (field: 'start_ns'|'end_ns'|'stride', v: number|null) => void }) {
  const [start, setStart] = useState('')
  const [end, setEnd]     = useState('')
  const [stride, setStr]  = useState('')

  const cell: React.CSSProperties = { fontSize: 11, fontFamily: 'var(--font-mono)', padding: '3px 6px', width: 60 }
  const btn: React.CSSProperties = {
    fontSize: 9, padding: '2px 5px', borderRadius: 4, marginLeft: 4,
    background: 'var(--bg-elevated)', color: 'var(--accent-bright)',
    border: '1px solid var(--border-light)',
  }

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.4fr 0.8fr 0.8fr 0.6fr 0.8fr', gap: 0,
      alignItems: 'center', padding: '6px 12px', borderTop: '1px solid var(--border)',
      background: 'rgba(59,130,246,0.04)',
    }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>set all →</span>
      <span style={{ display: 'flex', alignItems: 'center' }}>
        <input value={start} onChange={e => setStart(e.target.value)} placeholder="0" style={cell} />
        <button style={btn} onClick={() => onApply('start_ns', start ? parseFloat(start) : null)}>set</button>
      </span>
      <span style={{ display: 'flex', alignItems: 'center' }}>
        <input value={end} onChange={e => setEnd(e.target.value)} placeholder="end" style={cell} />
        <button style={btn} onClick={() => onApply('end_ns', end ? parseFloat(end) : null)}>set</button>
      </span>
      <span style={{ display: 'flex', alignItems: 'center' }}>
        <input value={stride} onChange={e => setStr(e.target.value)} placeholder="1" style={{ ...cell, width: 40 }} />
        <button style={btn} onClick={() => onApply('stride', Math.max(1, parseInt(stride) || 1))}>set</button>
      </span>
      <span />
    </div>
  )
}

export default function PcaTab({ sessionId }: { sessionId: string }) {
  const { activeSession, setJobsPanelOpen, pollJobs } = useStore()
  const conditions = Object.values(activeSession?.conditions ?? {})
  const ready = conditions.filter(c => (c.replicas?.filter(r => r.paired).length || 0) > 0 && c.pdb)

  const [condIds, setCondIds]       = useState<string[]>([])
  const [baseSel, setBaseSel]       = useState('C-alpha')
  const [include, setInclude]       = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [hasSystem, setHasSystem]   = useState(false)
  const [exclude, setExclude]       = useState('')
  const [check, setCheck]           = useState<PcaSelectionCheck | null>(null)
  const [checking, setChecking]     = useState(false)
  const [frames, setFrames]         = useState<PcaReplicaFrame[]>([])
  const [specs, setSpecs]           = useState<Record<string, PcaReplicaSpec>>({})
  const [projection, setProjection] = useState<'per_condition' | 'per_replica'>('per_condition')
  const [pcaName, setPcaName]        = useState('')
  const [targetFrames, setTarget]   = useState('')
  const [launching, setLaunching]   = useState(false)
  const [launchMsg, setLaunchMsg]   = useState('')

  // Keyed on the ids rather than the count: a same-size change of which
  // conditions are ready would otherwise go unnoticed.
  const readyIdsKey = ready.map(c => c.id).join(',')
  useEffect(() => { setCondIds(readyIdsKey ? readyIdsKey.split(',') : []) },
            [activeSession?.id, readyIdsKey])
  useEffect(() => { api.system.get(sessionId).then(r => setHasSystem(r.defined)).catch(() => {}) }, [sessionId])

  const key = (cid: string, ri: number) => `${cid}_${ri}`

  const toggleCond = (id: string) =>
    setCondIds(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])

  // Scan frames + check selection together
  const analyse = async () => {
    if (condIds.length === 0) return
    setChecking(true); setCheck(null)
    try {
      const [fr, ck] = await Promise.all([
        api.pca.scanFrames(sessionId, condIds, baseSel, include, exclude),
        api.pca.checkSelection(sessionId, condIds, baseSel, include, exclude),
      ])
      setFrames(fr.replicas)
      setCheck(ck)
      // init specs
      const init: Record<string, PcaReplicaSpec> = {}
      for (const f of fr.replicas) {
        init[key(f.condition_id, f.replica_index)] = {
          condition_id: f.condition_id, replica_index: f.replica_index,
          tpr: f.tpr, xtc: f.xtc, start_ns: null, end_ns: null, stride: 1,
        }
      }
      setSpecs(init)
    } catch (e: any) {
      setLaunchMsg(`Error: ${e.message}`)
    } finally {
      setChecking(false)
    }
  }

  const updateSpec = (k: string, patch: Partial<PcaReplicaSpec>) =>
    setSpecs(p => ({ ...p, [k]: { ...p[k], ...patch } }))

  // Auto-stride to hit target frame count for every replica
  // Auto-equalise: set stride per replica so each hits ~target frames.
  // Works from n_frames when available; if frame counts didn't parse, falls
  // back to computing stride from duration/dt, and if that's unavailable too,
  // it at least applies the target as a uniform end-time hint.
  const equalise = () => {
    const target = parseInt(targetFrames)
    if (!target || target < 1) return
    const next = { ...specs }
    for (const f of frames) {
      const k = key(f.condition_id, f.replica_index)
      const cur = next[k] || { condition_id: f.condition_id, replica_index: f.replica_index, tpr: f.tpr, xtc: f.xtc, start_ns: null, end_ns: null, stride: 1 }
      // Determine current available frames within the chosen window
      const availFrames =
        f.n_frames != null ? f.n_frames
        : (f.t_end_ps != null && f.dt_ps != null) ? Math.floor(f.t_end_ps / f.dt_ps) + 1
        : null
      if (availFrames != null && availFrames > target) {
        next[k] = { ...cur, stride: Math.max(1, Math.round(availFrames / target)) }
      } else {
        next[k] = { ...cur, stride: 1 }
      }
    }
    setSpecs(next)
  }

  // Apply one value to a field across ALL replicas at once.
  const applyToAll = (field: 'start_ns' | 'end_ns' | 'stride', value: number | null) => {
    const next = { ...specs }
    for (const f of frames) {
      const k = key(f.condition_id, f.replica_index)
      const cur = next[k] || { condition_id: f.condition_id, replica_index: f.replica_index, tpr: f.tpr, xtc: f.xtc, start_ns: null, end_ns: null, stride: 1 }
      next[k] = { ...cur, [field]: value }
    }
    setSpecs(next)
  }

  const applySuggestedExclusion = () => {
    if (check?.suggested_exclusions?.length) {
      setExclude(check.suggested_exclusions.join(' '))
      setCheck(null)  // force re-check
    }
  }

  const launch = async () => {
    if (!check?.consistent) return
    setLaunching(true); setLaunchMsg('')
    try {
      await api.pca.run({
        session_id: sessionId,
        condition_ids: condIds,
        base_selection: baseSel,
        include_residues: include,
        exclude_residues: exclude,
        projection,
        replicas: Object.values(specs),
        pca_name: pcaName,
      })
      setLaunchMsg(`PCA job launched. Watch progress in the Jobs panel.`)
      setJobsPanelOpen(true); pollJobs()
    } catch (e: any) {
      setLaunchMsg(`Error: ${e.message}`)
    } finally {
      setLaunching(false)
    }
  }

  if (ready.length < 1) {
    return (
      <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <div style={{ textAlign:'center', color:'var(--text-muted)', maxWidth:320 }}>
          <Layers size={40} style={{ margin:'0 auto 12px', opacity:0.25 }} />
          <div style={{ fontSize:15, fontWeight:600, marginBottom:6, color:'var(--text-secondary)' }}>No conditions ready</div>
          <div style={{ fontSize:12 }}>Register at least one condition with paired replicas. PCA compares conditions on a shared basis, so two or more is ideal.</div>
        </div>
      </div>
    )
  }

  const estimates = frames.map(f => {
    const s = specs[key(f.condition_id, f.replica_index)]
    return { f, est: s ? estFrames(f, s.start_ns ?? null, s.end_ns ?? null, s.stride) : f.n_frames }
  })
  const estValues = estimates.map(e => e.est).filter((v): v is number => v != null)
  const framesBalanced = estValues.length > 1 &&
    (Math.max(...estValues) - Math.min(...estValues)) / Math.max(...estValues) < 0.1

  return (
    <div style={{ flex:1, overflow:'auto', padding:'24px 28px' }}>
      <div style={{ maxWidth:760 }}>
        <h2 style={{ marginBottom:4 }}>Shared-basis PCA</h2>
        <p style={{ color:'var(--text-secondary)', fontSize:12, marginBottom:24, lineHeight:1.6 }}>
          Builds one covariance matrix from all selected conditions pooled together, then projects
          each condition (or replica) onto that shared basis — so PC1 means the same motion for
          everyone and WT vs mutant are directly comparable.
        </p>

        {/* Conditions */}
        <h3 style={{ marginBottom:10 }}>Conditions <span style={{ fontWeight:400, color:'var(--text-muted)', textTransform:'none' }}>— pooled to build the basis</span></h3>
        <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:22 }}>
          {ready.map(c => {
            const on = condIds.includes(c.id)
            const nRep = c.replicas.filter(r => r.paired).length
            return (
              <div key={c.id} onClick={() => toggleCond(c.id)} style={{
                display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:'var(--radius)', cursor:'pointer',
                background: on ? 'var(--bg-elevated)' : 'var(--bg-surface)',
                border:`1px solid ${on ? 'var(--border-light)' : 'var(--border)'}`,
              }}>
                <div style={{ width:16, height:16, borderRadius:4, flexShrink:0, border:`2px solid ${on ? c.colour : 'var(--border-light)'}`, background: on ? c.colour : 'transparent', display:'flex', alignItems:'center', justifyContent:'center' }}>
                  {on && <span style={{ color:'#fff', fontSize:10, fontWeight:900 }}>✓</span>}
                </div>
                <div style={{ width:10, height:10, borderRadius:'50%', background:c.colour }} />
                <span style={{ fontWeight:600, fontSize:13 }}>{c.name}</span>
                <span style={{ fontSize:11, color:'var(--text-muted)', display:'flex', alignItems:'center', gap:4 }}>
                  <Layers size={11} /> {nRep} replica{nRep>1?'s':''}
                </span>
              </div>
            )
          })}
        </div>

        {/* Covariance selection */}
        <h3 style={{ marginBottom:10 }}>Covariance atoms</h3>
        <div style={{ display:'flex', gap:8, marginBottom:8, flexWrap:'wrap' }}>
          {BASE_GROUPS.map(g => (
            <button key={g} onClick={() => { setBaseSel(g); setCheck(null) }} style={{
              padding:'6px 14px', borderRadius:20, fontSize:12,
              background: baseSel === g ? 'var(--accent)' : 'var(--bg-surface)',
              color: baseSel === g ? '#fff' : 'var(--text-secondary)',
              border:`1px solid ${baseSel === g ? 'transparent' : 'var(--border)'}`,
              fontWeight: baseSel === g ? 600 : 400,
            }}>{g}</button>
          ))}
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8, position:'relative' }}>
          <label style={{ fontSize:11, color:'var(--text-secondary)', width:110 }}>Include residues:</label>
          <input value={include} onChange={e => { setInclude(e.target.value); setCheck(null) }}
            placeholder="e.g. 200-270 (blank = all)" style={{ width:220, fontFamily:'var(--font-mono)', fontSize:11 }} />
          {hasSystem && (
            <button onClick={() => setPickerOpen(o => !o)} title="Select by chain + residue" style={{
              display:'flex', alignItems:'center', gap:5, padding:'5px 10px', borderRadius:20, fontSize:11,
              background:'var(--bg-elevated)', color:'var(--accent-bright)', border:'1px solid var(--border-light)',
            }}><Boxes size={12} /> chain</button>
          )}
          <span style={{ fontSize:10, color:'var(--text-muted)' }}>restrict PCA to these residues</span>
          {pickerOpen && (
            <ChainResiduePicker
              sessionId={sessionId}
              onApply={(ri) => {
                // PCA include field wants bare residue numbers, not "ri ..."
                setInclude(ri.replace(/^ri\s+/, '')); setCheck(null); setPickerOpen(false)
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8 }}>
          <label style={{ fontSize:11, color:'var(--text-secondary)', width:110 }}>Exclude residues:</label>
          <input value={exclude} onChange={e => { setExclude(e.target.value); setCheck(null) }}
            placeholder="e.g. 269 (optional)" style={{ width:220, fontFamily:'var(--font-mono)', fontSize:11 }} />
          <span style={{ fontSize:10, color:'var(--text-muted)' }}>e.g. remove a mutation site</span>
        </div>
        <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:8 }}>
          → resolves to <code style={{ color:'var(--text-code)' }}>{
            (baseSel === 'C-alpha' ? 'a CA' : baseSel)
            + (include.trim() ? ` & ri ${include.trim()}` : '')
            + (exclude.trim() ? ` & ! ri ${exclude.trim()}` : '')
          }</code>
        </div>

        <button onClick={analyse} disabled={condIds.length === 0 || checking} style={{
          display:'flex', alignItems:'center', gap:8, padding:'8px 16px', borderRadius:'var(--radius)',
          background:'var(--bg-elevated)', color:'var(--text-primary)', border:'1px solid var(--border-light)',
          fontSize:12, fontWeight:600, marginBottom:16,
        }}>
          {checking ? <Loader2 size={14} className="spin" /> : <Scale size={14} />}
          {checking ? 'Checking…' : 'Check selection & scan frames'}
        </button>

        {/* Selection consistency result */}
        {check && (
          <div style={{
            padding:'12px 14px', borderRadius:'var(--radius)', marginBottom:20,
            background: check.consistent ? '#0a2318' : '#2d1515',
            border:`1px solid ${check.consistent ? '#065f46' : '#7f1d1d'}`,
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, marginBottom: check.consistent ? 0 : 8 }}>
              {check.consistent
                ? <CheckCircle2 size={14} color="var(--green)" />
                : <AlertCircle size={14} color="var(--red)" />}
              <span style={{ fontWeight:600, color: check.consistent ? 'var(--green)' : 'var(--red)' }}>
                {check.consistent
                  ? `Consistent — ${check.atom_counts[0]} atoms in every replica`
                  : `Inconsistent atom counts: ${check.atom_counts.join(', ')}`}
              </span>
            </div>
            {!check.consistent && (
              <div style={{ fontSize:11, color:'var(--text-secondary)', lineHeight:1.6 }}>
                A shared basis needs identical atoms across all conditions.
                {check.suggested_exclusions.length > 0 && (
                  <> Residues differing between conditions: <code style={{ color:'var(--amber)' }}>{check.suggested_exclusions.join(', ')}</code>.{' '}
                    <button onClick={applySuggestedExclusion} style={{
                      display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:6,
                      background:'var(--bg-elevated)', color:'var(--accent-bright)', border:'1px solid var(--border-light)', fontSize:11,
                    }}><Wand2 size={11} /> exclude these</button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Per-replica frame table */}
        {frames.length > 0 && (
          <>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
              <h3>Frame control <span style={{ fontWeight:400, color:'var(--text-muted)', textTransform:'none' }}>— trim each replica to equal weight</span></h3>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <input value={targetFrames} onChange={e => setTarget(e.target.value)} placeholder="target frames"
                  style={{ width:110, fontSize:11, fontFamily:'var(--font-mono)' }} />
                <button onClick={equalise} style={{
                  display:'flex', alignItems:'center', gap:5, padding:'6px 12px', borderRadius:'var(--radius)',
                  background:'var(--bg-elevated)', color:'var(--accent-bright)', border:'1px solid var(--border-light)', fontSize:11, fontWeight:600,
                }}><Scale size={12} /> Auto-equalise</button>
              </div>
            </div>

            {framesBalanced && (
              <div style={{ fontSize:11, color:'var(--green)', marginBottom:8, display:'flex', alignItems:'center', gap:6 }}>
                <CheckCircle2 size={12} /> Frame counts are balanced (within 10%)
              </div>
            )}

            <div style={{ border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden', marginBottom:20 }}>
              <div style={{ display:'grid', gridTemplateColumns:'1.4fr 0.8fr 0.8fr 0.6fr 0.8fr', gap:0, fontSize:10, color:'var(--text-muted)', background:'var(--bg-panel)', padding:'6px 12px', textTransform:'uppercase', letterSpacing:0.5 }}>
                <span>Replica</span><span>Start (ns)</span><span>End (ns)</span><span>Stride</span><span>Frames</span>
              </div>

              {/* Apply-to-all row */}
              <ApplyAllRow onApply={applyToAll} />

              {estimates.map(({ f, est }) => {
                const k = key(f.condition_id, f.replica_index)
                const s = specs[k]
                if (!s) return null
                const durNs = f.t_end_ps != null ? (f.t_end_ps/1000).toFixed(0) : '?'
                return (
                  <div key={k} style={{ display:'grid', gridTemplateColumns:'1.4fr 0.8fr 0.8fr 0.6fr 0.8fr', gap:0, alignItems:'center', padding:'6px 12px', borderTop:'1px solid var(--border)', fontSize:11 }}>
                    <span style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <span style={{ width:8, height:8, borderRadius:'50%', background:f.colour }} />
                      {f.condition_name} rep{f.replica_index}
                      <span style={{ color:'var(--text-muted)', fontSize:10 }}>({f.n_frames ?? '?'}f / {durNs}ns)</span>
                    </span>
                    <input value={s.start_ns ?? ''} onChange={e => updateSpec(k, { start_ns: e.target.value ? parseFloat(e.target.value) : null })}
                      placeholder="0" style={{ width:60, fontSize:11, fontFamily:'var(--font-mono)', padding:'3px 6px' }} />
                    <input value={s.end_ns ?? ''} onChange={e => updateSpec(k, { end_ns: e.target.value ? parseFloat(e.target.value) : null })}
                      placeholder={durNs} style={{ width:60, fontSize:11, fontFamily:'var(--font-mono)', padding:'3px 6px' }} />
                    <input value={s.stride} onChange={e => updateSpec(k, { stride: Math.max(1, parseInt(e.target.value) || 1) })}
                      style={{ width:44, fontSize:11, fontFamily:'var(--font-mono)', padding:'3px 6px' }} />
                    <span style={{ fontFamily:'var(--font-mono)', color: est != null ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      ~{est ?? '?'}
                    </span>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* Projection mode */}
        {check?.consistent && (
          <>
            <h3 style={{ marginBottom:10 }}>Projection</h3>
            <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:22 }}>
              {([
                ['per_condition', 'Per condition', 'One cloud per condition (cleanest WT vs mutant comparison)'],
                ['per_replica', 'Per replica', 'Each replica as its own cloud on the shared axes (see replica spread)'],
              ] as const).map(([val, title, desc]) => (
                <label key={val} style={{
                  display:'flex', alignItems:'center', gap:10, cursor:'pointer', padding:'10px 12px', borderRadius:'var(--radius)',
                  background: projection === val ? 'var(--bg-hover)' : 'transparent',
                  border:`1px solid ${projection === val ? 'var(--border-light)' : 'var(--border)'}`,
                }}>
                  <input type="radio" checked={projection === val} onChange={() => setProjection(val)} style={{ accentColor:'var(--accent)' }} />
                  <div>
                    <div style={{ fontSize:12, fontWeight:600 }}>{title}</div>
                    <div style={{ fontSize:11, color:'var(--text-muted)' }}>{desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </>
        )}

        {/* PCA name */}
        {check?.consistent && (
          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', fontSize:11, color:'var(--text-secondary)', marginBottom:5 }}>
              Analysis name <span style={{ color:'var(--text-muted)' }}>— so you can tell multiple PCA runs apart</span>
            </label>
            <input value={pcaName} onChange={e => setPcaName(e.target.value)}
              placeholder="e.g. arch_domain (blank = auto)" style={{ width:320, fontFamily:'var(--font-mono)', fontSize:12 }} />
          </div>
        )}

        {/* Launch */}
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <button onClick={launch} disabled={!check?.consistent || launching} style={{
            display:'flex', alignItems:'center', gap:8, padding:'11px 24px', borderRadius:'var(--radius)',
            background: check?.consistent ? 'var(--accent)' : 'var(--bg-elevated)',
            color: check?.consistent ? '#fff' : 'var(--text-muted)', fontWeight:600, fontSize:14,
            border:`1px solid ${check?.consistent ? 'transparent' : 'var(--border)'}`,
          }}>
            <Play size={15} /> {launching ? 'Launching…' : 'Run PCA'}
          </button>
          {launchMsg && (
            <span style={{ fontSize:12, color: launchMsg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{launchMsg}</span>
          )}
        </div>
      </div>
    </div>
  )
}

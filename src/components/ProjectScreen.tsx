import React, { useState, useEffect } from 'react'
import {
  ArrowLeft, Plus, CheckCircle2, Atom,
  FlaskConical, Dna, Activity, Settings2,
  ChevronDown, ChevronUp, Layers, GitCompare, Boxes, Radar, Trash2 } from 'lucide-react'
import ErrorBoundary from './ErrorBoundary'
import { useStore } from '../store'
import { api } from '../api/client'
import type { Condition } from '../types'
import GromaxSettings from './GromaxSettings'
import FileRegistration from './FileRegistration'
import AnalysesTab from './AnalysesTab'
import PcaTab from './PcaTab'
import CompareTab from './CompareTab'
import SystemTab from './SystemTab'
import ContactsTab from './ContactsTab'
import ResultsTab from './ResultsTab'
// Lazy: NGL is ~1.3 MB and only the Structure tab needs it, so keeping it out
// of the initial bundle makes startup noticeably faster for everyone who never
// opens this tab. Vite splits it into its own chunk automatically.
const StructureTab = React.lazy(() => import('./StructureTab'))
import JobsPanel from './JobsPanel'

const CONDITION_COLOURS = [
  '#3b82f6', '#34d399', '#f87171', '#fbbf24',
  '#a78bfa', '#fb923c', '#22d3ee', '#f472b6'
]

function AddConditionModal({ sessionId, onClose, existingCount }: {
  sessionId: string; onClose: () => void; existingCount: number
}) {
  const [name, setName]        = useState('')
  const [colour, setColour]    = useState(CONDITION_COLOURS[existingCount % CONDITION_COLOURS.length])
  const [pbcCorrected, setPbc] = useState(true)
  const [loading, setLoading]  = useState(false)
  const { refreshSession }     = useStore()

  const submit = async () => {
    if (!name.trim()) return
    setLoading(true)
    try {
      await api.session.addCondition(sessionId, { name: name.trim(), colour, pbc_corrected: pbcCorrected })
      await refreshSession()
      onClose()
    } catch (e) { console.error(e); setLoading(false) }
  }

  return (
    <div style={{ position:'fixed', inset:0, zIndex:200, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center' }} onClick={onClose}>
      <div style={{ background:'var(--bg-elevated)', border:'1px solid var(--border-light)', borderRadius:'var(--radius-lg)', padding:28, width:420, animation:'fadeIn 150ms ease' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginBottom:20 }}>Add Condition</h2>
        <label style={{ display:'block', fontSize:11, color:'var(--text-secondary)', textTransform:'uppercase', letterSpacing:0.5, marginBottom:5 }}>Name</label>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key==='Enter' && submit()} placeholder="e.g. WT, A123V, apo, holo" style={{ width:'100%', marginBottom:16 }} />
        <label style={{ display:'block', fontSize:11, color:'var(--text-secondary)', textTransform:'uppercase', letterSpacing:0.5, marginBottom:8 }}>Colour</label>
        <div style={{ display:'flex', gap:8, marginBottom:20 }}>
          {CONDITION_COLOURS.map(c => <div key={c} onClick={() => setColour(c)} style={{ width:24, height:24, borderRadius:'50%', background:c, cursor:'pointer', outline:colour===c?'2px solid #fff':'none', outlineOffset:2 }} />)}
        </div>
        <label style={{ display:'block', fontSize:11, color:'var(--text-secondary)', textTransform:'uppercase', letterSpacing:0.5, marginBottom:8 }}>Trajectory state</label>
        <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:24 }}>
          {([true, false] as const).map(val => (
            <label key={String(val)} style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', padding:'10px 12px', borderRadius:'var(--radius)', background:pbcCorrected===val?'var(--bg-hover)':'transparent', border:`1px solid ${pbcCorrected===val?'var(--border-light)':'var(--border)'}` }}>
              <input type="radio" checked={pbcCorrected===val} onChange={() => setPbc(val)} style={{ accentColor:'var(--accent)' }} />
              <div>
                <div style={{ fontSize:12, fontWeight:600 }}>{val ? '✓ PBC corrected' : '⚠ Needs PBC correction'}</div>
                <div style={{ fontSize:11, color:'var(--text-muted)' }}>{val ? 'Upload pre-processed trajectory directly' : 'App will run gmx trjconv first'}</div>
              </div>
            </label>
          ))}
        </div>
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ padding:'8px 16px', borderRadius:'var(--radius)', background:'var(--bg-surface)', color:'var(--text-secondary)' }}>Cancel</button>
          <button onClick={submit} disabled={!name.trim()||loading} style={{ padding:'8px 20px', borderRadius:'var(--radius)', background:'var(--accent)', color:'#fff', fontWeight:600 }}>{loading ? 'Adding…' : 'Add Condition'}</button>
        </div>
      </div>
    </div>
  )
}

function ConditionCard({ condition, sessionId }: { condition: Condition; sessionId: string }) {
  const { refreshSession } = useStore()
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const doDelete = async () => {
    setDeleting(true)
    try {
      await api.session.deleteCondition(sessionId, condition.id)
      await refreshSession()
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const tprCount = Object.keys(condition.files).filter(k => k.startsWith('tpr')).length
  const xtcCount = Object.keys(condition.files).filter(k => k.startsWith('xtc')).length
  const hasPdb   = !!condition.files.pdb
  const isReady  = tprCount > 0 && xtcCount > 0 && hasPdb

  return (
    <div style={{ background:'var(--bg-surface)', borderLeft:`3px solid ${condition.colour}`, border:`1px solid var(--border)`, borderLeftWidth:3, borderLeftColor:condition.colour, borderRadius:'var(--radius-lg)', marginBottom:10, overflow:'hidden' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'14px 16px', cursor:'pointer' }} onClick={() => setExpanded(e => !e)}>
        <div style={{ width:10, height:10, borderRadius:'50%', background:condition.colour, flexShrink:0 }} />
        <span style={{ fontWeight:700, fontSize:14 }}>{condition.name}</span>
        <span style={{ fontSize:10, padding:'2px 8px', borderRadius:10, background:condition.pbc_corrected?'var(--green-dim)':'#3d2a0a', color:condition.pbc_corrected?'var(--green)':'var(--amber)', border:`1px solid ${condition.pbc_corrected?'#065f46':'#78350f'}` }}>
          {condition.pbc_corrected ? 'PBC ✓' : 'needs trjconv'}
        </span>
        <div style={{ display:'flex', gap:5, marginLeft:4 }}>
          {[{label:`${tprCount} tpr`,ok:tprCount>0},{label:`${xtcCount} xtc`,ok:xtcCount>0},{label:'pdb',ok:hasPdb}].map(({label,ok}) => (
            <span key={label} style={{ fontSize:10, padding:'1px 7px', borderRadius:8, background:ok?'rgba(52,211,153,0.1)':'var(--bg-elevated)', color:ok?'var(--green)':'var(--text-muted)', border:`1px solid ${ok?'#065f46':'var(--border)'}` }}>{label}</span>
          ))}
        </div>
        <div style={{ flex:1 }} />
        {isReady
          ? <span style={{ fontSize:11, color:'var(--green)', display:'flex', alignItems:'center', gap:4 }}><CheckCircle2 size={13} /> Ready</span>
          : <span style={{ fontSize:11, color:'var(--text-muted)' }}>Add files</span>
        }
        <button
          title="Delete this condition"
          onClick={e => { e.stopPropagation(); setConfirmDelete(true) }}
          style={{ display:'flex', alignItems:'center', background:'transparent',
                   border:'none', cursor:'pointer', color:'var(--text-muted)',
                   padding:2 }}
        ><Trash2 size={14} /></button>
        {expanded ? <ChevronUp size={14} color="var(--text-muted)" /> : <ChevronDown size={14} color="var(--text-muted)" />}
      </div>

      {confirmDelete && (
        <div style={{ borderTop:'1px solid var(--border)', padding:'12px 16px',
                      background:'rgba(247,79,79,0.08)', fontSize:12 }}
             onClick={e => e.stopPropagation()}>
          <div style={{ marginBottom:8, lineHeight:1.5 }}>
            Delete <strong>{condition.name}</strong>? Its stored analyses will be
            removed too. Your trajectory files on disk are not touched.
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={doDelete} disabled={deleting}
              style={{ padding:'5px 12px', borderRadius:4, fontSize:12,
                       border:'1px solid var(--red, #f74f4f)', cursor:'pointer',
                       background:'var(--red, #f74f4f)', color:'#fff' }}>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
            <button onClick={() => setConfirmDelete(false)}
              style={{ padding:'5px 12px', borderRadius:4, fontSize:12,
                       border:'1px solid var(--border)', cursor:'pointer',
                       background:'transparent', color:'var(--text)' }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {expanded && (
        <div style={{ borderTop:'1px solid var(--border)', padding:'16px 16px 20px', background:'var(--bg-panel)' }}>
          <FileRegistration condition={condition} sessionId={sessionId} onDone={async () => { await refreshSession(); setExpanded(false) }} />
        </div>
      )}
    </div>
  )
}

type Tab = 'setup' | 'system' | 'analyses' | 'pca' | 'contacts' | 'structure' | 'results' | 'compare'

function Sidebar({ activeTab, setTab }: { activeTab: Tab; setTab: (t: Tab) => void }) {
  const tabs = [
    { id: 'setup'    as Tab, label:'Setup',    icon:<Settings2 size={15}/> },
    { id: 'system'   as Tab, label:'System',   icon:<Boxes     size={15}/> },
    { id: 'structure' as Tab, label:'Structure', icon:<Atom     size={15}/> },
    { id: 'analyses' as Tab, label:'Analyses', icon:<Activity  size={15}/> },
    { id: 'pca'      as Tab, label:'PCA',      icon:<Layers    size={15}/> },
    { id: 'contacts' as Tab, label:'Contacts', icon:<Radar     size={15}/> },
    { id: 'results'  as Tab, label:'Results',  icon:<Dna       size={15}/> },
    { id: 'compare'  as Tab, label:'Compare',  icon:<GitCompare size={15}/> },
  ]
  return (
    <div style={{ width:180, background:'var(--bg-panel)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:2, padding:'12px 8px', flexShrink:0 }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setTab(t.id)} style={{ display:'flex', alignItems:'center', gap:9, padding:'9px 12px', borderRadius:'var(--radius)', background:activeTab===t.id?'var(--bg-elevated)':'transparent', color:activeTab===t.id?'var(--text-primary)':'var(--text-secondary)', fontWeight:activeTab===t.id?600:400, border:activeTab===t.id?'1px solid var(--border-light)':'1px solid transparent', textAlign:'left', fontSize:13 }}>
          {t.icon} {t.label}
        </button>
      ))}
    </div>
  )
}

function SetupTab({ sessionId }: { sessionId: string }) {
  const { activeSession } = useStore()
  const [showAddCond, setShowAddCond] = useState(false)
  const conditions = Object.values(activeSession?.conditions ?? {})

  return (
    <div style={{ padding:'24px 28px', overflow:'auto', flex:1 }}>
      <div style={{ maxWidth:660 }}>
        <h3 style={{ marginBottom:12 }}>GROMACS</h3>
        <GromaxSettings />

        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
          <h3>Conditions</h3>
          <button onClick={() => setShowAddCond(true)} style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', borderRadius:'var(--radius)', background:'var(--accent)', color:'#fff', fontWeight:600, fontSize:12 }}>
            <Plus size={13} /> Add Condition
          </button>
        </div>
        <p style={{ color:'var(--text-secondary)', fontSize:12, marginBottom:16, lineHeight:1.6 }}>
          One condition per simulation type. Click a condition to expand and load replica files.
          Multiple .tpr and .xtc files are auto-paired by number (e.g. step5_1.tpr ↔ step5_1.pbc.xtc).
        </p>

        {conditions.length === 0 ? (
          <div style={{ border:'1px dashed var(--border)', borderRadius:'var(--radius-lg)', padding:'36px 24px', textAlign:'center', color:'var(--text-muted)' }}>
            <FlaskConical size={28} style={{ margin:'0 auto 10px', opacity:0.3 }} />
            <div style={{ fontSize:13, marginBottom:4 }}>No conditions yet</div>
            <div style={{ fontSize:12 }}>Add a condition to start loading trajectory files.</div>
          </div>
        ) : conditions.map(c => <ConditionCard key={c.id} condition={c} sessionId={sessionId} />)}
      </div>
      {showAddCond && <AddConditionModal sessionId={sessionId} existingCount={conditions.length} onClose={() => setShowAddCond(false)} />}
    </div>
  )
}

export default function ProjectScreen() {
  const { activeSession, closeSession, jobs, jobsPanelOpen, setJobsPanelOpen,
          requestedTab, setRequestedTab } = useStore()
  const [tab, setTab] = useState<Tab>('setup')

  /**
   * Once the Structure tab has been opened it stays mounted, hidden rather
   * than unmounted.
   *
   * Every other tab is cheap to rebuild. The 3D viewer is not: unmounting it
   * disposes the NGL stage, so coming back re-downloaded the PDB, re-parsed it,
   * and dropped the camera back to the default orientation — a full reset every
   * time you glanced at Analyses. Keeping it mounted costs one hidden canvas
   * (NGL only renders on demand) and keeps the whole session intact.
   */
  const [structureMounted, setStructureMounted] = useState(false)
  useEffect(() => {
    if (tab === 'structure') setStructureMounted(true)
  }, [tab])

  // Let another tab request a switch (Structure -> Analyses with a selection).
  useEffect(() => {
    if (requestedTab) { setTab(requestedTab as Tab); setRequestedTab(null) }
  }, [requestedTab, setRequestedTab])
  if (!activeSession) return null
  const activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'pending').length
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      <div style={{ height:44, background:'var(--bg-panel)', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12, padding:'0 16px', flexShrink:0 }}>
        <button onClick={closeSession} style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 10px', borderRadius:'var(--radius-sm)', background:'transparent', color:'var(--text-secondary)', fontSize:12 }}>
          <ArrowLeft size={14} /> Projects
        </button>
        <div style={{ width:1, height:16, background:'var(--border)' }} />
        <span style={{ fontWeight:700 }}>{activeSession.name}</span>
        <span style={{ color:'var(--text-muted)', fontSize:11, fontFamily:'var(--font-mono)' }}>#{activeSession.id}</span>
        <div style={{ flex:1 }} />
        <button onClick={() => setJobsPanelOpen(!jobsPanelOpen)} style={{
          display:'flex', alignItems:'center', gap:6, padding:'5px 12px',
          borderRadius:'var(--radius)', fontSize:12,
          background: activeJobs > 0 ? 'var(--accent)' : 'var(--bg-surface)',
          color: activeJobs > 0 ? '#fff' : 'var(--text-secondary)',
          border:`1px solid ${activeJobs > 0 ? 'transparent' : 'var(--border)'}`,
        }}>
          <Activity size={13} /> Jobs {activeJobs > 0 && `(${activeJobs})`}
        </button>
      </div>
      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
        <Sidebar activeTab={tab} setTab={setTab} />
        {/* Each tab is isolated. An unhandled render error anywhere in the
            React tree unmounts the ENTIRE app — one bad reference in the
            viewer turned the whole window black, with no message and no way
            to switch back to a working tab. */}
        {tab==='setup'    && <ErrorBoundary label="Setup"><SetupTab sessionId={activeSession.id} /></ErrorBoundary>}
        {tab==='system'   && <ErrorBoundary label="System"><SystemTab sessionId={activeSession.id} /></ErrorBoundary>}
        {tab==='analyses' && <ErrorBoundary label="Analyses"><AnalysesTab sessionId={activeSession.id} /></ErrorBoundary>}
        {tab==='pca'      && <ErrorBoundary label="PCA"><PcaTab sessionId={activeSession.id} /></ErrorBoundary>}
        {tab==='contacts' && <ErrorBoundary label="Contacts"><ContactsTab sessionId={activeSession.id} /></ErrorBoundary>}
        {structureMounted && (
          // display:none rather than a conditional render — see the note on
          // structureMounted above. flex when visible, to match the other tabs.
          <div style={{ display: tab==='structure' ? 'flex' : 'none',
                        flex: 1, overflow: 'hidden' }}>
            <ErrorBoundary label="Structure viewer">
              <React.Suspense fallback={
                <div style={{ padding: 40, textAlign: 'center', fontSize: 13, opacity: 0.6 }}>
                  Loading 3D viewer…
                </div>
              }>
                <StructureTab sessionId={activeSession.id}
                              active={tab==='structure'} />
              </React.Suspense>
            </ErrorBoundary>
          </div>
        )}
        {tab==='results'  && <ErrorBoundary label="Results"><ResultsTab /></ErrorBoundary>}
        {tab==='compare'  && <ErrorBoundary label="Compare"><CompareTab /></ErrorBoundary>}
      </div>
      <JobsPanel />
    </div>
  )
}

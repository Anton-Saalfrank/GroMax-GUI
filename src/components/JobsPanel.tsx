import { useState } from 'react'
import { X, Loader2, CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp, Ban } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../api/client'
import type { Job } from '../types'

function JobRow({ job }: { job: Job }) {
  const [expanded, setExpanded] = useState(false)

  const statusIcon = {
    pending:   <Clock size={14} color="var(--text-muted)" />,
    running:   <Loader2 size={14} color="var(--accent-bright)" className="spin" />,
    completed: <CheckCircle2 size={14} color="var(--green)" />,
    failed:    <XCircle size={14} color="var(--red)" />,
    cancelled: <Ban size={14} color="var(--text-muted)" />,
  }[job.status]

  return (
    <div style={{
      background:'var(--bg-surface)', border:'1px solid var(--border)',
      borderRadius:'var(--radius)', marginBottom:8, overflow:'hidden',
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', cursor:'pointer' }}
        onClick={() => setExpanded(e => !e)}>
        {statusIcon}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:12, fontWeight:600 }} className="truncate">{job.label}</div>
          {job.status === 'running' && (
            <div style={{ marginTop:5, height:3, background:'var(--bg-elevated)', borderRadius:2, overflow:'hidden' }}>
              <div style={{ height:'100%', width:`${job.progress}%`, background:'var(--accent)', transition:'width 300ms' }} />
            </div>
          )}
          {job.status === 'failed' && job.error && (
            <div style={{ fontSize:10, color:'var(--red)', marginTop:2 }} className="truncate">{job.error}</div>
          )}
        </div>
        {job.status === 'running' && (
          <button onClick={e => { e.stopPropagation(); api.jobs.cancel(job.id) }} style={{
            padding:'3px 8px', fontSize:10, borderRadius:4, background:'var(--bg-elevated)',
            color:'var(--text-muted)', border:'1px solid var(--border)',
          }}>Cancel</button>
        )}
        {(job.log.length > 0 || !!job.error) && (expanded ? <ChevronUp size={13} color="var(--text-muted)" /> : <ChevronDown size={13} color="var(--text-muted)" />)}
      </div>

      {/* The FULL error, not the one-line summary above.
          The header truncates to a single ellipsised line, and this panel used
          to show only the log — so a failed job's actual message was
          unreachable from the UI. A diagnosis that says "Selection 'ri 277-287'
          could not be built. GROMACS coul…" is not one anybody can act on. */}
      {expanded && !!job.error && (
        <div style={{
          borderTop:'1px solid var(--border)', padding:'8px 12px',
          background:'var(--bg-base)', fontSize:11, color:'var(--red)',
          whiteSpace:'pre-wrap', wordBreak:'break-word', userSelect:'text',
          maxHeight:220, overflow:'auto', lineHeight:1.5,
        }}>{job.error}</div>
      )}

      {expanded && job.log.length > 0 && (
        <div style={{
          borderTop:'1px solid var(--border)', padding:'8px 12px',
          background:'var(--bg-base)', maxHeight:160, overflow:'auto',
          fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-muted)',
          whiteSpace:'pre-wrap', userSelect:'text',
        }}>
          {job.log.slice(-40).map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  )
}

export default function JobsPanel() {
  const { jobs, jobsPanelOpen, setJobsPanelOpen, activeSession } = useStore()

  if (!jobsPanelOpen) return null

  const active = jobs.filter(j => j.status === 'running' || j.status === 'pending')
  const done = jobs.filter(j => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled')

  return (
    <div style={{
      position:'fixed', top:0, right:0, bottom:0, width:380, zIndex:150,
      background:'var(--bg-panel)', borderLeft:'1px solid var(--border)',
      display:'flex', flexDirection:'column', animation:'fadeIn 150ms ease',
      boxShadow:'-8px 0 24px rgba(0,0,0,0.3)',
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'16px', borderBottom:'1px solid var(--border)' }}>
        <h2 style={{ flex:1 }}>Jobs</h2>
        {active.length > 0 && (
          <span style={{ fontSize:11, color:'var(--accent-bright)', display:'flex', alignItems:'center', gap:5 }}>
            <Loader2 size={12} className="spin" /> {active.length} running
          </span>
        )}
        <button onClick={() => setJobsPanelOpen(false)} style={{ padding:4, background:'transparent', color:'var(--text-muted)' }}>
          <X size={18} />
        </button>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:16 }}>
        {jobs.length === 0 && (
          <div style={{ textAlign:'center', color:'var(--text-muted)', fontSize:12, marginTop:40 }}>
            No jobs yet. Launch an analysis to see progress here.
          </div>
        )}
        {active.length > 0 && (
          <>
            <h3 style={{ marginBottom:10 }}>Active</h3>
            {active.map(j => <JobRow key={j.id} job={j} />)}
          </>
        )}
        {done.length > 0 && (
          <>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', margin:'16px 0 10px' }}>
              <h3>Finished</h3>
              <button onClick={() => activeSession && api.jobs.clearFinished(activeSession.id)} style={{
                fontSize:10, color:'var(--text-muted)', background:'transparent', padding:'2px 6px',
              }}>Clear</button>
            </div>
            {done.map(j => <JobRow key={j.id} job={j} />)}
          </>
        )}
      </div>
    </div>
  )
}

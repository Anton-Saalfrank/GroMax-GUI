import React, { useState, useEffect } from 'react'
import { Boxes, CheckCircle2, AlertCircle, X } from 'lucide-react'
import { api } from '../api/client'
import type { ChainDef } from '../types'

/**
 * A compact popover that lets the user pick chain + residue(s) in biological
 * (full-length) numbering and returns the flat `ri ...` selection string.
 * Only useful when a system definition exists; the caller decides whether to show it.
 */
export default function ChainResiduePicker({
  sessionId, onApply, onClose,
}: {
  sessionId: string
  onApply: (riString: string, label: string) => void
  onClose: () => void
}) {
  const [chains, setChains] = useState<ChainDef[]>([])
  const [chainId, setChainId] = useState('')
  const [rStart, setRStart] = useState('')
  const [rEnd, setREnd] = useState('')
  const [expected, setExpected] = useState('')
  const [check, setCheck] = useState<{ resname: string | null; passed?: boolean } | null>(null)
  const [ri, setRi] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    api.system.get(sessionId).then(r => {
      if (r.defined) { setChains(r.chains); setChainId(r.chains[0]?.id || '') }
    }).catch(() => {})
  }, [sessionId])

  const translate = async (doCheck: boolean) => {
    setErr(''); setCheck(null)
    try {
      const r = await api.system.translate({
        session_id: sessionId, chain_id: chainId,
        res_start: parseInt(rStart),
        res_end: rEnd ? parseInt(rEnd) : undefined,
        check_type: doCheck,
        expected_resname: doCheck && expected ? expected : undefined,
      })
      setRi(r.ri)
      if (doCheck && r.actual_resname !== undefined) setCheck({ resname: r.actual_resname ?? null, passed: r.check_passed })
    } catch (e: any) { setErr(e.message) }
  }

  const apply = () => {
    if (!ri) return
    const c = chains.find(x => x.id === chainId)
    const label = `chain ${chainId} ${rStart}${rEnd ? `-${rEnd}` : ''}${c?.label ? ` (${c.label})` : ''}`
    onApply(`ri ${ri}`, label)
  }

  return (
    <div style={{
      position: 'absolute', zIndex: 50, marginTop: 6, padding: 14, width: 320,
      background: 'var(--bg-elevated)', border: '1px solid var(--border-light)',
      borderRadius: 'var(--radius-lg)', boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <Boxes size={14} color="var(--accent-bright)" />
        <span style={{ fontSize: 12, fontWeight: 600 }}>Select by chain + residue</span>
        <button onClick={onClose} style={{ marginLeft: 'auto', padding: 2, background: 'transparent', color: 'var(--text-muted)', border: 'none' }}><X size={14} /></button>
      </div>

      {chains.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          No system defined yet. Define chains in the System tab first.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'flex-end' }}>
            <div>
              <label style={lbl}>Chain</label>
              <select value={chainId} onChange={e => setChainId(e.target.value)} style={{ fontSize: 12 }}>
                {chains.map(c => <option key={c.id} value={c.id}>{c.id}{c.label ? ` (${c.label})` : ''}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Residue</label><input value={rStart} onChange={e => setRStart(e.target.value)} placeholder="629" style={{ ...cell, width: 60 }} /></div>
            <div><label style={lbl}>End</label><input value={rEnd} onChange={e => setREnd(e.target.value)} placeholder="opt" style={{ ...cell, width: 50 }} /></div>
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'flex-end' }}>
            <div><label style={lbl}>Expected AA (opt.)</label><input value={expected} onChange={e => setExpected(e.target.value)} placeholder="ASP" style={{ ...cell, width: 64 }} /></div>
            <button onClick={() => translate(true)} style={btnGhost}>Check type</button>
            <button onClick={() => translate(false)} style={btnGhost}>Translate</button>
          </div>

          {err && <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 8 }}>{err}</div>}

          {ri && (
            <div style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.6 }}>
              → <code style={{ color: 'var(--accent-bright)' }}>ri {ri}</code>
              {check && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
                  {check.passed === true && <CheckCircle2 size={12} color="var(--green)" />}
                  {check.passed === false && <AlertCircle size={12} color="var(--red)" />}
                  <span style={{ color: check.passed === false ? 'var(--red)' : 'var(--text-secondary)' }}>
                    residue is {check.resname || 'not found'}
                    {check.passed === true && ` ✓`}
                  </span>
                </div>
              )}
            </div>
          )}

          <button onClick={apply} disabled={!ri} style={{
            width: '100%', padding: '8px', borderRadius: 'var(--radius)', fontSize: 12, fontWeight: 600,
            background: ri ? 'var(--accent)' : 'var(--bg-surface)', color: ri ? '#fff' : 'var(--text-muted)',
            border: 'none', cursor: ri ? 'pointer' : 'default',
          }}>Use this selection</button>
        </>
      )}
    </div>
  )
}

const cell: React.CSSProperties = { fontSize: 11, fontFamily: 'var(--font-mono)', padding: '4px 6px' }
const lbl: React.CSSProperties = { display: 'block', fontSize: 9, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase' }
const btnGhost: React.CSSProperties = { padding: '6px 10px', borderRadius: 'var(--radius)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', fontSize: 11, border: '1px solid var(--border)' }

import React, { useState, useEffect } from 'react'
import { FileInput, Save, Plus, Trash2, CheckCircle2, AlertCircle, ArrowRight } from 'lucide-react'
import { api } from '../api/client'
import type { ChainDef, TranslateResult } from '../types'

export default function SystemTab({ sessionId }: { sessionId: string }) {
  const [pdbPath, setPdbPath] = useState('')
  const [chains, setChains] = useState<ChainDef[]>([])
  const [msg, setMsg] = useState('')
  const [importing, setImporting] = useState(false)
  const [defined, setDefined] = useState(false)

  useEffect(() => {
    api.system.get(sessionId).then(r => {
      if (r.defined) { setChains(r.chains); setDefined(true); if (r.source_pdb) setPdbPath(r.source_pdb) }
    }).catch(() => {})
  }, [sessionId])

  const importPdb = async () => {
    if (!pdbPath.trim()) return
    setImporting(true); setMsg('')
    try {
      const r = await api.system.importPdb(sessionId, pdbPath.trim())
      setChains(r.chains); setDefined(true)
      setMsg(`Detected ${r.chains.length} chain(s), ${r.n_residues} residues. Review and edit below, then Save.`)
    } catch (e: any) {
      setMsg(`Error: ${e.message}`)
    } finally { setImporting(false) }
  }

  const updateChain = (i: number, patch: Partial<ChainDef>) =>
    setChains(cs => cs.map((c, j) => j === i ? { ...c, ...patch } : c))

  const addChain = () => setChains(cs => [...cs, { id: String.fromCharCode(65 + cs.length), label: '', start_resnum: 1, end_resnum: 1, n_residues: 1 }])
  const removeChain = (i: number) => setChains(cs => cs.filter((_, j) => j !== i))

  const save = async () => {
    // keep n_residues in sync with the range if not explicitly diverging
    const normalized = chains.map(c => ({ ...c, n_residues: c.n_residues || (c.end_resnum - c.start_resnum + 1) }))
    await api.system.save(sessionId, normalized)
    setMsg('System definition saved. You can now select by chain + residue in the analyses.')
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px' }}>
      <div style={{ maxWidth: 800 }}>
        <h2 style={{ marginBottom: 4 }}>System definition</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 22, lineHeight: 1.6 }}>
          Describe your multi-chain system once. The GROMACS index numbers residues as one
          continuous list; defining the chains here lets you select by biological identity
          (e.g. chain B, residue D629) and the app maps it to the flat index automatically.
        </p>

        {/* PDB import */}
        <h3 style={{ marginBottom: 8 }}>Import from PDB <span style={{ fontWeight: 400, color: 'var(--text-muted)', textTransform: 'none' }}>— auto-detect chains</span></h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <input value={pdbPath} onChange={e => setPdbPath(e.target.value)}
            placeholder="/path/to/input_structure.pdb"
            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
          <button onClick={importPdb} disabled={importing || !pdbPath.trim()} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 'var(--radius)',
            background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-light)', fontSize: 12, fontWeight: 600,
          }}><FileInput size={14} /> {importing ? 'Reading…' : 'Import'}</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.5 }}>
          Use the same structure you built the simulation from. Chain IDs and residue ranges are
          read from it; you can correct anything below before saving.
        </div>

        {/* Chains table */}
        {chains.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <h3>Chains <span style={{ fontWeight: 400, color: 'var(--text-muted)', textTransform: 'none' }}>— sequential order in the topology</span></h3>
              <button onClick={addChain} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 'var(--radius)', fontSize: 11, background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}><Plus size={12} /> Add chain</button>
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '0.6fr 1.2fr 1fr 1fr 1fr 0.4fr', gap: 0, fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-panel)', padding: '7px 12px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              <span>Chain</span><span>Protein</span><span>First resnum</span><span>Last resnum</span><span>Residues</span><span></span>
            </div>
            {chains.map((c, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '0.6fr 1.2fr 1fr 1fr 1fr 0.4fr', gap: 8, alignItems: 'center', padding: '6px 12px', borderTop: '1px solid var(--border)' }}>
                <input value={c.id} onChange={e => updateChain(i, { id: e.target.value })} style={cell} />
                <input value={c.label} onChange={e => updateChain(i, { label: e.target.value })} placeholder="e.g. VPS35" style={cell} />
                <input type="number" value={c.start_resnum} onChange={e => updateChain(i, { start_resnum: +e.target.value })} style={cell} />
                <input type="number" value={c.end_resnum} onChange={e => updateChain(i, { end_resnum: +e.target.value })} style={cell} />
                <input type="number" value={c.n_residues} onChange={e => updateChain(i, { n_residues: +e.target.value })} title="residue count in the simulated excerpt" style={cell} />
                <button onClick={() => removeChain(i)} style={{ padding: 4, background: 'transparent', color: 'var(--text-muted)', border: 'none' }}><Trash2 size={13} /></button>
              </div>
            ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
              <strong>First/Last resnum</strong> use full-length numbering (e.g. VPS35 400–800).
              <strong> Residues</strong> is the count actually simulated for that chain — usually
              (last − first + 1), but you can override if there are gaps.
            </div>
            <button onClick={save} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 'var(--radius)', background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: 13, marginBottom: 22 }}>
              <Save size={15} /> Save system definition
            </button>
          </>
        )}

        {msg && <div style={{ fontSize: 12, color: msg.startsWith('Error') ? 'var(--red)' : 'var(--green)', marginBottom: 20 }}>{msg}</div>}

        {/* Selection translator / tester */}
        {defined && chains.length > 0 && <SelectionTester sessionId={sessionId} chains={chains} />}
      </div>
    </div>
  )
}

// A small tool to translate + sanity-check a biological selection
function SelectionTester({ sessionId, chains }: { sessionId: string; chains: ChainDef[] }) {
  const [chainId, setChainId] = useState(chains[0]?.id || 'A')
  const [rStart, setRStart] = useState('')
  const [rEnd, setREnd] = useState('')
  const [expected, setExpected] = useState('')
  const [result, setResult] = useState<TranslateResult | null>(null)
  const [err, setErr] = useState('')

  const run = async (check: boolean) => {
    setErr(''); setResult(null)
    try {
      const r = await api.system.translate({
        session_id: sessionId, chain_id: chainId,
        res_start: parseInt(rStart),
        res_end: rEnd ? parseInt(rEnd) : undefined,
        check_type: check,
        expected_resname: check && expected ? expected : undefined,
      })
      setResult(r)
    } catch (e: any) { setErr(e.message) }
  }

  return (
    <div style={{ marginTop: 8, padding: '16px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
      <h3 style={{ marginBottom: 4 }}>Selection translator</h3>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        Convert a biological selection to the flat index the analyses use. Optionally verify the residue identity.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <label style={lbl}>Chain</label>
          <select value={chainId} onChange={e => setChainId(e.target.value)} style={{ fontSize: 12 }}>
            {chains.map(c => <option key={c.id} value={c.id}>{c.id}{c.label ? ` (${c.label})` : ''}</option>)}
          </select>
        </div>
        <div><label style={lbl}>Residue (or start)</label><input value={rStart} onChange={e => setRStart(e.target.value)} placeholder="629" style={{ ...cell, width: 80 }} /></div>
        <div><label style={lbl}>End (optional)</label><input value={rEnd} onChange={e => setREnd(e.target.value)} placeholder="635" style={{ ...cell, width: 80 }} /></div>
        <button onClick={() => run(false)} style={btnPrimary}><ArrowRight size={13} /> Translate</button>
        <div><label style={lbl}>Expected AA (opt.)</label><input value={expected} onChange={e => setExpected(e.target.value)} placeholder="ASP" style={{ ...cell, width: 70 }} /></div>
        <button onClick={() => run(true)} style={btnSecondary}>Check residue type</button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div>}
      {result && (
        <div style={{ fontSize: 12, lineHeight: 1.7 }}>
          <div>Flat index: <code style={{ color: 'var(--accent-bright)' }}>ri {result.ri}</code>
            {' '}<span style={{ color: 'var(--text-muted)' }}>(use this in the analyses, or type <code style={{ color: 'var(--text-code)' }}>ri {result.ri}</code> directly)</span>
          </div>
          {result.actual_resname !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              {result.check_passed === true && <CheckCircle2 size={14} color="var(--green)" />}
              {result.check_passed === false && <AlertCircle size={14} color="var(--red)" />}
              Residue {result.res_start} in chain {result.chain_id} is <strong>{result.actual_resname || 'not found'}</strong>
              {result.check_passed === true && <span style={{ color: 'var(--green)' }}>— matches {expected.toUpperCase()}</span>}
              {result.check_passed === false && expected && <span style={{ color: 'var(--red)' }}>— expected {expected.toUpperCase()}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const cell: React.CSSProperties = { width: '100%', fontSize: 11, fontFamily: 'var(--font-mono)', padding: '4px 6px' }
const lbl: React.CSSProperties = { display: 'block', fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase' }
const btnPrimary: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 'var(--radius)', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, border: 'none' }
const btnSecondary: React.CSSProperties = { padding: '7px 14px', borderRadius: 'var(--radius)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 12, border: '1px solid var(--border-light)' }

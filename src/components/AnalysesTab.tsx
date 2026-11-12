import { useState, useEffect, useRef } from 'react'
import { Play, Activity, Layers, Boxes } from 'lucide-react'
import { api } from '../api/client'
import { useStore } from '../store'
import ChainResiduePicker from './ChainResiduePicker'
import EnginePicker from './EnginePicker'
import type { AnalysisMeta, Condition, EngineMeta, SelectionChip } from '../types'

// Fallback chips for the GROMACS engine, used until the backend answers.
// Every engine's real chips come from the backend, because the spelling of
// "Protein" is not the same in all of them.
const FALLBACK_CHIPS: SelectionChip[] = [
  { label: 'System', value: 'System' },
  { label: 'Protein', value: 'Protein' },
  { label: 'Backbone', value: 'Backbone' },
  { label: 'C-alpha', value: 'C-alpha' },
  { label: 'MainChain', value: 'MainChain' },
  { label: 'SideChain', value: 'SideChain' },
]

export default function AnalysesTab({ sessionId }: { sessionId: string }) {
  const [pickerFor, setPickerFor] = useState<number | null>(null)
  const [hasSystem, setHasSystem] = useState(false)
  const { activeSession, pollJobs, setJobsPanelOpen,
          pendingSelection, setPendingSelection,
          selectionGroups, analysisDraft, setAnalysisDraft } = useStore()
  const [analyses, setAnalyses]       = useState<AnalysisMeta[]>([])
  const [engines, setEngines]         = useState<EngineMeta[]>([])
  const [engine, setEngine]           = useState<string>('gromacs')
  const [chips, setChips]             = useState<SelectionChip[]>(FALLBACK_CHIPS)
  const [seleHelp, setSeleHelp]       = useState<string>('')
  const [seleWarnings, setSeleWarnings] = useState<string[]>([])
  const [selected, setSelected]       = useState<string>('rmsf')
  const [groups, setGroups]           = useState<string[]>(['C-alpha'])
  const [condIds, setCondIds]         = useState<string[]>([])
  // Which replicas to run, per condition. A condition ABSENT from this map
  // runs all of its replicas — so the default needs no initialisation and
  // cannot drift out of date when a replica is added to a condition later.
  const [repSel, setRepSel]           = useState<Record<string, number[]>>({})
  const [useTimeWindow, setUseTime]   = useState(false)
  const [tStart, setTStart]           = useState('')
  const [tEnd, setTEnd]               = useState('')
  const [launching, setLaunching]     = useState(false)
  const [launchMsg, setLaunchMsg]     = useState('')
  const [force, setForce]             = useState(false)
  const [analysisName, setAnalysisName] = useState('')
  // Per-analysis extras (e.g. the contact cutoff). Driven by the
  // params_schema the backend reports, so adding a parameter to an
  // analysis needs no change here.
  const [params, setParams] = useState<Record<string, any>>({})

  // Restore the form after a tab switch. ProjectScreen unmounts each tab, so
  // without this a half-filled analysis (groups, cutoff, name) was lost every
  // time you looked at the structure to check a residue number.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !analysisDraft || !Object.keys(analysisDraft).length) {
      restored.current = true
      return
    }
    restored.current = true
    if (analysisDraft.engine) setEngine(analysisDraft.engine)
    if (analysisDraft.selected) setSelected(analysisDraft.selected)
    if (analysisDraft.groups) setGroups(analysisDraft.groups)
    if (analysisDraft.params) setParams(analysisDraft.params)
    if (analysisDraft.analysisName) setAnalysisName(analysisDraft.analysisName)
    if (analysisDraft.repSel) setRepSel(analysisDraft.repSel)
    // Mount only, and deliberately: this restores a draft ONCE and then marks
    // itself done. Re-running on later analysisDraft changes would fight the
    // save effect below, which writes the draft from the very state this
    // reads — a restore loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!restored.current) return
    setAnalysisDraft({ engine, selected, groups, params, analysisName, repSel })
  }, [engine, selected, groups, params, analysisName, repSel, setAnalysisDraft])

  const conditions = Object.values(activeSession?.conditions ?? {})
  const readyConditions = conditions.filter(c =>
    (c.replicas?.filter(r => r.paired).length || 0) > 0 && c.pdb
  )

  /** The replica numbers a condition can actually run — its own, not 1..n. */
  const pairedIndices = (c: Condition) =>
    (c.replicas || []).filter(r => r.paired).map(r => r.index)

  /** Chosen replicas for a condition; absent from the map means all of them. */
  const chosenReps = (c: Condition) => repSel[c.id] ?? pairedIndices(c)

  const toggleRep = (c: Condition, idx: number) => setRepSel(prev => {
    const cur = prev[c.id] ?? pairedIndices(c)
    const next = cur.includes(idx) ? cur.filter(i => i !== idx)
                                   : [...cur, idx].sort((a, b) => a - b)
    return { ...prev, [c.id]: next }
  })

  const setAllReps = (c: Condition, on: boolean) =>
    setRepSel(prev => ({ ...prev, [c.id]: on ? pairedIndices(c) : [] }))

  // A condition that is selected but has no replicas left to run would launch a
  // job that fails on the backend. Caught here instead, with the reason shown.
  const emptyConds = readyConditions.filter(
    c => condIds.includes(c.id) && chosenReps(c).length === 0)

  // Engines first: which analyses exist depends on which engine is chosen.
  useEffect(() => {
    api.analysis.engines().then(r => {
      setEngines(r.engines)
      // Never land on an engine that cannot run. If the remembered one is
      // missing, fall back to the first that works rather than showing an
      // analysis list that will refuse to launch.
      setEngine(prev => {
        const chosen = r.engines.find(e => e.id === prev)
        if (chosen?.available) return prev
        return (r.engines.find(e => e.available)?.id) || r.default
      })
    }).catch(() => {})
  }, [])

  /** The analyses and selection vocabulary for one engine. */
  const loadEngine = async (id: string) => {
    const [list, sele] = await Promise.all([
      api.analysis.available(id).catch(() => [] as AnalysisMeta[]),
      api.analysis.translateSelection([], id).catch(() => null),
    ])
    if (sele) {
      setChips(sele.chips?.length ? sele.chips : FALLBACK_CHIPS)
      setSeleHelp(sele.selection_help || '')
    }
    return list
  }

  /**
   * Keep the analysis list, chips and syntax hints matched to the engine.
   *
   * `analysesFor` records which engine the loaded list actually belongs to, and
   * this re-syncs whenever the two drift. That covers three cases a mount-only
   * effect got wrong:
   *
   *   - REMOUNT. ProjectScreen unmounts this tab on every switch, so coming
   *     back re-ran the load with `engine` at its INITIAL value while the saved
   *     draft restored the real one a moment later. The picker said MDAnalysis
   *     and the cards, chips and hints were GROMACS' — and only clicking away
   *     and back fixed it.
   *   - RESTORE. Same thing on first open with a remembered engine.
   *   - FALLBACK. The remembered engine is no longer installed and we move to
   *     one that is.
   *
   * switchEngine sets both together, so a deliberate switch does not load twice.
   */
  const [analysesFor, setAnalysesFor] = useState<string>('')
  useEffect(() => {
    if (analysesFor === engine) return
    let cancelled = false
    loadEngine(engine).then(list => {
      if (cancelled) return
      setAnalyses(list)
      setAnalysesFor(engine)
    })
    return () => { cancelled = true }
  }, [engine, analysesFor])

  useEffect(() => {
    api.system.get(sessionId).then(r => setHasSystem(r.defined)).catch(() => {})
  }, [sessionId])

  /*
   * Default-select all ready conditions.
   *
   * Keyed on the ids, not on readyConditions.length. The count is a proxy that
   * misses a same-size change of membership: if one condition loses its paired
   * replicas in the same refresh that another gains them, the length is
   * identical and this would not re-run — leaving condIds naming a condition
   * that can no longer be analysed.
   */
  const readyIdsKey = readyConditions.map(c => c.id).join(',')
  useEffect(() => {
    setCondIds(readyIdsKey ? readyIdsKey.split(',') : [])
  }, [activeSession?.id, readyIdsKey])

  // A selection sent from the Structure tab lands here.
  //
  // This must survive the "reset groups when analysis changes" effect below:
  // setting the analysis type fires that effect, which overwrites groups with
  // the type's defaults and silently discarded the incoming selection. So we
  // stash it and apply it AFTER the reset has run.
  const [incomingSelection, setIncomingSelection] = useState<string | null>(null)

  useEffect(() => {
    if (!pendingSelection) return
    setIncomingSelection(pendingSelection)
    // Minimum distance is the usual intent for a residue pick, but don't
    // override a type the user deliberately chose.
    setSelected(prev => (prev === 'rmsf' ? 'mindist' : prev))
    setJobsPanelOpen(false)
    setPendingSelection(null)
  }, [pendingSelection, setJobsPanelOpen, setPendingSelection])

  const current = analyses.find(a => a.type === selected)

  /**
   * Switch engine, in one ordered step.
   *
   * Three things have to change together — the analysis list, the selection
   * vocabulary, and the selections themselves — and doing them as independent
   * effects raced: fetching the new analysis list changes `analyses.length`,
   * which fires the reset-groups effect, which would overwrite the translated
   * selections with the new engine's defaults. Whether your picked residues
   * survived came down to which fetch answered first.
   *
   * So it is sequenced here instead, and every piece of state lands in one
   * render.
   */
  const switchEngine = async (next: string) => {
    if (next === engine) return
    const list = await loadEngine(next)

    // An analysis the new engine cannot run has to give way — MDAnalysis has
    // no 2D-RMSD, cpptraj no DSSP.
    const keepsType = list.some(a => a.type === selected)
    const nextType = keepsType ? selected : (list[0]?.type || selected)
    const nextMeta = list.find(a => a.type === nextType)

    // Translate only when the analysis survives. If the type changed, the old
    // selections describe a different question and the new type's defaults are
    // the honest starting point.
    const fallback = nextMeta
      ? nextMeta.default_groups.slice(0, nextMeta.n_groups)
      : groups
    let nextGroups = fallback
    let warnings: string[] = []
    if (keepsType) {
      const r = await api.analysis.translateSelection(groups, next).catch(() => null)
      if (r?.selections?.length) { nextGroups = r.selections; warnings = r.warnings || [] }
    }

    // The same analysis can genuinely need a different NUMBER of selections
    // from one engine to the next: gmx rms fits and measures separately, while
    // MDTraj's Baker–Hubbard hydrogen bonds take a single selection because
    // that is what the algorithm does. Reconcile rather than leaving a field
    // short (which the backend would reject) or stranded (which would silently
    // be ignored).
    if (nextMeta) {
      nextGroups = Array.from({ length: nextMeta.n_groups }, (_, i) =>
        nextGroups[i] ?? fallback[i] ?? nextMeta.default_groups[0] ?? '')
    }

    setEngine(next)
    setAnalyses(list)
    setAnalysesFor(next)
    setSelected(nextType)
    setGroups(nextGroups)
    setSeleWarnings(warnings)
    if (!keepsType && nextMeta) {
      const defaults: Record<string, any> = {}
      for (const f of (nextMeta as any).params_schema || []) defaults[f.key] = f.default
      setParams(defaults)
    }
  }

  // Reset groups when the user picks a different ANALYSIS.
  //
  // Guarded by the last type we actually applied defaults for: switching engine
  // also changes `analyses`, and without this that counted as a type change and
  // wiped the selections switchEngine had just translated.
  const appliedTypeRef = useRef<string | null>(null)
  useEffect(() => {
    if (!current) return
    if (appliedTypeRef.current === selected) return
    appliedTypeRef.current = selected
    setGroups(current.default_groups.slice(0, current.n_groups))
    const schema = (current as any).params_schema || []
    const defaults: Record<string, any> = {}
    for (const f of schema) defaults[f.key] = f.default
    setParams(defaults)
  }, [selected, current])

  // Applied after the reset above, so the picked residues actually stick.
  useEffect(() => {
    if (!incomingSelection || !current) return
    setGroups(prev => {
      const next = prev.length ? [...prev]
                               : current.default_groups.slice(0, current.n_groups)
      // Fill the LAST slot: for a two-group analysis the first stays as the
      // partner group (usually Protein), the picked residues go second.
      next[Math.max(0, (current.n_groups || next.length) - 1)] = incomingSelection
      return next
    })
    setIncomingSelection(null)
    // `current` itself, not current?.type: the body also reads n_groups and
    // default_groups, which can change for the same type when the engine's
    // analysis list is refetched. Re-running is harmless — the guard above
    // returns immediately once incomingSelection is cleared. `groups` is not
    // listed because it is only read through the functional setGroups form.
  }, [incomingSelection, current])

  const toggleCond = (id: string) => {
    setCondIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const setGroup = (i: number, val: string) => {
    setGroups(prev => { const n = [...prev]; n[i] = val; return n })
  }

  /**
   * Insert a saved selection group, in the current engine's language.
   *
   * Groups are stored as the GROMACS expression the Structure tab resolved, so
   * on any other engine they have to be rewritten — otherwise "probe group 1"
   * would work on GROMACS and quietly fail everywhere else.
   */
  const applySavedGroup = async (i: number, selection: string) => {
    if (engine === 'gromacs') { setGroup(i, selection); return }
    try {
      const r = await api.analysis.translateSelection([selection], engine)
      setGroup(i, r.selections[0] ?? selection)
      setSeleWarnings(r.warnings || [])
    } catch {
      setGroup(i, selection)
    }
  }

  const launch = async () => {
    if (!current || condIds.length === 0 || emptyConds.length > 0) return
    setLaunching(true); setLaunchMsg('')

    // Only conditions running FEWER than all their replicas are sent. The
    // backend hashes "all replicas" identically to sending nothing, so an
    // untouched condition still hits any result already cached for it.
    const replicas: Record<string, number[]> = {}
    for (const c of readyConditions) {
      if (!condIds.includes(c.id)) continue
      const all = pairedIndices(c), sel = chosenReps(c)
      if (sel.length < all.length) replicas[c.id] = sel
    }

    try {
      const res = await api.analysis.run({
        session_id: sessionId,
        analysis_type: selected,
        engine,
        condition_ids: condIds,
        replicas,
        groups: groups.slice(0, current.n_groups),
        time_start: useTimeWindow && tStart ? parseFloat(tStart) : null,
        time_end: useTimeWindow && tEnd ? parseFloat(tEnd) : null,
        analysis_name: analysisName,
        params,
        force,
      })
      setLaunchMsg(`Launched ${res.job_ids.length} job(s). See the Jobs panel for progress.`)
      setJobsPanelOpen(true)
      pollJobs()
    } catch (e: any) {
      setLaunchMsg(`Error: ${e.message}`)
    } finally {
      setLaunching(false)
    }
  }

  if (readyConditions.length === 0) {
    return (
      <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <div style={{ textAlign:'center', color:'var(--text-muted)', maxWidth:320 }}>
          <Activity size={40} style={{ margin:'0 auto 12px', opacity:0.25 }} />
          <div style={{ fontSize:15, fontWeight:600, marginBottom:6, color:'var(--text-secondary)' }}>No conditions ready</div>
          <div style={{ fontSize:12 }}>Go to the Setup tab, scan a folder into a condition, and register at least one paired replica + reference structure.</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex:1, overflow:'auto', padding:'24px 28px' }}>
      <div style={{ maxWidth:680 }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:12, marginBottom:4 }}>
          <h2 style={{ margin:0 }}>Run Analysis</h2>
          <div style={{ flex:1 }} />
          <EnginePicker engines={engines} value={engine} onChange={switchEngine} />
        </div>
        <p style={{ color:'var(--text-secondary)', fontSize:12, marginBottom:24 }}>
          Pick an analysis, choose selections and conditions, then launch. Every paired
          replica runs by default and the results are averaged with standard deviation —
          click a replica number to leave it out.
        </p>

        {/* Analysis type selector */}
        <h3 style={{ marginBottom:10 }}>Analysis</h3>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(200px, 1fr))', gap:8, marginBottom:24 }}>
          {analyses.map(a => (
            <div key={a.type} onClick={() => setSelected(a.type)} style={{
              padding:'12px 14px', borderRadius:'var(--radius)', cursor:'pointer',
              background: selected === a.type ? 'var(--bg-elevated)' : 'var(--bg-surface)',
              border:`1px solid ${selected === a.type ? 'var(--accent)' : 'var(--border)'}`,
              transition:'all 150ms',
            }}>
              <div style={{ fontWeight:700, fontSize:13, marginBottom:3, color: selected===a.type ? 'var(--accent-bright)':'var(--text-primary)' }}>
                {a.name}
              </div>
              <div style={{ fontSize:11, color:'var(--text-muted)', lineHeight:1.4 }}>{a.description}</div>
            </div>
          ))}
        </div>

        {/* Index groups.
            Hidden entirely when an analysis has none — Helix motion takes every
            selection as a typed parameter, and an empty "Selections" heading
            with no fields under it reads as something failing to load. */}
        {current && current.n_groups > 0 && (
          <>
            <h3 style={{ marginBottom:10 }}>
              {engine === 'gromacs'
                ? `Index Group${current.n_groups > 1 ? 's' : ''}`
                : `Selection${current.n_groups > 1 ? 's' : ''}`}
            </h3>

            {/* Each engine's syntax, stated where the typing happens rather
                than buried in the picker. */}
            {seleHelp && (
              <p style={{ fontSize:11, color:'var(--text-muted)', lineHeight:1.55,
                          marginTop:-4, marginBottom:10 }}>
                {seleHelp}
              </p>
            )}

            {/* A selection that could not be rewritten for this engine. Shown
                rather than silently sent, because an unreadable selection is
                how you get a confident, wrong answer. */}
            {seleWarnings.map((w, i) => (
              <div key={i} style={{
                marginBottom:10, padding:'7px 10px', borderRadius:4, fontSize:11,
                background:'rgba(247,210,79,0.12)', lineHeight:1.5,
              }}>⚠ {w}</div>
            ))}
            <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:24 }}>
              {Array.from({ length: current.n_groups }).map((_, i) => (
                <div key={i}>
                  <label style={{ display:'block', fontSize:11, color:'var(--text-secondary)', marginBottom:5 }}>
                    {current.group_prompts[i] || `Group ${i+1}`}
                  </label>
                  <div style={{ display:'flex', gap:6, flexWrap:'wrap', position:'relative' }}>
                    {chips.map(c => (
                      <button key={c.label} onClick={() => setGroup(i, c.value)}
                        title={c.value}
                        style={{
                        padding:'5px 12px', borderRadius:20, fontSize:12,
                        background: groups[i] === c.value ? 'var(--accent)' : 'var(--bg-surface)',
                        color: groups[i] === c.value ? '#fff' : 'var(--text-secondary)',
                        border:`1px solid ${groups[i] === c.value ? 'transparent' : 'var(--border)'}`,
                        fontWeight: groups[i] === c.value ? 600 : 400,
                      }}>{c.label}</button>
                    ))}
                    <input
                      value={groups[i] && !chips.some(c => c.value === groups[i]) ? groups[i] : ''}
                      onChange={e => setGroup(i, e.target.value)}
                      placeholder={engine === 'gromacs' ? 'custom, e.g. ri 200-270'
                                 : engine === 'cpptraj' ? 'custom, e.g. :200-270@CA'
                                 : engine === 'mdtraj'  ? 'custom, e.g. resSeq 200 to 270'
                                 : 'custom, e.g. resid 200:270'}
                      style={{ width:200, fontSize:11, fontFamily:'var(--font-mono)' }}
                    />
                    {hasSystem && engine === 'gromacs' && (
                      <button onClick={() => setPickerFor(pickerFor === i ? null : i)} title="Select by chain + residue" style={{
                        display:'flex', alignItems:'center', gap:5, padding:'5px 10px', borderRadius:20, fontSize:11,
                        background:'var(--bg-elevated)', color:'var(--accent-bright)', border:'1px solid var(--border-light)',
                      }}><Boxes size={12} /> chain</button>
                    )}
                    {pickerFor === i && (
                      <ChainResiduePicker
                        sessionId={sessionId}
                        onApply={(ri) => { setGroup(i, ri); setPickerFor(null) }}
                        onClose={() => setPickerFor(null)}
                      />
                    )}
                  </div>

                  {/* Saved groups, per slot. These used to render once, below
                      all the inputs, and always filled the LAST slot — so on a
                      two-group analysis like mindist the first group could
                      never be set from a saved group. */}
                  {selectionGroups.length > 0 && (
                    <div style={{ marginTop:6, display:'flex', alignItems:'center',
                                  gap:6, flexWrap:'wrap' }}>
                      <span style={{ fontSize:11, color:'var(--text-muted)' }}>
                        Saved:
                      </span>
                      {selectionGroups.map(g => (
                        <button key={g.id}
                          onClick={() => applySavedGroup(i, g.selection)}
                          title={g.selection}
                          style={{ fontSize:11, padding:'3px 10px', borderRadius:20,
                                   cursor:'pointer',
                                   border:`1px solid ${groups[i] === g.selection ? 'transparent' : 'var(--border)'}`,
                                   background: groups[i] === g.selection ? 'var(--accent)' : 'var(--bg-elevated)',
                                   color: groups[i] === g.selection ? '#fff' : 'var(--text-secondary)' }}
                        >{g.name} ({g.residues.length})</button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {engine === 'gromacs' && (
                <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2, lineHeight:1.5 }}>
                  Plain names (Protein, C-alpha) or a make_ndx selection like{' '}
                  <code style={{ color:'var(--text-code)' }}>ri 200-270</code> or{' '}
                  <code style={{ color:'var(--text-code)' }}>3 & ri 200-270</code>.
                  Custom selections are built into an index group automatically.
                </div>
              )}
            </div>
          </>
        )}

        {/* Conditions, and which of their replicas to run */}
        <h3 style={{ marginBottom:10 }}>Conditions <span style={{ fontWeight:400, color:'var(--text-muted)', textTransform:'none', letterSpacing:0 }}>— {condIds.length} selected</span></h3>
        <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:24 }}>
          {readyConditions.map(c => {
            const on = condIds.includes(c.id)
            const all = pairedIndices(c)
            const sel = chosenReps(c)
            const subset = sel.length < all.length
            return (
              <div key={c.id} style={{
                borderRadius:'var(--radius)',
                background: on ? 'var(--bg-elevated)' : 'var(--bg-surface)',
                border:`1px solid ${on ? 'var(--border-light)' : 'var(--border)'}`,
              }}>
                <div onClick={() => toggleCond(c.id)} style={{
                  display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
                  cursor:'pointer',
                }}>
                  <div style={{
                    width:16, height:16, borderRadius:4, flexShrink:0,
                    border:`2px solid ${on ? c.colour : 'var(--border-light)'}`,
                    background: on ? c.colour : 'transparent',
                    display:'flex', alignItems:'center', justifyContent:'center',
                  }}>
                    {on && <span style={{ color:'#fff', fontSize:10, fontWeight:900 }}>✓</span>}
                  </div>
                  <div style={{ width:10, height:10, borderRadius:'50%', background:c.colour, flexShrink:0 }} />
                  <span style={{ fontWeight:600, fontSize:13 }}>{c.name}</span>
                  <span style={{ fontSize:11,
                                 color: subset ? 'var(--amber)' : 'var(--text-muted)',
                                 display:'flex', alignItems:'center', gap:4 }}>
                    <Layers size={11} />
                    {subset ? `${sel.length} of ${all.length} replicas`
                            : `${all.length} replica${all.length>1?'s':''}`}
                  </span>
                </div>

                {/* Replica picker. Shown only for a condition that is actually
                    going to run, and only when there is a choice to make. */}
                {on && all.length > 1 && (
                  <div style={{
                    display:'flex', alignItems:'center', gap:5, flexWrap:'wrap',
                    padding:'0 14px 10px 40px',
                  }}>
                    {all.map(i => {
                      const picked = sel.includes(i)
                      return (
                        <button key={i} onClick={() => toggleRep(c, i)}
                                title={`Replica ${i}`}
                                style={{
                                  minWidth:28, padding:'3px 7px', fontSize:11,
                                  fontFamily:'var(--font-mono)', borderRadius:4,
                                  cursor:'pointer',
                                  background: picked ? c.colour : 'transparent',
                                  color: picked ? '#fff' : 'var(--text-muted)',
                                  border:`1px solid ${picked ? c.colour : 'var(--border)'}`,
                                  opacity: picked ? 1 : 0.75,
                                }}>{i}</button>
                      )
                    })}
                    <span style={{ width:6 }} />
                    <button onClick={() => setAllReps(c, true)}
                            disabled={sel.length === all.length}
                            style={{ fontSize:11, padding:'3px 8px', borderRadius:4,
                                     background:'transparent', color:'var(--text-secondary)',
                                     border:'1px solid var(--border)',
                                     opacity: sel.length === all.length ? 0.4 : 1 }}>
                      All
                    </button>
                    <button onClick={() => setAllReps(c, false)}
                            disabled={sel.length === 0}
                            style={{ fontSize:11, padding:'3px 8px', borderRadius:4,
                                     background:'transparent', color:'var(--text-secondary)',
                                     border:'1px solid var(--border)',
                                     opacity: sel.length === 0 ? 0.4 : 1 }}>
                      None
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {emptyConds.length > 0 && (
          <div style={{
            marginTop:-16, marginBottom:20, fontSize:11, padding:'8px 12px',
            borderRadius:'var(--radius)', color:'var(--amber)',
            background:'rgba(247,159,79,0.10)', border:'1px solid var(--border)',
          }}>
            No replicas selected for {emptyConds.map(c => c.name).join(', ')} —
            pick at least one, or deselect the condition.
          </div>
        )}

        {/* Per-analysis parameters (e.g. contact cutoff) */}
        {!!((current as any)?.params_schema?.length) && (
          <div style={{ marginBottom:20 }}>
            <h3 style={{ margin:'0 0 10px' }}>Options</h3>
            {((current as any).params_schema as any[]).map(f => (
              <div key={f.key} style={{ marginBottom:12 }}>
                {f.type === 'choice' ? (
                  <label style={{ display:'flex', alignItems:'center', gap:10, fontSize:13 }}>
                    <span style={{ minWidth:170 }}>{f.label}</span>
                    <select
                      value={params[f.key] ?? f.default}
                      onChange={e => setParams(p => ({ ...p, [f.key]: e.target.value }))}
                      style={{ fontSize:13, padding:'5px 8px',
                               border:'1px solid var(--border)', borderRadius:4,
                               background:'var(--bg)', color:'var(--text)' }}
                    >
                      {(f.choices || []).map((c: any) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                  </label>
                ) : f.type === 'boolean' ? (
                  <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13 }}>
                    <input
                      type="checkbox"
                      checked={!!params[f.key]}
                      onChange={e => setParams(p => ({ ...p, [f.key]: e.target.checked }))}
                    />
                    {f.label}
                  </label>
                ) : f.type === 'text' ? (
                  /* A real text input. Without this branch every non-choice,
                     non-boolean parameter fell through to the number input
                     below, where parseFloat destroyed it — typing the '-' of a
                     residue range made the value unparseable, Chromium reported
                     an empty string, and the whole field reset to its default
                     mid-word. */
                  <label style={{ display:'flex', alignItems:'center', gap:10, fontSize:13 }}>
                    <span style={{ minWidth:170 }}>{f.label}</span>
                    <input
                      type="text"
                      value={params[f.key] ?? f.default ?? ''}
                      placeholder={f.placeholder || f.default || ''}
                      onChange={e => setParams(p => ({ ...p, [f.key]: e.target.value }))}
                      spellCheck={false}
                      style={{ flex:1, minWidth:220, padding:'5px 8px', fontSize:13,
                               fontFamily:'var(--font-mono)',
                               border:'1px solid var(--border)', borderRadius:4,
                               background:'var(--bg)', color:'var(--text)' }}
                    />
                  </label>
                ) : (
                  <label style={{ display:'flex', alignItems:'center', gap:10, fontSize:13 }}>
                    <span style={{ minWidth:170 }}>{f.label}</span>
                    <input
                      type="number"
                      value={params[f.key] ?? f.default}
                      min={f.min} max={f.max} step={f.step}
                      onChange={e => setParams(p => ({
                        ...p, [f.key]: e.target.value === '' ? f.default
                                                             : parseFloat(e.target.value) }))}
                      style={{ width:110, padding:'5px 8px', fontSize:13,
                               border:'1px solid var(--border)', borderRadius:4,
                               background:'var(--bg)', color:'var(--text)' }}
                    />
                  </label>
                )}
                {f.help && (
                  <div style={{ fontSize:11, color:'var(--text-muted)',
                                marginTop:4, marginLeft: f.type === 'boolean' ? 24 : 180,
                                lineHeight:1.5 }}>
                    {f.help}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Time window */}
        <div style={{ marginBottom:24 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', marginBottom:10 }}>
            <input type="checkbox" checked={useTimeWindow} onChange={e => setUseTime(e.target.checked)}
              style={{ accentColor:'var(--accent)' }} />
            <h3 style={{ margin:0 }}>Time window</h3>
            <span style={{ fontSize:11, color:'var(--text-muted)', fontWeight:400, textTransform:'none' }}>
              optional — restrict to a time range
            </span>
          </label>
          {useTimeWindow && (
            <div style={{ display:'flex', gap:12, alignItems:'center', paddingLeft:26 }}>
              <div>
                <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3 }}>Start (ns)</label>
                <input value={tStart} onChange={e => setTStart(e.target.value)} placeholder="0"
                  style={{ width:90, fontFamily:'var(--font-mono)', fontSize:11 }} />
              </div>
              <div>
                <label style={{ display:'block', fontSize:10, color:'var(--text-muted)', marginBottom:3 }}>End (ns)</label>
                <input value={tEnd} onChange={e => setTEnd(e.target.value)} placeholder="500"
                  style={{ width:90, fontFamily:'var(--font-mono)', fontSize:11 }} />
              </div>
            </div>
          )}
        </div>

        {/* Analysis name */}
        <div style={{ marginBottom:18 }}>
          <h3 style={{ marginBottom:8 }}>Analysis name <span style={{ fontWeight:400, color:'var(--text-muted)', textTransform:'none' }}>— optional label</span></h3>
          <input value={analysisName} onChange={e => setAnalysisName(e.target.value)}
            placeholder="e.g. arch_distance (blank = auto-named from selection)"
            style={{ width:360, fontFamily:'var(--font-mono)', fontSize:12 }} />
          <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4, lineHeight:1.5 }}>
            Names this analysis so multiple of the same type (e.g. two mindist pairs) don't collide.
            Files are saved as <code style={{ color:'var(--text-code)' }}>{selected}_{analysisName || 'name'}_1.xvg</code> in their own folder.
          </div>
        </div>

        {/* Launch */}
        <div style={{ display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
          <button onClick={launch}
                  disabled={launching || condIds.length === 0 || emptyConds.length > 0}
                  style={{
            display:'flex', alignItems:'center', gap:8, padding:'11px 24px',
            borderRadius:'var(--radius)', background:'var(--accent)', color:'#fff',
            fontWeight:600, fontSize:14,
          }}>
            <Play size={15} /> {launching ? 'Launching…' : 'Run Analysis'}
          </button>

          <label style={{ display:'flex', alignItems:'center', gap:7, cursor:'pointer', fontSize:12, color:'var(--text-secondary)' }}>
            <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} style={{ accentColor:'var(--accent)' }} />
            Force re-run (ignore cache)
          </label>

          <button onClick={async () => {
            const r = await api.analysis.clearCache(sessionId)
            setLaunchMsg(`Cleared ${r.cleared} cached result(s).`)
          }} style={{
            padding:'8px 14px', borderRadius:'var(--radius)', fontSize:12,
            background:'var(--bg-surface)', color:'var(--text-muted)', border:'1px solid var(--border)',
          }}>
            Clear cache
          </button>

          <button onClick={async () => {
            if (!confirm('Reset all analyses? This clears cached results and job history for a clean slate. Your files and conditions are kept.')) return
            await api.analysis.reset(sessionId)
            pollJobs()
            setLaunchMsg('Reset complete — clean slate.')
          }} style={{
            padding:'8px 14px', borderRadius:'var(--radius)', fontSize:12,
            background:'transparent', color:'var(--red)', border:'1px solid rgba(248,113,113,0.3)',
          }}>
            Reset all analyses
          </button>

          {launchMsg && (
            <span style={{ fontSize:12, color: launchMsg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>
              {launchMsg}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

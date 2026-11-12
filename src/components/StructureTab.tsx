/**
 * StructureTab — the 3D view, wired to results and to selection.
 *
 * Four things happen here:
 *
 *   1. PICK RESIDUES ON THE STRUCTURE. Clicking builds a GROMACS selection,
 *      which replaces the "open ChimeraX, find the loop, note the numbers,
 *      come back and type them in" round trip.
 *
 *   2. COLOUR BY A PER-RESIDUE RESULT. Pick a stored RMSF (or any per-residue
 *      analysis) and the structure is painted by it, so you can see where the
 *      signal actually is on the fold.
 *
 *   3. LINKED BRUSHING. Hovering the plot highlights that residue in 3D;
 *      selecting in 3D marks those positions on the plot. Same residue
 *      identity on both sides, so they can't disagree.
 *
 *   4. HIGHLIGHTS. Named, coloured overlays — the catalytic triad in orange
 *      licorice, the pocket in translucent surface — kept and toggled
 *      independently. Display only: a highlight never changes what is
 *      analysed.
 *
 * STATE LIVES IN THE STORE. Condition, representation, filters, selection and
 * highlights are all in the app store, and ProjectScreen keeps this tab mounted
 * once visited, so a detour through Analyses does not cost you the camera
 * angle, the loaded structure or the view you built up.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Plot from './plots/Plot'
import { Copy, Check, Trash2, Boxes, ArrowRight, Plus, Eye, EyeOff,
         MousePointerClick, Camera } from 'lucide-react'
import { api } from '../api/client'
import { useStore, LAYER_COLOURS } from '../store'
import type { StructureLayer } from '../store'
import { PLOT_CONFIG, getPlotBg, getAxis } from './plots/shared'
import { groupSnapshots, shortTime } from '../lib/snapshotGroups'
import SequenceViewer from './SequenceViewer'
import StructureViewer, {
  PickedResidue, ResidueValue, DisplayFilters,
  ColorScheme, PickMode, Rep, SelectionLevel, SELECTION_LEVELS, InteractionMode,
  SeleCheck, SeqChain,
} from './StructureViewer'

interface StoredResult {
  cache_key: string
  type: string
  name: string
  condition_id: string
  condition_name?: string
  hidden?: boolean
  result?: any
}

interface Props {
  sessionId: string
  /** False while another tab is on screen — this one stays mounted. */
  active?: boolean
}

/**
 * Representations that make sense for a highlight overlay.
 *
 * 'none' means colour only — paint the region onto the base representation and
 * add nothing on top. That is the plain "colour this loop orange" case, and
 * without it the only way to see a highlight was to stack licorice over the
 * cartoon.
 */
const LAYER_REPS = [
  'none', 'licorice', 'ball+stick', 'spacefill', 'hyperball',
  'cartoon', 'tube', 'surface', 'point',
]

export default function StructureTab({ sessionId, active = true }: Props) {
  const { activeSession, jobs, setPendingSelection, setRequestedTab,
          structureSelection, setStructureSelection,
          structureView, setStructureView,
          structureLayers, addStructureLayer, updateStructureLayer,
          removeStructureLayer, structureFrame,
          structureFrames, activeFrameId, setActiveFrame,
          removeStructureFrame, updateStructureFrame,
          selectionGroups, addSelectionGroup, removeSelectionGroup } = useStore()

  // Selection and display settings are stored globally so they survive tab
  // switches — see the note at the top of the file.
  const selected = structureSelection as PickedResidue[]
  const setSelected = (
    v: PickedResidue[] | ((prev: PickedResidue[]) => PickedResidue[])
  ) => setStructureSelection(
    typeof v === 'function' ? (v as any)(structureSelection) : v)

  const { conditionId, colourKey, filters, colorScheme, rep, pickMode, level,
          interactionMode, selectionColor, neighbourRadius } = structureView
  const setColourKey      = (v: string)          => setStructureView({ colourKey: v })
  const setFilters        = (v: DisplayFilters)  => setStructureView({ filters: v })
  const setColorScheme    = (v: ColorScheme)     => setStructureView({ colorScheme: v })
  const setRep            = (v: Rep)             => setStructureView({ rep: v })
  const setPickMode       = (v: PickMode)        => setStructureView({ pickMode: v })
  const setLevel          = (v: SelectionLevel)  => setStructureView({ level: v })
  const setInteractionMode = (v: InteractionMode) => setStructureView({ interactionMode: v })
  const setSelectionColor = (v: string)          => setStructureView({ selectionColor: v })
  const setNeighbourRadius = (v: number)         => setStructureView({ neighbourRadius: v })

  const conditions = useMemo(
    () => Object.values(activeSession?.conditions || {}) as any[],
    [activeSession]
  )

  // Snapshots grouped for display only — the stored list keeps the order it
  // was built in, which is what a session saves and what ids refer to.
  // Its own memo: a fresh array every render would restart the grouping in the
  // viewer below on every keystroke.
  const conditionIds = useMemo(() => conditions.map(c => c.id), [conditions])
  const snapshotGroups = useMemo(
    () => groupSnapshots(structureFrames, conditionIds),
    [structureFrames, conditionIds]
  )

  const [stored, setStored] = useState<StoredResult[]>([])
  const [values, setValues] = useState<ResidueValue[] | null>(null)
  const [valueLabel, setValueLabel] = useState<string>('')
  const [valueError, setValueError] = useState<string | null>(null)

  const [hoveredFromPlot, setHoveredFromPlot] = useState<PickedResidue[]>([])
  const [resolved, setResolved] = useState<{
    selection: string; problems: string[]; notes?: string[]
    mutations?: any[]; atom_level?: boolean; ok: boolean
  } | null>(null)
  const [copied, setCopied] = useState(false)

  // ChimeraX-style breadth: atom -> residue -> secondary structure -> chain.
  const expanderRef = useRef<((p: PickedResidue[], l: SelectionLevel) => PickedResidue[]) | null>(null)
  // The residues actually clicked, before any widening.
  const anchorRef = useRef<PickedResidue[]>([])
  const [groupName, setGroupName] = useState('')

  // Highlight selections are checked against the loaded structure, not guessed
  // at — the viewer hands us a validator once the structure is in.
  const checkSeleRef = useRef<((s: string) => SeleCheck) | null>(null)
  const [checkReady, setCheckReady] = useState(0)
  const [layerChecks, setLayerChecks] = useState<Record<string, SeleCheck>>({})

  /**
   * Typed selection text is held locally and committed on a short delay.
   *
   * Committing on every keystroke means the viewer rebuilds the layer's
   * geometry for every prefix of what you are typing — and half-typed text
   * matches wildly different things on the way ("2", "26", "260-280:A"), so a
   * licorice overlay flickers over most of the protein while you type.
   */
  const [seleDrafts, setSeleDrafts] = useState<Record<string, string>>({})
  const commitTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (commitTimer.current) window.clearTimeout(commitTimer.current)
  }, [])

  const editSele = (id: string, text: string) => {
    setSeleDrafts(d => ({ ...d, [id]: text }))
    if (commitTimer.current) window.clearTimeout(commitTimer.current)
    commitTimer.current = window.setTimeout(
      () => updateStructureLayer(id, { sele: text }), 300)
  }

  const setSeleNow = (id: string, text: string) => {
    if (commitTimer.current) window.clearTimeout(commitTimer.current)
    setSeleDrafts(d => ({ ...d, [id]: text }))
    updateStructureLayer(id, { sele: text })
  }

  /**
   * Stable identities, both of them.
   *
   * The viewer re-runs its handover effect whenever these props change, and
   * `onResolve` sets state — so an inline arrow here is an infinite loop:
   * render -> new prop -> effect -> setState -> render.
   */
  const handleWiden = useCallback(
    (fn: (p: PickedResidue[], l: SelectionLevel) => PickedResidue[]) => {
      expanderRef.current = fn
    }, [])

  const handleResolve = useCallback((fn: (sele: string) => SeleCheck) => {
    checkSeleRef.current = fn
    setCheckReady(v => v + 1)
  }, [])

  const [sequence, setSequence] = useState<SeqChain[]>([])
  const handleSequence = useCallback((chains: SeqChain[]) => setSequence(chains), [])
  const [showSequence, setShowSequence] = useState(true)

  /** Residues per highlight, so the sequence can show highlight colours. */
  const layerResidues = useMemo(() => {
    const out: Record<string, PickedResidue[]> = {}
    for (const [id, c] of Object.entries(layerChecks)) out[id] = c.residues || []
    return out
  }, [layerChecks])

  useEffect(() => {
    const check = checkSeleRef.current
    if (!check) return
    const next: Record<string, SeleCheck> = {}
    for (const l of structureLayers) next[l.id] = check(l.sele)
    setLayerChecks(next)
  }, [structureLayers, checkReady, conditionId])

  /**
   * Widening/narrowing always derives from the ANCHOR — the residues actually
   * clicked — never from the current selection.
   *
   * Deriving from the current selection is why ↓ did nothing: once ↑ had
   * widened to the whole chain, narrowing recomputed "the residues of the
   * chain containing every residue of the chain", i.e. the same set. ChimeraX
   * keeps the original pick for exactly this reason.
   */
  const applyLevel = (next: SelectionLevel) => {
    setLevel(next)
    const anchor = anchorRef.current
    if (!expanderRef.current || !anchor.length) return
    setSelected(expanderRef.current(anchor, next))
  }

  /** A click in the viewer resets the anchor — that's the new starting point. */
  const handlePick = (picks: PickedResidue[]) => {
    anchorRef.current = picks
    // Only write when it actually changes: a sweep across the sequence fires
    // this once per residue, and every store write redraws the scene.
    const next = picks.some(p => p.atom) ? 'atom' : 'residue'
    if (next !== level) setLevel(next)
    setSelected(picks)
  }

  const step = (dir: 1 | -1) => {
    const i = SELECTION_LEVELS.indexOf(level)
    const j = Math.min(SELECTION_LEVELS.length - 1, Math.max(0, i + dir))
    if (j !== i) applyLevel(SELECTION_LEVELS[j])
  }

  // Up/down widen and narrow, as in ChimeraX. Ignored while typing so the
  // highlight and group-name fields still behave normally — and ignored
  // entirely while another tab is on screen, since this one stays mounted.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.key === 'ArrowUp') { e.preventDefault(); step(1) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); step(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Default to the first condition that actually has a structure.
  useEffect(() => {
    if (conditionId || !conditions.length) return
    const withPdb = conditions.find(c => c.pdb || c.files?.pdb)
    // setStructureView directly, not the setConditionId adapter above: that
    // adapter is a fresh arrow on every render, so depending on it would run
    // this effect every render. The store action is stable.
    setStructureView({ conditionId: (withPdb || conditions[0]).id })
  }, [conditions, conditionId, setStructureView])

  // Stored results, refreshed when a job completes.
  const nDone = jobs.filter(j => j.status === 'completed').length
  useEffect(() => {
    if (!sessionId) return
    api.analysis.storedResults(sessionId)
      .then(r => setStored(r.results || []))
      .catch(() => {})
  }, [sessionId, nDone])

  /**
   * Only per-residue results can be painted onto a structure. A per-frame
   * series (RMSD vs time) has no residue to attach to, so offering it would
   * just produce an error on click — filter it out here instead.
   */
  const colourable = useMemo(() => stored.filter(it => {
    const r = it.result
    if (!r || !r.x) return false
    const xl = String(r.xlabel || '').toLowerCase()
    if (xl.includes('time')) return false
    return it.condition_id === conditionId || r.condition_id === conditionId
  }), [stored, conditionId])

  // Fetch per-residue values for the chosen result.
  useEffect(() => {
    if (!colourKey) { setValues(null); setValueLabel(''); setValueError(null); return }
    let cancelled = false
    api.structure.residueValues(sessionId, colourKey)
      .then(r => {
        if (cancelled) return
        setValues(r.items)
        // The stable store action, not the per-render adapter — same reason as
        // the condition-default effect above.
        setStructureView({ colorScheme: 'value' })   // colouring by it is the reason you picked it
        setValueLabel(r.label || r.analysis_name || 'value')
        setValueError(r.n_unmapped > 0
          ? `${r.n_unmapped} residue(s) could not be mapped onto the structure.`
          : null)
      })
      .catch(e => {
        if (cancelled) return
        setValues(null)
        setValueError(e?.message || 'Could not map this result onto residues.')
      })
    return () => { cancelled = true }
  }, [sessionId, colourKey, setStructureView])

  // Resolve picks -> GROMACS selection (and catch structure mismatches).
  useEffect(() => {
    if (!selected.length) { setResolved(null); return }
    let cancelled = false
    api.structure.resolvePicks(sessionId, selected)
      .then(r => { if (!cancelled) setResolved(r) })
      .catch(() => { if (!cancelled) setResolved(null) })
    return () => { cancelled = true }
  }, [sessionId, selected])

  const sendToAnalysis = () => {
    if (!resolved?.selection) return
    // Hand the resolved 'ri ...' selection to the Analyses tab. The whole point
    // of picking on the structure is to skip typing residue indices by hand —
    // and getting them wrong, which is what the make_ndx errors were.
    setPendingSelection(resolved.selection)
    setRequestedTab('analyses')
  }

  const copySelection = () => {
    if (!resolved?.selection) return
    navigator.clipboard?.writeText(resolved.selection)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  // ── Highlights ────────────────────────────────────────────────────────────

  /** NGL selection text for the current pick, used to seed a highlight. */
  const seleFromSelection = (picks: PickedResidue[]) => picks
    .map(r => (r.chain ? `${r.resnum}:${r.chain}` : `${r.resnum}`))
    .join(' or ')

  const [savingGroup, setSavingGroup] = useState<string | null>(null)
  const [groupError, setGroupError] = useState<string | null>(null)

  /** A highlight, loaded into the analysis selection so it can be measured. */
  const selectLayer = (l: StructureLayer) => {
    const residues = layerChecks[l.id]?.residues
    if (!residues?.length) return
    anchorRef.current = residues
    setLevel('residue')
    setSelected(residues)
  }

  /**
   * A highlight, saved as a named selection group in one step.
   *
   * Goes through resolve-picks like every other route into a group, so a
   * highlight that lands on residues the system definition doesn't describe is
   * reported rather than saved as a selection that make_ndx will later reject.
   */
  const saveLayerAsGroup = async (l: StructureLayer) => {
    const residues = layerChecks[l.id]?.residues
    if (!residues?.length) return
    setSavingGroup(l.id)
    setGroupError(null)
    try {
      const r = await api.structure.resolvePicks(sessionId, residues)
      if (!r.selection) throw new Error('Could not resolve these residues.')
      addSelectionGroup({
        id: Math.random().toString(36).slice(2, 9),
        name: l.name,
        residues,
        selection: r.selection,
      })
      if (r.problems?.length) setGroupError(`${l.name}: ${r.problems[0]}`)
    } catch (e: any) {
      setGroupError(e?.message || 'Could not save this highlight as a group.')
    } finally {
      setSavingGroup(null)
    }
  }

  const newLayer = (patch: Partial<StructureLayer> = {}): StructureLayer => ({
    id: Math.random().toString(36).slice(2, 9),
    name: `Highlight ${structureLayers.length + 1}`,
    sele: '',
    rep: 'licorice',
    // Cycle the palette so two highlights are never the same colour by
    // default — the whole point is telling them apart at a glance.
    color: LAYER_COLOURS[structureLayers.length % LAYER_COLOURS.length],
    opacity: 1,
    visible: true,
    sideChainsOnly: true,
    colorBase: true,
    ...patch,
  })

  // ── Linked plot ───────────────────────────────────────────────────────────
  const plotData = useMemo(() => {
    if (!values?.length) return []
    const sorted = [...values].sort((a, b) =>
      a.chain === b.chain ? a.resnum - b.resnum : a.chain.localeCompare(b.chain))
    const selKeys = new Set(selected.map(r => `${r.chain}:${r.resnum}`))
    return [
      {
        x: sorted.map(v => v.resnum),
        y: sorted.map(v => v.value),
        type: 'scatter' as const,
        mode: 'lines' as const,
        line: { color: '#4f8ef7', width: 1.5 },
        name: valueLabel,
        customdata: sorted.map(v => v.chain),
        hovertemplate: '%{y:.3f}<br>residue %{x} (chain %{customdata})<extra></extra>',
      },
      // Selected residues marked on the plot — the other half of the link.
      {
        x: sorted.filter(v => selKeys.has(`${v.chain}:${v.resnum}`)).map(v => v.resnum),
        y: sorted.filter(v => selKeys.has(`${v.chain}:${v.resnum}`)).map(v => v.value),
        type: 'scatter' as const,
        mode: 'markers' as const,
        marker: { color: '#f7d24f', size: 9, line: { color: '#000', width: 1 } },
        name: 'selected',
        hoverinfo: 'skip' as const,
      },
    ]
  }, [values, valueLabel, selected])

  const panel: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 12,
  }

  const field: React.CSSProperties = {
    fontSize: 11, padding: '4px 7px',
    border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg)', color: 'var(--text)',
  }

  const smallButton: React.CSSProperties = {
    fontSize: 11, padding: '4px 9px', borderRadius: 4, cursor: 'pointer',
    border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 5,
  }

  if (!conditions.length) {
    return (
      <div style={{ ...panel, flex: 1, margin: '24px 28px',
                    textAlign: 'center', padding: 40, opacity: 0.7 }}>
        <Boxes size={28} style={{ opacity: 0.5 }} />
        <p style={{ marginTop: 10, fontSize: 13 }}>
          No conditions yet. Add one in the Setup tab, with a reference PDB.
        </p>
      </div>
    )
  }

  return (
    // flex:1 + overflow:auto — the parent is overflow:hidden, so without this
    // the tab clips instead of scrolling (matches SystemTab/ResultsTab).
    <div style={{
      flex: 1, overflow: 'auto', padding: '24px 28px',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {/* Controls */}
      <div style={{ ...panel, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          Condition
          <select
            value={conditionId}
            onChange={e => {
              // A snapshot belongs to the condition it was dumped from, so
              // changing condition falls back to the reference rather than
              // showing a structure the label no longer describes. The
              // snapshot itself is kept — switching away and back should not
              // cost you the moments you found.
              setActiveFrame(null)
              setStructureView({ conditionId: e.target.value, colourKey: '' })
              setSelected([])
            }}
            style={{ fontSize: 12, padding: '4px 6px' }}
          >
            {conditions.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{(c.pdb || c.files?.pdb) ? '' : ' (no PDB)'}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          Colour by
          <select
            value={colourKey}
            onChange={e => setColourKey(e.target.value)}
            style={{ fontSize: 12, padding: '4px 6px', minWidth: 180 }}
          >
            <option value="">— none —</option>
            {colourable.map(it => (
              <option key={it.cache_key} value={it.cache_key}>
                {it.name ? `${it.type} · ${it.name}` : it.type}
              </option>
            ))}
          </select>
        </label>

        {!colourable.length && (
          <span style={{ fontSize: 11, opacity: 0.6 }}>
            No per-residue results for this condition yet — run an RMSF.
          </span>
        )}
      </div>

      {valueError && (
        <div style={{
          ...panel, padding: '8px 12px', fontSize: 12,
          background: 'rgba(247,127,79,0.12)',
        }}>⚠ {valueError}</div>
      )}

      {/* ── Snapshots ────────────────────────────────────────────────────────
          A frame is a different thing from the reference structure, and
          mistaking one for the other would make every reading wrong — so which
          one is on screen is stated permanently, not just when it changes.

          They accumulate rather than replacing one another: pulling a second
          moment out of a plot used to discard the first, which made the obvious
          question — what is different between them? — the one thing you could
          not ask. */}
      {structureFrames.length > 0 && (
        <div style={{
          ...panel, padding: '9px 12px', display: 'flex', alignItems: 'center',
          gap: 8, flexWrap: 'wrap', fontSize: 12,
          background: structureFrame ? 'rgba(79,208,208,0.10)' : undefined,
          borderColor: structureFrame ? 'rgba(79,208,208,0.45)' : undefined,
        }}>
          <Camera size={14} />
          <span style={{ opacity: 0.75, fontSize: 11 }}>Snapshots</span>

          <button
            onClick={() => setActiveFrame(null)}
            title="The reference structure this project was set up with"
            style={{ ...smallButton,
              background: activeFrameId === null ? 'var(--accent)' : 'transparent',
              color: activeFrameId === null ? '#fff' : 'var(--text)',
              borderColor: activeFrameId === null ? 'transparent' : 'var(--border)',
            }}
          >Reference</button>

          <span style={{ opacity: 0.45, fontSize: 11 }}>
            {structureFrames.length} snapshot{structureFrames.length === 1 ? '' : 's'}
          </span>

          <div style={{ flex: 1 }} />
          {structureFrame && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 5,
                            fontSize: 11, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={structureFrame.includeSolvent}
                onChange={e => updateStructureFrame(structureFrame.id, {
                  includeSolvent: e.target.checked })}
              />
              include solvent
            </label>
          )}

          {/* Grouped: condition, then replica, then time.
              They arrive in the order moments were pulled out of plots, which
              is the order of a train of thought and not of anything in the
              data — a hundred of them wrapped into one row left the same
              replica's moments scattered through it and pushed the viewer off
              the bottom of the screen. The row says which condition and
              replica, so a chip only has to carry its time. */}
          <div style={{
            width: '100%', display: 'flex', flexDirection: 'column', gap: 2,
            // Bounded, because the list only grows. Beyond this it scrolls
            // rather than pushing the structure out of view.
            maxHeight: 190, overflowY: 'auto', marginTop: 2,
          }}>
            {snapshotGroups.map(group => (
              <div key={group.conditionId}>
                <div style={{
                  fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase',
                  opacity: 0.5, margin: '4px 0 2px',
                }}>
                  {group.conditionName} · {group.total}
                </div>
                {group.replicas.map(replica => (
                  <div key={replica.replicaIndex} style={{
                    display: 'flex', alignItems: 'baseline', gap: 6,
                    flexWrap: 'wrap', marginBottom: 2,
                  }}>
                    <span style={{
                      fontSize: 11, opacity: 0.6, minWidth: 46,
                      flex: '0 0 auto',
                    }}>rep {replica.replicaIndex}</span>
                    {replica.frames.map(f => {
                      const on = f.id === activeFrameId
                      return (
                        <span key={f.id}
                              style={{ display: 'flex', alignItems: 'center' }}>
                          <button
                            onClick={() => setActiveFrame(f.id)}
                            title={`${f.conditionName} · rep ${f.replicaIndex} · `
                                   + `${f.timeNs.toFixed(2)} ns`
                                   + (f.label ? ` — from ${f.label}` : '')}
                            style={{ ...smallButton, borderRadius: '4px 0 0 4px',
                              borderRight: 'none', padding: '2px 6px',
                              fontFamily: 'var(--font-mono)',
                              background: on ? 'var(--accent)' : 'transparent',
                              color: on ? '#fff' : 'var(--text)',
                              borderColor: on ? 'transparent' : 'var(--border)',
                            }}
                          >{shortTime(f.timeNs)}</button>
                          <button
                            onClick={() => removeStructureFrame(f.id)}
                            title="Forget this snapshot"
                            style={{ ...smallButton, borderRadius: '0 4px 4px 0',
                              padding: '2px 4px', opacity: 0.55,
                              background: on ? 'var(--accent)' : 'transparent',
                              color: on ? '#fff' : 'var(--text)',
                              borderColor: on ? 'transparent' : 'var(--border)',
                            }}
                          >×</button>
                        </span>
                      )
                    })}
                    {/* The unit, once per row rather than once per chip. */}
                    <span style={{ fontSize: 10, opacity: 0.4 }}>ns</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Viewer */}
      {conditionId && (
        <StructureViewer
          sessionId={sessionId}
          conditionId={conditionId}
          values={values}
          valueLabel={valueLabel}
          highlight={hoveredFromPlot}
          selected={selected}
          onSelectionChange={handlePick}
          filters={filters}
          onFiltersChange={setFilters}
          colorScheme={colorScheme}
          onColorSchemeChange={setColorScheme}
          representation={rep}
          onRepresentationChange={setRep}
          pickMode={pickMode}
          onPickModeChange={setPickMode}
          layers={structureLayers}
          frame={structureFrame}
          frames={structureFrames}
          conditionOrder={conditionIds}
          onActivateFrame={setActiveFrame}
          onWiden={handleWiden}
          onResolve={handleResolve}
          onSequence={handleSequence}
          interactionMode={interactionMode}
          onInteractionModeChange={setInteractionMode}
          selectionColor={selectionColor}
          onSelectionColorChange={setSelectionColor}
          neighbourRadius={neighbourRadius}
          onNeighbourRadiusChange={setNeighbourRadius}
          active={active}
        />
      )}

      {/* Sequence — the same selection as the 3D view, read the other way. */}
      <div style={panel}>
        <div style={{ display: 'flex', alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: showSequence ? 10 : 0 }}>
          <strong style={{ fontSize: 13 }}>Sequence</strong>
          <button
            onClick={() => setShowSequence(v => !v)}
            style={smallButton}
          >{showSequence ? 'Hide' : 'Show'}</button>
        </div>
        {showSequence && (
          <SequenceViewer
            chains={sequence}
            selected={selected}
            onSelectionChange={handlePick}
            onHover={setHoveredFromPlot}
            layers={structureLayers}
            layerResidues={layerResidues}
            selectionColor={selectionColor}
          />
        )}
      </div>

      {/* ── Highlights ──────────────────────────────────────────────────────
          Purely visual overlays. Kept apart from the analysis selection on
          purpose: "let me look closely at this pocket" and "measure these
          residues" are different intents that happen to look alike. */}
      <div style={panel}>
        <div style={{ display: 'flex', alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: structureLayers.length ? 10 : 0 }}>
          <strong style={{ fontSize: 13 }}>Highlights</strong>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => addStructureLayer(newLayer({
                name: selected.length === 1
                  ? `${selected[0].resname} ${selected[0].resnum}`
                  : `Selection (${selected.length})`,
                sele: seleFromSelection(selected),
              }))}
              disabled={!selected.length}
              title="Turn the current pick into a coloured overlay"
              style={{ ...smallButton,
                       cursor: selected.length ? 'pointer' : 'default',
                       opacity: selected.length ? 1 : 0.4 }}
            ><Plus size={12} /> From selection</button>
            <button
              onClick={() => addStructureLayer(newLayer())}
              style={smallButton}
            ><Plus size={12} /> Add</button>
          </div>
        </div>

        {groupError && (
          <div style={{ marginBottom: 8, padding: '7px 9px', borderRadius: 4,
                        fontSize: 11, lineHeight: 1.5,
                        background: 'rgba(247,127,79,0.12)' }}>⚠ {groupError}</div>
        )}

        {!structureLayers.length ? (
          <p style={{ fontSize: 12, opacity: 0.65, margin: 0, lineHeight: 1.6 }}>
            Give a region a colour and a style and it stays on screen — several
            at once, each toggled on its own. Viewing only: highlights never
            change what gets analysed.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {structureLayers.map(l => {
              const check = layerChecks[l.id]
              const bad = check?.ready && !!check.error
              const empty = check?.ready && !check.error && check.atoms === 0
                            && !!l.sele.trim()
              return (
                <div key={l.id} style={{
                  border: `1px solid ${bad ? 'rgba(247,79,79,0.5)' : 'var(--border)'}`,
                  borderLeft: `3px solid ${l.visible ? l.color : 'var(--border)'}`,
                  borderRadius: 4, padding: '8px 10px',
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                                flexWrap: 'wrap' }}>
                    <button
                      onClick={() => updateStructureLayer(l.id, { visible: !l.visible })}
                      title={l.visible ? 'Hide' : 'Show'}
                      style={{ display: 'flex', background: 'transparent',
                               border: 'none', cursor: 'pointer', padding: 0,
                               color: l.visible ? 'var(--text)' : 'var(--text-muted)' }}
                    >{l.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>

                    <input
                      value={l.name}
                      onChange={e => updateStructureLayer(l.id, { name: e.target.value })}
                      style={{ ...field, width: 130, fontWeight: 600 }}
                    />

                    <input
                      type="color"
                      value={l.color}
                      onChange={e => updateStructureLayer(l.id, { color: e.target.value })}
                      title="Highlight colour"
                      style={{ width: 28, height: 22, padding: 0, cursor: 'pointer',
                               border: '1px solid var(--border)', borderRadius: 3,
                               background: 'transparent' }}
                    />

                    <select
                      value={l.rep}
                      onChange={e => updateStructureLayer(l.id, { rep: e.target.value })}
                      style={{ fontSize: 11, padding: '3px 4px' }}
                    >
                      {LAYER_REPS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>

                    {l.rep !== 'none' && (
                      <label style={{ fontSize: 11, display: 'flex',
                                      alignItems: 'center', gap: 5, opacity: 0.85 }}>
                        opacity
                        <input
                          type="range" min={0.1} max={1} step={0.05}
                          value={l.opacity}
                          onChange={e => updateStructureLayer(l.id,
                            { opacity: parseFloat(e.target.value) })}
                          style={{ width: 70 }}
                        />
                      </label>
                    )}

                    <label style={{ fontSize: 11, display: 'flex',
                                    alignItems: 'center', gap: 4, cursor: 'pointer' }}
                           title="Paint this colour onto the cartoon (or whatever the base representation is)">
                      <input
                        type="checkbox"
                        checked={l.colorBase}
                        onChange={e => updateStructureLayer(l.id,
                          { colorBase: e.target.checked })}
                      />
                      colour structure
                    </label>

                    {l.rep !== 'none' && (
                      <label style={{ fontSize: 11, display: 'flex',
                                      alignItems: 'center', gap: 4, cursor: 'pointer' }}
                             title="Polymer reduced to side chain + Cα; ligands, ions and waters kept whole">
                        <input
                          type="checkbox"
                          checked={l.sideChainsOnly}
                          onChange={e => updateStructureLayer(l.id,
                            { sideChainsOnly: e.target.checked })}
                        />
                        side chains
                      </label>
                    )}

                    <div style={{ flex: 1 }} />

                    <button
                      onClick={() => removeStructureLayer(l.id)}
                      title="Delete highlight"
                      style={{ display: 'flex', background: 'transparent',
                               border: 'none', cursor: 'pointer',
                               color: 'var(--text-muted)', padding: 0 }}
                    ><Trash2 size={13} /></button>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      value={seleDrafts[l.id] ?? l.sele}
                      onChange={e => editSele(l.id, e.target.value)}
                      placeholder="e.g. 260-280:A  ·  269:A or 273:A  ·  within 5 of (269:A)"
                      style={{ ...field, flex: 1, minWidth: 180,
                               fontFamily: 'var(--font-mono)' }}
                    />
                    <button
                      onClick={() => setSeleNow(l.id, seleFromSelection(selected))}
                      disabled={!selected.length}
                      title="Replace with the current pick"
                      style={{ ...smallButton,
                               cursor: selected.length ? 'pointer' : 'default',
                               opacity: selected.length ? 1 : 0.4 }}
                    >Use selection</button>
                    {/* The other direction: a highlight you built by eye
                        becomes something you can measure. */}
                    <button
                      onClick={() => selectLayer(l)}
                      disabled={!check?.residues?.length}
                      title="Load these residues into the analysis selection"
                      style={{ ...smallButton,
                               cursor: check?.residues?.length ? 'pointer' : 'default',
                               opacity: check?.residues?.length ? 1 : 0.4 }}
                    ><MousePointerClick size={12} /> Select</button>
                    <button
                      onClick={() => saveLayerAsGroup(l)}
                      disabled={!check?.residues?.length || savingGroup === l.id}
                      title="Save these residues as a named selection group"
                      style={{ ...smallButton,
                               cursor: check?.residues?.length ? 'pointer' : 'default',
                               opacity: check?.residues?.length ? 1 : 0.4 }}
                    >{savingGroup === l.id ? 'Saving…' : 'Save as group'}</button>
                  </div>

                  {/* Feedback on what the selection actually matches. NGL
                      treats an unparseable selection as "select everything",
                      so a silent typo used to fill the view with solvent. */}
                  {bad && (
                    <div style={{ fontSize: 11, color: 'var(--danger, #f74f4f)',
                                  lineHeight: 1.5 }}>
                      ⚠ {check.error} — highlight hidden until this parses.
                    </div>
                  )}
                  {empty && (
                    <div style={{ fontSize: 11, opacity: 0.65 }}>
                      Matches nothing in this structure (or it is hidden by the
                      Show toggles above).
                    </div>
                  )}
                  {check?.ready && !bad && !empty && check.atoms > 0 && (
                    <div style={{ fontSize: 11, opacity: 0.6 }}>
                      {check.atoms.toLocaleString()} atoms
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Selection summary */}
      <div style={panel}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: selected.length ? 8 : 0,
        }}>
          <strong style={{ fontSize: 13 }}>
            Selection {selected.length ? `(${selected.length} residue${selected.length > 1 ? 's' : ''})` : ''}
          </strong>
          {selected.length > 0 && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={sendToAnalysis}
                disabled={!resolved?.ok}
                title={resolved?.ok ? 'Use this selection in a new analysis'
                                     : 'Resolve the selection first'}
                style={{
                  fontSize: 11, padding: '4px 9px', borderRadius: 4,
                  cursor: resolved?.ok ? 'pointer' : 'default',
                  border: '1px solid var(--accent)',
                  background: resolved?.ok ? 'var(--accent)' : 'transparent',
                  color: resolved?.ok ? '#fff' : 'var(--text)',
                  opacity: resolved?.ok ? 1 : 0.4,
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              ><ArrowRight size={12} /> Use in analysis</button>
              <button
                onClick={copySelection}
                disabled={!resolved?.selection}
                style={{ ...smallButton,
                         cursor: resolved?.selection ? 'pointer' : 'default' }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={() => { anchorRef.current = []; setSelected([]) }}
                style={smallButton}
              ><Trash2 size={12} /> Clear</button>
            </div>
          )}
        </div>

        {!selected.length && (
          <p style={{ fontSize: 12, opacity: 0.65, margin: 0 }}>
            Click residues in the structure above to build a selection. No need to
            look the numbers up elsewhere.
          </p>
        )}

        {selected.length > 0 && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
              {selected.map(r => (
                <span key={`${r.chain}:${r.resnum}:${r.atom || ''}`} style={{
                  fontSize: 11, padding: '2px 7px', borderRadius: 10,
                  border: '1px solid var(--border)', background: 'var(--bg-elevated)',
                }}>
                  {r.resname} {r.resnum}{r.chain ? ` · ${r.chain}` : ''}
                  {r.atom ? ` · ${r.atom}` : ''}
                </span>
              ))}
            </div>

            {/* Breadth control — same widening ladder as ChimeraX */}
            <div style={{ display:'flex', alignItems:'center', gap:8,
                          marginBottom:8, flexWrap:'wrap' }}>
              <span style={{ fontSize:11, opacity:0.7 }}>Breadth</span>
              {SELECTION_LEVELS.map(l => (
                <button key={l} onClick={() => applyLevel(l)}
                  style={{ fontSize:11, padding:'3px 8px', borderRadius:4,
                           cursor:'pointer', border:'1px solid var(--border)',
                           background: level===l ? 'var(--accent)' : 'transparent',
                           color: level===l ? '#fff' : 'var(--text)' }}
                >{l === 'sstruc' ? 'structure' : l}</button>
              ))}
              <span style={{ fontSize:11, opacity:0.55 }}>
                ↑ widen · ↓ narrow
              </span>
            </div>

            {resolved?.selection && (
              <code style={{
                display: 'block', fontSize: 11, padding: '7px 9px', borderRadius: 4,
                background: 'var(--bg)', border: '1px solid var(--border)',
                wordBreak: 'break-all',
              }}>{resolved.selection}</code>
            )}

            {/* Blocking problems — the selection cannot be used. */}
            {resolved?.problems?.map((p, i) => (
              <div key={`p${i}`} style={{
                marginTop: 8, padding: '7px 9px', borderRadius: 4, fontSize: 11,
                background: 'rgba(247,79,79,0.12)', lineHeight: 1.5,
              }}>⚠ {p}</div>
            ))}

            {/* Notes — the selection IS usable, but there's something to know.
                Mutation sites land here rather than blocking, since comparing
                a mutated position across conditions is the normal use case. */}
            {resolved?.notes?.map((n, i) => (
              <div key={`n${i}`} style={{
                marginTop: 8, padding: '7px 9px', borderRadius: 4, fontSize: 11,
                background: 'rgba(247,210,79,0.12)', lineHeight: 1.5,
              }}>ℹ {n}</div>
            ))}

            {/* Shortcut: mutation sites are usually best compared on backbone. */}
            {!!resolved?.mutations?.length && pickMode === 'residue' && (
              <button
                onClick={() => {
                  setPickMode('atom')
                  setSelected(prev => prev.map(r => ({ ...r, atom: 'CA' })))
                }}
                style={{
                  marginTop: 8, fontSize: 11, padding: '5px 10px', borderRadius: 4,
                  cursor: 'pointer', border: '1px solid var(--accent)',
                  background: 'transparent', color: 'var(--text)',
                }}
              >Use Cα only (comparable across conditions)</button>
            )}
          </>
        )}
      </div>

      {/* Selection groups */}
      <div style={panel}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                      marginBottom: selectionGroups.length ? 10 : 0 }}>
          <strong style={{ fontSize:13 }}>Selection groups</strong>
          <div style={{ display:'flex', gap:6 }}>
            <input
              value={groupName}
              onChange={e => setGroupName(e.target.value)}
              placeholder="group name"
              style={{ ...field, width: 150 }}
            />
            <button
              disabled={!selected.length || !resolved?.selection}
              onClick={() => {
                if (!resolved?.selection) return
                addSelectionGroup({
                  id: Math.random().toString(36).slice(2, 9),
                  name: groupName.trim() || `Group ${selectionGroups.length + 1}`,
                  residues: selected,
                  selection: resolved.selection,
                })
                setGroupName('')
              }}
              style={{ fontSize:11, padding:'4px 10px', borderRadius:4,
                       cursor: selected.length ? 'pointer' : 'default',
                       border:'1px solid var(--accent)',
                       background: selected.length ? 'var(--accent)' : 'transparent',
                       color: selected.length ? '#fff' : 'var(--text)',
                       opacity: selected.length ? 1 : 0.4 }}
            >Save selection as group</button>
          </div>
        </div>

        {!selectionGroups.length ? (
          <p style={{ fontSize:12, opacity:0.65, margin:0 }}>
            Save a selection here to reuse it by name in the Analyses tab,
            instead of retyping residue indices for every analysis.
          </p>
        ) : selectionGroups.map(g => (
          <div key={g.id} style={{
            display:'flex', alignItems:'center', gap:10, padding:'7px 9px',
            border:'1px solid var(--border)', borderRadius:4, marginBottom:6,
          }}>
            <strong style={{ fontSize:12, minWidth:110 }}>{g.name}</strong>
            <code style={{ fontSize:11, opacity:0.8, flex:1, wordBreak:'break-all' }}>
              {g.selection}
            </code>
            <span style={{ fontSize:11, opacity:0.6 }}>
              {g.residues.length} residue{g.residues.length === 1 ? '' : 's'}
            </span>
            <button
              onClick={() => { anchorRef.current = g.residues as PickedResidue[]
                               setLevel('residue')
                               setSelected(g.residues as PickedResidue[]) }}
              title="Load this group back into the viewer"
              style={{ fontSize:11, padding:'3px 8px', borderRadius:4, cursor:'pointer',
                       border:'1px solid var(--border)', background:'transparent',
                       color:'var(--text)' }}
            >Load</button>
            <button
              onClick={() => addStructureLayer(newLayer({
                name: g.name,
                sele: seleFromSelection(g.residues as PickedResidue[]),
              }))}
              title="Show this group in 3D as a coloured highlight"
              style={{ fontSize:11, padding:'3px 8px', borderRadius:4, cursor:'pointer',
                       border:'1px solid var(--border)', background:'transparent',
                       color:'var(--text)' }}
            >Highlight</button>
            <button
              onClick={() => removeSelectionGroup(g.id)}
              style={{ display:'flex', background:'transparent', border:'none',
                       cursor:'pointer', color:'var(--text-muted)' }}
            ><Trash2 size={13} /></button>
          </div>
        ))}
      </div>

      {/* Linked plot */}
      {values && values.length > 0 && (
        <div style={panel}>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
            {valueLabel} per residue — hover to highlight on the structure
          </div>
          <Plot
            data={plotData as any}
            layout={{
              autosize: true,
              uirevision: 'keep',
              height: 240,
              margin: { l: 60, r: 20, t: 10, b: 45 },
              ...getPlotBg(),
              xaxis: { ...getAxis(), title: 'Residue' },
              yaxis: { ...getAxis(), title: valueLabel },
              showlegend: false,
              hovermode: 'closest',
            }}
            config={PLOT_CONFIG}
            style={{ width: '100%' }}
            onHover={(e: any) => {
              const pt = e?.points?.[0]
              if (!pt) return
              setHoveredFromPlot([{
                chain: pt.customdata || '',
                resnum: Number(pt.x),
                resname: '',
              }])
            }}
            onUnhover={() => setHoveredFromPlot([])}
            onClick={(e: any) => {
              const pt = e?.points?.[0]
              if (!pt) return
              const pick: PickedResidue = {
                chain: pt.customdata || '', resnum: Number(pt.x), resname: '',
              }
              const key = `${pick.chain}:${pick.resnum}`
              setSelected(prev => prev.some(r => `${r.chain}:${r.resnum}` === key)
                ? prev.filter(r => `${r.chain}:${r.resnum}` !== key)
                : [...prev, pick])
            }}
          />
        </div>
      )}
    </div>
  )
}

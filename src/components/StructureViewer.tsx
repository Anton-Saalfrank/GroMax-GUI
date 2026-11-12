/**
 * StructureViewer — in-app 3D structure view with residue picking.
 *
 * THREE JOBS:
 *   1. Click residues to build a GROMACS selection, so you never have to open
 *      ChimeraX just to find out that the interesting loop is residues 640-655.
 *   2. Colour the structure by a per-residue result (RMSF and friends) so you
 *      can see *where* the signal is, not just where it is on an x-axis.
 *   3. Carry named, coloured highlight layers, so the view can say "catalytic
 *      triad orange, ligand pocket cyan" instead of one grey overlay at a time.
 *
 * DIVISION OF LABOUR: this is for exploring and selecting. Final publication
 * figures go to ChimeraX via the export in ResultsTab — NGL is fast and
 * embedded, ChimeraX renders better.
 *
 * NUMBERING: NGL reports picks in the PDB's author numbering (chain + full
 * length resnum), which is what the system definition describes. The backend
 * converts to GROMACS' flat indices and cross-checks residue names, so a
 * mismatched reference structure is reported rather than silently analysed.
 *
 * SELECTION STRINGS: never built by hand from residue numbers any more. See
 * lib/nglSelection.ts — a selection NGL cannot parse means "select everything",
 * which on a solvated system means 35 000 waters in licorice.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Stage, ColormakerRegistry } from 'ngl'
import type { StructureComponent } from 'ngl'
import { api } from '../api/client'
import { atomAtCanvasPoint } from '../lib/surfacePick'
import { groupSnapshots } from '../lib/snapshotGroups'
import { useStore } from '../store'
import type { StructureFrame, StructureLayer } from '../store'
import {
  applyDisplayFilters, atomsWithin, buildFilterSele, combineSele,
  displayFilterTest, expandWithin,
  indexSele, residueAtomIndices, residueCount, residuesAtomIndices, residuesOf,
  seleError, seleFor, selectionAtomIndices, structureSequence, toContactAtoms,
  wholeResidues,
  DEFAULT_FILTERS, SELECTION_LEVELS,
} from '../lib/nglSelection'
import type {
  ColorScheme, DisplayFilters, InteractionMode, PickedResidue, PickMode, Rep,
  SelectionLevel, SeqChain, SeqResidue,
} from '../lib/nglSelection'
import { atomSetOf, planMorph, frameAt, isMorphError } from '../lib/morph'
import type { MorphPlan } from '../lib/morph'

// Re-exported so the tab keeps importing its viewer vocabulary from one place.
export type {
  ColorScheme, DisplayFilters, InteractionMode, PickedResidue, PickMode, Rep,
  SelectionLevel, SeqChain, SeqResidue,
}
export { DEFAULT_FILTERS, SELECTION_LEVELS, buildFilterSele, seleFor }

/** What a highlight selection resolves to against the loaded structure. */
export interface SeleCheck {
  error: string | null
  atoms: number
  /**
   * The residues it covers, so a highlight can be handed straight to the
   * selection — "view and select at will" needs the two to speak the same
   * language, and this is that language.
   */
  residues: PickedResidue[]
  /** True once a structure is loaded and the answer means something. */
  ready: boolean
}

export interface ResidueValue {
  chain: string
  resnum: number
  value: number
}

interface Props {
  sessionId: string
  conditionId: string
  /** Per-residue values to colour by; null = plain cartoon. */
  values?: ResidueValue[] | null
  valueLabel?: string
  /** Residues to highlight (e.g. the point hovered in a plot). */
  highlight?: PickedResidue[]
  selected: PickedResidue[]
  onSelectionChange: (residues: PickedResidue[]) => void

  /** What to show. Solvent is off by default — see DEFAULT_FILTERS. */
  filters?: DisplayFilters
  /** How to colour the base representation. 'value' uses `values`. */
  colorScheme?: ColorScheme
  /** Base representation. */
  representation?: Rep
  /**
   * Named colour overlays. Purely visual — they never change what will be
   * analysed, which is why they are separate from `selected`.
   */
  layers?: StructureLayer[]
  /**
   * A trajectory frame to show instead of the reference structure.
   * Same residue numbering, so nothing else in here has to care which it is.
   */
  frame?: StructureFrame | null
  /**
   * Every snapshot that has been pulled out, so the viewer can offer to morph
   * into one. The viewer needs the whole record, not just a label, because
   * preparing a morph means fetching the target's coordinates.
   */
  frames?: StructureFrame[]
  /** Condition ids in the project's own order, so the snapshot list here
   *  and the one in the tab above it agree. */
  conditionOrder?: string[]
  /**
   * Called when a morph finishes, to move the "which structure is this" state
   * forward. The viewer has already put the target's coordinates on screen by
   * then, and deliberately does not reload — see loadNonce.
   */
  onActivateFrame?: (id: string | null) => void
  /** Whether a click selects the whole residue or the single atom. */
  pickMode?: PickMode
  onRepresentationChange?: (r: Rep) => void
  onFiltersChange?: (f: DisplayFilters) => void
  /** Called with a widen/narrow request; parent applies it to the selection. */
  onWiden?: (fn: (picks: PickedResidue[], level: SelectionLevel) => PickedResidue[]) => void
  /**
   * Hands the parent a validator bound to the loaded structure, so the
   * highlight editor can say "matches 42 atoms" or "unknown keyword" while you
   * type, instead of silently drawing nothing (or everything).
   */
  onResolve?: (fn: (sele: string) => SeleCheck) => void
  /** Called with the polymer sequence once a structure is loaded. */
  onSequence?: (chains: SeqChain[]) => void
  /** 'select' adds to the analysis selection; 'view' only highlights. */
  interactionMode?: InteractionMode
  onInteractionModeChange?: (m: InteractionMode) => void
  /** Colour used for the analysis selection overlay. */
  selectionColor?: string
  onSelectionColorChange?: (c: string) => void
  /** Radius (Å) for "show what's near" in view mode. 0 disables. */
  neighbourRadius?: number
  onNeighbourRadiusChange?: (r: number) => void
  onColorSchemeChange?: (c: ColorScheme) => void
  onPickModeChange?: (m: PickMode) => void
  /**
   * False while another tab is on screen. The component stays mounted so the
   * camera, the loaded structure and the whole session survive a tab switch,
   * but a hidden canvas must not resize and must not eat key presses.
   */
  active?: boolean
  height?: number
}

/** '#rrggbb' -> the packed integer NGL colormakers return. */
function hexToInt(hex: string): number {
  const v = parseInt(String(hex).replace('#', ''), 16)
  return Number.isFinite(v) ? v : 0x9aa3b2
}

/** Blue -> yellow -> red, matching the plot palette's warm/cool split. */
function valueToColor(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  let r: number, g: number, b: number
  if (clamped < 0.5) {
    const u = clamped * 2
    r = Math.round(79 + u * (247 - 79))
    g = Math.round(142 + u * (210 - 142))
    b = Math.round(247 - u * (247 - 79))
  } else {
    const u = (clamped - 0.5) * 2
    r = 247
    g = Math.round(210 - u * (210 - 79))
    b = Math.round(79 - u * 79)
  }
  return (r << 16) | (g << 8) | b
}

/**
 * Read the app's surface colour from CSS.
 *
 * NGL takes its background as a value at construction time and does not follow
 * CSS, so switching the app to light mode left a black canvas sitting inside a
 * white UI. We re-apply it whenever the theme changes.
 */
function currentBg(): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg-surface').trim()
  return v || '#12151c'
}

/**
 * Resolve a highlight layer to a selection string NGL will read correctly.
 * Returns null when the layer's selection is unusable, so a typo hides the
 * layer instead of drawing the entire solvated system.
 */
export function resolveLayerSele(
  structure: any, layer: StructureLayer, filters: DisplayFilters,
): string | null {
  if (!structure || layer.rep === 'none') return null
  const raw = (layer.sele || '').trim()
  if (!raw) return null

  const expanded = expandWithin(structure, raw)
  if (seleError(expanded)) return null

  const filter = buildFilterSele(filters)
  if (!layer.sideChainsOnly) return combineSele(expanded, filter)

  // Resolved against the structure rather than written as
  // `and (sidechain or .CA or not polymer)`. Both work; going through indices
  // keeps this on exactly the same code path as the view-mode neighbour shell,
  // so "side chains only" cannot come to mean two different things in the two
  // places it is offered.
  const atoms = toContactAtoms(structure, selectionAtomIndices(structure, expanded))
  return combineSele(indexSele(atoms), filter)
}

/**
 * Atoms a layer paints onto the BASE representation.
 *
 * Whole residues, and never reduced to side chains: cartoon colours a residue
 * through its trace atom, so painting only the side chain would leave the
 * ribbon its original colour and the highlight invisible where it matters.
 */
export function layerBaseAtoms(structure: any, layer: StructureLayer): number[] {
  if (!structure) return []
  const raw = (layer.sele || '').trim()
  if (!raw) return []
  const expanded = expandWithin(structure, raw)
  if (seleError(expanded)) return []
  return wholeResidues(structure, selectionAtomIndices(structure, expanded))
}

/**
 * Expand a set of picked residues to the requested breadth.
 * Returns the residues the new level covers.
 */
export function expandSelection(
  comp: any,
  picks: PickedResidue[],
  level: SelectionLevel,
): PickedResidue[] {
  if (!comp?.structure || !picks.length) return picks

  if (level === 'atom' || level === 'residue') {
    // Residue level simply drops the atom restriction.
    const seen = new Set<string>()
    const out: PickedResidue[] = []
    for (const p of picks) {
      const k = `${p.chain}:${p.resnum}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(level === 'atom' ? p : { ...p, atom: undefined })
    }
    return out
  }

  // Walk the polymer ONCE, in order, tagging each residue with its chain and
  // its contiguous secondary-structure run. Doing this per pick instead would
  // be O(residues x picks) and noticeably slow on a 600-residue system.
  type Row = { chain: string; resnum: number; resname: string; run: number }
  const rows: Row[] = []
  let prevChain: string | null = null
  let prevCode: string | null = null
  let run = 0

  comp.structure.eachResidue((r: any) => {
    if (!r.isPolymer?.()) return
    const chain = r.chainname || r.chainid || ''
    const code = r.sstruc || ''
    if (chain !== prevChain || code !== prevCode) {
      run += 1                       // new chain or new SS element starts a run
      prevChain = chain
      prevCode = code
    }
    rows.push({ chain, resnum: r.resno, resname: r.resname || '', run })
  })

  const wanted = new Set(picks.map(p => `${p.chain}:${p.resnum}`))
  const targetChains = new Set<string>()
  const targetRuns = new Set<number>()
  for (const row of rows) {
    if (!wanted.has(`${row.chain}:${row.resnum}`)) continue
    targetChains.add(row.chain)
    targetRuns.add(row.run)
  }

  const out = rows
    .filter(row => level === 'chain'
      ? targetChains.has(row.chain)
      : targetRuns.has(row.run))
    .map(row => ({ chain: row.chain, resnum: row.resnum, resname: row.resname }))

  return out.length ? out : picks
}

export default function StructureViewer({
  sessionId, conditionId, values, valueLabel, highlight,
  selected, onSelectionChange,
  filters, colorScheme = 'chainname', representation,
  layers, frame, frames, conditionOrder, onActivateFrame, pickMode = 'residue', onRepresentationChange,
  onFiltersChange, onColorSchemeChange, onPickModeChange, onWiden, onResolve,
  onSequence,
  interactionMode = 'select', onInteractionModeChange,
  selectionColor = '#f7d24f', onSelectionColorChange,
  neighbourRadius = 5, onNeighbourRadiusChange,
  active = true, height = 460,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  /** Canvas pixel coordinates of the last pointer press, from the top-left. */
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  /** The last surface point clicked, in structure coordinates — the seed a
   *  cavity lookup would start from. */
  const lastSurfaceHitRef = useRef<{ x: number; y: number; z: number } | null>(null)
  const [cavityBusy, setCavityBusy] = useState(false)
  const [cavityNote, setCavityNote] = useState<string | null>(null)
  const [canCavity, setCanCavity] = useState(false)
  const stageRef = useRef<Stage | null>(null)
  const compRef = useRef<StructureComponent | null>(null)
  const selectedRef = useRef<PickedResidue[]>(selected)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [repInternal, setRepInternal] = useState<Rep>('cartoon')
  const rep = representation ?? repInternal
  const setRep = (r: Rep) => {
    setRepInternal(r)
    onRepresentationChange?.(r)
  }
  const [hovered, setHovered] = useState<PickedResidue | null>(null)
  const [diag, setDiag] = useState<{ atoms: number; residues: number } | null>(null)
  const [repFellBack, setRepFellBack] = useState(false)
  const theme = useStore(st => st.theme)

  /**
   * Bumped once a structure has finished loading.
   *
   * The drawing effect below runs before the async load resolves, so without a
   * signal it had nothing to draw and the load had to add a hard-coded cartoon
   * itself — which is why a reloaded structure came back as cartoon/by-chain
   * no matter what the toolbar said. Now the load only bumps this, and one
   * code path draws.
   */
  const [structureVersion, setStructureVersion] = useState(0)

  /**
   * Only the layer properties that change the BASE colouring.
   *
   * The drawing effect rebuilds the whole scene, so depending on `layers`
   * directly would re-tessellate a molecular surface every time an opacity
   * slider moved a pixel. Opacity, representation type and side-chain reduction
   * belong to the overlay, which the layers effect updates in place.
   */
  const baseTintKey = useMemo(
    () => (layers || [])
      .filter(l => l.visible && l.colorBase)
      .map(l => `${l.id}\u0000${l.color}\u0000${l.sele}`)
      .join('\u0001'),
    [layers])

  const [loadingNote, setLoadingNote] = useState<string | null>(null)
  const [frameTime, setFrameTime] = useState<number | null>(null)

  // A primitive key, so passing a fresh object with the same contents does not
  // re-dump the frame.
  const frameKey = frame
    ? `${frame.conditionId}|${frame.replicaIndex}|${frame.timeNs}|${frame.includeSolvent}`
    : ''

  /**
   * The structure identity that is WANTED, versus the one already on screen.
   *
   * These normally track each other and a change reloads. The exception is a
   * completed morph: it ends with the target's coordinates already displayed,
   * fitted onto where the previous structure was. Reloading at that point would
   * fetch the same target and place it at its own position in the periodic box
   * — which is somewhere else entirely — so the molecule would visibly jump the
   * instant the animation finished. Marking the key as already-satisfied is
   * what stops that.
   *
   * A ref rather than derived state on purpose: the morph writes it before
   * telling the parent to change frame, and a ref makes that ordering
   * irrelevant. Compared against the current want on every run, so going back
   * to an earlier snapshot still reloads properly.
   */
  const wantKey = `${sessionId}|${conditionId}|${frameKey}`
  const haveKeyRef = useRef<string | null>(null)
  const [loadNonce, setLoadNonce] = useState(0)
  useEffect(() => {
    if (haveKeyRef.current === null) { haveKeyRef.current = wantKey; return }
    if (haveKeyRef.current === wantKey) return
    haveKeyRef.current = wantKey
    setLoadNonce(n => n + 1)
  }, [wantKey])

  // ── Morph ────────────────────────────────────────────────────────────────
  type MorphPhase = 'idle' | 'preparing' | 'ready' | 'playing'
  const [morphTargetId, setMorphTargetId] = useState<string>('')
  const [morphPhase, setMorphPhase] = useState<MorphPhase>('idle')
  const [morphError, setMorphError] = useState<string | null>(null)
  const [morphSeconds, setMorphSeconds] = useState(2.5)
  const [morphT, setMorphT] = useState(0)
  const [morphInfo, setMorphInfo] =
    useState<{ rmsd: number; maxShift: number; nFit: number; fitOn: string } | null>(null)
  const morphPlanRef = useRef<MorphPlan | null>(null)
  const morphRafRef = useRef<number | null>(null)
  const morphSecondsRef = useRef(morphSeconds)
  useEffect(() => { morphSecondsRef.current = morphSeconds }, [morphSeconds])
  /** The slider and readout are driven imperatively so playback never re-renders. */
  const morphSliderRef = useRef<HTMLInputElement | null>(null)
  const morphReadoutRef = useRef<HTMLSpanElement | null>(null)
  /**
   * PDB text already fetched, keyed by frame.
   *
   * A morph needs the target's coordinates, and so does the reload that would
   * follow it — refetching a frame we are holding in a string is pure latency.
   */
  const pdbCacheRef = useRef<Map<string, string>>(new Map())

  /**
   * Representations owned by the drawing effect, versus those owned by the
   * layers effect. Tracked separately because a full removeAllRepresentations()
   * would wipe the layers whenever the base view changed, and the layers effect
   * has no reason to re-run at that point.
   */
  const baseRepsRef = useRef<any[]>([])
  // Overlay handles, kept apart from baseReps so a click can add or drop an
  // overlay without the base effect — and the surface it may have built —
  // being touched at all.
  const selectionRepRef = useRef<any>(null)
  const hoverRepRef = useRef<any>(null)
  /** The base representation itself, so its COLOUR can be repainted. */
  const mainRepRef = useRef<any>(null)
  /**
   * atom index -> colour, for the current selection.
   *
   * A mutable Map held in a ref rather than a value in the dependency list,
   * because the colormaker below closes over it and must read it LIVE. That
   * is the whole trick: the surface keeps one colormaker and one set of
   * triangles for its entire life, and selecting an atom changes what that
   * colormaker answers rather than building anything new.
   */
  const selectionTintRef = useRef<Map<number, number>>(new Map())
  /** What the base effect resolved for atoms nothing else claims. */
  const fallbackRef = useRef<((atom: any) => number) | null>(null)
  /** The layer tints the base effect last applied. */
  const layerOverridesRef = useRef<Map<number, number>>(new Map())
  const peekRepsRef = useRef<any[]>([])
  const layerRepsRef = useRef<Map<string, { el: any; rep: string }>>(new Map())
  const highlightRepRef = useRef<any>(null)
  /**
   * The camera, carried across a structure swap.
   *
   * Swapping between the reference structure and a 345 ns frame tears the stage
   * down and builds a new one, which would otherwise drop you back to the
   * default view every time. Comparing the two is the entire point of pulling
   * the frame, and you cannot compare two things you are looking at from
   * different angles.
   */
  const orientationRef = useRef<{ key: string; matrix: any } | null>(null)
  /**
   * The value-colouring scheme currently registered with NGL.
   *
   * ColormakerRegistry.addScheme() keeps every scheme it is handed, and the
   * drawing effect re-runs on each click — so colouring by RMSF and then
   * picking thirty residues used to leave thirty dead schemes (each closing
   * over a full per-residue map) in the registry. Retire the old one first.
   */
  const schemeIdRef = useRef<string | null>(null)

  // Picking callbacks are registered once against the NGL stage, so they'd
  // capture a stale `selected` from first render. A ref keeps them current
  // without re-registering (and re-registering would double-fire clicks).
  useEffect(() => { selectedRef.current = selected }, [selected])
  const [peeked, setPeeked] = useState<PickedResidue | null>(null)
  const [peekCount, setPeekCount] = useState(0)
  const modeRef = useRef<InteractionMode>(interactionMode)
  const pickModeRef = useRef<PickMode>(pickMode)
  useEffect(() => { pickModeRef.current = pickMode }, [pickMode])
  useEffect(() => { modeRef.current = interactionMode }, [interactionMode])
  // Same reason as the refs above: the pointer handlers are registered once
  // against the stage, so they need the CURRENT representation, not the one
  // that happened to be showing on first render.
  const repRef = useRef<Rep>(rep)
  useEffect(() => { repRef.current = rep }, [rep])
  const filtersRef = useRef<DisplayFilters>(filters ?? DEFAULT_FILTERS)
  useEffect(() => { filtersRef.current = filters ?? DEFAULT_FILTERS }, [filters])
  /** Rejects an atom the display filters are hiding, for surface picking. */
  const visibleTest = useCallback(() => {
    const st = (compRef.current as any)?.structure
    return st ? displayFilterTest(st, filtersRef.current) : undefined
  }, [])
  /**
   * The atom under the cursor on a surface, so it can be marked.
   *
   * Carries the residue too: in residue pick mode the marker must cover what
   * a click would actually take, which is the whole residue, not the one atom
   * the ray happened to land nearest.
   */
  const [hoverAtom, setHoverAtom] = useState<
    { index: number; residue: PickedResidue } | null>(null)
  useEffect(() => { if (rep !== 'surface') setHoverAtom(null) }, [rep])
  // Leaving view mode drops the transient highlight.
  useEffect(() => { if (interactionMode === 'select') setPeeked(null) }, [interactionMode])

  const residueKey = (r: any) =>
    `${r.chain}:${r.resnum}${r.atom ? ':' + r.atom : ''}`

  /**
   * Select every residue lining the cavity behind the last surface click.
   *
   * THE CLICK IS THE PARAMETER. Seeding a cavity search on a residue is
   * awkward — a side chain's centroid lies inside the side chain, so the void
   * can only start a couple of Angstrom away and whichever pocket is nearest
   * wins. A point picked off the surface is already in the empty space, at the
   * mouth of the pocket being looked at, so there is nothing to guess.
   *
   * Only the atoms AROUND the click are sent. That keeps the request small,
   * and it means the backend measures exactly the coordinates on screen rather
   * than re-deriving which structure or frame is displayed.
   */
  const selectCavityHere = async () => {
    const hit = lastSurfaceHitRef.current
    const comp = compRef.current
    if (!hit || !comp) return
    setCavityBusy(true)
    setCavityNote(null)
    try {
      const structure = comp.structure
      // Far enough that the buriedness rays (10 A) still see protein from
      // anywhere in the 10 A search region.
      const near = structure.spatialHash?.within(hit.x, hit.y, hit.z, 22) || []
      const ap = structure.getAtomProxy()
      const atoms = near.map((i: number) => {
        ap.index = i
        return {
          index: i, x: ap.x, y: ap.y, z: ap.z,
          name: ap.atomname || 'C', resname: ap.resname || '',
          resnum: ap.resno, chain: ap.chainname || ap.chainid || '',
        }
      })
      const r = await api.structure.cavityAt([hit.x, hit.y, hit.z], atoms)
      if (!r.found) {
        setCavityNote(`No cavity here — ${r.reason}.`)
        return
      }
      const picks: PickedResidue[] = r.residues.map(x => ({
        chain: x.chain, resnum: x.resnum, resname: x.resname,
      }))
      const current = selectedRef.current
      const seen = new Set(current.map(residueKey))
      onSelectionChange([...current,
                         ...picks.filter(x => !seen.has(residueKey(x)))])
      setCavityNote(
        `${r.volume_A3} Å³ cavity · ${r.residues.length} lining residues added`
        + ` · largest sphere ${r.max_sphere_A} Å`
        + (r.open_to_bulk ? ' · open to bulk, so this is a groove or channel'
                          : ' · enclosed'))
    } catch (e: any) {
      setCavityNote(e?.message || 'Could not measure the cavity.')
    } finally {
      setCavityBusy(false)
    }
  }

  // ── Build the stage and load the structure ────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false

    // React StrictMode mounts, unmounts, then remounts every component in dev.
    // NGL's stage.dispose() does NOT remove its canvas wrapper from the DOM, so
    // the first (now dead) canvas was left sitting on top of the second, live
    // one — everything loaded correctly but nothing was visible. Clearing the
    // container before creating a stage makes the effect genuinely idempotent.
    while (container.firstChild) container.removeChild(container.firstChild)

    const stage = new Stage(container, {
      backgroundColor: currentBg(),
      quality: 'medium',
    })
    stageRef.current = stage

    // A hidden tab reports 0x0. Resizing to that makes NGL rebuild its render
    // target at zero size, and the canvas comes back blank when the tab is
    // shown again — so only resize when there is something to resize to.
    const resize = () => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        stage.handleResize()
      }
    }
    window.addEventListener('resize', resize)

    // The container can still be 0x0 when the Stage is constructed (lazy-loaded
    // tab, fonts settling, flex layout resolving). NGL only measures once, so
    // without this the canvas stays zero-sized and renders nothing.
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    ;(async () => {
      setLoading(true); setError(null); setDiag(null); setFrameTime(null)
      try {
        let pdbText: string
        let warn: string[] = []

        if (frame) {
          // Dumping a frame runs gmx trjconv over the trajectory, so this is
          // seconds rather than milliseconds — say so instead of showing an
          // indistinguishable "Loading structure…".
          setLoadingNote(`Extracting ${frame.timeNs.toFixed(1)} ns from `
                       + `replica ${frame.replicaIndex}…`)
          const r = await api.structure.frame(
            sessionId, frame.conditionId, frame.replicaIndex, frame.timeNs,
            frame.includeSolvent).catch((e: any) => {
              // A BARE "Not Found" / "Method Not Allowed" here is not about the
              // data — it means the route itself is absent, i.e. the backend
              // process predates this feature. The Python backend runs whatever
              // code it started with (no --reload, deliberately: auto-restart
              // would kill running GROMACS jobs), while Vite hot-reloads the
              // frontend. So the two can drift apart, and the raw message sends
              // you looking for a missing trajectory instead.
              const m = String(e?.message || '').trim()
              if (/^(not found|method not allowed)$/i.test(m)) {
                throw new Error(
                  'This backend does not have the trajectory-snapshot endpoint. '
                  + 'The Python backend keeps running the code it was started '
                  + 'with, so quit and relaunch the app (or restart the backend '
                  + 'process) and try again.')
              }
              throw e
            })
          if (cancelled) return
          pdbText = r.pdb
          warn = r.warnings || []
          setFrameTime(r.actual_ns ?? r.requested_ns)
          pdbCacheRef.current.set(frameKey, pdbText)
        } else {
          const [text, info] = await Promise.all([
            api.structure.pdb(sessionId, conditionId),
            api.structure.info(sessionId, conditionId),
          ])
          if (cancelled) return
          pdbText = text
          warn = info.warnings || []
          pdbCacheRef.current.set('', pdbText)
        }
        setLoadingNote(null)
        setWarnings(warn)

        if (!pdbText || pdbText.trim().length === 0) {
          throw new Error('The structure file is empty.')
        }

        const blob = new Blob([pdbText], { type: 'text/plain' })
        const comp = (await stage.loadFile(blob, { ext: 'pdb' })) as StructureComponent
        if (cancelled) { return }
        compRef.current = comp
        // Dev-only handle on the viewer. A 3D scene is the one part of this
        // app you cannot inspect from the DOM — "did that click rebuild the
        // surface?" is unanswerable without reaching the NGL component — so
        // in development it is reachable from the console and from tests.
        // Stripped from production builds by the constant folding on
        // import.meta.env.DEV.
        if (import.meta.env.DEV) {
          ;(window as any).__gromaxViewer = {
            stage, comp,
            // The refs themselves, so a test can tell "the tint map is empty"
            // apart from "the repaint call did nothing".
            tints: selectionTintRef, mainRep: mainRepRef,
            // Picking on a surface is a ray cast, so "why did that click do
            // nothing?" cannot be answered from the DOM either. Reports what
            // the cast resolves to with and without the visibility filter.
            probe: (px: number, py: number) => {
              const c = compRef.current
              if (!c) return null
              const all = atomAtCanvasPoint(stage, c, px, py, 20)
              const vis = atomAtCanvasPoint(stage, c, px, py, 20, visibleTest())
              const name = (h: any) => {
                if (!h) return null
                const ap = (c as any).structure.getAtomProxy()
                ap.index = h.atomIndex
                return { at: `${ap.resname}${ap.resno}.${ap.atomname}`,
                         d: Math.round(h.distance * 100) / 100,
                         via: h.via, i: h.atomIndex }
              }
              return { anyAtom: name(all), visibleAtom: name(vis),
                       point: all?.point || vis?.point || null }
            },
          }
        }

        // A silent zero-atom parse looks identical to a rendering failure, so
        // check explicitly rather than showing an empty canvas.
        const atomCount = (comp as any)?.structure?.atomCount ?? 0
        const residueCount = (comp as any)?.structure?.residueStore?.count ?? 0
        if (!atomCount) {
          throw new Error(
            'NGL parsed 0 atoms from this file. It may not be a valid PDB, ' +
            'or may contain no ATOM/HETATM records.')
        }
        setDiag({ atoms: atomCount, residues: residueCount })

        // Frame the molecule, not the water box. autoView() over the whole
        // system on a solvated trajectory leaves the protein a speck in the
        // middle of 10 nm of solvent.
        const saved = orientationRef.current
        if (saved && saved.key === `${sessionId}|${conditionId}`) {
          try { stage.viewerControls.orient(saved.matrix) }
          catch { stage.autoView() }
        } else {
          let polymerResidues = 0
          try {
            comp.structure.eachResidue((r: any) => { if (r.isPolymer?.()) polymerResidues++ })
          } catch { polymerResidues = 0 }
          if (polymerResidues > 0) comp.autoView('polymer')
          else stage.autoView()
        }

        // Hand over to the drawing effect, which knows the current toolbar
        // settings. Batched with setLoading, so nothing is ever drawn twice.
        setStructureVersion(v => v + 1)
        setLoading(false)
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || 'Could not load structure')
          setLoadingNote(null)
          setLoading(false)
        }
      }
    })()

    // ── Picking ─────────────────────────────────────────────────────────────
    //
    // Where the pointer is, in canvas pixels from the TOP-LEFT. NGL's own
    // clicked signal does not carry the position, and a molecular surface
    // gives no pickingProxy at all, so the raycast fallback below needs this.
    // Recorded on pointerdown rather than on move: it is the press that
    // decides where a click landed, and a click after a drag should use the
    // press point, not wherever the pointer drifted to.
    const trackPointer = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      pointerRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }
    container.addEventListener('pointerdown', trackPointer)

    stage.signals.clicked.add((pickingProxy: any) => {
      let atom = pickingProxy?.atom || pickingProxy?.closestBondAtom

      // A MOLECULAR SURFACE IS NOT PICKABLE IN NGL.
      //
      // Measured in a real Electron window: spacefill answered 17 of 17
      // probes with an atom, a surface answered 0 of 25 while covering 95% of
      // the canvas. So with surface mode on, every click was silently dropped
      // here and nothing could be selected — which is exactly what it felt
      // like. Falling back to a ray cast against the drawn triangles finds
      // the atom under the surface instead. See lib/surfacePick.ts.
      if (!atom && pointerRef.current && compRef.current) {
        const hit = atomAtCanvasPoint(
          stage, compRef.current, pointerRef.current.x, pointerRef.current.y,
          6, visibleTest())
        if (hit) {
          const ap = compRef.current.structure.getAtomProxy()
          ap.index = hit.atomIndex
          atom = ap
          lastSurfaceHitRef.current = hit.point
        }
      }
      if (!atom) {
        // Deliberately does NOT clear. Rotating the view often ends on empty
        // space, and wiping a carefully built selection by accident is worse
        // than needing one click on the Clear button.
        return
      }
      const pick: PickedResidue = {
        // GROMACS PDBs often have a blank chain column, so chainname is ''.
        // chainid is NGL's own fallback identifier.
        chain: atom.chainname || atom.chainid || '',
        resnum: atom.resno,
        resname: atom.resname || '',
        // In atom mode record which atom was hit, so a selection can target
        // e.g. just OD1/OD2 rather than the whole residue.
        atom: pickModeRef.current === 'atom' ? (atom.atomname || undefined) : undefined,
      }
      // VIEW mode: inspect without touching the analysis selection.
      if (modeRef.current === 'view') {
        setPeeked(pick)
        return
      }

      setCanCavity(!!lastSurfaceHitRef.current)
      const current = selectedRef.current
      const exists = current.some(r => residueKey(r) === residueKey(pick))
      // Toggle, so clicking a selected residue removes it.
      onSelectionChange(exists
        ? current.filter(r => residueKey(r) !== residueKey(pick))
        : [...current, pick])
    })

    stage.signals.hovered.add((pickingProxy: any) => {
      // A surface never answers this — see the click handler above — so in
      // surface mode the pointermove fallback below owns the hover and this
      // would only fight it by clearing what the ray cast just found.
      if (repRef.current === 'surface') return
      const atom = pickingProxy?.atom || pickingProxy?.closestBondAtom
      setHovered(atom
        ? { chain: atom.chainname || atom.chainid || '', resnum: atom.resno,
            resname: atom.resname || '' }
        : null)
    })

    // ── Hover feedback on a molecular surface ───────────────────────────────
    //
    // The click handler gained a ray cast because NGL cannot pick a surface.
    // The HOVER path never did, so in surface mode there was no feedback at
    // all: no label, no marker, nothing under the cursor until you clicked and
    // found out what you had got. Same ray cast, same measured accuracy.
    //
    // Throttled to one cast per animation frame, and suppressed while a button
    // is down — dragging is rotating the view, not aiming at an atom, and
    // casting against a surface mesh on every motion event is the one thing
    // here expensive enough to be felt.
    let hoverRaf = 0
    let hoverPending: { x: number; y: number } | null = null
    const runHover = () => {
      hoverRaf = 0
      const pt = hoverPending
      hoverPending = null
      if (!pt || repRef.current !== 'surface' || !compRef.current) return
      const hit = atomAtCanvasPoint(stage, compRef.current, pt.x, pt.y,
                                    6, visibleTest())
      if (!hit) { setHovered(null); setHoverAtom(null); return }
      const ap = compRef.current.structure.getAtomProxy()
      ap.index = hit.atomIndex
      setHovered({ chain: ap.chainname || ap.chainid || '', resnum: ap.resno,
                   resname: ap.resname || '' })
      setHoverAtom({
        index: hit.atomIndex,
        residue: { chain: ap.chainname || ap.chainid || '', resnum: ap.resno,
                   resname: ap.resname || '' },
      })
    }
    const onHoverMove = (e: PointerEvent) => {
      if (repRef.current !== 'surface') return
      if (e.buttons !== 0) { hoverPending = null; return }
      const r = container.getBoundingClientRect()
      hoverPending = { x: e.clientX - r.left, y: e.clientY - r.top }
      if (!hoverRaf) hoverRaf = requestAnimationFrame(runHover)
    }
    const onHoverLeave = () => {
      hoverPending = null
      setHovered(null)
      setHoverAtom(null)
    }
    container.addEventListener('pointermove', onHoverMove)
    container.addEventListener('pointerleave', onHoverLeave)

    return () => {
      cancelled = true
      window.removeEventListener('resize', resize)
      container.removeEventListener('pointerdown', trackPointer)
      container.removeEventListener('pointermove', onHoverMove)
      container.removeEventListener('pointerleave', onHoverLeave)
      if (hoverRaf) cancelAnimationFrame(hoverRaf)
      ro.disconnect()
      try {
        // Keyed by the system, not the frame: the same protein at two moments
        // shares an orientation, a different condition does not.
        orientationRef.current = {
          key: `${sessionId}|${conditionId}`,
          matrix: stage.viewerControls.getOrientation(),
        }
      } catch { /* nothing worth keeping */ }
      try { stage.dispose() } catch { /* already gone */ }
      // dispose() leaves the canvas wrapper behind; remove it explicitly or the
      // next mount stacks a live canvas underneath a dead one.
      while (container.firstChild) container.removeChild(container.firstChild)
      stageRef.current = null
      compRef.current = null
      // The handles point at representations of a structure that no longer
      // exists; keeping them would make the next diff try to update the dead.
      baseRepsRef.current = []
      // Clearing whatever the ref holds AT TEARDOWN is the intent, not the
      // value captured when the effect ran — this is a long-lived Map of
      // representation handles, not a DOM node, so the usual
      // copy-the-ref-into-a-local advice does not apply.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      layerRepsRef.current.clear()
      highlightRepRef.current = null
      if (schemeIdRef.current) {
        try { ColormakerRegistry.removeScheme(schemeIdRef.current) } catch { /* gone */ }
        schemeIdRef.current = null
      }
    }
    // Driven by loadNonce rather than the identity itself, so a morph can
    // declare an identity already satisfied and skip the reload. See wantKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadNonce])

  // ── Base representation, colouring, selection and peek ────────────────────
  useEffect(() => {
    const comp = compRef.current
    if (!comp) return
    const structure = (comp as any).structure

    // Only our own representations — the layers effect owns the rest.
    for (const el of baseRepsRef.current) {
      try { comp.removeRepresentation(el) } catch { /* already gone */ }
    }
    baseRepsRef.current = []
    const addRep = (type: string, params: any) => {
      const el = comp.addRepresentation(type as any, params)
      baseRepsRef.current.push(el)
      return el
    }

    const f = filters ?? DEFAULT_FILTERS
    const filterSele = buildFilterSele(f)
    const baseSele = seleFor(rep, f)

    // ── Colour ──────────────────────────────────────────────────────────────
    //
    // Two things can want a say in an atom's colour: the base scheme (by chain,
    // by RMSF, …) and any highlight layer set to paint the structure. Rather
    // than stacking a second representation on top of the first — which
    // z-fights, and cannot recolour a continuous cartoon ribbon anyway — both
    // are resolved into ONE colormaker, layers winning where they apply.
    const overrides = new Map<number, number>()
    for (const l of (layers || [])) {
      if (!l.visible || !l.colorBase) continue
      const tint = hexToInt(l.color)
      // Later layers win, matching the top-to-bottom reading of the list.
      for (const a of layerBaseAtoms(structure, l)) overrides.set(a, tint)
    }

    // The per-residue value scale, when that's the base scheme.
    let valueColor: ((atom: any) => number) | null = null
    if (colorScheme === 'value' && values && values.length) {
      const byResidue = new Map<string, number>()
      let lo = Infinity, hi = -Infinity
      for (const v of values) {
        byResidue.set(residueKey(v), v.value)
        if (v.value < lo) lo = v.value
        if (v.value > hi) hi = v.value
      }
      const span = hi - lo || 1
      valueColor = (atom: any) => {
        const val = byResidue.get(`${atom.chainname || ''}:${atom.resno}`)
        if (val === undefined) return 0x3a3f4b          // no data — muted grey
        return valueToColor((val - lo) / span)
      }
    }

    let colorParam: any = { color: colorScheme === 'value' ? 'chainname' : colorScheme }

    // `rep === 'surface'` forces the custom colormaker even when nothing else
    // needs one. Under an opaque surface the ball+stick selection overlay is
    // completely hidden — you cannot see which part of the surface you have
    // taken — so on a surface the selection is shown by painting the surface
    // itself, and that needs a colormaker to paint through.
    if (valueColor || overrides.size || rep === 'surface') {
      // Delegate to the built-in scheme for everything the layers don't claim.
      // Colormakers only need the structure to construct, so this is a legal
      // way to reuse 'sstruc', 'bfactor' and friends inside a custom scheme.
      let fallback: ((atom: any) => number) | null = valueColor
      if (!fallback) {
        // 'value' is ours, not one of NGL's — and getScheme() answers an
        // unknown name with the abstract base Colormaker, whose atomColor is
        // undefined. That would throw per atom at paint time, well past any
        // try/catch around construction, so resolve the name first and check.
        const known = colorScheme === 'value' ? 'chainname' : colorScheme
        try {
          const base: any = ColormakerRegistry.getScheme(
            { scheme: known, structure } as any)
          fallback = typeof base?.atomColor === 'function'
            ? (atom: any) => base.atomColor(atom)
            : () => 0x9aa3b2
        } catch {
          fallback = () => 0x9aa3b2
        }
      }

      if (schemeIdRef.current) {
        try { ColormakerRegistry.removeScheme(schemeIdRef.current) } catch { /* gone */ }
      }
      // NGL colour schemes are constructor functions; `this` is the colormaker
      // instance, so an arrow function would break it.
      const resolve = fallback
      const schemeId = ColormakerRegistry.addScheme(function (this: any) {
        this.atomColor = (atom: any) => {
          // Selection wins over a layer tint: it is the transient thing the
          // user is manipulating right now, and it has to be findable.
          const picked = selectionTintRef.current.get(atom.index)
          if (picked !== undefined) return picked
          const tint = overrides.get(atom.index)
          return tint !== undefined ? tint : resolve(atom)
        }
      })
      schemeIdRef.current = schemeId
      colorParam = { color: schemeId }
      // Kept so the selection effect can register an EQUIVALENT scheme without
      // re-deriving the fallback — see registerScheme below.
      fallbackRef.current = resolve
      layerOverridesRef.current = overrides
    } else {
      fallbackRef.current = null
      layerOverridesRef.current = new Map()
    }

    // ── Base representation ─────────────────────────────────────────────────
    // Explicitly scoped to the filtered selection. This is why solvent
    // disappears, and also why cartoon works: it is handed only polymer.
    mainRepRef.current = addRep(rep, { name: 'main', sele: baseSele, ...colorParam })

    // If a polymer representation was asked for but there is no polymer at all
    // (rare, but e.g. a ligand-only PDB), nothing would be drawn. Detect via
    // the structure, not via buffer counts — NGL builds geometry
    // asynchronously, so counting buffers immediately always reads zero and
    // caused a spurious fallback to ball+stick over the whole system.
    const polymerReps = ['cartoon', 'ribbon', 'tube', 'backbone', 'rope']
    let fellBack = false
    if (polymerReps.includes(rep)) {
      let residues = 0
      try {
        comp.structure.eachResidue((r: any) => { if (r.isPolymer?.()) residues++ })
      } catch { residues = 1 }
      if (residues === 0) {
        for (const el of baseRepsRef.current) {
          try { comp.removeRepresentation(el) } catch { /* already gone */ }
        }
        baseRepsRef.current = []
        addRep('ball+stick', { name: 'main', sele: filterSele, ...colorParam })
        fellBack = true
      }
    }
    setRepFellBack(fellBack)

    const c = containerRef.current
    if (c && c.clientWidth > 0 && c.clientHeight > 0) {
      stageRef.current?.handleResize()
    }
    /*
     * baseTintKey, NOT layers — and deliberately.
     *
     * This effect rebuilds the whole scene. baseTintKey is a projection of
     * `layers` holding exactly the fields that change the BASE colouring
     * (id, color, sele, in order, filtered to visible && colorBase); opacity,
     * representation type and side-chain reduction are excluded because they
     * belong to the overlay, which the layers effect below updates in place.
     * Depending on `layers` here would re-tessellate a molecular surface every
     * time an opacity slider moved a pixel — see the comment on baseTintKey.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureVersion, values, rep, filters, colorScheme, baseTintKey])

  // ── Analysis selection ────────────────────────────────────────────────────
  //
  // Its own effect and its own handle, for the same reason the hover highlight
  // below has one: this is an ADDITIVE overlay that changes nothing about the
  // base geometry or colour, and it used to live in the effect above. Because
  // `selected` was a dependency there, every click tore down and rebuilt every
  // base representation — and when that representation is a molecular surface,
  // re-tessellating it takes long enough to see. That is the structure
  // vanishing and coming back on each click.
  //
  // Addressed by atom index rather than 'resnum:chain'. On a GROMACS PDB with
  // a blank chain column, a bare '123' also matches water 123.
  useEffect(() => {
    const comp = compRef.current
    if (!comp) return
    if (selectionRepRef.current) {
      try { comp.removeRepresentation(selectionRepRef.current) } catch { /* gone */ }
      selectionRepRef.current = null
    }
    if (!selected.length) return

    const atoms = residuesAtomIndices((comp as any).structure, selected)
    if (!atoms.length) return
    selectionRepRef.current = comp.addRepresentation('ball+stick', {
      name: 'selection', sele: indexSele(atoms), color: selectionColor,
      aspectRatio: 2.5, multipleBond: 'symmetric',
    })
  }, [structureVersion, selected, selectionColor])

  // ── View-mode peek: the clicked residue and its neighbourhood, drawn
  //    without entering the analysis selection. ─────────────────────────────
  //
  // Also split out of the base effect — peeking is a click, and a click should
  // not rebuild the scene.
  //
  // The neighbour shell used to be written as `within N of (...)`. NGL has no
  // `within` keyword — the string failed to parse, and an unparseable
  // selection in NGL means "every atom", so one click in view mode drew the
  // entire solvated system. The distance query is done here instead, against
  // the same spatial hash NGL uses internally.
  useEffect(() => {
    const comp = compRef.current
    if (!comp) return
    for (const el of peekRepsRef.current) {
      try { comp.removeRepresentation(el) } catch { /* already gone */ }
    }
    peekRepsRef.current = []

    if (!peeked) { setPeekCount(0); return }

    const structure = (comp as any).structure
    const f = filters ?? DEFAULT_FILTERS
    const addPeek = (type: string, params: any) => {
      peekRepsRef.current.push(comp.addRepresentation(type as any, params))
    }

    const centre = applyDisplayFilters(
      structure,
      residueAtomIndices(structure, { ...peeked, atom: undefined }),
      f)
    if (centre.length) {
      addPeek('licorice', {
        name: 'peek', sele: indexSele(centre),
        color: '#4fd0d0', multipleBond: 'symmetric',
      })
    }

    let nNear = 0
    if (neighbourRadius > 0 && centre.length) {
      // NGL's spatial hash works in Angstrom, which is also what people quote
      // for contact distances — so the UI label says Å and no conversion is
      // needed.
      //
      // The display filters are applied here, numerically, rather than tacked
      // on as a selection string: the badge below reports this count, and a
      // count that includes waters you have chosen not to see is a lie.
      const shell = applyDisplayFilters(
        structure,
        toContactAtoms(structure,
          atomsWithin(structure, centre, neighbourRadius, { excludeSelf: true })),
        f)
      nNear = residueCount(structure, shell)
      if (shell.length) {
        addPeek('licorice', {
          name: 'peek-near', sele: indexSele(shell),
          color: '#9aa3b2', opacity: 0.55, multipleBond: 'symmetric',
        })
      }
    }
    setPeekCount(nNear)
  }, [structureVersion, peeked, neighbourRadius, filters])

  // ── Painting the selection onto the surface ───────────────────────────────
  //
  // THE PROBLEM THIS SOLVES
  // The selection overlay is a ball+stick drawn at the selected atoms. Under
  // an opaque molecular surface it is *inside* the mesh and completely
  // invisible, so on a surface there was no way to see which part you had
  // already taken — or, more to the point, which part you had not.
  //
  // WHY IT DOES NOT REBUILD ANYTHING
  // The obvious implementation — put `selected` back into the base effect and
  // let the colormaker be rebuilt with it — is exactly the dependency that
  // used to re-tessellate the surface on every click. Instead the colormaker
  // reads `selectionTintRef` live, so changing the selection means mutating a
  // Map and asking NGL to refresh ONLY the colour attribute. Geometry,
  // normals and the surface itself are untouched: `update({ color: true })`
  // walks the existing vertex buffer and nothing else.
  useEffect(() => {
    const comp = compRef.current
    const main = mainRepRef.current
    const tints = selectionTintRef.current
    const had = tints.size > 0

    tints.clear()
    if (comp && rep === 'surface' && selected.length) {
      const colour = hexToInt(selectionColor)
      for (const i of residuesAtomIndices((comp as any).structure, selected)) {
        tints.set(i, colour)
      }
    }
    // Nothing to repaint if the selection was empty before and after.
    if (!main || (!had && tints.size === 0)) return
    if (!fallbackRef.current) return

    // WHY A NEW SCHEME ID RATHER THAN A REPAINT OF THE OLD ONE
    //
    // Two things were tried first and measured not to work, in a real window
    // against the real surface (271840 vertices):
    //
    //   update({ color: true })   — the documented colour-only refresh. The
    //                               colour buffer came back byte-identical.
    //   setColor(sameSchemeId)    — NGL diffs representation parameters, sees
    //                               the same id, and does nothing.
    //
    // A built-in scheme name DID move the buffer (switching to 'element'
    // changed its checksum), which is what showed the problem was the
    // unchanged id rather than the surface being unpaintable. So each change
    // registers a FRESH colormaker — identical logic, new identity — and NGL
    // repaints because the parameter genuinely changed.
    const resolve = fallbackRef.current
    const layerTints = layerOverridesRef.current
    const previous = schemeIdRef.current
    const id = ColormakerRegistry.addScheme(function (this: any) {
      this.atomColor = (atom: any) => {
        const picked = tints.get(atom.index)
        if (picked !== undefined) return picked
        const tint = layerTints.get(atom.index)
        return tint !== undefined ? tint : resolve(atom)
      }
    })
    schemeIdRef.current = id
    try { main.setColor(id) } catch { /* rep already gone */ }
    // Only after the new one is in use: the registry keeps every scheme it is
    // handed, and this effect runs on every click.
    if (previous) {
      try { ColormakerRegistry.removeScheme(previous) } catch { /* gone */ }
    }
  }, [structureVersion, rep, selected, selectionColor])

  // ── Hover marker on a surface ─────────────────────────────────────────────
  //
  // Small, bright and drawn on top, so the thing a click is about to take is
  // visible before the click. Its own handle for the usual reason: it changes
  // on every pointer move, and must never touch the surface underneath it.
  useEffect(() => {
    const comp = compRef.current
    if (!comp) return
    if (hoverRepRef.current) {
      try { comp.removeRepresentation(hoverRepRef.current) } catch { /* gone */ }
      hoverRepRef.current = null
    }
    if (!hoverAtom) return

    // Mark exactly what a click would take: one atom in atom mode, the whole
    // residue otherwise. A marker that disagrees with the selection is worse
    // than no marker, because it teaches the wrong thing about where to aim.
    const atoms = pickMode === 'atom'
      ? [hoverAtom.index]
      : residueAtomIndices((comp as any).structure, hoverAtom.residue)
    if (!atoms.length) return
    hoverRepRef.current = comp.addRepresentation('spacefill', {
      name: 'hover-marker', sele: indexSele(atoms),
      color: '#ffd166', opacity: 0.85, radiusScale: 0.45,
    })
  }, [structureVersion, hoverAtom, pickMode])

  // ── Transient highlight (hovering a plot point, or the sequence) ──────────
  // Its own effect, and its own representation handle. Hovering along a
  // sequence fires this once per residue; rebuilding the entire scene — base
  // cartoon included — at that rate made the sequence view unusable on a large
  // structure.
  useEffect(() => {
    const comp = compRef.current
    if (!comp) return
    const structure = (comp as any).structure

    if (highlightRepRef.current) {
      try { comp.removeRepresentation(highlightRepRef.current) } catch { /* gone */ }
      highlightRepRef.current = null
    }
    if (!highlight?.length) return

    const atoms = residuesAtomIndices(structure, highlight)
    if (!atoms.length) return
    highlightRepRef.current = comp.addRepresentation('spacefill', {
      name: 'highlight', sele: indexSele(atoms), color: '#ffffff',
      opacity: 0.45, radiusScale: 0.6,
    })
  }, [structureVersion, highlight])

  // ── Highlight layers ──────────────────────────────────────────────────────
  // Diffed rather than rebuilt: dragging an opacity slider or nudging a colour
  // should not re-tessellate a molecular surface on every frame.
  useEffect(() => {
    const comp = compRef.current
    if (!comp) return
    const structure = (comp as any).structure
    const f = filters ?? DEFAULT_FILTERS
    const handles = layerRepsRef.current

    const wanted = new Map(
      (layers || []).filter(l => l.visible).map(l => [l.id, l] as const))

    // Gone, hidden, or switched to a different representation type — NGL cannot
    // change a rep's type in place, so those are recreated.
    for (const [id, handle] of Array.from(handles.entries())) {
      const l = wanted.get(id)
      if (!l || l.rep !== handle.rep) {
        try { comp.removeRepresentation(handle.el) } catch { /* already gone */ }
        handles.delete(id)
      }
    }

    for (const [id, l] of wanted) {
      const sele = resolveLayerSele(structure, l, f)
      const handle = handles.get(id)
      if (!sele) {
        // An unusable selection hides the layer rather than falling back to
        // NGL's "select everything".
        if (handle) {
          try { comp.removeRepresentation(handle.el) } catch { /* gone */ }
          handles.delete(id)
        }
        continue
      }
      if (handle) {
        try {
          handle.el.setSelection(sele)
          handle.el.setColor(l.color)
          handle.el.setParameters({ opacity: l.opacity })
        } catch { /* representation disposed under us — rebuilt next pass */ }
      } else {
        const el = comp.addRepresentation(l.rep as any, {
          name: `layer-${id}`,
          sele,
          color: l.color,
          opacity: l.opacity,
          multipleBond: 'symmetric',
          // Translucent surfaces read as noise without both faces drawn.
          side: l.rep === 'surface' ? 'double' : undefined,
        })
        handles.set(id, { el, rep: l.rep })
      }
    }
  }, [structureVersion, layers, filters])

  // Follow the app theme. Reading the CSS variable after the attribute change
  // has landed keeps the canvas in step with light/dark mode.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const id = requestAnimationFrame(() => {
      try { stage.setParameters({ backgroundColor: currentBg() }) } catch { /* noop */ }
    })
    return () => cancelAnimationFrame(id)
  }, [theme])

  // Coming back from another tab: the container had no size while hidden, so
  // NGL has to re-measure before it will draw.
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => {
      const c = containerRef.current
      if (c && c.clientWidth > 0 && c.clientHeight > 0) {
        try { stageRef.current?.handleResize() } catch { /* noop */ }
      }
    })
    return () => cancelAnimationFrame(id)
  }, [active])

  // Esc drops the view-mode peek. Clicking empty space deliberately does not:
  // a rotation that ends off the molecule would otherwise clear it constantly.
  useEffect(() => {
    if (!active || !peeked) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPeeked(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, peeked])

  // Hand the parent a validator bound to THIS loaded structure. `within N of`
  // is resolved here too, so the editor reports on what will actually be drawn.
  useEffect(() => {
    if (!onResolve) return
    onResolve((sele: string): SeleCheck => {
      const empty = { error: null, atoms: 0, residues: [] as PickedResidue[] }
      const structure = (compRef.current as any)?.structure
      if (!structure) return { ...empty, ready: false }
      const trimmed = (sele || '').trim()
      if (!trimmed) return { ...empty, ready: true }
      let expanded: string
      try {
        expanded = expandWithin(structure, trimmed)
      } catch (e: any) {
        return { ...empty, error: e?.message || 'Invalid selection', ready: true }
      }
      const err = seleError(expanded)
      if (err) return { ...empty, error: err, ready: true }
      const atoms = selectionAtomIndices(structure, expanded)
      return {
        error: null,
        atoms: atoms.length,
        residues: residuesOf(structure, atoms),
        ready: true,
      }
    })
  }, [onResolve, diag])

  // Publish the sequence once the structure is in, so the sequence view is
  // reading the same residues the 3D picks report.
  useEffect(() => {
    if (!onSequence) return
    const structure = (compRef.current as any)?.structure
    onSequence(structure ? structureSequence(structure) : [])
  }, [onSequence, structureVersion])

  // Hand the parent an expander bound to THIS loaded structure, so widening
  // can use real secondary-structure and chain assignments.
  useEffect(() => {
    if (!onWiden) return
    onWiden((picks: PickedResidue[], level: SelectionLevel) =>
      expandSelection(compRef.current, picks, level))
  }, [onWiden, diag])

  const focusSelection = useCallback(() => {
    const comp = compRef.current
    if (!comp || !selected.length) return
    const atoms = residuesAtomIndices((comp as any).structure, selected)
    if (atoms.length) comp.autoView(indexSele(atoms), 500)
  }, [selected])

  // ── Morph engine ──────────────────────────────────────────────────────────

  /** Every snapshot except the one on screen, plus the reference structure. */
  // Grouped by condition, then replica, then time — the same order as the
  // snapshot list above it. A hundred moments in one flat <select>, in the
  // order they happened to be collected, is a list you scroll rather than
  // read.
  const morphGroups = useMemo(
    () => groupSnapshots((frames || []).filter(f => !(frame && f.id === frame.id)),
                         conditionOrder || []),
    [frames, frame, conditionOrder])
  const morphCount = useMemo(
    () => morphGroups.reduce((n, g) => n + g.total, 0) + (frame ? 1 : 0),
    [morphGroups, frame])

  const cancelMorphRaf = () => {
    if (morphRafRef.current !== null) {
      cancelAnimationFrame(morphRafRef.current)
      morphRafRef.current = null
    }
  }

  /** Push the frame at `t` into NGL without going through React. */
  const showMorphAt = useCallback((t: number) => {
    const plan = morphPlanRef.current
    const comp = compRef.current
    if (!plan || !comp) return
    const coords = frameAt(plan, t)
    // refresh=false: updatePosition() otherwise rebuilds the bounding box and
    // the spatial hash on every tick, which is wasted work sixty times a second
    // when nothing queries them mid-animation. The final frame refreshes.
    ;(comp as any).structure.updatePosition(coords, false)
    comp.updateRepresentations({ position: true })
    if (morphSliderRef.current) morphSliderRef.current.value = String(t)
    if (morphReadoutRef.current) {
      morphReadoutRef.current.textContent = `${Math.round(t * 100)}%`
    }
  }, [])

  /** Settle at `t`, refreshing the derived geometry NGL caches. */
  const settleMorphAt = useCallback((t: number) => {
    const plan = morphPlanRef.current
    const comp = compRef.current
    if (!plan || !comp) return
    ;(comp as any).structure.updatePosition(frameAt(plan, t), true)
    comp.updateRepresentations({ position: true })
    // The slider is uncontrolled, so it has to be told too.
    if (morphSliderRef.current) morphSliderRef.current.value = String(t)
    if (morphReadoutRef.current) {
      morphReadoutRef.current.textContent = `${Math.round(t * 100)}%`
    }
    setMorphT(t)
  }, [])

  /**
   * Fetch a target and work out how to get there from here.
   *
   * Loading the target as a second (representation-less, therefore invisible)
   * component rather than parsing the PDB by hand is deliberate: both
   * structures then go through exactly the same parser, so "atom 412" means the
   * same thing on both sides. Parsing one of them differently is precisely how
   * a morph ends up animating the wrong correspondence while looking fine.
   */
  const prepareMorph = useCallback(async (targetId: string) => {
    const stage = stageRef.current
    const comp = compRef.current
    if (!stage || !comp) return
    cancelMorphRaf()
    morphPlanRef.current = null
    setMorphError(null); setMorphInfo(null); setMorphT(0)
    setMorphPhase('preparing')

    let tmp: any = null
    try {
      const target = targetId === 'reference'
        ? null
        : (frames || []).find(f => f.id === targetId)
      if (targetId !== 'reference' && !target) {
        throw new Error('That snapshot is no longer in the list.')
      }

      const key = target
        ? `${target.conditionId}|${target.replicaIndex}|${target.timeNs}|${target.includeSolvent}`
        : ''
      let text = pdbCacheRef.current.get(key)
      if (text === undefined) {
        if (target) {
          const r = await api.structure.frame(
            sessionId, target.conditionId, target.replicaIndex, target.timeNs,
            target.includeSolvent)
          text = r.pdb
        } else {
          text = await api.structure.pdb(sessionId, conditionId)
        }
        pdbCacheRef.current.set(key, text)
      }

      const blob = new Blob([text], { type: 'text/plain' })
      tmp = await stage.loadFile(blob, { ext: 'pdb' })
      if (!tmp?.structure?.atomCount) {
        throw new Error('The target snapshot parsed to zero atoms.')
      }

      const plan = planMorph(
        atomSetOf((comp as any).structure), atomSetOf(tmp.structure))
      if (isMorphError(plan)) throw new Error(plan.error)

      morphPlanRef.current = plan
      setMorphInfo({ rmsd: plan.rmsd, maxShift: plan.maxShift,
                     nFit: plan.nFitAtoms, fitOn: plan.fitDescription })
      setMorphPhase('ready')
    } catch (e: any) {
      const m = String(e?.message || 'Could not prepare the morph.')
      setMorphError(/^(not found|method not allowed)$/i.test(m.trim())
        ? 'This backend does not have the trajectory-snapshot endpoint. Quit and '
          + 'relaunch the app so the Python backend picks up the current code.'
        : m)
      setMorphPhase('idle')
    } finally {
      // The target was only ever a coordinate source; leaving it on the stage
      // would keep a second structure's worth of memory alive per morph.
      if (tmp) { try { stage.removeComponent(tmp) } catch { /* already gone */ } }
    }
  }, [sessionId, conditionId, frames])

  const playMorph = useCallback((from: number) => {
    const plan = morphPlanRef.current
    if (!plan) return
    cancelMorphRaf()
    setMorphPhase('playing')
    const start = performance.now()
    const t0 = from >= 1 ? 0 : from
    const span = Math.max(0.2, morphSecondsRef.current) * 1000 * (1 - t0)
    const step = (now: number) => {
      const t = Math.min(1, t0 + (now - start) / span)
      showMorphAt(t)
      if (t < 1) {
        morphRafRef.current = requestAnimationFrame(step)
        return
      }
      morphRafRef.current = null
      settleMorphAt(1)
      /*
       * The target's coordinates are now what is on screen, so the viewer IS
       * showing that snapshot — mark the identity satisfied BEFORE telling the
       * parent, or the frame-change would reload and undo the fit.
       */
      const target = (frames || []).find(f => f.id === morphTargetId)
      if (morphTargetId === 'reference') {
        haveKeyRef.current = `${sessionId}|${conditionId}|`
        setFrameTime(null)
        onActivateFrame?.(null)
      } else if (target) {
        haveKeyRef.current = `${sessionId}|${conditionId}|`
          + `${target.conditionId}|${target.replicaIndex}|${target.timeNs}|`
          + `${target.includeSolvent}`
        setFrameTime(target.timeNs)
        onActivateFrame?.(target.id)
      }
      /*
       * And the morph is then over, not merely finished playing.
       *
       * Keeping the plan would leave a scrub bar that runs back to the SOURCE
       * structure while the banner now says the target — the viewer would be
       * showing one snapshot and labelling it as another. Morphing back is a
       * click away and costs nothing, since both structures are cached.
       */
      morphPlanRef.current = null
      setMorphPhase('idle'); setMorphInfo(null)
      setMorphT(0); setMorphTargetId('')
    }
    morphRafRef.current = requestAnimationFrame(step)
  }, [showMorphAt, settleMorphAt, frames, morphTargetId, sessionId, conditionId,
      onActivateFrame])

  const stopMorph = useCallback(() => {
    cancelMorphRaf()
    setMorphPhase(morphPlanRef.current ? 'ready' : 'idle')
  }, [])

  /** Drop the morph and put the structure back where it started. */
  const clearMorph = useCallback(() => {
    cancelMorphRaf()
    if (morphPlanRef.current) settleMorphAt(0)
    morphPlanRef.current = null
    setMorphPhase('idle'); setMorphInfo(null); setMorphError(null)
    setMorphT(0); setMorphTargetId('')
  }, [settleMorphAt])

  // A plan holds coordinates for a structure that is about to stop existing, so
  // any reload has to invalidate it — otherwise the next morph would interpolate
  // towards the previous structure's atoms.
  useEffect(() => {
    cancelMorphRaf()
    morphPlanRef.current = null
    setMorphPhase('idle'); setMorphInfo(null); setMorphError(null)
    setMorphT(0); setMorphTargetId('')
  }, [loadNonce])

  useEffect(() => () => cancelMorphRaf(), [])

  const panel: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
  }

  return (
    <div style={panel}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '8px 10px', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 12, opacity: 0.7 }}>View</span>
        {(['cartoon', 'ribbon', 'tube', 'backbone', 'licorice',
           'ball+stick', 'spacefill', 'surface'] as Rep[]).map(r => (
          <button
            key={r}
            onClick={() => setRep(r)}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
              border: '1px solid var(--border)',
              background: rep === r ? 'var(--accent)' : 'transparent',
              color: rep === r ? '#fff' : 'var(--text)',
            }}
          >{r}</button>
        ))}

        <div style={{ flex: 1 }} />

        {values && values.length > 0 && (
          <span style={{ fontSize: 11, opacity: 0.75 }}>
            coloured by {valueLabel || 'value'}
          </span>
        )}
        <button
          onClick={() => stageRef.current?.autoView(500)}
          style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4,
                   cursor: 'pointer', border: '1px solid var(--border)',
                   background: 'transparent', color: 'var(--text)' }}
        >Reset view</button>
        <button
          onClick={focusSelection}
          disabled={!selected.length}
          style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4,
                   cursor: selected.length ? 'pointer' : 'default',
                   border: '1px solid var(--border)', background: 'transparent',
                   color: 'var(--text)', opacity: selected.length ? 1 : 0.4 }}
        >Zoom to selection</button>
      </div>

      {/* Display filters — solvent off by default, since 35k waters bury a
          600-residue protein and that was the first thing users hit. */}
      {onFiltersChange && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '7px 10px', borderBottom: '1px solid var(--border)',
          fontSize: 11,
        }}>
          <span style={{ opacity: 0.7 }}>Show</span>
          {([
            ['solvent', 'water'],
            ['ions', 'ions'],
            ['hetero', 'ligands'],
            ['hydrogens', 'hydrogens'],
          ] as [keyof DisplayFilters, string][]).map(([key, label]) => {
            const f = filters ?? DEFAULT_FILTERS
            return (
              <label key={key} style={{
                display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
              }}>
                <input
                  type="checkbox"
                  checked={f[key]}
                  onChange={e => onFiltersChange({ ...f, [key]: e.target.checked })}
                />
                {label}
              </label>
            )
          })}

          <div style={{ width: 1, height: 16, background: 'var(--border)' }} />

          <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            Colour
            <select
              value={colorScheme}
              onChange={e => onColorSchemeChange?.(e.target.value as ColorScheme)}
              style={{ fontSize: 11, padding: '2px 4px' }}
            >
              <option value="chainname">by chain</option>
              <option value="sstruc">by secondary structure</option>
              <option value="resindex">by residue index</option>
              <option value="element">by element</option>
              <option value="bfactor">by B-factor</option>
              <option value="value" disabled={!values?.length}>
                by analysis value{values?.length ? '' : ' (none loaded)'}
              </option>
            </select>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            Mode
            <select
              value={interactionMode}
              onChange={e => onInteractionModeChange?.(e.target.value as InteractionMode)}
              style={{ fontSize: 11, padding: '2px 4px' }}
            >
              <option value="select">select (adds to analysis)</option>
              <option value="view">view (highlight only)</option>
            </select>
          </label>

          {interactionMode === 'view' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              Show within
              <input
                type="number" min={0} max={15} step={0.5}
                value={neighbourRadius}
                onChange={e => onNeighbourRadiusChange?.(parseFloat(e.target.value) || 0)}
                style={{ width: 54, fontSize: 11, padding: '2px 4px',
                         border: '1px solid var(--border)', borderRadius: 3,
                         background: 'var(--bg)', color: 'var(--text)' }}
              />
              Å
            </label>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            Selection colour
            <input
              type="color"
              value={selectionColor}
              onChange={e => onSelectionColorChange?.(e.target.value)}
              style={{ width: 28, height: 20, padding: 0, cursor: 'pointer',
                       border: '1px solid var(--border)', borderRadius: 3,
                       background: 'transparent' }}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            Click selects
            <select
              value={pickMode}
              onChange={e => onPickModeChange?.(e.target.value as PickMode)}
              style={{ fontSize: 11, padding: '2px 4px' }}
            >
              <option value="residue">whole residue</option>
              <option value="atom">single atom</option>
            </select>
          </label>
        </div>
      )}

      {/* Warnings from the backend about structure/definition mismatch */}
      {warnings.map((w, i) => (
        <div key={i} style={{
          padding: '6px 10px', fontSize: 11, lineHeight: 1.45,
          background: 'rgba(247,127,79,0.12)',
          borderBottom: '1px solid var(--border)', color: 'var(--text)',
        }}>⚠ {w}</div>
      ))}

      {/* ── Morph ────────────────────────────────────────────────────────────
          Two stills tell you that something changed; the transition tells you
          WHAT changed, because the eye tracks motion far better than it diffs
          pictures. Only offered when there is a second structure to morph to. */}
      {morphCount > 0 && !loading && !error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '7px 10px', borderBottom: '1px solid var(--border)',
          fontSize: 11,
        }}>
          <span style={{ opacity: 0.7 }}>Morph to</span>
          <select
            value={morphTargetId}
            onChange={e => {
              const id = e.target.value
              setMorphTargetId(id)
              if (id) prepareMorph(id)
              else clearMorph()
            }}
            style={{ fontSize: 11, padding: '3px 6px', maxWidth: 260,
                     background: 'var(--bg)', color: 'var(--text)',
                     border: '1px solid var(--border)', borderRadius: 4 }}
          >
            <option value="">— pick a snapshot —</option>
            {frame && <option value="reference">Reference structure</option>}
            {morphGroups.map(g => (
              <optgroup key={g.conditionId} label={g.conditionName}>
                {g.replicas.flatMap(r => r.frames.map(f => (
                  <option key={f.id} value={f.id}>
                    rep {r.replicaIndex} · {f.timeNs.toFixed(2)} ns
                  </option>
                )))}
              </optgroup>
            ))}
          </select>

          {morphPhase === 'preparing' && (
            <span style={{ opacity: 0.7 }}>preparing…</span>
          )}

          {(morphPhase === 'ready' || morphPhase === 'playing') && (
            <>
              <button
                onClick={() => morphPhase === 'playing' ? stopMorph() : playMorph(morphT)}
                style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4,
                         cursor: 'pointer', border: '1px solid var(--border)',
                         background: morphPhase === 'playing'
                           ? 'var(--bg-elevated)' : 'var(--accent)',
                         color: morphPhase === 'playing' ? 'var(--text)' : '#fff' }}
              >{morphPhase === 'playing' ? 'Pause' : (morphT >= 1 ? 'Replay' : 'Play')}</button>

              {/* Uncontrolled on purpose: playback drives this element directly
                  so sixty frames a second never re-render the viewer. */}
              <input
                ref={morphSliderRef}
                type="range" min={0} max={1} step={0.005}
                defaultValue={morphT}
                onChange={e => {
                  if (morphPhase === 'playing') stopMorph()
                  showMorphAt(Number(e.target.value))
                }}
                onPointerUp={e => settleMorphAt(Number((e.target as HTMLInputElement).value))}
                style={{ width: 150, accentColor: 'var(--accent)' }}
              />
              <span ref={morphReadoutRef} style={{
                fontFamily: 'var(--font-mono)', opacity: 0.7, minWidth: 34,
              }}>{Math.round(morphT * 100)}%</span>

              <label style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: 0.8 }}>
                speed
                <input
                  type="range" min={0.5} max={8} step={0.5}
                  value={morphSeconds}
                  onChange={e => setMorphSeconds(Number(e.target.value))}
                  style={{ width: 70, accentColor: 'var(--accent)' }}
                />
                <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.7 }}>
                  {morphSeconds.toFixed(1)}s
                </span>
              </label>

              {morphInfo && (
                <span style={{ opacity: 0.65 }}>
                  {morphInfo.rmsd.toFixed(2)} Å RMSD · largest shift{' '}
                  {morphInfo.maxShift.toFixed(1)} Å · fitted on {morphInfo.nFit}{' '}
                  {morphInfo.fitOn}
                </span>
              )}
              <button
                onClick={clearMorph}
                style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4,
                         cursor: 'pointer', border: '1px solid var(--border)',
                         background: 'transparent', color: 'var(--text)' }}
              >Cancel</button>
            </>
          )}
        </div>
      )}

      {morphError && (
        <div style={{
          padding: '6px 10px', fontSize: 11, lineHeight: 1.45,
          background: 'rgba(247,127,79,0.12)',
          borderBottom: '1px solid var(--border)', color: 'var(--text)',
        }}>⚠ {morphError}</div>
      )}

      {/* Canvas */}
      <div style={{ position: 'relative', height }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

        {loading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: 12, opacity: 0.7,
          }}>{loadingNote || 'Loading structure…'}</div>
        )}

        {error && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', padding: 28,
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            textAlign: 'center', gap: 10,
          }}>
            <div style={{ fontSize: 13, color: 'var(--danger, #f74f4f)', maxWidth: 480, lineHeight: 1.5 }}>
              {error}
            </div>
            {/* A bare error tells you something broke; this tells you what to do. */}
            {/no reference structure|missing on disk/i.test(error) && (
              <div style={{
                fontSize: 12, opacity: 0.75, maxWidth: 460, lineHeight: 1.6,
                textAlign: 'left', padding: '10px 12px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--bg)',
              }}>
                <strong style={{ fontSize: 12 }}>To add a structure:</strong>
                <ol style={{ margin: '6px 0 0 16px', padding: 0 }}>
                  <li>Open the <strong>System</strong> tab.</li>
                  <li>Paste the path to your input PDB and import it.</li>
                </ol>
                <div style={{ marginTop: 6, opacity: 0.85 }}>
                  That same import defines your chains and residue numbering, so
                  picking maps to the right residues. Alternatively, pick a PDB
                  when scanning the folder in the <strong>Setup</strong> tab.
                </div>
              </div>
            )}
          </div>
        )}

        {diag && !loading && !error && (
          <div style={{
            position: 'absolute', right: 10, top: 10, fontSize: 10,
            padding: '3px 7px', borderRadius: 4, pointerEvents: 'none',
            background: 'var(--bg)', border: '1px solid var(--border)',
            // Explicit colour: these overlay the NGL canvas, which is not a
            // themed element, so an inherited colour turned invisible in
            // light mode.
            color: 'var(--text)', opacity: 0.85,
          }}>
            {diag.atoms.toLocaleString()} atoms · {diag.residues.toLocaleString()} residues
            {repFellBack ? ' · no backbone → ball+stick' : ''}
            {frame && frameTime !== null
              ? ` · rep ${frame.replicaIndex} @ ${frameTime.toFixed(2)} ns` : ''}
          </div>
        )}

        {/* View-mode peek readout. Also the only way to dismiss the peek, since
            clicking empty space is reserved for "I was just rotating". */}
        {peeked && !loading && (
          <div style={{
            position: 'absolute', left: 10, top: 10, fontSize: 11,
            padding: '4px 6px 4px 9px', borderRadius: 4,
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--bg)', border: '1px solid #4fd0d0',
            color: 'var(--text)',
          }}>
            <span>
              {peeked.resname} {peeked.resnum}
              {peeked.chain ? ` · chain ${peeked.chain}` : ''}
              {neighbourRadius > 0
                ? ` · ${peekCount} residue${peekCount === 1 ? '' : 's'} within ${neighbourRadius} Å`
                : ''}
            </span>
            <button
              onClick={() => setPeeked(null)}
              title="Clear (Esc)"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                       color: 'var(--text)', opacity: 0.6, padding: '0 2px',
                       fontSize: 13, lineHeight: 1 }}
            >×</button>
          </div>
        )}

        {/* Cavity from the last surface click. Only offered once a surface
            click has actually landed, so it never sits there inert. */}
        {canCavity && !loading && (
          <div style={{
            position: 'absolute', right: 10, top: 10, fontSize: 11,
            display: 'flex', alignItems: 'flex-end', gap: 6,
            flexDirection: 'column', maxWidth: 320,
          }}>
            <button
              onClick={selectCavityHere}
              disabled={cavityBusy}
              title={'Find the cavity behind the point you last clicked on the '
                   + 'surface and add every residue lining it to the selection'}
              style={{ fontSize: 11, padding: '4px 9px', borderRadius: 4,
                       cursor: cavityBusy ? 'default' : 'pointer',
                       border: '1px solid var(--border-light)',
                       background: 'var(--bg)', color: 'var(--text)' }}
            >{cavityBusy ? 'Measuring…' : 'Select cavity here'}</button>
            {cavityNote && (
              <div style={{
                padding: '5px 8px', borderRadius: 4, lineHeight: 1.45,
                background: 'var(--bg)', border: '1px solid var(--border)',
                color: 'var(--text)', textAlign: 'right',
              }}>{cavityNote}</div>
            )}
          </div>
        )}

        {hovered && !loading && (
          <div style={{
            position: 'absolute', left: 10, bottom: 10, fontSize: 11,
            padding: '3px 7px', borderRadius: 4, pointerEvents: 'none',
            background: 'var(--bg)', border: '1px solid var(--border)',
            color: 'var(--text)',
          }}>
            {hovered.resname} {hovered.resnum}
            {hovered.chain ? ` · chain ${hovered.chain}` : ''}
          </div>
        )}
      </div>

      {/* Colour legend */}
      {values && values.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px', borderTop: '1px solid var(--border)', fontSize: 11,
        }}>
          <span style={{ opacity: 0.7 }}>
            {Math.min(...values.map(v => v.value)).toFixed(2)}
          </span>
          <div style={{
            flex: 1, height: 8, borderRadius: 4,
            background: 'linear-gradient(to right, rgb(79,142,247), rgb(247,210,79), rgb(247,79,79))',
          }} />
          <span style={{ opacity: 0.7 }}>
            {Math.max(...values.map(v => v.value)).toFixed(2)}
          </span>
          <span style={{ opacity: 0.6, marginLeft: 4 }}>{valueLabel}</span>
        </div>
      )}

      <div style={{
        padding: '6px 10px', borderTop: '1px solid var(--border)',
        fontSize: 11, opacity: 0.65,
      }}>
        {interactionMode === 'view'
          ? 'View mode: clicking shows a residue and its surroundings without '
            + 'changing what gets analysed · Esc clears'
          : 'Click to select · click again to deselect · selection is kept when '
            + 'you switch tabs, and cleared with the Clear button'}
        {pickMode === 'atom' ? ' · atom mode: picks the exact atom clicked' : ''}
      </div>
    </div>
  )
}

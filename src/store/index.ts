import { create } from 'zustand'
import type { SessionState, SessionSummary, ArchivedSummary, Job, BackendInfo,
  DiskUsageReport } from '../types'
// Type-only — erased at build time, so this does NOT drag NGL out of the lazy
// Structure-tab chunk and into the main bundle.
import type {
  DisplayFilters, Rep, ColorScheme, PickMode, InteractionMode, SelectionLevel,
} from '../lib/nglSelection'
import type { FilterDef, SeriesStyle } from '../lib/plotSeries'
import type { AxisLock } from '../lib/axisLock'
import { DEFAULT_AXIS_LOCK, normaliseAxisLock } from '../lib/axisLock'
import { api, RequestSlot, isSuperseded } from '../api/client'

type View = 'home' | 'project'

/**
 * One slot per interval-driven or user-retriggerable fetch.
 *
 * Module-level rather than store state on purpose: these hold AbortControllers,
 * which are plumbing, not data. In the store, replacing one would be a state
 * change and every cancellation would cost a re-render of anything subscribed.
 */
const sessionSlot = new RequestSlot()
const jobsSlot = new RequestSlot()
const usageSlot = new RequestSlot()

export interface SelectionGroup {
  id: string
  name: string
  /** Residues in the group, in biological identity terms. */
  residues: { chain: string; resnum: number; resname?: string; atom?: string }[]
  /** Resolved make_ndx expression, e.g. 'ri 206 370 & a CA'. */
  selection: string
}

/**
 * A named, coloured overlay drawn on top of the base representation.
 *
 * This is the "personalised overview" layer: the catalytic triad in orange
 * licorice, the membrane-facing helix in translucent surface, the ligand in
 * spacefill — all at once, each kept and toggled independently, rather than
 * one throwaway side-chain selection at a time.
 *
 * Layers are display only. They never affect what gets analysed, which is why
 * they are separate from `structureSelection` and `selectionGroups`.
 */
export interface StructureLayer {
  id: string
  name: string
  /** NGL selection string. Supports `within N of (...)`, which we resolve. */
  sele: string
  /** NGL representation type, or 'none' to colour the base without adding one. */
  rep: string
  color: string
  opacity: number
  visible: boolean
  /** Reduce polymer to side chain + Cα — the usual intent for licorice. */
  sideChainsOnly: boolean
  /**
   * Paint this region onto the base representation too, so a highlighted loop
   * is a coloured stretch of cartoon and not just floating licorice. On by
   * default: colouring the structure is what people reach for first, and the
   * overlay alone left the ribbon underneath looking untouched.
   */
  colorBase: boolean
}

/** Distinguishable at a glance, and readable on both light and dark canvas. */
export const LAYER_COLOURS = [
  '#f79f4f', '#4fd0d0', '#c78bf7', '#7ee081',
  '#f76f9e', '#f7d24f', '#6fa8ff', '#9aa3b2',
]

/**
 * A moment in a trajectory, opened in the structure viewer.
 *
 * Set by clicking a point on a per-replica trace or a PCA cloud: "the mindist
 * jumps at 345 ns in repeat 5" becomes a structure you can actually look at,
 * with every highlight you have already built still applying to it.
 *
 * These accumulate rather than replacing one another. Pulling a second moment
 * used to discard the first, which made the obvious question — what is
 * different between them? — the one thing you could not ask.
 */
export interface StructureFrame {
  /** Stable across re-renders and reorderings; the key everything else uses. */
  id: string
  conditionId: string
  conditionName: string
  replicaIndex: number
  timeNs: number
  /** What the trace was showing, purely so the banner can say it. */
  label: string
  includeSolvent: boolean
}

/**
 * What identifies a moment, independent of how it is being displayed.
 *
 * Solvent is deliberately not part of it: showing the same frame with and
 * without water is one snapshot with a setting changed, not two snapshots.
 */
export function frameIdentity(f: {
  conditionId: string; replicaIndex: number; timeNs: number
}) {
  return `${f.conditionId}|${f.replicaIndex}|${f.timeNs}`
}

/** Everything the Structure tab needs to look the same when you come back. */
export interface StructureViewState {
  conditionId: string
  /** cache_key of the stored result the structure is coloured by, if any. */
  colourKey: string
  rep: Rep
  colorScheme: ColorScheme
  pickMode: PickMode
  interactionMode: InteractionMode
  level: SelectionLevel
  filters: DisplayFilters
  selectionColor: string
  neighbourRadius: number
}

export const DEFAULT_STRUCTURE_VIEW: StructureViewState = {
  conditionId: '',
  colourKey: '',
  rep: 'cartoon',
  colorScheme: 'chainname',
  pickMode: 'residue',
  interactionMode: 'select',
  level: 'residue',
  filters: { solvent: false, ions: false, hetero: true, hydrogens: false },
  selectionColor: '#f7d24f',
  neighbourRadius: 5,
}

interface AppStore {
  // Backend
  backendOnline: boolean
  backendInfo: BackendInfo | null
  setBackendOnline: (v: boolean) => void
  setBackendInfo: (info: BackendInfo) => void
  checkBackend: () => Promise<void>

  // Navigation
  view: View
  setView: (v: View) => void

  // Cross-tab handoff: the Structure tab drops a resolved selection here and
  // switches to Analyses, which picks it up. Avoids the user copy-pasting an
  // 'ri N' string between tabs (and getting the index wrong).
  pendingSelection: string | null
  setPendingSelection: (sel: string | null) => void

  // Residues picked in the Structure tab. Lives in the store, not in the tab,
  // because ProjectScreen unmounts the tab on every switch — so a selection
  // built up over several clicks was wiped the moment you looked at anything
  // else. Cleared only by the explicit Clear button.
  structureSelection: any[]
  setStructureSelection: (r: any[]) => void

  /**
   * Named selection groups, built in the Structure tab and referenced by name
   * in the Analyses tab. This is the "probe group 1, defined by residues
   * 5, 7, 23" workflow: build a set once, reuse it everywhere, instead of
   * retyping residue indices per analysis.
   */
  selectionGroups: SelectionGroup[]
  addSelectionGroup: (g: SelectionGroup) => void
  updateSelectionGroup: (id: string, patch: Partial<SelectionGroup>) => void
  removeSelectionGroup: (id: string) => void

  /**
   * Coloured overlays for the 3D view. In the store rather than the tab so a
   * built-up view — three highlighted regions, each in its own colour — is
   * still there after a detour through Analyses.
   */
  structureLayers: StructureLayer[]
  addStructureLayer: (l: StructureLayer) => void
  updateStructureLayer: (id: string, patch: Partial<StructureLayer>) => void
  removeStructureLayer: (id: string) => void

  /**
   * Viewer display settings — representation, colouring, filters, interaction
   * mode. Kept here for the same reason as the selection: switching to another
   * tab unmounts the Structure tab, and rebuilding the view every time was a
   * chore.
   */
  structureView: StructureViewState
  setStructureView: (patch: Partial<StructureViewState>) => void

  /**
   * Snapshots pulled out of trajectories, kept so they can be compared.
   *
   * `structureFrame` is the one on screen and is derived from these two — it
   * stays in the store rather than being computed by each consumer so that
   * "which structure am I looking at" has exactly one answer.
   */
  structureFrames: StructureFrame[]
  activeFrameId: string | null
  /** null = show the reference structure. */
  structureFrame: StructureFrame | null
  /** Add (or re-activate) a snapshot and show it. Returns its id. */
  addStructureFrame: (f: Omit<StructureFrame, 'id'>) => string
  setActiveFrame: (id: string | null) => void
  removeStructureFrame: (id: string) => void
  updateStructureFrame: (id: string, patch: Partial<StructureFrame>) => void
  /** Add-and-show, or (with null) go back to the reference. */
  setStructureFrame: (f: Omit<StructureFrame, 'id'> | null) => void

  /**
   * Saved plot filters. PROJECT state, deliberately: a filter names a metric
   * key like `ncontacts_06_cutoff_205-267_377-387`, which means nothing in
   * another project. Figure STYLE goes the other way — a journal's
   * requirements follow you between systems, so presets stay with the app.
   */
  plotFilters: FilterDef[]
  addPlotFilter: (f: FilterDef) => void
  updatePlotFilter: (id: string, patch: Partial<FilterDef>) => void
  removePlotFilter: (id: string) => void

  /**
   * Per-series style overrides, keyed by `filterId|conditionId`.
   *
   * Also project state, and for the same reason: both halves of the key are
   * project-scoped, so these would be meaningless in a preset. The global
   * PlotStyle they override is not here — it stays with the app.
   */
  plotSeriesStyles: Record<string, SeriesStyle>
  setSeriesStyle: (seriesId: string, patch: SeriesStyle) => void
  clearSeriesStyleField: (field: keyof SeriesStyle) => void
  resetSeriesStyle: (seriesId: string) => void

  /**
   * Starred analyses, by metric key, lifted to the top of every metric menu.
   *
   * Project state for the same reason as the filters above: a key like
   * `mindist · Y269 to loop` names a run that exists in this project only.
   * Starring by analysis TYPE would travel between projects but is not what
   * anyone wants — the thing you return to twenty times a day is one specific
   * named run, not every mindist you will ever compute.
   */
  favouriteMetrics: string[]
  toggleFavouriteMetric: (key: string) => void

  /**
   * Line colour per replica, keyed by `repeatColourKey(conditionId, repIndex)`.
   *
   * Project state: a condition id means nothing elsewhere. Separate from
   * `plotSeriesStyles` on purpose — that is keyed by filter x condition and a
   * replica is neither, so folding replicas in would make "clear this field on
   * every series" either skip them or wipe them, and both are wrong.
   */
  repeatColours: Record<string, string>
  /** '' clears the override and returns the replica to its colour-by mode. */
  setRepeatColour: (key: string, colour: string) => void
  clearRepeatColours: () => void

  /**
   * Per-analysis axis locking for Repeat detail, keyed by metric key.
   *
   * Absent means `DEFAULT_AXIS_LOCK`, so this stays empty until someone
   * deviates from it rather than filling up with a row per analysis the moment
   * the tab is opened.
   */
  repeatAxisLocks: Record<string, AxisLock>
  setRepeatAxisLock: (key: string, patch: Partial<AxisLock>) => void
  /** The shared time axis. One setting, because all panels share the x axis. */
  repeatXLock: AxisLock
  setRepeatXLock: (patch: Partial<AxisLock>) => void

  /** Write the per-project UI state back, debounced. */
  saveWorkspace: () => void
  /** Write it back now — used when the window is closing. */
  flushWorkspace: () => Promise<void> | void

  /** Analyses-tab form state, kept so switching tabs doesn't discard it. */
  analysisDraft: Record<string, any>
  setAnalysisDraft: (d: Record<string, any>) => void
  requestedTab: string | null
  setRequestedTab: (t: string | null) => void

  // Sessions
  sessions: SessionSummary[]
  activeSession: SessionState | null
  loadSessions: () => Promise<void>
  openSession: (id: string) => Promise<void>
  closeSession: () => void
  createSession: (name: string) => Promise<SessionState>
  refreshSession: () => Promise<void>
  /** Archived projects — loaded on demand, not with the project list. */
  archivedSessions: ArchivedSummary[]
  loadArchived: () => Promise<void>

  /** Disk use per project. null until measured — the walk is not instant. */
  usage: DiskUsageReport | null
  usageLoading: boolean
  usageError: string | null
  loadUsage: () => Promise<void>
  reclaimSpace: (id: string) => Promise<number>
  archiveSession: (id: string) => Promise<void>
  restoreSession: (id: string) => Promise<void>
  deleteArchived: (id: string) => Promise<void>

  // Jobs
  jobs: Job[]
  jobsPanelOpen: boolean
  setJobsPanelOpen: (v: boolean) => void
  theme: 'dark' | 'light'
  setTheme: (t: 'dark' | 'light') => void
  pollJobs: () => Promise<void>
}

/** How long after the last change the workspace is written back. */
const WORKSPACE_SAVE_DELAY = 800

let workspaceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Structure state is per project: condition ids, picked residues and highlight
 * selections from one session are meaningless (and, for condition ids, a load
 * error) in the next. So it is cleared on every session change...
 */
function freshStructureState() {
  return {
    structureSelection: [] as any[],
    structureLayers: [] as StructureLayer[],
    structureView: DEFAULT_STRUCTURE_VIEW,
    structureFrames: [] as StructureFrame[],
    activeFrameId: null as string | null,
    structureFrame: null as StructureFrame | null,
    selectionGroups: [] as SelectionGroup[],
    analysisDraft: {} as Record<string, any>,
    plotFilters: [] as FilterDef[],
    plotSeriesStyles: {} as Record<string, SeriesStyle>,
    favouriteMetrics: [] as string[],
    repeatColours: {} as Record<string, string>,
    repeatAxisLocks: {} as Record<string, AxisLock>,
    repeatXLock: DEFAULT_AXIS_LOCK as AxisLock,
  }
}

/**
 * ...and restored from the project itself when one is opened.
 *
 * This state is worth real effort to rebuild — residues picked one at a time in
 * 3D, highlight layers coloured by hand, groups named and saved — and all of it
 * lived in memory, so closing the app threw it away. It is stored with the
 * PROJECT rather than with the browser or the machine, because a selection
 * expressed in residue indices only means anything against this system.
 *
 * Every field is defended separately: a workspace written by an older or newer
 * build must not be able to take the project down with it.
 */
function restoreStructureState(session: SessionState) {
  const w: any = (session as any)?.workspace
  if (!w || typeof w !== 'object') return freshStructureState()
  const arr = (v: any) => (Array.isArray(v) ? v : [])
  return {
    structureSelection: arr(w.structureSelection),
    structureLayers: arr(w.structureLayers) as StructureLayer[],
    structureView: { ...DEFAULT_STRUCTURE_VIEW, ...(w.structureView || {}) },
    /*
     * The snapshot LIST comes back, but nothing is active.
     *
     * Which moments you pulled out is real work — you found them by reading
     * plots — and it was being thrown away on close. Restoring the list costs
     * nothing, because a snapshot is just a coordinate; the expensive part is
     * the trjconv that dumps it, and that only runs when one is clicked. So
     * reopening a project still shows the reference structure immediately
     * rather than silently re-dumping whatever you were looking at last week.
     */
    structureFrames: arr(w.structureFrames)
      .filter((f: any) => f && typeof f.conditionId === 'string'
                       && typeof f.timeNs === 'number')
      .map((f: any) => ({
        ...f, id: f.id || Math.random().toString(36).slice(2, 9),
      })) as StructureFrame[],
    activeFrameId: null as string | null,
    structureFrame: null as StructureFrame | null,
    selectionGroups: arr(w.selectionGroups) as SelectionGroup[],
    analysisDraft: (w.analysisDraft && typeof w.analysisDraft === 'object')
      ? w.analysisDraft : {},
    /*
     * A workspace written before filters existed has no `filters` key, and a
     * filter written by a newer build may carry fields this one does not know.
     * Both must load. Only the fields a filter cannot work without are
     * required — a filter with no metric would be a menu entry that silently
     * plots nothing.
     */
    plotFilters: arr(w.plotFilters).filter(
      (f: any) => f && typeof f.id === 'string' && typeof f.metric === 'string'
               && Number.isFinite(Number(f.threshold)),
    ).map((f: any) => ({ ...f, threshold: Number(f.threshold) })) as FilterDef[],
    plotSeriesStyles: (w.plotSeriesStyles && typeof w.plotSeriesStyles === 'object'
                       && !Array.isArray(w.plotSeriesStyles))
      ? w.plotSeriesStyles as Record<string, SeriesStyle> : {},
    /*
     * Stars for analyses that may no longer exist are kept, not pruned.
     *
     * A deleted-and-recomputed result comes back under the same metric key, and
     * silently unstarring it in between would make the star feel unreliable in
     * exactly the situation where someone is iterating on one analysis. An
     * orphaned key is invisible anyway: the menus only ever show keys that are
     * in `byKey` right now.
     */
    favouriteMetrics: arr(w.favouriteMetrics).filter((k: any) => typeof k === 'string'),
    repeatColours: Object.fromEntries(
      Object.entries((w.repeatColours && typeof w.repeatColours === 'object'
                      && !Array.isArray(w.repeatColours)) ? w.repeatColours : {})
            .filter(([, v]) => typeof v === 'string' && v !== '')) as Record<string, string>,
    repeatAxisLocks: Object.fromEntries(
      Object.entries((w.repeatAxisLocks && typeof w.repeatAxisLocks === 'object'
                      && !Array.isArray(w.repeatAxisLocks)) ? w.repeatAxisLocks : {})
            .map(([k, v]) => [k, normaliseAxisLock(v)])) as Record<string, AxisLock>,
    repeatXLock: normaliseAxisLock(w.repeatXLock),
  }
}

export const useStore = create<AppStore>((set, get) => ({
  // ─── Backend ───────────────────────────────────────────────────────────────

  backendOnline: false,
  backendInfo: null,

  setBackendOnline: (v) => set({ backendOnline: v }),
  setBackendInfo:   (info) => set({ backendInfo: info }),

  checkBackend: async () => {
    try {
      await api.health()
      const info = await api.info()
      set({ backendOnline: true, backendInfo: info })
    } catch {
      set({ backendOnline: false, backendInfo: null })
    }
  },

  // ─── Navigation ────────────────────────────────────────────────────────────

  view: 'home',
  setView: (v) => set({ view: v }),

  pendingSelection: null,
  setPendingSelection: (sel) => set({ pendingSelection: sel }),

  structureSelection: [],
  setStructureSelection: (r) => { set({ structureSelection: r }); get().saveWorkspace() },

  selectionGroups: [],
  addSelectionGroup: (g) => { set(st => ({ selectionGroups: [...st.selectionGroups, g] })); get().saveWorkspace() },
  updateSelectionGroup: (id, patch) => { set(st => ({
    selectionGroups: st.selectionGroups.map(g => g.id === id ? { ...g, ...patch } : g),
  })); get().saveWorkspace() },
  removeSelectionGroup: (id) => { set(st => ({
    selectionGroups: st.selectionGroups.filter(g => g.id !== id),
  })); get().saveWorkspace() },

  plotFilters: [],
  addPlotFilter: (f) => { set(st => ({ plotFilters: [...st.plotFilters, f] })); get().saveWorkspace() },
  updatePlotFilter: (id, patch) => { set(st => ({
    plotFilters: st.plotFilters.map(f => f.id === id ? { ...f, ...patch } : f),
  })); get().saveWorkspace() },
  /*
   * Deleting a filter also drops the per-series styles that pointed at it.
   * Leaving them behind would be invisible state that quietly reattaches if a
   * new filter ever reused the id, and would grow without bound otherwise.
   */
  removePlotFilter: (id) => { set(st => ({
    plotFilters: st.plotFilters.filter(f => f.id !== id),
    plotSeriesStyles: Object.fromEntries(
      Object.entries(st.plotSeriesStyles).filter(([k]) => k.split('|')[0] !== id)),
  })); get().saveWorkspace() },

  plotSeriesStyles: {},
  setSeriesStyle: (seriesId, patch) => { set(st => ({
    plotSeriesStyles: { ...st.plotSeriesStyles,
                        [seriesId]: { ...(st.plotSeriesStyles[seriesId] || {}), ...patch } },
  })); get().saveWorkspace() },
  /*
   * What "All series" does: writing a global value has to REMOVE the
   * per-series overrides of that one field, or "make everything circles"
   * silently leaves the overridden series behind.
   */
  clearSeriesStyleField: (field) => { set(st => ({
    plotSeriesStyles: Object.fromEntries(Object.entries(st.plotSeriesStyles)
      .map(([k, v]) => { const n = { ...v }; delete n[field]; return [k, n] })
      .filter(([, v]) => Object.keys(v as object).length > 0)),
  })); get().saveWorkspace() },
  resetSeriesStyle: (seriesId) => { set(st => ({
    plotSeriesStyles: Object.fromEntries(
      Object.entries(st.plotSeriesStyles).filter(([k]) => k !== seriesId)),
  })); get().saveWorkspace() },

  favouriteMetrics: [],
  toggleFavouriteMetric: (key) => { set(st => ({
    favouriteMetrics: st.favouriteMetrics.includes(key)
      ? st.favouriteMetrics.filter(k => k !== key)
      : [...st.favouriteMetrics, key],
  })); get().saveWorkspace() },

  repeatColours: {},
  /*
   * Clearing REMOVES the key rather than storing ''. Dead keys would otherwise
   * accumulate in the workspace for every colour ever tried and undone.
   */
  setRepeatColour: (key, colour) => { set(st => {
    const next = { ...st.repeatColours }
    if (colour) next[key] = colour; else delete next[key]
    return { repeatColours: next }
  }); get().saveWorkspace() },
  clearRepeatColours: () => { set({ repeatColours: {} }); get().saveWorkspace() },

  repeatAxisLocks: {},
  /*
   * Merged into whatever is there, so switching to 'auto' and back does not
   * lose the bounds that were typed in 'manual'. Returning to a mode and
   * finding the numbers gone is how a settings panel teaches people not to
   * explore it.
   */
  setRepeatAxisLock: (key, patch) => { set(st => ({
    repeatAxisLocks: { ...st.repeatAxisLocks,
      [key]: { ...DEFAULT_AXIS_LOCK, ...(st.repeatAxisLocks[key] || {}), ...patch } },
  })); get().saveWorkspace() },

  repeatXLock: DEFAULT_AXIS_LOCK,
  setRepeatXLock: (patch) => { set(st => ({
    repeatXLock: { ...st.repeatXLock, ...patch },
  })); get().saveWorkspace() },

  structureLayers: [],
  addStructureLayer: (l) => { set(st => ({
    structureLayers: [...st.structureLayers, l],
  })); get().saveWorkspace() },
  updateStructureLayer: (id, patch) => { set(st => ({
    structureLayers: st.structureLayers.map(l =>
      l.id === id ? { ...l, ...patch } : l),
  })); get().saveWorkspace() },
  removeStructureLayer: (id) => { set(st => ({
    structureLayers: st.structureLayers.filter(l => l.id !== id),
  })); get().saveWorkspace() },

  structureView: DEFAULT_STRUCTURE_VIEW,
  setStructureView: (patch) => { set(st => ({
    structureView: { ...st.structureView, ...patch },
  })); get().saveWorkspace() },

  /**
   * Debounced because the things that change the workspace are continuous:
   * sweeping a range across the sequence viewer fires once per residue, and a
   * request per residue would be absurd. Under a second after you stop is
   * indistinguishable from instant.
   */
  saveWorkspace: () => {
    if (!get().activeSession) return
    if (workspaceTimer !== null) clearTimeout(workspaceTimer)
    workspaceTimer = setTimeout(() => {
      workspaceTimer = null
      const st = get()
      if (!st.activeSession) return
      api.session.saveWorkspace(st.activeSession.id, {
        structureSelection: st.structureSelection,
        structureLayers: st.structureLayers,
        structureView: st.structureView,
        structureFrames: st.structureFrames,
        selectionGroups: st.selectionGroups,
        analysisDraft: st.analysisDraft,
        plotFilters: st.plotFilters,
        plotSeriesStyles: st.plotSeriesStyles,
        favouriteMetrics: st.favouriteMetrics,
        repeatColours: st.repeatColours,
        repeatAxisLocks: st.repeatAxisLocks,
        repeatXLock: st.repeatXLock,
      }).catch(() => { /* a lost layout is not worth interrupting anyone for */ })
    }, WORKSPACE_SAVE_DELAY)
  },

  flushWorkspace: () => {
    const st = get()
    if (workspaceTimer !== null) { clearTimeout(workspaceTimer); workspaceTimer = null }
    if (!st.activeSession) return
    return api.session.saveWorkspace(st.activeSession.id, {
      structureSelection: st.structureSelection,
      structureLayers: st.structureLayers,
      structureView: st.structureView,
      structureFrames: st.structureFrames,
      selectionGroups: st.selectionGroups,
      analysisDraft: st.analysisDraft,
      plotFilters: st.plotFilters,
      plotSeriesStyles: st.plotSeriesStyles,
      favouriteMetrics: st.favouriteMetrics,
      repeatColours: st.repeatColours,
      repeatAxisLocks: st.repeatAxisLocks,
      repeatXLock: st.repeatXLock,
    }).then(() => {}).catch(() => {})
  },

  structureFrames: [],
  activeFrameId: null,
  structureFrame: null,

  addStructureFrame: (f) => {
    const st = get()
    // Clicking the same moment twice is a request to look at it again, not to
    // collect a duplicate chip.
    const existing = st.structureFrames.find(
      x => frameIdentity(x) === frameIdentity(f))
    const id = existing ? existing.id : Math.random().toString(36).slice(2, 9)
    const frame: StructureFrame = existing ? { ...existing } : { ...f, id }
    set({
      structureFrames: existing
        ? st.structureFrames
        : [...st.structureFrames, frame],
      activeFrameId: id,
      structureFrame: frame,
      // A frame belongs to one condition; showing it while the tab is pointed
      // at a different one would silently mislabel what is on screen.
      structureView: { ...st.structureView, conditionId: frame.conditionId },
    })
    get().saveWorkspace()
    return id
  },

  setActiveFrame: (id) => {
    const st = get()
    const frame = id ? st.structureFrames.find(f => f.id === id) || null : null
    // An id that no longer exists means the reference, not a blank viewer.
    set({
      activeFrameId: frame ? frame.id : null,
      structureFrame: frame,
      structureView: frame
        ? { ...st.structureView, conditionId: frame.conditionId }
        : st.structureView,
    })
    get().saveWorkspace()
  },

  removeStructureFrame: (id) => {
    const st = get()
    const frames = st.structureFrames.filter(f => f.id !== id)
    const wasActive = st.activeFrameId === id
    set({
      structureFrames: frames,
      activeFrameId: wasActive ? null : st.activeFrameId,
      structureFrame: wasActive ? null : st.structureFrame,
    })
    get().saveWorkspace()
  },

  updateStructureFrame: (id, patch) => {
    const st = get()
    const frames = st.structureFrames.map(
      f => f.id === id ? { ...f, ...patch, id: f.id } : f)
    set({
      structureFrames: frames,
      structureFrame: st.activeFrameId === id
        ? frames.find(f => f.id === id) || null
        : st.structureFrame,
    })
    get().saveWorkspace()
  },

  setStructureFrame: (f) => {
    if (!f) { get().setActiveFrame(null); return }
    get().addStructureFrame(f)
  },

  analysisDraft: {},
  setAnalysisDraft: (d) => { set({ analysisDraft: d }); get().saveWorkspace() },
  requestedTab: null,
  setRequestedTab: (t) => set({ requestedTab: t }),

  // ─── Sessions ──────────────────────────────────────────────────────────────

  sessions: [],
  activeSession: null,

  loadSessions: async () => {
    try {
      const sessions = await api.session.list()
      set({ sessions })
    } catch (e) {
      console.error('Failed to load sessions', e)
    }
  },

  openSession: async (id) => {
    // Opening a second project while the first is still loading used to let
    // whichever answered LAST win, so a slow project could paint its state
    // over the one the user actually asked for. The slot aborts the first
    // request; the `current` check covers a reply that was already in the
    // queue when the abort landed.
    const signal = sessionSlot.begin()
    try {
      const session = await api.session.get(id, { signal })
      if (!sessionSlot.current(signal)) return
      set({ activeSession: session, view: 'project',
            ...restoreStructureState(session) })
    } catch (e) {
      if (isSuperseded(e)) return
      throw e
    }
  },

  closeSession: () => {
    // Flush before clearing: the debounce may still be pending, and the state
    // it would have written is about to be wiped.
    get().flushWorkspace()
    // Without this, a session load still in flight would resolve after the
    // project was closed and set `activeSession` again — reopening, from the
    // user's point of view, a project they had just left.
    sessionSlot.cancel()
    jobsSlot.cancel()
    set({ activeSession: null, view: 'home', ...freshStructureState() })
  },

  createSession: async (name) => {
    const session = await api.session.create(name)
    await get().loadSessions()
    set({ activeSession: session, view: 'project', ...freshStructureState() })
    return session
  },

  refreshSession: async () => {
    const active = get().activeSession
    if (!active) return
    const session = await api.session.get(active.id)
    // Re-read rather than trusting `active`: the user may have closed the
    // project or opened another one while this was in flight, and writing the
    // old project back would either resurrect a closed one or replace the new
    // one's state with a stranger's.
    const still = get().activeSession
    if (!still || still.id !== active.id) return
    set({ activeSession: session })
  },

  // ─── Archive ───────────────────────────────────────────────────────────────
  //
  // Every one of these refreshes BOTH lists. A project moves between them, so
  // updating one leaves the other showing the same project in two places —
  // which, for something whose whole purpose is to reassure the user that
  // nothing was lost, is the worst possible display.

  archivedSessions: [],

  loadArchived: async () => {
    try {
      set({ archivedSessions: await api.session.listArchived() })
    } catch (e) {
      console.error('Failed to load archived projects', e)
    }
  },

  archiveSession: async (id) => {
    await api.session.archive(id)
    // Close it if it is the project currently open, or the UI would keep
    // showing tabs for a folder that is no longer there.
    if (get().activeSession?.id === id) get().closeSession()
    await Promise.all([get().loadSessions(), get().loadArchived()])
  },

  restoreSession: async (id) => {
    await api.session.restore(id)
    await Promise.all([get().loadSessions(), get().loadArchived()])
  },

  deleteArchived: async (id) => {
    await api.session.deleteArchived(id)
    await get().loadArchived()
    // The project's bytes are gone; a usage report still showing them is worse
    // than none. Only refresh if it has been looked at at least once.
    if (get().usage) get().loadUsage()
  },

  // ─── Disk usage ────────────────────────────────────────────────────────────
  //
  // Fetched on demand, never as part of loading the project list: it walks
  // every project tree, and the list must not wait on a disk walk.

  usage: null,
  usageLoading: false,
  usageError: null,

  loadUsage: async () => {
    const signal = usageSlot.begin()
    set({ usageLoading: true, usageError: null })
    try {
      const usage = await api.session.usage({ signal })
      if (!usageSlot.current(signal)) return
      set({ usage, usageLoading: false })
    } catch (e: any) {
      // A superseded measurement is not a failure: another one is running, and
      // it owns the loading flag now.
      if (isSuperseded(e)) return
      set({ usageLoading: false,
            usageError: e?.message || 'Could not measure disk use' })
    }
  },

  reclaimSpace: async (id) => {
    const res = await api.session.reclaim(id)
    await get().loadUsage()
    return res.freed_bytes
  },

  // ─── Jobs ──────────────────────────────────────────────────────────────────

  jobs: [],
  jobsPanelOpen: false,
  setJobsPanelOpen: (v) => set({ jobsPanelOpen: v }),
  theme: 'dark',
  setTheme: (t) => {
    // Drive the CSS token overrides via a data attribute on <html>
    document.documentElement.setAttribute('data-theme', t)
    set({ theme: t })
  },

  pollJobs: async () => {
    const active = get().activeSession
    if (!active) return
    // This runs on an interval. When one poll outlasted the interval, two were
    // in flight and the older reply could land second — showing a finished job
    // as still running, or resurrecting a job list from the previous project.
    const signal = jobsSlot.begin()
    try {
      const jobs = await api.jobs.list(active.id, { signal })
      if (!jobsSlot.current(signal)) return
      if (get().activeSession?.id !== active.id) return
      set({ jobs })
    } catch {
      // Silently fail — the backend might be momentarily busy, and this fires
      // again shortly. A timeout now aborts the request instead of leaving it
      // to hang, so a stuck poll no longer freezes the job list for good.
    }
  },
}))

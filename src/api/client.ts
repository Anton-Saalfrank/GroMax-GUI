/**
 * Typed API client for the GroMax backend.
 * All fetch calls go through here — handles base URL and error wrapping.
 */

import type {
  SessionState, SessionSummary, ArchivedSummary, Condition, TimeWindow,
  Job, GmxInfo, BackendInfo, IndexGroup, Replica, AnalysisMeta,
  PcaReplicaFrame, PcaSelectionCheck, PcaReplicaSpec, NamedAnalysis, ChainDef, TranslateResult, StoredResult,
  EngineMeta, SelectionChip, DiskUsageReport } from '../types'

/**
 * Resolve where the backend lives.
 *
 * Three cases, in priority order:
 *
 *  1. PACKAGED APP — the backend serves this very page, so the API is on the
 *     SAME origin and a relative path is correct. This also means the backend
 *     port no longer has to be known by the frontend at all, which is what
 *     lets the port be chosen dynamically at startup.
 *
 *  2. VITE DEV SERVER — the page is served from :5173 but the backend is
 *     elsewhere. VITE_BACKEND_URL overrides; otherwise fall back to the
 *     conventional dev port.
 *
 *  3. Anything else — same fallback.
 *
 * Previously this was a hardcoded 'http://localhost:7432', which broke both
 * dynamic ports and any second running instance.
 */
function resolveBase(): string {
  if (typeof window === 'undefined') return ''

  const { origin, port } = window.location

  // Served by the backend itself (packaged app, or `vite preview` behind it).
  // The dev server is the only thing we expect on 5173.
  const isViteDev = port === '5173'
  if (!isViteDev && origin.startsWith('http')) return ''   // relative → same origin

  const envUrl = (import.meta as any)?.env?.VITE_BACKEND_URL
  return envUrl || 'http://127.0.0.1:7432'
}

const BASE = resolveBase()

/**
 * Cancellation and timeouts.
 *
 * WHY THERE IS NO DEFAULT TIMEOUT
 * Most endpoints here run GROMACS, walk a trajectory, or hash a cache. A
 * `gmx trjconv` over a 4 us trajectory legitimately takes minutes, and a
 * blanket timeout would abort real work and call it an error — strictly worse
 * than the hung spinner it was meant to fix. So the default is unbounded, the
 * same as before, and a timeout is opted into per call.
 *
 * WHERE A TIMEOUT IS OPTED INTO
 * The quick metadata reads: health, info, the project list, one project, the
 * job list. None of these touches a trajectory, so taking more than a few
 * seconds means something is wrong rather than slow. These are also the calls
 * that hurt most when they hang: `checkBackend` and `pollJobs` run on an
 * interval, so one stuck request used to leave `backendOnline` frozen at its
 * last value and the job list permanently stale, with nothing on screen saying
 * so and no way to recover but restarting the app.
 */
export interface ReqOpts {
  /** Abort this request when the signal fires. */
  signal?: AbortSignal
  /** Give up after this many ms. Omitted or 0 means never. */
  timeoutMs?: number
}

/** Why a request was aborted — callers treat these very differently. */
export type AbortReason = 'timeout' | 'superseded' | 'cancelled'

export class ApiAbortError extends Error {
  readonly reason: AbortReason
  constructor(reason: AbortReason, message: string) {
    super(message)
    this.name = 'ApiAbortError'
    this.reason = reason
  }
}

/** A request this app deliberately dropped, so there is nothing to report. */
export const isSuperseded = (e: unknown) =>
  e instanceof ApiAbortError && e.reason !== 'timeout'

/**
 * Build the signal actually handed to fetch, merging the caller's signal with
 * the timeout.
 *
 * Wired up by hand rather than with `AbortSignal.any()` so this works on any
 * engine the dev server might be opened in, and so the abort carries a REASON.
 * Without one, every cancellation arrives as the same bare `AbortError` and a
 * superseded request is indistinguishable from a backend that stopped
 * answering — which is the difference between staying quiet and telling the
 * user their backend is down.
 */
function armSignal(opts?: ReqOpts): {
  signal?: AbortSignal
  done: () => void
  reasonOf: (e: unknown) => ApiAbortError | null
} {
  const outer = opts?.signal
  const ms = opts?.timeoutMs ?? 0
  if (!outer && ms <= 0) {
    return { signal: undefined, done: () => {}, reasonOf: () => null }
  }

  const ctrl = new AbortController()
  let timedOut = false

  const timer = ms > 0 ? setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, ms) : null

  const onOuter = () => ctrl.abort()
  if (outer) {
    if (outer.aborted) ctrl.abort()
    else outer.addEventListener('abort', onOuter, { once: true })
  }

  return {
    signal: ctrl.signal,
    done: () => {
      if (timer) clearTimeout(timer)
      outer?.removeEventListener('abort', onOuter)
    },
    reasonOf: (e) => {
      // Only translate a genuine abort. A TypeError from a dead socket must
      // stay a network error, or "backend not running" would be reported as a
      // timeout and point at the wrong problem.
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      if (!aborted) return null
      if (timedOut) {
        // Sub-second waits round to "0s" with a plain toFixed(0), which reads
        // like a bug in the message rather than a timeout.
        const secs = ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
        return new ApiAbortError('timeout',
          `The backend did not respond within ${secs}.`)
      }
      return new ApiAbortError('superseded', 'Request superseded.')
    },
  }
}

async function failure(res: Response): Promise<Error> {
  // FastAPI puts the useful message in `detail`. Throwing the bare status
  // instead turns a helpful "no reference structure, import one in the System
  // tab" into an opaque "404 Not Found".
  const err = await res.json().catch(() => ({ detail: res.statusText }))
  return new Error(err.detail || `HTTP ${res.status}`)
}

async function getText(path: string, opts?: ReqOpts): Promise<string> {
  const arm = armSignal(opts)
  try {
    const res = await fetch(`${BASE}${path}`, { signal: arm.signal })
    if (!res.ok) throw await failure(res)
    return await res.text()
  } catch (e) {
    throw arm.reasonOf(e) ?? e
  } finally {
    arm.done()
  }
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: ReqOpts
): Promise<T> {
  const arm = armSignal(opts)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: arm.signal,
    })
    if (!res.ok) throw await failure(res)
    return await res.json()
  } catch (e) {
    throw arm.reasonOf(e) ?? e
  } finally {
    arm.done()
  }
}

/** Long enough that a busy backend is not called dead; short enough that the
 *  interval-driven pollers recover on their own. */
export const QUICK_MS = 15000

const get  = <T>(path: string, opts?: ReqOpts) => req<T>('GET',    path, undefined, opts)
const post = <T>(path: string, body: unknown, opts?: ReqOpts) => req<T>('POST',   path, body, opts)
const del  = <T>(path: string)              => req<T>('DELETE', path)
const patch = <T>(path: string, body: unknown) => req<T>('PATCH', path, body)

/**
 * One in-flight request at a time, newest wins.
 *
 * Two distinct bugs, one cause. Opening project A and then project B left both
 * requests in flight and whichever answered LAST won, so a slow first project
 * could load its state over the second one's — leaving the header naming B and
 * the tabs showing A. `pollJobs` had the same shape: it fires on an interval,
 * so when one poll outlasted the interval an older job list could land after a
 * newer one and a finished job would flip back to running.
 *
 * `begin()` cancels whatever was in the slot and returns a signal; `current()`
 * says whether a reply still belongs to the newest request. Both are needed:
 * the abort saves the work, and the check covers the response that was already
 * decoded and queued when the abort landed.
 */
export class RequestSlot {
  private ctrl: AbortController | null = null

  begin(): AbortSignal {
    this.ctrl?.abort()
    this.ctrl = new AbortController()
    return this.ctrl.signal
  }

  current(signal: AbortSignal): boolean {
    return this.ctrl?.signal === signal && !signal.aborted
  }

  /** Drop the in-flight request without starting another, e.g. on unmount. */
  cancel(): void {
    this.ctrl?.abort()
    this.ctrl = null
  }
}

// ─── Health ──────────────────────────────────────────────────────────────────

export const api = {
  health: () => get<{ status: string }>('/health', { timeoutMs: QUICK_MS }),
  info:   () => get<BackendInfo>('/api/info', { timeoutMs: QUICK_MS }),

  // ─── Sessions ──────────────────────────────────────────────────────────────

  session: {
    list:   (opts?: ReqOpts)          => get<SessionSummary[]>('/api/session/list',
                                           { timeoutMs: QUICK_MS, ...opts }),
    get:    (id: string, opts?: ReqOpts) => get<SessionState>(`/api/session/${id}`,
                                           { timeoutMs: QUICK_MS, ...opts }),
    create: (name: string)            => post<SessionState>('/api/session/create', { name }),
    delete: (id: string)              => del<{ ok: boolean }>(`/api/session/${id}`),

    /**
     * Archiving is the only removal the project list offers.
     *
     * It MOVES the folder to ~/.gromax/archive, keeping the id, so restoring
     * puts every path recorded inside state.json back where it was. Permanent
     * deletion exists only for something already archived.
     */
    archive: (id: string) =>
      post<{ ok: boolean; id: string; name: string }>(`/api/session/${id}/archive`, {}),

    listArchived: () => get<ArchivedSummary[]>('/api/session/archive/list',
                                               { timeoutMs: QUICK_MS }),

    /**
     * Disk use per project, broken down by what it is and whether it can be
     * recomputed. No timeout: this walks every project tree, which is ~0.5 s
     * for 32 GB on a warm local disk and much longer on a cold or networked
     * one — and a slow answer is still worth waiting for.
     */
    usage: (opts?: ReqOpts) => get<DiskUsageReport>('/api/session/usage/projects',
                                                    opts),

    /** Deduplicate a project's engine topologies. Frees space without
     *  dropping a single cache entry, so it needs no confirmation. */
    reclaim: (sessionId: string) =>
      post<{
        ok: boolean; freed_bytes: number; n_relinked: number
        n_distinct: number; total_bytes: number
      }>(`/api/session/${sessionId}/reclaim`, {}),

    restore: (id: string) =>
      post<{ ok: boolean; id: string }>(`/api/session/archive/${id}/restore`, {}),

    deleteArchived: (id: string) =>
      del<{ ok: boolean; id: string }>(`/api/session/archive/${id}`),

    deleteCondition: (sessionId: string, conditionId: string, purgeFiles = false) =>
      req<{ ok: boolean; name: string; analyses_removed: number }>(
        'DELETE',
        `/api/session/${sessionId}/conditions/${conditionId}?purge_files=${purgeFiles}`),

    addCondition: (sessionId: string, data: {
      name: string; colour: string; pbc_corrected: boolean
    }) => post<Condition>(`/api/session/${sessionId}/conditions`, data),

    updateCondition: (sessionId: string, condId: string, updates: Partial<Condition>) =>
      patch<Condition>(`/api/session/${sessionId}/conditions/${condId}`, updates),

    /**
     * Per-project UI state — picks, highlights, saved groups, the analysis
     * draft. Stored with the project so it survives closing the app.
     */
    saveWorkspace: (sessionId: string, workspace: Record<string, any>) =>
      req<{ ok: boolean }>('PUT', `/api/session/${sessionId}/workspace`,
                           { workspace }),

    addTimeWindow: (sessionId: string, data: Omit<TimeWindow, 'id'>) =>
      post<TimeWindow>(`/api/session/${sessionId}/time-windows`, data),

    deleteTimeWindow: (sessionId: string, windowId: string) =>
      del<{ ok: boolean }>(`/api/session/${sessionId}/time-windows/${windowId}`),
  },

  // ─── Files ─────────────────────────────────────────────────────────────────

  files: {
    scan: (folder: string, tprPattern = '*.tpr', xtcPattern = '*.xtc') =>
      post<{
        replicas: Replica[]; pdb_candidates: string[]; n_tpr: number; n_xtc: number
      }>('/api/files/scan', { folder, tpr_pattern: tprPattern, xtc_pattern: xtcPattern }),

    registerScan: (sessionId: string, conditionId: string, folder: string, replicas: Replica[], pdb: string | null) =>
      post<{ ok: boolean; n_replicas: number; n_paired: number }>('/api/files/register-scan', {
        session_id: sessionId, condition_id: conditionId, folder, replicas, pdb
      }),

    status: (sessionId: string, conditionId: string) =>
      get<{ ready: boolean; n_replicas: number; n_paired: number; has_pdb: boolean; source_dir: string }>(
        `/api/files/${sessionId}/${conditionId}/status`
      ),

    /** Open the OS file manager at this path. (Moved off the PCA router.) */
    reveal: (path: string) =>
      post<{ ok: boolean; error?: string }>('/api/files/reveal', { path }),

    copyPath: (path: string) =>
      get<{ path: string; exists: boolean }>(
        `/api/files/copy-path?path=${encodeURIComponent(path)}`),
  },

  // ─── GROMACS ───────────────────────────────────────────────────────────────

  gmx: {
    version: () => get<GmxInfo>('/api/gmx/version'),

    listIndexGroups: (sessionId: string, conditionId: string) =>
      post<{ groups: IndexGroup[] }>('/api/gmx/index-groups', {
        session_id: sessionId, condition_id: conditionId
      }),

    createNdx: (sessionId: string, conditionId: string, groupName: string, selections: string[]) =>
      post<{ ok: boolean; ndx_path: string }>('/api/gmx/create-ndx', {
        session_id: sessionId, condition_id: conditionId,
        group_name: groupName, selections
      }),
  },

  // ─── Analysis ──────────────────────────────────────────────────────────────

  analysis: {
    /** Analyses one engine can run — the sets genuinely differ between them. */
    available: (engine?: string) => get<AnalysisMeta[]>(
      `/api/analysis/available${engine ? `?engine=${encodeURIComponent(engine)}` : ''}`),

    /**
     * Every analysis engine, installed or not. Unavailable ones come back with
     * a reason and an install command rather than being omitted.
     */
    engines: () => get<{ engines: EngineMeta[]; default: string }>(
      '/api/analysis/engines'),

    /** Rewrite selections into another engine's language. */
    translateSelection: (selections: string[], toEngine: string) =>
      post<{
        selections: string[]
        warnings: string[]
        dialect: string
        chips: SelectionChip[]
        selection_help: string
      }>('/api/analysis/translate-selection',
         { selections, to_engine: toEngine }),

    run: (params: {
      session_id: string
      analysis_type: string
      engine?: string
      condition_ids: string[]
      groups: string[]
      analysis_name?: string
      time_start?: number | null
      time_end?: number | null
      stride?: number
      /** Per-analysis extras, e.g. { cutoff: 0.6 } for contacts over time. */
      params?: Record<string, any>
      force?: boolean
      /**
       * Which replicas to run, per condition: { condId: [1, 3, 4] }.
       *
       * A condition left out runs ALL of its replicas, and the backend hashes
       * that case identically to omitting the field entirely — so only send a
       * condition here when it really is a subset, or every cached analysis
       * would miss.
       */
      replicas?: Record<string, number[]>
    }) => post<{ ok: boolean; job_ids: string[] }>('/api/analysis/run', params),

    /**
     * What each residue typically does, measured across every condition.
     *
     * Reads matrices already cached, so nothing is recomputed. Normalising a
     * rolling-RMSF map against THIS rather than against each map's own rows is
     * what keeps the comparison between conditions alive — see rowNormalise.ts.
     */
    rowBaseline: (sessionId: string, cacheKeys: string[]) =>
      post<{
        n_rows: number
        n_conditions: number
        shared: { median: (number | null)[]; mad: (number | null)[] }
        per_condition: {
          cache_key: string; condition_id: string; condition_name: string
          colour: string; analysis_name: string
          n_replicas: number; n_windows: number; skipped_replicas: number[]
          median: (number | null)[]; mad: (number | null)[]
        }[]
        zlabel: string
        warnings: string[]
      }>('/api/analysis/row-baseline',
         { session_id: sessionId, cache_keys: cacheKeys }),

    clearCache: (sessionId: string) => del<{ ok: boolean; cleared: number }>(`/api/analysis/cache/${sessionId}`),

    reset: (sessionId: string) => post<{ ok: boolean; cleared_cache: number }>(`/api/analysis/reset/${sessionId}`, {}),

    list: (sessionId: string) => get<{ analyses: NamedAnalysis[] }>(`/api/analysis/list/${sessionId}`),

    deleteInstance: (sessionId: string, cacheKey: string) =>
      del<{ ok: boolean; deleted: string }>(`/api/analysis/instance/${sessionId}/${cacheKey}`),

    storedResults: (sessionId: string) =>
      get<{ results: StoredResult[] }>(`/api/analysis/results/${sessionId}`),

    storedResult: (sessionId: string, cacheKey: string) =>
      get<any>(`/api/analysis/result/${sessionId}/${cacheKey}`),

    /**
     * Correlate a rolling-RMSF map against a time series, per residue and at a
     * range of lags. Computed from results that already exist, so it returns
     * the finished analysis rather than a job id.
     */
    /**
     * Per-replicate distribution of a matrix result. Statistics come from every
     * cell; `sample` is a subsample for drawing only.
     */
    matrixDistribution: (sessionId: string, cacheKey: string, maxPoints = 2000) =>
      post<any>('/api/analysis/matrix-distribution',
                { session_id: sessionId, cache_key: cacheKey, max_points: maxPoints }),

    /** A stored time-series result as CSV. Omit `replica` for the aggregate. */
    exportCsv: (sessionId: string, cacheKey: string, replica?: number) =>
      post<{ filename: string; csv: string; n_rows: number; n_columns: number }>(
        '/api/analysis/export-csv',
        { session_id: sessionId, cache_key: cacheKey, replica: replica ?? null }),

    correlate: (params: {
      session_id: string
      map_key: string
      series_key: string
      max_lag_windows?: number
      method?: 'pearson' | 'spearman'
      name?: string
    }) => post<any>('/api/analysis/correlate', params),

    setVisibility: (sessionId: string, cacheKey: string, hidden: boolean) =>
      post<{ ok: boolean; cache_key: string; hidden: boolean }>('/api/analysis/visibility',
        { session_id: sessionId, cache_key: cacheKey, hidden }),
  },

  // ─── PCA (shared-basis) ────────────────────────────────────────────────────

  structure: {
    /** Raw PDB text for the viewer to parse client-side. */
    pdb: (sessionId: string, conditionId: string) =>
      getText(`/api/structure/${sessionId}/${conditionId}/pdb`),

    info: (sessionId: string, conditionId: string) =>
      get<{
        path: string; filename: string
        pdb_chains: any[]; n_pdb_residues: number
        defined_chains: any[]; has_system_definition: boolean
        warnings: string[]
      }>(`/api/structure/${sessionId}/${conditionId}/info`),

    /** Per-residue values for colouring, mapped to chain + resnum. */
    residueValues: (sessionId: string, cacheKey: string) =>
      post<{
        items: { chain: string; resnum: number; value: number }[]
        min: number; max: number
        n_mapped: number; n_unmapped: number
        label: string; analysis_name: string
        mapped_with_chains: boolean
      }>('/api/structure/residue-values',
         { session_id: sessionId, cache_key: cacheKey }),

    /**
     * One frame of a trajectory, dumped as a PDB in the app's own residue
     * numbering — so selections and highlights built on the reference
     * structure still mean the same residues in the frame.
     */
    frame: (sessionId: string, conditionId: string, replicaIndex: number,
            timeNs: number, includeSolvent: boolean) =>
      post<{
        pdb: string
        requested_ns: number
        actual_ns: number | null
        group: string
        warnings: string[]
      }>('/api/structure/frame', {
        session_id: sessionId, condition_id: conditionId,
        replica_index: replicaIndex, time_ns: timeNs,
        include_solvent: includeSolvent,
      }),

    /** Turn clicked residues into a GROMACS selection. */
    /**
     * The cavity behind a point clicked on the surface.
     *
     * The caller sends the atoms AROUND the click rather than naming a
     * structure, because what is on screen may be the reference or any frame
     * of any replica — and re-deriving that server-side would be a second
     * source of truth that could disagree with the picture.
     */
    cavityAt: (point: [number, number, number], atoms: {
      index: number; x: number; y: number; z: number
      name: string; resname: string; resnum: number; chain: string
    }[], params?: { probe?: number; burial?: number; region?: number }) =>
      post<{
        found: boolean
        reason: string
        volume_A3: number
        open_to_bulk: boolean
        max_sphere_A: number
        residues: { chain: string; resnum: number; resname: string; n_atoms: number }[]
        atom_indices: number[]
      }>('/api/structure/cavity-at', { point, atoms, ...(params || {}) }),

    resolvePicks: (sessionId: string,
                   picks: { chain: string; resnum: number; resname?: string;
                            atom?: string }[]) =>
      post<{
        residues: { chain: string; resnum: number; flat: number; resname?: string }[]
        flat_indices: number[]
        selection: string
        atom_level: boolean
        problems: string[]
        notes: string[]
        mutations: any[]
        ok: boolean
      }>('/api/structure/resolve-picks', { session_id: sessionId, picks }),
  },

  pca: {
    scanFrames: (sessionId: string, conditionIds: string[], baseSelection: string, includeResidues: string, excludeResidues: string) =>
      post<{ replicas: PcaReplicaFrame[] }>('/api/pca/scan-frames', {
        session_id: sessionId, condition_ids: conditionIds,
        base_selection: baseSelection, include_residues: includeResidues, exclude_residues: excludeResidues,
      }),

    checkSelection: (sessionId: string, conditionIds: string[], baseSelection: string, includeResidues: string, excludeResidues: string) =>
      post<PcaSelectionCheck>('/api/pca/check-selection', {
        session_id: sessionId, condition_ids: conditionIds,
        base_selection: baseSelection, include_residues: includeResidues, exclude_residues: excludeResidues,
      }),

    run: (params: {
      session_id: string
      condition_ids: string[]
      base_selection: string
      include_residues: string
      exclude_residues: string
      projection: 'per_condition' | 'per_replica'
      replicas: PcaReplicaSpec[]
      n_components?: number
      pca_name?: string
    }) => post<{ ok: boolean; job_id: string }>('/api/pca/run', params),

    /** @deprecated moved to api.files.reveal — kept so existing calls work. */
    reveal: (path: string) =>
      post<{ ok: boolean; error?: string }>('/api/files/reveal', { path }),
  },

  system: {
    importPdb: (sessionId: string, pdbPath: string) =>
      post<{ chains: ChainDef[]; n_residues: number }>('/api/system/import-pdb', { session_id: sessionId, pdb_path: pdbPath }),
    save: (sessionId: string, chains: ChainDef[]) =>
      post<{ ok: boolean; chains: ChainDef[] }>('/api/system/save', { session_id: sessionId, chains }),
    get: (sessionId: string) =>
      get<{ defined: boolean; chains: ChainDef[]; source_pdb?: string; n_residues?: number }>(`/api/system/get/${sessionId}`),
    translate: (params: { session_id: string; chain_id: string; res_start: number; res_end?: number; check_type?: boolean; expected_resname?: string }) =>
      post<TranslateResult>('/api/system/translate', params),
  },

  contacts: {
    run: (params: { session_id: string; condition_ids: string[]; target_selection: string; cutoff_nm: number; mode?: string; name?: string; filter_name?: string; filter_op?: string; filter_threshold?: number | null }) =>
      post<{ ok: boolean; job_ids: string[] }>('/api/contacts/run', params),
  },

  // ─── App config ────────────────────────────────────────────────────────────

  config: {
    get:       ()                  => get<any>("/api/config"),
    update:    (updates: Record<string, any>) => req<any>("PATCH", "/api/config", updates),
    verifyGmx: (path: string)      => post<{ ok: boolean; version?: string; error?: string; path?: string }>("/api/config/verify-gmx", { path }),

    /** Figure styling presets live with the app, not with a project. */
    savePreset: (name: string, style: Record<string, any>, makeDefault = false) =>
      post<any>("/api/config/presets", { name, style, make_default: makeDefault }),
    deletePreset: (name: string) =>
      del<any>(`/api/config/presets/${encodeURIComponent(name)}`),
  },

  // ─── Jobs ──────────────────────────────────────────────────────────────────

  jobs: {
    list:          (sessionId?: string, opts?: ReqOpts) =>
      get<Job[]>(`/api/jobs${sessionId ? `?session_id=${sessionId}` : ''}`,
                 { timeoutMs: QUICK_MS, ...opts }),
    get:           (jobId: string)      => get<Job>(`/api/jobs/${jobId}`),
    cancel:        (jobId: string)      => post<{ ok: boolean }>(`/api/jobs/${jobId}/cancel`, {}),
    clearFinished: (sessionId: string)  => del<{ ok: boolean }>(`/api/jobs/session/${sessionId}/finished`),
  },
}

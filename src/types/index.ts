// ─── Electron IPC bridge (injected by preload.js) ────────────────────────────

export interface ElectronAPI {
  openFiles: (options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
  openDirectory: () => Promise<Electron.OpenDialogReturnValue>
  saveFile: (options: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>
  getVersion: () => Promise<string>
  getUserDataPath: () => Promise<string>
  getBackendPort: () => Promise<number>
  onJobProgress: (cb: (data: JobProgressEvent) => void) => () => void
  onJobComplete: (cb: (data: JobCompleteEvent) => void) => () => void
  onBackendReady: (cb: (data: any) => void) => () => void
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

// ─── Session / Project ───────────────────────────────────────────────────────

export interface Replica {
  index: number
  tpr: string | null
  xtc: string | null
  tpr_name?: string | null
  xtc_name?: string | null
  paired: boolean
}

export interface Condition {
  id: string
  name: string
  colour: string
  files: Partial<Record<string, string>>
  pbc_corrected: boolean
  replicas: Replica[]
  pdb?: string | null
  source_dir?: string | null
}

/** A common selection, labelled the same everywhere, spelled per engine. */
export interface SelectionChip {
  label: string
  value: string
}

/**
 * One piece of analysis software, and whether it can run here.
 *
 * Unavailable engines are still listed — "not installed" and "not supported"
 * look identical if you simply hide the ones that are missing.
 */
export interface EngineMeta {
  id: string
  name: string
  description: string
  homepage: string
  dialect: string
  selection_help: string
  install_hint: string
  notes: string[]
  analyses: AnalysisMeta[]
  available: boolean
  version: string | null
  reason: string | null
}

export interface AnalysisMeta {
  params_schema?: any[]
  type: string
  name: string
  description: string
  n_groups: number
  group_prompts: string[]
  default_groups: string[]
}

export interface AnalysisResult {
  kind: string          // 'line' | 'heatmap' | 'scatter2d'
  /**
   * Zero is the meaningful midpoint of this matrix, so it wants a diverging
   * red/blue scale rather than a sequential one. Set by correlation matrices.
   */
  diverging?: boolean
  /**
   * One residue identity per matrix row, in row order, for matrices whose rows
   * ARE residues. Null entries are rows the system definition could not place —
   * kept in place rather than dropped, so the row indices stay aligned.
   *
   * This is what makes a matrix clickable: without it a dragged region is two
   * ranges of row numbers with nothing to map them onto.
   */
  residues?: ({ chain: string; resnum: number } | null)[]
  x: number[]
  y: number[]
  y_mean?: number[]
  y_sd?: number[]
  n_replicas?: number
  xlabel: string
  ylabel: string
  title: string
  condition_id?: string
  condition_name?: string
  colour?: string
  analysis_type?: string
  analysis_name?: string
  replicas?: { index: number; x?: number[]; y: number[] }[]
  // Heatmap fields
  z?: number[][]
  zlabel?: string
  categorical?: boolean
  categories?: string[]
  replica_note?: string
  // PCA
  var_explained?: number[]
}

export interface TimeWindow {
  id: string
  name: string
  start_ns: number | null
  end_ns: number | null
  stride: number
}

export interface SessionState {
  id: string
  name: string
  created_at: string
  updated_at: string
  conditions: Record<string, Condition>
  time_windows: Record<string, TimeWindow>
  index_groups: Record<string, string>
  analyses: Record<string, AnalysisRecord>
  notes: string
  /** Per-project UI state, persisted with the project. */
  workspace?: Record<string, any>
}

export interface SessionSummary {
  id: string
  name: string
  created_at: string
  updated_at: string
  conditions: string[]
  path: string
}

/**
 * Disk use of one project, broken down.
 *
 * A total alone says you have a problem without saying what to do about it.
 * The split is what makes it actionable: `recomputable` marks the categories
 * that can be thrown away and rebuilt, so the UI can distinguish 11 GB of
 * irreplaceable analysis results from 300 MB of cache.
 */
export interface UsageCategory {
  key: string
  label: string
  bytes: number
  n_files: number
  /** Can be deleted and rebuilt by re-running, at the cost of the compute. */
  recomputable: boolean
}

export interface ProjectUsage {
  id: string
  name: string
  path: string
  archived: boolean
  total_bytes: number
  n_files: number
  categories: UsageCategory[]
  /** Anything not in a named category, so the parts always sum to the total. */
  other_bytes: number
  /** Measured by a dry run, not estimated: what a reclaim would actually free. */
  reclaimable_bytes: number
  error?: string
}

export interface DiskUsageReport {
  projects: ProjectUsage[]
  total_bytes: number
  reclaimable_bytes: number
}

/** A project in ~/.gromax/archive — same shape, plus when it was archived. */
export interface ArchivedSummary extends SessionSummary {
  archived_at: string
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Job {
  id: string
  session_id: string
  condition_id: string
  analysis_type: string
  label: string
  status: JobStatus
  progress: number
  log: string[]
  result: any
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  params: Record<string, any>
}

export interface JobProgressEvent { job_id: string; progress: number; log_line: string }
export interface JobCompleteEvent  { job_id: string; status: JobStatus; result: any }

// ─── PCA ─────────────────────────────────────────────────────────────────────

export interface PcaReplicaFrame {
  condition_id: string
  condition_name: string
  colour: string
  replica_index: number
  tpr: string
  xtc: string
  n_frames: number | null
  t_end_ps: number | null
  dt_ps: number | null
}

export interface PcaReplicaSpec {
  condition_id: string
  replica_index: number
  tpr: string
  xtc: string
  start_ns?: number | null
  end_ns?: number | null
  stride: number
}

export interface PcaSelectionCheck {
  selection: string
  consistent: boolean
  atom_counts: number[]
  per_replica: {
    condition_id: string
    condition_name: string
    replica_index: number
    n_atoms: number | null
    ok: boolean
    error: string | null
  }[]
  suggested_exclusions: number[]
}

export interface PcaCloud {
  label: string
  colour: string
  x: number[]
  y: number[]
}

export interface PcaExtreme {
  condition_id: string
  condition_name: string
  colour: string
  path: string
  filename: string
}

export interface PcaResult {
  kind: 'pca'
  clouds: PcaCloud[]
  var_explained: number[]
  xlabel: string
  ylabel: string
  title: string
  n_atoms: number
  selection: string
  analysis_type: 'pca'
  extremes?: PcaExtreme[]
  pca_dir?: string
}

// ─── Analysis ────────────────────────────────────────────────────────────────

export interface AnalysisRecord {
  type: string
  params: Record<string, any>
  result_path: string
  cache_key: string
  created_at: string
}

export interface XvgData {
  x: number[]
  y_series: number[][]
  labels: string[]
  xlabel: string
  ylabel: string
  title: string
}

// ─── GMX ─────────────────────────────────────────────────────────────────────

export interface IndexGroup {
  index: number
  name: string
  n_atoms: number | null
}

export interface GmxInfo {
  available: boolean
  version: string | null
  executable: string | null
}

export interface BackendInfo {
  gromax_version: string
  python_version: string
  gromacs_available: boolean
  gromacs_path: string | null
  projects_dir: string
  platform: string
}


export interface NamedAnalysis {
  cache_key: string
  type: string
  name: string
  condition_id: string
  condition_name: string
  colour: string
  folder: string
}


export interface ChainDef {
  id: string
  label: string
  start_resnum: number
  end_resnum: number
  n_residues: number
}

export interface TranslateResult {
  chain_id: string
  res_start: number
  res_end: number
  flat_start: number
  flat_end: number
  ri: string
  actual_resname?: string | null
  check_passed?: boolean
}


export interface StoredResult {
  cache_key: string
  type: string
  /**
   * Which analysis software produced this. Results predating the engine picker
   * come back as 'gromacs', because that is what they were.
   */
  engine?: string
  name: string
  condition_id: string
  condition_name: string
  colour: string
  hidden: boolean
  result: AnalysisResult
}

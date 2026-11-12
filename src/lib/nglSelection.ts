/**
 * NGL selection helpers.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * NGL's selection language is NOT PyMOL's and NOT ChimeraX's, and it fails in
 * the worst possible way: silently, by selecting EVERYTHING.
 *
 *   parseSele() throws on an unknown token
 *     -> Selection.setString() catches it and stores { error }
 *       -> makeAtomTest() returns `false` for an errored selection
 *         -> Structure.getAtomSet() sees a falsy `.test` and returns
 *            `new BitArray(n, true)` — every atom in the system.
 *
 * So a typo, or any borrowed PyMOL idiom, turns a "show this loop" overlay into
 * "draw all 35 000 waters and every ion in licorice". That is exactly what the
 * view-mode neighbour highlight used to do: it asked for
 * `within 5 of (269:A)`, and NGL has no `within` keyword at all.
 *
 * The two rules this file enforces:
 *   1. Never hand NGL a selection string that has not been validated.
 *   2. Compute distance queries OURSELVES against the spatial hash, and pass
 *      the answer as an explicit `@atom,index,list`, which cannot be
 *      misinterpreted.
 */
import { Selection } from 'ngl'

/** A residue in biological identity terms, as picked in the viewer. */
export interface PickedResidue {
  chain: string
  resnum: number
  resname: string
  /** Set only in atom pick mode — the specific atom clicked (e.g. 'OD1'). */
  atom?: string
}

/** Base representation types offered in the viewer toolbar. */
export type Rep =
  | 'cartoon' | 'ribbon' | 'tube' | 'backbone' | 'rope'
  | 'licorice' | 'ball+stick' | 'spacefill' | 'point'
  | 'surface'

export type ColorScheme =
  | 'chainname' | 'sstruc' | 'element' | 'resindex' | 'bfactor' | 'value'

export type PickMode = 'residue' | 'atom'

/**
 * What a click does.
 *
 *   select — adds to the analysis selection (what gets measured)
 *   view   — highlights transiently to inspect surroundings, WITHOUT changing
 *            what will be analysed
 *
 * Keeping these apart matters: exploring "what is near this residue" should
 * never silently enlarge the set of residues you are about to run an analysis
 * on.
 */
export type InteractionMode = 'select' | 'view'

/**
 * Selection breadth, mirroring ChimeraX's up/down-arrow widening:
 *   atom -> residue -> secondary structure element -> chain
 */
export type SelectionLevel = 'atom' | 'residue' | 'sstruc' | 'chain'
export const SELECTION_LEVELS: SelectionLevel[] =
  ['atom', 'residue', 'sstruc', 'chain']

/**
 * NGL selection strings for what to display.
 *
 * Solvent dominates a solvated system — 35k water residues drown a 600-residue
 * protein — so it is hidden by DEFAULT and opt-in, which is the same choice
 * ChimeraX and PyMOL make.
 */
export interface DisplayFilters {
  solvent: boolean
  ions: boolean
  hetero: boolean          // ligands, cofactors (not water/ions)
  hydrogens: boolean
}

export const DEFAULT_FILTERS: DisplayFilters = {
  solvent: false, ions: false, hetero: true, hydrogens: false,
}

/** Build the "what is visible" selection from the filter toggles. */
/**
 * Ion residue names NGL's own `ion` keyword does not know.
 *
 * NGL matches a short list of PDB-style names (NA, CL, K, …). GROMACS systems
 * built with CHARMM-GUI use the CHARMM names instead — SOD, POT, CLA — and
 * AMBER adds its own. None of those match, so "hide ions" hid nothing:
 * measured on the real WT vs Y269C system, a surface with ions switched OFF
 * still contained roughly 270 ion atoms, each rendered as its own free-
 * floating blob. The protein was behind several hundred of them, and because
 * they are part of the surface they were pickable too.
 *
 * Names only — a bare element check would catch the calcium in a real
 * calcium-binding site as readily as a counter-ion from the solvent box.
 */
export const EXTRA_ION_RESNAMES = [
  // CHARMM / CHARMM-GUI
  'SOD', 'POT', 'CLA', 'CAL', 'CES', 'MG', 'ZN2', 'RUB', 'BAR',
  // AMBER
  'Na+', 'Cl-', 'K+', 'Ca2+', 'Mg2+', 'IB',
  // GROMOS / other common GROMACS topologies
  'NA+', 'CL-', 'CU1', 'CU2',
]

/**
 * The `[RESNAME] or …` clause for the names above.
 *
 * ALPHANUMERIC NAMES ONLY. NGL's parser does not accept `[Na+]`, and an
 * unparseable selection in NGL does not throw — it matches EVERY ATOM. A
 * typo here would therefore not hide the ions, it would hide the protein.
 * The names with charges stay in the list for `isExtraIon`, which is plain
 * JavaScript and has no such hazard.
 */
function extraIonSele(): string {
  return EXTRA_ION_RESNAMES
    .filter(n => /^[A-Za-z0-9]+$/.test(n))
    .map(n => `[${n}]`)
    .join(' or ')
}

/** True if this residue name is an ion NGL would not recognise as one. */
export function isExtraIon(resname: string): boolean {
  if (!resname) return false
  const want = resname.trim().toUpperCase()
  return EXTRA_ION_RESNAMES.some(n => n.toUpperCase() === want)
}

export function buildFilterSele(f: DisplayFilters): string {
  const excluded: string[] = []
  if (!f.solvent) excluded.push('water')
  if (!f.ions) excluded.push('ion', `(${extraIonSele()})`)
  if (!f.hydrogens) excluded.push('_H')
  if (!f.hetero) excluded.push('(hetero and not water and not ion)')
  return excluded.length ? `not (${excluded.join(' or ')})` : 'all'
}

/** Combine the filter with a representation's own requirement. */
export function seleFor(rep: string, f: DisplayFilters): string {
  const base = buildFilterSele(f)
  // Polymer representations can only draw a traceable backbone; restricting
  // them explicitly is far more reliable than adding cartoon over everything
  // and hoping NGL works out what to skip.
  const polymerReps = ['cartoon', 'ribbon', 'tube', 'backbone', 'rope']
  if (polymerReps.includes(rep)) {
    return base === 'all' ? 'polymer' : `(${base}) and polymer`
  }
  return base
}

/**
 * AND several selections together.
 *
 * The leading `all and` is deliberate. parseSele() begins with:
 *
 *     if (string.charAt(0) === '(' && string.substr(-1) === ')')
 *         string = string.slice(1, -1)
 *
 * — it strips the outer parentheses whenever a string merely STARTS with '('
 * and ENDS with ')', without checking that they are the same pair, so the
 * obvious `(A) and (B)` gets mangled into `A) and (B`. In practice the parser
 * re-balances that: an unmatched ')' with an empty context stack starts a new
 * root, and the trees come out identical for every shape this file produces
 * (checked against NGL's own parser). Prefixing a bare keyword means we do not
 * have to depend on that recovery — and given what an unparseable selection
 * costs here (see the note at the top of this file), one no-op `all` under an
 * AND is a cheap thing to pay.
 */
export function combineSele(...parts: (string | null | undefined)[]): string {
  const kept = parts
    .map(p => (p || '').trim())
    .filter(p => p.length > 0 && p.toLowerCase() !== 'all')
  if (!kept.length) return 'all'
  return `all and ${kept.map(p => `(${p})`).join(' and ')}`
}

/**
 * Validate a selection string the way NGL will read it.
 * Returns an error message, or null when the string is safe to use.
 */
export function seleError(sele: string): string | null {
  const trimmed = (sele || '').trim()
  if (!trimmed) return 'Empty selection'
  try {
    const sel = new Selection(trimmed)
    const err = (sel as any)?.selection?.error
    // An errored selection is not inert — NGL treats it as "select all", so
    // this has to be reported rather than passed through.
    return err ? String(err) : null
  } catch (e: any) {
    return e?.message || 'Invalid selection'
  }
}

/** Turn a list of atom indices into a selection NGL cannot misread. */
export function indexSele(indices: ArrayLike<number>): string {
  if (!indices.length) return 'none'
  return '@' + Array.from(indices).join(',')
}

/**
 * Atom indices belonging to a picked residue.
 *
 * Deliberately matched against the structure rather than expressed as a
 * `resnum:chain` string: GROMACS PDBs frequently have a blank chain column and
 * numbering that wraps at 9999, so a bare `123` can match a protein residue AND
 * a water. Matching resname too disambiguates them.
 */
export function residueAtomIndices(structure: any, r: PickedResidue): number[] {
  return residuesAtomIndices(structure, [r])
}

/**
 * Atom indices for a set of picks, in one pass over the structure.
 *
 * One pass, not one per pick: this runs on every click, and a 30-residue
 * selection against a 100 000-atom solvated system is 3 million proxy reads if
 * you loop the picks on the outside. Bucketing by residue number means almost
 * every atom is rejected by a single Map lookup.
 */
export function residuesAtomIndices(
  structure: any, picks: PickedResidue[],
): number[] {
  const out: number[] = []
  if (!structure || !picks.length) return out

  const byResno = new Map<number, PickedResidue[]>()
  for (const p of picks) {
    const bucket = byResno.get(p.resnum)
    if (bucket) bucket.push(p)
    else byResno.set(p.resnum, [p])
  }

  structure.eachAtom((ap: any) => {
    const candidates = byResno.get(ap.resno)
    if (!candidates) return
    const chain = ap.chainname || ap.chainid || ''
    for (const p of candidates) {
      // An empty chain or resname on the pick means "unspecified", not "blank":
      // plot-hover highlights carry no resname, and GROMACS PDBs often have no
      // chain at all.
      if (p.chain && chain !== p.chain) continue
      if (p.resname && ap.resname && ap.resname !== p.resname) continue
      if (p.atom && ap.atomname !== p.atom) continue
      out.push(ap.index)
      return
    }
  })
  return out
}

/**
 * Every atom within `radius` Å of `centre`, expanded to whole residues.
 *
 * This is the `within N of (...)` that NGL does not have. Computed against the
 * structure's spatial hash, exactly the way NGL's own
 * getAtomSetWithinSelection does it, and returned as indices so the caller can
 * hand NGL something unambiguous.
 */
export function atomsWithin(
  structure: any,
  centre: ArrayLike<number>,
  radius: number,
  opts: { excludeSelf?: boolean } = {},
): number[] {
  const hash = structure?.spatialHash
  if (!hash || !centre.length || radius <= 0) return []

  const ap = structure.getAtomProxy()
  const hitResidues = new Set<number>()
  for (let i = 0; i < centre.length; i++) {
    ap.index = centre[i]
    const hits = hash.within(ap.x, ap.y, ap.z, radius)
    for (const idx of hits) {
      ap.index = idx
      hitResidues.add(ap.residueIndex)
    }
  }

  const self = opts.excludeSelf ? new Set(Array.from(centre)) : null
  const rp = structure.getResidueProxy()
  const out: number[] = []

  for (const ri of hitResidues) {
    rp.index = ri
    for (let ai = rp.atomOffset; ai <= rp.atomEnd; ai++) {
      if (self?.has(ai)) continue
      out.push(ai)
    }
  }
  return out.sort((a, b) => a - b)
}

/**
 * Keep only the atoms the display filters allow — the numeric twin of
 * buildFilterSele().
 *
 * Needed wherever a count is shown next to a drawing: applying the filter as a
 * selection string and counting before it means the readout claims neighbours
 * that are not on screen.
 */
/**
 * The same test as applyDisplayFilters, for ONE atom at a time.
 *
 * Exists because surface picking needs to reject an atom before it is chosen,
 * not filter a list afterwards: the ray cast takes the NEAREST atom, so a
 * hidden one that happens to be nearest has already won by the time a list
 * filter would see it.
 *
 * Returns a closure rather than taking the filters each call, so the two
 * proxies are allocated once per pick instead of once per candidate atom.
 */
export function displayFilterTest(
  structure: any, f: DisplayFilters,
): (index: number) => boolean {
  if (!structure) return () => true
  const ap = structure.getAtomProxy()
  const rp = structure.getResidueProxy()
  return (index: number) => {
    ap.index = index
    if (!f.hydrogens && ap.element === 'H') return false
    rp.index = ap.residueIndex
    const water = rp.isWater?.() ?? false
    const ion = rp.isIon?.() ?? false
    if (!f.solvent && water) return false
    if (!f.ions && (ion || isExtraIon(rp.resname))) return false
    if (!f.hetero && !water && !ion && (rp.isHetero?.() ?? false)) return false
    return true
  }
}

export function applyDisplayFilters(
  structure: any, indices: number[], f: DisplayFilters,
): number[] {
  if (!structure) return indices
  const ap = structure.getAtomProxy()
  const rp = structure.getResidueProxy()
  const out: number[] = []
  for (const i of indices) {
    ap.index = i
    if (!f.hydrogens && ap.element === 'H') continue
    rp.index = ap.residueIndex
    const water = rp.isWater?.() ?? false
    const ion = rp.isIon?.() ?? false
    if (!f.solvent && water) continue
    if (!f.ions && (ion || isExtraIon(rp.resname))) continue
    if (!f.hetero && !water && !ion && (rp.isHetero?.() ?? false)) continue
    out.push(i)
  }
  return out
}

/** How many distinct residues a set of atom indices covers. */
export function residueCount(structure: any, indices: number[]): number {
  if (!structure || !indices.length) return 0
  const ap = structure.getAtomProxy()
  const seen = new Set<number>()
  for (const i of indices) { ap.index = i; seen.add(ap.residueIndex) }
  return seen.size
}

/**
 * Backbone atoms dropped by "side chains only", Cα deliberately kept.
 *
 * Named explicitly rather than asked of NGL. AtomProxy.isSidechain() is
 * `isPolymer() && !isBackbone()`, and isBackbone() consults
 * `residueType.backboneIndexList` — which NGL fills in only when it recognises
 * the residue's backbone type from its atom names, and returns FALSE for the
 * whole residue when it does not. On a GROMACS PDB (protonated histidines
 * named HISE/HSD, terminal OT1/OT2, chain column blank) that detection misses
 * residues, and a miss means "every atom in this residue is a side chain" — so
 * side-chains-only left whole residues fully drawn while its neighbours
 * thinned out, patchy along the chain.
 *
 * A fixed name list cannot go patchy: every residue is treated the same way.
 */
const PROTEIN_BACKBONE_ATOMS = new Set([
  'N', 'C', 'O',
  // C-terminal oxygens, across PDB/CHARMM/AMBER/GROMACS spellings
  'OXT', 'OT1', 'OT2', 'OC1', 'OC2', "O'", "O''",
  // Backbone hydrogens, including the three on a charged N-terminus
  'H', 'HN', 'H1', 'H2', 'H3', 'HT1', 'HT2', 'HT3',
  'HA', 'HA1', 'HA2', 'HA3',
])

/** The nucleic equivalent: phosphate and 5'/3' linkage, keeping sugar + base. */
const NUCLEIC_BACKBONE_ATOMS = new Set([
  'P', 'OP1', 'OP2', 'OP3', 'O1P', 'O2P', 'O3P',
  "O5'", 'O5*', "C5'", 'C5*', "O3'", 'O3*',
  "H5'", "H5''", "HO5'", "HO3'",
])

/**
 * Standard residue names, including the protonation- and force-field-specific
 * spellings GROMACS emits. Used to classify a residue when NGL's own
 * moleculeType detection is the very thing that cannot be trusted here.
 */
const AMINO_ACID_RESNAMES = new Set([
  'ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE',
  'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL',
  // Histidine tautomers / protonation states
  'HID', 'HIE', 'HIP', 'HSD', 'HSE', 'HSP', 'HISA', 'HISB', 'HISD', 'HISE',
  'HISH', 'HIS1', 'HIS2',
  // Other charge states and modified residues that still have a backbone
  'ASH', 'GLH', 'LYN', 'CYX', 'CYM', 'CYS2', 'ARGN', 'ASPH', 'GLUH', 'LYSH',
  'MSE', 'SEC', 'PYL', 'ACE', 'NME', 'NAC', 'NH2',
])

const NUCLEIC_RESNAMES = new Set([
  'A', 'C', 'G', 'U', 'T', 'I',
  'DA', 'DC', 'DG', 'DT', 'DI', 'RA', 'RC', 'RG', 'RU',
  'ADE', 'CYT', 'GUA', 'THY', 'URA',
])

type ResidueKind = 'protein' | 'nucleic' | 'other'

function classifyResidue(rp: any): ResidueKind {
  const resname = String(rp.resname || '').toUpperCase()
  // Name first: it is what the file actually says, and it survives the cases
  // where NGL's structural detection gives up.
  if (AMINO_ACID_RESNAMES.has(resname)) return 'protein'
  if (NUCLEIC_RESNAMES.has(resname)) return 'nucleic'
  if (rp.isProtein?.()) return 'protein'
  if (rp.isNucleic?.()) return 'nucleic'
  return 'other'
}

/**
 * Reduce polymer atoms to side chain + Cα, leaving ligands, ions and waters
 * whole.
 *
 * This is the "what is this residue touching" view: a full backbone shell
 * buries the contact in tube, while a ligand stripped to its "side chain" is
 * nothing at all. Glycine keeps only its Cα, which is correct — it has no side
 * chain to show.
 */
export function toContactAtoms(structure: any, indices: number[]): number[] {
  if (!structure) return indices
  const ap = structure.getAtomProxy()
  const rp = structure.getResidueProxy()
  const kindCache = new Map<number, ResidueKind>()
  const out: number[] = []

  for (const i of indices) {
    ap.index = i
    const ri = ap.residueIndex
    let kind = kindCache.get(ri)
    if (kind === undefined) {
      rp.index = ri
      kind = classifyResidue(rp)
      kindCache.set(ri, kind)
    }
    if (kind === 'other') { out.push(i); continue }
    const drop = kind === 'protein'
      ? PROTEIN_BACKBONE_ATOMS
      : NUCLEIC_BACKBONE_ATOMS
    if (drop.has(String(ap.atomname || '').toUpperCase())) continue
    out.push(i)
  }
  return out
}

/** Grow a set of atom indices to cover every atom of the residues it touches. */
export function wholeResidues(structure: any, indices: number[]): number[] {
  if (!structure || !indices.length) return indices
  const ap = structure.getAtomProxy()
  const rp = structure.getResidueProxy()
  const seen = new Set<number>()
  const out: number[] = []
  for (const i of indices) {
    ap.index = i
    const ri = ap.residueIndex
    if (seen.has(ri)) continue
    seen.add(ri)
    rp.index = ri
    for (let a = rp.atomOffset; a <= rp.atomEnd; a++) out.push(a)
  }
  return out.sort((a, b) => a - b)
}

/** One-letter codes, for the sequence view. */
const ONE_LETTER: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E',
  GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F',
  PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
  // GROMACS / force-field spellings map to their parent residue, so a
  // protonated histidine still reads as H rather than a run of X.
  HID: 'H', HIE: 'H', HIP: 'H', HSD: 'H', HSE: 'H', HSP: 'H',
  HISA: 'H', HISB: 'H', HISD: 'H', HISE: 'H', HISH: 'H', HIS1: 'H', HIS2: 'H',
  ASH: 'D', GLH: 'E', LYN: 'K', LYSH: 'K', ARGN: 'R', ASPH: 'D', GLUH: 'E',
  CYX: 'C', CYM: 'C', CYS2: 'C', MSE: 'M', SEC: 'U', PYL: 'O',
  DA: 'A', DC: 'C', DG: 'G', DT: 'T', DI: 'I',
  A: 'A', C: 'C', G: 'G', U: 'U', T: 'T', I: 'I',
}

export function oneLetter(resname: string): string {
  return ONE_LETTER[String(resname || '').toUpperCase()] || 'X'
}

/**
 * Secondary structure, normalised.
 *
 * NGL's single-letter codes are DSSP's, and they do not read the way you would
 * guess: 's' is a BEND, not a sheet. Sheets are 'e' (extended strand) and 'b'
 * (isolated bridge); helices are 'h', 'g' (3-10) and 'i' (pi). Checking for
 * 's' — which is the obvious thing to write — silently finds no sheets at all
 * and mislabels bends as sheets, which is exactly what happened here.
 *
 * NGL's own constants, not guesses:
 *   SecStrucHelix = ['h','g','i']
 *   SecStrucSheet = ['e','b']
 *   SecStrucTurn  = ['s','t','l','']
 */
export type SecondaryStructure = 'helix' | 'sheet' | 'turn' | 'coil'

const SS_HELIX = new Set(['h', 'g', 'i'])
const SS_SHEET = new Set(['e', 'b'])
const SS_TURN = new Set(['s', 't'])

export function classifySstruc(code: string): SecondaryStructure {
  const c = String(code || '').toLowerCase()
  if (SS_HELIX.has(c)) return 'helix'
  if (SS_SHEET.has(c)) return 'sheet'
  if (SS_TURN.has(c)) return 'turn'
  return 'coil'
}

/** Human-readable name for a code, for tooltips. */
export function sstrucLabel(code: string): string {
  const c = String(code || '').toLowerCase()
  return ({
    h: 'α-helix', g: '3₁₀-helix', i: 'π-helix',
    e: 'β-strand', b: 'β-bridge',
    s: 'bend', t: 'turn', l: 'loop',
  } as Record<string, string>)[c] || ''
}

export interface SeqResidue {
  resnum: number
  resname: string
  code: string
  /** Raw NGL code, kept for tooltips. */
  sstruc: string
  /** Normalised — use this, not the raw letter. */
  ss: SecondaryStructure
}

export interface SeqChain {
  chain: string
  residues: SeqResidue[]
}

/**
 * The polymer sequence, per chain, in structure order.
 *
 * Read from the loaded structure rather than fetched separately: the sequence
 * view exists to select residues in the thing on screen, so it has to be the
 * same residue numbering the viewer picks report.
 */
export function structureSequence(structure: any): SeqChain[] {
  if (!structure) return []
  const chains: SeqChain[] = []
  let current: SeqChain | null = null
  structure.eachResidue((rp: any) => {
    if (!rp.isPolymer?.()) return
    const chain = rp.chainname || rp.chainid || ''
    if (!current || current.chain !== chain) {
      current = { chain, residues: [] }
      chains.push(current)
    }
    const sstruc = rp.sstruc || ''
    current.residues.push({
      resnum: rp.resno,
      resname: rp.resname || '',
      code: oneLetter(rp.resname),
      sstruc,
      ss: classifySstruc(sstruc),
    })
  })
  return chains
}

/** The residues a set of atom indices covers, as pickable identities. */
export function residuesOf(structure: any, indices: number[]): PickedResidue[] {
  if (!structure || !indices.length) return []
  const ap = structure.getAtomProxy()
  const rp = structure.getResidueProxy()
  const seen = new Set<number>()
  const out: PickedResidue[] = []
  for (const i of indices) {
    ap.index = i
    const ri = ap.residueIndex
    if (seen.has(ri)) continue
    seen.add(ri)
    rp.index = ri
    ap.index = rp.atomOffset
    out.push({
      chain: ap.chainname || ap.chainid || '',
      resnum: rp.resno,
      resname: rp.resname || '',
    })
  }
  return out
}

/**
 * Expand `within <radius> of <expression>` into an explicit atom-index list.
 *
 * Structural biologists reach for this syntax by reflex — it is what PyMOL,
 * VMD and ChimeraX all use — so rather than rejecting it, resolve it here and
 * hand NGL the answer. Everything else in the string is passed through
 * untouched.
 */
export function expandWithin(structure: any, sele: string): string {
  if (!structure || !/\bwithin\b/i.test(sele)) return sele

  const re = /\bwithin\s+([0-9]*\.?[0-9]+)\s+of\s*/gi
  let out = ''
  let pos = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(sele)) !== null) {
    const radius = parseFloat(m[1])
    const { expr, end } = readExpression(sele, m.index + m[0].length)
    if (!expr) break

    // Nested `within` resolves innermost-first.
    const inner = expandWithin(structure, expr)
    const err = seleError(inner)
    const centre = err
      ? []
      : selectionAtomIndices(structure, inner)
    const near = atomsWithin(structure, centre, radius)

    out += sele.slice(pos, m.index) + indexSele(near)
    pos = end
    re.lastIndex = end
  }

  return out + sele.slice(pos)
}

/** Atom indices matched by an already-validated selection string. */
export function selectionAtomIndices(structure: any, sele: string): number[] {
  const trimmed = (sele || '').trim()
  // Both of these mean "all atoms" to NGL's getAtomSet, which is never what a
  // caller resolving a sub-expression wants to hit by accident.
  if (!trimmed || seleError(trimmed)) return []
  const out: number[] = []
  structure.getAtomSet(new Selection(trimmed))
    .forEach((idx: number) => out.push(idx))
  return out
}

/**
 * Read the expression a `within N of` applies to: either a parenthesised group
 * (with nesting respected) or a single bare token.
 */
function readExpression(s: string, start: number): { expr: string; end: number } {
  let i = start
  while (i < s.length && /\s/.test(s[i])) i++
  if (i >= s.length) return { expr: '', end: s.length }

  if (s[i] === '(') {
    let depth = 0
    for (let j = i; j < s.length; j++) {
      if (s[j] === '(') depth++
      else if (s[j] === ')') {
        depth--
        if (depth === 0) return { expr: s.slice(i + 1, j), end: j + 1 }
      }
    }
    return { expr: s.slice(i + 1), end: s.length }   // unbalanced — take the rest
  }

  let j = i
  while (j < s.length && !/\s/.test(s[j])) j++
  return { expr: s.slice(i, j), end: j }
}

/**
 * An NGL selection covering exactly these residues.
 *
 * Written as compressed ranges per chain (`:A and (12-30 or 45)`) rather than
 * one term per residue. Not for parser safety — NGL happily parses twelve
 * thousand `or` terms in under 10 ms, measured — but because a dragged region
 * of a matrix is usually one contiguous block, and `(120-420)` is a selection
 * you can read and edit by hand where three hundred `or`s is not.
 *
 * Returns '' for an empty input. Callers MUST treat that as "select nothing"
 * and skip the representation entirely: an empty selection parses to no atom
 * test at all, and NGL then falls back to the whole structure — the
 * select-everything trap described at the top of this file.
 */
export function residuesToSele(
  residues: { chain: string; resnum: number }[]
): string {
  if (!residues.length) return ''

  const byChain = new Map<string, number[]>()
  for (const r of residues) {
    const key = r.chain || ''
    const list = byChain.get(key)
    if (list) list.push(r.resnum)
    else byChain.set(key, [r.resnum])
  }

  const parts: string[] = []
  for (const [chain, nums] of byChain) {
    const sorted = [...new Set(nums)].sort((a, b) => a - b)
    const ranges: string[] = []
    let start = sorted[0]
    let prev = sorted[0]
    for (let i = 1; i <= sorted.length; i++) {
      const n = sorted[i]
      if (i < sorted.length && n === prev + 1) { prev = n; continue }
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`)
      start = n
      prev = n
    }
    const body = `(${ranges.join(' or ')})`
    parts.push(chain ? `(:${chain} and ${body})` : body)
  }
  return parts.length === 1 ? parts[0] : parts.join(' or ')
}

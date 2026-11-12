/**
 * Morphing between two snapshots of the same system.
 *
 * ChimeraX's `morph` in the small: take the structure on screen and the
 * structure you want to see, and interpolate between them so the change is
 * something you WATCH rather than something you infer by flicking back and
 * forth between two stills.
 *
 * Two things make this more than a lerp:
 *
 *  1. SUPERPOSITION IS NOT OPTIONAL. Two frames dumped from a trajectory sit
 *     wherever the molecule happened to be in the periodic box at that moment.
 *     Interpolating them directly animates the box translation — the protein
 *     sails across the screen and whatever actually changed inside it is
 *     invisible. The target is least-squares fitted onto the source first, so
 *     what is left to see is the internal motion. This is the same reason DCCM
 *     superposes before correlating.
 *
 *  2. THE ATOMS HAVE TO CORRESPOND. NGL replaces coordinates by position in its
 *     own atom traversal, so the target's coordinates must be reordered into
 *     the source's atom order. Getting that wrong does not fail loudly — it
 *     produces a plausible-looking animation of the wrong thing — so a
 *     correspondence that is not exact is refused rather than approximated.
 *
 * The interpolation itself is linear per atom (with eased timing). It is a
 * VIEWING aid, not a pathway calculation: intermediate frames are not physical
 * and a large motion will pass bonds through each other on the way. ChimeraX's
 * default corkscrew interpolation is prettier for big domain swings; linear is
 * what it degrades to, and for two frames of one trajectory the difference is
 * usually invisible.
 */
import { Superposition } from 'ngl'

/** Coordinates plus enough identity to line two structures up. */
export interface AtomSet {
  n: number
  /** chain:resno:inscode:atomname:altloc, in NGL's own traversal order. */
  keys: string[]
  /** xyz triples, in the SAME order NGL's updatePosition() writes them back. */
  coords: Float32Array
  /** 2 = Cα / C4' / P, 1 = other backbone, 0 = side chain or solvent. */
  fitRank: Uint8Array
}

const CA_LIKE = new Set(['CA', "C4'", 'C4*', 'P'])
const BACKBONE_LIKE = new Set(['N', 'C', 'O', "O3'", "C3'", "O5'", "C5'", 'OP1', 'OP2'])

/**
 * Read an NGL structure into a comparable form.
 *
 * Uses eachAtom with a running counter rather than atom indices, because that
 * is exactly what Structure.updatePosition() does when it writes coordinates
 * back — so an array built here can be handed straight to it.
 */
export function atomSetOf(structure: any): AtomSet {
  const n: number = structure?.atomCount ?? 0
  const keys = new Array<string>(n)
  const coords = new Float32Array(n * 3)
  const fitRank = new Uint8Array(n)

  let i = 0
  structure.eachAtom((ap: any) => {
    if (i >= n) return
    const name = ap.atomname || ''
    keys[i] = `${ap.chainname || ap.chainid || ''}:${ap.resno}:`
            + `${ap.inscode || ''}:${name}:${ap.altloc || ''}`
    coords[i * 3] = ap.x
    coords[i * 3 + 1] = ap.y
    coords[i * 3 + 2] = ap.z
    fitRank[i] = CA_LIKE.has(name) ? 2 : (BACKBONE_LIKE.has(name) ? 1 : 0)
    i++
  })

  // A short read would silently misalign everything after it.
  if (i !== n) return { n: i, keys: keys.slice(0, i), coords: coords.slice(0, i * 3), fitRank: fitRank.slice(0, i) }
  return { n, keys, coords, fitRank }
}

export interface MorphPlan {
  /** Where we start: the source structure's own coordinates. */
  from: Float32Array
  /** Where we end: the target, superposed and reordered into source order. */
  to: Float32Array
  /** Scratch buffer for the interpolated frame; reused every tick. */
  work: Float32Array
  /** How the two were lined up, for the UI to state plainly. */
  nAtoms: number
  nFitAtoms: number
  fitDescription: string
  /** RMSD between the two AFTER fitting — the size of the motion being shown. */
  rmsd: number
  /** The single largest atom displacement, which is what the eye follows. */
  maxShift: number
}

export type MorphResult = MorphPlan | { error: string }

export function isMorphError(r: MorphResult): r is { error: string } {
  return (r as any).error !== undefined
}

/**
 * Work out which atom of `b` corresponds to each atom of `a`.
 *
 * Tries the cheap, overwhelmingly common case first: two frames of the same
 * trajectory have identical topology, so atom k is atom k. Only if that fails
 * does it fall back to matching by identity — and that fallback is itself
 * refused when identities are not unique, which happens for real: PDB residue
 * numbers are four columns wide, so a solvated system with more than 9999
 * residues has waters that genuinely share a (chain, resnum, atom name).
 */
function correspond(a: AtomSet, b: AtomSet): Int32Array | { error: string } {
  if (a.n === 0) return { error: 'The structure on screen has no atoms.' }

  if (a.n === b.n) {
    let identical = true
    for (let i = 0; i < a.n; i++) {
      if (a.keys[i] !== b.keys[i]) { identical = false; break }
    }
    if (identical) {
      const map = new Int32Array(a.n)
      for (let i = 0; i < a.n; i++) map[i] = i
      return map
    }
  }

  const index = new Map<string, number>()
  let duplicates = 0
  for (let i = 0; i < b.n; i++) {
    if (index.has(b.keys[i])) duplicates++
    else index.set(b.keys[i], i)
  }
  if (duplicates > 0) {
    return { error:
      `The two snapshots have the same atoms in a different order, and ${duplicates} `
      + `atom identities are ambiguous (usually solvent, whose residue numbers wrap `
      + `past 9999 in a PDB). Turn solvent off on both snapshots and morph the `
      + `protein instead.` }
  }

  const map = new Int32Array(a.n)
  let missing = 0
  for (let i = 0; i < a.n; i++) {
    const j = index.get(a.keys[i])
    if (j === undefined) { missing++; map[i] = -1 }
    else map[i] = j
  }
  if (missing > 0) {
    return { error:
      `${missing} of ${a.n} atoms have no counterpart in the target `
      + `(${a.n} atoms here, ${b.n} there). Morphing needs the same atoms in both — `
      + `the usual causes are one snapshot including solvent and the other not, or `
      + `the two being different systems.` }
  }
  return map
}

/** Apply a THREE.Matrix4 (column-major) to an xyz array, in place. */
function applyMatrix(coords: Float32Array, e: ArrayLike<number>) {
  for (let i = 0; i < coords.length; i += 3) {
    const x = coords[i], y = coords[i + 1], z = coords[i + 2]
    coords[i]     = e[0] * x + e[4] * y + e[8]  * z + e[12]
    coords[i + 1] = e[1] * x + e[5] * y + e[9]  * z + e[13]
    coords[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]
  }
}

/**
 * Build everything needed to animate `a` into `b`.
 *
 * NGL's Superposition computes the fit matrix correctly from raw Float32Arrays,
 * but its own transform() cannot be used to apply it: on the 4x4 path
 * prepCoords() advances the READ index by four per atom while reading xyz
 * triples, so it takes its coordinates from the wrong offsets. Only the matrix
 * is taken from NGL; applying it is done here, where the stride is ours.
 */
export function planMorph(a: AtomSet, b: AtomSet): MorphResult {
  const map = correspond(a, b)
  if (!(map instanceof Int32Array)) return map

  // Target coordinates, reordered into the source's atom order.
  const to = new Float32Array(a.n * 3)
  for (let i = 0; i < a.n; i++) {
    const j = map[i]
    to[i * 3] = b.coords[j * 3]
    to[i * 3 + 1] = b.coords[j * 3 + 1]
    to[i * 3 + 2] = b.coords[j * 3 + 2]
  }

  // Fit on the most rigid thing available. Cα alone is the right reference for
  // a protein: fitting on everything lets flexible side chains and solvent drag
  // the alignment around, which shows up as the whole structure drifting.
  let rank = 2
  let fitIdx: number[] = []
  for (; rank >= 0; rank--) {
    fitIdx = []
    for (let i = 0; i < a.n; i++) if (a.fitRank[i] >= rank) fitIdx.push(i)
    if (fitIdx.length >= 3) break
  }
  if (fitIdx.length < 3) {
    return { error: 'Fewer than three atoms to fit on — too little to define an orientation.' }
  }
  const fitDescription = rank === 2 ? 'Cα atoms'
    : rank === 1 ? 'backbone atoms' : 'all atoms'

  const refSub = new Float32Array(fitIdx.length * 3)
  const mobSub = new Float32Array(fitIdx.length * 3)
  for (let k = 0; k < fitIdx.length; k++) {
    const i = fitIdx[k]
    refSub[k * 3] = a.coords[i * 3]
    refSub[k * 3 + 1] = a.coords[i * 3 + 1]
    refSub[k * 3 + 2] = a.coords[i * 3 + 2]
    mobSub[k * 3] = to[i * 3]
    mobSub[k * 3 + 1] = to[i * 3 + 1]
    mobSub[k * 3 + 2] = to[i * 3 + 2]
  }

  // Superposition(mobile, reference) yields the matrix taking mobile onto
  // reference — the argument order matters and is not symmetric.
  let elements: ArrayLike<number>
  try {
    const sp: any = new (Superposition as any)(mobSub, refSub)
    elements = sp?.transformationMatrix?.elements
    if (!elements || elements.length !== 16) throw new Error('no matrix')
  } catch {
    return { error: 'Could not superpose the two snapshots onto each other.' }
  }
  for (let k = 0; k < 16; k++) {
    if (!Number.isFinite(elements[k])) {
      return { error: 'Superposing the two snapshots produced an invalid transform '
                    + '(the fit atoms may all lie on a line or a single point).' }
    }
  }
  applyMatrix(to, elements)

  // Report the size of the motion, over the atoms it was fitted on — an RMSD
  // over everything including solvent would be dominated by diffusing water and
  // say nothing about the protein.
  let sum = 0, maxShift = 0
  for (const i of fitIdx) {
    const dx = to[i * 3] - a.coords[i * 3]
    const dy = to[i * 3 + 1] - a.coords[i * 3 + 1]
    const dz = to[i * 3 + 2] - a.coords[i * 3 + 2]
    const d2 = dx * dx + dy * dy + dz * dz
    sum += d2
    if (d2 > maxShift) maxShift = d2
  }

  return {
    from: Float32Array.from(a.coords),
    to,
    work: new Float32Array(a.n * 3),
    nAtoms: a.n,
    nFitAtoms: fitIdx.length,
    fitDescription,
    rmsd: Math.sqrt(sum / fitIdx.length),
    maxShift: Math.sqrt(maxShift),
  }
}

/**
 * Ease in and out.
 *
 * Constant-velocity playback reads as a mechanical slide; easing the ends makes
 * the two endpoints — the structures that actually exist — the parts the eye
 * rests on, and the invented middle the part it passes through.
 */
export function ease(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}

/** Fill `plan.work` with the frame at `t` (0 = source, 1 = target). */
export function frameAt(plan: MorphPlan, t: number): Float32Array {
  const e = ease(t)
  const { from, to, work } = plan
  for (let i = 0; i < work.length; i++) {
    work[i] = from[i] + (to[i] - from[i]) * e
  }
  return work
}

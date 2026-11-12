/**
 * Clicking a molecular surface and getting the atom underneath it.
 *
 * WHY THIS IS NEEDED: NGL DOES NOT PICK SURFACES.
 *
 * Every other representation answers a click — measured in a real Electron
 * window with NGL 2.4.0, a spacefill representation returned an atom for 17 of
 * 17 probes. A molecular surface returned NOTHING for all 25 probes, even
 * after six seconds, while covering 95% of the canvas. So `stage.signals.
 * clicked` fires with no pickingProxy at all and there is no handler fix that
 * can help: the geometry carries no picking ids.
 *
 * (NGL's own code explains why it looks as though it should work. A surface
 * builds an AtomPicker when it has per-vertex atom indices AND is handed the
 * structure — `this.atomindex && t ? new AtomPicker(...) : new SurfacePicker`
 * — and the molecular-surface representation does pass the structure. The
 * picking ids still never reach the rendered buffer, so none of it fires.)
 *
 * THE WAY ROUND IT
 * Cast a ray from the camera through the clicked pixel and intersect the scene
 * geometry with three.js, which needs no picking ids, only triangles. That
 * gives the triangle that was clicked; the two ways of turning that into an
 * atom are below, and the difference between them is the whole point of this
 * module.
 */
import { Matrix4, Raycaster, Vector2, Vector3 } from 'three'

export interface SurfaceHit {
  /** Index into the NGL structure's atom store. */
  atomIndex: number
  /** How far the surface point was from that atom's centre, in Angstrom. */
  distance: number
  /** The clicked point, in the structure's own coordinates. */
  point: { x: number; y: number; z: number }
  /**
   * How the atom was identified — `surface` means the triangle's own atom,
   * `nearest` means the fallback search. Diagnostics only.
   */
  via: 'surface' | 'nearest'
}

/**
 * The per-vertex atom indices of every molecular surface currently drawn.
 *
 * NGL's MolecularSurfaceRepresentation keeps one entry per structure view in
 * `__infoList`, each holding the Surface it built; a Surface carries an
 * `atomindex` array with one entry per vertex, recording which atom generated
 * that piece of the mesh. It is the same quantity the colour scheme uses, so
 * reading it here is what makes picking and painting agree.
 */
function surfaceVertexAtoms(component: any): { vertices: number; atomindex: Int32Array }[] {
  const out: { vertices: number; atomindex: Int32Array }[] = []
  for (const el of component?.reprList || []) {
    const infos = el?.repr?.__infoList
    if (!Array.isArray(infos)) continue
    for (const info of infos) {
      const surface = info?.surface
      const atomindex = surface?.atomindex
      if (!atomindex || !surface?.position) continue
      out.push({ vertices: surface.position.length / 3, atomindex })
    }
  }
  return out
}

/**
 * The atom that GENERATED the clicked triangle, rather than the atom nearest
 * to it.
 *
 * WHY THE DIFFERENCE MATTERS, AND WHY "NEAREST ATOM" IS NOT GOOD ENOUGH
 * A molecular surface is not a union of spheres around atom centres. A
 * solvent-excluded surface has re-entrant patches, swept by the probe rolling
 * between atoms, which bulge AWAY from the atom that owns them; and an atom in
 * a crevice can own a small island of surface that pokes out between two
 * larger neighbours. On such an island the nearest atom centre is one of the
 * neighbours, not the owner.
 *
 * That is visible in the app as a patch of unselected colour surrounded by
 * selected colour which cannot be clicked: the colour comes from the owning
 * atom, the click resolved to a neighbour, so clicking the island selected
 * something already selected and the island never changed colour. Taking the
 * triangle's own atom removes the disagreement by construction — what you
 * click is by definition what is drawn there.
 */
function generatingAtom(
  component: any, hit: any, local: Vector3, atomCount: number,
): number | null {
  const face = hit?.face
  const position = hit?.object?.geometry?.attributes?.position
  if (!face || !position) return null

  // Match the mesh to its Surface by vertex count. NGL builds the mesh buffer
  // straight from surface.position, so the counts are equal; if two surfaces
  // happen to share a count there is no way to tell them apart, and the
  // fallback search is used instead of guessing.
  const matches = surfaceVertexAtoms(component).filter(s => s.vertices === position.count)
  if (matches.length !== 1) return null
  const { atomindex } = matches[0]

  // Triangles at the boundary between two atoms' patches have vertices owned
  // by DIFFERENT atoms — which is precisely where this function earns its
  // keep — so take the vertex nearest the clicked point rather than any one
  // of the three.
  let best = -1
  let bestDist = Infinity
  for (const v of [face.a, face.b, face.c]) {
    if (v == null || v < 0 || v >= position.count) continue
    const d = Math.hypot(
      position.getX(v) - local.x,
      position.getY(v) - local.y,
      position.getZ(v) - local.z,
    )
    if (d < bestDist) { bestDist = d; best = v }
  }
  if (best < 0) return null

  const atom = atomindex[best]
  return atom >= 0 && atom < atomCount ? atom : null
}

/**
 * The atom under a click at canvas pixel (x, y), measured from the TOP-LEFT.
 *
 * `maxDistance` rejects a hit that is nowhere near any atom — a click on a
 * clipping plane or on some other object in the scene — rather than selecting
 * whatever happened to be closest. It bounds the fallback search only: a
 * triangle's own atom is the right answer however far away its centre is,
 * which on a re-entrant patch can be several Angstrom.
 */
export function atomAtCanvasPoint(
  stage: any, component: any, x: number, y: number, maxDistance = 6,
  isVisible?: (index: number) => boolean,
): SurfaceHit | null {
  const structure = component?.structure
  const viewer = stage?.viewer
  if (!structure || !viewer?.camera || !viewer?.scene) return null

  const canvas = viewer.renderer?.domElement
  if (!canvas) return null
  const dpr = window.devicePixelRatio || 1
  const width = canvas.width / dpr
  const height = canvas.height / dpr
  if (!width || !height) return null

  const ndc = new Vector2((x / width) * 2 - 1, -((y / height) * 2 - 1))
  const raycaster = new Raycaster()
  raycaster.setFromCamera(ndc, viewer.camera)

  let hits: any[] = []
  try {
    hits = raycaster.intersectObjects(viewer.scene.children, true)
  } catch {
    return null                       // a buffer mid-rebuild; next click works
  }
  const hit = hits.find(h => h.object?.visible && h.object?.geometry)
  if (!hit) return null

  // The hit arrives in world space; the structure's own coordinates are the
  // mesh's local space, so undo that mesh's transform rather than trying to
  // reproduce NGL's camera and component matrices by hand.
  const local = new Vector3().copy(hit.point)
  try {
    local.applyMatrix4(new Matrix4().copy(hit.object.matrixWorld).invert())
  } catch {
    return null
  }

  const proxy = structure.getAtomProxy()
  const distanceTo = (i: number) => {
    proxy.index = i
    return Math.hypot(proxy.x - local.x, proxy.y - local.y, proxy.z - local.z)
  }

  // FIRST CHOICE: the atom the clicked triangle was built from.
  const owner = generatingAtom(component, hit, local, structure.atomCount)
  if (owner !== null) {
    // No visibility test. An atom that contributed a triangle to the mesh in
    // front of the camera is drawn, by definition — and applying the display
    // filter here would reject the very atoms a surface exists to show, such
    // as a ligand when "show hetero" happens to be off.
    return {
      atomIndex: owner,
      distance: distanceTo(owner),
      point: { x: local.x, y: local.y, z: local.z },
      via: 'surface',
    }
  }

  // FALLBACK: nearest atom. Used for geometry that carries no per-vertex atom
  // indices — a volume isosurface, or a surface NGL built without them.
  const hash = structure.spatialHash
  if (!hash) return null
  let bestIndex = -1
  let bestDist = Infinity
  // Widening shells: the first one that contains anything is enough, and a
  // 3 A query over a large structure is far cheaper than a 12 A one.
  for (const radius of [3, 5, 8, maxDistance]) {
    if (radius > maxDistance) break
    const near = hash.within(local.x, local.y, local.z, radius)
    if (!near?.length) continue
    for (const i of near) {
      // Only atoms that are actually DRAWN may be picked.
      //
      // Without this the search ran over the whole spatial hash — every water,
      // ion and hydrogen in a solvated system, none of which is on screen and
      // none of which contributes a single triangle to the surface. Measured
      // on the real WT vs Y269C system: six clicks at six different points on
      // the protein surface all resolved to TIP3 971, a water molecule, with
      // "show water" switched off. The nearest atom to a point just outside a
      // solvent-excluded surface is very often a solvent molecule sitting in
      // the first hydration shell, so this was not an edge case; it was the
      // normal outcome.
      if (isVisible && !isVisible(i)) continue
      const d = distanceTo(i)
      if (d < bestDist) { bestDist = d; bestIndex = i }
    }
    if (bestIndex >= 0) break
  }
  if (bestIndex < 0 || bestDist > maxDistance) return null
  return {
    atomIndex: bestIndex,
    distance: bestDist,
    point: { x: local.x, y: local.y, z: local.z },
    via: 'nearest',
  }
}

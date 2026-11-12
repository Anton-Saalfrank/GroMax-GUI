'use strict'
/**
 * Does clicking a molecular surface find an atom?
 *
 * Runs a real Electron window with real WebGL, because this question cannot be
 * answered any other way: NGL's picking is a render pass that reads pixels, so
 * it needs a GPU context, and the behaviour differs per representation.
 *
 * Two things are pinned:
 *   1. NGL still does not pick surfaces (if that ever changes, this test says
 *      so rather than failing — the fallback stays harmless either way).
 *   2. Our ray cast does find the atom under a surface, and lands within a
 *      sensible distance of it.
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.on('ready', async () => {
  const win = new BrowserWindow({
    width: 700, height: 700, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  await win.loadFile(path.join(__dirname, 'page.html'))
  const deadline = Date.now() + 60000
  let res = null
  while (Date.now() < deadline) {
    res = await win.webContents
      .executeJavaScript('window.__result || null').catch(() => null)
    if (res) break
    await new Promise(r => setTimeout(r, 400))
  }

  let fails = 0
  const check = (name, ok, detail) => {
    if (!ok) fails++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  }

  if (!res || res.error) {
    console.log('  FAIL  the test page ran  — ' + (res ? res.error : 'no result in 60 s'))
    console.log('\n1 FAILED')
    app.exit(1)
    return
  }

  console.log('1. the control: a representation NGL does pick')
  check('spacefill answers clicks with an atom', res.spacefill.withAtom > 0,
        `${res.spacefill.withAtom} of ${res.spacefill.probes} probes`)

  console.log('\n2. a molecular surface is drawn but not pickable')
  check('the surface really is on screen', res.surface.drawn > 0.3,
        `${(res.surface.drawn * 100).toFixed(0)}% of the canvas`)
  if (res.surface.nglPicks === 0) {
    console.log(`  note  NGL ${res.ngl} returns no pick at all for a surface `
      + `(0 of ${res.surface.probes} probes) — the ray cast below is what makes `
      + `surface clicks work`)
  } else {
    console.log(`  note  NGL ${res.ngl} now returns picks for surfaces `
      + `(${res.surface.nglPicks} of ${res.surface.probes}); the ray cast is `
      + `then only a fallback and could be revisited`)
  }

  console.log('\n3. the ray cast finds the atom under the surface')
  check('most probes that hit the mesh resolve to an atom',
        res.surface.rayHits > res.surface.probes * 0.3,
        `${res.surface.rayHits} of ${res.surface.probes} probes`)
  // A solvent-excluded surface sits a probe radius (1.4 A) plus a van der
  // Waals radius (~1.5 A) from the atom centres, so ~3 A is right and 6 A
  // would mean the ray or the transform is wrong.
  check('the atom is a sensible distance from the surface point',
        res.surface.maxDist <= 6,
        `median ${res.surface.medianDist} A, max ${res.surface.maxDist} A`)
  check('and the hits name real atoms', !!res.surface.sample,
        res.surface.sample ? `${res.surface.sample.res} ${res.surface.sample.atom}` : '')

  console.log('\n4. a click resolves to the atom the surface is COLOURED by')
  // A surface vertex takes its colour from the atom that generated it. Picking
  // the nearest atom CENTRE instead is a different answer: on a re-entrant
  // patch, or on an island of surface poking out between two larger
  // neighbours, the nearest centre belongs to a neighbour. Measured on the
  // real 403-residue system, that was 31% of vertices, and it left 20% of the
  // atoms impossible to click at all — their patch stayed unselected wherever
  // it was clicked, which is the "part of the surface I cannot select" this
  // section exists to prevent coming back.
  //
  // The fix reads Surface.atomindex, which is NGL internals. If an upgrade
  // moves or drops it the app silently falls back to nearest-atom and the bug
  // returns with nothing failing — so the contract is pinned here.
  const ix = res.surface.atomIndex
  check('NGL still exposes per-vertex atom indices where the app looks', !!ix,
        ix ? '' : 'repr.__infoList[].surface.atomindex is gone — picking has ' +
                  'silently fallen back to nearest-atom')
  if (ix) {
    check('one atom index per surface vertex', ix.len === ix.verts,
          `${ix.len} indices for ${ix.verts} vertices`)
    check('the rendered mesh has that same vertex count', ix.meshMatches,
          `${ix.verts} vertices`)
    check('every index names a real atom', ix.outOfRange === 0,
          `${ix.outOfRange} out of range`)
  }
  check('and every surface hit went through that route, not the fallback',
        res.surface.rayHits > 0 && res.surface.viaSurface === res.surface.rayHits,
        `${res.surface.viaSurface} of ${res.surface.rayHits} hits`)
  // Informational: on a 6-residue peptide the two rules mostly agree. The
  // number is printed rather than asserted because it is a property of the
  // geometry, not of the code.
  console.log(`  note  the old nearest-atom rule would have picked a different `
    + `atom at ${res.surface.disagree} of ${res.surface.rayHits} of these probes`)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
  app.exit(fails ? 1 : 0)
})

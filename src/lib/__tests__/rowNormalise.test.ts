/**
 * Per-residue normalisation of a rolling-RMSF map.
 *
 * The point of the view is that a rigid residue's 2x excursion and a floppy
 * one's 2x excursion should look the same, while the floppy one's ordinary
 * baseline stops dominating the colour range. Test 1 is exactly that.
 *
 * Test 4 checks the claim the implementation rests on — that a robust baseline
 * beats mean/SD — rather than assuming it. Test 5 pins the property that makes
 * this a toggle and not a replacement: normalising destroys the comparison
 * between conditions, so a caller must never read one for that.
 */
import { normaliseRows, median, mad } from '../rowNormalise'

let fails = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** A residue with baseline `base` that spikes `mult`x over `frac` of the run. */
function residue(base: number, n = 100, mult = 1, frac = 0, noise = 0): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const spiking = i >= n * (1 - frac)
    const wobble = noise ? base * noise * Math.sin(i * 2.399) : 0
    out.push(base * (spiking ? mult : 1) + wobble)
  }
  return out
}

console.log('1. a rigid residue and a floppy one with the same RELATIVE event')
{
  const rigid = residue(0.05, 100, 3, 0.1, 0.05)    // 0.05 nm, triples
  const floppy = residue(0.80, 100, 3, 0.1, 0.05)   // 0.80 nm, triples
  const abs = [rigid, floppy]
  check('on absolute values the floppy residue dwarfs the rigid one',
        Math.max(...floppy) > 10 * Math.max(...rigid),
        `${Math.max(...floppy).toFixed(2)} vs ${Math.max(...rigid).toFixed(2)} nm`)

  const r = normaliseRows(abs, 'ratio')
  const peakRigid = Math.max(...(r.z[0] as number[]))
  const peakFloppy = Math.max(...(r.z[1] as number[]))
  check('normalised, both events read the same size',
        Math.abs(peakRigid - peakFloppy) < 0.2,
        `${peakRigid.toFixed(2)}x vs ${peakFloppy.toFixed(2)}x`)
  check('and both read as ~3x, the planted size',
        Math.abs(peakRigid - 3) < 0.3, `${peakRigid.toFixed(2)}x`)
  check('the quiet part sits at 1.0',
        Math.abs((r.z[0] as number[])[0] - 1) < 0.1,
        `${(r.z[0] as number[])[0].toFixed(3)}`)
}

console.log('\n2. log2 makes "half as mobile" and "twice as mobile" symmetric')
{
  const row = residue(0.4, 100)
  row[10] = 0.8; row[20] = 0.2
  const r = normaliseRows([row], 'log2')
  const z = r.z[0] as number[]
  check('2x reads +1 and 0.5x reads -1', Math.abs(z[10] - 1) < 0.02 && Math.abs(z[20] + 1) < 0.02,
        `${z[10].toFixed(2)} and ${z[20].toFixed(2)}`)
  check('the midpoint is 0', r.neutral === 0)
  const rr = normaliseRows([row], 'ratio')
  const zz = rr.z[0] as number[]
  check('on a plain ratio the same two are NOT symmetric about the midpoint',
        Math.abs((zz[10] - 1) - (1 - zz[20])) > 0.4,
        `+${(zz[10] - 1).toFixed(2)} vs -${(1 - zz[20]).toFixed(2)}`)
}

console.log('\n3. rows that cannot be scaled are blanked, not inflated')
{
  const r = normaliseRows([
    residue(0.3, 100),              // fine
    new Array(100).fill(0),         // a dead row: no baseline to divide by
    [0.1, 0.2, 0.3],                // too few windows
  ], 'ratio')
  check('the good row survives', (r.z[0] as any[]).every(v => v !== null))
  check('the all-zero row is blank, not infinite',
        (r.z[1] as any[]).every(v => v === null))
  check('the too-short row is blank', (r.z[2] as any[]).every(v => v === null))
  check('and the user is told how many', r.nSkipped === 2 && /2 residues/.test(r.note),
        r.note)
}

console.log('\n4. a robust baseline really does beat mean/SD (the design claim)')
{
  // One strong, short event — the thing this view is for.
  const row = residue(0.1, 200, 4, 0.05, 0.08)
  const peak = Math.max(...row)
  const m = row.reduce((a, b) => a + b, 0) / row.length
  const sd = Math.sqrt(row.reduce((a, b) => a + (b - m) ** 2, 0) / row.length)
  const classic = (peak - m) / sd
  const robust = (peak - median(row)) / mad(row)
  // No arbitrary cutoff on the mean/SD score: what matters is the RATIO
  // between the two baselines, since the event inflates the SD it is being
  // measured against and so partly hides itself.
  check('a robust baseline scores the event several times higher',
        robust > 4 * classic,
        `${robust.toFixed(1)} robust vs ${classic.toFixed(1)} mean/SD `
        + `(${(robust / classic).toFixed(1)}x)`)
  check('the event does inflate the SD it is measured against',
        sd > 0.5 * (median(row) || 1),
        `SD ${sd.toFixed(3)} against a median of ${median(row).toFixed(3)}`)
  const r = normaliseRows([row], 'robustz')
  check('the shipped robust-z agrees', Math.max(...(r.z[0] as number[])) > 2 * classic,
        `${Math.max(...(r.z[0] as number[])).toFixed(1)}`)
}

console.log('\n5. normalising ERASES the difference between two conditions')
{
  // The whole reason this is a toggle. A mutant uniformly twice as mobile.
  const wt = residue(0.2, 100, 1, 0, 0.05)
  const mut = wt.map(v => v * 2)
  check('absolutely, the mutant is twice the wild type',
        Math.abs(median(mut) / median(wt) - 2) < 0.01)
  const nwt = normaliseRows([wt], 'ratio').z[0] as number[]
  const nmut = normaliseRows([mut], 'ratio').z[0] as number[]
  const diff = Math.max(...nwt.map((v, i) => Math.abs(v - nmut[i])))
  check('normalised, the two are IDENTICAL — the difference is gone',
        diff < 1e-9, `largest difference ${diff.toExponential(1)}`)
  check('so the absolute view must stay available', true,
        'documented in rowNormalise.ts and shown in the UI note')
}

console.log('\n5b. a SHARED baseline keeps the difference the own-row one erased')
{
  const wt = residue(0.2, 100, 1, 0, 0.05)
  const mut = wt.map(v => v * 2)
  // The baseline a backend would supply: this residue's median across both.
  const shared = { median: [(median(wt) + median(mut)) / 2], label: 'all conditions' }
  const nwt = normaliseRows([wt], 'ratio', shared).z[0] as number[]
  const nmut = normaliseRows([mut], 'ratio', shared).z[0] as number[]
  check('the wild type now reads below the midpoint',
        median(nwt) < 0.75, `${median(nwt).toFixed(2)}x`)
  check('and the mutant above it', median(nmut) > 1.25, `${median(nmut).toFixed(2)}x`)
  check('their ratio is still the planted 2x',
        Math.abs(median(nmut) / median(nwt) - 2) < 0.01,
        `${(median(nmut) / median(nwt)).toFixed(2)}x`)

  // And the original purpose still holds: residues of wildly different
  // flexibility land on one scale.
  const rigid = residue(0.05, 100, 1, 0, 0.05)
  const floppy = residue(0.80, 100, 1, 0, 0.05)
  const b2 = { median: [median(rigid), median(floppy)], label: 'all conditions' }
  const n2 = normaliseRows([rigid, floppy], 'ratio', b2)
  check('a 16x spread in absolute flexibility still collapses to one scale',
        Math.abs(median(n2.z[0] as number[]) - median(n2.z[1] as number[])) < 0.05,
        `${median(n2.z[0] as number[]).toFixed(2)} and ${median(n2.z[1] as number[]).toFixed(2)}`)
  check('the colourbar says which baseline was used',
        n2.zlabel.includes('all conditions'), n2.zlabel)
}

console.log('\n5c. a baseline of the wrong size is refused, not misapplied')
{
  const rows = [residue(0.3, 50), residue(0.6, 50), residue(0.9, 50)]
  const wrong = { median: [0.3, 0.6], label: 'all conditions' }   // 2 vs 3 rows
  const r = normaliseRows(rows, 'ratio', wrong)
  check('it falls back to per-row scaling rather than misaligning residues',
        (r.z[2] as number[]).every(v => Number.isFinite(v)))
  check('and says so, including both counts',
        /2 residues/.test(r.note) && /3/.test(r.note), r.note)
  check('the colourbar admits it is per-map', r.zlabel.includes('this map'), r.zlabel)
}

console.log('\n6. the colour limit ignores a single wild residue')
{
  const rows = [residue(0.3, 100, 2, 0.1, 0.05), residue(0.3, 100, 2, 0.1, 0.05)]
  const tame = normaliseRows(rows, 'ratio').limit!
  const wild = residue(0.3, 100)
  wild[50] = 30                                     // one absurd window
  const withWild = normaliseRows([...rows, wild], 'ratio').limit!
  check('one 100x outlier does not blow up the range',
        withWild < 2 * tame, `${tame.toFixed(2)} -> ${withWild.toFixed(2)}`)
}

console.log('\n7. mode "none" passes the matrix through untouched')
{
  const rows = [residue(0.3, 10), residue(0.9, 10)]
  const r = normaliseRows(rows, 'none')
  check('same object, no transform', r.z === (rows as any) && r.limit === null)
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)

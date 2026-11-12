/**
 * A filter is a frame mask. These check the mask, and the four readings of it.
 *
 * Every expected value here is counted or arithmetic done by hand in the
 * comment beside it, never a second call into the module. The two tests that
 * matter most are not about arithmetic at all:
 *
 *   - section 3, which refuses to align metrics sampled differently. Getting
 *     this wrong produces a plausible number computed over the wrong frames,
 *     which is the one kind of bug a figure cannot reveal.
 *   - section 5b, which pins a conditional mean over zero passing frames as
 *     `null` rather than 0, because averaging "it never happened" in as zero
 *     drags a condition's bar toward the floor in proportion to how often the
 *     event failed to occur.
 */
import {
  passes, rawMask, openRuns, frameMask, alignFrames, evaluateReplica,
  gate, passIntervals, gatedMean, describeFilter,
} from '../plotFilter'
import type { FilterDef } from '../plotSeries'

let fails = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol

/** Ten frames, chosen so the counts below are obvious by eye. */
const YS = [0.5, 1.5, 2.5, 0.2, 3.0, 0.1, 0.9, 0.4, 0.8, 0.3]
const XS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
const TARGET = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

const mkFilter = (p: Partial<FilterDef> = {}): FilterDef => ({
  id: 'f1', name: 'test', metric: 'mindist', op: '>', threshold: 1,
  output: 'fraction', ...p,
})

console.log('1. the threshold, frame by frame')
{
  // > 1.0  passes at 1.5, 2.5, 3.0  →  indices 1, 2, 4  →  3 of 10
  const m = rawMask(YS, '>', 1.0)
  check('> keeps strictly greater', m.filter(Boolean).length === 3,
        m.map(v => v ? '1' : '0').join(''))
  check('and at the right frames', m.join(',') ===
        [false,true,true,false,true,false,false,false,false,false].join(','))

  // < 0.5  passes at 0.2, 0.1, 0.4, 0.3  →  4.  The 0.5 at index 0 does NOT.
  check('< is strict at the boundary', rawMask(YS, '<', 0.5).filter(Boolean).length === 4)
  // >= 0.5 passes at 0.5, 1.5, 2.5, 3.0, 0.9, 0.8  →  6
  check('>= includes the boundary', rawMask(YS, '>=', 0.5).filter(Boolean).length === 6)
  // <= 0.5 passes at 0.5, 0.2, 0.1, 0.4, 0.3  →  5
  check('<= includes the boundary', rawMask(YS, '<=', 0.5).filter(Boolean).length === 5)

  // A frame with no value did not pass a test; it was never tested. Treating
  // NaN as passing would silently count dropped frames as events.
  check('NaN never passes, whatever the comparison',
        !passes(NaN, '>', 0) && !passes(NaN, '<', 0)
        && !passes(NaN, '>=', 0) && !passes(NaN, '<=', 0))
}

console.log('\n2. debouncing: runs shorter than minRun are dropped')
{
  //            0 1 2 3 4 5 6 7 8 9
  const m =    [1,0,1,1,0,1,1,1,0,1].map(Boolean)
  // runs: [0]=1 frame, [2,3]=2, [5,6,7]=3, [9]=1
  check('minRun 1 changes nothing', openRuns(m, 1).join(',') === m.join(','))
  check('minRun 2 drops the two single frames',
        openRuns(m, 2).map(v => v ? '1' : '0').join('') === '0011011100',
        openRuns(m, 2).map(v => v ? '1' : '0').join(''))
  check('minRun 3 leaves only the three-frame run',
        openRuns(m, 3).map(v => v ? '1' : '0').join('') === '0000011100',
        openRuns(m, 3).map(v => v ? '1' : '0').join(''))
  // The run that touches the end of the array is the one an off-by-one loses.
  check('a run ending at the last frame is kept when long enough',
        openRuns([false,false,true,true].map(Boolean), 2).join(',') === 'false,false,true,true')
  check('frameMask applies the threshold then the debounce',
        frameMask(YS, mkFilter({ op: '>', threshold: 1, minRun: 2 }))
          .map(v => v ? '1' : '0').join('') === '0110000000',
        frameMask(YS, mkFilter({ op: '>', threshold: 1, minRun: 2 }))
          .map(v => v ? '1' : '0').join(''))
}

console.log('\n3. alignment is refused, not fudged')
{
  const a = { index: 1, x: XS, y: YS }

  const same = alignFrames(a, { index: 1, x: XS, y: TARGET })
  check('identical sampling aligns over all frames',
        same.n === 10 && !same.problem && !same.note, `n=${same.n}`)

  // Same number of frames, double the stride: index 5 is 0.5 ns in one series
  // and 1.0 ns in the other. Lengths alone cannot catch this.
  const coarse = XS.map(v => v * 2)
  const stride = alignFrames(a, { index: 1, x: coarse, y: TARGET }, 'cavity', 'rmsd')
  check('a different stride is refused', stride.n === 0 && !!stride.problem)
  check('and names BOTH intervals, not just that they differ',
        /0\.1/.test(stride.problem || '') && /0\.2/.test(stride.problem || ''),
        stride.problem || '')

  // Same stride, but starting 1 ns later: frame 0 is not frame 0.
  const shifted = XS.map(v => v + 1)
  const win = alignFrames(a, { index: 1, x: shifted, y: TARGET }, 'cavity', 'rmsd')
  check('a different time window is refused', win.n === 0 && !!win.problem)
  check('and says where each one starts',
        /1\.0/.test(win.problem || '') && /\b0\b|0\.000/.test(win.problem || ''),
        win.problem || '')

  // Same sampling, one run simply shorter. That IS alignable, frame for frame.
  const short = alignFrames(a, { index: 1, x: XS.slice(0, 8), y: TARGET.slice(0, 8) },
                            'cavity', 'rmsd')
  check('a shorter run aligns over the overlap', short.n === 8 && !short.problem,
        `n=${short.n}`)
  check('and the truncation is stated rather than silent',
        /10/.test(short.note || '') && /8/.test(short.note || ''), short.note || '')

  // No time axis: frame count is the only evidence, so unequal counts are
  // not something to guess at.
  const blind = alignFrames({ index: 1, y: YS }, { index: 1, y: TARGET.slice(0, 8) })
  check('without a time axis, unequal lengths are refused',
        blind.n === 0 && !!blind.problem, blind.problem || '')
  check('and equal lengths are accepted',
        alignFrames({ index: 1, y: YS }, { index: 1, y: TARGET }).n === 10)
}

console.log('\n4. fraction: counted by hand')
{
  const r = evaluateReplica(mkFilter({ op: '>', threshold: 1 }), { index: 1, x: XS, y: YS })
  // 3 of 10 frames pass → 0.3, exactly.
  check('3 passing frames out of 10 is 0.3', near(r.value!, 0.3), String(r.value))
  check('and the counts come back', r.nPass === 3 && r.nTotal === 10,
        `${r.nPass}/${r.nTotal}`)

  const none = evaluateReplica(mkFilter({ op: '>', threshold: 99 }), { index: 1, y: YS })
  // A fraction of zero IS a measurement: the event was looked for and not found.
  check('a fraction of 0 is 0, not null', none.value === 0, String(none.value))
}

console.log('\n5. conditional mean')
{
  const f = mkFilter({ op: '>', threshold: 1, output: 'conditional_mean',
                       targetMetric: 'rmsd' })
  const r = evaluateReplica(f, { index: 1, x: XS, y: YS }, { index: 1, x: XS, y: TARGET })
  // passing frames are 1, 2, 4 → target values 20, 30, 50 → (20+30+50)/3 = 100/3
  check('averages the target over exactly the passing frames',
        near(r.value!, 100 / 3, 1e-12), String(r.value))

  console.log('  5b. zero passing frames is an absence, not a zero')
  const empty = evaluateReplica({ ...f, threshold: 99 },
                                { index: 1, x: XS, y: YS }, { index: 1, x: XS, y: TARGET })
  check('a conditional mean over no frames is null', empty.value === null, String(empty.value))
  check('and says so', /passed no frames/.test(empty.problem || ''), empty.problem || '')

  console.log('  5c. misaligned metrics do not produce a number')
  const bad = evaluateReplica(f, { index: 1, x: XS, y: YS },
                              { index: 1, x: XS.map(v => v * 2), y: TARGET })
  check('a stride mismatch yields null, not a plausible average',
        bad.value === null && !!bad.problem, bad.problem || '')

  const missing = evaluateReplica(f, { index: 1, x: XS, y: YS })
  check('a missing target replica yields null', missing.value === null)
}

console.log('\n6. gating a time series keeps the time axis')
{
  const mask = rawMask(YS, '>', 1)                 // frames 1, 2, 4
  const g = gate(TARGET, mask)
  check('the array keeps its length, so x still lines up', g.length === TARGET.length,
        String(g.length))
  check('passing frames keep their value',
        g[1] === 20 && g[2] === 30 && g[4] === 50)
  check('failing frames become null (a GAP), not a dropped element',
        g[0] === null && g[3] === null && g[9] === null)
  check('nothing was deleted: the count of non-null equals the count of passes',
        g.filter(v => v !== null).length === 3)
}

console.log('\n7. passing stretches, for shading')
{
  const mask = rawMask(YS, '>', 1)                 // runs [1,2] and [4,4]
  const iv = passIntervals(XS, mask)
  // dt = 0.1, so half a frame is 0.05.
  // run 1..2  →  0.10-0.05  to  0.20+0.05  =  0.05 .. 0.25
  // run 4..4  →  0.40-0.05  to  0.40+0.05  =  0.35 .. 0.45
  check('two stretches', iv.length === 2, JSON.stringify(iv))
  check('the first spans the run plus half a frame each side',
        near(iv[0][0], 0.05, 1e-9) && near(iv[0][1], 0.25, 1e-9), JSON.stringify(iv[0]))
  check('a SINGLE passing frame is one frame wide, not zero',
        near(iv[1][1] - iv[1][0], 0.1, 1e-9), String(iv[1][1] - iv[1][0]))
  check('no mask means no shading', passIntervals(XS, YS.map(() => false)).length === 0)
}

console.log('\n8. gated mean: the number of contributing runs changes along x')
{
  const items = [
    { y: [1, 2, 3, 4], mask: [true,  true,  false, false] },
    { y: [3, 4, 5, 6], mask: [true,  false, true,  false] },
    { y: [5, 6, 7, 8], mask: [false, false, true,  false] },
  ]
  const g = gatedMean(items, 2)
  check('n is reported per time point', g.n.join(',') === '2,1,2,0', g.n.join(','))
  // i0: values 1 and 3 → mean 2, sample SD = sqrt(((1-2)^2+(3-2)^2)/1) = sqrt(2)
  check('the mean uses only the replicas passing AT THAT FRAME',
        near(g.mean[0] as number, 2), String(g.mean[0]))
  check('and the SD is the sample SD over those same replicas',
        near(g.sd[0] as number, Math.SQRT2, 1e-12), String(g.sd[0]))
  // i2: values 5 and 7 → mean 6. A different pair of runs than i0.
  check('a later point can rest on a different pair of runs',
        near(g.mean[2] as number, 6), String(g.mean[2]))
  check('below minN the point is null, so the line breaks instead of '
        + 'following one run', g.mean[1] === null && g.sd[1] === null)
  check('and a point no run passes is null too', g.mean[3] === null)
  check('with minN 1 the single-run point comes back, with zero SD',
        gatedMean(items, 1).mean[1] === 2 && gatedMean(items, 1).sd[1] === 0,
        String(gatedMean(items, 1).mean[1]))
}

console.log('\n9. a filter reads as a sentence')
{
  check('a fraction filter',
        describeFilter(mkFilter({ metric: 'cavity', op: '>', threshold: 20 }))
          === 'fraction of frames where cavity > 20',
        describeFilter(mkFilter({ metric: 'cavity', op: '>', threshold: 20 })))
  check('a conditional mean names both metrics',
        describeFilter(mkFilter({ metric: 'cavity', op: '>=', threshold: 20,
                                  output: 'conditional_mean', targetMetric: 'sasa' }))
          === 'mean sasa over frames where cavity ≥ 20')
  check('the debounce is spelled out when it is on',
        /3\+ frames in a row/.test(
          describeFilter(mkFilter({ metric: 'cavity', minRun: 3 }))))
  check('and is invisible when it is off',
        !/in a row/.test(describeFilter(mkFilter({ metric: 'cavity', minRun: 1 }))))
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)

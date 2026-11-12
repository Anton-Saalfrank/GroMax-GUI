/**
 * Grouping the Structure tab's snapshot list.
 *
 * The list arrives in the order moments were pulled out of plots. Test 1 is
 * the property that matters: whatever that order was, the view comes out by
 * condition, then replica, then time.
 *
 * Tests 4 and 5 are the ones that stop this quietly losing work — a snapshot
 * whose condition is no longer in the project must still appear, and the input
 * array must come back untouched, because it is the list the session saves.
 */
import { groupSnapshots, shortTime } from '../snapshotGroups'

let fails = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

let seq = 0
const f = (cond: string, rep: number, t: number) => ({
  id: `f${seq++}`, conditionId: cond,
  conditionName: cond === 'c1' ? 'WT' : cond === 'c2' ? 'Y269C' : cond,
  replicaIndex: rep, timeNs: t,
})

/** "WT/1: 10, 20 | WT/6: 5" — the whole shape on one line. */
const shape = (groups: ReturnType<typeof groupSnapshots>) =>
  groups.map(g => g.replicas.map(r =>
    `${g.conditionName}/${r.replicaIndex}: ${r.frames.map(x => x.timeNs).join(', ')}`
  ).join(' | ')).join(' || ')

console.log('1. the order a train of thought produced becomes the order of the data')
// Deliberately scrambled: two conditions interleaved, replicas out of order,
// times out of order within a replica. This is what the panel actually held.
const messy = [
  f('c2', 6, 2400), f('c1', 1, 997.5), f('c2', 4, 1717.5), f('c1', 1, 399),
  f('c2', 6, 240), f('c1', 7, 223), f('c2', 4, 2.5), f('c1', 1, 595),
]
const grouped = groupSnapshots(messy, ['c1', 'c2'])
check('every condition becomes one group', grouped.length === 2,
      grouped.map(g => g.conditionName).join(', '))
check('the project\'s condition order is kept, not alphabetical',
      grouped[0].conditionName === 'WT' && grouped[1].conditionName === 'Y269C',
      grouped.map(g => g.conditionName).join(' then '))
check('replicas come out ascending',
      grouped[0].replicas.map(r => r.replicaIndex).join() === '1,7',
      grouped[0].replicas.map(r => r.replicaIndex).join())
check('and times ascend within each replica',
      shape(grouped) === 'WT/1: 399, 595, 997.5 | WT/7: 223 || '
                       + 'Y269C/4: 2.5, 1717.5 | Y269C/6: 240, 2400',
      shape(grouped))
check('nothing is lost on the way',
      grouped.reduce((n, g) => n + g.total, 0) === messy.length,
      `${grouped.reduce((n, g) => n + g.total, 0)} of ${messy.length}`)
check('the per-condition count is the number of its snapshots',
      grouped[0].total === 4 && grouped[1].total === 4,
      `${grouped[0].total} / ${grouped[1].total}`)

console.log('\n2. an already-ordered list is unchanged')
const tidy = [f('c1', 1, 10), f('c1', 1, 20), f('c1', 2, 5)]
check('grouping is idempotent in shape',
      shape(groupSnapshots(tidy, ['c1'])) === 'WT/1: 10, 20 | WT/2: 5',
      shape(groupSnapshots(tidy, ['c1'])))

console.log('\n3. the empty case')
check('no snapshots gives no groups', groupSnapshots([], ['c1']).length === 0)

console.log('\n4. a snapshot whose condition is gone is still shown')
// A condition removed from the project must not silently delete the moments
// found in it — they are the user's work, and the list is what a session saves.
const orphan = [f('c1', 1, 10), f('gone', 3, 50), f('c2', 2, 20)]
const withOrphan = groupSnapshots(orphan, ['c1', 'c2'])
check('it survives grouping', withOrphan.length === 3,
      withOrphan.map(g => g.conditionId).join(', '))
check('and sorts after the conditions the project knows about',
      withOrphan.map(g => g.conditionId).join() === 'c1,c2,gone',
      withOrphan.map(g => g.conditionId).join())
check('with no condition order at all, first-seen order is kept',
      groupSnapshots(orphan).map(g => g.conditionId).join() === 'c1,gone,c2',
      groupSnapshots(orphan).map(g => g.conditionId).join())

console.log('\n5. the stored list is not touched')
const original = [f('c2', 2, 30), f('c1', 1, 10)]
const before = original.map(x => x.id).join()
const ids = new Set(original.map(x => x.id))
const out = groupSnapshots(original, ['c1', 'c2'])
check('the input array keeps its order', original.map(x => x.id).join() === before,
      original.map(x => x.id).join())
check('and the groups hold the very same objects, not copies',
      out.every(g => g.replicas.every(r => r.frames.every(x => ids.has(x.id))))
      && out[0].replicas[0].frames[0] === original[1])

console.log('\n6. ties cannot reorder between renders')
// frameIdentity() should make the same moment one snapshot, so this should not
// arise — but an unstable sort on a list rebuilt every render would flicker.
const tied = [
  { id: 'zz', conditionId: 'c1', conditionName: 'WT', replicaIndex: 1, timeNs: 5 },
  { id: 'aa', conditionId: 'c1', conditionName: 'WT', replicaIndex: 1, timeNs: 5 },
]
check('equal times break by id, the same way every time',
      groupSnapshots(tied, ['c1'])[0].replicas[0].frames.map(x => x.id).join() === 'aa,zz',
      groupSnapshots(tied, ['c1'])[0].replicas[0].frames.map(x => x.id).join())

console.log('\n7. the time a chip shows')
check('trailing zeros go', shortTime(997.5) === '997.5', shortTime(997.5))
check('a whole number loses its point', shortTime(240) === '240', shortTime(240))
check('zero is still zero', shortTime(0) === '0', shortTime(0))
check('two decimals are kept where they carry something',
      shortTime(2.25) === '2.25', shortTime(2.25))
check('and a rounded value does not become empty',
      shortTime(0.001) === '0', shortTime(0.001))
check('a non-number is not rendered as NaN', shortTime(NaN) === '—', shortTime(NaN))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)

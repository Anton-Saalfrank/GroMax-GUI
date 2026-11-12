/**
 * Putting the snapshot list in an order a person can read.
 *
 * Snapshots accumulate in the order they were pulled out of plots, which is
 * the order of a train of thought and not the order of anything in the data.
 * A hundred of them in one wrapped row is a wall: the same replica's moments
 * are scattered through it, two conditions are interleaved, and finding "the
 * other one I looked at in rep 6" means reading every chip.
 *
 * So they are grouped by condition, then by replica, then sorted by time. Each
 * chip then only has to carry its time, because the row it sits in already
 * says which condition and replica it belongs to.
 *
 * Nothing here mutates or reorders the stored list. The store's order is what
 * a session saves and restores, and an id is what everything else refers to;
 * this is a view of it.
 */

export interface GroupableFrame {
  id: string
  conditionId: string
  conditionName: string
  replicaIndex: number
  timeNs: number
}

export interface ReplicaGroup<T> {
  replicaIndex: number
  frames: T[]
}

export interface ConditionGroup<T> {
  conditionId: string
  conditionName: string
  /** Every snapshot in this condition, for a count on the header. */
  total: number
  replicas: ReplicaGroup<T>[]
}

/**
 * Snapshots grouped by condition and replica, each replica's frames sorted by
 * time.
 *
 * `conditionOrder` is the project's own condition order — WT before its mutant
 * because that is how the project was set up, not because "W" sorts after "Y".
 * Conditions missing from it (a snapshot whose condition has since been
 * removed) keep their first-seen order and come last, so nothing is dropped
 * from the list just because it no longer matches the project.
 */
export function groupSnapshots<T extends GroupableFrame>(
  frames: readonly T[], conditionOrder: readonly string[] = [],
): ConditionGroup<T>[] {
  const byCondition = new Map<string, ConditionGroup<T>>()
  const firstSeen = new Map<string, number>()

  for (const f of frames) {
    let group = byCondition.get(f.conditionId)
    if (!group) {
      group = {
        conditionId: f.conditionId,
        conditionName: f.conditionName,
        total: 0,
        replicas: [],
      }
      byCondition.set(f.conditionId, group)
      firstSeen.set(f.conditionId, firstSeen.size)
    }
    group.total++
    let replica = group.replicas.find(r => r.replicaIndex === f.replicaIndex)
    if (!replica) {
      replica = { replicaIndex: f.replicaIndex, frames: [] }
      group.replicas.push(replica)
    }
    replica.frames.push(f)
  }

  const rank = new Map(conditionOrder.map((id, i) => [id, i]))
  const place = (id: string) =>
    rank.has(id) ? rank.get(id)! : conditionOrder.length + (firstSeen.get(id) ?? 0)

  const out = [...byCondition.values()]
  out.sort((a, b) => place(a.conditionId) - place(b.conditionId))
  for (const group of out) {
    group.replicas.sort((a, b) => a.replicaIndex - b.replicaIndex)
    for (const replica of group.replicas) {
      // By time, then by id, so two snapshots at the same time never swap
      // places between renders. They should not exist — frameIdentity() makes
      // the same moment one snapshot — but an unstable sort on a list that is
      // rebuilt on every keystroke would be a flicker nobody could explain.
      replica.frames.sort((a, b) => a.timeNs - b.timeNs || (a.id < b.id ? -1 : 1))
    }
  }
  return out
}

/**
 * A time for a chip that no longer has room to say "ns".
 *
 * Trailing zeros are dropped because a column of "997.5 / 1087.5 / 240" reads
 * faster than "997.50 / 1087.50 / 240.00", and the unit is stated once on the
 * row rather than a hundred times.
 */
export function shortTime(ns: number): string {
  if (!Number.isFinite(ns)) return '—'
  const fixed = ns.toFixed(2)
  return fixed.replace(/\.?0+$/, '')
}

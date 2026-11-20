/**
 * What kind of thing an analysis measures, for grouping menus.
 *
 * A flat list of fourteen analyses — some of them named by hand, so
 * "mindist · Y269 to loop" sits between "hbond" and "rmsd" — is a list you
 * read linearly every time. Grouping by what the number MEANS lets the eye
 * skip five-sixths of it: nobody hunting for a surface area reads past
 * "Contacts & bonds".
 *
 * Keyed on the analysis TYPE, which is the part of a metric key before the
 * ` · ` separator that CompareTab's `byKey` builds. A named instance inherits
 * its type's category, because naming a run does not change what it measures.
 *
 * Anything unrecognised falls into "Other" rather than being dropped. That
 * matters more than it sounds: engines contribute analyses this map has never
 * heard of, and a menu that silently omits a result the user can see in the
 * Results tab is worse than one with an untidy last group.
 */

export interface MetricCategory {
  id: string
  label: string
  /** Analysis type ids that belong here. */
  types: string[]
}

/** Display order is the array order — most-used first, "Other" last. */
export const METRIC_CATEGORIES: MetricCategory[] = [
  {
    id: 'deviation',
    label: 'Deviation & flexibility',
    types: ['rmsd', 'rmsd2d', 'rmsf', 'rmsf_rolling'],
  },
  {
    id: 'shape',
    label: 'Size & surface',
    types: ['gyrate', 'sasa', 'sasa_new', 'sasa_nonpolar'],
  },
  {
    id: 'contacts',
    label: 'Contacts & bonds',
    types: ['hbond', 'ncontacts', 'mindist', 'contacts', 'residue_contacts'],
  },
  {
    id: 'secondary',
    label: 'Secondary structure',
    types: ['dssp'],
  },
  {
    id: 'correlation',
    label: 'Correlation & collective motion',
    types: ['dccm', 'xcorr', 'correlate', 'pca', 'helix_motion'],
  },
  {
    id: 'other',
    label: 'Other',
    types: [],
  },
]

const OTHER = 'other'

/** type id → category id, built once from the table above. */
const BY_TYPE: Record<string, string> = {}
for (const c of METRIC_CATEGORIES)
  for (const t of c.types) BY_TYPE[t] = c.id

/**
 * The analysis type inside a metric key.
 *
 * CompareTab keys a named result as `${type} · ${name}`, so the type is
 * everything before the first separator. Splitting on the padded ' · ' and not
 * on '·' alone keeps a name that itself contains a middle dot intact.
 */
export function typeOfMetricKey(key: string): string {
  const i = key.indexOf(' · ')
  return (i >= 0 ? key.slice(0, i) : key).trim()
}

export function categoryOfMetricKey(key: string): string {
  return BY_TYPE[typeOfMetricKey(key)] ?? OTHER
}

export interface MetricGroup {
  id: string
  label: string
  keys: string[]
}

/**
 * Group metric keys for a menu: favourites first, then categories in order.
 *
 * Favourites are LIFTED OUT rather than merely sorted to the top of their own
 * group, because the point of starring something is to stop hunting for it in
 * a category at all. A favourite therefore appears once, in the favourites
 * group, and not again below — a menu where the same option appears twice
 * leaves you wondering whether the two do different things.
 *
 * Empty groups are omitted, so a project with only RMSD runs gets one heading
 * rather than six, five of them blank.
 */
export function groupMetricKeys(
  keys: string[],
  favourites: Iterable<string> = [],
  labelFor: (k: string) => string = k => k,
): MetricGroup[] {
  const fav = new Set(favourites)
  const byLabel = (a: string, b: string) =>
    labelFor(a).localeCompare(labelFor(b), undefined, { numeric: true })

  const groups: MetricGroup[] = []

  const starred = keys.filter(k => fav.has(k)).sort(byLabel)
  if (starred.length)
    groups.push({ id: 'favourites', label: '★ Favourites', keys: starred })

  for (const c of METRIC_CATEGORIES) {
    const inC = keys
      .filter(k => !fav.has(k) && categoryOfMetricKey(k) === c.id)
      .sort(byLabel)
    if (inC.length) groups.push({ id: c.id, label: c.label, keys: inC })
  }
  return groups
}

/**
 * Flatten the grouping back to a key order.
 *
 * Used where a grouped control still needs a single ordered list — picking a
 * sensible default selection, for instance, which should land on a favourite
 * when one exists.
 */
export function orderedMetricKeys(
  keys: string[],
  favourites: Iterable<string> = [],
  labelFor: (k: string) => string = k => k,
): string[] {
  return groupMetricKeys(keys, favourites, labelFor).flatMap(g => g.keys)
}

/**
 * Which residues stopped being buried.
 *
 * The plot answers WHEN — a flat line that lifts. This answers WHERE, which is
 * the half you can act on: a list of residues, how buried each was, how exposed
 * it became, and a button that paints them onto the structure.
 */
import { useStore, LAYER_COLOURS } from '../../store'

interface Row {
  resnum: number
  resname: string
  ref_area: number
  ref_rsa: number | null
  final_area: number
  final_rsa: number | null
  gain: number
  bio?: { chain: string; resnum: number } | null
}

export function NewlyExposedPanel({ r }: { r: any }) {
  const rows: Row[] = r?.newly_exposed || []
  const { addStructureLayer, structureLayers, setRequestedTab } = useStore()

  const pct = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`

  const showOnStructure = () => {
    // Grouped per chain and compressed into ranges — an NGL selection listing
    // forty residues one at a time is unreadable in the layer editor.
    const byChain: Record<string, number[]> = {}
    for (const row of rows) {
      const bio = row.bio
      if (!bio) continue
      ;(byChain[bio.chain] ||= []).push(bio.resnum)
    }
    const parts: string[] = []
    for (const [chain, nums] of Object.entries(byChain)) {
      const sorted = [...new Set(nums)].sort((a, b) => a - b)
      const ranges: string[] = []
      let start = sorted[0], prev = sorted[0]
      for (const n of sorted.slice(1)) {
        if (n === prev + 1) { prev = n; continue }
        ranges.push(start === prev ? `${start}` : `${start}-${prev}`)
        start = prev = n
      }
      if (sorted.length) ranges.push(start === prev ? `${start}` : `${start}-${prev}`)
      const body = ranges.join(' or ')
      parts.push(chain ? `(:${chain} and (${body}))` : `(${body})`)
    }
    if (!parts.length) return
    addStructureLayer({
      id: Math.random().toString(36).slice(2, 9),
      name: 'Newly exposed',
      sele: parts.join(' or '),
      rep: 'licorice',
      color: LAYER_COLOURS[structureLayers.length % LAYER_COLOURS.length],
      opacity: 1,
      visible: true,
      sideChainsOnly: true,
      colorBase: true,
    })
    setRequestedTab('structure')
  }

  const mappable = rows.some(row => row.bio)

  return (
    <div style={{
      marginTop: 10, padding: '10px 12px', borderRadius: 6, fontSize: 11,
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10,
                    flexWrap: 'wrap', marginBottom: 6 }}>
        <strong style={{ fontSize: 12 }}>Residues that stopped being buried</strong>
        <span style={{ color: 'var(--text-muted)' }}>
          {r.n_emerged} of {r.n_buried} buried at t₀
          {r.n_exposed ? ` · ${r.n_exposed} were already exposed and are not counted` : ''}
          {r.n_untabulated ? ` · ${r.n_untabulated} residue(s) have no tabulated `
                             + `maximum area and were left out` : ''}
        </span>
        {mappable && rows.length > 0 && (
          <button onClick={showOnStructure}
                  style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 5,
                           fontSize: 11, background: 'var(--accent)', color: '#fff',
                           border: '1px solid transparent', fontWeight: 600 }}>
            Show on structure
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div style={{ color: 'var(--text-muted)' }}>
          Nothing emerged above the gain threshold — the buried residues stayed
          buried. That is a result, not a failure to detect one.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--font-mono)',
                          fontSize: 11 }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                <th style={{ textAlign: 'left', padding: '2px 10px 4px 0' }}>residue</th>
                <th style={{ padding: '2px 10px 4px' }}>buried (RSA)</th>
                <th style={{ padding: '2px 10px 4px' }}>after (RSA)</th>
                <th style={{ padding: '2px 0 4px 10px' }}>gain (nm²)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.resnum}>
                  <td style={{ padding: '1px 10px 1px 0' }}>
                    {row.resname} {row.bio
                      ? `${row.bio.chain ? row.bio.chain + ' ' : ''}${row.bio.resnum}`
                      : row.resnum}
                  </td>
                  <td style={{ textAlign: 'right', padding: '1px 10px' }}>
                    {row.ref_area.toFixed(2)} ({pct(row.ref_rsa)})
                  </td>
                  <td style={{ textAlign: 'right', padding: '1px 10px' }}>
                    {row.final_area.toFixed(2)} ({pct(row.final_rsa)})
                  </td>
                  <td style={{ textAlign: 'right', padding: '1px 0 1px 10px',
                               color: 'var(--green, #7ee081)' }}>
                    +{row.gain.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ color: 'var(--text-muted)', marginTop: 7, lineHeight: 1.55 }}>
        · Buried means relative accessibility ≤ {(r.rsa_threshold * 100).toFixed(0)}%
        over the first {r.ref_ns}&nbsp;ns — the residue's area as a fraction of
        that residue type's fully-exposed area (Tien et al. 2013).
        <br />
        · "After" is averaged over the last quarter of the run, so a momentary
        opening does not top the list.
        <br />
        · The classification is made per replica from its own start, so a run
        that began slightly open has a correspondingly smaller gain.
      </div>
    </div>
  )
}

/**
 * SequenceViewer — the ChimeraX sequence panel, wired to the same selection
 * the 3D view uses.
 *
 * WHY IT EARNS ITS SPACE
 * Some things are far easier to say in sequence than in space: "the whole
 * helix from 640 to 655", "both cysteines", "every residue between these two
 * loops". Hunting those down by rotating a structure and clicking is slow and
 * error-prone; reading them off a sequence is neither.
 *
 * IT IS THE SAME SELECTION. Clicking here changes exactly what clicking in 3D
 * changes, and a residue picked in 3D lights up here. There is no second
 * notion of "what is selected" to fall out of step.
 *
 * INTERACTION, matching what people already have in their fingers:
 *   click            replace the selection with this residue
 *   drag             sweep a range
 *   shift-click      extend from the last residue clicked
 *   ⌘/ctrl-click     add or remove one residue
 *   hover            light that residue up in 3D
 */
import React, { useMemo, useRef, useState } from 'react'
import type { PickedResidue } from './StructureViewer'
import { sstrucLabel } from '../lib/nglSelection'
import type { SeqChain, SecondaryStructure } from '../lib/nglSelection'
import type { StructureLayer } from '../store'

interface Props {
  chains: SeqChain[]
  selected: PickedResidue[]
  onSelectionChange: (residues: PickedResidue[]) => void
  /** Hover feedback into the 3D view; empty array clears it. */
  onHover: (residues: PickedResidue[]) => void
  /** Visible highlights, so their colours show under the sequence. */
  layers: StructureLayer[]
  /** Residue keys each layer covers, resolved against the structure. */
  layerResidues: Record<string, PickedResidue[]>
  selectionColor: string
}

const key = (chain: string, resnum: number) => `${chain}:${resnum}`

/** Ten-residue blocks, the standard way sequences are read off a ruler. */
const BLOCK = 10

/** Underline colour per secondary structure. Turns get a faint rule so a bend
 *  is visibly different from unassigned coil rather than both reading blank. */
const SS_RULE: Record<SecondaryStructure, string> = {
  helix: 'rgba(247,127,79,0.65)',
  sheet: 'rgba(79,142,247,0.65)',
  turn:  'rgba(154,163,178,0.35)',
  coil:  'transparent',
}

export default function SequenceViewer({
  chains, selected, onSelectionChange, onHover, layers, layerResidues,
  selectionColor,
}: Props) {
  const [dragging, setDragging] = useState(false)
  // The residue a shift-click or a drag measures from.
  const anchorRef = useRef<{ chain: string; resnum: number } | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const selectedKeys = useMemo(
    () => new Set(selected.map(r => key(r.chain, r.resnum))),
    [selected])

  /**
   * Which colour, if any, each residue carries from a highlight.
   * Later layers win, matching how they are drawn.
   */
  const layerColour = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of layers) {
      if (!l.visible) continue
      for (const r of layerResidues[l.id] || []) m.set(key(r.chain, r.resnum), l.color)
    }
    return m
  }, [layers, layerResidues])

  const residuesBetween = (chain: string, a: number, b: number): PickedResidue[] => {
    const lo = Math.min(a, b), hi = Math.max(a, b)
    // Every block with this chain name, not just the first: a structure can
    // list the same chain more than once, and a range that spans the second
    // block would otherwise come back short.
    return chains
      .filter(c => c.chain === chain)
      .flatMap(c => c.residues
        .filter(r => r.resnum >= lo && r.resnum <= hi)
        .map(r => ({ chain, resnum: r.resnum, resname: r.resname })))
  }

  const handleMouseDown = (
    e: React.MouseEvent, chain: string, resnum: number, resname: string,
  ) => {
    e.preventDefault()
    const pick: PickedResidue = { chain, resnum, resname }

    if (e.shiftKey && anchorRef.current) {
      const a = anchorRef.current
      if (a.chain === chain) {
        // Extend, keeping whatever was already selected elsewhere — the same
        // thing shift does in a file list.
        const range = residuesBetween(chain, a.resnum, resnum)
        const have = new Set(selected.map(r => key(r.chain, r.resnum)))
        onSelectionChange([...selected, ...range.filter(r => !have.has(key(r.chain, r.resnum)))])
        return
      }
    }

    if (e.metaKey || e.ctrlKey) {
      const k = key(chain, resnum)
      onSelectionChange(selectedKeys.has(k)
        ? selected.filter(r => key(r.chain, r.resnum) !== k)
        : [...selected, pick])
      anchorRef.current = { chain, resnum }
      return
    }

    anchorRef.current = { chain, resnum }
    setDragging(true)
    onSelectionChange([pick])
  }

  const handleMouseEnter = (chain: string, resnum: number, resname: string) => {
    onHover([{ chain, resnum, resname }])
    if (!dragging) return
    const a = anchorRef.current
    if (!a || a.chain !== chain) return
    onSelectionChange(residuesBetween(chain, a.resnum, resnum))
  }

  const total = chains.reduce((n, c) => n + c.residues.length, 0)

  // Counting them makes "there are no sheets" a statement you can check,
  // rather than something you infer from an absence.
  const ssCounts = useMemo(() => {
    const n = { helix: 0, sheet: 0, turn: 0, coil: 0 }
    for (const c of chains) for (const r of c.residues) n[r.ss] += 1
    return n
  }, [chains])

  if (!total) {
    return (
      <p style={{ fontSize: 12, opacity: 0.65, margin: 0, lineHeight: 1.6 }}>
        No polymer sequence in this structure — nothing to lay out. (A
        ligand-only or ion-only PDB will land here.)
      </p>
    )
  }

  return (
    <div
      onMouseUp={() => setDragging(false)}
      onMouseLeave={() => { setDragging(false); onHover([]) }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, userSelect: 'none' }}
    >
      {chains.map(c => {
        const isCollapsed = collapsed[c.chain]
        const first = c.residues[0]
        const last = c.residues[c.residues.length - 1]
        const nSel = c.residues.filter(
          r => selectedKeys.has(key(c.chain, r.resnum))).length

        return (
          <div key={c.chain || '_'}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
              fontSize: 11,
            }}>
              <button
                onClick={() => setCollapsed(s => ({ ...s, [c.chain]: !s[c.chain] }))}
                style={{ background: 'transparent', border: '1px solid var(--border)',
                         borderRadius: 3, cursor: 'pointer', color: 'var(--text)',
                         fontSize: 10, padding: '1px 6px' }}
              >{isCollapsed ? '▸' : '▾'}</button>
              <strong style={{ fontSize: 12 }}>
                {c.chain ? `Chain ${c.chain}` : 'Polymer'}
              </strong>
              <span style={{ opacity: 0.6 }}>
                {first?.resnum}–{last?.resnum} · {c.residues.length} residues
                {nSel ? ` · ${nSel} selected` : ''}
              </span>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => {
                  const all = c.residues.map(r => ({
                    chain: c.chain, resnum: r.resnum, resname: r.resname,
                  }))
                  const other = selected.filter(r => r.chain !== c.chain)
                  onSelectionChange(nSel === c.residues.length ? other : [...other, ...all])
                }}
                style={{ background: 'transparent', border: '1px solid var(--border)',
                         borderRadius: 3, cursor: 'pointer', color: 'var(--text)',
                         fontSize: 10, padding: '2px 7px' }}
              >{nSel === c.residues.length ? 'Deselect chain' : 'Select chain'}</button>
            </div>

            {!isCollapsed && (
              // Wrapping inline-blocks rather than a grid: chains do not all
              // start at the same residue number, and a grid would force a
              // column count that fights the ruler.
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.15,
                border: '1px solid var(--border)', borderRadius: 4,
                padding: '6px 7px', background: 'var(--bg)',
                maxHeight: 220, overflowY: 'auto',
              }}>
                {c.residues.map((r, i) => {
                  const k = key(c.chain, r.resnum)
                  const isSel = selectedKeys.has(k)
                  const tint = layerColour.get(k)
                  const startsBlock = i % BLOCK === 0
                  return (
                    <React.Fragment key={k}>
                      {startsBlock && (
                        // The ruler goes above the block it labels, as a
                        // superscript, so it never shifts the letters out of
                        // alignment.
                        <span style={{
                          display: 'inline-block', fontSize: 9, opacity: 0.45,
                          verticalAlign: 'top', padding: '0 3px 0 5px',
                          pointerEvents: 'none',
                        }}>{r.resnum}</span>
                      )}
                      <span
                        onMouseDown={e => handleMouseDown(e, c.chain, r.resnum, r.resname)}
                        onMouseEnter={() => handleMouseEnter(c.chain, r.resnum, r.resname)}
                        title={`${r.resname} ${r.resnum}${c.chain ? ` · chain ${c.chain}` : ''}`
                               + (sstrucLabel(r.sstruc) ? ` · ${sstrucLabel(r.sstruc)}` : '')}
                        style={{
                          display: 'inline-block', width: 12, textAlign: 'center',
                          cursor: 'pointer', borderRadius: 2,
                          background: isSel ? selectionColor : (tint || 'transparent'),
                          color: isSel || tint ? '#10141c' : 'var(--text)',
                          fontWeight: isSel ? 700 : 400,
                          // Secondary structure as a baseline rule: readable at
                          // 11px, and it does not compete with the colours.
                          borderBottom: `2px solid ${SS_RULE[r.ss]}`,
                        }}
                      >{r.code}</span>
                    </React.Fragment>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      <div style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.6 }}>
        Click to select · drag to sweep a range · shift-click to extend ·
        ⌘/ctrl-click to add one · hover to light it up in 3D.
        <span style={{ marginLeft: 8 }}>
          <span style={{ borderBottom: `2px solid ${SS_RULE.helix}` }}>
            helix ({ssCounts.helix})</span>
          {' · '}
          <span style={{ borderBottom: `2px solid ${SS_RULE.sheet}` }}>
            sheet ({ssCounts.sheet})</span>
          {' · '}
          <span style={{ borderBottom: `2px solid ${SS_RULE.turn}` }}>
            turn ({ssCounts.turn})</span>
        </span>
      </div>
    </div>
  )
}

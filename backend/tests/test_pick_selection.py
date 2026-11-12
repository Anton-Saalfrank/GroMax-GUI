"""
Can a selection made by clicking INDIVIDUAL ATOMS be analysed?

It could not. Clicking the SG of one residue, the CB of another and the O of a
third produced a selection that silently widened to whole residues, and the
pick was reported as unusable with "make_ndx cannot express that as one
expression". That message was true about one LINE of make_ndx and false about
make_ndx: a selection split at ';' becomes one group per part in a single
session, joined by group number, which ndx_builder has done for a long time.

The first half of this file is the string builder, run on the exact 18-atom
pick that exposed it. The second half hands the shape of that string to a real
gmx and counts the atoms that come back, because a string that merely looks
right is the failure mode this whole area has had before.
"""
import asyncio, shutil, subprocess, sys, tempfile, warnings
from pathlib import Path
warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.structure import build_pick_selection
from core.ndx_builder import is_custom_selection, split_selection_parts

fails = 0


def check(name, ok, detail=""):
    global fails
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        fails += 1


def picks(*spec):
    """[(flat, atom_or_None), ...] -> the resolved-pick dicts the builder takes."""
    return [{"flat": f, "atom": a} for f, a in spec]


print("1. the pick that could not be used")
# Read straight off the screenshot: 18 atoms over 11 residues, no two residues
# contributing the same atom set.
real = picks(
    (163, "CE1"),
    (202, "CB"), (202, "NE"), (202, "NH2"),
    (203, "CE"),
    (206, "CE3"), (206, "CG"), (206, "O"),
    (211, "CG"),
    (234, "CB"),
    (264, "CB"),
    (266, "O"),
    (269, "CB"), (269, "SG"),
    (270, "CA"), (270, "N"), (270, "O"),
    (402, "N"),
)
sel = build_pick_selection(real)
check("it is no longer the bare residue list that used to be emitted",
      sel != "ri 163 202 203 206 211 234 264 266 269 270 402", sel)
check("every part names its atoms",
      all("& a " in p for p in split_selection_parts(sel)), sel)
check("the parts cover every residue picked",
      sorted(int(t) for p in split_selection_parts(sel)
             for t in p.split("&")[0].split()[1:])
      == [163, 202, 203, 206, 211, 234, 264, 266, 269, 270, 402], sel)
check("and the whole thing is recognised as a selection to build",
      is_custom_selection(sel))
# 269 is the mutation site: SG and CB together, as picked.
check("the atoms of one residue stay together in one part",
      "ri 269 & a CB SG" in sel, sel)

print("\n2. residues that share an atom set share a part")
check("all-CA is still the single line it always was",
      build_pick_selection(picks((10, "CA"), (20, "CA"), (30, "CA")))
      == "ri 10 20 30 & a CA",
      build_pick_selection(picks((10, "CA"), (20, "CA"), (30, "CA"))))
two = build_pick_selection(picks((10, "CA"), (20, "CB"), (30, "CA")))
check("two atom sets over three residues make two parts, not three",
      two == "ri 10 30 & a CA; ri 20 & a CB", two)

print("\n3. whole-residue picks")
check("no atoms anywhere is the plain residue list",
      build_pick_selection(picks((5, None), (9, None))) == "ri 5 9")
mixed = build_pick_selection(picks((5, None), (9, "CA")))
check("mixed whole-residue and atom picks keep both, in their own parts",
      mixed == "ri 5; ri 9 & a CA", mixed)
# A residue picked whole AND by an atom: the whole residue is the superset, so
# intersecting it with the atom name would DROP atoms already asked for.
both = build_pick_selection(picks((7, None), (7, "CA")))
check("a residue picked whole and by an atom is taken whole", both == "ri 7", both)

print("\n4. nothing in, nothing out")
check("an empty pick list gives an empty selection", build_pick_selection([]) == "")

# ─────────────────────────────────────────────────────────────────────────────
# Against a real gmx: does that shape of string actually select those atoms?
# ─────────────────────────────────────────────────────────────────────────────
GMX = shutil.which("gmx") or shutil.which("gmx_mpi")
if not GMX:
    print("\n  (gmx not on PATH — skipping the make_ndx half)")
    print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
    sys.exit(1 if fails else 0)

print("\n5. a mixed-atom selection built by real make_ndx")
W = Path(tempfile.mkdtemp())
# Twelve residues, four atoms each, numbered 1..48 in a known order:
# residue r holds N=4r-3, CA=4r-2, C=4r-1, O=4r.
rows, n = [], 1
for r in range(1, 13):
    for nm, el, dx in (("N", "N", 0.0), ("CA", "C", 1.458),
                       ("C", "C", 2.009), ("O", "O", 1.251)):
        rows.append(f"ATOM  {n:5d}  {nm:<3s} ALA A{r:4d}    "
                    f"{dx:8.3f}{0.0:8.3f}{r * 1.5:8.3f}  1.00  0.00          {el:>2s}")
        n += 1
(W / "p.pdb").write_text("\n".join(rows) + "\nTER\n")
subprocess.run([GMX, "editconf", "-f", str(W / "p.pdb"), "-o", str(W / "box.gro"),
                "-d", "1.0", "-bt", "cubic"], capture_output=True, check=True)
GRO = W / "box.gro"

from core.ndx_builder import build_ndx_for_selections


def group_atoms(ndx_path, name):
    out, hit = [], False
    for line in Path(ndx_path).read_text().splitlines():
        t = line.strip()
        if t.startswith("["):
            if hit:
                break
            hit = t.strip("[]").strip() == name
        elif hit and t:
            out.extend(int(x) for x in t.split())
    return sorted(out)


# The same shape as the real pick: different atoms from different residues.
sel = build_pick_selection(picks((2, "CA"), (2, "O"), (5, "N"), (9, "C")))
check("the builder produced a multi-part string", ";" in sel, sel)
resolved, ndx = asyncio.run(build_ndx_for_selections(str(GRO), [sel], W / "mixed"))
got = group_atoms(ndx, resolved[0])
# residue 2: CA=6, O=8;  residue 5: N=17;  residue 9: C=35
check("and make_ndx returns exactly the atoms picked, nothing widened",
      got == [6, 8, 17, 35], f"{got} from '{sel}'")

print("\n6. the old behaviour would have been 12 atoms, not 4")
# What widening to whole residues used to produce, so the difference is not a
# matter of opinion: three whole residues is three times the atoms.
resolved2, ndx2 = asyncio.run(
    build_ndx_for_selections(str(GRO), ["ri 2 5 9"], W / "widened"))
widened = group_atoms(ndx2, resolved2[0])
check("widening really does select three times as many atoms",
      len(widened) == 12 and set(got) < set(widened),
      f"{len(widened)} atoms vs {len(got)}")

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

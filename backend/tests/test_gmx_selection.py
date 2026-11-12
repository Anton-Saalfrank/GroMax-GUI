"""
Does an index group built from a typed selection contain the atoms asked for?

Run against a REAL gmx on a 12-residue peptide where every count is known by
hand: 4 atoms per residue, 1 CA per residue. "The results do not correlate with
the residues I select" is a claim only a real make_ndx can settle.
"""
import asyncio, sys, tempfile, warnings
from pathlib import Path
warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.ndx_builder import build_ndx_for_selections, is_custom_selection

import shutil, subprocess
if not (shutil.which("gmx") or shutil.which("gmx_mpi")):
    print("  (gmx not on PATH — skipping)")
    sys.exit(0)

_W = Path(tempfile.mkdtemp())
_rows, _n = [], 1
for _r in range(1, 13):
    for _nm, _el, _dx in (("N", "N", 0.0), ("CA", "C", 1.458),
                          ("C", "C", 2.009), ("O", "O", 1.251)):
        _rows.append(f"ATOM  {_n:5d}  {_nm:<3s} ALA A{_r:4d}    "
                     f"{_dx:8.3f}{0.0:8.3f}{_r * 1.5:8.3f}  1.00  0.00          {_el:>2s}")
        _n += 1
(_W / "p.pdb").write_text("\n".join(_rows) + "\nTER\n")
subprocess.run([shutil.which("gmx") or shutil.which("gmx_mpi"), "editconf",
                "-f", str(_W / "p.pdb"), "-o", str(_W / "box.gro"),
                "-d", "1.0", "-bt", "cubic"],
               capture_output=True, check=True)
GRO = _W / "box.gro"

# A SECOND system with two residue types, for the case where an atom name
# exists in the system but NOT in the residue it is asked for — which is what
# a mutation does (a cysteine SG where the other structure has a tyrosine).
# Residue 1 is ALA (N CA C O); residue 2 is SER and also has CB and OG.
_rows2, _n2 = [], 1
for _r, _atoms in ((1, (("N", "N"), ("CA", "C"), ("C", "C"), ("O", "O"))),
                   (2, (("N", "N"), ("CA", "C"), ("C", "C"), ("O", "O"),
                        ("CB", "C"), ("OG", "O")))):
    _resname = "ALA" if _r == 1 else "SER"
    for _k, (_nm, _el) in enumerate(_atoms):
        _rows2.append(f"ATOM  {_n2:5d}  {_nm:<3s} {_resname} A{_r:4d}    "
                      f"{_k * 1.4:8.3f}{0.0:8.3f}{_r * 3.5:8.3f}"
                      f"  1.00  0.00          {_el:>2s}")
        _n2 += 1
(_W / "mix.pdb").write_text("\n".join(_rows2) + "\nTER\n")
subprocess.run([shutil.which("gmx") or shutil.which("gmx_mpi"), "editconf",
                "-f", str(_W / "mix.pdb"), "-o", str(_W / "mix.gro"),
                "-d", "1.0", "-bt", "cubic"],
               capture_output=True, check=True)
MIXED = _W / "mix.gro"

fails = 0
def check(n, ok, d=''):
    global fails
    ok = bool(ok)
    if not ok: fails += 1
    print(f"  {'ok  ' if ok else 'FAIL'}  {n}{('  — ' + str(d)) if str(d) else ''}")

def group_atoms(ndx_path, name):
    """Atom indices in a named group of an .ndx file."""
    if not ndx_path:
        return None
    txt = Path(ndx_path).read_text()
    cur, out = None, {}
    for line in txt.splitlines():
        s = line.strip()
        if s.startswith('['):
            cur = s.strip('[] ').strip(); out[cur] = []
        elif cur and s:
            out[cur] += [int(v) for v in s.split()]
    return out.get(name)

tmp = Path(tempfile.mkdtemp())

print("1. a plain residue range")
resolved, ndx = asyncio.run(build_ndx_for_selections(str(GRO), ["ri 3-5"], tmp / "a"))
atoms = group_atoms(ndx, resolved[0])
check("selection was turned into a custom group", resolved[0].startswith("gromax_sel"),
      resolved[0])
check("ri 3-5 gives 12 atoms (3 residues x 4)", atoms and len(atoms) == 12,
      f"{len(atoms) if atoms else 0} atoms")
check("  and they are residues 3,4,5 — atoms 9..20",
      atoms == list(range(9, 21)), f"{atoms[:3]}...{atoms[-3:]}" if atoms else None)

print("\n2. TWO custom selections in one analysis")
resolved, ndx = asyncio.run(
    build_ndx_for_selections(str(GRO), ["ri 1-2", "ri 10-12"], tmp / "b"))
a0, a1 = group_atoms(ndx, resolved[0]), group_atoms(ndx, resolved[1])
check("both became distinct groups", resolved[0] != resolved[1], resolved)
check("first is residues 1-2 (8 atoms)", a0 == list(range(1, 9)),
      f"{len(a0) if a0 else 0} atoms")
check("second is residues 10-12 (12 atoms)", a1 == list(range(37, 49)),
      f"{len(a1) if a1 else 0} atoms")
check("  and they do NOT overlap", a0 and a1 and not (set(a0) & set(a1)))

print("\n3. a custom selection mixed with a standard group name")
resolved, ndx = asyncio.run(
    build_ndx_for_selections(str(GRO), ["Protein", "ri 6-7"], tmp / "c"))
check("the standard name passes through untouched", resolved[0] == "Protein", resolved)
check("the custom one is built", resolved[1].startswith("gromax_sel"), resolved)
check("  Protein is still resolvable from the combined ndx",
      group_atoms(ndx, "Protein") and len(group_atoms(ndx, "Protein")) == 48,
      f"{len(group_atoms(ndx,'Protein') or [])} atoms")
check("  and the custom group is residues 6-7",
      group_atoms(ndx, resolved[1]) == list(range(21, 29)))

print("\n4. an EMPTY second selection (the two-box analyses)")
# SASA and Newly-exposed SASA default their second box to "", so this path runs
# on every GROMACS SASA job.
try:
    resolved, ndx = asyncio.run(
        build_ndx_for_selections(str(GRO), ["Protein", ""], tmp / "d"))
    check("an empty second group does not break the build", True, f"{resolved}, ndx={bool(ndx)}")
    check("  and it stays empty rather than becoming a group", resolved[1] == "",
          repr(resolved[1]))
except Exception as e:
    check("an empty second group does not break the build", False,
          f"{type(e).__name__}: {e}")

print("\n5. 'ri' with a CA restriction")
resolved, ndx = asyncio.run(
    build_ndx_for_selections(str(GRO), ["ri 2-4 & a CA"], tmp / "e"))
atoms = group_atoms(ndx, resolved[0])
check("ri 2-4 & a CA gives 3 atoms", atoms and len(atoms) == 3,
      f"{len(atoms) if atoms else 0}: {atoms}")
check("  which are the CA of residues 2,3,4", atoms == [6, 10, 14], atoms)

print("\n6. a selection that matches nothing is refused, not silently empty")
try:
    asyncio.run(build_ndx_for_selections(str(GRO), ["ri 900-999"], tmp / "f"))
    check("an out-of-range residue range is refused", False, "ACCEPTED")
except RuntimeError as e:
    check("an out-of-range residue range is refused",
          "0 atoms" in str(e) or "could not be built" in str(e),
          str(e).splitlines()[0][:70])

print("\n7. the normalisation of '&'-joined ri terms")
check("'ri 2 & ri 5' is recognised as custom", is_custom_selection("ri 2 & ri 5"))
resolved, ndx = asyncio.run(
    build_ndx_for_selections(str(GRO), ["ri 2 & ri 5 & ri 8"], tmp / "g"))
atoms = group_atoms(ndx, resolved[0])
check("  and collapses to the UNION 2,5,8 (12 atoms), not an empty intersection",
      atoms and len(atoms) == 12, f"{len(atoms) if atoms else 0} atoms")


print("\n8. a FAILING selection must be refused, never silently substituted")
# The bug this guards: make_ndx exits 0 and writes only the default groups when
# it rejects a selection. Taking "the last group in the file" then yields a
# default group — SideChain-H, Water, whatever is last — and the analysis runs
# on atoms nobody asked for, with nothing reporting a problem.
for bad in ("ri 9000-9100", "99 & ri 5", "ri 1-5 & a ZZZ"):
    try:
        resolved, ndx = asyncio.run(
            build_ndx_for_selections(str(GRO), [bad], tmp / f"bad_{abs(hash(bad))}"))
        atoms = group_atoms(ndx, resolved[0])
        check(f"{bad!r} is refused", False,
              f"ACCEPTED and resolved to {len(atoms or [])} atoms — WRONG ATOMS")
    except RuntimeError as e:
        # Any of the three refusal routes is fine; what matters is that the run
        # stops instead of proceeding on atoms nobody chose.
        msg = str(e)
        check(f"{bad!r} is refused",
              any(k in msg for k in ("could not be built", "0 atoms",
                                     "matched nothing")),
              msg.splitlines()[0][:64])

print("\n9. and a valid one still builds, with gmx's own group name")
resolved, ndx = asyncio.run(
    build_ndx_for_selections(str(GRO), ["ri 2-4"], tmp / "good_again"))
check("a good selection survives the stricter check",
      group_atoms(ndx, resolved[0]) == list(range(5, 17)),
      f"{len(group_atoms(ndx, resolved[0]) or [])} atoms")

print("\n10. the failure message carries GROMACS' own output")
try:
    asyncio.run(build_ndx_for_selections(str(GRO), ["nonsense zzz"], tmp / "msg"))
except RuntimeError as e:
    check("the error quotes what GROMACS said", "GROMACS output:" in str(e),
          "included" if "GROMACS output:" in str(e) else "MISSING")

print("\n11. an unquoted group name is the commonest real-world failure")
# Measured on gmx 2024.2: 'protein & ri 205-267' is a syntax error that builds
# nothing, while quoting the name works. Before this was diagnosed, the error
# said only "could not be built" and the user had no way to know why.
try:
    asyncio.run(build_ndx_for_selections(str(GRO), ["protein & ri 2-4"],
                                         tmp / "unquoted"))
    check("'protein & ri 2-4' is refused", False, "it was accepted")
except RuntimeError as e:
    msg = str(e)
    check("'protein & ri 2-4' is refused", "could not be built" in msg)
    check("the message names the fix (quotes)",
          "double quotes" in msg and '"Protein"' in msg,
          msg.splitlines()[0][:96])

resolved, ndx = asyncio.run(
    build_ndx_for_selections(str(GRO), ['"Protein" & ri 2-4'], tmp / "quoted"))
check("the quoted form builds, and holds exactly residues 2-4",
      group_atoms(ndx, resolved[0]) == list(range(5, 17)),
      f"{len(group_atoms(ndx, resolved[0]) or [])} atoms")

print("\n12. excluding hydrogens from a selection is supported")
# The documented way to make a GROMACS contact count comparable with a
# structure viewer. On this all-heavy-atom peptide it must keep all 12 atoms.
resolved, ndx = asyncio.run(
    build_ndx_for_selections(str(GRO), ["ri 2-4 & ! a H*"], tmp / "noh"))
check("'ri 2-4 & ! a H*' builds",
      group_atoms(ndx, resolved[0]) == list(range(5, 17)),
      f"{len(group_atoms(ndx, resolved[0]) or [])} atoms")

print("\n13. make_ndx has no precedence — and a multi-part selection gets round it")
# Each residue here is N, CA, C, O, so residue r is atoms 4r-3 .. 4r.
# The intent: residue 2's CA (atom 6) plus all of residue 5 (atoms 17-20).
want = [6, 17, 18, 19, 20]
resolved, ndx = asyncio.run(build_ndx_for_selections(
    str(GRO), ["ri 5 | ri 2 & a CA"], tmp / "oneline"))
one = group_atoms(ndx, resolved[0])
check("written as ONE line it is read left to right — and is wrong",
      one == [6, 18], f"{one} — that is (ri 5 | ri 2) & a CA")
resolved, ndx = asyncio.run(build_ndx_for_selections(
    str(GRO), ["ri 2 & a CA; ri 5"], tmp / "multi"))
check("written as parts separated by ';' it is exactly what was meant",
      group_atoms(ndx, resolved[0]) == want, f"{group_atoms(ndx, resolved[0])}")
resolved, ndx = asyncio.run(build_ndx_for_selections(
    str(GRO), ["ri 5; ri 2 & a CA"], tmp / "multi_rev"))
check("and the order of the parts does not matter",
      group_atoms(ndx, resolved[0]) == want, f"{group_atoms(ndx, resolved[0])}")
resolved, ndx = asyncio.run(build_ndx_for_selections(
    str(GRO), ["ri 1 & a N; ri 3 & a C O; ri 7; ri 12 & a CA"], tmp / "multi4"))
check("four parts mixing whole residues and named atoms",
      group_atoms(ndx, resolved[0]) == [1, 11, 12, 25, 26, 27, 28, 46],
      f"{group_atoms(ndx, resolved[0])}")

print("\n14. a broken part refuses the whole selection, and names the part")
# If a part fails, make_ndx skips it and every later group number shifts, so
# the union would join the wrong groups. That has to be caught, not run.
try:
    asyncio.run(build_ndx_for_selections(
        str(GRO), ["ri 2 & a CA; nonsense zzz; ri 5"], tmp / "badpart"))
    check("a part that cannot be built is refused", False, "it was accepted")
except RuntimeError as e:
    check("a part that cannot be built is refused", True)
    check("and the message names that part", "nonsense zzz" in str(e),
          str(e).splitlines()[0][:90])
try:
    asyncio.run(build_ndx_for_selections(
        str(GRO), ["ri 2 & a CA; ri 3 & a ZZZ"], tmp / "emptypart"))
    check("a part whose atom name matches nothing is refused", False,
          "it was accepted")
except RuntimeError as e:
    check("a part whose atom name matches nothing is refused",
          "matched nothing" in str(e), str(e).splitlines()[0][:90])

print("\n15. an atom name that matches nothing IN ITS PART is caught")
# REGRESSION: make_ndx reports ONE combined count for a list of atom names, so
# a name matching nothing is invisible whenever a sibling matches. Measured on
# a real pair of topologies: 'ri 269 & a CB HB1 O SG' printed "Found 1101 atoms
# with names CB HB1 O SG" and quietly gave 3 atoms instead of 4, because the
# wild type has a tyrosine there and no SG. The same selection then built 53
# atoms in one condition and 52 in the other, with nothing said.
# In MIXED, residue 1 is ALA and residue 2 is SER. OG exists in the system
# (residue 2) but not in residue 1 — exactly the mutation case, and NOT the
# "name matches nothing anywhere" case the older rule already caught.
try:
    asyncio.run(build_ndx_for_selections(
        str(MIXED), ["ri 1 & a CA OG"], tmp / "dropname"))
    check("a name absent from that residue is refused", False,
          "it silently built a smaller group")
except RuntimeError as e:
    check("a name absent from that residue is refused",
          "matched nothing in the part" in str(e), str(e).splitlines()[0][:90])
    check("and the message names the atom AND the part",
          "'OG'" in str(e) and "ri 1 & a CA OG" in str(e),
          str(e).splitlines()[0][:120])

# The same name IS fine in the residue that really has it.
resolved, ndx = asyncio.run(build_ndx_for_selections(
    str(MIXED), ["ri 2 & a CA OG"], tmp / "goodnames"))
check("a list whose names all match still builds",
      group_atoms(ndx, resolved[0]) == [6, 10], f"{group_atoms(ndx, resolved[0])}")

print("\n16. probe groups do not leak into the built group")
# The probes are written to the same index file AFTER the real group, so
# taking "the last group" would return a probe. Measured when that was wrong:
# a 53-atom selection came back as 1 atom.
resolved, ndx = asyncio.run(build_ndx_for_selections(
    str(GRO), ["ri 2 & a CA O; ri 5 & a N CA"], tmp / "noleak"))
check("a multi-part selection with name lists is exactly right",
      group_atoms(ndx, resolved[0]) == [6, 8, 17, 18],
      f"{group_atoms(ndx, resolved[0])}")

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

"""
The topology cache: one lookup key, one copy of the bytes.

Replicas of the same system are spawned from one equilibrated structure, so
their frame 0 is byte-identical and the per-(tpr, xtc) cache stores the same
~9 MB file once per replica. This checks that the content store collapses that
onto hard links WITHOUT changing what any reader sees — every cache entry must
still be a real, complete, readable file at its original path.

Numbers here are small so the test is fast; the mechanism is size-independent.
"""
import os
import shutil
import sys
import warnings
from pathlib import Path
from tempfile import TemporaryDirectory

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engines.topology import (BLOB_DIR, _content_hash, _store,
                              dedup_topologies)

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


def disk_bytes(d: Path) -> int:
    """What the directory really costs: each inode counted once, however many
    names point at it. This is the number the dedup is trying to lower."""
    seen, total = set(), 0
    for p in d.rglob("*"):
        if not p.is_file():
            continue
        st = p.stat()
        if st.st_ino in seen:
            continue
        seen.add(st.st_ino)
        total += st.st_size
    return total


def build(d: Path, spec):
    """spec: {name: content}. Returns total apparent bytes."""
    for name, content in spec.items():
        (d / name).write_bytes(content)


# Three replicas of condition A, two of B, one odd one out.
A = b"ATOM  A" * 500
B = b"ATOM  B" * 500          # same length as A, different bytes
C = b"ATOM  C" * 300          # unique length

SPEC = {
    "topology_aaa1_xxx1.pdb": A,
    "topology_aaa2_xxx2.pdb": A,
    "topology_aaa3_xxx3.pdb": A,
    "topology_bbb1_yyy1.pdb": B,
    "topology_bbb2_yyy2.pdb": B,
    "topology_ccc1_zzz1.pdb": C,
}
APPARENT = sum(len(v) for v in SPEC.values())           # 3*3500 + 2*3500 + 2100
UNIQUE = len(A) + len(B) + len(C)                       # one copy of each

print("1. a cache of duplicates, measured without being touched")
with TemporaryDirectory() as td:
    d = Path(td)
    build(d, SPEC)
    before = disk_bytes(d)
    st = dedup_topologies(d, dry_run=True)

    check("every file is seen", st["n_files"] == 6, st["n_files"])
    check("three distinct contents among six files",
          st["n_distinct"] == 3, st["n_distinct"])
    check("apparent size is the sum of the names",
          st["apparent_bytes"] == APPARENT, f'{st["apparent_bytes"]} == {APPARENT}')
    check("unique size counts each content once",
          st["unique_bytes"] == UNIQUE, f'{st["unique_bytes"]} == {UNIQUE}')
    # A costs 3 copies and should cost 1; B costs 2 and should cost 1.
    check("reclaimable is exactly the redundant copies",
          st["reclaimable_bytes"] == 2 * len(A) + 1 * len(B),
          f'{st["reclaimable_bytes"]} == 2*|A| + 1*|B|')
    check("a dry run relinks nothing", st["n_relinked"] == 0)
    check("and leaves the directory byte-for-byte as it was",
          disk_bytes(d) == before and not (d / BLOB_DIR).exists(),
          f'{disk_bytes(d)} == {before}')

print("\n2. the real run: smaller on disk, identical to every reader")
with TemporaryDirectory() as td:
    d = Path(td)
    build(d, SPEC)
    st = dedup_topologies(d)

    check("every original name still exists",
          all((d / n).is_file() for n in SPEC), )
    check("and still holds exactly its original bytes",
          all((d / n).read_bytes() == c for n, c in SPEC.items()))
    check("each name is a regular file, not a symlink that could dangle",
          all((d / n).is_file() and not (d / n).is_symlink() for n in SPEC))
    check("disk use drops to one copy per distinct content",
          disk_bytes(d) == UNIQUE, f'{disk_bytes(d)} == {UNIQUE}')
    check("which is the saving the dry run predicted",
          APPARENT - disk_bytes(d) == 2 * len(A) + len(B),
          f'{APPARENT} -> {disk_bytes(d)}')
    # 3, not 5: the blob is created by linking the FIRST file of each group,
    # so that file already shares the blob's inode and needs no relink. Two of
    # the three A's, one of the two B's, and none of the lone C.
    check("only the genuinely redundant names are rewritten",
          st["n_relinked"] == 3, st["n_relinked"])

    blobs = sorted((d / BLOB_DIR).glob("*.pdb"))
    # Including the file that had no duplicate: it costs nothing to give it a
    # blob (a hard link), and it means the NEXT replica producing those bytes
    # links onto it instead of writing a second copy.
    check("one blob per distinct content, duplicated or not",
          len(blobs) == 3, len(blobs))
    check("blobs are named by content hash",
          {b.stem for b in blobs} == {_content_hash(d / n) for n in
                                      ("topology_aaa1_xxx1.pdb",
                                       "topology_bbb1_yyy1.pdb",
                                       "topology_ccc1_zzz1.pdb")})
    check("blobs are read-only, so an in-place write fails loudly instead of "
          "corrupting every replica's topology",
          all((b.stat().st_mode & 0o222) == 0 for b in blobs),
          oct(blobs[0].stat().st_mode & 0o777))

    print("\n3. running it again changes nothing")
    again = dedup_topologies(d)
    check("nothing left to reclaim", again["reclaimable_bytes"] == 0,
          again["reclaimable_bytes"])
    check("nothing relinked", again["n_relinked"] == 0, again["n_relinked"])
    check("still three distinct contents", again["n_distinct"] == 3)
    check("and the files are still intact",
          all((d / n).read_bytes() == c for n, c in SPEC.items()))
    check("disk use unchanged", disk_bytes(d) == UNIQUE)

print("\n4. a new build lands on an existing blob instead of a fourth copy")
with TemporaryDirectory() as td:
    d = Path(td)
    build(d, SPEC)
    dedup_topologies(d)
    base = disk_bytes(d)

    # A fourth replica of condition A: gmx produced the same bytes again.
    tmp = d / ".building_test.pdb"
    tmp.write_bytes(A)
    out = _store(tmp, d / "topology_aaa4_xxx4.pdb")

    check("the new cache entry exists and reads correctly",
          out.is_file() and out.read_bytes() == A)
    check("the temp file is consumed", not tmp.exists())
    check("and disk use did not grow at all",
          disk_bytes(d) == base, f'{disk_bytes(d)} == {base}')
    check("no second blob was created for the same content",
          len(list((d / BLOB_DIR).glob("*.pdb"))) == 3,
          len(list((d / BLOB_DIR).glob("*.pdb"))))

    # And a genuinely new system does get its own blob.
    D = b"ATOM  D" * 400
    tmp2 = d / ".building_test2.pdb"
    tmp2.write_bytes(D)
    out2 = _store(tmp2, d / "topology_ddd1_www1.pdb")
    check("but new content does get stored",
          out2.read_bytes() == D and disk_bytes(d) == base + len(D),
          f'{disk_bytes(d)} == {base} + {len(D)}')
    check("as a fourth blob",
          len(list((d / BLOB_DIR).glob("*.pdb"))) == 4)

print("\n5. a deduplicated project can still be deleted")
# Blobs are read-only, which on POSIX does not impede unlinking (that needs
# write permission on the DIRECTORY) but on Windows would make rmtree fail
# halfway through deleting an archived project. _freeze skips Windows for
# exactly that reason; this checks the platform the test is running on.
with TemporaryDirectory() as td:
    d = Path(td) / "project"
    (d / "topologies").mkdir(parents=True)
    build(d / "topologies", SPEC)
    dedup_topologies(d / "topologies")
    try:
        shutil.rmtree(d)
        gone, why = not d.exists(), ''
    except OSError as e:
        gone, why = False, str(e)
    check("rmtree removes a project whose topologies were deduplicated",
          gone, why)

print("\n6. edge cases that must not raise")
with TemporaryDirectory() as td:
    d = Path(td)
    empty = dedup_topologies(d)
    check("an empty cache reports zeros",
          empty["n_files"] == 0 and empty["reclaimable_bytes"] == 0)
    check("a missing directory does too",
          dedup_topologies(d / "nope")["n_files"] == 0)

    # Files that are not topologies must be ignored entirely.
    (d / "notes.txt").write_bytes(A)
    (d / "topology_only1_only1.pdb").write_bytes(A)
    st = dedup_topologies(d)
    check("only topology_*.pdb is considered",
          st["n_files"] == 1, st["n_files"])
    check("an unrelated file with identical content is neither counted nor "
          "touched", (d / "notes.txt").read_bytes() == A
          and st["reclaimable_bytes"] == 0)
    check("and it is left out of the content store entirely",
          len(list((d / BLOB_DIR).glob("*.pdb"))) == 1)

print("\nALL PASS" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

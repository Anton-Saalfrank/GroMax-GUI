"""
Topology files for engines that cannot read a .tpr.

THE PROBLEM
MDAnalysis reads GROMACS .tpr files natively. MDTraj and cpptraj do not — they
need a topology in a format they understand, and the obvious candidate is the
condition's reference PDB.

That obvious candidate is wrong, twice over:

  1. ATOM COUNT. The reference structure is frequently a crystal structure or a
     pre-solvation model. The trajectory is the solvated, ionised, hydrogenated
     system. Feed one as the topology for the other and you either get a hard
     "topology has N atoms, trajectory has M" error, or — worse, with a
     tolerant reader — every coordinate assigned to the wrong atom.

  2. NUMBERING. The reference PDB carries author numbering (chain A, residue
     206). Selections in this app are flat GROMACS residue indices. `resSeq 206`
     against an author-numbered topology means a different residue than
     `ri 206` does, and nothing in the result would look wrong.

THE FIX
Dump frame 0 of the trajectory itself, through the .tpr, with gmx trjconv. The
result is guaranteed atom-for-atom identical to the trajectory, and carries
GROMACS' own flat residue numbering — which is exactly what the selections
assume. Note this is the OPPOSITE choice from the structure viewer's snapshot
endpoint, which renumbers INTO author numbering so it can be shown alongside
picks made on the reference structure. Same tool, opposite direction, because
the consumers want opposite things.

Cached per (tpr, xtc) identity, so a project's second analysis on the same
replica does not pay for it again.

WHY THE CACHE IS CONTENT-ADDRESSED UNDERNEATH
Keying the cache on (tpr, xtc) identity is right for the lookup — it is what
makes re-running a simulation invalidate the entry — but it badly over-counts
the storage. Replicas of the same system usually differ only by velocity seed,
so they are spawned from one equilibrated structure and their frame 0 is
BYTE-IDENTICAL. Ten replicas then cost ten copies of the same ~9 MB file. One
real project here held 9 topologies, 79.6 MB, with exactly 2 distinct contents.

So the identity-keyed name is kept as the lookup, but the bytes live once in
`by-content/<sha256>.pdb` and every identity name is a HARD LINK to it. Readers
are unaffected: they open the same path they always did, and it is a real file,
not a symlink that could dangle. Deleting one name frees nothing until the last
link to the blob goes, which is the correct behaviour for a cache keyed one way
and stored another.

Blobs are made read-only (0444) on the way in. A hard link shares the inode, so
anything that truncated one identity name in place would silently corrupt every
replica's topology; read-only turns that into a loud EACCES instead. Nothing in
this module writes to a final name — builds go to a temp file and are linked
into place — so the permission only ever fires on a mistake.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import uuid
from pathlib import Path

from core.gmx import run_gmx

#: Where the single copy of each distinct topology lives, under the cache dir.
BLOB_DIR = "by-content"


def _identity(path: Path) -> str:
    """Path + mtime + size, so re-running a simulation invalidates the cache."""
    try:
        st = path.stat()
        raw = f"{path}|{int(st.st_mtime)}|{st.st_size}"
    except OSError:
        raw = str(path)
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _content_hash(path: Path) -> str:
    """
    SHA-256 of the file's bytes, read in chunks.

    Chunked because these are ~9 MB now but a solvated membrane system is
    hundreds, and reading one whole into memory to hash it would be a needless
    spike during a run.
    """
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()[:32]


def _freeze(path: Path) -> None:
    """
    Make a blob read-only, so an in-place write fails loudly.

    Skipped on Windows, where this would be actively harmful: 0o444 sets the
    read-only ATTRIBUTE, and `os.unlink` refuses to delete such a file, so
    `shutil.rmtree` would fail halfway through deleting an archived project.
    On POSIX, unlinking needs write permission on the directory rather than on
    the file, so deletion is unaffected and the guard is free.

    Best effort otherwise: a cache that cannot be chmod'd is still a correct
    cache, just without the guard.
    """
    if os.name == "nt":
        return
    try:
        os.chmod(path, 0o444)
    except OSError:
        pass


def _link_or_copy(blob: Path, name: Path) -> Path:
    """
    Point `name` at `blob`'s bytes, preferring a hard link.

    Falls back to a copy when the filesystem has no hard links (exFAT, some
    network mounts) — the saving is lost, the behaviour is not. An existing
    `name` means a concurrent build of the same replica got there first, and its
    file is as good as ours.
    """
    try:
        os.link(blob, name)
    except FileExistsError:
        pass
    except OSError:
        if not name.exists():
            shutil.copy2(blob, name)
    return name


def _store(tmp: Path, name: Path) -> Path:
    """
    Move a freshly built topology into the content store and link `name` to it.

    `tmp` is consumed either way: moved in if its contents are new, discarded if
    an identical blob already exists.
    """
    blobs = name.parent / BLOB_DIR
    blobs.mkdir(parents=True, exist_ok=True)
    blob = blobs / f"{_content_hash(tmp)}.pdb"

    if blob.is_file() and blob.stat().st_size > 0:
        # Another replica already produced these exact bytes.
        tmp.unlink(missing_ok=True)
    else:
        os.replace(tmp, blob)      # atomic within one directory tree
        _freeze(blob)

    return _link_or_copy(blob, name)


async def ensure_topology(tpr: str, xtc: str, cache_dir: Path,
                          line_callback=None) -> Path:
    """
    A .pdb topology matching this trajectory atom-for-atom, in flat numbering.

    Raises RuntimeError with the gmx stderr tail if it cannot be produced —
    silently falling back to the reference PDB would reintroduce exactly the
    mismatch this function exists to prevent.
    """
    tpr_path, xtc_path = Path(tpr).expanduser(), Path(xtc).expanduser()
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"topology_{_identity(tpr_path)}_{_identity(xtc_path)}.pdb"

    if out.is_file() and out.stat().st_size > 0:
        return out

    if line_callback:
        line_callback("Building a topology from the .tpr (first frame)…")

    # Build to a temp name, never to `out`. Two reasons: a crashed or cancelled
    # trjconv cannot leave a half-written file sitting at the cache key where
    # the size check above would accept it, and the final name is a hard link
    # into the shared content store, which must never be written through.
    tmp = cache_dir / f".building_{os.getpid()}_{uuid.uuid4().hex[:8]}.pdb"

    # -dump 0 takes the first frame. The whole System, because an engine needs
    # to see every atom the trajectory contains, whatever the analysis will
    # later select from it.
    try:
        result = await run_gmx(
            ["trjconv", "-s", str(tpr_path), "-f", str(xtc_path),
             "-dump", "0", "-o", str(tmp)],
            stdin_input="System\n", cwd=cache_dir, timeout=900,
        )

        if not result["success"] or not tmp.is_file() or tmp.stat().st_size == 0:
            tail = "\n".join((result.get("stderr") or "").splitlines()[-8:])
            raise RuntimeError(
                "Could not build a topology for this engine. It needs a structure "
                "matching the trajectory atom-for-atom, which is dumped from the "
                f".tpr with gmx trjconv.\n{tail}")

        return _store(tmp, out)
    finally:
        # Covers the failure paths above and any cancellation mid-build.
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def dedup_topologies(cache_dir: Path, dry_run: bool = False) -> dict:
    """
    Collapse an existing topology cache onto hard links. Idempotent.

    Written for caches built before the content store existed, and safe to run
    at any time: names already linked to their blob are skipped, and a name is
    only ever replaced by `os.replace` of a ready-made link, so no cache entry
    is briefly absent even if this is interrupted.

    `dry_run` measures without touching anything, which is what lets the UI say
    how much this would free before the user agrees to it.

    Every file is hashed, including ones with a unique size. Grouping by size
    first would save a little I/O on a cache that holds no duplicates, but these
    caches hold tens of files, not thousands — and a name whose size is unique
    among the names can still be a redundant second copy of an existing blob,
    which a size-first pass would skip.
    """
    cache_dir = Path(cache_dir)
    if not cache_dir.is_dir():
        return _dedup_stats(0, 0, 0, 0, 0, dry_run)

    blobs = cache_dir / BLOB_DIR
    names = sorted(cache_dir.glob("topology_*.pdb"))

    groups: dict[str, list[Path]] = {}
    apparent = 0
    for n in names:
        try:
            apparent += n.stat().st_size
            groups.setdefault(_content_hash(n), []).append(n)
        except OSError:
            continue

    unique = 0
    freed = 0
    relinked = 0

    for digest, dups in groups.items():
        size = dups[0].stat().st_size
        unique += size
        blob = blobs / f"{digest}.pdb"

        # Disk charges per inode, not per name. The goal state is one inode
        # shared by the blob and every name, so the saving is whatever the
        # extra inodes currently cost.
        inodes = set()
        for q in dups:
            try:
                inodes.add(q.stat().st_ino)
            except OSError:
                pass
        blob_ino = blob.stat().st_ino if blob.is_file() else None
        if blob_ino is not None:
            inodes.add(blob_ino)

        freed += size * (len(inodes) - 1)

        # A content with ONE copy and a blob already pointing at it is done.
        # A content with one copy and NO blob is not: it costs the right
        # amount today, but the next replica to produce these same bytes would
        # write a second copy, because `_store` looks for a blob and finds
        # none. Giving every distinct content a blob — for free, as a hard
        # link — is what makes the store authoritative, so future builds
        # deduplicate on their own instead of waiting for another pass here.
        if blob_ino is not None and len(inodes) == 1:
            continue
        if dry_run:
            continue

        blobs.mkdir(parents=True, exist_ok=True)
        try:
            if blob_ino is None or blob.stat().st_size != size:
                # A wrong-sized blob is a truncated earlier attempt; it is
                # addressed by content, so there is nothing in it to preserve.
                blob.unlink(missing_ok=True)
                # Link, never copy: the bytes are already on this disk.
                os.link(dups[0], blob)
                _freeze(blob)
        except OSError:
            freed -= size * (len(inodes) - 1)
            continue

        blob_ino = blob.stat().st_ino
        for n in dups:
            try:
                if n.stat().st_ino == blob_ino:
                    continue
            except OSError:
                continue
            # Link to a temp name, then atomically replace: `n` is a valid
            # cache entry at every instant, before and after.
            tmp = cache_dir / f".relink_{uuid.uuid4().hex[:8]}.pdb"
            try:
                os.link(blob, tmp)
                os.replace(tmp, n)
                relinked += 1
            except OSError:
                # No hard links on this filesystem. Leave every name alone —
                # a cache that costs more than it needs to is not a fault.
                tmp.unlink(missing_ok=True)
                freed -= size * (len(inodes) - 1)
                break

    return _dedup_stats(len(names), len(groups), apparent, unique,
                        relinked, dry_run, freed)


def _dedup_stats(n_files, n_distinct, apparent, unique, relinked, dry_run,
                 freed=0) -> dict:
    return {
        "n_files": n_files,
        "n_distinct": n_distinct,
        "apparent_bytes": apparent,
        "unique_bytes": unique,
        "reclaimable_bytes": max(0, freed),
        "n_relinked": relinked,
        "dry_run": dry_run,
    }

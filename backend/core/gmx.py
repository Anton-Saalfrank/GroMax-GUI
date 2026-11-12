"""
GROMACS subprocess wrapper.
All gmx command execution flows through here — handles stdin piping,
progress streaming, output parsing, and index group management.
"""

import asyncio
import hashlib
import json
import re
from pathlib import Path
from typing import Optional, Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .appconfig import get_gmx_executable
from .session import load_state, save_state, session_dir, locked_state

router = APIRouter()


# ─── Core subprocess runner ───────────────────────────────────────────────────

async def run_gmx(
    args: list[str],
    stdin_input: str = "",
    cwd: Optional[Path] = None,
    timeout: int = 3600,
    line_callback: Optional[Callable[[str], None]] = None,
) -> dict:
    """
    Run a gmx command asynchronously with optional live line streaming.
    Returns {"returncode", "stdout", "stderr", "success", "cmd"}.
    """
    gmx = get_gmx_executable()
    cmd = [gmx] + args

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd) if cwd else None,
        )
    except Exception as e:
        return {"returncode": -1, "stdout": "", "stderr": f"Failed to launch gmx: {e}",
                "success": False, "cmd": " ".join(cmd)}

    stdout_chunks: list[str] = []
    stderr_lines: list[str] = []

    async def feed_stdin():
        if stdin_input:
            proc.stdin.write(stdin_input.encode())
            await proc.stdin.drain()
        proc.stdin.close()

    async def read_stdout():
        data = await proc.stdout.read()
        stdout_chunks.append(data.decode(errors="replace"))

    async def read_stderr():
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            decoded = line.decode(errors="replace").rstrip()
            stderr_lines.append(decoded)
            if line_callback:
                line_callback(decoded)

    async def _terminate():
        """Kill the child and REAP it. proc.kill() alone leaves a zombie."""
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass            # already gone
            try:
                await proc.wait()
            except Exception:
                pass

    try:
        await asyncio.wait_for(
            asyncio.gather(feed_stdin(), read_stdout(), read_stderr()),
            timeout=timeout,
        )
        await proc.wait()
    except asyncio.TimeoutError:
        await _terminate()
        return {"returncode": -1, "stdout": "".join(stdout_chunks),
                "stderr": "\n".join(stderr_lines) + "\n[Timed out]",
                "success": False, "cmd": " ".join(cmd)}
    except asyncio.CancelledError:
        # The job was cancelled. Without this, task.cancel() unwinds the await
        # but leaves gmx running to completion, burning CPU on work nobody
        # wants and holding the output file open.
        await _terminate()
        raise

    return {
        "returncode": proc.returncode,
        "stdout": "".join(stdout_chunks),
        "stderr": "\n".join(stderr_lines),
        "success": proc.returncode == 0,
        "cmd": " ".join(cmd),
    }


# ─── Index group utilities ────────────────────────────────────────────────────

def parse_gmx_groups(output: str) -> list[dict]:
    """Parse group listing. Lines like:  '  0 System : 12345 atoms'"""
    groups = []
    pattern = re.compile(r'^\s*(\d+)\s+(\S+)\s*:\s*(\d+)\s*atoms', re.MULTILINE)
    for m in pattern.finditer(output):
        groups.append({
            "index": int(m.group(1)),
            "name": m.group(2),
            "n_atoms": int(m.group(3)),
        })
    return groups


async def get_index_groups(tpr_path: Path, ndx_path: Optional[Path] = None) -> list[dict]:
    """List available index groups from a .tpr (and optionally .ndx) file."""
    args = ["make_ndx", "-f", str(tpr_path), "-o", "/tmp/_gromax_scratch.ndx"]
    if ndx_path and ndx_path.exists():
        args += ["-n", str(ndx_path)]
    result = await run_gmx(args, stdin_input="q\n", timeout=60)
    groups = parse_gmx_groups(result["stdout"] + result["stderr"])
    seen, unique = set(), []
    for g in groups:
        if g["index"] not in seen:
            seen.add(g["index"])
            unique.append(g)
    return unique


async def create_ndx_from_selection(tpr_path: Path, output_ndx: Path,
                                    selections: list[str], base_ndx: Optional[Path] = None) -> dict:
    args = ["make_ndx", "-f", str(tpr_path), "-o", str(output_ndx)]
    if base_ndx and base_ndx.exists():
        args += ["-n", str(base_ndx)]
    stdin = "\n".join(selections) + "\nq\n"
    return await run_gmx(args, stdin_input=stdin, timeout=120)


# ─── Result caching ───────────────────────────────────────────────────────────

def _file_identity(path) -> Optional[tuple]:
    """
    A cheap identity for a file: (resolved path, mtime_ns, size).

    Used to key caches on file CONTENT rather than just filename. If a
    trajectory is regenerated and overwrites the same path, the identity
    changes and anything keyed on it is invalidated automatically.

    Returns None if the file can't be stat'ed (caller should then skip caching).
    """
    try:
        p = Path(path)
        st = p.stat()
        return (str(p.resolve()), st.st_mtime_ns, st.st_size)
    except OSError:
        return None


# Frame-count cache: {file identity -> info dict}. In-memory only; `gmx check`
# is cheap to redo once per server start, and this avoids any staleness on disk.
_FRAME_INFO_CACHE: dict = {}


def make_analysis_hash(analysis_type: str, params: dict) -> str:
    content = json.dumps({"type": analysis_type, **params}, sort_keys=True)
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def get_cached_result(session_id: str, cache_key: str) -> Optional[dict]:
    cache_file = session_dir(session_id) / "cache" / f"{cache_key}.json"
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text())
        except Exception:
            return None
    return None


def save_cached_result(session_id: str, cache_key: str, data: dict):
    cache_dir = session_dir(session_id) / "cache"
    cache_dir.mkdir(exist_ok=True)
    (cache_dir / f"{cache_key}.json").write_text(json.dumps(data))


# ─── XVG parser ───────────────────────────────────────────────────────────────

def parse_xvg(xvg_path: Path) -> dict:
    """Parse a GROMACS .xvg file into series arrays + axis metadata."""
    x: list[float] = []
    ys: list[list[float]] = []
    xlabel = ylabel = title = ""
    legend_labels: list[str] = []

    with open(xvg_path) as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s.startswith("@"):
                # GROMACS pads these directives, e.g. '@    title "RMSD"' and
                # '@    xaxis  label "Time (ps)"'. Matching on a fixed prefix
                # like '@ title' silently never fires on real output, so match
                # the KEYWORD with flexible whitespace instead.
                if re.match(r'@\s*xaxis\s+label', s):
                    xlabel = s.split('"')[1] if '"' in s else ""
                elif re.match(r'@\s*yaxis\s+label', s):
                    ylabel = s.split('"')[1] if '"' in s else ""
                elif re.match(r'@\s*title\b', s):
                    title = s.split('"')[1] if '"' in s else ""
                elif re.match(r'@\s*s\d+\s+legend', s):
                    legend_labels.append(s.split('"')[1] if '"' in s else "")
                continue
            parts = s.split()
            try:
                vals = [float(p) for p in parts]
            except ValueError:
                continue
            x.append(vals[0])
            if not ys:
                ys = [[] for _ in vals[1:]]
            for i, v in enumerate(vals[1:]):
                if i < len(ys):
                    ys[i].append(v)

    return {
        "x": x, "y_series": ys,
        "labels": legend_labels or ([ylabel] if ylabel else ["value"]),
        "xlabel": xlabel, "ylabel": ylabel, "title": title,
    }


# ─── API routes ───────────────────────────────────────────────────────────────

@router.get("/version")
def gmx_version():
    from .appconfig import probe_gmx
    try:
        gmx = get_gmx_executable()
        status = probe_gmx(gmx)
        return {"available": status["found"], "version": status.get("version"), "executable": gmx}
    except Exception as e:
        return {"available": False, "version": None, "executable": None, "error": str(e)}


class IndexGroupRequest(BaseModel):
    session_id: str
    condition_id: str

@router.post("/index-groups")
async def list_index_groups(req: IndexGroupRequest):
    state = load_state(req.session_id)
    if req.condition_id not in state.conditions:
        raise HTTPException(status_code=404, detail="Condition not found")
    cond = state.conditions[req.condition_id]
    tpr = next((v for k, v in cond.files.items() if k.startswith("tpr")), None)
    if not tpr:
        raise HTTPException(status_code=400, detail="No .tpr file registered")
    groups = await get_index_groups(Path(tpr))
    return {"groups": groups}


class CreateNdxRequest(BaseModel):
    session_id: str
    condition_id: str
    group_name: str
    selections: list[str]

@router.post("/create-ndx")
async def create_index_group(req: CreateNdxRequest):
    state = load_state(req.session_id)
    if req.condition_id not in state.conditions:
        raise HTTPException(status_code=404, detail="Condition not found")
    cond = state.conditions[req.condition_id]
    tpr = next((v for k, v in cond.files.items() if k.startswith("tpr")), None)
    if not tpr:
        raise HTTPException(status_code=400, detail="No .tpr file")
    ndx_dir = session_dir(req.session_id) / "ndx"
    ndx_dir.mkdir(exist_ok=True)
    safe_name = re.sub(r'[^\w\-]', '_', req.group_name)
    output_ndx = ndx_dir / f"{safe_name}.ndx"
    result = await create_ndx_from_selection(Path(tpr), output_ndx, req.selections)
    if result["success"]:
        # Re-load under the lock rather than reusing the `state` read before the
        # await — it may be stale, and writing it back would clobber anything
        # saved while make_ndx was running.
        with locked_state(req.session_id) as fresh:
            fresh.index_groups[req.group_name] = str(output_ndx)
        return {"ok": True, "ndx_path": str(output_ndx), "group_name": req.group_name}
    raise HTTPException(status_code=500, detail=f"make_ndx failed: {result['stderr']}")


# ─── Trajectory & selection introspection (for PCA setup) ─────────────────────

async def count_frames(tpr: str, xtc: str) -> dict:
    """
    Return {"n_frames", "t_start_ps", "t_end_ps", "dt_ps"} for a trajectory.
    Uses `gmx check`, which prints a table like:
        Item        #frames Timestep (ps)
        Coords       5001    20
    to stderr. We parse frame count and timestep robustly across versions.

    CACHED on file identity (path + mtime + size). `gmx check` streams the whole
    trajectory, which is slow for a large .xtc and was being repeated on every
    PCA setup. The frame count cannot change unless the file changes, so keying
    on mtime+size is both correct and self-invalidating: overwrite the .xtc and
    the next call re-reads it.
    """
    ident = _file_identity(xtc)
    if ident is not None:
        hit = _FRAME_INFO_CACHE.get(ident)
        if hit is not None:
            return dict(hit)

    result = await run_gmx(["check", "-f", xtc], timeout=600)
    text = result["stdout"] + result["stderr"]
    n_frames = None
    dt_ps = None
    t_end_ps = None

    # Primary: the "Coords   <nframes>   <dt>" table row
    m_coords = re.search(r'Coords\s+(\d+)\s+([\d.]+)', text)
    if m_coords:
        n_frames = int(m_coords.group(1))
        dt_ps = float(m_coords.group(2))
    else:
        # Coords row without dt
        m_c2 = re.search(r'Coords\s+(\d+)', text)
        if m_c2:
            n_frames = int(m_c2.group(1))

    # Timestep printed separately in some versions
    if dt_ps is None:
        m_dt = re.search(r'(?:Time between frames|Timestep)\D+([\d.]+)', text)
        if m_dt:
            dt_ps = float(m_dt.group(1))

    # Last frame time
    m_last = re.search(r'Last frame\s+(\d+)\s+time\s+([\d.]+)', text)
    if m_last:
        t_end_ps = float(m_last.group(2))
        if n_frames is None:
            n_frames = int(m_last.group(1)) + 1

    # If we have n_frames + dt but no explicit end time, derive it
    if t_end_ps is None and n_frames is not None and dt_ps is not None:
        t_end_ps = (n_frames - 1) * dt_ps

    # FIRST frame time. This docstring has always promised t_start_ps and this
    # function never returned it — harmless while nothing read it, but a
    # trajectory trimmed with -b does NOT start at zero, and anything mapping a
    # frame index back to a time needs the real origin. gmx check prints
    # "Reading frame    0 time  200000.000" as it streams, so take the first
    # such line rather than assuming zero.
    t_start_ps = None
    m_first = re.search(r'Reading frame\s+\d+\s+time\s+([-\d.]+)', text)
    if m_first:
        try:
            t_start_ps = float(m_first.group(1))
        except ValueError:
            t_start_ps = None
    if (t_start_ps is None and t_end_ps is not None
            and n_frames is not None and dt_ps is not None):
        t_start_ps = t_end_ps - (n_frames - 1) * dt_ps

    info = {
        "n_frames": n_frames,
        "t_start_ps": t_start_ps,
        "t_end_ps": t_end_ps,
        "dt_ps": dt_ps,
        "raw": text[-800:] if n_frames is None else None,
    }

    # Only cache a successful read — a failed parse should be retried, not stuck.
    if ident is not None and n_frames is not None:
        _FRAME_INFO_CACHE[ident] = dict(info)
    return info


async def count_selection_atoms(tpr: str, selection: str, work_dir: Path) -> dict:
    """
    Resolve a make_ndx selection against a tpr and return the atom count.
    Returns {"ok": bool, "n_atoms": int|None, "error": str|None}.

    Robust approach: we DON'T guess the new group's numeric index. We create the
    selection as the last group, then read the LAST group block in the resulting
    .ndx file. Each call uses a UNIQUE output file (based on tpr + selection hash)
    so concurrent/repeated checks across replicas never contaminate each other.
    """
    import hashlib
    work_dir.mkdir(parents=True, exist_ok=True)
    # Unique filename per (tpr, selection) so calls never clobber each other.
    tag = hashlib.sha256(f"{tpr}|{selection}".encode()).hexdigest()[:12]
    ndx = work_dir / f"_count_{tag}.ndx"
    if ndx.exists():
        ndx.unlink()

    # Just enter the selection and quit — the new group is appended to the ndx.
    stdin = f"{selection}\nq\n"
    res = await run_gmx(["make_ndx", "-f", tpr, "-o", str(ndx)],
                        stdin_input=stdin, timeout=120)
    if not ndx.exists():
        return {"ok": False, "n_atoms": None,
                "error": (res["stderr"][-400:] or "make_ndx produced no ndx")}

    last = _last_group_in_ndx(ndx)
    # Clean up immediately so a stale file can never be read later.
    try:
        ndx.unlink()
    except OSError:
        pass

    if last is None:
        return {"ok": False, "n_atoms": None,
                "error": "No group was created by the selection (empty or invalid)."}

    name, n_atoms = last
    if n_atoms == 0:
        return {"ok": False, "n_atoms": 0,
                "error": f"Selection matched 0 atoms (group '{name}')."}
    return {"ok": True, "n_atoms": n_atoms, "error": None,
            "ndx": str(ndx), "group_name": name}


def _last_group_in_ndx(ndx_path: Path) -> Optional[tuple[str, int]]:
    """Return (name, atom_count) of the LAST group block in an ndx file."""
    lines = ndx_path.read_text().splitlines()
    groups = []  # list of [name, count]
    for ln in lines:
        s = ln.strip()
        if s.startswith("["):
            groups.append([s.strip("[] ").strip(), 0])
        elif s and groups:
            groups[-1][1] += len(s.split())
    if not groups:
        return None
    name, count = groups[-1]
    return (name, count)


def _count_atoms_in_ndx_group(ndx_path: Path, group_name: str) -> Optional[int]:
    """Count atom indices under [ group_name ] in an ndx file."""
    lines = ndx_path.read_text().splitlines()
    in_group = False
    count = 0
    for ln in lines:
        s = ln.strip()
        if s.startswith("["):
            name = s.strip("[] ").strip()
            in_group = (name == group_name)
            continue
        if in_group and s:
            count += len(s.split())
    return count if count > 0 else None


def read_pdb_residue_numbers(path: Path) -> Optional[list[int]]:
    """
    The residue number of every ATOM/HETATM record, in file order.

    Used to learn which residue each row of a matrix belongs to, from a PDB
    GROMACS wrote for exactly that group of atoms. Returns None if anything is
    unreadable rather than a partial list — a short read would misalign every
    row after the gap, which looks entirely plausible and is entirely wrong.

    PDB resSeq is four columns wide, so GROMACS wraps past 9999. An index group
    is sorted by atom index and therefore by residue, so residue numbers can
    only ever go up: a DECREASE is a wrap and nothing else, which makes it safe
    to unwrap by carrying a multiple of 10000.
    """
    if not Path(path).is_file():
        return None
    resnums: list[int] = []
    carry = 0
    prev = None
    for line in Path(path).read_text().splitlines():
        if not line.startswith(("ATOM", "HETATM")):
            continue
        try:
            raw = int(line[22:26])
        except ValueError:
            return None
        if prev is not None and raw < prev:
            carry += 10000
        prev = raw
        resnums.append(raw + carry)
    return resnums

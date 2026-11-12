"""
Running an analysis on a chosen subset of replicas.

Two properties matter more than the feature itself:

  AN UNKNOWN INDEX IS REFUSED, NOT IGNORED. Dropping it silently would compute
  a mean over fewer replicas than the user believes they included, and nothing
  on the plot would say so.

  THE CACHE KEY FOR "ALL REPLICAS" IS UNCHANGED. The subset is folded into the
  hash only when it IS a subset. Hashing it unconditionally would orphan every
  analysis ever cached and silently force hours of recomputation.

The engine is stubbed: this is about which replicas reach it, not about what it
then does with them.
"""
import asyncio
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.config import settings

TMP = Path(tempfile.mkdtemp())
settings.projects_dir = TMP / "projects"

import core.session as S
# Stays on analysis_runner: RunRequest and _make_run_coro are the
# orchestration that module kept when ndx_builder/replica_agg/
# engine_process/derived were split out of it.
import core.analysis_runner as AR

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


# ─── A project with four paired replicas ─────────────────────────────────────
state = S.create_session(S.CreateSessionRequest(name="Reps"))
SID = state.id
COND = "cond0001"
files = TMP / "traj"
files.mkdir(parents=True, exist_ok=True)
reps = []
for i in (1, 2, 3, 4):
    for ext in ("tpr", "xtc"):
        (files / f"r{i}.{ext}").write_text(f"replica {i} {ext}")
    reps.append({"index": i, "paired": True,
                 "tpr": str(files / f"r{i}.tpr"), "xtc": str(files / f"r{i}.xtc")})

with S.locked_state(SID) as st:
    st.conditions[COND] = S.Condition(id=COND, name="WT", colour="#4f8ef7",
                                      replicas=reps, pdb=str(files / "ref.pdb"))

# ─── A stub engine that records which replica it was handed ──────────────────
SEEN: list[int] = []


class _Stub:
    async def run(self, ctx, work_dir, line_callback=None):
        SEEN.append(int(Path(ctx["xtc"]).stem[1:]))     # r3.xtc -> 3
        return {"kind": "line", "x": [0.0, 1.0], "y": [1.0, 2.0],
                "xlabel": "Time (ns)", "ylabel": "y", "title": "stub"}


AR.get_engine_analysis = lambda engine, atype: _Stub()

LOG: list[str] = []


def run(replicas=None, force=True):
    SEEN.clear()
    LOG.clear()
    req = AR.RunRequest(session_id=SID, analysis_type="rmsf", engine="mdanalysis",
                        condition_ids=[COND], groups=["name CA"],
                        analysis_name="sub", force=force,
                        replicas=(replicas if replicas is not None else {}))
    coro = AR._make_run_coro(req, COND)
    return asyncio.run(coro(lambda p: None, LOG.append))


print("1. by default every paired replica runs")
agg = run()
check("all four ran", SEEN == [1, 2, 3, 4], SEEN)
check("the result says so", agg["n_replicas"] == 4)
check("and names them", agg["replica_indices"] == [1, 2, 3, 4],
      agg.get("replica_indices"))

print("\n2. a subset runs exactly the replicas asked for")
agg = run({COND: [2, 4]})
check("only replicas 2 and 4 ran", SEEN == [2, 4], SEEN)
check("n_replicas follows", agg["n_replicas"] == 2)
check("the indices are the chosen ones, not 1..n",
      agg["replica_indices"] == [2, 4], agg.get("replica_indices"))
check("the per-replica series keep their own numbers",
      [r["index"] for r in agg["replicas"]] == [2, 4],
      [r["index"] for r in agg["replicas"]])
check("the log says a subset is running",
      any("Running 2 of 4 replicas" in l for l in LOG),
      next((l for l in LOG if "Running" in l), "no such line"))

print("\n3. order does not matter, and one replica is allowed")
run({COND: [4, 1]})
check("the given order does not reorder the run", SEEN == [1, 4], SEEN)
agg = run({COND: [3]})
check("a single replica works", SEEN == [3] and agg["n_replicas"] == 1, SEEN)

print("\n4. a replica that does not exist is refused, never ignored")
for bad in ([5], [0], [2, 9]):
    try:
        run({COND: bad})
        check(f"{bad} is refused", False, "it ran anyway")
    except RuntimeError as e:
        msg = str(e)
        check(f"{bad} is refused",
              "has no replica" in msg and "Paired replicas here are: 1, 2, 3, 4" in msg,
              msg.splitlines()[0][:78])

print("\n5. the cache key")
KEYS = {}
_orig_save = AR.save_cached_result


def _spy(session_id, key, data):
    KEYS[tuple(sorted(SEEN))] = key
    return _orig_save(session_id, key, data)


AR.save_cached_result = _spy
run()                       # no `replicas` field at all — the old client
key_all_implicit = KEYS[(1, 2, 3, 4)]
run({COND: [1, 2, 3, 4]})   # every replica named explicitly
key_all_explicit = KEYS[(1, 2, 3, 4)]
check("naming every replica hashes the same as naming none",
      key_all_implicit == key_all_explicit,
      f"{key_all_implicit[:12]} vs {key_all_explicit[:12]}")

run({COND: [1, 2]})
key_12 = KEYS[(1, 2)]
run({COND: [3, 4]})
key_34 = KEYS[(3, 4)]
check("a subset does not collide with the full run",
      key_12 != key_all_implicit)
check("two subsets of the same size do not collide with each other",
      key_12 != key_34, f"{key_12[:12]} vs {key_34[:12]}")
AR.save_cached_result = _orig_save

print("\n6. a cached subset is returned without re-running")
run({COND: [2, 4]}, force=True)
run({COND: [2, 4]}, force=False)
check("the second run hit the cache instead of the engine", SEEN == [], SEEN)
check("and said so", any("cache" in l.lower() for l in LOG),
      next((l for l in LOG if "cache" in l.lower()), "no such line"))

import shutil
shutil.rmtree(TMP, ignore_errors=True)
print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

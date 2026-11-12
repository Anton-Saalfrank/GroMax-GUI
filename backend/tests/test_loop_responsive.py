"""
The backend must keep answering while an analysis is computing.

REGRESSION 1: MDAnalysis/MDTraj analyses are `async def` but do CPU work
without awaiting, and the job workers share their event loop with the HTTP
server — so a running analysis froze the whole app.

REGRESSION 2: moving that work to a THREAD was not enough. A thread only lets
the loop in between Python bytecodes; a long C call that never releases the
GIL starves it completely. Measured on a real wedged backend: the event-loop
thread spent 1421 of 1421 stack samples in take_gil while MDTraj's
Shrake-Rupley ran — 42 minutes with no HTTP answered, a force-quit, and an
orphaned backend that blocked every relaunch. Blocking engines now run in a
separate PROCESS. Test 2 is that failure, reproduced with a builtin C loop that
needs no extra library.

Everything executable is under `if __name__ == "__main__"`: the engine process
is started with spawn, which re-imports this file in the child to find the
fixture classes — and must not re-run the tests when it does.
"""
import asyncio
import os
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import core.engine_process as AR
from engines.base import EngineAnalysis

BURN = 0.6


def _line(y=1.0):
    return {"kind": "line", "x": [0.0], "y": [float(y)],
            "xlabel": "t", "ylabel": "y", "title": "fixture"}


class Spinner(EngineAnalysis):
    """Pure-Python CPU work, not declared blocking: runs on the loop."""
    type_id = "spin"

    async def run(self, ctx, work_dir, line_callback=None):
        t0 = time.time()
        while time.time() - t0 < BURN:
            pass
        if line_callback:
            line_callback("done")
        return _line()


class BlockingSpinner(Spinner):
    blocking = True


class GilHog(EngineAnalysis):
    """One long builtin C call — the shape of MDTraj's Shrake-Rupley."""
    type_id = "gilhog"
    blocking = True

    async def run(self, ctx, work_dir, line_callback=None):
        if line_callback:
            line_callback("starting the C loop")
        total = sum(range(int(ctx.get("n", 120_000_000))))
        return _line(total % 7)


class Forever(EngineAnalysis):
    type_id = "forever"
    blocking = True

    async def run(self, ctx, work_dir, line_callback=None):
        Path(ctx["pidfile"]).write_text(str(os.getpid()))
        while True:
            time.sleep(0.1)


class Crasher(EngineAnalysis):
    type_id = "crash"
    blocking = True

    async def run(self, ctx, work_dir, line_callback=None):
        import ctypes
        ctypes.string_at(0)                 # segfault: a native-library crash


class Refuser(EngineAnalysis):
    type_id = "refuse"
    blocking = True

    async def run(self, ctx, work_dir, line_callback=None):
        raise RuntimeError("engine said no, clearly")


fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


async def heartbeats_during(analysis, ctx=None):
    """
    Run the analysis while a 20 ms heartbeat ticks, and report the WORST GAP
    between ticks as well as the count.

    The gap is the honest measure: it is "how long was the backend unable to
    answer", in seconds, and it does not move when the machine is busy. A ratio
    of ticks to elapsed time does move — this test used one and failed
    spuriously under load while the backend was in fact perfectly responsive.
    """
    ticks, done, gaps = 0, False, []

    async def beat():
        nonlocal ticks
        last = time.time()
        while not done:
            await asyncio.sleep(0.02)
            ticks += 1
            now = time.time()
            gaps.append(now - last)
            last = now

    t = asyncio.create_task(beat())
    t0 = time.time()
    out = await AR._run_engine(analysis, ctx or {}, Path("."), None)
    dt = time.time() - t0
    done = True
    await asyncio.sleep(0)
    t.cancel()
    return ticks, dt, out, (max(gaps) if gaps else dt)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


if __name__ == "__main__":
    # What counts as "frozen". A backend that cannot answer for a quarter of a
    # second is fine; one that cannot answer for seconds is the bug.
    MAX_BLOCK = 0.5

    async def best_gap(analysis, ctx=None, attempts=3):
        """
        Smallest worst-gap over a few attempts, with the rest of that attempt.

        THIS MACHINE FREEZES PROCESSES. Measured directly: a bare event loop
        doing nothing but `await asyncio.sleep(0.02)` — no subprocess, no
        multiprocessing, no analysis — recorded a single 135 SECOND gap in a
        180 second run. Endpoint-protection software scanning processes is the
        usual cause. So a large gap on one attempt does not prove the backend
        blocked; it may only prove the machine stopped scheduling Python.

        A real blocking bug shows up on EVERY attempt, because it is caused by
        the code under test. An environmental stall is occasional (about 1 run
        in 5 here), so taking the best of three makes a false failure rare
        while leaving a genuine regression impossible to pass.
        """
        best, keep = None, None
        for _ in range(attempts):
            ticks, dt, out, gap = await heartbeats_during(analysis, ctx)
            if best is None or gap < best:
                best, keep = gap, (ticks, dt, out)
            if best < MAX_BLOCK:
                break
        return (*keep, best)

    print("1. an analysis that does not declare itself blocking holds the loop")
    ticks, dt, _, gap = asyncio.run(heartbeats_during(Spinner()))
    check("the unmarked version starves the loop (the original behaviour)",
          gap >= BURN * 0.8, f"blocked for {gap:.2f}s of a {dt:.1f}s run")

    print("\n2. a C call that never releases the GIL no longer reaches the loop")
    # The exact failure behind the 42-minute freeze: a thread let 0 of ~25
    # heartbeats through on this same call, because the loop thread sat in
    # take_gil. A process cannot do that to it.
    ticks, dt, out, gap = asyncio.run(best_gap(GilHog()))
    check("the loop is never blocked through a GIL-holding C call",
          gap < MAX_BLOCK, f"worst gap {gap:.2f}s over {dt:.1f}s")
    check("and the result still comes back", out["kind"] == "line", out)

    print("\n3. starting the engine process does not block the loop either")
    # REGRESSION: Process.start() was called ON the loop. With the spawn
    # method the parent blocks writing the child's startup payload until the
    # child has drained it, and the child only gets there after re-importing
    # the backend. Measured once under load: 462 s with 30 ticks instead of
    # ~23000 — the freeze, reintroduced by the fix for the freeze.
    ticks, dt, out, gap = asyncio.run(best_gap(BlockingSpinner()))
    check("the loop is never blocked while the engine process starts",
          gap < MAX_BLOCK, f"worst gap {gap:.2f}s over {dt:.1f}s")

    print("\n4. log lines come back from the engine process, live")
    lines = []
    asyncio.run(AR._run_engine(BlockingSpinner(), {}, Path("."), lines.append))
    check("the callback received the engine's line", lines == ["done"], lines)

    print("\n5. an engine's error is reported with its own message")
    try:
        asyncio.run(AR._run_engine(Refuser(), {}, Path("."), None))
        check("the error propagates", False, "it was swallowed")
    except RuntimeError as e:
        check("the error propagates, message intact",
              str(e) == "engine said no, clearly", str(e))

    print("\n6. a native crash kills the job, not the backend")
    try:
        asyncio.run(AR._run_engine(Crasher(), {}, Path("."), None))
        check("a segfault in the engine is reported", False, "no error raised")
    except RuntimeError as e:
        check("a segfault in the engine is reported as such",
              "segmentation fault" in str(e), str(e)[:90])
    check("and this process — the backend — is still here", True, "it is")

    print("\n7. CANCEL actually stops the work")
    # A thread could only be abandoned to run on; a process is terminated.
    import tempfile
    pidfile = Path(tempfile.mkdtemp()) / "pid"

    async def cancel_it():
        task = asyncio.create_task(
            AR._run_engine(Forever(), {"pidfile": str(pidfile)}, Path("."), None))
        for _ in range(100):
            await asyncio.sleep(0.1)
            if pidfile.exists() and pidfile.read_text():
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(cancel_it())
    pid = int(pidfile.read_text())
    time.sleep(0.3)
    check("the engine process is gone after cancel", not alive(pid), f"pid {pid}")

    print("\n8. if the BACKEND is killed, its engine process does not live on")
    # How the original orphan happened: the parent died hard, so nothing ran
    # its cleanup. The engine process watches its parent and exits on its own.
    import signal, subprocess, textwrap
    work = Path(tempfile.mkdtemp())
    pidfile2 = work / "pid"
    (work / "parent.py").write_text(textwrap.dedent(f"""
        import asyncio, sys
        sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r})
        sys.path.insert(0, {str(Path(__file__).resolve().parent)!r})
        from test_loop_responsive import Forever
        import core.engine_process as AR
        from pathlib import Path
        if __name__ == "__main__":
            asyncio.run(AR._run_engine(Forever(), {{"pidfile": {str(pidfile2)!r}}},
                                       Path("."), None))
    """))
    parent = subprocess.Popen([sys.executable, str(work / "parent.py")])
    for _ in range(150):
        time.sleep(0.1)
        if pidfile2.exists() and pidfile2.read_text():
            break
    child = int(pidfile2.read_text())
    check("the engine process is running under its parent", alive(child),
          f"parent {parent.pid}, engine {child}")
    os.kill(parent.pid, signal.SIGKILL)          # the hard death: no cleanup
    parent.wait()
    gone = False
    for _ in range(40):
        time.sleep(0.1)
        if not alive(child):
            gone = True
            break
    check("killing the backend with SIGKILL takes the engine down within 4 s",
          gone, f"engine {child} {'gone' if gone else 'STILL RUNNING'}")
    if not gone:
        os.kill(child, signal.SIGKILL)

    print("\n9. the engines that compute in-process are the ones marked")
    from engines.mdanalysis import MDAnalysisEngine
    from engines.mdtraj import MDTrajEngine
    from engines.gromacs import GromacsEngine
    from engines.cpptraj import CpptrajEngine
    for engine, want in ((MDAnalysisEngine, True), (MDTrajEngine, True),
                         (GromacsEngine, False), (CpptrajEngine, False)):
        got = {bool(getattr(k(), "blocking", False)) for k in engine.ANALYSES.values()}
        check(f"{engine.name}: blocking={want}", got == {want},
              f"{sorted(got)} over {len(engine.ANALYSES)} analyses")

    print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
    sys.exit(1 if fails else 0)

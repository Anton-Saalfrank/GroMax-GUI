"""
Tests for runtime behaviour: frame/stride argument building, job cancellation,
and subprocess cleanup.

These cover the v38 correctness fixes. Each one encodes a bug that shipped and
would be easy to reintroduce:

  REGRESSION (stride): `stride` was accepted by the API and folded into the
  cache key but never reached gmx, so setting it re-ran the analysis and
  produced byte-identical data at full cost.

  REGRESSION (cancel): cancel_job() only set a status field. The coroutine and
  its gmx subprocess kept running, and the worker then overwrote the status
  back to COMPLETED — so cancelling neither stopped the work nor stuck.

  REGRESSION (reap): proc.kill() on timeout was never followed by proc.wait(),
  leaving zombie processes to accumulate over a long session.

Run:  python3 backend/tests/test_runtime.py
"""

import asyncio
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import core.gmx as gmx
from core.jobs import JobManager, JobStatus
from analyses.rmsd import RMSDAnalysis
from analyses.rmsf import RMSFAnalysis


BASE_CTX = {"tpr": "s.tpr", "xtc": "t.xtc", "_out_xvg": "o.xvg"}


# ─── stride / frame args ──────────────────────────────────────────────────────

def test_stride_one_emits_no_dt():
    args = RMSDAnalysis().build_args({**BASE_CTX, "stride": 1, "dt_ps": 20})
    assert "-dt" not in args


def test_stride_emits_dt_in_picoseconds():
    """REGRESSION: stride never reached the command line at all.

    gmx -dt filters on TIME, so stride N with a 20 ps timestep is -dt 200.
    """
    args = RMSDAnalysis().build_args({**BASE_CTX, "stride": 10, "dt_ps": 20})
    assert "-dt" in args
    assert float(args[args.index("-dt") + 1]) == 200.0


def test_stride_scales_with_trajectory_timestep():
    args = RMSDAnalysis().build_args({**BASE_CTX, "stride": 5, "dt_ps": 2})
    assert float(args[args.index("-dt") + 1]) == 10.0


def test_stride_without_known_timestep_does_not_guess():
    """A wrong -dt silently keeps or drops every frame, so we must not guess."""
    args = RMSDAnalysis().build_args({**BASE_CTX, "stride": 10, "dt_ps": None})
    assert "-dt" not in args


def test_stride_composes_with_time_window():
    args = RMSDAnalysis().build_args({
        **BASE_CTX, "stride": 2, "dt_ps": 20, "time_start": 100, "time_end": 500,
    })
    # ns -> ps conversion must still hold, and -tu must never appear
    assert float(args[args.index("-b") + 1]) == 100_000.0
    assert float(args[args.index("-e") + 1]) == 500_000.0
    assert float(args[args.index("-dt") + 1]) == 40.0
    assert "-tu" not in args


def test_time_args_alias_still_works():
    """Kept for any custom analysis module still calling the old name."""
    a = RMSFAnalysis()
    assert a.time_args({**BASE_CTX, "time_start": 10}) == \
           a.frame_args({**BASE_CTX, "time_start": 10})


# ─── job cancellation ─────────────────────────────────────────────────────────

def _sleepers() -> int:
    """
    How many stand-in child processes are alive.

    Counted by listing pids, NOT with `pgrep -c`: -c is a procps (Linux) flag
    that BSD/macOS pgrep does not have. There it exits with a usage message and
    an EMPTY stdout, so this returned 0 unconditionally — which made the
    positive assertion ("child did not start") fail and, worse, made the
    assertion these tests exist for ("gmx kept running after cancel") pass
    without ever looking at anything.
    """
    proc = subprocess.run(["pgrep", "-f", "^/bin/sleep 30"],
                          capture_output=True, text=True)
    # pgrep exits 1 when nothing matched, which is a real answer, not an error.
    if proc.returncode not in (0, 1):
        raise RuntimeError(
            f"pgrep failed ({proc.returncode}): {proc.stderr.strip()[:200]}")
    return len([ln for ln in proc.stdout.split("\n") if ln.strip()])


def test_cancel_stops_the_work():
    """REGRESSION: cancel used to be cosmetic and got overwritten by COMPLETED.

    The meaningful assertion is that the CHILD PROCESS dies. Checking only a
    "did the coroutine finish" flag is vacuous: a long-running job hasn't
    finished yet either way, so such a test passes against the broken code.
    Here the job runs the real run_gmx() path (with /bin/sleep standing in for
    the gmx binary) and we count live children directly.
    """
    async def scenario():
        original = gmx.get_gmx_executable
        gmx.get_gmx_executable = lambda: "/bin/sleep"
        try:
            base = _sleepers()
            jm = JobManager(max_workers=2)
            await jm.start()
            started = asyncio.Event()
            completed = {"ran": False}

            async def slow(progress_cb, log_cb):
                started.set()
                await gmx.run_gmx(["30"], timeout=120)
                completed["ran"] = True
                return {"ok": True}

            job = jm.submit("s", "c", "test", "slow", slow)
            await asyncio.wait_for(started.wait(), timeout=5)
            await asyncio.sleep(0.5)
            assert _sleepers() - base == 1, "child process did not start"

            assert jm.cancel_job(job.id) is True
            await asyncio.sleep(0.8)

            assert jm.get_job(job.id).status == JobStatus.CANCELLED
            assert _sleepers() - base == 0, "gmx kept running after cancel"
            assert completed["ran"] is False, "work continued after cancel"
            await jm.stop()
        finally:
            gmx.get_gmx_executable = original

    _run(scenario)


def test_cancelled_job_is_not_resurrected():
    """A cancel landing near the end must not flip the status to COMPLETED."""
    async def scenario():
        jm = JobManager(max_workers=1)
        await jm.start()
        started = asyncio.Event()

        async def quick(progress_cb, log_cb):
            started.set()
            await asyncio.sleep(0.4)     # not cancellable-blocking; returns fine
            return {"ok": True}

        job = jm.submit("s", "c", "test", "quick", quick)
        await asyncio.wait_for(started.wait(), timeout=5)
        jm._jobs[job.id].status = JobStatus.CANCELLED   # simulate late cancel
        await asyncio.sleep(0.9)

        assert jm.get_job(job.id).status == JobStatus.CANCELLED, \
            "completed work overwrote a CANCELLED status"
        await jm.stop()

    _run(scenario)


def test_cancel_while_queued_never_starts():
    async def scenario():
        jm = JobManager(max_workers=1)
        ran = {"n": 0}

        async def work(progress_cb, log_cb):
            ran["n"] += 1
            return {}

        job = jm.submit("s", "c", "test", "queued", work)
        jm.cancel_job(job.id)          # cancel BEFORE workers start
        await jm.start()
        await asyncio.sleep(0.5)

        assert jm.get_job(job.id).status == JobStatus.CANCELLED
        assert ran["n"] == 0, "cancelled job was executed anyway"
        await jm.stop()

    _run(scenario)


def test_max_workers_override():
    async def scenario():
        jm = JobManager(max_workers=4)
        await jm.start(max_workers=2)
        assert jm._max_workers == 2
        await jm.stop()

    _run(scenario)


# ─── subprocess reaping ───────────────────────────────────────────────────────

def test_no_orphan_after_cancel_or_timeout():
    """REGRESSION: proc.kill() without proc.wait() left zombies."""
    async def scenario():
        original = gmx.get_gmx_executable
        gmx.get_gmx_executable = lambda: "/bin/sleep"
        try:
            base = _sleepers()

            task = asyncio.create_task(gmx.run_gmx(["30"], timeout=60))
            await asyncio.sleep(0.5)
            assert _sleepers() - base == 1, "child did not start"
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            await asyncio.sleep(0.4)
            assert _sleepers() - base == 0, "orphaned process after cancel"

            res = await gmx.run_gmx(["30"], timeout=1)
            await asyncio.sleep(0.4)
            assert _sleepers() - base == 0, "orphaned process after timeout"
            assert "[Timed out]" in res["stderr"]
        finally:
            gmx.get_gmx_executable = original

    _run(scenario)


# ─── runner ───────────────────────────────────────────────────────────────────

def _run(coro_fn, limit: float = 10.0):
    """Run an async scenario with a hard ceiling.

    Without this, a regression in cancellation makes the suite HANG rather than
    fail — the un-cancelled child runs to completion. A timeout turns that into
    a clean, readable failure.
    """
    async def guarded():
        await asyncio.wait_for(coro_fn(), timeout=limit)
    asyncio.run(guarded())


if __name__ == "__main__":
    import traceback

    passed = failed = 0
    for name, fn in sorted(list(globals().items())):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            passed += 1
        except Exception:
            failed += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)

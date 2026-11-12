"""
Running an engine off the event loop, in a separate process.

Split out of analysis_runner. Everything here exists because of one measured
problem — see the long note below, which is kept verbatim from where this code
used to live. It is process and signal handling, with no analysis logic in it
at all, and it was the single hardest part of that module to find.
"""
import asyncio
import logging
import time
from pathlib import Path

log = logging.getLogger("gromax.analysis")


# ─── Running an engine off the event loop ─────────────────────────────────────
#
# WHY A PROCESS AND NOT A THREAD
#
# The job workers share an event loop with the HTTP server, so anything that
# holds Python's interpreter lock (the GIL) for long freezes the whole backend:
# no job progress, no tab switches, a window that looks dead.
#
# The first fix pushed blocking engines to a worker thread. That works for code
# that returns to Python often, and FAILS for a long C call that never releases
# the GIL, because the loop thread then waits in take_gil indefinitely. Measured
# on a real wedged backend: the event-loop thread spent 1421 of 1421 stack
# samples in take_gil while one thread sat inside MDTraj's Shrake-Rupley SASA
# (_geometry.so `sasa`), which runs once over the WHOLE trajectory. Reproduced
# in isolation: a builtin C loop in a thread lets the loop through 0 of ~25
# heartbeats. No HTTP request was answered for 42 minutes, the UI hung, it was
# force-quit, and the orphaned backend then blocked the port on every relaunch.
#
# A separate process has its own interpreter and its own GIL, so no library
# behaviour in it can reach the event loop. It buys two more things for free:
# CANCEL can actually stop the work (a thread cannot be killed; a process can),
# and a native crash in a library kills the job instead of the backend.

def _engine_child(module: str, qualname: str, ctx: dict, work_dir: str,
                  queue, parent_pid: int) -> None:
    """
    Entry point of the engine process.

    Module-level, because the spawn start method finds it by import. Messages
    go back through `queue` as tuples: ("log", line), ("result", data) or
    ("error", message, traceback).
    """
    import importlib
    import os
    import threading
    import time
    import traceback

    # If the backend dies — SIGKILL, a crash, a force-quit — this process must
    # not carry on computing for an hour with nobody to deliver the answer to.
    # That is exactly how a backend came to be orphaned in the first place.
    def _watchdog():
        while True:
            if os.getppid() != parent_pid:
                os._exit(3)
            time.sleep(1.0)
    threading.Thread(target=_watchdog, daemon=True).start()

    def log(line):
        try:
            queue.put(("log", str(line)))
        except Exception:
            pass

    try:
        obj = importlib.import_module(module)
        for part in qualname.split("."):
            obj = getattr(obj, part)
        data = asyncio.run(obj().run(ctx, Path(work_dir), line_callback=log))
        queue.put(("result", data))
    except BaseException as e:                       # noqa: BLE001 — reported
        queue.put(("error", str(e) or type(e).__name__, traceback.format_exc()))


# What an exit code means when the engine process dies without a word.
_EXIT_MEANING = {
    -11: "a segmentation fault inside a native library",
    -9: "it was killed — most often the system running out of memory",
    -6: "an abort inside a native library",
    3: "the backend that started it went away",
}


async def _run_engine_in_process(analysis, ctx: dict, work_dir, line_cb):
    import multiprocessing as mp
    import os
    import queue as _queue

    # THE WHOLE SETUP RUNS OFF THE LOOP, not just the start.
    #
    # With the spawn method the parent writes the child's startup payload into
    # a pipe and blocks until the child drains it — and the child only gets
    # there after re-importing the backend (MDAnalysis, MDTraj, SciPy). That is
    # seconds on a cold cache, and far worse when something inspects each new
    # process: this machine runs an endpoint-protection agent that scans every
    # exec, and a run was measured blocking the loop for 462 s. Creating the
    # queue and constructing the Process touch semaphores and file descriptors
    # too, so none of it belongs on the loop. Doing the lot in one thread keeps
    # the backend answering however slow process creation turns out to be.
    cls = type(analysis)

    def _setup():
        # spawn, never fork: forking a process that already runs threads (the
        # event loop has several) is unsafe on macOS and deprecated in 3.12+.
        mpc = mp.get_context("spawn")
        q = mpc.Queue()
        proc = mpc.Process(
            target=_engine_child,
            args=(cls.__module__, cls.__qualname__, dict(ctx), str(work_dir), q,
                  os.getpid()),
            daemon=True, name=f"gromax-{cls.__name__}")
        proc.start()
        return q, proc

    t_start = time.monotonic()
    q, proc = await asyncio.to_thread(_setup)
    startup = time.monotonic() - t_start
    if startup > 10.0 and line_cb:
        line_cb(f"NOTE: starting the analysis process took {startup:.0f} s. "
                f"Antivirus or endpoint-protection software scanning each new "
                f"process is the usual cause; the analysis itself is "
                f"unaffected.")

    outcome = None
    try:
        while outcome is None:
            try:
                msg = q.get_nowait()
            except _queue.Empty:
                if proc.is_alive():
                    await asyncio.sleep(0.05)
                    continue
                # Exited: give a result that was flushed at the last moment
                # one chance to arrive before concluding there is none.
                try:
                    msg = await asyncio.to_thread(q.get, True, 1.0)
                except _queue.Empty:
                    break
            if msg[0] == "log":
                if line_cb:
                    line_cb(msg[1])
            else:
                outcome = msg
    except asyncio.CancelledError:
        # Cancel means STOP. A thread could only be abandoned to run on; a
        # process is terminated, so the CPU it was using comes straight back.
        _stop_process(proc)
        raise
    finally:
        if outcome is not None:
            await asyncio.to_thread(proc.join, 5.0)
        if proc.is_alive():
            _stop_process(proc)
        # Release the queue's semaphores and its feeder thread; without this a
        # long session leaks one set per job ("leaked semaphore objects").
        try:
            q.close()
            q.join_thread()
        except Exception:
            pass

    if outcome is None:
        code = proc.exitcode
        why = _EXIT_MEANING.get(code, f"exit code {code}")
        raise RuntimeError(
            f"The analysis process stopped without a result ({why}). The "
            f"backend itself is unaffected; re-running with a stride, or a "
            f"shorter time window, uses less memory if that was the cause.")
    if outcome[0] == "error":
        log.debug("engine process failed:\n%s", outcome[2])
        raise RuntimeError(outcome[1])
    return outcome[1]


def _stop_process(proc) -> None:
    """SIGTERM, then SIGKILL. Signals are delivered by the kernel, so unlike a
    Python-level handler they work even while the child is inside C code."""
    try:
        proc.terminate()
        proc.join(2.0)
        if proc.is_alive():
            proc.kill()
            proc.join(2.0)
    except Exception:
        pass


async def _run_engine(analysis, ctx: dict, work_dir, line_cb):
    """
    Run one engine analysis without freezing the rest of the backend.

    Engines that shell out to gmx or cpptraj await a subprocess and yield the
    loop on their own, so they run here. Engines that compute in-process
    declare `blocking` and run in a separate PROCESS — see the note above for
    why a thread was measured not to be enough.
    """
    if not getattr(analysis, "blocking", False):
        return await analysis.run(ctx, work_dir, line_callback=line_cb)
    return await _run_engine_in_process(analysis, ctx, work_dir, line_cb)

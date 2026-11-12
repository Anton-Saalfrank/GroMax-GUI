"""
Async job queue.
All GROMACS analyses are submitted as Jobs and run in the background.
Each job streams progress via a results dict that the frontend polls.
"""

import asyncio
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional, Callable, Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()


# ─── Models ──────────────────────────────────────────────────────────────────

class JobStatus(str, Enum):
    PENDING   = "pending"
    RUNNING   = "running"
    COMPLETED = "completed"
    FAILED    = "failed"
    CANCELLED = "cancelled"


class Job(BaseModel):
    id: str
    session_id: str
    condition_id: str
    analysis_type: str
    label: str                          # human-readable e.g. "RMSF — WT — 0-500ns"
    status: JobStatus = JobStatus.PENDING
    progress: int = 0                   # 0–100
    log: list[str] = Field(default_factory=list)
    result: Optional[dict] = None
    error: Optional[str] = None
    created_at: str = ""
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    params: dict = Field(default_factory=dict)


# ─── Job Manager ─────────────────────────────────────────────────────────────

class JobManager:
    def __init__(self, max_workers: int = 4):
        self._jobs: dict[str, Job] = {}
        self._queue: asyncio.Queue = asyncio.Queue()
        self._workers: list[asyncio.Task] = []
        # Live task per running job, so cancel_job() can actually interrupt the
        # work rather than only relabelling it. Keyed by job id; entries are
        # removed when the job finishes.
        self._tasks: dict[str, asyncio.Task] = {}
        self._max_workers = max_workers
        self._running = False

    async def start(self, max_workers: Optional[int] = None):
        """
        Start the worker pool. `max_workers` overrides the constructor value,
        so the configured `max_parallel_jobs` can take effect at startup
        instead of being silently ignored.
        """
        if max_workers is not None and max_workers > 0:
            self._max_workers = max_workers
        self._running = True
        for _ in range(self._max_workers):
            task = asyncio.create_task(self._worker())
            self._workers.append(task)

    async def stop(self):
        self._running = False
        for t in self._tasks.values():
            if not t.done():
                t.cancel()
        self._tasks.clear()
        for w in self._workers:
            w.cancel()
        self._workers.clear()

    async def _worker(self):
        while self._running:
            try:
                job_id, coro = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                job = self._jobs[job_id]

                # Cancelled while still queued — never start it.
                if job.status == JobStatus.CANCELLED:
                    job.finished_at = datetime.now(timezone.utc).isoformat()
                    self._queue.task_done()
                    continue

                job.status = JobStatus.RUNNING
                job.started_at = datetime.now(timezone.utc).isoformat()

                # Run the work as its OWN task. Cancelling that task interrupts
                # only this job; awaiting the coroutine directly would mean
                # cancel_job() had to cancel the shared worker, killing the pool.
                task = asyncio.create_task(coro(
                    progress_cb=self._make_progress_cb(job_id),
                    log_cb=self._make_log_cb(job_id),
                ))
                self._tasks[job_id] = task

                try:
                    result = await task
                    # Don't resurrect a job the user cancelled: without this
                    # guard a cancel that lands near the end flips the status
                    # back to COMPLETED.
                    if job.status != JobStatus.CANCELLED:
                        job.status = JobStatus.COMPLETED
                        job.progress = 100
                        job.result = result
                except asyncio.CancelledError:
                    job.status = JobStatus.CANCELLED
                    job.log.append("Cancelled.")
                except Exception as e:
                    job.status = JobStatus.FAILED
                    job.error = str(e)
                finally:
                    self._tasks.pop(job_id, None)
                    job.finished_at = datetime.now(timezone.utc).isoformat()
                    self._queue.task_done()

            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

    def _make_progress_cb(self, job_id: str) -> Callable:
        def cb(pct: int):
            if job_id in self._jobs:
                self._jobs[job_id].progress = min(max(pct, 0), 99)
        return cb

    def _make_log_cb(self, job_id: str) -> Callable:
        def cb(line: str):
            if job_id in self._jobs:
                self._jobs[job_id].log.append(line)
                # Keep log bounded
                if len(self._jobs[job_id].log) > 500:
                    self._jobs[job_id].log = self._jobs[job_id].log[-400:]
        return cb

    def submit(
        self,
        session_id: str,
        condition_id: str,
        analysis_type: str,
        label: str,
        coro_factory: Callable,
        params: dict = None
    ) -> Job:
        """Submit a job. coro_factory is called with (progress_cb, log_cb)."""
        job_id = str(uuid.uuid4())[:12]
        job = Job(
            id=job_id,
            session_id=session_id,
            condition_id=condition_id,
            analysis_type=analysis_type,
            label=label,
            created_at=datetime.now(timezone.utc).isoformat(),
            params=params or {}
        )
        self._jobs[job_id] = job
        self._queue.put_nowait((job_id, coro_factory))
        return job

    def get_job(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list_jobs(self, session_id: Optional[str] = None) -> list[Job]:
        jobs = list(self._jobs.values())
        if session_id:
            jobs = [j for j in jobs if j.session_id == session_id]
        return sorted(jobs, key=lambda j: j.created_at, reverse=True)

    def cancel_job(self, job_id: str) -> bool:
        """
        Cancel a job for real.

        Marking the status alone (the previous behaviour) left the coroutine
        and its `gmx` subprocess running, and the worker then overwrote the
        status with COMPLETED — so "cancel" neither stopped the work nor stuck.
        We now cancel the underlying task; run_gmx() traps CancelledError and
        kills the subprocess, so GROMACS actually stops.
        """
        job = self._jobs.get(job_id)
        if not job:
            return False
        if job.status not in (JobStatus.PENDING, JobStatus.RUNNING):
            return False

        job.status = JobStatus.CANCELLED
        task = self._tasks.get(job_id)
        if task and not task.done():
            task.cancel()          # propagates into run_gmx → proc.kill()
        return True

    def clear_finished(self, session_id: str):
        to_remove = [
            jid for jid, j in self._jobs.items()
            if j.session_id == session_id
            and j.status in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED)
        ]
        for jid in to_remove:
            del self._jobs[jid]

    def clear_all_for_session(self, session_id: str):
        """Remove ALL jobs (finished or not) for a session — full reset."""
        for jid in [j for j, job in self._jobs.items() if job.session_id == session_id]:
            del self._jobs[jid]


# Singleton instance shared across the app
job_manager = JobManager(max_workers=4)


# ─── API Routes ──────────────────────────────────────────────────────────────

# Registered at BOTH "" and "/", and this matters more than it looks.
#
# With the frontend mounted (any packaged build, and any checkout where `dist/`
# exists), main.py adds a catch-all `@app.get("/{full_path:path}")` to serve the
# SPA. That catch-all FULLY matches "/api/jobs", so Starlette never reaches its
# redirect-slashes fallback and never rewrites it to "/api/jobs/" — the request
# lands in the SPA handler, which correctly refuses to serve an api/ path and
# returns 404. The Jobs panel then polls forever, gets 404 every time, swallows
# it (pollJobs fails silently by design) and shows an empty list while analyses
# run perfectly well in the background.
#
# It only shows up once `dist/` exists, which is why it survived dev use and
# would have hit every packaged build. appconfig.py already sidesteps the same
# trap with `@router.get("")`.
@router.get("")
@router.get("/", include_in_schema=False)
def list_jobs(session_id: Optional[str] = None):
    return [j.model_dump() for j in job_manager.list_jobs(session_id)]


@router.get("/{job_id}")
def get_job(job_id: str):
    job = job_manager.get_job(job_id)
    if not job:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Job not found")
    return job.model_dump()


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str):
    ok = job_manager.cancel_job(job_id)
    return {"ok": ok}


@router.delete("/session/{session_id}/finished")
def clear_finished_jobs(session_id: str):
    job_manager.clear_finished(session_id)
    return {"ok": True}

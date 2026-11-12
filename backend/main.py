"""
GroMax GUI — Python Backend
FastAPI server that wraps GROMACS subprocess calls and manages session state.
"""

import argparse
import logging
import logging.handlers
import os
import sys
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# Ensure backend package is importable when run as script
sys.path.insert(0, str(Path(__file__).parent))


def setup_logging() -> Path:
    """
    Send gromax.* logs to the console AND to a rotating file, so failures that
    the UI can't show (a result computed but not registered, a state write that
    failed) leave a trace worth reading rather than vanishing.

    Returns the log file path.
    """
    log_dir = Path.home() / ".gromax"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "gromax.log"

    root = logging.getLogger("gromax")
    root.setLevel(logging.DEBUG)
    if root.handlers:                     # already configured (reload)
        return log_file

    fmt = logging.Formatter("%(asctime)s %(levelname)-8s %(name)s: %(message)s")

    console = logging.StreamHandler()
    console.setLevel(logging.INFO)
    console.setFormatter(fmt)
    root.addHandler(console)

    # 2 MB x 3 files is plenty for diagnostics and never grows unbounded
    fileh = logging.handlers.RotatingFileHandler(
        log_file, maxBytes=2_000_000, backupCount=3)
    fileh.setLevel(logging.DEBUG)
    fileh.setFormatter(fmt)
    root.addHandler(fileh)

    return log_file


# Engine processes (see analysis_runner._run_engine_in_process) are started
# with "spawn", which re-imports this module in the child as __mp_main__ — and
# a packaged build re-runs it with --multiprocessing-fork. Neither should attach
# a second rotating handler to the backend's log file: two processes rotating
# one file leave each writing into the other's renamed copy.
_IS_ENGINE_CHILD = (__name__ == "__mp_main__"
                    or "--multiprocessing-fork" in sys.argv)
LOG_FILE = (Path.home() / ".gromax" / "gromax.log") if _IS_ENGINE_CHILD \
    else setup_logging()

from core.session import router as session_router
from core.files import router as files_router
from core.gmx import router as gmx_router
from core.jobs import router as jobs_router, job_manager
from core.appconfig import router as appconfig_router
from core.analysis_runner import router as analysis_router
from core.pca_runner import router as pca_router
from core.system_map import router as system_router
from core.contact_query import router as contact_router
from core.chimerax import router as chimerax_router
from core.structure import router as structure_router
from core.config import settings
from core.version import __version__

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="GroMax GUI Backend",
    version=__version__,
    description="GROMACS trajectory analysis backend"
)

# CORS is only needed for the Vite DEV server, which runs on a different origin
# (5173) from the backend. In production the frontend is served BY this app
# (see "Static frontend" below), so the origin matches and CORS is moot.
#
# Historical note: the packaged Electron build used to load the UI via
# loadFile(), giving it a `file://` origin — which browsers send as
# `Origin: null`. That matched no entry here, so EVERY request from the
# packaged app was blocked and the desktop build could not reach its own
# backend. Serving the frontend from this origin removes that whole class of
# problem rather than papering over it with an allow-list entry.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Routers ──────────────────────────────────────────────────────────────────

app.include_router(session_router, prefix="/api/session", tags=["session"])
app.include_router(files_router,   prefix="/api/files",   tags=["files"])
app.include_router(gmx_router,     prefix="/api/gmx",     tags=["gromacs"])
app.include_router(jobs_router,    prefix="/api/jobs",    tags=["jobs"])
app.include_router(appconfig_router, prefix="/api/config",   tags=["config"])
app.include_router(analysis_router,  prefix="/api/analysis", tags=["analysis"])
app.include_router(pca_router,        prefix="/api/pca",      tags=["pca"])
app.include_router(system_router,     prefix="/api/system",   tags=["system"])
app.include_router(contact_router,    prefix="/api/contacts", tags=["contacts"])
app.include_router(chimerax_router,   prefix="/api/chimerax", tags=["chimerax"])
app.include_router(structure_router,  prefix="/api/structure", tags=["structure"])

# ─── Health & info ────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "version": __version__}

@app.get("/api/info")
def info():
    """Return backend environment info."""
    import shutil
    gmx_path = shutil.which("gmx") or shutil.which("gmx_mpi")
    return {
        "gromax_version": __version__,
        "python_version": sys.version,
        "gromacs_available": gmx_path is not None,
        "gromacs_path": gmx_path,
        "projects_dir": str(settings.projects_dir),
        "platform": sys.platform
    }

# ─── Static frontend ──────────────────────────────────────────────────────────
# In a packaged build the backend also serves the compiled UI, so Electron can
# point at http://127.0.0.1:<port> instead of loading from disk. That means:
#   * the renderer origin is a real http origin, so CORS is satisfied naturally
#   * dev and production behave identically (same origin, same relative paths)
#   * the API base URL can be relative, so the hardcoded port disappears
#
# Mounted LAST so it never shadows /api/* or /health. Absent in a dev checkout
# that hasn't run `vite build`, which is fine — Vite serves the UI then.

def _frontend_dir() -> Optional[Path]:
    """Locate the built frontend, dev layout or packaged layout."""
    # An explicit override, so the static route can be tested against a known
    # tree instead of depending on `vite build` having been run.
    override = os.environ.get("GROMAX_DIST")
    if override:
        p = Path(override)
        return p if p.is_dir() and (p / "index.html").is_file() else None
    for candidate in (
        Path(__file__).parent.parent / "dist",       # dev / repo checkout
        Path(__file__).parent / "dist",              # backend-adjacent
        Path(getattr(sys, "_MEIPASS", "")) / "dist" if hasattr(sys, "_MEIPASS")
            else None,                               # PyInstaller bundle
    ):
        if candidate and candidate.is_dir() and (candidate / "index.html").is_file():
            return candidate
    return None


def mount_frontend(app: FastAPI) -> Optional[Path]:
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    dist = _frontend_dir()
    if dist is None:
        return None

    # Resolved ONCE, so the containment check below compares two real paths and
    # cannot be fooled by a symlink inside dist/ either.
    root = dist.resolve()
    index = root / "index.html"

    # Serve hashed assets directly.
    assets = root / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        """
        Serve a built file, or fall back to index.html so client-side routing
        works for a deep link.

        CONFINED TO dist/. `full_path` arrives URL-DECODED, so `..%2f..%2f` is
        `../../` by the time it gets here, and joining it onto dist/ walked
        straight out of the tree — `GET /../../../../../etc/passwd` returned
        /etc/passwd with a 200. The backend binds 127.0.0.1, so reaching it
        means being on the machine already; the exposure that mattered was a
        shared workstation or login node, where every local account can reach
        another user's port.

        This is also a ROUTING fix, independent of the leak: a deep link is
        supposed to fall back to index.html, and any path containing `..` was
        returning something else entirely.
        """
        # Never intercept the API surface.
        if full_path.startswith(("api/", "health")):
            raise HTTPException(status_code=404, detail="Not found")
        if not full_path:
            return FileResponse(str(index))
        candidate = (root / full_path).resolve()
        # Anything outside the tree is treated as an unknown route, not an
        # error: an unknown route IS the SPA fallback case, and a 403 here
        # would leak whether the traversal target exists.
        if candidate == root or root not in candidate.parents:
            return FileResponse(str(index))
        if candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(index))              # SPA fallback

    return dist


# ─── Startup / shutdown ───────────────────────────────────────────────────────

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    settings.projects_dir.mkdir(parents=True, exist_ok=True)

    # Honour the configured parallelism. This setting existed in both Settings
    # and AppConfig (and in the Settings UI) but the job manager was built with
    # a hardcoded 4, so changing it did nothing.
    from core.appconfig import load_config
    try:
        n_workers = int(load_config().max_parallel_jobs)
    except Exception:
        n_workers = settings.max_parallel_jobs
    n_workers = max(1, min(n_workers, 32))      # sane bounds

    await job_manager.start(max_workers=n_workers)

    dist = mount_frontend(app)
    if dist:
        print(f"[gromax] Serving frontend from {dist}")
    else:
        print("[gromax] No built frontend found (dev mode — use the Vite server)")

    print(f"[gromax] Backend started. Projects dir: {settings.projects_dir} "
          f"({n_workers} worker(s))")
    yield
    # Shutdown
    await job_manager.stop()
    print("[gromax] Backend stopped.")

# Attach lifespan to the app (defined above)
app.router.lifespan_context = lifespan

# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Required for engine processes in a PyInstaller build: there the child is
    # this same executable re-launched, and this call is what hands it over to
    # multiprocessing instead of starting a second server. A no-op otherwise.
    import multiprocessing
    multiprocessing.freeze_support()

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7432)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    uvicorn.run(
        "main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info"
    )

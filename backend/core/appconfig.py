"""
Persistent app-level config stored at ~/.gromax/config.json
"""

import json
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

CONFIG_PATH = Path.home() / ".gromax" / "config.json"


# ─── Model ───────────────────────────────────────────────────────────────────

class PlotPreset(BaseModel):
    """A saved set of figure styling options, by name."""
    name: str
    style: dict


class AppConfig(BaseModel):
    gmx_path: Optional[str] = None
    max_parallel_jobs: int = 4
    default_stride: int = 1
    # Figure styling presets live with the APP, not with a project: a journal's
    # requirements follow you from one system to the next, and having to rebuild
    # "Nature single column" in every project is exactly the chore they exist to
    # remove.
    plot_presets: list[PlotPreset] = []
    default_preset: Optional[str] = None


class AppConfigUpdate(BaseModel):
    gmx_path: Optional[str] = None
    max_parallel_jobs: Optional[int] = None
    default_stride: Optional[int] = None
    plot_presets: Optional[list[PlotPreset]] = None
    # Explicitly nullable: clearing the default is a real action, and
    # exclude_none in the PATCH handler would otherwise silently drop it.
    default_preset: Optional[str] = None


class VerifyRequest(BaseModel):
    path: str


# ─── Helpers ─────────────────────────────────────────────────────────────────

def load_config() -> AppConfig:
    if CONFIG_PATH.exists():
        try:
            return AppConfig(**json.loads(CONFIG_PATH.read_text()))
        except Exception:
            pass
    return AppConfig()


def save_config(config: AppConfig):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(config.model_dump_json(indent=2))


def get_gmx_executable() -> str:
    import shutil
    config = load_config()
    if config.gmx_path:
        p = Path(config.gmx_path)
        if p.exists() and p.is_file():
            return str(p)
    for candidate in ["gmx", "gmx_mpi", "gmx_d"]:
        found = shutil.which(candidate)
        if found:
            return found
    raise RuntimeError(
        "GROMACS executable not found. Set the path in Settings."
    )


def probe_gmx(path: str) -> dict:
    """Run gmx --version and return status dict."""
    p = Path(path)
    if not p.exists():
        return {"found": False, "path": path, "version": None,
                "error": f"File not found: {path}"}
    if not p.is_file():
        return {"found": False, "path": path, "version": None,
                "error": f"Not a file: {path}"}
    try:
        result = subprocess.run(
            [str(p), "--version"], capture_output=True, text=True, timeout=10
        )
        # gmx --version writes to stdout
        all_output = result.stdout + result.stderr
        version_line = next(
            (l.strip() for l in all_output.splitlines() if "GROMACS version" in l),
            None
        )
        if version_line:
            return {"found": True, "path": path, "version": version_line}
        else:
            return {"found": True, "path": path, "version": "unknown",
                    "error": "Ran OK but version string not found"}
    except subprocess.TimeoutExpired:
        return {"found": False, "path": path, "version": None, "error": "Timed out"}
    except Exception as e:
        return {"found": False, "path": path, "version": None, "error": str(e)}


# ─── Routes ──────────────────────────────────────────────────────────────────

@router.get("")   # no trailing slash — avoids 307 redirect
def get_config():
    config = load_config()
    # Probe current gmx
    gmx_status = {"found": False, "path": None, "version": None}
    try:
        gmx = get_gmx_executable()
        gmx_status = probe_gmx(gmx)
    except Exception as e:
        gmx_status["error"] = str(e)
    return {**config.model_dump(), "gmx_status": gmx_status}


@router.patch("")  # no trailing slash
def update_config(updates: AppConfigUpdate):
    config = load_config()
    data = updates.model_dump(exclude_none=True)
    for k, v in data.items():
        setattr(config, k, v)
    save_config(config)
    return config.model_dump()


class PresetSaveRequest(BaseModel):
    name: str
    style: dict
    make_default: bool = False


@router.post("/presets")
def save_preset(req: PresetSaveRequest):
    """
    Add or replace a named styling preset.

    Replace rather than append on a name clash: saving over a preset is how you
    refine one, and silently keeping two entries with the same name would make
    the picker ambiguous.
    """
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="A preset needs a name.")
    config = load_config()
    kept = [p for p in config.plot_presets if p.name != name]
    kept.append(PlotPreset(name=name, style=req.style))
    kept.sort(key=lambda p: p.name.lower())
    config.plot_presets = kept
    if req.make_default:
        config.default_preset = name
    save_config(config)
    return config.model_dump()


@router.delete("/presets/{name}")
def delete_preset(name: str):
    config = load_config()
    config.plot_presets = [p for p in config.plot_presets if p.name != name]
    if config.default_preset == name:
        config.default_preset = None
    save_config(config)
    return config.model_dump()


@router.post("/verify-gmx")
def verify_gmx_path(req: VerifyRequest):
    """Test whether a given gmx path works."""
    result = probe_gmx(req.path.strip())
    return {"ok": result["found"], **result}

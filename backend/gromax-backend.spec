# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the GroMax backend.

WHY: the packaged Electron app previously shelled out to whatever `python3`
happened to be on PATH and assumed fastapi/uvicorn/pydantic/numpy were
installed there. On a colleague's machine that fails with no useful error.
Freezing the backend into a self-contained executable removes the Python
prerequisite entirely.

BUILD (must run on the TARGET platform — PyInstaller cannot cross-compile):
    pip install -r backend/requirements.txt pyinstaller
    pyinstaller backend/gromax-backend.spec --distpath dist-backend --workpath build-backend

Produces dist-backend/gromax-backend/ (onedir). Onedir, not onefile: onefile
unpacks to a temp directory on every launch, which is slow and confuses
antivirus. Electron spawns the executable inside that folder.

NOTE: GROMACS itself is NOT bundled and must not be — it is large, and the
user's own `gmx` build (often a tuned or conda one) is what they want used.
The app locates it via the path set in Settings.
"""

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = []
# uvicorn/fastapi load a lot dynamically; PyInstaller's static analysis misses it.
for pkg in ("uvicorn", "fastapi", "pydantic", "pydantic_settings", "anyio"):
    hiddenimports += collect_submodules(pkg)

# Our own modules are imported by string in places (routers, analysis registry).
hiddenimports += collect_submodules("core") + collect_submodules("analyses")

a = Analysis(
    ["main.py"],
    pathex=["."],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        # Keep the bundle lean — these get pulled in transitively but unused.
        "tkinter", "matplotlib", "PIL", "pytest", "IPython", "notebook",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="gromax-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX trips code-signing and some antivirus
    console=True,       # keep stdout/stderr so Electron can log backend output
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="gromax-backend",
)

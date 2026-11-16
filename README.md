# GroMax GUI

A desktop GUI for GROMACS trajectory analysis. Scan a folder of simulations,
auto-pair replicas, run analyses (RMSF, RMSD, Rg) across conditions, and
compare results in interactive plots.

## Install

Five steps from a bare machine to a running app. Copy-paste each block in
order; nothing is left implicit.

**The whole thing, if you just want the commands:**

```bash
git clone https://github.com/Anton-Saalfrank/GroMax-GUI.git
cd GroMax-GUI
conda env create -f environment.yml     # Python + GROMACS + Node, ~5-10 min
conda activate gromax-gui
npm install                             # frontend packages, ~1-2 min
npm run dev                             # the app opens
```

The rest of this section explains each line, says what success looks like, and
covers the ways it can go wrong.

### What you need first

Only two things:

| | | |
|---|---|---|
| **git** | to download the code | preinstalled on macOS and most Linux |
| **conda** | installs everything else | [Miniforge](https://conda-forge.org/download/) if you have neither |

You do **not** need to install Python, Node.js or GROMACS by hand. Step 2
brings all three, so this works on a machine with none of them.

<details>
<summary>Installing Miniforge, if you don't have conda</summary>

Miniforge is a minimal conda that defaults to the conda-forge channel — which
is where the GROMACS build comes from. Anaconda or Miniconda work too.

```bash
# macOS (Apple Silicon or Intel) and Linux — detects your platform
curl -L -o Miniforge3.sh "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh"
bash Miniforge3.sh -b -p "$HOME/miniforge3"
"$HOME/miniforge3/bin/conda" init "$(basename "$SHELL")"
```

Then **close and reopen your terminal**. Check it took:

```bash
conda --version        # e.g. conda 24.9.2
```

</details>

**Platforms.** macOS (Intel and Apple Silicon) and Linux are supported
directly. On **Windows**, run every step below inside
[WSL2](https://learn.microsoft.com/windows/wsl/install) — conda-forge publishes
no GROMACS build for native Windows, so there is nothing to install there. A
WSL2 Ubuntu shell behaves exactly like the Linux instructions.

### 1. Download the code

```bash
git clone https://github.com/Anton-Saalfrank/GroMax-GUI.git
cd GroMax-GUI
```

Everything after this assumes you are inside that folder. If a later command
says "file not found", check with `pwd` that you still are.

### 2. Create the environment

```bash
conda env create -f environment.yml
conda activate gromax-gui
```

This puts Python 3.11, **GROMACS 2024.2**, Node 20 and every analysis
dependency into one self-contained environment named `gromax-gui`. It does
not touch, move or upgrade any GROMACS, Python or Node you already have
elsewhere — conda environments are isolated directories, and removing this one
later leaves no trace (see [Removing it again](#removing-it-again)).

Expect a few minutes and around 200 packages, so have a couple of GB free.
If you have `mamba`, `mamba env create -f environment.yml` gives the identical
result considerably faster.

**You should see**, at the end:

```
# To activate this environment, use
#     $ conda activate gromax-gui
```

and after activating, your prompt gains a `(gromax-gui)` prefix.

### 3. Install the frontend packages

```bash
npm install
```

Node itself came from step 2, so this needs no separate Node install. It
downloads React, Plotly, Electron and the build tooling into `node_modules/`
(a few hundred MB, inside the project folder).

Warnings about deprecated transitive packages are normal and can be ignored.
An `npm ERR!` is not — see [Troubleshooting](#troubleshooting).

### 4. Run it

```bash
npm run dev
```

This starts three things at once: the Vite dev server, the Python backend, and
the Electron desktop window. The window opens by itself after a few seconds.
Leave the terminal running — closing it stops the app. `Ctrl+C` to quit.

> **Keep `gromax-gui` activated whenever you run the app.** It launches its
> backend with whatever `python3` is first on your PATH, which has to be the
> one holding the dependencies. Every new terminal needs
> `conda activate gromax-gui` again first. This is the single most common way
> a working install appears broken.

### 5. Check it worked

Look at the **title bar** of the app window. On the right you want:

```
● backend online · gmx ✓
```

A green `backend online` means the Python half started and the UI reached it.
`gmx ✓` means GROMACS was found. With the environment active, `gmx` is on your
PATH, so it is detected automatically and there is nothing to paste in — the
**Setup tab** shows the detected version if you want to confirm which build it
picked.

Two failure shapes, both covered in [Troubleshooting](#troubleshooting):

| Title bar says | Meaning |
|---|---|
| `backend offline` (red) | the Python backend didn't start |
| `backend online · gmx not found` (amber) | app is fine, GROMACS isn't visible |

The same check from a terminal, with `gromax-gui` active:

```bash
gmx --version | grep "GROMACS version"               # expect 2024.2
python3 -c "import fastapi, numpy, scipy; print('deps OK')"
node --version                                       # expect v20.x
```

All three printing sensibly means the install is sound, and you can carry on to
[Usage](#usage).

---

### Alternative: you already have a GROMACS you want to keep

If you have a tuned or GPU-enabled GROMACS build, don't let conda shadow it.
Skip step 2 and install only the Python and Node packages:

```bash
bash setup.sh
```

Then paste the full path to your own `gmx` into the app's **Setup tab** — find
it with `which gmx`, or `conda activate <your-env> && which gmx` if it lives in
another environment. That environment does **not** need to stay activated
afterwards; the app stores and invokes the path directly.

This route assumes **Python 3.11+**, **Node.js 20+** and **GROMACS 2024 or
newer** are already present — `setup.sh` checks the first two and stops if they
are missing, but only *warns* about GROMACS and carries on. See
[Troubleshooting](#troubleshooting) for why the GROMACS version matters.

### Alternative: run in a browser instead of the desktop app

Useful on a headless machine, over SSH, or if Electron won't start.

Either run the backend alongside the Vite dev server:

```bash
bash run-browser.sh          # then open http://localhost:5173
```

or build the frontend once and let a single Python process serve both the UI
and the API — closest to how the packaged app behaves:

```bash
npx vite build
python3 backend/main.py --port 7432     # then open http://localhost:7432
```

### Updating to a newer version

```bash
git pull
conda env update -f environment.yml --prune     # only if environment.yml changed
npm install                                     # only if package.json changed
```

Running both anyway is harmless, just slower. Your projects live outside the
repository (in `~/.gromax/`), so pulling never touches your data.

### Removing it again

```bash
conda deactivate
conda env remove -n gromax-gui     # the environment, incl. its GROMACS
rm -rf /path/to/GroMax-GUI         # the code and node_modules
rm -rf ~/.gromax                   # your projects and results — only if you mean it
```

### Troubleshooting

**`conda: command not found`.** conda isn't installed, or its shell hook isn't
loaded. Install Miniforge (above), then open a *new* terminal — `conda init`
only affects shells started afterwards.

**The environment solve takes forever or fails to resolve.** Use `mamba env
create -f environment.yml`, or `conda env create -f environment.yml
--solver=libmamba`. If it still fails, check `conda config --show channels`:
`environment.yml` requests conda-forge explicitly, but a pinned
`defaults`-first config can interfere.

**`npm ERR!` during `npm install`.** Confirm `node --version` reports v20.x —
if it reports something else, the environment isn't active and you are using a
system Node. Otherwise clear and retry: `rm -rf node_modules package-lock.json
&& npm install`.

**The title bar says `backend offline`.** The Python backend failed to start.
Scroll up in the terminal running `npm run dev` for a traceback. The usual
cause is a missing dependency because the environment wasn't active; verify
with `python3 -c "import fastapi, numpy, scipy"`. The log at
`~/.gromax/gromax.log` is worth attaching to any bug report.

**The title bar says `gmx not found`, or the Setup tab can't find `gmx`.** The
environment is not active in the shell that started the app. Run `conda
activate gromax-gui`, then `which gmx` — if that prints a path, relaunch the
app from that same shell. Alternatively paste the path into the Setup tab,
which persists it and removes the dependency on PATH entirely.

**Secondary structure (DSSP) fails, but every other analysis works.** Your
GROMACS is older than 2023. The app calls `gmx dssp`, which did not exist
before then (it was `gmx do_dssp` plus a separate DSSP binary), and there is no
fallback. `gmx dssp -hmode` and the rewritten `gmx hbond` are 2024-era, so
**GROMACS 2024.x is the supported floor** — which is exactly what
`environment.yml` pins. Note that the app currently reports only *whether*
`gmx` was found, not whether its version is new enough, so an old GROMACS
looks fine right up until you click the analysis.

**The Electron window never appears (Linux).** Electron needs GUI system
libraries that minimal and server images don't ship. On Debian/Ubuntu:

```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libgtk-3-0 libgbm1 libasound2
```

On a genuinely headless machine, use browser mode instead (above).

**An engine is greyed out in the Analyses tab.** It was installed into a
different Python than the one running the backend. The tab reports the version
it actually found, so use that to confirm which interpreter won, then install
into the active environment. (Only the GROMACS engine is required — the others
add alternative implementations.)

**"Port already in use" on startup.** Another copy is still running. The app
picks a free port automatically; if it still complains, close the other copy.

**Where did my work go?** Projects live in `~/.gromax/projects/`, archived ones
in `~/.gromax/archive/`, and the log — worth attaching to any bug report — is
`~/.gromax/gromax.log`. None of it is inside the repository, so it survives
`git pull` and re-cloning.

> **No prebuilt installers yet.** When releases are published, a
> `.dmg`/`.AppImage` will need only GROMACS, since the installers bundle the
> frontend and a frozen Python backend. Until then, the steps above are the
> way in.

## What works now (v1.0.0)

- **Projects** — create/open projects saved to `~/.gromax/projects/`
- **Conditions** — WT, mutant, etc., each with its own colour and replicas
- **Folder scanning** — point at a sim folder; the app finds `.tpr`/`.xtc` files
  and auto-pairs replicas by the number in the filename
  (e.g. `step5_1.tpr` ↔ `step5_1.pbc.xtc`)
- **GROMACS path setting** — set your `gmx` path once (works with conda envs)
- **Analyses** — RMSF, RMSD, radius of gyration, SASA, hydrogen bonds,
  minimum distance, 2D-RMSD matrix, secondary structure (DSSP), and PCA —
  run across all replicas
- **Persistent results** — analyses are stored in a registry on disk and loaded
  independently of the Jobs panel, with per-analysis show/hide (persisted) and
  delete. Clearing the Jobs panel no longer removes plots.
- **Light / dark theme** — toggle in the title bar; plots follow the theme.
- **Publication styling** (Compare tab) — plot/outer background, gridline colour
  and on/off, font family/size/colour/bold/italic, mean-line colour, axis labels
  and ranges, line width.
- **Plot Studio** (Compare tab) — ports the standalone HTML tool's plotting into
  the app, working on named results:
    - Overlay mode with line-display options (repeats + mean±SD / mean only /
      individual) and colour-by (condition shaded / repeat palette / time gradient)
    - Correlation scatter (metric X vs Y) with Pearson r
    - Time-lagged cross-correlation (normalised, ± max lag)
    - Average-comparison bars (per replica, grouped by condition, with error bars)
    - Per-replica panel: highlight, show/hide, exclude-from-mean (live recompute)
    - Plot customisation: title, axis labels, ranges, line width
- **Compare tab** — flexibly relate completed analyses to each other:
    - overlay any metric with each condition's mean ± SD as a reference band and
      individual replicas drawn against it; hover identifies each replica
    - a replica side panel to highlight, show/hide, or exclude specific replicas
      of specific conditions; excluding recomputes the mean/SD live (instant, no
      gmx re-run) so you can drop a broken run and see the corrected average
    - correlation scatter (metric X vs Y, same or cross condition) with Pearson r
    - cross-condition average bars with replica-derived error bars
- **Reset all analyses** — one-click clean slate (clears cached results + job
  history; keeps files, conditions, and config)
- **Residue contacts** now supports two modes: distance-based (gmx select) and
  **hydrogen bonds** (gmx hbond, geometric distance+angle). Both report per-residue
  occupancy (mean ± SD over replicas, with replica dots), mapped to biological
  identity with correct chain disambiguation. Distance mode also supports a
  **frame filter** (restrict the tally to frames where another metric passes a
  threshold).
- **Filtered analysis** (Compare tab) — threshold a per-frame metric and report
  either the fraction of frames passing (contact time) or the conditional mean
  of another metric over those frames; live-adjustable operator + threshold.
- **PCA improvements** — named PCA runs (tell multiple apart, delete individually),
  adjustable density coarseness, and colour a per-condition map by replica after
  the fact (no per-replica recompute) using stored per-replica frame counts.
- **System definition (multi-chain mapping)** — describe a multi-protein system
  once (import the input PDB to auto-detect chains + residue ranges, then verify
  / edit). Because the GROMACS index numbers residues as one continuous list,
  this lets you select by biological identity — e.g. chain B residue D629 in
  full-length numbering — and the app maps it to the flat index automatically.
  Includes an optional "check residue type" that verifies e.g. 629 is really ASP.
- **Shared-basis PCA** — the scientifically correct way to compare essential
  dynamics across conditions: builds ONE covariance matrix from all conditions
  pooled, then projects each condition (or replica) onto that shared basis so
  PC1 means the same motion for everyone. Includes:
    - per-replica frame control (trim start/end/stride) with an auto-equalise
      helper so every trajectory contributes equal weight to the basis
    - covariance atom selection (Cα / Backbone / Sidechain / custom) with an
      "exclude residues" field for mutation sites
    - an atom-count consistency guardrail that verifies the selection resolves
      to identical atoms across all conditions before running, and auto-detects
      differing residues to suggest exclusions
- **Custom index selections** — type make_ndx expressions like `ri 200-270`
  or `3 & ri 200-270`; they're built into named index groups automatically
- **Time windows** — restrict analysis to a start/end time in ns
- **Job queue** — live progress, cancellable, with logs
- **Results** — interactive Plotly charts, conditions overlaid, mean ± SD band,
  optional individual-replica traces, SVG export

## Usage

1. **Create a project** on the home screen.
2. **Setup tab**: paste your `gmx` path and hit Test → Save.
3. **Add a condition** (e.g. "WT"), click it to expand.
4. **Scan** your sim folder — adjust the tpr/xtc patterns if needed
   (defaults: `*.tpr` and `*.pbc.xtc`). Check the replica pairing, pick a
   reference structure, and Register.
5. **Analyses tab**: pick RMSF, choose index group (C-alpha etc.), select
   conditions, and Run.
6. **Results tab**: view the comparison plot. Toggle the SD band and
   individual replicas. Export as SVG.

## Architecture

- **Frontend**: Electron + React + TypeScript, Plotly.js for charts
- **Backend**: Python + FastAPI, wraps `gmx` as subprocesses
- **Analyses**: modular — each analysis is a class in `backend/analyses/`
  that declares its gmx flags and result shape; `BaseAnalysis` does the rest.

### How the two halves connect

In production the **backend serves the built frontend**, and Electron loads
`http://127.0.0.1:<port>/`. This matters more than it sounds: loading the UI
from `file://` gives it an `Origin: null`, which CORS rejects — so every API
call from a packaged build failed. Serving from one origin removes that class
of bug, makes dev and production behave identically, and lets the API base URL
be relative so the port can be chosen at runtime.

The backend **port is allocated at startup**, not hardcoded, so a second
instance (or anything already using the old fixed port) no longer breaks.

GROMACS is **not bundled** — GroMax invokes the user's own `gmx`, set once in
the Setup tab. Same for ChimeraX. Both are large, and users want their own
tuned builds used.

## ChimeraX integration

Per-residue results (RMSF, contact occupancy, H-bond occupancy) can be painted
onto a structure for figure preparation:

- `POST /api/chimerax/export` writes a `.defattr` attribute file plus a `.cxc`
  command script into `<project>/chimerax/`. Open the `.cxc` in ChimeraX.
- `POST /api/chimerax/send` pushes it straight into a **running** ChimeraX via
  its REST server. Start that once in ChimeraX with:
  `remotecontrol rest start port 60958 json true`
  (make it permanent in Preferences → Startup).
- `POST /api/chimerax/ping` / `GET /api/chimerax/detect` check availability.

The residue mapping reuses the system definition, so values land on the right
chain and full-length residue number rather than GROMACS' flat internal index.
Per-frame analyses (RMSD vs time) are rejected explicitly — they have no
per-residue value, and silently producing a figure from them would be worse
than an error.

## Adding a new analysis

Create a class in `backend/analyses/` subclassing `BaseAnalysis`, implement
`build_args()`, register it in `backend/analyses/__init__.py`. It automatically
appears in the Analyses tab and gets replica averaging + caching + comparison
plots for free.

## Code layout

Frontend (`src/`):
- `lib/stats.ts` — pure statistics (pearson, cross-correlation, mean/SD, ...).
  No React, no Plotly; verified numerically identical to the originals.
- `plotTheme.ts` — reads CSS design tokens so charts follow the light/dark theme.
- `components/plots/` — one file per plot type (`LinePlot` incl. heatmap,
  `Scatter2DPlot`, `PcaPlot`, `ContactsPlot`) plus `shared.ts` for the common
  theme-aware layout getters.
- `components/PlotStyleControls.tsx` — the publication styling panel, plus
  `styledLayout()` which maps a `PlotStyle` object to a Plotly layout.
- `components/ResultsTab.tsx` — orchestrates: loads the registry, handles
  show/hide + delete, dispatches to the right plot component.
- `components/CompareTab.tsx` — Plot Studio: metric selection and trace building.

Backend (`backend/`): `core/` holds the runners (analysis, PCA, contacts) and
infrastructure (session, jobs, gmx, system_map); `analyses/` has one module per
GROMACS analysis, registered automatically.

## Publishing / citation

`LICENSE`, `CITATION.cff` and `.zenodo.json` are scaffolded with **placeholders
that must be filled in before the repository is made public**.

The licence is not yet chosen deliberately: at the University of Bristol,
software written by staff (or on University equipment) is owned by the
University, and only the copyright holder may pick a licence — plus grant terms
often mandate one. Confirm with your line manager and RED, or
`ask-rse@bristol.ac.uk`, then replace the placeholder header in `LICENSE`.

Note for the README once decided: GroMax invokes `gmx` as an external
subprocess and does not link against GROMACS libraries, so GROMACS' LGPL does
not propagate here.

Reproducibility: `backend/requirements.txt` uses loose bounds so pip can find
wheels; `backend/requirements.lock` pins a known-good set for archived
releases. Install the lock file when reproducing published results.

**What to deposit.** Archive the **source**, not the installers. The
GitHub–Zenodo integration only archives the repository itself and does not pick
up files attached to a GitHub release, so a `.dmg`/`.AppImage`/`.exe` attached
to a release will never reach Zenodo anyway. Installers are platform-specific
and can't be inspected or rebuilt; source can. Put the built installers on the
**GitHub release** for convenience, and let Zenodo archive the source for
citation.

**Metadata gotcha.** If both `.zenodo.json` and `CITATION.cff` are present,
Zenodo reads `.zenodo.json` and ignores `CITATION.cff` completely. Both are
kept here (GitHub uses the latter for its cite button) but they must be kept in
step by hand. The licence lives in `LICENSE` only — Zenodo derives it from that
file, so it is deliberately absent from `.zenodo.json`.

## Robustness (v37)

- **state.json is lock-protected.** Sync FastAPI endpoints run in a threadpool,
  so "Hide all" fires one concurrent write per analysis. Unlocked, that lost
  19/20 updates. All read-modify-writes now go through `locked_state()`.
- **Writes are atomic** (temp file + fsync + os.replace), so a crash mid-write
  can't truncate the project file.
- **Failures are logged** to the console and `~/.gromax/gromax.log`. A result
  that computes but fails to register now warns in the Jobs panel instead of
  silently never appearing.
- **Caches key on file identity** (path + mtime + size), so overwriting a
  trajectory invalidates its cached results and frame counts automatically.
- **Polling is adaptive**: 2s while jobs run, 15s idle (~80% fewer idle requests).

## Verifying a change

Run `bash verify.sh` before packaging. `npx vite build` does NOT typecheck, so a
clean build alone doesn't mean the app works — two releases shipped broken that
way. verify.sh runs:

1. `tsc` (catches undefined identifiers — the v31 bug)
2. hook-order check (React rules-of-hooks — the v33 bug; tsc cannot catch this)
3. backend imports
4. parser tests (`backend/tests/test_parsers.py`)
5. runtime tests (`backend/tests/test_runtime.py`) — stride, job cancellation,
   subprocess reaping. Run under a hard timeout, because a cancellation
   regression leaves an un-reaped child that makes the suite HANG rather than
   fail.
6. backend concurrency (no `await` inside a lock; no bare `save_state`)
7. build

## Robustness notes

**Concurrent state writes.** `state.json` is mutated from FastAPI's threadpool
(sync `def` endpoints genuinely preempt each other) and from the job workers.
"Hide all" fires one POST per analysis simultaneously, so an unlocked
load-modify-save lost updates — measured at 19 of 20. Every read-modify-write
now goes through `session.locked_state()`, which holds a per-session re-entrant
lock. Never `await` inside that block: the lock is a threading lock and holding
it across an await can deadlock the event loop. `verify.sh` enforces both rules.

**Atomic writes.** `save_state()` writes to a temp file, fsyncs, then
`os.replace()`s — a crash mid-write can't leave a half-written project.

**Logging.** `~/.gromax/gromax.log` (rotating). Failures that the UI can't show
— a result computed but not registered, a state write that failed — are logged
rather than swallowed, and registration failures also warn in the Jobs panel.

**Polling.** Job polling runs at 2s while work is in flight and 15s when idle;
the health check is 15s when the backend is up and 3s when it's down. Roughly
80% fewer background requests on an idle day, with no loss of responsiveness.

**Caching.** Analysis cache keys and the frame-count cache are keyed on file
identity (path + mtime + size), so overwriting a trajectory invalidates stale
results automatically instead of silently serving the old ones.

## Tests

`backend/tests/test_parsers.py` covers the pure parsers — XVG, XPM (2D-RMSD
matrices), ndx groups, PDB chain mapping, selection normalisation, and the
`gmx hbond -pf` parser. These encode behaviour verified against real GROMACS
2024.2 output, so a regression here would otherwise be silent. Run via
`bash verify.sh`.

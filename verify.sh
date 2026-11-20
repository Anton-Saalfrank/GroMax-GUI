#!/usr/bin/env bash
# Pre-release verification. Run before packaging.
#
# Catches the two bug classes that shipped broken builds:
#   v31 — undefined identifiers survived a refactor (tsc catches: TS2304)
#   v33 — hooks after an early return (React rules-of-hooks; tsc does NOT catch)
# Vite's build does not typecheck, so a clean build proves nothing on its own.
set -e
cd "$(dirname "$0")"

# ── Preflight ────────────────────────────────────────────────────────────────
# Without this, `npx tsc` on a fresh checkout finds no local TypeScript and
# offers to download an UNRELATED package literally named `tsc` (different
# author, not the compiler) — which then prints a confusing message and exits 0,
# so the typecheck silently does nothing.
if [ ! -d node_modules ]; then
  echo "✗ node_modules missing — run 'npm install' first."
  echo "  (Skipping it makes npx fetch an unrelated package named 'tsc'.)"
  exit 1
fi

# Resolve the local compiler. Prefer the .bin shim, fall back to the package
# itself — npm has used both layouts, and a wrong guess here would send us back
# to npx and the bogus-package trap.
if [ -x node_modules/.bin/tsc ]; then
  TSC=./node_modules/.bin/tsc
elif [ -f node_modules/typescript/bin/tsc ]; then
  TSC="node node_modules/typescript/bin/tsc"
else
  echo "✗ TypeScript not installed locally. Run: npm install"
  echo "  Do NOT run 'npx tsc' — that downloads a different, unrelated package."
  exit 1
fi

if ! python3 -c "import fastapi, uvicorn, pydantic" 2>/dev/null; then
  echo "✗ Python dependencies missing. Run:"
  echo "    python3 -m pip install -r backend/requirements.txt"
  # Name the interpreter it actually tried. With several Pythons installed, the
  # deps are often present in one of them and `python3` resolves to another —
  # and then a correct bail reads like a broken suite.
  echo "  (tried: $(command -v python3) — prefix $(python3 -c 'import sys; print(sys.prefix)' 2>/dev/null || echo unknown))"
  exit 1
fi


# ── Portable timeout ─────────────────────────────────────────────────────────
# `timeout` is GNU coreutils and is NOT present on a stock macOS, where this
# script exited 127 at the first step that used it — so every check after that
# point silently never ran. Prefer the real thing when it exists, otherwise run
# the command with a watchdog that kills it. Returns 124 on timeout either way,
# matching GNU's convention so callers need only one case.
run_limited() {
  local secs="$1"; shift
  if command -v timeout > /dev/null 2>&1; then
    timeout "$secs" "$@"; return $?
  elif command -v gtimeout > /dev/null 2>&1; then
    gtimeout "$secs" "$@"; return $?
  fi
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2> /dev/null ) &
  local watcher=$!
  local rc=0
  wait "$pid" 2> /dev/null || rc=$?
  kill "$watcher" 2> /dev/null || true
  wait "$watcher" 2> /dev/null || true
  # 137 = SIGKILL, i.e. the watchdog fired.
  if [ "$rc" -eq 137 ]; then return 124; fi
  return "$rc"
}

echo "→ TypeScript"
$TSC --noEmit

echo "→ Prop destructuring"
# A prop declared in Props and used in the body but never destructured throws a
# ReferenceError at render, which unmounts the ENTIRE React tree — the whole
# window goes black with no message. tsc catches it as TS2304 when the project
# typechecks; this is a standalone check so it is caught even if tsc is skipped.
python3 scripts/propcheck.py || exit 1

echo "→ Plotly trace types registered in the partial bundle"
python3 scripts/check_plotly_traces.py || exit 1

echo "→ Lint (rules of hooks, exhaustive deps)"
# REPLACES a hand-rolled regex check for "hooks after an early return" — the
# v33 crash. That check could not see arrow-function components at all
# (`const X = () => {`), sliced function bodies by searching for the next
# `function` keyword so it read past the end of the last one in a file, and
# required the early return to be brace-wrapped and indented exactly two
# spaces. Given two deliberate violations it reported one, for the wrong
# reason. eslint-plugin-react-hooks does it from the AST.
#
# --max-warnings 0 on purpose: exhaustive-deps findings are warnings, and a
# rule carrying 42 standing warnings would never catch warning 43. The tree is
# at zero; keep it there.
if [ -x node_modules/.bin/eslint ]; then
  ./node_modules/.bin/eslint . --max-warnings 0 || exit 1
  echo "  no lint findings"
else
  echo "✗ eslint not installed. Run: npm install"
  exit 1
fi

echo "→ Backend undefined names"
# Python's import check does NOT catch this: a function whose `def` line is lost
# in a bad edit leaves its body as unreachable code inside the previous
# function. The module still imports cleanly and only fails at RUNTIME, mid-job,
# with "name 'x' is not defined". That shipped once. pyflakes catches it
# statically — this is the Python counterpart of the tsc check.
if python3 -m pyflakes --version > /dev/null 2>&1; then
  UNDEF=$(python3 -m pyflakes backend/ 2>&1 | grep -i "undefined name" || true)
  if [ -n "$UNDEF" ]; then
    echo "✗ Undefined names found:"
    echo "$UNDEF"
    exit 1
  fi
else
  echo "  (pyflakes not installed — skipping. Install with: pip install pyflakes)"
fi

echo "→ Backend imports"
(cd backend && python3 -c "import sys; sys.path.insert(0,'.'); import main" 2>/dev/null)

echo "→ Parser tests"
python3 backend/tests/test_parsers.py > /tmp/gromax_tests.log 2>&1 || { cat /tmp/gromax_tests.log; exit 1; }
tail -1 /tmp/gromax_tests.log

echo "→ Runtime tests (stride, cancellation, subprocess reaping)"
# Hard timeout: a cancellation regression leaves an un-reaped child that blocks
# event-loop teardown, so a broken build HANGS rather than failing. Cap it.
run_limited 120 python3 backend/tests/test_runtime.py > /tmp/gromax_runtime.log 2>&1
rc=$?
if [ $rc -eq 124 ]; then
  echo "  FAIL runtime tests timed out — likely an un-cancelled subprocess"
  cat /tmp/gromax_runtime.log; exit 1
elif [ $rc -ne 0 ]; then
  cat /tmp/gromax_runtime.log; exit 1
fi
tail -1 /tmp/gromax_runtime.log

echo "→ Helix motion geometry"
# Exact cases: translate 3 A along the axis -> piston 3; rotate 100 deg about it
# -> roll 100; a random rigid transform -> every metric unchanged after fitting.
# Also pins the axis-estimator bias and that tilt does not leak into roll.
python3 backend/tests/test_helix.py > /tmp/gromax_helix.log 2>&1 \
  || { cat /tmp/gromax_helix.log; exit 1; }
tail -1 /tmp/gromax_helix.log

echo "→ Helix motion end to end"
# Needs MDAnalysis. Skipped rather than failed where it is absent, so a machine
# without the optional engines can still run the rest of the suite.
if python3 -c "import MDAnalysis" 2>/dev/null; then
  python3 backend/tests/test_helix_e2e.py > /tmp/gromax_helix_e2e.log 2>&1 \
    || { cat /tmp/gromax_helix_e2e.log; exit 1; }
  tail -1 /tmp/gromax_helix_e2e.log
else
  echo "  (MDAnalysis not installed — skipping)"
fi

echo "→ Per-series plot styling"
./node_modules/.bin/esbuild src/lib/__tests__/plotSeries.test.ts --bundle \
  --platform=node --format=esm --outfile=/tmp/gromax_plotseries.mjs \
  --log-level=warning > /dev/null 2>&1 \
  || { echo "  esbuild failed"; exit 1; }
node /tmp/gromax_plotseries.mjs > /tmp/gromax_plotseries.log 2>&1 \
  || { cat /tmp/gromax_plotseries.log; exit 1; }
tail -1 /tmp/gromax_plotseries.log

echo "→ Saved filters as frame masks"
./node_modules/.bin/esbuild src/lib/__tests__/plotFilter.test.ts --bundle \
  --platform=node --format=esm --outfile=/tmp/gromax_plotfilter.mjs \
  --log-level=warning > /dev/null 2>&1 \
  || { echo "  esbuild failed"; exit 1; }
node /tmp/gromax_plotfilter.mjs > /tmp/gromax_plotfilter.log 2>&1 \
  || { cat /tmp/gromax_plotfilter.log; exit 1; }
tail -1 /tmp/gromax_plotfilter.log

echo "→ Paired statistics (vs scipy)"
./node_modules/.bin/esbuild src/lib/__tests__/pairedStats.test.ts --bundle \
  --platform=node --format=esm --outfile=/tmp/gromax_paired.mjs \
  --log-level=warning > /dev/null 2>&1 \
  || { echo "  esbuild failed"; exit 1; }
node /tmp/gromax_paired.mjs > /tmp/gromax_paired.log 2>&1 \
  || { cat /tmp/gromax_paired.log; exit 1; }
tail -1 /tmp/gromax_paired.log

echo "→ Per-residue normalisation of rolling-RMSF maps"
./node_modules/.bin/esbuild src/lib/__tests__/rowNormalise.test.ts --bundle \
  --platform=node --format=esm --outfile=/tmp/gromax_rownorm.mjs \
  --log-level=warning > /dev/null 2>&1 \
  || { echo "  esbuild failed"; exit 1; }
node /tmp/gromax_rownorm.mjs > /tmp/gromax_rownorm.log 2>&1 \
  || { cat /tmp/gromax_rownorm.log; exit 1; }
tail -1 /tmp/gromax_rownorm.log

echo "→ Axis frame, ticks and gridlines"
./node_modules/.bin/esbuild src/lib/__tests__/axisDecor.test.ts --bundle \
  --platform=node --format=esm --outfile=/tmp/gromax_axisdecor.mjs \
  --log-level=warning > /dev/null 2>&1 \
  || { echo "  esbuild failed"; exit 1; }
node /tmp/gromax_axisdecor.mjs > /tmp/gromax_axisdecor.log 2>&1 \
  || { cat /tmp/gromax_axisdecor.log; exit 1; }
tail -1 /tmp/gromax_axisdecor.log

echo "→ Axis locking, metric grouping and panel geometry"
./node_modules/.bin/esbuild src/lib/__tests__/axisLock.test.ts --bundle \
  --platform=node --format=esm --outfile=/tmp/gromax_axislock.mjs \
  --log-level=warning > /dev/null 2>&1 \
  || { echo "  esbuild failed"; exit 1; }
node /tmp/gromax_axislock.mjs > /tmp/gromax_axislock.log 2>&1 \
  || { cat /tmp/gromax_axislock.log; exit 1; }
tail -1 /tmp/gromax_axislock.log

echo "→ Snapshot list ordering"
./node_modules/.bin/esbuild src/lib/__tests__/snapshotGroups.test.ts --bundle \
  --platform=node --format=esm --outfile=/tmp/gromax_snapgroups.mjs \
  --log-level=warning > /dev/null 2>&1 \
  || { echo "  esbuild failed"; exit 1; }
node /tmp/gromax_snapgroups.mjs > /tmp/gromax_snapgroups.log 2>&1 \
  || { cat /tmp/gromax_snapgroups.log; exit 1; }
tail -1 /tmp/gromax_snapgroups.log

echo "→ Request cancellation and timeouts"
./node_modules/.bin/esbuild src/api/__tests__/requestSlot.test.ts --bundle \
  --platform=node --format=esm --outfile=/tmp/gromax_reqslot.mjs \
  --log-level=warning > /dev/null 2>&1 \
  || { echo "  esbuild failed"; exit 1; }
node /tmp/gromax_reqslot.mjs > /tmp/gromax_reqslot.log 2>&1 \
  || { cat /tmp/gromax_reqslot.log; exit 1; }
tail -1 /tmp/gromax_reqslot.log

echo "→ Topology content store (dedup by hard link)"
python3 backend/tests/test_topology_store.py > /tmp/gromax_topostore.log 2>&1 \
  || { cat /tmp/gromax_topostore.log; exit 1; }
tail -1 /tmp/gromax_topostore.log

echo "→ Error bands agree between Results and Compare tabs"
python3 backend/tests/test_band_consistency.py > /tmp/gromax_band.log 2>&1 \
  || { cat /tmp/gromax_band.log; exit 1; }
tail -1 /tmp/gromax_band.log

echo "→ Combining replicas (mean, spread, payload)"
python3 backend/tests/test_replica_agg.py > /tmp/gromax_repagg.log 2>&1 \
  || { cat /tmp/gromax_repagg.log; exit 1; }
tail -1 /tmp/gromax_repagg.log

echo "→ Cross-condition per-residue baseline"
python3 backend/tests/test_row_baseline.py > /tmp/gromax_baseline.log 2>&1 \
  || { cat /tmp/gromax_baseline.log; exit 1; }
tail -1 /tmp/gromax_baseline.log

echo "→ Cavity from a surface click"
python3 backend/tests/test_cavity_at.py > /tmp/gromax_cavityat.log 2>&1 \
  || { cat /tmp/gromax_cavityat.log; exit 1; }
tail -1 /tmp/gromax_cavityat.log

echo "→ Surface picking (real WebGL window)"
# Needs a GPU context and a window server, so it is skipped on a headless CI
# box rather than failing there.
if [ -z "$CI" ] && [ -x ./node_modules/.bin/electron ]; then
  ( unset ELECTRON_RUN_AS_NODE
    ./node_modules/.bin/electron electron/surfacepick-test/main.js ) \
      > /tmp/gromax_surfacepick.log 2>&1 \
    || { grep -vE "^\[|Warning|DevTools" /tmp/gromax_surfacepick.log; exit 1; }
  grep -E "^ALL PASS|FAILED|  note" /tmp/gromax_surfacepick.log | head -3
else
  echo "  (no Electron or running in CI — skipping)"
fi

echo "→ Backend process lifecycle (Electron launcher)"
# A backend that ignores SIGTERM must still die, and a busy port must be
# identified rather than producing a second, failing backend.
node electron/killBackend.test.js > /tmp/gromax_kill.log 2>&1 \
  || { cat /tmp/gromax_kill.log; exit 1; }
tail -1 /tmp/gromax_kill.log
node electron/portCheck.test.js > /tmp/gromax_port.log 2>&1 \
  || { cat /tmp/gromax_port.log; exit 1; }
tail -1 /tmp/gromax_port.log

echo "→ Renderer navigation guard (Electron)"
# window.open() is not covered by will-navigate, and a new window inherits the
# preload — so the IPC bridge was reachable from a page the app never loaded.
node electron/navGuard.test.js > /tmp/gromax_nav.log 2>&1 \
  || { cat /tmp/gromax_nav.log; exit 1; }
tail -1 /tmp/gromax_nav.log

echo "→ Event loop stays responsive during analysis"
python3 backend/tests/test_loop_responsive.py > /tmp/gromax_loop.log 2>&1 \
  || { cat /tmp/gromax_loop.log; exit 1; }
tail -1 /tmp/gromax_loop.log

echo "→ MDTraj SASA against an independent reference"
if python3 -c "import mdtraj" 2>/dev/null; then
  python3 backend/tests/test_mdtraj_sasa.py > /tmp/gromax_mdtsasa.log 2>&1 \
    || { cat /tmp/gromax_mdtsasa.log; exit 1; }
  tail -1 /tmp/gromax_mdtsasa.log
else
  echo "  (MDTraj not installed — skipping)"
fi

echo "→ Hydration (water contacts)"
if python3 -c "import MDAnalysis" 2>/dev/null; then
  python3 backend/tests/test_hydration.py > /tmp/gromax_hydration.log 2>&1 \
    || { cat /tmp/gromax_hydration.log; exit 1; }
  tail -1 /tmp/gromax_hydration.log
else
  echo "  (MDAnalysis not installed — skipping)"
fi

echo "→ Cavity volume geometry"
# Analytic volumes, rotation invariance, and bulk-solvent rejection.
if python3 -c "import scipy" 2>/dev/null; then
  python3 backend/tests/test_cavity.py > /tmp/gromax_cavity.log 2>&1 \
    || { cat /tmp/gromax_cavity.log; exit 1; }
  tail -1 /tmp/gromax_cavity.log
else
  echo "  (scipy not installed — skipping)"
fi

echo "→ Static route confinement (path traversal)"
python3 backend/tests/test_static_confinement.py > /tmp/gromax_static.log 2>&1 \
  || { cat /tmp/gromax_static.log; exit 1; }
tail -1 /tmp/gromax_static.log

echo "→ Project archive (archive / restore / permanent delete)"
python3 backend/tests/test_project_archive.py > /tmp/gromax_archive.log 2>&1 \
  || { cat /tmp/gromax_archive.log; exit 1; }
tail -1 /tmp/gromax_archive.log

echo "→ Replica selection"
python3 backend/tests/test_replica_selection.py > /tmp/gromax_reps.log 2>&1 \
  || { cat /tmp/gromax_reps.log; exit 1; }
tail -1 /tmp/gromax_reps.log

echo "→ Contact counting (atom pairs vs residue pairs)"
# The three different questions behind the word "contacts", each checked
# against a geometry counted by hand. Needs MDAnalysis.
if python3 -c "import MDAnalysis" 2>/dev/null; then
  python3 backend/tests/test_contact_count.py > /tmp/gromax_contacts.log 2>&1 \
    || { cat /tmp/gromax_contacts.log; exit 1; }
  tail -1 /tmp/gromax_contacts.log
else
  echo "  (MDAnalysis not installed — skipping)"
fi

echo "→ GROMACS selection -> index group"
# Does a typed selection become the atoms asked for? Needs a real gmx; skips
# itself where there is none.
python3 backend/tests/test_gmx_selection.py > /tmp/gromax_sel.log 2>&1 \
  || { cat /tmp/gromax_sel.log; exit 1; }
tail -1 /tmp/gromax_sel.log

echo "→ Atom picks -> make_ndx selection"
# Clicking individual atoms used to widen to whole residues and be refused.
# Checks the string, then hands it to a real gmx where there is one.
python3 backend/tests/test_pick_selection.py > /tmp/gromax_picksel.log 2>&1 \
  || { cat /tmp/gromax_picksel.log; exit 1; }
tail -1 /tmp/gromax_picksel.log

echo "→ Matrix distribution"
python3 backend/tests/test_matrix_distribution.py > /tmp/gromax_dist.log 2>&1 \
  || { cat /tmp/gromax_dist.log; exit 1; }
tail -1 /tmp/gromax_dist.log

echo "→ CSV export"
python3 backend/tests/test_export_csv.py > /tmp/gromax_csv.log 2>&1 \
  || { cat /tmp/gromax_csv.log; exit 1; }
tail -1 /tmp/gromax_csv.log

echo "→ Backend concurrency"
python3 - << 'PY'
import ast, glob, sys
# 1. No await inside a locked_state block (threading lock across await = deadlock)
# 2. No bare save_state() outside session.py (must go through locked_state)
problems = 0
for f in glob.glob('backend/core/*.py'):
    tree = ast.parse(open(f).read())
    for node in ast.walk(tree):
        if not isinstance(node, (ast.With, ast.AsyncWith)): continue
        if not any(isinstance(i.context_expr, ast.Call) and
                   getattr(i.context_expr.func,'id','')=='locked_state'
                   for i in node.items): continue
        if any(isinstance(s,(ast.Await,ast.AsyncFor,ast.AsyncWith)) for s in ast.walk(node)):
            print(f"  FAIL {f}:{node.lineno} await inside locked_state (deadlock risk)")
            problems += 1
    if not f.endswith('session.py'):
        src = open(f).read()
        for i, line in enumerate(src.splitlines(), 1):
            if line.strip().startswith('save_state(') :
                print(f"  FAIL {f}:{i} bare save_state — use locked_state()")
                problems += 1
sys.exit(1 if problems else 0)
PY

echo "→ App renders under the dev server"
# The build passing does not mean `npm run dev` works: the dev server resolves
# dependencies differently, and a partial Plotly bundle once broke dev only —
# blank window, every other check green. Port 5180 so a dev server the user is
# already running on 5173 is left alone.
#
# Opens a real Electron window, so it needs a window server. GitHub's
# ubuntu-latest runner is headless and Electron exits with "Missing X server or
# $DISPLAY" there, which would fail every push for a reason that has nothing to
# do with the code — so CI skips it, the same way the WebGL surface-pick test
# does. It could be run under xvfb-run later; that is untested here and an
# untested CI path is worse than a stated gap.
DEV_PORT=5180
if [ -n "$CI" ]; then
  echo "  (headless CI — skipping; needs a window server)"
elif lsof -nP -iTCP:$DEV_PORT -sTCP:LISTEN > /dev/null 2>&1; then
  echo "  (port $DEV_PORT busy — skipping)"
else
  ./node_modules/.bin/vite --port $DEV_PORT --strictPort --force \
    > /tmp/gromax_devserver.log 2>&1 &
  DEV_PID=$!
  DEV_UP=0
  for _ in $(seq 1 60); do
    if curl -s --max-time 1 -o /dev/null "http://localhost:$DEV_PORT/"; then DEV_UP=1; break; fi
    sleep 0.5
  done
  if [ "$DEV_UP" != "1" ]; then
    echo "  dev server never came up:"; tail -5 /tmp/gromax_devserver.log
    kill $DEV_PID 2>/dev/null; exit 1
  fi
  env -u ELECTRON_RUN_AS_NODE PROFILE=/tmp/gromax_dev_profile \
    ./node_modules/.bin/electron scripts/dev_render_check.js \
    "http://localhost:$DEV_PORT/" 2>/dev/null | grep -E "^ " 
  RC=${PIPESTATUS[0]}
  kill $DEV_PID 2>/dev/null
  wait $DEV_PID 2>/dev/null
  [ "$RC" = "0" ] || exit 1
fi

echo "→ Build"
npx vite build > /dev/null 2>&1

echo "✓ All checks passed"

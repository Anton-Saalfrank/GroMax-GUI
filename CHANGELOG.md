# Changelog

Notable changes per release. Versions follow [semantic versioning](https://semver.org/).

Development history before 1.0.0 was tracked informally as "v1"–"v37" and is
summarised below rather than reproduced release by release.

## [1.0.0] — unreleased

First versioned release. Consolidates the v1–v37 development series and fixes
several correctness bugs found in review.

### Fixed
- **Stride had no effect.** `stride` was accepted by the API and folded into the
  analysis cache key but was never passed to GROMACS, so setting it forced a
  re-run that produced byte-identical data at full cost. It is now translated to
  `gmx -dt` using the trajectory's own timestep (`gmx check`, cached on file
  identity). When the timestep cannot be determined the run proceeds at full
  resolution with a warning rather than guessing.
- **Job cancellation did nothing.** `cancel_job` only set a status field; the
  coroutine and its `gmx` subprocess kept running, and the worker then
  overwrote the status back to `completed`. Jobs now run as individually
  cancellable tasks and cancellation kills the subprocess.
- **Zombie processes.** `proc.kill()` on timeout was never followed by
  `proc.wait()`, leaking zombies over long sessions. Both the timeout and
  cancellation paths now reap.
- **SASA timeout** was 120 s despite documenting 10 minutes, failing legitimate
  long-trajectory runs. Now 600 s.
- **`max_parallel_jobs` was ignored.** The setting existed in config and in the
  UI but the worker pool was hardcoded to 4. It is now applied at startup.
- **Packaged Electron builds could not reach their backend.** The production
  window loaded the UI via `file://`, which sends `Origin: null`; the CORS
  allow-list matched only two localhost origins, so every API request was
  blocked. The backend now serves the built frontend itself and Electron loads
  it over HTTP from the same origin.

### Changed
- Backend port is chosen at runtime instead of being hardcoded to 7432, so a
  second instance (or anything already on that port) no longer breaks startup.
- Fonts are self-hosted via `@fontsource` instead of fetched from Google Fonts,
  so the packaged app works offline and makes no third-party requests.
- Generic file-manager endpoints moved from `/api/pca/*` to `/api/files/*`.
- Backend shutdown escalates SIGTERM to SIGKILL and guards against orphaning
  the Python process if the app crashes.

### Internal
- The five single-series analyses (RMSD, RMSF, Rg, H-bonds, minimum distance)
  had near-identical `build_args`/`parse` implementations; these are now
  declarative attributes on `BaseAnalysis`. SASA no longer overrides `run()`.
  Verified to produce identical commands and identical parsed output.
- Removed a duplicated colour palette (three copies, one of which shadowed its
  own import) and an unused theme helper.
- Added `backend/tests/test_runtime.py` covering stride, cancellation and
  subprocess reaping; wired into `verify.sh`.

## v1–v37 (development series, unreleased)

Highlights from the pre-1.0 development history:

- **v37** — `state.json` writes made lock-protected and atomic; failures logged
  to `~/.gromax/gromax.log`; caches keyed on file identity (path + mtime + size)
  so overwriting a trajectory invalidates stale results; adaptive job polling.
- **v33** — fixed a React rules-of-hooks violation (hooks after an early
  return) that shipped broken; `verify.sh` gained a hook-order check because
  `tsc` cannot catch it.
- **v31** — fixed undefined identifiers that survived a refactor; `verify.sh`
  gained a `tsc --noEmit` step because `vite build` does not typecheck.
- Earlier — shared-basis PCA, multi-chain system mapping, residue contacts
  (distance and hydrogen-bond modes), the Compare tab / Plot Studio, persistent
  named analyses, and light/dark theming.

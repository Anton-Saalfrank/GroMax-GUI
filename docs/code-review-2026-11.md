# GroMax GUI — code review

**Date:** 2026-11-02 · **Scope:** whole app (~18.7k lines TypeScript/React, ~13.5k
lines Python, ~800 lines Electron) · **Method:** read the code, then verified the
findings that were testable by running them.

Findings are ordered by what I would fix first, not by where they live. Every
claim marked **verified** was reproduced; the rest are judgement calls and are
labelled as such.

---

## 0. Verdict first

This is better engineered than most scientific software. The things that are
usually wrong here are right:

- **No `shell=True` anywhere.** Every subprocess call uses `exec` with an
  argument list, so GROMACS selections — which are user-supplied strings full
  of `&`, `!` and `|` — cannot become shell commands.
- **Atomic state writes** (`session.py:102`): temp file plus `os.replace()`, so
  a crash mid-write cannot destroy a project.
- **Read-modify-write on `state.json` is locked** (`locked_state()`,
  `session.py:161`). I went looking for a lost-update race between the debounced
  workspace save and job completion; it was already found and fixed, and the
  comment above it names the exact symptoms it caused. Only three `save_state`
  calls exist and all are either inside the lock or on a freshly created state.
- **Electron is configured correctly**: `contextIsolation: true`,
  `nodeIntegration: false`, `webSecurity: true`, explicit `contextBridge`
  surface. No `dangerouslySetInnerHTML` anywhere, so React's escaping is intact.
- **PCA delegates eigen-decomposition to `gmx covar`/`anaeig`** rather than
  rolling its own, which sidesteps eigenvector sign indeterminacy and ordering —
  the two things that most hand-written PCA gets wrong. Pooling conditions
  before diagonalising, so they share a subspace, is also the correct choice.
- **The test suite tests the right things.** 3.7k lines of tests against 13.5k
  of backend source, and they assert against independently computed values
  (an independent Shrake–Rupley, analytic cavity volumes, scipy reference
  p-values) rather than against another run of the same code.

The debt is concentrated in two places: **a handful of real security bugs on the
localhost surface**, and **three files that have grown past the point where
anyone can hold them in their head**.

---

## 1. Must fix

### 1.1 Arbitrary file read through the SPA catch-all route — **verified**

`backend/main.py:175-183`

```python
@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith(("api/", "health")):
        raise HTTPException(status_code=404, detail="Not found")
    candidate = (dist / full_path) if full_path else (dist / "index.html")
    if candidate.is_file():
        return FileResponse(str(candidate))
```

`full_path` is URL-decoded before it reaches this function, and nothing
constrains the result to `dist/`. I confirmed this against a running backend
with raw sockets (so no client-side path normalisation could interfere):

```
LEAK  HTTP/1.1 200 OK   /../../../../../etc/passwd
LEAK  HTTP/1.1 200 OK   /..%2f..%2f..%2f..%2f..%2fetc%2fpasswd
LEAK  HTTP/1.1 200 OK   /../../../../../../etc/hosts
LEAK  HTTP/1.1 200 OK   /../backend/main.py
```

**Severity: moderate, not critical.** The server binds `127.0.0.1`, and the CORS
regex only allows localhost origins, so a malicious *web page* can issue the
request but cannot read the response. The real exposure is any other local
process or script, which can read any file the backend user can — including
`~/.ssh`, keychains and the trajectory data itself.

**Fix** — resolve and confine:

```python
root = dist.resolve()
candidate = (root / full_path).resolve() if full_path else (root / "index.html")
if not candidate.is_relative_to(root):          # Python 3.9+
    return FileResponse(str(root / "index.html"))
if candidate.is_file():
    return FileResponse(str(candidate))
return FileResponse(str(root / "index.html"))
```

Worth a regression test in `verify.sh` — the probe I wrote is four lines of
`socket` and would have caught this.

### 1.2 The Electron "safe subset" is not a subset

`electron/preload.js:22` says `// File system (safe subset)` and
`electron/main.js:196` repeats it. Neither is true:

```js
ipcMain.handle('fs:read-file', async (_, filePath) => {
  return { ok: true, data: fs.readFileSync(filePath, 'utf8') }   // any path
})
ipcMain.handle('shell:open-path', async (_, filePath) => {
  await shell.openPath(filePath)                                  // any path
})
```

`fs:read-file` reads any file; `shell:open-path` will happily hand a `.app`,
`.command`, `.sh` or `.exe` to the OS to **execute**. There is no XSS vector in
the app today (no `innerHTML`, React escapes everything), so this is defence in
depth rather than a live hole — but a comment that claims validation exists is
worse than no comment, because it tells the next reader not to look.

**Fix:** confine `fs:read-file` to the projects directory and the paths recorded
in the open project; restrict `shell:open-path` to directories and known-inert
extensions, or replace it with `shell.showItemInFolder`, which is what the
"reveal file" feature actually wants. Then make the comments say what is
enforced.

### 1.3 `window.open` is not covered by the navigation guard

`electron/main.js:282-295` guards `will-navigate` but there is no
`setWindowOpenHandler`, so `window.open()` can still create a window — and new
windows inherit the preload bridge. Also, the guard's fallback is
`shell.openExternal(url)` for *any* non-allowed origin, which hands `file://`,
`smb://` and arbitrary custom protocol handlers to the OS.

```js
contents.setWindowOpenHandler(({ url }) => {
  const u = new URL(url)
  if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(url)
  return { action: 'deny' }
})
// and in will-navigate, gate the openExternal on http/https too
```

### 1.4 CI does not run on commits

`.github/workflows/build.yml` triggers only on `push: tags: ["v*"]` and
`workflow_dispatch`. So `verify.sh` — which exists specifically because broken
builds shipped twice — runs for the first time at release. Add:

```yaml
on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
  workflow_dispatch:
```

The verify job is ~2 minutes; there is no reason not to.

---

## 2. Correctness bugs in the plot styling I just added

These are mine, from this session's work, and they are the exact class of bug
`plotSeries.ts`'s own docstring says the file exists to prevent ("two sites
disagreeing about one visual property"). I introduced a second set of style
helpers and did not finish routing the old call sites through it.

| Site | Uses | Consequence |
|---|---|---|
| `CompareTab.tsx:980` | `resolveSeriesStyle(null, …)` | **Filtered** chart (no saved filters) ignores per-series overrides. Set WT's dot colour, switch to Filtered, nothing happens. |
| `CompareTab.tsx:480, 502` | `markerStyle(style, colour, …)` | **Correlation** scatter ignores per-series overrides. |
| `CompareTab.tsx:821, 965` | `barStyleFor(style, …)` | `per_replica` bars and `per_replica` filtered bars ignore overrides. |

**Fix:** pass `baseSeries(conditionId)` at 980, and convert the three
`markerStyle`/`barStyleFor` sites to `seriesMarker`/`seriesBar` over a resolved
style. Then **delete `markerStyle` and `barStyleFor` from `PlotStyleControls`**
so the duplication cannot come back. `errorBarStyle` can stay — error-bar style
is still figure-wide (that was §9.1, still unanswered).

### 2.1 Minor, same area

- `PlotStyleControls.tsx:315` — `Over` is a component declared inside the render
  body, so it is a new component type every render. It only renders a button so
  nothing breaks, but it is the same pattern that caused the focus-loss bug I
  fixed in `sField`. Make it a render function for consistency.
- `CompareTab.tsx:547, 696` — two local `const conditions` shadow the new
  component-level `conditions` list. Harmless today (neither block touches the
  outer one) but it is a loaded gun; rename to `condMap`/`condList` as I already
  did at line 849.

---

## 3. Architecture: three files are too big

| File | Lines | Hook/def sites | Problem |
|---|---|---|---|
| `backend/core/analysis_runner.py` | 2152 | 12 HTTP endpoints | Does index-group construction, subprocess orchestration, replica aggregation, CSV export, cross-correlation, row baselining and matrix distribution |
| `src/components/StructureViewer.tsx` | 1736 | 71 | One 240-line `useEffect` (`:516`), another ~190 lines (`:758`), 8 effects whose only job is mirroring state into refs |
| `src/components/CompareTab.tsx` | 1923 | 57 | Six plot modes, each with its own memo, plus all the controls for all of them |

None of this is wrong code. It is code that nobody can safely change, which
eventually becomes the same thing. The repo's own history bears this out: the
`tracesByMode` exhaustive `Record<Mode, …>` and the "no early return here"
comment both exist because this file broke in ways that were hard to see.

### 3.1 `analysis_runner.py` — split along the seams that already exist

The section comments are already the module boundaries:

```
core/ndx_builder.py       lines  95-656   selection → index group, and the diagnoser
core/engine_process.py    lines 893-1083  spawn, watchdog, line callbacks
core/replica_agg.py       lines 706-892   _agg_replicas, _matrix_stats, residue mapping
core/analysis_runner.py   the endpoints + _make_run_coro
core/derived.py           correlate, row_baseline, matrix_distribution, export_csv
```

This is a pure move — no logic changes — and it makes the untested parts
testable in isolation. `build_ndx_for_selections` (324-563, ~240 lines) and
`_make_run_coro` (1084-1337, ~254 lines) are each worth decomposing after the
move, but the move alone is the win.

### 3.2 `StructureViewer.tsx` — extract the NGL imperative layer

The eight ref-mirroring effects (`selectedRef`, `pickModeRef`, `modeRef`,
`morphSecondsRef`, …) are the tell: React state and an imperative WebGL scene
graph are fighting, and refs are the referee. Extract a `useNglStage()` hook
that owns the stage, the components and the representations, and exposes
imperative methods. The component then holds UI state only. The morph logic
(`:1113-1310`) is already nearly separable and could go to `useMorph()` today.

### 3.3 `CompareTab.tsx` — one file per mode

Each mode's memo is independent and depends only on `(byKey, metricA, metricB,
excluded, style, …)`. Moving each to `src/components/plots/modes/<mode>.ts` as a
pure `buildTraces(args) → { traces, layout, notes }` function would:

- cut the component to selection + layout + dispatch;
- make the trace builders **unit-testable**, which none of them are today —
  and the multi-series builder I added this session has real logic in it (the
  replica intersection, the mixed-units detection, the paired/unpaired
  decision) that is currently only checked by eye.

The `tracesByMode` exhaustive record keeps working and keeps its guarantee.

---

## 4. Testing and tooling gaps

### 4.1 No ESLint at all

No `.eslintrc*`, no `eslint` in `node_modules`, no `lint` script. For a React
codebase whose changelog records *"v33 — hooks after an early return"*, the
absence of `eslint-plugin-react-hooks` is the single highest-leverage gap in the
repo.

`verify.sh`'s hand-rolled "Hook-order safety" check is a regex with blind spots
I confirmed by running it against a file containing two deliberate violations:

- It only iterates `function NAME(` declarations, so **arrow-function
  components (`const X = () => {`) are never scanned**.
- Its body slice runs to the next `function` keyword, so for the last function
  in a file it reads past the end — it flagged one of my test components for a
  violation that was actually in the *next* component.
- The early-return pattern requires `\n  if (…) {` with exactly two spaces and a
  brace, so `if (!data) return null` is missed.

It reported 1 of 2 violations, and for the wrong reason.

To be clear: **I found no actual rules-of-hooks violation in the codebase
today.** I wrote a brace-matched scanner; its two hits in `CompareTab.tsx` are
both false positives (returns inside nested callbacks). The problem is the
enforcement, not the current state.

```bash
npm i -D eslint @eslint/js typescript-eslint eslint-plugin-react-hooks \
          eslint-plugin-react-refresh
```

with `react-hooks/rules-of-hooks: error` and `react-hooks/exhaustive-deps: warn`.
Then replace the regex step in `verify.sh` with `npm run lint`. `exhaustive-deps`
will also flag the `[keys.join(',')]` dependency pattern used in six places
(`CompareTab.tsx:172, 205`, `ResultsTab.tsx:184`, `MatrixDistributionPanel.tsx:76`,
`ContactsTab.tsx:37`) — stringified deps work but hide what the effect really
depends on.

### 4.2 `noUnusedLocals: false`

`tsconfig.json` disables it, so dead code accumulates silently. I hit this
directly this session: a `SERIES_FIELDS` constant I wrote and never used
typechecked clean. Turn it on; it is a one-time cleanup and then free.

### 4.3 Untested modules worth testing

`test_parsers.py` covers the parsers well. The gaps that matter, by size and
risk:

| Module | Lines | Why it matters |
|---|---|---|
| `core/pca_runner.py` | 534 | Frame pooling, per-condition projection, extreme-structure generation. Delegating the maths to `gmx` removes the numerical risk but not the bookkeeping risk — a mislabelled condition in a projection is invisible. |
| `core/contact_query.py` | 489 | Partially covered by `test_parsers`. The query normalisation is the part that bit you on the ncontacts discrepancy. |
| `core/correlate.py` | 246 | Lag conventions and sign. Easy to get backwards, impossible to spot in a plot. |
| frontend trace builders | ~900 in `CompareTab` | Zero coverage. See §3.3. |

### 4.4 ~~`verify.sh` exits 0 on missing dependencies~~ — **WITHDRAWN, I was wrong**

I originally reported that the suite returns 0 when the Python dependencies are
missing, and therefore that CI could go green having run nothing. **That is
false.** `verify.sh:34` already does `exit 1` on that path, and it works:

```
$ ./verify.sh > log 2>&1; echo $?
1
```

My measurement was the error: I had run `./verify.sh 2>&1 | tail -40; echo $?`,
which reports the exit status of `tail`, not of the script.

What remains is much smaller. The check uses whichever `python3` is first on
`PATH`; on this machine that is `/Library/Frameworks/Python.framework/3.13`
while the dependencies live in `/opt/miniconda3`, so a correct bail reads like
a broken suite until you notice. CI pins 3.11 and is unaffected. **Fixed** by
naming the interpreter in the error message.

---

## 5. Dependencies and packaging

### 5.1 Electron 30 is end of life

`electron@30.5.1` is installed. Electron supports the latest three majors; 30 is
well past that, so it is shipping an unpatched Chromium. This is the most
consequential dependency issue because the renderer loads and parses
user-supplied files. Upgrade to a supported major.

### 5.2 Two unused runtime dependencies — **verified**

```
axios            not imported anywhere (the API client uses fetch)
react-dropzone   not imported anywhere
```

`axios` also carries a high-severity advisory. Remove both: smaller bundle,
smaller attack surface, two fewer things to audit.

### 5.3 `npm audit --omit=dev`: 16 vulnerabilities, 3 critical

The one that actually ships and matters:

```
critical  plotly.js  →  maplibre-gl  XSS sanitizer bypass in DOM.sanitize()
```

Not reachable in this app (no map traces), but it is in the bundle. `plotly.js`
is pinned `^2.30.0`; a 2.x bump should resolve it. The remaining high-severity
entries (`postcss`, `source-map-js`, `browserslist`, `nanoid`) are build-time
and lower priority.

### 5.4 macOS signing

`hardenedRuntime: true` with no `afterSign` notarization hook means Gatekeeper
will still block the DMG on another machine. If you distribute outside your own
Mac, this needs `electron-notarize` wiring and an Apple Developer ID.

---

## 6. Storage and performance

### 6.1 Measured on your own projects

```
295M   ~/.gromax/projects/19117eb2/cache
203M   ~/.gromax/projects/e06fc8a4/cache
146M   ~/.gromax/projects/bd908ffb/cache
```

There is no size accounting, no eviction and no indication in the UI. `Clear
cache` exists (`AnalysesTab.tsx:727`) but you have to know to look. **Suggestion:**
show cache size per project on the home screen, next to the archive control that
already lives there. One `du` per project folder on the existing project-list
call.

### 6.2 Duplicated topology PDBs — **verified**

```
9 files × 8.4 MB = 76 MB
but only 2 distinct contents (5 copies of one, 4 of the other)
```

The names are `topology_<hash>_<hash>.pdb`, so the same structure is being stored
once per condition (or per replica). Content-addressing on the file hash alone
would cut this to ~17 MB, and reference-counting is not needed if the cache is
clearable wholesale, which it is.

### 6.3 `/api/analysis/results/{session_id}` payload

Heatmap and xcorr matrices are correctly stripped (`analysis_runner.py:1498`,
with a comment explaining why). Line results are not, and
`useLineResults` refetches the whole set on every change in completed-job count.
Your largest single cache file is 1.0 MB and the biggest replica file is 1.6 MB,
so this is not hurting yet — but for 10 replicas × 4 µs at a fine stride it will.
A `?metadata_only=1` variant plus on-demand fetch (the pattern already used for
matrices) is the natural fix.

### 6.4 No request timeouts or cancellation

`src/api/client.ts` has no `AbortController` anywhere. A hung `trjconv` behind
`/api/structure/frame` leaves the UI spinning with no way out. Add an
`AbortSignal` with a per-endpoint timeout, and abort in-flight requests on
session change — which also fixes §6.5.

### 6.5 Stale-response races

`openSession` (`store/index.ts:561`) and `pollJobs` (`:635`) both check state
before `await` and write after. Click project A then B quickly and A's response
can land last. A monotonically increasing request id, or an `AbortController`
per session, removes it. Low severity, trivially fixable.

### 6.6 Multi-instance writes

`locked_state()` is a process-local `threading.RLock`. Two backend instances
sharing `~/.gromax/projects` (two app copies on different ports) would race past
it. `portCheck.js` prevents the common case. If you want to close it properly,
the lock needs to be a file lock (`fcntl.flock` on a sibling `.lock`).

---

## 7. Smaller observations

- **229 `any` uses** across the frontend, concentrated in `StructureViewer` (41)
  and `CompareTab` (38). Most are unavoidable Plotly/NGL interop. Worth defining
  a narrow `PlotlyTrace` interface for the fields you actually set — the trace
  builders would then be typechecked, which matters more once they move to their
  own modules (§3.3).
- **43 `except Exception` handlers**, 6 of which are bare `pass`. Most are
  defensible ("a lost layout is not worth interrupting anyone for" is a fair
  call). `appconfig.py:58` and `session.py:331` swallow enough that a real
  problem could hide; a `log.debug(...)` in each costs nothing.
- **`SessionState(**json.loads(...))`** — pydantic v2 ignores extra fields, so
  forward compatibility is fine, but a *type* change in a future build raises a
  bare `ValidationError` → HTTP 500. Catching it and returning "this project was
  written by a newer version of GroMax" would be kinder.
- **`verify.sh` is 13.6k and growing.** It is genuinely good — the "note" lines
  that record *why* a check exists (the NGL surface-picking one especially) are
  the kind of thing that normally lives only in someone's memory. Consider
  splitting into `verify/` with one script per area, run by an index script, so
  individual checks can be run alone during development.
- **`docs/` has one file.** `plot-studio-v2.md` is a good model — measured
  current state, named traps, build order. An `ARCHITECTURE.md` with the module
  map and the three or four invariants (every state write goes through
  `locked_state`; every trace style goes through `resolveSeriesStyle`; engines
  run in a separate process and never touch state) would pay for itself.

---

## 8. If you only do five things

1. **Confine the SPA route** (`main.py:175`) and add the four-line socket
   regression test. It is the only finding here that leaks data today.
2. **Add ESLint with `react-hooks`** and make CI run on pushes and PRs. This
   addresses the bug class your changelog says has shipped twice, properly
   rather than heuristically.
3. **Finish routing the plot styles through `resolveSeriesStyle`** (§2) and
   delete `markerStyle`/`barStyleFor`. This is a bug I introduced and it is a
   30-minute fix.
4. **Upgrade Electron; drop `axios` and `react-dropzone`.**
5. **Split `analysis_runner.py`** along its existing section comments. Pure move,
   no behaviour change, unlocks testing for the parts that have none.


---

## 9. Tranche 1 — done (2026-11-02)

Everything in this section is implemented and the full suite passes (`exit 0`,
`✓ All checks passed`). Two new steps were added to `verify.sh`.

| Finding | What changed | Verified by |
|---|---|---|
| §1.1 path traversal | `main.py` resolves and confines to `dist/`, falling back to index.html for anything outside | `backend/tests/test_static_confinement.py` — raw sockets, since no HTTP client will send `..` unnormalised. **Fails 12/12 against the old code.** |
| §1.2 Electron fs/shell | `fs:read-file`, `fs:file-exists` and `shell:open-path` **removed** from main.js, preload.js and the `ElectronAPI` type | Nothing in `src/` ever called them — all twelve bridge methods have zero call sites, and "Reveal in Finder" is a backend endpoint |
| §1.3 `window.open` | `setWindowOpenHandler` denies every new window; both it and `will-navigate` hand only http/https to the OS. Logic extracted to `electron/navGuard.js` | `electron/navGuard.test.js` — 31 assertions, including prefix-confusion (`:74321`, `:7432.evil.com`, `@evil.com`) |
| §2 plot styling | All five sites routed through `resolveSeriesStyle`; `markerStyle`/`barStyleFor` **deleted** | `tsc` clean, `plotSeries.test.ts` passes, no call sites remain |
| §5.2 unused deps | `axios` and `react-dropzone` removed | Production audit: 16 → 14 vulnerabilities |
| — (new) no CSP | Content-Security-Policy added for the packaged app; dev excluded because Vite HMR needs eval and a websocket | Launched Electron against the backend-served `dist/` with the CSP active: React mounted (`#root children = 1`), CSS applied, zero violations |

### Deliberately not done

- `shell.openPath` was **removed rather than validated.** Writing a path
  allow-list for a handler nothing calls would be validation code with no
  caller to justify it, and one more thing to get wrong.
- The **dialogs and event relays were left in place** (`openFiles`,
  `openDirectory`, `saveFile`, `getVersion`, `getUserDataPath`,
  `getBackendPort`, `onJobProgress`, `onJobComplete`, `onBackendReady`). All are
  unused, and main.js never emits the three events the listeners wait for — so
  a UI wired to `onJobProgress` would silently never fire. They are inert, so
  removing them is cleanup rather than security, and that is the owner's call.

### Two corrections to this review

- **§4.4 is withdrawn.** `verify.sh` does exit 1 on missing dependencies. I had
  read `$?` from the end of a pipeline. The error message now names the
  interpreter it tried, which is all that was actually wrong.
- During the CSP work, forcing `isDev = false` to reach the production path also
  switched backend discovery to the packaged layout, which failed to spawn — so
  the first CSP run loaded nothing and "no violations" was a **false pass.** The
  test was redone with the CSP forced on but discovery left alone, and only then
  produced positive evidence of rendering.

### Residual, carried forward

`plotly.js ^2.30.0` still pulls a critical `maplibre-gl` XSS advisory. It is not
reachable (no map traces) and the CSP now constrains what an injected script
could do, but the fix is the version bump in tranche 2/3 alongside Electron.


---

## 10. Tranche 2 — done (2026-11-02)

ESLint with `react-hooks`, `noUnusedLocals`, and CI on every push and PR.
Full suite passes (`exit 0`, `✓ All checks passed`), now with lint inside it.

```
eslint .            49 problems (7 errors, 42 warnings)  ->  0
tsc --noEmit        39 unused-local errors               ->  0
```

### The rule proves its worth immediately

Dropped the same two deliberate violations on it that defeated the old regex
check — an arrow-function component and a braceless early return:

```
6:15   error  React Hook "useState" is called conditionally ...  react-hooks/rules-of-hooks
12:15  error  React Hook "useState" is called conditionally ...  react-hooks/rules-of-hooks
✖ 2 problems
```

Both caught. The regex found one, and for the wrong reason (its body slice ran
past the end of the function into the next one). `verify.sh` now runs
`eslint . --max-warnings 0` in place of it.

**There were no actual rules-of-hooks violations in the tree** — that part of
the original finding was about the enforcement, not the state, and it held up.

### Latent staleness the deps rule found

These are behaviour fixes, not cosmetics. Each would have shown up as a plot or
a form that quietly did not update:

| Where | Was | Why it was wrong |
|---|---|---|
| `AnalysesTab`, `ContactsTab`, `PcaTab` | `[activeSession?.id, ready.length]` | **The count is a proxy for the set.** If one condition loses its paired replicas in the same refresh that another gains them, the length is identical and the effect never re-runs — leaving the selection naming a condition that can no longer be analysed. Now keyed on the ids. |
| `AnalysesTab:278` | `[incomingSelection, current?.type, groups.length]` | The body also reads `current.n_groups` and `current.default_groups`, which can change for the same `type` when the engine's analysis list is refetched. Now depends on `current`. |
| `LinePlot:222` | `[repIdx, sessionId, prefix, cacheKey]` | A refetched aggregate brings a new inline replica-1 matrix with it, and nothing in the deps changed — so the panel kept showing the previous one. |
| `LinePlot:135` | `const indices = r.replica_indices \|\| []` | The `\|\| []` builds a fresh array whenever the field is absent, so every memo depending on it recomputed on every render. Now memoised. |
| `CompareTab:206` | `[keys.join(',')]` | The effect guards on `metricA`, `metricB`, `filterMetric` and `targetMetric` and none were declared. Also replaced the stringified dep with `byKey` — `keys` *is* `Object.keys(byKey)`, so byKey determines it completely. |

### Where the warning was wrong, and the code was right

Four suppressions, each with its reason in the code. These matter as much as the
fixes: "fixing" them would have reintroduced bugs.

- **`StructureViewer:943`** depends on `baseTintKey`, a projection of `layers`
  holding exactly the fields that change base colouring (`id`, `color`, `sele`,
  in order, filtered to `visible && colorBase`). I checked every field of
  `StructureLayer` against what the effect reads: `opacity`, `rep`,
  `sideChainsOnly` and `name` are correctly excluded, and reordering two
  overlapping layers does change the key — which matters, because later layers
  win. Depending on `layers` would re-tessellate a molecular surface on every
  pixel of an opacity slider, which is the performance bug the projection
  exists to avoid.
- **`StructureViewer:745`** clears a `Map` of representation handles at
  teardown. Clearing whatever the ref holds *at teardown* is the intent; the
  rule's copy-the-ref-to-a-local advice is for DOM nodes.
- **`AnalysesTab:56`** restores a form draft once and marks itself done.
  Re-running would fight the save effect that writes the draft from the state
  this reads — a restore loop.
- **`MatrixDistributionPanel:76`** is keyed on the cache keys, not on `keys`.
  `results` is a prop array whose identity changes every parent render;
  depending on it would refetch every matrix distribution on each render.
  Content-keying is correct here and is not statically expressible.

The rest of the 42 resolved as either `useCallback` on helpers the memos
already read (`isExcluded`, `isHidden`, `repColour`, `baseSeries`, `labelOf`,
`seriesFor` — all behaviour-neutral, since each tracks state those memos
already listed) or declaring stable store actions.

### Dead code `noUnusedLocals` surfaced

39 items, including two worth naming:

- **`CompareTab` carried `densityBins`/`showDensity` state that nothing read.**
  The density feature lives entirely in `PcaPlot` with its own local `mode`.
  Two orphaned `useState` pairs removed from the file whose comments say hook
  count is what broke v33.
- **`PcaTab`'s `loadingFrames` was a duplicate flag** — set at exactly the same
  two points as `checking` and never read. Not a missing spinner, just a
  redundant one.

Also 12 unused `import React` (the `react-jsx` transform does not need them —
I checked each file for `React.` namespace use first), `PlaceholderTab` (every
tab is implemented and nothing rendered it), `navBtn`, and the
`setConditionId` adapter whose only caller I had already moved onto
`setStructureView`.

### CI

`verify` now runs on pushes to main/master and on every pull request. The
three-platform `build` matrix stays gated on tags and manual runs, so ordinary
commits do not spend minutes packaging artefacts nobody downloads.

### Verified at runtime, not just at build

Rewriting ~30 dependency arrays risks exactly one failure that neither `tsc`
nor `vite build` can see: an infinite render loop from a dep whose identity
changes every render on an effect that sets state. Launched the app and watched
for it:

```
render-loop markers        (none)
hard errors / React warns  (none)
console lines in last 8s   0  (quiet — settled)
```

### Config scope, and why it is narrow

`no-explicit-any` and `no-unused-vars` are off, with reasons in the file. There
are ~229 `any` uses and most are Plotly and NGL interop where no usable types
exist; banning it would mean 229 suppression comments, which is not type
safety. `noUnusedLocals` already does unused variables, in one place, with the
compiler's own scope analysis.

A lint run nobody reads is worse than none, because it hides the two findings
that matter. Add rules when one would have caught a bug that actually happened.

### Carried forward

- `LinePlot`'s `cacheRef` is keyed by cache key, so re-running an analysis
  under the same name can still serve the previous matrix for replicas 2+.
  Adding `r` to the deps fixed the replica-1 path; the cache needs an
  invalidation signal to fix the rest, which is its own change.
- `plotly.js` → `maplibre-gl` critical advisory, still waiting on the version
  bump in tranche 3.


---

## 11. Tranche 3 — done (2026-11-02)

`analysis_runner.py` split along the section comments that were already in it.
Full suite passes (`exit 0`, `✓ All checks passed`), 23 test modules.

```
before   analysis_runner.py   2152 lines, 12 endpoints

after    analysis_runner.py    650   orchestration + CRUD endpoints
         ndx_builder.py        582   selection text -> gmx index group, + diagnostics
         derived.py            623   endpoints that read cached results
         engine_process.py     205   running a blocking engine in its own process
         replica_agg.py        203   combining replicas; pure, no I/O
```

### Verified as a pure move, not asserted

The graph was mapped with an AST pass before anything moved, which showed a
clean DAG — `runner -> {ndx_builder, replica_agg, engine_process}`, `derived`
needing only `router`, `engine_process` only `log`. No cycles, so no import
gymnastics were needed.

Afterwards, every top-level definition was compared by the hash of its
normalised source (`ast.unparse`, so formatting does not count):

```
definitions before: 47   after: 47
  lost:    none
  new:     none
  changed: ['correlate_results']   <- 2 lines, deliberate; see below
  duplicated across files: none
```

Plus: `pyflakes` reports **no undefined names**; all 15 `/api/analysis` routes
still registered at the same paths; and each moved endpoint was called against
a running backend to confirm it reaches its own handler rather than a routing
error.

The one changed definition is `correlate_results`, where `state =
load_state(...)` became `load_state(...)` with a comment. It is called for its
side effect — `load_state` raises 404 for an unknown session, so that line *is*
the existence check — and it read as dead code that a linter flags and a future
reader would delete, silently turning a missing project into a confusing error
further down. The live check above confirms it still returns
`Session 'nope' not found`.

### No compatibility shim

Four test modules reached into `analysis_runner` for the moved helpers. The
first instinct was to re-export them, and that was wrong: a shim means two
places each name appears to live. They now import from the module that owns the
code, and `analysis_runner` imports only what it still uses.

Worth recording how the last one was found. A grep for `from ... import` missed
`import core.analysis_runner as AR`, so `test_row_baseline` failed on the first
full run — `module 'core.analysis_runner' has no attribute 'row_baseline'`. The
suite caught what the grep did not, which is the argument for running it rather
than reasoning about it. `test_loop_responsive` needed the same change in two
places, one of them inside a child script embedded in a string.

### The payoff: a real inconsistency, found by reading the extracted code

`replica_agg.py` is the numerical heart of a multi-replica analysis and had two
assertions in `test_parsers`. Making it testable was the stated reason for the
split, so `backend/tests/test_replica_agg.py` now covers it — 34 assertions,
each expected value arithmetic done by hand.

Writing it turned up something that matters:

> **The backend's error band and the frontend's are different statistics.**
>
> `_agg_replicas` uses `statistics.pstdev` — the POPULATION standard deviation,
> dividing by *n*. `recomputeMean` in `src/lib/stats.ts` divides by *n−1* — the
> SAMPLE standard deviation — with a comment arguing the case: *"these replicas
> are a sample of the runs that could have been done."*
>
> The Results tab plots the band the backend computed. The Compare tab
> recomputes it in the browser as soon as a replica is excluded. **So the same
> ten runs give two different error bands in two tabs** — 5% apart at n=10,
> 22% at n=3 — and neither chart says which convention it used.

The project's own stated reasoning favours the sample SD, so the backend is the
side that disagrees with the house position. **Not changed here:** switching it
alters every error bar in every figure already exported, which is a decision
about published results rather than a tidy-up. The test pins current behaviour
so the choice has to be made explicitly.

### Still to do in this area

`build_ndx_for_selections` (~240 lines) and `_make_run_coro` (~254 lines) are
each worth decomposing now that they are in smaller files. That is a behaviour
change, not a move, so it is separate work.

## 12. Tranche 4 — done (2026-11-02)

Storage and robustness: the three items from §6, plus two defects found while
building them.

### 12.1 Topology deduplication — 76 MB → 17 MB on the largest project

**The finding.** `engines/topology.py` caches the per-engine topology under a
key derived from `(tpr, xtc)` identity — path, mtime and size. That key is
right for the lookup: it is what makes re-running a simulation invalidate the
entry. It is badly wrong for the storage. Replicas of one system differ only by
velocity seed, so they are spawned from a single equilibrated structure, and
frame 0 is *byte-identical* across them. Measured on `19117eb2`:

```
9 files, 79.6 MB, 2 distinct contents   (5 x hash A, 4 x hash B)
```

**The fix.** The identity-keyed name stays as the lookup; the bytes move to
`topologies/by-content/<sha256>.pdb` and every name becomes a HARD LINK to it.
Readers are untouched — they open the same path they always did, and it is a
real file, not a symlink that can dangle. A `dedup_topologies()` pass collapses
caches built before the store existed, and is idempotent.

Three decisions worth recording:

- **Blobs are created by linking, not copying.** The bytes are already on the
  disk; copying them to make a blob would briefly double the very thing being
  reduced.
- **A content with only ONE copy still gets a blob.** It costs nothing (another
  link) and it is what makes the store authoritative: without it, the next
  replica to produce those bytes writes a second copy, because `_store` looks
  for a blob and finds none.
- **Blobs are read-only (0444) — except on Windows.** A hard link shares the
  inode, so anything truncating one name in place would corrupt every replica's
  topology; read-only turns that into a loud `EACCES`. On Windows 0o444 sets the
  read-only *attribute*, which makes `os.unlink` refuse, which would make
  `shutil.rmtree` fail halfway through deleting an archived project — so the
  freeze is skipped there. On POSIX, unlinking needs write permission on the
  directory, not the file, so deletion is unaffected. `test_topology_store.py`
  §5 pins this.

**Verified, not asserted.** Measured on a copy of the real files: 76 MB → 17 MB,
nine names collapsed onto two inodes, and `shasum` identical before and after.
Then end to end through the UI against a throwaway projects directory: the
panel read "83.1 MB … 61.9 MB reclaimable" before and "21.2 MB … Freed 61.9 MB"
after, with `du` confirming 79M → 20M and contents unchanged.

**Not run against the real projects.** The 61.9 MB is there whenever you want
it — the Reclaim button in the new Storage panel.

### 12.2 Disk use on the home screen

Nothing in the app ever said what a project cost. The real numbers:

```
TOTAL 32.17 GB across 13 projects

WT vs Y269C    14.26 GB   results 11.52  pca 2.29  cache 0.31  topo 0.08
VPS35_dimer    10.06 GB   results  5.97  pca 3.87  cache 0.21
Crystal VPS35   5.62 GB   results  4.20  pca 1.27  cache 0.15
TBC1D13 VPS35   2.02 GB   results  2.02
```

**Broken down, not totalled.** A single number says you have a problem without
saying what to do about it. The split is the actionable part — and it corrects
the premise this tranche started from: topology dedup recovers 62 MB, which is
0.2% of the 32 GB. The thing actually filling the disk is `results/` at 11.5 GB
on one project. A UI that led with "clear the cache" would be pointing at the
wrong 2%. Categories are marked `rebuildable` where they can be deleted and
recomputed, which is the fact that decides whether deleting is cheap or painful.

**Its own endpoint, not part of `/list`.** The walk is ~0.5 s for 32 GB warm and
longer cold. The project list must never wait on a disk walk, so `GET
/api/session/usage/projects` is fetched only when the panel is opened.

**Shared inodes are counted once**, so the totals agree with `du` and Finder —
and so the panel does not report back the space it just saved.

Two smaller things this turned up:

- `md-test` and `csv-test` exist in BOTH `projects/` and `archive/`. The id
  alone is therefore not a unique key; the panel keys rows on `archived + id`.
- The category colours are Okabe–Ito, not the theme tokens. `--accent-dim`
  (#1d4ed8) against `--accent` (#3b82f6) made "Structure snapshots" and
  "Analysis results" two indistinguishable blues in a 6px bar, and `--green-dim`
  (#065f46) is nearly invisible on the dark background.

### 12.3 Cancellation and timeouts in the API client

Two bugs with one cause — nothing in `src/api/client.ts` could cancel a request.

**Stale responses.** `openSession(A)` then `openSession(B)` left both in flight
and whichever answered LAST won, so a slow first project could paint its state
over the second: header naming B, tabs showing A. `pollJobs` had the same shape
— it fires on an interval, so when one poll outlasted the interval an older job
list could land after a newer one and a finished job would flip back to running.
`refreshSession` could resurrect a project the user had already closed.

Fixed with a `RequestSlot`: `begin()` aborts whatever it replaces, `current()`
says whether a reply still belongs to the newest request. Both are needed — the
abort saves the work, the check covers a response already decoded and queued
when the abort landed.

**Requests that never return.** `checkBackend` and `pollJobs` run on an
interval; one stuck request froze `backendOnline` at its last value and the job
list permanently stale, with no recovery but restarting the app.

**There is deliberately no default timeout.** Most endpoints here run GROMACS or
walk a trajectory, and `gmx trjconv` over a 4 µs trajectory legitimately takes
minutes. A blanket timeout would abort real work and report it as an error —
strictly worse than the hang it was meant to fix. The default is unbounded, as
before; `QUICK_MS` (15 s) is opted into only by health, info, the project list,
one project, and the job list, none of which touches a trajectory.

Aborts carry a **reason**. Without one every cancellation arrives as the same
bare `AbortError`, and a superseded request is indistinguishable from a backend
that stopped answering — the difference between staying silent and telling the
user their backend is down. A dead socket stays a `TypeError`, so "not running"
is never reported as "slow".

**Found while testing:** clicking a project could fail in complete silence. The
rejection went to the console as an unhandled promise and the card just sat
there — and a backend that has stopped answering is exactly when that happens.
`HomeScreen` now surfaces it.

### 12.4 Environment note

`fastapi`, `uvicorn` and `pydantic` were missing from every interpreter on this
machine at the start of this tranche, so `verify.sh` bailed (correctly, with
exit 1 — the behaviour mis-measured and then corrected in §4.4). Reinstalled
from `backend/requirements.txt`, which pulled **FastAPI 0.162 / Starlette 1.10 /
pydantic 2.14** — considerably newer than the `>=0.111` floor the project was
written against. Everything passes, but this is a bigger version jump than a
routine reinstall and worth knowing about.

### Still open

Unchanged from §11: the population-vs-sample SD divergence between
`_agg_replicas` and `recomputeMean` is a decision about published figures, not a
tidy-up. The Electron 30 (EOL) and `plotly.js` / `maplibre-gl` XSS upgrades
still need a packaged build tested on your machines.

## 13. The SD convention — resolved (2026-11-03)

**Decision: sample SD (n-1) everywhere.** Replicas are a sample of the runs that
could have been done, not the whole population of them.

**It was one line.** `replica_agg.py` used `statistics.pstdev`. Everything else
in the codebase already divided by n-1 — `stats.ts` (`summarise`,
`recomputeMean`), `plotFilter.ts`, `derived.py`'s matrix-distribution `sd`, and
`helix.py`'s rolling SD. So this was not "backend vs frontend"; it was a single
function disagreeing with the rest of the project, including the rest of the
backend. (`correlate.py`'s bare `.std()` is a Pearson denominator where the
divisor cancels in the ratio, and is correctly left alone.)

**Consequence for published figures.** Error bars exported before 2026-11-03
used the narrower population band. Remade now they are wider by
`sqrt(n/(n-1))`: **5.4% at n=10, 11.8% at n=5, 22.5% at n=3.** Anything already
in a manuscript needs re-exporting for the numbers to match the app.

**How it is kept consistent.** Asserting in two places that each side "uses
n-1" would not catch a divergence in truncation, rounding or NaN handling. So
`backend/tests/test_band_consistency.py` runs *both* implementations — the
Python `_agg_replicas` and the real TypeScript `recomputeMean`, via esbuild and
node — on identical input and diffs the numbers, across seven cases including
ragged replica lengths, n=1, n=2 and non-round values. Reverting the one line
makes it fail 9 assertions, so it is a real guard rather than a tautology.

### Found here, not fixed: NaN handling still diverges

`recomputeMean` filters non-finite values per time point and averages what
remains. `_agg_replicas` does not — `statistics.stdev` raises `AttributeError`
on a NaN column, and `statistics.mean` returns NaN, which `json.dumps` emits as
bare `NaN` that the browser's `JSON.parse` rejects outright.

This is reachable: `engines/mdanalysis.py` writes `float("nan")` into series
(hydration with no water group; helix channels). It is pre-existing and
unchanged by this edit — `pstdev` raised on NaN identically.

Not fixed here because the sensible repair widens `y_mean` to
`(number | null)[]`, and null then has to be handled in LinePlot's band maths
(`null + 0` silently becomes `0`, drawing a band at zero), CSV export, and
anything else consuming the field. That is its own change with its own
decisions, not a rider on a one-line convention fix.

## 14. Plotly — partial bundle instead of an upgrade (2026-11-03)

**The advisory was in code the app never runs.** `maplibre-gl` 4.7.1 carries a
critical XSS (sanitizer bypass in `DOM.sanitize()`), reachable only through a
map trace. There is not one map trace in this codebase. The full plotly.js
distribution shipped it anyway.

So rather than move plotly across two major versions (2.35.3 → 4.2.0) to carry
a patched maplibre, `src/components/plots/Plot.ts` now builds a partial bundle
from `plotly.js/lib/core` plus the six trace types the app actually draws —
scatter, scattergl, bar, histogram, histogram2dcontour, heatmap — and hands it
to `createPlotlyComponent`. All nine `import Plot from 'react-plotly.js'` sites
now import that instead. No API change, no version bump.

```
index chunk   6.30 MB  ->  3.07 MB      (-51%)
maplibre in dist/assets/*.js:  0 hits
```

**`npm audit` will still flag it.** Audit reads the dependency graph, not the
build output: maplibre remains a transitive dep of plotly.js in node_modules.
What changed is that it is no longer in the shipped artifact — verified by grep
on `dist/`. There is no patched 4.x (4.7.1 is the latest 4), so clearing the
audit line would mean the plotly major upgrade, which now buys nothing.

**Verified, not assumed.** In a real Electron window: all six types register and
draw (scattergl on a canvas, histogram2dcontour as 11 contour paths), and both
export formats work — `toImage` returns `data:image/svg+xml` for SVG, the app's
default, and `data:image/png` for PNG. End to end through the app on a copy of
a real project, three plots drew two traces each and the modebar camera
produced a valid 2478x1320 PNG.

**The failure mode is silent, so there is a guard.** An unregistered trace type
does not raise: Plotly falls back to the default `scatter` module and draws
nothing. Confirmed with `scattermapbox`, which came back as
`resolvedType: 'scatter'`, zero nodes, no error. A new plot using an
unregistered type would therefore render an empty chart with nothing in the
console. `scripts/check_plotly_traces.py` (in verify.sh) cross-references every
`type: '...'` in src against the registrations, using the presence of
`node_modules/plotly.js/lib/<name>.js` to decide what counts as a trace type —
which is also what stops it mistaking the `type: 'line'` and `type: 'rect'` of
`layout.shapes` for traces. Deleting the heatmap registration makes it fail
with the fix spelled out.

## 15. Does this actually run on Windows and Linux?

**Configured for all three. Never built for any but macOS.** The repository is
not a git repository — there is no `.git` — so `.github/workflows/build.yml`,
whose matrix is `[macos-latest, ubuntu-latest, windows-latest]`, has never run.
The Windows NSIS and Linux AppImage targets are configuration that has never
produced an artifact.

**Most of the cross-platform work is genuinely done.** `electron/main.js`
already resolves `gromax-backend.exe` against `gromax-backend` and `python`
against `python3`; `shutil.which("gmx")` finds `gmx.exe` via PATHEXT;
`files.py` and `chimerax.py` both branch three ways; nothing splits PATH on
`:`; no filenames collide under a case-insensitive filesystem; the PyInstaller
spec is onedir, which matches what `extraResources` copies and what main.js
looks for.

### Fixed here

- **`explorer /select,` was passed as two arguments**, which puts a space after
  the comma. Explorer parses `/select,<path>` as one token, so it would have
  ignored the path and opened the default folder. Now one argument.
- **The backend spawn had no `windowsHide`.** The frozen backend is built
  `console=True` so its output can be piped; a console subprocess spawned from
  a GUI process on Windows gets its own console window, which would sit behind
  the app for as long as it ran.

### Found, not fixed

- **The orphan watchdog does not work on Windows.** `engine_process.py` detects
  a dead backend with `os.getppid() != parent_pid`. That is a POSIX idiom: an
  orphan is reparented to init, so the parent pid changes. Windows does not
  reparent — the stored parent pid keeps pointing at the dead process — so the
  check never fires and a blocking engine would keep computing with nobody to
  return the answer to. The Windows equivalent is a Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, or waiting on a handle to the parent.
  Reasoned from the platform semantics, not observed — there is no Windows
  machine here.

**None of this is confirmed on real hardware.** Everything above is static
reading plus macOS testing. The honest summary is that Windows and Linux are
plausible but unproven: the first real test is running the CI matrix, which
needs the project to be in git and pushed.

## 16. Surface picking: the flicker, and seeing what you are about to select (2026-11-10)

### 16.1 The structure vanishing and reappearing on every click — fixed

**Cause.** The effect in `StructureViewer.tsx` that builds the base
representations listed `selected` and `peeked` among its dependencies. Both
change on a click, so every click tore down *every* base representation and
rebuilt it. With a molecular surface that means re-tessellating the mesh, which
takes long enough to watch.

The effect immediately below it already carried the comment explaining this
exact hazard — hovering a sequence "rebuilt the entire scene … made the
sequence view unusable" — and had been split into its own handle for that
reason. Clicking never got the same treatment.

**Fix.** `selected` and `peeked` were used *only* to add two additive overlay
representations; they touch neither base geometry nor base colour. Both now
live in their own effects with their own handles (`selectionRepRef`,
`peekRepsRef`), and the base effect's dependencies drop to
`[structureVersion, values, rep, filters, colorScheme, baseTintKey]`.

**Proved by object identity**, in a real WebGL window on the real project, by
tagging each entry of `comp.reprList` and re-reading the tags after a click:

```
before fix   before: surface(tag0) …      after: surface(None)   <- rebuilt
after fix    before: surface(tag4) …      after: surface(tag4)   <- untouched
```

Only the selection overlay churns now: the old `ball+stick` goes, a new one
arrives, and the surface underneath is never touched.

A dev-only `window.__gromaxViewer` was added to make this testable at all — a
3D scene is the one part of the app that cannot be inspected from the DOM. It
is stripped from production builds (verified: 0 occurrences in `dist/`), which
needed `src/vite-env.d.ts` so `import.meta.env.DEV` is typed properly and folds
to a constant instead of being hidden behind an `as any` cast.

### 16.2 No feedback at all when hovering a surface — fixed

NGL cannot pick a molecular surface (0 of 25 probes — see `surfacePick.ts`),
which is why clicks already fall back to a ray cast. **The hover path never
did.** `stage.signals.hovered` reads `pickingProxy?.atom`, which on a surface
is always null, so in surface mode there was no label and no marker: nothing
until you clicked and found out what you had got.

The same ray cast now drives hover, throttled to one cast per animation frame
and suppressed while a button is down (that is rotating, not aiming). A marker
shows what a click would take — one atom in atom mode, the whole residue
otherwise, because a marker that disagrees with the selection teaches the wrong
thing about where to aim.

### 16.3 Found while testing: a reference structure that is not a PDB

The **Y269C LRP** project renders "NGL parsed 0 atoms from this file". Its
reference structure is

```
.../lrp/y269c/gromacs/step3_input.gro     "Generated by CHARMM-GUI", 112096 atoms
```

a GRO file, which the viewer hands to NGL as `{ ext: 'pdb' }`. A GRO has no
ATOM/HETATM records, so nothing parses. NGL ships a `GroParser`, so the viewer
side is a matter of choosing `ext` from the source filename; whether `/info`'s
chain parsing and the snapshot path also need to understand GRO is the part
that makes this more than a one-liner. Not fixed — it is a separate defect from
the picking work above.

## 17. Why surface selection felt imprecise — three causes, all measured (2026-11-10)

The complaint was "I can't tell which part of the surface I'm selecting". It
turned out to be three separate defects stacked on top of each other, none of
which was about the picking maths.

### 17.1 Every surface click selected a water molecule

`atomAtCanvasPoint` takes the atom nearest the ray's hit point, searching the
structure's **entire** spatial hash — every water, ion and hydrogen in a
solvated box, none of which is drawn and none of which contributes a triangle
to the surface.

That is not an edge case, it is the normal outcome. A solvent-excluded surface
sits *between* the protein atoms and the first hydration shell, so a water is
very often the nearest thing to a point on it. Measured on the real WT vs Y269C
system with "show water" OFF:

```
click          nearest atom (old)        nearest VISIBLE atom (new)
centre grid    TIP3 6947.H1   0.58 A     ASP285.OD1   2.53 A
               TIP3 335.H1    0.30 A     GLU196.OE1   2.02 A
               TIP3 8898.H1   1.25 A     SER118.CB    2.30 A
               TYR197.HE2     1.66 A     TYR197.CE2   2.37 A
               TYR186.HH      1.46 A     TYR186.OH    2.08 A
```

Every single unfiltered pick was a water or a hydrogen — invisible atoms. The
last two rows are the nicest demonstration: the ray lands on a tyrosine, the
old code took its *hydrogen*, the new code takes the heavy atom of the same
residue. The filtered distances cluster at 2.0–2.5 A, exactly the solvent-
excluded surface offset the module's own docstring documents.

`displayFilterTest()` is the per-atom form of `applyDisplayFilters` — needed
because the ray cast must reject a hidden atom *before* choosing, not filter a
list afterwards: the nearest atom has already won by then.

### 17.2 "Hide ions" hid nothing, and the ions were in the way

NGL's `ion` keyword matches PDB-style names (NA, CL, K). CHARMM-GUI writes
**SOD, POT, CLA**, which match nothing — so with ions switched off the surface
still contained them, each rendered as its own free-floating blob. The protein
was behind several hundred of them (see the before/after screenshots): that
alone made it hard to see what was being selected, and the blobs were pickable.

```
surface atoms, ions "hidden":   3422  ->  3221      (201 ion atoms removed)
```

3221 heavy atoms for 403 residues is right; 3422 was not.

The name list is applied two ways, and the NGL selection string deliberately
uses **alphanumeric names only**. `[Na+]` does not parse, and an unparseable
NGL selection does not throw — it matches every atom. A mistake here would not
have failed to hide the ions, it would have hidden the protein. Names carrying
a charge stay in `isExtraIon()`, which is plain JavaScript.

### 17.3 The selection was invisible under an opaque surface

The selection overlay is a ball+stick drawn at the selected atoms — inside the
mesh, hidden completely. The surface itself is now painted at those atoms.

Doing that without re-tessellating took three attempts, and the first two are
worth recording because both look correct:

```
update({ color: true })    the documented colour-only refresh.
                           Colour buffer came back byte-identical.
setColor(sameSchemeId)     NGL diffs representation parameters, sees the same
                           id, does nothing.
setColor(freshSchemeId)    works.
```

A built-in scheme name *did* move the buffer (switching to `element` changed
its checksum), which is what showed the problem was the unchanged id rather
than the surface being unpaintable. So each selection change registers a fresh
colormaker — identical logic, new identity — reading the tint map live out of a
ref, and the old scheme is removed afterwards so the registry does not grow.

Verified on the real surface, 271840 vertices:

```
colour buffer    558706.81  ->  558837.31     repainted
position buffer  43115688.68 -> 43115688.68   geometry untouched
representation   tag0 -> tag0                 same object, not rebuilt
```

### 17.4 Hover feedback

NGL cannot pick a surface, which is why clicks ray cast. `stage.signals.hovered`
reads `pickingProxy?.atom`, always null on a surface, so hovering gave nothing
at all. The same ray cast now drives hover, throttled to one cast per animation
frame and suppressed while a button is down, with a marker covering exactly
what a click would take — one atom in atom mode, the whole residue otherwise.

### Still open

- `CLA`/`POT` are now hidden, but NGL also does not recognise them as ions for
  *colouring* or for the `hetero` test. Only the display filter is fixed.
- The viewer's own badge still reads "111,968 atoms · 35,703 residues" — the
  whole file, not what is drawn. With water and ions hidden the drawn figure is
  3221 atoms, and the two numbers sitting next to a surface you cannot click
  through is part of why the tab feels imprecise.

---

## 18. The part of the surface that could be seen but not clicked

Two complaints, two unrelated causes. Both reproduced and measured on the real
WT vs Y269C system before anything was changed.

### 18a. 20% of the surface was unclickable

The surface was already correct and the painting was already correct. They
disagreed about one thing: **which atom owns a given piece of surface.**

NGL colours a surface vertex by the atom that *generated* it —
`Surface.atomindex`, one entry per vertex. `atomAtCanvasPoint` instead took the
nearest atom *centre* to the hit point. Those are not the same question. A
solvent-excluded surface has re-entrant patches swept by the probe rolling
*between* atoms, which bulge away from their owner, and an atom in a crevice
can own a small island of surface poking out between two larger neighbours. On
such an island the nearest centre is a neighbour.

Measured over the real surface (118,684 vertices, 1,903 owning atoms; 476 atoms
sampled deterministically, all of their vertices checked):

```
vertices where owner != nearest atom          31.1 %
atoms that were NEVER the nearest atom at
  any vertex they own  (= unclickable)      96 / 476   (20.2 %)
```

Those 96 atoms could be seen — they had their own colour on screen — and could
not be selected from anywhere on their own patch. That is the island of purple
surrounded by yellow, exactly as reported.

The fix reads the triangle's own atom: raycast as before, then take
`Surface.atomindex` at the vertex of the hit triangle nearest the hit point.
What you click is by construction what is drawn there, so the two can no longer
disagree.

End-to-end A/B, projecting a previously-unclickable atom's own vertex back to a
canvas pixel and clicking it through the real pick path (24 pixels where the ray
landed within 0.5 Å of the vertex aimed at):

```
                               returns the atom that colours the pixel
new rule (triangle's atom)                  23 / 24
old rule (nearest centre)                    0 / 24
old rule picked a DIFFERENT RESIDUE         16 / 24
```

The wrong-residue count is the part that matters beyond cosmetics: this was not
only a single-atom-mode problem. `ARG34.CZ`'s patch resolved to `ARG11.NH2` —
twenty-three residues away — so clicking it in *residue* mode selected the wrong
residue, with no sign that anything was off.

The one miss is honest: a pixel coloured by `LEU150.C` returned `LYS149.O`. The
hit lay on a triangle spanning two patches and the nearest vertex belonged to the
neighbour. At a patch seam the rendered colour is interpolated between the two
anyway, so there is a one-vertex ambiguity there that no rule removes.

**This rests on NGL internals** (`repr.__infoList[].surface.atomindex`), so the
contract is pinned in `electron/surfacepick-test/`: per-vertex indices exist
where the app looks, there is one per vertex, the rendered mesh has that vertex
count, every index names a real atom, and every surface hit went through that
route rather than the fallback. Stubbing `surfaceAtomIndex` to return `null`
fails two of those checks. Without that guard an NGL upgrade would drop the app
back to nearest-atom silently and this would return with nothing failing.

The nearest-atom search is kept as a fallback for geometry with no per-vertex
atoms (a volume isosurface), and it keeps the visibility filter from §17. The
surface path deliberately does *not* apply that filter: an atom that contributed
a triangle in front of the camera is drawn by definition, and filtering there
would reject the very atoms a surface exists to show.

### 18b. "It only lets me select whole residues"

Not the viewer. The picks *were* atom-level — the chips read `CYS 269 · A · SG`
— but the make_ndx expression came out as `ri 163 202 203 ...` with a warning
that the group "mixes different atoms per residue", and `ok: false` left **Use
in analysis** greyed out. So the selection could be made and not used, which
reads from the outside as the app refusing atoms.

The warning was true about one *line* of make_ndx and false about make_ndx.
There are no parentheses and no precedence, so `ri 1 & a CA | ri 2 & a OD1`
re-intersects everything to its left. But a selection split at `;` becomes one
group per part in a single make_ndx session, joined afterwards by group number,
and OR over group numbers is associative. `ndx_builder.split_selection_parts`
has done exactly that for some time — including a check of the joined group
against its parts atom-for-atom — and `resolve_picks` simply never used it.

The eighteen atoms from the report now resolve to:

```
ri 163 & a CE1;  ri 202 & a CB NE NH2;  ri 203 & a CE;
ri 206 & a CE3 CG O;  ri 211 & a CG;  ri 234 264 & a CB;
ri 266 & a O;  ri 269 & a CB SG;  ri 270 & a CA N O;  ri 402 & a N
                                          ok: true,  problems: []
```

Residues that ask for the same atoms share a part, so the ordinary all-CA case
is still the single line it always was. A residue picked both whole and by an
atom is taken whole — the whole residue is the superset, and intersecting it
with the atom name would drop atoms already asked for.

Against a real gmx 2024.2, `ri 2 & a CA O; ri 5 & a N; ri 9 & a C` builds to
atoms `[6, 8, 17, 35]` — exactly the four picked. The widened form `ri 2 5 9`
builds to twelve. Widening is not a blunter version of the same measurement: a
side-chain-tip contact and a whole-residue contact are different quantities.

The mutation notes are unchanged and still correct: `A:269` is CYS in the
reference and TYR in the simulated system, so a group naming `SG` is valid in
one condition only. The ndx builder refuses at build time if a named atom
matches nothing in its own part, rather than quietly returning a smaller group.

---

## 19. Ordering the snapshot list

Snapshots accumulate in the order moments were pulled out of plots — the order
of a train of thought, not of anything in the data. With 103 of them in one
wrapped row the same replica's moments were scattered through the list, the two
conditions were interleaved, and finding "the other one I looked at in rep 6"
meant reading every chip. The panel was also 600 px tall, which pushed the
viewer off the bottom of the window; that is why the structure sat below the
fold in every screenshot taken while debugging §17 and §18.

Grouped by condition, then replica, then time. The row states the condition and
replica, so a chip only carries its time, and the unit is written once per row
instead of once per chip. Measured on the real project (103 snapshots, 37 WT /
66 Y269C):

```
panel height     ~600 px  ->  243 px   (bounded; it scrolls past that)
canvas top          >871  ->  541 px   in an 871 px viewport
```

Conditions follow the **project's** order, not alphabetical — WT before its
mutant because that is how the project was set up, not because "W" sorts after
"Y". The same grouping is applied to the viewer's "Morph to" picker, which had
the same 103 entries in the same flat pile; it now uses `<optgroup>` per
condition. `conditionOrder` is passed down so the two lists cannot disagree,
which they did on the first attempt: the panel put WT first and the dropdown
put Y269C first, because the viewer was falling back to first-seen order.

`groupSnapshots` does not touch the stored array — that order is what a session
saves and what every id refers to — and a snapshot whose condition has since
been removed from the project still appears, after the known conditions, rather
than vanishing from the list. Both are tested, along with the tie-break on id
that stops two snapshots at the same time swapping places between renders.

### Noticed while verifying, not fixed

Ordering the list made one entry obvious that was invisible in the pile: **WT
rep 8 holds a snapshot at `-1.00 ns`**, now sorted to the front of its row. Its
label is a concatenation of seven trace names, so it came from a click on a
multi-trace plot that resolved to no time at all. There is no frame at -1 ns, so
it cannot open. One of 103, and chasing it means working back through the plot
click path, so it is reported rather than fixed — it can be deleted with its own
`×`.

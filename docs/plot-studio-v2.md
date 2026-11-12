# Plot Studio v2 — multiple filtered series, and Prism-style per-series control

**This is an implementation brief, written to be read before the work starts.**
It is the "prompt" for the build. It records what the code does *today*
(measured, not remembered), the data model to add, the order to build it in,
and the two places where a careless implementation would produce numbers that
are quietly wrong.

---

## 1. What was asked for

Three things, in the user's words:

1. *"plot several filtered plots on the same graph"*
2. *"save a filtered state and add other filtered states to it and then plot it
   by condition or filtered state"*
3. *"change the color of the dots on the bar graphs for each condition
   manually"* — with the flexibility of **GraphPad Prism**'s graph formatting.

Prism is the right reference, and it is worth being precise about which parts
of it are being asked for, because Prism's "Format Graph" dialog is four
different features in one window:

| Prism tab | What it does | Wanted here? |
|---|---|---|
| **Data Sets on Graph** | Which datasets appear on this graph, their order, and *adding datasets from other tables* | **Yes — this is (1) and (2)** |
| **Appearance** | Pick ONE dataset from a dropdown, then set its symbol/colour/size/border, bar fill, error-bar style independently of the others | **Yes — this is (3)** |
| Axes & Scaling | ranges, ticks, breaks | Mostly exists already |
| Titles & Fonts | labels, fonts | Exists already |

The single structural idea behind Prism's flexibility is this:

> **A graph is a list of *series*. Styling is a property of a series, not of the
> graph.**

This app currently has no series concept at all. Everything is styled globally.
That is the gap, and it is why (3) is impossible today rather than merely
fiddly.

---

## 2. Where the code actually is

Measured on the current tree, not recalled.

### The style object is global

`src/components/PlotStyleControls.tsx` defines one `PlotStyle` with ~30 flat
fields (`markerSymbol`, `markerSize`, `barOpacity`, `barFillLighten`,
`markerBorderColor`, …). One object for the whole figure. There is no way to
express "WT's dots are navy, Y269C's are orange".

### The dots on bar charts are all one colour, by construction

Both bar-chart dot traces hard-code a theme colour:

```
src/components/CompareTab.tsx:726   marker: markerStyle(style, plotTheme().title, style.markerSize + 1)
src/components/CompareTab.tsx:802   marker: markerStyle(style, plotTheme().title, style.markerSize + 1)
```

`plotTheme().title` is a single foreground colour. So every replica dot on
every bar is the same colour whatever condition it came from. This is the exact
complaint in (3), and it is a two-line symptom of the missing series concept.

Other marker sites *do* take a colour (`CompareTab.tsx:308, 330, 694` pass a
per-condition `colour`), so the inconsistency is already visible in the file.

### Filtered analysis is a single, unnamed, unsaved state

`CompareTab.tsx:130-137` holds the whole filter as six `useState`s:

```ts
filterMetric, filterOp, filterThreshold, filterOutput, targetMetric, filterBarStyle
```

There is exactly **one** of each. There is no identity, no name, no list, and
nothing is persisted — `restoreStructureState` in `src/store/index.ts` restores
`structureSelection`, `structureLayers`, `structureView`, `structureFrames`,
`selectionGroups` and `analysisDraft`, and **nothing from the Compare tab**.
Every filter is retyped from scratch on each visit.

### Where things are persisted today (keep this split)

| What | Where | Why |
|---|---|---|
| Figure style presets | **app config** (`/api/config/presets`) | A look is reusable across projects |
| Structure picks, layers, analysis draft | **project workspace** (opaque dict in `state.json`) | They name residues and metrics of *this* system |

A saved filter names a metric like `ncontacts_06_cutoff_205-267_377-387`. That
string is meaningless in another project. **Filters go in the project
workspace; styles stay in app presets.** Do not blur this.

### Constraints this file already carries

- `CompareTab.tsx` is **1405 lines** and its own comments record that hook
  count is what broke a previous release ("All figure styling lives in ONE
  object rather than a dozen useStates … hook-count is what broke v33", and a
  separate rules-of-hooks hazard noted around early returns). **Do not add
  state to this component.** New state goes in an extracted module.
- `tracesByMode` is an exhaustive `Record<Mode, any[]>` so that a new mode is a
  compile error if unhandled. Keep that property.
- `verify.sh` has a "Hook-order safety" step and a "Prop destructuring" step.
  Both will police this work; run it.

---

## 3. The data model

Three new types. Put them in a new `src/lib/plotSeries.ts` — **pure, no React**,
so they can be unit-tested the way `rowNormalise.ts` is.

```ts
/** A saved filter. Belongs to the PROJECT (it names this project's metrics). */
export interface FilterDef {
  id: string                     // stable, generated once, never derived from the name
  name: string                   // user-facing, editable: "contact < 4 Å"
  metric: string                 // metric key the threshold is applied to
  op: '>' | '<' | '>=' | '<='
  threshold: number
  output: 'fraction' | 'conditional_mean'
  targetMetric?: string          // only for conditional_mean
}

/** One drawable thing on the graph: a filter evaluated for one condition. */
export interface PlotSeries {
  id: string                     // `${filterId}|${conditionId}` — stable and reconstructible
  filterId: string
  conditionId: string
  label: string                  // defaults to "<filter> · <condition>", editable
  visible: boolean
  order: number
  style: SeriesStyle             // sparse overrides; absent means "inherit"
}

/**
 * Per-series overrides. Every field optional: absent means "use the global
 * PlotStyle". Only the fields that genuinely vary per series belong here —
 * fonts, axis ranges and backgrounds are properties of the FIGURE and must
 * stay global, exactly as Prism keeps them on a different tab.
 */
export interface SeriesStyle {
  colour?: string                // bar fill / line colour
  dotColour?: string             // the dots, INDEPENDENT of the bar — this is request (3)
  markerSymbol?: string
  markerSize?: number
  markerOpacity?: number
  markerBorderColor?: string
  markerBorderWidth?: number
  barFillLighten?: number
  barOpacity?: number
  barBorderColor?: string
  barBorderWidth?: number
  lineDash?: PlotStyle['lineDash']
  lineWidth?: number
  hidden?: boolean               // drawn but excluded; distinct from visible=false
}
```

### One resolver, used by every trace builder

This is the part most likely to rot. There must be exactly **one** function
that turns (series, global style, condition) into concrete Plotly styling, and
every trace must go through it:

```ts
export function resolveSeriesStyle(
  series: PlotSeries | null,
  global: PlotStyle,
  conditionColour: string,
): ResolvedStyle
```

**Precedence, fixed and documented:**

```
series.style.X  →  global.X  →  conditionColour (for colours only)  →  palette fallback
```

with one special case worth stating in the code: **`dotColour` falls back to
the series colour, not to the theme foreground.** That single default change is
what fixes request (3) even before any UI exists, and it is a better default
than today's behaviour regardless.

Why insist on one resolver: this codebase has already been bitten twice by two
sites disagreeing about the same visual property (the heatmap colour range
reading per-matrix stats in one place and pooled stats in another, and the
`fallbackStats` bug where a normalised matrix would have rescaled its
neighbours). A single resolver makes that class of bug impossible rather than
unlikely.

---

## 4. UI

Mirror Prism's two tabs, inside the existing "Customise plot" disclosure.

### 4a. "Data on graph" panel — new, `src/components/plots/SeriesPanel.tsx`

- **Saved filters** list: name, the filter expressed in words
  (`fraction of frames where mindist < 4 Å`), edit / duplicate / delete.
- **"Add to graph"** puts that filter on the plot for every selected condition,
  creating one `PlotSeries` per condition.
- The series list below: drag to reorder, checkbox to show/hide, inline label
  edit, and a colour swatch. Order controls draw order *and* legend order.
- **Group by**: `condition` | `filter`. This transposes the chart:
  - *by condition* — x-axis is WT / Y269C, colour distinguishes filters
  - *by filter* — x-axis is the filters, colour distinguishes conditions

  Both are one line of restructuring on the same series list; neither is a
  different computation.

### 4b. Per-series appearance — extend `PlotStyleControls.tsx`

Add a **series selector** at the top of the marker/bar sections, exactly as
Prism does: a dropdown listing the series, plus "All series". Editing with a
series selected writes to `series.style`; editing with "All series" selected
writes to the global `PlotStyle` **and clears that field's per-series
overrides**, so "set everything to circles" actually works. Show an "overridden"
dot next to any control that differs from the global value, with a one-click
reset — otherwise per-series overrides become invisible state that people
cannot find later.

### 4c. Colour schemes

Prism's "Change ▸ Colour scheme" applies a palette across datasets in one
action. Add a small palette row (the existing `REPEAT_PALETTE`, plus
colour-blind-safe Okabe–Ito) that assigns colours across the visible series in
order. This is the fastest path to a publication-ready figure and costs almost
nothing once series exist.

---

## 5. The statistics trap — read this before touching StatsPanel

With several filters × several conditions there are two different comparisons
on the same chart, and **they need different tests**:

| Comparison | Example | Independence | Correct test |
|---|---|---|---|
| Across **conditions**, one filter | WT vs Y269C, same filter | independent samples | Welch (current `compareGroups`) |
| Across **filters**, one condition | filter A vs filter B, same runs | **paired** — the same replicas | **paired** t / Wilcoxon signed-rank |

`src/lib/stats.ts`'s `compareGroups` is unpaired only. Feeding it two filters
measured on the same ten replicas treats ten paired observations as twenty
independent ones: the p-value will be too small, and *the error gets worse the
stronger the pairing is* — the opposite of conservative.

**Requirement:** the stats panel must decide which case it is from the series
definitions (same `conditionId`, different `filterId` ⇒ paired) and either use a
paired test or refuse and say why. Do not let it silently run Welch. Add
`pairedT` / `wilcoxonSignedRank` to `stats.ts` with reference values generated
from scipy, the same way the existing tests were validated.

A second, smaller trap: with *k* filters × *m* conditions the number of
pairwise comparisons grows fast. The existing Holm–Bonferroni adjustment must
be applied across the comparisons actually shown, and the panel should say how
many were adjusted for.

---

## 6. Risks specific to this codebase

1. **Hook count in `CompareTab.tsx`.** Already flagged in its own comments as
   the cause of a shipped breakage. Put new state in `useSeriesModel()` (one
   hook) or in the store, never as a dozen new `useState`s.
2. **Replica exclusion.** `isExcluded(metric, conditionId, repIndex)` is applied
   inside the current filter computation. It must be applied per-series, and
   excluding a replica must affect *every* series that uses it, or two series
   on one chart will silently be built from different sets of runs.
3. **Metric compatibility.** A filter on metric X and a target metric Y must
   share frame sampling (same time window and stride). The existing code notes
   this. With several filters it becomes easy to combine incompatible ones —
   detect and refuse with the mismatch named, rather than silently truncating
   to the shorter one.
4. **Legend explosion.** 4 filters × 10 conditions is 40 series. The panel needs
   select-all/none and sensible defaults, and the legend needs grouping
   (`legendgroup` by filter or condition, following `groupBy`).
5. **Backwards compatibility.** A project workspace written by the current build
   has no `filters` key; a preset saved today has no per-series fields.
   `restoreStructureState` already defends every field separately — follow that
   pattern exactly.

---

## 7. Build order

Each step ends somewhere shippable and verifiable.

| # | Step | Verifiable by |
|---|---|---|
| 1 | `plotSeries.ts`: types + `resolveSeriesStyle` + precedence, no UI | new unit test, run via esbuild like `rowNormalise.test.ts` |
| 2 | Route **existing** traces through the resolver; change the `dotColour` default to the series colour | dots on bar charts become per-condition — request (3) done, zero new UI |
| 3 | Per-series override UI (series selector in `PlotStyleControls`) | manual, plus a test that an override wins over global and reset restores |
| 4 | `FilterDef` list + save/edit/delete, persisted in the project workspace | reopen the project, filters are still there |
| 5 | Multi-series plotting + `groupBy` toggle | a chart with 2 filters × 2 conditions, both groupings |
| 6 | Paired/unpaired statistics | `stats.ts` tests against scipy reference values |
| 7 | Colour schemes, legend grouping, select-all | manual |

Steps 1–2 are worth doing on their own: they fix the stated colour complaint
and build the foundation, without any new UI surface to get wrong.

---

## 8. Test plan

Follow the house style: **assert against something computed independently, not
against another run of the same code.**

- `resolveSeriesStyle` precedence: series override beats global beats condition
  colour beats palette; clearing an override restores the global value.
- `dotColour` defaults to the series colour, never to the theme foreground
  (this is the regression that request (3) is about — pin it).
- Filter evaluation: on a hand-built series where the pass fraction is known by
  counting (e.g. 3 of 10 frames above threshold ⇒ 0.3), for both `fraction` and
  `conditional_mean`.
- Excluding a replica changes every series that uses it, consistently.
- Paired vs unpaired selection: two series on the same condition ⇒ paired test;
  two conditions on the same filter ⇒ unpaired. Verify the paired p-value
  against scipy for a fixture where the two differ substantially.
- Incompatible metrics (different stride) are refused with both lengths named.
- A workspace with no `filters` key loads; a preset with no per-series fields
  loads.

---

## 9. Decisions to confirm before building

1. **Scope of per-series overrides.** The list in §3 is deliberately limited to
   marker/bar/line properties. Should error-bar style and the mean-line be
   per-series too? Prism allows it; it is more switches.
2. ~~**Do filters apply to modes other than the bar chart?**~~ **ANSWERED: yes.**
   A saved filter also gates the Overlay (time-series) view. This changed the
   data model for the better — see §10.
3. **Do series survive a metric being deleted or re-run?** A `FilterDef` holds a
   metric key. When that analysis is deleted the series should grey out with an
   explanation rather than vanishing silently. Assumed yes.
4. **Colour source of truth.** A per-series colour override diverges from the
   condition colour shown elsewhere (Structure tab, Results tab). Assumed
   acceptable and local to the figure — but it should be *visible* that an
   override is in effect, hence the "overridden" marker in §4b.

---

## 10. What gating a time series changed (decision on §9.2)

Allowing a saved filter to gate the Overlay view was approved, and it moved the
centre of the design. **A filter is now a frame mask, and everything else is a
reading of that mask** (`src/lib/plotFilter.ts`):

```
fraction          = mean(mask)
conditional mean  = mean(target[i] for i where mask[i])
gated time series = target[i] where mask[i], a GAP elsewhere
shaded overlay    = the intervals where mask is true
```

The original code computed a pass fraction straight from a threshold, which
made the fraction the only thing a filter could produce. The mask is the better
primitive, and the four readings now cannot disagree with each other.

### Four things this got right that a naive version would not

1. **Gaps, not deletion.** A failing frame becomes `null`. Dropping failing
   frames and re-plotting would connect the line across the gap and compress
   the time axis, so a 50 ns excursion where the filter failed would render as
   two adjacent frames.
2. **Frame alignment is refused, not fudged.** A mask is an array of indices;
   applying it to a metric on a different stride or time window reports a
   number for the wrong moments. `alignFrames` compares the mean sampling
   interval and the start time and refuses, naming both sides. It is the one
   error class a figure cannot reveal.
3. **The gated mean has a varying n.** In the ungated plot every point averages
   the same ten runs. Gated, a point might average nine runs or two, because
   the runs do not enter the state in step. `gatedMean` returns `n` per frame,
   breaks the line below two contributing runs, and the UI states the range.
4. **Debouncing.** Cavity volume is noise-dominated frame to frame (its lag-1
   autocorrelation is near zero), so thresholding it produces a mask that
   flickers every few frames and a gated series that is confetti. `minRun`
   drops passing runs shorter than N frames — a 1-D morphological opening.
   Defaults to 1, i.e. off, because what counts as an *event* is the user's
   call.

### Shading uses a majority rule, and says so

With `gateMode: 'shade'` the whole trace is drawn and the passing stretches are
shaded. There is no single stretch to shade — each run passes at different
times — so the band marks where **more than half** the runs of that condition
pass. Shading every run's own stretches would be a grey wash; shading only
where all pass would almost never fire. One rule, stated on screen rather than
left to be assumed to mean "all".

### Gating takes ONE filter, not a list

The bar chart takes a list of series; the Overlay takes a single `gateFilterId`.
Two masks over one line have no defined meaning — "which frames am I looking
at" has one answer, and intersecting or unioning two filters would give a
different quantity depending on an ordering nobody chose.

---

## 11. Build status

| # | Step | State |
|---|---|---|
| 1 | `plotSeries.ts`: types + resolver + precedence | done — 29 assertions |
| 2 | Existing traces through the resolver; `dotColour` default | done |
| 3 | Per-series override UI (series selector in `PlotStyleControls`) | done |
| 4 | `FilterDef` list, persisted in the project workspace | done |
| 5 | Multi-series plotting + `groupBy` | done |
| 6 | Paired/unpaired statistics | done — validated against scipy 1.15.2 |
| 7 | Colour schemes, legend grouping, select-all | done |
| — | Filters gate the time-series view (§9.2) | done — 40 assertions |

Tests added to `verify.sh`: "Saved filters as frame masks", "Paired statistics
(vs scipy)".

### Two implementation notes worth keeping

- **The statistics test is chosen from the series, not from a menu.** All
  visible series on one condition ⇒ paired; all on one filter ⇒ unpaired; a
  mixture ⇒ **refused** with the way out named, because a chart holding both
  contains paired and unpaired comparisons at once and a single Holm-adjusted
  family over that mixture corrects nothing. `StatsPanel` does not offer the
  unpaired tests on a paired design at all.
- **`midRanks` matches ties with a tolerance, not `===`.** `2.1 - 2.5` is
  `-0.3999999999999999` and `5.0 - 5.4` is `-0.40000000000000036`: the same
  measurement, differing in the last bit. Exact comparison calls them distinct,
  which changes the tie correction and so the p-value. scipy has the same
  problem — its reference value for the test fixture is computed on a tie
  structure that is an artefact of subtraction order, and the test documents
  why the reference used is scipy run on cleaned differences.

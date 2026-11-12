#!/usr/bin/env python3
"""
Every Plotly trace type the app draws must be registered in the partial bundle.

WHY THIS CHECK EXISTS
src/components/plots/Plot.ts ships only the trace types this app uses, which is
what keeps maplibre-gl (and its critical XSS advisory) out of the build. The
cost of that is a silent failure mode: Plotly does NOT throw on an unregistered
trace type. It falls back to the default `scatter` module and draws nothing —
verified, not assumed. So a new plot using, say, `violin` would render an empty
chart with no error anywhere, and the first person to notice would be whoever
was waiting for the figure.

HOW IT DECIDES WHAT IS A TRACE TYPE
`node_modules/plotly.js/lib/<name>.js` exists for exactly the trace modules, so
that directory is the authority rather than a list maintained here. It is also
what keeps the check free of false positives: `type: 'line'` and `type: 'rect'`
appear all over the codebase inside `layout.shapes`, and neither has a lib
entry, so neither is mistaken for a trace.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLOT_TS = ROOT / "src" / "components" / "plots" / "Plot.ts"
LIB = ROOT / "node_modules" / "plotly.js" / "lib"

if not LIB.is_dir():
    print("  (plotly.js not installed — skipping)")
    sys.exit(0)
if not PLOT_TS.is_file():
    print(f"  {PLOT_TS.relative_to(ROOT)} is missing")
    sys.exit(1)

trace_modules = {p.stem for p in LIB.glob("*.js")}

registered = set(re.findall(r"from 'plotly\.js/lib/([a-z0-9_]+)'",
                            PLOT_TS.read_text()))
registered.discard("core")

used: dict[str, list[str]] = {}
for f in sorted(ROOT.joinpath("src").rglob("*.ts*")):
    if f == PLOT_TS:
        continue
    for m in re.finditer(r"type:\s*'([a-z0-9_]+)'", f.read_text()):
        name = m.group(1)
        if name in trace_modules:
            used.setdefault(name, []).append(str(f.relative_to(ROOT)))

missing = sorted(set(used) - registered)
unused = sorted(registered - set(used))

for name in sorted(used):
    mark = "ok  " if name in registered else "FAIL"
    print(f"  {mark}  {name}")

if missing:
    print()
    for name in missing:
        where = ", ".join(sorted(set(used[name]))[:3])
        print(f"  '{name}' is drawn in {where} but is not registered.")
    print(f"\n  Add it to {PLOT_TS.relative_to(ROOT)}:")
    print(f"      import {missing[0]} from 'plotly.js/lib/{missing[0]}'")
    print(f"      ...and include it in the Plotly.register([...]) call.")
    print("  Plotly will NOT warn about this — the chart just comes out empty.")
    sys.exit(1)

if unused:
    # Not a failure: carrying one unused trace module is cheap, and removing it
    # is a judgement call about what the app is about to need.
    print(f"  note  registered but not currently drawn: {', '.join(unused)}")

print(f"  {len(used)} trace types, all registered")

"""CSV export: a multi-channel result, a plain one, and the refusals."""
import shutil, sys, tempfile, warnings, datetime as dt
from pathlib import Path
warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core.session as sm
SBOX = Path(tempfile.mkdtemp()); sm.SESSIONS_DIR = SBOX
from fastapi import HTTPException
from core.gmx import save_cached_result
from core.derived import export_result_csv, ExportCsvRequest

fails = 0
def check(n, ok, d=''):
    global fails
    ok = bool(ok)
    if not ok: fails += 1
    print(f"  {'ok  ' if ok else 'FAIL'}  {n}{('  — ' + str(d)) if str(d) else ''}")

SID = "csv-test"; (SBOX / SID / "cache").mkdir(parents=True, exist_ok=True)
now = dt.datetime.now().isoformat()
sm.save_state(sm.SessionState(id=SID, name="csv", created_at=now, updated_at=now))

save_cached_result(SID, "helix", {
    "kind": "line", "x": [0.0, 0.1, 0.2], "y": [1.0, 2.0, 3.0],
    "xlabel": "Time (ns)", "ylabel": "Piston (A)", "title": "Helix A piston",
    "analysis_name": "helix A/B", "helix_meta": {
        "fit_selection": "name CA and protein", "axis_method": "smoothed",
        "ref_frame": 0, "ref_time_ns": 0.0, "units": "angstrom and degrees"},
    "channels": [
        {"key": "piston_A", "label": "Piston", "unit": "A", "y": [1.0, 2.0, 3.0]},
        {"key": "tilt_deg", "label": "Tilt", "unit": "deg", "y": [0.0, 5.0, None]}],
    "replicas": [
        {"index": 1, "x": [0.0, 0.1, 0.2], "channels": [
            {"key": "piston_A", "label": "Piston", "unit": "A", "y": [9.0, 8.0, 7.0]}]},
        {"index": 2, "x": [0.0, 0.1], "channels": [
            {"key": "piston_A", "label": "Piston", "unit": "A", "y": [1.5, 1.6]}]}],
})
save_cached_result(SID, "plain", {
    "kind": "line", "x": [0.0, 0.1], "y": [4.0, 5.0], "y_sd": [0.1, 0.2],
    "xlabel": "Time (ns)", "ylabel": "RMSD (nm)", "title": "RMSD",
    "analysis_name": "rmsd core"})
save_cached_result(SID, "matrix", {"kind": "heatmap", "z": [[1]], "x": [1], "y": [1]})

print("1. a multi-channel result")
r = export_result_csv(ExportCsvRequest(session_id=SID, cache_key="helix"))
rows = r["csv"].splitlines()
check("filename is derived from the analysis name", r["filename"] == "helix_A_B.csv",
      r["filename"])
check("units are recorded in the header comments",
      any("angstrom and degrees" in l for l in rows if l.startswith("#")))
check("the fit selection is recorded too",
      any("name CA and protein" in l for l in rows))
hdr = [l for l in rows if not l.startswith("#")][0]
check("every column header names its unit", hdr == "Time (ns),Piston (A),Tilt (deg)", hdr)
check("one row per frame", r["n_rows"] == 3, r["n_rows"])
check("a missing value is blank, not zero",
      [l for l in rows if not l.startswith("#")][-1] == "0.2,3.0,",
      [l for l in rows if not l.startswith("#")][-1])

print("\n2. per replica")
r1 = export_result_csv(ExportCsvRequest(session_id=SID, cache_key="helix", replica=1))
check("replica 1 exports its OWN series, not the aggregate",
      "9.0" in r1["csv"] and r1["filename"].endswith("_rep1.csv"), r1["filename"])
r2 = export_result_csv(ExportCsvRequest(session_id=SID, cache_key="helix", replica=2))
check("a shorter replica exports its own length", r2["n_rows"] == 2, r2["n_rows"])

print("\n3. a plain single-series result")
rp = export_result_csv(ExportCsvRequest(session_id=SID, cache_key="plain"))
h = rp["csv"].splitlines()[0]
check("exports value and SD", h == "Time (ns),RMSD (nm),RMSD (nm) SD", h)
rp1 = export_result_csv(ExportCsvRequest(session_id=SID, cache_key="plain", replica=None))
check("  with units carried from the axis labels", "(nm)" in rp1["csv"])

print("\n4. refusals")
for kw, expect, code in [
    (dict(cache_key="nope"), "no longer cached", 404),
    (dict(cache_key="matrix"), "time-series", 400),
    (dict(cache_key="helix", replica=99), "not in this result", 404),
]:
    try:
        export_result_csv(ExportCsvRequest(session_id=SID, **kw))
        check(f"{kw} refused", False, "ACCEPTED")
    except HTTPException as e:
        check(f"{kw} refused", expect in e.detail and e.status_code == code,
              f"{e.status_code}: {e.detail[:48]}")

shutil.rmtree(SBOX, ignore_errors=True)
print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

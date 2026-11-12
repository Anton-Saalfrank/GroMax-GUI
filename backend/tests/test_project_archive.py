"""
Archiving a project must be reversible, and deleting one must be hard to do.

A project folder holds every analysis ever run in it — hours of compute that
nothing in the UI can reproduce. So the home screen offers only archive, and
permanent deletion exists only for something already in the archive.

What is checked here is that the archive really is a safety net: the folder and
its contents survive the round trip intact, the id is preserved (absolute paths
recorded inside state.json point at the right place again on restore), and the
destructive paths refuse the cases that would lose data — a project with jobs
still running, an id collision, and an id that is not an id at all.
"""
import json
import shutil
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException

from core.config import settings

TMP = Path(tempfile.mkdtemp())
settings.projects_dir = TMP / "projects"          # never touch the real one

import core.session as S

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


def refuses(name, fn, *, status=None, contains=None):
    try:
        fn()
        check(name, False, "it was allowed")
    except HTTPException as e:
        ok = (status is None or e.status_code == status) and \
             (contains is None or contains.lower() in str(e.detail).lower())
        check(name, ok, f"{e.status_code}: {str(e.detail)[:70]}")


def make_project(name):
    st = S.create_session(S.CreateSessionRequest(name=name))
    d = S.session_dir(st.id)
    # Something expensive-looking to prove the contents survive the round trip.
    (d / "results" / "rmsf_x").mkdir(parents=True, exist_ok=True)
    (d / "results" / "rmsf_x" / "data.xvg").write_text("0 1\n1 2\n")
    return st.id


print("1. a project archives, disappears from the list, and is still there")
pid = make_project("Archivable")
other = make_project("Keeper")
check("both projects are listed", len(S.list_sessions()) == 2)

res = S.archive_session(pid)
check("archive reports the name back", res["name"] == "Archivable", res)
ids = [p["id"] for p in S.list_sessions()]
check("the archived project left the project list", pid not in ids, ids)
check("the other project is untouched", other in ids)

arch = S.list_archived()
check("it appears in the archive", [a["id"] for a in arch] == [pid], arch)
check("the archive row keeps its name", arch[0]["name"] == "Archivable")
check("the archive row records when", bool(arch[0]["archived_at"]),
      arch[0]["archived_at"])
check("its results came with it",
      (S.archive_dir_for(pid) / "results" / "rmsf_x" / "data.xvg").exists())
check("nothing was left behind in projects/", not S.session_dir(pid).exists())

print("\n2. restoring puts it back exactly where it was")
S.restore_session(pid)
check("it is a live project again", pid in [p["id"] for p in S.list_sessions()])
check("the archive is empty", S.list_archived() == [])
check("the id is unchanged, so stored paths still resolve",
      json.loads((S.session_dir(pid) / "state.json").read_text())["id"] == pid)
check("the results survived the round trip",
      (S.session_dir(pid) / "results" / "rmsf_x" / "data.xvg").read_text()
      == "0 1\n1 2\n")
check("the archive marker is not left inside the restored project",
      not (S.session_dir(pid) / S.ARCHIVE_MARKER).exists())

print("\n3. permanent deletion is only reachable from the archive")
refuses("deleting a LIVE project through the archive route is a 404",
        lambda: S.delete_archived(pid), status=404)
S.archive_session(pid)
S.delete_archived(pid)
check("the archived copy is gone", not S.archive_dir_for(pid).exists())
check("and it is in neither list",
      pid not in [p["id"] for p in S.list_sessions()]
      and pid not in [a["id"] for a in S.list_archived()])

print("\n4. the cases that would lose data are refused")
busy = make_project("Busy")


class _FakeJob:
    def __init__(self, status):
        self.status = status


_real_list = S.job_manager.list_jobs if hasattr(S, "job_manager") else None
import core.jobs as J
_orig = J.job_manager.list_jobs
J.job_manager.list_jobs = lambda sid=None: (
    [_FakeJob(J.JobStatus.RUNNING)] if sid == busy else [])
refuses("a project with a running job will not archive",
        lambda: S.archive_session(busy), status=409, contains="still running")
J.job_manager.list_jobs = _orig
S.archive_session(busy)
check("and it archives once the job is gone",
      busy in [a["id"] for a in S.list_archived()])

# An id collision in either direction would overwrite one project with another.
clash = make_project("Clash")
shutil.move(str(S.session_dir(clash)), str(S.archive_dir_for(busy) / "x"))
dup = make_project("Dup")
(S.archive_dir_for(dup)).mkdir(parents=True, exist_ok=True)
(S.archive_dir_for(dup) / "state.json").write_text(
    json.dumps({"id": dup, "name": "old copy", "created_at": "", "updated_at": ""}))
refuses("archiving onto an id already in the archive is refused",
        lambda: S.archive_session(dup), status=409, contains="already holds")
refuses("restoring onto a live id is refused",
        lambda: S.restore_session(dup), status=409, contains="already exists")

print("\n5. an id that is not an id never reaches a path")
for bad in ("../../etc", "..", "a/b", "x" * 80, "", "with space"):
    refuses(f"{bad!r} is rejected before any file operation",
            lambda b=bad: S.archive_session(b), status=400)
refuses("and on the delete route too",
        lambda: S.delete_archived("../../etc"), status=400)
check("the projects directory is still intact",
      S.settings.projects_dir.exists() and len(S.list_sessions()) >= 1)

print("\n6. an empty or missing archive directory is not an error")
shutil.rmtree(settings.archive_dir, ignore_errors=True)
check("listing an absent archive returns nothing", S.list_archived() == [])

shutil.rmtree(TMP, ignore_errors=True)
print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)

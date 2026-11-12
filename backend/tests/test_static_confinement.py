"""
The SPA route must serve dist/ and nothing else.

In a packaged build the backend also serves the compiled UI, with a catch-all
route so a deep link falls back to index.html. That route joined the request
path onto dist/ and served whatever came out:

    GET /../../../../../etc/passwd            ->  200, /etc/passwd
    GET /..%2f..%2f..%2f..%2f..%2fetc%2fpasswd ->  200, /etc/passwd

`full_path` arrives URL-DECODED, so percent-encoding the dots changed nothing.

WHY A RAW SOCKET AND NOT TestClient.  Every HTTP client worth using normalises
`..` out of a path before sending it, and httpx (which TestClient wraps) is no
exception — a test written through it cannot express the attack. These requests
are therefore written byte for byte onto the socket, so the server sees exactly
what a hostile client would send.

WHAT THE REAL EXPOSURE WAS.  The backend binds 127.0.0.1, so reaching it means
being on the machine already, and a process running as the same user could read
those files anyway. What mattered was a SHARED machine — a lab workstation with
several accounts, or an HPC login node — where every local account can reach
another user's port; and a browser, where DNS rebinding can make 127.0.0.1
appear same-origin and so pass the CORS check.

The last two cases are the routing half of the same bug: an unknown deep link
is supposed to fall back to index.html, and any path containing `..` was
returning something else.
"""
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

fails = 0


def check(name, ok, detail=''):
    global fails
    ok = bool(ok)
    if not ok:
        fails += 1
    d = str(detail)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{('  — ' + d) if d else ''}")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def raw_get(port: int, path: str) -> bytes:
    """A GET written straight onto the socket — no client-side normalisation."""
    s = socket.create_connection(("127.0.0.1", port), 5)
    s.sendall(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
              f"Connection: close\r\n\r\n".encode())
    buf = b""
    while True:
        try:
            chunk = s.recv(65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
    s.close()
    return buf


def body_of(resp: bytes) -> bytes:
    return resp.split(b"\r\n\r\n", 1)[-1]


def main() -> int:
    # The route only exists when a built frontend is present. Rather than
    # depend on `vite build` having been run, stand up a minimal dist/ in a
    # temp tree and point the backend at it via GROMAX_DIST.
    tmp = Path(tempfile.mkdtemp())
    dist = tmp / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>SPA-INDEX</title>")
    (dist / "assets" / "app.js").write_text("// REAL-ASSET")

    # A file that exists OUTSIDE dist/, at a known depth, to traverse to.
    canary = tmp / "outside.txt"
    canary.write_text("CANARY-OUTSIDE-DIST")
    # dist/../outside.txt
    up_one = "/../outside.txt"
    # ...and all the way to a system file, from wherever dist/ happens to sit.
    depth = len(dist.resolve().parts) - 1
    to_etc = "/" + "../" * depth + "etc/passwd"

    port = free_port()
    env = dict(os.environ, GROMAX_DIST=str(dist))
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "backend" / "main.py"),
         "--port", str(port), "--host", "127.0.0.1"],
        cwd=str(ROOT), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    try:
        for _ in range(150):
            try:
                socket.create_connection(("127.0.0.1", port), 0.3).close()
                break
            except OSError:
                time.sleep(0.2)
        else:
            print("  FAIL  backend did not start")
            return 1

        # ── The route works at all ────────────────────────────────────────
        root = raw_get(port, "/")
        check("the root path serves index.html", b"SPA-INDEX" in root)
        asset = raw_get(port, "/assets/app.js")
        check("a real asset is served", b"REAL-ASSET" in body_of(asset))
        deep = raw_get(port, "/some/client/route")
        check("an unknown deep link falls back to index.html",
              b"SPA-INDEX" in body_of(deep))

        # ── Nothing outside dist/ is served ───────────────────────────────
        for label, path in [
            ("one level up", up_one),
            ("percent-encoded one level up", "/..%2foutside.txt"),
            ("dot-encoded one level up", "/%2e%2e/outside.txt"),
            ("all the way to /etc/passwd", to_etc),
            ("percent-encoded to /etc/passwd",
             "/" + to_etc[1:].replace("/", "%2f")),
            ("project source", "/../backend/main.py"),
            ("mixed separators", "/.%2e/outside.txt"),
        ]:
            resp = raw_get(port, path)
            leaked = (b"CANARY-OUTSIDE-DIST" in resp
                      or b"root:" in resp
                      or b"GroMax GUI" in body_of(resp))
            check(f"refuses {label}", not leaked, path)
            # and it is the SPA fallback, not an error — an unknown route is
            # exactly the fallback case, and a 403 would say whether the
            # traversal target exists.
            check(f"  ...and falls back to index.html instead",
                  b"SPA-INDEX" in body_of(resp),
                  resp.split(b"\r\n")[0].decode(errors="replace"))

        # ── The API surface is still not shadowed ─────────────────────────
        health = raw_get(port, "/health")
        check("/health is not swallowed by the catch-all",
              b'"status"' in body_of(health), body_of(health)[:60])
        api404 = raw_get(port, "/api/nope")
        check("an unknown /api path 404s rather than returning index.html",
              b"404" in api404.split(b"\r\n")[0])
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            proc.kill()

    print("ALL PASS" if not fails else f"{fails} FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

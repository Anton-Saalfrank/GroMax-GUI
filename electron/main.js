const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const { stopProcess, hardKillSync } = require('./killBackend.js')
const { isAllowedNavigation, isExternallyOpenable } = require('./navGuard.js')
const { probeHealth, pidOnPort, reclaimWedgedBackend } = require('./portCheck.js')
const http = require('http')
const fs = require('fs')

const net = require('net')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Port is chosen at RUNTIME, not hardcoded. A fixed 7432 meant a second
// instance — or any other service on that port — failed to start with a
// confusing error. In dev we keep 7432 so the Vite proxy target is stable.
let backendPort = 7432
let backendProcess = null
let mainWindow = null

/** Ask the OS for a free port by binding to 0 and reading what we got. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// ─── Backend lifecycle ───────────────────────────────────────────────────────

/**
 * Locate the backend.
 *
 * Production ships a FROZEN executable (PyInstaller), so the user needs no
 * Python at all. Previously this pointed at main.py and spawned whatever
 * `python3` was on PATH, assuming fastapi/uvicorn/pydantic/numpy were
 * installed there — which fails on any machine but the developer's.
 *
 * Returns { cmd, args, cwd }.
 */
function getBackendCommand() {
  if (isDev) {
    const script = path.join(__dirname, '..', 'backend', 'main.py')
    const python = process.env.GROMAX_PYTHON ||
                   (process.platform === 'win32' ? 'python' : 'python3')
    return { cmd: python, args: [script], cwd: path.join(__dirname, '..') }
  }

  const exeName = process.platform === 'win32'
    ? 'gromax-backend.exe'
    : 'gromax-backend'
  const frozen = path.join(process.resourcesPath, 'backend', exeName)

  if (fs.existsSync(frozen)) {
    return { cmd: frozen, args: [], cwd: path.dirname(frozen) }
  }

  // Fallback: an unfrozen backend was shipped (build:nofreeze). Requires the
  // user to have Python + deps, so warn loudly rather than failing silently.
  console.warn(
    `[gromax] Frozen backend not found at ${frozen} — falling back to system ` +
    `Python. The app will only start if Python 3.11+ and the packages in ` +
    `backend/requirements.txt are installed.`
  )
  const script = path.join(process.resourcesPath, 'backend', 'main.py')
  const python = process.platform === 'win32' ? 'python' : 'python3'
  return { cmd: python, args: [script], cwd: path.dirname(script) }
}

function waitForBackend(retries = 60) {
  return new Promise((resolve, reject) => {
    const check = (n) => {
      http.get(`http://127.0.0.1:${backendPort}/health`, (res) => {
        if (res.statusCode === 200) resolve()
        else retry(n)
      }).on('error', () => retry(n))
    }
    const retry = (n) => {
      if (n <= 0) return reject(new Error('Backend failed to start'))
      setTimeout(() => check(n - 1), 500)
    }
    check(retries)
  })
}

function startBackend() {
  const { cmd, args, cwd } = getBackendCommand()
  const fullArgs = [...args, '--port', String(backendPort)]

  console.log(`Starting backend: ${cmd} ${fullArgs.join(' ')}`)

  backendProcess = spawn(cmd, fullArgs, {
    cwd,
    env: { ...process.env, GROMAX_ENV: isDev ? 'development' : 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // The frozen backend is built with console=True so its stdout and stderr
    // can be piped here. On Windows a console subprocess spawned from a GUI
    // process gets its own console WINDOW, which would sit behind the app for
    // as long as it runs. Hiding it costs nothing: the pipes above are how
    // the output is read, not the window. Ignored on macOS and Linux.
    windowsHide: true
  })

  backendProcess.on('error', (err) => {
    console.error('[backend] failed to spawn:', err.message)
  })

  backendProcess.stdout.on('data', (d) => console.log('[backend]', d.toString().trim()))
  backendProcess.stderr.on('data', (d) => console.error('[backend]', d.toString().trim()))
  backendProcess.on('exit', (code) => {
    console.log(`Backend exited with code ${code}`)
    backendProcess = null
  })
}

function stopBackend() {
  if (!backendProcess) return
  const proc = backendProcess
  backendProcess = null
  // SIGTERM, escalating to SIGKILL if it is ignored. See killBackend.js — the
  // escalation used to be guarded by `!proc.killed`, which Node sets when a
  // signal is SENT rather than when the child dies, so it never ran and a
  // blocked backend outlived the app holding its port.
  stopProcess(proc, { log: (m) => console.error('[backend]', m) })
    .then((how) => {
      if (how === 'sigkill') console.error('[backend] had to be force-killed')
      if (how === 'failed') console.error('[backend] COULD NOT BE STOPPED — '
        + `kill -9 ${proc.pid}`)
    })
}

// Last-resort guards so the Python child never outlives the app.
// process.on('exit') cannot run timers or promises, so the graceful path is
// not available there and it goes straight to SIGKILL.
process.on('exit', () => { const p = backendProcess; backendProcess = null; hardKillSync(p) })
process.on('SIGINT', () => { stopBackend(); process.exit(0) })
process.on('SIGTERM', () => { stopBackend(); process.exit(0) })

// ─── Window ──────────────────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 700,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    // Load over http from the backend, NOT loadFile(). A file:// page sends
    // `Origin: null`, which CORS rejects — that made every API call from the
    // packaged app fail. Same-origin http fixes it at the root.
    await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`)
  }
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

// File dialogs
ipcMain.handle('dialog:open-files', async (_, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options)
  return result
})

ipcMain.handle('dialog:open-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  })
  return result
})

ipcMain.handle('dialog:save-file', async (_, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options)
  return result
})

/*
 * NO fs OR shell HANDLERS.
 *
 * There were three: shell:open-path, fs:read-file and fs:file-exists. All
 * three took a path straight from the renderer with no validation, so
 * fs:read-file read any file the app could and shell:open-path would hand a
 * .app/.command/.sh/.exe to the OS to EXECUTE — while the comment above them
 * said "safe subset".
 *
 * They were also unused: nothing in src/ ever called them. Everything the UI
 * does goes over HTTP to the backend, and "Reveal in Finder" is a backend
 * endpoint (core/files.py) that only accepts paths already recorded in the
 * open project. So the fix is removal rather than validation — there is no
 * check to get wrong, and no surface for a future XSS to reach.
 *
 * If a renderer-side file read is ever genuinely needed, confine it to
 * settings.projects_dir and the paths in the open project's state.json, and
 * resolve() before comparing.
 */

// App info
ipcMain.handle('app:get-version', () => app.getVersion())
ipcMain.handle('app:get-user-data-path', () => app.getPath('userData'))
ipcMain.handle('backend:get-port', () => backendPort)

// ─── App events ──────────────────────────────────────────────────────────────

/**
 * Content-Security-Policy for the packaged app.
 *
 * Electron warns about the absence of one, and it is the mitigation that
 * actually matters here: the IPC bridge has no file or shell access any more,
 * but the renderer still parses user-supplied PDB/XTC through NGL and plotly,
 * and the bundle has carried XSS advisories before. A CSP is what stops an
 * injected script from reaching anything.
 *
 * DEV IS EXCLUDED on purpose. Vite's HMR client needs eval and a websocket
 * back to :5173, so a policy tight enough to be worth having would break the
 * dev loop — and the dev server is not what ships.
 *
 * Each allowance below is here for a named reason; none is decorative:
 *   'wasm-unsafe-eval' — NGL compiles WebAssembly for structure parsing.
 *   blob: in script/worker — NGL builds its workers from blobs.
 *   'unsafe-inline' for style — React writes inline style attributes
 *      everywhere in this codebase, and plotly injects a <style> block.
 *   data:/blob: for img — plotly's canvas export and NGL's textures.
 *   connect-src 'self' — the API is same-origin by design (see api/client.ts).
 * object-src, base-uri, form-action and frame-ancestors are shut off because
 * nothing here uses them and each is an injection route.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

function applyCsp() {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    })
  })
}

app.whenReady().then(async () => {
  applyCsp()
  // Dev keeps the conventional 7432 (the renderer falls back to it when served
  // from the Vite dev server); production takes whatever the OS hands us, so
  // instances never collide.
  if (!isDev) {
    try {
      backendPort = await findFreePort()
    } catch (e) {
      console.error('Could not find a free port, falling back to 7432:', e.message)
    }
  }
  console.log(`Backend port: ${backendPort}`)

  // AN OCCUPIED PORT USED TO PRODUCE TWO CONFUSING MESSAGES AND A DEAD APP:
  // uvicorn printed "address already in use", the spawned backend exited 3, and
  // the window then silently attached to whatever was ALREADY on the port —
  // typically a stale backend running older code, which looks like changes not
  // taking effect. Now it is checked before spawning, and said plainly.
  let reuseExisting = false
  const existing = await probeHealth(backendPort)
  if (existing) {
    reuseExisting = true
    console.log(`[gromax] A healthy backend (v${existing.version}) is already `
      + `on port ${backendPort}; using it instead of starting another. If you `
      + `expected new backend code, stop that one first.`)
  } else if (pidOnPort(backendPort)) {
    // Not answering /health. If it is a copy of OUR backend it is a wedged
    // leftover — reclaim the port rather than leave the app unopenable.
    const { cmd, args } = getBackendCommand()
    const markers = [args && args[0], /python/i.test(cmd) ? null : cmd]
    const r = await reclaimWedgedBackend(backendPort, markers)
    if (r.action === 'reclaimed') {
      console.log(`[gromax] Port ${backendPort} was held by an unresponsive `
        + `backend left over from an earlier run (PID ${r.pid}); stopped it.`)
    } else {
      console.error(
        `\n[gromax] Port ${backendPort} is held by PID ${r.pid}, which is not `
        + `answering /health`
        + (r.action === 'foreign'
            ? ` and is not this app's backend, so it was left alone:\n`
              + `          ${r.command.slice(0, 160)}\n`
              + `          Stop it yourself if it is safe to:   kill ${r.pid}\n`
            : `, and could not be stopped.\n`
              + `          Free it with:   kill -9 ${r.pid}\n`))
    }
  }

  if (!reuseExisting) startBackend()

  try {
    await waitForBackend()
    console.log('Backend ready')
  } catch (e) {
    console.error('Backend startup failed:', e.message)
    // Still open window — will show connection error UI
  }

  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => stopBackend())

/*
 * Keep the renderer inside its own origin.
 *
 * `will-navigate` alone was not enough. It does not fire for window.open(),
 * which created a NEW window that inherited this preload — so the bridge was
 * reachable from a page the app never meant to load. setWindowOpenHandler
 * covers that case and denies it outright.
 *
 * Both paths now only hand http/https to the OS. The previous code called
 * shell.openExternal() on ANY non-allowed URL, which passed file://, smb://
 * and every registered custom protocol straight to the system handler.
 */
const openExternalIfWeb = (url) => {
  if (isExternallyOpenable(url)) shell.openExternal(url)
}

app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    // backendPort is read at CALL time, not captured: it is chosen at runtime
    // and is still 0/default when this listener is registered.
    if (!isAllowedNavigation(url, backendPort)) {
      event.preventDefault()
      openExternalIfWeb(url)
    }
  })

  // A link or script asking for a new window never gets one. An external http
  // link still opens — in the user's real browser, where it belongs.
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url)
    return { action: 'deny' }
  })
})

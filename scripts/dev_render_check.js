// Does the app actually RENDER under the dev server?
//
// WHY THIS EXISTS
// The partial Plotly bundle imports `plotly.js/lib/*`, which reaches for the
// Node global `global`. The production build resolves it; Vite's dependency
// pre-bundler did not, so `npm run dev` died on
// `ReferenceError: global is not defined` before React mounted and the window
// came up blank — while `npm run build`, the typecheck, the lint and every
// test stayed green. Nothing in verify.sh had ever loaded the dev server.
//
// So this does the one thing none of those did: point a real browser at
// `vite dev` and check that something appeared. It takes a URL that the
// caller has already started and waited for.
const { app, BrowserWindow } = require('electron')

const URL = process.argv[2]
const FATAL = /ReferenceError|TypeError|SyntaxError|is not defined|Failed to fetch dynamically imported/
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

if (process.env.PROFILE) app.setPath('userData', process.env.PROFILE)

app.on('ready', async () => {
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  const bad = []
  win.webContents.on('console-message', (_e, level, msg) => {
    // The CSP notice is Electron's own dev-mode warning, not the app's.
    if (level >= 2 && !/Content-Security-Policy/.test(msg) && FATAL.test(msg)) {
      bad.push(msg.split('\n')[0].slice(0, 160))
    }
  })

  let children = 0
  try {
    await win.loadURL(URL)
    await wait(5000)
    children = await win.webContents.executeJavaScript(
      "document.getElementById('root') ? document.getElementById('root').children.length : -1")
  } catch (e) {
    bad.push(String(e).slice(0, 160))
  }

  if (bad.length) {
    console.log('  the renderer reported:')
    for (const m of bad) console.log('    ' + m)
  }
  if (children < 1) {
    console.log(`  #root has ${children === -1 ? 'no element' : 'no children'}`
      + ' — the app did not mount under the dev server')
  }
  const ok = children >= 1 && bad.length === 0
  console.log(ok ? `  ok    the app mounted under vite dev (#root children: ${children})`
                 : '  FAIL  the app did not render under vite dev')
  app.exit(ok ? 0 : 1)
})

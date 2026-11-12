/**
 * Which URLs the renderer may navigate to, and which the OS may be handed.
 *
 * Extracted from main.js for the same reason killBackend and portCheck were:
 * it is security logic with edge cases, and inside main.js it could only be
 * tested by launching Electron. Here it is three pure functions.
 *
 * WHAT WAS WRONG BEFORE
 *
 * 1. Only `will-navigate` was guarded. It does not fire for window.open(),
 *    which creates a new window that INHERITS the preload — so the IPC bridge
 *    was reachable from a page the app never meant to load.
 *
 * 2. The guard's fallback was shell.openExternal(url) for any non-allowed
 *    URL. That is the OS's "open this with whatever handles it" call, and it
 *    was being given every scheme: file://, smb://, and any custom protocol
 *    some other installed application had registered. Only http and https are
 *    meaningfully "open this in the browser".
 */

/** Origins the renderer itself is allowed to be on. */
function allowedOrigins(backendPort) {
  return [
    // The Vite dev server.
    'http://localhost:5173',
    // The packaged app loads the UI from the backend over http (not file://,
    // which sends `Origin: null` and fails CORS), so the backend's own origin
    // is the app's origin.
    `http://127.0.0.1:${backendPort}`,
    `http://localhost:${backendPort}`,
  ]
}

/**
 * May the renderer navigate here?
 *
 * Compared by ORIGIN, not by prefix. A prefix test on
 * `http://127.0.0.1:7432` also matches `http://127.0.0.1:74321` and
 * `http://127.0.0.1:7432.evil.com`; an origin comparison matches neither.
 */
function isAllowedNavigation(url, backendPort) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false        // not a URL at all — certainly not an allowed one
  }
  return allowedOrigins(backendPort).includes(u.origin)
}

/**
 * May this URL be handed to the OS to open?
 *
 * http/https only. Everything else — file:, smb:, javascript:, and whatever
 * custom schemes other installed apps have claimed — is dropped silently,
 * because "open externally" is about the user's browser and nothing else.
 */
function isExternallyOpenable(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  return u.protocol === 'http:' || u.protocol === 'https:'
}

module.exports = { allowedOrigins, isAllowedNavigation, isExternallyOpenable }

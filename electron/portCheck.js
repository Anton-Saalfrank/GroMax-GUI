'use strict'

/**
 * Who is on the backend port, and is it one of ours?
 *
 * An occupied port used to produce two confusing messages and a dead app:
 * uvicorn printed "address already in use", the spawned backend exited 3, and
 * the window then silently attached to whatever was ALREADY on the port —
 * typically a stale backend running older code, which presents as "my changes
 * did not take effect". Checking first lets the launcher say which of those is
 * happening.
 */
const http = require('http')

/** A healthy gromax backend on this port, or null. */
function probeHealth(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health',
                           timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        try {
          const j = JSON.parse(body)
          resolve(j && j.status === 'ok' ? j : null)
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/** Who holds a port, for an error message the user can act on. */
function pidOnPort(port) {
  if (process.platform === 'win32') return null
  try {
    const { execFileSync } = require('child_process')
    // -sTCP:LISTEN matters: without it lsof also returns every process with a
    // CLIENT socket on that port, and this pid is printed in a "kill -9" line.
    // Measured — a python listener (74727) with a node client (74729) attached
    // gives "74727,74729" plain and "74727" with the filter. Naming the client
    // would tell the user to kill the wrong process.
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'],
                             { encoding: 'utf8', timeout: 2000 })
    return out.trim().split('\n')[0] || null
  } catch { return null }
}

/** The full command line of a process, or '' if it cannot be read. */
function commandOfPid(pid) {
  if (!pid || process.platform === 'win32') return ''
  try {
    const { execFileSync } = require('child_process')
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)],
                        { encoding: 'utf8', timeout: 2000 }).trim()
  } catch { return '' }
}

/** Resolves once nothing is listening on the port, or false after timeoutMs. */
async function waitPortFree(port, timeoutMs = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (!pidOnPort(port)) return true
    await new Promise(r => setTimeout(r, 150))
  }
  return !pidOnPort(port)
}

/**
 * Free the port from a WEDGED copy of this app's own backend.
 *
 * The case this exists for, measured: a backend stuck inside a C call held
 * port 7432 at 99% CPU, answered nothing, ignored SIGTERM (its handler needs
 * the very lock that was held), and outlived the window that started it. Every
 * relaunch then found the port taken, started a backend that could not bind,
 * and attached the window to the wedged one — so the app could not be
 * reopened at all without a kill -9 from a terminal.
 *
 * Only ever touches a process whose command line contains one of `ownMarkers`
 * (this repo's backend script, or the packaged backend executable) AND which
 * has already failed /health. A healthy backend is reused, and anything else
 * on the port is reported, never killed: it is not ours to kill.
 *
 * Returns { action: 'none' | 'reclaimed' | 'foreign' | 'stuck', pid, command }.
 */
async function reclaimWedgedBackend(port, ownMarkers) {
  const pid = pidOnPort(port)
  if (!pid) return { action: 'none', pid: null, command: '' }
  const command = commandOfPid(pid)
  const ours = ownMarkers.filter(Boolean).some(m => command.includes(m))
  if (!ours) return { action: 'foreign', pid, command }
  try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ }
  const freed = await waitPortFree(port, 5000)
  return { action: freed ? 'reclaimed' : 'stuck', pid, command }
}

module.exports = { probeHealth, pidOnPort, commandOfPid, waitPortFree,
                   reclaimWedgedBackend }

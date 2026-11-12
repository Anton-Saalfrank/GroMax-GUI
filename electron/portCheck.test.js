'use strict'
/**
 * Telling "a backend is already running" apart from "something else is stuck
 * on the port".
 *
 * REGRESSION: neither was detected. The launcher spawned a second backend
 * regardless, uvicorn failed to bind, the child exited 3, and the window then
 * attached to whatever already held the port — so a stale backend running old
 * code looked exactly like a successful start, and "restart the backend" did
 * nothing visible. Both cases are now identified before anything is spawned.
 */
const { spawn } = require('child_process')
const net = require('net')
const { probeHealth, pidOnPort, reclaimWedgedBackend } = require('./portCheck.js')

let fails = 0
const check = (name, ok, detail) => {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const freePort = () => new Promise((res) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) })
})

async function main() {
  const PY = process.env.GROMAX_TEST_PYTHON || 'python3'
  const port = await freePort()

  console.log('1. nothing on the port')
  check('probeHealth returns null', (await probeHealth(port)) === null)
  check('pidOnPort returns null', pidOnPort(port) === null)

  console.log('\n2. a real backend on the port is recognised')
  const proc = spawn(PY, [require('path').join(__dirname, '..', 'backend', 'main.py'),
                          '--port', String(port)],
                     { stdio: 'ignore', env: { ...process.env, GROMAX_ENV: 'test' } })
  let health = null
  for (let i = 0; i < 40 && !health; i++) { await sleep(500); health = await probeHealth(port) }
  check('probeHealth reports it healthy', !!health, health ? `v${health.version}` : 'never came up')
  check('and reports its version', !!(health && health.version), health && health.version)
  check('pidOnPort finds the listener', String(pidOnPort(port) || '') !== '',
        `pid ${pidOnPort(port)}`)

  console.log('\n3. a port held by something that is NOT a backend')
  const other = await freePort()
  const dummy = net.createServer(() => {})
  await new Promise(r => dummy.listen(other, '127.0.0.1', r))
  check('probeHealth refuses to call it healthy', (await probeHealth(other, 800)) === null)
  check('but pidOnPort still names the holder', String(pidOnPort(other) || '') !== '',
        `pid ${pidOnPort(other)}`)
  dummy.close()

  console.log('\n4. a port whose holder never answers does not hang the launcher')
  const deaf = await freePort()
  const deafSrv = net.createServer(() => {})   // accepts, never responds
  await new Promise(r => deafSrv.listen(deaf, '127.0.0.1', r))
  const t0 = Date.now()
  const r = await probeHealth(deaf, 700)
  const dt = Date.now() - t0
  check('it gives up rather than blocking', r === null && dt < 2500, `${dt} ms`)
  deafSrv.close()

  console.log('\n5. the pid named for "kill -9" is the LISTENER, not a client')
  // lsof without -sTCP:LISTEN also returns processes holding a client socket
  // on that port. Since this pid goes into a kill instruction, picking the
  // wrong one would tell the user to kill something innocent.
  const victim = await new Promise((res) => {
    const c = require('net').connect(port, '127.0.0.1', () => res(c))
  })
  check('the backend is the named holder, not this test process',
        String(pidOnPort(port)) === String(proc.pid),
        `named ${pidOnPort(port)}, backend is ${proc.pid}, this process is ${process.pid}`)
  victim.destroy()

  try { proc.kill('SIGKILL') } catch {}

  console.log('\n6. a WEDGED copy of our own backend is cleared so the app can open')
  // The real failure: a backend stuck in a C call held the port, answered
  // nothing and ignored SIGTERM, so every relaunch failed. Simulated with a
  // process whose command line names a backend script and which accepts
  // connections but never replies.
  const fs = require('fs'), os = require('os'), path = require('path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gxwedge-'))
  const fakeBackend = path.join(dir, 'main.py')
  fs.writeFileSync(fakeBackend, [
    'import signal, socket, sys, time',
    'signal.signal(signal.SIGTERM, signal.SIG_IGN)   # wedged: ignores TERM',
    's = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
    "s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(5)",
    'conns = []',
    'while True:',
    '    c, _ = s.accept(); conns.append(c)           # accepts, never answers',
  ].join('\n'))
  const wport = await freePort()
  const wedged = spawn(PY, [fakeBackend, String(wport)], { stdio: 'ignore' })
  for (let i = 0; i < 40 && !pidOnPort(wport); i++) await sleep(100)
  check('the fake backend holds the port', !!pidOnPort(wport), `pid ${pidOnPort(wport)}`)
  check('and does not answer /health', (await probeHealth(wport, 600)) === null)
  const rw = await reclaimWedgedBackend(wport, [fakeBackend])
  check('it is recognised as ours and cleared', rw.action === 'reclaimed', rw.action)
  check('the port is free afterwards', !pidOnPort(wport))

  console.log('\n7. something on the port that is NOT our backend is left alone')
  const foreign = spawn(PY, ['-c', [
    'import socket, sys, time',
    's = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
    "s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(5)",
    'time.sleep(60)'].join('\n'), String(wport)], { stdio: 'ignore' })
  for (let i = 0; i < 40 && !pidOnPort(wport); i++) await sleep(100)
  const r2 = await reclaimWedgedBackend(wport, [fakeBackend])
  check('a foreign process is reported, not killed', r2.action === 'foreign', r2.action)
  check('and it is still running', !!pidOnPort(wport), `pid ${pidOnPort(wport)}`)
  try { foreign.kill('SIGKILL') } catch {}
  try { wedged.kill('SIGKILL') } catch {}
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
  process.exit(fails ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })

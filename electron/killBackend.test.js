'use strict'
/**
 * The backend child must die even when it refuses to.
 *
 * REGRESSION: a uvicorn whose event loop is blocked by CPU work cannot run its
 * SIGTERM handler, and the escalation that was supposed to follow up with
 * SIGKILL was guarded by `!proc.killed` — a flag Node sets when a signal has
 * been SENT, not when the child has died. So the escalation never ran, and a
 * backend survived the app by an hour, holding port 7432 at 99% CPU and
 * immune to `kill`, which made every later `npm run dev` fail to bind.
 *
 * Test 2 is that exact process: it ignores SIGTERM. It has to die anyway.
 */
const { spawn } = require('child_process')
const { stopProcess, hardKillSync, hasExited } = require('./killBackend.js')

let fails = 0
const check = (name, ok, detail) => {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const PY = process.env.GROMAX_TEST_PYTHON || 'python3'
const spawnPy = (code) => spawn(PY, ['-c', code], { stdio: 'ignore' })
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('1. a well-behaved backend stops on SIGTERM')
  let p = spawnPy('import time; time.sleep(60)')
  await sleep(300)
  let t0 = Date.now()
  let how = await stopProcess(p, { graceMs: 1500 })
  check('it exits without needing SIGKILL', how === 'sigterm', `via ${how}`)
  check('and quickly', Date.now() - t0 < 1200, `${Date.now() - t0} ms`)
  check('the process is really gone', !alive(p.pid))

  console.log('\n2. a backend that IGNORES SIGTERM still dies')
  // Exactly the failure seen in the wild: signal handler never runs.
  p = spawnPy('import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)')
  await sleep(400)
  check('it survives a plain SIGTERM', (p.kill('SIGTERM'), await sleep(400), alive(p.pid)),
        'confirms the fixture really ignores it')
  t0 = Date.now()
  how = await stopProcess(p, { graceMs: 600 })
  check('stopProcess escalates and kills it', how === 'sigkill', `via ${how}`)
  check('the process is really gone', !alive(p.pid))
  check('within the grace period plus a little', Date.now() - t0 < 2000,
        `${Date.now() - t0} ms`)

  console.log('\n3. the synchronous last-resort path kills immediately')
  p = spawnPy('import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)')
  await sleep(400)
  const sent = hardKillSync(p)
  await sleep(300)
  check('hardKillSync reports it signalled', sent)
  check('and a SIGTERM-ignoring process is gone', !alive(p.pid))

  console.log('\n4. stopping something already dead is not an error')
  p = spawnPy('pass')
  await sleep(500)
  check('a finished child is recognised', hasExited(p))
  how = await stopProcess(p, { graceMs: 300 })
  check('it reports already-gone', how === 'already-gone', `via ${how}`)
  check('hardKillSync does nothing to it', hardKillSync(p) === false)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
  process.exit(fails ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })

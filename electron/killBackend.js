'use strict'

/**
 * Stopping the backend child for certain.
 *
 * THE BUG THIS EXISTS FOR
 * The previous version sent SIGTERM and then escalated with:
 *
 *     if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL')
 *
 * `proc.killed` does not mean "the process died". Node sets it to true as soon
 * as a signal has been successfully SENT, so after the SIGTERM above it is
 * always true and the SIGKILL never fires. The escalation was dead code.
 *
 * That only matters when SIGTERM is ignored — and a uvicorn whose event loop is
 * blocked by CPU work ignores it, because the signal handler cannot run until
 * the loop gets a turn. The result was a backend still holding port 7432 at
 * 99% CPU an hour after the app had quit, immune to `kill`, which then made
 * every later `npm run dev` fail to bind with a confusing double error.
 *
 * Death is therefore detected from the 'exit' EVENT, never from a flag about
 * what was sent.
 */

/** Has this child already gone? */
function hasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null
}

/**
 * SIGTERM, then SIGKILL if it is still alive after `graceMs`.
 * Resolves with how it ended: 'already-gone' | 'sigterm' | 'sigkill' | 'failed'.
 */
function stopProcess(proc, { graceMs = 2000, log = () => {} } = {}) {
  return new Promise((resolve) => {
    if (!proc || hasExited(proc)) return resolve('already-gone')

    let settled = false
    const finish = (how) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(how)
    }

    proc.once('exit', () => finish(graceOver ? 'sigkill' : 'sigterm'))

    let graceOver = false
    try {
      proc.kill('SIGTERM')
    } catch (e) {
      log(`SIGTERM failed: ${e.message}`)
    }

    const timer = setTimeout(() => {
      graceOver = true
      if (hasExited(proc)) return finish('sigterm')
      log(`backend ignored SIGTERM after ${graceMs} ms — sending SIGKILL`)
      try {
        proc.kill('SIGKILL')
      } catch (e) {
        log(`SIGKILL failed: ${e.message}`)
        return finish('failed')
      }
      // SIGKILL cannot be caught, so 'exit' follows almost immediately; this
      // only covers a child already reaped by something else.
      setTimeout(() => finish(hasExited(proc) ? 'sigkill' : 'failed'), 400).unref?.()
    }, graceMs)
    timer.unref?.()
  })
}

/**
 * The last-resort path, for process.on('exit').
 *
 * Nothing asynchronous can run there — no timers, no promises — so there is no
 * way to send SIGTERM and then wait to see whether it worked. The choice is
 * between a polite signal that may be ignored (which is what orphaned the
 * backend) and an immediate one that cannot be. At this point the app is gone
 * and the child has nothing left to deliver its work to, so it is SIGKILL.
 */
function hardKillSync(proc) {
  if (!proc || hasExited(proc)) return false
  try {
    proc.kill('SIGKILL')
    return true
  } catch {
    // Already dead, or not ours to signal — either way there is nothing
    // left to kill.
    return false
  }
}

module.exports = { stopProcess, hardKillSync, hasExited }

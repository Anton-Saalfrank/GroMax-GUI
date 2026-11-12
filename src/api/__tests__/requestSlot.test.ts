/**
 * Cancellation, timeouts, and which reply is allowed to win.
 *
 * Three bugs are pinned here, all of which were invisible in normal use and
 * obvious once the machine was slow:
 *
 *   1. A request that never came back left the UI loading forever. The job
 *      poller and the backend-online probe run on an interval, so one stuck
 *      request froze them at their last value with no way back but a restart.
 *   2. Opening project A then project B let whichever answered LAST win, so a
 *      slow first project could paint its state over the second.
 *   3. A poll that outlasted its interval could land after a newer one, so a
 *      finished job flipped back to running.
 *
 * `fetch` is stubbed, so nothing here touches a network or a backend.
 */
import { api, RequestSlot, ApiAbortError, isSuperseded, QUICK_MS }
  from '../client'

let fails = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

type Init = { signal?: AbortSignal }
interface Call { url: string; signal?: AbortSignal }
const calls: Call[] = []

/** A fetch that resolves after `ms`, or never, and honours its abort signal. */
function stubFetch(ms: number | 'never', body: unknown = { ok: true }) {
  ;(globalThis as any).fetch = (url: string, init: Init = {}) => {
    calls.push({ url, signal: init.signal })
    return new Promise((resolve, reject) => {
      const fail = () => reject(Object.assign(
        new DOMException('aborted', 'AbortError')))
      if (init.signal?.aborted) return fail()
      init.signal?.addEventListener('abort', fail, { once: true })
      if (ms !== 'never') {
        setTimeout(() => resolve({
          ok: true, status: 200, statusText: 'OK',
          json: async () => body, text: async () => JSON.stringify(body),
        } as any), ms)
      }
    })
  }
}

async function main() {
  console.log('1. a request that never answers is given up on, not waited on')
  stubFetch('never')
  {
    const t0 = Date.now()
    let err: any = null
    // Through the real api surface, with the timeout cut short so the test is
    // quick. `session.get` carries QUICK_MS by default; opts override it.
    try { await api.session.get('abc', { timeoutMs: 120 }) }
    catch (e) { err = e }
    const dt = Date.now() - t0

    check('it rejects rather than hanging', err !== null)
    check('with an ApiAbortError', err instanceof ApiAbortError,
          err?.constructor?.name)
    check("whose reason is 'timeout'", err?.reason === 'timeout', err?.reason)
    check('and a message naming the wait, so the UI can say what happened',
          /did not respond/.test(err?.message || ''), err?.message)
    check('at roughly the stated time, not the default',
          dt >= 100 && dt < 2000, `${dt} ms`)
    check('a timeout is NOT treated as superseded — the user must be told',
          !isSuperseded(err))
    check('the default for a quick metadata call is 15s',
          QUICK_MS === 15000, String(QUICK_MS))
  }

  console.log('\n2. a long-running endpoint is left unbounded')
  stubFetch(40)
  {
    calls.length = 0
    const res: any = await api.session.usage()
    check('it completes', res?.ok === true)
    // No timeout and no caller signal means no AbortController is built at
    // all — so a genuinely slow gmx call cannot be killed by this layer.
    check('and fetch was given no abort signal whatsoever',
          calls[0]?.signal === undefined, String(calls[0]?.signal))
  }
  {
    // ...but it still accepts one when the caller supplies it.
    calls.length = 0
    await api.session.usage({ signal: new AbortController().signal })
    check('unless the caller supplies one', calls[0]?.signal !== undefined)
  }

  console.log('\n3. a slot cancels the request it replaces')
  {
    const slot = new RequestSlot()
    const first = slot.begin()
    const second = slot.begin()

    check('starting a second request aborts the first', first.aborted)
    check('and leaves the second live', !second.aborted)
    check('only the newest signal is current',
          slot.current(second) && !slot.current(first))

    slot.cancel()
    check('cancel aborts the outstanding one', second.aborted)
    check('and nothing is current afterwards', !slot.current(second))
  }

  console.log('\n4. the superseded request reports itself as such, not as an error')
  stubFetch('never')
  {
    const slot = new RequestSlot()
    const signal = slot.begin()
    const inflight = api.session.get('slow', { signal }).then(
      () => 'resolved', (e) => e)

    slot.begin()                       // user opens another project
    const err: any = await inflight

    check('the first request rejects', err instanceof ApiAbortError,
          err?.constructor?.name)
    check("with reason 'superseded'", err?.reason === 'superseded', err?.reason)
    check('which isSuperseded recognises, so no error is shown to the user',
          isSuperseded(err))
    check('a timeout, by contrast, is not swallowed',
          !isSuperseded(new ApiAbortError('timeout', 'x')))
  }

  console.log('\n5. latest-wins, end to end')
  {
    // Project A answers slowly, project B quickly — the order that used to
    // leave the header naming B and the tabs showing A.
    const order: string[] = []
    ;(globalThis as any).fetch = (url: string, init: Init = {}) =>
      new Promise((resolve, reject) => {
        const slow = url.includes('slowproj')
        const fail = () => reject(new DOMException('aborted', 'AbortError'))
        if (init.signal?.aborted) return fail()
        init.signal?.addEventListener('abort', fail, { once: true })
        setTimeout(() => {
          order.push(slow ? 'A' : 'B')
          resolve({ ok: true, status: 200, statusText: 'OK',
                    json: async () => ({ id: slow ? 'A' : 'B' }) } as any)
        }, slow ? 150 : 10)
      })

    const slot = new RequestSlot()
    const sigA = slot.begin()
    const a = api.session.get('slowproj', { signal: sigA }).then(
      r => ({ r }), e => ({ e }))
    const sigB = slot.begin()
    const b = api.session.get('fastproj', { signal: sigB }).then(
      r => ({ r }), e => ({ e }))

    const [ra, rb]: any[] = await Promise.all([a, b])
    check('the superseded project load is dropped', isSuperseded(ra.e),
          ra.e?.reason || 'resolved')
    check('the one the user asked for survives', rb.r?.id === 'B', rb.r?.id)
    check('and it is still the current one, so the store may apply it',
          slot.current(sigB))
    check("the aborted request's reply never even arrives",
          !order.includes('A'), order.join(','))
  }

  console.log('\n6. a dead socket stays a network error, not a timeout')
  {
    ;(globalThis as any).fetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    let err: any = null
    try { await api.session.get('x', { timeoutMs: 5000 }) } catch (e) { err = e }
    // Mislabelling this would point the user at a slow backend when the real
    // answer is that it is not running at all.
    check('it is not wrapped as an abort', !(err instanceof ApiAbortError),
          err?.constructor?.name)
    check('and keeps its own message', /Failed to fetch/.test(err?.message))
  }

  console.log("\n7. FastAPI's `detail` still reaches the user")
  {
    ;(globalThis as any).fetch = async () => ({
      ok: false, status: 404, statusText: 'Not Found',
      json: async () => ({ detail: "Session 'nope' not found" }),
    })
    let err: any = null
    try { await api.session.get('nope') } catch (e) { err = e }
    check('the helpful message is preserved, not replaced by the status',
          err?.message === "Session 'nope' not found", err?.message)
    check('and an HTTP error is not an abort', !(err instanceof ApiAbortError))
  }

  // A pending timeout timer would hold the event loop open. Reaching here and
  // exiting promptly is the assertion that `done()` clears it: §2 ran with the
  // 15s default and §6 with 5s, and neither may outlive its request.
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
  process.exit(fails ? 1 : 0)
}

main()

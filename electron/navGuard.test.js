'use strict'
/**
 * The renderer must not be able to leave its origin, or hand the OS a URL.
 *
 * REGRESSION: `will-navigate` was the only guard, and its fallback was
 * shell.openExternal() on ANY non-allowed URL. Two consequences:
 *
 *   - window.open() was not covered at all. It creates a new window that
 *     inherits the preload, so the IPC bridge was reachable from a page the
 *     app never meant to load.
 *   - openExternal() was handed every scheme, including file:// and whatever
 *     custom protocols other installed applications had registered.
 *
 * The origin test is also checked for prefix confusion, which is the classic
 * way an allow-list of URLs leaks: `startsWith('http://127.0.0.1:7432')` also
 * accepts port 74321 and the host `127.0.0.1:7432.evil.com`.
 */
const { allowedOrigins, isAllowedNavigation, isExternallyOpenable } = require('./navGuard.js')

let fails = 0
const check = (name, ok, detail) => {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const PORT = 7432

console.log('1. the app\'s own origins are allowed')
check('the backend origin on 127.0.0.1',
      isAllowedNavigation(`http://127.0.0.1:${PORT}/`, PORT))
check('the same host spelled localhost',
      isAllowedNavigation(`http://localhost:${PORT}/index.html`, PORT))
check('the Vite dev server',
      isAllowedNavigation('http://localhost:5173/', PORT))
check('a deep path on an allowed origin',
      isAllowedNavigation(`http://127.0.0.1:${PORT}/project/abc?x=1#y`, PORT))
check('the allow-list follows the RUNTIME port, which is not fixed',
      isAllowedNavigation('http://127.0.0.1:51234/', 51234)
      && !isAllowedNavigation('http://127.0.0.1:51234/', PORT))

console.log('\n2. prefix confusion is rejected (origin compare, not startsWith)')
check('a longer port number is NOT the allowed port',
      !isAllowedNavigation(`http://127.0.0.1:${PORT}1/`, PORT),
      `http://127.0.0.1:${PORT}1/`)
check('a hostname that merely begins with the allowed authority',
      !isAllowedNavigation(`http://127.0.0.1:${PORT}.evil.com/`, PORT))
check('a userinfo trick pointing at another host',
      !isAllowedNavigation(`http://127.0.0.1:${PORT}@evil.com/`, PORT),
      `resolved host is evil.com`)
check('https on the right host and port is still a different origin',
      !isAllowedNavigation(`https://127.0.0.1:${PORT}/`, PORT))
check('another loopback spelling is not on the list',
      !isAllowedNavigation(`http://[::1]:${PORT}/`, PORT))

console.log('\n3. nothing else may be navigated to')
for (const url of ['https://example.com/', 'http://evil.com/',
                   'file:///etc/passwd', 'about:blank']) {
  check(`refuses ${url}`, !isAllowedNavigation(url, PORT))
}
check('a string that is not a URL is refused, not thrown on',
      !isAllowedNavigation('not a url', PORT))
check('an empty string is refused', !isAllowedNavigation('', PORT))
check('undefined is refused', !isAllowedNavigation(undefined, PORT))

console.log('\n4. only http/https may be handed to the OS')
check('https opens externally', isExternallyOpenable('https://doi.org/10.1234/x'))
check('http opens externally', isExternallyOpenable('http://example.com/'))
for (const url of ['file:///Users/me/.ssh/id_rsa',
                   'smb://server/share',
                   'javascript:alert(1)',
                   'data:text/html,<script>alert(1)</script>',
                   'ms-msdt:/id',
                   'zoommtg://zoom.us/join?confno=1']) {
  check(`refuses to hand the OS ${url.slice(0, 34)}`, !isExternallyOpenable(url))
}
check('a non-URL is refused rather than thrown on', !isExternallyOpenable('nope'))

console.log('\n5. the allow-list has no accidental entries')
const origins = allowedOrigins(PORT)
check('exactly three origins', origins.length === 3, origins.join(' '))
check('all loopback, none wildcard',
      origins.every(o => /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o)),
      origins.join(' '))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)

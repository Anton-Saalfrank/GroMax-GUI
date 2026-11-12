/**
 * Hand a generated file to the user.
 *
 * In its own module because the Electron renderer runs with a restrictive CSP
 * and the object URL must be revoked — leaking one pins the whole Blob in
 * memory, which for a multi-megabyte CSV of a long trajectory is not nothing.
 */
export function downloadText(filename: string, text: string,
                             mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Deferred: revoking synchronously can cancel the download in some
    // Chromium builds before the click has been serviced.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

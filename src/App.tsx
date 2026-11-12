import { useEffect } from 'react'
import { useStore } from './store'
import TitleBar from './components/TitleBar'
import HomeScreen from './components/HomeScreen'
import ProjectScreen from './components/ProjectScreen'

// Polling intervals (ms). Both back off when there's nothing happening: the app
// used to poll jobs every 2s and health every 5s forever, which is a request
// every couple of seconds all day even with an empty queue.
const JOBS_POLL_ACTIVE = 2000    // while something is queued or running
const JOBS_POLL_IDLE   = 15000   // nothing running — just catch external changes
const HEALTH_POLL_UP   = 15000   // backend healthy: a slow heartbeat is enough
const HEALTH_POLL_DOWN = 3000    // backend down: check often so it reconnects fast

export default function App() {
  const { view, checkBackend, backendOnline, pollJobs, theme, jobs,
          flushWorkspace } = useStore()

  // The workspace save is debounced, so closing the window within a second of
  // the last change would drop it. Flush on the way out.
  //
  // `pagehide` rather than `beforeunload`: Electron fires it reliably on
  // window close, and it does not risk prompting the user.
  useEffect(() => {
    const flush = () => { flushWorkspace() }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flushWorkspace])

  // Apply the theme attribute so the CSS token overrides take effect
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Health check — slow while the backend is up, fast while it's down so the
  // app reconnects promptly.
  useEffect(() => {
    checkBackend()
    const period = backendOnline ? HEALTH_POLL_UP : HEALTH_POLL_DOWN
    const interval = setInterval(checkBackend, period)
    return () => clearInterval(interval)
    // checkBackend/pollJobs are store actions — defined once in create(), so
    // their identity never changes and listing them cannot cause a re-run.
  }, [backendOnline, checkBackend])

  // Job polling — 2s while work is in flight, otherwise a slow idle poll.
  // Tabs also call pollJobs() directly on submit, so a new job is picked up
  // immediately rather than waiting out the idle interval.
  const hasActiveJobs = jobs.some(j => j.status === 'running' || j.status === 'pending')
  useEffect(() => {
    if (!backendOnline) return
    pollJobs()
    const period = hasActiveJobs ? JOBS_POLL_ACTIVE : JOBS_POLL_IDLE
    const interval = setInterval(pollJobs, period)
    return () => clearInterval(interval)
  }, [backendOnline, hasActiveJobs, pollJobs])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TitleBar />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {view === 'home'    && <HomeScreen />}
        {view === 'project' && <ProjectScreen />}
      </div>
    </div>
  )
}

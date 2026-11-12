import { Sun, Moon } from 'lucide-react'
import { useStore } from '../store'

export default function TitleBar() {
  const { backendOnline, backendInfo, activeSession, theme, setTheme } = useStore()
  const isMac = navigator.platform.toUpperCase().includes('MAC')

  return (
    <div style={{
      height: 40,
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      paddingLeft: isMac ? 80 : 16,
      paddingRight: 16,
      gap: 12,
      // Electron drag region
      WebkitAppRegion: 'drag' as any,
      flexShrink: 0,
      zIndex: 100,
    }}>
      {/* Logo mark */}
      <div style={{
        width: 22, height: 22,
        background: 'var(--accent)',
        borderRadius: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 800, color: '#fff',
        flexShrink: 0,
      }}>G</div>

      {/* App name */}
      <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.5 }}>
        GroMax
      </span>

      {/* Project breadcrumb */}
      {activeSession && (
        <>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
            {activeSession.name}
          </span>
        </>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Theme toggle */}
      <button
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 26, height: 26, borderRadius: 6,
          background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
          border: '1px solid var(--border)', cursor: 'pointer',
          WebkitAppRegion: 'no-drag' as any,
        }}>
        {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
      </button>

      {/* Backend status pill */}
      <div style={{
        WebkitAppRegion: 'no-drag' as any,
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 20,
        padding: '3px 10px',
        fontSize: 11,
        color: backendOnline ? 'var(--green)' : 'var(--red)',
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: backendOnline ? 'var(--green)' : 'var(--red)',
          animation: backendOnline ? 'none' : 'pulse 1.5s infinite',
        }} />
        {backendOnline ? 'backend online' : 'backend offline'}
        {backendOnline && backendInfo?.gromacs_available && (
          <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
            · gmx ✓
          </span>
        )}
        {backendOnline && !backendInfo?.gromacs_available && (
          <span style={{ color: 'var(--amber)', marginLeft: 4 }}>
            · gmx not found
          </span>
        )}
      </div>
    </div>
  )
}

import React from 'react'

/**
 * Catches render errors in a subtree.
 *
 * WHY: an unhandled error anywhere in the React tree unmounts the ENTIRE app,
 * so a single bad reference in the structure viewer turned the whole window
 * black with no message — the user could not even switch back to another tab
 * to keep working. Confining the failure keeps the rest of the app usable and,
 * just as importantly, shows what actually went wrong instead of a blank
 * screen.
 */
interface Props {
  children: React.ReactNode
  /** Shown in the fallback so the user knows which part failed. */
  label?: string
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the stack in the console — the fallback shows only the message.
    console.error('[gromax] render error', error, info?.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div style={{
        flex: 1, overflow: 'auto', padding: '32px 28px',
        color: 'var(--text)',
      }}>
        <div style={{
          maxWidth: 620, padding: '18px 20px', borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--bg-surface)',
        }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>
            {this.props.label || 'This view'} hit an error
          </h3>
          <p style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.85, margin: '0 0 12px' }}>
            The rest of the app is still working — switch to another tab to carry
            on. If this keeps happening, the message below is the useful part to
            report.
          </p>
          <code style={{
            display: 'block', fontSize: 11, padding: '9px 11px', borderRadius: 4,
            background: 'var(--bg)', border: '1px solid var(--border)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {error.message || String(error)}
          </code>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 12, fontSize: 12, padding: '6px 13px', borderRadius: 4,
              cursor: 'pointer', border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text)',
            }}
          >Try again</button>
        </div>
      </div>
    )
  }
}

import { Component, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/** Last-resort screen if rendering fails, with a way out that doesn't need dev tools. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  reset = () => {
    try {
      localStorage.removeItem('axlr8.lab')
    } catch {
      /* storage unavailable */
    }
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1>The lab could not be displayed</h1>
        <p>{this.state.error.message}</p>
        <p>Resetting loads the example lab. Save your lab to a file first if you can.</p>
        <button type="button" className="primary" onClick={this.reset}>
          Reset to the example lab
        </button>
      </div>
    )
  }
}

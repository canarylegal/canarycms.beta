import { Component, type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { applyStoredTheme } from './theme'
import { DialogProvider } from './DialogProvider'
import App from './App.tsx'

applyStoredTheme()
import EditorPage from './EditorPage.tsx'
import { FinanceStandalone } from './FinancePage.tsx'
import { LedgerStandalone } from './LedgerPage.tsx'

class AppErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }

  static getDerivedStateFromError(err: Error) {
    return { err }
  }

  render() {
    if (this.state.err) {
      return (
        <div
          style={{
            padding: 24,
            fontFamily: 'system-ui, sans-serif',
            background: 'var(--page-bg)',
            color: '#dc2626',
            minHeight: '100vh',
            whiteSpace: 'pre-wrap',
          }}
        >
          <h1 style={{ color: '#b91c1c' }}>Canary hit a runtime error</h1>
          <p style={{ color: '#64748b' }}>Check the browser console for details. Stack:</p>
          {this.state.err.stack ?? String(this.state.err)}
        </div>
      )
    }
    return this.props.children
  }
}

const el = document.getElementById('root')
if (!el) {
  document.body.innerHTML = '<p style="padding:24px;font-family:sans-serif">Missing #root — index.html is invalid.</p>'
} else {
  const root = createRoot(el)

  const searchParams = new URLSearchParams(window.location.search)
  const ledgerCaseId = searchParams.get('ledger')
  const tasksCaseId = searchParams.get('tasks')

  if (window.location.pathname.startsWith('/editor/')) {
    // Reset the html { zoom: 1.2 } from index.css — OO DS needs unscaled coordinates
    document.documentElement.style.zoom = '1'
    root.render(<EditorPage />)
  } else if (ledgerCaseId || searchParams.get('finance')) {
    const financeCaseId = searchParams.get('finance')
    const storedToken = localStorage.getItem('token') ?? ''
    if (!storedToken) {
      root.render(
        <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#64748b' }}>
          Please log in to Canary first, then reopen this tab.
        </div>,
      )
    } else if (financeCaseId) {
      root.render(
        <StrictMode>
          <AppErrorBoundary>
            <DialogProvider>
              <FinanceStandalone caseId={financeCaseId} token={storedToken} />
            </DialogProvider>
          </AppErrorBoundary>
        </StrictMode>,
      )
    } else {
      root.render(
        <StrictMode>
          <AppErrorBoundary>
            <DialogProvider>
              <LedgerStandalone caseId={ledgerCaseId!} token={storedToken} />
            </DialogProvider>
          </AppErrorBoundary>
        </StrictMode>,
      )
    }
  } else if (tasksCaseId) {
    const storedToken = localStorage.getItem('token') ?? ''
    if (!storedToken) {
      root.render(
        <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#64748b' }}>
          Please log in to Canary first, then reopen this tab.
        </div>,
      )
    } else {
      root.render(
        <StrictMode>
          <AppErrorBoundary>
            <DialogProvider>
              <App initialTasksCaseFilter={tasksCaseId} />
            </DialogProvider>
          </AppErrorBoundary>
        </StrictMode>,
      )
    }
  } else {
    root.render(
      <StrictMode>
        <AppErrorBoundary>
          <DialogProvider>
            <App />
          </DialogProvider>
        </AppErrorBoundary>
      </StrictMode>,
    )
  }
}

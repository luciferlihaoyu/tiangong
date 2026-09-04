import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  componentStack: string | null
  /** 崩溃时间戳，用于在控制台中关联日志 */
  caughtAt: number | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, componentStack: null, caughtAt: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error, caughtAt: Date.now() }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // 保留 componentStack 到 state 以便在兜底页里展示
    this.setState({ componentStack: errorInfo.componentStack ?? null })
    // 同时打 console 方便开发者复现
    console.error('[ErrorBoundary] caught at', new Date().toISOString(), error, errorInfo)
  }

  /** 一键复制诊断信息：message + stack + componentStack，粘贴给 dsh 即可定位 */
  copyDiagnostic = async () => {
    const { error, componentStack, caughtAt } = this.state
    const text = [
      `【天宫渲染错误诊断】`,
      `时间: ${caughtAt ? new Date(caughtAt).toISOString() : 'unknown'}`,
      `URL: ${typeof window !== 'undefined' ? window.location.href : 'n/a'}`,
      `Message: ${error?.message ?? ''}`,
      ``,
      `--- error.stack ---`,
      error?.stack ?? '(no stack)',
      ``,
      `--- componentStack (最近组件在最上) ---`,
      componentStack ?? '(no componentStack)',
      ``,
      `--- userAgent ---`,
      typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a',
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      this.setState({ copied: true } as any)
      window.setTimeout(() => this.setState({ copied: false } as any), 2000)
    } catch (e) {
      console.warn('clipboard write failed:', e)
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const { error, componentStack, caughtAt } = this.state
    const ts = caughtAt ? new Date(caughtAt).toISOString().replace('T', ' ').slice(0, 19) : ''
    const copied = (this.state as any).copied as boolean | undefined

    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        backgroundColor: '#050508',
        color: '#ff8a8a',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '24px',
        textAlign: 'left',
        overflow: 'auto',
      }}>
        <div style={{ maxWidth: 880, width: '100%' }}>
          <h1 style={{ fontSize: 20, color: '#ff6b6b', margin: '0 0 8px 0' }}>渲染错误</h1>
          <p style={{ fontSize: 12, color: '#9aa', margin: '0 0 4px 0' }}>{ts} · {typeof window !== 'undefined' ? window.location.pathname : ''}</p>
          <p style={{ fontSize: 14, color: '#ff8a8a', margin: '0 0 16px 0', wordBreak: 'break-word' }}>
            {error?.message || 'Unknown error'}
          </p>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <button
              onClick={this.copyDiagnostic}
              style={{
                padding: '8px 16px', backgroundColor: '#1f6feb', color: '#fff',
                border: '1px solid #1f6feb', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 12,
              }}
            >
              {copied ? '✓ 已复制诊断信息' : '复制诊断信息（粘贴给 dsh 定位）'}
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 16px', backgroundColor: '#333', color: '#fff',
                border: '1px solid #555', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 12,
              }}
            >
              重新加载
            </button>
          </div>

          {componentStack && (
            <details open style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', color: '#9aa', fontSize: 12, marginBottom: 6 }}>
                组件栈（componentStack）— 最近的组件在最上方
              </summary>
              <pre style={{
                fontSize: 11, lineHeight: 1.5, color: '#cfd',
                backgroundColor: 'rgba(255,255,255,0.03)',
                border: '1px solid #222', borderRadius: 4,
                padding: 12, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                margin: 0,
              }}>{componentStack.trim()}</pre>
            </details>
          )}

          {error?.stack && (
            <details style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', color: '#9aa', fontSize: 12, marginBottom: 6 }}>
                JS 栈（error.stack）
              </summary>
              <pre style={{
                fontSize: 11, lineHeight: 1.5, color: '#aaa',
                backgroundColor: 'rgba(255,255,255,0.02)',
                border: '1px solid #222', borderRadius: 4,
                padding: 12, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                margin: 0,
              }}>{error.stack}</pre>
            </details>
          )}
        </div>
      </div>
    )
  }
}

import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallbackTitle?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary caught error]:', error, errorInfo)
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  handleClearAndReload = () => {
    try {
      sessionStorage.clear()
    } catch {}
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          dir="rtl"
          className="min-h-screen w-full flex items-center justify-center p-6 bg-slate-50 font-sans"
        >
          <div className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-slate-200 p-8 text-center">
            <div className="w-16 h-16 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center text-3xl mx-auto mb-4">
              ⚠️
            </div>
            <h2 className="text-lg font-black text-slate-800 mb-2">
              {this.props.fallbackTitle || 'خطایی در نمایش صفحه رخ داد'}
            </h2>
            <p className="text-sm text-slate-500 mb-6 leading-relaxed">
              ارتباط دستگاه یا اجرای بخشی از برنامه با وقفه مواجه شد. می‌توانید صفحه را دوباره باز کنید.
            </p>
            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={this.handleReload}
                className="w-full py-3 px-4 rounded-xl text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white transition-colors cursor-pointer shadow-xs"
              >
                بارگذاری مجدد صفحه
              </button>
              <button
                type="button"
                onClick={this.handleClearAndReload}
                className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer"
              >
                بارگذاری مجدد و تازه‌سازی حافظه موقت
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

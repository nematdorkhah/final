import { useState, useEffect } from 'react'

export default function LoadingScreen({
  message = 'در حال بارگذاری اطلاعات...',
  error = null,
  onRetry,
  onLogout,
}: {
  message?: string
  error?: string | null
  onRetry?: () => void
  onLogout?: () => void
}) {
  const [tookTooLong, setTookTooLong] = useState(false)

  // If loading takes more than 5 seconds, surface retry controls so the user is never stuck
  useEffect(() => {
    const timer = setTimeout(() => {
      setTookTooLong(true)
    }, 5000)
    return () => clearTimeout(timer)
  }, [])

  const hasIssue = Boolean(error) || tookTooLong

  return (
    <div
      dir="rtl"
      className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto"
    >
      {/* Central Pulsing / Alert Icon */}
      <div className="relative w-20 h-20 flex items-center justify-center mb-5">
        {!error && (
          <>
            <div className="absolute inset-0 rounded-full bg-blue-500/20 animate-ping opacity-75" />
            <div className="absolute -inset-1 rounded-full border-2 border-transparent border-t-blue-600 border-r-sky-400 animate-spin" />
          </>
        )}
        <div
          className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shadow-md border ${
            error
              ? 'bg-rose-50 border-rose-300 text-rose-600'
              : 'bg-gradient-to-br from-slate-900 to-indigo-950 border-blue-500/40 text-white'
          }`}
        >
          {error ? '⚠️' : '✨'}
        </div>
      </div>

      {/* Title */}
      <h3 className="text-base sm:text-lg font-black text-slate-900 mb-1 tracking-tight">
        {error ? 'خطا در بارگذاری اطلاعات' : message}
      </h3>

      {/* Description / Error message */}
      <p className="text-xs sm:text-sm text-slate-500 max-w-xs leading-relaxed mb-4">
        {error
          ? error
          : tookTooLong
          ? 'اتصال به سرور یا پایگاه داده بیش از حد معمول به طول انجامید. می‌توانید مجدداً تلاش کنید.'
          : 'لطفاً چند لحظه شکیبا باشید...'}
      </p>

      {/* Shimmer Bar when still loading without issue */}
      {!hasIssue && (
        <div className="w-36 h-1.5 bg-slate-200 rounded-full overflow-hidden relative">
          <div className="absolute top-0 bottom-0 w-1/2 bg-gradient-to-r from-blue-600 to-sky-400 rounded-full animate-[shimmerBar_1.5s_ease-in-out_infinite]" />
        </div>
      )}

      {/* Action Buttons if took long or error */}
      {hasIssue && (
        <div className="flex flex-col sm:flex-row items-center gap-2.5 mt-2 w-full max-w-xs">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="w-full flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl text-xs sm:text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-xs transition-colors cursor-pointer"
            >
              <span>🔄</span>
              <span>تلاش مجدد</span>
            </button>
          )}

          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="w-full flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl text-xs sm:text-sm font-bold bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 transition-colors cursor-pointer shadow-2xs"
            >
              <span>🚪</span>
              <span>خروج / بازگشت</span>
            </button>
          )}

          {!onRetry && !onLogout && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl text-xs sm:text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-xs transition-colors cursor-pointer"
            >
              <span>🔄</span>
              <span>بارگذاری مجدد صفحه</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

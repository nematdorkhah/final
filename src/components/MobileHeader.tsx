import SchoolLogo from './SchoolLogo'

export default function MobileHeader({
  title,
  subtitle,
  userBadge,
  dateLabel,
  onLogout,
  onAction,
  actionLabel,
  actionIcon,
}: {
  title: string
  subtitle?: string
  userBadge?: string
  dateLabel?: string
  onLogout?: () => void
  onAction?: () => void
  actionLabel?: string
  actionIcon?: string
}) {
  return (
    <header className="sticky top-0 z-40 w-full bg-white/95 backdrop-blur-md border-b border-slate-200/90 shadow-2xs">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between gap-2.5">
        {/* Right side (RTL start): School logo & Titles */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-blue-50 border border-blue-200/80 flex items-center justify-center shrink-0 shadow-2xs">
            <SchoolLogo size={20} />
          </div>
          <div className="min-w-0 flex items-baseline gap-1.5 sm:gap-2">
            <h1 className="text-xs sm:text-sm font-black text-slate-900 truncate tracking-tight">
              {title}
            </h1>
            {subtitle && (
              <span className="text-[10px] sm:text-[11px] text-slate-500 font-medium truncate">
                · {subtitle}
              </span>
            )}
          </div>
        </div>

        {/* Left side (RTL end): Badges, Date, Action, Logout */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {userBadge && (
            <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
              {userBadge}
            </span>
          )}

          {dateLabel && (
            <span className="hidden md:inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
              📅 {dateLabel}
            </span>
          )}

          {onAction && (
            <button
              type="button"
              className="p-1 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200 transition-colors cursor-pointer"
              onClick={onAction}
              title={actionLabel}
            >
              {actionIcon || '⚙️'}
            </button>
          )}

          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] sm:text-xs font-bold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 hover:border-rose-300 transition-all cursor-pointer shadow-2xs"
              title="خروج از حساب کاربری"
            >
              <span className="text-xs">🚪</span>
              <span>خروج</span>
            </button>
          )}
        </div>
      </div>
    </header>
  )
}

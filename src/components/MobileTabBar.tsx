interface TabItem {
  id: string
  label: string
  icon: string
  badge?: number | string
}

export default function MobileTabBar({
  tabs,
  activeTab,
  onChange,
  studentName,
}: {
  tabs: TabItem[]
  activeTab: string
  onChange: (id: string) => void
  studentName?: string
}) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-[9999] flex flex-col pointer-events-auto select-none"
      aria-label="ناوبری اصلی برنامه"
    >
      {/* لایه ۱: نوار دکمه‌های اصلی ناوبری (کاملاً بالاتر از نشان Netlify) */}
      <div className="w-full bg-white/98 backdrop-blur-md border-t border-slate-200/90 shadow-[0_-4px_24px_rgba(0,0,0,0.08)]">
        <div className="max-w-2xl mx-auto px-2 py-1.5 flex items-center justify-around gap-1">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  onChange(tab.id)
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
                className={`relative flex-1 flex flex-col items-center justify-center py-1.5 px-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  isActive
                    ? 'text-blue-600 bg-blue-50/90 font-black'
                    : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50 font-medium'
                }`}
              >
                <div className="relative inline-flex items-center justify-center">
                  <span className="text-xl sm:text-2xl leading-none">{tab.icon}</span>
                  {Boolean(tab.badge) && (
                    <span className="absolute -top-1 -right-2 bg-rose-600 text-white text-[10px] font-black px-1.5 py-0.2 rounded-full min-w-4 text-center shadow-xs">
                      {tab.badge}
                    </span>
                  )}
                </div>
                <span className="mt-1 tracking-tight truncate max-w-full">
                  {tab.label}
                </span>
                {isActive && (
                  <div className="w-6 h-1 bg-blue-600 rounded-full mt-0.5" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* لایه ۲: نوار پس‌زمینه پایینی همرنگ با کپسول Netlify (ادغام بصری و تضمین فاصله حداقل ۴۵ پیکسلی) */}
      <div className="w-full bg-[#0e1e25] text-slate-400 border-t border-[#1a2f38] px-4 py-2.5 min-h-[46px] pb-[max(0.6rem,env(safe-area-inset-bottom,0px))] flex items-center justify-between text-[11px] font-medium">
        <div className="flex items-center gap-1.5 text-slate-300">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>دبستان حضرت قائم (عج)</span>
        </div>
        <div className="flex items-center gap-1 text-sky-300 font-bold text-xs truncate max-w-[55%]">
          <span className="text-[13px]">👤</span>
          <span className="truncate">{studentName || 'دانش‌آموز پایه ششم'}</span>
        </div>
      </div>
    </nav>
  )
}

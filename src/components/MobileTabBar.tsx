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
    <>
      {/* ۱. نوار اصلی منوی سفید (دقیقاً روی سقف نوار مشکی، ارتفاع bottom-[56px] و z-40) */}
      <nav
        className="fixed bottom-[56px] left-0 right-0 w-full z-40 bg-white border-t border-slate-200/90 shadow-md select-none pointer-events-auto"
        aria-label="ناوبری اصلی برنامه"
      >
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
      </nav>

      {/* ۲. نوار فوتر کاملاً مشکی چسبیده به انتهای صفحه (ارتفاع ثابت ۵۶ پیکسل، z-30 و bottom-0) */}
      <div
        className="fixed bottom-0 left-0 right-0 w-full h-[56px] z-30 bg-[#0e1e25] text-slate-300 border-t border-slate-800/80 px-4 flex items-center justify-between text-[11px] font-medium select-none pointer-events-auto"
        aria-label="فوتر پایین صفحه"
      >
        <div className="flex items-center gap-2 text-slate-300">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span className="font-bold tracking-tight">دبستان حضرت قائم (عج)</span>
        </div>
        <div className="flex items-center gap-1.5 text-sky-300 font-bold text-xs truncate max-w-[55%]">
          <span className="text-[13px]">👤</span>
          <span className="truncate">{studentName || 'دانش‌آموز پایه ششم'}</span>
        </div>
      </div>
    </>
  )
}

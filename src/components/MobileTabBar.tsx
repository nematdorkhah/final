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
}: {
  tabs: TabItem[]
  activeTab: string
  onChange: (id: string) => void
}) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 shadow-lg"
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
              className={`relative flex-1 flex flex-col items-center justify-center py-1 px-2 rounded-xl text-xs font-bold transition-all ${
                isActive
                  ? 'text-blue-600 bg-blue-50/80 font-black'
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
  )
}

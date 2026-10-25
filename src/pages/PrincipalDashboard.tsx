import TeacherDashboard from './TeacherDashboard'

interface PrincipalDashboardProps {
  principalPassword?: string
  onLogout: () => void
}

export default function PrincipalDashboard({
  principalPassword = 'khalili100',
  onLogout,
}: PrincipalDashboardProps) {
  return (
    <div dir="rtl" className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Principal Management Header Banner */}
      <div className="sticky top-0 z-50 bg-gradient-to-r from-slate-900 via-indigo-950 to-indigo-900 text-white border-b-2 border-indigo-400 px-4 py-2.5 shadow-md">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 sm:gap-3 flex-wrap">
            <span className="text-xl">🏛️</span>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs sm:text-sm font-black">
                سامانه نظارت و مدیریت مدرسه — <strong className="font-bold text-indigo-200">دبستان حضرت قائم (عج)</strong>
              </span>
              <span className="bg-white/15 text-indigo-100 px-2 py-0.5 rounded-full text-[11px] font-bold border border-white/20">
                پنل مدیر: جناب آقای خلیلی
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-xs transition-colors cursor-pointer shrink-0"
            title="خروج از حساب مدیریت"
          >
            <span>خروج مدیریت</span>
            <span>🚪</span>
          </button>
        </div>
      </div>

      {/* Main Dashboard with full supervisory access */}
      <div className="flex-1">
        <TeacherDashboard
          teacherPassword={principalPassword}
          onLogout={onLogout}
        />
      </div>
    </div>
  )
}

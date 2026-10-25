import { toPersianDigits } from '../utils/persianNumbers'

export default function KpiCards({
  students,
  attendanceToday,
  homeworkPosts,
  submissions,
  grades,
  statsRows,
  weakSubjects,
}: {
  students: any[]
  attendanceToday: Record<string, string>
  homeworkPosts: any[]
  submissions: any[]
  grades: any[]
  statsRows: any[]
  weakSubjects: Array<{ subject: string; avg: number }>
}) {
  const total = students.length
  const presentToday = students.filter((s) => attendanceToday[s.id] === 'present').length
  const lateToday = students.filter((s) => attendanceToday[s.id] === 'late').length
  const unmarkedToday = Math.max(0, total - presentToday - lateToday)

  const pendingHomework = homeworkPosts.reduce((sum, p) => {
    const done = submissions.filter((s) => s.post_id === p.id).length
    return sum + Math.max(0, total - done)
  }, 0)

  const classAvg = grades.length
    ? grades.reduce((sum: number, g: any) => sum + (g.score / g.max_score) * 20, 0) / grades.length
    : null

  const ranked = [...statsRows].filter((r) => r.avg !== null).sort((a, b) => b.avg - a.avg)
  const best = ranked[0]
  const worst = ranked[ranked.length - 1]

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* 1. Total Students Card */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-4.5 shadow-xs flex flex-col justify-between hover:shadow-sm transition-all">
        <div className="flex items-center justify-between">
          <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-xl shrink-0">
            👥
          </div>
          <span className="text-xs font-bold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full border border-slate-200">
            کل کلاس
          </span>
        </div>
        <div className="mt-3">
          <div className="text-2xl font-black text-slate-900 tracking-tight">
            {toPersianDigits(total)}{' '}
            <span className="text-xs font-medium text-slate-500">نفر</span>
          </div>
          <div className="text-xs font-medium text-slate-500 mt-1">
            دانش‌آموزان پایه ششم
          </div>
        </div>
      </div>

      {/* 2. Attendance Today Card */}
      <div
        className="bg-white rounded-2xl border border-slate-200/90 p-4.5 shadow-xs flex flex-col justify-between hover:shadow-sm transition-all cursor-pointer"
        onClick={() => document.getElementById('att-section')?.scrollIntoView({ behavior: 'smooth' })}
      >
        <div className="flex items-center justify-between">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-xl shrink-0">
            ✅
          </div>
          <span
            className={`text-xs font-bold px-2.5 py-1 rounded-full border ${
              lateToday > 0
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
            }`}
          >
            {lateToday > 0 ? `${toPersianDigits(lateToday)} تاخیر` : 'بدون تاخیر'}
          </span>
        </div>
        <div className="mt-3">
          <div className="text-2xl font-black text-emerald-700 tracking-tight">
            {toPersianDigits(presentToday)}{' '}
            <span className="text-xs font-medium text-slate-500">
              از {toPersianDigits(total)} حاضر
            </span>
          </div>
          <div className="text-xs font-medium text-slate-500 mt-1">
            {unmarkedToday > 0
              ? `${toPersianDigits(unmarkedToday)} نفر نامشخص (کلیک جهت ثبت)`
              : 'حضور و غیاب امروز کامل است'}
          </div>
        </div>
      </div>

      {/* 3. Pending Homework Card */}
      <div
        className="bg-white rounded-2xl border border-slate-200/90 p-4.5 shadow-xs flex flex-col justify-between hover:shadow-sm transition-all cursor-pointer"
        onClick={() => document.getElementById('hw-status-section')?.scrollIntoView({ behavior: 'smooth' })}
      >
        <div className="flex items-center justify-between">
          <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center text-xl shrink-0">
            ⏱️
          </div>
          <span
            className={`text-xs font-bold px-2.5 py-1 rounded-full border ${
              pendingHomework > 0
                ? 'bg-rose-50 text-rose-700 border-rose-200'
                : 'bg-slate-100 text-slate-600 border-slate-200'
            }`}
          >
            تکالیف در جریان
          </span>
        </div>
        <div className="mt-3">
          <div className="text-2xl font-black text-rose-700 tracking-tight">
            {toPersianDigits(pendingHomework)}{' '}
            <span className="text-xs font-medium text-slate-500">مورد</span>
          </div>
          <div className="text-xs font-medium text-slate-500 mt-1">
            تکلیف بررسی یا تحویل‌نشده
          </div>
        </div>
      </div>

      {/* 4. Class Average Grade Card */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-4.5 shadow-xs flex flex-col justify-between hover:shadow-sm transition-all">
        <div className="flex items-center justify-between">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-xl shrink-0">
            📈
          </div>
          <span className="text-xs font-bold text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-200">
            معدل کل
          </span>
        </div>
        <div className="mt-3">
          <div className="text-2xl font-black text-indigo-700 tracking-tight">
            {classAvg !== null ? toPersianDigits(classAvg.toFixed(1)) : '—'}{' '}
            <span className="text-xs font-medium text-slate-500">/ ۲۰</span>
          </div>
          <div className="text-xs font-medium text-slate-500 mt-1">
            میانگین ارزیابی‌های ثبت‌شده
          </div>
        </div>
      </div>

      {/* Weak Subjects Banner */}
      {weakSubjects.length > 0 && (
        <div className="col-span-1 sm:col-span-2 lg:col-span-4 bg-amber-50/70 border border-amber-200 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">🎯</span>
            <div className="font-bold text-amber-900 text-sm">
              درس‌های نیازمند تمرین و تقویت بیشتر:
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {weakSubjects.map((w) => (
              <span
                key={w.subject}
                className="bg-white text-amber-900 border border-amber-300 text-xs font-bold px-2.5 py-1 rounded-lg shadow-xs"
              >
                {w.subject}: {toPersianDigits(w.avg.toFixed(1))} از ۲۰
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Best & Needs Attention Banner */}
      {best && worst && best.id !== worst.id && (
        <div className="col-span-1 sm:col-span-2 lg:col-span-4 bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="text-xl">🏆</span>
              <span className="text-sm font-bold text-slate-800">پیشتاز کلاس: {best.name}</span>
              <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-black px-2 py-0.5 rounded-full">
                معدل {toPersianDigits(best.avg?.toFixed(1))}
              </span>
            </div>
            <div className="flex items-center gap-2.5">
              <span className="text-xl">💡</span>
              <span className="text-sm font-bold text-slate-800">پشتیبانی ویژه: {worst.name}</span>
              <span className="bg-rose-50 text-rose-700 border border-rose-200 text-xs font-black px-2 py-0.5 rounded-full">
                معدل {toPersianDigits(worst.avg?.toFixed(1))}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

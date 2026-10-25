import { useMemo, useState } from 'react'
import { toPersianDigits } from '../utils/persianNumbers'
import { sortByLastName, normalizePersianText } from '../utils/persianSort'

export default function Gradebook({
  students,
  grades,
  attendanceRows,
  onSelectStudent,
  onRetry,
}: {
  students: any[]
  grades: any[]
  attendanceRows: any[]
  onSelectStudent: (id: string) => void
  onRetry?: () => void
}) {
  const [filterAtRisk, setFilterAtRisk] = useState(false)
  const [search, setSearch] = useState('')
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards')

  const subjects = useMemo(() => Array.from(new Set(grades.map((g) => g.subject))), [grades])

  const sortedStudents = useMemo(() => sortByLastName(students, 'full_name'), [students])

  const studentRows = useMemo(() => {
    return sortedStudents.map((st) => {
      const stGrades = grades.filter((g) => g.student_id === st.id)
      const stAttendance = attendanceRows.filter((a) => a.student_id === st.id)

      const totalNormalized = stGrades.reduce((acc, g) => acc + (g.score / g.max_score) * 20, 0)
      const gpa = stGrades.length ? (totalNormalized / stGrades.length).toFixed(1) : null

      const sortedGrades = [...stGrades].sort(
        (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
      )
      let isDropping = false
      if (sortedGrades.length >= 3) {
        const norm = (g: any) => (g.score / g.max_score) * 20
        const last = norm(sortedGrades[sortedGrades.length - 1])
        const prev = norm(sortedGrades[sortedGrades.length - 2])
        const beforePrev = norm(sortedGrades[sortedGrades.length - 3])
        if (last < prev && prev < beforePrev) isDropping = true
      }

      const absentCount = stAttendance.filter((a) => a.status === 'absent').length
      const atRisk = isDropping || (gpa !== null && Number(gpa) < 12) || absentCount >= 3

      return { ...st, gpa, atRisk, isDropping, absentCount, gradesBySubject: stGrades }
    })
  }, [sortedStudents, grades, attendanceRows])

  const filtered = useMemo(() => {
    let list = studentRows
    if (filterAtRisk) {
      list = list.filter((s) => s.atRisk)
    }
    if (search.trim()) {
      const q = normalizePersianText(search)
      list = list.filter((s) =>
        normalizePersianText(s.full_name || '').includes(q) ||
        (s.id || '').includes(search.trim())
      )
    }
    return list
  }, [studentRows, filterAtRisk, search])

  const atRiskCount = studentRows.filter((s) => s.atRisk).length

  return (
    <div className="w-full">
      {/* Search & Mode Switcher Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 mb-4">
        <div className="relative flex-1">
          <input
            type="text"
            className="w-full px-3.5 py-2 pl-8 rounded-xl border border-slate-200 text-xs sm:text-sm bg-white focus:outline-hidden focus:border-blue-500 transition-colors shadow-2xs"
            placeholder="🔍 جستجوی نام دانش‌آموز..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold p-1 cursor-pointer"
              title="پاک کردن جستجو"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
              filterAtRisk
                ? 'bg-amber-100 text-amber-900 border-amber-300 shadow-2xs'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
            onClick={() => setFilterAtRisk(!filterAtRisk)}
          >
            {filterAtRisk ? '✓ فیلتر نیازمند توجه' : `⚠️ نیازمند توجه (${toPersianDigits(atRiskCount)})`}
          </button>

          <button
            type="button"
            className="px-3 py-1.5 rounded-xl text-xs font-bold bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 transition-all cursor-pointer shadow-2xs"
            onClick={() => setViewMode(viewMode === 'cards' ? 'table' : 'cards')}
          >
            {viewMode === 'cards' ? '📊 جدول کامل' : '🗂 نمای کارتی'}
          </button>
        </div>
      </div>

      {students.length === 0 ? (
        <div className="text-center py-5 px-4 bg-white border border-slate-200 rounded-xl max-w-sm mx-auto my-4 shadow-2xs">
          <span className="text-2xl block mb-1">📋</span>
          <h4 className="text-xs sm:text-sm font-bold text-slate-800 mb-1">
            دفتر نمرات دانش‌آموزان در دسترس نیست
          </h4>
          <p className="text-[11px] text-slate-500 mb-2.5">
            جهت بارگذاری مجدد اطلاعات از سرور دکمه زیر را لمس فرمایید.
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white transition-colors cursor-pointer shadow-xs"
            >
              <span>🔄</span>
              <span>تلاش مجدد</span>
            </button>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-4 px-4 bg-amber-50/70 border border-amber-200/80 rounded-xl max-w-sm mx-auto my-4 shadow-2xs">
          <span className="text-xl block mb-1">🔍</span>
          <h4 className="text-xs sm:text-sm font-bold text-slate-800 mb-0.5">
            {search.trim()
              ? `دانش‌آموزی با نام «${search}» پیدا نشد`
              : 'دانش‌آموزی با فیلتر انتخابی یافت نشد'}
          </h4>
          <p className="text-[11px] text-slate-500 mb-2">
            برای مشاهده همه، جستجو یا فیلتر را پاک کنید.
          </p>
          {(search.trim() || filterAtRisk) && (
            <button
              type="button"
              onClick={() => {
                setSearch('')
                setFilterAtRisk(false)
              }}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold bg-white text-slate-700 border border-slate-300 hover:bg-slate-100 transition-colors cursor-pointer shadow-2xs"
            >
              ✕ پاک کردن فیلتر
            </button>
          )}
        </div>
      ) : null}

      {/* Cards View (Default Mobile UX) */}
      {viewMode === 'cards' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {filtered.map((st) => (
            <div
              key={st.id}
              className={`bg-white rounded-2xl border ${
                st.atRisk ? 'border-amber-300 bg-amber-50/15' : 'border-slate-200/90'
              } p-4 shadow-2xs hover:shadow-xs hover:border-blue-400 transition-all cursor-pointer flex flex-col justify-between`}
              onClick={() => onSelectStudent(st.id)}
            >
              <div>
                <div className="flex items-center justify-between gap-3 mb-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-700 border border-blue-200 flex items-center justify-center font-black text-sm shrink-0">
                      {st.full_name.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <h4 className="text-sm font-black text-slate-900 truncate">{st.full_name}</h4>
                      <div className="text-[11px] mt-0.5">
                        {st.atRisk ? (
                          <span className="text-amber-700 font-bold">
                            {st.isDropping ? '⚠️ افت نمره' : st.absentCount >= 3 ? '🔴 غیبت بالا' : '🟡 نمرات پایین'}
                          </span>
                        ) : (
                          <span className="text-emerald-700 font-bold">🟢 وضعیت عادی</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1 text-center shrink-0">
                    <div className="text-sm font-black text-slate-900 leading-tight">
                      {st.gpa ? toPersianDigits(st.gpa) : '—'}
                    </div>
                    <div className="text-[10px] text-slate-500 font-medium">معدل</div>
                  </div>
                </div>

                {/* Subject Mini Chips */}
                <div className="flex flex-wrap gap-1.5 my-2">
                  {subjects.slice(0, 4).map((sub) => {
                    const subGrades = st.gradesBySubject.filter((g: any) => g.subject === sub)
                    const subAvg = subGrades.length
                      ? (subGrades.reduce((a: number, b: any) => a + (b.score / b.max_score) * 20, 0) / subGrades.length).toFixed(1)
                      : null
                    return (
                      <div key={sub} className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md text-[11px] font-bold flex items-center gap-1">
                        <span>{sub}:</span>
                        <span className="text-blue-700">{subAvg ? toPersianDigits(subAvg) : '—'}</span>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="pt-2.5 mt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
                <span>تعداد نمرات: {toPersianDigits(st.gradesBySubject.length)}</span>
                <span className="text-blue-600 font-bold hover:underline">مشاهده پرونده ←</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Wide Table View with Smooth Horizontal Scroll */
        <div className="bg-white border border-slate-200 rounded-2xl overflow-x-auto shadow-2xs">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <th className="p-3 font-bold">دانش‌آموز</th>
                {subjects.map((sub: string) => (
                  <th key={sub} className="p-3 font-bold">{sub}</th>
                ))}
                <th className="p-3 font-bold">معدل کل</th>
                <th className="p-3 font-bold">وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((st) => (
                <tr
                  key={st.id}
                  onClick={() => onSelectStudent(st.id)}
                  className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 transition-colors ${
                    st.atRisk ? 'bg-amber-50/20' : ''
                  }`}
                >
                  <td className="p-3 font-bold text-slate-900">{st.full_name}</td>
                  {subjects.map((sub: string) => {
                    const subGrades = st.gradesBySubject.filter((g: any) => g.subject === sub)
                    const subAvg = subGrades.length
                      ? (subGrades.reduce((a: number, b: any) => a + (b.score / b.max_score) * 20, 0) / subGrades.length).toFixed(1)
                      : '—'
                    return <td key={sub} className="p-3 text-slate-700">{toPersianDigits(subAvg)}</td>
                  })}
                  <td className="p-3 font-black text-blue-600">
                    {st.gpa ? toPersianDigits(st.gpa) : '—'}
                  </td>
                  <td className="p-3">
                    {st.atRisk ? (
                      <span className="bg-amber-100 text-amber-800 text-[11px] font-bold px-2 py-0.5 rounded-full">
                        {st.isDropping ? '⚠️ افت نمره' : st.absentCount >= 3 ? '🔴 غیبت بالا' : '🟡 میانگین ضعیف'}
                      </span>
                    ) : (
                      <span className="bg-emerald-50 text-emerald-700 text-[11px] font-bold px-2 py-0.5 rounded-full">
                        🟢 عادی
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

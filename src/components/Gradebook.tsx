import { useMemo, useState } from 'react'
import { toPersianDigits } from '../utils/persianNumbers'
import { sortByLastName, normalizePersianText } from '../utils/persianSort'
import { isSameStudent } from '../classStudents'
import { roundScore2 } from '../utils/persianSemanticGrader'

function isGradedItem(g: any): boolean {
  return Boolean(
    g &&
      g.status !== 'pending_review' &&
      g.status !== 'pending_submission' &&
      g.score !== null &&
      g.score !== undefined
  )
}

function isPendingReviewItem(g: any): boolean {
  return Boolean(g && g.status === 'pending_review')
}

function normalizeTo20(g: any): number {
  const m = Number(g.max_score)
  const s = Number(g.score) || 0
  return m === 20 ? s : m > 0 ? (s / m) * 20 : s
}

export default function Gradebook({
  students,
  grades,
  attendanceRows,
  onSelectStudent,
  onRetry,
  loading = false,
  error = null,
}: {
  students: any[]
  grades: any[]
  attendanceRows: any[]
  onSelectStudent: (id: string) => void
  onRetry?: () => void
  loading?: boolean
  error?: string | null
}) {
  const [filterAtRisk, setFilterAtRisk] = useState(false)
  const [search, setSearch] = useState('')
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards')

  const subjects = useMemo(
    () => Array.from(new Set(grades.filter((g) => g?.subject).map((g) => g.subject))),
    [grades]
  )

  const sortedStudents = useMemo(() => sortByLastName(students, 'full_name'), [students])

  const studentRows = useMemo(() => {
    return sortedStudents.map((st) => {
      const stAllItems = grades.filter((g) => isSameStudent(g.student_id, st.id, g.student_name, st.full_name))
      const stGraded = stAllItems.filter(isGradedItem)
      const stPendingReview = stAllItems.filter(isPendingReviewItem)
      const stAttendance = attendanceRows.filter((a) => isSameStudent(a.student_id, st.id))

      const totalNormalized = stGraded.reduce((acc, g) => acc + normalizeTo20(g), 0)
      const gpa = stGraded.length ? String(roundScore2(totalNormalized / stGraded.length)) : null

      const sortedGrades = [...stGraded].sort(
        (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
      )
      let isDropping = false
      if (sortedGrades.length >= 3) {
        const last = normalizeTo20(sortedGrades[sortedGrades.length - 1])
        const prev = normalizeTo20(sortedGrades[sortedGrades.length - 2])
        const beforePrev = normalizeTo20(sortedGrades[sortedGrades.length - 3])
        if (last < prev && prev < beforePrev) isDropping = true
      }

      const absentCount = stAttendance.filter((a) => a.status === 'absent').length
      const atRisk = isDropping || (gpa !== null && Number(gpa) < 12) || absentCount >= 3

      return {
        ...st,
        gpa,
        atRisk,
        isDropping,
        absentCount,
        gradesBySubject: stGraded,
        pendingReviewItems: stPendingReview,
        pendingReviewCount: stPendingReview.length,
      }
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
      {/* Independent Error Banner for Grades Section */}
      {error && (
        <div className="mb-4 p-3.5 bg-rose-50 border border-rose-200 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shadow-2xs">
          <div className="flex items-center gap-2 text-xs font-bold text-rose-800">
            <span className="text-base">⚠️</span>
            <span>خطا در بارگذاری بخش نمرات: {error}</span>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white transition-colors cursor-pointer shrink-0"
            >
              <span>🔄</span>
              <span>تلاش دوباره</span>
            </button>
          )}
        </div>
      )}

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

      {/* Independent Loading Skeleton for Grades Section */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5" aria-label="در حال بارگذاری نمرات">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div
              key={idx}
              className="bg-white rounded-2xl border border-slate-200/90 p-4 shadow-2xs animate-pulse space-y-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-slate-200" />
                  <div className="space-y-1.5">
                    <div className="h-3.5 w-28 bg-slate-200 rounded" />
                    <div className="h-2.5 w-20 bg-slate-100 rounded" />
                  </div>
                </div>
                <div className="h-10 w-16 bg-slate-100 rounded-xl" />
              </div>
              <div className="flex gap-1.5">
                <div className="h-5 w-16 bg-slate-100 rounded-md" />
                <div className="h-5 w-16 bg-slate-100 rounded-md" />
              </div>
              <div className="h-3 w-full bg-slate-100 rounded" />
            </div>
          ))}
        </div>
      ) : students.length === 0 ? (
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
              <span>تلاش دوباره</span>
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
      ) : viewMode === 'cards' ? (
        /* Cards View (Default Mobile UX) */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {filtered.map((st) => (
            <div
              key={st.id}
              className={`bg-white rounded-2xl border ${
                st.atRisk
                  ? 'border-amber-300 bg-amber-50/15'
                  : st.pendingReviewCount > 0
                  ? 'border-amber-200/90'
                  : 'border-slate-200/90'
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
                      <div className="text-[11px] mt-0.5 flex flex-wrap items-center gap-1.5">
                        {st.atRisk ? (
                          <span className="text-amber-700 font-bold">
                            {st.isDropping ? '⚠️ افت نمره' : st.absentCount >= 3 ? '🔴 غیبت بالا' : '🟡 نمرات پایین'}
                          </span>
                        ) : (
                          <span className="text-emerald-700 font-bold">🟢 وضعیت عادی</span>
                        )}
                        {st.pendingReviewCount > 0 && (
                          <span className="bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 rounded-md text-[10px] font-bold">
                            ⏳ در انتظار تصحیح{st.pendingReviewCount > 1 ? ` (${toPersianDigits(st.pendingReviewCount)})` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1 text-center shrink-0">
                    <div className="text-sm font-black text-slate-900 leading-tight">
                      {st.gpa ? (
                        <>
                          {toPersianDigits(st.gpa)}{' '}
                          <span className="text-[10px] font-semibold text-slate-400">/ ۲۰</span>
                        </>
                      ) : st.pendingReviewCount > 0 ? (
                        <span className="text-[10px] font-bold text-amber-700">در انتظار تصحیح</span>
                      ) : (
                        <>
                          — <span className="text-[10px] font-semibold text-slate-400">/ ۲۰</span>
                        </>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-500 font-medium">معدل از ۲۰</div>
                  </div>
                </div>

                {/* Subject Mini Chips */}
                <div className="flex flex-wrap gap-1.5 my-2">
                  {subjects.slice(0, 4).map((sub) => {
                    const subGrades = st.gradesBySubject.filter((g: any) => g.subject === sub)
                    const subPending = st.pendingReviewItems.filter((g: any) => g.subject === sub)
                    const subAvg = subGrades.length
                      ? String(
                          roundScore2(
                            subGrades.reduce((a: number, b: any) => a + normalizeTo20(b), 0) /
                              subGrades.length
                          )
                        )
                      : null

                    return (
                      <div
                        key={sub}
                        className={`px-2 py-0.5 rounded-md text-[11px] font-bold flex items-center gap-1 ${
                          !subAvg && subPending.length > 0
                            ? 'bg-amber-50 text-amber-800 border border-amber-200'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        <span>{sub}:</span>
                        {subAvg ? (
                          <span className="text-blue-700">{toPersianDigits(subAvg)} / ۲۰</span>
                        ) : subPending.length > 0 ? (
                          <span className="text-amber-700">در انتظار تصحیح</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                        {subAvg && subPending.length > 0 && (
                          <span className="text-[10px] text-amber-700">(در انتظار تصحیح)</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="pt-2.5 mt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
                <span>
                  نمرات ثبت‌شده: {toPersianDigits(st.gradesBySubject.length)}
                  {st.pendingReviewCount > 0 ? ` · ${toPersianDigits(st.pendingReviewCount)} در انتظار تصحیح` : ''}
                </span>
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
                  <th key={sub} className="p-3 font-bold">{sub} (از ۲۰)</th>
                ))}
                <th className="p-3 font-bold">معدل کل (از ۲۰)</th>
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
                    const subPending = st.pendingReviewItems.filter((g: any) => g.subject === sub)
                    const subAvg = subGrades.length
                      ? String(
                          roundScore2(
                            subGrades.reduce((a: number, b: any) => a + normalizeTo20(b), 0) /
                              subGrades.length
                          )
                        )
                      : null
                    return (
                      <td key={sub} className="p-3 text-slate-700">
                        {subAvg ? (
                          <div className="flex items-center gap-1 flex-wrap">
                            <span>{toPersianDigits(subAvg)}</span>
                            {subPending.length > 0 && (
                              <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-1.5 py-0.5 rounded-md">
                                در انتظار تصحیح
                              </span>
                            )}
                          </div>
                        ) : subPending.length > 0 ? (
                          <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded-full">
                            در انتظار تصحیح
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    )
                  })}
                  <td className="p-3 font-black text-blue-600">
                    {st.gpa ? `${toPersianDigits(st.gpa)} / ۲۰` : '—'}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {st.pendingReviewCount > 0 && (
                        <span className="bg-amber-100 text-amber-800 border border-amber-300 text-[11px] font-bold px-2 py-0.5 rounded-full">
                          ⏳ در انتظار تصحیح{st.pendingReviewCount > 1 ? ` (${toPersianDigits(st.pendingReviewCount)})` : ''}
                        </span>
                      )}
                      {st.atRisk ? (
                        <span className="bg-amber-100 text-amber-800 text-[11px] font-bold px-2 py-0.5 rounded-full">
                          {st.isDropping ? '⚠️ افت نمره' : st.absentCount >= 3 ? '🔴 غیبت بالا' : '🟡 میانگین ضعیف'}
                        </span>
                      ) : st.pendingReviewCount === 0 ? (
                        <span className="bg-emerald-50 text-emerald-700 text-[11px] font-bold px-2 py-0.5 rounded-full">
                          🟢 عادی
                        </span>
                      ) : null}
                    </div>
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

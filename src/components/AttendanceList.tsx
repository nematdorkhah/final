import { useState, useMemo, useEffect } from 'react'
import { supabase } from '../supabaseClient'
import { todayISO } from '../useJalaliDate'
import { toPersianDigits } from '../utils/persianNumbers'
import { sortByLastName, normalizePersianText } from '../utils/persianSort'

export default function AttendanceList({
  students,
  attendanceToday,
  teacherPassword,
  onChanged,
}: {
  students: any[]
  attendanceToday: Record<string, string>
  teacherPassword: string
  onChanged: () => void
}) {
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [localAttendance, setLocalAttendance] = useState<Record<string, string>>(attendanceToday || {})

  // Synchronize when parent updates
  useEffect(() => {
    if (attendanceToday) {
      setLocalAttendance(attendanceToday)
    }
  }, [attendanceToday])

  const date = todayISO()

  const effectivePassword = teacherPassword || (() => {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('class_auth_session')
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed?.teacherPassword) return parsed.teacherPassword
          if (parsed?.principalPassword) return parsed.principalPassword
        }
      }
      if (typeof sessionStorage !== 'undefined') {
        return sessionStorage.getItem('teacherPassword') || '1234'
      }
    } catch {}
    return '1234'
  })()

  async function setStatus(studentId: string, status: 'present' | 'late' | 'absent') {
    setBusyId(studentId)
    const current = localAttendance[studentId]
    const nextStatus = current === status ? '' : status

    // Optimistic instant feedback so buttons change state with zero lag
    setLocalAttendance((prev) => ({
      ...prev,
      [studentId]: nextStatus,
    }))

    try {
      if (current === status) {
        // Toggle off if already selected
        await supabase.rpc('teacher_clear_attendance', {
          p_password: effectivePassword,
          p_student_id: studentId,
          p_date: date,
        })
      } else {
        await supabase.rpc('teacher_mark_attendance', {
          p_password: effectivePassword,
          p_student_id: studentId,
          p_date: date,
          p_status: status,
        })
      }
    } catch (err) {
      console.warn('Failed recording attendance to database:', err)
    } finally {
      setBusyId(null)
      onChanged()
    }
  }

  async function markAllPresent() {
    setBusyId('all')

    // Optimistic instant feedback for all students
    const nextMap: Record<string, string> = { ...localAttendance }
    for (const s of students) {
      nextMap[s.id] = 'present'
    }
    setLocalAttendance(nextMap)

    try {
      for (const s of students) {
        await supabase.rpc('teacher_mark_attendance', {
          p_password: effectivePassword,
          p_student_id: s.id,
          p_date: date,
          p_status: 'present',
        })
      }
    } catch (err) {
      console.warn('Failed marking all present:', err)
    } finally {
      setBusyId(null)
      onChanged()
    }
  }

  const counts = useMemo(() => {
    let present = 0
    let late = 0
    let absent = 0
    let unmarked = 0
    for (const s of students) {
      const st = localAttendance[s.id]
      if (st === 'present') present++
      else if (st === 'late') late++
      else if (st === 'absent') absent++
      else unmarked++
    }
    return { present, late, absent, unmarked }
  }, [students, localAttendance])

  const sortedStudents = useMemo(() => {
    return sortByLastName(students, 'full_name')
  }, [students])

  const filteredStudents = useMemo(() => {
    if (!search.trim()) return sortedStudents
    const query = normalizePersianText(search)
    return sortedStudents.filter((s) =>
      normalizePersianText(s.full_name || '').includes(query)
    )
  }, [sortedStudents, search])

  return (
    <div className="w-full max-w-full">
      {/* Top Banner & Quick Bulk Action */}
      <div className="mb-4">
        <button
          type="button"
          onClick={markAllPresent}
          disabled={busyId === 'all'}
          className="w-full py-3 px-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-black text-sm sm:text-base shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 active:scale-[0.99]"
        >
          <span className="text-lg">⚡</span>
          <span>{busyId === 'all' ? 'در حال ثبت همه دانش‌آموزان...' : 'ثبت سریع همه به عنوان حاضر'}</span>
        </button>
      </div>

      {/* Counters Pill Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-2.5 flex items-center justify-between shadow-2xs">
          <span className="text-xs font-bold text-emerald-800">حاضر:</span>
          <span className="font-black text-base text-emerald-700">{toPersianDigits(counts.present)}</span>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-2.5 flex items-center justify-between shadow-2xs">
          <span className="text-xs font-bold text-amber-800">با تاخیر:</span>
          <span className="font-black text-base text-amber-700">{toPersianDigits(counts.late)}</span>
        </div>
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-2.5 flex items-center justify-between shadow-2xs">
          <span className="text-xs font-bold text-rose-800">غایب:</span>
          <span className="font-black text-base text-rose-700">{toPersianDigits(counts.absent)}</span>
        </div>
        <div className="bg-slate-100 border border-slate-200 rounded-xl p-2.5 flex items-center justify-between shadow-2xs">
          <span className="text-xs font-bold text-slate-700">ثبت نشده:</span>
          <span className="font-black text-base text-slate-700">{toPersianDigits(counts.unmarked)}</span>
        </div>
      </div>

      {/* Search Input */}
      <div className="relative mb-4">
        <input
          type="text"
          className="w-full px-4 py-2.5 pl-9 rounded-xl border border-slate-300 text-xs sm:text-sm bg-white focus:outline-hidden focus:border-blue-500 shadow-2xs transition-colors"
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

      {/* Touch Attendance List */}
      <div className="space-y-2.5">
        {students.length === 0 ? (
          <div className="text-center py-5 px-4 bg-white border border-slate-200 rounded-xl max-w-sm mx-auto my-3 shadow-2xs">
            <span className="text-2xl block mb-1">📋</span>
            <h4 className="text-xs sm:text-sm font-bold text-slate-800 mb-1">
              اطلاعات دانش‌آموزان در دسترس نیست
            </h4>
            <p className="text-[11px] text-slate-500 mb-2.5">
              جهت بارگذاری مجدد اطلاعات از سرور دکمه زیر را لمس فرمایید.
            </p>
            <button
              type="button"
              onClick={onChanged}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white transition-colors cursor-pointer shadow-xs"
            >
              <span>🔄</span>
              <span>تلاش مجدد</span>
            </button>
          </div>
        ) : filteredStudents.length === 0 ? (
          <div className="text-center py-4 px-4 bg-amber-50/70 border border-amber-200/80 rounded-xl max-w-sm mx-auto my-3 shadow-2xs">
            <span className="text-xl block mb-1">🔍</span>
            <h4 className="text-xs sm:text-sm font-bold text-slate-800 mb-0.5">
              {search.trim()
                ? `دانش‌آموزی با نام «${search}» پیدا نشد`
                : 'موردی برای نمایش در این بخش وجود ندارد'}
            </h4>
            <p className="text-[11px] text-slate-500 mb-2">
              املا یا بخش دیگری از نام دانش‌آموز را برای جستجو وارد فرمایید.
            </p>
            {search.trim() && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold bg-white text-slate-700 border border-slate-300 hover:bg-slate-100 transition-colors cursor-pointer shadow-2xs"
              >
                ✕ پاک کردن جستجو
              </button>
            )}
          </div>
        ) : null}

        {filteredStudents.map((s, idx) => {
          const status = localAttendance[s.id]
          const isBusy = busyId === s.id || busyId === 'all'

          return (
            <div
              key={s.id}
              className={`p-3 sm:p-3.5 rounded-2xl border transition-all flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shadow-2xs ${
                status === 'present'
                  ? 'bg-emerald-50/70 border-emerald-300'
                  : status === 'late'
                  ? 'bg-amber-50/70 border-amber-300'
                  : status === 'absent'
                  ? 'bg-rose-50/70 border-rose-300'
                  : 'bg-white border-slate-200 hover:border-slate-300'
              }`}
            >
              {/* Student info */}
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-7 h-7 rounded-lg bg-slate-100 text-slate-700 font-mono text-xs font-bold flex items-center justify-center shrink-0 border border-slate-200">
                  {toPersianDigits(idx + 1)}
                </span>
                <span className="text-sm font-black text-slate-900 truncate">
                  {s.full_name}
                </span>
              </div>

              {/* 3 Large, Distinct Interactive Buttons */}
              <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center sm:gap-2 shrink-0">
                {/* Present button */}
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setStatus(s.id, 'present')}
                  className={`py-2 px-3 sm:px-3.5 rounded-xl text-xs font-black transition-all cursor-pointer flex items-center justify-center gap-1 shadow-2xs active:scale-95 ${
                    status === 'present'
                      ? 'bg-emerald-600 text-white ring-2 ring-emerald-500 ring-offset-1 shadow-xs'
                      : 'bg-white text-emerald-800 border border-emerald-300 hover:bg-emerald-50'
                  }`}
                  title="ثبت حاضر"
                >
                  <span className="text-xs">✓</span>
                  <span>حاضر</span>
                </button>

                {/* Late button */}
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setStatus(s.id, 'late')}
                  className={`py-2 px-3 sm:px-3.5 rounded-xl text-xs font-black transition-all cursor-pointer flex items-center justify-center gap-1 shadow-2xs active:scale-95 ${
                    status === 'late'
                      ? 'bg-amber-500 text-white ring-2 ring-amber-400 ring-offset-1 shadow-xs'
                      : 'bg-white text-amber-800 border border-amber-300 hover:bg-amber-50'
                  }`}
                  title="ثبت تاخیر"
                >
                  <span className="text-xs">⏳</span>
                  <span>تاخیر</span>
                </button>

                {/* Absent button */}
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setStatus(s.id, 'absent')}
                  className={`py-2 px-3 sm:px-3.5 rounded-xl text-xs font-black transition-all cursor-pointer flex items-center justify-center gap-1 shadow-2xs active:scale-95 ${
                    status === 'absent'
                      ? 'bg-rose-600 text-white ring-2 ring-rose-500 ring-offset-1 shadow-xs'
                      : 'bg-white text-rose-800 border border-rose-300 hover:bg-rose-50'
                  }`}
                  title="ثبت غایب"
                >
                  <span className="text-xs">✕</span>
                  <span>غایب</span>
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

import { useState, useMemo, useEffect, useCallback } from 'react'
import { supabase } from '../supabaseClient'
import { toPersianDigits } from '../utils/persianNumbers'
import { sortByLastName } from '../utils/persianSort'
import { tizhooshanTopicsData } from '../data/tizhooshanQuestions'
import { getStoredTeacherPassword } from '../services/geminiHybridService'

export interface TizhooshanProgressRow {
  student_id: string
  student_name?: string | null
  total_xp?: number | null
  gems?: number | null
  streak?: number | null
  hearts?: number | null
  unlocked_topic_index?: number | null
  completed_topics?: Record<string, any> | null
  completed_question_ids?: any[] | null
  wrong_question_ids?: any[] | null
  last_active_date?: string | null
  updated_at?: string | null
}

export interface StudentDuolingoData {
  studentId: string
  studentName: string
  totalXp: number
  gems: number
  streak: number
  hearts: number
  unlockedTopicIndex: number
  currentStep: number
  completedTopicsCount: number
  completedQuestionsCount: number
  wrongQuestionsCount: number
  lastActiveDate: string
  updatedAt: string | null
  lastActivityLabel: string
  hasStarted: boolean
}

export function formatTizhooshanLastActivity(
  updatedAt?: string | null,
  lastActiveDate?: string | null,
  hasStarted = false
): string {
  if (!hasStarted && !updatedAt && !lastActiveDate) {
    return 'هنوز شروع نکرده'
  }
  if (updatedAt) {
    const ts = Date.parse(updatedAt)
    if (Number.isFinite(ts)) {
      const diffMs = Math.max(0, Date.now() - ts)
      const diffMin = Math.floor(diffMs / 60000)
      if (diffMin < 1) return 'هم‌اکنون'
      if (diffMin < 60) return `${toPersianDigits(diffMin)} دقیقه پیش`
      const diffHr = Math.floor(diffMin / 60)
      if (diffHr < 24) return `${toPersianDigits(diffHr)} ساعت پیش`
      const diffDays = Math.floor(diffHr / 24)
      if (diffDays < 7) return `${toPersianDigits(diffDays)} روز پیش`
      try {
        return toPersianDigits(
          new Date(ts).toLocaleString('fa-IR', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        )
      } catch {
        // fall through
      }
    }
  }
  if (lastActiveDate && lastActiveDate.trim()) {
    const parsed = Date.parse(lastActiveDate)
    if (Number.isFinite(parsed)) {
      try {
        return toPersianDigits(new Date(parsed).toLocaleDateString('fa-IR'))
      } catch {
        // fall through
      }
    }
    return toPersianDigits(lastActiveDate)
  }
  return hasStarted ? 'فعال' : 'هنوز شروع نکرده'
}

export function buildTizhooshanStudentList(
  students: any[],
  rows: TizhooshanProgressRow[]
): StudentDuolingoData[] {
  const totalSteps = Math.max(1, tizhooshanTopicsData.length)
  const rowByStudentId = new Map<string, TizhooshanProgressRow>()
  for (const r of rows) {
    if (r?.student_id) {
      rowByStudentId.set(String(r.student_id), r)
    }
  }

  return students.map((s) => {
    const row = rowByStudentId.get(String(s.id))
    if (!row) {
      return {
        studentId: String(s.id),
        studentName: s.full_name || 'دانش‌آموز',
        totalXp: 0,
        gems: 25,
        streak: 0,
        hearts: 5,
        unlockedTopicIndex: 0,
        currentStep: 0,
        completedTopicsCount: 0,
        completedQuestionsCount: 0,
        wrongQuestionsCount: 0,
        lastActiveDate: '',
        updatedAt: null,
        lastActivityLabel: 'هنوز شروع نکرده',
        hasStarted: false,
      }
    }

    const totalXp = Math.max(0, Number(row.total_xp) || 0)
    const unlockedTopicIndex = Math.max(0, Math.min(totalSteps - 1, Number(row.unlocked_topic_index) || 0))
    const completedTopicsCount =
      row.completed_topics && typeof row.completed_topics === 'object'
        ? Object.keys(row.completed_topics).length
        : 0
    const completedQuestionsCount = Array.isArray(row.completed_question_ids)
      ? row.completed_question_ids.length
      : 0
    const wrongQuestionsCount = Array.isArray(row.wrong_question_ids)
      ? row.wrong_question_ids.length
      : 0

    const hasStarted =
      totalXp > 0 ||
      completedTopicsCount > 0 ||
      unlockedTopicIndex > 0 ||
      completedQuestionsCount > 0 ||
      wrongQuestionsCount > 0

    const currentStep = hasStarted
      ? Math.min(totalSteps, Math.max(completedTopicsCount, unlockedTopicIndex + 1))
      : 0

    const updatedAt = row.updated_at || null
    const lastActiveDate = row.last_active_date || ''

    return {
      studentId: String(s.id),
      studentName: s.full_name || row.student_name || 'دانش‌آموز',
      totalXp,
      gems: typeof row.gems === 'number' ? row.gems : 25,
      streak: Math.max(0, Number(row.streak) || 0),
      hearts: typeof row.hearts === 'number' ? row.hearts : 5,
      unlockedTopicIndex,
      currentStep,
      completedTopicsCount,
      completedQuestionsCount,
      wrongQuestionsCount,
      lastActiveDate,
      updatedAt,
      lastActivityLabel: formatTizhooshanLastActivity(updatedAt, lastActiveDate, hasStarted),
      hasStarted,
    }
  })
}

export function computeTizhooshanKpis(list: StudentDuolingoData[]) {
  const totalSteps = Math.max(1, tizhooshanTopicsData.length)
  const totalClassXp = list.reduce((sum, sp) => sum + (sp.totalXp || 0), 0)
  const activeStudents = list.filter((s) => s.hasStarted)
  const activeCount = activeStudents.length
  const avgStep =
    activeCount > 0
      ? Math.round((activeStudents.reduce((sum, sp) => sum + sp.currentStep, 0) / activeCount) * 10) / 10
      : 0

  return {
    totalClassXp,
    activeCount,
    avgStep,
    totalSteps,
  }
}

export default function TeacherDuolingoTracker({
  students,
  teacherPassword,
  externalProgressRows,
  externalRefreshing,
  externalError,
  onExternalRefresh,
  onClose,
}: {
  students: any[]
  teacherPassword?: string
  externalProgressRows?: TizhooshanProgressRow[]
  externalRefreshing?: boolean
  externalError?: string | null
  onExternalRefresh?: () => void
  onClose?: () => void
}) {
  const [search, setSearch] = useState('')
  const [sortField, setSortField] = useState<'xp' | 'step' | 'recent' | 'name'>('xp')
  const [internalRows, setInternalRows] = useState<TizhooshanProgressRow[]>([])
  const [internalRefreshing, setInternalRefreshing] = useState(false)
  const [internalError, setInternalError] = useState<string | null>(null)

  const usesExternalFeed = externalProgressRows !== undefined

  const fetchLiveProgress = useCallback(async () => {
    if (usesExternalFeed) {
      onExternalRefresh?.()
      return
    }
    const pwd = getStoredTeacherPassword(teacherPassword)
    if (!pwd) {
      setInternalError('ورود معلم منقضی شده است؛ برای مشاهده پیشرفت تیزهوشان دوباره وارد شوید.')
      setInternalRefreshing(false)
      return
    }
    setInternalRefreshing(true)
    setInternalError(null)
    try {
      const { data, error } = await supabase.rpc('teacher_list_tizhooshan', {
        p_password: pwd,
      })
      if (error) {
        setInternalError('خطا در دریافت اطلاعات پیشرفت تیزهوشان از سرور.')
        console.warn('teacher_list_tizhooshan error:', error)
      } else if (Array.isArray(data)) {
        setInternalRows(data as TizhooshanProgressRow[])
      }
    } catch (err) {
      setInternalError('خطا در ارتباط با سرور برای دریافت پیشرفت تیزهوشان.')
      console.warn('teacher_list_tizhooshan exception:', err)
    } finally {
      setInternalRefreshing(false)
    }
  }, [usesExternalFeed, onExternalRefresh, teacherPassword])

  // Fetch on mount & auto-refresh every 20 seconds when standalone
  useEffect(() => {
    if (usesExternalFeed) return
    void fetchLiveProgress()

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchLiveProgress()
      }
    }, 20000)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void fetchLiveProgress()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [usesExternalFeed, fetchLiveProgress])

  const progressRows = usesExternalFeed ? externalProgressRows || [] : internalRows
  const isRefreshing = usesExternalFeed ? Boolean(externalRefreshing) : internalRefreshing
  const loadError = usesExternalFeed ? externalError || null : internalError

  // Build real student progress list exclusively from Supabase teacher_list_tizhooshan rows
  const studentsProgress = useMemo(
    () => buildTizhooshanStudentList(students, progressRows),
    [students, progressRows]
  )

  // Real summary KPIs
  const { totalClassXp, activeCount, avgStep, totalSteps } = useMemo(
    () => computeTizhooshanKpis(studentsProgress),
    [studentsProgress]
  )

  const filtered = useMemo(() => {
    let list = studentsProgress.filter((s) =>
      s.studentName.toLowerCase().includes(search.trim().toLowerCase())
    )

    if (sortField === 'xp') {
      list.sort((a, b) => b.totalXp - a.totalXp || b.currentStep - a.currentStep)
    } else if (sortField === 'step') {
      list.sort((a, b) => b.currentStep - a.currentStep || b.totalXp - a.totalXp)
    } else if (sortField === 'recent') {
      list.sort((a, b) => {
        const ta = a.updatedAt ? Date.parse(a.updatedAt) || 0 : 0
        const tb = b.updatedAt ? Date.parse(b.updatedAt) || 0 : 0
        return tb - ta || b.totalXp - a.totalXp
      })
    } else {
      list = sortByLastName(list, 'studentName')
    }
    return list
  }, [studentsProgress, search, sortField])

  return (
    <div style={{ direction: 'rtl', padding: 4 }}>
      {/* Header Bar */}
      <div
        style={{
          background: 'linear-gradient(135deg, #1E1B4B 0%, #312E81 50%, #4338CA 100%)',
          borderRadius: 16,
          padding: '16px 20px',
          color: '#FFFFFF',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 32 }}>🦉</span>
            <div>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900, color: '#FFFFFF' }}>
                پایش پیشرفت تیزهوشان و مهارت‌های دولینگو
              </h3>
              <p style={{ margin: 0, fontSize: 12.5, color: '#C7D2FE' }}>
                رصد زنده و واقعی از سرور (بروزرسانی خودکار هر ۲۰ ثانیه)
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => void fetchLiveProgress()}
              disabled={isRefreshing}
              style={{
                background: 'rgba(255,255,255,0.15)',
                color: '#FFFFFF',
                border: '1px solid rgba(255,255,255,0.3)',
                padding: '6px 12px',
                borderRadius: 10,
                fontSize: 12,
                fontWeight: 800,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span>{isRefreshing ? '⏳' : '🔄'}</span>
              <span>{isRefreshing ? 'در حال بروزرسانی...' : 'بروزرسانی داده‌ها'}</span>
            </button>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                style={{
                  background: 'rgba(255,255,255,0.2)',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: 10,
                  width: 32,
                  height: 32,
                  cursor: 'pointer',
                  fontSize: 16,
                  fontWeight: 900,
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Quick KPI Strip (100% Real Data) */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: 10,
            marginTop: 14,
          }}
        >
          <div style={{ background: 'rgba(255,255,255,0.12)', padding: '10px 14px', borderRadius: 12 }}>
            <div style={{ fontSize: 11, color: '#E0E7FF' }}>مجموع XP</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#FACC15', marginTop: 2 }}>
              {toPersianDigits(totalClassXp)} XP ⚡
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.12)', padding: '10px 14px', borderRadius: 12 }}>
            <div style={{ fontSize: 11, color: '#E0E7FF' }}>دانش‌آموزان در حال تمرین</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#67E8F9', marginTop: 2 }}>
              {toPersianDigits(activeCount)} از {toPersianDigits(studentsProgress.length)} نفر
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.12)', padding: '10px 14px', borderRadius: 12 }}>
            <div style={{ fontSize: 11, color: '#E0E7FF' }}>میانگین گام</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#4ADE80', marginTop: 2 }}>
              {toPersianDigits(avgStep)} از {toPersianDigits(totalSteps)} گام
            </div>
          </div>
        </div>
      </div>

      {loadError && (
        <div
          style={{
            background: '#FEF2F2',
            border: '1.5px solid #FECACA',
            color: '#991B1B',
            borderRadius: 12,
            padding: '10px 14px',
            marginBottom: 12,
            fontSize: 12.5,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span>⚠️ {loadError}</span>
          <button
            type="button"
            onClick={() => void fetchLiveProgress()}
            style={{
              background: '#DC2626',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: 8,
              padding: '5px 12px',
              fontSize: 12,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            تلاش دوباره
          </button>
        </div>
      )}

      {/* Filter and Search Controls */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          marginBottom: 14,
          alignItems: 'center',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
        }}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 جستجوی دانش‌آموز در لیست تیزهوشان..."
          className="mobile-input"
          style={{ maxWidth: 280, height: 40, fontSize: 13 }}
        />

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#64748B' }}>مرتب‌سازی:</span>
          <button
            type="button"
            className="upload-btn"
            style={{
              padding: '5px 10px',
              fontSize: 12,
              background: sortField === 'xp' ? '#4F46E5' : '#FFFFFF',
              color: sortField === 'xp' ? '#FFFFFF' : '#1E293B',
              borderColor: '#4F46E5',
            }}
            onClick={() => setSortField('xp')}
          >
            بیشترین XP ⚡
          </button>
          <button
            type="button"
            className="upload-btn"
            style={{
              padding: '5px 10px',
              fontSize: 12,
              background: sortField === 'step' ? '#4F46E5' : '#FFFFFF',
              color: sortField === 'step' ? '#FFFFFF' : '#1E293B',
              borderColor: '#4F46E5',
            }}
            onClick={() => setSortField('step')}
          >
            پیشروترین گام 🗺️
          </button>
          <button
            type="button"
            className="upload-btn"
            style={{
              padding: '5px 10px',
              fontSize: 12,
              background: sortField === 'recent' ? '#4F46E5' : '#FFFFFF',
              color: sortField === 'recent' ? '#FFFFFF' : '#1E293B',
              borderColor: '#4F46E5',
            }}
            onClick={() => setSortField('recent')}
          >
            آخرین فعالیت 🕒
          </button>
          <button
            type="button"
            className="upload-btn"
            style={{
              padding: '5px 10px',
              fontSize: 12,
              background: sortField === 'name' ? '#4F46E5' : '#FFFFFF',
              color: sortField === 'name' ? '#FFFFFF' : '#1E293B',
              borderColor: '#4F46E5',
            }}
            onClick={() => setSortField('name')}
          >
            الفبایی 🔤
          </button>
        </div>
      </div>

      {/* Students Progress Table */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          maxHeight: '60vh',
          overflowY: 'auto',
          paddingLeft: 2,
        }}
      >
        {filtered.map((s, idx) => {
          const currentTopic = s.hasStarted
            ? tizhooshanTopicsData[Math.max(0, Math.min(totalSteps - 1, s.currentStep - 1))] || tizhooshanTopicsData[0]
            : null
          const progressPercent = Math.min(100, Math.round((s.currentStep / totalSteps) * 100))

          return (
            <div
              key={s.studentId}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '12px 16px',
                borderRadius: 14,
                border: '1.5px solid #E2E8F0',
                background: idx < 3 && s.hasStarted ? '#FEFCE8' : '#FFFFFF',
                boxShadow: '0 2px 4px rgba(0,0,0,0.03)',
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              {/* Student identity & rank */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 900,
                    width: 26,
                    height: 26,
                    borderRadius: 999,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background:
                      s.hasStarted && idx === 0
                        ? '#FACC15'
                        : s.hasStarted && idx === 1
                        ? '#E2E8F0'
                        : s.hasStarted && idx === 2
                        ? '#FDBA74'
                        : '#F1F5F9',
                    color: '#0F172A',
                  }}
                >
                  {toPersianDigits(idx + 1)}
                </span>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: '#0F172A' }}>
                    {s.studentName}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#475569', marginTop: 2 }}>
                    📍 {currentTopic ? (
                      <>گام فعلی: <strong>{currentTopic.topic}</strong></>
                    ) : (
                      <span>هنوز تمرینی ثبت نشده</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                    🕒 آخرین فعالیت: <strong style={{ color: s.hasStarted ? '#334155' : '#94A3B8' }}>{s.lastActivityLabel}</strong>
                  </div>
                </div>
              </div>

              {/* Progress Bar & Stats */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <div style={{ width: 132 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 3 }}>
                    <span>گام {toPersianDigits(s.currentStep)} از {toPersianDigits(totalSteps)}</span>
                    <span>{toPersianDigits(progressPercent)}٪</span>
                  </div>
                  <div style={{ width: '100%', height: 6, background: '#E2E8F0', borderRadius: 999, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${progressPercent}%`,
                        height: '100%',
                        background: s.hasStarted ? '#4F46E5' : '#CBD5E1',
                        borderRadius: 999,
                      }}
                    />
                  </div>
                </div>

                {/* Badges */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      background: '#EFF6FF',
                      color: '#1D4ED8',
                      padding: '4px 8px',
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 800,
                      border: '1px solid #BFDBFE',
                    }}
                  >
                    ⚡ {toPersianDigits(s.totalXp)} XP
                  </span>
                  <span
                    style={{
                      background: '#FEF3C7',
                      color: '#B45309',
                      padding: '4px 8px',
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 800,
                      border: '1px solid #FDE68A',
                    }}
                    title="تعداد روزهای متوالی فعالیت"
                  >
                    🔥 {toPersianDigits(s.streak)} روز
                  </span>
                  <span
                    style={{
                      background: s.hearts <= 1 ? '#FEE2E2' : '#FFF1F2',
                      color: s.hearts <= 1 ? '#B91C1C' : '#BE123C',
                      padding: '4px 8px',
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 800,
                      border: `1px solid ${s.hearts <= 1 ? '#FCA5A5' : '#FECDD3'}`,
                    }}
                    title="تعداد قلب‌های باقیمانده"
                  >
                    ❤️ {toPersianDigits(s.hearts)} / ۵
                  </span>
                  <span
                    style={{
                      background: '#DCFCE7',
                      color: '#166534',
                      padding: '4px 8px',
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 800,
                      border: '1px solid #BBF7D0',
                    }}
                  >
                    ✅ {toPersianDigits(s.completedTopicsCount)} مرحله
                  </span>
                  <span
                    style={{
                      background: s.hasStarted ? '#F0FDF4' : '#F8FAFC',
                      color: s.hasStarted ? '#15803D' : '#64748B',
                      padding: '4px 8px',
                      borderRadius: 8,
                      fontSize: 11,
                      fontWeight: 800,
                      border: `1px solid ${s.hasStarted ? '#BBF7D0' : '#E2E8F0'}`,
                    }}
                  >
                    {s.hasStarted ? '🟢 فعال' : '⚪ هنوز شروع نکرده'}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

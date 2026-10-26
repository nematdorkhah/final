import { useEffect, useRef, useState, useMemo } from 'react'
import { supabase } from '../supabaseClient'
import { getJalaliDateLabel, sanitizeFileName } from '../useJalaliDate'
import { computeStreak, computeBadges, groupSkillMastery, getHomeworkStatus } from '../masteryHelpers'
import MobileHeader from '../components/MobileHeader'
import MobileTabBar from '../components/MobileTabBar'
import PostsBoard from '../components/PostsBoard'
import TizhooshanPrep from '../components/TizhooshanPrep'
import StudentExamTaker from '../components/StudentExamTaker'
import LoadingScreen from '../components/LoadingScreen'
import AttachmentViewerModal from '../components/AttachmentViewerModal'
import ExamReviewModal from '../components/ExamReviewModal'
import StudentReportCard from '../components/StudentReportCard'
import MathRenderer from '../components/MathRenderer'
import { Exam } from '../types/examTypes'
import { fetchPublishedExams, getStudentExamSubmission, sanitizeExamTitle, getLocalExams, getLocalSubmissions } from '../utils/examStore'
import { isItemExpiredForStudent } from '../utils/expiration'
import { sanitizeTeacherFeedback } from '../utils/cleanFeedback'
import { toPersianDigits } from '../utils/persianNumbers'


type StudentTab = 'home' | 'tizhooshan' | 'homework' | 'grades' | 'profile'

export default function StudentDashboard({
  student,
  onLogout,
  onStudentUpdate,
  isTeacherPreview = false,
  onExitPreview,
}: {
  student: any
  onLogout: () => void
  onStudentUpdate?: (s: any) => void
  isTeacherPreview?: boolean
  onExitPreview?: () => void
}) {
  const { weekday, jalali } = getJalaliDateLabel()
  const [activeTab, setActiveTab] = useState<StudentTab>('home')
  const [posts, setPosts] = useState<any[]>([])
  const [mySubmissions, setMySubmissions] = useState<any[]>([])
  const [myGrades, setMyGrades] = useState<any[]>([])
  const [myAttendance, setMyAttendance] = useState<any[]>([])
  const [exams, setExams] = useState<Exam[]>([])
  const [takingExam, setTakingExam] = useState<Exam | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sendingPostId, setSendingPostId] = useState<string | null>(null)
  const [stagedFiles, setStagedFiles] = useState<Record<string, File>>({})
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>(() => {
    try {
      if (typeof localStorage !== 'undefined' && student?.id) {
        const raw = localStorage.getItem(`hw_drafts_${student.id}`)
        if (raw) return JSON.parse(raw)
      }
    } catch {}
    return {}
  })
  const [expandedHomeworkId, setExpandedHomeworkId] = useState<string | null>(null)
  const [viewingAttachmentUrl, setViewingAttachmentUrl] = useState<string | null>(null)
  const [viewingAttachmentTitle, setViewingAttachmentTitle] = useState<string>('فایل پیوست')
  const [reviewExamData, setReviewExamData] = useState<{ exam: any; submission: any } | null>(null)
  const [showReportCardModal, setShowReportCardModal] = useState(false)
  const [currentTime, setCurrentTime] = useState(Date.now())
  const hasLoadedOnce = useRef(false)

  function updateHomeworkDraft(postId: string, text: string) {
    setNoteDrafts((prev) => {
      const updated = { ...prev, [postId]: text }
      try {
        if (student?.id) {
          localStorage.setItem(`hw_drafts_${student.id}`, JSON.stringify(updated))
        }
      } catch {}
      return updated
    })
  }

  // Live timer for countdowns
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(Date.now())
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // Helper to format remaining time until exam starts
  function getExamCountdownInfo(scheduledStartTime: string) {
    const startMs = new Date(scheduledStartTime).getTime()
    const diffMs = startMs - currentTime

    // Exact scheduled time formatted in Persian
    const startDate = new Date(scheduledStartTime)
    const hours = startDate.getHours().toString().padStart(2, '0')
    const minutes = startDate.getMinutes().toString().padStart(2, '0')
    const timeLabel = `${toPersianDigits(hours)}:${toPersianDigits(minutes)}`

    if (diffMs <= 0) {
      return {
        isStarted: true,
        timeLabel,
        remainingText: 'هم‌اکنون در حال برگزاری',
        badgeText: '🟢 آماده برگزاری',
      }
    }

    const totalSeconds = Math.floor(diffMs / 1000)
    const d = Math.floor(totalSeconds / 86400)
    const h = Math.floor((totalSeconds % 86400) / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60

    let remainingParts: string[] = []
    if (d > 0) remainingParts.push(`${toPersianDigits(d)} روز`)
    if (h > 0) remainingParts.push(`${toPersianDigits(h)} ساعت`)
    if (m > 0 || (d === 0 && h === 0)) remainingParts.push(`${toPersianDigits(m)} دقیقه`)
    if (d === 0 && h === 0 && m < 60) remainingParts.push(`${toPersianDigits(s)} ثانیه`)

    const remainingText = `${remainingParts.join(' و ')} مانده به شروع`

    return {
      isStarted: false,
      timeLabel,
      remainingText,
      badgeText: '⏰ شروع به زودی',
      totalSeconds,
    }
  }

  // Profile Avatar State
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => {
    try {
      if (!student?.id) return null
      return localStorage.getItem(`student_avatar_${student.id}`)
    } catch {
      return null
    }
  })

  // Notification Banner for new registered homework
  const [dismissedHwBanner, setDismissedHwBanner] = useState<boolean>(() => {
    try {
      if (typeof sessionStorage !== 'undefined' && student?.id) {
        return sessionStorage.getItem(`hw_banner_dismissed_${student.id}`) === '1'
      }
      return false
    } catch {
      return false
    }
  })

  function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !student?.id) return
    const reader = new FileReader()
    reader.onloadend = () => {
      const dataUrl = reader.result as string
      setAvatarUrl(dataUrl)
      try {
        localStorage.setItem(`student_avatar_${student.id}`, dataUrl)
      } catch (err) {
        console.warn('Failed to save avatar to localStorage', err)
      }
    }
    reader.readAsDataURL(file)
  }

  const [oldCode, setOldCode] = useState('')
  const [newCode, setNewCode] = useState('')
  const [codeMsg, setCodeMsg] = useState('')
  const [codeBusy, setCodeBusy] = useState(false)

  // Guard against internal system records (__SYSTEM_EXAMS__, __EXAM_SUB__, etc.)
  function isSystemRecord(item: any): boolean {
    if (!item) return true
    const title = String(item.title || '')
    if (title.startsWith('__')) return true
    if (title.includes('__SYSTEM_') || title.includes('__EXAM_SUB__')) return true
    if (item.type === 'exam') return true
    if (typeof item.body === 'string' && (item.body.includes('"questions":') || item.body.includes('"examId":'))) {
      try {
        const parsed = JSON.parse(item.body)
        if (parsed.questions || parsed.examId || Array.isArray(parsed)) return true
      } catch {}
    }
    return false
  }

  async function loadAll() {
    if (!hasLoadedOnce.current) setLoading(true)
    setLoadError(null)

    // 7-second safety timeout guard against hanging network requests
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('زمان پاسخگویی سرور به پایان رسید.')), 7000)
    )

    try {
      const studentId = student?.id || student?.access_code
      const accessCode = student?.access_code || student?.id

      if (!studentId) {
        throw new Error('مشخصات نشست دانش‌آموز یافت نشد. لطفاً مجدداً وارد شوید.')
      }

      const fetchPromise = Promise.all([
        supabase.rpc('list_published_posts'),
        supabase.rpc('student_list_my_submissions', {
          p_student_id: studentId,
          p_access_code: accessCode,
        }),
        supabase.rpc('student_list_my_grades', {
          p_student_id: studentId,
          p_access_code: accessCode,
        }),
        supabase.rpc('student_list_my_attendance', {
          p_student_id: studentId,
          p_access_code: accessCode,
        }),
        fetchPublishedExams(),
      ])

      const [p, sub, g, att, examList] = (await Promise.race([fetchPromise, timeoutPromise])) as any[]

      // Filter out all system posts so students only see genuine announcements and homework
      const cleanPosts = (p?.data || []).filter((post: any) => !isSystemRecord(post))
      setPosts(cleanPosts)
      setMySubmissions(sub?.data || [])
      setMyGrades(g?.data || [])
      setMyAttendance(att?.data || [])
      setExams(examList || [])
      hasLoadedOnce.current = true

      // Auto-resume active exam if browser was refreshed or reopened mid-exam
      try {
        const activeExamId = sessionStorage.getItem('active_taking_exam_id')
        if (activeExamId && Array.isArray(examList)) {
          const found = examList.find((e: Exam) => e.id === activeExamId)
          if (found) {
            const prevSub = getStudentExamSubmission(found.id, studentId)
            if (!prevSub) {
              setTakingExam(found)
            } else {
              sessionStorage.removeItem('active_taking_exam_id')
            }
          }
        }
      } catch (err) {
        console.warn('Failed auto-resuming exam:', err)
      }
    } catch (err: any) {
      console.warn('Failed loading student classroom data:', err)
      setLoadError(err?.message || 'خطا در برقراری ارتباط با سرور')
      // Ensure state is initialized with safe empty arrays so dashboard renders
      setPosts((prev) => prev || [])
      setMySubmissions((prev) => prev || [])
      setMyGrades((prev) => prev || [])
      setMyAttendance((prev) => prev || [])
      setExams((prev) => prev || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function stageFile(postId: string, file: File) {
    setStagedFiles((s) => ({ ...s, [postId]: file }))
  }

  function cancelStaged(postId: string) {
    setStagedFiles((s) => {
      const copy = { ...s }
      delete copy[postId]
      return copy
    })
  }

  async function sendHomework(postId: string) {
    const file = stagedFiles[postId]
    const note = (noteDrafts[postId] || '').trim()
    if (!file && !note) {
      alert('لطفاً متن پاسخ یا فایل پیوست را وارد کنید.')
      return
    }
    setSendingPostId(postId)
    try {
      let path = 'text_only'
      if (file) {
        path = `${student.id}/${postId}-${Date.now()}-${sanitizeFileName(file.name)}`
        const { error: uploadError } = await supabase.storage.from('submissions').upload(path, file)
        if (uploadError) throw uploadError
      }

      const { error } = await supabase.rpc('student_submit_homework', {
        p_student_id: student.id,
        p_access_code: student.access_code,
        p_post_id: postId,
        p_file_url: path,
        p_note: note || (path === 'text_only' ? 'پاسخ متنی دانش‌آموز' : null),
      })
      if (error) throw error
      cancelStaged(postId)
      // Clear homework draft from state and localStorage upon successful submit
      setNoteDrafts((prev) => {
        const copy = { ...prev }
        delete copy[postId]
        try {
          if (student?.id) localStorage.setItem(`hw_drafts_${student.id}`, JSON.stringify(copy))
        } catch {}
        return copy
      })
      await loadAll()
    } catch (err) {
      alert('ارسال ناموفق بود، لطفاً مجدداً امتحان کنید.')
      console.error(err)
    } finally {
      setSendingPostId(null)
    }
  }

  async function changeAccessCode(e: React.FormEvent) {
    e.preventDefault()
    if (!oldCode.trim() || !newCode.trim()) return
    setCodeBusy(true)
    const { data, error } = await supabase.rpc('student_change_code', {
      p_student_id: student.id,
      p_old_code: oldCode.trim(),
      p_new_code: newCode.trim(),
    })
    setCodeBusy(false)
    if (error) {
      setCodeMsg('خطا: ' + error.message)
      return
    }
    setCodeMsg('رمز عبور با موفقیت به‌روزرسانی شد ✓')
    setOldCode('')
    setNewCode('')
    if (onStudentUpdate) onStudentUpdate(data)
  }

  // Combined grades merging Supabase grades with local exam scores
  const combinedGrades = useMemo(() => {
    const localExams = getLocalExams()
    const examSubs = getLocalSubmissions().filter((s) => s.studentId === student.id)
    const examMap = new Map(localExams.map((e) => [e.id, e]))
    const subMap = new Map(examSubs.map((s) => [s.examId, s]))

    // Process existing Supabase grades with matched exams
    const list = myGrades.map((g) => {
      let matchedExam = g.exam || null
      let matchedSub = g.sub || null

      if (!matchedExam) {
        matchedExam =
          localExams.find((e) => {
            if (g.examId && e.id === g.examId) return true
            if (g.id && (`exam_sub_${e.id}` === g.id || `exam_${e.id}` === g.id)) return true
            const cleanE = sanitizeExamTitle(e.title, e.subject)
            const cleanG = sanitizeExamTitle(g.skill || '', g.subject)
            return cleanE && cleanG && (cleanE === cleanG || g.skill?.includes(cleanE))
          }) || null
      }

      if (matchedExam && !matchedSub) {
        matchedSub = subMap.get(matchedExam.id) || null
      }

      return {
        ...g,
        matchedExam,
        matchedSub,
      }
    })

    // Add local exam submissions not yet in list
    for (const sub of examSubs) {
      const exam = examMap.get(sub.examId)
      if (!exam) continue
      const score = sub.teacherGrading?.totalScore ?? sub.aiGrading?.totalScore ?? (sub as any).studentScore
      if (score === undefined || score === null) continue
      const rawMax = Number(exam.totalPoints || (exam as any).totalScore) || 20
      // Exact formula: Score = (Earned / Total) * 20
      const scaledScore = rawMax > 0 ? Math.round(((Number(score) / rawMax) * 20) * 10) / 10 : Number(score)
      const cleanTitle = sanitizeTeacherFeedback(sanitizeExamTitle(exam.title, exam.subject))

      const exists = list.some(
        (g) => g.skill === `آزمون: ${cleanTitle}` || g.skill === cleanTitle || g.examId === exam.id || g.matchedExam?.id === exam.id
      )
      if (!exists) {
        list.push({
          id: `exam_sub_${sub.id}`,
          student_id: student.id,
          subject: exam.subject || 'عمومی',
          skill: `آزمون: ${cleanTitle}`,
          score: scaledScore,
          max_score: 20,
          recorded_at: sub.submittedAt || new Date().toISOString(),
          is_exam: true,
          examId: exam.id,
          matchedExam: exam,
          matchedSub: sub,
          exam,
          sub,
        })
      }
    }
    return list
  }, [myGrades, student.id])

  // Teacher report card recommendation note
  const reportNote = useMemo(() => {
    try {
      const raw = localStorage.getItem(`teacher_report_note_${student.id}`)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed.active && parsed.text?.trim()) return sanitizeTeacherFeedback(parsed.text.trim())
      }
    } catch {
      // ignore
    }
    return null
  }, [student.id, activeTab])


  // Active posts (announcements)
  const activePosts = useMemo(() => {
    return posts.filter((p) => !isItemExpiredForStudent(p, 5))
  }, [posts])

  const announcementPosts = useMemo(() => {
    return activePosts.filter((p) => p.type === 'announcement' && !isSystemRecord(p))
  }, [activePosts])

  // Unsubmitted homeworks are ALWAYS shown so student can still submit them (marked past due if late).
  // Submitted homeworks are cleaned up after 5 days so they don't pile up.
  const homeworkPosts = useMemo(() => {
    const submittedIds = new Set(mySubmissions.map((s) => s.post_id))
    return posts.filter((p) => {
      if (isSystemRecord(p)) return false
      if (p.type !== 'homework') return false
      if (!submittedIds.has(p.id)) return true
      return !isItemExpiredForStudent(p, 5)
    })
  }, [posts, mySubmissions])

  // Exams are visible for 3 days after scheduled date/deadline, then archived to report card only!
  const activeExams = useMemo(() => {
    return exams.filter((e) => !isItemExpiredForStudent(e, 3))
  }, [exams])

  const submittedIds = new Set(mySubmissions.map((s) => s.post_id))
  const pendingCount = homeworkPosts.filter((p) => !submittedIds.has(p.id)).length

  const newUnsubmittedHomeworks = useMemo(() => {
    return homeworkPosts.filter((p) => !submittedIds.has(p.id))
  }, [homeworkPosts, submittedIds])

  const latestHomeworkId = useMemo(() => {
    return newUnsubmittedHomeworks[0]?.id || null
  }, [newUnsubmittedHomeworks])

  const prevHomeworkIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (latestHomeworkId && prevHomeworkIdRef.current && latestHomeworkId !== prevHomeworkIdRef.current) {
      setDismissedHwBanner(false)
      try {
        if (student?.id) sessionStorage.removeItem(`hw_banner_dismissed_${student.id}`)
      } catch (e) {
        console.warn(e)
      }
    }
    prevHomeworkIdRef.current = latestHomeworkId
  }, [latestHomeworkId, student?.id])

  const showHomeworkNotification = useMemo(() => {
    if (activeTab === 'homework') return false
    if (newUnsubmittedHomeworks.length === 0) return false
    if (dismissedHwBanner) return false
    return true
  }, [activeTab, newUnsubmittedHomeworks.length, dismissedHwBanner])

  function dismissNotificationBanner() {
    setDismissedHwBanner(true)
    try {
      if (typeof sessionStorage !== 'undefined' && student?.id) {
        sessionStorage.setItem(`hw_banner_dismissed_${student.id}`, '1')
      }
    } catch (e) {
      console.warn(e)
    }
  }

  function handleOpenHomeworkTab() {
    setActiveTab('homework')
    dismissNotificationBanner()
  }

  const streak = computeStreak(homeworkPosts, mySubmissions)
  const badges = computeBadges(streak, combinedGrades, myAttendance)
  const skillGroups = groupSkillMastery(combinedGrades)

  const gpa = useMemo(() => {
    if (!combinedGrades.length) return null
    const total = combinedGrades.reduce((sum, g) => sum + (g.score / g.max_score) * 20, 0)
    return (total / combinedGrades.length).toFixed(1)
  }, [combinedGrades])

  const attendanceStats = useMemo(() => {
    const present = myAttendance.filter((a) => a.status === 'present').length
    const late = myAttendance.filter((a) => a.status === 'late').length
    const absent = myAttendance.filter((a) => a.status === 'absent').length
    return { present, late, absent }
  }, [myAttendance])

  const tabs = [
    { id: 'home', label: 'خانه', icon: '🏠' },
    { id: 'tizhooshan', label: 'تیزهوشان', icon: '🦉' },
    { id: 'homework', label: 'تکالیف', icon: '📝', badge: pendingCount || undefined },
    { id: 'grades', label: 'کارنامه', icon: '📊' },
    { id: 'profile', label: 'حساب من', icon: '👤' },
  ]

  if (loading) {
    return (
      <div dir="rtl" className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <LoadingScreen
          message="در حال دریافت اطلاعات دانش‌آموز..."
          error={loadError}
          onRetry={loadAll}
          onLogout={onLogout}
        />
      </div>
    )
  }

  return (
    <div dir="rtl" className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans pb-32 sm:pb-28">
      {/* Teacher View Preview Sticky Banner */}
      {isTeacherPreview && (
        <div className="sticky top-0 z-50 bg-gradient-to-r from-blue-900 to-blue-700 text-white px-4 py-2.5 shadow-md border-b-2 border-blue-400 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-xl">👁️</span>
            <div className="min-w-0">
              <div className="text-xs sm:text-sm font-black">حالت پیش‌نمایش معلم</div>
              <div className="text-[11px] text-blue-100 truncate">
                مشاهده صفحات و تکالیف از نگاه «{student?.full_name || 'دانش‌آموز'}»
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onExitPreview || onLogout}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-xs transition-colors cursor-pointer shrink-0"
          >
            <span>بازگشت به پنل معلم</span>
            <span>↩️</span>
          </button>
        </div>
      )}

      {/* Mobile Top Header */}
      <MobileHeader
        title={student?.full_name || 'دانش‌آموز'}
        subtitle="پایه ششم دبستان حضرت قائم (عج)"
        userBadge="دانش‌آموز"
        dateLabel={`${weekday}، ${jalali}`}
        onLogout={onLogout}
      />

      <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-5 pb-12 flex-1">
        {/* New Homework Notification Banner */}
        {showHomeworkNotification && (
          <div
            role="alert"
            className="mb-5 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-3.5 sm:p-4 shadow-xs flex items-center justify-between gap-3 animate-[mobileFadeIn_0.3s_ease-out]"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center text-lg shrink-0 shadow-xs">
                🔔
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <span className="text-xs sm:text-sm font-black text-blue-950">
                    {newUnsubmittedHomeworks.length === 1
                      ? `تکلیف جدید: ${newUnsubmittedHomeworks[0].title}`
                      : `${toPersianDigits(newUnsubmittedHomeworks.length)} تکلیف جدید برای شما ثبت شده`}
                  </span>
                  <span className="text-[10px] font-black bg-rose-500 text-white px-1.5 py-0.2 rounded-md">
                    جدید
                  </span>
                </div>
                <p className="text-xs text-blue-800 font-medium truncate">
                  {newUnsubmittedHomeworks.length === 1 && newUnsubmittedHomeworks[0].subject
                    ? `درس ${newUnsubmittedHomeworks[0].subject} · برای مشاهده جزئیات و ارسال پاسخ کلیک کنید`
                    : 'لطفاً برای مشاهده جزئیات و ارسال پاسخ وارد بخش تکالیف شوید.'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleOpenHomeworkTab}
                className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-black shadow-xs transition-colors cursor-pointer inline-flex items-center gap-1.5"
              >
                <span>مشاهده</span>
                <span>←</span>
              </button>
              <button
                type="button"
                onClick={dismissNotificationBanner}
                aria-label="بستن اعلان"
                title="بستن اعلان"
                className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200/60 transition-colors cursor-pointer text-sm"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* TAB 1: HOME */}
        {activeTab === 'home' && (
          <div className="space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            {/* Student Welcome Hero Card */}
            <div className="bg-gradient-to-br from-blue-700 via-indigo-700 to-sky-600 text-white rounded-3xl p-6 sm:p-7 shadow-lg shadow-blue-900/15 relative overflow-hidden">
              <div className="relative z-10">
                <div className="inline-flex items-center gap-2 bg-white/15 px-3 py-1 rounded-full text-xs font-bold mb-3 border border-white/20 backdrop-blur-xs">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>پایه ششم دبستان هوشمند حضرت قائم (عج)</span>
                </div>
                <h2 className="text-xl sm:text-2xl font-black mb-2 tracking-tight">
                  سلام {String(student?.full_name || 'دانش‌آموز').split(' ')[0]} عزیز! 👋
                </h2>
                <p className="text-xs sm:text-sm text-blue-100 font-medium max-w-xl leading-relaxed">
                  {pendingCount > 0
                    ? `تو ${toPersianDigits(pendingCount)} تکلیف انجام‌نشده داری. همین حالا پاسخ‌های خود را ارسال کن تا امتیاز کامل کسب کنی!`
                    : 'آفرین به پشتکارت! تمام تکالیف فعال تا این لحظه تحویل داده شده‌اند.'}
                </p>

                {/* Quick stats & badges */}
                {(gpa || badges.length > 0) && (
                  <div className="flex flex-wrap items-center gap-2.5 mt-5 pt-4 border-t border-white/15">
                    {gpa && (
                      <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-white/10 text-white border border-white/20 backdrop-blur-xs">
                        <span>📊 معدل کل:</span>
                        <span className="text-emerald-300 font-black">{toPersianDigits(gpa)} از ۲۰</span>
                      </div>
                    )}

                  {badges.map((b) => (
                    <span
                      key={b}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold bg-white/20 text-white border border-white/30 backdrop-blur-xs"
                    >
                      {b}
                    </span>
                  ))}
                  </div>
                )}
              </div>

              {/* Decorative background glow */}
              <div className="absolute -left-12 -bottom-12 w-48 h-48 bg-sky-400/20 rounded-full blur-2xl pointer-events-none" />
              <div className="absolute -right-12 -top-12 w-48 h-48 bg-indigo-500/30 rounded-full blur-2xl pointer-events-none" />
            </div>

            {/* Tizhooshan Quick Launcher */}
            <div
              className="bg-gradient-to-r from-emerald-600 to-teal-700 text-white rounded-2xl p-4 sm:p-5 shadow-sm hover:shadow-md transition-all flex items-center justify-between gap-4 cursor-pointer group"
              onClick={() => setActiveTab('tizhooshan')}
            >
              <div className="flex items-center gap-3.5">
                <span className="text-3xl sm:text-4xl group-hover:scale-110 transition-transform">🦉</span>
                <div>
                  <div className="font-black text-sm sm:text-base">
                    باشگاه و چالش استعداد تحلیلی تیزهوشان
                  </div>
                  <div className="text-xs text-emerald-100 mt-0.5">
                    بانک سوالات طبقه‌بندی شده سمپاد + تمرین بی‌پایان ♾️
                  </div>
                </div>
              </div>
              <span className="text-xs font-black bg-white/20 group-hover:bg-white/30 px-3.5 py-1.5 rounded-xl whitespace-nowrap border border-white/30 transition-colors">
                ورود به چالش 🚀
              </span>
            </div>

            {/* Online Exams Section */}
            {activeExams.length > 0 && (
              <div className="space-y-3.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-base sm:text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                    <span>📝</span>
                    <span>آزمون‌های آنلاین کلاسی</span>
                  </h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {activeExams.map((exam) => {
                    const sub = getStudentExamSubmission(exam.id, student.id)
                    const isSubmitted = Boolean(sub)
                    const isApproved = sub?.teacherGrading?.approved
                    const countdown = getExamCountdownInfo(exam.scheduledStartTime)
                    const isStarted = countdown.isStarted

                    return (
                      <div
                        key={exam.id}
                        className="bg-white border border-slate-200/90 rounded-2xl p-4.5 sm:p-5 shadow-xs hover:shadow-md transition-all flex flex-col justify-between"
                      >
                        <div>
                          <div className="flex items-start justify-between gap-3 mb-2">
                            <div>
                              <span className="text-[11px] font-black bg-blue-50 text-blue-700 px-2.5 py-0.5 rounded-md border border-blue-100">
                                {exam.subject}
                              </span>
                              <h4 className="text-base font-black text-slate-900 mt-1.5 mb-1">
                                {sanitizeExamTitle(exam.title, exam.subject)}
                              </h4>
                            </div>

                            <span
                              className={`text-[11px] font-black px-2.5 py-1 rounded-lg border whitespace-nowrap ${
                                isApproved
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : isSubmitted
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : isStarted
                                  ? 'bg-blue-50 text-blue-800 border-blue-200'
                                  : 'bg-amber-50 text-amber-800 border-amber-200'
                              }`}
                            >
                              {isApproved
                                ? `✅ نمره: ${toPersianDigits(sub?.teacherGrading?.totalScore)} از ${toPersianDigits(exam.totalPoints)}`
                                : isSubmitted
                                ? '✅ ارسال شد'
                                : isStarted
                                ? '🟢 آماده برگزاری'
                                : '⏰ شروع به زودی'}
                            </span>
                          </div>

                          {/* Countdown for Upcoming Exams */}
                          {!isStarted && !isSubmitted && (
                            <div className="my-3 p-3 bg-amber-50/80 border border-amber-200 rounded-xl flex items-center justify-between gap-2.5 flex-wrap">
                              <div className="flex items-center gap-2">
                                <span className="text-xl animate-pulse">⏳</span>
                                <div>
                                  <div className="text-xs font-black text-amber-900">
                                    آغاز آزمون: ساعت {countdown.timeLabel} · {countdown.remainingText}
                                  </div>
                                  <div className="text-[11px] text-amber-700 font-medium mt-0.5">
                                    به‌محض فرارسیدن زمان، دکمه ورود به آزمون فعال می‌شود.
                                  </div>
                                </div>
                              </div>
                              <span className="text-[11px] font-black bg-amber-200/70 text-amber-900 px-2 py-0.5 rounded-md">
                                شمارش معکوس زنده
                              </span>
                            </div>
                          )}

                          <p className="text-xs text-slate-500 mb-4">
                            {toPersianDigits(exam.questions.length)} سوال ({toPersianDigits(exam.totalPoints)} نمره) · مدت آزمون: {toPersianDigits(exam.durationMinutes)} دقیقه · زمان شروع: {toPersianDigits(new Date(exam.scheduledStartTime).toLocaleString('fa-IR'))}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 pt-2 border-t border-slate-100 flex-wrap">
                          {isSubmitted && (
                            <button
                              type="button"
                              className="flex-1 py-2 px-3 text-xs font-black text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
                              onClick={() => setReviewExamData({ exam, submission: sub })}
                            >
                              <span>📋</span>
                              <span>مشاهده کارنامه و ریز پاسخ‌ها</span>
                            </button>
                          )}
                          {(() => {
                            const hasDraft =
                              !isSubmitted &&
                              typeof localStorage !== 'undefined' &&
                              Boolean(
                                localStorage.getItem(`exam_draft_${exam.id}_${student.id}`) ||
                                  localStorage.getItem(`exam_draft_${exam.id}`)
                              )

                            return (
                              <button
                                type="button"
                                disabled={!isStarted && !isSubmitted && !hasDraft}
                                className={`py-2 px-3 text-xs font-black rounded-xl transition-all cursor-pointer inline-flex items-center justify-center gap-1.5 ${
                                  isSubmitted ? 'flex-1' : 'w-full'
                                } ${
                                  isApproved
                                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
                                    : isSubmitted
                                    ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-xs'
                                    : hasDraft
                                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-md ring-2 ring-emerald-200'
                                    : isStarted
                                    ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-xs'
                                    : 'bg-slate-200 text-slate-500 cursor-not-allowed'
                                }`}
                                onClick={() => {
                                  sessionStorage.setItem('active_taking_exam_id', exam.id)
                                  setTakingExam(exam)
                                }}
                              >
                                {isApproved
                                  ? '📊 بررسی در آزمون‌ساز'
                                  : isSubmitted
                                  ? '🔍 مشاهده آزمون ارسال‌شده'
                                  : hasDraft
                                  ? '📝 ادامه آزمون (دارای پاسخ ذخیره‌شده)'
                                  : isStarted
                                  ? '🚀 ورود به صفحه آزمون'
                                  : `⏳ آغاز در ساعت ${countdown.timeLabel} (${countdown.remainingText})`}
                              </button>
                            )
                          })()}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Teacher Announcements Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base sm:text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                    <span>📢</span>
                    <span>تابلوی اعلانات و اطلاعیه‌های آموزگار</span>
                  </h3>
                  <p className="text-xs text-slate-500 font-medium mt-0.5">
                    اخبار، برنامه‌های هفتگی و راهنمایی‌های درسی کلاس
                  </p>
                </div>
              </div>
              <PostsBoard
                posts={announcementPosts}
                emptyText="هنوز اطلاعیه‌ای از طرف آموزگار ثبت نشده است."
              />
            </div>
          </div>
        )}

        {/* TAB 2: HOMEWORK (تکالیف من) */}
        {activeTab === 'homework' && (
          <div className="space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-900 tracking-tight">تکالیف درسی من</h2>
                <p className="text-xs text-slate-500 font-medium mt-0.5">
                  {pendingCount > 0
                    ? `${toPersianDigits(pendingCount)} تکلیف انجام‌نشده در انتظار تحویل است`
                    : 'همه تکالیف فعال تا این لحظه ارسال شده‌اند'}
                </p>
              </div>
            </div>

            {/* INTERACTIVE ASSIGNMENTS SECTION (If teacher posted assignment exams) */}
            {activeExams.filter((e) => e.mode === 'assignment').length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🌟</span>
                  <h3 className="text-base font-black text-slate-900 tracking-tight">
                    تکالیف و تمرین‌های تعاملی آنلاین
                  </h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {activeExams
                    .filter((e) => e.mode === 'assignment')
                    .map((assignment) => {
                      const sub = getStudentExamSubmission(assignment.id, student.id)
                      const isSubmitted = Boolean(sub)
                      const isApproved = Boolean(sub?.teacherGrading?.approved || (sub as any)?.approved)
                      return (
                        <div
                          key={assignment.id}
                          className="bg-blue-50/60 border border-blue-200/90 rounded-2xl p-4.5 shadow-xs flex flex-col justify-between"
                        >
                          <div>
                            <div className="flex justify-between items-start gap-2 mb-2">
                              <div>
                                <span className="text-[11px] font-black bg-blue-100 text-blue-800 px-2 py-0.5 rounded-md">
                                  {assignment.subject} · تکلیف تعاملی
                                </span>
                                <h4 className="text-base font-black text-slate-900 mt-1.5 mb-1">
                                  {sanitizeExamTitle(assignment.title, assignment.subject)}
                                </h4>
                              </div>
                              <span
                                className={`text-[11px] font-black px-2.5 py-1 rounded-lg border whitespace-nowrap ${
                                  isApproved
                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                    : isSubmitted
                                    ? 'bg-amber-50 text-amber-800 border-amber-200'
                                    : 'bg-slate-100 text-slate-700 border-slate-200'
                                }`}
                              >
                                {isApproved ? '✅ تایید شد' : isSubmitted ? '✓ ارسال شد' : '⭕ در انتظار حل'}
                              </span>
                            </div>

                            <div className="text-xs text-slate-500 mb-3">
                              <span>تعداد سوالات: {toPersianDigits(assignment.questions.length)} سوال · بارم: {toPersianDigits(assignment.totalPoints)} نمره</span>
                              {assignment.dueDate && (
                                <div className="mt-1 text-blue-700 font-bold">
                                  ⏰ مهلت تحویل: {toPersianDigits(new Date(assignment.dueDate).toLocaleString('fa-IR'))}
                                </div>
                              )}
                            </div>
                          </div>

                          <button
                            type="button"
                            className="w-full py-2 px-3 text-xs font-black text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-xs transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
                            onClick={() => setTakingExam(assignment)}
                          >
                            {isApproved
                              ? '📊 مشاهده کارنامه و نمره تکلیف'
                              : isSubmitted
                              ? '✏️ مشاهده یا ویرایش پاسخ‌ها'
                              : '📝 ورود و شروع حل تکلیف تعاملی'}
                          </button>
                        </div>
                      )
                    })}
                </div>
              </div>
            )}

            {homeworkPosts.length === 0 && activeExams.filter((e) => e.mode === 'assignment').length === 0 && (
              <div className="bg-white border border-slate-200/80 rounded-2xl p-8 text-center shadow-xs">
                <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-slate-50 text-slate-400 flex items-center justify-center text-2xl shadow-2xs">
                  📝
                </div>
                <h4 className="text-sm font-black text-slate-800 mb-1">
                  در حال حاضر تکلیفی برای کلاس تعیین نشده است
                </h4>
                <p className="text-xs text-slate-500 max-w-sm mx-auto">
                  تکالیف روزانه و هفتگی جدید پس از ثبت توسط آموزگار در این صفحه نمایش داده می‌شوند.
                </p>
              </div>
            )}

            <div className="space-y-3.5">
              {homeworkPosts.map((p) => {
                const sub = mySubmissions.find((s) => s.post_id === p.id)
                const staged = stagedFiles[p.id]
                const currentText = noteDrafts[p.id] !== undefined ? noteDrafts[p.id] : (sub?.note || '')
                const isPastDue = Boolean(p.due_at && new Date(p.due_at) < new Date())
                const isExpanded = expandedHomeworkId === p.id

                return (
                  <div
                    key={p.id}
                    className={`bg-white border rounded-2xl transition-all duration-200 overflow-hidden ${
                      isExpanded
                        ? 'border-blue-400 shadow-md ring-2 ring-blue-100/60'
                        : 'border-slate-200/80 hover:border-slate-300 hover:shadow-xs'
                    }`}
                  >
                    {/* Header: Clickable to expand/collapse */}
                    <div
                      className="p-4 sm:p-4.5 cursor-pointer select-none flex items-start sm:items-center justify-between gap-3"
                      onClick={() => setExpandedHomeworkId(isExpanded ? null : p.id)}
                    >
                      <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                        <div
                          className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 text-base sm:text-lg ${
                            sub
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
                              : isPastDue
                              ? 'bg-rose-50 text-rose-700 border border-rose-200/60'
                              : 'bg-amber-50 text-amber-700 border border-amber-200/60'
                          }`}
                        >
                          {sub ? '✅' : isPastDue ? '⚠️' : '📐'}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span
                              className={`text-[11px] font-black px-2 py-0.5 rounded-md border ${
                                sub
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : isPastDue
                                  ? 'bg-rose-50 text-rose-800 border-rose-200'
                                  : 'bg-amber-50 text-amber-800 border-amber-200'
                              }`}
                            >
                              {sub ? 'ارسال شده' : isPastDue ? 'گذشته از مهلت' : 'در انتظار ارسال'}
                            </span>

                            {p.due_at && (
                              <span className="text-[11px] text-slate-500 font-bold">
                                مهلت: {toPersianDigits(new Date(p.due_at).toLocaleDateString('fa-IR'))}
                              </span>
                            )}
                          </div>

                          <h3
                            className={`text-sm sm:text-base font-black transition-colors ${
                              isExpanded ? 'text-blue-700' : 'text-slate-900'
                            } ${isExpanded ? 'whitespace-normal' : 'truncate'}`}
                          >
                            {toPersianDigits(p.title)}
                          </h3>

                          {/* Collapsed Snippet */}
                          {!isExpanded && (
                            <p className="text-xs text-slate-500 truncate mt-1 max-w-xl">
                              {p.body ? p.body.slice(0, 80) + (p.body.length > 80 ? '...' : '') : 'جهت مشاهده سوال و ارسال پاسخ کلیک کنید...'}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 self-center">
                        <span
                          className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-lg transition-all ${
                            isExpanded
                              ? 'bg-blue-50 text-blue-700'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200/80'
                          }`}
                        >
                          <span>{isExpanded ? 'بستن' : 'حل تکلیف'}</span>
                          <span
                            className={`transform transition-transform duration-200 text-xs ${
                              isExpanded ? 'rotate-180' : 'rotate-0'
                            }`}
                          >
                            ▼
                          </span>
                        </span>
                      </div>
                    </div>

                    {/* Expanded Content */}
                    {isExpanded && (
                      <div className="px-4 pb-4 sm:px-5 sm:pb-5 pt-2 border-t border-slate-100 bg-slate-50/40 space-y-3.5">
                        {/* Question / Description */}
                        {p.body && (
                          <div className="text-xs sm:text-sm text-slate-800 leading-relaxed bg-white p-4 rounded-xl border border-slate-200/80 shadow-2xs">
                            <MathRenderer text={p.body} />
                          </div>
                        )}

                        {/* Attachment from Teacher */}
                        {p.attachment_path && (
                          <div className="bg-blue-50/80 border border-blue-200/80 rounded-xl p-3 flex items-center justify-between gap-3 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="text-lg">📎</span>
                              <div>
                                <div className="font-black text-blue-950">فایل پیوست تکلیف آموزگار</div>
                                <div className="text-[11px] text-blue-700">برای دانلود و مشاهده تصویر یا جزوه کلیک کنید</div>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="px-3 py-1.5 text-xs font-black text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-2xs transition-colors cursor-pointer whitespace-nowrap"
                              onClick={(e) => {
                                e.stopPropagation()
                                setViewingAttachmentUrl(p.attachment_path)
                                setViewingAttachmentTitle(p.title || 'فایل پیوست تکلیف')
                              }}
                            >
                              مشاهده فایل 👁️
                            </button>
                          </div>
                        )}

                        {/* Previously Submitted File by Student */}
                        {sub?.file_url && sub.file_url !== 'text_only' && (
                          <div className="bg-emerald-50/80 border border-emerald-200/80 rounded-xl p-3 flex items-center justify-between gap-3 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="text-lg">✅</span>
                              <div>
                                <div className="font-black text-emerald-950">فایل قبلی ارسالی شما ثبت شده است</div>
                                <div className="text-[11px] text-emerald-700">می‌توانید پاسخ جدید ارسال کنید یا فایل قبلی را ببینید</div>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="px-3 py-1.5 text-xs font-black text-emerald-800 bg-emerald-100 hover:bg-emerald-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                              onClick={(e) => {
                                e.stopPropagation()
                                setViewingAttachmentUrl(sub.file_url)
                                setViewingAttachmentTitle(`پاسخ ارسالی شما برای ${p.title}`)
                              }}
                            >
                              مشاهده پاسخ ارسالی 👁️
                            </button>
                          </div>
                        )}

                        {/* Past Due Warning */}
                        {isPastDue && !sub && (
                          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 p-3 rounded-xl font-bold flex items-center gap-2">
                            <span>⚠️</span>
                            <span>مهلت تحویل این تکلیف به پایان رسیده است اما هنوز می‌توانید پاسخ خود را با تاخیر ارسال نمایید.</span>
                          </div>
                        )}

                        {/* Text Answer Input */}
                        <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-3">
                          <label className="block text-xs font-black text-slate-800">
                            ✍️ پاسخ متنی یا توضیحات شما:
                          </label>
                          <textarea
                            rows={3}
                            placeholder="پاسخ، توضیحات یا فرمول‌های حل تکلیف را اینجا بنویسید..."
                            value={currentText}
                            onChange={(e) => updateHomeworkDraft(p.id, e.target.value)}
                            className="w-full px-3.5 py-2.5 text-xs sm:text-sm leading-relaxed border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-sans"
                          />

                          {/* Upload / Staged File & Submit Area */}
                          <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100 flex-wrap">
                            <div className="flex items-center gap-2 flex-wrap">
                              <label className="px-3.5 py-2 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl cursor-pointer transition-colors inline-flex items-center gap-1.5">
                                <span>📷</span>
                                <span>{staged ? 'تغییر عکس یا فایل' : 'پیوست عکس / فایل'}</span>
                                <input
                                  type="file"
                                  accept="image/*,.pdf"
                                  className="hidden"
                                  onChange={(e) =>
                                    e.target.files?.[0] && stageFile(p.id, e.target.files[0])
                                  }
                                />
                              </label>

                              {staged && (
                                <div className="inline-flex items-center gap-2 text-xs bg-slate-100 text-slate-700 border border-slate-200 px-2.5 py-1.5 rounded-lg">
                                  <span>📎 {staged.name} ({(staged.size / 1024).toFixed(0)} KB)</span>
                                  <button
                                    type="button"
                                    className="text-rose-600 hover:text-rose-800 font-bold cursor-pointer"
                                    onClick={() => cancelStaged(p.id)}
                                  >
                                    ✕
                                  </button>
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setExpandedHomeworkId(null)}
                                className="px-3.5 py-2 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
                              >
                                بستن
                              </button>
                              <button
                                type="button"
                                disabled={
                                  sendingPostId === p.id ||
                                  (!staged && !currentText.trim())
                                }
                                onClick={() => sendHomework(p.id)}
                                className="px-4 py-2 text-xs font-black text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed rounded-xl shadow-xs transition-colors cursor-pointer inline-flex items-center gap-1.5"
                              >
                                {sendingPostId === p.id
                                  ? 'در حال ثبت...'
                                  : sub
                                  ? '🔄 ارسال پاسخ جدید'
                                  : '🚀 ثبت و ارسال تکلیف'}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* TAB 3: GRADES & REPORT CARD */}
        {activeTab === 'grades' && (
          <div className="space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            {/* Header & Quick Printable Report Card Launcher */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 sm:p-5 rounded-2xl border border-slate-200/90 shadow-2xs">
              <div>
                <h2 className="text-lg sm:text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <span>📊</span>
                  <span>کارنامه و ریز نمرات دانش‌آموز</span>
                </h2>
                <p className="text-xs text-slate-500 font-medium mt-0.5">
                  دفتر جامع ارزشیابی‌های مستمر، آزمون‌های آنلاین و بازخورد آموزگار
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowReportCardModal(true)}
                className="px-4 py-2 text-xs font-black text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-xs transition-colors cursor-pointer inline-flex items-center justify-center gap-2"
              >
                <span>🖨️</span>
                <span>مشاهده و چاپ کارنامه رسمی (PDF)</span>
              </button>
            </div>

            {/* GPA & Performance Hero Card */}
            <div className="bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white rounded-3xl p-6 sm:p-7 shadow-lg shadow-slate-900/10 border border-slate-800 relative overflow-hidden">
              <div className="relative z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                {/* Left/Main Score Block */}
                <div className="flex items-center gap-4.5">
                  <div className="w-20 h-20 sm:w-22 sm:h-22 rounded-2xl bg-white/10 border border-white/20 backdrop-blur-md flex flex-col items-center justify-center shrink-0 shadow-inner">
                    <span className="text-2xl sm:text-3xl font-black text-emerald-400">
                      {gpa ? toPersianDigits(gpa) : '—'}
                    </span>
                    <span className="text-[10px] font-bold text-slate-300 mt-0.5">از ۲۰</span>
                  </div>

                  <div>
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-400/30 mb-1.5">
                      {gpa && Number(gpa) >= 18 ? 'سطح کیفی: خیلی خوب (ممتاز) ★' : 'سطح کیفی: مطلوب و پویا'}
                    </div>
                    <h3 className="text-lg font-black text-white tracking-tight">
                      میانگین کل نمرات تحصیلی
                    </h3>
                    <p className="text-xs text-slate-300 font-medium mt-1">
                      بر اساس {toPersianDigits(combinedGrades.length)} ارزشیابی کلاسی و آزمون ثبت‌شده
                    </p>
                  </div>
                </div>

                {/* Right/Stats Pillars */}
                <div className="grid grid-cols-2 gap-3 sm:w-auto w-full pt-4 sm:pt-0 border-t sm:border-t-0 border-white/10">
                  <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
                    <div className="text-[11px] text-slate-400 font-medium">حضور در کلاس</div>
                    <div className="text-base font-black text-emerald-300 mt-0.5">
                      {toPersianDigits(attendanceStats.present)} جلسه
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      {toPersianDigits(attendanceStats.absent)} غیبت · {toPersianDigits(attendanceStats.late)} تاخیر
                    </div>
                  </div>

                  <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
                    <div className="text-[11px] text-slate-400 font-medium">تکالیف ارسالی</div>
                    <div className="text-base font-black text-blue-300 mt-0.5">
                      {toPersianDigits(mySubmissions.length)} تکلیف
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      از {toPersianDigits(homeworkPosts.length)} تکلیف کلاسی
                    </div>
                  </div>
                </div>
              </div>

              {/* Decorative subtle ambient lights */}
              <div className="absolute -left-10 -bottom-10 w-44 h-44 bg-indigo-500/20 rounded-full blur-2xl pointer-events-none" />
              <div className="absolute -right-10 -top-10 w-44 h-44 bg-blue-500/20 rounded-full blur-2xl pointer-events-none" />
            </div>

            {/* Teacher Recommendation Note (If set by teacher) */}
            {reportNote && (
              <div className="bg-amber-50/80 border border-amber-200/90 rounded-2xl p-5 shadow-2xs relative overflow-hidden">
                <div className="flex items-center gap-2.5 text-amber-900 font-black text-sm mb-2">
                  <span className="text-xl">💬</span>
                  <span>یادداشت و توصیه آموزگار محترم:</span>
                </div>
                <p className="text-xs sm:text-sm text-amber-950 leading-relaxed font-medium whitespace-pre-wrap pr-1">
                  {reportNote}
                </p>
              </div>
            )}

            {/* Skills & Subject Mastery */}
            {skillGroups.length > 0 ? (
              <div className="space-y-6">
                <div>
                  <h3 className="text-base font-black text-slate-900 tracking-tight flex items-center gap-2 mb-3">
                    <span>📚</span>
                    <span>میانگین عملکرد به تفکیک دروس</span>
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5">
                    {skillGroups.map((sg) => {
                      const avgNum = sg.avg || 0
                      const percent = Math.min(100, Math.round((avgNum / 20) * 100))
                      return (
                        <div
                          key={sg.subject}
                          className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between"
                        >
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-black text-slate-900">{sg.subject}</span>
                              <span className="text-xs font-black text-blue-700 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-100">
                                {toPersianDigits(avgNum.toFixed(1))} از ۲۰
                              </span>
                            </div>

                            {/* Progress bar */}
                            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden mb-3">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${
                                  avgNum >= 16
                                    ? 'bg-emerald-500'
                                    : avgNum >= 12
                                    ? 'bg-amber-500'
                                    : 'bg-rose-500'
                                }`}
                                style={{ width: `${percent}%` }}
                              />
                            </div>

                            {sg.skills.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mt-2">
                                {sg.skills.map((sk) => (
                                  <span
                                    key={sk.skill}
                                    className="text-[11px] font-bold text-slate-600 bg-slate-50 border border-slate-200/80 px-2 py-0.5 rounded-md"
                                  >
                                    {sk.color} {sk.skill}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Detailed Registered Grades List */}
                <div>
                  <h3 className="text-base font-black text-slate-900 tracking-tight flex items-center gap-2 mb-3">
                    <span>📝</span>
                    <span>ریز نمرات، آزمون‌ها و فعالیت‌های کلاسی</span>
                  </h3>
                  <div className="space-y-2.5">
                    {combinedGrades.map((g, idx) => {
                      const rawEarned = Number(g.score) || 0
                      const rawTotal = Number(g.max_score) || 20
                      const normalized = rawTotal > 0 ? Math.round(((rawEarned / rawTotal) * 20) * 10) / 10 : rawEarned
                      let badgeColor = 'text-emerald-700 bg-emerald-50 border-emerald-200'
                      let badgeLabel = 'خیلی خوب'
                      if (normalized < 12) {
                        badgeColor = 'text-rose-700 bg-rose-50 border-rose-200'
                        badgeLabel = 'نیازمند تلاش'
                      } else if (normalized < 15) {
                        badgeColor = 'text-amber-700 bg-amber-50 border-amber-200'
                        badgeLabel = 'قابل قبول'
                      } else if (normalized < 18) {
                        badgeColor = 'text-blue-700 bg-blue-50 border-blue-200'
                        badgeLabel = 'خوب'
                      }

                      const hasReview = Boolean(g.matchedExam && g.matchedSub)

                      return (
                        <div
                          key={g.id || idx}
                          className={`bg-white border rounded-2xl p-3.5 sm:p-4 transition-all flex items-center justify-between gap-3 ${
                            hasReview
                              ? 'border-blue-200 hover:border-blue-400 hover:shadow-xs cursor-pointer'
                              : 'border-slate-200/80'
                          }`}
                          onClick={() => {
                            if (hasReview) {
                              setReviewExamData({
                                exam: g.matchedExam,
                                submission: g.matchedSub,
                              })
                            }
                          }}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div
                              className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 text-base ${
                                hasReview
                                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                  : 'bg-slate-50 text-slate-600 border border-slate-200'
                              }`}
                            >
                              {hasReview ? '📋' : '📝'}
                            </div>

                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                                <span className="font-black text-sm text-slate-900">
                                  {g.subject || 'عمومی'}
                                </span>
                                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md border ${badgeColor}`}>
                                  {badgeLabel}
                                </span>
                              </div>
                              <div className="text-xs text-slate-500 truncate max-w-sm">
                                {sanitizeTeacherFeedback(g.skill || g.notes || 'ارزیابی مستمر و فعالیت کلاسی')}
                              </div>
                              {hasReview && (
                                <div className="text-[11px] text-blue-600 font-black mt-1">
                                  🔍 برای مشاهده سوالات و پاسخ‌نامه کلیک کنید
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="text-left shrink-0">
                            <div className="text-base sm:text-lg font-black text-slate-900">
                              <span
                                className={
                                  normalized >= 16
                                    ? 'text-emerald-700'
                                    : normalized >= 12
                                    ? 'text-amber-700'
                                    : 'text-rose-700'
                                }
                              >
                                {toPersianDigits(normalized)}
                              </span>
                              <span className="text-xs text-slate-400 mr-1 font-bold">از ۲۰</span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-white border border-slate-200/80 rounded-2xl p-8 text-center shadow-xs">
                <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-slate-50 text-slate-400 flex items-center justify-center text-2xl shadow-2xs">
                  📊
                </div>
                <h4 className="text-sm font-black text-slate-800 mb-1">
                  هنوز نمره‌ای برای شما ثبت نشده است
                </h4>
                <p className="text-xs text-slate-500 max-w-sm mx-auto">
                  ارزیابی‌های کلاسی و نمرات آزمون‌ها پس از ثبت توسط آموزگار در این بخش نمایش داده می‌شوند.
                </p>
              </div>
            )}
          </div>
        )}

        {/* TAB: TIZHOOSHAN DUOLINGO PREP */}
        {activeTab === 'tizhooshan' && (
          <div className="space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            <TizhooshanPrep student={student} />
          </div>
        )}

        {/* TAB 5: PROFILE & SETTINGS */}
        {activeTab === 'profile' && (
          <div className="max-w-xl mx-auto space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            <div>
              <h2 className="text-xl font-black text-slate-900 tracking-tight">حساب کاربری دانش‌آموز</h2>
              <p className="text-xs text-slate-500 font-medium mt-0.5">مشخصات، نمایه و تنظیمات امنیت ورود به سامانه</p>
            </div>

            {/* Profile Info Card with Circular Uploadable Avatar & Centered Name */}
            <div className="bg-white border border-slate-200/90 rounded-3xl p-6 sm:p-8 text-center shadow-xs flex flex-col items-center justify-center">
              <label
                htmlFor="student-avatar-input"
                className="cursor-pointer relative inline-block mb-3 group"
                title="برای انتخاب یا تغییر تصویر کلیک کنید"
              >
                <div className="w-24 h-24 rounded-full bg-slate-100 border-3 border-white shadow-md flex items-center justify-center overflow-hidden ring-2 ring-blue-500/20 group-hover:ring-blue-500 transition-all">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={student?.full_name || 'دانش‌آموز'}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-4xl">🧒</span>
                  )}
                </div>
                <div className="absolute bottom-0 left-0 bg-blue-600 text-white w-7 h-7 rounded-full border-2 border-white flex items-center justify-center text-xs shadow-xs">
                  📷
                </div>
                <input
                  id="student-avatar-input"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarUpload}
                />
              </label>

              <span className="text-[11px] text-slate-400 font-bold mb-2">
                برای انتخاب یا تغییر تصویر کلیک کنید
              </span>

              <h3 className="text-xl sm:text-2xl font-black text-slate-900 mt-1 mb-0.5">
                {student?.full_name || 'دانش‌آموز'}
              </h3>
              <p className="text-xs text-slate-500 font-bold">
                پایه ششم دبستان هوشمند حضرت قائم (عج)
              </p>

              <div className="mt-4 pt-4 border-t border-slate-100 w-full flex items-center justify-around text-xs text-slate-600 font-bold">
                <div>
                  <span className="text-slate-400 block text-[11px]">کد ورود / دانش‌آموزی</span>
                  <span className="font-mono text-slate-900 mt-0.5 block">
                    {toPersianDigits(student?.access_code || student?.id || '—')}
                  </span>
                </div>
                <div className="h-6 w-px bg-slate-200" />
                <div>
                  <span className="text-slate-400 block text-[11px]">تعداد ارزشیابی‌ها</span>
                  <span className="text-blue-700 mt-0.5 block">
                    {toPersianDigits(combinedGrades.length)} مورد
                  </span>
                </div>
                <div className="h-6 w-px bg-slate-200" />
                <div>
                  <span className="text-slate-400 block text-[11px]">کارنامه رسمی</span>
                  <button
                    type="button"
                    onClick={() => setShowReportCardModal(true)}
                    className="text-emerald-700 hover:text-emerald-800 underline mt-0.5 block cursor-pointer"
                  >
                    مشاهده 🖨️
                  </button>
                </div>
              </div>
            </div>

            {/* Change Password Form */}
            <div className="bg-white border border-slate-200/90 rounded-3xl p-6 shadow-xs">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-lg">🔐</span>
                <h3 className="text-base font-black text-slate-900">
                  تغییر رمز عبور ورود
                </h3>
              </div>
              <form onSubmit={changeAccessCode} className="space-y-4">
                <div>
                  <label className="block text-xs font-black text-slate-700 mb-1.5 text-right">
                    رمز عبور فعلی:
                  </label>
                  <input
                    type="password"
                    value={oldCode}
                    onChange={(e) => setOldCode(e.target.value)}
                    placeholder="رمز فعلی یا کد ملی"
                    required
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-right font-sans"
                  />
                </div>

                <div>
                  <label className="block text-xs font-black text-slate-700 mb-1.5 text-right">
                    رمز عبور جدید:
                  </label>
                  <input
                    type="password"
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value)}
                    placeholder="رمز جدید مد نظر خود را وارد کنید"
                    required
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-right font-sans"
                  />
                </div>

                {codeMsg && (
                  <div
                    className={`text-xs font-bold text-center p-2.5 rounded-xl border ${
                      codeMsg.includes('خطا')
                        ? 'bg-rose-50 text-rose-800 border-rose-200'
                        : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    }`}
                  >
                    {codeMsg}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={codeBusy}
                  className="w-full py-2.5 text-xs font-black text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-xl shadow-xs transition-colors cursor-pointer"
                >
                  {codeBusy ? 'در حال ثبت...' : 'ذخیره رمز جدید'}
                </button>
              </form>
            </div>

            {/* Logout button */}
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={onLogout}
                className="inline-flex items-center gap-2 px-5 py-2 text-xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl transition-colors cursor-pointer shadow-2xs"
              >
                <span>🚪</span>
                <span>خروج از حساب کاربری دانش‌آموز</span>
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Mobile Bottom Tab Bar */}
      <MobileTabBar
        tabs={tabs}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as StudentTab)}
      />

      {/* Student Official Report Card Modal */}
      {showReportCardModal && (
        <StudentReportCard
          student={student}
          grades={combinedGrades}
          attendanceRows={myAttendance}
          submissions={mySubmissions}
          homeworkCount={homeworkPosts.length}
          reportNote={reportNote || undefined}
          onClose={() => setShowReportCardModal(false)}
        />
      )}

      {/* Student Exam Taker Fullscreen Popup Modal */}
      {takingExam && (
        <StudentExamTaker
          exam={takingExam}
          student={student}
          onClose={() => setTakingExam(null)}
          onFinished={() => {
            loadAll()
          }}
        />
      )}

      {/* Attachment Viewer Modal for Homework and Files */}
      {viewingAttachmentUrl && (
        <AttachmentViewerModal
          url={viewingAttachmentUrl}
          title={viewingAttachmentTitle || 'فایل پیوست'}
          onClose={() => setViewingAttachmentUrl(null)}
        />
      )}
    </div>
  )
}

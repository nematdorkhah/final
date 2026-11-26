import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { supabase, getServerTimeOffsetMs } from '../supabaseClient'
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
import { Exam, StudentExamSubmission } from '../types/examTypes'
import {
  fetchPublishedExamsWithDiagnostics,
  fetchExamSubmissions,
  fetchStudentExamReview,
  StudentExamReviewQuestionItem,
  getStudentExamSubmission,
  sanitizeExamTitle,
  getLocalStudentExams,
  saveLocalStudentExams,
  getLocalSubmissions,
  flushPendingExamSyncQueue,
  isExamResultsReleased,
  mergeSubmissionsDeduplicated,
  buildCanonicalGradesList,
} from '../utils/examStore'
import { isItemExpiredForStudent } from '../utils/expiration'
import { sanitizeTeacherFeedback } from '../utils/cleanFeedback'
import { toPersianDigits } from '../utils/persianNumbers'
import { roundScore2 } from '../utils/persianSemanticGrader'
import { resolveCanonicalStudent, isSameStudent, resolveStudentAccessCode } from '../classStudents'
import {
  realtimeSync,
  fetchStudentPollFingerprint,
  hasFingerprintEntryChanged,
  isValidUuid,
  StudentPollFingerprint,
} from '../services/realtimeSync'
import {
  retryWithBackoff,
  fetchApiJson,
  fetchFilteredPublishedPosts,
  sanitizeExamForStudent,
  isBackendStaticOnly,
  parseExamTimestampMs,
  classifyExamForStudent,
} from '../utils/networkResilience'


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
  const [posts, setPosts] = useState<any[]>(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('cached_published_posts')
        if (raw) return JSON.parse(raw)
      }
    } catch {}
    return []
  })
  const [mySubmissions, setMySubmissions] = useState<any[]>(() => {
    try {
      if (typeof localStorage !== 'undefined' && student?.id) {
        const raw = localStorage.getItem(`cached_submissions_${student.id}`)
        if (raw) return JSON.parse(raw)
      }
    } catch {}
    return []
  })
  const [myGrades, setMyGrades] = useState<any[]>(() => {
    try {
      if (typeof localStorage !== 'undefined' && student?.id) {
        const raw = localStorage.getItem(`cached_grades_${student.id}`)
        if (raw) return JSON.parse(raw)
      }
    } catch {}
    return []
  })
  const [myAttendance, setMyAttendance] = useState<any[]>(() => {
    try {
      if (typeof localStorage !== 'undefined' && student?.id) {
        const raw = localStorage.getItem(`cached_attendance_${student.id}`)
        if (raw) return JSON.parse(raw)
      }
    } catch {}
    return []
  })
  const [exams, setExams] = useState<Exam[]>(() => {
    try {
      const cached = getLocalStudentExams()
      if (Array.isArray(cached) && cached.length > 0) {
        return cached.filter((e) => e.published !== false)
      }
    } catch {}
    return []
  })
  const [examsDataSource, setExamsDataSource] = useState<'loading' | 'server' | 'cache' | 'error'>(() => {
    try {
      const hasCachedExams = getLocalStudentExams().some((e) => e && e.published !== false)
      return hasCachedExams ? 'cache' : 'loading'
    } catch {}
    return 'loading'
  })
  const [takingExam, setTakingExam] = useState<Exam | null>(null)
  const [fetchStatus, setFetchStatus] = useState<'loading' | 'ready' | 'error'>(() => {
    try {
      const hasCachedExams = getLocalStudentExams().some((e) => e && e.published !== false)
      const rawPosts = typeof localStorage !== 'undefined' ? localStorage.getItem('cached_published_posts') : null
      const hasCachedPosts = Boolean(rawPosts && JSON.parse(rawPosts).length > 0)
      if (hasCachedExams || hasCachedPosts) return 'ready'
    } catch {}
    return 'loading'
  })
  const [examsFetchStatus, setExamsFetchStatus] = useState<'loading' | 'ready' | 'error'>(() => {
    try {
      const hasCachedExams = getLocalStudentExams().some((e) => e && e.published !== false)
      if (hasCachedExams) return 'ready'
    } catch {}
    return 'loading'
  })
  const [postsFetchStatus, setPostsFetchStatus] = useState<'loading' | 'ready' | 'error'>(() => {
    try {
      const rawPosts = typeof localStorage !== 'undefined' ? localStorage.getItem('cached_published_posts') : null
      if (rawPosts && JSON.parse(rawPosts).length > 0) return 'ready'
    } catch {}
    return 'loading'
  })
  const [gradesFetchStatus, setGradesFetchStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [submissionsFetchStatus, setSubmissionsFetchStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loading, setLoading] = useState(() => {
    try {
      const hasCachedExams = getLocalStudentExams().some((e) => e && e.published !== false)
      const rawPosts = typeof localStorage !== 'undefined' ? localStorage.getItem('cached_published_posts') : null
      const hasCachedPosts = Boolean(rawPosts && JSON.parse(rawPosts).length > 0)
      if (hasCachedExams || hasCachedPosts) return false
    } catch {}
    return true
  })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [syncWarning, setSyncWarning] = useState<string | null>(null)
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
  const [reviewExamData, setReviewExamData] = useState<{
    exam: any
    submission: any
    questionsReview?: StudentExamReviewQuestionItem[]
    scaledScore20?: number | null
    forceReleased?: boolean
  } | null>(null)
  const [openingReviewId, setOpeningReviewId] = useState<string | null>(null)
  const [reviewErrorMsg, setReviewErrorMsg] = useState<string | null>(null)
  const [myExamSubs, setMyExamSubs] = useState<StudentExamSubmission[]>([])
  const [showReportCardModal, setShowReportCardModal] = useState(false)
  const [reportCardLoading, setReportCardLoading] = useState(false)
  const [reportCardError, setReportCardError] = useState<string | null>(null)
  const reportCardReqSeqRef = useRef(0)
  const [isManualRefreshing, setIsManualRefreshing] = useState(false)
  const [currentTime, setCurrentTime] = useState(Date.now())
  const hasLoadedOnce = useRef(false)
  const requestSeqRef = useRef(0)
  const inFlightLoadRef = useRef<{ promise: Promise<void>; seq: number } | null>(null)
  const inFlightPollRef = useRef<Promise<void> | null>(null)
  const lastPollFingerprintRef = useRef<StudentPollFingerprint | null>(null)
  const hasRemoteSyncedRef = useRef(false)
  const lastBackgroundSyncAtRef = useRef(0)
  const serverTimeOffsetRef = useRef(getServerTimeOffsetMs())

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
      // Align with the server clock (measured from HTTP Date headers) so a wrong device clock never hides new items
      serverTimeOffsetRef.current = getServerTimeOffsetMs()
      setCurrentTime(Date.now())
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // Helper to format remaining time until exam starts (consistent UTC/ISO parsing)
  function getExamCountdownInfo(scheduledStartTime?: string) {
    const startMs = parseExamTimestampMs(scheduledStartTime)
    if (startMs === null) {
      return {
        isStarted: true,
        timeLabel: '--:--',
        remainingText: 'در حال برگزاری',
        badgeText: '🟢 آماده برگزاری',
      }
    }
    const diffMs = startMs - (currentTime + serverTimeOffsetRef.current)

    // Exact scheduled time formatted in Persian local display
    const startDate = new Date(startMs)
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
    if (title.includes('__SYSTEM_') || title.includes('__EXAM_SUB__') || title.includes('__EXAM_DRAFT__')) return true
    if (item.type === 'exam') return true
    return false
  }

  async function loadAll(force = false, options?: { background?: boolean }): Promise<void> {
    const isBackground = Boolean(options?.background)
    if ((!force || isBackground) && inFlightLoadRef.current) {
      return inFlightLoadRef.current.promise
    }

    const seq = ++requestSeqRef.current
    const runPromise = (async () => {
      // 1. Instant Cache Hydration: Show temporary cached data while fetching authoritative server data
      const localExams = getLocalStudentExams().filter((e) => e && e.published !== false)
      const localPosts = (() => {
        try {
          const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('cached_published_posts') : null
          return raw ? JSON.parse(raw) : []
        } catch {
          return []
        }
      })()
      const hasCachedData = localExams.length > 0 || localPosts.length > 0

      if (localExams.length > 0) {
        setExams((prev) => (prev.length > 0 ? prev : localExams))
      }
      const localSubs = getLocalSubmissions()
      if (localSubs.length > 0) {
        setMyExamSubs((prev) => (prev.length > 0 ? prev : localSubs))
      }

      if (hasLoadedOnce.current || hasCachedData || isBackground) {
        setLoading(false)
      } else {
        setLoading(true)
        setFetchStatus('loading')
        setExamsFetchStatus('loading')
        setExamsDataSource('loading')
      }
      if (!isBackground) {
        setLoadError(null)
        setSyncWarning(null)
      }

      const rawId = student?.id || student?.access_code
      const rosterInfo = resolveCanonicalStudent(rawId || student?.full_name)
      const canonicalStudentId = rosterInfo?.id || rawId
      const canonicalAccessCode = resolveStudentAccessCode(student)

      if (!canonicalStudentId) {
        if (seq === requestSeqRef.current) {
          setLoading(false)
          setFetchStatus('error')
          setExamsFetchStatus('error')
          setLoadError('اطلاعات کاربری دانش‌آموز معتبر نیست. لطفاً مجدداً وارد شوید.')
        }
        return
      }

      const withTimeout = async <T,>(promise: PromiseLike<T> | Promise<T>, ms = 35000): Promise<T> => {
        return Promise.race([
          Promise.resolve(promise),
          new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
        ])
      }

      let bundleOk = false
      let postsRemoteOk = false
      let examsRemoteOk = false
      let gradesRemoteOk = false
      let subsRemoteOk = false

      // 2. Execute Bundle Fetch (skipped immediately when static-only Netlify host detected) + Independent Parallel Direct Supabase Calls
      const bundlePromise = isBackendStaticOnly()
        ? Promise.reject(Object.assign(new Error('HTML_SPA_FALLBACK_ON_API_ROUTE'), { isHtmlFallback: true, status: 404 }))
        : retryWithBackoff(
            async () => {
              const json = await fetchApiJson<any>(
                `/api/classroom/bundle?studentId=${encodeURIComponent(canonicalStudentId)}${force ? '&fresh=1' : ''}`,
                { headers: { 'Cache-Control': 'no-cache' } },
                5500
              )
              if (!json || !json.success) {
                throw new Error(json?.error || 'Bundle fetch failed')
              }
              return json
            },
            { maxRetries: 2, baseDelayMs: 300, stage: 'classroom_bundle' }
          ).then((bundleOutcome) => {
            if (seq !== requestSeqRef.current) return bundleOutcome
            const bundleRes = bundleOutcome.data
            bundleOk = true
            postsRemoteOk = true
            examsRemoteOk = true

            if (typeof bundleRes.serverTime === 'number' && !isNaN(bundleRes.serverTime)) {
              serverTimeOffsetRef.current = bundleRes.serverTime - Date.now()
            }

            if (Array.isArray(bundleRes.posts)) {
              const cleanPosts = bundleRes.posts.filter((p: any) => !isSystemRecord(p))
              setPosts(cleanPosts)
              setPostsFetchStatus('ready')
              try {
                localStorage.setItem('cached_published_posts', JSON.stringify(cleanPosts))
              } catch {}
            }

            if (Array.isArray(bundleRes.exams)) {
              const validExams = bundleRes.exams
                .filter((e: Exam) => e && e.published !== false)
                .map(sanitizeExamForStudent)
              setExams(validExams)
              saveLocalStudentExams(validExams)
              setFetchStatus('ready')
              setExamsFetchStatus('ready')
              setExamsDataSource('server')
              setLoading(false)
              hasLoadedOnce.current = true
            }

            if (Array.isArray(bundleRes.examSubmissions)) {
              const mySubs = bundleRes.examSubmissions.filter((s: StudentExamSubmission) =>
                isSameStudent(s.studentId, canonicalStudentId, s.studentName, student?.full_name)
              )
              if (mySubs.length > 0) {
                setMyExamSubs(mySubs)
              }
            }
            return bundleOutcome
          })

      // Each Supabase stream resolves and updates UI independently — no single timeout can break the others
      const postsPromise = withTimeout<any[]>(
        fetchFilteredPublishedPosts(supabase, {
          includeScheduledFuture: false,
        }),
        35000
      ).then((rows) => {
        if (seq !== requestSeqRef.current || !Array.isArray(rows)) return
        postsRemoteOk = true
        const cleanPosts = rows.filter((post: any) => !isSystemRecord(post))
        if (cleanPosts.length > 0 || !bundleOk) {
          setPosts(cleanPosts)
          try {
            localStorage.setItem('cached_published_posts', JSON.stringify(cleanPosts))
          } catch {}
        }
        setPostsFetchStatus('ready')
        setLoading(false)
      })

      const examsPromise = withTimeout(
        fetchPublishedExamsWithDiagnostics(true, force, {
          skipBackendApi: true,
          requestSource: isBackground ? 'student_dashboard_bg' : 'student_dashboard',
        }),
        45000
      ).then((diag) => {
        if (seq !== requestSeqRef.current) return
        if (diag.remoteOk) {
          examsRemoteOk = true
          setExams(diag.exams)
          setExamsFetchStatus('ready')
          setExamsDataSource('server')
          setFetchStatus('ready')
          setSyncWarning(null)
          setLoadError(null)
          setLoading(false)
          hasLoadedOnce.current = true
        }
      })

      const subsPromise = withTimeout<any>(
        supabase.rpc('student_list_my_submissions', {
          p_student_id: canonicalStudentId,
          p_access_code: canonicalAccessCode,
        }),
        35000
      ).then((res) => {
        if (seq !== requestSeqRef.current) return
        if (!res?.error && Array.isArray(res?.data)) {
          subsRemoteOk = true
          setMySubmissions(res.data || [])
          setSubmissionsFetchStatus('ready')
          try {
            localStorage.setItem(`cached_submissions_${canonicalStudentId}`, JSON.stringify(res.data || []))
          } catch {}
        }
      })

      const gradesPromise = withTimeout<any>(
        supabase.rpc('student_list_my_grades', {
          p_student_id: canonicalStudentId,
          p_access_code: canonicalAccessCode,
        }),
        35000
      ).then((res) => {
        if (seq !== requestSeqRef.current) return
        if (!res?.error && Array.isArray(res?.data)) {
          gradesRemoteOk = true
          setMyGrades(res.data || [])
          setGradesFetchStatus('ready')
          try {
            localStorage.setItem(`cached_grades_${canonicalStudentId}`, JSON.stringify(res.data || []))
          } catch {}
        }
      })

      const attPromise = withTimeout<any>(
        supabase.rpc('student_list_my_attendance', {
          p_student_id: canonicalStudentId,
          p_access_code: canonicalAccessCode,
        }),
        35000
      ).then((res) => {
        if (seq !== requestSeqRef.current) return
        if (!res?.error && Array.isArray(res?.data)) {
          setMyAttendance(res.data || [])
        }
      })

      const examSubsPromise = withTimeout<StudentExamSubmission[]>(
        fetchExamSubmissions(undefined, canonicalStudentId, force, undefined, canonicalAccessCode),
        35000
      ).then((list) => {
        if (seq !== requestSeqRef.current) return
        if (Array.isArray(list)) {
          subsRemoteOk = true
          setMyExamSubs(list)
          setSubmissionsFetchStatus('ready')
        }
      })

      await Promise.allSettled([
        bundlePromise.catch((e: any) => {
          if (!e?.isHtmlFallback) {
            console.warn('[StudentDashboard] Bundle sync skipped/failed, relying on direct Supabase:', e)
          }
        }),
        postsPromise,
        examsPromise,
        subsPromise,
        gradesPromise,
        attPromise,
        examSubsPromise,
      ])

      if (seq !== requestSeqRef.current) return

      setLoading(false)
      hasLoadedOnce.current = true

      if (!postsRemoteOk && localPosts.length === 0) setPostsFetchStatus('error')
      if (!gradesRemoteOk) setGradesFetchStatus(myGrades.length > 0 ? 'ready' : 'error')
      if (!subsRemoteOk) setSubmissionsFetchStatus(myExamSubs.length > 0 ? 'ready' : 'error')

      // STRICT SERVER-VS-CACHE-VS-ERROR EVALUATION FOR EXAMS & POSTS:
      // Never treat stale cached exams as verified server data; always warn clearly when remote exam retrieval failed.
      if (examsRemoteOk && postsRemoteOk) {
        hasRemoteSyncedRef.current = true
        setFetchStatus('ready')
        setExamsFetchStatus('ready')
        setExamsDataSource('server')
        setLoadError(null)
        setSyncWarning(null)
      } else if (isBackground && (hasLoadedOnce.current || hasCachedData)) {
        if (examsRemoteOk || postsRemoteOk) {
          hasRemoteSyncedRef.current = true
        }
        if (examsRemoteOk) {
          setExamsFetchStatus('ready')
          setExamsDataSource('server')
          setSyncWarning(null)
        } else {
          setExamsDataSource((prev) => (prev === 'server' || localExams.length > 0 ? 'cache' : 'error'))
          setSyncWarning('ارتباط با سرور برای دریافت جدیدترین آزمون‌ها برقرار نشد؛ نسخه ذخیره‌شده قبلی نمایش داده می‌شود.')
        }
        if (postsRemoteOk) {
          setFetchStatus('ready')
        }
      } else if (examsRemoteOk || postsRemoteOk) {
        hasRemoteSyncedRef.current = true
        setFetchStatus(postsRemoteOk || localPosts.length > 0 ? 'ready' : 'error')
        setExamsFetchStatus(examsRemoteOk ? 'ready' : (localExams.length > 0 ? 'ready' : 'error'))
        setExamsDataSource(examsRemoteOk ? 'server' : (localExams.length > 0 ? 'cache' : 'error'))
        if (!examsRemoteOk) {
          setSyncWarning('ارتباط برای دریافت جدیدترین آزمون‌ها برقرار نشد؛ در صورت وجود، نسخه ذخیره‌شده قبلی نمایش داده می‌شود. لطفاً دوباره تلاش کنید.')
          setLoadError('دریافت جدیدترین آزمون‌ها از پایگاه داده با خطا مواجه شد.')
        } else {
          setLoadError(null)
          setSyncWarning(null)
        }
      } else if (hasCachedData) {
        // Keep cached exams/posts visible, warn clearly instead of pretending server is verified/empty
        setFetchStatus(localPosts.length > 0 || localExams.length > 0 ? 'ready' : 'error')
        setExamsFetchStatus(localExams.length > 0 ? 'ready' : 'error')
        setExamsDataSource(localExams.length > 0 ? 'cache' : 'error')
        setSyncWarning('اتصال به سرور با خطا مواجه شد؛ اطلاعات ذخیره‌شده قبلی نمایش داده می‌شود. برای دریافت جدیدترین آزمون‌ها دوباره تلاش کنید.')
        setLoadError('اختلال در دریافت اطلاعات جدید از سرور.')
      } else {
        setFetchStatus('error')
        setExamsFetchStatus('error')
        setExamsDataSource('error')
        setLoadError('خطا در دریافت اطلاعات و آزمون‌ها از سرور. لطفاً اتصال اینترنت را بررسی کرده و دکمه «تلاش مجدد» را بزنید.')
      }
    })().finally(() => {
      lastBackgroundSyncAtRef.current = Date.now()
      if (inFlightLoadRef.current?.seq === seq) {
        inFlightLoadRef.current = null
      }
    })

    inFlightLoadRef.current = { promise: runPromise, seq }
    return runPromise
  }

  useEffect(() => {
    let isMounted = true

    const resolveStudentCredentials = () => {
      const rawId = student?.id || student?.access_code
      const rosterInfo = resolveCanonicalStudent(rawId || student?.full_name)
      return {
        canonicalStudentId: rosterInfo?.id || rawId || '',
        canonicalAccessCode: resolveStudentAccessCode(student),
      }
    }

    const refreshPostsSection = async () => {
      const rows = await fetchFilteredPublishedPosts(supabase, {
        includeScheduledFuture: false,
      })
      if (!isMounted || !Array.isArray(rows)) return
      const cleanPosts = rows.filter((post: any) => !isSystemRecord(post))
      setPosts(cleanPosts)
      setPostsFetchStatus('ready')
      setFetchStatus('ready')
      try {
        localStorage.setItem('cached_published_posts', JSON.stringify(cleanPosts))
      } catch {}
    }

    const refreshExamsSection = async () => {
      const diag = await fetchPublishedExamsWithDiagnostics(true, true, {
        skipBackendApi: true,
        requestSource: 'student_realtime_or_poll',
      })
      if (!isMounted) return
      if (!diag.remoteOk) {
        setExamsDataSource((prev) => (prev === 'server' || diag.exams.length > 0 ? 'cache' : 'error'))
        setSyncWarning('بروزرسانی لحظه‌ای آزمون‌ها از سرور ناموفق بود؛ در صورت وجود نسخه قبلی نمایش داده می‌شود.')
        return
      }
      setExams(diag.exams)
      setExamsFetchStatus('ready')
      setExamsDataSource('server')
      setFetchStatus('ready')
      setSyncWarning(null)
      setLoadError(null)
      hasLoadedOnce.current = true
    }

    const refreshGradesSection = async () => {
      const { canonicalStudentId, canonicalAccessCode } = resolveStudentCredentials()
      if (!canonicalStudentId || !canonicalAccessCode) return
      const res = await supabase.rpc('student_list_my_grades', {
        p_student_id: canonicalStudentId,
        p_access_code: canonicalAccessCode,
      })
      if (!isMounted || res?.error || !Array.isArray(res?.data)) return
      setMyGrades(res.data)
      setGradesFetchStatus('ready')
      try {
        localStorage.setItem(`cached_grades_${canonicalStudentId}`, JSON.stringify(res.data))
      } catch {}
    }

    const refreshQuizSubmissionsSection = async () => {
      const { canonicalStudentId, canonicalAccessCode } = resolveStudentCredentials()
      if (!canonicalStudentId) return
      const list = await fetchExamSubmissions(undefined, canonicalStudentId, true, undefined, canonicalAccessCode)
      if (!isMounted || !Array.isArray(list)) return
      setMyExamSubs(list)
      setSubmissionsFetchStatus('ready')
    }

    const refreshHomeworkSubmissionsSection = async () => {
      const { canonicalStudentId, canonicalAccessCode } = resolveStudentCredentials()
      if (!canonicalStudentId || !canonicalAccessCode) return
      const res = await supabase.rpc('student_list_my_submissions', {
        p_student_id: canonicalStudentId,
        p_access_code: canonicalAccessCode,
      })
      if (!isMounted || res?.error || !Array.isArray(res?.data)) return
      setMySubmissions(res.data)
      setSubmissionsFetchStatus('ready')
      try {
        localStorage.setItem(`cached_submissions_${canonicalStudentId}`, JSON.stringify(res.data))
      } catch {}
    }

    const NORMAL_POLL_MS = 30000
    const ERROR_BACKOFF_POLL_MS = 45000
    // Safety net: even when the fingerprint says "no change", re-read homework & exams directly at this interval
    const DIRECT_REFRESH_EVERY_MS = 90000
    let lastDirectRefreshAt = Date.now()
    let currentPollDelayMs = NORMAL_POLL_MS
    let hasRpcError = false
    let lastRpcErrorAt = 0
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    // Guard: if student.id is not a valid UUID (e.g. test_preview_student), never run fingerprint polling at all
    const hasValidStudentUuid = (() => {
      if (!isValidUuid(student?.id)) return false
      const { canonicalStudentId } = resolveStudentCredentials()
      return isValidUuid(canonicalStudentId)
    })()

    const scheduleNextPollTimer = () => {
      if (!isMounted || !hasValidStudentUuid) return
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = setTimeout(() => {
        if (!isMounted) return
        if (typeof document !== 'undefined' && document.hidden) {
          scheduleNextPollTimer()
          return
        }
        scheduleBackupPoll(false)
      }, currentPollDelayMs)
    }

    loadAll(false).finally(() => {
      if (!isMounted || !hasValidStudentUuid || lastPollFingerprintRef.current !== null) return
      const { canonicalStudentId, canonicalAccessCode } = resolveStudentCredentials()
      if (!isValidUuid(canonicalStudentId) || !canonicalAccessCode) return
      fetchStudentPollFingerprint(canonicalStudentId, canonicalAccessCode)
        .then((res) => {
          if (!isMounted || res.skipped) return
          if (res.ok && res.data) {
            hasRpcError = false
            currentPollDelayMs = NORMAL_POLL_MS
            if (lastPollFingerprintRef.current === null) {
              lastPollFingerprintRef.current = res.data
            }
          } else {
            hasRpcError = true
            lastRpcErrorAt = Date.now()
            currentPollDelayMs = ERROR_BACKOFF_POLL_MS
            scheduleNextPollTimer()
          }
        })
        .catch(() => {
          if (!isMounted) return
          hasRpcError = true
          lastRpcErrorAt = Date.now()
          currentPollDelayMs = ERROR_BACKOFF_POLL_MS
          scheduleNextPollTimer()
        })
    })
    flushPendingExamSyncQueue().catch(() => {})

    // Primary channel: Realtime (broadcast + postgres_changes)
    realtimeSync.init()
    const unsubscribe = realtimeSync.subscribe((event) => {
      if (event.type === 'post') {
        if (event.action === 'create' && event.item && !isSystemRecord(event.item)) {
          // Guard against scheduled future posts appearing early (using server-offset corrected clock)
          const nowCorrected = Date.now() + serverTimeOffsetRef.current
          const isFuture = event.item.publish_at && new Date(event.item.publish_at).getTime() > nowCorrected
          if (!isFuture) {
            setPosts((prev) => {
              const exists = prev.some((p) => p.id === event.item.id)
              if (exists) return prev.map((p) => (p.id === event.item.id ? { ...p, ...event.item } : p))
              const updated = [event.item, ...prev]
              try {
                localStorage.setItem('cached_published_posts', JSON.stringify(updated))
              } catch {}
              return updated
            })
            setFetchStatus('ready')
          }
        } else if (event.action === 'update' && event.item) {
          setPosts((prev) => {
            const updated = prev.map((p) =>
              p.id === event.id || p.id === event.item.id ? { ...p, ...event.item } : p
            )
            try {
              localStorage.setItem('cached_published_posts', JSON.stringify(updated))
            } catch {}
            return updated
          })
        } else if (event.action === 'delete' && event.id) {
          setPosts((prev) => {
            const updated = prev.filter((p) => p.id !== event.id)
            try {
              localStorage.setItem('cached_published_posts', JSON.stringify(updated))
            } catch {}
            return updated
          })
        }
      } else if (event.type === 'exam') {
        if (event.action === 'create' || event.action === 'update') {
          if (event.item) {
            const safeExam = sanitizeExamForStudent(event.item)
            if (safeExam.published === false) {
              setExams((prev) => prev.filter((e) => e.id !== safeExam.id))
            } else {
              setExams((prev) => {
                const exists = prev.some((e) => e.id === safeExam.id)
                const next = exists
                  ? prev.map((e) => (e.id === safeExam.id ? { ...e, ...safeExam } : e))
                  : [safeExam, ...prev]
                saveLocalStudentExams(next)
                return next
              })
              setFetchStatus('ready')
              setExamsFetchStatus('ready')
              setExamsDataSource('server')
              setLoadError(null)
              setSyncWarning(null)
            }
          } else {
            // e.g. __SYSTEM_EXAMS__ changed in Supabase: re-fetch ONLY exams silently
            refreshExamsSection().catch(() => {})
          }
        } else if (event.action === 'delete' && event.id) {
          setExams((prev) => {
            const next = prev.filter((e) => e.id !== event.id)
            saveLocalStudentExams(next)
            return next
          })
        }
      } else if (event.type === 'grade') {
        refreshGradesSection().catch(() => {})
      } else if (event.type === 'submission') {
        Promise.allSettled([refreshHomeworkSubmissionsSection(), refreshQuizSubmissionsSection()])
      }
    })

    // Lightweight single-request RPC backup polling (student_poll_fingerprint)
    // Selectively refetches ONLY changed sections (posts / quizzes / grades / submissions)
    const runLightweightBackupPoll = async (immediate = false) => {
      if (!isMounted || !hasValidStudentUuid) return
      if (typeof document !== 'undefined' && document.hidden) return
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return
      if (inFlightLoadRef.current || inFlightPollRef.current) return
      if (!immediate && Date.now() - lastBackgroundSyncAtRef.current < 1500) return

      const { canonicalStudentId, canonicalAccessCode } = resolveStudentCredentials()
      if (!isValidUuid(canonicalStudentId) || !canonicalAccessCode) return

      const pollTask = (async () => {
        try {
          const res = await fetchStudentPollFingerprint(canonicalStudentId, canonicalAccessCode)
          if (!isMounted || res.skipped) return

          // On RPC error (e.g. fingerprint RPC missing or rejected): ALWAYS refresh homework & exams directly.
          // Realtime cannot be relied on (quizzes have no postgres_changes feed and WebSockets are often blocked).
          if (!res.ok || !res.data) {
            hasRpcError = true
            lastRpcErrorAt = Date.now()
            currentPollDelayMs = ERROR_BACKOFF_POLL_MS
            lastDirectRefreshAt = Date.now()
            await Promise.allSettled([
              refreshPostsSection(),
              refreshExamsSection(),
              refreshHomeworkSubmissionsSection(),
              refreshGradesSection(),
            ])
            return
          }

          // First successful RPC restores normal 45s polling cadence
          hasRpcError = false
          currentPollDelayMs = NORMAL_POLL_MS

          const nextFingerprint = res.data
          const prevFingerprint = lastPollFingerprintRef.current
          if (prevFingerprint === null) {
            lastPollFingerprintRef.current = nextFingerprint
            return
          }

          lastPollFingerprintRef.current = nextFingerprint

          // Selectively refetch ONLY sections whose updated_at or count changed
          const tasks: Promise<void>[] = []
          const directRefreshDue = Date.now() - lastDirectRefreshAt > DIRECT_REFRESH_EVERY_MS
          if (directRefreshDue) {
            lastDirectRefreshAt = Date.now()
            tasks.push(refreshPostsSection(), refreshExamsSection())
          }
          if (hasFingerprintEntryChanged(prevFingerprint.posts, nextFingerprint.posts)) {
            tasks.push(refreshPostsSection())
          }
          if (hasFingerprintEntryChanged(prevFingerprint.quizzes, nextFingerprint.quizzes)) {
            tasks.push(refreshExamsSection())
          }
          if (hasFingerprintEntryChanged(prevFingerprint.grades, nextFingerprint.grades)) {
            tasks.push(refreshGradesSection())
          }
          if (hasFingerprintEntryChanged(prevFingerprint.quiz_submissions, nextFingerprint.quiz_submissions)) {
            tasks.push(refreshQuizSubmissionsSection())
          }
          if (hasFingerprintEntryChanged(prevFingerprint.submissions, nextFingerprint.submissions)) {
            tasks.push(refreshHomeworkSubmissionsSection())
          }

          if (tasks.length > 0) {
            await Promise.allSettled(tasks)
          }
        } catch {
          // Catch any unexpected error safely without calling loadAll
          hasRpcError = true
          lastRpcErrorAt = Date.now()
          currentPollDelayMs = ERROR_BACKOFF_POLL_MS
        } finally {
          lastBackgroundSyncAtRef.current = Date.now()
          inFlightPollRef.current = null
          scheduleNextPollTimer()
        }
      })()

      inFlightPollRef.current = pollTask
      return pollTask
    }

    const scheduleBackupPoll = (immediate = false) => {
      if (!hasValidStudentUuid) return
      if (typeof document !== 'undefined' && document.hidden) return
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return
      if (inFlightLoadRef.current || inFlightPollRef.current) return

      if (immediate) {
        runLightweightBackupPoll(true)
        return
      }

      const run = () => {
        runLightweightBackupPoll(false)
      }
      if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
        ;(window as any).requestIdleCallback(run, { timeout: 2000 })
      } else {
        setTimeout(run, 0)
      }
    }

    // Start backup polling timer (45s normal, 2m backoff on RPC error; disabled completely for non-UUID students)
    if (hasValidStudentUuid) {
      scheduleNextPollTimer()
    }

    const handleReconnect = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      realtimeSync.init()
      flushPendingExamSyncQueue().catch(() => {})
      if (hasValidStudentUuid) {
        scheduleBackupPoll(true)
      } else {
        Promise.allSettled([refreshPostsSection(), refreshExamsSection()])
      }
    }

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && document.visibilityState === 'visible') {
        realtimeSync.init()
        if (hasValidStudentUuid) {
          scheduleBackupPoll(true)
        } else {
          Promise.allSettled([refreshPostsSection(), refreshExamsSection()])
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('online', handleReconnect)

    return () => {
      isMounted = false
      unsubscribe()
      if (pollTimer) clearTimeout(pollTimer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('online', handleReconnect)
    }
    // Re-initialize safely if logged-in student or teacher-previewed student changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student?.id, student?.access_code])

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

  // Combined grades merging Supabase grades, exams, homework assignments, and submissions via shared canonical builder
  const combinedGrades = useMemo(() => {
    const localExams = exams.length > 0 ? exams : getLocalStudentExams()
    const allSubs = mergeSubmissionsDeduplicated([], myExamSubs.length > 0 ? myExamSubs : getLocalSubmissions())
    return buildCanonicalGradesList({
      studentId: student.id,
      studentName: student.full_name || (student as any).fullName,
      dbGrades: myGrades,
      exams: localExams,
      examSubmissions: allSubs,
      homeworkPosts: posts,
      homeworkSubmissions: mySubmissions,
      includePending: true,
    })
  }, [myGrades, student.id, student.full_name, exams, myExamSubs, posts, mySubmissions])

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

  // Active homework posts
  const homeworkPosts = useMemo(() => {
    return posts.filter((p) => {
      if (isSystemRecord(p)) return false
      return p.type === 'homework'
    })
  }, [posts])

  // Memoized fast submission map by examId (deduplicated so duplicate records always resolve deterministically)
  const mySubByExamId = useMemo(() => {
    const map = new Map<string, StudentExamSubmission>()
    const source = mergeSubmissionsDeduplicated([], myExamSubs.length > 0 ? myExamSubs : getLocalSubmissions())
    for (const s of source) {
      if (!s || !s.examId) continue
      if (isSameStudent(s.studentId, student.id, s.studentName, student?.full_name || (student as any)?.fullName)) {
        map.set(s.examId, s)
      }
    }
    return map
  }, [myExamSubs, student.id, student?.full_name])

  // Active exams & assignments for home dashboard
  const activeExams = useMemo(() => {
    return exams
      .filter((e) => Boolean(e && e.published !== false))
      .sort((a, b) => {
        const subA = mySubByExamId.get(a.id)
        const subB = mySubByExamId.get(b.id)
        if (!subA && subB) return -1
        if (subA && !subB) return 1
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      })
  }, [exams, mySubByExamId])

  // Dedicated list for Homework (تکالیف) tab:
  // Includes all active and completed class assignments and online exams
  const homeworkAssignments = useMemo(() => {
    return exams
      .filter((e) => Boolean(e && e.published !== false))
      .sort((a, b) => {
        const subA = mySubByExamId.get(a.id)
        const subB = mySubByExamId.get(b.id)
        if (!subA && subB) return -1
        if (subA && !subB) return 1
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      })
  }, [exams, mySubByExamId])

  const submittedIds = new Set(mySubmissions.map((s) => s.post_id))
  const pendingExamCount = homeworkAssignments.filter((e) => !mySubByExamId.get(e.id)).length
  const pendingHwCount = homeworkPosts.filter((p) => !submittedIds.has(p.id)).length
  const pendingCount = pendingHwCount + pendingExamCount

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
  const gradedCombinedItems = useMemo(() => {
    return combinedGrades.filter(
      (g) => g.status === 'graded' && g.score !== null && g.score !== undefined && !isNaN(Number(g.score))
    )
  }, [combinedGrades])

  const skillGroups = useMemo(() => {
    return groupSkillMastery(gradedCombinedItems)
  }, [gradedCombinedItems])

  const gpa = useMemo(() => {
    if (!gradedCombinedItems.length) return null
    const total = gradedCombinedItems.reduce((sum, g) => {
      const m = Number(g.max_score)
      const s = Number(g.score) || 0
      return sum + (m === 20 ? s : m > 0 ? (s / m) * 20 : s)
    }, 0)
    return String(roundScore2(total / gradedCombinedItems.length))
  }, [gradedCombinedItems])

  // Fresh server fetch whenever the student opens the Report Card tab or official Report Card modal
  const refreshReportCardFromServer = useCallback(async () => {
    const rawId = student?.id || student?.access_code
    const rosterInfo = resolveCanonicalStudent(rawId || student?.full_name)
    const canonicalStudentId = rosterInfo?.id || rawId
    const canonicalAccessCode = resolveStudentAccessCode(student)

    if (!canonicalStudentId || !isValidUuid(String(canonicalStudentId))) {
      // Teacher preview mode or synthetic local preview student
      setReportCardLoading(false)
      setReportCardError(null)
      return
    }

    const seq = ++reportCardReqSeqRef.current
    setReportCardLoading(true)
    setReportCardError(null)

    const withFetchTimeout = async <T,>(promise: PromiseLike<T> | Promise<T>, ms = 35000): Promise<T> => {
      return Promise.race([
        Promise.resolve(promise),
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
      ])
    }

    try {
      const [gradesRes, examsRes, examSubsRes] = await Promise.allSettled([
        withFetchTimeout<any>(
          supabase.rpc('student_list_my_grades', {
            p_student_id: canonicalStudentId,
            p_access_code: String(canonicalAccessCode || ''),
          }),
          35000
        ),
        withFetchTimeout(fetchPublishedExamsWithDiagnostics(true, true, { skipBackendApi: true }), 35000),
        withFetchTimeout(
          fetchExamSubmissions(undefined, canonicalStudentId, true, undefined, String(canonicalAccessCode || '')),
          35000
        ),
      ])

      if (seq !== reportCardReqSeqRef.current) return

      let gradesOk = false
      if (gradesRes.status === 'fulfilled' && !gradesRes.value?.error && Array.isArray(gradesRes.value?.data)) {
        gradesOk = true
        setMyGrades(gradesRes.value.data)
        setGradesFetchStatus('ready')
        try {
          localStorage.setItem(`cached_grades_${canonicalStudentId}`, JSON.stringify(gradesRes.value.data))
        } catch {}
      }

      let examsOk = false
      if (examsRes.status === 'fulfilled' && examsRes.value?.remoteOk) {
        examsOk = true
        setExams(examsRes.value.exams)
        setExamsFetchStatus('ready')
      }

      let subsOk = false
      if (examSubsRes.status === 'fulfilled' && Array.isArray(examSubsRes.value)) {
        subsOk = true
        setMyExamSubs(examSubsRes.value)
        setSubmissionsFetchStatus('ready')
      }

      if (!gradesOk || (!examsOk && !subsOk)) {
        setReportCardError('خطا در دریافت جدیدترین نمرات از سرور. لطفاً اتصال اینترنت را بررسی کرده و دوباره تلاش کنید.')
      }
    } catch {
      if (seq !== reportCardReqSeqRef.current) return
      setReportCardError('خطا در دریافت جدیدترین نمرات از سرور. لطفاً اتصال اینترنت را بررسی کرده و دوباره تلاش کنید.')
    } finally {
      if (seq === reportCardReqSeqRef.current) {
        setReportCardLoading(false)
      }
    }
  }, [student?.id, student?.access_code, student?.full_name])

  useEffect(() => {
    if (activeTab === 'grades' || showReportCardModal) {
      void refreshReportCardFromServer()
    }
  }, [activeTab, showReportCardModal, refreshReportCardFromServer])

  async function handleOpenExamReview(g: any) {
    const rowKey = String(g.id || g.examId || g.skill || 'review')
    setReviewErrorMsg(null)
    setOpeningReviewId(rowKey)

    try {
      const targetStudentName = student?.full_name || (student as any)?.fullName
      const rawId = student?.id || student?.access_code
      const rosterInfo = resolveCanonicalStudent(rawId || targetStudentName)
      const canonicalStudentId = rosterInfo?.id || rawId
      const canonicalAccessCode = resolveStudentAccessCode(student)

      let targetExam =
        g.matchedExam ||
        g.exam ||
        exams.find((e) => e.id === g.examId) ||
        getLocalStudentExams().find((e) => e.id === g.examId) ||
        null

      if (!targetExam && g.skill) {
        targetExam =
          exams.find((e) => {
            const cleanE = sanitizeExamTitle(e.title, e.subject)
            const cleanG = sanitizeExamTitle(g.skill || '', g.subject)
            return Boolean(cleanE && cleanG && (cleanE === cleanG || String(g.skill).includes(cleanE)))
          }) || null
      }

      const targetExamId = String(g.examId || targetExam?.id || '').trim()

      if (!targetExamId) {
        setReviewErrorMsg('اطلاعات سؤالات این ارزیابی در سامانه یافت نشد یا مربوط به ارزیابی کلاسی بدون برگه‌سؤال است.')
        return
      }

      const officialScore20 =
        g.status === 'graded' && g.score !== null && g.score !== undefined && !isNaN(Number(g.score))
          ? Number(g.score)
          : null

      // Local answer sheet (exam questions + this student's answers) used when the secure RPC is
      // unavailable/slow, so the button ALWAYS opens something for an already-graded item.
      const localSub =
        g.matchedSub ||
        g.sub ||
        (myExamSubs.length > 0 ? myExamSubs : getLocalSubmissions()).find(
          (s) =>
            (s.examId === targetExamId || (targetExam && s.examId === targetExam.id)) &&
            isSameStudent(s.studentId, student?.id, s.studentName, targetStudentName)
        ) ||
        null
      const openLocalReview = (): boolean => {
        if (!targetExam || !localSub) return false
        const releasedLocally = g.status === 'graded' || isExamResultsReleased(targetExam, localSub)
        if (!releasedLocally) return false
        setReviewExamData({
          exam: targetExam,
          submission: localSub,
          scaledScore20: officialScore20,
          forceReleased: true,
        })
        return true
      }

      // Preferred: secure RPC returns full questions + correct answers + explanations ONLY when released.
      if (isValidUuid(String(canonicalStudentId || '')) && isValidUuid(targetExamId)) {
        let reviewRes: Awaited<ReturnType<typeof fetchStudentExamReview>> | null = null
        let rpcError: string | null = null
        try {
          reviewRes = await Promise.race([
            fetchStudentExamReview({
              examId: targetExamId,
              studentId: String(canonicalStudentId),
              accessCode: String(canonicalAccessCode || ''),
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
          ])
        } catch (rpcErr: any) {
          rpcError = rpcErr?.message || 'rpc_failed'
        }

        if (reviewRes && reviewRes.ok && reviewRes.released && reviewRes.exam && reviewRes.submission) {
          setReviewExamData({
            exam: reviewRes.exam,
            submission: reviewRes.submission,
            questionsReview: reviewRes.questionsReview,
            scaledScore20: officialScore20 ?? reviewRes.scaledScore20,
            forceReleased: true,
          })
          return
        }

        if (openLocalReview()) return

        if (reviewRes && !reviewRes.released) {
          setReviewErrorMsg(reviewRes.message || 'نتیجه این آزمون هنوز توسط آموزگار منتشر نشده است.')
          return
        }
        setReviewErrorMsg(
          rpcError
            ? 'اتصال برای دریافت پاسخ‌نامه برقرار نشد. لطفاً چند لحظه بعد دوباره روی دکمه بزنید.'
            : reviewRes?.message || 'پاسخ‌نامه این آزمون در حال حاضر در دسترس نیست. لطفاً دوباره تلاش کنید.'
        )
        return
      }

      // Teacher preview of a synthetic student: use local data only
      if (!openLocalReview()) {
        setReviewErrorMsg('نتیجه هنوز منتشر نشده است.')
      }
    } catch (err: any) {
      setReviewErrorMsg(err?.message || 'خطا در دریافت پاسخ‌نامه از سرور. لطفاً دوباره تلاش کنید.')
    } finally {
      setOpeningReviewId(null)
    }
  }

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
          message="در حال دریافت اطلاعات دانش‌آموز و آزمون‌ها..."
          error={loadError}
          onRetry={() => loadAll(true)}
          onLogout={onLogout}
        />
      </div>
    )
  }

  return (
    <div dir="rtl" className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans pb-36 sm:pb-32">
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

      <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-5 pb-16 flex-1">
        {/* Top Refresh Action Bar */}
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="text-[11px] sm:text-xs text-slate-500 font-medium">
            📅 {weekday}، {jalali}
          </div>
          <button
            type="button"
            disabled={isManualRefreshing}
            onClick={() => {
              setIsManualRefreshing(true)
              loadAll(true).finally(() => setIsManualRefreshing(false))
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-black bg-white hover:bg-blue-50 text-blue-700 border border-blue-200 hover:border-blue-300 shadow-2xs transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
            title="بروزرسانی تکالیف، آزمون‌ها و کارنامه"
          >
            <span className={isManualRefreshing ? 'inline-block animate-spin' : 'inline-block'}>🔄</span>
            <span>{isManualRefreshing ? 'در حال بروزرسانی...' : 'بروزرسانی'}</span>
          </button>
        </div>

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
                  {fetchStatus === 'loading'
                    ? 'در حال بررسی و همگام‌سازی تکالیف و آزمون‌های جدید...'
                    : fetchStatus === 'error'
                    ? 'در دریافت وضعیت تکالیف و آزمون‌ها از سرور خطا رخ داد. لطفاً اتصال اینترنت را بررسی کرده و دوباره تلاش کنید.'
                    : pendingCount > 0
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

            {/* Server Sync / Fetch Error or Stale Cache Banner on Home Tab */}
            {(fetchStatus === 'error' || examsFetchStatus === 'error' || examsDataSource === 'cache' || syncWarning) && (
              <div
                className={`${
                  fetchStatus === 'error' || examsFetchStatus === 'error'
                    ? 'bg-rose-50 border-rose-200'
                    : 'bg-amber-50 border-amber-200'
                } border rounded-2xl p-4 sm:p-5 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-xl shrink-0">⚠️</span>
                  <div>
                    <h4
                      className={`text-xs sm:text-sm font-black ${
                        fetchStatus === 'error' || examsFetchStatus === 'error' ? 'text-rose-900' : 'text-amber-900'
                      }`}
                    >
                      {fetchStatus === 'error' || examsFetchStatus === 'error'
                        ? 'خطا در دریافت آزمون‌ها و تکالیف از سرور'
                        : 'نمایش نسخه موقت — در انتظار همگام‌سازی با سرور'}
                    </h4>
                    <p
                      className={`text-xs mt-0.5 leading-relaxed ${
                        fetchStatus === 'error' || examsFetchStatus === 'error' ? 'text-rose-800' : 'text-amber-800'
                      }`}
                    >
                      {loadError || syncWarning || 'برای اطمینان از مشاهده جدیدترین آزمون‌ها و تکالیف، دکمه بروزرسانی را بزنید.'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => loadAll(true)}
                  className={`px-4 py-2 text-xs font-black text-white rounded-xl shadow-xs transition-colors cursor-pointer shrink-0 inline-flex items-center justify-center gap-1.5 ${
                    fetchStatus === 'error' || examsFetchStatus === 'error'
                      ? 'bg-rose-600 hover:bg-rose-700'
                      : 'bg-amber-600 hover:bg-amber-700'
                  }`}
                >
                  <span>🔄</span>
                  <span>تلاش مجدد</span>
                </button>
              </div>
            )}

            {/* Scheduled Future Exams Section (Always visible, clearly separated, locked until start time) */}
            {(() => {
              const nowAligned = currentTime + serverTimeOffsetRef.current
              const upcomingScheduledExams = activeExams.filter((exam) => {
                const info = classifyExamForStudent(exam, nowAligned)
                return info.isPublished && !info.isStarted
              })
              if (upcomingScheduledExams.length === 0) return null
              return (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base sm:text-lg font-black text-amber-900 tracking-tight flex items-center gap-2">
                      <span>⏳</span>
                      <span>آزمون‌های زمان‌بندی‌شده (شروع به‌زودی)</span>
                    </h3>
                    <span className="text-[11px] font-black bg-amber-100 text-amber-900 px-2.5 py-1 rounded-lg border border-amber-200">
                      {toPersianDigits(upcomingScheduledExams.length)} آزمون پیش‌رو
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {upcomingScheduledExams.map((exam) => {
                      const countdown = getExamCountdownInfo(exam.scheduledStartTime)
                      const isUntimedExam =
                        exam.mode === 'assignment' || Boolean(exam.isUntimed) || !exam.durationMinutes || Number(exam.durationMinutes) <= 0
                      const startMs = parseExamTimestampMs(exam.scheduledStartTime)
                      return (
                        <div
                          key={exam.id}
                          className="bg-amber-50/40 border-2 border-amber-200 rounded-2xl p-4.5 sm:p-5 shadow-xs flex flex-col justify-between"
                        >
                          <div>
                            <div className="flex items-start justify-between gap-3 mb-2">
                              <div>
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-[11px] font-black bg-blue-50 text-blue-700 px-2.5 py-0.5 rounded-md border border-blue-100">
                                    {exam.subject}
                                  </span>
                                  <span className="text-[11px] font-black bg-amber-100 text-amber-900 px-2 py-0.5 rounded-md">
                                    {isUntimedExam ? '🌱 تکلیف آنلاین' : '⏱️ آزمون زمان‌دار'}
                                  </span>
                                </div>
                                <h4 className="text-base font-black text-slate-900 mt-1.5 mb-1">
                                  {sanitizeExamTitle(exam.title, exam.subject)}
                                </h4>
                                {exam.description && exam.description.trim() && (
                                  <p className="text-xs text-slate-600 leading-relaxed line-clamp-2">
                                    {toPersianDigits(exam.description.trim())}
                                  </p>
                                )}
                              </div>
                              <span className="text-[11px] font-black px-2.5 py-1 rounded-lg border whitespace-nowrap bg-amber-100 text-amber-900 border-amber-300">
                                ⏰ شروع به زودی
                              </span>
                            </div>

                            <div className="my-3 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between gap-2.5 flex-wrap">
                              <div className="flex items-center gap-2">
                                <span className="text-xl animate-pulse">⏳</span>
                                <div>
                                  <div className="text-xs font-black text-amber-900">
                                    آغاز: ساعت {countdown.timeLabel} · {countdown.remainingText}
                                  </div>
                                  <div className="text-[11px] text-amber-700 font-medium mt-0.5">
                                    به‌محض فرارسیدن زمان شروع، دکمه ورود به‌طور خودکار فعال می‌شود.
                                  </div>
                                </div>
                              </div>
                              <span className="text-[11px] font-black bg-amber-200/70 text-amber-900 px-2 py-0.5 rounded-md">
                                شمارش معکوس زنده
                              </span>
                            </div>

                            <p className="text-xs text-slate-600 mb-3">
                              {toPersianDigits(exam.questions.length)} سوال ({toPersianDigits(exam.totalPoints)} نمره) ·{' '}
                              {isUntimedExam ? 'بدون محدودیت زمانی' : `مدت: ${toPersianDigits(exam.durationMinutes)} دقیقه`}
                              {startMs ? ` · زمان شروع: ${toPersianDigits(new Date(startMs).toLocaleString('fa-IR'))}` : ''}
                            </p>
                          </div>

                          <button
                            type="button"
                            disabled
                            className="w-full py-2.5 px-3 text-xs font-black rounded-xl bg-slate-200 text-slate-500 cursor-not-allowed inline-flex items-center justify-center gap-1.5"
                          >
                            <span>🔒</span>
                            <span>ورود در ساعت {countdown.timeLabel} فعال می‌شود</span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()}

            {/* Active Online Exams & Assignments Section */}
            {(() => {
              const nowAligned = currentTime + serverTimeOffsetRef.current
              const startedExams = activeExams.filter((exam) => {
                const info = classifyExamForStudent(exam, nowAligned)
                return info.isPublished && info.isStarted
              })
              if (startedExams.length === 0) return null
              return (
              <div className="space-y-3.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-base sm:text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                    <span>📝</span>
                    <span>آزمون‌ها و تکالیف آنلاین فعال</span>
                  </h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {startedExams.map((exam) => {
                    const sub = mySubByExamId.get(exam.id) || getStudentExamSubmission(exam.id, student.id)
                    const isSubmitted = Boolean(sub)
                    const countdown = getExamCountdownInfo(exam.scheduledStartTime)
                    const isStarted = countdown.isStarted

                    // Authoritative score lookup from combinedGrades (exact same source as Report Card)
                    const matchedGrade = combinedGrades.find(
                      (g) => g.examId === exam.id || g.matchedExam?.id === exam.id || (g as any).sub?.id === sub?.id
                    )
                    const isGraded = matchedGrade?.status === 'graded' && matchedGrade.score !== null && matchedGrade.score !== undefined
                    const isPendingReview = matchedGrade?.status === 'pending_review' || (isSubmitted && !isGraded)
                    const examClass = classifyExamForStudent(exam, nowAligned)
                    const isUntimedExam = examClass.isAssignment
                    const isPastDue = examClass.isPastDue
                    const isUntimedEditable = isUntimedExam && !isPastDue && !isGraded
                    const hasDraft = !isSubmitted && typeof localStorage !== 'undefined' && Boolean(
                      localStorage.getItem(`exam_draft_${exam.id}_${student.id}`) ||
                        localStorage.getItem(`exam_draft_${exam.id}`)
                    )

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
                              {exam.description && exam.description.trim() && (
                                <p className="text-xs text-slate-600 leading-relaxed line-clamp-2 mb-1">
                                  {toPersianDigits(exam.description.trim())}
                                </p>
                              )}
                            </div>

                            <span
                              className={`text-[11px] font-black px-2.5 py-1 rounded-lg border whitespace-nowrap ${
                                isGraded
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : isPendingReview
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : hasDraft
                                  ? 'bg-indigo-50 text-indigo-800 border-indigo-200'
                                  : isStarted
                                  ? 'bg-blue-50 text-blue-800 border-blue-200'
                                  : 'bg-slate-100 text-slate-700 border-slate-200'
                              }`}
                            >
                              {isGraded
                                ? `✅ نمره: ${toPersianDigits(matchedGrade.score)} از ۲۰`
                                : isPendingReview
                                ? '⏳ در انتظار تایید معلم'
                                : hasDraft
                                ? '✏️ دارای پیش‌نویس (ادامه)'
                                : isStarted
                                ? '🟢 آماده برگزاری'
                                : '⏰ شروع به زودی'}
                            </span>
                          </div>

                          {/* Countdown for Upcoming Exams */}
                          {!isStarted && !isSubmitted && !hasDraft && (
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
                            {toPersianDigits(exam.questions.length)} سوال ({toPersianDigits(exam.totalPoints)} نمره) · {isUntimedExam ? 'بدون محدودیت زمانی' : `مدت: ${toPersianDigits(exam.durationMinutes)} دقیقه`} {exam.dueDate ? `· مهلت: ${toPersianDigits(new Date(exam.dueDate).toLocaleDateString('fa-IR'))}` : `· زمان شروع: ${toPersianDigits(new Date(exam.scheduledStartTime || exam.createdAt || Date.now()).toLocaleString('fa-IR'))}`}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 pt-2 border-t border-slate-100 flex-wrap">
                          {isGraded ? (
                            <button
                              type="button"
                              className="w-full py-2.5 px-3 text-xs font-black text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
                              onClick={() => {
                                sessionStorage.setItem('active_taking_exam_id', exam.id)
                                setTakingExam(exam)
                              }}
                            >
                              <span>📊</span>
                              <span>مشاهده کارنامه و کلید پاسخ‌ها</span>
                            </button>
                          ) : isSubmitted ? (
                            isUntimedEditable ? (
                              <div className="flex items-center gap-2 w-full">
                                <button
                                  type="button"
                                  className="flex-1 py-2 px-3 text-xs font-black text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-xs transition-all cursor-pointer inline-flex items-center justify-center gap-1.5"
                                  onClick={() => {
                                    sessionStorage.setItem('active_taking_exam_id', exam.id)
                                    setTakingExam(exam)
                                  }}
                                >
                                  <span>✏️</span>
                                  <span>ویرایش و تغییر پاسخ‌ها</span>
                                </button>
                                <button
                                  type="button"
                                  className="flex-1 py-2 px-3 text-xs font-black text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-xl transition-all cursor-pointer inline-flex items-center justify-center gap-1.5"
                                  onClick={() => {
                                    sessionStorage.setItem('active_taking_exam_id', exam.id)
                                    setTakingExam(exam)
                                  }}
                                >
                                  <span>🔍</span>
                                  <span>وضعیت ثبت</span>
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="w-full py-2.5 px-3 text-xs font-black text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-xl shadow-xs transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5"
                                onClick={() => {
                                  sessionStorage.setItem('active_taking_exam_id', exam.id)
                                  setTakingExam(exam)
                                }}
                              >
                                <span>🔍</span>
                                <span>مشاهده وضعیت ثبت پاسخ (در انتظار تایید آموزگار)</span>
                              </button>
                            )
                          ) : hasDraft ? (
                            <button
                              type="button"
                              className="w-full py-2.5 px-3 text-xs font-black text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-md ring-2 ring-emerald-200 transition-all cursor-pointer inline-flex items-center justify-center gap-1.5"
                              onClick={() => {
                                sessionStorage.setItem('active_taking_exam_id', exam.id)
                                setTakingExam(exam)
                              }}
                            >
                              <span>📝</span>
                              <span>ادامه آزمون (دارای پاسخ ذخیره‌شده)</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={!isStarted}
                              className={`w-full py-2.5 px-3 text-xs font-black rounded-xl transition-all inline-flex items-center justify-center gap-1.5 ${
                                isStarted
                                  ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-xs cursor-pointer'
                                  : 'bg-slate-200 text-slate-500 cursor-not-allowed'
                              }`}
                              onClick={() => {
                                if (isStarted) {
                                  sessionStorage.setItem('active_taking_exam_id', exam.id)
                                  setTakingExam(exam)
                                }
                              }}
                            >
                              {isStarted ? (
                                <>
                                  <span>🚀</span>
                                  <span>ورود به صفحه آزمون</span>
                                </>
                              ) : (
                                <>
                                  <span>⏳</span>
                                  <span>آغاز در ساعت {countdown.timeLabel} ({countdown.remainingText})</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
              )
            })()}

            {/* Homework Posts Section on Home Tab */}
            {homeworkPosts.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base sm:text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                      <span>📐</span>
                      <span>تکالیف درسی و تمرین‌های کلاسی</span>
                    </h3>
                    <p className="text-xs text-slate-500 font-medium mt-0.5">
                      تکالیف تعیین‌شده توسط آموزگار محترم
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('homework')}
                    className="text-xs font-bold text-blue-600 hover:text-blue-800 cursor-pointer flex items-center gap-1"
                  >
                    <span>مشاهده همه</span>
                    <span>←</span>
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {homeworkPosts.slice(0, 4).map((hw) => {
                    const isSub = mySubmissions.some((s) => s.post_id === hw.id)
                    const isPastDue = Boolean(hw.due_at && new Date(hw.due_at) < new Date())
                    return (
                      <div
                        key={hw.id}
                        onClick={() => {
                          setActiveTab('homework')
                          setExpandedHomeworkId(hw.id)
                        }}
                        className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-2xs hover:shadow-xs transition-all cursor-pointer flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[11px] font-black bg-blue-50 text-blue-700 px-2 py-0.5 rounded-md">
                              {hw.subject || 'عمومی'}
                            </span>
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                                isSub
                                  ? 'bg-emerald-50 text-emerald-800'
                                  : isPastDue
                                  ? 'bg-rose-50 text-rose-800'
                                  : 'bg-amber-50 text-amber-800'
                              }`}
                            >
                              {isSub ? '✅ ارسال شده' : isPastDue ? '⚠️ مهلت گذشته' : '⭕ در انتظار ارسال'}
                            </span>
                          </div>
                          <h4 className="text-sm font-black text-slate-800 truncate">
                            {hw.title}
                          </h4>
                          {hw.due_at && (
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              مهلت: {toPersianDigits(new Date(hw.due_at).toLocaleDateString('fa-IR'))}
                            </div>
                          )}
                        </div>
                        <span className="text-xs font-black text-blue-600 bg-blue-50 px-2.5 py-1.5 rounded-xl shrink-0">
                          مشاهده 👁️
                        </span>
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
                  {fetchStatus === 'loading'
                    ? 'در حال دریافت و بررسی لیست تکالیف و آزمون‌ها...'
                    : fetchStatus === 'error'
                    ? 'در دریافت لیست تکالیف از سرور خطا رخ داد'
                    : pendingCount > 0
                    ? `${toPersianDigits(pendingCount)} تکلیف انجام‌نشده در انتظار تحویل است`
                    : 'همه تکالیف فعال تا این لحظه ارسال شده‌اند'}
                </p>
              </div>
            </div>

            {/* INTERACTIVE ASSIGNMENTS & ONLINE EXAMS SECTION */}
            {homeworkAssignments.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🌟</span>
                  <h3 className="text-base font-black text-slate-900 tracking-tight">
                    آزمون‌ها و تکالیف هوشمند آنلاین
                  </h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {homeworkAssignments.map((assignment) => {
                    const sub = mySubByExamId.get(assignment.id) || getStudentExamSubmission(assignment.id, student.id)
                    const isSubmitted = Boolean(sub)
                    const matchedGrade = combinedGrades.find(
                      (g) => g.examId === assignment.id || g.matchedExam?.id === assignment.id || (g as any).sub?.id === sub?.id
                    )
                    const isGraded = matchedGrade?.status === 'graded' && matchedGrade.score !== null && matchedGrade.score !== undefined
                    const isPendingReview = matchedGrade?.status === 'pending_review' || (isSubmitted && !isGraded)
                    const nowAligned = currentTime + serverTimeOffsetRef.current
                    const assignmentClass = classifyExamForStudent(assignment, nowAligned)
                    const countdown = getExamCountdownInfo(assignment.scheduledStartTime)
                    const isStarted = assignmentClass.isStarted
                    const isUntimedExam = assignmentClass.isAssignment
                    const isPastDue = assignmentClass.isPastDue
                    const isUntimedEditable = isUntimedExam && !isPastDue && !isGraded
                    const hasDraft = !isSubmitted && typeof localStorage !== 'undefined' && Boolean(
                      localStorage.getItem(`exam_draft_${assignment.id}_${student.id}`) ||
                        localStorage.getItem(`exam_draft_${assignment.id}`)
                    )
                    const isQuizMode = !isUntimedExam
                    const isLockedFuture = !isStarted && !isSubmitted && !hasDraft
                    const handleOpenAssignment = () => {
                      if (isLockedFuture) return
                      sessionStorage.setItem('active_taking_exam_id', assignment.id)
                      setTakingExam(assignment)
                    }
                    return (
                      <div
                        key={assignment.id}
                        className={`rounded-2xl p-4.5 transition-all flex flex-col justify-between group ${
                          isLockedFuture
                            ? 'bg-amber-50/40 border-2 border-amber-200 cursor-not-allowed'
                            : !isSubmitted && !hasDraft
                            ? 'bg-gradient-to-br from-blue-50/80 via-white to-indigo-50/60 border-2 border-blue-400 hover:border-blue-600 shadow-sm hover:shadow-md ring-2 ring-blue-100/70 cursor-pointer'
                            : hasDraft
                            ? 'bg-indigo-50/50 border-2 border-indigo-400 hover:border-indigo-600 shadow-xs cursor-pointer'
                            : isGraded
                            ? 'bg-white hover:bg-slate-50/60 border border-slate-200/90 hover:border-slate-300 shadow-2xs cursor-pointer'
                            : 'bg-white hover:bg-amber-50/30 border border-amber-200 hover:border-amber-400 shadow-2xs cursor-pointer'
                        }`}
                        onClick={handleOpenAssignment}
                      >
                        <div>
                          <div className="flex justify-between items-start gap-2 mb-2">
                            <div>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className={`text-[11px] font-black px-2.5 py-0.5 rounded-md ${
                                  isLockedFuture
                                    ? 'bg-amber-100 text-amber-900'
                                    : !isSubmitted && !hasDraft
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-blue-100 text-blue-800'
                                }`}>
                                  {assignment.subject || 'عمومی'} · {isQuizMode ? '⏱️ آزمون آنلاین' : '🌱 تکلیف تعاملی'}
                                </span>
                                {isLockedFuture ? (
                                  <span className="text-[10px] font-black bg-amber-100 text-amber-900 px-2 py-0.5 rounded-md">
                                    ⏳ شروع: ساعت {countdown.timeLabel}
                                  </span>
                                ) : !isSubmitted && !hasDraft ? (
                                  <span className="text-[10px] font-black bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-md animate-pulse">
                                    🟢 جدید · آماده انجام
                                  </span>
                                ) : null}
                                {hasDraft && (
                                  <span className="text-[10px] font-black bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded-md">
                                    ✏️ دارای پیش‌نویس
                                  </span>
                                )}
                              </div>
                              <h4 className="text-base font-black text-slate-900 group-hover:text-blue-700 transition-colors mt-2 mb-1">
                                {sanitizeExamTitle(assignment.title, assignment.subject)}
                              </h4>
                              {assignment.description && assignment.description.trim() && (
                                <p className="text-xs text-slate-600 leading-relaxed line-clamp-2 mb-1">
                                  {toPersianDigits(assignment.description.trim())}
                                </p>
                              )}
                            </div>
                            <span
                              className={`text-[11px] font-black px-2.5 py-1 rounded-lg border whitespace-nowrap ${
                                isGraded
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : isPendingReview
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : isLockedFuture
                                  ? 'bg-amber-100 text-amber-900 border-amber-300'
                                  : hasDraft
                                  ? 'bg-indigo-50 text-indigo-800 border-indigo-200'
                                  : 'bg-rose-50 text-rose-700 border-rose-200 font-black'
                              }`}
                            >
                              {isGraded
                                ? `✅ نمره: ${toPersianDigits(matchedGrade.score)} از ۲۰`
                                : isPendingReview
                                ? '⏳ در انتظار تایید معلم'
                                : isLockedFuture
                                ? '⏰ شروع به زودی'
                                : hasDraft
                                ? '✏️ دارای پیش‌نویس'
                                : '⭕ در انتظار حل'}
                            </span>
                          </div>

                          {isLockedFuture && (
                            <div className="my-2 p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-[11.5px] font-bold text-amber-900">
                              ⏳ {countdown.remainingText} (آغاز در ساعت {countdown.timeLabel})
                            </div>
                          )}

                          <div className="text-xs text-slate-500 mb-3 space-y-1">
                            <div className="font-semibold text-slate-600">
                              تعداد سوالات: <strong className="text-slate-800">{toPersianDigits(assignment.questions?.length || 0)} سوال</strong> · بارم:{' '}
                              <strong className="text-slate-800">{toPersianDigits(assignment.totalPoints || 20)} نمره</strong>
                            </div>
                            {assignment.dueDate && (
                              <div className="text-blue-700 font-bold">
                                ⏰ مهلت تحویل: {toPersianDigits(new Date(assignment.dueDate).toLocaleString('fa-IR'))}
                              </div>
                            )}
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={isLockedFuture}
                          className={`w-full py-2.5 px-3 text-xs font-black rounded-xl transition-all inline-flex items-center justify-center gap-1.5 ${
                            isLockedFuture
                              ? 'text-slate-500 bg-slate-200 cursor-not-allowed'
                              : !isSubmitted && !hasDraft
                              ? 'text-white bg-blue-600 hover:bg-blue-700 group-hover:bg-blue-700 shadow-sm cursor-pointer'
                              : hasDraft
                              ? 'text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm ring-2 ring-indigo-200 cursor-pointer'
                              : isGraded
                              ? 'text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 cursor-pointer'
                              : isUntimedEditable
                              ? 'text-white bg-blue-600 hover:bg-blue-700 shadow-sm cursor-pointer'
                              : 'text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 cursor-pointer'
                          }`}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleOpenAssignment()
                          }}
                        >
                          {isLockedFuture
                            ? `🔒 آغاز در ساعت ${countdown.timeLabel} (${countdown.remainingText})`
                            : isGraded
                            ? '📊 مشاهده کارنامه و نمره'
                            : isUntimedEditable && isSubmitted
                            ? '✏️ مشاهده یا ویرایش پاسخ‌ها'
                            : isSubmitted
                            ? '🔍 مشاهده وضعیت ثبت پاسخ'
                            : hasDraft
                            ? '📝 ادامه حل تکلیف (دارای پیش‌نویس)'
                            : isQuizMode
                            ? '📝 ورود و شروع آزمون'
                            : '📝 ورود و شروع حل تکلیف تعاملی'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {(fetchStatus === 'loading' || examsFetchStatus === 'loading' || loading) && homeworkPosts.length === 0 && homeworkAssignments.length === 0 && (
              <div className="bg-white border border-slate-200/80 rounded-2xl p-8 text-center shadow-xs animate-pulse">
                <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-blue-50 text-blue-500 flex items-center justify-center text-xl">
                  ⏳
                </div>
                <h4 className="text-sm font-black text-slate-800 mb-1">
                  در حال بارگذاری تکالیف و آزمون‌ها...
                </h4>
                <p className="text-xs text-slate-500 max-w-sm mx-auto">
                  ارتباط با سرور برقرار شد، در حال دریافت جدیدترین اطلاعات از پایگاه داده...
                </p>
              </div>
            )}

            {(fetchStatus === 'error' || examsFetchStatus === 'error' || syncWarning) && (
              <div className="bg-rose-50 border border-rose-200 rounded-2xl p-5 sm:p-6 text-center shadow-xs space-y-3">
                <div className="w-12 h-12 mx-auto rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center text-2xl">
                  📡
                </div>
                <h4 className="text-sm font-black text-rose-950">
                  {fetchStatus === 'error' || examsFetchStatus === 'error'
                    ? 'خطا در دریافت لیست تکالیف و آزمون‌ها'
                    : 'اختلال در ارتباط با سرور'}
                </h4>
                <p className="text-xs text-rose-800 max-w-md mx-auto leading-relaxed">
                  {loadError || syncWarning || 'ارتباط با پایگاه داده برقرار نشد. لطفاً وضعیت اینترنت را بررسی کرده و مجدداً تلاش کنید.'}
                </p>
                <button
                  type="button"
                  onClick={() => loadAll(true)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-black text-white bg-rose-600 hover:bg-rose-700 rounded-xl shadow-xs transition-colors cursor-pointer"
                >
                  <span>🔄</span>
                  <span>تلاش مجدد برای دریافت آزمون‌ها</span>
                </button>
              </div>
            )}

            {fetchStatus === 'ready' && examsFetchStatus === 'ready' && !syncWarning && !loading && homeworkPosts.length === 0 && homeworkAssignments.length === 0 && (
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

            {reportCardLoading && (
              <div className="bg-blue-50 border border-blue-200 text-blue-800 rounded-2xl px-4 py-2.5 text-xs font-bold flex items-center gap-2">
                <span className="animate-spin">⏳</span>
                <span>در حال دریافت جدیدترین نمرات از سرور...</span>
              </div>
            )}

            {reportCardError && (
              <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-2xl px-4 py-3 text-xs font-bold flex flex-wrap items-center justify-between gap-2.5">
                <span className="flex items-center gap-1.5">
                  <span>⚠️</span>
                  <span>{reportCardError}</span>
                </span>
                <button
                  type="button"
                  disabled={reportCardLoading}
                  onClick={() => void refreshReportCardFromServer()}
                  className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-black cursor-pointer disabled:opacity-60"
                >
                  تلاش دوباره
                </button>
              </div>
            )}

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
                                {toPersianDigits(roundScore2(avgNum))} از ۲۰
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
                      const isGraded = g.status === 'graded'
                      const isPendingReview = g.status === 'pending_review'
                      const isPendingSubmission = g.status === 'pending_submission'

                      const rawEarned = Number(g.score) || 0
                      const rawTotal = Number(g.max_score) || 20
                      const normalized = isGraded && rawTotal > 0 ? roundScore2((rawEarned / rawTotal) * 20) : roundScore2(rawEarned)

                      let badgeColor = 'text-emerald-700 bg-emerald-50 border-emerald-200'
                      let badgeLabel = 'خیلی خوب'
                      if (isPendingReview) {
                        badgeColor = 'text-amber-700 bg-amber-50 border-amber-200'
                        badgeLabel = '⏳ در انتظار تصحیح معلم'
                      } else if (isPendingSubmission) {
                        badgeColor = 'text-indigo-700 bg-indigo-50 border-indigo-200'
                        badgeLabel = '📝 در انتظار انجام تکلیف'
                      } else if (normalized < 12) {
                        badgeColor = 'text-rose-700 bg-rose-50 border-rose-200'
                        badgeLabel = 'نیازمند تلاش'
                      } else if (normalized < 15) {
                        badgeColor = 'text-amber-700 bg-amber-50 border-amber-200'
                        badgeLabel = 'قابل قبول'
                      } else if (normalized < 18) {
                        badgeColor = 'text-blue-700 bg-blue-50 border-blue-200'
                        badgeLabel = 'خوب'
                      }

                      const rowKey = String(g.id || g.examId || g.skill || idx)
                      const isOpeningThis = openingReviewId === rowKey
                      const hasReview = isGraded && Boolean(g.matchedExam || g.examId)
                      const canViewPendingAnswers = isPendingReview && Boolean(g.matchedExam || g.examId)

                      return (
                        <div
                          key={g.id || idx}
                          className={`bg-white border rounded-2xl p-3 sm:p-4 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                            hasReview || canViewPendingAnswers
                              ? 'border-blue-200 hover:border-blue-400 hover:shadow-xs cursor-pointer'
                              : isPendingSubmission
                              ? 'border-indigo-200/90 hover:border-indigo-300 hover:shadow-xs'
                              : 'border-slate-200/80'
                          }`}
                          onClick={() => {
                            if (hasReview || canViewPendingAnswers) {
                              handleOpenExamReview(g)
                            } else if (isPendingSubmission) {
                              if (g.matchedExam) {
                                setTakingExam(g.matchedExam)
                              } else {
                                setActiveTab('homework')
                              }
                            }
                          }}
                        >
                          <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                            <div
                              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-base ${
                                hasReview
                                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                  : isPendingSubmission
                                  ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                                  : isPendingReview
                                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                  : 'bg-slate-50 text-slate-600 border border-slate-200'
                              }`}
                            >
                              {hasReview ? '📋' : isPendingSubmission ? '✏️' : isPendingReview ? '⏳' : '📝'}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <span className="font-black text-sm text-slate-900">
                                  {g.subject || 'عمومی'}
                                </span>
                                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md border ${badgeColor}`}>
                                  {badgeLabel}
                                </span>
                              </div>
                              <div className="text-xs text-slate-600 font-medium truncate max-w-md">
                                {sanitizeTeacherFeedback(g.skill || g.notes || 'تکلیف و ارزیابی کلاسی')}
                              </div>
                              {hasReview && (
                                <button
                                  type="button"
                                  disabled={isOpeningThis}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleOpenExamReview(g)
                                  }}
                                  className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 active:scale-95 text-[11px] text-blue-700 font-black border border-blue-200/80 transition-all cursor-pointer"
                                >
                                  <span>{isOpeningThis ? '⏳' : '🔍'}</span>
                                  <span>
                                    {isOpeningThis
                                      ? 'در حال بارگذاری پاسخ‌نامه...'
                                      : 'برای مشاهده سؤالات و پاسخ‌نامه کلیک کنید'}
                                  </span>
                                </button>
                              )}
                              {canViewPendingAnswers && (
                                <button
                                  type="button"
                                  disabled={isOpeningThis}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleOpenExamReview(g)
                                  }}
                                  className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-[11px] text-amber-700 font-bold border border-amber-200 transition-all cursor-pointer"
                                >
                                  <span>👁️</span>
                                  <span>پاسخ شما ثبت شده و در انتظار تایید آموزگار است (برای مشاهده کلیک کنید)</span>
                                </button>
                              )}
                              {isPendingSubmission && (
                                <div className="text-[11px] text-indigo-600 font-bold mt-1">
                                  {g.due_date
                                    ? `مهلت انجام: ${toPersianDigits(new Date(g.due_date).toLocaleDateString('fa-IR'))}`
                                    : 'تکلیف فعال کلاس — برای شروع کلیک کنید'}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100">
                            {isGraded ? (
                              <div className="text-left">
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
                            ) : isPendingReview ? (
                              <div className="text-left">
                                <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200/90 px-3 py-1.5 rounded-xl">
                                  <span>⏳</span>
                                  <span>در انتظار تصحیح</span>
                                </span>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (g.matchedExam) {
                                    setTakingExam(g.matchedExam)
                                  } else {
                                    setActiveTab('homework')
                                  }
                                }}
                                className="px-4 py-2 text-xs font-black text-white bg-indigo-600 hover:bg-indigo-700 active:scale-95 rounded-xl shadow-xs transition-all flex items-center gap-1.5 cursor-pointer min-h-[44px]"
                              >
                                <span>✏️</span>
                                <span>حل تکلیف</span>
                              </button>
                            )}
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
        studentName={student?.full_name}
      />

      {/* Student Official Report Card Modal */}
      {showReportCardModal && (
        <StudentReportCard
          student={student}
          grades={combinedGrades}
          attendanceRows={myAttendance}
          submissions={mySubmissions}
          examSubmissions={myExamSubs}
          homeworkCount={homeworkPosts.length}
          reportNote={reportNote || undefined}
          loading={reportCardLoading}
          error={reportCardError}
          onRetry={() => void refreshReportCardFromServer()}
          onClose={() => setShowReportCardModal(false)}
        />
      )}

      {/* Student Exam Taker Fullscreen Popup Modal */}
      {takingExam && (
        <StudentExamTaker
          exam={takingExam}
          student={student}
          initialSubmission={
            myExamSubs.find((s) => s.examId === takingExam.id) ||
            combinedGrades.find((g) => g.matchedExam?.id === takingExam.id || g.examId === takingExam.id)?.matchedSub
          }
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

      {/* Clear Error Dialog when Answer Sheet Cannot Be Loaded (Never Silent No-Op) */}
      {reviewErrorMsg && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setReviewErrorMsg(null)}
        >
          <div
            className="w-full max-w-md bg-white border-2 border-slate-900 rounded-2xl p-5 shadow-2xl text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-3xl mb-2">📋</div>
            <h4 className="text-base font-black text-slate-900 mb-2">پاسخ‌نامه در دسترس نیست</h4>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-4">{reviewErrorMsg}</p>
            <button
              type="button"
              onClick={() => setReviewErrorMsg(null)}
              className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-black cursor-pointer"
            >
              متوجه شدم
            </button>
          </div>
        </div>
      )}

      {/* Student Exam Review Popup Modal */}
      {reviewExamData && (
        <ExamReviewModal
          exam={reviewExamData.exam}
          submission={reviewExamData.submission}
          questionsReview={reviewExamData.questionsReview}
          scaledScore20Override={reviewExamData.scaledScore20}
          forceReleased={reviewExamData.forceReleased}
          onClose={() => setReviewExamData(null)}
          onEdit={() => {
            const targetExam = reviewExamData.exam
            setReviewExamData(null)
            sessionStorage.setItem('active_taking_exam_id', targetExam.id)
            setTakingExam(targetExam)
          }}
        />
      )}
    </div>
  )
}

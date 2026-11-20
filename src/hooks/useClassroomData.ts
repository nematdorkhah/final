import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../supabaseClient'
import { todayISO } from '../useJalaliDate'
import { sortByLastName } from '../utils/persianSort'
import { CLASS_STUDENTS_ROSTER } from '../classStudents'
import {
  realtimeSync,
  fetchTeacherPollFingerprint,
  hasFingerprintEntryChanged,
  TeacherPollFingerprint,
} from '../services/realtimeSync'
import { fetchFilteredPublishedPosts } from '../utils/networkResilience'
import { Exam, StudentExamSubmission } from '../types/examTypes'
import {
  fetchAllExams,
  fetchExamSubmissions,
  getLocalExams,
  getLocalSubmissions,
  mergeSubmissionsDeduplicated,
} from '../utils/examStore'

export type ClassroomResourceKey =
  | 'students'
  | 'posts'
  | 'submissions'
  | 'attendance'
  | 'grades'
  | 'exams'
  | 'examSubmissions'

export interface ResourceStatus {
  loading: boolean
  error: string | null
  loaded: boolean
}

export type ClassroomSectionStatus = Record<ClassroomResourceKey, ResourceStatus>

const RESOURCE_TIMEOUT_MS = 15000
const REALTIME_DEBOUNCE_MS = 5000
const AUTH_EXPIRED_MESSAGE = 'ورود معلم منقضی شده است. لطفاً مجدداً وارد حساب آموزگار شوید.'

const ALL_RESOURCE_KEYS: ClassroomResourceKey[] = [
  'students',
  'posts',
  'submissions',
  'attendance',
  'grades',
  'exams',
  'examSubmissions',
]

function createInitialSectionStatus(loading = true): ClassroomSectionStatus {
  return {
    students: { loading, error: null, loaded: false },
    posts: { loading, error: null, loaded: false },
    submissions: { loading, error: null, loaded: false },
    attendance: { loading, error: null, loaded: false },
    grades: { loading, error: null, loaded: false },
    exams: { loading, error: null, loaded: false },
    examSubmissions: { loading, error: null, loaded: false },
  }
}

function getFallbackRoster() {
  return sortByLastName(
    CLASS_STUDENTS_ROSTER.map((cs) => ({
      id: cs.nationalCode,
      full_name: cs.fullName,
      father_name: cs.fatherName,
      access_code: cs.nationalCode,
    })),
    'full_name'
  )
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms)
  })
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function isAuthError(err: any): boolean {
  const code = String(err?.code || '')
  const msg = String(err?.message || '').toLowerCase()
  return (
    code === '42501' ||
    msg.includes('unauthorized') ||
    msg.includes('invalid password') ||
    msg.includes('forbidden') ||
    msg.includes('منقضی')
  )
}

function cleanClassroomPosts(rawPosts: any[]): any[] {
  return (Array.isArray(rawPosts) ? rawPosts : []).filter((post: any) => {
    const title = String(post?.title || '')
    return (
      !title.startsWith('__') &&
      !title.includes('__SYSTEM_') &&
      !title.includes('__EXAM_SUB__') &&
      post?.type !== 'exam'
    )
  })
}

export function useClassroomData(teacherPassword: string) {
  const [students, setStudents] = useState<any[]>(() => getFallbackRoster())
  const [posts, setPosts] = useState<any[]>(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('cached_teacher_posts_v2')
        if (raw) return JSON.parse(raw)
      }
    } catch {}
    return []
  })
  const [submissions, setSubmissions] = useState<any[]>(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('cached_teacher_submissions_v2')
        if (raw) return JSON.parse(raw)
      }
    } catch {}
    return []
  })
  const [attendanceToday, setAttendanceToday] = useState<Record<string, string>>({})
  const [allAttendance, setAllAttendance] = useState<any[]>([])
  const [grades, setGrades] = useState<any[]>([])
  const [exams, setExams] = useState<Exam[]>(() => getLocalExams())
  const [examSubmissions, setExamSubmissions] = useState<StudentExamSubmission[]>(() =>
    mergeSubmissionsDeduplicated([], getLocalSubmissions())
  )

  const [sectionStatus, setSectionStatus] = useState<ClassroomSectionStatus>(() => createInitialSectionStatus(true))
  const [authExpired, setAuthExpired] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  const inFlightLoadRef = useRef<Promise<void> | null>(null)
  const inFlightPollRef = useRef<Promise<void> | null>(null)
  const inFlightResourceRef = useRef<Partial<Record<ClassroomResourceKey, Promise<void>>>>({})
  const debounceTimersRef = useRef<Partial<Record<ClassroomResourceKey, ReturnType<typeof setTimeout>>>>({})
  const pendingFollowUpRef = useRef<Partial<Record<ClassroomResourceKey, boolean>>>({})
  const loadResourceRef = useRef<(key: ClassroomResourceKey, options?: { background?: boolean }) => Promise<void>>(
    async () => {}
  )
  const scheduleSectionRefreshRef = useRef<(key: ClassroomResourceKey) => void>(() => {})
  const lastPollFingerprintRef = useRef<TeacherPollFingerprint | null>(null)
  const lastBackgroundSyncAtRef = useRef(0)

  // Resolve password from prop, localStorage session, or sessionStorage — NEVER fallback to '1234'
  const effectivePassword = (
    teacherPassword ||
    (() => {
      try {
        if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem('class_auth_session')
          if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed?.teacherPassword) return String(parsed.teacherPassword)
            if (parsed?.principalPassword) return String(parsed.principalPassword)
          }
        }
        if (typeof sessionStorage !== 'undefined') {
          return sessionStorage.getItem('teacherPassword') || ''
        }
      } catch {}
      return ''
    })()
  ).trim()

  const updateResourceStatus = useCallback(
    (key: ClassroomResourceKey, patch: Partial<ResourceStatus>) => {
      if (!isMountedRef.current) return
      setSectionStatus((prev) => ({
        ...prev,
        [key]: { ...prev[key], ...patch },
      }))
    },
    []
  )

  const loadResource = useCallback(
    async (key: ClassroomResourceKey, options?: { background?: boolean }) => {
      const isBackground = Boolean(options?.background)

      if (!effectivePassword) {
        if (isMountedRef.current) {
          setAuthExpired(true)
          setError(AUTH_EXPIRED_MESSAGE)
          updateResourceStatus(key, { loading: false, error: AUTH_EXPIRED_MESSAGE })
        }
        return
      }

      const existing = inFlightResourceRef.current[key]
      if (existing) {
        return existing
      }

      const queuedTimer = debounceTimersRef.current[key]
      if (queuedTimer) {
        clearTimeout(queuedTimer)
        delete debounceTimersRef.current[key]
      }

      if (isMountedRef.current) {
        setSectionStatus((prev) => ({
          ...prev,
          [key]: {
            ...prev[key],
            loading: !isBackground || !prev[key].loaded,
            error: isBackground ? prev[key].error : null,
          },
        }))
      }

      const task = (async () => {
        try {
          if (key === 'students') {
            const res = await withTimeout(
              supabase.rpc('teacher_list_students', { p_password: effectivePassword }),
              RESOURCE_TIMEOUT_MS,
              'زمان بارگذاری فهرست دانش‌آموزان به پایان رسید.'
            )
            if (res?.error) throw res.error
            if (!isMountedRef.current) return
            if (Array.isArray(res?.data) && res.data.length > 0) {
              setStudents(sortByLastName(res.data, 'full_name'))
            } else {
              setStudents((prev) => (prev.length > 0 ? prev : getFallbackRoster()))
            }
          } else if (key === 'posts') {
            const res = await withTimeout(
              fetchFilteredPublishedPosts(supabase, { includeScheduledFuture: true })
                .then((data) => ({ data, error: null }))
                .catch(async () => {
                  const rpcRes = await supabase.rpc('teacher_list_posts', { p_password: effectivePassword })
                  return { data: rpcRes.data, error: rpcRes.error }
                }),
              RESOURCE_TIMEOUT_MS,
              'زمان بارگذاری تکالیف و اعلانات به پایان رسید.'
            )
            if (res?.error) throw res.error
            if (!isMountedRef.current) return
            const cleanPosts = cleanClassroomPosts(res?.data || [])
            setPosts(cleanPosts)
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('cached_teacher_posts_v2', JSON.stringify(cleanPosts))
              }
            } catch {}
          } else if (key === 'submissions') {
            const res = await withTimeout(
              supabase.rpc('teacher_list_submissions', { p_password: effectivePassword }),
              RESOURCE_TIMEOUT_MS,
              'زمان بارگذاری تحویل تکالیف به پایان رسید.'
            )
            if (res?.error) throw res.error
            if (!isMountedRef.current) return
            const rows = Array.isArray(res?.data) ? res.data : []
            setSubmissions(rows)
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('cached_teacher_submissions_v2', JSON.stringify(rows))
              }
            } catch {}
          } else if (key === 'attendance') {
            const res = await withTimeout(
              supabase.rpc('teacher_list_attendance', { p_password: effectivePassword }),
              RESOURCE_TIMEOUT_MS,
              'زمان بارگذاری حضور و غیاب به پایان رسید.'
            )
            if (res?.error) throw res.error
            if (!isMountedRef.current) return
            const rows = Array.isArray(res?.data) ? res.data : []
            const todayStr = todayISO()
            const attMap: Record<string, string> = {}
            rows.forEach((a: any) => {
              if (a.date === todayStr) attMap[a.student_id] = a.status
            })
            setAttendanceToday(attMap)
            setAllAttendance(rows)
          } else if (key === 'grades') {
            const res = await withTimeout(
              supabase.rpc('teacher_list_grades', { p_password: effectivePassword }),
              RESOURCE_TIMEOUT_MS,
              'زمان بارگذاری نمرات به پایان رسید.'
            )
            if (res?.error) throw res.error
            if (!isMountedRef.current) return
            setGrades(Array.isArray(res?.data) ? res.data : [])
          } else if (key === 'exams') {
            const loadedExams = await withTimeout(
              fetchAllExams(effectivePassword),
              RESOURCE_TIMEOUT_MS,
              'زمان بارگذاری آزمون‌ها به پایان رسید.'
            )
            if (!isMountedRef.current) return
            if (Array.isArray(loadedExams)) {
              setExams(loadedExams)
            }
          } else if (key === 'examSubmissions') {
            const loadedExamSubs = await withTimeout(
              fetchExamSubmissions(undefined, undefined, true),
              RESOURCE_TIMEOUT_MS,
              'زمان بارگذاری پاسخنامه‌های آزمون به پایان رسید.'
            )
            if (!isMountedRef.current) return
            if (Array.isArray(loadedExamSubs)) {
              setExamSubmissions(mergeSubmissionsDeduplicated([], loadedExamSubs))
            }
          }

          if (isMountedRef.current) {
            setAuthExpired(false)
            updateResourceStatus(key, { loading: false, error: null, loaded: true })
          }
        } catch (err: any) {
          console.warn(`[useClassroomData] Failed loading ${key}:`, err)
          if (!isMountedRef.current) return
          const expired = isAuthError(err)
          const message = expired
            ? AUTH_EXPIRED_MESSAGE
            : err?.message || 'خطا در ارتباط با سرور'
          if (expired) {
            setAuthExpired(true)
            setError(AUTH_EXPIRED_MESSAGE)
          }
          updateResourceStatus(key, { loading: false, error: message })
        } finally {
          delete inFlightResourceRef.current[key]
          if (pendingFollowUpRef.current[key]) {
            delete pendingFollowUpRef.current[key]
            if (isMountedRef.current) {
              scheduleSectionRefreshRef.current(key)
            }
          }
        }
      })()

      inFlightResourceRef.current[key] = task
      return task
    },
    [effectivePassword, updateResourceStatus]
  )

  loadResourceRef.current = loadResource

  const scheduleSectionRefresh = useCallback(
    (key: ClassroomResourceKey) => {
      if (!isMountedRef.current || !effectivePassword) return

      // If this resource is already being fetched, coalesce any new events into a single follow-up fetch
      if (inFlightResourceRef.current[key]) {
        pendingFollowUpRef.current[key] = true
        return
      }

      const existingTimer = debounceTimersRef.current[key]
      if (existingTimer) {
        clearTimeout(existingTimer)
      }

      debounceTimersRef.current[key] = setTimeout(() => {
        delete debounceTimersRef.current[key]
        if (!isMountedRef.current) return
        if (inFlightResourceRef.current[key]) {
          pendingFollowUpRef.current[key] = true
          return
        }
        loadResourceRef.current(key, { background: true }).catch(() => {})
      }, REALTIME_DEBOUNCE_MS)
    },
    [effectivePassword]
  )

  scheduleSectionRefreshRef.current = scheduleSectionRefresh

  const reloadSections = useCallback(
    async (keys: ClassroomResourceKey[], options?: { background?: boolean }) => {
      if (!effectivePassword) {
        if (isMountedRef.current) {
          setAuthExpired(true)
          setError(AUTH_EXPIRED_MESSAGE)
          setSectionStatus((prev) => {
            const next = { ...prev }
            keys.forEach((k) => {
              next[k] = { ...next[k], loading: false, error: AUTH_EXPIRED_MESSAGE }
            })
            return next
          })
        }
        return
      }
      await Promise.allSettled(keys.map((k) => loadResource(k, options)))
    },
    [effectivePassword, loadResource]
  )

  const reloadSection = useCallback(
    async (key: ClassroomResourceKey, options?: { background?: boolean }) => {
      await loadResource(key, options)
    },
    [loadResource]
  )

  const loadAll = useCallback(
    async (options?: { background?: boolean }) => {
      const isBackground = Boolean(options?.background)

      if (!effectivePassword) {
        if (isMountedRef.current) {
          setAuthExpired(true)
          setError(AUTH_EXPIRED_MESSAGE)
          setSectionStatus((prev) => {
            const next = { ...prev }
            ALL_RESOURCE_KEYS.forEach((k) => {
              next[k] = { ...next[k], loading: false, error: AUTH_EXPIRED_MESSAGE }
            })
            return next
          })
        }
        return
      }

      if (inFlightLoadRef.current) {
        return inFlightLoadRef.current
      }

      if (!isBackground && isMountedRef.current) {
        setAuthExpired(false)
        setError(null)
      }

      const runPromise = (async () => {
        try {
          await Promise.allSettled(
            ALL_RESOURCE_KEYS.map((key) => loadResource(key, { background: isBackground }))
          )
        } finally {
          lastBackgroundSyncAtRef.current = Date.now()
          inFlightLoadRef.current = null
        }
      })()

      inFlightLoadRef.current = runPromise
      return runPromise
    },
    [effectivePassword, loadResource]
  )

  useEffect(() => {
    isMountedRef.current = true
    let isMounted = true

    const NORMAL_POLL_MS = 60000
    const ERROR_BACKOFF_POLL_MS = 120000
    let currentPollDelayMs = NORMAL_POLL_MS
    let hasRpcError = false
    let lastRpcErrorAt = 0
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleNextPollTimer = () => {
      if (!isMounted || !effectivePassword) return
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = setTimeout(() => {
        if (!isMounted) return
        if (typeof document !== 'undefined' && document.hidden) {
          scheduleNextPollTimer()
          return
        }
        if (hasRpcError && realtimeSync.getIsSubscribed()) {
          scheduleNextPollTimer()
          return
        }
        scheduleBackupPoll(false)
      }, currentPollDelayMs)
    }

    loadAll().finally(() => {
      if (!isMounted || !effectivePassword || lastPollFingerprintRef.current !== null) return
      fetchTeacherPollFingerprint(effectivePassword)
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

    realtimeSync.init()

    const runLightweightBackupPoll = async (immediate = false) => {
      if (!isMounted || !effectivePassword) return
      if (typeof document !== 'undefined' && document.hidden) return
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return
      if (inFlightLoadRef.current || inFlightPollRef.current) return
      if (!immediate && Date.now() - lastBackgroundSyncAtRef.current < 1500) return

      if (hasRpcError && realtimeSync.getIsSubscribed()) {
        if (!immediate || Date.now() - lastRpcErrorAt < ERROR_BACKOFF_POLL_MS) {
          scheduleNextPollTimer()
          return
        }
      }

      const pollTask = (async () => {
        try {
          const res = await fetchTeacherPollFingerprint(effectivePassword)
          if (!isMounted || res.skipped) return

          if (!res.ok || !res.data) {
            hasRpcError = true
            lastRpcErrorAt = Date.now()
            currentPollDelayMs = ERROR_BACKOFF_POLL_MS
            return
          }

          hasRpcError = false
          currentPollDelayMs = NORMAL_POLL_MS

          const nextFingerprint = res.data
          const prevFingerprint = lastPollFingerprintRef.current
          if (prevFingerprint === null) {
            lastPollFingerprintRef.current = nextFingerprint
            return
          }

          lastPollFingerprintRef.current = nextFingerprint

          // Selectively refresh ONLY the sections whose updated_at or count changed
          const changedKeys: ClassroomResourceKey[] = []
          if (hasFingerprintEntryChanged(prevFingerprint.posts, nextFingerprint.posts)) {
            changedKeys.push('posts')
          }
          if (hasFingerprintEntryChanged(prevFingerprint.quizzes, nextFingerprint.quizzes)) {
            changedKeys.push('exams')
          }
          if (hasFingerprintEntryChanged(prevFingerprint.quiz_submissions, nextFingerprint.quiz_submissions)) {
            changedKeys.push('examSubmissions')
          }
          if (hasFingerprintEntryChanged(prevFingerprint.submissions, nextFingerprint.submissions)) {
            changedKeys.push('submissions')
          }
          if (hasFingerprintEntryChanged(prevFingerprint.grades, nextFingerprint.grades)) {
            changedKeys.push('grades')
          }
          if (hasFingerprintEntryChanged(prevFingerprint.attendance, nextFingerprint.attendance)) {
            changedKeys.push('attendance')
          }

          if (changedKeys.length > 0) {
            await reloadSections(changedKeys, { background: true })
          }
        } catch {
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

    // Realtime events refresh ONLY their matching section — NEVER full loadAll
    const unsubscribe = realtimeSync.subscribe((event) => {
      if (!effectivePassword) return
      if (event.type === 'post') {
        if (event.action === 'create' && event.item) {
          const title = String(event.item.title || '')
          if (!title.startsWith('__') && !title.includes('__SYSTEM_') && !title.includes('__EXAM_SUB__')) {
            setPosts((prev) => {
              const exists = prev.some((p) => p.id === event.item.id)
              const updated = exists
                ? prev.map((p) => (p.id === event.item.id ? { ...p, ...event.item } : p))
                : [event.item, ...prev]
              try {
                localStorage.setItem('cached_teacher_posts_v2', JSON.stringify(updated))
              } catch {}
              return updated
            })
          }
        } else if (event.action === 'update' && event.item) {
          setPosts((prev) => {
            const updated = prev.map((p) =>
              p.id === event.id || p.id === event.item.id ? { ...p, ...event.item } : p
            )
            try {
              localStorage.setItem('cached_teacher_posts_v2', JSON.stringify(updated))
            } catch {}
            return updated
          })
        } else if (event.action === 'delete' && event.id) {
          setPosts((prev) => {
            const updated = prev.filter((p) => p.id !== event.id)
            try {
              localStorage.setItem('cached_teacher_posts_v2', JSON.stringify(updated))
            } catch {}
            return updated
          })
        } else {
          loadResource('posts', { background: true }).catch(() => {})
        }
      } else if (event.type === 'submission') {
        scheduleSectionRefresh('submissions')
        scheduleSectionRefresh('examSubmissions')
      } else if (event.type === 'grade') {
        scheduleSectionRefresh('grades')
      } else if (event.type === 'attendance') {
        scheduleSectionRefresh('attendance')
      } else if (event.type === 'exam') {
        scheduleSectionRefresh('exams')
      }
    })

    scheduleNextPollTimer()

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden && document.visibilityState === 'visible') {
        scheduleBackupPoll(true)
      }
    }

    const handleOnlineSync = () => {
      scheduleBackupPoll(true)
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', handleOnlineSync)

    return () => {
      isMounted = false
      isMountedRef.current = false
      unsubscribe()
      if (pollTimer) clearTimeout(pollTimer)
      ALL_RESOURCE_KEYS.forEach((k) => {
        const t = debounceTimersRef.current[k]
        if (t) clearTimeout(t)
        delete debounceTimersRef.current[k]
        delete pendingFollowUpRef.current[k]
      })
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleOnlineSync)
    }
  }, [loadAll, loadResource, reloadSections, scheduleSectionRefresh, effectivePassword])

  const loading = ALL_RESOURCE_KEYS.every((k) => sectionStatus[k].loading && !sectionStatus[k].loaded)

  return {
    students,
    posts,
    submissions,
    attendanceToday,
    allAttendance,
    grades,
    exams,
    examSubmissions,
    loading,
    error,
    authExpired,
    sectionStatus,
    reload: loadAll,
    reloadSection,
    reloadSections,
    scheduleSectionRefresh,
  }
}

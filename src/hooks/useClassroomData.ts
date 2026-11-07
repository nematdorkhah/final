import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../supabaseClient'
import { todayISO } from '../useJalaliDate'
import { sortByLastName } from '../utils/persianSort'
import { CLASS_STUDENTS_ROSTER } from '../classStudents'
import { realtimeSync } from '../services/realtimeSync'

export function useClassroomData(teacherPassword: string) {
  // Safe initial state from roster so UI is never stuck on empty
  const [students, setStudents] = useState<any[]>(() =>
    sortByLastName(
      CLASS_STUDENTS_ROSTER.map((cs) => ({
        id: cs.nationalCode,
        full_name: cs.fullName,
        father_name: cs.fatherName,
        access_code: cs.nationalCode,
      })),
      'full_name'
    )
  )
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
  const [loading, setLoading] = useState(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('cached_teacher_posts_v2')
        if (raw && JSON.parse(raw).length > 0) return false
      }
    } catch {}
    return true
  })
  const [error, setError] = useState<string | null>(null)
  const hasLoadedOnce = useRef(false)

  // Resolve password from prop or class_auth_session
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

  const loadAll = useCallback(async () => {
    if (!hasLoadedOnce.current) setLoading(true)
    setError(null)

    // 7-second timeout guard to ensure loading never hangs indefinitely
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('زمان پاسخگویی سرور به پایان رسید.')), 7000)
    )

    try {
      const fetchPromise = Promise.all([
        supabase.rpc('teacher_list_students', { p_password: effectivePassword }),
        supabase.rpc('teacher_list_posts', { p_password: effectivePassword }),
        supabase.rpc('teacher_list_submissions', { p_password: effectivePassword }),
        supabase.rpc('teacher_list_attendance', { p_password: effectivePassword }),
        supabase.rpc('teacher_list_grades', { p_password: effectivePassword }),
      ])

      const [s, p, sub, allAtt, g] = (await Promise.race([fetchPromise, timeoutPromise])) as any[]

      // Update students roster with backend data or fallback
      if (s?.data && Array.isArray(s.data) && s.data.length > 0) {
        setStudents(sortByLastName(s.data, 'full_name'))
      } else {
        setStudents(
          sortByLastName(
            CLASS_STUDENTS_ROSTER.map((cs) => ({
              id: cs.nationalCode,
              full_name: cs.fullName,
              father_name: cs.fatherName,
              access_code: cs.nationalCode,
            })),
            'full_name'
          )
        )
      }

      const cleanPosts = (p?.data || []).filter((post: any) => {
        const title = String(post?.title || '')
        return (
          !title.startsWith('__') &&
          !title.includes('__SYSTEM_') &&
          !title.includes('__EXAM_SUB__') &&
          post?.type !== 'exam'
        )
      })
      setPosts(cleanPosts)
      setSubmissions(sub?.data || [])

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('cached_teacher_posts_v2', JSON.stringify(cleanPosts))
          localStorage.setItem('cached_teacher_submissions_v2', JSON.stringify(sub?.data || []))
        }
      } catch {}

      const todayStr = todayISO()
      const attMap: Record<string, string> = {}
      ;(allAtt?.data || []).forEach((a: any) => {
        if (a.date === todayStr) attMap[a.student_id] = a.status
      })
      setAttendanceToday(attMap)
      setAllAttendance(allAtt?.data || [])
      setGrades(g?.data || [])
      hasLoadedOnce.current = true
    } catch (err: any) {
      console.warn('[useClassroomData] Error fetching classroom data:', err)
      setError(err?.message || 'خطا در ارتباط با سرور')
      // Ensure fallback roster is always present even if offline or error
      setStudents((prev) =>
        prev.length > 0
          ? prev
          : sortByLastName(
              CLASS_STUDENTS_ROSTER.map((cs) => ({
                id: cs.nationalCode,
                full_name: cs.fullName,
                father_name: cs.fatherName,
                access_code: cs.nationalCode,
              })),
              'full_name'
            )
      )
    } finally {
      setLoading(false)
    }
  }, [effectivePassword])

  useEffect(() => {
    loadAll()

    realtimeSync.init()
    const unsubscribe = realtimeSync.subscribe((event) => {
      if (event.type === 'post') {
        if (event.action === 'create' && event.item) {
          const title = String(event.item.title || '')
          if (!title.startsWith('__') && !title.includes('__SYSTEM_') && !title.includes('__EXAM_SUB__')) {
            setPosts((prev) => {
              const exists = prev.some((p) => p.id === event.item.id)
              const updated = exists ? prev.map((p) => (p.id === event.item.id ? { ...p, ...event.item } : p)) : [event.item, ...prev]
              try {
                localStorage.setItem('cached_teacher_posts_v2', JSON.stringify(updated))
              } catch {}
              return updated
            })
          }
        } else if (event.action === 'update' && event.item) {
          setPosts((prev) => {
            const updated = prev.map((p) => (p.id === event.id || p.id === event.item.id ? { ...p, ...event.item } : p))
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
        }
      } else if (event.type === 'submission' || event.type === 'grade' || event.type === 'attendance') {
        // Silently refresh teacher data when students submit or grades change
        loadAll()
      }
    })

    return () => {
      unsubscribe()
    }
  }, [loadAll])

  return {
    students,
    posts,
    submissions,
    attendanceToday,
    allAttendance,
    grades,
    loading,
    error,
    reload: loadAll,
  }
}

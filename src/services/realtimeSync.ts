import { supabase } from '../supabaseClient'
import { Exam, StudentExamSubmission } from '../types/examTypes'
import {
  fetchWithTimeout,
  isBackendStaticOnly,
  sanitizeExamForStudent,
} from '../utils/networkResilience'

export type ClassroomEventType = 'post' | 'exam' | 'grade' | 'submission' | 'attendance'
export type ClassroomActionType = 'create' | 'update' | 'delete'

export interface RealtimeBroadcastPayload {
  type: ClassroomEventType
  action: ClassroomActionType
  item?: any
  id?: string
  studentId?: string
  timestamp: number
}

type RealtimeListener = (payload: RealtimeBroadcastPayload) => void

class RealtimeSyncManager {
  private channel: any = null
  private listeners: Set<RealtimeListener> = new Set()
  private isSubscribed = false
  private retryCount = 0
  private maxRetries = 10
  private heartbeatTimer: any = null
  private isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline.bind(this))
      window.addEventListener('offline', this.handleOffline.bind(this))
      document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this))
    }
  }

  public init() {
    if (this.channel) return
    this.connect()
    this.startHeartbeat()
  }

  private connect() {
    try {
      const channelName = 'classroom_live_sync_v2'
      this.channel = supabase.channel(channelName, {
        config: {
          broadcast: { self: false },
        },
      })

      // 1. Broadcast channel for instantaneous cross-tab/cross-client notifications (< 50ms)
      this.channel.on('broadcast', { event: 'classroom_content_changed' }, (data: any) => {
        if (data?.payload) {
          this.notifyListeners(data.payload)
          this.dispatchCustomWindowEvents(data.payload)
        }
      })

      // 2. Direct PostgreSQL Change Listeners
      // Posts table (homework, announcements & __SYSTEM_EXAMS__)
      this.channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts' },
        (payload: any) => {
          const action = payload.eventType === 'INSERT' ? 'create' : payload.eventType === 'DELETE' ? 'delete' : 'update'
          const item = payload.new || payload.old

          // If __SYSTEM_EXAMS__ changed in posts, notify exam listeners cleanly
          if (item?.title === '__SYSTEM_EXAMS__') {
            const examSignal: RealtimeBroadcastPayload = {
              type: 'exam',
              action: 'update',
              timestamp: Date.now(),
            }
            this.notifyListeners(examSignal)
            this.dispatchCustomWindowEvents(examSignal)
            return
          }

          const broadcastPayload: RealtimeBroadcastPayload = {
            type: 'post',
            action,
            item: payload.new,
            id: item?.id,
            timestamp: Date.now(),
          }
          this.notifyListeners(broadcastPayload)
          this.dispatchCustomWindowEvents(broadcastPayload)
        }
      )

      // Quizzes changes are delivered via broadcast + student_poll_fingerprint RPC (direct postgres_changes omitted due to RLS on public.quizzes)

      // Grades table (student report card updates)
      this.channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'grades' },
        (payload: any) => {
          const action = payload.eventType === 'INSERT' ? 'create' : payload.eventType === 'DELETE' ? 'delete' : 'update'
          const item = payload.new || payload.old
          const broadcastPayload: RealtimeBroadcastPayload = {
            type: 'grade',
            action,
            item: payload.new,
            id: item?.id,
            studentId: item?.student_id,
            timestamp: Date.now(),
          }
          this.notifyListeners(broadcastPayload)
          this.dispatchCustomWindowEvents(broadcastPayload)
        }
      )

      // Submissions table (homework file/note submissions)
      this.channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'submissions' },
        (payload: any) => {
          const action = payload.eventType === 'INSERT' ? 'create' : payload.eventType === 'DELETE' ? 'delete' : 'update'
          const item = payload.new || payload.old
          const broadcastPayload: RealtimeBroadcastPayload = {
            type: 'submission',
            action,
            item: payload.new,
            id: item?.id,
            studentId: item?.student_id,
            timestamp: Date.now(),
          }
          this.notifyListeners(broadcastPayload)
          this.dispatchCustomWindowEvents(broadcastPayload)
        }
      )

      // Quiz Submissions table (online exam submissions)
      this.channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'quiz_submissions' },
        (payload: any) => {
          const action = payload.eventType === 'INSERT' ? 'create' : payload.eventType === 'DELETE' ? 'delete' : 'update'
          const item = payload.new || payload.old
          const broadcastPayload: RealtimeBroadcastPayload = {
            type: 'submission',
            action,
            item: payload.new,
            id: item?.id,
            studentId: item?.student_id,
            timestamp: Date.now(),
          }
          this.notifyListeners(broadcastPayload)
          this.dispatchCustomWindowEvents(broadcastPayload)
        }
      )

      // Attendance table (attendance records)
      this.channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'attendance' },
        (payload: any) => {
          const action = payload.eventType === 'INSERT' ? 'create' : payload.eventType === 'DELETE' ? 'delete' : 'update'
          const item = payload.new || payload.old
          const broadcastPayload: RealtimeBroadcastPayload = {
            type: 'attendance',
            action,
            item: payload.new,
            id: item?.id,
            studentId: item?.student_id,
            timestamp: Date.now(),
          }
          this.notifyListeners(broadcastPayload)
          this.dispatchCustomWindowEvents(broadcastPayload)
        }
      )

      this.channel.subscribe((status: string, err?: any) => {
        if (status === 'SUBSCRIBED') {
          this.isSubscribed = true
          this.retryCount = 0
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isSubscribed = false
          this.scheduleReconnect()
        }
      })
    } catch (e) {
      console.warn('[RealtimeSync] Connection error:', e)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.retryCount >= this.maxRetries) return
    const delay = Math.min(1000 * Math.pow(1.5, this.retryCount), 10000)
    this.retryCount++
    setTimeout(() => {
      if (this.isOnline) {
        if (this.channel) {
          try {
            supabase.removeChannel(this.channel)
          } catch {}
          this.channel = null
        }
        this.connect()
      }
    }, delay)
  }

  private handleOnline() {
    this.isOnline = true
    this.retryCount = 0
    if (!this.isSubscribed) {
      this.connect()
    }
    // Instantly notify components to resync any data missed during offline
    this.notifyListeners({
      type: 'post',
      action: 'update',
      timestamp: Date.now(),
    })
    window.dispatchEvent(new CustomEvent('classroom_network_reconnected'))
  }

  private handleOffline() {
    this.isOnline = false
    this.isSubscribed = false
    window.dispatchEvent(new CustomEvent('classroom_network_disconnected'))
  }

  private handleVisibilityChange() {
    const isBrowserOnline = typeof navigator !== 'undefined' ? navigator.onLine : this.isOnline
    if (typeof document !== 'undefined' && !document.hidden && document.visibilityState === 'visible' && isBrowserOnline) {
      this.isOnline = true
      // Tab became active again; ensure Realtime connection is alive
      if (!this.isSubscribed) {
        this.connect()
      }
      window.dispatchEvent(new CustomEvent('classroom_tab_activated'))
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    // Primary sync runs over Realtime broadcast/postgres_changes; heartbeat only restores connection every 45s while tab is visible
    this.heartbeatTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      const isBrowserOnline = typeof navigator !== 'undefined' ? navigator.onLine : this.isOnline
      if (!isBrowserOnline) return
      if (!this.isSubscribed) {
        this.connect()
      }
    }, 45000)
  }

  public subscribe(listener: RealtimeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notifyListeners(payload: RealtimeBroadcastPayload) {
    this.listeners.forEach((listener) => {
      try {
        listener(payload)
      } catch (err) {
        console.warn('[RealtimeSync] Listener error:', err)
      }
    })
  }

  private dispatchCustomWindowEvents(payload: RealtimeBroadcastPayload) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('classroom_realtime_event', { detail: payload }))

    switch (payload.type) {
      case 'post':
        window.dispatchEvent(new CustomEvent('classroom_posts_updated', { detail: payload }))
        break
      case 'exam':
        window.dispatchEvent(new CustomEvent('classroom_exams_updated', { detail: payload }))
        window.dispatchEvent(new CustomEvent('exams-updated', { detail: payload }))
        break
      case 'grade':
        window.dispatchEvent(new CustomEvent('classroom_grades_updated', { detail: payload }))
        break
      case 'submission':
        window.dispatchEvent(new CustomEvent('classroom_submissions_updated', { detail: payload }))
        break
      case 'attendance':
        window.dispatchEvent(new CustomEvent('classroom_attendance_updated', { detail: payload }))
        break
    }
  }

  public getIsSubscribed(): boolean {
    return this.isSubscribed
  }

  /**
   * Broadcast an instantaneous notification to all connected clients & tabs (<50ms)
   */
  public async broadcast(payload: Omit<RealtimeBroadcastPayload, 'timestamp'>): Promise<void> {
    // Strip answer keys before broadcasting exams over public channel
    const safeItem =
      payload.type === 'exam' && payload.item ? sanitizeExamForStudent(payload.item as Exam) : payload.item

    const fullPayload: RealtimeBroadcastPayload = {
      ...payload,
      item: safeItem,
      timestamp: Date.now(),
    }

    // 1. Immediately notify local listeners on this client
    this.notifyListeners(fullPayload)
    this.dispatchCustomWindowEvents(fullPayload)

    // Ensure channel exists before attempting broadcast
    if (!this.channel) {
      this.init()
      // Give WebSocket up to 1200ms to reach SUBSCRIBED on cold start
      for (let i = 0; i < 12 && !this.isSubscribed; i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    // 2. Broadcast via Supabase Realtime channel to other clients
    if (this.channel) {
      try {
        await this.channel.send({
          type: 'broadcast',
          event: 'classroom_content_changed',
          payload: fullPayload,
        })
      } catch (err) {
        console.warn('[RealtimeSync] Broadcast send warning:', err)
      }
    }

    // 3. Notify backend server to invalidate caches immediately
    if (!isBackendStaticOnly()) {
      try {
        await fetchWithTimeout(
          '/api/sync/notify',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fullPayload),
          },
          2000
        ).catch(() => {})
      } catch {}
    }
  }

  public destroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.channel) {
      try {
        supabase.removeChannel(this.channel)
      } catch {}
      this.channel = null
    }
    this.listeners.clear()
    this.isSubscribed = false
  }
}

export const realtimeSync = new RealtimeSyncManager()

export interface TableFingerprintEntry {
  count: number
  max_updated_at: string | null
}

export interface StudentPollFingerprint {
  posts: TableFingerprintEntry
  quizzes: TableFingerprintEntry
  grades: TableFingerprintEntry
  quiz_submissions?: TableFingerprintEntry
  submissions?: TableFingerprintEntry
}

export interface TeacherPollFingerprint {
  posts: TableFingerprintEntry
  quizzes: TableFingerprintEntry
  quiz_submissions: TableFingerprintEntry
  submissions?: TableFingerprintEntry
  grades: TableFingerprintEntry
  attendance: TableFingerprintEntry
}

export interface PollFingerprintResult<T> {
  ok: boolean
  data: T | null
  error?: unknown
  skipped?: boolean
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim())
}

function normalizeEntry(raw: any): TableFingerprintEntry {
  return {
    count: typeof raw?.count === 'number' ? raw.count : Number(raw?.count) || 0,
    max_updated_at: raw?.max_updated_at ? String(raw.max_updated_at) : null,
  }
}

export function hasFingerprintEntryChanged(
  prev?: TableFingerprintEntry | null,
  next?: TableFingerprintEntry | null
): boolean {
  if (!prev || !next) return false
  return prev.count !== next.count || (prev.max_updated_at ?? null) !== (next.max_updated_at ?? null)
}

/**
 * Single-request lightweight polling fingerprint for a student (1 RPC call total).
 * Skips immediately if studentId is not a valid UUID (e.g. teacher preview mode).
 */
export async function fetchStudentPollFingerprint(
  studentId: string,
  accessCode: string
): Promise<PollFingerprintResult<StudentPollFingerprint>> {
  if (!isValidUuid(studentId) || !accessCode) {
    return { ok: false, data: null, skipped: true }
  }
  try {
    const { data, error } = await supabase.rpc('student_poll_fingerprint', {
      p_student_id: studentId.trim(),
      p_access_code: accessCode,
    })
    if (error || !data || typeof data !== 'object') {
      return { ok: false, data: null, error: error || new Error('Invalid student_poll_fingerprint response') }
    }
    return {
      ok: true,
      data: {
        posts: normalizeEntry((data as any).posts),
        quizzes: normalizeEntry((data as any).quizzes),
        grades: normalizeEntry((data as any).grades),
        quiz_submissions: (data as any).quiz_submissions
          ? normalizeEntry((data as any).quiz_submissions)
          : undefined,
        submissions: (data as any).submissions ? normalizeEntry((data as any).submissions) : undefined,
      },
    }
  } catch (err) {
    return { ok: false, data: null, error: err }
  }
}

/**
 * Single-request lightweight polling fingerprint for teacher (1 RPC call total).
 */
export async function fetchTeacherPollFingerprint(
  password: string
): Promise<PollFingerprintResult<TeacherPollFingerprint>> {
  if (!password) {
    return { ok: false, data: null, skipped: true }
  }
  try {
    const { data, error } = await supabase.rpc('teacher_poll_fingerprint', {
      p_password: password,
    })
    if (error || !data || typeof data !== 'object') {
      return { ok: false, data: null, error: error || new Error('Invalid teacher_poll_fingerprint response') }
    }
    return {
      ok: true,
      data: {
        posts: normalizeEntry((data as any).posts),
        quizzes: normalizeEntry((data as any).quizzes),
        quiz_submissions: normalizeEntry((data as any).quiz_submissions),
        submissions: (data as any).submissions ? normalizeEntry((data as any).submissions) : undefined,
        grades: normalizeEntry((data as any).grades),
        attendance: normalizeEntry((data as any).attendance),
      },
    }
  } catch (err) {
    return { ok: false, data: null, error: err }
  }
}

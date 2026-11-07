import { supabase } from '../supabaseClient'
import { Exam, StudentExamSubmission } from '../types/examTypes'

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
      // Posts table (homework & announcements)
      this.channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts' },
        (payload: any) => {
          const action = payload.eventType === 'INSERT' ? 'create' : payload.eventType === 'DELETE' ? 'delete' : 'update'
          const item = payload.new || payload.old
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

      // Quizzes table (online exams & interactive homework)
      this.channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'quizzes' },
        (payload: any) => {
          const action = payload.eventType === 'INSERT' ? 'create' : payload.eventType === 'DELETE' ? 'delete' : 'update'
          const item = payload.new || payload.old
          const broadcastPayload: RealtimeBroadcastPayload = {
            type: 'exam',
            action,
            item: payload.new,
            id: item?.id,
            timestamp: Date.now(),
          }
          this.notifyListeners(broadcastPayload)
          this.dispatchCustomWindowEvents(broadcastPayload)
        }
      )

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
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && this.isOnline) {
      // Tab became active again; ensure connection is alive and request fresh updates
      if (!this.isSubscribed) {
        this.connect()
      }
      window.dispatchEvent(new CustomEvent('classroom_tab_activated'))
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    // Lightweight heartbeat every 15s to check connectivity and poll if disconnected
    this.heartbeatTimer = setInterval(() => {
      if (!this.isSubscribed && this.isOnline) {
        this.connect()
      }
    }, 15000)
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

  /**
   * Broadcast an instantaneous notification to all connected clients & tabs (<50ms)
   */
  public async broadcast(payload: Omit<RealtimeBroadcastPayload, 'timestamp'>): Promise<void> {
    const fullPayload: RealtimeBroadcastPayload = {
      ...payload,
      timestamp: Date.now(),
    }

    // 1. Immediately notify local listeners on this client
    this.notifyListeners(fullPayload)
    this.dispatchCustomWindowEvents(fullPayload)

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
    try {
      fetch('/api/sync/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullPayload),
      }).catch(() => {})
    } catch {}
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

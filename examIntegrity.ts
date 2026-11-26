import { supabase } from '../supabaseClient'

/**
 * Online exam integrity monitoring (نظارت بر آزمون آنلاین).
 *
 * What a web page CAN detect: leaving the exam page/app, switching windows, screenshot keyboard
 * shortcuts on computers (PrintScreen, Win+Shift+S, Cmd+Shift+3/4/5), print, copy/cut/paste and the
 * long-press menu. What NO website can detect: a screenshot taken with the phone's own buttons.
 * That is why the exam page also shows a watermark with the student's name, so any screenshot that
 * gets shared shows exactly who took it.
 */

export type IntegrityEventType =
  | 'left_page'
  | 'returned'
  | 'window_blur'
  | 'screenshot_key'
  | 'print'
  | 'copy'
  | 'paste'
  | 'context_menu'

export interface IntegrityEvent {
  id: string
  type: IntegrityEventType | string
  at: string
  detail?: string
  duration_sec?: number | null
  server_at?: string
}

export interface IntegrityLogRow {
  student_id: string
  exam_id: string
  student_name: string
  events: IntegrityEvent[]
  event_count: number
  updated_at: string
}

export const INTEGRITY_EVENT_LABELS: Record<string, string> = {
  left_page: 'خروج از صفحه آزمون',
  returned: 'بازگشت به آزمون',
  window_blur: 'رفتن به پنجره دیگر',
  screenshot_key: 'زدن کلید اسکرین‌شات',
  print: 'تلاش برای چاپ صفحه',
  copy: 'کپی کردن متن سؤال',
  paste: 'چسباندن متن از بیرون',
  context_menu: 'نگه‌داشتن انگشت / منوی کپی',
}

export function describeIntegrityEvent(ev: IntegrityEvent): string {
  const label = INTEGRITY_EVENT_LABELS[ev.type] || 'رفتار مشکوک'
  const dur = typeof ev.duration_sec === 'number' && ev.duration_sec > 0 ? ` (${Math.round(ev.duration_sec)} ثانیه)` : ''
  return `${label}${dur}`
}

export function summarizeIntegrityEvents(events: IntegrityEvent[] | undefined | null): {
  total: number
  byType: Record<string, number>
  awaySeconds: number
  text: string
} {
  const list = Array.isArray(events) ? events : []
  const byType: Record<string, number> = {}
  let awaySeconds = 0
  for (const ev of list) {
    if (!ev || !ev.type) continue
    byType[ev.type] = (byType[ev.type] || 0) + 1
    if ((ev.type === 'returned' || ev.type === 'window_blur') && typeof ev.duration_sec === 'number') {
      awaySeconds += ev.duration_sec
    }
  }
  const parts: string[] = []
  if (byType.screenshot_key) parts.push(`${byType.screenshot_key} اسکرین‌شات`)
  if (byType.left_page) parts.push(`${byType.left_page} خروج از صفحه`)
  if (byType.window_blur) parts.push(`${byType.window_blur} تعویض پنجره`)
  if (byType.copy) parts.push(`${byType.copy} کپی`)
  if (byType.paste) parts.push(`${byType.paste} چسباندن`)
  if (byType.print) parts.push(`${byType.print} چاپ`)
  if (byType.context_menu) parts.push(`${byType.context_menu} منوی کپی`)
  return { total: list.length, byType, awaySeconds: Math.round(awaySeconds), text: parts.join('، ') }
}

function makeEventId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {}
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function isMissingFunctionError(err: any): boolean {
  const code = String(err?.code || '')
  const msg = String(err?.message || '').toLowerCase()
  return code === 'PGRST202' || code === '42883' || msg.includes('could not find the function')
}

let teacherRpcMissing = false

/** Teacher: read all integrity logs (empty list if the SQL migration has not been run yet). */
export async function fetchExamIntegrityLogs(teacherPassword: string): Promise<{ ok: boolean; rows: IntegrityLogRow[]; missing?: boolean }> {
  if (!teacherPassword) return { ok: false, rows: [] }
  if (teacherRpcMissing) return { ok: false, rows: [], missing: true }
  try {
    const { data, error } = await supabase.rpc('teacher_list_exam_integrity', { p_password: teacherPassword, p_since: null })
    if (error) {
      if (isMissingFunctionError(error)) teacherRpcMissing = true
      return { ok: false, rows: [], missing: teacherRpcMissing }
    }
    return { ok: true, rows: Array.isArray(data) ? (data as IntegrityLogRow[]) : [] }
  } catch {
    return { ok: false, rows: [] }
  }
}

export interface IntegrityMonitorHandle {
  stop: () => void
  getEvents: () => IntegrityEvent[]
}

/**
 * Starts monitoring the exam page. Events are kept on the device (survive refresh), sent live to the
 * server (when the SQL migration is installed) and also attached to the final submission.
 */
export function startExamIntegrityMonitor(params: {
  examId: string
  studentId: string
  accessCode: string
  onEvent?: (ev: IntegrityEvent) => void
}): IntegrityMonitorHandle {
  const { examId, studentId, accessCode, onEvent } = params
  const storageKey = `exam_integrity_${examId}_${studentId}`
  const sentKey = `${storageKey}_sent`
  let events: IntegrityEvent[] = []
  let sentIds = new Set<string>()
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) events = JSON.parse(raw) || []
    const rawSent = localStorage.getItem(sentKey)
    if (rawSent) sentIds = new Set(JSON.parse(rawSent) || [])
  } catch {}

  let stopped = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushing = false
  let rpcMissing = false
  let hiddenAt: number | null = null
  let blurAt: number | null = null
  let lastShotAt = 0

  const persist = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(events.slice(-300)))
      localStorage.setItem(sentKey, JSON.stringify(Array.from(sentIds).slice(-300)))
    } catch {}
  }

  const flush = async () => {
    if (flushing || rpcMissing) return
    const pending = events.filter((e) => !sentIds.has(e.id))
    if (pending.length === 0) return
    if (!/^[0-9a-f-]{36}$/i.test(studentId) || !accessCode) return
    flushing = true
    try {
      const { error } = await supabase.rpc('student_log_exam_integrity', {
        p_student_id: studentId,
        p_access_code: accessCode,
        p_exam_id: examId,
        p_events: pending.slice(0, 100),
      })
      if (!error) {
        pending.slice(0, 100).forEach((e) => sentIds.add(e.id))
        persist()
      } else if (isMissingFunctionError(error)) {
        rpcMissing = true
      } else {
        scheduleFlush(15000)
      }
    } catch {
      scheduleFlush(15000)
    } finally {
      flushing = false
    }
  }

  const scheduleFlush = (delay = 2500) => {
    if (stopped && delay > 0) return
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, delay)
  }

  const record = (type: IntegrityEventType, detail = '', durationSec: number | null = null) => {
    if (stopped) return
    const ev: IntegrityEvent = {
      id: makeEventId(),
      type,
      at: new Date().toISOString(),
      detail: detail.slice(0, 200),
      duration_sec: durationSec,
    }
    events.push(ev)
    if (events.length > 300) events = events.slice(-300)
    persist()
    try {
      onEvent?.(ev)
    } catch {}
    scheduleFlush()
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      blurAt = null
      // Try to send right away: the student may never come back to this page
      record('left_page', 'صفحه آزمون پنهان شد (رفتن به برنامه یا تب دیگر)')
      void flush()
    } else if (hiddenAt) {
      const seconds = Math.round((Date.now() - hiddenAt) / 1000)
      hiddenAt = null
      if (seconds >= 1) record('returned', `بازگشت به آزمون پس از ${seconds} ثانیه`, seconds)
    }
  }

  const onBlur = () => {
    if (document.visibilityState === 'hidden') return
    blurAt = Date.now()
  }

  const onFocus = () => {
    if (!blurAt) return
    const seconds = Math.round((Date.now() - blurAt) / 1000)
    blurAt = null
    if (seconds >= 2 && document.visibilityState === 'visible') {
      record('window_blur', `خروج از پنجره آزمون به مدت ${seconds} ثانیه`, seconds)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    const key = String(e.key || '')
    const lower = key.toLowerCase()
    const isPrintScreen = key === 'PrintScreen' || e.code === 'PrintScreen'
    const isWinSnip = (e.metaKey || e.getModifierState?.('OS')) && e.shiftKey && lower === 's'
    const isMacShot = e.metaKey && e.shiftKey && ['3', '4', '5', '6'].includes(key)
    const isPrint = (e.ctrlKey || e.metaKey) && lower === 'p'
    if (isPrintScreen || isWinSnip || isMacShot) {
      // keydown + keyup of the same shortcut must count once
      if (Date.now() - lastShotAt < 1500) return
      lastShotAt = Date.now()
      record('screenshot_key', isPrintScreen ? 'کلید PrintScreen' : isWinSnip ? 'میانبر Win+Shift+S' : 'میانبر اسکرین‌شات مک')
    } else if (isPrint && e.type === 'keydown') {
      e.preventDefault()
      record('print', 'میانبر Ctrl+P')
    }
  }

  const isEditable = (target: EventTarget | null) => {
    const el = target as HTMLElement | null
    if (!el) return false
    const tag = (el.tagName || '').toLowerCase()
    return tag === 'input' || tag === 'textarea' || Boolean(el.isContentEditable)
  }

  const onCopy = (e: ClipboardEvent) => {
    if (isEditable(e.target)) return
    e.preventDefault()
    record('copy', 'تلاش برای کپی متن سؤال')
  }

  const onCut = (e: ClipboardEvent) => {
    if (isEditable(e.target)) return
    e.preventDefault()
    record('copy', 'تلاش برای برش متن')
  }

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text') || ''
    if (text.trim().length >= 15) {
      record('paste', `چسباندن ${text.trim().length} نویسه در پاسخ`)
    }
  }

  const onContextMenu = (e: MouseEvent) => {
    if (isEditable(e.target)) return
    e.preventDefault()
    record('context_menu', 'باز کردن منوی کپی/ذخیره (نگه‌داشتن انگشت یا کلیک راست)')
  }

  const onBeforePrint = () => record('print', 'تلاش برای چاپ صفحه')

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)
  window.addEventListener('keyup', onKey, true)
  window.addEventListener('keydown', onKey, true)
  document.addEventListener('copy', onCopy, true)
  document.addEventListener('cut', onCut, true)
  document.addEventListener('paste', onPaste, true)
  document.addEventListener('contextmenu', onContextMenu, true)
  window.addEventListener('beforeprint', onBeforePrint)

  // Send anything left from a previous visit (e.g. phone was locked mid-exam)
  scheduleFlush(1000)

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('copy', onCopy, true)
      document.removeEventListener('cut', onCut, true)
      document.removeEventListener('paste', onPaste, true)
      document.removeEventListener('contextmenu', onContextMenu, true)
      window.removeEventListener('beforeprint', onBeforePrint)
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = null
      void flush()
    },
    getEvents: () => [...events],
  }
}

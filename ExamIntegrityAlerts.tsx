import { useEffect, useRef, useState } from 'react'
import {
  fetchExamIntegrityLogs,
  IntegrityLogRow,
  describeIntegrityEvent,
} from '../services/examIntegrity'
import { toPersianDigits } from '../utils/persianNumbers'
import { sanitizeExamTitle } from '../utils/examStore'
import { Exam } from '../types/examTypes'

/** Polls the live integrity log (every `pollMs`) and returns rows keyed by `${examId}::${studentId}`. */
export function useExamIntegrityLogs(teacherPassword: string, pollMs = 12000, enabled = true) {
  const [rows, setRows] = useState<IntegrityLogRow[]>([])
  const [missing, setMissing] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)

  useEffect(() => {
    if (!enabled || !teacherPassword) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = async () => {
      if (cancelled) return
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        const res = await fetchExamIntegrityLogs(teacherPassword)
        if (cancelled) return
        if (res.missing) {
          setMissing(true)
          return
        }
        if (res.ok) {
          setRows(res.rows)
          setLoadedOnce(true)
        }
      }
      timer = setTimeout(run, pollMs)
    }
    void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [teacherPassword, pollMs, enabled])

  const byKey = new Map<string, IntegrityLogRow>()
  for (const r of rows) byKey.set(`${r.exam_id}::${r.student_id}`, r)
  return { rows, byKey, missing, loadedOnce }
}

interface AlertToast {
  key: string
  text: string
  sub: string
  at: number
}

/**
 * Floating live alerts for the teacher: "⚠️ <student> — left the exam page / screenshot key…".
 * Shown on every tab of the teacher dashboard while an online exam is running.
 */
export default function ExamIntegrityAlerts({ teacherPassword, exams }: { teacherPassword: string; exams: Exam[] }) {
  const { rows, loadedOnce } = useExamIntegrityLogs(teacherPassword, 12000, true)
  const seenRef = useRef<Map<string, number> | null>(null)
  const [toasts, setToasts] = useState<AlertToast[]>([])

  useEffect(() => {
    if (!loadedOnce) return
    const seen = seenRef.current
    const next = new Map<string, number>()
    rows.forEach((r) => next.set(`${r.exam_id}::${r.student_id}`, Number(r.event_count) || 0))
    if (seen === null) {
      // First load: remember what already exists, alert only on NEW events from now on
      seenRef.current = next
      return
    }
    const fresh: AlertToast[] = []
    for (const r of rows) {
      const key = `${r.exam_id}::${r.student_id}`
      const before = seen.get(key) || 0
      const now = Number(r.event_count) || 0
      if (now > before && Array.isArray(r.events) && r.events.length > 0) {
        const newEvents = r.events.slice(-(now - before))
        const last = newEvents[newEvents.length - 1]
        const exam = exams.find((e) => e.id === r.exam_id)
        const title = exam ? sanitizeExamTitle(exam.title, exam.subject) : 'آزمون آنلاین'
        const time = toPersianDigits(
          new Date(last.server_at || last.at || Date.now()).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })
        )
        fresh.push({
          key: `${key}::${now}`,
          text: `⚠️ ${r.student_name || 'دانش‌آموز'}: ${describeIntegrityEvent(last)}${
            newEvents.length > 1 ? ` (+${toPersianDigits(newEvents.length - 1)} مورد دیگر)` : ''
          }`,
          sub: `${title} · ساعت ${time}`,
          at: Date.now(),
        })
      }
    }
    seenRef.current = next
    if (fresh.length > 0) {
      setToasts((prev) => [...fresh, ...prev].slice(0, 6))
    }
  }, [rows, exams, loadedOnce])

  useEffect(() => {
    if (toasts.length === 0) return
    const t = setInterval(() => {
      setToasts((prev) => prev.filter((x) => Date.now() - x.at < 45000))
    }, 3000)
    return () => clearInterval(t)
  }, [toasts.length])

  if (toasts.length === 0) return null

  return (
    <div
      dir="rtl"
      style={{
        position: 'fixed',
        top: 70,
        left: 12,
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 'min(360px, calc(100vw - 24px))',
      }}
    >
      {toasts.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => setToasts((prev) => prev.filter((x) => x.key !== t.key))}
          style={{
            textAlign: 'right',
            background: '#FEF2F2',
            border: '2px solid #F87171',
            borderRadius: 14,
            padding: '10px 12px',
            boxShadow: '0 10px 24px rgba(0,0,0,0.15)',
            cursor: 'pointer',
          }}
          title="برای بستن کلیک کنید"
        >
          <div style={{ fontSize: 12.5, fontWeight: 900, color: '#991B1B' }}>{t.text}</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#7F1D1D', marginTop: 2 }}>{t.sub}</div>
        </button>
      ))}
    </div>
  )
}

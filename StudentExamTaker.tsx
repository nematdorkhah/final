import { useState, useEffect, useRef, useMemo } from 'react'
import confetti from 'canvas-confetti'
import { Exam, ExamQuestion, StudentExamAnswer, StudentExamSubmission } from '../types/examTypes'
import {
  getStudentExamSubmission,
  submitStudentExam,
  submitStudentExamOptimistic,
  computeInstantExamResult,
  InstantExamResult,
  sanitizeExamTitle,
  isExamResultsReleased,
  saveExamDraftToCloud,
  getExamDraftFromCloud,
  deleteExamDraftFromCloud,
} from '../utils/examStore'
import { toPersianDigits } from '../utils/persianNumbers'
import MathRenderer from './MathRenderer'
import { safeNumber, safeScore, safeScaled20, getSubmissionEffectiveScore } from '../utils/persianSemanticGrader'
import { classifyExamForStudent } from '../utils/networkResilience'
import { getServerNowMs } from '../supabaseClient'
import { fetchPublishedExamsWithDiagnostics } from '../utils/examStore'
import { resolveStudentAccessCode } from '../classStudents'
import {
  startExamIntegrityMonitor,
  IntegrityMonitorHandle,
  IntegrityEvent,
  describeIntegrityEvent,
  summarizeIntegrityEvents,
} from '../services/examIntegrity'

interface StudentExamDraft {
  examId: string
  studentId: string
  answers: Record<string, StudentExamAnswer>
  startTime: number
  currentQIndex: number
  lastSavedAt: number
  elapsedSeconds?: number
}

function StudentExamTakerInner({
  exam,
  student,
  initialSubmission,
  onClose,
  onFinished,
}: {
  exam: Exam
  student: any
  initialSubmission?: StudentExamSubmission
  onClose: () => void
  onFinished?: () => void
}) {
  const [existingSubmission, setExistingSubmission] = useState<StudentExamSubmission | undefined>(initialSubmission)
  const [currentQIndex, setCurrentQIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, StudentExamAnswer>>({})
  const [timeLeftSeconds, setTimeLeftSeconds] = useState((Number(exam.durationMinutes) || 30) * 60)
  const [submitting, setSubmitting] = useState(false)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [submittedResult, setSubmittedResult] = useState<StudentExamSubmission | null>(null)
  const [draftRestored, setDraftRestored] = useState(false)
  const [saveIndicator, setSaveIndicator] = useState<'saved' | 'saving'>('saved')
  const [showExitConfirmModal, setShowExitConfirmModal] = useState(false)
  const [exitSaveStatus, setExitSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [exitErrorMessage, setExitErrorMessage] = useState<string | null>(null)

  // Canonical storage key for this specific student and exam
  const studentDraftKey = `exam_draft_${exam.id}_${student.id}`
  const legacyDraftKey = `exam_draft_${exam.id}`

  // Real timestamp when student started this exam
  const startTimeRef = useRef<number>(Date.now())
  const elapsedSecondsRef = useRef<number>(0)

  // Live ref for answers to prevent stale closures inside timer callback
  const answersRef = useRef<Record<string, StudentExamAnswer>>(answers)
  useEffect(() => {
    answersRef.current = answers
  }, [answers])

  // Live listener for background sync completion to update status & notes smoothly
  useEffect(() => {
    function handleUpdate(e: any) {
      const updatedSub = e.detail as StudentExamSubmission
      if (updatedSub && updatedSub.examId === exam.id && String(updatedSub.studentId) === String(student.id)) {
        setSubmittedResult((prev) => (prev ? { ...prev, ...updatedSub } : updatedSub))
        setExistingSubmission((prev) => (prev ? { ...prev, ...updatedSub } : updatedSub))
      }
    }
    window.addEventListener('exam_submission_updated', handleUpdate)
    return () => window.removeEventListener('exam_submission_updated', handleUpdate)
  }, [exam.id, student.id])

  // Use the server clock so a wrong phone clock can neither lock nor unlock the exam early/late
  const scheduleClassification = classifyExamForStudent(exam, getServerNowMs())
  const isAssignment = scheduleClassification.isAssignment
  const isPastDue = scheduleClassification.isPastDue
  const isLockedNotYetStarted = !existingSubmission && (!scheduleClassification.isPublished || !scheduleClassification.isStarted)

  // Cloud draft sync debounce timer ref
  const cloudDraftTimerRef = useRef<any>(null)

  // Cloud copy of the draft is only for continuing on another device: at most one upload every 15s
  // (40 students typing at the same time used to send several requests per second).
  const lastCloudDraftAtRef = useRef(0)
  const pendingCloudDraftRef = useRef<StudentExamDraft | null>(null)
  function syncDraftToCloudAsync(draftObj: StudentExamDraft) {
    pendingCloudDraftRef.current = draftObj
    if (cloudDraftTimerRef.current) return
    const wait = Math.max(0, 15000 - (Date.now() - lastCloudDraftAtRef.current))
    cloudDraftTimerRef.current = setTimeout(() => {
      cloudDraftTimerRef.current = null
      const latest = pendingCloudDraftRef.current
      pendingCloudDraftRef.current = null
      if (!latest) return
      lastCloudDraftAtRef.current = Date.now()
      saveExamDraftToCloud(exam.id, String(student.id), student.full_name, latest).catch(() => {})
    }, wait)
  }

  useEffect(() => {
    return () => {
      if (cloudDraftTimerRef.current) clearTimeout(cloudDraftTimerRef.current)
    }
  }, [])

  // Helper to persist draft immediately to localStorage with monotonic elapsedSeconds
  function persistDraft(updatedAnswers: Record<string, StudentExamAnswer>, qIdx: number = currentQIndex): boolean {
    try {
      const draftObj: StudentExamDraft = {
        examId: exam.id,
        studentId: String(student.id),
        answers: updatedAnswers,
        startTime: startTimeRef.current,
        currentQIndex: qIdx,
        elapsedSeconds: elapsedSecondsRef.current,
        lastSavedAt: Date.now(),
      }
      const serialized = JSON.stringify(draftObj)
      localStorage.setItem(studentDraftKey, serialized)
      localStorage.setItem(legacyDraftKey, serialized)
      setSaveIndicator('saved')
      syncDraftToCloudAsync(draftObj)
      return true
    } catch (err) {
      console.warn('Failed saving exam draft to localStorage', err)
      return false
    }
  }

  async function handleTemporaryExit() {
    setExitSaveStatus('saving')
    setExitErrorMessage(null)
    try {
      const ok = persistDraft(answersRef.current, currentQIndex)
      if (!ok) {
        setExitSaveStatus('error')
        setExitErrorMessage('خطا در ذخیره‌سازی پاسخ‌ها در حافظه مرورگر. لطفاً مجدداً امتحان کنید.')
        return
      }

      // Immediately sync draft to Supabase and server so other devices get it instantly!
      const draftObj: StudentExamDraft = {
        examId: exam.id,
        studentId: String(student.id),
        answers: answersRef.current,
        startTime: startTimeRef.current,
        currentQIndex,
        elapsedSeconds: elapsedSecondsRef.current,
        lastSavedAt: Date.now(),
      }
      await saveExamDraftToCloud(exam.id, String(student.id), student.full_name, draftObj).catch((e) => {
        console.warn('Cloud draft sync warning upon exit:', e)
      })

      setExitSaveStatus('saved')
      setTimeout(() => {
        sessionStorage.removeItem('active_taking_exam_id')
        setShowExitConfirmModal(false)
        onClose()
      }, 500)
    } catch (err: any) {
      setExitSaveStatus('error')
      setExitErrorMessage('خطا در ذخیره‌سازی موقت: ' + (err?.message || 'حافظه در دسترس نیست'))
    }
  }

  // 1. Restore previous submission or saved draft on component mount with anti-tamper logic
  useEffect(() => {
    // Never start the exam clock (or write a draft) while the exam is still locked before its start time
    if (isLockedNotYetStarted) return
    // Check if exam already submitted or passed via initialSubmission prop
    const localSub = getStudentExamSubmission(exam.id, student.id)
    const prevSub = initialSubmission || localSub
    const isApprovedOrReleased = Boolean(
      prevSub?.teacherGrading?.approved ||
      (prevSub && isExamResultsReleased(exam, prevSub))
    )

    if (prevSub) {
      setExistingSubmission(prevSub)
      if (prevSub.answers) {
        setAnswers(prevSub.answers)
        answersRef.current = prevSub.answers
      }

      // If timed exam, or past due date, or officially approved/released by teacher: lock in results view
      if (!isAssignment || isPastDue || isApprovedOrReleased) {
        setSubmittedResult(prevSub)
        return
      }

      // Untimed exam before deadline: keep in live editing mode so student can modify or complete answers
      setSubmittedResult(null)
    }

    // Restore local draft from localStorage if page refreshed or disconnected mid-exam
    try {
      const primaryRaw = localStorage.getItem(studentDraftKey)
      const legacyRaw = !primaryRaw ? localStorage.getItem(legacyDraftKey) : null
      const rawDraft = primaryRaw || legacyRaw

      let initialStartTime = Date.now()
      let initialQIndex = 0
      let previousElapsed = 0

      if (rawDraft) {
        const parsed = JSON.parse(rawDraft)
        if (parsed && typeof parsed === 'object') {
          // Support both new structured draft and legacy plain answers dictionary
          const restoredAnswers: Record<string, StudentExamAnswer> =
            parsed.answers && typeof parsed.answers === 'object'
              ? parsed.answers
              : !parsed.answers && !parsed.startTime && Object.keys(parsed).length > 0
              ? parsed
              : {}

          if (restoredAnswers && Object.keys(restoredAnswers).length > 0) {
            setAnswers(restoredAnswers)
            answersRef.current = restoredAnswers
            setDraftRestored(true)
          }

          if (typeof parsed.currentQIndex === 'number' && parsed.currentQIndex >= 0 && parsed.currentQIndex < exam.questions.length) {
            initialQIndex = parsed.currentQIndex
            setCurrentQIndex(parsed.currentQIndex)
          }

          if (typeof parsed.startTime === 'number' && parsed.startTime > 0) {
            initialStartTime = parsed.startTime
          }

          if (typeof parsed.elapsedSeconds === 'number' && parsed.elapsedSeconds > 0) {
            previousElapsed = parsed.elapsedSeconds
          }
        }
      }

      const now = Date.now()
      let calculatedElapsed = Math.floor((now - initialStartTime) / 1000)

      // Anti-tamper verification:
      // If user sets device clock backwards (now < initialStartTime, or calculatedElapsed < previousElapsed),
      // strictly enforce monotonic time so time cannot be regained.
      if (calculatedElapsed < previousElapsed || calculatedElapsed < 0) {
        console.warn('[Exam Timer] Device clock backward adjustment detected! Enforcing monotonic elapsed time.')
        calculatedElapsed = previousElapsed + 1
        initialStartTime = now - (calculatedElapsed * 1000)
      }

      startTimeRef.current = initialStartTime
      elapsedSecondsRef.current = calculatedElapsed

      // Manage timer based on real elapsed time from startTime
      if (!isAssignment) {
        const totalDurationSec = (Number(exam.durationMinutes) || 30) * 60
        const remainingSec = Math.max(0, totalDurationSec - calculatedElapsed)
        setTimeLeftSeconds(remainingSec)

        if (remainingSec <= 0) {
          // Time expired while away! Automatically trigger auto-submit
          console.warn('[Exam Timer] Exam time expired upon resume; auto-submitting...')
          setTimeout(() => {
            handleAutoSubmit()
          }, 800)
          return
        }
      }

      // Check cloud draft (Supabase & server) for cross-device synchronization
      getExamDraftFromCloud(exam.id, String(student.id)).then((cloudDraft) => {
        if (cloudDraft && cloudDraft.answers && typeof cloudDraft.answers === 'object') {
          const localRaw = localStorage.getItem(studentDraftKey)
          let localTime = 0
          if (localRaw) {
            try { localTime = JSON.parse(localRaw)?.lastSavedAt || 0 } catch {}
          }
          // If cloud draft is newer or local is empty, restore cloud draft
          if (!localTime || (cloudDraft.lastSavedAt && cloudDraft.lastSavedAt > localTime)) {
            console.log('[ExamTaker] Restoring newer cloud draft from Supabase/server for cross-device sync')
            setAnswers((prev) => ({ ...prev, ...cloudDraft.answers }))
            answersRef.current = { ...answersRef.current, ...cloudDraft.answers }
            if (typeof cloudDraft.currentQIndex === 'number' && cloudDraft.currentQIndex >= 0 && cloudDraft.currentQIndex < exam.questions.length) {
              setCurrentQIndex(cloudDraft.currentQIndex)
            }
            setDraftRestored(true)
            localStorage.setItem(studentDraftKey, JSON.stringify(cloudDraft))
          }
        }
      }).catch(() => {})

      // Persist draft immediately so startTime and elapsedSeconds are firmly established
      const initialDraft: StudentExamDraft = {
        examId: exam.id,
        studentId: String(student.id),
        answers: answersRef.current || {},
        startTime: initialStartTime,
        currentQIndex: initialQIndex,
        elapsedSeconds: calculatedElapsed,
        lastSavedAt: Date.now(),
      }
      localStorage.setItem(studentDraftKey, JSON.stringify(initialDraft))
      sessionStorage.setItem('active_taking_exam_id', exam.id)
    } catch (e) {
      console.warn('Failed restoring exam draft from localStorage:', e)
    }
  }, [exam.id, student.id])

  // Timer countdown (only for timed exams, not open assignments) with monotonic tick
  useEffect(() => {
    if (isAssignment || existingSubmission || submittedResult) return
    const timer = setInterval(() => {
      elapsedSecondsRef.current += 1
      setTimeLeftSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          handleAutoSubmit()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [isAssignment, existingSubmission, submittedResult])

  const currentQ: ExamQuestion | undefined = exam.questions[currentQIndex]
  const currentAnswer = currentQ ? answers[currentQ.id] || {} : {}

  const answeredCount = Object.keys(answers).filter((k) => {
    const a = answers[k]
    return a.selectedOption !== undefined || (a.textAnswer && a.textAnswer.trim().length > 0) || a.imageAttachment
  }).length

  function setAnswerForCurrent(field: keyof StudentExamAnswer, val: any) {
    if (!currentQ) return
    setSaveIndicator('saving')
    setAnswers((prev) => {
      const updated = {
        ...prev,
        [currentQ.id]: {
          ...(prev[currentQ.id] || {}),
          [field]: val,
        },
      }
      answersRef.current = updated
      // Instantly save to local draft so page refresh, tab closing or network disconnect preserves all answers
      persistDraft(updated, currentQIndex)
      return updated
    })
  }

  function handleSelectOption(optIdx: number, optText: string) {
    if (!currentQ) return
    setSaveIndicator('saving')
    setAnswers((prev) => {
      const updated = {
        ...prev,
        [currentQ.id]: {
          ...(prev[currentQ.id] || {}),
          selectedOption: optIdx,
          selectedOptionIndex: optIdx,
          selectedOptionText: optText,
        },
      }
      answersRef.current = updated
      persistDraft(updated, currentQIndex)
      return updated
    })
  }

  function handleQuestionChange(newIdx: number) {
    setCurrentQIndex(newIdx)
    persistDraft(answersRef.current, newIdx)
  }

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onloadend = () => {
      const original = reader.result as string
      // Phone photos are 3–8 MB; shrink to ≤1280px JPEG so drafts and the final submission stay small
      const img = new Image()
      img.onload = () => {
        try {
          const maxSide = 1280
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(img.width * scale))
          canvas.height = Math.max(1, Math.round(img.height * scale))
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('no canvas')
          ctx.fillStyle = '#FFFFFF'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          const compressed = canvas.toDataURL('image/jpeg', 0.72)
          setAnswerForCurrent('imageAttachment', compressed.length < original.length ? compressed : original)
        } catch {
          setAnswerForCurrent('imageAttachment', original)
        }
      }
      img.onerror = () => setAnswerForCurrent('imageAttachment', original)
      img.src = original
    }
    reader.readAsDataURL(file)
  }

  async function handleAutoSubmit() {
    await doSubmit(answersRef.current)
  }

  function doSubmit(explicitAnswers?: Record<string, StudentExamAnswer>) {
    setShowConfirmModal(false)
    const targetAnswers = explicitAnswers || answersRef.current || answers

    try {
      // 1. Instant Optimistic Submission (< 10ms execution, zero waiting)
      const integrityEvents = integrityMonitorRef.current?.getEvents() || integrityEventsRef.current
      integrityMonitorRef.current?.stop()
      integrityMonitorRef.current = null
      const sub = submitStudentExamOptimistic({
        exam,
        studentId: student.id,
        studentName: student.full_name,
        answers: targetAnswers,
        studentAccessCode: resolveStudentAccessCode(student),
        integrity: isAssignment
          ? undefined
          : { events: integrityEvents, summary: summarizeIntegrityEvents(integrityEvents) },
      })

      // 2. Celebratory confetti animation
      confetti({ particleCount: 90, spread: 75, origin: { y: 0.6 } })

      // 3. Clear in-progress drafts from storage (local & cloud)
      try {
        localStorage.removeItem(studentDraftKey)
        localStorage.removeItem(legacyDraftKey)
        sessionStorage.removeItem('active_taking_exam_id')
      } catch {}
      deleteExamDraftFromCloud(exam.id, String(student.id))

      // 4. Instantly display result screen without blocking
      setSubmittedResult(sub)
      setExistingSubmission(sub)
      setSubmitting(false)

      if (onFinished) onFinished()
    } catch (e: any) {
      console.error('Optimistic exam submit error:', e)
      setSubmitting(false)
      alert('خطا در ثبت آزمون: ' + (e?.message || 'خطای نامشخص'))
    }
  }

  // ---------------- Exam integrity monitoring (timed online exams only) ----------------
  const integrityMonitorRef = useRef<IntegrityMonitorHandle | null>(null)
  const integrityEventsRef = useRef<IntegrityEvent[]>([])
  const [integrityWarning, setIntegrityWarning] = useState<string | null>(null)
  const isActivelyTaking = !isAssignment && !isLockedNotYetStarted && !submittedResult && !existingSubmission
  useEffect(() => {
    if (!isActivelyTaking) return
    let warnTimer: ReturnType<typeof setTimeout> | null = null
    const handle = startExamIntegrityMonitor({
      examId: exam.id,
      studentId: String(student.id),
      accessCode: resolveStudentAccessCode(student),
      onEvent: (ev) => {
        integrityEventsRef.current = [...integrityEventsRef.current, ev]
        setIntegrityWarning(`⚠️ ${describeIntegrityEvent(ev)} — ثبت شد و برای آموزگار ارسال می‌شود.`)
        if (warnTimer) clearTimeout(warnTimer)
        warnTimer = setTimeout(() => setIntegrityWarning(null), 6000)
      },
    })
    integrityMonitorRef.current = handle
    integrityEventsRef.current = handle.getEvents()
    return () => {
      if (warnTimer) clearTimeout(warnTimer)
      handle.stop()
      if (integrityMonitorRef.current === handle) integrityMonitorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActivelyTaking, exam.id, student.id])

  const watermarkText = `${student?.full_name || 'دانش‌آموز'} · ${toPersianDigits(
    new Date(getServerNowMs()).toLocaleDateString('fa-IR')
  )}`

  const minutes = Math.floor(timeLeftSeconds / 60)
  const seconds = timeLeftSeconds % 60
  const formattedTime = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`

  // Defense-in-depth: never expose questions for unpublished drafts or future scheduled exams before start time
  if (isLockedNotYetStarted) {
    const startLabel = scheduleClassification.startMs
      ? toPersianDigits(new Date(scheduleClassification.startMs).toLocaleString('fa-IR'))
      : 'نامشخص'
    return (
      <div
        dir="rtl"
        className="fixed inset-0 z-[99999] bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-4 font-sans"
      >
        <div className="bg-white border-2 border-amber-300 rounded-2xl p-6 max-w-md w-full text-center shadow-xl space-y-3">
          <div className="text-4xl">⏳</div>
          <h3 className="text-base font-black text-slate-900">
            {!scheduleClassification.isPublished
              ? 'این آزمون هنوز منتشر نشده است'
              : 'زمان شروع این آزمون هنوز فرا نرسیده است'}
          </h3>
          <p className="text-xs text-slate-600 leading-relaxed">
            {!scheduleClassification.isPublished
              ? 'آموزگار هنوز این آزمون را برای دانش‌آموزان منتشر نکرده است.'
              : `زمان آغاز آزمون: ${startLabel}. به محض رسیدن زمان مقرر، می‌توانید وارد صفحه آزمون شوید.`}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black cursor-pointer"
          >
            بازگشت به داشبورد
          </button>
        </div>
      </div>
    )
  }

  // If student has submitted:
  if (submittedResult || existingSubmission) {
    const sub = submittedResult || existingSubmission!
    const resultsReleased = isExamResultsReleased(exam, sub)

    // 1. If teacher has NOT released results yet (or timed exam is still active):
    // Display reassuring confirmation message WITHOUT revealing scores or answer key!
    if (!resultsReleased) {
      const isSyncing = sub.syncStatus === 'syncing'
      const isFailed = sub.syncStatus === 'failed'

      return (
        <div
          dir="rtl"
          className="fixed inset-0 z-[99999] bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 overflow-y-auto font-sans"
          onClick={onClose}
        >
          <div
            className="bg-white rounded-3xl p-6 sm:p-8 max-w-lg w-full my-auto border-2 border-slate-800 shadow-2xl text-center relative overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top colored stripe */}
            <div className="absolute top-0 right-0 left-0 h-2.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500" />

            <div className="text-5xl sm:text-6xl mb-3 animate-pulse">
              📩
            </div>

            <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight mb-1">
              پاسخ شما با موفقیت ثبت شد!
            </h2>

            <p className="text-xs sm:text-sm text-slate-500 font-medium mb-4">
              دانش‌آموز گرامی: <strong>{student.full_name || 'دانش‌آموز'}</strong> · {exam.title}
            </p>

            {/* Primary Status Banner: Awaiting Teacher Confirmation */}
            <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4 sm:p-5 mb-5 text-center shadow-xs">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-black bg-amber-100 text-amber-800 border border-amber-300 mb-2">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
                <span>⏳ در انتظار بررسی و تایید آموزگار</span>
              </div>
              <p className="text-sm font-black text-amber-950 leading-relaxed mb-0">
                پاسخ شما با موفقیت ثبت شد و در انتظار تایید معلم است.
              </p>
              <p className="text-xs text-amber-800 mt-2 font-medium leading-relaxed">
                {isAssignment
                  ? 'برای این آزمون/تکلیف، ریزنمرات و کلید پاسخ‌ها پس از بررسی و انتشار رسمی کارنامه توسط معلم فعال خواهد شد.'
                  : 'کارنامه تفصیلی و کلید پاسخ‌ها پس از اتمام کامل مهلت کلی آزمون یا پس از تایید و انتشار توسط معلم فعال خواهد شد.'}
              </p>
            </div>

            {/* Summary Details Grid (Questions count & submission time) */}
            <div className="grid grid-cols-2 gap-2.5 mb-5 text-center">
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3">
                <div className="text-xs text-slate-500 font-bold">تعداد سوالات پاسخ‌داده‌شده</div>
                <div className="text-base sm:text-lg font-black text-slate-800 mt-0.5">
                  {toPersianDigits(answeredCount)} از {toPersianDigits(exam.questions.length)} سوال
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3">
                <div className="text-xs text-slate-500 font-bold">زمان ثبت پاسخ‌نامه</div>
                <div className="text-base sm:text-lg font-black text-slate-800 mt-0.5">
                  {toPersianDigits(new Date(sub.submittedAt || Date.now()).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }))}
                </div>
              </div>
            </div>

            {/* Cloud Sync Status Indicator */}
            <div className="mb-5">
              {isSyncing ? (
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold bg-blue-50 border border-blue-200 text-blue-700 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-blue-600 animate-ping" />
                  <span>☁️ در حال ثبت نهایی در سامانه ابری کلاسی...</span>
                </div>
              ) : isFailed ? (
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold bg-amber-50 border border-amber-200 text-amber-800">
                  <span>💾</span>
                  <span>پاسخ‌ها در حافظه دستگاه ذخیره شد و با برقراری شبکه ارسال می‌شود.</span>
                </div>
              ) : (
                <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold bg-emerald-50 border border-emerald-200 text-emerald-800">
                  <span>✓</span>
                  <span>پاسخ‌ها در دیتابیس کلاسی و پنل آموزگار ذخیره گردید</span>
                </div>
              )}
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5 mt-2">
              {isAssignment && !isPastDue && (
                <button
                  type="button"
                  onClick={() => setSubmittedResult(null)}
                  className="flex-1 py-3 px-4 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-black text-xs sm:text-sm rounded-xl transition-all shadow-md cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <span>✏️</span>
                  <span>ویرایش و تغییر پاسخ‌ها</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-3 px-4 bg-slate-900 hover:bg-slate-800 active:scale-95 text-white font-black text-xs sm:text-sm rounded-xl transition-all shadow-md cursor-pointer"
              >
                متوجه شدم (بازگشت به کلاس)
              </button>
            </div>
          </div>
        </div>
      )
    }

    // 2. If results ARE officially released: Show full report card & answers breakdown
    const eff = getSubmissionEffectiveScore(exam, sub)
    const isApproved = eff.isApproved
    const isSyncing = sub.syncStatus === 'syncing'
    const isFailed = sub.syncStatus === 'failed'

    // Instant client-side metrics (<1ms)
    const stats: InstantExamResult =
      sub.instantStats || computeInstantExamResult(exam, sub.answers || {})

    const maxPts = eff.maxPoints || safeNumber(stats.maxPoints || exam.totalPoints, 20) || 20
    const finalScore = eff.totalScore !== undefined && eff.totalScore !== null
      ? eff.totalScore
      : safeScore(sub.aiGrading?.totalScore ?? stats.earnedPoints, maxPts)

    const finalScaled20 = eff.scaledScore20 !== undefined && eff.scaledScore20 !== null
      ? eff.scaledScore20
      : safeScaled20(finalScore, maxPts)

    return (
      <div
        dir="rtl"
        className="fixed inset-0 z-[99999] bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 overflow-y-auto font-sans"
        onClick={onClose}
      >
        <div
          className="bg-white rounded-3xl p-5 sm:p-7 max-w-xl w-full my-auto border-2 border-slate-800 shadow-2xl text-center relative overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Top colored celebration stripe */}
          <div className="absolute top-0 right-0 left-0 h-2 bg-gradient-to-r from-emerald-500 via-teal-500 to-blue-500" />

          <div className="text-5xl sm:text-6xl mb-2 animate-bounce">
            {stats.status === 'excellent' ? '🌟' : '🎉'}
          </div>

          <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight mb-1">
            آزمون با موفقیت ثبت شد!
          </h2>

          <p className="text-xs sm:text-sm text-slate-500 font-medium mb-3">
            دانش‌آموز گرامی: <strong>{student.full_name || 'دانش‌آموز'}</strong> · {exam.title}
          </p>

          {/* Cloud Sync Status Indicator */}
          <div className="mb-4">
            {isSyncing ? (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold bg-blue-50 border border-blue-200 text-blue-700 animate-pulse">
                <span className="w-2 h-2 rounded-full bg-blue-600 animate-ping" />
                <span>☁️ ذخیره پایدار در حافظه دستگاه انجام شد؛ در حال همگام‌سازی ابری...</span>
              </div>
            ) : isFailed ? (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold bg-amber-50 border border-amber-200 text-amber-800">
                <span>💾</span>
                <span>پاسخ‌ها در حافظه دستگاه ذخیره شد و با برقراری شبکه ارسال می‌شود.</span>
              </div>
            ) : (
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 border border-emerald-200 text-emerald-800">
                <span>✓</span>
                <span>همگام‌سازی ابری پاسخ‌ها کامل شد (در انتظار بررسی و تایید آموزگار)</span>
              </div>
            )}
          </div>

          {/* Primary Score Showcase Card */}
          <div className="bg-gradient-to-br from-slate-50 to-blue-50/60 border border-blue-100 rounded-2xl p-4 sm:p-5 mb-4 text-center shadow-xs">
            <div className="text-xs font-bold text-slate-500 mb-1">
              نمره و تراز نهایی آزمون شما
            </div>
            <div className="flex items-center justify-center gap-2 text-3xl sm:text-4xl font-black text-blue-700 tracking-tight my-1">
              <span>{toPersianDigits(finalScaled20)}</span>
              <span className="text-sm sm:text-base font-bold text-slate-400">از ۲۰</span>
            </div>
            <div className="text-xs font-bold text-slate-600 mt-1">
              (معادل {toPersianDigits(finalScore)} از {toPersianDigits(maxPts)} بارم کل)
            </div>

            {/* Performance status pill */}
            <div className="mt-3 flex justify-center">
              <span
                className={`px-3 py-1 rounded-full text-xs font-black shadow-2xs ${
                  finalScaled20 >= 16
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                    : finalScaled20 >= 12
                    ? 'bg-blue-100 text-blue-800 border border-blue-200'
                    : 'bg-amber-100 text-amber-800 border border-amber-200'
                }`}
              >
                {finalScaled20 >= 16 ? 'سطح: عالی و درخشان 🌟' : finalScaled20 >= 12 ? 'سطح: خوب و رضایت‌بخش 👍' : 'سطح: نیازمند تمرین بیشتر 📚'}
              </span>
            </div>
          </div>

          {/* 4-Item Quick Stats Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 text-right">
            <div className="bg-emerald-50/80 border border-emerald-200 rounded-xl p-2.5 flex flex-col items-center justify-center text-center">
              <span className="text-base sm:text-lg mb-0.5">✅</span>
              <div className="text-xs text-slate-500 font-medium">پاسخ‌های درست</div>
              <div className="text-sm sm:text-base font-black text-emerald-700">
                {toPersianDigits(stats.correctCount)} سوال
              </div>
            </div>

            <div className="bg-rose-50/80 border border-rose-200 rounded-xl p-2.5 flex flex-col items-center justify-center text-center">
              <span className="text-base sm:text-lg mb-0.5">❌</span>
              <div className="text-xs text-slate-500 font-medium">پاسخ‌های نادرست</div>
              <div className="text-sm sm:text-base font-black text-rose-700">
                {toPersianDigits(stats.wrongCount)} سوال
              </div>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-2.5 flex flex-col items-center justify-center text-center">
              <span className="text-base sm:text-lg mb-0.5">⚪</span>
              <div className="text-xs text-slate-500 font-medium">بدون پاسخ</div>
              <div className="text-sm sm:text-base font-black text-slate-600">
                {toPersianDigits(stats.unansweredCount)} سوال
              </div>
            </div>

            <div className="bg-indigo-50/80 border border-indigo-200 rounded-xl p-2.5 flex flex-col items-center justify-center text-center">
              <span className="text-base sm:text-lg mb-0.5">📊</span>
              <div className="text-xs text-slate-500 font-medium">درصد موفقیت</div>
              <div className="text-sm sm:text-base font-black text-indigo-700">
                {toPersianDigits(stats.percentage)}٪
              </div>
            </div>
          </div>

          {/* Teacher or AI Personalized Note */}
          <div className="bg-amber-50/70 border border-amber-200 rounded-2xl p-3.5 mb-4 text-right text-xs leading-relaxed text-amber-950">
            <div className="font-bold mb-1 flex items-center gap-1.5 text-amber-900">
              <span>💬</span>
              <span>پیام آموزگار کلاس:</span>
            </div>
            <p>
              {sub.teacherGrading?.teacherNotes ||
                sub.aiGrading?.summary ||
                `آفرین ${student.full_name || 'دانش‌آموز'} عزیزم! تلاشت در این آزمون بسیار ارزشمند است. کارنامه تحصیلی شما به‌روزرسانی شد.`}
            </p>
          </div>

          {/* Detailed Question Review Breakdown */}
          <div className="text-right mb-5">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs sm:text-sm font-black text-slate-800">
                ریز نتایج و سوالات آزمون ({toPersianDigits(exam.questions.length)} سوال):
              </h4>
            </div>
            <div className="max-h-52 overflow-y-auto space-y-2 pr-1">
              {exam.questions.map((q, idx) => {
                const qMax = safeScore(q.points, 10, 2)
                const qScore = safeScore(
                  sub.teacherGrading?.questionScores?.[q.id] ??
                  eff.questionScores?.[q.id] ??
                  stats.questionScores?.[q.id] ?? 0,
                  qMax
                )
                const isFull = qScore >= qMax
                const isZero = qScore === 0
                let fb = (sub.teacherGrading?.questionFeedbacks?.[q.id] ?? stats.questionFeedbacks?.[q.id]) || ''
                if (q.id === 'q2' && fb.includes('با تصمیم آموزگار')) {
                  fb = qScore > 0
                    ? '✅ پاسخ کاملاً درست است (+1 نمره)'
                    : '❌ پاسخ نادرست است. گزینه ۲ (معرفت، سپاس‌داری، پایبند، مشاهده) صحیح می‌باشد.'
                }

                return (
                  <div
                    key={q.id}
                    className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs flex flex-col gap-1 text-right"
                  >
                    <div className="flex items-center justify-between font-bold text-slate-800">
                      <span className="truncate max-w-[80%]">
                        سوال {toPersianDigits(idx + 1)}: {q.question}
                      </span>
                      <span
                        className={`font-black shrink-0 ${
                          isFull ? 'text-emerald-700' : isZero ? 'text-rose-600' : 'text-blue-700'
                        }`}
                      >
                        {toPersianDigits(qScore)} از {toPersianDigits(qMax)}
                      </span>
                    </div>
                    {fb && <div className="text-[11px] text-slate-500 font-medium">{fb}</div>}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Re-edit assignment button if assignment and before deadline */}
          {isAssignment && !isPastDue && !isApproved && (
            <button
              type="button"
              className="w-full py-2.5 px-4 mb-2.5 rounded-xl text-xs sm:text-sm font-bold bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition-colors cursor-pointer"
              onClick={() => {
                setSubmittedResult(null)
                setExistingSubmission(undefined)
              }}
            >
              ✏️ ویرایش و تغییر پاسخ‌های تکلیف
            </button>
          )}

          <button
            type="button"
            className="w-full py-3 px-4 rounded-xl font-black text-xs sm:text-sm bg-blue-600 hover:bg-blue-700 text-white shadow-md shadow-blue-500/20 transition-all cursor-pointer"
            onClick={onClose}
          >
            بستن و مشاهده کارنامه کلاسی 🚀
          </button>
        </div>
      </div>
    )
  }

  if (!currentQ) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.85)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 14,
        backdropFilter: 'blur(6px)',
      }}
    >
      {/* Name watermark: any screenshot of this exam that gets shared shows who took it */}
      {!isAssignment && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100001,
            pointerEvents: 'none',
            overflow: 'hidden',
            display: 'flex',
            flexWrap: 'wrap',
            alignContent: 'flex-start',
            gap: '70px 40px',
            padding: 20,
            transform: 'rotate(-24deg) scale(1.4)',
            opacity: 0.09,
            color: '#0F172A',
            fontSize: 15,
            fontWeight: 900,
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          {Array.from({ length: 60 }).map((_, i) => (
            <span key={i}>{watermarkText}</span>
          ))}
        </div>
      )}

      {/* Live warning shown to the student when a suspicious action is recorded */}
      {integrityWarning && (
        <div
          role="alert"
          dir="rtl"
          style={{
            position: 'fixed',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100002,
            background: '#B91C1C',
            color: '#FFFFFF',
            padding: '10px 16px',
            borderRadius: 14,
            fontSize: 12.5,
            fontWeight: 900,
            boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
            maxWidth: '92vw',
            textAlign: 'center',
          }}
        >
          {integrityWarning}
        </div>
      )}

      <div
        className={isAssignment ? undefined : 'exam-secure'}
        onDragStart={(e) => e.preventDefault()}
        style={{
          userSelect: isAssignment ? undefined : 'none',
          WebkitUserSelect: isAssignment ? undefined : 'none',
          WebkitTouchCallout: isAssignment ? undefined : 'none',
          background: '#FFFFFF',
          borderRadius: 24,
          maxWidth: 620,
          width: '100%',
          maxHeight: '94vh',
          display: 'flex',
          flexDirection: 'column',
          border: '2px solid var(--black)',
          boxShadow: '0 24px 48px rgba(0,0,0,0.3)',
          overflow: 'hidden',
        }}
      >
        {!isAssignment && (
          <div
            dir="rtl"
            style={{
              background: '#FEF3C7',
              color: '#92400E',
              fontSize: 11.5,
              fontWeight: 800,
              padding: '6px 14px',
              borderBottom: '1px solid #FDE68A',
              textAlign: 'center',
            }}
          >
            🔒 این آزمون تحت نظارت است: خروج از صفحه، اسکرین‌شات با کیبورد و کپی سؤال برای آموزگار ثبت می‌شود.
          </div>
        )}
        {/* Top Header Bar */}
        <div
          style={{
            padding: '14px 18px',
            background: '#F8FAFC',
            borderBottom: '2px solid #E2E8F0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                background: '#DBEAFE',
                color: '#1E40AF',
                padding: '2px 8px',
                borderRadius: 999,
              }}
            >
              {exam.subject}
            </span>
            <h3 style={{ fontSize: 15, fontWeight: 900, margin: '4px 0 0 0', color: '#0F172A' }}>
              {sanitizeExamTitle(exam.title, exam.subject)}
            </h3>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Timer or Untimed Status Pill */}
            {isAssignment ? (
              <div
                style={{
                  background: '#ECFDF5',
                  color: '#065F46',
                  border: '1.5px solid #A7F3D0',
                  padding: '5px 12px',
                  borderRadius: 999,
                  fontSize: 12.5,
                  fontWeight: 900,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>🌱</span>
                <span>تکلیف تعاملی بدون زمان {exam.dueDate ? `(مهلت: ${new Date(exam.dueDate).toLocaleDateString('fa-IR')})` : ''}</span>
              </div>
            ) : (
              <div
                style={{
                  background: timeLeftSeconds < 300 ? '#FEE2E2' : '#DCFCE7',
                  color: timeLeftSeconds < 300 ? '#DC2626' : '#166534',
                  border: `1.5px solid ${timeLeftSeconds < 300 ? '#F87171' : '#86EFAC'}`,
                  padding: '4px 10px',
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: 900,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span>⏱️</span>
                <span>{formattedTime}</span>
              </div>
            )}


            <button
              type="button"
              onClick={() => {
                setExitSaveStatus('idle')
                setExitErrorMessage(null)
                setShowExitConfirmModal(true)
              }}
              style={{
                background: '#F1F5F9',
                border: '1.5px solid #CBD5E1',
                borderRadius: 10,
                padding: '6px 12px',
                fontSize: 12.5,
                fontWeight: 800,
                color: '#334155',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
              }}
              title="ذخیره موقت پاسخ‌ها و خروج به کلاس بدون نهایی‌سازی"
            >
              <span>✕</span>
              <span>خروج موقت</span>
            </button>
          </div>
        </div>

        {/* Draft Restored Banner */}
        {draftRestored && (
          <div
            style={{
              background: '#FEF3C7',
              color: '#92400E',
              borderBottom: '1px solid #FDE68A',
              padding: '8px 16px',
              fontSize: 12,
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>⚡ پاسخ‌های پیشین شما بازیابی شدند. زمان باقی‌مانده آزمون بر اساس زمان واقعی سپری‌شده در حال محاسبه است.</span>
            <button
              type="button"
              onClick={() => setDraftRestored(false)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 900, color: '#92400E' }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Progress & Quick Navigation Dots */}
        <div style={{ padding: '10px 18px', background: '#FFFFFF', borderBottom: '1px solid #F1F5F9' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, fontWeight: 800, color: '#64748B', marginBottom: 6 }}>
            <span>سوال {currentQIndex + 1} از {exam.questions.length}</span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                color: saveIndicator === 'saving' ? '#D97706' : '#059669',
                fontSize: 11.5,
                fontWeight: 800,
                background: saveIndicator === 'saving' ? '#FEF3C7' : '#ECFDF5',
                padding: '2px 8px',
                borderRadius: 6,
                border: `1px solid ${saveIndicator === 'saving' ? '#FDE68A' : '#A7F3D0'}`,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: saveIndicator === 'saving' ? '#F59E0B' : '#10B981',
                }}
              />
              {saveIndicator === 'saving' ? 'در حال ذخیره‌سازی پیش‌نویس...' : '✓ پاسخ‌ها ذخیره شد'}
            </span>
            <span>{answeredCount} از {exam.questions.length} پاسخ داده شده</span>
          </div>

          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
            {exam.questions.map((q, idx) => {
              const a = answers[q.id]
              const hasAns =
                a &&
                (a.selectedOption !== undefined ||
                  (a.textAnswer && a.textAnswer.trim().length > 0) ||
                  a.imageAttachment)
              const isCurrent = idx === currentQIndex

              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => handleQuestionChange(idx)}
                  style={{
                    minWidth: 28,
                    height: 28,
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 800,
                    border: isCurrent ? '2px solid #2563EB' : '1px solid #CBD5E1',
                    background: isCurrent ? '#EFF6FF' : hasAns ? '#DCFCE7' : '#FFFFFF',
                    color: isCurrent ? '#1D4ED8' : hasAns ? '#166534' : '#64748B',
                    cursor: 'pointer',
                  }}
                >
                  {idx + 1}
                </button>
              )
            })}
          </div>
        </div>

        {/* Slide Question Body */}
        <div style={{ padding: '20px 18px', flex: 1, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                padding: '2px 8px',
                borderRadius: 6,
                background:
                  currentQ.type === 'multiple_choice'
                    ? '#FEF08A'
                    : currentQ.type === 'fill_in_the_blank'
                    ? '#BAE6FD'
                    : currentQ.type === 'image'
                    ? '#FED7AA'
                    : '#BBF7D0',
                color: '#1E293B',
              }}
            >
              {currentQ.type === 'multiple_choice'
                ? 'چهارگزینه‌ای'
                : currentQ.type === 'fill_in_the_blank'
                ? 'جای خالی'
                : currentQ.type === 'image'
                ? 'تصویری / ارسال عکس'
                : 'تشریحی'}
            </span>
            <span style={{ fontSize: 12, color: '#64748B', fontWeight: 800 }}>
              بارم نمره: {currentQ.points}
            </span>
          </div>

          <div style={{ fontSize: 16, fontWeight: 800, color: '#0F172A', lineHeight: 1.8, margin: '0 0 16px 0' }}>
            <MathRenderer text={currentQ.question} />
          </div>

          {currentQ.imageUrl && (
            <div style={{ marginBottom: 16 }}>
              <img
                src={currentQ.imageUrl}
                alt="تصویر سوال"
                style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 12, border: '1px solid #CBD5E1' }}
              />
            </div>
          )}

          {/* INPUT 1: MULTIPLE CHOICE */}
          {currentQ.type === 'multiple_choice' && currentQ.options && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {currentQ.options.map((opt, optIdx) => {
                const isSelected = currentAnswer.selectedOption === optIdx
                return (
                  <button
                    key={optIdx}
                    type="button"
                    onClick={() => handleSelectOption(optIdx, opt)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 16px',
                      borderRadius: 14,
                      fontSize: 14,
                      fontWeight: isSelected ? 800 : 600,
                      textAlign: 'right',
                      cursor: 'pointer',
                      border: isSelected ? '2px solid #2563EB' : '1.5px solid #CBD5E1',
                      background: isSelected ? '#EFF6FF' : '#FFFFFF',
                      color: isSelected ? '#1E40AF' : '#1E293B',
                      boxShadow: isSelected ? '0 4px 12px rgba(37, 99, 235, 0.12)' : 'none',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 999,
                        border: isSelected ? '6px solid #2563EB' : '2px solid #94A3B8',
                        background: '#FFFFFF',
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1 }}>
                      <MathRenderer text={opt} />
                    </span>
                  </button>
                )
              })}
            </div>
          )}


          {/* INPUT 2: FILL IN THE BLANK */}
          {currentQ.type === 'fill_in_the_blank' && (
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 800, color: '#334155', marginBottom: 8 }}>
                عبارت یا کلمه جای خالی را بنویسید:
              </label>
              <input
                type="text"
                value={currentAnswer.textAnswer || ''}
                onChange={(e) => setAnswerForCurrent('textAnswer', e.target.value)}
                placeholder="پاسخ را اینجا تایپ کنید..."
                style={{
                  width: '100%',
                  padding: 14,
                  borderRadius: 12,
                  border: '2px solid var(--black)',
                  fontSize: 15,
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}

          {/* INPUT 3: DESCRIPTIVE TEXT */}
          {currentQ.type === 'descriptive' && (
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 800, color: '#334155', marginBottom: 8 }}>
                پاسخ تشریحی خود را بنویسید:
              </label>
              <textarea
                value={currentAnswer.textAnswer || ''}
                onChange={(e) => setAnswerForCurrent('textAnswer', e.target.value)}
                placeholder="توضیحات و پاسخ کامل خود را بنویسید..."
                style={{
                  width: '100%',
                  padding: 14,
                  borderRadius: 12,
                  border: '2px solid var(--black)',
                  fontSize: 14,
                  minHeight: 120,
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}

          {/* INPUT 4: IMAGE UPLOAD (PHOTO OF HANDWRITTEN ANSWER) */}
          {currentQ.type === 'image' && (
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 800, color: '#334155', marginBottom: 8 }}>
                پاسخ خود را روی برگه نوشته و عکس آن را ارسال کنید (یا توضیح متنی بنویسید):
              </label>

              <div style={{ marginBottom: 12 }}>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 16px',
                    borderRadius: 12,
                    border: '2px solid var(--black)',
                    background: '#F1F5F9',
                    fontSize: 13,
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  📷 انتخاب یا گرفتن عکس از برگه پاسخ
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
                </label>
              </div>

              {currentAnswer.imageAttachment && (
                <div style={{ position: 'relative', display: 'inline-block', marginBottom: 12 }}>
                  <img
                    src={currentAnswer.imageAttachment}
                    alt="پاسخ ارسالی"
                    style={{ maxHeight: 180, borderRadius: 12, border: '2px solid #10B981' }}
                  />
                  <button
                    type="button"
                    onClick={() => setAnswerForCurrent('imageAttachment', undefined)}
                    style={{
                      position: 'absolute',
                      top: 6,
                      left: 6,
                      background: '#EF4444',
                      color: '#FFFFFF',
                      border: 'none',
                      borderRadius: 999,
                      width: 24,
                      height: 24,
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}

              <textarea
                value={currentAnswer.textAnswer || ''}
                onChange={(e) => setAnswerForCurrent('textAnswer', e.target.value)}
                placeholder="توضیحات تکمیلی یا متن پاسخ (اختیاری)..."
                style={{
                  width: '100%',
                  padding: 10,
                  borderRadius: 10,
                  border: '1.5px solid #CBD5E1',
                  fontSize: 13,
                  boxSizing: 'border-box',
                  minHeight: 70,
                }}
              />
            </div>
          )}
        </div>

        {/* Bottom Slide Navigation Bar */}
        <div
          style={{
            padding: '14px 18px',
            background: '#F8FAFC',
            borderTop: '2px solid #E2E8F0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <button
            type="button"
            className="btn secondary"
            disabled={currentQIndex === 0}
            onClick={() => handleQuestionChange(Math.max(0, currentQIndex - 1))}
            style={{ padding: '10px 16px', fontSize: 13 }}
          >
            ➔ سوال قبلی
          </button>

          {currentQIndex < exam.questions.length - 1 ? (
            <button
              type="button"
              className="btn"
              onClick={() => handleQuestionChange(Math.min(exam.questions.length - 1, currentQIndex + 1))}
              style={{ padding: '10px 20px', fontSize: 13 }}
            >
              سوال بعدی ⬅️
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => setShowConfirmModal(true)}
              style={{ padding: '10px 20px', fontSize: 14, background: '#10B981' }}
            >
              🏁 اتمام آزمون و ارسال پاسخ‌ها
            </button>
          )}
        </div>
      </div>

      {/* CONFIRMATION SUBMIT MODAL */}
      {showConfirmModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            zIndex: 100000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setShowConfirmModal(false)}
        >
          <div
            style={{
              background: '#FFFFFF',
              borderRadius: 20,
              padding: 24,
              maxWidth: 440,
              width: '100%',
              border: '2px solid var(--black)',
              textAlign: 'center',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 44, marginBottom: 8 }}>📝</div>
            <h3 style={{ fontSize: 18, fontWeight: 900, color: '#0F172A', margin: '0 0 8px 0' }}>
              آیا از اتمام و ارسال آزمون اطمینان دارید؟
            </h3>
            <p style={{ fontSize: 13.5, color: '#64748B', margin: '0 0 16px 0', lineHeight: 1.5 }}>
              شما به <strong>{answeredCount}</strong> از <strong>{exam.questions.length}</strong> سوال پاسخ داده‌اید.
              پس از ارسال، پاسخ‌نامه شما در کارنامه ثبت خواهد شد.
            </p>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setShowConfirmModal(false)}
                style={{ flex: 1 }}
              >
                بازگشت و بازبینی
              </button>
              <button
                type="button"
                className="btn"
                disabled={submitting}
                onClick={() => doSubmit()}
                style={{ flex: 1, background: '#10B981' }}
              >
                {submitting ? 'در حال ثبت پاسخ‌ها...' : 'تایید و ثبت نهایی 🚀'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* IN-APP TEMPORARY EXIT MODAL */}
      {showExitConfirmModal && (
        <div
          dir="rtl"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.75)',
            backdropFilter: 'blur(4px)',
            zIndex: 100000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => {
            if (exitSaveStatus !== 'saving') setShowExitConfirmModal(false)
          }}
        >
          <div
            style={{
              background: '#FFFFFF',
              borderRadius: 24,
              padding: 24,
              maxWidth: 440,
              width: '100%',
              border: '2px solid #0F172A',
              textAlign: 'center',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 44, marginBottom: 8 }}>💾</div>
            <h3 style={{ fontSize: 18, fontWeight: 900, color: '#0F172A', margin: '0 0 8px 0' }}>
              ذخیره موقت و خروج از آزمون
            </h3>
            <p style={{ fontSize: 13, color: '#475569', margin: '0 0 14px 0', lineHeight: 1.6 }}>
              آیا می‌خواهید موقتاً از محیط آزمون خارج شوید؟
              <br />
              تمام پاسخ‌های ثبت‌شده شما تا این لحظه (<strong>{toPersianDigits(answeredCount)}</strong> از <strong>{toPersianDigits(exam.questions.length)}</strong> سوال) به صورت کامل ذخیره می‌شود و وضعیت آزمون <strong>در حال انجام</strong> باقی می‌ماند تا هر زمان خواستید بتوانید آن را ادامه دهید.
            </p>

            {exitErrorMessage && (
              <div
                style={{
                  background: '#FEE2E2',
                  border: '1px solid #FCA5A5',
                  color: '#991B1B',
                  borderRadius: 12,
                  padding: '8px 12px',
                  fontSize: 12,
                  fontWeight: 800,
                  marginBottom: 14,
                }}
              >
                ⚠️ {exitErrorMessage}
              </div>
            )}

            {exitSaveStatus === 'saved' && (
              <div
                style={{
                  background: '#DCFCE7',
                  border: '1px solid #86EFAC',
                  color: '#166534',
                  borderRadius: 12,
                  padding: '8px 12px',
                  fontSize: 12,
                  fontWeight: 800,
                  marginBottom: 14,
                }}
              >
                ✅ پاسخ‌ها با موفقیت ذخیره شدند. در حال انتقال به کلاس...
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button
                type="button"
                disabled={exitSaveStatus === 'saving'}
                onClick={() => setShowExitConfirmModal(false)}
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  borderRadius: 12,
                  fontSize: 13,
                  fontWeight: 800,
                  background: '#F1F5F9',
                  border: '1px solid #CBD5E1',
                  color: '#334155',
                  cursor: 'pointer',
                }}
              >
                ↩️ ادامه آزمون
              </button>
              <button
                type="button"
                disabled={exitSaveStatus === 'saving'}
                onClick={handleTemporaryExit}
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  borderRadius: 12,
                  fontSize: 13,
                  fontWeight: 800,
                  background: exitSaveStatus === 'saved' ? '#059669' : '#2563EB',
                  color: '#FFFFFF',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {exitSaveStatus === 'saving'
                  ? 'در حال ذخیره‌سازی...'
                  : exitSaveStatus === 'saved'
                  ? 'ذخیره شد ✓'
                  : '💾 ذخیره و خروج موقت'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Makes sure the exam questions are actually available before showing the exam.
 * Questions of a scheduled exam are hidden by the server until the start time, and a phone may still
 * hold the empty pre-start copy at 09:00 — previously that rendered a blank screen. Now the questions
 * are re-fetched automatically (every 3s, up to ~1 minute) with a clear message for the student.
 */
export default function StudentExamTaker(props: {
  exam: Exam
  student: any
  initialSubmission?: StudentExamSubmission
  onClose: () => void
  onFinished?: () => void
}) {
  const { exam, onClose } = props
  const hasQuestions = Array.isArray(exam?.questions) && exam.questions.length > 0
  const [resolvedExam, setResolvedExam] = useState<Exam | null>(hasQuestions ? exam : null)
  const [failed, setFailed] = useState(false)
  const [attemptKey, setAttemptKey] = useState(0)

  const classification = classifyExamForStudent(exam, getServerNowMs())
  const notStartedYet = !classification.isPublished || !classification.isStarted

  useEffect(() => {
    if (resolvedExam || notStartedYet) return
    let cancelled = false
    let tries = 0
    setFailed(false)
    const attempt = async () => {
      if (cancelled) return
      tries += 1
      try {
        const res = await fetchPublishedExamsWithDiagnostics(true, true, { requestSource: 'exam_taker_questions' })
        const fresh = res.exams.find((e) => e.id === exam.id)
        if (!cancelled && fresh && Array.isArray(fresh.questions) && fresh.questions.length > 0) {
          setResolvedExam({ ...exam, ...fresh })
          return
        }
      } catch {}
      if (cancelled) return
      if (tries >= 20) {
        setFailed(true)
        return
      }
      setTimeout(attempt, 3000)
    }
    void attempt()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exam.id, attemptKey, notStartedYet])

  // Re-check every second while locked so the exam opens by itself at the start time
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!notStartedYet) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [notStartedYet])

  if (resolvedExam || notStartedYet) {
    return (
      <StudentExamTakerInner
        key={notStartedYet ? 'locked' : 'open'}
        {...props}
        exam={resolvedExam || exam}
      />
    )
  }

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-[99999] bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-4 font-sans"
    >
      <div className="bg-white border-2 border-blue-300 rounded-2xl p-6 max-w-md w-full text-center shadow-xl space-y-3">
        <div className="text-4xl">{failed ? '⚠️' : '⏳'}</div>
        <h3 className="text-base font-black text-slate-900">
          {failed ? 'سؤالات آزمون دریافت نشد' : 'در حال دریافت سؤالات آزمون...'}
        </h3>
        <p className="text-xs text-slate-600 leading-relaxed">
          {failed
            ? 'اتصال اینترنت را بررسی کنید و دوباره تلاش کنید. زمان آزمون شما هنوز شروع نشده است.'
            : 'چند لحظه صبر کنید؛ سؤالات به محض دریافت نمایش داده می‌شوند. زمان آزمون شما هنوز شروع نشده است.'}
        </p>
        {failed && (
          <button
            type="button"
            onClick={() => setAttemptKey((k) => k + 1)}
            className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black cursor-pointer"
          >
            🔄 تلاش دوباره
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="w-full py-2.5 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-black cursor-pointer"
        >
          بازگشت به داشبورد
        </button>
      </div>
    </div>
  )
}

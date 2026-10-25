import { useState, useRef, useEffect, useMemo } from 'react'
import { toPersianDigits } from '../utils/persianNumbers'
import { sortByLastName } from '../utils/persianSort'

interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  time: string
}

export default function TeacherAiAssistant({
  students,
  statsRows,
  homeworkPosts,
  grades,
  allAttendance,
  weakSubjects,
}: {
  students: any[]
  statsRows: any[]
  homeworkPosts: any[]
  grades: any[]
  allAttendance: any[]
  weakSubjects?: any[]
}) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: `سلام همکار گرامی! 🌸
من دستیار هوشمند تحلیل کلاس و پداگوژی شما هستم. به تمامی آمار و داده‌های زنده کلاس، وضعیت ارسال تکالیف، نمرات دانش‌آموزان (در مقیاس ۲۰ نمره) و حضور و غیاب دسترسی دارم.

می‌توانید درباره هر دانش‌آموز بپرسید (مثلاً: «وضعیت علی چطوره؟») یا درباره وضعیت کلی کلاس، تکالیف ارسال‌نشده یا راهکارهای جبرانی گفتگو کنیم.`,
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedStudentForQuery, setSelectedStudentForQuery] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const sortedStudents = useMemo(() => sortByLastName(students, 'full_name'), [students])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Build the rich live context payload
  function buildClassroomContext() {
    const studentSummaries = statsRows.map((sr) => {
      const studentGrades = grades.filter((g) => g.student_id === sr.id)
      const subjectAverages: Record<string, { total: number; count: number }> = {}
      studentGrades.forEach((g) => {
        const sub = g.subject || 'عمومی'
        const normalized = g.max_score > 0 ? (g.score / g.max_score) * 20 : g.score
        if (!subjectAverages[sub]) subjectAverages[sub] = { total: 0, count: 0 }
        subjectAverages[sub].total += normalized
        subjectAverages[sub].count += 1
      })

      const subjectsBreakdown = Object.entries(subjectAverages).map(([sub, data]) => ({
        subject: sub,
        avgOutOf20: Math.round((data.total / data.count) * 10) / 10,
      }))

      const studentAbsents = allAttendance.filter(
        (a) => a.student_id === sr.id && a.status === 'absent'
      ).length

      const missingHwCount = Math.max(0, sr.totalHomework - sr.submitted)
      const hwSubmissionRate =
        sr.totalHomework > 0 ? Math.round((sr.submitted / sr.totalHomework) * 100) : 100

      return {
        id: sr.id,
        fullName: sr.name,
        avgGradeOutOf20: sr.avg !== null ? Math.round(sr.avg * 10) / 10 : 'بدون نمره',
        submittedHomeworkCount: sr.submitted,
        totalHomeworkCount: sr.totalHomework,
        missingHomeworkCount: missingHwCount,
        hwSubmissionRatePercent: hwSubmissionRate,
        presentDays: sr.present,
        lateDays: sr.late,
        absentDays: studentAbsents,
        streak: sr.streak,
        subjectScores: subjectsBreakdown,
      }
    })

    return {
      classSummary: {
        totalStudentsCount: students.length,
        totalHomeworksAssigned: homeworkPosts.length,
        totalGradesRecorded: grades.length,
        weakSubjectsIdentified: weakSubjects || [],
      },
      students: studentSummaries,
    }
  }

  async function handleSend(userText: string) {
    const trimmed = userText.trim()
    if (!trimmed || loading) return

    const userMsg: Message = {
      id: String(Date.now()),
      role: 'user',
      text: trimmed,
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
    }

    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const context = buildClassroomContext()
      const teacherPass = typeof window !== 'undefined' ? sessionStorage.getItem('teacherPassword') || '' : ''
      const res = await fetch('/api/ai/classroom-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(teacherPass ? { 'x-teacher-password': teacherPass } : {}),
        },
        body: JSON.stringify({
          message: trimmed,
          classroomContext: context,
          teacherPassword: teacherPass,
        }),
      })

      const data = await res.json()
      if (!data.success) {
        throw new Error(data.error || 'خطا در ارتباط با سرور')
      }

      const assistantMsg: Message = {
        id: String(Date.now() + 1),
        role: 'assistant',
        text: data.reply,
        time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      }
      setMessages((prev) => [...prev, assistantMsg])
    } catch (err: any) {
      const errorMsg: Message = {
        id: String(Date.now() + 1),
        role: 'assistant',
        text: `⚠️ متأسفانه در دریافت پاسخ مشکلی پیش آمد: ${err?.message || 'خطای اتصال'}. لطفاً مجدداً تلاش فرمایید.`,
        time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      }
      setMessages((prev) => [...prev, errorMsg])
    } finally {
      setLoading(false)
    }
  }

  const quickPrompts = [
    'وضعیت کلی تکالیف و نمرات کلاس چطوره؟',
    'کدوم دانش‌آموزها بیشترین تکلیف ارسال‌نشده رو دارند؟',
    'کلاس در چه مباحث یا دروسی ضعف بیشتری داره؟',
    'دانش‌آموزان با انگیزه و برتر کلاس کیا هستند؟',
    'پیشنهاد تکالیف جبرانی برای بچه‌های نیازمند تلاش بده.',
  ]

  return (
    <div className="w-full max-w-full overflow-hidden box-border bg-white rounded-2xl border border-slate-200/90 shadow-2xs flex flex-col h-[560px] sm:h-[640px] max-h-[80vh]">
      {/* Header */}
      <div className="p-3 sm:p-4 bg-gradient-to-r from-slate-900 via-indigo-950 to-indigo-900 text-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 w-full max-w-full box-border shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-2xl shrink-0">🤖</span>
          <div className="min-w-0">
            <h3 className="text-xs sm:text-base font-black text-white truncate">
              دستیار هوشمند تحلیل کلاس و دانش‌آموزان
            </h3>
            <p className="text-[10px] sm:text-[11px] text-indigo-200 truncate">
              تحلیل مستند داده‌های تکالیف، نمرات (مقیاس ۲۰) و پایش یادگیری
            </p>
          </div>
        </div>

        {/* Quick student picker */}
        <div className="w-full sm:w-auto shrink-0">
          <select
            value={selectedStudentForQuery}
            onChange={(e) => {
              const val = e.target.value
              setSelectedStudentForQuery(val)
              if (val) {
                handleSend(`وضعیت درسی، تکالیف و نمرات «${val}» چطوره و چه تحلیلی داری؟`)
              }
            }}
            className="w-full sm:w-auto px-3 py-1.5 rounded-lg text-xs font-bold bg-indigo-900 text-white border border-indigo-700 focus:outline-hidden cursor-pointer"
          >
            <option value="">👤 بررسی وضعیت یک دانش‌آموز...</option>
            {sortedStudents.map((s) => (
              <option key={s.id} value={s.full_name}>
                {s.full_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Quick Prompts Bar */}
      <div className="p-2 sm:p-2.5 bg-slate-100 border-b border-slate-200 flex gap-1.5 sm:gap-2 overflow-x-auto w-full max-w-full box-border shrink-0">
        {quickPrompts.map((qp, idx) => (
          <button
            key={idx}
            type="button"
            className="px-2.5 py-1 rounded-full text-xs font-bold bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 shadow-2xs cursor-pointer"
            onClick={() => handleSend(qp)}
          >
            💡 {qp}
          </button>
        ))}
      </div>

      {/* Messages stream */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 flex flex-col gap-3 bg-slate-50 w-full box-border">
        {messages.map((m) => {
          const isUser = m.role === 'user'
          return (
            <div
              key={m.id}
              className={`flex flex-col max-w-[88%] sm:max-w-[80%] ${
                isUser ? 'self-end items-end' : 'self-start items-start'
              }`}
            >
              <div
                className={`p-3 sm:p-3.5 rounded-2xl text-xs sm:text-sm leading-relaxed shadow-2xs whitespace-pre-wrap break-words ${
                  isUser
                    ? 'bg-blue-600 text-white rounded-tr-xs'
                    : 'bg-white text-slate-900 border border-slate-200 rounded-tl-xs'
                }`}
              >
                {toPersianDigits(m.text)}
              </div>
              <span className="text-[10px] text-slate-400 mt-1 px-1">
                {toPersianDigits(m.time)}
              </span>
            </div>
          )
        })}

        {loading && (
          <div className="self-start p-3 rounded-2xl bg-white border border-slate-200 text-xs text-indigo-600 font-bold flex items-center gap-2 shadow-2xs">
            <span className="w-3.5 h-3.5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            <span>در حال تحلیل داده‌های کلاس و تنظیم راهکار آموزشی...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleSend(input)
        }}
        className="p-2 sm:p-3 bg-white border-t border-slate-200 flex items-center gap-2 w-full max-w-full box-border shrink-0"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="سوالی درباره دانش‌آموزان یا وضعیت کلاس بپرسید..."
          disabled={loading}
          className="flex-1 min-w-0 px-3 py-2 text-xs sm:text-sm rounded-xl border border-slate-300 focus:outline-hidden focus:border-blue-500 bg-slate-50 focus:bg-white transition-colors box-border"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="btn shrink-0 text-xs sm:text-sm py-2 px-3 sm:px-4"
        >
          ارسال
        </button>
      </form>
    </div>
  )
}

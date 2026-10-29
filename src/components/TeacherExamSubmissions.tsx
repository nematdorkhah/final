import { useState, useEffect } from 'react'
import { Exam, StudentExamSubmission } from '../types/examTypes'
import {
  getExamSubmissions,
  fetchExamSubmissions,
  approveExamSubmission,
  releaseExamResultsForAll,
} from '../utils/examStore'
import { CLASS_STUDENTS_ROSTER } from '../classStudents'
import { sortByLastName } from '../utils/persianSort'

interface TeacherExamSubmissionsProps {
  exam: Exam
  teacherPassword?: string
  onClose?: () => void
  onSubmissionsUpdated?: () => void
}

export default function TeacherExamSubmissions({
  exam,
  teacherPassword = '',
  onClose,
  onSubmissionsUpdated,
}: TeacherExamSubmissionsProps) {
  const [currentExam, setCurrentExam] = useState<Exam>(exam)
  const [submissions, setSubmissions] = useState<StudentExamSubmission[]>(() =>
    getExamSubmissions(exam.id)
  )
  const [selectedSubForGrading, setSelectedSubForGrading] = useState<StudentExamSubmission | null>(null)
  const [teacherScoresDraft, setTeacherScoresDraft] = useState<Record<string, number>>({})
  const [teacherNoteDraft, setTeacherNoteDraft] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isReleasing, setIsReleasing] = useState(false)
  const [feedbackMsg, setFeedbackMsg] = useState('')
  const [activeTab, setActiveTab] = useState<'submitted' | 'missing'>('submitted')

  useEffect(() => {
    setCurrentExam(exam)
    loadSubmissions()
  }, [exam.id])

  async function loadSubmissions() {
    setIsRefreshing(true)
    try {
      const fresh = await fetchExamSubmissions(exam.id)
      setSubmissions(fresh)
      if (onSubmissionsUpdated) onSubmissionsUpdated()
    } catch (err) {
      console.warn('Failed to fetch submissions:', err)
      setSubmissions(getExamSubmissions(exam.id))
    } finally {
      setIsRefreshing(false)
    }
  }

  async function handleToggleRelease() {
    const isCurrentlyReleased = !!(currentExam.resultsPublished || currentExam.isResultsReleased)
    const promptMsg = isCurrentlyReleased
      ? 'آیا مایلید کارنامه و کلید پاسخ‌ها را مجدداً برای دانش‌آموزان قفل و مخفی کنید؟'
      : 'آیا مایلید کارنامه، نمرات و کلید سوالات برای تمامی دانش‌آموزان تایید و منتشر شود؟\nدانش‌آموزان بلافاصله کارنامه و نمرات خود را مشاهده خواهند کرد.'

    if (!window.confirm(promptMsg)) return

    setIsReleasing(true)
    setFeedbackMsg('')
    try {
      await releaseExamResultsForAll(currentExam.id, teacherPassword, isCurrentlyReleased)
      const nextState = !isCurrentlyReleased
      setCurrentExam((prev) => ({
        ...prev,
        resultsPublished: nextState,
        isResultsReleased: nextState,
        results_published: nextState,
      }))
      await loadSubmissions()
      setFeedbackMsg(
        nextState
          ? '🎉 کارنامه، نمرات و کلید سوالات با موفقیت تایید و برای تمامی دانش‌آموزان منتشر شد.'
          : '🔒 انتشار کارنامه لغو شد و دسترسی دانش‌آموزان مجدداً در حالت انتظار قرار گرفت.'
      )
    } catch (err: any) {
      alert('خطا در تغییر وضعیت انتشار کارنامه: ' + (err.message || 'خطای شبکه'))
    } finally {
      setIsReleasing(false)
    }
  }

  function startGrading(sub: StudentExamSubmission) {
    setSelectedSubForGrading(sub)
    const initialScores: Record<string, number> = {}
    for (const q of currentExam.questions) {
      initialScores[q.id] =
        sub.teacherGrading?.questionScores?.[q.id] ??
        sub.aiGrading?.questionScores?.[q.id] ??
        0
    }
    setTeacherScoresDraft(initialScores)
    setTeacherNoteDraft(sub.teacherGrading?.teacherNotes || sub.aiGrading?.summary || '')
    setFeedbackMsg('')
  }

  async function handleSaveGrading() {
    if (!selectedSubForGrading) return
    try {
      await approveExamSubmission({
        submissionId: selectedSubForGrading.id,
        exam: currentExam,
        studentId: selectedSubForGrading.studentId,
        approvedScores: teacherScoresDraft,
        teacherNotes: teacherNoteDraft,
        teacherPassword,
      })
      setFeedbackMsg(`✓ نمره و یادداشت برای ${selectedSubForGrading.studentName} با موفقیت ثبت شد.`)
      await loadSubmissions()
      const updatedList = getExamSubmissions(currentExam.id)
      const reloaded = updatedList.find((s) => s.id === selectedSubForGrading.id)
      if (reloaded) setSelectedSubForGrading(reloaded)
    } catch (err: any) {
      alert('خطا در ثبت نمره: ' + err.message)
    }
  }

  const isReleased = !!(currentExam.resultsPublished || currentExam.isResultsReleased)
  const totalStudents = CLASS_STUDENTS_ROSTER.length || 40
  const submittedStudentIds = new Set(submissions.map((s) => String(s.studentId)))
  const missingStudents = CLASS_STUDENTS_ROSTER.filter(
    (st) => !submittedStudentIds.has(st.nationalCode) && !submittedStudentIds.has(String(st.row))
  )

  return (
    <div className="w-full bg-white rounded-2xl border-2 border-slate-900 p-4 sm:p-6 shadow-sm">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-3 border-b border-slate-200">
        <div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-bold text-slate-500 hover:text-slate-800 mb-1 flex items-center gap-1 cursor-pointer"
            >
              ➔ بازگشت
            </button>
          )}
          <h2 className="text-base sm:text-lg font-black text-slate-900 m-0">
            مدیریت و بررسی پاسخ‌ها: {currentExam.title}
          </h2>
          <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-2">
            <span>درس: <strong>{currentExam.subject}</strong></span>
            <span>•</span>
            <span>مجموع بارم: <strong>{currentExam.totalPoints} نمره</strong></span>
            <span>•</span>
            <span>تعداد سوالات: <strong>{currentExam.questions.length}</strong></span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadSubmissions}
            disabled={isRefreshing}
            className="px-3 py-1.5 rounded-lg border-2 border-slate-900 bg-slate-100 hover:bg-slate-200 text-xs font-bold transition-all cursor-pointer"
          >
            {isRefreshing ? '⏳ در حال دریافت...' : '🔄 بروزرسانی پاسخ‌ها از سرور'}
          </button>
        </div>
      </div>

      {/* Release & Summary Card */}
      <div
        className={`rounded-xl border-2 p-4 mb-4 transition-all ${
          isReleased ? 'bg-emerald-50 border-emerald-500' : 'bg-amber-50 border-amber-500'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex-1 min-w-[240px]">
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`text-xs font-extrabold px-2.5 py-1 rounded-full ${
                  isReleased ? 'bg-emerald-200 text-emerald-900' : 'bg-amber-200 text-amber-900'
                }`}
              >
                {isReleased ? '🟢 کارنامه منتشر شده است' : '🔒 کارنامه قفل و مخفی است'}
              </span>
              <span className="text-xs font-bold text-slate-800">
                پاسخ‌های دریافتی: <strong>{submissions.length}</strong> از <strong>{totalStudents}</strong> دانش‌آموز ({Math.round((submissions.length / totalStudents) * 100)}%)
              </span>
            </div>
            <p className="text-xs text-slate-600 m-0 leading-relaxed">
              {isReleased
                ? 'دانش‌آموزان به نمره، کارنامه و کلید سوالات دسترسی دارند.'
                : 'پاسخ‌ها در انتظار تایید آموزگار هستند و دانش‌آموزان تا پیش از انتشار به کارنامه دسترسی ندارند.'}
            </p>
          </div>

          <div>
            <button
              type="button"
              onClick={handleToggleRelease}
              disabled={isReleasing}
              className={`px-4 py-2 rounded-xl border-2 border-slate-900 text-xs sm:text-sm font-black text-white transition-all cursor-pointer shadow-sm ${
                isReleased
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              }`}
            >
              {isReleasing
                ? 'در حال اعمال...'
                : isReleased
                ? '🔒 لغو انتشار و قفل کارنامه'
                : '📢 تایید و انتشار کارنامه برای همه'}
            </button>
          </div>
        </div>
      </div>

      {feedbackMsg && (
        <div className="bg-blue-50 text-blue-900 border border-blue-200 rounded-lg p-2.5 text-xs font-bold mb-4">
          {feedbackMsg}
        </div>
      )}

      {/* If grading an individual submission */}
      {selectedSubForGrading ? (
        <div className="bg-slate-50 border-2 border-slate-900 rounded-xl p-4 mb-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3 pb-2 border-b border-slate-200">
            <div>
              <h3 className="text-sm sm:text-base font-black text-slate-900 m-0">
                بررسی پاسخ‌نامه: {selectedSubForGrading.studentName}
              </h3>
              <p className="text-xs text-slate-500 m-0 mt-0.5">
                زمان ارسال: {selectedSubForGrading.submittedAt ? new Date(selectedSubForGrading.submittedAt).toLocaleString('fa-IR') : 'نامشخص'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span
                className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                  selectedSubForGrading.teacherGrading?.approved
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {selectedSubForGrading.teacherGrading?.approved ? '✓ تایید شده' : '⏳ نیازمند تایید'}
              </span>
              <button
                type="button"
                onClick={() => setSelectedSubForGrading(null)}
                className="px-2.5 py-1 text-xs font-bold bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
              >
                بستن پاسخ‌نامه
              </button>
            </div>
          </div>

          {/* Questions */}
          <div className="space-y-3">
            {currentExam.questions.map((q, idx) => {
              const sAnswer = selectedSubForGrading.answers[q.id]
              const aiScore = selectedSubForGrading.aiGrading?.questionScores?.[q.id] ?? 0
              const currentScore = teacherScoresDraft[q.id] ?? aiScore
              const maxPts = Number(q.points) || 1

              return (
                <div key={q.id} className="bg-white border border-slate-300 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span className="text-xs sm:text-sm font-bold text-slate-800">
                      سوال {idx + 1}: {q.question} ({maxPts} نمره)
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs font-bold text-slate-600">نمره:</span>
                      <input
                        type="number"
                        step="0.25"
                        min="0"
                        max={maxPts}
                        value={currentScore}
                        onChange={(e) =>
                          setTeacherScoresDraft({
                            ...teacherScoresDraft,
                            [q.id]: Math.min(maxPts, Math.max(0, parseFloat(e.target.value) || 0)),
                          })
                        }
                        className="w-14 px-1.5 py-0.5 text-center text-xs font-extrabold border-2 border-slate-900 rounded"
                      />
                      <span className="text-xs text-slate-500">از {maxPts}</span>
                    </div>
                  </div>

                  {/* Student Answer */}
                  <div className="bg-slate-100 rounded p-2 text-xs text-slate-800 mb-1">
                    <strong>پاسخ دانش‌آموز: </strong>
                    {q.type === 'multiple_choice' ? (
                      <span>
                        گزینه {Number(sAnswer?.selectedOption ?? -1) + 1}
                        {q.options && sAnswer?.selectedOption !== undefined
                          ? ` (${q.options[sAnswer.selectedOption]})`
                          : ''}
                      </span>
                    ) : (
                      <span>{sAnswer?.textAnswer || 'بدون پاسخ'}</span>
                    )}
                    {sAnswer?.imageAttachment && (
                      <div className="mt-2">
                        <img
                          src={sAnswer.imageAttachment}
                          alt="پیوست دانش‌آموز"
                          className="max-h-48 rounded border"
                        />
                      </div>
                    )}
                  </div>

                  {/* Correct Answer Reference */}
                  <div className="text-[11px] text-slate-500">
                    کلید: {q.type === 'multiple_choice' ? `گزینه ${Number(q.correctAnswer) + 1} (${q.options?.[Number(q.correctAnswer)] || ''})` : String(q.correctAnswer || '')}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Teacher Note and Save */}
          <div className="mt-4 pt-3 border-t border-slate-200">
            <label className="block text-xs font-bold text-slate-800 mb-1">
              یادداشت و توصیه معلم برای کارنامه دانش‌آموز:
            </label>
            <textarea
              value={teacherNoteDraft}
              onChange={(e) => setTeacherNoteDraft(e.target.value)}
              placeholder="بازخورد آموزگار..."
              rows={2}
              className="w-full p-2 text-xs border-2 border-slate-900 rounded-lg mb-3"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs sm:text-sm font-black text-slate-900">
                مجموع نمره: {Object.values(teacherScoresDraft).reduce((sum, v) => sum + (v || 0), 0)} از {currentExam.totalPoints}
              </span>
              <button
                type="button"
                onClick={handleSaveGrading}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-lg border-2 border-slate-900 cursor-pointer"
              >
                ✅ تایید نهایی نمره این دانش‌آموز
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Submissions Tabs & List */
        <div>
          {/* Tabs */}
          <div className="flex gap-2 mb-3 border-b border-slate-200 pb-2">
            <button
              type="button"
              onClick={() => setActiveTab('submitted')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                activeTab === 'submitted'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              📥 ارسال کرده‌اند ({submissions.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('missing')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                activeTab === 'missing'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              ⏳ هنوز ارسال نکرده‌اند ({missingStudents.length})
            </button>
          </div>

          {activeTab === 'submitted' ? (
            submissions.length === 0 ? (
              <div className="text-center py-10 bg-slate-50 rounded-xl border border-dashed border-slate-300">
                <div className="text-3xl mb-2">⏳</div>
                <p className="text-sm font-bold text-slate-700 m-0">هنوز پاسخی ارسال نشده است</p>
                <p className="text-xs text-slate-500 mt-1">به محض ثبت آزمون توسط دانش‌آموزان در این لیست قرار می‌گیرد.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {sortByLastName(submissions, 'studentName').map((sub) => {
                  const isApproved = sub.teacherGrading?.approved
                  const displayScore = isApproved
                    ? sub.teacherGrading?.totalScore
                    : sub.aiGrading?.totalScore ?? 0

                  return (
                    <div
                      key={sub.id}
                      className={`flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl border transition-all ${
                        isApproved
                          ? 'bg-emerald-50/50 border-emerald-300'
                          : 'bg-amber-50/50 border-amber-300'
                      }`}
                    >
                      <div>
                        <div className="text-sm font-black text-slate-900">
                          👤 {sub.studentName}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          ارسال: {sub.submittedAt ? new Date(sub.submittedAt).toLocaleTimeString('fa-IR') : 'نامشخص'} • نمره:{' '}
                          <strong className="text-slate-800">{displayScore} از {currentExam.totalPoints}</strong>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                            isApproved ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {isApproved ? '✓ ثبت در کارنامه' : '⏳ در انتظار تایید'}
                        </span>

                        <button
                          type="button"
                          onClick={() => startGrading(sub)}
                          className="px-3 py-1 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold border-2 border-slate-900 rounded-lg cursor-pointer"
                        >
                          {isApproved ? 'ویرایش نمره' : 'بررسی و تایید نمره'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          ) : (
            /* Missing Students List */
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {missingStudents.map((st) => (
                <div
                  key={st.nationalCode}
                  className="p-2.5 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-between text-xs"
                >
                  <span className="font-bold text-slate-800">
                    {st.row}. {st.fullName}
                  </span>
                  <span className="text-[11px] text-slate-500">فرزند {st.fatherName}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

import { useState, useEffect } from 'react'
import { Exam, StudentExamSubmission } from '../types/examTypes'
import {
  getExamSubmissions,
  fetchExamSubmissions,
  approveExamSubmission,
  releaseExamResultsForAll,
  mergeSubmissionsDeduplicated,
  isExamResultsReleased,
  findGradebookRowForExamSubmission,
  syncExamApprovedGradesToGradebook,
  fetchTeacherGradebookRows,
} from '../utils/examStore'
import { CLASS_STUDENTS_ROSTER, isSameStudent, isTestStudentRecord } from '../classStudents'
import { sortByLastName } from '../utils/persianSort'
import {
  resolveCorrectOptionIndex,
  resolveStudentSelectedOption,
  getSubmissionEffectiveScore,
  isSubmissionApprovedByTeacher,
  getExamMaxPoints,
  safeScaled20,
  roundScore2,
  safeNumber,
  safeScore,
} from '../utils/persianSemanticGrader'
import { toPersianDigits } from '../utils/persianNumbers'

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
  const [gradeSyncErrorBanner, setGradeSyncErrorBanner] = useState<string | null>(null)
  const [gradebookRows, setGradebookRows] = useState<any[]>([])
  const [gradebookFetchState, setGradebookFetchState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [gradebookFetchError, setGradebookFetchError] = useState<string | null>(null)
  const [isSyncingGradesTable, setIsSyncingGradesTable] = useState(false)
  const [activeTab, setActiveTab] = useState<'submitted' | 'missing'>('submitted')

  useEffect(() => {
    setCurrentExam(exam)
    loadSubmissions()
  }, [exam.id])

  async function loadGradebookStatus() {
    setGradebookFetchState('loading')
    setGradebookFetchError(null)
    const res = await fetchTeacherGradebookRows(teacherPassword)
    if (res.ok) {
      setGradebookRows(res.rows)
      setGradebookFetchState('loaded')
      setGradebookFetchError(null)
    } else {
      setGradebookRows([])
      setGradebookFetchState('error')
      setGradebookFetchError(res.error || 'خطا در بررسی وضعیت جدول grades')
    }
  }

  async function loadSubmissions() {
    setIsRefreshing(true)
    try {
      const [fresh] = await Promise.all([
        fetchExamSubmissions(exam.id, undefined, true, teacherPassword),
        loadGradebookStatus(),
      ])
      setSubmissions(mergeSubmissionsDeduplicated([], fresh))
      if (onSubmissionsUpdated) onSubmissionsUpdated()
    } catch (err) {
      console.warn('Failed to fetch submissions:', err)
      setSubmissions(getExamSubmissions(exam.id))
    } finally {
      setIsRefreshing(false)
    }
  }

  async function handleSyncMissingGradesToTable() {
    if (isSyncingGradesTable) return
    setIsSyncingGradesTable(true)
    setGradeSyncErrorBanner(null)
    setFeedbackMsg('')
    try {
      const summary = await syncExamApprovedGradesToGradebook(currentExam.id, teacherPassword)
      await loadGradebookStatus()
      if (summary.failed > 0 || !summary.verifiedInGradesTable) {
        const detail = summary.errors.length > 0 ? summary.errors.slice(0, 3).join(' | ') : 'تأیید نهایی در جدول grades برقرار نشد.'
        setGradeSyncErrorBanner(
          `⚠️ همگام‌سازی جدول grades: ${toPersianDigits(summary.succeeded)} موفق، ${toPersianDigits(summary.failed)} ناموفق — ${detail}`
        )
      } else {
        setFeedbackMsg(
          `✓ ${toPersianDigits(summary.succeeded)} نمره تاییدشده با موفقیت در جدول اصلی grades ثبت و تأیید شد.`
        )
      }
    } catch (err: any) {
      setGradeSyncErrorBanner('خطا در ثبت نمرات در جدول grades: ' + (err?.message || 'خطای شبکه'))
    } finally {
      setIsSyncingGradesTable(false)
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
    setGradeSyncErrorBanner(null)
    try {
      const res = await releaseExamResultsForAll(currentExam.id, teacherPassword, isCurrentlyReleased)
      const nextState = !isCurrentlyReleased
      setCurrentExam((prev) => ({
        ...prev,
        resultsPublished: nextState,
        isResultsReleased: nextState,
        results_published: nextState,
      }))
      await loadSubmissions()
      if (nextState) {
        const gs = res.gradeSyncSummary
        if (gs && (gs.failed > 0 || !gs.verifiedInGradesTable)) {
          setGradeSyncErrorBanner(
            `⚠️ پاسخ‌نامه‌ها منتشر شدند اما ثبت در جدول grades برای ${toPersianDigits(gs.failed)} مورد با خطا مواجه شد: ${gs.errors.slice(0, 2).join(' | ')}`
          )
        } else {
          setFeedbackMsg(
            `🎉 کارنامه و نمرات با موفقیت تایید و در جدول grades ثبت شد (${toPersianDigits(gs?.succeeded || 0)} مورد).`
          )
        }
      } else {
        setFeedbackMsg('🔒 انتشار کارنامه لغو شد و دسترسی دانش‌آموزان مجدداً در حالت انتظار قرار گرفت.')
      }
    } catch (err: any) {
      setGradeSyncErrorBanner('خطا در تغییر وضعیت انتشار کارنامه: ' + (err?.message || 'خطای شبکه'))
    } finally {
      setIsReleasing(false)
    }
  }

  async function handleApprovePendingSubmissions() {
    if (!window.confirm('آیا مایلید تمامی پاسخ‌نامه‌هایی که هنوز در انتظار تأیید هستند بررسی و نمره‌شان برای دانش‌آموزان منتشر شود؟')) return
    setIsReleasing(true)
    setFeedbackMsg('')
    setGradeSyncErrorBanner(null)
    try {
      const res = await releaseExamResultsForAll(currentExam.id, teacherPassword, false)
      setCurrentExam((prev) => ({
        ...prev,
        resultsPublished: true,
        isResultsReleased: true,
        results_published: true,
      }))
      await loadSubmissions()
      const gs = res.gradeSyncSummary
      if (gs && (gs.failed > 0 || !gs.verifiedInGradesTable)) {
        setGradeSyncErrorBanner(
          `⚠️ پاسخ‌نامه‌ها تأیید شدند اما ${toPersianDigits(gs.failed)} نمره در جدول grades ثبت نشد: ${gs.errors.slice(0, 2).join(' | ')}`
        )
      } else {
        setFeedbackMsg(
          `🎉 نمرات تمامی پاسخ‌های در انتظار با موفقیت تأیید و در جدول grades ثبت شد (${toPersianDigits(gs?.succeeded || 0)} مورد).`
        )
      }
    } catch (err: any) {
      setGradeSyncErrorBanner('خطا در تأیید و انتشار نمرات: ' + (err?.message || 'خطای شبکه'))
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
    setGradeSyncErrorBanner(null)
    try {
      const savedSub: any = await approveExamSubmission({
        submissionId: selectedSubForGrading.id,
        exam: currentExam,
        studentId: selectedSubForGrading.studentId,
        approvedScores: teacherScoresDraft,
        teacherNotes: teacherNoteDraft,
        teacherPassword,
      })
      await loadSubmissions()
      const gs = savedSub?.gradeSync
      if (gs && !gs.ok) {
        const errText = `تأیید پاسخ‌نامه برای ${selectedSubForGrading.studentName} ذخیره شد، اما ثبت در جدول اصلی grades ناموفق بود: ${gs.error || 'خطای نامشخص'}`
        setGradeSyncErrorBanner(errText)
        setFeedbackMsg(`⚠️ ${errText}`)
      } else {
        setFeedbackMsg(`✓ نمره و یادداشت برای ${selectedSubForGrading.studentName} با موفقیت تأیید و در جدول grades ثبت شد.`)
      }
      const updatedList = getExamSubmissions(currentExam.id)
      const reloaded = updatedList.find((s) => s.id === selectedSubForGrading.id)
      if (reloaded) setSelectedSubForGrading(reloaded)
    } catch (err: any) {
      setGradeSyncErrorBanner('خطا در ثبت نمره: ' + (err?.message || 'خطای سرور'))
    }
  }

  const examMaxPts = getExamMaxPoints(currentExam)
  const isReleased = !!(currentExam.resultsPublished || currentExam.isResultsReleased)
  const totalStudents = CLASS_STUDENTS_ROSTER.length || 40
  const realSubmissions = submissions.filter((s) => !isTestStudentRecord(s.studentId, s.studentName))
  const pendingUnapprovedCount = realSubmissions.filter((s) => !isSubmissionApprovedByTeacher(s)).length
  const missingStudents = CLASS_STUDENTS_ROSTER.filter(
    (st) =>
      !realSubmissions.some((s) =>
        isSameStudent(s.studentId, st.id, s.studentName, st.fullName)
      )
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
            <span>مجموع بارم: <strong>{toPersianDigits(examMaxPts)} نمره</strong></span>
            <span>•</span>
            <span>تعداد سوالات: <strong>{toPersianDigits(currentExam.questions.length)}</strong></span>
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
                پاسخ‌های دریافتی: <strong>{toPersianDigits(realSubmissions.length)}</strong> از <strong>{toPersianDigits(totalStudents)}</strong> دانش‌آموز ({toPersianDigits(Math.round((realSubmissions.length / totalStudents) * 100))}%)
              </span>
            </div>
            <p className="text-xs text-slate-600 m-0 leading-relaxed">
              {isReleased
                ? 'دانش‌آموزان به نمره، کارنامه و کلید سوالات دسترسی دارند.'
                : 'پاسخ‌ها در انتظار تایید آموزگار هستند و دانش‌آموزان تا پیش از انتشار به کارنامه دسترسی ندارند.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isReleased && pendingUnapprovedCount > 0 && (
              <button
                type="button"
                onClick={handleApprovePendingSubmissions}
                disabled={isReleasing}
                className="px-4 py-2 rounded-xl border-2 border-slate-900 text-xs sm:text-sm font-black text-white bg-emerald-600 hover:bg-emerald-700 transition-all cursor-pointer shadow-sm"
              >
                {`✅ تایید و انتشار ${toPersianDigits(pendingUnapprovedCount)} پاسخ در انتظار`}
              </button>
            )}
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
        {isReleased && pendingUnapprovedCount > 0 && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-amber-100 border border-amber-300 text-[11px] sm:text-xs font-bold text-amber-900">
            ⚠️ توجه: {toPersianDigits(pendingUnapprovedCount)} پاسخ‌نامه هنوز در وضعیت «در انتظار تأیید» هستند و تا زمان تأیید توسط شما، نمره آن‌ها در کارنامه دانش‌آموزان نمایش داده نمی‌شود.
          </div>
        )}

        {(() => {
          const approvedRealSubs = realSubmissions.filter((s) => isSubmissionApprovedByTeacher(s) && isExamResultsReleased(currentExam, s))
          const missingInGradesCount =
            gradebookFetchState === 'loaded'
              ? approvedRealSubs.filter((s) => !findGradebookRowForExamSubmission(gradebookRows, currentExam, s.studentId, s.studentName)).length
              : 0

          if (gradebookFetchState === 'error') {
            return (
              <div className="mt-3 px-3 py-2 rounded-lg bg-rose-50 border border-rose-300 text-[11px] sm:text-xs font-bold text-rose-900">
                ⚠️ بررسی ثبت واقعی در جدول اصلی grades ممکن نشد: {gradebookFetchError}
              </div>
            )
          }

          if (gradebookFetchState === 'loaded' && missingInGradesCount > 0) {
            return (
              <div className="mt-3 px-3 py-2.5 rounded-lg bg-orange-50 border border-orange-300 text-[11px] sm:text-xs font-bold text-orange-900 flex flex-wrap items-center justify-between gap-2">
                <span>
                  ⚠️ برای {toPersianDigits(missingInGradesCount)} دانش‌آموز تأییدشده، رکوردی در جدول اصلی <code>grades</code> یافت نشد و نمره فعلاً از منبع جایگزین پاسخ‌نامه خوانده می‌شود.
                </span>
                <button
                  type="button"
                  onClick={handleSyncMissingGradesToTable}
                  disabled={isSyncingGradesTable}
                  className="px-3 py-1.5 rounded-lg border-2 border-slate-900 bg-orange-600 hover:bg-orange-700 text-white text-xs font-black cursor-pointer"
                >
                  {isSyncingGradesTable ? '⏳ در حال ثبت...' : '📥 ثبت نمرات تاییدشده در جدول اصلی grades'}
                </button>
              </div>
            )
          }
          return null
        })()}
      </div>

      {gradeSyncErrorBanner && (
        <div className="bg-rose-50 text-rose-900 border border-rose-300 rounded-lg p-2.5 text-xs font-bold mb-4">
          {gradeSyncErrorBanner}
        </div>
      )}

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
              const maxPts = safeScore(q.points, 10, 1)
              const aiScore = safeScore(selectedSubForGrading.aiGrading?.questionScores?.[q.id], maxPts, 0)
              const currentScore = safeScore(teacherScoresDraft[q.id] ?? aiScore, maxPts)
              const resolvedCorrect = resolveCorrectOptionIndex(q)
              const resolvedStudent = resolveStudentSelectedOption(sAnswer, q.options)

              return (
                <div key={q.id} className="bg-white border border-slate-300 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span className="text-xs sm:text-sm font-bold text-slate-800">
                      سوال {toPersianDigits(idx + 1)}: {q.question} ({toPersianDigits(maxPts)} نمره)
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
                            [q.id]: safeScore(parseFloat(e.target.value) || 0, maxPts),
                          })
                        }
                        className="w-14 px-1.5 py-0.5 text-center text-xs font-extrabold border-2 border-slate-900 rounded"
                      />
                      <span className="text-xs text-slate-500">از {toPersianDigits(maxPts)}</span>
                    </div>
                  </div>

                  {/* Student Answer */}
                  <div className="bg-slate-100 rounded p-2 text-xs text-slate-800 mb-1">
                    <strong>پاسخ دانش‌آموز: </strong>
                    {q.type === 'multiple_choice' ? (
                      <span>
                        {resolvedStudent.isValid
                          ? `${resolvedStudent.label}${resolvedStudent.text ? ` (${resolvedStudent.text})` : ''}`
                          : 'بدون پاسخ'}
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
                    کلید: {q.type === 'multiple_choice'
                      ? `${resolvedCorrect.label}${resolvedCorrect.text ? ` (${resolvedCorrect.text})` : ''}`
                      : String(q.correctAnswer || q.rubricOrHint || 'تعیین‌نشده')}
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
            <div className="flex items-center justify-between flex-wrap gap-2">
              {(() => {
                const draftTotal = roundScore2(
                  Object.values(teacherScoresDraft).reduce((sum, v) => sum + safeNumber(v, 0), 0)
                )
                const draftScaled = safeScaled20(draftTotal, examMaxPts)
                return (
                  <span className="text-xs sm:text-sm font-black text-slate-900">
                    مجموع نمره: {toPersianDigits(draftTotal)} از {toPersianDigits(examMaxPts)}{' '}
                    <span className="text-blue-700">({toPersianDigits(draftScaled)} از ۲۰)</span>
                  </span>
                )
              })()}
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
                  const eff = getSubmissionEffectiveScore(currentExam, sub)
                  const isApproved = eff.isApproved
                  const isTest = isTestStudentRecord(sub.studentId, sub.studentName)

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
                        <div className="text-sm font-black text-slate-900 flex items-center gap-2 flex-wrap">
                          <span>👤 {sub.studentName}</span>
                          {isTest && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800">
                              🧪 حساب آزمایشی معلم
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          ارسال: {sub.submittedAt ? new Date(sub.submittedAt).toLocaleTimeString('fa-IR') : 'نامشخص'} •{' '}
                          {isApproved ? 'نمره رسمی:' : 'پیشنهادی هوشمند:'}{' '}
                          <strong className="text-blue-700">{toPersianDigits(eff.scaledScore20)} از ۲۰</strong>{' '}
                          <span className="text-slate-600">
                            ({toPersianDigits(eff.totalScore)} از {toPersianDigits(eff.maxPoints)})
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {(() => {
                          const subReleased = isExamResultsReleased(currentExam, sub)
                          const hasGradesRow =
                            gradebookFetchState === 'loaded' &&
                            Boolean(findGradebookRowForExamSubmission(gradebookRows, currentExam, sub.studentId, sub.studentName))
                          let badgeClass = 'bg-amber-100 text-amber-800'
                          let badgeLabel = '⏳ در انتظار تایید'
                          if (isApproved && subReleased) {
                            if (isTest) {
                              badgeClass = 'bg-indigo-100 text-indigo-800'
                              badgeLabel = '🧪 تاییدشده (حساب آزمایشی)'
                            } else if (gradebookFetchState === 'loaded') {
                              badgeClass = hasGradesRow ? 'bg-emerald-100 text-emerald-800' : 'bg-orange-100 text-orange-900'
                              badgeLabel = hasGradesRow ? '✓ ثبت در کارنامه' : '⚠️ نمایش از پاسخ‌نامه (در جدول grades ثبت نشده)'
                            } else if (gradebookFetchState === 'error') {
                              badgeClass = 'bg-rose-100 text-rose-800'
                              badgeLabel = '⚠️ تاییدشده (خطا در بررسی grades)'
                            } else {
                              badgeClass = 'bg-blue-100 text-blue-800'
                              badgeLabel = '⏳ در حال بررسی grades...'
                            }
                          } else if (isApproved) {
                            badgeClass = 'bg-blue-100 text-blue-800'
                            badgeLabel = '✔ تایید معلم (کارنامه قفل)'
                          }
                          return (
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${badgeClass}`}>
                              {badgeLabel}
                            </span>
                          )
                        })()}

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

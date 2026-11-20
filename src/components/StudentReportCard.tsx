import { useMemo, useState } from 'react'
import { toPersianDigits } from '../utils/persianNumbers'
import {
  sanitizeExamTitle,
  getLocalExams,
  getLocalSubmissions,
  isExamResultsReleased,
  mergeSubmissionsDeduplicated,
  deduplicateGradebookRows,
  fetchStudentExamReview,
  StudentExamReviewQuestionItem,
  isValidUuid,
} from '../utils/examStore'
import { sanitizeTeacherFeedback } from '../utils/cleanFeedback'
import {
  getSubmissionEffectiveScore,
  isSubmissionApprovedByTeacher,
  roundScore2,
  safeScaled20,
} from '../utils/persianSemanticGrader'
import { isSameStudent, resolveCanonicalStudent } from '../classStudents'
import ExamReviewModal from './ExamReviewModal'
import SchoolLogo from './SchoolLogo'

export default function StudentReportCard({
  student,
  grades,
  attendanceRows,
  submissions,
  examSubmissions,
  homeworkCount,
  reportNote,
  loading = false,
  error = null,
  onRetry,
  onClose,
}: {
  student: any
  grades: any[]
  attendanceRows: any[]
  submissions: any[]
  examSubmissions?: any[]
  homeworkCount: number
  reportNote?: string
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onClose: () => void
}) {
  const [reviewExamData, setReviewExamData] = useState<{
    exam: any
    submission: any
    questionsReview?: StudentExamReviewQuestionItem[]
    scaledScore20?: number | null
    forceReleased?: boolean
  } | null>(null)
  const [reviewNotice, setReviewNotice] = useState<string | null>(null)
  const [openingExamId, setOpeningExamId] = useState<string | null>(null)

  // Normalize every grade strictly to 20: Score = (earned / total) * 20
  const dedupedInputGrades = deduplicateGradebookRows(grades || [])
  const normalizedGrades = dedupedInputGrades.map((g: any) => {
    const isPendingReview = g.status === 'pending_review'
    const isPendingSubmission = g.status === 'pending_submission'
    const isPending = isPendingReview || isPendingSubmission

    const rawScoreInput = Number(g.score) || 0
    const rawMaxInput = Number(g.max_score) || 20

    // Match exam and submission if this represents an exam
    let matchedExam = g.matchedExam || g.exam || null
    let matchedSub = g.matchedSub || g.sub || null

    if (!matchedExam) {
      const allExams = getLocalExams()
      matchedExam =
        allExams.find((e) => {
          if (g.examId && e.id === g.examId) return true
          if (g.id && (`exam_sub_${e.id}` === g.id || `exam_${e.id}` === g.id)) return true
          const cleanE = sanitizeExamTitle(e.title, e.subject)
          const cleanG = sanitizeExamTitle(g.skill || '', g.subject)
          return cleanE && cleanG && (cleanE === cleanG || g.skill?.includes(cleanE))
        }) || null
    }

    if (!matchedSub && matchedExam) {
      const rawSubs =
        Array.isArray(examSubmissions) && examSubmissions.length > 0 ? examSubmissions : getLocalSubmissions()
      const allSubs = mergeSubmissionsDeduplicated([], rawSubs)
      matchedSub =
        allSubs.find(
          (s) =>
            s.examId === matchedExam.id &&
            isSameStudent(s.studentId, student.id, s.studentName, student.fullName || student.full_name)
        ) || null
    }

    const normalizedDb20 =
      rawMaxInput > 0 && rawMaxInput !== 20
        ? safeScaled20(rawScoreInput, rawMaxInput)
        : safeScaled20(rawScoreInput, 20)

    const isExplicitDbRecord = Boolean(
      g.id && !String(g.id).startsWith('exam_sub_') && !String(g.id).startsWith('exam_')
    )
    const gRecordedMs = g.recorded_at ? new Date(g.recorded_at).getTime() : 0
    const subApprovedMs = matchedSub?.teacherGrading?.approvedAt
      ? new Date(matchedSub.teacherGrading.approvedAt).getTime()
      : 0

    const isApprovedOrReleased =
      matchedSub && matchedExam
        ? isSubmissionApprovedByTeacher(matchedSub) && isExamResultsReleased(matchedExam, matchedSub)
        : false

    const subEff =
      matchedSub && matchedExam && isApprovedOrReleased
        ? getSubmissionEffectiveScore(matchedExam, matchedSub)
        : null
    const isDifferentManualDbScore = subEff ? Math.abs(normalizedDb20 - subEff.scaledScore20) > 0.06 : false
    const isNewerDbManualEdit = Boolean(
      isExplicitDbRecord &&
        isDifferentManualDbScore &&
        gRecordedMs > 0 &&
        subApprovedMs > 0 &&
        gRecordedMs > subApprovedMs + 1000
    )

    const effectivePending = isPending || Boolean(matchedSub && matchedExam && !isApprovedOrReleased)
    const effectivePendingReview = isPendingReview || Boolean(matchedSub && matchedExam && !isApprovedOrReleased)

    let scaledScore: number | null = null

    if (effectivePending) {
      scaledScore = null
    } else if (subEff && isApprovedOrReleased && !isNewerDbManualEdit) {
      scaledScore = safeScaled20(subEff.totalScore, subEff.maxPoints)
    } else if (g.raw_score !== undefined && g.raw_max !== undefined && Number(g.raw_max) > 0) {
      scaledScore = safeScaled20(Number(g.raw_score), Number(g.raw_max))
    } else {
      scaledScore = normalizedDb20
    }

    const cleanLabel = sanitizeTeacherFeedback(sanitizeExamTitle(g.skill || g.subject || 'عمومی', g.subject))

    let qualitativeStatus = 'خیلی خوب'
    let qualitativeColor = 'text-emerald-700 bg-emerald-50 border-emerald-200'

    if (effectivePendingReview) {
      qualitativeStatus = 'در انتظار تصحیح'
      qualitativeColor = 'text-amber-700 bg-amber-50 border-amber-200'
    } else if (isPendingSubmission) {
      qualitativeStatus = 'در انتظار انجام'
      qualitativeColor = 'text-indigo-700 bg-indigo-50 border-indigo-200'
    } else if (scaledScore !== null) {
      if (scaledScore < 12) {
        qualitativeStatus = 'نیازمند تلاش'
        qualitativeColor = 'text-rose-700 bg-rose-50 border-rose-200'
      } else if (scaledScore < 15) {
        qualitativeStatus = 'قابل قبول'
        qualitativeColor = 'text-amber-700 bg-amber-50 border-amber-200'
      } else if (scaledScore < 18) {
        qualitativeStatus = 'خوب'
        qualitativeColor = 'text-blue-700 bg-blue-50 border-blue-200'
      }
    }

    return {
      ...g,
      status: effectivePending
        ? effectivePendingReview
          ? 'pending_review'
          : 'pending_submission'
        : g.status || 'graded',
      score: scaledScore,
      max_score: 20,
      scaledScore,
      cleanLabel,
      matchedExam,
      matchedSub,
      qualitativeStatus,
      qualitativeColor,
    }
  })

  const gradedList = normalizedGrades.filter(
    (g: any) => g.status === 'graded' && g.scaledScore !== null && !isNaN(g.scaledScore)
  )

  const gpaVal = gradedList.length
    ? String(roundScore2(gradedList.reduce((acc: number, g: any) => acc + g.scaledScore, 0) / gradedList.length))
    : null

  // Per-subject averages strictly calculated from the out-of-20 normalized scores
  const subjectAverages = useMemo(() => {
    const map = new Map<string, { sum: number; count: number }>()
    for (const g of gradedList) {
      const subject = String(g.subject || 'عمومی').trim()
      const curr = map.get(subject) || { sum: 0, count: 0 }
      curr.sum += Number(g.scaledScore)
      curr.count += 1
      map.set(subject, curr)
    }
    return Array.from(map.entries())
      .map(([subject, stats]) => ({
        subject,
        avg: roundScore2(stats.sum / stats.count),
        count: stats.count,
      }))
      .sort((a, b) => b.avg - a.avg)
  }, [gradedList])

  const presents = attendanceRows.filter((a: any) => a.status === 'present').length
  const lates = attendanceRows.filter((a: any) => a.status === 'late').length
  const absents = attendanceRows.filter((a: any) => a.status === 'absent').length

  const cleanReportNote = sanitizeTeacherFeedback(reportNote)

  async function handleOpenReview(g: any) {
    const examId = String(g.examId || g.matchedExam?.id || '')
    if (!examId) return

    setReviewNotice(null)
    setOpeningExamId(examId)

    try {
      const rosterInfo = resolveCanonicalStudent(
        student?.id || student?.access_code || student?.full_name || student?.fullName
      )
      const canonicalStudentId = rosterInfo?.id || student?.id || ''
      const canonicalAccessCode = rosterInfo?.nationalCode || student?.access_code || student?.id || ''

      // Fetch full unsanitized questions + correct answers + explanations via secure RPC
      if (isValidUuid(examId) && isValidUuid(canonicalStudentId) && canonicalAccessCode) {
        const res = await fetchStudentExamReview({
          examId,
          studentId: canonicalStudentId,
          accessCode: canonicalAccessCode,
        })

        if (res.ok && res.released && res.exam && res.submission) {
          setReviewExamData({
            exam: res.exam,
            submission: res.submission,
            questionsReview: res.questionsReview,
            scaledScore20: res.scaledScore20,
            forceReleased: true,
          })
          return
        }

        if (!res.released) {
          setReviewNotice(res.message || 'نتیجه هنوز منتشر نشده است.')
          return
        }
      }

      // Preview-mode or non-UUID fallback
      if (g.status === 'pending_review' || g.status === 'pending_submission') {
        setReviewNotice('نتیجه هنوز منتشر نشده است.')
        return
      }

      if (g.matchedExam && g.matchedSub) {
        if (!isExamResultsReleased(g.matchedExam, g.matchedSub)) {
          setReviewNotice('نتیجه هنوز منتشر نشده است.')
          return
        }
        setReviewExamData({
          exam: g.matchedExam,
          submission: g.matchedSub,
        })
      } else {
        setReviewNotice('برگه پاسخ ثبت‌شده برای این آزمون در دسترس نیست.')
      }
    } catch (err: any) {
      setReviewNotice(err?.message || 'خطا در دریافت پاسخ‌نامه از سرور. لطفاً دوباره تلاش کنید.')
    } finally {
      setOpeningExamId(null)
    }
  }

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 overflow-y-auto animate-[mobileFadeIn_0.2s_ease-out]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #printable-report, #printable-report * { visibility: visible; }
          #printable-report {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            padding: 20px !important;
            margin: 0 !important;
            border: none !important;
            box-shadow: none !important;
          }
          .no-print { display: none !important; }
        }
      `}</style>

      <div
        className="w-full max-w-3xl bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[94vh] animate-[pageSlideIn_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Action Bar */}
        <div className="no-print bg-slate-900 text-white px-5 py-3.5 flex items-center justify-between gap-3 shrink-0 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="text-xl">📊</span>
            <div>
              <h3 className="text-sm font-black text-white">کارنامه رسمی عملکرد تحصیلی دانش‌آموز</h3>
              <p className="text-[11px] text-slate-400">پایه ششم دبستان هوشمند حضرت قائم (عج)</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onRetry && (
              <button
                type="button"
                disabled={loading}
                onClick={onRetry}
                className="px-3 py-1.5 text-xs font-bold text-slate-200 hover:text-white bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-xl transition-colors inline-flex items-center gap-1 cursor-pointer"
                title="دریافت مجدد نمرات از سرور"
              >
                <span>{loading ? '⏳' : '🔄'}</span>
                <span className="hidden sm:inline">{loading ? 'در حال دریافت...' : 'بروزرسانی'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => window.print()}
              className="px-3.5 py-1.5 text-xs font-black text-white bg-blue-600 hover:bg-blue-500 rounded-xl shadow-xs transition-colors inline-flex items-center gap-1.5 cursor-pointer"
            >
              <span>🖨️</span>
              <span>چاپ کارنامه (PDF)</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-bold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors cursor-pointer"
              title="بستن پنجره"
            >
              ✕ بستن
            </button>
          </div>
        </div>

        {/* Scrollable Printable Document */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 bg-slate-50/60">
          {/* Fresh Server Sync Status / Error Banner */}
          {loading && (
            <div className="no-print mb-3 bg-blue-50 border border-blue-200 text-blue-800 rounded-xl px-4 py-2.5 text-xs font-bold flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-600 animate-ping" />
              <span>در حال دریافت جدیدترین نمرات از سرور...</span>
            </div>
          )}

          {error && (
            <div className="no-print mb-4 bg-rose-50 border border-rose-200 text-rose-900 rounded-xl px-4 py-3 text-xs font-bold flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-center gap-2">
                <span className="text-base">⚠️</span>
                <span>{error}</span>
              </div>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="self-start sm:self-auto px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-black transition-colors cursor-pointer shrink-0 inline-flex items-center gap-1"
                >
                  <span>🔄</span>
                  <span>تلاش دوباره</span>
                </button>
              )}
            </div>
          )}

          <div
            id="printable-report"
            className="bg-white border border-slate-300 rounded-2xl p-5 sm:p-8 shadow-xs text-slate-900"
          >
            {/* Report Card Header */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-b-2 border-slate-800 pb-5 mb-5">
              <div className="flex items-center gap-3">
                <SchoolLogo size={52} className="shrink-0" />
                <div className="text-right">
                  <h2 className="text-lg sm:text-xl font-black text-slate-900 tracking-tight">
                    دبستان پسرانه هوشمند حضرت قائم (عج)
                  </h2>
                  <p className="text-xs text-slate-500 font-bold mt-0.5">
                    کارنامه جامع توصیفی و عملکرد تحصیلی — سال تحصیلی ۱۴۰۴-۱۴۰۵
                  </p>
                </div>
              </div>

              <div className="text-center sm:text-left bg-slate-50 px-4 py-2 rounded-xl border border-slate-200">
                <div className="text-[11px] text-slate-500 font-bold">تاریخ صدور کارنامه</div>
                <div className="text-xs font-black text-slate-800 mt-0.5">
                  {toPersianDigits(new Date().toLocaleDateString('fa-IR'))}
                </div>
              </div>
            </div>

            {/* Student Info Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-blue-50/60 border border-blue-200/80 rounded-xl p-3.5 mb-5 text-xs">
              <div>
                <span className="text-slate-500 font-medium block">نام و نام خانوادگی:</span>
                <span className="font-black text-slate-900 text-sm mt-0.5 block">{student?.full_name}</span>
              </div>
              <div>
                <span className="text-slate-500 font-medium block">پایه و کلاس:</span>
                <span className="font-bold text-slate-900 mt-0.5 block">پایه ششم ابتدایی</span>
              </div>
              <div>
                <span className="text-slate-500 font-medium block">کد دانش‌آموزی / ورود:</span>
                <span className="font-bold text-slate-900 mt-0.5 block font-mono">
                  {toPersianDigits(student?.access_code || student?.id || '—')}
                </span>
              </div>
              <div>
                <span className="text-slate-500 font-medium block">وضعیت ثبت‌نام:</span>
                <span className="font-bold text-emerald-700 mt-0.5 block">اشتغال به تحصیل ✓</span>
              </div>
            </div>

            {/* Summary KPIs */}
            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-3 text-center">
                <div className="text-[11px] text-emerald-800 font-bold">معدل کل ارزیابی‌ها</div>
                <div className="text-xl sm:text-2xl font-black text-emerald-700 mt-1">
                  {gpaVal ? `${toPersianDigits(gpaVal)} از ۲۰` : '—'}
                </div>
                <div className="text-[10px] text-emerald-700 font-black mt-0.5">
                  {gpaVal && Number(gpaVal) >= 18 ? 'سطح: خیلی خوب (ممتاز)' : 'سطح: مطلوب'}
                </div>
              </div>

              <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-3 text-center">
                <div className="text-[11px] text-blue-800 font-bold">تکالیف تحویل‌شده</div>
                <div className="text-xl sm:text-2xl font-black text-blue-700 mt-1">
                  {toPersianDigits(submissions.length)}
                  <span className="text-xs font-bold text-blue-600 mr-1">از {toPersianDigits(homeworkCount)}</span>
                </div>
                <div className="text-[10px] text-blue-700 font-bold mt-0.5">
                  {homeworkCount > 0
                    ? `${toPersianDigits(Math.round((submissions.length / homeworkCount) * 100))}٪ انجام تکالیف`
                    : 'بدون تکلیف معوق'}
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                <div className="text-[11px] text-slate-600 font-bold">آمار حضور و غیاب</div>
                <div className="text-sm sm:text-base font-black text-slate-800 mt-1.5 flex items-center justify-center gap-1.5">
                  <span className="text-emerald-700">{toPersianDigits(presents)} حاضر</span>
                  <span>·</span>
                  <span className="text-amber-600">{toPersianDigits(lates)} تاخیر</span>
                  <span>·</span>
                  <span className="text-rose-600">{toPersianDigits(absents)} غایب</span>
                </div>
                <div className="text-[10px] text-slate-500 font-bold mt-0.5">
                  مجموع {toPersianDigits(attendanceRows.length)} جلسه ثبت‌شده
                </div>
              </div>
            </div>

            {/* Subject Averages (strictly calculated from out-of-20 scores) */}
            {subjectAverages.length > 0 && (
              <div className="mb-5">
                <div className="text-xs font-black text-slate-700 mb-2">میانگین هر درس (از ۲۰):</div>
                <div className="flex flex-wrap gap-2">
                  {subjectAverages.map((sa) => (
                    <div
                      key={sa.subject}
                      className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-bold flex items-center gap-1.5"
                    >
                      <span className="text-slate-800">{sa.subject}:</span>
                      <span className="font-black text-blue-700">
                        {toPersianDigits(sa.avg)} از ۲۰
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {reviewNotice && (
              <div className="no-print mb-4 bg-amber-50 border border-amber-300 text-amber-900 rounded-xl px-4 py-2.5 text-xs font-bold flex items-center justify-between gap-2">
                <span>⚠️ {reviewNotice}</span>
                <button
                  type="button"
                  onClick={() => setReviewNotice(null)}
                  className="text-amber-800 hover:text-amber-950 font-black cursor-pointer px-1.5"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Grades Table */}
            <div className="overflow-x-auto rounded-xl border border-slate-200 mb-6">
              <table className="w-full border-collapse text-right text-xs sm:text-sm">
                <thead>
                  <tr className="bg-slate-100 text-slate-700 font-black border-b border-slate-200">
                    <th className="py-2.5 px-3 w-12 text-center">ردیف</th>
                    <th className="py-2.5 px-3">عنوان درس و آزمون</th>
                    <th className="py-2.5 px-3 text-center">نمره (از ۲۰)</th>
                    <th className="py-2.5 px-3 text-center">مقیاس توصیفی</th>
                    <th className="no-print py-2.5 px-3 text-center w-36">پاسخ‌نامه</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {normalizedGrades.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-500 font-medium">
                        هنوز نمره‌ای برای دانش‌آموز در سامانه ثبت نشده است.
                      </td>
                    </tr>
                  )}
                  {normalizedGrades.map((g: any, index: number) => {
                    const examId = String(g.examId || g.matchedExam?.id || '')
                    const hasExamObj = Boolean(examId)
                    const isOpening = openingExamId === examId

                    return (
                      <tr
                        key={g.id || index}
                        className={`hover:bg-slate-50 transition-colors ${hasExamObj ? 'cursor-pointer' : ''}`}
                        onClick={() => {
                          if (hasExamObj) handleOpenReview(g)
                        }}
                      >
                        <td className="py-2.5 px-3 text-center text-slate-500 font-mono">
                          {toPersianDigits(index + 1)}
                        </td>
                        <td className="py-2.5 px-3 font-bold text-slate-900">
                          <span>{g.subject}</span>
                          {g.cleanLabel && g.cleanLabel !== g.subject && (
                            <span className="text-xs text-slate-500 font-normal mr-1.5">
                              ({g.cleanLabel})
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-center font-black text-sm whitespace-nowrap">
                          {g.scaledScore !== null ? (
                            <span
                              className={
                                g.scaledScore >= 16
                                  ? 'text-emerald-700'
                                  : g.scaledScore >= 12
                                  ? 'text-amber-700'
                                  : 'text-rose-700'
                              }
                            >
                              {toPersianDigits(g.scaledScore)} از ۲۰
                            </span>
                          ) : (
                            <span className="text-slate-400 font-bold">—</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-bold border ${g.qualitativeColor}`}
                          >
                            {g.qualitativeStatus}
                          </span>
                        </td>
                        <td className="no-print py-2.5 px-3 text-center">
                          {hasExamObj ? (
                            <button
                              type="button"
                              disabled={isOpening}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleOpenReview(g)
                              }}
                              className="px-2.5 py-1 text-[11px] font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-200 transition-colors cursor-pointer inline-flex items-center gap-1"
                            >
                              <span>{isOpening ? '⏳' : '📋'}</span>
                              <span>{isOpening ? 'در حال دریافت...' : 'پاسخ‌نامه'}</span>
                            </button>
                          ) : (
                            <span className="text-[11px] text-slate-400 font-medium">کلاسی</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Pedagogical Teacher Note */}
            <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-4 mb-6">
              <div className="flex items-center gap-2 text-amber-900 font-black text-xs mb-2">
                <span className="text-base">✍️</span>
                <span>توصیه‌ها و رهنمودهای آموزشی آموزگار محترم:</span>
              </div>
              <p className="text-xs text-amber-950 leading-relaxed font-medium">
                {cleanReportNote ||
                  'دانش‌آموز کوشا و بااستعداد کلاس ششم، با استمرار در حل تکالیف و مشارکت فعال در کلاس، همواره در جهت شکوفایی علمی و اخلاقی گام برمی‌دارد.'}
              </p>
            </div>

            {/* Official Signatures and Stamp Section */}
            <div className="pt-4 border-t border-slate-200 grid grid-cols-3 gap-4 text-center text-xs">
              <div>
                <div className="font-black text-slate-700">امضای ولی دانش‌آموز</div>
                <div className="h-14 mt-1 border-b border-dashed border-slate-300" />
              </div>
              <div>
                <div className="font-black text-slate-700">امضای آموزگار پایه ششم</div>
                <div className="h-14 mt-1 border-b border-dashed border-slate-300" />
              </div>
              <div>
                <div className="font-black text-slate-700">مهر و امضای مدیریت دبستان</div>
                <div className="h-14 mt-1 border-b border-dashed border-slate-300" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Review Modal Popup when student clicks on any exam row */}
      {reviewExamData && (
        <ExamReviewModal
          exam={reviewExamData.exam}
          submission={reviewExamData.submission}
          questionsReview={reviewExamData.questionsReview}
          scaledScore20Override={reviewExamData.scaledScore20}
          forceReleased={reviewExamData.forceReleased}
          onClose={() => setReviewExamData(null)}
        />
      )}
    </div>
  )
}

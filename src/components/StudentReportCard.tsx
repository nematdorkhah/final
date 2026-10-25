import { useState } from 'react'
import { toPersianDigits } from '../utils/persianNumbers'
import { sanitizeExamTitle, getLocalExams, getLocalSubmissions } from '../utils/examStore'
import { sanitizeTeacherFeedback } from '../utils/cleanFeedback'
import ExamReviewModal from './ExamReviewModal'
import SchoolLogo from './SchoolLogo'

export default function StudentReportCard({
  student,
  grades,
  attendanceRows,
  submissions,
  homeworkCount,
  reportNote,
  onClose,
}: {
  student: any
  grades: any[]
  attendanceRows: any[]
  submissions: any[]
  homeworkCount: number
  reportNote?: string
  onClose: () => void
}) {
  const [reviewExamData, setReviewExamData] = useState<{ exam: any; submission: any } | null>(null)

  // Normalize every grade to 20 (Score = (Earned / Total) * 20)
  const normalizedGrades = grades.map((g: any) => {
    let rawScore = Number(g.score) || 0
    let rawMax = Number(g.max_score) || 20

    // Match exam and submission if this represents an exam
    let matchedExam = g.exam || null
    let matchedSub = g.sub || null

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
      const allSubs = getLocalSubmissions()
      matchedSub = allSubs.find((s) => s.examId === matchedExam.id && s.studentId === student.id) || null
    }

    if (matchedSub && matchedExam) {
      const subEarned =
        matchedSub.teacherGrading?.totalScore ??
        matchedSub.aiGrading?.totalScore ??
        matchedSub.studentScore
      if (subEarned !== undefined && subEarned !== null) {
        rawScore = Number(subEarned)
      }
      if (matchedExam.totalPoints || matchedExam.totalScore) {
        rawMax = Number(matchedExam.totalPoints || matchedExam.totalScore)
      }
    }

    const scaledScore = rawMax > 0 ? Math.round(((rawScore / rawMax) * 20) * 10) / 10 : rawScore
    const cleanLabel = sanitizeTeacherFeedback(sanitizeExamTitle(g.skill || g.subject || 'عمومی', g.subject))

    let qualitativeStatus = 'خیلی خوب'
    let qualitativeColor = 'text-emerald-700 bg-emerald-50 border-emerald-200'
    if (scaledScore < 10) {
      qualitativeStatus = 'نیازمند تلاش'
      qualitativeColor = 'text-rose-700 bg-rose-50 border-rose-200'
    } else if (scaledScore < 15) {
      qualitativeStatus = 'قابل قبول'
      qualitativeColor = 'text-amber-700 bg-amber-50 border-amber-200'
    } else if (scaledScore < 18) {
      qualitativeStatus = 'خوب'
      qualitativeColor = 'text-blue-700 bg-blue-50 border-blue-200'
    }

    return {
      ...g,
      rawScore,
      rawMax,
      scaledScore,
      cleanLabel,
      matchedExam,
      matchedSub,
      qualitativeStatus,
      qualitativeColor,
    }
  })

  const gpaVal = normalizedGrades.length
    ? (normalizedGrades.reduce((acc: number, g: any) => acc + g.scaledScore, 0) / normalizedGrades.length).toFixed(2)
    : null

  const presents = attendanceRows.filter((a: any) => a.status === 'present').length
  const lates = attendanceRows.filter((a: any) => a.status === 'late').length
  const absents = attendanceRows.filter((a: any) => a.status === 'absent').length

  const cleanReportNote = sanitizeTeacherFeedback(reportNote)

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
            <div className="grid grid-cols-3 gap-3 mb-6">
              <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-3 text-center">
                <div className="text-[11px] text-emerald-800 font-bold">معدل کل ارزیابی‌ها</div>
                <div className="text-xl sm:text-2xl font-black text-emerald-700 mt-1">
                  {gpaVal ? `${toPersianDigits(gpaVal)}` : '—'}
                  <span className="text-xs font-bold text-emerald-600 mr-1">از ۲۰</span>
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

            {/* Grades Table */}
            <div className="overflow-x-auto rounded-xl border border-slate-200 mb-6">
              <table className="w-full border-collapse text-right text-xs sm:text-sm">
                <thead>
                  <tr className="bg-slate-100 text-slate-700 font-black border-b border-slate-200">
                    <th className="py-2.5 px-3 w-12 text-center">ردیف</th>
                    <th className="py-2.5 px-3">عنوان درس و آزمون</th>
                    <th className="py-2.5 px-3 text-center">نمره (از ۲۰)</th>
                    <th className="py-2.5 px-3 text-center">مقیاس توصیفی</th>
                    <th className="no-print py-2.5 px-3 text-center w-28">پاسخنامه</th>
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
                    const hasReview = Boolean(g.matchedExam && g.matchedSub)

                    return (
                      <tr
                        key={g.id || index}
                        className={`hover:bg-slate-50 transition-colors ${
                          hasReview ? 'cursor-pointer' : ''
                        }`}
                        onClick={() => {
                          if (hasReview) {
                            setReviewExamData({
                              exam: g.matchedExam,
                              submission: g.matchedSub,
                            })
                          }
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
                        <td className="py-2.5 px-3 text-center font-black text-sm">
                          <span
                            className={
                              g.scaledScore >= 16
                                ? 'text-emerald-700'
                                : g.scaledScore >= 12
                                ? 'text-amber-700'
                                : 'text-rose-700'
                            }
                          >
                            {toPersianDigits(g.scaledScore)}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-bold border ${g.qualitativeColor}`}
                          >
                            {g.qualitativeStatus}
                          </span>
                        </td>
                        <td className="no-print py-2.5 px-3 text-center">
                          {hasReview ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setReviewExamData({
                                  exam: g.matchedExam,
                                  submission: g.matchedSub,
                                })
                              }}
                              className="px-2.5 py-1 text-[11px] font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-200 transition-colors cursor-pointer inline-flex items-center gap-1"
                            >
                              <span>📋</span>
                              <span>پاسخ‌نامه</span>
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
          onClose={() => setReviewExamData(null)}
        />
      )}
    </div>
  )
}

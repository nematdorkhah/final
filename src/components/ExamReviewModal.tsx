import { useEffect, useMemo, useState } from 'react'
import { toPersianDigits } from '../utils/persianNumbers'
import MathRenderer from './MathRenderer'
import { isExamResultsReleased, StudentExamReviewQuestionItem } from '../utils/examStore'
import {
  resolveCorrectOptionIndex,
  resolveStudentSelectedOption,
  evaluateMultipleChoice,
  evaluateFillInTheBlank,
  safeNumber,
  safeScore,
  safeScaled20,
  getSubmissionEffectiveScore,
} from '../utils/persianSemanticGrader'

interface ExamReviewModalProps {
  exam: any
  submission: any
  onClose: () => void
  onEdit?: () => void
  questionsReview?: StudentExamReviewQuestionItem[]
  scaledScore20Override?: number | null
  forceReleased?: boolean
}

export default function ExamReviewModal({
  exam,
  submission,
  onClose,
  onEdit,
  questionsReview,
  scaledScore20Override,
  forceReleased = false,
}: ExamReviewModalProps) {
  const [filterMode, setFilterMode] = useState<'all' | 'mistakes'>('all')

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (!exam || !submission) {
    return (
      <div
        className="fixed inset-0 z-[99999] bg-slate-900/85 backdrop-blur-sm flex items-center justify-center p-3.5"
        dir="rtl"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div
          className="bg-white rounded-2xl w-full max-w-md p-6 text-center border-2 border-slate-900 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-4xl mb-2.5">📄</div>
          <h3 className="text-base font-black text-slate-900 mb-2">پاسخ‌نامه قابل نمایش نیست</h3>
          <p className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-4">
            {!exam
              ? 'اطلاعات سؤالات این آزمون یافت نشد.'
              : 'پاسخ ثبت‌شده دانش‌آموز برای این آزمون در دسترس نیست.'}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-black cursor-pointer"
          >
            بستن پنجره
          </button>
        </div>
      </div>
    )
  }

  const isReleased = forceReleased || isExamResultsReleased(exam, submission)
  if (!isReleased) {
    const questionsList: any[] = exam.questions || []
    const answersList: Record<string, any> = submission.answers || {}
    const answeredCount = Object.keys(answersList).length
    const totalCount = questionsList.length
    const subTime = submission?.submittedAt
      ? new Date(submission.submittedAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })
      : 'ثبت‌شده'

    return (
      <div
        className="fixed inset-0 z-[99999] bg-slate-900/85 backdrop-blur-sm flex items-center justify-center p-3.5"
        dir="rtl"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div
          className="bg-white rounded-2xl w-full max-w-lg p-6 shadow-2xl text-center border-2 border-slate-900"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-5xl mb-3">🔒</div>
          <span className="inline-block bg-amber-100 text-amber-900 px-3.5 py-1.5 rounded-full text-xs font-black mb-3 border border-amber-300">
            ⏳ نتیجه هنوز منتشر نشده است
          </span>
          <h3 className="text-lg font-black text-slate-900 mb-2">
            نتیجه این آزمون هنوز توسط آموزگار تأیید و منتشر نشده است
          </h3>
          <p className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-4">
            پاسخ‌های شما برای {toPersianDigits(totalCount)} سؤال در ساعت {toPersianDigits(subTime)} ثبت شده است. پس از تأیید و انتشار نتیجه توسط آموزگار، سؤالات، پاسخ درست و توضیحات در همین بخش نمایش داده خواهد شد.
          </p>
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 mb-4 text-xs font-bold text-slate-700">
            تعداد پاسخ‌های ثبت‌شده:{' '}
            <strong>
              {toPersianDigits(answeredCount)} از {toPersianDigits(totalCount)} سؤال
            </strong>
          </div>
          <div className="flex gap-2.5">
            {onEdit && (
              <button
                type="button"
                onClick={() => {
                  onClose()
                  onEdit()
                }}
                className="flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-black cursor-pointer inline-flex items-center justify-center gap-1.5"
              >
                <span>✏️</span>
                <span>ویرایش پاسخ‌ها</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-black cursor-pointer"
            >
              متوجه شدم و بازگشت
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Calculate authoritative effective score strictly scaled to 20: (earned / total) * 20
  const eff = getSubmissionEffectiveScore(exam, submission)
  const scaledScore =
    scaledScore20Override !== null && scaledScore20Override !== undefined
      ? safeScaled20(scaledScore20Override, 20)
      : eff.scaledScore20

  const questions: any[] = Array.isArray(exam.questions) ? exam.questions : []
  const answers: Record<string, any> = submission.answers || {}

  const reviewById = useMemo(() => {
    const map = new Map<string, StudentExamReviewQuestionItem>()
    if (Array.isArray(questionsReview)) {
      for (const item of questionsReview) {
        if (item?.question_id) map.set(String(item.question_id), item)
      }
    }
    return map
  }, [questionsReview])

  const evaluatedQuestions = useMemo(() => {
    return questions.map((rawQ, idx) => {
      const reviewItem = reviewById.get(String(rawQ?.id || ''))
      const q = reviewItem
        ? {
            ...rawQ,
            correctAnswer:
              rawQ.correctAnswer !== undefined && rawQ.correctAnswer !== null
                ? rawQ.correctAnswer
                : reviewItem.correct_answer,
            explanation: rawQ.explanation || reviewItem.explanation || rawQ.solution || rawQ.rubricOrHint || '',
            options: Array.isArray(rawQ.options) && rawQ.options.length > 0 ? rawQ.options : reviewItem.options,
          }
        : rawQ

      const rawAns =
        answers[q.id] !== undefined ? answers[q.id] : reviewItem?.student_answer
      const isMultiChoice = q.type === 'multiple_choice' || (Array.isArray(q.options) && q.options.length > 0)
      const qPoints = safeScore(q.points ?? reviewItem?.max_points, 10, 1)

      const resolvedCorrect = resolveCorrectOptionIndex(q)
      const resolvedStudent = resolveStudentSelectedOption(rawAns, q.options)
      const correctOptIndex = resolvedCorrect.isValid ? resolvedCorrect.index : undefined
      const studentOptIndex = resolvedStudent.isValid ? resolvedStudent.index : undefined

      const studentText =
        typeof rawAns === 'object' && rawAns !== null
          ? rawAns.textAnswer || ''
          : typeof rawAns === 'string'
          ? rawAns
          : typeof rawAns === 'number'
          ? String(rawAns)
          : ''

      const studentImage = typeof rawAns === 'object' && rawAns !== null ? rawAns.imageAttachment : undefined

      const mcEval = isMultiChoice ? evaluateMultipleChoice(q, rawAns) : null
      const blankEval = !isMultiChoice ? evaluateFillInTheBlank(q, rawAns) : null

      const isBonusToAll =
        q.id === 'q2'
          ? false
          : Boolean(q.awardFullScoreToAll || q.allOptionsCorrect || q.allAnswersCorrect || q.isBonusToAll)

      const explicitTeacherQ = submission.teacherGrading?.questionScores?.[q.id]
      const effQScore = eff.questionScores?.[q.id]
      const earned = isBonusToAll
        ? qPoints
        : safeScore(
            explicitTeacherQ !== undefined && explicitTeacherQ !== null
              ? explicitTeacherQ
              : reviewItem?.earned_points !== undefined && reviewItem?.earned_points !== null
              ? reviewItem.earned_points
              : effQScore !== undefined && effQScore !== null
              ? effQScore
              : submission.aiGrading?.questionScores?.[q.id] ??
                (isMultiChoice ? mcEval?.score ?? 0 : blankEval?.score ?? 0),
            qPoints
          )

      const hasStudentAnswer = isMultiChoice
        ? studentOptIndex !== undefined
        : Boolean(String(studentText || '').trim() || studentImage)

      const isCorrect = qPoints > 0 ? earned >= qPoints * 0.75 : Boolean(mcEval?.status === 'correct' || blankEval?.status === 'correct')
      const isPartial = !isCorrect && earned > 0
      const isWrong = !isCorrect && !isPartial

      const explanationText = String(
        q.explanation || q.solution || q.rubricOrHint || q.gradingNotes || reviewItem?.explanation || ''
      ).trim()

      const feedbackText = isBonusToAll
        ? 'با تصمیم آموزگار، نمره کامل این سؤال برای همه دانش‌آموزان منظور شده است.'
        : String(
            submission.teacherGrading?.questionFeedbacks?.[q.id] ||
              reviewItem?.feedback ||
              submission.aiGrading?.questionFeedbacks?.[q.id] ||
              ''
          ).trim()

      const correctOptionText =
        isMultiChoice && correctOptIndex !== undefined && Array.isArray(q.options) && q.options[correctOptIndex] !== undefined
          ? `${toPersianDigits(correctOptIndex + 1)}) ${q.options[correctOptIndex]}`
          : null

      const studentOptionText =
        isMultiChoice && studentOptIndex !== undefined && Array.isArray(q.options) && q.options[studentOptIndex] !== undefined
          ? `${toPersianDigits(studentOptIndex + 1)}) ${q.options[studentOptIndex]}`
          : null

      const correctAnswerText = !isMultiChoice
        ? String(q.correctAnswer ?? q.correctOptionText ?? q.rubricOrHint ?? '').trim()
        : correctOptionText

      return {
        q,
        idx,
        isMultiChoice,
        qPoints,
        earned,
        correctOptIndex,
        studentOptIndex,
        studentText,
        studentImage,
        studentOptionText,
        correctOptionText,
        correctAnswerText,
        hasStudentAnswer,
        isCorrect,
        isPartial,
        isWrong,
        explanationText,
        feedbackText,
      }
    })
  }, [questions, reviewById, answers, submission, eff.questionScores])

  const summary = useMemo(() => {
    let correct = 0
    let partial = 0
    let wrong = 0
    for (const item of evaluatedQuestions) {
      if (item.isCorrect) correct++
      else if (item.isPartial) partial++
      else wrong++
    }
    return { correct, partial, wrong, mistakesTotal: wrong + partial }
  }, [evaluatedQuestions])

  const visibleQuestions = useMemo(() => {
    if (filterMode === 'mistakes') {
      return evaluatedQuestions.filter((item) => item.isWrong || item.isPartial)
    }
    return evaluatedQuestions
  }, [evaluatedQuestions, filterMode])

  const safeTotalPoints = safeNumber(exam.totalPoints || exam.totalScore, 20) || 20

  return (
    <div
      className="fixed inset-0 z-[99999] bg-slate-900/85 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4"
      dir="rtl"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden border-2 border-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky Top Header */}
        <div className="px-4 sm:px-5 py-3.5 bg-gradient-to-l from-slate-900 to-slate-800 text-white flex items-center justify-between flex-wrap gap-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <span className="text-2xl shrink-0">📋</span>
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-black text-white truncate">
                سؤالات و پاسخ‌نامه: {toPersianDigits(exam.title)}
              </h3>
              <p className="text-[11px] text-slate-300 mt-0.5 truncate">
                دانش‌آموز: {submission.studentName || 'دانش‌آموز'} • تاریخ ثبت:{' '}
                {submission.submittedAt
                  ? toPersianDigits(new Date(submission.submittedAt).toLocaleDateString('fa-IR'))
                  : '—'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {/* Scaled Score Badge (Strictly out of 20) */}
            <div
              className={`font-black text-xs sm:text-sm px-3.5 py-1.5 rounded-full border ${
                scaledScore >= 16
                  ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                  : scaledScore >= 12
                  ? 'bg-amber-100 text-amber-900 border-amber-300'
                  : 'bg-rose-100 text-rose-900 border-rose-300'
              }`}
            >
              نمره: {toPersianDigits(scaledScore)} از ۲۰
            </div>

            <button
              type="button"
              onClick={onClose}
              className="bg-rose-600 hover:bg-rose-500 text-white px-3.5 py-1.5 rounded-xl text-xs font-black flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors"
              title="خروج و بستن پنجره"
            >
              <span>✕</span>
              <span>بستن</span>
            </button>
          </div>
        </div>

        {/* Mistakes Summary & Filter Bar */}
        {evaluatedQuestions.length > 0 && (
          <div className="px-4 sm:px-5 py-3 bg-slate-100 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shrink-0">
            <div className="flex items-center gap-2 flex-wrap text-xs font-black">
              <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200">
                ✅ درست: {toPersianDigits(summary.correct)}
              </span>
              {summary.partial > 0 && (
                <span className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-800 border border-amber-200">
                  ⚠️ نیمه‌درست: {toPersianDigits(summary.partial)}
                </span>
              )}
              <span
                className={`px-2.5 py-1 rounded-lg border ${
                  summary.wrong > 0
                    ? 'bg-rose-100 text-rose-900 border-rose-300'
                    : 'bg-white text-slate-600 border-slate-200'
                }`}
              >
                ❌ غلط: {toPersianDigits(summary.wrong)}
              </span>
            </div>

            {summary.mistakesTotal > 0 && (
              <div className="flex items-center gap-1.5 bg-white p-1 rounded-xl border border-slate-200 self-start sm:self-auto">
                <button
                  type="button"
                  onClick={() => setFilterMode('all')}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-black transition-colors cursor-pointer ${
                    filterMode === 'all'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  همه سؤالات ({toPersianDigits(evaluatedQuestions.length)})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('mistakes')}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-black transition-colors cursor-pointer ${
                    filterMode === 'mistakes'
                      ? 'bg-rose-600 text-white'
                      : 'text-rose-700 hover:bg-rose-50'
                  }`}
                >
                  ❌ فقط اشتباهات ({toPersianDigits(summary.mistakesTotal)})
                </button>
              </div>
            )}
          </div>
        )}

        {/* Scrollable Questions and Detailed Review */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 flex flex-col gap-4 bg-slate-50">
          {visibleQuestions.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-sm font-bold">
              {evaluatedQuestions.length === 0
                ? 'جزئیات سؤالات این آزمون در دسترس نیست.'
                : 'آفرین! هیچ اشتباهی در این آزمون ثبت نشده است.'}
            </div>
          ) : (
            visibleQuestions.map((item) => {
              const {
                q,
                idx,
                isMultiChoice,
                qPoints,
                earned,
                correctOptIndex,
                studentOptIndex,
                studentText,
                studentImage,
                studentOptionText,
                correctAnswerText,
                hasStudentAnswer,
                isCorrect,
                isPartial,
                isWrong,
                explanationText,
                feedbackText,
              } = item

              const qScaled20 = safeTotalPoints > 0 ? safeScaled20((earned / safeTotalPoints) * 20, 20) : 0

              return (
                <div
                  key={q.id || idx}
                  className={`rounded-2xl p-4 border-2 transition-all shadow-2xs ${
                    isWrong
                      ? 'bg-rose-50/40 border-rose-400 ring-1 ring-rose-200'
                      : isPartial
                      ? 'bg-amber-50/30 border-amber-300'
                      : 'bg-white border-emerald-300'
                  }`}
                >
                  {/* Question Header: Number, Correct/Wrong Badge, Question Score */}
                  <div className="flex justify-between items-center mb-3 gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`font-black text-xs rounded-lg px-2.5 py-1 text-white ${
                          isWrong ? 'bg-rose-600' : isPartial ? 'bg-amber-600' : 'bg-slate-900'
                        }`}
                      >
                        سؤال {toPersianDigits(idx + 1)}
                      </span>

                      <span
                        className={`text-xs font-black px-2.5 py-1 rounded-full border ${
                          isCorrect
                            ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                            : isPartial
                            ? 'bg-amber-100 text-amber-900 border-amber-300'
                            : 'bg-rose-100 text-rose-900 border-rose-300'
                        }`}
                      >
                        {isCorrect
                          ? '✅ درست'
                          : isPartial
                          ? '⚠️ نیمه‌درست'
                          : hasStudentAnswer
                          ? '❌ غلط — نیاز به مرور'
                          : '❌ بدون پاسخ'}
                      </span>
                    </div>

                    <div className="text-[11px] font-black text-slate-600 bg-white px-2.5 py-1 rounded-lg border border-slate-200">
                      نمره سؤال: {toPersianDigits(earned)} از {toPersianDigits(qPoints)}
                      {qScaled20 > 0 ? '' : ''}
                    </div>
                  </div>

                  {/* Question Prompt */}
                  <div className="font-extrabold text-sm leading-7 text-slate-900 mb-3 bg-white p-3 rounded-xl border border-slate-200">
                    <MathRenderer text={q.question || q.text || q.questionText || ''} />
                  </div>

                  {/* Multiple Choice Options */}
                  {isMultiChoice && Array.isArray(q.options) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                      {q.options.map((opt: string, oIdx: number) => {
                        const isStudentChoice = studentOptIndex === oIdx
                        const isCorrectOption = correctOptIndex === oIdx

                        let styleClass = 'bg-white border-slate-200 text-slate-700 font-semibold'
                        let badge: string | null = null

                        if (isCorrectOption) {
                          styleClass = 'bg-emerald-50 border-emerald-500 text-emerald-900 font-black'
                          badge = '✅ پاسخ درست'
                        }
                        if (isStudentChoice) {
                          if (isCorrectOption) {
                            badge = '✅ انتخاب شما (درست)'
                          } else {
                            styleClass = 'bg-rose-100/80 border-rose-500 text-rose-950 font-black'
                            badge = '❌ انتخاب شما (غلط)'
                          }
                        }

                        return (
                          <div
                            key={oIdx}
                            className={`px-3 py-2.5 rounded-xl border-2 text-xs sm:text-sm flex items-center justify-between gap-2 ${styleClass}`}
                          >
                            <span>
                              {toPersianDigits(oIdx + 1)}) <MathRenderer text={opt} />
                            </span>
                            {badge && <span className="text-[11px] font-black shrink-0">{badge}</span>}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Explicit Student Answer vs Correct Answer Summary Box (Highlights Mistakes Clearly) */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-3">
                    <div
                      className={`p-3 rounded-xl border text-xs sm:text-sm ${
                        isCorrect
                          ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                          : isPartial
                          ? 'bg-amber-50/70 border-amber-200 text-amber-950'
                          : 'bg-rose-100/70 border-rose-300 text-rose-950'
                      }`}
                    >
                      <div className="font-black text-[11px] mb-1 opacity-85">
                        {isCorrect ? '✅ پاسخ شما:' : '❌ پاسخ شما:'}
                      </div>
                      {isMultiChoice ? (
                        studentOptionText ? (
                          <div className="font-bold">
                            <MathRenderer text={studentOptionText} />
                          </div>
                        ) : (
                          <span className="text-rose-700 font-bold italic">پاسخی انتخاب نشده است</span>
                        )
                      ) : studentText ? (
                        <div className="font-bold">
                          <MathRenderer text={studentText} />
                        </div>
                      ) : (
                        <span className="text-rose-700 font-bold italic">پاسخی ثبت نشده است</span>
                      )}
                      {studentImage && (
                        <div className="mt-2">
                          <img
                            src={studentImage}
                            alt="تصویر پاسخ دانش‌آموز"
                            className="max-w-[220px] max-h-[160px] rounded-lg border border-slate-300"
                          />
                        </div>
                      )}
                    </div>

                    <div className="p-3 rounded-xl border bg-emerald-50 border-emerald-300 text-emerald-950 text-xs sm:text-sm">
                      <div className="font-black text-[11px] text-emerald-800 mb-1">
                        🎯 پاسخ درست:
                      </div>
                      {correctAnswerText ? (
                        <div className="font-black text-emerald-900">
                          <MathRenderer text={correctAnswerText} />
                        </div>
                      ) : (
                        <span className="text-slate-500 font-medium text-xs">
                          تصحیح تشریحی توسط آموزگار
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Explanation / Solution */}
                  {explanationText && (
                    <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-xs text-blue-950 flex items-start gap-2 mb-2">
                      <span className="text-base shrink-0">💡</span>
                      <div className="leading-relaxed">
                        <strong className="font-black">توضیح و راهنمای حل:</strong>{' '}
                        <MathRenderer text={explanationText} />
                      </div>
                    </div>
                  )}

                  {/* Teacher / Grading Feedback */}
                  {feedbackText && feedbackText !== explanationText && (
                    <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-950 flex items-start gap-2">
                      <span className="text-base shrink-0">💬</span>
                      <div className="leading-relaxed">
                        <strong className="font-black">بازخورد آموزشی:</strong> {feedbackText}
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

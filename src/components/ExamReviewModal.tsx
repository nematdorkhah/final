import { useEffect } from 'react'
import { toPersianDigits } from '../utils/persianNumbers'
import MathRenderer from './MathRenderer'
import { isExamResultsReleased } from '../utils/examStore'
import {
  resolveCorrectOptionIndex,
  resolveStudentSelectedOption,
  evaluateFillInTheBlank,
  safeNumber,
  safeScore,
  safeScaled20,
} from '../utils/persianSemanticGrader'

interface ExamReviewModalProps {
  exam: any
  submission: any
  onClose: () => void
}

export default function ExamReviewModal({
  exam,
  submission,
  onClose,
}: ExamReviewModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (!exam || !submission) return null

  const isReleased = isExamResultsReleased(exam, submission)
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
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 99999,
          background: 'rgba(15, 23, 42, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '14px',
          direction: 'rtl',
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div
          style={{
            background: '#FFFFFF',
            borderRadius: 20,
            width: '100%',
            maxWidth: 500,
            padding: '24px',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.45)',
            textAlign: 'center',
            border: '2px solid #0F172A',
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 12 }}>🔒</div>
          <span
            style={{
              display: 'inline-block',
              background: '#FEF3C7',
              color: '#92400E',
              padding: '6px 14px',
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 800,
              marginBottom: 14,
            }}
          >
            ⏳ در انتظار تایید و انتشار آموزگار
          </span>
          <h3 style={{ fontSize: 18, fontWeight: 900, color: '#0F172A', margin: '0 0 10px 0' }}>
            پاسخ شما با موفقیت ثبت شد و در انتظار تایید معلم است
          </h3>
          <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.6, margin: '0 0 16px 0' }}>
            پاسخ‌های شما برای {totalCount} سوال در ساعت {toPersianDigits(subTime)} دریافت شد. به محض پایان زمان آزمون یا انتشار کارنامه توسط معلم کلاس، کلید سوالات و نمره نهایی در این بخش برای شما قابل مشاهده خواهد بود.
          </p>
          <div
            style={{
              background: '#F8FAFC',
              border: '1px solid #E2E8F0',
              borderRadius: 12,
              padding: '12px',
              marginBottom: 18,
              fontSize: 12.5,
              fontWeight: 700,
              color: '#334155',
            }}
          >
            تعداد پاسخ‌های ثبت‌شده: <strong>{toPersianDigits(answeredCount)} از {toPersianDigits(totalCount)} سوال</strong>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: '100%',
              padding: '10px 20px',
              background: '#0F172A',
              color: '#FFFFFF',
              borderRadius: 12,
              fontSize: 14,
              fontWeight: 800,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            متوجه شدم و بازگشت
          </button>
        </div>
      </div>
    )
  }


  // Calculate score scaled to 20
  const maxScore = safeNumber(exam.totalPoints || exam.totalScore, 20) || 20
  const rawScore = safeScore(
    submission?.teacherGrading?.totalScore ??
    submission?.aiGrading?.totalScore ??
    submission?.studentScore ??
    0,
    maxScore
  )
  const scaledScore = safeScaled20(rawScore, maxScore)

  const questions: any[] = exam.questions || []
  const answers: Record<string, any> = submission.answers || {}

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: 'rgba(15, 23, 42, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '14px',
        direction: 'rtl',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          background: '#FFFFFF',
          borderRadius: 20,
          width: '100%',
          maxWidth: 860,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.45)',
          overflow: 'hidden',
          border: '3px solid #0F172A',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky Top Header with prominent Exit (Cross) Button */}
        <div
          style={{
            padding: '14px 20px',
            background: 'linear-gradient(135deg, #0F172A 0%, #1E293B 100%)',
            color: '#FFFFFF',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            borderBottom: '2px solid rgba(255,255,255,0.1)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 24 }}>📋</span>
            <div style={{ minWidth: 0 }}>
              <h3
                style={{
                  margin: 0,
                  fontSize: 16,
                  fontWeight: 900,
                  color: '#FFFFFF',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                ریزنمرات و پاسخنامه: {toPersianDigits(exam.title)}
              </h3>
              <p style={{ margin: '2px 0 0 0', fontSize: 11.5, color: '#94A3B8' }}>
                دانش‌آموز: {submission.studentName || 'دانش‌آموز'} • تاریخ ثبت:{' '}
                {submission.submittedAt
                  ? toPersianDigits(new Date(submission.submittedAt).toLocaleDateString('fa-IR'))
                  : '—'}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            {/* Scaled Score Badge */}
            <div
              style={{
                background: scaledScore >= 16 ? '#DCFCE7' : scaledScore >= 12 ? '#FEF3C7' : '#FEE2E2',
                color: scaledScore >= 16 ? '#166534' : scaledScore >= 12 ? '#B45309' : '#991B1B',
                fontWeight: 900,
                fontSize: 13.5,
                padding: '5px 14px',
                borderRadius: 999,
                border: '1.5px solid',
                borderColor: scaledScore >= 16 ? '#86EFAC' : scaledScore >= 12 ? '#FDE68A' : '#FCA5A5',
              }}
            >
              نمره: {toPersianDigits(scaledScore)} از ۲۰
            </div>

            {/* Prominent Red Exit Button (Top Header, accessible immediately without scrolling) */}
            <button
              type="button"
              onClick={onClose}
              style={{
                background: '#EF4444',
                color: '#FFFFFF',
                border: 'none',
                padding: '6px 14px',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 900,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                boxShadow: '0 2px 10px rgba(239, 68, 68, 0.4)',
                transition: 'all 0.15s ease',
              }}
              title="خروج و بستن پنجره (بدون نیاز به اسکرول)"
            >
              <span style={{ fontSize: 16 }}>✕</span>
              <span>بستن</span>
            </button>

          </div>
        </div>

        {/* Scrollable Questions and Detailed Review */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            background: '#F8FAFC',
          }}
        >
          {questions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 30, color: '#64748B', fontSize: 14 }}>
              جزئیات سوالات این آزمون در دسترس نیست.
            </div>
          ) : (
            questions.map((q, idx) => {
              const rawAns = answers[q.id]
              const isMultiChoice = q.type === 'multiple_choice' || (Array.isArray(q.options) && q.options.length > 0)
              const qPoints = safeScore(q.points, 10, 2)

              const resolvedCorrect = resolveCorrectOptionIndex(q)
              const resolvedStudent = resolveStudentSelectedOption(rawAns, q.options)
              const correctOptIndex = resolvedCorrect.isValid ? resolvedCorrect.index : undefined
              const studentOptIndex = resolvedStudent.isValid ? resolvedStudent.index : undefined

              const studentText =
                typeof rawAns === 'object' && rawAns !== null
                  ? rawAns.textAnswer || ''
                  : typeof rawAns === 'string'
                  ? rawAns
                  : ''

              const studentImage = typeof rawAns === 'object' && rawAns !== null ? rawAns.imageAttachment : undefined

              // Evaluate correctness
              const isCorrectMC = isMultiChoice && studentOptIndex !== undefined && studentOptIndex === correctOptIndex
              const blankEval = !isMultiChoice ? evaluateFillInTheBlank(q, rawAns) : null
              const isCorrectBlank = blankEval?.status === 'correct'

              // Earned score for question
              const earned = safeScore(
                submission.teacherGrading?.questionScores?.[q.id] ??
                submission.aiGrading?.questionScores?.[q.id] ??
                (isCorrectMC || isCorrectBlank ? qPoints : (blankEval?.score ?? 0)),
                qPoints
              )

              const feedback =
                submission.teacherGrading?.questionFeedbacks?.[q.id] ||
                submission.aiGrading?.questionFeedbacks?.[q.id] ||
                blankEval?.feedback

              const isPassed = earned >= qPoints * 0.75
              const isPartial = earned > 0 && earned < qPoints * 0.75

              return (
                <div
                  key={q.id || idx}
                  style={{
                    background: '#FFFFFF',
                    borderRadius: 14,
                    padding: 16,
                    border: '2px solid',
                    borderColor: isPassed ? '#86EFAC' : isPartial ? '#FDE68A' : '#FECACA',
                    boxShadow: '0 2px 6px rgba(0,0,0,0.03)',
                  }}
                >
                  {/* Question Header: Number, Points, Status */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      marginBottom: 12,
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span
                        style={{
                          fontWeight: 900,
                          fontSize: 13,
                          background: '#0F172A',
                          color: '#FFFFFF',
                          borderRadius: 8,
                          padding: '3px 10px',
                        }}
                      >
                        سوال {toPersianDigits(idx + 1)}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#64748B' }}>
                        (بارم: {toPersianDigits(qPoints)} نمره)
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 900,
                          padding: '3px 10px',
                          borderRadius: 999,
                          background: isPassed ? '#DCFCE7' : isPartial ? '#FEF3C7' : '#FEE2E2',
                          color: isPassed ? '#166534' : isPartial ? '#B45309' : '#991B1B',
                        }}
                      >
                        نمره کسب‌شده: {toPersianDigits(earned)} از {toPersianDigits(qPoints)}
                      </span>
                    </div>
                  </div>

                  {/* Question Prompt */}
                  <div
                    style={{
                      fontWeight: 800,
                      fontSize: 14.5,
                      lineHeight: 1.8,
                      color: '#0F172A',
                      marginBottom: 14,
                      background: '#F8FAFC',
                      padding: '10px 14px',
                      borderRadius: 10,
                      border: '1px solid #E2E8F0',
                    }}
                  >
                    <MathRenderer text={q.question || q.text || q.questionText || ''} />
                  </div>

                  {/* Multiple Choice Options */}
                  {isMultiChoice && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                        gap: 8,
                        marginBottom: 12,
                      }}
                    >
                      {q.options.map((opt: string, oIdx: number) => {
                        const isStudentChoice = studentOptIndex === oIdx
                        const isCorrectOption = correctOptIndex === oIdx

                        let bg = '#F8FAFC'
                        let borderColor = '#CBD5E1'
                        let textColor = '#334155'
                        let badge = null

                        if (isCorrectOption) {
                          bg = '#ECFDF5'
                          borderColor = '#10B981'
                          textColor = '#065F46'
                          badge = '✅ پاسخ صحیح'
                        }
                        if (isStudentChoice) {
                          if (isCorrectOption) {
                            badge = '✅ انتخاب شما (صحیح)'
                          } else {
                            bg = '#FEF2F2'
                            borderColor = '#EF4444'
                            textColor = '#991B1B'
                            badge = '❌ انتخاب شما'
                          }
                        }

                        return (
                          <div
                            key={oIdx}
                            style={{
                              padding: '10px 12px',
                              borderRadius: 10,
                              border: '2px solid',
                              borderColor,
                              background: bg,
                              color: textColor,
                              fontSize: 13,
                              fontWeight: isStudentChoice || isCorrectOption ? 800 : 600,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 6,
                            }}
                          >
                            <span>
                              {toPersianDigits(oIdx + 1)}) <MathRenderer text={opt} />
                            </span>
                            {badge && (
                              <span style={{ fontSize: 11, fontWeight: 900, flexShrink: 0 }}>
                                {badge}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Non-multiple choice: Fill-in or Descriptive */}
                  {!isMultiChoice && (
                    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div
                        style={{
                          padding: '10px 14px',
                          borderRadius: 10,
                          background: studentText ? '#F0FDF4' : '#FEF2F2',
                          border: '1.5px solid',
                          borderColor: studentText ? '#BBF7D0' : '#FECACA',
                          fontSize: 13,
                        }}
                      >
                        <strong style={{ color: '#0F172A' }}>✍️ پاسخ ثبت‌شده شما:</strong>{' '}
                        {studentText ? (
                          <span style={{ color: '#166534', fontWeight: 700 }}>
                            <MathRenderer text={studentText} />
                          </span>
                        ) : (
                          <span style={{ color: '#DC2626', fontStyle: 'italic' }}>پاسخی ثبت نشده است</span>
                        )}
                        {studentImage && (
                          <div style={{ marginTop: 8 }}>
                            <img
                              src={studentImage}
                              alt="تصویر پاسخ دانش‌آموز"
                              style={{ maxWidth: 240, maxHeight: 180, borderRadius: 8, border: '1px solid #CBD5E1' }}
                            />
                          </div>
                        )}
                      </div>

                      {/* Correct answer / Model rubric */}
                      {(q.correctAnswer || q.rubricOrHint) && (
                        <div
                          style={{
                            padding: '10px 14px',
                            borderRadius: 10,
                            background: '#EFF6FF',
                            border: '1.5px solid #BFDBFE',
                            fontSize: 13,
                            color: '#1E40AF',
                          }}
                        >
                          <strong>💡 پاسخ صحیح / راهنمای حل معلم:</strong>{' '}
                          <MathRenderer text={String(q.correctAnswer || q.rubricOrHint || '')} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Feedback / Educational Note */}
                  {feedback && (
                    <div
                      style={{
                        padding: '8px 12px',
                        borderRadius: 8,
                        background: '#FFFBEB',
                        border: '1px solid #FDE68A',
                        fontSize: 12.5,
                        color: '#92400E',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 6,
                      }}
                    >
                      <span style={{ fontSize: 16 }}>💬</span>
                      <div>
                        <strong>توصیه و بازخورد آموزشی:</strong> {feedback}
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

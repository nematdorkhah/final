import React from 'react'
import { WhatsappPosterData } from '../types/whatsappPoster'
import { cleanQuestionForPoster, formatPosterDate } from '../utils/whatsappPosterUtils'
import { toPersianDigits } from '../utils/persianNumbers'
import MathRenderer from './MathRenderer'

interface WhatsappPosterCardProps {
  data: WhatsappPosterData
  cardRef?: React.RefObject<HTMLDivElement | null>
}

export default function WhatsappPosterCard({ data, cardRef }: WhatsappPosterCardProps) {
  const {
    type,
    title,
    subject,
    body,
    questions,
    dueAt,
    createdAt,
    teacherName = 'آموزگار پایه ششم',
    totalPoints,
    durationMinutes,
  } = data

  const typeLabel =
    type === 'homework'
      ? 'تکلیف کلاسی'
      : type === 'exam'
      ? 'آزمون کلاسی'
      : 'اطلاعیه کلاسی'

  return (
    <div
      ref={cardRef}
      data-whatsapp-card="true"
      dir="rtl"
      style={{
        width: '560px',
        maxWidth: '100%',
        margin: '0 auto',
        backgroundColor: '#FFFFFF',
        color: '#0F172A',
        fontFamily: "'Vazirmatn', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        border: '1.5px solid #E2E8F0',
        borderRadius: '16px',
        padding: '24px 22px',
        boxSizing: 'border-box',
        direction: 'rtl',
        textAlign: 'right',
        position: 'relative',
      }}
    >
      {/* ========================================================
          SLIM HEADER
          ======================================================== */}
      <header
        style={{
          borderBottom: '1.5px solid #E2E8F0',
          paddingBottom: '12px',
          marginBottom: '14px',
        }}
      >
        {/* Top Mini Meta Bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '11px',
            color: '#475569',
            fontWeight: 700,
            marginBottom: '6px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ color: '#1E293B', fontWeight: 900 }}>دبستان حضرت قائم (عج)</span>
            <span style={{ color: '#94A3B8' }}>•</span>
            <span>پایه ششم ابتدایی</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {subject && (
              <span
                style={{
                  background: '#F1F5F9',
                  color: '#334155',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  fontWeight: 800,
                  fontSize: '10.5px',
                  border: '1px solid #E2E8F0',
                }}
              >
                {subject}
              </span>
            )}
            <span
              style={{
                background: '#F8FAFC',
                color: '#475569',
                padding: '2px 8px',
                borderRadius: '6px',
                fontWeight: 800,
                fontSize: '10.5px',
                border: '1px solid #E2E8F0',
              }}
            >
              {typeLabel}
            </span>
          </div>
        </div>

        {/* Main Title */}
        <h2
          style={{
            margin: '0',
            fontSize: '16px',
            fontWeight: 900,
            color: '#0F172A',
            lineHeight: 1.5,
          }}
        >
          {toPersianDigits(title)}
        </h2>

        {/* Exam Specific Meta (Duration & Points) */}
        {type === 'exam' && (durationMinutes || totalPoints) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              fontSize: '11px',
              color: '#64748B',
              marginTop: '4px',
              fontWeight: 700,
            }}
          >
            {durationMinutes && (
              <span>⏱️ مدت زمان: {toPersianDigits(durationMinutes)} دقیقه</span>
            )}
            {totalPoints && (
              <span>📊 بارم کل: {toPersianDigits(totalPoints)} نمره</span>
            )}
            {questions && questions.length > 0 && (
              <span>📝 تعداد سوالات: {toPersianDigits(questions.length)}</span>
            )}
          </div>
        )}
      </header>

      {/* ========================================================
          BODY CONTENT
          ======================================================== */}
      <main style={{ minHeight: '120px' }}>
        {/* Description / Text Body */}
        {body && (
          <div
            style={{
              fontSize: '12.5px',
              color: '#334155',
              lineHeight: 1.8,
              fontWeight: 500,
              marginBottom: questions && questions.length > 0 ? '16px' : '0',
              whiteSpace: 'pre-line',
            }}
          >
            <MathRenderer text={cleanQuestionForPoster(body)} />
          </div>
        )}

        {/* Question Items (For Exams or Question-based assignments) */}
        {questions && questions.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
            {questions.map((q, idx) => {
              const cleanedText = cleanQuestionForPoster(q.question)
              const hasOptions = Array.isArray(q.options) && q.options.length > 0

              return (
                <div
                  key={q.id || idx}
                  style={{
                    backgroundColor: '#FAFAFA',
                    border: '1px solid #E2E8F0',
                    borderRadius: '10px',
                    padding: '9px 12px',
                    boxSizing: 'border-box',
                  }}
                >
                  {/* Question Title & Points */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: '8px',
                    }}
                  >
                    <div
                      style={{
                        fontSize: '12.5px',
                        fontWeight: 700,
                        color: '#0F172A',
                        lineHeight: 1.6,
                        flex: 1,
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 900,
                          color: '#1E293B',
                          marginLeft: '6px',
                        }}
                      >
                        {toPersianDigits(idx + 1)}-
                      </span>
                      <MathRenderer text={cleanedText} />
                    </div>

                    {typeof q.points === 'number' && q.points > 0 && (
                      <span
                        style={{
                          fontSize: '10px',
                          color: '#64748B',
                          fontWeight: 700,
                          flexShrink: 0,
                          marginRight: '6px',
                        }}
                      >
                        ({toPersianDigits(q.points)} نمره)
                      </span>
                    )}
                  </div>

                  {/* Multiple Choice Options */}
                  {hasOptions && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns:
                          q.options!.length <= 2 ? 'repeat(2, 1fr)' : 'repeat(2, 1fr)',
                        gap: '6px',
                        marginTop: '8px',
                        paddingTop: '6px',
                        borderTop: '1px solid #F1F5F9',
                      }}
                    >
                      {q.options!.map((opt, optIdx) => {
                        const optLabels = ['الف', 'ب', 'ج', 'د']
                        const label = optLabels[optIdx] || String(optIdx + 1)
                        return (
                          <div
                            key={optIdx}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              fontSize: '11.5px',
                              color: '#334155',
                              fontWeight: 500,
                            }}
                          >
                            <span
                              style={{
                                width: '16px',
                                height: '16px',
                                borderRadius: '4px',
                                border: '1px solid #CBD5E1',
                                backgroundColor: '#FFFFFF',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '9.5px',
                                fontWeight: 800,
                                color: '#475569',
                                flexShrink: 0,
                              }}
                            >
                              {label}
                            </span>
                            <span style={{ lineHeight: 1.4 }}>
                              <MathRenderer text={cleanQuestionForPoster(opt)} />
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Descriptive Solving Guide / Blank space */}
                  {!hasOptions && (
                    <div
                      style={{
                        marginTop: '6px',
                        paddingTop: '4px',
                        borderTop: '1px dashed #E2E8F0',
                        fontSize: '10.5px',
                        color: '#94A3B8',
                        fontWeight: 500,
                      }}
                    >
                      محل پاسخ و محاسبات: __________________________________________________
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </main>

      {/* ========================================================
          SLIM FOOTER
          ======================================================== */}
      <footer
        style={{
          borderTop: '1.5px solid #E2E8F0',
          paddingTop: '11px',
          marginTop: '16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '11px',
          color: '#64748B',
          fontWeight: 600,
        }}
      >
        <div>
          <span>آموزگار: </span>
          <strong style={{ color: '#1E293B' }}>{teacherName}</strong>
        </div>

        {dueAt && (
          <div>
            <span>مهلت تحویل: </span>
            <strong style={{ color: '#0F172A' }}>{formatPosterDate(dueAt)}</strong>
          </div>
        )}

        <div>
          <span>تاریخ: </span>
          <span>{formatPosterDate(createdAt)}</span>
        </div>
      </footer>
    </div>
  )
}

import { useState, useRef } from 'react'
import { WhatsappPosterData } from '../types/whatsappPoster'
import WhatsappPosterCard from './WhatsappPosterCard'
import { exportWhatsappCardToPng, cleanQuestionForPoster } from '../utils/whatsappPosterUtils'

interface WhatsappPosterModalProps {
  isOpen: boolean
  onClose: () => void
  data: WhatsappPosterData | null
}

export default function WhatsappPosterModal({
  isOpen,
  onClose,
  data,
}: WhatsappPosterModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [customTeacherName, setCustomTeacherName] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const [successMsg, setSuccessMsg] = useState('')
  const [err, setErr] = useState('')

  if (!isOpen || !data) return null

  const effectiveTeacherName =
    customTeacherName.trim() || data.teacherName || 'آموزگار پایه ششم'

  const posterData: WhatsappPosterData = {
    ...data,
    teacherName: effectiveTeacherName,
  }

  async function handleDownloadImage() {
    if (!cardRef.current) return
    setIsExporting(true)
    setErr('')
    setSuccessMsg('')
    try {
      const filename = `تکلیف-${data?.subject || 'کلاس'}-${data?.title || 'پوستر'}`
      await exportWhatsappCardToPng(cardRef.current, filename)
      setSuccessMsg('✅ تصویر پوستر با موفقیت و کیفیت بالا (۲ برابر) دانلود شد.')
      setTimeout(() => setSuccessMsg(''), 4000)
    } catch (error: any) {
      console.error('Failed to capture image:', error)
      setErr('خطا در تولید فایل تصویری: ' + (error?.message || 'لطفاً مجدداً امتحان کنید.'))
    } finally {
      setIsExporting(false)
    }
  }

  function handleCopyText() {
    if (!data) return
    const lines: string[] = []
    lines.push(`📚 دبستان حضرت قائم (عج) - پایه ششم`)
    lines.push(`📌 ${data.title}`)
    if (data.subject) lines.push(`🔹 درس: ${data.subject}`)
    if (data.body) lines.push(`\n📝 توضیحات:\n${cleanQuestionForPoster(data.body)}`)

    if (data.questions && data.questions.length > 0) {
      lines.push(`\n❓ سوالات:`)
      data.questions.forEach((q, i) => {
        lines.push(`${i + 1}) ${cleanQuestionForPoster(q.question)}`)
        if (q.options && q.options.length > 0) {
          const optLabels = ['الف', 'ب', 'ج', 'د']
          const optsText = q.options
            .map((opt, idx) => `(${optLabels[idx] || idx + 1}) ${cleanQuestionForPoster(opt)}`)
            .join('  |  ')
          lines.push(`   ${optsText}`)
        }
      })
    }

    if (data.dueAt) lines.push(`\n🗓️ مهلت تحویل: ${data.dueAt}`)
    lines.push(`👨‍🏫 ${effectiveTeacherName}`)

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    })
  }

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 bg-slate-900/65 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto animate-[mobileFadeIn_0.15s_ease-out]"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-slate-200/90 shadow-2xl max-w-2xl w-full max-h-[92vh] flex flex-col overflow-hidden text-right"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-200 bg-slate-50/80">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center text-base">
              📸
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-black text-slate-900">
                خروجی پوستر تصویری واتساپ
              </h3>
              <p className="text-[11px] sm:text-xs text-slate-500 font-medium">
                کارت مینیمال و استاندارد برای اشتراک‌گذاری در کانال و گروه‌های کلاسی
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center text-sm font-bold transition-colors cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Toolbar & Customization */}
        <div className="p-3 sm:p-4 bg-slate-100/60 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <span className="text-xs font-bold text-slate-700 shrink-0">نام آموزگار:</span>
            <input
              type="text"
              value={customTeacherName}
              placeholder="مثلاً: آموزگار پایه ششم"
              onChange={(e) => setCustomTeacherName(e.target.value)}
              className="text-xs font-medium bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 w-full max-w-[200px] focus:outline-hidden focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleCopyText}
              className="text-xs font-bold px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 transition-colors inline-flex items-center gap-1.5 cursor-pointer shadow-2xs"
            >
              <span>{copied ? '✓' : '📋'}</span>
              <span>{copied ? 'متن کپی شد!' : 'کپی متن'}</span>
            </button>

            <button
              type="button"
              disabled={isExporting}
              onClick={handleDownloadImage}
              className={`text-xs font-bold px-4 py-1.5 rounded-lg text-white transition-all shadow-xs inline-flex items-center gap-2 cursor-pointer ${
                isExporting
                  ? 'bg-emerald-400 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-700 active:scale-98'
              }`}
            >
              {isExporting ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>در حال تولید فایل عکس...</span>
                </>
              ) : (
                <>
                  <span>📥</span>
                  <span>دانلود تصویر PNG (کیفیت عالی)</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Alert Messages */}
        {successMsg && (
          <div className="mx-4 mt-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold p-2.5 rounded-xl flex items-center justify-between animate-fadeIn">
            <span>{successMsg}</span>
            <button
              type="button"
              onClick={() => setSuccessMsg('')}
              className="text-emerald-500 hover:text-emerald-700 font-bold px-1"
            >
              ✕
            </button>
          </div>
        )}

        {err && (
          <div className="mx-4 mt-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold p-2.5 rounded-xl flex items-center justify-between">
            <span>{err}</span>
            <button
              type="button"
              onClick={() => setErr('')}
              className="text-rose-500 hover:text-rose-700 font-bold px-1"
            >
              ✕
            </button>
          </div>
        )}

        {/* Card Live Preview Area */}
        <div className="p-4 sm:p-6 overflow-y-auto bg-slate-100 flex items-center justify-center">
          <div className="w-full flex justify-center">
            <WhatsappPosterCard data={posterData} cardRef={cardRef} />
          </div>
        </div>
      </div>
    </div>
  )
}

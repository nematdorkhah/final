import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { sanitizeFileName } from '../useJalaliDate'

const COMMON_SUBJECTS = [
  'ریاضی',
  'علوم تجربی',
  'فارسی',
  'مطالعات اجتماعی',
  'هدیه‌های آسمان',
  'هوش و استعداد تحلیلی',
]

export default function TextbookManager({
  teacherPassword,
  onChanged,
}: {
  teacherPassword: string
  onChanged?: () => void
}) {
  const [books, setBooks] = useState<any[]>([])
  const [subject, setSubject] = useState('ریاضی')
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadStep, setUploadStep] = useState<string>('')
  const [err, setErr] = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const effectivePassword =
    teacherPassword || sessionStorage.getItem('teacherPassword') || '1234'

  async function loadBooks() {
    try {
      const { data, error } = await supabase.from('textbooks').select('*').order('subject')
      if (error) {
        console.error('Error loading textbooks:', error)
        return
      }
      setBooks(data || [])
    } catch (e) {
      console.error('Exception loading textbooks:', e)
    }
  }

  useEffect(() => {
    loadBooks()
  }, [])

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 بایت'
    const mb = bytes / (1024 * 1024)
    if (mb >= 1) return `${mb.toFixed(1)} مگابایت`
    const kb = bytes / 1024
    return `${kb.toFixed(0)} کیلوبایت`
  }

  function mapUploadError(error: any): string {
    const msg = error?.message || String(error || '')
    if (msg.includes('Invalid key') || msg.includes('InvalidKey')) {
      return 'نام فایل حاوی کاراکترهای ناسازگار با سرور بود. نام فایل اصلاح شد، لطفاً مجدداً امتحان کنید.'
    }
    if (msg.includes('رمز معلم اشتباهه') || msg.includes('رمز')) {
      return 'رمز عبور دسترسی معلم تأیید نشد. لطفاً از پنل خارج شده و دوباره وارد شوید.'
    }
    if (msg.includes('Payload too large') || msg.includes('413') || msg.includes('exceeded')) {
      return 'حجم فایل از حد مجاز سرور (۵۰ مگابایت) بیشتر است. لطفاً نسخه فشرده‌تر فایل را انتخاب کنید.'
    }
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')) {
      return 'خطای اتصال به اینترنت در هنگام ارسال فایل. لطفاً پایداری اتصال خود را بررسی کنید.'
    }
    return `خطا در آپلود: ${msg}`
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setSuccessMsg('')

    if (!subject.trim()) {
      setErr('لطفاً نام درس را مشخص کنید.')
      return
    }
    if (!title.trim()) {
      setErr('لطفاً عنوان کتاب را وارد کنید.')
      return
    }
    if (!file) {
      setErr('لطفاً فایل PDF کتاب را انتخاب کنید.')
      return
    }

    // Validate PDF type
    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) {
      setErr('فرمت فایل نامعتبر است. لطفاً حتماً یک فایل با پسوند PDF. انتخاب فرمایید.')
      return
    }

    // Validate size (50MB Supabase Storage limit)
    if (file.size > 50 * 1024 * 1024) {
      setErr('حجم فایل انتخاب‌شده بیش از ۵۰ مگابایت است. لطفاً یک فایل کم‌حجم‌تر انتخاب فرمایید.')
      return
    }

    setUploading(true)
    setUploadStep('در حال ارسال فایل PDF به سرور ابری...')

    try {
      // 1. Generate ASCII safe storage path to prevent S3 InvalidKey errors
      const safeName = sanitizeFileName(file.name)
      const path = `textbooks/${Date.now()}-${safeName}`

      // 2. Upload file to 'materials' bucket
      const { error: uploadError } = await supabase.storage.from('materials').upload(path, file, {
        contentType: 'application/pdf',
        upsert: true,
      })

      if (uploadError) throw uploadError

      setUploadStep('در حال ثبت مشخصات کتاب در پایگاه داده...')

      // 3. Obtain public URL
      const { data: pub } = supabase.storage.from('materials').getPublicUrl(path)
      const publicUrl = pub?.publicUrl || ''

      if (!publicUrl) {
        throw new Error('آدرس دانلود عمومی فایل ایجاد نشد.')
      }

      // 4. Save to textbooks table via teacher RPC
      const { error: rpcError } = await supabase.rpc('teacher_add_textbook', {
        p_password: effectivePassword,
        p_subject: subject.trim(),
        p_title: title.trim(),
        p_file_path: publicUrl,
      })

      if (rpcError) throw rpcError

      // Success
      setSuccessMsg(`کتاب «${title.trim()}» با موفقیت آپلود و به کتابخانه کلاسی افزوده شد.`)
      setTitle('')
      setFile(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }

      await loadBooks()
      if (onChanged) onChanged()
    } catch (error: any) {
      console.error('Textbook upload failed:', error)
      setErr(mapUploadError(error))
    } finally {
      setUploading(false)
      setUploadStep('')
    }
  }

  async function remove(id: string, bookTitle: string) {
    if (!confirm(`آیا از حذف کتاب «${bookTitle}» از فهرست کتاب‌های مرجع اطمینان دارید؟`)) return
    try {
      const { error } = await supabase.rpc('teacher_delete_textbook', {
        p_password: effectivePassword,
        p_textbook_id: id,
      })
      if (error) throw error
      await loadBooks()
      if (onChanged) onChanged()
    } catch (error: any) {
      alert('خطا در حذف کتاب: ' + (error?.message || 'نامشخص'))
    }
  }

  return (
    <div className="space-y-6 text-right" dir="rtl">
      {/* Header Info */}
      <div className="bg-purple-50/80 border border-purple-200/80 rounded-2xl p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-600 text-white flex items-center justify-center text-xl shrink-0 shadow-xs">
            📖
          </div>
          <div>
            <h3 className="text-sm sm:text-base font-black text-purple-950 mb-1">
              مدیریت و آپلود کتب درسی مرجع
            </h3>
            <p className="text-xs sm:text-sm text-purple-800 leading-relaxed font-medium">
              کتب درسی را با فرمت PDF آپلود کنید تا هوش مصنوعی بتواند سوالات، آزمون‌ها و کاربرگ‌ها را
              دقیقاً منطبق بر سرفصل‌های رسمی کتاب‌های پایه ششم تولید کند.
            </p>
          </div>
        </div>
      </div>

      {/* Upload Form */}
      <form onSubmit={upload} className="bg-slate-50/80 border border-slate-200/90 rounded-2xl p-4 sm:p-5 space-y-4">
        <h4 className="text-sm font-black text-slate-900 flex items-center gap-2">
          <span>➕</span>
          <span>افزودن کتاب جدید</span>
        </h4>

        {/* Subject */}
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1.5">
            درس مربوطه <span className="text-rose-500">*</span>
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {COMMON_SUBJECTS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSubject(s)}
                className={`text-xs font-bold px-2.5 py-1 rounded-lg transition-all ${
                  subject === s
                    ? 'bg-purple-600 text-white shadow-2xs'
                    : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="مثلاً ریاضی، علوم یا نام دلخواه"
            className="w-full text-xs sm:text-sm font-medium bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-800 focus:outline-hidden focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
            required
            disabled={uploading}
          />
        </div>

        {/* Title */}
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1.5">
            عنوان کامل کتاب <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="مثلاً کتاب درسی ریاضی پایه ششم دبستان"
            className="w-full text-xs sm:text-sm font-medium bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-800 focus:outline-hidden focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
            required
            disabled={uploading}
          />
        </div>

        {/* PDF File Picker */}
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1.5">
            فایل PDF کتاب (حداکثر ۵۰ مگابایت) <span className="text-rose-500">*</span>
          </label>
          <div className="relative border-2 border-dashed border-slate-300 hover:border-purple-400 bg-white rounded-xl p-4 transition-all">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              disabled={uploading}
              required
            />
            <div className="text-center pointer-events-none">
              <span className="text-2xl block mb-1">📄</span>
              {file ? (
                <div>
                  <span className="text-xs sm:text-sm font-bold text-purple-700 block truncate max-w-md mx-auto">
                    {file.name}
                  </span>
                  <span className="text-xs text-slate-500 font-medium">
                    حجم: {formatBytes(file.size)}
                  </span>
                </div>
              ) : (
                <div>
                  <span className="text-xs sm:text-sm font-bold text-slate-700 block">
                    کلیک کنید یا فایل PDF را اینجا بکشید و رها کنید
                  </span>
                  <span className="text-[11px] text-slate-400 font-medium">
                    فقط فایل‌های دارای پسوند .pdf تا سقف ۵۰ مگابایت
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Progress Step */}
        {uploading && uploadStep && (
          <div className="bg-purple-100/70 border border-purple-200 text-purple-900 rounded-xl p-3 text-xs font-bold flex items-center gap-2 animate-pulse">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-600 animate-ping shrink-0" />
            <span>{uploadStep}</span>
          </div>
        )}

        {/* Error Message */}
        {err && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-xl p-3 text-xs font-bold flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>⚠️</span>
              <span>{err}</span>
            </div>
            <button
              type="button"
              onClick={() => setErr('')}
              className="text-rose-500 hover:text-rose-700 text-sm font-black px-1"
            >
              ✕
            </button>
          </div>
        )}

        {/* Success Message */}
        {successMsg && (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-3 text-xs font-bold flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>✅</span>
              <span>{successMsg}</span>
            </div>
            <button
              type="button"
              onClick={() => setSuccessMsg('')}
              className="text-emerald-500 hover:text-emerald-700 text-sm font-black px-1"
            >
              ✕
            </button>
          </div>
        )}

        {/* Submit Button */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={uploading}
            className={`w-full sm:w-auto px-6 py-2.5 rounded-xl text-xs sm:text-sm font-bold text-white transition-all shadow-xs flex items-center justify-center gap-2 cursor-pointer ${
              uploading
                ? 'bg-purple-400 cursor-not-allowed'
                : 'bg-purple-600 hover:bg-purple-700 active:scale-98'
            }`}
          >
            {uploading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>در حال آپلود و ثبت...</span>
              </>
            ) : (
              <>
                <span>📤</span>
                <span>افزودن و ذخیره کتاب</span>
              </>
            )}
          </button>
        </div>
      </form>

      {/* Registered Books List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-black text-slate-900 flex items-center gap-2">
            <span>📚</span>
            <span>کتاب‌های ثبت‌شده در سامانه ({books.length})</span>
          </h4>
          <button
            type="button"
            onClick={loadBooks}
            className="text-xs font-bold text-purple-600 hover:text-purple-800 flex items-center gap-1 cursor-pointer"
          >
            <span>🔄</span>
            <span>بروزرسانی</span>
          </button>
        </div>

        {books.length === 0 ? (
          <div className="text-center py-8 bg-slate-50 border border-slate-200 rounded-2xl text-slate-500 text-xs">
            <span className="text-3xl block mb-2">📭</span>
            <span>هنوز کتابی آپلود نشده است. برای شروع، اولین کتاب درسی را اضافه کنید.</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {books.map((b) => (
              <div
                key={b.id}
                className="bg-white border border-slate-200/90 rounded-xl p-3.5 flex items-center justify-between gap-3 hover:border-purple-300 transition-all shadow-2xs"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center text-lg shrink-0">
                    📕
                  </div>
                  <div className="min-w-0">
                    <h5 className="text-xs sm:text-sm font-black text-slate-900 truncate">
                      {b.title}
                    </h5>
                    <span className="inline-block mt-0.5 text-[11px] font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded-md">
                      {b.subject}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {b.file_path && (
                    <a
                      href={b.file_path}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 text-xs font-bold text-slate-500 hover:text-purple-700 bg-slate-100 hover:bg-purple-50 rounded-lg transition-colors"
                      title="مشاهده فایل PDF در زبانه جدید"
                    >
                      👁️
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(b.id, b.title)}
                    className="p-1.5 text-xs font-bold text-slate-400 hover:text-rose-600 bg-slate-100 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                    title="حذف کتاب"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}


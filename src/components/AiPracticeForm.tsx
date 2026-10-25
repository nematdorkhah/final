import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { generatePractice, generateSamplePreview, generateAnnouncement } from '../aiPractice'
import TextbookManager from './TextbookManager'
import TeacherExamBuilder from './TeacherExamBuilder'

export default function AiPracticeForm({
  teacherPassword,
  students = [],
  onDone,
  onCancel,
}: {
  teacherPassword: string
  students?: any[]
  onDone: () => void
  onCancel: () => void
}) {
  const [subTab, setSubTab] = useState<'exam' | 'practice' | 'announcement' | 'books'>('exam')
  const [topic, setTopic] = useState('')
  const [count, setCount] = useState('5')
  const [difficulty, setDifficulty] = useState('medium')
  const [bookId, setBookId] = useState('')
  const [books, setBooks] = useState<any[]>([])

  const [preview, setPreview] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [draft, setDraft] = useState<{ title: string; body: string; type: string } | null>(null)
  const [err, setErr] = useState('')
  const [publishing, setPublishing] = useState(false)

  useEffect(() => {
    supabase.from('textbooks').select('*').order('subject').then(({ data }: any) => setBooks(data || []))
  }, [subTab])

  const selectedBook = books.find((b) => b.id === bookId)

  async function handlePreview() {
    if (!topic.trim()) return
    setErr('')
    setPreviewing(true)
    setPreview('')
    try {
      const text = await generateSamplePreview({ topic: topic.trim(), difficulty, bookUrl: selectedBook?.file_path })
      setPreview(text)
    } catch (error: any) {
      setErr(error.message)
    } finally {
      setPreviewing(false)
    }
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault()
    if (!topic.trim()) return
    setErr('')
    setGenerating(true)
    setDraft(null)
    try {
      if (subTab === 'announcement') {
        const text = await generateAnnouncement({ topic: topic.trim() })
        const lines = text.split('\n').filter((l) => l.trim() !== '')
        setDraft({ title: lines[0]?.trim() || 'اعلان', body: lines.slice(1).join('\n').trim(), type: 'announcement' })
      } else {
        const text = await generatePractice({ topic: topic.trim(), count, difficulty, bookUrl: selectedBook?.file_path })
        const lines = text.split('\n')
        const title = lines[0].trim() || 'تمرین'
        const body = lines.slice(1).join('\n').trim()
        setDraft({ title, body, type: 'homework' })
      }
    } catch (error: any) {
      setErr(error.message)
    } finally {
      setGenerating(false)
    }
  }

  async function handlePublish() {
    if (!draft) return
    setPublishing(true)
    setErr('')
    const { error } = await supabase.rpc('teacher_create_post', {
      p_password: teacherPassword,
      p_type: draft.type,
      p_title: draft.title,
      p_body: draft.body,
      p_due_at: null,
      p_publish_at: new Date().toISOString(),
      p_attachment_path: null,
    })
    setPublishing(false)
    if (error) {
      setErr('خطا: ' + error.message)
      return
    }
    onDone()
  }

  return (
    <div className="w-full max-w-full overflow-hidden box-border text-right">
      {/* Modern Segmented Sub-tabs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2 mb-4 bg-slate-100 p-1.5 rounded-2xl w-full box-border">
        <button
          type="button"
          onClick={() => setSubTab('exam')}
          className={`py-2 px-2.5 rounded-xl text-xs sm:text-sm font-black transition-all flex items-center justify-center text-center cursor-pointer ${
            subTab === 'exam'
              ? 'bg-white text-blue-700 shadow-2xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          📝 آزمون‌ساز هوشمند
        </button>

        <button
          type="button"
          onClick={() => setSubTab('practice')}
          className={`py-2 px-2.5 rounded-xl text-xs sm:text-sm font-black transition-all flex items-center justify-center text-center cursor-pointer ${
            subTab === 'practice'
              ? 'bg-white text-emerald-700 shadow-2xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          📚 تکلیف هوشمند
        </button>

        <button
          type="button"
          onClick={() => setSubTab('announcement')}
          className={`py-2 px-2.5 rounded-xl text-xs sm:text-sm font-black transition-all flex items-center justify-center text-center cursor-pointer ${
            subTab === 'announcement'
              ? 'bg-white text-amber-700 shadow-2xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          📢 نگارش اعلان
        </button>

        <button
          type="button"
          onClick={() => setSubTab('books')}
          className={`py-2 px-2.5 rounded-xl text-xs sm:text-sm font-black transition-all flex items-center justify-center text-center cursor-pointer ${
            subTab === 'books'
              ? 'bg-white text-purple-700 shadow-2xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          📖 کتاب‌های مرجع
        </button>
      </div>

      {/* SUBTAB 1: EXAM BUILDER */}
      {subTab === 'exam' && (
        <TeacherExamBuilder
          teacherPassword={teacherPassword}
          students={students}
          onDone={onDone}
        />
      )}

      {/* SUBTAB 2 & 3: PRACTICE OR ANNOUNCEMENT */}
      {(subTab === 'practice' || subTab === 'announcement') && (
        <div className="w-full max-w-full overflow-hidden box-border bg-white p-4 sm:p-5 rounded-2xl border border-slate-200/90 shadow-2xs">
          <div className="mb-4">
            <h3 className="text-sm sm:text-base font-black text-slate-900 mb-1">
              {subTab === 'practice' ? '✨ تولید هوشمند تمرین و کاربرگ درسی' : '📢 نگارش هوشمند اعلان و اطلاعیه کلاسی'}
            </h3>
            <p className="text-xs text-slate-500">
              موضوع دلخواه خود را بنویسید تا هوش مصنوعی بر اساس کتب درسی پایه ششم آن را نگارش کند.
            </p>
          </div>

          {!draft ? (
            <form onSubmit={handleGenerate} className="flex flex-col gap-3.5 w-full max-w-full box-border">
              <div className="w-full max-w-full box-border">
                <label className="block text-xs sm:text-sm font-bold text-slate-800 mb-1.5">
                  {subTab === 'practice' ? 'موضوع یا مبحث تمرین مد نظر:' : 'موضوع اعلان کلاسی:'}
                </label>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder={
                    subTab === 'practice'
                      ? 'مثلاً: ۱۰ سوال درباره مساحت دایره و محیط آن در پایه ششم، با درجه دشواری مناسب'
                      : 'مثلاً: یادآوری آوردن وسایل آزمایشگاه علوم برای روز یکشنبه'
                  }
                  rows={3}
                  required
                  className="w-full max-w-full box-border p-3 rounded-xl border border-slate-300 text-xs sm:text-sm bg-slate-50 focus:bg-white focus:outline-hidden focus:border-blue-500 transition-colors leading-relaxed"
                />
              </div>

              {subTab === 'practice' && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-full box-border">
                    <div className="w-full min-w-0">
                      <label className="block text-xs font-bold text-slate-700 mb-1">تعداد سؤال</label>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={count}
                        onChange={(e) => setCount(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs sm:text-sm bg-white focus:outline-hidden focus:border-blue-500 box-border"
                      />
                    </div>
                    <div className="w-full min-w-0">
                      <label className="block text-xs font-bold text-slate-700 mb-1">سطح سختی</label>
                      <select
                        value={difficulty}
                        onChange={(e) => setDifficulty(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs sm:text-sm bg-white focus:outline-hidden focus:border-blue-500 box-border cursor-pointer"
                      >
                        <option value="easy">ساده و پایه‌ای</option>
                        <option value="medium">متوسط استاندارد پایه ششم</option>
                        <option value="hard">سخت و تیزهوشانی</option>
                      </select>
                    </div>
                  </div>

                  <div className="w-full max-w-full box-border">
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      کتاب مرجع برای استخراج محتوا (اختیاری):
                    </label>
                    <select
                      value={bookId}
                      onChange={(e) => setBookId(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs sm:text-sm bg-white focus:outline-hidden focus:border-blue-500 box-border cursor-pointer"
                    >
                      <option value="">— بدون پیوست کتاب خاص —</option>
                      {books.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.subject} — {b.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 transition-colors cursor-pointer"
                      onClick={handlePreview}
                      disabled={previewing || !topic.trim()}
                    >
                      {previewing ? 'در حال نگارش نمونه...' : '👀 مشاهده یک سوال نمونه سریع'}
                    </button>
                  </div>

                  {preview && (
                    <div className="bg-slate-50 rounded-xl p-3 text-xs sm:text-sm border border-slate-200 whitespace-pre-wrap leading-relaxed max-w-full overflow-x-auto box-border">
                      {preview}
                    </div>
                  )}
                </>
              )}

              {err && (
                <div className="text-rose-700 bg-rose-50 border border-rose-200 p-2.5 rounded-xl text-xs font-bold">
                  {err}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-2.5 pt-1 w-full max-w-full box-border">
                <button
                  type="submit"
                  className="btn flex-2 py-2.5 px-4 text-xs sm:text-sm font-bold"
                  disabled={generating}
                >
                  {generating
                    ? 'در حال تولید محتوا توسط هوش مصنوعی...'
                    : subTab === 'practice'
                    ? '✨ تولید تمرین کامل و ارسال به کلاس'
                    : '✨ نگارش متن رسمی اعلان'}
                </button>
                <button
                  type="button"
                  className="btn secondary flex-1 py-2.5 px-4 text-xs sm:text-sm font-bold"
                  onClick={onCancel}
                  disabled={generating}
                >
                  انصراف
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-3.5 w-full max-w-full box-border">
              <div className="w-full max-w-full box-border">
                <label className="block text-xs sm:text-sm font-bold text-slate-800 mb-1">عنوان</label>
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs sm:text-sm bg-white focus:outline-hidden focus:border-blue-500 box-border"
                />
              </div>

              <div className="w-full max-w-full box-border">
                <label className="block text-xs sm:text-sm font-bold text-slate-800 mb-1">
                  متن پیشنهادی هوش مصنوعی (قابل ویرایش پیش از انتشار):
                </label>
                <textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={6}
                  className="w-full max-w-full box-border p-3 rounded-xl border border-slate-300 text-xs sm:text-sm leading-relaxed bg-white focus:outline-hidden focus:border-blue-500"
                />
              </div>

              {err && (
                <div className="text-rose-700 bg-rose-50 border border-rose-200 p-2.5 rounded-xl text-xs font-bold">
                  {err}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-2.5 pt-1 w-full max-w-full box-border">
                <button
                  type="button"
                  className="btn flex-2 py-2.5 px-4 text-xs sm:text-sm font-bold"
                  onClick={handlePublish}
                  disabled={publishing}
                >
                  {publishing ? 'در حال ثبت در کلاس...' : '🚀 تایید و انتشار در کلاس'}
                </button>
                <button
                  type="button"
                  className="btn secondary flex-1 py-2.5 px-4 text-xs sm:text-sm font-bold"
                  onClick={() => setDraft(null)}
                  disabled={publishing}
                >
                  🔄 تولید مجدد
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SUBTAB 4: TEXTBOOK MANAGER */}
      {subTab === 'books' && (
        <div className="w-full max-w-full overflow-hidden box-border bg-white p-4 sm:p-5 rounded-2xl border border-slate-200/90 shadow-2xs">
          <TextbookManager teacherPassword={teacherPassword} onChanged={() => {}} />
        </div>
      )}
    </div>
  )
}

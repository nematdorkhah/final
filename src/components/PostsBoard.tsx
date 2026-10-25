import { useState, useMemo } from 'react'
import { supabase } from '../supabaseClient'
import { isItemExpiredForStudent } from '../utils/expiration'
import { toPersianDigits } from '../utils/persianNumbers'
import MathRenderer from './MathRenderer'
import AttachmentViewerModal from './AttachmentViewerModal'
import WhatsappPosterModal from './WhatsappPosterModal'
import { WhatsappPosterData } from '../types/whatsappPoster'

export default function PostsBoard({
  posts,
  emptyText,
  teacherPassword,
  onChanged,
}: {
  posts: any[]
  emptyText?: string
  teacherPassword?: string
  onChanged?: () => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [bodyDraft, setBodyDraft] = useState('')
  const [dueAtDraft, setDueAtDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null)
  const [viewerAttachment, setViewerAttachment] = useState<{ url: string; title: string } | null>(null)
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<{ id: string; title: string } | null>(null)
  const [whatsappModalData, setWhatsappModalData] = useState<WhatsappPosterData | null>(null)

  function handleExportWhatsapp(p: any) {
    const isHw = p.type === 'homework'
    setWhatsappModalData({
      type: isHw ? 'homework' : 'announcement',
      title: p.title || (isHw ? 'تکلیف کلاسی' : 'اطلاعیه کلاسی'),
      subject: p.subject || (isHw ? 'تکلیف روزانه' : 'اطلاعیه'),
      body: p.body || '',
      dueAt: p.due_at || null,
      createdAt: p.publish_at || p.created_at || null,
      teacherName: 'آموزگار پایه ششم',
    })
  }

  // Filter out any internal system records (__SYSTEM_EXAMS__, __EXAM_SUB__, etc.)
  const visiblePosts = useMemo(() => {
    return (posts || []).filter((p) => {
      if (!p) return false
      const title = String(p.title || '')
      if (title.startsWith('__')) return false
      if (title.includes('__SYSTEM_') || title.includes('__EXAM_SUB__')) return false
      if (p.type === 'exam') return false
      if (typeof p.body === 'string' && (p.body.includes('"questions":') || p.body.includes('"examId":'))) {
        try {
          const parsed = JSON.parse(p.body)
          if (parsed.questions || parsed.examId || Array.isArray(parsed)) return false
        } catch {}
      }
      return true
    })
  }, [posts])

  function startEdit(p: any) {
    setEditingId(p.id)
    setTitleDraft(p.title || '')
    setBodyDraft(p.body || '')
    if (p.due_at) {
      const d = new Date(p.due_at)
      if (!isNaN(d.getTime())) {
        const pad = (n: number) => String(n).padStart(2, '0')
        setDueAtDraft(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`)
      } else {
        setDueAtDraft('')
      }
    } else {
      setDueAtDraft('')
    }
    setExpandedPostId(p.id)
  }

  async function saveEdit(postId: string) {
    if (!teacherPassword) {
      alert('رمز عبور آموزگار یافت نشد.')
      return
    }
    setSaving(true)
    try {
      let isoDue: string | null = null
      if (dueAtDraft) {
        const d = new Date(dueAtDraft)
        if (!isNaN(d.getTime())) isoDue = d.toISOString()
      }

      // 1. Direct update to posts table with due_at
      const { error: directErr } = await supabase
        .from('posts')
        .update({ title: titleDraft, body: bodyDraft, due_at: isoDue })
        .eq('id', postId)

      if (directErr) {
        // Fallback to RPC if direct table update encounters RLS
        await supabase.rpc('teacher_update_post', {
          p_password: teacherPassword,
          p_post_id: postId,
          p_title: titleDraft,
          p_body: bodyDraft,
        })
      }

      setEditingId(null)
      if (onChanged) onChanged()
    } catch (err: any) {
      alert('خطا در ذخیره تغییرات: ' + (err?.message || 'مشکل در برقراری ارتباط'))
    } finally {
      setSaving(false)
    }
  }

  function promptDelete(postId: string, postTitle: string) {
    if (!teacherPassword) {
      alert('رمز عبور آموزگار در نشست فعلی ثبت نشده است. لطفاً یک‌بار از پنل خارج و مجدداً وارد شوید.')
      return
    }
    setDeleteConfirmTarget({ id: postId, title: postTitle })
  }

  async function executeDelete(postId: string) {
    setDeletingId(postId)
    try {
      let deleted = false

      // 1. First call server-side delete endpoint
      try {
        const res = await fetch('/api/teacher/delete-post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teacherPassword, postId }),
        })
        const data = await res.json()
        if (data && data.success) {
          deleted = true
        }
      } catch (errServer) {
        console.warn('Server delete endpoint error:', errServer)
      }

      // 2. Direct client-side fallbacks if server wasn't reachable
      if (!deleted) {
        try {
          await supabase.from('submissions').delete().eq('post_id', postId)
        } catch (e) {
          // ignore
        }

        const rpcResult = await supabase.rpc('teacher_delete_post', {
          p_password: teacherPassword,
          p_post_id: postId,
        })

        if (rpcResult.error) {
          const directResult = await supabase.from('posts').delete().eq('id', postId)
          if (directResult.error) {
            throw new Error(directResult.error.message || rpcResult.error.message)
          }
        }
      }

      // 3. Immediately refresh page state
      setDeleteConfirmTarget(null)
      if (expandedPostId === postId) setExpandedPostId(null)
      if (editingId === postId) setEditingId(null)
      if (onChanged) onChanged()
    } catch (err: any) {
      console.error('Delete post failed:', err)
      alert('خطا در حذف تکلیف: ' + (err?.message || 'مشکل در برقراری ارتباط'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-3.5">
      {visiblePosts.length === 0 && (
        <div className="bg-white border border-slate-200/80 rounded-2xl p-8 text-center shadow-xs">
          <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-2xl shadow-2xs">
            📢
          </div>
          <h4 className="text-sm font-black text-slate-800 mb-1">
            {emptyText || 'هنوز اطلاعیه‌ای ثبت نشده است'}
          </h4>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            پیام‌ها، بخشنامه‌ها و نکات آموزشی آموزگار محترم در این بخش قرار می‌گیرد.
          </p>
        </div>
      )}

      {visiblePosts.map((p) => {
        const isExpired = isItemExpiredForStudent(p, 5)
        const isDeleting = deletingId === p.id
        const isExpanded = expandedPostId === p.id || editingId === p.id
        const isHomework = p.type === 'homework'

        // Format creation date nicely
        const createdDate = p.created_at
          ? new Date(p.created_at).toLocaleDateString('fa-IR', {
              month: 'long',
              day: 'numeric',
            })
          : null

        return (
          <div
            key={p.id}
            className={`bg-white border rounded-2xl transition-all duration-200 overflow-hidden ${
              isExpanded
                ? 'border-blue-400 shadow-md ring-2 ring-blue-100/60'
                : 'border-slate-200/80 hover:border-slate-300 hover:shadow-xs'
            }`}
          >
            {/* Header / Clickable summary row */}
            <div
              className="p-4 sm:p-4.5 cursor-pointer select-none flex items-start sm:items-center justify-between gap-3"
              onClick={() => {
                if (editingId === p.id) return
                setExpandedPostId(isExpanded ? null : p.id)
              }}
            >
              {/* Right Side: Category icon, title and quiet metadata */}
              <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                <div
                  className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 text-base sm:text-lg transition-transform ${
                    isHomework
                      ? 'bg-amber-50 text-amber-700 border border-amber-200/60'
                      : 'bg-blue-50 text-blue-700 border border-blue-200/60'
                  }`}
                >
                  {isHomework ? '📐' : '📣'}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span
                      className={`text-[11px] font-black px-2 py-0.5 rounded-md ${
                        isHomework
                          ? 'bg-amber-100/70 text-amber-800'
                          : 'bg-blue-100/70 text-blue-800'
                      }`}
                    >
                      {isHomework ? 'تکلیف درسی' : 'اطلاعیه کلاسی'}
                    </span>

                    {createdDate && (
                      <span className="text-[11px] text-slate-400 font-medium">
                        {toPersianDigits(createdDate)}
                      </span>
                    )}

                    {p.due_at && (
                      <span className="text-[11px] text-rose-600 font-bold bg-rose-50 px-2 py-0.5 rounded-md border border-rose-100">
                        مهلت: {toPersianDigits(new Date(p.due_at).toLocaleDateString('fa-IR'))}
                      </span>
                    )}

                    {teacherPassword && isExpired && (
                      <span className="text-[11px] text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">
                        منقضی شده
                      </span>
                    )}
                  </div>

                  <h3
                    className={`text-sm sm:text-base font-black transition-colors ${
                      isExpanded ? 'text-blue-700' : 'text-slate-900'
                    } ${isExpanded ? 'whitespace-normal' : 'truncate'}`}
                  >
                    {toPersianDigits(p.title)}
                  </h3>

                  {/* Collapsed Snippet */}
                  {!isExpanded && p.body && (
                    <p className="text-xs text-slate-500 truncate mt-1 max-w-xl">
                      {p.body.slice(0, 90)}...
                    </p>
                  )}
                </div>
              </div>

              {/* Left Side: Actions and Expand Indicator */}
              <div className="flex items-center gap-2 shrink-0 self-center">
                {teacherPassword && editingId !== p.id && (
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      title="خروجی عکس واتساپ"
                      onClick={() => handleExportWhatsapp(p)}
                      className="px-2.5 py-1 text-xs font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-300 transition-colors inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span>📸</span>
                      <span className="hidden sm:inline">خروجی عکس واتساپ</span>
                    </button>
                    <button
                      type="button"
                      title="ویرایش"
                      onClick={() => startEdit(p)}
                      className="px-2.5 py-1 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-200 transition-colors inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span>✏️</span>
                      <span className="hidden sm:inline">ویرایش</span>
                    </button>
                    <button
                      type="button"
                      title="حذف"
                      disabled={isDeleting}
                      onClick={() => promptDelete(p.id, p.title)}
                      className="px-2.5 py-1 text-xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg border border-rose-200 transition-colors inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span>{isDeleting ? '⏳' : '🗑️'}</span>
                      <span className="hidden sm:inline">حذف</span>
                    </button>
                  </div>
                )}

                <span
                  className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-lg transition-all ${
                    isExpanded
                      ? 'bg-blue-50 text-blue-700'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200/80'
                  }`}
                >
                  <span className="hidden sm:inline">{isExpanded ? 'بستن' : 'مشاهده'}</span>
                  <span
                    className={`transform transition-transform duration-200 text-xs ${
                      isExpanded ? 'rotate-180' : 'rotate-0'
                    }`}
                  >
                    ▼
                  </span>
                </span>
              </div>
            </div>

            {/* Accordion Expanded Body */}
            {isExpanded && (
              <div className="px-4 pb-4 sm:px-5 sm:pb-5 pt-2 border-t border-slate-100 bg-slate-50/40">
                {editingId === p.id ? (
                  <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-3 shadow-2xs">
                    <div>
                      <label className="block text-xs font-black text-slate-800 mb-1.5">
                        عنوان {isHomework ? 'تکلیف' : 'اعلان'}:
                      </label>
                      <input
                        type="text"
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        className="w-full px-3 py-2 text-sm font-bold border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-black text-slate-800 mb-1.5">
                        متن و شرح:
                      </label>
                      <textarea
                        rows={4}
                        value={bodyDraft}
                        onChange={(e) => setBodyDraft(e.target.value)}
                        className="w-full px-3 py-2 text-sm leading-relaxed border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-sans"
                      />
                    </div>

                    {isHomework && (
                      <div>
                        <label className="block text-xs font-black text-slate-800 mb-1.5">
                          ⏰ مهلت تحویل:
                        </label>
                        <input
                          type="datetime-local"
                          value={dueAtDraft}
                          onChange={(e) => setDueAtDraft(e.target.value)}
                          className="px-3 py-2 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                      </div>
                    )}

                    <div className="flex items-center gap-2 pt-2">
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => saveEdit(p.id)}
                        className="px-4 py-2 text-xs font-black text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-xs transition-colors cursor-pointer"
                      >
                        {saving ? 'در حال ذخیره...' : '💾 ذخیره تغییرات'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="px-4 py-2 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                      >
                        انصراف
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Formatted body */}
                    {p.body && (
                      <div className="text-xs sm:text-sm text-slate-700 leading-relaxed bg-white p-4 rounded-xl border border-slate-200/80 shadow-2xs">
                        <MathRenderer text={p.body} />
                      </div>
                    )}

                    {/* Due date banner */}
                    {p.due_at && (
                      <div className="flex items-center gap-2 text-xs font-bold text-rose-700 bg-rose-50 px-3 py-2 rounded-lg border border-rose-100">
                        <span>⏰</span>
                        <span>
                          آخرین مهلت تحویل: {toPersianDigits(new Date(p.due_at).toLocaleString('fa-IR'))}
                        </span>
                      </div>
                    )}

                    {/* Attachment preview / download card */}
                    {p.attachment_path && (
                      <div className="pt-1">
                        <div className="inline-flex items-center justify-between gap-3 bg-blue-50/80 border border-blue-200/80 rounded-xl p-3 text-xs">
                          <div className="flex items-center gap-2.5">
                            <span className="text-xl">📎</span>
                            <div>
                              <div className="font-black text-blue-950">فایل پیوست آموزگار</div>
                              <div className="text-[11px] text-blue-700 font-medium mt-0.5">
                                برای بزرگنمایی، مطالعه یا دریافت کلیک کنید
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setViewerAttachment({
                                url: p.attachment_path,
                                title: p.title || 'پیوست اطلاعیه',
                              })
                            }}
                            className="px-3.5 py-1.5 text-xs font-black text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-2xs transition-colors cursor-pointer whitespace-nowrap"
                          >
                            مشاهده فایل 👁️
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Attachment Viewer Modal */}
      {viewerAttachment && (
        <AttachmentViewerModal
          url={viewerAttachment.url}
          title={viewerAttachment.title}
          onClose={() => setViewerAttachment(null)}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmTarget && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-[mobileFadeIn_0.2s_ease-out]"
          onClick={() => {
            if (!deletingId) setDeleteConfirmTarget(null)
          }}
        >
          <div
            className="bg-white rounded-2xl max-w-sm w-full p-6 text-center shadow-xl border border-slate-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-12 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center text-2xl mx-auto mb-3 shadow-2xs">
              🗑️
            </div>
            <h3 className="text-base font-black text-slate-900 mb-2">
              آیا از حذف این مورد اطمینان دارید؟
            </h3>
            <p className="text-xs text-slate-500 leading-relaxed mb-5">
              مورد <strong className="text-slate-800">«{deleteConfirmTarget.title || 'بدون عنوان'}»</strong> حذف خواهد شد.
            </p>
            <div className="flex gap-2.5">
              <button
                type="button"
                disabled={Boolean(deletingId)}
                onClick={() => setDeleteConfirmTarget(null)}
                className="flex-1 py-2 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
              >
                انصراف
              </button>
              <button
                type="button"
                disabled={Boolean(deletingId)}
                onClick={() => executeDelete(deleteConfirmTarget.id)}
                className="flex-1 py-2 text-xs font-black text-white bg-rose-600 hover:bg-rose-700 rounded-xl shadow-xs transition-colors cursor-pointer"
              >
                {deletingId ? 'در حال حذف...' : 'بله، حذف شود'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* WhatsApp Visual Poster Modal */}
      <WhatsappPosterModal
        isOpen={Boolean(whatsappModalData)}
        onClose={() => setWhatsappModalData(null)}
        data={whatsappModalData}
      />
    </div>
  )
}

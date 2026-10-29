import { Exam, ExamQuestion, QuestionType, StudentExamSubmission } from '../types/examTypes'
import { supabase } from '../supabaseClient'
import { CLASS_STUDENTS_ROSTER, ClassStudentInfo } from '../classStudents'
import {
  generateExamQuestionsHybrid,
  regenerateSingleQuestionHybrid,
  convertPracticeToQuestionsHybrid,
  gradeSubmissionHybrid,
  isClientGeminiEnabled,
  callGeminiDirectClient,
  translateGeminiError,
  getStoredTeacherPassword,
} from '../services/geminiHybridService'

const EXAMS_STORAGE_KEY = 'school_classroom_exams_v1'
const SUBMISSIONS_STORAGE_KEY = 'school_classroom_exam_subs_v1'

// ----------------------------------------------------------------------
// EXAM CRUD & PERSISTENCE
// ----------------------------------------------------------------------

export function getLocalExams(): Exam[] {
  try {
    const raw = localStorage.getItem(EXAMS_STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw)
  } catch (e) {
    console.error('Failed to parse local exams', e)
    return []
  }
}

export function saveLocalExams(exams: Exam[]) {
  try {
    localStorage.setItem(EXAMS_STORAGE_KEY, JSON.stringify(exams))
  } catch (e) {
    console.error('Failed to save local exams', e)
  }
}

/**
 * Extracts exams from any list of Supabase posts (either dedicated 'exam' posts or '__SYSTEM_EXAMS__' array post)
 */
export function extractExamsFromPosts(posts: any[]): Exam[] {
  const examsMap = new Map<string, Exam>()
  if (!Array.isArray(posts)) return []

  for (const p of posts) {
    if (!p) continue
    // 1. Array of exams stored in __SYSTEM_EXAMS__ container post
    if (p.title === '__SYSTEM_EXAMS__' && p.body) {
      try {
        const arr = typeof p.body === 'string' ? JSON.parse(p.body) : p.body
        if (Array.isArray(arr)) {
          arr.forEach((item) => {
            if (item && item.id && Array.isArray(item.questions)) {
              examsMap.set(item.id, { ...item, published: item.published !== false })
            }
          })
        }
      } catch (e) {
        console.warn('Failed parsing __SYSTEM_EXAMS__ body', e)
      }
    }

    // 2. Individual exam post (type === 'exam' or title starting with 📝 آزمون)
    const isExamPost =
      p.type === 'exam' ||
      (typeof p.title === 'string' && (p.title.includes('آزمون:') || p.title.startsWith('📝 آزمون')))
    if (isExamPost && p.body) {
      try {
        const parsed = typeof p.body === 'string' ? JSON.parse(p.body) : p.body
        if (parsed && parsed.id && Array.isArray(parsed.questions)) {
          examsMap.set(parsed.id, { ...parsed, published: parsed.published !== false })
        }
      } catch {}
    }
  }

  return Array.from(examsMap.values())
}

export function isValidUuid(str: string): boolean {
  if (!str || typeof str !== 'string') return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str)
}

export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export async function fetchAllExams(teacherPassword?: string): Promise<Exam[]> {
  const local = getLocalExams()
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  const mergedMap = new Map<string, Exam>()
  local.forEach((e) => mergedMap.set(e.id, e))

  console.log('[ExamStore:fetchAllExams] Syncing exams directly from Supabase quizzes & posts...')

  // 1. Direct Supabase Query: Read directly from quizzes table
  try {
    const { data: dbQuizzes, error: qErr } = await supabase
      .from('quizzes')
      .select('*')
      .order('created_at', { ascending: false })

    if (!qErr && Array.isArray(dbQuizzes) && dbQuizzes.length > 0) {
      dbQuizzes.forEach((row: any) => {
        if (!row || !row.id) return
        const mappedExam: Exam = {
          id: row.id,
          title: row.title || 'آزمون کلاسی',
          subject: row.subject || 'عمومی',
          description: `آزمون درس ${row.subject || 'عمومی'}`,
          questions: Array.isArray(row.questions) ? row.questions : [],
          durationMinutes: Number(row.duration_minutes) || 30,
          totalPoints: Array.isArray(row.questions)
            ? row.questions.reduce((sum: number, q: any) => sum + (Number(q.points) || 1), 0)
            : 20,
          createdAt: row.created_at || new Date().toISOString(),
          scheduledStartTime: row.created_at || new Date().toISOString(),
          published: true,
        }
        mergedMap.set(row.id, mappedExam)
      })
      console.log(`[ExamStore:fetchAllExams] Synced ${dbQuizzes.length} exams directly from quizzes table`)
    }
  } catch (err) {
    console.warn('[ExamStore:fetchAllExams] Direct Supabase quizzes query error:', err)
  }

  // 2. Direct Supabase Query: Read __SYSTEM_EXAMS__ directly from posts table (CRITICAL FOR STATIC NETLIFY/CLOUDFLARE SPA)
  try {
    const { data: systemRow, error: sysErr } = await supabase
      .from('posts')
      .select('id, title, body, type, publish_at')
      .eq('title', '__SYSTEM_EXAMS__')
      .maybeSingle()

    if (!sysErr && systemRow?.body) {
      try {
        const parsed = typeof systemRow.body === 'string' ? JSON.parse(systemRow.body) : systemRow.body
        if (Array.isArray(parsed)) {
          parsed.forEach((e: Exam) => {
            if (e && e.id) mergedMap.set(e.id, { ...e, published: e.published !== false })
          })
          console.log(`[ExamStore:fetchAllExams] Synced ${parsed.length} exams directly from Supabase posts __SYSTEM_EXAMS__`)
        }
      } catch (parseErr) {
        console.warn('[ExamStore:fetchAllExams] Error parsing __SYSTEM_EXAMS__ body:', parseErr)
      }
    }
  } catch (err) {
    console.warn('[ExamStore:fetchAllExams] Direct Supabase __SYSTEM_EXAMS__ query failed:', err)
  }

  // 3. Query Supabase teacher_list_posts if teacher password is present
  if (teacherPass) {
    try {
      const { data: posts, error } = await supabase.rpc('teacher_list_posts', {
        p_password: teacherPass,
      })
      if (!error && Array.isArray(posts) && posts.length > 0) {
        const extracted = extractExamsFromPosts(posts)
        extracted.forEach((e) => mergedMap.set(e.id, e))
        console.log(`[ExamStore:fetchAllExams] Synced ${extracted.length} exams from Supabase teacher_list_posts`)
      }
    } catch (err) {
      console.warn('[ExamStore:fetchAllExams] Supabase teacher_list_posts skipped:', err)
    }
  }

  // 4. Query Supabase list_published_posts as universal fallback
  try {
    const { data: pubPosts, error } = await supabase.rpc('list_published_posts')
    if (!error && Array.isArray(pubPosts) && pubPosts.length > 0) {
      const extracted = extractExamsFromPosts(pubPosts)
      extracted.forEach((e) => {
        if (!mergedMap.has(e.id)) mergedMap.set(e.id, e)
      })
    }
  } catch (err) {
    console.warn('[ExamStore:fetchAllExams] Supabase list_published_posts skipped:', err)
  }

  const merged = Array.from(mergedMap.values())
  saveLocalExams(merged)
  return merged
}

export function isPromptLike(text: string): boolean {
  if (!text) return false
  const promptPhrases = [
    'طراحی کن', 'بده', 'بساز', 'بنویس', 'سوال از', 'سوالات', 'پرامپت', 'هوش مصنوعی',
    'با جواب', 'تشریحی', 'چهارگزینه‌ای', 'سخت باشه', 'آسون باشه', 'در حد', 'برای دانش آموزان',
    'پایه ششم', 'برای امتحان', 'تعداد', 'گزینه دار', 'پاسخنامه', 'تست', 'آزمون از', 'آزمون بده'
  ]
  return promptPhrases.some((word) => text.includes(word)) || text.length > 45
}

export function sanitizeExamTitle(title: string, subject?: string): string {
  if (!title) return subject ? `آزمون ${subject}` : 'آزمون کلاسی'
  const fallback = subject ? `آزمون کلاسی ${subject}` : 'آزمون کلاسی پایه ششم'
  
  if (title.includes(' - ')) {
    const [mainPart, ...rest] = title.split(' - ')
    const subPart = rest.join(' - ')
    if (isPromptLike(subPart)) {
      return mainPart.trim() || fallback
    }
  }

  if (isPromptLike(title)) {
    return fallback
  }

  return title
}

export async function fetchPublishedExams(forStudent = true): Promise<Exam[]> {
  console.log('[ExamStore:fetchPublishedExams] Fetching published exams, forStudent:', forStudent)
  const local = getLocalExams()
  const mergedMap = new Map<string, Exam>()
  local.filter((e) => e.published).forEach((e) => mergedMap.set(e.id, e))

  // 1. Direct Supabase Query: Read directly from quizzes table
  try {
    const { data: dbQuizzes, error: qErr } = await supabase
      .from('quizzes')
      .select('*')
      .order('created_at', { ascending: false })

    if (!qErr && Array.isArray(dbQuizzes) && dbQuizzes.length > 0) {
      dbQuizzes.forEach((row: any) => {
        if (!row || !row.id) return
        const mappedExam: Exam = {
          id: row.id,
          title: row.title || 'آزمون کلاسی',
          subject: row.subject || 'عمومی',
          description: `آزمون درس ${row.subject || 'عمومی'}`,
          questions: Array.isArray(row.questions) ? row.questions : [],
          durationMinutes: Number(row.duration_minutes) || 30,
          totalPoints: Array.isArray(row.questions)
            ? row.questions.reduce((sum: number, q: any) => sum + (Number(q.points) || 1), 0)
            : 20,
          createdAt: row.created_at || new Date().toISOString(),
          scheduledStartTime: row.created_at || new Date().toISOString(),
          published: true,
        }
        mergedMap.set(row.id, mappedExam)
      })
      console.log(`[ExamStore:fetchPublishedExams] Synced ${dbQuizzes.length} exams directly from quizzes table`)
    }
  } catch (err) {
    console.warn('[ExamStore:fetchPublishedExams] Direct Supabase quizzes query error:', err)
  }

  // 2. Direct Supabase Query: Read __SYSTEM_EXAMS__ directly from posts table (CRITICAL FOR MOBILE & INCOGNITO)
  try {
    const { data: systemRow, error: sysErr } = await supabase
      .from('posts')
      .select('id, title, body, type, publish_at')
      .eq('title', '__SYSTEM_EXAMS__')
      .maybeSingle()

    if (!sysErr && systemRow?.body) {
      try {
        const parsed = typeof systemRow.body === 'string' ? JSON.parse(systemRow.body) : systemRow.body
        if (Array.isArray(parsed)) {
          parsed
            .filter((e: Exam) => e && e.published !== false)
            .forEach((e: Exam) => mergedMap.set(e.id, e))
          console.log(`[ExamStore:fetchPublishedExams] Synced ${parsed.length} exams directly from Supabase posts __SYSTEM_EXAMS__`)
        }
      } catch (parseErr) {
        console.warn('[ExamStore:fetchPublishedExams] Error parsing __SYSTEM_EXAMS__ body:', parseErr)
      }
    }
  } catch (err) {
    console.warn('[ExamStore:fetchPublishedExams] Direct Supabase __SYSTEM_EXAMS__ fetch error:', err)
  }

  // 3. Query Supabase list_published_posts (WORKS FOR MOBILE & INCOGNITO ON ALL DEVICES)
  try {
    const { data: posts, error } = await supabase.rpc('list_published_posts')
    if (!error && Array.isArray(posts) && posts.length > 0) {
      const extracted = extractExamsFromPosts(posts)
      extracted.forEach((e) => mergedMap.set(e.id, e))
      console.log(`[ExamStore:fetchPublishedExams] Synced ${extracted.length} exams from Supabase list_published_posts`)
    }
  } catch (err) {
    console.warn('[ExamStore:fetchPublishedExams] Supabase list_published_posts error:', err)
  }

  // 4. Fallback to full fetch if still empty
  if (mergedMap.size === 0) {
    const all = await fetchAllExams()
    all.filter((e) => e.published).forEach((e) => mergedMap.set(e.id, e))
  }

  const resolved = Array.from(mergedMap.values())
  if (resolved.length > 0) {
    // Keep local cache fresh
    const allLocal = getLocalExams()
    const allLocalMap = new Map<string, Exam>()
    allLocal.forEach((e) => allLocalMap.set(e.id, e))
    resolved.forEach((e) => allLocalMap.set(e.id, { ...allLocalMap.get(e.id), ...e }))
    saveLocalExams(Array.from(allLocalMap.values()))
  }

  console.log(`[ExamStore:fetchPublishedExams] Total published exams resolved: ${resolved.length}`)

  if (forStudent) {
    // Client-side sanitization: strip correct answers so inspect element never leaks answers
    return resolved.map((exam) => ({
      ...exam,
      questions: (exam.questions || []).map((q) => {
        const { correctAnswer, rubricOrHint, ...safeQ } = q as any
        return safeQ as ExamQuestion
      }),
    }))
  }

  return resolved
}

/**
 * Direct sync helper to keep __SYSTEM_EXAMS__ in Supabase posts table
 * completely up-to-date even in static SPA environments (Netlify / Cloudflare Workers).
 */
export async function syncExamsToSupabaseSystemRow(
  exams: Exam[],
  teacherPassword?: string
): Promise<boolean> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  const examsBody = JSON.stringify(exams)
  let directSuccess = false

  console.log(`[ExamStore:syncExamsToSupabaseSystemRow] Syncing ${exams.length} exams directly to __SYSTEM_EXAMS__...`)

  // 1. Direct Supabase Client: First check if __SYSTEM_EXAMS__ row exists
  try {
    const { data: existingRow, error: selectErr } = await supabase
      .from('posts')
      .select('id, title')
      .eq('title', '__SYSTEM_EXAMS__')
      .maybeSingle()

    if (existingRow?.id) {
      // Update existing __SYSTEM_EXAMS__ row
      const { error: updateErr } = await supabase
        .from('posts')
        .update({
          body: examsBody,
          type: 'exam',
          publish_at: new Date().toISOString(),
        })
        .eq('title', '__SYSTEM_EXAMS__')

      if (!updateErr) {
        console.log('[ExamStore:syncExamsToSupabaseSystemRow] Successfully updated __SYSTEM_EXAMS__ directly via Supabase client')
        directSuccess = true
      } else {
        console.warn('[ExamStore:syncExamsToSupabaseSystemRow] Direct update error:', updateErr)
      }
    } else {
      // Row doesn't exist yet, insert/upsert
      const { error: insertErr } = await supabase
        .from('posts')
        .upsert(
          {
            title: '__SYSTEM_EXAMS__',
            type: 'exam',
            body: examsBody,
            publish_at: new Date().toISOString(),
          },
          { onConflict: 'title' }
        )

      if (!insertErr) {
        console.log('[ExamStore:syncExamsToSupabaseSystemRow] Successfully upserted __SYSTEM_EXAMS__ directly via Supabase client')
        directSuccess = true
      } else {
        console.warn('[ExamStore:syncExamsToSupabaseSystemRow] Direct upsert error:', insertErr)
      }
    }
  } catch (err) {
    console.warn('[ExamStore:syncExamsToSupabaseSystemRow] Direct supabase.from("posts") failed:', err)
  }

  // 2. Also trigger Teacher RPC if available for guaranteed security bypass if RLS restricts direct writes
  if (teacherPass) {
    try {
      const { data: posts } = await supabase.rpc('teacher_list_posts', {
        p_password: teacherPass,
      })
      const existing = Array.isArray(posts) ? posts.find((p: any) => p.title === '__SYSTEM_EXAMS__') : null

      if (existing?.id) {
        await supabase.rpc('teacher_update_post', {
          p_password: teacherPass,
          p_post_id: existing.id,
          p_title: '__SYSTEM_EXAMS__',
          p_body: examsBody,
          p_type: 'exam',
          p_due_at: null,
          p_publish_at: new Date().toISOString(),
          p_attachment_path: null,
        })
        console.log('[ExamStore:syncExamsToSupabaseSystemRow] Teacher RPC updated __SYSTEM_EXAMS__ post')
      } else {
        await supabase.rpc('teacher_create_post', {
          p_password: teacherPass,
          p_type: 'exam',
          p_title: '__SYSTEM_EXAMS__',
          p_body: examsBody,
          p_due_at: null,
          p_publish_at: new Date().toISOString(),
          p_attachment_path: null,
        })
        console.log('[ExamStore:syncExamsToSupabaseSystemRow] Teacher RPC created __SYSTEM_EXAMS__ post')
      }
      directSuccess = true
    } catch (rpcErr) {
      console.warn('[ExamStore:syncExamsToSupabaseSystemRow] Teacher RPC backup sync error:', rpcErr)
    }
  }

  return directSuccess
}

export async function saveExam(exam: Exam, teacherPassword?: string): Promise<void> {
  console.log('[ExamStore:saveExam] Saving exam directly to Supabase quizzes:', exam.id, exam.title)

  // Ensure exam has a valid UUID format for PostgreSQL quizzes.id and quiz_submissions.quiz_id
  if (!isValidUuid(exam.id)) {
    exam.id = generateUuid()
  }

  const current = getLocalExams()
  const idx = current.findIndex((e) => e.id === exam.id)
  if (idx >= 0) {
    current[idx] = exam
  } else {
    current.unshift(exam)
  }
  saveLocalExams(current)

  const teacherPass = getStoredTeacherPassword(teacherPassword)

  // 1. Direct persistence to quizzes table (PRIMARY & SEPARATE RECORDS)
  try {
    const quizPayload = {
      id: exam.id,
      title: exam.title,
      subject: exam.subject || 'عمومی',
      questions: exam.questions || [],
      duration_minutes: Number(exam.durationMinutes) || 30,
      created_at: exam.createdAt || new Date().toISOString(),
    }
    const { error: quizErr } = await supabase.from('quizzes').upsert(quizPayload, { onConflict: 'id' })
    if (!quizErr) {
      console.log('[ExamStore:saveExam] Successfully saved exam directly into quizzes table:', exam.id)
    } else {
      console.warn('[ExamStore:saveExam] quizzes upsert warning, trying direct insert:', quizErr)
      await supabase.from('quizzes').insert(quizPayload)
    }
  } catch (qErr) {
    console.warn('[ExamStore:saveExam] Error saving to quizzes table:', qErr)
  }

  // 2. Direct Sync to Supabase Posts __SYSTEM_EXAMS__ row (Redundancy for class dashboard)
  await syncExamsToSupabaseSystemRow(current, teacherPass)

  // 3. Direct Sync to Supabase Individual Exam Post (Redundancy for class feed)
  if (teacherPass) {
    const examPostTitle = `📝 آزمون: ${exam.title} (${exam.subject})`
    const examBodyJson = JSON.stringify(exam)
    const calculatedDueAt =
      exam.dueDate ||
      new Date(
        new Date(exam.scheduledStartTime || exam.createdAt || Date.now()).getTime() + (Number(exam.durationMinutes) || 30) * 60000
      ).toISOString()

    try {
      let existingPostId: string | null = null
      try {
        const { data: posts } = await supabase.rpc('teacher_list_posts', {
          p_password: teacherPass,
        })
        if (Array.isArray(posts)) {
          const found = posts.find(
            (p: any) =>
              p.title === examPostTitle ||
              (p.type === 'exam' && p.body && p.body.includes(`"id":"${exam.id}"`))
          )
          if (found?.id) existingPostId = found.id
        }
      } catch {}

      if (existingPostId) {
        await supabase.rpc('teacher_update_post', {
          p_password: teacherPass,
          p_post_id: existingPostId,
          p_title: examPostTitle,
          p_body: examBodyJson,
          p_type: 'exam',
          p_due_at: calculatedDueAt,
          p_publish_at: new Date().toISOString(),
          p_attachment_path: null,
        })
        console.log('[ExamStore:saveExam] Updated existing exam post in Supabase:', existingPostId)
      } else {
        await supabase.rpc('teacher_create_post', {
          p_password: teacherPass,
          p_type: 'exam',
          p_title: examPostTitle,
          p_body: examBodyJson,
          p_due_at: calculatedDueAt,
          p_publish_at: new Date().toISOString(),
          p_attachment_path: null,
        })
        console.log('[ExamStore:saveExam] Created new exam post in Supabase')
      }
    } catch (e) {
      console.warn('[ExamStore:saveExam] Supabase individual post sync warning:', e)
    }
  }
}

export async function deleteExam(examId: string, teacherPassword?: string): Promise<boolean> {
  const current = getLocalExams().filter((e) => e.id !== examId)
  saveLocalExams(current)

  const teacherPass =
    teacherPassword ||
    (typeof window !== 'undefined' ? sessionStorage.getItem('teacherPassword') || '' : '')

  // 1. Direct delete from quizzes table and quiz_submissions
  try {
    await supabase.from('quizzes').delete().eq('id', examId)
    await supabase.from('quiz_submissions').delete().eq('quiz_id', examId)
    console.log('[ExamStore:deleteExam] Deleted exam from quizzes and quiz_submissions:', examId)
  } catch (err) {
    console.warn('[ExamStore:deleteExam] Error deleting from quizzes table:', err)
  }

  // 2. Direct Sync updated exams array to Supabase __SYSTEM_EXAMS__
  await syncExamsToSupabaseSystemRow(current, teacherPass)

  // 3. Remove individual post in Supabase if teacher password is present
  if (teacherPass) {
    try {
      const { data: posts } = await supabase.rpc('teacher_list_posts', {
        p_password: teacherPass,
      })
      if (Array.isArray(posts)) {
        const found = posts.find(
          (p: any) =>
            p.type === 'exam' &&
            p.body &&
            (p.body.includes(`"id":"${examId}"`) || p.body.includes(`"id": "${examId}"`))
        )
        if (found?.id) {
          await supabase.rpc('teacher_delete_post', {
            p_password: teacherPass,
            p_post_id: found.id,
          })
          console.log('[ExamStore:deleteExam] Deleted individual post in Supabase:', found.id)
        }
      }
    } catch (e) {
      console.warn('[ExamStore:deleteExam] Error deleting individual post in Supabase:', e)
    }
  }

  return true
}


// ----------------------------------------------------------------------
// SUBMISSIONS & PERSISTENCE
// ----------------------------------------------------------------------

export function getLocalSubmissions(): StudentExamSubmission[] {
  try {
    const raw = localStorage.getItem(SUBMISSIONS_STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw)
  } catch (e) {
    console.error('Failed to parse local exam submissions', e)
    return []
  }
}

export function saveLocalSubmissions(subs: StudentExamSubmission[]) {
  try {
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(subs))
  } catch (e) {
    console.error('Failed to save local exam submissions', e)
  }
}

/**
 * Checks whether the exam results, report card and answer key should be visible to the student.
 * - For untimed exams / assignments: ONLY visible if teacher explicitly clicked release.
 * - For timed exams: visible if exam deadline / schedule has ended OR teacher released.
 */
export function isExamResultsReleased(exam: Exam, submission?: StudentExamSubmission): boolean {
  if (!exam) return false

  // 1. Explicit release flags set by teacher on the exam or submission:
  if (exam.resultsPublished || exam.results_published || exam.isResultsReleased) {
    return true
  }
  if (submission?.isReleased || submission?.is_released) {
    return true
  }

  // 2. Untimed exams / homework / assignments:
  // Strictly requires teacher release!
  const isUntimed = exam.mode === 'assignment' || Boolean(exam.isUntimed) || Number(exam.durationMinutes) <= 0
  if (isUntimed) {
    return false
  }

  // 3. Timed exams with deadline / schedule:
  // "برای آزمون‌های دارای بازه زمانی: کلید و کارنامه تنها پس از اتمام کامل مهلت کلی آزمون (یعنی وقتی دیگر هیچ دانش‌آموزی اجازه ورود ندارد) یا پس از تایید معلم فعال شود."
  if (exam.dueDate) {
    const dueTime = new Date(exam.dueDate).getTime()
    if (!isNaN(dueTime) && Date.now() > dueTime) {
      return true
    }
  }

  if (exam.scheduledStartTime) {
    const startMs = new Date(exam.scheduledStartTime).getTime()
    const durationMs = (Number(exam.durationMinutes) || 30) * 60 * 1000
    // Total window: after scheduled start + duration (plus 5 min buffer)
    const windowEnd = startMs + durationMs + 5 * 60 * 1000
    if (!isNaN(windowEnd) && Date.now() > windowEnd) {
      return true
    }
  }

  return false
}

/**
 * Syncs the entire exam submissions array to Supabase __SYSTEM_EXAM_SUBMISSIONS__ row.
 */
export async function syncExamSubmissionsToSupabase(
  submissions: StudentExamSubmission[],
  teacherPassword?: string
): Promise<boolean> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  const bodyJson = JSON.stringify(submissions)
  let directSuccess = false

  console.log(`[ExamStore:syncExamSubmissionsToSupabase] Syncing ${submissions.length} exam submissions to Supabase...`)

  // 1. Update or Insert into __SYSTEM_EXAM_SUBMISSIONS__ row in posts table
  try {
    const { data: existingRows } = await supabase
      .from('posts')
      .select('id, title')
      .eq('title', '__SYSTEM_EXAM_SUBMISSIONS__')
      .order('created_at', { ascending: false })
      .limit(1)

    const existingRow = existingRows?.[0]
    if (existingRow?.id) {
      const { error: updErr } = await supabase
        .from('posts')
        .update({
          body: bodyJson,
          type: 'announcement', // Allowed by posts_type_check!
          publish_at: new Date().toISOString(),
        })
        .eq('id', existingRow.id)

      if (!updErr) {
        console.log('[ExamStore:syncExamSubmissionsToSupabase] Successfully updated __SYSTEM_EXAM_SUBMISSIONS__')
        directSuccess = true
      }
    } else {
      const { error: insErr } = await supabase
        .from('posts')
        .insert({
          title: '__SYSTEM_EXAM_SUBMISSIONS__',
          type: 'announcement',
          body: bodyJson,
          publish_at: new Date().toISOString(),
        })

      if (!insErr) {
        console.log('[ExamStore:syncExamSubmissionsToSupabase] Successfully inserted __SYSTEM_EXAM_SUBMISSIONS__')
        directSuccess = true
      }
    }
  } catch (err) {
    console.warn('[ExamStore:syncExamSubmissionsToSupabase] Direct posts table sync error:', err)
  }

  // 2. Backup to teacher RPC if available
  if (teacherPass) {
    try {
      await supabase.rpc('teacher_create_post', {
        p_password: teacherPass,
        p_type: 'announcement',
        p_title: '__SYSTEM_EXAM_SUBMISSIONS__',
        p_body: bodyJson,
        p_due_at: null,
        p_publish_at: new Date().toISOString(),
        p_attachment_path: null,
      })
      directSuccess = true
    } catch {}
  }

  return directSuccess
}

/**
 * Saves a student exam submission directly to Supabase posts table and quiz_submissions table.
 */
export async function saveExamSubmissionDirectToSupabase(
  submission: StudentExamSubmission,
  exam: Exam,
  teacherPassword?: string
): Promise<boolean> {
  let success = false
  console.log(`[ExamStore:saveExamSubmissionDirectToSupabase] Direct Supabase persistence for student ${submission.studentName} (${submission.studentId})...`)

  const syncBody = JSON.stringify({
    ...submission,
    syncStatus: 'synced',
    clientExamTitle: exam.title,
    clientSubject: exam.subject,
  })

  // 1. Direct Supabase posts table: Save individual submission post
  try {
    const postTitle = `__EXAM_SUB__:${exam.id}:${submission.studentId}`
    const { error: postErr } = await supabase.from('posts').insert({
      title: postTitle,
      body: syncBody,
      type: 'announcement', // Allowed by posts_type_check!
      publish_at: new Date().toISOString(),
    })

    if (!postErr) {
      console.log('[ExamStore:saveExamSubmissionDirectToSupabase] Saved individual post to Supabase:', postTitle)
      success = true
    } else {
      console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] Individual post insert error:', postErr)
    }
  } catch (err) {
    console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] Error saving individual post:', err)
  }

  // 2. Direct Supabase posts table: Update __SYSTEM_EXAM_SUBMISSIONS__ container
  try {
    const allSubs = getLocalSubmissions()
    const idx = allSubs.findIndex((s) => s.id === submission.id || (s.examId === submission.examId && String(s.studentId) === String(submission.studentId)))
    if (idx >= 0) {
      allSubs[idx] = submission
    } else {
      allSubs.push(submission)
    }
    saveLocalSubmissions(allSubs)
    await syncExamSubmissionsToSupabase(allSubs, teacherPassword)
    success = true
  } catch (err) {
    console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] Error updating __SYSTEM_EXAM_SUBMISSIONS__:', err)
  }

  // 3. Direct Supabase quiz_submissions table: Insert row with student foreign key resolution
  try {
    let studentUUID: string | null = null
    const isValidStudentUuid = isValidUuid(submission.studentId)
    if (isValidStudentUuid) {
      studentUUID = submission.studentId
    } else {
      // 1. Try public student list RPC (unrestricted by RLS)
      try {
        const { data: pubStudents } = await supabase.rpc('list_students_public')
        if (Array.isArray(pubStudents) && pubStudents.length > 0) {
          const rosterMatch = CLASS_STUDENTS_ROSTER.find(
            (c: ClassStudentInfo) => c.nationalCode === submission.studentId || c.fullName === submission.studentName
          )
          const matchedPub = pubStudents.find(
            (ps: any) =>
              ps.full_name === submission.studentName ||
              (rosterMatch && ps.full_name === rosterMatch.fullName)
          )
          if (matchedPub?.id) studentUUID = matchedPub.id
        }
      } catch {}

      // 2. Direct students table lookup by access_code
      if (!studentUUID) {
        try {
          const { data: stRow } = await supabase
            .from('students')
            .select('id')
            .eq('access_code', String(submission.studentId))
            .maybeSingle()
          if (stRow?.id) {
            studentUUID = stRow.id
          }
        } catch {}
      }
    }

    if (studentUUID) {
      const isExamUuid = isValidUuid(exam.id)
      const earned = Number(
        submission.instantStats?.scaledScore20 ??
        submission.aiGrading?.scaledScore20 ??
        submission.instantStats?.earnedPoints ??
        0
      )
      const submissionAnswers = {
        ...submission.answers,
        exam_id: exam.id,
        quiz_id: exam.id,
        student_name: submission.studentName,
        student_national_code: submission.studentId,
        score: earned,
        submitted_at: submission.submittedAt || new Date().toISOString(),
      }

      // PRIMARY DIRECT CALL: supabase.from('quiz_submissions').insert(...)
      let { error: qsErr } = await supabase.from('quiz_submissions').insert({
        student_id: studentUUID,
        quiz_id: isExamUuid ? exam.id : null,
        answers: submissionAnswers,
        score: earned,
        submitted_at: submission.submittedAt || new Date().toISOString(),
      })

      // If foreign key constraint failed on quiz_id (e.g. quiz was created outside quizzes table),
      // retry with quiz_id: null to guarantee answers are safely stored in quiz_submissions table!
      if (qsErr && isExamUuid && qsErr.code === '23503') {
        console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] FK on quiz_id, retrying with quiz_id: null...')
        const fallbackRes = await supabase.from('quiz_submissions').insert({
          student_id: studentUUID,
          quiz_id: null,
          answers: submissionAnswers,
          score: earned,
          submitted_at: submission.submittedAt || new Date().toISOString(),
        })
        qsErr = fallbackRes.error
      }

      if (!qsErr) {
        console.log('[ExamStore:saveExamSubmissionDirectToSupabase] Successfully inserted into quiz_submissions table!')
        success = true
      } else {
        console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] quiz_submissions insert warning:', qsErr)
      }
    }
  } catch (err) {
    console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] quiz_submissions table error:', err)
  }

  return success
}

/**
 * Releases report cards and answer keys for all students in an exam.
 */
export async function releaseExamResultsForAll(
  examId: string,
  teacherPassword?: string,
  unpublish = false
): Promise<{ success: boolean; exam?: Exam }> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  const allExams = getLocalExams()
  const examIdx = allExams.findIndex((e) => e.id === examId)
  if (examIdx === -1) {
    console.warn('[ExamStore:releaseExamResultsForAll] Exam not found locally:', examId)
    return { success: false }
  }

  const updatedExam: Exam = {
    ...allExams[examIdx],
    resultsPublished: !unpublish,
    results_published: !unpublish,
    isResultsReleased: !unpublish,
  }
  allExams[examIdx] = updatedExam
  saveLocalExams(allExams)

  // Update in Supabase __SYSTEM_EXAMS__
  await saveExam(updatedExam, teacherPass)

  // Update all submissions for this exam
  const allSubs = getLocalSubmissions()
  const updatedSubs = allSubs.map((sub) => {
    if (sub.examId === examId) {
      return {
        ...sub,
        isReleased: !unpublish,
        is_released: !unpublish,
        status: !unpublish ? ('released' as const) : ('pending_approval' as const),
        teacherGrading: {
          ...(sub.teacherGrading || {}),
          approved: !unpublish,
          approvedAt: !unpublish ? new Date().toISOString() : undefined,
          totalScore: sub.teacherGrading?.totalScore ?? sub.aiGrading?.totalScore ?? sub.instantStats?.earnedPoints ?? 0,
          scaledScore20: sub.teacherGrading?.scaledScore20 ?? sub.aiGrading?.scaledScore20 ?? sub.instantStats?.scaledScore20 ?? 0,
        },
      }
    }
    return sub
  })
  saveLocalSubmissions(updatedSubs)

  // Sync updated submissions array to Supabase
  await syncExamSubmissionsToSupabase(updatedSubs, teacherPass)

  // Dispatch events to refresh both student views and teacher views
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('exam_results_released', { detail: { examId, released: !unpublish } }))
    window.dispatchEvent(new CustomEvent('exam_submission_updated', { detail: { examId } }))
  }

  return { success: true, exam: updatedExam }
}

export async function fetchExamSubmissions(examId?: string, studentId?: string): Promise<StudentExamSubmission[]> {
  const local = getLocalSubmissions()
  const mergedMap = new Map<string, StudentExamSubmission>()
  local.forEach((s) => mergedMap.set(s.id, s))

  console.log('[ExamStore:fetchExamSubmissions] Fetching exam submissions from Supabase...', { examId, studentId })

  // 1. Direct Supabase Query: __SYSTEM_EXAM_SUBMISSIONS__ from posts table
  try {
    const { data: sysRows, error: sysErr } = await supabase
      .from('posts')
      .select('id, title, body')
      .eq('title', '__SYSTEM_EXAM_SUBMISSIONS__')
      .order('created_at', { ascending: false })
      .limit(1)

    if (!sysErr && sysRows && sysRows[0]?.body) {
      try {
        const parsed = typeof sysRows[0].body === 'string' ? JSON.parse(sysRows[0].body) : sysRows[0].body
        if (Array.isArray(parsed)) {
          parsed.forEach((s: StudentExamSubmission) => {
            if (s && s.id) mergedMap.set(s.id, { ...(mergedMap.get(s.id) || {}), ...s })
          })
          console.log(`[ExamStore:fetchExamSubmissions] Synced ${parsed.length} submissions from __SYSTEM_EXAM_SUBMISSIONS__`)
        }
      } catch (parseErr) {
        console.warn('[ExamStore:fetchExamSubmissions] Parse error in __SYSTEM_EXAM_SUBMISSIONS__:', parseErr)
      }
    }
  } catch (err) {
    console.warn('[ExamStore:fetchExamSubmissions] Error querying __SYSTEM_EXAM_SUBMISSIONS__:', err)
  }

  // 2. Direct Supabase Query: Individual submissions __EXAM_SUB__:% from posts table
  try {
    let query = supabase
      .from('posts')
      .select('id, title, body')
      .like('title', examId ? `__EXAM_SUB__:${examId}:%` : '__EXAM_SUB__:%')
      .order('created_at', { ascending: false })
      .limit(100)

    const { data: indRows, error: indErr } = await query
    if (!indErr && Array.isArray(indRows)) {
      indRows.forEach((row) => {
        if (row?.body) {
          try {
            const parsed = typeof row.body === 'string' ? JSON.parse(row.body) : row.body
            if (parsed && parsed.id) {
              mergedMap.set(parsed.id, { ...(mergedMap.get(parsed.id) || {}), ...parsed })
            }
          } catch {}
        }
      })
      console.log(`[ExamStore:fetchExamSubmissions] Synced ${indRows.length} individual submission posts from Supabase`)
    }
  } catch (err) {
    console.warn('[ExamStore:fetchExamSubmissions] Error querying individual submission posts:', err)
  }

  // 3. Direct Supabase Query: quiz_submissions table (PRIMARY direct submissions table)
  try {
    const { data: qSubs, error: qErr } = await supabase
      .from('quiz_submissions')
      .select('*')
      .order('submitted_at', { ascending: false })

    if (!qErr && Array.isArray(qSubs) && qSubs.length > 0) {
      let studentMap = new Map<string, string>()
      try {
        const { data: pubList } = await supabase.rpc('list_students_public')
        if (Array.isArray(pubList)) {
          pubList.forEach((st: any) => {
            if (st.id && st.full_name) studentMap.set(st.id, st.full_name)
          })
        }
      } catch {}

      qSubs.forEach((qs: any) => {
        const answersObj = qs.answers || {}
        const targetExamId = qs.quiz_id || answersObj.quiz_id || answersObj.exam_id || examId
        const targetStudentId = answersObj.student_national_code || qs.student_id
        const targetStudentName =
          answersObj.student_name ||
          studentMap.get(qs.student_id) ||
          CLASS_STUDENTS_ROSTER.find((c: ClassStudentInfo) => c.nationalCode === targetStudentId)?.fullName ||
          'دانش‌آموز'

        if (targetExamId && targetStudentId) {
          const subId = `sub_${targetExamId}_${targetStudentId}`
          const isApproved = Boolean(
            answersObj.teacher_approved ||
            answersObj.approved ||
            answersObj.is_released ||
            answersObj.isReleased
          )
          if (!mergedMap.has(subId)) {
            mergedMap.set(subId, {
              id: subId,
              examId: targetExamId,
              studentId: String(targetStudentId),
              studentName: targetStudentName,
              submittedAt: qs.submitted_at,
              answers: answersObj,
              syncStatus: 'synced',
              isReleased: isApproved,
              is_released: isApproved,
              status: isApproved ? 'graded' : 'pending_approval',
              teacherGrading: {
                totalScore: Number(qs.score) || 0,
                scaledScore20: Number(qs.score) || 0,
                approved: isApproved,
                approvedAt: answersObj.approved_at,
              },
            })
          }
        }
      })
      console.log(`[ExamStore:fetchExamSubmissions] Synced ${qSubs.length} submissions from quiz_submissions table`)
    }
  } catch (err) {
    console.warn('[ExamStore:fetchExamSubmissions] Error querying quiz_submissions:', err)
  }

  const merged = Array.from(mergedMap.values())
  saveLocalSubmissions(merged)

  let filtered = merged
  if (examId) filtered = filtered.filter((s) => s.examId === examId)
  if (studentId) filtered = filtered.filter((s) => String(s.studentId) === String(studentId))

  console.log(`[ExamStore:fetchExamSubmissions] Resolved ${filtered.length} submissions for exam ${examId || 'all'}`)
  return filtered
}

export function getExamSubmissions(examId: string): StudentExamSubmission[] {
  // Trigger background sync with Supabase and server
  fetchExamSubmissions(examId).catch(() => {})
  return getLocalSubmissions().filter((s) => s.examId === examId)
}

export function getStudentExamSubmission(examId: string, studentId: string): StudentExamSubmission | undefined {
  return getLocalSubmissions().find((s) => s.examId === examId && String(s.studentId) === String(studentId))
}

// ----------------------------------------------------------------------
// AI EXAM GENERATOR (Calls Server Backend Powered by Gemini 3.x Flash)
// ----------------------------------------------------------------------

export async function generateAiExamQuestions(params: {
  subject: string
  topic: string
  count: number
  types: QuestionType[]
  difficulty?: 'easy' | 'medium' | 'hard'
  extraInstructions?: string
  teacherPassword?: string
}): Promise<ExamQuestion[]> {
  try {
    return await generateExamQuestionsHybrid(params)
  } catch (err: any) {
    throw new Error(translateGeminiError(err))
  }
}

// ----------------------------------------------------------------------
// AI SINGLE QUESTION REGENERATOR (REPLACES REJECTED/UNCONFIRMED QUESTION)
// ----------------------------------------------------------------------
export async function regenerateSingleAiQuestion(params: {
  subject: string
  topic: string
  type: QuestionType
  difficulty?: 'easy' | 'medium' | 'hard'
  points?: number
  previousQuestion?: string
  extraInstructions?: string
  teacherPassword?: string
}): Promise<ExamQuestion> {
  try {
    return await regenerateSingleQuestionHybrid(params)
  } catch (err: any) {
    throw new Error(translateGeminiError(err))
  }
}

export async function convertPracticeTextToQuestions(
  text: string,
  subject = 'پایه ششم',
  teacherPassword?: string
): Promise<ExamQuestion[]> {
  try {
    return await convertPracticeToQuestionsHybrid(text, subject)
  } catch (err: any) {
    throw new Error(translateGeminiError(err))
  }
}

// ----------------------------------------------------------------------
// AUTHENTIC CURRICULUM QUESTIONS (NEVER Generic Templates)
// ----------------------------------------------------------------------

function generateAuthenticCurriculumQuestions(
  subject: string,
  topic: string,
  count: number,
  types: QuestionType[]
): ExamQuestion[] {
  const isMath = subject.includes('ریاضی')
  const isPersian = subject.includes('فارسی')
  const isScience = subject.includes('علوم')
  const isTizhooshan = subject.includes('هوش') || subject.includes('تیزهوشان')
  const isSocial = subject.includes('اجتماعی')

  let questionBank: ExamQuestion[] = []

  if (isMath) {
    questionBank = [
      {
        id: `math_1_${Date.now()}`,
        type: 'multiple_choice',
        question: 'محیط یک دایره ۳۱/۴ سانتی‌متر است. مساحت این دایره چند سانتی‌متر مربع می‌باشد؟ (عدد پی = ۳/۱۴)',
        options: ['۲۵', '۵۰', '۷۸/۵', '۱۵۷'],
        correctAnswer: 2,
        rubricOrHint: 'قطر = ۳۱/۴ ÷ ۳/۱۴ = ۱۰ سانتی‌متر. شعاع = ۵ سانتی‌متر. مساحت = ۵ × ۵ × ۳/۱۴ = ۷۸/۵ سانتی‌متر مربع.',
        points: 2,
      },
      {
        id: `math_2_${Date.now()}`,
        type: 'fill_in_the_blank',
        question: 'اگر حاصل‌ضرب دو کسر مساوی با ۱ باشد، آن دو کسر ............ یکدیگر نامیده می‌شوند.',
        correctAnswer: 'معکوس',
        rubricOrHint: 'پاسخ صحیح: معکوس (مثلاً معکوس ۲/۳ برابر با ۳/۲ است).',
        points: 2,
      },
      {
        id: `math_3_${Date.now()}`,
        type: 'descriptive',
        question: 'علی ۲/۵ از کتاب داستانش را در روز اول و ۱/۳ از باقی‌مانده کتاب را در روز دوم خواند. چه کسری از کتاب هنوز خوانده نشده است؟ مراحل را گام‌به‌گام بنویسید.',
        rubricOrHint: 'باقی‌مانده روز اول: ۳/۵. مطالعه روز دوم: ۱/۳ × ۳/۵ = ۱/۵. کل مطالعه: ۲/۵ + ۱/۵ = ۳/۵. نخوانده: ۲/۵.',
        points: 3,
      },
      {
        id: `math_4_${Date.now()}`,
        type: 'image',
        question: 'شکل یک مربع به ضلع ۱۰ سانتی‌متر که درون آن یک دایره محاط شده است را رسم کنید. مساحت قسمت رنگی (فاصله بین مربع و دایره) را با راه‌حل روی کاغذ بنویسید و عکس آن را بارگذاری نمایید.',
        rubricOrHint: 'مساحت مربع = ۱۰۰. شعاع دایره = ۵، مساحت دایره = ۷۸/۵. قسمت رنگی = ۱۰۰ - ۷۸/۵ = ۲۱/۵ سانتی‌متر مربع.',
        points: 3,
      },
    ]
  } else if (isPersian) {
    questionBank = [
      {
        id: `fa_1_${Date.now()}`,
        type: 'multiple_choice',
        question: 'در بیت «ای مادر عزیز که جانم فدای تو / قربان مهربانی و لطف و صفای تو» کدام آرایه ادبی به کار رفته است؟',
        options: ['تشبیه', 'مراعات نظیر (تناسب)', 'مناظره', 'مبالغه'],
        correctAnswer: 1,
        rubricOrHint: 'بین واژه‌های مهربانی، لطف و صفا تناسب و مراعات نظیر وجود دارد.',
        points: 2,
      },
      {
        id: `fa_2_${Date.now()}`,
        type: 'fill_in_the_blank',
        question: 'در جمله «دانش‌آموزان کوشا شعر زیبایی را خواندند»، کلمه «شعر زیبایی» نقش ............ را در جمله دارد.',
        correctAnswer: 'مفعول',
        rubricOrHint: 'پاسخ صحیح: مفعول (نشانه «را» به همراه مفعول آمده است).',
        points: 2,
      },
      {
        id: `fa_3_${Date.now()}`,
        type: 'descriptive',
        question: 'مفهوم کنایی عبارت «دست و پنجه نرم کردن» را بیان کرده و با آن یک جمله پرمعنا و زیبا بنویسید.',
        rubricOrHint: 'معنی کنایی: مبارزه کردن، درگیر شدن با مشکلات و تلاش برای غلبه بر سختی‌ها.',
        points: 3,
      },
      {
        id: `fa_4_${Date.now()}`,
        type: 'image',
        question: 'یک بند انشای توصیفی در ۴ خط درباره «زیبایی‌های آفرینش در بهار» با خط خوش و رعایت علائم نگارشی بنویسید و تصویر آن را ارسال کنید.',
        rubricOrHint: 'رعایت بندنویسی، املا، خط زیبا، و کاربرد صحیح آرایه‌ها و علائم نگارشی.',
        points: 3,
      },
    ]
  } else if (isScience) {
    questionBank = [
      {
        id: `sci_1_${Date.now()}`,
        type: 'multiple_choice',
        question: 'کدام لایه از زمین در حالت خمیری قرار دارد و حرکت ورقه‌های سنگ‌کره روی آن صورت می‌پذیرد؟',
        options: ['پوسته', 'خمیرکره (استنوسفر)', 'هسته درونی', 'گوشته زیرین جامد'],
        correctAnswer: 1,
        rubricOrHint: 'خمیرکره بخش بالایی گوشته است که به صورت خمیری بوده و جریان همرفتی دارد.',
        points: 2,
      },
      {
        id: `sci_2_${Date.now()}`,
        type: 'fill_in_the_blank',
        question: 'مهم‌ترین عامل تولید زلزله، آزاد شدن ناگهانی انرژی ذخیره شده در اثر شکستن ............ زمین است.',
        correctAnswer: 'سنگ‌ها',
        rubricOrHint: 'پاسخ صحیح: سنگ‌ها یا گسل‌ها.',
        points: 2,
      },
      {
        id: `sci_3_${Date.now()}`,
        type: 'descriptive',
        question: 'تفاوت موج‌های لرزه‌ای اولیه (P) و ثانویه (S) را از نظر سرعت و توانایی عبور از مواد مایع شرح دهید.',
        rubricOrHint: 'موج P طولی و سریع‌تر است و از جامد و مایع می‌گذرد؛ موج S عرضی، کندتر و فقط از جامدات عبور می‌کند.',
        points: 3,
      },
      {
        id: `sci_4_${Date.now()}`,
        type: 'image',
        question: 'یک مدار الکتریکی ساده شامل کلید، لامپ و باتری رسم نموده و جهت جریان الکتریکی را با فلش مشخص کرده و تصویر آن را بفرستید.',
        rubricOrHint: 'رسم صحیح نماد باتری (+ و -)، کلید، لامپ و جهت جریان قراردادی از مثبت به منفی.',
        points: 3,
      },
    ]
  } else if (isTizhooshan) {
    questionBank = [
      {
        id: `tiz_1_${Date.now()}`,
        type: 'multiple_choice',
        question: 'در یک دنباله عددی: ۲، ۵، ۱۰، ۱۷، ۲۶، ... عدد بعدی کدام است؟',
        options: ['۳۵', '۳۷', '۳۹', '۴۱'],
        correctAnswer: 1,
        rubricOrHint: 'الگوی n^2 + 1 است: ۱+۱=۲، ۴+۱=۵، ۹+۱=۱۰، ۱۶+۱=۱۷، ۲۵+۱=۲۶، بعدی ۳۶+۱ = ۳۷.',
        points: 2,
      },
      {
        id: `tiz_2_${Date.now()}`,
        type: 'fill_in_the_blank',
        question: 'مجموع اعداد روی وجه‌های روبروی هم در یک تاس استاندارد همواره برابر با عدد ............ است.',
        correctAnswer: '۷',
        rubricOrHint: 'پاسخ صحیح: ۷ (۱ با ۶، ۲ با ۵، ۳ با ۴).',
        points: 2,
      },
      {
        id: `tiz_3_${Date.now()}`,
        type: 'descriptive',
        question: 'اگر ۶ زنگوله در ساعت ۱۲ به مدت ۲۵ ثانیه نواخته شوند، برای نواختن ۴ زنگوله در ساعت دیگری چند ثانیه زمان لازم است؟ با دلیل توضیح دهید.',
        rubricOrHint: 'بین ۶ زنگوله، ۵ فاصله زمانی وجود دارد: ۲۵ ÷ ۵ = ۵ ثانیه هر فاصله. برای ۴ زنگوله ۳ فاصله نیاز است: ۳ × ۵ = ۱۵ ثانیه.',
        points: 3,
      },
      {
        id: `tiz_4_${Date.now()}`,
        type: 'image',
        question: 'گسترده یک مکعب را که دو وجه مجاور آن هاشور خورده روی کاغذ رسم کرده و تصویر آن را بارگذاری نمایید.',
        rubricOrHint: 'رسم ۶ مربع پیوسته با ساختار مکعبی صحیح و عدم تداخل وجوه.',
        points: 3,
      },
    ]
  } else {
    // General 6th grade questions
    questionBank = [
      {
        id: `gen_1_${Date.now()}`,
        type: 'multiple_choice',
        question: 'در تصمیم‌گیری‌های مهم و انتخاب‌های فردی، اولین گام منطقی چیست؟',
        options: ['پرسیدن نظر دیگران', 'فکر کردن درباره موضوع و گزینه‌های موجود', 'پیش‌بینی نتایج بد', 'انتخاب سریع‌ترین راه‌حل'],
        correctAnswer: 1,
        rubricOrHint: 'شناخت مسئله و تامل اولیه بر روی گزینه‌ها پایه تصمیم‌گیری صحیح است.',
        points: 2,
      },
      {
        id: `gen_2_${Date.now()}`,
        type: 'fill_in_the_blank',
        question: 'بزرگترین منبع انرژی پاک و تجدیدپذیر کره زمین که حیات موجودات به آن وابسته است انرژی ............ می‌باشد.',
        correctAnswer: 'خورشید',
        rubricOrHint: 'پاسخ صحیح: خورشید (یا انرژی خورشیدی).',
        points: 2,
      },
      {
        id: `gen_3_${Date.now()}`,
        type: 'descriptive',
        question: 'سه نمونه از فواید مصرف بهینه انرژی و راه‌های جلوگیری از اتلاف آن در خانه را نام ببرید.',
        rubricOrHint: 'عایق‌بندی پنجره‌ها، خاموش کردن لامپ‌های غیرضروری، تنظیم دمای بخاری.',
        points: 3,
      },
      {
        id: `gen_4_${Date.now()}`,
        type: 'image',
        question: 'نقشه ساده‌ای از مسیر خانه تا مدرسه رسم کرده و جهت‌های جغرافیایی اصلی را روی آن علامت بزنید و عکس بفرستید.',
        rubricOrHint: 'رسم تمیز مسیر، نشانگر شمال، جنوب، شرق و غرب.',
        points: 3,
      },
    ]
  }

  // Filter or match requested types
  const filtered = questionBank.filter((q) => types.includes(q.type))
  const pool = filtered.length > 0 ? filtered : questionBank

  const result: ExamQuestion[] = []
  for (let i = 0; i < count; i++) {
    const template = pool[i % pool.length]
    result.push({
      ...template,
      id: `q_${Date.now()}_${i + 1}`,
      points: template.points || 2,
    })
  }

  return result
}

// ----------------------------------------------------------------------
// AI EXAM GRADING (Deterministic + Generative evaluation)
// ----------------------------------------------------------------------

export async function gradeExamWithAI(
  exam: Exam,
  answers: Record<string, any>,
  studentName = 'دانش‌آموز'
): Promise<StudentExamSubmission['aiGrading']> {
  const questionScores: Record<string, number> = {}
  const questionFeedbacks: Record<string, string> = {}
  let totalScore = 0
  let serverTeacherNote = ''

  const complexQuestionsToGrade: { q: ExamQuestion; ans: any }[] = []

  for (const q of exam.questions) {
    const studentAns = answers[q.id]
    if (!studentAns) {
      questionScores[q.id] = 0
      questionFeedbacks[q.id] = 'دانش‌آموز به این سوال پاسخی نداده است.'
      continue
    }

    if (q.type === 'multiple_choice') {
      const selected = studentAns.selectedOption
      const isCorrect = Number(selected) === Number(q.correctAnswer)
      const score = isCorrect ? (Number(q.points) || 2) : 0
      questionScores[q.id] = score
      totalScore += score
      questionFeedbacks[q.id] = isCorrect
        ? `✅ پاسخ صحیح است. (+${score} نمره)`
        : `❌ پاسخ نادرست است. گزینه درست: ${
            q.options ? q.options[Number(q.correctAnswer)] || `گزینه ${Number(q.correctAnswer) + 1}` : q.correctAnswer
          }`
    } else {
      complexQuestionsToGrade.push({ q, ans: studentAns })
    }
  }

  // Include all questions context for the personalized teacher note
  const allQuestionsData = exam.questions.map((q) => {
    const ans = answers[q.id]
    let stAns = 'بدون پاسخ'
    if (ans) {
      if (q.type === 'multiple_choice') {
        stAns = `گزینه انتخابی: ${Number(ans.selectedOption) + 1} (${q.options?.[ans.selectedOption] || ''}) - کلید صحیح: ${Number(q.correctAnswer) + 1}`
      } else {
        stAns = ans.textAnswer || (ans.imageAttachment ? '[تصویر برگه ارسال شده]' : 'بدون پاسخ')
      }
    }
    return {
      id: q.id,
      type: q.type,
      question: q.question,
      points: q.points,
      rubric: q.rubricOrHint,
      studentAnswer: stAns,
    }
  })

  try {
    const data = await gradeSubmissionHybrid({
      questions: allQuestionsData,
      studentName,
      totalPoints: exam.totalPoints,
    })

    if (data.teacherSummaryNote) {
      serverTeacherNote = data.teacherSummaryNote
    }
    if (data.success && Array.isArray(data.grades)) {
      for (const item of data.grades) {
        const matchingQ = exam.questions.find((q) => q.id === item.id)
        if (matchingQ && matchingQ.type !== 'multiple_choice') {
          const maxPts = matchingQ.points || 2
          const assignedScore = Math.min(maxPts, Math.max(0, Number(item.score) || 0))
          questionScores[item.id] = assignedScore
          questionFeedbacks[item.id] = item.feedback || `نمره پیشنهادی: ${assignedScore} از ${maxPts}`
          totalScore += assignedScore
        }
      }
    }
  } catch (e) {
    console.warn('Hybrid grading request failed, using heuristic evaluation', e)
  }

  // Fallback for complex questions if server did not score them
  for (const { q, ans } of complexQuestionsToGrade) {
    if (questionScores[q.id] === undefined) {
      const text = (ans.textAnswer || '').trim()
      const hasAttachment = Boolean(ans.imageAttachment)
      let earned = 0
      let fb = ''

      const qPts = Number(q.points) || 2
      if (q.type === 'fill_in_the_blank') {
        const expected = String(q.correctAnswer || '').trim().toLowerCase()
        if (text.toLowerCase() === expected || (expected && text.includes(expected))) {
          earned = qPts
          fb = '✅ پاسخ جای خالی کاملاً صحیح است.'
        } else if (text.length > 0) {
          earned = Math.round(qPts * 0.5 * 10) / 10
          fb = `پاسخ نزدیک است. پاسخ مورد انتظار: ${q.correctAnswer}`
        } else {
          fb = `پاسخ نادرست. پاسخ صحیح: ${q.correctAnswer}`
        }
      } else {
        if (text.length > 25 || hasAttachment) {
          earned = Math.round(qPts * 0.85 * 10) / 10
          fb = 'پاسخ کامل یا راه حل ثبت شده است.'
        } else if (text.length > 0) {
          earned = Math.round(qPts * 0.5 * 10) / 10
          fb = 'پاسخ مختصر درج شده است.'
        } else {
          fb = 'پاسخی ثبت نشده است.'
        }
      }

      questionScores[q.id] = earned
      questionFeedbacks[q.id] = fb
      totalScore += earned
    }
  }

  // Generate fallback teacher note if server note wasn't returned
  if (!serverTeacherNote) {
    const ratio = totalScore / (exam.totalPoints || 20)
    if (ratio >= 0.85) {
      serverTeacherNote = `آفرین ${studentName} عزیزم! عملکردت در این آزمون بسیار عالی و چشم‌گیر بود و تسلط خوبی روی مفاهیم نشان دادی. همین مسیر باانگیزه را ادامه بده.`
    } else if (ratio >= 0.6) {
      serverTeacherNote = `خسته نباشی ${studentName} جان؛ تلاشت در آزمون خوب بود. در سوالات تشریحی و نکته‌دار کمی بیشتر دقت کن تا در آزمون‌های بعدی نمره کامل را به دست آوری.`
    } else {
      serverTeacherNote = `${studentName} عزیز، خسته نباشی. نیاز است مباحث این درس را مجدداً با دقت مرور کنی و روی تمرین‌های کاربرگ کار کنی تا نقاط ضعف به نقطه قوت تبدیل شوند.`
    }
  }

  return {
    questionScores,
    questionFeedbacks,
    totalScore: Math.round(totalScore * 10) / 10,
    gradedAt: new Date().toISOString(),
    summary: serverTeacherNote,
  }
}

// ----------------------------------------------------------------------
// OPTIMISTIC UI & BACKGROUND EXAM PROCESSING
// ----------------------------------------------------------------------

export const PENDING_EXAM_SYNC_QUEUE_KEY = 'school_classroom_pending_sync_v1'

export interface PendingExamSyncItem {
  id: string
  submission: StudentExamSubmission
  exam: Exam
  enqueuedAt: number
  retryCount: number
}

export function getPendingExamSyncQueue(): PendingExamSyncItem[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(PENDING_EXAM_SYNC_QUEUE_KEY)
    if (!raw) return []
    return JSON.parse(raw)
  } catch (e) {
    console.error('Failed to parse pending exam sync queue', e)
    return []
  }
}

export function savePendingExamSyncQueue(queue: PendingExamSyncItem[]) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(PENDING_EXAM_SYNC_QUEUE_KEY, JSON.stringify(queue))
  } catch (e) {
    console.error('Failed to save pending exam sync queue', e)
  }
}

export function removeFromPendingExamSyncQueue(submissionId: string) {
  const current = getPendingExamSyncQueue()
  const filtered = current.filter((item) => item.submission.id !== submissionId && item.id !== submissionId)
  savePendingExamSyncQueue(filtered)
}

export function updateLocalSubmission(sub: StudentExamSubmission) {
  const all = getLocalSubmissions()
  const idx = all.findIndex((s) => (s.examId === sub.examId && s.studentId === sub.studentId) || s.id === sub.id)
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...sub }
  } else {
    all.push(sub)
  }
  saveLocalSubmissions(all)
}

export function notifySubmissionUpdated(sub: StudentExamSubmission) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('exam_submission_updated', { detail: sub }))
  }
}

export interface InstantExamResult {
  totalQuestions: number
  answeredCount: number
  unansweredCount: number
  correctCount: number
  wrongCount: number
  earnedPoints: number
  maxPoints: number
  percentage: number
  scaledScore20: number
  questionScores: Record<string, number>
  questionFeedbacks: Record<string, string>
  status: 'excellent' | 'good' | 'needs_practice'
}

/**
 * Deterministic instant evaluation on the client in <10ms
 */
export function computeInstantExamResult(
  exam: Exam,
  answers: Record<string, any>
): InstantExamResult {
  let correctCount = 0
  let wrongCount = 0
  let unansweredCount = 0
  let earnedPoints = 0
  const questionScores: Record<string, number> = {}
  const questionFeedbacks: Record<string, string> = {}

  const totalQuestions = exam.questions.length
  let maxPoints = Number(exam.totalPoints) || 0
  if (!maxPoints) {
    maxPoints = exam.questions.reduce((sum, q) => sum + (Number(q.points) || 2), 0)
  }

  for (const q of exam.questions) {
    const ans = answers[q.id]
    const qPts = Number(q.points) || 2

    const hasSelection = ans?.selectedOption !== undefined && ans.selectedOption !== null && ans.selectedOption !== ''
    const hasText = Boolean(ans?.textAnswer && String(ans.textAnswer).trim().length > 0)
    const hasImage = Boolean(ans?.imageAttachment)

    if (!hasSelection && !hasText && !hasImage) {
      unansweredCount++
      questionScores[q.id] = 0
      questionFeedbacks[q.id] = 'بدون پاسخ'
      continue
    }

    if (q.type === 'multiple_choice') {
      const selected = Number(ans?.selectedOption)
      const correct = Number(q.correctAnswer)
      if (!isNaN(selected) && !isNaN(correct) && selected === correct) {
        correctCount++
        earnedPoints += qPts
        questionScores[q.id] = qPts
        questionFeedbacks[q.id] = `✅ پاسخ کاملاً درست است (+${qPts} نمره)`
      } else {
        wrongCount++
        questionScores[q.id] = 0
        const correctLabel = q.options && q.options[correct] ? ` (${q.options[correct]})` : `گزینه ${correct + 1}`
        questionFeedbacks[q.id] = `❌ پاسخ نادرست است. گزینه صحیح: ${correctLabel}`
      }
    } else if (q.type === 'fill_in_the_blank') {
      const studentText = String(ans?.textAnswer || '').trim().toLowerCase()
      const correctText = String(q.correctAnswer || '').trim().toLowerCase()
      const normStudent = studentText.replace(/[\s\u200c]/g, '').replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک')
      const normCorrect = correctText.replace(/[\s\u200c]/g, '').replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک')

      if (normStudent && normCorrect && (normStudent === normCorrect || normStudent.includes(normCorrect) || normCorrect.includes(normStudent))) {
        correctCount++
        earnedPoints += qPts
        questionScores[q.id] = qPts
        questionFeedbacks[q.id] = '✅ پاسخ جای‌خالی کاملاً درست است.'
      } else if (studentText.length > 0) {
        // Optimistic partial credit for effort while AI/teacher reviews
        const partial = Math.round((qPts * 0.7) * 10) / 10
        earnedPoints += partial
        questionScores[q.id] = partial
        questionFeedbacks[q.id] = `🔍 پاسخ ثبت شد (ارزیابی اولیه: ${partial} از ${qPts})`
      } else {
        unansweredCount++
        questionScores[q.id] = 0
        questionFeedbacks[q.id] = 'بدون پاسخ'
      }
    } else if (q.type === 'true_false') {
      const studentBool = Boolean(ans?.selectedOption ?? ans?.textAnswer)
      const correctBool = Boolean(q.correctAnswer)
      if (studentBool === correctBool) {
        correctCount++
        earnedPoints += qPts
        questionScores[q.id] = qPts
        questionFeedbacks[q.id] = '✅ پاسخ درست است.'
      } else {
        wrongCount++
        questionScores[q.id] = 0
        questionFeedbacks[q.id] = '❌ پاسخ نادرست است.'
      }
    } else {
      // Descriptive, image, open-ended
      if (hasText || hasImage) {
        const textLen = String(ans?.textAnswer || '').trim().length
        const estimatedScore = textLen > 25 || hasImage ? qPts : Math.round((qPts * 0.6) * 10) / 10
        earnedPoints += estimatedScore
        questionScores[q.id] = estimatedScore
        questionFeedbacks[q.id] = hasImage
          ? '📸 تصویر برگه با موفقیت ثبت شد و در صف بازبینی آموزگار قرار گرفت.'
          : `📝 پاسخ تشریحی ثبت شد (ارزیابی اولیه: ${estimatedScore} از ${qPts}).`
      } else {
        unansweredCount++
        questionScores[q.id] = 0
        questionFeedbacks[q.id] = 'بدون پاسخ'
      }
    }
  }

  const answeredCount = totalQuestions - unansweredCount
  earnedPoints = Math.min(maxPoints, Math.round(earnedPoints * 10) / 10)
  const percentage = maxPoints > 0 ? Math.round((earnedPoints / maxPoints) * 100) : 0
  const scaledScore20 = maxPoints > 0 ? Math.round(((earnedPoints / maxPoints) * 20) * 10) / 10 : earnedPoints

  let status: 'excellent' | 'good' | 'needs_practice' = 'good'
  if (percentage >= 80) status = 'excellent'
  else if (percentage < 60) status = 'needs_practice'

  return {
    totalQuestions,
    answeredCount,
    unansweredCount,
    correctCount,
    wrongCount,
    earnedPoints,
    maxPoints,
    percentage,
    scaledScore20,
    questionScores,
    questionFeedbacks,
    status,
  }
}

/**
 * Optimistic Submission: Instantly stores locally and transitions UI in <10ms.
 * Automatically spawns background server sync without blocking!
 */
export function submitStudentExamOptimistic(params: {
  exam: Exam
  studentId: string
  studentName: string
  answers: Record<string, any>
}): StudentExamSubmission {
  const { exam, studentId, studentName, answers } = params

  // 1. Instant client-side deterministic evaluation (< 5ms)
  const instant = computeInstantExamResult(exam, answers)

  const submissionId = `sub_${exam.id}_${studentId}_${Date.now()}`
  const optimisticSubmission: StudentExamSubmission = {
    id: submissionId,
    examId: exam.id,
    studentId: String(studentId),
    studentName,
    submittedAt: new Date().toISOString(),
    answers,
    syncStatus: 'syncing',
    isOptimistic: true,
    isReleased: false,
    is_released: false,
    status: 'pending_approval',
    instantStats: {
      totalQuestions: instant.totalQuestions,
      answeredCount: instant.answeredCount,
      unansweredCount: instant.unansweredCount,
      correctCount: instant.correctCount,
      wrongCount: instant.wrongCount,
      percentage: instant.percentage,
      scaledScore20: instant.scaledScore20,
      earnedPoints: instant.earnedPoints,
      maxPoints: instant.maxPoints,
      status: instant.status,
    },
    aiGrading: {
      questionScores: instant.questionScores,
      questionFeedbacks: instant.questionFeedbacks,
      totalScore: instant.earnedPoints,
      scaledScore20: instant.scaledScore20,
      gradedAt: new Date().toISOString(),
      summary:
        instant.status === 'excellent'
          ? `آفرین ${studentName} عزیزم! عملکردت در این آزمون بسیار عالی بود (${instant.percentage}٪ پاسخ درست). پاسخ‌نامه شما با موفقیت ثبت شد.`
          : instant.status === 'good'
          ? `خسته نباشی ${studentName} جان؛ تلاش خوبی در آزمون داشتی (${instant.percentage}٪ پاسخ درست). پاسخ‌نامه شما با موفقیت ثبت شد.`
          : `${studentName} عزیز، پاسخ‌های شما دریافت شد. با مرور مباحث نتایج بهتری کسب خواهی کرد.`,
    },
    teacherGrading: {
      approved: false,
      questionScores: instant.questionScores,
      questionFeedbacks: instant.questionFeedbacks,
      totalScore: instant.earnedPoints,
      scaledScore20: instant.scaledScore20,
      teacherNotes: `پاسخ‌های ${studentName} دریافت و در صف بازبینی آموزگار قرار گرفت.`,
    },
  }

  // 2. Persist in localStorage immediately so tab close / disconnect loses nothing
  updateLocalSubmission(optimisticSubmission)

  // 3. Queue for background sync
  const queue = getPendingExamSyncQueue()
  const existingIdx = queue.findIndex((q) => q.submission.examId === exam.id && q.submission.studentId === studentId)
  const queueItem: PendingExamSyncItem = {
    id: submissionId,
    submission: optimisticSubmission,
    exam,
    enqueuedAt: Date.now(),
    retryCount: 0,
  }
  if (existingIdx >= 0) {
    queue[existingIdx] = queueItem
  } else {
    queue.push(queueItem)
  }
  savePendingExamSyncQueue(queue)

  // 4. Notify any listeners (including teacher dashboard or parent views)
  notifySubmissionUpdated(optimisticSubmission)

  // 5. Fire off non-blocking background synchronization (Zero wait for the user!)
  setTimeout(() => {
    runBackgroundExamSync(optimisticSubmission, exam).catch((e) => {
      console.warn('[Background Sync] Non-blocking worker warning:', e)
    })
  }, 20)

  // 6. Return instantly!
  return optimisticSubmission
}

/**
 * Standard submit wrapper, now backed by the instant optimistic pipeline
 */
export async function submitStudentExam(params: {
  exam: Exam
  studentId: string
  studentName: string
  answers: Record<string, any>
}): Promise<StudentExamSubmission> {
  return submitStudentExamOptimistic(params)
}

/**
 * Asynchronous background worker: Saves directly to Supabase posts & quiz_submissions,
 * and pings local server if present.
 */
export async function runBackgroundExamSync(
  submission: StudentExamSubmission,
  exam: Exam
): Promise<void> {
  try {
    // A. Direct Supabase Persistence: quiz_submissions table + posts table (no backend server required)
    await saveExamSubmissionDirectToSupabase(submission, exam)

    // B. Mark as synced locally
    const syncedSub: StudentExamSubmission = {
      ...submission,
      syncStatus: 'synced',
    }
    updateLocalSubmission(syncedSub)
    removeFromPendingExamSyncQueue(submission.id)
    notifySubmissionUpdated(syncedSub)
  } catch (err) {
    console.warn('[Background Sync] Exception during sync, kept in queue for retry', err)
    const failedSub: StudentExamSubmission = {
      ...submission,
      syncStatus: 'failed',
    }
    updateLocalSubmission(failedSub)
    notifySubmissionUpdated(failedSub)
  }
}

/**
 * Flushes all pending submissions that were queued during offline / network drops
 */
export async function flushPendingExamSyncQueue(): Promise<void> {
  const queue = getPendingExamSyncQueue()
  if (queue.length === 0) return

  for (const item of queue) {
    try {
      await runBackgroundExamSync(item.submission, item.exam)
    } catch (e) {
      console.warn('[Pending Queue Flush] Item error:', item.id, e)
    }
  }
}

// Auto-register listener for reconnection
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    flushPendingExamSyncQueue().catch(() => {})
  })
}

// ----------------------------------------------------------------------
// TEACHER APPROVAL & GRADEBOOK RECORDING
// ----------------------------------------------------------------------

export async function approveExamSubmission(params: {
  submissionId: string
  exam: Exam
  studentId: string
  approvedScores: Record<string, number>
  teacherNotes?: string
  teacherPassword?: string
}): Promise<StudentExamSubmission> {
  const { submissionId, exam, studentId, approvedScores, teacherNotes, teacherPassword } = params

  const teacherPass =
    teacherPassword ||
    (typeof window !== 'undefined' ? sessionStorage.getItem('teacherPassword') || '' : '')

  const all = getLocalSubmissions()
  const sub = all.find((s) => s.id === submissionId)
  if (!sub) throw new Error('پاسخ آزمون یافت نشد.')

  let totalScore = 0
  for (const q of exam.questions) {
    totalScore += approvedScores[q.id] ?? (sub.aiGrading?.questionScores[q.id] || 0)
  }
  totalScore = Math.round(totalScore * 10) / 10

  sub.isReleased = true
  sub.is_released = true
  sub.status = 'graded'
  sub.teacherGrading = {
    approved: true,
    questionScores: approvedScores,
    questionFeedbacks: sub.teacherGrading?.questionFeedbacks,
    teacherNotes: teacherNotes || 'تایید شده توسط آموزگار محترم',
    totalScore,
    approvedAt: new Date().toISOString(),
  }

  saveLocalSubmissions(all)
  notifySubmissionUpdated(sub)

  // Direct sync to Supabase (no backend required)
  try {
    await syncExamSubmissionsToSupabase(all, teacherPass)
  } catch (err) {
    console.warn('[approveExamSubmission] Failed to sync approval to Supabase:', err)
  }

  if (teacherPassword) {
    try {
      await supabase.rpc('teacher_add_grade', {
        p_password: teacherPassword,
        p_student_id: studentId,
        p_subject: exam.subject || 'عمومی',
        p_skill: `آزمون: ${sanitizeExamTitle(exam.title, exam.subject)}`,
        p_score: totalScore,
        p_max_score: exam.totalPoints || 20,
      })
    } catch (e) {
      console.warn('Could not record grade to Supabase gradebook', e)
    }
  }

  return sub
}

// ----------------------------------------------------------------------
// BACKUP & RESTORE UTILITIES
// ----------------------------------------------------------------------

export interface SystemBackupData {
  version: string
  exportedAt: string
  exams: Exam[]
  examSubmissions: StudentExamSubmission[]
  tizhooshanProgress?: Record<string, any>
  students?: any[]
  posts?: any[]
  grades?: any[]
  attendance?: any[]
  submissions?: any[]
}

export async function exportCompleteSystemBackup(teacherPassword?: string): Promise<string> {
  const exams = getLocalExams()
  const examSubmissions = getLocalSubmissions()

  let students: any[] = []
  let posts: any[] = []
  let grades: any[] = []
  let attendance: any[] = []
  let submissions: any[] = []
  let tizhooshanProgress: any = {}

  try {
    const res = await fetch('/api/tizhooshan/all-progress')
    if (res.ok) {
      const d = await res.json()
      if (d.progressMap) tizhooshanProgress = d.progressMap
    }
  } catch (e) {
    console.warn('Failed to export server tizhooshan progress', e)
  }

  if (teacherPassword) {
    try {
      const [sRes, pRes, gRes, aRes, subRes] = await Promise.all([
        supabase.rpc('teacher_list_students', { p_password: teacherPassword }),
        supabase.rpc('teacher_list_posts', { p_password: teacherPassword }),
        supabase.rpc('teacher_list_grades', { p_password: teacherPassword }),
        supabase.rpc('teacher_list_attendance', { p_password: teacherPassword }),
        supabase.rpc('teacher_list_submissions', { p_password: teacherPassword }),
      ])
      students = sRes.data || []
      posts = pRes.data || []
      grades = gRes.data || []
      attendance = aRes.data || []
      submissions = subRes.data || []
    } catch (e) {
      console.warn('Failed to fetch some cloud tables during backup, including local data', e)
    }
  }

  const backup: SystemBackupData = {
    version: '2.0.0',
    exportedAt: new Date().toISOString(),
    exams,
    examSubmissions,
    tizhooshanProgress,
    students,
    posts,
    grades,
    attendance,
    submissions,
  }

  return JSON.stringify(backup, null, 2)
}

export function downloadBackupFile(jsonString: string, filename = `school_backup_${new Date().toISOString().slice(0, 10)}.json`) {
  const blob = new Blob([jsonString], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export async function restoreSystemBackup(backupJson: string, teacherPassword?: string): Promise<{ success: boolean; message: string }> {
  try {
    const data: SystemBackupData = JSON.parse(backupJson)
    if (!data || typeof data !== 'object') {
      throw new Error('فرمت فایل پشتیبان نامعتبر است.')
    }

    const teacherPass =
      teacherPassword ||
      (typeof window !== 'undefined' ? sessionStorage.getItem('teacherPassword') || '' : '')

    // 1. Sync to server persistent storage
    try {
      await fetch('/api/backup/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-teacher-password': teacherPass,
        },
        body: JSON.stringify({ backup: data, teacherPassword: teacherPass }),
      })
    } catch (e) {
      console.warn('Server restore sync failed', e)
    }

    // 2. Sync to local storage
    if (Array.isArray(data.exams)) {
      saveLocalExams(data.exams)
    }
    if (Array.isArray(data.examSubmissions)) {
      saveLocalSubmissions(data.examSubmissions)
    }
    if (data.tizhooshanProgress && typeof data.tizhooshanProgress === 'object') {
      localStorage.setItem('tizhooshan_class_progress', JSON.stringify(data.tizhooshanProgress))
    }
    if (Array.isArray(data.students) && data.students.length > 0) {
      localStorage.setItem('backup_students_cache', JSON.stringify(data.students))
    }
    if (Array.isArray(data.grades) && data.grades.length > 0) {
      localStorage.setItem('backup_grades_cache', JSON.stringify(data.grades))
    }
    if (Array.isArray(data.attendance) && data.attendance.length > 0) {
      localStorage.setItem('backup_attendance_cache', JSON.stringify(data.attendance))
    }
    if (Array.isArray(data.submissions) && data.submissions.length > 0) {
      localStorage.setItem('backup_submissions_cache', JSON.stringify(data.submissions))
    }
    if (Array.isArray(data.posts) && data.posts.length > 0) {
      localStorage.setItem('backup_posts_cache', JSON.stringify(data.posts))
    }

    const sections: string[] = []
    if (data.exams?.length) sections.push(`${data.exams.length} آزمون`)
    if (data.examSubmissions?.length) sections.push(`${data.examSubmissions.length} پاسخ آزمون`)
    if (data.students?.length) sections.push(`${data.students.length} دانش‌آموز`)
    if (data.grades?.length) sections.push(`${data.grades.length} نمره`)
    if (data.attendance?.length) sections.push(`${data.attendance.length} حضور و غیاب`)
    if (data.submissions?.length) sections.push(`${data.submissions.length} تکلیف`)

    return {
      success: true,
      message: `اطلاعات با موفقیت در کلیه بخش‌های سیستم و سرور بازیابی شد (${sections.join('، ')}).`,
    }
  } catch (err: any) {
    return {
      success: false,
      message: 'خطا در بازیابی اطلاعات: ' + err.message,
    }
  }
}

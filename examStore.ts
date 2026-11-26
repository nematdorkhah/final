import {
  Exam,
  ExamQuestion,
  QuestionType,
  StudentExamSubmission,
  RegradeAuditRecord,
  RegradeDiffItem,
  RegradePreviewResult,
  RegradeQuestionDiff,
} from '../types/examTypes'
import { supabase } from '../supabaseClient'
import { CLASS_STUDENTS_ROSTER, ClassStudentInfo, resolveCanonicalStudent, resolveStudentFromRecord, isSameStudent, isTestStudentRecord } from '../classStudents'
import {
  generateExamQuestionsHybrid,
  regenerateSingleQuestionHybrid,
  convertPracticeToQuestionsHybrid,
  gradeSubmissionHybrid,
  translateGeminiError,
  getStoredTeacherPassword,
} from '../services/geminiHybridService'
export { getStoredTeacherPassword }
import {
  evaluateEntireExamSubmission,
  evaluateMultipleChoice,
  evaluateFillInTheBlank,
  evaluateDescriptiveQuestion,
  resolveCorrectOptionIndex,
  resolveStudentSelectedOption,
  getExamMaxPoints,
  getSubmissionEffectiveScore,
  isSubmissionApprovedByTeacher,
  roundScore2,
  safeNumber,
  safeScore,
  safeScaled20,
} from './persianSemanticGrader'
import {
  retryWithBackoff,
  fetchWithTimeout,
  fetchApiJson,
  isBackendStaticOnly,
  fetchFilteredPublishedPosts,
  recordFetchDiagnostic,
  recordExamRetrievalDiagnostic,
  withPromiseTimeout,
  sanitizeExamForStudent,
  normalizeQuizRowToExam,
  ExamRetrievalDiagnostic,
} from './networkResilience'

const EXAMS_STORAGE_KEY = 'school_classroom_exams_v1'
const TEACHER_EXAMS_STORAGE_KEY = 'school_classroom_teacher_exams_v1'
const SUBMISSIONS_STORAGE_KEY = 'school_classroom_exam_subs_v1'

// ----------------------------------------------------------------------
// EXAM CRUD & PERSISTENCE
// ----------------------------------------------------------------------

function applyLegacyExamPatch(parsed: any[]): Exam[] {
  parsed.forEach((e) => {
    if (e && e.id === 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2' && Array.isArray(e.questions)) {
      const q2 = e.questions.find((q: any) => q && q.id === 'q2')
      if (q2) {
        delete q2.awardFullScoreToAll
        delete q2.allOptionsCorrect
        delete q2.allAnswersCorrect
        delete q2.isBonusToAll
        q2.correctAnswer = 1
      }
    }
  })
  return parsed
}

function readExamsFromKey(key: string): Exam[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return applyLegacyExamPatch(parsed)
  } catch (e) {
    console.error(`Failed to parse local exams (${key})`, e)
    return []
  }
}

export function getLocalStudentExams(): Exam[] {
  return readExamsFromKey(EXAMS_STORAGE_KEY)
    .filter((e) => e && e.published !== false)
    .map(sanitizeExamForStudent)
}

export function saveLocalStudentExams(exams: Exam[]) {
  try {
    if (typeof localStorage === 'undefined') return
    const safePublished = (Array.isArray(exams) ? exams : [])
      .filter((e) => e && e.published !== false)
      .map(sanitizeExamForStudent)
    localStorage.setItem(EXAMS_STORAGE_KEY, JSON.stringify(safePublished))
  } catch (e) {
    console.error('Failed to save local student exams', e)
  }
}

export function getLocalTeacherExams(): Exam[] {
  const teacherCached = readExamsFromKey(TEACHER_EXAMS_STORAGE_KEY)
  if (teacherCached.length > 0) return teacherCached
  return readExamsFromKey(EXAMS_STORAGE_KEY)
}

export function saveLocalTeacherExams(exams: Exam[]) {
  try {
    if (typeof localStorage === 'undefined') return
    const cleanList = Array.isArray(exams) ? exams : []
    localStorage.setItem(TEACHER_EXAMS_STORAGE_KEY, JSON.stringify(cleanList))
    // Keep student published cache synced ONLY with published, sanitized exams (never leak drafts or answer keys)
    saveLocalStudentExams(cleanList)
  } catch (e) {
    console.error('Failed to save local teacher exams', e)
  }
}

export function getLocalExams(): Exam[] {
  // Prefer teacher cache if present on teacher browser, otherwise student cache
  const teacherCached = readExamsFromKey(TEACHER_EXAMS_STORAGE_KEY)
  if (teacherCached.length > 0) return teacherCached
  return readExamsFromKey(EXAMS_STORAGE_KEY)
}

export function saveLocalExams(exams: Exam[]) {
  try {
    if (typeof localStorage === 'undefined') return
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

const LEGACY_SYSTEM_EXAMS_MIGRATED_KEY = 'quizzes_legacy_system_migration_v1_done'

function buildQuizRowPayload(exam: Exam) {
  const durationMinutes = Number(exam.durationMinutes ?? 30)
  const safeDuration = Number.isFinite(durationMinutes) && durationMinutes >= 0 ? Math.round(durationMinutes) : 30
  const isUntimed = Boolean(exam.isUntimed || exam.mode === 'assignment' || safeDuration === 0)
  const mode: 'exam' | 'assignment' = exam.mode === 'assignment' || isUntimed ? 'assignment' : 'exam'
  const questions = Array.isArray(exam.questions) ? exam.questions : []
  const explicitTotal = Number(exam.totalPoints)
  const totalPoints =
    Number.isFinite(explicitTotal) && explicitTotal > 0
      ? explicitTotal
      : questions.length > 0
      ? questions.reduce((sum, q) => sum + (Number(q?.points) || 1), 0)
      : 20

  return {
    id: exam.id,
    title: exam.title || 'آزمون کلاسی',
    subject: exam.subject || 'عمومی',
    questions,
    duration_minutes: safeDuration,
    published: exam.published !== false,
    mode,
    due_at: exam.dueDate || null,
    scheduled_start: exam.scheduledStartTime || exam.createdAt || new Date().toISOString(),
    is_untimed: isUntimed,
    results_published: Boolean(
      exam.resultsPublished || exam.results_published || exam.isResultsReleased || (exam as any).resultsReleased
    ),
    total_points: totalPoints,
    created_at: exam.createdAt || new Date().toISOString(),
  }
}

async function upsertSingleQuizRow(exam: Exam, teacherPass: string): Promise<Exam> {
  if (!teacherPass) {
    throw new Error('رمز عبور معلم برای ذخیره آزمون در پایگاه داده یافت نشد.')
  }
  const quizPayload = buildQuizRowPayload(exam)

  const { data, error } = await supabase.rpc('teacher_upsert_quiz', {
    p_password: teacherPass,
    p_quiz: quizPayload,
  })
  if (error) {
    throw error
  }
  const normalized = data ? normalizeQuizRowToExam(data) : null
  return normalized || exam
}

export interface LegacyMigrationDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  fetchLegacyRow?: () => Promise<{ data: any; error: any }>
  upsertQuiz?: (exam: Exam, teacherPass: string) => Promise<Exam>
  verifyQuizzes?: (teacherPass: string) => Promise<any[]>
}

/**
 * Verified one-time migration from legacy posts.__SYSTEM_EXAMS__ into public.quizzes.
 * - Never sets completion flag before every valid legacy exam is confirmed in public.quizzes.
 * - Safely retries on temporary network/DB errors.
 * - Prevents duplicate creation by checking existing quiz IDs first.
 * - Preserves original exam IDs and metadata; never modifies or deletes legacy posts data.
 */
export async function migrateLegacySystemExamsOnce(
  teacherPass: string,
  existingRows: any[],
  deps?: LegacyMigrationDeps
): Promise<Exam[] | null> {
  try {
    if (!teacherPass) return null
    const storage = deps?.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
    if (storage && storage.getItem(LEGACY_SYSTEM_EXAMS_MIGRATED_KEY) === '1') {
      return null
    }

    const fetchLegacyRow =
      deps?.fetchLegacyRow ??
      (async () =>
        supabase
          .from('posts')
          .select('id, body')
          .eq('title', '__SYSTEM_EXAMS__')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle())

    const { data: systemRow, error: sysErr } = await withPromiseTimeout(
      fetchLegacyRow(),
      8000,
      'Legacy system exams lookup timed out'
    )

    // Temporary failure reading legacy posts: do NOT set completion flag so next load retries cleanly
    if (sysErr) {
      console.warn('[ExamStore:migrateLegacySystemExamsOnce] Temporary error reading legacy __SYSTEM_EXAMS__:', sysErr)
      return null
    }

    if (!systemRow?.body) {
      if (storage) storage.setItem(LEGACY_SYSTEM_EXAMS_MIGRATED_KEY, '1')
      return null
    }

    let parsed: any
    try {
      parsed = typeof systemRow.body === 'string' ? JSON.parse(systemRow.body) : systemRow.body
    } catch (parseErr) {
      console.warn('[ExamStore:migrateLegacySystemExamsOnce] Could not parse __SYSTEM_EXAMS__ JSON:', parseErr)
      return null
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      if (storage) storage.setItem(LEGACY_SYSTEM_EXAMS_MIGRATED_KEY, '1')
      return null
    }

    // Deduplicate valid UUID legacy records while preserving original IDs and metadata
    const validLegacyMap = new Map<string, Exam>()
    for (const rawItem of parsed) {
      if (rawItem && isValidUuid(String(rawItem.id || ''))) {
        validLegacyMap.set(String(rawItem.id), rawItem as Exam)
      }
    }
    const validLegacyItems = Array.from(validLegacyMap.values())

    if (validLegacyItems.length === 0) {
      if (storage) storage.setItem(LEGACY_SYSTEM_EXAMS_MIGRATED_KEY, '1')
      return null
    }

    const existingIds = new Set(
      (Array.isArray(existingRows) ? existingRows : [])
        .filter((r) => r && r.id)
        .map((r) => String(r.id))
    )

    const missingLegacyItems = validLegacyItems.filter((item) => !existingIds.has(String(item.id)))

    // If every valid legacy record already exists in public.quizzes, migration is verified complete
    if (missingLegacyItems.length === 0) {
      if (storage) storage.setItem(LEGACY_SYSTEM_EXAMS_MIGRATED_KEY, '1')
      return null
    }

    const upsertQuiz = deps?.upsertQuiz ?? upsertSingleQuizRow
    let failedCount = 0

    for (const rawItem of missingLegacyItems) {
      try {
        await withPromiseTimeout(upsertQuiz(rawItem, teacherPass), 8000, 'Legacy quiz upsert timed out')
      } catch (itemErr) {
        failedCount += 1
        console.warn('[ExamStore:migrateLegacySystemExamsOnce] Failed migrating item:', rawItem.id, itemErr)
      }
    }

    // Do NOT mark migration done if any record failed; next load will safely retry only missing IDs
    if (failedCount > 0) {
      return null
    }

    // Verify all migrated records now exist in public.quizzes before setting completion flag
    const verifyQuizzes =
      deps?.verifyQuizzes ??
      (async (pass: string) => {
        const { data: verifiedRows, error: verifyErr } = await supabase.rpc('teacher_list_quizzes', {
          p_password: pass,
        })
        if (verifyErr) throw verifyErr
        return Array.isArray(verifiedRows) ? verifiedRows : []
      })

    const verifiedRows = await withPromiseTimeout(
      verifyQuizzes(teacherPass),
      8000,
      'Legacy migration verification timed out'
    )
    const verifiedIds = new Set(verifiedRows.filter((r) => r && r.id).map((r) => String(r.id)))
    const allVerifiedPresent = validLegacyItems.every((item) => verifiedIds.has(String(item.id)))

    if (!allVerifiedPresent) {
      console.warn('[ExamStore:migrateLegacySystemExamsOnce] Verification incomplete; will retry on next load.')
      return null
    }

    if (storage) {
      storage.setItem(LEGACY_SYSTEM_EXAMS_MIGRATED_KEY, '1')
    }

    return verifiedRows.map((row) => normalizeQuizRowToExam(row)).filter((e): e is Exam => Boolean(e))
  } catch (err) {
    console.warn('[ExamStore:migrateLegacySystemExamsOnce] Unexpected error (flag NOT set):', err)
    return null
  }
}

let legacyMigrationStartedThisSession = false

export interface ExamsFetchResult {
  exams: Exam[]
  remoteOk: boolean
  source: 'server' | 'cache' | 'error'
  error: string | null
  errorCode: string | null
  fromCacheOnly: boolean
  retryCount: number
  durationMs: number
  diagnostic: ExamRetrievalDiagnostic
}

function summarizeExamCounts(exams: Exam[]) {
  const published = exams.filter((e) => e && e.published !== false)
  const assignmentsCount = published.filter((e) => e.mode === 'assignment').length
  const publishedExamsCount = published.filter((e) => e.mode !== 'assignment').length
  return {
    totalRecords: exams.length,
    publishedExamsCount,
    assignmentsCount,
  }
}

export async function fetchAllExamsWithDiagnostics(
  teacherPassword?: string,
  options: { requestSource?: string; timeoutMs?: number } = {}
): Promise<ExamsFetchResult> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  const rpcName = teacherPass ? 'teacher_list_quizzes' : 'student_list_published_quizzes'
  const requestSource = options.requestSource || 'fetchAllExams'
  const timeoutMs = options.timeoutMs ?? 35000
  const start = Date.now()

  // Single authoritative source of truth: public.quizzes via secure RPC
  try {
    const outcome = await retryWithBackoff(
      async () => {
        if (teacherPass) {
          const { data: rpcRows, error: rpcErr } = await withPromiseTimeout(
            supabase.rpc('teacher_list_quizzes', { p_password: teacherPass }),
            timeoutMs,
            'زمان دریافت لیست آزمون‌ها از سرور به پایان رسید.'
          )
          if (rpcErr) {
            const err: any = new Error(rpcErr.message || 'teacher_list_quizzes error')
            err.code = rpcErr.code
            err.status = (rpcErr as any).status
            throw err
          }
          return Array.isArray(rpcRows) ? rpcRows : []
        }

        const { data: rpcRows, error: rpcErr } = await withPromiseTimeout(
          supabase.rpc('student_list_published_quizzes'),
          timeoutMs,
          'زمان دریافت آزمون‌های منتشرشده به پایان رسید.'
        )
        if (rpcErr) {
          const err: any = new Error(rpcErr.message || 'student_list_published_quizzes error')
          err.code = rpcErr.code
          err.status = (rpcErr as any).status
          throw err
        }
        return Array.isArray(rpcRows) ? rpcRows : []
      },
      { maxRetries: 2, baseDelayMs: 350, stage: `exam_fetch_${rpcName}` }
    )

    const rows = outcome.data
    // The legacy __SYSTEM_EXAMS__ migration downloads a large JSON row. It used to be awaited on EVERY
    // load (always in incognito/new devices), delaying the exam list ~20s. It now runs once per page
    // session in the background and refreshes the list only if it actually migrated something.
    if (teacherPass && !legacyMigrationStartedThisSession) {
      legacyMigrationStartedThisSession = true
      void migrateLegacySystemExamsOnce(teacherPass, rows)
        .then((migrated) => {
          if (migrated && migrated.length > rows.length && typeof window !== 'undefined') {
            saveLocalTeacherExams(migrated)
            window.dispatchEvent(new CustomEvent('exams-updated', { detail: { migrated: true } }))
          }
        })
        .catch(() => {})
    }
    const finalExams = rows.map((row) => normalizeQuizRowToExam(row)).filter((e): e is Exam => Boolean(e))

    // Confirmed server response: safely update role-appropriate cache (including genuine empty list)
    if (teacherPass) {
      saveLocalTeacherExams(finalExams)
    } else {
      saveLocalStudentExams(finalExams)
    }

    const counts = summarizeExamCounts(finalExams)
    const durationMs = Date.now() - start
    const diagnostic = recordExamRetrievalDiagnostic({
      requestSource,
      rpcName,
      success: true,
      errorCode: null,
      errorMessage: null,
      ...counts,
      usedCache: false,
      retryCount: outcome.retryCount,
      durationMs,
    })

    return {
      exams: finalExams,
      remoteOk: true,
      source: 'server',
      error: null,
      errorCode: null,
      fromCacheOnly: false,
      retryCount: outcome.retryCount,
      durationMs,
      diagnostic,
    }
  } catch (err: any) {
    const durationMs = Date.now() - start
    const errorCode = err?.code ? String(err.code) : err?.status ? String(err.status) : 'NETWORK_ERROR'
    const errorMsg = String(err?.message || err || 'خطا در دریافت آزمون‌ها از پایگاه داده')
    // Never overwrite local cache on failure; read role-appropriate cache only as fallback
    const cached = teacherPass ? getLocalTeacherExams() : getLocalStudentExams()
    const hasCache = cached.length > 0
    const counts = summarizeExamCounts(cached)

    const diagnostic = recordExamRetrievalDiagnostic({
      requestSource,
      rpcName,
      success: false,
      errorCode,
      errorMessage: errorMsg,
      ...counts,
      usedCache: hasCache,
      retryCount: 2,
      durationMs,
    })

    console.warn(`[ExamStore:fetchAllExamsWithDiagnostics] ${rpcName} failed:`, errorCode, errorMsg)

    return {
      exams: cached,
      remoteOk: false,
      source: hasCache ? 'cache' : 'error',
      error: errorMsg,
      errorCode,
      fromCacheOnly: hasCache,
      retryCount: 2,
      durationMs,
      diagnostic,
    }
  }
}

export async function fetchAllExams(teacherPassword?: string): Promise<Exam[]> {
  const result = await fetchAllExamsWithDiagnostics(teacherPassword, { requestSource: 'fetchAllExams' })
  return result.exams
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

export interface PublishedExamsResult {
  exams: Exam[]
  remoteOk: boolean
  remoteSourcesSucceeded: number
  source: 'server' | 'cache' | 'error'
  error: string | null
  errorCode: string | null
  fromCacheOnly: boolean
  retryCount: number
  durationMs: number
  diagnostic?: ExamRetrievalDiagnostic
}

const inFlightPublishedExams = new Map<string, Promise<PublishedExamsResult>>()

export async function fetchPublishedExamsWithDiagnostics(
  forStudent = true,
  forceFresh = false,
  options: { skipBackendApi?: boolean; requestSource?: string; timeoutMs?: number } = {}
): Promise<PublishedExamsResult> {
  const dedupeKey = `${forStudent ? '1' : '0'}:${forceFresh ? '1' : '0'}:${options.skipBackendApi ? '1' : '0'}`
  if (!forceFresh) {
    const existingFlight = inFlightPublishedExams.get(dedupeKey)
    if (existingFlight) {
      return existingFlight
    }
  }

  const runPromise = (async (): Promise<PublishedExamsResult> => {
    const local = forStudent ? getLocalStudentExams() : getLocalTeacherExams()
    const start = Date.now()
    const timeoutMs = options.timeoutMs ?? 35000
    const requestSource = options.requestSource || (forStudent ? 'student_published_fetch' : 'teacher_published_fetch')
    const teacherPass = forStudent ? '' : getStoredTeacherPassword()
    const rpcName = !forStudent && teacherPass ? 'teacher_list_quizzes' : 'student_list_published_quizzes'

    // Single authoritative source of truth: public.quizzes (1 single query with per-attempt timeout & backoff)
    try {
      const outcome = await retryWithBackoff(
        async () => {
          if (rpcName === 'teacher_list_quizzes' && teacherPass) {
            const { data: rpcRows, error: rpcErr } = await withPromiseTimeout(
              supabase.rpc('teacher_list_quizzes', { p_password: teacherPass }),
              timeoutMs,
              'زمان دریافت آزمون‌ها از سرور به پایان رسید.'
            )
            if (rpcErr) {
              const err: any = new Error(rpcErr.message || 'teacher_list_quizzes error')
              err.code = rpcErr.code
              err.status = (rpcErr as any).status
              throw err
            }
            return Array.isArray(rpcRows) ? rpcRows : []
          }

          const { data: rpcRows, error: rpcErr } = await withPromiseTimeout(
            supabase.rpc('student_list_published_quizzes'),
            timeoutMs,
            'زمان دریافت آزمون‌های منتشرشده از سرور به پایان رسید.'
          )
          if (rpcErr) {
            const err: any = new Error(rpcErr.message || 'student_list_published_quizzes error')
            err.code = rpcErr.code
            err.status = (rpcErr as any).status
            throw err
          }
          return Array.isArray(rpcRows) ? rpcRows : []
        },
        { maxRetries: 2, baseDelayMs: 350, stage: 'supabase_quizzes' }
      )

      const normalized = outcome.data
        .map((row: any) => normalizeQuizRowToExam(row))
        .filter((e): e is Exam => Boolean(e && e.published !== false))

      const finalExams = forStudent ? normalized.map(sanitizeExamForStudent) : normalized

      // Update only the student cache when forStudent=true so teacher drafts/answer keys on shared browsers are never overwritten
      if (forStudent) {
        saveLocalStudentExams(finalExams)
      } else if (teacherPass) {
        const allNormalized = outcome.data
          .map((row: any) => normalizeQuizRowToExam(row))
          .filter((e): e is Exam => Boolean(e))
        saveLocalTeacherExams(allNormalized)
      } else {
        saveLocalStudentExams(finalExams)
      }

      const counts = summarizeExamCounts(finalExams)
      const durationMs = Date.now() - start
      const diagnostic = recordExamRetrievalDiagnostic({
        requestSource,
        rpcName,
        success: true,
        errorCode: null,
        errorMessage: null,
        ...counts,
        usedCache: false,
        retryCount: outcome.retryCount,
        durationMs,
      })

      return {
        exams: finalExams,
        remoteOk: true,
        remoteSourcesSucceeded: 1,
        source: 'server',
        error: null,
        errorCode: null,
        fromCacheOnly: false,
        retryCount: outcome.retryCount,
        durationMs,
        diagnostic,
      }
    } catch (err: any) {
      const durationMs = Date.now() - start
      const errorCode = err?.code ? String(err.code) : err?.status ? String(err.status) : 'NETWORK_ERROR'
      const errorMsg = String(err?.message || err || 'خطا در دریافت آزمون‌ها از پایگاه داده')
      // NEVER overwrite local cache on failure
      const cached = local.filter((e) => e && e.published !== false)
      const finalExams = forStudent ? cached.map(sanitizeExamForStudent) : cached
      const hasCache = finalExams.length > 0
      const counts = summarizeExamCounts(finalExams)

      recordFetchDiagnostic({
        timestamp: new Date().toISOString(),
        examId: null,
        stage: 'fetch_published_exams_quizzes_failed',
        statusOrError: errorMsg,
        durationMs,
        retryCount: 2,
        finalStatus: 'failed',
      })

      const diagnostic = recordExamRetrievalDiagnostic({
        requestSource,
        rpcName,
        success: false,
        errorCode,
        errorMessage: errorMsg,
        ...counts,
        usedCache: hasCache,
        retryCount: 2,
        durationMs,
      })

      return {
        exams: finalExams,
        remoteOk: false,
        remoteSourcesSucceeded: 0,
        source: hasCache ? 'cache' : 'error',
        error: errorMsg,
        errorCode,
        fromCacheOnly: hasCache,
        retryCount: 2,
        durationMs,
        diagnostic,
      }
    }
  })().finally(() => {
    if (inFlightPublishedExams.get(dedupeKey) === runPromise) {
      inFlightPublishedExams.delete(dedupeKey)
    }
  })

  if (!forceFresh) {
    inFlightPublishedExams.set(dedupeKey, runPromise)
  }
  return runPromise
}

export async function fetchPublishedExams(forStudent = true): Promise<Exam[]> {
  const result = await fetchPublishedExamsWithDiagnostics(forStudent)
  if (!result.remoteOk && result.exams.length === 0) {
    throw new Error(result.error || 'خطا در دریافت آزمون‌ها از پایگاه داده')
  }
  return result.exams
}

export interface StudentExamReviewQuestionItem {
  question_id: string
  index: number
  text: string
  type: string
  options?: string[]
  student_answer?: any
  correct_answer?: any
  explanation?: string
  feedback?: string
  earned_points?: number | null
  max_points?: number
}

export interface StudentExamReviewResponse {
  ok: boolean
  released: boolean
  reason?: string
  message?: string
  exam?: Exam | null
  submission?: StudentExamSubmission | null
  questionsReview?: StudentExamReviewQuestionItem[]
  scaledScore20?: number | null
}

/**
 * Fetches full unsanitized exam questions, correct answers, explanations, and student's answers
 * via the secure Supabase RPC `student_get_exam_review`.
 * Returns `released: false` if results for this student have not been approved/published yet.
 */
export async function fetchStudentExamReview(params: {
  examId: string
  studentId: string
  accessCode: string
}): Promise<StudentExamReviewResponse> {
  const { examId, studentId, accessCode } = params
  if (!isValidUuid(examId) || !isValidUuid(studentId) || !String(accessCode || '').trim()) {
    return {
      ok: false,
      released: false,
      reason: 'invalid_params',
      message: 'اطلاعات شناسایی آزمون یا دانش‌آموز معتبر نیست.',
    }
  }

  const { data, error } = await supabase.rpc('student_get_exam_review', {
    p_exam_id: examId,
    p_student_id: studentId,
    p_access_code: String(accessCode).trim(),
  })

  if (error) {
    throw new Error(error.message || 'خطا در دریافت پاسخ‌نامه از سرور')
  }

  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      released: false,
      reason: 'empty_response',
      message: 'پاسخی از سرور دریافت نشد.',
    }
  }

  const payload = data as any
  if (!payload.ok || !payload.released) {
    return {
      ok: false,
      released: false,
      reason: payload.reason || 'not_released',
      message: payload.message || 'نتیجه هنوز منتشر نشده است.',
    }
  }

  const normalizedExam = payload.exam ? normalizeQuizRowToExam(payload.exam) : null
  const normalizedSub = payload.submission ? (payload.submission as StudentExamSubmission) : null

  return {
    ok: true,
    released: true,
    exam: normalizedExam,
    submission: normalizedSub,
    questionsReview: Array.isArray(payload.questions_review) ? payload.questions_review : [],
    scaledScore20:
      payload.scaled_score_20 !== null && payload.scaled_score_20 !== undefined
        ? safeScaled20(payload.scaled_score_20, 20)
        : null,
  }
}

export async function saveExam(exam: Exam, teacherPassword?: string): Promise<void> {
  // Ensure exam has a valid UUID format for PostgreSQL quizzes.id and quiz_submissions.quiz_id
  if (!isValidUuid(exam.id)) {
    exam.id = generateUuid()
  }

  const teacherPass = getStoredTeacherPassword(teacherPassword)

  const saveWork = async (): Promise<Exam> => {
    const outcome = await retryWithBackoff(
      async () => upsertSingleQuizRow(exam, teacherPass),
      { maxRetries: 1, baseDelayMs: 300, stage: 'save_exam_quizzes', examId: exam.id }
    )
    return outcome.data
  }

  const timeoutPromise = new Promise<Exam>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error('زمان ذخیره آزمون در سرور به پایان رسید. لطفاً اینترنت خود را بررسی کرده و مجدداً ذخیره کنید.')
        ),
      10000
    )
  )

  const savedExam = await Promise.race([saveWork(), timeoutPromise])

  // Update local cache ONLY after single-row quizzes upsert succeeds (never push localStorage list to server)
  const current = getLocalTeacherExams()
  const idx = current.findIndex((e) => e.id === savedExam.id)
  if (idx >= 0) {
    current[idx] = savedExam
  } else {
    current.unshift(savedExam)
  }
  saveLocalTeacherExams(current)

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('exams-updated', { detail: { examId: savedExam.id, saved: true } }))
  }
}

export async function deleteExam(examId: string, teacherPassword?: string): Promise<boolean> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)

  // Delete single quiz row in Supabase strictly via teacher_delete_quiz RPC (never direct table access)
  if (isValidUuid(examId)) {
    if (!teacherPass) {
      throw new Error('رمز عبور معلم برای حذف آزمون یافت نشد.')
    }
    const { error: rpcErr } = await supabase.rpc('teacher_delete_quiz', {
      p_password: teacherPass,
      p_quiz_id: examId,
    })
    if (rpcErr) {
      throw rpcErr
    }
  }

  // Clean local cache after remote deletion
  const current = getLocalTeacherExams().filter((e) => e.id !== examId)
  saveLocalTeacherExams(current)

  try {
    const currentSubs = getLocalSubmissions().filter((s) => s.examId !== examId)
    saveLocalSubmissions(currentSubs)
  } catch (err) {
    console.warn('[ExamStore:deleteExam] Error cleaning local submissions:', err)
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('exams-updated', { detail: { examId, deleted: true } }))
  }

  return true
}


// ----------------------------------------------------------------------
// SUBMISSIONS & PERSISTENCE
// ----------------------------------------------------------------------

export function getLocalSubmissions(): StudentExamSubmission[] {
  try {
    if (typeof localStorage === 'undefined') return []
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
    if (typeof localStorage === 'undefined') return
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

  // When evaluating access for a specific student's submission, STRICTLY require teacher approval on that submission!
  // Never reveal an unapproved/pending_approval score just because exam.resultsPublished / isResultsReleased is true.
  if (submission) {
    const subApproved = isSubmissionApprovedByTeacher(submission)
    if (!subApproved) {
      return false
    }

    if (
      exam.resultsPublished ||
      exam.results_published ||
      exam.isResultsReleased ||
      (exam as any).resultsReleased ||
      submission.isReleased ||
      submission.is_released ||
      submission.status === 'released' ||
      (submission.status as string) === 'approved' ||
      submission.status === 'graded'
    ) {
      return true
    }

    const isUntimed = exam.mode === 'assignment' || Boolean(exam.isUntimed) || Number(exam.durationMinutes) <= 0
    if (isUntimed) {
      return false
    }

    if (exam.dueDate) {
      const dueTime = new Date(exam.dueDate).getTime()
      if (!isNaN(dueTime) && Date.now() > dueTime) {
        return true
      }
    }

    if (exam.scheduledStartTime) {
      const startMs = new Date(exam.scheduledStartTime).getTime()
      const durationMs = (Number(exam.durationMinutes) || 30) * 60 * 1000
      const windowEnd = startMs + durationMs + 5 * 60 * 1000
      if (!isNaN(windowEnd) && Date.now() > windowEnd) {
        return true
      }
    }

    return false
  }

  return Boolean(exam.resultsPublished || exam.results_published || exam.isResultsReleased || (exam as any).resultsReleased)
}

/**
 * Syncs exam submissions to Supabase __SYSTEM_EXAM_SUBMISSIONS__ row safely:
 * - ALWAYS fetches the latest remote snapshot first and merges by canonical (examId, studentId) key,
 *   so partial local caches can NEVER wipe out other students or other exams.
 * - When `preserveExplicitUpdates` is true (e.g. teacher approve/unpublish), incoming items replace
 *   their matching keys explicitly instead of being overwritten by older remote states.
 */
export async function syncExamSubmissionsToSupabase(
  submissions: StudentExamSubmission[],
  teacherPassword?: string,
  options: { preserveExplicitUpdates?: boolean } = {}
): Promise<boolean> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  const preserveExplicitUpdates = Boolean(options.preserveExplicitUpdates)
  let directSuccess = false

  console.log(`[ExamStore:syncExamSubmissionsToSupabase] Safe-merging ${submissions.length} exam submissions to Supabase...`)

  // 1. Fetch latest remote snapshot FIRST so we NEVER overwrite class data with a partial array
  let existingRowId: string | null = null
  let remoteSubs: StudentExamSubmission[] = []
  try {
    const { data: existingRows, error: fetchErr } = await supabase
      .from('posts')
      .select('id, title, body')
      .eq('title', '__SYSTEM_EXAM_SUBMISSIONS__')
      .order('created_at', { ascending: false })
      .limit(1)

    if (!fetchErr && existingRows?.[0]) {
      existingRowId = existingRows[0].id
      const parsed = typeof existingRows[0].body === 'string'
        ? JSON.parse(existingRows[0].body)
        : existingRows[0].body
      if (Array.isArray(parsed)) {
        remoteSubs = parsed
      }
    }
  } catch (err) {
    console.warn('[ExamStore:syncExamSubmissionsToSupabase] Remote snapshot pre-fetch warning:', err)
  }

  let mergedToPersist: StudentExamSubmission[]
  if (preserveExplicitUpdates && submissions.length > 0) {
    const incomingMap = new Map<string, StudentExamSubmission>()
    for (const s of mergeSubmissionsDeduplicated([], submissions)) {
      if (s && s.examId && s.studentId) {
        incomingMap.set(getSubmissionCanonicalKey(s.examId, s.studentId, s.studentName), s)
      }
    }
    const preservedRemote = mergeSubmissionsDeduplicated([], remoteSubs).filter(
      (rs) => rs && rs.examId && rs.studentId && !incomingMap.has(getSubmissionCanonicalKey(rs.examId, rs.studentId, rs.studentName))
    )
    mergedToPersist = [...preservedRemote, ...Array.from(incomingMap.values())]
  } else {
    mergedToPersist = mergeSubmissionsDeduplicated(remoteSubs, submissions)
  }

  const bodyJson = JSON.stringify(mergedToPersist)

  // 2. Update or Insert into __SYSTEM_EXAM_SUBMISSIONS__ row in posts table
  try {
    if (existingRowId) {
      const { error: updErr } = await supabase
        .from('posts')
        .update({
          body: bodyJson,
          type: 'announcement', // Allowed by posts_type_check!
          publish_at: new Date().toISOString(),
        })
        .eq('id', existingRowId)

      if (!updErr) {
        console.log('[ExamStore:syncExamSubmissionsToSupabase] Successfully updated __SYSTEM_EXAM_SUBMISSIONS__')
        directSuccess = true
      } else {
        console.warn('[ExamStore:syncExamSubmissionsToSupabase] Update error:', updErr)
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
      } else {
        console.warn('[ExamStore:syncExamSubmissionsToSupabase] Insert error:', insErr)
      }
    }
  } catch (err) {
    console.warn('[ExamStore:syncExamSubmissionsToSupabase] Direct posts table sync error:', err)
  }

  // 3. Backup to teacher RPC ONLY if direct row update/insert failed
  if (!directSuccess && teacherPass) {
    try {
      const { error: rpcErr } = await supabase.rpc('teacher_create_post', {
        p_password: teacherPass,
        p_type: 'announcement',
        p_title: '__SYSTEM_EXAM_SUBMISSIONS__',
        p_body: bodyJson,
        p_due_at: null,
        p_publish_at: new Date().toISOString(),
        p_attachment_path: null,
      })
      if (!rpcErr) {
        directSuccess = true
      } else {
        console.warn('[ExamStore:syncExamSubmissionsToSupabase] RPC fallback error:', rpcErr)
      }
    } catch (rpcCatchErr) {
      console.warn('[ExamStore:syncExamSubmissionsToSupabase] RPC fallback exception:', rpcCatchErr)
    }
  }

  return directSuccess
}

function isMissingRpcFunctionError(err: any): boolean {
  if (!err) return false
  const code = String(err.code || '')
  const msg = String(err.message || '').toLowerCase()
  return (
    code === '42883' ||
    code === 'PGRST202' ||
    msg.includes('could not find the function') ||
    (msg.includes('function public.') && msg.includes('does not exist'))
  )
}

function getStoredStudentAccessCode(studentId?: string, explicitAccessCode?: string): string {
  const cleanExplicit = String(explicitAccessCode || '').trim()
  if (cleanExplicit) return cleanExplicit
  const canon = studentId ? resolveCanonicalStudent(studentId) : undefined
  try {
    if (typeof localStorage !== 'undefined') {
      const rawSession = localStorage.getItem('class_auth_session')
      if (rawSession) {
        const parsed = JSON.parse(rawSession)
        const s = parsed?.student
        const sCode = String(s?.access_code || '').trim()
        if (sCode) {
          if (!studentId || isSameStudent(s?.id || sCode, studentId, s?.full_name)) {
            return sCode
          }
        }
      }
      const rawLegacy = localStorage.getItem('student')
      if (rawLegacy) {
        const parsed = JSON.parse(rawLegacy)
        const sCode = String(parsed?.access_code || '').trim()
        if (sCode) {
          if (!studentId || isSameStudent(parsed?.id || sCode, studentId, parsed?.full_name)) {
            return sCode
          }
        }
      }
    }
  } catch {}
  return String(canon?.nationalCode || '').trim()
}

/**
 * Saves a student exam submission directly to Supabase posts table and quiz_submissions via authenticated RPC.
 */
export async function saveExamSubmissionDirectToSupabase(
  submission: StudentExamSubmission,
  exam: Exam,
  teacherPassword?: string,
  studentAccessCode?: string
): Promise<boolean> {
  let success = false
  const canonSubStudent = resolveCanonicalStudent(submission.studentId || submission.studentName)
  const canonicalStudentId = canonSubStudent?.id || String(submission.studentId).trim()
  const canonicalStudentName = canonSubStudent?.fullName || submission.studentName
  const normalizedSubmission: StudentExamSubmission = {
    ...submission,
    studentId: canonicalStudentId,
    studentName: canonicalStudentName,
  }

  console.log(`[ExamStore:saveExamSubmissionDirectToSupabase] Direct Supabase persistence for student ${canonicalStudentName} (${canonicalStudentId})...`)

  const syncBody = JSON.stringify({
    ...normalizedSubmission,
    syncStatus: 'synced',
    clientExamTitle: exam.title,
    clientSubject: exam.subject,
  })

  // 1. Direct Supabase posts table: Upsert/Insert individual student submission post (__EXAM_SUB__:${exam.id}:${canonicalStudentId})
  try {
    const postTitle = `__EXAM_SUB__:${exam.id}:${canonicalStudentId}`
    const candidateTitles = [postTitle]
    if (canonSubStudent?.nationalCode && canonSubStudent.nationalCode !== canonicalStudentId) {
      candidateTitles.push(`__EXAM_SUB__:${exam.id}:${canonSubStudent.nationalCode}`)
    }
    const { data: existingPosts } = await supabase
      .from('posts')
      .select('id, title')
      .in('title', candidateTitles)
      .order('created_at', { ascending: false })
      .limit(10)

    const existingPost = Array.isArray(existingPosts) && existingPosts.length > 0
      ? (existingPosts.find((p: any) => p.title === postTitle) || existingPosts[0])
      : null

    let postErr: any = null
    if (existingPost?.id) {
      const upd = await supabase
        .from('posts')
        .update({ title: postTitle, body: syncBody, publish_at: new Date().toISOString() })
        .eq('id', existingPost.id)
      postErr = upd.error
      if (postErr) {
        const ins = await supabase.from('posts').insert({
          title: postTitle,
          body: syncBody,
          type: 'announcement',
          publish_at: new Date().toISOString(),
        })
        postErr = ins.error
      }
    } else {
      const ins = await supabase.from('posts').insert({
        title: postTitle,
        body: syncBody,
        type: 'announcement',
        publish_at: new Date().toISOString(),
      })
      postErr = ins.error
    }

    if (!postErr) {
      console.log('[ExamStore:saveExamSubmissionDirectToSupabase] Saved individual post to Supabase:', postTitle)
      success = true
    } else {
      console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] Individual post save error:', postErr)
    }
  } catch (err) {
    console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] Error saving individual post:', err)
  }

  // 2. Update local submissions cache ONLY (never overwrite class-wide __SYSTEM_EXAM_SUBMISSIONS__ from student client!)
  try {
    const allSubs = mergeSubmissionsDeduplicated(getLocalSubmissions(), [normalizedSubmission])
    saveLocalSubmissions(allSubs)
  } catch (err) {
    console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] Error updating local submissions:', err)
  }

  // 3. Direct Supabase quiz_submissions table: Upsert row with student foreign key resolution
  try {
    let studentUUID: string | null = null
    const isValidStudentUuid = isValidUuid(canonicalStudentId)
    if (isValidStudentUuid) {
      studentUUID = canonicalStudentId
    } else {
      // 1. Try canonical roster or public student list RPC
      const rosterMatch = resolveCanonicalStudent(canonicalStudentId || canonicalStudentName)
      if (rosterMatch?.id && isValidUuid(rosterMatch.id)) {
        studentUUID = rosterMatch.id
      }
      if (!studentUUID) {
        try {
          const { data: pubStudents } = await supabase.rpc('list_students_public')
          if (Array.isArray(pubStudents) && pubStudents.length > 0) {
            const matchedPub = pubStudents.find(
              (ps: any) =>
                ps.full_name === canonicalStudentName ||
                (rosterMatch && ps.full_name === rosterMatch.fullName)
            )
            if (matchedPub?.id) studentUUID = matchedPub.id
          }
        } catch {}
      }

      // 2. Direct students table lookup by access_code
      if (!studentUUID) {
        try {
          const { data: stRow } = await supabase
            .from('students')
            .select('id')
            .eq('access_code', String(canonicalStudentId))
            .order('created_at', { ascending: false })
            .limit(1)
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
        normalizedSubmission.instantStats?.scaledScore20 ??
        normalizedSubmission.aiGrading?.scaledScore20 ??
        normalizedSubmission.instantStats?.earnedPoints ??
        0
      )
      const submissionAnswers = {
        ...normalizedSubmission.answers,
        exam_id: exam.id,
        quiz_id: exam.id,
        student_name: canonicalStudentName,
        student_national_code: canonSubStudent?.nationalCode || canonicalStudentId,
        score: earned,
        submitted_at: normalizedSubmission.submittedAt || new Date().toISOString(),
      }

      const effectiveAccessCode = getStoredStudentAccessCode(studentUUID, studentAccessCode)
      const submittedAtIso = normalizedSubmission.submittedAt || new Date().toISOString()
      let qsErr: any = null
      let handledViaRpc = false

      // 3a. Primary Secure Path: Authenticated student_upsert_quiz_submission RPC (works with RLS enabled)
      if (effectiveAccessCode) {
        const rpcRes = await supabase.rpc('student_upsert_quiz_submission', {
          p_student_id: studentUUID,
          p_access_code: effectiveAccessCode,
          p_quiz_id: isExamUuid ? exam.id : null,
          p_answers: submissionAnswers,
          p_score: earned,
          p_submitted_at: submittedAtIso,
        })
        if (!rpcRes.error) {
          handledViaRpc = true
          qsErr = null
        } else if (!isMissingRpcFunctionError(rpcRes.error)) {
          // Do not bypass explicit auth/validation errors from the secure RPC
          handledViaRpc = true
          qsErr = rpcRes.error
        }
      }

      // 3b. Pre-migration fallback ONLY if Phase 1 RPC has not been applied in Supabase yet
      if (!handledViaRpc) {
        const { data: existingQs } = await supabase
          .from('quiz_submissions')
          .select('id, quiz_id, answers')
          .eq('student_id', studentUUID)
          .order('submitted_at', { ascending: false })
          .limit(20)
        const matchingQs = (existingQs || []).find((r: any) => (r.quiz_id || r.answers?.quiz_id || r.answers?.exam_id) === exam.id)

        if (matchingQs?.id) {
          const updRes = await supabase
            .from('quiz_submissions')
            .update({
              answers: { ...(matchingQs.answers || {}), ...submissionAnswers },
              score: earned,
              submitted_at: submittedAtIso,
            })
            .eq('id', matchingQs.id)
          qsErr = updRes.error
        } else {
          const insRes = await supabase.from('quiz_submissions').insert({
            student_id: studentUUID,
            quiz_id: isExamUuid ? exam.id : null,
            answers: submissionAnswers,
            score: earned,
            submitted_at: submittedAtIso,
          })
          qsErr = insRes.error

          if (qsErr && isExamUuid && qsErr.code === '23503') {
            console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] FK on quiz_id, retrying with quiz_id: null...')
            const fallbackRes = await supabase.from('quiz_submissions').insert({
              student_id: studentUUID,
              quiz_id: null,
              answers: submissionAnswers,
              score: earned,
              submitted_at: submittedAtIso,
            })
            qsErr = fallbackRes.error
          }
        }
      }

      if (!qsErr) {
        console.log('[ExamStore:saveExamSubmissionDirectToSupabase] Successfully synced quiz_submissions!')
        success = true
      } else {
        console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] quiz_submissions save warning:', qsErr)
      }
    }
  } catch (err) {
    console.warn('[ExamStore:saveExamSubmissionDirectToSupabase] quiz_submissions table error:', err)
  }

  // 4. Also notify server endpoint to update memory cache and disk backup
  if (!isBackendStaticOnly()) {
    try {
      fetchWithTimeout(
        '/api/exams/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            examId: exam.id,
            studentId: submission.studentId,
            studentName: submission.studentName,
            answers: submission.answers,
            clientExam: exam,
          }),
        },
        6000
      ).catch(() => {})
    } catch {}
  }

  return success
}

export interface GradebookUpsertResult {
  ok: boolean
  action: 'inserted' | 'updated' | 'skipped' | 'failed'
  studentId: string
  studentName?: string
  gradeId?: string
  scaledScore20: number
  error?: string
}

export interface GradebookBatchSyncSummary {
  total: number
  succeeded: number
  failed: number
  skipped: number
  verifiedInGradesTable: boolean
  results: GradebookUpsertResult[]
  errors: string[]
}

export async function fetchTeacherGradebookRows(
  teacherPassword?: string
): Promise<{ ok: boolean; rows: any[]; error?: string }> {
  const effectivePass = getStoredTeacherPassword(teacherPassword)
  if (!effectivePass) {
    return {
      ok: false,
      rows: [],
      error: 'رمز عبور معلم برای خواندن جدول اصلی grades موجود نیست.',
    }
  }
  try {
    const { data, error } = await supabase.rpc('teacher_list_grades', {
      p_password: effectivePass,
    })
    if (error) {
      return {
        ok: false,
        rows: [],
        error: error.message || 'خطا در خواندن جدول grades از سرور',
      }
    }
    if (!Array.isArray(data)) {
      return {
        ok: false,
        rows: [],
        error: 'پاسخ نامعتبر از teacher_list_grades (احتمالاً رمز معلم نادرست است).',
      }
    }
    return { ok: true, rows: data }
  } catch (err: any) {
    return {
      ok: false,
      rows: [],
      error: err?.message || 'خطای غیرمنتظره هنگام خواندن جدول grades',
    }
  }
}

function normalizeGradeSkillKey(val: string): string {
  return String(val || '')
    .replace(/^آزمون:\s*/u, '')
    .replace(/^تکلیف:\s*/u, '')
    .replace(/[\u200c\s]+/g, '')
    .trim()
}

/**
 * Finds the canonical (newest) row in PostgreSQL `grades` for a specific student & exam.
 * Used identically across Teacher UI badges, upsert deduplication, and parity checks.
 */
export function findGradebookRowForExamSubmission(
  gradesList: any[],
  exam: Pick<Exam, 'id' | 'title' | 'subject'>,
  studentId: string,
  studentName?: string
): any | null {
  if (!Array.isArray(gradesList) || gradesList.length === 0 || !exam) return null
  const rosterStudent = resolveCanonicalStudent(studentId || studentName)
  const canonicalStudentId = rosterStudent?.id || String(studentId || '').trim()
  const canonicalName = rosterStudent?.fullName || studentName
  const cleanTitle = sanitizeExamTitle(exam.title, exam.subject)
  const targetNormSkill = normalizeGradeSkillKey(cleanTitle)
  const subjectNorm = String(exam.subject || 'عمومی').trim()

  const matching = gradesList.filter((g: any) => {
    if (!g) return false
    const studentMatches =
      isSameStudent(g.student_id, canonicalStudentId, g.student_name, canonicalName) ||
      String(g.student_id) === String(canonicalStudentId)
    if (!studentMatches) return false
    if (g.examId && g.examId === exam.id) return true
    const gSkillNorm = normalizeGradeSkillKey(g.skill || '')
    if (!gSkillNorm || !targetNormSkill) return false
    const gSubjectNorm = String(g.subject || 'عمومی').trim()
    const skillExactOrContains =
      gSkillNorm === targetNormSkill ||
      (targetNormSkill.length >= 5 && (gSkillNorm.includes(targetNormSkill) || targetNormSkill.includes(gSkillNorm)))
    return skillExactOrContains && (!exam.subject || gSubjectNorm === subjectNorm || gSkillNorm === targetNormSkill)
  })

  if (matching.length === 0) return null
  matching.sort((a: any, b: any) => {
    const ta = a?.recorded_at ? new Date(a.recorded_at).getTime() : 0
    const tb = b?.recorded_at ? new Date(b.recorded_at).getTime() : 0
    return tb - ta
  })
  return matching[0]
}

/**
 * Deduplicates raw PostgreSQL `grades` rows by (canonical studentId + subject + normalized skill),
 * always keeping the newest row by `recorded_at` without deleting any DB records.
 */
export function deduplicateGradebookRows(gradesList: any[]): any[] {
  if (!Array.isArray(gradesList) || gradesList.length === 0) return []
  const sorted = [...gradesList].sort((a: any, b: any) => {
    const ta = a?.recorded_at ? new Date(a.recorded_at).getTime() : 0
    const tb = b?.recorded_at ? new Date(b.recorded_at).getTime() : 0
    return tb - ta
  })
  const seen = new Set<string>()
  const deduped: any[] = []
  for (const g of sorted) {
    if (!g) continue
    const canon = resolveCanonicalStudent(g.student_id || g.student_name)
    const stKey = canon?.id || String(g.student_id || '').trim()
    const skKey = normalizeGradeSkillKey(g.skill || '')
    const subjKey = String(g.subject || 'عمومی').trim()
    const key = skKey ? `${stKey}::${subjKey}::${skKey}` : `${stKey}::${g.id || Math.random()}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(g)
  }
  return deduped
}

/**
 * Upserts a single exam grade in Supabase `grades` table independently per canonical student ID.
 * Checks EVERY Supabase RPC error and returns an explicit status object — NEVER swallows errors silently.
 */
export async function upsertGradebookExamRow(params: {
  teacherPassword: string
  studentId: string
  studentName?: string
  exam: Exam
  scaledScore20: number
  existingGradesCache?: any[]
}): Promise<GradebookUpsertResult> {
  const { teacherPassword, studentId, studentName, exam, scaledScore20, existingGradesCache } = params
  const rosterStudent = resolveCanonicalStudent(studentId || studentName)
  const canonicalStudentId = rosterStudent?.id || String(studentId || '').trim()
  const resolvedName = rosterStudent?.fullName || studentName
  const cleanScaled20 = Math.min(20, Math.max(0, roundScore2(scaledScore20)))

  if (!canonicalStudentId || isTestStudentRecord(canonicalStudentId, resolvedName)) {
    return {
      ok: true,
      action: 'skipped',
      studentId: canonicalStudentId || String(studentId || ''),
      studentName: resolvedName,
      scaledScore20: cleanScaled20,
    }
  }

  const effectivePass = String(teacherPassword || '').trim()
  if (!effectivePass) {
    return {
      ok: false,
      action: 'failed',
      studentId: canonicalStudentId,
      studentName: resolvedName,
      scaledScore20: cleanScaled20,
      error: 'رمز عبور معلم برای ثبت نمره در جدول اصلی grades وارد نشده است.',
    }
  }

  const subject = exam.subject || 'عمومی'
  const cleanTitle = sanitizeExamTitle(exam.title, exam.subject)
  const skill = exam.mode === 'assignment' ? `تکلیف: ${cleanTitle}` : `آزمون: ${cleanTitle}`

  try {
    let gradesList = existingGradesCache
    if (!gradesList) {
      const { data: listData, error: listErr } = await supabase.rpc('teacher_list_grades', {
        p_password: effectivePass,
      })
      if (listErr) {
        return {
          ok: false,
          action: 'failed',
          studentId: canonicalStudentId,
          studentName: resolvedName,
          scaledScore20: cleanScaled20,
          error: `خطا در خواندن جدول grades: ${listErr.message || 'خطای RPC'}`,
        }
      }
      if (!Array.isArray(listData)) {
        return {
          ok: false,
          action: 'failed',
          studentId: canonicalStudentId,
          studentName: resolvedName,
          scaledScore20: cleanScaled20,
          error: 'پاسخ نامعتبر از teacher_list_grades (احتمالاً رمز معلم نادرست است).',
        }
      }
      gradesList = listData
    }

    const existingRow = findGradebookRowForExamSubmission(gradesList, exam, canonicalStudentId, resolvedName)

    if (existingRow?.id) {
      const { error: updErr } = await supabase.rpc('teacher_update_grade', {
        p_password: effectivePass,
        p_grade_id: existingRow.id,
        p_score: cleanScaled20,
        p_max_score: 20,
      })
      if (updErr) {
        return {
          ok: false,
          action: 'failed',
          studentId: canonicalStudentId,
          studentName: resolvedName,
          gradeId: String(existingRow.id),
          scaledScore20: cleanScaled20,
          error: `خطا در بروزرسانی نمره در جدول grades: ${updErr.message || 'خطای RPC'}`,
        }
      }
      return {
        ok: true,
        action: 'updated',
        studentId: canonicalStudentId,
        studentName: resolvedName,
        gradeId: String(existingRow.id),
        scaledScore20: cleanScaled20,
      }
    }

    const { data: addData, error: addErr } = await supabase.rpc('teacher_add_grade', {
      p_password: effectivePass,
      p_student_id: canonicalStudentId,
      p_subject: subject,
      p_skill: skill,
      p_score: cleanScaled20,
      p_max_score: 20,
    })
    if (addErr) {
      return {
        ok: false,
        action: 'failed',
        studentId: canonicalStudentId,
        studentName: resolvedName,
        scaledScore20: cleanScaled20,
        error: `خطا در درج نمره در جدول grades: ${addErr.message || 'خطای RPC'}`,
      }
    }

    const insertedId =
      typeof addData === 'string'
        ? addData
        : Array.isArray(addData)
        ? addData[0]?.id
        : addData?.id

    return {
      ok: true,
      action: 'inserted',
      studentId: canonicalStudentId,
      studentName: resolvedName,
      gradeId: insertedId ? String(insertedId) : undefined,
      scaledScore20: cleanScaled20,
    }
  } catch (e: any) {
    return {
      ok: false,
      action: 'failed',
      studentId: canonicalStudentId,
      studentName: resolvedName,
      scaledScore20: cleanScaled20,
      error: e?.message || 'خطای غیرمنتظره هنگام ارتباط با جدول grades',
    }
  }
}

/**
 * Syncs an individual __EXAM_SUB__ post in Supabase posts table strictly by (examId, canonicalStudentId).
 */
async function syncIndividualExamSubPost(
  submission: StudentExamSubmission,
  exam: Exam
): Promise<{ ok: boolean; error?: string }> {
  try {
    const canon = resolveCanonicalStudent(submission.studentId || submission.studentName)
    const canonStudentId = canon?.id || String(submission.studentId).trim()
    const normalizedSub: StudentExamSubmission = {
      ...submission,
      studentId: canonStudentId,
      studentName: canon?.fullName || submission.studentName,
    }
    const postTitle = `__EXAM_SUB__:${exam.id}:${canonStudentId}`
    const syncBody = JSON.stringify({
      ...normalizedSub,
      syncStatus: 'synced',
      clientExamTitle: exam.title,
      clientSubject: exam.subject,
    })

    const candidateTitles = [postTitle]
    if (canon?.nationalCode && canon.nationalCode !== canonStudentId) {
      candidateTitles.push(`__EXAM_SUB__:${exam.id}:${canon.nationalCode}`)
    }

    const { data: existingPosts, error: selErr } = await supabase
      .from('posts')
      .select('id, title')
      .in('title', candidateTitles)
      .order('created_at', { ascending: false })
      .limit(10)

    if (selErr) {
      return { ok: false, error: selErr.message }
    }

    if (Array.isArray(existingPosts) && existingPosts.length > 0) {
      const target = existingPosts.find((p: any) => p.title === postTitle) || existingPosts[0]
      const { error: updErr } = await supabase
        .from('posts')
        .update({ title: postTitle, body: syncBody, publish_at: new Date().toISOString() })
        .eq('id', target.id)
      if (updErr) {
        const { error: insFallbackErr } = await supabase.from('posts').insert({
          title: postTitle,
          body: syncBody,
          type: 'announcement',
          publish_at: new Date().toISOString(),
        })
        if (insFallbackErr) return { ok: false, error: insFallbackErr.message }
      }
    } else {
      const { error: insErr } = await supabase.from('posts').insert({
        title: postTitle,
        body: syncBody,
        type: 'announcement',
        publish_at: new Date().toISOString(),
      })
      if (insErr) return { ok: false, error: insErr.message }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'syncIndividualExamSubPost error' }
  }
}

/**
 * Syncs teacher approval/regrade into Supabase quiz_submissions table per student UUID.
 */
async function syncQuizSubmissionScoreToSupabase(
  submission: StudentExamSubmission,
  exam: Exam,
  teacherPassword?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const canon = resolveCanonicalStudent(submission.studentId || submission.studentName)
    const studentUuid = canon?.id && isValidUuid(canon.id) ? canon.id : (isValidUuid(submission.studentId) ? submission.studentId : null)
    if (!studentUuid) return { ok: true }

    const eff = getSubmissionEffectiveScore(exam, submission)
    const isApproved = isSubmissionApprovedByTeacher(submission) && eff.isApproved
    const effectiveTeacherPass = getStoredTeacherPassword(teacherPassword)
    const gradingAnswersPatch = {
      ...(submission.answers || {}),
      exam_id: exam.id,
      quiz_id: exam.id,
      student_name: canon?.fullName || submission.studentName,
      student_national_code: canon?.nationalCode || submission.studentId,
      score: eff.scaledScore20,
      raw_score: eff.totalScore,
      scaledScore20: eff.scaledScore20,
      totalScore: eff.totalScore,
      approved: isApproved,
      teacher_approved: isApproved,
      is_released: Boolean(submission.isReleased || isApproved),
      approved_at: submission.teacherGrading?.approvedAt,
      questionScores: eff.questionScores,
      teacherGrading: submission.teacherGrading,
    }

    // 1. Primary Secure Path: Authenticated teacher_upsert_quiz_submission RPC (works with RLS enabled)
    if (effectiveTeacherPass) {
      const rpcRes = await supabase.rpc('teacher_upsert_quiz_submission', {
        p_password: effectiveTeacherPass,
        p_quiz_id: isValidUuid(exam.id) ? exam.id : null,
        p_student_id: studentUuid,
        p_answers: gradingAnswersPatch,
        p_score: isApproved ? eff.scaledScore20 : 0,
      })
      if (!rpcRes.error) {
        return { ok: true }
      }
      if (!isMissingRpcFunctionError(rpcRes.error)) {
        return { ok: false, error: rpcRes.error.message }
      }
    }

    // 2. Pre-migration fallback ONLY if Phase 1 RPC has not been applied in Supabase yet
    const { data: rows, error: selErr } = await supabase
      .from('quiz_submissions')
      .select('id, quiz_id, answers')
      .eq('student_id', studentUuid)
      .order('submitted_at', { ascending: false })
      .limit(20)

    if (selErr) return { ok: false, error: selErr.message }

    const matching = (rows || []).filter((r: any) => (r.quiz_id || r.answers?.quiz_id || r.answers?.exam_id) === exam.id)
    if (matching.length === 0) return { ok: true }

    const target = matching[0]
    const updatedAnswers = {
      ...(target.answers || {}),
      ...gradingAnswersPatch,
    }

    const { error: updErr } = await supabase
      .from('quiz_submissions')
      .update({
        score: isApproved ? eff.scaledScore20 : 0,
        answers: updatedAnswers,
      })
      .eq('id', target.id)

    if (updErr) return { ok: false, error: updErr.message }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'syncQuizSubmissionScoreToSupabase error' }
  }
}

/**
 * Persists a batch of approved exam submissions into PostgreSQL `grades` table
 * independently per canonical student ID, verifies persistence via `teacher_list_grades`,
 * and returns exact per-student results & errors without silent failures.
 */
export async function syncApprovedSubmissionsBatchToGradebook(params: {
  exam: Exam
  submissions: StudentExamSubmission[]
  teacherPassword: string
}): Promise<GradebookBatchSyncSummary> {
  const { exam, submissions, teacherPassword } = params
  const effectivePass = getStoredTeacherPassword(teacherPassword)
  const results: GradebookUpsertResult[] = []
  const errors: string[] = []

  const realSubs = mergeSubmissionsDeduplicated([], submissions).filter(
    (s) => s && s.examId === exam.id && !isTestStudentRecord(s.studentId, s.studentName)
  )

  if (!effectivePass) {
    const errMsg = 'رمز عبور معلم برای ثبت نمرات در جدول اصلی grades موجود نیست.'
    return {
      total: realSubs.length,
      succeeded: 0,
      failed: realSubs.length,
      skipped: 0,
      verifiedInGradesTable: false,
      results: realSubs.map((s) => ({
        ok: false,
        action: 'failed',
        studentId: s.studentId,
        studentName: s.studentName,
        scaledScore20: getSubmissionEffectiveScore(exam, s).scaledScore20,
        error: errMsg,
      })),
      errors: [errMsg],
    }
  }

  const { data: existingGrades, error: listErr } = await supabase.rpc('teacher_list_grades', {
    p_password: effectivePass,
  })
  if (listErr || !Array.isArray(existingGrades)) {
    const errMsg = listErr?.message
      ? `خطا در خواندن جدول grades: ${listErr.message}`
      : 'دریافت فهرست جدول grades ناموفق بود (رمز معلم را بررسی کنید).'
    return {
      total: realSubs.length,
      succeeded: 0,
      failed: realSubs.length,
      skipped: 0,
      verifiedInGradesTable: false,
      results: realSubs.map((s) => ({
        ok: false,
        action: 'failed',
        studentId: s.studentId,
        studentName: s.studentName,
        scaledScore20: getSubmissionEffectiveScore(exam, s).scaledScore20,
        error: errMsg,
      })),
      errors: [errMsg],
    }
  }

  const gradesCache = [...existingGrades]
  for (const s of realSubs) {
    const eff = getSubmissionEffectiveScore(exam, s)
    if (!isSubmissionApprovedByTeacher(s) || !eff.isApproved) {
      results.push({
        ok: true,
        action: 'skipped',
        studentId: s.studentId,
        studentName: s.studentName,
        scaledScore20: eff.scaledScore20,
      })
      continue
    }
    const res = await upsertGradebookExamRow({
      teacherPassword: effectivePass,
      studentId: s.studentId,
      studentName: s.studentName,
      exam,
      scaledScore20: eff.scaledScore20,
      existingGradesCache: gradesCache,
    })
    results.push(res)
    if (!res.ok && res.error) {
      errors.push(`${s.studentName || s.studentId}: ${res.error}`)
    }
  }

  const succeeded = results.filter((r) => r.ok && r.action !== 'skipped').length
  const failed = results.filter((r) => !r.ok).length
  const skipped = results.filter((r) => r.ok && r.action === 'skipped').length

  // Re-read `grades` table to verify actual persistence
  let verifiedInGradesTable = false
  if (succeeded > 0) {
    try {
      const { data: verifyRows, error: verifyErr } = await supabase.rpc('teacher_list_grades', {
        p_password: effectivePass,
      })
      if (!verifyErr && Array.isArray(verifyRows)) {
        const expectedSucceeded = results.filter((r) => r.ok && r.action !== 'skipped')
        verifiedInGradesTable = expectedSucceeded.every((r) =>
          Boolean(findGradebookRowForExamSubmission(verifyRows, exam, r.studentId, r.studentName))
        )
      }
    } catch {}
  }

  return {
    total: realSubs.length,
    succeeded,
    failed,
    skipped,
    verifiedInGradesTable,
    results,
    errors,
  }
}

/**
 * Syncs all already-approved & released submissions of an exam into PostgreSQL `grades` table
 * without modifying any unapproved/pending submission.
 */
export async function syncExamApprovedGradesToGradebook(
  examId: string,
  teacherPassword?: string
): Promise<GradebookBatchSyncSummary> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  const exams = await fetchAllExams(teacherPass)
  const exam = exams.find((e) => e.id === examId)
  if (!exam) {
    throw new Error(`آزمون با شناسه ${examId} یافت نشد.`)
  }
  const subs = await fetchExamSubmissions(examId, undefined, true, teacherPass)
  const approvedAndReleased = subs.filter(
    (s) => isSubmissionApprovedByTeacher(s) && isExamResultsReleased(exam, s)
  )
  return syncApprovedSubmissionsBatchToGradebook({
    exam,
    submissions: approvedAndReleased,
    teacherPassword: teacherPass,
  })
}

/**
 * Releases report cards and answer keys for all students in an exam.
 */
export async function releaseExamResultsForAll(
  examId: string,
  teacherPassword?: string,
  unpublish = false
): Promise<{ success: boolean; exam?: Exam; gradeSyncSummary?: GradebookBatchSyncSummary }> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  let allExams = getLocalExams()
  let examIdx = allExams.findIndex((e) => e.id === examId)

  // Hydrate authoritative exam (with correctAnswer keys) from Supabase if missing or stripped
  const localExam = examIdx >= 0 ? allExams[examIdx] : undefined
  const localHasKeys = Boolean(localExam && Array.isArray(localExam.questions) && localExam.questions.some((q) => q.correctAnswer !== undefined))
  if (!localExam || !localHasKeys) {
    try {
      const remoteExams = await fetchAllExams(teacherPass)
      if (remoteExams.length > 0) {
        allExams = remoteExams
        examIdx = allExams.findIndex((e) => e.id === examId)
      }
    } catch {}
  }

  if (examIdx === -1) {
    console.warn('[ExamStore:releaseExamResultsForAll] Exam not found:', examId)
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

  // Update single row in public.quizzes
  await saveExam(updatedExam, teacherPass)

  // Hydrate all submissions for this exam before updating
  let examSubsFresh: StudentExamSubmission[] = []
  try {
    examSubsFresh = await fetchExamSubmissions(examId, undefined, true, teacherPass)
  } catch {
    examSubsFresh = getLocalSubmissions().filter((s) => s.examId === examId)
  }

  const allSubs = mergeSubmissionsDeduplicated(getLocalSubmissions(), examSubsFresh)
  const maxExamPts = getExamMaxPoints(updatedExam)
  const nowIso = new Date().toISOString()

  const updatedExamSubsOnly: StudentExamSubmission[] = []
  const updatedSubs = allSubs.map((sub) => {
    if (sub.examId !== examId) return sub

    if (unpublish) {
      const lockedSub: StudentExamSubmission = {
        ...sub,
        isReleased: false,
        is_released: false,
        status: 'pending_approval' as const,
        teacherGrading: {
          ...(sub.teacherGrading || {}),
          approved: false,
          approvedAt: undefined,
        },
      }
      updatedExamSubsOnly.push(lockedSub)
      return lockedSub
    }

    // Recompute authoritative effective score while honoring any explicit manual teacher scores
    const eff = getSubmissionEffectiveScore(updatedExam, {
      ...sub,
      status: 'released',
      isReleased: true,
      teacherGrading: {
        ...(sub.teacherGrading || {}),
        approved: true,
      },
    })
    const evalResult = evaluateEntireExamSubmission(updatedExam, sub.answers || {})

    const nextSub: StudentExamSubmission = {
      ...sub,
      isReleased: true,
      is_released: true,
      status: 'released' as const,
      earnedPoints: eff.totalScore,
      totalScore: eff.totalScore,
      scaledScore20: eff.scaledScore20,
      instantStats: {
        totalQuestions: evalResult.totalQuestions,
        answeredCount: evalResult.answeredCount,
        unansweredCount: evalResult.unansweredCount,
        correctCount: evalResult.correctCount,
        wrongCount: evalResult.wrongCount,
        percentage: Math.round((eff.totalScore / (maxExamPts || 20)) * 100),
        scaledScore20: eff.scaledScore20,
        earnedPoints: eff.totalScore,
        maxPoints: maxExamPts,
        status: eff.status,
      },
      aiGrading: {
        ...(sub.aiGrading || {}),
        questionScores: evalResult.questionScores,
        questionFeedbacks: sub.aiGrading?.questionFeedbacks || evalResult.questionFeedbacks,
        totalScore: evalResult.earnedPoints,
        scaledScore20: evalResult.scaledScore20,
        gradedAt: sub.aiGrading?.gradedAt || nowIso,
      },
      teacherGrading: {
        ...(sub.teacherGrading || {}),
        approved: true,
        approvedAt: sub.teacherGrading?.approvedAt || nowIso,
        questionScores: eff.questionScores,
        questionFeedbacks: sub.teacherGrading?.questionFeedbacks || evalResult.questionFeedbacks,
        totalScore: eff.totalScore,
        scaledScore20: eff.scaledScore20,
      },
    }
    updatedExamSubsOnly.push(nextSub)
    return nextSub
  })
  saveLocalSubmissions(updatedSubs)

  // Merge ONLY this exam's updated submissions into remote __SYSTEM_EXAM_SUBMISSIONS__
  await syncExamSubmissionsToSupabase(updatedExamSubsOnly, teacherPass, { preserveExplicitUpdates: true })

  // Sync per-student individual submission posts & quiz_submissions
  if (updatedExamSubsOnly.length > 0) {
    await Promise.allSettled(
      updatedExamSubsOnly.flatMap((s) => [
        syncIndividualExamSubPost(s, updatedExam),
        syncQuizSubmissionScoreToSupabase(s, updatedExam, teacherPass),
      ])
    )
  }

  // Persist to PostgreSQL `grades` table per canonical student & collect honest result/errors
  let gradeSyncSummary: GradebookBatchSyncSummary | undefined
  if (!unpublish && updatedExamSubsOnly.length > 0) {
    gradeSyncSummary = await syncApprovedSubmissionsBatchToGradebook({
      exam: updatedExam,
      submissions: updatedExamSubsOnly,
      teacherPassword: teacherPass,
    })
  }

  // Dispatch events to refresh both student views and teacher views
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('exam_results_released', { detail: { examId, released: !unpublish } }))
    window.dispatchEvent(new CustomEvent('exam_submission_updated', { detail: { examId } }))
  }

  return { success: true, exam: updatedExam, gradeSyncSummary }
}

export function getSubmissionCanonicalKey(examId: string, studentId: string, studentName?: string): string {
  const canon = resolveStudentFromRecord(studentId, studentName)
  const canonId = canon ? canon.id : String(studentId).trim()
  return `${examId}::${canonId}`
}

function getSubmissionQualityScore(sub: StudentExamSubmission) {
  const canon = resolveCanonicalStudent(sub.studentId || sub.studentName)
  const isApproved = isSubmissionApprovedByTeacher(sub)
  const hasManualOverride = Boolean(sub.teacherGrading?.manualOverride)
  const approvedAtMs = sub.teacherGrading?.approvedAt ? new Date(sub.teacherGrading.approvedAt).getTime() : 0
  const submittedAtMs = sub.submittedAt ? new Date(sub.submittedAt).getTime() : 0
  const qScores = sub.teacherGrading?.questionScores
  const qKeys = qScores && typeof qScores === 'object' ? Object.keys(qScores) : []
  const qSum = qKeys.length > 0
    ? roundScore2(qKeys.reduce((acc, k) => acc + (Number((qScores as any)[k]) || 0), 0))
    : 0
  const fbText = sub.teacherGrading?.questionFeedbacks ? JSON.stringify(sub.teacherGrading.questionFeedbacks) : ''
  const hasStaleAiFeedback = fbText.includes('تفاوت در واژگان') || fbText.includes('نمره اولیه:')
  const hasTeacherApprovedNote = String(sub.teacherGrading?.teacherNotes || '').includes('تایید شده توسط آموزگار')
  const scalarScore = Number(sub.teacherGrading?.scaledScore20 ?? sub.teacherGrading?.totalScore ?? sub.scaledScore20 ?? 0)
  const effectiveRankScore = qKeys.length > 0 && qSum > 0 ? qSum : scalarScore
  const isCanonicalUuid = Boolean(canon && String(sub.studentId).trim() === canon.id)
  const ansCount = Object.keys(sub.answers || {}).length
  return {
    isApproved,
    hasManualOverride,
    approvedAtMs,
    submittedAtMs,
    qCount: qKeys.length,
    qSum,
    hasStaleAiFeedback,
    hasTeacherApprovedNote,
    effectiveRankScore,
    isCanonicalUuid,
    ansCount,
  }
}

function compareApprovedSubPriority(a: StudentExamSubmission, b: StudentExamSubmission): number {
  const qa = getSubmissionQualityScore(a)
  const qb = getSubmissionQualityScore(b)

  if (qa.hasManualOverride !== qb.hasManualOverride) return qa.hasManualOverride ? 1 : -1
  if (qa.hasStaleAiFeedback !== qb.hasStaleAiFeedback) return qa.hasStaleAiFeedback ? -1 : 1
  if (qa.hasTeacherApprovedNote !== qb.hasTeacherApprovedNote) return qa.hasTeacherApprovedNote ? 1 : -1
  if (Math.abs(qa.approvedAtMs - qb.approvedAtMs) > 1000) return qa.approvedAtMs > qb.approvedAtMs ? 1 : -1
  if (Math.abs(qa.effectiveRankScore - qb.effectiveRankScore) > 0.01) return qa.effectiveRankScore > qb.effectiveRankScore ? 1 : -1
  if (qa.qCount !== qb.qCount) return qa.qCount > qb.qCount ? 1 : -1
  if (qa.isCanonicalUuid !== qb.isCanonicalUuid) return qa.isCanonicalUuid ? 1 : -1
  if (qa.ansCount !== qb.ansCount) return qa.ansCount > qb.ansCount ? 1 : -1
  return qa.submittedAtMs >= qb.submittedAtMs ? 1 : -1
}

/**
 * Deduplicates submissions by (examId, canonicalStudentId) composite key.
 * Preserves teacher approvals, prioritizes genuine teacher-graded records over stale AI fallbacks,
 * merges answer sets cleanly, and retains audit history.
 */
export function mergeSubmissionsDeduplicated(
  baseList: StudentExamSubmission[],
  incomingList: StudentExamSubmission[]
): StudentExamSubmission[] {
  const map = new Map<string, StudentExamSubmission>()

  const processSub = (rawSub: StudentExamSubmission) => {
    if (!rawSub || !rawSub.examId || !rawSub.studentId) return
    const canon = resolveStudentFromRecord(
      rawSub.studentId,
      rawSub.studentName,
      (rawSub.answers as any)?.student_national_code
    )
    const normalizedSub: StudentExamSubmission = {
      ...rawSub,
      studentId: canon ? canon.id : String(rawSub.studentId).trim(),
      studentName: canon ? canon.fullName : rawSub.studentName,
    }
    const key = getSubmissionCanonicalKey(normalizedSub.examId, normalizedSub.studentId, normalizedSub.studentName)
    const existing = map.get(key)
    if (!existing) {
      map.set(key, normalizedSub)
      return
    }

    const qExisting = getSubmissionQualityScore(existing)
    const qIncoming = getSubmissionQualityScore(normalizedSub)

    let primary = qIncoming.submittedAtMs >= qExisting.submittedAtMs ? normalizedSub : existing
    let secondary = primary === normalizedSub ? existing : normalizedSub

    if (qExisting.isApproved && !qIncoming.isApproved) {
      primary = existing
      secondary = normalizedSub
    } else if (qIncoming.isApproved && !qExisting.isApproved) {
      primary = normalizedSub
      secondary = existing
    } else if (qExisting.isApproved && qIncoming.isApproved) {
      const cmp = compareApprovedSubPriority(normalizedSub, existing)
      primary = cmp >= 0 ? normalizedSub : existing
      secondary = primary === normalizedSub ? existing : normalizedSub
    } else if (qIncoming.ansCount !== qExisting.ansCount) {
      primary = qIncoming.ansCount > qExisting.ansCount ? normalizedSub : existing
      secondary = primary === normalizedSub ? existing : normalizedSub
    }

    // Combine regrade history without duplicates
    const combinedHistory = [
      ...(existing.regradeHistory || []),
      ...(normalizedSub.regradeHistory || []),
    ].filter((v, i, a) => a.findIndex((t) => t.regradedAt === v.regradedAt) === i)

    // Prefer richer answers map (preserving question answers from primary while filling missing keys from secondary)
    const mergedAnswers = { ...(secondary.answers || {}), ...(primary.answers || {}) }
    const anyApproved = qExisting.isApproved || qIncoming.isApproved

    const merged: StudentExamSubmission = {
      ...secondary,
      ...primary,
      id: primary.id || secondary.id || `sub_${primary.examId}_${primary.studentId}`,
      examId: primary.examId,
      studentId: String(primary.studentId).trim(),
      studentName:
        primary.studentName && primary.studentName !== 'دانش‌آموز'
          ? primary.studentName
          : secondary.studentName || primary.studentName,
      submittedAt: primary.submittedAt || secondary.submittedAt,
      answers: mergedAnswers,
      syncStatus:
        primary.syncStatus === 'synced' || secondary.syncStatus === 'synced'
          ? 'synced'
          : primary.syncStatus,
      isReleased: Boolean(primary.isReleased || secondary.isReleased),
      is_released: Boolean(primary.is_released || secondary.is_released),
      status: anyApproved ? 'graded' : primary.status || secondary.status,
      teacherGrading: anyApproved
        ? (() => {
            const pQ = primary.teacherGrading?.questionScores
            const sQ = secondary.teacherGrading?.questionScores
            const pickedFromPrimaryQ = Boolean(pQ && typeof pQ === 'object' && Object.keys(pQ).length > 0)
            const pickedQScores = pickedFromPrimaryQ
              ? pQ
              : sQ && typeof sQ === 'object' && Object.keys(sQ).length > 0
              ? sQ
              : pQ || sQ

            const pFb = primary.teacherGrading?.questionFeedbacks
            const sFb = secondary.teacherGrading?.questionFeedbacks
            const pickedFeedbacks =
              pickedFromPrimaryQ && pFb && typeof pFb === 'object' && Object.keys(pFb).length > 0
                ? pFb
                : !pickedFromPrimaryQ && sFb && typeof sFb === 'object' && Object.keys(sFb).length > 0
                ? sFb
                : (pFb && typeof pFb === 'object' && Object.keys(pFb).length > 0 ? pFb : sFb)

            const pTot = primary.teacherGrading?.totalScore
            const sTot = secondary.teacherGrading?.totalScore
            const pScaled = primary.teacherGrading?.scaledScore20
            const sScaled = secondary.teacherGrading?.scaledScore20

            const resolvedTotal = (() => {
              if (pickedQScores && typeof pickedQScores === 'object' && Object.keys(pickedQScores).length > 0) {
                const sum = Object.values(pickedQScores).reduce(
                  (acc: number, v: any) => acc + (Number(v) || 0),
                  0
                )
                return roundScore2(sum)
              }
              if (typeof pTot === 'number' && pTot > 0) return pTot
              if (typeof sTot === 'number' && sTot > 0) return sTot
              return pTot !== undefined ? pTot : sTot
            })()

            // Avoid locking a stale 0 scaledScore20 when questionScores sum > 0 (let getSubmissionEffectiveScore compute /20 from questionScores)
            const resolvedScaled = (() => {
              if (pickedFromPrimaryQ) {
                if (typeof pScaled === 'number' && pScaled > 0) return pScaled
                if (resolvedTotal && resolvedTotal > 0) return undefined
              }
              if (typeof pScaled === 'number' && pScaled > 0) return pScaled
              if (typeof sScaled === 'number' && sScaled > 0) return sScaled
              return pScaled !== undefined ? pScaled : sScaled
            })()

            return {
              ...(secondary.teacherGrading || {}),
              ...(primary.teacherGrading || {}),
              manualOverride: Boolean(
                primary.teacherGrading?.manualOverride || secondary.teacherGrading?.manualOverride
              ),
              questionScores: pickedQScores,
              questionFeedbacks: pickedFeedbacks,
              teacherNotes:
                primary.teacherGrading?.teacherNotes ||
                secondary.teacherGrading?.teacherNotes,
              totalScore: resolvedTotal,
              scaledScore20: resolvedScaled,
              approved: true,
            }
          })()
        : primary.teacherGrading || secondary.teacherGrading,
      aiGrading: primary.aiGrading || secondary.aiGrading,
      instantStats: primary.instantStats || secondary.instantStats,
      regradeHistory: combinedHistory.length > 0 ? combinedHistory : undefined,
    }

    map.set(key, merged)
  }

  baseList.forEach(processSub)
  incomingList.forEach(processSub)

  return Array.from(map.values())
}

let legacySnapshotCache: { marker: string; rows: StudentExamSubmission[] } | null = null
let legacySnapshotInFlight: Promise<StudentExamSubmission[]> | null = null

async function fetchLegacySubmissionsSnapshotCached(): Promise<StudentExamSubmission[]> {
  if (legacySnapshotInFlight) return legacySnapshotInFlight
  legacySnapshotInFlight = (async () => {
    // 1. Tiny metadata query to detect whether the snapshot changed since the last download
    let marker: string | null = null
    let rowId: string | null = null
    const meta = await supabase
      .from('posts')
      .select('id, updated_at')
      .eq('title', '__SYSTEM_EXAM_SUBMISSIONS__')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!meta.error) {
      if (!meta.data?.id) return []
      rowId = String(meta.data.id)
      marker = meta.data.updated_at ? `${meta.data.id}:${meta.data.updated_at}` : null
      if (marker && legacySnapshotCache?.marker === marker) return legacySnapshotCache.rows
    }

    // 2. Download the body only when needed
    const query = supabase.from('posts').select('id, body')
    const full = rowId
      ? await query.eq('id', rowId).maybeSingle()
      : await query.eq('title', '__SYSTEM_EXAM_SUBMISSIONS__').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (full.error || !full.data?.body) return legacySnapshotCache?.rows || []
    let parsedRows: StudentExamSubmission[] = []
    try {
      const parsed = typeof full.data.body === 'string' ? JSON.parse(full.data.body) : full.data.body
      parsedRows = Array.isArray(parsed) ? parsed : []
    } catch {
      parsedRows = []
    }
    if (marker) legacySnapshotCache = { marker, rows: parsedRows }
    return parsedRows
  })().finally(() => {
    legacySnapshotInFlight = null
  })
  return legacySnapshotInFlight
}

const inFlightSubsPromises = new Map<string, Promise<StudentExamSubmission[]>>()
const recentSubsFetchAt = new Map<string, number>()
const SUBS_DEDUPE_TTL_MS = 4000

function mapQuizSubmissionRowToSubmission(
  qs: any,
  studentMap: Map<string, string>,
  fallbackExamId?: string
): StudentExamSubmission | null {
  if (!qs || typeof qs !== 'object') return null
  const answersObj = qs.answers || {}
  const targetExamId = qs.quiz_id || answersObj.quiz_id || answersObj.exam_id || fallbackExamId
  if (!targetExamId) return null

  const rawStudentName = answersObj.student_name || studentMap.get(String(qs.student_id || ''))
  const canonRowStudent = resolveStudentFromRecord(qs.student_id, rawStudentName, answersObj.student_national_code)
  const targetStudentId = canonRowStudent?.id || qs.student_id || answersObj.student_national_code
  const targetStudentName = canonRowStudent?.fullName || rawStudentName || 'دانش‌آموز'
  if (!targetStudentId) return null

  const subId = `sub_${targetExamId}_${targetStudentId}`
  const isApproved = Boolean(
    answersObj.teacher_approved ||
      answersObj.approved ||
      answersObj.is_released ||
      answersObj.isReleased
  )
  const rawScore = Number(
    answersObj.raw_score ??
      answersObj.totalScore ??
      answersObj.earnedPoints ??
      answersObj.teacherGrading?.totalScore
  )
  const scaledScore = Number(
    qs.score ??
      answersObj.score ??
      answersObj.scaledScore20 ??
      answersObj.teacherGrading?.scaledScore20
  )
  const existingTeacherGrading = answersObj.teacherGrading || {}
  const qScores = answersObj.questionScores || existingTeacherGrading.questionScores
  const qFeedbacks = answersObj.questionFeedbacks || existingTeacherGrading.questionFeedbacks
  const teacherNotes = answersObj.teacherNotes || existingTeacherGrading.teacherNotes

  let calculatedRaw: number | undefined = !isNaN(rawScore) && rawScore > 0 ? rawScore : undefined
  if (qScores && typeof qScores === 'object' && Object.keys(qScores).length > 0) {
    const sum = Object.values(qScores).reduce((acc: number, v: any) => acc + (Number(v) || 0), 0)
    if (sum > 0) calculatedRaw = roundScore2(sum)
  }
  const validScaled = !isNaN(scaledScore) && scaledScore > 0 ? roundScore2(scaledScore) : undefined

  return {
    id: subId,
    examId: String(targetExamId),
    studentId: String(targetStudentId),
    studentName: targetStudentName,
    submittedAt: qs.submitted_at,
    answers: answersObj,
    syncStatus: 'synced',
    isReleased: isApproved,
    is_released: isApproved,
    status: isApproved ? 'graded' : 'pending_approval',
    teacherGrading: {
      ...existingTeacherGrading,
      totalScore: calculatedRaw,
      scaledScore20: validScaled,
      questionScores: qScores,
      questionFeedbacks: qFeedbacks,
      teacherNotes,
      approved: isApproved,
      approvedAt: answersObj.approved_at || existingTeacherGrading.approvedAt,
    },
  }
}

export async function fetchExamSubmissions(
  examId?: string,
  studentId?: string,
  force = false,
  teacherPassword?: string,
  studentAccessCode?: string
): Promise<StudentExamSubmission[]> {
  const isTeacherQuery = !studentId
  const effectiveTeacherPass = isTeacherQuery ? getStoredTeacherPassword(teacherPassword) : ''
  const dedupeKey = `${examId || '*'}::${studentId || (effectiveTeacherPass ? 'teacher' : 'unauth')}`
  const existingPromise = inFlightSubsPromises.get(dedupeKey)
  if (existingPromise) {
    return existingPromise
  }

  // Never expose all student submissions to unauthenticated callers
  if (isTeacherQuery && !effectiveTeacherPass) {
    console.warn('[ExamStore:fetchExamSubmissions] Blocked unauthenticated teacher submissions query.')
    return []
  }

  const lastAt = recentSubsFetchAt.get(dedupeKey) || 0
  if (!force && Date.now() - lastAt < SUBS_DEDUPE_TTL_MS) {
    let cached = mergeSubmissionsDeduplicated([], getLocalSubmissions())
    if (examId) cached = cached.filter((s) => s.examId === examId)
    if (studentId) cached = cached.filter((s) => isSameStudent(s.studentId, studentId, s.studentName))
    if (cached.length > 0) return cached
  }

  const runPromise = (async () => {
    const fetchedList: StudentExamSubmission[] = []

    // Build targeted Supabase queries in parallel (never call legacy Express-only /api/exams/submissions)
    const canonStudent = studentId ? resolveCanonicalStudent(studentId) : undefined
    const targetStudentUuid = canonStudent?.id && isValidUuid(canonStudent.id)
      ? canonStudent.id
      : (studentId && isValidUuid(studentId) ? studentId : null)
    const effectiveStudentAccessCode = !isTeacherQuery
      ? getStoredStudentAccessCode(targetStudentUuid || studentId, studentAccessCode)
      : ''

    const individualPattern = examId && targetStudentUuid
      ? `__EXAM_SUB__:${examId}:${targetStudentUuid}%`
      : examId && studentId
      ? `__EXAM_SUB__:${examId}:${studentId}%`
      : examId
      ? `__EXAM_SUB__:${examId}:%`
      : targetStudentUuid
      ? `__EXAM_SUB__:%:${targetStudentUuid}%`
      : studentId
      ? `__EXAM_SUB__:%:${studentId}%`
      : '__EXAM_SUB__:%'

    // Primary authoritative quiz_submissions source:
    // - Teacher mode: server-verified RPC `teacher_list_quiz_submissions(p_password)`
    // - Student mode: server-verified RPC `student_list_my_quiz_submissions(p_student_id, p_access_code, p_exam_id)`
    //   with safe pre-migration fallback ONLY if the RPC is not yet installed (42883 / PGRST202).
    const qSubsQuery: Promise<{ data: any; error: any }> = isTeacherQuery
      ? Promise.resolve(supabase.rpc('teacher_list_quiz_submissions', { p_password: effectiveTeacherPass }))
      : targetStudentUuid
      ? (async () => {
          if (effectiveStudentAccessCode) {
            const rpcRes = await supabase.rpc('student_list_my_quiz_submissions', {
              p_student_id: targetStudentUuid,
              p_access_code: effectiveStudentAccessCode,
              p_exam_id: examId && isValidUuid(examId) ? examId : null,
            })
            if (!rpcRes.error || !isMissingRpcFunctionError(rpcRes.error)) {
              return rpcRes
            }
          }
          // Pre-migration fallback ONLY if Phase 1 RPC has not been applied in Supabase yet
          const fallbackQuery = examId
            ? supabase
                .from('quiz_submissions')
                .select('id, quiz_id, student_id, score, submitted_at, answers')
                .eq('student_id', targetStudentUuid)
                .eq('quiz_id', examId)
                .order('submitted_at', { ascending: false })
            : supabase
                .from('quiz_submissions')
                .select('id, quiz_id, student_id, score, submitted_at, answers')
                .eq('student_id', targetStudentUuid)
                .order('submitted_at', { ascending: false })
          return fallbackQuery
        })()
      : Promise.resolve({ data: [], error: null })

    const indQuery = supabase
      .from('posts')
      .select('id, title, body')
      .like('title', individualPattern)
      .order('created_at', { ascending: false })
      .limit(studentId ? 30 : 200)

    const altNationalPattern =
      studentId && canonStudent?.nationalCode && canonStudent.nationalCode !== targetStudentUuid
        ? (examId ? `__EXAM_SUB__:${examId}:${canonStudent.nationalCode}%` : `__EXAM_SUB__:%:${canonStudent.nationalCode}%`)
        : null

    // Legacy class-wide snapshot (can be several MB). Students never download it (it contains every
    // student's answers and made student devices time out); the teacher reads it through a session cache
    // that only re-downloads when the row actually changed.
    const sysSubsQuery: Promise<{ data: any; error: any }> = isTeacherQuery
      ? fetchLegacySubmissionsSnapshotCached().then((rows) => ({ data: { parsedRows: rows }, error: null }))
      : Promise.resolve({ data: null, error: null })

    const studentRosterPromise = isTeacherQuery
      ? supabase.rpc('list_students_public')
      : Promise.resolve({ data: [], error: null })

    const [indRes, altIndRes, qSubsRes, sysRes, rosterRes] = await Promise.allSettled([
      indQuery,
      altNationalPattern
        ? supabase
            .from('posts')
            .select('id, title, body')
            .like('title', altNationalPattern)
            .order('created_at', { ascending: false })
            .limit(30)
        : Promise.resolve({ data: [], error: null }),
      qSubsQuery,
      sysSubsQuery,
      studentRosterPromise,
    ])

    // Enforce server-side teacher authentication: if RPC explicitly rejected credentials, fail closed
    if (isTeacherQuery && qSubsRes.status === 'fulfilled' && qSubsRes.value.error) {
      const rpcErr: any = qSubsRes.value.error
      const errMsg = String(rpcErr?.message || '').toLowerCase()
      const errCode = String(rpcErr?.code || '')
      if (
        errCode === '42501' ||
        errMsg.includes('unauthorized') ||
        errMsg.includes('invalid password') ||
        errMsg.includes('forbidden')
      ) {
        const authErr: any = new Error(rpcErr?.message || 'Unauthorized teacher')
        authErr.code = errCode || '42501'
        authErr.status = 401
        throw authErr
      }
      console.warn('[ExamStore:fetchExamSubmissions] teacher_list_quiz_submissions warning:', rpcErr)
    }

    const pushValidatedIndPost = (row: any) => {
      if (!row?.body) return
      try {
        const titleParts = String(row.title || '').split(':')
        const titleExamId = titleParts[1]
        const parsed = typeof row.body === 'string' ? JSON.parse(row.body) : row.body
        if (!parsed || !parsed.examId || !parsed.studentId) return
        // Reject cross-exam corrupted posts where title prefix examId disagrees with body.examId
        if (titleExamId && parsed.examId !== titleExamId) return
        if (examId && parsed.examId !== examId) return
        if (studentId && !isSameStudent(parsed.studentId, studentId, parsed.studentName)) return
        fetchedList.push(parsed)
      } catch {}
    }

    if (altIndRes.status === 'fulfilled' && !altIndRes.value.error && Array.isArray(altIndRes.value.data)) {
      altIndRes.value.data.forEach(pushValidatedIndPost)
    }

    // 1. Individual submissions __EXAM_SUB__:%
    if (indRes.status === 'fulfilled' && !indRes.value.error && Array.isArray(indRes.value.data)) {
      indRes.value.data.forEach(pushValidatedIndPost)
    }

    // 2. Primary authoritative quiz_submissions rows
    if (qSubsRes.status === 'fulfilled' && !qSubsRes.value.error && Array.isArray(qSubsRes.value.data) && qSubsRes.value.data.length > 0) {
      const studentMap = new Map<string, string>()
      if (rosterRes.status === 'fulfilled' && !rosterRes.value.error && Array.isArray(rosterRes.value.data)) {
        rosterRes.value.data.forEach((st: any) => {
          if (st?.id && st?.full_name) studentMap.set(String(st.id), String(st.full_name))
        })
      }

      qSubsRes.value.data.forEach((qs: any) => {
        const mapped = mapQuizSubmissionRowToSubmission(qs, studentMap, examId)
        if (!mapped) return
        if (examId && mapped.examId !== examId) return
        if (studentId && !isSameStudent(mapped.studentId, studentId, mapped.studentName)) return
        fetchedList.push(mapped)
      })
    }

    // 3. Authoritative __SYSTEM_EXAM_SUBMISSIONS__ snapshot (for legacy teacher approvals/regrades)
    if (sysRes.status === 'fulfilled' && !sysRes.value.error && Array.isArray(sysRes.value.data?.parsedRows)) {
      try {
        const parsed = sysRes.value.data.parsedRows
        if (Array.isArray(parsed)) {
          parsed.forEach((s: StudentExamSubmission) => {
            if (s && s.examId && s.studentId) {
              if (examId && s.examId !== examId) return
              if (studentId && !isSameStudent(s.studentId, studentId, s.studentName)) return
              fetchedList.push(s)
            }
          })
        }
      } catch {}
    }

    const deduplicated = mergeSubmissionsDeduplicated(getLocalSubmissions(), fetchedList)
    saveLocalSubmissions(deduplicated)
    recentSubsFetchAt.set(dedupeKey, Date.now())

    let filtered = deduplicated
    if (examId) filtered = filtered.filter((s) => s.examId === examId)
    if (studentId) filtered = filtered.filter((s) => isSameStudent(s.studentId, studentId, s.studentName))

    return filtered
  })().finally(() => {
    inFlightSubsPromises.delete(dedupeKey)
  })

  inFlightSubsPromises.set(dedupeKey, runPromise)
  return runPromise
}

export function getExamSubmissions(examId: string): StudentExamSubmission[] {
  // Pure synchronous cache read — never trigger side-effect network storms inside render loops!
  const local = getLocalSubmissions().filter((s) => s.examId === examId)
  return mergeSubmissionsDeduplicated([], local)
}

export function getStudentExamSubmission(examId: string, studentId: string): StudentExamSubmission | undefined {
  const subs = getExamSubmissions(examId)
  return subs.find(
    (s) =>
      String(s.studentId).trim() === String(studentId).trim() ||
      isSameStudent(s.studentId, studentId, s.studentName)
  )
}

/**
 * Preview regrading previous exam submissions using the corrected semantic algorithm.
 * Compares stored scores vs new calculated scores per student and question without mutating state.
 */
export async function previewRegradeExamSubmissions(
  examId: string,
  teacherPassword?: string
): Promise<RegradePreviewResult> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  const exams = await fetchAllExams(teacherPass)
  const exam = exams.find((e) => e.id === examId)
  if (!exam) throw new Error(`آزمون با شناسه ${examId} یافت نشد.`)

  const submissions = await fetchExamSubmissions(examId, undefined, true, teacherPass)
  const items: RegradeDiffItem[] = []
  let submissionsWithChanges = 0
  let approvedCount = 0

  for (const sub of submissions) {
    const isApproved = Boolean(sub.teacherGrading?.approved)
    if (isApproved) approvedCount++

    // Determine current stored score
    const currentScore = Number(
      isApproved
        ? (sub.teacherGrading?.totalScore ?? sub.aiGrading?.totalScore ?? sub.instantStats?.earnedPoints ?? 0)
        : (sub.aiGrading?.totalScore ?? sub.instantStats?.earnedPoints ?? 0)
    )
    const currentScaled20 = Number(
      isApproved
        ? (sub.teacherGrading?.scaledScore20 ?? sub.aiGrading?.scaledScore20 ?? sub.instantStats?.scaledScore20 ?? 0)
        : (sub.aiGrading?.scaledScore20 ?? sub.instantStats?.scaledScore20 ?? 0)
    )

    // Re-evaluate deterministically with updated semantic grader
    const evalResult = evaluateEntireExamSubmission(exam, sub.answers || {})
    const newScore = evalResult.earnedPoints
    const newScaled20 = evalResult.scaledScore20
    const scoreDiff = Math.round((newScore - currentScore) * 100) / 100

    const questionDiffs: RegradeQuestionDiff[] = []
    for (const q of exam.questions) {
      const oldQScore = Number(
        isApproved
          ? (sub.teacherGrading?.questionScores?.[q.id] ?? sub.aiGrading?.questionScores?.[q.id] ?? 0)
          : (sub.aiGrading?.questionScores?.[q.id] ?? 0)
      )
      const newQScore = evalResult.questionScores[q.id] ?? 0
      const oldFb = sub.teacherGrading?.questionFeedbacks?.[q.id] || sub.aiGrading?.questionFeedbacks?.[q.id]
      const newFb = evalResult.questionFeedbacks[q.id]

      if (Math.abs(newQScore - oldQScore) > 0.01) {
        questionDiffs.push({
          questionId: q.id,
          questionType: q.type,
          questionTitle: q.question,
          oldScore: oldQScore,
          newScore: newQScore,
          maxPoints: Number(q.points) || 2,
          oldFeedback: oldFb,
          newFeedback: newFb,
        })
      }
    }

    if (Math.abs(scoreDiff) > 0.01 || questionDiffs.length > 0) {
      submissionsWithChanges++
    }

    items.push({
      submissionId: sub.id,
      studentId: sub.studentId,
      studentName: sub.studentName || 'دانش‌آموز',
      examId: sub.examId,
      oldScore: currentScore,
      newScore,
      scoreDiff,
      oldScaledScore20: currentScaled20,
      newScaledScore20: newScaled20,
      isApproved,
      questionDiffs,
    })
  }

  return {
    examId,
    examTitle: exam.title,
    totalSubmissions: submissions.length,
    submissionsWithChanges,
    approvedCount,
    items,
  }
}

/**
 * Applies regrading to previous submissions:
 * - If teacher has approved score and overrideApproved is false: teacher manual grade is strictly preserved.
 * - If overrideApproved is true or submission is pending: updates score with corrected calculation.
 * - Appends audit record to regradeHistory to prevent duplicate or untracked changes.
 * - Syncs to Supabase.
 */
export async function applyRegradeExamSubmissions(params: {
  examId: string
  overrideApproved?: boolean
  teacherPassword?: string
}): Promise<{ updatedCount: number; submissions: StudentExamSubmission[]; gradeSyncSummary?: GradebookBatchSyncSummary }> {
  const { examId, overrideApproved = false, teacherPassword } = params
  const exams = await fetchAllExams(teacherPassword)
  const exam = exams.find((e) => e.id === examId)
  if (!exam) throw new Error(`آزمون با شناسه ${examId} یافت نشد.`)

  const submissions = await fetchExamSubmissions(examId, undefined, true, teacherPassword)
  const allLocal = mergeSubmissionsDeduplicated(getLocalSubmissions(), submissions)
  let updatedCount = 0
  const nowIso = new Date().toISOString()
  const syncedApprovedSubs: StudentExamSubmission[] = []

  for (let i = 0; i < allLocal.length; i++) {
    const sub = allLocal[i]
    if (sub.examId !== examId) continue

    const isApproved = Boolean(sub.teacherGrading?.approved)
    const oldScore = Number(
      isApproved
        ? (sub.teacherGrading?.totalScore ?? sub.aiGrading?.totalScore ?? 0)
        : (sub.aiGrading?.totalScore ?? sub.instantStats?.earnedPoints ?? 0)
    )
    const oldScaled20 = Number(
      isApproved
        ? (sub.teacherGrading?.scaledScore20 ?? sub.aiGrading?.scaledScore20 ?? 0)
        : (sub.aiGrading?.scaledScore20 ?? sub.instantStats?.scaledScore20 ?? 0)
    )

    // Re-evaluate deterministically
    const evalResult = evaluateEntireExamSubmission(exam, sub.answers || {})
    const newScore = evalResult.earnedPoints
    const newScaled20 = evalResult.scaledScore20
    const scoreDiff = Math.round((newScore - oldScore) * 100) / 100

    const shouldUpdateOfficial = !isApproved || overrideApproved

    const auditEntry: RegradeAuditRecord = {
      regradedAt: nowIso,
      oldScore,
      newScore,
      scoreDiff,
      oldScaledScore20: oldScaled20,
      newScaledScore20: newScaled20,
      teacherOverrodeApproved: isApproved && overrideApproved,
      reason:
        isApproved && !overrideApproved
          ? 'الگوریتم تصحیح هوشمند اصلاح شد اما نمره دستی آموزگار حفظ گردید.'
          : 'بازتصحیح خودکار با الگوریتم اصلاح‌شده تصحیح مفهومی.',
    }

    sub.regradeHistory = [...(sub.regradeHistory || []), auditEntry]

    sub.aiGrading = {
      ...(sub.aiGrading || {}),
      questionScores: evalResult.questionScores,
      questionFeedbacks: evalResult.questionFeedbacks,
      totalScore: newScore,
      scaledScore20: newScaled20,
      gradedAt: nowIso,
      summary: sub.aiGrading?.summary || `بازتصحیح انجام شد. نمره: ${newScore} از ${exam.totalPoints || 20}`,
    }

    sub.instantStats = {
      totalQuestions: evalResult.totalQuestions,
      answeredCount: evalResult.answeredCount,
      unansweredCount: evalResult.unansweredCount,
      correctCount: evalResult.correctCount,
      wrongCount: evalResult.wrongCount,
      percentage: evalResult.percentage,
      scaledScore20: newScaled20,
      earnedPoints: newScore,
      maxPoints: evalResult.maxPoints,
      status: evalResult.status,
    }

    if (shouldUpdateOfficial) {
      if (isApproved && overrideApproved) {
        sub.teacherGrading = {
          ...(sub.teacherGrading || {}),
          manualOverride: true,
          questionScores: evalResult.questionScores,
          questionFeedbacks: evalResult.questionFeedbacks,
          totalScore: newScore,
          scaledScore20: newScaled20,
          approved: true,
          approvedAt: nowIso,
          teacherNotes: `${sub.teacherGrading?.teacherNotes || ''} (بازتصحیح هوشمند با اجازه آموزگار اعمال شد)`.trim(),
        }
        syncedApprovedSubs.push(sub)
      } else if (!isApproved) {
        sub.teacherGrading = {
          ...(sub.teacherGrading || {}),
          questionScores: evalResult.questionScores,
          questionFeedbacks: evalResult.questionFeedbacks,
          totalScore: newScore,
          scaledScore20: newScaled20,
          approved: false,
        }
      }
      updatedCount++
    }

    allLocal[i] = sub
  }

  // Deduplicate and save
  const cleanSubs = mergeSubmissionsDeduplicated([], allLocal)
  saveLocalSubmissions(cleanSubs)

  // Merge ONLY this exam's submissions into remote __SYSTEM_EXAM_SUBMISSIONS__
  const updatedForThisExam = cleanSubs.filter((s) => s.examId === examId)
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  await syncExamSubmissionsToSupabase(updatedForThisExam, teacherPass, { preserveExplicitUpdates: true }).catch((e) =>
    console.warn('[applyRegradeExamSubmissions] Supabase sync warning:', e)
  )
  let gradeSyncSummary: GradebookBatchSyncSummary | undefined
  if (syncedApprovedSubs.length > 0) {
    await Promise.allSettled(
      syncedApprovedSubs.flatMap((s) => [
        syncIndividualExamSubPost(s, exam),
        syncQuizSubmissionScoreToSupabase(s, exam, teacherPass),
      ])
    )
    gradeSyncSummary = await syncApprovedSubmissionsBatchToGradebook({
      exam,
      submissions: syncedApprovedSubs,
      teacherPassword: teacherPass,
    })
  }

  const updatedForExam = cleanSubs.filter((s) => s.examId === examId)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('exam_submission_updated', { detail: { examId } }))
  }

  return {
    updatedCount,
    submissions: updatedForExam,
    gradeSyncSummary,
  }
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
    return await convertPracticeToQuestionsHybrid(text, subject, teacherPassword)
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
      const mcResult = evaluateMultipleChoice(q, studentAns)
      questionScores[q.id] = mcResult.score
      questionFeedbacks[q.id] = mcResult.feedback
      totalScore += mcResult.score
    } else if (q.type === 'fill_in_the_blank') {
      const fibResult = evaluateFillInTheBlank(q, studentAns)
      // If full semantic match, record immediately; if partial or complex, also queue for AI review
      questionScores[q.id] = fibResult.score
      questionFeedbacks[q.id] = fibResult.feedback
      totalScore += fibResult.score
      if (fibResult.status !== 'correct' && fibResult.status !== 'empty') {
        complexQuestionsToGrade.push({ q, ans: studentAns })
      }
    } else {
      complexQuestionsToGrade.push({ q, ans: studentAns })
    }
  }

  // Include rich contextual data for the personalized teacher note & descriptive grading
  const allQuestionsData = exam.questions.map((q) => {
    const ans = answers[q.id]
    let stAns = 'بدون پاسخ'
    if (ans) {
      if (q.type === 'multiple_choice') {
        const resolvedC = resolveCorrectOptionIndex(q)
        const resolvedS = resolveStudentSelectedOption(ans, q.options)
        stAns = resolvedS.isValid
          ? `${resolvedS.label} (${resolvedS.text}) - کلید صحیح: ${resolvedC.label} (${resolvedC.text})`
          : 'بدون پاسخ'
      } else {
        stAns = ans.textAnswer || (ans.imageAttachment ? '[تصویر برگه ارسال شده]' : 'بدون پاسخ')
      }
    }
    return {
      id: q.id,
      type: q.type,
      question: q.question,
      points: safeScore(q.points, 10, 2),
      rubric: q.rubricOrHint || q.correctAnswer || '',
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
          const maxPts = safeScore(matchingQ.points, 10, 2)
          const assignedScore = safeScore(item.score, maxPts)
          // Subtract old score before adding AI verified score
          totalScore -= (questionScores[item.id] || 0)
          questionScores[item.id] = assignedScore
          questionFeedbacks[item.id] = item.feedback || `نمره پیشنهادی: ${assignedScore} از ${maxPts}`
          totalScore += assignedScore
        }
      }
    }
  } catch (e) {
    console.warn('Hybrid grading request failed, using semantic heuristic evaluation', e)
  }

  // Heuristic semantic fallback for complex questions if server did not score them
  for (const { q, ans } of complexQuestionsToGrade) {
    if (questionScores[q.id] === undefined) {
      const qPts = safeScore(q.points, 10, 2)
      if (q.type === 'fill_in_the_blank') {
        const fib = evaluateFillInTheBlank(q, ans)
        questionScores[q.id] = fib.score
        questionFeedbacks[q.id] = fib.feedback
        totalScore += fib.score
      } else {
        const desc = evaluateDescriptiveQuestion(q, ans)
        questionScores[q.id] = desc.score
        questionFeedbacks[q.id] = desc.feedback
        totalScore += desc.score
      }
    }
  }

  // Generate personalized teacher note if server note wasn't returned
  const maxExamPoints = safeNumber(exam.totalPoints, 20) || 20
  totalScore = safeScore(totalScore, maxExamPoints)
  const scaledScore20 = safeScaled20(totalScore, maxExamPoints)

  if (!serverTeacherNote) {
    const ratio = totalScore / maxExamPoints
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
    totalScore: roundScore2(totalScore),
    scaledScore20,
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
  const subStId = String(sub.studentId).trim()
  const idx = all.findIndex(
    (s) =>
      (s.examId === sub.examId && String(s.studentId).trim() === subStId) ||
      s.id === sub.id
  )
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...sub }
  } else {
    all.push(sub)
  }
  const clean = mergeSubmissionsDeduplicated([], all)
  saveLocalSubmissions(clean)
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
  const result = evaluateEntireExamSubmission(exam, answers)
  return {
    totalQuestions: result.totalQuestions,
    answeredCount: result.answeredCount,
    unansweredCount: result.unansweredCount,
    correctCount: result.correctCount,
    wrongCount: result.wrongCount,
    earnedPoints: result.earnedPoints,
    maxPoints: result.maxPoints,
    percentage: result.percentage,
    scaledScore20: result.scaledScore20,
    questionScores: result.questionScores,
    questionFeedbacks: result.questionFeedbacks,
    status: result.status,
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
  studentAccessCode?: string
  /** Suspicious-activity log recorded during a timed online exam (shown to the teacher) */
  integrity?: { events: any[]; summary: any }
}): StudentExamSubmission {
  const { exam, studentId, studentName, answers, studentAccessCode, integrity } = params

  // 1. Instant client-side deterministic evaluation (< 5ms)
  // Check if exam questions have correct answers available (e.g. offline/teacher mode).
  // If keys were stripped for student exam security, do NOT calculate instant 0 scores!
  const hasKeys = Array.isArray(exam.questions) && exam.questions.some((q) => q.correctAnswer !== undefined)
  const maxExamPoints = getExamMaxPoints(exam)
  const instant = hasKeys
    ? computeInstantExamResult(exam, answers)
    : {
        totalQuestions: exam.questions.length,
        answeredCount: Object.keys(answers).length,
        unansweredCount: Math.max(0, exam.questions.length - Object.keys(answers).length),
        correctCount: 0,
        wrongCount: 0,
        earnedPoints: 0,
        maxPoints: maxExamPoints,
        percentage: 0,
        scaledScore20: 0,
        questionScores: {} as Record<string, number>,
        questionFeedbacks: {} as Record<string, string>,
        status: 'good' as const,
      }

  const canonSubmitter = resolveCanonicalStudent(studentId || studentName)
  const canonicalStudentId = canonSubmitter?.id || String(studentId).trim()
  const canonicalStudentName = canonSubmitter?.fullName || studentName
  const submissionId = `sub_${exam.id}_${canonicalStudentId}_${Date.now()}`
  const optimisticSubmission: StudentExamSubmission = {
    id: submissionId,
    examId: exam.id,
    studentId: canonicalStudentId,
    studentName: canonicalStudentName,
    submittedAt: new Date().toISOString(),
    answers,
    syncStatus: 'syncing',
    isOptimistic: true,
    ...(integrity && Array.isArray(integrity.events) ? { integrity } : {}),
    isReleased: false,
    is_released: false,
    status: 'pending_approval',
    instantStats: hasKeys
      ? {
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
        }
      : {
          totalQuestions: instant.totalQuestions,
          answeredCount: instant.answeredCount,
          unansweredCount: instant.unansweredCount,
          correctCount: 0,
          wrongCount: 0,
          percentage: 0,
          scaledScore20: 0,
          earnedPoints: 0,
          maxPoints: maxExamPoints,
          status: 'good',
        },
    aiGrading: hasKeys
      ? {
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
        }
      : {
          questionScores: {},
          questionFeedbacks: {},
          totalScore: 0,
          scaledScore20: 0,
          gradedAt: new Date().toISOString(),
          summary: `پاسخ‌های شما با موفقیت دریافت شد و پس از بررسی و تایید آموزگار در کارنامه درج خواهد شد.`,
        },
    teacherGrading: hasKeys
      ? {
          approved: false,
          questionScores: instant.questionScores,
          questionFeedbacks: instant.questionFeedbacks,
          totalScore: instant.earnedPoints,
          scaledScore20: instant.scaledScore20,
          teacherNotes: `پاسخ‌های ${studentName} دریافت و در صف بازبینی آموزگار قرار گرفت.`,
        }
      : {
          approved: false,
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
    runBackgroundExamSync(optimisticSubmission, exam, studentAccessCode).catch((e) => {
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
  studentAccessCode?: string
  integrity?: { events: any[]; summary: any }
}): Promise<StudentExamSubmission> {
  return submitStudentExamOptimistic(params)
}

/**
 * Asynchronous background worker: Saves directly to Supabase posts & quiz_submissions,
 * and pings local server if present.
 */
export async function runBackgroundExamSync(
  submission: StudentExamSubmission,
  exam: Exam,
  studentAccessCode?: string
): Promise<void> {
  try {
    // A. Direct Supabase Persistence: authenticated quiz_submissions RPC + posts table
    const syncedOk = await saveExamSubmissionDirectToSupabase(submission, exam, undefined, studentAccessCode)
    if (!syncedOk) {
      throw new Error('Supabase direct persistence returned false')
    }

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
let pendingQueueFlushInFlight: Promise<void> | null = null

export async function flushPendingExamSyncQueue(): Promise<void> {
  if (pendingQueueFlushInFlight) return pendingQueueFlushInFlight
  const queue = getPendingExamSyncQueue()
  if (queue.length === 0) return

  pendingQueueFlushInFlight = (async () => {
    for (const item of queue) {
      try {
        await runBackgroundExamSync(item.submission, item.exam)
      } catch (e) {
        console.warn('[Pending Queue Flush] Item error:', item.id, e)
      }
    }
  })().finally(() => {
    pendingQueueFlushInFlight = null
  })
  return pendingQueueFlushInFlight
}

// Keep retrying unsent exam answers every 30s while the app is open (never lose a student's submission)
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (getPendingExamSyncQueue().length === 0) return
    flushPendingExamSyncQueue().catch(() => {})
  }, 30000)
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
}): Promise<StudentExamSubmission & { gradeSync?: GradebookUpsertResult }> {
  const { submissionId, exam, studentId, approvedScores, teacherNotes, teacherPassword } = params

  const teacherPass = getStoredTeacherPassword(teacherPassword)

  let all = mergeSubmissionsDeduplicated([], getLocalSubmissions())
  let sub = all.find(
    (s) =>
      s.id === submissionId ||
      (s.examId === exam.id && isSameStudent(s.studentId, studentId, s.studentName))
  )
  if (!sub) {
    try {
      const remote = await fetchExamSubmissions(exam.id, undefined, true, teacherPass)
      all = mergeSubmissionsDeduplicated(all, remote)
      sub = all.find(
        (s) =>
          s.id === submissionId ||
          (s.examId === exam.id && isSameStudent(s.studentId, studentId, s.studentName))
      )
    } catch {}
  }
  if (!sub) throw new Error('پاسخ آزمون یافت نشد.')

  const rosterStudent = resolveCanonicalStudent(studentId || sub.studentId || sub.studentName)
  const canonicalStudentId = rosterStudent?.id || sub.studentId || studentId
  sub.studentId = canonicalStudentId
  if (rosterStudent?.fullName) sub.studentName = rosterStudent.fullName

  let totalScore = 0
  const cleanScores: Record<string, number> = {}
  for (const q of exam.questions) {
    const qPts = safeScore(q.points, 1000, 2)
    const val = approvedScores[q.id] ?? (sub.aiGrading?.questionScores?.[q.id] || 0)
    const valid = safeScore(val, qPts)
    cleanScores[q.id] = valid
    totalScore += valid
  }
  const maxExamPts = getExamMaxPoints(exam)
  totalScore = safeScore(totalScore, maxExamPts)
  const scaledScore20 = safeScaled20(totalScore, maxExamPts)

  sub.isReleased = true
  sub.is_released = true
  sub.status = 'graded'
  sub.earnedPoints = totalScore
  sub.totalScore = totalScore
  sub.scaledScore20 = scaledScore20

  if (!sub.instantStats) {
    sub.instantStats = {
      totalQuestions: exam.questions?.length || 9,
      answeredCount: Object.keys(sub.answers || {}).length,
      unansweredCount: Math.max(0, (exam.questions?.length || 9) - Object.keys(sub.answers || {}).length),
      correctCount: 0,
      wrongCount: 0,
      percentage: Math.round((totalScore / maxExamPts) * 100),
      scaledScore20,
      earnedPoints: totalScore,
      maxPoints: maxExamPts,
      status: scaledScore20 >= 16 ? 'excellent' : scaledScore20 >= 12 ? 'good' : 'needs_practice',
    }
  } else {
    sub.instantStats.earnedPoints = totalScore
    sub.instantStats.scaledScore20 = scaledScore20
    sub.instantStats.maxPoints = maxExamPts
    sub.instantStats.percentage = Math.round((totalScore / maxExamPts) * 100)
    sub.instantStats.status = scaledScore20 >= 16 ? 'excellent' : scaledScore20 >= 12 ? 'good' : 'needs_practice'
  }

  sub.teacherGrading = {
    approved: true,
    manualOverride: true,
    questionScores: cleanScores,
    questionFeedbacks: sub.teacherGrading?.questionFeedbacks || sub.aiGrading?.questionFeedbacks,
    teacherNotes: teacherNotes || 'تایید شده توسط آموزگار محترم',
    totalScore,
    scaledScore20,
    approvedAt: new Date().toISOString(),
  }

  const dedupedAll = mergeSubmissionsDeduplicated([], all)
  saveLocalSubmissions(dedupedAll)
  notifySubmissionUpdated(sub)

  // Clear stale cached student grades in localStorage
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`cached_grades_${studentId}`)
      localStorage.removeItem(`cached_grades_${sub.studentId}`)
      if (rosterStudent?.nationalCode) localStorage.removeItem(`cached_grades_${rosterStudent.nationalCode}`)
    }
  } catch {}

  // 1. Authoritative Backend Server API Call (Persists directly to server memory and disk backup)
  if (!isBackendStaticOnly()) {
    try {
      await fetchWithTimeout(
        '/api/exams/approve',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-teacher-password': teacherPass,
          },
          body: JSON.stringify({
            submissionId: sub.id,
            approvedScores: cleanScores,
            teacherNotes: teacherNotes || 'تایید شده توسط آموزگار محترم',
            teacherPassword: teacherPass,
          }),
        },
        6000
      )
    } catch (err) {
      console.warn('[approveExamSubmission] Backend /api/exams/approve warning:', err)
    }
  }

  // 2. Per-student independent sync to Supabase (__EXAM_SUB__, quiz_submissions) + safe merge into __SYSTEM_EXAM_SUBMISSIONS__
  try {
    await Promise.allSettled([
      syncExamSubmissionsToSupabase([sub], teacherPass, { preserveExplicitUpdates: true }),
      syncIndividualExamSubPost(sub, exam),
      syncQuizSubmissionScoreToSupabase(sub, exam, teacherPass),
    ])
  } catch (err) {
    console.warn('[approveExamSubmission] Failed to sync approval to Supabase:', err)
  }

  // 3. Persist grade independently to PostgreSQL `grades` table by canonical student ID & capture real result/error
  let gradeSync: GradebookUpsertResult = {
    ok: true,
    action: 'skipped',
    studentId: canonicalStudentId,
    studentName: sub.studentName || rosterStudent?.fullName,
    scaledScore20,
  }

  if (canonicalStudentId && !isTestStudentRecord(canonicalStudentId, sub.studentName || rosterStudent?.fullName)) {
    gradeSync = await upsertGradebookExamRow({
      teacherPassword: teacherPass,
      studentId: canonicalStudentId,
      studentName: sub.studentName || rosterStudent?.fullName,
      exam,
      scaledScore20,
    })
  }

  return Object.assign(sub, { gradeSync })
}

/**
 * Single Authoritative Canonical Gradebook & Report-Card Resolver:
 * Used identically by TeacherDashboard, StudentDashboard, StudentReportCard, and parity tests.
 * Guarantees 0 discrepancies across panels for every student and every exam.
 */
export function buildCanonicalGradesList(params: {
  studentId: string
  studentName?: string
  dbGrades: any[]
  exams: Exam[]
  examSubmissions: StudentExamSubmission[]
  homeworkPosts?: any[]
  homeworkSubmissions?: any[]
  includePending?: boolean
  /** Teacher gradebook: every recorded grade is shown, regardless of whether results were released to students */
  teacherView?: boolean
}): any[] {
  const {
    studentId,
    studentName,
    dbGrades = [],
    exams = [],
    examSubmissions = [],
    homeworkPosts = [],
    homeworkSubmissions = [],
    includePending = false,
    teacherView = false,
  } = params

  const canonStudent = resolveCanonicalStudent(studentId || studentName)
  const targetStudentId = canonStudent?.id || String(studentId || '').trim()
  const targetStudentName = canonStudent?.fullName || studentName

  const dedupedSubs = mergeSubmissionsDeduplicated([], examSubmissions).filter((s) =>
    isSameStudent(s.studentId, targetStudentId, s.studentName, targetStudentName)
  )
  const examMap = new Map(exams.map((e) => [e.id, e]))
  const subMap = new Map(dedupedSubs.map((s) => [s.examId, s]))

  const list: any[] = []
  const seenExamIds = new Set<string>()
  const seenTitles = new Set<string>()

  const cleanDbGrades = [...dbGrades]
    .filter((g) => !g?.student_id || isSameStudent(g.student_id, targetStudentId, g.student_name, targetStudentName))
    .sort((a: any, b: any) => {
      const ta = a?.recorded_at ? new Date(a.recorded_at).getTime() : 0
      const tb = b?.recorded_at ? new Date(b.recorded_at).getTime() : 0
      return tb - ta
    })

  // 1. Process authoritative DB grades (deduplicated newest-first per subject/skill)
  for (const g of cleanDbGrades) {
    let matchedExam: Exam | null = g.matchedExam || g.exam || (g.examId ? examMap.get(g.examId) || null : null)
    let matchedSub: StudentExamSubmission | null =
      g.matchedSub || g.sub || (g.examId ? subMap.get(g.examId) || null : null)

    if (!matchedExam) {
      matchedExam =
        exams.find((e) => {
          if (g.examId && e.id === g.examId) return true
          if (g.id && (`exam_sub_${e.id}` === g.id || `exam_${e.id}` === g.id)) return true
          const cleanE = sanitizeExamTitle(e.title, e.subject)
          const cleanG = sanitizeExamTitle(g.skill || '', g.subject)
          return cleanE && cleanG && (cleanE === cleanG || String(g.skill || '').includes(cleanE))
        }) || null
    }

    const cleanTitleKey = sanitizeExamTitle(g.skill || '', g.subject || 'عمومی')
      .replace(/^آزمون:\s*/u, '')
      .replace(/^تکلیف:\s*/u, '')
      .trim()
    const subjectTitleKey = `${String(g.subject || 'عمومی').trim()}::${cleanTitleKey}`

    if (matchedExam && seenExamIds.has(matchedExam.id)) continue
    if (cleanTitleKey && (seenTitles.has(subjectTitleKey) || seenTitles.has(cleanTitleKey))) continue

    if (matchedExam && !matchedSub) {
      matchedSub = subMap.get(matchedExam.id) || null
    }

    let officialScore = Number(g.score) || 0
    let officialMaxScore = Number(g.max_score) || 20
    let rawEarned: number | undefined = (g as any).raw_score
    let rawTotal: number | undefined = (g as any).raw_max
    let officialNotes = g.notes || ''
    let itemStatus: 'graded' | 'pending_review' | 'pending_submission' = 'graded'

    // The row in the `grades` table is the OFFICIAL recorded score (written on approval, regrade and manual
    // edits) and is always stored /20. Answer-sheet data is only used to enrich it, or when it is provably newer.
    const dbScaled20 =
      officialMaxScore > 0 && officialMaxScore !== 20
        ? safeScaled20(officialScore, officialMaxScore)
        : safeScaled20(officialScore, 20)

    if (matchedExam && matchedSub) {
      const eff = getSubmissionEffectiveScore(matchedExam, matchedSub)
      const isApproved = isSubmissionApprovedByTeacher(matchedSub) && eff.isApproved
      const isReleased = isExamResultsReleased(matchedExam, matchedSub)
      const examPublished = Boolean(
        matchedExam.resultsPublished ||
          matchedExam.results_published ||
          matchedExam.isResultsReleased ||
          (matchedExam as any).resultsReleased
      )
      const visible = teacherView || examPublished || (isApproved && isReleased)

      if (visible) {
        const qScores = matchedSub.teacherGrading?.questionScores
        const subHasExactBreakdown = Boolean(qScores && typeof qScores === 'object' && Object.keys(qScores).length > 0)
        const gRecordedMs = g.recorded_at ? new Date(g.recorded_at).getTime() : 0
        const subApprovedMs = matchedSub.teacherGrading?.approvedAt
          ? new Date(matchedSub.teacherGrading.approvedAt).getTime()
          : 0
        const subIsNewer =
          isApproved && subHasExactBreakdown && subApprovedMs > 0 && gRecordedMs > 0 && subApprovedMs > gRecordedMs + 1000

        officialScore = subIsNewer ? eff.scaledScore20 : dbScaled20
        officialMaxScore = 20
        const examMax = getExamMaxPoints(matchedExam)
        rawTotal = examMax
        rawEarned = roundScore2((officialScore / 20) * examMax)
        officialNotes = matchedSub.teacherGrading?.teacherNotes || officialNotes
        itemStatus = 'graded'
      } else {
        itemStatus = 'pending_review'
        rawEarned = undefined
        rawTotal = getExamMaxPoints(matchedExam)
      }
    } else {
      if (officialMaxScore > 0 && officialMaxScore !== 20) {
        rawEarned = roundScore2(officialScore)
        rawTotal = officialMaxScore
      }
      officialScore = dbScaled20
      officialMaxScore = 20
    }

    if (itemStatus === 'graded') {
      officialScore = safeScaled20(officialScore, 20)
      officialMaxScore = 20
    }

    if (matchedExam && rawEarned === undefined && itemStatus === 'graded') {
      const examMax = getExamMaxPoints(matchedExam)
      rawEarned = roundScore2((officialScore / 20) * examMax)
      rawTotal = examMax
    }

    if (itemStatus !== 'graded' && !includePending) {
      continue
    }

    if (matchedExam) seenExamIds.add(matchedExam.id)
    if (cleanTitleKey) {
      seenTitles.add(subjectTitleKey)
      seenTitles.add(cleanTitleKey)
    }

    const isExplicitGradebookUuid = Boolean(
      g.id && !String(g.id).startsWith('exam_sub_') && !String(g.id).startsWith('exam_') && !String(g.id).startsWith('pending_')
    )

    list.push({
      ...g,
      student_id: targetStudentId,
      status: itemStatus,
      score: itemStatus === 'graded' ? officialScore : null,
      max_score: 20,
      raw_score: rawEarned,
      raw_max: rawTotal,
      notes: officialNotes,
      is_exam: Boolean(matchedExam || g.is_exam),
      examId: matchedExam?.id || g.examId,
      matchedExam,
      matchedSub,
      isPersistedInGradesTable: isExplicitGradebookUuid,
      gradeSource: isExplicitGradebookUuid ? 'grades_table' : 'exam_submissions_fallback',
    })
  }

  // 2. Process all student exam submissions not yet represented in DB grades
  for (const sub of dedupedSubs) {
    const exam = examMap.get(sub.examId)
    if (!exam) continue
    if (seenExamIds.has(exam.id)) continue

    const cleanTitle = sanitizeExamTitle(exam.title, exam.subject)
    const subjectTitleKey = `${String(exam.subject || 'عمومی').trim()}::${cleanTitle}`
    if (seenTitles.has(subjectTitleKey) || seenTitles.has(cleanTitle)) continue

    const eff = getSubmissionEffectiveScore(exam, sub)
    const isApproved = isSubmissionApprovedByTeacher(sub) && eff.isApproved
    const isReleased = isExamResultsReleased(exam, sub)

    if (isApproved && (isReleased || teacherView)) {
      seenExamIds.add(exam.id)
      seenTitles.add(subjectTitleKey)
      seenTitles.add(cleanTitle)
      list.push({
        id: `exam_sub_${sub.id}`,
        student_id: targetStudentId,
        subject: exam.subject || 'عمومی',
        skill: exam.mode === 'assignment' ? `تکلیف: ${cleanTitle}` : `آزمون: ${cleanTitle}`,
        status: 'graded',
        score: eff.scaledScore20,
        max_score: 20,
        raw_score: eff.totalScore,
        raw_max: eff.maxPoints,
        recorded_at: sub.teacherGrading?.approvedAt || sub.submittedAt || new Date().toISOString(),
        is_exam: true,
        examId: exam.id,
        matchedExam: exam,
        matchedSub: sub,
        exam,
        sub,
        isPersistedInGradesTable: false,
        gradeSource: 'exam_submissions_fallback',
      })
    } else if (includePending) {
      seenExamIds.add(exam.id)
      seenTitles.add(subjectTitleKey)
      seenTitles.add(cleanTitle)
      list.push({
        id: `exam_sub_${sub.id}`,
        student_id: targetStudentId,
        subject: exam.subject || 'عمومی',
        skill: exam.mode === 'assignment' ? `تکلیف: ${cleanTitle}` : `آزمون: ${cleanTitle}`,
        status: 'pending_review',
        score: null,
        max_score: 20,
        raw_score: null,
        raw_max: getExamMaxPoints(exam),
        recorded_at: sub.submittedAt || new Date().toISOString(),
        is_exam: true,
        examId: exam.id,
        matchedExam: exam,
        matchedSub: sub,
        exam,
        sub,
      })
    }
  }

  // 3. Optionally include unsubmitted published exams & traditional homeworks (for Student UI/ReportCard)
  if (includePending) {
    for (const exam of exams) {
      if (!exam || exam.published === false) continue
      if (seenExamIds.has(exam.id)) continue

      const cleanTitle = sanitizeExamTitle(exam.title, exam.subject)
      const subjectTitleKey = `${String(exam.subject || 'عمومی').trim()}::${cleanTitle}`
      if (seenTitles.has(subjectTitleKey) || seenTitles.has(cleanTitle)) continue

      seenExamIds.add(exam.id)
      seenTitles.add(subjectTitleKey)
      seenTitles.add(cleanTitle)

      list.push({
        id: `pending_exam_${exam.id}`,
        student_id: targetStudentId,
        subject: exam.subject || 'عمومی',
        skill: exam.mode === 'assignment' ? `تکلیف: ${cleanTitle}` : `آزمون: ${cleanTitle}`,
        status: 'pending_submission',
        score: null,
        max_score: 20,
        raw_score: null,
        raw_max: getExamMaxPoints(exam),
        recorded_at: exam.dueDate || exam.createdAt || new Date().toISOString(),
        due_date: exam.dueDate,
        is_exam: true,
        examId: exam.id,
        matchedExam: exam,
        matchedSub: null,
      })
    }

    const submittedHwMap = new Map<string, any>()
    for (const s of homeworkSubmissions) {
      if (s?.post_id) submittedHwMap.set(s.post_id, s)
    }

    for (const hw of homeworkPosts) {
      if (!hw || !hw.id || hw.type !== 'homework') continue
      const titleStr = String(hw.title || '')
      if (titleStr.startsWith('__') || titleStr.includes('__SYSTEM_') || titleStr.includes('__EXAM_SUB__')) continue
      if (seenTitles.has(titleStr)) continue

      const sub = submittedHwMap.get(hw.id)
      seenTitles.add(titleStr)
      if (sub) {
        list.push({
          id: `hw_sub_${sub.id || hw.id}`,
          student_id: targetStudentId,
          subject: hw.subject || 'عمومی',
          skill: `تکلیف: ${titleStr}`,
          status: 'pending_review',
          score: null,
          max_score: 20,
          recorded_at: sub.submitted_at || hw.created_at,
          homeworkPost: hw,
          homeworkSubmission: sub,
        })
      } else {
        list.push({
          id: `hw_pending_${hw.id}`,
          student_id: targetStudentId,
          subject: hw.subject || 'عمومی',
          skill: `تکلیف: ${titleStr}`,
          status: 'pending_submission',
          score: null,
          max_score: 20,
          recorded_at: hw.due_at || hw.created_at,
          due_date: hw.due_at,
          homeworkPost: hw,
        })
      }
    }
  }

  return list.sort((a, b) => {
    const priority = { graded: 1, pending_review: 2, pending_submission: 3 }
    const pDiff = (priority[a.status as keyof typeof priority] || 9) - (priority[b.status as keyof typeof priority] || 9)
    if (pDiff !== 0) return pDiff
    return new Date(b.recorded_at || 0).getTime() - new Date(a.recorded_at || 0).getTime()
  })
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
  examsExportWarning?: string
  examSubmissionsExportWarning?: string
  tizhooshanExportError?: string
  students?: any[]
  posts?: any[]
  grades?: any[]
  attendance?: any[]
  submissions?: any[]
}

export async function exportCompleteSystemBackup(teacherPassword?: string): Promise<string> {
  const cleanTeacherPassword = typeof teacherPassword === 'string' ? teacherPassword.trim() : ''

  let exams: Exam[] = []
  let examSubmissions: StudentExamSubmission[] = []
  let students: any[] = []
  let posts: any[] = []
  let grades: any[] = []
  let attendance: any[] = []
  let submissions: any[] = []
  let tizhooshanProgress: Record<string, any> = {}

  let examsExportWarning: string | undefined
  let examSubmissionsExportWarning: string | undefined
  let tizhooshanExportError: string | undefined

  if (cleanTeacherPassword) {
    const [
      quizzesRes,
      quizSubsRes,
      tizhooshanRes,
      studentsRes,
      postsRes,
      gradesRes,
      attendanceRes,
      submissionsRes,
    ] = await Promise.allSettled([
      supabase.rpc('teacher_list_quizzes', { p_password: cleanTeacherPassword }),
      supabase.rpc('teacher_list_quiz_submissions', { p_password: cleanTeacherPassword }),
      supabase.rpc('teacher_list_tizhooshan', { p_password: cleanTeacherPassword }),
      supabase.rpc('teacher_list_students', { p_password: cleanTeacherPassword }),
      fetchFilteredPublishedPosts(supabase, { includeScheduledFuture: true }),
      supabase.rpc('teacher_list_grades', { p_password: cleanTeacherPassword }),
      supabase.rpc('teacher_list_attendance', { p_password: cleanTeacherPassword }),
      supabase.rpc('teacher_list_submissions', { p_password: cleanTeacherPassword }),
    ])

    // 1. Students & other cloud tables
    if (studentsRes.status === 'fulfilled' && !studentsRes.value.error && Array.isArray(studentsRes.value.data)) {
      students = studentsRes.value.data
    } else if (studentsRes.status === 'rejected' || (studentsRes.status === 'fulfilled' && studentsRes.value.error)) {
      console.warn('Failed to export Supabase students during backup', studentsRes.status === 'rejected' ? studentsRes.reason : studentsRes.value.error)
    }

    if (postsRes.status === 'fulfilled' && Array.isArray(postsRes.value)) {
      posts = postsRes.value
    } else if (postsRes.status === 'rejected') {
      console.warn('Failed to export Supabase posts during backup', postsRes.reason)
    }

    if (gradesRes.status === 'fulfilled' && !gradesRes.value.error && Array.isArray(gradesRes.value.data)) {
      grades = gradesRes.value.data
    } else if (gradesRes.status === 'rejected' || (gradesRes.status === 'fulfilled' && gradesRes.value.error)) {
      console.warn('Failed to export Supabase grades during backup', gradesRes.status === 'rejected' ? gradesRes.reason : gradesRes.value.error)
    }

    if (attendanceRes.status === 'fulfilled' && !attendanceRes.value.error && Array.isArray(attendanceRes.value.data)) {
      attendance = attendanceRes.value.data
    } else if (attendanceRes.status === 'rejected' || (attendanceRes.status === 'fulfilled' && attendanceRes.value.error)) {
      console.warn('Failed to export Supabase attendance during backup', attendanceRes.status === 'rejected' ? attendanceRes.reason : attendanceRes.value.error)
    }

    if (submissionsRes.status === 'fulfilled' && !submissionsRes.value.error && Array.isArray(submissionsRes.value.data)) {
      submissions = submissionsRes.value.data
    } else if (submissionsRes.status === 'rejected' || (submissionsRes.status === 'fulfilled' && submissionsRes.value.error)) {
      console.warn('Failed to export Supabase submissions during backup', submissionsRes.status === 'rejected' ? submissionsRes.reason : submissionsRes.value.error)
    }

    const studentNameById = new Map<string, string>()
    for (const st of students) {
      if (st?.id && st?.full_name) {
        studentNameById.set(String(st.id), String(st.full_name))
      }
    }

    // 2. Exams from teacher_list_quizzes (same server source as fetchAllExams), fallback to getLocalExams
    if (quizzesRes.status === 'fulfilled' && !quizzesRes.value.error && Array.isArray(quizzesRes.value.data)) {
      exams = quizzesRes.value.data
        .map((row: any) => normalizeQuizRowToExam(row))
        .filter((e): e is Exam => Boolean(e))
    } else {
      const err = quizzesRes.status === 'rejected' ? quizzesRes.reason : quizzesRes.value.error
      console.warn('Failed to export Supabase exams via teacher_list_quizzes, falling back to local cache', err)
      exams = getLocalExams()
      examsExportWarning = err?.message
        ? `دریافت آزمون‌ها از سرور ناموفق بود (${err.message})؛ نسخه حافظه محلی مرورگر در بکاپ ذخیره شد.`
        : 'دریافت آزمون‌ها از سرور ناموفق بود؛ نسخه حافظه محلی مرورگر در بکاپ ذخیره شد.'
    }

    // 3. Exam submissions from teacher_list_quiz_submissions, fallback to getLocalSubmissions
    if (quizSubsRes.status === 'fulfilled' && !quizSubsRes.value.error && Array.isArray(quizSubsRes.value.data)) {
      const mappedSubs: StudentExamSubmission[] = []
      for (const qs of quizSubsRes.value.data) {
        if (!qs || typeof qs !== 'object') continue
        const answersObj = qs.answers || {}
        const targetExamId = qs.quiz_id || answersObj.quiz_id || answersObj.exam_id
        if (!targetExamId) continue

        const rawStudentName = answersObj.student_name || studentNameById.get(String(qs.student_id || ''))
        const canonRowStudent = resolveCanonicalStudent(
          qs.student_id || answersObj.student_national_code || rawStudentName
        )
        const targetStudentId = canonRowStudent?.id || qs.student_id || answersObj.student_national_code
        const targetStudentName = canonRowStudent?.fullName || rawStudentName || 'دانش‌آموز'
        if (!targetStudentId) continue

        const isApproved = Boolean(
          answersObj.teacher_approved ||
            answersObj.approved ||
            answersObj.is_released ||
            answersObj.isReleased
        )
        const rawScore = Number(
          answersObj.raw_score ??
            answersObj.totalScore ??
            answersObj.earnedPoints ??
            answersObj.teacherGrading?.totalScore
        )
        const scaledScore = Number(
          qs.score ??
            answersObj.score ??
            answersObj.scaledScore20 ??
            answersObj.teacherGrading?.scaledScore20
        )
        const existingTeacherGrading = answersObj.teacherGrading || {}
        const qScores = answersObj.questionScores || existingTeacherGrading.questionScores
        const qFeedbacks = answersObj.questionFeedbacks || existingTeacherGrading.questionFeedbacks
        const teacherNotes = answersObj.teacherNotes || existingTeacherGrading.teacherNotes

        let calculatedRaw: number | undefined = !isNaN(rawScore) && rawScore > 0 ? rawScore : undefined
        if (qScores && typeof qScores === 'object' && Object.keys(qScores).length > 0) {
          const sum = Object.values(qScores).reduce((acc: number, v: any) => acc + (Number(v) || 0), 0)
          if (sum > 0) calculatedRaw = roundScore2(sum)
        }
        const validScaled = !isNaN(scaledScore) && scaledScore > 0 ? roundScore2(scaledScore) : undefined

        mappedSubs.push({
          id: `sub_${targetExamId}_${targetStudentId}`,
          examId: String(targetExamId),
          studentId: String(targetStudentId),
          studentName: targetStudentName,
          submittedAt: qs.submitted_at,
          answers: answersObj,
          syncStatus: 'synced',
          isReleased: isApproved,
          is_released: isApproved,
          status: isApproved ? 'graded' : 'pending_approval',
          teacherGrading: {
            ...existingTeacherGrading,
            totalScore: calculatedRaw,
            scaledScore20: validScaled,
            questionScores: qScores,
            questionFeedbacks: qFeedbacks,
            teacherNotes,
            approved: isApproved,
            approvedAt: answersObj.approved_at || existingTeacherGrading.approvedAt,
          },
        })
      }
      examSubmissions = mergeSubmissionsDeduplicated([], mappedSubs)
    } else {
      const err = quizSubsRes.status === 'rejected' ? quizSubsRes.reason : quizSubsRes.value.error
      console.warn('Failed to export Supabase exam submissions via teacher_list_quiz_submissions, falling back to local cache', err)
      examSubmissions = getLocalSubmissions()
      examSubmissionsExportWarning = err?.message
        ? `دریافت پاسخ‌های آزمون از سرور ناموفق بود (${err.message})؛ نسخه حافظه محلی مرورگر در بکاپ ذخیره شد.`
        : 'دریافت پاسخ‌های آزمون از سرور ناموفق بود؛ نسخه حافظه محلی مرورگر در بکاپ ذخیره شد.'
    }

    // 4. Tizhooshan progress from teacher_list_tizhooshan
    if (tizhooshanRes.status === 'fulfilled' && !tizhooshanRes.value.error && Array.isArray(tizhooshanRes.value.data)) {
      const progressMap: Record<string, any> = {}
      for (const row of tizhooshanRes.value.data) {
        if (!row || !row.student_id) continue
        progressMap[String(row.student_id)] = {
          student_id: row.student_id,
          student_name: row.student_name ?? '',
          total_xp: row.total_xp ?? 0,
          gems: row.gems ?? 0,
          streak: row.streak ?? 0,
          hearts: row.hearts ?? 5,
          unlocked_topic_index: row.unlocked_topic_index ?? 0,
          completed_topics: row.completed_topics ?? {},
          completed_question_ids: Array.isArray(row.completed_question_ids) ? row.completed_question_ids : [],
          wrong_question_ids: Array.isArray(row.wrong_question_ids) ? row.wrong_question_ids : [],
          last_active_date: row.last_active_date ?? '',
          updated_at: row.updated_at ?? null,
        }
      }
      tizhooshanProgress = progressMap
    } else {
      const err = tizhooshanRes.status === 'rejected' ? tizhooshanRes.reason : tizhooshanRes.value.error
      console.warn('Failed to export Supabase tizhooshan progress', err)
      tizhooshanProgress = {}
      tizhooshanExportError = err?.message
        ? `خطا در دریافت پیشرفت تیزهوشان: ${err.message}`
        : 'دریافت پیشرفت تیزهوشان از سرور ناموفق بود.'
    }
  } else {
    console.warn('Failed to export Supabase cloud backup data: missing teacher password')
    exams = getLocalExams()
    examSubmissions = getLocalSubmissions()
    tizhooshanProgress = {}
    examsExportWarning = 'رمز عبور آموزگار موجود نبود؛ آزمون‌ها از حافظه محلی مرورگر ذخیره شدند.'
    examSubmissionsExportWarning = 'رمز عبور آموزگار موجود نبود؛ پاسخ‌های آزمون از حافظه محلی مرورگر ذخیره شدند.'
    tizhooshanExportError = 'رمز عبور آموزگار برای دریافت پیشرفت تیزهوشان موجود نبود.'
  }

  const backup: SystemBackupData = {
    version: '2.0.0',
    exportedAt: new Date().toISOString(),
    exams,
    examSubmissions,
    tizhooshanProgress,
    ...(examsExportWarning ? { examsExportWarning } : {}),
    ...(examSubmissionsExportWarning ? { examSubmissionsExportWarning } : {}),
    ...(tizhooshanExportError ? { tizhooshanExportError } : {}),
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
    if (!isBackendStaticOnly()) {
      try {
        await fetchWithTimeout(
          '/api/backup/restore',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-teacher-password': teacherPass,
            },
            body: JSON.stringify({ backup: data, teacherPassword: teacherPass }),
          },
          6000
        )
      } catch (e) {
        console.warn('Server restore sync failed', e)
      }
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

/**
 * In-Progress Exam Drafts: Saves a draft to Supabase and the server.
 * Guarantees cross-device resumption and recovery upon browser close / refresh / device change.
 */
const draftFallbackInsertedTitles = new Set<string>()

export async function saveExamDraftToCloud(
  examId: string,
  studentId: string,
  studentName: string,
  draftData: {
    answers: Record<string, any>
    currentQIndex?: number
    startTime?: number
    elapsedSeconds?: number
    lastSavedAt?: number
  }
): Promise<boolean> {
  const normalizedDraft = {
    ...draftData,
    examId,
    studentId: String(studentId),
    studentName: studentName || 'دانش‌آموز',
    lastSavedAt: draftData.lastSavedAt || Date.now(),
    isDraft: true,
    status: 'in_progress',
  }

  let serverOk = false
  // 1. Try server endpoint
  if (!isBackendStaticOnly()) {
    try {
      await fetchWithTimeout(
        '/api/exams/draft/save',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            examId,
            studentId: String(studentId),
            studentName,
            draft: normalizedDraft,
          }),
        },
        5000
      )
      serverOk = true
    } catch {
      // Offline or static SPA without Node backend
    }
  }

  // 2. Direct Supabase posts table synchronization
  try {
    const postTitle = `__EXAM_DRAFT__:${examId}:${studentId}`
    const draftBody = JSON.stringify(normalizedDraft)
    const { data: existing, error: selErr } = await supabase
      .from('posts')
      .select('id')
      .eq('title', postTitle)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!selErr && existing?.id) {
      const { data: updRows, error: updErr } = await supabase
        .from('posts')
        .update({ body: draftBody, publish_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select('id')
      if (!updErr && Array.isArray(updRows) && updRows.length > 0) return true
      // Update blocked (RLS): insert a copy at most ONCE per page session — otherwise every autosave
      // would add another row to the posts table during an exam.
      if (draftFallbackInsertedTitles.has(postTitle)) return false
      draftFallbackInsertedTitles.add(postTitle)
      const { error: insErr } = await supabase
        .from('posts')
        .insert({
          title: postTitle,
          body: draftBody,
          type: 'announcement',
          publish_at: new Date().toISOString(),
        })
      if (!insErr) return true
    } else if (!selErr) {
      const { error: insErr } = await supabase
        .from('posts')
        .insert({
          title: postTitle,
          body: draftBody,
          type: 'announcement',
          publish_at: new Date().toISOString(),
        })
      if (!insErr) return true
    }
  } catch (e) {
    console.warn('[ExamStore] Direct Supabase draft sync failed:', e)
  }

  return serverOk
}

/**
 * In-Progress Exam Drafts: Fetches a draft from server or Supabase.
 */
export async function getExamDraftFromCloud(
  examId: string,
  studentId: string
): Promise<any | null> {
  // 1. Try server endpoint first
  if (!isBackendStaticOnly()) {
    try {
      const data = await fetchApiJson<any>(
        `/api/exams/draft?examId=${encodeURIComponent(examId)}&studentId=${encodeURIComponent(studentId)}`,
        {},
        5000
      )
      if (data?.draft && typeof data.draft === 'object') {
        return data.draft
      }
    } catch {
      // Continue to direct Supabase lookup
    }
  }

  // 2. Direct Supabase lookup
  try {
    const postTitle = `__EXAM_DRAFT__:${examId}:${studentId}`
    const { data: post } = await supabase
      .from('posts')
      .select('body')
      .eq('title', postTitle)
      .order('publish_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (post?.body) {
      const parsed = JSON.parse(post.body)
      if (parsed && typeof parsed === 'object' && parsed.isDraft !== false && parsed.status === 'in_progress') {
        return parsed
      }
    }
  } catch (e) {
    console.warn('[ExamStore] Direct Supabase draft fetch failed:', e)
  }

  return null
}

/**
 * In-Progress Exam Drafts: Deletes a draft from server and Supabase once finally submitted.
 */
export async function deleteExamDraftFromCloud(
  examId: string,
  studentId: string
): Promise<void> {
  if (!isBackendStaticOnly()) {
    try {
      fetchWithTimeout(
        '/api/exams/draft/delete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ examId, studentId: String(studentId) }),
        },
        5000
      ).catch(() => {})
    } catch {}
  }

  try {
    const postTitle = `__EXAM_DRAFT__:${examId}:${studentId}`
    const { data: delRows, error: delErr } = await supabase
      .from('posts')
      .delete()
      .eq('title', postTitle)
      .select('id')

    if (!delErr && Array.isArray(delRows) && delRows.length > 0) {
      return
    }

    const clearedBody = JSON.stringify({ isDraft: false, status: 'cleared', clearedAt: Date.now() })
    const { data: updRows, error: updErr } = await supabase
      .from('posts')
      .update({
        body: clearedBody,
        publish_at: new Date().toISOString(),
      })
      .eq('title', postTitle)
      .select('id')

    // If anon RLS blocks both DELETE and UPDATE (0 rows affected), append a cleared tombstone so latest draft lookup returns null
    const updatedAny = !updErr && Array.isArray(updRows) && updRows.length > 0
    if (!updatedAny) {
      await supabase.from('posts').insert({
        title: postTitle,
        body: clearedBody,
        type: 'announcement',
        publish_at: new Date().toISOString(),
      })
    }
  } catch {}
}


import { resolveApiUrl } from '../utils/networkResilience'

/**
 * Gemini AI API is handled strictly server-side via /api/ai/* endpoints so GEMINI_API_KEY
 * is never embedded in frontend bundles or exposed to browsers.
 */
export function getClientGeminiApiKey(): string {
  return ''
}

export function setClientGeminiApiKey(_key: string): void {
  // Key must reside exclusively on server in GEMINI_API_KEY
}

export function isClientGeminiEnabled(): boolean {
  return false
}

/**
 * Robustly retrieves the teacher password across memory, sessionStorage, and localStorage
 * with graceful fallback to standard '1234' so mobile browsers never get blocked.
 */
export function getStoredTeacherPassword(explicitPassword?: string): string {
  if (explicitPassword && typeof explicitPassword === 'string' && explicitPassword.trim()) {
    return explicitPassword.trim()
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      const sp = sessionStorage.getItem('teacherPassword')
      if (sp && sp.trim()) return sp.trim()
    }
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('class_auth_session')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed?.role === 'teacher' && parsed?.teacherPassword) {
          return String(parsed.teacherPassword).trim()
        }
        if (parsed?.role === 'principal' && parsed?.principalPassword) {
          return String(parsed.principalPassword).trim()
        }
      }
      const direct =
        localStorage.getItem('teacher_password') ||
        localStorage.getItem('teacherPassword')
      if (direct && direct.trim()) return direct.trim()
    }
  } catch {}
  return ''
}

/**
 * Translates Gemini & Network error messages into clear, friendly Persian
 */
export function translateGeminiError(err: any): string {
  const msg = err?.message || String(err || '')
  if (
    msg.includes('احراز هویت آموزگار') ||
    msg.includes('رمز عبور آموزگار') ||
    msg.includes('(401)')
  ) {
    return msg.includes('رمز') || msg.includes('احراز')
      ? msg
      : 'دسترسی به سرویس هوش مصنوعی نیازمند ورود معتبر آموزگار است.'
  }
  if (
    msg.includes('API_KEY_INVALID') ||
    msg.includes('API key not valid') ||
    msg.includes('GEMINI_API_KEY') ||
    msg.includes('not configured')
  ) {
    return 'سرویس هوش مصنوعی در سرور فعال نشده است یا کلید دسترسی معتبر نیست. لطفاً با مدیر سامانه تماس بگیرید.'
  }
  if (
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('quota') ||
    msg.includes('QuotaExceeded') ||
    msg.includes('429')
  ) {
    return 'سهمیه استفاده از سرویس هوش مصنوعی گوگل (Quota) موقتاً تکمیل شده است. لطفاً چند دقیقه دیگر مجدداً تلاش فرمایید.'
  }
  if (
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('network') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ECONNREFUSED')
  ) {
    return 'خطای شبکه در برقراری ارتباط با هوش مصنوعی. لطفاً اتصال اینترنت خود را بررسی کنید.'
  }
  if (msg.includes('AbortError') || msg.includes('زمان انتظار')) {
    return 'زمان انتظار ارتباط با سرور هوش مصنوعی به پایان رسید. لطفاً مجدداً امتحان نمایید.'
  }
  if (msg.includes('NOT_FOUND') || (msg.includes('model') && (msg.includes('not found') || msg.includes('unsupported')))) {
    return 'مدل هوش مصنوعی مورد نظر در دسترس نیست.'
  }
  return msg || 'خطای نامشخص در پردازش هوش مصنوعی'
}

/**
 * Standard headers for backend server requests ensuring teacher authorization
 */
export function getBackendAuthHeaders(explicitPassword?: string): Record<string, string> {
  const teacherPass = getStoredTeacherPassword(explicitPassword)
  return {
    'Content-Type': 'application/json',
    ...(teacherPass
      ? {
          'x-teacher-password': teacherPass,
          'Authorization': `Bearer ${teacherPass}`,
        }
      : {}),
  }
}

/**
 * Safely calls backend AI route with content-type inspection and HTML 404 detection
 * to prevent JSON parse errors on static hosting (Netlify/Cloudflare).
 */
export async function callBackendAiSafe(
  endpoint: string,
  payload: any,
  teacherPassword?: string
): Promise<any> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 45000)

  let res: Response
  try {
    res = await fetch(resolveApiUrl(endpoint), {
      method: 'POST',
      headers: getBackendAuthHeaders(teacherPass),
      body: JSON.stringify({ ...payload, teacherPassword: teacherPass }),
      signal: controller.signal,
    })
  } catch (netErr: any) {
    clearTimeout(timeoutId)
    if (netErr?.name === 'AbortError') {
      throw new Error('زمان انتظار ارتباط با سرور هوش مصنوعی به پایان رسید (۴۵ ثانیه). لطفاً دوباره امتحان کنید.')
    }
    throw new Error('عدم امکان برقراری ارتباط با سرور هوش مصنوعی. لطفاً اتصال اینترنت را بررسی کنید.')
  } finally {
    clearTimeout(timeoutId)
  }

  // Detect HTML response (happens when SPA rewrite serves index.html on static hosts without VITE_API_BASE_URL)
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/html') || res.status === 404) {
    console.warn(`[Gemini Proxy] Endpoint ${endpoint} returned 404/HTML.`)
    throw new Error(
      'سرور هوش مصنوعی روی این آدرس متصل نیست. برای استفاده از امکانات هوش مصنوعی در نسخه استاتیک، آدرس سرور Backend (VITE_API_BASE_URL) باید به سرور دارای GEMINI_API_KEY متصل باشد.'
    )
  }

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(errData.error || `خطا در ارتباط با سرور هوش مصنوعی (${res.status})`)
  }

  return await res.json()
}

// ============================================================================
// 1. PRACTICE & WORKSHEET GENERATION (SERVER-SIDE)
// ============================================================================
export async function generatePracticeHybrid({
  topic,
  count = 5,
  difficulty = 'medium',
  teacherPassword,
}: {
  topic: string
  count: number | string
  difficulty: string
  teacherPassword?: string
}): Promise<string> {
  try {
    const data = await callBackendAiSafe(
      '/api/ai/generate-practice',
      { topic, count, difficulty },
      teacherPassword
    )
    return data.text || ''
  } catch (err: any) {
    console.error('[Gemini Proxy] Practice generation error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 2. SAMPLE PREVIEW GENERATION (SERVER-SIDE)
// ============================================================================
export async function generateSamplePreviewHybrid({
  topic,
  difficulty = 'medium',
  teacherPassword,
}: {
  topic: string
  difficulty: string
  teacherPassword?: string
}): Promise<string> {
  try {
    const data = await callBackendAiSafe(
      '/api/ai/preview',
      { topic, difficulty },
      teacherPassword
    )
    return data.text || ''
  } catch (err: any) {
    console.error('[Gemini Proxy] Preview error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 3. ANNOUNCEMENT GENERATION (SERVER-SIDE)
// ============================================================================
export async function generateAnnouncementHybrid({
  topic,
  teacherPassword,
}: {
  topic: string
  teacherPassword?: string
}): Promise<string> {
  try {
    const data = await callBackendAiSafe(
      '/api/ai/generate-announcement',
      { topic },
      teacherPassword
    )
    return data.text || ''
  } catch (err: any) {
    console.error('[Gemini Proxy] Announcement error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 4. EXAM QUESTIONS GENERATION (SERVER-SIDE)
// ============================================================================
export async function generateExamQuestionsHybrid(params: {
  subject?: string
  topic: string
  count?: number
  types?: string[]
  difficulty?: 'easy' | 'medium' | 'hard'
  extraInstructions?: string
  teacherPassword?: string
}): Promise<any[]> {
  try {
    const data = await callBackendAiSafe('/api/ai/generate-exam', params, params.teacherPassword)
    if (data.success && Array.isArray(data.questions) && data.questions.length > 0) {
      return data.questions.map((item: any, idx: number) => ({
        id: item.id || `q_${Date.now()}_${idx + 1}`,
        type: item.type || 'multiple_choice',
        question: item.question,
        options: item.options || (item.type === 'multiple_choice' ? ['الف', 'ب', 'ج', 'د'] : undefined),
        correctAnswer: item.correctAnswer ?? 0,
        rubricOrHint: item.rubricOrHint || '',
        points: Number(item.points) || 2,
      }))
    }
    throw new Error('پاسخ سوالات از سرور دریافت نشد.')
  } catch (err: any) {
    console.error('[Gemini Proxy] Exam generation error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 5. REGENERATE SINGLE QUESTION (SERVER-SIDE)
// ============================================================================
export async function regenerateSingleQuestionHybrid(params: {
  subject: string
  topic: string
  type: string
  difficulty?: 'easy' | 'medium' | 'hard'
  points?: number
  previousQuestion?: string
  extraInstructions?: string
  teacherPassword?: string
}): Promise<any> {
  const { type, points = 2, teacherPassword } = params
  try {
    const data = await callBackendAiSafe('/api/ai/regenerate-question', params, teacherPassword)
    if (!data.success || !data.question) {
      throw new Error(data.error || 'پاسخ معتبری از سرور دریافت نشد')
    }
    const item = data.question
    return {
      id: item.id || `q_${Date.now()}`,
      type: item.type || type,
      question: item.question,
      options: item.options || (item.type === 'multiple_choice' ? ['الف', 'ب', 'ج', 'د'] : undefined),
      correctAnswer: item.correctAnswer ?? 0,
      rubricOrHint: item.rubricOrHint || '',
      points: Number(item.points) || points,
    }
  } catch (err: any) {
    console.error('[Gemini Proxy] Regenerate question error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 6. CONVERT PRACTICE TEXT TO QUESTIONS (SERVER-SIDE)
// ============================================================================
export async function convertPracticeToQuestionsHybrid(
  text: string,
  subject = 'پایه ششم',
  teacherPassword?: string
): Promise<any[]> {
  try {
    const data = await callBackendAiSafe(
      '/api/ai/convert-practice-to-exam',
      { text, subject },
      teacherPassword
    )
    if (!data.success || !Array.isArray(data.questions) || data.questions.length === 0) {
      throw new Error('سوال معتبری از متن کاربرگ استخراج نشد.')
    }
    return data.questions.map((item: any, idx: number) => ({
      id: item.id || `q_${Date.now()}_${idx + 1}`,
      type: item.type || 'multiple_choice',
      question: item.question,
      options: item.options || (item.type === 'multiple_choice' ? ['الف', 'ب', 'ج', 'د'] : undefined),
      correctAnswer: item.correctAnswer ?? 0,
      rubricOrHint: item.rubricOrHint || '',
      points: Number(item.points) || 2,
    }))
  } catch (err: any) {
    console.error('[Gemini Proxy] Convert practice error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 7. CLASSROOM CHAT ASSISTANT (SERVER-SIDE)
// ============================================================================
export async function classroomChatHybrid(
  message: string,
  classroomContext: any,
  teacherPassword?: string
): Promise<string> {
  const contextStr =
    typeof classroomContext === 'string' ? classroomContext : JSON.stringify(classroomContext, null, 2)

  try {
    const data = await callBackendAiSafe(
      '/api/ai/classroom-chat',
      {
        message,
        classroomContext: contextStr,
      },
      teacherPassword
    )
    if (!data.success) {
      throw new Error(data.error || 'خطا در ارتباط با سرور')
    }
    return data.reply || ''
  } catch (err: any) {
    console.error('[Gemini Proxy] Chat error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 8. EXAM SUBMISSION GRADING (SERVER-SIDE)
// ============================================================================
export interface GradeSubmissionResult {
  success: boolean
  grades: Array<{
    id: string
    score: number
    feedback?: string
  }>
  totalScore?: number
  maxScore?: number
  scaledScore20?: number
  scale?: number
  teacherSummaryNote?: string
  error?: string
}

export async function gradeSubmissionHybrid(params: {
  questions: any[]
  studentName: string
  totalPoints?: number
  teacherPassword?: string
}): Promise<GradeSubmissionResult> {
  const { questions, studentName, totalPoints = 20, teacherPassword } = params
  try {
    const data = await callBackendAiSafe(
      '/api/ai/grade-submission',
      {
        questions,
        studentName,
        totalPoints,
      },
      teacherPassword
    )
    return data
  } catch (err: any) {
    console.error('[Gemini Proxy] Grade submission error:', err)
    throw new Error(translateGeminiError(err))
  }
}

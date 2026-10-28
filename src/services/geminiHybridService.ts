import { GoogleGenAI } from '@google/genai'

// Models to try in order (Prioritizing gemini-1.5-flash and gemini-2.5-flash as requested)
const CANDIDATE_MODELS = [
  'gemini-1.5-flash',
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
]

/**
 * Retrieves the client-side Gemini API key if configured
 * Checks import.meta.env.VITE_GEMINI_API_KEY, localStorage, and sessionStorage.
 */
export function getClientGeminiApiKey(): string {
  try {
    const envKey = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GEMINI_API_KEY) || ''
    if (typeof envKey === 'string' && envKey.trim() && !envKey.includes('PLACEHOLDER')) {
      return envKey.trim()
    }
    if (typeof localStorage !== 'undefined') {
      const keys = [
        'VITE_GEMINI_API_KEY',
        'GEMINI_API_KEY',
        'gemini_api_key',
        'geminiApiKey',
        'client_gemini_api_key',
        'school_gemini_api_key',
      ]
      for (const k of keys) {
        const val = localStorage.getItem(k)
        if (typeof val === 'string' && val.trim()) {
          return val.trim()
        }
      }
    }
    if (typeof sessionStorage !== 'undefined') {
      const sessKey = sessionStorage.getItem('VITE_GEMINI_API_KEY') || sessionStorage.getItem('GEMINI_API_KEY')
      if (typeof sessKey === 'string' && sessKey.trim()) {
        return sessKey.trim()
      }
    }
  } catch {}
  return ''
}

/**
 * Saves a client-side Gemini API key to localStorage for mobile browsers & standalone SPAs
 */
export function setClientGeminiApiKey(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      const trimmed = key.trim()
      if (trimmed) {
        localStorage.setItem('VITE_GEMINI_API_KEY', trimmed)
        localStorage.setItem('GEMINI_API_KEY', trimmed)
      } else {
        localStorage.removeItem('VITE_GEMINI_API_KEY')
        localStorage.removeItem('GEMINI_API_KEY')
      }
    }
  } catch {}
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
  return '1234'
}

/**
 * Checks whether client-side direct Gemini API is enabled
 */
export function isClientGeminiEnabled(): boolean {
  return Boolean(getClientGeminiApiKey())
}

/**
 * Translates Gemini & Network error messages into clear, friendly Persian
 */
export function translateGeminiError(err: any): string {
  const msg = err?.message || String(err || '')
  if (
    msg.includes('API_KEY_INVALID') ||
    msg.includes('API key not valid') ||
    msg.includes('403') ||
    msg.includes('Forbidden') ||
    msg.includes('not configured')
  ) {
    return 'کلید هوش مصنوعی (API Key) معتبر نیست یا دسترسی آن محدود شده است. لطفاً متغیر VITE_GEMINI_API_KEY یا تنظیمات کلید را بررسی کنید.'
  }
  if (
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('quota') ||
    msg.includes('QuotaExceeded') ||
    msg.includes('429')
  ) {
    return 'سهمیه استفاده از سرویس هوش مصنوعی گوگل (Quota) تکمیل شده است. لطفاً چند دقیقه دیگر مجدداً تلاش فرمایید.'
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
  if (msg.includes('model') && (msg.includes('not found') || msg.includes('unsupported'))) {
    return 'مدل هوش مصنوعی مورد نظر در دسترس نیست.'
  }
  return msg || 'خطای نامشخص در پردازش هوش مصنوعی'
}

/**
 * Calls Google Gen AI directly from the frontend using the official @google/genai SDK
 * with cascading models and direct REST fallback. Full error details logged to console.
 */
export async function callGeminiDirectClient(
  prompt: string,
  responseJson = false
): Promise<string> {
  const apiKey = getClientGeminiApiKey()
  if (!apiKey) {
    throw new Error('کلید هوش مصنوعی در کلاینت یافت نشد. لطفاً VITE_GEMINI_API_KEY را در متغیرها تنظیم کنید.')
  }

  console.log('[Gemini Direct Client] Calling Gemini from browser with model cascade...')
  const ai = new GoogleGenAI({ apiKey })
  let lastError: any = null

  // 1. Try with GoogleGenAI SDK through candidate models (gemini-1.5-flash and gemini-2.5-flash first)
  for (const model of CANDIDATE_MODELS) {
    try {
      console.log(`[Gemini SDK] Attempting model: ${model}`)
      const res = await ai.models.generateContent({
        model,
        contents: prompt,
        config: responseJson ? { responseMimeType: 'application/json' } : undefined,
      })

      if (res && res.text) {
        console.log(`[Gemini SDK] Successfully generated content using model: ${model}`)
        return res.text.trim()
      }
    } catch (err: any) {
      console.warn(`[Gemini SDK Error] Model "${model}" failed:`, err?.message || err)
      lastError = err
    }
  }

  // 2. Direct REST fallback if SDK encountered browser-level issue
  for (const model of CANDIDATE_MODELS) {
    try {
      console.log(`[Gemini REST Fallback] Attempting direct REST fetch for model: ${model}`)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const bodyPayload: any = {
        contents: [{ parts: [{ text: prompt }] }],
      }
      if (responseJson) {
        bodyPayload.generationConfig = { responseMimeType: 'application/json' }
      }

      const restRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      })

      if (restRes.ok) {
        const json = await restRes.json()
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text
        if (text) {
          console.log(`[Gemini REST Fallback] Successfully generated content using model: ${model}`)
          return text.trim()
        }
      } else {
        const errJson = await restRes.json().catch(() => ({}))
        console.error(`[Gemini REST Error] Model "${model}" returned HTTP ${restRes.status}:`, errJson)
        lastError = new Error(errJson?.error?.message || `HTTP ${restRes.status}`)
      }
    } catch (restErr: any) {
      console.error(`[Gemini REST Error] Model "${model}" network/fetch error:`, restErr)
      lastError = restErr
    }
  }

  const translated = translateGeminiError(lastError)
  console.error('[Gemini Direct Client] All candidate models failed. Final error:', translated, lastError)
  throw new Error(translated)
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
 * to prevent JSON parse errors on static hosting (Netlify/Cloudflare Workers).
 */
export async function callBackendAiSafe(
  endpoint: string,
  payload: any,
  teacherPassword?: string
): Promise<any> {
  const teacherPass = getStoredTeacherPassword(teacherPassword)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: getBackendAuthHeaders(teacherPass),
      body: JSON.stringify({ ...payload, teacherPassword: teacherPass }),
      signal: controller.signal,
    })
  } catch (netErr: any) {
    clearTimeout(timeoutId)
    if (netErr?.name === 'AbortError') {
      throw new Error('زمان انتظار ارتباط با سرور هوش مصنوعی به پایان رسید.')
    }
    throw new Error('عدم امکان برقراری ارتباط با سرور بک‌اند.')
  } finally {
    clearTimeout(timeoutId)
  }

  // Detect HTML response (happens when Netlify / Cloudflare SPA rewrite serves index.html on missing /api routes)
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/html') || res.status === 404) {
    console.warn(`[Gemini Hybrid] Endpoint ${endpoint} returned 404/HTML (Static deployment).`);
    throw new Error(
      'سرویس هوش مصنوعی نیازمند تنظیم کلید VITE_GEMINI_API_KEY است. به دلیل استقرار استاتیک (بدون سرور بک‌اند)، لطفاً کلید رسمی جمینای را در تنظیمات هاست یا مرورگر قرار دهید.'
    )
  }

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(errData.error || `خطا در ارتباط با سرور هوش مصنوعی (${res.status})`)
  }

  return await res.json()
}

// ============================================================================
// 1. PRACTICE & WORKSHEET GENERATION (HYBRID)
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
  console.log('[Gemini Hybrid] generatePracticeHybrid invoked:', { topic, count, difficulty, hasClientKey: isClientGeminiEnabled() })

  // If client-side API key exists, call Gemini directly!
  if (isClientGeminiEnabled()) {
    try {
      const difficultyLabel =
        ({ easy: 'ساده', medium: 'متوسط', hard: 'سخت و تیزهوشانی' } as any)[difficulty] || 'متوسط'

      const prompt = `شما آموزگار شایسته، دلسوز و حرفه‌ای پایه ششم ابتدایی هستید.
موضوع و خواسته معلم برای تکلیف/تمرین: «${topic}»
سطح دشواری: ${difficultyLabel}
تعداد: ${count} سوال

دستورات حیاتی برای قالب‌بندی:
۱. هرگز و تحت هیچ شرایطی جواب، کلید سوال یا پاسخ درست را در صورت سوال یا بلافاصله پس از سوال ننویسید.
۲. صورت هر سوال باید کاملاً شفاف و تمیز باشد تا دانش‌آموز خود به تنهایی روی آن فکر کند و حل کند.
۳. در نگارش عبارات ریاضی:
   - علامت‌های کسر را به شکل کسری مشخص مانند ۳/۴ یا \\frac{۳}{۴} بنویسید.
   - ضرب را با علامت × و تقسیم را با ÷ یا کسر نمایش دهید.
۴. سوالات باید سناریودار، ملموس و مناسب سن ۱۲ سالگی باشند.
۵. پاسخنامه و راه‌حل گام‌به‌گام فقط و فقط در انتهای متن و پس از جداکننده «---» و با عنوان «📝 پاسخنامه و راهنمای حل تشریحی (ویژه معلم)» قرار گیرد.

ساختار کاربرگ:
- خط اول: عنوان شیک کاربرگ
- صورت سوالات شماره‌گذاری شده ۱ تا ${count}
- علامت جداکننده «---»
- پاسخنامه تشریحی گام‌به‌گام`

      return await callGeminiDirectClient(prompt, false)
    } catch (err: any) {
      console.warn('[Hybrid] Client direct generation failed, attempting backend fallback:', err)
      // Fall through to backend if available
    }
  }

  // Fallback to backend server (/api/ai/generate-practice) safely
  try {
    console.log('[Gemini Hybrid] Requesting /api/ai/generate-practice via safe backend call...')
    const data = await callBackendAiSafe(
      '/api/ai/generate-practice',
      { topic, count, difficulty },
      teacherPassword
    )
    return data.text || ''
  } catch (err: any) {
    console.error('[Gemini Hybrid] Practice generation error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 2. SAMPLE PREVIEW GENERATION (HYBRID)
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
  console.log('[Gemini Hybrid] generateSamplePreviewHybrid invoked:', { topic, difficulty })
  if (isClientGeminiEnabled()) {
    try {
      const prompt = `به عنوان طراح سوال پایه ششم، بر اساس این موضوع: «${topic}» و سطح «${difficulty}»، ۳ سوال نمونه واقعی و آموزنده طراحی کن. بین هر سوال فاصله بگذار. بدون حاشیه و پاسخنامه.`
      return await callGeminiDirectClient(prompt, false)
    } catch (err: any) {
      console.warn('[Hybrid] Client preview failed, attempting backend fallback:', err)
    }
  }

  try {
    const data = await callBackendAiSafe(
      '/api/ai/preview',
      { topic, difficulty },
      teacherPassword
    )
    return data.text || ''
  } catch (err: any) {
    console.error('[Gemini Hybrid] Preview error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 3. ANNOUNCEMENT GENERATION (HYBRID)
// ============================================================================
export async function generateAnnouncementHybrid({
  topic,
  teacherPassword,
}: {
  topic: string
  teacherPassword?: string
}): Promise<string> {
  console.log('[Gemini Hybrid] generateAnnouncementHybrid invoked:', { topic })
  if (isClientGeminiEnabled()) {
    try {
      const prompt = `شما آموزگار مهربان و باانگیزه پایه ششم هستید. بر اساس یادداشت زیر، یک اطلاعیه کلاسی شاداب، رسمی، خوانا و منظم برای دانش‌آموزان و اولیا بنویسید:
«${topic}»
خط اول عنوان باشد و متن اعلان در ۲ الی ۴ بند مرتب.`
      return await callGeminiDirectClient(prompt, false)
    } catch (err: any) {
      console.warn('[Hybrid] Client announcement failed, attempting backend fallback:', err)
    }
  }

  try {
    const data = await callBackendAiSafe(
      '/api/ai/generate-announcement',
      { topic },
      teacherPassword
    )
    return data.text || ''
  } catch (err: any) {
    console.error('[Gemini Hybrid] Announcement error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 4. EXAM QUESTIONS GENERATION (HYBRID)
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
  const {
    subject = '',
    topic = '',
    count = 5,
    types = ['multiple_choice', 'fill_in_the_blank', 'descriptive'],
    difficulty = 'medium',
    extraInstructions = '',
    teacherPassword,
  } = params

  console.log('[Gemini Hybrid] generateExamQuestionsHybrid invoked:', { subject, topic, count, difficulty })

  if (isClientGeminiEnabled()) {
    try {
      const rawTopic = String(topic || '').trim()
      let effectiveSubject = subject && subject.trim() ? subject.trim() : 'پایه ششم ابتدایی'
      const numCount = Math.min(25, Math.max(1, Number(count) || 5))

      const difficultyDesc =
        difficulty === 'hard'
          ? 'سطح دشوار و تحلیلی تیزهوشانی (مدارس سمپاد)'
          : difficulty === 'easy'
          ? 'سطح ساده و روان برای تثبیت مفاهیم کتاب درسی'
          : 'سطح استاندارد امتحانات کلاسی و نهایی پایه ششم'

      const prompt = `شما آموزگار شایسته، دلسوز و حرفه‌ای پایه ششم ابتدایی هستید.
معلم از شما خواسته است برای این موضوع یک آزمون بسیار باکیفیت و استاندارد طراحی کنید:
🎯 موضوع: «${rawTopic}»
🎯 درس: «${effectiveSubject}»
${extraInstructions ? `🎯 توضیحات معلم: «${extraInstructions}»` : ''}
📊 سطح دشواری: ${difficultyDesc}
🔢 تعداد: ${numCount} سوال
📝 انواع سوالات: ${Array.isArray(types) ? types.join('، ') : 'چهارگزینه‌ای، جای خالی، تشریحی'}

خروجی باید صرفاً یک آرایه JSON معتبر طبق این الگو باشد:
[
  {
    "id": "q1",
    "type": "multiple_choice",
    "question": "متن روان و دقیق صورت سوال",
    "options": ["گزینه ۱", "گزینه ۲", "گزینه ۳", "گزینه ۴"],
    "correctAnswer": 0,
    "rubricOrHint": "توضیح کامل پاسخنامه",
    "points": 2
  },
  {
    "id": "q2",
    "type": "fill_in_the_blank",
    "question": "متن سوال با علامت ............ برای جای خالی",
    "correctAnswer": "پاسخ جای خالی",
    "rubricOrHint": "توضیح پاسخ",
    "points": 2
  },
  {
    "id": "q3",
    "type": "descriptive",
    "question": "مسئله یا سوال تشریحی",
    "rubricOrHint": "معیار نمره‌دهی و راه‌حل",
    "points": 3
  }
]`

      const jsonText = await callGeminiDirectClient(prompt, true)
      let cleaned = jsonText.trim()
      if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json/, '').replace(/```$/, '').trim()
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```/, '').replace(/```$/, '').trim()

      const firstBracket = cleaned.indexOf('[')
      const lastBracket = cleaned.lastIndexOf(']')
      if (firstBracket !== -1 && lastBracket !== -1) {
        cleaned = cleaned.substring(firstBracket, lastBracket + 1)
      }

      const parsed = JSON.parse(cleaned)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item: any, idx: number) => ({
          id: item.id || `q_${Date.now()}_${idx + 1}`,
          type: item.type || 'multiple_choice',
          question: item.question,
          options: item.options || (item.type === 'multiple_choice' ? ['الف', 'ب', 'ج', 'د'] : undefined),
          correctAnswer: item.correctAnswer ?? 0,
          rubricOrHint: item.rubricOrHint || '',
          points: Number(item.points) || 2,
        }))
      }
    } catch (err: any) {
      console.warn('[Hybrid] Client direct exam generation failed, attempting backend fallback:', err)
    }
  }

  // Fallback to backend server safely
  try {
    const data = await callBackendAiSafe('/api/ai/generate-exam', params, teacherPassword)
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
    console.error('[Gemini Hybrid] Exam generation error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 5. REGENERATE SINGLE QUESTION (HYBRID)
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
  const {
    subject,
    topic,
    type,
    difficulty = 'medium',
    points = 2,
    previousQuestion = '',
    extraInstructions = '',
    teacherPassword,
  } = params

  if (isClientGeminiEnabled()) {
    try {
      const effectiveSubject = subject || 'کتاب‌های درسی پایه ششم ابتدایی'
      const prompt = `شما آموزگار متخصص پایه ششم ابتدایی هستید. آموزگار سوال قبلی زیر را تایید نکرده است:
«${previousQuestion || '(بدون متن)'}»

یک سوال کاملاً جدید و باکیفیت برای درس «${effectiveSubject}» و مبحث «${topic}» با نوع «${type}»، سطح «${difficulty}» و بارم «${points} نمره» طراحی کنید.
${extraInstructions ? `دستور آموزگار: ${extraInstructions}` : ''}

پاسخ را صرفاً به صورت یک شیء JSON معتبر تحویل دهید:
{
  "id": "q_${Date.now()}",
  "type": "${type}",
  "question": "متن سوال جدید",
  ${type === 'multiple_choice' ? `"options": ["گزینه ۱", "گزینه ۲", "گزینه ۳", "گزینه ۴"],\n  "correctAnswer": 0,` : ''}
  ${type === 'fill_in_the_blank' ? `"correctAnswer": "پاسخ جای خالی",` : ''}
  "rubricOrHint": "راهنمای حل",
  "points": ${points}
}`

      const jsonText = await callGeminiDirectClient(prompt, true)
      let cleaned = jsonText.trim()
      if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json/, '').replace(/```$/, '').trim()
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```/, '').replace(/```$/, '').trim()

      const firstBrace = cleaned.indexOf('{')
      const lastBrace = cleaned.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1)
      }

      const parsed = JSON.parse(cleaned)
      if (parsed.question) {
        return {
          id: parsed.id || `q_${Date.now()}`,
          type: parsed.type || type,
          question: parsed.question,
          options: parsed.options || (type === 'multiple_choice' ? ['الف', 'ب', 'ج', 'د'] : undefined),
          correctAnswer: parsed.correctAnswer ?? 0,
          rubricOrHint: parsed.rubricOrHint || '',
          points: Number(parsed.points) || points,
        }
      }
    } catch (err: any) {
      console.warn('[Hybrid] Client regenerate question failed, attempting backend fallback:', err)
    }
  }

  // Fallback to backend server safely
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
    console.error('[Gemini Hybrid] Regenerate question error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 6. CONVERT PRACTICE TEXT TO QUESTIONS (HYBRID)
// ============================================================================
export async function convertPracticeToQuestionsHybrid(
  text: string,
  subject = 'پایه ششم',
  teacherPassword?: string
): Promise<any[]> {
  if (isClientGeminiEnabled()) {
    try {
      const prompt = `شما دستیار آموزگار پایه ششم هستید. متن کاربرگ زیر را به سوالات آزمون آنلاین استاندارد (آرایه JSON) تبدیل کنید:
${text}

خروجی باید صرفاً یک آرایه JSON معتبر باشد:
[
  {
    "id": "q1",
    "type": "multiple_choice",
    "question": "صورت سوال",
    "options": ["گزینه ۱", "گزینه ۲", "گزینه ۳", "گزینه ۴"],
    "correctAnswer": 0,
    "rubricOrHint": "استدلال پاسخنامه",
    "points": 2
  }
]`

      const jsonText = await callGeminiDirectClient(prompt, true)
      let cleaned = jsonText.trim()
      if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json/, '').replace(/```$/, '').trim()
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```/, '').replace(/```$/, '').trim()

      const firstBracket = cleaned.indexOf('[')
      const lastBracket = cleaned.lastIndexOf(']')
      if (firstBracket !== -1 && lastBracket !== -1) {
        cleaned = cleaned.substring(firstBracket, lastBracket + 1)
      }

      const parsed = JSON.parse(cleaned)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item: any, idx: number) => ({
          id: item.id || `q_${Date.now()}_${idx + 1}`,
          type: item.type || 'multiple_choice',
          question: item.question,
          options: item.options || (item.type === 'multiple_choice' ? ['الف', 'ب', 'ج', 'د'] : undefined),
          correctAnswer: item.correctAnswer ?? 0,
          rubricOrHint: item.rubricOrHint || '',
          points: Number(item.points) || 2,
        }))
      }
    } catch (err: any) {
      console.warn('[Hybrid] Client convert practice failed, attempting backend fallback:', err)
    }
  }

  // Fallback to backend server safely
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
    console.error('[Gemini Hybrid] Convert practice error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 7. CLASSROOM CHAT ASSISTANT (HYBRID)
// ============================================================================
export async function classroomChatHybrid(
  message: string,
  classroomContext: any,
  teacherPassword?: string
): Promise<string> {
  const contextStr =
    typeof classroomContext === 'string' ? classroomContext : JSON.stringify(classroomContext, null, 2)

  if (isClientGeminiEnabled()) {
    try {
      const prompt = `شما دستیار هوشمند، دلسوز و تحلیل‌گر ارشد آموزگار پایه ششم دبستان حضرت قائم (عج) هستید.
اطلاعات عملکرد کلاسی:
${contextStr}

پیام آموزگار: «${message}»
پاسخی مشفقانه، کاربردی، دقیق و بر پایه داده‌های فوق ارائه فرمایید.`

      return await callGeminiDirectClient(prompt, false)
    } catch (err: any) {
      console.warn('[Hybrid] Client chat failed, attempting backend fallback:', err)
    }
  }

  // Fallback to backend server safely
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
    console.error('[Gemini Hybrid] Chat error:', err)
    throw new Error(translateGeminiError(err))
  }
}

// ============================================================================
// 8. EXAM SUBMISSION GRADING (HYBRID)
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

function sanitizeTeacherNoteClient(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/(هوش مصنوعی|مدل زبانی|الگوریتم|ربات|سیستم خودکار|gemini|chatgpt|openai)/gi, 'آموزگار')
    .trim()
}

export async function gradeSubmissionHybrid(params: {
  questions: any[]
  studentName: string
  totalPoints?: number
  teacherPassword?: string
}): Promise<GradeSubmissionResult> {
  const { questions, studentName, totalPoints = 20, teacherPassword } = params

  if (isClientGeminiEnabled()) {
    try {
      const prompt = `شما آموزگار مهربان، دلسوز، بسیار منعطف، صبور و باتجربه پایه ششم ابتدایی هستید. نام شما آموزگار کلاس است.
دانش‌آموز پایه ششم به نام «${studentName}» در این آزمون شرکت کرده است.
اطلاعات سوالات، بارم، راهنمای حل/کلید، و پاسخ ثبت‌شده دانش‌آموز:
${JSON.stringify(questions, null, 2)}

اصول و دستورالعمل‌های حیاتی تصحیح (رعایت دقیق و قطعی این موارد الزامی است):
۱. **تصحیح کاملاً منعطف، مهربانانه و مفهوم‌محور (Lenient & Concept-First)**:
   - اگر مفهوم، جان‌کلام، ایده اصلی یا پیام پاسخ دانش‌آموز درست بود، حتماً و بدون تعلل **نمره کامل** آن سوال را بدهید. سخت‌گیری وسواس‌گونه یا انطباق کلمه به کلمه با کتاب اکیداً ممنوع است.
   - دانش‌آموز پایه ششم ابتدایی ممکن است آموخته‌های خود را با لحن و ادبیات کودکانه و صادقانه خود بنویسد؛ مادامی که نشان‌دهنده درک مطلب درس است باید نمره کامل کسب کند.
۲. **اغماض و انعطاف کامل در نیم‌فاصله‌ها و فاصله‌گذاری**:
   - نیم‌فاصله و فاصله‌ها به هیچ وجه نباید نمره صفر بگیرند یا باعث کسر نمره شوند، بلکه کاملاً صحیح تلقی شده و نمره کامل داده شود.
۳. **پذیرش بی‌قیدوشرط کلمات مترادف و هم‌معنی**:
   - واژگان هم‌معنی به هیچ وجه نباید نمره صفر بگیرند؛ بلکه باید **نمره کامل** دریافت کنند.
۴. **نادیده گرفتن خطاهای املایی و تایپی جزئی دانش‌آموز ششم ابتدایی**:
   - خطاهای املایی جزئی دانش‌آموز ششم ابتدایی باید کاملاً نادیده گرفته شوند؛ اگر کلمه قابل تشخیص و مفهوم روشن است، نمره کامل منظور شود.
۵. **سوالات جای‌خالی و تشریحی**:
   - در سوالات جای‌خالی و تشریحی: اگر دانش‌آموز واژه کلیدی یا مترادف آن را حتی با املای ناقص، ادبیات کودکانه یا فاصله‌گذاری متفاوت نوشته باشد، نمره کامل سوال به او تعلق گیرد. نمره صفر فقط در صورتی مجاز است که سوال کاملاً سفید یا پاسخ ۱۰۰٪ بی‌ربط به درس باشد.
۶. **یادداشت معلمانه شخصی‌سازی‌شده و پرمهر (teacherSummaryNote)**:
   - مستقیماً از زبان آموزگار خطاب به دانش‌آموز «${studentName}» پیامی صمیمی، دلگرم‌کننده و انگیزاننده بنویسید.
   - نقاط قوت او را در پاسخ‌هایش تمجید کنید و در صورت نیاز به تقویت موضوعی، با لحن برادرانه و مشفقانه راهنمایی فرمایید.
   - لحن ۱۰۰٪ طبیعی از زبان آموزگار کلاس باشد و مطلقاً هیچ نامی از هوش مصنوعی، ربات، یا ابزار خودکار برده نشود.

پاسخ را صرفاً به صورت یک شیء JSON معتبر با این ساختار تحویل دهید:
{
  "grades": [
    {
      "id": "شناسه سوال",
      "score": 2,
      "feedback": "بازخورد مهربانانه، تشویقی و آموزنده به پاسخ سوال"
    }
  ],
  "teacherSummaryNote": "متن یادداشت و بازخورد پرمهر آموزگار به دانش‌آموز"
}`

      const jsonText = await callGeminiDirectClient(prompt, true)
      let cleaned = jsonText.trim()
      if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json/, '').replace(/```$/, '').trim()
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```/, '').replace(/```$/, '').trim()

      const firstBrace = cleaned.indexOf('{')
      const lastBrace = cleaned.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1)
      }

      const parsed = JSON.parse(cleaned)
      const gradesArr = Array.isArray(parsed) ? parsed : parsed.grades || []
      const rawTeacherNote = Array.isArray(parsed) ? '' : parsed.teacherSummaryNote || ''
      const cleanNote = sanitizeTeacherNoteClient(rawTeacherNote)

      const totalEarned = gradesArr.reduce((sum: number, g: any) => sum + (Number(g.score) || 0), 0)
      const maxPts = Number(totalPoints) || 20
      const scaledScore20 = maxPts > 0 ? Math.round(((totalEarned / maxPts) * 20) * 10) / 10 : totalEarned

      return {
        success: true,
        grades: gradesArr,
        totalScore: totalEarned,
        maxScore: maxPts,
        scaledScore20,
        scale: 20,
        teacherSummaryNote: cleanNote,
      }
    } catch (err: any) {
      console.warn('[Hybrid] Client grading failed, attempting backend fallback:', err)
    }
  }

  // Fallback to backend server safely
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
    console.error('[Gemini Hybrid] Grade submission error:', err)
    throw new Error(translateGeminiError(err))
  }
}

/**
 * Cloudflare Worker: Netlify Reverse Proxy + Secure Server-Side Gemini AI Gateway (/api/ai/*)
 * Target Worker: https://class.nemat-darkhah.workers.dev
 *
 * Required Cloudflare Worker Variables & Secrets (Dashboard -> Settings -> Variables and Secrets):
 * - GEMINI_API_KEY (Secret): Google Gemini API Key (NEVER expose in Frontend / GitHub)
 * - NETLIFY_ORIGIN (Text Variable): Your Netlify site URL (e.g. https://your-site-name.netlify.app)
 * - TEACHER_PASSWORD (Optional Secret): Override teacher password check (otherwise verified via Supabase verify_teacher RPC)
 * - GEMINI_MODEL (Optional Text Variable): Preferred Gemini model ID override
 * - SUPABASE_URL (Optional Text Variable): Defaults to existing project Supabase URL
 * - SUPABASE_ANON_KEY (Optional Text Variable): Defaults to existing public Supabase publishable/anon key
 */

const DEFAULT_SUPABASE_URL = 'https://ephgqrnbpxvxlzloflhy.supabase.co'
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_bI5v4Hzokb0A4JWJDzuz1A_4B3lIUX_'

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000
const discoveredModelsCache = new Map()

const PREFERRED_MODEL_PATTERNS = [
  /^gemini-3(?:\.\d+)?-flash(?!.*(?:tts|live|image|audio|lite))/,
  /^gemini-2\.5-flash(?!.*(?:tts|live|image|audio|lite))/,
  /^gemini-4-hydrogen$/,
  /^gemini-3(?:\.\d+)?-flash-lite/,
  /^gemini-2\.5-flash-lite/,
  /^gemini-.*flash(?!.*(?:1\.0|1\.5|2\.0|tts|live|image|audio|thinking))/,
]

const DISALLOWED_MODEL_KEYWORDS = [
  'embedding',
  'imagen',
  'veo',
  'lyria',
  'aqa',
  'tts',
  'live',
  'transcribe',
  'image',
  'audio',
  'gemini-1.0',
  'gemini-1.5',
  'gemini-2.0',
  'gemini-pro',
]

function getCorsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-teacher-password, x-principal-password, Cache-Control',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

const NO_CACHE_HEADERS = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate, proxy-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'Pragma': 'no-cache',
  'Expires': '0',
}

function jsonResponse(payload, status = 200, request = null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...getCorsHeaders(request),
      ...NO_CACHE_HEADERS,
    },
  })
}

class WorkerApiError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR') {
    super(message)
    this.status = status
    this.code = code
  }
}

function cleanOptionText(text) {
  if (!text) return ''
  return String(text)
    .replace(/^(?:گزینه\s*)?(?:[الفبجده]|1|2|3|4|۱|۲|۳|۴)[)\].:\-ـ\s]+/u, '')
    .trim()
}

function resolveCorrectOptionIndex(question) {
  const options = Array.isArray(question?.options) ? question.options : []
  if (options.length === 0) return { isValid: false, index: -1 }

  const raw = question?.correctAnswer ?? question?.correctOptionIndex
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < options.length) {
    return { isValid: true, index: raw }
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    const num = Number(trimmed)
    if (!Number.isNaN(num) && Number.isInteger(num) && num >= 0 && num < options.length) {
      return { isValid: true, index: num }
    }
    const cleanedTarget = cleanOptionText(trimmed)
    const foundIdx = options.findIndex((opt) => cleanOptionText(opt) === cleanedTarget)
    if (foundIdx >= 0) return { isValid: true, index: foundIdx }
  }

  if (typeof question?.correctOptionText === 'string' && question.correctOptionText.trim()) {
    const cleanedOptText = cleanOptionText(question.correctOptionText)
    const foundIdx = options.findIndex((opt) => cleanOptionText(opt) === cleanedOptText)
    if (foundIdx >= 0) return { isValid: true, index: foundIdx }
  }

  return { isValid: false, index: -1 }
}

function sanitizeTeacherNote(text) {
  if (!text) return ''
  let cleaned = String(text).trim()
  if (cleaned.startsWith('{') || cleaned.includes('"teacherSummaryNote"')) {
    try {
      const m = cleaned.match(/\{[\s\S]*\}/)
      if (m) {
        const p = JSON.parse(m[0])
        cleaned = p.teacherSummaryNote || p.teacherNotes || p.summary || p.feedback || cleaned
      }
    } catch {}
  }
  cleaned = cleaned.replace(/```(?:json)?[\s\S]*?```/g, '').trim()
  return cleaned
    .replace(/(هوش مصنوعی|مدل زبانی|الگوریتم|ربات|سیستم خودکار|gemini|chatgpt|openai)/gi, 'آموزگار')
    .replace(/^[\{\}\[\]"'\s]+|[\{\}\[\]"'\s]+$/g, '')
    .trim()
}

function extractJsonArray(rawText) {
  let cleaned = String(rawText || '').trim()
  if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json/, '').replace(/```$/, '').trim()
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```/, '').replace(/```$/, '').trim()
  const firstBracket = cleaned.indexOf('[')
  const lastBracket = cleaned.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket) {
    cleaned = cleaned.substring(firstBracket, lastBracket + 1)
  }
  try {
    return JSON.parse(cleaned)
  } catch {
    throw new WorkerApiError(
      'پاسخ دریافتی از مدل هوش مصنوعی ساختار JSON معتبر نداشت.',
      502,
      'INVALID_MODEL_RESPONSE'
    )
  }
}

function extractJsonObject(rawText) {
  let cleaned = String(rawText || '').trim()
  if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json/, '').replace(/```$/, '').trim()
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```/, '').replace(/```$/, '').trim()
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1)
  }
  try {
    return JSON.parse(cleaned)
  } catch {
    throw new WorkerApiError(
      'پاسخ دریافتی از مدل هوش مصنوعی ساختار JSON معتبر نداشت.',
      502,
      'INVALID_MODEL_RESPONSE'
    )
  }
}

async function verifyTeacher(password, env) {
  const cleanPass = String(password || '').trim()
  if (!cleanPass) return false

  if (env.TEACHER_PASSWORD && cleanPass === String(env.TEACHER_PASSWORD).trim()) {
    return true
  }

  const supabaseUrl = String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '')
  const supabaseKey = String(env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3500)
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/verify_teacher`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ p_password: cleanPass }),
      signal: controller.signal,
    })
    if (!res.ok) return false
    const data = await res.json()
    return Boolean(data)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function authenticateTeacherRequest(request, body, url, env) {
  let teacherPass =
    request.headers.get('x-teacher-password') ||
    body?.teacherPassword ||
    url.searchParams.get('teacherPassword') ||
    ''

  if (!teacherPass) {
    const authHeader = request.headers.get('authorization') || ''
    if (authHeader.startsWith('Bearer ')) {
      teacherPass = authHeader.slice(7).trim()
    }
  }

  const cleanPass = String(teacherPass || '').trim()
  if (!cleanPass) {
    return {
      ok: false,
      response: jsonResponse(
        {
          success: false,
          code: 'TEACHER_AUTH_REQUIRED',
          error: 'دسترسی به درگاه هوش مصنوعی مسدود است. احراز هویت آموزگار (x-teacher-password) الزامی است.',
        },
        401,
        request
      ),
    }
  }

  const isValid = await verifyTeacher(cleanPass, env)
  if (!isValid) {
    return {
      ok: false,
      response: jsonResponse(
        {
          success: false,
          code: 'TEACHER_AUTH_INVALID',
          error: 'رمز عبور آموزگار نادرست یا نامعتبر است. دسترسی به امکانات هوش مصنوعی مجاز نمی‌باشد.',
        },
        403,
        request
      ),
    }
  }

  return { ok: true }
}

function classifyGeminiHttpError(status, errMessage = '') {
  const msg = String(errMessage || '')
  const lower = msg.toLowerCase()

  if (
    status === 401 ||
    status === 403 ||
    (status === 400 && (lower.includes('api key') || lower.includes('api_key_invalid'))) ||
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied')
  ) {
    return new WorkerApiError(
      'کلید دسترسی Gemini نامعتبر است یا دسترسی آن در سرویس گوگل فعال نیست.',
      403,
      'API_KEY_INVALID'
    )
  }

  if (
    status === 429 ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return new WorkerApiError(
      'سهمیه استفاده از سرویس هوش مصنوعی گوگل (Quota / Rate Limit) موقتاً تکمیل شده است.',
      429,
      'QUOTA_EXCEEDED'
    )
  }

  if (status === 404 || lower.includes('not found') || lower.includes('is not supported')) {
    return new WorkerApiError(
      `مدل انتخابی هوش مصنوعی در سرویس Gemini در دسترس نیست (${msg || 'HTTP 404'}).`,
      404,
      'MODEL_UNAVAILABLE'
    )
  }

  return new WorkerApiError(
    `خطا در ارتباط با سرویس Gemini (${status || 'Network'}): ${msg || 'پاسخ نامعتبر'}`,
    status >= 500 || !status ? 502 : status,
    'GEMINI_UPSTREAM_ERROR'
  )
}

function rankAvailableFlashModels(rawModels, preferredOverride) {
  const validIds = (Array.isArray(rawModels) ? rawModels : [])
    .filter((m) => {
      const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : []
      if (!methods.includes('generateContent')) return false
      const id = String(m?.name || '').replace(/^models\//, '').toLowerCase()
      if (!id.startsWith('gemini-')) return false
      return !DISALLOWED_MODEL_KEYWORDS.some((kw) => id.includes(kw))
    })
    .map((m) => String(m.name).replace(/^models\//, ''))

  const uniqueIds = Array.from(new Set(validIds))
  const ordered = []

  if (preferredOverride) {
    const cleanOverride = String(preferredOverride).replace(/^models\//, '').trim()
    if (uniqueIds.includes(cleanOverride)) {
      ordered.push(cleanOverride)
    }
  }

  for (const pattern of PREFERRED_MODEL_PATTERNS) {
    for (const id of uniqueIds) {
      if (pattern.test(id) && !ordered.includes(id)) {
        ordered.push(id)
      }
    }
  }

  for (const id of uniqueIds) {
    if (!ordered.includes(id)) {
      ordered.push(id)
    }
  }

  return ordered
}

async function discoverConfirmedGeminiModels(apiKey, env) {
  const preferredOverride = env.GEMINI_MODEL ? String(env.GEMINI_MODEL).trim() : ''
  const cacheKey = `${apiKey.slice(-6)}::${preferredOverride}`
  const cached = discoveredModelsCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() && cached.models.length > 0) {
    return cached.models
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey,
      },
      signal: controller.signal,
    })

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}))
      throw classifyGeminiHttpError(res.status, errData?.error?.message || `HTTP ${res.status}`)
    }

    const json = await res.json()
    const ranked = rankAvailableFlashModels(json?.models, preferredOverride)
    if (ranked.length === 0) {
      throw new WorkerApiError(
        'هیچ مدل پشتیبانی‌شده‌ای برای generateContent روی کلید Gemini یافت نشد.',
        502,
        'MODEL_UNAVAILABLE'
      )
    }

    const selected = ranked.slice(0, 4)
    discoveredModelsCache.set(cacheKey, {
      models: selected,
      expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
    })
    return selected
  } catch (err) {
    if (err instanceof WorkerApiError) throw err
    if (err?.name === 'AbortError') {
      throw new WorkerApiError('زمان انتظار بررسی مدل‌های Gemini به پایان رسید.', 504, 'GEMINI_TIMEOUT')
    }
    throw new WorkerApiError(
      `خطای شبکه هنگام دریافت فهرست مدل‌های Gemini: ${err?.message || err}`,
      502,
      'GEMINI_NETWORK_ERROR'
    )
  } finally {
    clearTimeout(timer)
  }
}

async function callGeminiWithFallbacks(prompt, env, responseJson = false) {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) {
    throw new WorkerApiError(
      'کلید GEMINI_API_KEY در تنظیمات Cloudflare Worker تعریف نشده است.',
      503,
      'GEMINI_KEY_MISSING'
    )
  }

  // Always confirm actually supported models on the API key rather than guessing unverified IDs
  const candidateModels = await discoverConfirmedGeminiModels(apiKey, env)
  let lastError = null

  for (const model of candidateModels) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 35000)
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        ...(responseJson
          ? { generationConfig: { responseMimeType: 'application/json' } }
          : {}),
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        const classified = classifyGeminiHttpError(res.status, errData?.error?.message || `HTTP ${res.status}`)
        lastError = classified
        // Invalid API key won't succeed on another model — fail fast
        if (classified.code === 'API_KEY_INVALID') {
          throw classified
        }
        continue
      }

      const json = await res.json()
      const parts = json?.candidates?.[0]?.content?.parts
      const text = Array.isArray(parts)
        ? parts.map((p) => p?.text || '').join('').trim()
        : ''

      if (text) {
        return text
      }
      lastError = new WorkerApiError(
        `مدل ${model} پاسخ متنی معتبری بازنگرداند.`,
        502,
        'INVALID_MODEL_RESPONSE'
      )
    } catch (err) {
      if (err instanceof WorkerApiError && err.code === 'API_KEY_INVALID') {
        throw err
      }
      if (err?.name === 'AbortError') {
        lastError = new WorkerApiError('زمان انتظار پاسخ از مدل Gemini به پایان رسید.', 504, 'GEMINI_TIMEOUT')
      } else if (err instanceof WorkerApiError) {
        lastError = err
      } else {
        lastError = new WorkerApiError(
          `خطای ارتباط با Gemini: ${err?.message || err}`,
          502,
          'GEMINI_UPSTREAM_ERROR'
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastError || new WorkerApiError('خطا در برقراری ارتباط با مدل‌های هوش مصنوعی', 502, 'GEMINI_UPSTREAM_ERROR')
}

function inferSubjectFromTopic(rawTopic, providedSubject) {
  let effectiveSubject = providedSubject && String(providedSubject).trim() ? String(providedSubject).trim() : ''
  const lowerTopic = String(rawTopic || '').toLowerCase()

  if (
    /علوم|گوارش|معده|بلع|روده|گردش خون|قلب|تنفس|شش|زلزله|سنگ|زمین|خاک|میکروسکوپ|سلول|نیرو|اهرم|انرژی|اسید|کاغذ|آتشفشان|گیاه|فتوسنتز|مخلوط|محلول|آهنربا|مدار|اصطکاک|آزمایش/.test(
      lowerTopic
    )
  ) {
    effectiveSubject = 'علوم تجربی'
  } else if (/ریاضی|کسر|اعشار|مساحت|محیط|حجم|تناسب|مختصات|تقارن|زاویه|احتمال|اعداد صحیح|هندسه|درصد|تقسیم|ضرب/.test(lowerTopic)) {
    effectiveSubject = 'ریاضی'
  } else if (/فارسی|شعر|آرایه|تشبیه|کنایه|مفعول|نهاد|مسند|انشا|نگارش|ستایش|نیایش|املا/.test(lowerTopic)) {
    effectiveSubject = 'فارسی'
  } else if (/تیزهوشان|سمپاد|هوش|استعداد تحلیلی|مکعب|تاس|چرخ دنده/.test(lowerTopic)) {
    effectiveSubject = 'هوش و استعداد تحلیلی (تیزهوشان)'
  } else if (/هدیه|دینی|پیامبر|امام|نماز|وضو|قرآن|معاد/.test(lowerTopic)) {
    effectiveSubject = 'هدیه‌های آسمان'
  } else if (/اجتماعی|تاریخ|جغرافیا|مدنی|ایران|اصفهان|صفویه|کشاورزی|انرژی فسیلی/.test(lowerTopic)) {
    effectiveSubject = 'مطالعات اجتماعی'
  }

  return effectiveSubject || 'پایه ششم ابتدایی'
}

async function handleAiRoutes(pathname, request, url, env) {
  if (request.method !== 'POST') {
    return jsonResponse(
      { success: false, code: 'METHOD_NOT_ALLOWED', error: `متد ${request.method} برای ${pathname} مجاز نیست.` },
      405,
      request
    )
  }

  let body = {}
  try {
    body = await request.json()
  } catch {
    return jsonResponse(
      { success: false, code: 'INVALID_REQUEST_JSON', error: 'بدنه درخواست JSON معتبر نیست.' },
      400,
      request
    )
  }

  const auth = await authenticateTeacherRequest(request, body, url, env)
  if (!auth.ok) return auth.response

  try {
    if (pathname === '/api/ai/generate-exam') {
      const {
        subject = '',
        topic = '',
        count = 5,
        types = ['multiple_choice', 'fill_in_the_blank', 'descriptive'],
        difficulty = 'medium',
        extraInstructions = '',
      } = body

      const rawTopic = String(topic || '').trim()
      if (!rawTopic) {
        return jsonResponse({ success: false, code: 'BAD_REQUEST', error: 'موضوع آزمون مشخص نشده است.' }, 400, request)
      }

      const effectiveSubject = inferSubjectFromTopic(rawTopic, subject)
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
🔢 تعداد کل سوالات: ${numCount} سوال
📝 انواع سوالات مورد نظر: ${Array.isArray(types) ? types.join('، ') : 'چهارگزینه‌ای، جای خالی، تشریحی'}

اصول طراحی:
۱. سوالات زنده، ملموس و متناسب با سن ۱۲ سالگی باشند.
۲. در سوالات چهارگزینه‌ای ۴ گزینه متمایز و ایندکس صحیح متغیر (۰ تا ۳) در correctAnswer و متن دقیق در correctOptionText قرار دهید.
۳. در پاسخنامه و راهنمای تصحیح (rubricOrHint) دلیل درستی پاسخ را کامل توضیح دهید.

خروجی صرفاً یک آرایه JSON معتبر باشد:
[
  {
    "id": "q1",
    "type": "multiple_choice",
    "question": "متن روان صورت سوال",
    "options": ["گزینه ۱", "گزینه ۲", "گزینه ۳", "گزینه ۴"],
    "correctAnswer": 2,
    "correctOptionText": "گزینه ۳",
    "rubricOrHint": "توضیح کامل پاسخنامه",
    "points": 2
  }
]`

      const jsonText = await callGeminiWithFallbacks(prompt, env, true)
      const parsed = extractJsonArray(jsonText)
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new WorkerApiError('قالب بازگشتی هوش مصنوعی معتبر نبود.', 502, 'INVALID_MODEL_RESPONSE')
      }

      const processedQuestions = parsed.map((q, qIdx) => {
        if (!q || typeof q !== 'object') return q
        const baseId = q.id || `q_${Date.now()}_${qIdx}`
        if (q.type === 'multiple_choice' && Array.isArray(q.options) && q.options.length > 0) {
          const res = resolveCorrectOptionIndex(q)
          let finalIdx =
            res.isValid && res.index >= 0
              ? res.index
              : typeof q.correctAnswer === 'number'
              ? q.correctAnswer
              : 0
          if (finalIdx < 0 || finalIdx >= q.options.length) finalIdx = 0
          return {
            ...q,
            id: baseId,
            correctAnswer: finalIdx,
            correctOptionIndex: finalIdx,
            correctOptionText: q.correctOptionText
              ? cleanOptionText(q.correctOptionText)
              : cleanOptionText(q.options[finalIdx] || ''),
          }
        }
        return { ...q, id: baseId }
      })

      return jsonResponse(
        {
          success: true,
          detectedSubject: effectiveSubject,
          questions: processedQuestions,
        },
        200,
        request
      )
    }

    if (pathname === '/api/ai/regenerate-question') {
      const {
        subject = '',
        topic = '',
        type = 'multiple_choice',
        difficulty = 'medium',
        points = 2,
        previousQuestion = '',
        extraInstructions = '',
      } = body

      const effectiveSubject = subject && String(subject).trim() ? String(subject).trim() : 'کتاب‌های درسی پایه ششم ابتدایی'
      const prompt = `شما آموزگار متخصص پایه ششم ابتدایی هستید. آموزگار سوال قبلی زیر را تایید نکرده است:
«${previousQuestion || '(بدون متن)'}»

یک سوال کاملاً جدید و باکیفیت برای درس «${effectiveSubject}» و مبحث «${topic || 'کتاب درسی ششم'}» با نوع «${type}»، سطح «${difficulty}» و بارم «${Number(points) || 2} نمره» طراحی کنید.
${extraInstructions ? `دستور آموزگار: ${extraInstructions}` : ''}

پاسخ را صرفاً به صورت یک شیء JSON معتبر تحویل دهید:
{
  "id": "q_${Date.now()}",
  "type": "${type}",
  "question": "متن سوال جدید",
  ${type === 'multiple_choice' ? `"options": ["گزینه ۱", "گزینه ۲", "گزینه ۳", "گزینه ۴"],\n  "correctAnswer": 1,\n  "correctOptionText": "متن گزینه صحیح",` : ''}
  ${type === 'fill_in_the_blank' ? `"correctAnswer": "پاسخ دقیق جای خالی",` : ''}
  "rubricOrHint": "راهنمای حل",
  "points": ${Number(points) || 2}
}`

      const jsonText = await callGeminiWithFallbacks(prompt, env, true)
      const parsed = extractJsonObject(jsonText)
      if (!parsed || !parsed.question) {
        throw new WorkerApiError('قالب بازگشتی سوال معتبر نبود.', 502, 'INVALID_MODEL_RESPONSE')
      }

      parsed.points = Number(parsed.points) || Number(points) || 2
      if (parsed.type === 'multiple_choice' && (!Array.isArray(parsed.options) || parsed.options.length < 2)) {
        parsed.options = ['الف', 'ب', 'ج', 'د']
      }
      if (parsed.type === 'multiple_choice' && Array.isArray(parsed.options) && parsed.options.length > 0) {
        const res = resolveCorrectOptionIndex(parsed)
        let finalIdx =
          res.isValid && res.index >= 0
            ? res.index
            : typeof parsed.correctAnswer === 'number'
            ? parsed.correctAnswer
            : 0
        if (finalIdx < 0 || finalIdx >= parsed.options.length) finalIdx = 0
        parsed.correctAnswer = finalIdx
        parsed.correctOptionIndex = finalIdx
        parsed.correctOptionText = parsed.correctOptionText
          ? cleanOptionText(parsed.correctOptionText)
          : cleanOptionText(parsed.options[finalIdx] || '')
      }

      return jsonResponse({ success: true, question: parsed }, 200, request)
    }

    if (pathname === '/api/ai/convert-practice-to-exam') {
      const { text } = body
      if (!text || !String(text).trim()) {
        return jsonResponse({ success: false, code: 'BAD_REQUEST', error: 'متن تمرین یا کاربرگ ارسال نشده است.' }, 400, request)
      }

      const prompt = `شما دستیار هوشمند آموزگار پایه ششم هستید. متن کاربرگ زیر را به سوالات آزمون آنلاین استاندارد (آرایه JSON) تبدیل کنید:
${text}

خروجی باید صرفاً یک آرایه JSON معتبر باشد:
[
  {
    "id": "q1",
    "type": "multiple_choice",
    "question": "صورت سوال",
    "options": ["گزینه ۱", "گزینه ۲", "گزینه ۳", "گزینه ۴"],
    "correctAnswer": 1,
    "correctOptionText": "گزینه ۲",
    "rubricOrHint": "استدلال یا پاسخنامه",
    "points": 2
  }
]`

      const jsonText = await callGeminiWithFallbacks(prompt, env, true)
      const parsed = extractJsonArray(jsonText)
      const processedQuestions = (Array.isArray(parsed) ? parsed : []).map((q, qIdx) => {
        if (!q || typeof q !== 'object') return q
        const baseId = q.id || `q_conv_${Date.now()}_${qIdx}`
        if (q.type === 'multiple_choice' && Array.isArray(q.options) && q.options.length > 0) {
          const res = resolveCorrectOptionIndex(q)
          let finalIdx =
            res.isValid && res.index >= 0
              ? res.index
              : typeof q.correctAnswer === 'number'
              ? q.correctAnswer
              : 0
          if (finalIdx < 0 || finalIdx >= q.options.length) finalIdx = 0
          return {
            ...q,
            id: baseId,
            correctAnswer: finalIdx,
            correctOptionIndex: finalIdx,
            correctOptionText: q.correctOptionText
              ? cleanOptionText(q.correctOptionText)
              : cleanOptionText(q.options[finalIdx] || ''),
          }
        }
        return { ...q, id: baseId }
      })

      return jsonResponse({ success: true, questions: processedQuestions }, 200, request)
    }

    if (pathname === '/api/ai/generate-practice') {
      const { topic = '', count = 5, difficulty = 'medium' } = body
      const difficultyLabel = ({ easy: 'ساده', medium: 'متوسط', hard: 'سخت و تیزهوشانی' })[difficulty] || 'متوسط'
      const prompt = `شما آموزگار شایسته، دلسوز و حرفه‌ای پایه ششم ابتدایی هستید.
موضوع و خواسته معلم برای تکلیف/تمرین: «${topic}»
سطح دشواری: ${difficultyLabel}
تعداد: ${count} سوال

دستورات حیاتی برای قالب‌بندی:
۱. هرگز جواب یا کلید سوال را در صورت سوال ننویسید.
۲. صورت هر سوال شفاف، سناریودار و مناسب سن ۱۲ سالگی باشد.
۳. پاسخنامه و راه‌حل گام‌به‌گام فقط در انتهای متن و پس از جداکننده «---» و با عنوان «📝 پاسخنامه و راهنمای حل تشریحی (ویژه معلم)» قرار گیرد.`

      const text = await callGeminiWithFallbacks(prompt, env, false)
      return jsonResponse({ success: true, text }, 200, request)
    }

    if (pathname === '/api/ai/classroom-chat') {
      const { message = '', classroomContext = {} } = body
      if (!message || !String(message).trim()) {
        return jsonResponse({ success: false, code: 'BAD_REQUEST', error: 'متن پرسش یا پیام معلم مشخص نشده است.' }, 400, request)
      }

      const contextText =
        typeof classroomContext === 'string' ? classroomContext : JSON.stringify(classroomContext, null, 2)

      const prompt = `شما یک دستیار هوشمند و مشاور ارشد پداگوژی و تحلیل داده‌های کلاس درس برای آموزگار پایه ششم ابتدایی هستید.
داده‌های واقعی دریافتی از سامانه کلاس:
${contextText}

پیام یا سوال آموزگار:
«${message}»

لطفاً تحلیلی دقیق، داده‌محور در مقیاس ۲۰، با اعداد فارسی و لحنی صمیمی و کاربردی ارائه دهید.`

      const reply = await callGeminiWithFallbacks(prompt, env, false)
      return jsonResponse({ success: true, reply }, 200, request)
    }

    if (pathname === '/api/ai/preview') {
      const { topic = '', difficulty = 'medium' } = body
      const prompt = `به عنوان طراح سوال پایه ششم، بر اساس این موضوع: «${topic}» و سطح «${difficulty}»، ۳ سوال نمونه واقعی و آموزنده طراحی کن. بین هر سوال فاصله بگذار. بدون حاشیه و پاسخنامه.`
      const text = await callGeminiWithFallbacks(prompt, env, false)
      return jsonResponse({ success: true, text }, 200, request)
    }

    if (pathname === '/api/ai/generate-announcement') {
      const { topic = '' } = body
      const prompt = `شما آموزگار مهربان و باانگیزه پایه ششم هستید. بر اساس یادداشت زیر، یک اطلاعیه کلاسی شاداب، رسمی، خوانا و منظم برای دانش‌آموزان و اولیا بنویسید:
«${topic}»
خط اول عنوان باشد و متن اعلان در ۲ الی ۴ بند مرتب.`
      const text = await callGeminiWithFallbacks(prompt, env, false)
      return jsonResponse({ success: true, text }, 200, request)
    }

    if (pathname === '/api/ai/grade-submission') {
      const { questions, studentName = 'دانش‌آموز', totalPoints = 20 } = body
      if (!Array.isArray(questions)) {
        return jsonResponse({ success: false, code: 'BAD_REQUEST', error: 'questions array is required' }, 400, request)
      }

      const prompt = `شما آموزگار شایسته، دلسوز، بسیار منعطف و کارآزموده پایه ششم ابتدایی هستید.
دانش‌آموز «${studentName}» به سوالات زیر پاسخ داده است:
${JSON.stringify(questions, null, 2)}

قوانین تصحیح:
۱. مفهوم پاسخ مهم‌تر از تطابق کلمه به کلمه است؛ مترادف‌ها و ادبیات کودکانه را بپذیرید و خطاهای املایی/نیم‌فاصله را نادیده بگیرید.
۲. پاسخ متناقض نمره نگیرد؛ پاسخ جزئی نمره جزئی عادلانه بگیرد.
۳. یادداشت معلمانه (teacherSummaryNote) صمیمی و بدون هیچ اشاره‌ای به هوش مصنوعی باشد.

خروجی صرفاً JSON با این ساختار:
{
  "grades": [{ "id": "شناسه سوال", "score": 2, "status": "correct", "feedback": "بازخورد کوتاه" }],
  "teacherSummaryNote": "یادداشت آموزگار"
}`

      const jsonText = await callGeminiWithFallbacks(prompt, env, true)
      const parsed = extractJsonObject(jsonText)
      const rawGradesArr = Array.isArray(parsed) ? parsed : parsed.grades || []
      const cleanNote = sanitizeTeacherNote(Array.isArray(parsed) ? '' : parsed.teacherSummaryNote || '')

      const sanitizedGrades = rawGradesArr.map((g) => {
        const matchingQ = questions.find((q) => q.id === g.id)
        const qMax = Math.max(0.5, Number(matchingQ?.points) || 2)
        const parsedScore = Number(g.score)
        const safeSc =
          Number.isNaN(parsedScore) || !Number.isFinite(parsedScore)
            ? 0
            : Math.min(qMax, Math.max(0, Math.round(parsedScore * 100) / 100))
        return {
          id: g.id,
          score: safeSc,
          status: g.status || (safeSc >= qMax * 0.85 ? 'correct' : safeSc > 0 ? 'partial' : 'incorrect'),
          feedback: g.feedback || `ارزیابی آموزگار: ${safeSc} از ${qMax}`,
        }
      })

      const totalEarned = sanitizedGrades.reduce((sum, g) => sum + g.score, 0)
      const maxPts = Math.max(1, Number(totalPoints) || 20)
      const boundedEarned = Math.min(maxPts, Math.max(0, Math.round(totalEarned * 100) / 100))
      const scaledScore20 = Math.min(20, Math.max(0, Math.round(((boundedEarned / maxPts) * 20) * 100) / 100))

      return jsonResponse(
        {
          success: true,
          grades: sanitizedGrades,
          totalScore: boundedEarned,
          maxScore: maxPts,
          scaledScore20,
          scale: 20,
          teacherSummaryNote: cleanNote,
        },
        200,
        request
      )
    }

    return jsonResponse(
      { success: false, code: 'NOT_FOUND', error: `مسیر هوش مصنوعی یافت نشد: ${pathname}` },
      404,
      request
    )
  } catch (err) {
    const status = err instanceof WorkerApiError ? err.status : 500
    const code = err instanceof WorkerApiError ? err.code : 'INTERNAL_ERROR'
    return jsonResponse(
      {
        success: false,
        code,
        error: err?.message || 'خطا در ارتباط با سرویس هوش مصنوعی',
      },
      status,
      request
    )
  }
}

async function proxyToNetlify(request, url, env) {
  const upstreamRaw = String(env.NETLIFY_ORIGIN || '').trim().replace(/\/+$/, '')
  if (!upstreamRaw || upstreamRaw.includes('YOUR-NETLIFY-SITE')) {
    return jsonResponse(
      {
        success: false,
        code: 'NETLIFY_ORIGIN_MISSING',
        error: 'متغیر NETLIFY_ORIGIN در تنظیمات Cloudflare Worker تعریف نشده است.',
      },
      500,
      request
    )
  }

  let upstreamUrl
  try {
    upstreamUrl = new URL(url.pathname + url.search, upstreamRaw)
  } catch {
    return jsonResponse(
      { success: false, code: 'NETLIFY_ORIGIN_INVALID', error: 'مقدار NETLIFY_ORIGIN نامعتبر است.' },
      500,
      request
    )
  }

  if (upstreamUrl.hostname === url.hostname) {
    return jsonResponse(
      {
        success: false,
        code: 'PROXY_LOOP_BLOCKED',
        error: 'NETLIFY_ORIGIN نباید به آدرس خود Worker اشاره کند (جلوگیری از حلقه پروکسی).',
      },
      500,
      request
    )
  }

  const forwardedHeaders = new Headers(request.headers)
  forwardedHeaders.delete('host')
  forwardedHeaders.set('x-forwarded-host', url.hostname)

  const init = {
    method: request.method,
    headers: forwardedHeaders,
    redirect: 'follow',
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
  }

  return fetch(upstreamUrl.toString(), init)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const pathname = url.pathname

    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: getCorsHeaders(request) })
    }

    if (pathname === '/api/health') {
      return jsonResponse(
        {
          status: 'ok',
          runtime: 'cloudflare-worker',
          hasGeminiKey: Boolean(env.GEMINI_API_KEY),
          hasNetlifyOrigin: Boolean(
            env.NETLIFY_ORIGIN && !String(env.NETLIFY_ORIGIN).includes('YOUR-NETLIFY-SITE')
          ),
        },
        200,
        request
      )
    }

    if (pathname.startsWith('/api/ai/')) {
      return handleAiRoutes(pathname, request, url, env)
    }

    return proxyToNetlify(request, url, env)
  },
}

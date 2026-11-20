/**
 * Cloudflare Worker: Netlify Reverse Proxy + Supabase Proxy (/sb/* + Realtime WebSocket) + Secure Server-Side Gemini AI Gateway (/api/ai/*)
 * Target Worker: https://class.nemat-darkhah.workers.dev
 *
 * Required Cloudflare Worker Variables & Secrets (Dashboard -> Settings -> Variables and Secrets):
 * - GEMINI_API_KEY (Secret): Google Gemini API Key (NEVER expose in Frontend / GitHub)
 * - NETLIFY_ORIGIN (Text Variable): Your Netlify site URL (e.g. https://your-site-name.netlify.app)
 * - SUPABASE_URL (Text Variable, Optional): Supabase Project URL (defaults to https://ephgqrnbpxvxlzloflhy.supabase.co)
 * - TEACHER_PASSWORD (Optional Secret): Override teacher password check (otherwise verified via Supabase verify_teacher RPC)
 * - GEMINI_MODEL (Optional Text Variable): Preferred Gemini model ID override
 * - SUPABASE_ANON_KEY (Optional Text Variable): Defaults to existing public Supabase publishable/anon key
 */

const DEFAULT_SUPABASE_URL = 'https://ephgqrnbpxvxlzloflhy.supabase.co'
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_bI5v4Hzokb0A4JWJDzuz1A_4B3lIUX_'

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite'
const GEMINI_TIMEOUT_MS = 20000
const MODEL_LIST_TIMEOUT_MS = 8000

const WORKING_MODEL_CACHE_TTL_MS = 30 * 60 * 1000
const workingModelCache = new Map()

const EXCLUDED_DISCOVERY_KEYWORDS = ['preview', 'tts', 'live', 'image', 'audio', 'embedding']

const TEACHER_AUTH_CACHE_TTL_MS = 5 * 60 * 1000
const teacherAuthCache = new Map()

const EXAM_QUESTIONS_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'STRING' },
      type: {
        type: 'STRING',
        enum: ['multiple_choice', 'fill_in_the_blank', 'descriptive'],
      },
      question: { type: 'STRING' },
      options: {
        type: 'ARRAY',
        items: { type: 'STRING' },
      },
      correctAnswer: { type: 'STRING' },
      correctOptionText: { type: 'STRING' },
      rubricOrHint: { type: 'STRING' },
      points: { type: 'NUMBER' },
    },
    required: ['id', 'type', 'question', 'rubricOrHint', 'points'],
  },
}

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

function getSupabaseCorsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '*'
  const reqHeaders = request?.headers?.get('Access-Control-Request-Headers')
  const defaultAllowed =
    'apikey, authorization, content-type, prefer, x-client-info, range, accept, accept-profile, content-profile, x-upsert, x-supabase-api-version, cache-control, pragma'
  const allowHeaders = reqHeaders
    ? Array.from(
        new Set(
          `${defaultAllowed}, ${reqHeaders}`
            .split(',')
            .map((h) => h.trim())
            .filter(Boolean)
        )
      ).join(', ')
    : defaultAllowed

  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Expose-Headers':
      'Content-Range, Range, Preference-Applied, X-Total-Count, Location, Content-Location',
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

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text || ''))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function verifyTeacher(password, env) {
  const cleanPass = String(password || '').trim()
  if (!cleanPass) return false

  if (env.TEACHER_PASSWORD && cleanPass === String(env.TEACHER_PASSWORD).trim()) {
    return true
  }

  const now = Date.now()
  const passHash = await sha256Hex(cleanPass)
  const cached = teacherAuthCache.get(passHash)
  if (cached && cached.expiresAt > now) {
    return cached.valid
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
    const valid = Boolean(data)

    if (teacherAuthCache.size >= 200) {
      for (const [k, v] of teacherAuthCache.entries()) {
        if (v.expiresAt <= now) teacherAuthCache.delete(k)
      }
      if (teacherAuthCache.size >= 200) {
        const firstKey = teacherAuthCache.keys().next().value
        if (firstKey) teacherAuthCache.delete(firstKey)
      }
    }
    teacherAuthCache.set(passHash, {
      valid,
      expiresAt: now + TEACHER_AUTH_CACHE_TTL_MS,
    })

    return valid
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
      'مرحله کلید دسترسی ناموفق بود: کلید Gemini نامعتبر است یا مجوز استفاده از این سرویس را ندارد.',
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
      'مرحله سهمیه سرویس ناموفق بود: سهمیه یا محدودیت نرخ درخواست Gemini (Quota / Rate Limit) موقتاً تکمیل شده است.',
      429,
      'QUOTA_EXCEEDED'
    )
  }

  if (status === 404 || lower.includes('not found') || lower.includes('is not supported')) {
    return new WorkerApiError(
      `مرحله انتخاب مدل ناموفق بود: مدل در دسترس نیست یا منسوخ شده است (${msg || 'HTTP 404'}).`,
      404,
      'MODEL_UNAVAILABLE'
    )
  }

  return new WorkerApiError(
    `مرحله ارتباط با سرویس Gemini ناموفق بود (${status || 'Network'}): ${msg || 'پاسخ نامعتبر'}`,
    status >= 500 || !status ? 502 : status,
    'GEMINI_UPSTREAM_ERROR'
  )
}

function isThinkingConfig400Error(status, errMessage = '') {
  if (status !== 400) return false
  const lower = String(errMessage || '').toLowerCase()
  return (
    lower.includes('thinking') ||
    lower.includes('thinking_config') ||
    lower.includes('thinkingconfig') ||
    lower.includes('thinking_budget') ||
    lower.includes('thinkingbudget') ||
    lower.includes('thinking_level') ||
    lower.includes('thinkinglevel')
  )
}

function buildThinkingConfigForModel(model) {
  const normalized = String(model || '').replace(/^models\//, '').toLowerCase().trim()
  if (normalized.startsWith('gemini-2.5')) {
    return { thinkingBudget: 0 }
  }
  const versionMatch = normalized.match(/^gemini-(\d+)(?:\.(\d+))?/)
  if (versionMatch && Number(versionMatch[1]) >= 3) {
    return { thinkingLevel: 'minimal' }
  }
  return null
}

function parseGeminiVersion(modelId) {
  const match = String(modelId || '').toLowerCase().match(/^gemini-(\d+)(?:\.(\d+))?/)
  if (!match) return { major: 0, minor: 0 }
  return {
    major: Number(match[1]) || 0,
    minor: Number(match[2]) || 0,
  }
}

function selectDiscoveredFlashModels(rawModels) {
  const eligible = (Array.isArray(rawModels) ? rawModels : [])
    .filter((m) => {
      const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : []
      if (!methods.includes('generateContent')) return false
      const id = String(m?.name || '').replace(/^models\//, '').trim()
      const lower = id.toLowerCase()
      if (!lower.startsWith('gemini-') || !lower.includes('flash')) return false
      return !EXCLUDED_DISCOVERY_KEYWORDS.some((kw) => lower.includes(kw))
    })
    .map((m) => String(m.name).replace(/^models\//, '').trim())

  const uniqueIds = Array.from(new Set(eligible))

  const compareByNewest = (a, b) => {
    const va = parseGeminiVersion(a)
    const vb = parseGeminiVersion(b)
    if (vb.major !== va.major) return vb.major - va.major
    if (vb.minor !== va.minor) return vb.minor - va.minor
    const aHasVariant = /-\d{3}$|-latest$|-exp/.test(a.toLowerCase()) ? 1 : 0
    const bHasVariant = /-\d{3}$|-latest$|-exp/.test(b.toLowerCase()) ? 1 : 0
    if (aHasVariant !== bHasVariant) return aHasVariant - bHasVariant
    return a.length - b.length
  }

  const liteModels = uniqueIds
    .filter((id) => id.toLowerCase().includes('flash-lite'))
    .sort(compareByNewest)

  const standardFlashModels = uniqueIds
    .filter((id) => !id.toLowerCase().includes('flash-lite'))
    .sort(compareByNewest)

  const ordered = []
  if (liteModels.length > 0) ordered.push(liteModels[0])
  if (standardFlashModels.length > 0) ordered.push(standardFlashModels[0])
  for (const id of [...liteModels.slice(1), ...standardFlashModels.slice(1)]) {
    if (!ordered.includes(id)) ordered.push(id)
  }
  return ordered
}

async function discoverFallbackFlashModels(apiKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS)
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
    const ranked = selectDiscoveredFlashModels(json?.models)
    if (ranked.length === 0) {
      throw new WorkerApiError(
        'مرحله انتخاب مدل ناموفق بود: هیچ مدل پایدار gemini-*flash* با قابلیت generateContent در فهرست مدل‌های Gemini یافت نشد.',
        404,
        'MODEL_UNAVAILABLE'
      )
    }

    return ranked
  } catch (err) {
    if (err instanceof WorkerApiError) throw err
    if (err?.name === 'AbortError') {
      throw new WorkerApiError(
        'مرحله کشف مدل جایگزین ناموفق بود: زمان انتظار دریافت فهرست مدل‌های Gemini به پایان رسید.',
        504,
        'GEMINI_TIMEOUT'
      )
    }
    throw new WorkerApiError(
      `مرحله کشف مدل جایگزین ناموفق بود: خطای شبکه هنگام دریافت فهرست مدل‌های Gemini (${err?.message || err}).`,
      502,
      'GEMINI_UPSTREAM_ERROR'
    )
  } finally {
    clearTimeout(timer)
  }
}

async function executeGeminiRequest(
  model,
  prompt,
  apiKey,
  responseJson = false,
  responseSchema = null,
  omitThinkingConfig = false
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
    const thinkingConfig = omitThinkingConfig ? null : buildThinkingConfigForModel(model)

    const generationConfig = {}
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig
    }
    if (responseJson) {
      generationConfig.temperature = 0.4
      generationConfig.responseMimeType = 'application/json'
      if (responseSchema) {
        generationConfig.responseSchema = responseSchema
      }
    }

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
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
      const errMsg = errData?.error?.message || `HTTP ${res.status}`
      if (!omitThinkingConfig && thinkingConfig && isThinkingConfig400Error(res.status, errMsg)) {
        return { retryWithoutThinking: true }
      }
      throw classifyGeminiHttpError(res.status, errMsg)
    }

    const json = await res.json()
    const parts = json?.candidates?.[0]?.content?.parts
    const text = Array.isArray(parts)
      ? parts.map((p) => p?.text || '').join('').trim()
      : ''

    if (!text) {
      throw new WorkerApiError(
        `مرحله دریافت پاسخ ناموفق بود: مدل ${model} خروجی متنی معتبری بازنگرداند.`,
        502,
        'INVALID_MODEL_RESPONSE'
      )
    }

    return { retryWithoutThinking: false, text }
  } catch (err) {
    if (err instanceof WorkerApiError) throw err
    if (err?.name === 'AbortError') {
      throw new WorkerApiError(
        'مرحله دریافت پاسخ از مدل هوش مصنوعی ناموفق بود: زمان انتظار (۲۰ ثانیه) به پایان رسید.',
        504,
        'GEMINI_TIMEOUT'
      )
    }
    throw new WorkerApiError(
      `مرحله ارتباط با سرویس Gemini ناموفق بود: ${err?.message || err}`,
      502,
      'GEMINI_UPSTREAM_ERROR'
    )
  } finally {
    clearTimeout(timer)
  }
}

async function callSingleGeminiModel(model, prompt, apiKey, responseJson = false, responseSchema = null) {
  const firstAttempt = await executeGeminiRequest(model, prompt, apiKey, responseJson, responseSchema, false)
  if (firstAttempt.retryWithoutThinking) {
    const secondAttempt = await executeGeminiRequest(model, prompt, apiKey, responseJson, responseSchema, true)
    return secondAttempt.text
  }
  return firstAttempt.text
}

function getWorkingModelCacheKey(apiKey, configuredPrimary) {
  return `${String(apiKey || '').slice(-6)}::${configuredPrimary}`
}

function cacheWorkingModel(cacheKey, model) {
  workingModelCache.set(cacheKey, {
    model,
    expiresAt: Date.now() + WORKING_MODEL_CACHE_TTL_MS,
  })
}

async function callGeminiWithFallbacks(prompt, env, responseJson = false, responseSchema = null) {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) {
    throw new WorkerApiError(
      'مرحله کلید دسترسی ناموفق بود: کلید GEMINI_API_KEY در تنظیمات Cloudflare Worker تعریف نشده است.',
      503,
      'GEMINI_KEY_MISSING'
    )
  }

  const configuredPrimary =
    String(env.GEMINI_MODEL || '')
      .replace(/^models\//, '')
      .trim() || DEFAULT_GEMINI_MODEL

  const cacheKey = getWorkingModelCacheKey(apiKey, configuredPrimary)
  const cached = workingModelCache.get(cacheKey)
  const initialModel = cached && cached.expiresAt > Date.now() && cached.model
    ? cached.model
    : configuredPrimary

  try {
    const text = await callSingleGeminiModel(initialModel, prompt, apiKey, responseJson, responseSchema)
    cacheWorkingModel(cacheKey, initialModel)
    return text
  } catch (err) {
    const isModelUnavailable =
      err instanceof WorkerApiError &&
      (err.status === 404 || err.code === 'MODEL_UNAVAILABLE')

    if (!isModelUnavailable) {
      throw err
    }

    // Invalidate stale cached model and discover the newest stable flash-lite / flash model once
    workingModelCache.delete(cacheKey)

    const discovered = await discoverFallbackFlashModels(apiKey)
    const fallbackCandidates = discovered.filter((m) => m !== initialModel).slice(0, 2)
    if (fallbackCandidates.length === 0) {
      throw new WorkerApiError(
        `مرحله انتخاب مدل ناموفق بود: مدل «${initialModel}» در دسترس نیست و مدل جایگزین پایداری در حساب Gemini یافت نشد.`,
        404,
        'MODEL_UNAVAILABLE'
      )
    }

    let lastErr = err
    for (const candidateModel of fallbackCandidates) {
      try {
        const text = await callSingleGeminiModel(candidateModel, prompt, apiKey, responseJson, responseSchema)
        cacheWorkingModel(cacheKey, candidateModel)
        return text
      } catch (candidateErr) {
        lastErr = candidateErr
        const candidateUnavailable =
          candidateErr instanceof WorkerApiError &&
          (candidateErr.status === 404 || candidateErr.code === 'MODEL_UNAVAILABLE')
        if (!candidateUnavailable) {
          throw candidateErr
        }
      }
    }

    throw lastErr
  }
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

      const typesText = Array.isArray(types) ? types.join('، ') : 'چهارگزینه‌ای، جای خالی، تشریحی'
      const buildExamPrompt = (batchCount, batchInstruction = '') => `شما آموزگار شایسته، دلسوز و حرفه‌ای پایه ششم ابتدایی هستید.
معلم از شما خواسته است برای این موضوع یک آزمون بسیار باکیفیت و استاندارد طراحی کنید:
🎯 موضوع: «${rawTopic}»
🎯 درس: «${effectiveSubject}»
${extraInstructions ? `🎯 توضیحات معلم: «${extraInstructions}»` : ''}
${batchInstruction ? `🎯 بخش‌بندی: ${batchInstruction}` : ''}
📊 سطح دشواری: ${difficultyDesc}
🔢 تعداد کل سوالات این بخش: ${batchCount} سوال
📝 انواع سوالات مورد نظر: ${typesText}

اصول طراحی:
۱. سوالات زنده، ملموس و متناسب با سن ۱۲ سالگی باشند.
۲. در سوالات چهارگزینه‌ای ۴ گزینه متمایز و ایندکس صحیح متغیر (۰ تا ۳ به صورت رشته مثل "2") در correctAnswer و متن دقیق در correctOptionText قرار دهید.
۳. در پاسخنامه و راهنمای تصحیح (rubricOrHint) دلیل درستی پاسخ را کامل توضیح دهید.
۴. خروجی صرفاً آرایه JSON با دقیقاً ${batchCount} سوال باشد.`

      let parsed = []
      if (numCount > 10) {
        const firstBatchCount = Math.ceil(numCount / 2)
        const secondBatchCount = numCount - firstBatchCount
        const promptA = buildExamPrompt(
          firstBatchCount,
          `بخش اول (سوالات ۱ تا ${firstBatchCount}): تمرکز بر مفاهیم پایه، درک مطلب و کاربرد مستقیم.`
        )
        const promptB = buildExamPrompt(
          secondBatchCount,
          `بخش دوم (سوالات ${firstBatchCount + 1} تا ${numCount}): تمرکز بر سوالات تحلیلی، ترکیبی و متفاوت از بخش اول بدون تکرار.`
        )

        const [jsonTextA, jsonTextB] = await Promise.all([
          callGeminiWithFallbacks(promptA, env, true, EXAM_QUESTIONS_RESPONSE_SCHEMA),
          callGeminiWithFallbacks(promptB, env, true, EXAM_QUESTIONS_RESPONSE_SCHEMA),
        ])

        const arrA = extractJsonArray(jsonTextA)
        const arrB = extractJsonArray(jsonTextB)
        parsed = [
          ...(Array.isArray(arrA) ? arrA : []),
          ...(Array.isArray(arrB) ? arrB : []),
        ]
      } else {
        const prompt = buildExamPrompt(numCount)
        const jsonText = await callGeminiWithFallbacks(prompt, env, true, EXAM_QUESTIONS_RESPONSE_SCHEMA)
        parsed = extractJsonArray(jsonText)
      }

      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new WorkerApiError('قالب بازگشتی هوش مصنوعی معتبر نبود.', 502, 'INVALID_MODEL_RESPONSE')
      }

      const runTs = Date.now()
      const seenIds = new Set()
      const processedQuestions = parsed.map((q, qIdx) => {
        if (!q || typeof q !== 'object') return q
        let baseId = String(q.id || '').trim()
        if (!baseId || seenIds.has(baseId)) {
          baseId = `q_${runTs}_${qIdx + 1}`
        }
        seenIds.add(baseId)

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
        const normalized = { ...q, id: baseId }
        if (Array.isArray(normalized.options) && normalized.options.length === 0) {
          delete normalized.options
        }
        return normalized
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

      const jsonText = await callGeminiWithFallbacks(prompt, env, true, EXAM_QUESTIONS_RESPONSE_SCHEMA)
      const parsed = extractJsonArray(jsonText)
      const runTs = Date.now()
      const seenIds = new Set()
      const processedQuestions = (Array.isArray(parsed) ? parsed : []).map((q, qIdx) => {
        if (!q || typeof q !== 'object') return q
        let baseId = String(q.id || '').trim()
        if (!baseId || seenIds.has(baseId)) {
          baseId = `q_conv_${runTs}_${qIdx + 1}`
        }
        seenIds.add(baseId)
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
        const normalized = { ...q, id: baseId }
        if (Array.isArray(normalized.options) && normalized.options.length === 0) {
          delete normalized.options
        }
        return normalized
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

async function proxyToSupabase(request, url, env) {
  const supabaseBaseRaw = String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim().replace(/\/+$/, '')
  if (!supabaseBaseRaw) {
    return new Response(
      JSON.stringify({
        success: false,
        code: 'SUPABASE_URL_MISSING',
        error: 'متغیر SUPABASE_URL در تنظیمات Cloudflare Worker نامعتبر است.',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...getSupabaseCorsHeaders(request),
          ...NO_CACHE_HEADERS,
        },
      }
    )
  }

  const subPath = url.pathname === '/sb' ? '/' : url.pathname.slice(3) || '/'
  let upstreamUrl
  try {
    upstreamUrl = new URL(subPath + url.search, supabaseBaseRaw)
  } catch {
    return new Response(
      JSON.stringify({
        success: false,
        code: 'SUPABASE_URL_INVALID',
        error: 'مقدار SUPABASE_URL در تنظیمات Cloudflare Worker نامعتبر است.',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...getSupabaseCorsHeaders(request),
          ...NO_CACHE_HEADERS,
        },
      }
    )
  }

  if (upstreamUrl.hostname === url.hostname) {
    return new Response(
      JSON.stringify({
        success: false,
        code: 'PROXY_LOOP_BLOCKED',
        error: 'SUPABASE_URL نباید به آدرس خود Worker اشاره کند (جلوگیری از حلقه پروکسی).',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...getSupabaseCorsHeaders(request),
          ...NO_CACHE_HEADERS,
        },
      }
    )
  }

  // Forward original request headers (apikey, authorization, content-type, prefer, x-client-info, etc.) unchanged
  const forwardedHeaders = new Headers(request.headers)
  forwardedHeaders.delete('host')
  forwardedHeaders.delete('cf-connecting-ip')
  forwardedHeaders.delete('cf-ipcountry')
  forwardedHeaders.delete('cf-ray')
  forwardedHeaders.delete('cf-visitor')

  const isWebSocketUpgrade =
    (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket'

  try {
    if (isWebSocketUpgrade) {
      return await fetch(upstreamUrl.toString(), {
        method: request.method,
        headers: forwardedHeaders,
      })
    }

    const init = {
      method: request.method,
      headers: forwardedHeaders,
      redirect: 'manual',
      cf: {
        cacheTtl: 0,
        cacheEverything: false,
      },
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body
    }

    const upstreamRes = await fetch(upstreamUrl.toString(), init)
    if (upstreamRes.status === 101 || upstreamRes.webSocket) {
      return upstreamRes
    }

    const responseHeaders = new Headers(upstreamRes.headers)
    const corsHeaders = getSupabaseCorsHeaders(request)
    for (const [k, v] of Object.entries(corsHeaders)) {
      responseHeaders.set(k, v)
    }
    for (const [k, v] of Object.entries(NO_CACHE_HEADERS)) {
      responseHeaders.set(k, v)
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    })
  } catch (err) {
    return new Response(
      JSON.stringify({
        success: false,
        code: 'SUPABASE_PROXY_ERROR',
        error: `خطا در ارتباط پروکسی با Supabase: ${err?.message || err}`,
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...getSupabaseCorsHeaders(request),
          ...NO_CACHE_HEADERS,
        },
      }
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

    if (request.method === 'OPTIONS' && (pathname === '/sb' || pathname.startsWith('/sb/'))) {
      return new Response(null, {
        status: 204,
        headers: {
          ...getSupabaseCorsHeaders(request),
          ...NO_CACHE_HEADERS,
        },
      })
    }

    if (pathname === '/sb' || pathname.startsWith('/sb/')) {
      return proxyToSupabase(request, url, env)
    }

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
          hasSupabaseProxy: true,
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

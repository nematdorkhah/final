import { Exam, ExamQuestion } from '../types/examTypes'

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
  stage?: string
  examId?: string
  shouldRetry?: (err: any) => boolean
}

export interface FetchDiagnosticEntry {
  timestamp: string
  examId: string | null
  stage: string
  statusOrError: string
  durationMs: number
  retryCount: number
  finalStatus: 'success' | 'recovered_after_retry' | 'failed'
}

const MAX_DIAGNOSTICS_LOG = 100
const diagnosticsBuffer: FetchDiagnosticEntry[] = []

// Tracks whether the current deployment origin serves static SPA HTML / Netlify 404 HTML for /api/*
let backendStaticOnlyUntil = 0
const STATIC_ONLY_TTL_MS = 300_000
const STATIC_ONLY_STORAGE_KEY = 'classroom_backend_static_only_until'

export function resolveApiUrl(path: string): string {
  if (!path) return path
  if (/^https?:\/\//i.test(path)) return path
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  try {
    const rawBase =
      (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) || ''
    const base = String(rawBase).trim().replace(/\/+$/, '')
    if (base) {
      return `${base}${normalizedPath}`
    }
  } catch {}
  return normalizedPath
}

export function isBackendStaticOnly(): boolean {
  const now = Date.now()
  if (now < backendStaticOnlyUntil) return true
  try {
    if (typeof sessionStorage !== 'undefined') {
      const stored = Number(sessionStorage.getItem(STATIC_ONLY_STORAGE_KEY) || '0')
      if (stored > now) {
        backendStaticOnlyUntil = stored
        return true
      }
    }
  } catch {}
  return false
}

export function markBackendStaticOnly(ttlMs = STATIC_ONLY_TTL_MS): void {
  const until = Date.now() + ttlMs
  backendStaticOnlyUntil = until
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(STATIC_ONLY_STORAGE_KEY, String(until))
    }
  } catch {}
}

export function markBackendAvailable(): void {
  backendStaticOnlyUntil = 0
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(STATIC_ONLY_STORAGE_KEY)
    }
  } catch {}
}

export function recordFetchDiagnostic(entry: FetchDiagnosticEntry): void {
  diagnosticsBuffer.push(entry)
  if (diagnosticsBuffer.length > MAX_DIAGNOSTICS_LOG) {
    diagnosticsBuffer.shift()
  }

  // Skip telemetry ping when static Cloudflare Pages hosts without Node backend
  if (
    entry.finalStatus !== 'success' &&
    typeof fetch !== 'undefined' &&
    typeof window !== 'undefined' &&
    !isBackendStaticOnly()
  ) {
    try {
      fetch(resolveApiUrl('/api/telemetry/fetch-log'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
        keepalive: true,
      }).catch(() => {})
    } catch {
      // ignore telemetry network errors
    }
  }
}

export function getFetchDiagnostics(): FetchDiagnosticEntry[] {
  return [...diagnosticsBuffer]
}

export function isTransientNetworkOrServerError(err: any): boolean {
  if (!err) return true
  if (err.isHtmlFallback) return false

  const status = Number(err.status || err.httpStatus || err.code)
  if (!isNaN(status) && status > 0) {
    if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return true
    if (status >= 400 && status < 500) return false
  }

  const msg = String(err.message || err).toLowerCase()
  if (
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid password') ||
    msg.includes('html_spa_fallback') ||
    msg.includes('unexpected token')
  ) {
    return false
  }
  // Timeouts, AbortError, Failed to fetch, network resets, 5xx
  return true
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 6000
): Promise<Response> {
  const targetUrl = resolveApiUrl(url)
  const isApiRequest = targetUrl.includes('/api/')

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(targetUrl, {
      ...init,
      signal: controller ? controller.signal : init.signal,
    })

    const contentType = (res.headers.get('content-type') || '').toLowerCase()

    // CRITICAL STATIC HOSTING GUARD (Netlify 404 HTML & Cloudflare Pages 200 HTML):
    // Static hosts return text/html (HTTP 404 on Netlify, HTTP 200 on Cloudflare Pages) for /api/* paths.
    if (isApiRequest && contentType.includes('text/html') && (res.status === 404 || res.ok)) {
      markBackendStaticOnly()
      const err: any = new Error('HTML_SPA_FALLBACK_ON_API_ROUTE')
      err.status = 404
      err.isHtmlFallback = true
      throw err
    }

    if (!res.ok) {
      const err: any = new Error(`HTTP ${res.status}`)
      err.status = res.status
      throw err
    }

    if (isApiRequest) {
      markBackendAvailable()
    }

    return res
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      const timeoutErr: any = new Error(`Request timeout after ${timeoutMs}ms`)
      timeoutErr.status = 504
      throw timeoutErr
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function fetchApiJson<T = any>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 6000
): Promise<T> {
  const res = await fetchWithTimeout(url, init, timeoutMs)
  const rawText = await res.text()
  const trimmed = rawText.trim()
  if (!trimmed || trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<')) {
    markBackendStaticOnly()
    const err: any = new Error('HTML_SPA_FALLBACK_ON_API_ROUTE')
    err.status = 404
    err.isHtmlFallback = true
    throw err
  }
  return JSON.parse(trimmed) as T
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<{ data: T; retryCount: number; durationMs: number }> {
  const maxRetries = options.maxRetries ?? 3
  const baseDelayMs = options.baseDelayMs ?? 300
  const maxDelayMs = options.maxDelayMs ?? 2500
  const shouldRetry = options.shouldRetry ?? isTransientNetworkOrServerError
  const stage = options.stage || 'unknown'
  const examId = options.examId || null

  const start = Date.now()
  let lastError: any = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const data = await fn(attempt)
      const durationMs = Date.now() - start
      if (attempt > 0) {
        recordFetchDiagnostic({
          timestamp: new Date().toISOString(),
          examId,
          stage,
          statusOrError: `Recovered on attempt ${attempt + 1}`,
          durationMs,
          retryCount: attempt,
          finalStatus: 'recovered_after_retry',
        })
      }
      return { data, retryCount: attempt, durationMs }
    } catch (err: any) {
      lastError = err
      const canRetry = attempt < maxRetries && shouldRetry(err)
      if (!canRetry) {
        const durationMs = Date.now() - start
        if (!err?.isHtmlFallback) {
          recordFetchDiagnostic({
            timestamp: new Date().toISOString(),
            examId,
            stage,
            statusOrError: String(err?.status || err?.code || err?.message || 'Unknown error'),
            durationMs,
            retryCount: attempt,
            finalStatus: 'failed',
          })
        }
        throw err
      }

      // Exponential backoff + small jitter
      const backoff = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
      const jitter = Math.floor(Math.random() * 150)
      await new Promise((r) => setTimeout(r, backoff + jitter))
    }
  }

  throw lastError
}

/**
 * Queries real classroom announcements/homework from Supabase posts table directly,
 * excluding internal system rows (`__%` such as `__SYSTEM_EXAM_SUBMISSIONS__`, `__EXAM_SUB__`, etc.)
 * which otherwise inflate RPC `list_published_posts` to >10 MB.
 */
export async function fetchFilteredPublishedPosts(
  supabaseClient: any,
  options: { includeScheduledFuture?: boolean; serverNowMs?: number } = {}
): Promise<any[]> {
  const { includeScheduledFuture = false, serverNowMs } = options
  const nowMs = serverNowMs ?? Date.now()

  const { data, error } = await supabaseClient
    .from('posts')
    .select('id, title, body, type, attachment_path, publish_at, due_at, created_at')
    .not('title', 'like', '\\_\\_%')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    const err: any = new Error(error.message || 'posts query failed')
    err.code = error.code
    err.status = error.status
    throw err
  }

  const rows = Array.isArray(data) ? data : []
  return rows.filter((p: any) => {
    if (!p) return false
    const title = String(p.title || '')
    if (title.startsWith('__') || p.type === 'exam') return false
    if (!includeScheduledFuture && p.publish_at) {
      const pubMs = new Date(p.publish_at).getTime()
      if (!isNaN(pubMs) && pubMs > nowMs) return false
    }
    return true
  })
}

/**
 * Strips all sensitive answer-key / rubric / explanation fields from an Exam for students,
 * unless results are explicitly released.
 */
export function sanitizeExamForStudent(exam: Exam): Exam {
  if (!exam) return exam
  const resultsReleased = Boolean(
    exam.resultsPublished || exam.results_published || exam.isResultsReleased || (exam as any).resultsReleased
  )
  if (resultsReleased) return exam

  return {
    ...exam,
    questions: (exam.questions || []).map((q: any) => {
      if (!q) return q
      const {
        correctAnswer,
        rubricOrHint,
        correctOptionIndex,
        correctOptionText,
        gradingNotes,
        explanation,
        solution,
        teacherNotes,
        ...safeQ
      } = q
      return safeQ as ExamQuestion
    }),
  }
}

/**
 * Normalizes a raw Supabase `quizzes` row into an Exam object.
 */
export function normalizeQuizRowToExam(row: any): Exam | null {
  if (!row || !row.id) return null
  const questions = Array.isArray(row.questions) ? row.questions : []
  const duration = Number(row.duration_minutes ?? row.durationMinutes ?? 30)
  return {
    id: String(row.id),
    title: row.title || 'آزمون کلاسی',
    subject: row.subject || 'عمومی',
    description: row.description || `آزمون درس ${row.subject || 'عمومی'}`,
    questions,
    durationMinutes: isNaN(duration) ? 30 : duration,
    totalPoints:
      questions.length > 0
        ? questions.reduce((sum: number, q: any) => sum + (Number(q?.points) || 1), 0)
        : 20,
    createdAt: row.created_at || row.createdAt || new Date().toISOString(),
    scheduledStartTime: row.scheduled_start_time || row.scheduledStartTime || row.created_at || new Date().toISOString(),
    published: row.published !== false,
    mode: row.mode || (duration === 0 ? 'assignment' : 'exam'),
    dueDate: row.due_date || row.dueDate,
    isUntimed: Boolean(row.is_untimed || row.isUntimed || duration === 0),
    resultsPublished: Boolean(row.results_published || row.resultsPublished || row.isResultsReleased),
  }
}

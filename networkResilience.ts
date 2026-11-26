import { Exam, ExamQuestion } from '../types/examTypes'
import { getServerNowMs } from '../supabaseClient'

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

export interface ExamRetrievalDiagnostic {
  timestamp: string
  deviceContext: string
  requestSource: string
  rpcName: string
  success: boolean
  errorCode: string | null
  errorMessage: string | null
  totalRecords: number
  publishedExamsCount: number
  assignmentsCount: number
  usedCache: boolean
  retryCount: number
  durationMs: number
}

const MAX_DIAGNOSTICS_LOG = 100
const diagnosticsBuffer: FetchDiagnosticEntry[] = []
const examRetrievalDiagnosticsBuffer: ExamRetrievalDiagnostic[] = []

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

function isKnownStaticOrWorkerHostname(hostname: string): boolean {
  const host = String(hostname || '').trim().toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.run.app')) {
    return false
  }
  return (
    host.endsWith('.workers.dev') ||
    host.endsWith('.netlify.app') ||
    host.endsWith('.pages.dev')
  )
}

function isStaticOrWorkerDeployment(): boolean {
  try {
    const rawBase =
      (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) || ''
    const base = String(rawBase).trim()
    if (base && /^https?:\/\//i.test(base)) {
      const apiHost = new URL(base).hostname
      if (isKnownStaticOrWorkerHostname(apiHost)) {
        return true
      }
    }
  } catch {}
  try {
    if (typeof window !== 'undefined' && window.location?.hostname) {
      if (isKnownStaticOrWorkerHostname(window.location.hostname)) {
        return true
      }
    }
  } catch {}
  return false
}

export function isBackendStaticOnly(): boolean {
  if (typeof window === 'undefined') return true
  if (isStaticOrWorkerDeployment()) return true
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

export function getCompactDeviceContext(): string {
  try {
    if (typeof navigator === 'undefined') return 'server/node'
    const ua = String(navigator.userAgent || '')
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
    const browser = /Edg\//i.test(ua)
      ? 'Edge'
      : /Firefox\//i.test(ua)
      ? 'Firefox'
      : /Chrome\//i.test(ua)
      ? 'Chrome'
      : /Safari\//i.test(ua)
      ? 'Safari'
      : 'Other'
    const online = typeof navigator.onLine === 'boolean' ? (navigator.onLine ? 'online' : 'offline') : 'unknown'
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0
    return `${isMobile ? 'mobile' : 'desktop'}/${browser}/${online}${vw ? `/${vw}px` : ''}`
  } catch {
    return 'unknown'
  }
}

export function sanitizeDiagnosticMessage(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  if (!text) return null
  // Strip any potential bearer tokens, password parameters, or access codes from diagnostic strings
  return text
    .replace(/p_password\s*[:=]\s*[^\s,&}]+/gi, 'p_password=[REDACTED]')
    .replace(/p_access_code\s*[:=]\s*[^\s,&}]+/gi, 'p_access_code=[REDACTED]')
    .replace(/bearer\s+[a-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 240)
}

export function recordExamRetrievalDiagnostic(
  entry: Omit<ExamRetrievalDiagnostic, 'timestamp' | 'deviceContext'> & {
    timestamp?: string
    deviceContext?: string
  }
): ExamRetrievalDiagnostic {
  const safeEntry: ExamRetrievalDiagnostic = {
    timestamp: entry.timestamp || new Date().toISOString(),
    deviceContext: entry.deviceContext || getCompactDeviceContext(),
    requestSource: entry.requestSource || 'unknown',
    rpcName: entry.rpcName || 'unknown',
    success: Boolean(entry.success),
    errorCode: entry.errorCode ? String(entry.errorCode).slice(0, 64) : null,
    errorMessage: sanitizeDiagnosticMessage(entry.errorMessage),
    totalRecords: Number.isFinite(entry.totalRecords) ? entry.totalRecords : 0,
    publishedExamsCount: Number.isFinite(entry.publishedExamsCount) ? entry.publishedExamsCount : 0,
    assignmentsCount: Number.isFinite(entry.assignmentsCount) ? entry.assignmentsCount : 0,
    usedCache: Boolean(entry.usedCache),
    retryCount: Number.isFinite(entry.retryCount) ? entry.retryCount : 0,
    durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0,
  }

  examRetrievalDiagnosticsBuffer.push(safeEntry)
  if (examRetrievalDiagnosticsBuffer.length > MAX_DIAGNOSTICS_LOG) {
    examRetrievalDiagnosticsBuffer.shift()
  }

  if (typeof console !== 'undefined') {
    if (safeEntry.success) {
      console.info('[ExamSyncDiag]', safeEntry)
    } else {
      console.warn('[ExamSyncDiag]', safeEntry)
    }
  }

  return safeEntry
}

export function getExamRetrievalDiagnostics(): ExamRetrievalDiagnostic[] {
  return [...examRetrievalDiagnosticsBuffer]
}

export async function withPromiseTimeout<T>(
  promise: PromiseLike<T> | Promise<T>,
  timeoutMs = 8000,
  timeoutMessage = 'زمان ارتباط با سرور به پایان رسید'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err: any = new Error(timeoutMessage)
          err.status = 504
          err.code = 'TIMEOUT'
          reject(err)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isCloudflareWorkerHandledApiPath(url: string): boolean {
  try {
    const pathname = /^https?:\/\//i.test(url) ? new URL(url).pathname : url.split('?')[0]
    return pathname === '/api/health' || pathname.startsWith('/api/ai/')
  } catch {
    return url.includes('/api/health') || url.includes('/api/ai/')
  }
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

    // CRITICAL STATIC HOSTING GUARD (Netlify 404 HTML, Cloudflare Pages 200 HTML, or Worker 404 JSON):
    // Static/Worker hosts do not serve legacy Express /api/* routes.
    if (isApiRequest && contentType.includes('text/html') && (res.status === 404 || res.ok)) {
      markBackendStaticOnly()
      const err: any = new Error('HTML_SPA_FALLBACK_ON_API_ROUTE')
      err.status = 404
      err.isHtmlFallback = true
      throw err
    }

    if (isApiRequest && res.status === 404 && !isCloudflareWorkerHandledApiPath(targetUrl)) {
      markBackendStaticOnly()
      const err: any = new Error('API_ROUTE_NOT_SUPPORTED')
      err.status = 404
      err.isHtmlFallback = true
      throw err
    }

    if (!res.ok) {
      const err: any = new Error(`HTTP ${res.status}`)
      err.status = res.status
      throw err
    }

    // CRITICAL: Only mark Express backend available if a non-Worker Express API route succeeded.
    // Cloudflare Worker handles /api/health and /api/ai/* even when Netlify serves static SPA HTML for other /api/* paths.
    if (isApiRequest && !isCloudflareWorkerHandledApiPath(targetUrl)) {
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
  // Allow 2 minutes of drift without prematurely exposing genuinely future-scheduled posts
  const CLOCK_SKEW_GRACE_MS = 2 * 60 * 1000

  let rows: any[] = []
  const { data, error } = await supabaseClient
    .from('posts')
    .select('id, title, body, type, attachment_path, publish_at, due_at, created_at')
    .not('title', 'like', '\\_\\_%')
    .order('created_at', { ascending: false })
    .limit(200)

  const isNetworkFailure = Boolean(error && !error.code && /fetch|network|timeout|abort/i.test(String(error.message || '')))
  if (!error && Array.isArray(data)) {
    rows = data
  } else if (isNetworkFailure) {
    // Never fall back to the multi-MB list_published_posts RPC on a network failure — just report it
    const err: any = new Error(error?.message || 'posts query failed')
    err.status = 503
    throw err
  } else {
    // Resilient fallback to list_published_posts RPC if direct table select fails
    const rpcRes = await supabaseClient.rpc('list_published_posts')
    if (!rpcRes?.error && Array.isArray(rpcRes?.data)) {
      rows = rpcRes.data
    } else {
      const activeErr = error || rpcRes?.error
      const err: any = new Error(activeErr?.message || 'posts query failed')
      err.code = activeErr?.code
      err.status = activeErr?.status
      throw err
    }
  }

  // Evaluate "now" AFTER the response arrived so the server clock (HTTP Date header) is already known
  const nowMs = serverNowMs ?? getServerNowMs()
  return rows.filter((p: any) => {
    if (!p) return false
    const title = String(p.title || '')
    if (title.startsWith('__') || title.includes('__SYSTEM_') || title.includes('__EXAM_SUB__') || p.type === 'exam') {
      return false
    }
    if (!includeScheduledFuture && p.publish_at) {
      const pubMs = new Date(p.publish_at).getTime()
      if (!isNaN(pubMs) && pubMs > nowMs + CLOCK_SKEW_GRACE_MS) return false
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
 * Safely parses an ISO/date string to UTC epoch milliseconds.
 * Returns null if the value is missing or unparseable (never NaN).
 */
export function parseExamTimestampMs(value?: string | null): number | null {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Normalizes any timestamp input into a valid ISO-8601 UTC string, or returns fallback.
 */
function normalizeIsoTimestamp(value?: string | null, fallback?: string): string | undefined {
  const ms = parseExamTimestampMs(value)
  if (ms !== null) {
    return new Date(ms).toISOString()
  }
  return fallback
}

/**
 * Determines whether a published exam is scheduled to start in the future.
 * Online assignments without an explicit future start or invalid timestamps are treated as started.
 */
export function isExamScheduledForFuture(exam: Exam, nowMs: number = Date.now()): boolean {
  if (!exam || exam.published === false) return false
  const startMs = parseExamTimestampMs(exam.scheduledStartTime)
  if (startMs === null) return false
  return startMs > nowMs
}

/**
 * Determines whether an exam/assignment has passed its due date (using safe UTC parsing).
 */
export function isExamPastDue(exam: Exam, nowMs: number = Date.now()): boolean {
  if (!exam) return false
  const dueMs = parseExamTimestampMs(exam.dueDate)
  if (dueMs === null) return false
  return dueMs < nowMs
}

export type StudentExamScheduleState = 'unpublished' | 'scheduled_future' | 'active' | 'expired'

export function classifyExamForStudent(
  exam: Exam,
  nowMs: number = Date.now()
): {
  state: StudentExamScheduleState
  isPublished: boolean
  isAssignment: boolean
  isStarted: boolean
  isPastDue: boolean
  startMs: number | null
  dueMs: number | null
} {
  const isPublished = Boolean(exam && exam.published !== false)
  const isAssignment = Boolean(
    exam &&
      (exam.mode === 'assignment' ||
        exam.isUntimed ||
        !exam.durationMinutes ||
        Number(exam.durationMinutes) <= 0)
  )
  const startMs = parseExamTimestampMs(exam?.scheduledStartTime)
  const dueMs = parseExamTimestampMs(exam?.dueDate)
  const isStarted = startMs === null ? true : startMs <= nowMs
  const isPastDue = dueMs !== null ? dueMs < nowMs : false

  let state: StudentExamScheduleState = 'active'
  if (!isPublished) {
    state = 'unpublished'
  } else if (!isStarted) {
    state = 'scheduled_future'
  } else if (isPastDue) {
    state = 'expired'
  }

  return { state, isPublished, isAssignment, isStarted, isPastDue, startMs, dueMs }
}

/**
 * Normalizes a raw Supabase `quizzes` row into an Exam object.
 */
export function normalizeQuizRowToExam(row: any): Exam | null {
  if (!row || !row.id) return null
  const questions = Array.isArray(row.questions) ? row.questions : []
  const duration = Number(row.duration_minutes ?? row.durationMinutes ?? 30)
  const safeDuration = Number.isFinite(duration) && duration >= 0 ? duration : 30
  const isUntimed = Boolean(
    row.is_untimed ?? row.isUntimed ?? (row.mode === 'assignment' || safeDuration === 0)
  )
  const mode: 'exam' | 'assignment' =
    row.mode === 'assignment' || row.mode === 'exam'
      ? row.mode
      : isUntimed
      ? 'assignment'
      : 'exam'
  const explicitTotal = Number(row.total_points ?? row.totalPoints)
  const computedTotal =
    Number.isFinite(explicitTotal) && explicitTotal > 0
      ? explicitTotal
      : questions.length > 0
      ? questions.reduce((sum: number, q: any) => sum + (Number(q?.points) || 1), 0)
      : 20
  const resultsPublished = Boolean(
    row.results_published ?? row.resultsPublished ?? row.isResultsReleased
  )

  const fallbackCreatedAt = new Date().toISOString()
  const createdAt =
    normalizeIsoTimestamp(row.created_at || row.createdAt, fallbackCreatedAt) || fallbackCreatedAt
  const scheduledStartTime =
    normalizeIsoTimestamp(
      row.scheduled_start || row.scheduled_start_time || row.scheduledStartTime,
      createdAt
    ) || createdAt
  const dueDate = normalizeIsoTimestamp(row.due_at || row.due_date || row.dueDate)

  return {
    id: String(row.id),
    title: row.title || 'آزمون کلاسی',
    subject: row.subject || 'عمومی',
    description: row.description || `آزمون درس ${row.subject || 'عمومی'}`,
    questions,
    durationMinutes: safeDuration,
    totalPoints: computedTotal,
    createdAt,
    scheduledStartTime,
    published: row.published !== false,
    mode,
    dueDate,
    isUntimed,
    resultsPublished,
    results_published: resultsPublished,
  }
}

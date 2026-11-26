import { createClient } from '@supabase/supabase-js'

/**
 * Resilient Supabase client for Iranian networks.
 *
 * Problem this solves: some students' ISPs intermittently block or throttle one of the hosts
 * (e.g. *.workers.dev or *.supabase.co). Previously every request went to ONE fixed host, so for
 * those students homework/exams/grades "sometimes" never arrived.
 *
 * Now every REST/RPC/Storage request is routed through a list of equivalent endpoints and
 * automatically fails over to the next one on network errors, timeouts or HTML error pages:
 *   1. Same origin `/sb` (the site the student already opened — if the page loaded, this host is reachable).
 *      Works on the Cloudflare Worker (incl. a custom domain routed through it) and on Netlify via the
 *      `/sb/*` proxy rule in netlify.toml. Used only after a quick verification probe succeeds.
 *   2. The Cloudflare Worker proxy (VITE_API_BASE_URL + /sb)
 *   3. Supabase directly
 *
 * It also measures the server clock from the HTTP `Date` header so that devices with a wrong clock
 * still see newly published homework/exams immediately (see getServerNowMs()).
 */

const DIRECT_SUPABASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL
    ? String(import.meta.env.VITE_SUPABASE_URL).trim().replace(/\/+$/, '')
    : '') || 'https://ephgqrnbpxvxlzloflhy.supabase.co'

const supabaseAnonKey =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY) ||
  'sb_publishable_bI5v4Hzokb0A4JWJDzuz1A_4B3lIUX_'

const envApiBaseUrl =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL
    ? String(import.meta.env.VITE_API_BASE_URL).trim().replace(/\/+$/, '')
    : ''

const hasWindow = typeof window !== 'undefined' && Boolean(window.location?.origin)
const currentOrigin = hasWindow ? window.location.origin.replace(/\/+$/, '') : ''
const currentHost = hasWindow ? String(window.location.hostname || '').toLowerCase() : ''
const isLocalDev =
  currentHost === 'localhost' || currentHost === '127.0.0.1' || currentHost === '::1' || currentHost.endsWith('.run.app')

const runtimeIsWorkerHost = currentHost.endsWith('.workers.dev')
const workerProxyBase = envApiBaseUrl ? `${envApiBaseUrl}/sb` : runtimeIsWorkerHost ? `${currentOrigin}/sb` : ''
const sameOriginProxyBase = hasWindow && !isLocalDev ? `${currentOrigin}/sb` : ''

const SAME_ORIGIN_OK_KEY = 'sb_same_origin_proxy_ok_v1'
const SAME_ORIGIN_WS_KEY = 'sb_same_origin_ws_ok_v1'
const PREFERRED_BASE_KEY = 'sb_preferred_base_v1'
const PREFERRED_BASE_TTL_MS = 30 * 60 * 1000

function safeStorageGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function safeStorageSet(key: string, value: string) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {}
}

function safeStorageRemove(key: string) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch {}
}

// Same-origin proxy is trusted immediately on the worker host itself; elsewhere only after a probe.
let sameOriginVerified = (() => {
  if (!sameOriginProxyBase) return false
  if (sameOriginProxyBase === workerProxyBase) return true
  const raw = safeStorageGet(SAME_ORIGIN_OK_KEY)
  if (!raw) return false
  try {
    const parsed = JSON.parse(raw)
    return parsed?.origin === currentOrigin && Date.now() - Number(parsed?.at || 0) < 24 * 60 * 60 * 1000
  } catch {
    return false
  }
})()

/** Base URL given to createClient. REST calls are rewritten by smartFetch; realtime WebSocket uses it directly. */
const CLIENT_BASE_URL = (() => {
  if (sameOriginProxyBase && (runtimeIsWorkerHost || safeStorageGet(SAME_ORIGIN_WS_KEY) === currentOrigin)) {
    return sameOriginProxyBase
  }
  return workerProxyBase || DIRECT_SUPABASE_URL
})()

function uniqueList(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

function getCandidateBases(): string[] {
  const ordered = uniqueList([
    sameOriginVerified ? sameOriginProxyBase : '',
    workerProxyBase,
    DIRECT_SUPABASE_URL,
  ])
  const rawPreferred = safeStorageGet(PREFERRED_BASE_KEY)
  if (rawPreferred) {
    try {
      const parsed = JSON.parse(rawPreferred)
      if (parsed?.base && ordered.includes(parsed.base) && Date.now() - Number(parsed.at || 0) < PREFERRED_BASE_TTL_MS) {
        return uniqueList([parsed.base, ...ordered])
      }
    } catch {}
  }
  return ordered
}

let activeBase = getCandidateBases()[0] || DIRECT_SUPABASE_URL

// Endpoints that just failed are skipped for a while, so the NEXT request (or an outer retry)
// starts directly on a working endpoint instead of waiting for the same stalled host again.
const BAD_BASE_COOLDOWN_MS = 2 * 60 * 1000
const badBaseUntil = new Map<string, number>()

function markBaseBad(base: string) {
  badBaseUntil.set(base, Date.now() + BAD_BASE_COOLDOWN_MS)
}

function orderByHealth(bases: string[]): string[] {
  const now = Date.now()
  const healthy = bases.filter((b) => (badBaseUntil.get(b) || 0) <= now)
  const cooling = bases.filter((b) => (badBaseUntil.get(b) || 0) > now)
  return [...healthy, ...cooling]
}

function rememberGoodBase(base: string) {
  activeBase = base
  const defaultFirst = uniqueList([sameOriginVerified ? sameOriginProxyBase : '', workerProxyBase, DIRECT_SUPABASE_URL])[0]
  if (base === defaultFirst) {
    safeStorageRemove(PREFERRED_BASE_KEY)
  } else {
    safeStorageSet(PREFERRED_BASE_KEY, JSON.stringify({ base, at: Date.now() }))
  }
}

/** The REST base currently known to work (for raw fetch calls such as keepalive saves). */
export function getActiveSupabaseBase(): string {
  return activeBase
}

export const SUPABASE_ANON_KEY = String(supabaseAnonKey)

// ---------------------------------------------------------------------------
// Server clock (from HTTP Date header) so wrong device clocks never hide content
// ---------------------------------------------------------------------------
let serverOffsetMs = 0
let serverOffsetKnown = false

function recordServerDate(res: Response) {
  try {
    const raw = res.headers.get('date')
    if (!raw) return
    const serverMs = Date.parse(raw)
    if (!Number.isFinite(serverMs)) return
    const offset = serverMs - Date.now()
    // Date header has 1s resolution; ignore sub-2s jitter
    if (!serverOffsetKnown || Math.abs(offset - serverOffsetMs) > 2000) {
      serverOffsetMs = offset
      serverOffsetKnown = true
    }
  } catch {}
}

/** Milliseconds to add to Date.now() to get server time (0 when unknown). */
export function getServerTimeOffsetMs(): number {
  return serverOffsetKnown ? serverOffsetMs : 0
}

export function getServerNowMs(): number {
  return Date.now() + getServerTimeOffsetMs()
}

export function setServerTimeOffsetMs(offsetMs: number) {
  if (Number.isFinite(offsetMs)) {
    serverOffsetMs = offsetMs
    serverOffsetKnown = true
  }
}

// ---------------------------------------------------------------------------
// Failover fetch
// ---------------------------------------------------------------------------
const READ_RPC_PATTERN =
  /\/rest\/v1\/rpc\/(get_server_time|list_|teacher_list_|student_list_|student_login|verify_teacher|student_get_exam_review|teacher_poll_fingerprint|student_poll_fingerprint)/

// Upserts/updates keyed by id: re-sending them to another endpoint after a timeout cannot duplicate data
const IDEMPOTENT_RPC_PATTERN =
  /\/rest\/v1\/rpc\/(student_upsert_|teacher_upsert_|teacher_update_grade|teacher_mark_attendance|teacher_delete_)/

function isRetrySafeOnTimeout(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return true
  return READ_RPC_PATTERN.test(path) || IDEMPOTENT_RPC_PATTERN.test(path)
}

function timeoutForRequest(method: string, path: string): number {
  if (path.startsWith('/storage/')) return 120000
  if (method === 'GET' || method === 'HEAD') return 12000
  if (READ_RPC_PATTERN.test(path)) return 15000
  return 30000
}

function isHtmlResponse(res: Response): boolean {
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  return ct.includes('text/html')
}

function isGatewayFailure(res: Response): boolean {
  return res.status === 502 || res.status === 503 || res.status === 504 || (res.status >= 520 && res.status <= 530)
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url
}

async function attemptFetch(url: string, init: RequestInit, timeoutMs: number, callerSignal?: AbortSignal | null) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onCallerAbort = () => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  }
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    return { res, timedOut: false }
  } catch (err) {
    if (callerSignal?.aborted) throw err
    return { res: null as Response | null, timedOut, error: err }
  } finally {
    clearTimeout(timer)
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort)
  }
}

const smartFetch: typeof fetch = async (input, init = {}) => {
  const rawUrl = resolveRequestUrl(input)
  if (!rawUrl.startsWith(CLIENT_BASE_URL)) {
    return fetch(input as any, init)
  }

  const path = rawUrl.slice(CLIENT_BASE_URL.length)
  const method = String(init.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase()
  const callerSignal = init.signal || (input instanceof Request ? input.signal : undefined)
  const timeoutMs = timeoutForRequest(method, path)
  const candidates = orderByHealth(uniqueList([activeBase, ...getCandidateBases()]))

  let lastError: any = null
  let lastResponse: Response | null = null

  for (let i = 0; i < candidates.length; i++) {
    const base = candidates[i]
    const { res, timedOut, error } = await attemptFetch(base + path, init, timeoutMs, callerSignal)

    if (res) {
      if (isHtmlResponse(res) || isGatewayFailure(res)) {
        // Proxy/edge error page or SPA fallback — try the next equivalent endpoint
        lastResponse = res
        markBaseBad(base)
        if (base === sameOriginProxyBase && isHtmlResponse(res)) {
          sameOriginVerified = false
          safeStorageRemove(SAME_ORIGIN_OK_KEY)
        }
        continue
      }
      recordServerDate(res)
      badBaseUntil.delete(base)
      if (base !== activeBase) rememberGoodBase(base)
      return res
    }

    lastError = error
    markBaseBad(base)
    // A write that timed out may already have been applied — do not resend it elsewhere
    if (timedOut && !isRetrySafeOnTimeout(method, path)) break
  }

  if (lastResponse) return lastResponse
  const err: any = lastError instanceof Error ? lastError : new TypeError('Failed to fetch')
  if (err?.name === 'AbortError') {
    const timeoutErr: any = new TypeError(`Network timeout after ${Math.round(timeoutMs / 1000)}s`)
    throw timeoutErr
  }
  throw err
}

export const supabase = createClient(CLIENT_BASE_URL, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  global: {
    fetch: smartFetch,
  },
})

// ---------------------------------------------------------------------------
// Background verification of the same-origin proxy (so students use the host that already loaded)
// ---------------------------------------------------------------------------
async function verifySameOriginProxy() {
  if (!sameOriginProxyBase || sameOriginVerified) return
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    // GET RPC with explicit query: verifies the proxy reaches Supabase AND forwards query strings
    const res = await fetch(
      `${sameOriginProxyBase}/rest/v1/rpc/student_list_published_quizzes?select=id&limit=1`,
      {
        method: 'GET',
        headers: { apikey: String(supabaseAnonKey), Authorization: `Bearer ${supabaseAnonKey}` },
        signal: controller.signal,
      }
    )
    clearTimeout(timer)
    if (!res.ok || isHtmlResponse(res)) return
    const json = await res.json().catch(() => null)
    const valid =
      Array.isArray(json) &&
      json.length <= 1 &&
      json.every((row: any) => row && typeof row === 'object' && Object.keys(row).length === 1 && 'id' in row)
    if (!valid) return
    recordServerDate(res)
    sameOriginVerified = true
    safeStorageSet(SAME_ORIGIN_OK_KEY, JSON.stringify({ origin: currentOrigin, at: Date.now() }))
    activeBase = sameOriginProxyBase
    safeStorageRemove(PREFERRED_BASE_KEY)
  } catch {}
}

async function detectSameOriginWorker() {
  if (!hasWindow || isLocalDev || runtimeIsWorkerHost) return
  try {
    const res = await fetch(`${currentOrigin}/api/health`, { cache: 'no-store' })
    if (!res.ok || isHtmlResponse(res)) {
      safeStorageRemove(SAME_ORIGIN_WS_KEY)
      return
    }
    const json = await res.json().catch(() => null)
    if (json?.runtime === 'cloudflare-worker') {
      // This custom domain is served by the Worker → realtime WebSocket can use the same host next load
      safeStorageSet(SAME_ORIGIN_WS_KEY, currentOrigin)
    } else {
      safeStorageRemove(SAME_ORIGIN_WS_KEY)
    }
  } catch {}
}

/**
 * Fallback clock sync: when the HTTP Date header is not readable (cross-origin without exposure),
 * ask the database for its time (RPC get_server_time from migration_exam_integrity.sql).
 */
let clockRpcMissing = false
async function syncServerClockViaRpc() {
  if (clockRpcMissing) return
  try {
    const t0 = Date.now()
    const { data, error } = await supabase.rpc('get_server_time')
    const t1 = Date.now()
    if (error) {
      const code = String((error as any)?.code || '')
      if (code === 'PGRST202' || code === '42883') clockRpcMissing = true
      return
    }
    const serverMs = Date.parse(String(data))
    if (!Number.isFinite(serverMs) || t1 - t0 > 8000) return
    setServerTimeOffsetMs(serverMs - (t0 + t1) / 2)
  } catch {}
}

if (hasWindow) {
  setTimeout(() => {
    void verifySameOriginProxy()
    void detectSameOriginWorker()
  }, 300)
  // Measure the server clock early and refresh it every 10 minutes
  setTimeout(() => void syncServerClockViaRpc(), 1500)
  setInterval(() => void syncServerClockViaRpc(), 10 * 60 * 1000)
}

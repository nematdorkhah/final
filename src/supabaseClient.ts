import { createClient } from '@supabase/supabase-js'

const apiBaseUrl =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL
    ? String(import.meta.env.VITE_API_BASE_URL).trim().replace(/\/+$/, '')
    : ''

const fallbackSupabaseUrl =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL
    ? String(import.meta.env.VITE_SUPABASE_URL).trim().replace(/\/+$/, '')
    : '') || 'https://ephgqrnbpxvxlzloflhy.supabase.co'

const supabaseUrl = apiBaseUrl ? `${apiBaseUrl}/sb` : fallbackSupabaseUrl

const supabaseAnonKey =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY) ||
  'sb_publishable_bI5v4Hzokb0A4JWJDzuz1A_4B3lIUX_'

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
})

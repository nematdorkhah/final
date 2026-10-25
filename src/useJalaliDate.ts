export function todayISO(): string {
  try {
    return new Date().toISOString().split('T')[0]
  } catch {
    const d = new Date()
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }
}

export function getJalaliDateLabel(date: Date = new Date()): { weekday: string; jalali: string } {
  try {
    const weekdayFormatter = new Intl.DateTimeFormat('fa-IR', { weekday: 'long' })
    const dateFormatter = new Intl.DateTimeFormat('fa-IR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
    return {
      weekday: weekdayFormatter.format(date),
      jalali: dateFormatter.format(date),
    }
  } catch (e) {
    console.warn('Intl fa-IR formatter failed, falling back:', e)
    return {
      weekday: 'امروز',
      jalali: date.toLocaleDateString(),
    }
  }
}

export function sanitizeFileName(name: string): string {
  if (!name) return `file_${Date.now()}`
  
  // Extract file extension cleanly
  const lastDot = name.lastIndexOf('.')
  const ext = lastDot > 0 ? name.slice(lastDot).toLowerCase().replace(/[^a-z0-9.]/g, '') : ''
  const base = lastDot > 0 ? name.slice(0, lastDot) : name

  // ASCII-safe sanitization for S3 / Supabase Storage object keys
  const cleanBase = base
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')

  // If filename was non-ASCII (e.g. Persian/Arabic like "کتاب ریاضی ششم"),
  // provide a safe descriptive slug with timestamp/random identifier
  if (!cleanBase) {
    const randomSuffix = Math.random().toString(36).substring(2, 8)
    return `doc_${randomSuffix}${ext || '.bin'}`
  }

  return `${cleanBase.slice(0, 50)}${ext}`
}

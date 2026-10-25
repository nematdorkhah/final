export function extractLastName(fullName: string | null | undefined): string {
  if (!fullName) return ''
  const parts = fullName.trim().split(/\s+/)
  if (parts.length <= 1) return parts[0] || ''
  // Return everything after the first name
  return parts.slice(1).join(' ')
}

export function normalizePersianText(str: string | null | undefined): string {
  if (!str) return ''
  return String(str)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u200C/g, ' ')
    .replace(/[يى]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ة]/g, 'ه')
    .replace(/[\u064B-\u065F]/g, '')
    .toLowerCase()
    .trim()
}

export function sortByLastName<T>(
  list: T[],
  nameKey: keyof T | string = 'full_name'
): T[] {
  if (!Array.isArray(list)) return []
  return [...list].sort((a: any, b: any) => {
    const nameA = String(a?.[nameKey] || a?.name || a?.fullName || '')
    const nameB = String(b?.[nameKey] || b?.name || b?.fullName || '')
    const lastA = extractLastName(nameA)
    const lastB = extractLastName(nameB)
    const cmp = lastA.localeCompare(lastB, 'fa')
    if (cmp !== 0) return cmp
    return nameA.localeCompare(nameB, 'fa')
  })
}

export function isItemExpiredForStudent(
  item: {
    due_at?: string | null
    due_date?: string | null
    dueDate?: string | null
    deadline?: string | null
    created_at?: string | null
    createdAt?: string | null
    isExpired?: boolean
    [key: string]: any
  } | null | undefined,
  daysLimit?: number
): boolean {
  if (!item) return false
  if (item.isExpired) return true

  const now = Date.now()

  // 1. Check explicit due date/deadline if present
  const dueStr = item.due_at || item.due_date || item.dueDate || item.deadline
  if (dueStr) {
    try {
      const dueTime = new Date(dueStr).getTime()
      if (!isNaN(dueTime) && dueTime < now) {
        return true
      }
    } catch {}
  }

  // 2. Check days limit from creation if specified
  if (daysLimit && daysLimit > 0) {
    const createdStr = item.created_at || item.createdAt
    if (createdStr) {
      try {
        const createdTime = new Date(createdStr).getTime()
        if (!isNaN(createdTime)) {
          const maxAgeMs = daysLimit * 24 * 60 * 60 * 1000
          if (now - createdTime > maxAgeMs) {
            return true
          }
        }
      } catch {}
    }
  }

  return false
}

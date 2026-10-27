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
  const graceMs = (daysLimit && daysLimit > 0 ? daysLimit : 0) * 24 * 60 * 60 * 1000

  // 1. Check explicit due date/deadline if present
  const dueStr = item.due_at || item.due_date || item.dueDate || item.deadline
  if (dueStr) {
    try {
      const dueTime = new Date(dueStr).getTime()
      if (!isNaN(dueTime)) {
        // If daysLimit is specified, item remains visible for daysLimit days after due date/deadline
        if (now > dueTime + graceMs) {
          return true
        }
        return false
      }
    } catch {}
  }

  // 2. Check days limit from creation if specified and no due date
  if (daysLimit && daysLimit > 0) {
    const createdStr = item.created_at || item.createdAt
    if (createdStr) {
      try {
        const createdTime = new Date(createdStr).getTime()
        if (!isNaN(createdTime)) {
          if (now - createdTime > graceMs) {
            return true
          }
        }
      } catch {}
    }
  }

  return false
}


export interface SkillGroup {
  subject: string
  avg: number
  skills: { skill: string; avg: number; color?: string }[]
}

export function groupSkillMastery(grades: any[]): SkillGroup[] {
  if (!Array.isArray(grades) || grades.length === 0) return []

  const subjectMap = new Map<string, { totalScaled: number; count: number; skillMap: Map<string, { totalScaled: number; count: number }> }>()

  for (const g of grades) {
    const rawScore = Number(g.score) || 0
    const rawMax = Number(g.max_score) || 20
    const scaledScore = rawMax > 0 ? (rawScore / rawMax) * 20 : rawScore
    const subject = (g.subject || 'عمومی').trim()
    const skill = (g.skill || subject).trim()

    if (!subjectMap.has(subject)) {
      subjectMap.set(subject, { totalScaled: 0, count: 0, skillMap: new Map() })
    }
    const subEntry = subjectMap.get(subject)!
    subEntry.totalScaled += scaledScore
    subEntry.count += 1

    if (!subEntry.skillMap.has(skill)) {
      subEntry.skillMap.set(skill, { totalScaled: 0, count: 0 })
    }
    const skillEntry = subEntry.skillMap.get(skill)!
    skillEntry.totalScaled += scaledScore
    skillEntry.count += 1
  }

  const result: SkillGroup[] = []
  for (const [subject, data] of subjectMap.entries()) {
    const avg = data.count > 0 ? Math.round((data.totalScaled / data.count) * 10) / 10 : 0
    const skills: { skill: string; avg: number; color?: string }[] = []

    for (const [skillName, sData] of data.skillMap.entries()) {
      const sAvg = sData.count > 0 ? Math.round((sData.totalScaled / sData.count) * 10) / 10 : 0
      const color = sAvg >= 17 ? '🟢' : sAvg >= 12 ? '🟡' : '🔴'
      skills.push({ skill: skillName, avg: sAvg, color })
    }

    result.push({ subject, avg, skills })
  }

  return result.sort((a, b) => b.avg - a.avg)
}

export function computeStreak(homeworkPosts: any[], submissions: any[]): number {
  if (!Array.isArray(homeworkPosts) || !Array.isArray(submissions) || homeworkPosts.length === 0) {
    return 0
  }

  const subPostIds = new Set(submissions.map((s) => s.post_id || s.postId))
  const sortedPosts = [...homeworkPosts].sort((a, b) => {
    const timeA = new Date(a.created_at || a.due_at || 0).getTime()
    const timeB = new Date(b.created_at || b.due_at || 0).getTime()
    return timeB - timeA
  })

  let streak = 0
  for (const p of sortedPosts) {
    if (subPostIds.has(p.id)) {
      streak++
    } else {
      break
    }
  }

  return streak
}

export function computeBadges(streak: number, grades: any[], attendanceRows: any[]): string[] {
  const badges: string[] = []

  if (streak >= 5) {
    badges.push('🔥 زنجیره ۵ تکلیف')
  } else if (streak >= 3) {
    badges.push('🔥 زنجیره ۳ تکلیف')
  } else if (streak >= 1) {
    badges.push('✨ تکلیف فعال')
  }

  if (Array.isArray(grades) && grades.length > 0) {
    const total = grades.reduce((acc, g) => {
      const max = Number(g.max_score) || 20
      const s = Number(g.score) || 0
      return acc + (max > 0 ? (s / max) * 20 : s)
    }, 0)
    const gpa = total / grades.length
    if (gpa >= 18.5) {
      badges.push('🏆 شاگرد اول')
    } else if (gpa >= 17) {
      badges.push('⭐ دانش‌آموز ممتاز')
    } else if (grades.length >= 5) {
      badges.push('📝 تلاش مستمر')
    }
  }

  if (Array.isArray(attendanceRows) && attendanceRows.length >= 5) {
    const present = attendanceRows.filter((a) => a.status === 'present').length
    const rate = Math.round((present / attendanceRows.length) * 100)
    if (rate >= 95) {
      badges.push('🎯 حضور منظم')
    }
  }

  return badges
}

export function getHomeworkStatus(post: any, submission: any): { label: string; color: string; isSubmitted: boolean; isLate: boolean } {
  if (submission) {
    const subTime = new Date(submission.submitted_at || submission.created_at || Date.now()).getTime()
    const dueTime = post?.due_at ? new Date(post.due_at).getTime() : NaN

    if (!isNaN(dueTime) && subTime > dueTime + 60000) {
      return { label: 'تحویل با تأخیر', color: '🟡', isSubmitted: true, isLate: true }
    }
    return { label: 'ارسال شده', color: '🟢', isSubmitted: true, isLate: false }
  }

  const dueTime = post?.due_at ? new Date(post.due_at).getTime() : NaN
  if (!isNaN(dueTime) && Date.now() > dueTime) {
    return { label: 'مهلت تمام شد', color: '🔴', isSubmitted: false, isLate: true }
  }

  return { label: 'در انتظار ارسال', color: '⚪', isSubmitted: false, isLate: false }
}

export function weakestSubjects(grades: any[], limit: number = 3): { subject: string; avg: number; count: number }[] {
  if (!Array.isArray(grades) || grades.length === 0) return []

  const subjectMap = new Map<string, { totalScaled: number; count: number }>()

  for (const g of grades) {
    const rawScore = Number(g.score) || 0
    const rawMax = Number(g.max_score) || 20
    const scaled = rawMax > 0 ? (rawScore / rawMax) * 20 : rawScore
    const subject = (g.subject || 'عمومی').trim()

    if (!subjectMap.has(subject)) {
      subjectMap.set(subject, { totalScaled: 0, count: 0 })
    }
    const entry = subjectMap.get(subject)!
    entry.totalScaled += scaled
    entry.count += 1
  }

  const list: { subject: string; avg: number; count: number }[] = []
  for (const [subject, data] of subjectMap.entries()) {
    const avg = data.count > 0 ? Math.round((data.totalScaled / data.count) * 10) / 10 : 0
    list.push({ subject, avg, count: data.count })
  }

  return list.sort((a, b) => a.avg - b.avg).slice(0, limit)
}

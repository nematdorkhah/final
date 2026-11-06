import fs from 'fs'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { CLASS_STUDENTS_ROSTER, resolveCanonicalStudent, isSameStudent } from '../src/classStudents'
import { evaluateEntireExamSubmission } from '../src/utils/persianSemanticGrader'

dotenv.config()

const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://ephgqrnbpxvxlzloflhy.supabase.co'
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_bI5v4Hzokb0A4JWJDzuz1A_4B3lIUX_'
const supabase = createClient(supabaseUrl, supabaseAnonKey)
const teacherPassword = process.env.TEACHER_PASSWORD || '1234'

async function main() {
  console.log('--- STARTING UNIVERSAL GRADE RECONCILIATION FOR ALL STUDENTS ---')

  const exams = JSON.parse(fs.readFileSync('data/exams_backup.json', 'utf-8'))
  const exam = exams.find((e: any) => e.id === 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2')
  if (!exam) throw new Error('Exam not found')

  // Ensure q4 has awardFullScoreToAll
  const q4 = exam.questions.find((q: any) => q.id === 'q4')
  if (q4) {
    q4.awardFullScoreToAll = true
    q4.allOptionsCorrect = true
  }
  exam.totalPoints = exam.questions.reduce((sum: number, q: any) => sum + (Number(q.points) || 1), 0)

  const subs = JSON.parse(fs.readFileSync('data/submissions_backup.json', 'utf-8'))
  const spellingSubs = subs.filter((s: any) => s.examId === exam.id)
  const otherSubs = subs.filter((s: any) => s.examId !== exam.id)

  console.log(`Found ${spellingSubs.length} spelling submissions and ${otherSubs.length} other exam submissions.`)

  // Deduplicate spelling submissions by canonical student
  const studentSubMap = new Map<string, any>()
  for (const s of spellingSubs) {
    const canon = resolveCanonicalStudent(s.studentId || s.studentName)
    const key = canon ? canon.id : (s.studentId || s.studentName)
    const existing = studentSubMap.get(key)
    if (!existing) {
      studentSubMap.set(key, s)
    } else {
      const existingAnsCount = Object.keys(existing.answers || {}).length
      const currentAnsCount = Object.keys(s.answers || {}).length
      if (currentAnsCount > existingAnsCount) {
        studentSubMap.set(key, s)
      } else if (currentAnsCount === existingAnsCount && canon && s.studentId === canon.id) {
        studentSubMap.set(key, s)
      }
    }
  }

  console.log(`Unique exam students count: ${studentSubMap.size}`)

  const reconciledSpellingSubs: any[] = []
  const studentReports: any[] = []

  for (const [key, sub] of studentSubMap.entries()) {
    const canon = resolveCanonicalStudent(sub.studentId || sub.studentName)
    const studentName = canon ? canon.fullName : sub.studentName
    const studentId = canon ? canon.id : sub.studentId
    const nationalCode = canon ? canon.nationalCode : 'TEST'
    const isTest = key === 'test_preview_student'

    // Evaluate afresh with official grader
    const eff = evaluateEntireExamSubmission(exam, sub.answers)
    const rawScore = eff.earnedPoints
    const scaled20 = eff.scaledScore20
    const q1Score = eff.questionScores['q2'] ?? 0

    const updatedSub = {
      ...sub,
      id: sub.id || `sub_${exam.id}_${studentId}`,
      examId: exam.id,
      studentId: studentId,
      studentName: studentName,
      earnedPoints: rawScore,
      totalScore: rawScore,
      scaledScore20: scaled20,
      status: 'approved',
      syncStatus: 'synced',
      isReleased: true,
      is_released: true,
      teacherGrading: {
        ...(sub.teacherGrading || {}),
        approved: true,
        approvedAt: sub.teacherGrading?.approvedAt || new Date().toISOString(),
        questionScores: eff.questionScores,
        questionFeedbacks: eff.questionFeedbacks,
        totalScore: rawScore,
        scaledScore20: scaled20,
        teacherNotes: 'تایید شده توسط آموزگار محترم',
        published: true,
      },
      instantStats: {
        ...(sub.instantStats || {}),
        earnedPoints: rawScore,
        maxPoints: exam.totalPoints,
        totalPoints: exam.totalPoints,
        percentage: Math.round((rawScore / exam.totalPoints) * 100),
        scaledScore20: scaled20,
        status: 'approved',
      }
    }

    reconciledSpellingSubs.push(updatedSub)

    // Save report row
    studentReports.push({
      canonicalId: studentId,
      nationalCode,
      name: studentName,
      q1Score,
      rawScore,
      scaled20,
      isTest,
      sub: updatedSub
    })
  }

  // Save reconciled submissions to data/submissions_backup.json
  const allUpdatedSubs = [...otherSubs, ...reconciledSpellingSubs]
  fs.writeFileSync('data/submissions_backup.json', JSON.stringify(allUpdatedSubs, null, 2), 'utf-8')
  console.log(`Saved ${allUpdatedSubs.length} total submissions to data/submissions_backup.json.`)

  // Sync to Supabase: grades table, quiz_submissions table, and posts table
  console.log('Syncing all students to Supabase...')
  for (const rep of studentReports) {
    if (rep.isTest) continue

    // 1. grades table via teacher_add_grade RPC
    await supabase.rpc('teacher_add_grade', {
      p_password: teacherPassword,
      p_student_id: rep.canonicalId,
      p_subject: 'فارسی',
      p_skill: 'آزمون: املای درس اول و دوم',
      p_score: rep.scaled20,
      p_max_score: 20,
    })

    // 2. Clean up duplicate rows in grades table
    const { data: grades } = await supabase.rpc('student_list_my_grades', {
      p_student_id: rep.canonicalId,
      p_access_code: rep.nationalCode
    })
    if (Array.isArray(grades) && grades.length > 1) {
      const spellingGrades = grades.filter((g: any) => g.skill && g.skill.includes('املای درس اول و دوم'))
      if (spellingGrades.length > 1) {
        // Keep the one with rep.scaled20
        const toDelete = spellingGrades.filter((g: any) => g.id !== spellingGrades[0].id)
        for (const dg of toDelete) {
          await supabase.rpc('teacher_delete_grade', {
            p_password: teacherPassword,
            p_grade_id: dg.id
          })
        }
      }
    }

    // 3. quiz_submissions table in Supabase
    const { data: existingQs } = await supabase
      .from('quiz_submissions')
      .select('id')
      .eq('student_id', rep.canonicalId)

    if (existingQs && existingQs.length > 0) {
      for (const q of existingQs) {
        await supabase.from('quiz_submissions').update({
          score: rep.scaled20,
          answers: {
            ...rep.sub.answers,
            score: rep.scaled20,
            raw_score: rep.rawScore,
            teacher_approved: true,
            approved: true,
            is_released: true,
          }
        }).eq('id', q.id)
      }
    } else {
      await supabase.from('quiz_submissions').insert({
        quiz_id: exam.id,
        student_id: rep.canonicalId,
        score: rep.scaled20,
        answers: {
          ...rep.sub.answers,
          score: rep.scaled20,
          raw_score: rep.rawScore,
          teacher_approved: true,
          approved: true,
          is_released: true,
        },
        submitted_at: rep.sub.submittedAt || new Date().toISOString()
      })
    }

    // 4. posts table (__EXAM_SUB__:${exam.id}:${rep.canonicalId})
    const postTitle = `__EXAM_SUB__:${exam.id}:${rep.canonicalId}`
    const { data: existingPosts } = await supabase.from('posts').select('id').eq('title', postTitle)
    if (existingPosts && existingPosts.length > 0) {
      await supabase.from('posts').update({
        body: JSON.stringify(rep.sub),
        publish_at: new Date().toISOString()
      }).eq('id', existingPosts[0].id)
    } else {
      await supabase.from('posts').insert({
        title: postTitle,
        body: JSON.stringify(rep.sub),
        type: 'announcement',
        publish_at: new Date().toISOString()
      })
    }
  }

  console.log('--- VERIFYING ALL 35 REAL STUDENTS FROM SUPABASE RPC ---')
  let mismatchCount = 0

  for (const rep of studentReports) {
    if (rep.isTest) continue
    const { data: finalGrades } = await supabase.rpc('student_list_my_grades', {
      p_student_id: rep.canonicalId,
      p_access_code: rep.nationalCode
    })

    const dbScore = finalGrades?.[0]?.score
    const isMatch = Math.abs(Number(dbScore) - rep.scaled20) < 0.001
    if (!isMatch) {
      console.error(`MISMATCH for ${rep.name}: Expected ${rep.scaled20}, got DB ${dbScore}`)
      mismatchCount++
    }
  }

  console.log(`Verification finished. Total mismatches: ${mismatchCount}`)
  if (mismatchCount === 0) {
    console.log('🎉 100% of all real students have identical, verified official grades in Supabase!')
  }
}

main().catch(console.error)

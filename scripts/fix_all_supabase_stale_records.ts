import fs from 'fs'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { evaluateEntireExamSubmission } from '../src/utils/persianSemanticGrader'
import { CLASS_STUDENTS_ROSTER, resolveCanonicalStudent, isSameStudent } from '../src/classStudents'

dotenv.config()

const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://ephgqrnbpxvxlzloflhy.supabase.co'
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_bI5v4Hzokb0A4JWJDzuz1A_4B3lIUX_'
const supabase = createClient(supabaseUrl, supabaseAnonKey)

async function main() {
  const teacherPassword = process.env.TEACHER_PASSWORD || '1234'
  console.log('1. Loading exam and pristine submissions...')
  const exams = JSON.parse(fs.readFileSync('data/exams_backup.json', 'utf-8'))
  const exam = exams.find((e: any) => e.id === 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2')
  const subs = JSON.parse(fs.readFileSync('data/submissions_backup.json', 'utf-8'))

  // Filter spelling exam submissions
  const spellingSubs = subs.filter((s: any) => s.examId === exam.id)
  console.log(`Found ${spellingSubs.length} spelling exam submissions in local backup.`)

  // 2. Overwrite / Upsert all __EXAM_SUB__ posts in Supabase
  console.log('2. Overwriting all __EXAM_SUB__ posts in Supabase with official 100% evaluated scores...')
  for (const s of spellingSubs) {
    const canon = resolveCanonicalStudent(s.studentId || s.studentName)
    const canonId = canon ? canon.id : s.studentId
    const postTitle = `__EXAM_SUB__:${exam.id}:${canonId}`

    const bodyJson = JSON.stringify(s)

    // Check if post exists
    const { data: existingPosts } = await supabase.from('posts').select('id, title').eq('title', postTitle)
    if (existingPosts && existingPosts.length > 0) {
      const primaryId = existingPosts[0].id
      await supabase.from('posts').update({
        body: bodyJson,
        publish_at: new Date().toISOString(),
      }).eq('id', primaryId)

      // Delete any duplicates
      for (let i = 1; i < existingPosts.length; i++) {
        await supabase.from('posts').delete().eq('id', existingPosts[i].id)
      }
    } else {
      await supabase.from('posts').insert({
        title: postTitle,
        body: bodyJson,
        type: 'announcement',
        publish_at: new Date().toISOString(),
      })
    }

    // Also update quiz_submissions table row
    const { data: qsRows } = await supabase
      .from('quiz_submissions')
      .select('id, answers')
      .eq('student_id', canonId)

    if (qsRows && qsRows.length > 0) {
      for (const qs of qsRows) {
        const updatedAnswers = {
          ...(qs.answers || {}),
          ...s.answers,
          score: s.scaledScore20,
          raw_score: s.earnedPoints,
          teacher_approved: true,
          approved: true,
          is_released: true,
        }
        await supabase
          .from('quiz_submissions')
          .update({
            score: s.scaledScore20,
            answers: updatedAnswers,
          })
          .eq('id', qs.id)
      }
    } else {
      // Insert into quiz_submissions
      await supabase.from('quiz_submissions').insert({
        quiz_id: exam.id,
        student_id: canonId,
        score: s.scaledScore20,
        answers: {
          ...s.answers,
          score: s.scaledScore20,
          raw_score: s.earnedPoints,
          teacher_approved: true,
          approved: true,
          is_released: true,
        },
        submitted_at: s.submittedAt || new Date().toISOString(),
      })
    }
  }

  // 3. Delete or update all legacy __SYSTEM_EXAM_SUBMISSIONS__ posts
  console.log('3. Updating legacy __SYSTEM_EXAM_SUBMISSIONS__ posts...')
  const { data: legacyPosts } = await supabase
    .from('posts')
    .select('id, title')
    .eq('title', '__SYSTEM_EXAM_SUBMISSIONS__')

  if (legacyPosts && legacyPosts.length > 0) {
    for (const lp of legacyPosts) {
      await supabase.from('posts').delete().eq('id', lp.id)
    }
    console.log(`Deleted ${legacyPosts.length} legacy __SYSTEM_EXAM_SUBMISSIONS__ posts to eliminate stale cache.`)
  }

  // 4. Clean up duplicate / obsolete rows in grades table
  console.log('4. Cleaning up duplicate entries in grades table...')
  for (const c of CLASS_STUDENTS_ROSTER) {
    const { data: studentGrades } = await supabase
      .from('grades')
      .select('id, score, recorded_at')
      .eq('student_id', c.id)
      .ilike('skill', '%املای درس اول و دوم%')
      .order('recorded_at', { ascending: false })

    if (studentGrades && studentGrades.length > 1) {
      // Keep only the first (latest) valid row, delete the others
      for (let i = 1; i < studentGrades.length; i++) {
        await supabase.from('grades').delete().eq('id', studentGrades[i].id)
      }
    }
  }

  console.log('Finished updating Supabase records!')
}

main().catch(console.error)

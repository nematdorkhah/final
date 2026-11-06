import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()
const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://ephgqrnbpxvxlzloflhy.supabase.co'
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_bI5v4Hzokb0A4JWJDzuz1A_4B3lIUX_'
const supabase = createClient(supabaseUrl, supabaseAnonKey)
const teacherPassword = process.env.TEACHER_PASSWORD || '1234'

async function checkAll35Grades() {
  const { data: students } = await supabase.rpc('teacher_list_students', { p_password: teacherPassword })

  let countWithGrades = 0
  for (const s of (students || [])) {
    const { data: grades } = await supabase.rpc('student_list_my_grades', {
      p_student_id: s.id,
      p_access_code: s.access_code
    })

    const spellingGrade = grades?.find((g: any) => g.skill && g.skill.includes('املای درس اول و دوم'))
    if (spellingGrade) {
      countWithGrades++
      console.log(`[PASS] ${s.full_name} (${s.access_code}): Grade = ${spellingGrade.score} / ${spellingGrade.max_score}`)
    } else {
      console.log(`[ABSENT] ${s.full_name} (${s.access_code}): No grade registered`)
    }
  }
  console.log('SUMMARY: Total students verified with official grades: ' + countWithGrades)
}

checkAll35Grades().catch(console.error)

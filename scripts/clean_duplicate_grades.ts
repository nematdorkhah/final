import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { CLASS_STUDENTS_ROSTER } from '../src/classStudents'

dotenv.config()
const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://ephgqrnbpxvxlzloflhy.supabase.co'
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_bI5v4Hzokb0A4JWJDzuz1A_4B3lIUX_'
const supabase = createClient(supabaseUrl, supabaseAnonKey)
const teacherPassword = process.env.TEACHER_PASSWORD || '1234'

async function cleanAllStudentGrades() {
  console.log('Cleaning duplicate grades for all 35 students in Supabase...')
  let deletedCount = 0

  for (const st of CLASS_STUDENTS_ROSTER) {
    const { data: grades } = await supabase.rpc('student_list_my_grades', {
      p_student_id: st.id,
      p_access_code: st.nationalCode
    })

    if (!Array.isArray(grades) || grades.length <= 1) continue

    const spellingGrades = grades.filter((g: any) => g.skill && g.skill.includes('املای درس اول و دوم'))
    if (spellingGrades.length > 1) {
      // Sort descending by score, then recorded_at
      spellingGrades.sort((a: any, b: any) => {
        if (b.score !== a.score) return b.score - a.score
        return new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
      })

      // Keep the first (highest/latest)
      const keep = spellingGrades[0]
      const toDelete = spellingGrades.slice(1)
      for (const g of toDelete) {
        await supabase.rpc('teacher_delete_grade', {
          p_password: teacherPassword,
          p_grade_id: g.id
        })
        deletedCount++
      }
      console.log(`Student ${st.fullName}: kept grade ${keep.score}, deleted ${toDelete.length} duplicates.`)
    }
  }

  console.log(`Total duplicate grade rows deleted: ${deletedCount}`)
}

cleanAllStudentGrades().catch(console.error)

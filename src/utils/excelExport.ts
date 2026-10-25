import * as XLSX from 'xlsx'
import { toPersianDigits } from './persianNumbers'
import { extractLastName } from './persianSort'

export interface ExcelExportData {
  students: any[]
  grades: any[]
  submissions: any[]
  allAttendance: any[]
  homeworkPosts: any[]
}

export function exportClassroomToExcel({
  students,
  grades,
  submissions,
  allAttendance,
  homeworkPosts,
}: ExcelExportData) {
  try {
    const wb = XLSX.utils.book_new()

    // 1. Students & GPA Sheet (Alphabetical by Last Name)
    const sortedStudents = [...students].sort((a, b) => {
      const lastA = extractLastName(a.full_name || a.name || '')
      const lastB = extractLastName(b.full_name || b.name || '')
      return lastA.localeCompare(lastB, 'fa')
    })

    const studentsRows = sortedStudents.map((s, idx) => {
      const studentGrades = grades.filter((g) => g.student_id === s.id)
      const studentSubs = submissions.filter((sub) => sub.student_id === s.id)
      const studentAtt = allAttendance.filter((att) => att.student_id === s.id)

      let gpa = '-'
      if (studentGrades.length > 0) {
        const total = studentGrades.reduce((sum, g) => {
          const max = Number(g.max_score) || 20
          const sc = Number(g.score) || 0
          return sum + (max > 0 ? (sc / max) * 20 : sc)
        }, 0)
        gpa = (total / studentGrades.length).toFixed(2)
      }

      const presentCount = studentAtt.filter((a) => a.status === 'present').length
      const lateCount = studentAtt.filter((a) => a.status === 'late').length
      const absentCount = studentAtt.filter((a) => a.status === 'absent').length

      return {
        'ردیف': idx + 1,
        'نام و نام خانوادگی': s.full_name || s.name || '',
        'نام پدر': s.father_name || s.fatherName || '',
        'کد ملی': s.id || s.nationalCode || '',
        'میانگین نمرات (از ۲۰)': gpa,
        'تعداد تکالیف ارسالی': studentSubs.length,
        'حاضر': presentCount,
        'تأخیر': lateCount,
        'غایب': absentCount,
      }
    })

    const wsStudents = XLSX.utils.json_to_sheet(studentsRows)
    XLSX.utils.book_append_sheet(wb, wsStudents, 'دانش‌آموزان و معدل')

    // 2. Grades Sheet
    const gradesRows = grades.map((g, idx) => {
      const student = students.find((s) => s.id === g.student_id)
      const max = Number(g.max_score) || 20
      const score = Number(g.score) || 0
      const scaled = max > 0 ? Math.round(((score / max) * 20) * 10) / 10 : score
      return {
        'ردیف': idx + 1,
        'دانش‌آموز': student?.full_name || g.student_name || g.student_id,
        'درس': g.subject || 'عمومی',
        'مبحث / مهارت': g.skill || g.subject || '',
        'نمره خام': score,
        'از نمره': max,
        'معادل ۲۰': scaled,
        'تاریخ ثبت': g.recorded_at ? new Date(g.recorded_at).toLocaleDateString('fa-IR') : '',
        'توضیحات و بازخورد': g.notes || '',
      }
    })
    const wsGrades = XLSX.utils.json_to_sheet(gradesRows)
    XLSX.utils.book_append_sheet(wb, wsGrades, 'ریز نمرات')

    // 3. Attendance Sheet
    const attRows = allAttendance.map((a, idx) => {
      const student = students.find((s) => s.id === a.student_id)
      const statusLabel = a.status === 'present' ? 'حاضر' : a.status === 'late' ? 'تأخیر' : 'غایب'
      return {
        'ردیف': idx + 1,
        'تاریخ': a.date,
        'دانش‌آموز': student?.full_name || a.student_id,
        'وضعیت حضور': statusLabel,
        'یادداشت': a.notes || '',
      }
    })
    const wsAttendance = XLSX.utils.json_to_sheet(attRows)
    XLSX.utils.book_append_sheet(wb, wsAttendance, 'حضور و غیاب')

    // 4. Write workbook file to browser download
    const fileName = `کارنامه_جامع_کلاس_ششم_${Date.now()}.xlsx`
    XLSX.writeFile(wb, fileName)
  } catch (err) {
    console.error('Failed exporting Excel report:', err)
    alert('خطا در تولید فایل اکسل گزارش کلاسی.')
  }
}

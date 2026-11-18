import assert from 'assert'
import { supabase } from '../src/supabaseClient'
import { CLASS_STUDENTS_ROSTER, isSameStudent, isTestStudentRecord } from '../src/classStudents'
import {
  fetchAllExams,
  fetchPublishedExamsWithDiagnostics,
  fetchExamSubmissions,
  mergeSubmissionsDeduplicated,
  isExamResultsReleased,
  sanitizeExamTitle,
} from '../src/utils/examStore'
import {
  getExamMaxPoints,
  getSubmissionEffectiveScore,
  isSubmissionApprovedByTeacher,
  roundScore2,
} from '../src/utils/persianSemanticGrader'
import { Exam, StudentExamSubmission } from '../src/types/examTypes'

interface IndependentComparisonRow {
  rowNum: number
  studentName: string
  examId: string
  examTitle: string
  maxPts: number
  teacherExamMetaOk: boolean
  subFetchParityOk: boolean
  teacherBuilderStatus: string
  teacherBuilderScore20: number | null
  teacherBuilderRaw: string
  teacherGradebookScore20: number | null
  studentReportStatus: string
  studentReportScore20: number | null
  studentReportRaw: string
  dbGradeCount: number
  dbGradeLatestScore: number | null
  dbGradeAccess: 'OK' | 'CUSTOM_CODE'
  allMatch: boolean
  mismatchDetail?: string
}

/**
 * Independent Teacher Gradebook score computation (does NOT call buildCanonicalGradesList).
 * Mirrors TeacherExamBuilder + TeacherDashboard / Gradebook official grade rules.
 */
function computeIndependentTeacherSide(params: {
  studentId: string
  studentName: string
  exam: Exam
  classWideSubs: StudentExamSubmission[]
  dbGrades: any[]
}) {
  const { studentId, studentName, exam, classWideSubs, dbGrades } = params
  const cleanTitle = sanitizeExamTitle(exam.title, exam.subject)
  const maxPts = getExamMaxPoints(exam)

  const matchedSubs = classWideSubs.filter(
    (s) => s.examId === exam.id && isSameStudent(s.studentId, studentId, s.studentName, studentName)
  )
  const sub = matchedSubs[0] || null

  // 1. TeacherExamBuilder & TeacherExamSubmissions column ("نمره رسمی کارنامه")
  let builderStatus = 'NOT_SUBMITTED'
  let builderScore20: number | null = null
  let builderRaw = '—'

  if (sub) {
    const eff = getSubmissionEffectiveScore(exam, sub)
    const approved = isSubmissionApprovedByTeacher(sub) && eff.isApproved
    const released = isExamResultsReleased(exam, sub)
    if (approved && released) {
      builderStatus = 'APPROVED_RELEASED'
      builderScore20 = eff.scaledScore20
      builderRaw = `${eff.totalScore}/${maxPts}`
    } else if (approved) {
      builderStatus = 'APPROVED_LOCKED'
    } else {
      builderStatus = 'PENDING_APPROVAL'
    }
  }

  // 2. Teacher Gradebook / StudentProfilePanel effective official score (independent of buildCanonicalGradesList)
  const matchingDb = dbGrades
    .filter((g) => {
      const cleanG = sanitizeExamTitle(g.skill || '', g.subject)
      return (
        g.examId === exam.id ||
        (cleanTitle && cleanG && (cleanG === cleanTitle || String(g.skill || '').includes(cleanTitle)))
      )
    })
    .sort((a, b) => new Date(b.recorded_at || 0).getTime() - new Date(a.recorded_at || 0).getTime())
  const latestDb = matchingDb[0] || null

  let gradebookScore20: number | null = builderScore20
  if (latestDb) {
    const dbScore = Number(latestDb.score) || 0
    const dbMax = Number(latestDb.max_score) || 20
    const normalizedDb20 = dbMax > 0 && dbMax !== 20 ? roundScore2((dbScore / dbMax) * 20) : roundScore2(dbScore)

    if (sub) {
      const eff = getSubmissionEffectiveScore(exam, sub)
      const approved = isSubmissionApprovedByTeacher(sub) && eff.isApproved
      const released = isExamResultsReleased(exam, sub)
      if (!approved || !released) {
        gradebookScore20 = null // Unapproved/unreleased never enters official gradebook
      } else {
        const gMs = latestDb.recorded_at ? new Date(latestDb.recorded_at).getTime() : 0
        const sMs = sub.teacherGrading?.approvedAt ? new Date(sub.teacherGrading.approvedAt).getTime() : 0
        const isManualNewerEdit =
          Math.abs(normalizedDb20 - eff.scaledScore20) > 0.06 && gMs > 0 && sMs > 0 && gMs > sMs + 1000
        gradebookScore20 = isManualNewerEdit ? normalizedDb20 : eff.scaledScore20
      }
    } else {
      gradebookScore20 = normalizedDb20
    }
  }

  return {
    sub,
    matchedCount: matchedSubs.length,
    builderStatus,
    builderScore20,
    builderRaw,
    gradebookScore20,
    dbGradeCount: matchingDb.length,
    dbGradeLatestScore: latestDb ? Number(latestDb.score) : null,
  }
}

/**
 * Independent Student Report Card computation (does NOT call buildCanonicalGradesList).
 * Directly implements StudentDashboard fetch + StudentReportCard normalization & gating rules.
 */
function computeIndependentStudentSide(params: {
  studentId: string
  studentName: string
  exam: Exam
  perStudentSubs: StudentExamSubmission[]
  studentDbGrades: any[]
}) {
  const { studentId, studentName, exam, perStudentSubs, studentDbGrades } = params
  const cleanTitle = sanitizeExamTitle(exam.title, exam.subject)
  const maxPts = getExamMaxPoints(exam)

  const dedupedPerStudent = mergeSubmissionsDeduplicated([], perStudentSubs).filter(
    (s) => s.examId === exam.id && isSameStudent(s.studentId, studentId, s.studentName, studentName)
  )
  const sub = dedupedPerStudent[0] || null

  const matchingDb = studentDbGrades
    .filter((g) => {
      const cleanG = sanitizeExamTitle(g.skill || '', g.subject)
      return (
        g.examId === exam.id ||
        (cleanTitle && cleanG && (cleanG === cleanTitle || String(g.skill || '').includes(cleanTitle)))
      )
    })
    .sort((a, b) => new Date(b.recorded_at || 0).getTime() - new Date(a.recorded_at || 0).getTime())
  const latestDb = matchingDb[0] || null

  // Exact StudentReportCard.tsx lines 69-105 independent replication
  let reportStatus: 'graded' | 'pending_review' | 'pending_submission' = 'pending_submission'
  let reportScore20: number | null = null
  let reportRaw = '—'

  if (sub) {
    const approved = isSubmissionApprovedByTeacher(sub)
    const released = isExamResultsReleased(exam, sub)
    const eff = getSubmissionEffectiveScore(exam, sub)

    if (approved && eff.isApproved && released) {
      let score20 = eff.scaledScore20
      let rawEarned = eff.totalScore
      let rawMax = eff.maxPoints

      if (latestDb) {
        const dbScore = Number(latestDb.score) || 0
        const dbMax = Number(latestDb.max_score) || 20
        const normalizedDb20 = dbMax > 0 && dbMax !== 20 ? roundScore2((dbScore / dbMax) * 20) : roundScore2(dbScore)
        const dbRecordedMs = latestDb.recorded_at ? new Date(latestDb.recorded_at).getTime() : 0
        const subApprovedMs = sub.teacherGrading?.approvedAt
          ? new Date(sub.teacherGrading.approvedAt).getTime()
          : 0
        const isExplicitDbRecord = Boolean(
          latestDb.id && !String(latestDb.id).startsWith('exam_sub_') && !String(latestDb.id).startsWith('exam_')
        )
        const isDifferentManualDbScore = Math.abs(normalizedDb20 - eff.scaledScore20) > 0.06
        const isNewerDbManualEdit = Boolean(
          isExplicitDbRecord &&
            isDifferentManualDbScore &&
            dbRecordedMs > 0 &&
            subApprovedMs > 0 &&
            dbRecordedMs > subApprovedMs + 1000
        )
        if (isNewerDbManualEdit) {
          score20 = normalizedDb20
          rawEarned = dbScore
          rawMax = dbMax
        }
      }

      reportStatus = 'graded'
      reportScore20 = score20
      reportRaw = `${rawEarned}/${rawMax}`
    } else {
      reportStatus = 'pending_review'
      reportScore20 = null
      reportRaw = `0/${maxPts} (مخفی)`
    }
  } else if (latestDb) {
    const dbScore = Number(latestDb.score) || 0
    const dbMax = Number(latestDb.max_score) || 20
    reportStatus = 'graded'
    reportScore20 = dbMax > 0 && dbMax !== 20 ? roundScore2((dbScore / dbMax) * 20) : roundScore2(dbScore)
    reportRaw = `${dbScore}/${dbMax}`
  }

  return {
    sub,
    dedupedCount: dedupedPerStudent.length,
    reportStatus,
    reportScore20,
    reportRaw,
  }
}

async function main() {
  console.log('========================================================================')
  console.log('🔬 INDEPENDENT END-TO-END PIPELINE VERIFICATION (NO SHARED HELPER)')
  console.log('========================================================================')

  // 0. Before DB snapshot (must match After DB snapshot byte-for-byte)
  const snapshotBefore = {
    quizzes: (await supabase.from('quizzes').select('id', { count: 'exact', head: true })).count,
    quizSubs: (await supabase.from('quiz_submissions').select('id', { count: 'exact', head: true })).count,
    posts: (await supabase.from('posts').select('id', { count: 'exact', head: true })).count,
    gradesDirectAnon: (await supabase.from('grades').select('id', { count: 'exact', head: true })).count,
  }
  console.log('DB Snapshot Before:', snapshotBefore)

  // 1. TEACHER PIPELINE FETCH (exact calls from useClassroomData.ts lines 103-104)
  const teacherExams = (await fetchAllExams()).filter((e) => e && e.published !== false)
  const teacherClassSubs = await fetchExamSubmissions(undefined, undefined, true)
  const realTeacherSubs = teacherClassSubs.filter((s) => !isTestStudentRecord(s.studentId, s.studentName))

  // 2. STUDENT PIPELINE EXAMS FETCH (exact call from StudentDashboard.tsx line 446)
  const studentDiag = await fetchPublishedExamsWithDiagnostics(true, true, { skipBackendApi: true })
  const studentExams = studentDiag.exams.filter((e) => e && e.published !== false)

  console.log(
    `Teacher Exams: ${teacherExams.length} | Student Exams: ${studentExams.length} (remoteOk=${studentDiag.remoteOk}, sources=${studentDiag.remoteSourcesSucceeded})`
  )
  console.log(`Teacher Class-Wide Deduped Subs: ${teacherClassSubs.length} (real students=${realTeacherSubs.length})`)

  // Compare exam lists independently
  const teacherExamMap = new Map(teacherExams.map((e) => [e.id, e]))
  const studentExamMap = new Map(studentExams.map((e) => [e.id, e]))
  assert.strictEqual(teacherExams.length, studentExams.length, 'Teacher and Student must resolve identical published exam count')

  for (const tEx of teacherExams) {
    const sEx = studentExamMap.get(tEx.id)
    assert.ok(sEx, `Student pipeline missing exam ${tEx.id}`)
    assert.strictEqual(getExamMaxPoints(tEx), getExamMaxPoints(sEx), `Max points mismatch on ${tEx.title}`)
    assert.strictEqual(Boolean(tEx.resultsPublished), Boolean(sEx.resultsPublished), `resultsPublished mismatch on ${tEx.title}`)
    assert.strictEqual(Boolean(tEx.isResultsReleased), Boolean(sEx.isResultsReleased), `isResultsReleased mismatch on ${tEx.title}`)
  }

  // 3. Run Student Per-Student Pipeline for ALL 40 students independently + compare against Teacher Pipeline across all 80 pairs
  const results: IndependentComparisonRow[] = []
  let mismatches = 0
  let totalStudentDbRows = 0
  let mathDbRows = 0
  let spellingDbRows = 0
  const customCodeStudents: string[] = []

  // Process sequentially in small batches to avoid hammering Supabase concurrently while keeping each student query completely independent
  for (const st of CLASS_STUDENTS_ROSTER) {
    const [perStudentSubs, dbGradesRes] = await Promise.all([
      fetchExamSubmissions(undefined, st.id, true),
      supabase.rpc('student_list_my_grades', {
        p_student_id: st.id,
        p_access_code: st.nationalCode,
      }),
    ])

    const dbAccess: 'OK' | 'CUSTOM_CODE' = dbGradesRes.error ? 'CUSTOM_CODE' : 'OK'
    if (dbGradesRes.error) customCodeStudents.push(st.fullName)
    const studentDbGrades = Array.isArray(dbGradesRes.data) ? dbGradesRes.data : []

    totalStudentDbRows += studentDbGrades.length
    for (const r of studentDbGrades) {
      const sk = String(r.skill || '')
      if (sk.includes('تقسیم')) mathDbRows++
      if (sk.includes('املا')) spellingDbRows++
    }

    for (const tEx of teacherExams) {
      const sEx = studentExamMap.get(tEx.id)!
      const tSide = computeIndependentTeacherSide({
        studentId: st.id,
        studentName: st.fullName,
        exam: tEx,
        classWideSubs: teacherClassSubs,
        dbGrades: studentDbGrades,
      })
      const sSide = computeIndependentStudentSide({
        studentId: st.id,
        studentName: st.fullName,
        exam: sEx,
        perStudentSubs,
        studentDbGrades,
      })

      const subFetchParityOk =
        tSide.matchedCount === sSide.dedupedCount &&
        Boolean(tSide.sub?.id) === Boolean(sSide.sub?.id) &&
        (!tSide.sub ||
          !sSide.sub ||
          (tSide.sub.status === sSide.sub.status &&
            Boolean(tSide.sub.teacherGrading?.approved) === Boolean(sSide.sub.teacherGrading?.approved) &&
            Number(tSide.sub.teacherGrading?.totalScore ?? -1) === Number(sSide.sub.teacherGrading?.totalScore ?? -1)))

      let allMatch = subFetchParityOk
      let mismatchDetail: string | undefined

      if (!subFetchParityOk) {
        mismatchDetail = `SubFetch mismatch: T(${tSide.sub?.status}/${tSide.sub?.teacherGrading?.totalScore}) vs S(${sSide.sub?.status}/${sSide.sub?.teacherGrading?.totalScore})`
      } else if (tSide.builderScore20 !== sSide.reportScore20) {
        allMatch = false
        mismatchDetail = `TeacherBuilder(${tSide.builderScore20}) !== StudentReport(${sSide.reportScore20})`
      } else if (tSide.gradebookScore20 !== sSide.reportScore20) {
        allMatch = false
        mismatchDetail = `TeacherGradebook(${tSide.gradebookScore20}) !== StudentReport(${sSide.reportScore20})`
      }

      if (!allMatch) mismatches++

      results.push({
        rowNum: st.row,
        studentName: st.fullName,
        examId: tEx.id,
        examTitle: sanitizeExamTitle(tEx.title, tEx.subject),
        maxPts: getExamMaxPoints(tEx),
        teacherExamMetaOk: true,
        subFetchParityOk,
        teacherBuilderStatus: tSide.builderStatus,
        teacherBuilderScore20: tSide.builderScore20,
        teacherBuilderRaw: tSide.builderRaw,
        teacherGradebookScore20: tSide.gradebookScore20,
        studentReportStatus: sSide.reportStatus,
        studentReportScore20: sSide.reportScore20,
        studentReportRaw: sSide.reportRaw,
        dbGradeCount: tSide.dbGradeCount,
        dbGradeLatestScore: tSide.dbGradeLatestScore,
        dbGradeAccess: dbAccess,
        allMatch,
        mismatchDetail,
      })
    }
  }

  // Print concise per-exam stats + sample & any mismatches
  for (const ex of teacherExams) {
    const exRows = results.filter((r) => r.examId === ex.id)
    const approvedCount = exRows.filter((r) => r.teacherBuilderStatus === 'APPROVED_RELEASED').length
    const pendingCount = exRows.filter((r) => r.teacherBuilderStatus === 'PENDING_APPROVAL').length
    const lockedCount = exRows.filter((r) => r.teacherBuilderStatus === 'APPROVED_LOCKED').length
    const missingCount = exRows.filter((r) => r.teacherBuilderStatus === 'NOT_SUBMITTED').length
    const withDbRow = exRows.filter((r) => r.dbGradeCount > 0).length
    console.log(
      `\n📘 Exam: ${sanitizeExamTitle(ex.title, ex.subject)} (${ex.id}) [${getExamMaxPoints(ex)}pt]: ` +
        `approved_released=${approvedCount}, approved_locked=${lockedCount}, pending=${pendingCount}, not_submitted=${missingCount}, ` +
        `has_db_grades_row=${withDbRow}/40`
    )
  }

  console.log('\n--- NON-EMPTY SUBMISSIONS / MISMATCHES SUMMARY ---')
  for (const r of results) {
    if (r.teacherBuilderStatus !== 'NOT_SUBMITTED' || !r.allMatch) {
      console.log(
        `#${String(r.rowNum).padStart(2, '0')} ${r.studentName} | ${r.examTitle} | ` +
          `T_Builder=${r.teacherBuilderScore20 ?? r.teacherBuilderStatus}(${r.teacherBuilderRaw}) | ` +
          `T_GB=${r.teacherGradebookScore20 ?? '—'} | ` +
          `S_Report=${r.studentReportScore20 ?? r.studentReportStatus}(${r.studentReportRaw}) | ` +
          `DB=${r.dbGradeLatestScore ?? 'NONE'}(x${r.dbGradeCount}) | ${r.allMatch ? 'MATCH' : 'FAIL: ' + r.mismatchDetail}`
      )
    }
  }

  const snapshotAfter = {
    quizzes: (await supabase.from('quizzes').select('id', { count: 'exact', head: true })).count,
    quizSubs: (await supabase.from('quiz_submissions').select('id', { count: 'exact', head: true })).count,
    posts: (await supabase.from('posts').select('id', { count: 'exact', head: true })).count,
    gradesDirectAnon: (await supabase.from('grades').select('id', { count: 'exact', head: true })).count,
  }
  assert.deepStrictEqual(snapshotAfter, snapshotBefore, 'DB must remain 100% unmodified!')

  console.log('\n========================================================================')
  console.log(`INDEPENDENT 80-PAIR SUMMARY: Pairs=${results.length}, Mismatches=${mismatches}`)
  console.log(`GRADES TABLE RPC AUDIT: okStudents=${40 - customCodeStudents.length}, customCode=${customCodeStudents.length} (${customCodeStudents.join('، ')}), totalRows=${totalStudentDbRows}, mathRows=${mathDbRows}, spellingRows=${spellingDbRows}`)
  console.log('========================================================================')

  if (mismatches > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Independent audit failed:', err)
  process.exit(1)
})

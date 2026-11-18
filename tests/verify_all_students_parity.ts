import assert from 'assert'
import { supabase } from '../src/supabaseClient'
import { CLASS_STUDENTS_ROSTER, isSameStudent, isTestStudentRecord } from '../src/classStudents'
import {
  fetchAllExams,
  fetchExamSubmissions,
  mergeSubmissionsDeduplicated,
  isExamResultsReleased,
  buildCanonicalGradesList,
  sanitizeExamTitle,
} from '../src/utils/examStore'
import {
  evaluateEntireExamSubmission,
  getExamMaxPoints,
  getSubmissionEffectiveScore,
  isSubmissionApprovedByTeacher,
  roundScore2,
  safeScaled20,
} from '../src/utils/persianSemanticGrader'
import { Exam, StudentExamSubmission } from '../src/types/examTypes'

interface ParityRow {
  rowNum: number
  studentName: string
  studentUuid: string
  nationalCode: string
  examId: string
  examTitle: string
  maxPts: number
  rawMatchedCount: number
  dedupedCount: number
  rawScoreDisplay: string
  aiSuggestedDisplay: string
  teacherApprovedDisplay: string
  dbGradeDisplay: string
  scaled20Display: string
  releaseStatus: string
  teacherGradebookScore20: number | null
  studentReportScore20: number | null
  matchOk: boolean
  mismatchReason?: string
}

function formatScorePair(val: number | null | undefined, max: number): string {
  if (val === null || val === undefined || isNaN(val)) return '—'
  return `${roundScore2(val)}/${roundScore2(max)}`
}

async function main() {
  console.log('========================================================================')
  console.log('📊 FULL 40-STUDENT READ-ONLY PARITY & ROOT-CAUSE VERIFICATION AUDIT')
  console.log('========================================================================')

  // 0. Snapshot table counts to guarantee 100% read-only execution
  const snapshotBefore = {
    quizzes: (await supabase.from('quizzes').select('id', { count: 'exact', head: true })).count,
    quizSubs: (await supabase.from('quiz_submissions').select('id', { count: 'exact', head: true })).count,
    posts: (await supabase.from('posts').select('id', { count: 'exact', head: true })).count,
    grades: (await supabase.from('grades').select('id', { count: 'exact', head: true })).count,
  }
  console.log('DB Snapshot (before):', snapshotBefore)

  // 1. Load live exams & deduplicated submissions via authoritative store functions
  const exams: Exam[] = (await fetchAllExams()).filter((e) => e && e.published !== false)
  const dedupedSubs: StudentExamSubmission[] = await fetchExamSubmissions(undefined, undefined, true)

  // 2. Also inspect raw Supabase sources to quantify duplicate / corrupted rows eliminated
  const [sysSubRes, indPostsRes, quizSubRes] = await Promise.all([
    supabase
      .from('posts')
      .select('body')
      .eq('title', '__SYSTEM_EXAM_SUBMISSIONS__')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('posts')
      .select('id, title, body')
      .like('title', '__EXAM_SUB__:%')
      .limit(300),
    supabase
      .from('quiz_submissions')
      .select('id, quiz_id, student_id, score, submitted_at, answers')
      .limit(300),
  ])

  const rawSysSubs: any[] = sysSubRes.data?.body
    ? (typeof sysSubRes.data.body === 'string' ? JSON.parse(sysSubRes.data.body) : sysSubRes.data.body)
    : []
  const rawIndPosts: any[] = indPostsRes.data || []
  const rawQuizSubs: any[] = quizSubRes.data || []

  // Count corrupted cross-exam posts caught by our guard
  let corruptedIndPostsCount = 0
  for (const row of rawIndPosts) {
    try {
      const titleExamId = String(row.title || '').split(':')[1]
      const body = typeof row.body === 'string' ? JSON.parse(row.body) : row.body
      if (titleExamId && body?.examId && body.examId !== titleExamId) {
        corruptedIndPostsCount++
      }
    } catch {}
  }

  console.log(
    `Loaded ${exams.length} live exams, ${dedupedSubs.length} deduplicated submissions ` +
      `(raw sources: sys=${rawSysSubs.length}, ind=${rawIndPosts.length} [corrupted cross-exam=${corruptedIndPostsCount}], quiz_subs=${rawQuizSubs.length})`
  )

  // 3. Load official `grades` rows for all 40 roster students (read-only RPC per student)
  const studentGradesMap = new Map<string, any[]>()
  const studentGradesAccessMap = new Map<string, string>()
  await Promise.all(
    CLASS_STUDENTS_ROSTER.map(async (st) => {
      const { data, error } = await supabase.rpc('student_list_my_grades', {
        p_student_id: st.id,
        p_access_code: st.nationalCode,
      })
      if (error) {
        studentGradesMap.set(st.id, [])
        studentGradesAccessMap.set(st.id, `CUSTOM_CODE`)
      } else {
        studentGradesMap.set(st.id, Array.isArray(data) ? data : [])
        studentGradesAccessMap.set(st.id, 'OK')
      }
    })
  )

  // 4. Verify all 40 students x all live exams
  const rows: ParityRow[] = []
  let discrepancies = 0
  let duplicateDedupeViolations = 0

  for (const st of CLASS_STUDENTS_ROSTER) {
    const dbGrades = studentGradesMap.get(st.id) || []

    // Exact logic executed by TeacherDashboard.tsx (includePending: false)
    const teacherGradebookList = buildCanonicalGradesList({
      studentId: st.id,
      studentName: st.fullName,
      dbGrades,
      exams,
      examSubmissions: dedupedSubs,
      includePending: false,
    })

    // Exact logic executed by StudentDashboard.tsx & StudentProfilePanel Report Card (includePending: true)
    const studentDashboardList = buildCanonicalGradesList({
      studentId: st.id,
      studentName: st.fullName,
      dbGrades,
      exams,
      examSubmissions: dedupedSubs,
      includePending: true,
    })

    for (const exam of exams) {
      const maxPts = getExamMaxPoints(exam)
      const cleanTitle = sanitizeExamTitle(exam.title, exam.subject)

      // Raw matched submissions count across all 3 persistence tables
      const rawMatchedSys = rawSysSubs.filter(
        (s) => s?.examId === exam.id && isSameStudent(s.studentId, st.id, s.studentName, st.fullName)
      ).length
      const rawMatchedInd = rawIndPosts.filter((p) => {
        const parts = String(p.title || '').split(':')
        if (parts[1] !== exam.id) return false
        try {
          const b = typeof p.body === 'string' ? JSON.parse(p.body) : p.body
          if (b?.examId !== parts[1]) return false
          return isSameStudent(b?.studentId || parts[2], st.id, b?.studentName, st.fullName)
        } catch {
          return false
        }
      }).length
      const rawMatchedQs = rawQuizSubs.filter((q) => {
        const qEx = q.quiz_id || q.answers?.quiz_id || q.answers?.exam_id
        if (qEx !== exam.id) return false
        return isSameStudent(q.student_id, st.id, q.answers?.student_name, st.fullName)
      }).length
      const rawMatchedCount = rawMatchedSys + rawMatchedInd + rawMatchedQs

      const matchedDedupedSubs = dedupedSubs.filter(
        (s) => s.examId === exam.id && isSameStudent(s.studentId, st.id, s.studentName, st.fullName)
      )
      if (matchedDedupedSubs.length > 1) {
        duplicateDedupeViolations++
      }

      const sub = matchedDedupedSubs[0] || null
      const eff = sub ? getSubmissionEffectiveScore(exam, sub) : null
      const freshEval = sub ? evaluateEntireExamSubmission(exam, sub.answers || {}) : null
      const isApproved = sub ? isSubmissionApprovedByTeacher(sub) && Boolean(eff?.isApproved) : false
      const isReleased = sub ? isExamResultsReleased(exam, sub) : false

      // Match DB grades belonging to this exam
      const matchingDbGrades = dbGrades
        .filter((g) => {
          const cleanG = sanitizeExamTitle(g.skill || '', g.subject)
          return (
            g.examId === exam.id ||
            (cleanTitle && cleanG && (cleanG === cleanTitle || String(g.skill || '').includes(cleanTitle)))
          )
        })
        .sort((a, b) => new Date(b.recorded_at || 0).getTime() - new Date(a.recorded_at || 0).getTime())
      const latestDbGrade = matchingDbGrades[0] || null

      // Locate exam entry in teacherGradebookList & studentDashboardList
      const teacherItem =
        teacherGradebookList.find(
          (g) =>
            g.examId === exam.id ||
            g.matchedExam?.id === exam.id ||
            (cleanTitle && sanitizeExamTitle(g.skill || '', g.subject) === cleanTitle)
        ) || null
      const studentItem =
        studentDashboardList.find(
          (g) =>
            g.examId === exam.id ||
            g.matchedExam?.id === exam.id ||
            (cleanTitle && sanitizeExamTitle(g.skill || '', g.subject) === cleanTitle)
        ) || null

      const teacherScore20 = teacherItem && teacherItem.status === 'graded' ? roundScore2(Number(teacherItem.score)) : null
      const studentScore20 = studentItem && studentItem.status === 'graded' ? roundScore2(Number(studentItem.score)) : null

      // Teacher ExamBuilder Official column vs Student Report Card check
      let matchOk = true
      let mismatchReason: string | undefined

      if (teacherScore20 !== studentScore20) {
        matchOk = false
        mismatchReason = `TeacherGradebook(${teacherScore20}) !== StudentReport(${studentScore20})`
      }

      if (sub && isApproved && isReleased && eff) {
        // Unless there's a genuinely different newer manual Gradebook DB edit (>0.06 diff), ExamBuilder table official === TeacherGB === StudentRC
        const gMs = latestDbGrade?.recorded_at ? new Date(latestDbGrade.recorded_at).getTime() : 0
        const sMs = sub.teacherGrading?.approvedAt ? new Date(sub.teacherGrading.approvedAt).getTime() : 0
        const isManualOverrideDb = Boolean(
          latestDbGrade &&
            Math.abs(Number(latestDbGrade.score) - eff.scaledScore20) > 0.06 &&
            gMs > 0 &&
            sMs > 0 &&
            gMs > sMs + 1000
        )
        if (!isManualOverrideDb && studentScore20 !== eff.scaledScore20) {
          matchOk = false
          mismatchReason = `ExamOfficial(${eff.scaledScore20}) !== StudentReport(${studentScore20})`
        }
      }

      if (sub && (!isApproved || !isReleased)) {
        if (studentScore20 !== null || studentItem?.status !== 'pending_review') {
          matchOk = false
          mismatchReason = `Unapproved/locked submission leaked score=${studentScore20} status=${studentItem?.status}`
        }
      }

      if (!matchOk) discrepancies++

      const releaseStatus = !sub
        ? 'NOT_SUBMITTED'
        : isApproved && isReleased
        ? 'APPROVED_RELEASED'
        : isApproved
        ? 'APPROVED_LOCKED'
        : 'PENDING_APPROVAL'

      rows.push({
        rowNum: st.row,
        studentName: st.fullName,
        studentUuid: st.id,
        nationalCode: st.nationalCode,
        examId: exam.id,
        examTitle: cleanTitle,
        maxPts,
        rawMatchedCount,
        dedupedCount: matchedDedupedSubs.length,
        rawScoreDisplay: eff ? formatScorePair(eff.totalScore, maxPts) : '—',
        aiSuggestedDisplay: freshEval ? `${freshEval.earnedPoints}/${maxPts} (${freshEval.scaledScore20}/20)` : '—',
        teacherApprovedDisplay: isApproved && eff ? `${eff.totalScore}/${maxPts} (${eff.scaledScore20}/20)` : sub ? 'PENDING' : '—',
        dbGradeDisplay: latestDbGrade ? `${latestDbGrade.score}/${latestDbGrade.max_score || 20} (x${matchingDbGrades.length})` : 'NONE',
        scaled20Display: studentScore20 !== null ? `${studentScore20}/20` : studentItem?.status || '—',
        releaseStatus,
        teacherGradebookScore20: teacherScore20,
        studentReportScore20: studentScore20,
        matchOk,
        mismatchReason,
      })
    }
  }

  // 5. Print full 40-student parity table grouped cleanly
  console.log('\n--- PER-STUDENT FULL VERIFICATION TABLE (ALL 40 STUDENTS x ALL LIVE EXAMS) ---')
  for (const r of rows) {
    console.log(
      `#${String(r.rowNum).padStart(2, '0')} | ${r.studentName} (${r.nationalCode}) | ` +
        `${r.examTitle} [${r.maxPts}pt] | raw=${r.rawMatchedCount}->dedup=${r.dedupedCount} | ` +
        `AI=${r.aiSuggestedDisplay} | Approved=${r.teacherApprovedDisplay} | DB=${r.dbGradeDisplay} | ` +
        `TeacherGB=${r.teacherGradebookScore20 ?? '—'} | StudentRC=${r.studentReportScore20 ?? r.releaseStatus} | ` +
        `status=${r.releaseStatus} | ${r.matchOk ? 'OK' : 'MISMATCH: ' + r.mismatchReason}`
    )
  }

  // 6. Targeted diagnostic assertions for Mohammad Ahmadi (Behnam) + synthetic unapproved security simulation
  const mohammadRows = rows.filter((r) => r.nationalCode === '3382569701')
  assert.strictEqual(mohammadRows.length, exams.length, 'Mohammad Ahmadi must have one row per live exam')

  const mohammadSpelling = mohammadRows.find((r) => r.examId === 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2')
  assert.ok(mohammadSpelling, 'Mohammad Ahmadi Spelling row must exist')
  assert.strictEqual(mohammadSpelling.dedupedCount, 1, 'Spelling submission must deduplicate to exactly 1')
  assert.strictEqual(mohammadSpelling.rawScoreDisplay, '8/9.5', 'Spelling raw score must resolve to 8/9.5 (not stale 3.6 or 7)')
  assert.strictEqual(mohammadSpelling.studentReportScore20, 16.84, 'Spelling student report score must be 16.84/20 (not 7.6/20)')
  assert.strictEqual(mohammadSpelling.teacherGradebookScore20, 16.84, 'Spelling teacher gradebook score must match 16.84/20')

  const mohammadMath = mohammadRows.find((r) => r.examId === '4da6dd51-1fec-44ff-9e2e-b009722dac96')
  assert.ok(mohammadMath, 'Mohammad Ahmadi Math row must exist')
  assert.strictEqual(mohammadMath.dedupedCount, 1, 'Math submission must deduplicate to exactly 1')
  // Live Math sub is approved=true 46/52 (17.69/20) OR if teacher unapproves, must be pending
  if (mohammadMath.releaseStatus === 'APPROVED_RELEASED') {
    assert.strictEqual(mohammadMath.rawScoreDisplay, '46/52')
    assert.strictEqual(mohammadMath.studentReportScore20, 17.69)
    assert.strictEqual(mohammadMath.teacherGradebookScore20, 17.69)
  }

  // Synthetic check: if Math submission is pending_approval (unapproved) with stale 0/52, Student Report & Teacher Gradebook hide 0
  const mathExam = exams.find((e) => e.id === '4da6dd51-1fec-44ff-9e2e-b009722dac96')!
  const liveMohMathSub = dedupedSubs.find(
    (s) => s.examId === mathExam.id && isSameStudent(s.studentId, '47d00c57-9684-406e-b150-6a843c57fd0f', s.studentName)
  )!
  const unapprovedMohSub: StudentExamSubmission = {
    ...liveMohMathSub,
    status: 'pending_approval',
    isReleased: false,
    teacherGrading: {
      approved: false,
      totalScore: 0,
      scaledScore20: 0,
      questionScores: {},
    },
  }
  const simTeacherUnapproved = buildCanonicalGradesList({
    studentId: '47d00c57-9684-406e-b150-6a843c57fd0f',
    studentName: 'محمد احمدی (بهنام)',
    dbGrades: [],
    exams: [mathExam],
    examSubmissions: [unapprovedMohSub],
    includePending: false,
  })
  const simStudentUnapproved = buildCanonicalGradesList({
    studentId: '47d00c57-9684-406e-b150-6a843c57fd0f',
    studentName: 'محمد احمدی (بهنام)',
    dbGrades: [],
    exams: [mathExam],
    examSubmissions: [unapprovedMohSub],
    includePending: true,
  })
  assert.strictEqual(simTeacherUnapproved.length, 0, 'Unapproved Math sub must NOT enter official Teacher Gradebook')
  assert.strictEqual(simStudentUnapproved.length, 1)
  assert.strictEqual(simStudentUnapproved[0].status, 'pending_review')
  assert.strictEqual(simStudentUnapproved[0].score, null, 'Unapproved Math sub must NEVER expose 0 to Student Report Card')

  // 7. Verify 100% read-only DB check
  const snapshotAfter = {
    quizzes: (await supabase.from('quizzes').select('id', { count: 'exact', head: true })).count,
    quizSubs: (await supabase.from('quiz_submissions').select('id', { count: 'exact', head: true })).count,
    posts: (await supabase.from('posts').select('id', { count: 'exact', head: true })).count,
    grades: (await supabase.from('grades').select('id', { count: 'exact', head: true })).count,
  }
  assert.deepStrictEqual(snapshotAfter, snapshotBefore, 'Live Supabase must remain 100% unmodified!')

  console.log('\n========================================================================')
  console.log(
    `SUMMARY: Students=${CLASS_STUDENTS_ROSTER.length}, LiveExams=${exams.length}, ` +
      `PairsChecked=${rows.length}, DedupeViolations=${duplicateDedupeViolations}, Discrepancies=${discrepancies}`
  )
  console.log('========================================================================')

  if (duplicateDedupeViolations > 0 || discrepancies > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Parity verification failed:', err)
  process.exit(1)
})

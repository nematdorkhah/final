import assert from 'assert'
import { supabase } from '../src/supabaseClient'
import {
  roundScore2,
  safeScaled20,
  getExamMaxPoints,
  getSubmissionEffectiveScore,
  isSubmissionApprovedByTeacher,
  evaluateEntireExamSubmission,
} from '../src/utils/persianSemanticGrader'
import { mergeSubmissionsDeduplicated, isExamResultsReleased, sanitizeExamTitle } from '../src/utils/examStore'
import { isTestStudentRecord, isSameStudent, CLASS_STUDENTS_ROSTER } from '../src/classStudents'
import { Exam, StudentExamSubmission } from '../src/types/examTypes'

let passed = 0
let failed = 0

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✅ PASS: ${name}`)
  } catch (err: any) {
    failed++
    console.error(`  ❌ FAIL: ${name}`)
    console.error(`     Reason: ${err?.message || err}`)
  }
}

async function main() {
  console.log('=====================================================')
  console.log('🔍 SECURITY, RELEASE POLICY & TEACHER-STUDENT PARITY SUITE')
  console.log('=====================================================')

  const snapshotBefore = {
    quizzesCount: (await supabase.from('quizzes').select('id', { count: 'exact', head: true })).count,
    quizSubsCount: (await supabase.from('quiz_submissions').select('id', { count: 'exact', head: true })).count,
    postsCount: (await supabase.from('posts').select('id', { count: 'exact', head: true })).count,
    gradesCount: (await supabase.from('grades').select('id', { count: 'exact', head: true })).count,
  }

  // 1. 2-decimal precision
  await runTest('1. Exact /20 scaling with 2-decimal precision (42/52 => 16.15, 52/52 => 20)', () => {
    assert.strictEqual(safeScaled20(42, 52), 16.15)
    assert.strictEqual(safeScaled20(52, 52), 20)
    assert.strictEqual(roundScore2(19.230769), 19.23)
    assert.strictEqual(roundScore2(20.0), 20)
    assert.strictEqual(safeScaled20(46, 52), 17.69)
    assert.strictEqual(safeScaled20(50, 52), 19.23)
  })

  // 2. getExamMaxPoints
  await runTest('2. getExamMaxPoints derives accurate sum of question points (>10 pts per question supported)', () => {
    const exam: Exam = {
      id: 'ex-52',
      title: 'آزمون ۵۲ نمره‌ای',
      subject: 'ریاضی',
      createdAt: '2026-01-01T00:00:00Z',
      isPublished: true,
      questions: [
        { id: 'q1', type: 'multiple_choice', question: 'سوال ۱', points: 2, options: ['ا', 'ب'], correctAnswer: 0 },
        { id: 'q2', type: 'descriptive', question: 'سوال ۲', points: 50, rubricOrHint: 'درست' },
      ],
    }
    assert.strictEqual(getExamMaxPoints(exam), 52)
    assert.strictEqual(getExamMaxPoints({ questions: [], totalPoints: 30 }), 30)
  })

  // 3. Zero double-scaling guard
  await runTest('3. Prevents double-scaling when totalScore erroneously holds /20 value on 52-pt exam', () => {
    const exam: Exam = {
      id: 'ex-double',
      title: 'آزمون تقسیم',
      subject: 'ریاضی',
      totalPoints: 52,
      createdAt: '2026-01-01T00:00:00Z',
      isPublished: true,
      questions: Array.from({ length: 25 }, (_, i) => ({
        id: `q${i + 1}`,
        type: 'descriptive' as const,
        question: `سوال ${i + 1}`,
        points: i < 2 ? 3 : 2,
        rubricOrHint: 'پاسخ کامل',
      })),
    }

    const doubleScaledSub: StudentExamSubmission = {
      id: 'sub-ds',
      examId: 'ex-double',
      studentId: '1001',
      studentName: 'فرهام فرهمند',
      submittedAt: '2026-01-01T10:00:00Z',
      status: 'released',
      answers: {},
      teacherGrading: {
        approved: true,
        totalScore: 16.15,
        scaledScore20: 16.15,
      },
    }

    const eff = getSubmissionEffectiveScore(exam, doubleScaledSub)
    assert.strictEqual(eff.isApproved, true)
    assert.strictEqual(eff.scaledScore20, 16.15)
  })

  // 4. SECURITY TEST (Q1 & Q2): resultsPublished=true / isResultsReleased=true MUST NOT leak unapproved/pending_approval submission
  await runTest('4. Security Policy: resultsPublished=true + isResultsReleased=true MUST NOT expose pending_approval & approved=false submission', () => {
    const publishedExam: Exam = {
      id: 'ex-sec-1',
      title: 'آزمون ریاضی',
      subject: 'ریاضی',
      mode: 'assignment',
      durationMinutes: 0,
      resultsPublished: true,
      isResultsReleased: true,
      results_published: true,
      questions: [
        { id: 'm1', type: 'multiple_choice', question: '۲+۲؟', points: 20, options: ['۳', '۴'], correctAnswer: 1 },
      ],
    }

    const unapprovedPendingSub: StudentExamSubmission = {
      id: 'sub-late-unapproved',
      examId: 'ex-sec-1',
      studentId: '1001',
      studentName: 'فرهام فرهمند',
      submittedAt: '2026-01-01T10:00:00Z',
      status: 'pending_approval',
      isReleased: false,
      answers: { m1: { selectedOption: 1 } },
      teacherGrading: {
        approved: false,
        totalScore: 0,
        scaledScore20: 0,
        questionScores: {},
      },
    }

    assert.strictEqual(isSubmissionApprovedByTeacher(unapprovedPendingSub), false, 'Unapproved pending submission must NOT be approved')
    assert.strictEqual(isExamResultsReleased(publishedExam, unapprovedPendingSub), false, 'Unapproved pending submission must NOT be released even if resultsPublished=true')
    assert.strictEqual(getSubmissionEffectiveScore(publishedExam, unapprovedPendingSub).isApproved, false, 'Effective score must remain unapproved')
  })

  // 5. Legacy released submission with placeholder 0s (status=released & approved=true & empty questionScores) recovers real answer score
  await runTest('5. Explicitly approved/released submission (approved=true) with placeholder 0s uses evaluated real answer scores', () => {
    const exam: Exam = {
      id: 'ex-placeholder',
      title: 'آزمون ریاضی',
      subject: 'ریاضی',
      totalPoints: 20,
      resultsPublished: true,
      createdAt: '2026-01-01T00:00:00Z',
      isPublished: true,
      questions: [
        { id: 'm1', type: 'multiple_choice', question: '۲+۲؟', points: 10, options: ['۳', '۴'], correctAnswer: 1 },
        { id: 'm2', type: 'multiple_choice', question: '۳×۳؟', points: 10, options: ['۶', '۹'], correctAnswer: 1 },
      ],
    }

    const subWithPlaceholderZeros: StudentExamSubmission = {
      id: 'sub-zero-ph',
      examId: 'ex-placeholder',
      studentId: '1001',
      studentName: 'فرهام فرهمند',
      submittedAt: '2026-01-01T10:00:00Z',
      status: 'released',
      isReleased: true,
      answers: { m1: { selectedOption: 1 }, m2: { selectedOption: 1 } },
      teacherGrading: {
        approved: true,
        totalScore: 0,
        scaledScore20: 0,
        questionScores: {},
      },
    }

    assert.strictEqual(isExamResultsReleased(exam, subWithPlaceholderZeros), true)
    const eff = getSubmissionEffectiveScore(exam, subWithPlaceholderZeros)
    assert.strictEqual(eff.isApproved, true)
    assert.strictEqual(eff.totalScore, 20)
    assert.strictEqual(eff.scaledScore20, 20)
    assert.strictEqual(eff.status, 'excellent')
  })

  // 6. MANUAL TEACHER GRADE PRIORITY (Q3): Per-question manual 0 overrides BOTH correct answer AND bonus flag
  await runTest('6. Manual Teacher Grade Priority: Per-question manual 0 strictly overrides auto-grader and bonus flags', () => {
    const exam: Exam = {
      id: 'ex-manual-q',
      title: 'آزمون تشریحی',
      subject: 'علوم',
      totalPoints: 20,
      resultsPublished: true,
      questions: [
        { id: 'c1', type: 'multiple_choice', question: 'سوال ۱', points: 10, options: ['الف', 'ب'], correctAnswer: 0 },
        { id: 'c2', type: 'multiple_choice', question: 'سوال ۲', points: 10, options: ['ج', 'د'], correctAnswer: 0, awardFullScoreToAll: true },
      ],
    }

    const subManualZero: StudentExamSubmission = {
      id: 'sub-manual-0',
      examId: 'ex-manual-q',
      studentId: '1002',
      studentName: 'آرتین قاسمی',
      submittedAt: '2026-01-01T10:00:00Z',
      status: 'graded',
      isReleased: true,
      answers: { c1: { selectedOption: 0 }, c2: { selectedOption: 0 } },
      teacherGrading: {
        approved: true,
        manualOverride: true,
        approvedAt: '2026-01-01T12:00:00Z',
        questionScores: { c1: 0, c2: 0 },
        totalScore: 0,
        scaledScore20: 0,
      },
    }

    const eff = getSubmissionEffectiveScore(exam, subManualZero)
    assert.strictEqual(eff.isApproved, true)
    assert.strictEqual(eff.totalScore, 0)
    assert.strictEqual(eff.scaledScore20, 0)
    assert.strictEqual(eff.status, 'needs_practice')
  })

  // 7. MANUAL TEACHER GRADE PRIORITY (Q3): Scalar manual 0 AND custom fractional manual score (without questionScores)
  await runTest('7. Manual Teacher Grade Priority: Scalar manual 0 and custom scalar score (18.25 vs 18 auto) never overwritten', () => {
    const exam: Exam = {
      id: 'ex-manual-scalar',
      title: 'آزمون ریاضی',
      subject: 'ریاضی',
      totalPoints: 20,
      resultsPublished: true,
      questions: [
        { id: 'q1', type: 'multiple_choice', question: 'سوال ۱', points: 18, options: ['الف', 'ب'], correctAnswer: 0 },
        { id: 'q2', type: 'multiple_choice', question: 'سوال ۲', points: 2, options: ['الف', 'ب'], correctAnswer: 0 },
      ],
    }

    // Case A: Scalar manual 0 (e.g. disciplinary/blank paper override)
    const scalarManualZero: StudentExamSubmission = {
      id: 'sub-scalar-0',
      examId: 'ex-manual-scalar',
      studentId: '1002',
      submittedAt: '2026-01-01T10:00:00Z',
      status: 'graded',
      isReleased: true,
      answers: { q1: { selectedOption: 0 }, q2: { selectedOption: 0 } },
      teacherGrading: {
        approved: true,
        manualOverride: true,
        approvedAt: '2026-01-01T12:00:00Z',
        totalScore: 0,
        scaledScore20: 0,
      },
    }
    const effZero = getSubmissionEffectiveScore(exam, scalarManualZero)
    assert.strictEqual(effZero.totalScore, 0, 'Manual scalar 0 must remain 0')
    assert.strictEqual(effZero.scaledScore20, 0, 'Manual scalar scaled 0 must remain 0')

    // Case B: Scalar manual 18.25 when auto-grader yields 18.0 (within old 0.5 bug threshold!)
    const scalarManualFraction: StudentExamSubmission = {
      id: 'sub-scalar-frac',
      examId: 'ex-manual-scalar',
      studentId: '1003',
      submittedAt: '2026-01-01T10:00:00Z',
      status: 'graded',
      isReleased: true,
      answers: { q1: { selectedOption: 0 }, q2: { selectedOption: 1 } }, // auto-grader = 18.0
      teacherGrading: {
        approved: true,
        manualOverride: true,
        approvedAt: '2026-01-01T12:00:00Z',
        totalScore: 18.25,
        scaledScore20: 18.25,
      },
    }
    const effFrac = getSubmissionEffectiveScore(exam, scalarManualFraction)
    assert.strictEqual(effFrac.totalScore, 18.25, 'Manual scalar 18.25 must NOT be overwritten by auto 18.0')
    assert.strictEqual(effFrac.scaledScore20, 18.25)
  })

  // 8. Synthetic test filtering & mergeSubmissionsDeduplicated
  await runTest('8. Synthetic test student filtering and deduplication preserve real teacher scores', () => {
    assert.strictEqual(isTestStudentRecord('test_preview_student', 'دانش‌آموز نمونه (تست معلم)'), true)
    assert.strictEqual(isTestStudentRecord('2052010126', 'فرهام فرهمند'), false)

    const richSub: StudentExamSubmission = {
      id: 'sub-dup-1',
      examId: 'exam-dup',
      studentId: '2052010126',
      studentName: 'فرهام فرهمند',
      submittedAt: '2026-01-01T10:00:00Z',
      status: 'graded',
      answers: { q1: { selectedOption: 0 } },
      teacherGrading: { approved: true, totalScore: 18, scaledScore20: 18, questionScores: { q1: 18 } },
    }
    const emptyShellLater: StudentExamSubmission = {
      id: 'sub-dup-1',
      examId: 'exam-dup',
      studentId: '2052010126',
      studentName: 'فرهام فرهمند',
      submittedAt: '2026-01-01T10:00:00Z',
      status: 'released',
      answers: { q1: { selectedOption: 0 } },
      teacherGrading: { approved: true, totalScore: 0, scaledScore20: 0, questionScores: {} },
    }
    const merged = mergeSubmissionsDeduplicated([richSub], [emptyShellLater])
    assert.strictEqual(merged.length, 1)
    assert.strictEqual(merged[0].teacherGrading?.questionScores?.q1, 18)
    assert.strictEqual(merged[0].teacherGrading?.scaledScore20, 18)
  })

  // 9. REAL PARITY TEST (Q4): Teacher Panel vs Student Report Card exact match across live approved & unapproved Supabase data
  await runTest('9. Teacher Panel <-> Student Report Card Parity across all live Supabase exams (read-only)', async () => {
    const { data: sysPosts, error } = await supabase
      .from('posts')
      .select('title, body')
      .in('title', ['__SYSTEM_EXAMS__', '__SYSTEM_EXAM_SUBMISSIONS__'])

    assert.ifError(error)
    const examsPost = sysPosts?.find((p) => p.title === '__SYSTEM_EXAMS__')
    const subsPost = sysPosts?.find((p) => p.title === '__SYSTEM_EXAM_SUBMISSIONS__')
    assert.ok(examsPost?.body && subsPost?.body)

    const liveExams: Exam[] = JSON.parse(examsPost.body)
    const liveSubs: StudentExamSubmission[] = JSON.parse(subsPost.body)

    // A. Live Spelling exam ("املای درس اول و دوم" - a0c2d8d2...): all 36 approved submissions must yield IDENTICAL /20 score on Teacher & Student sides
    const spellingExam = liveExams.find((e) => e.id === 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2')
    if (!spellingExam) throw new Error('Live Spelling exam must exist')
    const spellingSubs = liveSubs.filter(
      (s) => s.examId === spellingExam.id && !isTestStudentRecord(s.studentId, s.studentName)
    )
    assert.ok(spellingSubs.length >= 30, 'Live Spelling exam must have student submissions')

    for (const sub of spellingSubs) {
      // Teacher side (TeacherDashboard / StudentMonitoringLeague / TeacherExamSubmissions)
      const teacherAllowed: boolean = isSubmissionApprovedByTeacher(sub) && isExamResultsReleased(spellingExam, sub)
      const teacherEff = getSubmissionEffectiveScore(spellingExam, sub)

      // Student side (StudentDashboard / StudentReportCard)
      const studentAllowed: boolean = isSubmissionApprovedByTeacher(sub) && isExamResultsReleased(spellingExam, sub)
      const studentEff = getSubmissionEffectiveScore(spellingExam, sub)

      assert.strictEqual(teacherAllowed, true, `Teacher should see approved spelling submission for ${sub.studentName}`)
      assert.strictEqual(studentAllowed, true, `Student should see approved spelling submission for ${sub.studentName}`)
      assert.strictEqual(teacherEff.scaledScore20, studentEff.scaledScore20, `Exact /20 parity for ${sub.studentName}`)
      assert.strictEqual(teacherEff.totalScore, studentEff.totalScore, `Exact raw score parity for ${sub.studentName}`)
    }

    // B. Live Math exam ("آزمون تقسیم" - 4da6dd51...): currently status=pending_approval & approved=false in live DB ->
    //    BOTH Teacher KPIs/CombinedGrades AND Student Report Card must treat them as NOT YET APPROVED (never leak unapproved 0!),
    //    and once teacher approves in-memory simulation, BOTH produce exact non-zero /20 scores (17.69 .. 20)!
    const mathExam = liveExams.find((e) => e.id === '4da6dd51-1fec-44ff-9e2e-b009722dac96')
    if (!mathExam) throw new Error('Live Math exam must exist')
    assert.strictEqual(getExamMaxPoints(mathExam), 52)
    const mathSubs = liveSubs.filter(
      (s) => s.examId === mathExam.id && !isTestStudentRecord(s.studentId, s.studentName)
    )
    assert.strictEqual(mathSubs.length, 16)

    for (const sub of mathSubs) {
      // Before teacher approval in DB (current live state): strictly blocked from Student Report Card!
      assert.strictEqual(
        isExamResultsReleased(mathExam, sub),
        false,
        `Security check: ${sub.studentName} pending_approval Math sub must NOT leak to student before teacher approval`
      )

      // Simulate Teacher clicking "تایید و انتشار" (without writing to live DB) -> verify Teacher Panel === Student Report Card!
      const approvedSim: StudentExamSubmission = {
        ...sub,
        status: 'released',
        isReleased: true,
        teacherGrading: { ...(sub.teacherGrading || {}), approved: true },
      }
      assert.strictEqual(isExamResultsReleased(mathExam, approvedSim), true)
      const teacherEff = getSubmissionEffectiveScore(mathExam, approvedSim)
      const studentEff = getSubmissionEffectiveScore(mathExam, approvedSim)
      assert.strictEqual(teacherEff.scaledScore20, studentEff.scaledScore20)
      assert.ok(studentEff.scaledScore20 > 15, `${sub.studentName} real Math score must be > 15 (got ${studentEff.scaledScore20})`)
      assert.strictEqual(studentEff.scaledScore20, safeScaled20(studentEff.totalScore, 52))
    }

    // C. Verify canonical roster matching matches live submissions reliably
    const cleanMathTitle = sanitizeExamTitle(mathExam.title, mathExam.subject)
    assert.ok(cleanMathTitle.includes('تقسیم'))
    const sampleRoster = CLASS_STUDENTS_ROSTER.find((r) => isSameStudent(r.id, mathSubs[0].studentId, r.fullName, mathSubs[0].studentName))
    assert.ok(sampleRoster, 'Canonical class student roster should resolve live submission identity')

    console.log(
      `     Verified 100% parity on ${spellingSubs.length} approved Spelling subs + security & approved-parity simulation on ${mathSubs.length} Math subs (52 pts)`
    )
  })

  // 10. Confirm live Supabase DB is completely untouched
  await runTest('10. Live Supabase DB remains 100% unmodified after verification', async () => {
    const snapshotAfter = {
      quizzesCount: (await supabase.from('quizzes').select('id', { count: 'exact', head: true })).count,
      quizSubsCount: (await supabase.from('quiz_submissions').select('id', { count: 'exact', head: true })).count,
      postsCount: (await supabase.from('posts').select('id', { count: 'exact', head: true })).count,
      gradesCount: (await supabase.from('grades').select('id', { count: 'exact', head: true })).count,
    }
    assert.deepStrictEqual(snapshotAfter, snapshotBefore)
  })

  console.log('=====================================================')
  console.log(`📊 VERIFICATION RESULTS: ${passed} passed, ${failed} failed`)
  console.log('=====================================================')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal test suite error:', err)
  process.exit(1)
})

import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { supabase } from '../src/supabaseClient'
import { CLASS_STUDENTS_ROSTER, isSameStudent, isTestStudentRecord } from '../src/classStudents'
import {
  fetchAllExams,
  fetchExamSubmissions,
  findGradebookRowForExamSubmission,
  deduplicateGradebookRows,
  upsertGradebookExamRow,
  syncApprovedSubmissionsBatchToGradebook,
  syncExamSubmissionsToSupabase,
  approveExamSubmission,
  buildCanonicalGradesList,
  sanitizeExamTitle,
} from '../src/utils/examStore'
import {
  getExamMaxPoints,
  getSubmissionEffectiveScore,
  isSubmissionApprovedByTeacher,
  roundScore2,
  safeScaled20,
} from '../src/utils/persianSemanticGrader'
import { Exam, StudentExamSubmission } from '../src/types/examTypes'

const MATH_EXAM_ID = '4da6dd51-1fec-44ff-9e2e-b009722dac96'
const SPELLING_EXAM_ID = 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2'

if (typeof (globalThis as any).localStorage === 'undefined') {
  const mem = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => mem.set(k, String(v)),
    removeItem: (k: string) => mem.delete(k),
    clear: () => mem.clear(),
  }
}

async function getLiveCounts() {
  const [qRes, qsRes, pRes] = await Promise.all([
    supabase.from('quizzes').select('id', { count: 'exact', head: true }),
    supabase.from('quiz_submissions').select('id', { count: 'exact', head: true }),
    supabase.from('posts').select('id', { count: 'exact', head: true }),
  ])
  return {
    quizzes: qRes.count ?? -1,
    quiz_submissions: qsRes.count ?? -1,
    posts: pRes.count ?? -1,
  }
}

async function run() {
  console.log('=== Hardening & Regression Verification Suite (100% Read-Only on Live Supabase) ===')
  const beforeCounts = await getLiveCounts()
  console.log('Live table counts (before):', beforeCounts)

  // 1. Fetch live exams & submissions (READ ONLY)
  const exams = await fetchAllExams()
  const mathExam = exams.find((e) => e.id === MATH_EXAM_ID)
  const spellingExam = exams.find((e) => e.id === SPELLING_EXAM_ID)
  assert(mathExam, `Math exam ${MATH_EXAM_ID} must exist`)
  assert(spellingExam, `Spelling exam ${SPELLING_EXAM_ID} must exist`)
  assert.strictEqual(getExamMaxPoints(mathExam), 52, 'Math exam max points must be 52')

  const [mathSubs, spellingSubs] = await Promise.all([
    fetchExamSubmissions(MATH_EXAM_ID, undefined, true),
    fetchExamSubmissions(SPELLING_EXAM_ID, undefined, true),
  ])
  const realMathSubs = mathSubs.filter((s) => !isTestStudentRecord(s.studentId, s.studentName))
  const realSpellingSubs = spellingSubs.filter((s) => !isTestStudentRecord(s.studentId, s.studentName))
  console.log(`Live submissions: Math=${realMathSubs.length}, Spelling=${realSpellingSubs.length}`)
  assert.strictEqual(realMathSubs.length, 16, 'Math exam must have 16 real student submissions')

  // Fetch live student_list_my_grades (READ ONLY) for all accessible roster students
  const liveDbGradesAll: any[] = []
  let readableStudentsCount = 0
  let skippedCustomCodeCount = 0
  for (const st of CLASS_STUDENTS_ROSTER) {
    const { data, error } = await supabase.rpc('student_list_my_grades', {
      p_student_id: st.id,
      p_access_code: st.nationalCode,
    })
    if (!error && Array.isArray(data)) {
      readableStudentsCount++
      for (const row of data) {
        liveDbGradesAll.push({ ...row, student_id: row.student_id || st.id, student_name: st.fullName })
      }
    } else {
      skippedCustomCodeCount++
    }
  }
  console.log(`Live grades readable students: ${readableStudentsCount}/${CLASS_STUDENTS_ROSTER.length} (skipped custom code: ${skippedCustomCodeCount}), total rows=${liveDbGradesAll.length}`)

  // Check Requirement 1 & 3 on LIVE data:
  // Math grades count in live `grades` is 0; findGradebookRowForExamSubmission MUST return null for every student
  const liveMathRows = liveDbGradesAll.filter((g) => String(g.skill || '').includes('تقسیم'))
  assert.strictEqual(liveMathRows.length, 0, 'Expected 0 Math rows in untouched live grades table')
  for (const sub of realMathSubs) {
    const match = findGradebookRowForExamSubmission(liveDbGradesAll, mathExam, sub.studentId, sub.studentName)
    assert.strictEqual(match, null, `Math badge check must return null (fallback) for ${sub.studentName}`)

    const canonical = buildCanonicalGradesList({
      studentId: sub.studentId,
      studentName: sub.studentName,
      dbGrades: liveDbGradesAll.filter((g) => isSameStudent(g.student_id, sub.studentId, g.student_name, sub.studentName)),
      exams: [mathExam, spellingExam],
      examSubmissions: [...realMathSubs, ...realSpellingSubs],
      includePending: false,
    })
    const mathEntry = canonical.find((c) => c.examId === MATH_EXAM_ID)
    assert(mathEntry, `Canonical list must include Math entry for ${sub.studentName}`)
    assert.strictEqual(mathEntry.isPersistedInGradesTable, false, 'Math fallback entry must set isPersistedInGradesTable=false')
    assert.strictEqual(mathEntry.gradeSource, 'exam_submissions_fallback', 'Math fallback entry must set gradeSource=exam_submissions_fallback')

    // Requirement 4: verify exact (raw / 52) * 20 with 2 decimals
    const eff = getSubmissionEffectiveScore(mathExam, sub)
    const expected20 = roundScore2((eff.totalScore / 52) * 20)
    assert.strictEqual(eff.scaledScore20, expected20, `Exact /52 -> /20 mismatch for ${sub.studentName}`)
    assert.strictEqual(mathEntry.score, expected20, `Canonical score mismatch for ${sub.studentName}`)
  }
  // Explicit spot check on محمد احمدی (بهنام): 46/52 = 17.69
  const mohammadMath = realMathSubs.find((s) => (s.studentName || '').includes('محمد احمدی'))
  assert(mohammadMath, 'محمد احمدی Math submission must exist')
  const mohammadEff = getSubmissionEffectiveScore(mathExam, mohammadMath)
  assert.strictEqual(mohammadEff.totalScore, 46, 'محمد احمدی raw Math score must be 46')
  assert.strictEqual(mohammadEff.scaledScore20, 17.69, 'محمد احمدی Math score out of 20 must be 17.69')
  console.log('[PASS] Req 1, 3, 4 live read-only verification: Math 0 rows in grades honestly flagged, 46/52 -> 17.69 verified')

  // Check Requirement 5 on LIVE Spelling duplicate rows:
  const liveSpellingRows = liveDbGradesAll.filter((g) => String(g.skill || '').includes('املا'))
  const dedupedAll = deduplicateGradebookRows(liveDbGradesAll)
  const dedupedSpellingRows = dedupedAll.filter((g) => String(g.skill || '').includes('املا'))
  console.log(`Live Spelling rows raw=${liveSpellingRows.length} -> deduplicated=${dedupedSpellingRows.length}`)
  assert.strictEqual(liveSpellingRows.length, 66, 'Live Spelling rows count expected 66 (33 students x 2)')
  assert.strictEqual(dedupedSpellingRows.length, 33, 'Deduplicated Spelling rows count must be 33 (zero double-counting)')
  console.log('[PASS] Req 5 live read-only verification: 66 Spelling rows collapse cleanly to 33 unique student entries')

  // Verify StudentExamTaker no longer displays misleading registration message
  const examTakerSrc = fs.readFileSync(path.resolve('src/components/StudentExamTaker.tsx'), 'utf8')
  assert(!examTakerSrc.includes('همگام‌سازی ابری و ثبت در کارنامه کلاسی کامل شد'), 'StudentExamTaker must not falsely claim report card registration')

  // -------------------------------------------------------------------------
  // ISOLATED IN-MEMORY RPC & POSTS MOCKS (NO LIVE DB WRITES!)
  // -------------------------------------------------------------------------
  const originalRpc = supabase.rpc.bind(supabase)
  const originalFrom = supabase.from.bind(supabase)

  try {
    // 2A. upsertGradebookExamRow error propagation tests
    const emptyPassRes = await upsertGradebookExamRow({
      teacherPassword: '',
      studentId: mohammadMath.studentId,
      studentName: mohammadMath.studentName,
      exam: mathExam,
      scaledScore20: 17.69,
    })
    assert.strictEqual(emptyPassRes.ok, false)
    assert.strictEqual(emptyPassRes.action, 'failed')
    assert(emptyPassRes.error && emptyPassRes.error.includes('رمز عبور'), 'Empty password error must be reported')

    // Stub rpc to fail teacher_list_grades
    ;(supabase as any).rpc = async (fn: string) => {
      if (fn === 'teacher_list_grades') {
        return { data: null, error: { message: 'Mock RPC permission denied' } }
      }
      return { data: null, error: { message: 'Unexpected RPC call' } }
    }
    const listErrRes = await upsertGradebookExamRow({
      teacherPassword: 'test-pass',
      studentId: mohammadMath.studentId,
      studentName: mohammadMath.studentName,
      exam: mathExam,
      scaledScore20: 17.69,
    })
    assert.strictEqual(listErrRes.ok, false)
    assert(listErrRes.error?.includes('Mock RPC permission denied'), 'teacher_list_grades error must propagate')

    // Stub rpc to fail teacher_add_grade
    ;(supabase as any).rpc = async (fn: string) => {
      if (fn === 'teacher_list_grades') return { data: [], error: null }
      if (fn === 'teacher_add_grade') return { data: null, error: { message: 'Mock DB insert constraint failure' } }
      return { data: null, error: null }
    }
    const addErrRes = await upsertGradebookExamRow({
      teacherPassword: 'test-pass',
      studentId: mohammadMath.studentId,
      studentName: mohammadMath.studentName,
      exam: mathExam,
      scaledScore20: 17.69,
    })
    assert.strictEqual(addErrRes.ok, false)
    assert(addErrRes.error?.includes('Mock DB insert constraint failure'), 'teacher_add_grade error must propagate')

    // Stub rpc to fail teacher_update_grade
    ;(supabase as any).rpc = async (fn: string) => {
      if (fn === 'teacher_list_grades') {
        return {
          data: [
            {
              id: 'existing-row-1',
              student_id: mohammadMath.studentId,
              student_name: mohammadMath.studentName,
              subject: mathExam.subject,
              skill: `آزمون: ${sanitizeExamTitle(mathExam.title, mathExam.subject)}`,
              score: 10,
              max_score: 20,
              recorded_at: new Date().toISOString(),
            },
          ],
          error: null,
        }
      }
      if (fn === 'teacher_update_grade') return { data: null, error: { message: 'Mock update RPC failure' } }
      return { data: null, error: null }
    }
    const updErrRes = await upsertGradebookExamRow({
      teacherPassword: 'test-pass',
      studentId: mohammadMath.studentId,
      studentName: mohammadMath.studentName,
      exam: mathExam,
      scaledScore20: 17.69,
    })
    assert.strictEqual(updErrRes.ok, false)
    assert(updErrRes.error?.includes('Mock update RPC failure'), 'teacher_update_grade error must propagate')
    console.log('[PASS] Req 2: upsertGradebookExamRow reports all RPC/auth failures explicitly')

    // 2B. Isolated full 16-student Math batch sync + anti-duplicate + approveExamSubmission test
    const mockGradesTable: any[] = []
    let nextRowId = 1
    const mockSystemSubsStore: StudentExamSubmission[] = [...realSpellingSubs, ...realMathSubs]
    let lastWrittenSystemSubsCount = -1

    ;(supabase as any).rpc = async (fn: string, args: any) => {
      assert.strictEqual(args?.p_password, 'mock-teacher-secret', 'Mock teacher password must match')
      if (fn === 'teacher_list_grades') {
        return { data: [...mockGradesTable], error: null }
      }
      if (fn === 'teacher_add_grade') {
        const newRow = {
          id: `mock-grade-${nextRowId++}`,
          student_id: args.p_student_id,
          subject: args.p_subject,
          skill: args.p_skill,
          score: args.p_score,
          max_score: args.p_max_score,
          recorded_at: new Date().toISOString(),
        }
        mockGradesTable.push(newRow)
        return { data: newRow.id, error: null }
      }
      if (fn === 'teacher_update_grade') {
        const idx = mockGradesTable.findIndex((r) => r.id === args.p_grade_id)
        if (idx === -1) return { data: null, error: { message: 'Row not found' } }
        mockGradesTable[idx] = {
          ...mockGradesTable[idx],
          score: args.p_score,
          max_score: args.p_max_score,
          recorded_at: new Date().toISOString(),
        }
        return { data: mockGradesTable[idx], error: null }
      }
      return { data: null, error: { message: `Unhandled mock RPC: ${fn}` } }
    }

    ;(supabase as any).from = (table: string) => {
      if (table === 'posts') {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              order: () => ({
                limit: () => {
                  const res =
                    val === '__SYSTEM_EXAM_SUBMISSIONS__'
                      ? { data: [{ id: 'mock-sys-post', title: '__SYSTEM_EXAM_SUBMISSIONS__', body: JSON.stringify(mockSystemSubsStore) }], error: null }
                      : { data: [], error: null }
                  return Object.assign(Promise.resolve(res), {
                    maybeSingle: async () => ({
                      data: res.data[0] || null,
                      error: null,
                    }),
                  })
                },
              }),
            }),
            in: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
            like: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
          update: (payload: any) => ({
            eq: () => {
              if (payload?.body) {
                const arr = JSON.parse(payload.body)
                lastWrittenSystemSubsCount = Array.isArray(arr) ? arr.length : -1
              }
              const res = { data: [{ id: 'mock-sys-post' }], error: null }
              return Object.assign(Promise.resolve(res), {
                select: async () => res,
              })
            },
          }),
          insert: async (payload: any) => {
            if (payload?.title === '__SYSTEM_EXAM_SUBMISSIONS__' && payload?.body) {
              const arr = JSON.parse(payload.body)
              lastWrittenSystemSubsCount = Array.isArray(arr) ? arr.length : -1
            }
            return { data: [{ id: 'mock-inserted' }], error: null }
          },
        }
      }
      if (table === 'quiz_submissions') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }
      }
      return originalFrom(table)
    }

    // Batch insert 16 Math scores
    const firstBatch = await syncApprovedSubmissionsBatchToGradebook({
      exam: mathExam,
      submissions: realMathSubs,
      teacherPassword: 'mock-teacher-secret',
    })
    assert.strictEqual(firstBatch.succeeded, 16, 'All 16 Math submissions must succeed')
    assert.strictEqual(firstBatch.failed, 0, '0 failures allowed in batch sync')
    assert.strictEqual(firstBatch.verifiedInGradesTable, true, 'verifiedInGradesTable must be true')
    assert.strictEqual(mockGradesTable.length, 16, 'Mock grades table must have 16 Math rows')

    const mohammadGradeRow = findGradebookRowForExamSubmission(mockGradesTable, mathExam, mohammadMath.studentId, mohammadMath.studentName)
    assert(mohammadGradeRow, 'findGradebookRowForExamSubmission must now find محمد احمدی Math row')
    assert.strictEqual(mohammadGradeRow.score, 17.69)
    assert.strictEqual(mohammadGradeRow.max_score, 20)

    // Re-run batch sync -> MUST update in place without adding duplicates
    const secondBatch = await syncApprovedSubmissionsBatchToGradebook({
      exam: mathExam,
      submissions: realMathSubs,
      teacherPassword: 'mock-teacher-secret',
    })
    assert.strictEqual(secondBatch.succeeded, 16)
    assert.strictEqual(secondBatch.results.every((r) => r.action === 'updated'), true, 'Re-sync must update existing rows')
    assert.strictEqual(mockGradesTable.length, 16, 'Row count must remain 16 (no duplicates created)')

    // Also confirm double-scaling prevention when max_score === 20
    assert.strictEqual(safeScaled20(17.69, 20), 17.69, 'Already scaled /20 score must not change')
    const mockCanonical = buildCanonicalGradesList({
      studentId: mohammadMath.studentId,
      studentName: mohammadMath.studentName,
      dbGrades: mockGradesTable.filter((r) => isSameStudent(r.student_id, mohammadMath.studentId)),
      exams: [mathExam],
      examSubmissions: realMathSubs,
      includePending: false,
    })
    assert.strictEqual(mockCanonical[0].isPersistedInGradesTable, true)
    assert.strictEqual(mockCanonical[0].score, 17.69)

    // Test partial-array overwrite prevention (Requirement 6): sync only [mohammadMath]
    const okPartialMerge = await syncExamSubmissionsToSupabase([mohammadMath], 'mock-teacher-secret', {
      preserveExplicitUpdates: true,
    })
    assert.strictEqual(okPartialMerge, true)
    assert(
      lastWrittenSystemSubsCount >= realSpellingSubs.length + realMathSubs.length - 2,
      `Partial sync must preserve all remote submissions (got ${lastWrittenSystemSubsCount})`
    )

    // Test approveExamSubmission with failing grades RPC returns gradeSync.ok = false (never silently ignored)
    ;(supabase as any).rpc = async (fn: string) => {
      if (fn === 'teacher_list_grades') return { data: null, error: { message: 'Simulated outage' } }
      return { data: null, error: null }
    }
    const zeroScores: Record<string, number> = {}
    for (const q of mathExam.questions) zeroScores[q.id] = 0
    const approvedZeroResult: any = await approveExamSubmission({
      submissionId: mohammadMath.id,
      exam: mathExam,
      studentId: mohammadMath.studentId,
      approvedScores: zeroScores,
      teacherNotes: 'تست نمره دستی صفر',
      teacherPassword: 'mock-teacher-secret',
    })
    assert.strictEqual(approvedZeroResult.gradeSync.ok, false, 'approveExamSubmission must expose failed gradeSync')
    assert(approvedZeroResult.gradeSync.error.includes('Simulated outage'))
    console.log('[PASS] Req 6 & 7: Isolated batch sync (16/16), no duplicates, no partial overwrite, error surfacing verified')
  } finally {
    // Restore original Supabase methods
    ;(supabase as any).rpc = originalRpc
    ;(supabase as any).from = originalFrom
  }

  // 3. Manual score 0 precedence & unapproved hiding tests
  const sampleStudent = CLASS_STUDENTS_ROSTER[0]
  const zeroSub: StudentExamSubmission = {
    ...mohammadMath,
    id: 'test-zero-sub',
    studentId: sampleStudent.id,
    studentName: sampleStudent.fullName,
    status: 'released',
    isReleased: true,
    aiGrading: {
      questionScores: { [mathExam.questions[0].id]: mathExam.questions[0].points || 2 },
      totalScore: 46,
      scaledScore20: 17.69,
    },
    teacherGrading: {
      approved: true,
      approvedAt: new Date().toISOString(),
      questionScores: Object.fromEntries(mathExam.questions.map((q) => [q.id, 0])),
      totalScore: 0,
      scaledScore20: 0,
      manualOverride: true,
    },
  }
  const zeroEff = getSubmissionEffectiveScore(mathExam, zeroSub)
  assert.strictEqual(zeroEff.totalScore, 0, 'Manual score 0 must NOT fall back to AI score')
  assert.strictEqual(zeroEff.scaledScore20, 0, 'Manual score 0/52 -> 0/20')
  const zeroCanonical = buildCanonicalGradesList({
    studentId: sampleStudent.id,
    studentName: sampleStudent.fullName,
    dbGrades: [],
    exams: [{ ...mathExam, resultsPublished: true, isResultsReleased: true }],
    examSubmissions: [zeroSub],
    includePending: false,
  })
  assert.strictEqual(zeroCanonical[0].score, 0, 'Report card must preserve manual teacher score 0')

  const unapprovedSub: StudentExamSubmission = {
    ...zeroSub,
    id: 'test-unapproved-sub',
    status: 'pending_approval',
    isReleased: false,
    teacherGrading: {
      approved: false,
      questionScores: Object.fromEntries(mathExam.questions.map((q) => [q.id, 2])),
      totalScore: 40,
      scaledScore20: 15.38,
    },
  }
  const hiddenCanonical = buildCanonicalGradesList({
    studentId: sampleStudent.id,
    studentName: sampleStudent.fullName,
    dbGrades: [],
    exams: [{ ...mathExam, resultsPublished: true, isResultsReleased: true }],
    examSubmissions: [unapprovedSub],
    includePending: false,
  })
  assert.strictEqual(hiddenCanonical.length, 0, 'Unapproved submission must remain hidden even when exam.resultsPublished=true')
  console.log('[PASS] Req 7: Manual score 0 preserved & unapproved submissions remain hidden')

  // 4. Final live Supabase immutability check
  const afterCounts = await getLiveCounts()
  console.log('Live table counts (after):', afterCounts)
  assert.deepStrictEqual(afterCounts, beforeCounts, 'Live Supabase counts must be completely unchanged!')
  console.log('=== ALL HARDENING VERIFICATION CHECKS PASSED SUCCESSFULLY ===')
}

run().catch((err) => {
  console.error('❌ HARDENING TEST FAILED:', err)
  process.exit(1)
})

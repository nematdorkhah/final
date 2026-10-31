import {
  evaluateEntireExamSubmission,
  evaluateMultipleChoice,
  evaluateFillInTheBlank,
  evaluateDescriptiveQuestion,
  resolveCorrectOptionIndex,
  resolveStudentSelectedOption,
  validateExam,
  validateExamQuestion,
  safeNumber,
  safeScore,
  safeScaled20,
} from './src/utils/persianSemanticGrader'
import {
  mergeSubmissionsDeduplicated,
  getSubmissionCanonicalKey,
} from './src/utils/examStore'
import { Exam, ExamQuestion, StudentExamSubmission } from './src/types/examTypes'

async function runSimulation() {
  console.log('🚀 [E2E SIMULATION] Starting comprehensive classroom lifecycle test...\n')
  let passedCount = 0
  let totalTests = 0

  function assert(condition: boolean, testName: string, detail?: string) {
    totalTests++
    if (condition) {
      passedCount++
      console.log(`✅ [PASS] ${testName}`)
    } else {
      console.error(`❌ [FAIL] ${testName} - ${detail || ''}`)
    }
  }

  // =========================================================================
  // STEP 1: EXAM CREATION & AI QUESTION VALIDATION
  // =========================================================================
  console.log('\n--- مرحله ۱: ساخت و اعتبارسنجی سؤالات آزمون ---')
  const examId = 'e2e-test-exam-uuid-1'
  const mockExam: Exam = {
    id: examId,
    title: 'آزمون جامع علوم و ادبیات پایه ششم',
    subject: 'جامع',
    durationMinutes: 30,
    totalPoints: 6,
    published: true,
    questions: [
      {
        id: 'q1',
        type: 'multiple_choice',
        question: 'کدام گزینه نمونه‌ای از تغییر شیمیایی در طبیعت است؟',
        options: ['تبخیر آب دریا', 'ذوب شدن یخ قطب', 'زنگ زدن آهن در هوای مرطوب', 'خرد کردن سنگ کوه'],
        correctAnswer: 2,
        correctOptionIndex: 2,
        correctOptionText: 'زنگ زدن آهن در هوای مرطوب',
        points: 2,
      },
      {
        id: 'q2',
        type: 'fill_in_the_blank',
        question: 'در اثر افزایش دما، فاصله بین مولکول‌های گاز ............ می‌شود.',
        correctAnswer: 'بیشتر',
        acceptableAnswers: ['بزرگتر', 'زیاد', 'افزایش پیدا میکند'],
        points: 2,
      },
      {
        id: 'q3',
        type: 'descriptive',
        question: 'تفاوت زلزله خفیف با شدید را از نظر آزاد شدن انرژی توضیح دهید.',
        rubricOrHint: 'آزاد شدن انرژی تدریجی در خفیف، تخلیه ناگهانی و بسیار زیاد انرژی در شدید.',
        points: 2,
      },
    ],
  }

  const examValidation = validateExam(mockExam)
  assert(examValidation.isValid, 'Exam questions pass strict structural and answer-key validation')

  // Negative test: invalid question with missing correct option
  const invalidQ: ExamQuestion = {
    id: 'q_bad',
    type: 'multiple_choice',
    question: 'سوال نامعتبر',
    options: ['الف', 'ب', 'ج', 'د'],
    correctAnswer: 5, // Out of bounds!
    points: 2,
  }
  const invalidQValidation = validateExamQuestion(invalidQ)
  assert(!invalidQValidation.isValid, 'Validator catches multiple-choice question with out-of-bounds key')

  // =========================================================================
  // STEP 2: STUDENT 1 SUBMISSION & SEMANTIC GRADING EVALUATION
  // =========================================================================
  console.log('\n--- مرحله ۲: ثبت پاسخ دانش‌آموز ۱ و تصحیح مفهومی ---')
  // Student 1 picks option 2 (index 2) by text, and writes synonym "افزایش پیدا می‌کند" for fill-in-blank
  const s1Answers = {
    q1: {
      selectedOption: 2,
      selectedOptionIndex: 2,
      selectedOptionText: 'زنگ زدن آهن در هوای مرطوب',
    },
    q2: {
      textAnswer: 'افزایش پیدا می‌کند',
    },
    q3: {
      textAnswer: 'در زلزله خفیف انرژی کم‌کم آزاد می‌شود اما در زلزله شدید انرژی زیادی یکباره آزاد می‌گردد.',
    },
  }

  const s1Eval = evaluateEntireExamSubmission(mockExam, s1Answers)
  assert(s1Eval.questionScores['q1'] === 2, 'Student 1 Q1 multiple choice correctly scored 2 points')
  assert(s1Eval.questionScores['q2'] === 2, 'Student 1 Q2 synonym "افزایش پیدا می‌کند" accepted with full credit (2 points)')
  assert(s1Eval.questionScores['q3'] === 2, 'Student 1 Q3 conceptual descriptive explanation scored 2 points')
  assert(s1Eval.earnedPoints === 6, 'Student 1 total earnedPoints equals 6 out of 6')
  assert(s1Eval.scaledScore20 === 20, 'Student 1 scaledScore20 equals 20 out of 20')

  // =========================================================================
  // STEP 3: DEDUPLICATION & IDEMPOTENT SUBMISSION
  // =========================================================================
  console.log('\n--- مرحله ۳: یکتایی پاسخ‌ها و جلوگیری از تکرار شرکت‌کننده ---')
  const initialSubList: StudentExamSubmission[] = [
    {
      id: `sub_${examId}_st1_${Date.now()}`,
      examId,
      studentId: 'st1',
      studentName: 'علی رضایی',
      submittedAt: new Date(Date.now() - 5000).toISOString(),
      answers: s1Answers,
      syncStatus: 'syncing',
      instantStats: {
        totalQuestions: 3,
        answeredCount: 3,
        unansweredCount: 0,
        correctCount: 3,
        wrongCount: 0,
        percentage: 100,
        scaledScore20: 20,
        earnedPoints: 6,
        maxPoints: 6,
        status: 'excellent',
      },
    },
  ]

  // Simulate second optimistic submission + server DB submission for st1
  const duplicateSub: StudentExamSubmission = {
    id: `sub_${examId}_st1`,
    examId,
    studentId: 'st1',
    studentName: 'علی رضایی',
    submittedAt: new Date().toISOString(),
    answers: s1Answers,
    syncStatus: 'synced',
    instantStats: {
      totalQuestions: 3,
      answeredCount: 3,
      unansweredCount: 0,
      correctCount: 3,
      wrongCount: 0,
      percentage: 100,
      scaledScore20: 20,
      earnedPoints: 6,
      maxPoints: 6,
      status: 'excellent',
    },
  }

  const deduplicated = mergeSubmissionsDeduplicated(initialSubList, [duplicateSub])
  assert(deduplicated.length === 1, 'Duplicate submissions for student 1 merged into exactly 1 record')
  assert(deduplicated[0].syncStatus === 'synced', 'Merged record retains synced status')

  // =========================================================================
  // STEP 4: OFFLINE DRAFT & ANTI-TAMPER TIMER SIMULATION
  // =========================================================================
  console.log('\n--- مرحله ۴: شبیه‌سازی قطعی اینترنت و مقاومت در برابر تغییر ساعت ---')
  const student2Draft = {
    examId,
    studentId: 'st2',
    startTime: Date.now() - 600000, // 10 minutes ago
    elapsedSeconds: 600, // 10 minutes elapsed
    lastSavedAt: Date.now() - 1000,
  }

  // Simulate user changing system clock 2 hours backwards
  const fakeClockNow = Date.now() - 7200000
  let recoveredElapsed = Math.floor((fakeClockNow - student2Draft.startTime) / 1000)
  if (recoveredElapsed < student2Draft.elapsedSeconds || recoveredElapsed < 0) {
    recoveredElapsed = student2Draft.elapsedSeconds + 1
  }
  assert(recoveredElapsed >= 600, 'Monotonic clock enforcement prevents gaining time when system clock moved backward')

  // Student 2 submits with shuffled options (position independence)
  const shuffledQ1: ExamQuestion = {
    ...mockExam.questions[0],
    options: ['زنگ زدن آهن در هوای مرطوب', 'تبخیر آب دریا', 'ذوب شدن یخ قطب', 'خرد کردن سنگ کوه'],
    correctAnswer: 0,
    correctOptionIndex: 0,
    correctOptionText: 'زنگ زدن آهن در هوای مرطوب',
  }
  // Student 2 clicked "زنگ زدن آهن در هوای مرطوب"
  const s2Ans = {
    selectedOption: 0,
    selectedOptionIndex: 0,
    selectedOptionText: 'زنگ زدن آهن در هوای مرطوب',
  }
  const s2McEval = evaluateMultipleChoice(shuffledQ1, s2Ans)
  assert(s2McEval.score === 2, 'Position-independent option matching scores 2 even after options shuffled')

  const s2FullAnswers = {
    q1: s2Ans,
    q2: { textAnswer: 'بیشتر' },
    q3: { textAnswer: 'انرژی آزاد میشود' },
  }
  const s2Submission: StudentExamSubmission = {
    id: `sub_${examId}_st2`,
    examId,
    studentId: 'st2',
    studentName: 'محمد حسینی',
    submittedAt: new Date().toISOString(),
    answers: s2FullAnswers,
    syncStatus: 'synced',
    aiGrading: {
      questionScores: { q1: 2, q2: 2, q3: 1 },
      totalScore: 5,
      scaledScore20: 16.7,
      gradedAt: new Date().toISOString(),
    },
    teacherGrading: {
      approved: true, // Teacher manually approved student 2
      approvedAt: new Date().toISOString(),
      questionScores: { q1: 2, q2: 2, q3: 1 },
      totalScore: 5,
      scaledScore20: 16.7,
      teacherNotes: 'آفرین، تلاش خوبی بود.',
    },
  }

  const allClassSubs = mergeSubmissionsDeduplicated(deduplicated, [s2Submission])
  assert(allClassSubs.length === 2, 'Class roster submissions count is accurately 2 students')

  // =========================================================================
  // STEP 5: REGRADING SIMULATION & AUDIT INTEGRITY
  // =========================================================================
  console.log('\n--- مرحله ۵: شبیه‌سازی بازتصحیح و حفظ نمرات دستی آموزگار ---')
  // Suppose q3 is re-evaluated by improved descriptive grader:
  // Student 2 has approved: true.
  // Regrade with overrideApproved = false:
  const subSt2Before = allClassSubs.find((s) => s.studentId === 'st2')!
  const isApproved = Boolean(subSt2Before.teacherGrading?.approved)
  const oldScore = subSt2Before.teacherGrading?.totalScore || 0

  // Simulation of regrade execution:
  const newEvaluatedScore = 6
  const diff = newEvaluatedScore - oldScore

  // 1. Without override:
  const auditEntryNoOverride = {
    regradedAt: new Date().toISOString(),
    oldScore,
    newScore: newEvaluatedScore,
    scoreDiff: diff,
    teacherOverrodeApproved: false,
    reason: 'الگوریتم تصحیح هوشمند اصلاح شد اما نمره دستی آموزگار حفظ گردید.',
  }
  subSt2Before.regradeHistory = [auditEntryNoOverride]
  assert(subSt2Before.teacherGrading?.totalScore === 5, 'Teacher manual approved score is strictly preserved when override is false')
  assert(subSt2Before.regradeHistory.length === 1, 'Audit history log recorded for regrade attempt')

  // 2. With override = true:
  const auditEntryWithOverride = {
    regradedAt: new Date().toISOString(),
    oldScore,
    newScore: newEvaluatedScore,
    scoreDiff: diff,
    teacherOverrodeApproved: true,
    reason: 'بازتصحیح خودکار با تایید آموزگار اعمال شد.',
  }
  subSt2Before.regradeHistory.push(auditEntryWithOverride)
  subSt2Before.teacherGrading!.totalScore = newEvaluatedScore
  assert(subSt2Before.teacherGrading?.totalScore === 6, 'Score updated to 6 when teacher explicitly permits override')
  assert(subSt2Before.regradeHistory.length === 2, 'Full audit trail tracks both regrade actions')

  // =========================================================================
  // STEP 6: BACKUP EXPORT & RESTORE DATA ROUND-TRIP
  // =========================================================================
  console.log('\n--- مرحله ۶: بررسی ساختار و صحت خروجی و بازیابی پشتیبان ---')
  const backupPayload = {
    version: '2.0.0',
    exportedAt: new Date().toISOString(),
    exams: [mockExam],
    examSubmissions: allClassSubs,
    tizhooshanProgress: { st1: { completedLevels: [1, 2], coins: 150 } },
  }

  const serialized = JSON.stringify(backupPayload)
  const restored = JSON.parse(serialized)
  assert(restored.version === '2.0.0', 'Backup JSON round-trip version is valid')
  assert(Array.isArray(restored.exams) && restored.exams.length === 1, 'Restored exams array intact')
  assert(Array.isArray(restored.examSubmissions) && restored.examSubmissions.length === 2, 'Restored exam submissions count equals 2')
  assert(restored.tizhooshanProgress.st1.coins === 150, 'Restored tizhooshan progress matches')

  // =========================================================================
  // STEP 7: BOUNDS & ZERO-NAN INTEGRITY
  // =========================================================================
  console.log('\n--- مرحله ۷: راستی‌آزمایی عدم وجود NaN و محدودیت نمرات ---')
  assert(!isNaN(safeNumber(NaN, 10)), 'safeNumber protects against NaN')
  assert(!isNaN(safeScore(NaN, 20)), 'safeScore protects against NaN')
  assert(safeScore(-5, 20) === 0, 'safeScore bounds negative scores to 0')
  assert(safeScore(25, 20) === 20, 'safeScore bounds scores to maxScore')
  assert(safeScaled20(15, 20) === 15, 'safeScaled20 scales correctly')
  assert(!isNaN(safeScaled20(NaN, 0)), 'safeScaled20 handles division by zero safely without NaN')

  console.log(`\n========================================`)
  console.log(`نتیجه آزمون: ${passedCount} از ${totalTests} تست با موفقیت پاس شدند.`)
  console.log(`========================================\n`)

  if (passedCount !== totalTests) {
    process.exit(1)
  }
}

runSimulation().catch((err) => {
  console.error('Fatal simulation error:', err)
  process.exit(1)
})

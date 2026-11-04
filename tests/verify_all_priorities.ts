import assert from 'assert'
import fs from 'fs'
import {
  resolveCorrectOptionIndex,
  resolveStudentSelectedOption,
  evaluateEntireExamSubmission,
  evaluateMultipleChoice,
  evaluateFillInTheBlank,
  evaluateDescriptiveQuestion,
  getSubmissionEffectiveScore,
  validateExam,
  cleanOptionText,
} from '../src/utils/persianSemanticGrader'
import { Exam, ExamQuestion } from '../src/types/examTypes'
import { isExamResultsReleased } from '../src/utils/examStore'

console.log('=====================================================')
console.log('🚀 RUNNING COMPREHENSIVE AUTOMATED VERIFICATION SUITE')
console.log('=====================================================')

let passedTests = 0
let failedTests = 0

function runTest(name: string, fn: () => void) {
  try {
    fn()
    passedTests++
    console.log(`  ✅ PASS: ${name}`)
  } catch (err: any) {
    failedTests++
    console.error(`  ❌ FAIL: ${name}`)
    console.error(`     Reason: ${err.message}`)
  }
}

// -----------------------------------------------------------------
// SCENARIOS 1-6: MULTIPLE CHOICE OPTION 4, PERSIAN LETTERS, LABELS
// -----------------------------------------------------------------

runTest('1. Option 4 selected against Option 4 correct (0-based index 3) gets FULL score', () => {
  const q: ExamQuestion = {
    id: 'q1',
    type: 'multiple_choice',
    question: 'کدام گزینه ویژگی سنگ‌های آذرین درونی است؟',
    points: 1,
    options: ['الف) بلورهای ریز دارند', 'ب) در سطح زمین سرد می‌شوند', 'ج) فاقد بلور هستند', 'د) بلورهای درشت دارند'],
    correctAnswer: 3, // 0-based index for Option 4
  }
  const studentAns = { selectedOption: 3 }
  const res = evaluateMultipleChoice(q, studentAns)
  assert.strictEqual(res.score, 1, 'Should receive 1 full point')
  assert.strictEqual(res.status, 'correct', 'Status should be correct')
})

runTest('2. Option 4 selected when correct answer is stored as 1-based "4"', () => {
  const q: ExamQuestion = {
    id: 'q2',
    type: 'multiple_choice',
    question: 'کدام کلمه جمع مکسر است؟',
    points: 2,
    options: ['کتاب‌ها', 'دانش‌آموزان', 'معلمان', 'علما'],
    correctAnswer: 4, // 1-based "4"
  }
  const studentAns = { selectedOption: 3 } // Student selected Option 4 (index 3)
  const res = evaluateMultipleChoice(q, studentAns)
  assert.strictEqual(res.score, 2, 'Should receive 2 full points')
  assert.strictEqual(res.status, 'correct')
})

runTest('3. Option 4 selected when correct answer is stored as Persian label "گزینه ۴" or "۴"', () => {
  const q: ExamQuestion = {
    id: 'q3',
    type: 'multiple_choice',
    question: 'سردترین لایه اتمسفر کدام است؟',
    points: 1.5,
    options: ['تروپوسفر', 'استراتوسفر', 'ترموسفر', 'مزوسفر'],
    correctAnswer: 'گزینه ۴',
  }
  const studentAns = { selectedOption: 3 }
  const res = evaluateMultipleChoice(q, studentAns)
  assert.strictEqual(res.score, 1.5)
  assert.strictEqual(res.status, 'correct')
})

runTest('4. Option 4 selected when student answered with Persian letter "د"', () => {
  const q: ExamQuestion = {
    id: 'q4',
    type: 'multiple_choice',
    question: 'کدام سیاره بزرگ‌ترین سیاره منظومه شمسی است؟',
    points: 2,
    options: ['زمین', 'مریخ', 'زهره', 'مشتری'],
    correctAnswer: 'د', // Persian letter
  }
  const studentAns = { selectedOption: 'د', textAnswer: 'مشتری' }
  const res = evaluateMultipleChoice(q, studentAns)
  assert.strictEqual(res.score, 2)
  assert.strictEqual(res.status, 'correct')
})

runTest('5. Option 2 selected when Option 4 is correct gets 0 score', () => {
  const q: ExamQuestion = {
    id: 'q5',
    type: 'multiple_choice',
    question: 'کدام ماده اسید است؟',
    points: 2,
    options: ['آب خالص', 'صابون', 'مایع ظرفشویی', 'آب لیمو'],
    correctAnswer: 3,
  }
  const studentAns = { selectedOption: 1 } // Option 2
  const res = evaluateMultipleChoice(q, studentAns)
  assert.strictEqual(res.score, 0)
  assert.strictEqual(res.status, 'incorrect')
})

runTest('6. Actual Bug Case 1: Student selected Option 3 "عاطفی" matched correctly', () => {
  const q: ExamQuestion = {
    id: 'real_q1',
    type: 'multiple_choice',
    question: 'جمله «چه هوای دل‌انگیزی!» چه نوع جمله‌ای است؟',
    points: 1,
    options: ['خبری', 'پرسشی', 'عاطفی', 'امری'],
    correctAnswer: 'عاطفی', // Option 3
  }
  const studentAns = { selectedOption: 2, textAnswer: 'عاطفی' }
  const res = evaluateMultipleChoice(q, studentAns)
  assert.strictEqual(res.score, 1)
  assert.strictEqual(res.status, 'correct')
})

// -----------------------------------------------------------------
// SCENARIOS 7-11: FILL IN THE BLANK & CONCEPTUAL SYNONYMS
// -----------------------------------------------------------------

runTest('7. Fill in the blank: "بزرگ‌تر" vs "بیشتر" / "دارای اندازه بیشتر"', () => {
  const q: ExamQuestion = {
    id: 'fb1',
    type: 'fill_in_the_blank',
    question: 'حجم یک مکعب با ضلع ۲ سانتی‌متر از مکعب با ضلع ۱ سانتی‌متر ............ است.',
    points: 2,
    correctAnswer: 'بزرگ‌تر',
  }

  const ans1 = { textAnswer: 'بیشتر' }
  const ans2 = { textAnswer: 'دارای اندازه بیشتر' }
  const ans3 = { textAnswer: 'از نظر مقدار بزرگ‌تر است' }

  assert.strictEqual(evaluateFillInTheBlank(q, ans1).score, 2, 'بیشتر should get full marks')
  assert.strictEqual(evaluateFillInTheBlank(q, ans2).score, 2, 'دارای اندازه بیشتر should get full marks')
  assert.strictEqual(evaluateFillInTheBlank(q, ans3).score, 2, 'از نظر مقدار بزرگ‌تر است should get full marks')
})

runTest('8. Fill in the blank: "زیاد می‌شود" vs "افزایش پیدا می‌کند"', () => {
  const q: ExamQuestion = {
    id: 'fb2',
    type: 'fill_in_the_blank',
    question: 'با گرم شدن هوا، حجم گازها ............ .',
    points: 2,
    correctAnswer: 'زیاد می‌شود',
  }
  const ans = { textAnswer: 'افزایش پیدا می‌کند' }
  const res = evaluateFillInTheBlank(q, ans)
  assert.strictEqual(res.score, 2, 'افزایش پیدا می‌کند should get full marks for زیاد می‌شود')
  assert.strictEqual(res.status, 'correct')
})

runTest('9. Fill in the blank: Science grade 6 "خمیرکره" vs "خمیر کره" vs "استنوسفر"', () => {
  const q: ExamQuestion = {
    id: 'fb3',
    type: 'fill_in_the_blank',
    question: 'بخش خمیری گوشته زمین را ............ می‌نامند.',
    points: 2,
    correctAnswer: 'خمیرکره',
  }
  assert.strictEqual(evaluateFillInTheBlank(q, { textAnswer: 'خمیر کره' }).score, 2)
  assert.strictEqual(evaluateFillInTheBlank(q, { textAnswer: 'استنوسفر' }).score, 2)
  assert.strictEqual(evaluateFillInTheBlank(q, { textAnswer: 'گوشته بالایی' }).score, 2)
})

runTest('10. Spacing & half-space: "شهاب سنگ" vs "شهاب‌سنگ"', () => {
  const q: ExamQuestion = {
    id: 'fb4',
    type: 'fill_in_the_blank',
    question: 'تکه‌سنگ‌های آسمانی که به زمین سقوط می‌کنند ............ نام دارند.',
    points: 2,
    correctAnswer: 'شهاب‌سنگ',
  }
  const res = evaluateFillInTheBlank(q, { textAnswer: 'شهاب سنگ' })
  assert.strictEqual(res.score, 2)
  assert.strictEqual(res.status, 'correct')
})

runTest('11. Grade 6 minor spelling and affix variation: "سنگ ها" vs "سنگها"', () => {
  const q: ExamQuestion = {
    id: 'fb5',
    type: 'fill_in_the_blank',
    question: 'زمین‌لرزه به دلیل شکستن ناگهانی ............ در گسل رخ می‌دهد.',
    points: 2,
    correctAnswer: 'سنگ‌ها',
  }
  const res = evaluateFillInTheBlank(q, { textAnswer: 'سنگ ها' })
  assert.strictEqual(res.score, 2)
  assert.strictEqual(res.status, 'correct')
})

// -----------------------------------------------------------------
// SCENARIOS 12-14: QUESTION APPROVAL & EXACT COUNT ENFORCEMENT
// -----------------------------------------------------------------

runTest('12. Question Approval: Rejected questions are strictly excluded from published exam', () => {
  const qApproved: ExamQuestion = {
    id: 'qa1',
    type: 'multiple_choice',
    question: 'سوال تایید شده شماره یک',
    points: 2,
    options: ['الف', 'ب', 'ج', 'د'],
    correctAnswer: 0,
  }
  const qRejected: ExamQuestion = {
    id: 'qa2',
    type: 'multiple_choice',
    question: 'سوال رد شده توسط آموزگار',
    points: 2,
    options: ['۱', '۲', '۳', '۴'],
    correctAnswer: 1,
  }

  const confirmedSet = new Set(['qa1'])
  const rejectedSet = new Set(['qa2'])

  const draftQuestions = [qApproved, qRejected]
  const finalQuestions = draftQuestions.filter((q) => confirmedSet.has(q.id) && !rejectedSet.has(q.id))

  assert.strictEqual(finalQuestions.length, 1, 'Only 1 question must be published')
  assert.strictEqual(finalQuestions[0].id, 'qa1')
})

runTest('13. Validation Engine: Invalid question without correct answer is rejected', () => {
  const invalidQ: ExamQuestion = {
    id: 'q_bad',
    type: 'multiple_choice',
    question: 'سوال بدون کلید معتبر',
    points: 2,
    options: ['الف', 'ب', 'ج', 'د'],
    correctAnswer: 'گزینه ناموجود ۵',
  }
  const exam = {
    title: 'آزمون تستی',
    questions: [invalidQ],
  }
  const valRes = validateExam(exam)
  assert.strictEqual(valRes.isValid, false, 'Exam with invalid correct option should fail validation')
})

// -----------------------------------------------------------------
// SCENARIOS 14-16: GRADE PRIVACY & UNAPPROVED SUBMISSIONS
// -----------------------------------------------------------------

runTest('14. Grade Privacy: Unapproved submission is NOT released to students', () => {
  const exam: Exam = {
    id: 'ex1',
    title: 'آزمون علوم',
    subject: 'علوم تجربی',
    mode: 'exam',
    durationMinutes: 30,
    questions: [],
    resultsPublished: false,
  }
  const unapprovedSub: any = {
    id: 'sub1',
    examId: 'ex1',
    studentId: 'st1',
    isReleased: false,
    teacherGrading: { approved: false, totalScore: 18 },
  }

  assert.strictEqual(isExamResultsReleased(exam, unapprovedSub), false, 'Unapproved exam must NOT be released')
})

runTest('15. Grade Privacy: Approved submission with resultsPublished is released', () => {
  const exam: Exam = {
    id: 'ex1',
    title: 'آزمون علوم',
    subject: 'علوم تجربی',
    mode: 'exam',
    durationMinutes: 30,
    questions: [],
    resultsPublished: true,
  }
  const approvedSub: any = {
    id: 'sub1',
    examId: 'ex1',
    studentId: 'st1',
    isReleased: true,
    teacherGrading: { approved: true, totalScore: 18 },
  }

  assert.strictEqual(isExamResultsReleased(exam, approvedSub), true, 'Approved & published exam must be released')
})

runTest('16. Stripped Keys: Questions with undefined correctAnswer do NOT produce negative or faulty feedback', () => {
  const strippedQ: ExamQuestion = {
    id: 'sq1',
    type: 'multiple_choice',
    question: 'سوال بدون کلید کلاینت',
    points: 2,
    options: ['الف', 'ب', 'ج', 'د'],
    // correctAnswer intentionally undefined
  }
  const studentAns = { selectedOption: 3 }
  const res = evaluateMultipleChoice(strippedQ, studentAns)
  assert.strictEqual(res.score, 0)
  assert.strictEqual(res.status, 'needs_teacher_review')
})

// -----------------------------------------------------------------
// SCENARIOS 17-18: ENTIRE EXAM SUBMISSION & REGRADE EVALUATION
// -----------------------------------------------------------------

runTest('17. Entire Exam Evaluation: 20-scale conversion and mixed questions', () => {
  const exam = {
    questions: [
      {
        id: 'q1',
        type: 'multiple_choice' as const,
        question: 'تستی ۱',
        points: 5,
        options: ['الف', 'ب', 'ج', 'د'],
        correctAnswer: 3, // Option 4
      },
      {
        id: 'q2',
        type: 'fill_in_the_blank' as const,
        question: 'جای خالی ۱',
        points: 5,
        correctAnswer: 'بزرگ‌تر',
      },
    ],
    totalPoints: 10,
  }

  const answers = {
    q1: { selectedOption: 3 }, // Full marks (5)
    q2: { textAnswer: 'بیشتر' }, // Full marks (5)
  }

  const result = evaluateEntireExamSubmission(exam, answers)
  assert.strictEqual(result.earnedPoints, 10, 'Earned 10/10')
  assert.strictEqual(result.scaledScore20, 20, 'Scaled to 20/20')
  assert.strictEqual(result.correctCount, 2, '2 correct answers')
  assert.strictEqual(result.wrongCount, 0, '0 wrong answers')
})

runTest('18. Option 4 selected with Persian digit "۴" gets full score in entire exam submission', () => {
  const exam = {
    questions: [
      {
        id: 'q1',
        type: 'multiple_choice' as const,
        question: 'تستی ۴',
        points: 1,
        options: ['گزینه ۱', 'گزینه ۲', 'گزینه ۳', 'گزینه ۴'],
        correctAnswer: 'گزینه ۴',
      },
    ],
    totalPoints: 1,
  }

  const answers: any = {
    q1: { selectedOption: '۴' }, // Persian digit 4
  }

  const result = evaluateEntireExamSubmission(exam, answers)
  assert.strictEqual(result.earnedPoints, 1, 'Earned 1/1')
  assert.strictEqual(result.scaledScore20, 20, 'Scaled to 20/20')
})

// -----------------------------------------------------------------
// SCENARIOS 19-24: REAL TEST BENCHMARKS FROM SCREENSHOTS 338, 339, 340
// -----------------------------------------------------------------

runTest('19. Question 7 (Screenshot 338): 3 spelling errors with emojis gets 1.5/1.5', () => {
  const q: ExamQuestion = {
    id: 'q7',
    type: 'descriptive',
    question: 'در متن زیر، سه غلط املایی وجود دارد. آن‌ها را پیدا کرده و شکل درست هر یک را بنویسید: «... در نقطه‌ی آغار آفرینش ... رفتار پسنطیده ... علمی مشاحده کرد»',
    points: 1.5,
    rubricOrHint: 'آغار ← آغاز ، پسنطیده ← پسندیده ، مشاحده ← مشاهده',
  }

  const studentAns = {
    textAnswer: 'آغار ❌ پسنطیده ❌ مشاحده ❌ آغاز ✅ پسندیده ✅ مشاهده ✅',
  }

  const res = evaluateDescriptiveQuestion(q, studentAns)
  assert.strictEqual(res.score, 1.5, 'Must receive full score 1.5 out of 1.5')
  assert.strictEqual(res.status, 'correct')
})

runTest('20. Question 7: reversed order without emojis gets 1.5/1.5', () => {
  const q: ExamQuestion = {
    id: 'q7_rev',
    type: 'descriptive',
    question: 'سه غلط املایی را پیدا کرده و شکل درست را بنویسید',
    points: 1.5,
    rubricOrHint: 'آغاز، پسندیده، مشاهده',
  }

  const studentAns = {
    textAnswer: 'مشاهده پسندیده آغاز',
  }

  const res = evaluateDescriptiveQuestion(q, studentAns)
  assert.strictEqual(res.score, 1.5, 'Must receive full score 1.5 out of 1.5 regardless of order')
  assert.strictEqual(res.status, 'correct')
})

runTest('21. Question 7: partial answer with 2 out of 3 errors gets 1.0/1.5', () => {
  const q: ExamQuestion = {
    id: 'q7_part',
    type: 'descriptive',
    question: 'سه غلط املایی را پیدا کرده و شکل درست را بنویسید',
    points: 1.5,
    rubricOrHint: 'آغاز، پسندیده، مشاهده',
  }

  const studentAns = {
    textAnswer: 'آغاز پسندیده',
  }

  const res = evaluateDescriptiveQuestion(q, studentAns)
  assert.strictEqual(res.score, 1.0, '2 out of 3 errors earns 1.0 out of 1.5')
  assert.strictEqual(res.status, 'partial')
})

runTest('22. Question 8 (Screenshot 338 & 339): 2 errors intentional in poem gets 1.0/1.0', () => {
  const q: ExamQuestion = {
    id: 'q8',
    type: 'descriptive',
    question: 'در بیت زیر دو غلط املایی عمدی وجود دارد. بیت را با املای درست بازنویسی کنید: «برگِ درختان سبز در نظرِ هوشیار / هر ورقش دفتری‌ست، معرقتِ کردگار»',
    points: 1,
    rubricOrHint: 'ورقش، معرفت (برگ درختان سبز در نظر هوشیار / هر ورقش دفتری‌ست، معرفت کردگار)',
  }

  const studentAns = {
    textAnswer: 'ورقش❌ معرقت❌ ورقش✅ معرفت✅',
  }

  const res = evaluateDescriptiveQuestion(q, studentAns)
  assert.strictEqual(res.score, 1.0, 'Student identified both errors and gets 1.0 out of 1.0')
  assert.strictEqual(res.status, 'correct')
})

runTest('23. Question 9 (Screenshot 339): 4 word completions gets 1.0/1.0', () => {
  const q: ExamQuestion = {
    id: 'q9',
    type: 'descriptive',
    question: 'کلمات زیر را با یکی از حروف (ت / ط) کامل کنید و دوباره بنویسید: الف) ...فاوت (تفاوت / طفاوت) ب) ...سرف مرغزار (ترف / طرف) ج) غفل... (غفلت / غلطط) د) نق...ـه‌ی آغاز (نقطه / نقتة)',
    points: 1,
    rubricOrHint: 'الف) تفاوت ب) طرف ج) غفلت د) نقطه',
  }

  const studentAns = {
    textAnswer: 'تفاوت طرف غفلت نقطه',
  }

  const res = evaluateDescriptiveQuestion(q, studentAns)
  assert.strictEqual(res.score, 1.0, 'All 4 items correct earns 1.0 out of 1.0')
  assert.strictEqual(res.status, 'correct')
})

runTest('24. Question 9: 3 out of 4 words completed gets 0.75/1.0', () => {
  const q: ExamQuestion = {
    id: 'q9_part',
    type: 'descriptive',
    question: 'کلمات زیر را با یکی از حروف (ت / ط) کامل کنید و دوباره بنویسید: الف) ...فاوت ب) ...سرف مرغزار ج) غفل... د) نق...ـه‌ی آغاز',
    points: 1,
    rubricOrHint: 'تفاوت، طرف، غفلت، نقطه',
  }

  const studentAns = {
    textAnswer: 'تفاوت طرف نقطه',
  }

  const res = evaluateDescriptiveQuestion(q, studentAns)
  assert.strictEqual(res.score, 0.75, '3 of 4 items earns 0.75 out of 1.0')
  assert.strictEqual(res.status, 'partial')
})

runTest('25. Question 9 with REAL teacher instructional rubric: "انتخاب حرف و نگارش واژه برای هر مورد ۰٫۲۵ نمره..."', () => {
  const q: ExamQuestion = {
    id: 'q9_real',
    type: 'descriptive',
    question: 'کلمات زیر را با یکی از حروف (ت / ط) کامل کنید و دوباره بنویسید: الف) ...ـفاوت (تفاوت / طفاوت) ب) ...ـرف مرغزار (ترف / طرف) ج) غفلـ... (غفلت / غفلط) د) نـقـ...ـهی آغاز (نقطه / نقتة) (۱ نمره)',
    points: 1,
    rubricOrHint: 'انتخاب حرف و نگارش واژه برای هر مورد ۰٫۲۵ نمره (الف: تفاوت، ب: طرف، ج: غفلت، د: نقطه)',
  }

  const studentAns = {
    textAnswer: 'تفاوت طرف غفلت نقطه',
  }

  const res = evaluateDescriptiveQuestion(q, studentAns)
  assert.strictEqual(res.score, 1.0, 'Must receive full score 1.0 out of 1.0')
  assert.strictEqual(res.status, 'correct')
  assert.strictEqual(res.feedback.includes('انتخاب'), false, 'Feedback must not leak instructional stop-words')
  assert.strictEqual(res.feedback.includes('نگارش'), false, 'Feedback must not leak instructional stop-words')
})

runTest('26. Question 9 with reversed order: "طرف غفلت نقطه تفاوت" earns 1.0/1.0', () => {
  const q: ExamQuestion = {
    id: 'q9_rev',
    type: 'descriptive',
    question: 'کلمات زیر را با یکی از حروف (ت / ط) کامل کنید: الف) ...ـفاوت ب) ...ـرف مرغزار ج) غفلـ... د) نـقـ...ـهی آغاز',
    points: 1,
    rubricOrHint: 'انتخاب حرف و نگارش واژه برای هر مورد ۰٫۲۵ نمره (الف: تفاوت، ب: طرف، ج: غفلت، د: نقطه)',
  }

  const studentAns = {
    textAnswer: 'طرف غفلت نقطه تفاوت',
  }

  const res = evaluateDescriptiveQuestion(q, studentAns)
  assert.strictEqual(res.score, 1.0, 'Order independence must grant 1.0 out of 1.0')
  assert.strictEqual(res.status, 'correct')
})

runTest('27. Cross-question isolation: Q7 and Q9 evaluated in same exam never cross-contaminate', () => {
  const exam = {
    questions: [
      {
        id: 'q7',
        type: 'descriptive' as const,
        question: 'در متن زیر، سه غلط املایی وجود دارد. آن‌ها را پیدا کرده و شکل درست هر یک را بنویسید',
        points: 1.5,
        rubricOrHint: 'آغار ← آغاز ، پسنطیده ← پسندیده ، مشاحده ← مشاهده',
      },
      {
        id: 'q9',
        type: 'descriptive' as const,
        question: 'کلمات زیر را با یکی از حروف (ت / ط) کامل کنید',
        points: 1.0,
        rubricOrHint: 'انتخاب حرف و نگارش واژه برای هر مورد ۰٫۲۵ نمره (الف: تفاوت، ب: طرف، ج: غفلت، د: نقطه)',
      },
    ],
    totalPoints: 2.5,
  }

  const answers = {
    q7: { textAnswer: 'آغاز پسندیده مشاهده' },
    q9: { textAnswer: 'تفاوت طرف غفلت نقطه' },
  }

  const result = evaluateEntireExamSubmission(exam, answers)
  assert.strictEqual(result.questionScores['q7'], 1.5, 'Q7 gets 1.5')
  assert.strictEqual(result.questionScores['q9'], 1.0, 'Q9 gets 1.0')
  assert.strictEqual(result.earnedPoints, 2.5, 'Total earned is 2.5/2.5')
})

runTest('28. Mathematical Unity: getSubmissionEffectiveScore strictly equals sum of question scores', () => {
  const exam = {
    questions: [
      { id: 'q1', type: 'multiple_choice' as const, question: 'تستی', points: 1, options: ['الف', 'ب', 'ج', 'د'], correctAnswer: 0 },
      { id: 'q7', type: 'descriptive' as const, question: 'املایی', points: 1.5, rubricOrHint: 'آغاز، پسندیده، مشاهده' },
      { id: 'q9', type: 'descriptive' as const, question: 'تکمیلی', points: 1.0, rubricOrHint: 'الف: تفاوت، ب: طرف، ج: غفلت، د: نقطه' },
    ],
    totalPoints: 3.5,
  }

  const sub: any = {
    id: 'sub_test_unity',
    studentId: '5540271531',
    studentName: 'محی الدین دانائی فر',
    answers: {
      q1: { selectedOption: 0 }, // 1.0
      q7: { textAnswer: 'آغار ❌ پسنطیده ❌ مشاحده ❌ آغاز ✅ پسندیده ✅ مشاهده ✅' }, // 1.5
      q9: { textAnswer: 'تفاوت طرف غفلت نقطه' }, // 1.0
    },
  }

  const eff = getSubmissionEffectiveScore(exam, sub)
  const sumOfScores = Object.values(eff.questionScores).reduce((a, b) => a + b, 0)
  assert.strictEqual(eff.totalScore, 3.5, 'Total score must be 3.5')
  assert.strictEqual(eff.totalScore, Math.round(sumOfScores * 100) / 100, 'Total score must equal sum of questions')
})

runTest('29. Preservation of teacher-approved grade: Manual teacher grade is strictly protected', () => {
  const exam = {
    questions: [
      { id: 'q1', type: 'multiple_choice' as const, question: 'تستی', points: 1, options: ['الف', 'ب'], correctAnswer: 0 },
    ],
    totalPoints: 1,
  }

  const approvedSub: any = {
    id: 'sub_approved',
    studentId: '5540271531',
    answers: { q1: { selectedOption: 1 } }, // Student picked wrong option (auto score = 0)
    teacherGrading: {
      approved: true,
      questionScores: { q1: 1.0 }, // Teacher manually gave 1.0
      totalScore: 1.0,
      scaledScore20: 20,
    },
  }

  const eff = getSubmissionEffectiveScore(exam, approvedSub)
  assert.strictEqual(eff.isApproved, true)
  assert.strictEqual(eff.totalScore, 1.0, 'Approved teacher score must NOT be overwritten')
  assert.strictEqual(eff.questionScores['q1'], 1.0)
})

runTest('30. Grade Privacy: Unapproved & unreleased submission is NOT released', () => {
  const exam: any = { id: 'exam_priv', title: 'آزمون فارسی', totalPoints: 10, isResultsReleased: false }
  const sub: any = { id: 'sub_priv', examId: 'exam_priv', teacherGrading: { approved: false } }
  assert.strictEqual(isExamResultsReleased(exam, sub), false, 'Must be false when unapproved & unreleased')
})

runTest('31. Real-Data Benchmark: Mohi-eddin Danaifar submission scores 9.5/9.5 with Q6=1.0, Q7=1.5, Q8=1.0, Q9=1.0', () => {
  const exams = JSON.parse(fs.readFileSync('./data/exams_backup.json', 'utf8'))
  const subs = JSON.parse(fs.readFileSync('./data/submissions_backup.json', 'utf8'))
  const exam = exams.find((e: any) => e.id === 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2')
  const mohiSub = subs.find((s: any) => s.id === 'sub_a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2_80cbb7a2-0d4e-4f0d-96f3-dfb0a801f9b2_1793551398410')
  assert.ok(exam, 'Exam must exist in backup')
  assert.ok(mohiSub, 'Mohi submission must exist in backup')

  const res = evaluateEntireExamSubmission(exam, mohiSub.answers)
  assert.strictEqual(res.questionGrading['q12']?.score, 1.0, 'Q6 ("ه" completing "نهراسیم") must receive 1.0/1.0 full credit')
  assert.strictEqual(res.questionGrading['q12']?.status, 'correct')
  assert.strictEqual(res.questionGrading['q14']?.score, 1.5, 'Q7 (3 spelling errors) must receive 1.5/1.5')
  assert.strictEqual(res.questionGrading['q18']?.score, 1.0, 'Q8 (intentional poem errors) must receive 1.0/1.0')
  assert.strictEqual(res.questionGrading['q19']?.score, 1.0, 'Q9 (4 word completions) must receive 1.0/1.0')
  assert.strictEqual(res.earnedPoints, 9.5, 'Earned points must be exactly 9.5 out of 9.5')

  const sumScores = Object.values(res.questionGrading).reduce((acc: number, item: any) => acc + (item.score || 0), 0)
  assert.strictEqual(res.earnedPoints, Math.round(sumScores * 100) / 100, 'Earned points must mathematically equal sum of questions')
})

runTest('32. Real-Data Benchmark: Amir Akbari Q6 ("ه") and Q3 bonus earn 1.0 each, total score reaches 9.0/9.5', () => {
  const exams = JSON.parse(fs.readFileSync('./data/exams_backup.json', 'utf8'))
  const subs = JSON.parse(fs.readFileSync('./data/submissions_backup.json', 'utf8'))
  const exam = exams.find((e: any) => e.id === 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2')
  const amirSub = subs.find((s: any) => s.id === 'sub_a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2_406aa45a-4aab-4965-bbac-7b2adde82cc4_1793650343553')
  assert.ok(exam, 'Exam must exist')
  assert.ok(amirSub, 'Amir Akbari submission must exist')

  const res = evaluateEntireExamSubmission(exam, amirSub.answers)
  assert.strictEqual(res.questionGrading['q12']?.score, 1.0, 'Amir Akbari Q6 ("ه") must receive 1.0/1.0')
  assert.strictEqual(res.questionGrading['q12']?.status, 'correct')
  assert.strictEqual(res.questionGrading['q4']?.score, 1.0, 'Amir Akbari Q3 (q4) bonus must receive 1.0/1.0')
  assert.strictEqual(res.questionGrading['q4']?.status, 'correct')
  assert.strictEqual(res.earnedPoints, 9.0, 'Amir Akbari total score must be exactly 9.0 out of 9.5')

  const sumScores = Object.values(res.questionGrading).reduce((acc: number, item: any) => acc + (item.score || 0), 0)
  assert.strictEqual(res.earnedPoints, Math.round(sumScores * 100) / 100, 'Exact sum equality')
})

runTest('33. Intra-word blank Question 6: Positive acceptance of letter forms and full words', () => {
  const q: ExamQuestion = {
    id: 'q12',
    type: 'fill_in_the_blank',
    question: 'ما باید بسیار بخوانیم و درباره‌ی دیده‌ها، شنیده‌ها و خوانده‌ها بپرسیم و از پرسیدن نـ............ـراسیم. (هـ / ح)',
    points: 1,
    correctAnswer: 'نهراسیم',
    rubricOrHint: 'پاسخ صحیح: نهراسیم (با حرف هـ)',
  }

  const positiveAnswers = ['ه', 'هـ', 'ه‍', 'ـهـ', 'نهراسیم', 'نهراسيم', '  ه  ', 'نهراسیم‌']
  for (const ans of positiveAnswers) {
    const res = evaluateFillInTheBlank(q, { textAnswer: ans })
    assert.strictEqual(res.score, 1.0, `Answer "${ans}" must receive 1.0 full score`)
    assert.strictEqual(res.status, 'correct', `Answer "${ans}" must have status correct`)
  }
})

runTest('34. Intra-word blank Question 6: Strict rejection of wrong letter choices and unrelated words', () => {
  const q: ExamQuestion = {
    id: 'q12',
    type: 'fill_in_the_blank',
    question: 'ما باید بسیار بخوانیم و درباره‌ی دیده‌ها، شنیده‌ها و خوانده‌ها بپرسیم و از پرسیدن نـ............ـراسیم. (هـ / ح)',
    points: 1,
    correctAnswer: 'نهراسیم',
    rubricOrHint: 'پاسخ صحیح: نهراسیم (با حرف هـ)',
  }

  const negativeAnswers = ['ح', 'ـحـ', 'نحراسیم', 'بلبل', 'ص', 'ت']
  for (const ans of negativeAnswers) {
    const res = evaluateFillInTheBlank(q, { textAnswer: ans })
    assert.strictEqual(res.score, 0, `Answer "${ans}" must receive 0 score`)
    assert.strictEqual(res.status, 'incorrect', `Answer "${ans}" must have status incorrect`)
  }
})

runTest('35. Standard whole-word fill-in-the-blank does NOT accept single letters', () => {
  const q: ExamQuestion = {
    id: 'q_std',
    type: 'fill_in_the_blank',
    question: 'سعدی در گلستان می‌گوید: تن آدمی شریف است به جان آدمیت نه همین لباس زیباست نشان .........',
    points: 1,
    correctAnswer: 'آدمیت',
  }

  const resLetter = evaluateFillInTheBlank(q, { textAnswer: 'ه' })
  assert.strictEqual(resLetter.score, 0, 'Single letter on regular fill-in-the-blank must receive 0')
  assert.strictEqual(resLetter.status, 'incorrect')

  const resWord = evaluateFillInTheBlank(q, { textAnswer: 'آدمیت' })
  assert.strictEqual(resWord.score, 1.0, 'Full word must receive full score')
  assert.strictEqual(resWord.status, 'correct')
})

runTest('36. Mathematical Unity check: 100% of all 38 submissions in backup have discrepancy = 0.00', () => {
  const exams = JSON.parse(fs.readFileSync('./data/exams_backup.json', 'utf8'))
  const subs = JSON.parse(fs.readFileSync('./data/submissions_backup.json', 'utf8'))

  for (const sub of subs) {
    const exam = exams.find((e: any) => e.id === sub.examId)
    if (!exam) continue
    const eff = getSubmissionEffectiveScore(exam, sub)
    const sum = Object.values(eff.questionScores).reduce((acc: number, val: any) => acc + (Number(val) || 0), 0)
    const roundedSum = Math.round(sum * 100) / 100
    const diff = Math.abs(eff.totalScore - roundedSum)
    assert.ok(diff < 0.001, `Submission ${sub.id} must have 0.00 discrepancy, got ${diff}`)
  }
})

runTest('37. Question 3 (q4) universal credit: Any option (0, 1, 2, 3) receives 1.0 full point', () => {
  const exams = JSON.parse(fs.readFileSync('./data/exams_backup.json', 'utf8'))
  const exam = exams.find((e: any) => e.id === 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2')
  const q4 = exam.questions.find((q: any) => q.id === 'q4')
  assert.ok(q4, 'Question 3 (q4) must exist')
  assert.strictEqual(q4.awardFullScoreToAll, true, 'awardFullScoreToAll must be true')

  // Test every option selection receives 1.0 point
  for (let opt = 0; opt <= 3; opt++) {
    const res = evaluateMultipleChoice(q4, { selectedOption: opt })
    assert.strictEqual(res.score, 1.0, `Option ${opt} must receive 1.0 point`)
    assert.strictEqual(res.status, 'correct')
    assert.ok(res.feedback.includes('تصمیم آموزگار'), 'Feedback mentions teacher decision')
  }
})

runTest('38. Universal Q3 check: All 36 students in spelling exam receive 1.0 on Question 3', () => {
  const exams = JSON.parse(fs.readFileSync('./data/exams_backup.json', 'utf8'))
  const subs = JSON.parse(fs.readFileSync('./data/submissions_backup.json', 'utf8'))
  const exam = exams.find((e: any) => e.id === 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2')
  const spellingSubs = subs.filter((s: any) => s.examId === 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2')

  assert.strictEqual(spellingSubs.length, 36, 'Must evaluate all 36 students')
  for (const sub of spellingSubs) {
    const res = evaluateEntireExamSubmission(exam, sub.answers)
    assert.strictEqual(res.questionScores['q4'], 1.0, `${sub.studentName} must receive 1.0 on Q3`)
    const sum = Object.values(res.questionScores).reduce((a: number, b: any) => a + (Number(b) || 0), 0)
    const diff = Math.abs(res.earnedPoints - Math.round(sum * 100) / 100)
    assert.ok(diff < 0.001, `Discrepancy for ${sub.studentName} must be 0.00`)
  }
})

console.log('=====================================================')
console.log(`📊 RESULTS: ${passedTests} passed, ${failedTests} failed.`)
console.log('=====================================================')

if (failedTests > 0) {
  process.exit(1)
} else {
  console.log('🎉 ALL 38 VERIFICATION SCENARIOS PASSED WITH 100% ACCURACY!')
  process.exit(0)
}




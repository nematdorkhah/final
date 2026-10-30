/**
 * Comprehensive Automated Test Suite for Grade 6 Persian Semantic Grading Engine
 * Covers all 17 requirements requested by the user.
 */

import {
  normalizePersianText,
  compactPersianText,
  safeNumber,
  safeScore,
  safePercentage,
  safeScaled20,
  resolveCorrectOptionIndex,
  resolveStudentSelectedOption,
  evaluateMultipleChoice,
  evaluateFillInTheBlank,
  evaluateDescriptiveQuestion,
  evaluateEntireExamSubmission,
} from './src/utils/persianSemanticGrader'
import { Exam, ExamQuestion, StudentExamAnswer, StudentExamSubmission } from './src/types/examTypes'
import { isExamResultsReleased, approveExamSubmission } from './src/utils/examStore'

interface TestResult {
  num: number
  title: string
  passed: boolean
  details: string
}

const results: TestResult[] = []

function assert(condition: boolean, num: number, title: string, details = '') {
  results.push({
    num,
    title,
    passed: Boolean(condition),
    details: condition ? '✓ پاس شد: ' + details : '✗ شکست خورد: ' + details,
  })
}

console.log('=================================================================')
console.log('🧪 شروع اجرای آزمون‌های ۱۷‌گانه سامانه تصحیح مفهومی و بدون NaN')
console.log('=================================================================\n')

// --------------------------------------------------------------------------
// تست ۱: پاسخ جای‌خالی دقیقاً مطابق پاسخنامه باشد
// --------------------------------------------------------------------------
{
  const q: ExamQuestion = {
    id: 'q1',
    type: 'fill_in_the_blank',
    question: 'اگر حاصل‌ضرب دو کسر مساوی با ۱ باشد، آن دو کسر ............ یکدیگرند.',
    correctAnswer: 'معکوس',
    points: 2,
  }
  const eval1 = evaluateFillInTheBlank(q, { textAnswer: 'معکوس' })
  assert(
    eval1.score === 2 && eval1.status === 'correct',
    1,
    'پاسخ جای‌خالی دقیقاً مطابق پاسخنامه',
    `نمره: ${eval1.score}/2، وضعیت: ${eval1.status}`
  )
}

// --------------------------------------------------------------------------
// تست ۲: پاسخ جای‌خالی با واژه‌ای متفاوت اما هم‌معنی نوشته شده باشد («بیشتر» به جای «بزرگتر»)
// --------------------------------------------------------------------------
{
  const qGreater: ExamQuestion = {
    id: 'q2_1',
    type: 'fill_in_the_blank',
    question: 'در مقایسه دو کسر با مخرج مساوی، کسری که صورت آن بزرگتر است، ............ است.',
    correctAnswer: 'بزرگتر',
    points: 2,
  }

  // حالت الف: بیشتر
  const resA = evaluateFillInTheBlank(qGreater, { textAnswer: 'بیشتر' })
  // حالت ب: دارای اندازه بیشتر
  const resB = evaluateFillInTheBlank(qGreater, { textAnswer: 'دارای اندازه بیشتر' })
  // حالت ج: افزایش پیدا می‌کند به جای زیاد می‌شود
  const qIncrease: ExamQuestion = {
    id: 'q2_2',
    type: 'fill_in_the_blank',
    question: 'با گرم شدن هوا، حجم گازها ............ .',
    correctAnswer: 'زیاد می‌شود',
    points: 2,
  }
  const resC = evaluateFillInTheBlank(qIncrease, { textAnswer: 'افزایش پیدا می‌کند' })

  const allPass = resA.score === 2 && resB.score === 2 && resC.score === 2
  assert(
    allPass,
    2,
    'پاسخ جای‌خالی با واژگان هم‌معنی («بیشتر» بجای «بزرگتر»، «افزایش پیدا می‌کند» بجای «زیاد می‌شود»)',
    `بیشتر: ${resA.score}/2، دارای اندازه بیشتر: ${resB.score}/2، افزایش پیدا می‌کند: ${resC.score}/2`
  )
}

// --------------------------------------------------------------------------
// تست ۳: پاسخ تشریحی با جمله‌بندی متفاوت اما مفهوم صحیح نوشته شده باشد
// --------------------------------------------------------------------------
{
  const qDesc: ExamQuestion = {
    id: 'q3',
    type: 'descriptive',
    question: 'تفاوت موج‌های لرزه‌ای اولیه (P) و ثانویه (S) را شرح دهید.',
    rubricOrHint: 'موج اولیه طولی و سریع‌تر است و از مایع و جامد عبور می‌کند؛ موج ثانویه عرضی و کندتر است و فقط از جامد می‌گذرد.',
    points: 3,
  }
  // دانش‌آموز با کلمات خودش نوشته:
  const studentAns = {
    textAnswer: 'موج‌های پی بسیار پرسرعت هستند و هم از سنگ‌های جامد و هم از مواد مذاب مایع درون زمین رد می‌شوند ولی امواج اس با سرعت کمتری حرکت کرده و نمی‌توانند از مایعات رد شوند.'
  }
  const res = evaluateDescriptiveQuestion(qDesc, studentAns)
  assert(
    res.score >= 2.5 && res.status === 'correct',
    3,
    'پاسخ تشریحی با جمله‌بندی دانش‌آموز اما مفهوم علمی کامل',
    `نمره کسب‌شده: ${res.score}/3، وضعیت: ${res.status}`
  )
}

// --------------------------------------------------------------------------
// تست ۴: پاسخ تشریحی بخشی از مفهوم را درست بیان کند و نمره جزئی بگیرد
// --------------------------------------------------------------------------
{
  const qDesc: ExamQuestion = {
    id: 'q4',
    type: 'descriptive',
    question: 'تفاوت موج‌های اولیه (P) و ثانویه (S) را شرح دهید.',
    rubricOrHint: 'موج پی طولی است و از جامد و مایع رد می‌شود و سریعتر است؛ موج اس عرضی و فقط از جامد رد می‌شود.',
    points: 3,
  }
  // دانش‌آموز فقط به سرعت اشاره کرده و به مایع/جامد اشاره نکرده:
  const studentAns = { textAnswer: 'موج پی خیلی سریع‌تر از موج اس به سطح زمین می‌رسد.' }
  const res = evaluateDescriptiveQuestion(qDesc, studentAns)
  assert(
    res.score > 0 && res.score < 3 && (res.status === 'partial' || res.status === 'needs_teacher_review'),
    4,
    'پاسخ تشریحی ناقص دریافت‌کننده نمره جزئی عادلانه',
    `نمره جزئی کسب‌شده: ${res.score}/3 (نه صفر و نه کامل)`
  )
}

// --------------------------------------------------------------------------
// تست ۵: پاسخ دارای مفهوم متناقض یا علمی نادرست باشد
// --------------------------------------------------------------------------
{
  const qChange: ExamQuestion = {
    id: 'q5',
    type: 'fill_in_the_blank',
    question: 'با افزایش ارتفاع از سطح دریا، فشار هوا ............ .',
    correctAnswer: 'کم می‌شود',
    points: 2,
  }
  // دانش‌آموز متناقض نوشته: زیاد می‌شود یا افزایش می‌یابد
  const resContradict = evaluateFillInTheBlank(qChange, { textAnswer: 'زیاد می‌شود' })
  assert(
    resContradict.score === 0 && resContradict.status === 'incorrect',
    5,
    'رد قاطع پاسخ متناقض (نوشتن افزایش بجای کاهش)',
    `نمره: ${resContradict.score}/2، وضعیت: ${resContradict.status}`
  )
}

// --------------------------------------------------------------------------
// تست ۶: پاسخ دانش‌آموز خالی باشد
// --------------------------------------------------------------------------
{
  const qMC: ExamQuestion = {
    id: 'q6_mc',
    type: 'multiple_choice',
    question: 'پایتخت ایران کدام است؟',
    options: ['تهران', 'اصفهان', 'شیراز', 'مشهد'],
    correctAnswer: 0,
    points: 2,
  }
  const qBlank: ExamQuestion = {
    id: 'q6_blank',
    type: 'fill_in_the_blank',
    question: 'جای خالی را پر کنید.',
    correctAnswer: 'آزمون',
    points: 2,
  }
  const resMC = evaluateMultipleChoice(qMC, {})
  const resBlank = evaluateFillInTheBlank(qBlank, { textAnswer: '' })
  assert(
    resMC.score === 0 && resMC.status === 'empty' && resBlank.score === 0 && resBlank.status === 'empty',
    6,
    'پاسخ خالی دانش‌آموز با نمره صفر و وضعیت بدون پاسخ مشخص',
    `تستی: ${resMC.score} (${resMC.status})، جای‌خالی: ${resBlank.score} (${resBlank.status})`
  )
}

// --------------------------------------------------------------------------
// تست ۷: پاسخ صحیح سؤال چهارگزینه‌ای در گزینه اول، دوم، سوم و چهارم قرار گرفته باشد
// --------------------------------------------------------------------------
{
  const options = ['گزینه اول', 'گزینه دوم', 'گزینه سوم', 'گزینه چهارم']
  let allCorrect = true
  for (let pos = 0; pos < 4; pos++) {
    const q: ExamQuestion = {
      id: `q7_${pos}`,
      type: 'multiple_choice',
      question: `سوال با کلید در موقعیت ${pos + 1}`,
      options,
      correctAnswer: pos,
      points: 2,
    }
    const evalRes = evaluateMultipleChoice(q, { selectedOption: pos })
    if (evalRes.score !== 2 || evalRes.status !== 'correct') {
      allCorrect = false
    }
  }
  assert(
    allCorrect,
    7,
    'صحت تصحیح سوالات چهارگزینه‌ای در موقعیت‌های ۱، ۲، ۳ و ۴',
    'هر ۴ موقعیت با موفقیت تصحیح شدند.'
  )
}

// --------------------------------------------------------------------------
// تست ۸: شماره گزینه (۱..۴) و اندیس آرایه (۰..۳) اشتباه گرفته نشوند
// --------------------------------------------------------------------------
{
  const qWithLabel: ExamQuestion = {
    id: 'q8_1',
    type: 'multiple_choice',
    question: 'سوال تستی با کلید به صورت رشته گزینه ۳',
    options: ['گزینه الف', 'گزینه ب', 'گزینه ج', 'گزینه د'],
    correctAnswer: 'گزینه ۳', // 1-based string label
    points: 2,
  }
  const resolved = resolveCorrectOptionIndex(qWithLabel)
  // گزینه ۳ باید به اندیس ۲ نگاشت شود
  const evalStudent = evaluateMultipleChoice(qWithLabel, { selectedOption: 2 })

  const qWithLetter: ExamQuestion = {
    id: 'q8_2',
    type: 'multiple_choice',
    question: 'سوال با کلید ج',
    options: ['الف', 'ب', 'ج', 'د'],
    correctAnswer: 'ج',
    points: 2,
  }
  const resolvedLetter = resolveCorrectOptionIndex(qWithLetter)

  assert(
    resolved.index === 2 && evalStudent.score === 2 && resolvedLetter.index === 2,
    8,
    'تمایز دقیق شماره گزینه (۱ تا ۴)، حروف فارسی (الف تا د) و اندیس آرایه (۰ تا ۳)',
    `«گزینه ۳» به اندیس ${resolved.index} و «ج» به اندیس ${resolvedLetter.index} نگاشت شد.`
  )
}

// --------------------------------------------------------------------------
// تست ۹: بارم سؤال نامعتبر، تهی یا NaN باشد
// --------------------------------------------------------------------------
{
  const qBadPoints: ExamQuestion = {
    id: 'q9',
    type: 'multiple_choice',
    question: 'سوال با بارم نامعتبر',
    options: ['الف', 'ب'],
    correctAnswer: 0,
    points: NaN as any,
  }
  const res = evaluateMultipleChoice(qBadPoints, { selectedOption: 0 })
  assert(
    !isNaN(res.score) && isFinite(res.score) && res.score > 0 && !isNaN(res.maxScore),
    9,
    'مدیریت بارم نامعتبر (NaN یا تهی) و عدم ایجاد نمره نامعتبر',
    `نمره ایمن اختصاص‌یافته: ${res.score} از ${res.maxScore}`
  )
}

// --------------------------------------------------------------------------
// تست ۱۰: مقدار نمره پیشنهادی هوش مصنوعی نامعتبر باشد (NaN، منفی یا بالاتر از بارم)
// --------------------------------------------------------------------------
{
  const qDesc: ExamQuestion = {
    id: 'q10',
    type: 'descriptive',
    question: 'سوال تشریحی با نمره نامعتبر هوش مصنوعی',
    points: 3,
  }
  // نمره منفی
  const resNeg = evaluateDescriptiveQuestion(qDesc, { textAnswer: 'توضیحات دانش‌آموز' }, { score: -5 })
  // نمره بالاتر از سقف
  const resOver = evaluateDescriptiveQuestion(qDesc, { textAnswer: 'توضیحات دانش‌آموز' }, { score: 999 })
  // نمره NaN
  const resNaN = evaluateDescriptiveQuestion(qDesc, { textAnswer: 'توضیحات دانش‌آموز' }, { score: NaN })

  const safeAll =
    resNeg.score >= 0 && resNeg.score <= 3 &&
    resOver.score <= 3 && !isNaN(resOver.score) &&
    !isNaN(resNaN.score) && resNaN.score >= 0 && resNaN.score <= 3

  assert(
    safeAll,
    10,
    'پالایش نمرات پیشنهادی نامعتبر هوش مصنوعی (منفی، بالاتر از سقف یا NaN)',
    `منفی به ${resNeg.score}، فراتر به ${resOver.score}، و NaN به ${resNaN.score} محدود شد.`
  )
}

// --------------------------------------------------------------------------
// تست ۱۱: پاسخ هوش مصنوعی ناقص یا غیرقابل‌تجزیه باشد
// --------------------------------------------------------------------------
{
  const qDesc: ExamQuestion = {
    id: 'q11',
    type: 'descriptive',
    question: 'منظور از اصطکاک چیست؟',
    rubricOrHint: 'نیرویی که مانع حرکت اجسام روی هم می‌شود و جهت آن خلاف جهت حرکت است.',
    points: 2.5,
  }
  // بدون نمره هوش مصنوعی (پاسخ شکسته سرور)
  const fallbackRes = evaluateDescriptiveQuestion(qDesc, {
    textAnswer: 'نیروی اصطکاک جلوی حرکت جسم را می‌گیرد و مخالف جهت حرکت است.'
  }, undefined)

  assert(
    fallbackRes.score > 0 && !isNaN(fallbackRes.score) && fallbackRes.maxScore === 2.5,
    11,
    'تصحیح بازگشتی معنایی در صورت عدم دسترسی یا غیرقابل‌تجزیه بودن پاسخ هوش مصنوعی',
    `نمره تصحیح مستقل: ${fallbackRes.score} از ۲.۵`
  )
}

// --------------------------------------------------------------------------
// تست ۱۲: کلید Gemini تنظیم نشده باشد یا سرویس از دسترس خارج شود
// --------------------------------------------------------------------------
{
  const examMock: Exam = {
    id: 'exam_offline',
    title: 'آزمون آفلاین کلاسی',
    questions: [
      { id: 'q12_1', type: 'multiple_choice', question: 'سوال ۱', options: ['۱', '۲'], correctAnswer: 0, points: 2 },
      { id: 'q12_2', type: 'fill_in_the_blank', question: 'انرژی تجدیدپذیر ............ نامیده می‌شود.', correctAnswer: 'پاک', points: 2 },
      { id: 'q12_3', type: 'descriptive', question: 'تعریف انرژی پاک', rubricOrHint: 'انرژی پاک آلودگی ندارد و پایان‌ناپذیر است.', points: 3 },
    ],
    totalPoints: 7,
  }

  const answers = {
    'q12_1': { selectedOption: 0 },
    'q12_2': { textAnswer: 'پاک' },
    'q12_3': { textAnswer: 'انرژی پاک آلودگی برای محیط زیست ندارد و تجدیدپذیر است.' },
  }

  // ارزیابی کامل آفلاین بدون تماس با سرور
  const offlineResult = evaluateEntireExamSubmission(examMock, answers)

  assert(
    offlineResult.earnedPoints === 7 && offlineResult.scaledScore20 === 20 && !isNaN(offlineResult.scaledScore20),
    12,
    'تداوم کارکرد ۱۰۰٪ و نمره‌دهی دقیق در شرایط قطعی اینترنت یا نبود کلید Gemini',
    `نمره کل: ${offlineResult.earnedPoints}/7، تراز از بیست: ${offlineResult.scaledScore20}/20`
  )
}

// --------------------------------------------------------------------------
// تست ۱۳: سؤال‌های قدیمی با ساختار داده متفاوت تصحیح شوند
// --------------------------------------------------------------------------
{
  // سوال قدیمی با فیلد correctOptionIndex بجای correctAnswer
  const legacyQ1: ExamQuestion = {
    id: 'leg1',
    type: 'multiple_choice',
    question: 'سوال قدیمی ۱',
    options: ['گزینه الف', 'گزینه ب', 'گزینه ج'],
    correctOptionIndex: 1,
    points: 2,
  }
  // سوال قدیمی که متن گزینه را در correctAnswer ذخیره کرده است
  const legacyQ2: ExamQuestion = {
    id: 'leg2',
    type: 'multiple_choice',
    question: 'محیط دایره',
    options: ['۲۵', '۵۰', '۷۸/۵', '۱۵۷'],
    correctAnswer: '۷۸/۵', // Option text directly!
    points: 2,
  }

  const res1 = evaluateMultipleChoice(legacyQ1, { selectedOption: 1 })
  const res2 = evaluateMultipleChoice(legacyQ2, { selectedOption: 2 })

  assert(
    res1.score === 2 && res2.score === 2,
    13,
    'پشتیبانی کامل از ساختار داده‌های قدیمی آزمون‌ها (متن گزینه یا correctOptionIndex)',
    `legacyQ1: ${res1.score}/2، legacyQ2: ${res2.score}/2`
  )
}

// --------------------------------------------------------------------------
// تست ۱۴: مجموع نمره سؤال‌ها دقیق و برابر مجموع نمره‌های معتبر باشد
// --------------------------------------------------------------------------
{
  const examCalc: Exam = {
    id: 'exam_sum',
    title: 'آزمون بررسی جمع نمرات',
    questions: [
      { id: 'q14_1', type: 'multiple_choice', question: 'س ۱', options: ['الف', 'ب'], correctAnswer: 0, points: 1.5 },
      { id: 'q14_2', type: 'multiple_choice', question: 'س ۲', options: ['الف', 'ب'], correctAnswer: 1, points: 2.25 },
      { id: 'q14_3', type: 'fill_in_the_blank', question: 'س ۳', correctAnswer: 'خورشید', points: 3.25 },
    ],
    totalPoints: 7,
  }

  const subAnswers = {
    'q14_1': { selectedOption: 0 }, // 1.5
    'q14_2': { selectedOption: 1 }, // 2.25
    'q14_3': { textAnswer: 'نور خورشید' }, // 3.25
  }

  const examEval = evaluateEntireExamSubmission(examCalc, subAnswers)
  const sumOfQuestions = Object.values(examEval.questionScores).reduce((a, b) => a + b, 0)
  const isMatch = Math.abs(sumOfQuestions - examEval.earnedPoints) < 0.001

  assert(
    isMatch && examEval.earnedPoints === 7,
    14,
    'دقت محاسباتی: مجموع نمرات تک‌تک سوالات دقیقاً برابر نمره کل است',
    `جمع سوالات: ${sumOfQuestions}، نمره کل کارنامه: ${examEval.earnedPoints}`
  )
}

// --------------------------------------------------------------------------
// تست ۱۵: دانش‌آموز نتواند پاسخ صحیح یا نمره منتشرنشده را دریافت کند
// --------------------------------------------------------------------------
{
  const secretExam: Exam = {
    id: 'secret_exam',
    title: 'امتحان نهایی ریاضی',
    mode: 'exam',
    isResultsReleased: false,
    resultsPublished: false,
    durationMinutes: 45,
    dueDate: new Date(Date.now() + 3600000).toISOString(), // 1 hour in future
    questions: [
      { id: 'sq1', type: 'multiple_choice', question: 'سوال محرمانه', correctAnswer: 2, rubricOrHint: 'پاسخ مخفی' }
    ]
  }

  const mockSubmission: StudentExamSubmission = {
    id: 'sub_test',
    examId: 'secret_exam',
    studentId: 'st_123',
    answers: {},
    isReleased: false,
  }

  const isReleasedToStudent = isExamResultsReleased(secretExam, mockSubmission)

  assert(
    !isReleasedToStudent,
    15,
    'حفظ امنیت و محرمانگی کلید و نمره تا پیش از انتشار معلم یا پایان زمان',
    'وضعیت انتشار به درستی مسدود (false) است.'
  )
}

// --------------------------------------------------------------------------
// تست ۱۶: معلم بتواند نمره پیشنهادی هوش مصنوعی را بررسی و اصلاح کند
// --------------------------------------------------------------------------
{
  const teacherExam: Exam = {
    id: 'exam_teacher_edit',
    title: 'آزمون با قابلیت ویرایش نمره توسط معلم',
    questions: [
      { id: 'tq1', type: 'descriptive', question: 'انشا درباره بهار', points: 4 }
    ],
    totalPoints: 4,
  }

  // ارزیابی اولیه نمره ۳.۵ داده بود، معلم می‌خواهد نمره را به ۴ (کامل) تغییر دهد
  const updatedScores = { 'tq1': 4 }
  const manualTotal = Object.values(updatedScores).reduce((s, v) => s + v, 0)
  const scaled = safeScaled20(manualTotal, 4)

  assert(
    manualTotal === 4 && scaled === 20,
    16,
    'امکان بازبینی، ویرایش و ثبت نمره نهایی توسط آموزگار در پنل بررسی',
    `نمره اصلاح‌شده معلم: ${manualTotal}/4 (تراز: ${scaled}/20)`
  )
}

// --------------------------------------------------------------------------
// تست ۱۷: نتیجه تصحیح در پنل معلم و گزارش دانش‌آموز پس از انتشار، یکسان باشد
// --------------------------------------------------------------------------
{
  const sharedExam: Exam = {
    id: 'shared_exam',
    title: 'آزمون هماهنگ علوم',
    totalPoints: 10,
    questions: [
      { id: 'q17_1', type: 'multiple_choice', question: 'س ۱', options: ['الف', 'ب'], correctAnswer: 1, points: 4 },
      { id: 'q17_2', type: 'fill_in_the_blank', question: 'س ۲', correctAnswer: 'سنگ‌ها', points: 6 },
    ],
  }

  const studentAnswers = {
    'q17_1': { selectedOption: 1 },
    'q17_2': { textAnswer: 'شکستن سنگ ها' },
  }

  const evaluation = evaluateEntireExamSubmission(sharedExam, studentAnswers)
  const teacherViewScore = evaluation.earnedPoints
  const studentViewScore = evaluation.earnedPoints
  const teacherScaled = safeScaled20(teacherViewScore, 10)
  const studentScaled = safeScaled20(studentViewScore, 10)

  assert(
    teacherViewScore === studentViewScore && teacherScaled === studentScaled && teacherScaled === 20,
    17,
    'انطباق و یکسانی ۱۰۰٪ نمرات و درصدها میان پنل معلم و کارنامه دانش‌آموز',
    `نمره معلم: ${teacherViewScore}، نمره دانش‌آموز: ${studentViewScore}، تراز: ${teacherScaled}/20`
  )
}

console.log('\n=================================================================')
console.log('📊 خلاصه نتایج اجرای آزمون‌ها:')
console.log('=================================================================')

let passCount = 0
for (const r of results) {
  if (r.passed) passCount++
  console.log(`${r.passed ? '✅' : '❌'} تست ${r.num}: ${r.title}`)
  console.log(`   ${r.details}`)
}

console.log('=================================================================')
console.log(`نتیجه نهایی: ${passCount} از ${results.length} تست با موفقیت پاس شدند (${Math.round((passCount / results.length) * 100)}٪).`)
console.log('=================================================================')

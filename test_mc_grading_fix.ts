/**
 * Comprehensive Automated Test Suite for Multiple-Choice & Pedagogical Grading Fix
 * Covers all 10 scenarios requested by the user + 3 real-world cases.
 */

import {
  cleanOptionText,
  resolveCorrectOptionIndex,
  resolveStudentSelectedOption,
  evaluateMultipleChoice,
  evaluateFillInTheBlank,
  evaluateEntireExamSubmission,
  safeNumber,
  safeScore,
  safeScaled20,
} from './src/utils/persianSemanticGrader'
import { ExamQuestion } from './src/types/examTypes'

interface TestItem {
  num: number
  title: string
  passed: boolean
  details: string
}

const testResults: TestItem[] = []

function assertTest(condition: boolean, num: number, title: string, details = '') {
  testResults.push({
    num,
    title,
    passed: Boolean(condition),
    details: condition ? '✓ پاس شد: ' + details : '✗ شکست خورد: ' + details,
  })
}

console.log('====================================================================')
console.log('🧪 اجرای تست‌های ده‌گانه تصحیح سوالات تستی و سناریوهای واقعی گزارش‌شده')
console.log('====================================================================\n')

// --------------------------------------------------------------------------
// سناریوی ۱: پاسخ صحیح در گزینه ۱ باشد (index 0)
// --------------------------------------------------------------------------
{
  const q: ExamQuestion = {
    id: 'q_idx0',
    type: 'multiple_choice',
    question: 'کدام گزینه یک جمله خبری است؟',
    options: ['امروز هوا بسیار لطیف و پاکیزه است.', 'آیا کتاب خواندی؟', 'به سخنان آموزگار گوش کن!', 'چه گل زیبایی!'],
    correctAnswer: 0,
    correctOptionText: 'امروز هوا بسیار لطیف و پاکیزه است.',
    points: 2,
  }

  const resKey = resolveCorrectOptionIndex(q)
  const evalCorrect = evaluateMultipleChoice(q, { selectedOption: 0, selectedOptionText: 'امروز هوا بسیار لطیف و پاکیزه است.' })
  const evalWrong = evaluateMultipleChoice(q, { selectedOption: 1, selectedOptionText: 'آیا کتاب خواندی؟' })

  const ok = resKey.isValid && resKey.index === 0 && evalCorrect.score === 2 && evalCorrect.status === 'correct' && evalWrong.score === 0
  assertTest(ok, 1, 'پاسخ صحیح در گزینه ۱ (index 0)', `کلید: ${resKey.label}، نمره انتخاب صحیح: ${evalCorrect.score}، نمره انتخاب غلط: ${evalWrong.score}`)
}

// --------------------------------------------------------------------------
// سناریوی ۲: پاسخ صحیح در گزینه ۲ باشد (index 1)
// --------------------------------------------------------------------------
{
  const q: ExamQuestion = {
    id: 'q_idx1',
    type: 'multiple_choice',
    question: 'کدام جمله پرسشی است؟',
    options: ['سهراب کتاب خواند.', 'آیا سهراب کتاب شاهنامه را خواند؟', 'کاش سهراب کتاب بخواند!', 'سهراب، کتاب را بخوان!'],
    correctAnswer: 1,
    correctOptionText: 'آیا سهراب کتاب شاهنامه را خواند؟',
    points: 2,
  }

  const resKey = resolveCorrectOptionIndex(q)
  const evalCorrect = evaluateMultipleChoice(q, { selectedOption: 1, selectedOptionText: 'آیا سهراب کتاب شاهنامه را خواند؟' })
  const evalWrong = evaluateMultipleChoice(q, { selectedOption: 0, selectedOptionText: 'سهراب کتاب خواند.' })

  const ok = resKey.isValid && resKey.index === 1 && evalCorrect.score === 2 && evalCorrect.status === 'correct' && evalWrong.score === 0
  assertTest(ok, 2, 'پاسخ صحیح در گزینه ۲ (index 1)', `کلید: ${resKey.label}، نمره انتخاب صحیح: ${evalCorrect.score}، نمره انتخاب غلط: ${evalWrong.score}`)
}

// --------------------------------------------------------------------------
// سناریوی ۳: پاسخ صحیح در گزینه ۳ باشد (index 2)
// --------------------------------------------------------------------------
{
  const q: ExamQuestion = {
    id: 'q_idx2',
    type: 'multiple_choice',
    question: 'نوع کدام جمله عاطفی است؟',
    options: ['الف: خبری', 'ب: امری', 'ج: عاطفی', 'د: پرسشی'],
    correctAnswer: 2,
    correctOptionText: 'عاطفی',
    points: 2,
  }

  const resKey = resolveCorrectOptionIndex(q)
  const evalCorrect = evaluateMultipleChoice(q, { selectedOption: 2, selectedOptionText: 'ج: عاطفی' })
  const evalWrong = evaluateMultipleChoice(q, { selectedOption: 0, selectedOptionText: 'الف: خبری' })

  const ok = resKey.isValid && resKey.index === 2 && evalCorrect.score === 2 && evalCorrect.status === 'correct' && evalWrong.score === 0
  assertTest(ok, 3, 'پاسخ صحیح در گزینه ۳ (index 2)', `کلید: ${resKey.label}، نمره انتخاب صحیح: ${evalCorrect.score}، نمره انتخاب غلط: ${evalWrong.score}`)
}

// --------------------------------------------------------------------------
// سناریوی ۴: پاسخ صحیح در گزینه ۴ باشد (index 3)
// --------------------------------------------------------------------------
{
  const q: ExamQuestion = {
    id: 'q_idx3',
    type: 'multiple_choice',
    question: 'مرکز استان اصفهان کدام شهر است؟',
    options: ['شیراز', 'تبریز', 'مشهد', 'اصفهان'],
    correctAnswer: 3,
    correctOptionText: 'اصفهان',
    points: 2,
  }

  const resKey = resolveCorrectOptionIndex(q)
  const evalCorrect = evaluateMultipleChoice(q, { selectedOption: 3, selectedOptionText: 'اصفهان' })
  const evalWrong = evaluateMultipleChoice(q, { selectedOption: 2, selectedOptionText: 'مشهد' })

  const ok = resKey.isValid && resKey.index === 3 && evalCorrect.score === 2 && evalCorrect.status === 'correct' && evalWrong.score === 0
  assertTest(ok, 4, 'پاسخ صحیح در گزینه ۴ (index 3)', `کلید: ${resKey.label}، نمره انتخاب صحیح: ${evalCorrect.score}، نمره انتخاب غلط: ${evalWrong.score}`)
}

// --------------------------------------------------------------------------
// سناریوی ۵: گزینه‌ها جابه‌جا شوند اما پاسخ صحیح کماکان درست تشخیص داده شود
// --------------------------------------------------------------------------
{
  // سوال اولیه: پاسخ صحیح "عاطفی" در گزینه ۳ بود
  // حال گزینه‌ها جابه‌جا شده‌اند و "عاطفی" در گزینه ۱ قرار گرفته است!
  const qShuffled: ExamQuestion = {
    id: 'q_shuffled',
    type: 'multiple_choice',
    question: 'نوع کدام جمله عاطفی است؟',
    options: ['ج: عاطفی', 'الف: خبری', 'ب: امری', 'د: پرسشی'],
    correctAnswer: 'عاطفی',
    correctOptionText: 'عاطفی',
    points: 2,
  }

  const resKey = resolveCorrectOptionIndex(qShuffled)
  // دانش‌آموز بر اساس متن گزینه "عاطفی" را انتخاب کرده است، گرچه ایندکس قبلی ۲ بود
  const evalShuffled = evaluateMultipleChoice(qShuffled, {
    selectedOption: 2, // ایندکس قدیمی
    selectedOptionText: 'عاطفی', // متن انتخاب‌شده واقعی
  })

  const ok = resKey.isValid && resKey.index === 0 && evalShuffled.score === 2 && evalShuffled.status === 'correct'
  assertTest(ok, 5, 'جابه‌جایی گزینه‌ها و حفظ پاسخ صحیح (Position Independence)', `مکان جدید کلید: ${resKey.label}، نمره دانش‌آموز: ${evalShuffled.score}/2`)
}

// --------------------------------------------------------------------------
// سناریوی ۶: پاسخ دانش‌آموز بر اساس شناسه/متن گزینه مقایسه شود نه ایندکس نامعتبر
// --------------------------------------------------------------------------
{
  const q: ExamQuestion = {
    id: 'q_match_text',
    type: 'multiple_choice',
    question: 'کدام گزینه یک جمله امری است؟',
    options: [
      'الف: امروز هوا بسیار لطیف و پاکیزه است',
      'ب: آیا فردا به مدرسه میروی؟',
      'ج: به سخنان آموزگار با دقت گوش فرا بده',
      'د: چه گل زیبایی!',
    ],
    correctAnswer: 'به سخنان آموزگار با دقت گوش فرا بده',
    points: 2,
  }

  // فرض کنیم سیستم دانش‌آموز به دلیل ناهمگام شدن ایندکس، عدد ۰ را ثبت کرده اما متن گزینه صحیح «به سخنان آموزگار با دقت گوش فرا بده» را به درستی همراه دارد
  const evalByText = evaluateMultipleChoice(q, {
    selectedOption: 0, // ایندکس اشتباه
    selectedOptionText: 'به سخنان آموزگار با دقت گوش فرا بده', // متن کاملاً صحیح
  })

  const ok = evalByText.score === 2 && evalByText.status === 'correct'
  assertTest(ok, 6, 'مقایسه بر اساس متن و ماهیت گزینه به جای ایندکس ناهمگام', `نمره با وجود ایندکس ناهمگام: ${evalByText.score}/2 (وضعیت: ${evalByText.status})`)
}

// --------------------------------------------------------------------------
// سناریوی ۷: سوال ایجادشده با هوش مصنوعی پس از ذخیره و لود مجدد، پاسخ صحیح خود را حفظ کند
// --------------------------------------------------------------------------
{
  // شبیه‌سازی خروجی هوش مصنوعی
  const aiGeneratedQ: ExamQuestion = {
    id: 'ai_q_1',
    type: 'multiple_choice',
    question: 'واحد اندازه‌گیری حجم مایعات در پایه ششم چیست؟',
    options: ['متر مربع', 'لیتر و میلی‌لیتر', 'کیلوگرم', 'سانتی‌متر'],
    correctAnswer: 1,
    correctOptionIndex: 1,
    correctOptionText: 'لیتر و میلی‌لیتر',
    rubricOrHint: 'پاسخ صحیح گزینه ۲ (لیتر و میلی‌لیتر) است.',
    points: 2,
  }

  // شبیه‌سازی JSON.stringify و JSON.parse (ذخیره در دیتابیس Supabase و بارگذاری مجدد)
  const serialized = JSON.stringify(aiGeneratedQ)
  const reloadedQ: ExamQuestion = JSON.parse(serialized)

  const resAfterReload = resolveCorrectOptionIndex(reloadedQ)
  const evalStudent = evaluateMultipleChoice(reloadedQ, { selectedOption: 1, selectedOptionText: 'لیتر و میلی‌لیتر' })

  const ok = resAfterReload.isValid && resAfterReload.index === 1 && evalStudent.score === 2 && evalStudent.status === 'correct'
  assertTest(ok, 7, 'پایداری کلید هوش مصنوعی پس از ذخیره در دیتابیس و بارگذاری مجدد', `کلید پس از لود مجدد: ${resAfterReload.label} (${resAfterReload.text})، نمره: ${evalStudent.score}`)
}

// --------------------------------------------------------------------------
// سناریوی ۸: سوالات قدیمی بدون ساختار جدید همچنان درست کار کنند (Backward Compatibility)
// --------------------------------------------------------------------------
{
  // سوال قدیمی بدون correctOptionText یا correctOptionIndex (تنها با حروف الف یا شماره)
  const legacyQ1: ExamQuestion = {
    id: 'legacy_1',
    type: 'multiple_choice',
    question: 'کدام کلمه جمع مکسر است؟',
    options: ['معلمان', 'کتاب‌ها', 'علما', 'دانش‌آموزان'],
    correctAnswer: 'علما', // ذخیره به صورت متن مستقیم قدیمی
    points: 2,
  }

  const legacyQ2: ExamQuestion = {
    id: 'legacy_2',
    type: 'multiple_choice',
    question: 'کدام کلمه مترادف «شادمان» است؟',
    options: ['غمگین', 'خوشحال', 'خسته', 'ناراحت'],
    correctAnswer: 'ب', // ذخیره به صورت حرف فارسی قدیمی
    points: 2,
  }

  const res1 = resolveCorrectOptionIndex(legacyQ1)
  const res2 = resolveCorrectOptionIndex(legacyQ2)

  const ok = res1.isValid && res1.index === 2 && res2.isValid && res2.index === 1
  assertTest(ok, 8, 'سازگاری کامل با فرمت‌های سنتی و آزمون‌های قدیمی', `Legacy 1 index: ${res1.index} (علما)، Legacy 2 index: ${res2.index} (ب: خوشحال)`)
}

// --------------------------------------------------------------------------
// سناریوی ۹: پاسخ خالی یا نامعتبر نمره نگیرد
// --------------------------------------------------------------------------
{
  const q: ExamQuestion = {
    id: 'q_empty_test',
    type: 'multiple_choice',
    question: 'کدام گزینه مضرب مشترک ۳ و ۴ است؟',
    options: ['۷', '۱۰', '۱۲', '۱۵'],
    correctAnswer: 2,
    correctOptionText: '۱۲',
    points: 2,
  }

  const evalEmpty = evaluateMultipleChoice(q, null)
  const evalUndefined = evaluateMultipleChoice(q, { selectedOption: undefined })
  const evalInvalidNum = evaluateMultipleChoice(q, { selectedOption: -1 })
  const evalOutOfBounds = evaluateMultipleChoice(q, { selectedOption: 99 })

  const ok = evalEmpty.score === 0 && evalUndefined.score === 0 && evalInvalidNum.score === 0 && evalOutOfBounds.score === 0
  assertTest(ok, 9, 'عدم اعطای نمره به پاسخ‌های خالی، نامعتبر یا خارج از محدوده', `نمرات: empty=${evalEmpty.score}, undef=${evalUndefined.score}, -1=${evalInvalidNum.score}, 99=${evalOutOfBounds.score}`)
}

// --------------------------------------------------------------------------
// سناریوی ۱۰: مجموع نمرات با بارم سوالات همخوانی داشته باشد و هیچ NaN تولید نشود
// --------------------------------------------------------------------------
{
  const exam = {
    id: 'full_exam_test',
    title: 'آزمون جامع ریاضی و فارسی ششم',
    totalPoints: 10,
    questions: [
      { id: 'q1', type: 'multiple_choice' as const, question: 'سوال ۱', options: ['الف', 'ب', 'ج', 'د'], correctAnswer: 0, points: 2.5 },
      { id: 'q2', type: 'multiple_choice' as const, question: 'سوال ۲', options: ['الف', 'ب', 'ج', 'د'], correctAnswer: 2, points: 2.5 },
      { id: 'q3', type: 'fill_in_the_blank' as const, question: 'سوال ۳ با جای خالی ............', correctAnswer: 'بزرگتر', points: 2.5 },
      { id: 'q4', type: 'descriptive' as const, question: 'سوال ۴ تشریحی', rubricOrHint: 'پاسخ کامل', points: 2.5 },
    ],
  }

  const answers = {
    q1: { selectedOption: 0, selectedOptionText: 'الف' }, // درست (2.5)
    q2: { selectedOption: 2, selectedOptionText: 'ج' }, // درست (2.5)
    q3: { textAnswer: 'بیشتر' }, // هم‌معنی درست (2.5)
    q4: { textAnswer: 'پاسخ تشریحی کامل دانش‌آموز' }, // ارزیابی تشریحی
  }

  const result = evaluateEntireExamSubmission(exam, answers)

  const hasNoNaN =
    !isNaN(result.earnedPoints) &&
    !isNaN(result.maxPoints) &&
    !isNaN(result.percentage) &&
    !isNaN(result.scaledScore20) &&
    Object.values(result.questionScores).every((s) => !isNaN(s))

  const totalPointsMatch = result.maxPoints === 10
  const scoresBounded = result.earnedPoints <= result.maxPoints && result.scaledScore20 <= 20

  const ok = hasNoNaN && totalPointsMatch && scoresBounded
  assertTest(ok, 10, 'تطابق مجموع نمرات با بارم آزمون و ریشه‌کنی مطلق هرگونه NaN', `کسب‌شده: ${result.earnedPoints} از ${result.maxPoints} (مقیاس ۲۰: ${result.scaledScore20}) - صفر NaN`)
}

// --------------------------------------------------------------------------
// سناریوهای تکمیلی: آزمون اختصاصی ۳ مورد واقعی گزارش‌شده توسط کاربر
// --------------------------------------------------------------------------
console.log('\n--------------------------------------------------------------------')
console.log('🔍 بررسی و حل قطعی ۳ خطای واقعی گزارش‌شده در گزارش آزمون:')
console.log('--------------------------------------------------------------------')

// مورد واقعی ۱: دانش‌آموز گزینه ۳ «عاطفی» را انتخاب کرد؛ سیستم گزینه «الف: خبری» را صحیح اعلام می‌کرد!
{
  const qReal1: ExamQuestion = {
    id: 'real_q1',
    type: 'multiple_choice',
    question: 'نوع کدام جمله عاطفی است؟',
    options: ['الف: خبری', 'ب: امری', 'ج: عاطفی', 'د: پرسشی'],
    correctAnswer: 'عاطفی',
    correctOptionText: 'عاطفی',
    points: 2,
  }

  const resKey = resolveCorrectOptionIndex(qReal1)
  const evalStudent = evaluateMultipleChoice(qReal1, {
    selectedOption: 2, // گزینه ۳ (ایندکس ۲)
    selectedOptionText: 'عاطفی',
  })

  const ok = resKey.index === 2 && evalStudent.score === 2 && evalStudent.status === 'correct'
  assertTest(ok, 11, 'رفع خطای گزارش واقعی ۱: تایید گزینه ۳ (عاطفی) و نمره کامل ۲/۲', `کلید شناسایی‌شده: ${resKey.label}، نمره دانش‌آموز: ${evalStudent.score}/2`)
}

// مورد واقعی ۲: دانش‌آموز گزینه ۳ «به سخنان آموزگار با دقت گوش فرا بده» را انتخاب کرد؛ سیستم گزینه «الف: امروز هوا بسیار لطیف...» را صحیح اعلام می‌کرد!
{
  const qReal2: ExamQuestion = {
    id: 'real_q2',
    type: 'multiple_choice',
    question: 'کدام گزینه یک جمله امری است؟',
    options: [
      'الف: امروز هوا بسیار لطیف و پاکیزه است',
      'ب: آیا فردا به مدرسه میروی؟',
      'ج: به سخنان آموزگار با دقت گوش فرا بده',
      'د: چه گل زیبایی!',
    ],
    correctAnswer: 'به سخنان آموزگار با دقت گوش فرا بده',
    correctOptionText: 'به سخنان آموزگار با دقت گوش فرا بده',
    points: 2,
  }

  const resKey = resolveCorrectOptionIndex(qReal2)
  const evalStudent = evaluateMultipleChoice(qReal2, {
    selectedOption: 2, // گزینه ۳ (ایندکس ۲)
    selectedOptionText: 'به سخنان آموزگار با دقت گوش فرا بده',
  })

  const ok = resKey.index === 2 && evalStudent.score === 2 && evalStudent.status === 'correct'
  assertTest(ok, 12, 'رفع خطای گزارش واقعی ۲: تایید گزینه ۳ (امری) و نمره کامل ۲/۲', `کلید شناسایی‌شده: ${resKey.label}، نمره دانش‌آموز: ${evalStudent.score}/2`)
}

// مورد واقعی ۳: دانش‌آموز گزینه ۲ «آیا سهراب کتاب شاهنامه را خواند؟» را انتخاب کرد؛ سیستم گزینه «الف: کاش سهراب...» را صحیح اعلام می‌کرد!
{
  const qReal3: ExamQuestion = {
    id: 'real_q3',
    type: 'multiple_choice',
    question: 'کدام جمله پرسشی است؟',
    options: [
      'الف: کاش سهراب کتاب شاهنامه را بخواند!',
      'ب: آیا سهراب کتاب شاهنامه را خواند؟',
      'ج: سهراب کتاب شاهنامه را خواند.',
      'د: سهراب، کتاب شاهنامه را بخوان!',
    ],
    correctAnswer: 'آیا سهراب کتاب شاهنامه را خواند؟',
    correctOptionText: 'آیا سهراب کتاب شاهنامه را خواند؟',
    points: 2,
  }

  const resKey = resolveCorrectOptionIndex(qReal3)
  const evalStudent = evaluateMultipleChoice(qReal3, {
    selectedOption: 1, // گزینه ۲ (ایندکس ۱)
    selectedOptionText: 'آیا سهراب کتاب شاهنامه را خواند؟',
  })

  const ok = resKey.index === 1 && evalStudent.score === 2 && evalStudent.status === 'correct'
  assertTest(ok, 13, 'رفع خطای گزارش واقعی ۳: تایید گزینه ۲ (پرسشی) و نمره کامل ۲/۲', `کلید شناسایی‌شده: ${resKey.label}، نمره دانش‌آموز: ${evalStudent.score}/2`)
}

// --------------------------------------------------------------------------
// چاپ نتایج نهایی
// --------------------------------------------------------------------------
console.log('\n====================================================================')
console.log('📊 نتایج نهایی اجرای آزمون‌ها:')
console.log('====================================================================')
let passedCount = 0
for (const r of testResults) {
  if (r.passed) passedCount++
  console.log(`${r.passed ? '✅' : '❌'} تست ${r.num}: ${r.title}`)
  console.log(`   ${r.details}`)
}

console.log('\n--------------------------------------------------------------------')
console.log(`نتیجه کل: ${passedCount} از ${testResults.length} آزمون با موفقیت پاس شدند.`)
if (passedCount === testResults.length) {
  console.log('🎉 تمامی تست‌های ده‌گانه و سناریوهای واقعی گزارش‌شده با موفقیت ۱۰۰٪ پاس شدند!')
} else {
  console.error('⚠️ برخی تست‌ها ناموفق بودند.')
  process.exit(1)
}

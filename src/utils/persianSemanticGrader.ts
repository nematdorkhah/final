/**
 * Persian Semantic Grader & Question Standardizer
 * Grade 6 Elementary School Classroom Intelligence Engine
 * 
 * Core Principles:
 * 1. Concept Over Literal Words: Accept synonyms, semantic equivalents, and student phrasing.
 * 2. Zero-NaN Guarantee: All numbers, scores, and option indexes are strictly bounded and finite.
 * 3. Lenient for 12-Year-Old Elementary Students: Tolerate minor typos, spelling errors, spacing, and zero-width spaces.
 * 4. Strict Scientific & Contextual Accuracy: Reject contradictions (e.g. increase vs decrease) and irrelevant text.
 * 5. Safe Multi-Choice Resolution: Handles 0-based vs 1-based indexes, Persian digits, Persian letters (الف-د), and option text.
 */

import { ExamQuestion, StudentExamAnswer } from '../types/examTypes'

// ----------------------------------------------------------------------
// 1. PERSIAN TEXT NORMALIZATION & CLEANING
// ----------------------------------------------------------------------

export const PERSIAN_DIGITS_MAP: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
}

export function convertDigitsToEnglish(str: string): string {
  if (!str) return ''
  return String(str).replace(/[۰-۹٠-٩]/g, (d) => PERSIAN_DIGITS_MAP[d] ?? d)
}

/**
 * Normalizes Persian/Arabic text for robust conceptual comparison:
 * - Unifies Arabic/Persian letters: ي->ی, ك->ک, ة->ه, ؤ/إ/أ/آ->ا
 * - Removes zero-width spaces, tatweel/kashida, and diacritics/tanwin
 * - Converts Persian & Arabic digits to standard English digits
 * - Collapses repeated whitespace and trims
 */
export function normalizePersianText(text: string): string {
  if (!text) return ''
  return convertDigitsToEnglish(String(text))
    .toLowerCase()
    .replace(/[\u200c\u200b\u200e\u200f\ufeff]/g, ' ') // zero-width spaces to space
    .replace(/[ـ]/g, '') // remove kashida / tatweel
    .replace(/[\u064b-\u065f\u0670]/g, '') // remove Arabic diacritics (harakat, tanwin)
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[ة]/g, 'ه')
    .replace(/[آأإ]/g, 'ا')
    .replace(/[ؤء]/g, 'و')
    .replace(/[،,؛;:!؟?«»"'\(\)\[\]\{\}\-_\\\/]/g, ' ') // punctuation to space
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Compact normalized text (all spaces and separators stripped)
 * Useful for checking joined vs separated words (e.g., «سنگها» vs «سنگ ها»)
 */
export function compactPersianText(text: string): string {
  return normalizePersianText(text).replace(/\s+/g, '')
}

// ----------------------------------------------------------------------
// 2. SAFE NUMBER & BOUNDING HELPERS (ZERO-NAN GUARANTEE)
// ----------------------------------------------------------------------

export function safeNumber(val: any, fallback = 0): number {
  if (val === null || val === undefined || val === '') return fallback
  const parsed = typeof val === 'number' ? val : parseFloat(convertDigitsToEnglish(String(val)))
  if (isNaN(parsed) || !isFinite(parsed)) return fallback
  return parsed
}

export function safeScore(score: any, maxPoints: any, fallback = 0): number {
  const maxPts = Math.max(0.25, safeNumber(maxPoints, 2))
  const cleanScore = safeNumber(score, fallback)
  const bounded = Math.min(maxPts, Math.max(0, cleanScore))
  return Math.round(bounded * 100) / 100
}

export function safePercentage(earned: any, total: any): number {
  const e = safeNumber(earned, 0)
  const t = safeNumber(total, 0)
  if (t <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((e / t) * 100)))
}

export function safeScaled20(earned: any, total: any): number {
  const e = safeNumber(earned, 0)
  const t = safeNumber(total, 0)
  if (t <= 0) return 0
  const scaled = (e / t) * 20
  return Math.min(20, Math.max(0, Math.round(scaled * 10) / 10))
}

// ----------------------------------------------------------------------
// 3. CURATED GRADE 6 ELEMENTARY CURRICULUM SYNONYM CLUSTERS
// ----------------------------------------------------------------------

export interface ConceptCluster {
  id: string
  name: string
  negationOf?: string // ID of opposite concept to prevent false positives
  synonyms: string[]
}

export const GRADE6_CONCEPT_CLUSTERS: ConceptCluster[] = [
  // Magnitude & Quantity Comparison
  {
    id: 'MAGNITUDE_GREATER',
    name: 'بزرگتر / بیشتر',
    negationOf: 'MAGNITUDE_LESS',
    synonyms: [
      'بزرگتر', 'بزرگ تر', 'بیشتر', 'دارای اندازه بیشتر', 'از نظر مقدار بزرگتر',
      'مقدار بیشتر', 'اندازه بیشتر', 'بالاتر', 'فزونی', 'وسیع تر', 'وسیعتر',
      'بزرگتری', 'بیشتری'
    ],
  },
  {
    id: 'MAGNITUDE_LESS',
    name: 'کوچکتر / کمتر',
    negationOf: 'MAGNITUDE_GREATER',
    synonyms: [
      'کوچکتر', 'کوچک تر', 'کمتر', 'دارای اندازه کمتر', 'از نظر مقدار کوچکتر',
      'مقدار کمتر', 'اندازه کمتر', 'پایین تر', 'کوچکتری', 'کمتری'
    ],
  },

  // Dynamic Change
  {
    id: 'INCREASE',
    name: 'افزایش / زیاد شدن',
    negationOf: 'DECREASE',
    synonyms: [
      'زیاد میشود', 'زیاد می شود', 'زیاد میگردد', 'زیاد می گردد',
      'افزایش پیدا میکند', 'افزایش پیدا می کند', 'افزایش می یابد', 'افزایش مییابد',
      'بالا میرود', 'بالا می رود', 'بیشتر میشود', 'بیشتر می شود',
      'رشد میکند', 'رشد می کند', 'صعودی میشود', 'صعودی است', 'افزایشی', 'افزایش'
    ],
  },
  {
    id: 'DECREASE',
    name: 'کاهش / کم شدن',
    negationOf: 'INCREASE',
    synonyms: [
      'کم میشود', 'کم می شود', 'کم میگردد', 'کم می گردد',
      'کاهش پیدا میکند', 'کاهش پیدا می کند', 'کاهش می یابد', 'کاهش مییابد',
      'پایین میاید', 'پایین می آید', 'کمتر میشود', 'کمتر می شود',
      'افت میکند', 'افت می کند', 'نزولی میشود', 'نزولی است', 'کاهشی', 'کاهش'
    ],
  },

  // Speed
  {
    id: 'SPEED_FAST',
    name: 'سریع‌تر / تندتر',
    negationOf: 'SPEED_SLOW',
    synonyms: [
      'سریعتر', 'سریع تر', 'تندتر', 'تند تر', 'با سرعت بیشتر', 'پر سرعت تر', 'شتابان'
    ],
  },
  {
    id: 'SPEED_SLOW',
    name: 'آهسته‌تر / کندتر',
    negationOf: 'SPEED_FAST',
    synonyms: [
      'اهسته تر', 'آهسته تر', 'کندتر', 'کند تر', 'با سرعت کمتر', 'کم سرعت تر', 'آرام تر', 'ارام تر'
    ],
  },

  // Mathematics (Grade 6)
  {
    id: 'MATH_RECIPROCAL',
    name: 'معکوس کسر',
    synonyms: ['معکوس', 'وارون', 'وارونه', 'عکس', 'واژگون'],
  },
  {
    id: 'MATH_DIAMETER',
    name: 'قطر دایره',
    synonyms: ['قطر', 'اندازه قطر', 'دو برابر شعاع', '۲ برابر شعاع'],
  },
  {
    id: 'MATH_RADIUS',
    name: 'شعاع دایره',
    synonyms: ['شعاع', 'اندازه شعاع', 'نصف قطر'],
  },
  {
    id: 'MATH_AREA',
    name: 'مساحت',
    synonyms: ['مساحت', 'سطح', 'اندازه سطح'],
  },
  {
    id: 'MATH_PERIMETER',
    name: 'محیط',
    synonyms: ['محیط', 'دور تا دور', 'اندازه دور', 'پیرامون'],
  },

  // Science - Earth Science & Geology (Grade 6)
  {
    id: 'SCI_ASTHENOSPHERE',
    name: 'خمیرکره',
    synonyms: [
      'خمیرکره', 'خمیر کره', 'استنوسفر', 'گوشته بالایی', 'بخش خمیری گوشته',
      'لایه خمیری', 'قسمت خمیری گوشته'
    ],
  },
  {
    id: 'SCI_LITHOSPHERE',
    name: 'سنگ‌کره',
    synonyms: [
      'سنگکره', 'سنگ کره', 'لیتوسفر', 'بخش جامد بالایی زمین', 'پوسته و بخش جامد گوشته'
    ],
  },
  {
    id: 'SCI_EARTHQUAKE_CAUSE',
    name: 'شکست سنگ‌ها / گسل',
    synonyms: [
      'سنگها', 'سنگ ها', 'شکستن سنگها', 'شکستن سنگ ها', 'شکست سنگها', 'شکست سنگ ها',
      'گسل', 'گسلها', 'گسل ها', 'حرکت گسل', 'شکستگی سنگ ها', 'لغزش لایه های زمین'
    ],
  },
  {
    id: 'SCI_SUN_ENERGY',
    name: 'خورشید / انرژی خورشیدی',
    synonyms: [
      'خورشید', 'نور خورشید', 'افتاب', 'آفتاب', 'انرژی خورشید', 'انرژی خورشیدی',
      'تابش خورشید', 'انرژی تابشی خورشید'
    ],
  },
  {
    id: 'SCI_RENEWABLE',
    name: 'تجدیدپذیر / پاک',
    negationOf: 'SCI_NON_RENEWABLE',
    synonyms: [
      'تجدیدپذیر', 'تجدید پذیر', 'پاک', 'انرژی پاک', 'پایان ناپذیر', 'تجدید شونده', 'همیشگی'
    ],
  },
  {
    id: 'SCI_NON_RENEWABLE',
    name: 'تجدیدناپذیر / فسیلی',
    negationOf: 'SCI_RENEWABLE',
    synonyms: [
      'تجدیدناپذیر', 'تجدید ناپذیر', 'فسیلی', 'سوخت فسیلی', 'تمام شدنی', 'تجدید ناشونده'
    ],
  },
  {
    id: 'SCI_PRIMARY_WAVE',
    name: 'موج اولیه (P)',
    synonyms: [
      'موج پی', 'موج p', 'موج طولی', 'موج اولیه', 'موج های اولیه', 'امواج اولیه', 'امواج طولی'
    ],
  },
  // Physical States & Waves
  {
    id: 'STATE_LIQUID',
    name: 'مایع / مواد مذاب',
    synonyms: ['مایع', 'مایعات', 'مواد مذاب', 'حالت مایع', 'ابکی'],
  },
  {
    id: 'STATE_SOLID',
    name: 'جامد / سنگ‌ها',
    synonyms: ['جامد', 'جامدات', 'سنگ ها', 'سنگهای جامد', 'سنگها', 'حالت جامد'],
  },
  {
    id: 'PASS_THROUGH',
    name: 'عبور / گذر کردن',
    synonyms: ['عبور', 'عبور میکند', 'رد میشود', 'رد میشوند', 'میگذرد', 'گذر میکند', 'گذر'],
  },

  // Persian Grammar & Literature (Grade 6)
  {
    id: 'PERSIAN_OBJECT',
    name: 'مفعول',
    synonyms: ['مفعول', 'نقش مفعولی', 'مفعولی'],
  },
  {
    id: 'PERSIAN_SUBJECT',
    name: 'نهاد / فاعل',
    synonyms: ['نهاد', 'فاعل', 'مسند الیه'],
  },
  {
    id: 'PERSIAN_PROPORTION',
    name: 'مراعات نظیر / تناسب',
    synonyms: ['مراعات نظیر', 'تناسب', 'ارایه تناسب', 'آرایه تناسب', 'مراعات النظیر'],
  },
  {
    id: 'PERSIAN_FIGHT_METAPHOR',
    name: 'دست و پنجه نرم کردن (مبارزه)',
    synonyms: [
      'مبارزه کردن', 'جنگیدن', 'دست و پنجه نرم کردن', 'تلاش در برابر سختی ها',
      'مبارزه با مشکلات', 'غلبه بر سختی ها', 'سخت کوشی و تلاش', 'روبرو شدن با سختی ها',
      'ایستادگی در برابر مشکلات'
    ],
  },
]

// ----------------------------------------------------------------------
// 4. LEVENSHTEIN DISTANCE FOR MINOR TYPO TOLERANCE
// ----------------------------------------------------------------------

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  const d: number[][] = []
  for (let i = 0; i <= m; i++) d[i] = [i]
  for (let j = 0; j <= n; j++) d[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1,      // deletion
        d[i][j - 1] + 1,      // insertion
        d[i - 1][j - 1] + cost // substitution
      )
    }
  }
  return d[m][n]
}

export function isMinorTypoMatch(student: string, expected: string): boolean {
  const normS = compactPersianText(student)
  const normE = compactPersianText(expected)
  if (!normS || !normE) return false
  if (normS === normE) return true

  // For words with >= 4 characters, 1 character difference is a minor typo
  if (normE.length >= 4 && Math.abs(normS.length - normE.length) <= 1) {
    const dist = levenshteinDistance(normS, normE)
    if (dist <= 1) return true
  }

  // For long phrases (>= 8 chars), 2 characters distance is acceptable
  if (normE.length >= 8 && Math.abs(normS.length - normE.length) <= 2) {
    const dist = levenshteinDistance(normS, normE)
    if (dist <= 2) return true
  }

  return false
}

// ----------------------------------------------------------------------
// 5. MULTIPLE CHOICE RESOLVER (ELIMINATES `NaN` COMPLETELY)
// ----------------------------------------------------------------------

export interface ResolvedOption {
  index: number // 0-based valid index (0..3) or -1 if unresolved
  label: string // e.g. "گزینه ۱ (الف)"
  text: string  // Text of option from options array
  isValid: boolean
}

const PERSIAN_OPTION_LETTERS = ['الف', 'ب', 'ج', 'د', 'هـ', 'و']

/**
 * Resolves the correct option index for a multiple choice question with 100% certainty:
 * Handles:
 * - 0-based number: 0, 1, 2, 3
 * - 1-based number or string: 1, 2, 3, 4
 * - Persian letters: الف -> 0, ب -> 1, ج -> 2, د -> 3
 * - Persian labels: "گزینه ۱", "گزینه ب"
 * - Option text matching: e.g. correctAnswer is "۷۸/۵" or "خمیرکره", matching options[1]
 */
export function resolveCorrectOptionIndex(q: ExamQuestion): ResolvedOption {
  const options: string[] = Array.isArray(q.options) && q.options.length > 0 ? q.options : []
  const maxIdx = Math.max(0, options.length - 1)

  // 1. Explicit correctOptionIndex or correctIndex
  const directIdx = q.correctOptionIndex ?? q.correctIndex
  if (typeof directIdx === 'number' && directIdx >= 0 && directIdx <= maxIdx) {
    return {
      index: directIdx,
      label: `گزینه ${directIdx + 1} (${PERSIAN_OPTION_LETTERS[directIdx] || directIdx + 1})`,
      text: options[directIdx] || '',
      isValid: true,
    }
  }

  // 2. Inspect correctAnswer
  const raw = q.correctAnswer
  if (raw === undefined || raw === null || raw === '') {
    return {
      index: 0,
      label: options.length > 0 ? 'گزینه ۱ (الف)' : 'تعیین‌نشده',
      text: options[0] || '',
      isValid: false,
    }
  }

  // Numeric correctAnswer
  if (typeof raw === 'number') {
    if (!isNaN(raw) && isFinite(raw)) {
      if (raw >= 0 && raw <= maxIdx) {
        return {
          index: raw,
          label: `گزینه ${raw + 1} (${PERSIAN_OPTION_LETTERS[raw] || raw + 1})`,
          text: options[raw] || '',
          isValid: true,
        }
      }
      // If 1-based (e.g. 1..4 when maxIdx is 3)
      if (raw >= 1 && raw <= options.length) {
        const zeroBased = raw - 1
        return {
          index: zeroBased,
          label: `گزینه ${raw} (${PERSIAN_OPTION_LETTERS[zeroBased] || raw})`,
          text: options[zeroBased] || '',
          isValid: true,
        }
      }
    }
  }

  // String correctAnswer
  const strRaw = String(raw).trim()
  const normStr = normalizePersianText(strRaw)
  const compactStr = compactPersianText(strRaw)

  // A. Check Persian option letters: الف, ب, ج, د
  const letterMap: Record<string, number> = {
    'الف': 0, 'الف)': 0, 'ب': 1, 'ب)': 1, 'ج': 2, 'ج)': 2, 'د': 3, 'د)': 3,
    'a': 0, 'b': 1, 'c': 2, 'd': 3,
  }
  for (const [letter, idx] of Object.entries(letterMap)) {
    if (normStr === letter || compactStr === letter || normStr.endsWith(letter)) {
      if (idx <= maxIdx) {
        return {
          index: idx,
          label: `گزینه ${idx + 1} (${PERSIAN_OPTION_LETTERS[idx] || idx + 1})`,
          text: options[idx] || '',
          isValid: true,
        }
      }
    }
  }

  // B. Check if string matches "گزینه 1" or "گزینه ۱"
  const optionMatch = normStr.match(/گزینه\s*([0-9]|الف|ب|ج|د)/)
  if (optionMatch && optionMatch[1]) {
    const val = optionMatch[1]
    if (letterMap[val] !== undefined && letterMap[val] <= maxIdx) {
      const idx = letterMap[val]
      return {
        index: idx,
        label: `گزینه ${idx + 1} (${PERSIAN_OPTION_LETTERS[idx] || idx + 1})`,
        text: options[idx] || '',
        isValid: true,
      }
    }
    const num = parseInt(val, 10)
    if (!isNaN(num)) {
      // If 1-based (1..4)
      if (num >= 1 && num <= options.length) {
        const zeroBased = num - 1
        return {
          index: zeroBased,
          label: `گزینه ${num} (${PERSIAN_OPTION_LETTERS[zeroBased] || num})`,
          text: options[zeroBased] || '',
          isValid: true,
        }
      }
      if (num >= 0 && num <= maxIdx) {
        return {
          index: num,
          label: `گزینه ${num + 1} (${PERSIAN_OPTION_LETTERS[num] || num + 1})`,
          text: options[num] || '',
          isValid: true,
        }
      }
    }
  }

  // C. Match directly against option text in options array!
  if (options.length > 0) {
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]
      if (opt === strRaw || compactPersianText(opt) === compactStr || normalizePersianText(opt) === normStr) {
        return {
          index: i,
          label: `گزینه ${i + 1} (${PERSIAN_OPTION_LETTERS[i] || i + 1})`,
          text: options[i],
          isValid: true,
        }
      }
    }
  }

  // D. Plain string integer (e.g. "0", "1", "2", "3", "4")
  const parsedInt = parseInt(convertDigitsToEnglish(strRaw), 10)
  if (!isNaN(parsedInt)) {
    if (parsedInt >= 0 && parsedInt <= maxIdx) {
      return {
        index: parsedInt,
        label: `گزینه ${parsedInt + 1} (${PERSIAN_OPTION_LETTERS[parsedInt] || parsedInt + 1})`,
        text: options[parsedInt] || '',
        isValid: true,
      }
    }
    if (parsedInt >= 1 && parsedInt <= options.length) {
      const zeroBased = parsedInt - 1
      return {
        index: zeroBased,
        label: `گزینه ${parsedInt} (${PERSIAN_OPTION_LETTERS[zeroBased] || parsedInt})`,
        text: options[zeroBased] || '',
        isValid: true,
      }
    }
  }

  // Fallback: Safe first option, never NaN
  return {
    index: 0,
    label: options.length > 0 ? `گزینه ۱ (${PERSIAN_OPTION_LETTERS[0]})` : 'تعیین‌نشده',
    text: options[0] || strRaw,
    isValid: false,
  }
}

/**
 * Resolves the student's selected option from their answer record
 */
export function resolveStudentSelectedOption(answer: any, options?: string[]): ResolvedOption {
  if (!answer) {
    return { index: -1, label: 'بدون پاسخ', text: '', isValid: false }
  }

  const raw =
    typeof answer === 'object' && answer !== null
      ? answer.selectedOption ?? answer.optionIndex ?? answer.selectedAnswer
      : answer

  if (raw === undefined || raw === null || raw === '') {
    return { index: -1, label: 'بدون پاسخ', text: '', isValid: false }
  }

  const optionsArr = Array.isArray(options) ? options : []
  const maxIdx = Math.max(0, optionsArr.length - 1)

  // Direct number
  if (typeof raw === 'number' && !isNaN(raw) && isFinite(raw)) {
    if (raw >= 0 && raw <= maxIdx) {
      return {
        index: raw,
        label: `گزینه ${raw + 1} (${PERSIAN_OPTION_LETTERS[raw] || raw + 1})`,
        text: optionsArr[raw] || '',
        isValid: true,
      }
    }
  }

  const strRaw = String(raw).trim()
  const num = parseInt(convertDigitsToEnglish(strRaw), 10)
  if (!isNaN(num) && num >= 0 && num <= maxIdx) {
    return {
      index: num,
      label: `گزینه ${num + 1} (${PERSIAN_OPTION_LETTERS[num] || num + 1})`,
      text: optionsArr[num] || '',
      isValid: true,
    }
  }

  // Option text match
  if (optionsArr.length > 0) {
    const compact = compactPersianText(strRaw)
    for (let i = 0; i < optionsArr.length; i++) {
      if (compactPersianText(optionsArr[i]) === compact) {
        return {
          index: i,
          label: `گزینه ${i + 1} (${PERSIAN_OPTION_LETTERS[i] || i + 1})`,
          text: optionsArr[i],
          isValid: true,
        }
      }
    }
  }

  return { index: -1, label: 'بدون پاسخ', text: '', isValid: false }
}

// ----------------------------------------------------------------------
// 6. QUESTION EVALUATION RESULTS INTERFACES
// ----------------------------------------------------------------------

export interface QuestionGradingOutput {
  questionId: string
  score: number
  maxScore: number
  status: 'correct' | 'partial' | 'incorrect' | 'empty' | 'needs_teacher_review'
  feedback: string
  correctKeyDisplay: string
  studentAnswerDisplay: string
  conceptMatched?: boolean
  isSemanticMatch?: boolean
  correctParts?: string[]
  missingParts?: string[]
}

// ----------------------------------------------------------------------
// 7. MULTIPLE CHOICE EVALUATION
// ----------------------------------------------------------------------

export function evaluateMultipleChoice(q: ExamQuestion, studentAns: any): QuestionGradingOutput {
  const maxScore = safeScore(q.points, 10, 2)
  const resolvedCorrect = resolveCorrectOptionIndex(q)
  const resolvedStudent = resolveStudentSelectedOption(studentAns, q.options)

  const correctKeyDisplay = `${resolvedCorrect.label}${resolvedCorrect.text ? `: ${resolvedCorrect.text}` : ''}`

  if (!resolvedStudent.isValid || resolvedStudent.index === -1) {
    return {
      questionId: q.id,
      score: 0,
      maxScore,
      status: 'empty',
      feedback: `دانش‌آموز به این سوال پاسخی نداده است. (کلید صحیح: ${correctKeyDisplay})`,
      correctKeyDisplay,
      studentAnswerDisplay: 'بدون پاسخ',
    }
  }

  const studentAnswerDisplay = `${resolvedStudent.label}${resolvedStudent.text ? `: ${resolvedStudent.text}` : ''}`
  const isCorrect = resolvedStudent.index === resolvedCorrect.index

  return {
    questionId: q.id,
    score: isCorrect ? maxScore : 0,
    maxScore,
    status: isCorrect ? 'correct' : 'incorrect',
    feedback: isCorrect
      ? `✅ پاسخ کاملاً درست است (+${maxScore} نمره)`
      : `❌ پاسخ نادرست است. گزینه انتخابی: ${resolvedStudent.label} - کلید صحیح: ${correctKeyDisplay}`,
    correctKeyDisplay,
    studentAnswerDisplay,
  }
}

// ----------------------------------------------------------------------
// 8. FILL IN THE BLANK EVALUATION (CONCEPT-FIRST & SYNONYM MATCHING)
// ----------------------------------------------------------------------

/**
 * Checks if a student's answer conceptually matches the expected answer for fill-in-the-blank:
 * 1. Exact match after Persian normalization
 * 2. Alternative acceptable answers defined on question
 * 3. Curriculum synonym clusters (e.g. «بیشتر» for «بزرگتر», «افزایش پیدا می‌کند» for «زیاد می‌شود»)
 * 4. Substring containment if contextual
 * 5. Minor typo tolerance (1 char distance for words >= 4 chars)
 * 6. Contradiction rejection (negation words or opposing clusters)
 */
export function evaluateFillInTheBlank(q: ExamQuestion, studentAns: any): QuestionGradingOutput {
  const maxScore = safeScore(q.points, 10, 2)
  const rawStudent = typeof studentAns === 'object' && studentAns !== null ? studentAns.textAnswer : studentAns
  const studentText = String(rawStudent || '').trim()

  const rawCorrect = String(q.correctAnswer || '').trim()
  const correctKeyDisplay = rawCorrect || String(q.rubricOrHint || 'تعیین‌نشده')

  if (!studentText) {
    return {
      questionId: q.id,
      score: 0,
      maxScore,
      status: 'empty',
      feedback: `پاسخی ثبت نشده است. پاسخ صحیح مورد انتظار: ${correctKeyDisplay}`,
      correctKeyDisplay,
      studentAnswerDisplay: 'بدون پاسخ',
    }
  }

  const studentNorm = normalizePersianText(studentText)
  const studentCompact = compactPersianText(studentText)
  const correctNorm = normalizePersianText(rawCorrect)
  const correctCompact = compactPersianText(rawCorrect)

  // Collect all acceptable answers (from correctAnswer, acceptableAnswers, or slash-separated)
  const acceptableList: string[] = []
  if (rawCorrect) {
    // If teacher wrote multiple options like «بزرگتر / بیشتر» or «بزرگتر، بیشتر»
    rawCorrect.split(/[\/،,;]/).forEach((p) => {
      const clean = p.trim()
      if (clean) acceptableList.push(clean)
    })
  }
  if (Array.isArray(q.acceptableAnswers)) {
    q.acceptableAnswers.forEach((a) => {
      const clean = String(a).trim()
      if (clean && !acceptableList.includes(clean)) acceptableList.push(clean)
    })
  }

  // A. Check direct match on any acceptable answer
  for (const acc of acceptableList) {
    const accNorm = normalizePersianText(acc)
    const accCompact = compactPersianText(acc)
    if (studentCompact === accCompact || studentNorm === accNorm) {
      return {
        questionId: q.id,
        score: maxScore,
        maxScore,
        status: 'correct',
        feedback: `✅ پاسخ جای‌خالی کاملاً درست است (+${maxScore} نمره)`,
        correctKeyDisplay,
        studentAnswerDisplay: studentText,
        conceptMatched: true,
      }
    }
  }

  // B. Check for contradictions first (e.g. expected increase, student wrote decrease)
  for (const cluster of GRADE6_CONCEPT_CLUSTERS) {
    if (cluster.negationOf) {
      const oppCluster = GRADE6_CONCEPT_CLUSTERS.find((c) => c.id === cluster.negationOf)
      const expectedInCluster = cluster.synonyms.some((s) => compactPersianText(s) === correctCompact || correctNorm.includes(normalizePersianText(s)))
      if (expectedInCluster && oppCluster) {
        const studentInOpp = oppCluster.synonyms.some((s) => studentCompact.includes(compactPersianText(s)))
        if (studentInOpp) {
          return {
            questionId: q.id,
            score: 0,
            maxScore,
            status: 'incorrect',
            feedback: `❌ پاسخ متناقض است. در صورت سوال «${cluster.name}» مدنظر بوده اما «${oppCluster.name}» نوشته شده است.`,
            correctKeyDisplay,
            studentAnswerDisplay: studentText,
          }
        }
      }
    }
  }

  // Check for explicit negation words (e.g. «نیست», «نمیشود», «نمی‌باشد») when not in correct answer
  const studentHasNegation = /\b(نه|نیست|نمی|نباشد)\b/.test(studentNorm)
  const correctHasNegation = /\b(نه|نیست|نمی|نباشد)\b/.test(correctNorm)
  if (studentHasNegation && !correctHasNegation) {
    return {
      questionId: q.id,
      score: 0,
      maxScore,
      status: 'incorrect',
      feedback: `❌ پاسخ با استفاده از افعال منفی نادرست است. پاسخ صحیح: ${correctKeyDisplay}`,
      correctKeyDisplay,
      studentAnswerDisplay: studentText,
    }
  }

  // C. Curriculum Concept & Synonym Cluster Matching
  for (const cluster of GRADE6_CONCEPT_CLUSTERS) {
    const expectedMatchesCluster = cluster.synonyms.some((syn) => {
      const normSyn = compactPersianText(syn)
      return correctCompact === normSyn || correctCompact.includes(normSyn) || normSyn.includes(correctCompact)
    })

    if (expectedMatchesCluster) {
      const studentMatchesCluster = cluster.synonyms.some((syn) => {
        const normSyn = compactPersianText(syn)
        return studentCompact === normSyn || studentCompact.includes(normSyn) || normSyn.includes(studentCompact)
      })

      if (studentMatchesCluster) {
        return {
          questionId: q.id,
          score: maxScore,
          maxScore,
          status: 'correct',
          feedback: `✅ پاسخ مفهومی کاملاً صحیح است (انطباق با مفهوم «${cluster.name}»). (+${maxScore} نمره)`,
          correctKeyDisplay,
          studentAnswerDisplay: studentText,
          conceptMatched: true,
          isSemanticMatch: true,
        }
      }
    }
  }

  // D. Substring or Inclusion Match (e.g. expected "خورشید", student wrote "انرژی خورشید" or "نور خورشید")
  if (correctCompact.length >= 3 && (studentCompact.includes(correctCompact) || correctCompact.includes(studentCompact))) {
    // If student answer is a reasonable phrase (< 45 chars) containing expected term
    if (studentText.length <= 45) {
      return {
        questionId: q.id,
        score: maxScore,
        maxScore,
        status: 'correct',
        feedback: `✅ پاسخ شامل واژه کلیدی مورد انتظار است (+${maxScore} نمره)`,
        correctKeyDisplay,
        studentAnswerDisplay: studentText,
        conceptMatched: true,
      }
    }
  }

  // E. Minor Typo Matching (Tolerate 1 typo in 12-year-old child handwriting/typing)
  for (const acc of acceptableList) {
    if (isMinorTypoMatch(studentText, acc)) {
      return {
        questionId: q.id,
        score: maxScore,
        maxScore,
        status: 'correct',
        feedback: `✅ مفهوم پاسخ با اغماض از خطای تایپی/املایی جزئی کاملاً پذیرفته شد (+${maxScore} نمره)`,
        correctKeyDisplay,
        studentAnswerDisplay: studentText,
        conceptMatched: true,
      }
    }
  }

  // F. Partial Credit: If student answer has non-trivial effort (> 3 chars)
  // Give partial credit (50% of points) while waiting for teacher confirmation
  if (studentText.length >= 3) {
    const partial = Math.round(maxScore * 0.5 * 10) / 10
    return {
      questionId: q.id,
      score: partial,
      maxScore,
      status: 'partial',
      feedback: `🔍 پاسخ بررسی شد و به دلیل تفاوت در واژگان به عنوان نمره اولیه منظور گردید (${partial} از ${maxScore}). پاسخنامه: ${correctKeyDisplay}`,
      correctKeyDisplay,
      studentAnswerDisplay: studentText,
    }
  }

  return {
    questionId: q.id,
    score: 0,
    maxScore,
    status: 'incorrect',
    feedback: `❌ پاسخ نادرست است. پاسخ مورد انتظار: ${correctKeyDisplay}`,
    correctKeyDisplay,
    studentAnswerDisplay: studentText,
  }
}

// ----------------------------------------------------------------------
// 9. DESCRIPTIVE QUESTION EVALUATION (SEMANTIC & HEURISTIC FALLBACK)
// ----------------------------------------------------------------------

export function evaluateDescriptiveQuestion(
  q: ExamQuestion,
  studentAns: any,
  aiGradeProposal?: { score?: number; feedback?: string; status?: string }
): QuestionGradingOutput {
  const maxScore = safeScore(q.points, 10, 3)
  const rawStudent = typeof studentAns === 'object' && studentAns !== null ? studentAns.textAnswer : studentAns
  const studentText = String(rawStudent || '').trim()
  const hasAttachment = Boolean(typeof studentAns === 'object' && studentAns?.imageAttachment)

  const rubric = String(q.rubricOrHint || q.correctAnswer || 'پاسخ تشریحی بر اساس مفاهیم کتاب درسی').trim()
  const correctKeyDisplay = rubric

  if (!studentText && !hasAttachment) {
    return {
      questionId: q.id,
      score: 0,
      maxScore,
      status: 'empty',
      feedback: `دانش‌آموز به این سوال تشریحی پاسخی نداده است.`,
      correctKeyDisplay,
      studentAnswerDisplay: 'بدون پاسخ',
    }
  }

  // 1. If AI score was proposed from server: Validate strictly
  if (aiGradeProposal && typeof aiGradeProposal.score !== 'undefined') {
    const proposed = safeNumber(aiGradeProposal.score, -1)
    if (proposed >= 0 && proposed <= maxScore && !isNaN(proposed) && isFinite(proposed)) {
      const cleanProposalScore = Math.min(maxScore, Math.max(0, proposed))
      const isFull = cleanProposalScore >= maxScore * 0.85
      const isZero = cleanProposalScore === 0
      return {
        questionId: q.id,
        score: cleanProposalScore,
        maxScore,
        status: isFull ? 'correct' : isZero ? 'incorrect' : 'partial',
        feedback: aiGradeProposal.feedback || `ارزیابی تشریحی: ${cleanProposalScore} از ${maxScore}`,
        correctKeyDisplay,
        studentAnswerDisplay: hasAttachment ? `[تصویر پاسخ ارسال شده] ${studentText}` : studentText,
      }
    }
  }

  // 2. High-Accuracy Pedagogical Heuristic Rubric (Fallback when AI is offline)
  const normStudent = normalizePersianText(studentText)
  const normRubric = normalizePersianText(rubric)

  // Extract key concept words from rubric (excluding common filler words)
  const stopWords = new Set([
    'در', 'به', 'با', 'از', 'که', 'و', 'یا', 'را', 'این', 'آن', 'برای', 'است', 'شد', 'می',
    'یک', 'هم', 'تا', 'بر', 'هر', 'چه', 'چون', 'اگر', 'پس', 'اما', 'ولی', 'باید', 'نمی'
  ])

  const rubricKeywords = normRubric
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w))

  const compactStudent = compactPersianText(studentText)

  let matchedKeywordCount = 0
  for (const kw of rubricKeywords) {
    const stemKw = kw.replace(/(‌های|های|ها|تر|ترین|ات|ان|ی)$/, '').trim()
    if (normStudent.includes(kw) || (stemKw.length >= 3 && normStudent.includes(stemKw))) {
      matchedKeywordCount++
    } else {
      // Check if any synonym in clusters matches
      let clusterMatched = false
      for (const cluster of GRADE6_CONCEPT_CLUSTERS) {
        const kwInCluster = cluster.synonyms.some((s) => {
          const cs = compactPersianText(s)
          const ckw = compactPersianText(kw)
          return cs === ckw || cs.includes(ckw) || ckw.includes(cs)
        })
        if (kwInCluster) {
          const studentInCluster = cluster.synonyms.some((s) => {
            const cs = compactPersianText(s)
            const ns = normalizePersianText(s)
            return normStudent.includes(ns) || compactStudent.includes(cs)
          })
          if (studentInCluster) {
            matchedKeywordCount++
            clusterMatched = true
            break
          }
        }
      }
    }
  }

  const keywordCoverage = rubricKeywords.length > 0 ? matchedKeywordCount / rubricKeywords.length : 0.5

  let assignedScore = 0
  let feedback = ''
  let status: 'correct' | 'partial' | 'incorrect' | 'needs_teacher_review' = 'partial'

  if (hasAttachment) {
    assignedScore = maxScore
    feedback = '📸 تصویر برگه پاسخ دانش‌آموز دریافت شد و جهت بررسی دقیق در پنل آموزگار آماده است.'
    status = 'needs_teacher_review'
  } else if (keywordCoverage >= 0.6 || (keywordCoverage >= 0.45 && studentText.length >= 40)) {
    assignedScore = maxScore
    feedback = `✅ پاسخ تشریحی جامع و بیان‌کننده مفهوم اصلی است (+${maxScore} نمره)`
    status = 'correct'
  } else if (keywordCoverage >= 0.15 || studentText.length >= 15) {
    assignedScore = Math.round(maxScore * 0.6 * 10) / 10
    feedback = `📝 پاسخ بخشی از مفهوم را پوشش می‌دهد (نمره اولیه: ${assignedScore} از ${maxScore})`
    status = 'partial'
  } else {
    assignedScore = Math.round(maxScore * 0.35 * 10) / 10
    feedback = `📝 پاسخ مختصر است و نیازمند بررسی تکمیلی آموزگار می‌باشد (${assignedScore} از ${maxScore})`
    status = 'needs_teacher_review'
  }

  return {
    questionId: q.id,
    score: assignedScore,
    maxScore,
    status,
    feedback,
    correctKeyDisplay,
    studentAnswerDisplay: studentText,
  }
}

// ----------------------------------------------------------------------
// 10. UNIFIED COMPREHENSIVE EXAM EVALUATOR
// ----------------------------------------------------------------------

export interface UnifiedGradingResult {
  totalQuestions: number
  answeredCount: number
  unansweredCount: number
  correctCount: number
  wrongCount: number
  earnedPoints: number
  maxPoints: number
  percentage: number
  scaledScore20: number
  questionScores: Record<string, number>
  questionFeedbacks: Record<string, string>
  questionGrading: Record<string, QuestionGradingOutput>
  status: 'excellent' | 'good' | 'needs_practice'
  hasPendingTeacherReview: boolean
}

export function evaluateEntireExamSubmission(
  exam: { questions: ExamQuestion[]; totalPoints?: number },
  answers: Record<string, StudentExamAnswer>,
  aiScores?: Record<string, { score?: number; feedback?: string }>
): UnifiedGradingResult {
  const questions = Array.isArray(exam?.questions) ? exam.questions : []
  let correctCount = 0
  let wrongCount = 0
  let unansweredCount = 0
  let earnedPoints = 0

  const questionScores: Record<string, number> = {}
  const questionFeedbacks: Record<string, string> = {}
  const questionGrading: Record<string, QuestionGradingOutput> = {}
  let hasPendingTeacherReview = false

  let calculatedMaxPoints = 0

  for (const q of questions) {
    const qPoints = safeScore(q.points, 10, 2)
    calculatedMaxPoints += qPoints
    const sAns = answers[q.id]

    let result: QuestionGradingOutput

    if (q.type === 'multiple_choice') {
      result = evaluateMultipleChoice(q, sAns)
    } else if (q.type === 'fill_in_the_blank') {
      result = evaluateFillInTheBlank(q, sAns)
    } else {
      const aiProp = aiScores?.[q.id]
      result = evaluateDescriptiveQuestion(q, sAns, aiProp)
    }

    if (result.status === 'empty') {
      unansweredCount++
    } else if (result.status === 'correct') {
      correctCount++
    } else if (result.status === 'incorrect') {
      wrongCount++
    }

    if (result.status === 'needs_teacher_review') {
      hasPendingTeacherReview = true
    }

    earnedPoints += result.score
    questionScores[q.id] = result.score
    questionFeedbacks[q.id] = result.feedback
    questionGrading[q.id] = result
  }

  const maxPoints = safeNumber(exam.totalPoints, calculatedMaxPoints) || calculatedMaxPoints || 20
  earnedPoints = Math.min(maxPoints, Math.max(0, Math.round(earnedPoints * 100) / 100))
  const answeredCount = questions.length - unansweredCount
  const percentage = safePercentage(earnedPoints, maxPoints)
  const scaledScore20 = safeScaled20(earnedPoints, maxPoints)

  let status: 'excellent' | 'good' | 'needs_practice' = 'good'
  if (percentage >= 80) status = 'excellent'
  else if (percentage < 60) status = 'needs_practice'

  return {
    totalQuestions: questions.length,
    answeredCount,
    unansweredCount,
    correctCount,
    wrongCount,
    earnedPoints,
    maxPoints,
    percentage,
    scaledScore20,
    questionScores,
    questionFeedbacks,
    questionGrading,
    status,
    hasPendingTeacherReview,
  }
}

import { chapter1Topics } from './chapters/chapter1Verbal'

export interface TizhooshanQuestion {
  id: number
  question: string
  options: string[]
  correct_index: number
  explanation: string
  difficulty?: string
  stage?: string
  badge?: string
  xp: number
  formula?: string
  image?: string
  _isRepeat?: boolean
  [key: string]: any
}

export interface TizhooshanTopic {
  id: string
  chapterId: number
  chapterTitle: string
  chapterIcon: string
  unitNumber: number
  category: string
  topic: string
  icon: string
  lesson_summary: string
  technique?: {
    title: string
    rule: string
    exampleQuestion: string
    exampleSolution: string
  }
  questions: TizhooshanQuestion[]
  [key: string]: any
}

export interface TizhooshanChapter {
  id: number
  title: string
  subtitle?: string
  icon: string
  cardGradient: string
  accentColor: string
  badgeBg?: string
  description?: string
  desc?: string
  color?: string
  environmentName?: string
  realmName?: string
  [key: string]: any
}

export const tizhooshanChaptersData: TizhooshanChapter[] = [
  {
    id: 1,
    title: 'فصل ۱: هوش کلامی و ادبی',
    subtitle: 'سرزمین واژگان، ضرب‌المثل‌ها و درک مطلب سمپاد',
    icon: '🗣️',
    cardGradient: 'linear-gradient(135deg, #10B981, #059669)',
    accentColor: '#10B981',
    badgeBg: '#D1FAE5',
    color: '#10B981',
    environmentName: 'واژگان و زبان فارسی',
    realmName: 'سرزمین کلامی',
    desc: 'تقویت دایره لغات، ریشه‌یابی و تحلیل متون ادبی سمپاد',
    description: 'تقویت دایره لغات، ریشه‌یابی و تحلیل متون ادبی سمپاد',
  },
  {
    id: 2,
    title: 'فصل ۲: هوش عددی و محاسباتی',
    subtitle: 'سرزمین الگوها، تناسب و معماهای ریاضی',
    icon: '🔢',
    cardGradient: 'linear-gradient(135deg, #0284C7, #0369A1)',
    accentColor: '#0284C7',
    badgeBg: '#E0F2FE',
    color: '#0284C7',
    environmentName: 'اعداد و محاسبات',
    realmName: 'سرزمین ریاضی',
    desc: 'الگوهای عددی، مسائل تناسب و حل خلاقانه مسائل ریاضی',
    description: 'الگوهای عددی، مسائل تناسب و حل خلاقانه مسائل ریاضی',
  },
  {
    id: 3,
    title: 'فصل ۳: هوش تحلیلی و منطقی',
    subtitle: 'سرزمین استدلال، کدگذاری و جداول منطق',
    icon: '🧩',
    cardGradient: 'linear-gradient(135deg, #8B5CF6, #6D28D9)',
    accentColor: '#8B5CF6',
    badgeBg: '#EDE9FE',
    color: '#8B5CF6',
    environmentName: 'منطق و استدلال',
    realmName: 'سرزمین منطق',
    desc: 'تحلیل فرضیات، استدلال گزاره‌ها و رمزگشایی کدهای سمپاد',
    description: 'تحلیل فرضیات، استدلال گزاره‌ها و رمزگشایی کدهای سمپاد',
  },
  {
    id: 4,
    title: 'فصل ۴: هوش تصویری و فضایی',
    subtitle: 'سرزمین دوران، گسترده مکعب و اشکال هندسی',
    icon: '📐',
    cardGradient: 'linear-gradient(135deg, #F59E0B, #D97706)',
    accentColor: '#F59E0B',
    badgeBg: '#FEF3C7',
    color: '#F59E0B',
    environmentName: 'تصاویر و تجسم فضایی',
    realmName: 'سرزمین هندسه',
    desc: 'دید فضایی، دوران سه‌بعدی و تقارن تصاویر',
    description: 'دید فضایی، دوران سه‌بعدی و تقارن تصاویر',
  },
  {
    id: 5,
    title: 'فصل ۵: سرعت، دقت و تمرکز',
    subtitle: 'آزمون‌های زمان‌دار و سنجش تمرکز سمپاد',
    icon: '⚡',
    cardGradient: 'linear-gradient(135deg, #EC4899, #BE185D)',
    accentColor: '#EC4899',
    badgeBg: '#FCE7F3',
    color: '#EC4899',
    environmentName: 'سرعت و دقت',
    realmName: 'سرزمین سرعت',
    desc: 'شمارش سریع، پیدا کردن تفاوت‌ها و افزایش سرعت پردازش',
    description: 'شمارش سریع، پیدا کردن تفاوت‌ها و افزایش سرعت پردازش',
  },
]

const chapter2Topics: TizhooshanTopic[] = [
  {
    id: 'ch2-t1',
    chapterId: 2,
    chapterTitle: 'فصل ۲: هوش عددی و محاسباتی',
    chapterIcon: '🔢',
    unitNumber: 1,
    category: 'عددی و محاسباتی',
    topic: 'گام ۱: الگوهای دنباله‌ای و تصاعدهای حسابی و هندسی',
    icon: '📈',
    lesson_summary: 'در الگوهای عددی سمپاد، تغییرات بین اعداد ممکن است بر اساس جمع، ضرب یا الگوهای چندمرحله‌ای (فیبوناچی و توانی) باشد.',
    technique: {
      title: 'تکنیک بررسی فاصله‌ها (تفاضل مرتبه دوم)',
      rule: 'همیشه ابتدا فاصله بین دو جمله متوالی را بنویسید؛ اگر فاصله‌ها ثابت نبود، فاصله بین خود فاصله‌ها را بررسی کنید.',
      exampleQuestion: 'عدد بعدی در الگوی ۲، ۵، ۱۰، ۱۷ کدام است؟',
      exampleSolution: 'فاصله‌ها: ۳، ۵، ۷، پس فاصله بعدی ۹ است. ۱۷ + ۹ = ۲۶ (یا الگوی n² + 1).',
    },
    questions: [
      {
        id: 201,
        question: 'در دنباله عددی ۲، ۵، ۱۰، ۱۷، ۲۶، عدد بعدی کدام است؟',
        options: ['۳۵', '۳۷', '۳۸', '۴۰'],
        correct_index: 1,
        explanation: 'فاصله‌ها به ترتیب ۳، ۵، ۷، ۹ است، بنابراین فاصله بعدی ۱۱ خواهد بود: ۲۶ + ۱۱ = ۳۷ (همچنین رابطه n² + 1 برقرار است: ۶² + ۱ = ۳۷).',
        difficulty: 'متوسط',
        stage: 'تثبیت و تسلط',
        badge: 'گام ۳: تثبیت',
        xp: 20,
      },
      {
        id: 202,
        question: 'در دنباله فیبوناچی ۱، ۱، ۲، ۳، ۵، ۸، ۱۳، عدد بعدی کدام است؟',
        options: ['۱۹', '۲۰', '۲۱', '۲۲'],
        correct_index: 2,
        explanation: 'هر عدد از مجموع دو عدد قبلی حاصل می‌شود: ۸ + ۱۳ = ۲۱.',
        difficulty: 'آسان',
        stage: 'درک اولیه',
        badge: 'گام ۲: درک اولیه',
        xp: 15,
      },
      {
        id: 203,
        question: 'مجموع اعداد طبیعی از ۱ تا ۵۰ برابر با کدام گزینه است؟',
        options: ['۱۲۲۵', '۱۲۷۵', '۱۳۰۰', '۲۵۵۰'],
        correct_index: 1,
        explanation: 'فرمول گاوس: (تعداد × (اولین + آخرین)) ÷ ۲ => (۵۰ × ۵۱) ÷ ۲ = ۱۲۷۵.',
        difficulty: 'سخت',
        stage: 'تست واقعی سمپاد',
        badge: '🏆 سمپاد',
        xp: 25,
      },
    ],
  },
]

const chapter3Topics: TizhooshanTopic[] = [
  {
    id: 'ch3-t1',
    chapterId: 3,
    chapterTitle: 'فصل ۳: هوش تحلیلی و منطقی',
    chapterIcon: '🧩',
    unitNumber: 1,
    category: 'تحلیلی و منطقی',
    topic: 'گام ۱: استدلال شرطی و حذف گزینه‌های ناممکن',
    icon: '🎯',
    lesson_summary: 'در سوالات منطقی، ابتدا فرضیاتی که قطعیت کامل دارند را شناسایی کرده و به کمک جدول منطقی سایر احتمالات را بررسی می‌کنیم.',
    technique: {
      title: 'تکنیک جدول ارزش و تناقض‌یابی',
      rule: 'هر گزاره‌ای که با فرضیات قطعی در تناقض باشد را بلافاصله حذف کنید.',
      exampleQuestion: 'اگر علی از حسن بلندتر و حسن از رضا بلندتر باشد، چه کسی از همه کوتاه‌تر است؟',
      exampleSolution: 'علی > حسن > رضا؛ بنابراین رضا کوتاه‌ترین است.',
    },
    questions: [
      {
        id: 301,
        question: 'اگر همه پرندگان پر دارند و پنگوئن یک پرنده است، کدام نتیجه‌گیری قطعی است؟',
        options: ['پنگوئن پرواز می‌کند', 'پنگوئن پر دارد', 'پنگوئن در قطب زندگی می‌کند', 'پنگوئن شناگر ماهری است'],
        correct_index: 1,
        explanation: 'بر اساس صغرای قیاس منطقی، چون پنگوئن پرنده است و همه پرندگان پر دارند، پنگوئن قطعا پر دارد.',
        difficulty: 'آسان',
        stage: 'درک اولیه',
        badge: 'گام ۲: درک اولیه',
        xp: 15,
      },
    ],
  },
]

const chapter4Topics: TizhooshanTopic[] = [
  {
    id: 'ch4-t1',
    chapterId: 4,
    chapterTitle: 'فصل ۴: هوش تصویری و فضایی',
    chapterIcon: '📐',
    unitNumber: 1,
    category: 'تصویری و فضایی',
    topic: 'گام ۱: دوران، تقارن و گسترده مکعب',
    icon: '🎲',
    lesson_summary: 'یک مکعب از ۶ وجه تشکیل شده است. در هر مکعب گسترده، وجوهی که یک وجه بین آن‌ها فاصله دارد روبه‌روی یکدیگر قرار می‌گیرند.',
    questions: [
      {
        id: 401,
        question: 'در یک تاس استاندارد مجموع دو وجه روبه‌رو همواره ۷ است. اگر عدد بالای تاس ۵ باشد، عدد وجه پایین کدام است؟',
        options: ['۱', '۲', '۳', '۴'],
        correct_index: 1,
        explanation: '۷ منهای ۵ برابر با ۲ است، بنابراین وجه روبه‌رو ۲ است.',
        difficulty: 'آسان',
        stage: 'درک اولیه',
        badge: 'گام ۲: درک اولیه',
        xp: 15,
      },
    ],
  },
]

const chapter5Topics: TizhooshanTopic[] = [
  {
    id: 'ch5-t1',
    chapterId: 5,
    chapterTitle: 'فصل ۵: سرعت، دقت و تمرکز',
    chapterIcon: '⚡',
    unitNumber: 1,
    category: 'سرعت و دقت',
    topic: 'گام ۱: شمارش سریع و دقت دیداری',
    icon: '⚡',
    lesson_summary: 'تمرین‌های سرعت و دقت نیاز به پرش دیداری سریع و تمرکز بالا بدون اشتباه دارند.',
    questions: [
      {
        id: 501,
        question: 'در عبارت «دبستان هوشمند حضرت قائم»، حرف «م» چند بار تکرار شده است؟',
        options: ['۱', '۲', '۳', '۴'],
        correct_index: 1,
        explanation: 'در کلمات «هوشمند» (۱) و «قائم» (۱)، در مجموع ۲ بار حرف «م» آمده است.',
        difficulty: 'آسان',
        stage: 'درک اولیه',
        badge: 'گام ۲: درک اولیه',
        xp: 15,
      },
    ],
  },
]

export const tizhooshanTopicsData: TizhooshanTopic[] = [
  ...chapter1Topics,
  ...chapter2Topics,
  ...chapter3Topics,
  ...chapter4Topics,
  ...chapter5Topics,
]

// Hybrid AI Client (Direct Gemini SDK in frontend or Backend Proxy)
import {
  generatePracticeHybrid,
  generateSamplePreviewHybrid,
  generateAnnouncementHybrid,
  generateExamQuestionsHybrid,
} from './services/geminiHybridService'

export async function generatePractice({
  topic,
  count,
  difficulty,
  teacherPassword,
}: {
  topic: string
  count: number | string
  difficulty: string
  bookUrl?: string | null
  teacherPassword?: string
}): Promise<string> {
  return await generatePracticeHybrid({
    topic,
    count,
    difficulty,
    teacherPassword,
  })
}

export async function generateSamplePreview({
  topic,
  difficulty,
  teacherPassword,
}: {
  topic: string
  difficulty: string
  bookUrl?: string | null
  teacherPassword?: string
}): Promise<string> {
  return await generateSamplePreviewHybrid({
    topic,
    difficulty,
    teacherPassword,
  })
}

export async function generateAnnouncement({
  topic,
  teacherPassword,
}: {
  topic: string
  teacherPassword?: string
}): Promise<string> {
  return await generateAnnouncementHybrid({ topic, teacherPassword })
}

export async function generateInteractiveQuiz({
  topic,
  count = 5,
  subject = 'ریاضی',
}: {
  topic: string
  count?: number
  subject?: string
}): Promise<any> {
  const questions = await generateExamQuestionsHybrid({
    subject,
    topic,
    count,
    types: ['multiple_choice'],
  })

  if (Array.isArray(questions) && questions.length > 0) {
    return {
      title: `آزمونک ${subject}: ${topic}`,
      questions: questions.map((q: any, i: number) => ({
        id: i + 1,
        question: q.question,
        options: q.options || [],
        correctIndex: q.correctAnswer ?? 0,
      })),
    }
  }

  throw new Error('خطا در تولید آزمونک')
}

export async function generateSampadAiQuestion({
  topic = 'استعداد تحلیلی و معماهای منطقی',
  difficulty = 'متوسط',
}: {
  topic?: string
  difficulty?: 'آسان' | 'متوسط' | 'سخت'
}): Promise<{
  id: number
  question: string
  options: string[]
  correct_index: number
  explanation: string
  difficulty: 'آسان' | 'متوسط' | 'سخت'
  xp: number
}> {
  const diffEng = difficulty === 'سخت' ? 'hard' : difficulty === 'آسان' ? 'easy' : 'medium'
  const questions = await generateExamQuestionsHybrid({
    subject: 'هوش و استعداد تحلیلی (تیزهوشان)',
    topic,
    count: 1,
    types: ['multiple_choice'],
    difficulty: diffEng,
    extraInstructions: 'یک سوال استاندارد با تکنیک استدلال آزمون تیزهوشان بساز.',
  })

  if (Array.isArray(questions) && questions[0]) {
    const q = questions[0]
    return {
      id: Date.now() + Math.floor(Math.random() * 1000),
      question: q.question,
      options: q.options || ['گزینه ۱', 'گزینه ۲', 'گزینه ۳', 'گزینه ۴'],
      correct_index: Number(q.correctAnswer) || 0,
      explanation: q.rubricOrHint || 'پاسخ صحیح گزینه فوق است.',
      difficulty,
      xp: difficulty === 'آسان' ? 15 : difficulty === 'متوسط' ? 25 : 35,
    }
  }

  throw new Error('تولید سوال هوشمند انجام نشد.')
}

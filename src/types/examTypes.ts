export type QuestionType =
  | 'multiple_choice'
  | 'fill_in_the_blank'
  | 'descriptive'
  | 'true_false'
  | 'image'

export interface ExamQuestion {
  id: string
  type: QuestionType
  question: string
  options?: string[]
  correctAnswer?: number | string
  points?: number
  rubricOrHint?: string
  explanation?: string
  imageUrl?: string
  [key: string]: any
}

export interface StudentExamAnswer {
  selectedOption?: number
  textAnswer?: string
  answeredAt?: string | number
  [key: string]: any
}

export interface StudentExamSubmission {
  id: string
  examId: string
  studentId: string
  studentName?: string
  submittedAt?: string
  answers: Record<string, StudentExamAnswer>
  aiGrading?: {
    questionScores: Record<string, number>
    questionFeedbacks?: Record<string, string>
    totalScore: number
    scaledScore20?: number
    gradedAt?: string
    summary?: string
    [key: string]: any
  }
  teacherGrading?: {
    approved?: boolean
    approvedAt?: string
    questionScores?: Record<string, number>
    questionFeedbacks?: Record<string, string>
    totalScore: number
    scaledScore20?: number
    teacherNotes?: string
    [key: string]: any
  }
  [key: string]: any
}

export interface Exam {
  id: string
  title: string
  subject?: string
  topic?: string
  durationMinutes?: number
  totalPoints?: number
  mode?: 'assignment' | 'exam'
  isUntimed?: boolean
  dueDate?: string
  created_at?: string
  questions: ExamQuestion[]
  published?: boolean
  active?: boolean
  isPublished?: boolean
  allowedStudents?: string[]
  [key: string]: any
}

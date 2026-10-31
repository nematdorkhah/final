export type QuestionType =
  | 'multiple_choice'
  | 'fill_in_the_blank'
  | 'descriptive'
  | 'true_false'
  | 'image'

export interface ExamOptionObject {
  id: string
  text: string
  [key: string]: any
}

export type ExamOptionItem = string | ExamOptionObject

export interface ExamQuestion {
  id: string
  type: QuestionType
  question: string
  options?: string[]
  optionObjects?: ExamOptionObject[]
  correctAnswer?: number | string
  correctOptionIndex?: number
  correctOptionText?: string
  correctOptionId?: string
  acceptableAnswers?: string[]
  points?: number
  rubricOrHint?: string
  explanation?: string
  imageUrl?: string
  [key: string]: any
}

export interface StudentExamAnswer {
  selectedOption?: number
  selectedOptionIndex?: number
  selectedOptionText?: string
  selectedOptionId?: string
  textAnswer?: string
  imageAttachment?: string
  answeredAt?: string | number
  [key: string]: any
}

export interface RegradeAuditRecord {
  regradedAt: string
  oldScore: number
  newScore: number
  scoreDiff: number
  oldScaledScore20?: number
  newScaledScore20?: number
  teacherOverrodeApproved?: boolean
  reason?: string
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
  regradeHistory?: RegradeAuditRecord[]
  isReleased?: boolean
  is_released?: boolean
  status?: 'pending_approval' | 'released' | 'graded'
  [key: string]: any
}

export interface RegradeQuestionDiff {
  questionId: string
  questionType: string
  questionTitle: string
  oldScore: number
  newScore: number
  maxPoints: number
  oldFeedback?: string
  newFeedback?: string
}

export interface RegradeDiffItem {
  submissionId: string
  studentId: string
  studentName: string
  examId: string
  oldScore: number
  newScore: number
  scoreDiff: number
  oldScaledScore20: number
  newScaledScore20: number
  isApproved: boolean
  questionDiffs: RegradeQuestionDiff[]
}

export interface RegradePreviewResult {
  examId: string
  examTitle: string
  totalSubmissions: number
  submissionsWithChanges: number
  approvedCount: number
  items: RegradeDiffItem[]
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
  scheduledStartTime?: string
  created_at?: string
  questions: ExamQuestion[]
  published?: boolean
  active?: boolean
  isPublished?: boolean
  resultsPublished?: boolean
  results_published?: boolean
  isResultsReleased?: boolean
  allowedStudents?: string[]
  [key: string]: any
}


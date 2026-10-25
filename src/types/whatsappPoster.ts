export interface WhatsappPosterQuestion {
  id?: string | number
  question: string
  type?: string
  options?: string[]
  points?: number
}

export interface WhatsappPosterData {
  type: 'homework' | 'exam' | 'announcement'
  title: string
  subject?: string
  body?: string
  questions?: WhatsappPosterQuestion[]
  dueAt?: string | null
  createdAt?: string | null
  teacherName?: string
  schoolName?: string
  gradeName?: string
  totalPoints?: number
  durationMinutes?: number
  instructions?: string
}

import StudentExamTaker from './StudentExamTaker'
import { Exam } from '../types/examTypes'

export interface StudentQuizViewProps {
  exam?: Exam
  quiz?: Exam
  student: any
  onClose: () => void
  onFinished?: () => void
}

/**
 * StudentQuizView: Canonical student exam/quiz interface
 * Features optimistic submission, direct Supabase persistence,
 * and teacher-controlled report card / answer key release.
 */
export default function StudentQuizView({
  exam,
  quiz,
  student,
  onClose,
  onFinished,
}: StudentQuizViewProps) {
  const targetExam = exam || quiz
  if (!targetExam) return null

  return (
    <StudentExamTaker
      exam={targetExam}
      student={student}
      onClose={onClose}
      onFinished={onFinished}
    />
  )
}

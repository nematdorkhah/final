-- Migration: Lightweight Polling Fingerprints with updated_at Triggers & Single-Request RPCs
-- Safe & idempotent: adds updated_at + BEFORE UPDATE triggers only if missing, and creates/replaces RPCs.

-- 1. Shared trigger function to automatically update updated_at on every UPDATE
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 2. Add updated_at column (if missing) and BEFORE UPDATE trigger for each polled table
-- 2a. posts
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_posts_set_updated_at ON public.posts;
CREATE TRIGGER trg_posts_set_updated_at
  BEFORE UPDATE ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_posts_updated_at ON public.posts (updated_at DESC);

-- 2b. quizzes
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_quizzes_set_updated_at ON public.quizzes;
CREATE TRIGGER trg_quizzes_set_updated_at
  BEFORE UPDATE ON public.quizzes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_quizzes_updated_at ON public.quizzes (updated_at DESC);

-- 2c. grades
ALTER TABLE public.grades
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_grades_set_updated_at ON public.grades;
CREATE TRIGGER trg_grades_set_updated_at
  BEFORE UPDATE ON public.grades
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_grades_student_updated_at ON public.grades (student_id, updated_at DESC);

-- 2d. quiz_submissions
ALTER TABLE public.quiz_submissions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_quiz_submissions_set_updated_at ON public.quiz_submissions;
CREATE TRIGGER trg_quiz_submissions_set_updated_at
  BEFORE UPDATE ON public.quiz_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_quiz_submissions_student_updated_at ON public.quiz_submissions (student_id, updated_at DESC);

-- 2e. submissions
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_submissions_set_updated_at ON public.submissions;
CREATE TRIGGER trg_submissions_set_updated_at
  BEFORE UPDATE ON public.submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_submissions_student_updated_at ON public.submissions (student_id, updated_at DESC);

-- 2f. attendance (needed for teacher_poll_fingerprint)
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_attendance_set_updated_at ON public.attendance;
CREATE TRIGGER trg_attendance_set_updated_at
  BEFORE UPDATE ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_attendance_updated_at ON public.attendance (updated_at DESC);

-- 3. Student lightweight single-request polling fingerprint RPC
CREATE OR REPLACE FUNCTION public.student_poll_fingerprint(
  p_student_id uuid,
  p_access_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_posts_count bigint := 0;
  v_posts_max timestamptz := NULL;
  v_quizzes_count bigint := 0;
  v_quizzes_max timestamptz := NULL;
  v_system_exams_max timestamptz := NULL;
  v_grades_count bigint := 0;
  v_grades_max timestamptz := NULL;
  v_quiz_subs_count bigint := 0;
  v_quiz_subs_max timestamptz := NULL;
  v_subs_count bigint := 0;
  v_subs_max timestamptz := NULL;
BEGIN
  IF p_student_id IS NULL OR p_access_code IS NULL OR btrim(p_access_code) = '' THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.students s
    WHERE s.id = p_student_id
      AND s.access_code = btrim(p_access_code)
  ) THEN
    RAISE EXCEPTION 'Invalid student credentials' USING ERRCODE = '42501';
  END IF;

  -- Posts without internal system rows (__SYSTEM_EXAMS__, __EXAM_SUB__, etc.)
  SELECT count(*), max(updated_at)
  INTO v_posts_count, v_posts_max
  FROM public.posts
  WHERE COALESCE(title, '') NOT LIKE '\_\_%' ESCAPE '\';

  -- Quizzes + authoritative __SYSTEM_EXAMS__ metadata row (catches published / dueDate / resultsPublished edits)
  SELECT count(*), max(updated_at)
  INTO v_quizzes_count, v_quizzes_max
  FROM public.quizzes;

  SELECT max(updated_at)
  INTO v_system_exams_max
  FROM public.posts
  WHERE title = '__SYSTEM_EXAMS__';

  -- Student-specific grades
  SELECT count(*), max(updated_at)
  INTO v_grades_count, v_grades_max
  FROM public.grades
  WHERE student_id = p_student_id;

  -- Student-specific quiz submissions
  SELECT count(*), max(updated_at)
  INTO v_quiz_subs_count, v_quiz_subs_max
  FROM public.quiz_submissions
  WHERE student_id = p_student_id;

  -- Student-specific homework submissions
  SELECT count(*), max(updated_at)
  INTO v_subs_count, v_subs_max
  FROM public.submissions
  WHERE student_id = p_student_id;

  RETURN jsonb_build_object(
    'posts', jsonb_build_object(
      'count', COALESCE(v_posts_count, 0),
      'max_updated_at', v_posts_max
    ),
    'quizzes', jsonb_build_object(
      'count', COALESCE(v_quizzes_count, 0),
      'max_updated_at', GREATEST(v_quizzes_max, v_system_exams_max)
    ),
    'grades', jsonb_build_object(
      'count', COALESCE(v_grades_count, 0),
      'max_updated_at', v_grades_max
    ),
    'quiz_submissions', jsonb_build_object(
      'count', COALESCE(v_quiz_subs_count, 0),
      'max_updated_at', v_quiz_subs_max
    ),
    'submissions', jsonb_build_object(
      'count', COALESCE(v_subs_count, 0),
      'max_updated_at', v_subs_max
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.student_poll_fingerprint(uuid, text) TO anon, authenticated;

-- 4. Teacher lightweight single-request polling fingerprint RPC
CREATE OR REPLACE FUNCTION public.teacher_poll_fingerprint(
  p_password text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_posts_count bigint := 0;
  v_posts_max timestamptz := NULL;
  v_quizzes_count bigint := 0;
  v_quizzes_max timestamptz := NULL;
  v_system_exams_max timestamptz := NULL;
  v_quiz_subs_count bigint := 0;
  v_quiz_subs_max timestamptz := NULL;
  v_exam_sub_posts_count bigint := 0;
  v_exam_sub_posts_max timestamptz := NULL;
  v_subs_count bigint := 0;
  v_subs_max timestamptz := NULL;
  v_grades_count bigint := 0;
  v_grades_max timestamptz := NULL;
  v_att_count bigint := 0;
  v_att_max timestamptz := NULL;
BEGIN
  IF p_password IS NULL OR NOT public.verify_teacher(p_password) THEN
    RAISE EXCEPTION 'Unauthorized teacher' USING ERRCODE = '42501';
  END IF;

  -- Posts without internal system rows
  SELECT count(*), max(updated_at)
  INTO v_posts_count, v_posts_max
  FROM public.posts
  WHERE COALESCE(title, '') NOT LIKE '\_\_%' ESCAPE '\';

  -- Quizzes + authoritative __SYSTEM_EXAMS__ metadata row
  SELECT count(*), max(updated_at)
  INTO v_quizzes_count, v_quizzes_max
  FROM public.quizzes;

  SELECT max(updated_at)
  INTO v_system_exams_max
  FROM public.posts
  WHERE title = '__SYSTEM_EXAMS__';

  -- Quiz submissions (including fallback __EXAM_SUB__ container rows if updated)
  SELECT count(*), max(updated_at)
  INTO v_quiz_subs_count, v_quiz_subs_max
  FROM public.quiz_submissions;

  SELECT count(*), max(updated_at)
  INTO v_exam_sub_posts_count, v_exam_sub_posts_max
  FROM public.posts
  WHERE title LIKE '\_\_EXAM\_SUB\_\_%' ESCAPE '\';

  -- Homework submissions
  SELECT count(*), max(updated_at)
  INTO v_subs_count, v_subs_max
  FROM public.submissions;

  -- Grades
  SELECT count(*), max(updated_at)
  INTO v_grades_count, v_grades_max
  FROM public.grades;

  -- Attendance
  SELECT count(*), max(updated_at)
  INTO v_att_count, v_att_max
  FROM public.attendance;

  RETURN jsonb_build_object(
    'posts', jsonb_build_object(
      'count', COALESCE(v_posts_count, 0),
      'max_updated_at', v_posts_max
    ),
    'quizzes', jsonb_build_object(
      'count', COALESCE(v_quizzes_count, 0),
      'max_updated_at', GREATEST(v_quizzes_max, v_system_exams_max)
    ),
    'quiz_submissions', jsonb_build_object(
      'count', COALESCE(v_quiz_subs_count, 0) + COALESCE(v_exam_sub_posts_count, 0),
      'max_updated_at', GREATEST(v_quiz_subs_max, v_exam_sub_posts_max)
    ),
    'submissions', jsonb_build_object(
      'count', COALESCE(v_subs_count, 0),
      'max_updated_at', v_subs_max
    ),
    'grades', jsonb_build_object(
      'count', COALESCE(v_grades_count, 0),
      'max_updated_at', v_grades_max
    ),
    'attendance', jsonb_build_object(
      'count', COALESCE(v_att_count, 0),
      'max_updated_at', v_att_max
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_poll_fingerprint(text) TO anon, authenticated;

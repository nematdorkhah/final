-- ============================================================================
-- Migration: public.quizzes as Single Source of Truth + Secure RLS & RPCs
-- File: supabase/migration_quizzes.sql
-- Safe & idempotent: can be executed multiple times in Supabase SQL Editor.
-- ============================================================================

-- 1. Ensure shared updated_at trigger function exists
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 2. Add missing columns to public.quizzes (idempotent)
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT true;

ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'exam';

ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS due_at timestamptz;

ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS scheduled_start timestamptz;

ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS is_untimed boolean NOT NULL DEFAULT false;

ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS results_published boolean NOT NULL DEFAULT false;

ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS total_points numeric;

ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Normalize any pre-existing invalid mode values before enforcing CHECK constraint
UPDATE public.quizzes
SET mode = CASE
  WHEN mode = 'assignment' OR COALESCE(is_untimed, false) = true OR COALESCE(duration_minutes, 30) <= 0 THEN 'assignment'
  ELSE 'exam'
END
WHERE mode IS NULL OR mode NOT IN ('exam', 'assignment');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'quizzes_mode_check'
      AND conrelid = 'public.quizzes'::regclass
  ) THEN
    ALTER TABLE public.quizzes
      ADD CONSTRAINT quizzes_mode_check CHECK (mode IN ('exam', 'assignment'));
  END IF;
END;
$$;

-- Automatic updated_at trigger on public.quizzes
DROP TRIGGER IF EXISTS trg_quizzes_set_updated_at ON public.quizzes;
CREATE TRIGGER trg_quizzes_set_updated_at
  BEFORE UPDATE ON public.quizzes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_quizzes_published_created_at
  ON public.quizzes (published, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quizzes_updated_at
  ON public.quizzes (updated_at DESC);

-- 3. One-time migration of legacy __SYSTEM_EXAMS__ JSON rows (in public.posts) into public.quizzes
-- Preserves all existing exam settings (published, mode, due_at, scheduled_start, is_untimed, results_published, total_points).
DO $$
DECLARE
  v_body text;
  v_items jsonb;
  v_item jsonb;
  v_id_text text;
  v_id uuid;
  v_duration int;
  v_is_untimed boolean;
  v_mode text;
  v_due_at timestamptz;
  v_scheduled_start timestamptz;
  v_created_at timestamptz;
  v_published boolean;
  v_results_published boolean;
  v_total_points numeric;
  v_questions jsonb;
BEGIN
  SELECT p.body
  INTO v_body
  FROM public.posts p
  WHERE p.title = '__SYSTEM_EXAMS__'
    AND p.body IS NOT NULL
  ORDER BY p.created_at DESC
  LIMIT 1;

  IF v_body IS NULL OR btrim(v_body) = '' THEN
    RETURN;
  END IF;

  BEGIN
    v_items := v_body::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;

  IF jsonb_typeof(v_items) <> 'array' THEN
    RETURN;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    v_id_text := btrim(COALESCE(v_item->>'id', ''));
    IF v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      CONTINUE;
    END IF;
    v_id := v_id_text::uuid;

    v_questions := CASE
      WHEN jsonb_typeof(v_item->'questions') = 'array' THEN v_item->'questions'
      ELSE '[]'::jsonb
    END;

    v_duration := 30;
    BEGIN
      v_duration := GREATEST(0, COALESCE(
        ROUND(NULLIF(v_item->>'durationMinutes', '')::numeric)::int,
        ROUND(NULLIF(v_item->>'duration_minutes', '')::numeric)::int,
        30
      ));
    EXCEPTION WHEN OTHERS THEN
      v_duration := 30;
    END;

    v_is_untimed := false;
    BEGIN
      v_is_untimed := COALESCE(
        NULLIF(v_item->>'isUntimed', '')::boolean,
        NULLIF(v_item->>'is_untimed', '')::boolean,
        (v_item->>'mode') = 'assignment',
        v_duration = 0
      );
    EXCEPTION WHEN OTHERS THEN
      v_is_untimed := ((v_item->>'mode') = 'assignment' OR v_duration = 0);
    END;

    v_mode := CASE
      WHEN (v_item->>'mode') = 'assignment' OR v_is_untimed THEN 'assignment'
      ELSE 'exam'
    END;

    v_published := true;
    BEGIN
      v_published := COALESCE(NULLIF(v_item->>'published', '')::boolean, true);
    EXCEPTION WHEN OTHERS THEN
      v_published := true;
    END;

    v_results_published := false;
    BEGIN
      v_results_published := COALESCE(
        NULLIF(v_item->>'resultsPublished', '')::boolean,
        NULLIF(v_item->>'results_published', '')::boolean,
        NULLIF(v_item->>'isResultsReleased', '')::boolean,
        false
      );
    EXCEPTION WHEN OTHERS THEN
      v_results_published := false;
    END;

    v_due_at := NULL;
    BEGIN
      v_due_at := COALESCE(
        NULLIF(v_item->>'due_at', '')::timestamptz,
        NULLIF(v_item->>'dueDate', '')::timestamptz,
        NULLIF(v_item->>'due_date', '')::timestamptz
      );
    EXCEPTION WHEN OTHERS THEN
      v_due_at := NULL;
    END;

    v_created_at := now();
    BEGIN
      v_created_at := COALESCE(
        NULLIF(v_item->>'createdAt', '')::timestamptz,
        NULLIF(v_item->>'created_at', '')::timestamptz,
        now()
      );
    EXCEPTION WHEN OTHERS THEN
      v_created_at := now();
    END;

    v_scheduled_start := v_created_at;
    BEGIN
      v_scheduled_start := COALESCE(
        NULLIF(v_item->>'scheduled_start', '')::timestamptz,
        NULLIF(v_item->>'scheduledStartTime', '')::timestamptz,
        NULLIF(v_item->>'scheduled_start_time', '')::timestamptz,
        v_created_at
      );
    EXCEPTION WHEN OTHERS THEN
      v_scheduled_start := v_created_at;
    END;

    v_total_points := NULL;
    BEGIN
      v_total_points := COALESCE(
        NULLIF(v_item->>'totalPoints', '')::numeric,
        NULLIF(v_item->>'total_points', '')::numeric
      );
    EXCEPTION WHEN OTHERS THEN
      v_total_points := NULL;
    END;

    IF v_total_points IS NULL OR v_total_points <= 0 THEN
      SELECT COALESCE(SUM(COALESCE(NULLIF(q->>'points', '')::numeric, 1)), 20)
      INTO v_total_points
      FROM jsonb_array_elements(v_questions) AS q;
    END IF;

    INSERT INTO public.quizzes (
      id,
      title,
      subject,
      questions,
      duration_minutes,
      published,
      mode,
      due_at,
      scheduled_start,
      is_untimed,
      results_published,
      total_points,
      created_at,
      updated_at
    )
    VALUES (
      v_id,
      COALESCE(NULLIF(v_item->>'title', ''), 'آزمون کلاسی'),
      COALESCE(NULLIF(v_item->>'subject', ''), 'عمومی'),
      v_questions,
      v_duration,
      v_published,
      v_mode,
      v_due_at,
      v_scheduled_start,
      v_is_untimed,
      v_results_published,
      v_total_points,
      v_created_at,
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      title = COALESCE(NULLIF(EXCLUDED.title, ''), public.quizzes.title),
      subject = COALESCE(NULLIF(EXCLUDED.subject, ''), public.quizzes.subject),
      questions = CASE
        WHEN jsonb_array_length(EXCLUDED.questions) > 0 THEN EXCLUDED.questions
        ELSE public.quizzes.questions
      END,
      duration_minutes = EXCLUDED.duration_minutes,
      published = EXCLUDED.published,
      mode = EXCLUDED.mode,
      due_at = COALESCE(EXCLUDED.due_at, public.quizzes.due_at),
      scheduled_start = COALESCE(EXCLUDED.scheduled_start, public.quizzes.scheduled_start),
      is_untimed = EXCLUDED.is_untimed,
      results_published = EXCLUDED.results_published,
      total_points = COALESCE(EXCLUDED.total_points, public.quizzes.total_points),
      updated_at = now();
  END LOOP;
END;
$$;

-- Backfill total_points & scheduled_start on any remaining quizzes rows
UPDATE public.quizzes q
SET
  total_points = COALESCE(
    q.total_points,
    (
      SELECT COALESCE(SUM(COALESCE(NULLIF(elem->>'points', '')::numeric, 1)), 20)
      FROM jsonb_array_elements(COALESCE(q.questions, '[]'::jsonb)) AS elem
    )
  ),
  scheduled_start = COALESCE(q.scheduled_start, q.created_at, now())
WHERE q.total_points IS NULL OR q.scheduled_start IS NULL;

-- 4. Helper to strip answer keys / rubrics from quiz questions for students when results_published is false
CREATE OR REPLACE FUNCTION public.sanitize_quiz_questions_for_student(
  p_questions jsonb,
  p_results_published boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(p_results_published, false) = true THEN COALESCE(p_questions, '[]'::jsonb)
    WHEN p_questions IS NULL OR jsonb_typeof(p_questions) <> 'array' THEN '[]'::jsonb
    ELSE COALESCE(
      (
        SELECT jsonb_agg(
          CASE
            WHEN jsonb_typeof(q) = 'object' THEN
              q - ARRAY[
                'correctAnswer',
                'rubricOrHint',
                'correctOptionIndex',
                'correctOptionText',
                'gradingNotes',
                'explanation',
                'solution',
                'teacherNotes'
              ]
            ELSE q
          END
        )
        FROM jsonb_array_elements(p_questions) AS q
      ),
      '[]'::jsonb
    )
  END;
$$;

-- 5. Strict Row Level Security (RLS) on public.quizzes
-- Raw table cannot be directly read (protects answer keys) or directly written by anon/authenticated.
-- Students read published, sanitized quizzes ONLY via student_list_published_quizzes() RPC or student_published_quizzes view.
-- Teachers read/write ONLY via verified teacher_* RPCs.
ALTER TABLE public.quizzes ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'quizzes'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.quizzes;', v_policy.policyname);
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE public.quizzes FROM anon, authenticated;

-- 6. Student-safe View (published = true only, answer keys stripped unless results_published = true)
DROP VIEW IF EXISTS public.student_published_quizzes;
CREATE VIEW public.student_published_quizzes AS
SELECT
  q.id,
  q.title,
  q.subject,
  public.sanitize_quiz_questions_for_student(q.questions, q.results_published) AS questions,
  q.duration_minutes::int AS duration_minutes,
  q.published,
  q.mode,
  q.due_at,
  q.scheduled_start,
  q.is_untimed,
  q.results_published,
  q.total_points::numeric AS total_points,
  q.created_at,
  q.updated_at
FROM public.quizzes q
WHERE q.published = true;

GRANT SELECT ON public.student_published_quizzes TO anon, authenticated;

-- 7. Student-safe RPC (1 single query, published = true only, answer keys stripped unless results_published = true)
DROP FUNCTION IF EXISTS public.student_list_published_quizzes();
CREATE FUNCTION public.student_list_published_quizzes()
RETURNS TABLE (
  id uuid,
  title text,
  subject text,
  questions jsonb,
  duration_minutes int,
  published boolean,
  mode text,
  due_at timestamptz,
  scheduled_start timestamptz,
  is_untimed boolean,
  results_published boolean,
  total_points numeric,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    q.id,
    q.title,
    q.subject,
    public.sanitize_quiz_questions_for_student(q.questions, q.results_published) AS questions,
    q.duration_minutes::int AS duration_minutes,
    q.published,
    q.mode,
    q.due_at,
    q.scheduled_start,
    q.is_untimed,
    q.results_published,
    q.total_points::numeric AS total_points,
    q.created_at,
    q.updated_at
  FROM public.quizzes q
  WHERE q.published = true
  ORDER BY q.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.student_list_published_quizzes() TO anon, authenticated;

-- 8. Teacher RPCs (verified via public.verify_teacher(p_password))

-- 8a. List all quizzes (including unpublished drafts & full answer keys)
CREATE OR REPLACE FUNCTION public.teacher_list_quizzes(
  p_password text
)
RETURNS SETOF public.quizzes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_password IS NULL OR NOT public.verify_teacher(p_password) THEN
    RAISE EXCEPTION 'Unauthorized teacher' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT q.*
  FROM public.quizzes q
  ORDER BY q.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_list_quizzes(text) TO anon, authenticated;

-- 8b. Upsert a SINGLE quiz row with all metadata fields
CREATE OR REPLACE FUNCTION public.teacher_upsert_quiz(
  p_password text,
  p_quiz jsonb
)
RETURNS public.quizzes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_questions jsonb;
  v_duration int;
  v_is_untimed boolean;
  v_mode text;
  v_published boolean;
  v_results_published boolean;
  v_due_at timestamptz;
  v_scheduled_start timestamptz;
  v_created_at timestamptz;
  v_total_points numeric;
  v_row public.quizzes;
BEGIN
  IF p_password IS NULL OR NOT public.verify_teacher(p_password) THEN
    RAISE EXCEPTION 'Unauthorized teacher' USING ERRCODE = '42501';
  END IF;

  IF p_quiz IS NULL OR jsonb_typeof(p_quiz) <> 'object' THEN
    RAISE EXCEPTION 'Invalid quiz payload' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_quiz->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_id := (p_quiz->>'id')::uuid;
  ELSE
    v_id := gen_random_uuid();
  END IF;

  v_questions := CASE
    WHEN jsonb_typeof(p_quiz->'questions') = 'array' THEN p_quiz->'questions'
    ELSE '[]'::jsonb
  END;

  v_duration := GREATEST(0, COALESCE(
    ROUND(NULLIF(p_quiz->>'duration_minutes', '')::numeric)::int,
    ROUND(NULLIF(p_quiz->>'durationMinutes', '')::numeric)::int,
    30
  ));
  v_is_untimed := COALESCE(
    (p_quiz->>'is_untimed')::boolean,
    (p_quiz->>'isUntimed')::boolean,
    (p_quiz->>'mode') = 'assignment',
    v_duration = 0
  );
  v_mode := CASE
    WHEN (p_quiz->>'mode') = 'assignment' OR v_is_untimed THEN 'assignment'
    ELSE 'exam'
  END;
  v_published := COALESCE((p_quiz->>'published')::boolean, true);
  v_results_published := COALESCE(
    (p_quiz->>'results_published')::boolean,
    (p_quiz->>'resultsPublished')::boolean,
    false
  );

  v_due_at := NULLIF(COALESCE(p_quiz->>'due_at', p_quiz->>'dueDate', ''), '')::timestamptz;
  v_created_at := COALESCE(NULLIF(COALESCE(p_quiz->>'created_at', p_quiz->>'createdAt', ''), '')::timestamptz, now());
  v_scheduled_start := COALESCE(
    NULLIF(COALESCE(p_quiz->>'scheduled_start', p_quiz->>'scheduledStartTime', ''), '')::timestamptz,
    v_created_at
  );

  v_total_points := NULLIF(COALESCE(p_quiz->>'total_points', p_quiz->>'totalPoints', ''), '')::numeric;
  IF v_total_points IS NULL OR v_total_points <= 0 THEN
    SELECT COALESCE(SUM(COALESCE(NULLIF(q->>'points', '')::numeric, 1)), 20)
    INTO v_total_points
    FROM jsonb_array_elements(v_questions) AS q;
  END IF;

  INSERT INTO public.quizzes (
    id,
    title,
    subject,
    questions,
    duration_minutes,
    published,
    mode,
    due_at,
    scheduled_start,
    is_untimed,
    results_published,
    total_points,
    created_at,
    updated_at
  )
  VALUES (
    v_id,
    COALESCE(NULLIF(btrim(p_quiz->>'title'), ''), 'آزمون کلاسی'),
    COALESCE(NULLIF(btrim(p_quiz->>'subject'), ''), 'عمومی'),
    v_questions,
    v_duration,
    v_published,
    v_mode,
    v_due_at,
    v_scheduled_start,
    v_is_untimed,
    v_results_published,
    v_total_points,
    v_created_at,
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    subject = EXCLUDED.subject,
    questions = EXCLUDED.questions,
    duration_minutes = EXCLUDED.duration_minutes,
    published = EXCLUDED.published,
    mode = EXCLUDED.mode,
    due_at = EXCLUDED.due_at,
    scheduled_start = EXCLUDED.scheduled_start,
    is_untimed = EXCLUDED.is_untimed,
    results_published = EXCLUDED.results_published,
    total_points = EXCLUDED.total_points,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_upsert_quiz(text, jsonb) TO anon, authenticated;

-- 8c. Delete a SINGLE quiz row (and its associated quiz_submissions)
CREATE OR REPLACE FUNCTION public.teacher_delete_quiz(
  p_password text,
  p_quiz_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_password IS NULL OR NOT public.verify_teacher(p_password) THEN
    RAISE EXCEPTION 'Unauthorized teacher' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.quiz_submissions WHERE quiz_id = p_quiz_id;
  DELETE FROM public.quizzes WHERE id = p_quiz_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_delete_quiz(text, uuid) TO anon, authenticated;

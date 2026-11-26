-- ============================================================================
-- Migration: Exam integrity monitoring (نظارت بر آزمون آنلاین)
-- File: supabase/migration_exam_integrity.sql
-- Safe & idempotent: can be executed multiple times in Supabase SQL Editor.
--
-- 1. Table public.exam_integrity_logs: one row per (student, exam) with the list of suspicious
--    events recorded on the student's device (leaving the exam page, screenshot shortcut keys,
--    copy/paste, print, long-press menu...). Reachable ONLY through the RPCs below.
-- 2. RPC student_log_exam_integrity(...)  — student appends events (verified by access code)
-- 3. RPC teacher_list_exam_integrity(...) — teacher reads the live log (verified by password)
-- 4. student_list_published_quizzes() now hides the questions of a scheduled exam until its
--    start time (so nobody can read or screenshot the questions before 09:00).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.exam_integrity_logs (
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  exam_id text NOT NULL,
  student_name text NOT NULL DEFAULT '',
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  event_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, exam_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_integrity_logs_updated_at
  ON public.exam_integrity_logs (updated_at DESC);

ALTER TABLE public.exam_integrity_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.exam_integrity_logs FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- Student: append integrity events (deduplicated by client event id, capped)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.student_log_exam_integrity(
  p_student_id uuid,
  p_access_code text,
  p_exam_id text,
  p_events jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student_id uuid;
  v_student_name text;
  v_existing jsonb := '[]'::jsonb;
  v_new jsonb := '[]'::jsonb;
  v_combined jsonb;
  v_trimmed jsonb;
  v_exam_id text := left(btrim(COALESCE(p_exam_id, '')), 128);
BEGIN
  IF p_student_id IS NULL OR p_access_code IS NULL OR btrim(p_access_code) = '' THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT s.id, COALESCE(s.full_name, '')
  INTO v_student_id, v_student_name
  FROM public.students s
  WHERE s.id = p_student_id
    AND s.access_code = btrim(p_access_code)
  LIMIT 1;

  IF v_student_id IS NULL THEN
    RAISE EXCEPTION 'Invalid student credentials' USING ERRCODE = '42501';
  END IF;

  IF v_exam_id = '' THEN
    RAISE EXCEPTION 'Invalid exam id' USING ERRCODE = '22023';
  END IF;

  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'Invalid events payload' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(l.events, '[]'::jsonb)
  INTO v_existing
  FROM public.exam_integrity_logs l
  WHERE l.student_id = v_student_id AND l.exam_id = v_exam_id
  FOR UPDATE;

  v_existing := COALESCE(v_existing, '[]'::jsonb);

  SELECT COALESCE(jsonb_agg(ev ORDER BY n), '[]'::jsonb)
  INTO v_new
  FROM (
    SELECT
      t.n,
      jsonb_build_object(
        'id', left(COALESCE(t.x->>'id', ''), 64),
        'type', left(COALESCE(NULLIF(t.x->>'type', ''), 'unknown'), 40),
        'at', left(COALESCE(t.x->>'at', ''), 40),
        'detail', left(COALESCE(t.x->>'detail', ''), 200),
        'duration_sec', CASE WHEN jsonb_typeof(t.x->'duration_sec') = 'number' THEN t.x->'duration_sec' ELSE 'null'::jsonb END,
        'server_at', to_jsonb(now())
      ) AS ev
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS t(x, n)
    WHERE jsonb_typeof(t.x) = 'object'
      AND t.n <= 100
      AND COALESCE(t.x->>'id', '') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_existing) AS y(v)
        WHERE y.v->>'id' = t.x->>'id'
      )
  ) s;

  v_combined := v_existing || v_new;

  -- Keep the latest 300 events per student/exam
  SELECT COALESCE(jsonb_agg(z.v ORDER BY z.n), '[]'::jsonb)
  INTO v_trimmed
  FROM (
    SELECT t.v, t.n
    FROM jsonb_array_elements(v_combined) WITH ORDINALITY AS t(v, n)
    ORDER BY t.n DESC
    LIMIT 300
  ) z;

  INSERT INTO public.exam_integrity_logs (student_id, exam_id, student_name, events, event_count, updated_at)
  VALUES (v_student_id, v_exam_id, v_student_name, v_trimmed, jsonb_array_length(v_trimmed), now())
  ON CONFLICT (student_id, exam_id) DO UPDATE SET
    student_name = EXCLUDED.student_name,
    events = EXCLUDED.events,
    event_count = EXCLUDED.event_count,
    updated_at = CASE
      WHEN jsonb_array_length(v_new) > 0 THEN now()
      ELSE public.exam_integrity_logs.updated_at
    END;

  RETURN jsonb_array_length(v_trimmed);
END;
$$;

REVOKE ALL ON FUNCTION public.student_log_exam_integrity(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_log_exam_integrity(uuid, text, text, jsonb) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- Teacher: read integrity logs (optionally only rows changed since p_since)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.teacher_list_exam_integrity(
  p_password text,
  p_since timestamptz DEFAULT NULL
)
RETURNS SETOF public.exam_integrity_logs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_password IS NULL OR NOT public.verify_teacher(p_password) THEN
    RAISE EXCEPTION 'Unauthorized teacher' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT l.*
  FROM public.exam_integrity_logs l
  WHERE p_since IS NULL OR l.updated_at > p_since
  ORDER BY l.updated_at DESC
  LIMIT 500;
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_list_exam_integrity(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_list_exam_integrity(text, timestamptz) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- Hide questions of scheduled exams until their start time (same signature as before)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.student_list_published_quizzes()
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
    CASE
      WHEN q.scheduled_start IS NOT NULL AND q.scheduled_start > now() THEN '[]'::jsonb
      ELSE public.sanitize_quiz_questions_for_student(q.questions, q.results_published)
    END AS questions,
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

-- ----------------------------------------------------------------------------
-- Server clock for the app (students' phones often have a wrong clock)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT now();
$$;

GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated;

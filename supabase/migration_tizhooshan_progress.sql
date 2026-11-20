-- ============================================================================
-- Migration: Tizhooshan Progress Table + Secure Student & Teacher RPCs
-- File: supabase/migration_tizhooshan_progress.sql
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

-- 2. Create public.tizhooshan_progress table
CREATE TABLE IF NOT EXISTS public.tizhooshan_progress (
  student_id uuid PRIMARY KEY REFERENCES public.students(id) ON DELETE CASCADE,
  student_name text NOT NULL DEFAULT '',
  total_xp integer NOT NULL DEFAULT 0,
  gems integer NOT NULL DEFAULT 25,
  streak integer NOT NULL DEFAULT 0,
  hearts integer NOT NULL DEFAULT 5,
  unlocked_topic_index integer NOT NULL DEFAULT 0,
  completed_topics jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_question_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  wrong_question_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_active_date text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for fast teacher leaderboard & recent activity queries
CREATE INDEX IF NOT EXISTS idx_tizhooshan_progress_xp_updated
  ON public.tizhooshan_progress (total_xp DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tizhooshan_progress_updated_at
  ON public.tizhooshan_progress (updated_at DESC);

-- Automatic updated_at trigger
DROP TRIGGER IF EXISTS trg_tizhooshan_progress_set_updated_at ON public.tizhooshan_progress;
CREATE TRIGGER trg_tizhooshan_progress_set_updated_at
  BEFORE UPDATE ON public.tizhooshan_progress
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- 3. Strict Row Level Security (all access goes through SECURITY DEFINER RPCs)
ALTER TABLE public.tizhooshan_progress ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tizhooshan_progress FROM anon, authenticated;

-- 4. Student RPC: Read (when p_progress IS NULL) or Upsert progress
DROP FUNCTION IF EXISTS public.student_upsert_tizhooshan(uuid, text, jsonb);

CREATE OR REPLACE FUNCTION public.student_upsert_tizhooshan(
  p_student_id uuid,
  p_access_code text,
  p_progress jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student_id uuid;
  v_student_name text;
  v_existing public.tizhooshan_progress%ROWTYPE;
  v_row public.tizhooshan_progress%ROWTYPE;
  v_total_xp integer;
  v_gems integer;
  v_streak integer;
  v_hearts integer;
  v_unlocked_topic_index integer;
  v_completed_topics jsonb;
  v_completed_question_ids jsonb;
  v_wrong_question_ids jsonb;
  v_last_active_date text;
BEGIN
  -- Strict student authentication
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

  -- Read-only mode when p_progress IS NULL
  IF p_progress IS NULL THEN
    SELECT tp.*
    INTO v_existing
    FROM public.tizhooshan_progress tp
    WHERE tp.student_id = v_student_id
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    RETURN to_jsonb(v_existing);
  END IF;

  IF jsonb_typeof(p_progress) <> 'object' THEN
    RAISE EXCEPTION 'Invalid progress payload' USING ERRCODE = '22023';
  END IF;

  -- Safely parse incoming fields (supports both camelCase and snake_case keys)
  v_total_xp := GREATEST(0, COALESCE(
    NULLIF(p_progress->>'total_xp', '')::integer,
    NULLIF(p_progress->>'totalXp', '')::integer,
    0
  ));

  v_gems := GREATEST(0, COALESCE(
    NULLIF(p_progress->>'gems', '')::integer,
    25
  ));

  v_streak := GREATEST(0, COALESCE(
    NULLIF(p_progress->>'streak', '')::integer,
    0
  ));

  v_hearts := LEAST(5, GREATEST(0, COALESCE(
    NULLIF(p_progress->>'hearts', '')::integer,
    5
  )));

  v_unlocked_topic_index := GREATEST(0, COALESCE(
    NULLIF(p_progress->>'unlocked_topic_index', '')::integer,
    NULLIF(p_progress->>'unlockedTopicIndex', '')::integer,
    0
  ));

  v_completed_topics := CASE
    WHEN jsonb_typeof(p_progress->'completed_topics') = 'object' THEN p_progress->'completed_topics'
    WHEN jsonb_typeof(p_progress->'completedTopics') = 'object' THEN p_progress->'completedTopics'
    ELSE '{}'::jsonb
  END;

  v_completed_question_ids := CASE
    WHEN jsonb_typeof(p_progress->'completed_question_ids') = 'array' THEN p_progress->'completed_question_ids'
    WHEN jsonb_typeof(p_progress->'completedQuestionIds') = 'array' THEN p_progress->'completedQuestionIds'
    ELSE '[]'::jsonb
  END;

  v_wrong_question_ids := CASE
    WHEN jsonb_typeof(p_progress->'wrong_question_ids') = 'array' THEN p_progress->'wrong_question_ids'
    WHEN jsonb_typeof(p_progress->'wrongQuestionIds') = 'array' THEN p_progress->'wrongQuestionIds'
    ELSE '[]'::jsonb
  END;

  v_last_active_date := COALESCE(
    NULLIF(btrim(COALESCE(p_progress->>'last_active_date', '')), ''),
    NULLIF(btrim(COALESCE(p_progress->>'lastActiveDate', '')), ''),
    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
  );

  INSERT INTO public.tizhooshan_progress (
    student_id,
    student_name,
    total_xp,
    gems,
    streak,
    hearts,
    unlocked_topic_index,
    completed_topics,
    completed_question_ids,
    wrong_question_ids,
    last_active_date,
    updated_at
  )
  VALUES (
    v_student_id,
    v_student_name,
    v_total_xp,
    v_gems,
    v_streak,
    v_hearts,
    v_unlocked_topic_index,
    v_completed_topics,
    v_completed_question_ids,
    v_wrong_question_ids,
    v_last_active_date,
    now()
  )
  ON CONFLICT (student_id) DO UPDATE SET
    student_name = EXCLUDED.student_name,
    total_xp = GREATEST(public.tizhooshan_progress.total_xp, EXCLUDED.total_xp),
    gems = EXCLUDED.gems,
    streak = EXCLUDED.streak,
    hearts = EXCLUDED.hearts,
    unlocked_topic_index = GREATEST(public.tizhooshan_progress.unlocked_topic_index, EXCLUDED.unlocked_topic_index),
    completed_topics = COALESCE(public.tizhooshan_progress.completed_topics, '{}'::jsonb) || COALESCE(EXCLUDED.completed_topics, '{}'::jsonb),
    completed_question_ids = (
      SELECT COALESCE(jsonb_agg(DISTINCT val), '[]'::jsonb)
      FROM (
        SELECT value AS val FROM jsonb_array_elements(COALESCE(public.tizhooshan_progress.completed_question_ids, '[]'::jsonb))
        UNION
        SELECT value AS val FROM jsonb_array_elements(COALESCE(EXCLUDED.completed_question_ids, '[]'::jsonb))
      ) merged_q
    ),
    wrong_question_ids = EXCLUDED.wrong_question_ids,
    last_active_date = EXCLUDED.last_active_date,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

GRANT EXECUTE ON FUNCTION public.student_upsert_tizhooshan(uuid, text, jsonb) TO anon, authenticated;

-- 5. Student Leaderboard RPC (student-safe summary for class leaderboard in TizhooshanPrep)
DROP FUNCTION IF EXISTS public.student_list_tizhooshan_leaderboard(uuid, text);

CREATE OR REPLACE FUNCTION public.student_list_tizhooshan_leaderboard(
  p_student_id uuid,
  p_access_code text
)
RETURNS TABLE (
  student_id uuid,
  student_name text,
  total_xp integer,
  streak integer,
  hearts integer,
  unlocked_topic_index integer,
  last_active_date text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_valid boolean := false;
BEGIN
  IF p_student_id IS NULL OR p_access_code IS NULL OR btrim(p_access_code) = '' THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.students s
    WHERE s.id = p_student_id
      AND s.access_code = btrim(p_access_code)
  ) INTO v_valid;

  IF NOT v_valid THEN
    RAISE EXCEPTION 'Invalid student credentials' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    tp.student_id,
    tp.student_name,
    tp.total_xp,
    tp.streak,
    tp.hearts,
    tp.unlocked_topic_index,
    tp.last_active_date,
    tp.updated_at
  FROM public.tizhooshan_progress tp
  ORDER BY tp.total_xp DESC, tp.updated_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.student_list_tizhooshan_leaderboard(uuid, text) TO anon, authenticated;

-- 6. Teacher RPC: List full Tizhooshan progress for all students
DROP FUNCTION IF EXISTS public.teacher_list_tizhooshan(text);

CREATE OR REPLACE FUNCTION public.teacher_list_tizhooshan(
  p_password text
)
RETURNS SETOF public.tizhooshan_progress
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_password IS NULL OR NOT public.verify_teacher(p_password) THEN
    RAISE EXCEPTION 'Unauthorized teacher' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT tp.*
  FROM public.tizhooshan_progress tp
  ORDER BY tp.total_xp DESC, tp.updated_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_list_tizhooshan(text) TO anon, authenticated;

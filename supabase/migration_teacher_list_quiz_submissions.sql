-- ============================================================================
-- Migration: Teacher RPC for listing all quiz_submissions rows
-- File: supabase/migration_teacher_list_quiz_submissions.sql
-- Safe & idempotent: can be executed multiple times in Supabase SQL Editor.
-- ============================================================================

DROP FUNCTION IF EXISTS public.teacher_list_quiz_submissions(text);

CREATE OR REPLACE FUNCTION public.teacher_list_quiz_submissions(
  p_password text
)
RETURNS SETOF public.quiz_submissions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_password IS NULL OR NOT public.verify_teacher(p_password) THEN
    RAISE EXCEPTION 'Unauthorized teacher' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT qs.*
  FROM public.quiz_submissions qs
  ORDER BY qs.submitted_at DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_list_quiz_submissions(text) TO anon, authenticated;

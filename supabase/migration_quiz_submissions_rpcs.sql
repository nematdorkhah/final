-- ============================================================================
-- Migration Phase 1 (Hardened, Safe & Additive — Zero Downtime):
-- Authenticated SECURITY DEFINER RPCs for public.quiz_submissions
-- File: supabase/migration_quiz_submissions_rpcs.sql
--
-- SECURITY PROPERTIES:
--   1. Zero privilege escalation: students CANNOT supply/modify score,
--      teacher_approved, approved, is_released, isReleased, approved_at,
--      approvedAt, questionScores, questionFeedbacks, teacherNotes,
--      teacherGrading, regradeHistory, raw_score, totalScore, scaledScore20,
--      earnedPoints, status, aiGrading, or instantStats.
--   2. Strict allowlist filtering on incoming student answers JSONB:
--      only legitimate question IDs (verified against public.quizzes.questions
--      when quiz exists) and allowlisted StudentExamAnswer properties are kept.
--   3. Server-authoritative timestamps: client p_submitted_at is ignored;
--      authoritative submitted_at is set exclusively by pg_catalog.now() on
--      insert and preserved on subsequent syncs.
--   4. Atomic, concurrency-safe upsert: uses transaction-scoped advisory lock
--      pg_catalog.pg_advisory_xact_lock(...) per (student_id, exam_key), plus
--      conditionally creates a partial unique index on (student_id, quiz_id)
--      WHERE quiz_id IS NOT NULL ONLY if no pre-existing duplicates exist.
--   5. Hardened SECURITY DEFINER: fixed search_path = pg_catalog, public;
--      fully qualified object references; REVOKE ALL FROM PUBLIC; explicit
--      GRANT EXECUTE only to anon, authenticated, service_role.
--   6. Least-privilege read projection: explicit RETURNS TABLE columns;
--      unreleased teacher notes/grades and national codes are withheld from
--      student_list_my_quiz_submissions until approved/released.
--   7. Non-destructive: never deletes, truncates, resets, or alters existing
--      student submissions, exams, grades, or approvals.
--
-- DEPLOYMENT ORDER:
--   1. Execute THIS file (Phase 1) in Supabase SQL Editor as postgres.
--   2. Deploy updated frontend (Netlify) and Cloudflare Worker.
--   3. Verify live student & teacher exam workflows end-to-end.
--   4. Only AFTER Step 3 succeeds, execute Phase 2:
--      supabase/migration_quiz_submissions_rls_lock.sql
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Concurrency-safe partial unique index (ONLY if zero duplicates exist)
--    Never modifies or deletes any existing rows.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_dup_count bigint := 0;
BEGIN
  SELECT pg_catalog.count(*)
  INTO v_dup_count
  FROM (
    SELECT qs.student_id, qs.quiz_id
    FROM public.quiz_submissions qs
    WHERE qs.quiz_id IS NOT NULL
    GROUP BY qs.student_id, qs.quiz_id
    HAVING pg_catalog.count(*) > 1
  ) dups;

  IF v_dup_count = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_submissions_unique_student_quiz
      ON public.quiz_submissions (student_id, quiz_id)
      WHERE quiz_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'Skipping unique index idx_quiz_submissions_unique_student_quiz: % legacy duplicate (student_id, quiz_id) pair(s) exist. Advisory xact locking in RPCs still prevents new duplicates.', v_dup_count;
  END IF;
END;
$$;

-- Supporting lookup index for per-student / per-quiz queries
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_student_quiz_submitted
  ON public.quiz_submissions (student_id, quiz_id, submitted_at DESC);

-- ----------------------------------------------------------------------------
-- 1. Teacher Read RPC: public.teacher_list_quiz_submissions(p_password)
--    Returns explicit columns only after server-side teacher authentication.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.teacher_list_quiz_submissions(text);

CREATE FUNCTION public.teacher_list_quiz_submissions(
  p_password text
)
RETURNS TABLE (
  id uuid,
  quiz_id uuid,
  student_id uuid,
  score numeric,
  submitted_at timestamptz,
  updated_at timestamptz,
  answers jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_password IS NULL
     OR pg_catalog.btrim(p_password) = ''
     OR NOT COALESCE(public.verify_teacher(p_password), false)
  THEN
    PERFORM pg_catalog.pg_sleep(0.25);
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    qs.id,
    qs.quiz_id,
    qs.student_id,
    qs.score,
    qs.submitted_at,
    qs.updated_at,
    qs.answers
  FROM public.quiz_submissions qs
  ORDER BY qs.submitted_at DESC NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_list_quiz_submissions(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_list_quiz_submissions(text) TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Student Read RPC: public.student_list_my_quiz_submissions(...)
--    Returns ONLY the authenticated student's own rows with explicit columns.
--    Withholds unreleased draft teacher scores/notes and sensitive identifiers.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.student_list_my_quiz_submissions(uuid, text, uuid);

CREATE FUNCTION public.student_list_my_quiz_submissions(
  p_student_id uuid,
  p_access_code text,
  p_exam_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  quiz_id uuid,
  student_id uuid,
  score numeric,
  submitted_at timestamptz,
  updated_at timestamptz,
  answers jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_valid_student uuid;
BEGIN
  IF p_student_id IS NULL OR p_access_code IS NULL OR pg_catalog.btrim(p_access_code) = '' THEN
    PERFORM pg_catalog.pg_sleep(0.20);
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT s.id
  INTO v_valid_student
  FROM public.students s
  WHERE s.id = p_student_id
    AND s.access_code = pg_catalog.btrim(p_access_code)
  LIMIT 1;

  IF v_valid_student IS NULL THEN
    PERFORM pg_catalog.pg_sleep(0.20);
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    qs.id,
    qs.quiz_id,
    qs.student_id,
    CASE
      WHEN COALESCE((qs.answers->>'teacher_approved')::boolean, false) = true
        OR COALESCE((qs.answers->>'approved')::boolean, false) = true
        OR COALESCE((qs.answers->>'is_released')::boolean, false) = true
        OR COALESCE((qs.answers->>'isReleased')::boolean, false) = true
        OR COALESCE(q.results_published, false) = true
      THEN qs.score
      ELSE NULL::numeric
    END AS score,
    qs.submitted_at,
    qs.updated_at,
    CASE
      WHEN COALESCE((qs.answers->>'teacher_approved')::boolean, false) = true
        OR COALESCE((qs.answers->>'approved')::boolean, false) = true
        OR COALESCE((qs.answers->>'is_released')::boolean, false) = true
        OR COALESCE((qs.answers->>'isReleased')::boolean, false) = true
        OR COALESCE(q.results_published, false) = true
      THEN COALESCE(qs.answers, '{}'::jsonb) - ARRAY['student_national_code']
      ELSE COALESCE(qs.answers, '{}'::jsonb) - ARRAY[
        'student_national_code',
        'score',
        'raw_score',
        'totalScore',
        'scaledScore20',
        'earnedPoints',
        'teacher_approved',
        'approved',
        'is_released',
        'isReleased',
        'approved_at',
        'approvedAt',
        'questionScores',
        'questionFeedbacks',
        'teacherNotes',
        'teacherGrading',
        'regradeHistory',
        'aiGrading',
        'instantStats',
        'status'
      ]
    END AS answers
  FROM public.quiz_submissions qs
  LEFT JOIN public.quizzes q
    ON q.id = qs.quiz_id
  WHERE qs.student_id = v_valid_student
    AND (
      p_exam_id IS NULL
      OR qs.quiz_id = p_exam_id
      OR (qs.answers->>'quiz_id') = p_exam_id::text
      OR (qs.answers->>'exam_id') = p_exam_id::text
    )
  ORDER BY qs.submitted_at DESC NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.student_list_my_quiz_submissions(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_list_my_quiz_submissions(uuid, text, uuid) TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Student Write RPC: public.student_upsert_quiz_submission(...)
--    NOTE ON LEGACY PARAMETERS:
--      p_score and p_submitted_at are retained ONLY for backward-compatible
--      RPC signature with existing clients and are STRICTLY IGNORED inside
--      this function. Students cannot assign scores, set teacher flags, or
--      forge submission timestamps.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.student_upsert_quiz_submission(uuid, text, uuid, jsonb, numeric, timestamptz);

CREATE FUNCTION public.student_upsert_quiz_submission(
  p_student_id uuid,
  p_access_code text,
  p_quiz_id uuid,
  p_answers jsonb,
  p_score numeric DEFAULT NULL,
  p_submitted_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  quiz_id uuid,
  student_id uuid,
  score numeric,
  submitted_at timestamptz,
  updated_at timestamptz,
  answers jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_valid_student uuid;
  v_student_name text;
  v_effective_quiz_id uuid := NULL;
  v_quiz_questions jsonb := NULL;
  v_quiz_id_text text;
  v_allowed_question_ids text[] := NULL;
  v_reserved_keys CONSTANT text[] := ARRAY[
    'score',
    'raw_score',
    'totalScore',
    'scaledScore20',
    'earnedPoints',
    'teacher_approved',
    'approved',
    'is_released',
    'isReleased',
    'approved_at',
    'approvedAt',
    'questionScores',
    'questionFeedbacks',
    'teacherNotes',
    'teacherGrading',
    'regradeHistory',
    'aiGrading',
    'instantStats',
    'status',
    'student_national_code',
    'student_name',
    'submitted_at',
    'exam_id',
    'quiz_id'
  ];
  v_allowed_answer_fields CONSTANT text[] := ARRAY[
    'selectedOption',
    'selectedOptionIndex',
    'selectedOptionText',
    'selectedOptionId',
    'textAnswer',
    'imageAttachment',
    'answeredAt'
  ];
  v_sanitized_answers jsonb := '{}'::jsonb;
  v_entry record;
  v_clean_obj jsonb;
  v_field record;
  v_server_now CONSTANT timestamptz := pg_catalog.now();
  v_lock_key text;
  v_existing public.quiz_submissions%ROWTYPE;
  v_existing_teacher_fields jsonb := '{}'::jsonb;
  v_existing_is_approved boolean := false;
  v_result public.quiz_submissions%ROWTYPE;
BEGIN
  -- 1. Strict student credential authentication
  IF p_student_id IS NULL OR p_access_code IS NULL OR pg_catalog.btrim(p_access_code) = '' THEN
    PERFORM pg_catalog.pg_sleep(0.20);
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_answers IS NULL OR pg_catalog.jsonb_typeof(p_answers) <> 'object' THEN
    RAISE EXCEPTION 'Invalid answers payload' USING ERRCODE = '22023';
  END IF;

  SELECT s.id, COALESCE(s.full_name, '')
  INTO v_valid_student, v_student_name
  FROM public.students s
  WHERE s.id = p_student_id
    AND s.access_code = pg_catalog.btrim(p_access_code)
  LIMIT 1;

  IF v_valid_student IS NULL THEN
    PERFORM pg_catalog.pg_sleep(0.20);
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- 2. Resolve target quiz (if present in public.quizzes) & extract authoritative question IDs
  IF p_quiz_id IS NOT NULL THEN
    SELECT q.id, q.questions
    INTO v_effective_quiz_id, v_quiz_questions
    FROM public.quizzes q
    WHERE q.id = p_quiz_id
    LIMIT 1;
  END IF;

  v_quiz_id_text := COALESCE(
    v_effective_quiz_id::text,
    p_quiz_id::text,
    NULLIF(pg_catalog.btrim(COALESCE(p_answers->>'quiz_id', p_answers->>'exam_id', '')), '')
  );

  IF v_quiz_id_text IS NULL OR pg_catalog.length(v_quiz_id_text) > 128 THEN
    RAISE EXCEPTION 'Invalid quiz identifier' USING ERRCODE = '22023';
  END IF;

  IF v_effective_quiz_id IS NOT NULL AND pg_catalog.jsonb_typeof(v_quiz_questions) = 'array' THEN
    SELECT pg_catalog.array_agg(DISTINCT q_id)
    INTO v_allowed_question_ids
    FROM (
      SELECT NULLIF(pg_catalog.btrim(elem->>'id'), '') AS q_id
      FROM pg_catalog.jsonb_array_elements(v_quiz_questions) AS elem
      WHERE pg_catalog.jsonb_typeof(elem) = 'object'
    ) qids
    WHERE q_id IS NOT NULL;
  END IF;

  -- 3. Strict allowlist filtering of student-editable answer entries ONLY
  --    Every teacher-controlled / grading / release / score field is dropped.
  FOR v_entry IN
    SELECT key, value
    FROM pg_catalog.jsonb_each(p_answers)
  LOOP
    -- Never allow any reserved or teacher-controlled top-level key
    IF v_entry.key = ANY(v_reserved_keys) THEN
      CONTINUE;
    END IF;

    -- Allowlist key check:
    --   - When quiz exists in public.quizzes with defined question IDs: key MUST be an actual question ID of that quiz.
    --   - Otherwise (legacy quiz outside quizzes table): key must match safe question ID pattern.
    IF v_allowed_question_ids IS NOT NULL AND pg_catalog.array_length(v_allowed_question_ids, 1) > 0 THEN
      IF NOT (v_entry.key = ANY(v_allowed_question_ids)) THEN
        CONTINUE;
      END IF;
    ELSE
      IF v_entry.key !~ '^(q[0-9a-zA-Z_-]{0,63}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$' THEN
        CONTINUE;
      END IF;
    END IF;

    -- Allowlist value shape check
    IF pg_catalog.jsonb_typeof(v_entry.value) IN ('string', 'number', 'boolean') THEN
      v_sanitized_answers := v_sanitized_answers || pg_catalog.jsonb_build_object(v_entry.key, v_entry.value);
    ELSIF pg_catalog.jsonb_typeof(v_entry.value) = 'object' THEN
      v_clean_obj := '{}'::jsonb;
      FOR v_field IN
        SELECT key, value
        FROM pg_catalog.jsonb_each(v_entry.value)
      LOOP
        IF v_field.key = ANY(v_allowed_answer_fields)
           AND pg_catalog.jsonb_typeof(v_field.value) IN ('string', 'number', 'boolean', 'null')
        THEN
          v_clean_obj := v_clean_obj || pg_catalog.jsonb_build_object(v_field.key, v_field.value);
        END IF;
      END LOOP;
      IF v_clean_obj <> '{}'::jsonb THEN
        v_sanitized_answers := v_sanitized_answers || pg_catalog.jsonb_build_object(v_entry.key, v_clean_obj);
      END IF;
    END IF;
  END LOOP;

  -- Attach ONLY server-derived safe metadata (never trusting client score, flags, or timestamps)
  v_sanitized_answers := v_sanitized_answers || pg_catalog.jsonb_build_object(
    'exam_id', v_quiz_id_text,
    'quiz_id', v_quiz_id_text,
    'student_name', v_student_name,
    'submitted_at', v_server_now
  );

  -- 4. Atomic concurrency serialization per (student_id, exam_key)
  --    Prevents duplicate rows under simultaneous double-clicks / retries / multi-tab saves.
  v_lock_key := 'quiz_submission:' || v_valid_student::text || ':' || v_quiz_id_text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_lock_key, 42)
  );

  SELECT qs.*
  INTO v_existing
  FROM public.quiz_submissions qs
  WHERE qs.student_id = v_valid_student
    AND (
      (v_effective_quiz_id IS NOT NULL AND qs.quiz_id = v_effective_quiz_id)
      OR (p_quiz_id IS NOT NULL AND qs.quiz_id = p_quiz_id)
      OR (qs.answers->>'quiz_id') = v_quiz_id_text
      OR (qs.answers->>'exam_id') = v_quiz_id_text
    )
  ORDER BY qs.submitted_at ASC NULLS LAST, qs.id ASC
  LIMIT 1
  FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    v_existing_is_approved :=
      COALESCE((v_existing.answers->>'teacher_approved')::boolean, false) = true
      OR COALESCE((v_existing.answers->>'approved')::boolean, false) = true
      OR COALESCE((v_existing.answers->>'is_released')::boolean, false) = true
      OR COALESCE((v_existing.answers->>'isReleased')::boolean, false) = true;

    -- Once teacher-approved or released, student sync is strictly read-only/idempotent:
    -- neither answers, nor score, nor approval/release state, nor timestamp can be mutated.
    IF v_existing_is_approved THEN
      v_result := v_existing;
    ELSE
      -- Even before approval, unconditionally preserve ANY existing teacher-controlled keys
      -- and the original authoritative server submitted_at & score.
      SELECT COALESCE(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      INTO v_existing_teacher_fields
      FROM pg_catalog.jsonb_each(COALESCE(v_existing.answers, '{}'::jsonb)) AS e
      WHERE e.key = ANY(v_reserved_keys);

      -- Preserve authoritative original server submitted_at inside answers metadata
      v_existing_teacher_fields := v_existing_teacher_fields || pg_catalog.jsonb_build_object(
        'submitted_at', COALESCE(v_existing.submitted_at, v_server_now),
        'exam_id', v_quiz_id_text,
        'quiz_id', v_quiz_id_text,
        'student_name', v_student_name
      );

      UPDATE public.quiz_submissions qs
      SET
        quiz_id = COALESCE(qs.quiz_id, v_effective_quiz_id),
        answers = COALESCE(qs.answers, '{}'::jsonb) || v_sanitized_answers || v_existing_teacher_fields,
        -- Never trust student score; preserve existing DB score unchanged
        score = qs.score,
        -- Never trust client timestamp; preserve original server submission time
        submitted_at = COALESCE(qs.submitted_at, v_server_now)
      WHERE qs.id = v_existing.id
      RETURNING * INTO v_result;
    END IF;
  ELSE
    -- New submission: server sets score = 0 (ungraded) and submitted_at = server now()
    INSERT INTO public.quiz_submissions (
      student_id,
      quiz_id,
      answers,
      score,
      submitted_at
    )
    VALUES (
      v_valid_student,
      v_effective_quiz_id,
      v_sanitized_answers,
      0,
      v_server_now
    )
    RETURNING * INTO v_result;
  END IF;

  RETURN QUERY
  SELECT
    v_result.id,
    v_result.quiz_id,
    v_result.student_id,
    CASE
      WHEN COALESCE((v_result.answers->>'teacher_approved')::boolean, false) = true
        OR COALESCE((v_result.answers->>'approved')::boolean, false) = true
        OR COALESCE((v_result.answers->>'is_released')::boolean, false) = true
        OR COALESCE((v_result.answers->>'isReleased')::boolean, false) = true
      THEN v_result.score
      ELSE NULL::numeric
    END,
    v_result.submitted_at,
    v_result.updated_at,
    CASE
      WHEN COALESCE((v_result.answers->>'teacher_approved')::boolean, false) = true
        OR COALESCE((v_result.answers->>'approved')::boolean, false) = true
        OR COALESCE((v_result.answers->>'is_released')::boolean, false) = true
        OR COALESCE((v_result.answers->>'isReleased')::boolean, false) = true
      THEN COALESCE(v_result.answers, '{}'::jsonb) - ARRAY['student_national_code']
      ELSE v_sanitized_answers
    END;
END;
$$;

REVOKE ALL ON FUNCTION public.student_upsert_quiz_submission(uuid, text, uuid, jsonb, numeric, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_upsert_quiz_submission(uuid, text, uuid, jsonb, numeric, timestamptz) TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Teacher Write RPC: public.teacher_upsert_quiz_submission(...)
--    Exclusive authoritative path for teacher grading, approval, and release.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.teacher_upsert_quiz_submission(text, uuid, uuid, jsonb, numeric);

CREATE FUNCTION public.teacher_upsert_quiz_submission(
  p_password text,
  p_quiz_id uuid,
  p_student_id uuid,
  p_answers jsonb,
  p_score numeric DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  quiz_id uuid,
  student_id uuid,
  score numeric,
  submitted_at timestamptz,
  updated_at timestamptz,
  answers jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.quiz_submissions%ROWTYPE;
  v_effective_quiz_id uuid := NULL;
  v_quiz_id_text text;
  v_lock_key text;
  v_server_now CONSTANT timestamptz := pg_catalog.now();
  v_result public.quiz_submissions%ROWTYPE;
BEGIN
  IF p_password IS NULL
     OR pg_catalog.btrim(p_password) = ''
     OR NOT COALESCE(public.verify_teacher(p_password), false)
  THEN
    PERFORM pg_catalog.pg_sleep(0.25);
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_student_id IS NULL OR p_answers IS NULL OR pg_catalog.jsonb_typeof(p_answers) <> 'object' THEN
    RAISE EXCEPTION 'Invalid submission payload' USING ERRCODE = '22023';
  END IF;

  IF p_score IS NOT NULL AND (p_score < 0 OR p_score > 1000) THEN
    RAISE EXCEPTION 'Invalid score value' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.students s
    WHERE s.id = p_student_id
  ) THEN
    RAISE EXCEPTION 'Invalid student identifier' USING ERRCODE = '22023';
  END IF;

  IF p_quiz_id IS NOT NULL THEN
    SELECT q.id
    INTO v_effective_quiz_id
    FROM public.quizzes q
    WHERE q.id = p_quiz_id
    LIMIT 1;
  END IF;

  v_quiz_id_text := COALESCE(
    v_effective_quiz_id::text,
    p_quiz_id::text,
    NULLIF(pg_catalog.btrim(COALESCE(p_answers->>'quiz_id', p_answers->>'exam_id', '')), '')
  );

  IF v_quiz_id_text IS NULL OR pg_catalog.length(v_quiz_id_text) > 128 THEN
    RAISE EXCEPTION 'Invalid quiz identifier' USING ERRCODE = '22023';
  END IF;

  -- Share the exact same advisory lock namespace with student_upsert_quiz_submission
  v_lock_key := 'quiz_submission:' || p_student_id::text || ':' || v_quiz_id_text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_lock_key, 42)
  );

  SELECT qs.*
  INTO v_existing
  FROM public.quiz_submissions qs
  WHERE qs.student_id = p_student_id
    AND (
      (v_effective_quiz_id IS NOT NULL AND qs.quiz_id = v_effective_quiz_id)
      OR (p_quiz_id IS NOT NULL AND qs.quiz_id = p_quiz_id)
      OR (qs.answers->>'quiz_id') = v_quiz_id_text
      OR (qs.answers->>'exam_id') = v_quiz_id_text
    )
  ORDER BY qs.submitted_at ASC NULLS LAST, qs.id ASC
  LIMIT 1
  FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.quiz_submissions qs
    SET
      quiz_id = COALESCE(qs.quiz_id, v_effective_quiz_id),
      score = COALESCE(p_score, qs.score, 0),
      answers = COALESCE(qs.answers, '{}'::jsonb) || p_answers
    WHERE qs.id = v_existing.id
    RETURNING * INTO v_result;
  ELSE
    INSERT INTO public.quiz_submissions (
      student_id,
      quiz_id,
      answers,
      score,
      submitted_at
    )
    VALUES (
      p_student_id,
      v_effective_quiz_id,
      p_answers,
      COALESCE(p_score, 0),
      v_server_now
    )
    RETURNING * INTO v_result;
  END IF;

  RETURN QUERY
  SELECT
    v_result.id,
    v_result.quiz_id,
    v_result.student_id,
    v_result.score,
    v_result.submitted_at,
    v_result.updated_at,
    v_result.answers;
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_upsert_quiz_submission(text, uuid, uuid, jsonb, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_upsert_quiz_submission(text, uuid, uuid, jsonb, numeric) TO anon, authenticated, service_role;

COMMIT;

-- ============================================================================
-- Migration: Secure Student Exam Review RPC
-- File: supabase/migration_student_exam_review.sql
-- Safe & idempotent: returns full questions, correct answers, explanations,
-- student answers, and per-question scores ONLY when results for that student
-- are approved/published.
-- ============================================================================

DROP FUNCTION IF EXISTS public.student_get_exam_review(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.student_get_exam_review(
  p_exam_id uuid,
  p_student_id uuid,
  p_access_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student_id uuid;
  v_student_name text;
  v_access_code text;
  v_quiz public.quizzes%ROWTYPE;
  v_post_sub jsonb := NULL;
  v_sys_sub jsonb := NULL;
  v_qs_row record;
  v_has_qs boolean := false;
  v_submission jsonb := NULL;
  v_answers jsonb := '{}'::jsonb;
  v_grade_row record;
  v_has_grade boolean := false;
  v_sub_approved boolean := false;
  v_is_released boolean := false;
  v_questions jsonb := '[]'::jsonb;
  v_questions_review jsonb := '[]'::jsonb;
  v_total_points numeric := 20;
  v_earned_points numeric := NULL;
  v_scaled_score_20 numeric := NULL;
  v_sys_body text;
  v_sys_arr jsonb;
  v_clean_quiz_title text;
BEGIN
  -- 1. Verify student identity strictly
  IF p_exam_id IS NULL OR p_student_id IS NULL OR p_access_code IS NULL OR btrim(p_access_code) = '' THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT s.id, s.full_name, s.access_code
  INTO v_student_id, v_student_name, v_access_code
  FROM public.students s
  WHERE s.id = p_student_id
    AND s.access_code = btrim(p_access_code)
  LIMIT 1;

  IF v_student_id IS NULL THEN
    RAISE EXCEPTION 'Invalid student credentials' USING ERRCODE = '42501';
  END IF;

  -- 2. Load full unsanitized quiz from public.quizzes
  SELECT q.*
  INTO v_quiz
  FROM public.quizzes q
  WHERE q.id = p_exam_id
  LIMIT 1;

  IF v_quiz.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'released', false,
      'reason', 'not_found',
      'message', 'اطلاعات این آزمون در سامانه یافت نشد.'
    );
  END IF;

  v_questions := CASE
    WHEN jsonb_typeof(v_quiz.questions) = 'array' THEN v_quiz.questions
    ELSE '[]'::jsonb
  END;

  -- 3. Locate student's submission across individual __EXAM_SUB__ post, __SYSTEM_EXAM_SUBMISSIONS__, and quiz_submissions
  -- 3a. Individual submission post
  BEGIN
    SELECT p.body::jsonb
    INTO v_post_sub
    FROM public.posts p
    WHERE p.title IN (
      '__EXAM_SUB__:' || p_exam_id::text || ':' || v_student_id::text,
      '__EXAM_SUB__:' || p_exam_id::text || ':' || v_access_code
    )
      AND p.body IS NOT NULL
    ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC NULLS LAST
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_post_sub := NULL;
  END;

  -- 3b. Class-wide __SYSTEM_EXAM_SUBMISSIONS__ container (teacher grading updates often persist here)
  BEGIN
    SELECT p.body
    INTO v_sys_body
    FROM public.posts p
    WHERE p.title = '__SYSTEM_EXAM_SUBMISSIONS__'
      AND p.body IS NOT NULL
    ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC NULLS LAST
    LIMIT 1;

    IF v_sys_body IS NOT NULL AND btrim(v_sys_body) <> '' THEN
      v_sys_arr := v_sys_body::jsonb;
      IF jsonb_typeof(v_sys_arr) = 'array' THEN
        SELECT elem
        INTO v_sys_sub
        FROM jsonb_array_elements(v_sys_arr) AS elem
        WHERE (elem->>'examId') = p_exam_id::text
          AND (
            (elem->>'studentId') = v_student_id::text
            OR (elem->>'studentId') = v_access_code
          )
        ORDER BY
          CASE
            WHEN COALESCE((elem->'teacherGrading'->>'approved')::boolean, false) = true
              OR COALESCE((elem->>'isReleased')::boolean, false) = true
              OR COALESCE(elem->>'status', '') IN ('released', 'approved', 'graded')
            THEN 1 ELSE 0
          END DESC,
          COALESCE(elem->>'submittedAt', '') DESC
        LIMIT 1;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_sys_sub := NULL;
  END;

  -- 3c. quiz_submissions row
  SELECT qs.id, qs.quiz_id, qs.student_id, qs.answers, qs.score, qs.submitted_at
  INTO v_qs_row
  FROM public.quiz_submissions qs
  WHERE qs.student_id = v_student_id
    AND (
      qs.quiz_id = p_exam_id
      OR (qs.answers->>'exam_id') = p_exam_id::text
      OR (qs.answers->>'quiz_id') = p_exam_id::text
    )
  ORDER BY qs.submitted_at DESC NULLS LAST
  LIMIT 1;

  v_has_qs := (v_qs_row.id IS NOT NULL);

  -- Choose most authoritative submission (preferring approved teacherGrading record)
  IF v_sys_sub IS NOT NULL AND (
    COALESCE((v_sys_sub->'teacherGrading'->>'approved')::boolean, false) = true
    OR COALESCE((v_sys_sub->>'isReleased')::boolean, false) = true
    OR COALESCE(v_sys_sub->>'status', '') IN ('released', 'approved', 'graded')
  ) THEN
    v_submission := v_sys_sub;
  ELSIF v_post_sub IS NOT NULL AND (
    COALESCE((v_post_sub->'teacherGrading'->>'approved')::boolean, false) = true
    OR COALESCE((v_post_sub->>'isReleased')::boolean, false) = true
    OR COALESCE(v_post_sub->>'status', '') IN ('released', 'approved', 'graded')
  ) THEN
    v_submission := v_post_sub;
  ELSE
    v_submission := COALESCE(v_sys_sub, v_post_sub);
  END IF;

  -- Merge answers cleanly from quiz_submissions and post submission so no student answer is lost
  IF v_has_qs AND jsonb_typeof(v_qs_row.answers) = 'object' THEN
    v_answers := v_qs_row.answers - ARRAY['exam_id', 'quiz_id', 'student_name', 'student_national_code', 'score', 'submitted_at'];
  END IF;
  IF v_submission IS NOT NULL AND jsonb_typeof(v_submission->'answers') = 'object' THEN
    v_answers := v_answers || (v_submission->'answers');
  END IF;

  -- 4. Check official grades row for this student & quiz
  v_clean_quiz_title := lower(btrim(COALESCE(v_quiz.title, '')));
  SELECT g.id, g.score, g.max_score, g.recorded_at, g.skill, g.subject
  INTO v_grade_row
  FROM public.grades g
  WHERE g.student_id = v_student_id
    AND v_clean_quiz_title <> ''
    AND (
      lower(btrim(COALESCE(g.skill, ''))) LIKE '%' || v_clean_quiz_title || '%'
      OR (
        length(regexp_replace(lower(btrim(COALESCE(g.skill, ''))), '^(آزمون|تکلیف):\s*', '')) >= 4
        AND v_clean_quiz_title LIKE '%' || regexp_replace(lower(btrim(COALESCE(g.skill, ''))), '^(آزمون|تکلیف):\s*', '') || '%'
      )
    )
  ORDER BY g.recorded_at DESC NULLS LAST
  LIMIT 1;

  v_has_grade := (v_grade_row.id IS NOT NULL AND v_grade_row.score IS NOT NULL);

  -- 5. Strict approval / publication gate: NEVER reveal answer key if not approved/published for this student
  IF v_submission IS NOT NULL THEN
    v_sub_approved := (
      COALESCE((v_submission->'teacherGrading'->>'approved')::boolean, false) = true
      OR COALESCE((v_submission->>'isReleased')::boolean, false) = true
      OR COALESCE((v_submission->>'is_released')::boolean, false) = true
      OR COALESCE(v_submission->>'status', '') IN ('released', 'approved', 'graded')
    );
  END IF;

  v_is_released := v_sub_approved OR (COALESCE(v_quiz.results_published, false) = true AND v_has_grade);

  IF NOT v_is_released THEN
    RETURN jsonb_build_object(
      'ok', false,
      'released', false,
      'reason', 'not_released',
      'message', 'نتیجه هنوز منتشر نشده است.'
    );
  END IF;

  -- Synthesize minimal submission wrapper if only grades + quiz_submissions exist
  IF v_submission IS NULL THEN
    v_submission := jsonb_build_object(
      'id', COALESCE(v_qs_row.id::text, 'qs_' || p_exam_id::text || '_' || v_student_id::text),
      'examId', p_exam_id::text,
      'studentId', v_student_id::text,
      'studentName', v_student_name,
      'answers', v_answers,
      'submittedAt', COALESCE(v_qs_row.submitted_at, v_grade_row.recorded_at, now()),
      'status', 'released',
      'isReleased', true,
      'is_released', true,
      'teacherGrading', jsonb_build_object('approved', true)
    );
  ELSE
    v_submission := v_submission || jsonb_build_object(
      'answers', v_answers,
      'studentId', v_student_id::text,
      'studentName', COALESCE(NULLIF(v_submission->>'studentName', ''), v_student_name),
      'status', 'released',
      'isReleased', true,
      'is_released', true
    );
  END IF;

  -- 6. Compute total_points and normalized score out of 20: (earned / total) * 20
  v_total_points := COALESCE(v_quiz.total_points, 0);
  IF v_total_points <= 0 THEN
    SELECT COALESCE(SUM(COALESCE(NULLIF(q->>'points', '')::numeric, 1)), 20)
    INTO v_total_points
    FROM jsonb_array_elements(v_questions) AS q;
  END IF;
  IF v_total_points <= 0 THEN
    v_total_points := 20;
  END IF;

  BEGIN
    v_scaled_score_20 := NULLIF(COALESCE(
      v_submission->'teacherGrading'->>'scaledScore20',
      v_submission->>'scaledScore20'
    ), '')::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_scaled_score_20 := NULL;
  END;

  IF v_scaled_score_20 IS NULL THEN
    BEGIN
      v_earned_points := NULLIF(COALESCE(
        v_submission->'teacherGrading'->>'totalScore',
        v_submission->>'totalScore',
        v_submission->>'earnedPoints'
      ), '')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_earned_points := NULL;
    END;

    IF v_earned_points IS NOT NULL AND v_total_points > 0 THEN
      v_scaled_score_20 := ROUND(LEAST(20, GREATEST(0, (v_earned_points / v_total_points) * 20))::numeric, 2);
    ELSIF v_has_grade THEN
      v_scaled_score_20 := ROUND(
        LEAST(
          20,
          GREATEST(
            0,
            CASE
              WHEN COALESCE(v_grade_row.max_score, 20) > 0 AND COALESCE(v_grade_row.max_score, 20) <> 20
              THEN (v_grade_row.score::numeric / v_grade_row.max_score::numeric) * 20
              ELSE v_grade_row.score::numeric
            END
          )
        )::numeric,
        2
      );
    END IF;
  ELSE
    v_scaled_score_20 := ROUND(LEAST(20, GREATEST(0, v_scaled_score_20))::numeric, 2);
  END IF;

  -- 7. Build structured per-question review items (question + student answer + correct answer + explanation + score)
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'question_id', COALESCE(q->>'id', 'q_' || ord::text),
        'index', ord,
        'text', COALESCE(q->>'question', q->>'text', q->>'questionText', ''),
        'type', COALESCE(
          q->>'type',
          CASE WHEN jsonb_typeof(q->'options') = 'array' THEN 'multiple_choice' ELSE 'short_answer' END
        ),
        'options', COALESCE(q->'options', '[]'::jsonb),
        'student_answer', v_answers -> COALESCE(q->>'id', ''),
        'correct_answer', COALESCE(q->'correctAnswer', q->'correctOptionIndex', q->'correctOptionText'),
        'explanation', COALESCE(
          NULLIF(q->>'explanation', ''),
          NULLIF(q->>'solution', ''),
          NULLIF(q->>'rubricOrHint', ''),
          NULLIF(q->>'gradingNotes', ''),
          ''
        ),
        'feedback', COALESCE(
          v_submission->'teacherGrading'->'questionFeedbacks'->>COALESCE(q->>'id', ''),
          v_submission->'aiGrading'->'questionFeedbacks'->>COALESCE(q->>'id', ''),
          ''
        ),
        'earned_points', COALESCE(
          CASE
            WHEN NULLIF(v_submission->'teacherGrading'->'questionScores'->>COALESCE(q->>'id', ''), '') IS NOT NULL
            THEN (v_submission->'teacherGrading'->'questionScores'->>COALESCE(q->>'id', ''))::numeric
            ELSE NULL
          END,
          CASE
            WHEN NULLIF(v_submission->'aiGrading'->'questionScores'->>COALESCE(q->>'id', ''), '') IS NOT NULL
            THEN (v_submission->'aiGrading'->'questionScores'->>COALESCE(q->>'id', ''))::numeric
            ELSE NULL
          END
        ),
        'max_points', COALESCE(NULLIF(q->>'points', '')::numeric, 1)
      )
      ORDER BY ord
    ),
    '[]'::jsonb
  )
  INTO v_questions_review
  FROM jsonb_array_elements(v_questions) WITH ORDINALITY AS t(q, ord);

  RETURN jsonb_build_object(
    'ok', true,
    'released', true,
    'exam', jsonb_build_object(
      'id', v_quiz.id,
      'title', v_quiz.title,
      'subject', v_quiz.subject,
      'questions', v_questions,
      'duration_minutes', v_quiz.duration_minutes::int,
      'published', v_quiz.published,
      'mode', v_quiz.mode,
      'due_at', v_quiz.due_at,
      'scheduled_start', v_quiz.scheduled_start,
      'is_untimed', v_quiz.is_untimed,
      'results_published', true,
      'total_points', v_total_points,
      'created_at', v_quiz.created_at
    ),
    'submission', v_submission,
    'questions_review', v_questions_review,
    'scaled_score_20', v_scaled_score_20,
    'total_points', v_total_points
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.student_get_exam_review(uuid, uuid, text) TO anon, authenticated;

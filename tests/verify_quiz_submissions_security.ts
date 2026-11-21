import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const PHASE1_PATH = path.resolve(process.cwd(), 'supabase/migration_quiz_submissions_rpcs.sql')
const PHASE2_PATH = path.resolve(process.cwd(), 'supabase/migration_quiz_submissions_rls_lock.sql')

const phase1Sql = fs.readFileSync(PHASE1_PATH, 'utf8')
const phase2Sql = fs.readFileSync(PHASE2_PATH, 'utf8')

const STUDENT_A = '4a2614ec-ebc7-437f-a90f-d6526caa082f'
const STUDENT_A_CODE = '5540265238'
const STUDENT_B = '47d00c57-9684-406e-b150-6a843c57fd0f'
const STUDENT_B_CODE = '3382569701'
const STUDENT_C = 'a991f960-4910-4d8a-b64a-3741adb7e8c0'
const STUDENT_C_CODE = '5540265009'

const QUIZ_1 = '11111111-1111-4111-8111-111111111111'
const QUIZ_2 = '22222222-2222-4222-8222-222222222222'
const LEGACY_EXISTING_SUB_ID = '99999999-9999-4999-8999-999999999999'

const TEACHER_SECRET = 'StrongTestTeacherPass!2026'

interface TestCaseResult {
  id: number
  name: string
  passed: boolean
  detail: string
}

const results: TestCaseResult[] = []

function record(id: number, name: string, passed: boolean, detail: string) {
  results.push({ id, name, passed, detail })
  const icon = passed ? 'PASS' : 'FAIL'
  console.log(`[${icon}] #${id} ${name} — ${detail}`)
}

async function setupBaseSchema(db: PGlite) {
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
      END IF;
    END;
    $$;

    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE TABLE public.students (
      id uuid PRIMARY KEY,
      full_name text NOT NULL,
      access_code text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE public.quizzes (
      id uuid PRIMARY KEY,
      title text NOT NULL,
      subject text NOT NULL DEFAULT 'ریاضی',
      questions jsonb NOT NULL DEFAULT '[]'::jsonb,
      duration_minutes int NOT NULL DEFAULT 30,
      published boolean NOT NULL DEFAULT true,
      mode text NOT NULL DEFAULT 'exam',
      results_published boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE public.quiz_submissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      quiz_id uuid REFERENCES public.quizzes(id),
      student_id uuid NOT NULL REFERENCES public.students(id),
      score numeric DEFAULT 0,
      submitted_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      answers jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE OR REPLACE FUNCTION public.set_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER trg_quiz_submissions_set_updated_at
      BEFORE UPDATE ON public.quiz_submissions
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at();

    -- Simulate existing Supabase verify_teacher(text) function
    CREATE OR REPLACE FUNCTION public.verify_teacher(p_password text)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      RETURN p_password = '${TEACHER_SECRET}';
    END;
    $$;

    -- Simulate pre-Phase-2 insecure permissive state (anon/authenticated/PUBLIC can touch quiz_submissions + legacy policy)
    GRANT ALL ON TABLE public.quiz_submissions TO PUBLIC, anon, authenticated, service_role;
    CREATE POLICY legacy_open_read ON public.quiz_submissions FOR SELECT TO anon, authenticated USING (true);
    CREATE POLICY legacy_open_write ON public.quiz_submissions FOR INSERT TO anon, authenticated WITH CHECK (true);

    -- Seed students
    INSERT INTO public.students (id, full_name, access_code) VALUES
      ('${STUDENT_A}', 'بردیا آذر', '${STUDENT_A_CODE}'),
      ('${STUDENT_B}', 'محمد احمدی', '${STUDENT_B_CODE}'),
      ('${STUDENT_C}', 'محمد احمدی میرزا', '${STUDENT_C_CODE}');

    -- Seed quizzes
    INSERT INTO public.quizzes (id, title, subject, questions, results_published) VALUES
      (
        '${QUIZ_1}',
        'آزمون ریاضی فصل اول',
        'ریاضی',
        '[
          {"id":"q1","type":"multiple_choice","question":"۲+۲؟","options":["۳","۴","۵","۶"],"correctAnswer":1,"points":2},
          {"id":"q2","type":"short_answer","question":"پایتخت ایران؟","correctAnswer":"تهران","points":3}
        ]'::jsonb,
        false
      ),
      (
        '${QUIZ_2}',
        'آزمون علوم فصل دوم',
        'علوم',
        '[
          {"id":"q1","type":"multiple_choice","question":"فتوسنتز در کدام بخش است؟","options":["برگ","ریشه"],"correctAnswer":0,"points":5}
        ]'::jsonb,
        false
      );

    -- Seed a pre-existing production submission (to verify Test 14: untouched across Phase 1 & Phase 2)
    INSERT INTO public.quiz_submissions (id, quiz_id, student_id, score, submitted_at, updated_at, answers) VALUES (
      '${LEGACY_EXISTING_SUB_ID}',
      '${QUIZ_2}',
      '${STUDENT_C}',
      19.5,
      '2026-04-01T08:30:00Z'::timestamptz,
      '2026-04-01T09:00:00Z'::timestamptz,
      '{
        "q1": {"selectedOption": 0, "selectedOptionText": "برگ"},
        "exam_id": "${QUIZ_2}",
        "quiz_id": "${QUIZ_2}",
        "student_name": "محمد احمدی میرزا",
        "teacher_approved": true,
        "approved": true,
        "is_released": true,
        "approved_at": "2026-04-01T09:00:00Z",
        "questionScores": {"q1": 5},
        "teacherGrading": {"approved": true, "totalScore": 5, "scaledScore20": 19.5, "teacherNotes": "بسیار عالی"}
      }'::jsonb
    );
  `)
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated' | 'service_role', fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET LOCAL ROLE ${role};`).catch(() => {})
  // Use session-level SET ROLE with guaranteed RESET ROLE in finally
  await db.exec(`SET ROLE ${role};`)
  try {
    return await fn()
  } finally {
    await db.exec(`RESET ROLE;`)
  }
}

async function main() {
  const db = new PGlite()
  await setupBaseSchema(db)

  // Snapshot pre-migration real record for Test 14
  const beforeLegacy = (await db.query(`SELECT id, quiz_id, student_id, score, submitted_at, updated_at, answers FROM public.quiz_submissions WHERE id = $1`, [LEGACY_EXISTING_SUB_ID])).rows[0]

  // Bonus Test 16 (pre-Phase-1): Phase 2 MUST abort safely if Phase 1 has not been run yet
  let phase2AbortedBeforePhase1 = false
  try {
    await db.exec(phase2Sql)
  } catch (err: any) {
    phase2AbortedBeforePhase1 = String(err?.message || '').includes('ABORTED')
    await db.exec('ROLLBACK;').catch(() => {})
  }
  const rlsStillDisabledAfterAbort = !(await db.query<any>(`SELECT relrowsecurity FROM pg_class WHERE relname = 'quiz_submissions'`)).rows[0].relrowsecurity
  record(
    16,
    'Phase 2 fails safely when Phase 1 prerequisites are missing',
    phase2AbortedBeforePhase1 && rlsStillDisabledAfterAbort,
    `aborted=${phase2AbortedBeforePhase1}, rlsStillDisabled=${rlsStillDisabledAfterAbort}`
  )

  // Apply Phase 1 verbatim
  await db.exec(phase1Sql)
  // Apply Phase 2 verbatim
  await db.exec(phase2Sql)

  // Test 1: Student A can submit and read their own answer (as anon)
  const submitARes = await asRole(db, 'anon', async () => {
    const up = await db.query<any>(
      `SELECT * FROM public.student_upsert_quiz_submission($1, $2, $3, $4::jsonb, $5, $6::timestamptz)`,
      [
        STUDENT_A,
        STUDENT_A_CODE,
        QUIZ_1,
        JSON.stringify({
          q1: { selectedOption: 1, selectedOptionText: '۴', maliciousNested: 'drop_me' },
          q2: { textAnswer: 'تهران' },
        }),
        0,
        '2020-01-01T00:00:00Z',
      ]
    )
    const rd = await db.query<any>(
      `SELECT * FROM public.student_list_my_quiz_submissions($1, $2, $3)`,
      [STUDENT_A, STUDENT_A_CODE, QUIZ_1]
    )
    return { up: up.rows[0], rd: rd.rows }
  })
  const test1Pass =
    submitARes.rd.length === 1 &&
    submitARes.rd[0].student_id === STUDENT_A &&
    submitARes.rd[0].answers?.q1?.selectedOption === 1 &&
    submitARes.rd[0].answers?.q1?.maliciousNested === undefined &&
    submitARes.rd[0].answers?.q2?.textAnswer === 'تهران'
  record(
    1,
    'Student A can submit and read their own answer (allowlisted fields only)',
    test1Pass,
    `rows=${submitARes.rd.length}, q1=${JSON.stringify(submitARes.rd[0]?.answers?.q1)}, q2=${JSON.stringify(submitARes.rd[0]?.answers?.q2)}`
  )

  // Bonus Test 15: Student cannot forge submitted_at timestamp via p_submitted_at
  const submittedYear = new Date(submitARes.up.submitted_at).getUTCFullYear()
  const test15Pass = submittedYear >= 2025 && String(submitARes.up.submitted_at) !== '2020-01-01T00:00:00.000Z'
  record(
    15,
    'Student cannot forge submission timestamp via p_submitted_at',
    test15Pass,
    `clientSent=2020-01-01, serverStored=${submitARes.up.submitted_at}`
  )

  // Also have Student B submit an answer so we can verify cross-student isolation
  await asRole(db, 'anon', async () => {
    await db.query(
      `SELECT * FROM public.student_upsert_quiz_submission($1, $2, $3, $4::jsonb, NULL, NULL)`,
      [STUDENT_B, STUDENT_B_CODE, QUIZ_1, JSON.stringify({ q1: { selectedOption: 0 }, q2: { textAnswer: 'شیراز' } })]
    )
  })

  // Test 2: Student A cannot read Student B's answer (neither via own creds nor by passing Student B's UUID with A's code)
  const test2A = await asRole(db, 'anon', async () => {
    const own = await db.query<any>(
      `SELECT * FROM public.student_list_my_quiz_submissions($1, $2, NULL)`,
      [STUDENT_A, STUDENT_A_CODE]
    )
    let crossRejected = false
    try {
      await db.query(
        `SELECT * FROM public.student_list_my_quiz_submissions($1, $2, NULL)`,
        [STUDENT_B, STUDENT_A_CODE]
      )
    } catch (err: any) {
      crossRejected = err?.code === '42501'
    }
    return { ownRows: own.rows, crossRejected }
  })
  const test2Pass =
    test2A.ownRows.every((r: any) => r.student_id === STUDENT_A) &&
    !test2A.ownRows.some((r: any) => r.student_id === STUDENT_B) &&
    test2A.crossRejected
  record(
    2,
    "Student A cannot read Student B's answer",
    test2Pass,
    `studentARows=${test2A.ownRows.length}, crossStudentUuidWithACodeRejected=${test2A.crossRejected}`
  )

  // Test 3: Incorrect access code is rejected (read & write)
  let readBadCodeErr = ''
  let writeBadCodeErr = ''
  await asRole(db, 'anon', async () => {
    try {
      await db.query(`SELECT * FROM public.student_list_my_quiz_submissions($1, $2, NULL)`, [STUDENT_A, 'WRONG_CODE'])
    } catch (e: any) {
      readBadCodeErr = e?.code || e?.message || 'err'
    }
    try {
      await db.query(
        `SELECT * FROM public.student_upsert_quiz_submission($1, $2, $3, $4::jsonb, NULL, NULL)`,
        [STUDENT_A, 'WRONG_CODE', QUIZ_1, JSON.stringify({ q1: 1 })]
      )
    } catch (e: any) {
      writeBadCodeErr = e?.code || e?.message || 'err'
    }
  })
  record(
    3,
    'Incorrect student access code is rejected (read & write)',
    readBadCodeErr === '42501' && writeBadCodeErr === '42501',
    `readErr=${readBadCodeErr}, writeErr=${writeBadCodeErr}`
  )

  // Tests 4, 5, 6, 7: Student tries privilege escalation payload on NEW submission (QUIZ_2 for Student A)
  await asRole(db, 'anon', async () => {
    await db.query(
      `SELECT * FROM public.student_upsert_quiz_submission($1, $2, $3, $4::jsonb, $5, $6::timestamptz)`,
      [
        STUDENT_A,
        STUDENT_A_CODE,
        QUIZ_2,
        JSON.stringify({
          q1: { selectedOption: 0 },
          score: 20,
          raw_score: 5,
          totalScore: 5,
          scaledScore20: 20,
          teacher_approved: true,
          approved: true,
          is_released: true,
          isReleased: true,
          approved_at: '2026-05-01T00:00:00Z',
          questionScores: { q1: 5 },
          teacherGrading: { approved: true, totalScore: 5, scaledScore20: 20, teacherNotes: 'forged' },
          teacherNotes: 'forged',
          status: 'graded',
          injectedUnknownKey: 'hack',
        }),
        20,
        '2021-01-01T00:00:00Z',
      ]
    )
  })
  // Inspect actual stored row directly as admin (postgres) to verify DB state
  const storedPrivEscRow = (
    await db.query<any>(
      `SELECT score, answers FROM public.quiz_submissions WHERE student_id = $1 AND quiz_id = $2`,
      [STUDENT_A, QUIZ_2]
    )
  ).rows[0]

  const test4Pass =
    Number(storedPrivEscRow.score) === 0 &&
    storedPrivEscRow.answers?.score === undefined &&
    storedPrivEscRow.answers?.raw_score === undefined &&
    storedPrivEscRow.answers?.totalScore === undefined &&
    storedPrivEscRow.answers?.scaledScore20 === undefined
  record(
    4,
    'Student cannot assign themselves a score (column or JSON)',
    test4Pass,
    `dbScore=${storedPrivEscRow.score}, jsonScoreKeysPresent=${['score', 'raw_score', 'totalScore', 'scaledScore20'].some((k) => k in storedPrivEscRow.answers)}`
  )

  const test5Pass =
    storedPrivEscRow.answers?.teacher_approved === undefined &&
    storedPrivEscRow.answers?.approved === undefined
  record(
    5,
    'Student cannot set teacher_approved or approved to true',
    test5Pass,
    `teacher_approved=${storedPrivEscRow.answers?.teacher_approved}, approved=${storedPrivEscRow.answers?.approved}`
  )

  const test6Pass =
    storedPrivEscRow.answers?.is_released === undefined &&
    storedPrivEscRow.answers?.isReleased === undefined
  record(
    6,
    'Student cannot set is_released to true',
    test6Pass,
    `is_released=${storedPrivEscRow.answers?.is_released}, isReleased=${storedPrivEscRow.answers?.isReleased}`
  )

  const test7Pass =
    storedPrivEscRow.answers?.questionScores === undefined &&
    storedPrivEscRow.answers?.teacherGrading === undefined &&
    storedPrivEscRow.answers?.approved_at === undefined &&
    storedPrivEscRow.answers?.teacherNotes === undefined &&
    storedPrivEscRow.answers?.injectedUnknownKey === undefined
  record(
    7,
    'Student cannot modify questionScores, teacherGrading, approved_at, or non-allowlisted keys',
    test7Pass,
    `storedKeys=${Object.keys(storedPrivEscRow.answers).sort().join(',')}`
  )

  // Test 9: Teacher with incorrect password cannot read or grade submissions
  let teacherBadReadCode = ''
  let teacherBadWriteCode = ''
  await asRole(db, 'anon', async () => {
    try {
      await db.query(`SELECT * FROM public.teacher_list_quiz_submissions($1)`, ['WRONG_TEACHER_PASS'])
    } catch (e: any) {
      teacherBadReadCode = e?.code || e?.message || 'err'
    }
    try {
      await db.query(
        `SELECT * FROM public.teacher_upsert_quiz_submission($1, $2, $3, $4::jsonb, $5)`,
        ['WRONG_TEACHER_PASS', QUIZ_1, STUDENT_A, JSON.stringify({ teacher_approved: true }), 18]
      )
    } catch (e: any) {
      teacherBadWriteCode = e?.code || e?.message || 'err'
    }
  })
  record(
    9,
    'Teacher with incorrect password cannot read or grade submissions',
    teacherBadReadCode === '42501' && teacherBadWriteCode === '42501',
    `readErr=${teacherBadReadCode}, writeErr=${teacherBadWriteCode}`
  )

  // Test 10: Teacher with correct password can read and grade/approve/release submissions
  const teacherOps = await asRole(db, 'authenticated', async () => {
    const listed = await db.query<any>(`SELECT * FROM public.teacher_list_quiz_submissions($1)`, [TEACHER_SECRET])
    const graded = await db.query<any>(
      `SELECT * FROM public.teacher_upsert_quiz_submission($1, $2, $3, $4::jsonb, $5)`,
      [
        TEACHER_SECRET,
        QUIZ_1,
        STUDENT_A,
        JSON.stringify({
          teacher_approved: true,
          approved: true,
          is_released: true,
          approved_at: '2026-05-02T12:00:00Z',
          questionScores: { q1: 2, q2: 2.5 },
          teacherGrading: { approved: true, totalScore: 4.5, scaledScore20: 18, teacherNotes: 'عالی' },
        }),
        18,
      ]
    )
    return { count: listed.rows.length, graded: graded.rows[0] }
  })
  const test10Pass =
    teacherOps.count >= 3 &&
    Number(teacherOps.graded.score) === 18 &&
    teacherOps.graded.answers?.teacher_approved === true &&
    teacherOps.graded.answers?.is_released === true &&
    teacherOps.graded.answers?.questionScores?.q2 === 2.5
  record(
    10,
    'Teacher with correct password can read and grade submissions',
    test10Pass,
    `listedCount=${teacherOps.count}, gradedScore=${teacherOps.graded.score}, approved=${teacherOps.graded.answers?.teacher_approved}`
  )

  // Test 8: Student synchronization CANNOT overwrite or remove existing teacher grade, approval, release state, or answers
  await asRole(db, 'anon', async () => {
    await db.query(
      `SELECT * FROM public.student_upsert_quiz_submission($1, $2, $3, $4::jsonb, $5, $6::timestamptz)`,
      [
        STUDENT_A,
        STUDENT_A_CODE,
        QUIZ_1,
        JSON.stringify({
          q1: { selectedOption: 3 },
          q2: { textAnswer: 'تغییر غیرمجاز پس از نمره‌دهی' },
          teacher_approved: false,
          approved: false,
          is_released: false,
          questionScores: { q1: 2, q2: 3 },
          teacherGrading: { approved: false, totalScore: 5, scaledScore20: 20 },
        }),
        20,
        '2019-01-01T00:00:00Z',
      ]
    )
  })
  const afterResyncRow = (
    await db.query<any>(
      `SELECT score, submitted_at, answers FROM public.quiz_submissions WHERE student_id = $1 AND quiz_id = $2`,
      [STUDENT_A, QUIZ_1]
    )
  ).rows[0]
  const test8Pass =
    Number(afterResyncRow.score) === 18 &&
    afterResyncRow.answers?.teacher_approved === true &&
    afterResyncRow.answers?.approved === true &&
    afterResyncRow.answers?.is_released === true &&
    afterResyncRow.answers?.questionScores?.q2 === 2.5 &&
    afterResyncRow.answers?.teacherGrading?.scaledScore20 === 18 &&
    afterResyncRow.answers?.q2?.textAnswer === 'تهران' &&
    String(afterResyncRow.submitted_at) === String(submitARes.up.submitted_at)
  record(
    8,
    'Student synchronization cannot overwrite existing teacher grade, approval, release state, or answers',
    test8Pass,
    `score=${afterResyncRow.score}, approved=${afterResyncRow.answers?.teacher_approved}, q2=${afterResyncRow.answers?.q2?.textAnswer}`
  )

  // Test 11: Concurrent / rapid overlapping saves do NOT create duplicate submissions
  await asRole(db, 'anon', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        db.query(
          `SELECT * FROM public.student_upsert_quiz_submission($1, $2, $3, $4::jsonb, NULL, NULL)`,
          [STUDENT_B, STUDENT_B_CODE, QUIZ_2, JSON.stringify({ q1: { selectedOption: idx % 2 } })]
        )
      )
    )
  })
  const bQuiz2Count = Number(
    (
      await db.query<any>(
        `SELECT count(*)::int AS cnt FROM public.quiz_submissions WHERE student_id = $1 AND quiz_id = $2`,
        [STUDENT_B, QUIZ_2]
      )
    ).rows[0].cnt
  )
  const uniqueIdxExists = (
    await db.query<any>(
      `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'quiz_submissions' AND indexname = 'idx_quiz_submissions_unique_student_quiz') AS ok`
    )
  ).rows[0].ok
  record(
    11,
    'Concurrent saves do not create duplicate submissions (advisory lock + partial unique index)',
    bQuiz2Count === 1 && uniqueIdxExists === true,
    `rowsForStudentBQuiz2After10ConcurrentSaves=${bQuiz2Count}, partialUniqueIndexExists=${uniqueIdxExists}`
  )

  // Test 12: RLS blocks direct anon and authenticated table access after Phase 2; service_role still works
  const directBlockChecks: Record<string, boolean> = {}
  for (const role of ['anon', 'authenticated'] as const) {
    await asRole(db, role, async () => {
      for (const [op, sql] of [
        ['select', `SELECT * FROM public.quiz_submissions LIMIT 1`],
        ['insert', `INSERT INTO public.quiz_submissions (student_id, quiz_id, answers) VALUES ('${STUDENT_A}', '${QUIZ_1}', '{}'::jsonb)`],
        ['update', `UPDATE public.quiz_submissions SET score = 20 WHERE student_id = '${STUDENT_A}'`],
        ['delete', `DELETE FROM public.quiz_submissions WHERE student_id = '${STUDENT_A}'`],
      ] as const) {
        try {
          await db.query(sql)
          directBlockChecks[`${role}_${op}`] = false
        } catch (e: any) {
          directBlockChecks[`${role}_${op}`] = e?.code === '42501'
        }
      }
    })
  }
  const serviceRoleCanRead = await asRole(db, 'service_role', async () => {
    const r = await db.query<any>(`SELECT count(*)::int AS cnt FROM public.quiz_submissions`)
    return Number(r.rows[0].cnt) > 0
  })
  const allDirectBlocked = Object.values(directBlockChecks).every(Boolean)
  record(
    12,
    'RLS & table grants block direct anon/authenticated table access after Phase 2 while preserving service_role',
    allDirectBlocked && serviceRoleCanRead,
    `allDirectBlocked=${allDirectBlocked}, serviceRoleCanRead=${serviceRoleCanRead}`
  )

  // Test 13: All four RPCs continue working after Phase 2 (for both anon and authenticated)
  const rpc4Check = await asRole(db, 'anon', async () => {
    const sUp = await db.query<any>(
      `SELECT id FROM public.student_upsert_quiz_submission($1, $2, $3, $4::jsonb, NULL, NULL)`,
      [STUDENT_A, STUDENT_A_CODE, QUIZ_2, JSON.stringify({ q1: { selectedOption: 0 } })]
    )
    const sList = await db.query<any>(
      `SELECT id, score, answers FROM public.student_list_my_quiz_submissions($1, $2, $3)`,
      [STUDENT_A, STUDENT_A_CODE, QUIZ_1]
    )
    const tList = await db.query<any>(`SELECT id FROM public.teacher_list_quiz_submissions($1)`, [TEACHER_SECRET])
    const tUp = await db.query<any>(
      `SELECT id, score FROM public.teacher_upsert_quiz_submission($1, $2, $3, $4::jsonb, $5)`,
      [TEACHER_SECRET, QUIZ_2, STUDENT_A, JSON.stringify({ teacher_approved: true, approved: true, is_released: true }), 20]
    )
    return {
      sUpOk: Boolean(sUp.rows[0]?.id),
      sListOk: sList.rows.length === 1 && Number(sList.rows[0].score) === 18,
      tListOk: tList.rows.length >= 4,
      tUpOk: Boolean(tUp.rows[0]?.id) && Number(tUp.rows[0].score) === 20,
    }
  })
  const test13Pass = rpc4Check.sUpOk && rpc4Check.sListOk && rpc4Check.tListOk && rpc4Check.tUpOk
  record(
    13,
    'All four RPCs continue working after Phase 2',
    test13Pass,
    JSON.stringify(rpc4Check)
  )

  // Test 14: Existing pre-migration real submission record remains 100% unchanged
  const afterLegacy = (
    await db.query<any>(
      `SELECT id, quiz_id, student_id, score, submitted_at, updated_at, answers FROM public.quiz_submissions WHERE id = $1`,
      [LEGACY_EXISTING_SUB_ID]
    )
  ).rows[0]
  const test14Pass = JSON.stringify(beforeLegacy) === JSON.stringify(afterLegacy)
  record(
    14,
    'Existing pre-migration submission records remain completely unchanged',
    test14Pass,
    `exactMatch=${test14Pass}`
  )

  // Summary
  const passedCount = results.filter((r) => r.passed).length
  const failedCount = results.length - passedCount
  console.log(`\nSUMMARY: ${passedCount}/${results.length} passed, ${failedCount} failed (executed locally on isolated PGlite PostgreSQL; production untouched).`)
  await db.close()
  if (failedCount > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Test harness fatal error:', err)
  process.exit(1)
})

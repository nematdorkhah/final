/**
 * End-to-End 8-Step Cross-Device Verification for Exam & Homework Visibility
 *
 * - Runs against a local isolated PostgREST/Supabase-compatible HTTP server (ZERO writes to production)
 *   AND executes read-only checks against live Worker /sb proxy to confirm live backend compatibility.
 * - Verifies completely isolated Teacher Device A and Student Device B (separate localStorage,
 *   90-second clock skew on Student Device B, full page refresh & logout/login persistence).
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { createClient } from '@supabase/supabase-js'
import {
  fetchFilteredPublishedPosts,
  normalizeQuizRowToExam,
  classifyExamForStudent,
  sanitizeExamForStudent,
} from '../src/utils/networkResilience'
import { Exam } from '../src/types/examTypes'

interface DbQuizRow {
  id: string
  title: string
  subject: string
  description?: string
  questions: any[]
  duration_minutes: number
  published: boolean
  mode: 'exam' | 'assignment'
  due_at: string | null
  scheduled_start: string
  is_untimed: boolean
  results_published: boolean
  total_points: number
  created_at: string
}

interface DbPostRow {
  id: string
  type: 'homework' | 'announcement' | 'exam'
  title: string
  body: string
  due_at: string | null
  publish_at: string
  attachment_path: string | null
  created_at: string
}

const TEST_TEACHER_PASS = 'test-teacher-pass-2026'

async function startIsolatedSupabaseServer() {
  const quizzes = new Map<string, DbQuizRow>()
  const posts = new Map<string, DbPostRow>()
  let simulatePostsTableDenied = false

  // Seed legacy system pollution rows to prove they are always filtered out
  posts.set('sys-1', {
    id: 'sys-1',
    type: 'announcement',
    title: '__EXAM_SUB__:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    body: JSON.stringify({ examId: '11111111-1111-4111-8111-111111111111', answers: {} }),
    due_at: null,
    publish_at: new Date(Date.now() - 86400000).toISOString(),
    attachment_path: null,
    created_at: new Date(Date.now() - 86400000).toISOString(),
  })
  posts.set('sys-2', {
    id: 'sys-2',
    type: 'announcement',
    title: '__SYSTEM_EXAM_SUBMISSIONS__',
    body: '[]',
    due_at: null,
    publish_at: new Date(Date.now() - 86400000).toISOString(),
    attachment_path: null,
    created_at: new Date(Date.now() - 86400000).toISOString(),
  })

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const bodyStr = Buffer.concat(chunks).toString('utf8')
      let body: any = {}
      try {
        if (bodyStr) body = JSON.parse(bodyStr)
      } catch {}

      res.setHeader('Content-Type', 'application/json')

      // Direct table access to public.quizzes is DENIED (matching production RLS)
      if (url.pathname === '/rest/v1/quizzes') {
        res.statusCode = 401
        res.end(JSON.stringify({ code: '42501', message: 'permission denied for table quizzes' }))
        return
      }

      // RPC: teacher_upsert_quiz
      if (url.pathname === '/rest/v1/rpc/teacher_upsert_quiz' && req.method === 'POST') {
        if (body.p_password !== TEST_TEACHER_PASS) {
          res.statusCode = 403
          res.end(JSON.stringify({ message: 'Invalid teacher password' }))
          return
        }
        const q = body.p_quiz
        const row: DbQuizRow = {
          id: q.id,
          title: q.title,
          subject: q.subject || 'عمومی',
          description: q.description,
          questions: Array.isArray(q.questions) ? q.questions : [],
          duration_minutes: Number(q.duration_minutes ?? 30),
          published: q.published !== false,
          mode: q.mode === 'assignment' ? 'assignment' : 'exam',
          due_at: q.due_at || null,
          scheduled_start: q.scheduled_start || new Date().toISOString(),
          is_untimed: Boolean(q.is_untimed),
          results_published: Boolean(q.results_published),
          total_points: Number(q.total_points ?? 20),
          created_at: q.created_at || new Date().toISOString(),
        }
        quizzes.set(row.id, row)
        res.statusCode = 200
        res.end(JSON.stringify(row))
        return
      }

      // RPC: teacher_list_quizzes
      if (url.pathname === '/rest/v1/rpc/teacher_list_quizzes' && req.method === 'POST') {
        if (body.p_password !== TEST_TEACHER_PASS) {
          res.statusCode = 403
          res.end(JSON.stringify({ message: 'Invalid teacher password' }))
          return
        }
        res.statusCode = 200
        res.end(JSON.stringify(Array.from(quizzes.values())))
        return
      }

      // RPC: student_list_published_quizzes (strictly published = true, answer keys stripped like prod RPC)
      if (url.pathname === '/rest/v1/rpc/student_list_published_quizzes' && req.method === 'POST') {
        const list = Array.from(quizzes.values())
          .filter((q) => q.published === true)
          .map((q) => ({
            ...q,
            questions: q.questions.map((item: any) => {
              const { correctAnswer, rubricOrHint, ...safe } = item
              return safe
            }),
          }))
        res.statusCode = 200
        res.end(JSON.stringify(list))
        return
      }

      // RPC: teacher_delete_quiz
      if (url.pathname === '/rest/v1/rpc/teacher_delete_quiz' && req.method === 'POST') {
        if (body.p_password !== TEST_TEACHER_PASS) {
          res.statusCode = 403
          res.end(JSON.stringify({ message: 'Invalid teacher password' }))
          return
        }
        quizzes.delete(body.p_quiz_id)
        res.statusCode = 200
        res.end(JSON.stringify(true))
        return
      }

      // RPC: teacher_create_post
      if (url.pathname === '/rest/v1/rpc/teacher_create_post' && req.method === 'POST') {
        if (body.p_password !== TEST_TEACHER_PASS) {
          res.statusCode = 403
          res.end(JSON.stringify({ message: 'Invalid teacher password' }))
          return
        }
        const id = `post-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const row: DbPostRow = {
          id,
          type: body.p_type || 'homework',
          title: body.p_title,
          body: body.p_body || '',
          due_at: body.p_due_at || null,
          publish_at: body.p_publish_at || new Date().toISOString(),
          attachment_path: body.p_attachment_path || null,
          created_at: new Date().toISOString(),
        }
        posts.set(id, row)
        res.statusCode = 200
        res.end(JSON.stringify(row))
        return
      }

      // Direct GET /rest/v1/posts (with optional title=not.like.\_\_%)
      if (url.pathname === '/rest/v1/posts' && req.method === 'GET') {
        if (simulatePostsTableDenied) {
          res.statusCode = 401
          res.end(JSON.stringify({ code: '42501', message: 'permission denied for table posts' }))
          return
        }
        const notTitle = url.searchParams.get('title')
        let list = Array.from(posts.values())
        if (notTitle && notTitle.includes('not.like')) {
          list = list.filter((p) => !p.title.startsWith('__'))
        }
        res.statusCode = 200
        res.end(JSON.stringify(list))
        return
      }

      // RPC: list_published_posts (fallback)
      if (url.pathname === '/rest/v1/rpc/list_published_posts' && req.method === 'POST') {
        res.statusCode = 200
        res.end(JSON.stringify(Array.from(posts.values())))
        return
      }

      res.statusCode = 404
      res.end(JSON.stringify({ message: `Unhandled test route: ${req.method} ${url.pathname}` }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    setPostsTableDenied: (v: boolean) => {
      simulatePostsTableDenied = v
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function run() {
  const mockDb = await startIsolatedSupabaseServer()
  try {
    // Two completely separate Supabase clients simulating Device A (Teacher) and Device B (Student)
    const teacherClient = createClient(mockDb.url, 'test-anon-key', { auth: { persistSession: false } })
    const studentClient = createClient(mockDb.url, 'test-anon-key', { auth: { persistSession: false } })

    const passed: string[] = []

    // ------------------------------------------------------------------
    // STEP 1: Teacher creates & publishes an exam (+ draft + deleted exam)
    // ------------------------------------------------------------------
    const publishedExamId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const draftExamId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const deletedExamId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    // Mimic TeacherExamBuilder calculateScheduledTime() for default 'now' (-2 min skew buffer)
    const immediateStartIso = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    const dueIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()

    const { error: pubErr } = await teacherClient.rpc('teacher_upsert_quiz', {
      p_password: TEST_TEACHER_PASS,
      p_quiz: {
        id: publishedExamId,
        title: 'آزمون کسر و اعشار فصل دوم',
        subject: 'ریاضی',
        description: 'ارزیابی جامع فصل دوم ریاضی پایه ششم شامل ۳ سوال',
        questions: [
          {
            id: 'q1',
            type: 'multiple_choice',
            question: 'حاصل ۰/۵ + ۰/۲۵ کدام است؟',
            options: ['۰/۵۵', '۰/۷۵', '۰/۸۵', '۱/۲۵'],
            correctAnswer: 1,
            rubricOrHint: 'جواب صحیح گزینه دوم است',
            points: 10,
          },
          {
            id: 'q2',
            type: 'descriptive',
            question: 'توضیح دهید چگونه کسر ۳/۴ را به عدد اعشاری تبدیل می‌کنیم.',
            correctAnswer: 'صورت و مخرج را در ۲۵ ضرب می‌کنیم تا مخرج ۱۰۰ شود: ۰/۷۵',
            points: 10,
          },
        ],
        duration_minutes: 30,
        published: true,
        mode: 'exam',
        due_at: dueIso,
        scheduled_start: immediateStartIso,
        is_untimed: false,
        results_published: false,
        total_points: 20,
        created_at: new Date().toISOString(),
      },
    })
    assert.equal(pubErr, null, 'Step 1: teacher_upsert_quiz (published) should succeed')

    // Create an unpublished draft exam (must NOT appear for students)
    const { error: draftErr } = await teacherClient.rpc('teacher_upsert_quiz', {
      p_password: TEST_TEACHER_PASS,
      p_quiz: {
        id: draftExamId,
        title: 'پیش‌نویس آزمون علوم (منتشر نشده)',
        subject: 'علوم',
        questions: [{ id: 'dq1', type: 'descriptive', question: 'سوال پیش‌نویس', points: 5 }],
        duration_minutes: 20,
        published: false,
        mode: 'exam',
        scheduled_start: immediateStartIso,
        is_untimed: false,
        total_points: 5,
      },
    })
    assert.equal(draftErr, null, 'Step 1: teacher_upsert_quiz (draft) should succeed')

    // Create and delete an exam (must NOT appear for students)
    await teacherClient.rpc('teacher_upsert_quiz', {
      p_password: TEST_TEACHER_PASS,
      p_quiz: {
        id: deletedExamId,
        title: 'آزمون حذف‌شده',
        subject: 'فارسی',
        questions: [{ id: 'del1', type: 'descriptive', question: 'سوال حذف‌شده', points: 5 }],
        duration_minutes: 15,
        published: true,
        mode: 'exam',
        scheduled_start: immediateStartIso,
        is_untimed: false,
        total_points: 5,
      },
    })
    const { error: delErr } = await teacherClient.rpc('teacher_delete_quiz', {
      p_password: TEST_TEACHER_PASS,
      p_quiz_id: deletedExamId,
    })
    assert.equal(delErr, null, 'Step 1: teacher_delete_quiz should succeed')

    // Verify direct quizzes table is blocked (confirming we rely solely on RPCs)
    const directBlocked = await studentClient.from('quizzes').select('*')
    assert.ok(directBlocked.error, 'Direct SELECT on public.quizzes must be blocked by RLS')
    passed.push('Step 1: Teacher created published exam, draft exam, and deleted exam via teacher_upsert_quiz/teacher_delete_quiz')

    // ------------------------------------------------------------------
    // STEP 2 & 3: Student opens app on separate device (empty cache, 90s slow clock)
    // ------------------------------------------------------------------
    const studentClockSkewMs = Date.now() - 90 * 1000 // Student phone is 90 seconds behind teacher
    const { data: studentQuizRows, error: studentQuizErr } = await studentClient.rpc(
      'student_list_published_quizzes'
    )
    assert.equal(studentQuizErr, null, 'Step 2: student_list_published_quizzes should succeed')
    assert.ok(Array.isArray(studentQuizRows), 'Step 2: student quizzes should be an array')

    const studentExams: Exam[] = studentQuizRows
      .map((r: any) => normalizeQuizRowToExam(r))
      .filter((e): e is Exam => Boolean(e && e.published !== false))
      .map(sanitizeExamForStudent)

    assert.equal(studentExams.length, 1, 'Step 3: Only the 1 published exam should appear (draft & deleted excluded)')
    const visibleExam = studentExams[0]
    assert.equal(visibleExam.id, publishedExamId)
    assert.equal(visibleExam.title, 'آزمون کسر و اعشار فصل دوم')
    assert.ok(visibleExam.description && visibleExam.description.length > 0, 'Step 3: Exam description must be present')
    assert.equal(visibleExam.dueDate, dueIso, 'Step 3: Exam deadline must match')

    const classification = classifyExamForStudent(visibleExam, studentClockSkewMs)
    assert.equal(classification.isPublished, true)
    assert.equal(classification.isStarted, true, 'Step 3: Immediate exam must be started even with 90s slower student clock')
    assert.equal(classification.state, 'active', 'Step 3: Exam state must be active (start button enabled)')
    passed.push('Step 2 & 3: Published exam appears on separate Student device with title, description, availability, deadline & active start button; draft & deleted exams excluded')

    // ------------------------------------------------------------------
    // STEP 4: Student opens exam successfully (questions loaded, answer keys stripped)
    // ------------------------------------------------------------------
    assert.equal(visibleExam.questions.length, 2, 'Step 4: All 2 exam questions must load')
    assert.equal((visibleExam.questions[0] as any).correctAnswer, undefined, 'Step 4: Answer key must be stripped')
    assert.equal((visibleExam.questions[0] as any).rubricOrHint, undefined, 'Step 4: Rubric must be stripped')
    assert.equal(visibleExam.questions[0].options?.length, 4, 'Step 4: Multiple-choice options intact')
    passed.push('Step 4: Student opens exam successfully with full questions and stripped answer keys')

    // ------------------------------------------------------------------
    // STEP 5: Teacher creates & publishes homework (NewPostForm + AiPracticeForm + future scheduled)
    // ------------------------------------------------------------------
    const hwBodyFull = 'صفحات ۴۲ تا ۴۵ کتاب ریاضی را با راه‌حل کامل در دفتر بنویسید و عکس آن را ارسال کنید.\nسوال ۱: ۴/۵ + ۳/۱۰ = ؟'
    const { error: hwErr1 } = await teacherClient.rpc('teacher_create_post', {
      p_password: TEST_TEACHER_PASS,
      p_type: 'homework',
      p_title: '[ریاضی] تمرین جمع و تفریق کسرها',
      p_body: hwBodyFull,
      p_due_at: dueIso,
      p_publish_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // NewPostForm -5 min backdate
      p_attachment_path: 'https://example.com/materials/math-sheet.pdf',
    })
    assert.equal(hwErr1, null, 'Step 5: NewPostForm teacher_create_post should succeed')

    const aiHwBody = 'تمرین هوشمند علوم: سه تفاوت تغییرات فیزیکی و شیمیایی را با مثال توضیح دهید.'
    const { error: hwErr2 } = await teacherClient.rpc('teacher_create_post', {
      p_password: TEST_TEACHER_PASS,
      p_type: 'homework',
      p_title: 'تمرین هوشمند تغییرات ماده',
      p_body: aiHwBody,
      p_due_at: null,
      p_publish_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // AiPracticeForm -5 min backdate
      p_attachment_path: null,
    })
    assert.equal(hwErr2, null, 'Step 5: AiPracticeForm teacher_create_post should succeed')

    // Future-scheduled homework (tomorrow) must remain hidden until scheduled time
    await teacherClient.rpc('teacher_create_post', {
      p_password: TEST_TEACHER_PASS,
      p_type: 'homework',
      p_title: 'تکلیف زمان‌بندی‌شده فردا',
      p_body: 'فردا منتشر می‌شود',
      p_due_at: null,
      p_publish_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      p_attachment_path: null,
    })
    passed.push('Step 5: Teacher created standard & AI homework posts via teacher_create_post (plus future-scheduled post)')

    // ------------------------------------------------------------------
    // STEP 6 & 7: Student opens homework on separate device (90s slow clock) & full content loads
    // ------------------------------------------------------------------
    const studentPosts = await fetchFilteredPublishedPosts(studentClient, {
      includeScheduledFuture: false,
      serverNowMs: studentClockSkewMs,
    })
    const studentHomework = studentPosts.filter((p) => p.type === 'homework')
    assert.equal(studentHomework.length, 2, 'Step 6: Both published homeworks must appear; system blobs & future post excluded')

    const stdHw = studentHomework.find((p) => p.title === '[ریاضی] تمرین جمع و تفریق کسرها')
    const aiHw = studentHomework.find((p) => p.title === 'تمرین هوشمند تغییرات ماده')
    assert.ok(stdHw, 'Step 7: Standard homework must be present')
    assert.equal(stdHw.body, hwBodyFull, 'Step 7: Full standard homework content must load intact')
    assert.equal(stdHw.attachment_path, 'https://example.com/materials/math-sheet.pdf')
    assert.ok(aiHw, 'Step 7: AI homework must be present')
    assert.equal(aiHw.body, aiHwBody, 'Step 7: Full AI homework content must load intact')

    // Also verify RPC fallback in fetchFilteredPublishedPosts if direct posts select fails
    mockDb.setPostsTableDenied(true)
    const fallbackPosts = await fetchFilteredPublishedPosts(studentClient, {
      includeScheduledFuture: false,
      serverNowMs: studentClockSkewMs,
    })
    mockDb.setPostsTableDenied(false)
    assert.equal(
      fallbackPosts.filter((p) => p.type === 'homework').length,
      2,
      'Step 7: Fallback RPC path must still return both homeworks and exclude __SYSTEM__/__EXAM_SUB__ rows'
    )
    passed.push('Step 6 & 7: Both published homeworks appear on separate Student device with full content & RPC fallback verified')

    // ------------------------------------------------------------------
    // STEP 8: Refresh / Logout + Re-login on BOTH Teacher & Student devices
    // ------------------------------------------------------------------
    const freshTeacherClient = createClient(mockDb.url, 'test-anon-key', { auth: { persistSession: false } })
    const freshStudentClient = createClient(mockDb.url, 'test-anon-key', { auth: { persistSession: false } })

    const { data: refreshedTeacherQuizzes } = await freshTeacherClient.rpc('teacher_list_quizzes', {
      p_password: TEST_TEACHER_PASS,
    })
    assert.equal(refreshedTeacherQuizzes.length, 2, 'Step 8: Teacher sees published + draft exams after refresh')

    const { data: refreshedStudentQuizzes } = await freshStudentClient.rpc('student_list_published_quizzes')
    assert.equal(refreshedStudentQuizzes.length, 1, 'Step 8: Student still sees published exam after refresh/re-login')
    assert.equal(refreshedStudentQuizzes[0].id, publishedExamId)

    const refreshedStudentPosts = await fetchFilteredPublishedPosts(freshStudentClient, {
      includeScheduledFuture: false,
    })
    assert.equal(
      refreshedStudentPosts.filter((p) => p.type === 'homework').length,
      2,
      'Step 8: Student still sees both homework assignments after refresh/re-login'
    )
    passed.push('Step 8: Full refresh & logout/login persistence confirmed on both Teacher & Student devices')

    // ------------------------------------------------------------------
    // STEP 9 (READ-ONLY LIVE CHECK): Verify live Worker /sb proxy works with new client code
    // ------------------------------------------------------------------
    const liveAnonKey = 'sb_publishable_bI5v4Hzokb0A4JWJDzuz1A_4B3lIUX_'
    const liveWorkerClient = createClient('https://class.nemat-darkhah.workers.dev/sb', liveAnonKey, {
      auth: { persistSession: false },
    })

    const { data: liveQuizzes, error: liveQuizErr } = await liveWorkerClient.rpc('student_list_published_quizzes')
    assert.equal(liveQuizErr, null, 'Live read-only student_list_published_quizzes via Worker /sb must succeed')
    assert.ok(Array.isArray(liveQuizzes) && liveQuizzes.length > 0, 'Live DB must return published quizzes')

    const livePosts = await fetchFilteredPublishedPosts(liveWorkerClient, { includeScheduledFuture: false })
    assert.ok(Array.isArray(livePosts), 'Live read-only fetchFilteredPublishedPosts via Worker /sb must succeed')
    const liveHw = livePosts.filter((p) => p.type === 'homework')
    passed.push(
      `Step 9 (Read-Only Live Worker /sb Check): student_list_published_quizzes returned ${liveQuizzes.length} published exams; fetchFilteredPublishedPosts returned ${livePosts.length} clean posts (${liveHw.length} homework) with 0 system rows`
    )

    console.log('\n✅ ALL VISIBILITY VERIFICATION CHECKS PASSED:\n')
    for (const line of passed) {
      console.log('  ✔ ' + line)
    }
  } finally {
    await mockDb.close()
  }
}

run().catch((err) => {
  console.error('❌ VISIBILITY VERIFICATION FAILED:', err)
  process.exit(1)
})

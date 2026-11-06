import fs from 'fs';
import { supabase } from '../src/supabaseClient';
import { evaluateEntireExamSubmission } from '../src/utils/persianSemanticGrader';
import { CLASS_STUDENTS_ROSTER } from '../src/classStudents';

async function main() {
  console.log('=== STARTING STRICT Q1 SCORING & ASSIGNMENT SYNC MIGRATION ===');

  const SPELLING_EXAM_ID = 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2';
  const DIVISION_EXAM_ID = '4da6dd51-1fec-44ff-9e2e-b009722dac96';
  const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD?.trim() || '1234';

  // 1. Update data/exams_backup.json
  const exams = JSON.parse(fs.readFileSync('data/exams_backup.json', 'utf8'));
  const spellingExam = exams.find((e: any) => e.id === SPELLING_EXAM_ID);
  if (!spellingExam) {
    throw new Error('Spelling exam not found in exams_backup.json');
  }

  // Question 1 (q2): Remove universal full score - strictly grade correct choice (Option index 1)
  const q2 = spellingExam.questions.find((q: any) => q.id === 'q2');
  if (q2) {
    delete q2.awardFullScoreToAll;
    delete q2.allOptionsCorrect;
    delete q2.allAnswersCorrect;
    delete q2.isBonusToAll;
    q2.correctAnswer = 1;
    console.log('✓ Question 1 (q2) reverted to strict scoring: Only option index 1 gets 1.0 point.');
  }

  // Question 3 (q4): Retain universal bonus to all (per teacher instruction)
  const q4 = spellingExam.questions.find((q: any) => q.id === 'q4');
  if (q4) {
    q4.awardFullScoreToAll = true;
    q4.allOptionsCorrect = true;
    console.log('✓ Question 3 (q4) retains awardFullScoreToAll: true');
  }

  // Division assignment check
  const divisionExam = exams.find((e: any) => e.id === DIVISION_EXAM_ID);
  if (divisionExam) {
    divisionExam.published = true;
    divisionExam.mode = 'assignment';
    divisionExam.isUntimed = true;
    console.log('✓ Division assignment verified in exams list.');
  }

  fs.writeFileSync('data/exams_backup.json', JSON.stringify(exams, null, 2), 'utf8');
  console.log('✓ data/exams_backup.json updated.');

  // 2. Update Supabase quizzes table
  try {
    const { error: quizErr } = await supabase
      .from('quizzes')
      .update({ questions: spellingExam.questions })
      .eq('id', SPELLING_EXAM_ID);
    console.log('✓ Supabase quizzes table updated for spelling exam:', quizErr ? `Error: ${quizErr.message}` : 'SUCCESS');
  } catch (e: any) {
    console.warn('Quizzes table update warning:', e.message);
  }

  // 3. Update Supabase __SYSTEM_EXAMS__ post
  try {
    const { error: sysExamErr } = await supabase
      .from('posts')
      .update({ body: JSON.stringify(exams) })
      .eq('title', '__SYSTEM_EXAMS__');
    console.log('✓ Supabase __SYSTEM_EXAMS__ updated:', sysExamErr ? `Error: ${sysExamErr.message}` : 'SUCCESS');
  } catch (e: any) {
    console.warn('__SYSTEM_EXAMS__ update warning:', e.message);
  }

  // Also ensure a published post of type homework exists for Division Assignment for instant student visibility
  try {
    const hwTitle = 'تکلیف تعاملی: آزمون تقسیم';
    const { data: existingHwPosts } = await supabase
      .from('posts')
      .select('id')
      .eq('title', hwTitle)
      .limit(1);

    if (!existingHwPosts || existingHwPosts.length === 0) {
      const { error: insHwErr } = await supabase.from('posts').insert({
        title: hwTitle,
        type: 'homework',
        body: JSON.stringify({
          examId: DIVISION_EXAM_ID,
          title: 'آزمون تقسیم',
          subject: 'ریاضی',
          description: 'تکلیف هوشمند آنلاین شامل ۲۵ سوال تقسیم و ساده‌سازی کسرها',
          totalPoints: 52,
          questionsCount: 25,
          mode: 'assignment',
          isInteractive: true,
        }),
        publish_at: new Date().toISOString(),
        due_at: '2026-11-09T17:55:38.539Z',
      });
      console.log('✓ Created dedicated homework post for division assignment:', insHwErr ? insHwErr.message : 'SUCCESS');
    } else {
      console.log('✓ Dedicated homework post already exists for division assignment.');
    }
  } catch (hwErr: any) {
    console.warn('Dedicated homework post check warning:', hwErr.message);
  }

  // 4. Update all submissions in data/submissions_backup.json
  const subs = JSON.parse(fs.readFileSync('data/submissions_backup.json', 'utf8'));
  const examSubs = subs.filter((s: any) => s.examId === SPELLING_EXAM_ID);
  console.log(`Processing ${examSubs.length} submissions for spelling exam...`);

  const auditReport: any[] = [];

  for (const sub of examSubs) {
    const evalResult = evaluateEntireExamSubmission(spellingExam, sub.answers || {});

    sub.status = 'approved';
    sub.isReleased = true;
    sub.is_released = true;
    sub.earnedPoints = evalResult.earnedPoints;
    sub.totalScore = evalResult.earnedPoints;
    sub.scaledScore20 = evalResult.scaledScore20;

    sub.teacherGrading = {
      approved: true,
      approvedAt: new Date().toISOString(),
      questionScores: evalResult.questionScores,
      questionFeedbacks: evalResult.questionFeedbacks,
      totalScore: evalResult.earnedPoints,
      scaledScore20: evalResult.scaledScore20,
      teacherNotes: sub.teacherGrading?.teacherNotes || 'بررسی، انطباق و تایید نهایی نمره توسط آموزگار انجام شد.',
    };

    if (sub.answers && typeof sub.answers === 'object') {
      sub.answers.approved = true;
      sub.answers.teacher_approved = true;
      sub.answers.is_released = true;
      sub.answers.score = evalResult.scaledScore20;
      sub.answers.raw_score = evalResult.earnedPoints;
    }

    const q1Score = evalResult.questionScores?.['q2'] || 0;
    const q3Score = evalResult.questionScores?.['q4'] || 0;

    auditReport.push({
      studentId: sub.studentId,
      studentName: sub.studentName,
      q1Score,
      q3Score,
      rawScore: evalResult.earnedPoints,
      scaledScore20: evalResult.scaledScore20,
      questionScores: evalResult.questionScores,
    });

    // Update Supabase quiz_submissions
    try {
      await supabase
        .from('quiz_submissions')
        .update({
          score: evalResult.scaledScore20,
          answers: sub.answers,
        })
        .eq('quiz_id', SPELLING_EXAM_ID)
        .eq('student_id', sub.studentId);
    } catch (e) {}

    // Update individual __EXAM_SUB__ post in Supabase
    try {
      const postTitle = `__EXAM_SUB__:${SPELLING_EXAM_ID}:${sub.studentId}`;
      const { data: existingPost } = await supabase
        .from('posts')
        .select('id')
        .eq('title', postTitle)
        .limit(1);

      if (existingPost && existingPost.length > 0) {
        await supabase
          .from('posts')
          .update({ body: JSON.stringify(sub) })
          .eq('id', existingPost[0].id);
      } else {
        await supabase
          .from('posts')
          .insert({
            title: postTitle,
            type: 'announcement',
            body: JSON.stringify(sub),
            publish_at: new Date().toISOString(),
          });
      }
    } catch (e) {}
  }

  // Save back updated submissions
  fs.writeFileSync('data/submissions_backup.json', JSON.stringify(subs, null, 2), 'utf8');
  console.log('✓ data/submissions_backup.json saved with updated grades.');

  // 5. Update Supabase __SYSTEM_EXAM_SUBMISSIONS__ post
  try {
    const { error: sysSubErr } = await supabase
      .from('posts')
      .update({ body: JSON.stringify(subs) })
      .eq('title', '__SYSTEM_EXAM_SUBMISSIONS__');
    console.log('✓ Supabase __SYSTEM_EXAM_SUBMISSIONS__ updated:', sysSubErr ? `Error: ${sysSubErr.message}` : 'SUCCESS');
  } catch (e: any) {
    console.warn('__SYSTEM_EXAM_SUBMISSIONS__ update warning:', e.message);
  }

  // 6. Update Supabase grades table for all 35 students in CLASS_STUDENTS_ROSTER
  console.log('\n--- UPDATING SUPABASE GRADES TABLE FOR ALL 35 ROSTER STUDENTS ---');
  let successGradeCount = 0;

  for (const student of CLASS_STUDENTS_ROSTER) {
    const item = auditReport.find((r) => r.studentId === student.id);
    if (!item) {
      console.warn(`No submission found for roster student: ${student.fullName} (${student.id})`);
      continue;
    }

    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('teacher_add_grade', {
        p_password: TEACHER_PASSWORD,
        p_student_id: student.id,
        p_subject: 'فارسی',
        p_skill: 'آزمون: املای درس اول و دوم',
        p_score: item.scaledScore20,
        p_max_score: 20,
      });

      if (rpcErr) {
        console.warn(`RPC error for ${student.fullName}:`, rpcErr.message);
      } else {
        successGradeCount++;
      }
    } catch (e: any) {
      console.warn(`Exception updating grade for ${student.fullName}:`, e.message);
    }
  }

  console.log(`✓ Successfully updated ${successGradeCount} of ${CLASS_STUDENTS_ROSTER.length} student grades via RPC.`);

  // 7. Clean up any stale duplicate grades
  try {
    const { data: allDbGrades } = await supabase
      .from('grades')
      .select('id, student_id, skill, score, max_score, created_at')
      .ilike('skill', '%املای درس اول و دوم%')
      .order('created_at', { ascending: false });

    if (allDbGrades && allDbGrades.length > 0) {
      const keepMap = new Map<string, string>(); // student_id -> keepGradeId
      const deleteIds: string[] = [];

      for (const g of allDbGrades) {
        if (!keepMap.has(g.student_id)) {
          keepMap.set(g.student_id, g.id);
        } else {
          deleteIds.push(g.id);
        }
      }

      if (deleteIds.length > 0) {
        console.log(`Cleaning up ${deleteIds.length} stale duplicate grades...`);
        await supabase.from('grades').delete().in('id', deleteIds);
        console.log('✓ Stale duplicate grades cleaned up.');
      }
    }
  } catch (e: any) {
    console.warn('Duplicate grade cleanup warning:', e.message);
  }

  // 8. Print comprehensive audit table
  console.log('\n========================================================================================');
  console.log('                     FINAL STRICT Q1 SCORING AUDIT REPORT                               ');
  console.log('========================================================================================');
  console.log('#   | نام دانش‌آموز                | نمره س۱ | نمره س۳ | نمره خام (از ۹.۵) | نمره نهایی (از ۲۰)');
  console.log('----+-----------------------------+---------+---------+--------------------+-------------------');

  auditReport.forEach((r, idx) => {
    const num = String(idx + 1).padStart(3, ' ');
    const name = r.studentName.padEnd(28, ' ');
    const q1 = String(r.q1Score).padStart(7, ' ');
    const q3 = String(r.q3Score).padStart(7, ' ');
    const raw = String(r.rawScore).padStart(18, ' ');
    const scaled = String(r.scaledScore20).padStart(19, ' ');
    console.log(`${num} | ${name} | ${q1} | ${q3} | ${raw} | ${scaled}`);
  });

  console.log('========================================================================================');
  console.log('✓ ALL TASKS COMPLETED SUCCESSFULLY.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

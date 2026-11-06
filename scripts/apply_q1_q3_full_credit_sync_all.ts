import fs from 'fs';
import { supabase } from '../src/supabaseClient';
import { evaluateEntireExamSubmission } from '../src/utils/persianSemanticGrader';
import { CLASS_STUDENTS_ROSTER } from '../src/classStudents';

async function main() {
  console.log('=== STARTING UNIVERSAL Q1 & Q3 FULL CREDIT SYNC ===');

  const EXAM_ID = 'a0c2d8d2-3f0b-4af6-95ff-3608cf9e2aa2';
  const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD?.trim() || '1234';

  // 1. Update data/exams_backup.json
  const exams = JSON.parse(fs.readFileSync('data/exams_backup.json', 'utf8'));
  const exam = exams.find((e: any) => e.id === EXAM_ID);
  if (!exam) {
    throw new Error('Spelling exam not found in exams_backup.json');
  }

  const q2 = exam.questions.find((q: any) => q.id === 'q2');
  if (q2) {
    q2.awardFullScoreToAll = true;
    q2.allOptionsCorrect = true;
  }
  const q4 = exam.questions.find((q: any) => q.id === 'q4');
  if (q4) {
    q4.awardFullScoreToAll = true;
    q4.allOptionsCorrect = true;
  }

  fs.writeFileSync('data/exams_backup.json', JSON.stringify(exams, null, 2), 'utf8');
  console.log('✓ data/exams_backup.json updated with Q1 & Q3 awardFullScoreToAll: true');

  // 2. Update Supabase quizzes table
  const { error: quizErr } = await supabase
    .from('quizzes')
    .update({ questions: exam.questions })
    .eq('id', EXAM_ID);
  console.log('✓ Supabase quizzes table updated:', quizErr ? `Error: ${quizErr.message}` : 'SUCCESS');

  // 3. Update Supabase __SYSTEM_EXAMS__ post
  const { error: sysExamErr } = await supabase
    .from('posts')
    .update({ body: JSON.stringify(exams) })
    .eq('title', '__SYSTEM_EXAMS__');
  console.log('✓ Supabase __SYSTEM_EXAMS__ updated:', sysExamErr ? `Error: ${sysExamErr.message}` : 'SUCCESS');

  // 4. Update all submissions in data/submissions_backup.json
  const subs = JSON.parse(fs.readFileSync('data/submissions_backup.json', 'utf8'));
  const examSubs = subs.filter((s: any) => s.examId === EXAM_ID);
  console.log(`Found ${examSubs.length} submissions for exam.`);

  const studentGradeSummary: any[] = [];

  for (const sub of examSubs) {
    const evalResult = evaluateEntireExamSubmission(exam, sub.answers || {});

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

    studentGradeSummary.push({
      studentId: sub.studentId,
      studentName: sub.studentName,
      rawScore: evalResult.earnedPoints,
      scaledScore20: evalResult.scaledScore20,
      questionScores: evalResult.questionScores,
    });

    // Update Supabase quiz_submissions if uuid
    try {
      await supabase
        .from('quiz_submissions')
        .update({
          score: evalResult.scaledScore20,
          answers: sub.answers,
        })
        .eq('quiz_id', EXAM_ID)
        .eq('student_id', sub.studentId);
    } catch (e) {}

    // Update individual __EXAM_SUB__ post in Supabase
    try {
      const postTitle = `__EXAM_SUB__:${EXAM_ID}:${sub.studentId}`;
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
            body: JSON.stringify(sub),
            type: 'announcement',
          });
      }
    } catch (e) {}
  }

  // Save updated submissions to data/submissions_backup.json
  fs.writeFileSync('data/submissions_backup.json', JSON.stringify(subs, null, 2), 'utf8');
  console.log('✓ data/submissions_backup.json updated with re-evaluated scores.');

  // 5. Update Supabase __SYSTEM_EXAM_SUBMISSIONS__
  try {
    const { data: sysSubPosts } = await supabase
      .from('posts')
      .select('id')
      .eq('title', '__SYSTEM_EXAM_SUBMISSIONS__');

    if (sysSubPosts && sysSubPosts.length > 0) {
      await supabase
        .from('posts')
        .update({ body: JSON.stringify(subs) })
        .eq('id', sysSubPosts[0].id);
      console.log('✓ Supabase __SYSTEM_EXAM_SUBMISSIONS__ post updated.');
    }
  } catch (e) {}

  // 6. Update Supabase grades table via teacher_list_grades & teacher_add_grade
  console.log('--- SYNCING SUPABASE GRADES TABLE ---');
  const { data: currentGrades } = await supabase.rpc('teacher_list_grades', {
    p_password: TEACHER_PASSWORD,
  });

  const skillName = 'آزمون: املای درس اول و دوم';

  for (const st of studentGradeSummary) {
    if (st.studentId === 'test_preview_student') continue; // Don't put test user in class grades table

    // Check if grade already exists for this student & skill
    const matchingGrades = (currentGrades || []).filter(
      (g: any) =>
        (g.student_id === st.studentId || (g.student_name && g.student_name === st.studentName)) &&
        (g.skill === skillName || g.skill?.includes('املای درس اول'))
    );

    // If duplicate grades exist, delete extras
    if (matchingGrades.length > 1) {
      console.log(`Found ${matchingGrades.length} duplicates for ${st.studentName}. Cleaning...`);
      for (let i = 1; i < matchingGrades.length; i++) {
        await supabase.rpc('teacher_delete_grade', {
          p_password: TEACHER_PASSWORD,
          p_grade_id: matchingGrades[i].id,
        });
      }
    }

    if (matchingGrades.length >= 1) {
      const primaryGrade = matchingGrades[0];
      if (primaryGrade.score !== st.scaledScore20) {
        // Delete old and re-add with exact correct score
        await supabase.rpc('teacher_delete_grade', {
          p_password: TEACHER_PASSWORD,
          p_grade_id: primaryGrade.id,
        });
        const addRes = await supabase.rpc('teacher_add_grade', {
          p_password: TEACHER_PASSWORD,
          p_student_id: st.studentId,
          p_subject: 'فارسی',
          p_skill: skillName,
          p_score: st.scaledScore20,
          p_max_score: 20,
        });
        console.log(`Updated grade for ${st.studentName}: ${primaryGrade.score} -> ${st.scaledScore20}`, addRes.error ? `Error: ${addRes.error.message}` : '✓');
      } else {
        console.log(`Grade already up-to-date for ${st.studentName}: ${st.scaledScore20} / 20`);
      }
    } else {
      // Add new grade
      const addRes = await supabase.rpc('teacher_add_grade', {
        p_password: TEACHER_PASSWORD,
        p_student_id: st.studentId,
        p_subject: 'فارسی',
        p_skill: skillName,
        p_score: st.scaledScore20,
        p_max_score: 20,
      });
      console.log(`Added grade for ${st.studentName}: ${st.scaledScore20} / 20`, addRes.error ? `Error: ${addRes.error.message}` : '✓');
    }
  }

  // 7. Verify all students
  console.log('\n=== FINAL VERIFICATION ACROSS ALL 35 CLASS STUDENTS ===');
  const { data: verifiedGrades } = await supabase.rpc('teacher_list_grades', {
    p_password: TEACHER_PASSWORD,
  });

  const verificationRows: any[] = [];
  let totalDiscrepancies = 0;

  for (const st of studentGradeSummary) {
    if (st.studentId === 'test_preview_student') continue;
    const dbGrade = (verifiedGrades || []).find(
      (g: any) =>
        (g.student_id === st.studentId || (g.student_name && g.student_name === st.studentName)) &&
        (g.skill === skillName || g.skill?.includes('املای درس اول'))
    );
    const dbScore = dbGrade ? Number(dbGrade.score) : 0;
    const diff = Math.abs(dbScore - st.scaledScore20);
    if (diff > 0.001) totalDiscrepancies++;

    // Sum of all 9 questions
    const qSum = Object.values(st.questionScores).reduce((a: number, b: any) => a + Number(b), 0);
    const sumDiff = Math.abs(qSum - st.rawScore);
    if (sumDiff > 0.001) totalDiscrepancies++;

    verificationRows.push({
      نام_دانش‌آموز: st.studentName,
      سوال۱: st.questionScores['q2'],
      سوال۳: st.questionScores['q4'],
      جمع_۹_سوال: qSum.toFixed(2),
      نمره_خام_۹_۵: st.rawScore.toFixed(2),
      نمره_۲۰: st.scaledScore20.toFixed(1),
      دیتابیس: dbScore.toFixed(1),
      وضعیت: diff < 0.001 && sumDiff < 0.001 ? 'کاملاً منطبق ✓' : 'اختلاف ⚠️',
    });
  }

  console.table(verificationRows);
  console.log(`\nVerification Finished. Total Discrepancies: ${totalDiscrepancies}`);
}

main().catch(console.error);

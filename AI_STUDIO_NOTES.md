# یادداشت برای ویرایش‌های بعدی (AI Studio / Gemini)

این بخش‌ها عمداً این‌طور نوشته شده‌اند؛ در ویرایش‌های بعدی آن‌ها را حذف یا ساده نکن:

1. `src/supabaseClient.ts` — اتصال چندمسیره به Supabase (همان دامنه `/sb` ← Worker ← مستقیم) + ساعت سرور (`getServerNowMs`). هرگز به `createClient` ساده با یک آدرس ثابت برنگردان.
2. `netlify.toml` — قانون `/sb/*` باید قبل از قانون `/*` بماند.
3. کد ورود دانش‌آموز: همیشه `resolveStudentAccessCode(student)` (کدی که با آن وارد شده)، نه کد ملی.
4. `buildCanonicalGradesList`: نمره‌ی جدول `grades` نمره‌ی رسمی و از ۲۰ است؛ `teacherView: true` برای همه‌ی صفحه‌های معلم.
5. دانش‌آموز هرگز ردیف `__SYSTEM_EXAM_SUBMISSIONS__` را دانلود نمی‌کند.
6. نظارت آزمون: `src/services/examIntegrity.ts` + `ExamIntegrityAlerts.tsx` + واترمارک نام در `StudentExamTaker.tsx`؛ SQL: `supabase/migration_exam_integrity.sql`.
7. زمان‌ها با ساعت سرور مقایسه می‌شوند (`getServerNowMs`) نه `Date.now()`.

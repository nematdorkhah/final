import { useMemo, useState } from 'react'
import { toPersianDigits } from '../utils/persianNumbers'
import { useClassroomData } from '../hooks/useClassroomData'
import { getJalaliDateLabel } from '../useJalaliDate'
import { computeStreak, weakestSubjects } from '../masteryHelpers'
import MobileHeader from '../components/MobileHeader'
import MobileTabBar from '../components/MobileTabBar'
import MobileModal from '../components/MobileModal'
import KpiCards from '../components/KpiCards'
import StudentMonitoringLeague from '../components/StudentMonitoringLeague'
import NewPostForm from '../components/NewPostForm'
import AiPracticeForm from '../components/AiPracticeForm'
import TeacherAiAssistant from '../components/TeacherAiAssistant'
import NewStudentForm from '../components/NewStudentForm'
import NewGradeForm from '../components/NewGradeForm'
import BulkGradeForm from '../components/BulkGradeForm'
import PostsBoard from '../components/PostsBoard'
import HomeworkStatusList from '../components/HomeworkStatusList'
import AttendanceList from '../components/AttendanceList'
import Gradebook from '../components/Gradebook'
import StudentProfilePanel from '../components/StudentProfilePanel'
import BackupRestoreModal from '../components/BackupRestoreModal'
import LoadingScreen from '../components/LoadingScreen'
import { exportClassroomToExcel } from '../utils/excelExport'
import { getLocalExams, getLocalSubmissions } from '../utils/examStore'
import { sortByLastName } from '../utils/persianSort'

type TeacherTab = 'home' | 'posts' | 'attendance' | 'grades' | 'monitoring' | 'ai'

export default function TeacherDashboard({
  teacherPassword,
  onLogout,
  onPreviewAsStudent,
}: {
  teacherPassword: string
  onLogout: () => void
  onPreviewAsStudent?: (student: any) => void
}) {
  const { weekday, jalali } = getJalaliDateLabel()
  const {
    students,
    posts,
    submissions,
    attendanceToday,
    allAttendance,
    grades,
    loading,
    error,
    reload,
  } = useClassroomData(teacherPassword)

  const sortedStudents = useMemo(() => sortByLastName(students), [students])

  const [activeTab, setActiveTab] = useState<TeacherTab>('home')
  const [showNewPost, setShowNewPost] = useState(false)
  const [showNewStudent, setShowNewStudent] = useState(false)
  const [showNewGrade, setShowNewGrade] = useState(false)
  const [showBackupModal, setShowBackupModal] = useState(false)
  const [showStudentPreviewModal, setShowStudentPreviewModal] = useState(false)
  const [previewSearch, setPreviewSearch] = useState('')
  const [gradeMode, setGradeMode] = useState<'bulk' | 'single'>('bulk')
  const [openStudentId, setOpenStudentId] = useState<string | null>(null)
  const [postFilter, setPostFilter] = useState<'all' | 'homework' | 'announcement'>('all')
  const [aiSubTab, setAiSubTab] = useState<'chat' | 'exam'>('chat')
  const [monitoringSubTab, setMonitoringSubTab] = useState<'league' | 'tizhooshan' | 'charts' | 'alerts'>('league')

  const isSystemRecord = (p: any) => {
    if (!p) return true
    const title = String(p.title || '')
    if (title.startsWith('__')) return true
    if (title.includes('__SYSTEM_') || title.includes('__EXAM_SUB__')) return true
    if (p.type === 'exam') return true
    if (typeof p.body === 'string' && (p.body.includes('"questions":') || p.body.includes('"examId":'))) {
      try {
        const parsed = JSON.parse(p.body)
        if (parsed.questions || parsed.examId || Array.isArray(parsed)) return true
      } catch {}
    }
    return false
  }

  const now = new Date()
  const cleanPosts = posts.filter((p) => !isSystemRecord(p))
  const publishedPosts = cleanPosts.filter((p) => new Date(p.publish_at) <= now)
  const homeworkPosts = publishedPosts.filter((p) => p.type === 'homework')

  const combinedGrades = useMemo(() => {
    const list = [...grades]
    const localExams = getLocalExams()
    const examSubs = getLocalSubmissions()
    const examMap = new Map(localExams.map((e) => [e.id, e]))
    for (const sub of examSubs) {
      const exam = examMap.get(sub.examId)
      if (!exam) continue
      const score = sub.teacherGrading?.totalScore ?? sub.aiGrading?.totalScore ?? (sub as any).studentScore
      if (score === undefined || score === null) continue
      const exists = list.some(
        (g) => g.student_id === sub.studentId && (g.skill === `آزمون: ${exam.title}` || g.skill === exam.title)
      )
      if (!exists) {
        list.push({
          id: `exam_sub_${sub.id}`,
          student_id: sub.studentId,
          subject: exam.subject || 'عمومی',
          skill: `آزمون: ${exam.title}`,
          score: Number(score),
          max_score: exam.totalPoints || 20,
          recorded_at: sub.submittedAt || new Date().toISOString(),
          is_exam: true,
        })
      }
    }
    return list
  }, [grades])

  const statsRows = useMemo(() => {
    return sortedStudents.map((s) => {
      const myGrades = combinedGrades.filter((g) => g.student_id === s.id)
      const avg = myGrades.length
        ? myGrades.reduce((sum: number, g: any) => sum + (g.score / g.max_score) * 20, 0) / myGrades.length
        : null
      const mySubmissionRows = submissions.filter((sub) => sub.student_id === s.id)
      const myPresent = allAttendance.filter((a) => a.student_id === s.id && a.status === 'present').length
      const myLate = allAttendance.filter((a) => a.student_id === s.id && a.status === 'late').length
      const streak = computeStreak(homeworkPosts, mySubmissionRows)
      return {
        id: s.id,
        name: s.full_name,
        avg,
        submitted: mySubmissionRows.length,
        totalHomework: homeworkPosts.length,
        present: myPresent,
        late: myLate,
        streak,
      }
    })
  }, [sortedStudents, combinedGrades, submissions, allAttendance, homeworkPosts])

  const weakSubjects = useMemo(() => weakestSubjects(combinedGrades, 3), [combinedGrades])

  const openStudent = students.find((s) => s.id === openStudentId)

  const filteredPosts = useMemo(() => {
    if (postFilter === 'all') return publishedPosts
    return publishedPosts.filter((p) => p.type === postFilter)
  }, [publishedPosts, postFilter])

  const tabs = [
    { id: 'home', label: 'داشبورد', icon: '🏠' },
    { id: 'posts', label: 'تکالیف', icon: '📢', badge: homeworkPosts.length || undefined },
    { id: 'attendance', label: 'حضور و غیاب', icon: '✅' },
    { id: 'grades', label: 'نمرات', icon: '📊' },
    { id: 'monitoring', label: 'پایش و لیگ', icon: '📈' },
    { id: 'ai', label: 'هوش مصنوعی', icon: '🤖' },
  ]

  if (loading) {
    return (
      <div dir="rtl" className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <LoadingScreen
          message="در حال بارگذاری اطلاعات کلاس درس..."
          error={error}
          onRetry={reload}
          onLogout={onLogout}
        />
      </div>
    )
  }

  return (
    <div dir="rtl" className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans pb-36 sm:pb-32">
      {/* Native Mobile Top Bar */}
      <MobileHeader
        title="کلاس ششم دبستان"
        subtitle="دبستان حضرت قائم (عج)"
        userBadge="آموزگار"
        dateLabel={`${weekday}، ${jalali}`}
        onLogout={onLogout}
      />

      {/* Main Tab Views */}
      <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-5 pb-16 flex-1">
        {/* TAB 1: HOME (Dashboard Overview) */}
        {activeTab === 'home' && (
          <div className="space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            {/* Hero Greeting Card */}
            <div className="bg-gradient-to-br from-indigo-900 via-indigo-800 to-blue-700 text-white rounded-2xl p-4 sm:p-5 shadow-xs relative overflow-hidden mb-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div className="inline-flex items-center gap-1.5 bg-white/15 px-2.5 py-0.5 rounded-full text-[11px] font-bold mb-1.5 border border-white/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> سال تحصیلی ۱۴۰۵ - ۱۴۰۴
                  </div>
                  <h2 className="text-base sm:text-lg font-black tracking-tight">
                    پنل مدیریت کلاس <span className="text-sky-300">ششم ابتدایی</span>
                  </h2>
                  <p className="text-[11px] sm:text-xs text-indigo-100 font-medium">
                    {toPersianDigits(students.length)} دانش‌آموز فعال · {toPersianDigits(homeworkPosts.length)} تکلیف ثبت‌شده
                  </p>
                </div>
              </div>

              {/* Quick Actions Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 mt-3.5 pt-3 border-t border-white/10">
                <button
                  type="button"
                  className="flex items-center gap-2 p-2 sm:p-2.5 rounded-xl text-xs font-bold bg-white text-slate-800 border border-slate-200/90 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer"
                  onClick={() => setShowNewPost(true)}
                >
                  <span className="text-base">📝</span>
                  <span className="truncate">ارسال تکلیف</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 p-2 sm:p-2.5 rounded-xl text-xs font-bold bg-white text-slate-800 border border-slate-200/90 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer"
                  onClick={() => setActiveTab('attendance')}
                >
                  <span className="text-base">✅</span>
                  <span className="truncate">حضور امروز</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 p-2 sm:p-2.5 rounded-xl text-xs font-bold bg-white text-slate-800 border border-slate-200/90 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer"
                  onClick={() => setShowNewGrade(true)}
                >
                  <span className="text-base">📊</span>
                  <span className="truncate">ثبت نمره</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 p-2 sm:p-2.5 rounded-xl text-xs font-bold bg-white text-slate-800 border border-slate-200/90 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer"
                  onClick={() => {
                    setMonitoringSubTab('league')
                    setActiveTab('monitoring')
                  }}
                >
                  <span className="text-base">📈</span>
                  <span className="truncate">پایش و لیگ</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 p-2 sm:p-2.5 rounded-xl text-xs font-bold bg-white text-slate-800 border border-slate-200/90 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer"
                  onClick={() => {
                    setMonitoringSubTab('tizhooshan')
                    setActiveTab('monitoring')
                  }}
                >
                  <span className="text-base">🦉</span>
                  <span className="truncate">ردیاب تیزهوشان</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 p-2 sm:p-2.5 rounded-xl text-xs font-bold bg-white text-slate-800 border border-slate-200/90 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer"
                  onClick={() => setActiveTab('ai')}
                >
                  <span className="text-base">🤖</span>
                  <span className="truncate">آزمون هوشمند</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 p-2 sm:p-2.5 rounded-xl text-xs font-bold bg-white text-slate-800 border border-slate-200/90 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer"
                  onClick={() => setShowBackupModal(true)}
                >
                  <span className="text-base">💾</span>
                  <span className="truncate">پشتیبان‌گیری</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 p-2 sm:p-2.5 rounded-xl text-xs font-bold bg-sky-600 text-white shadow-2xs hover:bg-sky-700 transition-all cursor-pointer"
                  onClick={() => setShowStudentPreviewModal(true)}
                >
                  <span className="text-base">👁️</span>
                  <span className="truncate">نگاه دانش‌آموز</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 p-2 sm:p-2.5 rounded-xl text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 transition-all cursor-pointer col-span-2 sm:col-span-1"
                  onClick={() => {
                    if (confirm('آیا از خروج از حساب آموزگار اطمینان دارید؟')) {
                      onLogout()
                    }
                  }}
                >
                  <span className="text-base">🚪</span>
                  <span className="truncate">خروج از حساب</span>
                </button>
              </div>
            </div>

            {/* Quick AI Classroom Data Analysis Card */}
            <div
              onClick={() => {
                setActiveTab('ai')
                setAiSubTab('chat')
              }}
              className="w-full max-w-full overflow-hidden box-border bg-gradient-to-r from-slate-900 via-indigo-950 to-indigo-900 text-white rounded-2xl p-3.5 sm:p-5 shadow-md border border-indigo-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer hover:border-indigo-400 transition-all"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-2xl sm:text-3xl shrink-0">🤖</span>
                <div className="min-w-0">
                  <div className="font-black text-xs sm:text-base truncate">
                    گفتگو با هوش مصنوعی درباره دیتای کلاس
                  </div>
                  <div className="text-[11px] sm:text-xs text-indigo-200 mt-0.5 line-clamp-2">
                    تحلیل وضعیت درسی، تکالیف ارسال‌نشده، نقاط ضعف و قوت دانش‌آموزان
                  </div>
                </div>
              </div>
              <span className="self-start sm:self-auto text-xs font-bold bg-white/15 px-3 py-1.5 rounded-xl whitespace-nowrap border border-white/20 shrink-0">
                شروع تحلیل 💬
              </span>
            </div>

            {/* KPI Cards */}
            <div className="mt-6">
              <KpiCards
                students={sortedStudents}
                attendanceToday={attendanceToday}
                homeworkPosts={homeworkPosts}
                submissions={submissions}
                grades={grades}
                statsRows={statsRows}
                weakSubjects={weakSubjects}
              />
            </div>
          </div>
        )}

        {/* TAB 2: POSTS & HOMEWORK */}
        {activeTab === 'posts' && (
          <div className="space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-900 tracking-tight">تکالیف و اعلانات کلاسی</h2>
                <p className="text-xs text-slate-500 font-medium mt-0.5">{publishedPosts.length} پیام و تکلیف در کلاس</p>
              </div>
              <button
                type="button"
                className="btn self-start sm:self-auto"
                onClick={() => setShowNewPost(true)}
              >
                + پست جدید
              </button>
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-xl border border-slate-200/80 flex-wrap">
              <button
                type="button"
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  postFilter === 'all'
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                onClick={() => setPostFilter('all')}
              >
                همه ({publishedPosts.length})
              </button>
              <button
                type="button"
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  postFilter === 'homework'
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                onClick={() => setPostFilter('homework')}
              >
                📐 فقط تکالیف ({homeworkPosts.length})
              </button>
              <button
                type="button"
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  postFilter === 'announcement'
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                onClick={() => setPostFilter('announcement')}
              >
                📣 اعلانات عمومی
              </button>
            </div>

            {/* Posts Board */}
            <PostsBoard
              posts={filteredPosts}
              teacherPassword={teacherPassword}
              onChanged={reload}
            />

            {/* Submissions Summary */}
            <div className="mt-8 pt-6 border-t border-slate-200">
              <div className="mb-4">
                <h3 className="text-lg font-black text-slate-900 tracking-tight">وضعیت تحویل تکالیف</h3>
                <p className="text-xs text-slate-500 font-medium mt-0.5">بررسی ارسال‌ها، فایل‌ها و بازخورد آموزگار</p>
              </div>
              <HomeworkStatusList
                homeworkPosts={homeworkPosts}
                submissions={submissions}
                students={sortedStudents}
                onRefresh={reload}
              />
            </div>
          </div>
        )}

        {/* TAB 3: ATTENDANCE */}
        {activeTab === 'attendance' && (
          <div className="space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-black text-slate-900 tracking-tight">حضور و غیاب امروز</h2>
                <p className="text-xs text-slate-500 font-medium mt-0.5">{weekday}، {jalali}</p>
              </div>
            </div>

            <AttendanceList
              students={sortedStudents}
              attendanceToday={attendanceToday}
              teacherPassword={teacherPassword}
              onChanged={reload}
            />
          </div>
        )}

        {/* TAB 4: GRADES & GRADEBOOK */}
        {activeTab === 'grades' && (
          <div className="space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-900 tracking-tight">دفتر نمرات و دانش‌آموزان</h2>
                <p className="text-xs text-slate-500 font-medium mt-0.5">{sortedStudents.length} دانش‌آموز در کلاس</p>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-300 hover:bg-emerald-100 transition-colors shadow-xs"
                  onClick={() =>
                    exportClassroomToExcel({
                      students: sortedStudents,
                      grades: combinedGrades,
                      submissions,
                      allAttendance,
                      homeworkPosts,
                    })
                  }
                  title="دانلود گزارش جامع اکسل به ترتیب الفبا"
                >
                  📊 خروجی اکسل (الفبا)
                </button>
                <button
                  type="button"
                  className="btn secondary text-xs"
                  onClick={() => setShowNewStudent(true)}
                >
                  + دانش‌آموز
                </button>
                <button
                  type="button"
                  className="btn text-xs"
                  onClick={() => setShowNewGrade(true)}
                >
                  + ثبت نمره
                </button>
              </div>
            </div>

            <Gradebook
              students={sortedStudents}
              grades={combinedGrades}
              attendanceRows={allAttendance}
              onSelectStudent={(id) => setOpenStudentId(id)}
              onRetry={reload}
            />
          </div>
        )}

        {/* TAB 5: STUDENT MONITORING & LEAGUE */}
        {activeTab === 'monitoring' && (
          <div className="space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            <StudentMonitoringLeague
              key={monitoringSubTab}
              students={sortedStudents}
              grades={combinedGrades}
              submissions={submissions}
              allAttendance={allAttendance}
              homeworkPosts={homeworkPosts}
              onOpenStudent={(id) => setOpenStudentId(id)}
              initialSubTab={monitoringSubTab}
            />
          </div>
        )}

        {/* TAB 6: AI ASSISTANT & CLASS DATA CHAT */}
        {activeTab === 'ai' && (
          <div className="w-full max-w-full overflow-hidden box-border space-y-4 sm:space-y-6 animate-[mobileFadeIn_0.2s_ease-out]">
            <div className="mb-3 px-1">
              <h2 className="text-lg sm:text-xl font-black text-slate-900 tracking-tight">دستیار هوشمند و تحلیل داده‌های کلاس</h2>
              <p className="text-xs text-slate-500 font-medium mt-0.5">گفتگو درباره عملکرد بچه‌ها، تحلیل تکالیف و طراحی آزمون</p>
            </div>

            {/* Sub-tab segmented toggle */}
            <div className="flex gap-2 p-1 bg-slate-100 rounded-xl border border-slate-200/80 mb-4 w-full max-w-md box-border">
              <button
                type="button"
                className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  aiSubTab === 'chat'
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                onClick={() => setAiSubTab('chat')}
              >
                <span>💬</span>
                <span>تحلیل داده‌ها</span>
              </button>
              <button
                type="button"
                className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  aiSubTab === 'exam'
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                onClick={() => setAiSubTab('exam')}
              >
                <span>📝</span>
                <span>آزمون‌ساز هوشمند</span>
              </button>
            </div>

            <div className="w-full max-w-full overflow-hidden box-border">
              {aiSubTab === 'chat' ? (
                <TeacherAiAssistant
                  students={sortedStudents}
                  statsRows={statsRows}
                  homeworkPosts={homeworkPosts}
                  grades={combinedGrades}
                  allAttendance={allAttendance}
                  weakSubjects={weakSubjects}
                  teacherPassword={teacherPassword}
                />
              ) : (
                <AiPracticeForm
                  teacherPassword={teacherPassword}
                  students={sortedStudents}
                  onDone={() => {
                    reload()
                    setActiveTab('posts')
                  }}
                  onCancel={() => setActiveTab('home')}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {/* Fixed Bottom Tab Navigation */}
      <MobileTabBar
        tabs={tabs}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as TeacherTab)}
        studentName="آموزگار کلاس"
      />

      {/* MODAL: New Post */}
      <MobileModal
        isOpen={showNewPost}
        onClose={() => setShowNewPost(false)}
        title="ارسال پست یا تکلیف جدید"
        subtitle="برای نمایش به دانش‌آموزان در کلاس"
      >
        <NewPostForm
          teacherPassword={teacherPassword}
          onDone={() => {
            setShowNewPost(false)
            reload()
          }}
          onCancel={() => setShowNewPost(false)}
        />
      </MobileModal>

      {/* MODAL: New Student */}
      <MobileModal
        isOpen={showNewStudent}
        onClose={() => setShowNewStudent(false)}
        title="افزودن دانش‌آموز جدید"
        subtitle="ثبت مشخصات و کد ورود دانش‌آموز"
      >
        <NewStudentForm
          teacherPassword={teacherPassword}
          onDone={() => {
            setShowNewStudent(false)
            reload()
          }}
          onCancel={() => setShowNewStudent(false)}
        />
      </MobileModal>

      {/* MODAL: New Grade (Bulk or Single) */}
      <MobileModal
        isOpen={showNewGrade}
        onClose={() => setShowNewGrade(false)}
        title="ثبت نمرات کلاسی"
        subtitle="امتحانات، فعالیت کلاسی و تکالیف"
      >
        <div className="flex gap-2 p-1 bg-slate-100 rounded-xl border border-slate-200/80 mb-4">
          <button
            type="button"
            className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-bold transition-all ${
              gradeMode === 'bulk'
                ? 'bg-white text-blue-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
            onClick={() => setGradeMode('bulk')}
          >
            گروهی (همه کلاس)
          </button>
          <button
            type="button"
            className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-bold transition-all ${
              gradeMode === 'single'
                ? 'bg-white text-blue-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
            onClick={() => setGradeMode('single')}
          >
            انفرادی
          </button>
        </div>

        {gradeMode === 'bulk' ? (
          <BulkGradeForm
            teacherPassword={teacherPassword}
            students={sortedStudents}
            onDone={() => {
              setShowNewGrade(false)
              reload()
            }}
            onCancel={() => setShowNewGrade(false)}
          />
        ) : (
          <NewGradeForm
            teacherPassword={teacherPassword}
            students={sortedStudents}
            onDone={() => {
              setShowNewGrade(false)
              reload()
            }}
            onCancel={() => setShowNewGrade(false)}
          />
        )}
      </MobileModal>

      {/* MODAL: Student Profile / Details */}
      {openStudent && (
        <MobileModal
          isOpen={Boolean(openStudent)}
          onClose={() => setOpenStudentId(null)}
          title={`پرونده تحصیلی ${openStudent.full_name}`}
        >
          <StudentProfilePanel
            student={openStudent}
            grades={combinedGrades.filter((g) => g.student_id === openStudent.id)}
            submissions={submissions.filter((s) => s.student_id === openStudent.id)}
            attendanceRows={allAttendance.filter((a) => a.student_id === openStudent.id)}
            homeworkPosts={homeworkPosts}
            teacherPassword={teacherPassword}
            onClose={() => setOpenStudentId(null)}
            onChanged={reload}
            onDeleted={() => {
              setOpenStudentId(null)
              reload()
            }}
          />
        </MobileModal>
      )}

      {/* MODAL: Backup & Restore */}
      <MobileModal
        isOpen={showBackupModal}
        onClose={() => setShowBackupModal(false)}
        title="پشتیبان‌گیری و بازیابی داده‌ها"
        subtitle="حفظ کلیه اطلاعات، تکالیف و نمرات کلاس"
      >
        <BackupRestoreModal
          teacherPassword={teacherPassword}
          onClose={() => setShowBackupModal(false)}
          onRestored={() => {
            reload()
            setShowBackupModal(false)
          }}
        />
      </MobileModal>

      {/* MODAL: Preview as Student */}
      <MobileModal
        isOpen={showStudentPreviewModal}
        onClose={() => setShowStudentPreviewModal(false)}
        title="مشاهده داشبورد از نگاه دانش‌آموز"
        subtitle="بررسی نحوه نمایش صفحات، تکالیف و تست آپلود فایل‌ها"
      >
        <div className="flex flex-col gap-3.5">
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs text-emerald-800 leading-relaxed">
            💡 <strong>همکار گرامی:</strong> با انتخاب هر دانش‌آموز، برنامه مستقیماً در حالت دانش‌آموزی باز می‌شود تا بتوانید ببینید تکالیف، آزمون‌ها و پیام‌ها به درستی نمایش داده می‌شوند یا خیر. در بالای صفحه نیز دکمه بازگشت فوری به پنل معلم قرار دارد.
          </div>

          <input
            type="text"
            className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-hidden focus:border-blue-500 bg-slate-50 focus:bg-white transition-colors"
            placeholder="جستجوی نام یا کد ملی دانش‌آموز..."
            value={previewSearch}
            onChange={(e) => setPreviewSearch(e.target.value)}
          />

          <div className="max-h-80 overflow-y-auto flex flex-col gap-2">
            {/* Sample Student Option */}
            <div className="flex items-center justify-between p-3 bg-slate-50 border border-dashed border-blue-300 rounded-xl">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl">🎓</span>
                <div>
                  <div className="font-bold text-xs text-blue-900">
                    دانش‌آموز تستی / پیش‌فرض کلاس
                  </div>
                  <div className="text-[11px] text-slate-500">
                    برای بررسی عمومی بدون اثرگذاری روی دانش‌آموز خاص
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="btn text-xs py-1.5 px-3"
                onClick={() => {
                  setShowStudentPreviewModal(false)
                  if (onPreviewAsStudent) {
                    onPreviewAsStudent({
                      id: 'test_preview_student',
                      full_name: 'دانش‌آموز نمونه (تست معلم)',
                      access_code: '0000000000',
                    })
                  }
                }}
              >
                ورود نمونه
              </button>
            </div>

            {/* Real Students Roster */}
            {sortedStudents
              .filter((s) =>
                previewSearch.trim()
                  ? (s.full_name || '').toLowerCase().includes(previewSearch.trim().toLowerCase()) ||
                    (s.id || '').includes(previewSearch.trim())
                  : true
              )
              .map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between p-2.5 bg-white border border-slate-200 rounded-xl"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-700 flex items-center justify-center font-black text-xs shrink-0">
                      {(s.full_name || 'د')[0]}
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-xs text-slate-800 truncate">
                        {s.full_name}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        کد ملی: {toPersianDigits(s.id)}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn secondary text-xs py-1 px-2.5 shrink-0"
                    onClick={() => {
                      setShowStudentPreviewModal(false)
                      if (onPreviewAsStudent) {
                        onPreviewAsStudent(s)
                      }
                    }}
                  >
                    مشاهده 👁️
                  </button>
                </div>
              ))}
          </div>
        </div>
      </MobileModal>
    </div>
  )
}

import { useEffect, useState, useMemo, useRef } from 'react'
import { supabase } from './supabaseClient'
import TeacherDashboard from './pages/TeacherDashboard'
import StudentDashboard from './pages/StudentDashboard'
import PrincipalDashboard from './pages/PrincipalDashboard'
import SchoolLogo from './components/SchoolLogo'
import LoadingScreen from './components/LoadingScreen'
import { toPersianDigits } from './utils/persianNumbers'
import { sortByLastName } from './utils/persianSort'
import { CLASS_STUDENTS_ROSTER } from './classStudents'

const initialIsTeacher = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).has('teacher') : false

const AUTH_STORAGE_KEY = 'class_auth_session'

interface AuthSession {
  role: 'student' | 'teacher' | 'principal'
  student?: any
  studentId?: string
  studentName?: string
  teacherPassword?: string
  principalPassword?: string
  savedAt: number
}

function getStoredAuthSession(): AuthSession | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(AUTH_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        if (parsed.role === 'teacher' && parsed.teacherPassword) {
          return parsed
        }
        if (parsed.role === 'principal') {
          return parsed
        }
        if (parsed.role === 'student') {
          const sId = parsed.student?.id || parsed.studentId || parsed.student?.access_code
          const match = CLASS_STUDENTS_ROSTER.find((cs) => cs.nationalCode === sId)
          const validStudent = parsed.student || (match ? {
            id: match.nationalCode,
            full_name: match.fullName,
            father_name: match.fatherName,
            access_code: match.nationalCode,
          } : (sId ? { id: sId, full_name: parsed.studentName || 'دانش‌آموز', access_code: sId } : null))

          if (validStudent) {
            return {
              role: 'student',
              student: validStudent,
              studentId: validStudent.id,
              studentName: validStudent.full_name,
              savedAt: parsed.savedAt || Date.now(),
            }
          }
        }
      }
    }
    // Backward compatibility: load from legacy 'student' localStorage key
    const legacyStudent = localStorage.getItem('student')
    if (legacyStudent) {
      const parsedStudent = JSON.parse(legacyStudent)
      if (parsedStudent && (parsedStudent.id || parsedStudent.access_code)) {
        return {
          role: 'student',
          student: parsedStudent,
          studentId: parsedStudent.id || parsedStudent.access_code,
          studentName: parsedStudent.full_name,
          savedAt: Date.now(),
        }
      }
    }
    // Backward compatibility: load from legacy sessionStorage
    if (typeof sessionStorage !== 'undefined') {
      if (sessionStorage.getItem('principalAuthed') === '1') {
        return { role: 'principal', principalPassword: 'khalili100', savedAt: Date.now() }
      }
      if (sessionStorage.getItem('teacherAuthed') === '1') {
        return {
          role: 'teacher',
          teacherPassword: sessionStorage.getItem('teacherPassword') || '1234',
          savedAt: Date.now(),
        }
      }
    }
  } catch (err) {
    console.warn('[App Init] Failed reading stored auth session:', err)
  }
  return null
}

export default function App() {
  console.log('[App] Rendering main component tree...');

  const initialSession = useMemo(() => getStoredAuthSession(), [])

  const [roleMode, setRoleMode] = useState<'student' | 'teacher'>(() => {
    if (initialSession) {
      return initialSession.role === 'principal' || initialSession.role === 'teacher' ? 'teacher' : 'student'
    }
    return initialIsTeacher ? 'teacher' : 'student'
  })

  const [teacherPassword, setTeacherPassword] = useState<string>(() => {
    return initialSession?.role === 'teacher' ? (initialSession.teacherPassword || '') : ''
  })
  const [teacherAuthed, setTeacherAuthed] = useState<boolean>(() => {
    return initialSession?.role === 'teacher' && Boolean(initialSession.teacherPassword)
  })
  const [principalAuthed, setPrincipalAuthed] = useState<boolean>(() => {
    return initialSession?.role === 'principal'
  })
  const [teacherPreviewStudent, setTeacherPreviewStudent] = useState<any>(null)

  const [student, setStudent] = useState<any>(() => {
    return initialSession?.role === 'student' ? initialSession.student : null
  })
  const [isLoading, setIsLoading] = useState(!student && !teacherAuthed && !principalAuthed)
  const [students, setStudents] = useState<any[]>(() =>
    sortByLastName(
      CLASS_STUDENTS_ROSTER.map((cs) => ({
        id: cs.nationalCode,
        full_name: cs.fullName,
        father_name: cs.fatherName,
        access_code: cs.nationalCode,
      }))
    )
  )
  const [selectedStudentId, setSelectedStudentId] = useState('')
  const [studentSearch, setStudentSearch] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [accessCode, setAccessCode] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [checking, setChecking] = useState(false)

  function switchRole(mode: 'student' | 'teacher') {
    setRoleMode(mode)
    setLoginError('')
    setPasswordInput('')
    setShowPassword(false)
  }

  const dropdownRef = useRef<HTMLDivElement>(null)

  // Root mount effect: enforce session restoration from localStorage
  useEffect(() => {
    try {
      const stored = getStoredAuthSession()
      if (stored) {
        if (stored.role === 'principal') {
          setPrincipalAuthed(true)
          setRoleMode('teacher')
          setIsLoading(false)
        } else if (stored.role === 'teacher' && stored.teacherPassword) {
          setTeacherPassword(stored.teacherPassword)
          setTeacherAuthed(true)
          setRoleMode('teacher')
          setIsLoading(false)
        } else if (stored.role === 'student' && stored.student) {
          setStudent(stored.student)
          setRoleMode('student')
          setIsLoading(false)
        } else {
          setIsLoading(false)
        }
      } else {
        setIsLoading(false)
      }
    } catch (err) {
      console.warn('Error reading stored session on root mount:', err)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowSearchDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    // 3-second safety guard timeout: under any circumstance, remove loading screen and show login
    const safetyTimeout = setTimeout(() => {
      setIsLoading(false)
    }, 3000)

    async function loadRoster() {
      try {
        if (roleMode === 'teacher' || student) {
          setIsLoading(false)
          return
        }
        const { data, error } = await supabase.rpc('list_students_public')
        if (!error && Array.isArray(data) && data.length > 0) {
          setStudents(sortByLastName(data))
        } else {
          setStudents(
            sortByLastName(
              CLASS_STUDENTS_ROSTER.map((cs) => ({
                id: cs.nationalCode,
                full_name: cs.fullName,
                father_name: cs.fatherName,
                access_code: cs.nationalCode,
              }))
            )
          )
        }
      } catch (err) {
        console.warn('Failed to fetch public students roster:', err)
        setStudents(
          sortByLastName(
            CLASS_STUDENTS_ROSTER.map((cs) => ({
              id: cs.nationalCode,
              full_name: cs.fullName,
              father_name: cs.fatherName,
              access_code: cs.nationalCode,
            }))
          )
        )
      } finally {
        setIsLoading(false)
        clearTimeout(safetyTimeout)
      }
    }

    loadRoster()

    return () => clearTimeout(safetyTimeout)
  }, [student, roleMode])

  const sortedAllStudents = useMemo(() => {
    return sortByLastName(students, 'full_name')
  }, [students])

  const filteredStudents = useMemo(() => {
    if (!studentSearch.trim()) return sortedAllStudents
    return sortedAllStudents.filter((s) =>
      String(s?.full_name || '').toLowerCase().includes(studentSearch.trim().toLowerCase())
    )
  }, [sortedAllStudents, studentSearch])

  function clearAuthSession() {
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY)
      localStorage.removeItem('student')
      sessionStorage.removeItem('teacherAuthed')
      sessionStorage.removeItem('teacherPassword')
      sessionStorage.removeItem('principalAuthed')
      sessionStorage.removeItem('active_taking_exam_id')
    } catch (e) {
      console.warn('Failed clearing auth session:', e)
    }
    setStudent(null)
    setTeacherAuthed(false)
    setTeacherPassword('')
    setPrincipalAuthed(false)
    setTeacherPreviewStudent(null)
    setPasswordInput('')
    setAccessCode('')
    setSelectedStudentId('')
  }

  function persistStudent(s: any) {
    if (!s) return
    const studentData = Array.isArray(s) ? s[0] : s
    const session: AuthSession = {
      role: 'student',
      student: studentData,
      studentId: studentData.id || studentData.access_code,
      studentName: studentData.full_name,
      savedAt: Date.now(),
    }
    try {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session))
      localStorage.setItem('student', JSON.stringify(studentData))
    } catch (e) {
      console.warn('Failed persisting student session:', e)
    }
    setStudent(studentData)
  }

  function logoutStudent() {
    clearAuthSession()
    setRoleMode('student')
  }

  function logoutTeacher() {
    clearAuthSession()
    setRoleMode('teacher')
  }

  function logoutPrincipal() {
    clearAuthSession()
    setRoleMode('teacher')
  }

  async function teacherLogin(e: React.FormEvent) {
    e.preventDefault()
    setChecking(true)
    setLoginError('')

    const cleanPass = passwordInput.trim()

    // 1. Principal Role Activation with 'khalili100' directly from teacher section
    if (cleanPass === 'khalili100') {
      const session: AuthSession = {
        role: 'principal',
        principalPassword: cleanPass,
        savedAt: Date.now(),
      }
      try {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session))
        sessionStorage.setItem('principalAuthed', '1')
      } catch {}
      setPrincipalAuthed(true)
      setChecking(false)
      return
    }

    try {
      const { data, error } = await supabase.rpc('verify_teacher', { p_password: cleanPass })
      setChecking(false)
      if (error || !data) {
        if (cleanPass === '1234') {
          const session: AuthSession = {
            role: 'teacher',
            teacherPassword: cleanPass,
            savedAt: Date.now(),
          }
          try {
            localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session))
            sessionStorage.setItem('teacherAuthed', '1')
            sessionStorage.setItem('teacherPassword', cleanPass)
          } catch {}
          setTeacherPassword(cleanPass)
          setTeacherAuthed(true)
          return
        }
        setLoginError('رمز عبور وارد شده نادرست است.')
        return
      }
      const session: AuthSession = {
        role: 'teacher',
        teacherPassword: cleanPass,
        savedAt: Date.now(),
      }
      try {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session))
        sessionStorage.setItem('teacherAuthed', '1')
        sessionStorage.setItem('teacherPassword', cleanPass)
      } catch {}
      setTeacherPassword(cleanPass)
      setTeacherAuthed(true)
    } catch {
      if (cleanPass === '1234') {
        const session: AuthSession = {
          role: 'teacher',
          teacherPassword: cleanPass,
          savedAt: Date.now(),
        }
        try {
          localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session))
          sessionStorage.setItem('teacherAuthed', '1')
          sessionStorage.setItem('teacherPassword', cleanPass)
        } catch {}
        setTeacherPassword(cleanPass)
        setTeacherAuthed(true)
        setChecking(false)
        return
      }
      setChecking(false)
      setLoginError('خطا در برقراری ارتباط با پایگاه داده.')
    }
  }

  const selectedStudent = useMemo(() => {
    return students.find((s) => s.id === selectedStudentId) || null
  }, [students, selectedStudentId])

  async function studentLogin(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedStudentId) {
      setLoginError('لطفاً نام خود را از فهرست کشویی جستجوی دانش‌آموزان انتخاب فرمایید.')
      return
    }
    if (!accessCode.trim()) {
      setLoginError('لطفاً کد ورود (کد ملی) خود را وارد فرمایید.')
      return
    }
    setChecking(true)
    setLoginError('')
    try {
      const { data, error } = await supabase.rpc('student_login', {
        p_student_id: selectedStudentId,
        p_access_code: accessCode.trim(),
      })
      if (!error && data) {
        setChecking(false)
        persistStudent(data)
        return
      }
      // Roster fallback if Supabase returns error or has no record
      const localMatch = CLASS_STUDENTS_ROSTER.find(
        (cs) => cs.nationalCode === selectedStudentId || cs.fullName === selectedStudent?.full_name
      )
      if (localMatch && localMatch.nationalCode === accessCode.trim()) {
        setChecking(false)
        persistStudent({
          id: localMatch.nationalCode,
          full_name: localMatch.fullName,
          access_code: localMatch.nationalCode,
          father_name: localMatch.fatherName,
        })
        return
      }
      setChecking(false)
      setLoginError('کد ورود (کد ملی) صحیح نمی‌باشد.')
    } catch {
      const localMatch = CLASS_STUDENTS_ROSTER.find(
        (cs) => cs.nationalCode === selectedStudentId || cs.fullName === selectedStudent?.full_name
      )
      if (localMatch && localMatch.nationalCode === accessCode.trim()) {
        setChecking(false)
        persistStudent({
          id: localMatch.nationalCode,
          full_name: localMatch.fullName,
          access_code: localMatch.nationalCode,
          father_name: localMatch.fatherName,
        })
        return
      }
      setChecking(false)
      setLoginError('خطا در ورود دانش‌آموز.')
    }
  }

  // Loading state with safety guard timeout
  if (isLoading) {
    return (
      <LoadingScreen
        message="در حال بارگذاری اطلاعات مدرسه..."
        onRetry={() => window.location.reload()}
        onLogout={clearAuthSession}
      />
    )
  }

  // Principal dashboard
  if (principalAuthed) {
    return (
      <PrincipalDashboard
        principalPassword="khalili100"
        onLogout={logoutPrincipal}
      />
    )
  }

  // Teacher dashboard
  if (roleMode === 'teacher' && teacherAuthed) {
    if (teacherPreviewStudent) {
      return (
        <StudentDashboard
          student={teacherPreviewStudent}
          onLogout={() => setTeacherPreviewStudent(null)}
          isTeacherPreview={true}
          onExitPreview={() => setTeacherPreviewStudent(null)}
        />
      )
    }
    return (
      <TeacherDashboard
        teacherPassword={teacherPassword}
        onLogout={logoutTeacher}
        onPreviewAsStudent={(s) => setTeacherPreviewStudent(s)}
      />
    )
  }

  // Student dashboard
  if (student) {
    return (
      <StudentDashboard
        student={student}
        onLogout={logoutStudent}
        onStudentUpdate={persistStudent}
      />
    )
  }

  // Modern Responsive Centered Login Screen
  return (
    <div
      dir="rtl"
      className="min-h-screen w-full flex items-center justify-center p-4 sm:p-6 bg-slate-50 font-sans selection:bg-blue-100 selection:text-blue-900"
      style={{
        backgroundImage: 'radial-gradient(circle at 50% 0%, rgba(219, 234, 254, 0.45) 0%, rgba(248, 250, 252, 1) 70%)',
      }}
    >
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl shadow-slate-200/80 border border-slate-200/90 p-6 sm:p-8 relative overflow-hidden backdrop-blur-sm">
        {/* Top colored accent bar */}
        <div className="absolute top-0 right-0 left-0 h-1.5 bg-gradient-to-r from-blue-600 via-indigo-600 to-sky-500" />

        {/* Top School Branding Header */}
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 transform transition-transform hover:scale-105 duration-200">
            <SchoolLogo size={78} />
          </div>

          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-bold border border-blue-200/70 shadow-xs mb-2">
            <span>🏫</span>
            <span>دبستان حضرت قائم (عج)</span>
          </div>

          <h1 className="text-xl sm:text-2xl font-black text-slate-800 tracking-tight">
            کلاس ششم <span className="text-blue-600">ابتدایی</span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 font-medium mt-1">
            سامانه هوشمند مدیریت کلاس ششم
          </p>
        </div>

        {/* Role Selector Tabs (2 roles: Student, Teacher & Management) */}
        <div className="grid grid-cols-2 p-1.5 bg-slate-100 rounded-2xl gap-1.5 border border-slate-200/80 mt-6 mb-6">
          <button
            type="button"
            onClick={() => switchRole('student')}
            className={`py-2.5 px-2 text-xs sm:text-sm font-bold rounded-xl transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer ${
              roleMode === 'student'
                ? 'bg-white text-blue-700 shadow-sm shadow-slate-200 font-black'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
            }`}
          >
            <span>🧒</span>
            <span>دانش‌آموز</span>
          </button>
          <button
            type="button"
            onClick={() => switchRole('teacher')}
            className={`py-2.5 px-2 text-xs sm:text-sm font-bold rounded-xl transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer ${
              roleMode === 'teacher'
                ? 'bg-white text-blue-700 shadow-sm shadow-slate-200 font-black'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
            }`}
          >
            <span>👨‍🏫</span>
            <span>آموزگار و مدیریت</span>
          </button>
        </div>

        {/* FORM 1: STUDENT LOGIN */}
        {roleMode === 'student' && (
          <form onSubmit={studentLogin} className="space-y-4">
            <div>
              <label className="block text-xs sm:text-sm font-bold text-slate-700 mb-1.5">
                نام دانش‌آموز <span className="text-slate-400 font-normal">(جستجو بر اساس نام خانوادگی):</span>
              </label>

              <div ref={dropdownRef} className="relative">
                <div className="relative flex items-center">
                  <input
                    type="text"
                    placeholder="🔍 جستجوی نام یا نام خانوادگی..."
                    value={studentSearch}
                    onFocus={() => setShowSearchDropdown(true)}
                    onChange={(e) => {
                      setStudentSearch(e.target.value)
                      setShowSearchDropdown(true)
                      if (!e.target.value.trim()) {
                        setSelectedStudentId('')
                      }
                    }}
                    className={`w-full py-2.5 px-3.5 pr-3 pl-9 rounded-xl border text-sm transition-all outline-none bg-slate-50/70 focus:bg-white text-slate-800 placeholder:text-slate-400 ${
                      selectedStudentId
                        ? 'border-emerald-500 ring-2 ring-emerald-100 bg-emerald-50/30'
                        : 'border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
                    }`}
                  />
                  {studentSearch && (
                    <button
                      type="button"
                      onClick={() => {
                        setStudentSearch('')
                        setSelectedStudentId('')
                        setShowSearchDropdown(true)
                      }}
                      className="absolute left-2.5 w-6 h-6 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-600 flex items-center justify-center text-xs transition cursor-pointer"
                      title="پاک کردن"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* Autocomplete dropdown */}
                {showSearchDropdown && (
                  <div className="absolute top-full right-0 left-0 z-50 bg-white rounded-2xl border border-slate-200 shadow-xl max-h-56 overflow-y-auto mt-1.5 divide-y divide-slate-100">
                    <div className="p-2 bg-slate-50 text-[11px] font-bold text-slate-500 flex justify-between items-center sticky top-0 border-b border-slate-100">
                      <span>فهرست الفبایی ({toPersianDigits(filteredStudents.length)} دانش‌آموز)</span>
                      <span>انتخاب با لمس</span>
                    </div>

                    {filteredStudents.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-400">
                        دانش‌آموزی با این نام یافت نشد.
                      </div>
                    ) : (
                      filteredStudents.map((s, idx) => {
                        const isSelected = selectedStudentId === s.id
                        return (
                          <div
                            key={s.id}
                            onClick={() => {
                              setSelectedStudentId(s.id)
                              setStudentSearch(s.full_name)
                              setShowSearchDropdown(false)
                              setLoginError('')
                            }}
                            className={`p-2.5 px-3 text-xs sm:text-sm cursor-pointer flex justify-between items-center transition-colors ${
                              isSelected
                                ? 'bg-blue-50 text-blue-700 font-bold'
                                : 'text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] text-slate-400 font-mono w-5">
                                {toPersianDigits(idx + 1)}.
                              </span>
                              <span>{s.full_name}</span>
                            </div>
                            {isSelected ? (
                              <span className="text-xs text-emerald-600 font-black">✓ انتخاب شد</span>
                            ) : (
                              <span className="text-[11px] text-slate-300">انتخاب ◀</span>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>

              {/* Selected Student Confirmation Pill */}
              {selectedStudent && (
                <div className="mt-2 p-2 px-3 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-between text-xs text-emerald-800 font-bold">
                  <div className="flex items-center gap-1.5">
                    <span>✅</span>
                    <span>دانش‌آموز: <strong>{selectedStudent.full_name}</strong></span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedStudentId('')
                      setStudentSearch('')
                      setShowSearchDropdown(true)
                    }}
                    className="text-rose-600 hover:text-rose-700 text-xs font-bold cursor-pointer"
                  >
                    تغییر ✕
                  </button>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs sm:text-sm font-bold text-slate-700 mb-1.5">
                کد ورود <span className="text-slate-400 font-normal">(کد ملی دانش‌آموز):</span>
              </label>
              <div className="relative flex items-center">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="کد ملی ۱۰ رقمی خود را وارد فرمایید..."
                  value={accessCode}
                  onChange={(e) => setAccessCode(e.target.value)}
                  inputMode="numeric"
                  className="w-full py-2.5 px-3.5 pr-3 pl-10 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 text-sm transition-all outline-none bg-slate-50/70 focus:bg-white text-slate-800 placeholder:text-slate-400 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute left-2.5 text-slate-400 hover:text-slate-600 text-sm p-1 cursor-pointer transition"
                  title={showPassword ? 'مخفی کردن کد' : 'نمایش کد'}
                >
                  {showPassword ? '👁️' : '🔒'}
                </button>
              </div>
            </div>

            {loginError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-2">
                <span>⚠️</span>
                <span>{loginError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={checking}
              className="w-full mt-2 py-3.5 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 active:scale-[0.99] text-white font-black text-sm sm:text-base rounded-xl shadow-lg shadow-blue-500/25 transition-all duration-150 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {checking ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>در حال بررسی اطلاعات...</span>
                </>
              ) : (
                <>
                  <span>ورود به سامانه</span>
                  <span>🚀</span>
                </>
              )}
            </button>
          </form>
        )}

        {/* FORM 2: UNIFIED TEACHER & MANAGEMENT LOGIN */}
        {roleMode === 'teacher' && (
          <form onSubmit={teacherLogin} className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs sm:text-sm font-bold text-slate-700">
                  رمز عبور آموزگار یا مدیریت:
                </label>
              </div>
              <div className="relative flex items-center">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="رمز عبور خود را وارد فرمایید..."
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  autoFocus
                  className="w-full py-2.5 px-3.5 pr-3 pl-10 rounded-xl border border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 text-sm transition-all outline-none bg-slate-50/70 focus:bg-white text-slate-800 placeholder:text-slate-400 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute left-2.5 text-slate-400 hover:text-slate-600 text-sm p-1 cursor-pointer transition"
                  title={showPassword ? 'مخفی کردن' : 'نمایش رمز'}
                >
                  {showPassword ? '👁️' : '🔒'}
                </button>
              </div>
            </div>

            {loginError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-2">
                <span>⚠️</span>
                <span>{loginError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={checking}
              className="w-full mt-2 py-3.5 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 active:scale-[0.99] text-white font-black text-sm sm:text-base rounded-xl shadow-lg shadow-blue-500/25 transition-all duration-150 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {checking ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>در حال بررسی رمز عبور...</span>
                </>
              ) : (
                <>
                  <span>ورود به سامانه</span>
                  <span>🔐</span>
                </>
              )}
            </button>
          </form>
        )}

        {/* Card Footer */}
        <div className="mt-6 pt-4 border-t border-slate-100 flex flex-col items-center gap-1 text-xs text-slate-400 font-medium">
          <div className="flex items-center gap-2 text-slate-500 font-semibold">
            <span>سال تحصیلی {toPersianDigits('1404')} - {toPersianDigits('1405')}</span>
            <span>•</span>
            <span>پایه ششم ابتدایی</span>
          </div>
          <div className="text-[11px] text-slate-400" dir="ltr">
            دبستان حضرت قائم (عج)
          </div>
        </div>
      </div>
    </div>
  )
}

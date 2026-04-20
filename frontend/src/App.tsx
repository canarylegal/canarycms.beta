import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AdminBilling } from './AdminBilling'
import { AdminSubMenus } from './AdminSubMenus'
import { AdminTasks } from './AdminTasks'
import { CalendarPage } from './CalendarPage'
import {
  GlobalContactCreateForm,
  ContactPersonOrgAddressFields,
  contactOutToFormFields,
  contactFieldsModelToPayload,
  resolveContactNameWithFallback,
} from './GlobalContactCreateForm'
import { CASE_FILES_STORAGE_KEY, signalCaseFilesChanged } from './caseFilesCrossTab'
import { CaseDetail } from './case/CaseDetail'
import { matterContactTypeLabel } from './case/matterLabels'
import { CASE_MENU_OPTIONS } from './caseMenuOptions'
import { apiFetch, apiUrl } from './api'
import {
  ACCENT_COLOR_PRESETS,
  DEFAULT_ACCENT,
  DEFAULT_PAGE_BG,
  FONT_OPTIONS,
  PAGE_BG_COLOR_PRESETS,
  getThemePreferences,
  saveThemePreferences,
} from './theme'
import { AppLogo } from './AppLogo'
import { DEFAULT_OUTLOOK_WEB_MAIL_URL, openCanaryEmailLauncher } from './emailLauncher'
import { useDialogs } from './DialogProvider'
import { SearchInput } from './SearchInput'
import type { ApiError } from './api'
import { copyTextToClipboard } from './copyToClipboard'
import { canaryDocumentTitle } from './tabTitle'
import { caseHasRevokedUserAccess, formatCaseStatusLabel } from './types'
import type {
  AdminAuditEvent,
  CaseContactOut,
  CaseNoteOut,
  CaseOut,
  CaseTaskOut,
  TaskMenuRow,
  ContactOut,
  FileSummary,
  MatterContactTypeOut,
  MatterHeadTypeOut,
  MatterSubTypeOut,
  PrecedentCategoryFlatOut,
  PrecedentCategoryOut,
  PrecedentOut,
  TokenResponse,
  AdminUserPublic,
  UserCalDAVProvisionOut,
  UserCalDAVStatusOut,
  UserPermissionCategoryOut,
  UserPublic,
  UserSummary,
} from './types'

type View =
  | 'main-menu'
  | 'tasks'
  | 'case-menu'
  | 'contacts'
  | 'calendar'
  | 'reports'
  | 'user-settings'
  | 'admin-console'

function canaryViewTitleSegment(view: View, caseDetail: CaseOut | null): string {
  switch (view) {
    case 'main-menu':
      return 'Main menu'
    case 'case-menu': {
      const desc = caseDetail?.matter_description?.trim()
      if (desc) return desc
      const ref = caseDetail?.case_number?.trim()
      return ref || 'Case'
    }
    case 'tasks':
      return 'Tasks'
    case 'contacts':
      return 'Contacts'
    case 'calendar':
      return 'Calendar'
    case 'reports':
      return 'Reports'
    case 'user-settings':
      return 'User Settings'
    case 'admin-console':
      return 'Admin settings'
  }
}

function formatTs(s: string) {
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}

function formatTaskMenuDate(iso: string) {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

/** Main menu cases: Reference · Client · Description · Fee earner · Status — Client 30fr; Status 5fr (5% moved from Status to Client). */
const MAIN_MENU_CASES_TABLE_GRID =
  'minmax(0, 10fr) minmax(0, 30fr) minmax(0, 35fr) minmax(0, 20fr) minmax(0, 5fr)'

/**
 * Tasks menu: Date · Priority · Assigned · Task · Description · Client · Reference.
 * Description is 30% of row width (30fr of 100fr); other columns scale with prior proportions on the remaining 70%.
 */
const TASKS_MENU_TABLE_GRID =
  'minmax(0, 8.768fr) minmax(0, 6.427fr) minmax(0, 8.768fr) minmax(0, 20.459fr) minmax(0, 30fr) minmax(0, 18.267fr) minmax(0, 7.311fr)'

/** Contacts page: Name · Type · Email · Phone — Name 30% (90fr/300fr); others share 70% equally (70fr each). */
const CONTACTS_TABLE_GRID =
  'minmax(0, 90fr) minmax(0, 70fr) minmax(0, 70fr) minmax(0, 70fr)'

function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'))
  const [me, setMe] = useState<UserPublic | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Lives in this hook (not in LoginForm) so it survives remounts when `loading` toggles. */
  const [loginError, setLoginError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      // Do not call setLoading(true) when unauthenticated: App would replace the login form with
      // "Loading…", unmount LoginForm, and clear its local state (including any inline login error).
      if (!token) {
        setMe(null)
        setError(null)
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const user = await apiFetch<UserPublic>('/auth/me', { token })
        if (!cancelled) setMe(user)
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? 'Auth error')
          setMe(null)
          setToken(null)
          localStorage.removeItem('token')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [token])

  const refreshMe = useCallback(async () => {
    if (!token) return
    try {
      const user = await apiFetch<UserPublic>('/auth/me', { token })
      setMe(user)
    } catch {
      /* keep existing me */
    }
  }, [token])

  return {
    token,
    me,
    loading,
    error,
    loginError,
    clearLoginError: () => setLoginError(null),
    refreshMe,
    async login(email: string, password: string, totpCode?: string) {
      setLoginError(null)
      try {
        const res = await apiFetch<TokenResponse>('/auth/login', {
          json: { email, password, totp_code: totpCode ?? null },
        })
        localStorage.setItem('token', res.access_token)
        setToken(res.access_token)
      } catch (e: any) {
        setLoginError(e?.message ?? 'Login failed')
      }
    },
    logout() {
      localStorage.removeItem('token')
      setToken(null)
      setMe(null)
      setLoginError(null)
    },
  }
}

function LoginForm({
  onLogin,
  error,
  onClearError,
}: {
  onLogin: (email: string, password: string, totp?: string) => Promise<void>
  error: string | null
  onClearError: () => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await onLogin(email, password, totp || undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="loginScreen">
      <div className="loginBrandRow">
        <AppLogo />
      </div>
      <div className="card" style={{ maxWidth: 520, margin: '24px auto 0' }}>
        <p className="muted">Sign in to continue.</p>
        <form className="stack" style={{ marginTop: 16 }} onSubmit={handleSubmit}>
        <label className="field">
          <span>Email</span>
          <input
            value={email}
            onChange={(e) => {
              onClearError()
              setEmail(e.target.value)
            }}
            autoComplete="username"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              onClearError()
              setPassword(e.target.value)
            }}
            autoComplete="current-password"
          />
        </label>
        <label className="field">
          <span>TOTP (if enabled)</span>
          <input
            value={totp}
            onChange={(e) => {
              onClearError()
              setTotp(e.target.value)
            }}
            inputMode="numeric"
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <button
          type="submit"
          className="btn primary"
          disabled={busy}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        </form>
      </div>
    </div>
  )
}

function App({ initialTasksCaseFilter }: { initialTasksCaseFilter?: string | null } = {}) {
  const auth = useAuth()
  const { askConfirm } = useDialogs()
  const [view, setView] = useState<View>(() => (initialTasksCaseFilter ? 'tasks' : 'main-menu'))
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const [showNewMatter, setShowNewMatter] = useState(false)

  // Cases
  const [cases, setCases] = useState<CaseOut[]>([])
  const [, setCasesBusy] = useState(false)
  const [casesErr, setCasesErr] = useState<string | null>(null)
  const [caseSearch, setCaseSearch] = useState('')
  const [filterMatterType, setFilterMatterType] = useState('')
  const [filterFeeEarnerUserId, setFilterFeeEarnerUserId] = useState('')
  const [filterCaseStatus, setFilterCaseStatus] = useState<
    '' | 'open' | 'closed' | 'archived' | 'quote' | 'post_completion'
  >('')
  const [sortKey, setSortKey] = useState<'reference' | 'client' | 'matter' | 'feeEarner' | 'status' | 'created'>(
    'created',
  )
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  /** Row highlight before double-click to open a case */
  const [caseListFocusId, setCaseListFocusId] = useState<string | null>(null)
  const [mainMenuFilterOpen, setMainMenuFilterOpen] = useState(false)
  const mainMenuFilterWrapRef = useRef<HTMLDivElement | null>(null)

  const [taskMenuRows, setTaskMenuRows] = useState<TaskMenuRow[]>([])
  const [taskMenuCaseFilter, setTaskMenuCaseFilter] = useState<string | null>(initialTasksCaseFilter ?? null)
  const [taskMenuSearch, setTaskMenuSearch] = useState('')
  const [taskMenuFilterMatterType, setTaskMenuFilterMatterType] = useState('')
  const [taskMenuSortKey, setTaskMenuSortKey] = useState<
    'reference' | 'client' | 'matter' | 'task' | 'date' | 'assigned' | 'priority'
  >('priority')
  const [taskMenuSortDir, setTaskMenuSortDir] = useState<'asc' | 'desc'>('asc')
  const [tasksMenuFilterOpen, setTasksMenuFilterOpen] = useState(false)
  const tasksMenuFilterWrapRef = useRef<HTMLDivElement | null>(null)

  // Case detail data
  const [caseDetail, setCaseDetail] = useState<CaseOut | null>(null)
  const [notes, setNotes] = useState<CaseNoteOut[]>([])
  const [tasks, setTasks] = useState<CaseTaskOut[]>([])
  const [files, setFiles] = useState<FileSummary[]>([])
  const [caseContacts, setCaseContacts] = useState<CaseContactOut[]>([])
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [caseListUsers, setCaseListUsers] = useState<UserSummary[]>([])
  const isAdmin = auth.me?.role === 'admin'

  const token = auth.token ?? undefined

  const mainMenuMatterTypeOptions = useMemo(() => {
    const set = new Set<string>()
    for (const c of cases) {
      set.add(matterTypeLabel(c))
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [cases])

  const mainMenuActiveFilterCount = useMemo(
    () =>
      (filterMatterType ? 1 : 0) +
      (filterFeeEarnerUserId ? 1 : 0) +
      (filterCaseStatus ? 1 : 0),
    [filterMatterType, filterFeeEarnerUserId, filterCaseStatus],
  )

  const tasksMenuMatterTypeOptions = useMemo(() => {
    const s = new Set<string>()
    for (const r of taskMenuRows) {
      if (r.matter_type_label.trim()) s.add(r.matter_type_label)
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }, [taskMenuRows])

  const tasksMenuActiveFilterCount = useMemo(() => (taskMenuFilterMatterType ? 1 : 0), [taskMenuFilterMatterType])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    async function load() {
      try {
        const data = await apiFetch<UserSummary[]>('/users', { token })
        if (!cancelled) setCaseListUsers((Array.isArray(data) ? data : []).filter((u) => u.is_active))
      } catch {
        if (!cancelled) setCaseListUsers([])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [token])

  async function refreshCases() {
    if (!token) return
    setCasesBusy(true)
    setCasesErr(null)
    try {
      const data = await apiFetch<CaseOut[]>('/cases', { token })
      setCases(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setCasesErr(e?.message ?? 'Failed to load cases')
    } finally {
      setCasesBusy(false)
    }
  }

  const refreshTaskMenu = useCallback(async () => {
    if (!token) return
    try {
      const q = taskMenuCaseFilter ? `?case_id=${encodeURIComponent(taskMenuCaseFilter)}` : ''
      const data = await apiFetch<TaskMenuRow[]>(`/tasks${q}`, { token })
      setTaskMenuRows(Array.isArray(data) ? data : [])
    } catch {
      setTaskMenuRows([])
    }
  }, [token, taskMenuCaseFilter])

  const refreshCaseDetail = useCallback(async (caseId: string) => {
    if (!token) return
    setDetailErr(null)
    try {
      const [c, n, t, f, cc] = await Promise.all([
        apiFetch<CaseOut>(`/cases/${caseId}`, { token }),
        apiFetch<CaseNoteOut[]>(`/cases/${caseId}/notes`, { token }),
        apiFetch<CaseTaskOut[]>(`/cases/${caseId}/tasks`, { token }),
        apiFetch<FileSummary[]>(`/cases/${caseId}/files`, { token }),
        apiFetch<CaseContactOut[]>(`/cases/${caseId}/contacts`, { token }),
      ])
      setCaseDetail(c)
      setNotes(Array.isArray(n) ? n : [])
      setTasks(Array.isArray(t) ? t : [])
      setFiles(Array.isArray(f) ? f : [])
      setCaseContacts(Array.isArray(cc) ? cc : [])
    } catch (e: any) {
      setDetailErr(e?.message ?? 'Failed to load case')
    }
  }, [token])

  const refreshOpenCaseDetail = useCallback(() => {
    if (selectedCaseId) void refreshCaseDetail(selectedCaseId)
  }, [selectedCaseId, refreshCaseDetail])

  /** Refreshes the open case and notifies other browser tabs (``storage``) so their document list can update. */
  const refreshCaseDetailWithCrossTabSignal = useCallback(() => {
    refreshOpenCaseDetail()
    if (selectedCaseId) signalCaseFilesChanged(selectedCaseId)
  }, [selectedCaseId, refreshOpenCaseDetail])

  useEffect(() => {
    if (!token) return
    void refreshCases()
  }, [token])

  useEffect(() => {
    if (!token || view !== 'tasks') return
    void refreshTaskMenu()
  }, [token, view, refreshTaskMenu])

  useEffect(() => {
    if (!token || !selectedCaseId) return
    void refreshCaseDetail(selectedCaseId)
  }, [token, selectedCaseId, refreshCaseDetail])

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      const d = e.data as { type?: string; caseId?: string } | null
      if (d?.type === 'canary-files-changed' && d.caseId && selectedCaseId === d.caseId) {
        void refreshCaseDetail(d.caseId)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [selectedCaseId, refreshCaseDetail])

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== CASE_FILES_STORAGE_KEY || !e.newValue || !token) return
      let parsed: { caseId?: string } = {}
      try {
        parsed = JSON.parse(e.newValue) as { caseId?: string }
      } catch {
        return
      }
      if (parsed.caseId && selectedCaseId === parsed.caseId) {
        void refreshCaseDetail(parsed.caseId)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [token, selectedCaseId, refreshCaseDetail])

  useEffect(() => {
    if (!mainMenuFilterOpen) return
    function handleMouseDown(e: MouseEvent) {
      const root = mainMenuFilterWrapRef.current
      if (root && !root.contains(e.target as Node)) {
        setMainMenuFilterOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [mainMenuFilterOpen])

  useEffect(() => {
    if (!tasksMenuFilterOpen) return
    function handleMouseDown(e: MouseEvent) {
      const root = tasksMenuFilterWrapRef.current
      if (root && !root.contains(e.target as Node)) {
        setTasksMenuFilterOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [tasksMenuFilterOpen])

  useEffect(() => {
    if (view !== 'main-menu') setMainMenuFilterOpen(false)
    if (view !== 'tasks') setTasksMenuFilterOpen(false)
  }, [view])

  const main = useMemo(() => {
    if (!token) return null

    if (view === 'admin-console') return <AdminConsole token={token} />
    if (view === 'user-settings')
      return <UserSettingsPage token={token} refreshMe={auth.refreshMe} />
    if (view === 'calendar') return <CalendarPage token={token} onOpenSettings={() => setView('user-settings')} />
    if (view === 'contacts') return <Contacts token={token} />

    if (view === 'reports') {
      return (
        <div className="mainMenuShell mainMenuShell--mainMenu">
          <div className="card casesTableCard reportsPageShell">
            <h1 className="reportsPageTitle">Reports</h1>
            <p className="muted reportsPageLead">Reporting features to follow.</p>
          </div>
        </div>
      )
    }

    if (view === 'case-menu') {
      return (
        <CaseDetail
          token={token}
          caseDetail={caseDetail}
          notes={notes}
          tasks={tasks}
          files={files}
          caseContacts={caseContacts}
          error={detailErr}
          selectedCaseId={selectedCaseId}
          currentUser={auth.me}
          onRefresh={refreshCaseDetailWithCrossTabSignal}
          onCaseListInvalidate={() => void refreshCases()}
          onTaskMenuInvalidate={() => void refreshTaskMenu()}
        />
      )
    }

    if (view === 'tasks') {
      return (
        <div className="mainMenuShell mainMenuShell--mainMenu">
          <div className="mainMenuFilterBar">
            <div className="row mainMenuFilterRow mainMenuFilterRow--toolbar">
              <div className="mainMenuFilterRowLeft">
            <SearchInput
              placeholder="Search tasks (reference, client, matter, task, date, assigned)…"
              value={taskMenuSearch}
              onChange={(e) => setTaskMenuSearch(e.target.value)}
              onClear={() => setTaskMenuSearch('')}
              className="mainMenuSearchInput"
              aria-label="Search tasks"
            />
                <div className="caseToolbarDropdownWrap" ref={tasksMenuFilterWrapRef}>
                  <button
                    type="button"
                    className="btn mainMenuFilterBtn"
                    aria-expanded={tasksMenuFilterOpen}
                    aria-haspopup="true"
                    aria-controls="tasks-menu-filter-menu"
                    id="tasks-menu-filter-button"
                    onClick={() => setTasksMenuFilterOpen((o) => !o)}
                  >
                    <span className="mainMenuFilterBtnInner">
                      <svg
                        className="mainMenuFilterBtnIcon"
                        width={16}
                        height={16}
                        viewBox="0 0 24 24"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden
                      >
                        <polygon
                          points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>Filter</span>
                      <span className="mainMenuFilterBtnCount">({tasksMenuActiveFilterCount})</span>
                    </span>
                  </button>
                  {tasksMenuFilterOpen ? (
                    <div
                      id="tasks-menu-filter-menu"
                      className="caseToolbarDropdown mainMenuFilterDropdown"
                      role="group"
                      aria-labelledby="tasks-menu-filter-button"
                    >
                      <div className="stack mainMenuFilterDropdownBody">
                        <label className="field">
                          <span>Matter type</span>
                          <select
                            value={taskMenuFilterMatterType}
                            onChange={(e) => setTaskMenuFilterMatterType(e.target.value)}
                            aria-label="Filter tasks by matter type"
                          >
                            <option value="">All</option>
                            {tasksMenuMatterTypeOptions.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="mainMenuFilterRowRight">
                {taskMenuCaseFilter ? (
                  <button type="button" className="btn" onClick={() => setTaskMenuCaseFilter(null)}>
                    Show all tasks
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void refreshCases()
                    void refreshTaskMenu()
                  }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void (async () => {
                    if (!token) return
                    const ok = await askConfirm({
                      title: 'Clear completed tasks',
                      message: taskMenuCaseFilter
                        ? 'Remove all completed tasks for this matter from the list?'
                        : 'Remove all of your completed tasks from the list?',
                    })
                    if (!ok) return
                    try {
                      const q = taskMenuCaseFilter ? `?case_id=${encodeURIComponent(taskMenuCaseFilter)}` : ''
                      await apiFetch(`/tasks/completed${q}`, { token, method: 'DELETE' })
                      void refreshTaskMenu()
                    } catch {
                      // ignore
                    }
                  })()}
                >
                  Clear completed tasks
                </button>
              </div>
            </div>
          </div>
          <TasksTable
            token={token}
            currentUserId={auth.me?.id ?? ''}
            users={caseListUsers}
            rows={taskMenuRows}
            search={taskMenuSearch}
            filterMatterType={taskMenuFilterMatterType}
            onSelectCase={(caseId) => {
              setSelectedCaseId(caseId)
              setView('case-menu')
            }}
            sortKey={taskMenuSortKey}
            sortDir={taskMenuSortDir}
            onSort={(k) => {
              if (k === taskMenuSortKey) setTaskMenuSortDir(taskMenuSortDir === 'asc' ? 'desc' : 'asc')
              else {
                setTaskMenuSortKey(k)
                setTaskMenuSortDir(k === 'priority' ? 'desc' : 'asc')
              }
            }}
            onInvalidate={() => void refreshTaskMenu()}
          />
        </div>
      )
    }

    return (
      <div className="mainMenuShell mainMenuShell--mainMenu">
        {casesErr ? <div className="error">{casesErr}</div> : null}
        <div className="mainMenuFilterBar">
          <div className="row mainMenuFilterRow mainMenuFilterRow--toolbar">
            <div className="mainMenuFilterRowLeft">
            <SearchInput
              placeholder="Search cases (reference, client, matter, fee earner, status)…"
              value={caseSearch}
              onChange={(e) => setCaseSearch(e.target.value)}
              onClear={() => setCaseSearch('')}
              className="mainMenuSearchInput"
              aria-label="Search cases"
            />
            <div className="caseToolbarDropdownWrap" ref={mainMenuFilterWrapRef}>
              <button
                type="button"
                className="btn mainMenuFilterBtn"
                aria-expanded={mainMenuFilterOpen}
                aria-haspopup="true"
                aria-controls="main-menu-filter-menu"
                id="main-menu-filter-button"
                onClick={() => setMainMenuFilterOpen((o) => !o)}
              >
                <span className="mainMenuFilterBtnInner">
                  <svg
                    className="mainMenuFilterBtnIcon"
                    width={16}
                    height={16}
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden
                  >
                    <polygon
                      points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  </svg>
                  <span>Filter</span>
                  <span className="mainMenuFilterBtnCount">({mainMenuActiveFilterCount})</span>
                </span>
              </button>
              {mainMenuFilterOpen ? (
                <div
                  id="main-menu-filter-menu"
                  className="caseToolbarDropdown mainMenuFilterDropdown"
                  role="group"
                  aria-labelledby="main-menu-filter-button"
                >
                  <div className="stack mainMenuFilterDropdownBody">
                    <label className="field">
                      <span>Matter type</span>
                      <select
                        value={filterMatterType}
                        onChange={(e) => setFilterMatterType(e.target.value)}
                        aria-label="Filter by matter type"
                      >
                        <option value="">All</option>
                        {mainMenuMatterTypeOptions.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Fee earner</span>
                      <select
                        value={filterFeeEarnerUserId}
                        onChange={(e) => setFilterFeeEarnerUserId(e.target.value)}
                        aria-label="Filter by fee earner"
                      >
                        <option value="">All</option>
                        {caseListUsers
                          .slice()
                          .sort((a, b) => a.display_name.localeCompare(b.display_name))
                          .map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.display_name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Status</span>
                      <select
                        value={filterCaseStatus}
                        onChange={(e) =>
                          setFilterCaseStatus(
                            e.target.value as
                              | ''
                              | 'open'
                              | 'closed'
                              | 'archived'
                              | 'quote'
                              | 'post_completion',
                          )
                        }
                        aria-label="Filter by status"
                      >
                        <option value="">All</option>
                        <option value="open">Active</option>
                        <option value="quote">Quote</option>
                        <option value="post_completion">Post-completion</option>
                        <option value="closed">Closed</option>
                        <option value="archived">Archived</option>
                      </select>
                    </label>
                  </div>
                </div>
              ) : null}
            </div>
            </div>
            <div className="mainMenuFilterRowRight">
              <button type="button" className="btn" onClick={() => void refreshCases()}>
                Refresh
              </button>
              <button type="button" className="btn" onClick={() => setShowNewMatter(true)}>
                New matter
              </button>
            </div>
          </div>
        </div>
        {showNewMatter ? (
          <NewMatterModal
            token={token}
            onClose={() => setShowNewMatter(false)}
            onCreated={async () => {
              setShowNewMatter(false)
              await refreshCases()
            }}
          />
        ) : null}
        <CasesTable
          cases={cases}
          users={caseListUsers}
          search={caseSearch}
          filterMatterType={filterMatterType}
          filterFeeEarnerUserId={filterFeeEarnerUserId}
          filterCaseStatus={filterCaseStatus}
          caseListFocusId={caseListFocusId}
          onCaseRowFocus={setCaseListFocusId}
          onSelect={(id) => {
            setCaseListFocusId(id)
            setSelectedCaseId(id)
            setView('case-menu')
          }}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={(k) => {
            if (k === sortKey) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
            else {
              setSortKey(k)
              setSortDir('asc')
            }
          }}
        />
      </div>
    )
  }, [
    token,
    view,
    casesErr,
    cases,
    selectedCaseId,
    caseDetail,
    notes,
    tasks,
    files,
    caseContacts,
    detailErr,
    caseSearch,
    filterMatterType,
    filterFeeEarnerUserId,
    filterCaseStatus,
    mainMenuMatterTypeOptions,
    mainMenuFilterOpen,
    mainMenuActiveFilterCount,
    sortKey,
    sortDir,
    showNewMatter,
    caseListFocusId,
    caseListUsers,
    taskMenuRows,
    taskMenuCaseFilter,
    taskMenuSearch,
    taskMenuFilterMatterType,
    taskMenuSortKey,
    taskMenuSortDir,
    tasksMenuFilterOpen,
    tasksMenuActiveFilterCount,
    tasksMenuMatterTypeOptions,
    refreshTaskMenu,
    auth.me,
    auth.refreshMe,
  ])

  useEffect(() => {
    if (auth.loading) {
      document.title = canaryDocumentTitle('Loading…')
      return
    }
    if (!auth.token) {
      document.title = canaryDocumentTitle('Sign in')
      return
    }
    document.title = canaryDocumentTitle(canaryViewTitleSegment(view, caseDetail))
  }, [auth.loading, auth.token, view, caseDetail])

  if (auth.loading) return <div className="center muted">Loading…</div>
  if (!auth.token) {
    return (
      <LoginForm
        onLogin={auth.login}
        error={auth.loginError}
        onClearError={auth.clearLoginError}
      />
    )
  }

  return (
    <div className="appShell">
      <header className="topbar">
        <div className="topbarMain">
          <nav className="topNav" aria-label="Primary">
            <button
              type="button"
              className={`navBtn ${view === 'main-menu' || view === 'case-menu' ? 'active' : ''}`}
              onClick={() => setView('main-menu')}
            >
              Main Menu
            </button>
            <button
              type="button"
              className="navBtn"
              title="Open e-mail"
              onClick={() => openCanaryEmailLauncher(auth.me)}
            >
              E-mail
            </button>
            <button type="button" className={`navBtn ${view === 'calendar' ? 'active' : ''}`} onClick={() => setView('calendar')}>
              Calendar
            </button>
            <button
              type="button"
              className={`navBtn ${view === 'tasks' ? 'active' : ''}`}
              onClick={() => setView('tasks')}
            >
              Tasks
            </button>
            <button type="button" className={`navBtn ${view === 'contacts' ? 'active' : ''}`} onClick={() => setView('contacts')}>
              Contacts
            </button>
            <button type="button" className={`navBtn ${view === 'reports' ? 'active' : ''}`} onClick={() => setView('reports')}>
              Reports
            </button>
            <button
              type="button"
              className={`navBtn ${view === 'user-settings' ? 'active' : ''}`}
              onClick={() => setView('user-settings')}
            >
              User Settings
            </button>
            {isAdmin ? (
              <button
                type="button"
                className={`navBtn ${view === 'admin-console' ? 'active' : ''}`}
                onClick={() => setView('admin-console')}
              >
                Admin settings
              </button>
            ) : null}
          </nav>
        </div>
        <div className="topbarRight">
          <div className="muted">{auth.me?.email}</div>
          <button type="button" className="btn" onClick={auth.logout}>
            Sign out
          </button>
        </div>
      </header>
      <main
        className={
          view === 'main-menu' || view === 'contacts' || view === 'tasks' || view === 'reports'
            ? 'main main--mainMenu'
            : 'main'
        }
      >
        {main}
      </main>
    </div>
  )
}

type NewMatterPendingClient = {
  contact_id: string
  name: string
  email?: string | null
  phone?: string | null
}

function NewMatterModal({
  token,
  onClose,
  onCreated,
}: {
  token: string
  onClose: () => void
  onCreated: () => void
}) {
  const { askConfirm } = useDialogs()
  const [matterDescription, setMatterDescription] = useState('')
  const [practiceArea, setPracticeArea] = useState('')
  const [feeEarner, setFeeEarner] = useState<string>('')
  /** Active = open; Quote = quote (only these may be set on create). */
  const [newMatterStatus, setNewMatterStatus] = useState<'open' | 'quote'>('open')
  const [step, setStep] = useState<'details' | 'contacts'>('details')
  const [users, setUsers] = useState<UserSummary[]>([])
  const [matterHeadTypes, setMatterHeadTypes] = useState<MatterHeadTypeOut[]>([])
  const [contacts, setContacts] = useState<ContactOut[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [contactSearch, setContactSearch] = useState('')
  const [selectedGlobalContactId, setSelectedGlobalContactId] = useState<string | null>(null)
  const [contactErr, setContactErr] = useState<string | null>(null)
  /** Client contacts to link after the matter is created (Finish). */
  const [pendingClientLinks, setPendingClientLinks] = useState<NewMatterPendingClient[]>([])
  const [newContactFormKey, setNewContactFormKey] = useState(0)

  const hasClientOnMatter = pendingClientLinks.length > 0

  useEffect(() => {
    let cancelled = false
    async function loadUsers() {
      try {
        const data = await apiFetch<UserSummary[]>('/users', { token })
        if (!cancelled) setUsers((Array.isArray(data) ? data : []).filter((u) => u.is_active))
      } catch {
        // ignore; keep dropdown empty
      }
    }
    void loadUsers()
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    let cancelled = false
    async function loadMatterTypes() {
      try {
        const data = await apiFetch<MatterHeadTypeOut[]>('/matter-types', { token })
        if (!cancelled) setMatterHeadTypes(data)
      } catch {
        // ignore; keep dropdown empty
      }
    }
    void loadMatterTypes()
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (step !== 'contacts') return
    let cancelled = false
    async function loadContacts() {
      try {
        const data = await apiFetch<ContactOut[]>('/contacts', { token })
        if (!cancelled) setContacts(data)
      } catch {
        // ignore
      }
    }
    void loadContacts()
    return () => {
      cancelled = true
    }
  }, [step, token])

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modal card modal--scrollBody">
        <div className="paneHead">
          <div>
            <h2>New matter</h2>
            <div className="muted">Reference is generated automatically.</div>
          </div>
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <div className="modalBodyScroll">
        {step === 'details' ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <label className="field">
            <span>Matter type</span>
            <select
              value={practiceArea}
              onChange={(e) => {
                const id = e.target.value
                setPracticeArea(id)
                // Pre-fill Description with the sub type's prefix (if configured)
                const sub = matterHeadTypes.flatMap((h) => h.sub_types).find((s) => s.id === id)
                setMatterDescription(sub?.prefix ?? '')
              }}
              disabled={busy}
            >
              <option value="">— select —</option>
              {matterHeadTypes.map((head) => (
                <optgroup key={head.id} label={head.name}>
                  {head.sub_types.map((sub) => (
                    <option key={sub.id} value={sub.id}>{sub.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Description</span>
            <input
              value={matterDescription}
              onChange={(e) => setMatterDescription(e.target.value)}
              disabled={busy}
            />
          </label>
          <div className="field">
            <span>Status</span>
            <div className="row" style={{ gap: 20, marginTop: 6, flexWrap: 'wrap' }}>
              <label className="row" style={{ gap: 8, cursor: busy ? 'default' : 'pointer' }}>
                <input
                  type="radio"
                  name="new-matter-status"
                  checked={newMatterStatus === 'open'}
                  onChange={() => setNewMatterStatus('open')}
                  disabled={busy}
                />
                <span>Active</span>
              </label>
              <label className="row" style={{ gap: 8, cursor: busy ? 'default' : 'pointer' }}>
                <input
                  type="radio"
                  name="new-matter-status"
                  checked={newMatterStatus === 'quote'}
                  onChange={() => setNewMatterStatus('quote')}
                  disabled={busy}
                />
                <span>Quote</span>
              </label>
            </div>
          </div>
          <label className="field">
            <span>Fee earner</span>
            <select
              value={feeEarner}
              onChange={(e) => setFeeEarner(e.target.value)}
              disabled={busy}
            >
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name} ({u.email})
                </option>
              ))}
            </select>
          </label>
          {err ? <div className="error">{err}</div> : null}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={busy || !matterDescription.trim() || !practiceArea}
              onClick={() => {
                setErr(null)
                setContactErr(null)
                setStep('contacts')
              }}
            >
              Continue
            </button>
          </div>
        </div>
        ) : null}

        {step === 'contacts' ? (
          <div className="card" style={{ marginTop: 12, padding: 12 }}>
            <div className="paneHead" style={{ padding: 0, marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>Contacts</h2>
                <div className="muted">Link at least one client contact, then finish to create the matter.</div>
              </div>
              <button className="btn" onClick={() => setStep('details')} disabled={busy}>
                Back
              </button>
            </div>

            <div className="stack">
              <div className="muted">Clients for this matter (you can add more than one):</div>
              <div className="list" style={{ maxHeight: 140, overflow: 'auto' }}>
                {pendingClientLinks.map((cc) => (
                  <div key={cc.contact_id} className="listCard row" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <div className="listTitle">
                        {cc.name} <span className="muted">· {matterContactTypeLabel('client')}</span>
                      </div>
                      <div className="muted">{cc.email ?? cc.phone ?? '—'}</div>
                    </div>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={async () => {
                        const ok = await askConfirm({
                          title: 'Remove contact',
                          message: 'Remove this contact from the list?',
                          danger: true,
                          confirmLabel: 'Remove',
                        })
                        if (!ok) return
                        setContactErr(null)
                        setPendingClientLinks((prev) => prev.filter((p) => p.contact_id !== cc.contact_id))
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {pendingClientLinks.length === 0 ? <div className="muted">None added yet.</div> : null}
              </div>

              <label className="field">
                <span>Search existing global contacts</span>
                <input value={contactSearch} onChange={(e) => setContactSearch(e.target.value)} />
              </label>

              <div className="list" style={{ maxHeight: 160, overflow: 'auto' }}>
                {contacts
                  .filter((c) => {
                    const s = contactSearch.trim().toLowerCase()
                    if (!s) return true
                    return (
                      c.name.toLowerCase().includes(s) ||
                      (c.email ?? '').toLowerCase().includes(s) ||
                      (c.phone ?? '').toLowerCase().includes(s)
                    )
                  })
                  .slice(0, 25)
                  .map((c) => (
                    <div key={c.id} className="listCard row" style={{ justifyContent: 'space-between' }}>
                      <div>
                        <div className="listTitle">
                          {c.name} <span className="muted">· {c.type}</span>
                        </div>
                        <div className="muted">{c.email ?? c.phone ?? '—'}</div>
                      </div>
                      <button
                        className={`btn ${selectedGlobalContactId === c.id ? 'primary' : ''}`}
                        disabled={busy || pendingClientLinks.some((p) => p.contact_id === c.id)}
                        onClick={() => setSelectedGlobalContactId(c.id)}
                      >
                        {pendingClientLinks.some((p) => p.contact_id === c.id)
                          ? 'Added'
                          : selectedGlobalContactId === c.id
                            ? 'Selected'
                            : 'Select'}
                      </button>
                    </div>
                  ))}
                {contacts.length === 0 ? <div className="muted">No contacts yet.</div> : null}
              </div>

              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button
                  className="btn primary"
                  disabled={
                    busy ||
                    !selectedGlobalContactId ||
                    pendingClientLinks.some((p) => p.contact_id === selectedGlobalContactId)
                  }
                  onClick={() => {
                    if (!selectedGlobalContactId) return
                    const c = contacts.find((x) => x.id === selectedGlobalContactId)
                    if (!c) return
                    setContactErr(null)
                    setErr(null)
                    setPendingClientLinks((prev) => [
                      ...prev,
                      {
                        contact_id: c.id,
                        name: c.name,
                        email: c.email,
                        phone: c.phone,
                      },
                    ])
                    setSelectedGlobalContactId(null)
                  }}
                >
                  Link as client
                </button>
              </div>

              <div className="card" style={{ padding: 12 }}>
                <GlobalContactCreateForm
                  key={newContactFormKey}
                  busy={busy}
                  submitLabel="Create & add as client"
                  intro={
                    <div className="muted" style={{ marginBottom: 8 }}>
                      Create new contact and add as client for this matter
                    </div>
                  }
                  onSubmit={async (payload) => {
                    setBusy(true)
                    setContactErr(null)
                    setErr(null)
                    try {
                      const created = await apiFetch<ContactOut>('/contacts', {
                        token,
                        method: 'POST',
                        json: payload,
                      })
                      setContacts((prev) => {
                        const without = prev.filter((x) => x.id !== created.id)
                        return [created, ...without]
                      })
                      setPendingClientLinks((prev) => [
                        ...prev,
                        {
                          contact_id: created.id,
                          name: created.name,
                          email: created.email,
                          phone: created.phone,
                        },
                      ])
                      setNewContactFormKey((k) => k + 1)
                    } catch (e: any) {
                      setContactErr(e?.message ?? 'Failed to create contact')
                      throw e
                    } finally {
                      setBusy(false)
                    }
                  }}
                />
              </div>

              {err ? <div className="error">{err}</div> : null}
              {contactErr ? <div className="error">{contactErr}</div> : null}
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                <button
                  className="btn primary"
                  disabled={busy || !hasClientOnMatter}
                  onClick={async () => {
                    if (!hasClientOnMatter) return
                    setBusy(true)
                    setErr(null)
                    setContactErr(null)
                    try {
                      const created = await apiFetch<CaseOut>('/cases', {
                        token,
                        json: {
                          matter_description: matterDescription.trim(),
                          matter_sub_type_id: practiceArea || null,
                          status: newMatterStatus,
                        },
                      })
                      if (feeEarner) {
                        await apiFetch(`/cases/${created.id}`, {
                          token,
                          method: 'PATCH',
                          json: { fee_earner_user_id: feeEarner || null },
                        })
                      }
                      for (const p of pendingClientLinks) {
                        await apiFetch(`/cases/${created.id}/contacts`, {
                          token,
                          json: {
                            contact_id: p.contact_id,
                            matter_contact_type: 'client',
                            matter_contact_reference: null,
                          },
                        })
                      }
                      onCreated()
                    } catch (e: any) {
                      setErr(e?.message ?? 'Could not create matter')
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  Finish
                </button>
              </div>
            </div>
          </div>
        ) : null}
        </div>
      </div>
    </div>
  )
}

function matterTypeLabel(c: CaseOut): string {
  const parts = [c.matter_head_type_name, c.matter_sub_type_name].filter(Boolean)
  return parts.length ? parts.join(' · ') : '—'
}

function feeEarnerLabel(c: CaseOut, users: UserSummary[]) {
  const u = users.find((x) => x.id === c.fee_earner_user_id)
  return u?.display_name ?? '—'
}

function CasesTable({
  cases,
  users,
  search,
  filterMatterType,
  filterFeeEarnerUserId,
  filterCaseStatus,
  caseListFocusId,
  onCaseRowFocus,
  onSelect,
  sortKey,
  sortDir,
  onSort,
}: {
  cases: CaseOut[]
  users: UserSummary[]
  search: string
  filterMatterType: string
  filterFeeEarnerUserId: string
  filterCaseStatus: '' | 'open' | 'closed' | 'archived' | 'quote' | 'post_completion'
  caseListFocusId: string | null
  onCaseRowFocus: (id: string | null) => void
  onSelect: (id: string) => void
  sortKey: 'reference' | 'client' | 'matter' | 'feeEarner' | 'status' | 'created'
  sortDir: 'asc' | 'desc'
  onSort: (k: 'reference' | 'client' | 'matter' | 'feeEarner' | 'status' | 'created') => void
}) {
  const [caseCtx, setCaseCtx] = useState<null | { id: string; x: number; y: number }>(null)
  const caseCtxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!caseCtx) return
    function handleMouseDown(e: MouseEvent) {
      const t = e.target as Node
      if (caseCtxRef.current?.contains(t)) return
      setCaseCtx(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [caseCtx])

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase()
    let filtered = cases
    if (s) {
      filtered = filtered.filter((c) => {
        const fe = feeEarnerLabel(c, users)
        const parts = [c.case_number, c.client_name ?? '', c.matter_description ?? '', c.status, fe]
        return parts.join(' ').toLowerCase().includes(s)
      })
    }
    if (filterMatterType) {
      filtered = filtered.filter((c) => matterTypeLabel(c) === filterMatterType)
    }
    if (filterFeeEarnerUserId) {
      filtered = filtered.filter((c) => c.fee_earner_user_id === filterFeeEarnerUserId)
    }
    if (filterCaseStatus) {
      filtered = filtered.filter((c) => c.status === filterCaseStatus)
    }
    const dir = sortDir === 'asc' ? 1 : -1
    const key = sortKey
    const sorted = [...filtered].sort((a, b) => {
      const av =
        key === 'reference'
          ? a.case_number
          : key === 'client'
            ? a.client_name ?? ''
            : key === 'matter'
              ? a.matter_description ?? ''
              : key === 'feeEarner'
                ? feeEarnerLabel(a, users)
                : key === 'status'
                  ? a.status
                  : key === 'created'
                    ? a.created_at
                    : ''
      const bv =
        key === 'reference'
          ? b.case_number
          : key === 'client'
            ? b.client_name ?? ''
            : key === 'matter'
              ? b.matter_description ?? ''
              : key === 'feeEarner'
                ? feeEarnerLabel(b, users)
                : key === 'status'
                  ? b.status
                  : key === 'created'
                    ? b.created_at
                    : ''
      return String(av).localeCompare(String(bv)) * dir
    })
    return sorted
  }, [
    cases,
    users,
    search,
    filterMatterType,
    filterFeeEarnerUserId,
    filterCaseStatus,
    sortKey,
    sortDir,
  ])

  return (
    <div className="card casesTableCard" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="casesTableScroll">
        <div className="table">
        <div className="tr th" style={{ gridTemplateColumns: MAIN_MENU_CASES_TABLE_GRID }}>
          {(
            [
              ['reference', 'Reference'],
              ['client', 'Client name'],
              ['matter', 'Description'],
              ['feeEarner', 'Fee earner'],
              ['status', 'Status'],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="thCell">
              <button type="button" className="thbtn" onClick={() => onSort(k)}>
                {label}
              </button>
            </div>
          ))}
        </div>
        {rows.map((c) => {
          const rowActive = caseListFocusId === c.id
          const rowInactive = c.status === 'closed' || c.status === 'archived'
          return (
            <button
              key={c.id}
              type="button"
              className={['tr', 'rowbtn', rowActive ? 'active' : '', rowInactive ? 'casesRowInactive' : '']
                .filter(Boolean)
                .join(' ')}
              style={{ gridTemplateColumns: MAIN_MENU_CASES_TABLE_GRID }}
              onClick={() => onCaseRowFocus(c.id)}
              onDoubleClick={() => onSelect(c.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCaseCtx({ id: c.id, x: e.clientX, y: e.clientY })
              }}
            >
              <div className="td mono" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {caseHasRevokedUserAccess(c) ? (
                  <span title="Access restricted for some users" aria-hidden style={{ opacity: 0.85 }}>
                    🔒
                  </span>
                ) : null}
                {c.case_number}
              </div>
              <div className="td">{c.client_name ?? '—'}</div>
              <div className="td">{c.matter_description}</div>
              <div className="td">{feeEarnerLabel(c, users)}</div>
              <div className="td">
                {formatCaseStatusLabel(c.status)}
              </div>
            </button>
          )
        })}
        {rows.length === 0 ? <div className="muted" style={{ padding: 12 }}>No cases match.</div> : null}
        </div>
      </div>
      {caseCtx ? (
        <div
          ref={caseCtxRef}
          className="docContextMenu"
          style={{ left: caseCtx.x, top: caseCtx.y, zIndex: 30 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="docContextItem"
            role="menuitem"
            tabIndex={0}
            onClick={() => {
              const id = caseCtx.id
              setCaseCtx(null)
              onSelect(id)
            }}
          >
            Open
          </div>
        </div>
      ) : null}
    </div>
  )
}

const TASK_PRI_ORDER: Record<string, number> = { high: 2, normal: 1, low: 0 }

function priorityLabel(p: string): string {
  if (p === 'high') return 'High'
  if (p === 'low') return 'Low'
  return 'Normal'
}

function TasksTable({
  token,
  currentUserId,
  users,
  rows,
  search,
  filterMatterType,
  onSelectCase,
  sortKey,
  sortDir,
  onSort,
  onInvalidate,
}: {
  token: string
  currentUserId: string
  users: UserSummary[]
  rows: TaskMenuRow[]
  search: string
  filterMatterType: string
  onSelectCase: (caseId: string) => void
  sortKey: 'reference' | 'client' | 'matter' | 'task' | 'date' | 'assigned' | 'priority'
  sortDir: 'asc' | 'desc'
  onSort: (k: 'reference' | 'client' | 'matter' | 'task' | 'date' | 'assigned' | 'priority') => void
  onInvalidate: () => void
}) {
  const { askConfirm } = useDialogs()
  const [ctx, setCtx] = useState<null | { x: number; y: number; row: TaskMenuRow }>(null)
  const taskCtxRef = useRef<HTMLDivElement | null>(null)
  const [editRow, setEditRow] = useState<TaskMenuRow | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDue, setEditDue] = useState('')
  const [editAssign, setEditAssign] = useState('')
  const [editPriority, setEditPriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [editCompleted, setEditCompleted] = useState(false)
  const [editPrivate, setEditPrivate] = useState(false)
  const [editCreatedBy, setEditCreatedBy] = useState('')
  const [editBaseline, setEditBaseline] = useState<{
    title: string
    due: string
    assign: string
    priority: 'low' | 'normal' | 'high'
    completed: boolean
    isPrivate: boolean
  } | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [editErr, setEditErr] = useState<string | null>(null)
  const [taskRowFocusId, setTaskRowFocusId] = useState<string | null>(null)
  const visible = useMemo(() => {
    const s = search.trim().toLowerCase()
    let filtered = rows
    if (s) {
      filtered = filtered.filter((r) => {
        const parts = [
          r.case_number,
          r.client_name ?? '',
          r.matter_description ?? '',
          r.task_title,
          r.date,
          formatTaskMenuDate(r.date),
          r.assigned_display_name ?? '',
          r.priority,
          r.status,
          r.is_private ? 'private' : '',
        ]
        return parts.join(' ').toLowerCase().includes(s)
      })
    }
    if (filterMatterType) {
      filtered = filtered.filter((r) => r.matter_type_label === filterMatterType)
    }
    const dir = sortDir === 'asc' ? 1 : -1
    const sorted = [...filtered].sort((a, b) => {
      const key = sortKey
      if (key === 'priority') {
        const pa = TASK_PRI_ORDER[a.priority] ?? 1
        const pb = TASK_PRI_ORDER[b.priority] ?? 1
        if (pa !== pb) return (pa - pb) * -dir
        return (new Date(a.date).getTime() - new Date(b.date).getTime()) * dir
      }
      const av =
        key === 'reference'
          ? a.case_number
          : key === 'client'
            ? a.client_name ?? ''
            : key === 'matter'
              ? a.matter_description ?? ''
              : key === 'task'
                ? a.task_title
                : key === 'date'
                  ? a.date
                  : a.assigned_display_name ?? ''
      const bv =
        key === 'reference'
          ? b.case_number
          : key === 'client'
            ? b.client_name ?? ''
            : key === 'matter'
              ? b.matter_description ?? ''
              : key === 'task'
                ? b.task_title
                : key === 'date'
                  ? b.date
                  : b.assigned_display_name ?? ''
      const c = String(av).localeCompare(String(bv)) * dir
      if (c !== 0) return c
      const pa = TASK_PRI_ORDER[a.priority] ?? 1
      const pb = TASK_PRI_ORDER[b.priority] ?? 1
      if (pa !== pb) return pb - pa
      return new Date(a.date).getTime() - new Date(b.date).getTime()
    })
    return sorted
  }, [rows, search, filterMatterType, sortKey, sortDir])

  useEffect(() => {
    if (!ctx) return
    function handleMouseDown(e: MouseEvent) {
      const t = e.target as Node
      if (taskCtxRef.current?.contains(t)) return
      setCtx(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [ctx])

  async function openEdit(r: TaskMenuRow) {
    setEditErr(null)
    setEditRow(r)
    setEditBusy(true)
    try {
      const list = await apiFetch<CaseTaskOut[]>(`/cases/${r.case_id}/tasks`, { token })
      const t = list.find((x) => x.id === r.id)
      const title = (t?.title ?? r.task_title).trim()
      const dueRaw = t?.due_at ?? r.date
      const due = dueRaw.slice(0, 10)
      const assign = t?.assigned_to_user_id ?? ''
      const pri = (t?.priority ?? r.priority ?? 'normal') as 'low' | 'normal' | 'high'
      const completed = (t?.status ?? r.status) === 'done'
      const priv = Boolean(t?.is_private)
      const createdBy = t?.created_by_user_id ?? ''
      setEditTitle(title)
      setEditDue(due)
      setEditAssign(assign)
      setEditPriority(pri)
      setEditCompleted(completed)
      setEditPrivate(priv)
      setEditCreatedBy(createdBy)
      setEditBaseline({ title, due, assign, priority: pri, completed, isPrivate: priv })
    } catch {
      const due = r.date.slice(0, 10)
      const pri = (r.priority ?? 'normal') as 'low' | 'normal' | 'high'
      const completed = r.status === 'done'
      const priv = Boolean(r.is_private)
      setEditTitle(r.task_title)
      setEditDue(due)
      setEditAssign('')
      setEditPriority(pri)
      setEditCompleted(completed)
      setEditPrivate(priv)
      setEditCreatedBy('')
      setEditBaseline({
        title: r.task_title,
        due,
        assign: '',
        priority: pri,
        completed,
        isPrivate: priv,
      })
    } finally {
      setEditBusy(false)
    }
  }

  function discardTaskEdit() {
    if (editBaseline) {
      setEditTitle(editBaseline.title)
      setEditDue(editBaseline.due)
      setEditAssign(editBaseline.assign)
      setEditPriority(editBaseline.priority)
      setEditCompleted(editBaseline.completed)
      setEditPrivate(editBaseline.isPrivate)
    }
    setEditRow(null)
    setEditErr(null)
  }

  async function saveEdit() {
    if (!editRow) return
    setEditBusy(true)
    setEditErr(null)
    try {
      const due = new Date(`${editDue}T12:00:00`)
      const patch: Record<string, unknown> = {
        title: editTitle.trim(),
        due_at: due.toISOString(),
        priority: editPriority,
        assigned_to_user_id: editAssign || null,
        status: editCompleted ? 'done' : 'open',
      }
      if (currentUserId && editCreatedBy === currentUserId) {
        patch.is_private = editPrivate
      }
      await apiFetch(`/cases/${editRow.case_id}/tasks/${editRow.id}`, {
        token,
        method: 'PATCH',
        json: patch,
      })
      setEditRow(null)
      setEditBaseline(null)
      onInvalidate()
    } catch (e: any) {
      setEditErr(e?.message ?? 'Failed to update task')
    } finally {
      setEditBusy(false)
    }
  }

  async function markComplete(r: TaskMenuRow) {
    try {
      await apiFetch(`/cases/${r.case_id}/tasks/${r.id}`, {
        token,
        method: 'PATCH',
        json: { status: 'done' },
      })
      onInvalidate()
    } catch {
      // ignore
    }
  }

  async function deleteTask(r: TaskMenuRow) {
    const ok = await askConfirm({
      title: 'Delete task',
      message: 'Delete this task permanently?',
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await apiFetch(`/cases/${r.case_id}/tasks/${r.id}`, { token, method: 'DELETE' })
      onInvalidate()
    } catch {
      // ignore
    }
  }

  return (
    <div className="card casesTableCard" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="casesTableScroll tasksTableScroll">
        <div className="table">
          <div className="tr th" style={{ gridTemplateColumns: TASKS_MENU_TABLE_GRID }}>
            {(
              [
                ['date', 'Date'],
                ['priority', 'Priority'],
                ['assigned', 'Assigned'],
                ['task', 'Task'],
                ['matter', 'Description'],
                ['client', 'Client name'],
                ['reference', 'Reference'],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="thCell">
                <button type="button" className="thbtn" onClick={() => onSort(k)}>
                  {label}
                </button>
              </div>
            ))}
          </div>
          {visible.map((r) => {
            const rowCls =
              r.status === 'done'
                ? 'taskMenuRow--done'
                : (r.priority ?? 'normal') === 'high'
                  ? 'taskMenuRow--high'
                  : ''
            const rowActive = taskRowFocusId === r.id
            return (
              <button
                key={r.id}
                type="button"
                className={`tr rowbtn taskMenuRow ${rowCls} ${rowActive ? 'active' : ''}`}
                style={{ gridTemplateColumns: TASKS_MENU_TABLE_GRID }}
                onClick={() => setTaskRowFocusId(r.id)}
                onDoubleClick={() => onSelectCase(r.case_id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCtx({ x: e.clientX, y: e.clientY, row: r })
                }}
              >
                <div className="td">{formatTaskMenuDate(r.date)}</div>
                <div className="td">{priorityLabel(r.priority ?? 'normal')}</div>
                <div className="td">{r.assigned_display_name ?? '—'}</div>
                <div className="td">
                  {r.task_title}
                  {r.is_private ? <span className="muted"> (private)</span> : null}
                </div>
                <div className="td">{r.matter_description ?? '—'}</div>
                <div className="td">{r.client_name ?? '—'}</div>
                <div className="td mono">{r.case_number}</div>
              </button>
            )
          })}
          {visible.length === 0 ? (
            <div className="muted" style={{ padding: 12 }}>
              No tasks to show yet.
            </div>
          ) : null}
        </div>
      </div>
      {ctx ? (
        <div
          ref={taskCtxRef}
          className="docContextMenu"
          style={{ left: ctx.x, top: ctx.y, zIndex: 30 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="docContextItem"
            role="menuitem"
            tabIndex={0}
            onClick={() => {
              const r = ctx.row
              setCtx(null)
              onSelectCase(r.case_id)
            }}
          >
            Open
          </div>
          <div
            className="docContextItem"
            role="menuitem"
            tabIndex={0}
            onClick={() => {
              const r = ctx.row
              setCtx(null)
              void openEdit(r)
            }}
          >
            Edit…
          </div>
          <div
            className="docContextItem"
            role="menuitem"
            tabIndex={0}
            onClick={() => {
              const r = ctx.row
              setCtx(null)
              void markComplete(r)
            }}
          >
            Mark as complete
          </div>
          <div
            className="docContextItem"
            role="menuitem"
            tabIndex={0}
            onClick={() => {
              const r = ctx.row
              setCtx(null)
              void deleteTask(r)
            }}
          >
            Delete
          </div>
        </div>
      ) : null}
      {editRow ? (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="task-edit-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !editBusy) discardTaskEdit()
          }}
        >
          <div className="modal card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="paneHead">
              <h2 id="task-edit-title" style={{ margin: 0, fontSize: 18 }}>
                Edit task
              </h2>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" disabled={editBusy} onClick={discardTaskEdit}>
                  Discard changes
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' }}
                  disabled={editBusy}
                  onClick={() => void saveEdit()}
                >
                  {editBusy ? 'Saving…' : 'Save and close'}
                </button>
              </div>
            </div>
            <div className="stack" style={{ marginTop: 12, gap: 12 }}>
              {editErr ? <div className="error">{editErr}</div> : null}
              <label className="field">
                <span>Title</span>
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} disabled={editBusy} />
              </label>
              <label className="field">
                <span>Due date</span>
                <input type="date" value={editDue} onChange={(e) => setEditDue(e.target.value)} disabled={editBusy} />
              </label>
              <label className="field">
                <span>Priority</span>
                <select
                  value={editPriority}
                  disabled={editBusy}
                  onChange={(e) => setEditPriority(e.target.value as 'low' | 'normal' | 'high')}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label className="field">
                <span>Assigned to</span>
                <select value={editAssign} disabled={editBusy} onChange={(e) => setEditAssign(e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {users
                    .filter((u) => u.is_active)
                    .slice()
                    .sort((a, b) => a.display_name.localeCompare(b.display_name))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.display_name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={editCompleted}
                  disabled={editBusy}
                  onChange={(e) => setEditCompleted(e.target.checked)}
                />
                <span>Completed</span>
              </label>
              {currentUserId && editCreatedBy === currentUserId ? (
                <label className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={editPrivate}
                    disabled={editBusy}
                    onChange={(e) => setEditPrivate(e.target.checked)}
                  />
                  <span>
                    Private — only you and the assignee (if any) can see this task on the matter.
                  </span>
                </label>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}


function AdminMatters({ token }: { token: string }) {
  const { askConfirm } = useDialogs()
  const [heads, setHeads] = useState<MatterHeadTypeOut[]>([])
  const [selectedHeadId, setSelectedHeadId] = useState<string | null>(null)
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [subPrecCats, setSubPrecCats] = useState<PrecedentCategoryOut[]>([])
  const [newPrecCatName, setNewPrecCatName] = useState('')

  // Head type form state
  const [newHeadName, setNewHeadName] = useState('')
  const [editingHeadId, setEditingHeadId] = useState<string | null>(null)
  const [editingHeadName, setEditingHeadName] = useState('')

  // Sub type form state
  const [newSubName, setNewSubName] = useState('')
  const [editingSubId, setEditingSubId] = useState<string | null>(null)
  const [editingSubName, setEditingSubName] = useState('')

  // Sub type config state (prefix + menus)
  const [prefixInput, setPrefixInput] = useState('')
  const [newMenuName, setNewMenuName] = useState('')
  const [editingMenuId, setEditingMenuId] = useState<string | null>(null)
  const [editingMenuName, setEditingMenuName] = useState('')

  async function loadHeads() {
    try {
      const data = await apiFetch<MatterHeadTypeOut[]>('/matter-types', { token })
      setHeads(data)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load matter types')
    }
  }

  useEffect(() => { void loadHeads() }, [token])

  useEffect(() => {
    if (!selectedSubId) {
      setSubPrecCats([])
      return
    }
    void apiFetch<PrecedentCategoryOut[]>(`/matter-types/sub-types/${selectedSubId}/precedent-categories`, { token })
      .then(setSubPrecCats)
      .catch(() => setSubPrecCats([]))
  }, [selectedSubId, token])

  const selectedHead = heads.find((h) => h.id === selectedHeadId) ?? null
  const selectedSub: MatterSubTypeOut | null =
    selectedHead?.sub_types.find((s) => s.id === selectedSubId) ?? null

  // Sync prefix input when selected sub changes
  useEffect(() => {
    setPrefixInput(selectedSub?.prefix ?? '')
    setNewPrecCatName('')
    setNewMenuName('')
    setEditingMenuId(null)
  }, [selectedSubId, selectedHead])

  // Clear sub selection when head changes
  useEffect(() => {
    setSelectedSubId(null)
  }, [selectedHeadId])

  const smallBtn = { padding: '3px 8px', fontSize: '0.82em' } as const
  const inlineInput = { flex: 1, width: 'auto' } as const

  // ── Head type actions ────────────────────────────────────────────────────

  async function addHead() {
    if (!newHeadName.trim()) return
    setBusy(true); setErr(null)
    try {
      await apiFetch('/matter-types/heads', { token, json: { name: newHeadName.trim() } })
      setNewHeadName('')
      await loadHeads()
    } catch (e: any) { setErr(e?.message ?? 'Failed') } finally { setBusy(false) }
  }

  async function saveHeadRename(id: string) {
    if (!editingHeadName.trim()) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/matter-types/heads/${id}`, { token, method: 'PATCH', json: { name: editingHeadName.trim() } })
      setEditingHeadId(null)
      await loadHeads()
    } catch (e: any) { setErr(e?.message ?? 'Failed') } finally { setBusy(false) }
  }

  async function deleteHead(id: string) {
    const ok = await askConfirm({
      title: 'Delete head type',
      message: 'Delete this head type and all its sub types?',
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/matter-types/heads/${id}`, { token, method: 'DELETE' })
      if (selectedHeadId === id) setSelectedHeadId(null)
      await loadHeads()
    } catch (e: any) { setErr(e?.message ?? 'Failed') } finally { setBusy(false) }
  }

  // ── Sub type actions ─────────────────────────────────────────────────────

  async function addSub() {
    if (!newSubName.trim() || !selectedHeadId) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/matter-types/heads/${selectedHeadId}/sub-types`, { token, json: { name: newSubName.trim() } })
      setNewSubName('')
      await loadHeads()
    } catch (e: any) { setErr(e?.message ?? 'Failed') } finally { setBusy(false) }
  }

  async function saveSubRename(id: string) {
    if (!editingSubName.trim()) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/matter-types/sub-types/${id}`, { token, method: 'PATCH', json: { name: editingSubName.trim() } })
      setEditingSubId(null)
      await loadHeads()
    } catch (e: any) { setErr(e?.message ?? 'Failed') } finally { setBusy(false) }
  }

  async function deleteSub(id: string) {
    const ok = await askConfirm({
      title: 'Delete sub type',
      message: 'Delete this sub type?',
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/matter-types/sub-types/${id}`, { token, method: 'DELETE' })
      if (selectedSubId === id) setSelectedSubId(null)
      await loadHeads()
    } catch (e: any) { setErr(e?.message ?? 'Failed') } finally { setBusy(false) }
  }

  // ── Prefix action ────────────────────────────────────────────────────────

  async function savePrefix() {
    if (!selectedSubId) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/matter-types/sub-types/${selectedSubId}`, {
        token, method: 'PATCH', json: { prefix: prefixInput.trim() || null },
      })
      await loadHeads()
    } catch (e: any) { setErr(e?.message ?? 'Failed') } finally { setBusy(false) }
  }

  // ── Menu actions ─────────────────────────────────────────────────────────

  async function addMenu() {
    if (!newMenuName.trim() || !selectedSubId) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/matter-types/sub-types/${selectedSubId}/menus`, { token, json: { name: newMenuName.trim() } })
      setNewMenuName('')
      await loadHeads()
    } catch (e: any) { setErr(e?.message ?? 'Failed') } finally { setBusy(false) }
  }

  async function saveMenuRename(id: string) {
    if (!editingMenuName.trim()) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/matter-types/menus/${id}`, { token, method: 'PATCH', json: { name: editingMenuName.trim() } })
      setEditingMenuId(null)
      await loadHeads()
    } catch (e: any) { setErr(e?.message ?? 'Failed') } finally { setBusy(false) }
  }

  async function deleteMenu(id: string) {
    const ok = await askConfirm({
      title: 'Remove menu',
      message: 'Remove this menu?',
      danger: true,
      confirmLabel: 'Remove',
    })
    if (!ok) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/matter-types/menus/${id}`, { token, method: 'DELETE' })
      await loadHeads()
    } catch (e: any) { setErr(e?.message ?? 'Failed') } finally { setBusy(false) }
  }

  return (
    <div className="stack">
      {err ? <div className="error">{err}</div> : null}

      {/* ── Row 1: head types + sub types ─────────────────────────── */}
      <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>

        {/* Head matter types */}
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Head matter types</h3>
          <div className="list">
            {heads.map((h) => (
              <div
                key={h.id}
                className="listCard row"
                style={{
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  background: selectedHeadId === h.id ? 'rgba(37,99,235,0.1)' : undefined,
                }}
                onClick={() => setSelectedHeadId(h.id)}
              >
                {editingHeadId === h.id ? (
                  <input
                    style={inlineInput}
                    value={editingHeadName}
                    onChange={(e) => setEditingHeadName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveHeadRename(h.id); if (e.key === 'Escape') setEditingHeadId(null) }}
                    autoFocus
                    disabled={busy}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="listTitle">{h.name}</span>
                )}
                <div className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                  {editingHeadId === h.id ? (
                    <>
                      <button className="btn" style={smallBtn} disabled={busy} onClick={() => void saveHeadRename(h.id)}>Save</button>
                      <button className="btn" style={smallBtn} disabled={busy} onClick={() => setEditingHeadId(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className="btn" style={smallBtn} disabled={busy} onClick={() => { setEditingHeadId(h.id); setEditingHeadName(h.name) }}>Rename</button>
                      <button className="btn danger" style={smallBtn} disabled={busy} onClick={() => void deleteHead(h.id)}>Delete</button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {heads.length === 0 && <div className="muted" style={{ padding: '6px 0' }}>No head types yet.</div>}
          </div>
          <div className="row" style={{ marginTop: 10, gap: 6 }}>
            <input
              style={inlineInput}
              placeholder="New head type name…"
              value={newHeadName}
              onChange={(e) => setNewHeadName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addHead() }}
              disabled={busy}
            />
            <button className="btn primary" disabled={busy || !newHeadName.trim()} onClick={() => void addHead()}>Add</button>
          </div>
        </div>

        {/* Sub matter types */}
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>
            Sub matter types{selectedHead ? ` — ${selectedHead.name}` : ''}
          </h3>
          {!selectedHead ? (
            <div className="muted">Select a head type on the left to manage its sub types.</div>
          ) : (
            <>
              <div className="list">
                {selectedHead.sub_types.map((s) => (
                  <div
                    key={s.id}
                    className="listCard row"
                    style={{
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      background: selectedSubId === s.id ? 'rgba(37,99,235,0.1)' : undefined,
                    }}
                    onClick={() => setSelectedSubId(s.id)}
                  >
                    {editingSubId === s.id ? (
                      <input
                        style={inlineInput}
                        value={editingSubName}
                        onChange={(e) => setEditingSubName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void saveSubRename(s.id); if (e.key === 'Escape') setEditingSubId(null) }}
                        autoFocus
                        disabled={busy}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="listTitle">{s.name}</span>
                    )}
                    <div className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                      {editingSubId === s.id ? (
                        <>
                          <button className="btn" style={smallBtn} disabled={busy} onClick={() => void saveSubRename(s.id)}>Save</button>
                          <button className="btn" style={smallBtn} disabled={busy} onClick={() => setEditingSubId(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button className="btn" style={smallBtn} disabled={busy} onClick={() => { setEditingSubId(s.id); setEditingSubName(s.name) }}>Rename</button>
                          <button className="btn danger" style={smallBtn} disabled={busy} onClick={() => void deleteSub(s.id)}>Delete</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {selectedHead.sub_types.length === 0 && (
                  <div className="muted" style={{ padding: '6px 0' }}>No sub types yet.</div>
                )}
              </div>
              <div className="row" style={{ marginTop: 10, gap: 6 }}>
                <input
                  style={inlineInput}
                  placeholder="New sub type name…"
                  value={newSubName}
                  onChange={(e) => setNewSubName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addSub() }}
                  disabled={busy}
                />
                <button className="btn primary" disabled={busy || !newSubName.trim()} onClick={() => void addSub()}>Add</button>
              </div>
            </>
          )}
        </div>

      </div>

      {/* ── Row 2: sub type config (shown when a sub type is selected) ── */}
      {selectedSub && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            Sub type config — <span style={{ fontWeight: 400 }}>{selectedSub.name}</span>
          </h3>
          <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>

            {/* Pre-fix */}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Pre-fix</div>
              <div className="muted" style={{ marginBottom: 8, fontSize: '0.9em' }}>
                Pre-filled into the Description field when a user creates a new matter of this type.
              </div>
              <div className="row" style={{ gap: 6 }}>
                <input
                  style={inlineInput}
                  placeholder="Pre-fix text…"
                  value={prefixInput}
                  onChange={(e) => setPrefixInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void savePrefix() }}
                  disabled={busy}
                />
                <button
                  className="btn primary"
                  disabled={busy || prefixInput === (selectedSub.prefix ?? '')}
                  onClick={() => void savePrefix()}
                >
                  Save
                </button>
              </div>
              {selectedSub.prefix && (
                <div className="muted" style={{ marginTop: 6, fontSize: '0.85em' }}>
                  Current: <em>{selectedSub.prefix}</em>
                </div>
              )}
            </div>

            {/* Default menus */}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Default menus</div>
              <div className="muted" style={{ marginBottom: 8, fontSize: '0.9em' }}>
                Additional menus shown on the case page (alongside Contacts).
              </div>
              <div className="list">
                {selectedSub.menus.map((m) => (
                  <div key={m.id} className="listCard row" style={{ justifyContent: 'space-between' }}>
                    {editingMenuId === m.id ? (
                      <input
                        style={inlineInput}
                        value={editingMenuName}
                        onChange={(e) => setEditingMenuName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void saveMenuRename(m.id); if (e.key === 'Escape') setEditingMenuId(null) }}
                        autoFocus
                        disabled={busy}
                      />
                    ) : (
                      <span className="listTitle">{m.name}</span>
                    )}
                    <div className="row" style={{ gap: 4 }}>
                      {editingMenuId === m.id ? (
                        <>
                          <button className="btn" style={smallBtn} disabled={busy} onClick={() => void saveMenuRename(m.id)}>Save</button>
                          <button className="btn" style={smallBtn} disabled={busy} onClick={() => setEditingMenuId(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button className="btn" style={smallBtn} disabled={busy} onClick={() => { setEditingMenuId(m.id); setEditingMenuName(m.name) }}>Rename</button>
                          <button className="btn danger" style={smallBtn} disabled={busy} onClick={() => void deleteMenu(m.id)}>Remove</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {selectedSub.menus.length === 0 && (
                  <div className="muted" style={{ padding: '6px 0' }}>No additional menus configured.</div>
                )}
              </div>
              <div className="row" style={{ marginTop: 10, gap: 6 }}>
                <select
                  style={inlineInput}
                  value={newMenuName}
                  onChange={(e) => setNewMenuName(e.target.value)}
                  disabled={busy}
                >
                  <option value="">— select menu —</option>
                  {CASE_MENU_OPTIONS.filter(
                    (opt) => !selectedSub.menus.some((m) => m.name === opt)
                  ).map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                <button className="btn primary" disabled={busy || !newMenuName} onClick={() => void addMenu()}>Add</button>
              </div>
            </div>

          </div>

          <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Precedent categories</div>
            <div className="muted" style={{ marginBottom: 8, fontSize: '0.9em' }}>
              Letter, document, and e-mail precedents for cases of this sub-type are grouped under these categories. The first category is selected by default in the precedent picker.
            </div>
            <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <input
                style={{ minWidth: 160, ...inlineInput }}
                placeholder="New category name…"
                value={newPrecCatName}
                onChange={(e) => setNewPrecCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void (async () => {
                      if (!newPrecCatName.trim() || !selectedSubId || busy) return
                      setBusy(true)
                      setErr(null)
                      try {
                        await apiFetch(`/matter-types/sub-types/${selectedSubId}/precedent-categories`, {
                          token,
                          json: { name: newPrecCatName.trim(), sort_order: subPrecCats.length },
                        })
                        setNewPrecCatName('')
                        const next = await apiFetch<PrecedentCategoryOut[]>(
                          `/matter-types/sub-types/${selectedSubId}/precedent-categories`,
                          { token },
                        )
                        setSubPrecCats(next)
                      } catch (e: any) {
                        setErr(e?.message ?? 'Failed to add category')
                      } finally {
                        setBusy(false)
                      }
                    })()
                  }
                }}
                disabled={busy}
              />
              <button
                type="button"
                className="btn primary"
                disabled={busy || !newPrecCatName.trim() || !selectedSubId}
                onClick={async () => {
                  if (!newPrecCatName.trim() || !selectedSubId) return
                  setBusy(true)
                  setErr(null)
                  try {
                    await apiFetch(`/matter-types/sub-types/${selectedSubId}/precedent-categories`, {
                      token,
                      json: { name: newPrecCatName.trim(), sort_order: subPrecCats.length },
                    })
                    setNewPrecCatName('')
                    const next = await apiFetch<PrecedentCategoryOut[]>(
                      `/matter-types/sub-types/${selectedSubId}/precedent-categories`,
                      { token },
                    )
                    setSubPrecCats(next)
                  } catch (e: any) {
                    setErr(e?.message ?? 'Failed to add category')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Add category
              </button>
            </div>
            <div className="list" style={{ maxHeight: 200, overflow: 'auto' }}>
              {subPrecCats.map((c) => (
                <div key={c.id} className="listCard row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="listTitle">{c.name}</span>
                  <button
                    type="button"
                    className="btn danger"
                    style={{ fontSize: 12, padding: '4px 10px' }}
                    disabled={busy}
                    onClick={async () => {
                      const ok = await askConfirm({
                        title: 'Remove category',
                        message: `Remove category “${c.name}”? You cannot remove a category that still has precedents.`,
                        danger: true,
                        confirmLabel: 'Remove',
                      })
                      if (!ok) return
                      setBusy(true)
                      setErr(null)
                      try {
                        await apiFetch(`/matter-types/sub-types/${selectedSubId}/precedent-categories/${c.id}`, {
                          token,
                          method: 'DELETE',
                        })
                        const next = await apiFetch<PrecedentCategoryOut[]>(
                          `/matter-types/sub-types/${selectedSubId}/precedent-categories`,
                          { token },
                        )
                        setSubPrecCats(next)
                      } catch (e: any) {
                        setErr(e?.message ?? 'Failed to remove category')
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {subPrecCats.length === 0 ? (
                <div className="muted" style={{ padding: 8 }}>No categories yet — add one before uploading precedents for this sub-type.</div>
              ) : null}
            </div>
          </div>

        </div>
      )}

    </div>
  )
}

const PRECEDENT_CODES_EXTRA_CLIENT_FIELDS: { key: string; description: string }[] = [
  { key: 'TITLE', description: 'Title (Mr / Mrs / Dr etc.)' },
  { key: 'FIRST_NAME', description: 'First name' },
  { key: 'FIRST_INITIAL', description: 'First initial (e.g. J)' },
  { key: 'MIDDLE_NAME', description: 'Middle name' },
  { key: 'MIDDLE_INITIAL', description: 'Middle initial' },
  { key: 'LAST_NAME', description: 'Surname' },
  { key: 'LAST_INITIAL', description: 'Surname initial' },
  { key: 'COMPANY_NAME', description: 'Registered company name (falls back to display name for organisations)' },
  { key: 'TRADING_NAME', description: 'Trading name' },
]

const PRECEDENT_CODES_EXTRA_CLIENTS: { code: string; description: string }[] = (() => {
  const rows: { code: string; description: string }[] = []
  for (const slot of [2, 3, 4] as const) {
    const ord = slot === 2 ? '2nd' : slot === 3 ? '3rd' : '4th'
    for (const row of PRECEDENT_CODES_EXTRA_CLIENT_FIELDS) {
      rows.push({
        code: `[${row.key}_${slot}]`,
        description: `${row.description} — additional client ${slot} (${ord} 'Client' matter contact on the case, by date added)`,
      })
    }
  }
  return rows
})()

const PRECEDENT_CODES_LAWYER_ROW_ORG: { key: string; description: string }[] = [
  { key: 'COMPANY_NAME', description: 'Registered company name' },
  { key: 'TRADING_NAME', description: 'Trading name' },
]

/** Extra fields on each lawyer-linked client (beyond TITLE … TRADING_NAME). */
const PRECEDENT_CODES_LAWYER_LINKED_CLIENT_EXTRA: { key: string; description: string }[] = [
  { key: 'NAME', description: 'Display name on the contact card' },
  { key: 'TYPE', description: 'person or organisation' },
  { key: 'EMAIL', description: 'Email' },
  { key: 'PHONE', description: 'Phone' },
  { key: 'ADDR1', description: 'Address line 1' },
  { key: 'ADDR2', description: 'Address line 2' },
  { key: 'ADDR3', description: 'Town / city' },
  { key: 'ADDR4', description: 'County' },
  { key: 'POSTCODE', description: 'Postcode' },
  { key: 'COUNTRY', description: 'Country' },
  { key: 'MATTER_REFERENCE', description: 'Matter-specific reference on this case' },
  { key: 'MATTER_CONTACT_TYPE', description: 'Matter contact type label on this case' },
]

const PRECEDENT_CODES_LAWYER: { code: string; description: string }[] = (() => {
  const rows: { code: string; description: string }[] = []
  for (let li = 1; li <= 4; li++) {
    for (const row of PRECEDENT_CODES_LAWYER_ROW_ORG) {
      rows.push({
        code: `[LAWYER_${li}_${row.key}]`,
        description: `Lawyer ${li}: ${row.description} (among 'Lawyers' matter contacts, by date added; lawyers are organisation contacts)`,
      })
    }
    for (let cj = 1; cj <= 4; cj++) {
      for (const row of PRECEDENT_CODES_EXTRA_CLIENT_FIELDS) {
        rows.push({
          code: `[LAWYER_${li}_CLIENT_${cj}_${row.key}]`,
          description: `Lawyer ${li}'s linked client ${cj}: ${row.description}`,
        })
      }
      for (const row of PRECEDENT_CODES_LAWYER_LINKED_CLIENT_EXTRA) {
        rows.push({
          code: `[LAWYER_${li}_CLIENT_${cj}_${row.key}]`,
          description: `Lawyer ${li}'s linked client ${cj}: ${row.description} (Case matter contact)`,
        })
      }
    }
  }
  const aliasFields = [...PRECEDENT_CODES_EXTRA_CLIENT_FIELDS, ...PRECEDENT_CODES_LAWYER_LINKED_CLIENT_EXTRA]
  for (let cj = 1; cj <= 4; cj++) {
    for (const row of aliasFields) {
      rows.push({
        code: `[LAWYER_CONTACT_CLIENT_${cj}_${row.key}]`,
        description: `Same as [LAWYER_1_CLIENT_${cj}_${row.key}]: first 'Lawyers' matter contact’s linked client ${cj} (by date added among Lawyers contacts).`,
      })
    }
  }
  return rows
})()

/** Selected in compose dialogue — always the contact picked when generating from a precedent (works with “merge all clients”). */
const PRECEDENT_CODES_COMPOSE_CONTACT: { code: string; description: string }[] = (() => {
  const rows: { code: string; description: string }[] = []
  const head: [string, string][] = [
    ['CONTACT_NAME', 'Display name on the contact card'],
    ['CONTACT_TYPE', 'person or organisation'],
    ['CONTACT_EMAIL', 'Email'],
    ['CONTACT_PHONE', 'Phone'],
    ['CONTACT_ADDR1', 'Address line 1'],
    ['CONTACT_ADDR2', 'Address line 2'],
    ['CONTACT_ADDR3', 'Town / city'],
    ['CONTACT_ADDR4', 'County'],
    ['CONTACT_POSTCODE', 'Postcode'],
    ['CONTACT_COUNTRY', 'Country'],
    [
      'CONTACT_MATTER_REFERENCE',
      'Matter-specific reference (case contact snapshot only; empty for a global directory contact)',
    ],
    [
      'CONTACT_MATTER_CONTACT_TYPE',
      'Matter contact type label on this case (case contact only; empty for a global directory contact)',
    ],
  ]
  for (const [suffix, desc] of head) {
    rows.push({
      code: `[${suffix}]`,
      description: `Selected contact for this compose: ${desc}. Empty if no contact was chosen in the dialogue.`,
    })
  }
  for (const row of PRECEDENT_CODES_EXTRA_CLIENT_FIELDS) {
    rows.push({
      code: `[CONTACT_${row.key}]`,
      description:
        `Selected contact for this compose: ${row.description} — always the contact picked when creating the letter or document ` +
        `(including when “merge all clients” fills [${row.key}] from a different client).`,
    })
  }
  return rows
})()

const PRECEDENT_CODES: { code: string; description: string }[] = [
  { code: '[TITLE]',          description: 'Title (Mr / Mrs / Dr etc.)' },
  { code: '[FIRST_NAME]',     description: 'First name' },
  { code: '[FIRST_INITIAL]',  description: 'First initial (e.g. J)' },
  { code: '[MIDDLE_NAME]',    description: 'Middle name' },
  { code: '[MIDDLE_INITIAL]', description: 'Middle initial' },
  { code: '[LAST_NAME]',      description: 'Surname' },
  { code: '[LAST_INITIAL]',   description: 'Surname initial' },
  { code: '[COMPANY_NAME]',   description: 'Registered company name (falls back to display name for organisations)' },
  { code: '[TRADING_NAME]',   description: 'Trading name' },
  { code: '[ADDR1]',          description: 'Address line 1' },
  { code: '[ADDR2]',          description: 'Address line 2' },
  { code: '[ADDR3]',          description: 'Town / city' },
  { code: '[ADDR4]',          description: 'County' },
  { code: '[POSTCODE]',       description: 'Postcode' },
  { code: '[MATTER_DESCRIPTION]', description: 'Matter description' },
  { code: '[CASE_REF]',       description: 'Case reference number' },
  { code: '[DATE]',           description: "Today's date when the document is generated (DD/MM/YYYY)" },
  { code: '[FEE_EARNER]',     description: 'Fee earner (name from the case fee earner)' },
  { code: '[FEE_EARNER_JOB_TITLE]', description: 'Fee earner job title (from the case fee earner user)' },
  { code: '[CONTACT_REF]',    description: "Contact's reference (as stored in canary)" },
  ...PRECEDENT_CODES_EXTRA_CLIENTS,
  ...PRECEDENT_CODES_LAWYER,
  ...PRECEDENT_CODES_COMPOSE_CONTACT,
]

function PrecedentNamePencilIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  )
}

function AdminPrecedents({ token }: { token: string }) {
  const { askConfirm } = useDialogs()
  const [items, setItems] = useState<PrecedentOut[]>([])
  const [matterHeads, setMatterHeads] = useState<MatterHeadTypeOut[]>([])
  const [flatCats, setFlatCats] = useState<PrecedentCategoryFlatOut[]>([])
  const [uploadHeadTypeId, setUploadHeadTypeId] = useState('')
  const [uploadSubTypeId, setUploadSubTypeId] = useState('')
  const [uploadCats, setUploadCats] = useState<PrecedentCategoryOut[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [reference, setReference] = useState('')
  const [kind, setKind] = useState<'letter' | 'email' | 'document'>('letter')
  const [file, setFile] = useState<File | null>(null)
  const [showCodes, setShowCodes] = useState(false)
  const [nameEditId, setNameEditId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const precedentNameInputRef = useRef<HTMLInputElement | null>(null)

  const matterTypeOptions = useMemo(
    () => matterHeads.map((h) => ({ id: h.id, label: h.name })),
    [matterHeads],
  )

  const uploadSubTypeOptions = useMemo(() => {
    if (!uploadHeadTypeId) return []
    const h = matterHeads.find((x) => x.id === uploadHeadTypeId)
    return (h?.sub_types ?? []).map((s) => ({ id: s.id, label: s.name }))
  }, [matterHeads, uploadHeadTypeId])

  const flatCatsBySubName = useMemo(() => {
    const m = new Map<string, PrecedentCategoryFlatOut[]>()
    for (const c of flatCats) {
      const k = c.matter_sub_type_name
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(c)
    }
    return m
  }, [flatCats])

  useEffect(() => {
    if (!uploadSubTypeId) {
      setUploadCats([])
      return
    }
    void apiFetch<PrecedentCategoryOut[]>(`/matter-types/sub-types/${uploadSubTypeId}/precedent-categories`, { token })
      .then((list) => setUploadCats(list))
      .catch(() => setUploadCats([]))
  }, [uploadSubTypeId, token])

  /** First category for the selected sub-type (API order: sort_order, name). Used as upload target. */
  const uploadTargetCategoryId = uploadCats[0]?.id

  async function load() {
    setBusy(true)
    setErr(null)
    try {
      const [data, heads, flat] = await Promise.all([
        apiFetch<PrecedentOut[]>('/precedents', { token }),
        apiFetch<MatterHeadTypeOut[]>('/matter-types', { token }),
        apiFetch<PrecedentCategoryFlatOut[]>('/matter-types/all-precedent-categories', { token }),
      ])
      setItems(data)
      setMatterHeads(heads)
      setFlatCats(flat)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load precedents')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (!nameEditId) return
    const id = requestAnimationFrame(() => {
      precedentNameInputRef.current?.focus()
      precedentNameInputRef.current?.select()
    })
    return () => cancelAnimationFrame(id)
  }, [nameEditId])

  async function commitPrecedentNameEdit(p: PrecedentOut) {
    const v = nameDraft.trim()
    if (!v) {
      setErr('Name cannot be empty.')
      return
    }
    if (v === p.name) {
      setNameEditId(null)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/precedents/${p.id}`, {
        token,
        method: 'PATCH',
        json: { name: v },
      })
      setNameEditId(null)
      await load()
    } catch (e2: unknown) {
      setErr((e2 as ApiError)?.message ?? 'Failed to update name')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="paneHead">
        <h3 style={{ margin: 0 }}>Precedents</h3>
        <button type="button" className="btn" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>
      {err ? <div className="error">{err}</div> : null}
      <div className="card" style={{ padding: 12 }}>
        <div className="muted" style={{ marginBottom: 8 }}>
          Upload a template. Choose matter type and sub-type. The precedent is filed under the first category for that
          sub-type (see Admin → Matters to add or reorder categories).
        </div>
        <div className="stack">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Reference</span>
            <input value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
          <label className="field">
            <span>Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="letter">Letter</option>
              <option value="email">E-mail</option>
              <option value="document">Document</option>
            </select>
          </label>
          <label className="field">
            <span>Matter type</span>
            <select
              value={uploadHeadTypeId}
              onChange={(e) => {
                const v = e.target.value
                setUploadHeadTypeId(v)
                setUploadSubTypeId('')
              }}
              disabled={busy}
            >
              <option value="">— select —</option>
              {matterTypeOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Sub-type</span>
            <select
              value={uploadSubTypeId}
              onChange={(e) => setUploadSubTypeId(e.target.value)}
              disabled={busy || !uploadHeadTypeId}
            >
              {!uploadHeadTypeId ? (
                <option value="">Select a matter type first</option>
              ) : uploadSubTypeOptions.length === 0 ? (
                <option value="">No sub-types for this matter type</option>
              ) : (
                <>
                  <option value="">— select —</option>
                  {uploadSubTypeOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>
          <label className="field">
            <span>File</span>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={
              busy ||
              !name.trim() ||
              !reference.trim() ||
              !file ||
              !uploadSubTypeId ||
              !uploadTargetCategoryId
            }
            onClick={async () => {
              if (!file || !uploadTargetCategoryId) return
              setBusy(true)
              setErr(null)
              try {
                const fd = new FormData()
                fd.set('name', name.trim())
                fd.set('reference', reference.trim())
                fd.set('kind', kind)
                fd.set('category_id', uploadTargetCategoryId)
                fd.set('upload', file)
                const res = await fetch(apiUrl('/precedents'), {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${token}` },
                  body: fd,
                })
                if (!res.ok) {
                  const body = await res.json().catch(() => ({}))
                  throw new Error((body as { detail?: string }).detail ?? res.statusText)
                }
                setName('')
                setReference('')
                setFile(null)
                await load()
              } catch (e: any) {
                setErr(e?.message ?? 'Upload failed')
              } finally {
                setBusy(false)
              }
            }}
          >
            Upload
          </button>
        </div>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: showCodes ? 8 : 0 }}
        >
          <span className="muted" style={{ fontSize: 13 }}>Merge codes — insert into templates to auto-populate contact details</span>
          <button type="button" className="btn" style={{ fontSize: 12 }} onClick={() => setShowCodes((v) => !v)}>
            {showCodes ? 'Hide codes' : 'Show codes'}
          </button>
        </div>
        {showCodes ? (
          <table
            className="allow-select"
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
          >
            <thead>
              <tr>
                <th style={{ textAlign: 'left', paddingBottom: 4, borderBottom: '1px solid #e2e8f0' }}>Code</th>
                <th style={{ textAlign: 'left', paddingBottom: 4, borderBottom: '1px solid #e2e8f0' }}>Inserts</th>
              </tr>
            </thead>
            <tbody>
              {PRECEDENT_CODES.map(({ code, description }) => (
                <tr key={code}>
                  <td style={{ padding: '3px 8px 3px 0', fontFamily: 'monospace', color: '#0f172a' }}>{code}</td>
                  <td style={{ padding: '3px 0', color: '#475569' }}>{description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      <div className="list">
        {items.map((p) => (
          <div
            key={p.id}
            className="listCard row precedentListCardRow"
            style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}
          >
            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
              {nameEditId === p.id ? (
                <div className="precedentNameRow precedentNameRow--edit">
                  <input
                    ref={precedentNameInputRef}
                    className="precedentAdminNameInput"
                    value={nameDraft}
                    disabled={busy}
                    maxLength={300}
                    aria-label="Precedent name"
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={() => void commitPrecedentNameEdit(p)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitPrecedentNameEdit(p)
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setNameEditId(null)
                        setErr(null)
                      }
                    }}
                  />
                </div>
              ) : (
                <div className="precedentNameRow">
                  <span className="listTitle precedentNameText">{p.name}</span>
                  <button
                    type="button"
                    className="btn precedentNameEditBtn"
                    disabled={busy}
                    title="Edit name"
                    aria-label="Edit precedent name"
                    onClick={() => {
                      setNameEditId(p.id)
                      setNameDraft(p.name)
                    }}
                  >
                    <PrecedentNamePencilIcon />
                  </button>
                </div>
              )}
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                <span className="mono">{p.reference}</span> · {p.kind}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {p.original_filename}
                {p.category_name ? <span> · {p.category_name}</span> : null}
              </div>
            </div>
            <select
              style={{ maxWidth: 280 }}
              value={p.category_id}
              disabled={busy || flatCats.length === 0}
              onChange={async (e) => {
                const v = e.target.value
                if (!v) return
                setBusy(true)
                setErr(null)
                try {
                  await apiFetch(`/precedents/${p.id}`, {
                    token,
                    method: 'PATCH',
                    json: { category_id: v },
                  })
                  await load()
                } catch (e2: any) {
                  setErr(e2?.message ?? 'Failed to update category')
                } finally {
                  setBusy(false)
                }
              }}
            >
              {[...flatCatsBySubName.entries()].map(([subName, list]) => (
                <optgroup key={subName} label={subName}>
                  {list.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => window.open(`/editor/precedent/${p.id}`, '_blank')}
              >
                Edit in OnlyOffice
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    const ok = await askConfirm({
                      title: 'Delete precedent',
                      message: `Delete precedent "${p.name}"?`,
                      danger: true,
                      confirmLabel: 'Delete',
                    })
                    if (!ok) return
                    setBusy(true)
                    apiFetch(`/precedents/${p.id}`, { token, method: 'DELETE' })
                      .then(() => load())
                      .catch((e: any) => setErr(e?.message ?? 'Delete failed'))
                      .finally(() => setBusy(false))
                  })()
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {items.length === 0 ? <div className="muted">No precedents yet.</div> : null}
      </div>
    </div>
  )
}

function UserSettingsPage({ token, refreshMe }: { token: string; refreshMe: () => Promise<void> }) {
  const { askConfirm } = useDialogs()
  const [appFont, setAppFont] = useState(() => getThemePreferences().font)
  const [appAccent, setAppAccent] = useState(() => getThemePreferences().accent)
  const [appPageBg, setAppPageBg] = useState(() => getThemePreferences().pageBg)
  const [appMode, setAppMode] = useState<'light' | 'dark'>(() => getThemePreferences().mode)
  const [themeSavedHint, setThemeSavedHint] = useState(false)

  const [busy, setBusy] = useState(false)

  const [caldav, setCaldav] = useState<UserCalDAVStatusOut | null>(null)
  const [caldavLoadErr, setCaldavLoadErr] = useState<string | null>(null)
  const [caldavActionErr, setCaldavActionErr] = useState<string | null>(null)
  const [caldavBusy, setCaldavBusy] = useState(false)
  const [caldavProvision, setCaldavProvision] = useState<UserCalDAVProvisionOut | null>(null)
  const [caldavCopyHint, setCaldavCopyHint] = useState<string | null>(null)

  const [account, setAccount] = useState<UserPublic | null>(null)
  const [pwdCurrent, setPwdCurrent] = useState('')
  const [pwdNew, setPwdNew] = useState('')
  const [pwdConfirm, setPwdConfirm] = useState('')
  const [pwdErr, setPwdErr] = useState<string | null>(null)
  const [pwdOk, setPwdOk] = useState(false)
  const [secBusy, setSecBusy] = useState(false)
  const [faSetup, setFaSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null)
  const [faCode, setFaCode] = useState('')
  const [faErr, setFaErr] = useState<string | null>(null)
  const [faOk, setFaOk] = useState(false)
  const [disablePwd, setDisablePwd] = useState('')
  const [disableTotp, setDisableTotp] = useState('')
  const [cancelSetupPwd, setCancelSetupPwd] = useState('')
  const [accountLoadErr, setAccountLoadErr] = useState<string | null>(null)

  const [emailPref, setEmailPref] = useState<'desktop' | 'outlook_web'>('desktop')
  const [outlookUrl, setOutlookUrl] = useState(DEFAULT_OUTLOOK_WEB_MAIL_URL)
  const [emailSaveErr, setEmailSaveErr] = useState<string | null>(null)
  const [emailSaveOk, setEmailSaveOk] = useState(false)
  const [emailBusy, setEmailBusy] = useState(false)

  async function load() {
    setBusy(true)
    setAccountLoadErr(null)
    setCaldavLoadErr(null)
    try {
      const me = await apiFetch<UserPublic>('/auth/me', { token })
      setAccount(me)
    } catch (e: unknown) {
      setAccount(null)
      setAccountLoadErr((e as ApiError).message ?? 'Failed to load account')
    }
    try {
      const st = await apiFetch<UserCalDAVStatusOut>('/users/me/calendar', { token })
      setCaldav(st)
    } catch (e: unknown) {
      setCaldav(null)
      setCaldavLoadErr((e as ApiError).message ?? 'Failed to load CalDAV status')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [token])

  useEffect(() => {
    if (!account) return
    setEmailPref(account.email_launch_preference ?? 'desktop')
    setOutlookUrl((account.email_outlook_web_url ?? '').trim() || DEFAULT_OUTLOOK_WEB_MAIL_URL)
  }, [account])

  async function saveEmailHandling() {
    setEmailSaveErr(null)
    setEmailSaveOk(false)
    setEmailBusy(true)
    try {
      const u = await apiFetch<UserPublic>('/users/me/email-handling', {
        method: 'PUT',
        token,
        json: {
          email_launch_preference: emailPref,
          email_outlook_web_url: emailPref === 'outlook_web' ? outlookUrl.trim() : null,
        },
      })
      setAccount(u)
      await refreshMe()
      setEmailSaveOk(true)
    } catch (e: unknown) {
      setEmailSaveErr((e as ApiError).message ?? 'Save failed')
    } finally {
      setEmailBusy(false)
    }
  }

  async function submitPasswordChange() {
    setPwdErr(null)
    setPwdOk(false)
    if (pwdNew.length < 12) {
      setPwdErr('New password must be at least 12 characters.')
      return
    }
    if (pwdNew !== pwdConfirm) {
      setPwdErr('New password and confirmation do not match.')
      return
    }
    setSecBusy(true)
    try {
      await apiFetch<null>('/auth/change-password', {
        method: 'POST',
        token,
        json: { current_password: pwdCurrent, new_password: pwdNew },
      })
      setPwdOk(true)
      setPwdCurrent('')
      setPwdNew('')
      setPwdConfirm('')
    } catch (e: unknown) {
      setPwdErr((e as ApiError).message ?? 'Could not change password')
    } finally {
      setSecBusy(false)
    }
  }

  async function start2faSetup() {
    setFaErr(null)
    setFaOk(false)
    setSecBusy(true)
    try {
      const res = await apiFetch<{ secret: string; otpauth_uri: string }>('/auth/2fa/setup', { method: 'POST', token })
      setFaSetup(res)
      setFaCode('')
    } catch (e: unknown) {
      setFaErr((e as ApiError).message ?? 'Could not start 2FA setup')
    } finally {
      setSecBusy(false)
    }
  }

  async function verify2fa() {
    setFaErr(null)
    setFaOk(false)
    const code = faCode.trim()
    if (code.length < 4) {
      setFaErr('Enter the code from your authenticator app.')
      return
    }
    setSecBusy(true)
    try {
      const me = await apiFetch<UserPublic>('/auth/2fa/verify', {
        method: 'POST',
        token,
        json: { code },
      })
      setAccount(me)
      setFaSetup(null)
      setFaCode('')
      setFaOk(true)
      setCancelSetupPwd('')
    } catch (e: unknown) {
      setFaErr((e as ApiError).message ?? 'Verification failed')
    } finally {
      setSecBusy(false)
    }
  }

  async function disable2fa() {
    setFaErr(null)
    setFaOk(false)
    setSecBusy(true)
    try {
      await apiFetch<null>('/auth/2fa/disable', {
        method: 'POST',
        token,
        json: { password: disablePwd, totp_code: disableTotp.trim() },
      })
      setDisablePwd('')
      setDisableTotp('')
      const me = await apiFetch<UserPublic>('/auth/me', { token })
      setAccount(me)
      setFaOk(true)
    } catch (e: unknown) {
      setFaErr((e as ApiError).message ?? 'Could not disable 2FA')
    } finally {
      setSecBusy(false)
    }
  }

  async function cancel2faSetup() {
    setFaErr(null)
    setFaOk(false)
    setSecBusy(true)
    try {
      await apiFetch<null>('/auth/2fa/cancel-setup', {
        method: 'POST',
        token,
        json: { password: cancelSetupPwd },
      })
      setCancelSetupPwd('')
      setFaSetup(null)
      setFaCode('')
      const me = await apiFetch<UserPublic>('/auth/me', { token })
      setAccount(me)
    } catch (e: unknown) {
      setFaErr((e as ApiError).message ?? 'Could not cancel setup')
    } finally {
      setSecBusy(false)
    }
  }

  return (
    <div
      className="mainMenuShell mainMenuShell--surface"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div className="paneHead">
        <div>
          <h2 style={{ margin: 0 }}>User settings</h2>
          <div className="muted" style={{ marginTop: 4 }}>
            Preferences for your account: appearance, sign-in security, e-mail launcher, and calendar sync.
          </div>
        </div>
        <button type="button" className="btn" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, marginTop: 12, overflow: 'auto' }} className="stack">
        {accountLoadErr ? <div className="error">{accountLoadErr}</div> : null}
        <section className="card" style={{ padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Appearance</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Font, accent colour, page background, and light or dark mode are stored in this browser only. More fonts and preset
            colours are listed below; stacks fall back if a font is not installed, and you can always enter a hex manually.
          </p>
          <div className="stack" style={{ maxWidth: 480, gap: 12 }}>
            <label className="field">
              <span>Font</span>
              <select
                value={appFont}
                onChange={(e) => {
                  setAppFont(e.target.value)
                  setThemeSavedHint(false)
                }}
              >
                {FONT_OPTIONS.map((o) => (
                  <option key={o.label} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Accent colour</span>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(appAccent.trim()) ? appAccent.trim() : DEFAULT_ACCENT}
                  onChange={(e) => {
                    setAppAccent(e.target.value)
                    setThemeSavedHint(false)
                  }}
                  aria-label="Accent colour"
                  style={{ width: 44, height: 32, padding: 0, border: 'none', cursor: 'pointer' }}
                />
                <input
                  className="allow-select"
                  value={appAccent}
                  onChange={(e) => {
                    setAppAccent(e.target.value)
                    setThemeSavedHint(false)
                  }}
                  placeholder={DEFAULT_ACCENT}
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 0 }}
                />
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Presets
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {ACCENT_COLOR_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    title={p.label}
                    aria-label={`Set accent to ${p.label}`}
                    onClick={() => {
                      setAppAccent(p.value)
                      setThemeSavedHint(false)
                    }}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      border: '2px solid var(--border)',
                      background: p.value,
                      cursor: 'pointer',
                      padding: 0,
                      boxSizing: 'border-box',
                    }}
                  />
                ))}
              </div>
            </label>
            <label className="field">
              <span>Background colour</span>
              <div className="muted" style={{ marginBottom: 6, fontSize: 12 }}>
                Colour behind cards and toolbars. Leave blank to use the default blue (light) or slate (dark) for the current
                mode.
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(appPageBg.trim()) ? appPageBg.trim() : DEFAULT_PAGE_BG}
                  onChange={(e) => {
                    setAppPageBg(e.target.value)
                    setThemeSavedHint(false)
                  }}
                  aria-label="Background colour"
                  style={{ width: 44, height: 32, padding: 0, border: 'none', cursor: 'pointer' }}
                />
                <input
                  className="allow-select"
                  value={appPageBg}
                  onChange={(e) => {
                    setAppPageBg(e.target.value)
                    setThemeSavedHint(false)
                  }}
                  placeholder={`${DEFAULT_PAGE_BG} or leave empty for default`}
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 0 }}
                />
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Presets
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {PAGE_BG_COLOR_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    title={p.label}
                    aria-label={p.value ? `Set background to ${p.label}` : 'Use built-in default background'}
                    onClick={() => {
                      setAppPageBg(p.value)
                      setThemeSavedHint(false)
                    }}
                    style={
                      p.value
                        ? {
                            width: 28,
                            height: 28,
                            borderRadius: 6,
                            border: '2px solid var(--border)',
                            background: p.value,
                            cursor: 'pointer',
                            padding: 0,
                            boxSizing: 'border-box',
                          }
                        : {
                            width: 28,
                            height: 28,
                            borderRadius: 6,
                            border: '2px dashed var(--border)',
                            background: 'var(--panel2)',
                            cursor: 'pointer',
                            padding: 0,
                            boxSizing: 'border-box',
                          }
                    }
                  />
                ))}
              </div>
            </label>
            <fieldset className="field" style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend style={{ marginBottom: 6 }}>Colour mode</legend>
              <div className="row" style={{ gap: 16 }}>
                <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="canary-mode"
                    checked={appMode === 'light'}
                    onChange={() => {
                      setAppMode('light')
                      setThemeSavedHint(false)
                    }}
                  />
                  Light
                </label>
                <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="canary-mode"
                    checked={appMode === 'dark'}
                    onChange={() => {
                      setAppMode('dark')
                      setThemeSavedHint(false)
                    }}
                  />
                  Dark
                </label>
              </div>
            </fieldset>
            {themeSavedHint ? <div className="muted">Appearance saved.</div> : null}
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  saveThemePreferences({ font: appFont, accent: appAccent, mode: appMode, pageBg: appPageBg })
                  setThemeSavedHint(true)
                }}
              >
                Save appearance
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setAppFont('')
                  setAppAccent(DEFAULT_ACCENT)
                  setAppPageBg('')
                  setAppMode('light')
                  saveThemePreferences({ font: '', accent: DEFAULT_ACCENT, mode: 'light', pageBg: '' })
                  setThemeSavedHint(true)
                }}
              >
                Reset to defaults
              </button>
            </div>
          </div>
        </section>

        <section className="card" style={{ padding: 16, marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Password &amp; two-factor authentication</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Change your Canary login password. Optional TOTP (authenticator app) adds a second step at sign-in.
          </p>

          <h4 style={{ margin: '16px 0 8px', fontSize: '1rem', fontWeight: 600 }}>Change password</h4>
          <div className="stack" style={{ maxWidth: 480, gap: 10 }}>
            <label className="field">
              <span>Current password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={pwdCurrent}
                onChange={(e) => setPwdCurrent(e.target.value)}
                disabled={busy || secBusy}
              />
            </label>
            <label className="field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={pwdNew}
                onChange={(e) => setPwdNew(e.target.value)}
                disabled={busy || secBusy}
              />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={pwdConfirm}
                onChange={(e) => setPwdConfirm(e.target.value)}
                disabled={busy || secBusy}
              />
            </label>
            <div className="muted" style={{ fontSize: 13 }}>
              At least 12 characters.
            </div>
            {pwdErr ? <div className="error">{pwdErr}</div> : null}
            {pwdOk ? <div className="muted">Password updated.</div> : null}
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy || secBusy || !pwdCurrent || !pwdNew}
                onClick={() => void submitPasswordChange()}
              >
                Update password
              </button>
            </div>
          </div>

          <h4 style={{ margin: '20px 0 8px', fontSize: '1rem', fontWeight: 600 }}>Authenticator (TOTP / 2FA)</h4>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Status:{' '}
            <strong>{account?.is_2fa_enabled ? 'Enabled' : 'Not enabled'}</strong>
          </p>

          {faErr ? <div className="error">{faErr}</div> : null}
          {faOk ? <div className="muted">2FA updated.</div> : null}

          {account?.is_2fa_enabled ? (
            <div className="stack" style={{ maxWidth: 480, gap: 10, marginTop: 8 }}>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                To turn off 2FA, enter your Canary password and a current code from your authenticator app.
              </p>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={disablePwd}
                  onChange={(e) => setDisablePwd(e.target.value)}
                  disabled={busy || secBusy}
                />
              </label>
              <label className="field">
                <span>Authenticator code</span>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={disableTotp}
                  onChange={(e) => setDisableTotp(e.target.value)}
                  disabled={busy || secBusy}
                  placeholder="6-digit code"
                />
              </label>
              <button
                type="button"
                className="btn danger"
                disabled={busy || secBusy || !disablePwd.trim() || disableTotp.trim().length < 6}
                onClick={() => void disable2fa()}
              >
                Disable 2FA
              </button>
            </div>
          ) : !faSetup ? (
            <div className="stack" style={{ maxWidth: 560, gap: 10, marginTop: 8 }}>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Use an app such as Google Authenticator, Microsoft Authenticator, or 1Password. You will scan a QR code or
                enter the secret key, then confirm with a one-time code.
              </p>
              <button
                type="button"
                className="btn primary"
                disabled={busy || secBusy}
                onClick={() => void start2faSetup()}
              >
                Begin 2FA setup
              </button>
            </div>
          ) : (
            <div className="stack" style={{ maxWidth: 560, gap: 12, marginTop: 8 }}>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Scan this QR code in your authenticator app, or add the account manually using the secret key below. Then
                enter a 6-digit code to confirm.
              </p>
              <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(faSetup.otpauth_uri)}`}
                  width={180}
                  height={180}
                  alt=""
                  style={{ borderRadius: 8, border: '1px solid var(--border)' }}
                />
                <div className="stack" style={{ gap: 8, flex: '1 1 200px', minWidth: 0 }}>
                  <label className="field">
                    <span>Secret key (manual entry)</span>
                    <input readOnly value={faSetup.secret} style={{ fontFamily: 'monospace', fontSize: 13 }} />
                  </label>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || secBusy}
                    onClick={() =>
                      void copyTextToClipboard(faSetup.secret).then((ok) =>
                        setFaErr(ok ? null : 'Could not copy — select the secret and copy manually.'),
                      )
                    }
                  >
                    Copy secret
                  </button>
                </div>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                The QR image is generated by a third-party service from your setup link (no password is sent).
              </p>
              <label className="field">
                <span>Confirmation code</span>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={faCode}
                  onChange={(e) => setFaCode(e.target.value)}
                  disabled={busy || secBusy}
                  placeholder="000000"
                />
              </label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || secBusy || faCode.trim().length < 4}
                  onClick={() => void verify2fa()}
                >
                  Enable 2FA
                </button>
                <div className="stack" style={{ gap: 6, flex: '1 1 220px' }}>
                  <label className="field" style={{ marginBottom: 0 }}>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Cancel setup (your Canary password)
                    </span>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={cancelSetupPwd}
                      onChange={(e) => setCancelSetupPwd(e.target.value)}
                      disabled={busy || secBusy}
                      placeholder="Password to clear pending setup"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || secBusy || !cancelSetupPwd}
                    onClick={() => void cancel2faSetup()}
                  >
                    Cancel setup
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="card" style={{ padding: 16, marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>E-mail</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Choose what happens when you click <strong>E-mail</strong> in the top bar (next to Main Menu): open your system&apos;s
            default mail program, or open Outlook on the web in a new browser tab.
          </p>
          <div className="stack" style={{ maxWidth: 560, gap: 14, marginTop: 12 }}>
            <label className="field">
              <span>Open e-mail with</span>
              <select
                value={emailPref}
                onChange={(e) => {
                  const v = e.target.value as 'desktop' | 'outlook_web'
                  setEmailPref(v)
                  if (v === 'outlook_web') {
                    setOutlookUrl((u) => u.trim() || DEFAULT_OUTLOOK_WEB_MAIL_URL)
                  }
                }}
                disabled={emailBusy}
                aria-label="How to open e-mail from the top bar"
              >
                <option value="desktop">Desktop client (system default)</option>
                <option value="outlook_web">Outlook web</option>
              </select>
            </label>
            {emailPref === 'outlook_web' ? (
              <label className="field">
                <span>Outlook web URL</span>
                <p className="muted" style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>
                  Confirm the page opened for Outlook on the web. The default is Microsoft&apos;s Outlook inbox; change this if
                  your organisation uses a different address (e.g. a custom Microsoft 365 URL).
                </p>
                <input
                  className="allow-select"
                  value={outlookUrl}
                  onChange={(e) => setOutlookUrl(e.target.value)}
                  disabled={emailBusy}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={DEFAULT_OUTLOOK_WEB_MAIL_URL}
                />
              </label>
            ) : null}
            {emailSaveErr ? <div className="error">{emailSaveErr}</div> : null}
            {emailSaveOk ? <div className="muted">Saved.</div> : null}
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                disabled={emailBusy || busy}
                onClick={() => void saveEmailHandling()}
              >
                {emailBusy ? 'Saving…' : 'Save e-mail settings'}
              </button>
            </div>
          </div>
        </section>

        <section className="card" style={{ padding: 16, marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Calendar (CalDAV)</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Subscribe in Apple Calendar, Thunderbird, etc. Use the app password below — not your Canary login. Extra calendars
            and sharing are managed in your client and on the server (Radicale).
          </p>
          {caldavLoadErr ? <div className="error">{caldavLoadErr}</div> : null}
          {caldavActionErr ? <div className="error">{caldavActionErr}</div> : null}
          {caldavCopyHint ? <div className="muted">{caldavCopyHint}</div> : null}
          {caldav && !caldav.enabled ? (
            <p className="muted">CalDAV is not enabled for your account yet.</p>
          ) : null}
          {caldav && caldav.enabled ? (
            <div className="stack" style={{ maxWidth: 560, gap: 10 }}>
              <label className="field">
                <span>Server / principal URL</span>
                <input readOnly value={caldav.caldav_url} style={{ fontFamily: 'monospace', fontSize: 13 }} />
              </label>
              <label className="field">
                <span>CalDAV username</span>
                <input readOnly value={caldav.caldav_username} style={{ fontFamily: 'monospace', fontSize: 13 }} />
              </label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || caldavBusy}
                  onClick={() => {
                    void copyTextToClipboard(caldav.caldav_url).then((ok) =>
                      setCaldavCopyHint(ok ? 'Copied URL.' : 'Could not copy automatically — select and copy the URL.'),
                    )
                  }}
                >
                  Copy URL
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || caldavBusy}
                  onClick={() => {
                    void copyTextToClipboard(caldav.caldav_username).then((ok) =>
                      setCaldavCopyHint(ok ? 'Copied username.' : 'Could not copy — select and copy the username.'),
                    )
                  }}
                >
                  Copy username
                </button>
              </div>
            </div>
          ) : null}
          {caldavProvision ? (
            <div
              style={{
                marginTop: 12,
                padding: 12,
                borderRadius: 8,
                background: 'rgba(139, 92, 246, 0.12)',
                border: '1px solid rgba(139, 92, 246, 0.35)',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 8 }}>CalDAV app password (save it now)</div>
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                {caldavProvision.note}
              </p>
              <label className="field">
                <span>Password</span>
                <input readOnly value={caldavProvision.caldav_password} style={{ fontFamily: 'monospace', fontSize: 13 }} />
              </label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void copyTextToClipboard(caldavProvision.caldav_password).then((ok) =>
                      setCaldavCopyHint(ok ? 'Copied password.' : 'Could not copy — select the password field manually.'),
                    )
                  }}
                >
                  Copy password
                </button>
                <button type="button" className="btn primary" onClick={() => setCaldavProvision(null)}>
                  I’ve saved it
                </button>
              </div>
            </div>
          ) : null}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
            {caldav && !caldav.enabled ? (
              <button
                type="button"
                className="btn primary"
                disabled={busy || caldavBusy || !!caldavLoadErr}
                onClick={() => {
                  setCaldavActionErr(null)
                  setCaldavCopyHint(null)
                  setCaldavBusy(true)
                  apiFetch<UserCalDAVProvisionOut>('/users/me/calendar/enable', { method: 'POST', token })
                    .then((p) => {
                      setCaldavProvision(p)
                      setCaldav({ enabled: true, caldav_url: p.caldav_url, caldav_username: p.caldav_username })
                    })
                    .catch((e: unknown) =>
                      setCaldavActionErr((e as ApiError).message ?? 'Could not enable CalDAV'),
                    )
                    .finally(() => setCaldavBusy(false))
                }}
              >
                Enable CalDAV
              </button>
            ) : null}
            {caldav?.enabled ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || caldavBusy}
                  onClick={() => {
                    setCaldavActionErr(null)
                    setCaldavCopyHint(null)
                    setCaldavBusy(true)
                    apiFetch<UserCalDAVProvisionOut>('/users/me/calendar/reset-password', { method: 'POST', token })
                      .then((p) => setCaldavProvision(p))
                      .catch((e: unknown) =>
                        setCaldavActionErr((e as ApiError).message ?? 'Could not reset password'),
                      )
                      .finally(() => setCaldavBusy(false))
                  }}
                >
                  Reset app password
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || caldavBusy}
                  onClick={() => {
                    void (async () => {
                      const ok = await askConfirm({
                        title: 'Disable CalDAV?',
                        message: 'Your calendar app will stop syncing until you enable again.',
                        danger: true,
                        confirmLabel: 'Disable',
                      })
                      if (!ok) return
                      setCaldavActionErr(null)
                      setCaldavCopyHint(null)
                      setCaldavProvision(null)
                      setCaldavBusy(true)
                      apiFetch<null>('/users/me/calendar/disable', { method: 'DELETE', token })
                      .then(() => {
                        setCaldav((c) =>
                          c
                            ? {
                                enabled: false,
                                caldav_url: c.caldav_url,
                                caldav_username: c.caldav_username,
                              }
                            : c,
                        )
                      })
                      .catch((e: unknown) =>
                        setCaldavActionErr((e as ApiError).message ?? 'Could not disable CalDAV'),
                      )
                      .finally(() => setCaldavBusy(false))
                    })()
                  }}
                >
                  Disable CalDAV
                </button>
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}

function AdminMatterContacts({ token }: { token: string }) {
  const { askConfirm } = useDialogs()
  const [rows, setRows] = useState<MatterContactTypeOut[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [newSlug, setNewSlug] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newSort, setNewSort] = useState(90)

  async function load() {
    setBusy(true)
    setErr(null)
    try {
      const r = await apiFetch<MatterContactTypeOut[]>('/admin/matter-contact-types', { token })
      setRows(r)
    } catch (e: unknown) {
      setErr((e as ApiError)?.message ?? 'Failed to load contact types')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [token])

  return (
    <div className="stack">
      <div className="paneHead">
        <h3 style={{ margin: 0 }}>Contacts</h3>
        <button type="button" className="btn" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>
      {err ? <div className="error">{err}</div> : null}
      <p className="muted" style={{ marginTop: 0 }}>
        These labels populate the matter contact type dropdown. The four system types (Client, Lawyers, New lender,
        Existing lender) cannot be deleted or renamed.
      </p>
      <div className="card stack" style={{ gap: 10, maxWidth: 720 }}>
        <div className="muted" style={{ fontWeight: 600 }}>
          Add type
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '1 1 140px', marginBottom: 0 }}>
            <span>Slug</span>
            <input
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder="e.g. surveyor"
              disabled={busy}
            />
          </label>
          <label className="field" style={{ flex: '1 1 160px', marginBottom: 0 }}>
            <span>Label</span>
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} disabled={busy} />
          </label>
          <label className="field" style={{ flex: '0 0 80px', marginBottom: 0 }}>
            <span>Sort</span>
            <input type="number" value={newSort} onChange={(e) => setNewSort(Number(e.target.value))} disabled={busy} />
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !newSlug.trim() || !newLabel.trim()}
            onClick={async () => {
              setBusy(true)
              setErr(null)
              try {
                await apiFetch('/admin/matter-contact-types', {
                  token,
                  method: 'POST',
                  json: { slug: newSlug.trim(), label: newLabel.trim(), sort_order: newSort },
                })
                setNewSlug('')
                setNewLabel('')
                await load()
              } catch (e: unknown) {
                setErr((e as ApiError)?.message ?? 'Could not add contact type')
              } finally {
                setBusy(false)
              }
            }}
          >
            Add
          </button>
        </div>
      </div>
      <div className="list" style={{ marginTop: 12 }}>
        {rows.map((r) => (
          <div
            key={r.id}
            className="listCard row"
            style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="listTitle">
                {r.label}{' '}
                {r.is_system ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    (system)
                  </span>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                slug: <span className="mono">{r.slug}</span> · sort {r.sort_order}
              </div>
            </div>
            {!r.is_system ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={async () => {
                  const ok = await askConfirm({
                    title: 'Delete contact type',
                    message: `Remove “${r.label}”? Existing matter contacts keep this slug until edited.`,
                    danger: true,
                    confirmLabel: 'Delete',
                  })
                  if (!ok) return
                  setBusy(true)
                  setErr(null)
                  try {
                    await apiFetch(`/admin/matter-contact-types/${r.id}`, { token, method: 'DELETE' })
                    await load()
                  } catch (e: unknown) {
                    setErr((e as ApiError)?.message ?? 'Delete failed')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Delete
              </button>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                Cannot delete
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function AdminConsole({ token }: { token: string }) {
  const [tab, setTab] = useState<
    'users' | 'matters' | 'billing' | 'submenus' | 'tasks' | 'contacts' | 'precedents' | 'audit'
  >('users')
  return (
    <div
      className="mainMenuShell mainMenuShell--surface"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div className="paneHead">
        <div>
          <h2 style={{ margin: 0 }}>Admin settings</h2>
          <div className="muted" style={{ marginTop: 4 }}>Users and audit trail</div>
        </div>
        <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
          <button type="button" className={`navBtn ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>
            Users
          </button>
          <button type="button" className={`navBtn ${tab === 'matters' ? 'active' : ''}`} onClick={() => setTab('matters')}>
            Matters
          </button>
          <button type="button" className={`navBtn ${tab === 'billing' ? 'active' : ''}`} onClick={() => setTab('billing')}>
            Billing
          </button>
          <button type="button" className={`navBtn ${tab === 'submenus' ? 'active' : ''}`} onClick={() => setTab('submenus')}>
            Sub-Menus
          </button>
          <button type="button" className={`navBtn ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>
            Tasks
          </button>
          <button type="button" className={`navBtn ${tab === 'contacts' ? 'active' : ''}`} onClick={() => setTab('contacts')}>
            Contacts
          </button>
          <button type="button" className={`navBtn ${tab === 'precedents' ? 'active' : ''}`} onClick={() => setTab('precedents')}>
            Precedents
          </button>
          <button type="button" className={`navBtn ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
            Audit
          </button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, marginTop: 12, overflow: 'auto' }}>
        {tab === 'users' ? (
          <AdminUsers token={token} embedded />
        ) : tab === 'matters' ? (
          <AdminMatters token={token} />
        ) : tab === 'billing' ? (
          <AdminBilling token={token} />
        ) : tab === 'submenus' ? (
          <AdminSubMenus token={token} />
        ) : tab === 'tasks' ? (
          <AdminTasks token={token} />
        ) : tab === 'contacts' ? (
          <AdminMatterContacts token={token} />
        ) : tab === 'precedents' ? (
          <AdminPrecedents token={token} />
        ) : (
          <AdminAudit token={token} embedded />
        )}
      </div>
    </div>
  )
}

function AdminUsers({ token, embedded }: { token: string; embedded?: boolean }) {
  const { askConfirm } = useDialogs()
  const [users, setUsers] = useState<AdminUserPublic[]>([])
  const [categories, setCategories] = useState<UserPermissionCategoryOut[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [newJobTitle, setNewJobTitle] = useState('')
  const [jobTitleByUser, setJobTitleByUser] = useState<Record<string, string>>({})
  const [newUserCategoryId, setNewUserCategoryId] = useState('')
  const [newCatName, setNewCatName] = useState('')
  const [newCat, setNewCat] = useState({
    perm_fee_earner: false,
    perm_post_client: false,
    perm_post_office: false,
    perm_approve_payments: false,
    perm_approve_invoices: false,
  })
  const [editCatId, setEditCatId] = useState<string | null>(null)
  const [editCatName, setEditCatName] = useState('')
  const [editCat, setEditCat] = useState({
    perm_fee_earner: false,
    perm_post_client: false,
    perm_post_office: false,
    perm_approve_payments: false,
    perm_approve_invoices: false,
  })

  async function load() {
    setBusy(true)
    setErr(null)
    try {
      const [u, c] = await Promise.all([
        apiFetch<AdminUserPublic[]>('/admin/users', { token }),
        apiFetch<UserPermissionCategoryOut[]>('/admin/permission-categories', { token }),
      ])
      setUsers(u)
      setCategories(c)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load users')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    const m: Record<string, string> = {}
    for (const u of users) m[u.id] = u.job_title ?? ''
    setJobTitleByUser(m)
  }, [users])

  return (
    <div className="stack">
      <div className="paneHead">
        {embedded ? <h3 style={{ margin: 0 }}>Users</h3> : <h2>Admin · Users</h2>}
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {err ? <div className="error">{err}</div> : null}
      <div className="card">
        <h3>User categories</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Assign each user to a category to control ledger posting and approvals. Categories are visible only in the admin
          console.
        </p>
        <div className="stack" style={{ gap: 10, maxWidth: 720 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: '1 1 200px', marginBottom: 0 }}>
              <span>New category name</span>
              <input value={newCatName} onChange={(e) => setNewCatName(e.target.value)} disabled={busy} />
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !newCatName.trim()}
              onClick={async () => {
                setBusy(true)
                setErr(null)
                try {
                  await apiFetch('/admin/permission-categories', {
                    token,
                    method: 'POST',
                    json: { name: newCatName.trim(), ...newCat },
                  })
                  setNewCatName('')
                  await load()
                } catch (e: any) {
                  setErr(e?.message ?? 'Could not create category')
                } finally {
                  setBusy(false)
                }
              }}
            >
              Add category
            </button>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            {(
              [
                ['perm_fee_earner', 'Fee-earner files'],
                ['perm_post_client', 'Post client'],
                ['perm_post_office', 'Post office'],
                ['perm_approve_payments', 'Approve payments'],
                ['perm_approve_invoices', 'Approve invoices'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="row" style={{ gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={newCat[k]}
                  disabled={busy}
                  onChange={(e) => setNewCat((p) => ({ ...p, [k]: e.target.checked }))}
                />
                <span style={{ fontSize: 13 }}>{label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="list" style={{ marginTop: 12 }}>
          {categories.map((c) => (
            <div key={c.id} className="listCard stack" style={{ gap: 10 }}>
              {editCatId === c.id ? (
                <div className="stack" style={{ gap: 10 }}>
                  <label className="field" style={{ marginBottom: 0 }}>
                    <span>Category name</span>
                    <input value={editCatName} onChange={(e) => setEditCatName(e.target.value)} disabled={busy} />
                  </label>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
                    {(
                      [
                        ['perm_fee_earner', 'Fee-earner files'],
                        ['perm_post_client', 'Post client'],
                        ['perm_post_office', 'Post office'],
                        ['perm_approve_payments', 'Approve payments'],
                        ['perm_approve_invoices', 'Approve invoices'],
                      ] as const
                    ).map(([k, label]) => (
                      <label key={k} className="row" style={{ gap: 6, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={editCat[k]}
                          disabled={busy}
                          onChange={(e) => setEditCat((p) => ({ ...p, [k]: e.target.checked }))}
                        />
                        <span style={{ fontSize: 13 }}>{label}</span>
                      </label>
                    ))}
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy || !editCatName.trim()}
                      onClick={async () => {
                        setBusy(true)
                        setErr(null)
                        try {
                          await apiFetch(`/admin/permission-categories/${c.id}`, {
                            token,
                            method: 'PATCH',
                            json: {
                              name: editCatName.trim(),
                              perm_fee_earner: editCat.perm_fee_earner,
                              perm_post_client: editCat.perm_post_client,
                              perm_post_office: editCat.perm_post_office,
                              perm_approve_payments: editCat.perm_approve_payments,
                              perm_approve_invoices: editCat.perm_approve_invoices,
                            },
                          })
                          setEditCatId(null)
                          await load()
                        } catch (e: any) {
                          setErr(e?.message ?? 'Could not update category')
                        } finally {
                          setBusy(false)
                        }
                      }}
                    >
                      Save changes
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setEditCatId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div className="listTitle">{c.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {[
                        c.perm_fee_earner ? 'Fee-earner' : null,
                        c.perm_post_client ? 'Client post' : null,
                        c.perm_post_office ? 'Office post' : null,
                        c.perm_approve_payments ? 'Approve payments' : null,
                        c.perm_approve_invoices ? 'Approve invoices' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'No permissions'}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => {
                        setEditCatId(c.id)
                        setEditCatName(c.name)
                        setEditCat({
                          perm_fee_earner: c.perm_fee_earner,
                          perm_post_client: c.perm_post_client,
                          perm_post_office: c.perm_post_office,
                          perm_approve_payments: c.perm_approve_payments,
                          perm_approve_invoices: c.perm_approve_invoices,
                        })
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn danger"
                      disabled={busy}
                      onClick={async () => {
                        const ok = await askConfirm({
                          title: 'Delete category',
                          message: `Delete category “${c.name}”?`,
                          danger: true,
                          confirmLabel: 'Delete',
                        })
                        if (!ok) return
                        setBusy(true)
                        setErr(null)
                        try {
                          await apiFetch(`/admin/permission-categories/${c.id}`, { token, method: 'DELETE' })
                          await load()
                        } catch (e: any) {
                          setErr(e?.message ?? 'Delete failed (is it still assigned to users?)')
                        } finally {
                          setBusy(false)
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {categories.length === 0 ? <div className="muted">No categories yet.</div> : null}
        </div>
      </div>
      <div className="card">
        <h3>Create user</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Every new user must be assigned a permission category (create one above if needed).
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
          <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <input
            placeholder="Job title (optional)"
            value={newJobTitle}
            onChange={(e) => setNewJobTitle(e.target.value)}
            style={{ minWidth: 160 }}
          />
          <input placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <label className="field" style={{ marginBottom: 0, minWidth: 200 }}>
            <span>Category</span>
            <select value={newUserCategoryId} onChange={(e) => setNewUserCategoryId(e.target.value)} disabled={busy}>
              <option value="">— Select category —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn primary"
            disabled={busy || !email || !displayName || password.length < 12 || !newUserCategoryId}
            onClick={async () => {
              setBusy(true)
              setErr(null)
              try {
                await apiFetch('/admin/users', {
                  token,
                  json: {
                    email,
                    display_name: displayName,
                    job_title: newJobTitle.trim() || null,
                    password,
                    permission_category_id: newUserCategoryId,
                  },
                })
                setEmail('')
                setDisplayName('')
                setNewJobTitle('')
                setPassword('')
                setNewUserCategoryId('')
                await load()
              } catch (e: any) {
                setErr(e?.message ?? 'Create failed')
              } finally {
                setBusy(false)
              }
            }}
          >
            Create
          </button>
        </div>
      </div>
      <div className="card">
        <h3>Users</h3>
        <div className="list">
          {users.map((u) => (
            <div key={u.id} className="listCard row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ flex: '1 1 220px' }}>
                <div className="listTitle">
                  {u.email} <span className="muted">· {u.role}</span>
                </div>
                <div className="muted">
                  {u.display_name} · {u.is_active ? 'active' : 'disabled'} · 2FA {u.is_2fa_enabled ? 'on' : 'off'}
                </div>
                <label className="field" style={{ marginTop: 8, marginBottom: 0, maxWidth: 420 }}>
                  <span>Job title</span>
                  <input
                    value={jobTitleByUser[u.id] ?? ''}
                    onChange={(e) => setJobTitleByUser((p) => ({ ...p, [u.id]: e.target.value }))}
                    onBlur={async () => {
                      const next = (jobTitleByUser[u.id] ?? '').trim()
                      const prev = (u.job_title ?? '').trim()
                      if (next === prev) return
                      setBusy(true)
                      setErr(null)
                      try {
                        await apiFetch(`/admin/users/${u.id}`, {
                          token,
                          method: 'PATCH',
                          json: { job_title: next || null },
                        })
                        await load()
                      } catch (err2: any) {
                        setErr(err2?.message ?? 'Could not update job title')
                        setJobTitleByUser((p) => ({ ...p, [u.id]: u.job_title ?? '' }))
                      } finally {
                        setBusy(false)
                      }
                    }}
                    disabled={busy}
                    placeholder="Optional"
                  />
                </label>
              </div>
              <label className="field" style={{ marginBottom: 0, minWidth: 200 }}>
                <span>Category</span>
                <select
                  value={u.permission_category_id ?? ''}
                  disabled={busy}
                  onChange={async (e) => {
                    const v = e.target.value || null
                    setBusy(true)
                    setErr(null)
                    try {
                      await apiFetch(`/admin/users/${u.id}`, {
                        token,
                        method: 'PATCH',
                        json: { permission_category_id: v },
                      })
                      await load()
                    } catch (err2: any) {
                      setErr(err2?.message ?? 'Update failed')
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  <option value="">— None —</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  setErr(null)
                  try {
                    await apiFetch(`/admin/users/${u.id}`, { token, method: 'PATCH', json: { is_active: !u.is_active } })
                    await load()
                  } catch (e: any) {
                    setErr(e?.message ?? 'Update failed')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {u.is_active ? 'Disable' : 'Enable'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function AdminAudit({ token, embedded }: { token: string; embedded?: boolean }) {
  const [events, setEvents] = useState<AdminAuditEvent[]>([])
  const [action, setAction] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setBusy(true)
    setErr(null)
    try {
      const qs = new URLSearchParams()
      if (action) qs.set('action', action)
      qs.set('limit', '50')
      const data = await apiFetch<AdminAuditEvent[]>(`/admin/audit-events?${qs.toString()}`, { token })
      setEvents(data)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load audit events')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="stack">
      <div className="paneHead">
        {embedded ? <h3 style={{ margin: 0 }}>Audit</h3> : <h2>Admin · Audit</h2>}
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="card">
        <div className="row">
          <input placeholder="Filter by action (e.g. auth.login)" value={action} onChange={(e) => setAction(e.target.value)} />
          <button type="button" className="btn primary" disabled={busy} onClick={() => void load()}>
            Apply
          </button>
        </div>
        {err ? <div className="error">{err}</div> : null}
      </div>
      <div className="card">
        <h3>Recent events</h3>
        <div className="list">
          {events.map((e) => (
            <div key={e.id} className="listCard">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="listTitle">{e.action}</div>
                <div className="muted">{formatTs(e.created_at)}</div>
              </div>
              <div className="muted">
                {e.entity_type ?? '-'} {e.entity_id ?? ''} · actor {e.actor_user_id ?? '-'}
              </div>
            </div>
          ))}
          {events.length === 0 ? <div className="muted">No events found.</div> : null}
        </div>
      </div>
    </div>
  )
}

function contactTypeLabel(t: ContactOut['type']) {
  return t === 'person' ? 'Person' : 'Organisation'
}

function Contacts({ token }: { token: string }) {
  const { askConfirm } = useDialogs()
  const [contacts, setContacts] = useState<ContactOut[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [contactRowFocusId, setContactRowFocusId] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)

  const [editing, setEditing] = useState<ContactOut | null>(null)
  const [contactCtx, setContactCtx] = useState<null | { x: number; y: number; c: ContactOut }>(null)
  const contactCtxRef = useRef<HTMLDivElement | null>(null)

  async function load() {
    setBusy(true)
    setErr(null)
    try {
      const data = await apiFetch<ContactOut[]>('/contacts', { token })
      setContacts(data)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load contacts')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [token])

  useEffect(() => {
    if (!contactCtx) return
    function handleMouseDown(e: MouseEvent) {
      const t = e.target as Node
      if (contactCtxRef.current?.contains(t)) return
      setContactCtx(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [contactCtx])

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    let list = contacts
    if (s) {
      list = contacts.filter((c) => {
        const parts = [c.name, c.email ?? '', c.phone ?? '', c.type]
        return parts.join(' ').toLowerCase().includes(s)
      })
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [contacts, q])

  function closeCreateModal() {
    if (busy) return
    setCreateOpen(false)
    setCreateErr(null)
  }

  return (
    <div className="mainMenuShell mainMenuShell--mainMenu">
      {err ? <div className="error">{err}</div> : null}
      <div className="mainMenuFilterBar">
        <div className="row mainMenuFilterRow mainMenuFilterRow--toolbar">
          <div className="mainMenuFilterRowLeft">
            <SearchInput
              placeholder="Search contacts (name, email, phone)…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ('')}
              className="mainMenuSearchInput"
              aria-label="Search contacts"
            />
          </div>
          <div className="mainMenuFilterRowRight">
            <button type="button" className="btn" onClick={() => void load()} disabled={busy}>
              Refresh
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCreateErr(null)
                setCreateOpen(true)
              }}
            >
              New contact…
            </button>
          </div>
        </div>
      </div>

      <div className="card casesTableCard" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="casesTableScroll contactsTableScroll">
          <div className="table">
            <div className="tr th" style={{ gridTemplateColumns: CONTACTS_TABLE_GRID }}>
              {(['Name', 'Type', 'Email', 'Phone'] as const).map((label) => (
                <div key={label} className="thCell">
                  <div className="thbtn" style={{ cursor: 'default', userSelect: 'none' }}>
                    {label}
                  </div>
                </div>
              ))}
            </div>
            {rows.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`tr rowbtn${contactRowFocusId === c.id ? ' active' : ''}`}
                style={{ gridTemplateColumns: CONTACTS_TABLE_GRID }}
                onClick={() => setContactRowFocusId(c.id)}
                onDoubleClick={() => setEditing(c)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setContactCtx({ x: e.clientX, y: e.clientY, c })
                }}
              >
                <div className="td">{c.name}</div>
                <div className="td">{contactTypeLabel(c.type)}</div>
                <div className="td">{c.email ?? '—'}</div>
                <div className="td">{c.phone ?? '—'}</div>
              </button>
            ))}
            {rows.length === 0 ? (
              <div className="muted" style={{ padding: 12 }}>
                {contacts.length === 0 ? 'No contacts yet.' : 'No contacts match your search.'}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {contactCtx ? (
        <div
          ref={contactCtxRef}
          className="docContextMenu"
          style={{ left: contactCtx.x, top: contactCtx.y, zIndex: 30 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="docContextItem"
            role="menuitem"
            tabIndex={0}
            onClick={() => {
              const c = contactCtx.c
              setContactCtx(null)
              setEditing(c)
            }}
          >
            Open
          </div>
          <div
            className="docContextItem"
            role="menuitem"
            tabIndex={0}
            onClick={() => {
              void (async () => {
                const c = contactCtx.c
                setContactCtx(null)
                const ok = await askConfirm({
                  title: 'Delete contact',
                  message: `Delete “${c.name}” from the global directory?`,
                  danger: true,
                  confirmLabel: 'Delete',
                })
                if (!ok) return
                setBusy(true)
                setErr(null)
                try {
                  await apiFetch(`/contacts/${c.id}`, { token, method: 'DELETE' })
                  if (editing?.id === c.id) setEditing(null)
                  await load()
                } catch (e: any) {
                  setErr(e?.message ?? 'Delete failed')
                } finally {
                  setBusy(false)
                }
              })()
            }}
          >
            Delete
          </div>
        </div>
      ) : null}

      {createOpen ? (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-contact-title"
          onClick={() => closeCreateModal()}
        >
          <div
            className="modal modal--scrollBody card"
            style={{ maxWidth: 720, width: 'min(720px, 100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="paneHead">
              <div>
                <h2 id="new-contact-title">New contact</h2>
                <div className="muted">Add a person or organisation to the global directory (same details as when creating from a matter).</div>
              </div>
              <button type="button" className="btn" onClick={() => closeCreateModal()} disabled={busy}>
                Close
              </button>
            </div>
            <div className="stack modalBodyScroll" style={{ marginTop: 12 }}>
              <GlobalContactCreateForm
                busy={busy}
                formError={createErr}
                submitLabel="Create"
                showCancelButton
                cancelLabel="Cancel"
                onCancel={() => closeCreateModal()}
                onSubmit={async (payload) => {
                  setBusy(true)
                  setCreateErr(null)
                  try {
                    await apiFetch('/contacts', { token, json: payload })
                    setCreateOpen(false)
                    setCreateErr(null)
                    await load()
                  } catch (e: any) {
                    setCreateErr(e?.message ?? 'Create failed')
                    throw e
                  } finally {
                    setBusy(false)
                  }
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      {editing ? (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-contact-title"
          onClick={() => {
            setEditing(null)
          }}
        >
          <div
            className="modal modal--scrollBody card"
            style={{ maxWidth: 640, width: 'min(640px, 100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <ContactEditor
              token={token}
              contact={editing}
              onSaved={async () => {
                setEditing(null)
                await load()
              }}
              onDeleted={async () => {
                setEditing(null)
                await load()
              }}
              onCancel={() => setEditing(null)}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ContactEditor({
  token,
  contact,
  onSaved,
  onDeleted,
  onCancel,
}: {
  token: string
  contact: ContactOut
  onSaved: () => void
  onDeleted?: () => void
  onCancel: () => void
}) {
  const { askConfirm } = useDialogs()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [fields, setFields] = useState(() => contactOutToFormFields(contact))

  useEffect(() => {
    setFields(contactOutToFormFields(contact))
  }, [contact.id])

  const resolvedName = useMemo(
    () =>
      resolveContactNameWithFallback(
        fields.type,
        {
          title: fields.title,
          first_name: fields.firstName,
          middle_name: fields.middleName,
          last_name: fields.lastName,
        },
        { company_name: fields.companyName, trading_name: fields.tradingName },
        contact.name,
      ),
    [fields, contact.name],
  )

  return (
    <>
      <div className="paneHead">
        <div>
          <h2 id="edit-contact-title">Edit contact</h2>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn" onClick={onCancel} disabled={busy}>
            Close
          </button>
          {onDeleted ? (
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                const ok = await askConfirm({
                  title: 'Delete contact',
                  message: 'Permanently delete this contact from the global directory?',
                  danger: true,
                  confirmLabel: 'Delete',
                })
                if (!ok) return
                setBusy(true)
                setErr(null)
                try {
                  await apiFetch<unknown>(`/contacts/${contact.id}`, { token, method: 'DELETE' })
                  onDeleted()
                } catch (e: any) {
                  setErr(e?.message ?? 'Delete failed')
                } finally {
                  setBusy(false)
                }
              }}
            >
              Delete globally
            </button>
          ) : null}
          <button
            className="btn primary"
            disabled={busy || !resolvedName.trim()}
            onClick={async () => {
              const payload = contactFieldsModelToPayload(fields)
              if (!payload) return
              setBusy(true)
              setErr(null)
              try {
                await apiFetch(`/contacts/${contact.id}`, {
                  token,
                  method: 'PATCH',
                  json: payload,
                })
                onSaved()
              } catch (e: any) {
                setErr(e?.message ?? 'Save failed')
              } finally {
                setBusy(false)
              }
            }}
          >
            Save
          </button>
        </div>
      </div>
      {err ? <div className="error">{err}</div> : null}
      <div className="stack modalBodyScroll" style={{ marginTop: 12 }}>
        <ContactPersonOrgAddressFields
          value={fields}
          onChange={(patch) => setFields((prev) => ({ ...prev, ...patch }))}
          busy={busy}
        />
      </div>
    </>
  )
}

export default App

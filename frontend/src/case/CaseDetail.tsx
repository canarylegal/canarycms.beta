import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EventsPage } from '../EventsPage'
import { FinancePage } from '../FinancePage'
import {
  GlobalContactCreateForm,
  ContactPersonOrgAddressFields,
  contactOutToFormFields,
  contactFieldsModelToPayload,
  resolveContactNameWithFallback,
} from '../GlobalContactCreateForm'
import { ManageCaseAccessModal } from '../ManageCaseAccessModal'
import { MATTER_CONTACT_TYPE_OPTIONS_FALLBACK } from '../matterContactTypeOptions'
import { apiFetch, apiUrl, browserAbsoluteApiUrl, formatApiErrorDetail } from '../api'
import {
  appendOutlookWebAuthHintsForNav,
  buildOutlookWebReadUrlFromGraphMessageId,
  openOutlookWebAppFromGraphWebLink,
} from '../emailClient'
import {
  buildOutlookWebMessageSearchUrl,
  extractInternetMessageIdFromEmlText,
  openCanaryEmailLauncher,
} from '../emailLauncher'
import { useDialogs } from '../DialogProvider'
import { SearchInput } from '../SearchInput'
import { CANARY_FOLLOW_UP_STANDARD_TASK_ID } from '../standardTasks'
import { TextPromptModal } from '../TextPromptModal'
import { useModalDrag } from '../useModalDrag'
import { caseHasRevokedUserAccess, formatCaseStatusLabel, type CaseWorkflowStatus } from '../types'
import type {
  CaseContactOut,
  CaseEmailDraftM365Out,
  CaseEventsOut,
  CaseNoteOut,
  CaseOut,
  CasePropertyDetailsOut,
  CasePropertyPayload,
  CasePropertyTenure,
  CaseTaskOut,
  ContactOut,
  FileSummary,
  FinanceOut,
  MatterContactTypeOut,
  MatterHeadTypeOut,
  MatterSubTypeStandardTaskOut,
  PrecedentCategoryOut,
  PrecedentOut,
  UserPublic,
  UserSummary,
} from '../types'
import { applyCaseContactFieldPatch } from './caseContactPatch'
import { computeDocContextMenuStyle } from './docContextMenu'
import { dndEventHasFiles, formatDocFileSize, formatDocModified, matterTypeDisplayLine } from './docFormat'
import { DocMimeIcon, DocsFileDescCell, DocsFolderDescCell } from './DocCells'
import { financeCaseTotals, penceGb } from './financeTotals'
import { matterContactTypeLabel } from './matterLabels'
import { EmlPreviewModal, parseEmlForPreview, type EmlPreviewData } from './emlPreview'
import { isEmlLikeFileSummary, isOfficeLikeFile } from './officeFiles'
import { propertyTenureLabel } from './propertyLabels'

/** Abort same-origin file GETs so a stuck server/proxy cannot leave the UI on “Loading” indefinitely. */
const CASE_FILE_FETCH_MS = 90_000

async function fetchCaseFileResponse(caseId: string, fileId: string, token: string): Promise<Response> {
  const ctrl = new AbortController()
  const tid = window.setTimeout(() => ctrl.abort(), CASE_FILE_FETCH_MS)
  try {
    return await fetch(apiUrl(`/cases/${caseId}/files/${fileId}`), {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(tid)
  }
}

function fetchTimedOutMessage(e: unknown): string | null {
  const err = e as { name?: string }
  return err?.name === 'AbortError' ? 'Request timed out — try again or use Download.' : null
}

/** Preview only: read up to this many UTF-8 chars so we never wait on multi‑GB .eml bodies. */
const EML_PREVIEW_STREAM_CAP = 768 * 1024

async function fetchEmlTextForPreview(caseId: string, fileId: string, token: string): Promise<string> {
  const ctrl = new AbortController()
  const tid = window.setTimeout(() => ctrl.abort(), CASE_FILE_FETCH_MS)
  try {
    const res = await fetch(apiUrl(`/cases/${caseId}/files/${fileId}`), {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    })
    if (res.status === 401) {
      localStorage.removeItem('token')
      window.location.reload()
      return ''
    }
    if (!res.ok) throw new Error((await res.text()) || res.statusText)
    if (!res.body) return await res.text()
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let out = ''
    while (out.length < EML_PREVIEW_STREAM_CAP) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) out += decoder.decode(value, { stream: true })
      if (out.length >= EML_PREVIEW_STREAM_CAP) {
        try {
          ctrl.abort()
        } catch {
          /* ignore */
        }
        break
      }
    }
    return out
  } finally {
    clearTimeout(tid)
  }
}

const CONTACT_TYPE_REQUIRED_MSG = 'Please select a contact type for this matter.'

const CLIENT_TYPE_SLUG = 'client'
const LAWYERS_TYPE_SLUG = 'lawyers'

function isClientMatterContact(c: CaseContactOut) {
  return (c.matter_contact_type || '').trim().toLowerCase() === CLIENT_TYPE_SLUG
}

function htmlEscapeForHandoffTab(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function formatHandoffCaughtError(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const o = e as { message?: string; status?: number; body?: unknown }
    const m = typeof o.message === 'string' ? o.message.trim() : ''
    if (m) return m
    const fb =
      typeof o.status === 'number' ? `HTTP ${o.status}` : 'Request failed'
    if (o.body !== undefined) {
      const fromBody = formatApiErrorDetail(o.body, fb).trim()
      if (fromBody) return fromBody
    }
  }
  if (e instanceof Error && e.message.trim()) return e.message.trim()
  if (typeof e === 'string' && e.trim()) return e.trim()
  if (e && typeof e === 'object' && 'status' in e) {
    const st = (e as { status?: number }).status
    if (typeof st === 'number') {
      return `Something went wrong (HTTP ${st}). Return to the Canary tab for the full message.`
    }
  }
  return 'Could not create Outlook draft. Return to the Canary tab for details.'
}

/** Render an error in a tab opened synchronously for async navigation. Avoid `close()` — it looks like the tab flashed away. */
function showHandoffTabError(tab: Window | null, message: string) {
  if (!tab || tab.closed) return
  const detail =
    (message || '').trim() ||
    'No additional details are available. Return to the Canary tab and try again.'
  const esc = htmlEscapeForHandoffTab
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Could not open Outlook</title><style>body{font-family:system-ui,sans-serif;padding:2rem;max-width:40rem;line-height:1.5;color:#111}h1{font-size:1.125rem;font-weight:600;margin:0 0 0.75rem}p.detail{margin:0;white-space:pre-wrap;word-break:break-word}</style></head><body><h1>Could not open Outlook</h1><p class="detail">${esc(detail)}</p></body></html>`
  try {
    tab.document.open()
    tab.document.write(doc)
    tab.document.close()
  } catch {
    try {
      tab.location.replace(`data:text/html;charset=utf-8,${encodeURIComponent(doc)}`)
    } catch {
      try {
        tab.location.replace(
          `data:text/plain;charset=utf-8,${encodeURIComponent(`Could not open Outlook\n\n${detail}`)}`,
        )
      } catch {
        /* ignore */
      }
    }
  }
}

export function CaseDetail({
  token,
  caseDetail,
  notes: _notes,
  tasks: _tasks,
  files,
  caseContacts,
  error,
  onRefresh,
  onCaseListInvalidate,
  onTaskMenuInvalidate,
  /** When set, case view waits until this matches ``caseDetail.id`` so we do not fetch the wrong matter while switching cases. */
  selectedCaseId,
  currentUser,
}: {
  token: string
  caseDetail: CaseOut | null
  notes: CaseNoteOut[]
  tasks: CaseTaskOut[]
  files: FileSummary[]
  caseContacts: CaseContactOut[]
  error: string | null
  onRefresh: () => void
  onCaseListInvalidate?: () => void
  onTaskMenuInvalidate?: () => void
  selectedCaseId?: string | null
  /** Used for e-mail launch preference when opening filed ``.eml`` files (Outlook web vs desktop). */
  currentUser?: UserPublic | null
}) {
  void _notes
  void _tasks
  const { askConfirm } = useDialogs()
  const caseId = caseDetail?.id
  /** Resolved matter id for API calls: null while ``caseDetail`` is stale vs. ``selectedCaseId``. */
  const matterScopeId = useMemo(() => {
    if (!caseId) return null
    if (selectedCaseId === undefined || selectedCaseId === null) return caseId
    return String(selectedCaseId) === String(caseId) ? caseId : null
  }, [caseId, selectedCaseId])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!busy) return
    const prev = document.body.style.cursor
    document.body.style.cursor = 'wait'
    return () => {
      document.body.style.cursor = prev
    }
  }, [busy])

  // File drag: prevent the browser from navigating / opening the file when dropping outside a valid target.
  useEffect(() => {
    function preventFileDropNavigate(e: DragEvent) {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
    }
    window.addEventListener('dragover', preventFileDropNavigate)
    window.addEventListener('drop', preventFileDropNavigate)
    return () => {
      window.removeEventListener('dragover', preventFileDropNavigate)
      window.removeEventListener('drop', preventFileDropNavigate)
    }
  }, [])

  const [actionErr, setActionErr] = useState<string | null>(null)
  const [textPrompt, setTextPrompt] = useState<
    | null
    | {
        title: string
        hint?: string
        initial: string
        confirmLabel: string
        onConfirm: (value: string) => void
      }
  >(null)
  const [contacts, setContacts] = useState<ContactOut[]>([])
  const [editSnapshot, setEditSnapshot] = useState<CaseContactOut | null>(null)
  const [pushToGlobal, setPushToGlobal] = useState(false)

  const resolvedEditSnapshotName = useMemo(() => {
    if (!editSnapshot) return ''
    return resolveContactNameWithFallback(
      editSnapshot.type,
      {
        title: editSnapshot.title ?? '',
        first_name: editSnapshot.first_name ?? '',
        middle_name: editSnapshot.middle_name ?? '',
        last_name: editSnapshot.last_name ?? '',
      },
      {
        company_name: editSnapshot.company_name ?? '',
        trading_name: editSnapshot.trading_name ?? '',
      },
      editSnapshot.name,
    )
  }, [editSnapshot])

  /** Match precedent client 1,2,… order (created_at asc among clients); other types after, newest first. */
  const caseContactsMenuOrder = useMemo(() => {
    const clients = caseContacts.filter(isClientMatterContact).sort((a, b) => a.created_at.localeCompare(b.created_at))
    const others = caseContacts
      .filter((c) => !isClientMatterContact(c))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return [...clients, ...others]
  }, [caseContacts])

  const clientMatterContacts = useMemo(
    () =>
      caseContacts.filter(isClientMatterContact).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [caseContacts],
  )

  useEffect(() => {
    if (!editSnapshot) {
      setEditLawyerLinkClientIds([])
      return
    }
    setEditLawyerLinkClientIds((editSnapshot.lawyer_client_ids ?? []).map((x) => String(x)))
  }, [editSnapshot])

  const [docSearch, setDocSearch] = useState('')
  const [docFolder, setDocFolder] = useState<string>('') // "" == Home (top-level documents)
  const [docMenu, setDocMenu] = useState<
    | null
    | { kind: 'file'; fileId: string; x: number; y: number }
    | { kind: 'folder'; folderPath: string; x: number; y: number }
    | { kind: 'surface'; x: number; y: number }
  >(null)
  // Multi-selection: each entry is a file ID or "folder:<path>"
  const [selectedDocSet, setSelectedDocSet] = useState<Set<string>>(new Set())
  const docAnchorRef = useRef<string | null>(null)
  const [docSortKey, setDocSortKey] = useState<'description' | 'size' | 'modified' | 'user'>('modified')
  const [docSortDir, setDocSortDir] = useState<'asc' | 'desc'>('desc')
  const [docsDragOver, setDocsDragOver] = useState(false)
  const [moveMenu, setMoveMenu] = useState<{ kind: 'file'; fileId: string } | { kind: 'folder'; folderPath: string } | null>(null)
  const docMenuRef = useRef<HTMLDivElement | null>(null)
  const [docMenuStyle, setDocMenuStyle] = useState<{ left: number; top: number; maxHeight?: number } | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const newMenuRef = useRef<HTMLDivElement | null>(null)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [taskCreateOpen, setTaskCreateOpen] = useState(false)
  const [taskCreateStandardId, setTaskCreateStandardId] = useState<string>('__custom__')
  const [taskCreateCustomTitle, setTaskCreateCustomTitle] = useState('')
  const [taskCreateDueDate, setTaskCreateDueDate] = useState('')
  const [taskCreateAssignUserId, setTaskCreateAssignUserId] = useState('')
  const [taskCreatePriority, setTaskCreatePriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [taskCreatePrivate, setTaskCreatePrivate] = useState(false)
  const [taskCreateErr, setTaskCreateErr] = useState<string | null>(null)
  const [taskCreateBusy, setTaskCreateBusy] = useState(false)
  /** When set, optional title override for a standard task (e.g. document “Follow up”). */
  const [taskCreateTitleOverride, setTaskCreateTitleOverride] = useState<string | null>(null)
  const [standardTaskTemplates, setStandardTaskTemplates] = useState<MatterSubTypeStandardTaskOut[]>([])
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentErr, setCommentErr] = useState<string | null>(null)
  // When set, the comment modal is in edit mode for this file ID
  const [commentEditFileId, setCommentEditFileId] = useState<string | null>(null)
  const [emlPreviewOpen, setEmlPreviewOpen] = useState(false)
  const [emlPreviewFile, setEmlPreviewFile] = useState<FileSummary | null>(null)
  const [emlPreviewData, setEmlPreviewData] = useState<EmlPreviewData | null>(null)
  const [emlPreviewBusy, setEmlPreviewBusy] = useState(false)
  const [emlPreviewErr, setEmlPreviewErr] = useState<string | null>(null)
  const [users, setUsers] = useState<UserSummary[]>([])
  const [leftOpen, setLeftOpen] = useState<{
    contacts: boolean
    property: boolean
    events: boolean
    finance: boolean
  }>({
    contacts: false,
    property: false,
    events: false,
    finance: false,
  })
  const [financeModalOpen, setFinanceModalOpen] = useState(false)
  const [eventsModalOpen, setEventsModalOpen] = useState(false)
  const [eventsPreview, setEventsPreview] = useState<CaseEventsOut | null>(null)
  const [financePreview, setFinancePreview] = useState<FinanceOut | null>(null)
  const [propertyDetails, setPropertyDetails] = useState<CasePropertyDetailsOut | null>(null)
  const [propertyLoading, setPropertyLoading] = useState(false)
  const [propertyModalOpen, setPropertyModalOpen] = useState(false)
  const [propertyDraft, setPropertyDraft] = useState<CasePropertyPayload | null>(null)
  const [propertyBaseline, setPropertyBaseline] = useState<CasePropertyPayload | null>(null)
  const [precedentPicker, setPrecedentPicker] = useState<null | { kind: 'letter' | 'document' | 'email' }>(null)
  const [precedentChoices, setPrecedentChoices] = useState<PrecedentOut[]>([])
  const [precedentCategories, setPrecedentCategories] = useState<PrecedentCategoryOut[]>([])
  const [precedentPickerCategoryId, setPrecedentPickerCategoryId] = useState<string | null>(null)
  const [precedentSearch, setPrecedentSearch] = useState('')
  const [precedentChosenId, setPrecedentChosenId] = useState<string | null>(null)
  const [contactPickModal, setContactPickModal] = useState<null | { precedentId: string | null; composeKind: 'letter' | 'email' }>(
    null,
  )
  const [emailAttachIds, setEmailAttachIds] = useState<string[]>([])
  const [emailAttachBrowseFolder, setEmailAttachBrowseFolder] = useState('')
  const [emailAttachCanaryOpen, setEmailAttachCanaryOpen] = useState(false)
  const emailLocalAttachInputRef = useRef<HTMLInputElement | null>(null)
  const [pickMatterCcId, setPickMatterCcId] = useState<string>('') // '' | 'none' | case contact id
  const [pickGlobalId, setPickGlobalId] = useState<string | null>(null)
  const [pickLinkGlobal, setPickLinkGlobal] = useState(false)
  const [pickLinkType, setPickLinkType] = useState('')
  const [pickLawyerClientIds, setPickLawyerClientIds] = useState<string[]>([])
  const [pickSearch, setPickSearch] = useState('')
  const [caseEditOpen, setCaseEditOpen] = useState(false)
  const [manageAccessOpen, setManageAccessOpen] = useState(false)
  const [editMatterDescription, setEditMatterDescription] = useState('')
  const [editPracticeArea, setEditPracticeArea] = useState('')
  const [editFeeEarner, setEditFeeEarner] = useState<string>('')
  const [editCaseStatus, setEditCaseStatus] = useState<CaseWorkflowStatus>('open')
  const [matterHeadTypes, setMatterHeadTypes] = useState<MatterHeadTypeOut[]>([])

  const [contactAddOpen, setContactAddOpen] = useState(false)
  const [contactAddSearch, setContactAddSearch] = useState('')
  const [selectedGlobalContactId, setSelectedGlobalContactId] = useState<string | null>(null)
  const [contactAddErr, setContactAddErr] = useState<string | null>(null)
  const [matterContactType, setMatterContactType] = useState('')
  const [matterContactReference, setMatterContactReference] = useState('')
  const [matterTypeOptions, setMatterTypeOptions] = useState<{ value: string; label: string }[]>(
    MATTER_CONTACT_TYPE_OPTIONS_FALLBACK,
  )
  const [lawyerLinkClientIds, setLawyerLinkClientIds] = useState<string[]>([])
  const [editLawyerLinkClientIds, setEditLawyerLinkClientIds] = useState<string[]>([])
  const [contactRowMenu, setContactRowMenu] = useState<null | { cc: CaseContactOut; x: number; y: number }>(null)
  const contactRowMenuRef = useRef<HTMLDivElement | null>(null)

  const caseEditDrag = useModalDrag(caseEditOpen)
  const contactAddDrag = useModalDrag(contactAddOpen)

  useEffect(() => {
    if (!contactRowMenu) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (contactRowMenuRef.current?.contains(t)) return
      setContactRowMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [contactRowMenu])

  // lazy-load global contacts when viewing a case
  useEffect(() => {
    if (!caseId) return
    let cancelled = false
    async function loadContacts() {
      try {
        const data = await apiFetch<ContactOut[]>('/contacts', { token })
        if (!cancelled) setContacts(data)
      } catch {
        // ignore; case view still usable without contacts
      }
    }
    void loadContacts()
    return () => {
      cancelled = true
    }
  }, [caseId, token])

  useEffect(() => {
    let cancelled = false
    async function loadUsers() {
      try {
        const data = await apiFetch<UserSummary[]>('/users', { token })
        if (!cancelled) setUsers(Array.isArray(data) ? data : [])
      } catch {
        // ignore
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
        // ignore
      }
    }
    void loadMatterTypes()
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    let cancelled = false
    async function loadMatterContactTypes() {
      try {
        const data = await apiFetch<MatterContactTypeOut[]>('/matter-contact-types', { token })
        if (!cancelled) {
          setMatterTypeOptions(data.map((r) => ({ value: r.slug, label: r.label })))
        }
      } catch {
        if (!cancelled) setMatterTypeOptions(MATTER_CONTACT_TYPE_OPTIONS_FALLBACK)
      }
    }
    void loadMatterContactTypes()
    return () => {
      cancelled = true
    }
  }, [token])

  const hasPropertyMenu = useMemo(
    () => Boolean(caseDetail?.matter_menus?.some((m) => m.name.trim().toLowerCase() === 'property')),
    [caseDetail?.matter_menus],
  )

  const hasFinanceMenu = useMemo(
    () => Boolean(caseDetail?.matter_menus?.some((m) => m.name.trim().toLowerCase() === 'finance')),
    [caseDetail?.matter_menus],
  )

  const hasEventsMenu = useMemo(
    () => Boolean(caseDetail?.matter_menus?.some((m) => m.name.trim().toLowerCase() === 'events')),
    [caseDetail?.matter_menus],
  )

  useEffect(() => {
    if (!caseId || !hasPropertyMenu || !leftOpen.property) return
    let cancelled = false
    async function load() {
      setPropertyLoading(true)
      try {
        const d = await apiFetch<CasePropertyDetailsOut>(`/cases/${caseId}/property-details`, { token })
        if (!cancelled) setPropertyDetails(d)
      } catch {
        if (!cancelled) setPropertyDetails(null)
      } finally {
        if (!cancelled) setPropertyLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [caseId, token, hasPropertyMenu, leftOpen.property])

  useEffect(() => {
    if (!caseId || !leftOpen.events) return
    let cancelled = false
    void apiFetch<CaseEventsOut>(`/cases/${caseId}/events`, { token })
      .then((d) => {
        if (!cancelled) setEventsPreview(d)
      })
      .catch(() => {
        if (!cancelled) setEventsPreview(null)
      })
    return () => {
      cancelled = true
    }
  }, [caseId, token, leftOpen.events])

  useEffect(() => {
    if (!caseId || !leftOpen.finance) return
    let cancelled = false
    void apiFetch<FinanceOut>(`/cases/${caseId}/finance`, { token })
      .then((d) => {
        if (!cancelled) setFinancePreview(d)
      })
      .catch(() => {
        if (!cancelled) setFinancePreview(null)
      })
    return () => {
      cancelled = true
    }
  }, [caseId, token, leftOpen.finance])

  useEffect(() => {
    if (!caseEditOpen) return
    setEditMatterDescription(caseDetail?.matter_description ?? '')
    setEditPracticeArea(caseDetail?.matter_sub_type_id ?? '')
    setEditFeeEarner(caseDetail?.fee_earner_user_id ?? '')
    setEditCaseStatus(caseDetail?.status ?? 'open')
  }, [caseEditOpen, caseDetail])

  useLayoutEffect(() => {
    if (!docMenu) {
      setDocMenuStyle(null)
      return
    }
    function reposition() {
      const m = docMenu
      const el = docMenuRef.current
      if (!m || !el) return
      setDocMenuStyle(computeDocContextMenuStyle(el, m.x, m.y))
    }
    reposition()
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [docMenu])

  useEffect(() => {
    if (!docMenu) return
    function onDocMouseDown() {
      setDocMenu(null)
      setMoveMenu(null)
    }
    window.addEventListener('mousedown', onDocMouseDown)
    return () => window.removeEventListener('mousedown', onDocMouseDown)
  }, [docMenu])

  useEffect(() => {
    if (!newMenuOpen) return
    function onDocMouseDown(e: MouseEvent) {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setNewMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [newMenuOpen])

  useEffect(() => {
    if (!taskCreateOpen || !caseId) {
      setStandardTaskTemplates([])
      return
    }
    let cancelled = false
    async function loadStd() {
      try {
        const data = await apiFetch<MatterSubTypeStandardTaskOut[]>(`/cases/${caseId}/standard-tasks`, { token })
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        setStandardTaskTemplates(list)
        setTaskCreateStandardId((prev) => {
          if (prev !== '__custom__' && list.some((x) => x.id === prev)) return prev
          return list.length > 0 ? list[0].id : '__custom__'
        })
      } catch {
        if (!cancelled) {
          setStandardTaskTemplates([])
          setTaskCreateStandardId('__custom__')
        }
      }
    }
    void loadStd()
    return () => {
      cancelled = true
    }
  }, [taskCreateOpen, caseId, token])

  useEffect(() => {
    if (!taskCreateOpen) setTaskCreateTitleOverride(null)
  }, [taskCreateOpen])

  useEffect(() => {
    if (!taskCreateOpen) return
    const t = new Date()
    const y = t.getFullYear()
    const mo = String(t.getMonth() + 1).padStart(2, '0')
    const d = String(t.getDate()).padStart(2, '0')
    setTaskCreateDueDate(`${y}-${mo}-${d}`)
    setTaskCreatePrivate(false)
  }, [taskCreateOpen])

  useEffect(() => {
    if (!taskCreateOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !taskCreateBusy) setTaskCreateOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [taskCreateOpen, taskCreateBusy])

  useEffect(() => {
    if (!precedentPicker) {
      setPrecedentChoices([])
      setPrecedentCategories([])
      setPrecedentPickerCategoryId(null)
      setPrecedentSearch('')
      return
    }
    const subId = caseDetail?.matter_sub_type_id
    if (!subId) {
      setPrecedentCategories([])
      setPrecedentChoices([])
      setPrecedentPickerCategoryId(null)
      setPrecedentChosenId(null)
      setPrecedentSearch('')
      return
    }
    const kind = precedentPicker.kind
    let cancelled = false
    async function load() {
      try {
        const [cats, list] = await Promise.all([
          apiFetch<PrecedentCategoryOut[]>(`/matter-types/sub-types/${subId}/precedent-categories`, { token }),
          apiFetch<PrecedentOut[]>(`/precedents?kind=${kind}&matter_sub_type_id=${subId}`, { token }),
        ])
        if (cancelled) return
        setPrecedentCategories(cats)
        setPrecedentChoices(list)
        setPrecedentChosenId(null)
        setPrecedentSearch('')
        setPrecedentPickerCategoryId(cats.length > 0 ? cats[0].id : null)
      } catch {
        if (!cancelled) {
          setPrecedentCategories([])
          setPrecedentChoices([])
          setPrecedentPickerCategoryId(null)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [precedentPicker, token, caseDetail?.matter_sub_type_id, caseDetail?.id])

  const filteredPrecedentChoices = useMemo(() => {
    if (precedentPickerCategoryId === null) return []
    const base = precedentChoices.filter((p) => p.category_id === precedentPickerCategoryId)
    const s = precedentSearch.trim().toLowerCase()
    if (!s) return base
    return base.filter(
      (p) => p.name.toLowerCase().includes(s) || p.reference.toLowerCase().includes(s),
    )
  }, [precedentChoices, precedentPickerCategoryId, precedentSearch])

  const filteredFiles = useMemo(() => {
    const s = docSearch.trim().toLowerCase()
    if (!s) return files
    const matches = (f: FileSummary) => f.original_filename.toLowerCase().includes(s)
    const expanded = new Set<string>(files.filter(matches).map((f) => f.id))
    let changed = true
    while (changed) {
      changed = false
      for (const f of files) {
        if (expanded.has(f.id)) continue
        if (f.parent_file_id && expanded.has(f.parent_file_id)) {
          expanded.add(f.id)
          changed = true
        }
      }
      for (const f of files) {
        if (!expanded.has(f.id)) continue
        if (f.parent_file_id && !expanded.has(f.parent_file_id)) {
          expanded.add(f.parent_file_id)
          changed = true
        }
      }
    }
    return files.filter((f) => expanded.has(f.id))
  }, [files, docSearch])

  const filesInFolder = useMemo(() => {
    return filteredFiles.filter((f) => (f.folder_path ?? '') === docFolder && f.category !== 'system')
  }, [filteredFiles, docFolder])

  // Group artifacts (e.g. imported emails with attachments) under a parent `.eml` row.
  // Attachments are represented as child files with `parent_file_id` set.
  const topLevelInFolder = useMemo(() => {
    return filesInFolder.filter((f) => !f.parent_file_id)
  }, [filesInFolder])

  const childrenByParentId = useMemo(() => {
    const map = new Map<string, FileSummary[]>()
    for (const f of filesInFolder) {
      if (!f.parent_file_id) continue
      const pid = f.parent_file_id
      const arr = map.get(pid) ?? []
      arr.push(f)
      map.set(pid, arr)
    }
    return map
  }, [filesInFolder])

  const childFolders = useMemo(() => {
    const set = new Set<string>()
    const basePrefix = docFolder ? `${docFolder}/` : ''
    for (const f of filteredFiles) {
      const fp = f.folder_path ?? ''
      if (fp === docFolder) continue
      if (docFolder && !fp.startsWith(basePrefix)) continue
      const rest = docFolder ? fp.slice(basePrefix.length) : fp
      const [first] = rest.split('/').filter(Boolean)
      if (first) set.add(first)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [filteredFiles, docFolder])

  const allFolderPaths = useMemo(() => {
    const set = new Set<string>()
    for (const f of files) {
      const fp = (f.folder_path ?? '').trim()
      if (!fp) continue
      const parts = fp.split('/').filter(Boolean)
      let cur = ''
      for (const p of parts) {
        cur = cur ? `${cur}/${p}` : p
        set.add(cur)
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [files])

  const sortedChildFolders = useMemo(() => {
    const dir = docSortDir === 'asc' ? 1 : -1
    return [...childFolders].sort((a, b) => a.localeCompare(b) * dir)
  }, [childFolders, docSortDir])

  const matterFilesNonSystem = useMemo(
    () => files.filter((f) => f.category !== 'system'),
    [files],
  )

  const emailAttachChildFolders = useMemo(() => {
    const folder = emailAttachBrowseFolder
    const set = new Set<string>()
    const basePrefix = folder ? `${folder}/` : ''
    for (const f of matterFilesNonSystem) {
      const fp = f.folder_path ?? ''
      if (fp === folder) continue
      if (folder && !fp.startsWith(basePrefix)) continue
      const rest = folder ? fp.slice(basePrefix.length) : fp
      const [first] = rest.split('/').filter(Boolean)
      if (first) set.add(first)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [matterFilesNonSystem, emailAttachBrowseFolder])

  const emailAttachFilesInBrowseFolder = useMemo(() => {
    const skipComment = (f: FileSummary) =>
      (f.mime_type || '').toLowerCase().startsWith('text/plain') ||
      (f.original_filename || '').toLowerCase().endsWith('.txt')
    return matterFilesNonSystem
      .filter(
        (f) =>
          (f.folder_path ?? '') === emailAttachBrowseFolder &&
          !f.parent_file_id &&
          !skipComment(f),
      )
      .sort((a, b) => a.original_filename.localeCompare(b.original_filename))
  }, [matterFilesNonSystem, emailAttachBrowseFolder])

  const sortedPinnedInFolder = useMemo(() => {
    const dir = docSortDir === 'asc' ? 1 : -1
    const compare = (a: FileSummary, b: FileSummary) => {
      const av =
        docSortKey === 'description'
          ? a.original_filename
          : docSortKey === 'size'
            ? a.size_bytes
            : docSortKey === 'modified'
              ? a.updated_at ?? a.created_at
              : a.owner_display_name ?? a.owner_email ?? ''
      const bv =
        docSortKey === 'description'
          ? b.original_filename
          : docSortKey === 'size'
            ? b.size_bytes
            : docSortKey === 'modified'
              ? b.updated_at ?? b.created_at
              : b.owner_display_name ?? b.owner_email ?? ''
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    }

    const pinnedParents = topLevelInFolder.filter((f) => f.is_pinned)
    const sortedParents = [...pinnedParents].sort(compare)

    const out: FileSummary[] = []
    for (const p of sortedParents) {
      out.push(p)
      const kids = childrenByParentId.get(p.id) ?? []
      out.push(...kids.sort(compare))
    }
    return out
  }, [topLevelInFolder, childrenByParentId, docSortDir, docSortKey])

  const sortedRegularInFolder = useMemo(() => {
    const dir = docSortDir === 'asc' ? 1 : -1
    const compare = (a: FileSummary, b: FileSummary) => {
      const av =
        docSortKey === 'description'
          ? a.original_filename
          : docSortKey === 'size'
            ? a.size_bytes
            : docSortKey === 'modified'
              ? a.updated_at ?? a.created_at
              : a.owner_display_name ?? a.owner_email ?? ''
      const bv =
        docSortKey === 'description'
          ? b.original_filename
          : docSortKey === 'size'
            ? b.size_bytes
            : docSortKey === 'modified'
              ? b.updated_at ?? b.created_at
              : b.owner_display_name ?? b.owner_email ?? ''
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    }

    const regularParents = topLevelInFolder.filter((f) => !f.is_pinned)
    const sortedParents = [...regularParents].sort(compare)

    const out: FileSummary[] = []
    for (const p of sortedParents) {
      out.push(p)
      const kids = childrenByParentId.get(p.id) ?? []
      out.push(...kids.sort(compare))
    }
    return out
  }, [topLevelInFolder, childrenByParentId, docSortDir, docSortKey])

  const breadcrumbParts = useMemo(() => {
    if (!docFolder) return []
    return docFolder.split('/').filter(Boolean)
  }, [docFolder])

  // Flat ordered key list for shift-range selection.
  // Files use their ID; folders use "folder:<path>".
  const allDocKeys = useMemo(() => [
    ...sortedPinnedInFolder.map((f) => f.id),
    ...sortedChildFolders.map((name) => `folder:${docFolder ? `${docFolder}/${name}` : name}`),
    ...sortedRegularInFolder.map((f) => f.id),
  ], [sortedPinnedInFolder, sortedChildFolders, sortedRegularInFolder, docFolder])

  function handleDocItemClick(key: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (e.shiftKey && docAnchorRef.current) {
      const anchorIdx = allDocKeys.indexOf(docAnchorRef.current)
      const currentIdx = allDocKeys.indexOf(key)
      if (anchorIdx !== -1 && currentIdx !== -1) {
        const [lo, hi] = anchorIdx <= currentIdx ? [anchorIdx, currentIdx] : [currentIdx, anchorIdx]
        const range = new Set(allDocKeys.slice(lo, hi + 1))
        setSelectedDocSet(e.ctrlKey || e.metaKey ? (prev) => new Set([...prev, ...range]) : range)
      }
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedDocSet((prev) => {
        const next = new Set(prev)
        if (next.has(key)) { next.delete(key) } else { next.add(key) }
        return next
      })
      docAnchorRef.current = key
    } else {
      setSelectedDocSet(new Set([key]))
      docAnchorRef.current = key
    }
  }

  async function uploadFilesToCurrentFolder(incomingFiles: File[]) {
    if (incomingFiles.length === 0) return
    setBusy(true)
    setActionErr(null)
    try {
      for (const f of incomingFiles) {
        const form = new FormData()
        form.append('upload', f)
        form.append('folder', docFolder)
        await fetch(apiUrl(`/cases/${caseId}/files`), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        }).then(async (r) => {
          if (r.status === 401) {
            localStorage.removeItem('token')
            window.location.reload()
            return
          }
          if (!r.ok) throw new Error((await r.text()) || r.statusText)
        })
      }
      onRefresh()
    } catch (err: any) {
      setActionErr(err?.message ?? 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function uploadLocalFilesForEmailAttach(incomingFiles: File[]) {
    if (!caseId || incomingFiles.length === 0) return
    setBusy(true)
    setActionErr(null)
    try {
      const collected: string[] = []
      for (const f of incomingFiles) {
        const form = new FormData()
        form.append('upload', f)
        form.append('folder', docFolder)
        const r = await fetch(apiUrl(`/cases/${caseId}/files`), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        })
        if (r.status === 401) {
          localStorage.removeItem('token')
          window.location.reload()
          return
        }
        if (!r.ok) {
          const t = await r.text()
          throw new Error(t || r.statusText)
        }
        const j = (await r.json()) as { id?: string }
        if (j.id) collected.push(j.id)
      }
      if (collected.length) {
        setEmailAttachIds((prev) => {
          const next = [...prev]
          for (const id of collected) {
            if (!next.includes(id) && next.length < 25) next.push(id)
          }
          return next
        })
      }
      onRefresh()
    } catch (err: unknown) {
      const e = err as { message?: string }
      setActionErr(e?.message ?? 'Upload failed')
    } finally {
      setBusy(false)
      if (emailLocalAttachInputRef.current) emailLocalAttachInputRef.current.value = ''
    }
  }

  function createFolderAtCurrentPath() {
    setTextPrompt({
      title: 'New folder',
      hint: 'Enter a folder name (no slashes).',
      initial: '',
      confirmLabel: 'Create',
      onConfirm: (name) => {
        const trimmed = name.trim()
        setTextPrompt(null)
        if (!trimmed) return
        const folder_path = docFolder ? `${docFolder}/${trimmed}` : trimmed
        if (!folder_path) return
        setBusy(true)
        setActionErr(null)
        apiFetch(`/cases/${caseId}/files/folders`, { token, method: 'POST', json: { folder_path } })
          .then(() => onRefresh())
          .catch((e: any) => setActionErr(e?.message ?? 'Failed to create folder'))
          .finally(() => setBusy(false))
      },
    })
  }

  async function composeOfficeFile(
    originalFilename: string,
    precedentId: string | null,
    caseContactId?: string | null,
    globalContactId?: string | null,
    precedentMergeAllClients?: boolean,
  ) {
    if (!caseId) return
    setBusy(true)
    setActionErr(null)
    try {
      const res = await apiFetch<{ id: string }>(`/cases/${caseId}/files/compose-office`, {
        token,
        json: {
          original_filename: originalFilename,
          folder: docFolder,
          precedent_id: precedentId,
          case_contact_id: caseContactId ?? null,
          global_contact_id: globalContactId ?? null,
          precedent_merge_all_clients: Boolean(precedentMergeAllClients),
        },
      })
      window.open(`/editor/${caseId}/${res.id}`, '_blank')
    } catch (e: any) {
      setActionErr(e?.message ?? 'Could not create document')
    } finally {
      setBusy(false)
    }
  }

  async function composeM365EmailDraft(
    precedentId: string | null,
    caseContactId: string | null,
    globalContactId: string | null,
    precedentMergeAllClients: boolean,
    attachmentFileIds: string[],
  ) {
    if (!caseId) return
    /* Open a tab synchronously on the click path so popup blockers allow navigation after `await`.
     * Do not pass `noopener` here: with noopener many browsers return `null` while still opening a tab,
     * so we cannot call `location.replace` and the user sees a blank orphan tab. */
    const handoffTab = window.open('about:blank', '_blank')
    setBusy(true)
    setActionErr(null)
    try {
      const res = await apiFetch<CaseEmailDraftM365Out>(`/cases/${caseId}/files/email-drafts/m365`, {
        token,
        json: {
          folder: docFolder,
          precedent_id: precedentId,
          case_contact_id: caseContactId,
          global_contact_id: globalContactId,
          precedent_merge_all_clients: precedentMergeAllClients,
          attachment_file_ids: attachmentFileIds,
        },
      })
      const rawOpen = (res.open_url || '').trim()
      if (!rawOpen) {
        const msg = 'The server did not return an Outlook link. Check Microsoft Graph and try again.'
        showHandoffTabError(handoffTab, msg)
        setActionErr(msg)
        return
      }
      const url = browserAbsoluteApiUrl(rawOpen)
      if (handoffTab) {
        handoffTab.location.replace(url)
      } else {
        const w = window.open(url, '_blank')
        if (!w) {
          setActionErr(
            'Your browser blocked opening Outlook. Allow pop-ups for this site, or copy the draft link from the browser network response.',
          )
        }
      }
    } catch (e: unknown) {
      const msg = formatHandoffCaughtError(e)
      showHandoffTabError(handoffTab, msg)
      setActionErr(msg)
    } finally {
      setBusy(false)
    }
  }

  function isCommentFile(f: FileSummary) {
    return (
      (f.mime_type || '').toLowerCase().startsWith('text/plain') ||
      (f.original_filename || '').toLowerCase().endsWith('.txt')
    )
  }

  async function openCommentForEdit(f: FileSummary) {
    if (!caseId) return
    setBusy(true)
    setActionErr(null)
    try {
      const res = await fetchCaseFileResponse(caseId, f.id, token)
      if (res.status === 401) { localStorage.removeItem('token'); window.location.reload(); return }
      if (!res.ok) throw new Error((await res.text()) || res.statusText)
      const text = await res.text()
      setCommentText(text)
      setCommentEditFileId(f.id)
      setCommentErr(null)
      setCommentOpen(true)
    } catch (e: any) {
      setActionErr(e?.message ?? 'Could not load comment')
    } finally {
      setBusy(false)
    }
  }

  async function previewEmlFile(f: FileSummary) {
    if (!caseId) return
    setEmlPreviewOpen(true)
    setEmlPreviewFile(f)
    setEmlPreviewData(null)
    setEmlPreviewErr(null)
    setEmlPreviewBusy(true)
    try {
      const raw = await fetchEmlTextForPreview(caseId, f.id, token)
      if (!raw) return
      let parsed: EmlPreviewData
      try {
        parsed = parseEmlForPreview(raw)
      } catch (pe: unknown) {
        setEmlPreviewErr(pe instanceof Error ? pe.message : 'Could not parse e-mail')
        return
      }
      setEmlPreviewData(parsed)
    } catch (e: unknown) {
      const msg = fetchTimedOutMessage(e)
      const err = e as { message?: string }
      setEmlPreviewErr(msg ?? err.message ?? 'Could not load preview')
    } finally {
      setEmlPreviewBusy(false)
    }
  }

  async function openCaseFile(f: FileSummary) {
    if (!caseId) return
    /** Prefer the row from the live ``files`` list so OWA fields (REST item id, Message-ID) stay current. */
    const file = files.find((x) => x.id === f.id) ?? f
    // Comment files (.txt) open in the comment editor, not the browser
    if (isCommentFile(file)) {
      void openCommentForEdit(file)
      return
    }

    if (isOfficeLikeFile(file)) {
      window.open(`/editor/${caseId}/${file.id}`, '_blank')
      return
    }

    if (isEmlLikeFileSummary(file)) {
      const pref = currentUser?.email_launch_preference ?? 'desktop'
      if (pref === 'outlook_web') {
        setBusy(true)
        setActionErr(null)
        try {
          const owaBase = currentUser?.email_outlook_web_url ?? null
          const loginHint = currentUser?.email?.trim() || null
          let hints: { outlook_graph_message_id: string | null; outlook_web_link: string | null } | null = null
          try {
            hints = await apiFetch<{
              outlook_graph_message_id: string | null
              outlook_web_link: string | null
            }>(`/cases/${caseId}/files/${file.id}/outlook-open-hints`, { token })
          } catch {
            hints = null
          }
          const web = ((hints?.outlook_web_link ?? file.outlook_web_link) || '').trim()
          const gid = (
            (hints?.outlook_graph_message_id ?? file.outlook_graph_message_id ?? file.source_outlook_item_id) ||
            ''
          ).trim()
          if (web) {
            const url = appendOutlookWebAuthHintsForNav(browserAbsoluteApiUrl(web), loginHint)
            const ok = openOutlookWebAppFromGraphWebLink(url)
            if (!ok) {
              setActionErr('Your browser blocked the Outlook window. Allow pop-ups for this site, then try again.')
            }
            return
          }
          if (gid) {
            const readUrl = buildOutlookWebReadUrlFromGraphMessageId(gid, owaBase)
            const url = appendOutlookWebAuthHintsForNav(browserAbsoluteApiUrl(readUrl), loginHint)
            const ok = openOutlookWebAppFromGraphWebLink(url)
            if (!ok) {
              setActionErr('Your browser blocked the Outlook window. Allow pop-ups for this site, then try again.')
            }
            return
          }
          const storedMid = (file.source_internet_message_id ?? '').trim()
          if (storedMid) {
            const url = buildOutlookWebMessageSearchUrl(owaBase, storedMid)
            window.open(browserAbsoluteApiUrl(url), '_blank', 'noopener,noreferrer')
            return
          }
          const res = await fetchCaseFileResponse(caseId, file.id, token)
          if (res.status === 401) {
            localStorage.removeItem('token')
            window.location.reload()
            return
          }
          if (!res.ok) throw new Error((await res.text()) || res.statusText)
          const text = await res.text()
          const mid = extractInternetMessageIdFromEmlText(text)
          if (mid) {
            const url = buildOutlookWebMessageSearchUrl(owaBase, mid)
            window.open(browserAbsoluteApiUrl(url), '_blank', 'noopener,noreferrer')
          } else {
            openCanaryEmailLauncher(currentUser)
            setActionErr(
              'This message has no Message-ID header. Opened your mailbox; use Download or desktop Open to view the file.',
            )
          }
        } catch (e: unknown) {
          const msg = fetchTimedOutMessage(e)
          const err = e as { message?: string }
          setActionErr(msg ?? err.message ?? 'Open failed')
        } finally {
          setBusy(false)
        }
        return
      }

      /* Desktop / default: never use blob: URLs for message/rfc822 — Chromium often shows an endless
       * “Loading” tab. Issue a short-lived token and GET .../eml-open (attachment) so the browser
       * downloads or hands off to the OS mail app. Open a tab synchronously so popup rules still apply.
       * Avoid `noopener` on this open — see composeM365EmailDraft (must keep Window for location.replace). */
      const emlHandoffTab = window.open('about:blank', '_blank')
      setBusy(true)
      setActionErr(null)
      try {
        const data = await apiFetch<{ token: string }>(`/cases/${caseId}/files/${file.id}/eml-open-token`, {
          method: 'POST',
          token,
        })
        const url = browserAbsoluteApiUrl(
          apiUrl(`/cases/${caseId}/files/${file.id}/eml-open?token=${encodeURIComponent(data.token)}`),
        )
        if (emlHandoffTab) {
          emlHandoffTab.location.replace(url)
        } else {
          window.location.assign(url)
        }
      } catch (e: unknown) {
        const msg = fetchTimedOutMessage(e) ?? (e as { message?: string }).message ?? 'Could not open e-mail'
        showHandoffTabError(emlHandoffTab, msg)
        setActionErr(msg)
      } finally {
        setBusy(false)
      }
      return
    }

    setBusy(true)
    setActionErr(null)
    try {
      const res = await fetchCaseFileResponse(caseId, file.id, token)
      if (res.status === 401) {
        localStorage.removeItem('token')
        window.location.reload()
        return
      }
      if (!res.ok) throw new Error((await res.text()) || res.statusText)
      const blob = await res.blob()
      const typed = file.mime_type ? new Blob([blob], { type: file.mime_type }) : blob
      const url = URL.createObjectURL(typed)
      window.open(url, '_blank', 'noopener,noreferrer')
      window.setTimeout(() => URL.revokeObjectURL(url), 120_000)
    } catch (e: unknown) {
      const msg = fetchTimedOutMessage(e)
      const err = e as { message?: string }
      setActionErr(msg ?? err.message ?? 'Open failed')
    } finally {
      setBusy(false)
    }
  }

  async function downloadCaseFile(f: FileSummary) {
    if (!caseId) return
    setBusy(true)
    setActionErr(null)
    try {
      const res = await fetchCaseFileResponse(caseId, f.id, token)
      if (res.status === 401) {
        localStorage.removeItem('token')
        window.location.reload()
        return
      }
      if (!res.ok) throw new Error((await res.text()) || res.statusText)
      const blob = await res.blob()
      const typed = f.mime_type ? new Blob([blob], { type: f.mime_type }) : blob
      const url = URL.createObjectURL(typed)
      const safeName = f.original_filename.replace(/[/\\]/g, '_').replace(/^\.+/, '') || 'download'
      const a = document.createElement('a')
      a.href = url
      a.download = safeName
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 120_000)
    } catch (e: unknown) {
      const msg = fetchTimedOutMessage(e)
      const err = e as { message?: string }
      setActionErr(msg ?? err.message ?? 'Download failed')
    } finally {
      setBusy(false)
    }
  }

  function resetContactPickForm() {
    setPickMatterCcId('none')
    setPickGlobalId(null)
    setPickLinkGlobal(false)
    setPickLinkType('')
    setPickLawyerClientIds([])
    setPickSearch('')
    setEmailAttachIds([])
    setEmailAttachBrowseFolder('')
    setEmailAttachCanaryOpen(false)
  }

  function confirmPrecedentPicker() {
    if (!precedentPicker) return
    const pid = precedentChosenId
    if (precedentPicker.kind === 'document') {
      setPrecedentPicker(null)
      void composeOfficeFile(`Document — ${new Date().toISOString().slice(0, 10)}.docx`, pid)
      return
    }
    if (precedentPicker.kind === 'letter') {
      setPrecedentPicker(null)
      resetContactPickForm()
      setContactPickModal({ precedentId: pid, composeKind: 'letter' })
      return
    }
    if (precedentPicker.kind === 'email') {
      setPrecedentPicker(null)
      resetContactPickForm()
      setContactPickModal({ precedentId: pid, composeKind: 'email' })
      return
    }
  }

  async function confirmContactPick() {
    if (!contactPickModal || !caseId) return
    setBusy(true)
    setActionErr(null)
    try {
      if (pickGlobalId) {
        const g = contacts.find((c) => c.id === pickGlobalId)
        if (!g) {
          setActionErr('Global contact not found.')
          return
        }
        if (pickLinkGlobal) {
          if (!pickLinkType.trim()) {
            setActionErr('Contact type is required when linking to this matter.')
            return
          }
          if (pickLinkType.trim().toLowerCase() === LAWYERS_TYPE_SLUG && pickLawyerClientIds.length < 1) {
            setActionErr('Select one or more clients for this lawyer contact.')
            return
          }
          const linkJson: Record<string, unknown> = {
            contact_id: pickGlobalId,
            matter_contact_type: pickLinkType.trim(),
            matter_contact_reference: null,
          }
          if (pickLinkType.trim().toLowerCase() === LAWYERS_TYPE_SLUG) {
            linkJson.lawyer_client_ids = pickLawyerClientIds
          }
          await apiFetch(`/cases/${caseId}/contacts`, {
            token,
            json: linkJson,
          })
          onRefresh()
        }
      }

      let label = 'Letter'
      let caseContactIdForMerge: string | null = null
      let globalContactIdForMerge: string | null = null
      let mergeAllClients = false
      if (pickMatterCcId === 'all_clients') {
        label = 'All clients'
        mergeAllClients = true
      } else if (pickMatterCcId && pickMatterCcId !== 'none') {
        label = caseContacts.find((c) => c.id === pickMatterCcId)?.name ?? 'Letter'
        caseContactIdForMerge = pickMatterCcId
      } else if (pickGlobalId) {
        label = contacts.find((c) => c.id === pickGlobalId)?.name ?? 'Letter'
        globalContactIdForMerge = pickGlobalId
      }

      const composeKind = contactPickModal.composeKind ?? 'letter'
      if (composeKind === 'email') {
        if (mergeAllClients) {
          setActionErr(
            'Choose a single matter contact or global contact with an e-mail (not “All clients”) for e-mail.',
          )
          return
        }
        await composeM365EmailDraft(
          contactPickModal.precedentId,
          caseContactIdForMerge,
          globalContactIdForMerge,
          mergeAllClients,
          emailAttachIds,
        )
        setContactPickModal(null)
        resetContactPickForm()
        return
      }

      const fn = `Letter — ${label.replace(/[/\\]/g, '_').slice(0, 120)}.docx`
      await composeOfficeFile(
        fn,
        contactPickModal.precedentId,
        caseContactIdForMerge,
        globalContactIdForMerge,
        mergeAllClients,
      )
      setContactPickModal(null)
      resetContactPickForm()
    } catch (e: any) {
      setActionErr(e?.message ?? 'Failed')
    } finally {
      setBusy(false)
    }
  }

  if (!caseId || !matterScopeId)
    return error ? <div className="error">{error}</div> : <div className="empty">Loading…</div>

  return (
    <div className="caseShell">
      <div className="caseToolbar" role="toolbar" aria-label="Case actions and documents">
        <div className="caseToolbarLeft">
          <button type="button" className="btn" disabled={busy} onClick={() => setCaseEditOpen(true)}>
            Edit details
          </button>
          <button
            type="button"
            className="btn"
            style={{ marginLeft: 8 }}
            onClick={() =>
              window.open(`${window.location.origin}${window.location.pathname}?tasks=${caseId}`, '_blank')
            }
          >
            Tasks
          </button>
          <button
            type="button"
            className="btn"
            style={{ marginLeft: 8 }}
            onClick={() => window.open(`${window.location.origin}${window.location.pathname}?ledger=${caseId}`, '_blank')}
          >
            Ledger
          </button>
        </div>
        <div className="caseToolbarMain">
          <div className="caseToolbarGroup caseToolbarDocs">
            <div className="caseToolbarDropdownWrap" ref={newMenuRef}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                aria-haspopup="menu"
                aria-expanded={newMenuOpen}
                onClick={() => setNewMenuOpen((o) => !o)}
              >
                New <span aria-hidden>▾</span>
              </button>
              {newMenuOpen ? (
                <div className="caseToolbarDropdown" role="menu">
                  <button
                    type="button"
                    className="caseToolbarDropdownItem"
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false)
                      createFolderAtCurrentPath()
                    }}
                  >
                    Folder
                  </button>
                  <button
                    type="button"
                    className="caseToolbarDropdownItem"
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false)
                      setTaskCreateErr(null)
                      setTaskCreateCustomTitle('')
                      setTaskCreateTitleOverride(null)
                      setTaskCreateDueDate('')
                      setTaskCreateAssignUserId('')
                      setTaskCreateOpen(true)
                    }}
                  >
                    Task
                  </button>
                  <button
                    type="button"
                    className="caseToolbarDropdownItem"
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false)
                      setPrecedentPicker({ kind: 'letter' })
                    }}
                  >
                    Letter
                  </button>
                  <button
                    type="button"
                    className="caseToolbarDropdownItem"
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false)
                      setPrecedentPicker({ kind: 'document' })
                    }}
                  >
                    Document
                  </button>
                  <button
                    type="button"
                    className="caseToolbarDropdownItem"
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false)
                      setPrecedentPicker({ kind: 'email' })
                    }}
                  >
                    E-mail
                  </button>
                  <button
                    type="button"
                    className="caseToolbarDropdownItem"
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false)
                      setCommentText('')
                      setCommentErr(null)
                      setCommentOpen(true)
                    }}
                  >
                    Comment
                  </button>
                </div>
              ) : null}
            </div>
            <button type="button" className="btn" disabled={busy} onClick={() => importInputRef.current?.click()}>
              Import
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => onRefresh()}>
              Refresh
            </button>
          </div>
          <SearchInput
            className="caseToolbarSearch"
            placeholder="Search documents…"
            value={docSearch}
            onChange={(e) => setDocSearch(e.target.value)}
            onClear={() => setDocSearch('')}
            aria-label="Search documents"
          />
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {actionErr ? <div className="error">{actionErr}</div> : null}

      <div
        className="caseGrid"
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <div className="caseLeft">
          <div className="card caseDetailsCard">
            <h3>Case details</h3>
            <dl className="caseDetailsList">
              <div className="caseDetailRow">
                <dt>Reference</dt>
                <dd>
                  <span className="mono">{caseDetail.case_number}</span>
                </dd>
              </div>
              <div className="caseDetailRow">
                <dt>Client</dt>
                <dd>{caseDetail.client_name ?? '—'}</dd>
              </div>
              <div className="caseDetailRow">
                <dt>Matter type</dt>
                <dd>{matterTypeDisplayLine(caseDetail)}</dd>
              </div>
              <div className="caseDetailRow">
                <dt>Description</dt>
                <dd>{caseDetail.matter_description}</dd>
              </div>
              <div className="caseDetailRow">
                <dt>Status</dt>
                <dd>
                  {formatCaseStatusLabel(caseDetail.status)}
                </dd>
              </div>
              <div className="caseDetailRow">
                <dt>Fee earner</dt>
                <dd>{users.find((u) => u.id === caseDetail.fee_earner_user_id)?.display_name ?? '—'}</dd>
              </div>
              <div className="caseDetailRow">
                <dt>Lock</dt>
                <dd>
                  {caseHasRevokedUserAccess(caseDetail)
                    ? 'Locked'
                    : !caseDetail.is_locked || caseDetail.lock_mode === 'none'
                      ? 'Unlocked'
                      : caseDetail.lock_mode}
                </dd>
              </div>
            </dl>
          </div>

          <div className="card">
            <div className="accordion">
              <button className="accHead" onClick={() => setLeftOpen({ ...leftOpen, contacts: !leftOpen.contacts })}>
                <span>Contacts</span>
                <span className="muted">{leftOpen.contacts ? '▾' : '▸'}</span>
              </button>
              {leftOpen.contacts ? (
                <div className="accBody">
                  {contactAddOpen ? <div className="muted" style={{ fontSize: 13 }}>Adding contact…</div> : null}
                  {!contactAddOpen ? (
                    <>
                      <div className="list caseLeftContactsList">
                        {caseContactsMenuOrder.map((cc) => (
                          <div
                            key={cc.id}
                            className="listCard row"
                            style={{ justifyContent: 'space-between', alignItems: 'center' }}
                            onDoubleClick={() => {
                              if (busy) return
                              setContactAddOpen(false)
                              setEditSnapshot(cc)
                              setPushToGlobal(false)
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              setContactRowMenu({ cc, x: e.clientX, y: e.clientY })
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div className="listTitle">{cc.name}</div>
                              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                                {matterContactTypeLabel(cc.matter_contact_type, matterTypeOptions)}
                              </div>
                            </div>
                            <button
                              className="btn"
                              disabled={busy}
                              onClick={() => {
                                setContactAddOpen(false)
                                setEditSnapshot(cc)
                                setPushToGlobal(false)
                              }}
                            >
                              Edit
                            </button>
                          </div>
                        ))}
                        {caseContacts.length === 0 ? <div className="muted">No contacts yet.</div> : null}
                      </div>
                      {contactRowMenu ? (
                        <div
                          ref={contactRowMenuRef}
                          className="docContextMenu"
                          style={{
                            position: 'fixed',
                            left: contactRowMenu.x,
                            top: contactRowMenu.y,
                            zIndex: 40,
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <div
                            className="docContextItem"
                            role="menuitem"
                            tabIndex={0}
                            onClick={() => {
                              const cc = contactRowMenu.cc
                              setContactRowMenu(null)
                              setContactAddOpen(false)
                              setEditSnapshot(cc)
                              setPushToGlobal(false)
                            }}
                          >
                            Open
                          </div>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        className="btn primary"
                        style={{ marginTop: 8, width: '100%', boxSizing: 'border-box' }}
                        disabled={busy}
                        onClick={() => {
                          setEditSnapshot(null)
                          setMatterContactType('')
                          setMatterContactReference('')
                          setLawyerLinkClientIds([])
                          setContactAddErr(null)
                          setContactAddOpen(true)
                        }}
                      >
                        Add contact…
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {hasPropertyMenu ? (
            <div className="card">
              <div className="accordion">
                <button
                  className="accHead"
                  onClick={() => setLeftOpen({ ...leftOpen, property: !leftOpen.property })}
                >
                  <span>Property</span>
                  <span className="muted">{leftOpen.property ? '▾' : '▸'}</span>
                </button>
                {leftOpen.property ? (
                  <div className="accBody">
                    {propertyLoading ? (
                      <div className="muted">Loading…</div>
                    ) : !propertyDetails?.has_details ? (
                      <>
                        <div className="muted">No details added</div>
                        <button
                          type="button"
                          className="btn primary"
                          style={{ marginTop: 8 }}
                          disabled={busy}
                          onClick={() => {
                            const blank: CasePropertyPayload = {
                              is_non_postal: false,
                              uk: {},
                              free_lines: ['', '', '', '', '', ''],
                              title_numbers: [],
                              tenure: null,
                            }
                            setPropertyDraft(blank)
                            setPropertyBaseline(JSON.parse(JSON.stringify(blank)) as CasePropertyPayload)
                            setPropertyModalOpen(true)
                          }}
                        >
                          Add
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="stack" style={{ gap: 4 }}>
                          {propertyDetails.payload.title_numbers
                            .map((t) => t.trim())
                            .filter(Boolean)
                            .map((t, i) => (
                              <div key={`title-${i}`}>Title number: {t}</div>
                            ))}
                          {propertyTenureLabel(propertyDetails.payload.tenure ?? undefined) ? (
                            <div>{propertyTenureLabel(propertyDetails.payload.tenure ?? undefined)}</div>
                          ) : null}
                          {(propertyDetails.payload.is_non_postal
                            ? propertyDetails.payload.free_lines
                            : [
                                propertyDetails.payload.uk.line1,
                                propertyDetails.payload.uk.line2,
                                propertyDetails.payload.uk.town,
                                propertyDetails.payload.uk.county,
                                propertyDetails.payload.uk.postcode,
                                propertyDetails.payload.uk.country,
                              ]
                          )
                            .map((ln) => (ln || '').trim())
                            .filter(Boolean)
                            .map((ln, i) => (
                              <div key={`prop-line-${i}`}>{ln}</div>
                            ))}
                        </div>
                        <button
                          type="button"
                          className="btn primary"
                          style={{ marginTop: 8 }}
                          disabled={busy}
                          onClick={() => {
                            const d: CasePropertyPayload = {
                              ...propertyDetails.payload,
                              free_lines: [...propertyDetails.payload.free_lines],
                              title_numbers: [...propertyDetails.payload.title_numbers],
                              tenure: propertyDetails.payload.tenure ?? null,
                            }
                            setPropertyDraft(d)
                            setPropertyBaseline(JSON.parse(JSON.stringify(d)) as CasePropertyPayload)
                            setPropertyModalOpen(true)
                          }}
                        >
                          Edit
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {hasEventsMenu ? (
            <div className="card">
              <div className="accordion">
                <button
                  className="accHead"
                  onClick={() => setLeftOpen({ ...leftOpen, events: !leftOpen.events })}
                >
                  <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <span>Events</span>
                  </span>
                  <span className="muted">{leftOpen.events ? '▾' : '▸'}</span>
                </button>
                {leftOpen.events ? (
                  <div className="accBody">
                    {eventsPreview ? (
                      <div className="stack" style={{ gap: 6 }}>
                        {eventsPreview.events.length === 0 ? (
                          <div className="muted">No event lines yet.</div>
                        ) : (
                          eventsPreview.events.slice(0, 6).map((ev) => (
                            <div key={ev.id} className="muted" style={{ fontSize: 13 }}>
                              {ev.track_in_calendar ? (
                                <span title="Tracked in calendar" aria-hidden style={{ marginRight: 4 }}>
                                  🔔
                                </span>
                              ) : null}
                              <strong style={{ color: 'var(--text)' }}>{ev.name}</strong>
                              {ev.event_date
                                ? ` · ${new Date(ev.event_date).toLocaleDateString('en-GB')}`
                                : ' · No date'}
                            </div>
                          ))
                        )}
                        {eventsPreview.events.length > 6 ? (
                          <div className="muted" style={{ fontSize: 12 }}>
                            +{eventsPreview.events.length - 6} more…
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="muted">Loading…</div>
                    )}
                    <button
                      type="button"
                      className="btn primary"
                      style={{ marginTop: 8 }}
                      disabled={busy}
                      onClick={() => setEventsModalOpen(true)}
                    >
                      Edit
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {hasFinanceMenu ? (
            <div className="card">
              <div className="accordion">
                <button
                  className="accHead"
                  onClick={() => setLeftOpen({ ...leftOpen, finance: !leftOpen.finance })}
                >
                  <span>Finance</span>
                  <span className="muted">{leftOpen.finance ? '▾' : '▸'}</span>
                </button>
                {leftOpen.finance ? (
                  <div className="accBody">
                    {financePreview ? (
                      (() => {
                        const { dr, cr } = financeCaseTotals(financePreview)
                        const net = cr - dr
                        const creditBal = net >= 0
                        return (
                          <div className="stack" style={{ gap: 6, fontSize: 14 }}>
                            <div>
                              Credits: <strong>{penceGb(cr)}</strong>
                            </div>
                            <div>
                              Debits: <strong>{penceGb(dr)}</strong>
                            </div>
                            <div style={{ color: creditBal ? 'var(--text)' : 'var(--danger)' }}>
                              Balance:{' '}
                              <strong>
                                {creditBal ? penceGb(net) : `-${penceGb(-net)}`}
                              </strong>
                            </div>
                          </div>
                        )
                      })()
                    ) : (
                      <div className="muted">Loading…</div>
                    )}
                    <button
                      type="button"
                      className="btn primary"
                      style={{ marginTop: 8 }}
                      disabled={busy}
                      onClick={() => setFinanceModalOpen(true)}
                    >
                      Edit
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Events modal */}
          {eventsModalOpen && caseId && (
            <div
              className="modalOverlay"
              role="dialog"
              aria-modal="true"
              aria-label="Events"
            >
              <div className="modal card modal--scrollBody" style={{ maxWidth: 720 }}>
                <div className="stack modalBodyScroll">
                  <EventsPage
                    caseId={caseId}
                    token={token}
                    caseLabel={
                      caseDetail
                        ? `${caseDetail.case_number}${caseDetail.matter_description ? ` — ${caseDetail.matter_description}` : ''}`.trim()
                        : ''
                    }
                    onClose={() => {
                      setEventsModalOpen(false)
                      void apiFetch<CaseEventsOut>(`/cases/${caseId}/events`, { token }).then(setEventsPreview).catch(() => {})
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Finance modal */}
          {financeModalOpen && caseId && (
            <div
              className="modalOverlay"
              role="dialog"
              aria-modal="true"
              aria-label="Finance"
            >
              <div className="modal card modal--scrollBody" style={{ maxWidth: 860 }}>
                <div className="stack modalBodyScroll">
                  <FinancePage
                    caseId={caseId}
                    token={token}
                    onClose={() => {
                      setFinanceModalOpen(false)
                      void apiFetch<FinanceOut>(`/cases/${caseId}/finance`, { token })
                        .then(setFinancePreview)
                        .catch(() => {})
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="caseRight">
          <div
            className={`card caseDocsCard${docsDragOver ? ' caseDocsCard--dragOver' : ''}`}
            onDragEnter={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!dndEventHasFiles(e)) return
              setDocsDragOver(true)
            }}
            onDragLeave={(e) => {
              const cur = e.currentTarget as HTMLElement
              const rel = e.relatedTarget as Node | null
              if (rel && cur.contains(rel)) return
              setDocsDragOver(false)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (dndEventHasFiles(e)) {
                e.dataTransfer.dropEffect = 'copy'
              } else {
                e.dataTransfer.dropEffect = 'none'
              }
            }}
            onClick={() => setSelectedDocSet(new Set())}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDocMenu({ kind: 'surface', x: e.clientX, y: e.clientY })
            }}
            onDrop={async (e) => {
              e.preventDefault()
              e.stopPropagation()
              setDocsDragOver(false)
              if (!dndEventHasFiles(e)) return
              const droppedFiles = Array.from(e.dataTransfer.files ?? [])
              await uploadFilesToCurrentFolder(droppedFiles)
            }}
          >
            <div className="caseDocsScroll">
              <div className="docsTr docsTh">
                <button
                  type="button"
                  className="thbtn"
                  onClick={() => {
                    if (docSortKey === 'description') setDocSortDir(docSortDir === 'asc' ? 'desc' : 'asc')
                    else {
                      setDocSortKey('description')
                      setDocSortDir('asc')
                    }
                  }}
                >
                  Description
                </button>
                <button
                  type="button"
                  className="thbtn docsCenter"
                  onClick={() => {
                    if (docSortKey === 'size') setDocSortDir(docSortDir === 'asc' ? 'desc' : 'asc')
                    else {
                      setDocSortKey('size')
                      setDocSortDir('asc')
                    }
                  }}
                >
                  Size
                </button>
                <button
                  type="button"
                  className="thbtn docsCenter"
                  onClick={() => {
                    if (docSortKey === 'modified') setDocSortDir(docSortDir === 'asc' ? 'desc' : 'asc')
                    else {
                      setDocSortKey('modified')
                      setDocSortDir('desc')
                    }
                  }}
                >
                  Modified
                </button>
                <button
                  type="button"
                  className="thbtn docsCenter"
                  onClick={() => {
                    if (docSortKey === 'user') setDocSortDir(docSortDir === 'asc' ? 'desc' : 'asc')
                    else {
                      setDocSortKey('user')
                      setDocSortDir('asc')
                    }
                  }}
                >
                  User
                </button>
              </div>
              <div
                className="muted"
                style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                onContextMenu={(e) => e.stopPropagation()}
              >
                <span
                  style={{ cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => setDocFolder('')}
                  title="Home"
                >
                  Home
                </span>
                {breadcrumbParts.map((p, idx) => {
                  const path = breadcrumbParts.slice(0, idx + 1).join('/')
                  return (
                    <span key={path} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <span aria-hidden> / </span>
                      <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setDocFolder(path)}>
                        {p}
                      </span>
                    </span>
                  )
                })}
              </div>

              {sortedPinnedInFolder.map((f) => (
                <div
                  key={f.id}
                  className={`docsTr rowbtn ${f.parent_file_id ? 'attachmentChild' : ''} ${selectedDocSet.has(f.id) ? 'active' : ''}`}
                  onMouseDown={(e) => { if (e.shiftKey) e.preventDefault() }}
                  onClick={(e) => handleDocItemClick(f.id, e)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (isEmlLikeFileSummary(f)) void previewEmlFile(f)
                    else void openCaseFile(f)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setDocMenu({ kind: 'file', fileId: f.id, x: e.clientX, y: e.clientY })
                  }}
                >
                  <DocsFileDescCell f={f} showPin={!f.parent_file_id} />
                  <div className="td docsCenter">{formatDocFileSize(f.size_bytes)}</div>
                  <div className="td docsCenter">{formatDocModified(f.updated_at ?? f.created_at)}</div>
                  <div className="td docsCenter">{f.owner_display_name ?? f.owner_email ?? '—'}</div>
                </div>
              ))}

              {sortedChildFolders.map((folderName) => {
                const next = docFolder ? `${docFolder}/${folderName}` : folderName
                const folderKey = `folder:${next}`
                return (
                  <div
                    key={next}
                    className={`docsTr rowbtn ${selectedDocSet.has(folderKey) ? 'active' : ''}`}
                    onMouseDown={(e) => { if (e.shiftKey) e.preventDefault() }}
                    onClick={(e) => handleDocItemClick(folderKey, e)}
                    onDoubleClick={() => setDocFolder(next)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setDocMenu({ kind: 'folder', folderPath: next, x: e.clientX, y: e.clientY })
                    }}
                  >
                    <DocsFolderDescCell name={folderName} />
                    <div className="td muted docsCenter">—</div>
                    <div className="td muted docsCenter">—</div>
                    <div className="td muted docsCenter">—</div>
                  </div>
                )
              })}

              {sortedRegularInFolder.map((f) => (
                <div
                  key={f.id}
                  className={`docsTr rowbtn ${f.parent_file_id ? 'attachmentChild' : ''} ${selectedDocSet.has(f.id) ? 'active' : ''}`}
                  onMouseDown={(e) => { if (e.shiftKey) e.preventDefault() }}
                  onClick={(e) => handleDocItemClick(f.id, e)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (isEmlLikeFileSummary(f)) void previewEmlFile(f)
                    else void openCaseFile(f)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setDocMenu({ kind: 'file', fileId: f.id, x: e.clientX, y: e.clientY })
                  }}
                >
                  <DocsFileDescCell f={f} showPin={false} />
                  <div className="td docsCenter">{formatDocFileSize(f.size_bytes)}</div>
                  <div className="td docsCenter">{formatDocModified(f.updated_at ?? f.created_at)}</div>
                  <div className="td docsCenter">{f.owner_display_name ?? f.owner_email ?? '—'}</div>
                </div>
              ))}

              {sortedPinnedInFolder.length === 0 && sortedRegularInFolder.length === 0 && childFolders.length === 0 ? (
                <div className="muted" style={{ padding: 12 }}>
                  No documents in this folder.
                </div>
              ) : null}
            </div>
          </div>

          <input
            ref={importInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const selectedFiles = Array.from(e.target.files ?? [])
              void uploadFilesToCurrentFolder(selectedFiles)
              e.target.value = ''
            }}
          />
        </div>

        {commentOpen ? (
          <div
            className="modalOverlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="comment-modal-title"
            onClick={(e) => e.target === e.currentTarget && !commentBusy && (() => { setCommentOpen(false); setCommentEditFileId(null) })()}
          >
            <div className="modal card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
              <div className="paneHead">
                <h2 id="comment-modal-title" style={{ margin: 0, fontSize: 18 }}>
                  {commentEditFileId ? 'Edit comment' : 'New comment'}
                </h2>
                <button
                  type="button"
                  className="btn"
                  disabled={commentBusy}
                  onClick={() => { setCommentOpen(false); setCommentEditFileId(null) }}
                >
                  Cancel
                </button>
              </div>
              <div className="stack" style={{ marginTop: 12 }}>
                {commentErr ? <div className="error">{commentErr}</div> : null}
                <textarea
                  autoFocus
                  rows={8}
                  style={{ resize: 'vertical', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 14, padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' }}
                  placeholder="Type your comment here…"
                  value={commentText}
                  disabled={commentBusy}
                  onChange={(e) => setCommentText(e.target.value)}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={commentBusy || !commentText.trim()}
                    onClick={async () => {
                      if (!caseId) return
                      setCommentBusy(true)
                      setCommentErr(null)
                      try {
                        if (commentEditFileId) {
                          // Edit mode: PATCH existing comment file
                          await apiFetch(`/cases/${caseId}/files/${commentEditFileId}/comment`, {
                            token,
                            method: 'PATCH',
                            json: { text: commentText },
                          })
                        } else {
                          // Create mode: upload as new .txt file
                          const firstLine = commentText.trim().split('\n')[0].trim()
                          const label = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine
                          const filename = `${label || 'Comment'}.txt`
                          const blob = new Blob([commentText], { type: 'text/plain' })
                          const fd = new FormData()
                          fd.set('upload', blob, filename)
                          fd.set('folder', docFolder)
                          const res = await fetch(apiUrl(`/cases/${caseId}/files`), {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}` },
                            body: fd,
                          })
                          if (!res.ok) {
                            const body = await res.json().catch(() => ({}))
                            throw new Error((body as { detail?: string }).detail ?? res.statusText)
                          }
                        }
                        setCommentOpen(false)
                        setCommentEditFileId(null)
                        setCommentText('')
                        onRefresh()
                      } catch (e: any) {
                        setCommentErr(e?.message ?? 'Failed to save comment')
                      } finally {
                        setCommentBusy(false)
                      }
                    }}
                  >
                    {commentBusy ? 'Saving…' : 'Save comment'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {emlPreviewOpen && emlPreviewFile ? (
          <EmlPreviewModal
            file={emlPreviewFile}
            data={emlPreviewData}
            loading={emlPreviewBusy}
            error={emlPreviewErr}
            onClose={() => {
              setEmlPreviewOpen(false)
              setEmlPreviewFile(null)
              setEmlPreviewData(null)
              setEmlPreviewErr(null)
            }}
            onOpenExternal={() => {
              const f = emlPreviewFile
              setEmlPreviewOpen(false)
              setEmlPreviewFile(null)
              setEmlPreviewData(null)
              setEmlPreviewErr(null)
              if (f) void openCaseFile(f)
            }}
          />
        ) : null}

        {taskCreateOpen ? (
          <div
            className="modalOverlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-create-title"
            onClick={(e) => e.target === e.currentTarget && !taskCreateBusy && setTaskCreateOpen(false)}
          >
            <div className="modal card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
              <div className="paneHead">
                <h2 id="task-create-title" style={{ margin: 0, fontSize: 18 }}>
                  New task
                </h2>
                <button type="button" className="btn" disabled={taskCreateBusy} onClick={() => setTaskCreateOpen(false)}>
                  Cancel
                </button>
              </div>
              <div className="stack" style={{ marginTop: 12, gap: 12 }}>
                {taskCreateErr ? <div className="error">{taskCreateErr}</div> : null}
                {!caseDetail?.matter_sub_type_id ? (
                  <div className="muted">
                    This case has no matter sub-type. You can still use the built-in &quot;Follow up&quot; template or a
                    custom task title below.
                  </div>
                ) : null}
                <label className="field">
                  <span>Task</span>
                  <select
                    value={taskCreateStandardId}
                    disabled={taskCreateBusy}
                    onChange={(e) => {
                      const v = e.target.value
                      setTaskCreateStandardId(v)
                      if (v === '__custom__' && taskCreateTitleOverride) {
                        setTaskCreateCustomTitle(taskCreateTitleOverride)
                        setTaskCreateTitleOverride(null)
                      } else if (v !== CANARY_FOLLOW_UP_STANDARD_TASK_ID) {
                        setTaskCreateTitleOverride(null)
                      }
                    }}
                    aria-label="Standard or custom task"
                  >
                    {standardTaskTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                    <option value="__custom__">Custom task…</option>
                  </select>
                </label>
                {taskCreateTitleOverride !== null ? (
                  <label className="field">
                    <span>Title</span>
                    <input
                      value={taskCreateTitleOverride}
                      onChange={(e) => setTaskCreateTitleOverride(e.target.value)}
                      disabled={taskCreateBusy}
                    />
                  </label>
                ) : null}
                {taskCreateStandardId === '__custom__' ? (
                  <label className="field">
                    <span>Custom title</span>
                    <input
                      value={taskCreateCustomTitle}
                      onChange={(e) => setTaskCreateCustomTitle(e.target.value)}
                      disabled={taskCreateBusy}
                      placeholder="Describe the task…"
                    />
                  </label>
                ) : null}
                <label className="field">
                  <span>Date</span>
                  <input
                    type="date"
                    value={taskCreateDueDate}
                    onChange={(e) => setTaskCreateDueDate(e.target.value)}
                    disabled={taskCreateBusy}
                  />
                </label>
                <label className="field">
                  <span>Assigned to</span>
                  <select
                    value={taskCreateAssignUserId}
                    disabled={taskCreateBusy}
                    onChange={(e) => setTaskCreateAssignUserId(e.target.value)}
                    aria-label="Assign to user"
                  >
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
                <label className="field">
                  <span>Priority</span>
                  <select
                    value={taskCreatePriority}
                    disabled={taskCreateBusy}
                    onChange={(e) => setTaskCreatePriority(e.target.value as 'low' | 'normal' | 'high')}
                    aria-label="Task priority"
                  >
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={taskCreatePrivate}
                    disabled={taskCreateBusy}
                    onChange={(e) => setTaskCreatePrivate(e.target.checked)}
                  />
                  <span className="muted" style={{ lineHeight: 1.4 }}>
                    Private — only you and the assignee (if any) can see this task on the matter.
                  </span>
                </label>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" className="btn primary" disabled={taskCreateBusy} onClick={() => void (async () => {
                    if (!caseId) return
                    if (!taskCreateDueDate.trim()) {
                      setTaskCreateErr('Please choose a date.')
                      return
                    }
                    if (taskCreateStandardId === '__custom__' && !taskCreateCustomTitle.trim()) {
                      setTaskCreateErr('Please enter a task title or pick a standard task.')
                      return
                    }
                    setTaskCreateBusy(true)
                    setTaskCreateErr(null)
                    try {
                      const due = new Date(`${taskCreateDueDate}T12:00:00`)
                      const json: Record<string, unknown> = {
                        due_at: due.toISOString(),
                        priority: taskCreatePriority,
                        is_private: taskCreatePrivate,
                      }
                      if (taskCreateAssignUserId) json.assigned_to_user_id = taskCreateAssignUserId
                      if (taskCreateStandardId !== '__custom__') {
                        json.standard_task_id = taskCreateStandardId
                        if (taskCreateTitleOverride != null && taskCreateTitleOverride.trim() !== '') {
                          json.title = taskCreateTitleOverride.trim()
                        }
                      } else {
                        json.title = taskCreateCustomTitle.trim()
                      }
                      await apiFetch(`/cases/${caseId}/tasks`, { token, method: 'POST', json })
                      setTaskCreateOpen(false)
                      onRefresh()
                      onTaskMenuInvalidate?.()
                    } catch (e: any) {
                      setTaskCreateErr(e?.message ?? 'Failed to create task')
                    } finally {
                      setTaskCreateBusy(false)
                    }
                  })()}>
                    {taskCreateBusy ? 'Creating…' : 'Create task'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {precedentPicker ? (
          <div
            className="modalOverlay"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.target === e.currentTarget && setPrecedentPicker(null)}
          >
            <div className="modal card precedentPickerModal" onClick={(e) => e.stopPropagation()}>
              <div className="paneHead">
                <div>
                  <h2 className="precedentPickerTitle">Precedent</h2>
                  <div className="muted">Choose a category, then a template — or blank.</div>
                  {!caseDetail?.matter_sub_type_id ? (
                    <div className="muted" style={{ marginTop: 4 }}>
                      This case has no matter sub-type; precedents are filtered by sub-type.
                    </div>
                  ) : null}
                </div>
                <button type="button" className="btn" onClick={() => setPrecedentPicker(null)}>
                  Close
                </button>
              </div>
              <div className="precedentPickerBody">
                <div className="precedentPickerCats">
                  <div className="precedentPickerCatsTitle">Category</div>
                  <div className="precedentPickerCatList">
                    {precedentCategories.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`precedentPickerCatBtn ${precedentPickerCategoryId === c.id ? 'active' : ''}`}
                        onClick={() => {
                          setPrecedentPickerCategoryId(c.id)
                          setPrecedentChosenId(null)
                        }}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="precedentPickerMain">
                  <label className="field" style={{ marginBottom: 8 }}>
                    <span>Search by name or reference</span>
                    <SearchInput
                      placeholder="Search…"
                      value={precedentSearch}
                      onChange={(e) => setPrecedentSearch(e.target.value)}
                      onClear={() => setPrecedentSearch('')}
                      disabled={
                        !caseDetail?.matter_sub_type_id ||
                        precedentCategories.length === 0 ||
                        precedentPickerCategoryId === null
                      }
                      aria-label="Search precedents"
                    />
                  </label>
                  {!caseDetail?.matter_sub_type_id ? (
                    <div className="muted precedentPickerEmpty">
                      Set a matter sub-type on this case to choose precedents. Categories are configured per sub-type under Admin → Matters.
                    </div>
                  ) : precedentCategories.length === 0 ? (
                    <div className="muted precedentPickerEmpty">
                      No precedent categories for this matter sub-type yet. An administrator can add them under Admin → Matters.
                    </div>
                  ) : precedentPickerCategoryId === null ? (
                    <div className="muted precedentPickerEmpty">
                      Select a category on the left.
                    </div>
                  ) : (
                    <>
                      <div className="precedentPickerTableHead row">
                        <span className="precedentPickerColPick" />
                        <span className="precedentPickerColName">Name</span>
                        <span className="precedentPickerColRef">Reference</span>
                      </div>
                      <div className="precedentPickerTableBody">
                        <label className="precedentPickerRow rowbtn row">
                          <span className="precedentPickerColPick">
                            <input
                              type="radio"
                              name="precedentChoice"
                              checked={precedentChosenId === null}
                              onChange={() => setPrecedentChosenId(null)}
                            />
                          </span>
                          <span className="precedentPickerColName">Blank (no precedent)</span>
                          <span className="precedentPickerColRef muted">—</span>
                        </label>
                        {filteredPrecedentChoices.map((p) => (
                          <label
                            key={p.id}
                            className={`precedentPickerRow rowbtn row ${precedentChosenId === p.id ? 'active' : ''}`}
                          >
                            <span className="precedentPickerColPick">
                              <input
                                type="radio"
                                name="precedentChoice"
                                checked={precedentChosenId === p.id}
                                onChange={() => setPrecedentChosenId(p.id)}
                              />
                            </span>
                            <span className="precedentPickerColName">{p.name}</span>
                            <span className="precedentPickerColRef mono">{p.reference}</span>
                          </label>
                        ))}
                        {filteredPrecedentChoices.length === 0 ? (
                          <div className="muted precedentPickerEmpty">
                            No precedents match this category and search.
                          </div>
                        ) : null}
                      </div>
                    </>
                  )}
                  <div className="row precedentPickerActions">
                    <button type="button" className="btn" onClick={() => setPrecedentPicker(null)}>
                      Cancel
                    </button>
                    <button type="button" className="btn primary" onClick={() => confirmPrecedentPicker()}>
                      Continue
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {contactPickModal ? (
          <div
            className="modalOverlay"
            role="dialog"
            aria-modal="true"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setContactPickModal(null)
                resetContactPickForm()
              }
            }}
          >
            <div className="modal card modal--scrollBody" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
              <div className="paneHead">
                <div>
                  <h2 style={{ margin: 0, fontSize: 18 }}>
                    {contactPickModal.composeKind === 'email' ? 'E-mail recipient' : 'Letter recipient'}
                  </h2>
                  <div className="muted">
                    {contactPickModal.composeKind === 'email' ? (
                      <>
                        Select a matter contact or global contact with an e-mail address. &quot;All clients&quot; is not
                        available for Microsoft 365 e-mail.
                      </>
                    ) : (
                      <>
                        Matter contact (choose &quot;All clients&quot; to fill every client merge slot), none, or search for a
                        global contact below.
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setContactPickModal(null)
                    resetContactPickForm()
                  }}
                >
                  Close
                </button>
              </div>
              <div className="stack modalBodyScroll" style={{ marginTop: 12 }}>
                <label className="field">
                  <span>Matter contact</span>
                  <select
                    value={pickMatterCcId}
                    onChange={(e) => {
                      const v = e.target.value
                      setPickMatterCcId(v)
                      if (v !== 'none') setPickGlobalId(null)
                    }}
                  >
                    <option value="none">None</option>
                    {contactPickModal.composeKind !== 'email' ? (
                      <option value="all_clients">All clients</option>
                    ) : null}
                    {caseContactsMenuOrder.map((cc) => (
                      <option key={cc.id} value={cc.id}>
                        {cc.name} ({matterContactTypeLabel(cc.matter_contact_type, matterTypeOptions)})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="muted" style={{ fontSize: 12 }}>
                  Or search for a global contact (results appear when your search matches):
                </div>
                <SearchInput
                  placeholder="Search global…"
                  value={pickSearch}
                  onChange={(e) => setPickSearch(e.target.value)}
                  onClear={() => setPickSearch('')}
                  aria-label="Search global contacts"
                />
                <div className="list" style={{ maxHeight: 120, overflow: 'auto' }}>
                  {(() => {
                    const q = pickSearch.trim().toLowerCase()
                    if (!q) {
                      return (
                        <div className="muted" style={{ padding: '6px 0' }}>
                          Type in the search box to find global contacts.
                        </div>
                      )
                    }
                    const filtered = contacts.filter((c) => {
                      if (pickLinkType.trim().toLowerCase() === LAWYERS_TYPE_SLUG && c.type !== 'organisation') {
                        return false
                      }
                      return c.name.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q)
                    })
                    if (filtered.length === 0) {
                      return (
                        <div className="muted" style={{ padding: '6px 0' }}>
                          No global contacts match.
                        </div>
                      )
                    }
                    return filtered.slice(0, 20).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="listItem"
                        style={
                          pickGlobalId === c.id
                            ? { outline: '2px solid rgba(37,99,235,0.45)', outlineOffset: -2 }
                            : undefined
                        }
                        onClick={() => {
                          setPickGlobalId(c.id)
                          setPickMatterCcId('none')
                        }}
                      >
                        <div className="listTitle">{c.name}</div>
                        <div className="muted">{c.email ?? '—'}</div>
                      </button>
                    ))
                  })()}
                </div>
                {pickGlobalId ? (
                  <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={pickLinkGlobal}
                      onChange={(e) => setPickLinkGlobal(e.target.checked)}
                    />
                    <span className="muted">Link this contact to the current matter</span>
                  </label>
                ) : null}
                {pickLinkGlobal ? (
                  <label className="field">
                    <span>Contact type (required to link)</span>
                    <select
                      value={pickLinkType}
                      onChange={(e) => {
                        const v = e.target.value
                        setPickLinkType(v)
                        if (v.trim().toLowerCase() !== LAWYERS_TYPE_SLUG) {
                          setPickLawyerClientIds([])
                        } else if (pickGlobalId) {
                          const sel = contacts.find((x) => x.id === pickGlobalId)
                          if (sel && sel.type === 'person') setPickGlobalId(null)
                        }
                      }}
                    >
                      <option value="">— select —</option>
                      {matterTypeOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {pickLinkGlobal && pickLinkType.trim().toLowerCase() === LAWYERS_TYPE_SLUG ? (
                  <div className="field">
                    <span>Linked clients (required)</span>
                    <div className="stack" style={{ gap: 6, maxHeight: 120, overflow: 'auto' }}>
                      {clientMatterContacts.length === 0 ? (
                        <div className="muted">Add at least one Client matter contact on this case first.</div>
                      ) : (
                        clientMatterContacts.map((c) => (
                          <label key={c.id} className="row" style={{ gap: 8, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={pickLawyerClientIds.includes(c.id)}
                              onChange={(e) => {
                                setPickLawyerClientIds((prev) => {
                                  if (e.target.checked) {
                                    if (prev.includes(c.id) || prev.length >= 4) return prev
                                    return [...prev, c.id]
                                  }
                                  return prev.filter((x) => x !== c.id)
                                })
                              }}
                            />
                            <span>{c.name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
                {contactPickModal.composeKind === 'email' ? (
                  <>
                    <input
                      ref={emailLocalAttachInputRef}
                      type="file"
                      multiple
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        void uploadLocalFilesForEmailAttach(Array.from(e.target.files ?? []))
                      }}
                    />
                    <div className="field" style={{ marginTop: 4 }}>
                      <span>Attach</span>
                      <div className="emailAttachToolbar">
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => {
                            setEmailAttachBrowseFolder('')
                            setEmailAttachCanaryOpen(true)
                          }}
                        >
                          From Canary
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => emailLocalAttachInputRef.current?.click()}
                        >
                          From local drive
                        </button>
                      </div>
                    </div>
                    {emailAttachIds.length > 0 ? (
                      <div className="field">
                        <span className="muted" style={{ fontSize: 13 }}>
                          Attached ({emailAttachIds.length}/25)
                        </span>
                        <div className="emailAttachChips">
                          {emailAttachIds.map((id) => {
                            const f = files.find((x) => x.id === id)
                            return (
                              <div key={id} className="emailAttachChip">
                                <span className="docsTypeIcon" aria-hidden>
                                  {f ? (
                                    <DocMimeIcon mime={f.mime_type} filename={f.original_filename} />
                                  ) : (
                                    <DocMimeIcon mime="application/octet-stream" filename="" />
                                  )}
                                </span>
                                <span className="emailAttachChipName" title={f?.original_filename ?? id}>
                                  {f?.original_filename ?? `File ${id.slice(0, 8)}…`}
                                </span>
                                <button
                                  type="button"
                                  className="btn"
                                  style={{ padding: '2px 8px', fontSize: 12 }}
                                  onClick={() => setEmailAttachIds((prev) => prev.filter((x) => x !== id))}
                                  aria-label="Remove attachment"
                                >
                                  Remove
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setContactPickModal(null)
                      resetContactPickForm()
                    }}
                  >
                    Cancel
                  </button>
                  <button type="button" className="btn primary" disabled={busy} onClick={() => void confirmContactPick()}>
                    Continue
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {contactPickModal?.composeKind === 'email' && emailAttachCanaryOpen ? (
          <div
            className="modalOverlay emailAttachCanaryOverlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="email-attach-canary-title"
            onClick={(e) => {
              if (e.target === e.currentTarget) setEmailAttachCanaryOpen(false)
            }}
          >
            <div className="modal card modal--scrollBody" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
              <div className="paneHead">
                <div>
                  <h2 id="email-attach-canary-title" style={{ margin: 0, fontSize: 18 }}>
                    Attach from Canary
                  </h2>
                  <div className="muted" style={{ fontSize: 13 }}>
                    Open folders to browse; tick files to attach (up to 25 total).
                  </div>
                </div>
                <button type="button" className="btn primary" onClick={() => setEmailAttachCanaryOpen(false)}>
                  Done
                </button>
              </div>
              <div
                className="muted"
                style={{ padding: '8px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
              >
                <span
                  style={{ cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => setEmailAttachBrowseFolder('')}
                >
                  Home
                </span>
                {emailAttachBrowseFolder.split('/').filter(Boolean).map((_seg, idx, arr) => {
                  const path = arr.slice(0, idx + 1).join('/')
                  const label = arr[idx]
                  return (
                    <span key={path} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <span aria-hidden> / </span>
                      <span
                        style={{ cursor: 'pointer', textDecoration: 'underline' }}
                        onClick={() => setEmailAttachBrowseFolder(path)}
                      >
                        {label}
                      </span>
                    </span>
                  )
                })}
              </div>
              <div className="emailAttachPickerList">
                {emailAttachChildFolders.map((folderName) => {
                  const next = emailAttachBrowseFolder ? `${emailAttachBrowseFolder}/${folderName}` : folderName
                  return (
                    <button
                      key={next}
                      type="button"
                      className="emailAttachPickerRow emailAttachPickerRow--folder"
                      onClick={() => setEmailAttachBrowseFolder(next)}
                    >
                      <span className="emailAttachPickerCheckSpacer" aria-hidden />
                      <DocsFolderDescCell name={folderName} />
                    </button>
                  )
                })}
                {emailAttachFilesInBrowseFolder.map((f) => (
                  <label key={f.id} className="emailAttachPickerRow emailAttachPickerRow--file">
                    <input
                      type="checkbox"
                      checked={emailAttachIds.includes(f.id)}
                      onChange={(e) => {
                        setEmailAttachIds((prev) => {
                          if (e.target.checked) {
                            if (prev.includes(f.id) || prev.length >= 25) return prev
                            return [...prev, f.id]
                          }
                          return prev.filter((x) => x !== f.id)
                        })
                      }}
                    />
                    <DocsFileDescCell f={f} showPin={false} />
                  </label>
                ))}
                {emailAttachChildFolders.length === 0 && emailAttachFilesInBrowseFolder.length === 0 ? (
                  <div className="muted" style={{ padding: 12 }}>
                    No documents in this folder.
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {propertyModalOpen && propertyDraft ? (
          <div
            className="modalOverlay"
            role="dialog"
            aria-modal="true"
            onClick={(e) => {
              if (e.target !== e.currentTarget) return
              if (propertyBaseline) {
                setPropertyDraft(JSON.parse(JSON.stringify(propertyBaseline)) as CasePropertyPayload)
              }
              setPropertyModalOpen(false)
            }}
          >
            <div className="modal card modal--scrollBody" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
              <div className="paneHead">
                <div>
                  <h2 style={{ margin: 0, fontSize: 18 }}>Property details</h2>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      if (propertyBaseline) {
                        setPropertyDraft(JSON.parse(JSON.stringify(propertyBaseline)) as CasePropertyPayload)
                      }
                      setPropertyModalOpen(false)
                    }}
                  >
                    Discard changes
                  </button>
                  <button
                    type="button"
                    className="btn"
                    style={{ background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' }}
                    disabled={busy}
                    onClick={async () => {
                      if (!caseId) return
                      setBusy(true)
                      setActionErr(null)
                      try {
                        const lines = [...propertyDraft.free_lines]
                        while (lines.length < 6) lines.push('')
                        const out = await apiFetch<CasePropertyDetailsOut>(
                          `/cases/${caseId}/property-details`,
                          {
                            method: 'PUT',
                            token,
                            json: { ...propertyDraft, free_lines: lines.slice(0, 6) },
                          },
                        )
                        setPropertyDetails(out)
                        setPropertyModalOpen(false)
                      } catch (e: any) {
                        setActionErr(e?.message ?? 'Save failed')
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Save and close
                  </button>
                </div>
              </div>
              <div className="stack modalBodyScroll" style={{ marginTop: 12 }}>
                <div className="muted" style={{ fontWeight: 600 }}>
                  Title number(s)
                </div>
                {propertyDraft.title_numbers.map((t, i) => (
                  <div key={i} className="row" style={{ gap: 8 }}>
                    <input
                      style={{ flex: 1 }}
                      value={t}
                      onChange={(e) => {
                        const next = [...propertyDraft.title_numbers]
                        next[i] = e.target.value
                        setPropertyDraft({ ...propertyDraft, title_numbers: next })
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        const next = propertyDraft.title_numbers.filter((_, j) => j !== i)
                        setPropertyDraft({ ...propertyDraft, title_numbers: next })
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setPropertyDraft({
                      ...propertyDraft,
                      title_numbers: [...propertyDraft.title_numbers, ''],
                    })
                  }
                >
                  Add title number
                </button>
                <label className="field">
                  <span>Tenure</span>
                  <select
                    value={propertyDraft.tenure ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      setPropertyDraft({
                        ...propertyDraft,
                        tenure: v === '' ? null : (v as CasePropertyTenure),
                      })
                    }}
                  >
                    <option value="">—</option>
                    <option value="freehold">Freehold</option>
                    <option value="leasehold">Leasehold</option>
                    <option value="commonhold">Commonhold</option>
                  </select>
                </label>
                <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={propertyDraft.is_non_postal}
                    onChange={(e) =>
                      setPropertyDraft({ ...propertyDraft, is_non_postal: e.target.checked })
                    }
                  />
                  <span>Non-postal address (free lines)</span>
                </label>
                {!propertyDraft.is_non_postal ? (
                  <>
                    <label className="field">
                      <span>Address line 1</span>
                      <input
                        value={propertyDraft.uk.line1 ?? ''}
                        onChange={(e) =>
                          setPropertyDraft({
                            ...propertyDraft,
                            uk: { ...propertyDraft.uk, line1: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Address line 2</span>
                      <input
                        value={propertyDraft.uk.line2 ?? ''}
                        onChange={(e) =>
                          setPropertyDraft({
                            ...propertyDraft,
                            uk: { ...propertyDraft.uk, line2: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Town / city</span>
                      <input
                        value={propertyDraft.uk.town ?? ''}
                        onChange={(e) =>
                          setPropertyDraft({
                            ...propertyDraft,
                            uk: { ...propertyDraft.uk, town: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>County</span>
                      <input
                        value={propertyDraft.uk.county ?? ''}
                        onChange={(e) =>
                          setPropertyDraft({
                            ...propertyDraft,
                            uk: { ...propertyDraft.uk, county: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Postcode</span>
                      <input
                        value={propertyDraft.uk.postcode ?? ''}
                        onChange={(e) =>
                          setPropertyDraft({
                            ...propertyDraft,
                            uk: { ...propertyDraft.uk, postcode: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Country</span>
                      <input
                        value={propertyDraft.uk.country ?? ''}
                        onChange={(e) =>
                          setPropertyDraft({
                            ...propertyDraft,
                            uk: { ...propertyDraft.uk, country: e.target.value },
                          })
                        }
                      />
                    </label>
                  </>
                ) : (
                  [0, 1, 2, 3, 4, 5].map((i) => (
                    <label key={i} className="field">
                      <span>Address line {i + 1}</span>
                      <input
                        value={propertyDraft.free_lines[i] ?? ''}
                        onChange={(e) => {
                          const next = [...propertyDraft.free_lines]
                          next[i] = e.target.value
                          setPropertyDraft({ ...propertyDraft, free_lines: next })
                        }}
                      />
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}

        {docMenu ? (
          <div
            ref={docMenuRef}
            className="docContextMenu"
            style={{
              left: docMenuStyle?.left ?? docMenu.x,
              top: docMenuStyle?.top ?? docMenu.y,
              ...(docMenuStyle?.maxHeight != null
                ? { maxHeight: docMenuStyle.maxHeight, overflowY: 'auto' as const }
                : {}),
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseLeave={() => setMoveMenu(null)}
          >
            {docMenu.kind === 'surface' ? (
              <div
                className="docContextItem"
                onClick={() => {
                  setDocMenu(null)
                  createFolderAtCurrentPath()
                }}
              >
                New folder
              </div>
            ) : null}

            {docMenu.kind === 'folder' ? (
              <div
                className="docContextItem"
                onClick={() => {
                  setDocFolder(docMenu.folderPath)
                  setDocMenu(null)
                }}
              >
                Open
              </div>
            ) : null}

            {docMenu.kind === 'folder' ? (
              <>
                <div
                  className="docContextItem"
                  onClick={() => {
                    const current = docMenu.folderPath
                    const parts = current.split('/').filter(Boolean)
                    const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
                    const leaf = parts[parts.length - 1] || ''
                    setDocMenu(null)
                    setTextPrompt({
                      title: 'Rename folder',
                      hint: 'Name only (not the full path).',
                      initial: leaf,
                      confirmLabel: 'Rename',
                      onConfirm: (newName) => {
                        const trimmed = newName.trim()
                        setTextPrompt(null)
                        if (!trimmed) return
                        const newFolderPath = parent ? `${parent}/${trimmed}` : trimmed
                        if (docFolder === current) setDocFolder(newFolderPath)
                        setBusy(true)
                        setActionErr(null)
                        apiFetch(`/cases/${caseId}/files/folders/rename`, {
                          token,
                          method: 'POST',
                          json: { old_folder_path: current, new_folder_path: newFolderPath },
                        })
                          .then(() => {
                            onRefresh()
                          })
                          .catch((e: any) => {
                            setActionErr(e?.message ?? 'Failed to rename folder')
                          })
                          .finally(() => {
                            setBusy(false)
                          })
                      },
                    })
                  }}
                >
                  Rename
                </div>

                <div
                  className="docContextSubWrap"
                  onMouseEnter={() => setMoveMenu({ kind: 'folder', folderPath: docMenu.folderPath })}
                  onMouseLeave={() => setMoveMenu(null)}
                >
                  <div className="docContextItem docContextItemRow">
                    <span>Move</span>
                    <span className="docMenuChevron" aria-hidden>
                      ▸
                    </span>
                  </div>
                  {moveMenu?.kind === 'folder' && moveMenu.folderPath === docMenu.folderPath ? (
                    <div className="docSubMenu" role="menu">
                      {(() => {
                        const current = docMenu.folderPath
                        const currentParts = current.split('/').filter(Boolean)
                        const leaf = currentParts[currentParts.length - 1] ?? ''
                        const forbiddenPrefix = `${current}/`
                        const currentParent = currentParts.length > 1 ? currentParts.slice(0, -1).join('/') : ''
                        const options = [
                          { label: 'Home', parent: '' },
                          ...allFolderPaths
                            .filter(
                              (p) => p !== current && !p.startsWith(forbiddenPrefix),
                            )
                            .map((p) => ({ label: p, parent: p })),
                        ]
                        return options.map((opt) => {
                          const isCurrentParent = opt.parent === currentParent
                          return (
                          <div
                            key={`folder-move-${opt.parent || 'home'}`}
                            className={`docContextItem${isCurrentParent ? ' docContextItemDisabled' : ''}`}
                            role="menuitem"
                            aria-disabled={isCurrentParent}
                            onClick={() => {
                              if (isCurrentParent) return
                              const newFullPath = opt.parent ? `${opt.parent}/${leaf}` : leaf
                              if (docFolder === current) setDocFolder(newFullPath)
                              else if (docFolder.startsWith(`${current}/`)) {
                                setDocFolder(`${newFullPath}/${docFolder.slice(current.length + 1)}`)
                              }
                              setBusy(true)
                              setActionErr(null)
                              apiFetch(`/cases/${caseId}/files/folders/move`, {
                                token,
                                method: 'POST',
                                json: { old_folder_path: current, new_parent_path: opt.parent },
                              })
                                .then(() => onRefresh())
                                .catch((e: any) => setActionErr(e?.message ?? 'Failed to move folder'))
                                .finally(() => setBusy(false))
                              setMoveMenu(null)
                              setDocMenu(null)
                            }}
                          >
                            {opt.label}
                          </div>
                          )
                        })
                      })()}
                    </div>
                  ) : null}
                </div>

                <div
                  className="docContextItem"
                  onClick={() => {
                    void (async () => {
                      const current = docMenu.folderPath
                      const ok = await askConfirm({
                        title: 'Delete folder',
                        message: `Delete folder "${current}" (including its contents)?`,
                        danger: true,
                        confirmLabel: 'Delete',
                      })
                      if (!ok) return
                      setDocMenu(null)
                      setBusy(true)
                      setActionErr(null)
                      apiFetch(`/cases/${caseId}/files/folders/delete`, {
                        token,
                        method: 'POST',
                        json: { folder_path: current },
                      })
                        .then(() => {
                          if (docFolder === current) setDocFolder('')
                          onRefresh()
                        })
                        .catch((e: any) => {
                          setActionErr(e?.message ?? 'Failed to delete folder')
                        })
                        .finally(() => {
                          setBusy(false)
                        })
                      setMoveMenu(null)
                    })()
                  }}
                >
                  Delete
                </div>
              </>
            ) : null}

            {docMenu.kind === 'file' ? (
              <>
                {(() => {
                  const f = files.find((x) => x.id === docMenu.fileId)
                  if (!f) return null
                  const canOpenDownload = f.category !== 'system' && f.mime_type !== 'application/x-directory'
                  if (!canOpenDownload) return null
                  return (
                    <>
                      {isEmlLikeFileSummary(f) ? (
                        <div
                          className="docContextItem"
                          onClick={() => {
                            setDocMenu(null)
                            void previewEmlFile(f)
                          }}
                        >
                          Preview
                        </div>
                      ) : null}
                      <div
                        className="docContextItem"
                        onClick={() => {
                          setDocMenu(null)
                          void openCaseFile(f)
                        }}
                      >
                        Open
                      </div>
                      <div
                        className="docContextItem"
                        onClick={() => {
                          setDocMenu(null)
                          void downloadCaseFile(f)
                        }}
                      >
                        Download
                      </div>
                    </>
                  )
                })()}

                {(() => {
                  const f = files.find((x) => x.id === docMenu.fileId)
                  if (!f || f.mime_type === 'application/x-directory') return null
                  return (
                    <div
                      className="docContextItem"
                      onClick={() => {
                        setDocMenu(null)
                        setTaskCreateErr(null)
                        setTaskCreateCustomTitle('')
                        const name = f.original_filename.trim() || 'Document'
                        setTaskCreateTitleOverride(`Follow up: ${name}`)
                        setTaskCreateStandardId(CANARY_FOLLOW_UP_STANDARD_TASK_ID)
                        setTaskCreateOpen(true)
                      }}
                    >
                      Follow up
                    </div>
                  )
                })()}

                {(() => {
                  const f = files.find((x) => x.id === docMenu.fileId)
                  if (!f) return null
                  if (isCommentFile(f)) {
                    return (
                      <div
                        className="docContextItem"
                        onClick={() => {
                          setDocMenu(null)
                          void downloadCaseFile(f)
                        }}
                      >
                        Export
                      </div>
                    )
                  }
                  return (
                    <div
                      className="docContextItem"
                      onClick={() => {
                        setDocMenu(null)
                        const originalName = f.original_filename.trim()
                        const extIdx = originalName.lastIndexOf('.')
                        const hasEditableExt = extIdx > 0 && extIdx < originalName.length - 1
                        const lockedExt = hasEditableExt ? originalName.slice(extIdx) : ''
                        const initialBase = hasEditableExt ? originalName.slice(0, extIdx) : originalName
                        setTextPrompt({
                          title: lockedExt ? `Rename file (extension ${lockedExt} is fixed)` : 'Rename file',
                          initial: initialBase,
                          confirmLabel: 'Rename',
                          onConfirm: (newName) => {
                            const trimmedBase = newName.trim()
                            setTextPrompt(null)
                            if (!trimmedBase) return
                            const finalName = `${trimmedBase}${lockedExt}`
                            if (finalName === f.original_filename) return
                            setBusy(true)
                            setActionErr(null)
                            apiFetch(`/cases/${caseId}/files/${f.id}/rename`, {
                              token,
                              method: 'PATCH',
                              json: { original_filename: finalName },
                            })
                              .then(() => onRefresh())
                              .catch((e: any) => setActionErr(e?.message ?? 'Failed to rename file'))
                              .finally(() => setBusy(false))
                          },
                        })
                      }}
                    >
                      Rename
                    </div>
                  )
                })()}

                <div
                  className="docContextItem"
                  onClick={async () => {
                    const f = files.find((x) => x.id === docMenu.fileId)
                    if (!f) return
                    setBusy(true)
                    setActionErr(null)
                    try {
                      await apiFetch(`/cases/${caseId}/files/${f.id}/pin`, {
                        token,
                        method: 'PATCH',
                        json: { is_pinned: !f.is_pinned },
                      })
                      onRefresh()
                      setDocMenu(null)
                      setMoveMenu(null)
                    } catch (e: any) {
                      setActionErr(e?.message ?? 'Failed to update pin')
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  {files.find((x) => x.id === docMenu.fileId)?.is_pinned ? 'Unpin' : 'Pin'}
                </div>

                <div
                  className="docContextSubWrap"
                  onMouseEnter={() => setMoveMenu({ kind: 'file', fileId: docMenu.fileId })}
                  onMouseLeave={() => setMoveMenu(null)}
                >
                  <div className="docContextItem docContextItemRow">
                    <span>Move</span>
                    <span className="docMenuChevron" aria-hidden>
                      ▸
                    </span>
                  </div>
                  {moveMenu?.kind === 'file' && moveMenu.fileId === docMenu.fileId ? (
                    <div className="docSubMenu" role="menu">
                      {(() => {
                        const f = files.find((x) => x.id === docMenu.fileId)
                        if (!f) return null
                        const here = (f.folder_path ?? '').trim()
                        return [{ label: 'Home', path: '' }, ...allFolderPaths.map((p) => ({ label: p, path: p }))].map(
                          (opt) => {
                            const isHere = here === (opt.path ?? '').trim()
                            return (
                          <div
                            key={`file-move-${opt.path || 'home'}`}
                            className={`docContextItem${isHere ? ' docContextItemDisabled' : ''}`}
                            role="menuitem"
                            aria-disabled={isHere}
                            onClick={() => {
                              if (isHere) return
                              const file = files.find((x) => x.id === moveMenu.fileId)
                              if (!file) return
                              setBusy(true)
                              setActionErr(null)
                              apiFetch(`/cases/${caseId}/files/${file.id}/move`, {
                                token,
                                method: 'POST',
                                json: { folder_path: opt.path },
                              })
                                .then(() => onRefresh())
                                .catch((e: any) => setActionErr(e?.message ?? 'Failed to move file'))
                                .finally(() => setBusy(false))
                              setMoveMenu(null)
                              setDocMenu(null)
                            }}
                          >
                            {opt.label}
                          </div>
                            )
                          },
                        )
                      })()}
                    </div>
                  ) : null}
                </div>

                <div
                  className="docContextItem"
                  onClick={async () => {
                    const f = files.find((x) => x.id === docMenu.fileId)
                    if (!f) return
                    // If this file is in a multi-selection, delete all selected files
                    const isMultiSelected = selectedDocSet.has(f.id) && selectedDocSet.size > 1
                    const idsToDelete = isMultiSelected
                      ? [...selectedDocSet].filter((k) => !k.startsWith('folder:'))
                      : [f.id]
                    const label = isMultiSelected
                      ? `${idsToDelete.length} selected files`
                      : `"${f.original_filename}"`
                    const ok = await askConfirm({
                      title: 'Delete file',
                      message: `Delete ${label}?`,
                      danger: true,
                      confirmLabel: 'Delete',
                    })
                    if (!ok) return
                    setDocMenu(null)
                    setMoveMenu(null)
                    setBusy(true)
                    setActionErr(null)
                    try {
                      await Promise.all(
                        idsToDelete.map((id) =>
                          apiFetch(`/cases/${caseId}/files/${id}`, { token, method: 'DELETE' }),
                        ),
                      )
                      setSelectedDocSet(new Set())
                      onRefresh()
                    } catch (e: any) {
                      setActionErr(e?.message ?? 'Failed to delete file(s)')
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  Delete
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        {textPrompt ? (
          <TextPromptModal
            title={textPrompt.title}
            hint={textPrompt.hint}
            initial={textPrompt.initial}
            confirmLabel={textPrompt.confirmLabel}
            busy={busy}
            onConfirm={textPrompt.onConfirm}
            onCancel={() => setTextPrompt(null)}
          />
        ) : null}
        {caseEditOpen ? (
          <div className="modalOverlay" role="dialog" aria-modal="true">
            <div className="modal card modalSurfaceDraggable" style={caseEditDrag.surfaceStyle}>
              <div className="paneHead">
                <div>
                  <h2 className="modalDragHandle" {...caseEditDrag.handleProps}>
                    Edit case
                  </h2>
                  <div className="muted">Reference is immutable and generated automatically.</div>
                </div>
                <button className="btn" onClick={() => setCaseEditOpen(false)} disabled={busy}>
                  Close
                </button>
              </div>
              <div className="stack" style={{ marginTop: 12 }}>
                <div className="muted">
                  Client name comes from matter contacts with type &quot;Client&quot;. Use Contacts in the left menu →
                  Edit to change names.
                </div>
                <label className="field">
                  <span>Matter type</span>
                  <select value={editPracticeArea} onChange={(e) => setEditPracticeArea(e.target.value)} disabled={busy}>
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
                    value={editMatterDescription}
                    onChange={(e) => setEditMatterDescription(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Fee earner</span>
                  <select value={editFeeEarner} onChange={(e) => setEditFeeEarner(e.target.value)} disabled={busy}>
                    <option value="">Unassigned</option>
                    {users
                      .filter((u) => u.is_active)
                      .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.display_name} ({u.email})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Status</span>
                  <select
                    value={editCaseStatus}
                    onChange={(e) => setEditCaseStatus(e.target.value as CaseWorkflowStatus)}
                    disabled={busy}
                  >
                    <option value="open">Active</option>
                    <option value="quote">Quote</option>
                    <option value="post_completion">Post-completion</option>
                    <option value="closed">Closed</option>
                    <option value="archived">Archived</option>
                  </select>
                </label>
                <div className="row" style={{ justifyContent: 'flex-start' }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !caseId}
                    onClick={() => setManageAccessOpen(true)}
                  >
                    Manage access…
                  </button>
                </div>
                {actionErr ? <div className="error">{actionErr}</div> : null}
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn" onClick={() => setCaseEditOpen(false)} disabled={busy}>
                    Cancel
                  </button>
                  <button
                    className="btn primary"
                    disabled={busy || !editMatterDescription.trim()}
                    onClick={async () => {
                      setBusy(true)
                      setActionErr(null)
                      try {
                        await apiFetch(`/cases/${caseId}`, {
                          token,
                          method: 'PATCH',
                          json: {
                            matter_description: editMatterDescription.trim(),
                            matter_sub_type_id: editPracticeArea || null,
                            fee_earner_user_id: editFeeEarner || null,
                            status: editCaseStatus,
                          },
                        })
                        setCaseEditOpen(false)
                        onRefresh()
                        onCaseListInvalidate?.()
                      } catch (e: any) {
                        setActionErr(e?.message ?? 'Failed to update case')
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {manageAccessOpen && caseId ? (
          <ManageCaseAccessModal
            token={token}
            caseId={caseId}
            users={users}
            onClose={() => setManageAccessOpen(false)}
            onSaved={() => {
              onRefresh()
              onCaseListInvalidate?.()
            }}
          />
        ) : null}

        {contactAddOpen ? (
          <div className="modalOverlay" role="dialog" aria-modal="true">
            <div className="modal modal--scrollBody card modalSurfaceDraggable" style={contactAddDrag.surfaceStyle}>
              <div className="paneHead">
                <div>
                  <h2 className="modalDragHandle" {...contactAddDrag.handleProps}>
                    Add contact
                  </h2>
                  <div className="muted">Link an existing global contact or create a new one.</div>
                </div>
                <button
                  className="btn"
                  onClick={() => {
                    setContactAddErr(null)
                    setContactAddOpen(false)
                  }}
                  disabled={busy}
                >
                  Close
                </button>
              </div>
              <div className="stack modalBodyScroll" style={{ marginTop: 12 }}>
                <div className="card" style={{ padding: 12 }}>
                  <div className="muted" style={{ marginBottom: 8 }}>Matter-specific</div>
                  <label className="field">
                    <span>Contact type (required)</span>
                    <select
                      required
                      value={matterContactType}
                      onChange={(e) => {
                        const v = e.target.value
                        setMatterContactType(v)
                        setContactAddErr(null)
                        if (v.trim().toLowerCase() !== LAWYERS_TYPE_SLUG) {
                          setLawyerLinkClientIds([])
                        } else if (selectedGlobalContactId) {
                          const sel = contacts.find((x) => x.id === selectedGlobalContactId)
                          if (sel && sel.type === 'person') setSelectedGlobalContactId(null)
                        }
                      }}
                      disabled={busy}
                    >
                      <option value="" disabled>
                        Select contact type
                      </option>
                      {matterTypeOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Contact reference</span>
                    <input
                      value={matterContactReference}
                      onChange={(e) => setMatterContactReference(e.target.value)}
                      placeholder="Reference for this matter only"
                      disabled={busy}
                    />
                  </label>
                  {matterContactType.trim().toLowerCase() === LAWYERS_TYPE_SLUG ? (
                    <div className="field">
                      <span>Linked clients (required)</span>
                      <div className="stack" style={{ gap: 6, maxHeight: 160, overflow: 'auto' }}>
                        {clientMatterContacts.length === 0 ? (
                          <div className="muted">Add at least one Client matter contact on this case first.</div>
                        ) : (
                          clientMatterContacts.map((c) => (
                            <label key={c.id} className="row" style={{ gap: 8, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={lawyerLinkClientIds.includes(c.id)}
                                disabled={busy}
                                onChange={(e) => {
                                  setLawyerLinkClientIds((prev) => {
                                    if (e.target.checked) {
                                      if (prev.includes(c.id) || prev.length >= 4) return prev
                                      return [...prev, c.id]
                                    }
                                    return prev.filter((x) => x !== c.id)
                                  })
                                }}
                              />
                              <span>{c.name}</span>
                            </label>
                          ))
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
                {contactAddErr ? <div className="error">{contactAddErr}</div> : null}
                <div className="row">
                  <SearchInput
                    placeholder="Search global contacts…"
                    value={contactAddSearch}
                    onChange={(e) => setContactAddSearch(e.target.value)}
                    onClear={() => setContactAddSearch('')}
                    style={{ flex: 1 }}
                    aria-label="Search global contacts to add"
                  />
                </div>

                <div className="card" style={{ padding: 12 }}>
                  <div className="muted" style={{ marginBottom: 8 }}>Existing contacts</div>
                  <div className="list" style={{ maxHeight: 140, overflow: 'auto' }}>
                    {contacts
                      .filter((c) => {
                        if (matterContactType.trim().toLowerCase() === LAWYERS_TYPE_SLUG && c.type !== 'organisation') {
                          return false
                        }
                        const s = contactAddSearch.trim().toLowerCase()
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
                            disabled={busy}
                            onClick={() => setSelectedGlobalContactId(c.id)}
                          >
                            {selectedGlobalContactId === c.id ? 'Selected' : 'Select'}
                          </button>
                        </div>
                      ))}
                    {contacts.length === 0 ? <div className="muted">No contacts yet.</div> : null}
                  </div>
                </div>

                <button
                  className="btn primary"
                  disabled={busy || !selectedGlobalContactId}
                  onClick={async () => {
                    setContactAddErr(null)
                    setActionErr(null)
                    if (!matterContactType.trim()) {
                      setContactAddErr(CONTACT_TYPE_REQUIRED_MSG)
                      return
                    }
                    if (matterContactType.trim().toLowerCase() === LAWYERS_TYPE_SLUG && lawyerLinkClientIds.length < 1) {
                      setContactAddErr('Select one or more clients that this lawyer represents on this matter.')
                      return
                    }
                    if (!selectedGlobalContactId) return
                    setBusy(true)
                    try {
                      const linkBody: Record<string, unknown> = {
                        contact_id: selectedGlobalContactId,
                        matter_contact_type: matterContactType.trim(),
                        matter_contact_reference: matterContactReference.trim() || null,
                      }
                      if (matterContactType.trim().toLowerCase() === LAWYERS_TYPE_SLUG) {
                        linkBody.lawyer_client_ids = lawyerLinkClientIds
                      }
                      await apiFetch(`/cases/${caseId}/contacts`, {
                        token,
                        json: linkBody,
                      })
                      setContactAddOpen(false)
                      onRefresh()
                    } catch (e: any) {
                      setContactAddErr(e?.message ?? 'Failed to link contact')
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  Link selected
                </button>

                <div className="card" style={{ padding: 12, marginTop: 12 }}>
                  <GlobalContactCreateForm
                    key={matterContactType || 'mc'}
                    organisationOnly={matterContactType.trim().toLowerCase() === LAWYERS_TYPE_SLUG}
                    busy={busy}
                    formError={contactAddErr}
                    submitLabel="Create & link"
                    intro={<div className="muted" style={{ marginBottom: 8 }}>Create new contact</div>}
                    onSubmit={async (payload) => {
                      setContactAddErr(null)
                      setActionErr(null)
                      if (!matterContactType.trim()) {
                        setContactAddErr(CONTACT_TYPE_REQUIRED_MSG)
                        throw new Error(CONTACT_TYPE_REQUIRED_MSG)
                      }
                      if (matterContactType.trim().toLowerCase() === LAWYERS_TYPE_SLUG && lawyerLinkClientIds.length < 1) {
                        const msg = 'Select one or more clients that this lawyer represents on this matter.'
                        setContactAddErr(msg)
                        throw new Error(msg)
                      }
                      if (!caseId) throw new Error('No case')
                      setBusy(true)
                      try {
                        const created = await apiFetch<ContactOut>('/contacts', {
                          token,
                          method: 'POST',
                          json: payload,
                        })
                        const createLinkBody: Record<string, unknown> = {
                          contact_id: created.id,
                          matter_contact_type: matterContactType.trim(),
                          matter_contact_reference: matterContactReference.trim() || null,
                        }
                        if (matterContactType.trim().toLowerCase() === LAWYERS_TYPE_SLUG) {
                          createLinkBody.lawyer_client_ids = lawyerLinkClientIds
                        }
                        await apiFetch(`/cases/${caseId}/contacts`, {
                          token,
                          json: createLinkBody,
                        })
                        setContactAddOpen(false)
                        onRefresh()
                      } catch (e: any) {
                        if (e?.message !== CONTACT_TYPE_REQUIRED_MSG) {
                          setContactAddErr(e?.message ?? 'Failed to create/link contact')
                        }
                        throw e
                      } finally {
                        setBusy(false)
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {editSnapshot ? (
          <div className="modalOverlay" role="dialog" aria-modal="true" aria-labelledby="edit-contact-title">
            <div className="modal modal--scrollBody card">
              <div className="paneHead">
                <div>
                  <h2 id="edit-contact-title">Edit contact</h2>
                  <div className="muted">Update the snapshot on this matter.</div>
                </div>
                <button
                  className="btn"
                  onClick={() => setEditSnapshot(null)}
                  disabled={busy}
                >
                  Close
                </button>
              </div>
              <div className="stack modalBodyScroll" style={{ marginTop: 12 }}>
                <label className="field">
                  <span>Contact type (required)</span>
                  <select
                    required
                    value={editSnapshot.matter_contact_type ?? ''}
                    onChange={(e) => {
                      const v = e.target.value ? e.target.value : null
                      const isLawyers = (v || '').trim().toLowerCase() === LAWYERS_TYPE_SLUG
                      setEditSnapshot({
                        ...editSnapshot,
                        matter_contact_type: v,
                        ...(isLawyers ? { type: 'organisation' as const } : {}),
                      })
                      if (!isLawyers) {
                        setEditLawyerLinkClientIds([])
                      }
                    }}
                    disabled={busy}
                  >
                    <option value="" disabled>
                      Select contact type
                    </option>
                    {matterTypeOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                    {editSnapshot.matter_contact_type &&
                    !matterTypeOptions.some((o) => o.value === editSnapshot.matter_contact_type) ? (
                      <option value={editSnapshot.matter_contact_type}>{editSnapshot.matter_contact_type}</option>
                    ) : null}
                  </select>
                </label>
                <label className="field">
                  <span>Contact reference</span>
                  <input
                    placeholder="Matter-specific reference"
                    value={editSnapshot.matter_contact_reference ?? ''}
                    onChange={(e) =>
                      setEditSnapshot({ ...editSnapshot, matter_contact_reference: e.target.value || null })
                    }
                    disabled={busy}
                  />
                </label>
                {(editSnapshot.matter_contact_type || '').trim().toLowerCase() === LAWYERS_TYPE_SLUG ? (
                  <div className="field">
                    <span>Linked clients (required)</span>
                    <div className="stack" style={{ gap: 6, maxHeight: 160, overflow: 'auto' }}>
                      {clientMatterContacts.length === 0 ? (
                        <div className="muted">Add at least one Client matter contact on this case first.</div>
                      ) : (
                        clientMatterContacts.map((c) => (
                          <label key={c.id} className="row" style={{ gap: 8, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={editLawyerLinkClientIds.includes(c.id)}
                              disabled={busy}
                              onChange={(e) => {
                                setEditLawyerLinkClientIds((prev) => {
                                  if (e.target.checked) {
                                    if (prev.includes(c.id) || prev.length >= 4) return prev
                                    return [...prev, c.id]
                                  }
                                  return prev.filter((x) => x !== c.id)
                                })
                              }}
                            />
                            <span>{c.name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
                <div className="muted" style={{ fontSize: 12 }}>
                  Name and email below are the case snapshot; they can be pushed to the global card only when linked.
                </div>
                <ContactPersonOrgAddressFields
                  busy={busy}
                  organisationOnly={(editSnapshot.matter_contact_type || '').trim().toLowerCase() === LAWYERS_TYPE_SLUG}
                  value={contactOutToFormFields(editSnapshot as unknown as ContactOut)}
                  onChange={(patch) => setEditSnapshot((prev) => (prev ? applyCaseContactFieldPatch(prev, patch) : prev))}
                />
                {editSnapshot.contact_id ? (
                  <label className="row" style={{ alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={pushToGlobal}
                      onChange={(e) => setPushToGlobal(e.target.checked)}
                      disabled={busy}
                    />
                    <span className="muted">Also update global contact</span>
                  </label>
                ) : null}
                <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
                    <button
                    className="btn"
                    disabled={busy}
                    onClick={async () => {
                      if (!caseId) return
                      const ok = await askConfirm({
                        title: 'Remove contact',
                        message:
                          'Remove this contact from the matter only? The global contact will not be deleted.',
                        danger: true,
                        confirmLabel: 'Remove',
                      })
                      if (!ok) return
                      setBusy(true)
                      setActionErr(null)
                      try {
                        await apiFetch(`/cases/${caseId}/contacts/${editSnapshot.id}`, {
                          token,
                          method: 'DELETE',
                        })
                        setEditSnapshot(null)
                        onRefresh()
                      } catch (e: any) {
                        setActionErr(e?.message ?? 'Failed to remove contact')
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Remove from matter
                  </button>
                  <button
                    className="btn primary"
                    disabled={
                      busy ||
                      !resolvedEditSnapshotName.trim() ||
                      !(editSnapshot.matter_contact_type && editSnapshot.matter_contact_type.trim()) ||
                      ((editSnapshot.matter_contact_type || '').trim().toLowerCase() === LAWYERS_TYPE_SLUG &&
                        editLawyerLinkClientIds.length < 1)
                    }
                    onClick={async () => {
                      setBusy(true)
                      setActionErr(null)
                      try {
                        const payload = contactFieldsModelToPayload(
                          contactOutToFormFields(editSnapshot as unknown as ContactOut),
                        )
                        if (!payload) {
                          setActionErr('Enter a name (person or organisation fields).')
                          return
                        }
                        const patchBody: Record<string, unknown> = {
                          type: payload.type,
                          name: payload.name,
                          email: payload.email,
                          phone: payload.phone,
                          title: payload.title,
                          first_name: payload.first_name,
                          middle_name: payload.middle_name,
                          last_name: payload.last_name,
                          company_name: payload.company_name,
                          trading_name: payload.trading_name,
                          address_line1: payload.address_line1,
                          address_line2: payload.address_line2,
                          city: payload.city,
                          county: payload.county,
                          postcode: payload.postcode,
                          country: payload.country,
                          matter_contact_type: editSnapshot.matter_contact_type!.trim(),
                          matter_contact_reference: (editSnapshot.matter_contact_reference ?? '').trim() || null,
                          push_to_global: pushToGlobal,
                        }
                        if ((editSnapshot.matter_contact_type || '').trim().toLowerCase() === LAWYERS_TYPE_SLUG) {
                          patchBody.lawyer_client_ids = editLawyerLinkClientIds
                        }
                        await apiFetch(`/cases/${caseId}/contacts/${editSnapshot.id}`, {
                          token,
                          method: 'PATCH',
                          json: patchBody,
                        })
                        setEditSnapshot(null)
                        onRefresh()
                      } catch (e: any) {
                        setActionErr(e?.message ?? 'Failed to update snapshot')
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

      </div>
    </div>
  )
}

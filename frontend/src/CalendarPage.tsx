import type {
  DateSelectArg,
  EventChangeArg,
  EventClickArg,
  EventInput,
  EventMountArg,
} from '@fullcalendar/core'
import interactionPlugin from '@fullcalendar/interaction'
import listPlugin from '@fullcalendar/list'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from './api'
import type { ApiError } from './api'
import { ConfirmModal } from './ConfirmModal'
import { useDialogs } from './DialogProvider'
import { SearchInput } from './SearchInput'
import type {
  CalendarCategoryOut,
  CalendarDirectoryRow,
  CalendarEventOut,
  CalendarShareOut,
  UserCalendarListItem,
  UserSummary,
} from './types'

function contrastTextForBg(hex: string): string {
  const h = hex.replace(/^#/, '')
  if (h.length !== 6) return '#ffffff'
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const yiq = (r * 299 + g * 587 + b * 114) / 1000
  return yiq >= 128 ? '#1a1a1a' : '#ffffff'
}

function CalendarCategoriesPanel({
  token,
  calendar,
  rows,
  isOwner,
  busy,
  setBusy,
  setErr,
  onRefresh,
  embedded = false,
}: {
  token: string
  calendar: UserCalendarListItem
  rows: CalendarCategoryOut[]
  isOwner: boolean
  busy: boolean
  setBusy: (v: boolean) => void
  setErr: (v: string | null) => void
  onRefresh: () => void
  /** Hide calendar name row when nested under calendar Edit screen */
  embedded?: boolean
}) {
  const { askConfirm } = useDialogs()
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('')

  async function add() {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/users/me/calendars/${calendar.id}/categories`, {
        method: 'POST',
        token,
        json: { name, color: newColor.trim() || null },
      })
      setNewName('')
      setNewColor('')
      onRefresh()
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Add failed')
    } finally {
      setBusy(false)
    }
  }

  async function removeCategory(catId: string) {
    const ok = await askConfirm({
      title: 'Delete category',
      message: 'Delete this category? Events keep their times but lose this colour in Canary.',
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/users/me/calendars/${calendar.id}/categories/${catId}`, { method: 'DELETE', token })
      onRefresh()
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  async function patchColor(catId: string, raw: string) {
    const c = raw.trim()
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/users/me/calendars/${calendar.id}/categories/${catId}`, {
        method: 'PATCH',
        token,
        json: { color: c || null },
      })
      onRefresh()
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  const colorInputStyle: CSSProperties = {
    width: 40,
    height: 32,
    padding: 0,
    border: '1px solid var(--border)',
    borderRadius: 6,
    cursor: busy ? 'not-allowed' : 'pointer',
    background: 'transparent',
    verticalAlign: 'middle',
  }

  return (
    <div style={{ marginBottom: embedded ? 0 : 16, padding: embedded ? 0 : 12, border: embedded ? 'none' : '1px solid var(--border)', borderRadius: embedded ? 0 : 8 }}>
      {embedded ? null : (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
          <strong>{calendar.name}</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {calendar.source !== 'owned' ? `${calendar.owner.display_name} · ` : ''}
            {isOwner ? 'owner' : calendar.access === 'read' ? 'read-only' : 'can edit events'}
          </span>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>No categories yet.</div>
      ) : (
        <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
          {rows.map((cat) => (
            <li key={cat.id} style={{ marginBottom: 8 }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span
                  title={cat.color ?? 'No colour'}
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 4,
                    background: cat.color || 'var(--border)',
                    border: '1px solid var(--border)',
                    flexShrink: 0,
                  }}
                />
                <span>{cat.name}</span>
                {isOwner ? (
                  <>
                    <input
                      type="color"
                      aria-label={`Colour for ${cat.name}`}
                      title="Choose colour"
                      value={cat.color ?? '#888888'}
                      disabled={busy}
                      style={colorInputStyle}
                      onChange={(e) => void patchColor(cat.id, e.target.value)}
                    />
                    {cat.color ? (
                      <button
                        type="button"
                        className="btn"
                        style={{ fontSize: 12, padding: '2px 8px' }}
                        disabled={busy}
                        onClick={() => void patchColor(cat.id, '')}
                      >
                        Clear colour
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn"
                      style={{ fontSize: 12, padding: '2px 8px' }}
                      disabled={busy}
                      onClick={() => void removeCategory(cat.id)}
                    >
                      Delete
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {isOwner ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
          <input
            placeholder="New category name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ flex: '1 1 160px', minWidth: 140 }}
            disabled={busy}
          />
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 13 }}>
              Colour
            </span>
            <input
              type="color"
              aria-label="Pick colour for new category"
              title="Choose colour (optional)"
              value={newColor || '#888888'}
              disabled={busy}
              style={colorInputStyle}
              onChange={(e) => setNewColor(e.target.value)}
            />
          </label>
          {newColor ? (
            <button type="button" className="btn" style={{ fontSize: 12, padding: '2px 8px' }} disabled={busy} onClick={() => setNewColor('')}>
              Clear colour
            </button>
          ) : null}
          <button type="button" className="btn primary" disabled={busy || !newName.trim()} onClick={() => void add()}>
            Add category
          </button>
        </div>
      ) : null}
    </div>
  )
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Options 00–23 */
const HOURS_00_23 = Array.from({ length: 24 }, (_, i) => i)
/** Start minute column 00–59; bold 15, 30, 45 */
const START_MINS_00_59 = Array.from({ length: 60 }, (_, i) => i)
/** Duration full days 0–99 (left of hours) */
const DUR_DAYS_0_99 = Array.from({ length: 100 }, (_, i) => i)
/** Duration hours 0–24 */
const DUR_HOURS_0_24 = Array.from({ length: 25 }, (_, i) => i)
/** Duration minutes 1–60; bold 15, 30, 45 in UI */
const DUR_MINS_1_60 = Array.from({ length: 60 }, (_, i) => i + 1)

function minuteOptionStyle(m: number): CSSProperties | undefined {
  return m === 15 || m === 30 || m === 45 ? { fontWeight: 700 } : undefined
}

function startOfLocalDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function addDaysLocal(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** `startMinute` is 0–59. `durMinutes` is 1–60 for duration. */
function buildTimedStartEnd(
  anchor: Date,
  startHour: number,
  startMinute: number,
  durDays: number,
  durHours: number,
  durMinutes: number,
): { start: Date; end: Date } {
  const s = new Date(anchor)
  const sm = Math.min(59, Math.max(0, Math.floor(startMinute)))
  s.setHours(startHour, sm, 0, 0)
  const dm = Math.min(60, Math.max(1, durMinutes))
  const dd = Math.min(99, Math.max(0, Math.floor(durDays)))
  let totalDurMin = dd * 24 * 60 + durHours * 60 + dm
  if (totalDurMin <= 0) {
    totalDurMin = 30
  }
  const e = new Date(s.getTime() + totalDurMin * 60_000)
  return { start: s, end: e }
}

function splitRemainderToHoursMinutes(totalMin: number): { durHours: number; durMinutes: number } {
  let durH = Math.min(24, Math.floor(totalMin / 60))
  let rem = totalMin % 60
  if (rem === 0 && durH > 0) {
    durH -= 1
    rem = 60
  } else if (rem === 0) {
    rem = 1
  }
  return { durHours: durH, durMinutes: rem }
}

/** Split a timed range into days (0–99) + hours + minutes for the duration UI. */
function timedDurationFromRange(start: Date, end: Date): { durDays: number; durHours: number; durMinutes: number } {
  const totalMin = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000))
  let durDays = Math.min(99, Math.floor(totalMin / (24 * 60)))
  let rem = totalMin - durDays * 24 * 60
  while (rem <= 0 && durDays > 0) {
    durDays -= 1
    rem += 24 * 60
  }
  if (rem <= 0) {
    rem = 1
  }
  const { durHours, durMinutes } = splitRemainderToHoursMinutes(rem)
  return { durDays, durHours, durMinutes }
}

function startHourMinuteFromDate(d: Date): { startHour: number; startMinute: number } {
  return { startHour: d.getHours(), startMinute: d.getMinutes() }
}

function toBodyDate(d: Date, allDay: boolean): string {
  if (allDay) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  return d.toISOString()
}

/** YYYY-MM-DD prefix from API (avoid parsing as UTC midnight for all-day). */
function isoDateOnlyFromApi(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim())
  return m ? m[1] : s
}

/** Next calendar day after YYYY-MM-DD (local). FullCalendar uses exclusive end for all-day. */
function addOneCalendarDayYmd(isoYmd: string): string {
  const [y, mo, d] = isoYmd.split('-').map(Number)
  const dt = new Date(y, mo - 1, d)
  dt.setDate(dt.getDate() + 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

/** Map API event to FullCalendar all-day: date-only strings + valid exclusive end. */
function fullCalendarRangeFromApi(r: CalendarEventOut): { start: string; end: string; allDay: boolean } {
  if (!r.all_day) {
    return { start: r.start, end: r.end, allDay: false }
  }
  const start = isoDateOnlyFromApi(r.start)
  let end = isoDateOnlyFromApi(r.end)
  if (end <= start) {
    end = addOneCalendarDayYmd(start)
  }
  return { start, end, allDay: true }
}

/** Strip auto-numbering some clients put in SUMMARY (e.g. "1. Meeting"). */
function stripLeadingCalendarTitle(title: string): string {
  const once = title.replace(/^\s*\d{1,3}[.)]\s+/, '').replace(/^\s*\d{1,3}\)\s+/, '').trim()
  return once.length > 0 ? once : title
}

/** Coerce FullCalendar event start/end to YYYY-MM-DD for api_all_day transform. */
function eventInputToYmd(v: EventInput['start']): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return isoDateOnlyFromApi(v)
  if (v instanceof Date) {
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const day = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  return undefined
}

export function CalendarPage({
  token,
  onOpenSettings,
}: {
  token: string
  onOpenSettings: () => void
}) {
  const calRef = useRef<FullCalendar>(null)
  const calWrapRef = useRef<HTMLDivElement | null>(null)
  const [calendarPixelHeight, setCalendarPixelHeight] = useState(480)
  const [needCaldav, setNeedCaldav] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDeleteEventOpen, setConfirmDeleteEventOpen] = useState(false)

  const [calendars, setCalendars] = useState<UserCalendarListItem[]>([])
  const [selectedCalIds, setSelectedCalIds] = useState<string[]>([])
  const [showManage, setShowManage] = useState(false)
  const [eventCategories, setEventCategories] = useState<CalendarCategoryOut[]>([])

  const [draft, setDraft] = useState<
    | null
    | {
        kind: 'create'
        title: string
        description: string
        /** Selection anchor (date); times/duration apply when `allDay` is false. */
        start: Date
        end: Date
        allDay: boolean
        startHour: number
        /** 0–59 */
        startMinute: number
        durDays: number
        durHours: number
        /** 1–60 */
        durMinutes: number
        calendarId: string
        categoryId: string | null
      }
    | {
        kind: 'edit'
        id: string
        title: string
        description: string
        start: Date
        end: Date
        allDay: boolean
        startHour: number
        /** 0–59 */
        startMinute: number
        durDays: number
        durHours: number
        /** 1–60 */
        durMinutes: number
        canEdit: boolean
        calendarId: string
        categoryId: string | null
        categoryLabel: string | null
      }
  >(null)

  const writableCalendars = useMemo(
    () => calendars.filter((c) => c.access === 'owner' || c.access === 'write'),
    [calendars],
  )

  const refresh = useCallback(() => {
    calRef.current?.getApi().refetchEvents()
  }, [])

  const loadCalendars = useCallback(async () => {
    try {
      const rows = await apiFetch<UserCalendarListItem[]>('/users/me/calendars', { token })
      setCalendars(rows)
    } catch (e: unknown) {
      const err = e as ApiError
      if (err.status === 403) setNeedCaldav(true)
    }
  }, [token])

  useEffect(() => {
    if (needCaldav) return
    void loadCalendars()
  }, [needCaldav, loadCalendars])

  useEffect(() => {
    if (calendars.length === 0) return
    setSelectedCalIds((prev) => {
      const valid = new Set(calendars.map((c) => c.id))
      let next = prev.filter((id) => valid.has(id))
      for (const c of calendars) {
        if (!next.includes(c.id)) next = [...next, c.id]
      }
      if (next.length === 0) next = calendars.map((c) => c.id)
      return next
    })
  }, [calendars])

  useLayoutEffect(() => {
    const el = calWrapRef.current
    if (!el) return
    const apply = () => {
      const h = el.getBoundingClientRect().height
      if (h > 0) setCalendarPixelHeight(Math.floor(h))
    }
    apply()
    const ro = new ResizeObserver(() => apply())
    ro.observe(el)
    return () => ro.disconnect()
  }, [needCaldav])

  const selectionKey = selectedCalIds.join(',')

  useEffect(() => {
    if (!draft) {
      setEventCategories([])
      return
    }
    const calId = draft.kind === 'create' ? draft.calendarId : draft.calendarId
    if (!calId) {
      setEventCategories([])
      return
    }
    let cancel = false
    void apiFetch<CalendarCategoryOut[]>(`/users/me/calendars/${calId}/categories`, { token })
      .then((rows) => {
        if (!cancel) setEventCategories(rows)
      })
      .catch(() => {
        if (!cancel) setEventCategories([])
      })
    return () => {
      cancel = true
    }
  }, [draft, token])

  const transformEventFromApi = useCallback((event: EventInput): EventInput => {
    const ep = event.extendedProps as { api_all_day?: boolean } | undefined
    if (ep?.api_all_day !== true) return event
    const startY = eventInputToYmd(event.start)
    let endY = eventInputToYmd(event.end ?? event.start)
    if (!startY) return { ...event, allDay: true }
    if (!endY || endY <= startY) {
      endY = addOneCalendarDayYmd(startY)
    }
    return {
      ...event,
      allDay: true,
      start: startY,
      end: endY,
    }
  }, [])

  const onEventDidMount = useCallback((info: EventMountArg) => {
    const apiAll = info.event.extendedProps?.api_all_day === true
    if (apiAll) {
      info.el.setAttribute('data-canary-allday', '1')
      info.el.querySelectorAll('.fc-event-time').forEach((node) => {
        ;(node as HTMLElement).style.setProperty('display', 'none', 'important')
      })
      const listRow = info.el.closest('tr.fc-list-event')
      if (listRow) {
        listRow.setAttribute('data-canary-allday', '1')
        listRow.querySelectorAll('td.fc-list-event-time').forEach((td) => {
          ;(td as HTMLElement).style.setProperty('display', 'none', 'important')
        })
      }
    } else if (!info.event.allDay) {
      const listRow = info.el.closest('tr.fc-list-event')
      const td = listRow?.querySelector('td.fc-list-event-time')
      if (td) {
        const t = td.textContent?.trim() ?? ''
        if (t && !t.startsWith('(') && /\d/.test(t) && !/^all-?day$/i.test(t)) {
          td.textContent = `(${t})`
        }
      }
    }
    const row = info.el.closest('tr.fc-list-event')
    if (!row) return
    const bg = info.event.backgroundColor
    if (!bg) return
    const fg = info.event.textColor
    const el = row as HTMLElement
    el.style.backgroundColor = bg
    if (fg) el.style.color = fg
    row.querySelectorAll('td').forEach((td) => {
      ;(td as HTMLElement).style.backgroundColor = 'transparent'
    })
  }, [])

  const fetchEvents = useCallback(
    async (
      info: { startStr: string; endStr: string },
      successCallback: (events: EventInput[]) => void,
      failureCallback: (error: Error) => void,
    ) => {
      setBanner(null)
      setNeedCaldav(false)
      try {
        const params = new URLSearchParams({ start: info.startStr, end: info.endStr })
        if (calendars.length > 0 && selectedCalIds.length > 0 && selectedCalIds.length < calendars.length) {
          params.set('calendar_ids', selectedCalIds.join(','))
        }
        const rows = await apiFetch<CalendarEventOut[]>(`/users/me/calendar/events?${params}`, { token })
        successCallback(
          rows.map((r) => {
            const range = fullCalendarRangeFromApi(r)
            return {
            id: r.id,
            title: stripLeadingCalendarTitle(r.title),
            start: range.start,
            end: range.end,
            allDay: range.allDay,
            editable: r.can_edit !== false,
            display: 'block',
            backgroundColor: r.category_color ?? undefined,
            borderColor: r.category_color ?? undefined,
            textColor: r.category_color ? contrastTextForBg(r.category_color) : undefined,
            extendedProps: {
              description: r.description ?? '',
              calendar_id: r.calendar_id,
              can_edit: r.can_edit !== false,
              category_id: r.category_id ?? null,
              category_name: r.category_name ?? null,
              category_color: r.category_color ?? null,
              api_all_day: r.all_day,
            },
          }
          }),
        )
      } catch (e: unknown) {
        const err = e as ApiError
        if (err.status === 403) {
          setNeedCaldav(true)
          successCallback([])
          return
        }
        setBanner(err.message ?? 'Could not load events')
        failureCallback(err instanceof Error ? err : new Error(String(e)))
      }
    },
    [token, calendars.length, selectionKey, selectedCalIds],
  )

  function toggleCal(id: string) {
    setSelectedCalIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev
        return prev.filter((x) => x !== id)
      }
      return [...prev, id]
    })
  }

  function onSelect(selectInfo: DateSelectArg) {
    if (writableCalendars.length === 0) return
    const def = writableCalendars[0]?.id ?? ''
    const start = selectInfo.start
    const end = selectInfo.end
    const allDaySel = Boolean(selectInfo.allDay)
    let durD = 0
    let durH = 1
    let durM = 30
    if (!allDaySel && start && end) {
      const dur = timedDurationFromRange(start, end)
      durD = dur.durDays
      durH = dur.durHours
      durM = dur.durMinutes
    }
    setDraft({
      kind: 'create',
      title: '',
      description: '',
      start,
      end,
      allDay: allDaySel,
      startHour: start.getHours(),
      startMinute: start.getMinutes(),
      durDays: allDaySel ? 0 : durD,
      durHours: allDaySel ? 0 : durH,
      durMinutes: allDaySel ? 30 : durM,
      calendarId: def,
      categoryId: null,
    })
    selectInfo.view.calendar.unselect()
  }

  function onEventClick(clickInfo: EventClickArg) {
    const ev = clickInfo.event
    const s = ev.start
    const e = ev.end
    if (!s) return
    const end = e ?? s
    const canEdit = ev.extendedProps.can_edit !== false
    const ep = ev.extendedProps as {
      category_id?: string | null
      category_name?: string | null
      calendar_id?: string | null
    }
    let startHour = 9
    let startMinute = 0
    let durDays = 0
    let durHours = 1
    let durMinutes = 30
    if (!ev.allDay) {
      const sm = startHourMinuteFromDate(s)
      startHour = sm.startHour
      startMinute = sm.startMinute
      const dur = timedDurationFromRange(s, end)
      durDays = dur.durDays
      durHours = dur.durHours
      durMinutes = dur.durMinutes
    }
    setDraft({
      kind: 'edit',
      id: ev.id,
      title: ev.title || '(no title)',
      description: String(ev.extendedProps.description ?? ''),
      start: s,
      end: end,
      allDay: ev.allDay,
      startHour,
      startMinute,
      durDays,
      durHours,
      durMinutes,
      canEdit,
      calendarId: String(ep.calendar_id ?? ''),
      categoryId: ep.category_id ? String(ep.category_id) : null,
      categoryLabel: ep.category_name != null && ep.category_name !== '' ? String(ep.category_name) : null,
    })
  }

  const onEventChange = useCallback(
    async (changeInfo: EventChangeArg) => {
      if (changeInfo.event.extendedProps.can_edit === false) {
        changeInfo.revert()
        return
      }
      const ev = changeInfo.event
      const s = ev.start
      const e = ev.end
      if (!s) {
        changeInfo.revert()
        return
      }
      const endDt = e ?? s
      try {
        await apiFetch<CalendarEventOut>(`/users/me/calendar/events/${encodeURIComponent(ev.id)}`, {
          method: 'PATCH',
          token,
          json: {
            start: toBodyDate(s, ev.allDay),
            end: toBodyDate(endDt, ev.allDay),
            all_day: ev.allDay,
          },
        })
      } catch {
        changeInfo.revert()
        setBanner('Could not update event')
      }
    },
    [token],
  )

  async function saveCreate() {
    if (!draft || draft.kind !== 'create') return
    const title = draft.title.trim()
    if (!title) {
      setBanner('Title is required')
      return
    }
    const allDay = draft.allDay
    setBusy(true)
    setBanner(null)
    try {
      let bodyStart: string
      let bodyEnd: string
      if (allDay) {
        bodyStart = toBodyDate(draft.start, true)
        bodyEnd = toBodyDate(draft.end, true)
      } else {
        const anchor = startOfLocalDay(draft.start)
        const { start, end } = buildTimedStartEnd(
          anchor,
          draft.startHour,
          draft.startMinute,
          draft.durDays,
          draft.durHours,
          draft.durMinutes,
        )
        bodyStart = toBodyDate(start, false)
        bodyEnd = toBodyDate(end, false)
      }
      await apiFetch<CalendarEventOut>('/users/me/calendar/events', {
        method: 'POST',
        token,
        json: {
          title,
          description: draft.description.trim() || null,
          start: bodyStart,
          end: bodyEnd,
          all_day: allDay,
          calendar_id: draft.calendarId,
          category_id: draft.categoryId,
        },
      })
      setDraft(null)
      refresh()
    } catch (e: unknown) {
      setBanner((e as ApiError).message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit() {
    if (!draft || draft.kind !== 'edit' || !draft.canEdit) return
    const title = draft.title.trim()
    if (!title) {
      setBanner('Title is required')
      return
    }
    const allDay = draft.allDay
    setBusy(true)
    setBanner(null)
    try {
      let bodyStart: string
      let bodyEnd: string
      if (allDay) {
        bodyStart = toBodyDate(draft.start, true)
        bodyEnd = toBodyDate(draft.end, true)
      } else {
        const anchor = startOfLocalDay(draft.start)
        const { start, end } = buildTimedStartEnd(
          anchor,
          draft.startHour,
          draft.startMinute,
          draft.durDays,
          draft.durHours,
          draft.durMinutes,
        )
        bodyStart = toBodyDate(start, false)
        bodyEnd = toBodyDate(end, false)
      }
      await apiFetch<CalendarEventOut>(`/users/me/calendar/events/${encodeURIComponent(draft.id)}`, {
        method: 'PATCH',
        token,
        json: {
          title,
          description: draft.description.trim() || null,
          start: bodyStart,
          end: bodyEnd,
          all_day: allDay,
          category_id: draft.categoryId,
        },
      })
      setDraft(null)
      refresh()
    } catch (e: unknown) {
      setBanner((e as ApiError).message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  function requestDeleteEdit() {
    if (!draft || draft.kind !== 'edit' || !draft.canEdit) return
    setConfirmDeleteEventOpen(true)
  }

  async function performDeleteEditEvent() {
    if (!draft || draft.kind !== 'edit' || !draft.canEdit) return
    setConfirmDeleteEventOpen(false)
    setBusy(true)
    setBanner(null)
    try {
      await apiFetch(`/users/me/calendar/events/${encodeURIComponent(draft.id)}`, { method: 'DELETE', token })
      setDraft(null)
      refresh()
    } catch (e: unknown) {
      setBanner((e as ApiError).message ?? 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="mainMenuShell mainMenuShell--surface"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div className="paneHead">
        <div>
          <h2 style={{ margin: 0 }}>Calendar</h2>
          <div className="muted" style={{ marginTop: 4 }}>
            Radicale-backed; shared and public calendars sync here. External CalDAV still sees only your own principal.
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void loadCalendars().then(() => refresh())
            }}
            disabled={needCaldav}
          >
            Refresh
          </button>
          <button type="button" className="btn" onClick={() => setShowManage(true)} disabled={needCaldav}>
            Calendars…
          </button>
        </div>
      </div>
      {needCaldav ? (
        <div className="card" style={{ marginTop: 12, padding: 16 }}>
          <p style={{ margin: 0 }}>Turn on CalDAV in User settings to use this calendar.</p>
          <button type="button" className="btn primary" style={{ marginTop: 12 }} onClick={onOpenSettings}>
            Open User settings
          </button>
        </div>
      ) : null}
      {banner ? <div className="error" style={{ marginTop: 12 }}>{banner}</div> : null}
      {!needCaldav && calendars.length > 0 ? (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div className="muted" style={{ marginBottom: 8, fontSize: 13 }}>
            Show calendars (at least one):
          </div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            {calendars.map((c) => (
              <label key={c.id} className="row" style={{ gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selectedCalIds.includes(c.id)}
                  onChange={() => toggleCal(c.id)}
                />
                <span>
                  {c.name}
                  {c.source !== 'owned' ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {' '}
                      — {c.owner.display_name}
                      {c.access === 'read' ? ' (read-only)' : ''}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <div
        className="card canaryCalendar"
        style={{
          marginTop: 12,
          padding: 12,
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div ref={calWrapRef} className="canaryCalendarInner">
          <FullCalendar
          ref={calRef}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
          }}
          height={calendarPixelHeight}
          editable={!needCaldav}
          selectable={!needCaldav && writableCalendars.length > 0}
          selectMirror
          dayMaxEvents
          weekends
          events={fetchEvents}
          eventDataTransform={needCaldav ? undefined : transformEventFromApi}
          eventDidMount={needCaldav ? undefined : onEventDidMount}
          select={needCaldav ? undefined : onSelect}
          eventClick={needCaldav ? undefined : onEventClick}
          eventDrop={needCaldav ? undefined : onEventChange}
          eventResize={needCaldav ? undefined : onEventChange}
          nowIndicator
          eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
        />
        </div>
      </div>

      {showManage ? (
        <CalendarManageModal
          token={token}
          calendars={calendars}
          onClose={() => setShowManage(false)}
          onChanged={() => {
            void loadCalendars().then(() => refresh())
          }}
        />
      ) : null}

      {draft ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 20,
            padding: 16,
          }}
          onClick={() => !busy && setDraft(null)}
          onKeyDown={(e) => e.key === 'Escape' && !busy && setDraft(null)}
          role="presentation"
        >
          <div
            className="card"
            style={{
              maxWidth:
                draft.kind === 'create' || (draft.kind === 'edit' && draft.canEdit) ? 480 : 440,
              width: '100%',
              padding: 20,
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <h3 style={{ marginTop: 0 }}>{draft.kind === 'create' ? 'New event' : 'Edit event'}</h3>
            <div className="stack" style={{ gap: 12 }}>
              {draft.kind === 'create' ? (
                <label className="field">
                  <span>Calendar</span>
                  <select
                    value={draft.calendarId}
                    onChange={(e) => setDraft({ ...draft, calendarId: e.target.value, categoryId: null })}
                    disabled={busy}
                  >
                    {writableCalendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.source !== 'owned' ? ` (${c.owner.display_name})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {draft.kind === 'create' || (draft.kind === 'edit' && draft.canEdit) ? (
                <>
                  {!draft.allDay ? (
                    <>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <span>Start</span>
                        <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select
                            aria-label="Start hour"
                            value={draft.startHour}
                            disabled={busy}
                            onChange={(e) =>
                              setDraft({ ...draft, startHour: Number.parseInt(e.target.value, 10) })
                            }
                          >
                            {HOURS_00_23.map((h) => (
                              <option key={h} value={h}>
                                {pad2(h)}
                              </option>
                            ))}
                          </select>
                          <span className="muted">:</span>
                          <select
                            aria-label="Start minute"
                            value={draft.startMinute}
                            disabled={busy}
                            onChange={(e) =>
                              setDraft({ ...draft, startMinute: Number.parseInt(e.target.value, 10) })
                            }
                          >
                            {START_MINS_00_59.map((m) => (
                              <option key={m} value={m} style={minuteOptionStyle(m)}>
                                {pad2(m)}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <span>Duration</span>
                        <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select
                            aria-label="Duration days"
                            value={draft.durDays}
                            disabled={busy}
                            onChange={(e) =>
                              setDraft({ ...draft, durDays: Number.parseInt(e.target.value, 10) })
                            }
                          >
                            {DUR_DAYS_0_99.map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                          <span className="muted">d</span>
                          <select
                            aria-label="Duration hours"
                            value={draft.durHours}
                            disabled={busy}
                            onChange={(e) =>
                              setDraft({ ...draft, durHours: Number.parseInt(e.target.value, 10) })
                            }
                          >
                            {DUR_HOURS_0_24.map((h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                          <span className="muted">h</span>
                          <select
                            aria-label="Duration minutes"
                            value={draft.durMinutes}
                            disabled={busy}
                            onChange={(e) =>
                              setDraft({ ...draft, durMinutes: Number.parseInt(e.target.value, 10) })
                            }
                          >
                            {DUR_MINS_1_60.map((m) => (
                              <option key={m} value={m} style={minuteOptionStyle(m)}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <span className="muted">m</span>
                        </div>
                      </div>
                    </>
                  ) : null}
                  <label className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 4 }}>
                    <input
                      type="checkbox"
                      checked={draft.allDay}
                      disabled={busy}
                      onChange={(e) => {
                        const checked = e.target.checked
                        if (checked) {
                          const s = startOfLocalDay(draft.start)
                          const en = addDaysLocal(s, 1)
                          setDraft({ ...draft, allDay: true, start: s, end: en })
                        } else {
                          const { start, end } = buildTimedStartEnd(
                            startOfLocalDay(draft.start),
                            draft.startHour,
                            draft.startMinute,
                            draft.durDays,
                            draft.durHours,
                            draft.durMinutes,
                          )
                          setDraft({ ...draft, allDay: false, start, end })
                        }
                      }}
                    />
                    <span>All day</span>
                  </label>
                </>
              ) : null}
              {draft.kind === 'edit' && !draft.canEdit ? (
                <p className="muted">You can view this event but not edit it (read-only share or subscription).</p>
              ) : null}
              <label className="field">
                <span>Title</span>
                <input
                  value={draft.title}
                  onChange={(e) =>
                    setDraft(
                      draft.kind === 'create'
                        ? { ...draft, title: e.target.value }
                        : { ...draft, title: e.target.value },
                    )
                  }
                  disabled={busy || (draft.kind === 'edit' && !draft.canEdit)}
                  autoFocus={draft.kind === 'create' || (draft.kind === 'edit' && draft.canEdit)}
                />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea
                  rows={3}
                  value={draft.description}
                  onChange={(e) =>
                    setDraft(
                      draft.kind === 'create'
                        ? { ...draft, description: e.target.value }
                        : { ...draft, description: e.target.value },
                    )
                  }
                  disabled={busy || (draft.kind === 'edit' && !draft.canEdit)}
                />
              </label>
              {draft.kind === 'edit' && !draft.canEdit ? (
                <div className="muted" style={{ fontSize: 13 }}>
                  Category (Canary): {draft.categoryLabel ?? '—'}
                </div>
              ) : (
                <label className="field">
                  <span>Category (Canary only)</span>
                  <select
                    value={draft.categoryId ?? ''}
                    onChange={(e) =>
                      setDraft(
                        draft.kind === 'create'
                          ? { ...draft, categoryId: e.target.value || null }
                          : { ...draft, categoryId: e.target.value || null },
                      )
                    }
                    disabled={busy}
                  >
                    <option value="">None</option>
                    {eventCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {draft.kind === 'create'
                  ? draft.allDay
                    ? 'Saved as all-day — you can edit or delete this entry later.'
                    : 'Saved with the start time and duration above — you can edit or delete this entry later.'
                  : draft.kind === 'edit' && draft.canEdit
                    ? draft.allDay
                      ? 'All-day — drag the event on the calendar to change the date, or adjust options above.'
                      : 'Start time and duration are set above; you can also drag or resize the event on the calendar.'
                    : draft.kind === 'edit' && !draft.canEdit
                      ? draft.allDay
                        ? 'All-day event — drag on the grid to reschedule when you can edit.'
                        : 'Timed event — drag on the grid to reschedule when you can edit.'
                      : null}
              </p>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              {draft.kind === 'edit' && draft.canEdit ? (
                <button type="button" className="btn primary" disabled={busy} onClick={() => void saveEdit()}>
                  Save
                </button>
              ) : null}
              {draft.kind === 'create' ? (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !draft.title.trim()}
                  onClick={() => void saveCreate()}
                >
                  Save
                </button>
              ) : null}
              <button type="button" className="btn" disabled={busy} onClick={() => setDraft(null)}>
                Close
              </button>
              {draft.kind === 'edit' && draft.canEdit ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => requestDeleteEdit()}
                  style={{ marginLeft: 'auto', color: 'var(--danger)' }}
                >
                  Delete
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        open={confirmDeleteEventOpen}
        title="Delete event?"
        message="Delete this calendar event? This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        busy={busy}
        onConfirm={() => void performDeleteEditEvent()}
        onCancel={() => setConfirmDeleteEventOpen(false)}
      />
    </div>
  )
}

function CalendarManageModal({
  token,
  calendars,
  onClose,
  onChanged,
}: {
  token: string
  calendars: UserCalendarListItem[]
  onClose: () => void
  onChanged: () => void
}) {
  const { askConfirm } = useDialogs()
  const [newName, setNewName] = useState('')
  const [dirQ, setDirQ] = useState('')
  const [dirRows, setDirRows] = useState<CalendarDirectoryRow[] | null>(null)
  const [dirBusy, setDirBusy] = useState(false)
  const [users, setUsers] = useState<UserSummary[]>([])
  const [shares, setShares] = useState<CalendarShareOut[]>([])
  const [pickGrantee, setPickGrantee] = useState('')
  const [pickCanWrite, setPickCanWrite] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editCalId, setEditCalId] = useState<string | null>(null)
  const [editCategoryRows, setEditCategoryRows] = useState<CalendarCategoryOut[]>([])

  const owned = useMemo(() => calendars.filter((c) => c.access === 'owner'), [calendars])

  const editingCal = useMemo(
    () => (editCalId ? calendars.find((c) => c.id === editCalId) : undefined),
    [calendars, editCalId],
  )

  const loadEditCategories = useCallback(async () => {
    if (!editCalId) {
      setEditCategoryRows([])
      return
    }
    try {
      const rows = await apiFetch<CalendarCategoryOut[]>(`/users/me/calendars/${editCalId}/categories`, { token })
      setEditCategoryRows(rows)
    } catch {
      setEditCategoryRows([])
    }
  }, [editCalId, token])

  useEffect(() => {
    void loadEditCategories()
  }, [loadEditCategories])

  useEffect(() => {
    if (editCalId && !calendars.some((c) => c.id === editCalId)) {
      setEditCalId(null)
    }
  }, [calendars, editCalId])

  useEffect(() => {
    void apiFetch<UserSummary[]>('/users', { token })
      .then(setUsers)
      .catch(() => setUsers([]))
  }, [token])

  async function searchDir() {
    const q = dirQ.trim()
    if (q.length < 1) return
    setDirBusy(true)
    setErr(null)
    try {
      const rows = await apiFetch<CalendarDirectoryRow[]>(
        `/users/me/calendars/directory?q=${encodeURIComponent(q)}`,
        { token },
      )
      setDirRows(rows)
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Search failed')
    } finally {
      setDirBusy(false)
    }
  }

  async function createCal() {
    const name = newName.trim()
    if (name.length < 1) return
    setBusy(true)
    setErr(null)
    try {
      await apiFetch('/users/me/calendars', { method: 'POST', token, json: { name } })
      setNewName('')
      onChanged()
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  async function loadSharesForEdit(calId: string) {
    try {
      const rows = await apiFetch<CalendarShareOut[]>(`/users/me/calendars/${calId}/shares`, { token })
      setShares(rows)
    } catch {
      setShares([])
    }
  }

  function openCalendarEdit(calId: string) {
    setErr(null)
    setEditCalId(calId)
    void loadSharesForEdit(calId)
  }

  async function togglePublic(calId: string, cur: boolean) {
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/users/me/calendars/${calId}`, { method: 'PATCH', token, json: { is_public: !cur } })
      onChanged()
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  async function addShare(calId: string) {
    const id = pickGrantee
    if (!id) return
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/users/me/calendars/${calId}/shares`, {
        method: 'POST',
        token,
        json: { grantee_user_id: id, can_write: pickCanWrite },
      })
      setPickGrantee('')
      setPickCanWrite(false)
      await loadSharesForEdit(calId)
      onChanged()
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Share failed')
    } finally {
      setBusy(false)
    }
  }

  async function removeShare(calId: string, granteeId: string) {
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/users/me/calendars/${calId}/shares/${granteeId}`, { method: 'DELETE', token })
      await loadSharesForEdit(calId)
      onChanged()
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Remove share failed')
    } finally {
      setBusy(false)
    }
  }

  async function subscribe(calId: string) {
    setBusy(true)
    setErr(null)
    try {
      await apiFetch('/users/me/calendars/subscribe', { method: 'POST', token, json: { calendar_id: calId } })
      onChanged()
      setDirRows(null)
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Subscribe failed')
    } finally {
      setBusy(false)
    }
  }

  async function unsubscribe(calId: string) {
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/users/me/calendars/${calId}/subscription`, { method: 'DELETE', token })
      onChanged()
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Unsubscribe failed')
    } finally {
      setBusy(false)
    }
  }

  async function deleteOwnedCalendar(calId: string, name: string) {
    const ok = await askConfirm({
      title: 'Delete calendar',
      message: `Delete calendar “${name}”? All events in this calendar will be removed from the server. Shares and Canary categories for it will be removed. This cannot be undone.`,
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/users/me/calendars/${calId}`, { method: 'DELETE', token })
      setEditCalId((prev) => (prev === calId ? null : prev))
      onChanged()
    } catch (e: unknown) {
      setErr((e as ApiError).message ?? 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.35)',
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && (editCalId ? setEditCalId(null) : onClose())}
      role="presentation"
    >
      <div
        className="card"
        style={{ maxWidth: 560, width: '100%', maxHeight: '90vh', overflow: 'auto', padding: 20 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        {err ? <div className="error" style={{ marginBottom: 12 }}>{err}</div> : null}

        {editCalId && editingCal && editingCal.access === 'owner' ? (
          <>
            <div className="row" style={{ marginBottom: 16, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setEditCalId(null)}>
                ← Back
              </button>
            </div>
            <h3 style={{ marginTop: 0 }}>{editingCal.name}</h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              Change who can see this calendar, whether it appears in the public directory, and Canary-only event
              categories (not synced to external CalDAV).
            </p>

            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              <span className="muted" style={{ fontSize: 13 }}>
                Public directory
              </span>
              <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={editingCal.is_public}
                  disabled={busy}
                  onChange={() => void togglePublic(editingCal.id, editingCal.is_public)}
                />
              </label>
            </div>

            <h4 style={{ margin: '0 0 8px' }}>Access</h4>
            <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
              Grant Canary users access (in-app + CalDAV via server). External clients only see their own principal.
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
              <select value={pickGrantee} onChange={(e) => setPickGrantee(e.target.value)}>
                <option value="">Select user…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name} ({u.email})
                  </option>
                ))}
              </select>
              <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={pickCanWrite} onChange={(e) => setPickCanWrite(e.target.checked)} />
                <span className="muted" style={{ fontSize: 13 }}>Can edit</span>
              </label>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !pickGrantee}
                onClick={() => void addShare(editingCal.id)}
              >
                Add
              </button>
            </div>
            <ul style={{ margin: '0 0 20px', paddingLeft: 18 }}>
              {shares.map((s) => (
                <li key={s.grantee_user_id} style={{ marginBottom: 4 }}>
                  {s.grantee_display_name} ({s.grantee_email}) — {s.can_write ? 'edit' : 'view'}
                  <button
                    type="button"
                    className="btn"
                    style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}
                    disabled={busy}
                    onClick={() => void removeShare(editingCal.id, s.grantee_user_id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>

            <h4 style={{ margin: '0 0 8px' }}>Event categories (Canary only)</h4>
            <p className="muted" style={{ marginTop: 0, fontSize: 13, marginBottom: 8 }}>
              Labels and colours for the in-app calendar. Everyone who can see this calendar can view its categories.
            </p>
            <CalendarCategoriesPanel
              token={token}
              calendar={editingCal}
              rows={editCategoryRows}
              isOwner
              busy={busy}
              setBusy={setBusy}
              setErr={setErr}
              onRefresh={() => void loadEditCategories()}
              embedded
            />

            <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setEditCalId(null)}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
        <h3 style={{ marginTop: 0 }}>Calendars</h3>
        <section style={{ marginBottom: 20 }}>
          <h4 style={{ margin: '0 0 8px' }}>New calendar</h4>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input
              placeholder="Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={{ flex: '1 1 200px' }}
            />
            <button type="button" className="btn primary" disabled={busy} onClick={() => void createCal()}>
              Create
            </button>
          </div>
        </section>

        <section style={{ marginBottom: 20 }}>
          <h4 style={{ margin: '0 0 8px' }}>Find calendar by name</h4>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Lists public calendars and calendars already shared with you. Subscribe to add a public calendar to your list.
          </p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <SearchInput
              placeholder="Search…"
              value={dirQ}
              onChange={(e) => setDirQ(e.target.value)}
              onClear={() => setDirQ('')}
              style={{ flex: '1 1 200px' }}
              aria-label="Search calendars"
            />
            <button type="button" className="btn" disabled={dirBusy} onClick={() => void searchDir()}>
              Search
            </button>
          </div>
          {dirRows ? (
            <div className="stack" style={{ marginTop: 12, gap: 8 }}>
              {dirRows.length === 0 ? (
                <div className="muted">No matches.</div>
              ) : (
                dirRows.map((r) => (
                  <div
                    key={r.id}
                    className="row"
                    style={{
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 10px',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    <div>
                      <strong>{r.name}</strong>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.owner.display_name} — {r.is_public ? 'public' : 'shared with you'}
                        {r.shared_directly ? ' — already shared' : ''}
                      </div>
                    </div>
                    {r.can_subscribe ? (
                      <button type="button" className="btn primary" disabled={busy} onClick={() => void subscribe(r.id)}>
                        Subscribe
                      </button>
                    ) : (
                      <span className="muted" style={{ fontSize: 13 }}>
                        {r.already_in_my_list ? 'In your list' : '—'}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : null}
        </section>

        <section>
          <h4 style={{ margin: '0 0 8px' }}>Your calendars</h4>
          {owned.map((c) => (
            <div key={c.id} style={{ marginBottom: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <strong>{c.name}</strong>
              </div>
              <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn primary" disabled={busy} onClick={() => openCalendarEdit(c.id)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void deleteOwnedCalendar(c.id, c.name)}
                  style={{ color: 'var(--danger)' }}
                >
                  Delete calendar…
                </button>
              </div>
            </div>
          ))}
        </section>

        <section style={{ marginTop: 20 }}>
          <h4 style={{ margin: '0 0 8px' }}>Subscriptions</h4>
          {calendars.filter((c) => c.source === 'subscription').map((c) => (
            <div key={c.id} className="row" style={{ justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
              <span>
                {c.name} <span className="muted">— {c.owner.display_name}</span>
              </span>
              <button type="button" className="btn" disabled={busy} onClick={() => void unsubscribe(c.id)}>
                Unsubscribe
              </button>
            </div>
          ))}
          {calendars.every((c) => c.source !== 'subscription') ? (
            <div className="muted" style={{ fontSize: 13 }}>No subscriptions yet.</div>
          ) : null}
        </section>

        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
          </>
        )}
      </div>
    </div>
  )
}

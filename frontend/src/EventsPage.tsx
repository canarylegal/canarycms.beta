import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from './api'
import type { ApiError } from './api'
import type { CalendarEventOut, CaseEventOut, CaseEventsOut } from './types'

interface Props {
  caseId: string
  token: string
  /** Shown in linked calendar event titles (e.g. case number + short description). */
  caseLabel?: string
  onClose: () => void
}

function toInputDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ''
}

function datesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = !a || !a.trim()
  const nb = !b || !b.trim()
  if (na && nb) return true
  if (na !== nb) return false
  return new Date(a as string).getTime() === new Date(b as string).getTime()
}

function eventRowChanged(was: CaseEventOut | undefined, ev: CaseEventOut): boolean {
  if (!was) return true
  if (!datesEqual(was.event_date, ev.event_date)) return true
  if ((was.track_in_calendar ?? false) !== (ev.track_in_calendar ?? false)) return true
  return false
}

/** All-day UTC range for CalDAV (exclusive end date). */
function allDayExclusiveEnd(iso: string | null | undefined): { start: string; end: string } | null {
  const d = iso?.slice(0, 10)
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  const [y, m, day] = d.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, day))
  next.setUTCDate(next.getUTCDate() + 1)
  return { start: d, end: next.toISOString().slice(0, 10) }
}

async function syncCalendarsForCaseEvents(
  events: CaseEventOut[],
  caseId: string,
  token: string,
  caseLabel: string,
): Promise<void> {
  const label = caseLabel.trim() || 'Case'
  for (const ev of events) {
    const range = allDayExclusiveEnd(ev.event_date ?? null)
    const track = Boolean(ev.track_in_calendar && range)

    if (!track) {
      if (ev.calendar_event_uid) {
        try {
          await apiFetch(`/users/me/calendar/events/${encodeURIComponent(ev.calendar_event_uid)}`, {
            method: 'DELETE',
            token,
          })
        } catch {
          /* event already removed */
        }
        try {
          await apiFetch(`/cases/${caseId}/events/${ev.id}`, {
            token,
            method: 'PATCH',
            json: { calendar_event_uid: null },
          })
        } catch {
          /* best effort */
        }
      }
      continue
    }

    const title = `${label}: ${ev.name}`.slice(0, 500)
    const desc = `Canary tracked case event (${label}).`
    const calBody = {
      title,
      start: range!.start,
      end: range!.end,
      all_day: true,
      description: desc,
    }

    if (ev.calendar_event_uid) {
      try {
        await apiFetch(`/users/me/calendar/events/${encodeURIComponent(ev.calendar_event_uid)}`, {
          token,
          method: 'PATCH',
          json: calBody,
        })
      } catch {
        try {
          const created = await apiFetch<CalendarEventOut>(`/users/me/calendar/events`, {
            token,
            method: 'POST',
            json: calBody,
          })
          await apiFetch(`/cases/${caseId}/events/${ev.id}`, {
            token,
            method: 'PATCH',
            json: { calendar_event_uid: created.id },
          })
        } catch {
          /* CalDAV unavailable */
        }
      }
    } else {
      try {
        const created = await apiFetch<CalendarEventOut>(`/users/me/calendar/events`, {
          token,
          method: 'POST',
          json: calBody,
        })
        await apiFetch(`/cases/${caseId}/events/${ev.id}`, {
          token,
          method: 'PATCH',
          json: { calendar_event_uid: created.id },
        })
      } catch {
        /* CalDAV unavailable */
      }
    }
  }
}

export function EventsPage({ caseId, token, caseLabel = '', onClose }: Props) {
  const [data, setData] = useState<CaseEventsOut | null>(null)
  const [baseline, setBaseline] = useState<CaseEventsOut | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [customName, setCustomName] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    setErr(null)
    try {
      const out = await apiFetch<CaseEventsOut>(`/cases/${caseId}/events`, { token })
      setData(out)
      setBaseline(JSON.parse(JSON.stringify(out)) as CaseEventsOut)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to load events')
      setData(null)
      setBaseline(null)
    } finally {
      setBusy(false)
    }
  }, [caseId, token])

  useEffect(() => {
    void load()
  }, [load])

  function discard() {
    if (baseline) {
      setData(JSON.parse(JSON.stringify(baseline)) as CaseEventsOut)
    }
    setCustomName('')
    onClose()
  }

  async function saveAllAndClose() {
    if (!data) {
      onClose()
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const baseEv = new Map((baseline?.events ?? []).map((e) => [e.id, e]))
      for (const ev of data.events) {
        const was = baseEv.get(ev.id)
        if (!eventRowChanged(was, ev)) continue
        const raw = ev.event_date
        const d = raw != null && String(raw).trim() !== '' ? String(raw).slice(0, 10) : null
        await apiFetch<CaseEventOut>(`/cases/${caseId}/events/${ev.id}`, {
          token,
          method: 'PATCH',
          json: {
            event_date: d,
            track_in_calendar: ev.track_in_calendar ?? false,
          },
        })
      }
      let fresh = await apiFetch<CaseEventsOut>(`/cases/${caseId}/events`, { token })
      await syncCalendarsForCaseEvents(fresh.events, caseId, token, caseLabel)
      fresh = await apiFetch<CaseEventsOut>(`/cases/${caseId}/events`, { token })
      setBaseline(JSON.parse(JSON.stringify(fresh)) as CaseEventsOut)
      onClose()
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to save events')
    } finally {
      setBusy(false)
    }
  }

  async function addCustomEvent() {
    const name = customName.trim()
    if (!name) return
    setBusy(true)
    setErr(null)
    try {
      const created = await apiFetch<CaseEventOut>(`/cases/${caseId}/events`, {
        token,
        method: 'POST',
        json: { name },
      })
      setData((prev) =>
        prev
          ? { ...prev, events: [...prev.events, created] }
          : { case_id: caseId, events: [created] },
      )
      setBaseline((prev) =>
        prev
          ? { ...prev, events: [...prev.events, created] }
          : { case_id: caseId, events: [created] },
      )
      setCustomName('')
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to add event')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack" style={{ padding: '4px 4px 0' }}>
      <div className="paneHead" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>Events</h2>
          <div className="muted" style={{ marginTop: 4 }}>
            Set dates and optionally track in your calendar. When you track an event (with a date), Canary adds a task for
            the fee earner with higher priority when the date is within five UK working days or overdue. Save and close to
            apply.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn" disabled={busy} onClick={discard}>
            Discard changes
          </button>
          <button
            type="button"
            className="btn"
            style={{ background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' }}
            disabled={busy}
            onClick={() => void saveAllAndClose()}
          >
            Save and close
          </button>
        </div>
      </div>

      {err ? <div className="error">{err}</div> : null}

      <div className="stack" style={{ gap: 8, marginBottom: 12 }}>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Custom event (this case only)</span>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              style={{ flex: 1 }}
              value={customName}
              placeholder="Event name…"
              disabled={busy}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addCustomEvent()
              }}
            />
            <button
              type="button"
              className="btn primary"
              disabled={busy || !customName.trim()}
              onClick={() => void addCustomEvent()}
            >
              Add
            </button>
          </div>
        </label>
      </div>

      {busy && !data ? <div className="muted">Loading…</div> : null}

      {data && data.events.length === 0 ? (
        <div className="muted">
          No events yet. Add a custom event above, or ask an administrator to configure template lines under Admin →
          Sub-Menus.
        </div>
      ) : null}

      {data && data.events.length > 0 ? (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div
            className="row"
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--border)',
              fontWeight: 600,
              fontSize: '0.85rem',
              color: 'var(--muted)',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <span style={{ flex: '1 1 160px' }}>Event</span>
            <span style={{ width: 200 }}>Date</span>
            <span style={{ width: 100 }}>Calendar</span>
          </div>
          <div>
            {data.events.map((ev) => (
              <div
                key={ev.id}
                className="row"
                style={{
                  padding: '12px 14px',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ flex: '1 1 160px', minWidth: 0 }}>{ev.name}</span>
                <div className="row" style={{ width: 200, alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <input
                    type="date"
                    style={{ flex: 1, minWidth: 0 }}
                    value={toInputDate(ev.event_date ?? undefined)}
                    disabled={busy}
                    onChange={(e) => {
                      const v = e.target.value
                      setData((prev) => {
                        if (!prev) return prev
                        const event_date = v === '' ? null : `${v}T12:00:00.000Z`
                        return {
                          ...prev,
                          events: prev.events.map((x) => (x.id === ev.id ? { ...x, event_date } : x)),
                        }
                      })
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    style={{ padding: '4px 8px', fontSize: 12 }}
                    disabled={busy || !ev.event_date}
                    title="Clear date"
                    onClick={() =>
                      setData((prev) => {
                        if (!prev) return prev
                        return {
                          ...prev,
                          events: prev.events.map((x) =>
                            x.id === ev.id ? { ...x, event_date: null } : x,
                          ),
                        }
                      })
                    }
                  >
                    Clear
                  </button>
                </div>
                <label className="row" style={{ width: 100, gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={ev.track_in_calendar ?? false}
                    disabled={busy || !ev.event_date}
                    onChange={(e) =>
                      setData((prev) => {
                        if (!prev) return prev
                        return {
                          ...prev,
                          events: prev.events.map((x) =>
                            x.id === ev.id ? { ...x, track_in_calendar: e.target.checked } : x,
                          ),
                        }
                      })
                    }
                  />
                  <span className="muted" style={{ fontSize: 12 }}>
                    Track
                  </span>
                </label>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

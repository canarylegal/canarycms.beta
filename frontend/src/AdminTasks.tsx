import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { useDialogs } from './DialogProvider'
import type { ApiError } from './api'
import type { MatterHeadTypeOut, MatterSubTypeStandardTaskOut } from './types'

export function AdminTasks({ token }: { token: string }) {
  const { askConfirm } = useDialogs()
  const [heads, setHeads] = useState<MatterHeadTypeOut[]>([])
  const [selectedHeadId, setSelectedHeadId] = useState<string | null>(null)
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null)
  const [templates, setTemplates] = useState<MatterSubTypeStandardTaskOut[]>([])
  const [newTitle, setNewTitle] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function loadHeads() {
    setErr(null)
    try {
      const data = await apiFetch<MatterHeadTypeOut[]>('/matter-types', { token })
      setHeads(data)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to load matter types')
    }
  }

  async function loadTemplates(subId: string) {
    setErr(null)
    try {
      const data = await apiFetch<MatterSubTypeStandardTaskOut[]>(
        `/admin/standard-tasks/by-sub-type/${subId}`,
        { token },
      )
      setTemplates(Array.isArray(data) ? data : [])
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to load standard tasks')
      setTemplates([])
    }
  }

  useEffect(() => {
    void loadHeads()
  }, [token])

  useEffect(() => {
    setSelectedSubId(null)
  }, [selectedHeadId])

  useEffect(() => {
    if (!selectedSubId) {
      setTemplates([])
      return
    }
    void loadTemplates(selectedSubId)
  }, [selectedSubId, token])

  const selectedHead = heads.find((h) => h.id === selectedHeadId) ?? null
  const selectedSub = selectedHead?.sub_types.find((s) => s.id === selectedSubId) ?? null

  return (
    <div className="stack">
      {err ? <div className="error">{err}</div> : null}

      <div className="muted" style={{ fontSize: '0.95em', marginBottom: 8 }}>
        Choose a matter sub-type, then add task titles that appear when users create a <strong>Task</strong> on a case of
        that type.
      </div>

      <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>
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
                <span className="listTitle">{h.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {h.sub_types.length} sub
                </span>
              </div>
            ))}
            {heads.length === 0 ? <div className="muted">No head types — create them under Matters.</div> : null}
          </div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Sub types</h3>
          {!selectedHeadId ? (
            <div className="muted">Select a head type first.</div>
          ) : (
            <div className="list">
              {selectedHead!.sub_types.map((s) => (
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
                  <span className="listTitle">{s.name}</span>
                </div>
              ))}
              {selectedHead!.sub_types.length === 0 ? (
                <div className="muted">No sub types — add them under Matters.</div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {selectedSub ? (
        <div className="card">
          <div className="paneHead">
            <h3 style={{ margin: 0 }}>Standard tasks · {selectedSub.name}</h3>
            <button type="button" className="btn" disabled={busy} onClick={() => void loadTemplates(selectedSub.id)}>
              Refresh
            </button>
          </div>
          <div className="stack" style={{ marginTop: 12, gap: 10 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                placeholder="New standard task title…"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                style={{ flex: '1 1 220px', minWidth: 160 }}
              />
              <button
                type="button"
                className="btn primary"
                disabled={busy || !newTitle.trim()}
                onClick={async () => {
                  setBusy(true)
                  setErr(null)
                  try {
                    await apiFetch<MatterSubTypeStandardTaskOut>('/admin/standard-tasks', {
                      token,
                      method: 'POST',
                      json: {
                        matter_sub_type_id: selectedSub.id,
                        title: newTitle.trim(),
                        sort_order: templates.length,
                      },
                    })
                    setNewTitle('')
                    await loadTemplates(selectedSub.id)
                  } catch (e) {
                    setErr((e as ApiError).message ?? 'Failed to add')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Add
              </button>
            </div>
            <div className="list">
              {templates.map((t) => (
                <div key={t.id} className="listCard row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  {t.is_system ? (
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{t.title}</div>
                      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                        Built-in — applies to all matter types and sub-types; cannot be edited or removed.
                      </div>
                    </div>
                  ) : (
                    <>
                      <input
                        defaultValue={t.title}
                        key={t.id + t.updated_at}
                        disabled={busy}
                        style={{ flex: 1, minWidth: 0 }}
                        onBlur={async (e) => {
                          const v = e.target.value.trim()
                          if (!v || v === t.title) return
                          setBusy(true)
                          setErr(null)
                          try {
                            await apiFetch(`/admin/standard-tasks/${t.id}`, {
                              token,
                              method: 'PATCH',
                              json: { title: v },
                            })
                            await loadTemplates(selectedSub.id)
                          } catch (err2) {
                            setErr((err2 as ApiError).message ?? 'Failed to update')
                            e.target.value = t.title
                          } finally {
                            setBusy(false)
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={async () => {
                          const ok = await askConfirm({
                            title: 'Remove standard task',
                            message: 'Remove this standard task?',
                            danger: true,
                            confirmLabel: 'Remove',
                          })
                          if (!ok) return
                          setBusy(true)
                          setErr(null)
                          try {
                            await apiFetch(`/admin/standard-tasks/${t.id}`, { token, method: 'DELETE' })
                            await loadTemplates(selectedSub.id)
                          } catch (err2) {
                            setErr((err2 as ApiError).message ?? 'Failed to delete')
                          } finally {
                            setBusy(false)
                          }
                        }}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              ))}
              {templates.length === 0 ? <div className="muted">No standard tasks yet for this sub-type.</div> : null}
            </div>
          </div>
        </div>
      ) : selectedHeadId ? (
        <div className="muted">Select a sub type to edit standard tasks.</div>
      ) : null}
    </div>
  )
}

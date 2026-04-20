import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { useDialogs } from './DialogProvider'
import type { ApiError } from './api'
import type { MatterSubTypeEventTemplateOut } from './types'

interface Props {
  token: string
  subTypeId: string
  subTypeName: string
}

const SMALL: React.CSSProperties = { padding: '3px 8px', fontSize: '0.82em' }
const INLINE: React.CSSProperties = { flex: 1, width: 'auto', minWidth: 120 }

export function AdminEventsTemplate({ token, subTypeId, subTypeName }: Props) {
  const { askConfirm } = useDialogs()
  const [rows, setRows] = useState<MatterSubTypeEventTemplateOut[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newOrder, setNewOrder] = useState('0')
  const [edit, setEdit] = useState<{ id: string; name: string; sort_order: string } | null>(null)

  async function load() {
    setBusy(true)
    setErr(null)
    try {
      const data = await apiFetch<MatterSubTypeEventTemplateOut[]>(
        `/admin/sub-menus/events/templates/${subTypeId}`,
        { token },
      )
      setRows(data)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to load events template')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    setRows([])
    setNewName('')
    setNewOrder('0')
    setEdit(null)
    void load()
  }, [subTypeId, token])

  async function addRow() {
    if (!newName.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await apiFetch('/admin/sub-menus/events/templates', {
        token,
        method: 'POST',
        json: {
          matter_sub_type_id: subTypeId,
          name: newName.trim(),
          sort_order: parseInt(newOrder, 10) || 0,
        },
      })
      setNewName('')
      setNewOrder('0')
      await load()
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to add')
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit() {
    if (!edit) return
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/admin/sub-menus/events/templates/${edit.id}`, {
        token,
        method: 'PATCH',
        json: { name: edit.name.trim(), sort_order: parseInt(edit.sort_order, 10) || 0 },
      })
      setEdit(null)
      await load()
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  async function removeRow(id: string) {
    const ok = await askConfirm({
      title: 'Remove template line',
      message: 'Remove this event line from the template?',
      danger: true,
      confirmLabel: 'Remove',
    })
    if (!ok) return
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/admin/sub-menus/events/templates/${id}`, { token, method: 'DELETE' })
      await load()
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to remove')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="adminFinanceSection" style={{ marginTop: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>
          Events template — <span style={{ fontWeight: 400 }}>{subTypeName}</span>
        </div>
        <button type="button" className="btn" style={SMALL} disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="muted" style={{ marginBottom: 12, fontSize: '0.9em' }}>
        Event names and order shown when a user opens Events on a case of this sub-type (after you assign the Events menu
        under Matters). Lower numbers appear first.
      </div>
      {err ? <div className="error" style={{ marginBottom: 8 }}>{err}</div> : null}

      <div className="list">
        {rows.map((r) => (
          <div key={r.id} className="listCard row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            {edit?.id === r.id ? (
              <>
                <input
                  style={INLINE}
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  disabled={busy}
                />
                <input
                  style={{ width: 72 }}
                  type="number"
                  value={edit.sort_order}
                  onChange={(e) => setEdit({ ...edit, sort_order: e.target.value })}
                  disabled={busy}
                />
                <div className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn" style={SMALL} disabled={busy} onClick={() => void saveEdit()}>
                    Save
                  </button>
                  <button type="button" className="btn" style={SMALL} disabled={busy} onClick={() => setEdit(null)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="listTitle" style={{ flex: 1, minWidth: 0 }}>
                  {r.name}{' '}
                  <span className="muted adminFinanceCatOrder" style={{ fontSize: '0.85em' }}>
                    #{r.sort_order}
                  </span>
                </span>
                <div className="row" style={{ gap: 4 }}>
                  <button
                    type="button"
                    className="btn"
                    style={SMALL}
                    disabled={busy}
                    onClick={() => setEdit({ id: r.id, name: r.name, sort_order: String(r.sort_order) })}
                  >
                    Edit
                  </button>
                  <button type="button" className="btn danger" style={SMALL} disabled={busy} onClick={() => void removeRow(r.id)}>
                    Remove
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {rows.length === 0 ? <div className="muted" style={{ padding: '8px 0' }}>No event lines yet.</div> : null}
      </div>

      <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ ...INLINE, maxWidth: 280 }}
          placeholder="New event name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          disabled={busy}
        />
        <input
          style={{ width: 80 }}
          type="number"
          placeholder="Order"
          value={newOrder}
          onChange={(e) => setNewOrder(e.target.value)}
          disabled={busy}
        />
        <button type="button" className="btn primary" disabled={busy || !newName.trim()} onClick={() => void addRow()}>
          Add event
        </button>
      </div>
    </div>
  )
}

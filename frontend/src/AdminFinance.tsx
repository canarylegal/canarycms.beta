import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { useDialogs } from './DialogProvider'
import type { ApiError } from './api'
import type { FinanceCategoryTemplateOut, FinanceItemTemplateOut, FinanceTemplateOut } from './types'

interface Props {
  token: string
  subTypeId: string
  subTypeName: string
}

const SMALL: React.CSSProperties = { padding: '3px 8px', fontSize: '0.82em' }
const INLINE: React.CSSProperties = { flex: 1, width: 'auto' }

export function AdminFinance({ token, subTypeId, subTypeName }: Props) {
  const { askConfirm } = useDialogs()
  const [template, setTemplate] = useState<FinanceTemplateOut | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Category form state
  const [newCatName, setNewCatName] = useState('')
  const [newCatOrder, setNewCatOrder] = useState('0')
  const [editCat, setEditCat] = useState<{ id: string; name: string; sort_order: string } | null>(null)

  // Item form state per category
  const [newItemName, setNewItemName] = useState<Record<string, string>>({})
  const [newItemDir, setNewItemDir] = useState<Record<string, 'debit' | 'credit'>>({})
  const [newItemOrder, setNewItemOrder] = useState<Record<string, string>>({})
  const [editItem, setEditItem] = useState<{
    id: string; name: string; direction: 'debit' | 'credit'; sort_order: string
  } | null>(null)

  async function loadTemplate() {
    setBusy(true); setErr(null)
    try {
      const data = await apiFetch<FinanceTemplateOut>(`/admin/finance/templates/${subTypeId}`, { token })
      setTemplate(data)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to load finance template')
    } finally { setBusy(false) }
  }

  useEffect(() => {
    setTemplate(null)
    setNewCatName('')
    setNewCatOrder('0')
    setEditCat(null)
    setNewItemName({})
    setNewItemDir({})
    setNewItemOrder({})
    setEditItem(null)
    void loadTemplate()
  }, [subTypeId])

  // ── Category CRUD ────────────────────────────────────────────────────────

  async function addCategory() {
    if (!newCatName.trim()) return
    setBusy(true); setErr(null)
    try {
      await apiFetch('/admin/finance/templates/categories', {
        token, method: 'POST',
        json: { matter_sub_type_id: subTypeId, name: newCatName.trim(), sort_order: parseInt(newCatOrder) || 0 },
      })
      setNewCatName(''); setNewCatOrder('0')
      await loadTemplate()
    } catch (e) { setErr((e as ApiError).message ?? 'Failed') } finally { setBusy(false) }
  }

  async function saveCategory() {
    if (!editCat) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/admin/finance/templates/categories/${editCat.id}`, {
        token, method: 'PATCH',
        json: { name: editCat.name.trim(), sort_order: parseInt(editCat.sort_order) || 0 },
      })
      setEditCat(null)
      await loadTemplate()
    } catch (e) { setErr((e as ApiError).message ?? 'Failed') } finally { setBusy(false) }
  }

  async function deleteCategory(id: string) {
    const ok = await askConfirm({
      title: 'Delete category',
      message: 'Delete this category and all its items?',
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/admin/finance/templates/categories/${id}`, { token, method: 'DELETE' })
      await loadTemplate()
    } catch (e) { setErr((e as ApiError).message ?? 'Failed') } finally { setBusy(false) }
  }

  // ── Item CRUD ────────────────────────────────────────────────────────────

  async function addItem(catId: string) {
    const name = (newItemName[catId] ?? '').trim()
    const dir = newItemDir[catId] ?? 'debit'
    if (!name) return
    setBusy(true); setErr(null)
    try {
      await apiFetch('/admin/finance/templates/items', {
        token, method: 'POST',
        json: { category_id: catId, name, direction: dir, sort_order: parseInt(newItemOrder[catId] ?? '0') || 0 },
      })
      setNewItemName((p) => ({ ...p, [catId]: '' }))
      setNewItemOrder((p) => ({ ...p, [catId]: '0' }))
      await loadTemplate()
    } catch (e) { setErr((e as ApiError).message ?? 'Failed') } finally { setBusy(false) }
  }

  async function saveItem() {
    if (!editItem) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/admin/finance/templates/items/${editItem.id}`, {
        token, method: 'PATCH',
        json: { name: editItem.name.trim(), direction: editItem.direction, sort_order: parseInt(editItem.sort_order) || 0 },
      })
      setEditItem(null)
      await loadTemplate()
    } catch (e) { setErr((e as ApiError).message ?? 'Failed') } finally { setBusy(false) }
  }

  async function deleteItem(id: string) {
    const ok = await askConfirm({
      title: 'Delete item',
      message: 'Delete this item?',
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    setBusy(true); setErr(null)
    try {
      await apiFetch(`/admin/finance/templates/items/${id}`, { token, method: 'DELETE' })
      await loadTemplate()
    } catch (e) { setErr((e as ApiError).message ?? 'Failed') } finally { setBusy(false) }
  }

  if (!template && busy) return <div className="muted" style={{ padding: '6px 0' }}>Loading finance template…</div>

  return (
    <div className="adminFinanceSection">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>Finance template — <span style={{ fontWeight: 400 }}>{subTypeName}</span></div>
        <button type="button" className="btn" style={SMALL} disabled={busy} onClick={() => void loadTemplate()}>Refresh</button>
      </div>
      <div className="muted" style={{ marginBottom: 10, fontSize: '0.85em' }}>
        Default categories and line items shown when a user opens Finance for a case of this sub-type.
        Users can override names and amounts per-case.
      </div>

      {err && <div className="error" style={{ marginBottom: 8 }}>{err}</div>}

      <div className="stack" style={{ gap: 10 }}>
        {template && template.categories.length === 0 && (
          <div className="muted" style={{ padding: '4px 0' }}>No categories yet.</div>
        )}

        {template && template.categories.map((cat: FinanceCategoryTemplateOut) => (
          <div key={cat.id} className="adminFinanceCat">
            {/* Category header */}
            <div className="adminFinanceCatHead">
              {editCat?.id === cat.id ? (
                <>
                  <input
                    className="input"
                    style={{ ...INLINE, maxWidth: 240 }}
                    value={editCat.name}
                    onChange={(e) => setEditCat({ ...editCat, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveCategory(); if (e.key === 'Escape') setEditCat(null) }}
                    autoFocus
                    disabled={busy}
                  />
                  <span className="muted" style={{ fontSize: '0.82em' }}>Order:</span>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    style={{ width: 58 }}
                    value={editCat.sort_order}
                    onChange={(e) => setEditCat({ ...editCat, sort_order: e.target.value })}
                    disabled={busy}
                  />
                  <button className="btn" style={SMALL} disabled={busy} onClick={() => void saveCategory()}>Save</button>
                  <button className="btn" style={SMALL} onClick={() => setEditCat(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span className="adminFinanceCatName">{cat.name}</span>
                  <span className="muted adminFinanceCatOrder">#{cat.sort_order}</span>
                  <button className="btn" style={SMALL} disabled={busy} onClick={() => setEditCat({ id: cat.id, name: cat.name, sort_order: String(cat.sort_order) })}>Edit</button>
                  <button className="btn danger" style={SMALL} disabled={busy} onClick={() => void deleteCategory(cat.id)}>Delete</button>
                </>
              )}
            </div>

            {/* Items */}
            <div className="adminFinanceItems">
              {cat.items.map((item: FinanceItemTemplateOut) => (
                <div key={item.id} className="adminFinanceItem">
                  {editItem?.id === item.id ? (
                    <>
                      <input
                        className="input"
                        style={{ ...INLINE, maxWidth: 200 }}
                        value={editItem.name}
                        onChange={(e) => setEditItem({ ...editItem, name: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') void saveItem(); if (e.key === 'Escape') setEditItem(null) }}
                        autoFocus
                        disabled={busy}
                      />
                      <select
                        className="select"
                        style={{ width: 90 }}
                        value={editItem.direction}
                        onChange={(e) => setEditItem({ ...editItem, direction: e.target.value as 'debit' | 'credit' })}
                        disabled={busy}
                      >
                        <option value="debit">Debit</option>
                        <option value="credit">Credit</option>
                      </select>
                      <span className="muted" style={{ fontSize: '0.82em' }}>Order:</span>
                      <input
                        className="input"
                        type="number"
                        min="0"
                        style={{ width: 55 }}
                        value={editItem.sort_order}
                        onChange={(e) => setEditItem({ ...editItem, sort_order: e.target.value })}
                        disabled={busy}
                      />
                      <button className="btn" style={SMALL} disabled={busy} onClick={() => void saveItem()}>Save</button>
                      <button className="btn" style={SMALL} onClick={() => setEditItem(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className={`finDirBadge finDirBadge--${item.direction}`}>{item.direction}</span>
                      <span className="adminFinanceItemName">{item.name}</span>
                      <span className="muted adminFinanceCatOrder">#{item.sort_order}</span>
                      <button className="btn" style={SMALL} disabled={busy} onClick={() => setEditItem({ id: item.id, name: item.name, direction: item.direction, sort_order: String(item.sort_order) })}>Edit</button>
                      <button className="btn danger" style={SMALL} disabled={busy} onClick={() => void deleteItem(item.id)}>Delete</button>
                    </>
                  )}
                </div>
              ))}

              {/* Add item row */}
              <div className="adminFinanceAddItem">
                <select
                  className="select"
                  style={{ width: 90 }}
                  value={newItemDir[cat.id] ?? 'debit'}
                  onChange={(e) => setNewItemDir((p) => ({ ...p, [cat.id]: e.target.value as 'debit' | 'credit' }))}
                  disabled={busy}
                >
                  <option value="debit">Debit</option>
                  <option value="credit">Credit</option>
                </select>
                <input
                  className="input"
                  style={INLINE}
                  placeholder="New item name…"
                  value={newItemName[cat.id] ?? ''}
                  onChange={(e) => setNewItemName((p) => ({ ...p, [cat.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addItem(cat.id) }}
                  disabled={busy}
                />
                <span className="muted" style={{ fontSize: '0.82em' }}>Order:</span>
                <input
                  className="input"
                  type="number"
                  min="0"
                  style={{ width: 55 }}
                  value={newItemOrder[cat.id] ?? '0'}
                  onChange={(e) => setNewItemOrder((p) => ({ ...p, [cat.id]: e.target.value }))}
                  disabled={busy}
                />
                <button
                  className="btn"
                  style={SMALL}
                  disabled={busy || !(newItemName[cat.id] ?? '').trim()}
                  onClick={() => void addItem(cat.id)}
                >
                  Add item
                </button>
              </div>
            </div>
          </div>
        ))}

        {/* Add category row */}
        <div className="adminFinanceAddCat">
          <strong style={{ fontSize: '0.85em' }}>New category:</strong>
          <input
            className="input"
            style={INLINE}
            placeholder="Category name…"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addCategory() }}
            disabled={busy}
          />
          <span className="muted" style={{ fontSize: '0.82em' }}>Order:</span>
          <input
            className="input"
            type="number"
            min="0"
            style={{ width: 58 }}
            value={newCatOrder}
            onChange={(e) => setNewCatOrder(e.target.value)}
            disabled={busy}
          />
          <button
            className="btn primary"
            disabled={busy || !newCatName.trim()}
            onClick={() => void addCategory()}
          >
            Add category
          </button>
        </div>
      </div>
    </div>
  )
}

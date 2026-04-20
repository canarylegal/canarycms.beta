import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from './api'
import { canaryDocumentTitle } from './tabTitle'
import type { ApiError } from './api'
import { useDialogs } from './DialogProvider'
import { SearchInput } from './SearchInput'
import type { CaseOut, FinanceCategoryOut, FinanceItemOut, FinanceOut } from './types'

interface Props {
  caseId: string
  token: string
  /** When provided (modal mode): renders Save and Close / Discard buttons in a header. */
  onClose?: () => void
}

type ItemDraft = { name: string; direction: 'debit' | 'credit'; amountStr: string }

function pence(p: number): string {
  return `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function totals(items: FinanceItemOut[], drafts: Record<string, ItemDraft>) {
  let dr = 0, cr = 0
  for (const it of items) {
    const d = drafts[it.id]
    const dir = d?.direction ?? it.direction
    const amt = d ? (d.amountStr.trim() ? Math.round(parseFloat(d.amountStr) * 100) : null) : it.amount_pence
    if (amt == null || isNaN(amt)) continue
    if (dir === 'debit') dr += amt
    else cr += amt
  }
  return { dr, cr }
}

export function FinancePage({ caseId, token, onClose }: Props) {
  const { askConfirm } = useDialogs()
  const [finance, setFinance] = useState<FinanceOut | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  const [financeSearch, setFinanceSearch] = useState('')

  // Add item form state per category
  const [addItemCatId, setAddItemCatId] = useState<string | null>(null)
  const [addItemName, setAddItemName] = useState('')
  const [addItemDir, setAddItemDir] = useState<'debit' | 'credit'>('debit')

  // Add category form
  const [addCatOpen, setAddCatOpen] = useState(false)
  const [addCatName, setAddCatName] = useState('')
  const addCatRef = useRef<HTMLInputElement>(null)

  function initDrafts(data: FinanceOut) {
    const d: Record<string, ItemDraft> = {}
    for (const cat of data.categories) {
      for (const item of cat.items) {
        d[item.id] = {
          name: item.name,
          direction: item.direction,
          amountStr: item.amount_pence != null ? (item.amount_pence / 100).toFixed(2) : '',
        }
      }
    }
    setDrafts(d)
  }

  async function load() {
    setBusy(true); setError(null)
    try {
      const data = await apiFetch<FinanceOut>(`/cases/${caseId}/finance`, { token })
      setFinance(data)
      initDrafts(data)
    } catch (e) {
      setError((e as ApiError).message ?? 'Failed to load finance')
    } finally { setBusy(false) }
  }

  useEffect(() => { void load() }, [caseId])

  useEffect(() => {
    if (addCatOpen) setTimeout(() => addCatRef.current?.focus(), 50)
  }, [addCatOpen])

  // ── Draft helpers ─────────────────────────────────────────────────────────

  function setDraft(itemId: string, patch: Partial<ItemDraft>) {
    setDrafts((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...patch } }))
  }

  // ── Save all ──────────────────────────────────────────────────────────────

  async function saveAll() {
    if (!finance) { onClose?.(); return }
    setBusy(true); setError(null)
    try {
      for (const cat of finance.categories) {
        for (const item of cat.items) {
          const d = drafts[item.id]
          if (!d) continue
          const amtPence = d.amountStr.trim() ? Math.round(parseFloat(d.amountStr) * 100) : null
          const nameChanged = d.name !== item.name
          const dirChanged = d.direction !== item.direction
          const amtChanged = amtPence !== item.amount_pence
          if (nameChanged || dirChanged || amtChanged) {
            await apiFetch(`/cases/${caseId}/finance/items/${item.id}`, {
              token, method: 'PATCH',
              json: { name: d.name || item.name, direction: d.direction, amount_pence: amtPence },
            })
          }
        }
      }
      onClose?.()
    } catch (e) {
      setError((e as ApiError).message ?? 'Failed to save')
      setBusy(false)
    }
  }

  function discardChanges() {
    if (finance) initDrafts(finance)
    onClose?.()
  }

  async function generateCompletionStatement() {
    if (!finance) return
    setGenBusy(true); setError(null)
    try {
      // Save any pending drafts first
      for (const cat of finance.categories) {
        for (const item of cat.items) {
          const d = drafts[item.id]
          if (!d) continue
          const amtPence = d.amountStr.trim() ? Math.round(parseFloat(d.amountStr) * 100) : null
          const nameChanged = d.name !== item.name
          const dirChanged = d.direction !== item.direction
          const amtChanged = amtPence !== item.amount_pence
          if (nameChanged || dirChanged || amtChanged) {
            await apiFetch(`/cases/${caseId}/finance/items/${item.id}`, {
              token, method: 'PATCH',
              json: { name: d.name || item.name, direction: d.direction, amount_pence: amtPence },
            })
          }
        }
      }
      // Generate the document
      const res = await apiFetch<{ id: string }>(`/cases/${caseId}/finance/completion-statement`, {
        token, method: 'POST',
      })
      window.open(`/editor/${caseId}/${res.id}`, '_blank')
    } catch (e: any) {
      setError(e?.message ?? 'Failed to generate completion statement')
    } finally {
      setGenBusy(false)
    }
  }

  // ── Structural mutations (immediate) ─────────────────────────────────────

  async function deleteItem(itemId: string) {
    const ok = await askConfirm({
      title: 'Remove item',
      message: 'Remove this item?',
      danger: true,
      confirmLabel: 'Remove',
    })
    if (!ok) return
    setBusy(true)
    try {
      await apiFetch(`/cases/${caseId}/finance/items/${itemId}`, { token, method: 'DELETE' })
      await load()
    } catch (e) { setError((e as ApiError).message ?? 'Failed') } finally { setBusy(false) }
  }

  async function addItem(catId: string) {
    if (!addItemName.trim()) return
    setBusy(true)
    try {
      const order = finance?.categories.find((c) => c.id === catId)?.items.length ?? 0
      await apiFetch(`/cases/${caseId}/finance/items`, {
        token, method: 'POST',
        json: { category_id: catId, name: addItemName.trim(), direction: addItemDir, sort_order: order },
      })
      setAddItemCatId(null); setAddItemName(''); setAddItemDir('debit')
      await load()
    } catch (e) { setError((e as ApiError).message ?? 'Failed') } finally { setBusy(false) }
  }

  async function addCategory() {
    if (!addCatName.trim()) return
    setBusy(true)
    try {
      const order = finance?.categories.length ?? 0
      await apiFetch(`/cases/${caseId}/finance/categories`, {
        token, method: 'POST',
        json: { name: addCatName.trim(), sort_order: order },
      })
      setAddCatOpen(false); setAddCatName('')
      await load()
    } catch (e) { setError((e as ApiError).message ?? 'Failed') } finally { setBusy(false) }
  }

  async function deleteCategory(catId: string) {
    const ok = await askConfirm({
      title: 'Delete category',
      message: 'Delete this category and all its items?',
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    setBusy(true)
    try {
      await apiFetch(`/cases/${caseId}/finance/categories/${catId}`, { token, method: 'DELETE' })
      await load()
    } catch (e) { setError((e as ApiError).message ?? 'Failed') } finally { setBusy(false) }
  }

  // ── Derived totals ────────────────────────────────────────────────────────

  const allItems = finance?.categories.flatMap((c) => c.items) ?? []
  const grandDr = allItems.reduce((s, i) => {
    const d = drafts[i.id]; const dir = d?.direction ?? i.direction
    const amt = d ? (d.amountStr.trim() ? Math.round(parseFloat(d.amountStr) * 100) : null) : i.amount_pence
    return dir === 'debit' && amt != null && !isNaN(amt) ? s + amt : s
  }, 0)
  const grandCr = allItems.reduce((s, i) => {
    const d = drafts[i.id]; const dir = d?.direction ?? i.direction
    const amt = d ? (d.amountStr.trim() ? Math.round(parseFloat(d.amountStr) * 100) : null) : i.amount_pence
    return dir === 'credit' && amt != null && !isNaN(amt) ? s + amt : s
  }, 0)
  const balance = grandCr - grandDr

  const filteredCategories = useMemo(() => {
    if (!finance) return []
    const q = financeSearch.trim().toLowerCase()
    if (!q) return finance.categories
    return finance.categories.filter((cat) => {
      if (cat.name.toLowerCase().includes(q)) return true
      return cat.items.some((it) => {
        const d = drafts[it.id]
        const name = (d?.name ?? it.name).toLowerCase()
        return name.includes(q)
      })
    })
  }, [finance, financeSearch, drafts])

  return (
    <div className="finShell">
      {/* Modal title bar — only shown when used as a pop-out */}
      {onClose && (
        <div className="paneHead" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Finance</h2>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" disabled={busy} onClick={discardChanges}>
              Discard changes
            </button>
            <button
              type="button"
              className="btn"
              style={{ background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' }}
              disabled={busy}
              onClick={() => void saveAll()}
            >
              Save and close
            </button>
          </div>
        </div>
      )}

      {/* Totals + utility buttons (totals hidden in modal — summary is on the case sidebar) */}
      <div className="finHeader">
        {!onClose ? (
          <div className="finTotals">
            <div className="finTotalCard">
              <span className="finTotalLabel">Total debits</span>
              <span className="finTotalValue finTotalDr">{pence(grandDr)}</span>
            </div>
            <div className="finTotalCard">
              <span className="finTotalLabel">Total credits</span>
              <span className="finTotalValue finTotalCr">{pence(grandCr)}</span>
            </div>
            <div className="finTotalCard">
              <span className="finTotalLabel">Balance</span>
              <span className={`finTotalValue${balance < 0 ? ' finTotalDr' : ' finTotalCr'}`}>
                {balance === 0 ? '£0.00' : `${pence(Math.abs(balance))}${balance > 0 ? ' CR' : ''}`}
              </span>
            </div>
          </div>
        ) : null}
        <div className={`finActions${onClose ? ' finActions--modalToolbar' : ''}`} style={{ flexWrap: 'wrap', gap: 8 }}>
          <div style={{ flex: '1 1 220px', minWidth: 200, maxWidth: 360 }}>
            <SearchInput
              placeholder="Search categories and line items…"
              value={financeSearch}
              onChange={(e) => setFinanceSearch(e.target.value)}
              onClear={() => setFinanceSearch('')}
              className="mainMenuSearchInput"
              aria-label="Search finance"
            />
          </div>
          <button type="button" className="btn" disabled={busy || genBusy} onClick={() => void load()}>Refresh</button>
          <button type="button" className="btn finAddCatBtn" disabled={busy || genBusy} onClick={() => setAddCatOpen(true)}>
            + Category
          </button>
          <button
            type="button"
            className="btn"
            style={{ background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' }}
            disabled={busy || genBusy || !finance}
            onClick={() => void generateCompletionStatement()}
            title="Save current values and generate a completion statement in Word format"
          >
            {genBusy ? 'Generating…' : 'Generate completion statement'}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {!finance && busy && <div className="empty">Loading…</div>}

      {finance && finance.categories.length === 0 && (
        <div className="empty">No finance items yet. Add a category to get started.</div>
      )}

      {finance && filteredCategories.length === 0 && finance.categories.length > 0 && financeSearch.trim() ? (
        <div className="muted" style={{ padding: 12 }}>
          No categories or items match your search.
        </div>
      ) : null}

      {finance && filteredCategories.map((cat: FinanceCategoryOut) => {
        const { dr, cr } = totals(cat.items, drafts)
        return (
          <div key={cat.id} className="finCategoryBlock">
            <div className="finCategoryHead">
              <span className="finCategoryName">{cat.name}</span>
              <span className="finCategoryTotals muted">
                {dr > 0 && <span className="finTotalDr">DR {pence(dr)}</span>}
                {cr > 0 && <span className="finTotalCr">CR {pence(cr)}</span>}
              </span>
              <button
                type="button"
                className="btn finCatDeleteBtn"
                disabled={busy}
                onClick={() => void deleteCategory(cat.id)}
                title="Delete category"
              >
                ✕
              </button>
            </div>

            <table className="finTable">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>Type</th>
                  <th>Description</th>
                  <th className="finAmtCell">Amount</th>
                  <th className="finActCell" />
                </tr>
              </thead>
              <tbody>
                {cat.items.map((item: FinanceItemOut) => {
                  const d = drafts[item.id] ?? { name: item.name, direction: item.direction, amountStr: '' }
                  return (
                    <tr key={item.id} className="finRow">
                      <td>
                        <select
                          className="select"
                          style={{ width: 92 }}
                          value={d.direction}
                          onChange={(e) => setDraft(item.id, { direction: e.target.value as 'debit' | 'credit' })}
                          disabled={busy}
                        >
                          <option value="debit">Debit</option>
                          <option value="credit">Credit</option>
                        </select>
                      </td>
                      <td>
                        <input
                          className="input"
                          style={{ width: '100%' }}
                          value={d.name}
                          onChange={(e) => setDraft(item.id, { name: e.target.value })}
                          disabled={busy}
                        />
                      </td>
                      <td className="finAmtCell">
                        <input
                          className="input"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          style={{ width: 110, textAlign: 'right' }}
                          value={d.amountStr}
                          onChange={(e) => setDraft(item.id, { amountStr: e.target.value })}
                          disabled={busy}
                        />
                      </td>
                      <td className="finActCell">
                        <button
                          type="button"
                          className="btn danger finRowBtn"
                          onClick={() => void deleteItem(item.id)}
                          disabled={busy}
                          title="Remove item"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
                {cat.items.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ padding: '8px 10px', fontStyle: 'italic' }}>No items.</td></tr>
                )}
              </tbody>
            </table>

            {/* Add item row */}
            {addItemCatId === cat.id ? (
              <div className="finAddItemRow">
                <select
                  className="select"
                  style={{ width: 92 }}
                  value={addItemDir}
                  onChange={(e) => setAddItemDir(e.target.value as 'debit' | 'credit')}
                  disabled={busy}
                >
                  <option value="debit">Debit</option>
                  <option value="credit">Credit</option>
                </select>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  placeholder="Item description…"
                  value={addItemName}
                  autoFocus
                  onChange={(e) => setAddItemName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addItem(cat.id)
                    if (e.key === 'Escape') { setAddItemCatId(null); setAddItemName('') }
                  }}
                  disabled={busy}
                />
                <button
                  className="btn"
                  style={{ background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' }}
                  disabled={busy || !addItemName.trim()}
                  onClick={() => void addItem(cat.id)}
                >
                  Add
                </button>
                <button className="btn" disabled={busy} onClick={() => { setAddItemCatId(null); setAddItemName('') }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn finAddItemBtn"
                disabled={busy}
                onClick={() => { setAddItemCatId(cat.id); setAddItemName(''); setAddItemDir('debit') }}
              >
                + Add item
              </button>
            )}
          </div>
        )
      })}

      {/* Add category form */}
      {addCatOpen && (
        <div className="finAddCatRow">
          <input
            ref={addCatRef}
            className="input"
            style={{ flex: 1, maxWidth: 320 }}
            placeholder="New category name…"
            value={addCatName}
            onChange={(e) => setAddCatName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addCategory()
              if (e.key === 'Escape') { setAddCatOpen(false); setAddCatName('') }
            }}
            disabled={busy}
          />
          <button
            className="btn"
            style={{ background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' }}
            disabled={busy || !addCatName.trim()}
            onClick={() => void addCategory()}
          >
            Add category
          </button>
          <button className="btn" disabled={busy} onClick={() => { setAddCatOpen(false); setAddCatName('') }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Standalone wrapper rendered when the app opens with ?finance=<caseId>.
 */
export function FinanceStandalone({ caseId, token }: { caseId: string; token: string }) {
  const [caseRef, setCaseRef] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<CaseOut>(`/cases/${caseId}`, { token })
      .then((c) => {
        const label = [c.case_number, c.client_name].filter(Boolean).join(' — ')
        setCaseRef(label || caseId)
        document.title = canaryDocumentTitle(`Finance — ${label || caseId}`)
      })
      .catch(() => {
        document.title = canaryDocumentTitle('Finance')
      })
  }, [caseId, token])

  return (
    <div className="ledgerStandaloneShell">
      <div className="ledgerStandaloneBar">
        <span className="ledgerStandaloneLogo">Canary</span>
        {caseRef && <span className="ledgerStandaloneCase">{caseRef}</span>}
        <span className="ledgerStandaloneTitle">Finance</span>
      </div>
      <div className="ledgerStandaloneBody">
        <FinancePage caseId={caseId} token={token} />
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from './api'
import type { ApiError } from './api'
import type { BillingLineTemplateOut, MatterHeadTypeOut } from './types'

interface Props {
  token: string
}

const SMALL: React.CSSProperties = { padding: '3px 8px', fontSize: '0.82em' }
const INLINE: React.CSSProperties = { flex: 1, width: 'auto' }

export function AdminBilling({ token }: Props) {
  const [heads, setHeads] = useState<MatterHeadTypeOut[]>([])
  const [selectedHeadId, setSelectedHeadId] = useState<string | null>(null)
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [vatStr, setVatStr] = useState('20')
  const [templates, setTemplates] = useState<BillingLineTemplateOut[]>([])

  const [newFeeLabel, setNewFeeLabel] = useState('')
  const [newFeeAmt, setNewFeeAmt] = useState('0')
  const [newDisLabel, setNewDisLabel] = useState('')
  const [newDisAmt, setNewDisAmt] = useState('0')

  const [editT, setEditT] = useState<{
    id: string
    label: string
    default_amount_pence: string
    sort_order: string
  } | null>(null)

  async function loadHeads() {
    setErr(null)
    try {
      const data = await apiFetch<MatterHeadTypeOut[]>('/matter-types', { token })
      setHeads(data)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to load matter types')
    }
  }

  async function loadVat() {
    try {
      const s = await apiFetch<{ default_vat_percent: number }>('/admin/billing/settings', { token })
      setVatStr(String(s.default_vat_percent))
    } catch {
      setVatStr('20')
    }
  }

  async function loadTemplates(subId: string) {
    setBusy(true)
    setErr(null)
    try {
      const list = await apiFetch<BillingLineTemplateOut[]>(`/admin/billing/templates/${subId}`, { token })
      setTemplates(list)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to load templates')
      setTemplates([])
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void loadHeads()
    void loadVat()
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

  const feeList = useMemo(() => templates.filter((t) => t.line_kind === 'fee'), [templates])
  const disList = useMemo(() => templates.filter((t) => t.line_kind === 'disbursement'), [templates])

  async function saveVat() {
    const v = parseFloat(vatStr)
    if (Number.isNaN(v) || v < 0 || v > 100) {
      setErr('VAT must be between 0 and 100.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await apiFetch('/admin/billing/settings', {
        token,
        method: 'PATCH',
        json: { default_vat_percent: v },
      })
      await loadVat()
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to save VAT')
    } finally {
      setBusy(false)
    }
  }

  async function addFee() {
    if (!selectedSubId || !newFeeLabel.trim()) return
    const pence = Math.round(parseFloat(newFeeAmt || '0') * 100)
    if (Number.isNaN(pence) || pence < 0) {
      setErr('Enter a valid default amount.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await apiFetch('/admin/billing/templates', {
        token,
        method: 'POST',
        json: {
          matter_sub_type_id: selectedSubId,
          line_kind: 'fee',
          label: newFeeLabel.trim(),
          default_amount_pence: pence,
          sort_order: feeList.length,
        },
      })
      setNewFeeLabel('')
      setNewFeeAmt('0')
      await loadTemplates(selectedSubId)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to add')
    } finally {
      setBusy(false)
    }
  }

  async function addDis() {
    if (!selectedSubId || !newDisLabel.trim()) return
    const pence = Math.round(parseFloat(newDisAmt || '0') * 100)
    if (Number.isNaN(pence) || pence < 0) {
      setErr('Enter a valid default amount.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await apiFetch('/admin/billing/templates', {
        token,
        method: 'POST',
        json: {
          matter_sub_type_id: selectedSubId,
          line_kind: 'disbursement',
          label: newDisLabel.trim(),
          default_amount_pence: pence,
          sort_order: disList.length,
        },
      })
      setNewDisLabel('')
      setNewDisAmt('0')
      await loadTemplates(selectedSubId)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to add')
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit() {
    if (!editT) return
    const pence = Math.round(parseFloat(editT.default_amount_pence || '0') * 100)
    if (Number.isNaN(pence) || pence < 0) {
      setErr('Invalid amount.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/admin/billing/templates/${editT.id}`, {
        token,
        method: 'PATCH',
        json: {
          label: editT.label.trim(),
          default_amount_pence: pence,
          sort_order: parseInt(editT.sort_order, 10) || 0,
        },
      })
      setEditT(null)
      if (selectedSubId) await loadTemplates(selectedSubId)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    setErr(null)
    try {
      await apiFetch(`/admin/billing/templates/${id}`, { token, method: 'DELETE' })
      if (selectedSubId) await loadTemplates(selectedSubId)
    } catch (e) {
      setErr((e as ApiError).message ?? 'Failed to delete')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="muted" style={{ fontSize: '0.95em', marginBottom: 8 }}>
        Set the default VAT rate and per–matter-sub-type invoice line presets (fees and disbursements). These appear when
        users create invoices on the ledger.
      </div>
      {err ? <div className="error">{err}</div> : null}

      <div className="card" style={{ padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Default VAT rate</h3>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Current rate of VAT (%)</span>
            <input
              className="input inputNoSpinner"
              inputMode="decimal"
              value={vatStr}
              disabled={busy}
              onChange={(e) => setVatStr(e.target.value.replace(/[^\d.]/g, ''))}
            />
          </label>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void saveVat()}>
            Save VAT
          </button>
        </div>
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
              {selectedHead!.sub_types.length === 0 ? <div className="muted">No sub types.</div> : null}
            </div>
          )}
        </div>
      </div>

      {selectedSub ? (
        <div className="stack" style={{ gap: 16 }}>
          <h3 style={{ margin: 0 }}>
            Billing presets — <span style={{ fontWeight: 400 }}>{selectedSub.name}</span>
          </h3>

          <div className="card" style={{ padding: 12 }}>
            <h4 style={{ marginTop: 0 }}>Default fees</h4>
            <div className="stack" style={{ gap: 8 }}>
              {feeList.map((t) => (
                <div key={t.id} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {editT?.id === t.id ? (
                    <>
                      <input
                        style={INLINE}
                        value={editT.label}
                        onChange={(e) => setEditT({ ...editT, label: e.target.value })}
                        disabled={busy}
                      />
                      <input
                        style={{ width: 100 }}
                        className="input inputNoSpinner"
                        value={editT.default_amount_pence}
                        onChange={(e) => setEditT({ ...editT, default_amount_pence: e.target.value })}
                        disabled={busy}
                      />
                      <span className="muted">£</span>
                      <input
                        style={{ width: 56 }}
                        value={editT.sort_order}
                        onChange={(e) => setEditT({ ...editT, sort_order: e.target.value })}
                        disabled={busy}
                      />
                      <button type="button" className="btn" style={SMALL} disabled={busy} onClick={() => void saveEdit()}>
                        Save
                      </button>
                      <button type="button" className="btn" style={SMALL} disabled={busy} onClick={() => setEditT(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={{ flex: 1 }}>{t.label}</span>
                      <span className="muted">£{(t.default_amount_pence / 100).toFixed(2)}</span>
                      <button
                        type="button"
                        className="btn"
                        style={SMALL}
                        disabled={busy}
                        onClick={() =>
                          setEditT({
                            id: t.id,
                            label: t.label,
                            default_amount_pence: (t.default_amount_pence / 100).toFixed(2),
                            sort_order: String(t.sort_order),
                          })
                        }
                      >
                        Edit
                      </button>
                      <button type="button" className="btn danger" style={SMALL} disabled={busy} onClick={() => void remove(t.id)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              ))}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input style={INLINE} placeholder="Label" value={newFeeLabel} onChange={(e) => setNewFeeLabel(e.target.value)} disabled={busy} />
                <input
                  style={{ width: 100 }}
                  className="input inputNoSpinner"
                  placeholder="£"
                  value={newFeeAmt}
                  onChange={(e) => setNewFeeAmt(e.target.value)}
                  disabled={busy}
                />
                <button type="button" className="btn primary" style={SMALL} disabled={busy || !newFeeLabel.trim()} onClick={() => void addFee()}>
                  Add fee
                </button>
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 12 }}>
            <h4 style={{ marginTop: 0 }}>Default disbursements</h4>
            <div className="stack" style={{ gap: 8 }}>
              {disList.map((t) => (
                <div key={t.id} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {editT?.id === t.id ? (
                    <>
                      <input
                        style={INLINE}
                        value={editT.label}
                        onChange={(e) => setEditT({ ...editT, label: e.target.value })}
                        disabled={busy}
                      />
                      <input
                        style={{ width: 100 }}
                        className="input inputNoSpinner"
                        value={editT.default_amount_pence}
                        onChange={(e) => setEditT({ ...editT, default_amount_pence: e.target.value })}
                        disabled={busy}
                      />
                      <span className="muted">£</span>
                      <input
                        style={{ width: 56 }}
                        value={editT.sort_order}
                        onChange={(e) => setEditT({ ...editT, sort_order: e.target.value })}
                        disabled={busy}
                      />
                      <button type="button" className="btn" style={SMALL} disabled={busy} onClick={() => void saveEdit()}>
                        Save
                      </button>
                      <button type="button" className="btn" style={SMALL} disabled={busy} onClick={() => setEditT(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={{ flex: 1 }}>{t.label}</span>
                      <span className="muted">£{(t.default_amount_pence / 100).toFixed(2)}</span>
                      <button
                        type="button"
                        className="btn"
                        style={SMALL}
                        disabled={busy}
                        onClick={() =>
                          setEditT({
                            id: t.id,
                            label: t.label,
                            default_amount_pence: (t.default_amount_pence / 100).toFixed(2),
                            sort_order: String(t.sort_order),
                          })
                        }
                      >
                        Edit
                      </button>
                      <button type="button" className="btn danger" style={SMALL} disabled={busy} onClick={() => void remove(t.id)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              ))}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input style={INLINE} placeholder="Label" value={newDisLabel} onChange={(e) => setNewDisLabel(e.target.value)} disabled={busy} />
                <input
                  style={{ width: 100 }}
                  className="input inputNoSpinner"
                  placeholder="£"
                  value={newDisAmt}
                  onChange={(e) => setNewDisAmt(e.target.value)}
                  disabled={busy}
                />
                <button type="button" className="btn primary" style={SMALL} disabled={busy || !newDisLabel.trim()} onClick={() => void addDis()}>
                  Add disbursement
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : selectedHeadId ? (
        <div className="muted">Select a sub type to edit billing presets.</div>
      ) : null}
    </div>
  )
}

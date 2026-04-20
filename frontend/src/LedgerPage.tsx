import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from './api'
import { canaryDocumentTitle } from './tabTitle'
import type { ApiError } from './api'
import { ConfirmModal } from './ConfirmModal'
import { useModalDrag } from './useModalDrag'
import type {
  CaseContactOut,
  CaseInvoiceCreate,
  CaseInvoicesOut,
  CaseOut,
  ContactOut,
  InvoiceBillingDefaultsOut,
  LedgerEntryOut,
  LedgerPermissionsOut,
  LedgerOut,
  LedgerPostCreate,
} from './types'

interface Props {
  caseId: string
  token: string
}

function pence(p: number): string {
  const abs = Math.abs(p)
  return `£${(abs / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function balanceLabel(p: number): string {
  if (p === 0) return '£0.00'
  return pence(p)
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

type AccountFilter = 'all' | 'client' | 'office'

// Contact picker mode
type ContactMode = '' | 'na' | 'matter' | 'global' | 'other'

type InvLineDraft = {
  id: string
  line_type: 'fee' | 'disbursement' | 'vat'
  /** Selected admin preset id, or '' for custom */
  presetId: string
  description: string
  amountStr: string
  /** VAT percentage (fee / disbursement only) */
  vatPctStr: string
}

function newInvLineId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function defaultInvLines(vatPct: string): InvLineDraft[] {
  return [
    {
      id: newInvLineId(),
      line_type: 'fee',
      presetId: '',
      description: '',
      amountStr: '',
      vatPctStr: vatPct,
    },
  ]
}

const EMPTY_POST: LedgerPostCreate = {
  description: '',
  reference: '',
  contact_label: null,
  amount_pence: 0,
  client_direction: null,
  office_direction: null,
}

export function LedgerPage({ caseId, token }: Props) {
  const [ledger, setLedger] = useState<LedgerOut | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<AccountFilter>('all')
  const [postOpen, setPostOpen] = useState(false)
  const [form, setForm] = useState<LedgerPostCreate>(EMPTY_POST)
  const [amountStr, setAmountStr] = useState('')
  const [postError, setPostError] = useState<string | null>(null)
  const [postBusy, setPostBusy] = useState(false)
  const [ledgerPerm, setLedgerPerm] = useState<LedgerPermissionsOut | null>(null)
  const [invoicesData, setInvoicesData] = useState<CaseInvoicesOut | null>(null)
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false)
  const [invCreditUserId, setInvCreditUserId] = useState('')
  const [invBillingDefaults, setInvBillingDefaults] = useState<InvoiceBillingDefaultsOut | null>(null)
  const [invLines, setInvLines] = useState<InvLineDraft[]>(() => defaultInvLines('20'))
  const [invErr, setInvErr] = useState<string | null>(null)
  const [invBusy, setInvBusy] = useState(false)
  const [voidInvoiceId, setVoidInvoiceId] = useState<string | null>(null)
  const postModalDrag = useModalDrag(postOpen)
  const invoiceModalDrag = useModalDrag(invoiceModalOpen)

  // Contact picker state
  const [caseContacts, setCaseContacts] = useState<CaseContactOut[]>([])
  const [globalContacts, setGlobalContacts] = useState<ContactOut[]>([])
  const [contactMode, setContactMode] = useState<ContactMode>('')
  const [contactPickId, setContactPickId] = useState<string>('') // id within chosen group
  const [contactOther, setContactOther] = useState('')

  const descRef = useRef<HTMLInputElement>(null)

  async function load() {
    setBusy(true)
    setError(null)
    try {
      const data = await apiFetch<LedgerOut>(`/cases/${caseId}/ledger`, { token })
      setLedger(data)
    } catch (e) {
      setError((e as ApiError).message ?? 'Failed to load ledger')
    } finally {
      setBusy(false)
    }
  }

  async function loadInvoices() {
    try {
      const d = await apiFetch<CaseInvoicesOut>(`/cases/${caseId}/invoices`, { token })
      setInvoicesData(d)
    } catch {
      setInvoicesData({ case_id: caseId, invoices: [] })
    }
  }

  async function refreshAll() {
    await load()
    await loadInvoices()
  }

  useEffect(() => {
    void load()
    void loadInvoices()
    apiFetch<LedgerPermissionsOut>('/users/me/ledger-permissions', { token })
      .then(setLedgerPerm)
      .catch(() => setLedgerPerm(null))
    // Fetch contacts for the posting modal
    apiFetch<CaseContactOut[]>(`/cases/${caseId}/contacts`, { token })
      .then(setCaseContacts)
      .catch(() => {})
    apiFetch<ContactOut[]>('/contacts', { token })
      .then(setGlobalContacts)
      .catch(() => {})
  }, [caseId, token])

  useEffect(() => {
    if (postOpen) setTimeout(() => descRef.current?.focus(), 50)
  }, [postOpen])

  useEffect(() => {
    if (!invoiceModalOpen) return
    let cancelled = false
    apiFetch<InvoiceBillingDefaultsOut>(`/cases/${caseId}/invoice-billing-defaults`, { token })
      .then((d) => {
        if (cancelled) return
        setInvBillingDefaults(d)
        const pick =
          d.fee_earner_user_id && d.users.some((u) => u.id === d.fee_earner_user_id)
            ? d.fee_earner_user_id
            : d.users[0]?.id ?? ''
        setInvCreditUserId(pick)
        setInvLines((prev) =>
          prev.map((ln) => ({ ...ln, vatPctStr: String(d.default_vat_percent) })),
        )
      })
      .catch(() => {
        if (!cancelled) setInvBillingDefaults(null)
      })
    return () => {
      cancelled = true
    }
  }, [invoiceModalOpen, caseId, token])

  function openPost() {
    setForm(EMPTY_POST)
    setAmountStr('')
    setPostError(null)
    setContactMode('')
    setContactPickId('')
    setContactOther('')
    setPostOpen(true)
  }

  function resolveContactLabel(): string | null {
    if (contactMode === 'na') return null
    if (contactMode === 'matter') {
      const c = caseContacts.find((x) => x.id === contactPickId)
      return c?.name ?? null
    }
    if (contactMode === 'global') {
      const c = globalContacts.find((x) => x.id === contactPickId)
      return c?.name ?? null
    }
    if (contactMode === 'other') return contactOther.trim() || null
    return undefined as never
  }

  async function submitPost() {
    setPostError(null)

    // Validate contact field
    if (!contactMode) {
      setPostError('Party is required — select a contact, "Other", or "N/A".')
      return
    }
    if (contactMode === 'matter' && !contactPickId) {
      setPostError('Select a matter contact or choose a different option.')
      return
    }
    if (contactMode === 'global' && !contactPickId) {
      setPostError('Select a global contact or choose a different option.')
      return
    }
    if (contactMode === 'other' && !contactOther.trim()) {
      setPostError('Enter the party name.')
      return
    }

    const penceVal = Math.round(parseFloat(amountStr) * 100)
    if (!amountStr || isNaN(penceVal) || penceVal <= 0) {
      setPostError('Enter a valid amount greater than zero.')
      return
    }
    if (!form.client_direction && !form.office_direction) {
      setPostError('Select at least one account and direction.')
      return
    }
    if (!form.description.trim()) {
      setPostError('Description is required.')
      return
    }

    const payload: LedgerPostCreate = {
      ...form,
      amount_pence: penceVal,
      reference: form.reference?.trim() || null,
      description: form.description.trim(),
      contact_label: resolveContactLabel(),
    }
    setPostBusy(true)
    try {
      await apiFetch(`/cases/${caseId}/ledger/post`, {
        method: 'POST',
        token,
        json: payload,
      })
      setPostOpen(false)
      await load()
    } catch (e) {
      setPostError((e as ApiError).message ?? 'Failed to post transaction')
    } finally {
      setPostBusy(false)
    }
  }

  const entries: LedgerEntryOut[] = ledger?.entries ?? []

  const runningById = useMemo(() => {
    const sorted = [...entries].sort(
      (a, b) => new Date(a.posted_at).getTime() - new Date(b.posted_at).getTime(),
    )
    let o = 0
    let c = 0
    const m = new Map<string, { o: number; c: number }>()
    for (const e of sorted) {
      if (e.is_approved === false) {
        m.set(e.id, { o, c })
        continue
      }
      // Match backend _balance: net = sum(credits) - sum(debits)
      const delta = e.direction === 'credit' ? e.amount_pence : -e.amount_pence
      if (e.account_type === 'office') o += delta
      else c += delta
      m.set(e.id, { o, c })
    }
    return m
  }, [entries])

  const visible = filter === 'all' ? entries : entries.filter((e) => e.account_type === filter)

  const approveRep = new Map<string, string>()
  for (const e of visible) {
    if (e.is_approved === false && !approveRep.has(e.pair_id)) {
      approveRep.set(e.pair_id, e.id)
    }
  }

  const canApprove = ledgerPerm?.can_approve_ledger ?? false
  const canApproveInvoices = ledgerPerm?.can_approve_invoices ?? false

  async function approvePair(pairId: string) {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/cases/${caseId}/ledger/approve/${pairId}`, { method: 'POST', token })
      await load()
    } catch (e) {
      setError((e as ApiError).message ?? 'Could not approve')
    } finally {
      setBusy(false)
    }
  }

  const invoicePreviewTotals = useMemo(() => {
    let fees = 0
    let disb = 0
    let tax = 0
    let vatOnly = 0
    for (const ln of invLines) {
      const amt = Math.round(parseFloat(ln.amountStr) * 100)
      if (!ln.amountStr.trim() || Number.isNaN(amt) || amt <= 0) continue
      if (ln.line_type === 'vat') {
        vatOnly += amt
        tax += amt
        continue
      }
      const pct = parseFloat(ln.vatPctStr) || 0
      const tp = Math.round((amt * pct) / 100)
      tax += tp
      const gross = amt + tp
      if (ln.line_type === 'fee') fees += gross
      else disb += gross
    }
    return { fees, disb, tax, total: fees + disb + vatOnly }
  }, [invLines])

  async function submitInvoice() {
    setInvErr(null)
    if (!invCreditUserId) {
      setInvErr('Select credit (user).')
      return
    }
    const outLines: CaseInvoiceCreate['lines'] = []
    for (const ln of invLines) {
      const amt = Math.round(parseFloat(ln.amountStr) * 100)
      if (!ln.description.trim()) {
        setInvErr('Each line needs a description.')
        return
      }
      if (!ln.amountStr.trim() || Number.isNaN(amt) || amt <= 0) {
        setInvErr('Each line needs a valid amount greater than zero.')
        return
      }
      let tax = 0
      if (ln.line_type === 'fee' || ln.line_type === 'disbursement') {
        const pct = parseFloat(ln.vatPctStr) || 0
        if (Number.isNaN(pct) || pct < 0 || pct > 100) {
          setInvErr('VAT % must be between 0 and 100.')
          return
        }
        tax = Math.round((amt * pct) / 100)
      }
      outLines.push({
        line_type: ln.line_type,
        description: ln.description.trim(),
        amount_pence: amt,
        tax_pence: tax,
      })
    }
    if (outLines.length === 0) {
      setInvErr('Add at least one invoice line.')
      return
    }
    const payload: CaseInvoiceCreate = {
      credit_user_id: invCreditUserId,
      lines: outLines,
    }
    setInvBusy(true)
    try {
      await apiFetch(`/cases/${caseId}/invoices`, { method: 'POST', token, json: payload })
      setInvoiceModalOpen(false)
      setInvCreditUserId('')
      setInvBillingDefaults(null)
      setInvLines(defaultInvLines('20'))
      await load()
      await loadInvoices()
    } catch (e) {
      setInvErr((e as ApiError).message ?? 'Could not create invoice')
    } finally {
      setInvBusy(false)
    }
  }

  async function approveInvoice(id: string) {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/cases/${caseId}/invoices/${id}/approve`, { method: 'POST', token })
      await load()
      await loadInvoices()
    } catch (e) {
      setError((e as ApiError).message ?? 'Could not approve invoice')
    } finally {
      setBusy(false)
    }
  }

  async function performVoidInvoice() {
    if (!voidInvoiceId) return
    const id = voidInvoiceId
    setVoidInvoiceId(null)
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/cases/${caseId}/invoices/${id}`, { method: 'DELETE', token })
      await load()
      await loadInvoices()
    } catch (e) {
      setError((e as ApiError).message ?? 'Could not void invoice')
    } finally {
      setBusy(false)
    }
  }

  // Global contacts not already linked to the matter (to avoid duplication in the picker)
  const matterContactIds = new Set(caseContacts.map((c) => c.contact_id).filter(Boolean))
  const globalOnly = globalContacts.filter((g) => !matterContactIds.has(g.id))

  return (
    <div className="ledgerShell">
      <div className="ledgerHeader ledgerHeader--ledger">
        <div className="ledgerFilterGroup" role="group" aria-label="Filter by account">
          {(['all', 'client', 'office'] as AccountFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`btn${filter === f ? ' ledgerFilterActive' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="ledgerActions">
          <button type="button" className="btn" onClick={() => void refreshAll()} disabled={busy}>
            Refresh
          </button>
          <button type="button" className="btn ledgerPostBtn" onClick={openPost} disabled={busy}>
            New posting
          </button>
          <button
            type="button"
            className="btn ledgerPostBtn"
            onClick={() => {
              setInvErr(null)
              setInvLines(defaultInvLines('20'))
              setInvoiceModalOpen(true)
            }}
            disabled={busy}
          >
            New invoice
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {/* Entries table */}
      <div className="ledgerTableWrap">
        {busy && !ledger ? (
          <div className="empty">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="empty">No entries yet.</div>
        ) : (
          <table className="ledgerTable ledgerTable--fixed ledgerTable--fourAmt" style={{ tableLayout: 'fixed', width: '100%' }}>
            {filter === 'all' ? (
              <colgroup>
                <col style={{ width: '8%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '22%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '11%' }} />
              </colgroup>
            ) : filter === 'client' ? (
              <colgroup>
                <col style={{ width: '9%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '36%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '12%' }} />
              </colgroup>
            ) : (
              <colgroup>
                <col style={{ width: '9%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '36%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '12%' }} />
              </colgroup>
            )}
            <thead>
              <tr>
                <th className="ledgerThCell ledgerColDate">
                  <span>Date</span>
                </th>
                <th className="ledgerThCell ledgerColParty">
                  <span>Party</span>
                </th>
                <th className="ledgerThCell ledgerColDesc">
                  <span>Description</span>
                </th>
                <th className="ledgerThCell ledgerColRef">
                  <span>Ref</span>
                </th>
                {filter === 'all' ? (
                  <>
                    <th className="ledgerThCell ledgerAmtCol ledgerColOfficeDr">
                      <span>Office debits</span>
                    </th>
                    <th className="ledgerThCell ledgerAmtCol ledgerColOfficeCr">
                      <span>Office credits</span>
                    </th>
                    <th className="ledgerThCell ledgerAmtCol ledgerColClientDr">
                      <span>Client debits</span>
                    </th>
                    <th className="ledgerThCell ledgerAmtCol ledgerColClientCr">
                      <span>Client credits</span>
                    </th>
                    <th className="ledgerThCell ledgerAmtCol ledgerColOfficeBal">
                      <span>Office balance</span>
                    </th>
                    <th className="ledgerThCell ledgerAmtCol ledgerColClientBal">
                      <span>Client balance</span>
                    </th>
                  </>
                ) : filter === 'client' ? (
                  <>
                    <th className="ledgerThCell ledgerAmtCol ledgerColClientDr">
                      <span>Client debits</span>
                    </th>
                    <th className="ledgerThCell ledgerAmtCol ledgerColClientCr">
                      <span>Client credits</span>
                    </th>
                    <th className="ledgerThCell ledgerAmtCol ledgerColClientBal">
                      <span>Client balance</span>
                    </th>
                  </>
                ) : (
                  <>
                    <th className="ledgerThCell ledgerAmtCol ledgerColOfficeDr">
                      <span>Office debits</span>
                    </th>
                    <th className="ledgerThCell ledgerAmtCol ledgerColOfficeCr">
                      <span>Office credits</span>
                    </th>
                    <th className="ledgerThCell ledgerAmtCol ledgerColOfficeBal">
                      <span>Office balance</span>
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => {
                const od =
                  e.account_type === 'office' && e.direction === 'debit' ? pence(e.amount_pence) : ''
                const oc =
                  e.account_type === 'office' && e.direction === 'credit' ? pence(e.amount_pence) : ''
                const cd =
                  e.account_type === 'client' && e.direction === 'debit' ? pence(e.amount_pence) : ''
                const cc =
                  e.account_type === 'client' && e.direction === 'credit' ? pence(e.amount_pence) : ''
                const pending = e.is_approved === false
                const showApprove = canApprove && pending && approveRep.get(e.pair_id) === e.id
                const rc = runningById.get(e.id)
                return (
                  <tr key={e.id} className={pending ? 'ledgerRow--pending' : undefined}>
                    <td className="ledgerDateCell ledgerColDate">{formatDate(e.posted_at)}</td>
                    <td className="ledgerPartyCell ledgerColParty">{e.contact_label ?? <span className="muted">N/A</span>}</td>
                    <td className="ledgerColDesc">
                      <span className={pending ? 'ledgerPendingDesc' : undefined}>
                        {e.description}
                        {pending ? <span className="muted"> (pending)</span> : null}
                      </span>
                      {showApprove ? (
                        <button
                          type="button"
                          className="btn ledgerApproveBtn"
                          disabled={busy}
                          onClick={() => void approvePair(e.pair_id)}
                        >
                          Approve
                        </button>
                      ) : null}
                    </td>
                    <td className="ledgerRefCell ledgerColRef">{e.reference ?? ''}</td>
                    {filter === 'all' ? (
                      <>
                        <td className="ledgerAmtCol ledgerColOfficeDr ledgerDebitCell">{od}</td>
                        <td className="ledgerAmtCol ledgerColOfficeCr ledgerCreditCell">{oc}</td>
                        <td className="ledgerAmtCol ledgerColClientDr ledgerDebitCell">{cd}</td>
                        <td className="ledgerAmtCol ledgerColClientCr ledgerCreditCell">{cc}</td>
                        <td className={`ledgerAmtCol ledgerColOfficeBal${rc && rc.o < 0 ? ' ledgerBalNeg' : ''}`}>
                          {rc ? balanceLabel(rc.o) : ''}
                        </td>
                        <td className={`ledgerAmtCol ledgerColClientBal${rc && rc.c < 0 ? ' ledgerBalNeg' : ''}`}>
                          {rc ? balanceLabel(rc.c) : ''}
                        </td>
                      </>
                    ) : filter === 'client' ? (
                      <>
                        <td className="ledgerAmtCol ledgerColClientDr ledgerDebitCell">{cd}</td>
                        <td className="ledgerAmtCol ledgerColClientCr ledgerCreditCell">{cc}</td>
                        <td className={`ledgerAmtCol ledgerColClientBal${rc && rc.c < 0 ? ' ledgerBalNeg' : ''}`}>
                          {rc ? balanceLabel(rc.c) : ''}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="ledgerAmtCol ledgerColOfficeDr ledgerDebitCell">{od}</td>
                        <td className="ledgerAmtCol ledgerColOfficeCr ledgerCreditCell">{oc}</td>
                        <td className={`ledgerAmtCol ledgerColOfficeBal${rc && rc.o < 0 ? ' ledgerBalNeg' : ''}`}>
                          {rc ? balanceLabel(rc.o) : ''}
                        </td>
                      </>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {invoicesData ? (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong>Invoices</strong>
          </div>
          {invoicesData.invoices.length === 0 ? (
            <div className="muted" style={{ fontSize: 14 }}>
              No invoices yet. Use “New invoice” to add one.
            </div>
          ) : (
          <table className="ledgerTable" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Number</th>
                <th>Status</th>
                <th>Total</th>
                <th style={{ width: 200 }} />
              </tr>
            </thead>
            <tbody>
              {invoicesData.invoices.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.invoice_number}</td>
                  <td>{inv.status}</td>
                  <td>{pence(inv.total_pence)}</td>
                  <td>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {canApproveInvoices && inv.status === 'pending_approval' ? (
                      <button type="button" className="btn ledgerApproveBtn" disabled={busy} onClick={() => void approveInvoice(inv.id)}>
                        Approve invoice
                      </button>
                    ) : null}
                    {canApproveInvoices && inv.status !== 'voided' ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => setVoidInvoiceId(inv.id)}
                        style={{ color: 'var(--danger)' }}
                      >
                        Void
                      </button>
                    ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>
      ) : null}

      {/* Post modal */}
      {postOpen && (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ledgerPostTitle"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPostOpen(false)
          }}
        >
          <div className="card ledgerPostModal modalSurfaceDraggable" style={postModalDrag.surfaceStyle}>
            <h3 id="ledgerPostTitle" className="ledgerPostTitle modalDragHandle" {...postModalDrag.handleProps}>
              New posting
            </h3>

            {/* ── Party / Contact ── */}
            <label className="ledgerPostLabel">
              Party <span aria-hidden>*</span>
              <select
                className="select"
                value={
                  contactMode === 'matter'
                    ? `matter:${contactPickId}`
                    : contactMode === 'global'
                      ? `global:${contactPickId}`
                      : contactMode
                }
                onChange={(e) => {
                  const val = e.target.value
                  setContactPickId('')
                  setContactOther('')
                  if (val === 'na') {
                    setContactMode('na')
                  } else if (val === 'other') {
                    setContactMode('other')
                  } else if (val.startsWith('matter:')) {
                    setContactMode('matter')
                    setContactPickId(val.slice(7))
                  } else if (val.startsWith('global:')) {
                    setContactMode('global')
                    setContactPickId(val.slice(7))
                  } else {
                    setContactMode('')
                  }
                }}
              >
                <option value="">— select party —</option>
                <option value="na">N/A</option>
                {caseContacts.length > 0 && (
                  <optgroup label="Matter contacts">
                    {caseContacts.map((c) => (
                      <option key={c.id} value={`matter:${c.id}`}>
                        {c.name}
                        {c.matter_contact_type ? ` (${c.matter_contact_type})` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {globalOnly.length > 0 && (
                  <optgroup label="Global contacts">
                    {globalOnly.map((c) => (
                      <option key={c.id} value={`global:${c.id}`}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="other">Other (enter below)</option>
              </select>
            </label>

            {contactMode === 'other' && (
              <label className="ledgerPostLabel">
                Party name <span aria-hidden>*</span>
                <input
                  className="input"
                  value={contactOther}
                  maxLength={300}
                  placeholder="Enter party name"
                  autoFocus
                  onChange={(e) => setContactOther(e.target.value)}
                />
              </label>
            )}

            {/* ── Description ── */}
            <label className="ledgerPostLabel">
              Description <span aria-hidden>*</span>
              <input
                ref={descRef}
                className="input"
                value={form.description}
                maxLength={500}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </label>

            <label className="ledgerPostLabel">
              Reference
              <input
                className="input"
                value={form.reference ?? ''}
                maxLength={200}
                placeholder="Optional (e.g. cheque no.)"
                onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
              />
            </label>

            <label className="ledgerPostLabel">
              Amount (£) <span aria-hidden>*</span>
              <input
                className="input"
                type="number"
                min="0.01"
                step="0.01"
                value={amountStr}
                placeholder="0.00"
                onChange={(e) => setAmountStr(e.target.value)}
              />
            </label>

            <fieldset className="ledgerPostFieldset">
              <legend>Client account</legend>
              <label className="ledgerRadioLabel">
                <input
                  type="radio"
                  name="clientDir"
                  value="debit"
                  checked={form.client_direction === 'debit'}
                  onChange={() => setForm((f) => ({ ...f, client_direction: 'debit' }))}
                />
                Debit
              </label>
              <label className="ledgerRadioLabel">
                <input
                  type="radio"
                  name="clientDir"
                  value="credit"
                  checked={form.client_direction === 'credit'}
                  onChange={() => setForm((f) => ({ ...f, client_direction: 'credit' }))}
                />
                Credit
              </label>
              <label className="ledgerRadioLabel">
                <input
                  type="radio"
                  name="clientDir"
                  value=""
                  checked={!form.client_direction}
                  onChange={() => setForm((f) => ({ ...f, client_direction: null }))}
                />
                Not affected
              </label>
            </fieldset>

            <fieldset className="ledgerPostFieldset">
              <legend>Office account</legend>
              <label className="ledgerRadioLabel">
                <input
                  type="radio"
                  name="officeDir"
                  value="debit"
                  checked={form.office_direction === 'debit'}
                  onChange={() => setForm((f) => ({ ...f, office_direction: 'debit' }))}
                />
                Debit
              </label>
              <label className="ledgerRadioLabel">
                <input
                  type="radio"
                  name="officeDir"
                  value="credit"
                  checked={form.office_direction === 'credit'}
                  onChange={() => setForm((f) => ({ ...f, office_direction: 'credit' }))}
                />
                Credit
              </label>
              <label className="ledgerRadioLabel">
                <input
                  type="radio"
                  name="officeDir"
                  value=""
                  checked={!form.office_direction}
                  onChange={() => setForm((f) => ({ ...f, office_direction: null }))}
                />
                Not affected
              </label>
            </fieldset>

            {postError && <div className="error">{postError}</div>}

            <div className="ledgerPostActions">
              <button type="button" className="btn" onClick={() => setPostOpen(false)} disabled={postBusy}>
                Cancel
              </button>
              <button type="button" className="btn ledgerPostBtn" onClick={submitPost} disabled={postBusy}>
                {postBusy ? 'Posting…' : 'Post'}
              </button>
            </div>
          </div>
        </div>
      )}

      {invoiceModalOpen ? (
        <div
          className="modalOverlay"
          style={{ zIndex: 25 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ledgerInvTitle"
          onClick={(e) => {
            if (e.target === e.currentTarget && !invBusy) setInvoiceModalOpen(false)
          }}
        >
          <div className="card ledgerPostModal modalSurfaceDraggable" style={invoiceModalDrag.surfaceStyle}>
            <h3 id="ledgerInvTitle" className="ledgerPostTitle modalDragHandle" {...invoiceModalDrag.handleProps}>
              New invoice
            </h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              Creates a pending office posting for the total. An authorised user can approve or void it.
            </p>
            <label className="ledgerPostLabel">
              Credit <span aria-hidden>*</span>
              <select
                className="select"
                value={invCreditUserId}
                disabled={invBusy || !(invBillingDefaults?.users.length)}
                onChange={(e) => setInvCreditUserId(e.target.value)}
              >
                {(invBillingDefaults?.users ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name || u.email}
                  </option>
                ))}
              </select>
            </label>
            <div className="stack" style={{ gap: 10 }}>
              <div className="muted" style={{ fontSize: 13 }}>
                Lines <span aria-hidden>*</span>
              </div>
              {invLines.map((ln) => {
                const feePres = invBillingDefaults?.fee_templates ?? []
                const disPres = invBillingDefaults?.disbursement_templates ?? []
                const presets = ln.line_type === 'fee' ? feePres : ln.line_type === 'disbursement' ? disPres : []
                return (
                  <div
                    key={ln.id}
                    className="card"
                    style={{ padding: 10, background: 'var(--surface-2, rgba(0,0,0,0.04))' }}
                  >
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
                      <label className="field" style={{ marginBottom: 0, minWidth: 120 }}>
                        <span>Type</span>
                        <select
                          className="select"
                          value={ln.line_type}
                          disabled={invBusy}
                          onChange={(e) =>
                            setInvLines((prev) =>
                              prev.map((x) =>
                                x.id === ln.id
                                  ? { ...x, line_type: e.target.value as InvLineDraft['line_type'], presetId: '' }
                                  : x,
                              ),
                            )
                          }
                        >
                          <option value="fee">Fee</option>
                          <option value="disbursement">Disbursement</option>
                          <option value="vat">VAT</option>
                        </select>
                      </label>
                      {ln.line_type !== 'vat' ? (
                        <label className="field" style={{ marginBottom: 0, minWidth: 160 }}>
                          <span>Preset</span>
                          <select
                            className="select"
                            value={ln.presetId}
                            disabled={invBusy}
                            onChange={(e) => {
                              const v = e.target.value
                              if (!v) {
                                setInvLines((prev) =>
                                  prev.map((x) => (x.id === ln.id ? { ...x, presetId: '' } : x)),
                                )
                                return
                              }
                              const t = presets.find((p) => p.id === v)
                              if (!t) return
                              setInvLines((prev) =>
                                prev.map((x) =>
                                  x.id === ln.id
                                    ? {
                                        ...x,
                                        presetId: v,
                                        description: t.label,
                                        amountStr: (t.default_amount_pence / 100).toFixed(2),
                                      }
                                    : x,
                                ),
                              )
                            }}
                          >
                            <option value="">— Custom —</option>
                            {presets.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      {invLines.length > 1 ? (
                        <button
                          type="button"
                          className="btn"
                          style={{ marginLeft: 'auto' }}
                          disabled={invBusy}
                          onClick={() => setInvLines((prev) => prev.filter((x) => x.id !== ln.id))}
                        >
                          Remove line
                        </button>
                      ) : null}
                    </div>
                    <label className="ledgerPostLabel">
                      Description <span aria-hidden>*</span>
                      <input
                        className="input"
                        value={ln.description}
                        maxLength={500}
                        disabled={invBusy}
                        onChange={(e) =>
                          setInvLines((prev) =>
                            prev.map((x) => (x.id === ln.id ? { ...x, description: e.target.value } : x)),
                          )
                        }
                      />
                    </label>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <label className="field" style={{ flex: '1 1 120px', marginBottom: 0 }}>
                        <span>Amount (£) <span aria-hidden>*</span></span>
                        <input
                          className="input inputNoSpinner"
                          inputMode="decimal"
                          autoComplete="off"
                          value={ln.amountStr}
                          disabled={invBusy}
                          onChange={(e) =>
                            setInvLines((prev) =>
                              prev.map((x) => (x.id === ln.id ? { ...x, amountStr: e.target.value } : x)),
                            )
                          }
                        />
                      </label>
                      {ln.line_type === 'fee' || ln.line_type === 'disbursement' ? (
                        <label className="field" style={{ flex: '1 1 100px', marginBottom: 0 }}>
                          <span>VAT (%)</span>
                          <input
                            className="input inputNoSpinner"
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder={invBillingDefaults ? String(invBillingDefaults.default_vat_percent) : '20'}
                            value={ln.vatPctStr}
                            disabled={invBusy}
                            onChange={(e) =>
                              setInvLines((prev) =>
                                prev.map((x) =>
                                  x.id === ln.id ? { ...x, vatPctStr: e.target.value.replace(/[^\d.]/g, '') } : x,
                                ),
                              )
                            }
                          />
                        </label>
                      ) : (
                        <span className="muted" style={{ fontSize: 12, alignSelf: 'flex-end', paddingBottom: 4 }}>
                          VAT-only line — amount is the VAT charge (£).
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
              <button
                type="button"
                className="btn"
                disabled={invBusy}
                onClick={() =>
                  setInvLines((prev) => [
                    ...prev,
                    {
                      id: newInvLineId(),
                      line_type: 'fee',
                      presetId: '',
                      description: '',
                      amountStr: '',
                      vatPctStr: invBillingDefaults
                        ? String(invBillingDefaults.default_vat_percent)
                        : '20',
                    },
                  ])
                }
              >
                + Add line
              </button>
            </div>
            <div
              className="card"
              style={{
                marginTop: 8,
                padding: 10,
                fontSize: 14,
                background: 'var(--surface-2, rgba(0,0,0,0.04))',
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span>Total fees (incl. VAT)</span>
                <strong>{pence(invoicePreviewTotals.fees)}</strong>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
                <span>Total disbursements (incl. VAT)</span>
                <strong>{pence(invoicePreviewTotals.disb)}</strong>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
                <span>Total tax / VAT</span>
                <strong>{pence(invoicePreviewTotals.tax)}</strong>
              </div>
              <div
                className="row"
                style={{
                  justifyContent: 'space-between',
                  gap: 8,
                  marginTop: 8,
                  paddingTop: 8,
                  borderTop: '1px solid var(--border, rgba(0,0,0,0.12))',
                }}
              >
                <span>Invoice total</span>
                <strong>{pence(invoicePreviewTotals.total)}</strong>
              </div>
            </div>
            {invErr ? <div className="error">{invErr}</div> : null}
            <div className="ledgerPostActions">
              <button type="button" className="btn" onClick={() => setInvoiceModalOpen(false)} disabled={invBusy}>
                Cancel
              </button>
              <button type="button" className="btn ledgerPostBtn" onClick={() => void submitInvoice()} disabled={invBusy}>
                {invBusy ? 'Saving…' : 'Create invoice'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        open={voidInvoiceId !== null}
        title="Void invoice?"
        message="This will remove the invoice or post a reversal on the ledger, depending on status. Continue?"
        confirmLabel="Void"
        cancelLabel="Cancel"
        danger
        busy={busy}
        onConfirm={() => void performVoidInvoice()}
        onCancel={() => setVoidInvoiceId(null)}
      />
    </div>
  )
}

/**
 * Standalone wrapper rendered when the app is opened with ?ledger=<caseId>.
 * Fetches minimal case info for the title bar, then renders LedgerPage.
 */
export function LedgerStandalone({ caseId, token }: { caseId: string; token: string }) {
  const [caseRef, setCaseRef] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<CaseOut>(`/cases/${caseId}`, { token })
      .then((c) => {
        const label = [c.case_number, c.client_name, c.matter_description].filter(Boolean).join(' — ')
        setCaseRef(label || caseId)
        document.title = canaryDocumentTitle(`Ledger — ${label || caseId}`)
      })
      .catch(() => {
        document.title = canaryDocumentTitle('Ledger')
      })
  }, [caseId, token])

  return (
    <div className="ledgerStandaloneShell">
      <div className="ledgerStandaloneBar">
        <span className="ledgerStandaloneLogo">Canary</span>
        {caseRef && <span className="ledgerStandaloneCase">{caseRef}</span>}
        <span className="ledgerStandaloneTitle">Ledger</span>
      </div>
      <div className="ledgerStandaloneBody">
        <LedgerPage caseId={caseId} token={token} />
      </div>
    </div>
  )
}

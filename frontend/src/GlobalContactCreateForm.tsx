import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ContactOut } from './types'

export const CONTACT_PERSON_TITLE_OPTIONS = [
  'Mr',
  'Mrs',
  'Miss',
  'Ms',
  'Dr',
  'Prof',
  'Rev',
  'Sir',
  'Lady',
  'Lord',
] as const

export type GlobalContactCreatePayload = {
  type: 'person' | 'organisation'
  name: string
  email: string | null
  phone: string | null
  title: string | null
  first_name: string | null
  middle_name: string | null
  last_name: string | null
  company_name: string | null
  trading_name: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  county: string | null
  postcode: string | null
  country: string | null
}

export function buildPersonDisplayName(parts: {
  title?: string
  first_name?: string
  middle_name?: string
  last_name?: string
}): string {
  const t = (parts.title ?? '').trim()
  const core = [parts.first_name, parts.middle_name, parts.last_name]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ')
  return [t, core].filter(Boolean).join(' ').trim()
}

/** Stored `name` is derived from person name parts or company / trading only (no separate display name). */
export function resolveContactNameFromParts(
  type: ContactOut['type'],
  person: { title: string; first_name: string; middle_name: string; last_name: string },
  org: { company_name: string; trading_name: string },
): string {
  if (type === 'person') return buildPersonDisplayName(person)
  const c = org.company_name.trim()
  const tr = org.trading_name.trim()
  return c || tr || ''
}

/** When parts are empty (e.g. legacy card), fall back to existing stored name. */
export function resolveContactNameWithFallback(
  type: ContactOut['type'],
  person: { title: string; first_name: string; middle_name: string; last_name: string },
  org: { company_name: string; trading_name: string },
  fallbackName: string,
): string {
  return resolveContactNameFromParts(type, person, org) || fallbackName.trim()
}

export type ContactFormFieldsModel = {
  type: 'person' | 'organisation'
  title: string
  firstName: string
  middleName: string
  lastName: string
  companyName: string
  tradingName: string
  email: string
  phone: string
  addressLine1: string
  addressLine2: string
  city: string
  county: string
  postcode: string
  country: string
}

export function emptyContactFormFields(): ContactFormFieldsModel {
  return {
    type: 'person',
    title: '',
    firstName: '',
    middleName: '',
    lastName: '',
    companyName: '',
    tradingName: '',
    email: '',
    phone: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    county: '',
    postcode: '',
    country: '',
  }
}

export function contactOutToFormFields(c: ContactOut): ContactFormFieldsModel {
  return {
    type: c.type,
    title: c.title ?? '',
    firstName: c.first_name ?? '',
    middleName: c.middle_name ?? '',
    lastName: c.last_name ?? '',
    companyName: c.company_name ?? '',
    tradingName: c.trading_name ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
    addressLine1: c.address_line1 ?? '',
    addressLine2: c.address_line2 ?? '',
    city: c.city ?? '',
    county: c.county ?? '',
    postcode: c.postcode ?? '',
    country: c.country ?? '',
  }
}

export function contactFieldsModelToPayload(s: ContactFormFieldsModel): GlobalContactCreatePayload | null {
  const name = resolveContactNameFromParts(
    s.type,
    {
      title: s.title,
      first_name: s.firstName,
      middle_name: s.middleName,
      last_name: s.lastName,
    },
    { company_name: s.companyName, trading_name: s.tradingName },
  )
  if (!name) return null
  const isPerson = s.type === 'person'
  return {
    type: s.type,
    name,
    email: s.email.trim() || null,
    phone: s.phone.trim() || null,
    title: isPerson ? s.title.trim() || null : null,
    first_name: isPerson ? s.firstName.trim() || null : null,
    middle_name: isPerson ? s.middleName.trim() || null : null,
    last_name: isPerson ? s.lastName.trim() || null : null,
    company_name: !isPerson ? s.companyName.trim() || null : null,
    trading_name: !isPerson ? s.tradingName.trim() || null : null,
    address_line1: s.addressLine1.trim() || null,
    address_line2: s.addressLine2.trim() || null,
    city: s.city.trim() || null,
    county: s.county.trim() || null,
    postcode: s.postcode.trim() || null,
    country: s.country.trim() || null,
  }
}

type FieldsProps = {
  value: ContactFormFieldsModel
  onChange: (patch: Partial<ContactFormFieldsModel>) => void
  busy: boolean
  /** When true (e.g. Lawyers matter contact), only organisation fields are shown and type is fixed. */
  organisationOnly?: boolean
}

/** Shared layout for global contact create and edit (type, person/org names, email/phone, address). */
export function ContactPersonOrgAddressFields({
  value: s,
  onChange,
  busy,
  organisationOnly = false,
}: FieldsProps) {
  const patch = onChange

  useEffect(() => {
    if (!organisationOnly || s.type === 'organisation') return
    patch({ type: 'organisation' })
  }, [organisationOnly, s.type, patch])

  const effectiveType = organisationOnly ? 'organisation' : s.type

  return (
    <>
      <label className="field">
        <span>Type</span>
        {organisationOnly ? (
          <div className="muted" style={{ padding: '6px 0' }}>
            Organisation (required for Lawyers)
          </div>
        ) : (
          <select
            value={s.type}
            onChange={(e) => patch({ type: e.target.value as 'person' | 'organisation' })}
            disabled={busy}
            style={{ maxWidth: 220 }}
          >
            <option value="person">Person</option>
            <option value="organisation">Organisation</option>
          </select>
        )}
      </label>
      {effectiveType === 'person' ? (
        <div className="row" style={{ gap: 8 }}>
          <label className="field" style={{ flex: '0 0 100px' }}>
            <span>Title</span>
            <select value={s.title} onChange={(e) => patch({ title: e.target.value })} disabled={busy}>
              <option value="">—</option>
              {CONTACT_PERSON_TITLE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1, minWidth: 0 }}>
            <span>First name</span>
            <input value={s.firstName} onChange={(e) => patch({ firstName: e.target.value })} disabled={busy} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 0 }}>
            <span>Middle name</span>
            <input
              placeholder="optional"
              value={s.middleName}
              onChange={(e) => patch({ middleName: e.target.value })}
              disabled={busy}
            />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 0 }}>
            <span>Last name</span>
            <input value={s.lastName} onChange={(e) => patch({ lastName: e.target.value })} disabled={busy} />
          </label>
        </div>
      ) : (
        <>
          <label className="field">
            <span>Registered company name</span>
            <input
              value={s.companyName}
              onChange={(e) => patch({ companyName: e.target.value })}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>Trading name</span>
            <input
              placeholder="optional"
              value={s.tradingName}
              onChange={(e) => patch({ tradingName: e.target.value })}
              disabled={busy}
            />
          </label>
        </>
      )}
      <div className="row">
        <label className="field" style={{ flex: 1, minWidth: 0 }}>
          <span>Email (optional)</span>
          <input value={s.email} onChange={(e) => patch({ email: e.target.value })} disabled={busy} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 0 }}>
          <span>Phone (optional)</span>
          <input value={s.phone} onChange={(e) => patch({ phone: e.target.value })} disabled={busy} />
        </label>
      </div>
      <div className="row">
        <label className="field" style={{ flex: 1, minWidth: 0 }}>
          <span>Address line 1 (optional)</span>
          <input value={s.addressLine1} onChange={(e) => patch({ addressLine1: e.target.value })} disabled={busy} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 0 }}>
          <span>Address line 2 (optional)</span>
          <input value={s.addressLine2} onChange={(e) => patch({ addressLine2: e.target.value })} disabled={busy} />
        </label>
      </div>
      <div className="row">
        <label className="field" style={{ flex: 1, minWidth: 0 }}>
          <span>Town / city (optional)</span>
          <input value={s.city} onChange={(e) => patch({ city: e.target.value })} disabled={busy} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 0 }}>
          <span>County (optional)</span>
          <input value={s.county} onChange={(e) => patch({ county: e.target.value })} disabled={busy} />
        </label>
        <label className="field" style={{ flex: '0 0 140px' }}>
          <span>Postcode (optional)</span>
          <input value={s.postcode} onChange={(e) => patch({ postcode: e.target.value })} disabled={busy} />
        </label>
      </div>
      <label className="field">
        <span>Country (optional)</span>
        <input value={s.country} onChange={(e) => patch({ country: e.target.value })} disabled={busy} />
      </label>
    </>
  )
}

type Props = {
  busy: boolean
  submitLabel: string
  showCancelButton?: boolean
  cancelLabel?: string
  onCancel?: () => void
  formError?: string | null
  intro?: ReactNode
  onSubmit: (payload: GlobalContactCreatePayload) => Promise<void>
  organisationOnly?: boolean
}

export function GlobalContactCreateForm({
  busy,
  submitLabel,
  showCancelButton = false,
  cancelLabel = 'Cancel',
  onCancel,
  formError,
  intro,
  onSubmit,
  organisationOnly = false,
}: Props) {
  const [s, setS] = useState<ContactFormFieldsModel>(() => ({
    ...emptyContactFormFields(),
    ...(organisationOnly ? { type: 'organisation' as const } : {}),
  }))

  useEffect(() => {
    if (!organisationOnly) return
    setS((prev) => (prev.type === 'organisation' ? prev : { ...prev, type: 'organisation' }))
  }, [organisationOnly])

  const resolvedName = useMemo(
    () =>
      resolveContactNameFromParts(
        s.type,
        {
          title: s.title,
          first_name: s.firstName,
          middle_name: s.middleName,
          last_name: s.lastName,
        },
        { company_name: s.companyName, trading_name: s.tradingName },
      ),
    [s.type, s.title, s.firstName, s.middleName, s.lastName, s.companyName, s.tradingName],
  )

  async function handleSubmit() {
    const payload = contactFieldsModelToPayload(s)
    if (!payload) return
    try {
      await onSubmit(payload)
    } catch {
      // Parent sets formError; do not clear fields
    }
  }

  return (
    <div className="stack">
      {intro}
      <ContactPersonOrgAddressFields
        value={s}
        onChange={(patch) => setS((prev) => ({ ...prev, ...patch }))}
        busy={busy}
        organisationOnly={organisationOnly}
      />
      {formError ? <div className="error">{formError}</div> : null}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {showCancelButton ? (
          <button type="button" className="btn" onClick={() => onCancel?.()} disabled={busy}>
            {cancelLabel}
          </button>
        ) : null}
        <button
          type="button"
          className="btn primary"
          disabled={busy || !resolvedName}
          onClick={() => void handleSubmit()}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

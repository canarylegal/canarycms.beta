/**
 * Fallback when `/matter-contact-types` has not loaded yet (matches seeded defaults).
 */
export const MATTER_CONTACT_TYPE_OPTIONS_FALLBACK: { value: string; label: string }[] = [
  { value: 'client', label: 'Client' },
  { value: 'lawyers', label: 'Lawyers' },
  { value: 'new-lender', label: 'New lender' },
  { value: 'existing-lender', label: 'Existing lender' },
  { value: 'other', label: 'Other' },
]

/** @deprecated Prefer loading options from the API; this alias matches the fallback list. */
export const MATTER_CONTACT_TYPE_OPTIONS = MATTER_CONTACT_TYPE_OPTIONS_FALLBACK

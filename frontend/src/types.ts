export type TokenResponse = { access_token: string; token_type: string }

export type UserPublic = {
  id: string
  email: string
  display_name: string
  job_title?: string | null
  role: 'admin' | 'user'
  is_active: boolean
  is_2fa_enabled: boolean
  /** Top-bar E-mail: `mailto:` vs Outlook web URL */
  email_launch_preference?: 'desktop' | 'outlook_web'
  email_outlook_web_url?: string | null
}

/** Admin-only user row (includes permission category). */
export type AdminUserPublic = UserPublic & {
  permission_category_id?: string | null
}

export type UserPermissionCategoryOut = {
  id: string
  name: string
  perm_fee_earner: boolean
  perm_post_client: boolean
  perm_post_office: boolean
  perm_approve_payments: boolean
  perm_approve_invoices: boolean
  created_at: string
  updated_at: string
}

export type LedgerPermissionsOut = {
  can_approve_ledger: boolean
  can_approve_invoices?: boolean
}

export type CaseInvoiceLineOut = {
  id: string
  line_type: string
  description: string
  amount_pence: number
  tax_pence: number
  credit_user_id?: string | null
}

export type CaseInvoiceOut = {
  id: string
  case_id: string
  invoice_number: string
  status: string
  total_pence: number
  payee_name?: string | null
  credit_user_id?: string | null
  credit_user_display_name?: string | null
  contact_id?: string | null
  ledger_pair_id?: string | null
  created_by_user_id?: string | null
  approved_by_user_id?: string | null
  approved_at?: string | null
  voided_at?: string | null
  created_at: string
  lines: CaseInvoiceLineOut[]
}

export type CaseInvoicesOut = {
  case_id: string
  invoices: CaseInvoiceOut[]
}

export type CaseInvoiceLineCreate = {
  line_type: 'fee' | 'disbursement' | 'vat'
  description: string
  amount_pence: number
  tax_pence?: number
  credit_user_id?: string | null
}

export type CaseInvoiceCreate = {
  credit_user_id: string
  payee_name?: string | null
  contact_id?: string | null
  lines: CaseInvoiceLineCreate[]
}

export type BillingLineTemplateOut = {
  id: string
  matter_sub_type_id: string
  line_kind: 'fee' | 'disbursement'
  label: string
  default_amount_pence: number
  sort_order: number
}

export type InvoiceBillingDefaultsUser = {
  id: string
  email: string
  display_name: string
}

export type InvoiceBillingDefaultsOut = {
  default_vat_percent: number
  fee_earner_user_id?: string | null
  fee_templates: BillingLineTemplateOut[]
  disbursement_templates: BillingLineTemplateOut[]
  users: InvoiceBillingDefaultsUser[]
}

export type UserCalDAVStatusOut = {
  enabled: boolean
  caldav_url: string
  caldav_username: string
}

export type UserCalDAVProvisionOut = {
  caldav_url: string
  caldav_username: string
  caldav_password: string
  note: string
}

export type CalendarEventOut = {
  id: string
  uid: string
  title: string
  start: string
  end: string
  all_day: boolean
  description?: string | null
  calendar_name?: string | null
  calendar_id?: string | null
  can_edit?: boolean
  /** Canary-only; not in Radicale. */
  category_id?: string | null
  category_name?: string | null
  category_color?: string | null
}

export type CalendarCategoryOut = {
  id: string
  calendar_id: string
  name: string
  color?: string | null
}

export type UserCalendarListItem = {
  id: string
  name: string
  radicale_slug: string
  is_public: boolean
  access: 'owner' | 'read' | 'write'
  source: 'owned' | 'share' | 'subscription'
  owner: { id: string; display_name: string; email: string }
}

export type CalendarDirectoryRow = {
  id: string
  name: string
  owner: { id: string; display_name: string; email: string }
  is_public: boolean
  shared_directly: boolean
  already_in_my_list: boolean
  can_subscribe: boolean
}

export type CalendarShareOut = {
  grantee_user_id: string
  grantee_display_name: string
  grantee_email: string
  can_write: boolean
}

export type MatterSubTypeMenuOut = {
  id: string
  name: string
}

export type MatterSubTypeOut = {
  id: string
  name: string
  prefix?: string | null
  menus: MatterSubTypeMenuOut[]
}

export type MatterHeadTypeOut = {
  id: string
  name: string
  sub_types: MatterSubTypeOut[]
}

export type MatterMenuItemOut = {
  id: string
  name: string
}

/** Stored case workflow status (`open` is shown as Active in the UI). */
export type CaseWorkflowStatus = 'open' | 'closed' | 'archived' | 'quote' | 'post_completion'

export function formatCaseStatusLabel(status: string): string {
  switch (status) {
    case 'open':
      return 'Active'
    case 'closed':
      return 'Closed'
    case 'archived':
      return 'Archived'
    case 'quote':
      return 'Quote'
    case 'post_completion':
      return 'Post-completion'
    default:
      return status
  }
}

export type CaseOut = {
  id: string
  case_number: string
  client_name?: string | null
  matter_description: string
  fee_earner_user_id?: string | null
  status: CaseWorkflowStatus
  practice_area?: string | null
  matter_sub_type_id?: string | null
  /** Derived from the matter sub-type; may be set without sub for legacy rows. */
  matter_head_type_id?: string | null
  matter_sub_type_name?: string | null
  matter_head_type_name?: string | null
  matter_menus?: MatterMenuItemOut[]
  created_by: string
  is_locked: boolean
  lock_mode: 'none' | 'whitelist' | 'blacklist'
  created_at: string
  updated_at: string
}

/** True when the case has at least one explicit access revocation (deny / blacklist). */
export function caseHasRevokedUserAccess(c: Pick<CaseOut, 'is_locked' | 'lock_mode'>): boolean {
  return Boolean(c.is_locked && c.lock_mode === 'blacklist')
}

export type CaseAccessRuleOut = {
  id: string
  case_id: string
  user_id: string
  mode: 'allow' | 'deny'
}

export type CasePropertyUK = {
  line1?: string | null
  line2?: string | null
  town?: string | null
  county?: string | null
  postcode?: string | null
  country?: string | null
}

export type CasePropertyTenure = 'freehold' | 'leasehold' | 'commonhold'

export type CasePropertyPayload = {
  is_non_postal: boolean
  uk: CasePropertyUK
  free_lines: string[]
  title_numbers: string[]
  tenure?: CasePropertyTenure | null
}

export type CasePropertyDetailsOut = {
  has_details: boolean
  payload: CasePropertyPayload
  updated_at?: string | null
}

export type PrecedentCategoryOut = {
  id: string
  matter_sub_type_id: string
  name: string
  sort_order: number
  created_at: string
  updated_at: string
}

export type PrecedentCategoryFlatOut = PrecedentCategoryOut & {
  matter_sub_type_name: string
}

/** Form/API token for Global scope (must match backend GLOBAL_SCOPE). */
export const GLOBAL_PRECEDENT_SCOPE = '__GLOBAL__'

export type PrecedentOut = {
  id: string
  name: string
  reference: string
  kind: 'letter' | 'email' | 'document'
  original_filename: string
  mime_type: string
  category_id?: string | null
  matter_head_type_id?: string | null
  matter_sub_type_id?: string | null
  category_name?: string | null
  matter_head_type_name?: string | null
  matter_sub_type_name?: string | null
  scope_summary?: string
  created_at: string
}

export type UserSummary = {
  id: string
  email: string
  display_name: string
  role: string
  is_active: boolean
}

export type CaseNoteOut = {
  id: string
  case_id: string
  author_user_id: string
  body: string
  created_at: string
  updated_at: string
}

export type CaseTaskPriority = 'low' | 'normal' | 'high'

export type CaseTaskOut = {
  id: string
  case_id: string
  created_by_user_id: string
  title: string
  description?: string | null
  status: 'open' | 'done' | 'cancelled'
  due_at?: string | null
  standard_task_id?: string | null
  assigned_to_user_id?: string | null
  assigned_display_name?: string | null
  priority?: CaseTaskPriority
  case_event_id?: string | null
  is_private?: boolean
  created_at: string
  updated_at: string
}

export type MatterSubTypeStandardTaskOut = {
  id: string
  matter_sub_type_id: string | null
  title: string
  sort_order: number
  is_system?: boolean
  created_at: string
  updated_at: string
}

/** One row on the top-level Tasks list. Filled when task/case rules are configured; empty by default. */
export type TaskMenuRow = {
  id: string
  case_id: string
  case_number: string
  client_name: string | null
  matter_description: string | null
  /** Same shape as main-menu matter type filter (e.g. head · sub). */
  matter_type_label: string
  task_title: string
  is_private?: boolean
  /** Due date or other relevant task date (ISO 8601). */
  date: string
  assigned_display_name: string | null
  priority: CaseTaskPriority
  status: 'open' | 'done' | 'cancelled'
}

export type FileSummary = {
  id: string
  original_filename: string
  mime_type: string
  size_bytes: number
  created_at: string
  updated_at?: string
  folder_path?: string
  is_pinned?: boolean
  category?: 'case_document' | 'precedent' | 'system'
  parent_file_id?: string | null
  /** IMAP mailbox name when the message was linked from the server (threading / poller). */
  source_imap_mbox?: string | null
  source_imap_uid?: string | null
  /** Parsed From: header for parent .eml uploads; shown on second line in the documents list. */
  source_mail_from_name?: string | null
  source_mail_from_email?: string | null
  /** True when filed from a sent folder (IMAP) or From matches uploader; drives mail icon colour. */
  source_mail_is_outbound?: boolean | null
  /** RFC5322 Message-ID header from parent .eml (parsed on upload). */
  source_internet_message_id?: string | null
  /** Exchange/Outlook REST item id when filed from the Office add-in (OWA read deeplink). */
  source_outlook_item_id?: string | null
  /** Graph message id (often same as REST item id) for OWA read / desktop open. */
  outlook_graph_message_id?: string | null
  /** Microsoft Graph ``webLink`` when available (preferred one-click OWA open). */
  outlook_web_link?: string | null
  owner_display_name?: string | null
  owner_email?: string | null
}

/** Response from ``POST /cases/{id}/files/email-drafts/m365`` (Microsoft Graph draft). */
export type CaseEmailDraftM365Out = {
  open_url: string
  graph_message_id?: string | null
  draft_compose_web_link?: string | null
}

export type AdminAuditEvent = {
  id: string
  actor_user_id: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  ip: string | null
  user_agent: string | null
  meta: unknown
  created_at: string
}

export type ContactOut = {
  id: string
  type: 'person' | 'organisation'
  name: string
  email?: string | null
  phone?: string | null
  // Person name fields
  title?: string | null
  first_name?: string | null
  middle_name?: string | null
  last_name?: string | null
  // Organisation fields
  company_name?: string | null
  trading_name?: string | null
  // Address
  address_line1?: string | null
  address_line2?: string | null
  city?: string | null
  county?: string | null
  postcode?: string | null
  country?: string | null
  created_at: string
  updated_at: string
}

export type CaseContactOut = {
  id: string
  case_id: string
  contact_id: string | null
  is_linked_to_master: boolean
  type: 'person' | 'organisation'
  name: string
  email?: string | null
  phone?: string | null
  // Person name fields
  title?: string | null
  first_name?: string | null
  middle_name?: string | null
  last_name?: string | null
  // Organisation fields
  company_name?: string | null
  trading_name?: string | null
  // Address
  address_line1?: string | null
  address_line2?: string | null
  city?: string | null
  county?: string | null
  postcode?: string | null
  country?: string | null
  /** Matter-specific; not stored on the global contact card. */
  matter_contact_type?: string | null
  /** Matter-specific free text; not stored on the global contact card. */
  matter_contact_reference?: string | null
  /** When matter contact type is Lawyers: linked Client matter contacts (max 4). */
  lawyer_client_ids?: string[]
  created_at: string
  updated_at: string
}

export type MatterContactTypeOut = {
  id: string
  slug: string
  label: string
  sort_order: number
  is_system: boolean
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerEntryOut = {
  id: string
  pair_id: string
  account_type: 'client' | 'office'
  direction: 'debit' | 'credit'
  amount_pence: number
  description: string
  reference?: string | null
  contact_label?: string | null
  posted_by_user_id?: string | null
  posted_at: string
  is_approved?: boolean
}

export type LedgerAccountSummary = {
  account_type: 'client' | 'office'
  balance_pence: number
}

export type LedgerOut = {
  entries: LedgerEntryOut[]
  client: LedgerAccountSummary
  office: LedgerAccountSummary
}

export type LedgerPostCreate = {
  description: string
  reference?: string | null
  contact_label?: string | null
  amount_pence: number
  client_direction?: 'debit' | 'credit' | null
  office_direction?: 'debit' | 'credit' | null
}

// ---------------------------------------------------------------------------
// Finance templates (admin)
// ---------------------------------------------------------------------------

export type FinanceItemTemplateOut = {
  id: string
  category_id: string
  name: string
  direction: 'debit' | 'credit'
  sort_order: number
}

export type FinanceCategoryTemplateOut = {
  id: string
  matter_sub_type_id: string
  name: string
  sort_order: number
  items: FinanceItemTemplateOut[]
}

export type FinanceTemplateOut = {
  matter_sub_type_id: string
  categories: FinanceCategoryTemplateOut[]
}

// ---------------------------------------------------------------------------
// Finance case data
// ---------------------------------------------------------------------------

export type FinanceItemOut = {
  id: string
  category_id: string
  template_item_id?: string | null
  name: string
  direction: 'debit' | 'credit'
  amount_pence?: number | null
  sort_order: number
}

export type FinanceCategoryOut = {
  id: string
  case_id: string
  template_category_id?: string | null
  name: string
  sort_order: number
  items: FinanceItemOut[]
}

export type FinanceOut = {
  case_id: string
  categories: FinanceCategoryOut[]
}

// Sub-menu Events (admin template + case rows)
export type MatterSubTypeEventTemplateOut = {
  id: string
  matter_sub_type_id: string
  name: string
  sort_order: number
  created_at: string
  updated_at: string
}

export type CaseEventOut = {
  id: string
  case_id: string
  template_id?: string | null
  name: string
  sort_order: number
  event_date?: string | null
  track_in_calendar?: boolean
  calendar_event_uid?: string | null
  created_at: string
  updated_at: string
}

export type CaseEventsOut = {
  case_id: string
  events: CaseEventOut[]
}


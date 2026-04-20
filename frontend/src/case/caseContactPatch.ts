import type { ContactFormFieldsModel } from '../GlobalContactCreateForm'
import type { CaseContactOut } from '../types'

export function applyCaseContactFieldPatch(
  prev: CaseContactOut,
  patch: Partial<ContactFormFieldsModel>,
): CaseContactOut {
  const n = { ...prev }
  if (patch.type !== undefined) n.type = patch.type
  if (patch.title !== undefined) n.title = patch.title || null
  if (patch.firstName !== undefined) n.first_name = patch.firstName || null
  if (patch.middleName !== undefined) n.middle_name = patch.middleName || null
  if (patch.lastName !== undefined) n.last_name = patch.lastName || null
  if (patch.companyName !== undefined) n.company_name = patch.companyName || null
  if (patch.tradingName !== undefined) n.trading_name = patch.tradingName || null
  if (patch.email !== undefined) n.email = patch.email || null
  if (patch.phone !== undefined) n.phone = patch.phone || null
  if (patch.addressLine1 !== undefined) n.address_line1 = patch.addressLine1 || null
  if (patch.addressLine2 !== undefined) n.address_line2 = patch.addressLine2 || null
  if (patch.city !== undefined) n.city = patch.city || null
  if (patch.county !== undefined) n.county = patch.county || null
  if (patch.postcode !== undefined) n.postcode = patch.postcode || null
  if (patch.country !== undefined) n.country = patch.country || null
  return n
}

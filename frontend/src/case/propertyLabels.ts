import type { CasePropertyTenure } from '../types'

export function propertyTenureLabel(t: CasePropertyTenure | null | undefined): string {
  if (t === 'freehold') return 'Freehold'
  if (t === 'leasehold') return 'Leasehold'
  if (t === 'commonhold') return 'Commonhold'
  return ''
}

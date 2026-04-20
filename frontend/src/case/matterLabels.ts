import { MATTER_CONTACT_TYPE_OPTIONS_FALLBACK } from '../matterContactTypeOptions'

export function matterContactTypeLabel(
  value: string | null | undefined,
  opts?: { value: string; label: string }[],
): string {
  if (!value || !value.trim()) return '—'
  const list = opts ?? MATTER_CONTACT_TYPE_OPTIONS_FALLBACK
  const o = list.find((x) => x.value === value)
  return o?.label ?? value
}

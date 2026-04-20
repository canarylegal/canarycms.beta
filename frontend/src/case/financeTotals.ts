import type { FinanceOut } from '../types'

export function financeCaseTotals(f: FinanceOut): { dr: number; cr: number } {
  let dr = 0
  let cr = 0
  for (const cat of f.categories) {
    for (const it of cat.items) {
      const amt = it.amount_pence
      if (amt == null) continue
      if (it.direction === 'debit') dr += amt
      else cr += amt
    }
  }
  return { dr, cr }
}

export function penceGb(p: number): string {
  return `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

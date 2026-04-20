/** Used with the `storage` event so other tabs can refresh when case files change. */

export const CASE_FILES_STORAGE_KEY = 'canary.caseFilesSignal'

export function signalCaseFilesChanged(caseId: string): void {
  try {
    localStorage.setItem(CASE_FILES_STORAGE_KEY, JSON.stringify({ caseId, t: Date.now() }))
  } catch {
    /* private mode / quota */
  }
}

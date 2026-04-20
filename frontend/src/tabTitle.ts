/** Browser tab title: `Canary - {segment}` */
export function canaryDocumentTitle(segment: string): string {
  const s = segment.trim()
  return s ? `Canary - ${s}` : 'Canary'
}

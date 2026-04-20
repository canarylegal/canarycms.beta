/** Keep `position: fixed` context menus in the viewport: flip upward, clamp horizontally, scroll if needed. */
export function computeDocContextMenuStyle(
  el: HTMLElement,
  clientX: number,
  clientY: number,
): { left: number; top: number; maxHeight?: number } {
  const margin = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = clientX
  let top = clientY
  const rect = el.getBoundingClientRect()
  const w = rect.width
  const h = rect.height

  if (left + w > vw - margin) {
    left = Math.max(margin, vw - w - margin)
  }

  if (top + h > vh - margin) {
    const above = top - h
    if (above >= margin) {
      top = above
    } else {
      top = margin
      return { left, top, maxHeight: Math.max(120, vh - 2 * margin) }
    }
  }
  return { left, top }
}

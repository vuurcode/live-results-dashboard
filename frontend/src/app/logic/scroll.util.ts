/**
 * Page scroll position that puts an element `anchorRatio` of the way down the viewport
 * (0 = flush with the top, 0.3 = a third down), clamped to the scrollable range.
 */
export function followScrollTop(
  elementTop: number,
  scrollY: number,
  viewportHeight: number,
  documentHeight: number,
  anchorRatio: number,
): number {
  const target = elementTop + scrollY - viewportHeight * anchorRatio;
  const max = Math.max(0, documentHeight - viewportHeight);
  return Math.min(Math.max(0, target), max);
}
